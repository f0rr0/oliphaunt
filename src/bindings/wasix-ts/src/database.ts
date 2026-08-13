import { WasixStorageError } from './errors.js';
import { simpleQuery } from './protocol.js';
import {
  assertSuccessfulQueryResponse,
  extendedQuery,
  parseQueryResponse,
  type QueryParam,
  type QueryResult,
  toUint8Array,
} from './query.js';
import type { BinaryInput, OliphauntDatabase, OliphauntTransaction } from './types.js';

const transactionPinnedMessage =
  'Oliphaunt WASIX database is pinned to an active transaction; use the callback transaction handle';
const CLOSE_DEADLINE_MS = 120_000;

/** @internal Execution seam shared by direct and worker-backed database handles. */
export type WasixDatabaseSession = {
  exec(input: Uint8Array): Promise<Uint8Array>;
  checkpoint(): Promise<void>;
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
  #activeTransaction = false;

  constructor(session: WasixDatabaseSession) {
    this.#session = session;
  }

  async execute(sql: string): Promise<Uint8Array> {
    const response = await this.#execOwned(simpleQuery(sql));
    assertSuccessfulQueryResponse(response);
    return response;
  }

  async query(sql: string, parameters: ReadonlyArray<QueryParam> = []): Promise<QueryResult> {
    const input = parameters.length === 0 ? simpleQuery(sql) : extendedQuery(sql, parameters);
    return parseQueryResponse(await this.#execOwned(input));
  }

  async execProtocolRaw(input: BinaryInput): Promise<Uint8Array> {
    return this.#execOwned(toUint8Array(input).slice());
  }

  #execOwned(bytes: Uint8Array): Promise<Uint8Array> {
    this.#assertAvailable();
    return this.#serialize(async () => {
      // A checkpoint failure may have been ahead of this operation in the
      // serialized queue. Recheck here so queued work cannot run against the
      // unpublished, deliberately poisoned generation.
      this.#assertHealthy();
      return this.#session.exec(bytes);
    });
  }

  async checkpoint(): Promise<void> {
    this.#assertAvailable();
    await this.#serialize(async () => {
      this.#assertHealthy();
      // Preserve PostgreSQL error identity: first complete the ordinary pgwire
      // exchange and parse any ErrorResponse on the main thread. Only a
      // successful CHECKPOINT asks the worker to publish its PGDATA snapshot.
      const response = await this.#session.exec(simpleQuery('CHECKPOINT'));
      assertSuccessfulQueryResponse(response);
      try {
        await this.#session.checkpoint();
      } catch (error) {
        // PostgreSQL has already committed the CHECKPOINT in the live memory
        // filesystem. If publication fails, no later query may widen the gap
        // between that state and the last durable IndexedDB generation.
        this.#persistenceFailure =
          error instanceof WasixStorageError
            ? error
            : new WasixStorageError('WASIX persistence checkpoint failed', {
                code: 'checkpoint-failed',
                durability: 'unknown',
                cause: error,
              });
        throw error;
      }
    });
  }

  async transaction<T>(body: (transaction: OliphauntTransaction) => Promise<T> | T): Promise<T> {
    this.#assertAvailable();
    if (typeof body !== 'function') {
      throw new TypeError('Oliphaunt WASIX transaction body must be a function');
    }
    this.#activeTransaction = true;
    const attempt = this.#serialize(async () => {
      this.#assertHealthy();
      const transaction = new WasixTransactionImpl((input) => this.#session.exec(input));
      try {
        await transaction.execute('BEGIN');
        const result = await body(transaction);
        transaction.seal();
        await transaction.finish('COMMIT');
        return result;
      } catch (error) {
        transaction.seal();
        await transaction.finish('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        transaction.seal();
      }
    });
    return await attempt.finally(() => {
      this.#activeTransaction = false;
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
    if (this.#persistenceFailure !== undefined) {
      throw new WasixStorageError(
        'Oliphaunt WASIX database cannot be used after a persistence checkpoint failed; close and reopen it',
        {
          code: this.#persistenceFailure.code,
          durability: this.#persistenceFailure.durability,
          cause: this.#persistenceFailure,
        },
      );
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
  #tail = Promise.resolve();
  #active = true;
  #failed = false;
  #firstFailure: unknown;

  constructor(exec: (input: Uint8Array) => Promise<Uint8Array>) {
    this.#exec = exec;
  }

  execute(sql: string): Promise<Uint8Array> {
    return this.#execOwned(simpleQuery(sql), (response) => {
      assertSuccessfulQueryResponse(response);
      return response;
    });
  }

  query(sql: string, parameters: ReadonlyArray<QueryParam> = []): Promise<QueryResult> {
    const input = parameters.length === 0 ? simpleQuery(sql) : extendedQuery(sql, parameters);
    return this.#execOwned(input, parseQueryResponse);
  }

  execProtocolRaw(input: BinaryInput): Promise<Uint8Array> {
    return this.#execOwned(toUint8Array(input).slice(), (response) => response);
  }

  seal(): void {
    this.#active = false;
  }

  finish(sql: 'COMMIT' | 'ROLLBACK'): Promise<void> {
    return this.#enqueue(async () => {
      const response = await this.#exec(simpleQuery(sql));
      assertSuccessfulQueryResponse(response);
      // PostgreSQL spells COMMIT in an aborted transaction as a successful
      // `ROLLBACK` CommandComplete. Sending the command is important: a caught
      // error may have been recovered with ROLLBACK TO SAVEPOINT and should be
      // allowed to commit. Only propagate the first queued failure when the
      // server confirms that COMMIT actually rolled the transaction back.
      if (sql === 'COMMIT') {
        const commandTag = parseQueryResponse(response).commandTag;
        if (commandTag !== 'COMMIT') {
          if (this.#failed) {
            throw this.#firstFailure;
          }
          // Raw protocol callers own response decoding, so an ErrorResponse
          // can abort the server transaction without rejecting its JS promise.
          // Never report success when PostgreSQL answers COMMIT with ROLLBACK.
          throw new Error('PostgreSQL rolled back the transaction instead of committing');
        }
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
