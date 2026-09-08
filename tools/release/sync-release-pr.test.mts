#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  EXAMPLE_CARGO_POLICIES,
  exampleCargoReleaseVersionBindings,
} from './example-cargo-policy.mts';
import {
  cargoPathDependencyBindings,
  desiredCargoPathDependencyVersion,
  SDK_INSTALL_VERSION_RULES,
  sharedContribBootstrapRequired,
  syncExampleCargoManifestText,
  syncLockfile,
  syncSdkInstallDocs,
} from './sync-release-pr.mts';

const ROOT = path.resolve(import.meta.dir, '../..');

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

test('shared contrib bootstrap is allowed only from unreleased main state', () => {
  assert.equal(
    sharedContribBootstrapRequired([], () => [{ product: 'liboliphaunt-native' }]),
    true,
  );
  assert.equal(
    sharedContribBootstrapRequired([], () => []),
    false,
  );
  let discoveries = 0;
  assert.equal(
    sharedContribBootstrapRequired(
      [{ product: 'liboliphaunt-native', before: '0.1.0', after: '0.1.1' }],
      () => {
        discoveries += 1;
        throw new Error('released main must not run shared candidate discovery');
      },
    ),
    false,
    'a released or pending main transition must not seed another release PR',
  );
  assert.equal(discoveries, 0);
});

test('Cargo release inventory includes new manifests and preserves prior dependency constraints', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'oliphaunt-cargo-inventory-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  };
  git('init', '-q');
  git('config', 'user.name', 'Release Test');
  git('config', 'user.email', 'release-test@example.invalid');
  writeFileSync(path.join(root, '.gitignore'), 'ignored/\n');
  const existing = path.join(root, 'Cargo.toml');
  writeFileSync(
    existing,
    '[package]\nname = "root"\nversion = "0.1.0"\n[dependencies]\nlocal = { path = "nested", version = "*" }\n',
  );
  git('add', '.');
  git('commit', '-qm', 'initial');
  for (const name of ['nested', 'ignored']) {
    mkdirSync(path.join(root, name));
    writeFileSync(
      path.join(root, name, 'Cargo.toml'),
      '[package]\nname = "nested"\nversion = "0.2.0"\n',
    );
  }
  git('add', 'nested');
  git('commit', '-qm', 'new package');
  mkdirSync(path.join(root, 'untracked'));
  const untracked = path.join(root, 'untracked', 'Cargo.toml');
  writeFileSync(untracked, '[package]\nname = "untracked"\nversion = "0.1.0"\n');
  const nested = path.join(root, 'nested', 'Cargo.toml');
  const probe = path.join(root, 'probe.mts');
  writeFileSync(
    probe,
    `import * as api from ${JSON.stringify(path.resolve(import.meta.dirname, 'sync-release-pr.mts'))};
const root = process.argv[2];
console.log(JSON.stringify({ paths: api.cargoManifestPaths({ root }), prior: ${JSON.stringify([existing, nested, untracked])}.map(file => [...api.priorCargoPathDependencyVersions(file, { root })]) }));
`,
  );
  const snapshot = () => {
    const result = spawnSync(
      'bash',
      [
        path.resolve(import.meta.dirname, 'release-please-state.sh'),
        root,
        'HEAD',
        '',
        process.execPath,
        probe,
        root,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const captured = snapshot();
  assert.deepEqual(captured.paths, [existing, nested, untracked]);
  assert.equal(new Map(captured.prior[0]).get(JSON.stringify(['dependencies', 'local'])), '*');
  assert.deepEqual(captured.prior[1], []);
  assert.deepEqual(captured.prior[2], []);
  rmSync(nested);
  assert.deepEqual(snapshot().paths, [existing, untracked]);
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
  assert.match(first.text, /features = \[\n  "preserved-feature",\n\]/u);
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

test('release sync targets both WASIX example dependency scopes independently', () => {
  const bindings = exampleCargoReleaseVersionBindings();
  for (const policyId of ['wasix-tauri', 'wasix-electron-sidecar']) {
    const policy = EXAMPLE_CARGO_POLICIES.find(({ id }) => id === policyId);
    assert.notEqual(policy, undefined);
    const manifestPath = path.join(ROOT, policy.crateDir, 'Cargo.toml');
    const initial = readFileSync(manifestPath, 'utf8');
    const result = syncExampleCargoManifestText(initial, {
      policy,
      bindings: bindings.filter(({ policyId: candidate }) => candidate === policyId),
      label: `${policy.crateDir}/Cargo.toml`,
    });
    assert.equal(result.text, initial);
    assert.deepEqual(result.details, []);
  }
});

test('generated release readiness closes the cheap pre-fanout fixed point', () => {
  const result = spawnSync(
    'bash',
    ['tools/release/sync-release-pr.sh', '--check-generated-release'],
    {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      timeout: 10_000,
    },
  );
  assert.equal(result.status, 0, [result.stdout, result.stderr].filter(Boolean).join('\n'));
  assert.match(result.stdout, /release PR derived files are in sync/u);

  const conflicting = spawnSync(
    process.execPath,
    ['tools/release/sync-release-pr.mts', '--check', '--check-generated-release'],
    { cwd: ROOT, encoding: 'utf8', timeout: 10_000 },
  );
  assert.equal(conflicting.status, 2);
  assert.match(conflicting.stderr, /mutually exclusive/u);
});
