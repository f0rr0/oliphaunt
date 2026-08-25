import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';

import { resolveExactNativeRuntimeProfile } from '../native/runtime-profile.js';

test('explicit native runtime profile is derived only from its exact ICU payload', async () => {
  const root = await mkdtemp(join(tmpdir(), 'oliphaunt-runtime-profile-'));
  try {
    const standard = join(root, 'standard');
    await mkdir(standard, { recursive: true });
    assert.deepEqual(await resolveExactNativeRuntimeProfile(standard), {
      catalogProfile: 'standard',
    });

    const icu = join(root, 'icu');
    const icuDataDirectory = join(icu, 'share/icu');
    await mkdir(join(icuDataDirectory, 'icudt76l/coll'), { recursive: true });
    await writeFile(join(icuDataDirectory, 'icudt76l/coll/root.res'), 'icu');
    assert.deepEqual(await resolveExactNativeRuntimeProfile(icu), {
      icuDataDirectory,
      catalogProfile: 'icu',
    });

    const malformed = join(root, 'malformed');
    await mkdir(join(malformed, 'share/icu/icudt76l'), { recursive: true });
    await assert.rejects(
      resolveExactNativeRuntimeProfile(malformed),
      /does not contain a usable icudt payload/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
