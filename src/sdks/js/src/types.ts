export type EngineMode = 'nativeDirect' | 'nativeBroker' | 'nativeServer';
export type DurabilityProfile = 'safe' | 'balanced' | 'fastDev';
export type RuntimeFootprintProfile = 'throughput' | 'balancedMobile' | 'smallMobile';
export type JavaScriptRuntime = 'node' | 'bun' | 'deno';
export type RawProtocolTransport =
  | 'node-addon'
  | 'bun-ffi'
  | 'deno-ffi'
  | 'broker-ipc'
  | 'server-wire';
export type BackupFormat = 'sql' | 'physicalArchive' | 'oliphauntArchive';
export type BrokerTransport = 'auto' | 'unix' | 'tcp';

export type PostgresStartupGUC =
  | string
  | {
      readonly name: string;
      readonly value: string;
    };

export type BinaryInput = ArrayBuffer | ArrayBufferView | Uint8Array | ReadonlyArray<number>;

export type OpenConfig = {
  engine?: EngineMode;
  root?: string;
  temporary?: boolean;
  durability?: DurabilityProfile;
  runtimeFootprint?: RuntimeFootprintProfile;
  startupGUCs?: ReadonlyArray<PostgresStartupGUC>;
  username?: string;
  database?: string;
  extensions?: ReadonlyArray<string>;
  libraryPath?: string;
  runtimeDirectory?: string;
  maxClientSessions?: number;
  brokerExecutable?: string;
  brokerMaxRoots?: number;
  brokerTransport?: BrokerTransport;
  serverExecutable?: string;
  serverPort?: number;
  serverToolDirectory?: string;
};

export type EngineCapabilities = {
  engine: EngineMode;
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
  backupFormats: BackupFormat[];
  restoreFormats: BackupFormat[];
  simpleQuery: boolean;
  extensions: boolean;
  connectionString?: string;
  rawProtocolTransport?: RawProtocolTransport;
};

export type EngineModeSupport = {
  engine: EngineMode;
  available: boolean;
  capabilities: EngineCapabilities;
  unavailableReason?: string;
};

export type BackupArtifact = {
  format: BackupFormat;
  bytes: Uint8Array;
};

export type RestoreOptions = {
  engine?: EngineMode;
  root: string;
  artifact: BackupArtifact;
  replaceExisting?: boolean;
  libraryPath?: string;
  brokerExecutable?: string;
};

export type BackgroundPreparationOptions = {
  cancelActiveWork?: boolean;
  checkpointWhenIdle?: boolean;
};

export type BackgroundPreparationResult = {
  cancelledActiveWork: boolean;
  checkpointed: boolean;
  skippedCheckpointReason?: 'activeWork' | 'transactionActive';
};

export type ProtocolChunkCallback = (chunk: Uint8Array) => void;

export type OliphauntTransaction = {
  execute(sql: string): Promise<Uint8Array>;
  query(
    sql: string,
    parameters?: ReadonlyArray<import('./query.js').QueryParam>,
  ): Promise<import('./query.js').QueryResult>;
  execProtocolRaw(input: BinaryInput): Promise<Uint8Array>;
  execProtocolStream(input: BinaryInput, onChunk: ProtocolChunkCallback): Promise<void>;
};

export type SupportedModesOptions = {
  libraryPath?: string;
  runtimeDirectory?: string;
  brokerExecutable?: string;
  brokerTransport?: BrokerTransport;
  serverExecutable?: string;
  serverToolDirectory?: string;
};

export type OliphauntClient = {
  supportedModes(options?: SupportedModesOptions): Promise<EngineModeSupport[]>;
  open(config?: OpenConfig): Promise<import('./client.js').OliphauntDatabase>;
  restore(options: RestoreOptions): Promise<string>;
};
