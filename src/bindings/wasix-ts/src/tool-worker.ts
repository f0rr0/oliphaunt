/// <reference lib="webworker" />

import * as host from './host/index.mjs';
import {
  createWasixToolWorkerDispatcher,
  toolWorkerResponseTransfers,
  type WasixToolWorkerRequest,
  type WasixToolWorkerResponse,
} from './tool-worker-common.js';

const scope = globalThis as unknown as DedicatedWorkerGlobalScope;
const dispatch = createWasixToolWorkerDispatcher(host);
scope.addEventListener('message', (event: MessageEvent<WasixToolWorkerRequest>) => {
  void dispatch(event.data).then((response) => {
    scope.postMessage(
      response satisfies WasixToolWorkerResponse,
      toolWorkerResponseTransfers(response),
    );
  });
});
