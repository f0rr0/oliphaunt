import assert from 'node:assert/strict';
import {
  appendFileSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { gzipSync } from 'node:zlib';

import { preparePackagedCargoTestClosure } from './cargo-package-test-closure.mts';
import { createDeterministicTar, packageGeneratedCargoSource } from './cargo-source-package.mts';

function fixture(t, name) {
  const root = mkdtempSync(path.join(os.tmpdir(), `oliphaunt-${name}-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function writePackage(directory, name, body = '#![forbid(unsafe_code)]\n') {
  mkdirSync(path.join(directory, 'src'), { recursive: true });
  writeFileSync(
    path.join(directory, 'Cargo.toml'),
    [
      '[package]',
      `name = ${JSON.stringify(name)}`,
      'version = "0.1.0"',
      'edition = "2024"',
      'license = "MIT"',
      '',
      '[lib]',
      'path = "src/lib.rs"',
      '',
    ].join('\n'),
  );
  writeFileSync(path.join(directory, 'src/lib.rs'), body);
}

function closureCrate(root) {
  const source = path.join(root, 'source');
  mkdirSync(path.join(source, 'src'), { recursive: true });
  writeFileSync(
    path.join(source, 'Cargo.toml'),
    [
      '[package]',
      'name = "closure-fixture"',
      'version = "0.1.0"',
      'edition = "2024"',
      'license = "MIT"',
      '',
      '[features]',
      'forward = ["carrier?/needed"]',
      '',
      '[dependencies]',
      'carrier = { version = "=0.1.0", optional = true }',
      '',
      '[lib]',
      'path = "src/lib.rs"',
      '',
    ].join('\n'),
  );
  writeFileSync(path.join(source, 'src/lib.rs'), '#![forbid(unsafe_code)]\n');
  return packageGeneratedCargoSource(path.join(source, 'Cargo.toml'), path.join(root, 'crate'), {
    root,
    rel: String,
    fail: (message) => {
      throw new Error(message);
    },
  });
}

if (process.argv[2] === 'prepare') {
  console.log(closureCrate(process.argv[3]));
  process.exit(0);
}

test('rejects conflicting path-patch sources for the same package identity', (t) => {
  const root = fixture(t, 'cargo-closure-conflict');
  const cratePath = closureCrate(root);
  const controllers = [];
  for (const suffix of ['one', 'two']) {
    const dependency = path.join(root, `carrier-${suffix}`);
    writePackage(dependency, 'carrier');
    const controller = path.join(root, `controller-${suffix}`);
    writePackage(controller, `controller-${suffix}`);
    writeFileSync(
      path.join(controller, 'Cargo.toml'),
      [
        '[package]',
        `name = "controller-${suffix}"`,
        'version = "0.1.0"',
        'edition = "2024"',
        '',
        '[dependencies]',
        `carrier = { version = "*", path = ${JSON.stringify(dependency)} }`,
        '',
      ].join('\n'),
    );
    controllers.push(path.join(controller, 'Cargo.toml'));
  }
  assert.throws(
    () =>
      preparePackagedCargoTestClosure({
        cratePath,
        scratch: path.join(root, 'work'),
        pathDependencyManifests: controllers,
      }),
    /conflicting path-dependency sources/u,
  );
});

test('package qualification retains exact published pins after a local dependency advances', (t) => {
  const root = fixture(t, 'cargo-closure-independent');
  const cratePath = closureCrate(root);
  const dependency = path.join(root, 'carrier');
  writePackage(dependency, 'carrier');
  const sourceManifest = path.join(root, 'Cargo.toml');
  writeFileSync(sourceManifest, '[dependencies]\ncarrier = { path = "carrier", version = "*" }\n');
  for (const version of ['0.1.0', '0.2.0']) {
    const file = path.join(dependency, 'Cargo.toml');
    writeFileSync(
      file,
      readFileSync(file, 'utf8').replace(/^version = "[^"]+"/mu, `version = "${version}"`),
    );
    const scratch = path.join(root, `work-${version}`);
    const manifestFile = preparePackagedCargoTestClosure({
      cratePath,
      scratch,
      pathDependencyManifests: [sourceManifest],
    });
    const manifest = Bun.TOML.parse(readFileSync(manifestFile, 'utf8'));
    assert.equal(manifest.dependencies.carrier.version, '=0.1.0');
    const config = Bun.TOML.parse(readFileSync(path.join(scratch, '.cargo/config.toml'), 'utf8'));
    if (version === '0.1.0') {
      const patch = config.patch['crates-io'].carrier.path;
      assert.equal(
        Bun.TOML.parse(readFileSync(path.join(patch, 'Cargo.toml'), 'utf8')).package.version,
        '0.1.0',
      );
    } else {
      assert.equal(config.patch, undefined);
    }
  }
});

test('stages sibling, optional build, and cyclic path dependencies as a closed Cargo graph', (t) => {
  const root = fixture(t, 'cargo-closure-transitive');
  const cratePath = closureCrate(root);
  const source = path.join(root, 'engine');
  for (const [directory, name, dependencies] of [
    [
      'carrier',
      'carrier',
      '[features]\nneeded = []\n[dependencies]\npeer = { package = "renamed-peer", version = "*", path = "../peer" }\n',
    ],
    [
      'peer',
      'renamed-peer',
      '[features]\nunused = ["dep:build-peer"]\n[build-dependencies]\nbuild-peer = { version = "*", path = "../build-peer", optional = true }\n',
    ],
    [
      'build-peer',
      'build-peer',
      '[dependencies]\ncarrier = { version = "*", path = "../carrier", optional = true }\n',
    ],
  ]) {
    const directoryPath = path.join(source, directory);
    writePackage(directoryPath, name);
    appendFileSync(path.join(directoryPath, 'Cargo.toml'), dependencies);
  }
  const hint = path.join(root, 'Cargo.toml');
  writeFileSync(hint, '[dependencies]\ncarrier = { version = "*", path = "engine/carrier" }\n');
  const scratch = path.join(root, 'consumer');
  const manifest = preparePackagedCargoTestClosure({
    cratePath,
    scratch,
    pathDependencyManifests: [hint],
  });
  rmSync(source, { recursive: true });
  const result = Bun.spawnSync(
    [
      'cargo',
      'metadata',
      '--offline',
      '--features',
      'carrier',
      '--format-version',
      '1',
      '--manifest-path',
      manifest,
    ],
    { cwd: scratch },
  );
  assert.equal(result.exitCode, 0, result.stderr.toString());
  const packages = JSON.parse(result.stdout.toString()).packages;
  assert.deepEqual(packages.map((row) => row.name).sort(), [
    'carrier',
    'closure-fixture',
    'renamed-peer',
  ]);
  for (const row of packages) {
    assert.ok(row.manifest_path.startsWith(scratch));
    assert.ok(row.dependencies.every((dependency) => !dependency.path));
  }
  const config = Bun.TOML.parse(readFileSync(path.join(scratch, '.cargo/config.toml'), 'utf8'));
  assert.deepEqual(Object.keys(config.patch['crates-io']), [
    'build-peer',
    'carrier',
    'renamed-peer',
  ]);
});

test('rejects unsafe packaged names', (t) => {
  const root = fixture(t, 'cargo-closure-unsafe');
  const stage = path.join(root, 'stage');
  mkdirSync(path.join(stage, 'src'), { recursive: true });
  writeFileSync(
    path.join(stage, 'Cargo.toml'),
    ['[package]', 'name = "../escape"', 'version = "0.1.0"', 'edition = "2024"', ''].join('\n'),
  );
  writeFileSync(path.join(stage, 'src/lib.rs'), '');
  const unsafeCrate = path.join(root, 'unsafe.crate');
  writeFileSync(
    unsafeCrate,
    gzipSync(
      createDeterministicTar(stage, 'safe-root', {
        fail: (message) => {
          throw new Error(message);
        },
      }),
      { mtime: 0 },
    ),
  );
  assert.throws(
    () =>
      preparePackagedCargoTestClosure({
        cratePath: unsafeCrate,
        scratch: path.join(root, 'unsafe-work'),
      }),
    /unsafe Cargo package name/u,
  );
});
