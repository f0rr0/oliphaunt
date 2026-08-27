import { EventEmitter } from 'node:events';
import type { Worker } from 'node:worker_threads';

import { describe, expect, it } from 'vitest';

import { nodeWorkerPort } from '../node-worker-port.js';
import type { WorkerRequest, WorkerResponse } from '../rpc.js';
import { openWorkerDatabase } from '../worker-rpc.js';
import { workerOpenOptions } from './worker-helpers.js';

describe('Node WASIX worker transport', () => {
  it('turns a clean unexpected exit into a fatal error for pending database work', async () => {
    const worker = new FakeNodeWorker();
    let recoveries = 0;
    const opening = openWorkerDatabase(
      nodeWorkerPort(worker as unknown as Worker, () => {
        recoveries += 1;
      }),
      workerOpenOptions(),
    );
    const openRequest = worker.requests[0]?.message;
    if (openRequest === undefined) {
      throw new Error('open request was not posted');
    }
    worker.respond({ id: openRequest.id, ok: true });
    const database = await opening;

    const query = database.execProtocolRaw(Uint8Array.of(1));
    await Promise.resolve();
    expect(worker.requests.map(({ message }) => message.method)).toEqual(['open', 'exec']);
    const queryRejection = expect(query).rejects.toThrow(
      'Node worker exited unexpectedly with code 0',
    );

    worker.emit('exit', 0);

    expect(database.closed).toBe(true);
    await queryRejection;
    await expect(database.close()).rejects.toThrow('Node worker exited unexpectedly with code 0');
    await expect(database.query('select 1')).rejects.toThrow('Oliphaunt WASIX database is closed');
    expect(worker.terminations).toBe(1);
    expect(recoveries).toBe(1);
  });

  it('silently performs token-safe cleanup after an intentional termination', async () => {
    const worker = new FakeNodeWorker();
    let recoveries = 0;
    const port = nodeWorkerPort(worker as unknown as Worker, () => {
      recoveries += 1;
    });
    const failures: Error[] = [];
    port.onFatal((error) => failures.push(error));

    await port.terminate();
    worker.emit('exit', 1);

    expect(worker.terminations).toBe(1);
    expect(failures).toEqual([]);
    expect(recoveries).toBe(1);
  });
});

class FakeNodeWorker extends EventEmitter {
  readonly requests: Array<{
    message: WorkerRequest;
    transfer: readonly ArrayBuffer[];
  }> = [];
  terminations = 0;

  postMessage(message: WorkerRequest, transfer: readonly ArrayBuffer[] = []): void {
    this.requests.push({ message, transfer });
  }

  terminate(): Promise<number> {
    this.terminations += 1;
    return Promise.resolve(1);
  }

  respond(response: WorkerResponse): void {
    this.emit('message', response);
  }
}
