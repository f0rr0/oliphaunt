import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { buildPlanFromProductTags } from './release-graph.mts';
import { selectedDependencySatisfiesPin } from './check_release_versions.mts';

const PRODUCTS = {
  'liboliphaunt-native': 'packages/native',
  'liboliphaunt-wasix': 'packages/wasix',
  'oliphaunt-extension-vector': 'packages/vector',
};

function writeSnapshot(
  root,
  versions,
  { vectorCompatibility = 'native=1.0.0,wasix=1.0.0', vectorSource = 'vector' } = {},
) {
  writeFileSync(
    path.join(root, '.release-please-manifest.json'),
    `${JSON.stringify(Object.fromEntries(Object.entries(PRODUCTS).map(([product, packagePath]) => [packagePath, versions[product]])), null, 2)}\n`,
  );
  for (const [product, packagePath] of Object.entries(PRODUCTS)) {
    const directory = path.join(root, packagePath);
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, 'VERSION'), `${versions[product]}\n`);
    writeFileSync(path.join(directory, 'CHANGELOG.md'), `## ${versions[product]}\n`);
    const compatibility = Object.fromEntries(
      vectorCompatibility.split(',').map((entry) => entry.split('=', 2)),
    );
    const body =
      product === 'oliphaunt-extension-vector'
        ? [
            `id = ${JSON.stringify(product)}`,
            `source = ${JSON.stringify(vectorSource)}`,
            '[extension]',
            'sql_name = "vector"',
            '[extension.compatibility]',
            `native_runtime_version = ${JSON.stringify(compatibility.native)}`,
            `wasix_runtime_version = ${JSON.stringify(compatibility.wasix)}`,
            '',
          ].join('\n')
        : `id = ${JSON.stringify(product)}\n`;
    writeFileSync(path.join(directory, 'release.toml'), body);
  }
}

function graph(versions) {
  return {
    policy: { versioning: 'independent' },
    products: {
      'liboliphaunt-native': {
        path: PRODUCTS['liboliphaunt-native'],
        tag_prefix: 'liboliphaunt-native-v',
        version: versions['liboliphaunt-native'],
        version_files: [`${PRODUCTS['liboliphaunt-native']}/VERSION`],
      },
      'liboliphaunt-wasix': {
        path: PRODUCTS['liboliphaunt-wasix'],
        tag_prefix: 'liboliphaunt-wasix-v',
        version: versions['liboliphaunt-wasix'],
        version_files: [`${PRODUCTS['liboliphaunt-wasix']}/VERSION`],
      },
      'oliphaunt-extension-vector': {
        extension: { class: 'external' },
        path: PRODUCTS['oliphaunt-extension-vector'],
        tag_prefix: 'oliphaunt-extension-vector-v',
        version: versions['oliphaunt-extension-vector'],
        version_files: [`${PRODUCTS['oliphaunt-extension-vector']}/VERSION`],
        compatibility_versions: {
          'vector-native-runtime': {
            source_product: 'liboliphaunt-native',
            path: `${PRODUCTS['oliphaunt-extension-vector']}/release.toml`,
            parser: 'toml:extension.compatibility.native_runtime_version',
          },
          'vector-wasix-runtime': {
            source_product: 'liboliphaunt-wasix',
            path: `${PRODUCTS['oliphaunt-extension-vector']}/release.toml`,
            parser: 'toml:extension.compatibility.wasix_runtime_version',
          },
        },
      },
    },
    moon_projects: {
      'liboliphaunt-native': {
        id: 'liboliphaunt-native',
        source: PRODUCTS['liboliphaunt-native'],
        dependencies: [],
      },
      'liboliphaunt-wasix': {
        id: 'liboliphaunt-wasix',
        source: PRODUCTS['liboliphaunt-wasix'],
        dependencies: [],
      },
      'oliphaunt-extension-vector': {
        id: 'oliphaunt-extension-vector',
        source: PRODUCTS['oliphaunt-extension-vector'],
        dependencies: [
          { id: 'liboliphaunt-native', scope: 'build', source: 'explicit' },
          { id: 'liboliphaunt-wasix', scope: 'build', source: 'explicit' },
        ],
      },
    },
  };
}

const V1 = {
  'liboliphaunt-native': '1.0.0',
  'liboliphaunt-wasix': '1.0.0',
  'oliphaunt-extension-vector': '1.0.0',
};

const [phase, root, scenario, stage, graphPath] = process.argv.slice(2);
const native = 'liboliphaunt-native';
const wasix = 'liboliphaunt-wasix';
const vector = 'oliphaunt-extension-vector';
const runtimeVersions = { ...V1, [native]: '2.0.0', [wasix]: '2.0.0' };
const runtimeCases = ['compatible', 'inline-source', 'source', 'invalid-pin', 'production'];
const versions = runtimeCases.includes(scenario)
  ? runtimeVersions
  : scenario === 'native'
    ? { ...V1, [native]: '2.0.0' }
    : scenario === 'external'
      ? { ...runtimeVersions, [vector]: '1.1.0' }
      : scenario === 'regressed'
        ? { ...runtimeVersions, [native]: '1.0.0' }
        : scenario === 'detached'
          ? { ...V1, [vector]: '1.1.0' }
          : ['first', 'zero'].includes(scenario)
            ? Object.fromEntries(
                Object.keys(PRODUCTS).map((id) => [id, scenario === 'first' ? '0.1.0' : '0.0.0']),
              )
            : V1;
const releaseGraph = graph(versions);
if (scenario === 'production')
  releaseGraph.moon_projects[vector].dependencies = releaseGraph.moon_projects[
    vector
  ].dependencies.map((dependency) => ({ ...dependency, scope: 'production' }));
if (scenario === 'detached')
  releaseGraph.products[vector].version_files = ['metadata/vector-version'];
if (phase === 'write') {
  if (scenario === 'detached' && stage === 'release') {
    writeFileSync(
      path.join(root, '.release-please-manifest.json'),
      JSON.stringify(
        Object.fromEntries(Object.entries(PRODUCTS).map(([id, folder]) => [folder, versions[id]])),
      ),
    );
    writeFileSync(path.join(root, 'metadata/vector-version'), '1.1.0\n');
  } else {
    const selected =
      stage === 'base'
        ? ['first', 'zero'].includes(scenario)
          ? versions
          : V1
        : stage === 'runtime'
          ? runtimeVersions
          : versions;
    const options = {};
    if (
      stage !== 'base' &&
      (runtimeCases.includes(scenario) || ['native', 'external'].includes(scenario))
    ) {
      options.vectorCompatibility = `native=${scenario === 'invalid-pin' ? '9.9.9' : selected[native]},wasix=${selected[wasix]}`;
    }
    if (stage === 'release' && scenario === 'inline-source') options.vectorSource = 'vector-v2';
    if (stage === 'release' && scenario === 'external') options.vectorSource = 'vector-v1.1';
    if (stage === 'different') options.vectorSource = 'different-tree';
    writeSnapshot(root, selected, options);
  }
  writeFileSync(graphPath, JSON.stringify(releaseGraph));
} else if (phase === 'assert') {
  const plan = (includeCurrentTags = false) =>
    buildPlanFromProductTags(releaseGraph, 'HEAD', {
      prefix: 'transition-test',
      root,
      includeCurrentTags,
    });
  switch (scenario) {
    case 'compatible': {
      const result = plan();
      assert.deepEqual(result.releaseProducts, [native, wasix]);
      assert.equal(result.changedFiles.includes('packages/vector/release.toml'), true);
      break;
    }
    case 'inline-source':
      assert.throws(
        () => plan(),
        /oliphaunt-extension-vector has release-affecting changes .* manifest version remains 1[.]0[.]0.*packages\/vector\/release[.]toml/u,
      );
      break;
    case 'source':
      assert.throws(
        () => plan(),
        /oliphaunt-extension-vector has release-affecting changes .*packages\/vector\/source[.]toml/u,
      );
      break;
    case 'invalid-pin':
      assert.throws(
        () => plan(),
        /oliphaunt-extension-vector has release-affecting changes .*packages\/vector\/release[.]toml/u,
      );
      break;
    case 'native': {
      const result = plan();
      assert.deepEqual(result.releaseProducts, [native]);
      assert.equal(result.changedFiles.includes('packages/vector/release.toml'), true);
      break;
    }
    case 'production':
      assert.deepEqual(plan().releaseProducts, [native, wasix]);
      break;
    case 'external': {
      const result = plan();
      assert.deepEqual(result.directProducts, [vector]);
      assert.deepEqual(result.releaseProducts, [vector]);
      break;
    }
    case 'first':
      assert.deepEqual(plan().releaseProducts, [native, wasix, vector]);
      break;
    case 'zero':
      assert.deepEqual(plan().releaseProducts, []);
      break;
    case 'rerun': {
      assert.deepEqual(plan().releaseProducts, []);
      const result = plan(true);
      assert.deepEqual(result.releaseProducts, [native, wasix, vector]);
      assert.deepEqual(result.currentTaggedProducts, result.releaseProducts);
      break;
    }
    case 'tooling': {
      const result = plan(true);
      assert.deepEqual(result.releaseProducts, []);
      assert.deepEqual(result.currentTaggedProducts, []);
      break;
    }
    case 'regressed':
      assert.throws(
        () => plan(true),
        /manifest version 1[.]0[.]0 is older than tagged version 2[.]0[.]0/u,
      );
      break;
    case 'canonical':
      assert.throws(
        () => plan(true),
        /canonical version "9[.]9[.]9" does not match its manifest version "1[.]0[.]0"/u,
      );
      break;
    case 'detached':
      assert.throws(() => plan(), /manifest advanced .* changed paths do not select the product/u);
      break;
    case 'unrelated':
      assert.throws(
        () => plan(true),
        /current-version tag .* is not an ancestor of release candidate/u,
      );
      break;
    default:
      throw new Error('unknown transition scenario');
  }
  console.log(`release transition ${scenario}: passed`);
} else if (phase === 'pins') {
  assert.equal(selectedDependencySatisfiesPin(new Set([native]), native, '1.0.0', '1.0.0'), true);
  assert.equal(selectedDependencySatisfiesPin(new Set([native]), native, '1.0.0', '2.0.0'), false);
  console.log('selected dependency requires exact pin: passed');
} else throw new Error('run through release-version-transition.test.sh');
