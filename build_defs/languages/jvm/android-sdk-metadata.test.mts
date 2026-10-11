import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { androidSdkMetadata, verifyAndroidSdk } from './android-sdk-metadata.mts';

const manifest = Bun.TOML.parse(
  readFileSync(new URL('../../../tools/dev/android-sdk.toml', import.meta.url), 'utf8'),
);

test('acquisition derives exact versions and checked archives from the conventional SDK manifest', () => {
  const metadata = androidSdkMetadata(manifest);
  expect(metadata.api).toBe(Number(manifest.packages.compile_sdk));
  expect(metadata.buildTools).toBe(manifest.packages.build_tools);
  expect(metadata.platformTools).toBe(manifest.packages.platform_tools);
  expect(metadata.archives.map(({ directory }) => directory)).toEqual([
    'platforms/android-36',
    'build-tools/36.0.0',
    'platform-tools',
  ]);
  for (const update of [
    (value) => {
      value.platform.sha256 = '';
    },
    (value) => {
      value.platform.url = 'https://example.com/sdk.zip';
    },
    (value) => {
      value.packages.compile_sdk = '37';
    },
    (value) => {
      value.build_tools.linux.strip_prefix = '../outside';
    },
  ]) {
    const value = structuredClone(manifest);
    update(value);
    expect(() => androidSdkMetadata(value)).toThrow();
  }
  expect(() => androidSdkMetadata(manifest, { os: 'darwin', arch: 'arm64' })).toThrow(
    'Linux x86_64',
  );
});

test('downloaded SDK package properties must exactly match the pinned acquisition contract', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'oliphaunt-sdk-properties-'));
  const metadata = androidSdkMetadata(manifest);
  const files = [
    ['platforms/android-36/source.properties', 'AndroidVersion.ApiLevel=36\nPkg.Revision=2\n'],
    ['build-tools/36.0.0/source.properties', 'Pkg.Revision=36.0.0\n'],
    ['platform-tools/source.properties', 'Pkg.Revision=37.0.0\n'],
  ];
  try {
    for (const [relative, text] of files) {
      const file = path.join(directory, relative);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, text);
    }
    expect(() => verifyAndroidSdk(directory, metadata)).not.toThrow();
    for (const [relative, text] of files) {
      const file = path.join(directory, relative);
      writeFileSync(file, 'Pkg.Revision=0\n');
      expect(() => verifyAndroidSdk(directory, metadata)).toThrow('package identities');
      writeFileSync(file, text);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
