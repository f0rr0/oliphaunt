/** Test-only receipt identity; the bound package bytes are actual Bazel leaves. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { writeJson } from './native_carriers.mts';
import { finalFileInventory } from './owner_carriers.mts';

const spec = JSON.parse(readFileSync(process.argv[2], 'utf8'));
assert.equal(spec.qualificationFixture.schema, 'oliphaunt-final-file-receipt-fixture-v1');
assert.equal(spec.qualificationFixture.testOnly, true);
writeJson(spec.output, {
  schema: 'oliphaunt-extension-final-files-v1',
  scope: 'construction',
  product: spec.leaf.product,
  owner: spec.leaf.owner,
  version: spec.leaf.version,
  target: spec.leaf.target,
  source: spec.source,
  files: finalFileInventory(spec.leaf),
});
