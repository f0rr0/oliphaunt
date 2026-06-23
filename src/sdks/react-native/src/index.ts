import NativeOliphaunt from './specs/NativeOliphaunt';
import { createOliphauntClient } from './client';

export type {
  BackupArtifact,
  BackupFormat,
  BackgroundPreparationOptions,
  BackgroundPreparationResult,
  BinaryInput,
  DurabilityProfile,
  EngineCapabilities,
  EngineMode,
  EngineModeSupport,
  ExtensionSizeReport,
  OpenConfig,
  PackageSizeReport,
  PackageSizeReportOptions,
  ProcessMemoryReport,
  OliphauntClient,
  OliphauntTransaction,
  ProtocolChunkCallback,
  RawProtocolTransport,
  RuntimeFootprintProfile,
  PostgresStartupGUC,
  RestoreOptions,
} from './client';
export {
  OliphauntDatabase,
  createOliphauntClient,
  supportsBackupFormat,
  supportsRestoreFormat,
} from './client';
export { simpleQuery } from './protocol';
export type {
  QueryField,
  QueryFormat,
  QueryParam,
  QueryResult,
  QueryRow,
  QueryBinaryInput,
  PostgresErrorField,
} from './query';
export { extendedQuery, parseQueryResponse, PostgresError } from './query';
export type {
  LatencySummary,
  ReactNativeBenchmarkOptions,
  ReactNativeBenchmarkReport,
  ReactNativeBenchmarkWorkload,
  PostgresSettings,
  ThroughputSummary,
} from './benchmark';
export {
  runInstalledOliphauntReactNativeBenchmark,
  runOliphauntReactNativeBenchmark,
} from './benchmark';
export type {
  ReactNativeSmokeOptions,
  ReactNativeSmokeReport,
} from './smoke';
export {
  runInstalledOliphauntReactNativeSmoke,
  runOliphauntReactNativeSmoke,
} from './smoke';
export type { JsiRawProtocolTransport } from './jsiTransport';
export type {
  NativeCapabilities,
  NativeEngineModeSupport,
  NativeExtensionSizeReport,
  NativeOpenConfig,
  NativePackageSizeReport,
  NativeProcessMemoryReport,
  NativeResourceConfig,
  Spec as NativeOliphauntModule,
} from './specs/NativeOliphaunt';

export const Oliphaunt = createOliphauntClient(NativeOliphaunt);
