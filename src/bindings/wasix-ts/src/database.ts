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
import type { BinaryInput, WasixDatabase } from './types.js';

type DatabaseWorkerRequest =
  | { method: 'exec'; input: Uint8Array }
  | { method: 'checkpoint' }
  | { method: 'close' };

/** @internal Narrow transport seam used by the database state-machine tests. */
export type WasixDatabaseWorker = {
  request(
    request: DatabaseWorkerRequest,
    transfer?: Transferable[],
  ): Promise<Uint8Array | undefined>;
  terminate(): void;
};

/** @internal Main-thread database state machine; public construction stays in openWasix(). */
export class WorkerWasixDatabase implements WasixDatabase {
  readonly #rpc: WasixDatabaseWorker;
  #tail = Promise.resolve();
  #closed = false;
  #closeAttempt: Promise<void> | undefined;
  #persistenceFailure: WasixStorageError | undefined;

  constructor(rpc: WasixDatabaseWorker) {
    this.#rpc = rpc;
  }

  async execute(sql: string): Promise<Uint8Array> {
    const response = await this.execProtocolRaw(simpleQuery(sql));
    assertSuccessfulQueryResponse(response);
    return response;
  }

  async query(sql: string, parameters: ReadonlyArray<QueryParam> = []): Promise<QueryResult> {
    const input = parameters.length === 0 ? simpleQuery(sql) : extendedQuery(sql, parameters);
    return parseQueryResponse(await this.execProtocolRaw(input));
  }

  async execProtocolRaw(input: BinaryInput): Promise<Uint8Array> {
    this.#assertOpen();
    const bytes = toUint8Array(input).slice();
    return this.#serialize(async () => {
      // A checkpoint failure may have been ahead of this operation in the
      // serialized queue. Recheck here so queued work cannot run against the
      // unpublished, deliberately poisoned generation.
      this.#assertHealthy();
      const response = await this.#rpc.request({ method: 'exec', input: bytes }, [bytes.buffer]);
      if (!(response instanceof Uint8Array)) {
        throw new Error('Oliphaunt WASIX worker returned an invalid protocol response');
      }
      return response;
    });
  }

  async checkpoint(): Promise<void> {
    this.#assertOpen();
    await this.#serialize(async () => {
      this.#assertHealthy();
      // Preserve PostgreSQL error identity: first complete the ordinary pgwire
      // exchange and parse any ErrorResponse on the main thread. Only a
      // successful CHECKPOINT asks the worker to publish its PGDATA snapshot.
      const response = await this.#rpc.request({
        method: 'exec',
        input: simpleQuery('CHECKPOINT'),
      });
      if (!(response instanceof Uint8Array)) {
        throw new Error('Oliphaunt WASIX worker returned an invalid CHECKPOINT response');
      }
      assertSuccessfulQueryResponse(response);
      try {
        await this.#rpc.request({ method: 'checkpoint' });
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

  close(): Promise<void> {
    if (this.#closeAttempt !== undefined) {
      return this.#closeAttempt;
    }
    this.#closed = true;
    this.#closeAttempt = this.#serialize(async () => {
      try {
        await this.#rpc.request({ method: 'close' });
      } finally {
        this.#rpc.terminate();
      }
    });
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
