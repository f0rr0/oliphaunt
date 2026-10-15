import { normalizeAdmissionLimits } from '@oliphaunt/ts-query/internal/operation-budget';
import defaultWasixRuntime from '@oliphaunt/liboliphaunt-wasix';

import { serializeWasixExtensionDescriptors } from '../resources/extension-descriptor.js';
import { serializeWasixIcuDescriptor, serializeWasixSeed } from '../resources/icu-descriptor.js';
import type { SerializedOpenOptions } from '../workers/rpc.js';
import { serializeWasixRuntimeDescriptor } from '../resources/runtime-descriptor.js';
import { serializeWasixStorage } from '../storage/types.js';
import { normalizeWasixStartupGUCs } from './startup-config.js';
import type { OpenConfig, WasixRuntimeDescriptor } from './types.js';

export function serializeOpenConfig(
  config: OpenConfig = {},
  runtimeDescriptor: WasixRuntimeDescriptor = defaultWasixRuntime,
): SerializedOpenOptions {
  const admission = normalizeAdmissionLimits(config.admission);
  const extensions = serializeWasixExtensionDescriptors(config.extensions ?? []);
  const runtime = serializeWasixRuntimeDescriptor(runtimeDescriptor);
  const storage = serializeWasixStorage(config.storage);
  return {
    runtime,
    ...(admission === undefined ? {} : { admission }),
    ...(config.seed === undefined ? {} : { seed: serializeWasixSeed(config.seed) }),
    ...(config.icu === undefined ? {} : { icu: serializeWasixIcuDescriptor(config.icu) }),
    extensionCarriers: extensions.carriers,
    extensions: extensions.selectedSqlNames,
    username: config.username ?? 'postgres',
    database: config.database ?? 'postgres',
    startupGUCs: normalizeWasixStartupGUCs(config.startupGUCs ?? {}),
    storage,
  };
}

/** Reject unsupported browser storage before loading an engine or starting a worker. */
export function requireBrowserStorage(options: SerializedOpenOptions): void {
  if (options.storage.kind === 'directory') {
    throw new TypeError(
      '@oliphaunt/wasix-ts/browser directory storage is native-only; use memory, IndexedDB, or OPFS',
    );
  }
}

/** Native actor permits use a u32 count; reject before loading an addon or starting its Worker. */
export function validateNativeOwnerAdmission(options: SerializedOpenOptions): void {
  const limits = options.admission;
  if (
    limits !== undefined &&
    (limits.maxPendingOperations > 0xffff_ffff || limits.highWaterMarkBytes > 0xffff_ffff)
  ) {
    throw new RangeError('admission limits exceed the WASIX owner semaphore range');
  }
}
