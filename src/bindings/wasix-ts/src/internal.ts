import type { OliphauntDatabase } from './types.js';
import {
  runWasixToolProcess as runTool,
  type WasixToolProcessOptions,
  type WasixToolProcessResult,
  type WasixToolWorkerPort,
} from './internal-common.js';
import type { WasixToolWorkerRequest, WasixToolWorkerResponse } from './tool-worker-common.js';

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
  return {
    postMessage: (request: WasixToolWorkerRequest, transfer: ArrayBuffer[]) =>
      worker.postMessage(request, transfer),
    response: () =>
      new Promise<WasixToolWorkerResponse>((resolve, reject) => {
        worker.addEventListener('message', (event: MessageEvent<WasixToolWorkerResponse>) =>
          resolve(event.data),
        );
        worker.addEventListener('error', (event) =>
          reject(new Error(event.message || 'Oliphaunt WASIX tool worker crashed')),
        );
        worker.addEventListener('messageerror', () =>
          reject(new Error('Oliphaunt WASIX tool worker returned an unreadable response')),
        );
      }),
    terminate: () => worker.terminate(),
  };
}
