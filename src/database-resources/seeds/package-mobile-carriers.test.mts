import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDeterministicTar } from '../../../tools/packaging/archive-directory.mts';
import {
  canonicalGzipSync,
  readPortableArchiveEntries,
  releaseZstdCompressSync,
} from '../../../tools/packaging/portable-archive.mts';
import {
  assertReleaseNoticesInEntries,
  stageReleaseNotices,
} from '../../../tools/packaging/release-notices.mts';
import { nativeIcuDataManifest, parseNativeIcuDataIdentity } from '../contracts/icu-data.mts';
import {
  NATIVE_PGDATA_DIRECTORIES,
  nativeClusterSeedCompatibilityKey,
  parseProperties,
} from '../contracts/native-manifest.mts';
import { packageMobileSeedCarriers, stageMobileSeed } from './package-mobile-carriers.mts';

test('mobile carrier preserves seed bytes and rejects wrong target, profile and digest', async () => {
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'oliphaunt-mobile-carrier-'));
  try {
    const source = path.join(scratch, 'fixture');
    for (const directory of NATIVE_PGDATA_DIRECTORIES)
      mkdirSync(path.join(source, directory), { recursive: true });
    writeFileSync(path.join(source, 'PG_VERSION'), '18\n');
    writeFileSync(path.join(source, 'global/pg_control'), 'archive-layout-fixture-only');
    const archive = path.join(scratch, 'seed.tar.zst');
    const bytes = releaseZstdCompressSync(await createDeterministicTar(source));
    writeFileSync(archive, bytes);
    const contract = JSON.parse(
      readFileSync(new URL('../contracts/contract.json', import.meta.url), 'utf8'),
    );
    const metadata = {
      schema: contract.manifests.wasix.schema,
      catalogProfile: 'standard',
      artifactRole: 'cluster-seed-standard',
      runtime: {
        engineFamily: 'native',
        target: 'android-datum64',
        postgresMajor: 18,
        physicalFormat: contract.physicalFormats.native,
        compatibilityKey: nativeClusterSeedCompatibilityKey('android-datum64'),
      },
      archive: { sha256: createHash('sha256').update(bytes).digest('hex') },
      icu: null,
    };
    const manifest = path.join(scratch, 'seed.json');
    writeFileSync(manifest, JSON.stringify(metadata));
    const destination = path.join(scratch, 'carrier/cluster-seed');
    const options = {
      archive,
      manifest,
      destination,
      target: 'android-datum64',
      profile: 'standard',
    };
    stageMobileSeed(options);
    expect(readFileSync(path.join(destination, 'files/global/pg_control'), 'utf8')).toBe(
      'archive-layout-fixture-only',
    );
    const properties = parseProperties(
      readFileSync(path.join(destination, 'manifest.properties')),
      'test carrier',
    );
    expect(properties.get('target')).toBe('android-datum64');
    expect(properties.get('icuDataTreeSha256')).toBe('');
    expect(() => stageMobileSeed({ ...options, target: 'ios-datum64' })).toThrow('does not match');
    expect(() => stageMobileSeed({ ...options, profile: 'icu' })).toThrow('does not match');

    const assets = path.join(scratch, 'release-assets');
    const work = path.join(scratch, 'mobile-carriers');
    const maven = path.join(scratch, 'maven');
    mkdirSync(assets);
    // Explicit action context must not fall back to the checkout's current owner version.
    const version = '7.8.9';
    const stem = `database-resources-${version}-seed-native-android-datum64-standard`;
    copyFileSync(archive, path.join(assets, `${stem}.tar.zst`));
    copyFileSync(manifest, path.join(assets, `${stem}.json`));
    const inputNames = readdirSync(assets).sort();
    const outputs = await packageMobileSeedCarriers({
      targets: ['android-datum64'],
      profiles: ['standard'],
      assetDir: assets,
      workDir: work,
      mavenDir: maven,
      version,
      contract,
    });
    expect(readdirSync(assets).sort()).toEqual(inputNames);
    expect(outputs).toEqual([path.join(work, `${stem}-maven.tar.gz`)]);
    const entries = readPortableArchiveEntries(outputs[0]);
    expect(entries.get('cluster-seed/files/global/pg_control').data().toString()).toBe(
      'archive-layout-fixture-only',
    );
    const artifact = 'oliphaunt-seed-native-android-datum64-standard';
    expect(
      readFileSync(
        path.join(
          maven,
          'dev/oliphaunt/runtime',
          artifact,
          version,
          `${artifact}-${version}.tar.gz`,
        ),
      ),
    ).toEqual(readFileSync(outputs[0]));
    expect(
      readFileSync(
        path.join(maven, 'dev/oliphaunt/runtime', artifact, version, `${artifact}-${version}.pom`),
        'utf8',
      ),
    ).toContain('<version>7.8.9</version>');

    writeFileSync(archive, Buffer.from('corrupt'));
    expect(() => stageMobileSeed(options)).toThrow('checksum');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('Swift carrier preserves both seed profiles, ICU data and complete canonical legal inputs', async () => {
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'oliphaunt-swift-seed-carrier-'));
  try {
    const version = '7.8.9';
    const assets = path.join(scratch, 'assets');
    const sourceRoot = path.resolve(import.meta.dir, '../../..');
    const legalRoot = path.join(scratch, 'legal');
    mkdirSync(assets);
    for (const relative of [
      'LICENSE',
      'THIRD_PARTY_NOTICES.md',
      'src/native/runtime/THIRD_PARTY_NOTICES.md',
      'src/third-party/postgres/COPYRIGHT',
      'src/third-party/postgres/source.toml',
      'src/third-party/icu/LICENSE',
      'src/third-party/icu/source.toml',
    ]) {
      const destination = path.join(legalRoot, relative);
      mkdirSync(path.dirname(destination), { recursive: true });
      copyFileSync(path.join(sourceRoot, relative), destination);
    }
    const icu = path.join(scratch, 'icu');
    const data = path.join(icu, 'share/icu');
    mkdirSync(data, { recursive: true });
    const dataBytes = Buffer.from('ICU archive fixture data');
    writeFileSync(path.join(data, 'icudt76l.dat'), dataBytes);
    const icuManifest = nativeIcuDataManifest(data);
    const identity = parseNativeIcuDataIdentity(icuManifest);
    writeFileSync(path.join(icu, 'manifest.properties'), icuManifest);
    stageReleaseNotices(icu, { profile: 'native-icu-data', sourceRoot: legalRoot });
    writeFileSync(
      path.join(assets, `database-resources-${version}-icu-data.tar.gz`),
      canonicalGzipSync(await createDeterministicTar(icu)),
    );
    const seed = path.join(scratch, 'seed');
    for (const directory of NATIVE_PGDATA_DIRECTORIES)
      mkdirSync(path.join(seed, directory), { recursive: true });
    writeFileSync(path.join(seed, 'PG_VERSION'), '18\n');
    const controlBytes = Buffer.from('archive-layout-fixture-only');
    writeFileSync(path.join(seed, 'global/pg_control'), controlBytes);
    const seedBytes = releaseZstdCompressSync(await createDeterministicTar(seed));
    const contract = JSON.parse(
      readFileSync(new URL('../contracts/contract.json', import.meta.url), 'utf8'),
    );
    for (const profile of ['standard', 'icu']) {
      const stem = `database-resources-${version}-seed-native-ios-datum64-${profile}`;
      writeFileSync(path.join(assets, `${stem}.tar.zst`), seedBytes);
      writeFileSync(
        path.join(assets, `${stem}.json`),
        JSON.stringify({
          schema: contract.manifests.wasix.schema,
          catalogProfile: profile,
          artifactRole: contract.profiles[profile].artifactRole,
          runtime: {
            engineFamily: 'native',
            target: 'ios-datum64',
            postgresMajor: 18,
            physicalFormat: contract.physicalFormats.native,
            compatibilityKey: nativeClusterSeedCompatibilityKey('ios-datum64'),
          },
          archive: { sha256: createHash('sha256').update(seedBytes).digest('hex') },
          icu: profile === 'icu' ? identity : null,
        }),
      );
    }
    const outputs = await packageMobileSeedCarriers({
      targets: ['ios-datum64'],
      profiles: ['standard', 'icu'],
      assetDir: assets,
      workDir: path.join(scratch, 'mobile'),
      version,
      contract,
      noticeSourceRoot: legalRoot,
    });
    expect(outputs).toEqual([path.join(assets, `database-resources-${version}-swift.zip`)]);
    const entries = readPortableArchiveEntries(outputs[0]);
    assertReleaseNoticesInEntries(entries, { profile: 'native-runtime', sourceRoot: legalRoot });
    expect(entries.get('THIRD_PARTY_LICENSES/ICU-LICENSE').data()).toEqual(
      readFileSync(path.join(legalRoot, 'src/third-party/icu/LICENSE')),
    );
    expect(entries.get('Sources/OliphauntICU/share/icu/icudt76l.dat').data()).toEqual(dataBytes);
    expect(entries.get('Sources/OliphauntICU/manifest.properties').data()).toEqual(icuManifest);
    expect(
      [...entries.keys()].filter((name) => /^Sources\/[^/]+\/Resources.swift$/u.test(name)).sort(),
    ).toEqual([
      'Sources/OliphauntICU/Resources.swift',
      'Sources/OliphauntSeedNativeIOSICU/Resources.swift',
      'Sources/OliphauntSeedNativeIOSStandard/Resources.swift',
    ]);
    for (const [name, resource, profile] of [
      ['OliphauntSeedNativeIOSStandard', 'cluster-seed', 'standard'],
      ['OliphauntSeedNativeIOSICU', 'cluster-seed-icu', 'icu'],
    ]) {
      const prefix = `Sources/${name}/${resource}`;
      expect(entries.get(`${prefix}/files/global/pg_control`).data()).toEqual(controlBytes);
      const manifest = parseProperties(entries.get(`${prefix}/manifest.properties`).data(), prefix);
      expect(manifest.get('target')).toBe('ios-datum64');
      expect(manifest.get('catalogProfile')).toBe(profile);
      expect(manifest.get('runtimeFeatures')).toBe(profile === 'icu' ? 'icu' : '');
      expect(manifest.get('icuDataTreeSha256')).toBe(
        profile === 'icu' ? identity.dataTreeSha256 : '',
      );
    }
    expect(
      [...entries.keys()].some((name) => /(?:^|\/)(?:extensions|static-registry)\//u.test(name)),
    ).toBe(false);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
