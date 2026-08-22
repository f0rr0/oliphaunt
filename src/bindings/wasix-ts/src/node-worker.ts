import { parentPort } from 'node:worker_threads';
import { hostRuntimeName } from './host-runtime.js';
import { openNodeDirectSession } from './node-direct.js';
import type { WorkerRequest, WorkerResponse } from './rpc.js';
import { createWorkerSessionDispatcher } from './worker-dispatch.js';

if (parentPort === null) {
  throw new Error(`@oliphaunt/wasix-ts ${hostRuntimeName()} host must run inside a worker thread`);
}

const port = parentPort;
const dispatch = createWorkerSessionDispatcher(openNodeDirectSession, respond);
port.on('message', (request: WorkerRequest) => {
  void dispatch(request);
});

function respond(response: WorkerResponse, transfer: readonly ArrayBuffer[] = []): void {
  port.postMessage(response, [...transfer]);
}
