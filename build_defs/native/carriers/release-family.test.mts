import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { validateChecksumManifest } from '../../../tools/release/checksum-manifest.mts';

/** Qualify the actual assembled family using the publication reader's checksum contract. */
export function checkReleaseChecksumFamily(
  expected: { product: string; checksum: string; archives: string[] },
  files: string[],
) {
  assert(expected.archives.length, 'release family requires canonical public archives');
  assert.equal(new Set(expected.archives).size, expected.archives.length);
  assert(!expected.archives.includes(expected.checksum), 'checksum cannot include itself');
  assert.deepEqual(
    files.map((file) => path.basename(file)).sort(),
    [...expected.archives, expected.checksum].sort(),
    `${expected.product} release family must contain exactly its canonical public Files`,
  );
  const checksum = files.find((file) => path.basename(file) === expected.checksum);
  assert(checksum);
  validateChecksumManifest(
    checksum,
    files.filter((file) => file !== checksum),
    `${expected.product}/${expected.checksum}`,
  );
}

if (import.meta.main) {
  const [specification, ...files] = process.argv.slice(2);
  assert(specification, 'release checksum test requires its declared family specification');
  checkReleaseChecksumFamily(JSON.parse(readFileSync(specification, 'utf8')), files);
}
