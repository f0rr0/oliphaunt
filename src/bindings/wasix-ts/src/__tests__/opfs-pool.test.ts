import { afterEach, describe, expect, it, vi } from 'vitest';

import type { WasixDirectoryMount } from '../archive.js';
import type { Directory } from '../host/index.mjs';
import {
  applyPooledOpfsDelta,
  DirectOpfsPool,
  inspectPooledOpfsDatabase,
  OPFS_POOL_ROOT,
} from '../storage/opfs-pool.js';
import { acquireOpfsStorage, restoreOpfsStorage } from '../storage/opfs-provider.js';
import {
  WASIX_PHYSICAL_IDENTITY,
  type WasixClusterSeedLoader,
  type WasixPhysicalIdentity,
} from '../storage-provider.js';

const OP = {
  metadata: 1,
  createDirectory: 3,
  rename: 5,
  open: 7,
  close: 8,
  read: 9,
  write: 10,
  flush: 11,
  truncate: 12,
  unlink: 13,
} as const;
const FLAG_READ = 1;
const FLAG_WRITE = 2;
const FLAG_CREATE = 8;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

describe('WASIX pooled OPFS storage', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('persists the opaque logical namespace across direct reopen', async () => {
    const root = installOpfs();
    const pool = await DirectOpfsPool.open('todos', clusterSeed(), compatible());
    expect(pool.state).toBe('new');

    requestOk(pool, OP.createDirectory, 'base/1');
    const descriptor = open(pool, 'base/1/value', FLAG_WRITE | FLAG_CREATE);
    write(pool, descriptor, encoder.encode('persisted'));
    requestOk(pool, OP.close, '', new Uint8Array(), descriptor);
    await pool.sync('checkpoint');
    await pool.close(true);

    const database = await databaseDirectory(root, 'todos');
    expect(await collectKeys(database)).toEqual(['data', 'state.json']);

    const reopened = await DirectOpfsPool.open(
      'todos',
      async () => {
        throw new Error('existing OPFS storage must not load the cluster seed');
      },
      compatible(),
    );
    expect(reopened.state).toBe('existing');
    const readDescriptor = open(reopened, 'base/1/value', FLAG_READ);
    expect(decoder.decode(read(reopened, readDescriptor, 32))).toBe('persisted');
    requestOk(reopened, OP.close, '', new Uint8Array(), readDescriptor);
    await reopened.close(false);
  });

  it('keeps an unlinked descriptor alive without resurrecting its path', async () => {
    installOpfs();
    const pool = await DirectOpfsPool.open('unlink', clusterSeed(), compatible());
    const descriptor = open(pool, 'base/transient', FLAG_READ | FLAG_WRITE | FLAG_CREATE);
    write(pool, descriptor, encoder.encode('still open'));
    requestOk(pool, OP.unlink, '', new Uint8Array(), descriptor);
    expect(pool.request(OP.metadata, 'base/transient', new Uint8Array(), 0, 0, 0)[0]).toBe(1);
    expect(decoder.decode(read(pool, descriptor, 32))).toBe('still open');
    requestOk(pool, OP.close, '', new Uint8Array(), descriptor);
    await pool.sync('operation');
    await pool.close(true);

    const reopened = await DirectOpfsPool.open('unlink', clusterSeed(), compatible());
    expect(reopened.request(OP.metadata, 'base/transient', new Uint8Array(), 0, 0, 0)[0]).toBe(1);
    await reopened.close(false);
  });

  it('keeps an open descriptor attached to its file across rename replacement', async () => {
    installOpfs();
    const pool = await DirectOpfsPool.open('rename-open', clusterSeed(), compatible());
    const descriptor = open(pool, 'base/source', FLAG_READ | FLAG_WRITE | FLAG_CREATE);
    write(pool, descriptor, encoder.encode('before'));
    const replaced = open(pool, 'base/destination', FLAG_WRITE | FLAG_CREATE);
    write(pool, replaced, encoder.encode('replaced'));
    requestOk(pool, OP.close, '', new Uint8Array(), replaced);

    requestOk(pool, OP.rename, 'base/source', encoder.encode('base/destination'));
    write(pool, descriptor, encoder.encode('-after'), 'before'.length);
    requestOk(pool, OP.close, '', new Uint8Array(), descriptor);
    await pool.sync('checkpoint');
    await pool.close(true);

    const reopened = await DirectOpfsPool.open('rename-open', clusterSeed(), compatible());
    expect(reopened.request(OP.metadata, 'base/source', new Uint8Array(), 0, 0, 0)[0]).toBe(1);
    const destination = open(reopened, 'base/destination', FLAG_READ);
    expect(decoder.decode(read(reopened, destination, 32))).toBe('before-after');
    requestOk(reopened, OP.close, '', new Uint8Array(), destination);
    await reopened.close(false);
  });

  it('flushes descriptors immediately and operation boundaries drain only WAL', async () => {
    const flushes: string[] = [];
    const io: FakeIo = { flushes };
    const root = installOpfs(io);
    const pool = await DirectOpfsPool.open('flush-order', clusterSeed(), compatible());
    for (const path of ['base/value', 'base/other', 'pg_wal/0001']) {
      const descriptor = open(pool, path, FLAG_WRITE | FLAG_CREATE);
      write(pool, descriptor, Uint8Array.of(1));
      requestOk(pool, OP.close, '', new Uint8Array(), descriptor);
    }
    await pool.sync('checkpoint');
    flushes.length = 0;

    const state = JSON.parse(
      await (await databaseDirectory(root, 'flush-order')).file('state.json').text(),
    ) as { entries: Array<{ path: string; backing?: string }> };
    const backing = (path: string): string => {
      const value = state.entries.find((entry) => entry.path === path)?.backing;
      if (value === undefined) throw new Error(`missing backing for ${path}`);
      return value;
    };
    const relation = open(pool, 'base/value', FLAG_WRITE);
    const ordinary = open(pool, 'base/other', FLAG_WRITE);
    const wal = open(pool, 'pg_wal/0001', FLAG_WRITE);
    const control = open(pool, 'global/pg_control', FLAG_WRITE);
    write(pool, relation, Uint8Array.of(2));
    write(pool, ordinary, Uint8Array.of(2));
    write(pool, wal, Uint8Array.of(2));
    write(pool, control, Uint8Array.of(2));

    requestOk(pool, OP.flush, '', new Uint8Array(), relation);
    expect(flushes.map(lastPathSegment)).toEqual([backing('base/value')]);
    flushes.length = 0;
    await pool.sync('operation');
    expect(flushes.map(lastPathSegment)).toEqual([backing('pg_wal/0001')]);
    await pool.sync('checkpoint');
    expect(flushes.map(lastPathSegment)).toEqual([
      backing('pg_wal/0001'),
      backing('base/other'),
      backing('global/pg_control'),
    ]);

    flushes.length = 0;
    const created = open(pool, 'base/new-relation', FLAG_WRITE | FLAG_CREATE);
    write(pool, created, Uint8Array.of(3));
    write(pool, wal, Uint8Array.of(3));
    write(pool, control, Uint8Array.of(3));
    await pool.sync('operation');
    const updated = JSON.parse(
      await (await databaseDirectory(root, 'flush-order')).file('state.json').text(),
    ) as { entries: Array<{ path: string; backing?: string }> };
    const createdBacking = updated.entries.find(
      (entry) => entry.path === 'base/new-relation',
    )?.backing;
    if (createdBacking === undefined) throw new Error('new relation was not published');
    expect(flushes.map(lastPathSegment)).toEqual([
      backing('pg_wal/0001'),
      createdBacking,
      backing('global/pg_control'),
    ]);

    for (const descriptor of [relation, ordinary, wal, control, created]) {
      requestOk(pool, OP.close, '', new Uint8Array(), descriptor);
    }
    await pool.close(false);
  });

  it('stages a creation burst beyond the preopened fast path and publishes it durably', async () => {
    installOpfs();
    const pool = await DirectOpfsPool.open('burst', clusterSeed(), compatible());
    for (let index = 0; index < 140; index += 1) {
      const descriptor = open(pool, `base/file-${index}`, FLAG_WRITE | FLAG_CREATE);
      write(pool, descriptor, Uint8Array.of(index));
      requestOk(pool, OP.close, '', new Uint8Array(), descriptor);
    }
    const large = open(pool, 'base/large-staged', FLAG_READ | FLAG_WRITE | FLAG_CREATE);
    const chunk = new Uint8Array(8 * 1024).fill(6);
    for (let index = 0; index < 64; index += 1) {
      write(pool, large, chunk, index * chunk.byteLength);
    }
    requestOk(pool, OP.truncate, '', new Uint8Array(), large, 128);
    requestOk(pool, OP.truncate, '', new Uint8Array(), large, 256);
    expect(read(pool, large, 256).slice(128)).toEqual(new Uint8Array(128));
    requestOk(pool, OP.close, '', new Uint8Array(), large);
    await pool.sync('checkpoint');
    await pool.close(true);

    const reopened = await DirectOpfsPool.open('burst', clusterSeed(), compatible());
    for (let index = 0; index < 140; index += 1) {
      const descriptor = open(reopened, `base/file-${index}`, FLAG_READ);
      expect(read(reopened, descriptor, 1)).toEqual(Uint8Array.of(index));
      requestOk(reopened, OP.close, '', new Uint8Array(), descriptor);
    }
    const largeReopened = open(reopened, 'base/large-staged', FLAG_READ);
    expect(read(reopened, largeReopened, 512)).toEqual(new Uint8Array(256).fill(6, 0, 128));
    requestOk(reopened, OP.close, '', new Uint8Array(), largeReopened);
    await reopened.close(false);
  });

  it('does not publish staged overflow when backing allocation fails', async () => {
    const io: FakeIo = {};
    installOpfs(io);
    const pool = await DirectOpfsPool.open('staged-failure', clusterSeed(), compatible());
    await pool.sync('checkpoint');
    for (let index = 0; index < 40; index += 1) {
      const descriptor = open(pool, `base/staged-${index}`, FLAG_WRITE | FLAG_CREATE);
      write(pool, descriptor, Uint8Array.of(index));
      requestOk(pool, OP.close, '', new Uint8Array(), descriptor);
    }

    io.syncAccessErrorName = 'QuotaExceededError';
    await expect(pool.sync('operation')).rejects.toMatchObject({ name: 'QuotaExceededError' });
    io.syncAccessErrorName = undefined;
    await pool.close(false);

    const reopened = await DirectOpfsPool.open('staged-failure', clusterSeed(), compatible());
    expect(reopened.state).toBe('existing');
    expect(reopened.request(OP.metadata, 'base/staged-0', new Uint8Array(), 0, 0, 0)[0]).toBe(1);
    await reopened.close(false);
  });

  it('does not fail a persisted boundary when optional spare replenishment fails', async () => {
    const io: FakeIo = {};
    const root = installOpfs(io);
    const pool = await DirectOpfsPool.open('replenishment', clusterSeed(), compatible());
    const descriptor = open(pool, 'base/value', FLAG_WRITE | FLAG_CREATE);
    write(pool, descriptor, Uint8Array.of(7));
    requestOk(pool, OP.close, '', new Uint8Array(), descriptor);

    io.syncAccessErrorName = 'QuotaExceededError';
    await expect(pool.sync('checkpoint')).resolves.toBeUndefined();
    io.syncAccessErrorName = undefined;
    await pool.close(false);

    const snapshot = await readSnapshot(
      await databaseDirectory(root, 'replenishment'),
      'replenishment',
      compatible(),
    );
    expect(snapshot?.files.find(({ path }) => path === 'base/value')?.bytes).toEqual(
      Uint8Array.of(7),
    );
  });

  it('uses the same durable format for direct and portable fallback paths', async () => {
    const root = installOpfs();
    const pool = await DirectOpfsPool.open('portable', clusterSeed(), compatible());
    const descriptor = open(pool, 'base/direct', FLAG_WRITE | FLAG_CREATE);
    write(pool, descriptor, Uint8Array.of(1, 2, 3));
    requestOk(pool, OP.close, '', new Uint8Array(), descriptor);
    await pool.close(true);

    const database = await databaseDirectory(root, 'portable');
    const snapshot = await readSnapshot(database, 'portable', compatible());
    expect(snapshot?.files.find(({ path }) => path === 'base/direct')?.bytes).toEqual(
      Uint8Array.of(1, 2, 3),
    );
    await applyPooledOpfsDelta(database.asHandle(), 'portable', compatible(), {
      directories: [],
      files: [{ path: 'base/direct', bytes: Uint8Array.of(4, 5) }],
      deleted: [],
    });

    const reopened = await DirectOpfsPool.open('portable', clusterSeed(), compatible());
    const readDescriptor = open(reopened, 'base/direct', FLAG_READ);
    expect(read(reopened, readDescriptor, 8)).toEqual(Uint8Array.of(4, 5));
    requestOk(reopened, OP.close, '', new Uint8Array(), readDescriptor);
    await reopened.close(false);
  });

  it('publishes portable files in PostgreSQL durability order before state', async () => {
    const writes: string[] = [];
    const origin = installOpfs({ writes });
    const root = await origin.getDirectoryHandle(OPFS_POOL_ROOT, { create: true });
    const database = await root.getDirectoryHandle('portable-order', { create: true });
    await applyPooledOpfsDelta(database.asHandle(), 'portable-order', compatible(), {
      directories: ['base', 'global', 'pg_wal'],
      files: [
        { path: 'global/pg_control', bytes: Uint8Array.of(1) },
        { path: 'base/value', bytes: Uint8Array.of(2) },
        { path: 'PG_VERSION', bytes: encoder.encode('18\n') },
        { path: 'pg_wal/0001', bytes: Uint8Array.of(3) },
      ],
      deleted: [],
    });

    const state = JSON.parse(await database.file('state.json').text()) as {
      entries: Array<{ path: string; backing?: string }>;
    };
    const logicalPath = new Map(
      state.entries.flatMap((entry) =>
        entry.backing === undefined ? [] : [[entry.backing, entry.path]],
      ),
    );
    expect(
      writes.map((path) => {
        const filename = lastPathSegment(path);
        return filename === 'state.json' ? filename : logicalPath.get(filename);
      }),
    ).toEqual(['pg_wal/0001', 'base/value', 'PG_VERSION', 'global/pg_control', 'state.json']);
  });

  it('keeps first-open setup pending when direct handles are unavailable', async () => {
    const io: FakeIo = { syncAccessErrorName: 'NotSupportedError' };
    installOpfs(io);

    const fallback = await acquireOpfsStorage('first-fallback', clusterSeed(), compatible());
    expect(fallback.state).toBe('new');
    expect(fallback.createPgdataDirectory).toBeUndefined();
    await fallback.close(undefined, 'failed');

    io.syncAccessErrorName = undefined;
    const direct = await DirectOpfsPool.open('first-fallback', clusterSeed(), compatible());
    expect(direct.state).toBe('new');
    await direct.sync('checkpoint');
    await direct.close(true);

    const reopened = await DirectOpfsPool.open('first-fallback', clusterSeed(), compatible());
    expect(reopened.state).toBe('existing');
    await reopened.close(false);
  });

  it('publishes an unchanged portable first-open generation as ready', async () => {
    const root = installOpfs();
    vi.stubGlobal('document', {});
    const lease = await acquireOpfsStorage('portable-initialization', clusterSeed(), compatible());
    expect(lease.state).toBe('new');
    const clearChanges = vi.fn();
    await lease.sync(
      {
        readDir: async () => [],
        readFile: async () => new Uint8Array(),
        changedPaths: () => [],
        entryType: async () => 'missing',
        clearChanges,
      },
      'checkpoint',
    );
    await lease.close(undefined, 'failed');

    const database = await databaseDirectory(root, 'portable-initialization');
    const state = JSON.parse(await database.file('state.json').text()) as { phase: string };
    expect(state.phase).toBe('ready');
    expect(clearChanges).toHaveBeenCalledOnce();
  });

  it('releases the direct host filesystem exactly once when its lease closes', async () => {
    installOpfs();
    const free = vi.fn();
    const createSync = vi.fn(() => directDirectory({ readTextFile: async () => '18\n', free }));
    const lease = await acquireOpfsStorage('direct-lifecycle', clusterSeed(), compatible());
    if (lease.createPgdataDirectory === undefined) throw new Error('expected direct OPFS storage');

    const directory = await lease.createPgdataDirectory({
      createSync,
    } as unknown as typeof Directory);
    await lease.close(directory, 'failed');
    await lease.close(directory, 'failed');

    expect(createSync).toHaveBeenCalledOnce();
    expect(free).toHaveBeenCalledOnce();
  });

  it('releases a direct host filesystem when bridge validation fails', async () => {
    installOpfs();
    const free = vi.fn();
    const lease = await acquireOpfsStorage(
      'direct-validation-failure',
      clusterSeed(),
      compatible(),
    );
    if (lease.createPgdataDirectory === undefined) throw new Error('expected direct OPFS storage');

    await expect(
      lease.createPgdataDirectory({
        createSync: () =>
          directDirectory({
            readTextFile: async () => {
              throw new Error('injected bridge read failure');
            },
            free,
          }),
      } as unknown as typeof Directory),
    ).rejects.toThrow('injected bridge read failure');
    await lease.close(undefined, 'failed');

    expect(free).toHaveBeenCalledOnce();
  });

  it('reports persisted when access-handle cleanup fails after a clean close sync', async () => {
    const io: FakeIo = {};
    installOpfs(io);
    const free = vi.fn();
    const lease = await acquireOpfsStorage('close-cleanup', clusterSeed(), compatible());
    if (lease.createPgdataDirectory === undefined) throw new Error('expected direct OPFS storage');
    const directory = await lease.createPgdataDirectory({
      createSync: () => directDirectory({ readTextFile: async () => '18\n', free }),
    } as unknown as typeof Directory);
    await lease.sync(directory, 'checkpoint');

    io.failNextAccessClose = true;
    await expect(lease.close(directory, 'clean')).rejects.toMatchObject({
      code: 'unavailable',
      commitState: 'persisted',
    });
    expect(free).toHaveBeenCalledOnce();
  });

  it('does not publish setup completion when its final state commit fails', async () => {
    const io: FakeIo = {};
    installOpfs(io);
    const pool = await DirectOpfsPool.open('initialization-marker', clusterSeed(), compatible());
    const control = open(pool, 'global/pg_control', FLAG_WRITE);
    requestOk(pool, OP.truncate, '', new Uint8Array(), control, 1);
    write(pool, control, Uint8Array.of(9));
    requestOk(pool, OP.close, '', new Uint8Array(), control);
    io.failNextStateCommit = true;
    await expect(pool.sync('checkpoint')).rejects.toThrow('injected state commit failure');
    await pool.close(false);

    const reopened = await DirectOpfsPool.open(
      'initialization-marker',
      clusterSeed(),
      compatible(),
    );
    expect(reopened.state).toBe('new');
    const restoredControl = open(reopened, 'global/pg_control', FLAG_READ);
    expect(read(reopened, restoredControl, 8)).toEqual(Uint8Array.of(1, 2, 3));
    requestOk(reopened, OP.close, '', new Uint8Array(), restoredControl);
    await reopened.close(false);
  });

  it('normalizes direct browser failures and classifies missing backings as corrupt', async () => {
    const io: FakeIo = { syncAccessErrorName: 'QuotaExceededError' };
    const root = installOpfs(io);
    const fallback = await acquireOpfsStorage('quota', clusterSeed(), compatible());
    expect(fallback.state).toBe('new');
    expect(fallback.createPgdataDirectory).toBeUndefined();
    await fallback.close(undefined, 'failed');

    io.syncAccessErrorName = undefined;
    const pool = await DirectOpfsPool.open('missing-backing', clusterSeed(), compatible());
    await pool.sync('checkpoint');
    await pool.close(true);
    const database = await databaseDirectory(root, 'missing-backing');
    const state = JSON.parse(await database.file('state.json').text()) as {
      entries: Array<{ path: string; type: string; backing?: string }>;
    };
    const version = state.entries.find((entry) => entry.path === 'PG_VERSION');
    if (version === undefined) throw new Error('test state lost PG_VERSION');
    version.backing = 'f-00000000-0000-4000-8000-000000000000';
    await database.file('state.json').replaceText(JSON.stringify(state));

    await expect(
      acquireOpfsStorage('missing-backing', clusterSeed(), compatible()),
    ).rejects.toMatchObject({
      name: 'WasixStorageError',
      code: 'corrupt',
      commitState: 'unchanged',
    });
    await expect(readSnapshot(database, 'missing-backing', compatible())).rejects.toMatchObject({
      name: 'WasixStorageError',
      code: 'corrupt',
      commitState: 'unchanged',
    });
  });

  it('scrubs transient PostgreSQL process files before portable hydration', async () => {
    const root = installOpfs();
    const pool = await DirectOpfsPool.open('volatile', clusterSeed(), compatible());
    await pool.close(true);
    const database = await databaseDirectory(root, 'volatile');
    await applyPooledOpfsDelta(database.asHandle(), 'volatile', compatible(), {
      directories: [],
      files: [{ path: 'postmaster.pid', bytes: encoder.encode('stale') }],
      deleted: [],
    });

    const snapshot = await readSnapshot(database, 'volatile', compatible());
    expect(snapshot?.files.some(({ path }) => path === 'postmaster.pid')).toBe(false);
    const reopened = await readSnapshot(database, 'volatile', compatible());
    expect(reopened?.files.some(({ path }) => path === 'postmaster.pid')).toBe(false);
  });

  it('fails closed for incompatible or structurally invalid state', async () => {
    const root = installOpfs();
    const pool = await DirectOpfsPool.open('guarded', clusterSeed(), compatible());
    await pool.close(true);
    const database = await databaseDirectory(root, 'guarded');
    const state = JSON.parse(await database.file('state.json').text()) as {
      physicalIdentity: { physicalFormat: string };
    };
    state.physicalIdentity.physicalFormat = 'wasix-pg18-v2';
    await database.file('state.json').replaceText(JSON.stringify(state));
    await expect(readSnapshot(database, 'guarded', compatible())).rejects.toMatchObject({
      code: 'incompatible',
      commitState: 'unchanged',
    });

    await database.file('state.json').replaceText(
      JSON.stringify({
        schema: 'oliphaunt-wasix-opfs-pool-v1',
        name: 'guarded',
        phase: 'ready',
        physicalIdentity: compatible(),
        entries: [{ path: '../escape', type: 'directory' }],
      }),
    );
    await expect(readSnapshot(database, 'guarded', compatible())).rejects.toMatchObject({
      code: 'corrupt',
      commitState: 'unchanged',
    });
  });

  it('rejects malformed, duplicate, and extended state metadata', async () => {
    const root = installOpfs();
    const pool = await DirectOpfsPool.open('malformed-state', clusterSeed(), compatible());
    await pool.sync('checkpoint');
    await pool.close(true);
    const database = await databaseDirectory(root, 'malformed-state');
    const state = JSON.parse(await database.file('state.json').text()) as Record<string, unknown>;
    const physicalIdentity = compatible();
    const valid = JSON.stringify(state);
    const malformed = [
      JSON.stringify({ ...state, physicalIdentity: 'not-an-object' }),
      JSON.stringify({ ...state, unexpected: true }),
      valid.replace(
        '"schema":"oliphaunt-wasix-opfs-pool-v1"',
        '"schema":"oliphaunt-wasix-opfs-pool-v1","schema":"oliphaunt-wasix-opfs-pool-v1"',
      ),
      valid.replace(
        `"physicalFormat":"${physicalIdentity.physicalFormat}"`,
        `"physicalFormat":"${physicalIdentity.physicalFormat}","physicalFormat":"${physicalIdentity.physicalFormat}"`,
      ),
    ];
    for (const text of malformed) {
      await database.file('state.json').replaceText(text);
      await expect(readSnapshot(database, 'malformed-state', compatible())).rejects.toMatchObject({
        code: 'corrupt',
        commitState: 'unchanged',
      });
    }
  });

  it('does not publish a namespace generation when its state commit fails', async () => {
    const io: FakeIo = {};
    const root = installOpfs(io);
    const pool = await DirectOpfsPool.open('atomic', clusterSeed(), compatible());
    const descriptor = open(pool, 'base/uncommitted', FLAG_WRITE | FLAG_CREATE);
    write(pool, descriptor, Uint8Array.of(7));
    requestOk(pool, OP.close, '', new Uint8Array(), descriptor);
    io.failNextStateCommit = true;
    await expect(pool.sync('checkpoint')).rejects.toThrow('injected state commit failure');
    await pool.close(false);

    const reopened = await DirectOpfsPool.open('atomic', clusterSeed(), compatible());
    expect(reopened.request(OP.metadata, 'base/uncommitted', new Uint8Array(), 0, 0, 0)[0]).toBe(1);
    await reopened.close(false);
    expect((await databaseDirectory(root, 'atomic')).file('state.json')).toBeDefined();
  });

  it('keeps the preceding portable generation when publication fails', async () => {
    const io: FakeIo = {};
    const root = installOpfs(io);
    const pool = await DirectOpfsPool.open('portable-atomic', clusterSeed(), compatible());
    await pool.close(true);
    const database = await databaseDirectory(root, 'portable-atomic');
    await applyPooledOpfsDelta(database.asHandle(), 'portable-atomic', compatible(), {
      directories: [],
      files: [{ path: 'base/value', bytes: Uint8Array.of(1) }],
      deleted: [],
    });

    io.failNextStateCommit = true;
    await expect(
      applyPooledOpfsDelta(database.asHandle(), 'portable-atomic', compatible(), {
        directories: [],
        files: [{ path: 'base/value', bytes: Uint8Array.of(2) }],
        deleted: [],
      }),
    ).rejects.toThrow('injected state commit failure');
    const snapshot = await readSnapshot(database, 'portable-atomic', compatible());
    expect(snapshot?.files.find(({ path }) => path === 'base/value')?.bytes).toEqual(
      Uint8Array.of(1),
    );
  });

  it('rejects a cluster seed without essential PostgreSQL control files', async () => {
    installOpfs();
    await expect(
      DirectOpfsPool.open(
        'invalid-seed',
        async () => ({
          directories: ['base', 'global'],
          files: { PG_VERSION: encoder.encode('18\n') },
        }),
        compatible(),
      ),
    ).rejects.toMatchObject({ code: 'corrupt', commitState: 'unchanged' });
  });

  it('replaces an unpublished initialization when restoring', async () => {
    const origin = installOpfs();
    const pool = await DirectOpfsPool.open('restore-initializing', clusterSeed(), compatible());
    expect(pool.state).toBe('new');
    await pool.close(false);

    await restoreOpfsStorage('restore-initializing', completeSnapshot(), compatible());
    const database = await databaseDirectory(origin, 'restore-initializing');
    const restored = await inspectPooledOpfsDatabase(
      database.asHandle(),
      'restore-initializing',
      compatible(),
    );
    expect(restored.state).toBe('existing');
    expect(restored.snapshot?.directories).toEqual(['global', 'pg_wal']);
    const restoredFiles = restored.snapshot?.files.map(({ path }) => path);
    expect(restoredFiles).toHaveLength(2);
    expect(restoredFiles).toEqual(expect.arrayContaining(['PG_VERSION', 'global/pg_control']));
  });

  it('leaves an interrupted restore destination retryable', async () => {
    const io: FakeIo = {};
    const origin = installOpfs(io);
    const pool = await DirectOpfsPool.open('restore-retry', clusterSeed(), compatible());
    await pool.close(false);

    io.failNextDataCommit = true;
    await expect(
      restoreOpfsStorage('restore-retry', completeSnapshot(), compatible()),
    ).rejects.toThrow('injected OPFS write failure');
    expect(await collectKeys(await databaseDirectory(origin, 'restore-retry'))).toEqual([]);

    await restoreOpfsStorage('restore-retry', completeSnapshot(), compatible());
    await expect(
      readSnapshot(await databaseDirectory(origin, 'restore-retry'), 'restore-retry', compatible()),
    ).resolves.toBeDefined();
  });

  it('rejects restoring over a published database', async () => {
    installOpfs();
    const pool = await DirectOpfsPool.open('restore-published', clusterSeed(), compatible());
    await pool.sync('checkpoint');
    await pool.close(true);

    await expect(
      restoreOpfsStorage('restore-published', completeSnapshot(), compatible()),
    ).rejects.toMatchObject({ code: 'incomplete', commitState: 'unchanged' });
  });

  it('preserves a caller-owned empty restore destination after publication fails', async () => {
    const io: FakeIo = {
      failNextDataCommit: true,
      lockReleaseFailure: new Error('injected ownership release failure'),
    };
    const origin = installOpfs(io);
    const root = await origin.getDirectoryHandle(OPFS_POOL_ROOT, { create: true });
    await root.getDirectoryHandle('restore-existing', { create: true });

    await expect(
      restoreOpfsStorage('restore-existing', completeSnapshot(), compatible()),
    ).rejects.toThrow(/injected OPFS write failure.*ownership release also failed/u);

    const restoredEmpty = await root.getDirectoryHandle('restore-existing');
    expect(await collectKeys(restoredEmpty)).toEqual([]);
  });

  it('reports persisted when ownership release fails after restore publication', async () => {
    const origin = installOpfs({
      lockReleaseFailure: new Error('injected ownership release failure'),
    });

    await expect(
      restoreOpfsStorage('restore-persisted', completeSnapshot(), compatible()),
    ).rejects.toMatchObject({ code: 'unavailable', commitState: 'persisted' });

    const database = await databaseDirectory(origin, 'restore-persisted');
    await expect(readSnapshot(database, 'restore-persisted', compatible())).resolves.toBeDefined();
  });

  it('removes an SDK-created restore destination after publication fails', async () => {
    const origin = installOpfs({ failNextDataCommit: true });

    await expect(
      restoreOpfsStorage('restore-new', completeSnapshot(), compatible()),
    ).rejects.toThrow('injected OPFS write failure');

    const root = await origin.getDirectoryHandle(OPFS_POOL_ROOT);
    await expect(root.getDirectoryHandle('restore-new')).rejects.toMatchObject({
      name: 'NotFoundError',
    });
  });
});

function requestOk(
  pool: DirectOpfsPool,
  opcode: number,
  path: string,
  buffer: Uint8Array = new Uint8Array(),
  arg0 = 0,
  arg1 = 0,
  flags = 0,
): readonly number[] {
  const result = pool.request(opcode, path, buffer, arg0, arg1, flags);
  expect(result[0], `opcode ${opcode} failed for ${path}`).toBe(0);
  return result;
}

function open(pool: DirectOpfsPool, path: string, flags: number): number {
  return requestOk(pool, OP.open, path, new Uint8Array(), 0, 0, flags)[2] as number;
}

function write(pool: DirectOpfsPool, descriptor: number, bytes: Uint8Array, offset = 0): void {
  const result = requestOk(pool, OP.write, '', bytes, descriptor, offset);
  expect(result[2]).toBe(bytes.byteLength);
}

function read(pool: DirectOpfsPool, descriptor: number, capacity: number): Uint8Array {
  const output = new Uint8Array(capacity);
  const result = requestOk(pool, OP.read, '', output, descriptor, 0);
  return output.slice(0, result[1]);
}

function clusterSeed(): WasixClusterSeedLoader {
  const mount: WasixDirectoryMount = {
    directories: ['base', 'global', 'pg_wal'],
    files: {
      PG_VERSION: encoder.encode('18\n'),
      'global/pg_control': Uint8Array.of(1, 2, 3),
    },
  };
  return async () => mount;
}

function completeSnapshot() {
  return {
    schema: 'oliphaunt-wasix-directory-snapshot-v1' as const,
    directories: ['global', 'pg_wal'],
    files: [
      { path: 'PG_VERSION', bytes: encoder.encode('18\n') },
      { path: 'global/pg_control', bytes: Uint8Array.of(1) },
    ],
  };
}

function compatible(): WasixPhysicalIdentity {
  return { ...WASIX_PHYSICAL_IDENTITY };
}

function directDirectory(overrides: Pick<Directory, 'readTextFile' | 'free'>): Directory {
  return overrides as unknown as Directory;
}

type FakeIo = {
  failNextAccessClose?: boolean;
  failNextStateCommit?: boolean;
  failNextDataCommit?: boolean;
  flushes?: string[];
  lockReleaseFailure?: Error;
  syncAccessErrorName?: string;
  writes?: string[];
};

function installOpfs(io: FakeIo = {}): FakeDirectory {
  const root = new FakeDirectory('', io);
  vi.stubGlobal('navigator', {
    locks: {
      request: async (
        _name: string,
        _options: unknown,
        callback: (lock: object) => Promise<unknown>,
      ) => {
        const result = await callback({});
        if (io.lockReleaseFailure !== undefined) throw io.lockReleaseFailure;
        return result;
      },
    },
    storage: { getDirectory: async () => root.asHandle() },
  });
  return root;
}

async function databaseDirectory(root: FakeDirectory, name: string): Promise<FakeDirectory> {
  return await (await root.getDirectoryHandle(OPFS_POOL_ROOT)).getDirectoryHandle(name);
}

async function readSnapshot(
  database: FakeDirectory,
  name: string,
  physicalIdentity: WasixPhysicalIdentity,
) {
  return (await inspectPooledOpfsDatabase(database.asHandle(), name, physicalIdentity)).snapshot;
}

async function collectKeys(directory: FakeDirectory): Promise<string[]> {
  const keys: string[] = [];
  for await (const key of directory.keys()) keys.push(key);
  return keys.sort();
}

class FakeDirectory {
  readonly kind = 'directory';
  readonly #path: string;
  readonly #io: FakeIo;
  readonly #entries = new Map<string, FakeDirectory | FakeFile>();

  constructor(path: string, io: FakeIo) {
    this.#path = path;
    this.#io = io;
  }

  asHandle(): FileSystemDirectoryHandle {
    return this as unknown as FileSystemDirectoryHandle;
  }

  async getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<FakeDirectory> {
    const existing = this.#entries.get(name);
    if (existing instanceof FakeDirectory) return existing;
    if (existing !== undefined || options?.create !== true) throw notFound();
    const directory = new FakeDirectory(join(this.#path, name), this.#io);
    this.#entries.set(name, directory);
    return directory;
  }

  async getFileHandle(name: string, options?: { create?: boolean }): Promise<FakeFile> {
    const existing = this.#entries.get(name);
    if (existing instanceof FakeFile) return existing;
    if (existing !== undefined || options?.create !== true) throw notFound();
    const file = new FakeFile(join(this.#path, name), this.#io);
    this.#entries.set(name, file);
    return file;
  }

  file(name: string): FakeFile {
    const entry = this.#entries.get(name);
    if (!(entry instanceof FakeFile)) throw notFound();
    return entry;
  }

  async removeEntry(name: string): Promise<void> {
    if (!this.#entries.delete(name)) throw notFound();
  }

  async *keys(): AsyncGenerator<string> {
    yield* this.#entries.keys();
  }
}

class FakeFile {
  readonly kind = 'file';
  readonly #path: string;
  readonly #io: FakeIo;
  #bytes = new Uint8Array();
  #open = false;

  constructor(path: string, io: FakeIo) {
    this.#path = path;
    this.#io = io;
  }

  asHandle(): FileSystemFileHandle {
    return this as unknown as FileSystemFileHandle;
  }

  async getFile(): Promise<File> {
    const bytes = this.#bytes.slice();
    return {
      size: bytes.byteLength,
      arrayBuffer: async () => bytes.buffer,
      text: async () => decoder.decode(bytes),
    } as File;
  }

  async text(): Promise<string> {
    return decoder.decode(this.#bytes);
  }

  async createWritable(): Promise<FileSystemWritableFileStream> {
    let next = this.#bytes.slice();
    return {
      write: async (value: FileSystemWriteChunkType) => {
        if (!(value instanceof Uint8Array)) throw new TypeError('test expects byte writes');
        next = Uint8Array.from(value as Uint8Array);
      },
      close: async () => {
        if (this.#path.endsWith('/state.json') && this.#io.failNextStateCommit === true) {
          this.#io.failNextStateCommit = false;
          throw new Error('injected state commit failure');
        }
        if (this.#path.includes('/data/') && this.#io.failNextDataCommit === true) {
          this.#io.failNextDataCommit = false;
          throw new Error('injected OPFS write failure');
        }
        this.#bytes = next;
        this.#io.writes?.push(this.#path);
      },
      abort: async () => undefined,
    } as unknown as FileSystemWritableFileStream;
  }

  async createSyncAccessHandle(): Promise<FakeSyncAccessHandle> {
    if (this.#io.syncAccessErrorName !== undefined) {
      throw new DOMException('injected synchronous access failure', this.#io.syncAccessErrorName);
    }
    if (this.#open) throw new DOMException('already open', 'NoModificationAllowedError');
    this.#open = true;
    return {
      close: () => {
        this.#open = false;
        if (this.#io.failNextAccessClose === true) {
          this.#io.failNextAccessClose = false;
          throw new Error('injected access-handle close failure');
        }
      },
      flush: () => {
        this.#io.flushes?.push(this.#path);
      },
      getSize: () => this.#bytes.byteLength,
      read: (output, { at }) => {
        const length = Math.max(0, Math.min(output.byteLength, this.#bytes.byteLength - at));
        output.set(this.#bytes.subarray(at, at + length));
        return length;
      },
      truncate: (size) => {
        const next = new Uint8Array(size);
        next.set(this.#bytes.subarray(0, size));
        this.#bytes = next;
      },
      write: (input, { at }) => {
        const required = at + input.byteLength;
        if (required > this.#bytes.byteLength) {
          const next = new Uint8Array(required);
          next.set(this.#bytes);
          this.#bytes = next;
        }
        this.#bytes.set(input, at);
        return input.byteLength;
      },
    };
  }

  async replaceText(value: string): Promise<void> {
    this.#bytes = encoder.encode(value);
  }
}

type FakeSyncAccessHandle = {
  close(): void;
  flush(): void;
  getSize(): number;
  read(buffer: Uint8Array, options: { at: number }): number;
  truncate(size: number): void;
  write(buffer: Uint8Array, options: { at: number }): number;
};

function join(parent: string, name: string): string {
  return parent === '' ? name : `${parent}/${name}`;
}

function lastPathSegment(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

function notFound(): DOMException {
  return new DOMException('missing', 'NotFoundError');
}
