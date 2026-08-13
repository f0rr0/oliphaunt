import { describe, expect, it } from 'vitest';

import { WasixStorageError } from '../errors.js';
import {
  acquireIndexedDbStorageWithBackend,
  type IndexedDbStorageBackend,
  type StoredDatabase,
  type StoredDatabaseStore,
  snapshotStorageDirectory,
  validateStoredDatabase,
  writeStoredDatabase,
} from '../storage/indexed-db-provider.js';
import {
  acquireWasixStorage,
  canonicalStorageContract,
  type StorageDirectory,
  type WasixStorageCompatibility,
} from '../storage-provider.js';

describe('WASIX IndexedDB PGDATA snapshots', () => {
  it('reports a missing Node directory integration without mislabeling the host', async () => {
    await expect(
      acquireWasixStorage(
        {
          schema: 'oliphaunt-wasix-storage-v1',
          kind: 'node-directory',
          path: '/tmp/oliphaunt-test',
        },
        pgdataTemplate(),
        compatible(),
      ),
    ).rejects.toThrow('Node directory storage is unavailable in this @oliphaunt/wasix-ts host');
  });

  it('recursively snapshots files and empty directories but not process lock files', async () => {
    const directory = fakeDirectory({
      '': [
        { type: 'file', name: 'postmaster.pid' },
        { type: 'dir', name: 'pg_wal' },
        { type: 'file', name: 'PG_VERSION' },
        { type: 'dir', name: 'empty' },
      ],
      pg_wal: [{ type: 'file', name: '000000010000000000000001' }],
      empty: [],
    });

    const snapshot = await snapshotStorageDirectory(directory);

    expect(snapshot.directories).toEqual(['empty', 'pg_wal']);
    expect(snapshot.files.map((file) => file.path)).toEqual([
      'PG_VERSION',
      'pg_wal/000000010000000000000001',
    ]);
    expect(new TextDecoder().decode(snapshot.files[0]?.bytes)).toBe('contents:PG_VERSION');
  });

  it('rejects directory entries Wasmer cannot represent safely', async () => {
    await expect(
      snapshotStorageDirectory(fakeDirectory({ '': [{ type: 'unknown', name: 'link' }] })),
    ).rejects.toThrow('unknown type');
    await expect(
      snapshotStorageDirectory(fakeDirectory({ '': [{ type: 'file', name: '../escape' }] })),
    ).rejects.toThrow('unsafe PGDATA entry name');
  });

  it('accepts an exact reopen identity and fails closed on extension changes', () => {
    const compatibility = compatible();
    const snapshot = {
      schema: 'oliphaunt-wasix-directory-snapshot-v1',
      directories: ['global'],
      files: [
        { path: 'global/pg_control', bytes: Uint8Array.of(1) },
        { path: 'PG_VERSION', bytes: new TextEncoder().encode('18\n') },
      ],
    };
    const storedDatabase = {
      schema: 'oliphaunt-wasix-indexed-db-database-v1',
      name: 'todos',
      compatibility,
      snapshot,
    };

    expect(validateStoredDatabase(storedDatabase, 'todos', compatibility)).toEqual(snapshot);

    const changed: WasixStorageCompatibility = {
      ...compatibility,
      extensions: [
        ...compatibility.extensions,
        {
          sqlName: 'vector',
          product: 'oliphaunt-extension-vector',
          version: '0.1.1',
          archiveSha256: '8'.repeat(64),
          installContract: '{}',
        },
      ],
    };
    expect(() => validateStoredDatabase(storedDatabase, 'todos', changed)).toThrowError(
      expect.objectContaining<Partial<WasixStorageError>>({
        code: 'incompatible',
        durability: 'unchanged',
      }),
    );
  });

  it('rejects corrupt paths and compatibility cycles before mounting bytes', () => {
    const compatibility = compatible();
    expect(() =>
      validateStoredDatabase(
        {
          schema: 'oliphaunt-wasix-indexed-db-database-v1',
          name: 'todos',
          compatibility,
          snapshot: {
            schema: 'oliphaunt-wasix-directory-snapshot-v1',
            directories: [],
            files: [{ path: '../PG_VERSION', bytes: new Uint8Array() }],
          },
        },
        'todos',
        compatibility,
      ),
    ).toThrowError(expect.objectContaining({ code: 'corrupt' }));

    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(() => canonicalStorageContract(cyclic)).toThrow('contains a cycle');
  });

  it('classifies malformed persisted record shapes as corrupt storage', () => {
    const compatibility = compatible();
    for (const stored of [
      null,
      {
        schema: 'oliphaunt-wasix-indexed-db-database-v1',
        name: 'todos',
        compatibility: null,
        snapshot: {},
      },
      {
        schema: 'oliphaunt-wasix-indexed-db-database-v1',
        name: 'todos',
        compatibility,
        snapshot: null,
      },
      {
        schema: 'oliphaunt-wasix-indexed-db-database-v1',
        name: 'todos',
        compatibility,
        snapshot: {
          schema: 'oliphaunt-wasix-directory-snapshot-v1',
          directories: [],
          files: [null],
        },
      },
    ]) {
      expect(() => validateStoredDatabase(stored, 'todos', compatibility)).toThrowError(
        expect.objectContaining<Partial<WasixStorageError>>({
          code: 'corrupt',
          durability: 'unchanged',
        }),
      );
    }
  });

  it('rejects semantically incomplete or transient PGDATA before mounting it', () => {
    const compatibility = compatible();
    const validate = (snapshot: unknown) =>
      validateStoredDatabase(
        {
          schema: 'oliphaunt-wasix-indexed-db-database-v1',
          name: 'todos',
          compatibility,
          snapshot,
        },
        'todos',
        compatibility,
      );
    const complete = {
      schema: 'oliphaunt-wasix-directory-snapshot-v1',
      directories: ['global'],
      files: [
        { path: 'PG_VERSION', bytes: new TextEncoder().encode('18\n') },
        { path: 'global/pg_control', bytes: Uint8Array.of(1) },
      ],
    };

    expect(() => validate({ ...complete, files: complete.files.slice(0, 1) })).toThrowError(
      expect.objectContaining({ code: 'corrupt', durability: 'unchanged' }),
    );
    expect(() =>
      validate({
        ...complete,
        files: [
          ...complete.files,
          { path: 'postmaster.pid', bytes: new TextEncoder().encode('123') },
        ],
      }),
    ).toThrow('transient PostgreSQL process state');
    expect(() =>
      validate({
        ...complete,
        files: [{ path: 'PG_VERSION', bytes: new TextEncoder().encode('17\n') }, complete.files[1]],
      }),
    ).toThrow('expected "18"');
    expect(() =>
      validate({
        ...complete,
        directories: [],
      }),
    ).toThrow('without parent directory "global"');
  });

  it('rejects snapshots whose file and directory ancestry conflict', () => {
    const compatibility = compatible();
    expect(() =>
      validateStoredDatabase(
        {
          schema: 'oliphaunt-wasix-indexed-db-database-v1',
          name: 'todos',
          compatibility,
          snapshot: {
            schema: 'oliphaunt-wasix-directory-snapshot-v1',
            directories: ['global', 'pg_wal/archive_status'],
            files: [
              { path: 'PG_VERSION', bytes: new TextEncoder().encode('18\n') },
              { path: 'global/pg_control', bytes: Uint8Array.of(1) },
              { path: 'pg_wal', bytes: Uint8Array.of(2) },
            ],
          },
        },
        'todos',
        compatibility,
      ),
    ).toThrow('below file "pg_wal"');
  });

  it('releases ownership after provider open failure and permits reacquisition', async () => {
    const harness = providerHarness();
    harness.failNextOpen(new Error('database open aborted'));

    await expect(
      acquireIndexedDbStorageWithBackend('todos', pgdataTemplate(), compatible(), harness.backend),
    ).rejects.toMatchObject({ code: 'unavailable', durability: 'unchanged' });
    expect(harness.isHeld()).toBe(false);

    const acquired = await acquireIndexedDbStorageWithBackend(
      'todos',
      pgdataTemplate(),
      compatible(),
      harness.backend,
    );
    expect(acquired.state).toBe('new');
    await acquired.close(undefined, 'failed');
    expect(harness.isHeld()).toBe(false);
  });

  it('preserves acquisition failures and releases ownership when connection cleanup throws', async () => {
    const harness = providerHarness();
    const readFailure = new Error('database read aborted');
    harness.failNextRead(readFailure);
    harness.failNextClose(new Error('connection close failed'));

    const failure = await rejection(
      acquireIndexedDbStorageWithBackend('todos', pgdataTemplate(), compatible(), harness.backend),
    );
    expect(failure).toMatchObject({ code: 'unavailable', durability: 'unchanged' });
    expect(failure.message).toContain('database read aborted');
    expect(failure.message).toContain('database connection cleanup also failed');
    expect(failure.cause).toBeInstanceOf(AggregateError);
    expect(harness.isHeld()).toBe(false);

    const reacquired = await acquireIndexedDbStorageWithBackend(
      'todos',
      pgdataTemplate(),
      compatible(),
      harness.backend,
    );
    await reacquired.close(undefined, 'failed');
  });

  it('releases ownership and reports a connection cleanup failure on lease close', async () => {
    const harness = providerHarness();
    const lease = await acquireIndexedDbStorageWithBackend(
      'todos',
      pgdataTemplate(),
      compatible(),
      harness.backend,
    );
    const closeFailure = new Error('connection close failed');
    harness.failNextClose(closeFailure);

    await expect(lease.close(undefined, 'failed')).rejects.toMatchObject({
      code: 'unavailable',
      durability: 'unchanged',
      cause: closeFailure,
    });
    expect(harness.isHeld()).toBe(false);

    const reacquired = await acquireIndexedDbStorageWithBackend(
      'todos',
      pgdataTemplate(),
      compatible(),
      harness.backend,
    );
    await reacquired.close(undefined, 'failed');
  });

  it('preserves the primary failure while reporting ownership-release failures', async () => {
    const harness = providerHarness();
    const readFailure = new Error('database read aborted');
    harness.failNextRead(readFailure);
    harness.failNextRelease(new Error('lock callback failed'));

    const failure = await rejection(
      acquireIndexedDbStorageWithBackend('todos', pgdataTemplate(), compatible(), harness.backend),
    );

    expect(failure).toMatchObject({ code: 'unavailable', durability: 'unchanged' });
    expect(failure.message).toContain('database read aborted');
    expect(failure.message).toContain('ownership release also failed');
    expect(failure.cause).toBeInstanceOf(AggregateError);
    expect(harness.isHeld()).toBe(false);
  });

  it('classifies an aborted checkpoint, releases the failed lease, and reacquires cleanly', async () => {
    const harness = providerHarness();
    const lease = await acquireIndexedDbStorageWithBackend(
      'todos',
      pgdataTemplate(),
      compatible(),
      harness.backend,
    );
    harness.failNextWrite(new Error('IndexedDB transaction aborted'));

    await expect(lease.checkpoint(pgdataDirectory())).rejects.toMatchObject({
      code: 'checkpoint-failed',
      durability: 'not-persisted',
    });
    expect(harness.isHeld()).toBe(true);
    await lease.close(undefined, 'failed');
    expect(harness.isHeld()).toBe(false);

    const reacquired = await acquireIndexedDbStorageWithBackend(
      'todos',
      pgdataTemplate(),
      compatible(),
      harness.backend,
    );
    expect(reacquired.state).toBe('new');
    await reacquired.close(undefined, 'failed');
  });

  it('publishes on clean close, releases ownership, and hydrates the next lease', async () => {
    const harness = providerHarness();
    const first = await acquireIndexedDbStorageWithBackend(
      'todos',
      pgdataTemplate(),
      compatible(),
      harness.backend,
    );

    await first.close(pgdataDirectory(), 'clean');
    expect(harness.isHeld()).toBe(false);

    const second = await acquireIndexedDbStorageWithBackend(
      'todos',
      pgdataTemplate(),
      compatible(),
      harness.backend,
    );
    expect(second.state).toBe('existing');
    expect(new TextDecoder().decode(second.mount.files.PG_VERSION)).toBe('18\n');
    expect(second.mount.files['global/pg_control']).toEqual(Uint8Array.of(1, 2, 3));
    await second.close(undefined, 'failed');
    expect(harness.isHeld()).toBe(false);
  });

  it('waits for IndexedDB transaction completion and rejects an abort', async () => {
    const failure = new Error('quota transaction aborted');
    type FakeTransaction = {
      error: Error;
      onabort: (() => void) | null;
      oncomplete: (() => void) | null;
      onerror: (() => void) | null;
      objectStore(): { put(value: unknown): void };
    };
    const transaction: FakeTransaction = {
      error: failure,
      onabort: null,
      oncomplete: null,
      onerror: null,
      objectStore() {
        return {
          put() {
            queueMicrotask(() => transaction.onabort?.());
          },
        };
      },
    };
    const database = {
      transaction() {
        return transaction;
      },
    } as unknown as IDBDatabase;

    await expect(writeStoredDatabase(database, storedDatabase('todos', compatible()))).rejects.toBe(
      failure,
    );
  });
});

function compatible(): WasixStorageCompatibility {
  return {
    schema: 'oliphaunt-wasix-pgdata-compatibility-v1',
    runtime: {
      product: 'liboliphaunt-wasix',
      version: '0.1.1',
      manifestSha256: '1'.repeat(64),
      runtimeArchiveSha256: '2'.repeat(64),
      pgdataTemplateSha256: '3'.repeat(64),
      moduleSha256: '4'.repeat(64),
      sourceFingerprint: 'source-v1',
      postgresVersion: '18.4',
    },
    extensions: [
      {
        sqlName: 'pgtap',
        product: 'oliphaunt-extension-pgtap',
        version: '0.1.1',
        archiveSha256: '5'.repeat(64),
        installContract: '{"schema":"v1"}',
      },
    ],
  };
}

function fakeDirectory(
  entries: Record<string, Awaited<ReturnType<StorageDirectory['readDir']>>>,
): StorageDirectory {
  return {
    async readDir(path) {
      const value = entries[path];
      if (value === undefined) {
        throw new Error(`missing fake directory ${path}`);
      }
      return value;
    },
    async readFile(path) {
      return new TextEncoder().encode(`contents:${path}`);
    },
  };
}

function pgdataTemplate() {
  return {
    directories: ['global'],
    files: {
      PG_VERSION: new TextEncoder().encode('18\n'),
      'global/pg_control': Uint8Array.of(1, 2, 3),
    },
  };
}

function pgdataDirectory(): StorageDirectory {
  return {
    async readDir(path) {
      if (path === '') {
        return [
          { type: 'file', name: 'PG_VERSION' },
          { type: 'dir', name: 'global' },
        ];
      }
      if (path === 'global') {
        return [{ type: 'file', name: 'pg_control' }];
      }
      throw new Error(`unexpected PGDATA directory ${path}`);
    },
    async readFile(path) {
      if (path === 'PG_VERSION') {
        return new TextEncoder().encode('18\n');
      }
      if (path === 'global/pg_control') {
        return Uint8Array.of(1, 2, 3);
      }
      throw new Error(`unexpected PGDATA file ${path}`);
    },
  };
}

function storedDatabase(name: string, compatibility: WasixStorageCompatibility): StoredDatabase {
  return {
    schema: 'oliphaunt-wasix-indexed-db-database-v1',
    name,
    compatibility,
    snapshot: {
      schema: 'oliphaunt-wasix-directory-snapshot-v1',
      directories: ['global'],
      files: [
        { path: 'PG_VERSION', bytes: new TextEncoder().encode('18\n') },
        { path: 'global/pg_control', bytes: Uint8Array.of(1, 2, 3) },
      ],
    },
  };
}

function providerHarness(): {
  backend: IndexedDbStorageBackend;
  failNextClose(error: Error): void;
  failNextOpen(error: Error): void;
  failNextRead(error: Error): void;
  failNextRelease(error: Error): void;
  failNextWrite(error: Error): void;
  isHeld(): boolean;
} {
  const records = new Map<string, StoredDatabase>();
  let held = false;
  let nextCloseFailure: Error | undefined;
  let nextOpenFailure: Error | undefined;
  let nextReadFailure: Error | undefined;
  let nextReleaseFailure: Error | undefined;
  let nextWriteFailure: Error | undefined;
  const backend: IndexedDbStorageBackend = {
    async acquireLock(name) {
      if (held) {
        throw new WasixStorageError(`storage ${name} is already held`, {
          code: 'busy',
          durability: 'unchanged',
        });
      }
      held = true;
      let released = false;
      return {
        async release() {
          if (!released) {
            released = true;
            held = false;
            if (nextReleaseFailure !== undefined) {
              const failure = nextReleaseFailure;
              nextReleaseFailure = undefined;
              throw failure;
            }
          }
        },
      };
    },
    async openDatabase(): Promise<StoredDatabaseStore> {
      if (nextOpenFailure !== undefined) {
        const failure = nextOpenFailure;
        nextOpenFailure = undefined;
        throw failure;
      }
      return {
        async read(name) {
          if (nextReadFailure !== undefined) {
            const failure = nextReadFailure;
            nextReadFailure = undefined;
            throw failure;
          }
          return records.get(name);
        },
        async write(database) {
          if (nextWriteFailure !== undefined) {
            const failure = nextWriteFailure;
            nextWriteFailure = undefined;
            throw failure;
          }
          records.set(database.name, structuredClone(database));
        },
        close() {
          if (nextCloseFailure !== undefined) {
            const failure = nextCloseFailure;
            nextCloseFailure = undefined;
            throw failure;
          }
        },
      };
    },
  };
  return {
    backend,
    failNextClose(error) {
      nextCloseFailure = error;
    },
    failNextOpen(error) {
      nextOpenFailure = error;
    },
    failNextRead(error) {
      nextReadFailure = error;
    },
    failNextRelease(error) {
      nextReleaseFailure = error;
    },
    failNextWrite(error) {
      nextWriteFailure = error;
    },
    isHeld() {
      return held;
    },
  };
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) return error;
    throw new Error(`expected Error rejection, received ${String(error)}`);
  }
  throw new Error('expected promise to reject');
}
