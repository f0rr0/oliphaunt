export {
  supportsBackupFormat,
  supportsRestoreFormat,
} from './client.js';
export { simpleQuery } from './protocol.js';
export {
  assertSuccessfulQueryResponse,
  extendedQuery,
  PostgresError,
  type PostgresErrorField,
  parseQueryResponse,
  type QueryBinaryInput,
  type QueryField,
  type QueryFormat,
  type QueryParam,
  type QueryResult,
  type QueryRow,
  toUint8Array,
} from './query.js';
export type {
  BackgroundPreparationOptions,
  BackgroundPreparationResult,
  BackupArtifact,
  BackupFormat,
  BinaryInput,
  BrokerTransport,
  DatabaseStorage,
  DurabilityProfile,
  EngineCapabilities,
  EngineMode,
  EngineModeSupport,
  JavaScriptRuntime,
  OliphauntClient,
  OliphauntDatabase,
  OliphauntTransaction,
  OpenConfig,
  PostgresStartupGUC,
  ProtocolChunkCallback,
  RawProtocolTransport,
  RestoreDestinationPolicy,
  RestoreOptions,
  RuntimeFootprintProfile,
  SupportedModesOptions,
} from './types.js';

import { createOliphauntClient } from './client.js';
import type { OliphauntClient } from './types.js';

export const Oliphaunt: OliphauntClient = createOliphauntClient();

export default Oliphaunt;
