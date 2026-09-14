import { parentPort } from 'node:worker_threads';

import { hostRuntimeName } from './host-runtime.js';
import { openNodeDirectSession } from './node-direct.js';
import { restoreNativeWasixStorageDirect } from './native-session.js';
import type { WorkerRequest, WorkerResponse } from './rpc.js';
import { createWorkerSessionDispatcher } from './worker-dispatch.js';

if (parentPort === null) {
  throw new Error(`@oliphaunt/wasix-ts ${hostRuntimeName()} host must run inside a Worker`);
}

const port = parentPort;
const runtimeName = hostRuntimeName();
const dispatch = createWorkerSessionDispatcher(
  openNodeDirectSession,
  respond,
  restoreNativeWasixStorageDirect,
  {
    onQuiescentClose() {
      // Run after the close reply and dispatcher frame have unwound. Release
      // the parent port so the Worker exits naturally. Bun 1.3 hangs if its
      // process exit follows MessagePort teardown, so use its Worker-local
      // exit before touching the port. Deno omits close().
      queueMicrotask(() => {
        // Bun's process.exit exits only this Worker, not its parent process.
        // Native close and the close reply have both completed before this
        // quiescent callback runs.
        if (runtimeName === 'Bun') process.exit(0);
        port.off('message', onMessage);
        port.close?.();
        port.unref();
        // Some Worker hosts also expose the standard self-close hook; Node
        // simply omits it.
        (globalThis as { close?: () => void }).close?.();
      });
    },
  },
);

function onMessage(request: WorkerRequest): void {
  void dispatch(request);
}

port.on('message', onMessage);

function respond(response: WorkerResponse, transfer: readonly ArrayBuffer[] = []): void {
  port.postMessage(response, [...transfer]);
}
