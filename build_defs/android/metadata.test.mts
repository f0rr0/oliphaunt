import { expect, test } from 'bun:test';
import { androidNdkMetadata } from './metadata.mts';

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
