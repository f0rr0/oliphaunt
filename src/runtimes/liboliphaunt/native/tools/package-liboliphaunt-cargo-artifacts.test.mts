#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  NATIVE_CARGO_CARRIER_LICENSES,
  renderUnsupportedToolsTargetGuard,
} from './package-liboliphaunt-cargo-artifacts.mts';
import { elfFixture } from '../../../../../tools/test/release-fixture-utils.mts';
import { nativeRuntimeResourceManifestFixture } from '../../../../../tools/test/native-runtime-fixture.mts';
import {
  assertReleaseNoticesInArchive,
  stageReleaseNotices,
} from '../../../../shared/artifact-packaging/release-notices.mts';
import { requiredCoreRuntimePaths } from './native-runtime-payload.mts';
import { logicalTreeSha256 } from '../../../../shared/cluster-seed-contract/native-manifest.mts';
import { nativeIcuDataManifest } from '../../../../shared/cluster-seed-contract/icu-data.mts';
import { extractPortableArchiveTree } from '../../../../shared/artifact-packaging/portable-archive.mts';
import { nativeRuntimeCarrierManifest } from './native-runtime-carrier-contract.mts';

const ROOT = path.resolve(import.meta.dir, '../../../../..');

function run(command, args, { env = process.env } = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.equal(
    result.status,
    0,
    `${command} ${args.join(' ')} failed:\n${result.stdout}\n${result.stderr}`,
  );
}

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

function writeExecutable(file, contents) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, contents);
  chmodSync(file, 0o755);
}

function archiveFixture(source, archive) {
  run('tar', ['--format', 'ustar', '-czf', archive, '-C', source, '.'], {
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  });
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function stageClusterSeed(root, directory, profile, target, icuDataTreeSha256 = '') {
  const seed = path.join(root, directory);
  mkdirSync(path.join(seed, 'files/global'), { recursive: true });
  mkdirSync(path.join(seed, 'files/pg_wal'), { recursive: true });
  writeFileSync(path.join(seed, 'files/PG_VERSION'), '18\n');
  writeFileSync(path.join(seed, 'files/global/pg_control'), `${profile}\n`);
  writeFileSync(
    path.join(seed, 'manifest.properties'),
    [
      'schema=oliphaunt-runtime-resources-v1',
      'layout=oliphaunt-cluster-seed-v1',
      `artifactRole=cluster-seed-${profile}`,
      `catalogProfile=${profile}`,
      'postgresMajor=18',
      'physicalFormat=native-pg18-v1',
      `target=${target}`,
      `compatibilityKey=native-pg18-${target}-v1`,
      'initialSuperuser=postgres',
      `runtimeFeatures=${profile === 'icu' ? 'icu' : ''}`,
      `icuDataVersion=${profile === 'icu' ? '76.1' : ''}`,
      `icuDataForm=${profile === 'icu' ? 'files-le' : ''}`,
      `icuDataTreeSha256=${icuDataTreeSha256}`,
      'cacheKey=0123456789abcdef',
      '',
    ].join('\n'),
  );
}

test('freezes .crate bytes for native parts, aggregators, and facade and rejects substituted bytes', () => {
  mkdirSync(path.join(ROOT, 'target'), { recursive: true });
  const root = mkdtempSync(path.join(ROOT, 'target', 'native-cargo-freeze-test-'));
  try {
    const assets = path.join(root, 'assets');
    const runtime = path.join(root, 'runtime-fixture');
    const tools = path.join(root, 'tools-fixture');
    const output = path.join(root, 'output');
    const work = path.join(root, 'work');
    const forbiddenStrip = path.join(root, 'forbidden-strip');
    writeExecutable(
      forbiddenStrip,
      '#!/bin/sh\necho carrier assembly must not strip frozen release assets >&2\nexit 99\n',
    );
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
    const icu = path.join(root, 'icu-fixture');
    const icuData = path.join(icu, 'share/icu');
    mkdirSync(icuData, { recursive: true });
    const icuBytes = Buffer.from('fixture ICU data\n');
    writeFileSync(path.join(icuData, 'icudt76l.dat'), icuBytes);
    const icuDigest = logicalTreeSha256([{ path: 'icudt76l.dat', bytes: icuBytes }]);
    stageClusterSeed(runtime, 'cluster-seed', 'standard', 'linux-x64-gnu');
    stageClusterSeed(runtime, 'cluster-seed-icu', 'icu', 'linux-x64-gnu', icuDigest);
    writeFileSync(
      path.join(runtime, 'manifest.properties'),
      nativeRuntimeCarrierManifest('linux-x64-gnu'),
    );
    writeFileSync(
      path.join(runtime, 'runtime/manifest.properties'),
      nativeRuntimeResourceManifestFixture({
        cacheKey: 'fixture-runtime',
        target: 'linux-x64-gnu',
      }),
    );
    writeFileSync(path.join(icu, 'manifest.properties'), nativeIcuDataManifest(icuData));
    stageReleaseNotices(runtime, { profile: 'native-runtime' });
    stageReleaseNotices(tools, { profile: 'native-tools' });
    stageReleaseNotices(icu, { profile: 'native-icu-data' });
    mkdirSync(assets, { recursive: true });
    archiveFixture(runtime, path.join(assets, 'liboliphaunt-9.8.7-linux-x64-gnu.tar.gz'));
    archiveFixture(tools, path.join(assets, 'oliphaunt-tools-9.8.7-linux-x64-gnu.tar.gz'));
    archiveFixture(icu, path.join(assets, 'liboliphaunt-9.8.7-icu-data.tar.gz'));

    const packageArgs = [
      'src/runtimes/liboliphaunt/native/tools/package-liboliphaunt-cargo-artifacts.mts',
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
    run(process.execPath, packageArgs, {
      env: {
        ...process.env,
        OLIPHAUNT_ELF_STRIP: forbiddenStrip,
        OLIPHAUNT_STRIP: forbiddenStrip,
      },
    });

    const manifest = JSON.parse(readFileSync(path.join(output, 'packages.json'), 'utf8'));
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
      readdirSync(output).filter((name) => name.endsWith('.crate')).length,
      manifest.packages.length,
    );
    const runtimeParts = manifest.packages.filter(
      ({ role, kind }) => role === 'part' && kind === 'native-runtime',
    );
    assert.ok(
      runtimeParts.some(({ cratePath, name }) =>
        commandOutput('tar', ['-tzf', path.resolve(ROOT, cratePath)]).includes(
          `${name}-9.8.7/payload/files/cluster-seed-icu/manifest.properties`,
        ),
      ),
    );
    for (const item of manifest.packages) {
      const expectedProfile = item.role === 'part' ? item.kind : 'code-facade';
      assert.equal(
        item.noticeProfile,
        expectedProfile,
        `${item.name} must freeze its carrier notice profile`,
      );
      const packedManifest = commandOutput('tar', [
        '-xOzf',
        path.resolve(ROOT, item.cratePath),
        `${item.name}-9.8.7/Cargo.toml`,
      ]);
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
    run('cargo', ['check', '--offline', '--manifest-path', path.join(consumer, 'Cargo.toml')], {
      env: {
        ...process.env,
        CARGO_HOME: path.join(consumer, 'cargo-home'),
        CARGO_TARGET_DIR: path.join(consumer, 'target'),
      },
    });

    const packedAggregator = manifest.packages.find(({ role }) => role === 'aggregator');
    const packedManifest = commandOutput('tar', [
      '-xOzf',
      path.resolve(ROOT, packedAggregator.cratePath),
      `${packedAggregator.name}-9.8.7/Cargo.toml`,
    ]);
    assert.doesNotMatch(packedManifest, /oliphaunt-package-deps|registry\s*=/u);
    assert.doesNotMatch(
      packedManifest,
      /\[build-dependencies[.]liboliphaunt-native-linux-x64-gnu-part-001\][\s\S]*?path\s*=/u,
    );
    assert.match(packedManifest, /version\s*=\s*"=9[.]8[.]7"/u);

    const facade = manifest.packages.find(({ role }) => role === 'facade');
    assert.ok(facade);
    const facadeRoot = path.dirname(path.resolve(ROOT, facade.manifestPath));
    const facadeManifestText = readFileSync(path.join(facadeRoot, 'Cargo.toml'), 'utf8');
    assert.doesNotMatch(facadeManifestText, /\[dev-dependencies\]|serde_json/u);
    const facadeSource = path.join(facadeRoot, 'src/lib.rs');
    const facadeText = readFileSync(facadeSource, 'utf8');
    const packedFacadeSource = commandOutput('tar', [
      '-xOzf',
      path.resolve(ROOT, facade.cratePath),
      `${facade.name}-9.8.7/src/lib.rs`,
    ]);
    assert.equal(packedFacadeSource, facadeText);
    const forcedUnsupported = path.join(root, 'forced-unsupported-tools.rs');
    writeFileSync(
      forcedUnsupported,
      `#![forbid(unsafe_code)]
${renderUnsupportedToolsTargetGuard(['fixture-unsupported'], ['any()'])}
pub const FIXTURE: bool = true;
`,
    );
    const unsupported = spawnSync(
      'rustc',
      [
        '--crate-name',
        'oliphaunt_tools',
        '--crate-type',
        'lib',
        '--edition',
        '2024',
        forcedUnsupported,
      ],
      { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    assert.notEqual(unsupported.status, 0);
    assert.match(unsupported.stderr, /has no portable fallback/u);

    const forcedSupported = path.join(root, 'forced-supported-tools.rs');
    writeFileSync(
      forcedSupported,
      `#![forbid(unsafe_code)]
${renderUnsupportedToolsTargetGuard(['fixture-supported'], ['all()'])}
pub const FIXTURE: bool = true;
`,
    );
    const supported = spawnSync(
      'rustc',
      [
        '--crate-name',
        'oliphaunt_tools',
        '--crate-type',
        'lib',
        '--edition',
        '2024',
        '--emit',
        'metadata',
        '-o',
        path.join(root, 'forced-supported-tools.rmeta'),
        forcedSupported,
      ],
      { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    assert.equal(supported.status, 0, supported.stderr);

    const digests = () =>
      new Map(
        manifest.packages.map((item) => [item.name, sha256(path.resolve(ROOT, item.cratePath))]),
      );
    const firstDigests = digests();
    run(process.execPath, packageArgs);
    assert.deepEqual(digests(), firstDigests);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
