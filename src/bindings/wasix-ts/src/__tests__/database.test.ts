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
  it('validates explicit startup identities like Rust WASIX', () => {
    expect(normalizeWasixDatabaseIdentity('application', 'products')).toEqual({
      username: 'application',
      database: 'products',
    });
    expect(() => normalizeWasixDatabaseIdentity('application', '')).toThrow(
      'database must not be empty',
    );
    expect(() => normalizeWasixDatabaseIdentity(' ', 'products')).toThrow(
      'username must not be empty',
    );
    expect(() => normalizeWasixDatabaseIdentity('application', 'bad\0name')).toThrow(
      'database must not contain NUL bytes',
    );
  });

  it('identifies protocol-capable targets without exposing a public capability flag', () => {
    const direct = new WasixDatabaseImpl({
      async exec() {
        return ready();
      },
      async sync() {},
      async close() {},
    });
    const worker = new WasixDatabaseImpl({
      supportsProtocolConnections: true,
      async exec() {
        return ready();
      },
      async sync() {},
      async serve() {},
      async close() {},
    });

    expect(() => assertWasixProtocolConnectionTarget(direct)).toThrow(/wasix-ts\/worker/);
    expect(() => assertWasixProtocolConnectionTarget(worker)).not.toThrow();
  });

  it('reserves protocol FIFO order without entering a canceled guest connection', async () => {
    const events: string[] = [];
    const database = new WasixDatabaseImpl({
      supportsProtocolConnections: true,
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
      supportsProtocolConnections: true,
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
    const transactionFailure = expect(transaction).rejects.toThrow(/database is closing/);

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
      supportsProtocolConnections: true,
      async exec(input) {
        const statement = querySql(input);
        return statement === 'BEGIN' ? completed('BEGIN', 'T') : completed('COMMIT', 'I');
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
        if (statement === 'BEGIN') return completed('BEGIN', 'T');
        if (statement === 'COMMIT') return completed('COMMIT', 'I');
        return completed('SELECT 0', 'T');
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
      expect(database.closed).toBe(false);
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

  it('returns rejected Promises for transaction argument, planning, and state failures', async () => {
    const statements: string[] = [];
    const database = new WasixDatabaseImpl({
      async exec(input) {
        const statement = querySql(input);
        statements.push(statement);
        return statement === 'BEGIN' ? completed('BEGIN', 'T') : completed('COMMIT', 'I');
      },
      async sync() {},
      async close() {},
    });
    let expired: OliphauntTransaction | undefined;

    await database.transaction(async (transaction) => {
      expired = transaction;
      expect('execProtocolRaw' in transaction).toBe(false);
      expect('execProtocolRawStream' in transaction).toBe(false);
      const invalidCalls: ReadonlyArray<readonly [string, () => Promise<unknown>]> = [
        ['execute', () => transaction.execute(undefined as never)],
        ['query', () => transaction.query(undefined as never)],
        ['queryRaw', () => transaction.queryRaw(undefined as never)],
        ['exec', () => transaction.exec(undefined as never)],
        ['describe', () => transaction.describe('SELECT $1', [Number.NaN])],
      ];

      for (const [name, invoke] of invalidCalls) {
        let caught: Promise<unknown> | undefined;
        expect(() => {
          caught = invoke().catch((error: unknown) => error);
        }, `${name} threw before returning its Promise`).not.toThrow();
        await expect(caught, `${name} did not reject`).resolves.toBeInstanceOf(Error);
      }
      const chainCalls: ReadonlyArray<readonly [string, () => Promise<unknown>]> = [
        ['execute', () => transaction.execute('ROLLBACK AND CHAIN')],
        ['query', () => transaction.query('ABORT WORK AND CHAIN')],
        ['queryRaw', () => transaction.queryRaw('ROLLBACK TRANSACTION /* ownership */ AND CHAIN')],
        ['exec', () => transaction.exec('SELECT 1; RoLlBaCk AND /* comment */ CHAIN')],
      ];
      for (const [name, invoke] of chainCalls) {
        let caught: Promise<unknown> | undefined;
        expect(() => {
          caught = invoke().catch((error: unknown) => error);
        }, `${name} chain guard threw before returning its Promise`).not.toThrow();
        await expect(caught, `${name} did not reject a transaction chain`).resolves.toMatchObject({
          message: expect.stringContaining('do not support ROLLBACK/ABORT ... AND CHAIN'),
        });
      }
      expect(statements).toEqual(['BEGIN']);
    });

    expect(statements).toEqual(['BEGIN', 'COMMIT']);
    const closedTransaction = expired;
    if (closedTransaction === undefined) {
      throw new Error('transaction test handle was not captured');
    }
    const closedCalls: ReadonlyArray<readonly [string, () => Promise<unknown>]> = [
      ['execute', () => closedTransaction.execute('SELECT 1')],
      ['query', () => closedTransaction.query('SELECT 1')],
      ['queryRaw', () => closedTransaction.queryRaw('SELECT 1')],
      ['exec', () => closedTransaction.exec('SELECT 1')],
      ['describe', () => closedTransaction.describe('SELECT 1')],
      ['rollback', () => closedTransaction.rollback()],
    ];
    for (const [name, invoke] of closedCalls) {
      let caught: Promise<unknown> | undefined;
      expect(() => {
        caught = invoke().catch((error: unknown) => error);
      }, `${name} threw for a closed transaction`).not.toThrow();
      await expect(
        caught,
        `${name} did not reject for a closed transaction`,
      ).resolves.toMatchObject({ message: expect.stringContaining('no longer active') });
    }
    expect(statements).toEqual(['BEGIN', 'COMMIT']);
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
        if (statement === 'BEGIN') return completed('BEGIN', 'T');
        if (statement === 'ROLLBACK') return completed('ROLLBACK', 'I');
        return statement === 'SELECT recovered' ? emptyComplete('I') : completed('SELECT 0', 'T');
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
    expect(persistenceModes).toEqual(['defer', 'defer', 'defer', 'defer']);
    expect(syncBoundaries).toEqual(['operation', 'operation']);
    await database.close();
  });

  it('preserves a callback failure plus an independently unknown transaction outcome', async () => {
    const statements: string[] = [];
    const transportFailure = new Error('transaction transport outcome is unknown');
    const businessFailure = new Error('business callback failed');
    const database = new WasixDatabaseImpl({
      async exec(input) {
        const statement = querySql(input);
        statements.push(statement);
        if (statement === 'BEGIN') return completed('BEGIN', 'T');
        if (statement === 'SELECT transport_failure') throw transportFailure;
        return completed('SELECT 0', 'T');
      },
      async sync() {},
      async close() {},
    });
    let caughtDatabaseFailure: unknown;

    const combined = await database
      .transaction(async (transaction) => {
        try {
          await transaction.execute('SELECT transport_failure');
        } catch (error) {
          caughtDatabaseFailure = error;
        }
        throw businessFailure;
      })
      .catch((error: unknown) => error);

    expect(combined).toBeInstanceOf(AggregateError);
    if (!(combined instanceof AggregateError)) throw new Error('expected aggregate failure');
    expect(combined.errors).toEqual([businessFailure, caughtDatabaseFailure]);
    expect(combined.message).toContain('independent database failure');
    expect(statements).toEqual(['BEGIN', 'SELECT transport_failure']);
    await expect(database.query('SELECT never_runs')).rejects.toThrow(/outcome became unknown/);
    expect(statements).toEqual(['BEGIN', 'SELECT transport_failure']);
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
        return statement === 'BEGIN' ? completed('BEGIN', 'T') : completed('COMMIT', 'I');
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
        return statement === 'BEGIN' ? completed('BEGIN', 'T') : completed('ROLLBACK', 'I');
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
          return concatenate(backendError('XX000', 'queued operation failed'), ready('E'));
        }
        if (statement === 'COMMIT' && transactionAborted) {
          return completed('ROLLBACK', 'I');
        }
        if (statement === 'BEGIN') return completed('BEGIN', 'T');
        if (statement === 'COMMIT') return completed('COMMIT', 'I');
        return emptyComplete('I');
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
          return concatenate(backendError('XX000', 'savepoint operation failed'), ready('E'));
        }
        if (statement === 'COMMIT') {
          return completed('COMMIT', 'I');
        }
        if (statement === 'BEGIN') return completed('BEGIN', 'T');
        return completed(statement, 'T');
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

  it('poisons on transaction command tags before a later response error can hide them', async () => {
    const cases = [
      {
        response: concatenateMessages(
          commandComplete('COMMIT'),
          commandComplete('BEGIN'),
          backendError('XX000', 'later failure'),
          ready('T'),
        ),
        expected: 'command tag COMMIT',
      },
      {
        response: concatenateMessages(
          commandComplete('ROLLBACK'),
          commandComplete('BEGIN'),
          ready('T'),
        ),
        expected: 'command tag BEGIN',
      },
    ];

    for (const entry of cases) {
      const statements: string[] = [];
      const database = new WasixDatabaseImpl({
        async exec(input) {
          const statement = querySql(input);
          statements.push(statement);
          if (statement === 'BEGIN') return completed('BEGIN', 'T');
          return entry.response;
        },
        async sync() {},
        async close() {},
      });

      await expect(
        database.transaction((transaction) => {
          const ignored = transaction.exec('SELECT ownership_escape');
          void ignored.catch(() => undefined);
        }),
      ).rejects.toThrow(entry.expected);
      expect(statements).toEqual(['BEGIN', 'SELECT ownership_escape']);
      await expect(database.query('SELECT never_runs')).rejects.toThrow(
        'transaction outcome became unknown',
      );
      expect(statements).toEqual(['BEGIN', 'SELECT ownership_escape']);
      await database.close();
    }
  });

  it('poisons the handle when COMMIT returns a malformed successful response', async () => {
    const statements: string[] = [];
    const database = new WasixDatabaseImpl({
      async exec(input) {
        const statement = querySql(input);
        statements.push(statement);
        return statement === 'BEGIN' ? completed('BEGIN', 'T') : ready('I');
      },
      async sync() {},
      async close() {},
    });

    await expect(database.transaction(async () => 42)).rejects.toThrow(
      'query response omitted CommandComplete or EmptyQueryResponse',
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
        return statement === 'BEGIN' ? completed('BEGIN', 'T') : completed('COMMIT', 'I');
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
    await expect(transactionHandle.query('SELECT after_body')).rejects.toThrow(/finishing/);
    releaseCommit?.();
    await transaction;

    expect(statements).toEqual(['BEGIN', 'COMMIT']);
    await database.close();
  });

  it('recovers a failed BEGIN boundary and releases transaction ownership', async () => {
    const statements: string[] = [];
    const session: WasixDatabaseSession = {
      async exec(input) {
        const statement = querySql(input);
        statements.push(statement);
        if (statement === 'BEGIN') {
          return concatenate(backendError('XX000', 'BEGIN failed'), ready('E'));
        }
        if (statement === 'ROLLBACK') return completed('ROLLBACK', 'I');
        return emptyComplete('I');
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

    expect(statements).toEqual(['BEGIN', 'ROLLBACK', 'SELECT recovered']);
    await database.close();
  });

  it('poisons the database after a failed COMMIT response without sending rollback', async () => {
    const statements: string[] = [];
    const database = new WasixDatabaseImpl({
      async exec(input) {
        const statement = querySql(input);
        statements.push(statement);
        if (statement === 'BEGIN') return completed('BEGIN', 'T');
        if (statement === 'COMMIT') {
          return concatenate(backendError('XX000', 'COMMIT failed'), ready('I'));
        }
        return completed('SELECT 0', 'T');
      },
      async sync() {},
      async close() {},
    });

    await expect(
      database.transaction(async (transaction) => {
        await transaction.execute('SELECT inside');
      }),
    ).rejects.toMatchObject({ sqlstate: 'XX000' });
    await expect(database.query('SELECT never_runs')).rejects.toThrow(
      'transaction outcome became unknown',
    );
    expect(statements).toEqual(['BEGIN', 'SELECT inside', 'COMMIT']);
    await database.close();
  });

  it('preserves the callback error when best-effort rollback also fails', async () => {
    const statements: string[] = [];
    const session: WasixDatabaseSession = {
      async exec(input) {
        const statement = querySql(input);
        statements.push(statement);
        if (statement === 'BEGIN') return completed('BEGIN', 'T');
        return concatenate(backendError('XX000', 'rollback failed'), ready('E'));
      },
      async sync() {},
      async close() {},
    };
    const database = new WasixDatabaseImpl(session);
    const callbackError = new Error('keep me primary');

    const failure = await database
      .transaction(async () => {
        throw callbackError;
      })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors[0]).toBe(callbackError);
    expect((failure as AggregateError).errors[1]).toBeInstanceOf(PostgresError);
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
        const statement = querySql(input);
        statements.push(statement);
        return statement === 'BEGIN' ? completed('BEGIN', 'T') : ready('I');
      },
      async sync() {},
      async close() {},
    });
    const callbackError = new Error('keep malformed rollback secondary');

    const failure = await database
      .transaction(async () => {
        throw callbackError;
      })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors[0]).toBe(callbackError);
    expect((failure as AggregateError).errors[1]).toMatchObject({
      message: expect.stringContaining('omitted CommandComplete'),
    });
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

  it('preserves public raw input ownership for both execution surfaces', async () => {
    const executions: Uint8Array[] = [];
    const session: WasixDatabaseSession = {
      async exec(input) {
        executions.push(input);
        return executions.length === 1 ? completed('SELECT 0', 'I') : ready();
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
        return 'complete';
      },
      async sync() {},
      async close() {},
    });
    const input = Uint8Array.of(9, 8, 7);
    const received: Uint8Array[] = [];

    await database.execProtocolRawStream(input, (chunk) => {
      received.push(chunk);
    });

    expect(inputs).toHaveLength(1);
    expect(inputs[0]).not.toBe(input);
    expect(inputs[0]?.buffer).not.toBe(input.buffer);
    expect(inputs[0]).toEqual(input);
    expect(persistenceModes).toEqual(['sync']);
    expect(received).toEqual(chunks);
    await database.close();
  });

  it('preserves the consumer failure only after streamed protocol recovery is confirmed', async () => {
    const callbackFailure = { reason: 'consumer stopped' };
    let executions = 0;
    const database = new WasixDatabaseImpl({
      async exec() {
        executions += 1;
        return ready();
      },
      async execStream(_input, onChunk) {
        try {
          onChunk(Uint8Array.of(1));
        } catch {
          return 'callbackAborted';
        }
        return 'complete';
      },
      async sync() {},
      async close() {},
    });

    await expect(
      database.execProtocolRawStream(Uint8Array.of(1), () => {
        throw callbackFailure;
      }),
    ).rejects.toBe(callbackFailure);
    await expect(database.execProtocolRaw(Uint8Array.of(2))).resolves.toEqual(ready());
    expect(executions).toBe(1);
    await database.close();
  });

  it('keeps a streamed transport failure primary over the consumer failure and poisons the handle', async () => {
    const recoveryFailure = new Error('stream recovery failed');
    const database = new WasixDatabaseImpl({
      async exec() {
        return ready();
      },
      async execStream(_input, onChunk) {
        try {
          onChunk(Uint8Array.of(1));
        } catch {
          throw recoveryFailure;
        }
        return 'complete';
      },
      async sync() {},
      async close() {},
    });

    await expect(
      database.execProtocolRawStream(Uint8Array.of(1), () => {
        throw new Error('consumer stopped');
      }),
    ).rejects.toBe(recoveryFailure);
    await expect(database.execProtocolRaw(Uint8Array.of(2))).rejects.toMatchObject({
      message: expect.stringContaining('transaction outcome became unknown'),
      cause: recoveryFailure,
    });
    await database.close();
  });

  it.each([
    {
      name: 'callback recovery without a consumer failure',
      outcome: 'callbackAborted' as const,
      callback: (): undefined => undefined,
      message: 'without a retained callback failure',
    },
    {
      name: 'success after a consumer failure',
      outcome: 'complete' as const,
      callback: (): undefined => {
        throw new Error('consumer stopped');
      },
      message: 'success after rejecting its callback',
    },
  ])('poisons on an impossible stream outcome: $name', async ({ outcome, callback, message }) => {
    const database = new WasixDatabaseImpl({
      async exec() {
        return ready();
      },
      async execStream(_input, onChunk) {
        try {
          onChunk(Uint8Array.of(1));
        } catch {
          // The deliberately inconsistent outcome below is the subject of the test.
        }
        return outcome;
      },
      async sync() {},
      async close() {},
    });

    await expect(database.execProtocolRawStream(Uint8Array.of(1), callback)).rejects.toThrow(
      message,
    );
    await expect(database.execProtocolRaw(Uint8Array.of(2))).rejects.toThrow(
      'transaction outcome became unknown',
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

    await expect(
      database.execProtocolRawStream(Uint8Array.of(1), undefined as never),
    ).rejects.toThrow(TypeError);
    expect(executions).toBe(0);
    await database.close();
  });

  it('rejects thenable stream callbacks and preserves the caller failure', async () => {
    let bufferedExecutions = 0;
    const database = new WasixDatabaseImpl({
      async exec() {
        bufferedExecutions += 1;
        return ready();
      },
      async execStream(_input, onChunk) {
        try {
          onChunk(Uint8Array.of(1));
          return 'complete';
        } catch {
          return 'callbackAborted';
        }
      },
      async sync() {},
      async close() {},
    });

    const dynamicallyTypedAsyncCallback: (chunk: Uint8Array) => unknown = async () => undefined;
    await expect(
      database.execProtocolRawStream(
        Uint8Array.of(1),
        dynamicallyTypedAsyncCallback as unknown as (chunk: Uint8Array) => undefined,
      ),
    ).rejects.toThrow(/must complete synchronously.*Promise or thenable/);
    await expect(database.execProtocolRaw(Uint8Array.of(2))).resolves.toEqual(ready());
    const dynamicallyTypedThenableCallback: (chunk: Uint8Array) => unknown = () => ({
      then: () => undefined,
    });
    await expect(
      database.execProtocolRawStream(
        Uint8Array.of(1),
        dynamicallyTypedThenableCallback as unknown as (chunk: Uint8Array) => undefined,
      ),
    ).rejects.toThrow(/must complete synchronously.*Promise or thenable/);
    await expect(database.execProtocolRaw(Uint8Array.of(3))).resolves.toEqual(ready());
    expect(bufferedExecutions).toBe(2);
    await database.close();
  });

  it('rejects same-handle stream callback reentry without queueing side effects', async () => {
    const executedSql: string[] = [];
    const database = new WasixDatabaseImpl({
      async exec(input) {
        const sql = querySql(input);
        executedSql.push(sql);
        if (sql === 'BEGIN') return completed('BEGIN', 'T');
        return completed(sql === 'ROLLBACK' ? 'ROLLBACK' : 'COMMIT', 'I');
      },
      async execStream(_input, onChunk) {
        onChunk(Uint8Array.of(1));
        return 'complete';
      },
      async sync() {},
      async close() {},
    });

    let databaseReentry: Promise<unknown> | undefined;
    await database.execProtocolRawStream(Uint8Array.of(1), () => {
      databaseReentry = database.query("SELECT 'forbidden database callback reentry'");
    });
    await expect(databaseReentry).rejects.toThrow(
      /must not reenter the same Oliphaunt database or transaction/,
    );
    expect(executedSql).not.toContain("SELECT 'forbidden database callback reentry'");

    let closeReentry: Promise<unknown> | undefined;
    await database.execProtocolRawStream(Uint8Array.of(2), () => {
      closeReentry = database.close();
    });
    await expect(closeReentry).rejects.toThrow(
      /must not reenter the same Oliphaunt database or transaction/,
    );
    expect(database.closed).toBe(false);

    await database.close();
  });

  it('shares one terminal close attempt after session teardown fails', async () => {
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
    expect(database.closed).toBe(true);
    expect(database.close()).toBe(first);
    await expect(database.close()).rejects.toBe(failure);
    await expect(database.query('SELECT never_runs')).rejects.toThrow(
      'Oliphaunt WASIX database is closed',
    );
    expect(closes).toBe(1);
  });

  it('stays definitively closed when resource cleanup fails after session close', async () => {
    const cleanupFailure = new Error('resource cleanup failed');
    let sessionCloses = 0;
    let resourceCloses = 0;
    const database = new WasixDatabaseImpl({
      async exec() {
        return ready();
      },
      async sync() {},
      async close() {
        sessionCloses += 1;
      },
    });
    database.registerResource({
      close() {
        resourceCloses += 1;
        if (resourceCloses === 1) throw cleanupFailure;
      },
    });

    const first = database.close();
    await expect(first).rejects.toMatchObject({
      name: 'AggregateError',
      errors: [cleanupFailure],
    });
    expect(database.closed).toBe(true);
    const retry = database.close();
    expect(retry).toBe(first);
    await expect(retry).rejects.toMatchObject({
      name: 'AggregateError',
      errors: [cleanupFailure],
    });
    expect(sessionCloses).toBe(1);
    expect(resourceCloses).toBe(1);
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

    const closing = database.close();
    const failure = await closing.catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    if (!(failure instanceof AggregateError)) throw new Error('expected aggregate close failure');
    expect(failure.errors[0]).toBe(sessionFailure);
    const resourceFailure = failure.errors[1];
    expect(resourceFailure).toBeInstanceOf(AggregateError);
    if (!(resourceFailure instanceof AggregateError)) {
      throw new Error('expected aggregate resource failure');
    }
    expect(resourceFailure.errors).toEqual([firstResourceFailure, secondResourceFailure]);
    expect(database.closed).toBe(true);
    expect(database.close()).toBe(closing);
  });

  it('aborts SDK-owned execution when queued work prevents bounded shutdown', async () => {
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

      const closeAttempt = database.close();
      const close = expect(closeAttempt).rejects.toThrow(
        'close exceeded 120000ms; worker termination was requested',
      );
      await vi.advanceTimersByTimeAsync(120_000);
      await close;
      expect(aborts).toBe(1);
      expect(database.closed).toBe(true);
      await expect(database.query('SELECT never_runs')).rejects.toThrow(
        'Oliphaunt WASIX database is closed',
      );
      expect(database.close()).toBe(closeAttempt);
      await expect(database.close()).rejects.toThrow(
        'close exceeded 120000ms; worker termination was requested',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('waits for forced termination before releasing database resources', async () => {
    vi.useFakeTimers();
    try {
      const events: string[] = [];
      let finishTermination: (() => void) | undefined;
      const database = new WasixDatabaseImpl({
        exec() {
          return new Promise(() => undefined);
        },
        async sync() {},
        async close() {},
        abort() {
          events.push('abort');
          return new Promise<void>((resolve) => {
            finishTermination = () => {
              events.push('terminated');
              resolve();
            };
          });
        },
      });
      database.registerResource({
        close() {
          events.push('resource');
        },
      });
      void database.execProtocolRaw(Uint8Array.of(1));
      await Promise.resolve();

      const closeAttempt = database.close();
      let settled = false;
      void closeAttempt.catch(() => {
        settled = true;
      });
      const close = expect(closeAttempt).rejects.toThrow(
        'close exceeded 120000ms; worker termination was requested',
      );
      await vi.advanceTimersByTimeAsync(120_000);
      expect(events).toEqual(['abort']);
      expect(settled).toBe(false);
      expect(database.closed).toBe(false);

      finishTermination?.();
      await close;
      expect(events).toEqual(['abort', 'terminated', 'resource']);
      expect(database.closed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('preserves timeout, forced-termination, and resource cleanup failures', async () => {
    vi.useFakeTimers();
    try {
      const abortFailure = new Error('worker termination failed');
      const cleanupFailure = new Error('resource release failed');
      const database = new WasixDatabaseImpl({
        exec() {
          return new Promise(() => undefined);
        },
        async sync() {},
        async close() {},
        async abort() {
          throw abortFailure;
        },
      });
      database.registerResource({
        async close() {
          throw cleanupFailure;
        },
      });
      void database.execProtocolRaw(Uint8Array.of(1));
      await Promise.resolve();

      const closing = database.close();
      const observedFailure = closing.catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(120_000);
      const failure = await observedFailure;

      expect(failure).toBeInstanceOf(AggregateError);
      if (!(failure instanceof AggregateError)) throw new Error('expected aggregate failure');
      const sessionFailure = failure.errors[0];
      expect(sessionFailure).toBeInstanceOf(AggregateError);
      if (!(sessionFailure instanceof AggregateError)) {
        throw new Error('expected timeout and termination aggregate');
      }
      expect(sessionFailure.errors).toEqual([
        expect.objectContaining({ name: 'WasixCloseTimeoutError' }),
        abortFailure,
      ]);
      const resourceFailure = failure.errors[1];
      expect(resourceFailure).toBeInstanceOf(AggregateError);
      if (!(resourceFailure instanceof AggregateError)) {
        throw new Error('expected resource aggregate');
      }
      expect(resourceFailure.errors).toEqual([cleanupFailure]);
      expect(database.closed).toBe(true);
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
    const syncBoundaries: string[] = [];
    const session: WasixDatabaseSession = {
      async exec() {
        requests.push('exec');
        return completed('CHECKPOINT', 'I');
      },
      sync(boundary) {
        requests.push('sync');
        syncBoundaries.push(boundary);
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

    const checkpointExecution = expect(database.execute('CHECKPOINT')).rejects.toBe(storageFailure);
    await started;
    const queuedQuery = expect(database.query('select 42')).rejects.toMatchObject({
      name: 'WasixStorageError',
      code: 'publication-failed',
      commitState: 'not-persisted',
      message: expect.stringContaining('cannot be used after a persistence boundary failed'),
    });
    rejectPublication?.(storageFailure);

    await checkpointExecution;
    await queuedQuery;
    await expect(database.query('select 43')).rejects.toMatchObject({
      name: 'WasixStorageError',
      code: 'publication-failed',
      commitState: 'not-persisted',
      message: expect.stringContaining('cannot be used after a persistence boundary failed'),
    });
    expect(requests).toEqual(['exec', 'sync']);
    expect(syncBoundaries).toEqual(['operation']);

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
        return emptyComplete('I');
      },
      async sync() {
        requests.push('sync');
      },
      async close() {},
    };
    const database = new WasixDatabaseImpl(session);

    await expect(database.execute('CHECKPOINT')).rejects.toBeInstanceOf(PostgresError);
    await expect(database.query('select 42')).resolves.toMatchObject({
      rows: [],
      rowCount: null,
    });
    expect(requests).toEqual(['exec', 'sync', 'exec', 'sync']);
    await database.close();
  });
});

function ready(status: 'I' | 'T' | 'E' = 'I'): Uint8Array {
  return Uint8Array.of('Z'.charCodeAt(0), 0, 0, 0, 5, status.charCodeAt(0));
}

function completed(tag: string, status: 'I' | 'T' | 'E'): Uint8Array {
  return concatenateMessages(
    emptyBackendMessage('1'),
    emptyBackendMessage('2'),
    emptyBackendMessage('n'),
    commandComplete(tag),
    ready(status),
  );
}

function emptyComplete(status: 'I' | 'T' | 'E'): Uint8Array {
  return concatenateMessages(
    emptyBackendMessage('1'),
    emptyBackendMessage('2'),
    emptyBackendMessage('n'),
    emptyBackendMessage('I'),
    ready(status),
  );
}

function emptyBackendMessage(tag: string): Uint8Array {
  return Uint8Array.of(tag.charCodeAt(0), 0, 0, 0, 4);
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

function concatenateMessages(...messages: Uint8Array[]): Uint8Array {
  return messages.reduce(concatenate);
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
