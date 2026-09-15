/// <reference lib="webworker" />

import * as host from './host/index.mjs';

import { openBrowserWorkerSession, type DirectWasixHost } from './direct-client-common.js';
import type { WorkerRequest, WorkerResponse } from './rpc.js';
import { createWorkerSessionDispatcher } from './worker-dispatch.js';

const scope = globalThis as unknown as DedicatedWorkerGlobalScope;
const directHost: DirectWasixHost = {
  Directory: host.Directory,
  init: host.init,
  instantiateOliphauntDirect: host.instantiateOliphauntDirect,
  prepareOliphauntTool: host.prepareOliphauntTool,
  runOliphauntToolDirect: host.runOliphauntToolDirect,
};
// This package worker is the isolation boundary. Opening the direct session
// here keeps PostgreSQL and synchronous OPFS handles in the same realm.
const dispatch = createWorkerSessionDispatcher(
  (options) => openBrowserWorkerSession(options, directHost),
  respond,
);

scope.addEventListener('message', (event: MessageEvent<WorkerRequest>) => {
  void dispatch(event.data);
});

function respond(response: WorkerResponse, transfer: readonly ArrayBuffer[] = []): void {
  scope.postMessage(response, [...transfer]);
}
