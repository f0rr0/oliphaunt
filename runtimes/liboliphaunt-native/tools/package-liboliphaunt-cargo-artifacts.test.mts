#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  packageNativeToolsCargoArtifacts,
  renderUnsupportedToolsTargetGuard,
} from '../../../postgres-tools/native/tools/package-cargo-artifacts.mts';
import { createDeterministicTar } from '../../../tools/packaging/cargo-source-package.mts';
import { NATIVE_CARGO_CARRIER_LICENSES } from '../../../tools/packaging/native-cargo-payload.mts';
import {
  canonicalGzipSync,
  extractPortableArchiveTree,
  readPortableArchiveEntries,
} from '../../../tools/packaging/portable-archive.mts';
import {
  assertReleaseNoticesInArchive,
  stageReleaseNotices,
} from '../../../tools/packaging/release-notices.mts';
import { elfFixture } from '../../../tools/packaging/testdata/release-fixture-utils.mts';
import { requiredCoreRuntimePaths } from './native-runtime-payload.mts';
import { packageNativeCargoArtifacts } from './package-liboliphaunt-cargo-artifacts.mts';

const ROOT = path.resolve(import.meta.dir, '../../..');

function archiveMember(file, member) {
  return readPortableArchiveEntries(file).get(member).data().toString('utf8');
}

function writeExecutable(file, contents) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, contents);
  chmodSync(file, 0o755);
}

function archiveFixture(source, archive) {
  writeFileSync(archive, canonicalGzipSync(createDeterministicTar(source, '.', {})));
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

test('freezes deterministic .crate bytes and prepares an extracted native consumer', async () => {
  const root = process.env.OLIPHAUNT_NATIVE_CARGO_TEST_ROOT;
  if (!root)
    throw new Error(
      'Run bash runtimes/liboliphaunt-native/tools/package-liboliphaunt-cargo-artifacts.test.sh',
    );
  const assets = path.join(root, 'assets');
  const runtime = path.join(root, 'runtime-fixture');
  const tools = path.join(root, 'tools-fixture');
  const output = path.join(root, 'output');
  const work = path.join(root, 'work');
  const fixtureElf = elfFixture({ machine: 62, requiredVersions: ['GLIBC_2.17'] });
  mkdirSync(path.join(runtime, 'runtime/lib'), { recursive: true });
  writeFileSync(path.join(runtime, 'runtime/lib/liboliphaunt.so'), fixtureElf);
  for (const name of ['initdb', 'pg_ctl', 'postgres']) {
    writeExecutable(path.join(runtime, 'runtime/bin', name), fixtureElf);
  }
  for (const relativePath of requiredCoreRuntimePaths(
    'linux-x64-gnu',
    path.join(runtime, 'runtime'),
  )) {
    const file = path.join(runtime, 'runtime', ...relativePath.split('/'));
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(
      file,
      relativePath.startsWith('lib/postgresql/') ? fixtureElf : `${relativePath}\n`,
    );
  }
  for (const name of ['pg_basebackup', 'pg_dump', 'psql']) {
    writeExecutable(path.join(tools, 'runtime/bin', name), fixtureElf);
  }
  stageReleaseNotices(runtime, { profile: 'native-runtime' });
  stageReleaseNotices(tools, { profile: 'native-tools' });
  mkdirSync(assets, { recursive: true });
  archiveFixture(runtime, path.join(assets, 'liboliphaunt-9.8.7-linux-x64-gnu.tar.gz'));
  const toolsAssets = path.join(root, 'tools-assets');
  mkdirSync(toolsAssets, { recursive: true });
  mkdirSync(path.join(tools, 'runtime/lib'), { recursive: true });
  writeFileSync(path.join(tools, 'runtime/lib/libpq.so.5'), fixtureElf);
  archiveFixture(tools, path.join(toolsAssets, 'oliphaunt-tools-9.8.7-linux-x64-gnu.tar.gz'));

  const packageArgs = [
    '--asset-dir',
    assets,
    '--output-dir',
    output,
    '--work-dir',
    work,
    '--version',
    '9.8.7',
    '--target',
    'linux-x64-gnu',
    '--part-bytes',
    '65536',
  ];
  await packageNativeCargoArtifacts(packageArgs);

  const toolsOutput = path.join(root, 'tools-output');
  const toolsArgs = [...packageArgs];
  toolsArgs[toolsArgs.indexOf('--asset-dir') + 1] = toolsAssets;
  toolsArgs[toolsArgs.indexOf('--output-dir') + 1] = toolsOutput;
  toolsArgs[toolsArgs.indexOf('--work-dir') + 1] = path.join(root, 'tools-work');
  await packageNativeToolsCargoArtifacts(toolsArgs);
  const manifest = JSON.parse(readFileSync(path.join(output, 'packages.json'), 'utf8'));
  const toolsManifest = JSON.parse(readFileSync(path.join(toolsOutput, 'packages.json'), 'utf8'));
  manifest.packages.push(...toolsManifest.packages);
  assert(
    toolsManifest.packages.some(
      ({ role, cratePath, name }) =>
        role === 'part' &&
        readPortableArchiveEntries(path.resolve(ROOT, cratePath)).has(
          name + '-9.8.7/payload/files/runtime/lib/libpq.so.5',
        ),
    ),
  );
  assert.ok(manifest.packages.length >= 5);
  assert.deepEqual(
    new Set(manifest.packages.map(({ role }) => role)),
    new Set(['part', 'aggregator', 'facade']),
  );
  assert.ok(
    manifest.packages.every(
      ({ cratePath }) => typeof cratePath === 'string' && cratePath.endsWith('.crate'),
    ),
  );
  assert.equal(
    readdirSync(output).filter((name) => name.endsWith('.crate')).length +
      readdirSync(toolsOutput).filter((name) => name.endsWith('.crate')).length,
    manifest.packages.length,
  );
  for (const item of manifest.packages) {
    const expectedProfile = item.role === 'part' ? item.kind : 'code-facade';
    assert.equal(
      item.noticeProfile,
      expectedProfile,
      `${item.name} must freeze its carrier notice profile`,
    );
    const packedManifest = archiveMember(
      path.resolve(ROOT, item.cratePath),
      `${item.name}-9.8.7/Cargo.toml`,
    );
    assert.equal(
      Bun.TOML.parse(packedManifest).package.license,
      NATIVE_CARGO_CARRIER_LICENSES[expectedProfile],
      `${item.name} must declare its exact role license closure`,
    );
    assertReleaseNoticesInArchive(path.resolve(ROOT, item.cratePath), {
      prefix: `${item.name}-9.8.7`,
      profile: expectedProfile,
    });
  }

  const consumer = path.join(root, 'installed-consumer');
  mkdirSync(path.join(consumer, 'src'), { recursive: true });
  const patches = [];
  for (const item of manifest.packages) {
    const extracted = path.join(consumer, 'packages', item.name);
    extractPortableArchiveTree(path.resolve(ROOT, item.cratePath), extracted);
    patches.push(
      `${item.name} = { path = ${JSON.stringify(path.join(extracted, item.name + '-9.8.7'))} }`,
    );
  }
  writeFileSync(
    path.join(consumer, 'Cargo.toml'),
    [
      '[package]',
      'name = "installed-native-consumer"',
      'version = "0.0.0"',
      'edition = "2024"',
      '[workspace]',
      '[dependencies]',
      'oliphaunt-tools = "=9.8.7"',
      'liboliphaunt-native-linux-x64-gnu = "=9.8.7"',
      '[patch.crates-io]',
      ...patches,
      '',
    ].join('\n'),
  );
  writeFileSync(path.join(consumer, 'src/lib.rs'), 'pub fn installed() {}\n');
  const packedAggregator = manifest.packages.find(({ role }) => role === 'aggregator');
  const packedManifest = archiveMember(
    path.resolve(ROOT, packedAggregator.cratePath),
    `${packedAggregator.name}-9.8.7/Cargo.toml`,
  );
  assert.doesNotMatch(packedManifest, /oliphaunt-package-deps|registry\s*=/u);
  assert.doesNotMatch(
    packedManifest,
    /\[build-dependencies[.]liboliphaunt-native-linux-x64-gnu-part-001\][\s\S]*?path\s*=/u,
  );
  assert.match(packedManifest, /version\s*=\s*"=9[.]8[.]7"/u);

  const facade = manifest.packages.find(({ role }) => role === 'facade');
  assert.ok(facade);
  const facadeRoot = path.dirname(path.resolve(ROOT, facade.manifestPath));
  const facadeSource = path.join(facadeRoot, 'src/lib.rs');
  const facadeText = readFileSync(facadeSource, 'utf8');
  const packedFacadeSource = archiveMember(
    path.resolve(ROOT, facade.cratePath),
    `${facade.name}-9.8.7/src/lib.rs`,
  );
  assert.equal(packedFacadeSource, facadeText);
  const forcedUnsupported = path.join(root, 'forced-unsupported-tools.rs');
  writeFileSync(
    forcedUnsupported,
    `#![forbid(unsafe_code)]
${renderUnsupportedToolsTargetGuard(['fixture-unsupported'], ['any()'])}
pub const FIXTURE: bool = true;
`,
  );
  const forcedSupported = path.join(root, 'forced-supported-tools.rs');
  writeFileSync(
    forcedSupported,
    `#![forbid(unsafe_code)]
${renderUnsupportedToolsTargetGuard(['fixture-supported'], ['all()'])}
pub const FIXTURE: bool = true;
`,
  );
  const digests = () =>
    new Map(
      manifest.packages.map((item) => [item.name, sha256(path.resolve(ROOT, item.cratePath))]),
    );
  const firstDigests = digests();
  await packageNativeCargoArtifacts(packageArgs);
  await packageNativeToolsCargoArtifacts(toolsArgs);
  assert.deepEqual(digests(), firstDigests);
});
