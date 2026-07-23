import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { normalizeOpenConfig, validateOptionalPathOverride, validateRootPath } from './config.js';
import { createDefaultNativeBinding } from './native/default.js';
import type { NativeBinding, NativeBindingOptions } from './native/types.js';
import { simpleQuery } from './protocol.js';
import {
  assertSuccessfulQueryResponse,
  extendedQuery,
  parseQueryResponse,
  toUint8Array,
  type QueryParam,
  type QueryResult,
} from './query.js';
import type {
  BackupArtifact,
  BackupFormat,
  BackgroundPreparationOptions,
  BackgroundPreparationResult,
  BinaryInput,
  EngineCapabilities,
  EngineMode,
  EngineModeSupport,
  JavaScriptRuntime,
  OliphauntClient,
  OliphauntTransaction,
  OpenConfig,
  ProtocolChunkCallback,
  RestoreOptions,
  SupportedModesOptions,
} from './types.js';
import {
  brokerModeSupport,
  createBrokerRuntimeBinding,
  restorePhysicalArchiveWithBroker,
} from './runtime/broker.js';
import { directRuntimeBinding, nativeDirectCapabilities } from './runtime/direct.js';
import { createServerRuntimeBinding, serverModeSupport } from './runtime/server.js';
import type { RuntimeBinding, RuntimeHandle } from './runtime/types.js';

export type NativeBindingFactory = (
  options?: NativeBindingOptions,
) => NativeBinding | Promise<NativeBinding>;

export { nativeDirectCapabilities } from './runtime/direct.js';

export class OliphauntDatabase {
  readonly #binding: RuntimeBinding;
  readonly #handle: RuntimeHandle;
  #closed = false;
  #activeTransaction = false;
  #activeOperations = 0;

  constructor(
    binding: RuntimeBinding,
    handle: RuntimeHandle,
    readonly root: string,
  ) {
    this.#binding = binding;
    this.#handle = handle;
  }

  get handle(): RuntimeHandle {
    return this.#handle;
  }

  async capabilities(): Promise<EngineCapabilities> {
    this.#assertOpen();
    return this.#binding.capabilities(this.#handle);
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
    this.#assertOpen();
    this.#assertNoActiveTransaction();
    const response = await this.#executeSimpleUnlocked(sql);
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
    this.#assertOpen();
    this.#assertNoActiveTransaction();
    return this.#execProtocolRawUnlocked(input);
  }

  async execProtocolStream(input: BinaryInput, onChunk: ProtocolChunkCallback): Promise<void> {
    this.#assertOpen();
    this.#assertNoActiveTransaction();
    await this.#execProtocolStreamUnlocked(input, onChunk);
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
      bytes: await this.#runNativeOperation(() => this.#binding.backup(this.#handle, format)),
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
      await this.#binding.cancel(this.#handle);
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
    await this.#binding.cancel(this.#handle);
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
    await this.#binding.detach(this.#handle);
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  async #executeSimpleUnlocked(sql: string): Promise<Uint8Array> {
    if (this.#binding.execSimpleQuery !== undefined) {
      return this.#runNativeOperation(() => this.#binding.execSimpleQuery?.(this.#handle, sql));
    }
    return this.#execProtocolRawUnlocked(simpleQuery(sql));
  }

  async #execProtocolRawUnlocked(input: BinaryInput): Promise<Uint8Array> {
    const requestBytes = toUint8Array(input);
    return this.#runNativeOperation(() =>
      this.#binding.execProtocolRaw(this.#handle, requestBytes),
    );
  }

  async #execProtocolStreamUnlocked(
    input: BinaryInput,
    onChunk: ProtocolChunkCallback,
  ): Promise<void> {
    const requestBytes = toUint8Array(input);
    if (this.#binding.protocolStream && this.#binding.execProtocolStream !== undefined) {
      await this.#runNativeVoidOperation(() =>
        this.#binding.execProtocolStream?.(this.#handle, requestBytes, onChunk),
      );
      return;
    }
    onChunk(await this.#execProtocolRawUnlocked(requestBytes));
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

  async #runNativeOperation<T>(body: () => T | undefined | Promise<T | undefined>): Promise<T> {
    this.#activeOperations += 1;
    try {
      const result = await body();
      if (result === undefined) {
        throw new Error('native oliphaunt runtime operation returned no result');
      }
      return result;
    } finally {
      this.#activeOperations -= 1;
    }
  }

  async #runNativeVoidOperation(body: () => void | Promise<void>): Promise<void> {
    this.#activeOperations += 1;
    try {
      await body();
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

export function createOliphauntClient(
  bindingFactory: NativeBindingFactory = createDefaultNativeBinding,
): OliphauntClient {
  const bindings = new Map<string, Promise<NativeBinding>>();
  const brokerBindings = new Map<string, RuntimeBinding>();
  const serverBinding = createServerRuntimeBinding();

  function bindingFor(options: NativeBindingOptions = {}): Promise<NativeBinding> {
    const key = options.libraryPath ?? '';
    const cached = bindings.get(key);
    if (cached !== undefined) {
      return cached;
    }
    const created = Promise.resolve()
      .then(() => bindingFactory(options))
      .catch((error) => {
        bindings.delete(key);
        throw error;
      });
    bindings.set(key, created);
    return created;
  }

  function brokerBindingFor(config: {
    brokerExecutable?: string;
    brokerMaxRoots?: number;
  }): RuntimeBinding {
    const key = `${config.brokerExecutable ?? ''}:${config.brokerMaxRoots ?? 1}`;
    const cached = brokerBindings.get(key);
    if (cached !== undefined) {
      return cached;
    }
    const created = createBrokerRuntimeBinding({
      executable: config.brokerExecutable,
      maxRoots: config.brokerMaxRoots,
    });
    brokerBindings.set(key, created);
    return created;
  }

  return {
    async supportedModes(options: SupportedModesOptions = {}): Promise<EngineModeSupport[]> {
      const support: EngineModeSupport[] = [];
      const libraryPath = validateOptionalPathOverride(options.libraryPath, 'libraryPath');
      try {
        const binding = await bindingFor({ libraryPath });
        const directCapabilities = nativeDirectCapabilities(await binding.capabilities(), binding);
        support.push({
          engine: 'nativeDirect',
          available: true,
          capabilities: directCapabilities,
        });
      } catch (error) {
        support.push({
          engine: 'nativeDirect',
          available: false,
          capabilities: baseCapabilitiesForMode('nativeDirect'),
          unavailableReason: `native liboliphaunt is unavailable: ${errorString(error)}`,
        });
      }

      const brokerExecutable = validateOptionalPathOverride(
        options.brokerExecutable,
        'brokerExecutable',
      );
      const runtimeDirectory = validateOptionalPathOverride(
        options.runtimeDirectory,
        'runtimeDirectory',
      );
      support.push(await brokerModeSupport({ brokerExecutable, libraryPath, runtimeDirectory }));
      const serverExecutable = validateOptionalPathOverride(
        options.serverExecutable,
        'serverExecutable',
      );
      const serverToolDirectory = validateOptionalPathOverride(
        options.serverToolDirectory,
        'serverToolDirectory',
      );
      support.push(await serverModeSupport({ serverExecutable, serverToolDirectory }));
      return support;
    },

    async open(config: OpenConfig = {}): Promise<OliphauntDatabase> {
      const root = await resolveOpenRoot(config);
      const normalized = normalizeOpenConfig(withDefaultEngine(config), root);
      let binding: RuntimeBinding;
      if (normalized.engine === 'nativeDirect') {
        binding = directRuntimeBinding(await bindingFor({ libraryPath: normalized.libraryPath }));
      } else if (normalized.engine === 'nativeBroker') {
        binding = brokerBindingFor({
          brokerExecutable: normalized.brokerExecutable,
          brokerMaxRoots: normalized.brokerMaxRoots,
        });
      } else {
        binding = serverBinding;
      }
      const handle = await binding.open(normalized);
      return new OliphauntDatabase(binding, handle, normalized.root);
    },

    async restore(options: RestoreOptions): Promise<string> {
      validateRootPath(options.root, 'restore root');
      const artifact = options.artifact;
      if (artifact.format !== 'physicalArchive') {
        throw new Error(
          `restore currently requires a physicalArchive artifact, got ${artifact.format}`,
        );
      }
      const engine = options.engine ?? defaultEngineForRuntime();
      if (engine === 'nativeDirect') {
        const libraryPath = validateOptionalPathOverride(options.libraryPath, 'libraryPath');
        const binding = await bindingFor({ libraryPath });
        await binding.restore({
          root: options.root,
          format: artifact.format,
          bytes: toUint8Array(artifact.bytes),
          replaceExisting: options.replaceExisting === true,
        });
        return options.root;
      }
      if (engine === 'nativeBroker') {
        const brokerExecutable = validateOptionalPathOverride(
          options.brokerExecutable,
          'brokerExecutable',
        );
        const libraryPath = validateOptionalPathOverride(options.libraryPath, 'libraryPath');
        return restorePhysicalArchiveWithBroker({
          root: options.root,
          bytes: toUint8Array(artifact.bytes),
          replaceExisting: options.replaceExisting,
          brokerExecutable,
          libraryPath,
        });
      }
      throw new Error('nativeServer restore is not supported by the TypeScript SDK');
    },
  };
}

export function defaultEngineForRuntime(runtime: JavaScriptRuntime = currentRuntime()): EngineMode {
  switch (runtime) {
    case 'node':
    case 'bun':
    case 'deno':
      return 'nativeDirect';
  }
}

function withDefaultEngine(config: OpenConfig): OpenConfig {
  if (config.engine !== undefined) {
    return config;
  }
  return { ...config, engine: defaultEngineForRuntime() };
}

function currentRuntime(): JavaScriptRuntime {
  if (
    typeof (globalThis as { Deno?: { version?: { deno?: string } } }).Deno?.version?.deno ===
    'string'
  ) {
    return 'deno';
  }
  if (typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined') {
    return 'bun';
  }
  return 'node';
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

function baseCapabilitiesForMode(engine: EngineMode): EngineCapabilities {
  switch (engine) {
    case 'nativeDirect':
      return {
        engine,
        processIsolated: false,
        multiRoot: false,
        reopenable: true,
        sameRootLogicalReopen: true,
        rootSwitchable: false,
        crashRestartable: false,
        independentSessions: false,
        maxClientSessions: 1,
        protocolRaw: true,
        protocolStream: true,
        queryCancel: true,
        backupRestore: true,
        backupFormats: ['physicalArchive'],
        restoreFormats: ['physicalArchive'],
        simpleQuery: true,
        extensions: true,
      };
    case 'nativeBroker':
      return {
        engine,
        processIsolated: true,
        multiRoot: false,
        reopenable: true,
        sameRootLogicalReopen: false,
        rootSwitchable: true,
        crashRestartable: true,
        independentSessions: false,
        maxClientSessions: 1,
        protocolRaw: true,
        protocolStream: true,
        queryCancel: true,
        backupRestore: true,
        backupFormats: ['physicalArchive'],
        restoreFormats: ['physicalArchive'],
        simpleQuery: true,
        extensions: true,
      };
    case 'nativeServer':
      return {
        engine,
        processIsolated: true,
        multiRoot: false,
        reopenable: true,
        sameRootLogicalReopen: false,
        rootSwitchable: true,
        crashRestartable: false,
        independentSessions: true,
        maxClientSessions: 32,
        protocolRaw: true,
        protocolStream: true,
        queryCancel: true,
        backupRestore: true,
        backupFormats: ['sql', 'physicalArchive'],
        restoreFormats: ['physicalArchive'],
        simpleQuery: true,
        extensions: true,
      };
  }
}

async function resolveOpenRoot(config: OpenConfig): Promise<string> {
  if (config.root !== undefined) {
    return config.root;
  }
  if (config.temporary === false) {
    throw new Error('database root is not configured; pass root or set temporary true');
  }
  return mkdtemp(join(tmpdir(), 'liboliphaunt-js-'));
}

function errorString(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
