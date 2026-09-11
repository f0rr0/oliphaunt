import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const parent = process.env.OLIPHAUNT_WASIX_PACKAGING_TEST_ROOT;
if (!parent) throw new Error('Run bash runtimes/liboliphaunt-wasix/tools/test-packaging.sh');
const root = path.join(parent, 'npm-runtime');
const descriptor = (await import(pathToFileURL(path.join(root, 'package/index.js')).href)).default;
assert.equal(descriptor.product, 'liboliphaunt-wasix');
assert.equal(descriptor.runtime, 'wasix');
assert(Object.isFrozen(descriptor));
for (const asset of [descriptor.runtimeArchive, descriptor.manifest])
  assert(Object.isFrozen(asset));
assert.deepEqual(
  readFileSync(descriptor.runtimeArchive.source),
  readFileSync(
    path.join(root, 'release-stage/target/oliphaunt-wasix/assets/oliphaunt.wasix.tar.zst'),
  ),
);
assert.deepEqual(
  readFileSync(descriptor.manifest.source),
  readFileSync(path.join(root, 'release-stage/target/oliphaunt-wasix/assets/manifest.json')),
);
