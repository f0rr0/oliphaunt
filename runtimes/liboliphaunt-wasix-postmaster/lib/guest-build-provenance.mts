#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { createHash, type Hash } from 'node:crypto';
import * as fs from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';

const schema = 'oliphaunt.wasix-postmaster.guest-installed-closure.v1';
const policy = new URL('../wasmer/policies/sealed-side-modules.v1.tsv', import.meta.url);
const occupied = new Set<string>();
export const sideModulePolicy = fs
  .readFileSync(policy, 'utf8')
  .split('\n')
  .filter((line) => line && !line.startsWith('#'))
  .map((line) => {
    const [relative, rawAliases, abi, extra] = line.split('\t');
    assert(
      relative?.startsWith('lib/') &&
        /\.(so|so\.5\.18)$/.test(relative) &&
        rawAliases &&
        abi &&
        extra === undefined,
      'invalid side-module policy',
    );
    const aliases = rawAliases === '-' ? [] : rawAliases.split(',');
    for (const path of [relative, ...aliases]) {
      assert(
        path.startsWith('lib/') &&
          !path.split('/').some((part) => !part || part === '.' || part === '..') &&
          !occupied.has(path),
        `invalid or duplicate side-module path: ${path}`,
      );
      occupied.add(path);
    }
    return { relative, aliases };
  });
assert(sideModulePolicy.length, 'empty side-module policy');
export const requiredModules = [
  'bin/initdb',
  'bin/postgres',
  ...sideModulePolicy.map((row) => row.relative),
];
const identity = (stat: fs.BigIntStats) => [
  stat.dev,
  stat.ino,
  stat.mode,
  stat.size,
  stat.mtimeNs,
  stat.ctimeNs,
];
const sorted = (paths: string[]) =>
  paths.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
const stat = (path: string) => fs.lstatSync(path, { bigint: true });

function withRegular<T>(
  path: string,
  directory: boolean,
  read: (fd: number, opened: fs.BigIntStats) => T,
): T {
  const before = stat(path);
  assert(
    directory ? before.isDirectory() : before.isFile(),
    `non-regular guest ${directory ? 'directory' : 'file'}: ${path}`,
  );
  const fd = fs.openSync(
    path,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | (directory ? fs.constants.O_DIRECTORY : 0),
  );
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    assert.deepEqual(
      identity(opened),
      identity(before),
      `guest entry changed while opening: ${path}`,
    );
    const result = read(fd, opened);
    assert.deepEqual(
      identity(fs.fstatSync(fd, { bigint: true })),
      identity(opened),
      `guest entry changed during read/sync: ${path}`,
    );
    assert.deepEqual(
      identity(stat(path)),
      identity(opened),
      `guest entry replaced during read/sync: ${path}`,
    );
    return result;
  } finally {
    fs.closeSync(fd);
  }
}

function readRegular(path: string, synchronize: boolean) {
  return withRegular(path, false, (fd, opened) => {
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let size = 0;
    for (;;) {
      const count = fs.readSync(fd, buffer);
      if (!count) break;
      hash.update(buffer.subarray(0, count));
      size += count;
      assert(BigInt(size) <= opened.size, `guest file grew while hashing: ${path}`);
    }
    assert(BigInt(size) === opened.size, `guest file changed while hashing: ${path}`);
    if (synchronize) fs.fsyncSync(fd);
    return { size, sha256: hash.digest('hex'), identity: identity(opened) };
  });
}

export function closureFiles(root: string): string[] {
  assert(stat(root).isDirectory(), 'guest install root is not a non-symlink directory');
  const files = [...requiredModules];
  for (const relative of files)
    assert(stat(join(root, relative)).isFile(), `missing regular guest module: ${relative}`);
  const visit = (relative: string) => {
    const directory = join(root, relative);
    assert(stat(directory).isDirectory(), `non-directory in guest closure: ${relative}`);
    for (const name of fs.readdirSync(directory, { encoding: 'buffer' })) {
      const decoded = new TextDecoder('utf-8', { fatal: true }).decode(name);
      const child = `${relative}/${decoded}`;
      const entry = stat(join(root, child));
      if (entry.isDirectory()) visit(child);
      else {
        assert(entry.isFile(), `non-regular guest closure member: ${child}`);
        files.push(child);
      }
    }
  };
  visit('share/postgresql');
  assert(files.length > requiredModules.length, 'PostgreSQL share closure is empty');
  assert(new Set(files).size === files.length, 'duplicate guest closure paths');
  return sorted(files);
}

function frame(hash: Hash, value: string) {
  const bytes = Buffer.from(value);
  const length = Buffer.alloc(8);
  length.writeBigUInt64BE(BigInt(bytes.length));
  hash.update(length).update(bytes);
}

export function installedClosureIdentityFromRecords(
  records: { relative: string; size: number; sha256: string }[],
) {
  assert(records.length, 'empty guest closure records');
  const paths = records.map((record) => record.relative);
  assert.deepEqual(
    paths,
    sorted([...new Set(paths)]),
    'guest closure records must be sorted and unique',
  );
  const hash = createHash('sha256');
  frame(hash, schema);
  for (const { relative, size, sha256 } of records) {
    assert(
      Number.isSafeInteger(size) && size >= 0 && /^[0-9a-f]{64}$/.test(sha256),
      'invalid guest closure size or SHA-256',
    );
    for (const field of [relative, String(size), sha256]) frame(hash, field);
  }
  return hash.digest('hex');
}

export function installedClosureIdentity(root: string, synchronize = false): string {
  root = resolve(root);
  const files = closureFiles(root);
  const records = files.map((relative) => ({
    relative,
    ...readRegular(join(root, relative), synchronize),
  }));
  if (synchronize) {
    const directories = new Set(['.']);
    for (const file of files) {
      for (let parent = posix.dirname(file); parent !== '.'; parent = posix.dirname(parent))
        directories.add(parent);
    }
    const directoryIdentities = new Map<string, bigint[]>();
    // Children must be durable before their containing directory and install root.
    for (const relative of sorted([...directories]).sort(
      (a, b) => b.split('/').length - a.split('/').length || (a === '.' ? 1 : b === '.' ? -1 : 0),
    )) {
      directoryIdentities.set(
        relative,
        withRegular(join(root, relative), true, (fd, opened) => {
          fs.fsyncSync(fd);
          return identity(opened);
        }),
      );
    }
    withRegular(dirname(root), true, (fd) => {
      assert.deepEqual(
        identity(stat(root)),
        directoryIdentities.get('.'),
        'guest root changed before parent sync',
      );
      fs.fsyncSync(fd);
      assert.deepEqual(
        identity(stat(root)),
        directoryIdentities.get('.'),
        'guest root changed during parent sync',
      );
    });
    assert.deepEqual(closureFiles(root), files, 'guest closure inventory changed after sync');
    assert.deepEqual(
      files.map((relative) => ({ relative, ...readRegular(join(root, relative), false) })),
      records,
      'guest closure changed after sync',
    );
    for (const [relative, expected] of directoryIdentities)
      assert.deepEqual(
        identity(stat(join(root, relative))),
        expected,
        `guest directory changed after sync: ${relative}`,
      );
  }
  return installedClosureIdentityFromRecords(records);
}

if (import.meta.main) {
  try {
    const [mode, root, extra] = process.argv.slice(2);
    assert(
      root && !extra && ['identity', 'seal-identity'].includes(mode!),
      'usage: guest-build-provenance.mts identity|seal-identity INSTALL_ROOT',
    );
    console.log(installedClosureIdentity(root, mode === 'seal-identity'));
  } catch (error) {
    console.error(`guest build provenance failed: ${(error as Error).message}`);
    process.exitCode = 2;
  }
}
