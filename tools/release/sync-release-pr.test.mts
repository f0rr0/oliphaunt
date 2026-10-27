#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { renderToml } from '../../build_defs/languages/cargo-metadata.mts';
import { loadProducts } from './release-graph.mts';
import {
  cargoLocalVersions,
  cargoManifestPaths,
  cargoPathDependencyBindings,
  cargoSameOwnerDependencyBindings,
  desiredCargoPathDependencyVersion,
  priorCargoPathDependencyVersions,
  releaseDerivedPathInventory,
  syncExampleCargoManifestText,
  syncLockfile,
  syncReleasePr,
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

if (mode === 'workspace-floor') {
  const core = 'liboliphaunt-native-bindings';
  const manifests = ['src/native/rust-bindings/Cargo.toml', 'src/native/sdks/rust/Cargo.toml'];
  if (stage === 'prepare') {
    const versionsFile = path.join(root, '.release-please-manifest.json');
    const versions = JSON.parse(readFileSync(versionsFile, 'utf8'));
    for (const file of manifests) {
      const text = readFileSync(path.join(root, file), 'utf8');
      const version = Bun.TOML.parse(text).package.version;
      const next = version.replace(/\d+$/u, (patch) => String(Number(patch) + 1));
      writeFileSync(
        path.join(root, file),
        text.replace('version = "' + version + '"', 'version = "' + next + '"'),
      );
      versions[path.posix.dirname(file)] = next;
    }
    writeFileSync(versionsFile, JSON.stringify(versions, null, 2) + '\n');
  } else if (stage === 'hold') {
    const file = path.join(root, loadProducts()['oliphaunt-query'].path, 'Cargo.toml');
    const manifest = Bun.TOML.parse(readFileSync(file, 'utf8'));
    manifest.dependencies ??= {};
    manifest.dependencies[core] = { workspace: true };
    writeFileSync(file, renderToml(manifest));
  } else {
    const before = readFileSync(path.join(root, 'Cargo.toml'));
    const buildBound = new Map(Object.keys(loadProducts()).map((id) => [id, new Set()]));
    await syncReleasePr(['--check'], { buildBound });
    assert.deepEqual(readFileSync(path.join(root, 'Cargo.toml')), before);
    throw new Error('missing workspace floor was accepted');
  }
  process.exit(0);
}

// Invoke the real runner in a disposable full checkout; no production CLI option.
if (mode === 'supplier-map') {
  const sdk = path.join(root, 'src/native/sdks/rust/Cargo.toml');
  const broker = path.join(root, 'src/native/broker/Cargo.toml');
  const manifestFile = path.join(root, '.release-please-manifest.json');
  const parsed = (file) => Bun.TOML.parse(readFileSync(file, 'utf8'));
  const next = (version) => version.replace(/\d+$/u, (patch) => String(Number(patch) + 1));
  if (stage === 'prepare') {
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
    for (const file of [sdk, broker]) {
      const version = parsed(file).package.version;
      writeFileSync(
        file,
        readFileSync(file, 'utf8').replace(
          `version = "${version}"`,
          `version = "${next(version)}"`,
        ),
      );
      manifest[path.relative(root, path.dirname(file)).split(path.sep).join('/')] = next(version);
    }
    writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
    process.exit(0);
  }
  const buildBound = new Map(
    Object.keys(loadProducts('sync fixture')).map((id) => [id, new Set()]),
  );
  const constantFile = path.join(root, 'src/native/sdks/rust/src/broker.rs');
  const beforeSdk = parsed(sdk);
  const beforeConstant = readFileSync(constantFile, 'utf8');
  if (stage === 'held') {
    // The checkout already contains version transitions and stale derived pins.
    // Unknown supplier coverage must reject before changing any derived file.
    const before = new Map(
      releaseDerivedPathInventory().map((file) => [file, readFileSync(path.join(root, file))]),
    );
    for (const unknown of [undefined, new Map()]) {
      await assert.rejects(syncReleasePr([], { buildBound: unknown }), /buildBound/u);
      for (const [file, contents] of before)
        assert.deepEqual(readFileSync(path.join(root, file)), contents);
    }
  } else {
    assert.equal(stage, 'current');
    buildBound.get('oliphaunt-rust').add('oliphaunt-broker');
  }
  await syncReleasePr([], { buildBound });
  const afterSdk = parsed(sdk);
  const expected =
    stage === 'held'
      ? beforeSdk.package.metadata.oliphaunt['broker-version']
      : parsed(broker).package.version;
  assert.equal(afterSdk.package.metadata.oliphaunt['broker-version'], expected);
  assert.equal(afterSdk.dependencies['oliphaunt-broker'].version, parsed(broker).package.version);
  assert.match(
    readFileSync(constantFile, 'utf8'),
    new RegExp(`BROKER_RELEASE_VERSION: &str = "${expected.replaceAll('.', '[.]')}"`, 'u'),
  );
  assert.equal(
    afterSdk.package.metadata.oliphaunt['native-version'],
    beforeSdk.package.metadata.oliphaunt['native-version'],
  );
  assert.equal(
    afterSdk.dependencies['oliphaunt-query'].version,
    beforeSdk.dependencies['oliphaunt-query'].version,
  );
  if (stage === 'held') assert.equal(readFileSync(constantFile, 'utf8'), beforeConstant);
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

test('unknown supplied relationships reject the actual sync runner before derived writes', async () => {
  const file = path.resolve(import.meta.dir, '../../release-please-config.json');
  const before = readFileSync(file);
  for (const buildBound of [undefined, null, new Map()]) {
    await assert.rejects(syncReleasePr([], { buildBound }), /buildBound/u);
    assert.deepEqual(readFileSync(file), before);
  }
});

test('release sync preserves wildcard Cargo path dependencies', () => {
  assert.equal(desiredCargoPathDependencyVersion('*', '0.2.0'), '*');
  assert.equal(desiredCargoPathDependencyVersion('0.2.0', '0.2.1'), '0.2.0');
  assert.equal(desiredCargoPathDependencyVersion('^0.2.0', '0.2.1'), '^0.2.0');
  assert.equal(desiredCargoPathDependencyVersion('=0.2.0', '0.2.1'), '=0.2.1');
  assert.equal(desiredCargoPathDependencyVersion('0.1.0', '0.2.0'), '0.2.0');
  assert.equal(desiredCargoPathDependencyVersion('=0.1.0', '0.2.0'), '=0.2.0');
  assert.equal(desiredCargoPathDependencyVersion('^0.2.0', '0.2.1', true), '0.2.1');
});

test('selected release owners close their registry carrier aliases while omitted and other owners retain historical requirements', () => {
  const owners = new Map([
    ['owned-sdk', 'sdk'],
    ['owned-core', 'sdk'],
    ['owned-engine', 'sdk'],
    ['owned-codec', 'sdk'],
    ['foreign-sdk', 'other'],
  ]);
  const products = { sdk: { version: '0.3.3' }, other: { version: '9.0.0' } };
  const source = `[package]
name = 'owned-sdk'
version = '0.3.3'
[dependencies]
owned-core = '=0.3.2'
historical = { package = 'foreign-sdk', version = '=0.3.2' }
private = { package = 'owned-engine', version = '=0.3.2', registry = 'private' }
local = { package = 'owned-engine', version = '=0.3.2', path = '../engine' }
[target.'cfg(windows)'.dependencies]
engine = { package = 'owned-engine', version = '=0.3.2', features = ['v8'], default-features = false }
[build-dependencies.codec]
package = 'owned-codec'
version = '=0.3.2'
[dev-dependencies]
fixture = { package = 'owned-core', version = '=0.3.2' }
`;
  const update = (text, selected) =>
    syncExampleCargoManifestText(text, {
      policy: { crateDir: 'sdk' },
      bindings: cargoSameOwnerDependencyBindings(Bun.TOML.parse(text), owners, products, selected),
    });
  const actual = update(source, new Set(['sdk']));
  const expected = Bun.TOML.parse(source);
  expected.dependencies['owned-core'] = '=0.3.3';
  expected.target['cfg(windows)'].dependencies.engine.version = '=0.3.3';
  expected['build-dependencies'].codec.version = '=0.3.3';
  expected['dev-dependencies'].fixture.version = '=0.3.3';
  assert.deepEqual(Bun.TOML.parse(actual.text), expected);
  assert.equal(actual.details.length, 4);
  assert.deepEqual(update(actual.text, new Set(['sdk'])), { text: actual.text, details: [] });
  assert.deepEqual(update(source, new Set(['other'])), { text: source, details: [] });
  const heldConsumer = {
    package: { name: 'foreign-sdk' },
    dependencies: { 'owned-core': '=0.3.2' },
  };
  assert.deepEqual(
    cargoSameOwnerDependencyBindings(heldConsumer, owners, products, new Set(['sdk'])),
    [],
  );
  assert.deepEqual(
    cargoSameOwnerDependencyBindings(heldConsumer, owners, products, new Set(['sdk', 'other'])),
    [],
  );
});

test('workspace registry aliases advance with their sole public owner and private tools inherit', () => {
  const manifest = Bun.TOML.parse(
    `[workspace.dependencies]\nengine = { package = 'owned-engine', version = '=0.3.2', default-features = false }\n`,
  );
  const owners = new Map([
    ['owned-sdk', 'sdk'],
    ['owned-engine', 'sdk'],
    ['other-sdk', 'other'],
  ]);
  const products = { sdk: { version: '0.3.3' }, other: { version: '2.0.0' } };
  const consumer = (name) => ({
    manifest: {
      package: { name },
      target: {
        'cfg(windows)': { dependencies: { engine: { workspace: true, features: ['v8'] } } },
      },
    },
  });
  const manifests = new Map([
    ['sdk/Cargo.toml', consumer('owned-sdk')],
    ['tools/serializer/Cargo.toml', consumer('private-serializer')],
  ]);
  const bindings = () =>
    cargoSameOwnerDependencyBindings(manifest, owners, products, new Set(['sdk']), { manifests });
  assert.deepEqual(bindings(), [
    {
      kind: 'dependency',
      name: 'engine',
      entryParts: ['workspace', 'dependencies', 'engine'],
      expected: '=0.3.3',
    },
  ]);
  assert.deepEqual(
    cargoSameOwnerDependencyBindings(manifest, owners, products, new Set(), { manifests }),
    [],
  );
  manifests.set('other/Cargo.toml', consumer('other-sdk'));
  assert.throws(bindings, /shares an independently versioned consumer/u);
});

test('compatibility sync preserves exact installed Cargo requirements and their operator spacing', () => {
  for (const requirement of ['=0.1.1', '= 0.1.1']) {
    for (const source of [
      `[dependencies]\nquery = { version = '${requirement}', features = ['one'] }\n`,
      `[dependencies.query]\nversion = '${requirement}'\nfeatures = ['one']\n`,
      `[workspace.dependencies]\nquery = { version = '${requirement}' }\n`,
    ]) {
      const dotted = source.startsWith('[workspace.')
        ? 'workspace.dependencies.query.version'
        : 'dependencies.query.version';
      assert.deepEqual(syncTomlStringPath(source, dotted, '0.1.1', 'consumer'), {
        text: source,
        detail: undefined,
      });
      const result = syncTomlStringPath(source, dotted, '0.1.2', 'consumer');
      const expected = Bun.TOML.parse(source);
      (expected.workspace?.dependencies ?? expected.dependencies).query.version =
        requirement.replace('0.1.1', '0.1.2');
      assert.deepEqual(Bun.TOML.parse(result.text), expected);
      assert.equal(syncTomlStringPath(result.text, dotted, '0.1.2', 'consumer').detail, undefined);
    }
  }
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
    const observed = [];
    const observeUpdate = (update) => observed.push(update);
    syncLockfile(lockfile, versions, checkChanges, { write: false, observeUpdate });
    assert.equal(readFileSync(lockfile, 'utf8'), initial);
    assert.deepEqual(observed, []);
    assert.deepEqual(
      checkChanges.map(({ detail }) => detail),
      ['oliphaunt 0.0.0 -> 0.1.0'],
    );

    const writeChanges = [];
    syncLockfile(lockfile, versions, writeChanges, { write: true, observeUpdate });
    const updated = readFileSync(lockfile, 'utf8');
    assert.equal(observed.length, 1);
    assert.deepEqual(observed[0].before, Buffer.from(initial));
    assert.deepEqual(observed[0].after, readFileSync(lockfile));
    syncLockfile(lockfile, versions, [], { write: true, observeUpdate });
    assert.equal(observed.length, 1);
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

test('generated source and payload crates follow their SDK owner only when that owner changes', (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'oliphaunt-generated-release-lock-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const facade = 'owned-engine-windows-x64-msvc';
  const generated = [
    'owned-api',
    'owned-runtime',
    'owned-types',
    'owned-journal',
    facade,
    ...[1, 2].map((part) => `${facade}-part-${String(part).padStart(3, '0')}`),
  ];
  for (const bumpSdk of [false, true]) {
    const sdkVersion = bumpSdk ? '0.3.4' : '0.3.3';
    const carriers = ['owned-sdk', ...generated.slice(0, 5)].map((name) => ({
      id: `cargo:${name}`,
      ecosystem: 'cargo',
      name,
      product: 'owned-sdk',
      version: sdkVersion,
      role: name === facade ? 'platform-leaf' : 'facade',
    }));
    const lock = {
      version: 4,
      package: [
        { name: 'owned-sdk', version: '0.3.3' },
        ...generated.map((name) => ({ name, version: '0.3.3' })),
        { name: 'other', version: '1.0.0' },
        {
          name: 'owned-api',
          version: '0.3.3',
          source: 'registry+https://github.com/rust-lang/crates.io-index',
          checksum: 'held-source',
        },
      ],
    };
    const versions = cargoLocalVersions(
      new Map([
        ['sdk/Cargo.toml', ['owned-sdk', sdkVersion]],
        ['other/Cargo.toml', ['other', '1.0.1']],
      ]),
      carriers,
      lock,
    );
    for (const name of generated) assert.equal(versions.get(name), sdkVersion);
    const lockfile = path.join(directory, `${bumpSdk}.lock`);
    writeFileSync(
      lockfile,
      `version = 4\n${lock.package
        .map(
          (entry) =>
            `\n[[package]]\n${Object.entries(entry)
              .map(([key, value]) => `${key} = ${JSON.stringify(value)}`)
              .join('\n')}\n`,
        )
        .join('')}`,
    );
    const changes = [];
    syncLockfile(lockfile, versions, changes, { write: true, observeUpdate: undefined });
    const updated = Bun.TOML.parse(readFileSync(lockfile, 'utf8'));
    for (const row of updated.package)
      assert.equal(row.version, row.source ? '0.3.3' : row.name === 'other' ? '1.0.1' : sdkVersion);
    assert.equal(updated.package.find((row) => row.source).checksum, 'held-source');
    assert.equal(changes.length, 1);
    if (!bumpSdk) assert.equal(changes[0].detail, 'other 1.0.0 -> 1.0.1');
    const repeated = [];
    syncLockfile(lockfile, versions, repeated, { write: true, observeUpdate: undefined });
    assert.deepEqual(repeated, []);
    assert.equal(
      cargoLocalVersions(new Map([['sdk/Cargo.toml', ['owned-sdk', '9.9.9']]]), carriers, lock).get(
        'owned-sdk',
      ),
      '9.9.9',
    );
  }
  assert.throws(
    () =>
      cargoLocalVersions(
        new Map([
          ['one/Cargo.toml', ['same', '1.0.0']],
          ['two/Cargo.toml', ['same', '2.0.0']],
        ]),
        [],
        { package: [] },
      ),
    /conflicting versions/,
  );
  assert.deepEqual(
    [
      ...cargoLocalVersions(
        new Map(),
        [{ id: 'cargo:held', ecosystem: 'cargo', name: 'held', version: '9.9.9' }],
        {
          package: [
            {
              name: 'held',
              version: '1.0.0',
              source: 'registry+https://github.com/rust-lang/crates.io-index',
            },
          ],
        },
      ),
    ],
    [],
  );
});

test('release sync updates exact local dependency references while preserving registry identities, comments and line endings', (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'oliphaunt-release-dependency-lock-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const lockfile = path.join(directory, 'Cargo.lock');
  const initial = `version = 4

[[package]]
name = "owned"
version = "1.0.0"

[[package]]
name = "owned"
version = "1.0.0"
source = "registry+https://github.com/rust-lang/crates.io-index"
checksum = "held-one"

[[package]]
name = "owned"
version = "1.5.0"
source = "registry+https://github.com/rust-lang/crates.io-index"
checksum = "held-other"

[[package]]
name = "consumer"
version = "3.0.0"
dependencies = [
 "owned 1.0.0", # current source, literal "owned 1.0.0", ]
 "owned 1.0.0 (registry+https://github.com/rust-lang/crates.io-index)", # held same version
 "owned 1.5.0", # independently resolved registry version
]

[[package]]
name = "sourced-consumer"
version = "4.0.0"
source = "registry+https://github.com/rust-lang/crates.io-index"
checksum = "held-consumer"
dependencies = ["owned 1.0.0", "owned 1.5.0"]
`.replaceAll('\n', '\r\n');
  writeFileSync(lockfile, initial);
  const versions = new Map([['owned', '2.0.0']]);
  const preview = [];
  syncLockfile(lockfile, versions, preview, { write: false, observeUpdate: undefined });
  assert.equal(readFileSync(lockfile, 'utf8'), initial);
  assert.equal(preview.length, 1);
  syncLockfile(lockfile, versions, [], { write: true, observeUpdate: undefined });
  assert.equal(
    readFileSync(lockfile, 'utf8'),
    initial
      .replace('name = "owned"\r\nversion = "1.0.0"', 'name = "owned"\r\nversion = "2.0.0"')
      .replace('"owned 1.0.0", #', '"owned 2.0.0", #')
      .replace('dependencies = ["owned 1.0.0",', 'dependencies = ["owned 2.0.0",'),
  );
  const unchanged = [];
  syncLockfile(lockfile, versions, unchanged, { write: true, observeUpdate: undefined });
  assert.deepEqual(unchanged, []);
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
