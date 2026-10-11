import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

// One declared archiver operation combines the maintained cc_library outputs.
const [specPath, archiver, output] = process.argv.slice(2);
assert(
  specPath && archiver && output && process.argv.length === 5,
  'Expected archive specification, llvm-ar and output',
);
const archives = JSON.parse(readFileSync(specPath, 'utf8')) as string[];
assert(
  archives.length && new Set(archives).size === archives.length,
  'Empty or duplicate libc archives',
);
for (const path of [...archives, output])
  assert(/^[A-Za-z0-9_./+@=-]+$/.test(path), 'Invalid MRI archive path');
mkdirSync(dirname(output), { recursive: true });
const input = `CREATE ${output}\n${archives
  .toReversed()
  .map((path) => `ADDLIB ${path}\n`)
  .join('')}SAVE\nEND\n`;
const archiverProcess = Bun.spawn([archiver, '-M'], {
  stdin: new Blob([input]),
  stdout: 'inherit',
  stderr: 'inherit',
  env: { ...globalThis.process.env, LC_ALL: 'C' },
});
assert.equal(await archiverProcess.exited, 0, 'Native patched libc archiving failed');
