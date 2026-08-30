import { EventEmitter } from 'node:events';
import type { Worker } from 'node:worker_threads';

import { describe, expect, it } from 'vitest';

import { nodeWorkerPort } from '../node-worker-port.js';
import type { WorkerRequest, WorkerResponse } from '../rpc.js';

describe('Node-compatible WASIX Worker transport', () => {
  it('turns an unexpected clean exit into a fatal ownership error', () => {
    const worker = new FakeNodeWorker();
    const port = nodeWorkerPort(worker as unknown as Worker);
    const failures: Error[] = [];
    port.onFatal((error) => failures.push(error));

    worker.exit(0);

    expect(failures).toEqual([
      expect.objectContaining({
        message: 'Oliphaunt WASIX Node Worker exited unexpectedly with code 0',
      }),
    ]);
  });

  it('waits for a quiescent Worker to self-exit without calling terminate', async () => {
    const worker = new FakeNodeWorker();
    const port = nodeWorkerPort(worker as unknown as Worker);
    const failures: Error[] = [];
    port.onFatal((error) => failures.push(error));

    const exited = port.expectSelfExit?.();
    worker.respond({ id: 1, ok: true });
    worker.exit(0);

    await expect(exited).resolves.toBeUndefined();
    expect(worker.terminations).toBe(0);
    expect(failures).toEqual([]);
  });

  it('treats terminate after an observed self-exit as an idempotent no-op', async () => {
    const worker = new FakeNodeWorker();
    const port = nodeWorkerPort(worker as unknown as Worker, 'Bun');

    const exited = port.expectSelfExit?.();
    worker.respond({ id: 1, ok: true });
    worker.exit(0);
    await exited;
    await port.terminate();

    expect(worker.terminations).toBe(0);
  });

  it('rejects a nonzero self-exit without reclassifying it as an unrelated crash', async () => {
    const worker = new FakeNodeWorker();
    const port = nodeWorkerPort(worker as unknown as Worker, 'Bun');
    const failures: Error[] = [];
    port.onFatal((error) => failures.push(error));

    const exited = port.expectSelfExit?.();
    worker.respond({ id: 1, ok: true });
    worker.exit(7);

    await expect(exited).rejects.toThrow('Oliphaunt WASIX Bun Worker self-exited with code 7');
    expect(failures).toEqual([]);
  });

  it('fails pending shutdown work if the Worker exits before its reply', async () => {
    const worker = new FakeNodeWorker();
    const port = nodeWorkerPort(worker as unknown as Worker);
    const failures: Error[] = [];
    port.onFatal((error) => failures.push(error));

    const exited = port.expectSelfExit?.();
    worker.exit(0);

    await expect(exited).rejects.toThrow('self-exited before its shutdown reply');
    expect(failures).toEqual([
      expect.objectContaining({ message: expect.stringContaining('before its shutdown reply') }),
    ]);
  });

  it('adapts messages and reserves terminate for idle/failure cleanup', async () => {
    const worker = new FakeNodeWorker();
    const port = nodeWorkerPort(worker as unknown as Worker);
    const responses: WorkerResponse[] = [];
    port.onMessage((message) => responses.push(message));
    const request = { id: 1, method: 'close' } as const;

    port.postMessage(request, []);
    worker.respond({ id: 1, ok: true });
    await port.terminate();

    expect(worker.requests).toEqual([request]);
    expect(responses).toEqual([{ id: 1, ok: true }]);
    expect(worker.terminations).toBe(1);
  });

  it('delivers an early startup error when the fatal listener is installed', () => {
    const worker = new FakeNodeWorker();
    const port = nodeWorkerPort(worker as unknown as Worker);
    const failure = new Error('Worker startup failed');
    worker.emit('error', failure);
    const failures: Error[] = [];

    port.onFatal((error) => failures.push(error));

    expect(failures).toEqual([failure]);
  });
});

class FakeNodeWorker extends EventEmitter {
  readonly requests: WorkerRequest[] = [];
  terminations = 0;

  postMessage(message: WorkerRequest): void {
    this.requests.push(message);
  }

  async terminate(): Promise<number> {
    this.terminations += 1;
    return 0;
  }

  respond(response: WorkerResponse): void {
    this.emit('message', response);
  }

  exit(code: number): void {
    this.emit('exit', code);
  }
}
