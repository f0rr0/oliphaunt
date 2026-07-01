#!/usr/bin/env bun
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const decoder = new TextDecoder();

function fail(message) {
  console.error(`verify_product_tags.mjs: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
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
    fail(`unknown argument: ${arg}`);
  }
  if (!productsJson || !target) {
    fail('usage: tools/release/verify_product_tags.mjs --products-json <json-array> [--target <commitish>]');
  }
  return { productsJson, target };
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
  return [...new Set(products)].sort((left, right) => left.localeCompare(right));
}

function runVerifyProductTag(product, target) {
  const result = Bun.spawnSync(['tools/dev/bun.sh', 'tools/release/verify_product_tag.mjs', product, '--target', target], {
    cwd: root,
    stdout: 'inherit',
    stderr: 'pipe',
  });
  if (result.exitCode !== 0) {
    const stderr = decoder.decode(result.stderr).trim();
    fail(`${product} release tag is not ready${stderr ? `: ${stderr}` : ''}`);
  }
}

const { productsJson, target } = parseArgs(Bun.argv.slice(2));
const products = parseProducts(productsJson);
for (const product of products) {
  runVerifyProductTag(product, target);
}
console.log(`verified ${products.length} release product tag(s) at ${target}`);
