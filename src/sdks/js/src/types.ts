export type EngineMode = 'nativeDirect' | 'nativeBroker' | 'nativeServer';
export type DurabilityProfile = 'safe' | 'balanced' | 'fastDev';
export type RuntimeFootprintProfile = 'throughput' | 'balancedMobile' | 'smallMobile';
export type JavaScriptRuntime = 'node' | 'bun' | 'deno';
export type RawProtocolTransport = 'node-addon' | 'deno-ffi' | 'broker-ipc' | 'server-wire';
export type BackupFormat = 'sql' | 'physicalArchive' | 'oliphauntArchive';
export type RestoreDestinationPolicy = 'failIfExists' | 'replaceExisting';
export type BrokerTransport = 'auto' | 'unix' | 'tcp';

export type DatabaseStorage =
  | { readonly kind: 'temporaryDirectory' }
  | { readonly kind: 'directory'; readonly path: string };

export type PostgresStartupGUC =
  | string
  | {
      readonly name: string;
      readonly value: string;
    };

export type BinaryInput = ArrayBuffer | ArrayBufferView | Uint8Array | ReadonlyArray<number>;

export type OpenConfig = {
  engine?: EngineMode;
  storage?: DatabaseStorage;
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
  brokerMaxInstances?: number;
  brokerTransport?: BrokerTransport;
  serverExecutable?: string;
  serverPort?: number;
  serverToolDirectory?: string;
};

export type EngineCapabilities = {
  engine: EngineMode;
  processIsolated: boolean;
  multipleInstances: boolean;
  sameInstanceLogicalReopen: boolean;
  instanceSwitchable: boolean;
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
  destination: string;
  artifact: BackupArtifact;
  destinationPolicy?: RestoreDestinationPolicy;
  libraryPath?: string;
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

export type OliphauntDatabase = {
  capabilities(): Promise<EngineCapabilities>;
  connectionString(): Promise<string | undefined>;
  supportsBackupFormat(format: BackupFormat): Promise<boolean>;
  supportsRestoreFormat(format: BackupFormat): Promise<boolean>;
  execute(sql: string): Promise<Uint8Array>;
  query(
    sql: string,
    parameters?: ReadonlyArray<import('./query.js').QueryParam>,
  ): Promise<import('./query.js').QueryResult>;
  execProtocolRaw(input: BinaryInput): Promise<Uint8Array>;
  execProtocolStream(input: BinaryInput, onChunk: ProtocolChunkCallback): Promise<void>;
  backup(format?: BackupFormat): Promise<BackupArtifact>;
  checkpoint(): Promise<void>;
  prepareForBackground(
    options?: BackgroundPreparationOptions,
  ): Promise<BackgroundPreparationResult>;
  resumeFromBackground(): Promise<void>;
  cancel(): Promise<void>;
  transaction<T>(body: (transaction: OliphauntTransaction) => Promise<T> | T): Promise<T>;
  close(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
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
  open(config?: OpenConfig): Promise<OliphauntDatabase>;
  restore(options: RestoreOptions): Promise<string>;
};
