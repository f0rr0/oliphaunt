import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { compatibilityVersionSource } from './compatibility-version-policy.mts';

import {
  requireCompatibilityVersionBinding,
  requireCompatibilityVersionBounds,
} from './compatibility-version-policy.mts';

const NATIVE = 'liboliphaunt-native';
const CONTRIB = 'oliphaunt-extension-amcheck';
const EXTERNAL = 'oliphaunt-extension-vector';
const SDK = 'oliphaunt-js';
const RUNTIME_CONSUMER = 'oliphaunt-node-direct';
const PATHS = {
  [NATIVE]: 'packages/native',
  [CONTRIB]: 'packages/amcheck',
  [EXTERNAL]: 'packages/vector',
  [SDK]: 'packages/js',
  [RUNTIME_CONSUMER]: 'packages/node-direct',
};
const EXTERNAL_ENTRY = {
  id: 'vector-native-runtime',
  product: EXTERNAL,
  sourceProduct: NATIVE,
  path: `${PATHS[EXTERNAL]}/release.toml`,
  parser: 'toml:compatibility.native',
};

function writeState(root, versions, { compatibilityByProduct = {} } = {}) {
  const releaseManifest = {};
  for (const [product, packagePath] of Object.entries(PATHS)) {
    const directory = path.join(root, packagePath);
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, 'VERSION'), `${versions[product]}\n`);
    const compatibility = compatibilityByProduct[product] ?? versions[NATIVE];
    writeFileSync(
      path.join(directory, 'release.toml'),
      `[compatibility]\nnative = ${JSON.stringify(compatibility)}\n`,
    );
    releaseManifest[packagePath] = versions[product];
  }
  writeFileSync(
    path.join(root, '.release-please-manifest.json'),
    `${JSON.stringify(releaseManifest, null, 2)}\n`,
  );
}

function products(versions) {
  return {
    [NATIVE]: {
      path: PATHS[NATIVE],
      tag_prefix: `${NATIVE}-v`,
      version: versions[NATIVE],
      version_files: [`${PATHS[NATIVE]}/VERSION`],
    },
    [CONTRIB]: {
      path: PATHS[CONTRIB],
      tag_prefix: `${CONTRIB}-v`,
      version: versions[CONTRIB],
      version_files: [`${PATHS[CONTRIB]}/VERSION`],
      extension: { class: 'contrib' },
    },
    [EXTERNAL]: {
      path: PATHS[EXTERNAL],
      tag_prefix: `${EXTERNAL}-v`,
      version: versions[EXTERNAL],
      version_files: [`${PATHS[EXTERNAL]}/VERSION`],
      extension: { class: 'external' },
    },
    [SDK]: {
      path: PATHS[SDK],
      tag_prefix: `${SDK}-v`,
      version: versions[SDK],
      version_files: [`${PATHS[SDK]}/VERSION`],
      kind: 'sdk',
    },
    [RUNTIME_CONSUMER]: {
      path: PATHS[RUNTIME_CONSUMER],
      tag_prefix: `${RUNTIME_CONSUMER}-v`,
      version: versions[RUNTIME_CONSUMER],
      version_files: [`${PATHS[RUNTIME_CONSUMER]}/VERSION`],
      kind: 'runtime',
    },
  };
}

const ZERO = Object.fromEntries(Object.keys(PATHS).map((product) => [product, '0.0.0']));
const V1 = Object.fromEntries(Object.keys(PATHS).map((product) => [product, '1.0.0']));

const [phase, root, scenario, stage, graphPath, taggedCommit] = process.argv.slice(2);
const runtimeRelease = { ...V1, [NATIVE]: '1.1.0', [CONTRIB]: '1.1.0' };
const released =
  scenario === 'first'
    ? Object.fromEntries(Object.keys(PATHS).map((product) => [product, '0.1.0']))
    : ['external-tag', 'consumer-tags', 'contrib'].includes(scenario)
      ? runtimeRelease
      : scenario === 'external-bump'
        ? { ...V1, [EXTERNAL]: '1.1.0' }
        : scenario === 'sdk-bump'
          ? { ...V1, [SDK]: '1.1.0' }
          : V1;
const current = products(released);
if (scenario === 'workspace')
  current['postgres-tools-wasix'] = {
    path: 'postgres-tools/wasix',
    tag_prefix: 'postgres-tools-wasix-v',
    version: '0.2.1',
    version_files: ['postgres-tools/wasix/VERSION'],
  };
if (phase === 'write') {
  const versions =
    stage === 'zero'
      ? ZERO
      : stage === 'v1'
        ? V1
        : stage === 'mismatch'
          ? { ...V1, [EXTERNAL]: '0.9.0' }
          : released;
  const compatibilityByProduct =
    scenario === 'external-tag'
      ? { [EXTERNAL]: '1.0.0' }
      : scenario === 'consumer-tags'
        ? { [SDK]: '1.0.0', [RUNTIME_CONSUMER]: '1.0.0' }
        : {};
  writeState(root, versions, { compatibilityByProduct });
  writeFileSync(graphPath, JSON.stringify({ products: current }));
} else if (phase === 'workspace') {
  mkdirSync(path.join(root, 'postgres-tools/wasix'), { recursive: true });
  writeFileSync(path.join(root, 'postgres-tools/wasix/VERSION'), '0.2.1\n');
} else if (phase === 'assert') {
  const pending = (...ids) => new Map(ids.map((id) => [id, released[id]]));
  const options = { root, prefix: 'compatibility-test' };
  const source = (entry = EXTERNAL_ENTRY, selected = new Map()) =>
    compatibilityVersionSource(entry, current, selected, options);
  const currentSource = { kind: 'current-source', ref: null, tag: null };
  switch (scenario) {
    case 'workspace':
      assert.doesNotThrow(() =>
        requireCompatibilityVersionBounds({
          id: 'new-tools-runtime',
          value: '1.0.0',
          sourceProduct: NATIVE,
          sourceVersion: '1.0.0',
        }),
      );
      assert.throws(
        () =>
          source(
            { ...EXTERNAL_ENTRY, product: 'postgres-tools-wasix', id: 'new-tools-runtime' },
            new Map([['postgres-tools-wasix', '0.2.1']]),
          ),
        /manifest version.*must be a stable.*undefined/u,
      );
      break;
    case 'first':
      assert.deepEqual(source(EXTERNAL_ENTRY, pending(EXTERNAL)), currentSource);
      assert.throws(
        () => source(EXTERNAL_ENTRY, new Map([[EXTERNAL, '1.2.0']])),
        /is not pending from a verified release commit/u,
      );
      break;
    case 'external-tag':
      assert.deepEqual(source(EXTERNAL_ENTRY, pending(NATIVE, CONTRIB)), {
        kind: 'tagged-sink',
        ref: taggedCommit,
        tag: `${EXTERNAL}-v1.0.0`,
      });
      break;
    case 'external-bump':
      assert.deepEqual(source(EXTERNAL_ENTRY, pending(EXTERNAL)), currentSource);
      break;
    case 'missing':
      assert.throws(
        () => source(),
        /version 1[.]0[.]0 has no immutable current-version tag and is not pending from a verified release commit/u,
      );
      break;
    case 'mismatch':
      assert.throws(
        () => source(EXTERNAL_ENTRY, pending(EXTERNAL)),
        /tag .* names 1[.]0[.]0, but its manifest contains "0[.]9[.]0"/u,
      );
      break;
    case 'unrelated':
      assert.throws(
        () => source(),
        /current-version tag .* is not an ancestor of release candidate/u,
      );
      break;
    case 'reused':
      assert.throws(
        () => source(EXTERNAL_ENTRY, pending(EXTERNAL)),
        /cannot advance to already-tagged immutable version 1[.]0[.]0/u,
      );
      break;
    case 'consumer-tags':
      for (const product of [SDK, RUNTIME_CONSUMER])
        assert.deepEqual(source({ ...EXTERNAL_ENTRY, product }, pending(NATIVE, CONTRIB)), {
          kind: 'tagged-sink',
          ref: taggedCommit,
          tag: `${product}-v1.0.0`,
        });
      break;
    case 'sdk-bump':
      assert.deepEqual(source({ ...EXTERNAL_ENTRY, product: SDK }, pending(SDK)), currentSource);
      break;
    case 'contrib':
      assert.deepEqual(
        source(
          { ...EXTERNAL_ENTRY, product: CONTRIB },
          stage === 'tagged' ? new Map() : pending(NATIVE, CONTRIB),
        ),
        stage === 'tagged'
          ? { kind: 'tagged-sink', ref: taggedCommit, tag: `${CONTRIB}-v1.1.0` }
          : currentSource,
      );
      break;
    default:
      throw new Error('unknown compatibility scenario');
  }
  console.log(`compatibility ${scenario} ${stage}: passed`);
} else if (phase === 'bindings') {
  assert.throws(
    () =>
      requireCompatibilityVersionBinding({
        id: EXTERNAL_ENTRY.id,
        value: '1.1.0',
        expected: '1.0.0',
        sourceProduct: NATIVE,
        sourceVersion: '1.1.0',
        provenance: `immutable ${EXTERNAL} tag ${EXTERNAL}-v1.0.0`,
      }),
    /compatibility value "1[.]1[.]0" must match immutable .* tag/u,
  );
  assert.throws(
    () =>
      requireCompatibilityVersionBinding({
        id: EXTERNAL_ENTRY.id,
        value: '2.0.0',
        expected: '2.0.0',
        sourceProduct: NATIVE,
        sourceVersion: '1.1.0',
        provenance: `${NATIVE} 2.0.0`,
      }),
    /cannot be newer than liboliphaunt-native 1[.]1[.]0/u,
  );
  console.log('compatibility value bounds and immutable binding: passed');
} else throw new Error('run through compatibility-version-policy.test.sh');
