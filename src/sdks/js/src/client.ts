import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  normalizeDatabaseTopology,
  normalizeOpenConfig,
  validateDirectoryPath,
  validateNativeStartupGUCs,
} from './config.js';
import { createDefaultNativeBinding } from './native/default.js';
import type { NativeBinding, NativeBindingOptions } from './native/types.js';
import {
  assertNoTransactionChain,
  decodeQueryResult,
  describeQuery,
  errorWithNotices,
  extendedQuery,
  inspectManagedTransactionResponse,
  inspectReadyForQuery,
  parseCommandResponse,
  parseDescribeResponse,
  parseExecResponse,
  parseQueryRawResponse,
  planQuery,
  structuredSimpleQuery,
  type CommandResult,
  type DescribeResult,
  type ExecResult,
  type InferQueryRow,
  type ParameterOptions,
  type PostgresNotice,
  type QueryParam,
  type QueryOptions,
  type QueryPlan,
  type QueryResult,
  type RawQueryResult,
  type TransactionStatus,
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
  ServerListen,
  ServerOpenConfig,
  ProtocolChunkCallback,
  RestoreOptions,
} from './types.js';

export type NativeBindingFactory = (
  options?: NativeBindingOptions,
) => NativeBinding | Promise<NativeBinding>;

type RuntimeBindingOverrides = {
  readonly broker?: RuntimeBinding;
  readonly server?: RuntimeBinding;
};

type QueryReadOptions = Omit<QueryOptions, 'encoders'>;

class OliphauntDatabaseBase {
  protected readonly binding: RuntimeBinding;
  protected readonly handle: RuntimeHandle;
  readonly #releaseOwnership?: () => void;
  #closed = false;
  #closing = false;
  #closeAttempt?: Promise<void>;
  #operationTail = Promise.resolve();
  readonly #cancellationOperations = new Set<Promise<void>>();
  #runtimeCloseActive = false;
  #activeTransaction = false;
  #streamCallbackActive = false;
  #sessionFailure?: Error;

  static async publish<Database extends OliphauntDatabaseBase>(
    database: Database,
  ): Promise<Database> {
    try {
      database.#initializeForgottenHandleCleanup();
      return database;
    } catch (publicationError) {
      const cleanupFailure = await database.#discardUnpublishedOwner();
      if (cleanupFailure === undefined) throw publicationError;
      throw new AggregateError(
        [publicationError, cleanupFailure],
        'Oliphaunt opened a runtime owner but could not publish its JavaScript facade',
      );
    }
  }

  constructor(binding: RuntimeBinding, handle: RuntimeHandle, releaseOwnership?: () => void) {
    this.binding = binding;
    this.handle = handle;
    if (releaseOwnership !== undefined) {
      let released = false;
      this.#releaseOwnership = () => {
        if (released) return;
        released = true;
        releaseOwnership();
      };
    }
  }

  /** Complete owner publication after the facade itself is reachable locally. */
  #initializeForgottenHandleCleanup(): void {
    this.binding.registerForgottenHandleCleanup?.(
      this,
      this.handle,
      this.#releaseOwnership ?? noop,
    );
  }

  /**
   * Retire an opened handle whose public facade could not be published.
   * Registration is unregistered even when the registry threw after partially
   * accepting it, and the exact JavaScript ownership lease is always released.
   */
  async #discardUnpublishedOwner(): Promise<unknown | undefined> {
    const failures: unknown[] = [];
    const closeFailure = await closeRuntimeHandleFailure(this.binding, this.handle);
    if (closeFailure !== undefined) failures.push(closeFailure);
    const retirementFailure = this.#retire();
    if (retirementFailure !== undefined) failures.push(retirementFailure);
    return collapseFailures(failures, 'unpublished Oliphaunt owner cleanup failed');
  }

  get closed(): boolean {
    return this.#closed;
  }

  async execute(
    sql: string,
    parameters: ReadonlyArray<QueryParam> = [],
    options: ParameterOptions = {},
  ): Promise<CommandResult> {
    this.assertNoActiveTransaction();
    const plan = planQuery(sql, parameters, snapshotParameterOptions(options));
    return this.withSessionOperation(() =>
      this.#runPlannedUnlocked(plan, 'database', parseCommandResponse),
    );
  }

  async query<Row = never, const Options extends QueryOptions = {}>(
    sql: string,
    parameters: ReadonlyArray<QueryParam> = [],
    options: Options & QueryOptions = {} as Options & QueryOptions,
  ): Promise<QueryResult<InferQueryRow<Options, Row>>> {
    this.assertNoActiveTransaction();
    const stableOptions = snapshotQueryOptions(options);
    const plan = planQuery(sql, parameters, stableOptions);
    return this.withSessionOperation(async () =>
      decodeQueryResult<Row, Options>(
        await this.#runPlannedUnlocked(plan, 'database', parseQueryRawResponse),
        stableOptions,
      ),
    );
  }

  async queryRaw(
    sql: string,
    parameters: ReadonlyArray<QueryParam> = [],
    options: ParameterOptions = {},
  ): Promise<RawQueryResult> {
    this.assertNoActiveTransaction();
    const plan = planQuery(sql, parameters, snapshotParameterOptions(options));
    return this.withSessionOperation(() =>
      this.#runPlannedUnlocked(plan, 'database', parseQueryRawResponse),
    );
  }

  async exec<Row = never, const Options extends QueryReadOptions = {}>(
    sql: string,
    options: Options & QueryReadOptions = {} as Options & QueryReadOptions,
  ): Promise<ExecResult<InferQueryRow<Options, Row>>> {
    this.assertNoActiveTransaction();
    const input = structuredSimpleQuery(sql);
    const stableOptions = snapshotReadOptions(options);
    return this.withSessionOperation(() =>
      this.#runStructuredUnlocked(input, 'database', (response) =>
        parseExecResponse<Row, Options>(response, stableOptions),
      ),
    );
  }

  async describe(
    sql: string,
    parameterTypeOids: ReadonlyArray<number> = [],
  ): Promise<DescribeResult> {
    this.assertNoActiveTransaction();
    const input = describeQuery(sql, [...parameterTypeOids]);
    return this.withSessionOperation(() =>
      this.#runStructuredUnlocked(input, 'database', parseDescribeResponse),
    );
  }

  async execProtocolRaw(input: BinaryInput): Promise<Uint8Array> {
    this.assertNoActiveTransaction();
    const bytes = toUint8Array(input).slice();
    return this.withSessionOperation(() => this.#runRawProtocolUnlocked(bytes));
  }

  async execProtocolRawStream(input: BinaryInput, onChunk: ProtocolChunkCallback): Promise<void> {
    this.assertNoActiveTransaction();
    if (typeof onChunk !== 'function') {
      return Promise.reject(new TypeError('protocol stream callback must be a function'));
    }
    const bytes = toUint8Array(input).slice();
    return this.withSessionOperation(() => this.#execProtocolStreamUnlocked(bytes, onChunk));
  }

  cancel(): Promise<void> {
    if (this.#closed) {
      return Promise.reject(new Error('Oliphaunt database is closed'));
    }
    if (this.#runtimeCloseActive) {
      return Promise.reject(new Error('Oliphaunt database is closing'));
    }
    // Cancellation must remain independent of the physical-session queue so
    // it can interrupt an admitted operation even after close() has stopped
    // ordinary admission. Runtime teardown waits for every admitted cancel.
    const operation = this.#runNativeVoidOperation(() => this.binding.cancel(this.handle));
    this.#cancellationOperations.add(operation);
    void operation.then(
      () => this.#cancellationOperations.delete(operation),
      () => this.#cancellationOperations.delete(operation),
    );
    return operation;
  }

  async transaction<T>(body: (transaction: OliphauntTransaction) => Promise<T> | T): Promise<T> {
    this.assertNoActiveTransaction();
    if (typeof body !== 'function') {
      return Promise.reject(new TypeError('Oliphaunt transaction body must be a function'));
    }
    // Pin immediately at admission. Calls made after transaction() returns may
    // not slip into the physical-session queue before BEGIN starts.
    this.#activeTransaction = true;
    let attempt: Promise<T>;
    try {
      attempt = this.withSessionOperation(async () => {
        const transaction = new OliphauntTransactionHandle(
          (plan, decode) => this.#runPlannedUnlocked(plan, 'transaction', decode),
          (input, decode) => this.#runStructuredUnlocked(input, 'transaction', decode),
          () => this.#executeTransactionControlUnlocked('ROLLBACK').then(() => undefined),
        );
        try {
          await this.#executeTransactionControlUnlocked('BEGIN');

          let result: T;
          try {
            result = await body(transaction);
            await transaction.sealAndDrain();
          } catch (error) {
            transaction.seal();
            await transaction.drain().catch(() => undefined);
            let rollbackFailure: unknown;
            if (transaction.rollbackStarted) {
              try {
                await transaction.waitForRollback();
              } catch (rollbackError) {
                rollbackFailure = rollbackError;
              }
            } else if (this.#sessionFailure === undefined) {
              try {
                await this.#executeTransactionControlUnlocked('ROLLBACK');
              } catch (rollbackError) {
                rollbackFailure = rollbackError;
              }
            }
            if (rollbackFailure !== undefined && rollbackFailure !== error) {
              throw transactionCallbackAggregate(
                error,
                rollbackFailure,
                'transaction callback and rollback both failed',
              );
            }
            const databaseFailure =
              this.#sessionFailure === undefined
                ? undefined
                : (transaction.firstFailure ?? this.#sessionFailure);
            if (databaseFailure !== undefined && databaseFailure !== error) {
              throw transactionCallbackAggregate(
                error,
                databaseFailure,
                'transaction callback and an independent database failure both occurred',
              );
            }
            throw error;
          }

          if (transaction.rolledBack) {
            return result;
          }
          if (this.#sessionFailure !== undefined && transaction.firstFailure !== undefined) {
            throw transaction.firstFailure;
          }
          const outcome = await this.#executeTransactionControlUnlocked('COMMIT');
          if (outcome === 'rolledBack') {
            throw transaction.firstFailure ?? transactionTagError('COMMIT', 'ROLLBACK');
          }
          return result;
        } finally {
          transaction.deactivate();
        }
      });
    } catch (error) {
      this.#activeTransaction = false;
      throw error;
    }
    return attempt.finally(() => {
      this.#activeTransaction = false;
    });
  }

  close(): Promise<void> {
    if (this.#streamCallbackActive) {
      return Promise.reject(streamCallbackReentryError());
    }
    if (this.#closeAttempt !== undefined) {
      return this.#closeAttempt;
    }
    if (this.#closed) {
      return Promise.resolve();
    }
    if (this.#activeTransaction) {
      return Promise.reject(new Error('cannot close Oliphaunt while a transaction is active'));
    }

    this.#closing = true;
    let terminal = false;
    const attempt = this.#operationTail
      .then(async () => {
        // Cancellation remains out-of-band while admitted session work drains.
        // Close the cancellation admission gate only in the same job that
        // starts runtime teardown, after every already-admitted cancel settles.
        while (this.#cancellationOperations.size > 0) {
          await Promise.allSettled([...this.#cancellationOperations]);
        }
        this.#runtimeCloseActive = true;
        let outcome;
        try {
          outcome = await this.binding.close(this.handle);
        } catch (error) {
          // A runtime adapter violated the private no-rejection contract. Its
          // teardown state is unknowable, so retiring the public owner is the
          // only safe result.
          outcome = { state: 'terminal' as const, error };
        }
        if (outcome.state === 'retryable') {
          throw outcome.error;
        }

        terminal = true;
        const cleanupFailure = this.#retire();
        if (outcome.state === 'terminal') {
          throw outcome.error;
        }
        if (cleanupFailure !== undefined) {
          throw cleanupFailure;
        }
      })
      .finally(() => {
        this.#closing = false;
        if (!terminal && this.#closeAttempt === attempt) {
          this.#runtimeCloseActive = false;
          this.#closeAttempt = undefined;
        }
      });
    this.#closeAttempt = attempt;
    return attempt;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  async #executeTransactionControlUnlocked(
    sql: 'BEGIN' | 'COMMIT' | 'ROLLBACK',
  ): Promise<'committed' | 'rolledBack' | undefined> {
    this.#assertHealthy();
    let response: Uint8Array;
    try {
      response = await this.#execProtocolRawUnlocked(extendedQuery(sql, []));
    } catch (error) {
      this.#poison(error, `${sql} transport outcome is unknown`);
      throw error;
    }

    let status: TransactionStatus;
    try {
      status = inspectReadyForQuery(response);
    } catch (error) {
      this.#poison(error, `${sql} did not reach a valid ReadyForQuery boundary`);
      throw error;
    }

    let result: CommandResult;
    try {
      result = parseCommandResponse(response);
    } catch (error) {
      if (sql === 'BEGIN' && status !== 'idle') {
        await this.#recoverDatabaseBoundaryUnlocked().catch(() => undefined);
      } else if (sql === 'ROLLBACK') {
        this.#poison(error, 'ROLLBACK did not return its exact command boundary');
      } else if (sql === 'COMMIT') {
        this.#poison(error, 'COMMIT did not return its exact command boundary');
      }
      throw error;
    }

    if (sql === 'BEGIN') {
      if (result.commandTag === 'BEGIN' && status === 'transaction') return undefined;
      const error = transactionBoundaryError(sql, result.commandTag, status);
      if (status !== 'idle') {
        await this.#recoverDatabaseBoundaryUnlocked();
      }
      throw error;
    }

    if (sql === 'COMMIT' && result.commandTag === 'ROLLBACK' && status === 'idle') {
      return 'rolledBack';
    }
    if (result.commandTag === sql && status === 'idle') {
      return sql === 'COMMIT' ? 'committed' : undefined;
    }

    const error = transactionBoundaryError(sql, result.commandTag, status);
    this.#poison(error, `${sql} returned an unrecognized transaction boundary`);
    throw error;
  }

  async #runPlannedUnlocked<Result extends NoticeCarrier>(
    plan: QueryPlan,
    scope: StructuredScope,
    decode: (response: Uint8Array) => Result,
  ): Promise<Result> {
    if (plan.kind === 'complete') {
      return this.#runStructuredUnlocked(plan.input, scope, decode);
    }
    const description = await this.#runStructuredUnlocked(plan.input, scope, parseDescribeResponse);
    // plan.bind() may invoke a caller codec. It runs only after a proven Ready
    // boundary and therefore cannot poison the wire session if it throws.
    let input: Uint8Array;
    try {
      input = plan.bind(description.parameterTypeOids);
    } catch (error) {
      throw errorWithNotices(error, description.notices);
    }
    try {
      return prependNotices(
        await this.#runStructuredUnlocked(input, scope, decode),
        description.notices,
      );
    } catch (error) {
      throw errorWithNotices(error, description.notices);
    }
  }

  async #runStructuredUnlocked<Result>(
    input: Uint8Array,
    scope: StructuredScope,
    decode: (response: Uint8Array) => Result,
  ): Promise<Result> {
    let response: Uint8Array;
    try {
      response = await this.#execProtocolRawUnlocked(input);
    } catch (error) {
      this.#poison(error, 'structured PostgreSQL transport outcome is unknown');
      throw error;
    }

    let status: TransactionStatus;
    try {
      status =
        scope === 'transaction'
          ? inspectManagedTransactionResponse(response)
          : inspectReadyForQuery(response);
    } catch (error) {
      this.#poison(
        error,
        scope === 'transaction'
          ? 'callback transaction ownership escaped or its response boundary was invalid'
          : 'structured PostgreSQL response has no valid readiness boundary',
      );
      throw error;
    }

    if (scope === 'database' && status !== 'idle') {
      await this.#recoverDatabaseBoundaryUnlocked();
      // Preserve a PostgreSQL/parser error after proven recovery, but never
      // report a successful structured call whose transaction was discarded.
      const result = decode(response);
      const error = new Error(
        `structured database operation ended with PostgreSQL transaction status ${status}; Oliphaunt rolled it back`,
      );
      throw isNoticeCarrier(result) ? errorWithNotices(error, result.notices) : error;
    }
    return decode(response);
  }

  async #recoverDatabaseBoundaryUnlocked(): Promise<void> {
    try {
      await this.#executeTransactionControlUnlocked('ROLLBACK');
    } catch (error) {
      this.#poison(error, 'PostgreSQL automatic rollback did not prove recovery');
      throw new Error('PostgreSQL session could not be recovered to idle; close the database', {
        cause: error,
      });
    }
  }

  async #execProtocolRawUnlocked(input: BinaryInput): Promise<Uint8Array> {
    const requestBytes = toUint8Array(input);
    return this.runNativeOperation(() => this.binding.execProtocolRaw(this.handle, requestBytes));
  }

  async #runRawProtocolUnlocked(input: BinaryInput): Promise<Uint8Array> {
    try {
      return await this.#execProtocolRawUnlocked(input);
    } catch (error) {
      // Raw protocol bypasses Oliphaunt's response-boundary parser. If the
      // adapter rejects, neither the caller nor this layer can prove where the
      // physical PostgreSQL session stopped, so subsequent work is unsafe.
      this.#poison(error, 'raw PostgreSQL transport outcome is unknown');
      throw error;
    }
  }

  async #execProtocolStreamUnlocked(
    input: BinaryInput,
    onChunk: ProtocolChunkCallback,
  ): Promise<void> {
    if (typeof onChunk !== 'function') {
      throw new TypeError('protocol stream callback must be a function');
    }
    const requestBytes = toUint8Array(input);
    const consumer = synchronousProtocolChunkConsumer((chunk) => {
      this.#streamCallbackActive = true;
      try {
        return (onChunk as (chunk: Uint8Array) => unknown)(chunk);
      } finally {
        this.#streamCallbackActive = false;
      }
    });
    try {
      await this.binding.execProtocolStream(this.handle, requestBytes, consumer.callback);
    } catch (error) {
      // Adapters only preserve callback identity when they have positively
      // confirmed recovery (for example broker ReadyForQuery frame 104). Any
      // other rejection is the authoritative execution/recovery outcome.
      if (consumer.failure === undefined || !Object.is(error, consumer.failure.error)) {
        this.#poison(error, 'streaming raw PostgreSQL recovery was not proven');
      }
      throw error;
    }
    if (consumer.failure !== undefined) {
      throw consumer.failure.error;
    }
  }

  #assertOpen(): void {
    this.#assertNoStreamCallbackReentry();
    if (this.#closed) {
      throw new Error('Oliphaunt database is closed');
    }
    if (this.#closing) {
      throw new Error('Oliphaunt database is closing');
    }
    this.#assertHealthy();
  }

  #assertHealthy(): void {
    if (this.#sessionFailure !== undefined) {
      throw new Error('Oliphaunt session state is unknown; close the database', {
        cause: this.#sessionFailure,
      });
    }
  }

  protected assertNoActiveTransaction(): void {
    this.#assertNoStreamCallbackReentry();
    if (this.#activeTransaction) {
      throw new Error(transactionPinnedMessage);
    }
  }

  #assertNoStreamCallbackReentry(): void {
    if (this.#streamCallbackActive) {
      throw streamCallbackReentryError();
    }
  }

  #retire(): unknown | undefined {
    this.#closed = true;
    const failures: unknown[] = [];
    try {
      this.binding.unregisterForgottenHandleCleanup?.(this);
    } catch (error) {
      failures.push(error);
    }
    try {
      this.#releaseOwnership?.();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length === 0) return undefined;
    if (failures.length === 1) return failures[0];
    return new AggregateError(failures, 'Oliphaunt owner retirement failed');
  }

  protected withSessionOperation<T>(body: () => T | Promise<T>): Promise<T> {
    this.#assertOpen();
    const operation = this.#operationTail.then(async () => {
      this.#assertHealthy();
      return await body();
    });
    this.#operationTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
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

  #poison(error: unknown, message: string): void {
    this.#sessionFailure ??= new Error(message, { cause: error });
  }
}

class OliphauntDatabaseImpl extends OliphauntDatabaseBase implements OliphauntDatabase {
  async backup(): Promise<Uint8Array> {
    this.assertNoActiveTransaction();
    return this.withSessionOperation(async () => {
      const backup = this.binding.backup;
      if (backup === undefined) {
        throw new Error('database runtime binding does not implement backup');
      }
      return this.runNativeOperation(() => backup(this.handle));
    });
  }
}

class OliphauntServerOwner extends OliphauntDatabaseBase {}

class OliphauntServerImpl implements OliphauntServer {
  readonly #owner: OliphauntServerOwner;

  constructor(
    owner: OliphauntServerOwner,
    readonly connectionString: string,
  ) {
    this.#owner = owner;
  }

  get closed(): boolean {
    return this.#owner.closed;
  }

  close(): Promise<void> {
    return this.#owner.close();
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}

class OliphauntTransactionHandle implements OliphauntTransaction {
  readonly #runPlan: <Result extends NoticeCarrier>(
    plan: QueryPlan,
    decode: (response: Uint8Array) => Result,
  ) => Promise<Result>;
  readonly #runStructured: <Result>(
    input: Uint8Array,
    decode: (response: Uint8Array) => Result,
  ) => Promise<Result>;
  readonly #rollbackControl: () => Promise<void>;
  #state: 'active' | 'finishing' | 'closed' = 'active';
  #tail = Promise.resolve();
  #rollbackAttempt?: Promise<void>;
  #rolledBack = false;
  #firstFailure: unknown;

  constructor(
    runPlan: <Result extends NoticeCarrier>(
      plan: QueryPlan,
      decode: (response: Uint8Array) => Result,
    ) => Promise<Result>,
    runStructured: <Result>(
      input: Uint8Array,
      decode: (response: Uint8Array) => Result,
    ) => Promise<Result>,
    rollbackControl: () => Promise<void>,
  ) {
    this.#runPlan = runPlan;
    this.#runStructured = runStructured;
    this.#rollbackControl = rollbackControl;
  }

  get closed(): boolean {
    return this.#state === 'closed';
  }

  get rollbackStarted(): boolean {
    return this.#rollbackAttempt !== undefined;
  }

  get rolledBack(): boolean {
    return this.#rolledBack;
  }

  get firstFailure(): unknown {
    return this.#firstFailure;
  }

  execute(
    sql: string,
    parameters: ReadonlyArray<QueryParam> = [],
    options: ParameterOptions = {},
  ): Promise<CommandResult> {
    return promiseFromSynchronousCall(() => {
      assertNoTransactionChain(sql);
      const plan = planQuery(sql, parameters, snapshotParameterOptions(options));
      return this.#enqueue(() => this.#runPlan(plan, parseCommandResponse));
    });
  }

  query<Row = never, const Options extends QueryOptions = {}>(
    sql: string,
    parameters: ReadonlyArray<QueryParam> = [],
    options: Options & QueryOptions = {} as Options & QueryOptions,
  ): Promise<QueryResult<InferQueryRow<Options, Row>>> {
    return promiseFromSynchronousCall(() => {
      assertNoTransactionChain(sql);
      const stableOptions = snapshotQueryOptions(options);
      const plan = planQuery(sql, parameters, stableOptions);
      return this.#enqueue(async () => {
        return decodeQueryResult<Row, Options>(
          await this.#runPlan(plan, parseQueryRawResponse),
          stableOptions,
        );
      });
    });
  }

  queryRaw(
    sql: string,
    parameters: ReadonlyArray<QueryParam> = [],
    options: ParameterOptions = {},
  ): Promise<RawQueryResult> {
    return promiseFromSynchronousCall(() => {
      assertNoTransactionChain(sql);
      const plan = planQuery(sql, parameters, snapshotParameterOptions(options));
      return this.#enqueue(() => this.#runPlan(plan, parseQueryRawResponse));
    });
  }

  exec<Row = never, const Options extends QueryReadOptions = {}>(
    sql: string,
    options: Options & QueryReadOptions = {} as Options & QueryReadOptions,
  ): Promise<ExecResult<InferQueryRow<Options, Row>>> {
    return promiseFromSynchronousCall(() => {
      assertNoTransactionChain(sql);
      const input = structuredSimpleQuery(sql);
      const stableOptions = snapshotReadOptions(options);
      return this.#enqueue(() =>
        this.#runStructured(input, (response) =>
          parseExecResponse<Row, Options>(response, stableOptions),
        ),
      );
    });
  }

  describe(sql: string, parameterTypeOids: ReadonlyArray<number> = []): Promise<DescribeResult> {
    return promiseFromSynchronousCall(() => {
      const input = describeQuery(sql, [...parameterTypeOids]);
      return this.#enqueue(() => this.#runStructured(input, parseDescribeResponse));
    });
  }

  rollback(): Promise<void> {
    return promiseFromSynchronousCall(() => {
      this.#assertActive();
      this.#state = 'finishing';
      const operation = this.#enqueueFinishing(this.#rollbackControl);
      const attempt = operation.then(
        () => {
          this.#rolledBack = true;
          this.#state = 'closed';
        },
        (error: unknown) => {
          this.#state = 'closed';
          throw error;
        },
      );
      this.#rollbackAttempt = attempt;
      return attempt;
    });
  }

  deactivate(): void {
    this.#state = 'closed';
  }

  seal(): void {
    if (this.#state === 'active') this.#state = 'finishing';
  }

  async drain(): Promise<void> {
    await this.#tail;
  }

  async sealAndDrain(): Promise<void> {
    this.seal();
    await this.#tail;
    await this.#rollbackAttempt;
  }

  async waitForRollback(): Promise<void> {
    await this.#rollbackAttempt;
  }

  #assertActive(): void {
    if (this.#state === 'finishing') throw new Error('transaction is finishing');
    if (this.#state === 'closed') throw new Error('transaction is no longer active');
  }

  #enqueue<T>(body: () => Promise<T>): Promise<T> {
    try {
      this.#assertActive();
    } catch (error) {
      return Promise.reject(error);
    }
    return this.#enqueueFinishing(body);
  }

  #enqueueFinishing<T>(body: () => Promise<T>): Promise<T> {
    const operation = this.#tail.then(body);
    this.#tail = operation.then(
      () => undefined,
      (error: unknown) => {
        this.#firstFailure ??= error;
      },
    );
    return operation;
  }
}

const transactionPinnedMessage = 'physical session is pinned; use the active OliphauntTransaction';

type StructuredScope = 'database' | 'transaction';
type NoticeCarrier = { notices: PostgresNotice[] };

function promiseFromSynchronousCall<T>(body: () => Promise<T>): Promise<T> {
  try {
    return body();
  } catch (error) {
    return Promise.reject(error);
  }
}

function snapshotParameterOptions(options: ParameterOptions): ParameterOptions {
  return Object.freeze({
    ...(options.encoders === undefined ? {} : { encoders: Object.freeze({ ...options.encoders }) }),
  });
}

function snapshotReadOptions<const Options extends QueryReadOptions>(options: Options): Options {
  return Object.freeze({
    rowMode: options.rowMode,
    valueMode: options.valueMode,
    ...(options.decoders === undefined ? {} : { decoders: Object.freeze({ ...options.decoders }) }),
  }) as Options;
}

function snapshotQueryOptions<const Options extends QueryOptions>(options: Options): Options {
  return Object.freeze({
    ...snapshotReadOptions(options),
    ...snapshotParameterOptions(options),
  }) as Options;
}

function prependNotices<Result extends NoticeCarrier>(
  result: Result,
  notices: ReadonlyArray<PostgresNotice>,
): Result {
  if (notices.length > 0) result.notices.unshift(...notices);
  return result;
}

function isNoticeCarrier(value: unknown): value is NoticeCarrier {
  return (
    value !== null &&
    typeof value === 'object' &&
    Array.isArray((value as { notices?: unknown }).notices)
  );
}

function transactionTagError(expected: string, actual: string | undefined): Error {
  return new Error(
    `PostgreSQL transaction command expected ${expected}, got ${actual ?? 'no command tag'}`,
  );
}

function transactionBoundaryError(
  expected: 'BEGIN' | 'COMMIT' | 'ROLLBACK',
  actual: string | undefined,
  status: TransactionStatus,
): Error {
  return new Error(
    `PostgreSQL transaction command expected ${expected} with its matching readiness status, got ${actual ?? 'no command tag'} with ${status}`,
  );
}

function collapseFailures(failures: readonly unknown[], message: string): unknown | undefined {
  if (failures.length === 0) return undefined;
  if (failures.length === 1) return failures[0];
  return new AggregateError(failures, message);
}

function transactionCallbackAggregate(
  callback: unknown,
  secondary: unknown,
  message: string,
): AggregateError {
  return new AggregateError([callback, secondary], message);
}

function noop(): void {}

export function createOliphauntClient(
  bindingFactory: NativeBindingFactory = createDefaultNativeBinding,
  runtimeOverrides: RuntimeBindingOverrides = {},
): OliphauntClient {
  const bindings = new Map<string, Promise<NativeBinding>>();
  const brokerBindings = new Map<string, RuntimeBinding>();
  const serverBinding = runtimeOverrides.server ?? createServerRuntimeBinding();
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
    if (runtimeOverrides.broker !== undefined) {
      return runtimeOverrides.broker;
    }
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
    effectiveConfig: OpenConfig | (ServerOpenConfig & { topology: 'server' }),
  ): Promise<OliphauntDatabaseImpl | OliphauntServerImpl> {
    const direct = effectiveConfig.topology === 'direct';
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
      if (normalized.topology === 'direct') {
        binding = directRuntimeBinding(await bindingFor({ libraryPath: normalized.libraryPath }));
      } else if (normalized.topology === 'broker') {
        binding = brokerBindingFor({
          brokerExecutable: normalized.brokerExecutable,
        });
      } else {
        binding = serverBinding;
      }

      runtimeOpenAttempted = true;
      const handle = await binding.open(normalized);
      if (normalized.topology === 'server') {
        const connectionString = binding.connectionString?.(handle);
        if (connectionString === undefined) {
          const mismatch = new Error('native server did not expose its connection string');
          const cleanupFailure = await closeRuntimeHandleFailure(binding, handle);
          if (cleanupFailure !== undefined) {
            throw new AggregateError(
              [mismatch, cleanupFailure],
              'native server omitted its connection string and cleanup also failed',
            );
          }
          throw mismatch;
        }
        const owner = await OliphauntDatabaseBase.publish(
          new OliphauntServerOwner(binding, handle),
        );
        return new OliphauntServerImpl(owner, connectionString);
      }
      if (!direct) {
        return await OliphauntDatabaseBase.publish(new OliphauntDatabaseImpl(binding, handle));
      }

      if (resolvedStorage.temporaryDirectory) {
        directResident.temporaryDirectory ??= resolvedStorage.instanceDirectory;
      }
      const owner = Symbol('native-direct-owner');
      directResident.activeOwner = owner;
      return await OliphauntDatabaseBase.publish(
        new OliphauntDatabaseImpl(binding, handle, () => {
          if (directResident.activeOwner === owner) {
            directResident.activeOwner = undefined;
          }
        }),
      );
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
      const effectiveConfig = snapshotOpenConfig(config);
      const database = await (effectiveConfig.topology === 'direct'
        ? serializeDirectOpen(() => openDatabase(effectiveConfig))
        : openDatabase(effectiveConfig));
      if (database instanceof OliphauntServerImpl) {
        return rejectUnexpectedFacade(
          database,
          new Error('generic database opener returned a native server'),
        );
      }
      return database;
    },

    async openServer(config: ServerOpenConfig = {}): Promise<OliphauntServer> {
      const database = await openDatabase(snapshotServerOpenConfig(config));
      if (!(database instanceof OliphauntServerImpl)) {
        return rejectUnexpectedFacade(
          database,
          new Error('native server opener returned a non-server database'),
        );
      }
      return database;
    },

    async restore(
      destination: string,
      backup: BinaryInput,
      options: RestoreOptions = {},
    ): Promise<void> {
      validateDirectoryPath(destination, 'restore destination');
      const bytes = toUint8Array(backup).slice();
      const binding = await bindingFor({ libraryPath: options.libraryPath });
      await binding.restore({
        destination,
        bytes,
      });
    },
  };
}

function snapshotOpenConfig(config: OpenConfig): OpenConfig & { topology: 'direct' | 'broker' } {
  const topology = normalizeDatabaseTopology(config.topology);
  validateNativeStartupGUCs(topology, config.startupGUCs ?? {});
  return {
    ...snapshotCommonOpenConfig(config),
    topology,
    libraryPath: config.libraryPath,
    brokerExecutable: config.brokerExecutable,
  };
}

async function rejectUnexpectedFacade(
  facade: OliphauntDatabaseImpl | OliphauntServerImpl,
  mismatch: Error,
): Promise<never> {
  try {
    await facade.close();
  } catch (cleanupFailure) {
    throw new AggregateError(
      [mismatch, cleanupFailure],
      'native runtime returned the wrong facade and cleanup also failed',
    );
  }
  throw mismatch;
}

async function closeRuntimeHandleFailure(
  binding: RuntimeBinding,
  handle: RuntimeHandle,
): Promise<unknown | undefined> {
  try {
    const outcome = await binding.close(handle);
    return outcome.state === 'closed' ? undefined : outcome.error;
  } catch (error) {
    return error;
  }
}

function snapshotServerOpenConfig(
  config: ServerOpenConfig,
): ServerOpenConfig & { topology: 'server' } {
  validateNativeStartupGUCs('server', config.startupGUCs ?? {});
  return {
    ...snapshotCommonOpenConfig(config),
    topology: 'server',
    serverExecutable: config.serverExecutable,
    listen: snapshotServerListen(config.listen),
  };
}

function snapshotCommonOpenConfig(config: OpenConfig | ServerOpenConfig) {
  return {
    storage: snapshotStorage(config.storage),
    startupGUCs: config.startupGUCs === undefined ? undefined : { ...config.startupGUCs },
    username: config.username,
    database: config.database,
    extensions: config.extensions === undefined ? undefined : [...config.extensions],
    runtimeDirectory: config.runtimeDirectory,
  };
}

function snapshotStorage(storage: DatabaseStorage | undefined): DatabaseStorage | undefined {
  if (storage === undefined) return undefined;
  return storage.kind === 'directory'
    ? { kind: 'directory', path: storage.path }
    : { kind: storage.kind };
}

function snapshotServerListen(listen: ServerListen | undefined): ServerListen | undefined {
  if (listen === undefined) return undefined;
  return listen.transport === 'tcp'
    ? { transport: 'tcp', port: listen.port }
    : { transport: 'unix', directory: listen.directory, port: listen.port };
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

function synchronousProtocolChunkConsumer(callback: (chunk: Uint8Array) => unknown): {
  callback: ProtocolChunkCallback;
  failure?: { error: unknown };
} {
  const consumer: {
    callback: ProtocolChunkCallback;
    failure?: { error: unknown };
  } = {
    callback(chunk) {
      try {
        const result = (callback as (chunk: Uint8Array) => unknown)(chunk);
        if (!isThenable(result)) return;
        // A synchronous chunk boundary cannot await caller work. Observe any
        // eventual rejection before reporting the contract violation.
        void Promise.resolve(result).catch(() => undefined);
        throw new TypeError(
          'raw protocol stream callback must complete synchronously and must not return a Promise or thenable',
        );
      } catch (error) {
        consumer.failure ??= { error };
        throw error;
      }
    },
  };
  return consumer;
}

function streamCallbackReentryError(): Error {
  return new Error(
    'raw protocol stream callback must not re-enter the same Oliphaunt handle; cancel remains available',
  );
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    ((typeof value === 'object' && value !== null) || typeof value === 'function') &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}
