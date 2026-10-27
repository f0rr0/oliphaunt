import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { gunzipSync } from 'node:zlib';
import { renderCargoToml } from '../../../../tools/packaging/cargo-manifest.mts';
import { CARGO_PACKAGE_SIZE_LIMIT_BYTES } from '../../../../tools/packaging/cargo-source-package.mts';
import { listArchiveEntries } from '../../../../tools/packaging/package-archive.mts';
import { readPortableArchiveEntries } from '../../../../tools/packaging/portable-archive.mts';
import {
  assembleWindowsEnginePackages,
  ENGINE_DLL_PACKAGE,
  ENGINE_SOURCE_PACKAGES,
  type EnginePackageInputs,
  engineDeliveryManifests,
  normalizeEngineManifest,
} from './package.mts';

const version = '0.3.4';
function fixture(t): EnginePackageInputs {
  const root = mkdtempSync(
    path.join(process.env.TEST_TMPDIR ?? tmpdir(), 'windows-engine-package-'),
  );
  t.after(() => rmSync(root, { recursive: true, force: true }));
  function file(relative: string, content: string | Uint8Array) {
    const target = path.join(root, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
    return target;
  }
  const sources = {} as EnginePackageInputs['sources'];
  for (const original of Object.keys(ENGINE_SOURCE_PACKAGES)) {
    const upstreamVersion = original === 'wasmer' ? '7.5.0' : '0.705.0';
    sources[original] = path.join(root, original);
    file(
      `${original}/Cargo.toml`,
      renderCargoToml({
        package: { name: original, version: upstreamVersion, license: 'MIT', publish: false },
        lib: { name: original.replaceAll('-', '_'), path: 'src/lib.rs' },
        dependencies:
          original === 'wasmer'
            ? {}
            : {
                runtime: { package: 'wasmer', version: '=7.5.0', 'default-features': false },
              },
        features: original === 'wasmer' ? { v8: ['std', 'dep:ureq', 'dep:tempfile'], std: [] } : {},
        ...(original === 'wasmer'
          ? {
              'build-dependencies': {
                ureq: { version: '3.4.2', optional: true },
                tempfile: { version: '3.6.0', optional: true },
              },
            }
          : {}),
      }),
    );
    file(`${original}/src/lib.rs`, `// ${original} patched source\npub const VALUE: u32 = 42;\n`);
    file(`${original}/LICENSE`, `Genuine upstream ${original} license fixture\n`);
    file(`${original}/Cargo.toml.orig`, 'unpublished upstream development manifest');
    file(`${original}/Cargo.lock`, 'upstream lockfile');
  }
  return {
    version,
    sdkManifestFile: file(
      'sdk/Cargo.toml',
      `[package]\nname = "oliphaunt-wasix"\nversion = "${version}"\n`,
    ),
    sources,
    dllFile: file('engine.dll', randomBytes(128 * 1024)),
    embeddedBindingsFile: file('bindings.rs', 'pub const EMBEDDED_ABI: u32 = 1;\n'),
    buildScriptTemplate: file('build.rs.tpl', 'fn main() { /* declared facade delivery */ }\n'),
    noticesFile: file('licenses.txt', 'Complete applicable upstream license fixture\n'),
    outputDirectory: path.join(root, 'output'),
  };
}

function manifestOf(archive: string) {
  const entries = readPortableArchiveEntries(archive);
  const manifestEntry = [...entries].find(([name]) => name.endsWith('/Cargo.toml'));
  assert.ok(manifestEntry);
  return { entries, manifest: Bun.TOML.parse(manifestEntry[1].data().toString()) };
}

test('normalization changes only the four family registry identities and keeps aliases and feature wiring', () => {
  const source = renderCargoToml({
    package: {
      name: 'wasmer-wasix',
      version: '0.705.0',
      publish: false,
      metadata: { existing: { value: 42 } },
    },
    dependencies: {
      engine: {
        package: 'wasmer',
        version: '=7.5.0',
        path: '../api',
        optional: true,
        'default-features': false,
        features: ['v8'],
      },
      'wasmer-journal': '0.705.0',
      'wasmer-types': { version: '=7.5.0', 'default-features': false },
      serde: { version: '1.0', git: 'https://example.invalid/serde', rev: 'immutable' },
    },
    target: {
      'cfg(windows)': {
        'build-dependencies': {
          abi: { package: 'wasmer-wasix-types', version: '0.705.0', path: '../types' },
        },
        'dev-dependencies': { wasmer: { version: '=7.5.0', features: ['wat'] } },
      },
    },
    features: { v8: ['dep:engine', 'engine/v8', 'engine?/wat', 'wasmer-journal/log-file'] },
    patch: { 'crates-io': { wasmer: { path: '../private-patch' } } },
    workspace: { members: ['development-only'] },
  });
  const actual = Bun.TOML.parse(normalizeEngineManifest(source, { version }));
  assert.equal(actual.package.name, 'oliphaunt-wasmer-wasix');
  assert.equal(actual.package.version, version);
  assert.equal(actual.package.publish, undefined);
  assert.equal(actual.lib.name, 'wasmer_wasix');
  assert.deepEqual(actual.package.metadata.existing, { value: 42 });
  assert.deepEqual(actual.package.metadata.oliphaunt.upstream, {
    package: 'wasmer-wasix',
    version: '0.705.0',
  });
  assert.deepEqual(actual.dependencies.engine, {
    package: 'oliphaunt-wasmer',
    version: `=${version}`,
    optional: true,
    'default-features': false,
    features: ['v8'],
  });
  assert.deepEqual(actual.dependencies['wasmer-journal'], {
    package: 'oliphaunt-wasmer-journal',
    version: `=${version}`,
  });
  assert.deepEqual(actual.dependencies['wasmer-types'], {
    version: '=7.5.0',
    'default-features': false,
  });
  assert.deepEqual(actual.dependencies.serde, { version: '1.0' });
  assert.deepEqual(actual.target['cfg(windows)']['build-dependencies'].abi, {
    package: 'oliphaunt-wasmer-wasix-types',
    version: `=${version}`,
  });
  assert.deepEqual(actual.target['cfg(windows)']['dev-dependencies'].wasmer, {
    package: 'oliphaunt-wasmer',
    version: `=${version}`,
    features: ['wat'],
  });
  assert.deepEqual(actual.features.v8, [
    'dep:engine',
    'engine/v8',
    'engine?/wat',
    'wasmer-journal/log-file',
  ]);
  assert.equal(actual.patch, undefined);
  assert.deepEqual(actual.workspace, {});
});

test('the API retains the V8 runtime tempfile requirement and only its optional exact facade at build time', () => {
  const source = renderCargoToml({
    package: { name: 'wasmer', version: '7.5.0', build: 'old/build.rs' },
    dependencies: { 'wasm-types-polyfill': { version: '1', optional: true } },
    'build-dependencies': {
      ureq: { version: '3.4.2', optional: true },
      cmake: '0.1.50',
      tempfile: { version: '3.6.0', optional: true },
    },
    target: { 'cfg(windows)': { 'build-dependencies': { bindgen: '0.72.1' } } },
    features: {
      v8: ['std', 'dep:ureq', 'dep:tempfile', 'wasm-types-polyfill'],
      std: [],
      other: ['cmake'],
    },
  });
  const actual = Bun.TOML.parse(
    normalizeEngineManifest(source, { version, facadeVersion: '0.0.0' }),
  );
  assert.equal(actual.lib.name, 'wasmer');
  assert.equal(actual.package.build, 'build.rs');
  assert.deepEqual(actual['build-dependencies'], {
    [ENGINE_DLL_PACKAGE]: { version: '=0.0.0', optional: true },
  });
  assert.equal(actual.target['cfg(windows)']['build-dependencies'], undefined);
  assert.deepEqual(actual.dependencies.tempfile, { version: '3.6.0', optional: true });
  assert.deepEqual(actual.features.v8, [
    'std',
    'dep:tempfile',
    'wasm-types-polyfill',
    `dep:${ENGINE_DLL_PACKAGE}`,
  ]);
  assert.deepEqual(actual.features.other, []);
  assert.throws(
    () => normalizeEngineManifest('[package]\nname="other"\nversion="1.0.0"', { version }),
    /official Wasmer/,
  );
  assert.throws(
    () => normalizeEngineManifest(source, { version: 'invalid' }),
    /Invalid engine package version/,
  );
  assert.throws(
    () =>
      normalizeEngineManifest(
        '[package]\nname="wasmer-wasix"\nversion="0.705.0"\n[dependencies]\nprivate={git="https://example.invalid/private"}',
        { version },
      ),
    /Unversioned public Cargo dependency private/,
  );
});

test('seven deterministic archives have exact coherent versions and reconstruct every DLL byte without API payload duplication', (t) => {
  const inputs = fixture(t);
  const first = assembleWindowsEnginePackages(inputs);
  const second = assembleWindowsEnginePackages({
    ...inputs,
    outputDirectory: `${inputs.outputDirectory}-again`,
  });
  assert.equal(first.length, 7);
  assert.deepEqual(
    first.map(({ name }) => name).sort(),
    [
      ...Object.values(ENGINE_SOURCE_PACKAGES),
      ENGINE_DLL_PACKAGE,
      `${ENGINE_DLL_PACKAGE}-part-001`,
      `${ENGINE_DLL_PACKAGE}-part-002`,
    ].sort(),
  );
  const chunks = [];
  const deliveryManifests = engineDeliveryManifests(version);
  assert.equal(Object.keys(deliveryManifests).length, 3);
  for (const [index, packaged] of first.entries()) {
    assert.deepEqual(readFileSync(packaged.archive), readFileSync(second[index].archive));
    assert.ok(readFileSync(packaged.archive).length <= CARGO_PACKAGE_SIZE_LIMIT_BYTES);
    const { entries, manifest } = manifestOf(packaged.archive);
    const prefix = `${packaged.name}-${version}/`;
    assert.equal(manifest.package.name, packaged.name);
    assert.equal(manifest.package.version, version);
    if (Object.hasOwn(deliveryManifests, packaged.name)) {
      assert.deepEqual(manifest, deliveryManifests[packaged.name]);
      assert.equal(manifest.package['rust-version'], '1.96');
      const retainedRoot = path.join(inputs.outputDirectory, 'delivery', packaged.name);
      assert.deepEqual(
        readFileSync(path.join(retainedRoot, 'src/lib.rs')),
        entries.get(`${prefix}src/lib.rs`).data(),
      );
      if (packaged.name.includes('-part-'))
        assert.deepEqual(
          readFileSync(path.join(retainedRoot, 'payload/dll.gz.part')),
          entries.get(`${prefix}payload/dll.gz.part`).data(),
        );
    }
    assert.deepEqual(manifest.workspace, {});
    assert.equal(
      entries.get(`${prefix}THIRD_PARTY_NOTICES.md`).data().toString(),
      readFileSync(inputs.noticesFile, 'utf8'),
    );
    for (const section of ['dependencies', 'build-dependencies']) {
      for (const [alias, dependency] of Object.entries(manifest[section] ?? {})) {
        const value =
          typeof dependency === 'string' ? { version: dependency } : (dependency as any);
        if ((value.package ?? alias).startsWith('oliphaunt-'))
          assert.equal(value.version, `=${version}`);
      }
    }
    assert.equal(entries.has(`${prefix}Cargo.toml.orig`), false);
    assert.equal(entries.has(`${prefix}Cargo.lock`), false);
    if (packaged.name === 'oliphaunt-wasmer') {
      assert.deepEqual(manifest.dependencies.tempfile, { version: '3.6.0', optional: true });
      assert.ok(manifest.features.v8.includes('dep:tempfile'));
      assert.equal(
        entries.get(`${prefix}build.rs`).data().toString(),
        readFileSync(inputs.buildScriptTemplate, 'utf8'),
      );
      assert.equal(
        entries.get(`${prefix}prebuilt/embedded_bindings.rs`).data().toString(),
        readFileSync(inputs.embeddedBindingsFile, 'utf8'),
      );
      assert.equal(
        entries.get(`${prefix}LICENSE`).data().toString(),
        'Genuine upstream wasmer license fixture\n',
      );
      assert.ok(
        [...entries.keys()].every((name) => !name.endsWith('.dll') && !name.includes('dll.gz')),
      );
    }
    if (packaged.name.includes('-part-'))
      chunks.push(entries.get(`${prefix}payload/dll.gz.part`).data());
    if (packaged.name === ENGINE_DLL_PACKAGE) {
      assert.equal(manifest.package['license-file'], 'THIRD_PARTY_NOTICES.md');
      assert.match(entries.get(`${prefix}src/lib.rs`).data().toString(), /pub fn write_dll/u);
      assert.ok([...entries.keys()].every((name) => !name.includes('/payload/')));
    }
  }
  const compressed = Buffer.concat(chunks);
  const deliveryRoot = path.join(inputs.outputDirectory, 'delivery');
  assert.deepEqual(
    listArchiveEntries(deliveryRoot)
      .filter((file) => statSync(file).isFile())
      .map((file) => path.relative(deliveryRoot, file).split(path.sep).join('/'))
      .sort(),
    Object.keys(deliveryManifests)
      .flatMap((name) => [
        `${name}/src/lib.rs`,
        ...(name.includes('-part-') ? [`${name}/payload/dll.gz.part`] : []),
      ])
      .sort(),
  );
  assert.equal(compressed.subarray(0, 10).toString('hex'), '1f8b0800000000000003');
  assert.deepEqual(gunzipSync(compressed), readFileSync(inputs.dllFile));
  assert.equal(
    readFileSync(path.join(inputs.sources.wasmer, 'Cargo.toml.orig'), 'utf8'),
    'unpublished upstream development manifest',
  );
});

test('a payload exceeding the two actual crates.io envelopes fails rather than truncating or inventing more packages', (t) => {
  const inputs = fixture(t);
  writeFileSync(inputs.dllFile, randomBytes(21 * 1024 * 1024));
  assert.throws(
    () => assembleWindowsEnginePackages(inputs),
    /above the crates.io 10 MiB package limit/,
  );
});

test('explicit source and license inputs cannot silently select the wrong package or duplicate the DLL', (t) => {
  const inputs = fixture(t);
  assert.throws(
    () => assembleWindowsEnginePackages({ ...inputs, version: '0.3.5' }),
    /must match its actual oliphaunt-wasix SDK manifest/,
  );
  assert.throws(
    () =>
      assembleWindowsEnginePackages({
        ...inputs,
        sources: { ...inputs.sources, wasmer: inputs.sources['wasmer-wasix'] },
      }),
    /source directory for wasmer contains a different package/,
  );
  const notices = readFileSync(inputs.noticesFile);
  writeFileSync(inputs.noticesFile, '');
  assert.throws(() => assembleWindowsEnginePackages(inputs), /complete applicable license texts/);
  writeFileSync(inputs.noticesFile, notices);
  writeFileSync(path.join(inputs.sources.wasmer, 'stale.dll'), 'old payload');
  assert.throws(
    () => assembleWindowsEnginePackages(inputs),
    /must not contain raw engine DLL bytes/,
  );
});
