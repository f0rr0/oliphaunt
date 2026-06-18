import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  insertAppGradlePlugin,
  insertIosPodfileBlock,
  normalizeOptions,
} = require('../../app.plugin.js');
const packageMetadata = require('../../package.json');

function requirePackageOliphauntVersion(key: 'swiftSdkVersion' | 'kotlinSdkVersion'): string {
  const version = packageMetadata.oliphaunt?.[key];
  if (typeof version !== 'string' || version.length === 0) {
    throw new Error(`@oliphaunt/react-native package metadata does not pin ${key}`);
  }
  return version;
}

const kotlinSdkVersion = requirePackageOliphauntVersion('kotlinSdkVersion');

const normalized = normalizeOptions({
  extensions: ['vector', 'pg_trgm', 'vector'],
  liboliphauntVersion: '0.1.0',
});

assert.deepEqual(normalized, {
  extensions: ['pg_trgm', 'vector'],
  liboliphauntVersion: '0.1.0',
  assetBaseUrl: undefined,
  kotlinPluginVersion: kotlinSdkVersion,
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

const podfile = [
  "target 'OliphauntExample' do",
  '  use_expo_modules!',
  '  config = use_native_modules!',
  'end',
  '',
].join('\n');

const patchedPodfile = insertIosPodfileBlock(podfile);
assert.match(patchedPodfile, /# @oliphaunt\/react-native begin/);
assert.match(
  patchedPodfile,
  /pod 'COliphaunt', :podspec => File\.join\(oliphaunt_podspecs_path, 'COliphaunt\.podspec'\), :modular_headers => true/,
);
assert.match(
  patchedPodfile,
  /pod 'Oliphaunt', :podspec => File\.join\(oliphaunt_podspecs_path, 'Oliphaunt\.podspec'\)/,
);
assert.equal(insertIosPodfileBlock(patchedPodfile), patchedPodfile);

assert.throws(
  () => insertIosPodfileBlock("target 'App' do\nend\n"),
  /use_native_modules! or use_expo_modules!/,
);

const appGradle = "plugins {\n    id 'com.android.application'\n}\n";
const patchedAppGradle = insertAppGradlePlugin(appGradle, kotlinSdkVersion);
assert.ok(patchedAppGradle.includes(`id 'dev.oliphaunt.android' version '${kotlinSdkVersion}'`));
assert.equal(insertAppGradlePlugin(patchedAppGradle, kotlinSdkVersion), patchedAppGradle);

test('config plugin', () => {
  assert.ok(true);
});
