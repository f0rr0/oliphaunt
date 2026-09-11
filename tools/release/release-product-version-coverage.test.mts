#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { buildPlan } from './release-graph.mts';
import { verifyReleaseCommit } from './verify-release-commit.mts';

const NATIVE = 'liboliphaunt-native';
const WASIX = 'liboliphaunt-wasix';
const VECTOR = 'oliphaunt-extension-vector';
const PRODUCT_PATHS = {
  [NATIVE]: 'runtimes/liboliphaunt-native',
  [WASIX]: 'runtimes/liboliphaunt-wasix',
  [VECTOR]: 'extensions/external/vector',
};
const VECTOR_RELEASE = `${PRODUCT_PATHS[VECTOR]}/release.toml`;
const VECTOR_SOURCE = `${PRODUCT_PATHS[VECTOR]}/source.toml`;

function write(repo, file, contents) {
  const destination = path.join(repo, file);
  mkdirSync(path.dirname(destination), { recursive: true });
  writeFileSync(destination, contents);
}

function manifest(versions) {
  return `${JSON.stringify(
    Object.fromEntries(
      Object.entries(PRODUCT_PATHS).map(([product, packagePath]) => [
        packagePath,
        versions[product],
      ]),
    ),
    null,
    2,
  )}\n`;
}

function releasePleaseConfig() {
  return `${JSON.stringify(
    {
      packages: Object.fromEntries(
        Object.entries(PRODUCT_PATHS).map(([product, packagePath]) => [
          packagePath,
          {
            'release-type': 'simple',
            component: product,
            'version-file': 'VERSION',
            'changelog-path': 'CHANGELOG.md',
          },
        ]),
      ),
    },
    null,
    2,
  )}\n`;
}

function vectorMetadata(nativeVersion, wasixVersion, { sqlName = 'vector' } = {}) {
  return [
    `id = ${JSON.stringify(VECTOR)}`,
    '',
    '[extension]',
    `sql_name = ${JSON.stringify(sqlName)}`,
    '',
    '[extension.compatibility]',
    `native_runtime_version = ${JSON.stringify(nativeVersion)}`,
    `wasix_runtime_version = ${JSON.stringify(wasixVersion)}`,
    '',
  ].join('\n');
}

function writeBase(repo, versions) {
  write(repo, 'release-please-config.json', releasePleaseConfig());
  write(repo, '.release-please-manifest.json', manifest(versions));
  for (const [product, packagePath] of Object.entries(PRODUCT_PATHS)) {
    write(repo, `${packagePath}/VERSION`, `${versions[product]}\n`);
    write(repo, `${packagePath}/CHANGELOG.md`, '# Changelog\n');
  }
  write(repo, VECTOR_RELEASE, vectorMetadata(versions[NATIVE], versions[WASIX]));
  write(repo, VECTOR_SOURCE, 'commit = "vector-v1"\n');
}

function writeRuntimeRelease(repo, versions, options = {}) {
  write(repo, '.release-please-manifest.json', manifest(versions));
  for (const product of [NATIVE, WASIX]) {
    const packagePath = PRODUCT_PATHS[product];
    write(repo, `${packagePath}/VERSION`, `${versions[product]}\n`);
    write(
      repo,
      `${packagePath}/CHANGELOG.md`,
      `# Changelog\n\n## ${versions[product]} (2026-07-15)\n`,
    );
  }
  write(repo, VECTOR_RELEASE, vectorMetadata(versions[NATIVE], versions[WASIX], options));
}

function graph(versions) {
  const product = (id, extra = {}) => ({
    path: PRODUCT_PATHS[id],
    version: versions[id],
    version_files: [`${PRODUCT_PATHS[id]}/VERSION`],
    ...extra,
  });
  const project = (id, dependencies = []) => ({
    id,
    source: PRODUCT_PATHS[id],
    dependencies,
  });
  return {
    policy: { versioning: 'independent' },
    products: {
      [NATIVE]: product(NATIVE),
      [WASIX]: product(WASIX),
      [VECTOR]: product(VECTOR, {
        extension: { class: 'external' },
        compatibility_versions: {
          native_runtime_version: { source_product: NATIVE },
          wasix_runtime_version: { source_product: WASIX },
        },
      }),
    },
    moon_projects: {
      [NATIVE]: project(NATIVE),
      [WASIX]: project(WASIX),
      [VECTOR]: project(VECTOR, [
        { id: NATIVE, scope: 'build', source: 'explicit' },
        { id: WASIX, scope: 'build', source: 'explicit' },
      ]),
    },
  };
}

const [phase, repo, scenario, headRef] = process.argv.slice(2);
const v1 = { [NATIVE]: '1.0.0', [WASIX]: '1.0.0', [VECTOR]: '1.0.0' };
const v2 = { ...v1, [NATIVE]: '2.0.0', [WASIX]: '2.0.0' };
if (phase === 'base') {
  writeBase(repo, v1);
} else if (phase === 'release') {
  writeRuntimeRelease(repo, v2, scenario === 'config' ? { sqlName: 'not-vector' } : {});
  if (scenario === 'source') write(repo, VECTOR_SOURCE, 'commit = "vector-v2"\n');
} else if (phase === 'assert') {
  const verify = () => verifyReleaseCommit({ repo, headRef, products: [NATIVE, WASIX] });
  if (scenario === 'compatible') {
    assert.deepEqual(verify().verifiedDerivedPaths, [VECTOR_RELEASE]);
    assert.deepEqual(
      buildPlan(graph(v2), [VECTOR_SOURCE], 'release-coverage-test').releaseProducts,
      [VECTOR],
      'a real external source change remains independently release-significant',
    );
  } else if (scenario === 'source') {
    assert.throws(
      verify,
      (error) =>
        error.message.includes('non-release-derived path') && error.message.includes(VECTOR_SOURCE),
    );
  } else if (scenario === 'config') {
    assert.throws(
      verify,
      /derived file.*release[.]toml contains a non-version semantic change at extension[.]sql_name/u,
    );
  } else throw new Error('unknown coverage scenario');
  console.log('release product coverage ' + scenario + ': passed');
} else throw new Error('run through release-product-version-coverage.test.sh');
