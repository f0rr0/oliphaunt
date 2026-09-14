import type { OliphauntDatabase } from './types.js';
import {
  runWasixToolProcess as runTool,
  type WasixToolProcessOptions,
  type WasixToolProcessResult,
  type WasixToolWorkerPort,
} from './internal-common.js';
import type { WasixToolWorkerRequest, WasixToolWorkerResponse } from './tool-worker-common.js';

export { getWasixDatabaseIdentity } from './database.js';

export type {
  WasixToolDescriptor,
  WasixToolProcessOptions,
  WasixToolProcessResult,
} from './internal-common.js';

export function runWasixToolProcess(
  database: OliphauntDatabase,
  options: WasixToolProcessOptions,
): Promise<WasixToolProcessResult> {
  return runTool(database, options, createBrowserToolWorker);
}

function createBrowserToolWorker(): WasixToolWorkerPort {
  if (typeof Worker === 'undefined') {
    throw new Error('WASIX tools require Web Workers');
  }
  const worker = new Worker(new URL('./tool-worker.js', import.meta.url), {
    type: 'module',
    name: 'oliphaunt-wasix-tool',
  });
  let messageListener: ((response: WasixToolWorkerResponse) => void) | undefined;
  let fatalListener: ((error: Error) => void) | undefined;
  let fatalDelivered = false;
  worker.addEventListener('message', (event: MessageEvent<WasixToolWorkerResponse>) => {
    messageListener?.(event.data);
  });
  worker.addEventListener('error', (event) => {
    if (fatalDelivered) return;
    fatalDelivered = true;
    fatalListener?.(new Error(event.message || 'Oliphaunt WASIX tool worker crashed'));
  });
  worker.addEventListener('messageerror', () => {
    if (fatalDelivered) return;
    fatalDelivered = true;
    fatalListener?.(new Error('Oliphaunt WASIX tool worker returned an unreadable response'));
  });
  return {
    postMessage: (request: WasixToolWorkerRequest, transfer: ArrayBuffer[] = []) =>
      worker.postMessage(request, transfer),
    onMessage: (listener) => {
      messageListener = listener;
    },
    onFatal: (listener) => {
      fatalListener = listener;
    },
    terminate: () => worker.terminate(),
  };
}
