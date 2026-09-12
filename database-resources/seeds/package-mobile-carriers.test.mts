import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDeterministicTar } from '../../tools/packaging/archive-directory.mts';
import { releaseZstdCompressSync } from '../../tools/packaging/portable-archive.mts';
import {
  nativeClusterSeedCompatibilityKey,
  parseProperties,
} from '../contracts/native-manifest.mts';
import { stageMobileSeed } from './package-mobile-carriers.mts';

test('mobile carrier preserves seed bytes and rejects wrong target, profile and digest', async () => {
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'oliphaunt-mobile-carrier-'));
  try {
    const source = path.join(scratch, 'fixture');
    mkdirSync(path.join(source, 'global'), { recursive: true });
    mkdirSync(path.join(source, 'pg_wal'));
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
    writeFileSync(archive, Buffer.from('corrupt'));
    expect(() => stageMobileSeed(options)).toThrow('checksum');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
