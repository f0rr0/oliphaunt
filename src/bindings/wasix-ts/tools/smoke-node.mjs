import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createPackedWasixConsumer, runFixtureCommand } from './packed-node-fixture.mjs';

const { packageOnly, runtime } = readOptions(process.argv.slice(2));
const runtimeName = runtime === 'bun' ? 'Bun' : runtime === 'deno' ? 'Deno' : 'Node';
const expectedEntrypoint = `index.${runtime}.js`;
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
    `import { access } from 'node:fs/promises';
import { Worker } from 'node:worker_threads';

const candidate = ${JSON.stringify(candidate)};
const extension = ${JSON.stringify(extension)};
const runtime = ${JSON.stringify(runtime)};
const runtimeName = ${JSON.stringify(runtimeName)};
const packageOnly = ${JSON.stringify(packageOnly)};
const pgtap = packageOnly ? undefined : (await import(extension)).default;
const { default: Oliphaunt, PostgresError, WasixStorageError } = await import(candidate);
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
  throw new Error(runtimeName + ' did not select its worker_threads entrypoint: ' + resolved);
}
const callerSource = [
  "import { parentPort } from 'node:worker_threads';",
  'const { default: Oliphaunt } = await import(' + JSON.stringify(resolved) + ');',
  'const { directory } = await import(' +
    JSON.stringify(import.meta.resolve(candidate + '/storage/' + runtime)) +
    ');',
  'try {',
  '  await Oliphaunt.open({ storage: directory(' +
    JSON.stringify(new URL('./nested-worker-storage', import.meta.url).href) +
    ') });',
  "  parentPort.postMessage({ status: 'opened' });",
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
if (
  callerResult?.name !== 'TypeError' ||
  callerResult?.message !==
    '@oliphaunt/wasix-ts ' + runtimeName + ' directory storage must be opened from the main thread'
) {
  throw new Error('persistent storage caller-worker guard failed: ' + JSON.stringify(callerResult));
}
try {
  await access(new URL('./nested-worker-storage', import.meta.url));
  throw new Error('caller-worker rejection created persistent storage state');
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}

if (packageOnly) {
  const storage = directory(new URL('./package-condition-storage', import.meta.url));
  if (!Object.isFrozen(storage) || Reflect.ownKeys(storage).length !== 0) {
    throw new Error(runtimeName + ' storage condition returned an invalid adapter');
  }
  console.log(JSON.stringify({
    host: runtime + '-package-condition-and-worker_threads',
    entrypoint: ${JSON.stringify(expectedEntrypoint)},
    storage: runtime + '-directory',
  }));
} else {
async function verifyMemory(execution) {
  // OLIPHAUNT_DOCS_SNIPPET wasix-typescript-quickstart
  const db = await Oliphaunt.open({ execution, extensions: [pgtap] });
  const version = (await db.query('SELECT pgtap_version()::text AS version')).getText(0, 'version');
  const retainedProtocol = await db.execProtocolRaw(
    simpleQuery("SELECT repeat('a', 8192) AS retained_payload"),
  );
  const retainedSnapshot = retainedProtocol.slice();
  await db.execProtocolRaw(simpleQuery("SELECT repeat('z', 8192) AS replacement_payload"));
  const protocolResponseOwned =
    retainedProtocol.length === retainedSnapshot.length &&
    retainedProtocol.every((byte, index) => byte === retainedSnapshot[index]);
  const wallClockMillis = Number((await db.query(
    'SELECT (extract(epoch FROM clock_timestamp()) * 1000)::bigint AS millis',
  )).getText(0, 'millis'));
  const wallClockDeltaMillis = Math.abs(Date.now() - wallClockMillis);
  const explain = JSON.parse((await db.query(
    'EXPLAIN (ANALYZE, FORMAT JSON) SELECT pg_sleep(0.05)',
  )).getText(0, 'QUERY PLAN'));
  const monotonicElapsedMillis = explain[0]?.['Execution Time'];
  await db.execute('CREATE TABLE smoke_transaction (value integer NOT NULL)');
  const transactionValue = await db.transaction(async (tx) => {
    await tx.execute('INSERT INTO smoke_transaction VALUES ($1)', [7]);
    return (await tx.query('SELECT value::text AS value FROM smoke_transaction')).getText(0, 'value');
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
  const transactionRows = (await db.query(
    'SELECT count(*)::int AS count FROM smoke_transaction',
  )).getText(0, 'count');
  let sqlstate;
  try {
    await db.query('SELEC 1');
  } catch (error) {
    if (!(error instanceof PostgresError)) throw error;
    sqlstate = error.sqlstate;
  }
  const answer = (await db.query('SELECT 42::int AS answer')).getText(0, 'answer');
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
    answer !== '42'
  ) {
    throw new Error(execution + ': ' + JSON.stringify(result));
  }
  return result;
}

const direct = await verifyMemory('direct');
const worker = await verifyMemory('worker');
if (direct.version !== worker.version) {
  throw new Error('placement extension versions differ: ' + JSON.stringify({ direct, worker }));
}

const storage = directory(new URL('./database space ü', import.meta.url));
let persistent = await Oliphaunt.open({ execution: 'direct', storage, extensions: [pgtap] });
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
await persistent.checkpoint();
let busy;
try {
  await Oliphaunt.open({ execution: 'worker', storage, extensions: [pgtap] });
} catch (error) {
  if (!(error instanceof WasixStorageError)) throw error;
  busy = error.code;
}
const directArchive = await persistent.backup();
const directSessionState = (await persistent.query(
  "SELECT (SELECT value FROM smoke_direct_session) || ':' || current_setting('application_name') AS value",
)).getText(0, 'value');
await persistent.close();

persistent = await Oliphaunt.open({ execution: 'worker', storage, extensions: [pgtap] });
const workerPersistedRows = (await persistent.query(
  'SELECT count(*)::int AS count FROM smoke_persistence',
)).getText(0, 'count');
const persistentExtension = (await persistent.query(
  'SELECT pgtap_version()::text AS version',
)).getText(0, 'version');
await persistent.execute(
  "INSERT INTO smoke_persistence(label, payload, optional_value) " +
    "VALUES ('naïve', decode('010203', 'hex'), NULL)"
);
await persistent.execute('CREATE TEMP TABLE smoke_worker_session(value text NOT NULL)');
await persistent.execute("INSERT INTO smoke_worker_session VALUES ('worker-session')");
await persistent.execute("SET application_name = 'packed-worker-session'");
await persistent.checkpoint();
const workerArchive = await persistent.backup();
const workerSessionState = (await persistent.query(
  "SELECT (SELECT value FROM smoke_worker_session) || ':' || current_setting('application_name') AS value",
)).getText(0, 'value');
await persistent.close();

const directRestoreStorage = directory(new URL('./direct-backup-restore', import.meta.url));
await Oliphaunt.restore(directRestoreStorage, directArchive);
let restored = await Oliphaunt.open({
  execution: 'worker',
  storage: directRestoreStorage,
  extensions: [pgtap],
});
const directBackupRows = (await restored.query(
  'SELECT count(*)::int AS count FROM smoke_persistence',
)).getText(0, 'count');
const directBackupValues = await richBackupValues(restored);
const directBackupSequence = (await restored.query(
  "SELECT nextval('smoke_persistence_seq')::text AS value",
)).getText(0, 'value');
await restored.close();

const workerRestoreStorage = directory(new URL('./worker-backup-restore', import.meta.url));
await Oliphaunt.restore(workerRestoreStorage, workerArchive);
restored = await Oliphaunt.open({
  execution: 'direct',
  storage: workerRestoreStorage,
  extensions: [pgtap],
});
const workerBackupRows = (await restored.query(
  'SELECT count(*)::int AS count FROM smoke_persistence',
)).getText(0, 'count');
const workerBackupValues = await richBackupValues(restored);
const workerBackupSequence = (await restored.query(
  "SELECT nextval('smoke_persistence_seq')::text AS value",
)).getText(0, 'value');
await restored.close();
let corruptRestore;
try {
  await Oliphaunt.restore(
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
  placements: { direct, worker },
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
  const index = (await db.query(
    "SELECT to_regclass('smoke_persistence_label_idx')::text AS value",
  )).getText(0, 'value');
  if (index !== 'smoke_persistence_label_idx') {
    throw new Error('restored physical backup omitted smoke_persistence_label_idx: ' + index);
  }
  return (await db.query(
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
