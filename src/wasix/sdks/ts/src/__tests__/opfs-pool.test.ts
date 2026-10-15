import { afterEach, describe, expect, it, vi } from 'bun:test';
import type { WasixDirectoryMount } from '../resources/archive.js';
import {
  applyPooledOpfsDelta,
  inspectPooledOpfsDatabase,
  OPFS_POOL_ROOT,
} from '../storage/opfs-pool.js';
import { acquireOpfsStorage, restoreOpfsStorage } from '../storage/opfs-provider.js';
import {
  WASIX_PHYSICAL_IDENTITY,
  type WasixClusterSeedLoader,
  type WasixPhysicalIdentity,
} from '../storage/storage-provider.js';
import { restoreGlobals, stubGlobal } from './test-globals.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
afterEach(() => restoreGlobals());

describe('WASIX pooled OPFS storage', () => {
  it.each([
    'data',
    'state',
  ] as const)('preserves committed bytes, lengths, and paths after a failed %s publication', async (failure) => {
    const io: FakeIo = {};
    const root = installOpfs(io);
    await seedPool(root, 'committed');
    const database = await databaseDirectory(root, 'committed');
    await applyPooledOpfsDelta(database.asHandle(), 'committed', compatible(), {
      directories: [],
      files: [
        { path: 'base/overwritten', bytes: Uint8Array.of(1, 2, 3) },
        { path: 'base/renamed', bytes: Uint8Array.of(4, 5) },
      ],
      deleted: [],
    });
    const committed = await readSnapshot(database, 'committed', compatible());
    if (failure === 'data') io.failNextDataCommit = true;
    else io.failNextStateCommit = true;
    await expect(
      applyPooledOpfsDelta(database.asHandle(), 'committed', compatible(), {
        directories: [],
        files: [
          { path: 'base/overwritten', bytes: Uint8Array.of(9) },
          { path: 'base/moved', bytes: Uint8Array.of(4, 5) },
          { path: 'global/pg_control', bytes: Uint8Array.of(8) },
        ],
        deleted: ['base/renamed'],
      }),
    ).rejects.toThrow(/injected/u);
    expect(await readSnapshot(database, 'committed', compatible())).toEqual(committed);
  });

  it('rebuilds a legacy unpublished initialization from its seed', async () => {
    const root = installOpfs();
    await seedPool(root, 'initializing', true);
    const lease = await acquireOpfsStorage('initializing', clusterSeed(), compatible());
    expect(lease.state).toBe('new');
    expect(lease.mount?.files['global/pg_control']).toEqual(Uint8Array.of(1, 2, 3));
    await lease.close(undefined, 'failed');
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

  it('keeps first-open setup pending after a failed initialization', async () => {
    const root = installOpfs();
    const fallback = await acquireOpfsStorage('first-fallback', clusterSeed(), compatible());
    expect(fallback.state).toBe('new');
    await fallback.close(undefined, 'failed');
    const reopened = await acquireOpfsStorage('first-fallback', clusterSeed(), compatible());
    expect(reopened.state).toBe('new');
    await reopened.close(undefined, 'failed');
    expect(await collectKeys(await databaseDirectory(root, 'first-fallback'))).toEqual([]);
  });

  it('publishes an unchanged portable first-open generation as ready', async () => {
    const root = installOpfs();
    stubGlobal('document', {});
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
      'full',
    );
    await lease.close(undefined, 'failed');

    const database = await databaseDirectory(root, 'portable-initialization');
    const state = JSON.parse(await database.file('state.json').text()) as { phase: string };
    expect(state.phase).toBe('ready');
    expect(clearChanges).toHaveBeenCalledTimes(1);
  });

  it('uses copy-on-write publication in worker realms with synchronous handles', async () => {
    installOpfs();
    const lease = await acquireOpfsStorage('worker-publication', clusterSeed(), compatible());
    expect(lease.createPgdataDirectory).toBeUndefined();
    expect(lease.state).toBe('new');
    await lease.close(undefined, 'failed');
    await lease.close(undefined, 'failed');
  });

  it('classifies missing backings as corrupt', async () => {
    const root = installOpfs();
    await seedPool(root, 'missing-backing');
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
    await seedPool(root, 'volatile', false);
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
    await seedPool(root, 'guarded', false);
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
    await seedPool(root, 'malformed-state', false);
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

  it('keeps the preceding portable generation when publication fails', async () => {
    const io: FakeIo = {};
    const root = installOpfs(io);
    await seedPool(root, 'portable-atomic', false);
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

  it('replaces an unpublished initialization when restoring', async () => {
    const origin = installOpfs();
    await seedPool(origin, 'restore-initializing', true);

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
    await seedPool(origin, 'restore-retry', true);

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
    const origin = installOpfs();
    await seedPool(origin, 'restore-published');

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
async function seedPool(root: FakeDirectory, name: string, initializing = false): Promise<void> {
  const pool = await root.getDirectoryHandle(OPFS_POOL_ROOT, { create: true });
  const database = await pool.getDirectoryHandle(name, { create: true });
  const seed = await clusterSeed()();
  await applyPooledOpfsDelta(database.asHandle(), name, compatible(), {
    directories: seed.directories,
    files: Object.entries(seed.files).map(([path, bytes]) => ({ path, bytes })),
    deleted: [],
  });
  if (initializing) {
    const state = JSON.parse(await database.file('state.json').text()) as { phase: string };
    state.phase = 'initializing';
    await database.file('state.json').replaceText(JSON.stringify(state));
  }
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

type FakeIo = {
  failNextStateCommit?: boolean;
  failNextDataCommit?: boolean;
  lockReleaseFailure?: Error;
  syncAccessErrorName?: string;
  writes?: string[];
  readBacking?: () => Promise<void>;
};

function installOpfs(io: FakeIo = {}): FakeDirectory {
  const root = new FakeDirectory('', io);
  stubGlobal('navigator', {
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
      arrayBuffer: async () => {
        if (this.#path.includes('/data/')) await this.#io.readBacking?.();
        return bytes.buffer;
      },
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

  async createSyncAccessHandle(): Promise<never> {
    throw new Error('copy-on-write storage must not open synchronous handles');
  }

  async replaceText(value: string): Promise<void> {
    this.#bytes = encoder.encode(value);
  }
}

function join(parent: string, name: string): string {
  return parent === '' ? name : `${parent}/${name}`;
}

function lastPathSegment(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

function notFound(): DOMException {
  return new DOMException('missing', 'NotFoundError');
}

it.each([
  1, 2, 5,
])('OPFS snapshots bound slow backing I/O at %s concurrent reads', async (maxConcurrentIO) => {
  let active = 0;
  let peak = 0;
  const io: FakeIo = {
    readBacking: async () => {
      active++;
      peak = Math.max(peak, active);
      await Promise.resolve();
      await Promise.resolve();
      active--;
    },
  };
  const root = installOpfs(io);
  await seedPool(root, 'concurrency');
  const database = await databaseDirectory(root, 'concurrency');
  await applyPooledOpfsDelta(database.asHandle(), 'concurrency', compatible(), {
    directories: ['base'],
    files: Array.from({ length: 9 }, (_, index) => ({
      path: `base/file${index}`,
      bytes: Uint8Array.of(index),
    })),
    deleted: [],
  });
  const lease = await acquireOpfsStorage(
    'concurrency',
    clusterSeed(),
    compatible(),
    maxConcurrentIO,
  );
  expect(peak).toBe(maxConcurrentIO);
  expect(lease.mount?.files['base/file8']).toEqual(Uint8Array.of(8));
  await lease.close(undefined, 'failed');
  restoreGlobals();
});
