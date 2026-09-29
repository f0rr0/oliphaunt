import test from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { stageArtifacts } from './stage-release-artifacts.mts';
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

test('package staging accepts frozen current iOS metadata and rejects stale or corrupt metadata', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'rn-frozen-carrier-'));
  const previous = process.env.OLIPHAUNT_REACT_NATIVE_IOS_BASE_CARRIER;
  try {
    const version = readFileSync(
      new URL('../../../runtime/VERSION', import.meta.url),
      'utf8',
    ).trim();
    const carrier = selectionNeutralCarrier(version);
    const frozen = path.join(root, 'frozen.json');
    const work = path.join(root, 'work');
    const artifacts = path.join(root, 'artifacts');
    mkdirSync(path.join(work, 'package'), { recursive: true });
    writeFileSync(path.join(work, 'package/package.json'), '{}');
    writeFileSync(frozen, JSON.stringify(carrier));
    process.env.OLIPHAUNT_REACT_NATIVE_IOS_BASE_CARRIER = frozen;
    stageArtifacts(artifacts, work);
    const evidence = readFileSync(
      path.join(artifacts, 'ios-carriers/oliphaunt-react-native-ios-carriers.json'),
      'utf8',
    );
    assert.deepEqual(JSON.parse(evidence), carrier);
    assert.equal(
      readFileSync(path.join(work, 'package/oliphaunt-react-native-ios-carriers.json'), 'utf8'),
      evidence,
    );
    for (const mutate of [
      (value) => {
        value.base.version = '999.0.0';
      },
      (value) => {
        value.base.assets[0].sha256 = 'invalid';
      },
    ]) {
      const invalid = structuredClone(carrier);
      mutate(invalid);
      writeFileSync(frozen, JSON.stringify(invalid));
      assert.throws(() => stageArtifacts(artifacts, work));
    }
  } finally {
    if (previous === undefined) delete process.env.OLIPHAUNT_REACT_NATIVE_IOS_BASE_CARRIER;
    else process.env.OLIPHAUNT_REACT_NATIVE_IOS_BASE_CARRIER = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
