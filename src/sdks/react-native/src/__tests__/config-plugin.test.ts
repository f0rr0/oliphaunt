import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';

const require = createRequire(import.meta.url);
const {
  extensionPackageName,
  ensureIosDeploymentTarget,
  ensureIosConfigDeploymentTarget,
  insertAppGradlePlugin,
  insertIosPodfileBlock,
  iosStageCommand,
  normalizeOptions,
  readCarrierSummary,
  releaseOwnerForSqlName,
  resolveInstalledExtensionOwners,
  resolveIosCarrierManifests,
  selectedExtensionClosure,
  serializeExtensionVersions,
  stageIosAppPayload,
} = require('../../app.plugin.js');
const packageJson = require('../../package.json');
const sdkRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const CARRIER_SCHEMA = 'oliphaunt-react-native-ios-carrier-v1';
const CARRIER_FILENAME = 'oliphaunt-react-native-ios-carriers.json';

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function writeCarrier(
  file: string,
  extensions: Array<{
    dependencies: string[];
    product?: string;
    sqlName: string;
    tag?: string;
    version?: string;
  }>,
  options: {
    baseVersion?: string;
    ownerVersions?: Record<string, string>;
  } = {},
): void {
  const baseVersion = options.baseVersion ?? '1.2.3';
  writeJson(file, {
    schema: CARRIER_SCHEMA,
    base: {
      assets: [],
      product: 'liboliphaunt-native',
      tag: `liboliphaunt-native-v${baseVersion}`,
      version: baseVersion,
    },
    carriers: [],
    extensions: extensions.map((row) => {
      const owner = releaseOwnerForSqlName(row.sqlName);
      const product = row.product ?? owner.releaseProduct;
      const version = row.version ?? options.ownerVersions?.[owner.releaseProduct] ?? baseVersion;
      return {
        ...row,
        product,
        tag: row.tag ?? `${product}-v${version}`,
        version,
      };
    }),
  });
}

function writeCarrierPackage(
  packageRoot: string,
  packageName: string,
  extensions: Array<{ sqlName: string; dependencies: string[] }>,
  options: {
    kind?: string;
    liboliphauntVersion?: string;
    members?: string[];
    product?: string;
    version?: string;
  } = {},
): string {
  const carrier = path.join(packageRoot, CARRIER_FILENAME);
  const packageVersion = options.version ?? '1.2.3';
  const nativeVersion = options.liboliphauntVersion ?? packageVersion;
  writeCarrier(carrier, extensions, {
    baseVersion: nativeVersion,
    ownerVersions: options.product ? { [options.product]: packageVersion } : {},
  });
  writeJson(path.join(packageRoot, 'package.json'), {
    name: packageName,
    version: packageVersion,
    exports: { './package.json': './package.json' },
    oliphaunt: {
      iosCarrierManifest: `./${CARRIER_FILENAME}`,
      kind: options.kind,
      liboliphauntVersion: options.liboliphauntVersion,
      members: options.members,
      product: options.product,
      sqlName: options.members?.length === 1 ? options.members[0] : undefined,
    },
  });
  return carrier;
}

test('normalizes exact extension selection', () => {
  const normalized = normalizeOptions({
    extensions: ['vector', 'pg_trgm', 'vector'],
    icu: true,
    liboliphauntVersion: '0.1.0',
  });

  assert.deepEqual(normalized, {
    extensions: ['pg_trgm', 'vector'],
    icu: true,
    liboliphauntVersion: '0.1.0',
    assetBaseUrl: undefined,
    kotlinPluginVersion: packageJson.oliphaunt.kotlinSdkVersion,
  });
  assert.throws(
    () => normalizeOptions({ extensions: ['core,vector'] }),
    /exact PostgreSQL extension name/,
  );
  assert.throws(
    () => normalizeOptions({ extensions: ['pg_search'] }),
    /not in the generated exact-extension catalog/,
  );
  assert.deepEqual(normalizeOptions({ extensions: ['postgis'] }).extensions, ['postgis']);
  assert.equal(extensionPackageName('uuid-ossp'), '@oliphaunt/extension-contrib-pg18');
  assert.equal(extensionPackageName('vector'), '@oliphaunt/extension-vector');
  assert.deepEqual(selectedExtensionClosure(['earthdistance']), ['cube', 'earthdistance']);
  assert.deepEqual(releaseOwnerForSqlName('hstore'), {
    members: releaseOwnerForSqlName('earthdistance').members,
    mavenArtifact: 'oliphaunt-extension-contrib-pg18',
    mavenGroup: 'dev.oliphaunt.extensions',
    npmPackage: '@oliphaunt/extension-contrib-pg18',
    releaseProduct: 'oliphaunt-extension-contrib-pg18',
    runtimeBound: true,
  });
});

test('Podfile patch is app-owned, fail-closed, and idempotent', () => {
  const podfile = [
    "target 'OliphauntExample' do",
    '  use_expo_modules!',
    '  config = use_native_modules!',
    'end',
    '',
  ].join('\n');

  const patchedPodfile = insertIosPodfileBlock(podfile, { icu: true });
  assert.match(patchedPodfile, /# @oliphaunt\/react-native begin/);
  assert.match(
    patchedPodfile,
    /pod 'COliphaunt', :podspec => File\.join\(oliphaunt_podspecs_path, 'COliphaunt\.podspec'\), :modular_headers => true/,
  );
  assert.match(
    patchedPodfile,
    /pod 'Oliphaunt', :podspec => File\.join\(oliphaunt_podspecs_path, 'Oliphaunt\.podspec'\)/,
  );
  assert.match(
    patchedPodfile,
    /oliphaunt_payload_path = File\.expand_path\('oliphaunt', __dir__\)/,
  );
  assert.match(
    patchedPodfile,
    /oliphaunt_payload_podspec = File\.join\(oliphaunt_payload_path, 'OliphauntReactNativePayload\.podspec'\)/,
  );
  assert.match(patchedPodfile, /raise 'Oliphaunt iOS payload is missing/);
  assert.match(
    patchedPodfile,
    /pod 'OliphauntReactNativePayload', :path => oliphaunt_payload_path/,
  );
  assert.doesNotMatch(
    patchedPodfile,
    /pod 'OliphauntReactNativePayload', :podspec/,
  );
  assert.doesNotMatch(patchedPodfile, /OliphauntICU/);
  assert.equal(insertIosPodfileBlock(patchedPodfile, { icu: true }), patchedPodfile);

  assert.throws(
    () => insertIosPodfileBlock("target 'App' do\nend\n"),
    /use_native_modules! or use_expo_modules!/,
  );
  assert.throws(
    () => insertIosPodfileBlock('# @oliphaunt/react-native begin\n'),
    /partial @oliphaunt\/react-native managed block/,
  );
});

test('Expo iOS deployment target meets the packaged pod minimum without lowering newer apps', () => {
  assert.deepEqual(ensureIosDeploymentTarget({}), { 'ios.deploymentTarget': '17.0' });
  assert.deepEqual(
    ensureIosDeploymentTarget({ 'ios.deploymentTarget': '16.4', keep: 'value' }),
    { 'ios.deploymentTarget': '17.0', keep: 'value' },
  );
  assert.deepEqual(ensureIosDeploymentTarget({ 'ios.deploymentTarget': '17' }), {
    'ios.deploymentTarget': '17',
  });
  assert.deepEqual(ensureIosDeploymentTarget({ 'ios.deploymentTarget': '18.1' }), {
    'ios.deploymentTarget': '18.1',
  });
  assert.throws(
    () => ensureIosDeploymentTarget({ 'ios.deploymentTarget': 'latest' }),
    /numeric dotted version/,
  );
  assert.deepEqual(ensureIosConfigDeploymentTarget({ name: 'app' }), {
    name: 'app',
    ios: { deploymentTarget: '17.0' },
  });
  assert.deepEqual(
    ensureIosConfigDeploymentTarget({ ios: { bundleIdentifier: 'dev.example', deploymentTarget: '18.0' } }),
    { ios: { bundleIdentifier: 'dev.example', deploymentTarget: '18.0' } },
  );
});

test('base React Native pod is source-only', () => {
  const podspec = fs.readFileSync(path.join(sdkRoot, 'OliphauntReactNative.podspec'), 'utf8');
  assert.match(podspec, /s\.source_files = "ios\/\*\.\{h,m,mm,swift\}"/);
  assert.doesNotMatch(podspec, /ios\/(?:generated|resources|frameworks|extension-frameworks)/);
  assert.doesNotMatch(podspec, /vendored_frameworks|user_target_xcconfig|s\.resources/);
});

test('Android Gradle patch stays idempotent', () => {
  const appGradle = "plugins {\n    id 'com.android.application'\n}\n";
  const patchedAppGradle = insertAppGradlePlugin(appGradle, '0.1.0');
  assert.match(patchedAppGradle, /id 'dev\.oliphaunt\.android' version '0\.1\.0'/);
  assert.equal(insertAppGradlePlugin(patchedAppGradle, '0.1.0'), patchedAppGradle);
});

test('carrier discovery de-duplicates runtime-bound bundle dependencies', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oliphaunt-plugin-carriers-'));
  try {
    const projectRoot = path.join(root, 'app');
    const baseRoot = path.join(root, 'react-native');
    const contribRoot = path.join(
      projectRoot,
      'node_modules',
      '@oliphaunt',
      'extension-contrib-pg18',
    );
    const baseCarrier = writeCarrierPackage(baseRoot, '@oliphaunt/react-native', []);
    const members = releaseOwnerForSqlName('earthdistance').members;
    const contribCarrier = writeCarrierPackage(
      contribRoot,
      '@oliphaunt/extension-contrib-pg18',
      members.map((sqlName: string) => ({
        dependencies: sqlName === 'earthdistance' ? ['cube'] : [],
        sqlName,
      })),
      {
        kind: 'exact-extension-bundle',
        liboliphauntVersion: '1.2.3',
        members,
        product: 'oliphaunt-extension-contrib-pg18',
      },
    );

    const manifests = resolveIosCarrierManifests(projectRoot, ['earthdistance'], {
      basePackageRoot: baseRoot,
      env: {},
    });
    assert.deepEqual(manifests, [baseCarrier, contribCarrier]);
  } finally {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

test('Android package discovery passes exact owner versions and rejects compatibility conflicts', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oliphaunt-plugin-android-owners-'));
  try {
    const projectRoot = path.join(root, 'app');
    const scopeRoot = path.join(projectRoot, 'node_modules', '@oliphaunt');
    const members = releaseOwnerForSqlName('earthdistance').members;
    writeCarrierPackage(
      path.join(scopeRoot, 'extension-contrib-pg18'),
      '@oliphaunt/extension-contrib-pg18',
      members.map((sqlName: string) => ({
        dependencies: sqlName === 'earthdistance' ? ['cube'] : [],
        sqlName,
      })),
      {
        kind: 'exact-extension-bundle',
        liboliphauntVersion: '1.2.3',
        members,
        product: 'oliphaunt-extension-contrib-pg18',
      },
    );
    writeCarrierPackage(
      path.join(scopeRoot, 'extension-vector'),
      '@oliphaunt/extension-vector',
      [{ dependencies: [], sqlName: 'vector' }],
      {
        kind: 'exact-extension',
        liboliphauntVersion: '1.2.3',
        members: ['vector'],
        product: 'oliphaunt-extension-vector',
        version: '0.8.1',
      },
    );

    const resolution = resolveInstalledExtensionOwners(projectRoot, ['earthdistance', 'vector'], {
      liboliphauntVersion: '1.2.3',
    });
    assert.deepEqual(resolution.closure, ['cube', 'earthdistance', 'vector']);
    assert.equal(resolution.owners.length, 2);
    assert.deepEqual(resolution.extensionVersions, {
      'oliphaunt-extension-contrib-pg18': '1.2.3',
      'oliphaunt-extension-vector': '0.8.1',
    });
    assert.equal(
      serializeExtensionVersions(resolution.extensionVersions),
      'oliphaunt-extension-contrib-pg18=1.2.3,oliphaunt-extension-vector=0.8.1',
    );
    assert.throws(
      () =>
        resolveInstalledExtensionOwners(projectRoot, ['earthdistance'], {
          liboliphauntVersion: '1.2.4',
        }),
      /requires liboliphaunt 1\.2\.3, but the app selected 1\.2\.4/,
    );

    const vectorPackage = path.join(scopeRoot, 'extension-vector', 'package.json');
    const vectorMetadata = JSON.parse(fs.readFileSync(vectorPackage, 'utf8'));
    vectorMetadata.version = '01.2.3';
    writeJson(vectorPackage, vectorMetadata);
    assert.throws(
      () => resolveInstalledExtensionOwners(projectRoot, ['vector']),
      /package metadata has an invalid version/,
    );

    const contribPackage = path.join(scopeRoot, 'extension-contrib-pg18', 'package.json');
    const metadata = JSON.parse(fs.readFileSync(contribPackage, 'utf8'));
    metadata.version = '1.2.4';
    writeJson(contribPackage, metadata);
    assert.throws(
      () => resolveInstalledExtensionOwners(projectRoot, ['earthdistance']),
      /is runtime-bound but version 1\.2\.4 does not match liboliphauntVersion 1\.2\.3/,
    );
  } finally {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

test('carrier env overrides are exact and stage only into the app ios tree', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oliphaunt-plugin-stage-'));
  try {
    const projectRoot = path.join(root, 'app');
    const iosRoot = path.join(projectRoot, 'ios');
    const manifestsRoot = path.join(root, 'manifests');
    const baseCarrier = path.join(manifestsRoot, 'base.json');
    const cubeCarrier = path.join(manifestsRoot, 'cube.json');
    const earthdistanceCarrier = path.join(manifestsRoot, 'earthdistance.json');
    writeCarrier(baseCarrier, []);
    writeCarrier(cubeCarrier, [{ sqlName: 'cube', dependencies: [] }]);
    writeCarrier(earthdistanceCarrier, [{ sqlName: 'earthdistance', dependencies: ['cube'] }]);
    const env = {
      OLIPHAUNT_REACT_NATIVE_IOS_BASE_CARRIER: baseCarrier,
      OLIPHAUNT_REACT_NATIVE_IOS_EXTENSION_CARRIERS: JSON.stringify({
        cube: cubeCarrier,
        earthdistance: earthdistanceCarrier,
      }),
      OLIPHAUNT_REACT_NATIVE_IOS_ALLOW_FILE_URLS: 'true',
      OLIPHAUNT_REACT_NATIVE_IOS_CACHE_DIR: './.oliphaunt-cache',
    };
    const normalized = {
      extensions: ['earthdistance'],
      icu: true,
    };

    const command = iosStageCommand(projectRoot, iosRoot, normalized, { env });
    assert.deepEqual(command.carrierManifests, [baseCarrier, cubeCarrier, earthdistanceCarrier]);
    assert.equal(command.outputDir, path.join(iosRoot, 'oliphaunt'));
    assert.equal(command.args.filter((arg: string) => arg === '--carrier').length, 3);
    assert.deepEqual(command.args.slice(-8), [
      '--output-dir',
      path.join(iosRoot, 'oliphaunt'),
      '--extensions',
      'earthdistance',
      '--icu',
      '--cache-dir',
      path.join(projectRoot, '.oliphaunt-cache'),
      '--allow-file-urls',
    ]);
    assert.ok(command.args.includes('--allow-file-urls'));
    assert.ok(!command.outputDir.includes('node_modules'));

    let spawned = false;
    stageIosAppPayload(projectRoot, iosRoot, normalized, {
      env,
      spawnSyncImpl: (_executable: string, args: string[], options: { cwd: string }) => {
        spawned = true;
        assert.equal(options.cwd, projectRoot);
        const outputIndex = args.indexOf('--output-dir');
        const outputDir = args[outputIndex + 1];
        if (outputIndex < 0 || outputDir === undefined) {
          throw new Error('stage command omitted --output-dir');
        }
        fs.mkdirSync(outputDir, { recursive: true });
        fs.writeFileSync(
          path.join(outputDir, 'OliphauntReactNativePayload.podspec'),
          'Pod::Spec.new\n',
        );
        return { error: undefined, status: 0, stderr: '', stdout: '' };
      },
    });
    assert.equal(spawned, true);
    assert.equal(fs.existsSync(path.join(projectRoot, 'node_modules')), false);
  } finally {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

test('aggregate CI carrier override supplies base and dependency closure exactly once', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oliphaunt-plugin-aggregate-'));
  try {
    const projectRoot = path.join(root, 'app');
    const aggregateCarrier = path.join(root, 'aggregate.json');
    writeCarrier(aggregateCarrier, [
      { sqlName: 'cube', dependencies: [] },
      { sqlName: 'earthdistance', dependencies: ['cube'] },
      { sqlName: 'vector', dependencies: [] },
    ]);
    const env = {
      OLIPHAUNT_REACT_NATIVE_IOS_BASE_CARRIER: aggregateCarrier,
    };
    const packageJsonResolver = () => {
      throw new Error('aggregate CI mode must not resolve extension packages');
    };

    assert.deepEqual(
      resolveIosCarrierManifests(projectRoot, ['earthdistance'], {
        env,
        packageJsonResolver,
      }),
      [aggregateCarrier],
    );
    const command = iosStageCommand(
      projectRoot,
      path.join(projectRoot, 'ios'),
      { extensions: ['earthdistance'], icu: false },
      { env, packageJsonResolver },
    );
    assert.equal(command.args.filter((arg: string) => arg === '--carrier').length, 1);
    assert.deepEqual(command.carrierManifests, [aggregateCarrier]);
    assert.throws(
      () =>
        resolveIosCarrierManifests(projectRoot, ['earthdistance'], {
          env: {
            ...env,
            OLIPHAUNT_REACT_NATIVE_IOS_EXTENSION_CARRIERS: JSON.stringify({
              cube: aggregateCarrier,
            }),
          },
        }),
      /cannot be combined with an aggregate/,
    );

    writeCarrier(aggregateCarrier, [{ sqlName: 'earthdistance', dependencies: ['cube'] }]);
    assert.throws(
      () => resolveIosCarrierManifests(projectRoot, ['earthdistance'], { env }),
      /aggregate iOS carrier is missing cube required by earthdistance/,
    );
  } finally {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

test('carrier discovery and staging fail closed', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oliphaunt-plugin-failure-'));
  try {
    const fakeOwner = path.join(root, 'fake-owner.json');
    writeCarrier(fakeOwner, [
      {
        dependencies: [],
        product: 'oliphaunt-extension-fake-cube',
        sqlName: 'cube',
        tag: 'oliphaunt-extension-fake-cube-v1.2.3',
      },
    ]);
    assert.throws(
      () => readCarrierSummary(fakeOwner),
      /cube must be owned by oliphaunt-extension-contrib-pg18/,
    );

    const leadingZero = path.join(root, 'leading-zero.json');
    writeCarrier(leadingZero, [
      {
        dependencies: [],
        sqlName: 'vector',
        tag: 'oliphaunt-extension-vector-v01.2.3',
        version: '01.2.3',
      },
    ]);
    assert.throws(() => readCarrierSummary(leadingZero), /invalid stable SemVer version/);

    const ownerConflict = path.join(root, 'owner-conflict.json');
    writeCarrier(ownerConflict, [
      { dependencies: [], sqlName: 'cube' },
      {
        dependencies: ['cube'],
        sqlName: 'earthdistance',
        tag: 'oliphaunt-extension-contrib-pg18-v1.2.4',
        version: '1.2.4',
      },
    ]);
    assert.throws(
      () => readCarrierSummary(ownerConflict),
      /conflicting releases for owner oliphaunt-extension-contrib-pg18/,
    );

    const invalid = path.join(root, 'invalid.json');
    writeCarrier(invalid, [{ sqlName: 'earthdistance', dependencies: ['cube', 'cube'] }]);
    assert.throws(() => readCarrierSummary(invalid), /repeats a dependency/);

    const baseCarrier = path.join(root, 'base.json');
    const earthdistanceCarrier = path.join(root, 'earthdistance.json');
    writeCarrier(baseCarrier, []);
    writeCarrier(earthdistanceCarrier, [{ sqlName: 'earthdistance', dependencies: ['cube'] }]);
    const env = {
      OLIPHAUNT_REACT_NATIVE_IOS_BASE_CARRIER: baseCarrier,
      OLIPHAUNT_REACT_NATIVE_IOS_EXTENSION_CARRIERS: JSON.stringify({
        earthdistance: earthdistanceCarrier,
      }),
    };
    assert.throws(
      () => resolveIosCarrierManifests(root, ['earthdistance'], { env }),
      /missing @oliphaunt\/extension-contrib-pg18 required by earthdistance/,
    );

    const incompatibleVectorCarrier = path.join(root, 'incompatible-vector.json');
    writeCarrier(
      incompatibleVectorCarrier,
      [{ dependencies: [], sqlName: 'vector', version: '0.8.1' }],
      { baseVersion: '1.2.4' },
    );
    assert.throws(
      () =>
        resolveIosCarrierManifests(root, ['vector'], {
          env: {
            OLIPHAUNT_REACT_NATIVE_IOS_BASE_CARRIER: baseCarrier,
            OLIPHAUNT_REACT_NATIVE_IOS_EXTENSION_CARRIERS: JSON.stringify({
              vector: incompatibleVectorCarrier,
            }),
          },
        }),
      /pins liboliphaunt-native-v1\.2\.4, but the selected base carrier pins liboliphaunt-native-v1\.2\.3/,
    );

    const vectorCarrier = path.join(root, 'vector.json');
    writeCarrier(vectorCarrier, [{ sqlName: 'vector', dependencies: [] }]);
    const stageEnv = {
      OLIPHAUNT_REACT_NATIVE_IOS_BASE_CARRIER: baseCarrier,
      OLIPHAUNT_REACT_NATIVE_IOS_EXTENSION_CARRIERS: JSON.stringify({ vector: vectorCarrier }),
    };
    assert.throws(
      () =>
        stageIosAppPayload(
          root,
          path.join(root, 'ios'),
          { extensions: ['vector'], icu: false },
          {
            env: stageEnv,
            spawnSyncImpl: () => ({
              error: undefined,
              status: 12,
              stderr: 'checksum mismatch',
              stdout: '',
            }),
          },
        ),
      /exit code 12: checksum mismatch/,
    );
  } finally {
    fs.rmSync(root, { force: true, recursive: true });
  }
});
