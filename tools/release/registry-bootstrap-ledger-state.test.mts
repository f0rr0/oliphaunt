#!/usr/bin/env bun
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyLedgerRequirement,
  collectLedgerRows,
  parseTagRefs,
  tagState,
} from '../../.github/scripts/registry-bootstrap-ledger-state.mts';

test('requires a ledger only for pre-tag current-version registry publications', () => {
  assert.deepEqual(
    classifyLedgerRequirement([
      { product: 'new', ecosystem: 'npm', published: 0, tagState: 'missing' },
      { product: 'retry', ecosystem: 'cargo', published: 1, tagState: 'exact' },
    ]),
    { needsLedger: false, requiring: [] },
  );

  const bootstrap = classifyLedgerRequirement([
    { product: 'bootstrap', ecosystem: 'npm', published: 2, tagState: 'missing' },
  ]);
  assert.equal(bootstrap.needsLedger, true);
  assert.deepEqual(bootstrap.requiring, [{ product: 'bootstrap', ecosystem: 'npm', published: 2 }]);

  assert.throws(
    () =>
      classifyLedgerRequirement([
        { product: 'conflict', ecosystem: 'npm', published: 1, tagState: 'wrong' },
      ]),
    /another commit/u,
  );
});

test('resolves product tags before registry reads and records exact-tag skips explicitly', async () => {
  const lock = {
    products: [
      { id: 'exact', version: '1.0.0' },
      { id: 'missing', version: '2.0.0' },
    ],
  };
  const queries = [];
  const rows = await collectLedgerRows(
    {
      lock,
      products: ['exact', 'missing'],
      headCommit: 'a'.repeat(40),
    },
    {
      carriersFor: (_lock, { product, ecosystem }) =>
        ecosystem === 'cargo' || product === 'exact' ? [{ id: `${product}:${ecosystem}` }] : [],
      queryPublication: (_lock, product, ecosystem) => {
        queries.push(`${product}:${ecosystem}`);
        return { published: [{ id: 'published' }], missing: [] };
      },
      resolveTagState: (product) => (product === 'exact' ? 'exact' : 'missing'),
    },
  );

  assert.deepEqual(queries, ['missing:cargo']);
  assert.deepEqual(rows, [
    {
      product: 'exact',
      ecosystem: 'cargo',
      published: null,
      missing: null,
      queryState: 'skipped-exact-tag',
      tagState: 'exact',
    },
    {
      product: 'exact',
      ecosystem: 'npm',
      published: null,
      missing: null,
      queryState: 'skipped-exact-tag',
      tagState: 'exact',
    },
    {
      product: 'missing',
      ecosystem: 'cargo',
      published: 1,
      missing: 0,
      queryState: 'queried',
      tagState: 'missing',
    },
  ]);
  assert.deepEqual(classifyLedgerRequirement(rows), {
    needsLedger: true,
    requiring: [{ product: 'missing', ecosystem: 'cargo', published: 1 }],
  });
});

test('rejects a wrong product tag before any registry query', async () => {
  let queries = 0;
  await assert.rejects(
    () =>
      collectLedgerRows(
        {
          lock: { products: [{ id: 'conflict', version: '1.0.0' }] },
          products: ['conflict'],
          headCommit: 'a'.repeat(40),
        },
        {
          carriersFor: () => [{ id: 'must-not-be-read' }],
          queryPublication: () => {
            queries += 1;
            return { published: [], missing: [] };
          },
          resolveTagState: () => 'wrong',
        },
      ),
    /another commit/u,
  );
  assert.equal(queries, 0);
});

test('tag inventory prefers peeled annotations and distinguishes missing tags from wrong objects', () => {
  const commit = 'a'.repeat(40),
    object = 'b'.repeat(40);
  const refs = parseTagRefs(
    `${commit} refs/tags/direct-v1.0.0\n${object} refs/tags/annotated-v1.0.0\n${commit} refs/tags/annotated-v1.0.0^{}\n${object} refs/tags/wrong-v1.0.0\n`,
  );
  assert.equal(tagState('direct', '1.0.0', commit, refs), 'exact');
  assert.equal(tagState('annotated', '1.0.0', commit, refs), 'exact');
  assert.equal(tagState('wrong', '1.0.0', commit, refs), 'wrong');
  assert.equal(tagState('absent', '1.0.0', commit, refs), 'missing');
  assert.throws(() => parseTagRefs('bad refs/tags/direct-v1.0.0'), /invalid/);
});
