import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { normalizeOpenConfig, validateDirectoryPath } from './config.js';
import { createDefaultNativeBinding } from './native/default.js';
import type { NativeBinding, NativeBindingOptions } from './native/types.js';
import { simpleQuery } from './protocol.js';
import {
  extendedQuery,
  parseCommandResponse,
  parseQueryResponse,
  type CommandResult,
  type QueryParam,
  type QueryResult,
  toUint8Array,
} from './query.js';
import { createBrokerRuntimeBinding } from './runtime/broker.js';
import { directRuntimeBinding } from './runtime/direct.js';
import { createServerRuntimeBinding } from './runtime/server.js';
import type { RuntimeBinding, RuntimeHandle } from './runtime/types.js';
import type {
  BinaryInput,
  DatabaseStorage,
  OliphauntClient,
  OliphauntDatabase,
  OliphauntTransaction,
  OliphauntServer,
  OpenConfig,
  ServerOpenConfig,
} from './types.js';

export type NativeBindingFactory = (
  options?: NativeBindingOptions,
) => NativeBinding | Promise<NativeBinding>;

class OliphauntDatabaseBase {
  protected readonly binding: RuntimeBinding;
  protected readonly handle: RuntimeHandle;
  readonly #releaseOwnership?: () => void;
  #closed = false;
  #closing = false;
  #closeAttempt?: Promise<void>;
  #lifecycleOperations = 0;
  readonly #lifecycleIdleWaiters = new Set<() => void>();
  #activeTransaction = false;
  #transactionPoisoned = false;

  constructor(binding: RuntimeBinding, handle: RuntimeHandle, releaseOwnership?: () => void) {
    this.binding = binding;
    this.handle = handle;
    this.#releaseOwnership = releaseOwnership;
  }

  async execute(sql: string, parameters: ReadonlyArray<QueryParam> = []): Promise<CommandResult> {
    return this.withLifecycleOperation(async () => {
      this.assertNoActiveTransaction();
      const response = await this.#execProtocolRawUnlocked(extendedQuery(sql, parameters));
      return parseCommandResponse(response);
    });
  }

  async query(sql: string, parameters: ReadonlyArray<QueryParam> = []): Promise<QueryResult> {
    return this.withLifecycleOperation(async () => {
      this.assertNoActiveTransaction();
      return parseQueryResponse(await this.#execProtocolRawUnlocked(extendedQuery(sql, parameters)));
    });
  }

  async execProtocolRaw(input: BinaryInput): Promise<Uint8Array> {
    return this.withLifecycleOperation(() => {
      this.assertNoActiveTransaction();
      return this.#execProtocolRawUnlocked(input);
    });
  }

  async checkpoint(): Promise<void> {
    await this.withLifecycleOperation(async () => {
      this.assertNoActiveTransaction();
      parseCommandResponse(await this.#executeSimpleUnlocked('CHECKPOINT'));
    });
  }

  async cancel(): Promise<void> {
    await this.withLifecycleOperation(() =>
      this.#runNativeVoidOperation(() => this.binding.cancel(this.handle)),
    );
  }

  async transaction<T>(body: (transaction: OliphauntTransaction) => Promise<T> | T): Promise<T> {
    return this.withLifecycleOperation(async () => {
      if (this.#activeTransaction) {
        throw new Error(transactionPinnedMessage);
      }

      this.#activeTransaction = true;
      const transaction = new OliphauntTransactionHandle((input) =>
        this.#execProtocolRawUnlocked(input),
      );
      try {
        try {
          requireTransactionTag(await transaction.execute('BEGIN'), 'BEGIN');
        } catch (error) {
          this.#transactionPoisoned = true;
          throw error;
        }

        let result: T;
        try {
          result = await body(transaction);
        } catch (error) {
          try {
            requireTransactionTag(await transaction.execute('ROLLBACK'), 'ROLLBACK');
          } catch {
            this.#transactionPoisoned = true;
          }
          throw error;
        }

        let commit: CommandResult;
        try {
          commit = await transaction.execute('COMMIT');
        } catch (error) {
          // PostgreSQL may already have committed. A follow-up ROLLBACK cannot
          // undo that boundary and would misrepresent the outcome.
          this.#transactionPoisoned = true;
          throw error;
        }
        if (commit.commandTag !== 'COMMIT') {
          if (commit.commandTag !== 'ROLLBACK') {
            this.#transactionPoisoned = true;
          }
          throw transactionTagError('COMMIT', commit.commandTag);
        }
        return result;
      } finally {
        transaction.deactivate();
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
      .then(() => this.binding.detach(this.handle))
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
    if (this.binding.execSimpleQuery !== undefined) {
      return this.runNativeOperation(() => this.binding.execSimpleQuery?.(this.handle, sql));
    }
    return this.#execProtocolRawUnlocked(simpleQuery(sql));
  }

  async #execProtocolRawUnlocked(input: BinaryInput): Promise<Uint8Array> {
    const requestBytes = toUint8Array(input);
    return this.runNativeOperation(() => this.binding.execProtocolRaw(this.handle, requestBytes));
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new Error('Oliphaunt database is closed');
    }
    if (this.#closing) {
      throw new Error('Oliphaunt database is closing');
    }
    if (this.#transactionPoisoned) {
      throw new Error('Oliphaunt transaction state is unknown; close the database');
    }
  }

  protected assertNoActiveTransaction(): void {
    if (this.#activeTransaction) {
      throw new Error(transactionPinnedMessage);
    }
  }

  protected async withLifecycleOperation<T>(body: () => T | Promise<T>): Promise<T> {
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

  protected async runNativeOperation<T>(
    body: () => T | undefined | Promise<T | undefined>,
  ): Promise<T> {
    const result = await body();
    if (result === undefined) {
      throw new Error('native oliphaunt runtime operation returned no result');
    }
    return result;
  }

  async #runNativeVoidOperation(body: () => void | Promise<void>): Promise<void> {
    await body();
  }
}

class OliphauntDatabaseImpl extends OliphauntDatabaseBase implements OliphauntDatabase {
  async backup(): Promise<Uint8Array> {
    return this.withLifecycleOperation(async () => {
      this.assertNoActiveTransaction();
      const backup = this.binding.backup;
      if (backup === undefined) {
        throw new Error('database runtime binding does not implement backup');
      }
      return this.runNativeOperation(() => backup(this.handle));
    });
  }
}

class OliphauntServerImpl extends OliphauntDatabaseBase implements OliphauntServer {
  constructor(
    binding: RuntimeBinding,
    handle: RuntimeHandle,
    readonly connectionString: string,
  ) {
    super(binding, handle);
  }
}

class OliphauntTransactionHandle implements OliphauntTransaction {
  readonly #execRaw: (input: BinaryInput) => Promise<Uint8Array>;
  #active = true;

  constructor(execRaw: (input: BinaryInput) => Promise<Uint8Array>) {
    this.#execRaw = execRaw;
  }

  async execute(sql: string, parameters: ReadonlyArray<QueryParam> = []): Promise<CommandResult> {
    const response = await this.execProtocolRaw(extendedQuery(sql, parameters));
    return parseCommandResponse(response);
  }

  async query(sql: string, parameters: ReadonlyArray<QueryParam> = []): Promise<QueryResult> {
    return parseQueryResponse(await this.execProtocolRaw(extendedQuery(sql, parameters)));
  }

  async execProtocolRaw(input: BinaryInput): Promise<Uint8Array> {
    this.#assertActive();
    return this.#execRaw(input);
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

function requireTransactionTag(result: CommandResult, expected: string): void {
  if (result.commandTag !== expected) {
    throw transactionTagError(expected, result.commandTag);
  }
}

function transactionTagError(expected: string, actual: string | undefined): Error {
  return new Error(
    `PostgreSQL transaction command expected ${expected}, got ${actual ?? 'no command tag'}`,
  );
}

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

  function brokerBindingFor(config: { brokerExecutable?: string }): RuntimeBinding {
    const key = config.brokerExecutable ?? '';
    const cached = brokerBindings.get(key);
    if (cached !== undefined) {
      return cached;
    }
    const created = createBrokerRuntimeBinding({
      executable: config.brokerExecutable,
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

  async function openDatabase(
    effectiveConfig: OpenConfig | (ServerOpenConfig & { execution: 'server' }),
  ): Promise<OliphauntDatabaseImpl | OliphauntServerImpl> {
    const direct = effectiveConfig.execution === 'direct';
    if (direct && directResident.activeOwner !== undefined) {
      throw new Error('native direct already has an active process-wide instance');
    }

    const reusableTemporaryDirectory = direct ? directResident.temporaryDirectory : undefined;
    const resolvedStorage = await materializeStorage(
      effectiveConfig.storage,
      reusableTemporaryDirectory,
    );
    let runtimeOpenAttempted = false;
    try {
      const normalized = normalizeOpenConfig(effectiveConfig, resolvedStorage);
      let binding: RuntimeBinding;
      if (normalized.execution === 'direct') {
        binding = directRuntimeBinding(await bindingFor({ libraryPath: normalized.libraryPath }));
      } else if (normalized.execution === 'broker') {
        binding = brokerBindingFor({
          brokerExecutable: normalized.brokerExecutable,
        });
      } else {
        binding = serverBinding;
      }

      runtimeOpenAttempted = true;
      const handle = await binding.open(normalized);
      if (normalized.execution === 'server') {
        const connectionString = binding.connectionString?.(handle);
        if (connectionString === undefined) {
          await Promise.resolve(binding.detach(handle)).catch(() => {});
          throw new Error('native server did not expose its connection string');
        }
        return new OliphauntServerImpl(binding, handle, connectionString);
      }
      if (!direct) {
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
        if (direct && runtimeOpenAttempted) {
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
    async open(config: OpenConfig = {}): Promise<OliphauntDatabase> {
      const effectiveConfig: OpenConfig =
        config.execution === undefined ? { ...config, execution: 'direct' } : config;
      const database = await (effectiveConfig.execution === 'direct'
        ? serializeDirectOpen(() => openDatabase(effectiveConfig))
        : openDatabase(effectiveConfig));
      if (database instanceof OliphauntServerImpl) {
        throw new Error('generic database opener returned a native server');
      }
      return database;
    },

    async openServer(config: ServerOpenConfig = {}): Promise<OliphauntServer> {
      const database = await openDatabase({ ...config, execution: 'server' });
      if (!(database instanceof OliphauntServerImpl)) {
        throw new Error('native server opener returned a non-server database');
      }
      return database;
    },

    async restore(destination: string, backup: BinaryInput): Promise<void> {
      validateDirectoryPath(destination, 'restore destination');
      const binding = await bindingFor();
      await binding.restore({
        destination,
        bytes: toUint8Array(backup),
      });
    },
  };
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
    await mkdir(storage.path, { recursive: true });
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
