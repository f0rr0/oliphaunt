#!/usr/bin/env bun

import { existsSync, readFileSync, statSync } from 'node:fs';

import { loadGraph } from '../release/release-graph.mjs';

const manifestPath = 'tools/policy/sdk-manifest.toml';
const jsPackagePath = 'src/sdks/js/package.json';
const parityPolicyPath = 'docs/maintainers/sdk-parity-policy.md';
const deferredIds = [
  'FUTURE-EXTENSION-MIGRATION',
  'FUTURE-NATIVE-SERVER-SDK-BACKUP',
  'FUTURE-RESTORE-REPLACE',
  'FUTURE-WASIX-CANCELLATION',
  'FUTURE-WASIX-DIRECT-COPY',
  'FUTURE-WASIX-TS-SERVER-TOOLS',
];
const jsPackage = JSON.parse(readFileSync(jsPackagePath, 'utf8'));
const brokerHelperProduct = jsPackage?.oliphaunt?.brokerHelper;
const releaseProducts = loadGraph('check-sdk-manifest.mjs').products;
const releaseSdkProducts = Object.values(releaseProducts).filter((product) => product.kind === 'sdk');

const requiredFields = new Set([
  'classification',
  'package_identity',
  'implementation_path',
  'documentation_path',
  'supported_consumer_targets',
  'runtime_owner',
  'runtime_boundary',
  'parity_role',
  'available_modes',
  'unsupported_modes',
  'artifact_resolution',
  'tool_resolution',
  'extension_resolution',
  'resource_override',
]);
const optionalFields = new Set([
  'unsupported_mode_reason',
  'delegates_apple_to',
  'delegates_android_to',
  'depends_on_rust_broker_helper',
  'broker_helper_product',
]);
const stringFields = new Set([
  'classification',
  'package_identity',
  'implementation_path',
  'documentation_path',
  'runtime_boundary',
  'parity_role',
  'artifact_resolution',
  'tool_resolution',
  'extension_resolution',
  'resource_override',
]);
const listFields = new Set([
  'supported_consumer_targets',
  'available_modes',
  'unsupported_modes',
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

function requireDirectory(path, sdkId, field) {
  if (!existsSync(path)) {
    errors.push(`[sdks.${sdkId}].${field} points at missing path ${formatValue(path)}`);
    return;
  }
  if (!statSync(path).isDirectory()) {
    errors.push(`[sdks.${sdkId}].${field} must point at a directory: ${formatValue(path)}`);
  }
}

const args = process.argv.slice(2);
if (args.includes('--help')) {
  usage();
  process.exit(0);
}
if (args.length > 1) {
  fail(`expected at most one option, got ${args.join(' ')}`);
}
const mode = args[0] ?? 'check';
if (!['check', '--list', '--json'].includes(mode)) {
  fail(`unknown option: ${mode}`);
}

const manifest = Bun.TOML.parse(readFileSync(manifestPath, 'utf8'));
const parityPolicy = readFileSync(parityPolicyPath, 'utf8');
const actualDeferredIds = [...parityPolicy.matchAll(/\bFUTURE-[A-Z0-9-]+\b/g)].map(
  ([id]) => id,
);
if (
  actualDeferredIds.length !== deferredIds.length ||
  [...actualDeferredIds].sort().some((id, index) => id !== deferredIds[index])
) {
  errors.push(
    `${parityPolicyPath} must contain each canonical deferred ID exactly once; found ${formatValue(
      actualDeferredIds,
    )}`,
  );
}
if (manifest.schema_version !== 3) {
  errors.push(`schema_version is ${formatValue(manifest.schema_version)}; expected 3`);
}
if (!isPlainObject(manifest.sdks)) {
  errors.push('manifest must contain an [sdks] table');
}

const sdks = isPlainObject(manifest.sdks) ? manifest.sdks : {};
const sdkIds = Object.keys(sdks).sort();
if (sdkIds.length === 0) errors.push('manifest must register at least one SDK');

const seenImplementationPaths = new Map();
const seenPackageIdentities = new Map();
for (const sdkId of sdkIds) {
  const actual = sdks[sdkId];
  if (!isPlainObject(actual)) {
    errors.push(`[sdks.${sdkId}] must be a table`);
    continue;
  }

  for (const field of requiredFields) {
    if (!(field in actual)) errors.push(`[sdks.${sdkId}] is missing required field ${field}`);
  }
  for (const field of Object.keys(actual)) {
    if (!requiredFields.has(field) && !optionalFields.has(field)) {
      errors.push(`[sdks.${sdkId}] has unknown field ${field}`);
    }
  }
  for (const field of stringFields) {
    if (typeof actual[field] !== 'string' || actual[field].length === 0) {
      errors.push(`[sdks.${sdkId}].${field} must be a non-empty string`);
    }
  }
  for (const field of listFields) {
    const value = actual[field];
    if (!Array.isArray(value) || !value.every((item) => typeof item === 'string' && item.length > 0)) {
      errors.push(`[sdks.${sdkId}].${field} must be a list of non-empty strings`);
    } else if (new Set(value).size !== value.length) {
      errors.push(`[sdks.${sdkId}].${field} must not contain duplicates`);
    }
  }
  if (actual.classification !== 'sdk') errors.push(`[sdks.${sdkId}].classification must be "sdk"`);
  if (typeof actual.runtime_owner !== 'boolean') {
    errors.push(`[sdks.${sdkId}].runtime_owner must be a boolean`);
  }
  if (typeof actual.package_identity === 'string') {
    if (!actual.package_identity.includes(':')) {
      errors.push(`[sdks.${sdkId}].package_identity must include its registry kind`);
    } else if (seenPackageIdentities.has(actual.package_identity)) {
      errors.push(
        `[sdks.${sdkId}].package_identity duplicates [sdks.${seenPackageIdentities.get(
          actual.package_identity,
        )}] identity ${formatValue(actual.package_identity)}`,
      );
    }
    seenPackageIdentities.set(actual.package_identity, sdkId);
  }
  if (Array.isArray(actual.available_modes) && Array.isArray(actual.unsupported_modes)) {
    const overlap = actual.available_modes.filter((mode) => actual.unsupported_modes.includes(mode));
    if (overlap.length > 0) {
      errors.push(`[sdks.${sdkId}] lists modes as both available and unsupported: ${overlap.join(', ')}`);
    }
  }

  if (typeof actual.implementation_path === 'string') {
    if (seenImplementationPaths.has(actual.implementation_path)) {
      errors.push(
        `[sdks.${sdkId}].implementation_path duplicates [sdks.${seenImplementationPaths.get(
          actual.implementation_path,
        )}] path ${formatValue(actual.implementation_path)}`,
      );
    }
    seenImplementationPaths.set(actual.implementation_path, sdkId);
    requireDirectory(actual.implementation_path, sdkId, 'implementation_path');
  }
  if (typeof actual.documentation_path === 'string') {
    requireDirectory(actual.documentation_path, sdkId, 'documentation_path');
  }

  if (Array.isArray(actual.unsupported_modes) && actual.unsupported_modes.length > 0) {
    if (
      typeof actual.unsupported_mode_reason !== 'string' ||
      actual.unsupported_mode_reason.length === 0
    ) {
      errors.push(`[sdks.${sdkId}] must explain unsupported modes`);
    }
  }
}

const releaseSdkByPath = new Map();
for (const product of releaseSdkProducts) {
  if (releaseSdkByPath.has(product.path)) {
    errors.push(
      `release SDK products ${releaseSdkByPath.get(product.path).id} and ${product.id} share path ${formatValue(product.path)}`,
    );
  }
  releaseSdkByPath.set(product.path, product);
}
for (const product of releaseSdkProducts) {
  const sdkId = seenImplementationPaths.get(product.path);
  if (sdkId === undefined) {
    errors.push(`release SDK product ${product.id} at ${formatValue(product.path)} is missing from the SDK manifest`);
  }
}
for (const sdkId of sdkIds) {
  const actual = sdks[sdkId];
  if (!isPlainObject(actual) || typeof actual.implementation_path !== 'string') continue;
  const product = releaseSdkByPath.get(actual.implementation_path);
  if (product === undefined) {
    errors.push(
      `[sdks.${sdkId}] path ${formatValue(actual.implementation_path)} is not an SDK product in the release graph`,
    );
    continue;
  }
  if (
    Array.isArray(product.registry_packages) &&
    product.registry_packages.length > 0 &&
    !product.registry_packages.includes(releaseRegistryIdentity(actual.package_identity))
  ) {
    errors.push(
      `[sdks.${sdkId}].package_identity ${formatValue(actual.package_identity)} is not published by release SDK product ${product.id}`,
    );
  }
}

for (const sdkId of sdkIds) {
  const actual = sdks[sdkId];
  if (!isPlainObject(actual)) {
    continue;
  }
  for (const delegateField of ['delegates_apple_to', 'delegates_android_to']) {
    const delegate = actual[delegateField];
    if (delegate === undefined) {
      continue;
    }
    if (!sdkIds.includes(delegate)) {
      errors.push(`[sdks.${sdkId}].${delegateField} points at unknown SDK ${formatValue(delegate)}`);
      continue;
    }
    if (sdks[delegate]?.runtime_owner !== true) {
      errors.push(`[sdks.${sdkId}].${delegateField} must point at a runtime-owning SDK`);
    }
  }
  if (actual.runtime_owner === false && actual.delegates_apple_to === undefined && actual.delegates_android_to === undefined) {
    errors.push(`[sdks.${sdkId}] does not own a runtime and must declare at least one delegation`);
  }
}

if (sdks.typescript?.depends_on_rust_broker_helper === true) {
  if (typeof brokerHelperProduct !== 'string' || brokerHelperProduct.length === 0) {
    errors.push(`${jsPackagePath} must declare oliphaunt.brokerHelper`);
  } else if (sdks.typescript.broker_helper_product !== brokerHelperProduct) {
    errors.push(
      `[sdks.typescript].broker_helper_product must match ${jsPackagePath} oliphaunt.brokerHelper`,
    );
  }
  if (!(sdks.typescript.broker_helper_product in releaseProducts)) {
    errors.push('[sdks.typescript].broker_helper_product must identify a canonical release product');
  }
}

if (errors.length > 0) {
  for (const error of errors) {
    console.error(`check-sdk-manifest.mjs: ${error}`);
  }
  process.exit(1);
}

if (mode === '--json') {
  const summary = {
    schemaVersion: manifest.schema_version,
    sdkCount: sdkIds.length,
    sdks: Object.fromEntries(
      sdkIds.map((sdkId) => [
        sdkId,
        {
          packageIdentity: sdks[sdkId].package_identity,
          runtimeOwner: sdks[sdkId].runtime_owner,
          availableModes: sdks[sdkId].available_modes,
          unsupportedModes: sdks[sdkId].unsupported_modes,
          artifactResolution: sdks[sdkId].artifact_resolution,
          toolResolution: sdks[sdkId].tool_resolution,
          extensionResolution: sdks[sdkId].extension_resolution,
        },
      ]),
    ),
  };
  console.log(JSON.stringify(summary, null, 2));
} else if (mode === '--list') {
  for (const sdkId of sdkIds) {
    const sdk = sdks[sdkId];
    console.log(
      `${sdkId}: modes=${sdk.available_modes.join(',')} unsupported=${
        sdk.unsupported_modes.length > 0 ? sdk.unsupported_modes.join(',') : 'none'
      } artifact=${sdk.artifact_resolution} tools=${sdk.tool_resolution} extensions=${
        sdk.extension_resolution
      }`,
    );
  }
} else {
  console.log(`SDK manifest contract verified (${sdkIds.length} SDKs).`);
}
