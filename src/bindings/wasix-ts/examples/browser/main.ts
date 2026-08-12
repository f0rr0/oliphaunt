import pgtap from '@oliphaunt/extension-pgtap-wasix';
import Oliphaunt, {
  PostgresError,
  type QueryParam,
  type WasixDatabase,
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

try {
  const extensions: WasixExtensionDescriptor[] = [pgtap];
  if (pgUuidv7Canary) {
    const { default: pgUuidv7 } = await import('@oliphaunt/extension-pg-uuidv7-wasix');
    extensions.push(pgUuidv7);
  }
  const storage = indexedDB('browser-smoke');
  let database = await Oliphaunt.open({
    extensions,
    ...(smoke ? { storage } : {}),
  });
  status.textContent = 'PostgreSQL 18 is running in a Web Worker.';
  if (smoke) {
    await expectStartupSqlstate('oliphaunt_browser_smoke_missing_database', '3D000');
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
    const recoveredPgtapVersion = await readPgtapVersion(database);
    if (recoveredPgtapVersion !== pgtapVersion) {
      throw new Error('browser smoke observed a different pgtap version after recovery');
    }
    if (pgUuidv7Canary) {
      await readPgUuidv7(database);
    }
    await database.close();

    database = await Oliphaunt.open({ storage, extensions });
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
}

async function expectStartupSqlstate(database: string, sqlstate: string): Promise<void> {
  try {
    const unexpected = await Oliphaunt.open({ database });
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

async function expectExclusiveOwnership(
  storage: ReturnType<typeof indexedDB>,
  extensions: readonly WasixExtensionDescriptor[],
): Promise<void> {
  try {
    const duplicate = await Oliphaunt.open({ storage, extensions });
    await duplicate.close();
    throw new Error('browser smoke opened one IndexedDB database twice');
  } catch (error) {
    if (!(error instanceof WasixStorageError) || error.code !== 'busy') {
      throw error;
    }
  }
}

async function exercisePgtap(database: WasixDatabase): Promise<string> {
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

async function readPgtapVersion(database: WasixDatabase): Promise<string> {
  const pgtap = await database.query('SELECT pgtap_version()::text AS version');
  const version = pgtap.getText(0, 'version');
  if (version === null || version.length === 0) {
    throw new Error('browser smoke expected pgtap_version() to return a version');
  }
  return version;
}

async function readPgUuidv7(database: WasixDatabase): Promise<string> {
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
  database: WasixDatabase,
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

async function expectAnswer(database: WasixDatabase): Promise<void> {
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
