import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));

test('strict series applies inside an enclosing checkout and rejects stale context', {
  skip: process.platform === 'win32',
}, () => {
  // The source must be inside the real checkout to reproduce Git discovery.
  const fixture = mkdtempSync(path.join(root, '.patch-series-test-'));
  try {
    const source = path.join(fixture, 'source');
    mkdirSync(source);
    writeFileSync(path.join(source, 'probe'), 'before\n');
    const patch = path.join(fixture, 'change.patch');
    writeFileSync(
      patch,
      'diff --git a/probe b/probe\n--- a/probe\n+++ b/probe\n@@ -1 +1 @@\n-before\n+after\n',
    );
    const series = path.join(fixture, 'series');
    writeFileSync(series, `${path.relative(root, patch)}\n`);
    const apply = () =>
      spawnSync(
        'bash',
        [path.join(root, 'src/third-party/postgres/apply-series.sh'), source, series],
        { encoding: 'utf8' },
      );
    const first = apply();
    assert.equal(first.status, 0, first.stderr);
    assert.equal(readFileSync(path.join(source, 'probe'), 'utf8'), 'after\n');
    assert.notEqual(apply().status, 0, 'reapplying stale context must fail');
    assert.equal(readFileSync(path.join(source, 'probe'), 'utf8'), 'after\n');
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
