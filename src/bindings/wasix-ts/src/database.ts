import { composeWasixStorageFailure, WasixStorageError } from './errors.js';
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
import type { WasixStorageSyncBoundary } from './storage-provider.js';
import type { WasixProtocolConnection } from './pgwire-connection.js';
import type {
  WasixPgDumpProcessOptions,
  WasixToolProcessOptions,
  WasixToolProcessResult,
} from './tool-runtime.js';
import type {
  BinaryInput,
  OliphauntDatabase,
  OliphauntTransaction,
  ProtocolChunkCallback,
} from './types.js';

const transactionPinnedMessage =
  'Oliphaunt WASIX database is pinned to an active transaction; use the callback transaction handle';
const CLOSE_DEADLINE_MS = 120_000;
/** @internal Buffered protocol fallbacks use the same observable callback granularity. */
export const WASIX_PROTOCOL_CALLBACK_CHUNK_BYTES = 64 * 1024;
const pgDumpTargets = new WeakSet<OliphauntDatabase>();
const protocolConnectionTargets = new WeakSet<OliphauntDatabase>();
const transactionPinnedTargets = new WeakSet<OliphauntDatabase>();

type QueryReadOptions = Omit<QueryOptions, 'encoders'>;

/** @internal Publish a promise before starting reentrant ownership teardown. */
export function createWasixDeferred<T>(): Readonly<{
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(error: unknown): void;
}> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

export type WasixDatabaseIdentity = Readonly<{
  username: string;
  database: string;
}>;

export type WasixDatabaseResource = Readonly<{
  close(): void | Promise<void>;
}>;

/** @internal Observable ownership loss for execution sessions with a fallible transport. */
export type WasixDatabaseSessionTerminalState = Readonly<{
  /** True only after the execution owner has terminated unexpectedly. */
  readonly terminal: boolean;
  /** The first transport failure that made the execution owner terminal. */
  readonly failure: Error | undefined;
}>;

/** @internal Apply PostgreSQL's default database-name rule once at open. */
export function normalizeWasixDatabaseIdentity(
  username: string,
  database: string,
): WasixDatabaseIdentity {
  return { username, database: database === '' ? username : database };
}

/** @internal Host-publication policy for one pgwire exchange. */
export type WasixPersistenceMode = 'sync' | 'defer';
export type WasixProtocolConnectionMode = 'server' | 'tool';
/** @internal Whether a stream completed normally or recovered after stopping callback delivery. */
export type WasixProtocolStreamOutcome = 'complete' | 'callbackAborted';

/** @internal A database FIFO slot whose guest connection starts explicitly. */
export type WasixProtocolConnectionReservation = Readonly<{
  start(): Promise<void>;
  cancel(): void;
}>;

type PendingProtocolConnectionReservation = Readonly<{
  cancel(error: Error): void;
}>;

/** @internal Execution seam shared by caller- and package-owned database handles. */
export type WasixDatabaseSession = {
  /** The session can safely block away from its public caller while serving a connection. */
  readonly supportsProtocolConnections?: boolean;
  readonly identity?: WasixDatabaseIdentity;
  /** Optional shared state for an execution owner that can die independently of the handle. */
  readonly terminalState?: WasixDatabaseSessionTerminalState;
  exec(input: Uint8Array, persistence?: WasixPersistenceMode): Promise<Uint8Array>;
  execStream?(
    input: Uint8Array,
    onChunk: ProtocolChunkCallback,
    persistence?: WasixPersistenceMode,
  ): Promise<WasixProtocolStreamOutcome>;
  sync(boundary: WasixStorageSyncBoundary): Promise<void>;
  /** Internal test seams may omit backup; production sessions always provide it. */
  backup?(): Promise<Uint8Array>;
  runPgDump?(options: WasixPgDumpProcessOptions): Promise<WasixToolProcessResult>;
  serve?(connection: WasixProtocolConnection, mode: WasixProtocolConnectionMode): Promise<void>;
  /**
   * Begin the session's one terminal teardown attempt.
   *
   * Implementations must stop admitting work immediately, return the same
   * promise to every later caller, and remain terminal even when teardown
   * rejects after owned transport or host resources have been destroyed.
   */
  close(): Promise<void>;
  /** Force-stop an SDK-owned execution lane when orderly shutdown stalls. */
  abort?(): void | Promise<void>;
};

type ForgottenDatabaseGeneration = Readonly<Record<never, never>>;

type FinalizationRegistryLike = Readonly<{
  register(target: object, heldValue: ForgottenDatabaseGeneration, unregisterToken: object): void;
  unregister(unregisterToken: object): boolean;
}>;

type FinalizationRegistryFactory = (
  cleanup: (generation: ForgottenDatabaseGeneration) => void,
) => FinalizationRegistryLike;

export type WasixForgottenDatabaseRegistration = Readonly<{
  generation: ForgottenDatabaseGeneration;
}>;

/**
 * Tracks only session owners, never their public database handles.
 *
 * The finalizer's held value is an opaque generation token. The session lives
 * in a separately keyed table, so an already queued finalizer can atomically
 * prove that it still owns the exact registration before scheduling cleanup.
 *
 * @internal
 */
export class WasixForgottenDatabaseRegistry {
  readonly #active = new Map<ForgottenDatabaseGeneration, WasixDatabaseSession>();
  readonly #finalizer: FinalizationRegistryLike;
  readonly #schedule: (work: () => void) => void;

  constructor(
    createRegistry: FinalizationRegistryFactory = (cleanup) => new FinalizationRegistry(cleanup),
    schedule: (work: () => void) => void = queueMicrotask,
  ) {
    this.#schedule = schedule;
    this.#finalizer = createRegistry((generation) => this.#finalize(generation));
  }

  register(owner: object, session: WasixDatabaseSession): WasixForgottenDatabaseRegistration {
    // Object identity is the generation. It cannot wrap, be forged by a stale
    // callback, or retain the public owner through the held value.
    const generation: ForgottenDatabaseGeneration = Object.freeze({});
    this.#finalizer.register(owner, generation, generation);
    this.#active.set(generation, session);
    return Object.freeze({ generation });
  }

  unregister(registration: WasixForgottenDatabaseRegistration): void {
    // Remove the cleanup authority first. A finalizer callback that was already
    // queued then observes a stale generation and is a harmless no-op.
    this.#active.delete(registration.generation);
    this.#finalizer.unregister(registration.generation);
  }

  #finalize(generation: ForgottenDatabaseGeneration): void {
    const session = this.#active.get(generation);
    if (session === undefined) return;
    this.#active.delete(generation);

    // Finalization callbacks must stay nonblocking. Caller-realm teardown may
    // execute synchronous guest code, so even invoking close is deferred until
    // after the callback returns. Cleanup is intentionally unobservable best
    // effort; explicit close remains the only way to observe its outcome.
    this.#schedule(() => {
      void closeForgottenSession(session).catch(() => undefined);
    });
  }
}

async function closeForgottenSession(session: WasixDatabaseSession): Promise<void> {
  if (session.abort !== undefined) {
    await session.abort();
    return;
  }
  await session.close();
}

const forgottenDatabaseRegistry =
  typeof FinalizationRegistry === 'undefined' ? undefined : new WasixForgottenDatabaseRegistry();

/** @internal Public database state machine; construction stays behind Oliphaunt.open(). */
export class WasixDatabaseImpl implements OliphauntDatabase {
  readonly #session: WasixDatabaseSession;
  readonly #identity: WasixDatabaseIdentity;
  readonly #forgottenRegistry: WasixForgottenDatabaseRegistry | undefined;
  readonly #forgottenRegistration: WasixForgottenDatabaseRegistration | undefined;
  readonly #resources = new Set<WasixDatabaseResource>();
  readonly #pendingProtocolConnections = new Set<PendingProtocolConnectionReservation>();
  #tail = Promise.resolve();
  #closed = false;
  #closing = false;
  #closeAttempt: Promise<void> | undefined;
  #persistenceFailure: WasixStorageError | undefined;
  #transactionFailure: Error | undefined;
  #activeTransaction = false;
  #transactionRunning = false;
  #streamCallbackActive = false;

  constructor(
    session: WasixDatabaseSession,
    forgottenRegistry: WasixForgottenDatabaseRegistry | undefined = forgottenDatabaseRegistry,
  ) {
    this.#session = session;
    this.#forgottenRegistry = forgottenRegistry;
    this.#forgottenRegistration = forgottenRegistry?.register(this, session);
    this.#identity = session.identity ?? {
      username: 'postgres',
      database: 'postgres',
    };
    if (session.runPgDump !== undefined) pgDumpTargets.add(this);
    if (session.supportsProtocolConnections === true && session.serve !== undefined) {
      protocolConnectionTargets.add(this);
    }
  }

  get closed(): boolean {
    return this.#closed || this.#session.terminalState?.terminal === true;
  }

  async execute(
    sql: string,
    parameters: ReadonlyArray<QueryParam> = [],
    options: ParameterOptions = {},
  ): Promise<CommandResult> {
    this.#assertAvailable();
    const plan = planQuery(sql, parameters, snapshotParameterOptions(options));
    return this.#serialize(() => this.#runDatabasePlanUnlocked(plan, parseCommandResponse));
  }

  async query<Row = never, const Options extends QueryOptions = {}>(
    sql: string,
    parameters: ReadonlyArray<QueryParam> = [],
    options: Options & QueryOptions = {} as Options & QueryOptions,
  ): Promise<QueryResult<InferQueryRow<Options, Row>>> {
    this.#assertAvailable();
    const stableOptions = snapshotQueryOptions(options);
    const plan = planQuery(sql, parameters, stableOptions);
    return this.#serialize(() =>
      this.#runDatabasePlanUnlocked(plan, (response) =>
        decodeQueryResult<Row, Options>(parseQueryRawResponse(response), stableOptions),
      ),
    );
  }

  async queryRaw(
    sql: string,
    parameters: ReadonlyArray<QueryParam> = [],
    options: ParameterOptions = {},
  ): Promise<RawQueryResult> {
    this.#assertAvailable();
    const plan = planQuery(sql, parameters, snapshotParameterOptions(options));
    return this.#serialize(() => this.#runDatabasePlanUnlocked(plan, parseQueryRawResponse));
  }

  async exec<Row = never, const Options extends QueryReadOptions = {}>(
    sql: string,
    options: Options & QueryReadOptions = {} as Options & QueryReadOptions,
  ): Promise<ExecResult<InferQueryRow<Options, Row>>> {
    this.#assertAvailable();
    const input = structuredSimpleQuery(sql);
    const stableOptions = snapshotReadOptions(options);
    return this.#serialize(() =>
      this.#runDatabaseStructuredUnlocked(input, (response) =>
        parseExecResponse<Row, Options>(response, stableOptions),
      ),
    );
  }

  async describe(
    sql: string,
    parameterTypeOids: ReadonlyArray<number> = [],
  ): Promise<DescribeResult> {
    this.#assertAvailable();
    const input = describeQuery(sql, [...parameterTypeOids]);
    return this.#serialize(() => this.#runDatabaseStructuredUnlocked(input, parseDescribeResponse));
  }

  async execProtocolRaw(input: BinaryInput): Promise<Uint8Array> {
    return this.#execOwned(toUint8Array(input).slice());
  }

  async execProtocolRawStream(input: BinaryInput, onChunk: ProtocolChunkCallback): Promise<void> {
    if (typeof onChunk !== 'function') {
      throw new TypeError('raw protocol stream callback must be a function');
    }
    const consumer = this.#protocolChunkConsumer(onChunk);
    this.#assertAvailable();
    const bytes = toUint8Array(input).slice();
    await this.#serialize(async () => {
      this.#assertHealthy();
      if (this.#session.execStream === undefined) {
        let response: Uint8Array;
        try {
          response = await this.#session.exec(bytes, 'sync');
        } catch (error) {
          this.#recordUnknownExchange(error, 'streaming PostgreSQL transport outcome is unknown');
          throw error;
        }
        for (
          let offset = 0;
          offset < response.length;
          offset += WASIX_PROTOCOL_CALLBACK_CHUNK_BYTES
        ) {
          consumer.callback(response.slice(offset, offset + WASIX_PROTOCOL_CALLBACK_CHUNK_BYTES));
        }
        return;
      }

      let outcome: WasixProtocolStreamOutcome;
      try {
        outcome = await this.#session.execStream(bytes, consumer.callback, 'sync');
      } catch (error) {
        this.#recordUnknownExchange(error, 'streaming PostgreSQL transport outcome is unknown');
        throw error;
      }
      this.#resolveProtocolStreamOutcome(outcome, consumer.failure);
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

  /** @internal Run pg_dump in the database-owning execution realm without another transport. */
  runPgDump(options: WasixToolProcessOptions): Promise<WasixToolProcessResult> {
    this.#assertAvailable();
    return this.#serialize(async () => {
      this.#assertHealthy();
      if (this.#session.runPgDump === undefined) {
        throw new Error('this WASIX database entrypoint does not support pg_dump');
      }
      return this.#session.runPgDump(options);
    });
  }

  /** @internal Serialized connection ownership used by optional server/tool packages. */
  runProtocolConnection(
    connection: WasixProtocolConnection,
    mode: WasixProtocolConnectionMode,
  ): Promise<void> {
    return this.reserveProtocolConnection(connection, mode).start();
  }

  /** @internal Reserve call order without entering the guest before a client is ready. */
  reserveProtocolConnection(
    connection: WasixProtocolConnection,
    mode: WasixProtocolConnectionMode,
  ): WasixProtocolConnectionReservation {
    this.#assertAvailable();
    let state: 'pending' | 'started' | 'canceled' = 'pending';
    let cancellation: Error | undefined;
    let resolveStart: ((start: boolean) => void) | undefined;
    const startDecision = new Promise<boolean>((resolve) => {
      resolveStart = resolve;
    });
    const pending: PendingProtocolConnectionReservation = {
      cancel(error) {
        if (state !== 'pending') return;
        state = 'canceled';
        cancellation = error;
        resolveStart?.(false);
      },
    };
    this.#pendingProtocolConnections.add(pending);
    const serving = this.#serialize(async () => {
      const start = await startDecision;
      this.#pendingProtocolConnections.delete(pending);
      if (!start) return;
      this.#assertHealthy();
      if (this.#session.serve === undefined) {
        throw new Error('this WASIX database entrypoint does not support protocol connections');
      }
      if (!this.#session.supportsProtocolConnections) {
        throw new Error('WASIX psql and local servers require @oliphaunt/wasix-ts/worker');
      }
      try {
        await this.#session.serve(connection, mode);
      } catch (error) {
        if (error instanceof WasixStorageError) this.#persistenceFailure = error;
        throw error;
      }
    });
    return {
      start() {
        if (state === 'canceled') {
          throw cancellation ?? new Error('Oliphaunt WASIX protocol connection was canceled');
        }
        if (state === 'pending') {
          state = 'started';
          resolveStart?.(true);
        }
        return serving;
      },
      cancel() {
        pending.cancel(new Error('Oliphaunt WASIX protocol connection was canceled before start'));
      },
    };
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

  async #runDatabasePlanUnlocked<Result extends NoticeCarrier>(
    plan: QueryPlan,
    decode: (response: Uint8Array) => Result,
  ): Promise<Result> {
    if (plan.kind === 'complete') {
      return this.#runDatabaseStructuredUnlocked(plan.input, decode);
    }

    const describedExchange = await this.#exchangeKnownUnlocked(plan.input, 'database');
    if (describedExchange.status !== 'idle') {
      return this.#finishDatabaseExchangeUnlocked(
        describedExchange,
        parseDescribeResponse as unknown as (response: Uint8Array) => Result,
        'operation',
      );
    }

    let description: DescribeResult;
    try {
      description = parseDescribeResponse(describedExchange.response);
    } catch (error) {
      return this.#publishLogicalFailureUnlocked(error, 'operation');
    }

    let input: Uint8Array;
    try {
      input = plan.bind(description.parameterTypeOids);
    } catch (error) {
      return this.#publishLogicalFailureUnlocked(
        errorWithNotices(error, description.notices),
        'operation',
      );
    }

    const finalExchange = await this.#exchangeKnownUnlocked(input, 'database');
    return this.#finishDatabaseExchangeUnlocked(
      finalExchange,
      (response) => {
        try {
          return prependNotices(decode(response), description.notices);
        } catch (error) {
          throw errorWithNotices(error, description.notices);
        }
      },
      'operation',
    );
  }

  async #runDatabaseStructuredUnlocked<Result>(
    input: Uint8Array,
    decode: (response: Uint8Array) => Result,
    boundary: WasixStorageSyncBoundary = 'operation',
  ): Promise<Result> {
    const exchange = await this.#exchangeKnownUnlocked(input, 'database');
    return this.#finishDatabaseExchangeUnlocked(exchange, decode, boundary);
  }

  async #finishDatabaseExchangeUnlocked<Result>(
    exchange: KnownExchange,
    decode: (response: Uint8Array) => Result,
    boundary: WasixStorageSyncBoundary,
  ): Promise<Result> {
    if (exchange.status !== 'idle') {
      await this.#executeTransactionControlUnlocked('ROLLBACK');
    }

    let result: Result | undefined;
    let failure: unknown;
    try {
      result = decode(exchange.response);
      if (exchange.status !== 'idle') {
        failure = new Error(
          `structured database operation ended with PostgreSQL transaction status ${exchange.status}; Oliphaunt rolled it back`,
        );
        if (isNoticeCarrier(result)) {
          failure = errorWithNotices(failure, result.notices);
        }
      }
    } catch (error) {
      failure = error;
    }

    try {
      await this.#syncPersistence(boundary);
    } catch (persistenceError) {
      if (failure !== undefined) {
        throw composeWasixStorageFailure(
          persistenceError as WasixStorageError,
          'operation also failed',
          failure,
        );
      }
      throw persistenceError;
    }
    if (failure !== undefined) throw failure;
    return result as Result;
  }

  async #publishLogicalFailureUnlocked(
    failure: unknown,
    boundary: WasixStorageSyncBoundary,
  ): Promise<never> {
    try {
      await this.#syncPersistence(boundary);
    } catch (persistenceError) {
      throw composeWasixStorageFailure(
        persistenceError as WasixStorageError,
        'operation also failed',
        failure,
      );
    }
    throw failure;
  }

  async #runTransactionPlanUnlocked<Result extends NoticeCarrier>(
    plan: QueryPlan,
    decode: (response: Uint8Array) => Result,
  ): Promise<Result> {
    if (plan.kind === 'complete') {
      return this.#runTransactionStructuredUnlocked(plan.input, decode);
    }
    const described = await this.#runTransactionStructuredUnlocked(
      plan.input,
      parseDescribeResponse,
    );
    let input: Uint8Array;
    try {
      input = plan.bind(described.parameterTypeOids);
    } catch (error) {
      throw errorWithNotices(error, described.notices);
    }
    try {
      return prependNotices(
        await this.#runTransactionStructuredUnlocked(input, decode),
        described.notices,
      );
    } catch (error) {
      throw errorWithNotices(error, described.notices);
    }
  }

  async #runTransactionStructuredUnlocked<Result>(
    input: Uint8Array,
    decode: (response: Uint8Array) => Result,
  ): Promise<Result> {
    const exchange = await this.#exchangeKnownUnlocked(input, 'transaction');
    return decode(exchange.response);
  }

  async #exchangeKnownUnlocked(input: Uint8Array, scope: StructuredScope): Promise<KnownExchange> {
    this.#assertHealthy();
    let response: Uint8Array;
    try {
      response = await this.#session.exec(input, 'defer');
    } catch (error) {
      this.#recordUnknownExchange(error, 'structured PostgreSQL transport outcome is unknown');
      throw error;
    }

    let status: TransactionStatus;
    try {
      status =
        scope === 'transaction'
          ? inspectManagedTransactionResponse(response)
          : inspectReadyForQuery(response);
    } catch (error) {
      this.#recordUnknownExchange(
        error,
        'structured PostgreSQL response has no valid readiness boundary',
      );
      throw error;
    }
    return { response, status };
  }

  async #executeTransactionControlUnlocked(
    sql: 'BEGIN' | 'COMMIT' | 'ROLLBACK',
  ): Promise<'committed' | 'rolledBack' | undefined> {
    const exchange = await this.#exchangeKnownUnlocked(extendedQuery(sql, []), 'control');
    let result: CommandResult;
    try {
      result = parseCommandResponse(exchange.response);
    } catch (error) {
      if (sql === 'BEGIN' && exchange.status !== 'idle') {
        await this.#executeTransactionControlUnlocked('ROLLBACK').catch(() => undefined);
      } else if (sql !== 'BEGIN') {
        this.#transactionFailure = asError(error, `${sql} outcome is unknown`);
      }
      throw error;
    }

    if (sql === 'BEGIN') {
      if (result.commandTag === 'BEGIN' && exchange.status === 'transaction') return undefined;
      const error = transactionBoundaryError(sql, result.commandTag, exchange.status);
      if (exchange.status !== 'idle') {
        await this.#executeTransactionControlUnlocked('ROLLBACK');
      }
      throw error;
    }

    if (sql === 'COMMIT') {
      if (result.commandTag === 'COMMIT' && exchange.status === 'idle') return 'committed';
      if (result.commandTag === 'ROLLBACK' && exchange.status === 'idle') return 'rolledBack';
    } else if (result.commandTag === 'ROLLBACK' && exchange.status === 'idle') {
      return undefined;
    }

    const error = transactionBoundaryError(sql, result.commandTag, exchange.status);
    this.#transactionFailure = error;
    throw error;
  }

  #recordUnknownExchange(error: unknown, message: string): void {
    if (error instanceof WasixStorageError) {
      this.#persistenceFailure = error;
    } else {
      this.#transactionFailure ??= asError(error, message);
    }
  }

  #resolveProtocolStreamOutcome(
    outcome: WasixProtocolStreamOutcome,
    failure: { error: unknown } | undefined,
  ): void {
    try {
      resolveProtocolStreamOutcome(outcome, failure);
    } catch (error) {
      if (error instanceof WasixProtocolStreamInvariantError) {
        this.#recordUnknownExchange(error, 'streaming PostgreSQL transport outcome is unknown');
      }
      throw error;
    }
  }

  async transaction<T>(body: (transaction: OliphauntTransaction) => Promise<T> | T): Promise<T> {
    this.#assertAvailable();
    if (typeof body !== 'function') {
      throw new TypeError('Oliphaunt WASIX transaction body must be a function');
    }
    this.#activeTransaction = true;
    transactionPinnedTargets.add(this);
    const attempt = this.#serialize(async () => {
      // A close may cancel this transaction while it is still queued behind
      // an unstarted protocol reservation. Once execution enters PostgreSQL,
      // close remains prohibited until the callback transaction is finished.
      this.#assertOpen();
      this.#transactionRunning = true;
      const transaction = new WasixTransactionImpl(
        (plan, decode) => this.#runTransactionPlanUnlocked(plan, decode),
        (input, decode) => this.#runTransactionStructuredUnlocked(input, decode),
        () => this.#executeTransactionControlUnlocked('ROLLBACK').then(() => undefined),
      );
      try {
        try {
          await this.#executeTransactionControlUnlocked('BEGIN');
        } catch (error) {
          if (this.#transactionFailure === undefined && this.#persistenceFailure === undefined) {
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
        }

        let result: T;
        try {
          result = await body(transaction);
          await transaction.sealAndDrain();
        } catch (error) {
          transaction.seal();
          await transaction.drain();
          let rolledBack = transaction.rolledBack;
          let rollbackFailure: unknown;
          if (transaction.rollbackStarted) {
            try {
              await transaction.waitForRollback();
              rolledBack = transaction.rolledBack;
            } catch (rollbackError) {
              rollbackFailure = rollbackError;
            }
          } else if (
            this.#transactionFailure === undefined &&
            this.#persistenceFailure === undefined
          ) {
            try {
              await this.#executeTransactionControlUnlocked('ROLLBACK');
              rolledBack = true;
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
          const sessionFailure = this.#persistenceFailure ?? this.#transactionFailure;
          const databaseFailure =
            sessionFailure === undefined ? undefined : (transaction.firstFailure ?? sessionFailure);
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
          await this.#syncPersistence('operation');
          return result;
        }
        if (this.#transactionFailure !== undefined && transaction.firstFailure !== undefined) {
          throw transaction.firstFailure;
        }

        const outcome = await this.#executeTransactionControlUnlocked('COMMIT');
        if (outcome === 'committed') {
          await this.#syncPersistence('operation');
          return result;
        }
        const primary =
          transaction.firstFailure ??
          new Error('PostgreSQL rolled back the transaction instead of committing');
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
      } finally {
        transaction.deactivate();
        this.#transactionRunning = false;
      }
    });
    return await attempt.finally(() => {
      this.#activeTransaction = false;
      transactionPinnedTargets.delete(this);
    });
  }

  close(): Promise<void> {
    try {
      this.#assertNotInProtocolStreamCallback();
    } catch (error) {
      return Promise.reject(error);
    }
    if (this.#closeAttempt !== undefined) {
      return this.#closeAttempt;
    }
    if (this.#transactionRunning) {
      return Promise.reject(
        new Error('cannot close Oliphaunt WASIX while a transaction is active'),
      );
    }
    if (this.#forgottenRegistration !== undefined) {
      this.#forgottenRegistry?.unregister(this.#forgottenRegistration);
    }
    this.#closing = true;
    const closing = new Error('Oliphaunt WASIX database is closing');
    for (const connection of this.#pendingProtocolConnections) connection.cancel(closing);
    const orderlyClose = this.#serialize(() => this.#session.close());
    const sessionClose =
      this.#session.abort === undefined
        ? orderlyClose
        : withDeadline(orderlyClose, CLOSE_DEADLINE_MS, () => this.#session.abort?.());
    const attempt = (async () => {
      let sessionFailed = false;
      let sessionFailure: unknown;
      try {
        await sessionClose;
      } catch (error) {
        sessionFailed = true;
        sessionFailure = error;
      }

      let cleanupFailed = false;
      let cleanupFailure: unknown;
      try {
        await this.#closeResources();
      } catch (error) {
        cleanupFailed = true;
        cleanupFailure = error;
      } finally {
        // Session close is a terminal ownership transfer, not a retryable
        // operation. Worker close always destroys its transport, while direct
        // close always attempts provider and allocation release. Advertising a
        // reusable handle after either path rejects would be false.
        this.#closed = true;
        this.#closing = false;
      }

      if (sessionFailed && cleanupFailed) {
        throw new AggregateError(
          [sessionFailure, cleanupFailure],
          'Oliphaunt WASIX database and resource cleanup both failed',
        );
      }
      if (sessionFailed) throw sessionFailure;
      if (cleanupFailed) throw cleanupFailure;
    })();
    this.#closeAttempt = attempt;
    return attempt;
  }

  /** @internal Register package-owned state that must not outlive this database. */
  registerResource(resource: WasixDatabaseResource): void {
    this.#assertAvailable();
    this.#resources.add(resource);
  }

  /** @internal Identity used by private protocol clients such as pg_dump and psql. */
  get identity(): WasixDatabaseIdentity {
    return this.#identity;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  #assertOpen(): void {
    this.#assertNotInProtocolStreamCallback();
    const terminalFailure = this.#session.terminalState?.failure;
    if (this.#closed || terminalFailure !== undefined) {
      throw new Error('Oliphaunt WASIX database is closed', {
        ...(terminalFailure === undefined ? {} : { cause: terminalFailure }),
      });
    }
    if (this.#closing) {
      throw new Error('Oliphaunt WASIX database is closing');
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

  #assertNotInProtocolStreamCallback(): void {
    if (this.#streamCallbackActive) {
      throw new Error(
        'raw protocol stream callback must not reenter the same Oliphaunt database or transaction',
      );
    }
  }

  #protocolChunkConsumer(
    callback: ProtocolChunkCallback,
  ): ReturnType<typeof synchronousProtocolChunkConsumer> {
    return synchronousProtocolChunkConsumer(
      callback,
      () => {
        this.#assertNotInProtocolStreamCallback();
        this.#streamCallbackActive = true;
      },
      () => {
        this.#streamCallbackActive = false;
      },
    );
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

  async #closeResources(): Promise<void> {
    const resources = [...this.#resources];
    // Every registered owner gets exactly one teardown attempt. Drop the
    // ownership graph before awaiting userland cleanup so a failed terminal
    // close cannot retain otherwise collectible resources indefinitely.
    this.#resources.clear();
    const results = await Promise.allSettled(resources.map(async (resource) => resource.close()));
    const failures: unknown[] = [];
    for (let index = 0; index < results.length; index += 1) {
      const result = results[index]!;
      if (result.status === 'rejected') {
        failures.push(result.reason);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Oliphaunt WASIX database resource cleanup failed');
    }
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

/** @internal Execute pg_dump in the realm that owns this database. */
export function runWasixPgDumpProcess(
  database: OliphauntDatabase,
  options: WasixToolProcessOptions,
): Promise<WasixToolProcessResult> {
  assertWasixPgDumpTarget(database);
  return database.runPgDump(options);
}

/** @internal Reserve a Worker-owned connection in the database FIFO. */
export function reserveWasixProtocolConnection(
  database: OliphauntDatabase,
  connection: WasixProtocolConnection,
  mode: WasixProtocolConnectionMode,
): WasixProtocolConnectionReservation {
  assertWasixProtocolConnectionTarget(database);
  return database.reserveProtocolConnection(connection, mode);
}

/** @internal Fail before loading a tool or opening a listener for unsupported placement. */
export function assertWasixProtocolConnectionTarget(
  database: OliphauntDatabase,
): asserts database is WasixDatabaseImpl {
  assertWasixDatabaseTarget(database);
  if (!protocolConnectionTargets.has(database)) {
    throw new Error('WASIX psql and local servers require @oliphaunt/wasix-ts/worker');
  }
}

/** @internal Accept both public entrypoints that own the co-located runner. */
function assertWasixPgDumpTarget(
  database: OliphauntDatabase,
): asserts database is WasixDatabaseImpl {
  assertWasixDatabaseTarget(database);
  if (!pgDumpTargets.has(database)) {
    throw new Error('this WASIX database entrypoint does not support pg_dump');
  }
}

function assertWasixDatabaseTarget(
  database: OliphauntDatabase,
): asserts database is WasixDatabaseImpl {
  if (!(database instanceof WasixDatabaseImpl)) {
    throw new TypeError('database is not an @oliphaunt/wasix-ts handle');
  }
  if (transactionPinnedTargets.has(database)) {
    throw new Error(transactionPinnedMessage);
  }
}

/** @internal Attach an optional-package resource without adding public database methods. */
export function registerWasixDatabaseResource(
  database: OliphauntDatabase,
  resource: WasixDatabaseResource,
): void {
  assertWasixProtocolConnectionTarget(database);
  database.registerResource(resource);
}

/** @internal Return the exact startup identity owned by a WASIX database handle. */
export function getWasixDatabaseIdentity(database: OliphauntDatabase): WasixDatabaseIdentity {
  assertWasixDatabaseTarget(database);
  return database.identity;
}

function withDeadline<T>(
  operation: Promise<T>,
  milliseconds: number,
  expire: () => void | Promise<void>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let expired = false;
    const timer = setTimeout(() => {
      expired = true;
      const timeout = new WasixCloseTimeoutError(milliseconds);
      void Promise.resolve()
        .then(expire)
        .then(
          () => reject(timeout),
          (abortFailure) =>
            reject(
              new AggregateError(
                [timeout, abortFailure],
                'Oliphaunt WASIX orderly close timed out and forced termination failed',
              ),
            ),
        );
    }, milliseconds);
    void operation.then(
      (value) => {
        if (expired) return;
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        if (expired) return;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function transactionCallbackAggregate(
  callback: unknown,
  secondary: unknown,
  message: string,
): AggregateError {
  return new AggregateError([callback, secondary], message);
}

class WasixCloseTimeoutError extends Error {
  constructor(milliseconds: number) {
    super(`Oliphaunt WASIX close exceeded ${milliseconds}ms; worker termination was requested`);
    this.name = 'WasixCloseTimeoutError';
  }
}

class WasixTransactionImpl implements OliphauntTransaction {
  readonly #runPlan: <Result extends NoticeCarrier>(
    plan: QueryPlan,
    decode: (response: Uint8Array) => Result,
  ) => Promise<Result>;
  readonly #runStructured: <Result>(
    input: Uint8Array,
    decode: (response: Uint8Array) => Result,
  ) => Promise<Result>;
  readonly #rollbackControl: () => Promise<void>;
  #tail = Promise.resolve();
  #state: 'active' | 'finishing' | 'closed' = 'active';
  #failed = false;
  #firstFailure: unknown;
  #rollbackAttempt: Promise<void> | undefined;
  #rolledBack = false;

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
    return this.#publicPromise(() => {
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
    return this.#publicPromise(() => {
      assertNoTransactionChain(sql);
      const stableOptions = snapshotQueryOptions(options);
      const plan = planQuery(sql, parameters, stableOptions);
      return this.#enqueue(async () =>
        decodeQueryResult<Row, Options>(
          await this.#runPlan(plan, parseQueryRawResponse),
          stableOptions,
        ),
      );
    });
  }

  queryRaw(
    sql: string,
    parameters: ReadonlyArray<QueryParam> = [],
    options: ParameterOptions = {},
  ): Promise<RawQueryResult> {
    return this.#publicPromise(() => {
      assertNoTransactionChain(sql);
      const plan = planQuery(sql, parameters, snapshotParameterOptions(options));
      return this.#enqueue(() => this.#runPlan(plan, parseQueryRawResponse));
    });
  }

  exec<Row = never, const Options extends QueryReadOptions = {}>(
    sql: string,
    options: Options & QueryReadOptions = {} as Options & QueryReadOptions,
  ): Promise<ExecResult<InferQueryRow<Options, Row>>> {
    return this.#publicPromise(() => {
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
    return this.#publicPromise(() => {
      const input = describeQuery(sql, [...parameterTypeOids]);
      return this.#enqueue(() => this.#runStructured(input, parseDescribeResponse));
    });
  }

  rollback(): Promise<void> {
    try {
      this.#assertActive();
    } catch (error) {
      return Promise.reject(error);
    }
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

  #publicPromise<Result>(operation: () => Promise<Result>): Promise<Result> {
    try {
      return operation();
    } catch (error) {
      return Promise.reject(error);
    }
  }

  #enqueue<Result>(operation: () => Promise<Result>): Promise<Result> {
    try {
      this.#assertActive();
    } catch (error) {
      return Promise.reject(error);
    }
    return this.#enqueueFinishing(operation);
  }

  #enqueueFinishing<Result>(operation: () => Promise<Result>): Promise<Result> {
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

type StructuredScope = 'database' | 'transaction' | 'control';
type NoticeCarrier = { notices: PostgresNotice[] };
type KnownExchange = Readonly<{
  response: Uint8Array;
  status: TransactionStatus;
}>;

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

function transactionBoundaryError(
  expected: 'BEGIN' | 'COMMIT' | 'ROLLBACK',
  actual: string | undefined,
  status: TransactionStatus,
): Error {
  return new Error(
    `PostgreSQL transaction command expected ${expected} with its matching readiness status, got ${actual ?? 'no command tag'} with ${status}`,
  );
}

function synchronousProtocolChunkConsumer(
  callback: ProtocolChunkCallback,
  enter: () => void = () => undefined,
  leave: () => void = () => undefined,
): {
  callback: ProtocolChunkCallback;
  failure?: { error: unknown };
} {
  const consumer: {
    callback: ProtocolChunkCallback;
    failure?: { error: unknown };
  } = {
    callback(chunk) {
      enter();
      try {
        const result = (callback as (chunk: Uint8Array) => unknown)(chunk);
        if (!isThenable(result)) return;
        // The returned task cannot participate in synchronous backpressure.
        // Mark its rejection handled before failing deterministically.
        void Promise.resolve(result).catch(() => undefined);
        throw new TypeError(
          'raw protocol stream callback must complete synchronously and must not return a Promise or thenable',
        );
      } catch (error) {
        consumer.failure ??= { error };
        throw error;
      } finally {
        leave();
      }
    },
  };
  return consumer;
}

function resolveProtocolStreamOutcome(
  outcome: WasixProtocolStreamOutcome,
  failure: { error: unknown } | undefined,
): void {
  if (outcome === 'callbackAborted' && failure === undefined) {
    throw new WasixProtocolStreamInvariantError(
      'WASIX runtime confirmed protocol callback recovery without a retained callback failure',
    );
  }
  if (outcome === 'complete' && failure !== undefined) {
    throw new WasixProtocolStreamInvariantError(
      'WASIX runtime reported protocol stream success after rejecting its callback',
    );
  }
  if (failure !== undefined) {
    throw failure.error;
  }
}

class WasixProtocolStreamInvariantError extends Error {}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    ((typeof value === 'object' && value !== null) || typeof value === 'function') &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

function asError(value: unknown, fallback: string): Error {
  if (value instanceof Error) return value;
  return new Error(fallback, { cause: value });
}
