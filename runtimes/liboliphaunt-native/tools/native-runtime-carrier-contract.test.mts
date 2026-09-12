import { expect, test } from 'bun:test';

import { bindNativeRuntimeResourceManifest } from './native-runtime-carrier-contract.mts';
import { nativeRuntimeResourceManifestFixture } from '../../../runtimes/liboliphaunt-native/tools/testdata/native-runtime-fixture.mts';

test('binds only the exact native-direct runtime resource contract', () => {
  const bound = bindNativeRuntimeResourceManifest(
    nativeRuntimeResourceManifestFixture(),
    'android-datum64',
  );
  expect(bound.toString('utf8')).toContain('clusterSeedTarget=android-datum64\n');
  expect(() =>
    bindNativeRuntimeResourceManifest(
      nativeRuntimeResourceManifestFixture({ extra: { legacy: 'value' } }),
      'android-datum64',
    ),
  ).toThrow(/exact canonical field set/u);
  expect(() =>
    bindNativeRuntimeResourceManifest(
      nativeRuntimeResourceManifestFixture({ overrides: { cacheKey: '..' } }),
      'android-datum64',
    ),
  ).toThrow(/native-direct contract/u);
  expect(() =>
    bindNativeRuntimeResourceManifest(
      nativeRuntimeResourceManifestFixture({ overrides: { mode: 'native-server' } }),
      'android-datum64',
    ),
  ).toThrow(/native-direct contract/u);
});
