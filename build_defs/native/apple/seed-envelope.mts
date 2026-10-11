import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { packageMobileSeedCarriers } from '../../../src/database-resources/seeds/package-mobile-carriers.mts';
import { materializeInputs, privateWork, readSpecification } from '../../resources/shared.mts';

export async function packageSwiftSeedEnvelope(specification) {
  const version = specification.version;
  const expected = [`database-resources-${version}-icu-data.tar.gz`];
  for (const profile of ['standard', 'icu']) {
    const stem = `database-resources-${version}-seed-native-ios-datum64-${profile}`;
    expected.push(`${stem}.tar.zst`, `${stem}.json`);
  }
  assert.deepEqual(
    specification.assets.map((input) => path.basename(input)).sort(),
    expected.sort(),
    'Swift resources require exactly the canonical standard seed, ICU seed and ICU archive',
  );
  const output = path.resolve(specification.output);
  const work = privateWork(output);
  try {
    const legalRoot = materializeInputs(specification.notices, path.join(work, 'legal'));
    const assets = path.join(work, 'assets');
    mkdirSync(assets);
    for (const input of specification.assets) {
      const destination = path.join(assets, path.basename(input));
      copyFileSync(input, destination);
      chmodSync(destination, 0o644);
    }
    const results = await packageMobileSeedCarriers({
      targets: ['ios-datum64'],
      profiles: ['standard', 'icu'],
      assetDir: assets,
      workDir: path.join(work, 'mobile'),
      version,
      contract: specification.contract,
      noticeSourceRoot: legalRoot,
    });
    const archive = path.join(assets, `database-resources-${version}-swift.zip`);
    assert.deepEqual(
      results,
      [archive],
      'the existing formatter must emit one canonical Swift ZIP',
    );
    copyFileSync(archive, output);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (import.meta.main) await packageSwiftSeedEnvelope(readSpecification());
