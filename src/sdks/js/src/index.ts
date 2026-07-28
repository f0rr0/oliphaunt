export {
  createOliphauntClient,
  nativeDirectCapabilities,
  OliphauntDatabase,
  supportsBackupFormat,
  supportsRestoreFormat,
  type NativeBindingFactory,
} from './client.js';
export { createBunNativeBinding } from './native/bun.js';
export { createDefaultNativeBinding } from './native/default.js';
export { createDenoNativeBinding } from './native/deno.js';
export { createNodeNativeBinding } from './native/node.js';
export { simpleQuery } from './protocol.js';
export {
  assertSuccessfulQueryResponse,
  extendedQuery,
  parseQueryResponse,
  PostgresError,
  toUint8Array,
  type PostgresErrorField,
  type QueryBinaryInput,
  type QueryField,
  type QueryFormat,
  type QueryParam,
  type QueryResult,
  type QueryRow,
} from './query.js';
export type {
  BackupArtifact,
  BackupFormat,
  BackgroundPreparationOptions,
  BackgroundPreparationResult,
  BinaryInput,
  BrokerTransport,
  DurabilityProfile,
  EngineCapabilities,
  EngineMode,
  EngineModeSupport,
  JavaScriptRuntime,
  OliphauntClient,
  OliphauntTransaction,
  OpenConfig,
  PostgresStartupGUC,
  ProtocolChunkCallback,
  RawProtocolTransport,
  RestoreOptions,
  RuntimeFootprintProfile,
  SupportedModesOptions,
} from './types.js';
export type { NormalizedOpenConfig } from './config.js';
export type {
  MaybePromise,
  NativeBinding,
  NativeBindingOptions,
  NativeHandle,
  NativeOpenConfig,
  NativeRestoreOptions,
} from './native/types.js';
export type { RuntimeBinding, RuntimeHandle } from './runtime/types.js';

import { createOliphauntClient } from './client.js';
import type { OliphauntClient } from './types.js';

export const Oliphaunt: OliphauntClient = createOliphauntClient();

export default Oliphaunt;
