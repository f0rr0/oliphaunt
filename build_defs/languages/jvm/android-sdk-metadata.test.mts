import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  androidEmulatorMetadata,
  androidLocalPackageDocuments,
  androidSdkMetadata,
  verifyAndroidEmulator,
  verifyAndroidSdk,
} from './android-sdk-metadata.mts';

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

test('installed emulator pins are lazy and remain independent of the compiler SDK archives', () => {
  const metadata = androidEmulatorMetadata(manifest);
  expect(metadata.api).toBe(35);
  expect(metadata.abi).toBe('x86_64');
  expect(metadata.tag).toBe('google_atd');
  expect(metadata.version).toBe(manifest.packages.emulator);
  expect(metadata.archives.map((row) => row.role)).toEqual([
    'emulator',
    'system-image',
    'command-line-tools',
  ]);
  const compiler = androidSdkMetadata(manifest);
  const value = structuredClone(manifest);
  value.emulator.linux.sha256 = '';
  expect(() => androidEmulatorMetadata(value)).toThrow('immutable');
  expect(androidSdkMetadata(value)).toEqual(compiler);
  for (const update of [
    (value) => {
      value.system_image.linux_x86_64.api = '36';
    },
    (value) => {
      value.system_image.linux_x86_64.abi = 'arm64-v8a';
    },
    (value) => {
      value.emulator.linux.url = 'https://example.com/emulator.zip';
    },
    (value) => {
      value.system_image.linux_x86_64.strip_prefix = '../outside';
    },
    (value) => {
      value.packages.command_line_tools_build = '0';
    },
  ]) {
    const value = structuredClone(manifest);
    update(value);
    expect(() => androidEmulatorMetadata(value)).toThrow();
  }
});

test('offline AVD package documents derive from verified original properties and do not rewrite test inputs', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'oliphaunt-emulator-properties-'));
  const metadata = androidEmulatorMetadata(manifest);
  const input = {
    'emulator/source.properties': `Pkg.Revision=${metadata.version}\n`,
    'cmdline-tools/latest/source.properties': `Pkg.Revision=${metadata.commandLineToolsRevision}\n`,
    [metadata.imagePath + '/source.properties']:
      `Pkg.Revision=${metadata.imageRevision}\nAndroidVersion.ApiLevel=${metadata.api}\nAndroidVersion.ExtensionLevel=13\nAndroidVersion.IsBaseSdk=true\nSystemImage.TagId=${metadata.tag}\nSystemImage.TagDisplay=Google APIs ATD\nSystemImage.Abi=${metadata.abi}\nAddon.VendorId=google\nAddon.VendorDisplay=Google Inc.\nPkg.Desc=Original API35 image\nPkg.Dependencies=emulator#32.1.8\n`,
  };
  try {
    for (const [relative, text] of Object.entries(input)) {
      mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
      writeFileSync(path.join(root, relative), text);
    }
    expect(() => verifyAndroidEmulator(root, metadata)).not.toThrow();
    const docs = androidLocalPackageDocuments(root, metadata);
    expect(docs['emulator/package.xml']).toContain(
      `<major>${metadata.version.split('.')[0]}</major>`,
    );
    expect(docs[metadata.imagePath + '/package.xml']).toContain(
      `<api-level>${metadata.api}</api-level>`,
    );
    expect(docs[metadata.imagePath + '/package.xml']).toContain(
      '<extension-level>13</extension-level>',
    );
    for (const [relative, text] of Object.entries(input))
      expect(readFileSync(path.join(root, relative), 'utf8')).toBe(text);
    const image = path.join(root, metadata.imagePath, 'source.properties');
    for (const [from, to] of [
      [`AndroidVersion.ApiLevel=${metadata.api}`, 'AndroidVersion.ApiLevel=36'],
      ['SystemImage.Abi=x86_64', 'SystemImage.Abi=arm64-v8a'],
      ['emulator#32.1.8', 'emulator#99.0.0'],
    ]) {
      writeFileSync(image, input[metadata.imagePath + '/source.properties'].replace(from, to));
      expect(() => verifyAndroidEmulator(root, metadata)).toThrow();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
