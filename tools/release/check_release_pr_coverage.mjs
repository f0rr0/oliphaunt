#!/usr/bin/env bun
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  exactReleasePleaseQualificationTransportBaseline,
  isExactReleasePleaseIntroductionCommit,
} from './release-please-bootstrap.mjs';
import { captureCommandOutput } from '../dev/capture-command-output.mjs';
import { loadGraph } from './release-graph.mjs';
import { releaseProductVersionCoverage } from './release-product-version-coverage.mjs';
import { deriveReleaseProducts, verifyReleaseCommit } from './verify-release-commit.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MANIFEST = '.release-please-manifest.json';

function fail(message) {
  console.error(`check_release_pr_coverage.mjs: ${message}`);
  process.exit(1);
}

function run(command, args, { check = true, cwd = ROOT } = {}) {
  const result = captureCommandOutput(command, args, {
    cwd,
    label: `${command} ${args.join(' ')}`,
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

export function gitStdout(args, options = {}) {
  return git(args, options).stdout.trim();
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

function currentReleasePleaseConfig() {
  return parseJsonObject(
    fs.readFileSync(path.join(ROOT, 'release-please-config.json'), 'utf8'),
    'release-please-config.json',
  );
}

function headParentShas() {
  const fields = gitStdout(['rev-list', '--parents', '-n', '1', 'HEAD']).trim().split(/\s+/u);
  return fields.slice(1);
}

function releasePleaseProductPaths(config) {
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

export function releasePleaseCoverageBootstrapBaseline(
  releasePleaseConfig,
  beforeManifest,
  afterManifest,
  parentShas,
  { prefix = 'check_release_pr_coverage.mjs' } = {},
) {
  if (isExactReleasePleaseIntroductionCommit(releasePleaseConfig, afterManifest, parentShas)) {
    return { kind: 'introduction' };
  }
  return exactReleasePleaseQualificationTransportBaseline(
    releasePleaseConfig,
    beforeManifest,
    afterManifest,
    parentShas,
    { prefix },
  );
}

function main() {
  const afterManifest = currentManifest();
  const releasePleaseConfig = currentReleasePleaseConfig();
  const parentShas = headParentShas();
  const beforeParentManifest = parentShas.length === 1 ? manifestAt(parentShas[0]) : {};
  const bootstrapBaseline = releasePleaseCoverageBootstrapBaseline(
    releasePleaseConfig,
    beforeParentManifest,
    afterManifest,
    parentShas,
  );
  if (bootstrapBaseline !== null) {
    console.log(
      bootstrapBaseline.kind === 'introduction'
        ? 'release PR coverage check skipped for the exact unreleased introduction commit'
        : 'release PR coverage check skipped for the exact unreleased qualification transport baseline',
    );
    return;
  }

const ref = baseRef();
if (ref === null) {
  fail('could not resolve base ref for release PR coverage check');
}

const beforeManifest = manifestAt(ref);
const productPaths = releasePleaseProductPaths(releasePleaseConfig);
const versionedProducts = new Set();

for (const [product, packagePath] of productPaths.entries()) {
  if (beforeManifest[packagePath] !== afterManifest[packagePath]) {
    versionedProducts.add(product);
  }
}

if (versionedProducts.size === 0) {
  console.log('release PR coverage check skipped; release-please manifest is unchanged');
  process.exit(0);
}

const graph = loadGraph('check_release_pr_coverage.mjs');
const knownProducts = new Set(Object.keys(graph.products));
const unknownVersioned = [...versionedProducts].filter(product => !knownProducts.has(product)).sort();
if (unknownVersioned.length > 0) {
  fail(`${MANIFEST} changed unknown products: ${unknownVersioned.join(', ')}`);
}

const versionedProductList = [...versionedProducts].sort();
try {
  const derivedProducts = deriveReleaseProducts({ repo: ROOT, headRef: 'HEAD' }).products;
  if (JSON.stringify(derivedProducts) !== JSON.stringify(versionedProductList)) {
    fail(
      `release commit manifest transitions disagree with base coverage: ` +
        `base=${JSON.stringify(versionedProductList)}, parent=${JSON.stringify(derivedProducts)}`,
    );
  }
  const verified = verifyReleaseCommit({
    repo: ROOT,
    headRef: 'HEAD',
    products: versionedProductList,
  });
  const baseCommit = gitStdout(['rev-parse', `${ref}^{commit}`]);
  if (verified.parent !== baseCommit) {
    fail(`release commit parent ${verified.parent} does not match coverage base ${baseCommit}`);
  }
} catch (error) {
  fail(error instanceof Error ? error.message.replace(/^verify-release-commit[.]mjs: /u, '') : String(error));
}

let coverage;
try {
  coverage = releaseProductVersionCoverage(graph, versionedProductList, 'check_release_pr_coverage.mjs');
} catch (error) {
  fail(error.message.replace(/^check_release_pr_coverage[.]mjs: /u, ''));
}
const missing = coverage.missingProducts;
if (missing.length > 0) {
  fail(
    'the generated release PR did not version every dependency-selected release product. ' +
      'Moon production/peer edges and directed release compatibility fields are authoritative; ' +
      'Release Please plus sync-release-pr must own the corresponding versions, changelogs, and tags. ' +
      'Missing product version bumps: ' +
      missing.join(', '),
  );
}

  console.log('release PR product coverage checks passed');
}

if (import.meta.main) {
  main();
}
