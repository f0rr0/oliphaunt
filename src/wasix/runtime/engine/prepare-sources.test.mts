import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { applyEnginePatches } from './prepare-sources.mts';

test('ordered Git patches apply inside an ignored directory of the enclosing worktree', (t) => {
  const root = path.resolve(import.meta.dir, '../../../..');
  mkdirSync(path.join(root, 'target'), { recursive: true });
  const scratch = mkdtempSync(path.join(root, 'target/engine-patch-test-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const source = path.join(scratch, 'source');
  mkdirSync(source);
  writeFileSync(path.join(source, 'value.txt'), 'original\n');
  const patches = [
    ['original', 'first'],
    ['first', 'second'],
  ].map(([before, after], index) => {
    const file = path.join(scratch, `${index}.patch`);
    writeFileSync(
      file,
      `diff --git a/value.txt b/value.txt\n--- a/value.txt\n+++ b/value.txt\n@@ -1 +1 @@\n-${before}\n+${after}\n`,
    );
    return file;
  });
  applyEnginePatches(source, patches);
  assert.equal(readFileSync(path.join(source, 'value.txt'), 'utf8'), 'second\n');
});
