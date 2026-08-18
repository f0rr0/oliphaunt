import { describe, expect, it } from 'vitest';

import { WasixStorageError } from '../errors.js';
import {
  acquireIndexedDbStorageWithBackend,
  type IndexedDbStorageBackend,
  indexedDbDatabaseName,
  type StoredDatabase,
  type StoredDatabaseStore,
  validateStoredDatabase,
} from '../storage/indexed-db-provider.js';
import {
  acquireWasixStorage,
  canonicalStorageContract,
  type StorageDirectory,
  type WasixStorageCompatibility,
} from '../storage-provider.js';
import { snapshotStorageDelta, snapshotStorageDirectory } from '../storage-snapshot.js';

describe('WASIX incremental PGDATA storage', () => {
  it('reports a missing server directory integration without mislabeling the host', async () => {
    await expect(
      acquireWasixStorage(
        {
          schema: 'oliphaunt-wasix-storage-v2',
          kind: 'directory',
          path: '/tmp/oliphaunt-test',
        },
        pgdataTemplate(),
        compatible(),
      ),
    ).rejects.toThrow('directory storage is unavailable in this @oliphaunt/wasix-ts host');
  });

  it('recursively snapshots files and empty directories but not process state', async () => {
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
  });

  it('reads only journaled paths and expresses current-state removals', async () => {
    const reads: string[] = [];
    const directory: StorageDirectory = {
      changedPaths: () => ['base/1', 'pg_wal/0001'],
      entryType(path) {
        if (path === 'base/1') return 'missing';
        if (path === 'pg_wal/0001') return 'file';
        return 'unknown';
      },
      async readDir() {
        throw new Error('no directory scan expected');
      },
      async readFile(path) {
        reads.push(path);
        return Uint8Array.of(9);
      },
    };

    const delta = await snapshotStorageDelta(
      directory,
      new Map([
        ['PG_VERSION', 'file'],
        ['global', 'dir'],
        ['global/pg_control', 'file'],
        ['base', 'dir'],
        ['base/1', 'file'],
        ['pg_wal', 'dir'],
        ['pg_wal/0001', 'file'],
      ] as const),
    );

    expect(delta).toEqual({
      directories: [],
      files: [{ path: 'pg_wal/0001', bytes: Uint8Array.of(9) }],
      deleted: ['base/1'],
    });
    expect(reads).toEqual(['pg_wal/0001']);
  });

  it('deletes a persisted entry before replacing its path with another type', async () => {
    const directory: StorageDirectory = {
      changedPaths: () => ['base/1'],
      entryType: () => 'file',
      async readDir() {
        throw new Error('no directory scan expected');
      },
      async readFile() {
        return Uint8Array.of(7);
      },
    };

    const delta = await snapshotStorageDelta(directory, new Map([['base/1', 'dir']] as const));

    expect(delta).toEqual({
      directories: [],
      files: [{ path: 'base/1', bytes: Uint8Array.of(7) }],
      deleted: ['base/1'],
    });
  });

  it('rejects unsafe or unknown Wasmer entries', async () => {
    await expect(
      snapshotStorageDirectory(fakeDirectory({ '': [{ type: 'unknown', name: 'link' }] })),
    ).rejects.toThrow('unknown type');
    await expect(
      snapshotStorageDirectory(fakeDirectory({ '': [{ type: 'file', name: '../escape' }] })),
    ).rejects.toThrow('unsafe PGDATA entry name');
    await expect(
      snapshotStorageDelta(
        {
          changedPaths: () => ['link'],
          entryType: () => 'symlink' as never,
          readDir: async () => [],
          readFile: async () => Uint8Array.of(),
        },
        new Map(),
      ),
    ).rejects.toThrow('unknown type');
  });

  it('accepts an exact v3 identity and fails closed on extension changes', () => {
    const compatibility = compatible();
    const stored = storedDatabase('todos', compatibility);

    expect(validateStoredDatabase(stored, 'todos', compatibility).files).toHaveLength(2);

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
    expect(() => validateStoredDatabase(stored, 'todos', changed)).toThrowError(
      expect.objectContaining<Partial<WasixStorageError>>({
        code: 'incompatible',
        durability: 'unchanged',
      }),
    );
  });

  it('rejects malformed rows, incomplete PGDATA, and compatibility cycles', () => {
    const compatibility = compatible();
    expect(() =>
      validateStoredDatabase(
        {
          ...storedDatabase('todos', compatibility),
          entries: [{ path: '../PG_VERSION', type: 'file', bytes: new Uint8Array() }],
        },
        'todos',
        compatibility,
      ),
    ).toThrowError(expect.objectContaining({ code: 'corrupt' }));
    expect(() =>
      validateStoredDatabase(
        { ...storedDatabase('todos', compatibility), entries: [] },
        'todos',
        compatibility,
      ),
    ).toThrow('missing PG_VERSION or global/pg_control');

    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(() => canonicalStorageContract(cyclic)).toThrow('contains a cycle');
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
    await acquired.close(undefined, 'failed');
    expect(harness.isHeld()).toBe(false);
  });

  it('isolates logical databases as independent physical IndexedDB databases', async () => {
    const harness = providerHarness();

    const [todos, analytics] = await Promise.all([
      acquireIndexedDbStorageWithBackend('todos', pgdataTemplate(), compatible(), harness.backend),
      acquireIndexedDbStorageWithBackend(
        'analytics',
        pgdataTemplate(),
        compatible(),
        harness.backend,
      ),
    ]);

    expect(indexedDbDatabaseName('todos')).not.toBe(indexedDbDatabaseName('analytics'));
    expect(harness.openedNames()).toEqual(['todos', 'analytics']);
    expect(harness.isHeld('todos')).toBe(true);
    expect(harness.isHeld('analytics')).toBe(true);

    await Promise.all([todos.close(undefined, 'failed'), analytics.close(undefined, 'failed')]);
    expect(harness.isHeld('todos')).toBe(false);
    expect(harness.isHeld('analytics')).toBe(false);
  });

  it('classifies an aborted delta transaction and leaves the prior generation current', async () => {
    const harness = providerHarness();
    const lease = await acquireIndexedDbStorageWithBackend(
      'todos',
      pgdataTemplate(),
      compatible(),
      harness.backend,
    );
    harness.failNextApply(new Error('IndexedDB transaction aborted'));

    await expect(lease.sync(pgdataDirectory(), 'operation')).rejects.toMatchObject({
      code: 'checkpoint-failed',
      durability: 'not-persisted',
    });
    await lease.close(undefined, 'failed');

    const reacquired = await acquireIndexedDbStorageWithBackend(
      'todos',
      pgdataTemplate(),
      compatible(),
      harness.backend,
    );
    expect(reacquired.state).toBe('new');
    await reacquired.close(undefined, 'failed');
  });

  it('publishes on operation boundaries and hydrates the next lease', async () => {
    const harness = providerHarness();
    const first = await acquireIndexedDbStorageWithBackend(
      'todos',
      pgdataTemplate(),
      compatible(),
      harness.backend,
    );

    const directory = pgdataDirectory(true);
    await first.sync(directory, 'operation');
    await first.close(directory, 'clean');
    expect(harness.applyCount()).toBe(1);

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
  });

  it('acknowledges journal paths only after their durable generation commits', async () => {
    const harness = providerHarness();
    const lease = await acquireIndexedDbStorageWithBackend(
      'todos',
      pgdataTemplate(),
      compatible(),
      harness.backend,
    );
    let changes = [''];
    let control = Uint8Array.of(1, 2, 3);
    let acknowledgements = 0;
    const directory: StorageDirectory = {
      changedPaths: () => changes,
      clearChanges() {
        acknowledgements += 1;
        changes = [];
      },
      entryType(path) {
        if (path === '' || path === 'global') return 'dir';
        if (path === 'PG_VERSION' || path === 'global/pg_control') return 'file';
        return 'missing';
      },
      async readDir(path) {
        if (path === '') {
          return [
            { type: 'file', name: 'PG_VERSION' },
            { type: 'dir', name: 'global' },
          ];
        }
        if (path === 'global') return [{ type: 'file', name: 'pg_control' }];
        throw new Error(`unexpected PGDATA directory ${path}`);
      },
      async readFile(path) {
        if (path === 'PG_VERSION') return new TextEncoder().encode('18\n');
        if (path === 'global/pg_control') return control;
        throw new Error(`unexpected PGDATA file ${path}`);
      },
    };

    await lease.sync(directory, 'operation');
    expect(acknowledgements).toBe(1);

    control = Uint8Array.of(4, 5, 6);
    changes.push('global/pg_control');
    harness.failNextApply(new Error('IndexedDB transaction aborted'));
    await expect(lease.sync(directory, 'operation')).rejects.toMatchObject({
      durability: 'not-persisted',
    });
    expect(changes).toEqual(['global/pg_control']);
    expect(acknowledgements).toBe(1);

    await lease.sync(directory, 'operation');
    expect(acknowledgements).toBe(2);
    expect(changes).toEqual([]);
    await lease.close(undefined, 'failed');
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
      if (value === undefined) throw new Error(`missing fake directory ${path}`);
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

function pgdataDirectory(tracked = false): StorageDirectory {
  let changes = [''];
  return {
    ...(tracked
      ? {
          changedPaths() {
            return changes;
          },
          clearChanges() {
            changes = [];
          },
          entryType(path: string) {
            if (path === '' || path === 'global') return 'dir' as const;
            if (path === 'PG_VERSION' || path === 'global/pg_control') return 'file' as const;
            return 'missing' as const;
          },
        }
      : {}),
    async readDir(path) {
      if (path === '') {
        return [
          { type: 'file', name: 'PG_VERSION' },
          { type: 'dir', name: 'global' },
        ];
      }
      if (path === 'global') return [{ type: 'file', name: 'pg_control' }];
      throw new Error(`unexpected PGDATA directory ${path}`);
    },
    async readFile(path) {
      if (path === 'PG_VERSION') return new TextEncoder().encode('18\n');
      if (path === 'global/pg_control') return Uint8Array.of(1, 2, 3);
      throw new Error(`unexpected PGDATA file ${path}`);
    },
  };
}

function storedDatabase(name: string, compatibility: WasixStorageCompatibility): StoredDatabase {
  return {
    schema: 'oliphaunt-wasix-indexed-db-v3',
    name,
    compatibility,
    entries: [
      { path: 'global', type: 'dir' },
      {
        path: 'PG_VERSION',
        type: 'file',
        bytes: new TextEncoder().encode('18\n'),
      },
      {
        path: 'global/pg_control',
        type: 'file',
        bytes: Uint8Array.of(1, 2, 3),
      },
    ],
  };
}

function providerHarness(): {
  backend: IndexedDbStorageBackend;
  failNextApply(error: Error): void;
  failNextOpen(error: Error): void;
  isHeld(name?: string): boolean;
  openedNames(): string[];
  applyCount(): number;
} {
  const records = new Map<string, StoredDatabase>();
  const held = new Set<string>();
  const openedNames: string[] = [];
  let applies = 0;
  let nextOpenFailure: Error | undefined;
  let nextApplyFailure: Error | undefined;
  const backend: IndexedDbStorageBackend = {
    async acquireLock(name) {
      if (held.has(name)) {
        throw new WasixStorageError(`storage ${name} is already held`, {
          code: 'busy',
          durability: 'unchanged',
        });
      }
      held.add(name);
      return {
        async release() {
          held.delete(name);
        },
      };
    },
    async openDatabase(name): Promise<StoredDatabaseStore> {
      if (nextOpenFailure !== undefined) {
        const failure = nextOpenFailure;
        nextOpenFailure = undefined;
        throw failure;
      }
      openedNames.push(name);
      return {
        async read() {
          return records.get(name);
        },
        async apply(compatibility, delta) {
          if (nextApplyFailure !== undefined) {
            const failure = nextApplyFailure;
            nextApplyFailure = undefined;
            throw failure;
          }
          const rows = new Map(
            (records.get(name)?.entries ?? []).map((entry) => [entry.path, entry]),
          );
          for (const path of delta.deleted) rows.delete(path);
          for (const path of delta.directories) {
            rows.set(path, { path, type: 'dir' });
          }
          for (const { path, bytes } of delta.files) {
            rows.set(path, { path, type: 'file', bytes });
          }
          records.set(name, {
            schema: 'oliphaunt-wasix-indexed-db-v3',
            name,
            compatibility,
            entries: [...rows.values()] as StoredDatabase['entries'],
          });
          applies += 1;
        },
        close() {},
      };
    },
  };
  return {
    backend,
    failNextApply(error) {
      nextApplyFailure = error;
    },
    failNextOpen(error) {
      nextOpenFailure = error;
    },
    isHeld(name = 'todos') {
      return held.has(name);
    },
    openedNames() {
      return [...openedNames];
    },
    applyCount() {
      return applies;
    },
  };
}
