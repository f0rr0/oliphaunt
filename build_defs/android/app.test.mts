import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'bun:test';
import {
  androidDynamicLinkMetadata,
  assertAndroidElf,
  assertHermesBytecode,
  dexDefinedClasses,
  extractFinalAar,
  mobileBundleEnvironment,
  stageNodeInputs,
} from './app.mts';
import { createDeterministicTar } from '../../tools/packaging/archive-directory.mts';
import {
  canonicalGzipSync,
  readPortableArchiveEntries,
} from '../../tools/packaging/portable-archive.mts';

function dex(names: string[], definitions: number[]) {
  const strings = 112;
  const types = strings + names.length * 4;
  const classes = types + names.length * 4;
  const data = classes + definitions.length * 32;
  const encoded = names.map((name) => Buffer.from(`\x01L${name.replaceAll('.', '/')};\x00`));
  const bytes = Buffer.alloc(data + encoded.reduce((total, row) => total + row.length, 0));
  bytes.write('dex\n035\x00', 0, 'binary');
  for (const [offset, value] of [
    [32, bytes.length],
    [36, 112],
    [40, 0x12345678],
    [56, names.length],
    [60, strings],
    [64, names.length],
    [68, types],
    [96, definitions.length],
    [100, classes],
  ])
    bytes.writeUInt32LE(value, offset);
  let cursor = data;
  for (let index = 0; index < names.length; index++) {
    bytes.writeUInt32LE(cursor, strings + index * 4);
    bytes.writeUInt32LE(index, types + index * 4);
    encoded[index].copy(bytes, cursor);
    cursor += encoded[index].length;
  }
  for (let index = 0; index < definitions.length; index++)
    bytes.writeUInt32LE(definitions[index], classes + index * 32);
  return bytes;
}

test('APK bytecode proof distinguishes actual class definitions from references', () => {
  const names = ['dev.oliphaunt.DatabaseStorage$TemporaryDirectory', 'com.sun.jna.Native'];
  assert.deepEqual([...dexDefinedClasses(dex(names, [0]))], [names[0]]);
  assert.deepEqual([...dexDefinedClasses(dex(names, [0, 1]))], names);
  assert.throws(() => dexDefinedClasses(dex(names, [2])), /invalid type index/u);
  const truncated = dex(names, [0]).subarray(0, 140);
  assert.throws(() => dexDefinedClasses(truncated));
});

function elf(alignment: bigint, machine = 183) {
  const bytes = Buffer.alloc(128);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]);
  bytes.writeUInt16LE(machine, 18);
  bytes.writeBigUInt64LE(64n, 32);
  bytes.writeUInt16LE(56, 54);
  bytes.writeUInt16LE(1, 56);
  bytes.writeUInt32LE(1, 64);
  bytes.writeBigUInt64LE(alignment, 112);
  return bytes;
}

test('JNI proof rejects ABI mismatch and libraries with 4 KiB ELF segments', () => {
  assertAndroidElf(elf(16384n), 'arm64-v8a');
  assert.throws(() => assertAndroidElf(elf(4096n), 'arm64-v8a'), /16 KiB/u);
  assert.throws(() => assertAndroidElf(elf(16384n), 'x86_64'), /machine differs/u);
  const inconsistent = elf(16384n);
  inconsistent.writeBigUInt64LE(128n, 72);
  assert.throws(() => assertAndroidElf(inconsistent, 'arm64-v8a'), /incongruent/u);
});

test('release JS proof rejects source text and truncated Hermes files', () => {
  const bytes = Buffer.alloc(256);
  bytes.writeBigUInt64LE(0x1f1903c103bc1fc6n);
  bytes.writeUInt32LE(bytes.length, 32);
  createHash('sha1')
    .update(bytes.subarray(0, -20))
    .digest()
    .copy(bytes, bytes.length - 20);
  assertHermesBytecode(bytes);
  assert.throws(() =>
    assertHermesBytecode(Buffer.from('globalThis.__OLIPHAUNT_EXPO_SMOKE_PASS=true;')),
  );
  assert.throws(() => assertHermesBytecode(bytes.subarray(0, 8)));
});

test('APK native link proof rejects absent SONAME and build-path dependencies', () => {
  const valid =
    'Dynamic Section:\n  NEEDED       liboliphaunt.so\n  SONAME       liboliphaunt_extensions.so\n';
  assert.deepEqual(androidDynamicLinkMetadata(valid, 'liboliphaunt_extensions.so'), {
    soname: 'liboliphaunt_extensions.so',
    needed: ['liboliphaunt.so'],
  });
  assert.throws(
    () => androidDynamicLinkMetadata('  NEEDED liboliphaunt.so\n', 'liboliphaunt_extensions.so'),
    /omitted its conventional SONAME/u,
  );
  assert.throws(
    () =>
      androidDynamicLinkMetadata(
        valid.replace('liboliphaunt.so', 'bazel-out/android/bin/liboliphaunt.so'),
        'liboliphaunt_extensions.so',
      ),
    /build path/u,
  );
  assert.throws(
    () =>
      androidDynamicLinkMetadata(
        valid.replace('liboliphaunt.so', 'libc.so'),
        'liboliphaunt_extensions.so',
      ),
    /omitted its native runtime dependency/u,
  );
  assert.throws(() => androidDynamicLinkMetadata(valid, 'libappmodules.so'), /SONAME differs/u);
});

test('declared node staging rejects missing dependency and duplicate app input', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'expo-input-test-'));
  try {
    const source = path.join(root, 'input');
    mkdirSync(source);
    writeFileSync(
      path.join(source, 'package.json'),
      JSON.stringify({ name: 'first', version: '1.0.0' }),
    );
    const packages = {
      a: {
        package: 'first',
        version: '1.0.0',
        integrity: 'sha512-AA==',
        source,
        dependencies: { absent: 'b' },
      },
    };
    assert.throws(
      () =>
        stageNodeInputs(path.join(root, 'missing'), {
          packages,
          roots: { first: 'a' },
          sources: [],
          node: '',
          tar: '',
        }),
      /Undeclared npm dependency/u,
    );
    const sources = [0, 1].map(() => ({
      source: path.join(source, 'package.json'),
      destination: 'app.json',
    }));
    assert.throws(
      () =>
        stageNodeInputs(path.join(root, 'duplicate'), {
          packages: { a: { ...packages.a, dependencies: {} } },
          roots: { first: 'a' },
          sources,
          node: '',
          tar: '',
        }),
      /Duplicate app input/u,
    );
    const valid = path.join(root, 'valid');
    stageNodeInputs(valid, {
      packages: { a: { ...packages.a, dependencies: {} } },
      roots: { first: 'a' },
      sources: [sources[0]],
      node: '',
      tar: '',
    });
    assert.equal(
      readFileSync(path.join(valid, 'app.json'), 'utf8'),
      readFileSync(sources[0].source, 'utf8'),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('app-private Android envelope preserves canonical Maven runtime and seed TAR bytes', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'expo-maven-test-'));
  try {
    const runtime = path.join(root, 'runtime');
    mkdirSync(path.join(runtime, 'jni/arm64-v8a'), { recursive: true });
    const library = elf(16384n);
    writeFileSync(path.join(runtime, 'jni/arm64-v8a/liboliphaunt.so'), library);
    const archive = path.join(root, 'runtime.tar.gz');
    writeFileSync(archive, canonicalGzipSync(await createDeterministicTar(runtime)));
    const output = path.join(root, 'runtime.aar');
    await extractFinalAar({
      source: archive,
      output,
      kind: 'runtime',
      package: 'dev.oliphaunt.runtime',
      abi: 'arm64-v8a',
    });
    assert(
      Buffer.from(
        readPortableArchiveEntries(output).get('jni/arm64-v8a/liboliphaunt.so')!.data(),
      ).equals(library),
    );
    await assert.rejects(
      extractFinalAar({
        source: archive,
        output,
        kind: 'runtime',
        package: 'dev.oliphaunt.runtime',
        abi: 'x86_64',
      }),
      /selected JNI/u,
    );
    const seed = path.join(root, 'seed');
    mkdirSync(path.join(seed, 'cluster-seed/files'), { recursive: true });
    writeFileSync(path.join(seed, 'cluster-seed/manifest.properties'), 'physicalFormat=datum64\n');
    writeFileSync(path.join(seed, 'cluster-seed/files/PG_VERSION'), '18\n');
    const seedArchive = path.join(root, 'seed.tar.gz');
    writeFileSync(seedArchive, canonicalGzipSync(await createDeterministicTar(seed)));
    const seedOutput = path.join(root, 'seed.aar');
    await extractFinalAar({
      source: seedArchive,
      output: seedOutput,
      kind: 'seed',
      package: 'dev.oliphaunt.resources',
    });
    const entries = readPortableArchiveEntries(seedOutput);
    assert.equal(
      Buffer.from(entries.get('assets/oliphaunt/cluster-seed/files/PG_VERSION')!.data()).toString(),
      '18\n',
    );
    assert.equal(
      Buffer.from(
        entries.get('assets/oliphaunt/cluster-seed/manifest.properties')!.data(),
      ).toString(),
      'physicalFormat=datum64\n',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('mobile bundle embeds the source-owned selected catalog and extension expectations', () => {
  const file = new URL('../../src/database-resources/contracts/profile-probe.json', import.meta.url)
    .pathname;
  const source = JSON.parse(readFileSync(file, 'utf8'));
  const actual = mobileBundleEnvironment(
    { EXPO_PUBLIC_OLIPHAUNT_RUNNER: 'smoke' },
    ['vector'],
    'standard',
    file,
  );
  assert.equal(actual.EXPO_PUBLIC_OLIPHAUNT_EXTENSIONS, 'vector');
  assert.equal(actual.EXPO_PUBLIC_OLIPHAUNT_CATALOG_PROFILE, 'standard');
  assert.equal(
    actual.EXPO_PUBLIC_OLIPHAUNT_CATALOG_PROFILE_PROBE_SQL,
    source.profiles.standard.sql,
  );
  assert.equal(
    actual.EXPO_PUBLIC_OLIPHAUNT_CATALOG_PROFILE_PROBE_EXPECTED,
    source.profiles.standard.expected,
  );
  assert.equal(actual.EXPO_PUBLIC_OLIPHAUNT_RUNNER, 'smoke');
  assert.equal(
    mobileBundleEnvironment({}, [], 'icu', file)
      .EXPO_PUBLIC_OLIPHAUNT_CATALOG_PROFILE_PROBE_EXPECTED,
    source.profiles.icu.expected,
  );
  assert.throws(
    () => mobileBundleEnvironment({}, ['vector', 'vector'], 'standard', file),
    /Duplicate packaged/u,
  );
  assert.throws(
    () => mobileBundleEnvironment({}, ['vector'], 'unknown', file),
    /Unsupported packaged/u,
  );
  assert.throws(
    () =>
      mobileBundleEnvironment(
        { EXPO_PUBLIC_OLIPHAUNT_EXTENSIONS: '' },
        ['vector'],
        'standard',
        file,
      ),
    /Conflicting packaged/u,
  );
});
