import assert from 'node:assert/strict';
import path from 'node:path';
import {
  AOT_PACKAGES,
  RUNTIME_PACKAGE,
} from '../../src/wasix/runtime/tools/wasix-cargo-artifact-contract.mts';
import { readPortableArchiveEntries } from './portable-archive.mts';

/** Read one parent and exactly the payload parts declared by its actual Cargo manifest. */
export function readRuntimeCargoFamily(archives: readonly string[], target: string | null) {
  const parentName = target === null ? RUNTIME_PACKAGE : AOT_PACKAGES[target];
  assert(parentName, 'Unknown WASIX Cargo family target');
  const records = archives.map((file) => {
    const entries = readPortableArchiveEntries(file);
    const manifests = [...entries.values()].filter(
      (e) => e.isFile && /^[^/]+\/Cargo\.toml$/u.test(e.name),
    );
    assert.equal(manifests.length, 1, 'Cargo family archive must have one root manifest');
    const manifest = Bun.TOML.parse(manifests[0].data().toString());
    const { name, version } = manifest.package;
    assert(
      !Object.hasOwn(manifest.package.metadata?.oliphaunt ?? {}, 'qualificationOnly'),
      'Cargo family must not contain qualification-only archives',
    );
    const root = `${name}-${version}`;
    assert(
      [...entries.values()].every(
        (entry) => (entry.name === root && entry.isDirectory) || entry.name.startsWith(`${root}/`),
      ),
      'Cargo family archive has a noncanonical package root',
    );
    assert.equal(
      path.basename(file),
      `${name}-${version}.crate`,
      'Cargo family archive filename differs',
    );
    return { file, entries, manifest, name, version };
  });
  assert.equal(
    new Set(records.map((row) => row.name)).size,
    records.length,
    'Cargo family repeats an archive',
  );
  const parent = records.filter((row) => row.name === parentName);
  assert.equal(parent.length, 1, 'Cargo family must have its unique canonical parent');
  const manifest = parent[0].manifest;
  const parts = records
    .filter((row) => row.name !== parentName)
    .sort((a, b) => a.name.localeCompare(b.name, 'en'));
  const dependencies = Object.keys(manifest['build-dependencies'] ?? {})
    .filter((name) => name.startsWith(`${parentName}-part-`))
    .sort();
  assert.deepEqual(
    parts.map((row) => row.name),
    dependencies,
    'Cargo family must contain exactly the parent payload parts',
  );
  for (const [index, part] of parts.entries()) {
    assert.equal(
      part.name,
      `${parentName}-part-${String(index + 1).padStart(3, '0')}`,
      'Cargo family parts must be contiguous',
    );
    assert.equal(part.version, parent[0].version, 'Cargo family part version differs');
    assert.deepEqual(
      manifest['build-dependencies'][part.name],
      { version: `=${part.version}` },
      'Cargo parent must pin each exact part version',
    );
  }
  return { parent: parent[0], parts };
}
