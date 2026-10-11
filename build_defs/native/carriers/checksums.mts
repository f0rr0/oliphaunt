import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** Product-wide assembly requires exactly the canonical assets supplied by its caller. */
export function writeNativeChecksums({
  expected,
  files,
  output,
}: {
  expected: string[];
  files: string[];
  output: string;
}): void {
  assert(
    expected.length && new Set(expected).size === expected.length,
    'checksum asset names must be unique',
  );
  const observed = files
    .map((file) => ({ name: path.basename(file), file }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  assert.deepEqual(
    observed.map(({ name }) => name),
    [...expected].sort(),
    'product checksum assembly is missing or repeats canonical assets',
  );
  mkdirSync(path.dirname(output), { recursive: true });
  writeFileSync(
    output,
    observed
      .map(
        ({ name, file }) =>
          `${createHash('sha256').update(readFileSync(file)).digest('hex')}  ${name}\n`,
      )
      .join(''),
  );
}
if (import.meta.main) {
  assert.equal(process.argv.length, 3, 'usage: checksums.mts <declared-inputs.json>');
  writeNativeChecksums(JSON.parse(readFileSync(process.argv[2], 'utf8')));
}
