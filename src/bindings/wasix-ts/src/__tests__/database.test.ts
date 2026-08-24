import { describe, expect, it, vi } from 'vitest';

import {
  assertWasixProtocolConnectionTarget,
  normalizeWasixDatabaseIdentity,
  WasixDatabaseImpl,
  type WasixDatabaseSession,
} from '../database.js';
import { createWasixByteChannel } from '../byte-channel.js';
import { WasixStorageError } from '../errors.js';
import { PostgresError } from '../query.js';
import type { OliphauntTransaction } from '../types.js';

// liboliphaunt-doc-example:wasix-typescript-transaction
describe('WASIX database recovery state', () => {
  it('normalizes an empty database name like PostgreSQL startup', () => {
    expect(normalizeWasixDatabaseIdentity('application', '')).toEqual({
      username: 'application',
      database: 'application',
    });
    expect(normalizeWasixDatabaseIdentity('application', 'products')).toEqual({
      username: 'application',
      database: 'products',
    });
  });

  it('identifies worker protocol targets without exposing a public capability flag', () => {
    const direct = new WasixDatabaseImpl({
      async exec() {
        return ready();
      },
      async sync() {},
      async close() {},
    });
    const worker = new WasixDatabaseImpl({
      isolated: true,
      async exec() {
        return ready();
      },
      async sync() {},
      async serve() {},
      async close() {},
    });

    expect(() => assertWasixProtocolConnectionTarget(direct)).toThrow(/worker execution/);
    expect(() => assertWasixProtocolConnectionTarget(worker)).not.toThrow();
  });

  it('reserves protocol FIFO order without entering a canceled guest connection', async () => {
    const events: string[] = [];
    const database = new WasixDatabaseImpl({
      isolated: true,
      async exec() {
        events.push('query');
        return ready();
      },
      async sync() {},
      async serve() {
        events.push('serve');
      },
      async close() {},
    });
    const reservation = database.reserveProtocolConnection(
      { frontend: createWasixByteChannel(), backend: createWasixByteChannel() },
      'tool',
    );
    const query = database.execProtocolRaw(Uint8Array.of(1));

    await Promise.resolve();
    await Promise.resolve();
    expect(events).toEqual([]);
    reservation.cancel();
    await query;
    expect(events).toEqual(['query']);
    expect(() => reservation.start()).toThrow(/canceled before start/);
    await database.close();
  });

  it('cancels a queued transaction while closing an unstarted protocol reservation', async () => {
    const events: string[] = [];
    const database = new WasixDatabaseImpl({
      isolated: true,
      async exec() {
        events.push('exec');
        return ready();
      },
      async sync() {},
      async serve() {
        events.push('serve');
      },
      async close() {
        events.push('close');
      },
    });
    const reservation = database.reserveProtocolConnection(
      { frontend: createWasixByteChannel(), backend: createWasixByteChannel() },
      'tool',
    );
    let bodyEntered = false;
    const transaction = database.transaction(() => {
      bodyEntered = true;
    });
    const transactionFailure = expect(transaction).rejects.toThrow(/database is closed/);

    await database.close();
    await transactionFailure;

    expect(bodyEntered).toBe(false);
    expect(events).toEqual(['close']);
    expect(() => reservation.start()).toThrow(/database is closing/);
  });

  it('rejects a protocol owner while a callback transaction is active', async () => {
    let release!: () => void;
    let enteredTransaction!: () => void;
    const entered = new Promise<void>((resolve) => {
      enteredTransaction = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const database = new WasixDatabaseImpl({
      isolated: true,
      async exec(input) {
        return querySql(input) === 'COMMIT'
          ? concatenate(commandComplete('COMMIT'), ready())
          : ready();
      },
      async sync() {},
      async serve() {},
      async close() {},
    });
    const transaction = database.transaction(async () => {
      enteredTransaction();
      await blocked;
    });
    await entered;
    expect(() => assertWasixProtocolConnectionTarget(database)).toThrow(/active transaction/);
    release();
    await transaction;
    expect(() => assertWasixProtocolConnectionTarget(database)).not.toThrow();
  });

  it('pins callback transactions, commits results, and expires the transaction handle', async () => {
    const statements: string[] = [];
    const persistenceModes: Array<string | undefined> = [];
    const syncBoundaries: string[] = [];
    const session: WasixDatabaseSession = {
      async exec(input, persistence) {
        const statement = querySql(input);
        statements.push(statement);
        persistenceModes.push(persistence);
        return statement === 'COMMIT' ? concatenate(commandComplete('COMMIT'), ready()) : ready();
      },
      async sync(boundary) {
        syncBoundaries.push(boundary);
      },
      async close() {},
    };
    const database = new WasixDatabaseImpl(session);
    let expired: OliphauntTransaction | undefined;

    const value = await database.transaction(async (transaction) => {
      expired = transaction;
      await transaction.execute('SELECT inside');
      await expect(database.query('SELECT outside')).rejects.toThrow(/pinned/);
      await expect(database.close()).rejects.toThrow(/transaction is active/);
      return 42;
    });

    expect(value).toBe(42);
    expect(statements).toEqual(['BEGIN', 'SELECT inside', 'COMMIT']);
    expect(persistenceModes).toEqual(['defer', 'defer', 'defer']);
    expect(syncBoundaries).toEqual(['operation']);
    if (expired === undefined) throw new Error('transaction test handle was not captured');
    await expect(expired.query('SELECT too_late')).rejects.toThrow(/no longer active/);
    await database.close();
  });

  it('rolls back callback failures and leaves the database usable', async () => {
    const statements: string[] = [];
    const persistenceModes: Array<string | undefined> = [];
    const syncBoundaries: string[] = [];
    const session: WasixDatabaseSession = {
      async exec(input, persistence) {
        const statement = querySql(input);
        statements.push(statement);
        persistenceModes.push(persistence);
        return statement === 'ROLLBACK'
          ? concatenate(commandComplete('ROLLBACK'), ready())
          : ready();
      },
      async sync(boundary) {
        syncBoundaries.push(boundary);
      },
      async close() {},
    };
    const database = new WasixDatabaseImpl(session);
    const failure = new Error('body failed');

    await expect(
      database.transaction(async (transaction) => {
        await transaction.execute('SELECT before_failure');
        throw failure;
      }),
    ).rejects.toBe(failure);
    await database.query('SELECT recovered');

    expect(statements).toEqual(['BEGIN', 'SELECT before_failure', 'ROLLBACK', 'SELECT recovered']);
    expect(persistenceModes).toEqual(['defer', 'defer', 'defer', 'sync']);
    expect(syncBoundaries).toEqual(['operation']);
    await database.close();
  });

  it('rejects and poisons the handle when publication fails after COMMIT', async () => {
    const statements: string[] = [];
    const storageFailure = new WasixStorageError('commit generation failed', {
      code: 'publication-failed',
      commitState: 'unknown',
    });
    const session: WasixDatabaseSession = {
      async exec(input, persistence) {
        const statement = querySql(input);
        statements.push(`${statement}:${persistence}`);
        return statement === 'COMMIT' ? concatenate(commandComplete('COMMIT'), ready()) : ready();
      },
      async sync() {
        throw storageFailure;
      },
      async close() {},
    };
    const database = new WasixDatabaseImpl(session);

    await expect(database.transaction(async () => 42)).rejects.toBe(storageFailure);
    expect(statements).toEqual(['BEGIN:defer', 'COMMIT:defer']);
    await expect(database.query('SELECT never_runs')).rejects.toMatchObject({
      name: 'WasixStorageError',
      code: 'publication-failed',
    });
    expect(statements).toEqual(['BEGIN:defer', 'COMMIT:defer']);
    await database.close();
  });

  it('keeps rollback publication failure primary while retaining the callback error', async () => {
    const callbackFailure = new Error('body failed');
    const storageFailure = new WasixStorageError('rollback generation failed', {
      code: 'publication-failed',
      commitState: 'not-persisted',
    });
    const statements: string[] = [];
    const database = new WasixDatabaseImpl({
      async exec(input) {
        const statement = querySql(input);
        statements.push(statement);
        return statement === 'ROLLBACK'
          ? concatenate(commandComplete('ROLLBACK'), ready())
          : ready();
      },
      async sync() {
        throw storageFailure;
      },
      async close() {},
    });

    await expect(
      database.transaction(async () => {
        throw callbackFailure;
      }),
    ).rejects.toMatchObject({
      name: 'WasixStorageError',
      code: 'publication-failed',
      commitState: 'not-persisted',
      message: expect.stringContaining('transaction also failed: body failed'),
    });
    expect(statements).toEqual(['BEGIN', 'ROLLBACK']);
    await database.close();
  });

  it('rolls back when the callback leaves a failed operation unawaited', async () => {
    const statements: string[] = [];
    let transactionAborted = false;
    const session: WasixDatabaseSession = {
      async exec(input) {
        const statement = querySql(input);
        statements.push(statement);
        if (statement === 'SELECT rejected') {
          transactionAborted = true;
          return concatenate(backendError('XX000', 'queued operation failed'), ready());
        }
        if (statement === 'COMMIT' && transactionAborted) {
          return concatenate(commandComplete('ROLLBACK'), ready());
        }
        return statement === 'COMMIT' ? concatenate(commandComplete('COMMIT'), ready()) : ready();
      },
      async sync() {},
      async close() {},
    };
    const database = new WasixDatabaseImpl(session);
    let ignored: ReturnType<WasixDatabaseImpl['execute']> | undefined;

    await expect(
      database.transaction((transaction) => {
        ignored = transaction.execute('SELECT rejected');
        return 42;
      }),
    ).rejects.toMatchObject({ sqlstate: 'XX000' });
    await expect(ignored).rejects.toMatchObject({ sqlstate: 'XX000' });

    expect(statements).toEqual(['BEGIN', 'SELECT rejected', 'COMMIT']);
    await expect(database.query('SELECT recovered')).resolves.toMatchObject({
      rowCount: null,
    });
    await database.close();
  });

  it('commits after a caught failure is recovered to a savepoint', async () => {
    const statements: string[] = [];
    const session: WasixDatabaseSession = {
      async exec(input) {
        const statement = querySql(input);
        statements.push(statement);
        if (statement === 'SELECT rejected') {
          return concatenate(backendError('XX000', 'savepoint operation failed'), ready());
        }
        if (statement === 'COMMIT') {
          return concatenate(commandComplete('COMMIT'), ready());
        }
        return ready();
      },
      async sync() {},
      async close() {},
    };
    const database = new WasixDatabaseImpl(session);

    await expect(
      database.transaction(async (transaction) => {
        await transaction.execute('SAVEPOINT retry');
        await expect(transaction.execute('SELECT rejected')).rejects.toMatchObject({
          sqlstate: 'XX000',
        });
        await transaction.execute('ROLLBACK TO SAVEPOINT retry');
        await transaction.execute('SELECT recovered');
        return 42;
      }),
    ).resolves.toBe(42);

    expect(statements).toEqual([
      'BEGIN',
      'SAVEPOINT retry',
      'SELECT rejected',
      'ROLLBACK TO SAVEPOINT retry',
      'SELECT recovered',
      'COMMIT',
    ]);
    await database.close();
  });

  it('does not report a commit after raw protocol traffic aborts the server transaction', async () => {
    const statements: string[] = [];
    let transactionAborted = false;
    const session: WasixDatabaseSession = {
      async exec(input) {
        if (input.length === 1) {
          statements.push('RAW');
          transactionAborted = true;
          return concatenate(backendError('XX000', 'raw operation failed'), ready());
        }
        const statement = querySql(input);
        statements.push(statement);
        if (statement === 'COMMIT' && transactionAborted) {
          return concatenate(commandComplete('ROLLBACK'), ready());
        }
        return ready();
      },
      async sync() {},
      async close() {},
    };
    const database = new WasixDatabaseImpl(session);

    await expect(
      database.transaction(async (transaction) => {
        await transaction.execProtocolRaw(Uint8Array.of(1));
      }),
    ).rejects.toThrow('rolled back the transaction instead of committing');

    expect(statements).toEqual(['BEGIN', 'RAW', 'COMMIT']);
    await expect(database.query('SELECT recovered')).resolves.toMatchObject({
      rowCount: null,
    });
    await database.close();
  });

  it('poisons the handle when COMMIT returns a malformed successful response', async () => {
    const statements: string[] = [];
    const database = new WasixDatabaseImpl({
      async exec(input) {
        const statement = querySql(input);
        statements.push(statement);
        return ready();
      },
      async sync() {},
      async close() {},
    });

    await expect(database.transaction(async () => 42)).rejects.toThrow(
      'PostgreSQL returned no command tag for COMMIT',
    );
    await expect(database.query('SELECT never_runs')).rejects.toThrow(
      'transaction outcome became unknown',
    );
    expect(statements).toEqual(['BEGIN', 'COMMIT']);
    await database.close();
  });

  it('seals the callback handle before commit begins', async () => {
    const statements: string[] = [];
    let releaseCommit: (() => void) | undefined;
    let commitStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      commitStarted = resolve;
    });
    const session: WasixDatabaseSession = {
      async exec(input) {
        const statement = querySql(input);
        statements.push(statement);
        if (statement === 'COMMIT') {
          commitStarted?.();
          await new Promise<void>((resolve) => {
            releaseCommit = resolve;
          });
        }
        return statement === 'COMMIT' ? concatenate(commandComplete('COMMIT'), ready()) : ready();
      },
      async sync() {},
      async close() {},
    };
    const database = new WasixDatabaseImpl(session);
    let transactionHandle: OliphauntTransaction | undefined;

    const transaction = database.transaction((handle) => {
      transactionHandle = handle;
    });
    await started;
    if (transactionHandle === undefined)
      throw new Error('transaction test handle was not captured');
    await expect(transactionHandle.query('SELECT after_body')).rejects.toThrow(/no longer active/);
    releaseCommit?.();
    await transaction;

    expect(statements).toEqual(['BEGIN', 'COMMIT']);
    await database.close();
  });

  it.each([
    'BEGIN',
    'COMMIT',
  ] as const)('releases transaction ownership when %s fails', async (failedStatement) => {
    const statements: string[] = [];
    const session: WasixDatabaseSession = {
      async exec(input) {
        const statement = querySql(input);
        statements.push(statement);
        return statement === failedStatement
          ? concatenate(backendError('XX000', `${failedStatement} failed`), ready())
          : statement === 'ROLLBACK'
            ? concatenate(commandComplete('ROLLBACK'), ready())
            : ready();
      },
      async sync() {},
      async close() {},
    };
    const database = new WasixDatabaseImpl(session);

    await expect(
      database.transaction(async (transaction) => {
        await transaction.execute('SELECT inside');
      }),
    ).rejects.toMatchObject({ sqlstate: 'XX000' });
    await expect(database.query('SELECT recovered')).resolves.toMatchObject({
      rowCount: null,
    });

    expect(statements).toEqual(
      failedStatement === 'BEGIN'
        ? ['BEGIN', 'ROLLBACK', 'SELECT recovered']
        : ['BEGIN', 'SELECT inside', 'COMMIT', 'SELECT recovered'],
    );
    await database.close();
  });

  it('preserves the callback error when best-effort rollback also fails', async () => {
    const statements: string[] = [];
    const session: WasixDatabaseSession = {
      async exec(input) {
        const statement = querySql(input);
        statements.push(statement);
        return statement === 'ROLLBACK'
          ? concatenate(backendError('XX000', 'rollback failed'), ready())
          : ready();
      },
      async sync() {},
      async close() {},
    };
    const database = new WasixDatabaseImpl(session);
    const callbackError = new Error('keep me primary');

    await expect(
      database.transaction(async () => {
        throw callbackError;
      }),
    ).rejects.toBe(callbackError);
    await expect(database.query('SELECT never_runs')).rejects.toThrow(
      'transaction outcome became unknown',
    );
    expect(statements).toEqual(['BEGIN', 'ROLLBACK']);
    await database.close();
  });

  it('preserves the callback error when ROLLBACK has no command tag', async () => {
    const statements: string[] = [];
    const database = new WasixDatabaseImpl({
      async exec(input) {
        statements.push(querySql(input));
        return ready();
      },
      async sync() {},
      async close() {},
    });
    const callbackError = new Error('keep malformed rollback secondary');

    await expect(
      database.transaction(async () => {
        throw callbackError;
      }),
    ).rejects.toBe(callbackError);
    expect(statements).toEqual(['BEGIN', 'ROLLBACK']);
    await expect(database.query('SELECT never_runs')).rejects.toThrow(
      'transaction outcome became unknown',
    );
    await database.close();
  });

  it('reports invalid transaction callbacks as asynchronous rejections', async () => {
    const database = new WasixDatabaseImpl({
      async exec() {
        return ready();
      },
      async sync() {},
      async close() {},
    });
    let attempt: Promise<unknown> | undefined;

    expect(() => {
      attempt = database.transaction(undefined as never);
    }).not.toThrow();
    await expect(attempt).rejects.toThrow(TypeError);
    await database.close();
  });

  it('preserves public raw input ownership for every execution placement', async () => {
    const executions: Uint8Array[] = [];
    const session: WasixDatabaseSession = {
      async exec(input) {
        executions.push(input);
        return ready();
      },
      async sync() {},
      async close() {},
    };
    const database = new WasixDatabaseImpl(session);

    await database.execute('select 42');
    expect(executions[0]?.[0]).toBe('P'.charCodeAt(0));
    const raw = Uint8Array.of('Q'.charCodeAt(0), 0, 0, 0, 5, 0);
    await database.execProtocolRaw(raw);

    expect(executions).toHaveLength(2);
    expect(executions[1]).not.toBe(raw);
    expect(executions[1]?.buffer).not.toBe(raw.buffer);
    expect(raw).toEqual(Uint8Array.of('Q'.charCodeAt(0), 0, 0, 0, 5, 0));
    await database.close();
  });

  it('streams protocol responses in order without retaining caller-owned input', async () => {
    const inputs: Uint8Array[] = [];
    const persistenceModes: Array<string | undefined> = [];
    const chunks = [Uint8Array.of(1, 2), Uint8Array.of(3)];
    const database = new WasixDatabaseImpl({
      async exec() {
        throw new Error('buffered execution must not be used');
      },
      async execStream(input, onChunk, persistence) {
        inputs.push(input);
        persistenceModes.push(persistence);
        for (const chunk of chunks) onChunk(chunk);
      },
      async sync() {},
      async close() {},
    });
    const input = Uint8Array.of(9, 8, 7);
    const received: Uint8Array[] = [];

    await database.execProtocolStream(input, (chunk) => received.push(chunk));

    expect(inputs).toHaveLength(1);
    expect(inputs[0]).not.toBe(input);
    expect(inputs[0]?.buffer).not.toBe(input.buffer);
    expect(inputs[0]).toEqual(input);
    expect(persistenceModes).toEqual(['sync']);
    expect(received).toEqual(chunks);
    await database.close();
  });

  it('uses deferred streaming inside a callback transaction and expires the handle', async () => {
    const persistenceModes: Array<string | undefined> = [];
    const streamed: number[] = [];
    let expired: OliphauntTransaction | undefined;
    const database = new WasixDatabaseImpl({
      async exec(input, persistence) {
        persistenceModes.push(persistence);
        const statement = querySql(input);
        return statement === 'COMMIT' ? concatenate(commandComplete('COMMIT'), ready()) : ready();
      },
      async execStream(_input, onChunk, persistence) {
        persistenceModes.push(persistence);
        onChunk(Uint8Array.of(4, 5));
      },
      async sync() {},
      async close() {},
    });

    await database.transaction(async (transaction) => {
      expired = transaction;
      await transaction.execProtocolStream(Uint8Array.of(1), (chunk) => {
        streamed.push(...chunk);
      });
    });

    expect(streamed).toEqual([4, 5]);
    expect(persistenceModes).toEqual(['defer', 'defer', 'defer']);
    if (expired === undefined) throw new Error('transaction handle was not captured');
    await expect(expired.execProtocolStream(Uint8Array.of(1), () => undefined)).rejects.toThrow(
      /no longer active/,
    );
    await database.close();
  });

  it('rejects an invalid protocol stream callback without executing the guest', async () => {
    let executions = 0;
    const database = new WasixDatabaseImpl({
      async exec() {
        executions += 1;
        return ready();
      },
      async sync() {},
      async close() {},
    });

    await expect(database.execProtocolStream(Uint8Array.of(1), undefined as never)).rejects.toThrow(
      TypeError,
    );
    expect(executions).toBe(0);
    await database.close();
  });

  it('shares one close attempt, including its failure, with every caller', async () => {
    let rejectClose: ((error: Error) => void) | undefined;
    let closeStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      closeStarted = resolve;
    });
    let closes = 0;
    const session: WasixDatabaseSession = {
      async exec() {
        return ready();
      },
      async sync() {},
      close() {
        closes += 1;
        closeStarted?.();
        return new Promise((_, reject) => {
          rejectClose = reject;
        });
      },
    };
    const database = new WasixDatabaseImpl(session);

    const first = database.close();
    const second = database.close();
    expect(second).toBe(first);
    await started;
    let firstSettled = false;
    let secondSettled = false;
    void first.catch(() => {
      firstSettled = true;
    });
    void second.catch(() => {
      secondSettled = true;
    });
    await Promise.resolve();
    expect(firstSettled).toBe(false);
    expect(secondSettled).toBe(false);

    const failure = new Error('worker close failed');
    rejectClose?.(failure);
    await expect(first).rejects.toBe(failure);
    await expect(second).rejects.toBe(failure);
    await expect(database.close()).rejects.toBe(failure);
    expect(closes).toBe(1);
  });

  it('preserves session and every registered resource cleanup failure', async () => {
    const sessionFailure = new Error('session close failed');
    const firstResourceFailure = new Error('first resource close failed');
    const secondResourceFailure = new Error('second resource close failed');
    const database = new WasixDatabaseImpl({
      async exec() {
        return ready();
      },
      async sync() {},
      async close() {
        throw sessionFailure;
      },
    });
    database.registerResource({
      close() {
        throw firstResourceFailure;
      },
    });
    database.registerResource({
      async close() {
        throw secondResourceFailure;
      },
    });

    const failure = await database.close().catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    if (!(failure instanceof AggregateError)) throw new Error('expected aggregate close failure');
    expect(failure.errors[0]).toBe(sessionFailure);
    const resourceFailure = failure.errors[1];
    expect(resourceFailure).toBeInstanceOf(AggregateError);
    if (!(resourceFailure instanceof AggregateError)) {
      throw new Error('expected aggregate resource failure');
    }
    expect(resourceFailure.errors).toEqual([firstResourceFailure, secondResourceFailure]);
  });

  it('aborts isolated execution when queued work prevents bounded shutdown', async () => {
    vi.useFakeTimers();
    try {
      let aborts = 0;
      const database = new WasixDatabaseImpl({
        exec() {
          return new Promise(() => undefined);
        },
        async sync() {},
        async close() {},
        abort() {
          aborts += 1;
        },
      });
      void database.execProtocolRaw(Uint8Array.of(1));
      await Promise.resolve();

      const close = expect(database.close()).rejects.toThrow(
        'close exceeded 120000ms; worker termination was requested',
      );
      await vi.advanceTimersByTimeAsync(120_000);
      await close;
      expect(aborts).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the close deadline bounded when forced termination stalls', async () => {
    vi.useFakeTimers();
    try {
      let aborts = 0;
      const database = new WasixDatabaseImpl({
        exec() {
          return new Promise(() => undefined);
        },
        async sync() {},
        async close() {},
        abort() {
          aborts += 1;
          return new Promise(() => undefined);
        },
      });
      void database.execProtocolRaw(Uint8Array.of(1));
      await Promise.resolve();

      const close = expect(database.close()).rejects.toThrow(
        'close exceeded 120000ms; worker termination was requested',
      );
      await vi.advanceTimersByTimeAsync(120_000);
      await close;
      expect(aborts).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('poisons queued and later work after persistent delta publication fails', async () => {
    let rejectPublication: ((error: Error) => void) | undefined;
    let publicationStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      publicationStarted = resolve;
    });
    const requests: string[] = [];
    const session: WasixDatabaseSession = {
      async exec() {
        requests.push('exec');
        return ready();
      },
      sync() {
        requests.push('sync');
        publicationStarted?.();
        return new Promise((_, reject) => {
          rejectPublication = reject;
        });
      },
      async close() {
        requests.push('close');
      },
    };
    const database = new WasixDatabaseImpl(session);
    const storageFailure = new WasixStorageError('IndexedDB transaction aborted', {
      code: 'publication-failed',
      commitState: 'not-persisted',
    });

    const checkpoint = expect(database.checkpoint()).rejects.toBe(storageFailure);
    await started;
    const queuedQuery = expect(database.query('select 42')).rejects.toMatchObject({
      name: 'WasixStorageError',
      code: 'publication-failed',
      commitState: 'not-persisted',
      message: expect.stringContaining('cannot be used after a persistence boundary failed'),
    });
    rejectPublication?.(storageFailure);

    await checkpoint;
    await queuedQuery;
    await expect(database.query('select 43')).rejects.toMatchObject({
      name: 'WasixStorageError',
      code: 'publication-failed',
      commitState: 'not-persisted',
      message: expect.stringContaining('cannot be used after a persistence boundary failed'),
    });
    expect(requests).toEqual(['exec', 'sync']);

    await database.close();
    expect(requests).toEqual(['exec', 'sync', 'close']);
  });

  it('retains a typed persistence failure from an ordinary operation boundary', async () => {
    let executions = 0;
    const storageFailure = new WasixStorageError('OPFS publication stopped', {
      code: 'publication-failed',
      commitState: 'unknown',
    });
    const database = new WasixDatabaseImpl({
      async exec() {
        executions += 1;
        throw storageFailure;
      },
      async sync() {},
      async close() {},
    });

    await expect(database.query('insert into t values (1)')).rejects.toBe(storageFailure);
    await expect(database.query('select 1')).rejects.toMatchObject({
      code: 'publication-failed',
      commitState: 'unknown',
    });
    expect(executions).toBe(1);
    await database.close();
  });

  it('does not poison the handle for an ordinary PostgreSQL CHECKPOINT error', async () => {
    const requests: string[] = [];
    let firstExec = true;
    const session: WasixDatabaseSession = {
      async exec() {
        requests.push('exec');
        if (firstExec) {
          firstExec = false;
          return concatenate(backendError('42501', 'permission denied'), ready());
        }
        return ready();
      },
      async sync() {
        requests.push('sync');
      },
      async close() {},
    };
    const database = new WasixDatabaseImpl(session);

    await expect(database.checkpoint()).rejects.toBeInstanceOf(PostgresError);
    await expect(database.query('select 42')).resolves.toMatchObject({
      rows: [],
      rowCount: null,
    });
    expect(requests).toEqual(['exec', 'exec']);
    await database.close();
  });
});

function ready(): Uint8Array {
  return Uint8Array.of('Z'.charCodeAt(0), 0, 0, 0, 5, 'I'.charCodeAt(0));
}

function backendError(sqlstate: string, message: string): Uint8Array {
  const body = new Uint8Array([
    'S'.charCodeAt(0),
    ...new TextEncoder().encode('ERROR'),
    0,
    'C'.charCodeAt(0),
    ...new TextEncoder().encode(sqlstate),
    0,
    'M'.charCodeAt(0),
    ...new TextEncoder().encode(message),
    0,
    0,
  ]);
  const result = new Uint8Array(body.length + 5);
  result[0] = 'E'.charCodeAt(0);
  new DataView(result.buffer).setUint32(1, body.length + 4);
  result.set(body, 5);
  return result;
}

function commandComplete(tag: string): Uint8Array {
  const body = Uint8Array.from([...new TextEncoder().encode(tag), 0]);
  const result = new Uint8Array(body.length + 5);
  result[0] = 'C'.charCodeAt(0);
  new DataView(result.buffer).setUint32(1, body.length + 4);
  result.set(body, 5);
  return result;
}

function concatenate(left: Uint8Array, right: Uint8Array): Uint8Array {
  const result = new Uint8Array(left.length + right.length);
  result.set(left);
  result.set(right, left.length);
  return result;
}

function querySql(input: Uint8Array): string {
  if (input[0] === 'Q'.charCodeAt(0) && input.at(-1) === 0) {
    return new TextDecoder().decode(input.subarray(5, -1));
  }
  if (input[0] === 'P'.charCodeAt(0) && input[5] === 0) {
    const terminator = input.indexOf(0, 6);
    if (terminator >= 0) return new TextDecoder().decode(input.subarray(6, terminator));
  }
  throw new Error('test expected a simple- or extended-query packet');
}
