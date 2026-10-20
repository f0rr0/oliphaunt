import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { preparePackagedCargoTestClosure } from '../../../../../tools/packaging/cargo-package-test-closure.mts';
import {
  packageAotSpec,
  packageSpec,
} from '../../../../../tools/packaging/wasix-cargo-payload.mts';
import {
  currentProductVersionSync,
  ROOT,
} from '../../../../../tools/release/release-artifact-targets.mts';
import { packageEngine } from '../../../runtime/engine/package.mts';
import {
  postgresSourceFingerprint,
  stageAotAssets,
  stagePortableAssets,
} from '../../../runtime/tools/package-release-assets.mts';
import { runtimeCorePayload } from '../../../runtime/tools/package_liboliphaunt_wasix_cargo_artifacts.mts';
import {
  AOT_PACKAGES,
  AOT_TARGET_TRIPLES,
  RUNTIME_PACKAGE,
} from '../../../runtime/tools/wasix-cargo-artifact-contract.mts';

assert.equal(process.platform, 'win32');
const targetId = 'windows-x64-msvc';
const target = AOT_TARGET_TRIPLES[targetId];
const version = currentProductVersionSync('liboliphaunt-wasix');
const scratch = mkdtempSync(path.join(os.tmpdir(), 'oliphaunt-wasix-installed-aot-'));
try {
  const sourceRoot = path.join(scratch, 'source');
  const outputDir = path.join(scratch, 'packages');
  mkdirSync(outputDir);
  const fingerprint = postgresSourceFingerprint();
  const portable = path.join(scratch, 'portable');
  const aot = path.join(scratch, 'aot');
  stagePortableAssets(path.join(ROOT, 'target/oliphaunt-wasix/assets'), portable, fingerprint);
  stageAotAssets(path.join(ROOT, 'target/oliphaunt-wasix/aot', target), aot, target, fingerprint);
  const packages = packageEngine({ sourceRoot, outputDir, version });
  for (const spec of [
    {
      name: RUNTIME_PACKAGE,
      kind: 'wasix-runtime',
      target: 'portable',
      templateDir: path.join(ROOT, 'src/wasix/runtime/crates/assets'),
      payloadRoot: runtimeCorePayload(portable, scratch),
      payloadDirName: 'payload',
    },
    {
      name: AOT_PACKAGES[targetId],
      kind: 'wasix-aot',
      target,
      templateDir: path.join(ROOT, 'src/wasix/runtime/crates/aot', target),
      payloadRoot: aot,
      payloadDirName: 'artifacts',
    },
  ]) {
    const options = { version, sourceRoot, outputDir, cargoTargetDir: scratch };
    packages.push(
      ...(spec.kind === 'wasix-aot' ? packageAotSpec(spec, options) : [packageSpec(spec, options)]),
    );
  }
  const sdkVersion = currentProductVersionSync('oliphaunt-wasix-rust');
  const queryVersion = currentProductVersionSync('oliphaunt-query');
  const consumer = path.join(scratch, 'consumer');
  const manifest = preparePackagedCargoTestClosure({
    cratePath: path.join(
      ROOT,
      `target/sdk-artifacts/oliphaunt-wasix-rust/oliphaunt-wasix-${sdkVersion}.crate`,
    ),
    scratch: consumer,
    dependencyCrates: [
      ...packages.map((row) => row.cratePath),
      path.join(ROOT, `target/sdk-artifacts/oliphaunt-query/oliphaunt-query-${queryVersion}.crate`),
    ],
    // Inactive platform and optional tool/ICU declarations still participate in
    // Cargo resolution; the selected host's runtime and engine are real archives.
    stubDependencyPrefixes: ['liboliphaunt-wasix-aot-', 'oliphaunt-wasix-tools'],
    stubDependencies: ['oliphaunt-icu'],
  });
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith('OLIPHAUNT_')),
  );
  env.CARGO_TARGET_DIR = path.join(scratch, 'target');
  function run(command: string[]) {
    const result = Bun.spawnSync(command, {
      cwd: consumer,
      env,
      stdout: 'inherit',
      stderr: 'inherit',
      timeout: 1_200_000,
    });
    assert.equal(result.exitCode, 0, `packaged SDK AOT: ${command.join(' ')}`);
  }
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
    '--test',
    'runtime_smoke',
    '-E',
    'test(direct_api_) | test(async_api_)',
    '--no-tests=fail',
    '--test-threads=1',
  ]);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
