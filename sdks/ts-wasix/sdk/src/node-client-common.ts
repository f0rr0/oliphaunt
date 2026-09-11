import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { serializeOpenConfig } from './client-common.js';
import { hostRuntime } from './host-runtime.js';
import { restoreNativeWasix, restoreNativeWasixDirect } from './native-session.js';
import { toUint8Array } from './query.js';
import type { SerializedOpenOptions } from './rpc.js';
import type { PersistentWasixStorage } from './storage.js';
import type { BinaryInput } from './types.js';

/** @internal Restore a physical archive through the Rust WASIX implementation. */
export async function restoreNodeWasix(
  storage: PersistentWasixStorage,
  bytes: BinaryInput,
): Promise<void> {
  const options = serializeOpenConfig({ storage });
  requireNodeStorage(options);
  return restoreNativeWasix(options, toUint8Array(bytes).slice());
}

/** @internal Restore synchronously in the importing realm for `/direct`. */
export async function restoreNodeWasixDirect(
  storage: PersistentWasixStorage,
  bytes: BinaryInput,
): Promise<void> {
  const options = serializeOpenConfig({ storage });
  requireNodeStorage(options);
  return restoreNativeWasixDirect(options, toUint8Array(bytes).slice());
}

/** @internal Validate and normalize storage shared by direct and Worker entrypoints. */
export function requireNodeStorage(options: SerializedOpenOptions): void {
  if (options.storage.kind === 'indexed-db' || options.storage.kind === 'opfs') {
    const provider = options.storage.kind === 'indexed-db' ? 'IndexedDB' : 'OPFS';
    throw new TypeError(
      `@oliphaunt/wasix-ts ${provider} storage is browser-only; use memory or the storage/${hostRuntime()} adapter`,
    );
  }
  if (options.storage.kind === 'directory') {
    options.storage = {
      ...options.storage,
      path: resolveNodeDirectoryPath(options.storage.path),
    };
  }
}

function resolveNodeDirectoryPath(input: string): string {
  const requested = input.startsWith('file:') ? fileURLToPath(input) : input;
  return isAbsolute(requested) ? requested : resolve(requested);
}
