import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expectedExtensionBundleManifest } from './check-carriers.mts';
import {
  composeExtensionReleaseDocuments,
  extensionReleasePropertiesText,
  writeReleaseControls,
} from './build-extension-ci-artifacts.mts';
import { parseUniquePropertiesText } from '../../../../../tools/packaging/release-carrier.mts';
import { createDeterministicTar } from '../../../../../tools/packaging/cargo-source-package.mts';
import { canonicalGzipSync } from '../../../../../tools/packaging/portable-archive.mts';
import {
  extensionMetadata,
  extensionSourceIdentity,
  ROOT,
} from '../../../../../tools/release/release-artifact-targets.mts';
import { loadPublicationCatalog } from '../../../../../tools/release/publication-catalog.mts';
import { extensionGithubReleaseFixture } from '../../../../../tools/release/testdata/publication-artifact-fixtures.mts';
import { bundleCarrierAssets } from './bundle-carrier-assets.mts';

test('checks composed singleton and bundle optional member facts against their frozen values', () => {
  mkdirSync(path.join(ROOT, 'target'), { recursive: true });
  const root = mkdtempSync(path.join(ROOT, 'target/check-carriers-optional-'));
  try {
    const payloadRoot = path.join(root, 'payload');
    mkdirSync(payloadRoot);
    writeFileSync(path.join(payloadRoot, 'fixture.txt'), 'runtime fixture\n');
    const payload = canonicalGzipSync(createDeterministicTar(payloadRoot, 'runtime', {}));
    for (const [id, product] of [
      ['oliphaunt-extension-vector', 'oliphaunt-extension-vector'],
      ['liboliphaunt-native', 'oliphaunt-extension-contrib-pg18'],
    ]) {
      const catalogProduct = loadPublicationCatalog('check-carriers.test', { products: [id] })
        .products[0];
      const fixture = extensionGithubReleaseFixture(root, catalogProduct, {
        artifactProduct: product,
        family: 'native',
      });
      const frozen = JSON.parse(readFileSync(fixture.manifestPath, 'utf8'));
      const members = frozen.extensions ?? [frozen];
      rmSync(fixture.directory, { recursive: true });
      mkdirSync(fixture.directory);
      for (const member of members) {
        member.iosNativeDependencies = [];
        member.iosRegistration = null;
        member.assets = member.assets
          .filter((asset) => asset.target === 'linux-x64-gnu')
          .map((asset) => {
            writeFileSync(asset.path, payload);
            return {
              ...asset,
              source: 'fixture',
              path: path.relative(ROOT, asset.path).split(path.sep).join('/'),
              sha256: createHash('sha256').update(payload).digest('hex'),
              bytes: payload.length,
            };
          });
      }
      const productRoot = path.dirname(fixture.manifestPath);
      const directAssets =
        members.length === 1
          ? members[0].assets
          : bundleCarrierAssets(
              product,
              frozen.version,
              productRoot,
              members,
              frozen.compatibility,
              {
                root: ROOT,
              },
            );
      const metadata = extensionMetadata(product, 'check-carriers.test');
      const controls = () =>
        writeReleaseControls({
          product,
          releaseProduct: id,
          family: 'native',
          version: frozen.version,
          members,
          directAssets,
          productRoot,
          releaseMetadata: metadata,
          ...composeExtensionReleaseDocuments({
            product,
            releaseProduct: id,
            family: 'native',
            version: frozen.version,
            members,
            directAssets,
            releaseMetadata: metadata,
            sourceIdentity: extensionSourceIdentity(product, 'check-carriers.test'),
          }),
        });
      const check = () =>
        spawnSync(
          process.execPath,
          [
            '--no-env-file',
            '--no-install',
            path.join(import.meta.dir, 'check-carriers.mts'),
            product,
            '--family',
            'native',
          ],
          {
            cwd: ROOT,
            env: {
              ...process.env,
              OLIPHAUNT_EXTENSION_ARTIFACT_ROOT: path.relative(
                ROOT,
                path.join(root, 'target/extension-artifacts'),
              ),
            },
            encoding: 'utf8',
          },
        );
      controls();
      let result = check();
      assert.equal(result.status, 0, result.stderr);
      const selected = members.find((member) => member.nativeModuleStem !== null);
      selected.nativeDependencyModules = ['fixture.so'];
      selected.nativeConstructionLicenseFiles = [];
      controls();
      result = check();
      assert.equal(result.status, 0, result.stderr);
      for (const field of ['nativeDependencyModules', 'nativeConstructionLicenseFiles']) {
        const { releaseManifest } = controls();
        const publicDocument = JSON.parse(readFileSync(releaseManifest, 'utf8'));
        const publicMember =
          publicDocument.extensions?.find((member) => member.sqlName === selected.sqlName) ??
          publicDocument;
        delete publicMember[field];
        writeFileSync(releaseManifest, JSON.stringify(publicDocument));
        result = check();
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /keys must be|must exactly match stable metadata/u);
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('explicit external native controls retain their family while combined defaults stay unchanged', () => {
  const product = 'oliphaunt-extension-pgtap';
  const inputs = {
    product,
    version: '9.1.0',
    members: [
      {
        sqlName: 'pgtap',
        createsExtension: true,
        dependencies: [],
        dataFiles: [],
        extensionSqlFileNames: [],
        extensionSqlFilePrefixes: [],
        nativeModuleStem: null,
        iosNativeDependencies: [],
        iosRegistration: null,
        wasixInstall: null,
        sharedPreloadLibraries: [],
        assets: [],
      },
    ],
    directAssets: [],
    releaseMetadata: {
      class: 'external',
      versioning: 'independent',
      sourceIdentity: { kind: 'git' },
      compatibility: {},
    },
  };
  const legacy = composeExtensionReleaseDocuments(inputs);
  for (const document of [legacy.manifest, legacy.releaseData]) {
    assert.equal(Object.hasOwn(document, 'releaseProduct'), false);
    assert.equal(Object.hasOwn(document, 'family'), false);
  }
  const legacyProperties = parseUniquePropertiesText(
    extensionReleasePropertiesText({
      ...inputs,
      ...legacy,
    }),
  );
  assert.equal(legacyProperties.releaseProduct, undefined);
  assert.equal(legacyProperties.carrierFamily, undefined);

  const native = composeExtensionReleaseDocuments({ ...inputs, family: 'native' });
  for (const document of [native.manifest, native.releaseData]) {
    assert.equal(document.releaseProduct, product);
    assert.equal(document.family, 'native');
  }
  const nativeBefore = structuredClone(native.manifest);
  const combined = composeExtensionReleaseDocuments({ ...inputs, members: [native.manifest] });
  for (const document of [combined.manifest, combined.releaseData]) {
    assert.equal(Object.hasOwn(document, 'releaseProduct'), false);
    assert.equal(Object.hasOwn(document, 'family'), false);
  }
  assert.deepEqual(native.manifest, nativeBefore);

  const member = {
    ...inputs.members[0],
    assets: [
      {
        name: 'fixture.tar.gz',
        family: 'native',
        target: 'linux-x64-gnu',
        kind: 'runtime',
        identity: null,
        sha256: 'a'.repeat(64),
        bytes: 1,
      },
    ],
  };
  const envelope = ['schema', 'product', 'releaseProduct', 'family', 'version', 'compatibility'];
  for (const count of [1, 2]) {
    const members = Array.from({ length: count }, (_, index) => ({
      ...member,
      sqlName: `member${index}`,
      schema: 'foreign-schema',
      product: 'foreign-product',
      releaseProduct: 'foreign-owner',
      family: 'foreign-family',
      version: '0.0.0',
      compatibility: { foreign: true },
    }));
    const before = structuredClone(members);
    for (const ownership of [
      { releaseProduct: product, family: null },
      { releaseProduct: product, family: 'native' },
      { releaseProduct: 'liboliphaunt-wasix', family: 'wasix' },
    ]) {
      const documents = composeExtensionReleaseDocuments({
        ...inputs,
        ...ownership,
        members,
        directAssets: member.assets,
      });
      for (const [kind, document] of Object.entries(documents)) {
        assert.equal(
          document.schema,
          `oliphaunt-extension-${kind === 'manifest' ? 'ci-artifacts' : 'release-manifest'}-v${count}`,
        );
        assert.equal(document.product, product);
        assert.equal(document.version, inputs.version);
        assert.deepEqual(document.compatibility, inputs.releaseMetadata.compatibility);
        if (count === 2)
          assert.deepEqual(
            document[kind === 'manifest' ? 'carrierAssets' : 'assets'],
            member.assets,
          );
        if (ownership.family === null) {
          assert.equal(Object.hasOwn(document, 'releaseProduct'), false);
          assert.equal(Object.hasOwn(document, 'family'), false);
        } else {
          assert.equal(document.releaseProduct, ownership.releaseProduct);
          assert.equal(document.family, ownership.family);
        }
        for (const [index, row] of (count === 1 ? [document] : document.extensions).entries()) {
          for (const [key, value] of Object.entries({ ...member, sqlName: `member${index}` }))
            assert.deepEqual(row[key], value);
          if (count === 2) for (const key of envelope) assert.equal(Object.hasOwn(row, key), false);
        }
      }
    }
    assert.deepEqual(members, before);
  }
  const root = mkdtempSync(path.join(tmpdir(), 'external-native-controls-test-'));
  try {
    const productRoot = path.join(root, product);
    mkdirSync(path.join(productRoot, 'release-assets'), { recursive: true });
    const controls = writeReleaseControls({
      ...inputs,
      ...native,
      releaseProduct: product,
      family: 'native',
      productRoot,
      root,
    });
    const manifest = JSON.parse(readFileSync(controls.releaseManifest, 'utf8'));
    assert.equal(manifest.releaseProduct, product);
    assert.equal(manifest.family, 'native');
    const properties = parseUniquePropertiesText(readFileSync(controls.propertiesManifest, 'utf8'));
    assert.equal(properties.releaseProduct, product);
    assert.equal(properties.carrierFamily, 'native');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('derives nested bundle compatibility from the staged bundle data', () => {
  const compatibility = {
    nativeRuntimeProduct: 'liboliphaunt-native',
    nativeRuntimeVersion: '1.2.3',
    postgresMajor: '18',
  };
  const carrier = {
    family: 'native',
    target: 'android-arm64-v8a',
  };
  const rows = [
    {
      member: { sqlName: 'cube' },
      asset: {
        bytes: 123,
        identity: null,
        kind: 'runtime',
        memberPath: 'extensions/cube/cube.tar.gz',
        sha256: 'a'.repeat(64),
      },
    },
  ];

  assert.deepEqual(
    expectedExtensionBundleManifest({
      product: 'oliphaunt-extension-contrib-pg18',
      version: '1.0.0',
      data: { compatibility },
      carrier,
      rows,
    }),
    {
      schema: 'oliphaunt-extension-bundle-v1',
      product: 'oliphaunt-extension-contrib-pg18',
      version: '1.0.0',
      compatibility,
      family: 'native',
      target: 'android-arm64-v8a',
      licenseProfile: 'contrib-native',
      licenseFiles: [],
      members: [
        {
          sqlName: 'cube',
          kind: 'runtime',
          identity: null,
          path: 'extensions/cube/cube.tar.gz',
          sha256: 'a'.repeat(64),
          bytes: 123,
        },
      ],
    },
  );
});

test('renders every single-extension asset identity into the public properties manifest', () => {
  const dependencyIdentities = ['geos', 'geos-c', 'json-c', 'libxml2', 'proj', 'sqlite'];
  const assets = [
    ...dependencyIdentities.map((identity) => ({
      family: 'native',
      target: 'ios-xcframework',
      kind: 'ios-dependency-xcframework',
      identity,
      name: `postgis-${identity}.zip`,
    })),
    {
      family: 'native',
      target: 'ios-xcframework',
      kind: 'ios-xcframework',
      identity: 'postgis-3',
      name: 'postgis.zip',
    },
    {
      family: 'native',
      target: 'ios-xcframework',
      kind: 'runtime',
      identity: null,
      name: 'postgis-runtime.tar.gz',
    },
  ];
  const text = extensionReleasePropertiesText({
    product: 'oliphaunt-extension-postgis',
    version: '1.0.0',
    manifest: {
      schema: 'oliphaunt-extension-ci-artifacts-v1',
      sqlName: 'postgis',
      createsExtension: true,
      dependencies: [],
      dataFiles: ['contrib/postgis-3.6/postgis.sql', 'proj/proj.db'],
      extensionSqlFileNames: ['uninstall_postgis.sql'],
      extensionSqlFilePrefixes: ['postgis_comments', 'rtpostgis'],
      nativeModuleStem: 'postgis-3',
      iosNativeDependencies: dependencyIdentities,
      sharedPreloadLibraries: [],
      assets,
    },
    releaseData: {
      schema: 'oliphaunt-extension-release-manifest-v1',
      extensionClass: 'external',
      versioning: 'independent',
      sourceIdentity: { kind: 'git' },
    },
    directAssets: assets,
  });
  const assetLines = text.split('\n').filter((line) => line.startsWith('asset.'));

  assert.deepEqual(assetLines, [
    'asset.native.ios-xcframework.ios-dependency-xcframework.geos=postgis-geos.zip',
    'asset.native.ios-xcframework.ios-dependency-xcframework.geos-c=postgis-geos-c.zip',
    'asset.native.ios-xcframework.ios-dependency-xcframework.json-c=postgis-json-c.zip',
    'asset.native.ios-xcframework.ios-dependency-xcframework.libxml2=postgis-libxml2.zip',
    'asset.native.ios-xcframework.ios-dependency-xcframework.proj=postgis-proj.zip',
    'asset.native.ios-xcframework.ios-dependency-xcframework.sqlite=postgis-sqlite.zip',
    'asset.native.ios-xcframework.ios-xcframework.postgis-3=postgis.zip',
    'asset.native.ios-xcframework.runtime=postgis-runtime.tar.gz',
  ]);
  assert.equal(
    Object.keys(parseUniquePropertiesText(text)).filter((key) => key.startsWith('asset.')).length,
    8,
  );
  const properties = parseUniquePropertiesText(text);
  assert.equal(properties.createsExtension, 'true');
  assert.equal(properties.dataFiles, 'contrib/postgis-3.6/postgis.sql,proj/proj.db');
  assert.equal(properties.extensionSqlFileNames, 'uninstall_postgis.sql');
  assert.equal(properties.extensionSqlFilePrefixes, 'postgis_comments,rtpostgis');
  assert.doesNotMatch(text, /^carrier\./mu);
});

test('freezes each bundle member desktop inventory in the public properties manifest', () => {
  const text = extensionReleasePropertiesText({
    product: 'oliphaunt-extension-contrib-pg18',
    version: '1.0.0',
    manifest: {
      schema: 'oliphaunt-extension-ci-artifacts-v2',
      extensions: [
        {
          sqlName: 'pgtap',
          createsExtension: true,
          dependencies: [],
          dataFiles: [],
          extensionSqlFileNames: ['uninstall_pgtap.sql'],
          extensionSqlFilePrefixes: ['pgtap-core', 'pgtap-schema'],
          nativeModuleStem: null,
          iosNativeDependencies: [],
          sharedPreloadLibraries: [],
          assets: [],
        },
      ],
    },
    releaseData: {
      schema: 'oliphaunt-extension-release-manifest-v2',
      extensionClass: 'contrib',
      versioning: 'coordinated',
      sourceIdentity: { kind: 'repository' },
    },
    directAssets: [],
  });
  const properties = parseUniquePropertiesText(text);

  assert.equal(properties['extension.pgtap.createsExtension'], 'true');
  assert.equal(properties['extension.pgtap.dataFiles'], '');
  assert.equal(properties['extension.pgtap.extensionSqlFileNames'], 'uninstall_pgtap.sql');
  assert.equal(properties['extension.pgtap.extensionSqlFilePrefixes'], 'pgtap-core,pgtap-schema');
});
