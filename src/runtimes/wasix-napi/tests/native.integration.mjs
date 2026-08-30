import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';

const addonPath = process.argv[2];
if (addonPath === undefined) {
  throw new Error('usage: node native.integration.mjs /absolute/path/to/addon.node [--tools]');
}

const addon = createRequire(import.meta.url)(addonPath);
const expectedExports = [
  'NativeWasixActorDatabase',
  'NativeWasixDatabase',
  'NativeWasixServer',
  'addonAbiVersion',
  'extensionIdentity',
  'nodeApiVersion',
  'payloadIdentity',
  'restore',
  'restoreDirect',
  'runtimeVersion',
  'supportedProfiles',
  'toolIdentity',
];
assert.deepEqual(Object.keys(addon).sort(), expectedExports);
assert.equal(addon.addonAbiVersion(), 1);
assert.equal(addon.nodeApiVersion(), 8);
assert.deepEqual(addon.supportedProfiles(), ['standard', 'icu']);

const openOptions = (profile = 'standard', storage = { kind: 'memory' }) => ({
  profile,
  storage,
  username: 'postgres',
  database: 'postgres',
  startupGucs: {},
  extensions: [],
});

const queryMessage = (sql) => {
  const text = Buffer.from(`${sql}\0`);
  const request = Buffer.alloc(5 + text.length);
  request[0] = 0x51;
  request.writeUInt32BE(4 + text.length, 1);
  text.copy(request, 5);
  return request;
};

const assertResponse = (response, value) => {
  assert(response instanceof Uint8Array);
  assert(Buffer.from(response).includes(Buffer.from(String(value))));
};

const assertTransferable = (bytes) => {
  assert(bytes instanceof Uint8Array);
  const expected = Uint8Array.from(bytes);
  const moved = structuredClone(bytes, { transfer: [bytes.buffer] });
  assert.equal(bytes.byteLength, 0, 'V8 must detach the source ArrayBuffer');
  assert.deepEqual(moved, expected, 'transfer must preserve every output byte');
  return moved;
};

const direct = addon.NativeWasixDatabase.open(openOptions());
const directResponse = direct.execProtocolRaw(queryMessage('select 4101'));
assertResponse(directResponse, 4101);
assertTransferable(directResponse);
const directChunks = [];
assert.equal(
  direct.execProtocolRawStream(queryMessage('select 4102'), (chunk) => {
    assertResponse(chunk, 4102);
    directChunks.push(assertTransferable(chunk));
  }),
  'complete',
);
assert(Buffer.concat(directChunks.map(Buffer.from)).includes(Buffer.from('4102')));
let directReentryError;
assert.equal(
  direct.execProtocolRawStream(queryMessage('select 4103'), () => {
    try {
      direct.close();
    } catch (error) {
      directReentryError = error;
    }
  }),
  'complete',
);
assert(
  directReentryError instanceof Error,
  'napi-rs must reject a synchronous mutable reentry while the stream callback is active',
);
assert.match(directReentryError.message, /borrow(?:ed|ing)|mutabl/iu);
assertResponse(direct.execProtocolRaw(queryMessage('select 4104')), 4104);
const directBackup = direct.backup();
const restoreBackup = Uint8Array.from(directBackup);
assert(directBackup.byteLength > 0);
assertTransferable(directBackup);
direct.close();
assert.equal(direct.closed, true);

const actor = await addon.NativeWasixActorDatabase.open(openOptions());
const actorResponse = await actor.execProtocolRaw(queryMessage('select 4201'));
assertResponse(actorResponse, 4201);
assertTransferable(actorResponse);
const actorChunks = [];
assert.equal(
  await actor.execProtocolRawStream(queryMessage('select 4202'), (chunk) => {
    actorChunks.push(assertTransferable(chunk));
  }),
  'complete',
);
assert(Buffer.concat(actorChunks.map(Buffer.from)).includes(Buffer.from('4202')));
assert.equal(
  await actor.execProtocolRawStream(queryMessage('select 4203'), () => {
    throw new Error('intentional stream stop');
  }),
  'callbackAborted',
);
assertResponse(await actor.execProtocolRaw(queryMessage('select 4204')), 4204);

if (process.argv.includes('--tools')) {
  const dump = await actor.pgDump([]);
  assert.equal(dump.status, 0);
  assert(dump.stdout.byteLength > 0);
  assertTransferable(dump.stdout);
  assertTransferable(dump.stderr);
}

await Promise.all([actor.close(), actor.close()]);
assert.equal(actor.closed, true);
await assert.rejects(actor.execProtocolRaw(queryMessage('select 1')), (error) => {
  assert.equal(error.oliphauntWasixError, 'lifecycle');
  assert.equal(error.oliphauntWasixAddonAbi, 1);
  return true;
});

const server = await addon.NativeWasixServer.open({
  ...openOptions(),
  listen: { transport: 'tcp' },
});
assert.match(server.connectionString, /^postgresql:\/\//u);
await Promise.all([server.close(), server.close()]);
assert.equal(server.closed, true);

assert.match(addon.payloadIdentity('icuDataArchive'), /^[0-9a-f]{64}:\d+$/u);
const icu = await addon.NativeWasixActorDatabase.open(openOptions('icu'));
assertResponse(await icu.execProtocolRaw(queryMessage('select 4301')), 4301);
await icu.close();

const temporaryRoot = mkdtempSync(join(tmpdir(), 'oliphaunt-wasix-napi-'));
try {
  const restored = join(temporaryRoot, 'restored-actor');
  await addon.restore(restored, restoreBackup);
  const restoredActor = await addon.NativeWasixActorDatabase.open(
    openOptions('standard', { kind: 'directory', path: restored }),
  );
  assertResponse(await restoredActor.execProtocolRaw(queryMessage('select 4401')), 4401);
  await assert.rejects(
    addon.NativeWasixActorDatabase.open(
      openOptions('standard', { kind: 'directory', path: restored }),
    ),
    (error) => {
      assert.equal(error.name, 'OliphauntWasixStorageError');
      assert.equal(error.oliphauntWasixError, 'storage');
      assert.equal(error.oliphauntWasixAddonAbi, 1);
      assert.equal(error.code, 'busy');
      assert.equal(error.commitState, 'unchanged');
      assert.equal(error.phase, 'ownership');
      return true;
    },
  );
  await restoredActor.close();

  const restoredDirectPath = join(temporaryRoot, 'restored-direct');
  addon.restoreDirect(restoredDirectPath, restoreBackup);
  const restoredDirect = addon.NativeWasixDatabase.open(
    openOptions('standard', { kind: 'directory', path: restoredDirectPath }),
  );
  assertResponse(restoredDirect.execProtocolRaw(queryMessage('select 4402')), 4402);
  restoredDirect.close();
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}

const worker = new Worker(
  `
    const { parentPort, workerData } = require('node:worker_threads');
    const addon = require(workerData.addonPath);
    const options = ${JSON.stringify(openOptions())};
    addon.NativeWasixActorDatabase.open(options).then((database) => {
      globalThis.database = database;
      const text = Buffer.from('select 4501\\0');
      const request = Buffer.alloc(5 + text.length);
      request[0] = 0x51;
      request.writeUInt32BE(4 + text.length, 1);
      text.copy(request, 5);
      void database.execProtocolRawStream(request, () => {
        parentPort.postMessage('stream-entered');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);
      }).catch(() => undefined);
    }, (error) => { throw error; });
  `,
  { eval: true, workerData: { addonPath } },
);
await new Promise((resolve, reject) => {
  worker.once('message', resolve);
  worker.once('error', reject);
});
await Promise.race([
  worker.terminate(),
  new Promise((_, reject) => {
    setTimeout(
      () => reject(new Error('worker teardown blocked on actor stream')),
      10_000,
    ).unref();
  }),
]);

console.log('WASIX N-API native integration passed');
