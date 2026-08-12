import { describe, expect, it } from 'vitest';

import { type WasixDatabaseWorker, WorkerWasixDatabase } from '../database.js';
import { WasixStorageError } from '../errors.js';
import { PostgresError } from '../query.js';

describe('WASIX database recovery state', () => {
  it('shares one close attempt, including its failure, with every caller', async () => {
    let rejectClose: ((error: Error) => void) | undefined;
    let closeStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      closeStarted = resolve;
    });
    let terminations = 0;
    const rpc: WasixDatabaseWorker = {
      request(request) {
        if (request.method !== 'close') {
          return Promise.resolve(undefined);
        }
        closeStarted?.();
        return new Promise((_, reject) => {
          rejectClose = reject;
        });
      },
      terminate() {
        terminations += 1;
      },
    };
    const database = new WorkerWasixDatabase(rpc);

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
    expect(terminations).toBe(1);
  });

  it('poisons queued and later work after persistent snapshot publication fails', async () => {
    let rejectPublication: ((error: Error) => void) | undefined;
    let publicationStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      publicationStarted = resolve;
    });
    const requests: string[] = [];
    let terminated = false;
    const rpc: WasixDatabaseWorker = {
      async request(request) {
        requests.push(request.method);
        if (request.method === 'exec') {
          return ready();
        }
        if (request.method === 'checkpoint') {
          publicationStarted?.();
          return new Promise((_, reject) => {
            rejectPublication = reject;
          });
        }
        return undefined;
      },
      terminate() {
        terminated = true;
      },
    };
    const database = new WorkerWasixDatabase(rpc);
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
    expect(terminated).toBe(true);
  });

  it('does not poison the handle for an ordinary PostgreSQL CHECKPOINT error', async () => {
    const requests: string[] = [];
    let firstExec = true;
    const rpc: WasixDatabaseWorker = {
      async request(request) {
        requests.push(request.method);
        if (request.method !== 'exec') {
          return undefined;
        }
        if (firstExec) {
          firstExec = false;
          return concatenate(backendError('42501', 'permission denied'), ready());
        }
        return ready();
      },
      terminate() {},
    };
    const database = new WorkerWasixDatabase(rpc);

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

function concatenate(left: Uint8Array, right: Uint8Array): Uint8Array {
  const result = new Uint8Array(left.length + right.length);
  result.set(left);
  result.set(right, left.length);
  return result;
}
