import {
  backupJsi,
  execProtocolRawJsi,
  execProtocolStreamJsi,
  requireJsiRawProtocolTransport,
  restoreJsi,
  type JsiRawProtocolTransport,
  type JsiProtocolStreamOutcome,
} from './jsiTransport';
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
  responseTransactionStatus,
  structuredSimpleQuery,
  toUint8Array,
  type ByteInput,
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
} from './query';
import { generatedExtensionBySqlName } from './generated/extensions';
import type { NativeOpenConfig, Spec as NativeOliphauntModule } from './specs/NativeOliphaunt';

export type BinaryInput = ByteInput;
/** A synchronous, serial raw-protocol consumer used as the backpressure acknowledgement. */
type ProtocolChunkCallback = (chunk: Uint8Array) => undefined;

export type DatabaseStorage =
  | { readonly kind: 'temporaryDirectory' }
  | { readonly kind: 'directory'; readonly path: string }
  | { readonly kind: 'applicationData'; readonly name: string };

type QueryReadOptions = Omit<QueryOptions, 'encoders'>;

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
  readonly closed: boolean;
  execute(
    sql: string,
    parameters?: ReadonlyArray<QueryParam>,
    options?: ParameterOptions,
  ): Promise<CommandResult>;
  query<Row = never, const Options extends QueryOptions = {}>(
    sql: string,
    parameters?: ReadonlyArray<QueryParam>,
    options?: Options & QueryOptions,
  ): Promise<QueryResult<InferQueryRow<Options, Row>>>;
  queryRaw(
    sql: string,
    parameters?: ReadonlyArray<QueryParam>,
    options?: ParameterOptions,
  ): Promise<RawQueryResult>;
  exec<Row = never, const Options extends QueryReadOptions = {}>(
    sql: string,
    options?: Options & QueryReadOptions,
  ): Promise<ExecResult<InferQueryRow<Options, Row>>>;
  describe(sql: string, parameterTypeOids?: ReadonlyArray<number>): Promise<DescribeResult>;
  rollback(): Promise<void>;
};

export type OliphauntDatabase = {
  readonly closed: boolean;
  execute(
    sql: string,
    parameters?: ReadonlyArray<QueryParam>,
    options?: ParameterOptions,
  ): Promise<CommandResult>;
  query<Row = never, const Options extends QueryOptions = {}>(
    sql: string,
    parameters?: ReadonlyArray<QueryParam>,
    options?: Options & QueryOptions,
  ): Promise<QueryResult<InferQueryRow<Options, Row>>>;
  queryRaw(
    sql: string,
    parameters?: ReadonlyArray<QueryParam>,
    options?: ParameterOptions,
  ): Promise<RawQueryResult>;
  exec<Row = never, const Options extends QueryReadOptions = {}>(
    sql: string,
    options?: Options & QueryReadOptions,
  ): Promise<ExecResult<InferQueryRow<Options, Row>>>;
  describe(sql: string, parameterTypeOids?: ReadonlyArray<number>): Promise<DescribeResult>;
  execProtocolRaw(input: BinaryInput): Promise<Uint8Array>;
  execProtocolRawStream(input: BinaryInput, onChunk: ProtocolChunkCallback): Promise<void>;
  backup(): Promise<Uint8Array>;
  cancel(): Promise<void>;
  /**
   * Own the session for one callback. Use callback return/throw or rollback()
   * for lifecycle; manual BEGIN/START/COMMIT/END/ABORT/PREPARE TRANSACTION and
   * AND CHAIN are unsupported. SAVEPOINT and ROLLBACK TO are allowed.
   */
  transaction<T>(body: (transaction: OliphauntTransaction) => Promise<T> | T): Promise<T>;
  close(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
};

/** @internal Generation-bound cleanup payload; not exported by the package. */
export type ForgottenDatabase = Readonly<{
  generation: number;
  transport: JsiRawProtocolTransport;
}>;

/** @internal Deterministic lifecycle-test seam; not exported by the package. */
export type ForgottenDatabaseRegistry = {
  register(target: object, heldValue: ForgottenDatabase, unregisterToken: object): void;
  unregister(unregisterToken: object): boolean;
};

const forgottenDatabaseRegistry: ForgottenDatabaseRegistry | undefined =
  typeof FinalizationRegistry === 'function'
    ? new FinalizationRegistry<ForgottenDatabase>(({ generation, transport }) => {
        try {
          transport.closeIfGeneration(generation);
        } catch {
          // Module invalidation remains the process-lifecycle fallback.
        }
      })
    : undefined;

class NativeOliphauntDatabase implements OliphauntDatabase {
  readonly #native: NativeOliphauntModule;
  readonly #handle: number;
  readonly #jsiTransport: JsiRawProtocolTransport;
  readonly #forgottenRegistry?: ForgottenDatabaseRegistry;
  #closed = false;
  #closing = false;
  #closeTeardownStarted = false;
  #closeAttempt?: Promise<void>;
  readonly #activeCancellations = new Set<Promise<void>>();
  #operationTail = Promise.resolve();
  #activeTransaction = false;
  #streamCallbackActive = false;
  #poisoned?: Error;

  constructor(
    native: NativeOliphauntModule,
    handle: number,
    jsiTransport: JsiRawProtocolTransport,
    forgottenRegistry: ForgottenDatabaseRegistry | undefined,
  ) {
    this.#native = native;
    this.#handle = handle;
    this.#jsiTransport = jsiTransport;
    this.#forgottenRegistry = forgottenRegistry;
    forgottenRegistry?.register(
      this,
      Object.freeze({ generation: handle, transport: jsiTransport }),
      this,
    );
  }

  get closed(): boolean {
    return this.#closed;
  }

  execute(
    sql: string,
    parameters: ReadonlyArray<QueryParam> = [],
    options: ParameterOptions = {},
  ): Promise<CommandResult> {
    return this.#capturePromiseFailure(() => {
      this.#assertNoActiveTransaction();
      const plan = planQuery(sql, parameters, snapshotParameterOptions(options));
      return this.#serialize(() =>
        runQueryPlan(
          (input, parse) => this.#runOrdinaryExchangeUnlocked(input, parse),
          plan,
          parseCommandResponse,
        ),
      );
    });
  }

  query<Row = never, const Options extends QueryOptions = {}>(
    sql: string,
    parameters: ReadonlyArray<QueryParam> = [],
    options: Options & QueryOptions = {} as Options & QueryOptions,
  ): Promise<QueryResult<InferQueryRow<Options, Row>>> {
    return this.#capturePromiseFailure(() => {
      this.#assertNoActiveTransaction();
      const stableOptions = snapshotQueryOptions(options);
      const plan = planQuery(sql, parameters, stableOptions);
      return this.#serialize(async () => {
        const raw = await runQueryPlan(
          (input, parse) => this.#runOrdinaryExchangeUnlocked(input, parse),
          plan,
          parseQueryRawResponse,
        );
        return decodeQueryResult<Row, Options>(raw, stableOptions);
      });
    });
  }

  queryRaw(
    sql: string,
    parameters: ReadonlyArray<QueryParam> = [],
    options: ParameterOptions = {},
  ): Promise<RawQueryResult> {
    return this.#capturePromiseFailure(() => {
      this.#assertNoActiveTransaction();
      const plan = planQuery(sql, parameters, snapshotParameterOptions(options));
      return this.#serialize(() =>
        runQueryPlan(
          (input, parse) => this.#runOrdinaryExchangeUnlocked(input, parse),
          plan,
          parseQueryRawResponse,
        ),
      );
    });
  }

  exec<Row = never, const Options extends QueryReadOptions = {}>(
    sql: string,
    options: Options & QueryReadOptions = {} as Options & QueryReadOptions,
  ): Promise<ExecResult<InferQueryRow<Options, Row>>> {
    return this.#capturePromiseFailure(() => {
      this.#assertNoActiveTransaction();
      const input = structuredSimpleQuery(sql);
      const stableOptions = snapshotReadOptions(options);
      return this.#serialize(() =>
        this.#runOrdinaryExchangeUnlocked(input, (bytes) =>
          parseExecResponse<Row, Options>(bytes, stableOptions),
        ),
      );
    });
  }

  describe(sql: string, parameterTypeOids: ReadonlyArray<number> = []): Promise<DescribeResult> {
    return this.#capturePromiseFailure(() => {
      this.#assertNoActiveTransaction();
      const input = describeQuery(sql, [...parameterTypeOids]);
      return this.#serialize(() => this.#runOrdinaryExchangeUnlocked(input, parseDescribeResponse));
    });
  }

  execProtocolRaw(input: BinaryInput): Promise<Uint8Array> {
    return this.#capturePromiseFailure(() => {
      this.#assertNoActiveTransaction();
      const bytes = toUint8Array(input).slice();
      return this.#serialize(() => this.#runRawProtocolUnlocked(bytes));
    });
  }

  execProtocolRawStream(input: BinaryInput, onChunk: ProtocolChunkCallback): Promise<void> {
    return this.#capturePromiseFailure(() => {
      this.#assertNoActiveTransaction();
      if (typeof onChunk !== 'function') {
        throw new TypeError('protocol stream callback must be a function');
      }
      const bytes = toUint8Array(input).slice();
      return this.#serialize(() => {
        return this.#execProtocolStreamUnlocked(bytes, onChunk);
      });
    });
  }

  async #execProtocolRawUnlocked(input: BinaryInput): Promise<Uint8Array> {
    const requestBytes = toUint8Array(input);
    return this.#runNativeOperation(() =>
      execProtocolRawJsi(this.#jsiTransport, this.#handle, requestBytes),
    );
  }

  async #runRawProtocolUnlocked(input: BinaryInput): Promise<Uint8Array> {
    try {
      return await this.#execProtocolRawUnlocked(input);
    } catch (error) {
      this.#poison(asError(error, 'raw PostgreSQL transport outcome is unknown'));
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
    let outcome: JsiProtocolStreamOutcome;
    try {
      outcome = await this.#execProtocolStreamOutcomeUnlocked(input, onChunk);
    } catch (error) {
      this.#poison(asError(error, 'streaming raw PostgreSQL recovery was not proven'));
      throw error;
    }
    if (outcome.kind === 'callbackAborted') throw outcome.error;
  }

  async #execProtocolStreamOutcomeUnlocked(
    input: BinaryInput,
    onChunk: ProtocolChunkCallback,
  ): Promise<JsiProtocolStreamOutcome> {
    const consumer = synchronousProtocolChunkConsumer(
      onChunk,
      () => {
        this.#assertNotInProtocolStreamCallback();
        this.#streamCallbackActive = true;
      },
      () => {
        this.#streamCallbackActive = false;
      },
    );
    return execProtocolStreamJsi(this.#jsiTransport, this.#handle, toUint8Array(input), consumer);
  }

  backup(): Promise<Uint8Array> {
    return this.#capturePromiseFailure(() => {
      this.#assertNoActiveTransaction();
      return this.#serialize(() => {
        return this.#runNativeOperation(() => backupJsi(this.#jsiTransport, this.#handle));
      });
    });
  }

  async cancel(): Promise<void> {
    if (this.#closed || this.#closeTeardownStarted) {
      throw new Error('Oliphaunt database is closed');
    }
    // Cancellation must not wait behind the operation it is intended to interrupt.
    // A close admission cutoff does not revoke cancellation while previously
    // admitted work still drains; native teardown is the terminal boundary.
    const cancellation = this.#native.cancel(this.#handle);
    this.#activeCancellations.add(cancellation);
    try {
      await cancellation;
    } finally {
      this.#activeCancellations.delete(cancellation);
    }
  }

  transaction<T>(body: (transaction: OliphauntTransaction) => Promise<T> | T): Promise<T> {
    return this.#capturePromiseFailure(() => {
      this.#assertAvailable();
      if (typeof body !== 'function') {
        return Promise.reject(new TypeError('Oliphaunt transaction body must be a function'));
      }
      if (this.#activeTransaction) {
        return Promise.reject(new Error(transactionPinnedMessage));
      }
      this.#activeTransaction = true;
      const operation = this.#serialize(async () => {
        const transaction = new OliphauntTransactionHandle(
          (input, parse) => this.#runKnownExchangeUnlocked(input, parse, true),
          () => this.#rollbackControlUnlocked(),
          (cause) => this.#poison(cause),
        );
        try {
          await this.#beginControlUnlocked();

          let result: T;
          try {
            result = await body(transaction);
          } catch (bodyError) {
            const settlement = await transaction.sealAndDrain();
            if (
              settlement.kind === 'ready' ||
              (settlement.kind === 'failed' && settlement.needsRollback)
            ) {
              try {
                await this.#rollbackControlUnlocked();
              } catch (rollbackError) {
                throw transactionRollbackAggregate(bodyError, rollbackError);
              }
            }
            if (
              settlement.kind === 'failed' &&
              !settlement.needsRollback &&
              settlement.error !== bodyError
            ) {
              throw transactionCallbackAggregate(
                bodyError,
                settlement.error,
                'Oliphaunt transaction callback failed after an independent database failure',
              );
            }
            throw bodyError;
          }

          const settlement = await transaction.sealAndDrain();
          if (settlement.kind === 'rolledBack') {
            return result;
          }
          if (settlement.kind === 'failed') {
            if (settlement.needsRollback) {
              try {
                await this.#rollbackControlUnlocked();
              } catch (rollbackError) {
                throw transactionRollbackAggregate(settlement.error, rollbackError);
              }
            }
            throw settlement.error;
          }

          const commit = await this.#commitControlUnlocked();
          if (commit === 'rolledBack') {
            throw (
              transaction.firstFailure ??
              transactionBoundaryError('COMMIT', 'ROLLBACK', 'idle', 'idle')
            );
          }
          return result;
        } finally {
          transaction.expire();
        }
      });
      return operation.finally(() => {
        this.#activeTransaction = false;
      });
    });
  }

  close(): Promise<void> {
    return this.#capturePromiseFailure(() => {
      this.#assertNotInProtocolStreamCallback();
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
      const attempt = this.#operationTail
        .then(async () => {
          this.#closeTeardownStarted = true;
          await Promise.allSettled([...this.#activeCancellations]);
          return this.#native.close(this.#handle);
        })
        .then(() => {
          this.#closing = false;
          this.#closed = true;
          this.#forgottenRegistry?.unregister(this);
        })
        .catch((error: unknown) => {
          this.#closeTeardownStarted = false;
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
    });
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  #assertAvailable(): void {
    this.#assertNotInProtocolStreamCallback();
    if (this.#closed) {
      throw new Error('Oliphaunt database is closed');
    }
    if (this.#closeTeardownStarted) {
      throw new Error('Oliphaunt database is closed');
    }
    if (this.#closing) {
      throw new Error('Oliphaunt database is closing');
    }
    this.#assertHealthy();
  }

  #assertHealthy(): void {
    if (this.#poisoned !== undefined) throw this.#poisoned;
  }

  #assertNoActiveTransaction(): void {
    this.#assertAvailable();
    if (this.#activeTransaction) {
      throw new Error(transactionPinnedMessage);
    }
  }

  #assertNotInProtocolStreamCallback(): void {
    if (this.#streamCallbackActive) {
      throw new Error(
        'raw protocol stream callback must not reenter the same Oliphaunt database or transaction',
      );
    }
  }

  #capturePromiseFailure<T>(body: () => Promise<T>): Promise<T> {
    try {
      return body();
    } catch (error) {
      return Promise.reject(error);
    }
  }

  #serialize<T>(body: () => T | Promise<T>): Promise<T> {
    const operation = this.#operationTail.then(async () => {
      this.#assertHealthy();
      return body();
    });
    this.#operationTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  async #runNativeOperation<T>(body: () => Promise<T>): Promise<T> {
    return body();
  }

  async #runKnownExchangeUnlocked<T extends object>(
    input: BinaryInput,
    parse: (bytes: Uint8Array) => T,
    managedTransaction = false,
  ): Promise<T> {
    let response: Uint8Array;
    try {
      response = await this.#execProtocolRawUnlocked(input);
    } catch (error) {
      const failure = asError(error, 'Oliphaunt transport failed before PostgreSQL readiness');
      this.#poison(failure);
      throw failure;
    }

    let inspectedStatus: TransactionStatus;
    try {
      inspectedStatus = managedTransaction
        ? inspectManagedTransactionResponse(response)
        : inspectReadyForQuery(response);
    } catch (error) {
      const failure = asError(error, 'structured response has no valid ReadyForQuery boundary');
      this.#poison(failure);
      throw failure;
    }

    try {
      const result = parse(response);
      const parsedStatus = responseTransactionStatus(result);
      if (parsedStatus !== undefined && parsedStatus !== inspectedStatus) {
        const failure = new Error('structured parser disagreed with the ReadyForQuery boundary');
        this.#poison(failure);
        throw failure;
      }
      observedTransactionStatuses.set(result, inspectedStatus);
      return result;
    } catch (error) {
      const failure = asError(error, 'Oliphaunt could not parse the PostgreSQL response');
      observedTransactionStatuses.set(failure, inspectedStatus);
      throw failure;
    }
  }

  async #runOrdinaryExchangeUnlocked<T extends object>(
    input: BinaryInput,
    parse: (bytes: Uint8Array) => T,
  ): Promise<T> {
    let result: T;
    try {
      result = await this.#runKnownExchangeUnlocked(input, parse);
    } catch (error) {
      const failure = asError(error);
      const status = observedTransactionStatus(failure);
      if (status === 'transaction' || status === 'failed') {
        await this.#recoverToIdleUnlocked(failure);
      }
      throw failure;
    }

    const status = requiredTransactionStatus(result);
    if (status === 'idle') return result;
    const failure = new Error(
      `structured operation ended with PostgreSQL transaction status '${status}' outside a callback transaction`,
    );
    await this.#recoverToIdleUnlocked(failure);
    throw failure;
  }

  async #recoverToIdleUnlocked(primary: Error): Promise<void> {
    let recoveryFailure: Error | undefined;
    try {
      const result = await this.#runKnownExchangeUnlocked(
        extendedQuery('ROLLBACK', []),
        parseCommandResponse,
      );
      const status = requiredTransactionStatus(result);
      if (status !== 'idle' || result.commandTag !== 'ROLLBACK') {
        recoveryFailure = transactionBoundaryError('ROLLBACK', result.commandTag, 'idle', status);
      }
    } catch (error) {
      recoveryFailure = asError(error);
    }
    if (recoveryFailure !== undefined) {
      const lifecycleFailure = new AggregateError(
        [primary, recoveryFailure],
        'Oliphaunt operation failed and automatic ROLLBACK could not prove recovery',
      );
      this.#poison(lifecycleFailure, true);
      throw lifecycleFailure;
    }
  }

  async #beginControlUnlocked(): Promise<void> {
    let result: CommandResult;
    try {
      result = await this.#runKnownExchangeUnlocked(
        extendedQuery('BEGIN', []),
        parseCommandResponse,
      );
    } catch (error) {
      const failure = asError(error);
      const status = observedTransactionStatus(failure);
      if (status === 'transaction' || status === 'failed') {
        await this.#recoverToIdleUnlocked(failure);
      }
      throw failure;
    }
    const status = requiredTransactionStatus(result);
    if (result.commandTag === 'BEGIN' && status === 'transaction') return;
    const failure = transactionBoundaryError('BEGIN', result.commandTag, 'transaction', status);
    if (status !== 'idle') await this.#recoverToIdleUnlocked(failure);
    throw failure;
  }

  async #commitControlUnlocked(): Promise<'committed' | 'rolledBack'> {
    let result: CommandResult;
    try {
      result = await this.#runKnownExchangeUnlocked(
        extendedQuery('COMMIT', []),
        parseCommandResponse,
      );
    } catch (error) {
      const failure = asError(error);
      this.#poison(errorWithCause('COMMIT outcome is unknown; close the database', failure));
      throw failure;
    }
    const status = requiredTransactionStatus(result);
    if (result.commandTag === 'COMMIT' && status === 'idle') return 'committed';
    if (result.commandTag === 'ROLLBACK' && status === 'idle') return 'rolledBack';
    const failure = transactionBoundaryError('COMMIT', result.commandTag, 'idle', status);
    this.#poison(errorWithCause('COMMIT outcome is unknown; close the database', failure));
    throw failure;
  }

  async #rollbackControlUnlocked(): Promise<void> {
    try {
      const result = await this.#runKnownExchangeUnlocked(
        extendedQuery('ROLLBACK', []),
        parseCommandResponse,
      );
      const status = requiredTransactionStatus(result);
      if (result.commandTag === 'ROLLBACK' && status === 'idle') return;
      const failure = transactionBoundaryError('ROLLBACK', result.commandTag, 'idle', status);
      this.#poison(failure);
      throw failure;
    } catch (error) {
      const failure = asError(error);
      this.#poison(errorWithCause('ROLLBACK failed; PostgreSQL session state is unknown', failure));
      throw failure;
    }
  }

  #poison(cause: Error, replace = false): void {
    if (!replace && this.#poisoned !== undefined) return;
    this.#poisoned = errorWithCause(
      'Oliphaunt PostgreSQL session state is unknown; close the database',
      cause,
    );
  }
}

type StructuredExchange = <T extends object>(
  input: BinaryInput,
  parse: (bytes: Uint8Array) => T,
) => Promise<T>;

type TransactionState = 'active' | 'finishing' | 'rolledBack' | 'failed' | 'expired';

type TransactionSettlement =
  | Readonly<{ kind: 'ready' }>
  | Readonly<{ kind: 'rolledBack' }>
  | Readonly<{ kind: 'failed'; error: Error; needsRollback: boolean }>;

class OliphauntTransactionHandle implements OliphauntTransaction {
  readonly #exchange: StructuredExchange;
  readonly #rollbackControl: () => Promise<void>;
  readonly #poison: (cause: Error) => void;
  #state: TransactionState = 'active';
  #tail = Promise.resolve();
  #failure?: Readonly<{ error: Error; needsRollback: boolean }>;
  #firstFailure?: Error;

  constructor(
    exchange: StructuredExchange,
    rollbackControl: () => Promise<void>,
    poison: (cause: Error) => void,
  ) {
    this.#exchange = exchange;
    this.#rollbackControl = rollbackControl;
    this.#poison = poison;
  }

  get closed(): boolean {
    return this.#state !== 'active';
  }

  get firstFailure(): Error | undefined {
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
      return this.#enqueue(() =>
        runQueryPlan(
          (input, parse) => this.#runTransactionExchange(input, parse),
          plan,
          parseCommandResponse,
        ),
      );
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
        const raw = await runQueryPlan(
          (input, parse) => this.#runTransactionExchange(input, parse),
          plan,
          parseQueryRawResponse,
        );
        return decodeQueryResult<Row, Options>(raw, stableOptions);
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
      return this.#enqueue(() =>
        runQueryPlan(
          (input, parse) => this.#runTransactionExchange(input, parse),
          plan,
          parseQueryRawResponse,
        ),
      );
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
        this.#runTransactionExchange(input, (bytes) =>
          parseExecResponse<Row, Options>(bytes, stableOptions),
        ),
      );
    });
  }

  describe(sql: string, parameterTypeOids: ReadonlyArray<number> = []): Promise<DescribeResult> {
    return promiseFromSynchronousCall(() => {
      const input = describeQuery(sql, [...parameterTypeOids]);
      return this.#enqueue(() => this.#runTransactionExchange(input, parseDescribeResponse));
    });
  }

  rollback(): Promise<void> {
    try {
      this.#assertActive();
      this.#state = 'finishing';
      return this.#enqueueAdmitted(async () => {
        try {
          await this.#rollbackControl();
          this.#state = 'rolledBack';
        } catch (error) {
          this.#markFailed(asError(error), false);
          throw error;
        }
      });
    } catch (error) {
      return Promise.reject(error);
    }
  }

  async sealAndDrain(): Promise<TransactionSettlement> {
    if (this.#state === 'active') this.#state = 'finishing';
    await this.#tail;
    if (this.#state === 'rolledBack') return { kind: 'rolledBack' };
    if (this.#state === 'failed') {
      const failure = this.#failure;
      if (failure === undefined) {
        throw new Error('transaction failed without retaining its cause');
      }
      return { kind: 'failed', ...failure };
    }
    return { kind: 'ready' };
  }

  expire(): void {
    this.#state = 'expired';
  }

  #enqueue<T>(body: () => T | Promise<T>): Promise<T> {
    try {
      this.#assertActive();
      return this.#enqueueAdmitted(body);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  #enqueueAdmitted<T>(body: () => T | Promise<T>): Promise<T> {
    const operation = this.#tail.then(body);
    this.#tail = operation.then(
      () => undefined,
      (error: unknown) => {
        this.#firstFailure ??= asError(error);
      },
    );
    return operation;
  }

  async #runTransactionExchange<T extends object>(
    input: BinaryInput,
    parse: (bytes: Uint8Array) => T,
  ): Promise<T> {
    let result: T;
    try {
      result = await this.#exchange(input, parse);
    } catch (error) {
      const failure = asError(error);
      const status = observedTransactionStatus(failure);
      if (status === undefined || status === 'idle') {
        this.#markFailed(failure, false);
        this.#poison(failure);
      }
      throw failure;
    }

    const status = requiredTransactionStatus(result);
    if (status === 'transaction') return result;
    const failure = new Error(
      `callback transaction operation ended with PostgreSQL status '${status}'`,
    );
    this.#markFailed(failure, status === 'failed');
    if (status === 'idle') this.#poison(failure);
    throw failure;
  }

  #markFailed(error: Error, needsRollback: boolean): void {
    this.#failure ??= { error, needsRollback };
    this.#state = 'failed';
  }

  #assertActive(): void {
    if (this.#state !== 'active') {
      throw new Error('transaction is no longer active');
    }
  }
}

type NoticeCarrier = { notices: PostgresNotice[] };

async function runQueryPlan<T extends NoticeCarrier>(
  exchange: StructuredExchange,
  plan: QueryPlan,
  parse: (bytes: Uint8Array) => T,
): Promise<T> {
  if (plan.kind === 'complete') return exchange(plan.input, parse);
  const description = await exchange(plan.input, parseDescribeResponse);
  let input: Uint8Array;
  try {
    input = plan.bind(description.parameterTypeOids);
  } catch (error) {
    throw errorWithNotices(error, description.notices);
  }
  try {
    return prependNotices(await exchange(input, parse), description.notices);
  } catch (error) {
    throw errorWithNotices(error, description.notices);
  }
}

function snapshotParameterOptions(options: ParameterOptions): ParameterOptions {
  return Object.freeze({
    ...(options.encoders === undefined ? {} : { encoders: Object.freeze({ ...options.encoders }) }),
  });
}

function promiseFromSynchronousCall<T>(body: () => Promise<T>): Promise<T> {
  try {
    return body();
  } catch (error) {
    return Promise.reject(error);
  }
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

function prependNotices<T extends NoticeCarrier>(
  result: T,
  notices: ReadonlyArray<PostgresNotice>,
): T {
  if (notices.length > 0) result.notices.unshift(...notices);
  return result;
}

const transactionPinnedMessage = 'physical session is pinned; use the active OliphauntTransaction';
const observedTransactionStatuses = new WeakMap<object, TransactionStatus>();

function observedTransactionStatus(value: object): TransactionStatus | undefined {
  return responseTransactionStatus(value) ?? observedTransactionStatuses.get(value);
}

function requiredTransactionStatus(value: object): TransactionStatus {
  const status = observedTransactionStatus(value);
  if (status === undefined) {
    throw new Error('structured operation did not retain its ReadyForQuery status');
  }
  return status;
}

function transactionBoundaryError(
  command: string,
  actualTag: string | undefined,
  expectedStatus: TransactionStatus,
  actualStatus: TransactionStatus,
): Error {
  return new Error(
    `PostgreSQL transaction command expected ${command}/${expectedStatus}, got ${
      actualTag ?? 'no command tag'
    }/${actualStatus}`,
  );
}

function synchronousProtocolChunkConsumer(
  callback: ProtocolChunkCallback,
  enter: () => void,
  leave: () => void,
): ProtocolChunkCallback {
  return (chunk) => {
    enter();
    try {
      const result = (callback as (chunk: Uint8Array) => unknown)(chunk);
      if (isThenable(result)) {
        // The native callback boundary cannot await caller work. Observe an
        // eventual rejection before failing this stream deterministically.
        void Promise.resolve(result).catch(() => undefined);
        throw new TypeError(
          'raw protocol stream callback must complete synchronously and must not return a Promise or thenable',
        );
      }
    } finally {
      leave();
    }
  };
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    ((typeof value === 'object' && value !== null) || typeof value === 'function') &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

function asError(error: unknown, fallback = 'Oliphaunt operation failed'): Error {
  if (error instanceof Error) return error;
  const normalized = errorWithCause(fallback, error);
  if (error !== null && (typeof error === 'object' || typeof error === 'function')) {
    try {
      const notices = (error as { notices?: unknown }).notices;
      if (Array.isArray(notices)) {
        return errorWithNotices(normalized, notices as PostgresNotice[]) as Error;
      }
    } catch {
      // The normalized error still retains a hostile thrown object as cause.
    }
  }
  return normalized;
}

function errorWithCause(message: string, cause: unknown): Error {
  const error = new Error(message) as Error & { cause?: unknown };
  error.cause = cause;
  return error;
}

function transactionRollbackAggregate(primary: unknown, rollback: unknown): AggregateError {
  return transactionCallbackAggregate(
    primary,
    rollback,
    'Oliphaunt transaction failed and automatic ROLLBACK could not prove recovery',
  );
}

function transactionCallbackAggregate(
  callback: unknown,
  secondary: unknown,
  message: string,
): AggregateError {
  return new AggregateError([callback, secondary], message);
}

/** @internal Package bootstrap and deterministic test injection only. */
export function createOliphauntClient(
  native: NativeOliphauntModule,
  registry: ForgottenDatabaseRegistry | undefined = forgottenDatabaseRegistry,
): OliphauntClient {
  const client = {
    async open(config: OpenConfig = {}): Promise<OliphauntDatabase> {
      const nativeConfig = normalizeOpenConfig(config);
      const jsiTransport = requireJsiRawProtocolTransport();
      const handle = await native.open(nativeConfig);
      return new NativeOliphauntDatabase(native, handle, jsiTransport, registry);
    },
    async restore(destination: RestoreDestination, backup: BinaryInput): Promise<void> {
      const storage = normalizeRestoreDestination(destination);
      const bytes = toUint8Array(backup).slice();
      await restoreJsi(requireJsiRawProtocolTransport(), storage, bytes);
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
  validateStartupIdentity(config.username, 'username');
  validateStartupIdentity(config.database, 'database');
  const startupGUCs = config.startupGUCs ? validateStartupGUCs(config.startupGUCs) : undefined;
  const storage = normalizeDatabaseStorage(config.storage);
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
  const entries = Object.entries(gucs).map(([name, value]) => {
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
    const canonicalName = trimmedName.toLowerCase();
    if (canonicalName === 'config_file' || canonicalName === 'data_directory') {
      throw new Error(
        `Oliphaunt owns PostgreSQL startup GUC '${canonicalName}'; configure database storage through Oliphaunt open options`,
      );
    }
    return { name: canonicalName, value };
  });
  const lastIndexByName = new Map<string, number>();
  entries.forEach(({ name }, index) => lastIndexByName.set(name, index));
  return entries
    .filter(({ name }, index) => lastIndexByName.get(name) === index)
    .map(({ name, value }) => `${name}=${value}`);
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
