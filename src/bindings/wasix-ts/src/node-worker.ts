import { readFile } from 'node:fs/promises';
import { parentPort } from 'node:worker_threads';
import * as zlib from 'node:zlib';
import { installPackageAssetReader } from './asset-source.js';
import { DirectWasixSession, type DirectWasixHost } from './direct-client-common.js';
import * as host from './node-host.js';
import { nodeZstdDecompressor } from './node-zstd.js';
import type { WorkerRequest, WorkerResponse } from './rpc.js';
import { acquireNodeDirectoryStorage } from './storage/node-directory-provider.js';
import { installNodeDirectoryStorageProvider } from './storage-provider.js';
import { createWorkerSessionDispatcher } from './worker-dispatch.js';
import { installZstdDecompressor } from './zstd.js';

if (parentPort === null) {
  throw new Error('@oliphaunt/wasix-ts Node host must run inside a worker thread');
}

installPackageAssetReader((source) => readFile(source));
installNodeDirectoryStorageProvider(acquireNodeDirectoryStorage);
const nativeZstd = nodeZstdDecompressor(Reflect.get(zlib, 'zstdDecompressSync'), zlib);
if (nativeZstd !== undefined) installZstdDecompressor(nativeZstd);

const port = parentPort;
const directHost: DirectWasixHost = {
  Directory: host.Directory,
  init: host.initDirect,
  instantiateOliphauntDirect: host.instantiateOliphauntDirect,
};
const dispatch = createWorkerSessionDispatcher(
  (options) => DirectWasixSession.open(options, directHost, undefined, 'node'),
  respond,
);
port.on('message', (request: WorkerRequest) => {
  void dispatch(request);
});

function respond(response: WorkerResponse, transfer: readonly ArrayBuffer[] = []): void {
  port.postMessage(response, [...transfer]);
}
