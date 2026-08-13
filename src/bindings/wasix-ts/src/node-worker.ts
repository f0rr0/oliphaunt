import { readFile } from 'node:fs/promises';
import { parentPort } from 'node:worker_threads';
import * as zlib from 'node:zlib';
import { installPackageAssetReader } from './asset-source.js';
import * as host from './node-host.js';
import { nodeZstdDecompressor } from './node-zstd.js';
import type { WorkerRequest, WorkerResponse } from './rpc.js';
import { acquireNodeDirectoryStorage } from './storage/node-directory-provider.js';
import { installNodeDirectoryStorageProvider } from './storage-provider.js';
import { createWorkerDispatcher } from './worker-dispatch.js';
import { installZstdDecompressor } from './zstd.js';

if (parentPort === null) {
  throw new Error('@oliphaunt/wasix-ts Node host must run inside a worker thread');
}

installPackageAssetReader((source) => readFile(source));
installNodeDirectoryStorageProvider(acquireNodeDirectoryStorage);
const nativeZstd = nodeZstdDecompressor(Reflect.get(zlib, 'zstdDecompressSync'), zlib);
if (nativeZstd !== undefined) installZstdDecompressor(nativeZstd);

const port = parentPort;
const dispatch = createWorkerDispatcher(host, respond);
port.on('message', (request: WorkerRequest) => {
  void dispatch(request);
});

function respond(response: WorkerResponse, transfer: readonly ArrayBuffer[] = []): void {
  port.postMessage(response, [...transfer]);
}
