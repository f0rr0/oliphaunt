import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bundleCarrierAssets } from '../../../src/extensions/artifacts/packages/tools/bundle-carrier-assets.mts';
import { AOT_TARGET_TRIPLES } from '../../../src/wasix/runtime/tools/wasix-cargo-artifact-contract.mts';
import {
  readPortableArchiveEntries,
  releaseZstdCompressSync,
} from '../../../tools/packaging/portable-archive.mts';
import {
  assertDeclaredWasixResource,
  stageCompiledWasixMember,
  type WasixCompiledCarrierSpec,
} from '../wasix_carriers.mts';

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
        aot: Object.values(AOT_TARGET_TRIPLES).map((target) => ({
          name: `extension:${sqlName}`,
          target,
          module,
          image,
        })),
      };
      const memberRoot = path.join(productRoot, 'member-assets', sqlName);
      const row = await stageCompiledWasixMember(spec, [], productRoot, memberRoot);
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
