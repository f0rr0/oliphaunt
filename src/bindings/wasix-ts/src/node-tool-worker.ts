import { parentPort } from 'node:worker_threads';
import * as host from './node-host.js';
import { installNodeEnvironment } from './node-direct.js';
import {
  runWasixToolWorker,
  toolWorkerResponseTransfers,
  type WasixToolWorkerRequest,
  type WasixToolWorkerResponse,
} from './tool-worker-common.js';

if (parentPort === null) {
  throw new Error('Oliphaunt WASIX tool host must run inside a worker thread');
}

const port = parentPort;
port.on('message', (request: WasixToolWorkerRequest) => {
  installNodeEnvironment();
  void runWasixToolWorker(request, host).then((response) => {
    port.postMessage(
      response satisfies WasixToolWorkerResponse,
      toolWorkerResponseTransfers(response),
    );
  });
});
