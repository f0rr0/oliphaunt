import { expect, test } from 'bun:test';
import { androidNdkMetadata } from './metadata.mts';
import {
  androidReleaseDependencies,
  nativeAndroidPackages,
  reactNativeRuntimeDependencies,
} from './native-metadata.mts';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const input = {
  packages: { ndk: '27.0.12077973', expo_ndk: '27.1.12297006' },
  ndk: {
    linux: {
      url: 'https://dl.google.com/android/repository/android-ndk-r27-linux.zip',
      sha256: 'a'.repeat(64),
      strip_prefix: 'android-ndk-r27',
    },
  },
};

test('native Android reads the canonical NDK and minimum platform API', () => {
  expect(androidNdkMetadata(input)).toEqual({
    revision: '27.0.12077973',
    api: 24,
    page_alignment: 16_384,
    ...input.ndk.linux,
  });
  expect(
    androidNdkMetadata({
      ...input,
      ndk: { linux: { ...input.ndk.linux, api: 99, revision: '1.0.0', page_alignment: 4096 } },
    }),
  ).toEqual(androidNdkMetadata(input));
});

test('native Android cannot import unpinned, foreign or inconsistent archives', () => {
  expect(() => androidNdkMetadata({ ...input, packages: { ndk: 'latest' } })).toThrow();
  for (const patch of [
    { sha256: '' },
    { url: 'https://example.invalid/ndk.zip' },
    { strip_prefix: '../ndk' },
  ]) {
    expect(() =>
      androidNdkMetadata({ ...input, ndk: { linux: { ...input.ndk.linux, ...patch } } }),
    ).toThrow();
  }
});

test('native discovery preserves duplicate JS tools and excludes unrelated Expo prefixes', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'oliphaunt-native-discovery-'));
  try {
    const packages = [
      { package: '@expo/json-file', version: '1.0.0', root: path.join(root, 'json-one') },
      { package: '@expo/json-file', version: '2.0.0', root: path.join(root, 'json-two') },
      { package: 'exponential-backoff', version: '1.0.0', root: path.join(root, 'unrelated') },
      { package: 'expo-source-module', version: '56.0.0', root: path.join(root, 'native') },
    ];
    for (const row of packages) mkdirSync(row.root, { recursive: true });
    for (const row of packages.slice(2)) {
      mkdirSync(path.join(row.root, 'android'));
      writeFileSync(
        path.join(row.root, 'android/build.gradle'),
        'namespace "expo.modules.fixture"',
      );
    }
    expect(nativeAndroidPackages(packages)).toEqual([packages[3]]);
    expect(packages.slice(0, 2).map((row) => row.version)).toEqual(['1.0.0', '2.0.0']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('native discovery rejects ambiguous actual Android implementations', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'oliphaunt-native-discovery-'));
  try {
    const packages = ['56.0.0', '56.0.1'].map((version) => ({
      package: 'expo-source-module',
      version,
      root: path.join(root, version),
    }));
    for (const row of packages) {
      mkdirSync(path.join(row.root, 'android'), { recursive: true });
      writeFileSync(
        path.join(row.root, 'android/build.gradle'),
        'namespace "expo.modules.fixture"',
      );
    }
    expect(() => nativeAndroidPackages(packages)).toThrow('one exact locked package identity');
    expect(nativeAndroidPackages([packages[0], packages[0]])).toEqual([packages[0]]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('withoutCompose release preserves active roots and omits the disabled Gradle branch', () => {
  const source = `
dependencies {
  implementation 'androidx.core:core-ktx:1.17.0'
  if (shouldIncludeCompose) {
    // A commented closing brace } cannot end the branch.
    if (enabled) {
      implementation "androidx.compose.foundation:foundation-android:\${composeVersion}"
    }
  }
  releaseCompileOnly 'androidx.compose.foundation:foundation-android:1.9.0'
  implementation 'com.facebook.react:react-android'
}
`;
  expect(androidReleaseDependencies(source, '2.2.21', '0.85.3', true)).toEqual([
    'androidx.core:core-ktx:1.17.0',
    'androidx.compose.foundation:foundation-android:1.9.0',
    'com.facebook.react:react-android:aar:release:0.85.3',
  ]);
  expect(() =>
    androidReleaseDependencies('if (shouldIncludeCompose) {', '2.2.21', '0.85.3', true),
  ).toThrow('Unterminated');
});

test('Compose-enabled projection retains its source-declared dependency version', () => {
  const source = `def composeVersion = "1.7.6"
dependencies {
  if (shouldIncludeCompose) {
    implementation "androidx.compose.foundation:foundation-android:$composeVersion"
  }
}`;
  expect(androidReleaseDependencies(source, '2.2.21', '0.85.3')).toEqual([
    'androidx.compose.foundation:foundation-android:1.7.6',
  ]);
  expect(androidReleaseDependencies(source, '2.2.21', '0.85.3', true)).toEqual([]);
});

test('React Native release runtime follows source catalog aliases and excludes test/compile-only roots', () => {
  const source = `dependencies {
  api(libs.fresco.imagepipeline.okhttp3)
  implementation(libs.soloader)
  runtimeOnly(libs.fresco)
  compileOnly(libs.javax.annotation.api)
  testImplementation(libs.junit)
}`;
  const catalog = `[versions]
fresco = "3.6.0"
soloader = "0.12.1"
[libraries]
fresco-imagepipeline-okhttp3 = { module = "com.facebook.fresco:imagepipeline-okhttp3", version.ref = "fresco" }
fresco = { module = "com.facebook.fresco:fresco", version.ref = "fresco" }
soloader = { group = "com.facebook.soloader", name = "soloader", version.ref = "soloader" }
`;
  expect(reactNativeRuntimeDependencies(source, catalog)).toEqual([
    'com.facebook.fresco:fresco:3.6.0',
    'com.facebook.fresco:imagepipeline-okhttp3:3.6.0',
    'com.facebook.soloader:soloader:0.12.1',
  ]);
  expect(() => reactNativeRuntimeDependencies('api(libs.missing)', catalog)).toThrow(
    'alias missing',
  );
  expect(() => reactNativeRuntimeDependencies('testImplementation(libs.junit)', catalog)).toThrow(
    'declarations are missing',
  );
});
