import { readFile } from 'node:fs/promises';
import * as zlib from 'node:zlib';

import { installPackageAssetReader } from './asset-source.js';
import { WasixDatabaseImpl } from './database.js';
import { DirectWasixSession, type DirectWasixHost } from './direct-client-common.js';
import * as host from './node-host.js';
import { nodeZstdDecompressor } from './node-zstd.js';
import type { SerializedOpenOptions } from './rpc.js';
import {
  acquireNodeDirectoryStorage,
  restoreNodeDirectoryStorage,
} from './storage/node-directory-provider.js';
import {
  installNodeDirectoryStorageProvider,
  installNodeDirectoryStorageRestorer,
} from './storage-provider.js';
import type { OliphauntDatabase } from './types.js';
import { installZstdDecompressor } from './zstd.js';

let environmentInstalled = false;

const directHost: DirectWasixHost = {
  Directory: host.Directory,
  init: host.init,
  instantiateOliphauntDirect: host.instantiateOliphauntDirect,
  prepareOliphauntTool: host.prepareOliphauntTool,
  runOliphauntToolDirect: host.runOliphauntToolDirect,
};

/** @internal Own one Node-realm WASIX session without an RPC boundary. */
export async function openNodeDirectSession(
  options: SerializedOpenOptions,
): Promise<DirectWasixSession> {
  installNodeEnvironment();
  return DirectWasixSession.open(options, directHost, undefined, 'node');
}

/** @internal Open the public database contract in the current Node realm. */
export async function openNodeDirect(options: SerializedOpenOptions): Promise<OliphauntDatabase> {
  return new WasixDatabaseImpl(await openNodeDirectSession(options));
}

export function installNodeEnvironment(): void {
  if (environmentInstalled) return;
  installPackageAssetReader((source) => readFile(source));
  installNodeDirectoryStorageProvider(acquireNodeDirectoryStorage);
  installNodeDirectoryStorageRestorer(restoreNodeDirectoryStorage);
  const nativeZstd = nodeZstdDecompressor(Reflect.get(zlib, 'zstdDecompressSync'), zlib);
  if (nativeZstd !== undefined) installZstdDecompressor(nativeZstd);
  environmentInstalled = true;
}
