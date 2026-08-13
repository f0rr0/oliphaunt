import { describe, expect, it, vi } from 'vitest';

import { WasixDatabaseImpl, type WasixDatabaseSession } from '../database.js';
import { WasixStorageError } from '../errors.js';
import { PostgresError } from '../query.js';
import type { OliphauntTransaction } from '../types.js';

describe('WASIX database recovery state', () => {
  it('pins callback transactions, commits results, and expires the transaction handle', async () => {
    const statements: string[] = [];
    const session: WasixDatabaseSession = {
      async exec(input) {
        statements.push(simpleQuerySql(input));
        return ready();
      },
      async checkpoint() {},
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
    await expect(expired!.query('SELECT too_late')).rejects.toThrow(/no longer active/);
    await database.close();
  });

  it('rolls back callback failures and leaves the database usable', async () => {
    const statements: string[] = [];
    const session: WasixDatabaseSession = {
      async exec(input) {
        statements.push(simpleQuerySql(input));
        return ready();
      },
      async checkpoint() {},
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
    await database.close();
  });

  it('rolls back when the callback leaves a failed operation unawaited', async () => {
    const statements: string[] = [];
    let transactionAborted = false;
    const session: WasixDatabaseSession = {
      async exec(input) {
        const statement = simpleQuerySql(input);
        statements.push(statement);
        if (statement === 'SELECT rejected') {
          transactionAborted = true;
          return concatenate(backendError('XX000', 'queued operation failed'), ready());
        }
        if (statement === 'COMMIT' && transactionAborted) {
          return concatenate(commandComplete('ROLLBACK'), ready());
        }
        return ready();
      },
      async checkpoint() {},
      async close() {},
    };
    const database = new WasixDatabaseImpl(session);
    let ignored: Promise<Uint8Array> | undefined;

    await expect(
      database.transaction((transaction) => {
        ignored = transaction.execute('SELECT rejected');
        return 42;
      }),
    ).rejects.toMatchObject({ sqlstate: 'XX000' });
    await expect(ignored).rejects.toMatchObject({ sqlstate: 'XX000' });

    expect(statements).toEqual(['BEGIN', 'SELECT rejected', 'COMMIT', 'ROLLBACK']);
    await database.close();
  });

  it('commits after a caught failure is recovered to a savepoint', async () => {
    const statements: string[] = [];
    const session: WasixDatabaseSession = {
      async exec(input) {
        const statement = simpleQuerySql(input);
        statements.push(statement);
        if (statement === 'SELECT rejected') {
          return concatenate(backendError('XX000', 'savepoint operation failed'), ready());
        }
        if (statement === 'COMMIT') {
          return concatenate(commandComplete('COMMIT'), ready());
        }
        return ready();
      },
      async checkpoint() {},
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

  it('seals the callback handle before commit begins', async () => {
    const statements: string[] = [];
    let releaseCommit: (() => void) | undefined;
    let commitStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      commitStarted = resolve;
    });
    const session: WasixDatabaseSession = {
      async exec(input) {
        const statement = simpleQuerySql(input);
        statements.push(statement);
        if (statement === 'COMMIT') {
          commitStarted?.();
          await new Promise<void>((resolve) => {
            releaseCommit = resolve;
          });
        }
        return ready();
      },
      async checkpoint() {},
      async close() {},
    };
    const database = new WasixDatabaseImpl(session);
    let transactionHandle: OliphauntTransaction | undefined;

    const transaction = database.transaction((handle) => {
      transactionHandle = handle;
    });
    await started;
    await expect(transactionHandle!.query('SELECT after_body')).rejects.toThrow(/no longer active/);
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
        const statement = simpleQuerySql(input);
        statements.push(statement);
        return statement === failedStatement
          ? concatenate(backendError('XX000', `${failedStatement} failed`), ready())
          : ready();
      },
      async checkpoint() {},
      async close() {},
    };
    const database = new WasixDatabaseImpl(session);

    await expect(
      database.transaction(async (transaction) => {
        await transaction.execute('SELECT inside');
      }),
    ).rejects.toMatchObject({ sqlstate: 'XX000' });
    await expect(database.query('SELECT recovered')).resolves.toMatchObject({ rowCount: 0 });

    expect(statements).toEqual(
      failedStatement === 'BEGIN'
        ? ['BEGIN', 'ROLLBACK', 'SELECT recovered']
        : ['BEGIN', 'SELECT inside', 'COMMIT', 'ROLLBACK', 'SELECT recovered'],
    );
    await database.close();
  });

  it('preserves the callback error when best-effort rollback also fails', async () => {
    const statements: string[] = [];
    const session: WasixDatabaseSession = {
      async exec(input) {
        const statement = simpleQuerySql(input);
        statements.push(statement);
        return statement === 'ROLLBACK'
          ? concatenate(backendError('XX000', 'rollback failed'), ready())
          : ready();
      },
      async checkpoint() {},
      async close() {},
    };
    const database = new WasixDatabaseImpl(session);
    const callbackError = new Error('keep me primary');

    await expect(
      database.transaction(async () => {
        throw callbackError;
      }),
    ).rejects.toBe(callbackError);
    await expect(database.query('SELECT recovered')).resolves.toMatchObject({ rowCount: 0 });
    expect(statements).toEqual(['BEGIN', 'ROLLBACK', 'SELECT recovered']);
    await database.close();
  });

  it('reports invalid transaction callbacks as asynchronous rejections', async () => {
    const database = new WasixDatabaseImpl({
      async exec() {
        return ready();
      },
      async checkpoint() {},
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
      async checkpoint() {},
      async close() {},
    };
    const database = new WasixDatabaseImpl(session);

    await database.execute('select 42');
    const raw = Uint8Array.of('Q'.charCodeAt(0), 0, 0, 0, 5, 0);
    await database.execProtocolRaw(raw);

    expect(executions).toHaveLength(2);
    expect(executions[1]).not.toBe(raw);
    expect(executions[1]?.buffer).not.toBe(raw.buffer);
    expect(raw).toEqual(Uint8Array.of('Q'.charCodeAt(0), 0, 0, 0, 5, 0));
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
      async checkpoint() {},
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

  it('aborts isolated execution when queued work prevents bounded shutdown', async () => {
    vi.useFakeTimers();
    try {
      let aborts = 0;
      const database = new WasixDatabaseImpl({
        exec() {
          return new Promise(() => undefined);
        },
        async checkpoint() {},
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
        async checkpoint() {},
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

  it('poisons queued and later work after persistent snapshot publication fails', async () => {
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
      checkpoint() {
        requests.push('checkpoint');
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
      code: 'checkpoint-failed',
      durability: 'not-persisted',
    });

    const checkpoint = expect(database.checkpoint()).rejects.toBe(storageFailure);
    await started;
    const queuedQuery = expect(database.query('select 42')).rejects.toMatchObject({
      name: 'WasixStorageError',
      code: 'checkpoint-failed',
      durability: 'not-persisted',
      message: expect.stringContaining('cannot be used after a persistence checkpoint failed'),
    });
    rejectPublication?.(storageFailure);

    await checkpoint;
    await queuedQuery;
    await expect(database.query('select 43')).rejects.toMatchObject({
      name: 'WasixStorageError',
      code: 'checkpoint-failed',
      durability: 'not-persisted',
      message: expect.stringContaining('cannot be used after a persistence checkpoint failed'),
    });
    expect(requests).toEqual(['exec', 'checkpoint']);

    await database.close();
    expect(requests).toEqual(['exec', 'checkpoint', 'close']);
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
      async checkpoint() {
        requests.push('checkpoint');
      },
      async close() {},
    };
    const database = new WasixDatabaseImpl(session);

    await expect(database.checkpoint()).rejects.toBeInstanceOf(PostgresError);
    await expect(database.query('select 42')).resolves.toMatchObject({ rows: [], rowCount: 0 });
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

function simpleQuerySql(input: Uint8Array): string {
  if (input[0] !== 'Q'.charCodeAt(0) || input.at(-1) !== 0) {
    throw new Error('test expected a simple-query packet');
  }
  return new TextDecoder().decode(input.subarray(5, -1));
}
