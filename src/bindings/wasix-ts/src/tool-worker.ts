/// <reference lib="webworker" />

import * as host from './host/index.mjs';
import {
  runWasixToolWorker,
  toolWorkerResponseTransfers,
  type WasixToolWorkerRequest,
  type WasixToolWorkerResponse,
} from './tool-worker-common.js';

const scope = globalThis as unknown as DedicatedWorkerGlobalScope;
scope.addEventListener('message', (event: MessageEvent<WasixToolWorkerRequest>) => {
  void runWasixToolWorker(event.data, host).then((response) => {
    scope.postMessage(
      response satisfies WasixToolWorkerResponse,
      toolWorkerResponseTransfers(response),
    );
  });
});
