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
import { resolveBrokerStreamCompletion } from '../runtime/broker.js';

async function main(): Promise<void> {
  await requestFramesRoundTrip();
  await responseFramesRoundTrip();
  rejectsMalformedFrames();
  streamCompletionUsesRecoveryAwareErrorPrecedence();
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
  assert.deepEqual(decodeBrokerRequest(4, new Uint8Array([3, 4])), {
    kind: 'execProtocolStream',
    bytes: new Uint8Array([3, 4]),
  });
  assert.deepEqual(decodeBrokerRequest(8, new TextEncoder().encode('SELECT 1')), {
    kind: 'execSimpleQuery',
    sql: 'SELECT 1',
  });
  assert.deepEqual(decodeBrokerRequest(3, new Uint8Array()), { kind: 'close' });
  assert.deepEqual(decodeBrokerRequest(5, new Uint8Array()), {
    kind: 'backup',
  });
  assert.deepEqual(decodeBrokerRequest(7, new Uint8Array()), {
    kind: 'cancel',
  });
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

  const callbackAborted = encodeBrokerResponse({
    kind: 'streamCallbackAborted',
    message: 'callback rejected; stream recovered to ReadyForQuery',
  });
  assert.deepEqual(await readBrokerResponse(new MemoryDuplexStream([callbackAborted])), {
    kind: 'streamCallbackAborted',
    message: 'callback rejected; stream recovered to ReadyForQuery',
  });
}

function rejectsMalformedFrames(): void {
  assert.throws(() => decodeBrokerRequest(999, new Uint8Array()), /unknown broker request/);
  assert.throws(() => decodeBrokerResponse(999, new Uint8Array()), /unknown broker response/);
  assert.throws(() => decodeBrokerRequest(5, new Uint8Array([99])), /unexpectedly had a payload/);
  assert.throws(
    () => decodeBrokerResponse(104, new Uint8Array([0xff])),
    /stream callback-aborted frame is not UTF-8/,
  );
}

function streamCompletionUsesRecoveryAwareErrorPrecedence(): void {
  const callbackError = new Error('client callback failed');
  assert.throws(
    () =>
      resolveBrokerStreamCompletion(
        { kind: 'streamCallbackAborted', message: 'stream recovered' },
        true,
        callbackError,
      ),
    (error) => error === callbackError,
  );
  assert.throws(
    () =>
      resolveBrokerStreamCompletion(
        { kind: 'error', message: 'transport recovery failed' },
        true,
        callbackError,
      ),
    (error) => error instanceof Error && error.message === 'transport recovery failed',
  );
  assert.throws(
    () =>
      resolveBrokerStreamCompletion(
        { kind: 'streamCallbackAborted', message: 'stream recovered' },
        false,
        undefined,
      ),
    /without a stored client callback error: stream recovered/,
  );
  assert.throws(
    () =>
      resolveBrokerStreamCompletion({ kind: 'ok', bytes: new Uint8Array() }, true, callbackError),
    (error) => error === callbackError,
  );
  assert.doesNotThrow(() =>
    resolveBrokerStreamCompletion({ kind: 'ok', bytes: new Uint8Array() }, false, undefined),
  );
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

  const streamingRequest = new MemoryDuplexStream();
  await writeBrokerRequest(streamingRequest, {
    kind: 'execProtocolStream',
    bytes: new Uint8Array([0x51]),
  });
  assert.deepEqual(await readBrokerRequest(new MemoryDuplexStream(streamingRequest.output)), {
    kind: 'execProtocolStream',
    bytes: new Uint8Array([0x51]),
  });

  const responseStream = new MemoryDuplexStream();
  await writeBrokerResponse(responseStream, {
    kind: 'ok',
    bytes: new Uint8Array([0x5a]),
  });
  assert.deepEqual(await readBrokerResponse(new MemoryDuplexStream(responseStream.output)), {
    kind: 'ok',
    bytes: new Uint8Array([0x5a]),
  });

  const raw = encodeBrokerRequest({ kind: 'backup' });
  assert.equal(raw[0], 0x50);
  assert.equal(raw[1], 0x47);
  assert.equal(raw[2], 0x4f);
  assert.equal(raw[3], 0x42);
}

test('broker frames', async () => {
  await main();
});
