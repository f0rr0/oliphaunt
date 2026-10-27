import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bundleCarrierAssets } from '../../../src/extensions/artifacts/packages/tools/bundle-carrier-assets.mts';
import { extensionControlRequires } from '../../../src/native/sdks/ts/src/native/extension-contract.ts';
import { canonicalWasixAotMetadata } from '../../../src/wasix/runtime/tools/wasix-aot-manifest.mts';
import { AOT_TARGET_TRIPLES } from '../../../src/wasix/runtime/tools/wasix-cargo-artifact-contract.mts';
import { createDeterministicTar } from '../../../tools/packaging/cargo-source-package.mts';
import {
  canonicalGzipSync,
  readPortableArchiveEntries,
  readPortableTarZstdBufferEntries,
  releaseZstdCompressSync,
} from '../../../tools/packaging/portable-archive.mts';
import {
  assertDeclaredWasixResource,
  stageCompiledWasixMember,
  type WasixCompiledCarrierSpec,
} from '../wasix_carriers.mts';
import { prepareWasixConsumerInput, readCompletedContribPayload } from './consumer_inputs.mts';

test('held contrib preserves pinned full and chunked portable members across its complete Cargo family', () => {
  const root = mkdtempSync(path.join(process.env.TEST_TMPDIR ?? os.tmpdir(), 'held-contrib-'));
  const name = 'oliphaunt-extension-contrib-pg18-wasix';
  const version = '0.3.2';
  const publication = {
    product: 'liboliphaunt-wasix',
    version,
    tagName: `liboliphaunt-wasix-v${version}`,
    publicationSha: 'a'.repeat(40),
    publicationTree: 'b'.repeat(40),
    releaseSha: 'c'.repeat(40),
  };
  let sequence = 0;
  const archive = (
    packageName: string,
    dependencies: string[],
    payload: Record<string, Buffer> = {},
    qualificationOnly = false,
  ) => {
    const directory = path.join(root, String(sequence++));
    const source = path.join(directory, 'source');
    mkdirSync(source, { recursive: true });
    writeFileSync(
      path.join(source, 'Cargo.toml'),
      `[package]\nname=${JSON.stringify(packageName)}\nversion=${JSON.stringify(version)}\n` +
        '[build-dependencies]\n' +
        dependencies.map((name) => `${name}={version="=${version}"}\n`).join('') +
        (qualificationOnly ? '[package.metadata.oliphaunt]\nqualificationOnly=false\n' : ''),
    );
    for (const [relative, bytes] of Object.entries(payload)) {
      const file = path.join(source, 'payload', relative);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, bytes);
    }
    const file = path.join(directory, `${packageName}-${version}.crate`);
    const bytes = canonicalGzipSync(
      createDeterministicTar(source, `${packageName}-${version}`, {
        fail: (message: string) => {
          throw new Error(message);
        },
      }),
    );
    writeFileSync(file, bytes);
    return {
      publication,
      artifact: `cargo:${packageName}`,
      file: {
        path: file,
        size: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      },
    };
  };
  try {
    const full = Buffer.from('original fuzzystrmatch portable archive');
    const chunked = Buffer.from('original btree_gin portable archive');
    const fullPath = 'extensions/fuzzystrmatch/extension.tar.zst';
    const chunkPath = 'extensions/btree_gin/extension.tar.zst';
    const first = `${name}-part-001`;
    const second = `${name}-part-002`;
    const original = archive(name, [first, second]);
    const parts = [
      archive(first, [], {
        [`files/${fullPath}`]: full,
        [`chunks/${chunkPath}.part000000`]: chunked.subarray(0, 12),
      }),
      archive(second, [], { [`chunks/${chunkPath}.part000001`]: chunked.subarray(12) }),
    ];
    const files = [original, ...parts].map((row) => row.file.path);
    const payload = readCompletedContribPayload(original, parts, files, version);
    assert.deepEqual(
      payload,
      new Map([
        [fullPath, full],
        [chunkPath, chunked],
      ]),
    );
    assert.throws(
      () => readCompletedContribPayload(original, parts.slice(0, 1), files.slice(0, 2), version),
      /complete Cargo payload part set/u,
    );
    for (const file of [
      { ...parts[1].file, sha256: 'f'.repeat(64) },
      { ...parts[1].file, size: parts[1].file.size + 1 },
    ])
      assert.throws(
        () =>
          readCompletedContribPayload(original, [parts[0], { ...parts[1], file }], files, version),
        assert.AssertionError,
      );
    assert.throws(
      () => readCompletedContribPayload(original, parts, files, '0.3.3'),
      assert.AssertionError,
    );
    assert.throws(
      () =>
        readCompletedContribPayload(
          original,
          [parts[0], { ...parts[1], publication: { ...publication, releaseSha: 'd'.repeat(40) } }],
          files,
          version,
        ),
      /publication differs/u,
    );
    const qualification = archive(second, [], {}, true);
    assert.throws(
      () =>
        readCompletedContribPayload(
          original,
          [parts[0], qualification],
          [files[0], files[1], qualification.file.path],
          version,
        ),
      /qualification-only/u,
    );
    const unsplit = archive(name, [], { [`files/${fullPath}`]: full });
    assert.deepEqual(
      readCompletedContribPayload(unsplit, [], [unsplit.file.path], version).get(fullPath),
      full,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('compiled contrib members retain canonical basenames within distinct aggregate locators', async () => {
  const root = mkdtempSync(path.join(process.env.TEST_TMPDIR ?? os.tmpdir(), 'wasix-member-'));
  try {
    const product = 'oliphaunt-extension-contrib-pg18';
    const version = '1.2.3';
    const basename = 'oliphaunt-extension-contrib-pg18-1.2.3-wasix-portable.tar.zst';
    const productRoot = path.join(root, 'product');
    const staged = [];
    for (const sqlName of ['btree_gin', 'pgcrypto']) {
      const module = path.join(root, `${sqlName}.wasm`);
      const moduleBytes = Buffer.from(`fixture module ${sqlName}`);
      writeFileSync(module, moduleBytes);
      const moduleSha256 = createHash('sha256').update(moduleBytes).digest('hex');
      const runtimePath = `lib/postgresql/${sqlName}.so`;
      const link = path.join(root, `${sqlName}-link.json`);
      writeFileSync(
        link,
        JSON.stringify({
          schema: 'oliphaunt-declared-wasix-extension-link-v1',
          sqlName,
          unresolvedImports: [],
          nativeModules: [
            {
              name: sqlName,
              path: runtimePath,
              sha256: moduleSha256,
              moduleSha256,
              size: moduleBytes.length,
            },
          ],
          coreExportsRequired: [],
          sourceFingerprint: 'fixture',
          postgresVersion: '18',
        }),
      );
      const image = path.join(root, `${sqlName}-aot.bin.zst`);
      writeFileSync(image, releaseZstdCompressSync(Buffer.from(`fixture AOT ${sqlName}`)));
      const spec: WasixCompiledCarrierSpec = {
        operation: 'compiled',
        product,
        version,
        sqlName,
        target: 'wasix-portable',
        descriptor: {
          'native-module-file': `${sqlName}.so`,
          dependencies: [],
          lifecycle: {
            'create-extension': false,
            'load-sql': [],
            'post-create-sql': [],
            'startup-config': [],
            'preload-required': false,
            'restart-required': false,
            'shared-memory-required': false,
          },
        },
        recipe: {},
        source: {},
        selectedDependencies: [],
        compatibility: {
          postgres_major: '18',
          extension_runtime_contract: 'oliphaunt-extension-runtime-v1',
          native_runtime_product: 'liboliphaunt-native',
          native_runtime_version: version,
          wasix_runtime_product: 'liboliphaunt-wasix',
          wasix_runtime_version: version,
        },
        releaseMetadata: {},
        carriers: [],
        outputs: { github: '', npm: '', cargo: '', manifest: '', frozen: '' },
        modules: [{ name: sqlName, path: module, runtime_path: runtimePath }],
        resources: [],
        link,
        toolchain: '',
        aot: Object.values(AOT_TARGET_TRIPLES).map((target) => {
          const canonical = canonicalWasixAotMetadata(undefined, target);
          return {
            name: `extension:${sqlName}`,
            target,
            module,
            image,
            profile: {
              engine: canonical.engine,
              wasmer_version: canonical.wasmerVersion,
              wasmer_wasix_version: canonical.wasmerWasixVersion,
            },
          };
        }),
      };
      const memberRoot = path.join(productRoot, 'member-assets', sqlName);
      const row = await stageCompiledWasixMember(spec, [], productRoot, memberRoot);
      for (const targetId of Object.keys(AOT_TARGET_TRIPLES)) {
        const delivered = JSON.parse(
          readFileSync(
            path.join(productRoot, 'wasix-aot', targetId, sqlName, 'manifest.json'),
            'utf8',
          ),
        );
        assert.equal(delivered.engine, targetId === 'windows-x64-msvc' ? 'v8' : 'llvm-opta');
      }
      if (sqlName === 'btree_gin') {
        const invalid = structuredClone(spec);
        const windows = invalid.aot.find(
          (image) => image.target === AOT_TARGET_TRIPLES['windows-x64-msvc'],
        );
        assert(windows);
        windows.profile.engine = 'llvm-opta';
        await assert.rejects(
          stageCompiledWasixMember(
            invalid,
            [],
            path.join(root, 'invalid-profile'),
            path.join(root, 'invalid-member'),
          ),
          /AOT engine profile differs/u,
        );
      }
      assert.equal(row.archiveName, basename);
      assert.equal(row.asset.name, basename);
      assert.equal(row.archive, path.join(memberRoot, basename));
      staged.push(row);
    }
    assert.notEqual(staged[0].archive, staged[1].archive);
    const members = staged.map(({ member, archive }) => ({
      ...member,
      assets: member.assets.map((asset) => ({
        ...asset,
        path: path.relative(root, archive).split(path.sep).join('/'),
      })),
    }));
    mkdirSync(path.join(productRoot, 'release-assets'));
    const carriers = bundleCarrierAssets(
      product,
      version,
      productRoot,
      members,
      staged[0].member.compatibility,
      { root },
    );
    assert.equal(carriers.length, 1);
    assert.equal(
      carriers[0].name,
      'oliphaunt-extension-contrib-pg18-1.2.3-wasix-wasix-portable-bundle.tar.gz',
    );
    assert.equal(carriers[0].memberCount, 2);
    const entries = readPortableArchiveEntries(path.resolve(root, carriers[0].path));
    for (const [index, member] of members.entries()) {
      const asset = member.assets[0];
      assert.equal(asset.memberPath, `extensions/${member.sqlName}/${basename}`);
      assert.equal(asset.carrierAsset, carriers[0].name);
      assert.equal(
        asset.carrierRoot,
        'oliphaunt-extension-contrib-pg18-1.2.3-wasix-wasix-portable-bundle',
      );
      assert.deepEqual(
        entries.get(`${asset.carrierRoot}/${asset.memberPath}`)!.data(),
        readFileSync(staged[index].archive),
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('empty delivered upgrade SQL stays valid while missing, nonregular and unsafe inputs fail', () => {
  const root = mkdtempSync(path.join(process.env.TEST_TMPDIR ?? os.tmpdir(), 'wasix-resource-'));
  try {
    const source = path.join(root, 'pg_ivm--1.12--1.13.sql');
    writeFileSync(source, '');
    assertDeclaredWasixResource({
      source,
      destination: 'share/postgresql/extension/pg_ivm--1.12--1.13.sql',
    });
    for (const destination of [
      'lib/postgresql/pg_ivm.so',
      'share/postgresql/extension/pg_ivm.control',
      'share/postgresql/tsearch_data/dict.rules',
      'share/postgresql/contrib/data.sql',
    ])
      assert.throws(
        () => assertDeclaredWasixResource({ source, destination }),
        /must be nonempty/u,
      );
    assert.throws(
      () =>
        assertDeclaredWasixResource({
          source: path.join(root, 'missing.sql'),
          destination: 'share/postgresql/extension/missing.sql',
        }),
      /ENOENT/u,
    );
    const directory = path.join(root, 'directory.sql');
    mkdirSync(directory);
    assert.throws(
      () =>
        assertDeclaredWasixResource({
          source: directory,
          destination: 'share/postgresql/extension/directory.sql',
        }),
      /regular file/u,
    );
    for (const destination of [
      'share/postgresql/extension/../escape.sql',
      '/share/postgresql/extension/absolute.sql',
      'share/postgresql//empty.sql',
    ])
      assert.throws(
        () => assertDeclaredWasixResource({ source, destination }),
        /unsafe member destination/u,
      );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('delivered control dependencies accept PostgreSQL forms and reject ambiguous declarations', () => {
  for (const control of [
    "requires = 'postgis, fuzzystrmatch'",
    'requires = postgis, fuzzystrmatch # delivered dependency list',
    "# requires = ignored\r\n  requires = 'postgis, fuzzystrmatch' # comment\r\n",
  ])
    assert.deepEqual(extensionControlRequires(control, 'fixture.control'), [
      'postgis',
      'fuzzystrmatch',
    ]);
  assert.deepEqual(extensionControlRequires('# no dependency', 'fixture.control'), []);
  assert.deepEqual(extensionControlRequires("requires = ''", 'fixture.control'), []);
  for (const control of [
    "requires = 'postgis'\nrequires = fuzzystrmatch",
    "requires = 'postgis",
    "requires = 'postgis' trailing",
    'requires = postgis,,fuzzystrmatch',
    'requires = postgis, postgis',
    'requires = ../postgis',
  ])
    assert.throws(
      () => extensionControlRequires(control, 'fixture.control'),
      /requires|dependency/u,
    );
});

test('installed PostGIS input binds all four delivered controls and only its original dependency archive', () => {
  const root = mkdtempSync(
    path.join(process.env.TEST_TMPDIR ?? os.tmpdir(), 'wasix-postgis-input-'),
  );
  try {
    const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
    let sequence = 0;
    const archive = (files: Record<string, string>) => {
      const directory = path.join(root, String(sequence++));
      for (const [relative, bytes] of Object.entries(files)) {
        const file = path.join(directory, relative);
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, bytes);
      }
      return releaseZstdCompressSync(
        createDeterministicTar(directory, '.', {
          fixedFileMode: 0o644,
          fail: (message: string) => {
            throw new Error(message);
          },
        }),
      );
    };
    const prefix = 'share/postgresql/extension/';
    const sqlMembers = ['postgis', 'postgis_raster', 'postgis_tiger_geocoder', 'postgis_topology'];
    const controls = Object.fromEntries(
      sqlMembers.map((name) => [
        `${prefix}${name}.control`,
        "default_version = '3.6.4'\n" +
          (name === 'postgis'
            ? ''
            : name === 'postgis_tiger_geocoder'
              ? 'requires = postgis, fuzzystrmatch\n'
              : "requires = 'postgis'\n"),
      ]),
    );
    const ownBytes = archive(controls);
    const nativeModuleStems = ['postgis-3', 'postgis_raster-3', 'postgis_topology-3'];
    const nativeModules = nativeModuleStems.map((name) => ({
      name,
      path: `lib/postgresql/${name}.so`,
      sha256: 'a'.repeat(64),
      moduleSha256: 'a'.repeat(64),
      size: 7,
    }));
    const member = {
      sqlName: 'postgis',
      createsExtension: true,
      nativeModuleStem: 'postgis-3',
      sqlMembers,
      nativeModuleStems,
      dependencies: ['fuzzystrmatch', 'plpgsql'],
      dataFiles: [],
      extensionSqlFileNames: [],
      extensionSqlFilePrefixes: [],
      sharedPreloadLibraries: [],
      assets: [
        {
          family: 'wasix',
          kind: 'wasix-runtime',
          target: 'wasix-portable',
          sha256: hash(ownBytes),
          bytes: ownBytes.length,
        },
      ],
      wasixInstall: {
        schema: 'oliphaunt-wasix-extension-install-v1',
        name: 'PostGIS',
        nativeModule: nativeModules[0].path,
        nativeModules,
        coreExportsRequired: [],
        dependencies: ['fuzzystrmatch', 'plpgsql'],
        loadOrder: nativeModules.map((module) => module.path),
        installedFiles: [...Object.keys(controls), ...nativeModules.map((module) => module.path)],
        unresolvedImports: [],
        lifecycle: {
          createExtension: true,
          createSchema: null,
          loadSql: [],
          postCreateSql: [],
          startupConfig: [],
          preloadRequired: false,
          restartRequired: false,
          sharedMemoryRequired: false,
        },
      },
    };
    const frozen = {
      schema: 'oliphaunt-extension-ci-artifacts-v1',
      product: 'oliphaunt-extension-postgis',
      version: '3.6.4',
      compatibility: {
        extensionRuntimeContract: 'src/extensions/contracts/contract.toml',
        postgresMajor: '18',
        nativeRuntimeProduct: 'liboliphaunt-native',
        nativeRuntimeVersion: '0.3.2',
        wasixRuntimeProduct: 'liboliphaunt-wasix',
        wasixRuntimeVersion: '0.3.2',
      },
      ...member,
    };
    const dependencyFiles = {
      [`${prefix}fuzzystrmatch.control`]: "default_version = '1.2'\n",
      'lib/postgresql/fuzzystrmatch.so': 'original selected module',
    };
    const dependencyBytes = archive(dependencyFiles);
    const dependency = {
      bytes: dependencyBytes,
      sha256: hash(dependencyBytes),
      size: dependencyBytes.length,
    };
    const requested: string[] = [];
    const input = {
      frozen,
      sqlName: 'postgis',
      portable: readPortableTarZstdBufferEntries(ownBytes),
      addonName: '@oliphaunt/wasix-napi-win32-x64-msvc',
      packageJson: '/fixture/portable/package.json',
      aotPackageJson: '/fixture/windows/package.json',
      fixturePath: '/fixture/postgis.sql',
      hostManifestPath: '/fixture/host.json',
      readDependency: (name: string) => {
        requested.push(name);
        assert.equal(name, 'fuzzystrmatch');
        return dependency;
      },
    };
    const selfContainedBytes = archive(
      Object.fromEntries(
        sqlMembers.map((name) => [`${prefix}${name}.control`, "default_version = '3.6.4'\n"]),
      ),
    );
    const selfContained = prepareWasixConsumerInput({
      ...input,
      frozen: {
        ...frozen,
        dependencies: [],
        wasixInstall: { ...member.wasixInstall, dependencies: [] },
      },
      portable: readPortableTarZstdBufferEntries(selfContainedBytes),
      readDependency: () => {
        assert.fail('dependency-free members must not authenticate unused held contrib');
      },
    });
    assert.deepEqual(selfContained.dependencies, []);
    for (const document of [
      frozen,
      { ...frozen, schema: 'oliphaunt-extension-ci-artifacts-v2', extensions: [member] },
    ]) {
      const prepared = prepareWasixConsumerInput({ ...input, frozen: document });
      assert.deepEqual(prepared.sqlMembers, [
        { sqlName: 'fuzzystrmatch', version: '1.2' },
        ...sqlMembers.map((sqlName) => ({ sqlName, version: '3.6.4' })),
      ]);
      assert.deepEqual(prepared.dependencies, [
        {
          sqlName: 'fuzzystrmatch',
          sha256: dependency.sha256,
          size: dependency.size,
          modules: ['lib/postgresql/fuzzystrmatch.so'],
        },
      ]);
      assert.deepEqual(prepared.modules, [
        'lib/postgresql/fuzzystrmatch.so',
        ...nativeModules.map((module) => module.path),
      ]);
      assert.equal(prepared.runtimeVersion, '0.3.2');
      assert.equal(prepared.defaultVersion, '3.6.4');
      assert.deepEqual(prepared.extensionPackage, {
        sqlName: 'postgis',
        product: frozen.product,
        version: frozen.version,
        packageJson: input.packageJson,
        archiveSha256: hash(ownBytes),
        archiveSize: ownBytes.length,
        aotPackageJson: input.aotPackageJson,
      });
    }
    assert.deepEqual(requested, ['fuzzystrmatch', 'fuzzystrmatch']);
    const missing = new Map(input.portable);
    missing.delete(`${prefix}postgis_raster.control`);
    assert.throws(
      () => prepareWasixConsumerInput({ ...input, portable: missing }),
      /frozen member closure/u,
    );
    assert.throws(
      () => prepareWasixConsumerInput({ ...input, readDependency: () => null }),
      /original dependency/u,
    );
    for (const invalid of [
      { ...dependency, sha256: 'f'.repeat(64) },
      { ...dependency, size: dependency.size + 1 },
    ])
      assert.throws(
        () => prepareWasixConsumerInput({ ...input, readDependency: () => invalid }),
        assert.AssertionError,
      );
    const cycleBytes = archive({
      ...controls,
      [`${prefix}postgis.control`]: "default_version = '3.6.4'\nrequires = postgis_topology\n",
    });
    assert.throws(
      () =>
        prepareWasixConsumerInput({
          ...input,
          portable: readPortableTarZstdBufferEntries(cycleBytes),
        }),
      /dependency cycle/u,
    );
    const companionBytes = archive({
      ...dependencyFiles,
      [`${prefix}fuzzy_helper.control`]:
        "default_version = '1.0'\nrequires = postgis_tiger_geocoder\n",
    });
    const companion = prepareWasixConsumerInput({
      ...input,
      readDependency: () => ({
        bytes: companionBytes,
        sha256: hash(companionBytes),
        size: companionBytes.length,
      }),
    });
    assert(companion.sqlMembers.some((member) => member.sqlName === 'fuzzy_helper'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
