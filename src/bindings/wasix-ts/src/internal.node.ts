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
  installNodeEnvironment();
  return runTool(database, options, createNodeToolWorker);
}

function createNodeToolWorker(): WasixToolWorkerPort {
  const worker = new Worker(new URL('./node-tool-worker.js', import.meta.url), {
    execArgv: nodeWorkerExecArgv(),
    name: 'oliphaunt-wasix-tool',
  });
  let messageListener: ((response: WasixToolWorkerResponse) => void) | undefined;
  let fatalListener: ((error: Error) => void) | undefined;
  let terminating = false;
  let fatalDelivered = false;
  const fail = (error: unknown) => {
    if (terminating || fatalDelivered) return;
    fatalDelivered = true;
    fatalListener?.(error instanceof Error ? error : new Error(String(error)));
  };
  worker.on('message', (response: WasixToolWorkerResponse) => messageListener?.(response));
  worker.on('error', fail);
  worker.on('messageerror', fail);
  worker.on('exit', (code) => {
    if (!terminating) {
      fail(new Error(`Oliphaunt WASIX tool worker exited before shutdown (code ${code})`));
    }
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
    terminate: async () => {
      terminating = true;
      await worker.terminate();
    },
  };
}
