import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

export type NativeOpenConfig = {
  engine?: string;
  root?: string;
  temporary?: boolean;
  durability?: string;
  runtimeFootprint?: string;
  startupGUCs?: Array<string>;
  username?: string;
  database?: string;
  extensions?: Array<string>;
  libraryPath?: string;
  runtimeDirectory?: string;
  resourceRoot?: string;
};

export type NativeResourceConfig = {
  resourceRoot?: string;
};

export type NativeCapabilities = {
  engine: string;
  processIsolated: boolean;
  multiRoot: boolean;
  reopenable: boolean;
  sameRootLogicalReopen: boolean;
  rootSwitchable: boolean;
  crashRestartable: boolean;
  independentSessions: boolean;
  maxClientSessions: number;
  protocolRaw: boolean;
  protocolStream: boolean;
  queryCancel: boolean;
  backupRestore: boolean;
  backupFormats: Array<string>;
  restoreFormats: Array<string>;
  simpleQuery: boolean;
  extensions: boolean;
  connectionString?: string;
  rawProtocolTransport: string;
};

export type NativeExtensionSizeReport = {
  name: string;
  fileCount: number;
  bytes: number;
};

export type NativePackageSizeReport = {
  packageBytes: number;
  runtimeBytes: number;
  templatePgdataBytes: number;
  staticRegistryBytes: number;
  selectedExtensionBytes: number;
  mobileStaticRegistryState?: string;
  mobileStaticRegistryRegistered?: Array<string>;
  mobileStaticRegistryPending?: Array<string>;
  nativeModuleStems?: Array<string>;
  extensions: Array<NativeExtensionSizeReport>;
};

export type NativeProcessMemoryReport = {
  source: string;
  residentBytes?: number;
  physicalFootprintBytes?: number;
  virtualBytes?: number;
  peakResidentBytes?: number;
  totalPssKb?: number;
  totalPrivateDirtyKb?: number;
  totalSharedDirtyKb?: number;
  nativeHeapAllocatedBytes?: number;
  nativeHeapSizeBytes?: number;
  runtimeTotalBytes?: number;
  runtimeFreeBytes?: number;
};

export type NativeEngineModeSupport = {
  engine: string;
  available: boolean;
  capabilities: NativeCapabilities;
  unavailableReason?: string;
};

export interface Spec extends TurboModule {
  supportedModes(): Promise<Array<NativeEngineModeSupport>>;
  packageSizeReport(config: NativeResourceConfig): Promise<NativePackageSizeReport | null>;
  processMemory(): Promise<NativeProcessMemoryReport>;
  open(config: NativeOpenConfig): Promise<number>;
  cancel(handle: number): Promise<void>;
  close(handle: number): Promise<void>;
  capabilities(handle: number): Promise<NativeCapabilities>;
}

export default TurboModuleRegistry.getEnforcing<Spec>('Oliphaunt');
