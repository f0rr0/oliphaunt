import pgtap from '@oliphaunt/extension-pgtap-wasix';
import Oliphaunt, {
  type OliphauntDatabase,
  PostgresError,
  type QueryParam,
  type WasixExtensionDescriptor,
  type WasixStorage,
  WasixStorageError,
} from '@oliphaunt/wasix-ts';
import WorkerOliphaunt from '@oliphaunt/wasix-ts/worker';
import { indexedDB } from '@oliphaunt/wasix-ts/storage/indexed-db';
import { opfs } from '@oliphaunt/wasix-ts/storage/opfs';
import { pgDump, psql } from '@oliphaunt/wasix-tools';

import logicalToolsFixtureJson from '../../src/shared/fixtures/postgres/logical-tools.json?raw';
import logicalToolsSeed from '../../src/shared/fixtures/postgres/logical-tools-seed.sql?raw';
import logicalToolsVerify from '../../src/shared/fixtures/postgres/logical-tools-verify.sql?raw';
import { expectDirectPgDump } from './direct-pg-dump-smoke.js';
import { expectStructuredApi } from './structured-api-smoke.js';

const logicalToolsFixture = JSON.parse(logicalToolsFixtureJson) as {
  expected: {
    rows: number;
    sum: number;
    sequenceLastValue: number;
    quotedValue: string;
    normalizedMatches: number;
    extensionLoaded: boolean;
  };
};

const status = requireElement<HTMLParagraphElement>('status');
const sql = requireElement<HTMLTextAreaElement>('sql');
const run = requireElement<HTMLButtonElement>('run');
const output = requireElement<HTMLPreElement>('output');
const searchParams = new URL(globalThis.location.href).searchParams;
const smoke = searchParams.has('smoke');
const pgUuidv7Canary = searchParams.has('pg_uuidv7');
const postgisWorkerCanary = searchParams.has('postgis_worker');
const directWorkerAudit = smoke ? auditDirectWorkerConstruction() : undefined;

try {
  const extensions: WasixExtensionDescriptor[] = [pgtap];
  if (pgUuidv7Canary) {
    const { default: pgUuidv7 } = await import('@oliphaunt/extension-pg-uuidv7-wasix');
    extensions.push(pgUuidv7);
  }
  if (smoke) {
    expectOwnedMemoryCopyAcrossGrowth();
    await expectFailedDirectOpenRecovery();
  }
  const storage = indexedDB('browser-smoke');
  let database = await (smoke ? Oliphaunt : WorkerOliphaunt).open({
    extensions,
    ...(smoke ? { storage } : {}),
  });
  status.textContent = `PostgreSQL 18 is running through the ${smoke ? 'direct root' : 'Worker-owned'} entrypoint.`;
  if (smoke) {
    await installSelectedExtensions(database, extensions);
    await expectStructuredApi(database, 'browser direct');
    await expectConcurrentDirectExecution(database);
    await expectExclusiveOwnership(storage, extensions, 'IndexedDB');
    const pgtapVersion = await exercisePgtap(database);
    const firstUuid = pgUuidv7Canary ? await readPgUuidv7(database) : undefined;
    await database.queryRaw('CREATE TABLE browser_reopen_probe (answer integer NOT NULL)');
    await database.queryRaw('INSERT INTO browser_reopen_probe VALUES (42)');
    await database.execute('CHECKPOINT');
    // This row is intentionally newer than the explicit checkpoint. Its query
    // Promise includes an operation storage boundary; clean close also drains
    // the journal before releasing ownership.
    await database.queryRaw('INSERT INTO browser_reopen_probe VALUES (43)');
    await expectSqlstate(database, 'SELEC 1', '42601');
    await expectAnswer(database);
    await expectSqlstate(database, 'SELECT 1 / $1::int', '22012', [0]);
    await expectAnswer(database);
    await expectTransaction(database);
    await expectClockConsistency(database);
    const recoveredPgtapVersion = await readPgtapVersion(database);
    if (recoveredPgtapVersion !== pgtapVersion) {
      throw new Error('browser smoke observed a different pgtap version after recovery');
    }
    if (pgUuidv7Canary) {
      await readPgUuidv7(database);
    }
    await expectDirectPgDump(database);
    await database.close();

    directWorkerAudit?.assertNoneAndRestore();
    await expectDirectWithoutWorker();
    await expectFailedWorkerOpenRecovery();

    database = await WorkerOliphaunt.open({ storage, extensions });
    await expectStructuredApi(database, 'browser Worker');
    await expectSqlstate(database, 'SELEC 1', '42601');
    await expectAnswer(database);
    await expectSqlstate(database, 'SELECT 1 / $1::int', '22012', [0]);
    await expectAnswer(database);
    await expectOwnedRawProtocolResponse(database);
    await expectClockConsistency(database);
    const reopened = await database.queryRaw(
      'SELECT string_agg(answer::text, $1 ORDER BY answer) AS answers FROM browser_reopen_probe',
      [','],
    );
    if (reopened.getText(0, 'answers') !== '42,43') {
      throw new Error('browser smoke did not reopen operation-persisted PGDATA');
    }
    if ((await readPgtapVersion(database)) !== pgtapVersion) {
      throw new Error('browser smoke did not reconstruct the selected pgtap carrier on reopen');
    }
    if (pgUuidv7Canary) {
      await readPgUuidv7(database);
    }
    await database.close();
    const logicalTools = await expectLogicalTools();
    const opfsAnswers = await expectOpfsPersistence(extensions);
    const opfsCrash = await expectOpfsCrashRecovery();
    const postgisVersion = postgisWorkerCanary ? await expectLargePostgisWorkerModule() : undefined;
    status.textContent = 'Browser smoke passed.';
    output.textContent = JSON.stringify({
      answers: [42, 43],
      opfsAnswers,
      pgtap: pgtapVersion,
      startupSqlstate: '3D000',
      directWorkers: 0,
      directPgDump: true,
      opfsTransport: 'synchronous-access',
      opfsCrashAnswer: opfsCrash.answer,
      opfsCrashRelations: opfsCrash.relations,
      logicalTools,
      ...(firstUuid === undefined ? {} : { pg_uuidv7: firstUuid }),
      ...(postgisVersion === undefined ? {} : { postgis: postgisVersion }),
    });
    document.documentElement.dataset.oliphauntSmoke = 'passed';
  } else {
    run.disabled = false;
    run.addEventListener('click', async () => {
      run.disabled = true;
      output.textContent = '';
      try {
        const result = await database.queryRaw(sql.value);
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

function simpleQuery(sql: string): Uint8Array {
  if (sql.includes('\0')) throw new Error('simple query SQL must not contain NUL bytes');
  const body = new TextEncoder().encode(`${sql}\0`);
  const message = new Uint8Array(body.length + 5);
  message[0] = 0x51;
  new DataView(message.buffer).setUint32(1, body.length + 4);
  message.set(body, 5);
  return message;
}

async function expectLargePostgisWorkerModule(): Promise<string> {
  const { default: postgis } = await import('@oliphaunt/extension-postgis-wasix');
  const dependencyModule = postgis.carriers
    .flatMap((carrier) => carrier.install.nativeModules)
    .find((module) => module.name === 'postgis_deps');
  if (dependencyModule === undefined || dependencyModule.size <= 8 * 1024 * 1024) {
    throw new Error('browser worker canary requires a PostGIS side module larger than 8 MiB');
  }

  const database = await WorkerOliphaunt.open({ extensions: [postgis] });
  try {
    await database.execute('CREATE EXTENSION postgis');
    const version = await readPostgisVersion(database);
    await database.queryRaw('CREATE TEMP TABLE postgis_nested_error_catch(value integer)');
    await database.queryRaw(
      `DO $$ BEGIN
         BEGIN
           PERFORM ST_GeomFromText('POINT(');
         EXCEPTION WHEN OTHERS THEN
           INSERT INTO postgis_nested_error_catch VALUES (1);
         END;
       END $$`,
    );
    const caught = await database.queryRaw(
      'SELECT count(*)::int AS count FROM postgis_nested_error_catch',
    );
    if (caught.getText(0, 'count') !== '1') {
      throw new Error('browser worker did not catch an error crossing PostGIS side modules');
    }
    try {
      await database.queryRaw("SELECT ST_GeomFromText('POINT(')");
      throw new Error('browser worker expected malformed PostGIS geometry to fail');
    } catch (error) {
      if (!(error instanceof PostgresError)) {
        throw error;
      }
    }
    if ((await readPostgisVersion(database)) !== version) {
      throw new Error('browser worker did not recover its PostGIS session after an error');
    }
    return version;
  } finally {
    await database.close();
  }
}

async function readPostgisVersion(database: OliphauntDatabase): Promise<string> {
  const result = await database.queryRaw('SELECT postgis_full_version()::text AS version');
  const version = result.getText(0, 'version');
  if (version === null || !version.includes('POSTGIS=')) {
    throw new Error(
      `browser worker returned an invalid PostGIS version: ${JSON.stringify(version)}`,
    );
  }
  return version;
}

function expectOwnedMemoryCopyAcrossGrowth(): void {
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 2 });
  const guest = new Uint8Array(memory.buffer, 0, 4);
  guest.set([1, 2, 3, 4]);
  const owned = guest.slice();
  const previousBuffer = memory.buffer;
  memory.grow(1);
  if (memory.buffer === previousBuffer) {
    throw new Error('WebAssembly memory growth did not replace its backing buffer');
  }
  new Uint8Array(memory.buffer, 0, 4).fill(9);
  if (!owned.every((byte, index) => byte === index + 1)) {
    throw new Error('owned protocol bytes changed after explicit WebAssembly memory growth');
  }
}

async function expectConcurrentDirectExecution(first: OliphauntDatabase): Promise<void> {
  const attempts = await Promise.allSettled([Oliphaunt.open(), Oliphaunt.open()]);
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
    const database = await Oliphaunt.open();
    try {
      await expectAnswer(database);
      await expectOwnedRawProtocolResponse(database);
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
    const result = await transaction.queryRaw('SELECT $1::int + 1 AS answer', [41]);
    return result.getText(0, 'answer');
  });
  if (answer !== '42') {
    throw new Error(`browser smoke transaction expected 42, received ${JSON.stringify(answer)}`);
  }
}

async function expectOwnedRawProtocolResponse(database: OliphauntDatabase): Promise<void> {
  const retained = await database.execProtocolRaw(
    simpleQuery("SELECT repeat('a', 10240) AS retained_payload"),
  );
  const snapshot = retained.slice();
  const large = await database.execProtocolRaw(
    simpleQuery("SELECT repeat('z', 1048576) AS large_payload"),
  );
  if (large.byteLength < 1048576) {
    throw new Error(
      `browser worker returned a truncated large PGWire response: ${large.byteLength}`,
    );
  }
  if (
    retained.byteLength !== snapshot.byteLength ||
    !retained.every((byte, index) => byte === snapshot[index])
  ) {
    throw new Error('browser worker response changed after the guest reused its output memory');
  }
}

async function expectLogicalTools(): Promise<string> {
  const source = await WorkerOliphaunt.open({ extensions: [pgtap] });
  let sql: string;
  try {
    await psql(source, { script: logicalToolsSeed });
    sql = await pgDump(source);
    if (!sql.includes('COPY public.logical_items') || sql.includes('--inserts')) {
      throw new Error('browser pg_dump did not preserve standard plain COPY output');
    }
  } finally {
    await source.close();
  }

  const target = await WorkerOliphaunt.open({ extensions: [pgtap] });
  try {
    await psql(target, { script: sql });
    const result = await target.queryRaw(logicalToolsVerify);
    const actual = {
      rows: Number(result.getText(0, 'rows')),
      sum: Number(result.getText(0, 'sum')),
      sequenceLastValue: Number(result.getText(0, 'sequence_last_value')),
      quotedValue: result.getText(0, 'quoted_value'),
      normalizedMatches: Number(result.getText(0, 'normalized_matches')),
      extensionLoaded: result.getText(0, 'extension_loaded') === 't',
    };
    if (JSON.stringify(actual) !== JSON.stringify(logicalToolsFixture.expected)) {
      throw new Error(
        `browser logical tool round trip differed from the shared fixture: ${JSON.stringify(actual)}`,
      );
    }
    return `${actual.rows}:${actual.sum}:${actual.sequenceLastValue}`;
  } finally {
    await target.close();
  }
}

async function expectClockConsistency(database: OliphauntDatabase): Promise<void> {
  const wallClock = await database.queryRaw(
    'SELECT (extract(epoch FROM clock_timestamp()) * 1000)::bigint AS millis',
  );
  const wallClockMillis = Number(wallClock.getText(0, 'millis'));
  if (!Number.isFinite(wallClockMillis) || Math.abs(Date.now() - wallClockMillis) > 5_000) {
    throw new Error(`browser WASI realtime clock drifted: ${wallClockMillis}`);
  }
  const plan = await database.queryRaw('EXPLAIN (ANALYZE, FORMAT JSON) SELECT pg_sleep(0.05)');
  const explain = JSON.parse(plan.getText(0, 'QUERY PLAN') ?? 'null');
  const elapsed = explain?.[0]?.['Execution Time'];
  if (!Number.isFinite(elapsed) || elapsed < 25 || elapsed > 5_000) {
    throw new Error(`browser WASI monotonic clock returned invalid elapsed time: ${elapsed}`);
  }
}

async function expectStartupSqlstate(
  database: string,
  sqlstate: string,
  client: typeof Oliphaunt,
): Promise<void> {
  try {
    const unexpected = await client.open({ database });
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
  await expectStartupSqlstate('oliphaunt_browser_smoke_missing_database', '3D000', Oliphaunt);
  const reopened = await Oliphaunt.open();
  try {
    await expectAnswer(reopened);
  } finally {
    await reopened.close();
  }
}

async function expectFailedWorkerOpenRecovery(): Promise<void> {
  await expectStartupSqlstate(
    'oliphaunt_browser_worker_missing_database',
    '3D000',
    WorkerOliphaunt,
  );
  const reopened = await WorkerOliphaunt.open();
  try {
    await expectAnswer(reopened);
  } finally {
    await reopened.close();
  }
}

async function expectExclusiveOwnership(
  storage: WasixStorage,
  extensions: readonly WasixExtensionDescriptor[],
  provider: string,
): Promise<void> {
  try {
    const duplicate = await Oliphaunt.open({ storage, extensions });
    await duplicate.close();
    throw new Error(`browser smoke opened one ${provider} database twice`);
  } catch (error) {
    if (!(error instanceof WasixStorageError) || error.code !== 'busy') {
      throw error;
    }
  }
}

async function expectOpfsPersistence(
  extensions: readonly WasixExtensionDescriptor[],
): Promise<string> {
  const storage = opfs('browser-smoke');
  let database = await Oliphaunt.open({ storage, extensions });
  await expectExclusiveOwnership(storage, extensions, 'OPFS');
  await database.queryRaw('CREATE TABLE opfs_reopen_probe (answer integer NOT NULL)');
  await database.queryRaw('INSERT INTO opfs_reopen_probe VALUES (1)');
  // PostgreSQL normally retains the relation and WAL descriptors. This second
  // operation proves that the host journal observes writes after initial open.
  await database.queryRaw('INSERT INTO opfs_reopen_probe VALUES (2)');
  await database.close();

  database = await WorkerOliphaunt.open({ storage, extensions });
  try {
    await expectSynchronousOpfsTransport('browser-smoke');
    const reopened = await database.queryRaw(
      'SELECT string_agg(answer::text, $1 ORDER BY answer) AS answers FROM opfs_reopen_probe',
      [','],
    );
    const answers = reopened.getText(0, 'answers');
    if (answers !== '1,2') {
      throw new Error(`browser smoke did not reopen OPFS state: ${answers}`);
    }
    await database.queryRaw('INSERT INTO opfs_reopen_probe VALUES (3)');
    await database.queryRaw('CREATE TABLE opfs_sync_create_probe (answer integer NOT NULL)');
    await database.queryRaw('INSERT INTO opfs_sync_create_probe VALUES (99)');
    await database.execute('CHECKPOINT');
  } finally {
    await database.close();
  }

  database = await Oliphaunt.open({ storage, extensions });
  try {
    const reopened = await database.queryRaw(
      'SELECT string_agg(answer::text, $1 ORDER BY answer) AS answers FROM opfs_reopen_probe',
      [','],
    );
    const answers = reopened.getText(0, 'answers');
    if (answers !== '1,2,3') {
      throw new Error(`browser smoke did not reopen synchronous OPFS writes: ${answers}`);
    }
    const created = await database.queryRaw('SELECT answer FROM opfs_sync_create_probe');
    if (created.getText(0, 'answer') !== '99') {
      throw new Error('browser smoke did not reopen a relation created through synchronous OPFS');
    }
    return answers;
  } finally {
    await database.close();
  }
}

async function expectSynchronousOpfsTransport(name: string): Promise<void> {
  const worker = new Worker(new URL('./opfs-transport-probe-worker.ts', import.meta.url), {
    type: 'module',
  });
  try {
    const response = await new Promise<
      { ok: true; transport: 'synchronous-access' | 'portable' } | { ok: false; error: string }
    >((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('OPFS transport probe timed out')), 10_000);
      worker.addEventListener(
        'error',
        (event) => {
          clearTimeout(timeout);
          reject(event.error ?? new Error(event.message));
        },
        { once: true },
      );
      worker.addEventListener(
        'message',
        (event: MessageEvent) => {
          clearTimeout(timeout);
          resolve(
            event.data as
              | { ok: true; transport: 'synchronous-access' | 'portable' }
              | { ok: false; error: string },
          );
        },
        { once: true },
      );
      worker.postMessage({ name });
    });
    if (!response.ok) throw new Error(`OPFS transport probe failed: ${response.error}`);
    if (response.transport !== 'synchronous-access') {
      throw new Error(
        'browser smoke selected portable OPFS instead of the synchronous-access Worker path',
      );
    }
  } finally {
    worker.terminate();
  }
}

async function expectOpfsCrashRecovery(): Promise<Readonly<{ answer: string; relations: string }>> {
  const name = `browser-crash-${crypto.randomUUID()}`;
  const worker = new Worker(new URL('./opfs-crash-probe-worker.ts', import.meta.url), {
    type: 'module',
  });
  try {
    const response = await new Promise<
      Readonly<{ ok: true }> | Readonly<{ ok: false; error: string }>
    >((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('OPFS crash-recovery setup timed out')),
        60_000,
      );
      worker.addEventListener(
        'error',
        (event) => {
          clearTimeout(timeout);
          reject(event.error ?? new Error(event.message));
        },
        { once: true },
      );
      worker.addEventListener(
        'message',
        (event: MessageEvent) => {
          clearTimeout(timeout);
          resolve(event.data as Readonly<{ ok: true }> | Readonly<{ ok: false; error: string }>);
        },
        { once: true },
      );
      worker.postMessage({ name });
    });
    if (!response.ok) throw new Error(`OPFS crash-recovery setup failed: ${response.error}`);
  } finally {
    worker.terminate();
  }

  const database = await Oliphaunt.open({ storage: opfs(name) });
  try {
    const result = await database.queryRaw('SELECT answer FROM opfs_crash_probe');
    const answer = result.getText(0, 'answer');
    if (answer !== '73') {
      throw new Error(`OPFS crash recovery returned an unexpected answer: ${answer}`);
    }
    const relationResult = await database.queryRaw(`
      SELECT count(*)::text AS count
      FROM pg_class
      WHERE relname LIKE 'opfs_crash_burst_%'
    `);
    const relations = relationResult.getText(0, 'count');
    if (relations !== '48') {
      throw new Error(`OPFS crash recovery returned an unexpected relation count: ${relations}`);
    }
    return { answer, relations };
  } finally {
    await database.close();
  }
}

async function exercisePgtap(database: OliphauntDatabase): Promise<string> {
  const version = await readPgtapVersion(database);
  const plan = await database.queryRaw('SELECT plan(1)::text AS tap');
  if (plan.getText(0, 'tap') !== '1..1') {
    throw new Error('browser smoke expected pgtap plan(1) to return 1..1');
  }
  const assertion = await database.queryRaw("SELECT ok(true, 'browser pgtap')::text AS tap");
  if (assertion.getText(0, 'tap') !== 'ok 1 - browser pgtap') {
    throw new Error('browser smoke expected pgtap ok() to report a passing assertion');
  }
  await database.queryRaw('SELECT * FROM finish()');
  return version;
}

async function installSelectedExtensions(
  database: OliphauntDatabase,
  extensions: readonly WasixExtensionDescriptor[],
): Promise<void> {
  for (const extension of extensions) {
    const sqlName = `"${extension.sqlName.replaceAll('"', '""')}"`;
    await database.execute(`CREATE EXTENSION IF NOT EXISTS ${sqlName}`);
  }
}

async function readPgtapVersion(database: OliphauntDatabase): Promise<string> {
  const pgtap = await database.queryRaw('SELECT pgtap_version()::text AS version');
  const version = pgtap.getText(0, 'version');
  if (version === null || version.length === 0) {
    throw new Error('browser smoke expected pgtap_version() to return a version');
  }
  return version;
}

async function readPgUuidv7(database: OliphauntDatabase): Promise<string> {
  const result = await database.queryRaw('SELECT uuid_generate_v7()::text AS uuid');
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
    await database.queryRaw(query, parameters);
    throw new Error(`browser smoke expected SQLSTATE ${sqlstate}`);
  } catch (error) {
    if (!(error instanceof PostgresError) || error.sqlstate !== sqlstate) {
      throw error;
    }
  }
}

async function expectAnswer(database: OliphauntDatabase): Promise<void> {
  const result = await database.queryRaw('SELECT 40 + 2 AS answer');
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
        throw new Error(`root entrypoint constructed ${constructed} Web Worker(s)`);
      }
    },
    restore,
  };
}
