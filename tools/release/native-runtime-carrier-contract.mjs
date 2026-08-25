#!/usr/bin/env bun

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  NATIVE_CLUSTER_SEED_TARGETS,
  parseProperties,
  validNativeCacheKey,
  validateNativeClusterSeedDirectory,
} from "./native-cluster-seed-contract.mjs";

export const NATIVE_RUNTIME_CARRIER_SCHEMA = "oliphaunt-native-runtime-carrier-v1";
export const NATIVE_RUNTIME_RESOURCE_MANIFEST_KEYS = Object.freeze([
  "schema",
  "layout",
  "artifactRole",
  "catalogProfile",
  "clusterSeedTarget",
  "icuDataTreeSha256",
  "mode",
  "cacheKey",
  "selectedExtensions",
  "extensions",
  "runtimeFeatures",
  "sharedPreloadLibraries",
  "mobileStaticRegistryState",
  "mobileStaticRegistryRegistered",
  "mobileStaticRegistryPending",
  "nativeModuleStems",
  "mobileStaticRegistrySource",
]);

function requireTarget(target) {
  if (!NATIVE_CLUSTER_SEED_TARGETS.includes(target)) {
    throw new Error(`unsupported native cluster-seed target ${JSON.stringify(target)}`);
  }
  return target;
}

export function nativeRuntimeCarrierManifest(target) {
  requireTarget(target);
  return Buffer.from([
    `schema=${NATIVE_RUNTIME_CARRIER_SCHEMA}`,
    `clusterSeedTarget=${target}`,
    "clusterSeedRelativePath=cluster-seed",
    "icuClusterSeedRelativePath=cluster-seed-icu",
    "",
  ].join("\n"));
}

export function bindNativeRuntimeResourceManifest(bytes, target) {
  requireTarget(target);
  const fields = parseProperties(bytes, "native runtime resource manifest");
  const expectedKeys = new Set(NATIVE_RUNTIME_RESOURCE_MANIFEST_KEYS);
  if (fields.size !== expectedKeys.size
    || [...fields.keys()].some((key) => !expectedKeys.has(key))) {
    throw new Error("native runtime resource manifest must contain its exact canonical field set");
  }
  if (fields.get("schema") !== "oliphaunt-runtime-resources-v1"
    || fields.get("layout") !== "postgres-runtime-files-v1"
    || fields.get("artifactRole") !== "runtime"
    || fields.get("catalogProfile") !== ""
    || !["", target].includes(fields.get("clusterSeedTarget"))
    || fields.get("mode") !== "native-direct"
    || !validNativeCacheKey(fields.get("cacheKey") ?? "")) {
    throw new Error("native runtime resource manifest has an incompatible native-direct contract");
  }
  const registryState = fields.get("mobileStaticRegistryState");
  const expectedSource = registryState === "complete"
    ? "static-registry/oliphaunt_static_registry.c"
    : "";
  if (fields.get("mobileStaticRegistrySource") !== expectedSource) {
    throw new Error("native runtime resource manifest has inconsistent mobileStaticRegistrySource");
  }
  fields.set("clusterSeedTarget", target);
  return Buffer.from(`${NATIVE_RUNTIME_RESOURCE_MANIFEST_KEYS.map((key) => `${key}=${fields.get(key)}`).join("\n")}\n`);
}

export function validateNativeRuntimeCarrier(root, { icuData } = {}) {
  const manifestPath = path.join(root, "manifest.properties");
  const fields = parseProperties(readFileSync(manifestPath), manifestPath);
  if (fields.get("schema") !== NATIVE_RUNTIME_CARRIER_SCHEMA) {
    throw new Error(`${manifestPath}: unsupported schema`);
  }
  const target = fields.get("clusterSeedTarget");
  requireTarget(target);
  if (fields.size !== 4
    || fields.get("clusterSeedRelativePath") !== "cluster-seed"
    || fields.get("icuClusterSeedRelativePath") !== "cluster-seed-icu") {
    throw new Error(`${manifestPath}: single-target seed paths are invalid`);
  }
  const runtimeManifestPath = path.join(root, "runtime/manifest.properties");
  const runtimeManifest = readFileSync(runtimeManifestPath);
  const canonicalRuntimeManifest = bindNativeRuntimeResourceManifest(runtimeManifest, target);
  if (!runtimeManifest.equals(canonicalRuntimeManifest)) {
    throw new Error(`${runtimeManifestPath}: runtime resource manifest is not canonical for ${target}`);
  }
  validateNativeClusterSeedDirectory(path.join(root, "cluster-seed"), "standard", { target });
  validateNativeClusterSeedDirectory(path.join(root, "cluster-seed-icu"), "icu", { target, icuData });
  return Object.freeze({ target });
}

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined || value.startsWith("--") || values.has(key)) {
      throw new Error("usage: native-runtime-carrier-contract.mjs --root DIR --target TARGET --icu-data DIR");
    }
    values.set(key, value);
  }
  const root = values.get("--root");
  const target = values.get("--target");
  const icuData = values.get("--icu-data");
  if (!root || !icuData || !target || values.size !== 3) {
    throw new Error("usage: native-runtime-carrier-contract.mjs --root DIR --target TARGET --icu-data DIR");
  }
  return { root: path.resolve(root), target, icuData: path.resolve(icuData) };
}

if (import.meta.main) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const manifest = nativeRuntimeCarrierManifest(args.target);
    writeFileSync(path.join(args.root, "manifest.properties"), manifest);
    const result = validateNativeRuntimeCarrier(args.root, { icuData: args.icuData });
    console.log(`clusterSeedTarget=${result.target}`);
  } catch (error) {
    console.error(`native-runtime-carrier-contract.mjs: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }
}
