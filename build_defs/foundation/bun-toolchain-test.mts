/** Exercise the selected executable, independently of its declared platform. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const [expectedPlatform, expectedDigest] = process.argv.slice(2);
const os = process.platform === 'win32' ? 'windows' : process.platform;
const arch = process.arch === 'arm64' ? 'aarch64' : process.arch;
assert.equal(`${os}-${arch}`, expectedPlatform);
assert.equal(
  createHash('sha256').update(readFileSync(process.execPath)).digest('hex'),
  expectedDigest,
);
