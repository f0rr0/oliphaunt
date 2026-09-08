import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  statSync,
  existsSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { zipArchive } from '../test/zip-fixture.mts';
import { extractPinnedZip } from './extract-pinned-zip.mts';

const root = mkdtempSync(path.join(tmpdir(), 'pinned-zip-'));
const tool = {
  name: 'tool/bin/tool',
  data: '#!/bin/sh\necho ok\n',
  externalAttributes: 0o100755 << 16,
};
const archive = path.join(root, 'tool.zip');
const destination = path.join(root, 'out');
function extract(bytes, count = 1) {
  writeFileSync(archive, bytes);
  extractPinnedZip([
    '--archive',
    archive,
    '--destination',
    destination,
    '--prefix',
    'tool',
    '--entry-count',
    String(count),
    '--required',
    tool.name,
    '--executable',
    tool.name,
  ]);
}
try {
  const valid = zipArchive([tool]);
  extract(valid);
  assert.equal(readFileSync(path.join(destination, tool.name), 'utf8'), tool.data);
  if (process.platform !== 'win32')
    assert.equal(statSync(path.join(destination, tool.name)).mode & 0o777, 0o755);
  // A rejected destination belongs to its caller; preserve it even on failure.
  assert.throws(() => extract(valid));
  assert.equal(readFileSync(path.join(destination, tool.name), 'utf8'), tool.data);
  rmSync(destination, { recursive: true });
  for (const [bytes, count] of [
    [zipArchive([{ ...tool, name: 'tool/../escape' }]), 1],
    [zipArchive([{ ...tool, externalAttributes: 0o120777 << 16 }]), 1],
    [zipArchive([tool, tool]), 2],
    [zipArchive([tool, { ...tool, name: 'tool/bin/Tool' }]), 2],
    [zipArchive([{ ...tool, declaredSize: 150_000_001 }]), 1],
    [valid.subarray(0, -7), 1],
    [zipArchive([{ ...tool, name: 'other/bin/tool' }]), 1],
    [valid, 2],
  ]) {
    assert.throws(() => extract(bytes, count));
    assert.equal(existsSync(destination), false, 'failed extraction left a partial destination');
  }
  console.log('pinned ZIP adversarial tests passed');
} finally {
  rmSync(root, { recursive: true, force: true });
}
