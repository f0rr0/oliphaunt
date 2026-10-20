import { requireBrowserStorage, serializeOpenConfig } from '../../core/open-config.js';
import { DEFAULT_BROWSER_STARTUP_TIMEOUT_MS } from '../../core/startup-budget.js';
import type { PersistentWasixStorage } from './browser-public.js';
import type {
  BinaryInput,
  OliphauntClient,
  OliphauntDatabase,
  OpenConfig,
} from './browser-public.js';
import {
  openWasixWithWorker,
  restoreWasixWithWorker,
  type WasixWorkerPort,
} from '../../workers/worker-rpc.js';

/** Open PostgreSQL in a package-owned browser Worker. */
export async function openWasix(config: OpenConfig = {}): Promise<OliphauntDatabase> {
  const openOptions = serializeOpenConfig(config);
  openOptions.timeouts = {
    startupTimeoutMs: DEFAULT_BROWSER_STARTUP_TIMEOUT_MS,
    ...openOptions.timeouts,
  };
  requireBrowserStorage(openOptions);
  assertBrowserWorkerEnvironment();
  return openWasixWithWorker(createBrowserWorker, openOptions, requireBrowserStorage);
}

async function restoreBrowserWasix(
  storage: PersistentWasixStorage,
  bytes: BinaryInput,
  options?: import('../../core/types.js').RestoreOptions,
): Promise<void> {
  assertBrowserWorkerEnvironment();
  return restoreWasixWithWorker(
    createBrowserWorker,
    storage,
    bytes,
    requireBrowserStorage,
    options,
  );
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
