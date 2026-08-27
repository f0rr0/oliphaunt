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
  'surfaces',
]);
const optionalFields = new Set(['delegates_apple_to', 'delegates_android_to']);
const stringFields = new Set([
  'package_identity',
  'implementation_path',
  'documentation_path',
  'runtime_boundary',
]);
const listFields = new Set(['consumer_targets']);
const requiredSurfaceFields = new Set([
  'id',
  'entrypoint',
  'calling_contract',
  'execution_owner',
  'main_safe',
  'topologies',
]);
const knownTopologies = new Set([
  'native-direct',
  'native-broker',
  'native-server',
  'wasix-direct',
  'wasix-server',
]);
const knownCallingContracts = new Set(['async', 'sync']);
const knownExecutionOwners = new Set([
  'caller',
  'platform-sdk',
  'sdk-runtime',
  'sdk-thread',
  'sdk-worker',
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
if (manifest.schema_version !== 6) {
  errors.push(`schema_version is ${formatValue(manifest.schema_version)}; expected 6`);
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
  if (!Array.isArray(sdk.surfaces) || sdk.surfaces.length === 0) {
    errors.push(`[sdks.${sdkId}].surfaces must be a non-empty array of surface tables`);
  } else {
    const seenSurfaceIds = new Set();
    for (const [surfaceIndex, surface] of sdk.surfaces.entries()) {
      const location = `[sdks.${sdkId}].surfaces[${surfaceIndex}]`;
      if (!isPlainObject(surface)) {
        errors.push(`${location} must be a table`);
        continue;
      }
      for (const field of requiredSurfaceFields) {
        if (!(field in surface)) errors.push(`${location} is missing required field ${field}`);
      }
      for (const field of Object.keys(surface)) {
        if (!requiredSurfaceFields.has(field)) errors.push(`${location} has unknown field ${field}`);
      }
      for (const field of ['id', 'entrypoint', 'calling_contract', 'execution_owner']) {
        if (typeof surface[field] !== 'string' || surface[field].length === 0) {
          errors.push(`${location}.${field} must be a non-empty string`);
        }
      }
      if (typeof surface.id === 'string') {
        if (seenSurfaceIds.has(surface.id)) {
          errors.push(`${location}.id duplicates surface ${formatValue(surface.id)}`);
        }
        seenSurfaceIds.add(surface.id);
      }
      if (!knownCallingContracts.has(surface.calling_contract)) {
        errors.push(`${location}.calling_contract contains unknown contract ${formatValue(surface.calling_contract)}`);
      }
      if (!knownExecutionOwners.has(surface.execution_owner)) {
        errors.push(`${location}.execution_owner contains unknown owner ${formatValue(surface.execution_owner)}`);
      }
      if (typeof surface.main_safe !== 'boolean') {
        errors.push(`${location}.main_safe must be a boolean`);
      }
      if (surface.calling_contract === 'sync' && surface.main_safe !== false) {
        errors.push(`${location} synchronous database surfaces must declare main_safe = false`);
      }
      if (
        !Array.isArray(surface.topologies)
        || surface.topologies.length === 0
        || !surface.topologies.every((topology) => typeof topology === 'string' && topology.length > 0)
      ) {
        errors.push(`${location}.topologies must be a non-empty list of non-empty strings`);
      } else {
        if (new Set(surface.topologies).size !== surface.topologies.length) {
          errors.push(`${location}.topologies must not contain duplicates`);
        }
        for (const topology of surface.topologies) {
          if (!knownTopologies.has(topology)) {
            errors.push(`${location}.topologies contains unknown topology ${formatValue(topology)}`);
          }
        }
      }
    }
    if (!seenSurfaceIds.has('default')) {
      errors.push(`[sdks.${sdkId}].surfaces must contain a default surface`);
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
    if (
      typeof sdk.package_identity === 'string'
      && sdk.package_identity.startsWith('npm:')
      && Array.isArray(sdk.surfaces)
    ) {
      const packageFile = `${sdk.implementation_path}/package.json`;
      if (!existsSync(packageFile)) {
        errors.push(`[sdks.${sdkId}] npm implementation has no package.json`);
      } else {
        const packageManifest = JSON.parse(readFileSync(packageFile, 'utf8'));
        const packageName = sdk.package_identity.slice('npm:'.length);
        for (const surface of sdk.surfaces) {
          if (!isPlainObject(surface) || typeof surface.entrypoint !== 'string') continue;
          const exportKey = surface.entrypoint === packageName
            ? '.'
            : surface.entrypoint.startsWith(`${packageName}/`)
              ? `./${surface.entrypoint.slice(packageName.length + 1)}`
              : undefined;
          if (exportKey === undefined) {
            errors.push(
              `[sdks.${sdkId}] surface ${formatValue(surface.id)} entrypoint ${formatValue(surface.entrypoint)} is outside package ${formatValue(packageName)}`,
            );
          } else if (!isPlainObject(packageManifest.exports) || !(exportKey in packageManifest.exports)) {
            errors.push(
              `[sdks.${sdkId}] surface ${formatValue(surface.id)} entrypoint ${formatValue(surface.entrypoint)} is missing package export ${formatValue(exportKey)}`,
            );
          }
        }
      }
    }
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
      surfaces: sdks[sdkId].surfaces.map((surface) => ({
        id: surface.id,
        entrypoint: surface.entrypoint,
        callingContract: surface.calling_contract,
        executionOwner: surface.execution_owner,
        mainSafe: surface.main_safe,
        topologies: surface.topologies,
      })),
      consumerTargets: sdks[sdkId].consumer_targets,
    }])),
  }, null, 2));
} else if (mode === '--list') {
  for (const sdkId of sdkIds) {
    const sdk = sdks[sdkId];
    const surfaces = sdk.surfaces
      .map((surface) => `${surface.id}:${surface.calling_contract}/${surface.execution_owner}[${surface.topologies.join(',')}]`)
      .join(' ');
    console.log(`${sdkId}: surfaces=${surfaces} targets=${sdk.consumer_targets.join(',')}`);
  }
} else {
  console.log(`SDK manifest contract verified (${sdkIds.length} SDKs).`);
}
