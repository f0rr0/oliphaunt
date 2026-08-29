import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fsContract = vi.hoisted(() => ({
  events: [] as string[],
  fstatCalls: 0,
  descriptorPaths: new Map<number, string>(),
  swapOnOpen: undefined as
    | Readonly<{ target: string; parent: string; displaced: string; outside: string }>
    | undefined,
  renameErrorCode: undefined as string | undefined,
  writeErrorCode: undefined as string | undefined,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const nativeOpen = actual.openSync as unknown as (
    path: import('node:fs').PathLike,
    flags: string | number,
    mode?: import('node:fs').Mode,
  ) => number;
  const nativeWrite = actual.writeSync as unknown as (
    fd: number,
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number | null,
  ) => number;
  return {
    ...actual,
    openSync(
      path: import('node:fs').PathLike,
      flags: string | number,
      mode?: import('node:fs').Mode,
    ) {
      const swap = fsContract.swapOnOpen;
      if (swap !== undefined && String(path) === swap.target) {
        fsContract.swapOnOpen = undefined;
        actual.renameSync(swap.parent, swap.displaced);
        actual.symlinkSync(swap.outside, swap.parent, 'dir');
      }
      const descriptor = nativeOpen(path, flags, mode);
      fsContract.descriptorPaths.set(descriptor, String(path));
      return descriptor;
    },
    fsyncSync(descriptor: number) {
      fsContract.events.push(`file:${fsContract.descriptorPaths.get(descriptor) ?? descriptor}`);
      return actual.fsyncSync(descriptor);
    },
    fstatSync(descriptor: number, options?: Parameters<typeof actual.fstatSync>[1]) {
      fsContract.fstatCalls += 1;
      return actual.fstatSync(descriptor, options as never);
    },
    renameSync(from: import('node:fs').PathLike, to: import('node:fs').PathLike) {
      const code = fsContract.renameErrorCode;
      if (code !== undefined) {
        fsContract.renameErrorCode = undefined;
        throw Object.assign(new Error(`injected ${code}`), { code });
      }
      return actual.renameSync(from, to);
    },
    writeSync(
      descriptor: number,
      buffer: Uint8Array,
      offset: number,
      length: number,
      position: number | null,
    ) {
      const code = fsContract.writeErrorCode;
      if (code !== undefined) {
        fsContract.writeErrorCode = undefined;
        throw Object.assign(new Error(`injected ${code}`), { code });
      }
      return nativeWrite(descriptor, buffer, offset, length, position);
    },
  };
});

vi.mock('../node-fs-commit-state.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../node-fs-commit-state.js')>();
  return {
    ...actual,
    async syncNodeDirectory(path: string) {
      fsContract.events.push(`directory:${path}`);
      await actual.syncNodeDirectory(path);
    },
  };
});

import { NodeSyncDirectoryPool } from '../storage/node-sync-directory-pool.js';

const OP = {
  metadata: 1,
  createDirectory: 3,
  rename: 5,
  open: 7,
  close: 8,
  write: 10,
  flush: 11,
  unlink: 13,
  fileSize: 14,
} as const;
const RESULT_IO = 11;
const RESULT_STORAGE_FULL = 8;
const FLAG_READ = 1 << 0;
const FLAG_WRITE = 1 << 1;
const FLAG_CREATE_NEW = 1 << 2;
const FLAG_APPEND = 1 << 4;
const FLAG_TRUNCATE = 1 << 5;
const scratch: string[] = [];

beforeEach(() => {
  fsContract.events.length = 0;
  fsContract.fstatCalls = 0;
  fsContract.descriptorPaths.clear();
  fsContract.swapOnOpen = undefined;
  fsContract.renameErrorCode = undefined;
  fsContract.writeErrorCode = undefined;
});

afterEach(async () => {
  await Promise.all(scratch.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('Node synchronous directory bridge adversarial contracts', () => {
  it('fsyncs dirty detached inodes after descriptor unlink and replacement', async () => {
    const root = await databaseRoot('detached-inode-flush');
    const pool = new NodeSyncDirectoryPool(root);
    const unlinked = openWritable(pool, 'unlinked');
    write(pool, unlinked, 'unlinked-value');
    requestOk(pool, OP.unlink, '', new Uint8Array(), unlinked);
    fsContract.events.length = 0;
    requestOk(pool, OP.flush, '', new Uint8Array(), unlinked);
    expect(fileEvents(root)).toEqual(['unlinked']);
    requestOk(pool, OP.close, '', new Uint8Array(), unlinked);

    const replaced = openWritable(pool, 'replaced');
    write(pool, replaced, 'old-value');
    const source = openWritable(pool, 'source');
    write(pool, source, 'new-value');
    requestOk(pool, OP.rename, 'source', new TextEncoder().encode('replaced'));
    fsContract.events.length = 0;
    requestOk(pool, OP.flush, '', new Uint8Array(), replaced);
    expect(fileEvents(root)).toEqual(['replaced']);
    requestOk(pool, OP.close, '', new Uint8Array(), replaced);
    requestOk(pool, OP.close, '', new Uint8Array(), source);
    pool.close();
  });

  it('defers truncation until an opened path survives confinement revalidation', async () => {
    const root = await databaseRoot('open-swap');
    await mkdir(join(root, 'data'));
    await writeFile(join(root, 'data/victim'), 'inside');
    const outside = join(root, '..', 'open-swap-outside');
    await mkdir(outside);
    await writeFile(join(outside, 'victim'), 'outside-must-survive');
    const displaced = join(root, 'data-original');
    const pool = new NodeSyncDirectoryPool(root);
    fsContract.swapOnOpen = {
      target: join(root, 'data/victim'),
      parent: join(root, 'data'),
      displaced,
      outside,
    };

    expect(
      pool.request(OP.open, 'data/victim', new Uint8Array(), 0, 0, FLAG_WRITE | FLAG_TRUNCATE)[0],
    ).toBe(RESULT_IO);
    expect(await readFile(join(outside, 'victim'), 'utf8')).toBe('outside-must-survive');
    expect(pool.request(OP.metadata, 'PG_VERSION', new Uint8Array(), 0, 0, 0)[0]).toBe(RESULT_IO);

    await rm(join(root, 'data'));
    await rename(displaced, join(root, 'data'));
    pool.close();
  });

  it('orders file and namespace fsyncs as WAL, data, then control', async () => {
    const root = await databaseRoot('publication-order');
    await mkdir(join(root, 'base/1'), { recursive: true });
    const pool = new NodeSyncDirectoryPool(root);
    const wal = openWritable(pool, 'pg_wal/000000010000000000000001');
    const data = openWritable(pool, 'base/1/2600');
    const controlOpen = requestOk(
      pool,
      OP.open,
      'global/pg_control',
      new Uint8Array(),
      0,
      0,
      FLAG_WRITE | FLAG_TRUNCATE,
    );
    expect(controlOpen[3]).toBe(0);
    const control = controlOpen[2];
    write(pool, wal, 'wal');
    write(pool, data, 'data');
    write(pool, control, 'control');
    for (const descriptor of [wal, data, control]) {
      requestOk(pool, OP.close, '', new Uint8Array(), descriptor);
    }

    fsContract.events.length = 0;
    await pool.sync();
    expect(normalizedEvents(root)).toEqual([
      'file:pg_wal/000000010000000000000001',
      'directory:pg_wal',
      'file:base/1/2600',
      'directory:base/1',
      'file:global/pg_control',
    ]);
    pool.close();
  });

  it('does not publish either side of a cross-class rename before the destination file', async () => {
    const root = await databaseRoot('rename-publication-order');
    const pool = new NodeSyncDirectoryPool(root);
    const control = openWritable(pool, 'next-control');
    write(pool, control, 'replacement-control');
    requestOk(pool, OP.close, '', new Uint8Array(), control);
    requestOk(pool, OP.rename, 'next-control', new TextEncoder().encode('global/pg_control'));

    fsContract.events.length = 0;
    await pool.sync();
    expect(normalizedEvents(root)).toEqual([
      'file:global/pg_control',
      'directory:global',
      'directory:',
    ]);
    expect(await readFile(join(root, 'global/pg_control'), 'utf8')).toBe('replacement-control');
    pool.close();
  });

  it('limits later sync work after clean-file churn, including a large file', async () => {
    const root = await databaseRoot('clean-file-churn');
    const pool = new NodeSyncDirectoryPool(root);
    requestOk(pool, OP.createDirectory, 'churn');

    const fileCount = 32;
    const largeFileSize = 2 * 1024 * 1024;
    for (let index = 0; index < fileCount; index += 1) {
      const descriptor = openWritable(pool, `churn/value-${index}`);
      const value =
        index === fileCount - 1
          ? new Uint8Array(largeFileSize).fill(0x61)
          : new TextEncoder().encode(`value-${index}`);
      requestOk(pool, OP.write, '', value, descriptor, 0);
      requestOk(pool, OP.close, '', new Uint8Array(), descriptor);
    }
    await pool.sync();
    expect(fileEvents(root)).toHaveLength(fileCount);
    expect((await stat(join(root, `churn/value-${fileCount - 1}`))).size).toBe(largeFileSize);

    // Clean open/close churn must not retain historical records either.
    for (let index = 0; index < fileCount; index += 1) {
      const descriptor = requestOk(
        pool,
        OP.open,
        `churn/value-${index}`,
        new Uint8Array(),
        0,
        0,
        FLAG_READ,
      )[2];
      requestOk(pool, OP.close, '', new Uint8Array(), descriptor);
    }
    fsContract.events.length = 0;
    await pool.sync();
    expect(fsContract.events).toEqual([]);

    const dirty = requestOk(pool, OP.open, 'churn/value-0', new Uint8Array(), 0, 0, FLAG_WRITE)[2];
    write(pool, dirty, 'next');
    requestOk(pool, OP.close, '', new Uint8Array(), dirty);

    fsContract.events.length = 0;
    await pool.sync();
    expect(fileEvents(root)).toEqual(['churn/value-0']);
    pool.close();
  });

  it('serves extent queries and append progress without hot-path fstat calls', async () => {
    const root = await databaseRoot('extent-without-fstat');
    const pool = new NodeSyncDirectoryPool(root);
    const descriptor = openWritable(pool, 'value');
    const afterOpen = fsContract.fstatCalls;
    write(pool, descriptor, 'value');
    for (let index = 0; index < 2_000; index += 1) {
      expect(requestOk(pool, OP.fileSize, '', new Uint8Array(), descriptor)[2]).toBe(5);
    }
    expect(fsContract.fstatCalls).toBe(afterOpen);

    const append = requestOk(
      pool,
      OP.open,
      'value',
      new Uint8Array(),
      0,
      0,
      FLAG_WRITE | FLAG_APPEND,
    )[2];
    const afterAppendOpen = fsContract.fstatCalls;
    const appendResult = requestOk(
      pool,
      OP.write,
      '',
      new TextEncoder().encode('-next'),
      append,
      0,
    );
    expect(appendResult[3]).toBe(10);
    expect(requestOk(pool, OP.fileSize, '', new Uint8Array(), descriptor)[2]).toBe(10);
    expect(fsContract.fstatCalls).toBe(afterAppendOpen);

    requestOk(pool, OP.close, '', new Uint8Array(), append);
    requestOk(pool, OP.close, '', new Uint8Array(), descriptor);
    pool.close();
  });

  it('fails closed when an externally resized dirty inode is reopened or published', async () => {
    const root = await databaseRoot('external-resize');
    const pool = new NodeSyncDirectoryPool(root);
    const descriptor = openWritable(pool, 'value');
    write(pool, descriptor, 'value');
    requestOk(pool, OP.close, '', new Uint8Array(), descriptor);

    await writeFile(join(root, 'value'), 'externally-resized');
    expect(pool.request(OP.open, 'value', new Uint8Array(), 0, 0, FLAG_READ)[0]).toBe(RESULT_IO);
    expect(pool.request(OP.metadata, 'PG_VERSION', new Uint8Array(), 0, 0, 0)[0]).toBe(RESULT_IO);
    pool.close();

    const syncRoot = await databaseRoot('external-resize-before-sync');
    const syncPool = new NodeSyncDirectoryPool(syncRoot);
    const syncDescriptor = openWritable(syncPool, 'value');
    write(syncPool, syncDescriptor, 'value');
    requestOk(syncPool, OP.close, '', new Uint8Array(), syncDescriptor);
    await writeFile(join(syncRoot, 'value'), 'externally-resized');
    await expect(syncPool.sync()).rejects.toThrow(/changed before flush/u);
    expect(syncPool.request(OP.metadata, 'PG_VERSION', new Uint8Array(), 0, 0, 0)[0]).toBe(
      RESULT_IO,
    );
    syncPool.close();
  });

  it('poisons after an injected mutating storage-full failure', async () => {
    const root = await databaseRoot('storage-full-poison');
    const pool = new NodeSyncDirectoryPool(root);
    const descriptor = openWritable(pool, 'value');
    fsContract.writeErrorCode = 'ENOSPC';
    expect(pool.request(OP.write, '', new TextEncoder().encode('value'), descriptor, 0, 0)[0]).toBe(
      RESULT_STORAGE_FULL,
    );
    expect(pool.request(OP.metadata, 'PG_VERSION', new Uint8Array(), 0, 0, 0)[0]).toBe(RESULT_IO);
    pool.close();
  });

  it('treats a mocked Windows rename sharing failure as recoverable', async () => {
    const root = await databaseRoot('windows-rename-retry');
    const pool = new NodeSyncDirectoryPool(root);
    const descriptor = openWritable(pool, 'before');
    requestOk(pool, OP.close, '', new Uint8Array(), descriptor);
    fsContract.renameErrorCode = 'EPERM';

    expect(pool.request(OP.rename, 'before', new TextEncoder().encode('after'), 0, 0, 0)[0]).toBe(
      6,
    );
    expect(requestOk(pool, OP.metadata, 'before')[2]).toBe(1);
    requestOk(pool, OP.rename, 'before', new TextEncoder().encode('after'));
    expect(requestOk(pool, OP.metadata, 'after')[2]).toBe(1);
    await pool.sync();
    pool.close();
  });
});

async function databaseRoot(suffix: string): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), 'oliphaunt-node-sync-adversarial-'));
  scratch.push(parent);
  const root = join(parent, suffix);
  await mkdir(join(root, 'global'), { recursive: true });
  await mkdir(join(root, 'pg_wal'));
  await writeFile(join(root, 'PG_VERSION'), '18\n');
  await writeFile(join(root, 'global/pg_control'), Uint8Array.of(1));
  return root;
}

function openWritable(pool: NodeSyncDirectoryPool, path: string): number {
  return requestOk(pool, OP.open, path, new Uint8Array(), 0, 0, FLAG_WRITE | FLAG_CREATE_NEW)[2];
}

function write(pool: NodeSyncDirectoryPool, descriptor: number, value: string): void {
  requestOk(pool, OP.write, '', new TextEncoder().encode(value), descriptor, 0);
}

function requestOk(
  pool: NodeSyncDirectoryPool,
  opcode: number,
  path: string,
  buffer = new Uint8Array(),
  arg0 = 0,
  arg1 = 0,
  flags = 0,
): [number, number, number, number] {
  const result = pool.request(opcode, path, buffer, arg0, arg1, flags);
  expect(result[0]).toBe(0);
  return result;
}

function fileEvents(root: string): string[] {
  return normalizedEvents(root)
    .filter((event) => event.startsWith('file:'))
    .map((event) => event.slice('file:'.length));
}

function normalizedEvents(root: string): string[] {
  return fsContract.events.map((event) => {
    const separator = event.indexOf(':');
    const kind = event.slice(0, separator);
    const path = event.slice(separator + 1);
    const child = relative(root, path).split(sep).join('/');
    return `${kind}:${child}`;
  });
}
