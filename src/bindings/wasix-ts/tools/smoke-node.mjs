import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createPackedWasixConsumer, runFixtureCommand } from './packed-node-fixture.mjs';

const { packageOnly, runtime } = readOptions(process.argv.slice(2));
const runtimeName = runtime === 'bun' ? 'Bun' : runtime === 'deno' ? 'Deno' : 'Node';
const expectedEntrypoint = `index.${runtime}.js`;
const expectedWorkerEntrypoint = `worker-entry.${runtime}.js`;
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const scratch = await mkdtemp(resolve(tmpdir(), `oliphaunt-wasix-${runtime}-smoke-`));

try {
  const fixture = await createPackedWasixConsumer({
    scratch,
    consumerName: `oliphaunt-wasix-${runtime}-smoke-consumer`,
    includePgtap: !packageOnly,
    useStubRuntime: packageOnly,
  });
  const candidate = fixture.packages.binding.name;
  const extension = fixture.packages.extension?.name;
  await writeFile(
    resolve(fixture.consumer, 'verify.mjs'),
    `import { Worker } from 'node:worker_threads';

const candidate = ${JSON.stringify(candidate)};
const extension = ${JSON.stringify(extension)};
const runtime = ${JSON.stringify(runtime)};
const runtimeName = ${JSON.stringify(runtimeName)};
const packageOnly = ${JSON.stringify(packageOnly)};
const pgtap = packageOnly ? undefined : (await import(extension)).default;
const executionSurfaces = {
  direct: {
    entrypoint: candidate,
    resolvedEntrypoint: ${JSON.stringify(expectedEntrypoint)},
    callingContract: 'async',
    executionOwner: 'caller',
  },
  worker: {
    entrypoint: candidate + '/worker',
    resolvedEntrypoint: ${JSON.stringify(expectedWorkerEntrypoint)},
    callingContract: 'async',
    executionOwner: 'sdk-worker',
  },
};
const { default: Oliphaunt, PostgresError, postgresOids, WasixStorageError } = await import(candidate);
const { default: WorkerOliphaunt } = await import(candidate + '/worker');
const { directory } = await import(candidate + '/storage/' + runtime);
const simpleQuery = (sql) => {
  const body = new TextEncoder().encode(sql + '\\0');
  const message = new Uint8Array(body.length + 5);
  message[0] = 0x51;
  new DataView(message.buffer).setUint32(1, body.length + 4);
  message.set(body, 5);
  return message;
};

const resolved = import.meta.resolve(candidate);
if (!resolved.endsWith('/lib/${expectedEntrypoint}')) {
  throw new Error(runtimeName + ' did not select its direct entrypoint: ' + resolved);
}
const workerResolved = import.meta.resolve(candidate + '/worker');
if (!workerResolved.endsWith('/lib/${expectedWorkerEntrypoint}')) {
  throw new Error(
    runtimeName + ' did not select its Worker entrypoint: ' + workerResolved,
  );
}
if (!packageOnly) {
  const callerSource = [
    "import { parentPort } from 'node:worker_threads';",
    'const { default: DirectOliphaunt } = await import(' + JSON.stringify(resolved) + ');',
    'const { default: WorkerOliphaunt } = await import(' + JSON.stringify(workerResolved) + ');',
    'const { directory } = await import(' +
      JSON.stringify(import.meta.resolve(candidate + '/storage/' + runtime)) +
      ');',
    'try {',
    '  const direct = await DirectOliphaunt.open({ storage: directory(' +
      JSON.stringify(new URL('./caller-worker-storage', import.meta.url).href) +
      ') });',
    "  const directAnswer = (await direct.queryRaw('SELECT 42::int AS answer')).getText(0, 'answer');",
    '  await direct.close();',
    '  const nestedWorker = await WorkerOliphaunt.open();',
    "  const workerAnswer = (await nestedWorker.queryRaw('SELECT 43::int AS answer')).getText(0, 'answer');",
    '  await nestedWorker.close();',
    '  parentPort.postMessage({ directAnswer, workerAnswer });',
    '} catch (error) {',
    '  parentPort.postMessage({ name: error?.name, message: error?.message });',
    '}',
  ].join('\\n');
  const callerResult = await new Promise((resolveResult, rejectResult) => {
    let receivedMessage = false;
    const worker = new Worker(
      new URL('data:text/javascript,' + encodeURIComponent(callerSource)),
      { name: 'oliphaunt-caller-worker-check' },
    );
    worker.once('message', (message) => {
      receivedMessage = true;
      void worker.terminate().then(() => resolveResult(message), rejectResult);
    });
    worker.once('error', rejectResult);
    worker.once('exit', (code) => {
      if (!receivedMessage && code !== 0) {
        rejectResult(new Error('caller worker exited with code ' + code));
      }
    });
  });
  if (callerResult?.directAnswer !== '42' || callerResult?.workerAnswer !== '43') {
    throw new Error('caller-worker execution failed: ' + JSON.stringify(callerResult));
  }
}

if (packageOnly) {
  const storage = directory(new URL('./package-condition-storage', import.meta.url));
  if (!Object.isFrozen(storage) || Reflect.ownKeys(storage).length !== 0) {
    throw new Error(runtimeName + ' storage condition returned an invalid adapter');
  }
  console.log(JSON.stringify({
    host: runtime + '-package-condition-direct-and-worker_threads',
    executionSurfaces,
    storage: runtime + '-directory',
  }));
} else {
async function verifyMemory(client, executionSurface) {
  // OLIPHAUNT_DOCS_SNIPPET wasix-typescript-quickstart
  const db = await client.open({ extensions: [pgtap] });
  await db.execute('CREATE EXTENSION pgtap');
  const structuredApi = await verifyStructuredApi(db);
  const version = (await db.queryRaw('SELECT pgtap_version()::text AS version')).getText(0, 'version');
  const retainedProtocol = await db.execProtocolRaw(
    simpleQuery("SELECT repeat('a', 8192) AS retained_payload"),
  );
  const retainedSnapshot = retainedProtocol.slice();
  await db.execProtocolRaw(simpleQuery("SELECT repeat('z', 8192) AS replacement_payload"));
  const protocolResponseOwned =
    retainedProtocol.length === retainedSnapshot.length &&
    retainedProtocol.every((byte, index) => byte === retainedSnapshot[index]);
  const wallClockMillis = Number((await db.queryRaw(
    'SELECT (extract(epoch FROM clock_timestamp()) * 1000)::bigint AS millis',
  )).getText(0, 'millis'));
  const wallClockDeltaMillis = Math.abs(Date.now() - wallClockMillis);
  const explain = JSON.parse((await db.queryRaw(
    'EXPLAIN (ANALYZE, FORMAT JSON) SELECT pg_sleep(0.05)',
  )).getText(0, 'QUERY PLAN'));
  const monotonicElapsedMillis = explain[0]?.['Execution Time'];
  await db.execute('CREATE TABLE smoke_transaction (value integer NOT NULL)');
  const transactionValue = await db.transaction(async (tx) => {
    await tx.execute('INSERT INTO smoke_transaction VALUES ($1)', [7]);
    return (await tx.queryRaw('SELECT value::text AS value FROM smoke_transaction')).getText(0, 'value');
  });
  const rollbackSentinel = new Error('packed transaction rollback sentinel');
  try {
    await db.transaction(async (tx) => {
      await tx.execute('INSERT INTO smoke_transaction VALUES ($1)', [9]);
      throw rollbackSentinel;
    });
    throw new Error('failed packed transaction unexpectedly committed');
  } catch (error) {
    if (error !== rollbackSentinel) throw error;
  }
  const transactionRows = (await db.queryRaw(
    'SELECT count(*)::int AS count FROM smoke_transaction',
  )).getText(0, 'count');
  let sqlstate;
  try {
    await db.queryRaw('SELEC 1');
  } catch (error) {
    if (!(error instanceof PostgresError)) throw error;
    sqlstate = error.sqlstate;
  }
  const answer = (await db.queryRaw('SELECT 42::int AS answer')).getText(0, 'answer');
  await db[Symbol.asyncDispose]();
  const result = {
    version,
    protocolResponseOwned,
    wallClockDeltaMillis,
    monotonicElapsedMillis,
    transactionValue,
    transactionRows,
    sqlstate,
    answer,
    structuredApi,
  };
  if (
    !version ||
    !protocolResponseOwned ||
    wallClockDeltaMillis > 5_000 ||
    !Number.isFinite(monotonicElapsedMillis) ||
    monotonicElapsedMillis < 25 ||
    monotonicElapsedMillis > 5_000 ||
    transactionValue !== '7' ||
    transactionRows !== '1' ||
    sqlstate !== '42601' ||
    answer !== '42' ||
    structuredApi !== '42:9007199254740993:3:custom:42:42:2'
  ) {
    throw new Error(executionSurface + ': ' + JSON.stringify(result));
  }
  return result;
}

async function verifyStructuredApi(db) {
  const decoded = await db.query(
    'SELECT $1::int4 AS answer, $2::int8 AS wide, $3::jsonb AS document, $4::int4[] AS numbers',
    [42, 9007199254740993n, { ok: true }, [1, 2, 3]],
  );
  const objectRow = decoded.rows[0];
  if (
    objectRow?.answer !== 42 ||
    objectRow?.wide !== '9007199254740993' ||
    objectRow?.document?.ok !== true ||
    JSON.stringify(objectRow?.numbers) !== '[1,2,3]'
  ) {
    throw new Error('decoded object-row contract failed: ' + JSON.stringify(objectRow));
  }

  const positional = await db.query('SELECT 41::int4 AS left, 42::int4 AS right', [], {
    rowMode: 'array',
  });
  if (JSON.stringify(positional.rows) !== '[[41,42]]') {
    throw new Error('decoded array-row contract failed: ' + JSON.stringify(positional.rows));
  }

  const custom = await db.query('SELECT 42::int4 AS answer', [], {
    decoders: {
      [postgresOids.int4]: (value, field) => 'custom:' + value + ':' + field.typeOid,
    },
  });
  if (custom.rows[0]?.answer !== 'custom:42:23') {
    throw new Error('OID decoder contract failed: ' + JSON.stringify(custom.rows));
  }

  const description = await db.describe('SELECT $1::int4 AS answer');
  if (
    description.parameterTypeOids[0] !== postgresOids.int4 ||
    description.fields?.[0]?.typeOid !== postgresOids.int4
  ) {
    throw new Error('describe contract failed: ' + JSON.stringify(description));
  }

  const execution = await db.exec('SELECT 1::int4 AS first; SELECT 2::int4 AS second');
  if (
    execution.statements.length !== 2 ||
    execution.statements[0]?.rows[0]?.first !== 1 ||
    execution.statements[1]?.rows[0]?.second !== 2
  ) {
    throw new Error('multi-statement exec contract failed: ' + JSON.stringify(execution));
  }

  return [
    objectRow.answer,
    objectRow.wide,
    objectRow.numbers.length,
    String(custom.rows[0].answer).split(':').slice(0, 2).join(':'),
    positional.rows[0][1],
    execution.statements.length,
  ].join(':');
}

const direct = await verifyMemory(Oliphaunt, 'direct');
const worker = await verifyMemory(WorkerOliphaunt, 'worker');
if (direct.version !== worker.version) {
  throw new Error('entrypoint extension versions differ: ' + JSON.stringify({ direct, worker }));
}

const storage = directory(new URL('./database space ü', import.meta.url));
let persistent = await Oliphaunt.open({ storage, extensions: [pgtap] });
await persistent.execute('CREATE EXTENSION pgtap');
await persistent.execute('CREATE SEQUENCE smoke_persistence_seq START WITH 10');
await persistent.execute(
  'CREATE TABLE smoke_persistence (' +
    ${JSON.stringify("ordinal bigint PRIMARY KEY DEFAULT nextval('smoke_persistence_seq'), ")} +
    'label text NOT NULL, payload bytea NOT NULL, optional_value text NULL)'
);
await persistent.execute('CREATE UNIQUE INDEX smoke_persistence_label_idx ON smoke_persistence(label)');
await persistent.execute(
  "INSERT INTO smoke_persistence(label, payload, optional_value) VALUES " +
    "('café 🐘', decode('00ff10', 'hex'), NULL), " +
    "('東京', decode('deadbeef', 'hex'), 'present'), " +
    "('mañana', decode('', 'hex'), NULL)"
);
await persistent.execute('CREATE TEMP TABLE smoke_direct_session(value text NOT NULL)');
await persistent.execute("INSERT INTO smoke_direct_session VALUES ('direct-session')");
await persistent.execute("SET application_name = 'packed-direct-session'");
await persistent.execute('CHECKPOINT');
let busy;
try {
  await WorkerOliphaunt.open({ storage, extensions: [pgtap] });
} catch (error) {
  if (!(error instanceof WasixStorageError)) throw error;
  busy = error.code;
}
const directArchive = await persistent.backup();
const directSessionState = (await persistent.queryRaw(
  "SELECT (SELECT value FROM smoke_direct_session) || ':' || current_setting('application_name') AS value",
)).getText(0, 'value');
await persistent.close();

persistent = await WorkerOliphaunt.open({ storage, extensions: [pgtap] });
const workerPersistedRows = (await persistent.queryRaw(
  'SELECT count(*)::int AS count FROM smoke_persistence',
)).getText(0, 'count');
const persistentExtension = (await persistent.queryRaw(
  'SELECT pgtap_version()::text AS version',
)).getText(0, 'version');
await persistent.execute(
  "INSERT INTO smoke_persistence(label, payload, optional_value) " +
    "VALUES ('naïve', decode('010203', 'hex'), NULL)"
);
await persistent.execute('CREATE TEMP TABLE smoke_worker_session(value text NOT NULL)');
await persistent.execute("INSERT INTO smoke_worker_session VALUES ('worker-session')");
await persistent.execute("SET application_name = 'packed-worker-session'");
await persistent.execute('CHECKPOINT');
const workerArchive = await persistent.backup();
const workerSessionState = (await persistent.queryRaw(
  "SELECT (SELECT value FROM smoke_worker_session) || ':' || current_setting('application_name') AS value",
)).getText(0, 'value');
await persistent.close();

const directRestoreStorage = directory(new URL('./direct-backup-restore', import.meta.url));
await WorkerOliphaunt.restore(directRestoreStorage, directArchive);
let restored = await WorkerOliphaunt.open({
  storage: directRestoreStorage,
  extensions: [pgtap],
});
const directBackupRows = (await restored.queryRaw(
  'SELECT count(*)::int AS count FROM smoke_persistence',
)).getText(0, 'count');
const directBackupValues = await richBackupValues(restored);
const directBackupSequence = (await restored.queryRaw(
  "SELECT nextval('smoke_persistence_seq')::text AS value",
)).getText(0, 'value');
await restored.close();

const workerRestoreStorage = directory(new URL('./worker-backup-restore', import.meta.url));
await Oliphaunt.restore(workerRestoreStorage, workerArchive);
restored = await Oliphaunt.open({
  storage: workerRestoreStorage,
  extensions: [pgtap],
});
const workerBackupRows = (await restored.queryRaw(
  'SELECT count(*)::int AS count FROM smoke_persistence',
)).getText(0, 'count');
const workerBackupValues = await richBackupValues(restored);
const workerBackupSequence = (await restored.queryRaw(
  "SELECT nextval('smoke_persistence_seq')::text AS value",
)).getText(0, 'value');
await restored.close();
let corruptRestore;
try {
  await WorkerOliphaunt.restore(
    directory(new URL('./corrupt-backup-restore', import.meta.url)),
    Uint8Array.of(1, 2, 3),
  );
} catch (error) {
  if (!(error instanceof WasixStorageError)) throw error;
  corruptRestore = error.code + ':' + error.commitState;
}
if (
  busy !== 'busy' ||
  workerPersistedRows !== '3' ||
  directBackupRows !== '3' ||
  workerBackupRows !== '4' ||
  directBackupValues !== 'café 🐘:00ff10:NULL|mañana::NULL|東京:deadbeef:present' ||
  workerBackupValues !== 'café 🐘:00ff10:NULL|mañana::NULL|naïve:010203:NULL|東京:deadbeef:present' ||
  directBackupSequence !== '13' ||
  workerBackupSequence !== '14' ||
  directSessionState !== 'direct-session:packed-direct-session' ||
  workerSessionState !== 'worker-session:packed-worker-session' ||
  corruptRestore !== 'corrupt:unchanged' ||
  persistentExtension !== direct.version
) {
  throw new Error(JSON.stringify({
    busy,
    workerPersistedRows,
    directBackupRows,
    workerBackupRows,
    directBackupValues,
    workerBackupValues,
    directBackupSequence,
    workerBackupSequence,
    directSessionState,
    workerSessionState,
    corruptRestore,
    persistentExtension,
    version: direct.version,
  }));
}
console.log(JSON.stringify({
  host: runtime + '-direct-and-worker_threads',
  executionSurfaces,
  surfaceResults: { direct, worker },
  extension: 'pgtap',
  version: direct.version,
  storage: runtime + '-raw-pgdata-delta',
  busy,
  workerPersistedRows,
  backupRestore: {
    directBackupRows,
    workerBackupRows,
    directBackupSequence,
    workerBackupSequence,
    corruptRestore,
  },
}));

async function richBackupValues(db) {
  const index = (await db.queryRaw(
    "SELECT to_regclass('smoke_persistence_label_idx')::text AS value",
  )).getText(0, 'value');
  if (index !== 'smoke_persistence_label_idx') {
    throw new Error('restored physical backup omitted smoke_persistence_label_idx: ' + index);
  }
  return (await db.queryRaw(
    ${JSON.stringify(
      "SELECT string_agg(label || ':' || encode(payload, 'hex') || ':' || " +
        "coalesce(optional_value, 'NULL'), '|' ORDER BY label COLLATE \"C\") AS value " +
        'FROM smoke_persistence',
    )}
  )).getText(0, 'value');
}
}
`,
  );
  const verification = runtimeVerificationCommand(
    runtime,
    pathToFileURL(resolve(fixture.consumer, 'verify.mjs')).href,
  );
  const { stdout } = await runFixtureCommand(
    verification.command,
    verification.args,
    fixture.consumer,
    300_000,
  );
  console.log(`wasix-ts ${runtimeName} smoke: PASS ${stdout.trim()}`);
} finally {
  await rm(scratch, { force: true, recursive: true });
}

function readOptions(args) {
  let packageOnly = false;
  let runtime = 'node';
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--package-only' && !packageOnly) {
      packageOnly = true;
      continue;
    }
    if (
      argument === '--runtime' &&
      index + 1 < args.length &&
      ['bun', 'deno', 'node'].includes(args[index + 1])
    ) {
      runtime = args[index + 1];
      index += 1;
      continue;
    }
    throw new Error('usage: smoke-node.mjs [--runtime node|bun|deno] [--package-only]');
  }
  return { packageOnly, runtime };
}

function runtimeVerificationCommand(runtime, verificationUrl) {
  const expression = `await import(${JSON.stringify(verificationUrl)})`;
  switch (runtime) {
    case 'node':
      return {
        command: process.execPath,
        args: ['--input-type=module', '--eval', expression],
      };
    case 'bun':
      return {
        command: resolve(repositoryRoot, 'tools/dev/bun.sh'),
        args: ['--eval', expression],
      };
    case 'deno':
      return {
        command: resolve(repositoryRoot, 'tools/dev/deno.sh'),
        args: ['run', '--allow-all', verificationUrl],
      };
  }
}
