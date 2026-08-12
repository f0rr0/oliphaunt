import { Worker } from 'node:worker_threads';

import { openWasixWithWorker, type WasixWorkerPort } from './client-common.js';
import type { WorkerOpenOptions } from './rpc.js';
import type { OliphauntWasixClient, WasixDatabase, WasixOpenOptions } from './types.js';

export async function openWasix(options: WasixOpenOptions = {}): Promise<WasixDatabase> {
  return openWasixWithWorker(createNodeWorker, options, requireNodeStorage);
}

export const Oliphaunt: OliphauntWasixClient = {
  open: openWasix,
};

function requireNodeStorage(options: WorkerOpenOptions): void {
  if (options.storage.kind !== 'memory') {
    throw new TypeError(
      '@oliphaunt/wasix IndexedDB storage is browser-only; omit storage to use Node memory storage',
    );
  }
}

function createNodeWorker(): WasixWorkerPort {
  const worker = new Worker(new URL('./node-worker.js', import.meta.url), {
    name: 'oliphaunt-wasix',
  });
  return {
    postMessage: (message, transfer) => {
      worker.postMessage(message, transfer as readonly ArrayBuffer[]);
    },
    terminate: () => {
      void worker.terminate();
    },
    onMessage: (listener) => {
      worker.on('message', listener);
    },
    onFatal: (listener) => {
      worker.on('error', listener);
      worker.on('messageerror', (error) => {
        listener(
          error instanceof Error
            ? error
            : new Error('Oliphaunt WASIX Node worker returned an unreadable message'),
        );
      });
      worker.on('exit', (code) => {
        if (code !== 0) {
          listener(new Error(`Oliphaunt WASIX Node worker exited with code ${code}`));
        }
      });
    },
  };
}
