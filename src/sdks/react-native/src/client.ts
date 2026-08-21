import {
  backupJsi,
  execProtocolRawJsi,
  execProtocolStreamJsi,
  requireJsiRawProtocolTransport,
  restoreJsi,
  type JsiRawProtocolTransport,
} from './jsiTransport';
import { simpleQuery } from './protocol';
import {
  assertSuccessfulQueryResponse,
  extendedQuery,
  parseCommandResponse,
  parseQueryResponse,
  type CommandResult,
  type QueryParam,
  type QueryResult,
} from './query';
import { generatedExtensionBySqlName } from './generated/extensions';
import type { NativeOpenConfig, Spec as NativeOliphauntModule } from './specs/NativeOliphaunt';

export type BinaryInput = ArrayBuffer | ArrayBufferView | Uint8Array | ReadonlyArray<number>;
export type ProtocolChunkCallback = (chunk: Uint8Array) => void;

export type DatabaseStorage =
  | { readonly kind: 'temporaryDirectory' }
  | { readonly kind: 'directory'; readonly path: string }
  | { readonly kind: 'applicationData'; readonly name: string };

export type RestoreDestination = Exclude<DatabaseStorage, { readonly kind: 'temporaryDirectory' }>;

export type OpenConfig = {
  storage?: DatabaseStorage;
  startupGUCs?: Readonly<Record<string, string>>;
  username?: string;
  database?: string;
  extensions?: ReadonlyArray<string>;
};

export type OliphauntClient = {
  open(config?: OpenConfig): Promise<OliphauntDatabase>;
  restore(destination: RestoreDestination, backup: BinaryInput): Promise<void>;
};

export type OliphauntTransaction = {
  execute(sql: string, parameters?: ReadonlyArray<QueryParam>): Promise<CommandResult>;
  query(sql: string, parameters?: ReadonlyArray<QueryParam>): Promise<QueryResult>;
  execProtocolRaw(input: BinaryInput): Promise<Uint8Array>;
  execProtocolStream(input: BinaryInput, onChunk: ProtocolChunkCallback): Promise<void>;
};

export type OliphauntDatabase = {
  execute(sql: string, parameters?: ReadonlyArray<QueryParam>): Promise<CommandResult>;
  query(sql: string, parameters?: ReadonlyArray<QueryParam>): Promise<QueryResult>;
  execProtocolRaw(input: BinaryInput): Promise<Uint8Array>;
  execProtocolStream(input: BinaryInput, onChunk: ProtocolChunkCallback): Promise<void>;
  backup(): Promise<Uint8Array>;
  checkpoint(): Promise<void>;
  cancel(): Promise<void>;
  transaction<T>(body: (transaction: OliphauntTransaction) => Promise<T> | T): Promise<T>;
  close(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
};

class NativeOliphauntDatabase implements OliphauntDatabase {
  readonly #native: NativeOliphauntModule;
  readonly #handle: number;
  readonly #jsiTransport: JsiRawProtocolTransport;
  #closed = false;
  #closing = false;
  #closeAttempt?: Promise<void>;
  #lifecycleOperations = 0;
  readonly #lifecycleIdleWaiters = new Set<() => void>();
  #activeTransaction = false;
  #transactionPoisoned = false;

  constructor(
    native: NativeOliphauntModule,
    handle: number,
    jsiTransport: JsiRawProtocolTransport,
  ) {
    this.#native = native;
    this.#handle = handle;
    this.#jsiTransport = jsiTransport;
  }

  async execute(sql: string, parameters: ReadonlyArray<QueryParam> = []): Promise<CommandResult> {
    return this.#withLifecycleOperation(async () => {
      this.#assertNoActiveTransaction();
      const response = await this.#execProtocolRawUnlocked(extendedQuery(sql, parameters));
      return parseCommandResponse(response);
    });
  }

  async query(sql: string, parameters: ReadonlyArray<QueryParam> = []): Promise<QueryResult> {
    return this.#withLifecycleOperation(async () => {
      this.#assertNoActiveTransaction();
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
    await this.#withLifecycleOperation(async () => {
      this.#assertNoActiveTransaction();
      await this.#execProtocolStreamUnlocked(input, onChunk);
    });
  }

  async #execProtocolRawUnlocked(input: BinaryInput): Promise<Uint8Array> {
    const requestBytes = toUint8Array(input);
    return this.#runNativeOperation(() =>
      execProtocolRawJsi(this.#jsiTransport, this.#handle, requestBytes),
    );
  }

  async #execProtocolStreamUnlocked(
    input: BinaryInput,
    onChunk: ProtocolChunkCallback,
  ): Promise<void> {
    if (typeof onChunk !== 'function') {
      throw new TypeError('protocol stream callback must be a function');
    }
    await execProtocolStreamJsi(this.#jsiTransport, this.#handle, toUint8Array(input), onChunk);
  }

  async backup(): Promise<Uint8Array> {
    return this.#withLifecycleOperation(async () => {
      this.#assertNoActiveTransaction();
      return this.#runNativeOperation(() => backupJsi(this.#jsiTransport, this.#handle));
    });
  }

  async checkpoint(): Promise<void> {
    await this.#withLifecycleOperation(async () => {
      this.#assertNoActiveTransaction();
      assertSuccessfulQueryResponse(await this.#execProtocolRawUnlocked(simpleQuery('CHECKPOINT')));
    });
  }

  async cancel(): Promise<void> {
    await this.#withLifecycleOperation(() => this.#native.cancel(this.#handle));
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
        try {
          requireTransactionTag(await transaction.execute('BEGIN'), 'BEGIN');
        } catch (error) {
          try {
            requireTransactionTag(await transaction.execute('ROLLBACK'), 'ROLLBACK');
          } catch {
            this.#transactionPoisoned = true;
          }
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
      .then(() => this.#native.close(this.#handle))
      .then(() => {
        this.#closing = false;
        this.#closed = true;
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

  async #runNativeOperation<T>(body: () => Promise<T>): Promise<T> {
    return body();
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

/** @internal Package bootstrap and deterministic test injection only. */
export function createOliphauntClient(native: NativeOliphauntModule): OliphauntClient {
  const client = {
    async open(config: OpenConfig = {}): Promise<OliphauntDatabase> {
      const jsiTransport = requireJsiRawProtocolTransport();
      const nativeConfig = normalizeOpenConfig(config);
      const handle = await native.open(nativeConfig);
      return new NativeOliphauntDatabase(native, handle, jsiTransport);
    },
    async restore(destination: RestoreDestination, backup: BinaryInput): Promise<void> {
      const storage = normalizeRestoreDestination(destination);
      await restoreJsi(requireJsiRawProtocolTransport(), storage, toUint8Array(backup));
    },
  };
  return client;
}

function normalizeRestoreDestination(destination: RestoreDestination): {
  storageKind: 'directory' | 'applicationData';
  storagePath?: string;
  storageName?: string;
} {
  if (destination.kind === 'directory') {
    validatePath(destination.path, 'restore destination directory');
    return { storageKind: 'directory', storagePath: destination.path };
  }
  if (destination.kind === 'applicationData') {
    return {
      storageKind: 'applicationData',
      storageName: validateApplicationDataName(destination.name),
    };
  }
  throw new Error(
    `unknown restore destination kind '${String((destination as { kind?: unknown }).kind)}'`,
  );
}

function normalizeOpenConfig(config: OpenConfig): NativeOpenConfig {
  const storage = normalizeDatabaseStorage(config.storage);
  validateStartupIdentity(config.username, 'username');
  validateStartupIdentity(config.database, 'database');
  const startupGUCs = config.startupGUCs ? validateStartupGUCs(config.startupGUCs) : undefined;
  return {
    ...storage,
    startupGUCs,
    username: config.username,
    database: config.database,
    extensions: config.extensions ? validateExtensionIds(config.extensions) : undefined,
  };
}

function validatePath(value: string, label: string): void {
  if (value.trim().length === 0) {
    throw new Error(`${label} must not be empty`);
  }
  if (value.includes('\0')) {
    throw new Error(`${label} must not contain NUL bytes`);
  }
}

function normalizeDatabaseStorage(
  storage: DatabaseStorage | undefined,
): Pick<NativeOpenConfig, 'storageKind' | 'storagePath' | 'storageName'> {
  if (storage === undefined) {
    return { storageKind: 'temporaryDirectory' };
  }
  if (typeof storage !== 'object' || storage === null) {
    throw new Error('database storage must be an object');
  }
  if (storage.kind === 'temporaryDirectory') {
    return { storageKind: 'temporaryDirectory' };
  }
  if (storage.kind === 'directory') {
    validatePath(storage.path, 'database storage directory');
    return { storageKind: 'directory', storagePath: storage.path };
  }
  if (storage.kind === 'applicationData') {
    return {
      storageKind: 'applicationData',
      storageName: validateApplicationDataName(storage.name),
    };
  }
  throw new Error(`unknown database storage kind ${String((storage as { kind?: unknown }).kind)}`);
}

function validateApplicationDataName(value: string): string {
  const name = value.trim();
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(name) || name === '.' || name === '..') {
    throw new Error(
      'applicationData storage name must contain 1 to 128 ASCII letters, digits, dot, underscore or hyphen',
    );
  }
  return name;
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

function validateStartupGUCs(gucs: Readonly<Record<string, string>>): string[] {
  return Object.entries(gucs).map(([name, value]) => {
    const trimmedName = name.trim();
    if (trimmedName.length === 0) {
      throw new Error('PostgreSQL startup GUC name must not be empty');
    }
    if (trimmedName.includes('\0') || value.includes('\0')) {
      throw new Error('PostgreSQL startup GUC must not contain NUL bytes');
    }
    if (!/^[A-Za-z_][A-Za-z0-9_$]*(?:\.[A-Za-z_][A-Za-z0-9_$]*)*$/.test(trimmedName)) {
      throw new Error(
        `PostgreSQL startup GUC name '${name}': each dot-separated component must start with an ASCII letter or '_', followed by ASCII letters, digits, '_', or '$'`,
      );
    }
    return `${trimmedName}=${value}`;
  });
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
