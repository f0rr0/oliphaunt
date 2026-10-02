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
  readPortableArchiveEntries,
  releaseZstdCompressSync,
} from '../../../tools/packaging/portable-archive.mts';
import { currentProductVersionSync } from '../../../tools/release/release-artifact-targets.mts';
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
    const version = currentProductVersionSync('database-resources');
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

    writeFileSync(archive, Buffer.from('corrupt'));
    expect(() => stageMobileSeed(options)).toThrow('checksum');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
