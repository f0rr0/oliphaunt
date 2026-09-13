import defaultWasixRuntime from '@oliphaunt/liboliphaunt-wasix';

import { serializeWasixExtensionDescriptors } from './extension-descriptor.js';
import { serializeWasixIcuDescriptor } from './icu-descriptor.js';
import type { SerializedOpenOptions } from './rpc.js';
import { serializeWasixRuntimeDescriptor } from './runtime-descriptor.js';
import { serializeWasixStorage } from './storage.js';
import { normalizeWasixStartupGUCs } from './startup-config.js';

import type { OpenConfig, WasixRuntimeDescriptor } from './types.js';

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
