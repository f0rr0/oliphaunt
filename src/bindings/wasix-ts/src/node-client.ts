import { Worker } from 'node:worker_threads';

import {
  openWasixWithWorker,
  serializeOpenConfig,
  type WasixWorkerPort,
} from './client-common.js';
import { resolveExecutionMode } from './open-options.js';
import type { SerializedOpenOptions } from './rpc.js';
import type { OliphauntClient, OliphauntDatabase, OpenConfig } from './types.js';

export async function openWasix(config: OpenConfig = {}): Promise<OliphauntDatabase> {
  if (resolveExecutionMode(config) === 'direct') {
    throw new TypeError(
      '@oliphaunt/wasix direct execution is browser-only; use execution: "worker" in Node.js',
    );
  }
  const openOptions = serializeOpenConfig(config);
  requireNodeStorage(openOptions);
  return openWasixWithWorker(createNodeWorker, openOptions);
}

export const Oliphaunt: OliphauntClient = {
  open: openWasix,
};

function requireNodeStorage(options: SerializedOpenOptions): void {
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
