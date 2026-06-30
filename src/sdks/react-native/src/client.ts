import {
  backupJsi,
  execProtocolRawJsi,
  execProtocolStreamJsi,
  jsiTransportSupportsProtocolStream,
  requireJsiRawProtocolTransport,
  resolveJsiRawProtocolTransport,
  restoreJsi,
  type JsiRawProtocolTransport,
} from './jsiTransport';
import { simpleQuery } from './protocol';
import {
  assertSuccessfulQueryResponse,
  extendedQuery,
  parseQueryResponse,
  type QueryParam,
  type QueryResult,
} from './query';
import { generatedExtensionBySqlName } from './generated/extensions';
import type {
  NativeCapabilities,
  NativeEngineModeSupport,
  NativeOpenConfig,
  NativePackageSizeReport,
  NativeProcessMemoryReport,
  NativeResourceConfig,
  Spec as NativeOliphauntModule,
} from './specs/NativeOliphaunt';

export type EngineMode = 'nativeDirect' | 'nativeBroker' | 'nativeServer';
export type DurabilityProfile = 'safe' | 'balanced' | 'fastDev';
export type RuntimeFootprintProfile = 'throughput' | 'balancedMobile' | 'smallMobile';
export type RawProtocolTransport = 'jsi-array-buffer';
export type BackupFormat = 'sql' | 'physicalArchive' | 'oliphauntArchive';
export type PostgresStartupGUC =
  | string
  | {
      readonly name: string;
      readonly value: string;
    };

export type BinaryInput = ArrayBuffer | ArrayBufferView | Uint8Array | ReadonlyArray<number>;

export type OpenConfig = {
  engine?: 'nativeDirect';
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
  resourceRoot?: string;
};

export type PackageSizeReportOptions = {
  resourceRoot?: string;
};

export type ExtensionSizeReport = {
  name: string;
  fileCount: number;
  bytes: number;
};

export type PackageSizeReport = {
  packageBytes: number;
  runtimeBytes: number;
  templatePgdataBytes: number;
  staticRegistryBytes: number;
  selectedExtensionBytes: number;
  mobileStaticRegistryState: string | null;
  mobileStaticRegistryRegistered: string[];
  mobileStaticRegistryPending: string[];
  nativeModuleStems: string[];
  runtimeFeatures: string[];
  extensions: ExtensionSizeReport[];
};

export type ProcessMemoryReport = {
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
  rawProtocolTransport: RawProtocolTransport;
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
  root: string;
  artifact: BackupArtifact;
  replaceExisting?: boolean;
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

export type OliphauntClient = {
  supportedModes(): Promise<EngineModeSupport[]>;
  packageSizeReport(options?: PackageSizeReportOptions): Promise<PackageSizeReport | null>;
  processMemory(): Promise<ProcessMemoryReport>;
  open(config?: OpenConfig): Promise<OliphauntDatabase>;
  restore(options: RestoreOptions): Promise<string>;
};

export type ProtocolChunkCallback = (chunk: Uint8Array) => void;

export type OliphauntTransaction = {
  execute(sql: string): Promise<Uint8Array>;
  query(sql: string, parameters?: ReadonlyArray<QueryParam>): Promise<QueryResult>;
  execProtocolRaw(input: BinaryInput): Promise<Uint8Array>;
  execProtocolStream(input: BinaryInput, onChunk: ProtocolChunkCallback): Promise<void>;
};

export class OliphauntDatabase {
  readonly #native: NativeOliphauntModule;
  readonly #handle: number;
  readonly #jsiTransport: JsiRawProtocolTransport;
  #closed = false;
  #activeTransaction = false;
  #activeOperations = 0;

  constructor(
    native: NativeOliphauntModule,
    handle: number,
    jsiTransport: JsiRawProtocolTransport,
  ) {
    this.#native = native;
    this.#handle = handle;
    this.#jsiTransport = jsiTransport;
  }

  get handle(): number {
    return this.#handle;
  }

  async capabilities(): Promise<EngineCapabilities> {
    this.#assertOpen();
    return normalizeCapabilities(await this.#native.capabilities(this.#handle), this.#jsiTransport);
  }

  async connectionString(): Promise<string | undefined> {
    return (await this.capabilities()).connectionString;
  }

  async supportsBackupFormat(format: BackupFormat): Promise<boolean> {
    return supportsBackupFormat(await this.capabilities(), format);
  }

  async supportsRestoreFormat(format: BackupFormat): Promise<boolean> {
    return supportsRestoreFormat(await this.capabilities(), format);
  }

  async execute(sql: string): Promise<Uint8Array> {
    const response = await this.execProtocolRaw(simpleQuery(sql));
    assertSuccessfulQueryResponse(response);
    return response;
  }

  async query(sql: string, parameters: ReadonlyArray<QueryParam> = []): Promise<QueryResult> {
    if (parameters.length === 0) {
      return parseQueryResponse(await this.execute(sql));
    }
    return parseQueryResponse(await this.execProtocolRaw(extendedQuery(sql, parameters)));
  }

  async execProtocolRaw(input: BinaryInput): Promise<Uint8Array> {
    this.#assertNoActiveTransaction();
    return this.#execProtocolRawUnlocked(input);
  }

  async #execProtocolRawUnlocked(input: BinaryInput): Promise<Uint8Array> {
    this.#assertOpen();
    const requestBytes = toUint8Array(input);
    return this.#runNativeOperation(() =>
      execProtocolRawJsi(this.#jsiTransport, this.#handle, requestBytes),
    );
  }

  async execProtocolStream(input: BinaryInput, onChunk: ProtocolChunkCallback): Promise<void> {
    this.#assertNoActiveTransaction();
    await this.#execProtocolStreamUnlocked(input, onChunk);
  }

  async #execProtocolStreamUnlocked(
    input: BinaryInput,
    onChunk: ProtocolChunkCallback,
  ): Promise<void> {
    this.#assertOpen();
    const requestBytes = toUint8Array(input);
    const streamed = await this.#runNativeOperation(() =>
      execProtocolStreamJsi(this.#jsiTransport, this.#handle, requestBytes, onChunk),
    );
    if (!streamed) {
      onChunk(await this.#execProtocolRawUnlocked(requestBytes));
    }
  }

  async backup(format: BackupFormat = 'physicalArchive'): Promise<BackupArtifact> {
    this.#assertOpen();
    this.#assertNoActiveTransaction();
    const capabilities = await this.capabilities();
    if (!supportsBackupFormat(capabilities, format)) {
      throw new Error(`${format} backup is not supported by ${capabilities.engine}`);
    }
    return {
      format,
      bytes: await this.#runNativeOperation(() =>
        backupJsi(this.#jsiTransport, this.#handle, format),
      ),
    };
  }

  async checkpoint(): Promise<void> {
    await this.execute('CHECKPOINT');
  }

  async prepareForBackground(
    options: BackgroundPreparationOptions = {},
  ): Promise<BackgroundPreparationResult> {
    this.#assertOpen();
    const hadActiveWork = this.#activeOperations > 0;
    const shouldCancel = options.cancelActiveWork !== false;
    const shouldCheckpoint = options.checkpointWhenIdle !== false;
    let cancelledActiveWork = false;
    if (shouldCancel && hadActiveWork) {
      await this.#native.cancel(this.#handle);
      cancelledActiveWork = true;
    }
    if (!shouldCheckpoint) {
      return { cancelledActiveWork, checkpointed: false };
    }
    if (this.#activeTransaction) {
      return {
        cancelledActiveWork,
        checkpointed: false,
        skippedCheckpointReason: 'transactionActive',
      };
    }
    if (hadActiveWork || this.#activeOperations > 0) {
      return {
        cancelledActiveWork,
        checkpointed: false,
        skippedCheckpointReason: 'activeWork',
      };
    }
    await this.checkpoint();
    return { cancelledActiveWork, checkpointed: true };
  }

  async resumeFromBackground(): Promise<void> {
    await this.execute('SELECT 1');
  }

  async cancel(): Promise<void> {
    this.#assertOpen();
    await this.#native.cancel(this.#handle);
  }

  async transaction<T>(body: (transaction: OliphauntTransaction) => Promise<T> | T): Promise<T> {
    this.#assertOpen();
    if (this.#activeTransaction) {
      throw new Error(transactionPinnedMessage);
    }
    this.#activeTransaction = true;
    const transaction = new OliphauntTransactionHandle(
      (input) => this.#execProtocolRawUnlocked(input),
      (input, onChunk) => this.#execProtocolStreamUnlocked(input, onChunk),
    );
    try {
      await transaction.execute('BEGIN');
      const result = await body(transaction);
      await transaction.execute('COMMIT');
      transaction.deactivate();
      return result;
    } catch (error) {
      try {
        await transaction.execute('ROLLBACK');
      } catch {
        // Preserve the original transaction failure; rollback is best-effort cleanup.
      }
      transaction.deactivate();
      throw error;
    } finally {
      this.#activeTransaction = false;
    }
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    await this.#native.close(this.#handle);
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new Error('Oliphaunt database is closed');
    }
  }

  #assertNoActiveTransaction(): void {
    if (this.#activeTransaction) {
      throw new Error(transactionPinnedMessage);
    }
  }

  async #runNativeOperation<T>(body: () => Promise<T>): Promise<T> {
    this.#activeOperations += 1;
    try {
      return await body();
    } finally {
      this.#activeOperations -= 1;
    }
  }
}

class OliphauntTransactionHandle implements OliphauntTransaction {
  readonly #execRaw: (input: BinaryInput) => Promise<Uint8Array>;
  readonly #execStream: (input: BinaryInput, onChunk: ProtocolChunkCallback) => Promise<void>;
  #active = true;

  constructor(
    execRaw: (input: BinaryInput) => Promise<Uint8Array>,
    execStream: (input: BinaryInput, onChunk: ProtocolChunkCallback) => Promise<void>,
  ) {
    this.#execRaw = execRaw;
    this.#execStream = execStream;
  }

  async execute(sql: string): Promise<Uint8Array> {
    const response = await this.execProtocolRaw(simpleQuery(sql));
    assertSuccessfulQueryResponse(response);
    return response;
  }

  async query(sql: string, parameters: ReadonlyArray<QueryParam> = []): Promise<QueryResult> {
    if (parameters.length === 0) {
      return parseQueryResponse(await this.execute(sql));
    }
    return parseQueryResponse(await this.execProtocolRaw(extendedQuery(sql, parameters)));
  }

  async execProtocolRaw(input: BinaryInput): Promise<Uint8Array> {
    this.#assertActive();
    return this.#execRaw(input);
  }

  async execProtocolStream(input: BinaryInput, onChunk: ProtocolChunkCallback): Promise<void> {
    this.#assertActive();
    await this.#execStream(input, onChunk);
  }

  deactivate(): void {
    this.#active = false;
  }

  #assertActive(): void {
    if (!this.#active) {
      throw new Error('transaction is no longer active');
    }
  }
}

const transactionPinnedMessage = 'physical session is pinned; use the active OliphauntTransaction';

export function createOliphauntClient(native: NativeOliphauntModule): OliphauntClient {
  return {
    async supportedModes(): Promise<EngineModeSupport[]> {
      const jsiTransport = resolveJsiRawProtocolTransport();
      return (await native.supportedModes()).map((support) =>
        normalizeEngineModeSupport(support, jsiTransport),
      );
    },
    async packageSizeReport(
      options: PackageSizeReportOptions = {},
    ): Promise<PackageSizeReport | null> {
      const report = await native.packageSizeReport(normalizeResourceConfig(options));
      return report == null ? null : normalizePackageSizeReport(report);
    },
    async processMemory(): Promise<ProcessMemoryReport> {
      return normalizeProcessMemoryReport(await native.processMemory());
    },
    async open(config: OpenConfig = {}): Promise<OliphauntDatabase> {
      const jsiTransport = requireJsiRawProtocolTransport();
      const nativeConfig = normalizeOpenConfig(config);
      const handle = await native.open(nativeConfig);
      return new OliphauntDatabase(native, handle, jsiTransport);
    },
    async restore(options: RestoreOptions): Promise<string> {
      validateRootPath(options.root, 'restore root');
      const artifact = options.artifact;
      if (artifact.format !== 'physicalArchive') {
        throw new Error(
          `restore currently requires a physicalArchive artifact, got ${artifact.format}`,
        );
      }
      const libraryPath = validateOptionalPathOverride(options.libraryPath, 'libraryPath');
      return restoreJsi(
        requireJsiRawProtocolTransport(),
        options.root,
        artifact.format,
        toUint8Array(artifact.bytes),
        options.replaceExisting === true,
        libraryPath ?? null,
      );
    },
  };
}

export function supportsBackupFormat(
  capabilities: EngineCapabilities,
  format: BackupFormat,
): boolean {
  return capabilities.backupRestore && capabilities.backupFormats.includes(format);
}

export function supportsRestoreFormat(
  capabilities: EngineCapabilities,
  format: BackupFormat,
): boolean {
  return capabilities.backupRestore && capabilities.restoreFormats.includes(format);
}

function normalizeEngineModeSupport(
  native: NativeEngineModeSupport,
  jsiTransport: JsiRawProtocolTransport | null,
): EngineModeSupport {
  const transportAvailable = jsiTransport != null;
  return {
    engine: parseEngine(native.engine),
    available: native.available && transportAvailable,
    capabilities: normalizeCapabilities(native.capabilities, jsiTransport),
    unavailableReason: transportAvailable
      ? native.unavailableReason
      : 'React Native New Architecture JSI ArrayBuffer transport is not installed',
  };
}

function normalizeOpenConfig(config: OpenConfig): NativeOpenConfig {
  if (config.root !== undefined && config.temporary === true) {
    throw new Error('root and temporary are mutually exclusive');
  }
  validateRootPath(config.root, 'database root');
  validateStartupIdentity(config.username, 'username');
  validateStartupIdentity(config.database, 'database');
  const startupGUCs = config.startupGUCs ? validateStartupGUCs(config.startupGUCs) : undefined;
  const runtimeFootprint = normalizeRuntimeFootprint(config.runtimeFootprint ?? 'balancedMobile');
  const libraryPath = validateOptionalPathOverride(config.libraryPath, 'libraryPath');
  const runtimeDirectory = validateOptionalPathOverride(
    config.runtimeDirectory,
    'runtimeDirectory',
  );
  const resourceRoot = validateOptionalPathOverride(config.resourceRoot, 'resourceRoot');
  return {
    engine: normalizeOpenEngine(config.engine),
    root: config.root,
    temporary: config.temporary,
    durability: config.durability ?? 'balanced',
    runtimeFootprint,
    startupGUCs,
    username: config.username,
    database: config.database,
    extensions: config.extensions ? validateExtensionIds(config.extensions) : undefined,
    libraryPath,
    runtimeDirectory,
    resourceRoot,
  };
}

function normalizeOpenEngine(engine: unknown): 'nativeDirect' {
  if (engine === undefined || engine === null || engine === 'nativeDirect') {
    return 'nativeDirect';
  }
  if (engine === 'nativeBroker' || engine === 'nativeServer') {
    throw new Error(
      `React Native open currently supports nativeDirect, got ${engine}; use supportedModes() to inspect broker/server availability`,
    );
  }
  throw new Error(`unsupported engine mode ${String(engine)}`);
}

function normalizeResourceConfig(options: PackageSizeReportOptions): NativeResourceConfig {
  return {
    resourceRoot: validateOptionalPathOverride(options.resourceRoot, 'resourceRoot'),
  };
}

function normalizeProcessMemoryReport(native: NativeProcessMemoryReport): ProcessMemoryReport {
  const source =
    typeof native.source === 'string' && native.source.trim().length > 0
      ? native.source
      : 'unknown';
  return compactUndefined({
    source,
    residentBytes: finiteNonNegative(native.residentBytes),
    physicalFootprintBytes: finiteNonNegative(native.physicalFootprintBytes),
    virtualBytes: finiteNonNegative(native.virtualBytes),
    peakResidentBytes: finiteNonNegative(native.peakResidentBytes),
    totalPssKb: finiteNonNegative(native.totalPssKb),
    totalPrivateDirtyKb: finiteNonNegative(native.totalPrivateDirtyKb),
    totalSharedDirtyKb: finiteNonNegative(native.totalSharedDirtyKb),
    nativeHeapAllocatedBytes: finiteNonNegative(native.nativeHeapAllocatedBytes),
    nativeHeapSizeBytes: finiteNonNegative(native.nativeHeapSizeBytes),
    runtimeTotalBytes: finiteNonNegative(native.runtimeTotalBytes),
    runtimeFreeBytes: finiteNonNegative(native.runtimeFreeBytes),
  });
}

function finiteNonNegative(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function compactUndefined<T extends Record<string, unknown>>(value: T): T {
  for (const key of Object.keys(value)) {
    if (value[key] === undefined) {
      delete value[key];
    }
  }
  return value;
}

function validateRootPath(value: string | undefined, label: string): void {
  if (value === undefined) {
    return;
  }
  if (value.trim().length === 0) {
    throw new Error(rootPathMessage(label, 'empty'));
  }
  if (value.includes('\0')) {
    throw new Error(rootPathMessage(label, 'nul'));
  }
}

function normalizeRuntimeFootprint(profile: RuntimeFootprintProfile): RuntimeFootprintProfile {
  if (profile === 'throughput' || profile === 'balancedMobile' || profile === 'smallMobile') {
    return profile;
  }
  throw new Error(`unknown liboliphaunt runtime footprint profile '${profile}'`);
}

function rootPathMessage(label: string, reason: 'empty' | 'nul'): string {
  switch (`${label}:${reason}`) {
    case 'database root:empty':
      return 'database root must not be empty';
    case 'database root:nul':
      return 'database root must not contain NUL bytes';
    case 'restore root:empty':
      return 'restore root must not be empty';
    case 'restore root:nul':
      return 'restore root must not contain NUL bytes';
    default:
      return reason === 'empty'
        ? `${label} must not be empty`
        : `${label} must not contain NUL bytes`;
  }
}

function validateStartupIdentity(value: string | undefined, label: string): void {
  if (value === undefined) {
    return;
  }
  if (value.trim().length === 0) {
    throw new Error(`${label} must not be empty`);
  }
  if (value.includes('\0')) {
    throw new Error(`${label} must not contain NUL bytes`);
  }
}

function validateStartupGUCs(gucs: ReadonlyArray<PostgresStartupGUC>): string[] {
  return gucs.map((guc) => {
    const [name, value] =
      typeof guc === 'string' ? splitStartupGUCAssignment(guc) : [guc.name, guc.value];
    const trimmedName = name.trim();
    if (trimmedName.length === 0) {
      throw new Error('PostgreSQL startup GUC name must not be empty');
    }
    if (trimmedName.includes('\0') || value.includes('\0')) {
      throw new Error('PostgreSQL startup GUC must not contain NUL bytes');
    }
    if (!/^[A-Za-z0-9_.]+$/.test(trimmedName)) {
      throw new Error(
        `PostgreSQL startup GUC name '${name}' must contain only ASCII letters, digits, '_' or '.'`,
      );
    }
    if (value.trim().length === 0) {
      throw new Error(`PostgreSQL startup GUC '${name}' value must not be empty`);
    }
    return `${trimmedName}=${value}`;
  });
}

function splitStartupGUCAssignment(assignment: string): [string, string] {
  const index = assignment.indexOf('=');
  if (index < 0) {
    throw new Error('PostgreSQL startup GUC string must use name=value');
  }
  return [assignment.slice(0, index), assignment.slice(index + 1)];
}

function validateOptionalPathOverride(
  value: string | undefined,
  label: string,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value.trim().length === 0) {
    throw new Error(pathOverrideMessage(label, 'empty'));
  }
  if (value.includes('\0')) {
    throw new Error(pathOverrideMessage(label, 'nul'));
  }
  return value;
}

function pathOverrideMessage(label: string, reason: 'empty' | 'nul'): string {
  switch (`${label}:${reason}`) {
    case 'libraryPath:empty':
      return 'libraryPath must not be empty';
    case 'libraryPath:nul':
      return 'libraryPath must not contain NUL bytes';
    case 'runtimeDirectory:empty':
      return 'runtimeDirectory must not be empty';
    case 'runtimeDirectory:nul':
      return 'runtimeDirectory must not contain NUL bytes';
    case 'resourceRoot:empty':
      return 'resourceRoot must not be empty';
    case 'resourceRoot:nul':
      return 'resourceRoot must not contain NUL bytes';
    default:
      return reason === 'empty'
        ? `${label} must not be empty`
        : `${label} must not contain NUL bytes`;
  }
}

function validateExtensionIds(extensions: ReadonlyArray<string>): string[] {
  const normalized: string[] = [];
  for (const extension of extensions) {
    const trimmed = extension.trim();
    if (trimmed.length === 0) {
      continue;
    }
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(trimmed)) {
      throw new Error(
        `React Native Oliphaunt extension id '${trimmed}' must contain 1 to 128 ASCII letters, digits, '.', '_' or '-'`,
      );
    }
    if (generatedExtensionBySqlName(trimmed) === undefined) {
      throw new Error(`unknown React Native Oliphaunt extension id '${trimmed}'`);
    }
    normalized.push(trimmed);
  }
  return normalized;
}

function normalizePackageSizeReport(native: NativePackageSizeReport): PackageSizeReport {
  return {
    packageBytes: native.packageBytes,
    runtimeBytes: native.runtimeBytes,
    templatePgdataBytes: native.templatePgdataBytes,
    staticRegistryBytes: native.staticRegistryBytes,
    selectedExtensionBytes: native.selectedExtensionBytes,
    mobileStaticRegistryState: native.mobileStaticRegistryState ?? null,
    mobileStaticRegistryRegistered: [...(native.mobileStaticRegistryRegistered ?? [])],
    mobileStaticRegistryPending: [...(native.mobileStaticRegistryPending ?? [])],
    nativeModuleStems: [...(native.nativeModuleStems ?? [])],
    runtimeFeatures: [...(native.runtimeFeatures ?? [])],
    extensions: native.extensions.map((extension) => ({
      name: extension.name,
      fileCount: extension.fileCount,
      bytes: extension.bytes,
    })),
  };
}

function normalizeCapabilities(
  native: NativeCapabilities,
  jsiTransport: JsiRawProtocolTransport | null = resolveJsiRawProtocolTransport(),
): EngineCapabilities {
  const jsiAvailable = jsiTransport != null;
  return {
    engine: parseEngine(native.engine),
    processIsolated: native.processIsolated,
    multiRoot: native.multiRoot,
    reopenable: native.reopenable,
    sameRootLogicalReopen: native.sameRootLogicalReopen,
    rootSwitchable: native.rootSwitchable,
    crashRestartable: native.crashRestartable,
    independentSessions: native.independentSessions,
    maxClientSessions: native.maxClientSessions,
    protocolRaw: native.protocolRaw && jsiAvailable,
    protocolStream: native.protocolStream && jsiTransportSupportsProtocolStream(jsiTransport),
    queryCancel: native.queryCancel,
    backupRestore: native.backupRestore && jsiAvailable,
    backupFormats: jsiAvailable ? native.backupFormats.map(parseBackupFormat) : [],
    restoreFormats: jsiAvailable ? native.restoreFormats.map(parseBackupFormat) : [],
    simpleQuery: native.simpleQuery,
    extensions: native.extensions,
    connectionString: native.connectionString,
    rawProtocolTransport: 'jsi-array-buffer',
  };
}

function parseBackupFormat(format: string): BackupFormat {
  switch (format) {
    case 'sql':
    case 'physicalArchive':
    case 'oliphauntArchive':
      return format;
    default:
      throw new Error(`unknown backup format '${format}'`);
  }
}

function parseEngine(engine: string): EngineMode {
  switch (engine) {
    case 'nativeDirect':
    case 'nativeBroker':
    case 'nativeServer':
      return engine;
    default:
      throw new Error(`unknown native engine '${engine}'`);
  }
}

function toUint8Array(input: BinaryInput): Uint8Array {
  if (input instanceof Uint8Array) {
    return input;
  }
  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  if (input instanceof ArrayBuffer) {
    return new Uint8Array(input);
  }
  return Uint8Array.from(input);
}
