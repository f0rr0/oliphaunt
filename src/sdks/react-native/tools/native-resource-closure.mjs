import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const SHA256 = /^[0-9a-f]{64}$/u;
const PORTABLE_ID = /^[A-Za-z0-9._-]{1,128}$/u;

function validCacheKey(value) {
  return PORTABLE_ID.test(value) && value !== "." && value !== "..";
}
const RUNTIME_SCHEMA = "oliphaunt-runtime-resources-v1";
const TARGET = "ios-datum64";
const COMPATIBILITY_KEY = "native-pg18-ios-datum64-v1";
const RESOURCE_FIELDS = new Set([
  "schema", "layout", "artifactRole", "catalogProfile", "clusterSeedTarget",
  "icuDataTreeSha256", "mode", "cacheKey",
  "selectedExtensions", "extensions", "runtimeFeatures", "sharedPreloadLibraries",
  "mobileStaticRegistryState", "mobileStaticRegistryRegistered", "mobileStaticRegistryPending",
  "nativeModuleStems", "mobileStaticRegistrySource",
]);
const CLUSTER_SEED_FIELDS = new Set([
  "schema", "layout", "artifactRole", "catalogProfile", "postgresMajor", "physicalFormat",
  "target", "compatibilityKey", "initialSuperuser", "runtimeFeatures", "icuDataVersion",
  "icuDataForm", "icuDataTreeSha256", "cacheKey",
]);

export function parseProperties(text, source) {
  const values = new Map();
  for (const [index, line] of text.split(/\r?\n/u).entries()) {
    if (!line) continue;
    const separator = line.indexOf("=");
    if (separator < 1) throw new Error(`${source}:${index + 1} is not key=value`);
    const key = line.slice(0, separator);
    if (values.has(key)) throw new Error(`${source}:${index + 1} repeats ${key}`);
    values.set(key, line.slice(separator + 1));
  }
  return values;
}

export function requireProperty(values, key, expected, source) {
  if (values.get(key) !== expected) {
    throw new Error(
      `${source} must declare ${key}=${expected}; got ${values.get(key) ?? "<missing>"}`,
    );
  }
}

async function readProperties(file) {
  return parseProperties(await fs.readFile(file, "utf8"), file);
}

function requireResourceFields(values, source) {
  const missing = [...RESOURCE_FIELDS].filter((key) => !values.has(key)).sort();
  const unsupported = [...values.keys()].filter((key) => !RESOURCE_FIELDS.has(key)).sort();
  if (missing.length > 0 || unsupported.length > 0) {
    throw new Error(
      `${source} must contain its exact canonical runtime fields; missing=${missing.join(",")}; unsupported=${unsupported.join(",")}`,
    );
  }
}

export async function logicalTreeSha256(root) {
  const files = [];
  async function visit(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      const metadata = await fs.lstat(file);
      if (metadata.isSymbolicLink()) throw new Error(`logical tree contains a symlink: ${file}`);
      if (metadata.isDirectory()) await visit(file);
      else if (metadata.isFile()) files.push(file);
      else throw new Error(`logical tree contains a special file: ${file}`);
    }
  }
  await visit(root);
  files.sort((left, right) => Buffer.compare(
    Buffer.from(path.relative(root, left).split(path.sep).join("/")),
    Buffer.from(path.relative(root, right).split(path.sep).join("/")),
  ));
  const digest = createHash("sha256");
  for (const file of files) {
    const relative = path.relative(root, file).split(path.sep).join("/");
    const bytes = await fs.readFile(file);
    digest.update(relative);
    digest.update(Buffer.of(0));
    digest.update(String(bytes.length));
    digest.update(Buffer.of(0));
    digest.update(bytes);
    digest.update("\n");
  }
  return digest.digest("hex");
}

async function validateClusterSeed(root, profile) {
  const source = path.join(root, "manifest.properties");
  await Promise.all([
    fs.access(path.join(root, "files/PG_VERSION")),
    fs.access(path.join(root, "files/global/pg_control")),
  ]);
  const values = await readProperties(source);
  if (values.size !== CLUSTER_SEED_FIELDS.size
      || [...CLUSTER_SEED_FIELDS].some((key) => !values.has(key))) {
    throw new Error(`${source} must contain exactly the canonical cluster-seed fields`);
  }
  requireProperty(values, "schema", RUNTIME_SCHEMA, source);
  requireProperty(values, "layout", "oliphaunt-cluster-seed-v1", source);
  requireProperty(values, "artifactRole", `cluster-seed-${profile}`, source);
  requireProperty(values, "catalogProfile", profile, source);
  requireProperty(values, "postgresMajor", "18", source);
  requireProperty(values, "physicalFormat", "native-pg18-v1", source);
  requireProperty(values, "target", TARGET, source);
  requireProperty(values, "compatibilityKey", COMPATIBILITY_KEY, source);
  requireProperty(values, "initialSuperuser", "postgres", source);
  requireProperty(values, "runtimeFeatures", profile === "icu" ? "icu" : "", source);
  requireProperty(values, "icuDataVersion", profile === "icu" ? "76.1" : "", source);
  requireProperty(values, "icuDataForm", profile === "icu" ? "files-le" : "", source);
  const digest = values.get("icuDataTreeSha256") ?? "";
  if (!validCacheKey(values.get("cacheKey") ?? "")) {
    throw new Error(`${source} has an invalid cluster-seed cache key`);
  }
  if (profile === "icu" ? !SHA256.test(digest) : digest !== "") {
    throw new Error(`${source} has an invalid ICU data identity`);
  }
  return { digest, values };
}

export async function validateNativeRuntimeClosure(root, { integrated } = {}) {
  const receiptSource = path.join(root, "manifest.properties");
  const receipt = await readProperties(receiptSource);
  const receiptFields = new Set([
    "schema", "clusterSeedTarget", "clusterSeedRelativePath", "icuClusterSeedRelativePath",
  ]);
  if (receipt.size !== receiptFields.size || [...receiptFields].some((key) => !receipt.has(key))) {
    throw new Error(`${receiptSource} must contain exactly the canonical runtime-carrier fields`);
  }
  requireProperty(receipt, "schema", "oliphaunt-native-runtime-carrier-v1", receiptSource);
  requireProperty(receipt, "clusterSeedTarget", TARGET, receiptSource);
  requireProperty(receipt, "clusterSeedRelativePath", "cluster-seed", receiptSource);
  requireProperty(receipt, "icuClusterSeedRelativePath", "cluster-seed-icu", receiptSource);
  const source = path.join(root, "runtime/manifest.properties");
  const runtime = await readProperties(source);
  requireResourceFields(runtime, source);
  requireProperty(runtime, "schema", RUNTIME_SCHEMA, source);
  requireProperty(runtime, "layout", "postgres-runtime-files-v1", source);
  requireProperty(runtime, "artifactRole", "runtime", source);
  requireProperty(runtime, "catalogProfile", "", source);
  requireProperty(runtime, "clusterSeedTarget", TARGET, source);
  requireProperty(runtime, "mode", "native-direct", source);
  if (!validCacheKey(runtime.get("cacheKey") ?? "")) {
    throw new Error(`${source} has an invalid runtime cache key`);
  }
  const expectedRegistrySource = runtime.get("mobileStaticRegistryState") === "complete"
    ? "static-registry/oliphaunt_static_registry.c"
    : "";
  requireProperty(runtime, "mobileStaticRegistrySource", expectedRegistrySource, source);
  await validateClusterSeed(path.join(root, "cluster-seed"), "standard");
  const icu = await validateClusterSeed(path.join(root, "cluster-seed-icu"), "icu");
  const features = new Set((runtime.get("runtimeFeatures") ?? "").split(",").filter(Boolean));
  integrated ??= features.has("icu");
  if ([...features].some((feature) => feature !== "icu") || features.has("icu") !== integrated) {
    throw new Error(`${source} has inconsistent runtimeFeatures for the selected catalog profile`);
  }
  const runtimeDigest = runtime.get("icuDataTreeSha256") ?? "";
  if (integrated) {
    if (runtimeDigest !== icu.digest) {
      throw new Error(`${source} ICU identity does not match cluster-seed-icu`);
    }
    const data = path.join(root, "runtime/files/share/icu");
    if (await logicalTreeSha256(data) !== runtimeDigest) {
      throw new Error(`${source} ICU identity does not match runtime/files/share/icu`);
    }
  } else if (runtimeDigest !== "") {
    throw new Error(`${source} selects ICU data without the ICU runtime feature`);
  }
  return { icuDigest: icu.digest, runtime };
}

export async function validateIcuDataCarrier(root) {
  const source = path.join(root, "manifest.properties");
  const values = await readProperties(source);
  const expected = new Set([
    "schema", "artifactRole", "icuDataVersion", "icuDataForm", "icuDataTreeSha256",
  ]);
  if (values.size !== expected.size || [...expected].some((key) => !values.has(key))) {
    throw new Error(`${source} must contain exactly the canonical ICU data fields`);
  }
  requireProperty(values, "schema", "oliphaunt-icu-data-v1", source);
  requireProperty(values, "artifactRole", "icu-data", source);
  requireProperty(values, "icuDataVersion", "76.1", source);
  requireProperty(values, "icuDataForm", "files-le", source);
  const data = path.join(root, "share/icu");
  const digest = await logicalTreeSha256(data);
  requireProperty(values, "icuDataTreeSha256", digest, source);
  return { data, digest };
}
