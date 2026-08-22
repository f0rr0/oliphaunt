import {
  openWasixWithWorker,
  restoreWasix,
  serializeOpenConfig,
  type WasixWorkerPort,
} from './client-common.js';
import { resolveExecutionMode } from './open-options.js';
import type { OliphauntClient, OliphauntDatabase, OpenConfig } from './types.js';

export async function openWasix(config: OpenConfig = {}): Promise<OliphauntDatabase> {
  const execution = resolveExecutionMode(config);
  if (globalThis.crossOriginIsolated !== true) {
    throw new Error(
      '@oliphaunt/wasix-ts requires COOP: same-origin and COEP: require-corp response headers',
    );
  }
  const openOptions = serializeOpenConfig(config);
  if (execution === 'direct') {
    const [{ openWasixDirect }, host] = await Promise.all([
      import('./direct-client-common.js'),
      import('./host/index.mjs'),
    ]);
    return openWasixDirect(openOptions, host);
  }
  if (typeof Worker === 'undefined') {
    throw new Error('@oliphaunt/wasix-ts worker execution requires a browser with Web Workers');
  }
  return openWasixWithWorker(createBrowserWorker, openOptions);
}

export const Oliphaunt: OliphauntClient = {
  open: openWasix,
  restore: restoreWasix,
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
