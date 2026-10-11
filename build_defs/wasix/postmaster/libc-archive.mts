import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

// Canonical Makefile-eh archive packaging over already compiled native objects.
// Its sorted crs batches intentionally replace basename collisions.
const [specPath, archiver, output] = process.argv.slice(2);
assert(
  specPath && archiver && output && process.argv.length === 5,
  'Expected object specification, llvm-ar and output',
);
const records = JSON.parse(readFileSync(specPath, 'utf8')) as { source: string; path: string }[];
assert(
  records.length && new Set(records.map((row) => row.source)).size === records.length,
  'Empty or duplicate libc object sources',
);
const staging = mkdtempSync(join(tmpdir(), 'postmaster-libc-archive-'));
try {
  const objects = records
    .sort((a, b) => (a.source < b.source ? -1 : a.source > b.source ? 1 : 0))
    .map((row) => {
      assert(
        /^[A-Za-z0-9_./-]+\.[cs]$/.test(row.source) &&
          !row.source.split('/').some((part) => !part || part === '.' || part === '..'),
        'Invalid libc object source',
      );
      const path = join(staging, `${row.source.slice(0, -2)}.o`);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, readFileSync(row.path));
      return path;
    });
  mkdirSync(dirname(output), { recursive: true });
  const destination = resolve(output);
  for (const [start, end] of [
    [0, 199],
    [199, 399],
    [399, 599],
    [599, 799],
    [799, objects.length],
  ]) {
    if (start >= objects.length) continue;
    const child = Bun.spawn([archiver, 'crs', destination, ...objects.slice(start, end)], {
      stdout: 'inherit',
      stderr: 'inherit',
      env: { ...process.env, LC_ALL: 'C' },
    });
    assert.equal(await child.exited, 0, 'Native patched libc archiving failed');
  }
} finally {
  rmSync(staging, { recursive: true, force: true });
}
