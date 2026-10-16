import assert from 'node:assert/strict';
import { test } from 'bun:test';
import {
  decodeBrokerRequest,
  decodeBrokerResponse,
  encodeBrokerRequest,
  encodeBrokerResponse,
  readBrokerRequest,
  readBrokerResponse,
  readBrokerBackup,
} from '../runtime/broker-frames.js';
import { MemoryDuplexStream } from '../runtime/byte-stream.js';

test('broker management carries authentication, backup and close; SQL uses PostgreSQL', async () => {
  for (const request of [
    { kind: 'authenticate', token: 'secret' },
    { kind: 'backup' },
    { kind: 'backup-stream' },
    { kind: 'close' },
  ] as const) {
    assert.deepEqual(
      await readBrokerRequest(new MemoryDuplexStream([encodeBrokerRequest(request)])),
      request,
    );
  }
  for (const response of [
    { kind: 'ok', bytes: new Uint8Array([1, 2, 3]) },
    { kind: 'error', message: 'backup failed' },
  ] as const) {
    assert.deepEqual(
      await readBrokerResponse(new MemoryDuplexStream([encodeBrokerResponse(response)])),
      response,
    );
  }
  assert.throws(() => decodeBrokerRequest(1, new Uint8Array()), /unknown broker request/);
  assert.throws(() => decodeBrokerResponse(104, new Uint8Array()), /unknown broker response/);
  assert.throws(() => decodeBrokerRequest(5, new Uint8Array([1])), /unexpectedly had a payload/);
  assert.throws(() => decodeBrokerResponse(102, new Uint8Array([0xff])), /not UTF-8/);
  const header = encodeBrokerRequest({ kind: 'backup' });
  new DataView(header.buffer).setBigUint64(5, 128n * 1024n * 1024n + 1n);
  await assert.rejects(readBrokerRequest(new MemoryDuplexStream([header])), /exceeds limit/);
  header[0] = 0;
  await assert.rejects(readBrokerRequest(new MemoryDuplexStream([header])), /magic mismatch/);
});

test('backup streams await the destination and drain its failure through completion', async () => {
  const frame = (bytes: Uint8Array) => {
    const encoded = encodeBrokerResponse({ kind: 'ok', bytes });
    encoded[4] = 103;
    return encoded;
  };
  const chunks = [Uint8Array.of(1, 2), Uint8Array.of(3)];
  const stream = new MemoryDuplexStream([
    ...chunks.map(frame),
    encodeBrokerResponse({ kind: 'ok', bytes: new Uint8Array() }),
    encodeBrokerResponse({ kind: 'ok', bytes: Uint8Array.of(4) }),
  ]);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const failure = new Error('destination failed');
  let calls = 0;
  const transfer = readBrokerBackup(stream, async (chunk) => {
    calls++;
    assert.deepEqual(chunk, chunks[0]);
    await gate;
    throw failure;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  release();
  assert.deepEqual(await transfer, {
    response: { kind: 'ok', bytes: new Uint8Array() },
    destinationFailure: { error: failure },
  });
  assert.equal(calls, 1);
  assert.deepEqual(await readBrokerResponse(stream), { kind: 'ok', bytes: Uint8Array.of(4) });
  const oversized = frame(new Uint8Array());
  new DataView(oversized.buffer).setBigUint64(5, 65537n);
  await assert.rejects(
    readBrokerBackup(new MemoryDuplexStream([oversized]), () => {}),
    /exceeds limit 65536/,
  );
});
