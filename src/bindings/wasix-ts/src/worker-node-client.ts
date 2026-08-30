import { Worker } from 'node:worker_threads';

import { serializeOpenConfig } from './client-common.js';
import { hostRuntimeName } from './host-runtime.js';
import { requireNodeStorage } from './node-client-common.js';
import { nodeWorkerExecArgv } from './node-worker-options.js';
import { nodeWorkerPort } from './node-worker-port.js';
import type { SerializedOpenOptions } from './rpc.js';
import type { PersistentWasixStorage } from './storage.js';
import type { BinaryInput, OliphauntClient, OliphauntDatabase, OpenConfig } from './types.js';
import { openWasixWithWorker, restoreWasixWithWorker, type WasixWorkerPort } from './worker-rpc.js';

/** Open PostgreSQL in a package-owned Node-compatible Worker realm. */
export async function openWasix(config: OpenConfig = {}): Promise<OliphauntDatabase> {
  // The native Worker owns release-embedded runtime assets. Do not structured-
  // clone caller-provided WebAssembly archives that the N-API path will never
  // read; retain their exact identity metadata for compatibility validation.
  const openOptions = withoutNativeAssetPayloads(serializeOpenConfig(config));
  return openWasixWithWorker(createNodeWorker, openOptions, requireNodeStorage, false);
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

function createNodeWorker(_options: SerializedOpenOptions): WasixWorkerPort {
  return nodeWorkerPort(
    new Worker(new URL('./node-worker.js', import.meta.url), {
      execArgv: nodeWorkerExecArgv(),
      name: 'oliphaunt-wasix',
    }),
    hostRuntimeName(),
  );
}

function withoutNativeAssetPayloads(options: SerializedOpenOptions): SerializedOpenOptions {
  const source = 'oliphaunt:wasix-napi-embedded';
  return {
    ...options,
    runtime: {
      ...options.runtime,
      runtimeArchive: { ...options.runtime.runtimeArchive, source },
      standardSeedArchive: { ...options.runtime.standardSeedArchive, source },
      standardSeedManifest: { ...options.runtime.standardSeedManifest, source },
      manifest: { ...options.runtime.manifest, source },
    },
    ...(options.icu === undefined
      ? {}
      : {
          icu: {
            ...options.icu,
            dataArchive: { ...options.icu.dataArchive, source },
            clusterSeedArchive: { ...options.icu.clusterSeedArchive, source },
            clusterSeedManifest: { ...options.icu.clusterSeedManifest, source },
          },
        }),
    extensionCarriers: Object.fromEntries(
      Object.entries(options.extensionCarriers).map(([sqlName, carrier]) => [
        sqlName,
        { ...carrier, source },
      ]),
    ),
  };
}
