#!/usr/bin/env bun
import { appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { parseTagRefs } from '../../src/shared/product-metadata/git-tag-state.mts';
export { parseTagRefs } from '../../src/shared/product-metadata/git-tag-state.mts';

import { loadPublicationLock, lockedCarriers } from '../../tools/release/publication-lock.mts';
import {
  productRegistryPackagesFromLock,
  queryRegistryPackages,
} from '../../tools/release/check_registry_publication.mts';

const ROOT = path.resolve(import.meta.dir, '../..');

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function fail(message) {
  throw new Error(`registry-bootstrap-ledger-state: ${message}`);
}

function parseProducts(raw) {
  let value;
  try {
    value = JSON.parse(raw);
  } catch (cause) {
    fail(`PRODUCTS_JSON is invalid: ${cause.message}`);
  }
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((item) => typeof item !== 'string' || item.length === 0)
  ) {
    fail('PRODUCTS_JSON must be a non-empty product string list');
  }
  return [...new Set(value)].sort();
}

export function classifyLedgerRequirement(rows) {
  const requiring = rows
    .filter(
      (row) =>
        row.queryState !== 'skipped-exact-tag' && row.published > 0 && row.tagState === 'missing',
    )
    .map(({ product, ecosystem, published }) => ({ product, ecosystem, published }))
    .sort((left, right) =>
      compareText(`${left.product}:${left.ecosystem}`, `${right.product}:${right.ecosystem}`),
    );
  const conflicting = rows.filter((row) => row.tagState === 'wrong');
  if (conflicting.length > 0) {
    fail(
      `current product tag points at another commit: ${conflicting.map(({ product }) => product).join(', ')}`,
    );
  }
  return { needsLedger: requiring.length > 0, requiring };
}

function query(lock, product, ecosystem) {
  return queryRegistryPackages(
    productRegistryPackagesFromLock(lock, product, {
      registryKind: ecosystem === 'cargo' ? 'crates' : 'npm',
    }),
  );
}

export function tagState(product, version, headCommit, tags) {
  const ref = `refs/tags/${product}-v${version}`;
  const commit = tags.get(ref + '^{}') ?? tags.get(ref);
  return commit === undefined ? 'missing' : commit === headCommit ? 'exact' : 'wrong';
}

export async function collectLedgerRows(
  { lock, products, headCommit, tags },
  {
    carriersFor = lockedCarriers,
    queryPublication = query,
    resolveTagState = (product, version, headCommit) =>
      tagState(product, version, headCommit, tags),
  } = {},
) {
  const rows = [];
  for (const product of products) {
    const productRow = lock.products.find((entry) => entry.id === product);
    if (productRow === undefined) fail(`publication lock omits selected product ${product}`);
    const currentTagState = resolveTagState(product, productRow.version, headCommit);
    if (currentTagState === 'wrong') {
      fail(`current product tag points at another commit: ${product}`);
    }
    if (currentTagState !== 'exact' && currentTagState !== 'missing') {
      fail(`product tag state for ${product} is invalid: ${JSON.stringify(currentTagState)}`);
    }
    for (const ecosystem of ['cargo', 'npm']) {
      const carriers = carriersFor(lock, { product, ecosystem });
      if (carriers.length === 0) continue;
      if (currentTagState === 'exact') {
        rows.push({
          product,
          ecosystem,
          published: null,
          missing: null,
          queryState: 'skipped-exact-tag',
          tagState: currentTagState,
        });
        continue;
      }
      const result = await queryPublication(lock, product, ecosystem);
      if (!Array.isArray(result.published) || !Array.isArray(result.missing)) {
        fail(`registry query returned invalid publication lists for ${product}/${ecosystem}`);
      }
      rows.push({
        product,
        ecosystem,
        published: result.published.length,
        missing: result.missing.length,
        queryState: 'queried',
        tagState: currentTagState,
      });
    }
  }
  return rows;
}

async function main() {
  const lockFile = path.resolve(
    ROOT,
    process.env.PUBLICATION_LOCK_PATH || 'target/release/publication-lock.json',
  );
  const products = parseProducts(process.env.PRODUCTS_JSON || '');
  const headCommit = process.env.RELEASE_HEAD_COMMIT;
  if (!/^[0-9a-f]{40}$/u.test(headCommit ?? ''))
    fail('RELEASE_HEAD_COMMIT must be a full commit SHA');
  const refsFile = process.argv[2];
  if (!refsFile) fail('run registry-bootstrap-ledger-state.sh to read Git references');
  const tags = parseTagRefs(readFileSync(refsFile, 'utf8'));
  const lock = loadPublicationLock(lockFile);
  if (lock.source.commit !== headCommit) {
    fail(`publication lock source ${lock.source.commit} does not match ${headCommit}`);
  }
  const rows = await collectLedgerRows({ lock, products, headCommit, tags });
  const state = classifyLedgerRequirement(rows);
  const output = process.env.GITHUB_OUTPUT;
  if (output) {
    appendFileSync(output, `needs_ledger=${String(state.needsLedger)}\n`);
    appendFileSync(output, `state_json=${JSON.stringify(rows)}\n`);
  }
  console.log(JSON.stringify({ ...state, rows }, null, 2));
}

if (import.meta.main) {
  try {
    await main();
  } catch (cause) {
    console.error(cause instanceof Error ? cause.message : String(cause));
    process.exit(1);
  }
}
