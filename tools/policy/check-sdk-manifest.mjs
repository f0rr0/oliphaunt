#!/usr/bin/env bun

import { existsSync, readFileSync, statSync } from 'node:fs';

import { loadGraph } from '../release/release-graph.mjs';

const manifestPath = 'tools/policy/sdk-manifest.toml';
const parityPolicyPath = 'docs/maintainers/sdk-parity-policy.md';
const deferredIds = [
  'FUTURE-EXTENSION-MIGRATION',
  'FUTURE-NATIVE-SERVER-SDK-BACKUP',
  'FUTURE-SWIFT-MACOS-SERVER-TOOLS',
  'FUTURE-RESTORE-REPLACE',
  'FUTURE-WASIX-CANCELLATION',
  'FUTURE-WASIX-DIRECT-COPY',
];
const releaseProducts = loadGraph('check-sdk-manifest.mjs').products;
const releaseSdkProducts = Object.values(releaseProducts).filter((product) => product.kind === 'sdk');
const requiredFields = new Set([
  'package_identity',
  'implementation_path',
  'documentation_path',
  'consumer_targets',
  'runtime_owner',
  'runtime_boundary',
  'execution_modes',
]);
const optionalFields = new Set(['delegates_apple_to', 'delegates_android_to']);
const stringFields = new Set([
  'package_identity',
  'implementation_path',
  'documentation_path',
  'runtime_boundary',
]);
const listFields = new Set(['consumer_targets', 'execution_modes']);
const knownModes = new Set([
  'native-direct',
  'native-broker',
  'native-server',
  'wasix-direct',
  'wasix-worker',
  'wasix-server',
]);
const errors = [];

function fail(message) {
  console.error(`check-sdk-manifest.mjs: ${message}`);
  process.exit(1);
}

function usage() {
  console.log('usage: tools/policy/check-sdk-manifest.mjs [--list] [--json]');
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function formatValue(value) {
  return JSON.stringify(value);
}

function releaseRegistryIdentity(packageIdentity) {
  return packageIdentity.startsWith('cargo:')
    ? `crates:${packageIdentity.slice('cargo:'.length)}`
    : packageIdentity;
}

function requireDirectory(relativePath, sdkId, field) {
  if (!existsSync(relativePath)) {
    errors.push(`[sdks.${sdkId}].${field} points at missing path ${formatValue(relativePath)}`);
  } else if (!statSync(relativePath).isDirectory()) {
    errors.push(`[sdks.${sdkId}].${field} must point at a directory: ${formatValue(relativePath)}`);
  }
}

const args = process.argv.slice(2);
if (args.includes('--help')) {
  usage();
  process.exit(0);
}
if (args.length > 1) fail(`expected at most one option, got ${args.join(' ')}`);
const mode = args[0] ?? 'check';
if (!['check', '--list', '--json'].includes(mode)) fail(`unknown option: ${mode}`);

const manifest = Bun.TOML.parse(readFileSync(manifestPath, 'utf8'));
const parityPolicy = readFileSync(parityPolicyPath, 'utf8');
const actualDeferredIds = [...parityPolicy.matchAll(/\bFUTURE-[A-Z0-9-]+\b/g)].map(([id]) => id);
const expectedDeferredIds = [...deferredIds].sort();
if (
  actualDeferredIds.length !== deferredIds.length
  || [...actualDeferredIds].sort().some((id, index) => id !== expectedDeferredIds[index])
) {
  errors.push(
    `${parityPolicyPath} must contain each canonical deferred ID exactly once; found ${formatValue(actualDeferredIds)}`,
  );
}
if (manifest.schema_version !== 4) {
  errors.push(`schema_version is ${formatValue(manifest.schema_version)}; expected 4`);
}
if (!isPlainObject(manifest.sdks)) errors.push('manifest must contain an [sdks] table');

const sdks = isPlainObject(manifest.sdks) ? manifest.sdks : {};
const sdkIds = Object.keys(sdks).sort();
if (sdkIds.length === 0) errors.push('manifest must register at least one SDK');

const seenImplementationPaths = new Map();
const seenPackageIdentities = new Map();
for (const sdkId of sdkIds) {
  const sdk = sdks[sdkId];
  if (!isPlainObject(sdk)) {
    errors.push(`[sdks.${sdkId}] must be a table`);
    continue;
  }
  for (const field of requiredFields) {
    if (!(field in sdk)) errors.push(`[sdks.${sdkId}] is missing required field ${field}`);
  }
  for (const field of Object.keys(sdk)) {
    if (!requiredFields.has(field) && !optionalFields.has(field)) {
      errors.push(`[sdks.${sdkId}] has unknown field ${field}`);
    }
  }
  for (const field of stringFields) {
    if (typeof sdk[field] !== 'string' || sdk[field].length === 0) {
      errors.push(`[sdks.${sdkId}].${field} must be a non-empty string`);
    }
  }
  for (const field of listFields) {
    const value = sdk[field];
    if (!Array.isArray(value) || value.length === 0 || !value.every((item) => typeof item === 'string' && item.length > 0)) {
      errors.push(`[sdks.${sdkId}].${field} must be a non-empty list of non-empty strings`);
    } else if (new Set(value).size !== value.length) {
      errors.push(`[sdks.${sdkId}].${field} must not contain duplicates`);
    }
  }
  if (Array.isArray(sdk.execution_modes)) {
    for (const executionMode of sdk.execution_modes) {
      if (!knownModes.has(executionMode)) {
        errors.push(`[sdks.${sdkId}].execution_modes contains unknown mode ${formatValue(executionMode)}`);
      }
    }
  }
  if (typeof sdk.runtime_owner !== 'boolean') {
    errors.push(`[sdks.${sdkId}].runtime_owner must be a boolean`);
  }
  if (typeof sdk.package_identity === 'string') {
    if (!sdk.package_identity.includes(':')) {
      errors.push(`[sdks.${sdkId}].package_identity must include its registry kind`);
    } else if (seenPackageIdentities.has(sdk.package_identity)) {
      errors.push(
        `[sdks.${sdkId}].package_identity duplicates [sdks.${seenPackageIdentities.get(sdk.package_identity)}] identity ${formatValue(sdk.package_identity)}`,
      );
    }
    seenPackageIdentities.set(sdk.package_identity, sdkId);
  }
  if (typeof sdk.implementation_path === 'string') {
    if (seenImplementationPaths.has(sdk.implementation_path)) {
      errors.push(
        `[sdks.${sdkId}].implementation_path duplicates [sdks.${seenImplementationPaths.get(sdk.implementation_path)}] path ${formatValue(sdk.implementation_path)}`,
      );
    }
    seenImplementationPaths.set(sdk.implementation_path, sdkId);
    requireDirectory(sdk.implementation_path, sdkId, 'implementation_path');
  }
  if (typeof sdk.documentation_path === 'string') {
    requireDirectory(sdk.documentation_path, sdkId, 'documentation_path');
  }
}

const releaseSdkByPath = new Map();
for (const product of releaseSdkProducts) {
  if (releaseSdkByPath.has(product.path)) {
    errors.push(`release SDK products ${releaseSdkByPath.get(product.path).id} and ${product.id} share path ${formatValue(product.path)}`);
  }
  releaseSdkByPath.set(product.path, product);
  if (!seenImplementationPaths.has(product.path)) {
    errors.push(`release SDK product ${product.id} at ${formatValue(product.path)} is missing from the SDK manifest`);
  }
}
for (const sdkId of sdkIds) {
  const sdk = sdks[sdkId];
  if (!isPlainObject(sdk) || typeof sdk.implementation_path !== 'string') continue;
  const product = releaseSdkByPath.get(sdk.implementation_path);
  if (product === undefined) {
    errors.push(`[sdks.${sdkId}] path ${formatValue(sdk.implementation_path)} is not an SDK product in the release graph`);
  } else if (
    Array.isArray(product.registry_packages)
    && product.registry_packages.length > 0
    && !product.registry_packages.includes(releaseRegistryIdentity(sdk.package_identity))
  ) {
    errors.push(`[sdks.${sdkId}].package_identity ${formatValue(sdk.package_identity)} is not published by release SDK product ${product.id}`);
  }
}

for (const sdkId of sdkIds) {
  const sdk = sdks[sdkId];
  if (!isPlainObject(sdk)) continue;
  let delegationCount = 0;
  for (const field of ['delegates_apple_to', 'delegates_android_to']) {
    const delegate = sdk[field];
    if (delegate === undefined) continue;
    delegationCount += 1;
    if (typeof delegate !== 'string' || !(delegate in sdks)) {
      errors.push(`[sdks.${sdkId}].${field} points at unknown SDK ${formatValue(delegate)}`);
    } else if (sdks[delegate]?.runtime_owner !== true) {
      errors.push(`[sdks.${sdkId}].${field} must point at a runtime-owning SDK`);
    }
  }
  if (sdk.runtime_owner === false && delegationCount === 0) {
    errors.push(`[sdks.${sdkId}] does not own a runtime and must declare delegation`);
  }
  if (sdk.runtime_owner === true && delegationCount > 0) {
    errors.push(`[sdks.${sdkId}] owns its runtime and must not declare delegation`);
  }
}

if (errors.length > 0) {
  for (const error of errors) console.error(`check-sdk-manifest.mjs: ${error}`);
  process.exit(1);
}

if (mode === '--json') {
  console.log(JSON.stringify({
    schemaVersion: manifest.schema_version,
    sdkCount: sdkIds.length,
    sdks: Object.fromEntries(sdkIds.map((sdkId) => [sdkId, {
      packageIdentity: sdks[sdkId].package_identity,
      runtimeOwner: sdks[sdkId].runtime_owner,
      executionModes: sdks[sdkId].execution_modes,
      consumerTargets: sdks[sdkId].consumer_targets,
    }])),
  }, null, 2));
} else if (mode === '--list') {
  for (const sdkId of sdkIds) {
    const sdk = sdks[sdkId];
    console.log(`${sdkId}: modes=${sdk.execution_modes.join(',')} targets=${sdk.consumer_targets.join(',')}`);
  }
} else {
  console.log(`SDK manifest contract verified (${sdkIds.length} SDKs).`);
}
