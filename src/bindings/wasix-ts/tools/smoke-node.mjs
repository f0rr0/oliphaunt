import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { createPackedWasixNodeConsumer, runFixtureCommand } from './packed-node-fixture.mjs';

const scratch = await mkdtemp(resolve(tmpdir(), 'oliphaunt-wasix-node-smoke-'));

try {
  const fixture = await createPackedWasixNodeConsumer({
    scratch,
    consumerName: 'oliphaunt-wasix-node-smoke-consumer',
    includePgtap: true,
  });
  const candidate = fixture.packages.binding.name;
  const extension = fixture.packages.extension.name;
  await writeFile(
    resolve(fixture.consumer, 'verify.mjs'),
    `import { access } from 'node:fs/promises';
import { Worker } from 'node:worker_threads';

const candidate = ${JSON.stringify(candidate)};
const extension = ${JSON.stringify(extension)};
const pgtap = (await import(extension)).default;
const { default: Oliphaunt, PostgresError, WasixStorageError } = await import(candidate);
const { directory } = await import(candidate + '/storage/node');

const resolved = import.meta.resolve(candidate);
if (!resolved.endsWith('/lib/index.node.js')) {
  throw new Error('Node did not select the worker_threads entrypoint: ' + resolved);
}
const callerSource = [
  "import { parentPort } from 'node:worker_threads';",
  'const { default: Oliphaunt } = await import(' + JSON.stringify(resolved) + ');',
  'const { directory } = await import(' +
    JSON.stringify(import.meta.resolve(candidate + '/storage/node')) +
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
    '@oliphaunt/wasix-ts Node directory storage must be opened from the main thread'
) {
  throw new Error('persistent storage caller-worker guard failed: ' + JSON.stringify(callerResult));
}
try {
  await access(new URL('./nested-worker-storage/.oliphaunt-wasix-ts', import.meta.url));
  throw new Error('caller-worker rejection created persistent storage state');
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}

async function verifyMemory(execution) {
  const db = await Oliphaunt.open({ execution, extensions: [pgtap] });
  const version = (await db.query('SELECT pgtap_version()::text AS version')).getText(0, 'version');
  await db.query('CREATE TABLE smoke_transaction (value integer NOT NULL)');
  const transactionValue = await db.transaction(async (tx) => {
    await tx.query('INSERT INTO smoke_transaction VALUES ($1)', [7]);
    return (await tx.query('SELECT value::text AS value FROM smoke_transaction')).getText(0, 'value');
  });
  const rollbackSentinel = new Error('packed transaction rollback sentinel');
  try {
    await db.transaction(async (tx) => {
      await tx.query('INSERT INTO smoke_transaction VALUES ($1)', [9]);
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
  const result = { version, transactionValue, transactionRows, sqlstate, answer };
  if (
    !version ||
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
await persistent.query('CREATE TABLE smoke_persistence (value integer NOT NULL)');
await persistent.query('INSERT INTO smoke_persistence VALUES (1)');
await persistent.checkpoint();
await persistent.query('INSERT INTO smoke_persistence VALUES (2)');
let busy;
try {
  await Oliphaunt.open({ execution: 'worker', storage, extensions: [pgtap] });
} catch (error) {
  if (!(error instanceof WasixStorageError)) throw error;
  busy = error.code;
}
await persistent.close();

persistent = await Oliphaunt.open({ execution: 'worker', storage, extensions: [pgtap] });
const workerPersistedRows = (await persistent.query(
  'SELECT count(*)::int AS count FROM smoke_persistence',
)).getText(0, 'count');
const persistentExtension = (await persistent.query(
  'SELECT pgtap_version()::text AS version',
)).getText(0, 'version');
await persistent.query('INSERT INTO smoke_persistence VALUES (3)');
await persistent.close();

persistent = await Oliphaunt.open({ execution: 'direct', storage, extensions: [pgtap] });
const directPersistedRows = (await persistent.query(
  'SELECT count(*)::int AS count FROM smoke_persistence',
)).getText(0, 'count');
await persistent.close();
if (
  busy !== 'busy' ||
  workerPersistedRows !== '2' ||
  directPersistedRows !== '3' ||
  persistentExtension !== direct.version
) {
  throw new Error(JSON.stringify({
    busy,
    workerPersistedRows,
    directPersistedRows,
    persistentExtension,
    version: direct.version,
  }));
}
console.log(JSON.stringify({
  host: 'node-direct-and-worker_threads',
  placements: { direct, worker },
  extension: 'pgtap',
  version: direct.version,
  storage: 'node-directory-snapshot',
  busy,
  workerPersistedRows,
  directPersistedRows,
}));
`,
  );
  const { stdout } = await runFixtureCommand(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `await import(${JSON.stringify(pathToFileURL(resolve(fixture.consumer, 'verify.mjs')).href)})`,
    ],
    fixture.consumer,
    300_000,
  );
  console.log(`wasix-ts Node smoke: PASS ${stdout.trim()}`);
} finally {
  await rm(scratch, { force: true, recursive: true });
}
