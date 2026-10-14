import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { nativeRuntimeResourceManifestFixture } from '../../src/native/runtime/tools/testdata/native-runtime-fixture.mts';
import {
  createDeterministicTar,
  createDeterministicZip,
} from '../../tools/packaging/archive-directory.mts';
import {
  canonicalGzipSync,
  readPortableArchiveEntries,
} from '../../tools/packaging/portable-archive.mts';
import {
  androidDynamicLinkMetadata,
  assertAndroidElf,
  assertAndroidRuntimeManifest,
  assertHermesBytecode,
  dexDefinedClasses,
  extractFinalAar,
  mobileBundleEnvironment,
  prepareAppRuntimeAssets,
  stageAndroidSelectedResources,
  stageNodeInputs,
  verifyAndroidApk,
} from './app.mts';

function dex(names: string[], definitions: number[]) {
  const strings = 112;
  const types = strings + names.length * 4;
  const classes = types + names.length * 4;
  const data = classes + definitions.length * 32;
  const encoded = names.map((name) => {
    const value = `L${name.replaceAll('.', '/')};`;
    assert(value.length < 128);
    const units = Array.from({ length: value.length }, (_, index) => value.charCodeAt(index));
    return Buffer.from([
      value.length,
      ...units.flatMap((unit) =>
        unit < 0x80
          ? [unit]
          : unit < 0x800
            ? [0xc0 | (unit >> 6), 0x80 | (unit & 0x3f)]
            : [0xe0 | (unit >> 12), 0x80 | ((unit >> 6) & 0x3f), 0x80 | (unit & 0x3f)],
      ),
      0,
    ]);
  });
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
  const companion = 'androidx.compose.animation.AnimatedContentTransitionScope$-CC';
  assert.deepEqual([...dexDefinedClasses(dex([companion], [0]))], [companion]);
  assert.deepEqual([...dexDefinedClasses(dex([companion], []))], []);
  const unicode = 'dev.example.É漢𐐀';
  assert.deepEqual([...dexDefinedClasses(dex([unicode], [0]))], [unicode]);
  const canonical = dex(['dev.example.Valid'], [0]);
  const stringData = canonical.readUInt32LE(canonical.readUInt32LE(60));
  for (const overlong of [
    [0xc1, 0x8c],
    [0xe0, 0x81, 0x8c],
  ]) {
    const malformed = Buffer.concat([
      canonical.subarray(0, stringData + 1),
      Buffer.from(overlong),
      canonical.subarray(stringData + 2),
    ]);
    malformed.writeUInt32LE(malformed.length, 32);
    assert.throws(() => dexDefinedClasses(malformed), /Noncanonical DEX MUTF-8/u);
  }
  const wrongLength = Buffer.from(canonical);
  wrongLength[stringData]++;
  assert.throws(() => dexDefinedClasses(wrongLength), /UTF16 length differs/u);
  for (const name of ['androidx..compose.Broken', '/Bad', 'Bad/', 'Bad;Other', 'Bad[Array'])
    assert.throws(() => dexDefinedClasses(dex([name], [0])), /Invalid defined DEX class/u);
  assert.throws(() => dexDefinedClasses(dex(names, [2])), /invalid type index/u);
  const truncated = dex(names, [0]).subarray(0, 140);
  assert.throws(() => dexDefinedClasses(truncated));
});

test('selected Android resources use frozen carrier bytes and bind both ABI static archives to the link receipt', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'android-selected-resources-'));
  try {
    for (const abi of ['arm64-v8a', 'x86_64']) {
      const directory = path.join(root, abi);
      const payload = path.join(directory, 'payload');
      mkdirSync(path.join(payload, 'files/share/postgresql/extension'), { recursive: true });
      mkdirSync(path.join(payload, 'files/share/postgresql/data'), { recursive: true });
      mkdirSync(path.join(payload, `mobile-static/android-${abi}/extensions/vector`), {
        recursive: true,
      });
      writeFileSync(
        path.join(payload, 'files/share/postgresql/extension/vector.control'),
        'default_version=fixture\n',
      );
      writeFileSync(
        path.join(payload, 'files/share/postgresql/extension/vector--fixture.sql'),
        'original install SQL\n',
      );
      writeFileSync(
        path.join(payload, 'files/share/postgresql/data/value'),
        'original declared runtime data\n',
      );
      const archive = Buffer.from('original static archive fixture');
      writeFileSync(
        path.join(
          payload,
          `mobile-static/android-${abi}/extensions/vector/liboliphaunt_extension_vector.a`,
        ),
        archive,
      );
      const github = path.join(directory, 'github');
      mkdirSync(github);
      const file = path.join(github, 'vector.tar.gz');
      writeFileSync(file, canonicalGzipSync(await createDeterministicTar(payload)));
      const frozen = path.join(directory, 'frozen.json');
      writeFileSync(
        frozen,
        JSON.stringify({
          product: 'vector-product',
          releaseProduct: 'vector-owner',
          version: '1.2.3',
          compatibility: { nativeRuntimeVersion: '3.3.3' },
          sqlName: 'vector',
          dataFiles: ['postgresql/data'],
          assets: [
            {
              name: 'vector.tar.gz',
              family: 'native',
              target: `android-${abi}`,
              kind: 'runtime',
              bytes: readFileSync(file).length,
              sha256: createHash('sha256').update(readFileSync(file)).digest('hex'),
            },
          ],
        }),
      );
      const leaf = {
        product: 'vector-product',
        owner: 'vector-owner',
        version: '1.2.3',
        runtimeVersion: '3.3.3',
        target: `android-${abi}`,
        sqlNames: ['vector'],
        github: [github],
        frozen,
      };
      const receipt = path.join(directory, 'receipt.json');
      const link = {
        abi,
        selectedExtensions: ['vector'],
        members: [
          {
            sqlName: 'vector',
            nativeModuleStem: 'vector',
            archiveSha256: createHash('sha256').update(archive).digest('hex'),
          },
        ],
      };
      writeFileSync(receipt, JSON.stringify(link));
      const spec = {
        abi,
        selectedExtensions: ['vector'],
        version: '3.3.3',
        leaves: [leaf],
        receipt,
      };
      const staged = await stageAndroidSelectedResources(spec, path.join(directory, 'valid'));
      assert.equal(staged.length, 1);
      assert(readFileSync(staged[0]).equals(readFileSync(file)));
      const intermediate = path.join(directory, 'formatter-intermediate');
      const data = Buffer.from('runtime resource bytes');
      const registry = Buffer.from('source static registration');
      mkdirSync(path.join(intermediate, 'runtime/files/share/postgresql'), { recursive: true });
      mkdirSync(path.join(intermediate, 'static-registry'));
      writeFileSync(path.join(intermediate, 'runtime/files/share/postgresql/data'), data);
      writeFileSync(
        path.join(intermediate, 'static-registry/oliphaunt_static_registry.c'),
        registry,
      );
      const intermediateManifest = nativeRuntimeResourceManifestFixture({
        overrides: {
          runtimeFeatures: abi === 'x86_64' ? 'icu' : '',
          icuDataTreeSha256: abi === 'x86_64' ? 'a'.repeat(64) : '',
          selectedExtensions: 'vector',
          extensions: 'vector',
          mobileStaticRegistryState: 'complete',
          mobileStaticRegistryRegistered: 'vector',
          nativeModuleStems: 'vector',
          mobileStaticRegistrySource: 'static-registry/oliphaunt_static_registry.c',
        },
      });
      writeFileSync(path.join(intermediate, 'runtime/manifest.properties'), intermediateManifest);
      writeFileSync(
        path.join(intermediate, 'package-size.tsv'),
        'kind\tid\textensions\tfiles\tbytes\npackage\ttotal\t-\t-\t0\nextension\tvector\tvector\t2\t99\n',
      );
      const formatter = path.join(directory, 'formatter.mts');
      writeFileSync(
        formatter,
        `#!${process.execPath}\nimport { cpSync } from 'node:fs';\nimport path from 'node:path';\nconst args=process.argv.slice(2);\ncpSync(${JSON.stringify(intermediate)},path.join(args[args.indexOf('--output')+1],'oliphaunt'),{recursive:true});\n`,
      );
      chmodSync(formatter, 0o755);
      const output = path.join(directory, 'app-assets');
      await prepareAppRuntimeAssets({
        ...spec,
        payload,
        formatter,
        mobileStaticModules: ['vector'],
        output,
      });
      const closure = path.join(output, 'oliphaunt');
      const manifest = readFileSync(path.join(closure, 'runtime/manifest.properties'));
      await assertAndroidRuntimeManifest(manifest);
      assert(
        manifest.equals(
          Buffer.from(
            intermediateManifest
              .toString('utf8')
              .replace('clusterSeedTarget=\n', 'clusterSeedTarget=android-datum64\n'),
          ),
        ),
      );
      assert(readFileSync(path.join(closure, 'runtime/files/share/postgresql/data')).equals(data));
      assert(
        readFileSync(path.join(closure, 'static-registry/link-receipt.json')).equals(
          readFileSync(receipt),
        ),
      );
      const report = readFileSync(path.join(closure, 'package-size.tsv'), 'utf8');
      assert(
        report.includes(
          `package\ttotal\t-\t-\t${data.length + registry.length + readFileSync(receipt).length}\n`,
        ),
      );
      assert(report.includes('extension\tvector\tvector\t2\t99\n'));
      await assert.rejects(
        assertAndroidRuntimeManifest(
          readFileSync(path.join(intermediate, 'runtime/manifest.properties')),
        ),
        /canonical for android-datum64/u,
      );
      await assert.rejects(
        assertAndroidRuntimeManifest(
          Buffer.from(
            manifest
              .toString('utf8')
              .replace('clusterSeedTarget=android-datum64', 'clusterSeedTarget=ios-datum64'),
          ),
        ),
        /incompatible native-direct contract/u,
      );
      await assert.rejects(
        stageAndroidSelectedResources(
          { ...spec, abi: abi === 'arm64-v8a' ? 'x86_64' : 'arm64-v8a' },
          path.join(directory, 'wrong-abi'),
        ),
        /ABI differs/u,
      );
      writeFileSync(
        receipt,
        JSON.stringify({
          ...link,
          members: [{ ...link.members[0], archiveSha256: '0'.repeat(64) }],
        }),
      );
      await assert.rejects(
        stageAndroidSelectedResources(spec, path.join(directory, 'wrong-link')),
        /differs from actual app link/u,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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

test('actual APK proof rejects an unbound runtime manifest before deeper bytecode inspection', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'android-runtime-manifest-proof-'));
  try {
    const tree = path.join(root, 'apk');
    mkdirSync(path.join(tree, 'assets/oliphaunt/runtime'), { recursive: true });
    const manifest = path.join(tree, 'assets/oliphaunt/runtime/manifest.properties');
    writeFileSync(manifest, nativeRuntimeResourceManifestFixture());
    const apk = path.join(root, 'installed.apk');
    writeFileSync(apk, await createDeterministicZip(tree));
    const tool = path.join(root, 'sdk-tool.mts');
    const badging =
      "package: name='dev.oliphaunt.reactnative.example'\nsdkVersion:'24'\ntargetSdkVersion:'36'\nlaunchable-activity: name='dev.oliphaunt.reactnative.example.MainActivity'\n";
    writeFileSync(
      tool,
      `#!${process.execPath}\nif(process.argv[2]==='dump') console.log(${JSON.stringify(badging)});\n`,
    );
    chmodSync(tool, 0o755);
    const spec = {
      apk,
      abi: 'x86_64',
      zipalign: tool,
      apksigner: tool,
      aapt: tool,
      objdump: tool,
      output: path.join(root, 'proof.json'),
      selectedExtensions: [],
      expectedClasses: [],
      catalogProfile: 'standard',
      profileProbe: '',
    };
    await assert.rejects(verifyAndroidApk(spec), /canonical for android-datum64/u);
    writeFileSync(manifest, nativeRuntimeResourceManifestFixture({ target: 'android-datum64' }));
    writeFileSync(apk, await createDeterministicZip(tree));
    await assert.rejects(verifyAndroidApk(spec), /Full Expo APK omitted lib/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

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

test('canonical Maven input Tree resolves sandbox File links and rejects directory links or duplicate carriers', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'maven-tree-transport-'));
  try {
    const payload = path.join(root, 'payload.aar');
    const bytes = Buffer.from('declared original AAR bytes');
    writeFileSync(payload, bytes);
    const tree = path.join(root, 'tree');
    const coordinate = path.join(tree, 'dev/example/artifact/1.0.0');
    mkdirSync(coordinate, { recursive: true });
    symlinkSync(payload, path.join(coordinate, 'artifact-1.0.0.aar'));
    const output = path.join(root, 'installed.aar');
    await extractFinalAar({ source: tree, output });
    assert(readFileSync(output).equals(bytes));
    symlinkSync(payload, path.join(coordinate, 'second-1.0.0.aar'));
    await assert.rejects(extractFinalAar({ source: tree, output }), /exactly one final/u);
    rmSync(path.join(coordinate, 'second-1.0.0.aar'));
    symlinkSync(root, path.join(tree, 'directory-link'));
    await assert.rejects(extractFinalAar({ source: tree, output }), /regular File leaves/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('actual source package requirements reject an independently advanced query and undeclared edges', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'app-query-requirement-'));
  try {
    function source(name: string, version: string, dependencies = {}) {
      const directory = path.join(root, name.replaceAll('/', '_'));
      mkdirSync(directory, { recursive: true });
      writeFileSync(
        path.join(directory, 'package.json'),
        JSON.stringify({ name, version, dependencies }),
      );
      return {
        package: name,
        version,
        dependencies: {},
        source: directory,
        integrity: '',
        local: true,
      };
    }
    const rn = source('@oliphaunt/react-native', '0.3.2', { '@oliphaunt/ts-query': '0.1.1' });
    const query = source('@oliphaunt/ts-query', '1.0.0');
    const specification = {
      packages: { rn: { ...rn, dependencies: { '@oliphaunt/ts-query': 'query' } }, query },
      roots: { '@oliphaunt/react-native': 'rn' },
      sources: [],
      node: '',
      tar: '',
    };
    assert.throws(
      () => stageNodeInputs(path.join(root, 'major'), specification),
      /does not satisfy 0\.1\.1/u,
    );
    assert.throws(
      () =>
        stageNodeInputs(path.join(root, 'missing'), {
          ...specification,
          packages: { ...specification.packages, rn },
        }),
      /Undeclared npm dependency/u,
    );
    assert.throws(
      () =>
        stageNodeInputs(path.join(root, 'extra'), {
          ...specification,
          packages: { ...specification.packages, rn: { ...rn, dependencies: { wrong: 'query' } } },
        }),
      /absent from its conventional manifest/u,
    );
    writeFileSync(
      path.join(query.source, 'package.json'),
      JSON.stringify({ name: query.package, version: '0.1.1' }),
    );
    const valid = {
      ...specification,
      packages: { ...specification.packages, query: { ...query, version: '0.1.1' } },
    };
    stageNodeInputs(path.join(root, 'valid'), valid);
    const app = path.join(root, 'app.json');
    writeFileSync(
      app,
      JSON.stringify({ name: 'app', dependencies: { '@oliphaunt/react-native': '^1.0.0' } }),
    );
    assert.throws(
      () =>
        stageNodeInputs(path.join(root, 'app-major'), {
          ...valid,
          sources: [{ source: app, destination: 'package.json' }],
        }),
      /does not satisfy \^1\.0\.0/u,
    );
    writeFileSync(
      app,
      JSON.stringify({ name: 'app', dependencies: { '@oliphaunt/react-native': 'workspace:*' } }),
    );
    const staged = path.join(root, 'app-workspace');
    stageNodeInputs(staged, { ...valid, sources: [{ source: app, destination: 'package.json' }] });
    assert.equal(
      JSON.parse(readFileSync(path.join(staged, 'package.json'), 'utf8')).dependencies[
        '@oliphaunt/react-native'
      ],
      '0.3.2',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('completed query bytes retain their File identity despite an equal-version candidate', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'app-query-byte-origin-'));
  try {
    const packageRoot = path.join(root, 'package');
    mkdirSync(packageRoot);
    writeFileSync(
      path.join(packageRoot, 'package.json'),
      JSON.stringify({ name: '@oliphaunt/ts-query', version: '0.1.1' }),
    );
    writeFileSync(path.join(packageRoot, 'query.txt'), 'genuine completed fixture');
    const held = path.join(root, 'held.tgz');
    writeFileSync(
      held,
      canonicalGzipSync(await createDeterministicTar(packageRoot, { keepParent: true })),
    );
    const row = {
      package: '@oliphaunt/ts-query',
      version: '0.1.1',
      dependencies: {},
      integrity: '',
      local: true,
      origin: 'completed-supplier',
      source: held,
      sourceSha256: createHash('sha256').update(readFileSync(held)).digest('hex'),
      sourceSize: readFileSync(held).length,
    };
    writeFileSync(path.join(packageRoot, 'query.txt'), 'unpublished same-version candidate');
    const candidate = path.join(root, 'candidate.tgz');
    writeFileSync(
      candidate,
      canonicalGzipSync(await createDeterministicTar(packageRoot, { keepParent: true })),
    );
    assert.notEqual(
      createHash('sha256').update(readFileSync(candidate)).digest('hex'),
      row.sourceSha256,
    );
    assert.equal(
      Buffer.from(readPortableArchiveEntries(held).get('package/query.txt')!.data()).toString(),
      'genuine completed fixture',
    );
    const specification = {
      packages: { query: row },
      roots: { '@oliphaunt/ts-query': 'query' },
      sources: [],
      node: '',
      tar: '',
    };
    assert.throws(
      () =>
        stageNodeInputs(path.join(root, 'candidate'), {
          ...specification,
          packages: {
            query: { ...row, source: candidate, sourceSize: readFileSync(candidate).length },
          },
        }),
      /npm supplier File SHA256/u,
    );
    assert.throws(
      () =>
        stageNodeInputs(path.join(root, 'missing-identity'), {
          ...specification,
          packages: { query: { ...row, sourceSha256: undefined } },
        }),
      /Missing completed npm File identity/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
