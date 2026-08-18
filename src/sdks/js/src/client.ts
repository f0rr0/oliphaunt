import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  normalizeOpenConfig,
  validateDirectoryPath,
  validateOptionalPathOverride,
} from './config.js';
import { createDefaultNativeBinding } from './native/default.js';
import type { NativeBinding, NativeBindingOptions } from './native/types.js';
import { simpleQuery } from './protocol.js';
import {
  assertSuccessfulQueryResponse,
  extendedQuery,
  parseQueryResponse,
  type QueryParam,
  type QueryResult,
  toUint8Array,
} from './query.js';
import { brokerModeSupport, createBrokerRuntimeBinding } from './runtime/broker.js';
import { directRuntimeBinding, nativeDirectCapabilities } from './runtime/direct.js';
import { createServerRuntimeBinding, serverModeSupport } from './runtime/server.js';
import type { RuntimeBinding, RuntimeHandle } from './runtime/types.js';
import type {
  BackgroundPreparationOptions,
  BackgroundPreparationResult,
  BackupArtifact,
  BackupFormat,
  BinaryInput,
  DatabaseStorage,
  EngineCapabilities,
  EngineMode,
  EngineModeSupport,
  JavaScriptRuntime,
  OliphauntClient,
  OliphauntDatabase,
  OliphauntTransaction,
  OpenConfig,
  ProtocolChunkCallback,
  RestoreDestinationPolicy,
  RestoreOptions,
  SupportedModesOptions,
} from './types.js';

export type NativeBindingFactory = (
  options?: NativeBindingOptions,
) => NativeBinding | Promise<NativeBinding>;

export { nativeDirectCapabilities } from './runtime/direct.js';

class OliphauntDatabaseImpl implements OliphauntDatabase {
  readonly #binding: RuntimeBinding;
  readonly #handle: RuntimeHandle;
  readonly #releaseOwnership?: () => void;
  #closed = false;
  #closing = false;
  #closeAttempt?: Promise<void>;
  #lifecycleOperations = 0;
  readonly #lifecycleIdleWaiters = new Set<() => void>();
  #activeTransaction = false;
  #activeOperations = 0;

  constructor(binding: RuntimeBinding, handle: RuntimeHandle, releaseOwnership?: () => void) {
    this.#binding = binding;
    this.#handle = handle;
    this.#releaseOwnership = releaseOwnership;
  }

  async capabilities(): Promise<EngineCapabilities> {
    return this.#withLifecycleOperation(() => this.#binding.capabilities(this.#handle));
  }

  async connectionString(): Promise<string | undefined> {
    return this.#withLifecycleOperation(
      async () => (await this.#binding.capabilities(this.#handle)).connectionString,
    );
  }

  async supportsBackupFormat(format: BackupFormat): Promise<boolean> {
    return this.#withLifecycleOperation(async () =>
      supportsBackupFormat(await this.#binding.capabilities(this.#handle), format),
    );
  }

  async supportsRestoreFormat(format: BackupFormat): Promise<boolean> {
    return this.#withLifecycleOperation(async () =>
      supportsRestoreFormat(await this.#binding.capabilities(this.#handle), format),
    );
  }

  async execute(sql: string): Promise<Uint8Array> {
    return this.#withLifecycleOperation(async () => {
      this.#assertNoActiveTransaction();
      const response = await this.#executeSimpleUnlocked(sql);
      assertSuccessfulQueryResponse(response);
      return response;
    });
  }

  async query(sql: string, parameters: ReadonlyArray<QueryParam> = []): Promise<QueryResult> {
    return this.#withLifecycleOperation(async () => {
      this.#assertNoActiveTransaction();
      if (parameters.length === 0) {
        const response = await this.#executeSimpleUnlocked(sql);
        assertSuccessfulQueryResponse(response);
        return parseQueryResponse(response);
      }
      return parseQueryResponse(
        await this.#execProtocolRawUnlocked(extendedQuery(sql, parameters)),
      );
    });
  }

  async execProtocolRaw(input: BinaryInput): Promise<Uint8Array> {
    return this.#withLifecycleOperation(() => {
      this.#assertNoActiveTransaction();
      return this.#execProtocolRawUnlocked(input);
    });
  }

  async execProtocolStream(input: BinaryInput, onChunk: ProtocolChunkCallback): Promise<void> {
    await this.#withLifecycleOperation(() => {
      this.#assertNoActiveTransaction();
      return this.#execProtocolStreamUnlocked(input, onChunk);
    });
  }

  async backup(format: BackupFormat = 'physicalArchive'): Promise<BackupArtifact> {
    return this.#withLifecycleOperation(async () => {
      this.#assertNoActiveTransaction();
      const capabilities = await this.#binding.capabilities(this.#handle);
      if (!supportsBackupFormat(capabilities, format)) {
        throw new Error(`${format} backup is not supported by ${capabilities.engine}`);
      }
      return {
        format,
        bytes: await this.#runNativeOperation(() => this.#binding.backup(this.#handle, format)),
      };
    });
  }

  async checkpoint(): Promise<void> {
    await this.#withLifecycleOperation(async () => {
      this.#assertNoActiveTransaction();
      assertSuccessfulQueryResponse(await this.#executeSimpleUnlocked('CHECKPOINT'));
    });
  }

  async prepareForBackground(
    options: BackgroundPreparationOptions = {},
  ): Promise<BackgroundPreparationResult> {
    return this.#withLifecycleOperation(async () => {
      const hadActiveWork = this.#activeOperations > 0;
      const shouldCancel = options.cancelActiveWork !== false;
      const shouldCheckpoint = options.checkpointWhenIdle !== false;
      let cancelledActiveWork = false;

      if (shouldCancel && hadActiveWork) {
        await this.#runNativeVoidOperation(() => this.#binding.cancel(this.#handle));
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
      assertSuccessfulQueryResponse(await this.#executeSimpleUnlocked('CHECKPOINT'));
      return { cancelledActiveWork, checkpointed: true };
    });
  }

  async resumeFromBackground(): Promise<void> {
    await this.#withLifecycleOperation(async () => {
      assertSuccessfulQueryResponse(await this.#executeSimpleUnlocked('SELECT 1'));
    });
  }

  async cancel(): Promise<void> {
    await this.#withLifecycleOperation(() =>
      this.#runNativeVoidOperation(() => this.#binding.cancel(this.#handle)),
    );
  }

  async transaction<T>(body: (transaction: OliphauntTransaction) => Promise<T> | T): Promise<T> {
    return this.#withLifecycleOperation(async () => {
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
    });
  }

  close(): Promise<void> {
    if (this.#closed) {
      return Promise.resolve();
    }
    if (this.#closeAttempt !== undefined) {
      return this.#closeAttempt;
    }
    if (this.#activeTransaction) {
      return Promise.reject(new Error('cannot close Oliphaunt while a transaction is active'));
    }

    this.#closing = true;
    const attempt = this.#waitForLifecycleIdle()
      .then(() => this.#binding.detach(this.#handle))
      .then(() => {
        this.#closing = false;
        this.#closed = true;
        this.#releaseOwnership?.();
      })
      .catch((error: unknown) => {
        this.#closing = false;
        throw error;
      })
      .finally(() => {
        if (this.#closeAttempt === attempt) {
          this.#closeAttempt = undefined;
        }
      });
    this.#closeAttempt = attempt;
    return attempt;
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
    if (this.#closing) {
      throw new Error('Oliphaunt database is closing');
    }
  }

  #assertNoActiveTransaction(): void {
    if (this.#activeTransaction) {
      throw new Error(transactionPinnedMessage);
    }
  }

  async #withLifecycleOperation<T>(body: () => T | Promise<T>): Promise<T> {
    this.#assertOpen();
    this.#lifecycleOperations += 1;
    try {
      return await body();
    } finally {
      this.#lifecycleOperations -= 1;
      if (this.#lifecycleOperations === 0) {
        for (const resolve of this.#lifecycleIdleWaiters) {
          resolve();
        }
        this.#lifecycleIdleWaiters.clear();
      }
    }
  }

  #waitForLifecycleIdle(): Promise<void> {
    if (this.#lifecycleOperations === 0) {
      return Promise.resolve();
    }
    return new Promise((resolve) => this.#lifecycleIdleWaiters.add(resolve));
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
  const directResident = {
    temporaryDirectory: undefined as string | undefined,
    activeOwner: undefined as symbol | undefined,
    openQueue: Promise.resolve() as Promise<void>,
  };

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
    brokerMaxInstances?: number;
  }): RuntimeBinding {
    const key = `${config.brokerExecutable ?? ''}:${config.brokerMaxInstances ?? 1}`;
    const cached = brokerBindings.get(key);
    if (cached !== undefined) {
      return cached;
    }
    const created = createBrokerRuntimeBinding({
      executable: config.brokerExecutable,
      maxInstances: config.brokerMaxInstances,
    });
    brokerBindings.set(key, created);
    return created;
  }

  function serializeDirectOpen<T>(body: () => Promise<T>): Promise<T> {
    const result = directResident.openQueue.then(body, body);
    directResident.openQueue = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  async function openDatabase(effectiveConfig: OpenConfig): Promise<OliphauntDatabase> {
    const nativeDirect = effectiveConfig.engine === 'nativeDirect';
    if (nativeDirect && directResident.activeOwner !== undefined) {
      throw new Error('native direct already has an active process-wide instance');
    }

    const reusableTemporaryDirectory = nativeDirect ? directResident.temporaryDirectory : undefined;
    const resolvedStorage = await materializeStorage(
      effectiveConfig.storage,
      reusableTemporaryDirectory,
    );
    let runtimeOpenAttempted = false;
    try {
      const normalized = normalizeOpenConfig(effectiveConfig, resolvedStorage);
      let binding: RuntimeBinding;
      if (normalized.engine === 'nativeDirect') {
        binding = directRuntimeBinding(await bindingFor({ libraryPath: normalized.libraryPath }));
      } else if (normalized.engine === 'nativeBroker') {
        binding = brokerBindingFor({
          brokerExecutable: normalized.brokerExecutable,
          brokerMaxInstances: normalized.brokerMaxInstances,
        });
      } else {
        binding = serverBinding;
      }

      runtimeOpenAttempted = true;
      const handle = await binding.open(normalized);
      if (!nativeDirect) {
        return new OliphauntDatabaseImpl(binding, handle);
      }

      if (resolvedStorage.temporaryDirectory) {
        directResident.temporaryDirectory ??= resolvedStorage.instanceDirectory;
      }
      const owner = Symbol('native-direct-owner');
      directResident.activeOwner = owner;
      return new OliphauntDatabaseImpl(binding, handle, () => {
        if (directResident.activeOwner === owner) {
          directResident.activeOwner = undefined;
        }
      });
    } catch (error) {
      if (resolvedStorage.createdTemporaryDirectory) {
        if (nativeDirect && runtimeOpenAttempted) {
          // A native adapter can surface an error after liboliphaunt has claimed
          // its process-resident PGDATA. Retain the candidate for a coherent
          // retry, but do not publish it before the native open is entered.
          directResident.temporaryDirectory ??= resolvedStorage.instanceDirectory;
        } else if (!runtimeOpenAttempted) {
          await removeDirectory(resolvedStorage.instanceDirectory);
        }
      }
      throw error;
    }
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
      const effectiveConfig = withDefaultEngine(config);
      return effectiveConfig.engine === 'nativeDirect'
        ? serializeDirectOpen(() => openDatabase(effectiveConfig))
        : openDatabase(effectiveConfig);
    },

    async restore(options: RestoreOptions): Promise<string> {
      validateDirectoryPath(options.destination, 'restore destination');
      const destinationPolicy = validateRestoreDestinationPolicy(options.destinationPolicy);
      const replaceExisting = destinationPolicy === 'replaceExisting';
      const artifact = options.artifact;
      if (artifact.format !== 'physicalArchive') {
        throw new Error(
          `restore currently requires a physicalArchive artifact, got ${artifact.format}`,
        );
      }
      const libraryPath = validateOptionalPathOverride(options.libraryPath, 'libraryPath');
      const binding = await bindingFor({ libraryPath });
      await binding.restore({
        destination: options.destination,
        format: artifact.format,
        bytes: toUint8Array(artifact.bytes),
        replaceExisting,
      });
      return options.destination;
    },
  };
}

function validateRestoreDestinationPolicy(
  policy: RestoreDestinationPolicy | undefined,
): RestoreDestinationPolicy {
  const resolved = policy ?? 'failIfExists';
  if (resolved !== 'failIfExists' && resolved !== 'replaceExisting') {
    throw new Error(`unknown restore destination policy '${String(resolved)}'`);
  }
  return resolved;
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
        multipleInstances: false,
        sameInstanceLogicalReopen: true,
        instanceSwitchable: false,
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
        multipleInstances: false,
        sameInstanceLogicalReopen: false,
        instanceSwitchable: true,
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
        multipleInstances: false,
        sameInstanceLogicalReopen: false,
        instanceSwitchable: true,
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

async function materializeStorage(
  storage: DatabaseStorage | undefined,
  reusableTemporaryDirectory?: string,
): Promise<{
  instanceDirectory: string;
  temporaryDirectory: boolean;
  createdTemporaryDirectory: boolean;
}> {
  if (storage === undefined || storage.kind === 'temporaryDirectory') {
    if (reusableTemporaryDirectory !== undefined) {
      return {
        instanceDirectory: reusableTemporaryDirectory,
        temporaryDirectory: true,
        createdTemporaryDirectory: false,
      };
    }
    return {
      instanceDirectory: await mkdtemp(join(tmpdir(), 'liboliphaunt-js-')),
      temporaryDirectory: true,
      createdTemporaryDirectory: true,
    };
  }
  if (storage.kind === 'directory') {
    return {
      instanceDirectory: storage.path,
      temporaryDirectory: false,
      createdTemporaryDirectory: false,
    };
  }
  throw new Error(
    `unknown native database storage kind '${String((storage as { kind?: unknown }).kind)}'`,
  );
}

async function removeDirectory(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true }).catch(() => {});
}

function errorString(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
