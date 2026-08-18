import { randomUUID } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainThread, Worker } from 'node:worker_threads';

import { openWasixWithWorker, serializeOpenConfig, type WasixWorkerPort } from './client-common.js';
import { releaseNodeDirectoryLockSync } from './node-directory-lock.js';
import { nodeWorkerExecArgv } from './node-worker-options.js';
import { nodeWorkerPort } from './node-worker-port.js';
import { resolveExecutionMode } from './open-options.js';
import type { SerializedOpenOptions } from './rpc.js';
import { serverRuntime, serverRuntimeName } from './server-runtime.js';
import type { OliphauntClient, OliphauntDatabase, OpenConfig } from './types.js';

export async function openWasix(config: OpenConfig = {}): Promise<OliphauntDatabase> {
  const execution = resolveExecutionMode(config);
  const openOptions = serializeOpenConfig(config);
  if (execution === 'direct') {
    requireNodeStorage(openOptions);
    const { openNodeDirect } = await import('./node-direct.js');
    return openNodeDirect(openOptions);
  }
  return openWasixWithWorker(createNodeWorker, openOptions, requireNodeStorage);
}

export const Oliphaunt: OliphauntClient = {
  open: openWasix,
};

function requireNodeStorage(options: SerializedOpenOptions): void {
  if (options.storage.kind === 'indexed-db' || options.storage.kind === 'opfs') {
    const provider = options.storage.kind === 'indexed-db' ? 'IndexedDB' : 'OPFS';
    throw new TypeError(
      `@oliphaunt/wasix-ts ${provider} storage is browser-only; use memory or the storage/${serverRuntime()} adapter`,
    );
  }
  if (options.storage.kind === 'directory') {
    if (!isMainThread) {
      throw new TypeError(
        `@oliphaunt/wasix-ts ${serverRuntimeName()} directory storage must be opened from the main thread`,
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
  const ownerToken = storage.kind === 'directory' ? storage.ownerToken : undefined;
  const recoverLease =
    storage.kind === 'directory' && ownerToken !== undefined
      ? () => releaseAbandonedDirectoryLock(storage.path, ownerToken)
      : undefined;
  return nodeWorkerPort(
    new Worker(new URL('./node-worker.js', import.meta.url), {
      execArgv: nodeWorkerExecArgv(),
      name: 'oliphaunt-wasix',
    }),
    recoverLease,
    serverRuntimeName(),
  );
}

/** Last-resort cleanup when a worker dies before its storage lease can close. */
function releaseAbandonedDirectoryLock(input: string, ownerToken: string): void {
  const root = resolveNodeDirectoryPath(input);
  releaseNodeDirectoryLockSync(root, ownerToken);
}

function resolveNodeDirectoryPath(input: string): string {
  const requested = input.startsWith('file:') ? fileURLToPath(input) : input;
  return isAbsolute(requested) ? requested : resolve(requested);
}
