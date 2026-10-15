import { afterEach, describe, expect, it, vi } from 'bun:test';
import type { Directory } from '../host/index.mjs';
import { DirectOpfsPool, inspectPooledOpfsDatabase } from '../storage/opfs-pool.js';
import { acquireOpfsStorage, restoreOpfsStorage } from '../storage/opfs-provider.js';
import { restoreGlobals, stubGlobal } from './test-globals.js';
import {
  installOpfs,
  clusterSeed,
  compatible,
  databaseDirectory,
  collectKeys,
  type FakeIo,
} from './opfs-test-helpers.js';
const OP = {
  metadata: 1,
  createDirectory: 3,
  removeDirectory: 4,
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
afterEach(() => restoreGlobals());
function worker(io: FakeIo = {}) {
  const root = installOpfs(io);
  stubGlobal('document', undefined);
  return root;
}
describe('direct OPFS storage', () => {
  it('persists the opaque logical namespace across direct reopen', async () => {
    const root = worker();
    const pool = await DirectOpfsPool.open('todos', clusterSeed(), compatible());
    expect(pool.state).toBe('new');

    requestOk(pool, OP.createDirectory, 'base/1');
    const descriptor = open(pool, 'base/1/value', FLAG_WRITE | FLAG_CREATE);
    write(pool, descriptor, encoder.encode('persisted'));
    requestOk(pool, OP.close, '', new Uint8Array(), descriptor);
    await pool.sync('full');
    pool.close();

    const database = await databaseDirectory(root, 'todos');
    expect((await collectKeys(database)).filter((key) => !key.startsWith('j-'))).toEqual([
      'data',
      'state.json',
    ]);

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
    reopened.close();
  });

  it('keeps an unlinked descriptor alive without resurrecting its path', async () => {
    worker();
    const pool = await DirectOpfsPool.open('unlink', clusterSeed(), compatible());
    const descriptor = open(pool, 'base/transient', FLAG_READ | FLAG_WRITE | FLAG_CREATE);
    write(pool, descriptor, encoder.encode('still open'));
    requestOk(pool, OP.unlink, '', new Uint8Array(), descriptor);
    expect(pool.request(OP.metadata, 'base/transient', new Uint8Array(), 0, 0, 0)[0]).toBe(1);
    expect(decoder.decode(read(pool, descriptor, 32))).toBe('still open');
    requestOk(pool, OP.close, '', new Uint8Array(), descriptor);
    await pool.sync('operation');
    pool.close();

    const reopened = await DirectOpfsPool.open('unlink', clusterSeed(), compatible());
    expect(reopened.request(OP.metadata, 'base/transient', new Uint8Array(), 0, 0, 0)[0]).toBe(1);
    reopened.close();
  });

  it('keeps an open descriptor attached to its file across rename replacement', async () => {
    worker();
    const pool = await DirectOpfsPool.open('rename-open', clusterSeed(), compatible());
    const descriptor = open(pool, 'base/source', FLAG_READ | FLAG_WRITE | FLAG_CREATE);
    write(pool, descriptor, encoder.encode('before'));
    const replaced = open(pool, 'base/destination', FLAG_WRITE | FLAG_CREATE);
    write(pool, replaced, encoder.encode('replaced'));
    requestOk(pool, OP.close, '', new Uint8Array(), replaced);

    requestOk(pool, OP.rename, 'base/source', encoder.encode('base/destination'));
    write(pool, descriptor, encoder.encode('-after'), 'before'.length);
    requestOk(pool, OP.close, '', new Uint8Array(), descriptor);
    await pool.sync('full');
    pool.close();

    const reopened = await DirectOpfsPool.open('rename-open', clusterSeed(), compatible());
    expect(reopened.request(OP.metadata, 'base/source', new Uint8Array(), 0, 0, 0)[0]).toBe(1);
    const destination = open(reopened, 'base/destination', FLAG_READ);
    expect(decoder.decode(read(reopened, destination, 32))).toBe('before-after');
    requestOk(reopened, OP.close, '', new Uint8Array(), destination);
    reopened.close();
  });

  it('stages a creation burst beyond the preopened fast path and publishes it durably', async () => {
    worker();
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
    await pool.sync('full');
    pool.close();

    const reopened = await DirectOpfsPool.open('burst', clusterSeed(), compatible());
    for (let index = 0; index < 140; index += 1) {
      const descriptor = open(reopened, `base/file-${index}`, FLAG_READ);
      expect(read(reopened, descriptor, 1)).toEqual(Uint8Array.of(index));
      requestOk(reopened, OP.close, '', new Uint8Array(), descriptor);
    }
    const largeReopened = open(reopened, 'base/large-staged', FLAG_READ);
    expect(read(reopened, largeReopened, 512)).toEqual(new Uint8Array(256).fill(6, 0, 128));
    requestOk(reopened, OP.close, '', new Uint8Array(), largeReopened);
    reopened.close();
  });

  it('releases the direct host filesystem exactly once when its lease closes', async () => {
    worker();
    const free = vi.fn();
    const createSync = vi.fn(() => directDirectory({ readTextFile: async () => '18\n', free }));
    const lease = await acquireOpfsStorage('direct-lifecycle', clusterSeed(), compatible());
    if (lease.createPgdataDirectory === undefined) throw new Error('expected direct OPFS storage');

    const directory = await lease.createPgdataDirectory({
      createSync,
    } as unknown as typeof Directory);
    await lease.close(directory, 'failed');
    await lease.close(directory, 'failed');

    expect(createSync).toHaveBeenCalledTimes(1);
    expect(free).toHaveBeenCalledTimes(1);
  });

  it('releases a direct host filesystem when bridge validation fails', async () => {
    worker();
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

    expect(free).toHaveBeenCalledTimes(1);
  });

  it('reports persisted when access-handle cleanup fails after a clean close sync', async () => {
    const io: FakeIo = {};
    worker(io);
    const free = vi.fn();
    const lease = await acquireOpfsStorage('close-cleanup', clusterSeed(), compatible());
    if (lease.createPgdataDirectory === undefined) throw new Error('expected direct OPFS storage');
    const directory = await lease.createPgdataDirectory({
      createSync: () => directDirectory({ readTextFile: async () => '18\n', free }),
    } as unknown as typeof Directory);
    await lease.sync(directory, 'full');

    io.failNextAccessClose = true;
    await expect(lease.close(directory, 'clean')).rejects.toMatchObject({
      code: 'unavailable',
      commitState: 'persisted',
    });
    expect(free).toHaveBeenCalledTimes(1);
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

function directDirectory(overrides: Pick<Directory, 'readTextFile' | 'free'>): Directory {
  return overrides as unknown as Directory;
}

it.each([
  1, 40,
])('recovers names and contents of %s WAL files before a control update', async (count) => {
  worker();
  const pool = await DirectOpfsPool.open('wal-recovery', clusterSeed(), compatible());
  await pool.sync('full');
  for (let index = 0; index < count; index++) {
    const fd = open(pool, `pg_wal/new-${index}`, FLAG_READ | FLAG_WRITE | FLAG_CREATE);
    write(pool, fd, Uint8Array.of(index, 42));
    requestOk(pool, OP.flush, '', new Uint8Array(), fd);
  }
  const control = open(pool, 'global/pg_control', FLAG_WRITE);
  write(pool, control, Uint8Array.of(9, 9, 9));
  requestOk(pool, OP.flush, '', new Uint8Array(), control);
  pool.close();
  const reopened = await DirectOpfsPool.open('wal-recovery', clusterSeed(), compatible());
  expect([...read(reopened, open(reopened, 'global/pg_control', FLAG_READ), 3)]).toEqual([9, 9, 9]);
  for (let index = 0; index < count; index++) {
    expect([...read(reopened, open(reopened, `pg_wal/new-${index}`, FLAG_READ), 2)]).toEqual([
      index,
      42,
    ]);
  }
  reopened.close();
});

it('recovers repeated overflow writes and truncation before dependent mutations', async () => {
  worker();
  const pool = await DirectOpfsPool.open('overflow-rewrite', clusterSeed(), compatible(), 2, 0);
  await pool.sync('full');
  const wal = open(pool, 'pg_wal/new', FLAG_READ | FLAG_WRITE | FLAG_CREATE);
  write(pool, wal, Uint8Array.of(1, 2, 3));
  requestOk(pool, OP.flush, '', new Uint8Array(), wal);
  write(pool, wal, Uint8Array.of(8), 0);
  requestOk(pool, OP.truncate, '', new Uint8Array(), wal, 2);
  // No second explicit WAL flush: the publication guard must also protect
  // staged bytes before permitting an existing backing to change.
  write(pool, open(pool, 'global/pg_control', FLAG_WRITE), Uint8Array.of(9));
  pool.close();
  const reopened = await DirectOpfsPool.open('overflow-rewrite', clusterSeed(), compatible());
  expect([...read(reopened, open(reopened, 'pg_wal/new', FLAG_READ), 3)]).toEqual([8, 2]);
  reopened.close();
});

it('stops mutations when overflow journal persistence fails', async () => {
  const io: FakeIo = {};
  worker(io);
  const pool = await DirectOpfsPool.open('journal-failure', clusterSeed(), compatible(), 2, 0);
  await pool.sync('full');
  write(pool, open(pool, 'pg_wal/new', FLAG_WRITE | FLAG_CREATE), Uint8Array.of(8));
  const control = open(pool, 'global/pg_control', FLAG_WRITE);
  io.failNextJournalWrite = true;
  expect(pool.request(OP.write, '', Uint8Array.of(9), control, 0, 0)[0]).not.toBe(0);
  expect(pool.request(OP.write, '', Uint8Array.of(9), control, 0, 0)[0]).not.toBe(0);
  await expect(pool.sync('operation')).rejects.toThrow('injected journal write failure');
  pool.close();
  const reopened = await DirectOpfsPool.open('journal-failure', clusterSeed(), compatible());
  expect([...read(reopened, open(reopened, 'global/pg_control', FLAG_READ), 3)]).toEqual([1, 2, 3]);
  reopened.close();
});

it('replays the same journal before portable handoff and restore inspection', async () => {
  const origin = worker();
  const pool = await DirectOpfsPool.open('handoff', clusterSeed(), compatible(), 2, 0);
  await pool.sync('full');
  const file = open(pool, 'base/value', FLAG_WRITE | FLAG_CREATE);
  write(pool, file, Uint8Array.of(7));
  requestOk(pool, OP.flush, '', new Uint8Array(), file);
  pool.close();
  stubGlobal('document', {});
  const lease = await acquireOpfsStorage('handoff', clusterSeed(), compatible());
  expect(lease.mount?.files['base/value']).toEqual(Uint8Array.of(7));
  await lease.close(undefined, 'failed');
  const database = await databaseDirectory(origin, 'handoff');
  expect(
    (await inspectPooledOpfsDatabase(database.asHandle(), 'handoff', compatible())).state,
  ).toBe('existing');
  await expect(
    restoreOpfsStorage(
      'handoff',
      { schema: 'oliphaunt-wasix-directory-snapshot-v1', directories: [], files: [] },
      compatible(),
    ),
  ).rejects.toMatchObject({ commitState: 'unchanged' });
});

it('does range I/O without hydrating or copying unchanged table files', async () => {
  const io: FakeIo = {
    synchronousWrites: [],
    readBacking: async () => {
      throw new Error('full-file hydration');
    },
  };
  worker(io);
  const pool = await DirectOpfsPool.open('range-io', clusterSeed(), compatible());
  await pool.sync('full');
  const file = open(pool, 'base/large', FLAG_READ | FLAG_WRITE | FLAG_CREATE);
  requestOk(pool, OP.truncate, '', new Uint8Array(), file, 8 * 1024 * 1024);
  await pool.sync('operation');
  io.synchronousWrites = [];
  write(pool, file, Uint8Array.of(7), 1024);
  await pool.sync('operation');
  expect(
    io.synchronousWrites
      .filter((write) => write.path.includes('/data/'))
      .map((write) => write.bytes),
  ).toEqual([1]);
  pool.close();
  const reopened = await DirectOpfsPool.open('range-io', clusterSeed(), compatible());
  reopened.close();
});

it('skips journal and state publication for temporary create/delete cycles', async () => {
  const io: FakeIo = { writes: [], synchronousWrites: [] };
  worker(io);
  const pool = await DirectOpfsPool.open('temporary', clusterSeed(), compatible());
  await pool.sync('full');
  io.writes = [];
  io.synchronousWrites = [];
  const fd = open(pool, 'base/temp', FLAG_WRITE | FLAG_CREATE);
  write(pool, fd, Uint8Array.of(1));
  requestOk(pool, OP.unlink, '', new Uint8Array(), fd);
  requestOk(pool, OP.close, '', new Uint8Array(), fd);
  await pool.sync('operation');
  expect(io.writes.filter((path) => path.endsWith('/state.json'))).toEqual([]);
  expect(io.synchronousWrites.filter((write) => write.path.includes('/j-'))).toEqual([]);
  pool.close();
});

it('recovers rename replacement and open-unlinked writes without reviving the replaced file', async () => {
  worker();
  const pool = await DirectOpfsPool.open('rename-crash', clusterSeed(), compatible());
  const source = open(pool, 'base/source', FLAG_READ | FLAG_WRITE | FLAG_CREATE);
  write(pool, source, Uint8Array.of(1));
  const replaced = open(pool, 'base/target', FLAG_READ | FLAG_WRITE | FLAG_CREATE);
  write(pool, replaced, Uint8Array.of(2));
  await pool.sync('full');
  requestOk(pool, OP.rename, 'base/source', encoder.encode('base/target'));
  // An open descriptor still owns the replaced backing, but its bytes must not
  // become visible through either name after recovery.
  write(pool, replaced, Uint8Array.of(8));
  write(pool, source, Uint8Array.of(9));
  requestOk(pool, OP.flush, '', new Uint8Array(), source);
  pool.close();
  const reopened = await DirectOpfsPool.open('rename-crash', clusterSeed(), compatible());
  expect(reopened.request(OP.metadata, 'base/source', new Uint8Array(), 0, 0, 0)[0]).toBe(1);
  expect([...read(reopened, open(reopened, 'base/target', FLAG_READ), 1)]).toEqual([9]);
  reopened.close();
});

it('flushes direct WAL before publishing ordinary overflow images', async () => {
  const io: FakeIo = { flushes: [] };
  const root = worker(io);
  const pool = await DirectOpfsPool.open('wal-before-images', clusterSeed(), compatible(), 2, 1);
  await pool.sync('full');
  const wal = open(pool, 'pg_wal/new', FLAG_WRITE | FLAG_CREATE);
  write(pool, wal, Uint8Array.of(7));
  const relation = open(pool, 'base/new', FLAG_WRITE | FLAG_CREATE);
  write(pool, relation, Uint8Array.of(8));
  io.flushes = [];
  write(pool, open(pool, 'global/pg_control', FLAG_WRITE), Uint8Array.of(9));
  expect(io.flushes?.[0]).toContain('/data/');
  expect(io.flushes?.slice(1).every((path) => path.includes('/j-'))).toBe(true);
  pool.close();
  const recovered = await inspectPooledOpfsDatabase(
    (await databaseDirectory(root, 'wal-before-images')).asHandle(),
    'wal-before-images',
    compatible(),
  );
  expect(recovered.snapshot?.files.find((file) => file.path === 'base/new')?.bytes).toEqual(
    Uint8Array.of(8),
  );
  expect(recovered.snapshot?.files.find((file) => file.path === 'pg_wal/new')?.bytes).toEqual(
    Uint8Array.of(7),
  );
});

it.each([
  'write',
  'truncate',
] as const)('flushes a WAL %s after a preceding namespace barrier', async (operation) => {
  const io: FakeIo = { flushes: [] };
  worker(io);
  const pool = await DirectOpfsPool.open('wal-after-barrier', clusterSeed(), compatible());
  const wal = open(pool, 'pg_wal/current', FLAG_WRITE | FLAG_CREATE);
  write(pool, wal, Uint8Array.of(1, 2));
  await pool.sync('full');

  write(pool, wal, Uint8Array.of(3));
  requestOk(pool, OP.createDirectory, 'base/pending');
  // The barrier flushes the previous WAL bytes. The following mutation must
  // remain dirty so its own guest flush also reaches the access handle.
  if (operation === 'write') write(pool, wal, Uint8Array.of(4));
  else requestOk(pool, OP.truncate, '', new Uint8Array(), wal, 1);
  io.flushes = [];
  requestOk(pool, OP.flush, '', new Uint8Array(), wal);
  expect(io.flushes).toHaveLength(1);
  expect(io.flushes?.[0]).toContain('/data/');
  pool.close();
});

it('retains journal recovery after checkpoint publication fails', async () => {
  const io: FakeIo = {};
  worker(io);
  const pool = await DirectOpfsPool.open('checkpoint-failure', clusterSeed(), compatible(), 2, 0);
  await pool.sync('full');
  const wal = open(pool, 'pg_wal/new', FLAG_READ | FLAG_WRITE | FLAG_CREATE);
  write(pool, wal, Uint8Array.of(7));
  requestOk(pool, OP.flush, '', new Uint8Array(), wal);
  io.failNextStateCommit = true;
  await expect(pool.sync('operation')).rejects.toThrow('injected state commit failure');
  pool.close();
  const reopened = await DirectOpfsPool.open('checkpoint-failure', clusterSeed(), compatible());
  expect([...read(reopened, open(reopened, 'pg_wal/new', FLAG_READ), 1)]).toEqual([7]);
  reopened.close();
});

it('selects fallback when synchronous handles are unavailable', async () => {
  installOpfs({ syncAccessErrorName: 'NotSupportedError' });
  stubGlobal('document', undefined);
  const fallback = await acquireOpfsStorage('unsupported', clusterSeed(), compatible());
  expect(fallback.createPgdataDirectory).toBeUndefined();
  expect(fallback.mount).toBeDefined();
  await fallback.close(undefined, 'failed');
});

it.each([
  'operation',
  'full',
  'close',
] as const)('skips full publication of explicitly flushed temporary files at %s', async (boundary) => {
  const io: FakeIo = { writes: [] };
  worker(io);
  const pool = await DirectOpfsPool.open('temporary-flushed', clusterSeed(), compatible());
  await pool.sync('full');
  io.writes = [];
  const fd = open(pool, 'base/temp', FLAG_WRITE | FLAG_CREATE);
  write(pool, fd, Uint8Array.of(1));
  requestOk(pool, OP.flush, '', new Uint8Array(), fd);
  requestOk(pool, OP.unlink, '', new Uint8Array(), fd);
  requestOk(pool, OP.close, '', new Uint8Array(), fd);
  await pool.sync(boundary);
  expect(io.writes.filter((path) => path.endsWith('/state.json'))).toEqual([]);
  pool.close();
  const reopened = await DirectOpfsPool.open('temporary-flushed', clusterSeed(), compatible());
  expect(reopened.request(OP.metadata, 'base/temp', new Uint8Array(), 0, 0, 0)[0]).toBe(1);
  reopened.close();
});

it('journals overflow ranges without copying a preallocated WAL file on every barrier', async () => {
  const io: FakeIo = { synchronousWrites: [] };
  worker(io);
  const pool = await DirectOpfsPool.open('overflow-ranges', clusterSeed(), compatible(), 2, 0);
  await pool.sync('full');
  const wal = open(pool, 'pg_wal/new', FLAG_READ | FLAG_WRITE | FLAG_CREATE);
  requestOk(pool, OP.truncate, '', new Uint8Array(), wal, 16 * 1024 * 1024);
  const control = open(pool, 'global/pg_control', FLAG_WRITE);
  io.synchronousWrites = [];
  for (let index = 0; index < 10; index++) {
    write(pool, wal, Uint8Array.of(index + 1), index);
    write(pool, control, Uint8Array.of(index));
  }
  const journalBytes = io.synchronousWrites
    .filter((write) => write.path.includes('/j-'))
    .reduce((sum, write) => sum + write.bytes, 0);
  expect(journalBytes).toBeLessThan(16 * 1024);
  pool.close();
  const reopened = await DirectOpfsPool.open('overflow-ranges', clusterSeed(), compatible());
  expect([...read(reopened, open(reopened, 'pg_wal/new', FLAG_READ), 11)]).toEqual([
    1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 0,
  ]);
  reopened.close();
});

it('returns unused handles to the configured reserve after deleting files', async () => {
  const root = worker();
  const pool = await DirectOpfsPool.open('trim-reserve', clusterSeed(), compatible(), 2, 2);
  for (let index = 0; index < 8; index++) {
    const fd = open(pool, `base/value-${index}`, FLAG_WRITE | FLAG_CREATE);
    write(pool, fd, Uint8Array.of(index));
    requestOk(pool, OP.close, '', new Uint8Array(), fd);
  }
  await pool.sync('full');
  for (let index = 0; index < 8; index++) {
    const fd = open(pool, `base/value-${index}`, FLAG_WRITE);
    requestOk(pool, OP.unlink, '', new Uint8Array(), fd);
    requestOk(pool, OP.close, '', new Uint8Array(), fd);
  }
  await pool.sync('operation');
  const database = await databaseDirectory(root, 'trim-reserve');
  // Two seed files plus the two requested unused backings.
  expect(await collectKeys(await database.getDirectoryHandle('data'))).toHaveLength(4);
  pool.close();
});

it('keeps verified journal recovery retryable after a backing write failure', async () => {
  const io: FakeIo = {};
  worker(io);
  const pool = await DirectOpfsPool.open(
    'recovery-write-failure',
    clusterSeed(),
    compatible(),
    2,
    0,
  );
  await pool.sync('full');
  const fd = open(pool, 'base/value', FLAG_WRITE | FLAG_CREATE);
  write(pool, fd, Uint8Array.of(7));
  requestOk(pool, OP.flush, '', new Uint8Array(), fd);
  pool.close();
  io.failNextDataCommit = true;
  await expect(
    DirectOpfsPool.open('recovery-write-failure', clusterSeed(), compatible()),
  ).rejects.toMatchObject({ code: 'publication-failed', commitState: 'unknown' });
  const reopened = await DirectOpfsPool.open('recovery-write-failure', clusterSeed(), compatible());
  expect([...read(reopened, open(reopened, 'base/value', FLAG_READ), 1)]).toEqual([7]);
  reopened.close();
});
