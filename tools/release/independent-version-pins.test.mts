import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'bun:test';

import {
  compatibilityVersionEntries,
  compatibilityVersionValue,
  loadProducts,
  productCompatibilityVersion,
  ROOT,
} from './release-graph.mts';
import {
  prepareSourceOnlyNpmPackage,
  SOURCE_ONLY_NPM_PROFILES,
} from '../packaging/source-only-sdk-package.mts';
import { packagedCargoManifestText } from '../packaging/cargo-source-package.mts';
import { renderReleaseCargoToml } from '../../src/native/sdks/rust/tools/prepare-rust-release-source.mts';
import { renderOliphauntWasixReleaseCargoToml } from '../../src/wasix/sdks/rust/tools/prepare-rust-release-source.mts';
import { prepareWasixTypescriptPackage } from '../../src/wasix/sdks/ts/tools/package.mts';
import { assertWasixTypescriptManifest } from '../../src/wasix/sdks/ts/tools/wasix-typescript-package.mts';
import {
  workspaceCarrierManifest,
  workspaceRuntimeVersion,
} from '../../src/wasix/node-addon/tools/workspace-runtime-contract.mts';
import { assertWasixNapiCarrierManifest } from '../../src/wasix/node-addon/tools/check-release-assets.mts';
import { requireMatchingWasixRuntime } from './compatibility-version-policy.mts';
import { workspaceBindingManifest } from '../../src/wasix/sdks/ts/tools/integration/packed-node-fixture.mts';

if (process.env.OLIPHAUNT_INDEPENDENT_VERSION_TEST !== '1' || existsSync(path.join(ROOT, '.git'))) {
  throw new Error('Run bash tools/release/independent-version-pins.test.sh');
}

const read = (file) => readFileSync(path.join(ROOT, file), 'utf8');
const write = (file, text) => writeFileSync(path.join(ROOT, file), text);
const json = (file) => JSON.parse(read(file));
const products = loadProducts();
const sdkPins = compatibilityVersionEntries(products, { requireSourceProduct: true })
  .filter((entry) => products[entry.product].kind === 'sdk')
  .map((entry) => ({ ...entry, value: compatibilityVersionValue(entry) }));
const manifest = json('.release-please-manifest.json');

// Advance dependencies without selecting their consumers. Distinct versions
// expose both accidental coupling and substitution of a current workspace pin.
for (const [index, product] of [
  'liboliphaunt-native',
  'liboliphaunt-wasix',
  'oliphaunt-broker',
  'oliphaunt-node-direct',
  'oliphaunt-wasix-napi',
  'oliphaunt-query',
  'oliphaunt-query-ts',
  'oliphaunt-swift',
  'oliphaunt-kotlin',
].entries()) {
  const metadata = products[product];
  const version = `${Number(metadata.version.split('.')[0]) + 10 + index}.0.0`;
  manifest[metadata.path] = version;
  const file = metadata.version_files[0];
  if (path.basename(file) === 'package.json') {
    write(file, JSON.stringify({ ...json(file), version }));
  } else if (path.basename(file) === 'Cargo.toml') {
    write(file, read(file).replace(/^version = "[^"]+"/mu, `version = "${version}"`));
  } else {
    assert.equal(path.basename(file), 'VERSION');
    write(file, `${version}\n`);
  }
}
write('.release-please-manifest.json', JSON.stringify(manifest));

function stageManifest(name, source) {
  const directory = path.join(ROOT, 'target', 'independent-version-pins', name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, 'package.json'), read(source));
  return directory;
}

test('every SDK retains its declared compatibility pins after independent dependency releases', () => {
  assert.ok(sdkPins.length > 0);
  for (const entry of sdkPins) {
    assert.equal(
      productCompatibilityVersion(entry.product, entry.sourceProduct),
      entry.value,
      entry.id,
    );
    const source = products[entry.sourceProduct];
    if (source.version !== manifest[source.path]) {
      assert.notEqual(entry.value, manifest[source.path], entry.id);
    }
  }
});

test('native TypeScript and React Native npm staging retains independent product pins', () => {
  for (const [profile, source] of [
    ['js', 'src/native/sdks/ts/package.json'],
    ['react-native', 'src/native/sdks/react-native/package.json'],
  ]) {
    const original = json(source);
    const directory = stageManifest(profile, source);
    prepareSourceOnlyNpmPackage(directory, SOURCE_ONLY_NPM_PROFILES[profile]);
    const staged = JSON.parse(readFileSync(path.join(directory, 'package.json'), 'utf8'));
    assert.deepEqual(staged.oliphaunt, original.oliphaunt);
    assert.deepEqual(staged.dependencies, original.dependencies);
    for (const [name, field] of Object.entries(
      SOURCE_ONLY_NPM_PROFILES[profile].optionalDependencyVersions ?? {},
    )) {
      assert.equal(staged.optionalDependencies[name], original.oliphaunt[field]);
    }
  }
});

test('WASIX TypeScript npm staging uses its portable runtime and Node-API pins', () => {
  const source = 'src/wasix/sdks/ts/package.json';
  const original = json(source);
  const staged = prepareWasixTypescriptPackage(stageManifest('wasix-ts', source));
  assertWasixTypescriptManifest(staged);
  assert.equal(
    staged.dependencies['@oliphaunt/liboliphaunt-wasix'],
    original.oliphaunt.runtimeVersion,
  );
  assert.equal(
    staged.dependencies['@oliphaunt/ts-query'],
    original.dependencies['@oliphaunt/ts-query'],
  );
  for (const version of Object.values(staged.optionalDependencies)) {
    assert.equal(version, original.oliphaunt.wasixNapiVersion);
  }
});

test('WASIX addon qualification identifies the compiled workspace runtime without changing release pins', () => {
  const product = json('src/wasix/node-addon/package.json');
  const original = json('src/wasix/node-addon/packages/linux-x64-gnu/package.json');
  const staged = workspaceCarrierManifest(original, product.oliphaunt);
  assert.equal(staged.oliphaunt.runtimeVersion, workspaceRuntimeVersion());
  assert.notEqual(staged.oliphaunt.runtimeVersion, original.oliphaunt.runtimeVersion);
  assert.equal(staged.oliphaunt.qualificationOnly, true);
  const currentRust = Bun.TOML.parse(read('src/wasix/sdks/rust/Cargo.toml')).package.version;
  const currentContract = {
    runtimeVersion: workspaceRuntimeVersion(),
    rustBindingVersion: currentRust,
  };
  const aligned = workspaceCarrierManifest(original, currentContract);
  assert.equal(Object.hasOwn(aligned.oliphaunt, 'qualificationOnly'), false);
  const rustOnly = workspaceCarrierManifest(original, {
    ...currentContract,
    rustBindingVersion: '0.0.0',
  });
  assert.equal(rustOnly.oliphaunt.qualificationOnly, true);
  assert.deepEqual(json('src/wasix/node-addon/packages/linux-x64-gnu/package.json'), original);
  const target = {
    target: 'linux-x64-gnu',
    npmPackage: original.name,
    npmOs: 'linux',
    npmCpu: 'x64',
    npmLibc: 'glibc',
  };
  assert.doesNotThrow(() =>
    assertWasixNapiCarrierManifest(staged, target, original.version, 'workspace', staged.oliphaunt),
  );
  assert.throws(
    () => assertWasixNapiCarrierManifest(staged, target, original.version),
    /runtime\/ABI\/profile metadata/u,
  );
  const result = spawnSync(
    process.execPath,
    [
      'src/wasix/node-addon/tools/native-build-data.mts',
      'metadata',
      'src/wasix/node-addon/package.json',
    ],
    { cwd: ROOT, encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.split('\t')[0], staged.oliphaunt.runtimeVersion);
});

test('WASIX SDK release requires the same portable and addon runtime', () => {
  assert.doesNotThrow(() =>
    requireMatchingWasixRuntime({
      runtimeVersion: '1.2.3',
      napiVersion: '4.5.6',
      napiRuntimeVersion: '1.2.3',
    }),
  );
  assert.throws(
    () =>
      requireMatchingWasixRuntime({
        runtimeVersion: '1.2.4',
        napiVersion: '4.5.6',
        napiRuntimeVersion: '1.2.3',
      }),
    /select a new addon release/u,
  );
});

test('WASIX workspace consumer uses current producers while its release package retains its pins', () => {
  const original = prepareWasixTypescriptPackage(
    stageManifest('wasix-workspace-consumer', 'src/wasix/sdks/ts/package.json'),
  );
  const snapshot = structuredClone(original);
  const runtimeVersion = workspaceRuntimeVersion();
  const nativeVersion = manifest[products['oliphaunt-wasix-napi'].path];
  const staged = workspaceBindingManifest(original, { runtimeVersion, nativeVersion });
  assertWasixTypescriptManifest(staged);
  assert.equal(staged.oliphaunt.runtimeVersion, runtimeVersion);
  assert.equal(staged.dependencies['@oliphaunt/liboliphaunt-wasix'], runtimeVersion);
  assert.equal(staged.oliphaunt.qualificationOnly, true);
  for (const value of Object.values(staged.optionalDependencies))
    assert.equal(value, nativeVersion);
  assert.deepEqual(original, snapshot);
});

test('native Rust source generation uses its native runtime and broker pins', () => {
  const source = read('src/native/sdks/rust/Cargo.toml');
  const original = Bun.TOML.parse(source);
  const staged = Bun.TOML.parse(packagedCargoManifestText(renderReleaseCargoToml(source)));
  assert.equal(
    staged.dependencies['oliphaunt-query'].version,
    original.dependencies['oliphaunt-query'].version,
  );
  for (const { dependencies } of Object.values(staged.target)) {
    for (const [name, dependency] of Object.entries(dependencies)) {
      if (name.startsWith('liboliphaunt-native-')) {
        assert.equal(
          dependency.version,
          `=${original.package.metadata.oliphaunt['native-version']}`,
        );
      } else if (name.startsWith('oliphaunt-broker-')) {
        assert.equal(
          dependency.version,
          `=${original.package.metadata.oliphaunt['broker-version']}`,
        );
      }
    }
  }
});

test('WASIX Rust source generation retains its runtime and explicit query pins', () => {
  const source = read('src/wasix/sdks/rust/Cargo.toml');
  const original = Bun.TOML.parse(source);
  const staged = Bun.TOML.parse(renderOliphauntWasixReleaseCargoToml(source));
  const runtimeVersion = `=${original.package.metadata.oliphaunt['runtime-version']}`;
  assert.equal(staged.dependencies['liboliphaunt-wasix-portable'].version, runtimeVersion);
  assert.equal(
    staged.dependencies['oliphaunt-query'].version,
    `=${original.dependencies['oliphaunt-query'].version}`,
  );
  for (const { dependencies } of Object.values(staged.target)) {
    for (const [name, dependency] of Object.entries(dependencies)) {
      if (name.startsWith('liboliphaunt-wasix-aot-'))
        assert.equal(dependency.version, runtimeVersion);
    }
  }
});

function mavenTests() {
  return spawnSync(
    process.execPath,
    ['test', '--timeout=30000', './tools/packaging/maven-artifact-manifest.test.mts'],
    {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 30_000,
    },
  );
}

test('Maven carrier generation preserves older external pins and runtime-owned contrib versions', () => {
  const result = mavenTests();
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('Maven carrier generation still rejects compatibility newer than the source runtime', () => {
  const file = 'src/extensions/external/pg_hashids/release.toml';
  const original = read(file);
  const current = manifest[products['liboliphaunt-native'].path];
  const future = `${Number(current.split('.')[0]) + 1}.0.0`;
  try {
    write(
      file,
      original.replace(
        /^native_runtime_version = "[^"]+"/mu,
        `native_runtime_version = "${future}"`,
      ),
    );
    const result = mavenTests();
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /cannot be newer than liboliphaunt-native/u);
  } finally {
    write(file, original);
  }
});
