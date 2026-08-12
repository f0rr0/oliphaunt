import NativeOliphaunt from './specs/NativeOliphaunt';
import { createOliphauntClient } from './client';

export type {
  BackupArtifact,
  BackupFormat,
  BackgroundPreparationOptions,
  BackgroundPreparationResult,
  BinaryInput,
  DatabaseStorage,
  DurabilityProfile,
  EngineCapabilities,
  EngineMode,
  EngineModeSupport,
  ExtensionSizeReport,
  OpenConfig,
  OliphauntDatabase,
  PackageSizeReport,
  PackageSizeReportOptions,
  ProcessMemoryReport,
  OliphauntClient,
  OliphauntTransaction,
  ProtocolChunkCallback,
  RawProtocolTransport,
  RuntimeFootprintProfile,
  PostgresStartupGUC,
  RestoreDestinationPolicy,
  RestoreOptions,
} from './client';
export {
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
export type {
  MobileReleaseExtensionProof,
  MobileReleasePlatform,
} from './mobileExtensionProof';
export {
  MOBILE_RELEASE_EXTENSION_PROOF_COUNT,
  MOBILE_RELEASE_EXTENSION_CATALOG_SHA256,
  mobileReleaseExtensionProofPlan,
} from './mobileExtensionProof';
export const Oliphaunt = createOliphauntClient(NativeOliphaunt);
