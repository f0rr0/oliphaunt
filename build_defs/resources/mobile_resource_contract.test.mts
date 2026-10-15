import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  nativeIcuDataManifest,
  parseNativeIcuDataIdentity,
} from '../../src/database-resources/contracts/icu-data.mts';
import { NATIVE_PGDATA_DIRECTORIES } from '../../src/database-resources/contracts/native-manifest.mts';
import { seedCarrierIdentities } from '../../src/database-resources/seeds/carrier-identities.mts';
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
import {
  captureSeedConstructionIntent,
  writeSeedConstructionReceipt,
} from './seed_construction.mts';

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

test('the final mobile verifier consumes conventional Android and iOS package writers through declared input aliases', async () => {
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
      const producer = { postgresSha256: 'a'.repeat(64), initdbSha256: 'b'.repeat(64) };
      const constructions = [];
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
              product: 'liboliphaunt-native',
              engineFamily: 'native',
              target,
              version: runtimeVersion,
              postgresMajor: 18,
              physicalFormat: contract.physicalFormats.native,
              compatibilityKey: contract.compatibilityKeys.native[target],
            },
            source: { producer: 'native-initdb', ...producer },
            archive: {
              sha256: createHash('sha256').update(seedBytes).digest('hex'),
              compressedBytes: seedBytes.length,
            },
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
        const construction = path.join(root, `${target}-${profile}.seed-construction.json`);
        const intent = captureSeedConstructionIntent(
          { family: 'native', target, profile },
          { producer },
          { manifest },
        );
        writeSeedConstructionReceipt(construction, intent, frozen, path.join(frozenRoot, 'files'));
        constructions.push({ construction, intent, frozen, frozenRoot, archive, manifest });
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
        for (const [name, entry] of readPortableArchiveEntries(carrier.crate))
          expect(entry.mode, name).toBe(entry.isDirectory ? 0o755 : 0o644);
        seeds.push({
          profile,
          frozen,
          archive,
          manifest,
          npm: carrier.npmArchive,
          cargo: carrier.crate,
          construction,
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
      const aliases = path.join(root, `${target}-input-aliases`);
      mkdirSync(aliases);
      const alias = (file: string) => {
        const input = path.join(aliases, path.basename(file));
        symlinkSync(file, input);
        return input;
      };
      const aliasedIcu = alias(icu);
      const swift = target === 'ios-datum64' ? alias(outputs[0]) : undefined;
      let aliasedMaven: string | undefined;
      if (target === 'android-datum64') {
        const mavenRunfiles = path.join(root, 'maven-runfiles');
        for (const seed of seeds) {
          const identity = seedCarrierIdentities().find(
            (row) =>
              row.family === 'native' && row.target === target && row.profile === seed.profile,
          );
          if (!identity) throw new Error('missing canonical seed carrier');
          const coordinate = path.join('dev/oliphaunt/runtime', identity.cargo, version);
          const source = path.join(root, 'maven', coordinate);
          const destination = path.join(mavenRunfiles, coordinate);
          mkdirSync(destination, { recursive: true });
          for (const name of readdirSync(source))
            symlinkSync(path.join(source, name), path.join(destination, name));
        }
        aliasedMaven = alias(mavenRunfiles);
      }
      const aliasedSeeds = seeds.map((seed) => ({
        ...seed,
        frozen: alias(seed.frozen),
        archive: alias(seed.archive),
        manifest: alias(seed.manifest),
        npm: alias(seed.npm),
        cargo: alias(seed.cargo),
        construction: alias(seed.construction),
        maven: aliasedMaven,
      }));
      await verifyMobileResourceFiles({
        target,
        version,
        runtimeVersion,
        icu: aliasedIcu,
        swift,
        seeds: aliasedSeeds,
        root: path.join(root, `${target}-proof`),
      });
      await expect(
        verifyMobileResourceFiles({
          target,
          version,
          runtimeVersion: '1.2.4',
          icu: aliasedIcu,
          swift,
          seeds: aliasedSeeds,
          root: path.join(root, `${target}-fresh-runtime-mismatch`),
        }),
      ).rejects.toThrow();
      const publication = {
        product: 'database-resources',
        version: '0.2.2',
        tagName: 'database-resources-v0.2.2',
        publicationSha: 'a'.repeat(40),
        publicationTree: 'b'.repeat(40),
        releaseSha: 'c'.repeat(40),
      };
      for (const row of constructions) {
        const contents = readFileSync(row.manifest, 'utf8');
        const manifestIdentity = {
          size: Buffer.byteLength(contents),
          sha256: createHash('sha256').update(contents).digest('hex'),
        };
        writeSeedConstructionReceipt(
          row.construction,
          row.intent,
          row.frozen,
          path.join(row.frozenRoot, 'files'),
          {
            kind: 'completed-publication',
            operation: 'adopted',
            publication,
            archive: {
              size: seedBytes.length,
              sha256: createHash('sha256').update(seedBytes).digest('hex'),
            },
            manifest: manifestIdentity,
          },
          undefined,
          { ...manifestIdentity, contents, publication },
        );
      }
      await verifyMobileResourceFiles({
        target,
        version,
        runtimeVersion: '1.2.4',
        icu: aliasedIcu,
        swift,
        seeds: aliasedSeeds,
        root: path.join(root, `${target}-admitted-original-runtime`),
      });
      await expect(
        verifyMobileResourceFiles({
          target,
          version,
          runtimeVersion: 'latest',
          icu: aliasedIcu,
          swift,
          seeds: aliasedSeeds,
          root: path.join(root, `${target}-invalid-runtime-version`),
        }),
      ).rejects.toThrow();
      const original = readFileSync(seeds[0].manifest, 'utf8');
      for (const mutation of [
        { runtime: { ...JSON.parse(original).runtime, version: '1.2.4' } },
        { runtime: { ...JSON.parse(original).runtime, product: 'liboliphaunt-wasix' } },
        { source: { ...JSON.parse(original).source, postgresSha256: 'c'.repeat(64) } },
        { archive: { ...JSON.parse(original).archive, sha256: 'c'.repeat(64) } },
      ]) {
        writeFileSync(seeds[0].manifest, JSON.stringify({ ...JSON.parse(original), ...mutation }));
        await expect(
          verifyMobileResourceFiles({
            target,
            version,
            runtimeVersion: '1.2.4',
            icu: aliasedIcu,
            swift,
            seeds: aliasedSeeds,
            root: path.join(root, `${target}-changed-original-provenance`),
          }),
        ).rejects.toThrow();
      }
      writeFileSync(seeds[0].manifest, original);
      await expect(
        verifyMobileResourceFiles({
          target,
          version: '7.8.8',
          runtimeVersion,
          icu: aliasedIcu,
          swift,
          seeds: aliasedSeeds,
          root: path.join(root, `${target}-wrong-version`),
        }),
      ).rejects.toThrow();
      await expect(
        verifyMobileResourceFiles({
          target,
          version,
          runtimeVersion,
          icu: alias(icuRoot),
          swift,
          seeds: aliasedSeeds,
          root: path.join(root, `${target}-directory-substitution`),
        }),
      ).rejects.toThrow();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
