import { EventEmitter } from 'node:events';
import { Worker } from 'node:worker_threads';

import { describe, expect, it } from 'vitest';

import { openWasixWithWorker } from '../client-common.js';
import { resolvedRuntimeClosure } from '../database.js';
import { sharedToolRuntime } from '../internal-common.js';
import { nodeWorkerPort } from '../node-worker-port.js';
import type { WorkerRequest, WorkerResponse } from '../rpc.js';
import { openWorkerDatabase } from '../worker-rpc.js';
import { workerOpenOptions } from './worker-helpers.js';

describe('Node WASIX worker transport', () => {
  it('retains byte-backed runtime assets after a real worker transfer', async () => {
    const worker = new Worker(
      `
        const { parentPort } = require('node:worker_threads');
        parentPort.on('message', ({ id, method }) => {
          if (method === 'open' || method === 'close') parentPort.postMessage({ id, ok: true });
        });
      `,
      { eval: true },
    );
    const options = workerOpenOptions();
    const runtimeArchive = Uint8Array.of(1);
    const clusterSeedArchive = Uint8Array.of(3);
    const clusterSeedManifest = Uint8Array.of(5);
    const runtimeManifest = Uint8Array.of(7);
    options.runtime.runtimeArchive.source = runtimeArchive;
    options.runtime.standardSeedArchive.source = clusterSeedArchive;
    options.runtime.standardSeedManifest.source = clusterSeedManifest;
    options.runtime.manifest.source = runtimeManifest;

    const database = await openWasixWithWorker(() => nodeWorkerPort(worker), options);
    try {
      const closure = resolvedRuntimeClosure(database);
      expect(runtimeArchive.byteLength).toBe(0);
      expect(clusterSeedArchive.byteLength).toBe(0);
      expect(clusterSeedManifest.byteLength).toBe(0);
      expect(runtimeManifest.byteLength).toBe(0);
      expect(closure.runtime.runtimeArchive.source).toEqual(Uint8Array.of(1));
      expect(closure.runtime.manifest.source).toEqual(Uint8Array.of(7));
      expect(Object.keys(closure.runtime).sort()).toEqual([
        'manifest',
        'product',
        'runtimeArchive',
        'version',
      ]);
      expect(() => structuredClone(closure)).not.toThrow();

      const shared = await sharedToolRuntime(database);
      const reused = await sharedToolRuntime(database);
      expect(reused).toBe(shared);
      expect(shared.runtimeArchive.source).toBeInstanceOf(Uint8Array);
      expect(shared.manifest.source).toBeInstanceOf(Uint8Array);
      expect((shared.runtimeArchive.source as Uint8Array).buffer).toBeInstanceOf(SharedArrayBuffer);
      expect((shared.manifest.source as Uint8Array).buffer).toBeInstanceOf(SharedArrayBuffer);
      expect(resolvedRuntimeClosure(database).runtime).toBe(shared);

      const cloned = structuredClone(shared);
      (shared.runtimeArchive.source as Uint8Array)[0] = 11;
      expect((cloned.runtimeArchive.source as Uint8Array)[0]).toBe(11);
    } finally {
      await database.close();
    }
  });

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

    await queryRejection;
    await expect(database.close()).rejects.toThrow('Node worker exited unexpectedly with code 0');
    await expect(database.query('select 1')).rejects.toThrow('database is closed');
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
