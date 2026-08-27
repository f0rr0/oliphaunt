import { randomUUID } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainThread } from 'node:worker_threads';

import { restoreWasix, restoreWasixWithWorker } from './client-common.js';
import { hostRuntime, hostRuntimeName } from './host-runtime.js';
import { installNodeEnvironment } from './node-environment.js';
import type { SerializedOpenOptions } from './rpc.js';
import type { PersistentWasixStorage } from './storage.js';
import type { BinaryInput } from './types.js';
import type { WasixWorkerPort } from './worker-rpc.js';

/** @internal Install Node host adapters before restoring a physical archive. */
export async function restoreNodeWasix(
  storage: PersistentWasixStorage,
  bytes: BinaryInput,
): Promise<void> {
  installNodeEnvironment();
  return restoreWasix(storage, bytes, requireNodeStorage);
}

/** @internal Restore through a temporary Node-compatible owner Worker. */
export async function restoreNodeWasixWithWorker(
  createWorker: (options: SerializedOpenOptions) => WasixWorkerPort,
  storage: PersistentWasixStorage,
  bytes: BinaryInput,
): Promise<void> {
  return restoreWasixWithWorker(createWorker, storage, bytes, requireNodeStorage);
}

/** @internal Validate and normalize storage shared by Worker and blocking entrypoints. */
export function requireNodeStorage(options: SerializedOpenOptions): void {
  if (options.storage.kind === 'indexed-db' || options.storage.kind === 'opfs') {
    const provider = options.storage.kind === 'indexed-db' ? 'IndexedDB' : 'OPFS';
    throw new TypeError(
      `@oliphaunt/wasix-ts ${provider} storage is browser-only; use memory or the storage/${hostRuntime()} adapter`,
    );
  }
  if (options.storage.kind === 'directory') {
    if (!isMainThread) {
      throw new TypeError(
        `@oliphaunt/wasix-ts ${hostRuntimeName()} directory storage must be opened from the main thread`,
      );
    }
    options.storage = {
      ...options.storage,
      path: resolveNodeDirectoryPath(options.storage.path),
      ownerToken: randomUUID(),
    };
  }
}

function resolveNodeDirectoryPath(input: string): string {
  const requested = input.startsWith('file:') ? fileURLToPath(input) : input;
  return isAbsolute(requested) ? requested : resolve(requested);
}
