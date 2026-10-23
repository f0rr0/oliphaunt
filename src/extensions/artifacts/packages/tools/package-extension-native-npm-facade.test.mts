import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readPortableArchiveEntries } from '../../../../../tools/packaging/portable-archive.mts';
import { IOS_CARRIER_FILENAME } from '../../../../native/sdks/swift/tools/ios-carrier-manifest.mts';
import { stageExtensionNativeNpmFacade } from './package-extension-release-carriers.mts';

const directories = [];
afterEach(() => {
  while (directories.length) rmSync(directories.pop(), { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'extension-npm-facade-test-'));
  directories.push(root);
  const iosCarrier = JSON.parse(
    readFileSync(
      path.resolve(
        import.meta.dirname,
        '../../../../../build_defs/release/testdata/swift-0.8.2-carrier.json',
      ),
      'utf8',
    ),
  );
  iosCarrier.extensions = [
    {
      product: 'oliphaunt-extension-pgtap',
      version: '1.3.4',
      sqlName: 'pgtap',
      assets: [{ role: 'runtime-resources', carrier: 'pgtap-ios-fixture.tar.gz' }],
    },
  ];
  return {
    root,
    metadata: {
      product: 'oliphaunt-extension-pgtap',
      version: '1.3.4',
      members: ['pgtap'],
      targets: ['linux-arm64-gnu', 'linux-x64-gnu', 'macos-arm64', 'windows-x64-msvc'],
      iosCarrier,
      liboliphauntVersion: iosCarrier.base.version,
      runtimeBound: false,
    },
    result: { staged: [], skipped: [] },
  };
}

test('facade packing preserves Apple metadata and every supplied desktop identity', () => {
  const { root, metadata, result } = fixture();
  const tarball = stageExtensionNativeNpmFacade(
    path.join(root, 'package'),
    path.join(root, 'tarballs'),
    metadata,
    result,
  );
  expect(tarball).not.toBeNull();
  const entries = readPortableArchiveEntries(tarball);
  const manifest = JSON.parse(entries.get('package/package.json').data().toString('utf8'));
  expect(manifest.name).toBe('@oliphaunt/extension-pgtap');
  expect(Object.keys(manifest.oliphaunt.targetPackageNames)).toEqual(metadata.targets);
  expect(manifest.optionalDependencies).toEqual(
    Object.fromEntries(
      metadata.targets.map((target) => [`@oliphaunt/extension-pgtap-${target}`, metadata.version]),
    ),
  );
  expect(
    JSON.parse(entries.get(`package/${IOS_CARRIER_FILENAME}`).data().toString('utf8')),
  ).toEqual(metadata.iosCarrier);
  expect(entries.has('package/LICENSE')).toBe(true);
  expect(result.staged).toHaveLength(1);
});

test('single Linux facade retains the legacy optional Apple metadata contract', () => {
  const { root, metadata, result } = fixture();
  metadata.targets = ['linux-x64-gnu'];
  metadata.iosCarrier = undefined;
  const tarball = stageExtensionNativeNpmFacade(
    path.join(root, 'package'),
    path.join(root, 'tarballs'),
    metadata,
    result,
  );
  expect(tarball).not.toBeNull();
  const manifest = JSON.parse(
    readPortableArchiveEntries(tarball).get('package/package.json').data().toString('utf8'),
  );
  expect(manifest.optionalDependencies).toEqual({
    '@oliphaunt/extension-pgtap-linux-x64-gnu': metadata.version,
  });
  expect(result.staged).toHaveLength(1);
});

test('facade rejects missing targets, repeated members and mismatched Apple identities', () => {
  const { root, metadata, result } = fixture();
  const stage = () =>
    stageExtensionNativeNpmFacade(
      path.join(root, 'package'),
      path.join(root, 'tarballs'),
      metadata,
      result,
    );
  const targets = metadata.targets;
  metadata.targets = [];
  expect(stage).toThrow('explicit non-empty unique target list');
  metadata.targets = targets;
  metadata.members = ['pgtap', 'pgtap'];
  expect(stage).toThrow('unique members');
  metadata.members = ['pgtap'];
  metadata.iosCarrier.extensions[0].version = '1.3.5';
  expect(stage).toThrow('mismatched Apple carrier identity');
  expect(result.staged).toEqual([]);
});

test('facade requires Apple identity for an explicit iOS target and checks it when supplied', () => {
  const { root, metadata, result } = fixture();
  metadata.iosCarrier = undefined;
  metadata.targets = ['ios-xcframework'];
  const stage = () =>
    stageExtensionNativeNpmFacade(
      path.join(root, 'package'),
      path.join(root, 'tarballs'),
      metadata,
      result,
    );
  expect(stage).toThrow('mismatched Apple carrier identity');
  metadata.targets = ['linux-x64-gnu'];
  metadata.iosCarrier = null;
  expect(stage).toThrow('mismatched Apple carrier identity');
  expect(result.staged).toEqual([]);
});
