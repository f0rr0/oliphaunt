import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expectedExtensionBundleManifest } from './check-carriers.mts';
import {
  composeExtensionReleaseDocuments,
  extensionReleasePropertiesText,
  writeReleaseControls,
} from './build-extension-ci-artifacts.mts';
import { parseUniquePropertiesText } from '../../../../../tools/packaging/release-carrier.mts';

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
