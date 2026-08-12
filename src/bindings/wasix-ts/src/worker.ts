/// <reference lib="webworker" />

import * as host from './host/index.mjs';

import type { WorkerRequest, WorkerResponse } from './rpc.js';
import { createWorkerDispatcher } from './worker-dispatch.js';

const scope = globalThis as unknown as DedicatedWorkerGlobalScope;
const dispatch = createWorkerDispatcher(host, respond);

scope.addEventListener('message', (event: MessageEvent<WorkerRequest>) => {
  void dispatch(event.data);
});

function respond(response: WorkerResponse, transfer: readonly ArrayBuffer[] = []): void {
  scope.postMessage(response, [...transfer]);
}
