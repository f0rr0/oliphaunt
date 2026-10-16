import { expect, test } from 'bun:test';

import {
  nativeExtensionDependencyModulePaths,
  validateExtensionTargetProfiles,
} from './extension-target-profiles.mts';

function fixture() {
  return {
    schema: 'oliphaunt-extension-artifact-target-profiles-v1',
    profiles: [
      {
        id: 'native-v1',
        targets: [{ target: 'linux-x64-gnu', family: 'native', kind: 'native-dynamic' }],
      },
    ],
  };
}

test('normalizes the minimal target identity contract', () => {
  expect(validateExtensionTargetProfiles(fixture()).targets).toEqual([
    {
      profileId: 'native-v1',
      target: 'linux-x64-gnu',
      family: 'native',
      kind: 'native-dynamic',
    },
  ]);
});

test('rejects intermediate state fields', () => {
  const raw = fixture();
  raw.profiles[0].targets[0].status = 'supported';
  expect(() => validateExtensionTargetProfiles(raw)).toThrow(
    /fields must be exactly family, kind, target/u,
  );
});

test('rejects a target declared by more than one profile', () => {
  const raw = fixture();
  raw.profiles.push({ ...raw.profiles[0], id: 'duplicate-v1' });
  expect(() => validateExtensionTargetProfiles(raw)).toThrow(/duplicate target linux-x64-gnu/u);
});

test('native dependency overrides select only a declared desktop host subset', () => {
  const files = ['lib/postgresql/private.so'];
  const overrides = { 'windows-x64-msvc': [] };
  expect(nativeExtensionDependencyModulePaths(files, 'windows-x64-msvc', overrides)).toEqual([]);
  for (const target of [
    'linux-x64-gnu',
    'linux-arm64-gnu',
    'macos-arm64',
    'ios-xcframework',
    'android-arm64-v8a',
  ])
    expect(nativeExtensionDependencyModulePaths(files, target, overrides)).toEqual(files);
  expect(() => nativeExtensionDependencyModulePaths(files, 'linux-x64-gnu', { typo: [] })).toThrow(
    /desktop native target/u,
  );
  expect(() =>
    nativeExtensionDependencyModulePaths(files, 'linux-x64-gnu', {
      'windows-x64-msvc': ['lib/postgresql/foreign.so'],
    }),
  ).toThrow(/declared module paths/u);
  expect(() =>
    nativeExtensionDependencyModulePaths(files, 'linux-x64-gnu', { 'windows-x64-msvc': 'invalid' }),
  ).toThrow(/declared module paths/u);
  expect(() => nativeExtensionDependencyModulePaths(files, undefined, [])).toThrow(
    /must be a table/u,
  );
});
