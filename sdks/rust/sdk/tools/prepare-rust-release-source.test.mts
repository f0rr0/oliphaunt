import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { readPortableArchiveEntries } from '../../../../tools/packaging/portable-archive.mts';
import {
  assertReleaseNoticesInArchive,
  assertReleaseNoticesInDirectory,
} from '../../../../tools/packaging/release-notices.mts';
import { rustNativeTargetCfg } from '../../../../tools/packaging/rust-native-targets.mts';
import {
  allArtifactTargets,
  currentProductVersionSync,
} from '../../../../tools/release/release-artifact-targets.mts';
import { productCompatibilityVersion } from '../../../../tools/release/release-graph.mts';

const scratch = process.env.OLIPHAUNT_RUST_RELEASE_SOURCE_TEST_ROOT;
if (!scratch) throw new Error('Run bash sdks/rust/sdk/tools/prepare-rust-release-source.test.sh');
function crateAt(root) {
  const directory = path.join(root, 'crate');
  const names = readdirSync(directory).filter((name) => name.endsWith('.crate'));
  assert.equal(names.length, 1);
  return path.join(directory, names[0]);
}

test('freezes the generated target-wired Rust SDK source instead of the workspace facade', () => {
  const root = path.join(scratch, 'sdk');
  const manifestPath = path.join(root, 'source/Cargo.toml');
  const manifest = readFileSync(manifestPath, 'utf8');
  const source = readFileSync(path.join(root, 'source/src/lib.rs'), 'utf8');
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
    assert.equal(dependencies['liboliphaunt-native-' + target.target].version, '=' + nativeVersion);
    assert.equal(dependencies['oliphaunt-broker-' + target.target].version, '=' + brokerVersion);
  }
  assert.equal(parsed.dependencies?.['oliphaunt-tools'], undefined);

  const cratePath = crateAt(root);
  assert.equal(path.basename(cratePath), `oliphaunt-${sdkVersion}.crate`);
  const packageRoot = `oliphaunt-${sdkVersion}`;
  assertReleaseNoticesInArchive(cratePath, {
    profile: 'source-sdk',
    prefix: packageRoot,
  });
  const entries = readPortableArchiveEntries(cratePath);
  const packedManifest = entries.get(`${packageRoot}/Cargo.toml`).data().toString('utf8');
  const packedSource = entries.get(`${packageRoot}/src/lib.rs`).data().toString('utf8');
  const packedNames = [...entries.keys()].join('\n');
  assert.equal(packedManifest, manifest);
  assert.equal(packedSource, source);
  assert.doesNotMatch(packedManifest, /=\s*\{[^}\n]*\bpath\s*=/u);
  assert.doesNotMatch(packedNames, /crates\/oliphaunt-build/u);
});

test('freezes oliphaunt-build with truthful metadata and canonical notices', () => {
  const root = path.join(scratch, 'build');
  const manifestPath = path.join(root, 'source/Cargo.toml');
  const manifest = readFileSync(manifestPath, 'utf8');
  const version = currentProductVersionSync(
    'oliphaunt-rust',
    'prepare-rust-release-source.test.mts',
  );
  assert.equal(Bun.TOML.parse(manifest).package.license, 'MIT');
  assert.doesNotMatch(manifest, /\.workspace\s*=\s*true/u);
  assertReleaseNoticesInDirectory(path.join(root, 'source'), { profile: 'source-sdk' });

  const cratePath = crateAt(root);
  assert.equal(path.basename(cratePath), `oliphaunt-build-${version}.crate`);
  assertReleaseNoticesInArchive(cratePath, {
    profile: 'source-sdk',
    prefix: `oliphaunt-build-${version}`,
  });
});
