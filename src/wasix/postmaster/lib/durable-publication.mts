#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { stableRead } from './receipt-files.mts';

const maxBytes = 256 * 1024 * 1024;
type Source = { device: bigint; inode: bigint; size: number; sha256: string };
const stat = (path: string) => fs.lstatSync(path, { bigint: true, throwIfNoEntry: false });
const sameFile = (a: fs.BigIntStats, b: fs.BigIntStats | Source) =>
  a.dev === ('device' in b ? b.device : b.dev) && a.ino === ('inode' in b ? b.inode : b.ino);
const identity = (info: fs.BigIntStats) => [
  info.dev,
  info.ino,
  info.mode,
  info.size,
  info.mtimeNs,
  info.ctimeNs,
];
const token = (source: Source) =>
  [source.device, source.inode, source.size, source.sha256].join('\t');
export function parseToken(values: string[]): Source {
  assert(
    values.length === 4 && values.slice(0, 3).every((value) => /^(0|[1-9][0-9]*)$/.test(value)),
    'invalid publication token',
  );
  const [device, inode, size] = values.slice(0, 3).map((value) => BigInt(value));
  assert(
    device > 0n && inode > 0n && size <= BigInt(maxBytes) && /^[0-9a-f]{64}$/.test(values[3]),
    'invalid publication identity',
  );
  return { device, inode, size: Number(size), sha256: values[3] };
}
function openRegular(path: string) {
  const before = stat(path);
  assert(before?.isFile(), `publication source is not regular: ${path}`);
  const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    assert.deepEqual(
      identity(opened),
      identity(before),
      'publication source changed while opening',
    );
    const current = stat(path);
    assert(current?.isFile(), 'publication source disappeared');
    assert.deepEqual(identity(current), identity(opened), 'publication source was replaced');
    return { fd, info: opened };
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}
function descriptorHash(fd: number, size: number) {
  assert(
    Number.isSafeInteger(size) && size >= 0 && size <= maxBytes,
    'publication exceeds size bound',
  );
  const hash = createHash('sha256'),
    buffer = Buffer.alloc(1024 * 1024);
  let position = 0;
  while (position < size) {
    const count = fs.readSync(fd, buffer, 0, Math.min(buffer.length, size - position), position);
    assert(count > 0, 'publication was truncated');
    hash.update(buffer.subarray(0, count));
    position += count;
  }
  assert.equal(fs.readSync(fd, buffer, 0, 1, position), 0, 'publication grew');
  return hash.digest('hex');
}
export function sourceIdentity(path: string): Source {
  const hash = createHash('sha256');
  const info = stableRead(
    path,
    (chunk) => {
      hash.update(chunk);
    },
    maxBytes,
  );
  assert.equal(info.mode & 0o7777n, 0o444n, 'publication source must be sealed 0444');
  return { device: info.dev, inode: info.ino, size: Number(info.size), sha256: hash.digest('hex') };
}
// One CLI process owns one directory for its entire operation. Relative I/O stays
// anchored to that directory even if another process renames/replaces its path.
// Do not call this from a process serving concurrent filesystem operations.
export function anchorDirectory(path: string) {
  const before = stat(path);
  assert(before?.isDirectory(), 'publication parent is not a real directory');
  process.chdir(path);
  const fd = fs.openSync(
    '.',
    fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
  );
  try {
    const current = fs.fstatSync(fd, { bigint: true });
    assert(
      current.isDirectory() && sameFile(current, before),
      'publication parent changed while opening',
    );
    return fd;
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}
export function removePrivate(path: string, expected: Source, dirfd: number) {
  const current = stat(path);
  if (!current) return;
  assert(current.isFile() && sameFile(current, expected), 'private publication generation changed');
  fs.unlinkSync(path);
  fs.fsyncSync(dirfd);
}
export function publish(source: string, destination: string, expected: Source, dirfd: number) {
  assert(!stat(destination), 'publication destination already exists');
  const { fd, info } = openRegular(source);
  let linked: fs.BigIntStats | undefined,
    committed = false;
  try {
    assert.equal(info.mode & 0o7777n, 0o444n, 'publication source is not sealed');
    assert(
      sameFile(info, expected) && info.size === BigInt(expected.size),
      'publication source generation differs',
    );
    const digest = descriptorHash(fd, expected.size);
    assert.equal(digest, expected.sha256, 'publication source bytes differ');
    fs.fsyncSync(fd);
    fs.linkSync(source, destination);
    linked = stat(destination);
    assert(linked, 'publication destination disappeared');
    const published = openRegular(destination);
    try {
      assert(sameFile(info, published.info), 'publication destination identity differs');
      const current = fs.fstatSync(fd, { bigint: true });
      assert.deepEqual(
        identity(current).slice(0, -1),
        identity(info).slice(0, -1),
        'publication source changed before commit',
      );
      assert.equal(
        descriptorHash(fd, expected.size),
        digest,
        'publication source bytes changed before commit',
      );
      fs.fsyncSync(published.fd);
    } finally {
      fs.closeSync(published.fd);
    }
    fs.fsyncSync(dirfd);
    committed = true;
  } finally {
    fs.closeSync(fd);
    if (linked && !committed) {
      const current = stat(destination);
      if (current && sameFile(current, linked)) {
        fs.unlinkSync(destination);
        fs.fsyncSync(dirfd);
      }
    }
  }
  removePrivate(source, expected, dirfd);
}
function requireDestination(path: string, expected: Source, dirfd: number) {
  const { fd, info } = openRegular(path);
  try {
    assert.equal(info.mode & 0o7777n, 0o444n, 'publication set destination is not sealed');
    assert.equal(info.size, BigInt(expected.size), 'publication set destination size differs');
    assert.equal(
      descriptorHash(fd, expected.size),
      expected.sha256,
      'publication set destination bytes differ',
    );
    fs.fsyncSync(fd);
    fs.fsyncSync(dirfd);
  } finally {
    fs.closeSync(fd);
  }
}
export function publishSet(
  pairs: { source: string; destination: string; expected?: Source }[],
  dirfd: number,
) {
  assert(pairs.length >= 2, 'publication set requires two or more pairs');
  const sources = new Set(pairs.map((pair) => pair.source)),
    destinations = new Set(pairs.map((pair) => pair.destination));
  assert(
    sources.size === pairs.length &&
      destinations.size === pairs.length &&
      ![...sources].some((path) => destinations.has(path)),
    'publication set names must be unique and disjoint',
  );
  const identified = pairs.map((pair) => {
    const expected = sourceIdentity(pair.source);
    if (pair.expected)
      assert.deepEqual(expected, pair.expected, 'publication set generation differs');
    return { ...pair, expected };
  });
  // Reject any conflicting existing member before creating a new partial set.
  for (const pair of identified)
    if (stat(pair.destination)) requireDestination(pair.destination, pair.expected, dirfd);
  for (const { source, destination, expected } of identified) {
    try {
      publish(source, destination, expected, dirfd);
    } catch {
      requireDestination(destination, expected, dirfd);
      removePrivate(source, expected, dirfd);
    }
  }
}
export async function writePrivate(
  path: string,
  chunks: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  dirfd: number,
): Promise<Source> {
  const fd = fs.openSync(
    path,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
    0o600,
  );
  const opened = fs.fstatSync(fd, { bigint: true }),
    hash = createHash('sha256');
  let size = 0;
  try {
    for await (const chunk of chunks) {
      size += chunk.length;
      assert(size <= maxBytes, 'publication input exceeds size bound');
      hash.update(chunk);
      for (let offset = 0; offset < chunk.length; ) {
        const count = fs.writeSync(fd, chunk, offset);
        assert(count > 0, 'short publication write');
        offset += count;
      }
    }
    fs.fchmodSync(fd, 0o444);
    fs.fsyncSync(fd);
    const final = fs.fstatSync(fd, { bigint: true }),
      current = stat(path);
    assert(
      final.isFile() &&
        sameFile(final, opened) &&
        final.size === BigInt(size) &&
        current?.isFile() &&
        sameFile(current, final),
      'publication changed while writing',
    );
    return { device: final.dev, inode: final.ino, size, sha256: hash.digest('hex') };
  } catch (error) {
    const current = stat(path);
    if (current && sameFile(current, opened)) {
      fs.unlinkSync(path);
      fs.fsyncSync(dirfd);
    }
    throw error;
  } finally {
    fs.closeSync(fd);
  }
}
export async function run(args: string[]) {
  const [command, ...values] = args;
  if (command === 'require-equal' && values.length === 2) {
    const read = (path: string) => {
      const chunks: Buffer[] = [];
      stableRead(path, (chunk) => chunks.push(Buffer.from(chunk)), 16 * 1024 * 1024);
      return Buffer.concat(chunks);
    };
    assert(read(values[0]).equals(read(values[1])), 'regular files differ');
    return;
  }
  if (command === 'identify-source' && values.length === 1) {
    console.log(token(sourceIdentity(values[0])));
    return;
  }
  let paths: string[],
    tokens: Source[] = [];
  if (
    (command === 'publish' && values.length === 2) ||
    (command === 'publish-identified' && values.length === 6)
  ) {
    paths = values.slice(0, 2);
    if (command === 'publish-identified') tokens = [parseToken(values.slice(2))];
  } else if (command === 'publish-set' && values.length >= 4 && values.length % 2 === 0)
    paths = values;
  else if (command === 'publish-set-identified' && values.length >= 12 && values.length % 6 === 0) {
    paths = [];
    for (let index = 0; index < values.length; index += 6) {
      paths.push(...values.slice(index, index + 2));
      tokens.push(parseToken(values.slice(index + 2, index + 6)));
    }
  } else if (command === 'remove-private-identified' && values.length === 5) {
    paths = values.slice(0, 1);
    tokens = [parseToken(values.slice(1))];
  } else if (
    ['write-stdin', 'write-stdin-identified', 'discard-private', 'fsync-directory'].includes(
      command,
    ) &&
    values.length === 1
  )
    paths = values;
  else
    assert.fail(
      'usage: durable-publication.mts publish[-identified] | publish-set[-identified] | write-stdin[-identified] | identify-source | require-equal | discard-private | remove-private-identified | fsync-directory',
    );
  paths = paths.map((path) => resolve(path));
  const parent = command === 'fsync-directory' ? paths[0] : dirname(paths[0]);
  if (command !== 'fsync-directory')
    assert(
      paths.every((path) => dirname(path) === parent),
      'publication paths must share one directory',
    );
  if (command.startsWith('publish'))
    for (let index = 0; index < paths.length; index += 2)
      assert(paths[index] !== paths[index + 1], 'publication source and destination must differ');
  const fd = anchorDirectory(parent);
  paths = paths.map((path) => basename(path));
  try {
    if (command === 'fsync-directory') fs.fsyncSync(fd);
    else if (command.startsWith('write-stdin')) {
      const source = await writePrivate(paths[0], process.stdin, fd);
      if (command === 'write-stdin-identified') console.log(token(source));
    } else if (command === 'discard-private') {
      const info = stat(paths[0]);
      if (info)
        removePrivate(
          paths[0],
          { device: info.dev, inode: info.ino, size: Number(info.size), sha256: '' },
          fd,
        );
    } else if (command === 'remove-private-identified') removePrivate(paths[0], tokens[0], fd);
    else if (command.startsWith('publish-set'))
      publishSet(
        Array.from({ length: paths.length / 2 }, (_, index) => ({
          source: paths[index * 2],
          destination: paths[index * 2 + 1],
          expected: tokens[index],
        })),
        fd,
      );
    else publish(paths[0], paths[1], tokens[0] ?? sourceIdentity(paths[0]), fd);
  } finally {
    fs.closeSync(fd);
  }
}
if (import.meta.main) {
  try {
    await run(process.argv.slice(2));
  } catch (error) {
    console.error(`durable publication failed: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 2;
  }
}
