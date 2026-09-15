import { decodePhysicalArchive } from './physical-archive.js';
import { toUint8Array } from './query.js';
import type { SerializedOpenOptions } from './rpc.js';
import { restoreWasixStorage, WASIX_PHYSICAL_IDENTITY } from './storage-provider.js';
import type { BinaryInput, OpenConfig } from './types.js';
import { serializeOpenConfig } from './open-config.js';
export { serializeOpenConfig } from './open-config.js';

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
