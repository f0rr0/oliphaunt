import { describe, expect, it } from 'vitest';

import { openWorkerDatabase, WorkerRpc } from '../worker-rpc.js';
import { FakeWorkerPort, workerOpenOptions } from './worker-helpers.js';

describe('WASIX worker RPC', () => {
  it('terminates the worker when opening returns an error', async () => {
    const port = new FakeWorkerPort();
    const opening = openWorkerDatabase(port, workerOpenOptions());
    const request = port.requests[0]?.message;
    expect(request?.method).toBe('open');
    if (request === undefined) {
      throw new Error('open request was not posted');
    }

    port.respond({
      id: request.id,
      ok: false,
      error: { name: 'Error', message: 'runtime initialization failed' },
    });

    await expect(opening).rejects.toThrow('runtime initialization failed');
    expect(port.terminations).toBe(1);
  });

  it('rejects every pending and later request with one fatal worker error', async () => {
    const port = new FakeWorkerPort();
    const rpc = new WorkerRpc(port);
    const first = rpc.request({ method: 'exec', input: Uint8Array.of(1) });
    const second = rpc.request({ method: 'checkpoint' });
    const failure = new Error('worker exited unexpectedly');
    const firstRejection = expect(first).rejects.toBe(failure);
    const secondRejection = expect(second).rejects.toBe(failure);

    port.fail(failure);

    await firstRejection;
    await secondRejection;
    await expect(rpc.request({ method: 'close' })).rejects.toBe(failure);
    await rpc.terminate();
    expect(port.terminations).toBe(1);
  });
});
