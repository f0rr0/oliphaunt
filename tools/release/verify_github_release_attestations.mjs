#!/usr/bin/env bun
// Verify GitHub artifact attestations for asset-backed product releases.

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { runMoon } from "../policy/moon.mjs";
import { expectedAssets as expectedDesktopAssets } from "./release-artifact-targets.mjs";
import { currentVersion } from "./product-version.mjs";

const ROOT = path.resolve(import.meta.dir, "../..");
const PREFIX = "verify_github_release_attestations.mjs";
const GITHUB_API = process.env.GITHUB_API ?? "https://api.github.com";
const MAX_GITHUB_JSON_BYTES = 8 * 1024 * 1024;
const MAX_CONTROL_ASSET_BYTES = 8 * 1024 * 1024;
const MAX_RELEASE_ASSET_BYTES = 2 * 1024 * 1024 * 1024;
const GITHUB_API_TIMEOUT_MS = 30_000;
const RELEASE_ASSET_TIMEOUT_MS = 10 * 60 * 1000;

const BASE_ASSET_BACKED_PRODUCTS = new Set([
  "liboliphaunt-native",
  "liboliphaunt-wasix",
  "oliphaunt-broker",
  "oliphaunt-node-direct",
]);

const DESKTOP_TARGETS = new Set([
  "linux-arm64-gnu",
  "linux-x64-gnu",
  "macos-arm64",
  "windows-x64-msvc",
]);

const PUBLIC_EXTENSION_RELEASE_MANIFEST_KEYS = new Set([
  "schema",
  "product",
  "version",
  "sqlName",
  "extensionClass",
  "versioning",
  "sourceIdentity",
  "compatibility",
  "createsExtension",
  "dependencies",
  "nativeDependencies",
  "nativeModuleStem",
  "iosNativeDependencies",
  "iosRegistration",
  "sharedPreloadLibraries",
  "mobileReleaseReady",
  "desktopReleaseReady",
  "assets",
]);

const PUBLIC_EXTENSION_RELEASE_ASSET_KEYS = new Set([
  "name",
  "family",
  "target",
  "kind",
  "identity",
  "sha256",
  "bytes",
]);

function fail(message) {
  console.error(`${PREFIX}: ${message}`);
  process.exit(1);
}

function rel(file) {
  return path.relative(ROOT, file).split(path.sep).join("/");
}

async function readJson(file) {
  try {
    const value = JSON.parse(await fs.readFile(file, "utf8"));
    if (value === null || Array.isArray(value) || typeof value !== "object") {
      fail(`${rel(file)} must contain a JSON object`);
    }
    return value;
  } catch (error) {
    fail(`failed to read ${rel(file)}: ${error.message}`);
  }
}

async function readToml(file) {
  try {
    const value = Bun.TOML.parse(await fs.readFile(file, "utf8"));
    if (value === null || Array.isArray(value) || typeof value !== "object") {
      fail(`${rel(file)} must contain a TOML table`);
    }
    return value;
  } catch (error) {
    fail(`failed to read ${rel(file)}: ${error.message}`);
  }
}

let releaseConfigCache;
async function releaseConfig() {
  releaseConfigCache ??= readJson(path.join(ROOT, "release-please-config.json"));
  return releaseConfigCache;
}

let packagePathsCache;
async function packagePathsByProduct() {
  if (packagePathsCache !== undefined) {
    return packagePathsCache;
  }
  const config = await releaseConfig();
  const packages = config.packages;
  if (packages === null || Array.isArray(packages) || typeof packages !== "object") {
    fail("release-please-config.json must define packages");
  }
  const paths = new Map();
  for (const [packagePath, packageConfig] of Object.entries(packages)) {
    const component = packageConfig?.component;
    if (typeof component !== "string" || component.length === 0) {
      fail(`${packagePath}.component must be a non-empty string`);
    }
    if (paths.has(component)) {
      fail(`duplicate release-please component ${component}`);
    }
    paths.set(component, packagePath);
  }
  packagePathsCache = paths;
  return paths;
}

async function packagePath(product) {
  const paths = await packagePathsByProduct();
  const value = paths.get(product);
  if (typeof value !== "string" || value.length === 0) {
    fail(`unknown release product ${JSON.stringify(product)}`);
  }
  return value;
}

async function productConfig(product) {
  const productPath = await packagePath(product);
  const metadata = await readToml(path.join(ROOT, productPath, "release.toml"));
  if (metadata.id !== product) {
    fail(`${productPath}/release.toml must declare id = ${JSON.stringify(product)}`);
  }
  return metadata;
}

async function exactExtensionProducts() {
  const paths = await packagePathsByProduct();
  const products = [];
  for (const product of paths.keys()) {
    const config = await productConfig(product);
    if (config.kind === "exact-extension-artifact") {
      products.push(product);
    }
  }
  return products.sort(compareText);
}

async function assetBackedProducts() {
  return new Set([...BASE_ASSET_BACKED_PRODUCTS, ...(await exactExtensionProducts())]);
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function tagPrefix(product) {
  const config = await releaseConfig();
  if (config["include-v-in-tag"] !== true) {
    fail("release-please must include v in product tags");
  }
  if (config["tag-separator"] !== "-") {
    fail("release-please tag-separator must be '-'");
  }
  return `${product}-v`;
}

async function productTag(product, version) {
  return `${await tagPrefix(product)}${version}`;
}

function repository() {
  return process.env.GITHUB_REPOSITORY || "f0rr0/oliphaunt";
}

let moonReleaseProductsCache;
function moonReleaseProducts() {
  if (moonReleaseProductsCache !== undefined) {
    return moonReleaseProductsCache;
  }
  const value = JSON.parse(runMoon(["query", "projects"]));
  if (!Array.isArray(value.projects)) {
    fail("moon query projects did not return a projects array");
  }
  const products = new Map();
  for (const project of value.projects) {
    const id = project?.id;
    const tags = project?.config?.tags;
    const release = project?.config?.project?.metadata?.release;
    if (!Array.isArray(tags) || !tags.includes("release-product")) {
      continue;
    }
    if (typeof id !== "string" || release === null || typeof release !== "object") {
      fail("Moon release metadata returned an invalid product row");
    }
    if (release.component !== id) {
      fail(`Moon release product ${id} release.component must match project id`);
    }
    products.set(id, release);
  }
  moonReleaseProductsCache = products;
  return products;
}

function publishedTargets(product, preset) {
  const release = moonReleaseProducts().get(product);
  if (!release) {
    fail(`Moon release metadata does not include ${product}`);
  }
  const artifactTargets = release.artifactTargets;
  if (
    artifactTargets === null ||
    typeof artifactTargets !== "object" ||
    artifactTargets.preset !== preset
  ) {
    fail(`Moon release metadata for ${product} must use artifactTargets preset ${preset}`);
  }
  const targets = artifactTargets.publishedTargets;
  if (!Array.isArray(targets) || !targets.every((target) => typeof target === "string" && target)) {
    fail(`Moon release metadata for ${product} must declare publishedTargets`);
  }
  return [...targets].sort(compareText);
}

function archiveSuffix(target) {
  return target === "windows-x64-msvc" ? "zip" : "tar.gz";
}

function liboliphauntNativeAssets(version) {
  const targets = publishedTargets("liboliphaunt-native", "liboliphaunt-native");
  const assets = targets.map((target) => `liboliphaunt-${version}-${target}.${archiveSuffix(target)}`);
  for (const target of targets.filter((target) => DESKTOP_TARGETS.has(target))) {
    assets.push(`oliphaunt-tools-${version}-${target}.${archiveSuffix(target)}`);
  }
  assets.push(
    `liboliphaunt-${version}-apple-spm-xcframework.zip`,
    `liboliphaunt-${version}-runtime-resources.tar.gz`,
    `liboliphaunt-${version}-icu-data.tar.gz`,
    `liboliphaunt-${version}-package-size.tsv`,
    `liboliphaunt-${version}-release-assets.sha256`,
  );
  return [...new Set(assets)].sort(compareText);
}

function liboliphauntWasixAssets(version) {
  const targets = publishedTargets("liboliphaunt-wasix", "liboliphaunt-wasix");
  if (!targets.includes("portable")) {
    fail("Moon release metadata for liboliphaunt-wasix must publish portable");
  }
  const assets = [
    `liboliphaunt-wasix-${version}-runtime-portable.tar.zst`,
    `liboliphaunt-wasix-${version}-icu-data.tar.zst`,
    `liboliphaunt-wasix-${version}-release-assets.sha256`,
  ];
  for (const target of targets.filter((target) => target !== "portable")) {
    assets.push(`liboliphaunt-wasix-${version}-runtime-aot-${target}.tar.zst`);
  }
  return assets.sort(compareText);
}

async function expectedExtensionAssets(product, version) {
  const releaseAssetRoot = path.join(ROOT, "target/extension-artifacts", product, "release-assets");
  const manifestPath = path.join(releaseAssetRoot, `${product}-${version}-manifest.json`);
  const manifest = await readJson(manifestPath);
  validateExtensionManifest(product, version, manifest, manifestPath);
  const names = manifest.assets.map((asset) => asset.name);
  names.push(
    `${product}-${version}-manifest.json`,
    `${product}-${version}-manifest.properties`,
    `${product}-${version}-release-assets.sha256`,
  );
  return [...new Set(names)].sort(compareText);
}

async function expectedAssets(product, version) {
  const config = await productConfig(product);
  if (config.kind === "exact-extension-artifact") {
    return expectedExtensionAssets(product, version);
  }
  if (product === "liboliphaunt-native") {
    return liboliphauntNativeAssets(version);
  }
  if (product === "liboliphaunt-wasix") {
    return liboliphauntWasixAssets(version);
  }
  if (product === "oliphaunt-broker") {
    return expectedDesktopAssets(product, "broker-helper", version, PREFIX);
  }
  if (product === "oliphaunt-node-direct") {
    return expectedDesktopAssets(product, "node-direct-addon", version, PREFIX);
  }
  fail(`asset expectation is not defined for ${product}`);
}

function authHeaders(accept) {
  const headers = {
    Accept: accept,
    "User-Agent": "oliphaunt-release-check",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

function responseContentLength(response, context) {
  const raw = response.headers?.get?.("content-length");
  if (raw === null || raw === undefined) return null;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${context} returned an invalid Content-Length`);
  }
  return value;
}

async function boundedResponseBytes(response, maximum, context) {
  const declared = responseContentLength(response, context);
  if (declared !== null && declared > maximum) {
    await response.body?.cancel?.().catch(() => {});
    throw new Error(`${context} exceeds ${maximum} bytes`);
  }
  const reader = response.body?.getReader?.();
  if (reader === undefined) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maximum) throw new Error(`${context} exceeds ${maximum} bytes`);
    return bytes;
  }
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) {
        await reader.cancel().catch(() => {});
        throw new Error(`${context} exceeds ${maximum} bytes`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return new Uint8Array(Buffer.concat(chunks, size));
}

async function exactResponseProof(response, expectedSize, context) {
  const declared = responseContentLength(response, context);
  if (declared !== null && declared !== expectedSize) {
    await response.body?.cancel?.().catch(() => {});
    throw new Error(`${context} Content-Length ${declared} does not match expected size ${expectedSize}`);
  }
  const hash = createHash("sha256");
  let size = 0;
  const reader = response.body?.getReader?.();
  if (reader === undefined) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    size = bytes.byteLength;
    if (size > expectedSize) throw new Error(`${context} exceeds expected size ${expectedSize}`);
    hash.update(bytes);
  } else {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > expectedSize) {
          await reader.cancel().catch(() => {});
          throw new Error(`${context} exceeds expected size ${expectedSize}`);
        }
        hash.update(value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  if (size !== expectedSize) {
    throw new Error(`${context} size ${size} does not match expected size ${expectedSize}`);
  }
  return { bytes: size, sha256: hash.digest("hex") };
}

function releaseAssetApiUrl(rawUrl, name) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`GitHub release asset ${name} has an invalid API download URL`);
  }
  const api = new URL(GITHUB_API);
  if (url.protocol !== "https:" || url.origin !== api.origin) {
    throw new Error(`GitHub release asset ${name} API download URL must use ${api.origin}`);
  }
  return url;
}

function expectedAssetSize(value, name, maximum = MAX_RELEASE_ASSET_BYTES) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new Error(`GitHub release asset ${name} has invalid size ${JSON.stringify(value)}`);
  }
  return value;
}

export async function requestBoundedGithubJson(url, {
  fetchImpl = fetch,
  timeoutMs = GITHUB_API_TIMEOUT_MS,
} = {}) {
  const response = await fetchImpl(url, {
    headers: authHeaders("application/vnd.github+json"),
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    await response.body?.cancel?.().catch(() => {});
    throw new Error(`GitHub API returned HTTP ${response.status} for ${url}`);
  }
  const bytes = await boundedResponseBytes(response, MAX_GITHUB_JSON_BYTES, "GitHub API response");
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    throw new Error(`GitHub API returned invalid JSON for ${url}: ${error.message}`);
  }
}

export async function requestReleaseControlBytes(url, name, expectedSize, {
  fetchImpl = fetch,
  timeoutMs = RELEASE_ASSET_TIMEOUT_MS,
} = {}) {
  const size = expectedAssetSize(expectedSize, name, MAX_CONTROL_ASSET_BYTES);
  const response = await fetchImpl(releaseAssetApiUrl(url, name), {
    headers: authHeaders("application/octet-stream"),
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    await response.body?.cancel?.().catch(() => {});
    throw new Error(`GitHub asset download returned HTTP ${response.status} for ${name}`);
  }
  const bytes = await boundedResponseBytes(response, size, `GitHub release asset ${name}`);
  if (bytes.byteLength !== size) {
    throw new Error(`GitHub release asset ${name} size ${bytes.byteLength} does not match expected size ${size}`);
  }
  return bytes;
}

export async function requestReleaseAssetProof(url, name, expectedSize, {
  fetchImpl = fetch,
  timeoutMs = RELEASE_ASSET_TIMEOUT_MS,
} = {}) {
  const size = expectedAssetSize(expectedSize, name);
  const response = await fetchImpl(releaseAssetApiUrl(url, name), {
    headers: authHeaders("application/octet-stream"),
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    await response.body?.cancel?.().catch(() => {});
    throw new Error(`GitHub asset download returned HTTP ${response.status} for ${name}`);
  }
  return exactResponseProof(response, size, `GitHub release asset ${name}`);
}

async function githubJson(url) {
  try {
    return await requestBoundedGithubJson(url);
  } catch (error) {
    fail(`failed to query GitHub release URL ${url}: ${error.message}`);
  }
}

async function releaseAssets(repo, tag) {
  const repoPath = encodeURIComponent(repo).replaceAll("%2F", "/");
  const tagPath = encodeURIComponent(tag);
  const url = `${GITHUB_API.replace(/\/$/u, "")}/repos/${repoPath}/releases/tags/${tagPath}`;
  const data = await githubJson(url);
  if (data === null || Array.isArray(data) || typeof data !== "object") {
    fail(`GitHub release response for ${tag} was not an object`);
  }
  if (!Array.isArray(data.assets)) {
    fail(`GitHub release response for ${tag} did not include assets`);
  }
  const assets = new Map();
  for (const asset of data.assets) {
    if (asset === null || typeof asset !== "object" || typeof asset.name !== "string") {
      continue;
    }
    if (assets.has(asset.name)) {
      fail(`GitHub release ${tag} declares duplicate asset ${asset.name}`);
    }
    assets.set(asset.name, asset);
  }
  return assets;
}

async function requestBytes(url, name, expectedSize) {
  if (typeof url !== "string" || url.length === 0) {
    fail(`GitHub release asset ${name} did not include an API download URL`);
  }
  try {
    return await requestReleaseControlBytes(url, name, expectedSize);
  } catch (error) {
    fail(`failed to download GitHub asset ${name}: ${error.message}`);
  }
}

async function requestAssetProof(url, name, expectedSize) {
  if (typeof url !== "string" || url.length === 0) {
    fail(`GitHub release asset ${name} did not include an API download URL`);
  }
  try {
    return await requestReleaseAssetProof(url, name, expectedSize);
  } catch (error) {
    fail(`failed to verify GitHub asset ${name}: ${error.message}`);
  }
}

function sha256Bytes(data) {
  return createHash("sha256").update(data).digest("hex");
}

function validateKeySet(object, expected, context) {
  const actual = new Set(Object.keys(object));
  const missing = [...expected].filter((key) => !actual.has(key));
  const unexpected = [...actual].filter((key) => !expected.has(key));
  if (missing.length > 0 || unexpected.length > 0) {
    fail(`${context} keys must be ${JSON.stringify([...expected].sort())}, got ${JSON.stringify([...actual].sort())}`);
  }
}

function validateSha256(value, context) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
    fail(`${context} has invalid sha256 ${JSON.stringify(value)}`);
  }
}

function validateExtensionManifest(product, version, manifest, context) {
  if (manifest.schema !== "oliphaunt-extension-release-manifest-v1") {
    fail(`${context} schema must be oliphaunt-extension-release-manifest-v1`);
  }
  if (manifest.product !== product || manifest.version !== version) {
    fail(`${context} declares product/version ${manifest.product}@${manifest.version}, expected ${product}@${version}`);
  }
  validateKeySet(manifest, PUBLIC_EXTENSION_RELEASE_MANIFEST_KEYS, context);
  if (!Array.isArray(manifest.assets) || manifest.assets.length === 0) {
    fail(`${context} must declare a non-empty assets array`);
  }
  const seen = new Set();
  for (const [index, asset] of manifest.assets.entries()) {
    const assetContext = `${context} assets[${index}]`;
    if (asset === null || Array.isArray(asset) || typeof asset !== "object") {
      fail(`${assetContext} must be an object`);
    }
    validateKeySet(asset, PUBLIC_EXTENSION_RELEASE_ASSET_KEYS, assetContext);
    for (const key of ["name", "family", "target", "kind", "sha256"]) {
      if (typeof asset[key] !== "string" || asset[key].length === 0) {
        fail(`${assetContext}.${key} must be a non-empty string`);
      }
    }
    if (!(asset.identity === null || typeof asset.identity === "string" && asset.identity.length > 0)) {
      fail(`${assetContext}.identity must be null or a non-empty string`);
    }
    if (asset.kind === "ios-dependency-xcframework" && asset.identity === null) {
      fail(`${assetContext} iOS dependency XCFramework must declare its identity`);
    }
    validateSha256(asset.sha256, `${assetContext}.${asset.name}`);
    if (!Number.isInteger(asset.bytes) || asset.bytes <= 0) {
      fail(`${assetContext}.${asset.name} must declare positive bytes`);
    }
    if (seen.has(asset.name)) {
      fail(`${context} declares duplicate asset ${asset.name}`);
    }
    seen.add(asset.name);
  }
}

function parseChecksumManifest(data, context) {
  const checksums = new Map();
  const text = new TextDecoder().decode(data);
  for (const [index, rawLine] of text.split(/\r?\n/u).entries()) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    const parts = line.split(/\s+/u);
    if (parts.length !== 2) {
      fail(`${context}:${index + 1} must contain '<sha256> ./<asset>'`);
    }
    const [sha, name] = parts;
    validateSha256(sha, `${context}:${index + 1}`);
    if (!name.startsWith("./") || name.slice(2).includes("/")) {
      fail(`${context}:${index + 1} must reference a direct asset path like ./name`);
    }
    const assetName = name.slice(2);
    if (checksums.has(assetName)) {
      fail(`${context} declares duplicate checksum entry for ${assetName}`);
    }
    checksums.set(assetName, sha);
  }
  return checksums;
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort(compareText)
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

async function verifyExtensionReleaseAssets(product, version, expectedNames, actualAssets) {
  const actualNames = new Set(actualAssets.keys());
  const unexpected = [...actualNames].filter((name) => !expectedNames.has(name)).sort(compareText);
  if (unexpected.length > 0) {
    fail(`${product} GitHub release ${await productTag(product, version)} has unexpected exact-extension asset(s): ${unexpected.join(", ")}`);
  }

  const manifestName = `${product}-${version}-manifest.json`;
  const propertiesName = `${product}-${version}-manifest.properties`;
  const checksumName = `${product}-${version}-release-assets.sha256`;
  const localManifestPath = path.join(ROOT, "target/extension-artifacts", product, "release-assets", manifestName);
  const localManifest = await readJson(localManifestPath);
  const proofs = new Map();

  const manifestAsset = actualAssets.get(manifestName);
  const manifestSize = expectedAssetSize(manifestAsset.size, manifestName, MAX_CONTROL_ASSET_BYTES);
  const manifestBytes = await requestBytes(manifestAsset.url, manifestName, manifestSize);
  proofs.set(manifestName, { bytes: manifestBytes.byteLength, sha256: sha256Bytes(manifestBytes) });
  const remoteManifest = JSON.parse(new TextDecoder().decode(manifestBytes));
  if (stableStringify(remoteManifest) !== stableStringify(localManifest)) {
    fail(`${product} GitHub release ${await productTag(product, version)} public manifest differs from staged manifest`);
  }
  validateExtensionManifest(product, version, remoteManifest, `${product} ${version} public extension manifest`);

  const checksumAsset = actualAssets.get(checksumName);
  const checksumSize = expectedAssetSize(checksumAsset.size, checksumName, MAX_CONTROL_ASSET_BYTES);
  const checksumBytes = await requestBytes(checksumAsset.url, checksumName, checksumSize);
  proofs.set(checksumName, { bytes: checksumBytes.byteLength, sha256: sha256Bytes(checksumBytes) });
  const checksums = parseChecksumManifest(checksumBytes, checksumName);
  const checksumCoveredNames = new Set(remoteManifest.assets.map((asset) => asset.name));
  checksumCoveredNames.add(manifestName);
  checksumCoveredNames.add(propertiesName);
  if (
    stableStringify([...checksums.keys()].sort(compareText)) !==
    stableStringify([...checksumCoveredNames].sort(compareText))
  ) {
    fail(
      `${product} GitHub release ${await productTag(product, version)} checksum manifest must cover release assets exactly`,
    );
  }

  for (const name of [...checksumCoveredNames].sort(compareText)) {
    if (!actualAssets.has(name)) {
      fail(`${product} GitHub release ${await productTag(product, version)} is missing checksum-covered asset ${name}`);
    }
    const actualAsset = actualAssets.get(name);
    const manifestAsset = remoteManifest.assets.find((asset) => asset.name === name);
    const remoteSize = expectedAssetSize(actualAsset.size, name);
    if (manifestAsset !== undefined && remoteSize !== manifestAsset.bytes) {
      fail(`${product} GitHub release ${await productTag(product, version)} asset ${name} size metadata mismatch`);
    }
    let proof = proofs.get(name);
    if (proof === undefined) {
      proof = await requestAssetProof(actualAsset.url, name, manifestAsset?.bytes ?? remoteSize);
      proofs.set(name, proof);
    }
    if (proof.sha256 !== checksums.get(name)) {
      fail(`${product} GitHub release ${await productTag(product, version)} asset ${name} checksum mismatch`);
    }
    if (remoteSize !== proof.bytes) {
      fail(`${product} GitHub release ${await productTag(product, version)} asset ${name} size mismatch`);
    }
  }

  for (const asset of remoteManifest.assets) {
    const proof = proofs.get(asset.name);
    if (proof.bytes !== asset.bytes || proof.sha256 !== asset.sha256) {
      fail(`${product} GitHub release ${await productTag(product, version)} asset ${asset.name} public manifest mismatch`);
    }
  }
}

async function verifyReleaseAssets(product, version, assets) {
  const repo = repository();
  const tag = await productTag(product, version);
  const actualAssets = await releaseAssets(repo, tag);
  const expectedNames = new Set(assets);
  const missing = [...expectedNames].filter((name) => !actualAssets.has(name)).sort(compareText);
  if (missing.length > 0) {
    fail(`${product} GitHub release ${tag} is missing required asset(s): ${missing.join(", ")}`);
  }
  const config = await productConfig(product);
  if (config.kind === "exact-extension-artifact") {
    await verifyExtensionReleaseAssets(product, version, expectedNames, actualAssets);
  }
  console.log(`${product} GitHub release assets verified for ${tag}: ${assets.join(", ")}`);
}

function run(args, options = {}) {
  console.log(`\n==> ${args.join(" ")}`);
  const result = spawnSync(args[0], args.slice(1), {
    cwd: ROOT,
    stdio: "inherit",
    ...options,
  });
  if (result.error) {
    fail(`${args[0]} failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function parseArgs(argv) {
  const args = { product: [], productsJson: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--product") {
      const product = argv[++index];
      if (!product) {
        fail("--product requires a value");
      }
      args.product.push(product);
    } else if (value.startsWith("--product=")) {
      args.product.push(value.slice("--product=".length));
    } else if (value === "--products-json") {
      args.productsJson = argv[++index];
      if (args.productsJson === undefined) {
        fail("--products-json requires a value");
      }
    } else if (value.startsWith("--products-json=")) {
      args.productsJson = value.slice("--products-json=".length);
    } else if (value === "--head-ref") {
      index += 1;
    } else if (value.startsWith("--head-ref=")) {
      continue;
    } else if (value === "--help" || value === "-h") {
      console.log("usage: tools/release/verify_github_release_attestations.mjs [--product ID...] [--products-json JSON] [--head-ref REF]");
      process.exit(0);
    } else {
      fail(`unknown argument ${value}`);
    }
  }
  return args;
}

async function parseProducts(value) {
  const backed = await assetBackedProducts();
  if (!value) {
    return [...backed].sort(compareText);
  }
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    fail(`--products-json must be valid JSON: ${error.message}`);
  }
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
    fail("--products-json must be a JSON string array");
  }
  return parsed.filter((product) => backed.has(product));
}

function requireGh() {
  const result = spawnSync("gh", ["--version"], { stdio: "ignore" });
  if (result.error || result.status !== 0) {
    fail("gh CLI is required to verify GitHub release attestations");
  }
}

async function verifyProduct(product, destination) {
  const version = await currentVersion(product);
  const tag = await productTag(product, version);
  const repo = repository();
  const signerWorkflow = `${repo}/.github/workflows/release.yml`;
  const assets = await expectedAssets(product, version);
  await verifyReleaseAssets(product, version, assets);
  const productDir = path.join(destination, product);
  await fs.mkdir(productDir, { recursive: true });
  for (const asset of assets) {
    run(["gh", "release", "download", tag, "--repo", repo, "--pattern", asset, "--dir", productDir]);
    run([
      "gh",
      "attestation",
      "verify",
      path.join(productDir, asset),
      "--repo",
      repo,
      "--signer-workflow",
      signerWorkflow,
      "--source-ref",
      "refs/heads/main",
      "--deny-self-hosted-runners",
    ]);
  }
  console.log(`${product} GitHub release attestations verified for ${tag}`);
}

export { assetBackedProducts, expectedAssets, productTag, verifyReleaseAssets };

async function main(argv) {
  const args = parseArgs(argv);
  requireGh();
  const products = args.product.length > 0 ? args.product : await parseProducts(args.productsJson);
  const backed = await assetBackedProducts();
  const unknown = products.filter((product) => !backed.has(product)).sort(compareText);
  if (unknown.length > 0) {
    fail(`attestation verification is only defined for asset-backed products: ${unknown.join(", ")}`);
  }
  if (products.length === 0) {
    console.log("no asset-backed products selected; GitHub attestation verification skipped");
    return;
  }
  const destination = await fs.mkdtemp(path.join(tmpdir(), "oliphaunt-release-attestations."));
  try {
    for (const product of products) {
      await verifyProduct(product, destination);
    }
  } finally {
    await fs.rm(destination, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  await main(Bun.argv.slice(2));
}
