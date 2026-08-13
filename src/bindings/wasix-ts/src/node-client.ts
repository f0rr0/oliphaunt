import { randomUUID } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainThread, Worker } from 'node:worker_threads';

import { openWasixWithWorker, serializeOpenConfig, type WasixWorkerPort } from './client-common.js';
import { releaseNodeDirectoryLockSync } from './node-directory-lock.js';
import { nodeWorkerExecArgv } from './node-worker-options.js';
import { nodeWorkerPort } from './node-worker-port.js';
import { resolveExecutionMode } from './open-options.js';
import type { SerializedOpenOptions } from './rpc.js';
import type { OliphauntClient, OliphauntDatabase, OpenConfig } from './types.js';

export async function openWasix(config: OpenConfig = {}): Promise<OliphauntDatabase> {
  if (resolveExecutionMode(config) === 'direct') {
    throw new TypeError(
      '@oliphaunt/wasix-ts direct execution is browser-only; use execution: "worker" in Node.js',
    );
  }
  const openOptions = serializeOpenConfig(config);
  return openWasixWithWorker(createNodeWorker, openOptions, requireNodeStorage);
}

export const Oliphaunt: OliphauntClient = {
  open: openWasix,
};

function requireNodeStorage(options: SerializedOpenOptions): void {
  if (options.storage.kind === 'indexed-db') {
    throw new TypeError(
      '@oliphaunt/wasix-ts IndexedDB storage is browser-only; use memory or the storage/node adapter',
    );
  }
  if (options.storage.kind === 'node-directory') {
    if (!isMainThread) {
      throw new TypeError(
        '@oliphaunt/wasix-ts Node directory storage must be opened from the main thread',
      );
    }
    options.storage = {
      ...options.storage,
      path: resolveNodeDirectoryPath(options.storage.path),
      ownerToken: randomUUID(),
    };
  }
}

function createNodeWorker(options: SerializedOpenOptions): WasixWorkerPort {
  const storage = options.storage;
  const ownerToken = storage.kind === 'node-directory' ? storage.ownerToken : undefined;
  const recoverLease =
    storage.kind === 'node-directory' && ownerToken !== undefined
      ? () => releaseAbandonedDirectoryLock(storage.path, ownerToken)
      : undefined;
  return nodeWorkerPort(
    new Worker(new URL('./node-worker.js', import.meta.url), {
      execArgv: nodeWorkerExecArgv(),
      name: 'oliphaunt-wasix',
    }),
    recoverLease,
  );
}

/** Last-resort cleanup when a worker dies before its storage lease can close. */
function releaseAbandonedDirectoryLock(input: string, ownerToken: string): void {
  const root = resolveNodeDirectoryPath(input);
  releaseNodeDirectoryLockSync(join(root, '.oliphaunt-wasix-ts'), ownerToken);
}

function resolveNodeDirectoryPath(input: string): string {
  const requested = input.startsWith('file:') ? fileURLToPath(input) : input;
  return isAbsolute(requested) ? requested : resolve(requested);
}
