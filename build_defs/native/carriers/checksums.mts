import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
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
          `${createHash('sha256').update(readFileSync(file)).digest('hex')}  ./${name}\n`,
      )
      .join(''),
  );
}

/** Join independently constructed archives into the canonical product directory. */
export function assembleNativeReleaseAssets(spec: {
  expected: string[];
  files: string[];
  copies: string[];
  output: string;
}): void {
  const destinations = spec.copies.map((file) => path.basename(file)).sort();
  assert.deepEqual(destinations, [...spec.expected].sort(), 'release asset destinations differ');
  assert.equal(
    new Set([...spec.copies, spec.output].map((file) => path.resolve(path.dirname(file)))).size,
    1,
    'release assets and checksum must share one directory',
  );
  assert.equal(path.basename(path.dirname(spec.output)), 'release-assets');
  const sources = new Map(spec.files.map((file) => [path.basename(file), file]));
  assert.equal(sources.size, spec.files.length, 'release assets repeat a source name');
  assert.deepEqual(
    [...sources.keys()].sort(),
    destinations,
    'release asset source inventory differs',
  );
  assert(!sources.has(path.basename(spec.output)), 'checksum must not include itself');
  const copies = spec.copies.map((destination) => {
    const declared = sources.get(path.basename(destination));
    assert(declared, 'release asset source is missing');
    // Bazel projects declared input Files as sandbox links. Resolve only the
    // supplied leaf; assembled public outputs are regular copied files.
    const source = realpathSync(declared);
    assert(statSync(source).isFile(), 'release asset input must resolve to a regular file');
    assert.notEqual(
      path.resolve(source),
      path.resolve(destination),
      'release asset source is its destination',
    );
    return { source, destination };
  });
  mkdirSync(path.dirname(spec.output), { recursive: true });
  for (const { source, destination } of copies) {
    copyFileSync(source, destination);
    chmodSync(destination, 0o644);
  }
  writeNativeChecksums({ expected: spec.expected, files: spec.copies, output: spec.output });
}
if (import.meta.main) {
  assert.equal(process.argv.length, 3, 'usage: checksums.mts <declared-inputs.json>');
  const spec = JSON.parse(readFileSync(process.argv[2], 'utf8'));
  if (spec.copies !== undefined) assembleNativeReleaseAssets(spec);
  else writeNativeChecksums(spec);
}
