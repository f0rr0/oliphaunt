import defaultWasixRuntime from '@oliphaunt/liboliphaunt-wasix';

import { serializeWasixExtensionDescriptors } from './extension-descriptor.js';
import type { SerializedAssetSource, SerializedOpenOptions } from './rpc.js';
import { serializeWasixRuntimeDescriptor } from './runtime-descriptor.js';
import { serializeWasixStorage } from './storage.js';
import type { OliphauntDatabase, OpenConfig } from './types.js';
import { openWorkerDatabase, type WasixWorkerPort } from './worker-rpc.js';

export type { WasixWorkerPort } from './worker-rpc.js';

export function serializeOpenConfig(config: OpenConfig = {}): SerializedOpenOptions {
  const extensions = serializeWasixExtensionDescriptors(config.extensions ?? []);
  const runtime = serializeWasixRuntimeDescriptor(config.advanced?.runtime ?? defaultWasixRuntime);
  const storage = serializeWasixStorage(config.storage);
  return {
    runtime,
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

function assetTransfers(options: SerializedOpenOptions): Transferable[] {
  const transfer: Transferable[] = [];
  const seen = new Set<ArrayBuffer>();
  appendAssetTransfer(options.runtime.runtimeArchive.source, transfer, seen);
  appendAssetTransfer(options.runtime.pgdataArchive.source, transfer, seen);
  appendAssetTransfer(options.runtime.manifest.source, transfer, seen);
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
