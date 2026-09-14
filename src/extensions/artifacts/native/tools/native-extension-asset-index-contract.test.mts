import { expect, test } from 'bun:test';

import { isCanonicalNativeExtensionRuntimeIndexRow } from './native-extension-asset-index-contract.mts';

test('the raw native extension index uses the canonical runtime carrier kind', () => {
  const canonical = {
    sql_name: 'amcheck',
    target: 'linux-x64-gnu',
    kind: 'runtime',
    identity: '-',
    artifact: 'amcheck.tar.gz',
    artifact_bytes: '1',
    registration_artifact: '-',
  };
  expect(isCanonicalNativeExtensionRuntimeIndexRow(canonical, 'linux-x64-gnu')).toBe(true);
  expect(
    isCanonicalNativeExtensionRuntimeIndexRow(
      {
        ...canonical,
        kind: 'runtime-extension',
      },
      'linux-x64-gnu',
    ),
  ).toBe(false);
});
