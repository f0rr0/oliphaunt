import { afterEach, describe, expect, it, vi } from 'vitest';

import type { WasixDirectoryMount } from '../archive.js';
import type { Directory } from '../host/index.mjs';
import { acquireOpfsStorage } from '../storage/opfs-provider.js';
import {
  applyPooledOpfsDelta,
  DirectOpfsPool,
  OPFS_POOL_ROOT,
  readPooledOpfsDatabase,
} from '../storage/opfs-pool.js';
import type { WasixStorageCompatibility } from '../storage-provider.js';

const OP = {
  metadata: 1,
  createDirectory: 3,
  open: 7,
  close: 8,
  read: 9,
  write: 10,
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
    const pool = await DirectOpfsPool.open('todos', template(), compatible());
    expect(pool.state).toBe('new');

    requestOk(pool, OP.createDirectory, 'base/1');
    const descriptor = open(pool, 'base/1/value', FLAG_WRITE | FLAG_CREATE);
    write(pool, descriptor, encoder.encode('persisted'));
    requestOk(pool, OP.close, '', new Uint8Array(), descriptor);
    await pool.sync('checkpoint');
    await pool.completeInitialization();
    await pool.close(true);

    const database = await databaseDirectory(root, 'todos');
    expect(await collectKeys(database)).toEqual(['data', 'state.json']);

    const reopened = await DirectOpfsPool.open('todos', template(), compatible());
    expect(reopened.state).toBe('existing');
    const readDescriptor = open(reopened, 'base/1/value', FLAG_READ);
    expect(decoder.decode(read(reopened, readDescriptor, 32))).toBe('persisted');
    requestOk(reopened, OP.close, '', new Uint8Array(), readDescriptor);
    await reopened.close(false);
  });

  it('keeps an unlinked descriptor alive without resurrecting its path', async () => {
    installOpfs();
    const pool = await DirectOpfsPool.open('unlink', template(), compatible());
    const descriptor = open(pool, 'base/transient', FLAG_READ | FLAG_WRITE | FLAG_CREATE);
    write(pool, descriptor, encoder.encode('still open'));
    requestOk(pool, OP.unlink, '', new Uint8Array(), descriptor);
    expect(pool.request(OP.metadata, 'base/transient', new Uint8Array(), 0, 0, 0)[0]).toBe(1);
    expect(decoder.decode(read(pool, descriptor, 32))).toBe('still open');
    requestOk(pool, OP.close, '', new Uint8Array(), descriptor);
    await pool.sync('operation');
    await pool.close(true);

    const reopened = await DirectOpfsPool.open('unlink', template(), compatible());
    expect(reopened.request(OP.metadata, 'base/transient', new Uint8Array(), 0, 0, 0)[0]).toBe(1);
    await reopened.close(false);
  });

  it('spills safely to memory when one operation exhausts the preopened pool', async () => {
    installOpfs();
    const pool = await DirectOpfsPool.open('burst', template(), compatible());
    for (let index = 0; index < 140; index += 1) {
      const descriptor = open(pool, `base/file-${index}`, FLAG_WRITE | FLAG_CREATE);
      write(pool, descriptor, Uint8Array.of(index));
      requestOk(pool, OP.close, '', new Uint8Array(), descriptor);
    }
    const large = open(pool, 'base/large-spill', FLAG_READ | FLAG_WRITE | FLAG_CREATE);
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

    const reopened = await DirectOpfsPool.open('burst', template(), compatible());
    for (let index = 0; index < 140; index += 1) {
      const descriptor = open(reopened, `base/file-${index}`, FLAG_READ);
      expect(read(reopened, descriptor, 1)).toEqual(Uint8Array.of(index));
      requestOk(reopened, OP.close, '', new Uint8Array(), descriptor);
    }
    const largeReopened = open(reopened, 'base/large-spill', FLAG_READ);
    expect(read(reopened, largeReopened, 512)).toEqual(
      new Uint8Array(256).fill(6, 0, 128),
    );
    requestOk(reopened, OP.close, '', new Uint8Array(), largeReopened);
    await reopened.close(false);
  });

  it('uses the same durable format for direct and portable fallback paths', async () => {
    const root = installOpfs();
    const pool = await DirectOpfsPool.open('portable', template(), compatible());
    const descriptor = open(pool, 'base/direct', FLAG_WRITE | FLAG_CREATE);
    write(pool, descriptor, Uint8Array.of(1, 2, 3));
    requestOk(pool, OP.close, '', new Uint8Array(), descriptor);
    await pool.close(true);

    const database = await databaseDirectory(root, 'portable');
    const snapshot = await readPooledOpfsDatabase(database.asHandle(), 'portable', compatible());
    expect(snapshot?.files.find(({ path }) => path === 'base/direct')?.bytes).toEqual(
      Uint8Array.of(1, 2, 3),
    );
    await applyPooledOpfsDelta(database.asHandle(), 'portable', compatible(), {
      directories: [],
      files: [{ path: 'base/direct', bytes: Uint8Array.of(4, 5) }],
      deleted: [],
    });

    const reopened = await DirectOpfsPool.open('portable', template(), compatible());
    const readDescriptor = open(reopened, 'base/direct', FLAG_READ);
    expect(read(reopened, readDescriptor, 8)).toEqual(Uint8Array.of(4, 5));
    requestOk(reopened, OP.close, '', new Uint8Array(), readDescriptor);
    await reopened.close(false);
  });

  it('keeps first-open setup pending when direct handles are unavailable', async () => {
    const io: FakeIo = { syncAccessErrorName: 'NotSupportedError' };
    installOpfs(io);

    const fallback = await acquireOpfsStorage('first-fallback', template(), compatible());
    expect(fallback.state).toBe('new');
    expect(fallback.createDirectory).toBeUndefined();
    await fallback.close(undefined, 'failed');

    io.syncAccessErrorName = undefined;
    const direct = await DirectOpfsPool.open('first-fallback', template(), compatible());
    expect(direct.state).toBe('new');
    await direct.completeInitialization();
    await direct.close(true);

    const reopened = await DirectOpfsPool.open('first-fallback', template(), compatible());
    expect(reopened.state).toBe('existing');
    await reopened.close(false);
  });

  it('releases the direct host filesystem exactly once when its lease closes', async () => {
    installOpfs();
    const free = vi.fn();
    const createSync = vi.fn(() =>
      directDirectory({ readTextFile: async () => '18\n', free }),
    );
    const lease = await acquireOpfsStorage('direct-lifecycle', template(), compatible());
    if (lease.createDirectory === undefined) throw new Error('expected direct OPFS storage');

    const directory = await lease.createDirectory({ createSync } as unknown as typeof Directory);
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
      template(),
      compatible(),
    );
    if (lease.createDirectory === undefined) throw new Error('expected direct OPFS storage');

    await expect(
      lease.createDirectory({
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

  it('does not publish setup completion when its marker commit fails', async () => {
    const io: FakeIo = {};
    installOpfs(io);
    const pool = await DirectOpfsPool.open('initialization-marker', template(), compatible());
    io.failNextStateCommit = true;
    await expect(pool.completeInitialization()).rejects.toThrow('injected state commit failure');
    await pool.close(false);

    const reopened = await DirectOpfsPool.open(
      'initialization-marker',
      template(),
      compatible(),
    );
    expect(reopened.state).toBe('new');
    await reopened.close(false);
  });

  it('normalizes direct browser failures and classifies missing backings as corrupt', async () => {
    const io: FakeIo = { syncAccessErrorName: 'QuotaExceededError' };
    const root = installOpfs(io);
    await expect(
      acquireOpfsStorage('quota', template(), compatible()),
    ).rejects.toMatchObject({
      name: 'WasixStorageError',
      code: 'unavailable',
      durability: 'unchanged',
    });

    io.syncAccessErrorName = undefined;
    const pool = await DirectOpfsPool.open('missing-backing', template(), compatible());
    await pool.completeInitialization();
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
      acquireOpfsStorage('missing-backing', template(), compatible()),
    ).rejects.toMatchObject({
      name: 'WasixStorageError',
      code: 'corrupt',
      durability: 'unchanged',
    });
    await expect(
      readPooledOpfsDatabase(database.asHandle(), 'missing-backing', compatible()),
    ).rejects.toMatchObject({
      name: 'WasixStorageError',
      code: 'corrupt',
      durability: 'unchanged',
    });
  });

  it('scrubs transient PostgreSQL process files before portable hydration', async () => {
    const root = installOpfs();
    const pool = await DirectOpfsPool.open('volatile', template(), compatible());
    await pool.close(true);
    const database = await databaseDirectory(root, 'volatile');
    await applyPooledOpfsDelta(database.asHandle(), 'volatile', compatible(), {
      directories: [],
      files: [{ path: 'postmaster.pid', bytes: encoder.encode('stale') }],
      deleted: [],
    });

    const snapshot = await readPooledOpfsDatabase(
      database.asHandle(),
      'volatile',
      compatible(),
    );
    expect(snapshot?.files.some(({ path }) => path === 'postmaster.pid')).toBe(false);
    const reopened = await readPooledOpfsDatabase(
      database.asHandle(),
      'volatile',
      compatible(),
    );
    expect(reopened?.files.some(({ path }) => path === 'postmaster.pid')).toBe(false);
  });

  it('fails closed for incompatible or structurally invalid state', async () => {
    const root = installOpfs();
    const pool = await DirectOpfsPool.open('guarded', template(), compatible());
    await pool.close(true);
    const database = await databaseDirectory(root, 'guarded');
    await expect(
      readPooledOpfsDatabase(database.asHandle(), 'guarded', {
        ...compatible(),
        runtime: { ...compatible().runtime, moduleSha256: '9'.repeat(64) },
      }),
    ).rejects.toMatchObject({ code: 'incompatible', durability: 'unchanged' });

    await database.file('state.json').replaceText(
      JSON.stringify({
        schema: 'oliphaunt-wasix-opfs-pool-v2',
        name: 'guarded',
        phase: 'ready',
        compatibility: compatible(),
        entries: [{ path: '../escape', type: 'directory' }],
      }),
    );
    await expect(
      readPooledOpfsDatabase(database.asHandle(), 'guarded', compatible()),
    ).rejects.toMatchObject({ code: 'corrupt', durability: 'unchanged' });
  });

  it('does not publish a namespace generation when its state commit fails', async () => {
    const io: FakeIo = {};
    const root = installOpfs(io);
    const pool = await DirectOpfsPool.open('atomic', template(), compatible());
    const descriptor = open(pool, 'base/uncommitted', FLAG_WRITE | FLAG_CREATE);
    write(pool, descriptor, Uint8Array.of(7));
    requestOk(pool, OP.close, '', new Uint8Array(), descriptor);
    io.failNextStateCommit = true;
    await expect(pool.sync('checkpoint')).rejects.toThrow('injected state commit failure');
    await pool.close(false);

    const reopened = await DirectOpfsPool.open('atomic', template(), compatible());
    expect(reopened.request(OP.metadata, 'base/uncommitted', new Uint8Array(), 0, 0, 0)[0]).toBe(1);
    await reopened.close(false);
    expect((await databaseDirectory(root, 'atomic')).file('state.json')).toBeDefined();
  });

  it('keeps the preceding portable generation when publication fails', async () => {
    const io: FakeIo = {};
    const root = installOpfs(io);
    const pool = await DirectOpfsPool.open('portable-atomic', template(), compatible());
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
    const snapshot = await readPooledOpfsDatabase(
      database.asHandle(),
      'portable-atomic',
      compatible(),
    );
    expect(snapshot?.files.find(({ path }) => path === 'base/value')?.bytes).toEqual(
      Uint8Array.of(1),
    );
  });

  it('rejects a template without essential PostgreSQL control files', async () => {
    installOpfs();
    await expect(
      DirectOpfsPool.open(
        'invalid-template',
        { directories: ['base', 'global'], files: { PG_VERSION: encoder.encode('18\n') } },
        compatible(),
      ),
    ).rejects.toMatchObject({ code: 'corrupt', durability: 'unchanged' });
  });

  it('fails closed instead of shadowing a retired raw-layout database', async () => {
    const root = installOpfs();
    const legacy = await root.getDirectoryHandle('.oliphaunt-wasix-v2', { create: true });
    const database = await legacy.getDirectoryHandle('legacy', { create: true });
    await database.getFileHandle('PG_VERSION', { create: true });

    await expect(
      DirectOpfsPool.open('legacy', template(), compatible()),
    ).rejects.toMatchObject({ code: 'incompatible', durability: 'unchanged' });
    await expect(root.getDirectoryHandle(OPFS_POOL_ROOT)).rejects.toMatchObject({
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

function write(
  pool: DirectOpfsPool,
  descriptor: number,
  bytes: Uint8Array,
  offset = 0,
): void {
  const result = requestOk(pool, OP.write, '', bytes, descriptor, offset);
  expect(result[2]).toBe(bytes.byteLength);
}

function read(pool: DirectOpfsPool, descriptor: number, capacity: number): Uint8Array {
  const output = new Uint8Array(capacity);
  const result = requestOk(pool, OP.read, '', output, descriptor, 0);
  return output.slice(0, result[1]);
}

function template(): WasixDirectoryMount {
  return {
    directories: ['base', 'global', 'pg_wal'],
    files: {
      PG_VERSION: encoder.encode('18\n'),
      'global/pg_control': Uint8Array.of(1, 2, 3),
    },
  };
}

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
    extensions: [],
  };
}

function directDirectory(
  overrides: Pick<Directory, 'readTextFile' | 'free'>,
): Directory {
  return overrides as unknown as Directory;
}

type FakeIo = {
  failNextStateCommit?: boolean;
  syncAccessErrorName?: string;
};

function installOpfs(io: FakeIo = {}): FakeDirectory {
  const root = new FakeDirectory('', io);
  vi.stubGlobal('navigator', {
    locks: {
      request: async (
        _name: string,
        _options: unknown,
        callback: (lock: object) => Promise<unknown>,
      ) => callback({}),
    },
    storage: { getDirectory: async () => root.asHandle() },
  });
  return root;
}

async function databaseDirectory(root: FakeDirectory, name: string): Promise<FakeDirectory> {
  return (await (await root.getDirectoryHandle(OPFS_POOL_ROOT)).getDirectoryHandle(name));
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
        this.#bytes = next;
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
      },
      flush: () => undefined,
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

function notFound(): DOMException {
  return new DOMException('missing', 'NotFoundError');
}
