import { readFile } from 'node:fs/promises';
import { parentPort } from 'node:worker_threads';

import * as host from './node-host.js';

import { installPackageAssetReader } from './asset-source.js';
import type { WorkerRequest, WorkerResponse } from './rpc.js';
import { createWorkerDispatcher } from './worker-dispatch.js';

if (parentPort === null) {
  throw new Error('@oliphaunt/wasix Node host must run inside a worker thread');
}

installPackageAssetReader(async (source) => new Uint8Array(await readFile(source)));

const port = parentPort;
const dispatch = createWorkerDispatcher(host, respond);
port.on('message', (request: WorkerRequest) => {
  void dispatch(request);
});

function respond(response: WorkerResponse, transfer: readonly ArrayBuffer[] = []): void {
  port.postMessage(response, [...transfer]);
}
