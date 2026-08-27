import { readFile } from 'node:fs/promises';
import * as zlib from 'node:zlib';

import { installPackageAssetReader } from './asset-source.js';
import { nodeZstdDecompressor } from './node-zstd.js';
import {
  acquireNodeDirectoryStorage,
  restoreNodeDirectoryStorage,
} from './storage/node-directory-provider.js';
import {
  installNodeDirectoryStorageProvider,
  installNodeDirectoryStorageRestorer,
} from './storage-provider.js';
import { installZstdDecompressor } from './zstd.js';

let environmentInstalled = false;

/** @internal Install host-neutral Node adapters without loading the guest driver. */
export function installNodeEnvironment(): void {
  if (environmentInstalled) return;
  installPackageAssetReader((source) => readFile(source));
  installNodeDirectoryStorageProvider(acquireNodeDirectoryStorage);
  installNodeDirectoryStorageRestorer(restoreNodeDirectoryStorage);
  const nativeZstd = nodeZstdDecompressor(Reflect.get(zlib, 'zstdDecompressSync'), zlib);
  if (nativeZstd !== undefined) installZstdDecompressor(nativeZstd);
  environmentInstalled = true;
}
