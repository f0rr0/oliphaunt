import assert from 'node:assert/strict';
import { test } from 'bun:test';
import {
  decodeBrokerRequest,
  decodeBrokerResponse,
  encodeBrokerRequest,
  encodeBrokerResponse,
  readBrokerRequest,
  readBrokerResponse,
} from '../runtime/broker-frames.js';
import { MemoryDuplexStream } from '../runtime/byte-stream.js';

test('broker management carries authentication, backup and close; SQL uses PostgreSQL', async () => {
  for (const request of [
    { kind: 'authenticate', token: 'secret' },
    { kind: 'backup' },
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
