/** Authenticate a declared supplier File, including Bazel's outer File aliases. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';

export type FileIdentity = { size: number; sha256: string };

export function verifyCapturedFile(file: string, identity: FileIdentity) {
  const physical = realpathSync(file);
  const stat = lstatSync(physical);
  assert(stat.isFile(), 'Captured supplier File must resolve to a regular File');
  assert.equal(stat.size, identity.size, 'Captured supplier File size differs');
  assert.equal(
    createHash('sha256').update(readFileSync(physical)).digest('hex'),
    identity.sha256,
    'Captured supplier File SHA differs',
  );
  return physical;
}
