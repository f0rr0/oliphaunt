import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { copyNativeInputFile, fileIdentity } from './native-file-identity.mts';

test('bounded identities preserve empty, small and multi-chunk bytes without oversized read buffers', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'oliphaunt-native-file-'));
  const originalAllocate = Buffer.allocUnsafe;
  try {
    for (const size of [
      0,
      17,
      8192,
      1024 * 1024 - 1,
      1024 * 1024,
      1024 * 1024 + 1,
      2 * 1024 * 1024 + 19,
    ]) {
      const bytes = Buffer.alloc(size, 0x5a);
      const source = path.join(root, `source-${size}`);
      const destination = path.join(root, `copy-${size}`);
      writeFileSync(source, bytes, { mode: 0o600 });
      const capacities: number[] = [];
      Buffer.allocUnsafe = (capacity: number) => {
        capacities.push(capacity);
        return originalAllocate(capacity);
      };
      const identity = fileIdentity(source);
      const copy = fileIdentity(source, destination);
      Buffer.allocUnsafe = originalAllocate;
      assert.deepEqual(copy, identity);
      assert.deepEqual(readFileSync(destination), bytes);
      assert.equal(identity.mode, lstatSync(source).mode & 0o777);
      assert.equal(identity.size, size);
      assert.equal(identity.sha256, createHash('sha256').update(bytes).digest('hex'));
      assert.ok(capacities.length > 0);
      assert.ok(capacities.every((capacity) => capacity > 0 && capacity <= 1024 * 1024));
      if (size < 1024 * 1024)
        assert.ok(
          capacities.every((capacity) => capacity <= Math.max(1, size)),
          'a tiny File must not allocate a MiB read buffer',
        );
    }
  } finally {
    Buffer.allocUnsafe = originalAllocate;
    rmSync(root, { recursive: true, force: true });
  }
});

test('declared repository aliases copy exact regular bytes through the bounded reader', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'oliphaunt-native-input-'));
  try {
    const source = path.join(root, 'source');
    mkdirSync(source);
    const bytes = Buffer.alloc(2 * 1024 * 1024 + 19, 0x5a);
    writeFileSync(path.join(source, 'payload.bin'), bytes);
    const execution = path.join(root, 'execution');
    mkdirSync(execution);
    symlinkSync(
      source,
      path.join(execution, 'external'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const output = path.join(root, 'private', 'payload.bin');
    const identity = copyNativeInputFile(execution, 'external/payload.bin', output);
    assert.equal(identity.sha256, createHash('sha256').update(bytes).digest('hex'));
    assert.equal(identity.size, bytes.length);
    assert.deepEqual(readFileSync(output), bytes);
    assert.throws(() =>
      copyNativeInputFile(execution, '../source/payload.bin', path.join(root, 'escape')),
    );
    assert.throws(() => copyNativeInputFile(execution, 'external', path.join(root, 'directory')));
    assert.throws(() => copyNativeInputFile(execution, 'external/payload.bin', output), /EEXIST/);
    const alias = path.join(root, 'aliased-output');
    symlinkSync(source, alias, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(
      () => copyNativeInputFile(execution, 'external/payload.bin', path.join(alias, 'overwritten')),
      /symlink|regular directory/u,
    );
    assert.deepEqual(readFileSync(path.join(source, 'payload.bin')), bytes);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
