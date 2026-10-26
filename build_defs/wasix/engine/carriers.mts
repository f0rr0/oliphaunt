/** Import existing authenticated Cargo Files; producer authentication stays with the controller. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  ENGINE_DLL_PACKAGE,
  ENGINE_SOURCE_PACKAGES,
  engineDeliveryManifests,
} from '../../../src/wasix/runtime/engine/package.mts';
import { stageCargoCarrierInputs } from '../../../tools/packaging/frozen-cargo.mts';
import {
  DEFAULT_PORTABLE_ARCHIVE_LIMITS,
  strictGunzip,
} from '../../../tools/packaging/portable-archive.mts';
import type { NativeCurrentArtifact } from '../../../tools/release/native-extension-final-inputs.mts';
import { resolveActualCarrier } from '../../../tools/release/publication-catalog.mts';

const owner = 'oliphaunt-wasix-rust';
type Source = { commit: string; tree: string };
export interface EngineCarrierInputs {
  version: string;
  source?: Source;
  records: NativeCurrentArtifact[];
  catalog: Record<string, any>[];
  archives: Record<string, string>;
  outputDirectory: string;
}

export function selectEngineCarrierInputs(
  inputs: Pick<EngineCarrierInputs, 'version' | 'source' | 'records' | 'catalog'>,
) {
  const delivery = engineDeliveryManifests(inputs.version);
  const names = [...Object.values(ENGINE_SOURCE_PACKAGES), ...Object.keys(delivery)].sort();
  const selected = inputs.records.filter(
    (row) => names.includes(row.artifact?.slice(6)) && row.artifact.startsWith('cargo:'),
  );
  if (selected.length === 0) return [];
  assert.equal(
    selected.length,
    names.length,
    'Windows engine requires all seven original Cargo carriers',
  );
  assert.deepEqual(
    selected.map((row) => row.artifact.slice(6)).sort(),
    names,
    'Windows engine Cargo carriers must be unique and complete',
  );
  for (const value of [inputs.source?.commit, inputs.source?.tree])
    assert.match(
      value ?? '',
      /^[a-f0-9]{40}$/u,
      'Windows engine imports require the exact current source',
    );
  const catalog = {
    carriers: inputs.catalog.map((row) => ({
      ...row,
      id: `${row.ecosystem}:${row.name}`,
      declared: true,
    })),
  };
  const cohort = (row: NativeCurrentArtifact) => ({
    evidenceDigest: row.file.producer.evidenceDigest,
    invocationId: row.file.producer.invocationId,
    configuration: row.file.producer.configuration,
  });
  for (const row of selected) {
    const name = row.artifact.slice(6);
    const carrier = resolveActualCarrier(catalog, 'cargo', name, 'Windows engine import');
    assert.equal(carrier.product, owner, 'Windows engine carrier has a different declared owner');
    assert.equal(row.product, owner, 'Windows engine original belongs to a different owner');
    assert.equal(
      row.version,
      inputs.version,
      'Windows engine original has a different owner version',
    );
    assert.equal(carrier.version, inputs.version, 'Windows engine catalog version differs');
    assert.equal(
      row.configuration,
      carrier.target ?? 'portable',
      'Windows engine original target differs',
    );
    assert.deepEqual(row.source, inputs.source, 'Windows engine original source differs');
    assert.equal(row.file.member, undefined, 'Windows engine needs whole original Cargo Files');
    assert.deepEqual(
      cohort(row),
      cohort(selected[0]),
      'Windows engine originals mix producer cohorts',
    );
  }
  return selected.sort((left, right) => (left.artifact < right.artifact ? -1 : 1));
}

function assertFamilyDependencies(manifest: Record<string, any>, version: string) {
  const family = new Set<string>(Object.values(ENGINE_SOURCE_PACKAGES));
  const upstream = new Set(Object.keys(ENGINE_SOURCE_PACKAGES));
  for (const table of [manifest, ...Object.values(manifest.target ?? {})] as Record<
    string,
    any
  >[]) {
    for (const section of ['dependencies', 'build-dependencies', 'dev-dependencies']) {
      for (const [alias, declaration] of Object.entries(table[section] ?? {})) {
        const dependency =
          typeof declaration === 'string'
            ? { version: declaration }
            : (declaration as Record<string, any>);
        const identity = dependency.package ?? alias;
        assert(
          !upstream.has(identity),
          'Windows engine source-family dependency still uses its upstream identity',
        );
        if (family.has(identity))
          assert.equal(
            dependency.version,
            `=${version}`,
            'Windows engine source-family dependency version differs',
          );
      }
    }
  }
}

export function stageEngineCarrierInputs(inputs: EngineCarrierInputs) {
  const records = selectEngineCarrierInputs(inputs);
  if (!records.length) return { available: false, files: {}, archiveGroups: {} };
  const files = records.map((record) => {
    const name = record.artifact.slice(6);
    const file = realpathSync(inputs.archives[name]);
    assert.equal(
      statSync(file).size,
      record.file.size,
      'Windows engine original File size differs',
    );
    return { file, name, version: inputs.version, sha256: record.file.sha256 };
  });
  // Reuse authenticated Cargo extraction; its patch configuration is not a resolver input here.
  const unusedConfig = stageCargoCarrierInputs(files, inputs.outputDirectory);
  rmSync(unusedConfig);
  const crateDirectory = (name: string) => path.join('crates', `${name}-${inputs.version}`);
  const read = (name: string, file: string) =>
    readFileSync(path.join(inputs.outputDirectory, crateDirectory(name), file));
  const delivery = engineDeliveryManifests(inputs.version);
  for (const { name } of files) {
    const manifest = Bun.TOML.parse(read(name, 'Cargo.toml').toString()) as Record<string, any>;
    assertFamilyDependencies(manifest, inputs.version);
    if (Object.hasOwn(delivery, name))
      assert.deepEqual(
        manifest,
        delivery[name],
        'Windows engine delivery Cargo dependencies differ',
      );
  }
  const api = ENGINE_SOURCE_PACKAGES.wasmer;
  const apiManifest = Bun.TOML.parse(read(api, 'Cargo.toml').toString()) as Record<string, any>;
  assert.deepEqual(
    apiManifest['build-dependencies']?.[ENGINE_DLL_PACKAGE],
    { version: `=${inputs.version}`, optional: true },
    'Windows engine API facade dependency differs',
  );
  assert(
    apiManifest.features?.v8?.includes(`dep:${ENGINE_DLL_PACKAGE}`),
    'Windows engine API V8 feature does not activate its facade',
  );
  const binding = path.join(crateDirectory(api), 'prebuilt/embedded_bindings.rs');
  const bindings = readFileSync(path.join(inputs.outputDirectory, binding), 'utf8');
  const digests = [
    ...bindings.matchAll(/Oliphaunt\/engines\/([a-f0-9]{64})\/oliphaunt_wee8\.dll/gu),
  ];
  assert.equal(
    digests.length,
    1,
    'Windows engine API must contain its unique generated cache identity',
  );
  const parts = Object.keys(delivery)
    .filter((name) => name !== ENGINE_DLL_PACKAGE)
    .sort();
  const compressed = Buffer.concat(parts.map((name) => read(name, 'payload/dll.gz.part')));
  const dll = strictGunzip(
    compressed,
    'Windows engine payload',
    DEFAULT_PORTABLE_ARCHIVE_LIMITS.maxEntryBytes,
  );
  assert.equal(
    createHash('sha256').update(dll).digest('hex'),
    digests[0][1],
    'Windows engine payload differs from the API binding identity',
  );
  const groups: Record<string, string[]> = { bindings: [binding] };
  for (const name of Object.keys(delivery)) {
    const stem = name === ENGINE_DLL_PACKAGE ? 'facade' : `part${name.slice(-3)}`;
    groups[`${stem}_rs`] = [path.join(crateDirectory(name), 'src/lib.rs')];
    if (name !== ENGINE_DLL_PACKAGE)
      groups[`${stem}_payload`] = [path.join(crateDirectory(name), 'payload/dll.gz.part')];
  }
  const archiveGroups = Object.fromEntries([
    ...Object.entries(ENGINE_SOURCE_PACKAGES).map(([original, name]) => [
      name,
      original.replaceAll('-', '_'),
    ]),
    ...Object.keys(delivery).map((name) => [name, 'facade']),
  ]);
  return { available: true, files: groups, archiveGroups };
}

if (import.meta.main) {
  const [specification] = process.argv.slice(2);
  assert(specification, 'usage: carriers.mts SPEC.json');
  console.log(
    JSON.stringify(stageEngineCarrierInputs(JSON.parse(readFileSync(specification, 'utf8')))),
  );
}
