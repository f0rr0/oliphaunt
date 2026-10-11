import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { cargoLinkEnvironment } from './cargo-consumer-test.mts';

test('installed Cargo proof retains registered Apple SDK link flags with declared runfiles paths', () => {
  const environment = cargoLinkEnvironment(
    {
      linker: 'external/compiler/bin/clang',
      args: ['-isysroot', 'external/sdk/MacOSX.sdk', '-Wl,-no_uuid'],
      env: { SDKROOT: 'external/sdk/MacOSX.sdk', DEVELOPER_DIR: 'external/sdk' },
      roots: { 'external/compiler': 'compiler', 'external/sdk': 'sdk' },
    },
    '/runfiles',
  );
  const sdk = join('/runfiles', 'sdk');
  const compiler = join('/runfiles', 'compiler');
  expect(environment.SDKROOT).toBe(`${sdk}/MacOSX.sdk`);
  expect(environment.DEVELOPER_DIR).toBe(sdk);
  expect(environment.CARGO_ENCODED_RUSTFLAGS.split('\x1f')).toEqual([
    `-Clinker=${compiler}/bin/clang`,
    '-Clink-arg=-isysroot',
    `-Clink-arg=${sdk}/MacOSX.sdk`,
    '-Clink-arg=-Wl,-no_uuid',
  ]);
});

test('installed Cargo proof retains Windows LIB/INCLUDE and arguments containing spaces', () => {
  const environment = cargoLinkEnvironment(
    {
      linker: 'external/compiler/bin/link.exe',
      args: ['/LIBPATH:external/sdk/lib/um x64', '/NOLOGO'],
      env: {
        LIB: 'external/sdk/lib/ucrt;external/sdk/lib/um x64',
        INCLUDE: 'external/sdk/include',
      },
      roots: { 'external/compiler': 'compiler', 'external/sdk': 'sdk' },
    },
    '/runfiles',
  );
  const sdk = join('/runfiles', 'sdk');
  const compiler = join('/runfiles', 'compiler');
  expect(environment.LIB).toBe(`${sdk}/lib/ucrt;${sdk}/lib/um x64`);
  expect(environment.INCLUDE).toBe(`${sdk}/include`);
  expect(environment.CARGO_ENCODED_RUSTFLAGS.split('\x1f')).toEqual([
    `-Clinker=${compiler}/bin/link.exe`,
    `-Clink-arg=/LIBPATH:${sdk}/lib/um x64`,
    '-Clink-arg=/NOLOGO',
  ]);
});
