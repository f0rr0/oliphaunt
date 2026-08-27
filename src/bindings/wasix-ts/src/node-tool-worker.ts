import { parentPort } from 'node:worker_threads';
import * as host from './node-host.js';
import { installNodeEnvironment } from './node-environment.js';
import {
  createWasixToolWorkerDispatcher,
  toolWorkerResponseTransfers,
  type WasixToolWorkerRequest,
  type WasixToolWorkerResponse,
} from './tool-worker-common.js';

if (parentPort === null) {
  throw new Error('Oliphaunt WASIX tool host must run inside a worker thread');
}

const port = parentPort;
installNodeEnvironment();
const dispatch = createWasixToolWorkerDispatcher(host);
port.on('message', (request: WasixToolWorkerRequest) => {
  void dispatch(request).then((response) => {
    port.postMessage(
      response satisfies WasixToolWorkerResponse,
      toolWorkerResponseTransfers(response),
    );
  });
});
