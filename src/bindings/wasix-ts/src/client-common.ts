import defaultWasixRuntime from '@oliphaunt/liboliphaunt-wasix';

import { serializeWasixExtensionDescriptors } from './extension-descriptor.js';
import { serializeWasixIcuDescriptor } from './icu-descriptor.js';
import { decodePhysicalArchive } from './physical-archive.js';
import { toUint8Array } from './query.js';
import type { SerializedOpenOptions } from './rpc.js';
import { serializeWasixRuntimeDescriptor } from './runtime-descriptor.js';
import { serializeWasixStorage } from './storage.js';
import { restoreWasixStorage, WASIX_PHYSICAL_IDENTITY } from './storage-provider.js';
import type { BinaryInput, OpenConfig, WasixRuntimeDescriptor } from './types.js';

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
      '@oliphaunt/wasix-ts no longer accepts the "execution" option; use the root entrypoint for caller-realm execution or import @oliphaunt/wasix-ts/worker for a package-owned Worker',
    );
  }
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

/** @internal Restore already-owned archive bytes inside the selected realm. */
export async function restoreWasixSerialized(
  storage: SerializedOpenOptions['storage'],
  bytes: Uint8Array,
): Promise<void> {
  const snapshot = decodePhysicalArchive(bytes);
  await restoreWasixStorage(storage, snapshot, WASIX_PHYSICAL_IDENTITY);
}
