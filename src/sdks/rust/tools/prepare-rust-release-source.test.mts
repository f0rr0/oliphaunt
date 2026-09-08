import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  allArtifactTargets,
  currentProductVersionSync,
} from '../../../shared/product-metadata/release-artifact-targets.mts';
import {
  prepareOliphauntBuildReleaseSource,
  prepareRustReleaseSource,
} from './prepare-rust-release-source.mts';
import { productCompatibilityVersion } from '../../../shared/product-metadata/release-graph.mts';
import {
  assertReleaseNoticesInArchive,
  assertReleaseNoticesInDirectory,
} from '../../../shared/artifact-packaging/release-notices.mts';
import { rustNativeTargetCfg } from '../../../shared/artifact-packaging/rust-native-targets.mts';

const ROOT = path.resolve(import.meta.dir, '../../../..');

function commandOutput(command, args) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.equal(
    result.status,
    0,
    `${command} ${args.join(' ')} failed:\n${result.stdout}\n${result.stderr}`,
  );
  return result.stdout;
}

test('freezes the generated target-wired Rust SDK source instead of the workspace facade', () => {
  mkdirSync(path.join(ROOT, 'target'), { recursive: true });
  const root = mkdtempSync(path.join(ROOT, 'target', 'rust-release-source-test-'));
  try {
    const manifestPath = prepareRustReleaseSource({
      stageDir: path.join(root, 'source'),
      log: false,
    });
    const manifest = readFileSync(manifestPath, 'utf8');
    const source = readFileSync(path.join(root, 'source/src/lib.rs'), 'utf8');
    const queryCore = readFileSync(path.join(root, 'source/src/query_core.rs'), 'utf8');
    const canonicalQueryCore = readFileSync(
      path.join(ROOT, 'src/shared/rust-query-core/query_core.rs'),
      'utf8',
    );
    const nativeVersion = productCompatibilityVersion(
      'oliphaunt-rust',
      'liboliphaunt-native',
      'prepare-rust-release-source.test.mts',
    );
    const brokerVersion = productCompatibilityVersion(
      'oliphaunt-rust',
      'oliphaunt-broker',
      'prepare-rust-release-source.test.mts',
    );
    const sdkVersion = currentProductVersionSync(
      'oliphaunt-rust',
      'prepare-rust-release-source.test.mts',
    );
    const targets = allArtifactTargets(
      {
        product: 'liboliphaunt-native',
        kind: 'native-runtime',
        surface: 'rust-native-direct',
      },
      'prepare-rust-release-source.test.mts',
    );
    assert.equal(Bun.TOML.parse(manifest).package.license, 'MIT');
    assertReleaseNoticesInDirectory(path.join(root, 'source'), { profile: 'source-sdk' });

    const parsed = Bun.TOML.parse(manifest);
    for (const target of targets) {
      const cfg = rustNativeTargetCfg(target);
      const dependencies = parsed.target['cfg(' + cfg + ')'].dependencies;
      assert.equal(
        dependencies['liboliphaunt-native-' + target.target].version,
        '=' + nativeVersion,
      );
      assert.equal(dependencies['oliphaunt-broker-' + target.target].version, '=' + brokerVersion);
    }
    assert.equal(parsed.dependencies?.['oliphaunt-tools'], undefined);
    assert.equal(queryCore, canonicalQueryCore);

    const cratePath = commandOutput('bash', [
      path.join(ROOT, 'src/shared/artifact-packaging/package-cargo-source.sh'),
      manifestPath,
      path.join(root, 'crate'),
    ]).trim();
    assert.equal(path.basename(cratePath), `oliphaunt-${sdkVersion}.crate`);
    const packageRoot = `oliphaunt-${sdkVersion}`;
    assertReleaseNoticesInArchive(cratePath, {
      profile: 'source-sdk',
      prefix: packageRoot,
    });
    const packedManifest = commandOutput('tar', ['-xOzf', cratePath, `${packageRoot}/Cargo.toml`]);
    const packedSource = commandOutput('tar', ['-xOzf', cratePath, `${packageRoot}/src/lib.rs`]);
    const packedQueryCore = commandOutput('tar', [
      '-xOzf',
      cratePath,
      `${packageRoot}/src/query_core.rs`,
    ]);
    const packedNames = commandOutput('tar', ['-tzf', cratePath]);
    assert.equal(packedManifest, manifest);
    assert.equal(packedSource, source);
    assert.equal(packedQueryCore, canonicalQueryCore);
    assert.doesNotMatch(packedManifest, /=\s*\{[^}\n]*\bpath\s*=/u);
    assert.doesNotMatch(packedNames, /crates\/oliphaunt-build/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('freezes oliphaunt-build with truthful metadata and canonical notices', () => {
  mkdirSync(path.join(ROOT, 'target'), { recursive: true });
  const root = mkdtempSync(path.join(ROOT, 'target', 'rust-build-release-source-test-'));
  try {
    const manifestPath = prepareOliphauntBuildReleaseSource({
      stageDir: path.join(root, 'source'),
      log: false,
    });
    const manifest = readFileSync(manifestPath, 'utf8');
    const version = currentProductVersionSync(
      'oliphaunt-rust',
      'prepare-rust-release-source.test.mts',
    );
    assert.equal(Bun.TOML.parse(manifest).package.license, 'MIT');
    assert.doesNotMatch(manifest, /\.workspace\s*=\s*true/u);
    assertReleaseNoticesInDirectory(path.join(root, 'source'), { profile: 'source-sdk' });

    const cratePath = commandOutput('bash', [
      path.join(ROOT, 'src/shared/artifact-packaging/package-cargo-source.sh'),
      manifestPath,
      path.join(root, 'crate'),
    ]).trim();
    assert.equal(path.basename(cratePath), `oliphaunt-build-${version}.crate`);
    assertReleaseNoticesInArchive(cratePath, {
      profile: 'source-sdk',
      prefix: `oliphaunt-build-${version}`,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
