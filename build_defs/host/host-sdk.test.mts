import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  appleDeploymentTargets,
  captureHostSdk,
  parsePolicy,
  verifyWindowsVersions,
} from './host-sdk.mts';

const policy = JSON.parse(readFileSync('tools/dev/native-host-toolchains.json', 'utf8'));
const environment = {
  VSCMD_VER: '18.0.4',
  VCToolsVersion: '14.50.35717\\',
  WindowsSDKVersion: '10.0.26100.0\\',
  VSCMD_ARG_HOST_ARCH: 'x64',
  VSCMD_ARG_TGT_ARCH: 'x64',
};

describe('declared native host SDK policy', () => {
  test('deployment profiles project the existing public artifact compatibility contract', () => {
    expect(appleDeploymentTargets()).toEqual({
      native_macos: '11.0.0',
      package_macos: '14.0.0',
      ios: '17.0.0',
      ios_simulator: '17.0.0',
    });
  });
  test('existing supported toolset family accepts exact selected versions', () => {
    const parsed = parsePolicy(policy);
    verifyWindowsVersions(environment, parsed.windows);
    verifyWindowsVersions({ ...environment, VSCMD_VER: '18.1.9' }, parsed.windows);
    verifyWindowsVersions({ ...environment, VCToolsVersion: '14.59.1' }, parsed.windows);
  });
  test('unsupported families, architecture and missing identities fail', () => {
    for (const mutation of [
      { VSCMD_VER: '17.0.1' },
      { VSCMD_VER: undefined },
      { VCToolsVersion: '14.49.1' },
      { VCToolsVersion: '14.60.1' },
      { WindowsSDKVersion: '11.0.1' },
      { VSCMD_ARG_HOST_ARCH: 'arm64' },
      { VSCMD_ARG_TGT_ARCH: 'arm64' },
      { VCToolsVersion: undefined },
      { WindowsSDKVersion: '10.0\n26100' },
    ])
      expect(() =>
        verifyWindowsVersions({ ...environment, ...mutation }, policy.windows),
      ).toThrow();
  });
  test('malformed policy does not provide a default or silently widen support', () => {
    for (const mutation of [
      null,
      {},
      { ...policy, apple: {} },
      {
        ...policy,
        apple: { ...policy.apple, developer_dir: '/Applications/Xcode.app/Contents/Developer' },
      },
      { ...policy, windows: { ...policy.windows, vc_toolset_minor_max_exclusive: 50 } },
      { ...policy, windows: { ...policy.windows, visual_studio_major: '18' } },
    ])
      expect(() => parsePolicy(mutation)).toThrow();
  });
  test('licensed SDK acquisition rejects this Linux client', () => {
    if (process.platform === 'linux') {
      expect(() => captureHostSdk(policy, 'apple')).toThrow('incompatible host');
      expect(() => captureHostSdk(policy, 'msvc')).toThrow('incompatible host');
    }
    expect(() => captureHostSdk(policy, 'unknown')).toThrow('unknown host SDK');
  });
});
