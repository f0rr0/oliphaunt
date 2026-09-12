import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { parseStrictJson } from '../../../tools/packaging/strict-json.mts';
import { requiredModules } from './guest-build-provenance.mts';
import { parsePayloadInventory } from './verify-sealed-carrier.mts';
import { safeRelative } from './receipt-files.mts';
import { publish, writePrivate } from './durable-publication.mts';

export const SCHEMA = 'oliphaunt.wasix-postmaster.immutable-carrier-deployment.v2';
export const POLICY = 'linux-ext-fs-immutable-sealed-closure-v2';
export const IMMUTABLE = 0x10;
export const EXT_MAGIC = 0xef53;
const c = fs.constants;
const READ = c.O_RDONLY | c.O_NOFOLLOW | c.O_NONBLOCK;
const identityNames = [
  'manifest.json',
  'wasmer-build.receipt',
  'payload.files',
  'bin/wasmer-headless',
];
const identityFields = [
  'manifest-sha256',
  'wasmer-build-receipt-sha256',
  'payload-inventory-sha256',
  'headless-sha256',
];
const expectedCount = requiredModules.length;
type Ops = {
  getFlags(fd: number): number;
  setFlags(fd: number, flags: number): void;
  filesystemMagic(fd: number): number;
};
type Entry = { fd: number; row: any };
const fdPath = (fd: number, name = '') => `/proc/self/fd/${fd}${name ? `/${name}` : ''}`;
const sha = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex');
const requireSha = (value: unknown) =>
  assert(typeof value === 'string' && /^[0-9a-f]{64}$/.test(value), 'invalid SHA-256');
const sameInode = (a: fs.BigIntStats, b: fs.BigIntStats) => a.dev === b.dev && a.ino === b.ino;
const mode = (info: fs.BigIntStats) => (info.mode & 0o7777n).toString(8).padStart(4, '0');
const hex = (value: number) => `0x${(value >>> 0).toString(16).padStart(8, '0')}`;
const postFlags = (value: number) => (value | IMMUTABLE) >>> 0;
const keys = (value: any, expected: string[]) =>
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort(), 'receipt fields differ');
const ordered = (entries: Entry[]) =>
  [...entries].sort(
    (a, b) =>
      Number(a.row.path !== '.') - Number(b.row.path !== '.') ||
      (a.row.path < b.row.path ? -1 : a.row.path > b.row.path ? 1 : 0),
  );

export function canonicalJson(value: any): string {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${canonicalJson(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  return JSON.stringify(value).replace(
    /[\u0080-\uffff]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}
function json(data: Buffer) {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(data);
  assert(!text.includes('\r'), 'JSON contains a carriage return');
  return parseStrictJson(text, (_key, value, context) => {
    if (typeof value !== 'number') return value;
    assert(/^-?(0|[1-9][0-9]*)$/.test(context.source), 'JSON identity must use integer numbers');
    return BigInt(context.source);
  }) as any;
}
export function kernelOps(): Ops {
  assert(process.platform === 'linux', 'immutable deployment requires Linux');
  assert(
    process.env.OLIPHAUNT_IMMUTABLE_KERNEL,
    'immutable kernel binding is missing; use the Shell entry point',
  );
  const kernel = require(process.env.OLIPHAUNT_IMMUTABLE_KERNEL);
  return { ...kernel, filesystemMagic: (fd: number) => fs.statfsSync(fdPath(fd)).type };
}
export function requireCapability() {
  assert(process.geteuid!() === 0, 'immutable deployment/removal requires effective UID 0');
  const capabilities = /^CapEff:\s+([0-9a-f]+)$/m.exec(
    fs.readFileSync('/proc/self/status', 'ascii'),
  );
  assert(
    capabilities && BigInt(`0x${capabilities[1]}`) & (1n << 9n),
    'immutable deployment/removal requires effective CAP_LINUX_IMMUTABLE',
  );
}
function openRoot(path: string) {
  assert(process.platform === 'linux', 'immutable deployment requires Linux');
  assert(
    isAbsolute(path) && fs.realpathSync(path) === path,
    'path must already be canonical and absolute',
  );
  const before = fs.lstatSync(path, { bigint: true });
  assert(before.isDirectory(), 'root must be a non-symlink directory');
  const fd = fs.openSync(path, READ | c.O_DIRECTORY);
  try {
    assert(sameInode(before, fs.fstatSync(fd, { bigint: true })), 'root changed while opening');
    return fd;
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}
export function openBeneath(root: number, path: string, directory = false) {
  if (path !== '.') safeRelative(path);
  // /proc/self/fd holds the same open directory inode if its original path is replaced.
  let fd = fs.openSync(fdPath(root), c.O_RDONLY | c.O_DIRECTORY);
  try {
    const parts = path === '.' ? [] : path.split('/');
    for (let index = 0; index < parts.length; index++) {
      const child = fs.openSync(
        fdPath(fd, parts[index]),
        READ | (index < parts.length - 1 || directory ? c.O_DIRECTORY : 0),
      );
      fs.closeSync(fd);
      fd = child;
    }
    const info = fs.fstatSync(fd, { bigint: true });
    assert(directory ? info.isDirectory() : info.isFile(), 'carrier entry type differs');
    return fd;
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}
function readFd(fd: number, retain = false) {
  const before = fs.fstatSync(fd, { bigint: true });
  assert(before.isFile(), 'expected regular file');
  if (retain) assert(before.size <= 16n * 1024n ** 2n, 'receipt exceeds 16 MiB');
  const hash = createHash('sha256'),
    chunks: Buffer[] = [],
    buffer = Buffer.alloc(1024 * 1024);
  let position = 0;
  for (;;) {
    const count = fs.readSync(fd, buffer, 0, buffer.length, position);
    if (!count) break;
    position += count;
    assert(BigInt(position) <= before.size, 'file grew while reading');
    hash.update(buffer.subarray(0, count));
    if (retain) chunks.push(Buffer.from(buffer.subarray(0, count)));
  }
  const after = fs.fstatSync(fd, { bigint: true });
  assert(
    BigInt(position) === before.size &&
      before.size === after.size &&
      before.mtimeNs === after.mtimeNs &&
      before.ctimeNs === after.ctimeNs,
    'file changed while reading',
  );
  return { hash: hash.digest('hex'), data: Buffer.concat(chunks) };
}
function identity(root: number) {
  const hashes: Record<string, string> = {},
    contents: Record<string, Buffer> = {};
  for (const name of identityNames) {
    const fd = openBeneath(root, name);
    try {
      const result = readFd(fd, name === 'manifest.json' || name === 'payload.files');
      hashes[name] = result.hash;
      contents[name] = result.data;
    } finally {
      fs.closeSync(fd);
    }
  }
  return { hashes, contents };
}
function expectedIdentity(actual: Record<string, string>, expected?: Record<string, string>) {
  if (expected)
    for (const name of identityNames) {
      requireSha(expected[name]);
      assert.equal(actual[name], expected[name], `carrier identity changed: ${name}`);
    }
}
function carrierIdentity(path: string, root: fs.BigIntStats, hashes: Record<string, string>) {
  return {
    'closure-identity': sha(
      [
        'oliphaunt.wasix-postmaster.qualification-carrier.v1',
        ...identityNames.map((name) => hashes[name]),
        '',
      ].join('\0'),
    ),
    device: root.dev,
    inode: root.ino,
    path,
    ...Object.fromEntries(
      identityFields.map((field, index) => [field, hashes[identityNames[index]]]),
    ),
  };
}
function provenance(data: Buffer) {
  const manifest = json(data);
  assert(
    manifest['format-version'] === 6n &&
      manifest.schema === 'oliphaunt.wasix-postmaster.sealed-aot.v5',
    'manifest provenance schema differs',
  );
  assert(['release-o3', 'safe-o2'].includes(manifest['core-profile']), 'invalid core profile');
  requireSha(manifest['guest-build-recipe-sha256']);
  return {
    core_profile: manifest['core-profile'],
    guest_build_recipe_sha256: manifest['guest-build-recipe-sha256'],
  };
}
function directPaths(data: Buffer) {
  const artifacts = json(data).artifacts;
  assert(
    Array.isArray(artifacts) && artifacts.length === expectedCount,
    'manifest AOT count differs',
  );
  const paths = new Map<string, string>();
  for (const artifact of artifacts) {
    assert(
      typeof artifact.path === 'string' &&
        /^aot\/[0-9A-F]{64}\.bin$/.test(artifact.path) &&
        !paths.has(artifact.path),
      'invalid or duplicate AOT path',
    );
    requireSha(artifact.sha256);
    paths.set(artifact.path, artifact.sha256);
  }
  return paths;
}
function inventory(data: Buffer) {
  return new Map(
    [...parsePayloadInventory(data)].map(([path, record]) => [
      path,
      { size: BigInt(record.size), hash: record.sha256 },
    ]),
  );
}
function closeAll(entries: Entry[]) {
  for (const entry of entries) fs.closeSync(entry.fd);
}
function closure(root: number, contents: Record<string, Buffer>, ops: Ops): Entry[] {
  const files = inventory(contents['payload.files']),
    direct = directPaths(contents['manifest.json']),
    entries: Entry[] = [];
  files.set('payload.files', {
    size: BigInt(contents['payload.files'].length),
    hash: sha(contents['payload.files']),
  });
  function walk(path: string, directory: boolean, before?: fs.BigIntStats) {
    const fd = openBeneath(root, path, directory);
    const entry = { fd, row: {} as any };
    entries.push(entry);
    const info = fs.fstatSync(fd, { bigint: true }),
      permissions = mode(info);
    assert(
      directory ? permissions === '0555' : ['0444', '0555'].includes(permissions),
      `sealed mode differs: ${path}`,
    );
    assert.equal(
      ops.filesystemMagic(fd),
      EXT_MAGIC,
      'carrier entry must reside on ext-family filesystem',
    );
    if (before) assert(sameInode(before, info), 'carrier entry changed while opening');
    const hash = directory ? null : readFd(fd).hash;
    if (!directory) {
      assert.deepEqual({ size: info.size, hash }, files.get(path), `payload differs: ${path}`);
      if (direct.has(path))
        assert.equal(hash, direct.get(path), `direct-loader SHA-256 differs: ${path}`);
    }
    const flags = ops.getFlags(fd);
    entry.row = {
      device: info.dev,
      inode: info.ino,
      size: info.size,
      uid: info.uid,
      gid: info.gid,
      mode: permissions,
      path,
      'entry-type': directory ? 'directory' : 'file',
      'direct-loader-kind': direct.has(path) ? 'aot' : 'none',
      sha256: hash,
      'pre-flags': hex(flags),
      'post-flags': hex(postFlags(flags)),
    };
    if (directory)
      for (const name of fs.readdirSync(fdPath(fd)).sort()) {
        const relative = path === '.' ? name : `${path}/${name}`;
        safeRelative(relative);
        const before = fs.lstatSync(fdPath(fd, name), { bigint: true });
        assert(
          before.isFile() || before.isDirectory(),
          'carrier contains a symlink or special entry',
        );
        walk(relative, before.isDirectory(), before);
      }
  }
  try {
    walk('.', true);
    assert.deepEqual(
      entries
        .filter((e) => e.row['entry-type'] === 'file')
        .map((e) => e.row.path)
        .sort(),
      [...files.keys()].sort(),
      'carrier file closure differs',
    );
    assert.deepEqual(
      entries
        .filter((e) => e.row['direct-loader-kind'] === 'aot')
        .map((e) => e.row.path)
        .sort(),
      [...direct.keys()].sort(),
      'direct-loader closure differs',
    );
    return entries;
  } catch (error) {
    closeAll(entries);
    throw error;
  }
}

function receiptParent(path: string, carrier: string) {
  assert(isAbsolute(path) && resolve(path) === path, 'receipt path must be canonical and absolute');
  assert(
    path !== carrier && !path.startsWith(`${carrier}/`),
    'receipt must be outside the carrier',
  );
  return openRoot(dirname(path));
}
function readReceipt(path: string, carrier: string, ops: Ops, owner: bigint, immutable: boolean) {
  const parent = receiptParent(path, carrier);
  let fd = -1;
  try {
    fd = openBeneath(parent, basename(path));
    const info = fs.fstatSync(fd, { bigint: true });
    assert(
      info.uid === owner && mode(info) === '0444',
      'deployment receipt must be root-owned with mode 0444',
    );
    assert.equal(
      ops.filesystemMagic(fd),
      EXT_MAGIC,
      'deployment receipt must reside on ext-family filesystem',
    );
    if (immutable)
      assert(ops.getFlags(fd) & IMMUTABLE, 'deployment receipt inode is not immutable');
    const { data, hash } = readFd(fd, true),
      receipt = json(data);
    assert.equal(
      `${canonicalJson(receipt)}\n`,
      data.toString('utf8'),
      'deployment receipt is not canonical JSON',
    );
    keys(receipt, [
      'carrier',
      'core_profile',
      'direct-loader-paths',
      'entries',
      'filesystem',
      'guest_build_recipe_sha256',
      'policy',
      'schema',
    ]);
    assert(
      receipt.schema === SCHEMA && receipt.policy === POLICY,
      'deployment receipt policy differs',
    );
    assert(
      ['release-o3', 'safe-o2'].includes(receipt.core_profile),
      'deployment receipt core profile differs',
    );
    requireSha(receipt.guest_build_recipe_sha256);
    return { receipt, info, hash };
  } finally {
    if (fd >= 0) fs.closeSync(fd);
    fs.closeSync(parent);
  }
}
function unlinkReceipt(path: string, info: fs.BigIntStats, hash: string, ops: Ops) {
  const parent = receiptParent(path, '/nonexistent-carrier-placeholder');
  let fd = -1;
  try {
    const name = fdPath(parent, basename(path));
    fd = openBeneath(parent, basename(path));
    assert(
      sameInode(info, fs.fstatSync(fd, { bigint: true })),
      'receipt identity changed before removal',
    );
    assert.equal(readFd(fd).hash, hash, 'receipt content changed before removal');
    const flags = (ops.getFlags(fd) & ~IMMUTABLE) >>> 0;
    ops.setFlags(fd, flags);
    assert.equal(ops.getFlags(fd), flags, 'receipt immutable flag could not be cleared');
    assert(
      sameInode(info, fs.lstatSync(name, { bigint: true })),
      'receipt path changed before removal',
    );
    fs.unlinkSync(name);
    fs.fsyncSync(parent);
  } finally {
    if (fd >= 0) fs.closeSync(fd);
    fs.closeSync(parent);
  }
}
async function writeReceipt(path: string, carrier: string, data: Buffer, ops: Ops, owner: bigint) {
  const parent = receiptParent(path, carrier);
  const temporary = fdPath(parent, `.${basename(path)}.pending.${randomUUID()}`),
    destination = fdPath(parent, basename(path));
  let fd = -1,
    published = false;
  try {
    const source = await writePrivate(
      temporary,
      (async function* () {
        yield data;
      })(),
      parent,
    );
    fd = fs.openSync(temporary, READ);
    const info = fs.fstatSync(fd, { bigint: true });
    assert.equal(info.uid, owner, 'deployment receipt has the wrong owner');
    assert.equal(
      ops.filesystemMagic(fd),
      EXT_MAGIC,
      'deployment receipt must reside on ext-family filesystem',
    );
    const flags = ops.getFlags(fd);
    assert(!(flags & IMMUTABLE), 'new deployment receipt unexpectedly begins immutable');
    publish(temporary, destination, source, parent);
    published = true;
    ops.setFlags(fd, postFlags(flags));
    assert.equal(ops.getFlags(fd), postFlags(flags), 'receipt immutable flag did not stick');
    fs.fsyncSync(fd);
    fs.fsyncSync(parent);
    return { info, hash: sha(data) };
  } catch (error) {
    if (published && fd >= 0) {
      const info = fs.fstatSync(fd, { bigint: true });
      try {
        unlinkReceipt(path, info, sha(data), ops);
      } catch {
        /* Keep the journal if exact cleanup fails. */
      }
    }
    try {
      fs.unlinkSync(temporary);
      fs.fsyncSync(parent);
    } catch (cleanup) {
      if (cleanup.code !== 'ENOENT')
        throw new AggregateError([error, cleanup], 'receipt cleanup failed');
    }
    throw error;
  } finally {
    if (fd >= 0) fs.closeSync(fd);
    fs.closeSync(parent);
  }
}
function transitionOrder(entries: Entry[]) {
  const rank = (row: any) => (row['entry-type'] === 'file' ? 0 : row.path === '.' ? 2 : 1);
  return [...entries].sort(
    (a, b) =>
      rank(a.row) - rank(b.row) ||
      (a.row['entry-type'] === 'directory'
        ? b.row.path.split('/').length - a.row.path.split('/').length
        : 0) ||
      (a.row.path < b.row.path ? -1 : a.row.path > b.row.path ? 1 : 0),
  );
}
function transition(entries: Entry[], ops: Ops, freeze: boolean) {
  const errors: unknown[] = [];
  for (const { fd, row } of entries)
    try {
      const pre = Number(row['pre-flags']),
        post = Number(row['post-flags']),
        desired = freeze ? post : pre;
      const current = ops.getFlags(fd);
      assert(current === pre || current === post, `inode flags diverged: ${row.path}`);
      if (current !== desired) ops.setFlags(fd, desired);
      assert.equal(ops.getFlags(fd), desired, `flag transition did not stick: ${row.path}`);
    } catch (error) {
      errors.push(error);
    }
  if (errors.length) throw new AggregateError(errors, 'failed to transition inode flags');
}
function receiptEntries(receipt: any, remove = false) {
  assert(Array.isArray(receipt.entries) && receipt.entries.length, 'empty receipt closure');
  let previous = '';
  for (const row of receipt.entries) {
    const fields = [
      'device',
      'direct-loader-kind',
      'entry-type',
      'inode',
      'mode',
      'path',
      'post-flags',
      'pre-flags',
      'sha256',
      'size',
    ];
    if (!remove || 'uid' in row || 'gid' in row) fields.push('uid', 'gid');
    keys(row, fields);
    if (row.path !== '.') safeRelative(row.path);
    assert(
      !previous ||
        (previous === '.' && row.path !== '.') ||
        (previous !== '.' && row.path > previous),
      'receipt paths must be strictly sorted with root first',
    );
    previous = row.path;
    assert(
      ['file', 'directory'].includes(row['entry-type']) &&
        ['none', 'aot'].includes(row['direct-loader-kind']),
      'invalid receipt entry type',
    );
    for (const field of ['device', 'inode', 'size', ...('uid' in row ? ['uid', 'gid'] : [])])
      assert(
        typeof row[field] === 'bigint' && row[field] >= (field === 'inode' ? 1n : 0n),
        `invalid receipt ${field}`,
      );
    if (row['entry-type'] === 'file') {
      requireSha(row.sha256);
      assert(['0444', '0555'].includes(row.mode), 'file mode differs');
    } else
      assert(
        row.sha256 === null && row.mode === '0555' && row['direct-loader-kind'] === 'none',
        'directory identity differs',
      );
    for (const field of ['pre-flags', 'post-flags'])
      assert(/^0x[0-9a-f]{8}$/.test(row[field]), 'invalid flag encoding');
    assert.equal(
      Number(row['post-flags']),
      postFlags(Number(row['pre-flags'])),
      'invalid immutable transition',
    );
  }
  assert(
    receipt.entries[0].path === '.' && receipt.entries[0]['entry-type'] === 'directory',
    'receipt must begin with root',
  );
  const direct = receipt.entries
    .filter((row) => row['direct-loader-kind'] === 'aot')
    .map((row) => row.path);
  assert.deepEqual(receipt['direct-loader-paths'], direct, 'receipt direct-loader subset differs');
  assert.equal(direct.length, expectedCount, 'receipt AOT count differs');
  return receipt.entries;
}
function checkLive(fd: number, row: any, ops: Ops, remove = false) {
  const info = fs.fstatSync(fd, { bigint: true });
  assert.deepEqual(
    [info.dev, info.ino, info.size],
    [row.device, row.inode, row.size],
    `deployment inode identity differs: ${row.path}`,
  );
  assert.equal(mode(info), row.mode, `deployment entry mode differs: ${row.path}`);
  if ('uid' in row)
    assert.deepEqual(
      [info.uid, info.gid],
      [row.uid, row.gid],
      `deployment entry ownership differs: ${row.path}`,
    );
  else assert(remove, 'deployment ownership is not receipt-bound');
  const flags = ops.getFlags(fd);
  assert(
    flags === Number(row['post-flags']) || (remove && flags === Number(row['pre-flags'])),
    `deployment inode flags differ: ${row.path}`,
  );
}
function verifyRoot(receipt: any, path: string, fd: number, expected?: Record<string, string>) {
  const hashes = Object.fromEntries(
    identityNames.map((name, index) => [name, receipt.carrier[identityFields[index]]]),
  );
  for (const hash of Object.values(hashes)) requireSha(hash);
  expectedIdentity(hashes, expected);
  assert.deepEqual(
    receipt.carrier,
    carrierIdentity(path, fs.fstatSync(fd, { bigint: true }), hashes),
    'receipt carrier identity differs',
  );
  assert.deepEqual(
    receipt.filesystem,
    { magic: '0xef53', type: 'ext-family' },
    'receipt filesystem differs',
  );
}
export async function operate(
  action: 'deploy' | 'verify' | 'verify-fast' | 'remove',
  carrier: string,
  receiptPath: string,
  expected?: Record<string, string>,
  ops: Ops = kernelOps(),
  checkCapability = requireCapability,
  owner = 0n,
) {
  if (action === 'deploy' || action === 'remove') checkCapability();
  assert(
    action === 'verify-fast' || expected,
    'full operations require all carrier identity hashes',
  );
  const root = openRoot(carrier);
  let entries: Entry[] = [];
  try {
    assert.equal(
      ops.filesystemMagic(root),
      EXT_MAGIC,
      'carrier root must reside on ext-family filesystem',
    );
    if (action === 'deploy') {
      const { hashes, contents } = identity(root);
      expectedIdentity(hashes, expected);
      entries = closure(root, contents, ops);
      const receipt = {
        carrier: carrierIdentity(carrier, fs.fstatSync(root, { bigint: true }), hashes),
        filesystem: { magic: '0xef53', type: 'ext-family' },
        ...provenance(contents['manifest.json']),
        'direct-loader-paths': ordered(entries)
          .filter((entry) => entry.row['direct-loader-kind'] === 'aot')
          .map((entry) => entry.row.path),
        entries: ordered(entries).map((entry) => entry.row),
        policy: POLICY,
        schema: SCHEMA,
      };
      const journal = await writeReceipt(
        receiptPath,
        carrier,
        Buffer.from(`${canonicalJson(receipt)}\n`),
        ops,
        owner,
      );
      try {
        transition(transitionOrder(entries), ops, true);
        assert.deepEqual(
          identity(root).hashes,
          hashes,
          'carrier identity changed during deployment',
        );
      } catch (error) {
        transition(transitionOrder(entries).reverse(), ops, false);
        unlinkReceipt(receiptPath, journal.info, journal.hash, ops);
        throw error;
      }
      return receipt;
    }
    const loaded = readReceipt(receiptPath, carrier, ops, owner, action !== 'remove'),
      receipt = loaded.receipt;
    verifyRoot(receipt, carrier, root, expected);
    const rows = receiptEntries(receipt, action === 'remove');
    if (action === 'verify-fast') {
      for (const row of rows) {
        const fd = openBeneath(root, row.path, row['entry-type'] === 'directory');
        entries.push({ fd, row });
        checkLive(fd, row, ops);
      }
      return receipt;
    }
    const { hashes, contents } = identity(root);
    expectedIdentity(hashes, expected);
    assert.deepEqual(
      receipt.carrier,
      carrierIdentity(carrier, fs.fstatSync(root, { bigint: true }), hashes),
      'receipt carrier hashes differ',
    );
    const guest = provenance(contents['manifest.json']);
    assert(
      receipt.core_profile === guest.core_profile &&
        receipt.guest_build_recipe_sha256 === guest.guest_build_recipe_sha256,
      'receipt provenance differs',
    );
    entries = closure(root, contents, ops);
    const sorted = ordered(entries);
    assert.deepEqual(
      sorted.map((entry) => entry.row.path),
      rows.map((row) => row.path),
      'receipt carrier closure differs',
    );
    for (let index = 0; index < rows.length; index++) {
      const entry = sorted[index],
        row = rows[index];
      checkLive(entry.fd, row, ops, action === 'remove');
      for (const key of ['sha256', 'entry-type', 'direct-loader-kind'])
        assert.equal(entry.row[key], row[key], `receipt ${key} differs`);
      entry.row = row;
    }
    if (action === 'remove') {
      try {
        transition(transitionOrder(entries).reverse(), ops, false);
      } catch (error) {
        transition(transitionOrder(entries), ops, true);
        throw error;
      }
      unlinkReceipt(receiptPath, loaded.info, loaded.hash, ops);
    }
    return receipt;
  } finally {
    closeAll(entries);
    fs.closeSync(root);
  }
}
if (import.meta.main) {
  try {
    const actions = ['deploy', 'verify', 'verify-fast', 'remove'] as const;
    const options = Object.fromEntries([
      ...actions.map((action) => [action, { type: 'boolean' }]),
      ...['carrier', 'receipt', ...identityFields].map((name) => [name, { type: 'string' }]),
    ]);
    const { values } = parseArgs({ options });
    const selected = actions.filter((action) => values[action]);
    assert(
      selected.length === 1 && values.carrier && values.receipt,
      'select exactly one operation with --carrier and --receipt',
    );
    const hashes = identityFields.map((field) => values[field]);
    assert(
      hashes.every(Boolean) ||
        (selected[0] === 'verify-fast' && hashes.every((value) => value === undefined)),
      'identity hashes must be all present or all absent',
    );
    await operate(
      selected[0],
      values.carrier,
      values.receipt,
      hashes.every(Boolean)
        ? Object.fromEntries(identityNames.map((name, i) => [name, hashes[i]]))
        : undefined,
    );
    console.log(`${selected[0]} immutable sealed carrier closure: ${values.carrier}`);
  } catch (error) {
    console.error('immutable carrier deployment failed:', error);
    process.exitCode = 2;
  }
}
