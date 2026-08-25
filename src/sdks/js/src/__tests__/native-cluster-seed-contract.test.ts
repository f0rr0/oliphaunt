import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';

import { validateNativeClusterSeedManifest } from '../native/cluster-seed.js';

const FIXTURE_ROOT = new URL('../../../../shared/cluster-seed-contract/fixtures/', import.meta.url);

async function fixture(name: string): Promise<string> {
  return readFile(new URL(name, FIXTURE_ROOT), 'utf8');
}

describe('shared native cluster seed contract fixtures', () => {
  test('accepts the canonical standard and ICU manifests', async () => {
    expect(
      validateNativeClusterSeedManifest(
        await fixture('native-standard.valid.properties'),
        'standard',
        'linux-x64-gnu',
        'shared standard fixture',
      ),
    ).toBeUndefined();
    expect(
      validateNativeClusterSeedManifest(
        await fixture('native-icu.valid.properties'),
        'icu',
        'linux-x64-gnu',
        'shared ICU fixture',
      ),
    ).toBe('a'.repeat(64));
  });

  test('rejects the canonical invalid vectors', async () => {
    for (const name of [
      'native-malformed.invalid.properties',
      'native-whitespace.invalid.properties',
      'native-cache-key.invalid.properties',
      'native-dot-cache-key.invalid.properties',
      'native-dotdot-cache-key.invalid.properties',
      'native-extra-field.invalid.properties',
      'native-target-mismatch.invalid.properties',
      'native-profile-mismatch.invalid.properties',
    ]) {
      const manifest = await fixture(name);
      expect(
        () => validateNativeClusterSeedManifest(manifest, 'standard', 'linux-x64-gnu', name),
        name,
      ).toThrow();
    }
  });
});
