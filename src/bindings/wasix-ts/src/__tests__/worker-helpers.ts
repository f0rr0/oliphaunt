import type { SerializedOpenOptions, WorkerRequest, WorkerResponse } from '../rpc.js';
import type { WasixWorkerPort } from '../worker-rpc.js';

export class FakeWorkerPort implements WasixWorkerPort {
  readonly requests: Array<{
    message: WorkerRequest;
    transfer: readonly Transferable[];
  }> = [];
  terminations = 0;
  #messageListener: ((message: WorkerResponse) => void) | undefined;
  #fatalListener: ((error: Error) => void) | undefined;

  postMessage(message: WorkerRequest, transfer: readonly Transferable[]): void {
    this.requests.push({ message, transfer });
  }

  terminate(): void {
    this.terminations += 1;
  }

  onMessage(listener: (message: WorkerResponse) => void): void {
    this.#messageListener = listener;
  }

  onFatal(listener: (error: Error) => void): void {
    this.#fatalListener = listener;
  }

  respond(message: WorkerResponse): void {
    this.#messageListener?.(message);
  }

  fail(error: Error): void {
    this.#fatalListener?.(error);
  }
}

export function workerOpenOptions(): SerializedOpenOptions {
  return {
    runtime: {
      schema: 'oliphaunt-wasix-runtime-v2',
      runtime: 'wasix',
      product: 'liboliphaunt-wasix',
      version: '0.1.1',
      runtimeArchive: {
        archive: 'oliphaunt.wasix.tar.zst',
        sha256: '1'.repeat(64),
        size: 1,
        source: 'file:///runtime.tar.zst',
      },
      standardSeedArchive: {
        archive: 'cluster-seeds/standard.tar.zst',
        sha256: '2'.repeat(64),
        size: 1,
        source: 'file:///standard-seed.tar.zst',
      },
      standardSeedManifest: {
        sha256: '4'.repeat(64),
        size: 1,
        source: 'file:///standard-seed.json',
      },
      manifest: {
        sha256: '3'.repeat(64),
        size: 1,
        source: 'file:///manifest.json',
      },
    },
    extensionCarriers: {},
    extensions: [],
    username: 'postgres',
    database: 'postgres',
    startupGUCs: {},
    storage: { schema: 'oliphaunt-wasix-storage-v1', kind: 'memory' },
  };
}
