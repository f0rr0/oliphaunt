import { openWasixWithWorker, type WasixWorkerPort } from './client-common.js';
import type { OliphauntWasixClient, WasixDatabase, WasixOpenOptions } from './types.js';

export async function openWasix(options: WasixOpenOptions = {}): Promise<WasixDatabase> {
  if (typeof Worker === 'undefined') {
    throw new Error('@oliphaunt/wasix requires a browser with module Web Workers');
  }
  if (globalThis.crossOriginIsolated !== true) {
    throw new Error(
      '@oliphaunt/wasix requires COOP: same-origin and COEP: require-corp response headers',
    );
  }
  return openWasixWithWorker(createBrowserWorker, options);
}

export const Oliphaunt: OliphauntWasixClient = {
  open: openWasix,
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
