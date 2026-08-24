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
import { openWorkerDatabase, type WasixWorkerPort } from './worker-rpc.js';

export type { WasixWorkerPort } from './worker-rpc.js';

export function serializeOpenConfig(
  config: OpenConfig = {},
  runtimeDescriptor: WasixRuntimeDescriptor = defaultWasixRuntime,
): SerializedOpenOptions {
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
  const snapshot = decodePhysicalArchive(toUint8Array(bytes).slice());
  await restoreWasixStorage(openOptions.storage, snapshot, WASIX_PHYSICAL_IDENTITY);
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
