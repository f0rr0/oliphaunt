#!/usr/bin/env bun
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const oidcTargets = new Set(['crates-io', 'npm', 'jsr']);
const mavenTargets = new Set(['maven-central']);
const githubTargets = new Set(['github-release', 'github-release-assets', 'swift-package-source-tag']);
const forbiddenEnvVars = {
  CARGO_REGISTRY_TOKEN: [
    new Set(['crates-io']),
    'Cargo publishing uses crates.io trusted publishing through GitHub Actions OIDC',
  ],
  NPM_TOKEN: [
    new Set(['npm']),
    'npm publishing uses trusted publishing with provenance through GitHub Actions OIDC',
  ],
  NODE_AUTH_TOKEN: [
    new Set(['npm']),
    'npm publishing uses trusted publishing with provenance through GitHub Actions OIDC',
  ],
  JSR_TOKEN: [new Set(['jsr']), 'JSR publishing uses GitHub Actions OIDC'],
  COCOAPODS_TRUNK_TOKEN: [
    new Set(),
    'Apple SDK releases use SwiftPM plus GitHub assets, not CocoaPods trunk',
  ],
  COCOAPODS_TRUNK_EMAIL: [
    new Set(),
    'Apple SDK releases use SwiftPM plus GitHub assets, not CocoaPods trunk',
  ],
};

function fail(message) {
  console.error(`check_publish_environment.mjs: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  let productsJson = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--products-json') {
      productsJson = argv[index + 1] ?? null;
      index += 1;
      continue;
    }
    fail(`unknown argument: ${arg}`);
  }
  if (productsJson === null) {
    fail('usage: tools/release/check_publish_environment.mjs --products-json <json-string-list>');
  }
  return { productsJson };
}

function parseProducts(raw) {
  let value;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    fail(`--products-json must be valid JSON: ${error.message}`);
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    fail('--products-json must be a JSON string list');
  }
  return new Set(value);
}

async function productConfigs() {
  const releasePlease = JSON.parse(await fs.readFile(path.join(root, 'release-please-config.json'), 'utf8'));
  if (typeof releasePlease.packages !== 'object' || releasePlease.packages === null) {
    fail('release-please-config.json must define packages');
  }
  const products = new Map();
  const packageEntries = Object.entries(releasePlease.packages).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  for (const [packagePath, packageConfig] of packageEntries) {
    if (path.isAbsolute(packagePath) || packagePath.split(/[\\/]/u).includes('..')) {
      fail(`release-please package path must stay inside the repository: ${packagePath}`);
    }
    const component = packageConfig?.component;
    if (typeof component !== 'string' || component.length === 0) {
      fail(`${packagePath}.component must be a non-empty string`);
    }
    const file = path.join(root, packagePath, 'release.toml');
    const metadata = Bun.TOML.parse(await fs.readFile(file, 'utf8'));
    const id = metadata.id;
    if (id !== component) {
      fail(`${path.relative(root, file)} must declare id = "${component}"`);
    }
    if (products.has(id)) {
      fail(`duplicate release product id ${id}`);
    }
    const publishTargets = metadata.publish_targets ?? [];
    if (
      !Array.isArray(publishTargets) ||
      publishTargets.some((target) => typeof target !== 'string')
    ) {
      fail(`${id}.publish_targets must be a string list`);
    }
    products.set(id, { publishTargets });
  }
  return products;
}

function requireEnv(name, context, failures) {
  if (!process.env[name]) {
    failures.push(`${context} requires ${name}`);
  }
}

function requireAnyEnv(names, context, failures) {
  if (!names.some((name) => process.env[name])) {
    failures.push(`${context} requires one of ${names.join(', ')}`);
  }
}

function intersects(left, right) {
  for (const value of left) {
    if (right.has(value)) {
      return true;
    }
  }
  return false;
}

const args = parseArgs(Bun.argv.slice(2));
const products = parseProducts(args.productsJson);
const configs = await productConfigs();
const unknown = [...products].filter((product) => !configs.has(product)).sort();
if (unknown.length > 0) {
  fail(`unknown release products: ${unknown.join(', ')}`);
}

const publishTargets = new Set();
for (const product of products) {
  for (const target of configs.get(product).publishTargets) {
    publishTargets.add(target);
  }
}

const failures = [];
for (const [name, [blockedTargets, reason]] of Object.entries(forbiddenEnvVars).sort()) {
  const appliesToSelection =
    products.size > 0 && (blockedTargets.size === 0 || intersects(publishTargets, blockedTargets));
  if (appliesToSelection && process.env[name]) {
    failures.push(`forbidden release credential ${name} is set: ${reason}`);
  }
}

if (intersects(publishTargets, oidcTargets)) {
  requireEnv('ACTIONS_ID_TOKEN_REQUEST_TOKEN', 'trusted publishing', failures);
  requireEnv('ACTIONS_ID_TOKEN_REQUEST_URL', 'trusted publishing', failures);
}

if (intersects(publishTargets, githubTargets)) {
  requireAnyEnv(['GH_TOKEN', 'GITHUB_TOKEN'], 'GitHub release assets and tags', failures);
}

if (intersects(publishTargets, mavenTargets)) {
  for (const name of [
    'ORG_GRADLE_PROJECT_mavenCentralUsername',
    'ORG_GRADLE_PROJECT_mavenCentralPassword',
    'ORG_GRADLE_PROJECT_signingInMemoryKey',
    'ORG_GRADLE_PROJECT_signingInMemoryKeyId',
    'ORG_GRADLE_PROJECT_signingInMemoryKeyPassword',
  ]) {
    requireEnv(name, 'Maven Central publish', failures);
  }
}

if (failures.length > 0) {
  fail(`missing publish environment:\n  - ${failures.join('\n  - ')}`);
}

console.log('publish environment checks passed');
