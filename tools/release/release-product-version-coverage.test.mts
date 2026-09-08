#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildPlan } from '../../src/shared/product-metadata/release-graph.mts';
import { verifyReleaseCommit } from '../test/release-history-fixture.mts';

const NATIVE = 'liboliphaunt-native';
const WASIX = 'liboliphaunt-wasix';
const VECTOR = 'oliphaunt-extension-vector';
const PRODUCT_PATHS = {
  [NATIVE]: 'src/runtimes/liboliphaunt/native',
  [WASIX]: 'src/runtimes/liboliphaunt/wasix',
  [VECTOR]: 'src/extensions/external/vector',
};
const VECTOR_RELEASE = `${PRODUCT_PATHS[VECTOR]}/release.toml`;
const VECTOR_SOURCE = `${PRODUCT_PATHS[VECTOR]}/source.toml`;

function git(repo, ...args) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
}

function write(repo, file, contents) {
  const destination = path.join(repo, file);
  mkdirSync(path.dirname(destination), { recursive: true });
  writeFileSync(destination, contents);
}

function commit(repo, subject) {
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', subject);
  return git(repo, 'rev-parse', 'HEAD');
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

test('runtime releases leave compatible extension versions independent', {
  timeout: 20_000,
}, (t) => {
  const repo = mkdtempSync(path.join(os.tmpdir(), 'oliphaunt-release-coverage-'));
  t.after(() => rmSync(repo, { force: true, recursive: true }));
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.name', 'Release Coverage Test');
  git(repo, 'config', 'user.email', 'release-coverage@example.invalid');

  const v1 = { [NATIVE]: '1.0.0', [WASIX]: '1.0.0', [VECTOR]: '1.0.0' };
  const v2 = { ...v1, [NATIVE]: '2.0.0', [WASIX]: '2.0.0' };
  writeBase(repo, v1);
  const base = commit(repo, 'feat: introduce release coverage fixture');

  writeRuntimeRelease(repo, v2);
  const release = commit(repo, 'chore(release): prepare runtime release');
  git(repo, 'update-ref', 'refs/remotes/origin/main', base);
  const output = execFileSync('bash', [path.resolve(import.meta.dir, 'check-release-pr.sh')], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, MOON_BIN: 'false' },
  });
  assert.match(output, /verified release-bump commit/u);
  const verified = verifyReleaseCommit({ repo, headRef: release, products: [NATIVE, WASIX] });
  assert.deepEqual(verified.verifiedDerivedPaths, [VECTOR_RELEASE]);

  assert.deepEqual(
    buildPlan(graph(v2), [VECTOR_SOURCE], 'release-coverage-test').releaseProducts,
    [VECTOR],
    'a real external source change remains independently release-significant',
  );

  git(repo, 'switch', '-q', '-c', 'tainted-source', base);
  writeRuntimeRelease(repo, v2);
  write(repo, VECTOR_SOURCE, 'commit = "vector-v2"\n');
  const taintedSource = commit(repo, 'chore(release): hide external source change');
  assert.throws(
    () => verifyReleaseCommit({ repo, headRef: taintedSource, products: [NATIVE, WASIX] }),
    /non-release-derived path.*src\/extensions\/external\/vector\/source[.]toml/u,
  );

  git(repo, 'switch', '-q', '-c', 'tainted-config', base);
  writeRuntimeRelease(repo, v2, { sqlName: 'not-vector' });
  const taintedConfig = commit(repo, 'chore(release): hide external config change');
  assert.throws(
    () => verifyReleaseCommit({ repo, headRef: taintedConfig, products: [NATIVE, WASIX] }),
    /derived file.*release[.]toml contains a non-version semantic change at extension[.]sql_name/u,
  );
});
