import { Worker } from 'node:worker_threads';
import type { OliphauntDatabase } from './types.js';
import { installNodeEnvironment } from './node-direct.js';
import { nodeWorkerExecArgv } from './node-worker-options.js';
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
  installNodeEnvironment();
  return runTool(database, options, createNodeToolWorker);
}

function createNodeToolWorker(): WasixToolWorkerPort {
  const worker = new Worker(new URL('./node-tool-worker.js', import.meta.url), {
    execArgv: nodeWorkerExecArgv(),
    name: 'oliphaunt-wasix-tool',
  });
  return {
    postMessage: (request: WasixToolWorkerRequest, transfer: ArrayBuffer[]) =>
      worker.postMessage(request, transfer),
    response: () =>
      new Promise<WasixToolWorkerResponse>((resolve, reject) => {
        worker.once('message', resolve);
        worker.once('error', reject);
        worker.once('messageerror', reject);
        worker.once('exit', (code) => {
          reject(new Error(`Oliphaunt WASIX tool worker exited before replying (code ${code})`));
        });
      }),
    terminate: async () => {
      await worker.terminate();
    },
  };
}
