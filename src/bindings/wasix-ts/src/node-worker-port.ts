import type { Worker } from 'node:worker_threads';

import type { WasixWorkerPort } from './worker-rpc.js';

/** @internal Adapts Node's EventEmitter worker API to the shared worker transport. */
export function nodeWorkerPort(
  worker: Worker,
  recoverLease?: () => void,
  runtimeName = 'Node',
): WasixWorkerPort {
  let terminating = false;
  let recovered = false;
  return {
    postMessage: (message, transfer) => {
      worker.postMessage(message, transfer as readonly ArrayBuffer[]);
    },
    terminate: async () => {
      terminating = true;
      await worker.terminate();
    },
    onMessage: (listener) => {
      worker.on('message', listener);
    },
    onFatal: (listener) => {
      const fail = (error: Error) => {
        if (!terminating) {
          listener(error);
        }
      };
      worker.on('error', fail);
      worker.on('messageerror', (error) => {
        fail(
          error instanceof Error
            ? error
            : new Error(`Oliphaunt WASIX ${runtimeName} worker returned an unreadable message`),
        );
      });
      worker.on('exit', (code) => {
        if (!recovered) {
          recovered = true;
          recoverLease?.();
        }
        fail(
          new Error(`Oliphaunt WASIX ${runtimeName} worker exited unexpectedly with code ${code}`),
        );
      });
    },
  };
}
