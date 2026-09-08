import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { gzipSync } from 'node:zlib';

import { spawnSync } from 'node:child_process';

import { preparePackagedCargoTestClosure } from './cargo-package-test-closure.mts';
import { createDeterministicTar, packageGeneratedCargoSource } from './cargo-source-package.mts';

const SCRIPT = path.resolve(import.meta.dirname, 'check-cargo-package-tests.sh');

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

test('compiles an unpacked crate offline with locked weak-feature carrier stubs', (t) => {
  const root = fixture(t, 'cargo-closure-stub');
  const cratePath = closureCrate(root);
  const checked = spawnSync(
    'bash',
    [
      SCRIPT,
      '--crate',
      cratePath,
      '--target-dir',
      path.join(root, 'target'),
      '--stub-dependency',
      'carrier',
      '--no-default-features',
      '--features',
      'forward',
      '--lib',
    ],
    { encoding: 'utf8' },
  );
  assert.equal(checked.status, 0, checked.stdout + checked.stderr);
  assert.match(checked.stdout, /Cargo package test closure verified: closure-fixture-0.1.0/u);
});

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

test('rejects unsafe packaged names and invalid CLI/config combinations', (t) => {
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

  const cratePath = closureCrate(root);
  for (const [args, message] of [
    [['--unknown'], /unknown argument/u],
    [['--crate', cratePath, '--all-features', '--features', 'forward'], /mutually exclusive/u],
    [['--crate'], /requires a value/u],
  ]) {
    const cli = spawnSync('bash', [SCRIPT, ...args], { encoding: 'utf8' });
    assert.equal(cli.status, 1);
    assert.match(cli.stdout + cli.stderr, message);
  }
});
