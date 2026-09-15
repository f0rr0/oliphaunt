#!/usr/bin/env bun

import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  parseProperties,
  validNativeCacheKey,
} from '../../../database-resources/contracts/native-manifest.mts';

export const NATIVE_RUNTIME_RESOURCE_MANIFEST_KEYS = Object.freeze([
  'schema',
  'layout',
  'artifactRole',
  'catalogProfile',
  'clusterSeedTarget',
  'icuDataTreeSha256',
  'mode',
  'cacheKey',
  'selectedExtensions',
  'extensions',
  'runtimeFeatures',
  'sharedPreloadLibraries',
  'mobileStaticRegistryState',
  'mobileStaticRegistryRegistered',
  'mobileStaticRegistryPending',
  'nativeModuleStems',
  'mobileStaticRegistrySource',
]);

function requireTarget(target) {
  if (!['android-datum64', 'ios-datum64', 'macos-arm64'].includes(target)) {
    throw new Error(`unsupported native cluster-seed target ${JSON.stringify(target)}`);
  }
  return target;
}

export function bindNativeRuntimeResourceManifest(bytes, target) {
  requireTarget(target);
  const fields = parseProperties(bytes, 'native runtime resource manifest');
  const expectedKeys = new Set(NATIVE_RUNTIME_RESOURCE_MANIFEST_KEYS);
  if (
    fields.size !== expectedKeys.size ||
    [...fields.keys()].some((key) => !expectedKeys.has(key))
  ) {
    throw new Error('native runtime resource manifest must contain its exact canonical field set');
  }
  if (
    fields.get('schema') !== 'oliphaunt-runtime-resources-v1' ||
    fields.get('layout') !== 'postgres-runtime-files-v1' ||
    fields.get('artifactRole') !== 'runtime' ||
    fields.get('catalogProfile') !== '' ||
    !['', target].includes(fields.get('clusterSeedTarget')) ||
    fields.get('mode') !== 'native-direct' ||
    !validNativeCacheKey(fields.get('cacheKey') ?? '')
  ) {
    throw new Error('native runtime resource manifest has an incompatible native-direct contract');
  }
  const registryState = fields.get('mobileStaticRegistryState');
  const expectedSource =
    registryState === 'complete' ? 'static-registry/oliphaunt_static_registry.c' : '';
  if (fields.get('mobileStaticRegistrySource') !== expectedSource) {
    throw new Error('native runtime resource manifest has inconsistent mobileStaticRegistrySource');
  }
  fields.set('clusterSeedTarget', target);
  return Buffer.from(
    `${NATIVE_RUNTIME_RESOURCE_MANIFEST_KEYS.map((key) => `${key}=${fields.get(key)}`).join('\n')}\n`,
  );
}

export function validateNativeRuntimeCarrier(root, { target }) {
  const runtimeManifestPath = path.join(root, 'runtime/manifest.properties');
  const runtimeManifest = readFileSync(runtimeManifestPath);
  const canonicalRuntimeManifest = bindNativeRuntimeResourceManifest(runtimeManifest, target);
  if (!runtimeManifest.equals(canonicalRuntimeManifest)) {
    throw new Error(
      `${runtimeManifestPath}: runtime resource manifest is not canonical for ${target}`,
    );
  }
  return Object.freeze({ target });
}

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (
      !key?.startsWith('--') ||
      value === undefined ||
      value.startsWith('--') ||
      values.has(key)
    ) {
      throw new Error(
        'usage: native-runtime-carrier-contract.mts check --root DIR --target TARGET',
      );
    }
    values.set(key, value);
  }
  const root = values.get('--root');
  const target = values.get('--target');
  if (!root || !target || values.size !== 2) {
    throw new Error('usage: native-runtime-carrier-contract.mts check --root DIR --target TARGET');
  }
  return { root: path.resolve(root), target };
}

if (import.meta.main) {
  try {
    const check = process.argv[2] === 'check';
    const args = parseArgs(process.argv.slice(check ? 3 : 2));
    const result = validateNativeRuntimeCarrier(args.root, { target: args.target });
    if (result.target !== args.target) {
      throw new Error(`expected ${args.target}, got ${result.target}`);
    }
    console.log(`clusterSeedTarget=${result.target}`);
  } catch (error) {
    console.error(
      `native-runtime-carrier-contract.mts: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(2);
  }
}
