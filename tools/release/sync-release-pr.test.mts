#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  cargoManifestPaths,
  cargoPathDependencyBindings,
  desiredCargoPathDependencyVersion,
  priorCargoPathDependencyVersions,
  SDK_INSTALL_VERSION_RULES,
  syncExampleCargoManifestText,
  syncLockfile,
  syncSdkInstallDocs,
  syncTomlStringPath,
} from './sync-release-pr.mts';

const [mode, root, stage] = process.argv.slice(2);
if (mode === 'inventory') {
  const existing = path.join(root, 'Cargo.toml'),
    nested = path.join(root, 'nested/Cargo.toml'),
    untracked = path.join(root, 'untracked/Cargo.toml');
  assert.deepEqual(
    cargoManifestPaths({ root }),
    stage === 'deleted' ? [existing, untracked] : [existing, nested, untracked],
  );
  assert.equal(
    priorCargoPathDependencyVersions(existing, { root }).get(
      JSON.stringify(['dependencies', 'local']),
    ),
    '*',
  );
  assert.deepEqual([...priorCargoPathDependencyVersions(nested, { root })], []);
  assert.deepEqual([...priorCargoPathDependencyVersions(untracked, { root })], []);
  process.exit(0);
}

test('compatibility sync handles inline and table Cargo dependencies without changing other fields', () => {
  for (const source of [
    `[dependencies]\nquery = { path = '../query', version = '0.1.0', features = ['one'] }\n`,
    `[dependencies.query]\npath = '../query'\nversion = '0.1.0'\nfeatures = ['one']\n`,
  ]) {
    const result = syncTomlStringPath(source, 'dependencies.query.version', '0.2.0', 'consumer');
    const expected = Bun.TOML.parse(source);
    expected.dependencies.query.version = '0.2.0';
    assert.deepEqual(Bun.TOML.parse(result.text), expected);
    assert.equal(
      syncTomlStringPath(result.text, 'dependencies.query.version', '0.2.0', 'consumer').detail,
      undefined,
    );
  }
});

test('release sync preserves wildcard Cargo path dependencies', () => {
  assert.equal(desiredCargoPathDependencyVersion('*', '0.2.0'), '*');
  assert.equal(desiredCargoPathDependencyVersion('0.1.0', '0.2.0'), '0.2.0');
  assert.equal(desiredCargoPathDependencyVersion('=0.1.0', '0.2.0'), '=0.2.0');
});

test('release sync updates table-form Cargo pins and keeps target-specific requirements distinct', () => {
  const manifestPath = path.resolve('/release-fixture/client/Cargo.toml');
  const packages = new Map([
    [path.resolve('/release-fixture/native/Cargo.toml'), ['runtime', '0.2.0']],
  ]);
  const source = `
[dependencies]
alias = { package = 'runtime', path = '../native', version = '=0.1.0', features = ['one'] }
[target.'cfg(unix)'.dependencies.alias]
package = 'runtime'
path = '../native'
version = '0.1.0'
[target.'cfg(windows)'.build-dependencies]
alias = { package = 'runtime', path = '../native', version = '*' }
`;
  const policy = { crateDir: path.dirname(manifestPath) };
  const bindings = cargoPathDependencyBindings(source, manifestPath, packages);
  const result = syncExampleCargoManifestText(source, { policy, bindings });
  const expected = Bun.TOML.parse(source);
  expected.dependencies.alias.version = '=0.2.0';
  expected.target['cfg(unix)'].dependencies.alias.version = '0.2.0';
  assert.deepEqual(Bun.TOML.parse(result.text), expected);
  assert.equal(result.details.length, 2);
  assert.deepEqual(syncExampleCargoManifestText(result.text, { policy, bindings }), {
    text: result.text,
    details: [],
  });
});

test('release sync advances every SDK install contract with its product', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'oliphaunt-sdk-install-docs-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const transitions = [
    { product: 'oliphaunt-swift', before: '0.6.1', after: '0.7.0' },
    { product: 'oliphaunt-kotlin', before: '0.1.1', after: '0.2.0' },
  ];
  for (const rule of SDK_INSTALL_VERSION_RULES) {
    const transition = transitions.find(({ product }) => product === rule.product);
    const file = path.join(root, rule.file);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${rule.prefix}${transition.before}${rule.suffix}\n`);
  }

  const changes = [];
  syncSdkInstallDocs(changes, { root, write: true, transitions });
  assert.deepEqual(
    changes.map(({ path: file }) => path.relative(root, file)).sort(),
    SDK_INSTALL_VERSION_RULES.map(({ file }) => file).sort(),
  );
  for (const rule of SDK_INSTALL_VERSION_RULES) {
    const transition = transitions.find(({ product }) => product === rule.product);
    assert.equal(
      readFileSync(path.join(root, rule.file), 'utf8'),
      `${rule.prefix}${transition.after}${rule.suffix}\n`,
    );
  }
  const checkChanges = [];
  syncSdkInstallDocs(checkChanges, { root, write: false, transitions });
  assert.deepEqual(checkChanges, []);
});

test('release sync updates only unsourced local packages in a nested Cargo lock', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'oliphaunt-release-lock-'));
  try {
    const lockfile = path.join(directory, 'Cargo.lock');
    const initial = `version = 4

[[package]]
name = "oliphaunt"
version = "0.0.0"

[[package]]
name = "serde"
version = "1.0.0"
source = "registry+https://github.com/rust-lang/crates.io-index"
`;
    writeFileSync(lockfile, initial);
    const versions = new Map([
      ['oliphaunt', '0.1.0'],
      ['serde', '9.9.9'],
    ]);
    const checkChanges = [];
    syncLockfile(lockfile, versions, checkChanges, { write: false });
    assert.equal(readFileSync(lockfile, 'utf8'), initial);
    assert.deepEqual(
      checkChanges.map(({ detail }) => detail),
      ['oliphaunt 0.0.0 -> 0.1.0'],
    );

    const writeChanges = [];
    syncLockfile(lockfile, versions, writeChanges, { write: true });
    const updated = readFileSync(lockfile, 'utf8');
    assert.match(updated, /name = "oliphaunt"\nversion = "0[.]1[.]0"/u);
    assert.match(updated, /name = "serde"\nversion = "1[.]0[.]0"\nsource =/u);
    assert.deepEqual(
      writeChanges.map(({ detail }) => detail),
      ['oliphaunt 0.0.0 -> 0.1.0'],
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('release sync closes registry example pins and runtime metadata across Cargo scopes', () => {
  const target = 'cfg(all(target_os = "linux", target_arch = "x86_64", target_env = "gnu"))';
  const policy = {
    crateDir: 'fixture',
    runtime: {
      product: 'liboliphaunt-native',
      productParts: ['package', 'metadata', 'oliphaunt', 'runtime'],
    },
  };
  const dependency = (name, entryParts) => ({
    kind: 'dependency',
    name,
    entryParts,
    expected: '=0.1.1',
  });
  const bindings = [
    dependency('oliphaunt-build', ['build-dependencies', 'oliphaunt-build']),
    dependency('oliphaunt', ['dependencies', 'oliphaunt']),
    dependency('oliphaunt', ['dev-dependencies', 'oliphaunt']),
    dependency('oliphaunt-target', ['target', target, 'dependencies', 'oliphaunt-target']),
    {
      kind: 'runtime',
      name: 'runtime-version',
      entryParts: ['package', 'metadata', 'oliphaunt', 'runtime-version'],
      expected: '0.1.1',
    },
  ];
  const initial = `[package]
name = "fixture"
version = "0.0.0"

[package.metadata.oliphaunt]
runtime = "liboliphaunt-native"
runtime-version = "0.1.0" # exact native payload contract

[build-dependencies]
oliphaunt-build = { version = "=0.1.0" }

[dependencies]
oliphaunt = "=0.1.0"

[dev-dependencies]
'oliphaunt' = { version = '=0.1.0', optional = false }

[target.'${target}'.dependencies]
oliphaunt-target = { version = "=0.1.0", features = [
  "preserved-feature",
] }
`;

  const first = syncExampleCargoManifestText(initial, {
    policy,
    bindings,
    label: 'fixture/Cargo.toml',
  });
  assert.equal(first.details.length, 5);
  assert.equal((first.text.match(/0[.]1[.]1/gu) ?? []).length, 5);
  assert.equal(first.text.includes('0.1.0'), false);
  assert.match(first.text, /features = \[\n {2}"preserved-feature",\n\]/u);
  assert.match(first.text, /runtime-version = "0[.]1[.]1" # exact native payload contract/u);

  const second = syncExampleCargoManifestText(first.text, {
    policy,
    bindings,
    label: 'fixture/Cargo.toml',
  });
  assert.equal(second.text, first.text);
  assert.deepEqual(second.details, []);

  const unsupported = initial.replace('oliphaunt = "=0.1.0"', 'oliphaunt = true');
  assert.throws(
    () =>
      syncExampleCargoManifestText(unsupported, { policy, bindings, label: 'fixture/Cargo.toml' }),
    /must use a string or inline-table dependency specification/u,
  );
});
