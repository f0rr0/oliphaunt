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
  insertAppGradlePlugin,
  insertIosPodfileBlock,
  iosStageCommand,
  normalizeOptions,
  readCarrierSummary,
  resolveIosCarrierManifests,
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
  extensions: Array<{ sqlName: string; dependencies: string[] }>,
): void {
  writeJson(file, {
    schema: CARRIER_SCHEMA,
    base: {},
    extensions,
  });
}

function writeCarrierPackage(
  packageRoot: string,
  packageName: string,
  extensions: Array<{ sqlName: string; dependencies: string[] }>,
): string {
  const carrier = path.join(packageRoot, CARRIER_FILENAME);
  writeCarrier(carrier, extensions);
  writeJson(path.join(packageRoot, 'package.json'), {
    name: packageName,
    version: '1.2.3',
    exports: { './package.json': './package.json' },
    oliphaunt: { iosCarrierManifest: `./${CARRIER_FILENAME}` },
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
  assert.equal(extensionPackageName('uuid_ossp'), '@oliphaunt/extension-uuid-ossp');
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
    /File\.expand_path\('oliphaunt\/OliphauntReactNativePayload\.podspec', __dir__\)/,
  );
  assert.match(patchedPodfile, /raise 'Oliphaunt iOS payload is missing/);
  assert.match(
    patchedPodfile,
    /pod 'OliphauntReactNativePayload', :podspec => oliphaunt_payload_podspec/,
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

test('carrier discovery follows separately packaged extension dependencies', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oliphaunt-plugin-carriers-'));
  try {
    const projectRoot = path.join(root, 'app');
    const baseRoot = path.join(root, 'react-native');
    const earthdistanceRoot = path.join(
      projectRoot,
      'node_modules',
      '@oliphaunt',
      'extension-earthdistance',
    );
    const cubeRoot = path.join(earthdistanceRoot, 'node_modules', '@oliphaunt', 'extension-cube');
    const baseCarrier = writeCarrierPackage(baseRoot, '@oliphaunt/react-native', []);
    const earthdistanceCarrier = writeCarrierPackage(
      earthdistanceRoot,
      '@oliphaunt/extension-earthdistance',
      [{ sqlName: 'earthdistance', dependencies: ['cube'] }],
    );
    const cubeCarrier = writeCarrierPackage(cubeRoot, '@oliphaunt/extension-cube', [
      { sqlName: 'cube', dependencies: [] },
    ]);

    const manifests = resolveIosCarrierManifests(projectRoot, ['earthdistance'], {
      basePackageRoot: baseRoot,
      env: {},
    });
    assert.deepEqual(manifests, [baseCarrier, cubeCarrier, earthdistanceCarrier]);
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
      /missing @oliphaunt\/extension-cube required by earthdistance/,
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
