/// <reference lib="webworker" />

import * as host from '../../host/index.mjs';

import { openBrowserWorkerSession, type DirectWasixHost } from './direct-client-common.js';
import type { WorkerRequest, WorkerResponse } from '../../workers/rpc.js';
import { createWorkerSessionDispatcher } from '../../workers/worker-dispatch.js';

const scope = globalThis as unknown as DedicatedWorkerGlobalScope;
const directHost: DirectWasixHost = {
  runWasix: host.runWasix,
  Directory: host.Directory,
  init: host.init,
  instantiateOliphauntDirect: host.instantiateOliphauntDirect,
  prepareOliphauntTool: host.prepareOliphauntTool,
  runOliphauntToolDirect: host.runOliphauntToolDirect,
};
// This package worker owns PostgreSQL and its storage publication boundaries.
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
