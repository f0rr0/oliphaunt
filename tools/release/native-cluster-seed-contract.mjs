#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CONTRACT = JSON.parse(readFileSync(
  new URL("../../src/shared/cluster-seed-contract/contract.json", import.meta.url),
  "utf8",
));
const SHA256 = /^[0-9a-f]{64}$/u;
const CACHE_KEY = new RegExp(CONTRACT.manifests.native.cacheKeyPattern, "u");
const DISALLOWED_CACHE_KEYS = new Set(CONTRACT.manifests.native.cacheKeyDisallowedValues);

export function validNativeCacheKey(value) {
  return CACHE_KEY.test(value) && !DISALLOWED_CACHE_KEYS.has(value);
}

export const NATIVE_CLUSTER_SEED_TARGETS = Object.freeze(
  Object.keys(CONTRACT.compatibilityKeys.native).sort(),
);

export const NATIVE_CLUSTER_SEED_MANIFEST_KEYS = Object.freeze([
  "schema",
  "layout",
  "artifactRole",
  "catalogProfile",
  "target",
  "postgresMajor",
  "physicalFormat",
  "compatibilityKey",
  "initialSuperuser",
  "icuDataVersion",
  "icuDataForm",
  "icuDataTreeSha256",
  "runtimeFeatures",
  "cacheKey",
]);

export function nativeClusterSeedCompatibilityKey(target) {
  const key = CONTRACT.compatibilityKeys.native[target];
  if (typeof key !== "string") {
    throw new Error(`unsupported native cluster-seed target ${JSON.stringify(target)}`);
  }
  return key;
}

export function bindNativeClusterSeedManifest(bytes, target, profile) {
  const source = parseProperties(bytes, "native cluster seed producer manifest");
  const profileContract = CONTRACT.profiles[profile];
  if (profileContract === undefined) {
    throw new Error(`native cluster seed producer manifest: unsupported profile ${profile}`);
  }
  const expectedSource = new Map([
    ["schema", CONTRACT.manifests.native.schema],
    ["layout", CONTRACT.manifests.native.layout],
    ["artifactRole", profileContract.artifactRole],
    ["catalogProfile", profile],
    ["postgresMajor", "18"],
    ["physicalFormat", CONTRACT.physicalFormats.native],
    ["initialSuperuser", "postgres"],
    ["icuDataVersion", profile === "icu" ? CONTRACT.icu.dataVersion : ""],
    ["icuDataForm", profile === "icu" ? CONTRACT.icu.dataForm : ""],
    ["runtimeFeatures", profileContract.requiredRuntimeFeatures.join(",")],
  ]);
  const expectedSourceKeys = new Set([
    ...expectedSource.keys(),
    "icuDataTreeSha256",
    "cacheKey",
  ]);
  if (source.size !== expectedSourceKeys.size
    || [...source.keys()].some((key) => !expectedSourceKeys.has(key))) {
    throw new Error("native cluster seed producer manifest: expected the exact unbound producer field set");
  }
  for (const [key, value] of expectedSource) {
    if (source.get(key) !== value) {
      throw new Error(`native cluster seed producer manifest: ${key} must be ${JSON.stringify(value)}`);
    }
  }
  const cacheKey = source.get("cacheKey");
  if (typeof cacheKey !== "string" || !validNativeCacheKey(cacheKey)) {
    throw new Error("native cluster seed producer manifest: cacheKey must be a portable identifier");
  }
  const values = new Map([
    ...expectedSource,
    ["target", target],
    ["compatibilityKey", nativeClusterSeedCompatibilityKey(target)],
    ["icuDataTreeSha256", source.get("icuDataTreeSha256") ?? ""],
    ["cacheKey", cacheKey],
  ]);
  return Buffer.from(`${NATIVE_CLUSTER_SEED_MANIFEST_KEYS.map((key) => `${key}=${values.get(key)}`).join("\n")}\n`);
}

export function parseProperties(bytes, label) {
  const text = Buffer.from(bytes).toString("utf8");
  if (!Buffer.from(text, "utf8").equals(Buffer.from(bytes))) {
    throw new Error(`${label} is not canonical UTF-8`);
  }
  const values = new Map();
  for (const [index, line] of text.split(/\r?\n/u).entries()) {
    if (line.length === 0) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) throw new Error(`${label}:${index + 1} is not key=value`);
    const key = line.slice(0, separator);
    if (values.has(key)) throw new Error(`${label}:${index + 1} repeats ${key}`);
    values.set(key, line.slice(separator + 1));
  }
  return values;
}

export function validateNativeClusterSeedManifest(bytes, profile, options = {}) {
  const label = options.label ?? `${profile} native cluster seed manifest`;
  const target = options.target;
  const compatibilityKey = nativeClusterSeedCompatibilityKey(target);
  const profileContract = CONTRACT.profiles[profile];
  if (profileContract === undefined) throw new Error(`${label}: unsupported profile ${profile}`);
  const values = parseProperties(bytes, label);
  const expected = new Map([
    ["schema", CONTRACT.manifests.native.schema],
    ["layout", CONTRACT.manifests.native.layout],
    ["artifactRole", profileContract.artifactRole],
    ["catalogProfile", profile],
    ["postgresMajor", "18"],
    ["physicalFormat", CONTRACT.physicalFormats.native],
    ["target", target],
    ["compatibilityKey", compatibilityKey],
    ["initialSuperuser", "postgres"],
    ["runtimeFeatures", profileContract.requiredRuntimeFeatures.join(",")],
    ["icuDataVersion", profile === "icu" ? CONTRACT.icu.dataVersion : ""],
    ["icuDataForm", profile === "icu" ? CONTRACT.icu.dataForm : ""],
    ["icuDataTreeSha256", profile === "icu" ? options.icuDataTreeSha256 : ""],
  ]);
  if (values.size !== NATIVE_CLUSTER_SEED_MANIFEST_KEYS.length
    || NATIVE_CLUSTER_SEED_MANIFEST_KEYS.some((key) => !values.has(key))) {
    throw new Error(`${label}: fields must be exactly ${NATIVE_CLUSTER_SEED_MANIFEST_KEYS.join(",")}`);
  }
  if (!validNativeCacheKey(values.get("cacheKey") ?? "")) {
    throw new Error(`${label}: cacheKey must be a portable identifier`);
  }
  if (profile === "icu" && !SHA256.test(options.icuDataTreeSha256 ?? "")) {
    throw new Error(`${label}: requires the exact lowercase ICU data tree SHA-256`);
  }
  for (const [key, value] of expected) {
    if (values.get(key) !== value) {
      throw new Error(`${label}: ${key} must be ${JSON.stringify(value)}, got ${JSON.stringify(values.get(key))}`);
    }
  }
  return values;
}

export function logicalTreeSha256(rows) {
  const normalized = [...rows].map(({ path: relative, bytes }) => {
    if (typeof relative !== "string" || relative.length === 0 || relative.includes("\0")) {
      throw new Error(`logical tree contains an invalid path: ${JSON.stringify(relative)}`);
    }
    const normalizedPath = relative.replaceAll("\\", "/");
    const components = normalizedPath.split("/");
    if (normalizedPath.startsWith("/")
      || components.some((component) => component.length === 0 || component === "." || component === "..")) {
      throw new Error(`logical tree contains an unsafe path: ${JSON.stringify(relative)}`);
    }
    return { path: normalizedPath, bytes: Buffer.from(bytes) };
  });
  normalized.sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
  for (let index = 1; index < normalized.length; index += 1) {
    if (normalized[index - 1].path === normalized[index].path) {
      throw new Error(`logical tree repeats path ${JSON.stringify(normalized[index].path)}`);
    }
  }
  const digest = createHash("sha256");
  for (const row of normalized) {
    digest.update(row.path);
    digest.update(Buffer.of(0));
    digest.update(String(row.bytes.length));
    digest.update(Buffer.of(0));
    digest.update(row.bytes);
    digest.update("\n");
  }
  return digest.digest("hex");
}

export function filesystemTreeRows(root) {
  const absoluteRoot = path.resolve(root);
  const rows = [];
  visitRegularFileTree(absoluteRoot, "logical tree", (file) => {
    rows.push({
      path: path.relative(absoluteRoot, file).split(path.sep).join("/"),
      bytes: readFileSync(file),
    });
  });
  return rows;
}

function visitRegularFileTree(root, label, onFile) {
  const visit = (entry) => {
    const metadata = lstatSync(entry);
    if (metadata.isSymbolicLink()) throw new Error(`${label} contains a symlink: ${entry}`);
    if (metadata.isFile()) {
      onFile(entry);
      return;
    }
    if (!metadata.isDirectory()) throw new Error(`${label} contains a special file: ${entry}`);
    for (const name of readdirSync(entry).sort()) visit(path.join(entry, name));
  };
  visit(root);
}

export function validateNativeClusterSeedDirectory(seed, profile, options = {}) {
  for (const relative of [
    "files",
    "files/global",
    "files/pg_wal",
    "files/PG_VERSION",
    "files/global/pg_control",
    "manifest.properties",
  ]) {
    const file = path.join(seed, ...relative.split("/"));
    const expectedDirectory = relative === "files"
      || relative === "files/global"
      || relative === "files/pg_wal";
    const metadata = lstatSync(file);
    if (metadata.isSymbolicLink()
      || (expectedDirectory ? !metadata.isDirectory() : !metadata.isFile())) {
      throw new Error(`${seed} has an unsafe or missing ${relative}`);
    }
  }
  const pgVersion = readFileSync(path.join(seed, "files/PG_VERSION"), "utf8").trim();
  if (pgVersion !== "18") throw new Error(`${seed} has PostgreSQL ${JSON.stringify(pgVersion)}, expected 18`);
  if (lstatSync(path.join(seed, "files/global/pg_control")).size === 0) {
    throw new Error(`${seed} has an empty files/global/pg_control`);
  }
  const files = path.join(seed, "files");
  const rootEntries = new Set(readdirSync(files));
  for (const transient of ["postmaster.pid", "postmaster.opts"]) {
    if (rootEntries.has(transient)) throw new Error(`${seed} contains transient ${transient}`);
  }
  visitRegularFileTree(files, "native cluster seed", () => {});
  const icuDataTreeSha256 = options.icuData === undefined
    ? undefined
    : logicalTreeSha256(filesystemTreeRows(options.icuData));
  validateNativeClusterSeedManifest(readFileSync(path.join(seed, "manifest.properties")), profile, {
    target: options.target,
    icuDataTreeSha256,
    label: path.join(seed, "manifest.properties"),
  });
  return { icuDataTreeSha256 };
}

function main(args) {
  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error("usage: native-cluster-seed-contract.mjs --profile standard|icu --target TARGET --seed DIR [--icu-data DIR]");
    }
    values.set(key.slice(2), value);
  }
  const profile = values.get("profile");
  const target = values.get("target");
  const seed = values.get("seed");
  if (!(profile === "standard" || profile === "icu") || target === undefined || seed === undefined) {
    throw new Error("usage: native-cluster-seed-contract.mjs --profile standard|icu --target TARGET --seed DIR [--icu-data DIR]");
  }
  const icuData = values.get("icu-data");
  const { icuDataTreeSha256 } = validateNativeClusterSeedDirectory(seed, profile, { icuData, target });
  process.stdout.write(`profile=${profile}\ntarget=${target}\nicuDataTreeSha256=${icuDataTreeSha256 ?? ""}\n`);
}

if (import.meta.main) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`native-cluster-seed-contract.mjs: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }
}
