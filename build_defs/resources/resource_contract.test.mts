import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  emptyDirectoryPaths,
  filesystemTreeRows,
  logicalTreeSha256,
  parseProperties,
} from '../../src/database-resources/contracts/native-manifest.mts';
import { packageClusterSeed } from '../../src/database-resources/seeds/package.mts';
import { buildMavenArtifactManifest } from '../../tools/packaging/build-maven-artifact-manifest.mts';
import { readPortableArchiveEntries } from '../../tools/packaging/portable-archive.mts';
import { releaseProfilePackageLicense } from '../../tools/packaging/release-notices.mts';
import { bindSeedDomain } from './seed_domain.mts';
import { materializeInputs, nativeSeedHost, seedEnvironment } from './shared.mts';

test('resource Maven formatter loads from declared helpers and rejects missing carrier mappings before output', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'resource-maven-contract-'));
  const manifest = path.join(root, 'maven.tsv');
  try {
    await expect(
      buildMavenArtifactManifest(manifest, {
        artifactProduct: 'database-resources',
        artifactIds: ['unknown-carrier'],
        runtimeAssetRoot: root,
        context: { version: '1.0.0', artifactTargets: [], registryPackages: [] },
      }),
    ).rejects.toThrow('database-resources artifact targets did not produce any Maven artifacts');
    expect(existsSync(manifest)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('native bootstrap rejects a runtime for a different executor before filesystem mutation', () => {
  const artifact = {
    target: 'windows-x64-msvc',
    npm_os: 'win32',
    npm_cpu: 'x64',
    library_relative_path: 'bin/oliphaunt.dll',
  };
  expect(nativeSeedHost(artifact, 'win32', 'x64')).toEqual({
    target: artifact.target,
    executableSuffix: '.exe',
    memoryType: 'windows',
    libraryRelativePath: 'bin/oliphaunt.dll',
  });
  expect(() => nativeSeedHost(artifact, 'linux', 'x64')).toThrow('executor OS');
  expect(() => nativeSeedHost(artifact, 'win32', 'arm64')).toThrow('executor CPU');
  expect(() => nativeSeedHost(artifact, 'freebsd', 'x64')).toThrow('unsupported');
  expect(() =>
    nativeSeedHost({ ...artifact, library_relative_path: '../ambient.dll' }, 'win32', 'x64'),
  ).toThrow('canonical');
  const mac = {
    ...artifact,
    target: 'macos-arm64',
    npm_os: 'darwin',
    npm_cpu: 'arm64',
    library_relative_path: 'lib/liboliphaunt.dylib',
  };
  expect(nativeSeedHost(mac, 'darwin', 'arm64').memoryType).toBe('mmap');
  expect(nativeSeedHost(mac, 'darwin', 'arm64').executableSuffix).toBe('');
});

test('seed loader environments consume only candidate libraries and the selected separate ICU data', () => {
  const ambient = {
    PATH: '/ambient/bin',
    LD_LIBRARY_PATH: '/ambient/lib',
    DYLD_LIBRARY_PATH: '/ambient/lib',
    ICU_DATA: '/ambient/icu',
    PGDATA: '/ambient/database',
    secret: 'must-not-be-inherited',
    SystemRoot: 'C:\\Windows',
  };
  for (const platform of ['linux', 'darwin', 'win32'] as const) {
    const runtime = platform === 'win32' ? 'C:\\candidate' : '/candidate';
    const root = platform === 'win32' ? 'C:\\private' : '/private';
    const standard = seedEnvironment(runtime, root, undefined, platform, ambient);
    expect(standard.PGDATA).toBeUndefined();
    expect(standard.secret).toBeUndefined();
    expect(standard.ICU_DATA).toBeUndefined();
    expect(standard.OLIPHAUNT_INTERNAL_SKIP_ICU_DISCOVERY).toBe('1');
    expect(standard.PATH).not.toContain('/ambient');
    expect(standard.HOME).toBe(root);
    expect(standard.TEMP).toBe(root);
    if (platform === 'win32') {
      expect(standard.PATH).toBe('C:\\candidate\\bin;C:\\Windows\\System32;C:\\Windows');
      expect(standard.SystemRoot).toBe('C:\\Windows');
      expect(standard.LD_LIBRARY_PATH).toBeUndefined();
    } else {
      expect(standard[platform === 'darwin' ? 'DYLD_LIBRARY_PATH' : 'LD_LIBRARY_PATH']).toBe(
        '/candidate/lib',
      );
      expect(standard.SystemRoot).toBeUndefined();
    }
    const icu = seedEnvironment(runtime, root, '/selected/icu', platform, ambient);
    expect(icu.ICU_DATA).toBe('/selected/icu');
    expect(icu.OLIPHAUNT_INTERNAL_ICU_READY).toBe('1');
    expect(icu.OLIPHAUNT_INTERNAL_SKIP_ICU_DISCOVERY).toBeUndefined();
  }
  expect(() => seedEnvironment('C:\\candidate', 'C:\\private', undefined, 'win32', {})).toThrow(
    'SystemRoot',
  );
});

test('declared input staging rejects paths that escape its private root', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'resource-contract-'));
  try {
    const input = path.join(root, 'input');
    writeFileSync(input, 'declared input');
    materializeInputs({ 'nested/file': input }, path.join(root, 'stage'));
    expect(readFileSync(path.join(root, 'stage/nested/file'), 'utf8')).toBe('declared input');
    expect(() => materializeInputs({ '../escape': input }, path.join(root, 'stage'))).toThrow(
      'unsafe',
    );
    expect(() =>
      materializeInputs({ 'nested/../escape': input }, path.join(root, 'stage')),
    ).toThrow('unsafe');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('seed envelopes preserve explicit historical runtime requirements and empty directories', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'resource-contract-'));
  try {
    const contract = JSON.parse(
      readFileSync(
        new URL('../../src/database-resources/contracts/contract.json', import.meta.url),
        'utf8',
      ),
    );
    const pgdata = path.join(root, 'fixture');
    for (const directory of contract.pgdataDirectories)
      mkdirSync(path.join(pgdata, directory), { recursive: true });
    writeFileSync(path.join(pgdata, 'PG_VERSION'), '18\n');
    // This tests the formatter boundary; only the installed consumer qualifies real PGDATA.
    writeFileSync(path.join(pgdata, 'global/pg_control'), 'formatter fixture\n');
    const runtime = path.join(root, 'runtime');
    mkdirSync(path.join(runtime, 'bin'), { recursive: true });
    writeFileSync(path.join(runtime, 'bin/postgres'), 'declared postgres fixture');
    writeFileSync(path.join(runtime, 'bin/initdb'), 'declared initdb fixture');
    const options = {
      family: 'native',
      profile: 'standard',
      target: 'linux-x64-gnu',
      pgdata,
      runtime,
      contract,
      version: '0.2.2',
      runtimeVersion: '0.3.2',
      outputDir: path.join(root, 'assets'),
    };
    const result = await packageClusterSeed(options);
    const manifest = JSON.parse(readFileSync(result.manifest, 'utf8'));
    expect(manifest.runtime.version).toBe('0.3.2');
    expect(manifest.runtime.compatibilityKey).toBe(
      contract.compatibilityKeys.native['linux-x64-gnu'],
    );
    const entries = readPortableArchiveEntries(result.archive);
    expect(entries.get('pg_twophase')?.isDirectory).toBe(true);
    expect(entries.get('pg_twophase')?.mode).toBe(0o755);
    expect(entries.get('global/pg_control')?.mode).toBe(0o644);
    const heldOptions = {
      ...options,
      runtime: undefined,
      producer: manifest.source,
      nativeSourceManifest: JSON.stringify(manifest),
    };
    const beforeCoreBump = await packageClusterSeed({
      ...heldOptions,
      runtimeVersion: '0.3.3',
      outputDir: path.join(root, 'before-core'),
    });
    const afterCoreBump = await packageClusterSeed({
      ...heldOptions,
      runtimeVersion: '0.3.4',
      outputDir: path.join(root, 'after-core'),
    });
    expect(readFileSync(afterCoreBump.manifest)).toEqual(readFileSync(beforeCoreBump.manifest));
    expect(readFileSync(afterCoreBump.archive)).toEqual(readFileSync(beforeCoreBump.archive));
    const heldDescriptor = JSON.parse(readFileSync(afterCoreBump.manifest, 'utf8'));
    expect(heldDescriptor.runtime).toEqual(manifest.runtime);
    expect(heldDescriptor.source).toEqual(manifest.source);
    await expect(
      packageClusterSeed({
        ...heldOptions,
        producer: { ...manifest.source, postgresSha256: '0'.repeat(64) },
      }),
    ).rejects.toThrow('producer/profile');
    const incompatibleOriginal = structuredClone(manifest);
    incompatibleOriginal.runtime.target = 'ios-datum64';
    await expect(
      packageClusterSeed({
        ...heldOptions,
        nativeSourceManifest: JSON.stringify(incompatibleOriginal),
      }),
    ).rejects.toThrow('physical identity');
    const before = readFileSync(path.join(pgdata, 'global/pg_control'));
    await packageClusterSeed({ ...options, version: '0.2.3' });
    expect(readFileSync(path.join(pgdata, 'global/pg_control')).equals(before)).toBe(true);
    await expect(packageClusterSeed({ ...options, runtimeVersion: undefined })).rejects.toThrow(
      'exact',
    );
    await expect(packageClusterSeed({ ...options, icuData: root })).rejects.toThrow('only ICU');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('WASIX manifest retains exact consumed module hashes and the distinct Datum32 contract', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'resource-wasix-contract-'));
  try {
    const contract = JSON.parse(
      readFileSync(
        new URL('../../src/database-resources/contracts/contract.json', import.meta.url),
        'utf8',
      ),
    );
    const pgdata = path.join(root, 'formatter-fixture');
    for (const directory of contract.pgdataDirectories)
      mkdirSync(path.join(pgdata, directory), { recursive: true });
    writeFileSync(path.join(pgdata, 'PG_VERSION'), '18\n');
    writeFileSync(path.join(pgdata, 'global/pg_control'), 'formatter fixture only');
    const runtime = path.join(root, 'runtime');
    mkdirSync(path.join(runtime, 'bin'), { recursive: true });
    const postgres = Buffer.from('explicit WASIX postgres fixture');
    const initdb = Buffer.from('explicit WASIX initdb fixture');
    writeFileSync(path.join(runtime, 'bin/postgres'), postgres);
    writeFileSync(path.join(runtime, 'bin/initdb'), initdb);
    const result = await packageClusterSeed({
      family: 'wasix',
      profile: 'standard',
      target: 'portable',
      pgdata,
      runtime,
      contract,
      version: '0.2.2',
      runtimeVersion: '0.3.2',
      outputDir: path.join(root, 'assets'),
    });
    const manifest = JSON.parse(readFileSync(result.manifest, 'utf8'));
    const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
    expect(manifest.runtime.version).toBe('0.3.2');
    expect(manifest.runtime.engineFamily).toBe('wasix');
    expect(manifest.runtime.target).toBe('portable');
    expect(manifest.runtime.physicalFormat).toBe(contract.physicalFormats.wasix);
    expect(manifest.runtime.compatibilityKey).toBe(contract.compatibilityKeys.wasixDatum32);
    expect(manifest.runtime.consumerSha256).toBe(sha256(postgres));
    expect(manifest.runtime.producerSha256).toBe(sha256(postgres));
    expect(manifest.runtime.initdbSha256).toBe(sha256(initdb));
    expect(manifest.source.producer).toBe('wasix-initdb');
    expect(readPortableArchiveEntries(result.archive).get('pg_twophase')?.isDirectory).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('license metadata uses the declared source tree and rejects altered or absent pinned licenses', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'resource-license-'));
  try {
    const source = path.resolve(import.meta.dir, '../..');
    materializeInputs(
      Object.fromEntries(
        ['LICENSE', 'src/third-party/icu/LICENSE', 'src/third-party/icu/source.toml'].map(
          (relative) => [relative, path.join(source, relative)],
        ),
      ),
      root,
    );
    const license = releaseProfilePackageLicense('native-icu-data', { sourceRoot: root });
    expect(license.spdx).toBe('MIT AND Unicode-3.0');
    expect(license.entries.map((entry) => entry.source)).toEqual([
      path.join(root, 'LICENSE'),
      path.join(root, 'src/third-party/icu/LICENSE'),
    ]);
    const icuLicense = path.join(root, 'src/third-party/icu/LICENSE');
    chmodSync(icuLicense, 0o644);
    writeFileSync(icuLicense, 'altered pinned ICU license');
    expect(() => releaseProfilePackageLicense('native-icu-data', { sourceRoot: root })).toThrow(
      /sha256|bytes|license/,
    );
    rmSync(icuLicense);
    expect(() => releaseProfilePackageLicense('native-icu-data', { sourceRoot: root })).toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('domain binding requires every target receipt and preserves PostgreSQL bytes and empty directories', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'resource-domain-'));
  try {
    const source = path.resolve(import.meta.dir, '../..');
    const contract = JSON.parse(
      readFileSync(path.join(source, 'src/database-resources/contracts/contract.json'), 'utf8'),
    );
    const seed = path.join(root, 'seed');
    const pgdata = path.join(seed, 'files');
    for (const directory of contract.pgdataDirectories)
      mkdirSync(path.join(pgdata, directory), { recursive: true });
    // Formatter fixtures exercise binding; real target construction qualifies the receipts.
    writeFileSync(path.join(pgdata, 'PG_VERSION'), '18\n');
    writeFileSync(path.join(pgdata, 'global/pg_control'), 'domain fixture preserves this nonce');
    writeFileSync(
      path.join(seed, 'manifest.properties'),
      readFileSync(
        path.join(
          source,
          'src/database-resources/contracts/fixtures/native-standard.valid.properties',
        ),
      ),
    );
    const values = {
      schema: 'oliphaunt-native-mobile-abi-v1',
      byteOrder: 'little',
      datumBytes: '8',
      maximumAlignof: '8',
      float8ByVal: '1',
      blockSize: '8192',
      walBlockSize: '8192',
      relationSegmentSize: '131072',
      nameDataLength: '64',
      indexMaxKeys: '32',
      catalogVersion: '202506291',
      pgControlVersion: '1800',
    };
    const receipts = ['android-arm64-v8a', 'android-x86_64', 'linux-x64-gnu'].map((target) => ({
      text: `${Object.entries({ ...values, target })
        .map(([key, value]) => `${key}=${value}`)
        .join('\n')}\n`,
      label: target,
    }));
    writeFileSync(path.join(seed, 'abi.properties'), receipts[2].text);
    const options = {
      seed,
      producerTarget: 'linux-x64-gnu',
      domain: 'android-datum64',
      profile: 'standard',
      receipts,
    };
    const before = logicalTreeSha256(filesystemTreeRows(pgdata));
    const empty = emptyDirectoryPaths(pgdata);
    expect(() => bindSeedDomain({ ...options, receipts: receipts.slice(1) })).toThrow(
      'requires receipts',
    );
    expect(() => bindSeedDomain({ ...options, producerTarget: 'macos-arm64' })).toThrow(
      'actual host producer',
    );
    expect(() =>
      bindSeedDomain({
        ...options,
        receipts: [
          receipts[0],
          {
            ...receipts[1],
            text: receipts[1].text.replace('maximumAlignof=8', 'maximumAlignof=16'),
          },
          receipts[2],
        ],
      }),
    ).toThrow('ABI mismatch');
    expect(logicalTreeSha256(filesystemTreeRows(pgdata))).toBe(before);
    bindSeedDomain(options);
    const manifest = parseProperties(
      readFileSync(path.join(seed, 'manifest.properties')),
      'domain fixture',
    );
    expect(manifest.get('target')).toBe('android-datum64');
    expect(manifest.get('compatibilityKey')).toBe(
      contract.compatibilityKeys.native['android-datum64'],
    );
    expect(logicalTreeSha256(filesystemTreeRows(pgdata))).toBe(before);
    expect(emptyDirectoryPaths(pgdata)).toEqual(empty);
    expect(readFileSync(path.join(seed, 'abi-receipts/android-x86_64.properties'), 'utf8')).toBe(
      receipts[1].text,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
