#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { currentProductVersionSync } from './release-artifact-targets.mts';
import { loadProducts, ROOT, readJson } from './release-graph.mts';
import { releasePleaseBootstrapLifecycleError } from './release-please-bootstrap.mts';
import { assertReleasePleasePackageIdentity } from './release-please-package-identity.mts';

const TOOL = 'check_release_please_config.mts';

try {
  const config = readJson('release-please-config.json', TOOL);
  const manifest = readJson('.release-please-manifest.json', TOOL);
  const bootstrapError = releasePleaseBootstrapLifecycleError(config, manifest);
  assert.equal(bootstrapError, undefined, bootstrapError);
  // Shared metadata parsing already validates product identities, tag prefixes,
  // package-relative version/changelog paths, and their existence.
  const products = loadProducts(TOOL);
  assert.deepEqual(
    Object.keys(manifest).sort(),
    Object.values(products)
      .map((product) => product.path)
      .sort(),
    'release manifest paths must match configured products',
  );
  for (const [id, product] of Object.entries(products)) {
    const packageConfig = config.packages[product.path];
    assert.equal(
      currentProductVersionSync(id, TOOL),
      product.version,
      `${id} canonical version must match the release manifest`,
    );
    for (const file of [...product.version_files, product.changelog_path]) {
      assert(statSync(path.join(ROOT, file)).isFile(), `${file} must be a regular file`);
    }
    if (['expo', 'node'].includes(packageConfig['release-type'])) {
      assertReleasePleasePackageIdentity(
        product.path,
        packageConfig,
        readJson(`${product.path}/package.json`, TOOL),
      );
    }
    if (product.version === '0.0.0') {
      assert.equal(
        readFileSync(path.join(ROOT, product.changelog_path), 'utf8').trim(),
        '',
        `${product.changelog_path} must be empty before its first generated release`,
      );
    }
    for (const entry of packageConfig['extra-files'] ?? []) {
      if (typeof entry === 'string') continue;
      if (['json', 'toml', 'yaml'].includes(entry.type)) {
        assert.equal(typeof entry.jsonpath, 'string', `${entry.path} requires jsonpath`);
      } else if (entry.type === 'xml') {
        assert.equal(typeof entry.xpath, 'string', `${entry.path} requires xpath`);
      }
    }
    if (id === 'oliphaunt-swift') {
      assert.equal(
        packageConfig['initial-version'],
        '0.6.0',
        'Swift must clear legacy semver tags',
      );
      assert.equal(packageConfig['bump-patch-for-minor-pre-major'], false);
      assert(
        product.version === '0.0.0' || Bun.semver.order(product.version, '0.6.0') >= 0,
        'Swift releases must start at 0.6.0 to clear legacy semver tags',
      );
    }
  }
  console.log('release-please config checks passed');
} catch (error) {
  console.error(`${TOOL}: ${error.message}`);
  process.exitCode = 2;
}
