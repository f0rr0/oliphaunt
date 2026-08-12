import pgtap from '@oliphaunt/extension-pgtap-wasix';
import Oliphaunt, {
  PostgresError,
  type QueryParam,
  type OliphauntDatabase,
  type WasixExtensionDescriptor,
  WasixStorageError,
} from '@oliphaunt/wasix';
import { indexedDB } from '@oliphaunt/wasix/storage/indexed-db';

const status = requireElement<HTMLParagraphElement>('status');
const sql = requireElement<HTMLTextAreaElement>('sql');
const run = requireElement<HTMLButtonElement>('run');
const output = requireElement<HTMLPreElement>('output');
const searchParams = new URL(globalThis.location.href).searchParams;
const smoke = searchParams.has('smoke');
const pgUuidv7Canary = searchParams.has('pg_uuidv7');
const directWorkerAudit = smoke ? auditDirectWorkerConstruction() : undefined;

try {
  const extensions: WasixExtensionDescriptor[] = [pgtap];
  if (pgUuidv7Canary) {
    const { default: pgUuidv7 } = await import('@oliphaunt/extension-pg-uuidv7-wasix');
    extensions.push(pgUuidv7);
  }
  if (smoke) {
    await expectFailedDirectOpenRecovery();
  }
  const storage = indexedDB('browser-smoke');
  let database = await Oliphaunt.open({
    execution: smoke ? 'direct' : 'worker',
    extensions,
    ...(smoke ? { storage } : {}),
  });
  status.textContent = `PostgreSQL 18 is running with ${smoke ? 'direct' : 'worker'} execution.`;
  if (smoke) {
    await expectConcurrentDirectExecution(database);
    await expectExclusiveOwnership(storage, extensions);
    const pgtapVersion = await exercisePgtap(database);
    const firstUuid = pgUuidv7Canary ? await readPgUuidv7(database) : undefined;
    await database.query('CREATE TABLE browser_reopen_probe (answer integer NOT NULL)');
    await database.query('INSERT INTO browser_reopen_probe VALUES (42)');
    await database.checkpoint();
    // This row is intentionally newer than the explicit checkpoint. Reopening
    // it proves the independent clean-close publication path.
    await database.query('INSERT INTO browser_reopen_probe VALUES (43)');
    await expectSqlstate(database, 'SELEC 1', '42601');
    await expectAnswer(database);
    await expectSqlstate(database, 'SELECT 1 / $1::int', '22012', [0]);
    await expectAnswer(database);
    await expectTransaction(database);
    const recoveredPgtapVersion = await readPgtapVersion(database);
    if (recoveredPgtapVersion !== pgtapVersion) {
      throw new Error('browser smoke observed a different pgtap version after recovery');
    }
    if (pgUuidv7Canary) {
      await readPgUuidv7(database);
    }
    await database.close();

    directWorkerAudit?.assertNoneAndRestore();
    await expectDirectWithoutWorker();

    database = await Oliphaunt.open({ execution: 'worker', storage, extensions });
    const reopened = await database.query(
      'SELECT string_agg(answer::text, $1 ORDER BY answer) AS answers FROM browser_reopen_probe',
      [','],
    );
    if (reopened.getText(0, 'answers') !== '42,43') {
      throw new Error('browser smoke did not reopen checkpointed and clean-close PGDATA');
    }
    if ((await readPgtapVersion(database)) !== pgtapVersion) {
      throw new Error('browser smoke did not reconstruct the selected pgtap carrier on reopen');
    }
    if (pgUuidv7Canary) {
      await readPgUuidv7(database);
    }
    await database.close();
    status.textContent = 'Browser smoke passed.';
    output.textContent = JSON.stringify({
      answers: [42, 43],
      pgtap: pgtapVersion,
      startupSqlstate: '3D000',
      directWorkers: 0,
      ...(firstUuid === undefined ? {} : { pg_uuidv7: firstUuid }),
    });
    document.documentElement.dataset.oliphauntSmoke = 'passed';
  } else {
    run.disabled = false;
    run.addEventListener('click', async () => {
      run.disabled = true;
      output.textContent = '';
      try {
        const result = await database.query(sql.value);
        output.textContent = JSON.stringify(
          result.rows.map((row) =>
            Object.fromEntries(result.fields.map((field, index) => [field.name, row.text(index)])),
          ),
          null,
          2,
        );
      } catch (error) {
        output.textContent = describeError(error);
      } finally {
        run.disabled = false;
      }
    });
  }
} catch (error) {
  status.textContent = 'Startup failed.';
  output.textContent = describeError(error);
  document.documentElement.dataset.oliphauntSmoke = 'failed';
} finally {
  directWorkerAudit?.restore();
}

async function expectConcurrentDirectExecution(first: OliphauntDatabase): Promise<void> {
  const attempts = await Promise.allSettled([
    Oliphaunt.open({ execution: 'direct' }),
    Oliphaunt.open({ execution: 'direct' }),
  ]);
  const opened = attempts.flatMap((attempt) =>
    attempt.status === 'fulfilled' ? [attempt.value] : [],
  );
  const failed = attempts.find(
    (attempt): attempt is PromiseRejectedResult => attempt.status === 'rejected',
  );
  if (failed !== undefined) {
    await Promise.allSettled(opened.map((database) => database.close()));
    throw failed.reason;
  }
  const [second, third] = opened;
  if (second === undefined || third === undefined) {
    throw new Error('direct concurrent-open smoke produced an incomplete result');
  }
  try {
    await expectAnswer(first);
    await expectAnswer(second);
    await expectAnswer(third);
  } finally {
    await Promise.all([second.close(), third.close()]);
  }
}

async function expectDirectWithoutWorker(): Promise<void> {
  const workerDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'Worker');
  Object.defineProperty(globalThis, 'Worker', {
    configurable: true,
    writable: true,
    value: undefined,
  });
  try {
    const database = await Oliphaunt.open({ execution: 'direct' });
    try {
      await expectAnswer(database);
    } finally {
      await database.close();
    }
  } finally {
    if (workerDescriptor === undefined) {
      Reflect.deleteProperty(globalThis, 'Worker');
    } else {
      Object.defineProperty(globalThis, 'Worker', workerDescriptor);
    }
  }
}

async function expectTransaction(database: OliphauntDatabase): Promise<void> {
  const answer = await database.transaction(async (transaction) => {
    const result = await transaction.query('SELECT $1::int + 1 AS answer', [41]);
    return result.getText(0, 'answer');
  });
  if (answer !== '42') {
    throw new Error(`browser smoke transaction expected 42, received ${JSON.stringify(answer)}`);
  }
}

async function expectStartupSqlstate(database: string, sqlstate: string): Promise<void> {
  try {
    const unexpected = await Oliphaunt.open({ database, execution: 'direct' });
    await unexpected.close();
    throw new Error(
      `browser smoke unexpectedly opened missing database ${JSON.stringify(database)}`,
    );
  } catch (error) {
    if (
      !(error instanceof PostgresError) ||
      error.sqlstate !== sqlstate ||
      error.severity !== 'FATAL'
    ) {
      throw error;
    }
  }
}

async function expectFailedDirectOpenRecovery(): Promise<void> {
  await expectStartupSqlstate('oliphaunt_browser_smoke_missing_database', '3D000');
  const reopened = await Oliphaunt.open({ execution: 'direct' });
  try {
    await expectAnswer(reopened);
  } finally {
    await reopened.close();
  }
}

async function expectExclusiveOwnership(
  storage: ReturnType<typeof indexedDB>,
  extensions: readonly WasixExtensionDescriptor[],
): Promise<void> {
  try {
    const duplicate = await Oliphaunt.open({ execution: 'direct', storage, extensions });
    await duplicate.close();
    throw new Error('browser smoke opened one IndexedDB database twice');
  } catch (error) {
    if (!(error instanceof WasixStorageError) || error.code !== 'busy') {
      throw error;
    }
  }
}

async function exercisePgtap(database: OliphauntDatabase): Promise<string> {
  const version = await readPgtapVersion(database);
  const plan = await database.query('SELECT plan(1)::text AS tap');
  if (plan.getText(0, 'tap') !== '1..1') {
    throw new Error('browser smoke expected pgtap plan(1) to return 1..1');
  }
  const assertion = await database.query("SELECT ok(true, 'browser pgtap')::text AS tap");
  if (assertion.getText(0, 'tap') !== 'ok 1 - browser pgtap') {
    throw new Error('browser smoke expected pgtap ok() to report a passing assertion');
  }
  await database.query('SELECT * FROM finish()');
  return version;
}

async function readPgtapVersion(database: OliphauntDatabase): Promise<string> {
  const pgtap = await database.query('SELECT pgtap_version()::text AS version');
  const version = pgtap.getText(0, 'version');
  if (version === null || version.length === 0) {
    throw new Error('browser smoke expected pgtap_version() to return a version');
  }
  return version;
}

async function readPgUuidv7(database: OliphauntDatabase): Promise<string> {
  const result = await database.query('SELECT uuid_generate_v7()::text AS uuid');
  const uuid = result.getText(0, 'uuid');
  if (
    uuid === null ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(uuid)
  ) {
    throw new Error(`browser smoke expected a version 7 UUID, received ${JSON.stringify(uuid)}`);
  }
  return uuid;
}

async function expectSqlstate(
  database: OliphauntDatabase,
  query: string,
  sqlstate: string,
  parameters: ReadonlyArray<QueryParam> = [],
): Promise<void> {
  try {
    await database.query(query, parameters);
    throw new Error(`browser smoke expected SQLSTATE ${sqlstate}`);
  } catch (error) {
    if (!(error instanceof PostgresError) || error.sqlstate !== sqlstate) {
      throw error;
    }
  }
}

async function expectAnswer(database: OliphauntDatabase): Promise<void> {
  const result = await database.query('SELECT 40 + 2 AS answer');
  const answer = result.getText(0, 'answer');
  if (answer !== '42') {
    throw new Error(`browser smoke expected 42, received ${JSON.stringify(answer)}`);
  }
}

function requireElement<ElementType extends HTMLElement>(id: string): ElementType {
  const element = document.getElementById(id);
  if (element === null) {
    throw new Error(`missing #${id}`);
  }
  return element as ElementType;
}

function describeError(error: unknown): string {
  return error instanceof Error ? (error.stack ?? error.message) : String(error);
}

function auditDirectWorkerConstruction(): {
  assertNoneAndRestore(): void;
  restore(): void;
} {
  const NativeWorker = globalThis.Worker;
  let constructed = 0;
  let restored = false;
  class AuditedWorker extends NativeWorker {
    constructor(scriptURL: string | URL, options?: WorkerOptions) {
      constructed += 1;
      super(scriptURL, options);
    }
  }
  globalThis.Worker = AuditedWorker;
  const restore = () => {
    if (!restored) {
      globalThis.Worker = NativeWorker;
      restored = true;
    }
  };
  return {
    assertNoneAndRestore() {
      restore();
      if (constructed !== 0) {
        throw new Error(`direct execution constructed ${constructed} Web Worker(s)`);
      }
    },
    restore,
  };
}
