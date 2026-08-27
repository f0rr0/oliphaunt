import { Worker } from 'node:worker_threads';

import { serializeOpenConfig } from './client-common.js';
import { hostRuntimeName } from './host-runtime.js';
import { requireNodeStorage } from './node-client-common.js';
import { releaseNodeDirectoryLockSync } from './node-directory-lock.js';
import { nodeWorkerExecArgv } from './node-worker-options.js';
import { nodeWorkerPort } from './node-worker-port.js';
import type { SerializedOpenOptions } from './rpc.js';
import type { PersistentWasixStorage } from './storage.js';
import type { BinaryInput, OliphauntClient, OliphauntDatabase, OpenConfig } from './types.js';
import { openWasixWithWorker, restoreWasixWithWorker, type WasixWorkerPort } from './worker-rpc.js';

/** Open PostgreSQL in a package-owned Node-compatible Worker. */
export async function openWasix(config: OpenConfig = {}): Promise<OliphauntDatabase> {
  const openOptions = serializeOpenConfig(config);
  return openWasixWithWorker(createNodeWorker, openOptions, requireNodeStorage);
}

export const Oliphaunt: OliphauntClient = {
  open: openWasix,
  restore: restoreNodeWasixWithWorker,
};

async function restoreNodeWasixWithWorker(
  storage: PersistentWasixStorage,
  bytes: BinaryInput,
): Promise<void> {
  return restoreWasixWithWorker(createNodeWorker, storage, bytes, requireNodeStorage);
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
    hostRuntimeName(),
  );
}

/** Last-resort cleanup when a Worker dies before its storage lease can close. */
function releaseAbandonedDirectoryLock(input: string, ownerToken: string): void {
  releaseNodeDirectoryLockSync(input, ownerToken);
}
