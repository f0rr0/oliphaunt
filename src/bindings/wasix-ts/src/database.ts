import { composeWasixStorageFailure, WasixStorageError } from './errors.js';
import { WASIX_STREAM_CHUNK_BYTES } from './byte-channel.js';
import { simpleQuery } from './protocol.js';
import {
  assertSuccessfulQueryResponse,
  extendedQuery,
  parseCommandResponse,
  parseQueryResponse,
  type CommandResult,
  PostgresError,
  type QueryParam,
  type QueryResult,
  toUint8Array,
} from './query.js';
import type { WasixStorageSyncBoundary } from './storage-provider.js';
import type { WasixProtocolConnection } from './pgwire-connection.js';
import type {
  BinaryInput,
  OliphauntDatabase,
  OliphauntTransaction,
  ProtocolChunkCallback,
} from './types.js';

const transactionPinnedMessage =
  'Oliphaunt WASIX database is pinned to an active transaction; use the callback transaction handle';
const CLOSE_DEADLINE_MS = 120_000;
const protocolConnectionTargets = new WeakSet<OliphauntDatabase>();
const transactionPinnedTargets = new WeakSet<OliphauntDatabase>();

/** @internal Host-publication policy for one pgwire exchange. */
export type WasixPersistenceMode = 'sync' | 'defer';
export type WasixProtocolConnectionMode = 'server' | 'tool';

/** @internal Execution seam shared by direct and worker-backed database handles. */
export type WasixDatabaseSession = {
  readonly isolated?: boolean;
  exec(input: Uint8Array, persistence?: WasixPersistenceMode): Promise<Uint8Array>;
  execStream?(
    input: Uint8Array,
    onChunk: ProtocolChunkCallback,
    persistence?: WasixPersistenceMode,
  ): Promise<void>;
  sync(boundary: WasixStorageSyncBoundary): Promise<void>;
  /** Internal test seams may omit backup; production sessions always provide it. */
  backup?(): Promise<Uint8Array>;
  serve?(connection: WasixProtocolConnection, mode: WasixProtocolConnectionMode): Promise<void>;
  close(): Promise<void>;
  /** Force-stop an isolated execution placement when orderly shutdown stalls. */
  abort?(): void | Promise<void>;
};

/** @internal Public database state machine; construction stays behind Oliphaunt.open(). */
export class WasixDatabaseImpl implements OliphauntDatabase {
  readonly #session: WasixDatabaseSession;
  #tail = Promise.resolve();
  #closed = false;
  #closeAttempt: Promise<void> | undefined;
  #persistenceFailure: WasixStorageError | undefined;
  #transactionFailure: Error | undefined;
  #activeTransaction = false;

  constructor(session: WasixDatabaseSession) {
    this.#session = session;
    if (session.isolated === true && session.serve !== undefined) {
      protocolConnectionTargets.add(this);
    }
  }

  async execute(sql: string, parameters: ReadonlyArray<QueryParam> = []): Promise<CommandResult> {
    return parseCommandResponse(await this.#execOwned(extendedQuery(sql, parameters)));
  }

  async query(sql: string, parameters: ReadonlyArray<QueryParam> = []): Promise<QueryResult> {
    return parseQueryResponse(await this.#execOwned(extendedQuery(sql, parameters)));
  }

  async execProtocolRaw(input: BinaryInput): Promise<Uint8Array> {
    return this.#execOwned(toUint8Array(input).slice());
  }

  async execProtocolStream(input: BinaryInput, onChunk: ProtocolChunkCallback): Promise<void> {
    if (typeof onChunk !== 'function') {
      throw new TypeError('protocol stream callback must be a function');
    }
    this.#assertAvailable();
    const bytes = toUint8Array(input).slice();
    await this.#serialize(async () => {
      this.#assertHealthy();
      try {
        if (this.#session.execStream === undefined) {
          const response = await this.#session.exec(bytes, 'sync');
          for (let offset = 0; offset < response.length; offset += WASIX_STREAM_CHUNK_BYTES) {
            onChunk(response.slice(offset, offset + WASIX_STREAM_CHUNK_BYTES));
          }
          return;
        }
        await this.#session.execStream(bytes, onChunk, 'sync');
      } catch (error) {
        if (error instanceof WasixStorageError) this.#persistenceFailure = error;
        throw error;
      }
    });
  }

  async backup(): Promise<Uint8Array> {
    this.#assertAvailable();
    return this.#serialize(async () => {
      this.#assertHealthy();
      if (this.#session.backup === undefined) {
        throw new Error('this WASIX execution session does not support physical backup');
      }
      const bytes = await this.#session.backup();
      await this.#syncPersistence('operation');
      return bytes;
    });
  }

  /** @internal Serialized connection ownership used by optional server/tool packages. */
  runProtocolConnection(
    connection: WasixProtocolConnection,
    mode: WasixProtocolConnectionMode,
  ): Promise<void> {
    this.#assertAvailable();
    return this.#serialize(async () => {
      this.#assertHealthy();
      if (this.#session.serve === undefined) {
        throw new Error('this WASIX execution placement does not support protocol connections');
      }
      if (!this.#session.isolated) {
        throw new Error('WASIX tools and local servers require worker execution');
      }
      try {
        await this.#session.serve(connection, mode);
      } catch (error) {
        if (error instanceof WasixStorageError) this.#persistenceFailure = error;
        throw error;
      }
    });
  }

  #execOwned(bytes: Uint8Array): Promise<Uint8Array> {
    this.#assertAvailable();
    return this.#serialize(async () => {
      // A persistence failure may have been ahead of this operation in the
      // serialized queue. Recheck here so queued work cannot run against the
      // unpublished, deliberately poisoned generation.
      this.#assertHealthy();
      try {
        return await this.#session.exec(bytes, 'sync');
      } catch (error) {
        if (error instanceof WasixStorageError) this.#persistenceFailure = error;
        throw error;
      }
    });
  }

  async checkpoint(): Promise<void> {
    this.#assertAvailable();
    await this.#serialize(async () => {
      this.#assertHealthy();
      // Preserve PostgreSQL error identity: first complete the ordinary pgwire
      // exchange and parse any ErrorResponse on the main thread.
      const response = await this.#session.exec(simpleQuery('CHECKPOINT'), 'defer');
      assertSuccessfulQueryResponse(response);
      await this.#syncPersistence('checkpoint');
    });
  }

  async transaction<T>(body: (transaction: OliphauntTransaction) => Promise<T> | T): Promise<T> {
    this.#assertAvailable();
    if (typeof body !== 'function') {
      throw new TypeError('Oliphaunt WASIX transaction body must be a function');
    }
    this.#activeTransaction = true;
    transactionPinnedTargets.add(this);
    const attempt = this.#serialize(async () => {
      this.#assertHealthy();
      const transaction = new WasixTransactionImpl(
        (input) => this.#session.exec(input, 'defer'),
        (input, onChunk) => {
          if (this.#session.execStream === undefined) {
            return this.#session.exec(input, 'defer').then((response) => {
              for (let offset = 0; offset < response.length; offset += WASIX_STREAM_CHUNK_BYTES) {
                onChunk(response.slice(offset, offset + WASIX_STREAM_CHUNK_BYTES));
              }
            });
          }
          return this.#session.execStream(input, onChunk, 'defer');
        },
      );
      let commitAttempted = false;
      let commitConfirmed = false;
      try {
        await transaction.execute('BEGIN');
        const result = await body(transaction);
        transaction.seal();
        commitAttempted = true;
        await transaction.finish('COMMIT');
        commitConfirmed = true;
        await this.#syncPersistence('operation');
        return result;
      } catch (error) {
        transaction.seal();
        // Once COMMIT is on the wire, a later ROLLBACK cannot undo it. A clean
        // PostgreSQL response is safe to publish and report; transport or
        // malformed-protocol failures leave the outcome unknown and poison
        // this handle until it is closed.
        if (commitAttempted) {
          if (
            !commitConfirmed &&
            !(error instanceof CommitRolledBackError) &&
            !(error instanceof PostgresError)
          ) {
            this.#transactionFailure = asError(error, 'COMMIT outcome is unknown');
            throw error;
          }
          if (!commitConfirmed) {
            const primary = error instanceof CommitRolledBackError ? error.primary : error;
            try {
              await this.#syncPersistence('operation');
            } catch (persistenceError) {
              throw composeWasixStorageFailure(
                persistenceError as WasixStorageError,
                'transaction also failed',
                primary,
              );
            }
            throw primary;
          }
          throw error;
        }
        let rolledBack = false;
        try {
          await transaction.finish('ROLLBACK');
          rolledBack = true;
        } catch (rollbackError) {
          this.#transactionFailure = asError(rollbackError, 'ROLLBACK outcome is unknown');
          // Preserve the callback/BEGIN/COMMIT error as the primary failure,
          // while preventing later work on a session that did not prove its
          // final transaction boundary.
        }
        if (rolledBack) {
          try {
            await this.#syncPersistence('operation');
          } catch (persistenceError) {
            throw composeWasixStorageFailure(
              persistenceError as WasixStorageError,
              'transaction also failed',
              error,
            );
          }
        }
        throw error;
      } finally {
        transaction.seal();
      }
    });
    return await attempt.finally(() => {
      this.#activeTransaction = false;
      transactionPinnedTargets.delete(this);
    });
  }

  close(): Promise<void> {
    if (this.#closeAttempt !== undefined) {
      return this.#closeAttempt;
    }
    if (this.#activeTransaction) {
      return Promise.reject(
        new Error('cannot close Oliphaunt WASIX while a transaction is active'),
      );
    }
    this.#closed = true;
    const orderlyClose = this.#serialize(() => this.#session.close());
    this.#closeAttempt =
      this.#session.abort === undefined
        ? orderlyClose
        : withDeadline(orderlyClose, CLOSE_DEADLINE_MS, () => this.#session.abort?.());
    return this.#closeAttempt;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new Error('Oliphaunt WASIX database is closed');
    }
    this.#assertHealthy();
  }

  #assertAvailable(): void {
    this.#assertOpen();
    if (this.#activeTransaction) {
      throw new Error(transactionPinnedMessage);
    }
  }

  #assertHealthy(): void {
    if (this.#transactionFailure !== undefined) {
      throw new Error(
        'Oliphaunt WASIX database cannot be used after a transaction outcome became unknown; close and reopen it',
        { cause: this.#transactionFailure },
      );
    }
    if (this.#persistenceFailure !== undefined) {
      throw new WasixStorageError(
        'Oliphaunt WASIX database cannot be used after a persistence boundary failed; close and reopen it',
        {
          code: this.#persistenceFailure.code,
          commitState: this.#persistenceFailure.commitState,
          cause: this.#persistenceFailure,
        },
      );
    }
  }

  async #syncPersistence(boundary: WasixStorageSyncBoundary): Promise<void> {
    try {
      await this.#session.sync(boundary);
    } catch (error) {
      const failure =
        error instanceof WasixStorageError
          ? error
          : new WasixStorageError(`WASIX persistence ${boundary} failed`, {
              code: 'publication-failed',
              commitState: 'unknown',
              cause: error,
            });
      // PostgreSQL may already have completed the operation in the live
      // filesystem. No later query may widen the gap after publication fails.
      this.#persistenceFailure = failure;
      throw failure;
    }
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(operation, operation);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

/** @internal Optional packages acquire exclusive ownership without expanding the public class. */
export function runWasixProtocolConnection(
  database: OliphauntDatabase,
  connection: WasixProtocolConnection,
  mode: WasixProtocolConnectionMode,
): Promise<void> {
  assertWasixProtocolConnectionTarget(database);
  return database.runProtocolConnection(connection, mode);
}

/** @internal Fail before loading a tool or opening a listener for unsupported placement. */
export function assertWasixProtocolConnectionTarget(
  database: OliphauntDatabase,
): asserts database is WasixDatabaseImpl {
  if (!(database instanceof WasixDatabaseImpl)) {
    throw new TypeError('database is not an @oliphaunt/wasix-ts handle');
  }
  if (!protocolConnectionTargets.has(database)) {
    throw new Error('WASIX tools and local servers require worker execution');
  }
  if (transactionPinnedTargets.has(database)) {
    throw new Error(transactionPinnedMessage);
  }
}

function withDeadline<T>(
  operation: Promise<T>,
  milliseconds: number,
  expire: () => void | Promise<void>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      void Promise.resolve()
        .then(expire)
        .catch(() => undefined);
      reject(
        new Error(
          `Oliphaunt WASIX close exceeded ${milliseconds}ms; worker termination was requested`,
        ),
      );
    }, milliseconds);
    void operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

class WasixTransactionImpl implements OliphauntTransaction {
  readonly #exec: (input: Uint8Array) => Promise<Uint8Array>;
  readonly #execStream: (input: Uint8Array, onChunk: ProtocolChunkCallback) => Promise<void>;
  #tail = Promise.resolve();
  #active = true;
  #failed = false;
  #firstFailure: unknown;

  constructor(
    exec: (input: Uint8Array) => Promise<Uint8Array>,
    execStream: (input: Uint8Array, onChunk: ProtocolChunkCallback) => Promise<void>,
  ) {
    this.#exec = exec;
    this.#execStream = execStream;
  }

  execute(sql: string, parameters: ReadonlyArray<QueryParam> = []): Promise<CommandResult> {
    return this.#execOwned(extendedQuery(sql, parameters), parseCommandResponse);
  }

  query(sql: string, parameters: ReadonlyArray<QueryParam> = []): Promise<QueryResult> {
    return this.#execOwned(extendedQuery(sql, parameters), parseQueryResponse);
  }

  execProtocolRaw(input: BinaryInput): Promise<Uint8Array> {
    return this.#execOwned(toUint8Array(input).slice(), (response) => response);
  }

  execProtocolStream(input: BinaryInput, onChunk: ProtocolChunkCallback): Promise<void> {
    if (typeof onChunk !== 'function') {
      return Promise.reject(new TypeError('protocol stream callback must be a function'));
    }
    if (!this.#active) {
      return Promise.reject(new Error('Oliphaunt WASIX transaction is no longer active'));
    }
    return this.#enqueue(() => this.#execStream(toUint8Array(input).slice(), onChunk));
  }

  seal(): void {
    this.#active = false;
  }

  finish(sql: 'COMMIT' | 'ROLLBACK'): Promise<void> {
    return this.#enqueue(async () => {
      const response = await this.#exec(simpleQuery(sql));
      const result = parseCommandResponse(response);
      // PostgreSQL spells COMMIT in an aborted transaction as a successful
      // `ROLLBACK` CommandComplete. Sending the command is important: a caught
      // error may have been recovered with ROLLBACK TO SAVEPOINT and should be
      // allowed to commit. Only propagate the first queued failure when the
      // server confirms that COMMIT actually rolled the transaction back.
      if (sql === 'COMMIT') {
        if (result.commandTag === 'ROLLBACK') {
          // Raw protocol callers own response decoding, so an ErrorResponse
          // can abort the server transaction without rejecting its JS promise.
          // Never report success when PostgreSQL answers COMMIT with ROLLBACK.
          throw new CommitRolledBackError(
            this.#failed
              ? this.#firstFailure
              : new Error('PostgreSQL rolled back the transaction instead of committing'),
          );
        }
        if (result.commandTag !== 'COMMIT') {
          throw new Error(
            `PostgreSQL returned ${result.commandTag ?? 'no command tag'} for COMMIT`,
          );
        }
      } else if (result.commandTag !== 'ROLLBACK') {
        throw new Error(
          `PostgreSQL returned ${result.commandTag ?? 'no command tag'} for ROLLBACK`,
        );
      }
    });
  }

  #execOwned<Result>(input: Uint8Array, decode: (response: Uint8Array) => Result): Promise<Result> {
    if (!this.#active) {
      return Promise.reject(new Error('Oliphaunt WASIX transaction is no longer active'));
    }
    return this.#enqueue(async () => decode(await this.#exec(input)));
  }

  #enqueue<Result>(operation: () => Promise<Result>): Promise<Result> {
    const result = this.#tail.then(operation);
    this.#tail = result.then(
      () => undefined,
      (error: unknown) => {
        if (!this.#failed) {
          this.#failed = true;
          this.#firstFailure = error;
        }
      },
    );
    return result;
  }
}

class CommitRolledBackError extends Error {
  constructor(readonly primary: unknown) {
    super('PostgreSQL returned ROLLBACK for COMMIT');
    this.name = 'CommitRolledBackError';
  }
}

function asError(value: unknown, fallback: string): Error {
  if (value instanceof Error) return value;
  return new Error(fallback, { cause: value });
}
