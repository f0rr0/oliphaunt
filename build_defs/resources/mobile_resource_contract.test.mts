import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  nativeIcuDataManifest,
  parseNativeIcuDataIdentity,
} from '../../src/database-resources/contracts/icu-data.mts';
import { NATIVE_PGDATA_DIRECTORIES } from '../../src/database-resources/contracts/native-manifest.mts';
import { packageSeedCarriers } from '../../src/database-resources/seeds/package-carriers.mts';
import {
  packageMobileSeedCarriers,
  stageMobileSeed,
} from '../../src/database-resources/seeds/package-mobile-carriers.mts';
import { NATIVE_MOBILE_ABI_TARGETS_BY_DOMAIN } from '../../src/native/runtime/tools/native-mobile-abi-contract.mts';
import { createDeterministicTar } from '../../tools/packaging/archive-directory.mts';
import {
  canonicalGzipSync,
  readPortableArchiveEntries,
  releaseZstdCompressSync,
} from '../../tools/packaging/portable-archive.mts';
import { tarArchive } from '../../tools/packaging/testdata/tar-fixture.mts';
import {
  assertMatchingArchiveTrees,
  verifyMobileResourceFiles,
} from './mobile_resource_contract.mts';

test('final resource comparison binds PostgreSQL bytes, empty directories, modes and regular files', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'mobile-resource-proof-'));
  try {
    const original = [
      { name: 'PG_VERSION', data: '18\n' },
      { name: 'global/', type: '5', mode: 0o755 },
      { name: 'global/pg_control', data: 'physical seed bytes' },
      { name: 'pg_twophase/', type: '5', mode: 0o755 },
    ];
    const archive = (name: string, rows) => {
      const file = path.join(root, name);
      writeFileSync(file, tarArchive(rows));
      return readPortableArchiveEntries(file);
    };
    const frozen = archive(
      'frozen.tar.gz',
      original.map((row) => ({ ...row, name: `files/${row.name}` })),
    );
    const equivalent = archive('equivalent.tar.gz', [...original].reverse());
    assertMatchingArchiveTrees(equivalent, '', frozen, 'files/');
    for (const [name, rows] of [
      [
        'changed',
        original.map((row) =>
          row.name === 'global/pg_control' ? { ...row, data: 'changed bytes' } : row,
        ),
      ],
      ['missing-empty', original.filter((row) => row.name !== 'pg_twophase/')],
      ['mode', original.map((row) => (row.name === 'PG_VERSION' ? { ...row, mode: 0o755 } : row))],
      [
        'symlink',
        original.map((row) =>
          row.name === 'global/pg_control'
            ? { ...row, data: '', type: '2', linkTarget: 'other' }
            : row,
        ),
      ],
    ])
      expect(() =>
        assertMatchingArchiveTrees(archive(`${name}.tar.gz`, rows), '', frozen, 'files/'),
      ).toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the final mobile verifier consumes the conventional Android and iOS package writers', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'mobile-carrier-formatters-'));
  try {
    const version = '7.8.9';
    const runtimeVersion = '1.2.3';
    const contract = JSON.parse(
      readFileSync(
        new URL('../../src/database-resources/contracts/contract.json', import.meta.url),
        'utf8',
      ),
    );
    const icuRoot = path.join(root, 'icu');
    const data = path.join(icuRoot, 'share/icu');
    mkdirSync(data, { recursive: true });
    writeFileSync(path.join(data, 'icudt76l.dat'), 'formatter fixture ICU bytes');
    const icuManifest = nativeIcuDataManifest(data);
    writeFileSync(path.join(icuRoot, 'manifest.properties'), icuManifest);
    const assets = path.join(root, 'assets');
    mkdirSync(assets);
    const icu = path.join(assets, `database-resources-${version}-icu-data.tar.gz`);
    writeFileSync(icu, canonicalGzipSync(await createDeterministicTar(icuRoot)));
    const identity = parseNativeIcuDataIdentity(icuManifest);
    const pgdata = path.join(root, 'pgdata');
    for (const directory of NATIVE_PGDATA_DIRECTORIES)
      mkdirSync(path.join(pgdata, directory), { recursive: true });
    writeFileSync(path.join(pgdata, 'PG_VERSION'), '18\n');
    writeFileSync(
      path.join(pgdata, 'global/pg_control'),
      'formatter fixture, not runtime evidence',
    );
    const seedBytes = releaseZstdCompressSync(await createDeterministicTar(pgdata));
    const values = {
      schema: 'oliphaunt-native-mobile-abi-v1',
      byteOrder: 'little',
      datumBytes: '8',
      maximumAlignof: '8',
      float8ByVal: '1',
      blockSize: '8192',
      walBlockSize: '8192',
      relationSegmentSize: '131072',
      nameDataLength: '64',
      indexMaxKeys: '32',
      catalogVersion: '202506291',
      pgControlVersion: '1800',
    };
    for (const target of ['android-datum64', 'ios-datum64'] as const) {
      const seeds = [];
      for (const profile of ['icu', 'standard'] as const) {
        const stem = `database-resources-${version}-seed-native-${target}-${profile}`;
        const archive = path.join(assets, `${stem}.tar.zst`);
        const manifest = path.join(assets, `${stem}.json`);
        writeFileSync(archive, seedBytes);
        writeFileSync(
          manifest,
          JSON.stringify({
            schema: contract.manifests.wasix.schema,
            catalogProfile: profile,
            artifactRole: contract.profiles[profile].artifactRole,
            runtime: {
              engineFamily: 'native',
              target,
              version: runtimeVersion,
              postgresMajor: 18,
              physicalFormat: contract.physicalFormats.native,
              compatibilityKey: contract.compatibilityKeys.native[target],
            },
            archive: { sha256: createHash('sha256').update(seedBytes).digest('hex') },
            icu: profile === 'icu' ? identity : null,
          }),
        );
        const frozenRoot = path.join(root, `${target}-${profile}-frozen`);
        stageMobileSeed({
          archive,
          manifest,
          destination: frozenRoot,
          target,
          profile,
          icuData: profile === 'icu' ? data : undefined,
        });
        mkdirSync(path.join(frozenRoot, 'abi-receipts'));
        for (const abiTarget of NATIVE_MOBILE_ABI_TARGETS_BY_DOMAIN[target])
          writeFileSync(
            path.join(frozenRoot, 'abi-receipts', `${abiTarget}.properties`),
            `${Object.entries({ ...values, target: abiTarget })
              .map(([key, value]) => `${key}=${value}`)
              .join('\n')}\n`,
          );
        const frozen = path.join(root, `${target}-${profile}-frozen.tar`);
        writeFileSync(frozen, await createDeterministicTar(frozenRoot));
        const [carrier] = packageSeedCarriers(
          ['--family', 'native', '--target', target, '--profile', profile],
          {
            version,
            contract,
            assetDir: assets,
            outputDir: path.join(root, `${target}-${profile}-packages`),
            sourceDir: path.join(root, `${target}-${profile}-sources`),
          },
        );
        seeds.push({
          profile,
          frozen,
          archive,
          manifest,
          npm: carrier.npmArchive,
          cargo: carrier.crate,
          maven: target === 'android-datum64' ? path.join(root, 'maven') : undefined,
        });
      }
      const outputs = await packageMobileSeedCarriers({
        targets: [target],
        profiles: ['standard', 'icu'],
        assetDir: assets,
        version,
        contract,
        workDir: path.join(root, `${target}-mobile`),
        mavenDir: path.join(root, 'maven'),
      });
      const swift = target === 'ios-datum64' ? outputs[0] : undefined;
      await verifyMobileResourceFiles({
        target,
        version,
        runtimeVersion,
        icu,
        swift,
        seeds,
        root: path.join(root, `${target}-proof`),
      });
      await expect(
        verifyMobileResourceFiles({
          target,
          version: '7.8.8',
          runtimeVersion,
          icu,
          swift,
          seeds,
          root: path.join(root, `${target}-wrong-version`),
        }),
      ).rejects.toThrow();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
