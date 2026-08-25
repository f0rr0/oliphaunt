import { afterEach, describe, expect, it, vi } from 'vitest';

import { WasixStorageError } from '../errors.js';
import {
  acquireIndexedDbStorage,
  acquireIndexedDbStorageWithBackend,
  type IndexedDbStorageBackend,
  indexedDbDatabaseName,
  type StoredDatabase,
  type StoredDatabaseStore,
  validateStoredDatabase,
  restoreIndexedDbStorage,
} from '../storage/indexed-db-provider.js';
import {
  acquireWasixStorage,
  canonicalJson,
  installNodeDirectoryStorageProvider,
  installNodeDirectoryStorageRestorer,
  restoreWasixStorage,
  assertWasixPhysicalIdentity,
  WASIX_PHYSICAL_IDENTITY,
  type StorageDirectory,
  type WasixPhysicalIdentity,
} from '../storage-provider.js';
import { snapshotStorageDelta, snapshotStorageDirectory } from '../storage-snapshot.js';

afterEach(() => vi.unstubAllGlobals());

describe('WASIX incremental PGDATA storage', () => {
  it('reports a missing server directory integration without mislabeling the host', async () => {
    await expect(
      acquireWasixStorage(
        {
          schema: 'oliphaunt-wasix-storage-v1',
          kind: 'directory',
          path: '/tmp/oliphaunt-test',
        },
        clusterSeed(),
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

  it('uses the exact stable physical identity', () => {
    const compatibility = compatible();
    const stored = storedDatabase('todos', compatibility);

    expect(validateStoredDatabase(stored, 'todos', compatibility).files).toHaveLength(2);

    expect(() =>
      validateStoredDatabase(
        {
          ...stored,
          physicalIdentity: {
            ...stored.physicalIdentity,
            physicalFormat: 'wasix-pg18-v2',
          },
        },
        'todos',
        compatibility,
      ),
    ).toThrowError(expect.objectContaining({ code: 'incompatible' }));

    for (const physicalIdentity of [
      'not-an-object',
      { ...stored.physicalIdentity, unexpected: true },
      { ...stored.physicalIdentity, postgresMajor: '18' },
      { ...stored.physicalIdentity, physicalFormat: 18 },
    ]) {
      expect(() =>
        validateStoredDatabase({ ...stored, physicalIdentity }, 'todos', compatibility),
      ).toThrowError(expect.objectContaining({ code: 'corrupt' }));
    }

    expect(() =>
      validateStoredDatabase(
        {
          ...stored,
          physicalIdentity: { ...stored.physicalIdentity, postgresMajor: 19 },
        },
        'todos',
        compatibility,
      ),
    ).toThrowError(expect.objectContaining({ code: 'incompatible' }));
  });

  it('rejects malformed rows, incomplete PGDATA, and compatibility cycles', () => {
    const compatibility = compatible();
    expect(() =>
      validateStoredDatabase(
        { ...storedDatabase('todos', compatibility), unexpected: true },
        'todos',
        compatibility,
      ),
    ).toThrowError(expect.objectContaining({ code: 'corrupt' }));
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
        {
          ...storedDatabase('todos', compatibility),
          entries: [{ path: 'global', type: 'dir', unexpected: true }],
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
    ).toThrow('missing PG_VERSION, global/pg_control, or pg_wal');

    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(() => canonicalJson(cyclic)).toThrow('contains a cycle');
  });

  it('releases ownership after provider open failure and permits reacquisition', async () => {
    const harness = providerHarness();
    harness.failNextOpen(new Error('database open aborted'));

    await expect(
      acquireIndexedDbStorageWithBackend('todos', clusterSeed(), compatible(), harness.backend),
    ).rejects.toMatchObject({ code: 'unavailable', commitState: 'unchanged' });
    expect(harness.isHeld()).toBe(false);

    const acquired = await acquireIndexedDbStorageWithBackend(
      'todos',
      clusterSeed(),
      compatible(),
      harness.backend,
    );
    await acquired.close(undefined, 'failed');
    expect(harness.isHeld()).toBe(false);
  });

  it('preserves an IndexedDB restore failure when ownership release also fails', async () => {
    vi.stubGlobal('indexedDB', undefined);
    vi.stubGlobal('navigator', {
      locks: {
        async request(
          _name: string,
          _options: LockOptions,
          callback: (lock: Lock | null) => unknown,
        ) {
          await callback({ name: 'test', mode: 'exclusive' } as Lock);
          throw new Error('injected ownership release failure');
        },
      },
    });

    await expect(
      restoreIndexedDbStorage(
        'todos',
        {
          schema: 'oliphaunt-wasix-directory-snapshot-v1',
          directories: ['global', 'pg_wal'],
          files: [
            { path: 'PG_VERSION', bytes: new TextEncoder().encode('18\n') },
            { path: 'global/pg_control', bytes: Uint8Array.of(1) },
          ],
        },
        compatible(),
      ),
    ).rejects.toMatchObject({
      code: 'unavailable',
      commitState: 'unchanged',
      message: expect.stringMatching(/IndexedDB is unavailable.*ownership release also failed/u),
    });
  });

  it('isolates logical databases as independent physical IndexedDB databases', async () => {
    const harness = providerHarness();

    const [todos, analytics] = await Promise.all([
      acquireIndexedDbStorageWithBackend('todos', clusterSeed(), compatible(), harness.backend),
      acquireIndexedDbStorageWithBackend('analytics', clusterSeed(), compatible(), harness.backend),
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
      clusterSeed(),
      compatible(),
      harness.backend,
    );
    harness.failNextApply(new Error('IndexedDB transaction aborted'));

    await expect(lease.sync(pgdataDirectory(), 'operation')).rejects.toMatchObject({
      code: 'publication-failed',
      commitState: 'not-persisted',
    });
    await lease.close(undefined, 'failed');

    const reacquired = await acquireIndexedDbStorageWithBackend(
      'todos',
      clusterSeed(),
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
      clusterSeed(),
      compatible(),
      harness.backend,
    );

    const directory = pgdataDirectory(true);
    await first.sync(directory, 'operation');
    await first.close(directory, 'clean');
    expect(harness.applyCount()).toBe(1);

    const second = await acquireIndexedDbStorageWithBackend(
      'todos',
      async () => {
        throw new Error('existing IndexedDB storage must not load the cluster seed');
      },
      compatible(),
      harness.backend,
    );
    expect(second.state).toBe('existing');
    if (second.mount === undefined) throw new Error('IndexedDB did not provide a portable mount');
    expect(new TextDecoder().decode(second.mount.files.PG_VERSION)).toBe('18\n');
    expect(second.mount.files['global/pg_control']).toEqual(Uint8Array.of(1, 2, 3));
    await second.close(undefined, 'failed');
  });

  it('reports persisted when journal acknowledgement fails after publication', async () => {
    const harness = providerHarness();
    const lease = await acquireIndexedDbStorageWithBackend(
      'todos',
      clusterSeed(),
      compatible(),
      harness.backend,
    );
    const directory = pgdataDirectory(true);
    directory.clearChanges = () => {
      throw new Error('journal acknowledgement failed');
    };

    await expect(lease.sync(directory, 'operation')).rejects.toMatchObject({
      code: 'publication-failed',
      commitState: 'persisted',
    });
    expect(harness.applyCount()).toBe(1);
    await lease.close(undefined, 'failed');
  });

  it('acknowledges journal paths only after their durable generation commits', async () => {
    const harness = providerHarness();
    const lease = await acquireIndexedDbStorageWithBackend(
      'todos',
      clusterSeed(),
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
      commitState: 'not-persisted',
    });
    expect(changes).toEqual(['global/pg_control']);
    expect(acknowledgements).toBe(1);

    await lease.sync(directory, 'operation');
    expect(acknowledgements).toBe(2);
    expect(changes).toEqual([]);
    await lease.close(undefined, 'failed');
  });

  it('round-trips the browser IndexedDB adapter and rejects replacement restore', async () => {
    const factory = new FakeIndexedDbFactory();
    vi.stubGlobal('indexedDB', factory.asFactory());
    vi.stubGlobal('navigator', { locks: webLocks() });

    const snapshot = completeSnapshot();
    await restoreIndexedDbStorage('todos', snapshot, compatible());
    await expect(restoreIndexedDbStorage('todos', snapshot, compatible())).rejects.toMatchObject({
      code: 'incomplete',
      commitState: 'unchanged',
    });

    const lease = await acquireIndexedDbStorage('todos', clusterSeed(), compatible());
    expect(lease.state).toBe('existing');
    if (lease.mount === undefined) throw new Error('IndexedDB did not provide a portable mount');
    expect(new TextDecoder().decode(lease.mount.files.PG_VERSION)).toBe('18\n');
    expect(lease.mount.files['global/pg_control']).toEqual(Uint8Array.of(1, 2, 3));
    await lease.close(undefined, 'failed');
  });

  it('routes memory and installed directory storage without weakening descriptors', async () => {
    const seedMount = clusterSeedMount();
    const loadClusterSeed = async () => seedMount;
    const memory = await acquireWasixStorage(
      { schema: 'oliphaunt-wasix-storage-v1', kind: 'memory' },
      loadClusterSeed,
      compatible(),
    );
    expect(memory).toMatchObject({ state: 'new', mount: seedMount });
    await memory.sync(pgdataDirectory(), 'operation');
    await memory.close(undefined, 'clean');

    const calls: string[] = [];
    installNodeDirectoryStorageProvider(async (path, load, _compatibility, ownerToken) => {
      calls.push(`open:${path}:${ownerToken}`);
      return {
        state: 'new',
        mount: await load(),
        async sync() {},
        async close() {},
      };
    });
    installNodeDirectoryStorageRestorer(async (path, snapshot) => {
      calls.push(`restore:${path}:${snapshot.files.length}`);
    });
    const directory = await acquireWasixStorage(
      {
        schema: 'oliphaunt-wasix-storage-v1',
        kind: 'directory',
        path: '/tmp/todos',
        ownerToken: '0123456789abcdef',
      },
      loadClusterSeed,
      compatible(),
    );
    await directory.close(undefined, 'failed');
    await restoreWasixStorage(
      {
        schema: 'oliphaunt-wasix-storage-v1',
        kind: 'directory',
        path: '/tmp/restored',
      },
      completeSnapshot(),
      compatible(),
    );
    expect(calls).toEqual(['open:/tmp/todos:0123456789abcdef', 'restore:/tmp/restored:2']);

    await expect(
      restoreWasixStorage(
        { schema: 'oliphaunt-wasix-storage-v1', kind: 'memory' },
        completeSnapshot(),
        compatible(),
      ),
    ).rejects.toMatchObject({ code: 'unavailable', commitState: 'unchanged' });
    await expect(
      acquireWasixStorage(
        { schema: 'unsupported' as never, kind: 'memory' },
        loadClusterSeed,
        compatible(),
      ),
    ).rejects.toMatchObject({ code: 'unavailable', commitState: 'unchanged' });
  });

  it('rejects unsupported physical identities and non-JSON metadata', () => {
    expect(() =>
      assertWasixPhysicalIdentity({
        ...compatible(),
        schema: 'unsupported' as never,
      }),
    ).toThrow('unsupported physical identity');
    expect(() =>
      assertWasixPhysicalIdentity({
        ...compatible(),
        postgresMajor: 19,
      }),
    ).toThrow('unsupported physical identity');
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, undefined, () => undefined]) {
      expect(() => canonicalJson(value)).toThrow();
    }
  });
});

function compatible(): WasixPhysicalIdentity {
  return { ...WASIX_PHYSICAL_IDENTITY };
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

function clusterSeed() {
  const mount = clusterSeedMount();
  return async () => mount;
}

function clusterSeedMount() {
  return {
    directories: ['global', 'pg_wal'],
    files: {
      PG_VERSION: new TextEncoder().encode('18\n'),
      'global/pg_control': Uint8Array.of(1, 2, 3),
    },
  };
}

function completeSnapshot() {
  return {
    schema: 'oliphaunt-wasix-directory-snapshot-v1' as const,
    directories: ['global', 'pg_wal'],
    files: [
      { path: 'PG_VERSION', bytes: new TextEncoder().encode('18\n') },
      { path: 'global/pg_control', bytes: Uint8Array.of(1, 2, 3) },
    ],
  };
}

function webLocks() {
  return {
    async request(
      _name: string,
      _options: LockOptions,
      callback: (lock: Lock | null) => Promise<unknown> | unknown,
    ) {
      return callback({ name: 'test', mode: 'exclusive' } as Lock);
    },
  };
}

type FakeIndexedDbState = {
  metadata?: unknown;
  entries: Map<string, unknown>;
  stores: Set<string>;
};

class FakeIndexedDbFactory {
  readonly #databases = new Map<string, FakeIndexedDbState>();

  asFactory(): IDBFactory {
    return {
      open: (name: string) => this.#open(name),
    } as unknown as IDBFactory;
  }

  #open(name: string): IDBOpenDBRequest {
    const request = fakeRequestShell<IDBDatabase>() as IDBOpenDBRequest;
    queueMicrotask(() => {
      const existing = this.#databases.get(name);
      const state = existing ?? { entries: new Map(), stores: new Set() };
      this.#databases.set(name, state);
      const database = new FakeIndexedDbDatabase(state).asDatabase();
      setRequestResult(request, database);
      if (existing === undefined) {
        request.onupgradeneeded?.(new Event('upgradeneeded') as IDBVersionChangeEvent);
      }
      request.onsuccess?.(new Event('success'));
    });
    return request;
  }
}

class FakeIndexedDbDatabase {
  constructor(private readonly state: FakeIndexedDbState) {}

  asDatabase(): IDBDatabase {
    return {
      objectStoreNames: {
        contains: (name: string) => this.state.stores.has(name),
      },
      createObjectStore: (name: string) => {
        this.state.stores.add(name);
        return {} as IDBObjectStore;
      },
      transaction: (_names: string[], _mode: IDBTransactionMode) =>
        new FakeIndexedDbTransaction(this.state).asTransaction(),
      close() {},
    } as unknown as IDBDatabase;
  }
}

class FakeIndexedDbTransaction {
  readonly transaction = {
    error: null,
    oncomplete: null,
    onerror: null,
    onabort: null,
    objectStore: (name: string) => this.#objectStore(name),
  } as unknown as IDBTransaction;

  constructor(private readonly state: FakeIndexedDbState) {
    setTimeout(() => this.transaction.oncomplete?.(new Event('complete')), 0);
  }

  asTransaction(): IDBTransaction {
    return this.transaction;
  }

  #objectStore(name: string): IDBObjectStore {
    if (name === 'metadata') {
      return {
        get: () => fakeRequest(() => this.state.metadata),
        put: (value: unknown) => {
          this.state.metadata = value;
          return fakeRequest(() => undefined);
        },
      } as unknown as IDBObjectStore;
    }
    return {
      getAll: () => fakeRequest(() => [...this.state.entries.values()]),
      delete: (path: IDBValidKey) => {
        this.state.entries.delete(String(path));
        return fakeRequest(() => undefined);
      },
      put: (value: { path: string }) => {
        this.state.entries.set(value.path, value);
        return fakeRequest(() => undefined);
      },
    } as unknown as IDBObjectStore;
  }
}

function fakeRequestShell<T>(): IDBRequest<T> {
  return {
    result: undefined,
    error: null,
    onsuccess: null,
    onerror: null,
  } as unknown as IDBRequest<T>;
}

function fakeRequest<T>(read: () => T): IDBRequest<T> {
  const request = fakeRequestShell<T>();
  queueMicrotask(() => {
    try {
      setRequestResult(request, read());
      request.onsuccess?.(new Event('success'));
    } catch (error) {
      Object.defineProperty(request, 'error', {
        configurable: true,
        value: error,
      });
      request.onerror?.(new Event('error'));
    }
  });
  return request;
}

function setRequestResult<T>(request: IDBRequest<T>, result: T): void {
  Object.defineProperty(request, 'result', {
    configurable: true,
    value: result,
  });
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
            if (path === '' || path === 'global' || path === 'pg_wal') return 'dir' as const;
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
          { type: 'dir', name: 'pg_wal' },
        ];
      }
      if (path === 'global') return [{ type: 'file', name: 'pg_control' }];
      if (path === 'pg_wal') return [];
      throw new Error(`unexpected PGDATA directory ${path}`);
    },
    async readFile(path) {
      if (path === 'PG_VERSION') return new TextEncoder().encode('18\n');
      if (path === 'global/pg_control') return Uint8Array.of(1, 2, 3);
      throw new Error(`unexpected PGDATA file ${path}`);
    },
  };
}

function storedDatabase(name: string, compatibility: WasixPhysicalIdentity): StoredDatabase {
  return {
    schema: 'oliphaunt-wasix-indexed-db-v1',
    name,
    physicalIdentity: assertWasixPhysicalIdentity(compatibility),
    entries: [
      { path: 'global', type: 'dir' },
      { path: 'pg_wal', type: 'dir' },
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
          commitState: 'unchanged',
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
            schema: 'oliphaunt-wasix-indexed-db-v1',
            name,
            physicalIdentity: assertWasixPhysicalIdentity(compatibility),
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
