#!/usr/bin/env bun
import { afterAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { zstdCompressSync } from 'node:zlib';

import { createDeterministicTar } from '../../../tools/packaging/cargo-source-package.mts';
import { stageReleaseNotices } from '../../../tools/packaging/release-notices.mts';
import { CORE_RUNTIME_ARCHIVE_FILES } from './wasix-cargo-artifact-contract.mts';
import { packWasixRuntimeNpmCarrier } from './wasix-runtime-npm-carrier.mts';
import {
  WASIX_PORTABLE_RELEASE_MEMBERS,
  WASIX_RUNTIME_NPM_PACKAGE,
} from './wasix-runtime-npm-contract.mts';

const directories = [];

afterAll(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

function temporaryRoot(name) {
  const root = mkdtempSync(path.join(os.tmpdir(), name));
  directories.push(root);
  return root;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function deterministicTar(stage, archiveRoot) {
  return createDeterministicTar(stage, archiveRoot, {
    fail(message) {
      throw new Error(message);
    },
    fixedFileMode: 0o644,
  });
}

function writeMember(stage, member, bytes) {
  const output = path.join(stage, ...member.split('/'));
  mkdirSync(path.dirname(output), { recursive: true });
  writeFileSync(output, bytes);
}

function portableReleaseFixture(root, { transformManifest = (manifest) => manifest } = {}) {
  const runtimeStage = path.join(root, 'runtime-stage');
  for (const member of CORE_RUNTIME_ARCHIVE_FILES) {
    expect(member.startsWith('oliphaunt/')).toBe(true);
    writeMember(runtimeStage, member.slice('oliphaunt/'.length), `fixture:${member}\n`);
  }
  const runtimeBytes = zstdCompressSync(deterministicTar(runtimeStage, 'oliphaunt'));

  const sourceFingerprint = 'fixture-postgres-source-fingerprint';
  const runtimeModuleSha256 = sha256(Buffer.from('fixture:oliphaunt/bin/postgres\n'));
  const manifest = transformManifest({
    'format-version': 2,
    'source-fingerprint': sourceFingerprint,
    runtime: {
      archive: 'oliphaunt.wasix.tar.zst',
      sha256: sha256(runtimeBytes),
      size: runtimeBytes.length,
      'module-sha256': runtimeModuleSha256,
      'postgres-version': '18.4',
      link: { exports: [] },
    },
    'runtime-support': [],
    extensions: [],
  });
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  const releaseStage = path.join(root, 'release-stage');
  writeMember(releaseStage, WASIX_PORTABLE_RELEASE_MEMBERS.runtimeArchive, runtimeBytes);
  writeMember(releaseStage, WASIX_PORTABLE_RELEASE_MEMBERS.manifest, manifestBytes);
  stageReleaseNotices(releaseStage, { profile: 'wasix-runtime' });
  const archive = path.join(root, 'liboliphaunt-wasix-7.8.9-runtime-portable.tar.zst');
  writeFileSync(archive, zstdCompressSync(deterministicTar(releaseStage, '.')));
  return { archive, manifestBytes, runtimeBytes };
}

test('rejects a core manifest that omits host-required identity metadata', () => {
  const root = temporaryRoot('oliphaunt-wasix-runtime-invalid-manifest-');
  const fixture = portableReleaseFixture(root, {
    transformManifest(manifest) {
      delete manifest.runtime.link;
      return manifest;
    },
  });
  expect(() =>
    packWasixRuntimeNpmCarrier({
      version: '7.8.9',
      portableReleaseArchive: fixture.archive,
      packageDir: path.join(root, 'package'),
      tarballRoot: path.join(root, 'tarballs'),
    }),
  ).toThrow(/runtime[.]link must be an object/u);
});

test('rejects a core manifest whose optional runtime size differs from its bytes', () => {
  const root = temporaryRoot('oliphaunt-wasix-runtime-invalid-size-');
  const fixture = portableReleaseFixture(root, {
    transformManifest(manifest) {
      manifest.runtime.size += 1;
      return manifest;
    },
  });
  expect(() =>
    packWasixRuntimeNpmCarrier({
      version: '7.8.9',
      portableReleaseArchive: fixture.archive,
      packageDir: path.join(root, 'package'),
      tarballRoot: path.join(root, 'tarballs'),
    }),
  ).toThrow(/runtime archive does not match manifest[.]runtime[.]size/u);
});

test('packs the exact qualified core projection as one host-neutral npm carrier', () => {
  const parent = process.env.OLIPHAUNT_WASIX_PACKAGING_TEST_ROOT;
  if (!parent) throw new Error('Run bash runtimes/liboliphaunt-wasix/tools/test-packaging.sh');
  const root = path.join(parent, 'npm-runtime');
  mkdirSync(root);
  const fixture = portableReleaseFixture(root);
  const packed = packWasixRuntimeNpmCarrier({
    version: '7.8.9',
    portableReleaseArchive: fixture.archive,
    packageDir: path.join(root, 'package'),
    tarballRoot: path.join(root, 'tarballs'),
  });
  const packageJson = JSON.parse(
    readFileSync(path.join(packed.packageDir, 'package.json'), 'utf8'),
  );
  expect(packageJson.name).toBe(WASIX_RUNTIME_NPM_PACKAGE);
  expect(packageJson.version).toBe('7.8.9');
  expect(packageJson.oliphaunt.manifestProjection).toBe('core');
  expect(Object.keys(packed.descriptor).sort()).toEqual(['manifest', 'runtimeArchive', 'version']);
  expect(readFileSync(path.join(packed.packageDir, 'assets/manifest.json'))).toEqual(
    fixture.manifestBytes,
  );
});

test('rejects stale bundled-seed manifests and a runtime module with the wrong identity', () => {
  for (const [change, error] of [
    [
      (manifest) => {
        manifest['cluster-seeds'] = {};
      },
      /must not bundle independently packaged cluster seeds/,
    ],
    [
      (manifest) => {
        manifest.runtime['module-sha256'] = '0'.repeat(64);
      },
      /runtime module does not match/,
    ],
  ]) {
    const root = temporaryRoot('oliphaunt-wasix-runtime-identity-');
    const fixture = portableReleaseFixture(root, {
      transformManifest(manifest) {
        change(manifest);
        return manifest;
      },
    });
    expect(() =>
      packWasixRuntimeNpmCarrier({
        version: '7.8.9',
        portableReleaseArchive: fixture.archive,
        packageDir: path.join(root, 'package'),
        tarballRoot: path.join(root, 'tarballs'),
      }),
    ).toThrow(error);
  }
});

test('rejects invalid generated carrier versions before touching staging paths', async () => {
  const pack = packWasixRuntimeNpmCarrier;
  for (const version of ['../outside', '01.2.3', '1.2', '1.2.3/../../outside']) {
    expect(() => pack({ version })).toThrow(/semantic version/u);
  }
});
