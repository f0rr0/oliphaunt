import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { preparePackagedCargoTestClosure } from '../../../../tools/packaging/cargo-package-test-closure.mts';
import { packageEngine } from './package.mts';

assert.equal(process.platform, 'win32', 'installed engine qualification requires Windows');
const root = mkdtempSync(path.join(os.tmpdir(), 'oliphaunt-installed-engine-'));
try {
  const version = Bun.TOML.parse(
    readFileSync(path.join(import.meta.dir, 'crates/wasmer/Cargo.toml'), 'utf8'),
  ).package.version;
  const packages = packageEngine({
    sourceRoot: path.join(root, 'source'),
    outputDir: path.join(root, 'packages'),
    version,
  });
  const consumer = path.join(root, 'consumer');
  const wasmer = packages.find((row) => row.name === 'oliphaunt-wasmer');
  const manifest = preparePackagedCargoTestClosure({
    cratePath: wasmer.cratePath,
    scratch: consumer,
    dependencyCrates: packages.filter((row) => row !== wasmer).map((row) => row.cratePath),
  });
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith('OLIPHAUNT_')),
  );
  env.CARGO_TARGET_DIR = path.join(root, 'target');
  function run(command: string[]) {
    const result = Bun.spawnSync(command, {
      cwd: consumer,
      env,
      stdout: 'inherit',
      stderr: 'inherit',
      timeout: 1_200_000,
    });
    assert.equal(result.exitCode, 0, `installed engine: ${command.join(' ')}`);
  }
  // Only the extracted archives supply private dependencies. No workspace
  // producer, source archive, native library, or compiler build is consulted.
  run(['cargo', '--config', 'net.offline=false', 'fetch', '--manifest-path', manifest]);
  run([
    'cargo',
    'nextest',
    'run',
    '--manifest-path',
    manifest,
    '--locked',
    '--offline',
    '--no-default-features',
    '--features',
    'v8',
    '--lib',
    '-E',
    'test(oliphaunt_contract)',
    '--no-tests=fail',
    '--test-threads=1',
  ]);
  const wasix = path.join(
    consumer,
    'dependencies',
    `oliphaunt-wasmer-wasix-${version}`,
    'Cargo.toml',
  );
  run(['cargo', '--config', 'net.offline=false', 'fetch', '--manifest-path', wasix]);
  run([
    'cargo',
    'check',
    '--manifest-path',
    wasix,
    '--locked',
    '--offline',
    '--no-default-features',
    '--features',
    'sys-minimal,sys-poll,host-vnet,time,v8,wasmer/headless',
  ]);
} finally {
  rmSync(root, { recursive: true, force: true });
}
