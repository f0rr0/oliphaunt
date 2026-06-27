#!/usr/bin/env bun
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MANIFEST = '.release-please-manifest.json';

function fail(message) {
  console.error(`check_release_pr_coverage.mjs: ${message}`);
  process.exit(1);
}

function run(command, args, { check = true } = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) {
    if (check) {
      fail(`failed to run ${command}: ${result.error.message}`);
    }
    return result;
  }
  if (check && result.status !== 0) {
    fail(`${command} ${args.join(' ')} failed: ${result.stderr.trim()}`);
  }
  return result;
}

function git(args, options = {}) {
  return run('git', args, options);
}

function gitStdout(args) {
  return git(args).stdout;
}

function refExists(ref) {
  return git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { check: false }).status === 0;
}

function baseRef() {
  const candidates = [];
  const baseBranch = process.env.GITHUB_BASE_REF;
  if (baseBranch) {
    candidates.push(`origin/${baseBranch}`, baseBranch);
  }
  candidates.push('origin/main', 'main');
  return candidates.find(refExists) ?? null;
}

function parseJsonObject(raw, context) {
  let value;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    fail(`${context} must be valid JSON: ${error.message}`);
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${context} must be a JSON object`);
  }
  return value;
}

function requireStringObject(value, context) {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.entries(value).some(([key, item]) => typeof key !== 'string' || typeof item !== 'string')
  ) {
    fail(`${context} must be a JSON string object`);
  }
  return value;
}

function manifestAt(ref) {
  if (git(['cat-file', '-e', `${ref}:${MANIFEST}`], { check: false }).status !== 0) {
    return {};
  }
  const raw = gitStdout(['show', `${ref}:${MANIFEST}`]);
  return requireStringObject(parseJsonObject(raw, `${MANIFEST} at ${ref}`), `${MANIFEST} at ${ref}`);
}

function currentManifest() {
  const raw = fs.readFileSync(path.join(ROOT, MANIFEST), 'utf8');
  return requireStringObject(parseJsonObject(raw, MANIFEST), MANIFEST);
}

function releasePleaseProductPaths() {
  const config = parseJsonObject(
    fs.readFileSync(path.join(ROOT, 'release-please-config.json'), 'utf8'),
    'release-please-config.json',
  );
  const packages = config.packages;
  if (packages === null || typeof packages !== 'object' || Array.isArray(packages)) {
    fail('release-please-config.json must define packages');
  }
  const productPaths = new Map();
  for (const [packagePath, packageConfig] of Object.entries(packages)) {
    const component = packageConfig?.component;
    if (typeof component !== 'string' || component.length === 0) {
      fail(`release-please package ${packagePath} must define component`);
    }
    if (productPaths.has(component)) {
      fail(`release-please-config.json declares duplicate component ${component}`);
    }
    productPaths.set(component, packagePath);
  }
  return productPaths;
}

function releasePlan(ref) {
  const result = run('tools/dev/bun.sh', [
    'tools/release/release_plan.mjs',
    '--base-ref',
    ref,
    '--head-ref',
    'HEAD',
    '--format',
    'json',
  ]);
  return parseJsonObject(result.stdout, 'release plan output');
}

const ref = baseRef();
if (ref === null) {
  fail('could not resolve base ref for release PR coverage check');
}

const plan = releasePlan(ref);
const files = Array.isArray(plan.changedFiles) ? plan.changedFiles : [];
if (!files.includes(MANIFEST)) {
  console.log('release PR coverage check skipped; release-please manifest is unchanged');
  process.exit(0);
}

const beforeManifest = manifestAt(ref);
const afterManifest = currentManifest();
const productPaths = releasePleaseProductPaths();
const knownProducts = new Set(Array.isArray(plan.productIds) ? plan.productIds : []);
const versionedProducts = new Set();

for (const [product, packagePath] of productPaths.entries()) {
  if (beforeManifest[packagePath] !== afterManifest[packagePath]) {
    versionedProducts.add(product);
  }
}

const selectedProducts = new Set(Array.isArray(plan.releaseProducts) ? plan.releaseProducts : []);
const missing = [...selectedProducts].filter(product => !versionedProducts.has(product)).sort();
if (missing.length > 0) {
  fail(
    'release-please did not version every Moon-selected release product. ' +
      'Moon remains the dependency authority, but release-please must own ' +
      'the corresponding versions/tags. Missing product version bumps: ' +
      missing.join(', '),
  );
}

const unknownVersioned = [...versionedProducts].filter(product => !knownProducts.has(product)).sort();
if (unknownVersioned.length > 0) {
  fail(`${MANIFEST} changed unknown products: ${unknownVersioned.join(', ')}`);
}

console.log('release PR product coverage checks passed');
