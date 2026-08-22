import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';

import { validateAndroidLinkEvidence } from './validate-android-link-evidence.mjs';

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test('accepts exact current Android link evidence and rejects stale selections', () => {
  const fixture = makeFixture();
  expect(() => validateAndroidLinkEvidence(fixture.args)).not.toThrow();
  expect(() =>
    validateAndroidLinkEvidence({ ...fixture.args, expectedModuleStems: 'vector,pg_ivm' }),
  ).toThrow(/missing=pg_ivm/);
  expect(() => validateAndroidLinkEvidence({ ...fixture.args, expectedModuleStems: '' })).toThrow(
    /unexpected=vector/,
  );
});

test('rejects stale ABI, archive paths, duplicates, and missing dependencies', () => {
  const abi = makeFixture();
  expect(() => validateAndroidLinkEvidence({ ...abi.args, expectedAbi: 'x86_64' })).toThrow(
    /expected abi\tx86_64/,
  );

  const archive = makeFixture();
  writeFileSync(archive.evidence, archive.text.replace('vector.a', 'wrong.a'));
  expect(() => validateAndroidLinkEvidence(archive.args)).toThrow(/path does not exist/);

  const duplicate = makeFixture();
  writeFileSync(duplicate.evidence, `${duplicate.text}extension\tvector\t${duplicate.vector}\n`);
  expect(() => validateAndroidLinkEvidence(duplicate.args)).toThrow(/duplicate extension/);

  const dependency = makeFixture();
  writeFileSync(dependency.evidence, dependency.text.replace(/^dependency.*\n/mu, ''));
  expect(() => validateAndroidLinkEvidence(dependency.args)).toThrow(/missing=cxx/);
});

function makeFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'oliphaunt-link-evidence-'));
  roots.push(root);
  const archives = path.join(root, 'archives', 'android-arm64-v8a');
  mkdirSync(archives, { recursive: true });
  const runtime = path.join(root, 'liboliphaunt.so');
  const vector = path.join(archives, 'liboliphaunt_extension_vector.a');
  const dependency = path.join(archives, 'libcxx.a');
  for (const file of [runtime, vector, dependency]) writeFileSync(file, file);
  const registry = path.join(root, 'manifest.properties');
  writeFileSync(
    registry,
    [
      'dependencyArchives=cxx',
      'module.vector.archive.android-arm64-v8a=archives/android-arm64-v8a/liboliphaunt_extension_vector.a',
      'dependency.cxx.archive.android-arm64-v8a=archives/android-arm64-v8a/libcxx.a',
      '',
    ].join('\n'),
  );
  const evidence = path.join(root, 'evidence.tsv');
  const text = [
    'schema\toliphaunt-android-static-extension-link-v1',
    'abi\tarm64-v8a',
    `runtime\tliboliphaunt\t${runtime}`,
    `extension\tvector\t${vector}`,
    `dependency\tcxx\t${dependency}`,
    '',
  ].join('\n');
  writeFileSync(evidence, text);
  return {
    args: {
      evidenceFile: evidence,
      expectedAbi: 'arm64-v8a',
      expectedModuleStems: 'vector',
      staticRegistryManifest: registry,
      target: 'android-arm64-v8a',
    },
    evidence,
    text,
    vector,
  };
}
