import test from 'node:test';
import { iosBaseLegalMetadata } from '../../swift/tools/ios-carrier-manifest.mts';
import assert from 'node:assert/strict';
import { validateReactNativePackagedCarrier } from './check-package.mts';

function selectionNeutralCarrier(version = '1.2.3') {
  const product = 'liboliphaunt-native';
  const tag = `${product}-v${version}`;
  const assets = [
    [
      'base-xcframework',
      `liboliphaunt-${version}-apple-spm-xcframework.zip`,
      'zip',
      'liboliphaunt.xcframework',
      'a',
    ],
    [
      'runtime-resources',
      `liboliphaunt-${version}-runtime-resources-ios-datum64.tar.gz`,
      'tar.gz',
      'oliphaunt',
      'b',
    ],
  ].map(([role, name, format, member, digit], index) => ({
    bytes: index + 1,
    format,
    member,
    name,
    role,
    sha256: digit.repeat(64),
    url: `https://github.com/f0rr0/oliphaunt/releases/download/${tag}/${name}`,
  }));
  return {
    base: { assets, product, tag, version },
    carriers: [],
    extensions: [],
    legal: { base: iosBaseLegalMetadata(), extensions: [] },
    schema: 'oliphaunt-react-native-ios-carrier-v1',
  };
}

test('binds the React Native npm carrier bytes to selection-neutral staged evidence', () => {
  const member = 'package/oliphaunt-react-native-ios-carriers.json';
  const bytes = Buffer.from(`${JSON.stringify(selectionNeutralCarrier(), null, 2)}\n`);
  assert.deepEqual(
    validateReactNativePackagedCarrier({
      artifact: 'oliphaunt-react-native.tgz',
      evidence: bytes,
      expectedNativeVersion: '1.2.3',
      memberBytes: bytes,
      names: [member],
    }),
    selectionNeutralCarrier(),
  );

  assert.throws(
    () =>
      validateReactNativePackagedCarrier({
        artifact: 'missing.tgz',
        evidence: bytes,
        expectedNativeVersion: '1.2.3',
        memberBytes: Buffer.alloc(0),
        names: [],
      }),
    /must contain exactly one/u,
  );
  assert.throws(
    () =>
      validateReactNativePackagedCarrier({
        artifact: 'skewed.tgz',
        evidence: bytes,
        expectedNativeVersion: '1.2.3',
        memberBytes: Buffer.from(`${JSON.stringify(selectionNeutralCarrier('1.2.4'))}\n`),
        names: [member],
      }),
    /byte-for-byte match/u,
  );
  assert.throws(
    () =>
      validateReactNativePackagedCarrier({
        artifact: 'wrong-version.tgz',
        evidence: Buffer.from(`${JSON.stringify(selectionNeutralCarrier('1.2.4'))}\n`),
        expectedNativeVersion: '1.2.3',
        memberBytes: Buffer.from(`${JSON.stringify(selectionNeutralCarrier('1.2.4'))}\n`),
        names: [member],
      }),
    /must match liboliphaunt-native 1\.2\.3/u,
  );
});
