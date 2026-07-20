#!/usr/bin/env bun
import { spawnSync } from 'node:child_process';

import { compareText, loadGraph } from './release-graph.mjs';

const root = new URL('../..', import.meta.url).pathname;

function fail(message) {
  console.error(`verify_product_tags.mjs: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  let allowMissing = false;
  let productsJson = '';
  let target = process.env.GITHUB_SHA || 'HEAD';
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--products-json') {
      productsJson = argv[index + 1] ?? '';
      index += 1;
      continue;
    }
    if (arg === '--target') {
      target = argv[index + 1] ?? '';
      index += 1;
      continue;
    }
    if (arg === '--allow-missing') {
      allowMissing = true;
      continue;
    }
    fail(`unknown argument: ${arg}`);
  }
  if (!productsJson || !target) {
    fail('usage: tools/release/verify_product_tags.mjs --products-json <json-array> [--target <commitish>] [--allow-missing]');
  }
  return { allowMissing, productsJson, target };
}

function parseProducts(productsJson) {
  let products;
  try {
    products = JSON.parse(productsJson);
  } catch (error) {
    fail(`--products-json must be valid JSON: ${error.message}`);
  }
  if (!Array.isArray(products) || products.length === 0 || !products.every((product) => typeof product === 'string' && product)) {
    fail('--products-json must be a non-empty JSON string array');
  }
  return [...new Set(products)].sort(compareText);
}

function git(args, { check = true } = {}) {
  const result = spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) {
    fail(result.error.message);
  }
  if (check && result.status !== 0) {
    fail(`git ${args.join(' ')} failed${result.stderr.trim() ? `: ${result.stderr.trim()}` : ''}`);
  }
  return { status: result.status, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}

const { allowMissing, productsJson, target } = parseArgs(Bun.argv.slice(2));
const products = parseProducts(productsJson);
const graph = loadGraph('verify_product_tags.mjs');
const rows = products.map((product) => {
  const config = graph.products[product];
  if (!config) {
    fail(`unknown release product '${product}'`);
  }
  return { product, tag: `${config.tag_prefix}${config.version}` };
});
const targetCommit = git(['rev-parse', '--verify', `${target}^{commit}`]).stdout;

let remoteTags = null;
if (git(['remote', 'get-url', 'origin'], { check: false }).status === 0) {
  const advertised = git(['ls-remote', '--tags', 'origin']);
  remoteTags = new Set(
    advertised.stdout
      .split(/\r?\n/u)
      .map((line) => line.split(/\s+/u)[1] ?? '')
      .filter((ref) => ref.startsWith('refs/tags/'))
      .map((ref) => ref.replace(/\^\{\}$/u, '')),
  );
  const existingRefs = rows
    .filter(({ tag }) => remoteTags.has(`refs/tags/${tag}`))
    .map(({ tag }) => `refs/tags/${tag}:refs/tags/${tag}`);
  if (existingRefs.length > 0) {
    git(['fetch', '--force', '--no-tags', 'origin', ...existingRefs]);
  }
}

let absent = 0;
let exact = 0;
for (const { product, tag } of rows) {
  const advertised = remoteTags === null ? null : remoteTags.has(`refs/tags/${tag}`);
  const resolved = advertised === false
    ? { status: 1, stdout: '' }
    : git(['rev-parse', '--verify', '--quiet', `refs/tags/${tag}^{commit}`], { check: false });
  if (resolved.status !== 0) {
    absent += 1;
    if (!allowMissing) {
      fail(`${product} release tag ${tag} does not exist; stage the exact-SHA draft release before publication`);
    }
    continue;
  }
  if (resolved.stdout !== targetCommit) {
    fail(`${product} release tag ${tag} points at ${resolved.stdout}, not exact release commit ${targetCommit}`);
  }
  exact += 1;
}
console.log(
  `${allowMissing ? 'preflighted' : 'verified'} ${products.length} release product tag(s) at ${targetCommit}: ` +
    `${exact} exact, ${absent} absent`,
);
