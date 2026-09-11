import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  compatibilityEntriesForBumpedProducts,
  releasePleaseManifestTransitions,
  releasePleaseWorktreeTransitions,
} from './release-please-transition.mts';

const PRODUCT_PATHS = {
  'liboliphaunt-native': 'packages/native',
  'liboliphaunt-wasix': 'packages/wasix',
  'oliphaunt-extension-amcheck': 'packages/amcheck',
  'oliphaunt-extension-vector': 'packages/vector',
};

const config = {
  packages: Object.fromEntries(
    Object.entries(PRODUCT_PATHS).map(([component, packagePath]) => [packagePath, { component }]),
  ),
};
const manifest = (versions) =>
  Object.fromEntries(
    Object.entries(PRODUCT_PATHS).map(([product, packagePath]) => [packagePath, versions[product]]),
  );
const ZERO = Object.fromEntries(Object.keys(PRODUCT_PATHS).map((product) => [product, '0.0.0']));
const V1 = Object.fromEntries(Object.keys(PRODUCT_PATHS).map((product) => [product, '1.0.0']));
const transitionsFor = (before, after) =>
  releasePleaseManifestTransitions(config, manifest(before), manifest(after));
const [mode, root, value] = process.argv.slice(2);
if (mode === 'write-fixture') {
  writeFileSync(path.join(root, 'release-please-config.json'), JSON.stringify(config));
  writeFileSync(
    path.join(root, '.release-please-manifest.json'),
    JSON.stringify(
      manifest(Object.fromEntries(Object.keys(PRODUCT_PATHS).map((product) => [product, value]))),
    ),
  );
  process.exit(0);
}
if (mode === 'history') {
  const read = () => releasePleaseWorktreeTransitions(root, { prefix: 'transition-test' });
  if (value === 'introduction') assert.deepEqual(read(), []);
  else if (value === 'invalid-introduction')
    assert.throws(
      read,
      /missing parent release-please manifest is valid only for the unreleased 0[.]0[.]0 introduction state/u,
    );
  else if (value === 'first-release')
    assert.deepEqual(
      read().map(({ product }) => product),
      Object.keys(PRODUCT_PATHS).sort(),
    );
  else throw Error('unknown history assertion');
  process.exit(0);
}
test('the first release reports every product that advanced', () => {
  const baseline = ZERO;
  const released = Object.fromEntries(
    Object.keys(PRODUCT_PATHS).map((product) => [product, '0.1.0']),
  );

  const transitions = transitionsFor(baseline, released);
  assert.deepEqual(
    transitions.map(({ product }) => product),
    Object.keys(PRODUCT_PATHS).sort(),
  );
});

test('a post-first runtime release leaves an independently versioned external sink untouched', () => {
  const baseline = V1;
  const released = {
    ...V1,
    'liboliphaunt-native': '1.1.0',
    'liboliphaunt-wasix': '1.1.0',
    'oliphaunt-extension-amcheck': '1.1.0',
  };

  const transitions = transitionsFor(baseline, released);
  assert.deepEqual(
    transitions.map(({ product }) => product),
    ['liboliphaunt-native', 'liboliphaunt-wasix', 'oliphaunt-extension-amcheck'],
  );
  const entries = [
    {
      id: 'contrib-native',
      product: 'oliphaunt-extension-amcheck',
      sourceProduct: 'liboliphaunt-native',
    },
    {
      id: 'contrib-wasix',
      product: 'oliphaunt-extension-amcheck',
      sourceProduct: 'liboliphaunt-wasix',
    },
    {
      id: 'external-native',
      product: 'oliphaunt-extension-vector',
      sourceProduct: 'liboliphaunt-native',
    },
  ];
  assert.deepEqual(
    compatibilityEntriesForBumpedProducts(entries, transitions).map(({ id }) => id),
    ['contrib-native', 'contrib-wasix'],
  );
});

test('a consumer-only bump advances its compatibility metadata', () => {
  const entries = [{ id: 'sdk-native', product: 'sdk', sourceProduct: 'native' }];
  const transitions = [{ product: 'sdk', before: '1.0.0', after: '1.1.0' }];
  assert.deepEqual(compatibilityEntriesForBumpedProducts(entries, transitions), entries);
});

test('native can advance without WASIX or contrib', () => {
  const baseline = V1;
  const released = { ...V1, 'liboliphaunt-native': '1.1.0' };
  const transitions = transitionsFor(baseline, released);

  assert.deepEqual(
    transitions.map(({ product }) => product),
    ['liboliphaunt-native'],
  );
});

test('independent products can advance to divergent versions', () => {
  const baseline = V1;
  const released = {
    ...V1,
    'liboliphaunt-native': '1.1.0',
    'liboliphaunt-wasix': '1.2.0',
    'oliphaunt-extension-amcheck': '1.2.0',
  };
  const transitions = transitionsFor(baseline, released);

  assert.deepEqual(
    transitions.map(({ product, after }) => [product, after]),
    [
      ['liboliphaunt-native', '1.1.0'],
      ['liboliphaunt-wasix', '1.2.0'],
      ['oliphaunt-extension-amcheck', '1.2.0'],
    ],
  );
});

test('an external-only release remains independent', () => {
  const baseline = V1;
  const released = { ...V1, 'oliphaunt-extension-vector': '1.1.0' };
  const transitions = transitionsFor(baseline, released);

  assert.deepEqual(
    transitions.map(({ product }) => product),
    ['oliphaunt-extension-vector'],
  );
});

test('a manifest regression fails closed', () => {
  const baseline = V1;
  const released = { ...V1, 'oliphaunt-extension-vector': '0.9.0' };

  assert.throws(
    () => transitionsFor(baseline, released),
    /oliphaunt-extension-vector manifest version regressed from 1[.]0[.]0 to 0[.]9[.]0/u,
  );
});

test('only the retired contrib release path may disappear without fabricating a transition', () => {
  const config = { packages: { 'packages/native': { component: 'liboliphaunt-native' } } };
  assert.deepEqual(
    releasePleaseManifestTransitions(
      config,
      { 'packages/native': '1.0.0', 'extensions/contrib': '1.0.0' },
      { 'packages/native': '1.0.0' },
      { prefix: 'transition-test' },
    ),
    [],
  );
  assert.throws(
    () =>
      releasePleaseManifestTransitions(
        config,
        { 'packages/native': '1.0.0', 'packages/accidentally-removed': '1.0.0' },
        { 'packages/native': '1.0.0' },
        { prefix: 'transition-test' },
      ),
    /packages cannot disappear.*packages\/accidentally-removed/u,
  );
});

test('moving a release owner preserves its baseline and cannot hide a version regression', () => {
  const beforeConfig = { packages: { 'old/sdk': { component: 'sdk' } } };
  const config = { packages: { 'sdks/sdk': { component: 'sdk' } } };
  const before = { 'old/sdk': '1.2.3' };
  const transitions = (version) =>
    releasePleaseManifestTransitions(config, before, { 'sdks/sdk': version }, { beforeConfig });
  assert.deepEqual(transitions('1.2.3'), []);
  assert.deepEqual(transitions('1.2.4'), [
    { product: 'sdk', packagePath: 'sdks/sdk', before: '1.2.3', after: '1.2.4' },
  ]);
  assert.throws(() => transitions('1.0.0'), /regressed/);
  assert.throws(
    () =>
      releasePleaseManifestTransitions(
        { packages: { 'sdks/sdk': { component: 'replacement' } } },
        before,
        { 'sdks/sdk': '1.2.3' },
        { beforeConfig },
      ),
    /packages cannot disappear/,
  );
});
