import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import {
  NodeSyncDirectoryPool,
  nodeSyncContainedRelativePath,
  validateNodeSyncBridgePath,
} from '../storage/node-sync-directory-pool.js';

const OP = {
  metadata: 1,
  readDirectory: 2,
  createDirectory: 3,
  removeDirectory: 4,
  rename: 5,
  removeFile: 6,
  open: 7,
  close: 8,
  read: 9,
  write: 10,
  flush: 11,
  truncate: 12,
  unlink: 13,
  fileSize: 14,
} as const;

const FLAG_READ = 1 << 0;
const FLAG_WRITE = 1 << 1;
const FLAG_CREATE_NEW = 1 << 2;
const FLAG_APPEND = 1 << 4;
const scratch: string[] = [];

afterEach(async () => {
  await Promise.all(scratch.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('Node synchronous directory bridge', () => {
  it('preserves descriptor identity across rename and unlink', async () => {
    const root = await databaseRoot('descriptor-identity');
    const pool = new NodeSyncDirectoryPool(root);
    requestOk(pool, OP.createDirectory, 'user');
    const descriptor = requestOk(
      pool,
      OP.open,
      'user/value',
      new Uint8Array(),
      0,
      0,
      FLAG_READ | FLAG_WRITE | FLAG_CREATE_NEW,
    )[2];
    const value = new TextEncoder().encode('persistent value');
    expect(requestOk(pool, OP.write, '', value, descriptor, 0)[2]).toBe(value.byteLength);
    requestOk(pool, OP.flush, '', new Uint8Array(), descriptor);
    requestOk(pool, OP.rename, 'user/value', new TextEncoder().encode('user/renamed'));

    const read = new Uint8Array(64);
    const readResult = requestOk(pool, OP.read, '', read, descriptor, 0);
    expect(new TextDecoder().decode(read.subarray(0, readResult[1]))).toBe('persistent value');
    expect(requestOk(pool, OP.fileSize, '', new Uint8Array(), descriptor)[2]).toBe(
      value.byteLength,
    );

    requestOk(pool, OP.unlink, '', new Uint8Array(), descriptor);
    expect(pool.request(OP.metadata, 'user/renamed', new Uint8Array(), 0, 0, 0)[0]).toBe(1);
    const afterUnlink = new Uint8Array(64);
    const afterUnlinkResult = requestOk(pool, OP.read, '', afterUnlink, descriptor, 0);
    expect(new TextDecoder().decode(afterUnlink.subarray(0, afterUnlinkResult[1]))).toBe(
      'persistent value',
    );
    requestOk(pool, OP.close, '', new Uint8Array(), descriptor);
    await pool.sync();
    pool.close();
  });

  it('preserves a descriptor mapping across a same-path rename', async () => {
    const root = await databaseRoot('same-path-rename');
    const pool = new NodeSyncDirectoryPool(root);
    const descriptor = requestOk(
      pool,
      OP.open,
      'same',
      new Uint8Array(),
      0,
      0,
      FLAG_READ | FLAG_WRITE | FLAG_CREATE_NEW,
    )[2];
    requestOk(pool, OP.write, '', new TextEncoder().encode('value'), descriptor, 0);
    requestOk(pool, OP.rename, 'same', new TextEncoder().encode('same'));
    requestOk(pool, OP.unlink, '', new Uint8Array(), descriptor);
    expect(pool.request(OP.metadata, 'same', new Uint8Array(), 0, 0, 0)[0]).toBe(1);
    requestOk(pool, OP.close, '', new Uint8Array(), descriptor);
    await pool.sync();
    pool.close();
  });

  it('implements append, truncate, directory paging, and durable publication', async () => {
    const root = await databaseRoot('filesystem-contract');
    const pool = new NodeSyncDirectoryPool(root);
    requestOk(pool, OP.createDirectory, 'data');
    const descriptor = requestOk(
      pool,
      OP.open,
      'data/log',
      new Uint8Array(),
      0,
      0,
      FLAG_WRITE | FLAG_CREATE_NEW,
    )[2];
    requestOk(pool, OP.write, '', new TextEncoder().encode('one'), descriptor, 0);
    requestOk(pool, OP.close, '', new Uint8Array(), descriptor);

    const append = requestOk(
      pool,
      OP.open,
      'data/log',
      new Uint8Array(),
      0,
      0,
      FLAG_WRITE | FLAG_APPEND,
    )[2];
    requestOk(pool, OP.write, '', new TextEncoder().encode('two'), append, 0);
    requestOk(pool, OP.truncate, '', new Uint8Array(), append, 4);
    requestOk(pool, OP.close, '', new Uint8Array(), append);

    const page = new Uint8Array(4096);
    const pageResult = requestOk(pool, OP.readDirectory, 'data', page);
    expect(decodeDirectoryPage(page.subarray(0, pageResult[1]))).toEqual(['log']);
    await pool.sync();
    expect(await readFile(join(root, 'data/log'), 'utf8')).toBe('onet');
    pool.close();
  });

  it('rejects traversal and symbolic links instead of following them', async () => {
    const root = await databaseRoot('containment');
    const outside = join(root, '..', 'outside');
    await writeFile(outside, 'outside');
    await symlink(outside, join(root, 'escape'));
    expect(() => new NodeSyncDirectoryPool(root)).toThrow(/symbolic link/u);
    await rm(join(root, 'escape'));

    const pool = new NodeSyncDirectoryPool(root);
    expect(pool.request(OP.metadata, '../outside', new Uint8Array(), 0, 0, 0)[0]).toBe(7);
    await symlink(outside, join(root, 'escape'));
    expect(pool.request(OP.metadata, 'escape', new Uint8Array(), 0, 0, 0)[0]).toBe(11);
    expect(pool.request(OP.metadata, 'PG_VERSION', new Uint8Array(), 0, 0, 0)[0]).toBe(11);
    expect(await readFile(outside, 'utf8')).toBe('outside');
    pool.close();
  });

  it('rejects a symbolic-link root instead of silently changing the confinement root', async () => {
    const root = await databaseRoot('root-link-target');
    const alias = join(root, '..', 'root-link');
    await symlink(root, alias, 'dir');
    expect(() => new NodeSyncDirectoryPool(alias)).toThrow(/symbolic link/u);
  });

  it('rejects a hard link added after open at the next explicit flush', async () => {
    const root = await databaseRoot('late-hardlink');
    const pool = new NodeSyncDirectoryPool(root);
    const descriptor = requestOk(
      pool,
      OP.open,
      'linked-late',
      new Uint8Array(),
      0,
      0,
      FLAG_WRITE | FLAG_CREATE_NEW,
    )[2];
    requestOk(pool, OP.write, '', new TextEncoder().encode('dirty'), descriptor, 0);
    await link(join(root, 'linked-late'), join(root, '..', 'late-hardlink-alias'));

    expect(pool.request(OP.flush, '', new Uint8Array(), descriptor, 0, 0)[0]).toBe(11);
    expect(pool.request(OP.metadata, 'PG_VERSION', new Uint8Array(), 0, 0, 0)[0]).toBe(11);
    pool.close();
  });

  it('relocates and forgets pending directory durability work with namespace changes', async () => {
    const root = await databaseRoot('directory-durability-state');
    const pool = new NodeSyncDirectoryPool(root);
    requestOk(pool, OP.createDirectory, 'first');
    const moved = requestOk(
      pool,
      OP.open,
      'first/value',
      new Uint8Array(),
      0,
      0,
      FLAG_WRITE | FLAG_CREATE_NEW,
    )[2];
    requestOk(pool, OP.write, '', new TextEncoder().encode('moved'), moved, 0);
    requestOk(pool, OP.close, '', new Uint8Array(), moved);
    requestOk(pool, OP.rename, 'first', new TextEncoder().encode('second'));

    requestOk(pool, OP.createDirectory, 'discarded');
    const removed = requestOk(
      pool,
      OP.open,
      'discarded/value',
      new Uint8Array(),
      0,
      0,
      FLAG_WRITE | FLAG_CREATE_NEW,
    )[2];
    requestOk(pool, OP.close, '', new Uint8Array(), removed);
    requestOk(pool, OP.removeFile, 'discarded/value');
    requestOk(pool, OP.removeDirectory, 'discarded');

    await expect(pool.sync()).resolves.toBeUndefined();
    expect(await readFile(join(root, 'second/value'), 'utf8')).toBe('moved');
    pool.close();
  });

  it('poisons the bridge when a dirty file changes before its durability boundary', async () => {
    const root = await databaseRoot('poison');
    const outside = join(root, '..', 'poison-outside');
    await writeFile(outside, 'outside');
    const pool = new NodeSyncDirectoryPool(root);
    const descriptor = requestOk(
      pool,
      OP.open,
      'dirty',
      new Uint8Array(),
      0,
      0,
      FLAG_WRITE | FLAG_CREATE_NEW,
    )[2];
    requestOk(pool, OP.write, '', new TextEncoder().encode('dirty'), descriptor, 0);
    requestOk(pool, OP.close, '', new Uint8Array(), descriptor);

    await rm(join(root, 'dirty'));
    await symlink(outside, join(root, 'dirty'));
    await expect(pool.sync()).rejects.toThrow(/symbolic link/u);
    expect(pool.request(OP.metadata, 'PG_VERSION', new Uint8Array(), 0, 0, 0)[0]).toBe(11);
    pool.close();
  });

  it('fails bridge requests after close', async () => {
    const root = await databaseRoot('closed');
    const pool = new NodeSyncDirectoryPool(root);
    pool.close();
    expect(pool.request(OP.metadata, 'PG_VERSION', new Uint8Array(), 0, 0, 0)[0]).toBe(11);
    await expect(pool.sync()).rejects.toThrow(/closed/u);
  });

  it('keeps recoverable input and lookup errors from poisoning the bridge', async () => {
    const root = await databaseRoot('recoverable-errors');
    const pool = new NodeSyncDirectoryPool(root);
    expect(pool.request(OP.metadata, '../outside', new Uint8Array(), 0, 0, 0)[0]).toBe(7);
    expect(pool.request(OP.metadata, 'missing', new Uint8Array(), 0, 0, 0)[0]).toBe(1);
    expect(requestOk(pool, OP.metadata, 'PG_VERSION')[2]).toBe(1);
    pool.close();
  });
});

describe('Node synchronous directory bridge path contract', () => {
  it('models Windows containment case-insensitively without accepting siblings or drives', () => {
    expect(
      nodeSyncContainedRelativePath(String.raw`C:\Data`, String.raw`c:\data\global`, win32),
    ).toBe('global');
    expect(
      nodeSyncContainedRelativePath(
        String.raw`\\server\share\Data`,
        String.raw`\\SERVER\SHARE\data\pg_wal`,
        win32,
      ),
    ).toBe('pg_wal');
    expect(() =>
      nodeSyncContainedRelativePath(String.raw`C:\Data`, String.raw`C:\Database`, win32),
    ).toThrow(/escapes/u);
    expect(() =>
      nodeSyncContainedRelativePath(String.raw`C:\Data`, String.raw`D:\Data\value`, win32),
    ).toThrow(/escapes/u);
  });

  it('rejects Windows device, alternate-stream, and aliasing path segments', () => {
    for (const path of [
      'C:/outside',
      'global/pg_control:shadow',
      'base/CON',
      'base/nul.txt',
      'base/name.',
      'base/name ',
      'base/value?',
    ]) {
      expect(() => validateNodeSyncBridgePath(path, false, 'win32'), path).toThrow(/unsafe/u);
    }
    expect(validateNodeSyncBridgePath('base/16384/2600', false, 'win32')).toEqual([
      'base',
      '16384',
      '2600',
    ]);
  });
});

async function databaseRoot(suffix: string): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), 'oliphaunt-node-sync-pool-'));
  scratch.push(parent);
  const root = join(parent, suffix);
  await mkdir(join(root, 'global'), { recursive: true });
  await mkdir(join(root, 'pg_wal'));
  await writeFile(join(root, 'PG_VERSION'), '18\n');
  await writeFile(join(root, 'global/pg_control'), Uint8Array.of(1));
  return root;
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

function decodeDirectoryPage(bytes: Uint8Array): string[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(0, true);
  const names: string[] = [];
  let offset = 4;
  for (let index = 0; index < count; index += 1) {
    offset += 1;
    const length = view.getUint32(offset, true);
    offset += 4;
    names.push(new TextDecoder().decode(bytes.subarray(offset, offset + length)));
    offset += length;
  }
  return names;
}
