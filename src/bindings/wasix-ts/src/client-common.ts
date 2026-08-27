import defaultWasixRuntime from '@oliphaunt/liboliphaunt-wasix';

import { serializeWasixExtensionDescriptors } from './extension-descriptor.js';
import { serializeWasixIcuDescriptor } from './icu-descriptor.js';
import { decodePhysicalArchive } from './physical-archive.js';
import { toUint8Array } from './query.js';
import type { SerializedAssetSource, SerializedOpenOptions } from './rpc.js';
import { serializeWasixRuntimeDescriptor } from './runtime-descriptor.js';
import { serializeWasixStorage } from './storage.js';
import { restoreWasixStorage, WASIX_PHYSICAL_IDENTITY } from './storage-provider.js';
import type {
  BinaryInput,
  OliphauntDatabase,
  OpenConfig,
  WasixRuntimeDescriptor,
} from './types.js';
import {
  openWorkerDatabase,
  WorkerRpc,
  type WasixWorkerPort,
} from './worker-rpc.js';

export type { WasixWorkerPort } from './worker-rpc.js';

export function serializeOpenConfig(
  config: OpenConfig = {},
  runtimeDescriptor: WasixRuntimeDescriptor = defaultWasixRuntime,
): SerializedOpenOptions {
  rejectLegacyExecutionOption(config);
  const extensions = serializeWasixExtensionDescriptors(config.extensions ?? []);
  const runtime = serializeWasixRuntimeDescriptor(runtimeDescriptor);
  const storage = serializeWasixStorage(config.storage);
  return {
    runtime,
    ...(config.icu === undefined ? {} : { icu: serializeWasixIcuDescriptor(config.icu) }),
    extensionCarriers: extensions.carriers,
    extensions: extensions.selectedSqlNames,
    username: config.username ?? 'postgres',
    database: config.database ?? 'postgres',
    startupGUCs: { ...(config.startupGUCs ?? {}) },
    storage,
  };
}

/** @internal Prevent untyped JavaScript from silently changing calling semantics. */
export function rejectLegacyExecutionOption(config: OpenConfig): void {
  if (Object.prototype.hasOwnProperty.call(config, 'execution')) {
    throw new TypeError(
      '@oliphaunt/wasix-ts no longer accepts the "execution" option; use the root entrypoint for package-owned Worker execution or import @oliphaunt/wasix-ts/blocking for caller-realm execution',
    );
  }
}

export async function openWasixWithWorker(
  createWorker: (options: SerializedOpenOptions) => WasixWorkerPort,
  openOptions: SerializedOpenOptions,
  validate?: (options: SerializedOpenOptions) => void,
): Promise<OliphauntDatabase> {
  validate?.(openOptions);
  return openWorkerDatabase(createWorker(openOptions), openOptions, assetTransfers(openOptions));
}

export async function restoreWasix(
  storage: OpenConfig['storage'],
  bytes: BinaryInput,
  validate?: (options: SerializedOpenOptions) => void,
): Promise<void> {
  if (storage === undefined) throw new TypeError('WASIX restore requires persistent storage');
  const openOptions = serializeOpenConfig({ storage });
  validate?.(openOptions);
  await restoreWasixSerialized(openOptions.storage, toUint8Array(bytes).slice());
}

/** @internal Restore through a temporary package-owned Worker. */
export async function restoreWasixWithWorker(
  createWorker: (options: SerializedOpenOptions) => WasixWorkerPort,
  storage: OpenConfig['storage'],
  bytes: BinaryInput,
  validate?: (options: SerializedOpenOptions) => void,
): Promise<void> {
  if (storage === undefined) throw new TypeError('WASIX restore requires persistent storage');
  const openOptions = serializeOpenConfig({ storage });
  validate?.(openOptions);
  const input = toUint8Array(bytes).slice();
  const rpc = new WorkerRpc(createWorker(openOptions));
  let primaryFailure: unknown;
  try {
    await rpc.request({ method: 'restore', storage: openOptions.storage, bytes: input }, [
      input.buffer,
    ]);
  } catch (error) {
    primaryFailure = error;
  }
  try {
    await rpc.terminate();
  } catch (terminationFailure) {
    if (primaryFailure === undefined) throw terminationFailure;
  }
  if (primaryFailure !== undefined) throw primaryFailure;
}

/** @internal Restore already-owned archive bytes inside the selected realm. */
export async function restoreWasixSerialized(
  storage: SerializedOpenOptions['storage'],
  bytes: Uint8Array,
): Promise<void> {
  const snapshot = decodePhysicalArchive(bytes);
  await restoreWasixStorage(storage, snapshot, WASIX_PHYSICAL_IDENTITY);
}

function assetTransfers(options: SerializedOpenOptions): Transferable[] {
  const transfer: Transferable[] = [];
  const seen = new Set<ArrayBuffer>();
  appendAssetTransfer(options.runtime.runtimeArchive.source, transfer, seen);
  appendAssetTransfer(options.runtime.manifest.source, transfer, seen);
  if (options.icu !== undefined) {
    appendAssetTransfer(options.icu.dataArchive.source, transfer, seen);
    appendAssetTransfer(options.icu.clusterSeedArchive.source, transfer, seen);
    appendAssetTransfer(options.icu.clusterSeedManifest.source, transfer, seen);
  } else {
    appendAssetTransfer(options.runtime.standardSeedArchive.source, transfer, seen);
    appendAssetTransfer(options.runtime.standardSeedManifest.source, transfer, seen);
  }
  for (const carrier of Object.values(options.extensionCarriers)) {
    appendAssetTransfer(carrier.source, transfer, seen);
  }
  return transfer;
}

function appendAssetTransfer(
  source: SerializedAssetSource | undefined,
  transfer: Transferable[],
  seen: Set<ArrayBuffer>,
): void {
  if (!(source instanceof Uint8Array) || !(source.buffer instanceof ArrayBuffer)) {
    return;
  }
  if (!seen.has(source.buffer)) {
    seen.add(source.buffer);
    transfer.push(source.buffer);
  }
}
