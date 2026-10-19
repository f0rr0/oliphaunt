import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { canonicalJson, EXT_MAGIC, IMMUTABLE, openBeneath, operate } from './immutable-carrier.mts';

const sha = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
function fixture() {
  const directory = fs.mkdtempSync(join(tmpdir(), 'immutable-carrier-')),
    carrier = join(directory, 'carrier'),
    receipt = join(directory, 'deployment.json');
  fs.mkdirSync(join(carrier, 'aot'), { recursive: true });
  fs.mkdirSync(join(carrier, 'bin'));
  const files = new Map<string, string>();
  const artifacts = Array.from({ length: 29 }, (_, index) => {
    const path = `aot/${(index + 1).toString(16).toUpperCase().padStart(64, '0')}.bin`,
      data = `artifact-${index}\n`;
    files.set(path, data);
    return { path, sha256: sha(data) };
  });
  files.set(
    'manifest.json',
    `${canonicalJson({
      artifacts,
      'core-profile': 'release-o3',
      'format-version': 6,
      'guest-build-recipe-sha256': '9'.repeat(64),
      schema: 'oliphaunt.wasix-postmaster.sealed-aot.v5',
    })}\n`,
  );
  files.set('wasmer-build.receipt', 'schema=fake\n');
  files.set('bin/wasmer-headless', 'fake-headless\n');
  files.set(
    'payload.files',
    [
      'schema=oliphaunt.wasix-postmaster.payload-files.v1',
      ...[...files]
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([path, data]) => `${sha(data)}\t${Buffer.byteLength(data)}\t${path}`),
      '',
    ].join('\n'),
  );
  for (const [path, data] of files) fs.writeFileSync(join(carrier, path), data, { mode: 0o444 });
  for (const path of ['aot', 'bin', '.']) fs.chmodSync(join(carrier, path), 0o555);
  const expected = Object.fromEntries(
    ['manifest.json', 'wasmer-build.receipt', 'payload.files', 'bin/wasmer-headless'].map(
      (path) => [path, sha(files.get(path)!)],
    ),
  );
  const flags = new Map<string, number>();
  let calls = 0,
    failAt = -1;
  const key = (fd: number) => {
    const info = fs.fstatSync(fd, { bigint: true });
    return `${info.dev}:${info.ino}`;
  };
  const ops = {
    filesystemMagic: () => EXT_MAGIC,
    getFlags(fd: number) {
      const k = key(fd);
      if (!flags.has(k)) flags.set(k, 0x80000);
      return flags.get(k)!;
    },
    setFlags(fd: number, value: number) {
      if (++calls === failAt) throw Error('injected transition failure');
      flags.set(key(fd), value);
    },
  };
  return {
    directory,
    carrier,
    receipt,
    expected,
    flags,
    ops,
    failNext(offset: number) {
      failAt = calls + offset;
    },
    run: (action: Parameters<typeof operate>[0], fast = false) =>
      operate(
        action,
        carrier,
        receipt,
        fast ? undefined : expected,
        ops,
        () => {},
        BigInt(process.geteuid!()),
      ),
    rewrite(value: unknown) {
      fs.chmodSync(receipt, 0o644);
      fs.writeFileSync(receipt, `${canonicalJson(value)}\n`);
      fs.chmodSync(receipt, 0o444);
    },
    cleanup() {
      for (const path of ['aot', 'bin', '.']) fs.chmodSync(join(carrier, path), 0o755);
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

test('immutable deployment retains exact receipts, fast verification and removal', {
  skip: process.platform !== 'linux',
}, async () => {
  const f = fixture();
  try {
    const receipt = await f.run('deploy');
    assert.equal(fs.readFileSync(f.receipt, 'utf8'), `${canonicalJson(receipt)}\n`);
    assert.equal(receipt['direct-loader-paths'].length, 29);
    assert([...f.flags.values()].every((flags) => flags & IMMUTABLE));
    assert.deepEqual(await f.run('verify'), receipt);
    // Fast verification checks inode metadata; the full verification must detect changed payload bytes.
    const file = join(f.carrier, receipt['direct-loader-paths'][0]);
    const data = fs.readFileSync(file);
    fs.chmodSync(file, 0o644);
    fs.writeFileSync(file, Buffer.alloc(data.length, 65));
    fs.chmodSync(file, 0o444);
    assert.deepEqual(await f.run('verify-fast', true), receipt);
    await assert.rejects(f.run('verify'), /payload differs/);
    fs.chmodSync(file, 0o644);
    fs.writeFileSync(file, data);
    fs.chmodSync(file, 0o444);
    await f.run('remove');
    assert(!fs.existsSync(f.receipt));
    assert([...f.flags.values()].every((flags) => flags === 0x80000));
  } finally {
    f.cleanup();
  }
});

test('immutable transition failures restore exact flags and retain recoverable journals', {
  skip: process.platform !== 'linux',
}, async () => {
  const f = fixture();
  try {
    f.failNext(4);
    await assert.rejects(f.run('deploy'), /transition/);
    assert(!fs.existsSync(f.receipt));
    assert([...f.flags.values()].every((flags) => flags === 0x80000));
    const receipt = await f.run('deploy');
    f.failNext(3);
    await assert.rejects(f.run('remove'), /transition/);
    assert.deepEqual(await f.run('verify-fast'), receipt);
    const first = receipt.entries[0];
    f.flags.set(`${first.device}:${first.inode}`, Number(first['pre-flags']));
    const receiptInfo = fs.statSync(f.receipt, { bigint: true });
    f.flags.set(`${receiptInfo.dev}:${receiptInfo.ino}`, 0x80000);
    // Recovery accepts journals predating ownership fields, but normal verification never does.
    for (const entry of receipt.entries) {
      delete entry.uid;
      delete entry.gid;
    }
    f.rewrite(receipt);
    await assert.rejects(f.run('verify-fast'));
    await f.run('remove');
    assert(!fs.existsSync(f.receipt));
    assert([...f.flags.values()].every((flags) => flags === 0x80000));
  } finally {
    f.cleanup();
  }
});

test('immutable verification rejects changed ownership and same-byte replacement inodes', {
  skip: process.platform !== 'linux',
}, async () => {
  const f = fixture();
  try {
    const receipt = await f.run('deploy');
    receipt.entries[0].uid += 1n;
    f.rewrite(receipt);
    await assert.rejects(f.run('verify-fast'), /ownership differs/);
    receipt.entries[0].uid -= 1n;
    f.rewrite(receipt);
    const file = join(f.carrier, receipt['direct-loader-paths'][0]);
    fs.chmodSync(join(f.carrier, 'aot'), 0o755);
    fs.writeFileSync(`${file}.replacement`, fs.readFileSync(file), { mode: 0o444 });
    fs.renameSync(`${file}.replacement`, file);
    fs.chmodSync(join(f.carrier, 'aot'), 0o555);
    await assert.rejects(f.run('verify'), /inode identity differs/);
  } finally {
    f.cleanup();
  }
});

test('open descriptor traversal survives parent replacement and rejects symlinks', {
  skip: process.platform !== 'linux',
}, () => {
  const parent = fs.mkdtempSync(join(tmpdir(), 'immutable-descriptor-'));
  let root = -1;
  try {
    fs.mkdirSync(join(parent, 'root'));
    fs.writeFileSync(join(parent, 'root', 'file'), 'original');
    root = fs.openSync(join(parent, 'root'), fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
    fs.renameSync(join(parent, 'root'), join(parent, 'moved'));
    fs.mkdirSync(join(parent, 'root'));
    fs.writeFileSync(join(parent, 'root', 'file'), 'replacement');
    const fd = openBeneath(root, 'file');
    try {
      assert.equal(fs.readFileSync(fd, 'utf8'), 'original');
    } finally {
      fs.closeSync(fd);
    }
    fs.symlinkSync('/etc/passwd', join(parent, 'moved', 'link'));
    assert.throws(() => openBeneath(root, 'link'));
    assert.throws(() => openBeneath(root, '../file'));
    assert.equal(
      canonicalJson({ inode: 18446744073709551615n, unicode: 'é' }),
      '{"inode":18446744073709551615,"unicode":"\\u00e9"}',
    );
  } finally {
    if (root >= 0) fs.closeSync(root);
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test('native immutable binding queries exact descriptors and enforces privileges', {
  skip: !process.env.OLIPHAUNT_IMMUTABLE_KERNEL,
}, async () => {
  const { kernelOps, requireCapability } = await import('./immutable-carrier.mts');
  const directory = fs.mkdtempSync(join(tmpdir(), 'immutable-kernel-'));
  const fd = fs.openSync(join(directory, 'file'), 'wx');
  try {
    const ops = kernelOps(),
      flags = ops.getFlags(fd);
    assert.equal(ops.filesystemMagic(fd), EXT_MAGIC);
    ops.setFlags(fd, flags);
    assert.equal(ops.getFlags(fd), flags);
    assert.throws(() => ops.getFlags(-1));
    if (process.geteuid!() !== 0) {
      assert.throws(requireCapability, /effective UID 0/);
      assert.throws(() => ops.setFlags(fd, flags | IMMUTABLE));
    }
  } finally {
    fs.closeSync(fd);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
