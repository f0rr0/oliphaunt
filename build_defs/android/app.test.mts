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
  assertAndroidStaticMembers,
  assertHermesBytecode,
  dexDefinedClasses,
  extractFinalAar,
  extensionLinkReceipt,
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
          nativeModuleStem: 'vector',
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
      const sqlPayload = path.join(directory, 'pgtap-payload');
      mkdirSync(path.join(sqlPayload, 'files/share/postgresql/extension'), { recursive: true });
      const pgtapSql = Buffer.from('original SQL-only install fixture\n');
      writeFileSync(
        path.join(sqlPayload, 'files/share/postgresql/extension/pgtap.control'),
        'default_version=fixture\n',
      );
      writeFileSync(
        path.join(sqlPayload, 'files/share/postgresql/extension/pgtap--fixture.sql'),
        pgtapSql,
      );
      const sqlArchive = path.join(directory, 'pgtap.tar.gz');
      writeFileSync(sqlArchive, canonicalGzipSync(await createDeterministicTar(sqlPayload)));
      const sqlFrozen = path.join(directory, 'pgtap-frozen.json');
      writeFileSync(
        sqlFrozen,
        JSON.stringify({
          product: 'pgtap-product',
          releaseProduct: 'pgtap-owner',
          version: '1.2.3',
          compatibility: { nativeRuntimeVersion: '3.3.3' },
          sqlName: 'pgtap',
          nativeModuleStem: null,
          assets: [
            {
              name: 'pgtap.tar.gz',
              family: 'native',
              target: `android-${abi}`,
              kind: 'runtime',
              bytes: readFileSync(sqlArchive).length,
              sha256: createHash('sha256').update(readFileSync(sqlArchive)).digest('hex'),
            },
          ],
        }),
      );
      const sqlLeaf = {
        product: 'pgtap-product',
        owner: 'pgtap-owner',
        version: '1.2.3',
        runtimeVersion: '3.3.3',
        target: `android-${abi}`,
        sqlNames: ['pgtap'],
        github: [sqlArchive],
        frozen: sqlFrozen,
      };
      const receipt = path.join(directory, 'receipt.json');
      const link = {
        abi,
        selectedExtensions: ['pgtap', 'vector'],
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
        selectedExtensions: ['pgtap', 'vector'],
        moduleStems: { pgtap: null, vector: 'vector' },
        version: '3.3.3',
        leaves: [leaf, sqlLeaf],
        receipt,
      };
      const staged = await stageAndroidSelectedResources(spec, path.join(directory, 'valid'));
      assert.equal(staged.length, 2);
      assert(readFileSync(staged[0]).equals(readFileSync(file)));
      assert(readFileSync(staged[1]).equals(readFileSync(sqlArchive)));
      const stagedSql = readPortableArchiveEntries(staged[1]).get(
        'files/share/postgresql/extension/pgtap--fixture.sql',
      );
      assert(stagedSql?.isFile);
      assert(Buffer.from(stagedSql.data()).equals(pgtapSql));
      await assert.rejects(
        stageAndroidSelectedResources(
          { ...spec, leaves: [leaf] },
          path.join(directory, 'missing-sql'),
        ),
        /Selected resource carriers differ/u,
      );
      const originalSqlFrozen = readFileSync(sqlFrozen);
      writeFileSync(
        sqlFrozen,
        JSON.stringify({
          ...JSON.parse(originalSqlFrozen.toString('utf8')),
          nativeModuleStem: 'pgtap',
        }),
      );
      await assert.rejects(
        stageAndroidSelectedResources(spec, path.join(directory, 'wrong-sql-module')),
        /module stem/u,
      );
      writeFileSync(sqlFrozen, originalSqlFrozen);
      assert.throws(
        () =>
          assertAndroidStaticMembers(spec.selectedExtensions, { vector: 'vector' }, link.members),
        /Canonical SQL cohort differs/u,
      );
      assert.throws(
        () =>
          assertAndroidStaticMembers(spec.selectedExtensions, spec.moduleStems, [
            ...link.members,
            { sqlName: 'pgtap', nativeModuleStem: 'pgtap' },
          ]),
        /Compiled registration cohort differs/u,
      );
      assert.throws(
        () =>
          assertAndroidStaticMembers(spec.selectedExtensions, spec.moduleStems, [
            { ...link.members[0], nativeModuleStem: 'wrong-vector' },
          ]),
        /Canonical native module stem differs/u,
      );
      const intermediate = path.join(directory, 'formatter-intermediate');
      const data = Buffer.from('runtime resource bytes');
      const registry = Buffer.from('source static registration');
      const icuBytes =
        abi === 'x86_64' ? Buffer.from('immutable ICU fixture bytes') : Buffer.alloc(0);
      let icu: string | undefined;
      let icuDigest = '';
      if (icuBytes.length) {
        const icuRoot = path.join(directory, 'icu');
        const icuData = path.join(icuRoot, 'share/icu');
        mkdirSync(icuData, { recursive: true });
        writeFileSync(path.join(icuData, 'icudt76l.dat'), icuBytes);
        icuDigest = 'a'.repeat(64);
        icu = path.join(directory, 'icu.tar.gz');
        writeFileSync(icu, canonicalGzipSync(await createDeterministicTar(icuRoot)));
        mkdirSync(path.join(intermediate, 'runtime/files/share/icu'), { recursive: true });
        writeFileSync(path.join(intermediate, 'runtime/files/share/icu/icudt76l.dat'), icuBytes);
      }
      mkdirSync(path.join(intermediate, 'runtime/files/share/postgresql'), { recursive: true });
      mkdirSync(path.join(intermediate, 'static-registry'));
      writeFileSync(path.join(intermediate, 'runtime/files/share/postgresql/data'), data);
      writeFileSync(
        path.join(intermediate, 'static-registry/oliphaunt_static_registry.c'),
        registry,
      );
      const intermediateManifest = nativeRuntimeResourceManifestFixture({
        overrides: {
          runtimeFeatures: icu ? 'icu' : '',
          icuDataTreeSha256: icuDigest,
          selectedExtensions: 'pgtap,vector',
          extensions: 'pgtap,vector',
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
        `#!${process.execPath}\nimport assert from 'node:assert/strict';\nimport { cpSync, readFileSync } from 'node:fs';\nimport path from 'node:path';\nconst args=process.argv.slice(2);\nassert.equal(args.includes('--runtime-feature'),${Boolean(icu)});\nif(${Boolean(icu)}) { assert.equal(args[args.indexOf('--runtime-feature')+1],'icu'); assert(readFileSync(path.join(process.env.OLIPHAUNT_ICU_DATA_DIR,'icudt76l.dat')).equals(Buffer.from(${JSON.stringify(icuBytes.toString('hex'))},'hex'))); } else assert.equal(process.env.OLIPHAUNT_ICU_DATA_DIR,undefined);\nassert.equal(args.filter(arg=>arg==='--prebuilt-extension').length,2);\ncpSync(${JSON.stringify(intermediate)},path.join(args[args.indexOf('--output')+1],'oliphaunt'),{recursive:true});\n`,
      );
      chmodSync(formatter, 0o755);
      const output = path.join(directory, 'app-assets');
      const assetSpec = {
        ...spec,
        payload,
        formatter,
        mobileStaticModules: ['vector'],
        icu,
        output,
      };
      await assert.rejects(
        prepareAppRuntimeAssets({ ...assetSpec, mobileStaticModules: [] }),
        /Selected native modules differ/u,
      );
      await prepareAppRuntimeAssets(assetSpec);
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
      if (icu)
        assert(
          readFileSync(path.join(closure, 'runtime/files/share/icu/icudt76l.dat')).equals(icuBytes),
        );
      assert(
        readFileSync(path.join(closure, 'static-registry/link-receipt.json')).equals(
          readFileSync(receipt),
        ),
      );
      const report = readFileSync(path.join(closure, 'package-size.tsv'), 'utf8');
      assert(
        report.includes(
          `package\ttotal\t-\t-\t${data.length + icuBytes.length + registry.length + readFileSync(receipt).length}\n`,
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

test('static extension link proof retains required definitions beyond the child output buffer limit', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'android-static-symbol-output-'));
  try {
    const library = path.join(root, 'linked.so');
    const archive = path.join(root, 'vector.a');
    const registration = path.join(root, 'vector.json');
    const registry = path.join(root, 'registry.c');
    const nm = path.join(root, 'fixture-nm.mts');
    const symbols = path.join(root, 'symbols.txt');
    const status = path.join(root, 'status.txt');
    writeFileSync(library, elf(16384n));
    writeFileSync(archive, 'original static archive fixture bytes');
    writeFileSync(registry, 'original generated registry fixture bytes');
    const required = [
      'liboliphaunt_selected_static_extensions',
      'oliphaunt_static_vector_Pg_magic_func',
      'oliphaunt_static_vector__PG_init',
      'vector_dims',
    ];
    writeFileSync(
      registration,
      JSON.stringify({
        sqlName: 'vector',
        nativeModuleStem: 'vector',
        magicSymbol: required[1],
        initSymbol: required[2],
        symbols: [{ name: 'vector_dims', address: required[3] }],
      }),
    );
    const filler = Array.from(
      { length: 30_000 },
      (_, index) =>
        `0000000000000000 T oliphaunt_boundary_export_abcdefghijklmnopqrstuvwxyz_${String(index).padStart(5, '0')}\n`,
    ).join('');
    assert(Buffer.byteLength(filler) > 1024 * 1024);
    const definitions = (names: string[]) =>
      filler + names.map((name) => `0000000000000000 T ${name}\n`).join('');
    writeFileSync(symbols, definitions(required));
    writeFileSync(status, '0');
    writeFileSync(
      nm,
      `#!${process.execPath}\nimport { readFileSync } from 'node:fs';\nprocess.stdout.write(readFileSync(new URL('./symbols.txt', import.meta.url)));\nprocess.exitCode = Number(readFileSync(new URL('./status.txt', import.meta.url), 'utf8'));\nif (process.exitCode) process.stderr.write('fixture nm child failed');\n`,
    );
    chmodSync(nm, 0o755);
    const spec = {
      library,
      registry,
      members: [{ archive, registration }],
      selectedExtensions: ['pgtap', 'vector'],
      moduleStems: { pgtap: null, vector: 'vector' },
      abi: 'arm64-v8a',
      nm,
      output: path.join(root, 'receipt.json'),
    };
    extensionLinkReceipt(spec);
    const receipt = JSON.parse(readFileSync(spec.output, 'utf8'));
    const digest = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
    assert.equal(receipt.linkedSha256, digest(library));
    assert.equal(receipt.registrySha256, digest(registry));
    assert.deepEqual(receipt.selectedExtensions, spec.selectedExtensions);
    assert.equal(receipt.members[0].archiveSha256, digest(archive));
    assert.equal(receipt.members[0].registrationSha256, digest(registration));
    assert.deepEqual(receipt.members[0].definedSymbols, required.slice(1).sort());
    rmSync(spec.output);
    writeFileSync(status, '7');
    assert.throws(
      () => extensionLinkReceipt(spec),
      /declared llvm-nm failed: fixture nm child failed/u,
    );
    assert.throws(() => readFileSync(spec.output), { code: 'ENOENT' });
    writeFileSync(status, '0');
    writeFileSync(symbols, definitions(required.filter((name) => name !== 'vector_dims')));
    assert.throws(
      () => extensionLinkReceipt(spec),
      /omitted actual archive definition vector\/vector_dims/u,
    );
    assert.throws(() => readFileSync(spec.output), { code: 'ENOENT' });
    writeFileSync(symbols, definitions(required.slice(1)));
    assert.throws(() => extensionLinkReceipt(spec), /Linked static extension registry is absent/u);
    assert.throws(() => readFileSync(spec.output), { code: 'ENOENT' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

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
      moduleStems: {},
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
    for (const catalogProfile of ['standard', 'icu'] as const) {
      const prefix = catalogProfile === 'icu' ? 'cluster-seed-icu' : 'cluster-seed';
      const seed = path.join(root, `seed-${catalogProfile}`);
      mkdirSync(path.join(seed, prefix, 'files'), { recursive: true });
      const manifest = Buffer.from(`catalogProfile=${catalogProfile}\nphysicalFormat=datum64\n`);
      writeFileSync(path.join(seed, prefix, 'manifest.properties'), manifest);
      writeFileSync(path.join(seed, prefix, 'files/PG_VERSION'), '18\n');
      const seedArchive = path.join(root, `seed-${catalogProfile}.tar.gz`);
      writeFileSync(seedArchive, canonicalGzipSync(await createDeterministicTar(seed)));
      const seedOutput = path.join(root, `seed-${catalogProfile}.aar`);
      const spec = {
        source: seedArchive,
        output: seedOutput,
        kind: 'seed' as const,
        package: 'dev.oliphaunt.resources',
        catalogProfile,
      };
      await extractFinalAar(spec);
      const entries = readPortableArchiveEntries(seedOutput);
      assert.equal(
        Buffer.from(entries.get(`assets/oliphaunt/${prefix}/files/PG_VERSION`)!.data()).toString(),
        '18\n',
      );
      assert(
        Buffer.from(entries.get(`assets/oliphaunt/${prefix}/manifest.properties`)!.data()).equals(
          manifest,
        ),
      );
      await assert.rejects(
        extractFinalAar({ ...spec, catalogProfile: catalogProfile === 'icu' ? 'standard' : 'icu' }),
        /seed TAR omitted its resource manifest/u,
      );
    }
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
