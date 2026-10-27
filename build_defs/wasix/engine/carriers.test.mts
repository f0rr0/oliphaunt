import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  assembleWindowsEnginePackages,
  ENGINE_DLL_PACKAGE,
  ENGINE_SOURCE_PACKAGES,
  type EnginePackageInputs,
  engineDeliveryManifests,
} from '../../../src/wasix/runtime/engine/package.mts';
import { renderCargoToml } from '../../../tools/packaging/cargo-manifest.mts';
import { createDeterministicTar } from '../../../tools/packaging/package-archive.mts';
import {
  canonicalGzipSync,
  extractPortableArchiveTree,
} from '../../../tools/packaging/portable-archive.mts';
import type { NativeCurrentArtifact } from '../../../tools/release/native-extension-final-inputs.mts';
import {
  type EngineCarrierInputs,
  selectEngineCarrierInputs,
  stageEngineCarrierInputs,
} from './carriers.mts';

const version = '0.3.4';
const source = { commit: 'a'.repeat(40), tree: 'b'.repeat(40) };
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

function fixture(t) {
  const root = mkdtempSync(path.join(process.env.TEST_TMPDIR ?? tmpdir(), 'engine-import-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  function file(relative: string, content: string | Uint8Array) {
    const destination = path.join(root, relative);
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, content);
    return destination;
  }
  const sources = {} as EnginePackageInputs['sources'];
  for (const original of Object.keys(ENGINE_SOURCE_PACKAGES)) {
    sources[original] = path.join(root, original);
    file(
      `${original}/Cargo.toml`,
      renderCargoToml({
        package: { name: original, version: original === 'wasmer' ? '7.5.0' : '0.705.0' },
        dependencies:
          original === 'wasmer' ? {} : { engine: { package: 'wasmer', version: '=7.5.0' } },
        features: original === 'wasmer' ? { v8: ['dep:tempfile'], std: [] } : {},
        ...(original === 'wasmer'
          ? { 'build-dependencies': { tempfile: { version: '3.6.0', optional: true } } }
          : {}),
      }),
    );
    file(`${original}/src/lib.rs`, `// upstream ${original}\n`);
  }
  const dll = Buffer.from(Array.from({ length: 8192 }, (_, index) => (index * 73) % 251));
  const packaged = assembleWindowsEnginePackages({
    version,
    sources,
    sdkManifestFile: file(
      'sdk/Cargo.toml',
      `[package]\nname="oliphaunt-wasix"\nversion="${version}"\n`,
    ),
    dllFile: file('engine.dll', dll),
    embeddedBindingsFile: file(
      'bindings.rs',
      `const CACHE: &str = "Oliphaunt/engines/${digest(dll)}/oliphaunt_wee8.dll";\n`,
    ),
    buildScriptTemplate: file('build.rs.tpl', 'fn main() {}\n'),
    noticesFile: file('notices.txt', 'Applicable license texts fixture\n'),
    outputDirectory: path.join(root, 'packages'),
  });
  // The publication catalog declares the facade; its two part identities are derived there.
  const catalog = [...Object.values(ENGINE_SOURCE_PACKAGES), ENGINE_DLL_PACKAGE].map((name) => ({
    ecosystem: 'cargo',
    product: 'oliphaunt-wasix-rust',
    version,
    name,
    role: name === ENGINE_DLL_PACKAGE ? 'platform-leaf' : 'facade',
    target: name === ENGINE_DLL_PACKAGE ? 'windows-x64-msvc' : null,
  }));
  const records: NativeCurrentArtifact[] = packaged.map(({ name, archive }, index) => {
    const bytes = readFileSync(archive);
    return {
      product: 'oliphaunt-wasix-rust',
      version,
      artifact: `cargo:${name}`,
      configuration: Object.hasOwn(ENGINE_SOURCE_PACKAGES, name.slice('oliphaunt-'.length))
        ? 'portable'
        : 'windows-x64-msvc',
      source: { ...source },
      file: {
        path: archive,
        size: bytes.length,
        sha256: digest(bytes),
        producer: {
          evidenceDigest: 'c'.repeat(64),
          invocationId: 'producer-123',
          configuration: 'windows-x64-msvc',
          root: `//shipping:original_${index}`,
          output: `engine/${name}-${version}.crate`,
        },
      },
    };
  });
  const inputs: EngineCarrierInputs = {
    version,
    source,
    catalog,
    records,
    archives: Object.fromEntries(packaged.map(({ name, archive }) => [name, archive])),
    outputDirectory: path.join(root, 'imported'),
  };
  return { root, inputs };
}

function rewriteArchive(
  inputs: EngineCarrierInputs,
  name: string,
  directory: string,
  edit: (directory: string) => void,
) {
  const rewritten = structuredClone(inputs);
  const sourceDirectory = path.join(directory, 'source');
  extractPortableArchiveTree(inputs.archives[name], sourceDirectory, `${name}-${version}`);
  edit(sourceDirectory);
  const archive = path.join(directory, `${name}-${version}.crate`);
  writeFileSync(
    archive,
    canonicalGzipSync(
      createDeterministicTar(sourceDirectory, `${name}-${version}`, { fixedFileMode: 0o644 }),
    ),
  );
  rewritten.archives[name] = archive;
  const row = rewritten.records.find((record) => record.artifact === `cargo:${name}`);
  assert(row);
  const bytes = readFileSync(archive);
  row.file.size = bytes.length;
  row.file.sha256 = digest(bytes);
  rewritten.outputDirectory = path.join(directory, 'imported');
  return rewritten;
}

test('absent engine carriers need no source or archive access', () => {
  assert.deepEqual(
    stageEngineCarrierInputs({
      version,
      records: [],
      catalog: [],
      archives: {},
      outputDirectory: '/must-not-be-used',
    }),
    { available: false, files: {}, archiveGroups: {} },
  );
});

test('imports all seven exact archives and real member Files, preserving distinct original roots', (t) => {
  const { root, inputs } = fixture(t);
  const originals = structuredClone(inputs.records);
  const api = ENGINE_SOURCE_PACKAGES.wasmer;
  const alias = path.join(root, 'metadata-file-alias.crate');
  symlinkSync(inputs.archives[api], alias);
  inputs.archives[api] = alias;
  const result = stageEngineCarrierInputs(inputs);
  assert.equal(result.available, true);
  assert.equal(Object.keys(result.archiveGroups).length, 7);
  assert.deepEqual(Object.keys(result.files).sort(), [
    'bindings',
    'facade_rs',
    'part001_payload',
    'part001_rs',
    'part002_payload',
    'part002_rs',
  ]);
  for (const members of Object.values(result.files)) {
    assert.equal(members.length, 1);
    assert.ok(readFileSync(path.join(inputs.outputDirectory, members[0])).length);
  }
  assert.equal(existsSync(path.join(inputs.outputDirectory, 'cargo-config.toml')), false);
  assert.equal(existsSync(path.join(inputs.outputDirectory, 'oliphaunt_wee8.dll')), false);
  assert.deepEqual(inputs.records, originals);
});

test('each partial or duplicate carrier set fails before touching any archive', (t) => {
  const { inputs } = fixture(t);
  for (const record of inputs.records) {
    const remaining = inputs.records.filter((row) => row !== record);
    assert.throws(
      () => selectEngineCarrierInputs({ ...inputs, records: remaining }),
      /all seven original Cargo carriers/,
    );
    assert.throws(
      () => selectEngineCarrierInputs({ ...inputs, records: [...remaining, remaining[0]] }),
      /unique and complete/,
    );
  }
});

test('mixed owner, version, source, target, producer cohort, or nested transport is rejected', (t) => {
  const { inputs } = fixture(t);
  const cases: [(row: NativeCurrentArtifact) => void, RegExp][] = [
    [
      (row) => {
        row.product = 'other';
      },
      /different owner/,
    ],
    [
      (row) => {
        row.version = '0.3.5';
      },
      /different owner version/,
    ],
    [
      (row) => {
        row.source.commit = 'd'.repeat(40);
      },
      /source differs/,
    ],
    [
      (row) => {
        row.source.tree = 'd'.repeat(40);
      },
      /source differs/,
    ],
    [
      (row) => {
        row.configuration = 'linux-x64-gnu';
      },
      /target differs/,
    ],
    [
      (row) => {
        row.file.producer.evidenceDigest = 'd'.repeat(64);
      },
      /producer cohorts/,
    ],
    [
      (row) => {
        row.file.producer.invocationId = 'other-run';
      },
      /producer cohorts/,
    ],
    [
      (row) => {
        row.file.producer.configuration = 'linux-x64-gnu';
      },
      /producer cohorts/,
    ],
    [
      (row) => {
        row.file.member = 'inner.crate';
      },
      /whole original Cargo Files/,
    ],
  ];
  for (const [mutate, error] of cases) {
    const changed = structuredClone(inputs);
    mutate(changed.records[1]);
    assert.throws(() => selectEngineCarrierInputs(changed), error);
  }
  assert.throws(
    () => selectEngineCarrierInputs({ ...inputs, source: undefined }),
    /exact current source/,
  );
  const wrongCatalog = structuredClone(inputs);
  wrongCatalog.catalog[0].version = '0.3.5';
  assert.throws(() => selectEngineCarrierInputs(wrongCatalog), /catalog version differs/);
});

test('original archive size, SHA and Cargo identity are checked against its record', (t) => {
  const { root, inputs } = fixture(t);
  const size = structuredClone(inputs);
  size.records[0].file.size += 1;
  assert.throws(() => stageEngineCarrierInputs(size), /File size differs/);
  const sha = structuredClone(inputs);
  sha.records[0].file.sha256 = '0'.repeat(64);
  assert.throws(() => stageEngineCarrierInputs(sha), /frozen Cargo input differs/);
  const name = ENGINE_SOURCE_PACKAGES.wasmer;
  const identity = rewriteArchive(inputs, name, path.join(root, 'identity'), (directory) => {
    const file = path.join(directory, 'Cargo.toml');
    const manifest = Bun.TOML.parse(readFileSync(file, 'utf8'));
    manifest.package.name = 'wrong';
    writeFileSync(file, renderCargoToml(manifest));
  });
  assert.throws(() => stageEngineCarrierInputs(identity), /Cargo identity differs/u);
});

test('coherent physical archives still cannot hide incompatible manifests, bindings or payloads', (t) => {
  const { root, inputs } = fixture(t);
  const api = ENGINE_SOURCE_PACKAGES.wasmer;
  const child = ENGINE_SOURCE_PACKAGES['wasmer-wasix'];
  const parts = Object.keys(engineDeliveryManifests(version))
    .filter((name) => name !== ENGINE_DLL_PACKAGE)
    .sort();
  const editManifest = (edit: (manifest: any) => void) => (directory: string) => {
    const file = path.join(directory, 'Cargo.toml');
    const manifest = Bun.TOML.parse(readFileSync(file, 'utf8'));
    edit(manifest);
    writeFileSync(file, renderCargoToml(manifest));
  };
  const cases: [string, string, (directory: string) => void, RegExp][] = [
    [
      'upstream-family',
      child,
      editManifest((manifest) => {
        manifest.dependencies.engine.package = 'wasmer';
      }),
      /still uses its upstream identity/,
    ],
    [
      'family-version',
      child,
      editManifest((manifest) => {
        manifest.dependencies.engine.version = '=0.3.3';
      }),
      /source-family dependency version differs/,
    ],
    [
      'facade-version',
      ENGINE_DLL_PACKAGE,
      editManifest((manifest) => {
        manifest.dependencies[parts[0]] = '=0.3.3';
      }),
      /delivery Cargo dependencies differ/,
    ],
    [
      'api-facade',
      api,
      editManifest((manifest) => {
        manifest['build-dependencies'][ENGINE_DLL_PACKAGE].version = '=0.3.3';
      }),
      /API facade dependency differs/,
    ],
    [
      'api-feature',
      api,
      editManifest((manifest) => {
        manifest.features.v8 = [];
      }),
      /does not activate its facade/,
    ],
    [
      'bindings-hash',
      api,
      (directory) => {
        writeFileSync(
          path.join(directory, 'prebuilt/embedded_bindings.rs'),
          `"Oliphaunt/engines/${'0'.repeat(64)}/oliphaunt_wee8.dll"`,
        );
      },
      /payload differs from the API binding identity/,
    ],
    [
      'bindings-missing',
      api,
      (directory) => {
        writeFileSync(
          path.join(directory, 'prebuilt/embedded_bindings.rs'),
          '// no engine identity',
        );
      },
      /unique generated cache identity/,
    ],
    [
      'payload-corrupt',
      parts[0],
      (directory) => {
        const file = path.join(directory, 'payload/dll.gz.part');
        const bytes = readFileSync(file);
        bytes[0] ^= 0xff;
        writeFileSync(file, bytes);
      },
      /gzip/iu,
    ],
    [
      'payload-truncated',
      parts[1],
      (directory) => {
        const file = path.join(directory, 'payload/dll.gz.part');
        writeFileSync(file, readFileSync(file).subarray(0, -4));
      },
      /gzip/iu,
    ],
  ];
  for (const [scenario, name, edit, error] of cases) {
    const changed = rewriteArchive(inputs, name, path.join(root, scenario), edit);
    assert.throws(() => stageEngineCarrierInputs(changed), error, scenario);
  }
});
