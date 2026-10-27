import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDeterministicTar } from '../../tools/packaging/package-archive.mts';
import {
  canonicalGzipSync,
  extractPortableArchiveTree,
  readFileOnlyTarGzipEntries,
} from '../../tools/packaging/portable-archive.mts';
import { cargoLinkEnvironment, sourceCrateRoot } from './cargo-consumer-test.mts';
import { archive as packageEnvelope } from './package.mts';

test('installed Cargo source accepts canonical directory entries and rejects malformed source envelopes', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'oliphaunt-query-cargo-contract-'));
  try {
    const stage = join(scratch, 'stage');
    mkdirSync(join(stage, 'src'), { recursive: true });
    writeFileSync(join(stage, 'Cargo.toml'), '[package]\nname="fixture"\nversion="1.2.3"\n');
    writeFileSync(join(stage, 'src/lib.rs'), 'pub fn proof() {}\n');
    const archive = join(scratch, 'fixture.crate');
    const packageArchive = (mode = 0o644) =>
      writeFileSync(
        archive,
        canonicalGzipSync(createDeterministicTar(stage, 'fixture-1.2.3', { fixedFileMode: mode })),
      );
    packageArchive();
    expect(() => readFileOnlyTarGzipEntries(archive)).toThrow('must be a regular mode=644 file');
    expect(sourceCrateRoot(archive)).toBe('fixture-1.2.3');
    const installed = join(scratch, 'installed');
    extractPortableArchiveTree(archive, installed, sourceCrateRoot(archive));
    expect(readFileSync(join(installed, 'src/lib.rs'), 'utf8')).toBe('pub fn proof() {}\n');
    packageArchive(0o755);
    expect(() => sourceCrateRoot(archive)).toThrow('regular mode 0644 files');
    writeFileSync(join(stage, 'src/Cargo.toml'), '[package]\nname="extra"\nversion="1.2.3"\n');
    packageArchive();
    expect(() => sourceCrateRoot(archive)).toThrow('one Cargo manifest');
    writeFileSync(
      archive,
      packageEnvelope({
        'fixture-1.2.3/Cargo.toml': Buffer.from('[package]\nname="fixture"\nversion="1.2.3"\n'),
        'other/src/lib.rs': Buffer.from('pub fn unowned() {}\n'),
      }),
    );
    expect(() => sourceCrateRoot(archive)).toThrow('inside their package root');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

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
