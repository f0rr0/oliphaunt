import { serializeOpenConfig } from './client-common.js';
import type { PersistentWasixStorage } from './storage.js';
import type { BinaryInput, OliphauntClient, OliphauntDatabase, OpenConfig } from './types.js';
import { openWasixWithWorker, restoreWasixWithWorker, type WasixWorkerPort } from './worker-rpc.js';

/** Open PostgreSQL in a package-owned browser Worker. */
export async function openWasix(config: OpenConfig = {}): Promise<OliphauntDatabase> {
  const openOptions = serializeOpenConfig(config);
  assertBrowserWorkerEnvironment();
  return openWasixWithWorker(createBrowserWorker, openOptions);
}

async function restoreBrowserWasix(
  storage: PersistentWasixStorage,
  bytes: BinaryInput,
): Promise<void> {
  assertBrowserWorkerEnvironment();
  return restoreWasixWithWorker(createBrowserWorker, storage, bytes);
}

function assertBrowserWorkerEnvironment(): void {
  if (globalThis.crossOriginIsolated !== true) {
    throw new Error(
      '@oliphaunt/wasix-ts/worker requires COOP: same-origin and COEP: require-corp response headers',
    );
  }
  if (typeof Worker === 'undefined') {
    throw new Error('@oliphaunt/wasix-ts/worker requires a browser with Web Workers');
  }
}

export const Oliphaunt: OliphauntClient = {
  open: openWasix,
  restore: restoreBrowserWasix,
};

function createBrowserWorker(): WasixWorkerPort {
  const worker = new Worker(new URL('./worker.js', import.meta.url), {
    type: 'module',
    name: 'oliphaunt-wasix',
  });
  return {
    postMessage: (message, transfer) => worker.postMessage(message, [...transfer]),
    terminate: () => worker.terminate(),
    onMessage: (listener) => {
      worker.addEventListener('message', (event: MessageEvent) => listener(event.data));
    },
    onFatal: (listener) => {
      worker.addEventListener('error', (event) => {
        listener(new Error(event.message || 'Oliphaunt WASIX browser worker crashed'));
      });
      worker.addEventListener('messageerror', () => {
        listener(new Error('Oliphaunt WASIX browser worker returned an unreadable message'));
      });
    },
  };
}
