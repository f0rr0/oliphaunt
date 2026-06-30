import assert from 'node:assert/strict';
import { test } from 'vitest';

import {
  decodeBrokerRequest,
  decodeBrokerResponse,
  encodeBrokerRequest,
  encodeBrokerResponse,
  readBrokerRequest,
  readBrokerResponse,
  writeBrokerRequest,
  writeBrokerResponse,
} from '../runtime/broker-frames.js';
import { MemoryDuplexStream } from '../runtime/byte-stream.js';

async function main(): Promise<void> {
  await requestFramesRoundTrip();
  await responseFramesRoundTrip();
  rejectsMalformedFrames();
  await streamHelpersUseBinaryFrames();
}

async function requestFramesRoundTrip(): Promise<void> {
  assert.deepEqual(decodeBrokerRequest(6, new TextEncoder().encode('secret')), {
    kind: 'authenticate',
    token: 'secret',
  });
  assert.deepEqual(decodeBrokerRequest(1, new Uint8Array([1, 2])), {
    kind: 'execProtocol',
    bytes: new Uint8Array([1, 2]),
  });
  assert.deepEqual(decodeBrokerRequest(8, new TextEncoder().encode('SELECT 1')), {
    kind: 'execSimpleQuery',
    sql: 'SELECT 1',
  });
  assert.deepEqual(decodeBrokerRequest(2, new Uint8Array()), { kind: 'checkpoint' });
  assert.deepEqual(decodeBrokerRequest(3, new Uint8Array()), { kind: 'close' });
  assert.deepEqual(decodeBrokerRequest(4, new Uint8Array([3, 4])), {
    kind: 'execProtocolStream',
    bytes: new Uint8Array([3, 4]),
  });
  assert.deepEqual(decodeBrokerRequest(5, new Uint8Array([2])), {
    kind: 'backup',
    format: 'physicalArchive',
  });
  assert.deepEqual(decodeBrokerRequest(7, new Uint8Array()), { kind: 'cancel' });
}

async function responseFramesRoundTrip(): Promise<void> {
  const ok = encodeBrokerResponse({ kind: 'ok', bytes: new Uint8Array([9]) });
  assert.deepEqual(await readBrokerResponse(new MemoryDuplexStream([ok])), {
    kind: 'ok',
    bytes: new Uint8Array([9]),
  });

  const error = encodeBrokerResponse({ kind: 'error', message: 'boom' });
  assert.deepEqual(await readBrokerResponse(new MemoryDuplexStream([error])), {
    kind: 'error',
    message: 'boom',
  });

  const chunk = encodeBrokerResponse({ kind: 'chunk', bytes: new Uint8Array([7, 8]) });
  assert.deepEqual(await readBrokerResponse(new MemoryDuplexStream([chunk])), {
    kind: 'chunk',
    bytes: new Uint8Array([7, 8]),
  });
}

function rejectsMalformedFrames(): void {
  assert.throws(() => decodeBrokerRequest(999, new Uint8Array()), /unknown broker request/);
  assert.throws(() => decodeBrokerResponse(999, new Uint8Array()), /unknown broker response/);
  assert.throws(() => decodeBrokerRequest(5, new Uint8Array()), /missing a format/);
  assert.throws(() => decodeBrokerRequest(5, new Uint8Array([99])), /unknown broker backup/);
  assert.throws(() => decodeBrokerRequest(2, new Uint8Array([1])), /unexpectedly had a payload/);
}

async function streamHelpersUseBinaryFrames(): Promise<void> {
  const requestStream = new MemoryDuplexStream();
  await writeBrokerRequest(requestStream, {
    kind: 'execProtocol',
    bytes: new Uint8Array([0x51, 0, 0, 0, 4]),
  });
  assert.deepEqual(await readBrokerRequest(new MemoryDuplexStream(requestStream.output)), {
    kind: 'execProtocol',
    bytes: new Uint8Array([0x51, 0, 0, 0, 4]),
  });

  const responseStream = new MemoryDuplexStream();
  await writeBrokerResponse(responseStream, { kind: 'ok', bytes: new Uint8Array([0x5a]) });
  assert.deepEqual(await readBrokerResponse(new MemoryDuplexStream(responseStream.output)), {
    kind: 'ok',
    bytes: new Uint8Array([0x5a]),
  });

  const raw = encodeBrokerRequest({ kind: 'backup', format: 'physicalArchive' });
  assert.equal(raw[0], 0x50);
  assert.equal(raw[1], 0x47);
  assert.equal(raw[2], 0x4f);
  assert.equal(raw[3], 0x42);
}

test('broker frames', async () => {
  await main();
});
