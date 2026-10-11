import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { copyNativeInputFile } from './native-file-identity.mts';

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
