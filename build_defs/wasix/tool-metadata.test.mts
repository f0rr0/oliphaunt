import { expect, test } from 'bun:test';
import { DESKTOP_TARGETS } from '../../tools/release/release-artifact-targets.mts';
import { aotProfiles, llvmPins, llvmSysVersion } from './tool-metadata.mts';

test('AOT targets use their own canonical engine pins', () => {
  const targets = {
    linux: 'x86_64-unknown-linux-gnu',
    apple: 'aarch64-apple-darwin',
    windows: 'x86_64-pc-windows-msvc',
  };
  const toolchain = { wasmer: '1.2.3', 'wasmer-wasix': '2.3.4' };
  const sources = {
    crates: { wasmer: { version: '3.4.5' }, 'wasmer-wasix': { version: '4.5.6' } },
  };
  const profiles = aotProfiles(targets, toolchain, sources);
  expect(profiles.linux).toEqual({
    engine: 'llvm-opta',
    wasmer_version: '1.2.3',
    wasmer_wasix_version: '2.3.4',
  });
  expect(profiles.apple).toEqual(profiles.linux);
  expect(profiles.windows).toEqual({
    engine: 'v8',
    wasmer_version: '3.4.5',
    wasmer_wasix_version: '4.5.6',
  });
  expect(() => aotProfiles(targets, toolchain, { crates: {} })).toThrow('canonical engine pins');
  expect(() => aotProfiles(targets, { ...toolchain, wasmer: '' }, sources)).toThrow(
    'canonical engine pins',
  );
});

test('LLVM projection preserves canonical host pins without product metadata', () => {
  const result = llvmPins(DESKTOP_TARGETS, '221.0.0');
  const canonical = DESKTOP_TARGETS['linux-x64-gnu'];
  expect(result.hosts['linux-x64-gnu']).toEqual({
    triple: canonical.triple,
    url: canonical.wasixLlvmUrl,
    sha256: canonical.wasixLlvmSha256,
    bytes: canonical.wasixLlvmBytes,
  });
  expect(result.version).toBe('22.1');
  expect(result.llvm_sys_abi).toBe(221);
  expect(result.unavailable).toEqual(['macos-x64']);
  expect(JSON.stringify(result)).not.toContain('wasixNapiPackage');
});

test('LLVM projection rejects incomplete or unsafe acquisition pins', () => {
  const canonical = DESKTOP_TARGETS['linux-x64-gnu'];
  for (const bad of [
    { ...canonical, wasixLlvmUrl: undefined },
    { ...canonical, wasixLlvmSha256: 'bad' },
    { ...canonical, wasixLlvmBytes: 0 },
    { ...canonical, wasixLlvmUrl: 'http://example.invalid/llvm.tar.xz' },
  ])
    expect(() => llvmPins({ host: bad }, '221.0.0')).toThrow();
});

test('LLVM ABI comes from the selected locked Wasmer compiler dependency', () => {
  const compiler = {
    name: 'wasmer-compiler-llvm',
    version: 'fixture',
    dependencies: ['llvm-sys 221.0.0'],
  };
  const llvm = { name: 'llvm-sys', version: '221.0.0' };
  expect(llvmSysVersion([compiler, llvm, { ...llvm, version: '180.0.0' }], 'fixture')).toBe(
    llvm.version,
  );
  expect(
    llvmSysVersion(
      [
        { ...compiler, dependencies: ['inkwell'] },
        { name: 'inkwell', version: 'fixture', dependencies: ['llvm-sys 221.0.0'] },
        llvm,
      ],
      'fixture',
    ),
  ).toBe(llvm.version);
  expect(() => llvmSysVersion([compiler], 'fixture')).toThrow();
  expect(() =>
    llvmSysVersion(
      [{ ...compiler, dependencies: ['llvm-sys'] }, llvm, { ...llvm, version: '180.0.0' }],
      'fixture',
    ),
  ).toThrow('ambiguous');
});
