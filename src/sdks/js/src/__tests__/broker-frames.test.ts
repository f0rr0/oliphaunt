import assert from 'node:assert/strict';
import { test } from 'vitest';

import {
  decodeBrokerResponse,
  encodeBrokerRequest,
  readBrokerResponse,
  writeBrokerRequest,
} from '../runtime/broker-frames.js';
import { encodeBrokerResponse } from './broker-response.js';
import { MemoryDuplexStream } from './memory-duplex-stream.js';
import { resolveBrokerStreamCompletion } from '../runtime/broker.js';

async function main(): Promise<void> {
  await requestFramesRoundTrip();
  await responseFramesRoundTrip();
  rejectsMalformedFrames();
  streamCompletionUsesRecoveryAwareErrorPrecedence();
}

async function requestFramesRoundTrip(): Promise<void> {
  const requests = [
    [{ kind: 'authenticate', token: 'secret' }, 6, [...new TextEncoder().encode('secret')]],
    [{ kind: 'execProtocol', bytes: Uint8Array.of(1, 2) }, 1, [1, 2]],
    [{ kind: 'execProtocolStream', bytes: Uint8Array.of(3, 4) }, 4, [3, 4]],
    [{ kind: 'execSimpleQuery', sql: 'SELECT 1' }, 8, [...new TextEncoder().encode('SELECT 1')]],
    [{ kind: 'close' }, 3, []],
    [{ kind: 'backup' }, 5, []],
    [{ kind: 'cancel' }, 7, []],
  ] as const;
  for (const [request, kind, payload] of requests) {
    const expected = Uint8Array.from([
      0x50,
      0x47,
      0x4f,
      0x42,
      kind,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      payload.length,
      ...payload,
    ]);
    assert.deepEqual(encodeBrokerRequest(request), expected);
    const stream = new MemoryDuplexStream();
    await writeBrokerRequest(stream, request);
    assert.deepEqual(stream.output, [expected]);
  }
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
  assert.throws(() => decodeBrokerResponse(999, new Uint8Array()), /unknown broker response/);
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

test('broker frames', async () => {
  await main();
});
