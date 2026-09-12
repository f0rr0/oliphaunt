import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { compatibilityVersionValue, productVersionTransitionStatus } from './release-graph.mts';
import { historyFile, historyManifest } from './release-history.mts';

const [mode, repo] = process.argv.slice(2);
if (mode === 'prepare') {
  const alpha = {
    path: 'red',
    tag_prefix: 'alpha-v',
    version: '1.1.0',
    version_files: ['red/VERSION'],
    compatibility_versions: {
      runtime: { path: 'red/PIN', parser: 'raw', source_product: 'beta' },
      introduced: { path: 'red/NEW_PIN', parser: 'raw', source_product: 'beta' },
    },
  };
  const graph = {
    products: {
      alpha,
      beta: {
        path: 'blue',
        tag_prefix: 'beta-v',
        version: '8.0.0',
        version_files: ['blue/VERSION'],
      },
    },
  };

  writeFileSync(path.join(repo, 'graph.json'), JSON.stringify(graph));
} else if (mode === 'assert') {
  const root = repo;
  const config = JSON.parse(readFileSync(path.join(repo, 'graph.json'), 'utf8')).products.alpha;
  assert.equal(historyFile(root, 'alpha-v1.0.0', 'red/VERSION'), '1.0.0');
  assert.deepEqual(historyManifest(root, 'alpha-v1.0.0'), { red: '1.0.0', blue: '8.0.0' });
  assert.equal(
    compatibilityVersionValue(
      { path: 'red/PIN', parser: 'raw' },
      { root, ref: 'alpha-v1.0.0', missingValue: '0.6.0' },
    ),
    '0.5.0',
  );
  productVersionTransitionStatus('alpha', config, 'alpha-v1.0.0', 'HEAD', { root });
  assert.throws(
    () =>
      compatibilityVersionValue(
        { path: 'red/NEW_PIN', parser: 'raw' },
        { root, ref: 'alpha-v1.0.0', missingValue: '0.6.0' },
      ),
    /missing historical product file/,
  );
} else throw Error('expected prepare or assert');
