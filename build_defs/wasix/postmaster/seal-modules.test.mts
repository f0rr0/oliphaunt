import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { modulePlan } from './seal-modules.mts';

const manifest = readFileSync(
  new URL(
    '../../../src/wasix/postmaster/wasmer/policies/sealed-side-modules.v1.tsv',
    import.meta.url,
  ),
  'utf8',
);
const paths = manifest
  .split('\n')
  .filter((line) => line && !line.startsWith('#'))
  .map((line) => line.split('\t')[0]);
const inputs = paths.map((path) => `declared/${basename(path)}`);

test('actual canonical side policy preserves paths and aliases independent of File order', () => {
  const plan = modulePlan(manifest, [...inputs].reverse());
  assert.deepEqual(
    plan.map((row) => row.path),
    paths,
  );
  for (const row of plan) assert.equal(basename(row.input), basename(row.path));
  assert.equal(plan.length, 27);
  assert.deepEqual(plan[0].aliases, manifest.split('\n')[2].split('\t')[1].split(','));
});

test('rejects omitted, extra and duplicate declared side inputs', () => {
  assert.throws(() => modulePlan(manifest, inputs.slice(1)), /missing declared/u);
  assert.throws(
    () => modulePlan(manifest, [...inputs, 'foreign/unknown.so']),
    /absent from canonical/u,
  );
  assert.throws(
    () => modulePlan(manifest, [...inputs, `foreign/${basename(inputs[0])}`]),
    /duplicate side input/u,
  );
});

test('rejects duplicate or escaping policy paths and aliases', () => {
  const first = manifest.split('\n')[2];
  assert.throws(() => modulePlan(`${manifest}${first}\n`, inputs), /duplicate side path/u);
  assert.throws(
    () =>
      modulePlan(manifest.replace(first, first.replace('lib/libpq.so,', '../escape.so,')), inputs),
    /unsafe receipt path/u,
  );
  assert.throws(
    () =>
      modulePlan(manifest.replace(first, first.replace('lib/libpq.so,', '/escape.so,')), inputs),
    /unsafe receipt path/u,
  );
  assert.throws(
    () =>
      modulePlan(
        manifest.replace(first, first.replace('lib/libpq.so,', 'lib/libpq.so.5.18,')),
        inputs,
      ),
    /duplicate side path/u,
  );
});
