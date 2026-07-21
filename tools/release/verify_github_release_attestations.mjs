#!/usr/bin/env bun
// Verify GitHub artifact attestations for asset-backed product releases.

import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { runMoon } from "../policy/moon.mjs";
import {
  expectedAssets as expectedDesktopAssets,
  extensionMetadata,
  extensionSourceIdentity,
  extensionSqlNames,
} from "./release-artifact-targets.mjs";
import { currentVersion } from "./product-version.mjs";
import {
  assertPublicationLockSource,
  loadPublicationLock,
} from "./publication-lock.mjs";
import { reserveGitHubCoreRequestSync } from "./github-core-request-journal.mjs";
import { swiftExtensionCarrierAssetName } from "./ios-carrier-manifest.mjs";

const ROOT = path.resolve(import.meta.dir, "../..");
const PREFIX = "verify_github_release_attestations.mjs";
const GITHUB_API = process.env.GITHUB_API ?? "https://api.github.com";
const MAX_GITHUB_JSON_BYTES = 8 * 1024 * 1024;
const MAX_GITHUB_ERROR_BYTES = 64 * 1024;
const MAX_CONTROL_ASSET_BYTES = 8 * 1024 * 1024;
const MAX_RELEASE_ASSET_BYTES = 2 * 1024 * 1024 * 1024;
const GITHUB_API_TIMEOUT_MS = 30_000;
const RELEASE_ASSET_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_ATTESTATION_BUNDLE_BYTES = 32 * 1024 * 1024;
const MAX_ATTESTATION_RECEIPT_BYTES = 16 * 1024 * 1024;
const GITHUB_RELEASE_QUERY_WINDOW_MS = 5 * 60 * 1000;
const GITHUB_RELEASE_QUERY_MAX_ATTEMPTS = 3;
const GITHUB_RELEASE_SNAPSHOT_MAX_ATTEMPTS = 10;
const GITHUB_RELEASE_SNAPSHOT_MAX_RETRY_DELAY_MS = 15_000;
const GITHUB_RELEASE_QUERY_MAX_RETRY_AFTER_MS = 4 * 60 * 1000;
const GITHUB_RELEASE_LIST_PAGE_SIZE = 100;
const GITHUB_RELEASE_LIST_MAX_PAGES = 1_000;
const GITHUB_RELEASE_FALLBACK_QUERY_CONCURRENCY = 1;
const GH_ATTESTATION_VERIFY_TIMEOUT_MS = 5 * 60 * 1000;
const GH_ATTESTATION_VERIFY_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const GITHUB_ATTESTATION_RECEIPT_SCHEMA = "oliphaunt-github-release-attestation-receipt-v1";
const SLSA_PROVENANCE_V1 = "https://slsa.dev/provenance/v1";
const IN_TOTO_STATEMENT_V1 = "https://in-toto.io/Statement/v1";
const GITHUB_RELEASE_ARTIFACT_ROLES = new Set([
  "github-release-asset",
  "github-release-metadata",
]);

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
  "dataFiles",
  "extensionSqlFileNames",
  "extensionSqlFilePrefixes",
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
const PUBLIC_EXTENSION_BUNDLE_MANIFEST_KEYS = new Set([
  "schema",
  "product",
  "version",
  "extensionClass",
  "versioning",
  "sourceIdentity",
  "compatibility",
  "extensions",
  "assets",
]);
const PUBLIC_EXTENSION_BUNDLE_MEMBER_KEYS = new Set([
  "sqlName",
  "createsExtension",
  "dependencies",
  "dataFiles",
  "extensionSqlFileNames",
  "extensionSqlFilePrefixes",
  "nativeDependencies",
  "nativeModuleStem",
  "iosNativeDependencies",
  "iosRegistration",
  "sharedPreloadLibraries",
  "mobileReleaseReady",
  "desktopReleaseReady",
  "assets",
]);
const PUBLIC_EXTENSION_BUNDLE_ASSET_KEYS = new Set([
  "name",
  "family",
  "target",
  "kind",
  "sha256",
  "bytes",
  "memberCount",
]);
const PUBLIC_EXTENSION_BUNDLE_MEMBER_ASSET_KEYS = new Set([
  ...PUBLIC_EXTENSION_RELEASE_ASSET_KEYS,
  "carrierAsset",
  "carrierRoot",
  "memberPath",
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
    if (["exact-extension-artifact", "exact-extension-bundle"].includes(config.kind)) {
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
  const extensionAssets = await validateExtensionManifest(product, version, manifest, manifestPath);
  const names = extensionAssets.map((asset) => asset.name);
  names.push(
    `${product}-${version}-manifest.json`,
    `${product}-${version}-manifest.properties`,
    swiftExtensionCarrierAssetName(product, version),
    `${product}-${version}-release-assets.sha256`,
  );
  return [...new Set(names)].sort(compareText);
}

async function expectedAssets(product, version) {
  const config = await productConfig(product);
  if (["exact-extension-artifact", "exact-extension-bundle"].includes(config.kind)) {
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

function authHeaders(accept, token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN) {
  const headers = {
    Accept: accept,
    "User-Agent": "oliphaunt-release-check",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) {
    if (typeof token !== "string" || /[\0\r\n]/u.test(token)) {
      throw new Error("GitHub API token is invalid");
    }
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

function githubRateLimitedResponse(response, detail) {
  if (response.status === 429) return true;
  if (response.status !== 403) return false;
  return response.headers?.has?.("retry-after") === true
    || response.headers?.get?.("x-ratelimit-remaining")?.trim() === "0"
    || /(?:abuse|rate limit|secondary limit)/iu.test(detail);
}

function retryableGithubResponse(response, rateLimited) {
  return rateLimited
    || response.status === 408
    || response.status === 425
    || response.status >= 500 && response.status <= 599;
}

async function githubErrorDetail(response) {
  try {
    const bytes = await boundedResponseBytes(
      response,
      MAX_GITHUB_ERROR_BYTES,
      `GitHub API HTTP ${response.status} error response`,
    );
    const text = new TextDecoder().decode(bytes);
    try {
      const parsed = JSON.parse(text);
      return typeof parsed?.message === "string" ? parsed.message : text;
    } catch {
      return text;
    }
  } catch {
    await response.body?.cancel?.().catch(() => {});
    return "";
  }
}

function retryAfterDelay(response, nowMs, context) {
  const raw = response.headers?.get?.("retry-after")?.trim();
  if (!raw) return null;
  let delay;
  if (/^[0-9]+$/u.test(raw)) {
    delay = Number(raw) * 1000;
  } else {
    const date = Date.parse(raw);
    if (!Number.isFinite(date)) {
      throw new Error(`${context} returned an invalid Retry-After header`);
    }
    delay = Math.max(0, date - nowMs);
  }
  if (!Number.isSafeInteger(delay) || delay > GITHUB_RELEASE_QUERY_MAX_RETRY_AFTER_MS) {
    throw new Error(
      `${context} requested Retry-After ${JSON.stringify(raw)}, exceeding the ${GITHUB_RELEASE_QUERY_MAX_RETRY_AFTER_MS}ms retry cap`,
    );
  }
  return delay;
}

function rateLimitDelay(response, nowMs, headerlessSecondaryAttempt, context) {
  const retryAfter = retryAfterDelay(response, nowMs, context);
  if (retryAfter !== null) return retryAfter;

  if (response.headers?.get?.("x-ratelimit-remaining")?.trim() === "0") {
    const rawReset = response.headers?.get?.("x-ratelimit-reset")?.trim();
    if (rawReset === undefined || rawReset === null || rawReset === "") {
      throw new Error(`${context} exhausted the primary rate limit without X-RateLimit-Reset`);
    }
    if (!/^[1-9][0-9]*$/u.test(rawReset)) {
      throw new Error(`${context} returned an invalid X-RateLimit-Reset header`);
    }
    const resetMs = Number(rawReset) * 1000;
    const delay = Math.max(0, resetMs - nowMs) + 1_000;
    if (!Number.isSafeInteger(resetMs) || delay > GITHUB_RELEASE_QUERY_MAX_RETRY_AFTER_MS) {
      throw new Error(
        `${context} requires a primary-rate-limit wait exceeding the ${GITHUB_RELEASE_QUERY_MAX_RETRY_AFTER_MS}ms retry cap`,
      );
    }
    return delay;
  }

  // GitHub requires at least a one-minute pause for a secondary limit without
  // usable rate-limit headers, followed by exponential backoff.
  return Math.min(
    GITHUB_RELEASE_QUERY_MAX_RETRY_AFTER_MS,
    60_000 * 2 ** Math.max(0, headerlessSecondaryAttempt - 1),
  );
}

function githubReleaseQueryDeadline(nowMs = Date.now(), env = process.env) {
  let deadline = nowMs + GITHUB_RELEASE_QUERY_WINDOW_MS;
  const raw = env.REGISTRY_JOB_HARD_DEADLINE_EPOCH?.trim();
  if (raw !== undefined && raw !== "") {
    if (!/^[1-9][0-9]*$/u.test(raw)) {
      throw new Error("REGISTRY_JOB_HARD_DEADLINE_EPOCH must be a positive Unix timestamp");
    }
    const hardDeadline = Number(raw) * 1000;
    if (!Number.isSafeInteger(hardDeadline)) {
      throw new Error("REGISTRY_JOB_HARD_DEADLINE_EPOCH exceeds the safe timestamp range");
    }
    deadline = Math.min(deadline, hardDeadline);
  }
  if (deadline <= nowMs) {
    throw new Error("GitHub release query deadline has already expired");
  }
  return deadline;
}

export async function requestGithubJsonWithRetry(url, {
  authToken,
  coreJournalOptions,
  deadlineMs,
  fetchImpl = fetch,
  maxAttempts = GITHUB_RELEASE_QUERY_MAX_ATTEMPTS,
  nowImpl = Date.now,
  responseMetadata = false,
  sleepImpl = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
} = {}) {
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts <= 0) {
    throw new Error("GitHub request maxAttempts must be a positive safe integer");
  }
  const effectiveDeadline = deadlineMs ?? githubReleaseQueryDeadline(nowImpl());
  let headerlessSecondaryFailures = 0;
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const now = nowImpl();
    const remaining = effectiveDeadline - now;
    if (remaining <= 0) {
      throw new Error(`GitHub release query deadline expired for ${url}`);
    }
    let response;
    let rateLimited = false;
    reserveGitHubCoreRequestSync({
      ...(coreJournalOptions ?? {}),
      label: `GitHub release JSON ${new URL(url).pathname}`,
    });
    const transportRemaining = effectiveDeadline - nowImpl();
    if (transportRemaining <= 0) {
      throw new Error(`GitHub release query deadline expired during request-journal admission for ${url}`);
    }
    try {
      response = await fetchImpl(url, {
        headers: authHeaders("application/vnd.github+json", authToken),
        redirect: "error",
        signal: AbortSignal.timeout(Math.max(1, Math.min(GITHUB_API_TIMEOUT_MS, transportRemaining))),
      });
    } catch (error) {
      lastError = error;
      if (attempt === maxAttempts) break;
    }
    if (response?.ok) {
      const bytes = await boundedResponseBytes(response, MAX_GITHUB_JSON_BYTES, "GitHub API response");
      try {
        const data = JSON.parse(new TextDecoder().decode(bytes));
        return responseMetadata
          ? { data, link: response.headers?.get?.("link") ?? "" }
          : data;
      } catch (error) {
        throw new Error(`GitHub API returned invalid JSON for ${url}: ${error.message}`);
      }
    }
    if (response !== undefined) {
      const detail = await githubErrorDetail(response);
      rateLimited = githubRateLimitedResponse(response, detail);
      if (!retryableGithubResponse(response, rateLimited)) {
        throw new Error(`GitHub API returned HTTP ${response.status} for ${url}`);
      }
      lastError = new Error(`GitHub API returned transient HTTP ${response.status} for ${url}`);
      if (attempt === maxAttempts) break;
    }
    const current = nowImpl();
    const retryAfter = response === undefined
      ? null
      : retryAfterDelay(response, current, `GitHub API HTTP ${response.status}`);
    const headerlessSecondary = response !== undefined
      && rateLimited
      && retryAfter === null
      && response.headers?.get?.("x-ratelimit-remaining")?.trim() !== "0";
    headerlessSecondaryFailures = headerlessSecondary
      ? headerlessSecondaryFailures + 1
      : 0;
    const delay = retryAfter ?? (rateLimited
      ? rateLimitDelay(
          response,
          current,
          headerlessSecondaryFailures,
          `GitHub API HTTP ${response.status}`,
        )
      : Math.min(2_000, 250 * 2 ** (attempt - 1)));
    if (current + delay >= effectiveDeadline) {
      throw new Error(`GitHub release query retry for ${url} would exceed its deadline`);
    }
    await sleepImpl(delay);
  }
  throw new Error(`${lastError?.message ?? `GitHub API request failed for ${url}`} after ${maxAttempts} attempts`);
}

export async function requestReleaseControlBytes(url, name, expectedSize, {
  fetchImpl = fetch,
  timeoutMs = RELEASE_ASSET_TIMEOUT_MS,
} = {}) {
  const size = expectedAssetSize(expectedSize, name, MAX_CONTROL_ASSET_BYTES);
  reserveGitHubCoreRequestSync({ label: `download GitHub release control asset ${name}` });
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
  reserveGitHubCoreRequestSync({ label: `prove GitHub release asset ${name}` });
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

function validateExtensionAssets(assets, context, seen) {
  if (!Array.isArray(assets) || assets.length === 0) {
    fail(`${context} must declare a non-empty assets array`);
  }
  for (const [index, asset] of assets.entries()) {
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

function validateBundleCarrierAssets(assets, context, expectedMemberCount) {
  if (!Array.isArray(assets) || assets.length === 0) {
    fail(`${context} must declare a non-empty aggregate assets array`);
  }
  const byName = new Map();
  const groups = new Set();
  for (const [index, asset] of assets.entries()) {
    const assetContext = `${context} assets[${index}]`;
    if (asset === null || Array.isArray(asset) || typeof asset !== "object") fail(`${assetContext} must be an object`);
    validateKeySet(asset, PUBLIC_EXTENSION_BUNDLE_ASSET_KEYS, assetContext);
    for (const key of ["name", "family", "target", "kind", "sha256"]) {
      if (typeof asset[key] !== "string" || asset[key].length === 0) fail(`${assetContext}.${key} must be a non-empty string`);
    }
    if (asset.kind !== "extension-bundle") fail(`${assetContext}.kind must be extension-bundle`);
    validateSha256(asset.sha256, `${assetContext}.${asset.name}`);
    if (!Number.isSafeInteger(asset.bytes) || asset.bytes <= 0) fail(`${assetContext}.${asset.name} must declare positive bytes`);
    if (asset.memberCount !== expectedMemberCount) {
      fail(`${assetContext}.${asset.name} must declare memberCount=${expectedMemberCount}`);
    }
    const group = `${asset.family}\0${asset.target}`;
    if (byName.has(asset.name) || groups.has(group)) fail(`${context} repeats an aggregate carrier name or family/target`);
    byName.set(asset.name, asset);
    groups.add(group);
  }
  return byName;
}

function validateBundleMemberAssets(assets, context, carriers, seenLocators) {
  if (!Array.isArray(assets) || assets.length === 0) fail(`${context} must declare a non-empty assets array`);
  for (const [index, asset] of assets.entries()) {
    const assetContext = `${context} assets[${index}]`;
    if (asset === null || Array.isArray(asset) || typeof asset !== "object") fail(`${assetContext} must be an object`);
    validateKeySet(asset, PUBLIC_EXTENSION_BUNDLE_MEMBER_ASSET_KEYS, assetContext);
    for (const key of [
      "name", "family", "target", "kind", "sha256", "carrierAsset", "carrierRoot", "memberPath",
    ]) {
      if (typeof asset[key] !== "string" || asset[key].length === 0) fail(`${assetContext}.${key} must be a non-empty string`);
    }
    if (!(asset.identity === null || typeof asset.identity === "string" && asset.identity.length > 0)) {
      fail(`${assetContext}.identity must be null or a non-empty string`);
    }
    validateSha256(asset.sha256, `${assetContext}.${asset.name}`);
    if (!Number.isSafeInteger(asset.bytes) || asset.bytes <= 0) fail(`${assetContext}.${asset.name} must declare positive bytes`);
    const carrier = carriers.get(asset.carrierAsset);
    if (carrier === undefined || carrier.family !== asset.family || carrier.target !== asset.target) {
      fail(`${assetContext} references a missing or wrong-family aggregate carrier`);
    }
    const expectedRoot = asset.carrierAsset.replace(/\.tar\.gz$/u, "");
    if (asset.carrierRoot !== expectedRoot) fail(`${assetContext}.carrierRoot does not match ${asset.carrierAsset}`);
    if (
      asset.memberPath.includes("\\")
      || asset.memberPath.startsWith("/")
      || asset.memberPath.split("/").some((part) => !part || part === "." || part === "..")
    ) fail(`${assetContext}.memberPath must be a safe POSIX path`);
    const locator = `${asset.carrierAsset}\0${asset.memberPath}`;
    if (seenLocators.has(locator)) fail(`${context} repeats aggregate member locator ${asset.memberPath}`);
    seenLocators.add(locator);
  }
}

let canonicalExtensionRowsCache;
let canonicalIosDependenciesCache;

function canonicalExtensionRows() {
  canonicalExtensionRowsCache ??= JSON.parse(
    readFileSync(path.join(ROOT, "src/extensions/generated/sdk/react-native.json"), "utf8"),
  ).extensions;
  if (!Array.isArray(canonicalExtensionRowsCache)) {
    throw new Error("generated React Native extension catalog has no extensions array");
  }
  return canonicalExtensionRowsCache;
}

function canonicalIosDependencies() {
  if (canonicalIosDependenciesCache !== undefined) return canonicalIosDependenciesCache;
  const lines = readFileSync(path.join(ROOT, "src/extensions/generated/mobile/static-extensions.tsv"), "utf8")
    .split(/\r?\n/u)
    .filter((line) => line.length > 0 && !line.startsWith("#"));
  const header = lines.shift()?.split("\t") ?? [];
  canonicalIosDependenciesCache = new Map(lines.map((line) => {
    const fields = line.split("\t");
    const row = Object.fromEntries(header.map((key, index) => [key, fields[index] ?? ""]));
    return [row["sql-name"], (row["ios-static-dependencies"] ?? "").split(",").filter(Boolean).sort(compareText)];
  }));
  return canonicalIosDependenciesCache;
}

function canonicalSortedUniqueStrings(value, context) {
  if (
    !Array.isArray(value)
    || value.some((item) => typeof item !== "string" || item.length === 0)
    || new Set(value).size !== value.length
  ) {
    throw new Error(`${context} must be a unique non-empty string list`);
  }
  return [...value].sort(compareText);
}

function canonicalMemberSemantics(product, sqlName) {
  if (!extensionSqlNames(product, PREFIX).includes(sqlName)) {
    throw new Error(`${product} does not own extension SQL name ${JSON.stringify(sqlName)}`);
  }
  const row = canonicalExtensionRows().find((candidate) => candidate?.["sql-name"] === sqlName);
  if (row === undefined || row["release-product"] !== product) {
    throw new Error(`${product}/${sqlName} is absent from canonical generated extension metadata`);
  }
  const nativeModuleStem = typeof row["native-module-stem"] === "string" && row["native-module-stem"].length > 0
    ? row["native-module-stem"]
    : null;
  return {
    sqlName,
    createsExtension: row["creates-extension"] !== false,
    dependencies: canonicalSortedUniqueStrings(row["selected-extension-dependencies"], `${product}/${sqlName}.selected-extension-dependencies`),
    dataFiles: canonicalSortedUniqueStrings(row["runtime-share-data-files"], `${product}/${sqlName}.runtime-share-data-files`),
    extensionSqlFileNames: canonicalSortedUniqueStrings(row["extension-sql-file-names"], `${product}/${sqlName}.extension-sql-file-names`),
    extensionSqlFilePrefixes: canonicalSortedUniqueStrings(row["extension-sql-file-prefixes"], `${product}/${sqlName}.extension-sql-file-prefixes`),
    nativeDependencies: canonicalSortedUniqueStrings(row["native-dependencies"], `${product}/${sqlName}.native-dependencies`),
    nativeModuleStem,
    iosNativeDependencies: nativeModuleStem === null ? [] : (canonicalIosDependencies().get(sqlName) ?? []),
    sharedPreloadLibraries: canonicalSortedUniqueStrings(row["shared-preload-libraries"], `${product}/${sqlName}.shared-preload-libraries`),
    mobileReleaseReady: row["mobile-release-ready"] === true,
    desktopReleaseReady: row["desktop-release-ready"] === true,
  };
}

function assertCanonicalIosRegistration(member, expected, context) {
  if (expected.nativeModuleStem === null) {
    if (member.iosRegistration !== null) throw new Error(`${context} SQL-only extension fabricates iOS registration metadata`);
    return;
  }
  const registration = member.iosRegistration;
  if (registration === null || Array.isArray(registration) || typeof registration !== "object") {
    throw new Error(`${context} native extension lacks iOS registration metadata`);
  }
  const expectedKeys = ["initSymbol", "magicSymbol", "nativeModuleStem", "schema", "sqlName", "symbols"].sort(compareText);
  if (stableStringify(Object.keys(registration).sort(compareText)) !== stableStringify(expectedKeys)) {
    throw new Error(`${context}.iosRegistration has a non-canonical key set`);
  }
  const prefix = `oliphaunt_static_${expected.nativeModuleStem.replaceAll(/[^A-Za-z0-9_]/gu, "_")}`;
  if (
    registration.schema !== "oliphaunt-ios-extension-registration-v1"
    || registration.sqlName !== expected.sqlName
    || registration.nativeModuleStem !== expected.nativeModuleStem
    || registration.magicSymbol !== `${prefix}_Pg_magic_func`
    || ![null, `${prefix}__PG_init`].includes(registration.initSymbol)
    || !Array.isArray(registration.symbols)
  ) {
    throw new Error(`${context}.iosRegistration does not match its canonical native module identity`);
  }
  const normalizedSymbols = registration.symbols.map((row, index) => {
    if (
      row === null
      || Array.isArray(row)
      || typeof row !== "object"
      || stableStringify(Object.keys(row).sort(compareText)) !== stableStringify(["address", "name"])
      || typeof row.name !== "string"
      || typeof row.address !== "string"
      || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(row.name)
      || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(row.address)
    ) {
      throw new Error(`${context}.iosRegistration.symbols[${index}] is not a canonical C symbol mapping`);
    }
    return `${row.name}\0${row.address}`;
  });
  if (
    new Set(registration.symbols.map((row) => row.name)).size !== registration.symbols.length
    || stableStringify(normalizedSymbols) !== stableStringify([...normalizedSymbols].sort(compareText))
  ) {
    throw new Error(`${context}.iosRegistration.symbols must be sorted with unique public names`);
  }
}

function assertCanonicalMemberSemantics(product, member, context) {
  const expected = canonicalMemberSemantics(product, member?.sqlName);
  for (const key of Object.keys(expected)) {
    if (stableStringify(member?.[key]) !== stableStringify(expected[key])) {
      throw new Error(`${context}.${key} differs from canonical generated extension metadata`);
    }
  }
  assertCanonicalIosRegistration(member, expected, context);
}

export function assertCanonicalExtensionReleaseIdentity(product, version, manifest, context = "extension release manifest") {
  if (manifest === null || Array.isArray(manifest) || typeof manifest !== "object") {
    throw new Error(`${context} must be an object`);
  }
  const metadata = extensionMetadata(product, PREFIX);
  const expectedRoot = {
    product,
    version,
    extensionClass: metadata.class,
    versioning: metadata.versioning,
    sourceIdentity: extensionSourceIdentity(product, PREFIX),
    compatibility: metadata.compatibility,
  };
  for (const [key, expected] of Object.entries(expectedRoot)) {
    if (stableStringify(manifest[key]) !== stableStringify(expected)) {
      throw new Error(`${context}.${key} differs from canonical release identity`);
    }
  }
  const expectedSqlNames = extensionSqlNames(product, PREFIX);
  if (manifest.schema === "oliphaunt-extension-release-manifest-v1") {
    if (expectedSqlNames.length !== 1 || manifest.sqlName !== expectedSqlNames[0]) {
      throw new Error(`${context}.sqlName differs from its canonical release owner`);
    }
    assertCanonicalMemberSemantics(product, manifest, context);
    return manifest;
  }
  if (manifest.schema === "oliphaunt-extension-release-manifest-v2") {
    const actualSqlNames = Array.isArray(manifest.extensions)
      ? manifest.extensions.map((member) => member?.sqlName)
      : [];
    if (stableStringify(actualSqlNames) !== stableStringify(expectedSqlNames)) {
      throw new Error(`${context}.extensions differs from its canonical sorted member set`);
    }
    manifest.extensions.forEach((member, index) =>
      assertCanonicalMemberSemantics(product, member, `${context}.extensions[${index}]`));
    return manifest;
  }
  throw new Error(`${context} has unsupported extension release manifest schema ${JSON.stringify(manifest.schema)}`);
}

async function validateExtensionManifest(product, version, manifest, context) {
  try {
    assertCanonicalExtensionReleaseIdentity(product, version, manifest, context);
  } catch (error) {
    fail(error.message);
  }
  const seen = new Set();
  if (manifest.schema === "oliphaunt-extension-release-manifest-v1") {
    validateKeySet(manifest, PUBLIC_EXTENSION_RELEASE_MANIFEST_KEYS, context);
    validateExtensionAssets(manifest.assets, context, seen);
    return manifest.assets;
  }
  if (manifest.schema !== "oliphaunt-extension-release-manifest-v2") {
    fail(`${context} has unsupported extension release manifest schema ${JSON.stringify(manifest.schema)}`);
  }
  validateKeySet(manifest, PUBLIC_EXTENSION_BUNDLE_MANIFEST_KEYS, context);
  if (!Array.isArray(manifest.extensions) || manifest.extensions.length < 2) {
    fail(`${context}.extensions must be a non-empty bundle member array`);
  }
  const config = await productConfig(product);
  const expectedSqlNames = config.extension_sql_names;
  const actualSqlNames = manifest.extensions.map((member) => member?.sqlName);
  if (!Array.isArray(expectedSqlNames) || stableStringify(actualSqlNames) !== stableStringify(expectedSqlNames)) {
    fail(`${context}.extensions must exactly match the sorted release bundle member set`);
  }
  const carriers = validateBundleCarrierAssets(manifest.assets, context, expectedSqlNames.length);
  const seenLocators = new Set();
  for (const [index, member] of manifest.extensions.entries()) {
    const memberContext = `${context}.extensions[${index}]`;
    if (member === null || Array.isArray(member) || typeof member !== "object") {
      fail(`${memberContext} must be an object`);
    }
    validateKeySet(member, PUBLIC_EXTENSION_BUNDLE_MEMBER_KEYS, memberContext);
    validateBundleMemberAssets(member.assets, memberContext, carriers, seenLocators);
    for (const asset of member.assets) {
      const expectedMemberPath = `extensions/${member.sqlName}/${asset.name}`;
      if (asset.memberPath !== expectedMemberPath) {
        fail(`${memberContext} asset ${asset.name} must use memberPath ${expectedMemberPath}`);
      }
    }
  }
  return manifest.assets;
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

export function assertExactReleaseAssetNames({ product, tag, expectedNames, actualNames }) {
  const expected = new Set(expectedNames);
  const actual = new Set(actualNames);
  const missing = [...expected].filter((name) => !actual.has(name)).sort(compareText);
  const unexpected = [...actual].filter((name) => !expected.has(name)).sort(compareText);
  if (missing.length > 0 || unexpected.length > 0) {
    const details = [
      ...(missing.length > 0 ? [`missing: ${missing.join(", ")}`] : []),
      ...(unexpected.length > 0 ? [`unexpected: ${unexpected.join(", ")}`] : []),
    ];
    throw new Error(`${product} GitHub release ${tag} asset set mismatch (${details.join("; ")})`);
  }
}

function requireObject(value, context) {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new Error(`${context} must be an object`);
  }
  return value;
}

function assertKeySet(value, keys, context) {
  requireObject(value, context);
  const actual = Object.keys(value).sort(compareText);
  const expected = [...keys].sort(compareText);
  if (stableStringify(actual) !== stableStringify(expected)) {
    throw new Error(`${context} keys must be ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function requireSha256(value, context) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new Error(`${context} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function normalizeGithubId(value, context) {
  if (Number.isSafeInteger(value) && value > 0) {
    return String(value);
  }
  if (typeof value === "string" && /^[1-9][0-9]*$/u.test(value)) {
    return value;
  }
  throw new Error(`${context} must be a positive integer ID`);
}

function normalizedRepository(value) {
  if (
    typeof value !== "string"
    || !/^[^/\s\0]+\/[^/\s\0]+$/u.test(value)
    || value.includes("..")
  ) {
    throw new Error(`GitHub repository must be an owner/name pair, got ${JSON.stringify(value)}`);
  }
  return value;
}

function frozenProductTag(product) {
  if (
    product === null
    || Array.isArray(product)
    || typeof product !== "object"
    || typeof product.id !== "string"
    || product.id.length === 0
    || typeof product.version !== "string"
    || product.version.length === 0
  ) {
    throw new Error("publication lock contains an invalid product row");
  }
  return `${product.id}-v${product.version}`;
}

export function frozenGithubReleaseAssets(lock) {
  if (!Array.isArray(lock?.products) || !Array.isArray(lock?.productArtifacts)) {
    throw new Error("publication lock must contain products and productArtifacts arrays");
  }
  const products = new Set();
  for (const product of lock.products) {
    frozenProductTag(product);
    if (products.has(product.id)) {
      throw new Error(`publication lock contains duplicate product ${product.id}`);
    }
    products.add(product.id);
  }
  const identities = new Set();
  const assets = [];
  for (const artifact of lock.productArtifacts) {
    if (!GITHUB_RELEASE_ARTIFACT_ROLES.has(artifact?.role)) continue;
    if (!products.has(artifact.product)) {
      throw new Error(`frozen GitHub asset ${artifact?.name ?? "<unknown>"} belongs to unselected product ${artifact?.product ?? "<unknown>"}`);
    }
    if (
      typeof artifact.name !== "string"
      || artifact.name.length === 0
      || artifact.name.includes("/")
      || artifact.name.includes("\\")
      || /[\0\r\n]/u.test(artifact.name)
    ) {
      throw new Error(`${artifact.product} contains an invalid frozen GitHub asset name`);
    }
    requireSha256(artifact.sha256, `${artifact.product}/${artifact.name} frozen sha256`);
    if (!Number.isSafeInteger(artifact.size) || artifact.size < 0) {
      throw new Error(`${artifact.product}/${artifact.name} frozen size must be a non-negative safe integer`);
    }
    if (typeof artifact.path !== "string" || artifact.path.length === 0) {
      throw new Error(`${artifact.product}/${artifact.name} frozen path must be non-empty`);
    }
    const identity = `${artifact.product}\0${artifact.name}`;
    if (identities.has(identity)) {
      throw new Error(`publication lock contains duplicate GitHub asset ${artifact.product}/${artifact.name}`);
    }
    identities.add(identity);
    assets.push({
      name: artifact.name,
      path: artifact.path,
      product: artifact.product,
      sha256: artifact.sha256,
      size: artifact.size,
    });
  }
  return assets.sort((left, right) =>
    compareText(left.product, right.product) || compareText(left.name, right.name));
}

function expectedAssetsByProduct(lock) {
  const grouped = new Map(lock.products.map((product) => [product.id, []]));
  for (const asset of frozenGithubReleaseAssets(lock)) {
    grouped.get(asset.product).push(asset);
  }
  return grouped;
}

async function mapConcurrent(values, concurrency, worker) {
  if (!Number.isSafeInteger(concurrency) || concurrency <= 0) {
    throw new Error("concurrency must be a positive safe integer");
  }
  const output = new Array(values.length);
  let next = 0;
  let failure;
  const runWorker = async () => {
    for (;;) {
      if (failure !== undefined) return;
      const index = next;
      next += 1;
      if (index >= values.length) return;
      try {
        output[index] = await worker(values[index], index);
      } catch (error) {
        failure ??= error;
        return;
      }
    }
  };
  await Promise.all(Array.from(
    { length: Math.min(values.length, concurrency) },
    () => runWorker(),
  ));
  if (failure !== undefined) throw failure;
  return output;
}

function repositoryApiBase(repo) {
  const repoPath = encodeURIComponent(repo).replaceAll("%2F", "/");
  return `${GITHUB_API.replace(/\/$/u, "")}/repos/${repoPath}`;
}

function releasesListApiUrl(repo, page) {
  return `${repositoryApiBase(repo)}/releases?per_page=${GITHUB_RELEASE_LIST_PAGE_SIZE}&page=${page}`;
}

function releaseAssetsListApiUrl(repo, releaseId, page) {
  return `${repositoryApiBase(repo)}/releases/${releaseId}/assets?per_page=${GITHUB_RELEASE_LIST_PAGE_SIZE}&page=${page}`;
}

function requiredGithubAuthToken(value = process.env.GH_TOKEN || process.env.GITHUB_TOKEN) {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.trim() !== value
    || /[\0\r\n]/u.test(value)
  ) {
    throw new Error("authenticated GitHub release snapshots require GH_TOKEN or GITHUB_TOKEN");
  }
  return value;
}

async function requestGithubArrayPages({
  authToken,
  context,
  deadlineMs,
  fetchImpl,
  nowImpl,
  sleepImpl,
  urlForPage,
}) {
  const rows = [];
  for (let page = 1; page <= GITHUB_RELEASE_LIST_MAX_PAGES; page += 1) {
    const url = urlForPage(page);
    const { data, link } = await requestGithubJsonWithRetry(url, {
      authToken,
      deadlineMs,
      fetchImpl,
      nowImpl,
      responseMetadata: true,
      sleepImpl,
    });
    if (!Array.isArray(data)) {
      throw new Error(`${context} page ${page} must be an array`);
    }
    if (data.length > GITHUB_RELEASE_LIST_PAGE_SIZE) {
      throw new Error(
        `${context} page ${page} exceeds ${GITHUB_RELEASE_LIST_PAGE_SIZE} rows`,
      );
    }
    rows.push(...data);
    const hasNext = /(?:^|,)\s*<[^>]+>\s*;\s*rel="next"(?:\s*;[^,]*)?(?:,|$)/iu.test(link);
    if (!hasNext) return rows;
    if (data.length !== GITHUB_RELEASE_LIST_PAGE_SIZE) {
      throw new Error(`${context} advertises another page after only ${data.length} rows`);
    }
  }
  throw new Error(`${context} exceeds ${GITHUB_RELEASE_LIST_MAX_PAGES} pages`);
}

function normalizeRemoteAsset(asset, expected, product, tag) {
  requireObject(asset, `${product} GitHub release ${tag} asset ${expected.name}`);
  if (asset.name !== expected.name) {
    throw new Error(`${product} GitHub release ${tag} asset name changed while it was being validated`);
  }
  if (asset.state !== "uploaded") {
    throw new GithubReleaseSnapshotNotReadyError(
      `${product} GitHub release ${tag} asset ${expected.name} is not fully uploaded`,
    );
  }
  if (!Number.isSafeInteger(asset.size) || asset.size < 0 || asset.size !== expected.size) {
    throw new Error(
      `${product} GitHub release ${tag} asset ${expected.name} size ${JSON.stringify(asset.size)} does not match frozen size ${expected.size}`,
    );
  }
  const expectedDigest = `sha256:${expected.sha256}`;
  if (asset.digest !== expectedDigest) {
    if (asset.digest === null || asset.digest === undefined || asset.digest === "") {
      throw new GithubReleaseSnapshotNotReadyError(
        `${product} GitHub release ${tag} asset ${expected.name} is missing GitHub digest metadata`,
      );
    }
    throw new Error(
      `${product} GitHub release ${tag} asset ${expected.name} digest ${JSON.stringify(asset.digest)} does not match ${expectedDigest}`,
    );
  }
  return {
    assetId: normalizeGithubId(asset.id, `${product} GitHub release ${tag} asset ${expected.name} id`),
    name: expected.name,
    sha256: expected.sha256,
    size: expected.size,
  };
}

class GithubReleaseSnapshotNotReadyError extends Error {
  constructor(message) {
    super(message);
    this.name = "GithubReleaseSnapshotNotReadyError";
  }
}

function exactProductSet(expected, actual, context) {
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  const missing = [...expectedSet].filter((value) => !actualSet.has(value)).sort(compareText);
  const extra = [...actualSet].filter((value) => !expectedSet.has(value)).sort(compareText);
  if (missing.length > 0 || extra.length > 0 || actual.length !== actualSet.size) {
    throw new Error(`${context} mismatch: missing=${JSON.stringify(missing)}, extra=${JSON.stringify(extra)}, duplicate=${actual.length !== actualSet.size}`);
  }
}

export function normalizeGithubReleaseSnapshot(lock, releases) {
  if (!Array.isArray(releases)) {
    throw new Error("GitHub release snapshot must be an array");
  }
  const products = [...lock.products].sort((left, right) => compareText(left.id, right.id));
  exactProductSet(
    products.map((product) => product.id),
    releases.map((release) => release?.product),
    "GitHub release snapshot product set",
  );
  const expectedByProduct = expectedAssetsByProduct(lock);
  const releaseIds = new Set();
  const assetIds = new Set();
  const normalized = [];
  for (const product of products) {
    const release = releases.find((candidate) => candidate?.product === product.id);
    const context = `${product.id} GitHub release snapshot`;
    assertKeySet(release, [
      "assets",
      "draft",
      "prerelease",
      "product",
      "releaseId",
      "releaseName",
      "tag",
      "targetCommitish",
      "version",
    ], context);
    const tag = frozenProductTag(product);
    if (
      release.version !== product.version
      || release.tag !== tag
      || release.releaseName !== `${product.id} v${product.version}`
      || release.targetCommitish !== lock.source.commit
      || release.prerelease !== product.version.includes("-")
      || typeof release.draft !== "boolean"
    ) {
      throw new Error(`${context} metadata does not match the frozen publication lock`);
    }
    const releaseId = normalizeGithubId(release.releaseId, `${context} id`);
    if (releaseIds.has(releaseId)) {
      throw new Error(`GitHub release snapshot reuses release id ${releaseId}`);
    }
    releaseIds.add(releaseId);
    if (!Array.isArray(release.assets)) {
      throw new Error(`${context}.assets must be an array`);
    }
    const expectedAssets = expectedByProduct.get(product.id);
    assertExactReleaseAssetNames({
      product: product.id,
      tag,
      expectedNames: expectedAssets.map((asset) => asset.name),
      actualNames: release.assets.map((asset) => asset?.name),
    });
    if (new Set(release.assets.map((asset) => asset?.name)).size !== release.assets.length) {
      throw new Error(`${context} contains duplicate asset names`);
    }
    const assets = [];
    for (const expected of expectedAssets) {
      const asset = release.assets.find((candidate) => candidate?.name === expected.name);
      assertKeySet(asset, ["assetId", "name", "sha256", "size"], `${context} asset ${expected.name}`);
      if (asset.sha256 !== expected.sha256 || asset.size !== expected.size) {
        throw new Error(`${context} asset ${expected.name} differs from the frozen publication lock`);
      }
      const assetId = normalizeGithubId(asset.assetId, `${context} asset ${expected.name} id`);
      if (assetIds.has(assetId)) {
        throw new Error(`GitHub release snapshot reuses asset id ${assetId}`);
      }
      assetIds.add(assetId);
      assets.push({
        assetId,
        name: expected.name,
        sha256: expected.sha256,
        size: expected.size,
      });
    }
    normalized.push({
      assets,
      draft: release.draft,
      prerelease: release.prerelease,
      product: product.id,
      releaseId,
      releaseName: release.releaseName,
      tag,
      targetCommitish: lock.source.commit,
      version: product.version,
    });
  }
  return normalized;
}

async function queryLockedGithubReleasesOnce(lock, {
  authToken,
  deadlineMs,
  fetchImpl = fetch,
  nowImpl = Date.now,
  repo = repository(),
  sleepImpl,
} = {}) {
  const canonicalRepo = normalizedRepository(repo);
  const token = requiredGithubAuthToken(authToken);
  const effectiveDeadline = deadlineMs ?? githubReleaseQueryDeadline(nowImpl());
  const expectedByProduct = expectedAssetsByProduct(lock);
  const products = [...lock.products].sort((left, right) => compareText(left.id, right.id));
  const selectedTags = new Set(products.map(frozenProductTag));
  const listedReleases = await requestGithubArrayPages({
    authToken: token,
    context: `${canonicalRepo} GitHub release list`,
    deadlineMs: effectiveDeadline,
    fetchImpl,
    nowImpl,
    sleepImpl,
    urlForPage: (page) => releasesListApiUrl(canonicalRepo, page),
  });
  const releasesByTag = new Map();
  const releaseIds = new Set();
  for (const [index, release] of listedReleases.entries()) {
    const context = `${canonicalRepo} GitHub release list row ${index}`;
    requireObject(release, context);
    if (typeof release.tag_name !== "string" || release.tag_name.length === 0) {
      throw new Error(`${context}.tag_name must be a non-empty string`);
    }
    const releaseId = normalizeGithubId(release.id, `${context}.id`);
    if (releaseIds.has(releaseId)) {
      throw new Error(`${canonicalRepo} GitHub release list reuses release id ${releaseId}`);
    }
    releaseIds.add(releaseId);
    if (!selectedTags.has(release.tag_name)) continue;
    if (releasesByTag.has(release.tag_name)) {
      throw new Error(`${canonicalRepo} returned duplicate releases for selected tag ${release.tag_name}`);
    }
    releasesByTag.set(release.tag_name, release);
  }
  const missingTags = [...selectedTags]
    .filter((tag) => !releasesByTag.has(tag))
    .sort(compareText);
  if (missingTags.length > 0) {
    throw new GithubReleaseSnapshotNotReadyError(
      `${canonicalRepo} GitHub release list is not yet exposing selected release(s): ${missingTags.join(", ")}`,
    );
  }

  // Reject immutable release identity/metadata conflicts before fanning out
  // to the per-release asset endpoints. The embedded assets field is neither
  // authoritative nor required; every product is inventoried separately.
  for (const product of products) {
    const tag = frozenProductTag(product);
    const data = releasesByTag.get(tag);
    requireObject(data, `${product.id} GitHub release ${tag}`);
    if (
      data.tag_name !== tag
      || data.name !== `${product.id} v${product.version}`
      || data.target_commitish !== lock.source.commit
      || data.prerelease !== product.version.includes("-")
      || typeof data.draft !== "boolean"
    ) {
      throw new Error(`${product.id} GitHub release ${tag} metadata does not match the frozen publication lock`);
    }
  }

  const exactAssetRows = new Map(await mapConcurrent(
    products,
    GITHUB_RELEASE_FALLBACK_QUERY_CONCURRENCY,
    async (product) => {
      const tag = frozenProductTag(product);
      const release = releasesByTag.get(tag);
      const releaseId = normalizeGithubId(release.id, `${product.id} GitHub release ${tag} id`);
      const assets = await requestGithubArrayPages({
        authToken: token,
        context: `${product.id} GitHub release ${tag} asset list`,
        deadlineMs: effectiveDeadline,
        fetchImpl,
        nowImpl,
        sleepImpl,
        urlForPage: (page) => releaseAssetsListApiUrl(canonicalRepo, releaseId, page),
      });
      return [product.id, assets];
    },
  ));

  const releases = products.map((product) => {
    const tag = frozenProductTag(product);
    const data = releasesByTag.get(tag);
    requireObject(data, `${product.id} GitHub release ${tag}`);
    const expectedAssets = expectedByProduct.get(product.id);
    const remoteAssets = exactAssetRows.get(product.id);
    const names = remoteAssets.map((asset) => {
      if (asset === null || Array.isArray(asset) || typeof asset !== "object" || typeof asset.name !== "string") {
        throw new Error(`${product.id} GitHub release ${tag} contains an invalid asset row`);
      }
      return asset.name;
    });
    const expectedNames = expectedAssets.map((asset) => asset.name);
    const actualNameSet = new Set(names);
    const expectedNameSet = new Set(expectedNames);
    const missing = expectedNames.filter((name) => !actualNameSet.has(name));
    const unexpected = names.filter((name) => !expectedNameSet.has(name));
    if (unexpected.length > 0) {
      assertExactReleaseAssetNames({
        product: product.id,
        tag,
        expectedNames,
        actualNames: names,
      });
    }
    if (missing.length > 0) {
      throw new GithubReleaseSnapshotNotReadyError(
        `${product.id} GitHub release ${tag} is not yet exposing frozen asset(s): ${missing.sort(compareText).join(", ")}`,
      );
    }
    if (new Set(names).size !== names.length) {
      throw new Error(`${product.id} GitHub release ${tag} contains duplicate asset names`);
    }
    const byName = new Map(remoteAssets.map((asset) => [asset.name, asset]));
    return {
      assets: expectedAssets.map((expected) =>
        normalizeRemoteAsset(byName.get(expected.name), expected, product.id, tag)),
      draft: data.draft,
      prerelease: data.prerelease,
      product: product.id,
      releaseId: normalizeGithubId(data.id, `${product.id} GitHub release ${tag} id`),
      releaseName: data.name,
      tag,
      targetCommitish: data.target_commitish,
      version: product.version,
    };
  });
  return normalizeGithubReleaseSnapshot(lock, releases);
}

export async function queryLockedGithubReleases(lock, options = {}) {
  const nowImpl = options.nowImpl ?? Date.now;
  const sleepImpl = options.sleepImpl
    ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const deadlineMs = options.deadlineMs ?? githubReleaseQueryDeadline(nowImpl());
  const maxAttempts = options.snapshotMaxAttempts ?? GITHUB_RELEASE_SNAPSHOT_MAX_ATTEMPTS;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts <= 0) {
    throw new Error("GitHub release snapshot maxAttempts must be a positive safe integer");
  }
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await queryLockedGithubReleasesOnce(lock, {
        ...options,
        deadlineMs,
        nowImpl,
        sleepImpl,
      });
    } catch (error) {
      if (!(error instanceof GithubReleaseSnapshotNotReadyError)) {
        throw error;
      }
      lastError = error;
      if (attempt === maxAttempts) {
        throw new Error(
          `GitHub release snapshot readiness retries exhausted after ${maxAttempts} attempts: ${error.message}`,
          { cause: error },
        );
      }
    }
    const delay = Math.min(
      GITHUB_RELEASE_SNAPSHOT_MAX_RETRY_DELAY_MS,
      1_000 * 2 ** (attempt - 1),
    );
    const now = nowImpl();
    if (now + delay >= deadlineMs) {
      throw new Error(`GitHub release snapshot retry would exceed its deadline: ${lastError.message}`);
    }
    await sleepImpl(delay);
  }
  throw lastError;
}

function normalizeAttestationSubjects(subjects, context) {
  if (!Array.isArray(subjects) || subjects.length === 0) {
    throw new Error(`${context} must contain a non-empty subject array`);
  }
  const names = new Set();
  const keys = new Set();
  const normalized = [];
  for (const [index, subject] of subjects.entries()) {
    const subjectContext = `${context} subject[${index}]`;
    assertKeySet(subject, ["digest", "name"], subjectContext);
    if (
      typeof subject.name !== "string"
      || subject.name.length === 0
      || subject.name.includes("/")
      || subject.name.includes("\\")
      || /[\0\r\n]/u.test(subject.name)
    ) {
      throw new Error(`${subjectContext}.name must be a direct asset basename`);
    }
    assertKeySet(subject.digest, ["sha256"], `${subjectContext}.digest`);
    const sha256 = requireSha256(subject.digest.sha256, `${subjectContext}.digest.sha256`);
    const key = `${subject.name}\0${sha256}`;
    if (names.has(subject.name) || keys.has(key)) {
      throw new Error(`${context} contains duplicate or ambiguous subject ${subject.name}`);
    }
    names.add(subject.name);
    keys.add(key);
    normalized.push({ name: subject.name, sha256 });
  }
  return normalized.sort((left, right) =>
    compareText(left.name, right.name) || compareText(left.sha256, right.sha256));
}

function normalizedReceiptSubjects(subjects, context) {
  if (!Array.isArray(subjects)) {
    throw new Error(`${context} subjects must be an array`);
  }
  return normalizeAttestationSubjects(
    subjects.map((subject) => ({
      digest: { sha256: subject?.sha256 },
      name: subject?.name,
    })),
    context,
  );
}

function githubAssetSubjectKey(value) {
  return `${value.name}\0${value.sha256}`;
}

export function assertAttestationSubjectCoverage(assets, attestations) {
  if (!Array.isArray(assets) || !Array.isArray(attestations)) {
    throw new Error("attestation coverage requires asset and attestation arrays");
  }
  if (assets.length === 0 && attestations.length > 0) {
    throw new Error("attestation bundles contaminate a release selection with no frozen GitHub assets");
  }
  const expectedByName = new Map();
  const expectedByKey = new Map();
  for (const asset of assets) {
    requireSha256(asset?.sha256, `${asset?.product ?? "<unknown>"}/${asset?.name ?? "<unknown>"} sha256`);
    if (expectedByName.has(asset.name)) {
      throw new Error(`frozen GitHub assets contain ambiguous repeated subject name ${asset.name}`);
    }
    const key = githubAssetSubjectKey(asset);
    if (expectedByKey.has(key)) {
      throw new Error(`frozen GitHub assets contain duplicate subject ${asset.name}`);
    }
    expectedByName.set(asset.name, asset);
    expectedByKey.set(key, asset);
  }
  const covered = new Set();
  const bundleDigests = new Set();
  const normalized = [];
  for (const [index, attestation] of attestations.entries()) {
    assertKeySet(attestation, ["bundleSha256", "subjects"], `attestation[${index}]`);
    const bundleSha256 = requireSha256(attestation.bundleSha256, `attestation[${index}].bundleSha256`);
    if (bundleDigests.has(bundleSha256)) {
      throw new Error(`attestation bundle ${bundleSha256} was supplied more than once`);
    }
    bundleDigests.add(bundleSha256);
    const subjects = normalizedReceiptSubjects(attestation.subjects, `attestation bundle ${bundleSha256}`);
    for (const subject of subjects) {
      const key = githubAssetSubjectKey(subject);
      if (!expectedByKey.has(key)) {
        const expected = expectedByName.get(subject.name);
        if (expected !== undefined) {
          throw new Error(`attestation bundle ${bundleSha256} subject ${subject.name} digest differs from the frozen GitHub asset`);
        }
        throw new Error(`attestation bundle ${bundleSha256} contains non-frozen subject ${subject.name}`);
      }
      if (covered.has(key)) {
        throw new Error(`signed subject ${subject.name} overlaps multiple attestation bundles`);
      }
      covered.add(key);
    }
    normalized.push({ bundleSha256, subjects });
  }
  const missing = [...expectedByKey]
    .filter(([key]) => !covered.has(key))
    .map(([, asset]) => `${asset.product}/${asset.name}`)
    .sort(compareText);
  if (missing.length > 0) {
    throw new Error(`frozen GitHub assets are missing signed subjects: ${missing.join(", ")}`);
  }
  return normalized.sort((left, right) => compareText(left.bundleSha256, right.bundleSha256));
}

function receiptDigest(receipt) {
  const copy = structuredClone(receipt);
  delete copy.receiptDigest;
  return createHash("sha256").update(stableStringify(copy)).digest("hex");
}

function githubSignerWorkflow(repo) {
  return `${repo}/.github/workflows/release.yml`;
}

export function buildGithubAttestationReceipt({ attestations, lock, releases, repo = repository() }) {
  const canonicalRepo = normalizedRepository(repo);
  const normalizedReleases = normalizeGithubReleaseSnapshot(lock, releases);
  const normalizedAttestations = assertAttestationSubjectCoverage(
    frozenGithubReleaseAssets(lock),
    attestations,
  );
  const receipt = {
    attestations: normalizedAttestations,
    head: lock.source.commit,
    lockDigest: lock.lockDigest,
    releases: normalizedReleases,
    repository: canonicalRepo,
    schema: GITHUB_ATTESTATION_RECEIPT_SCHEMA,
    signerWorkflow: githubSignerWorkflow(canonicalRepo),
    sourceRef: "refs/heads/main",
    sourceTree: lock.source.tree,
  };
  receipt.receiptDigest = receiptDigest(receipt);
  return receipt;
}

export function validateGithubAttestationReceipt(receipt, lock, { repo = repository() } = {}) {
  const canonicalRepo = normalizedRepository(repo);
  assertKeySet(receipt, [
    "attestations",
    "head",
    "lockDigest",
    "receiptDigest",
    "releases",
    "repository",
    "schema",
    "signerWorkflow",
    "sourceRef",
    "sourceTree",
  ], "GitHub attestation receipt");
  if (
    receipt.schema !== GITHUB_ATTESTATION_RECEIPT_SCHEMA
    || receipt.repository !== canonicalRepo
    || receipt.head !== lock.source.commit
    || receipt.sourceTree !== lock.source.tree
    || receipt.lockDigest !== lock.lockDigest
    || receipt.signerWorkflow !== githubSignerWorkflow(canonicalRepo)
    || receipt.sourceRef !== "refs/heads/main"
  ) {
    throw new Error("GitHub attestation receipt identity does not match the repository, source, or publication lock");
  }
  requireSha256(receipt.receiptDigest, "GitHub attestation receipt digest");
  const expectedDigest = receiptDigest(receipt);
  if (receipt.receiptDigest !== expectedDigest) {
    throw new Error(`GitHub attestation receipt digest mismatch: expected ${expectedDigest}, got ${receipt.receiptDigest}`);
  }
  const releases = normalizeGithubReleaseSnapshot(lock, receipt.releases);
  const attestations = assertAttestationSubjectCoverage(
    frozenGithubReleaseAssets(lock),
    receipt.attestations,
  );
  if (
    stableStringify(releases) !== stableStringify(receipt.releases)
    || stableStringify(attestations) !== stableStringify(receipt.attestations)
  ) {
    throw new Error("GitHub attestation receipt is not in deterministic canonical order");
  }
  return receipt;
}

export function assertGithubReleaseSnapshotMatchesReceipt(receipt, releases) {
  if (stableStringify(releases) !== stableStringify(receipt?.releases)) {
    throw new Error("GitHub release or asset IDs, names, sizes, or digests changed after the pre-mutation receipt was created");
  }
}

async function verifyExtensionReleaseAssets(product, version, actualAssets) {
  const manifestName = `${product}-${version}-manifest.json`;
  const propertiesName = `${product}-${version}-manifest.properties`;
  const swiftCarrierName = swiftExtensionCarrierAssetName(product, version);
  const checksumName = `${product}-${version}-release-assets.sha256`;
  const localManifestPath = path.join(ROOT, "target/extension-artifacts", product, "release-assets", manifestName);
  const localSwiftCarrierPath = path.join(ROOT, "target/extension-artifacts", product, "release-assets", swiftCarrierName);
  const localManifest = await readJson(localManifestPath);
  const localSwiftCarrier = await readJson(localSwiftCarrierPath);
  const proofs = new Map();

  const manifestAsset = actualAssets.get(manifestName);
  const manifestSize = expectedAssetSize(manifestAsset.size, manifestName, MAX_CONTROL_ASSET_BYTES);
  const manifestBytes = await requestBytes(manifestAsset.url, manifestName, manifestSize);
  proofs.set(manifestName, { bytes: manifestBytes.byteLength, sha256: sha256Bytes(manifestBytes) });
  const remoteManifest = JSON.parse(new TextDecoder().decode(manifestBytes));
  if (stableStringify(remoteManifest) !== stableStringify(localManifest)) {
    fail(`${product} GitHub release ${await productTag(product, version)} public manifest differs from staged manifest`);
  }
  const extensionAssets = await validateExtensionManifest(
    product,
    version,
    remoteManifest,
    `${product} ${version} public extension manifest`,
  );

  const swiftCarrierAsset = actualAssets.get(swiftCarrierName);
  const swiftCarrierSize = expectedAssetSize(swiftCarrierAsset.size, swiftCarrierName, MAX_CONTROL_ASSET_BYTES);
  const swiftCarrierBytes = await requestBytes(swiftCarrierAsset.url, swiftCarrierName, swiftCarrierSize);
  proofs.set(swiftCarrierName, { bytes: swiftCarrierBytes.byteLength, sha256: sha256Bytes(swiftCarrierBytes) });
  const remoteSwiftCarrier = JSON.parse(new TextDecoder().decode(swiftCarrierBytes));
  if (stableStringify(remoteSwiftCarrier) !== stableStringify(localSwiftCarrier)) {
    fail(`${product} GitHub release ${await productTag(product, version)} Swift iOS carrier differs from staged carrier`);
  }

  const checksumAsset = actualAssets.get(checksumName);
  const checksumSize = expectedAssetSize(checksumAsset.size, checksumName, MAX_CONTROL_ASSET_BYTES);
  const checksumBytes = await requestBytes(checksumAsset.url, checksumName, checksumSize);
  proofs.set(checksumName, { bytes: checksumBytes.byteLength, sha256: sha256Bytes(checksumBytes) });
  const checksums = parseChecksumManifest(checksumBytes, checksumName);
  const checksumCoveredNames = new Set(extensionAssets.map((asset) => asset.name));
  checksumCoveredNames.add(manifestName);
  checksumCoveredNames.add(propertiesName);
  checksumCoveredNames.add(swiftCarrierName);
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
    const manifestAsset = extensionAssets.find((asset) => asset.name === name);
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

  for (const asset of extensionAssets) {
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
  try {
    assertExactReleaseAssetNames({
      product,
      tag,
      expectedNames,
      actualNames: actualAssets.keys(),
    });
  } catch (error) {
    fail(error.message);
  }
  const config = await productConfig(product);
  if (["exact-extension-artifact", "exact-extension-bundle"].includes(config.kind)) {
    await verifyExtensionReleaseAssets(product, version, actualAssets);
  }
  console.log(`${product} GitHub release assets verified for ${tag}: ${assets.join(", ")}`);
}

async function readBoundedRegularFile(file, maximum, context) {
  let stat;
  try {
    stat = await fs.lstat(file);
  } catch (error) {
    throw new Error(`${context} is unavailable: ${error.message}`);
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`${context} must be a regular non-symlink file`);
  }
  if (!Number.isSafeInteger(stat.size) || stat.size < 0 || stat.size > maximum) {
    throw new Error(`${context} exceeds ${maximum} bytes`);
  }
  const bytes = await fs.readFile(file);
  if (bytes.byteLength !== stat.size || bytes.byteLength > maximum) {
    throw new Error(`${context} changed while it was being read`);
  }
  return bytes;
}

function parseJsonBytes(bytes, context) {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error(`${context} is not valid UTF-8: ${error.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${context} is not one JSON value: ${error.message}`);
  }
}

function decodeBundleStatement(bundle, context) {
  requireObject(bundle, context);
  const payload = bundle.dsseEnvelope?.payload;
  if (typeof payload !== "string" || payload.length === 0 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(payload)) {
    throw new Error(`${context} lacks a canonical base64 DSSE payload`);
  }
  const bytes = Buffer.from(payload, "base64");
  if (bytes.toString("base64") !== payload) {
    throw new Error(`${context} DSSE payload is not canonical base64`);
  }
  const statement = parseJsonBytes(bytes, `${context} DSSE statement`);
  requireObject(statement, `${context} DSSE statement`);
  return statement;
}

function statementSubjects(statement, context) {
  if (statement._type !== IN_TOTO_STATEMENT_V1 || statement.predicateType !== SLSA_PROVENANCE_V1) {
    throw new Error(`${context} must be an in-toto v1 SLSA provenance v1 statement`);
  }
  return normalizeAttestationSubjects(statement.subject, context);
}

async function lockedLocalSubject(asset) {
  const file = path.resolve(ROOT, asset.path);
  const relative = path.relative(ROOT, file);
  if (relative === "" || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${asset.product}/${asset.name} frozen path must remain inside the repository`);
  }
  let stat;
  try {
    stat = await fs.lstat(file);
  } catch (error) {
    throw new Error(`${asset.product}/${asset.name} frozen local subject is missing: ${error.message}`);
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`${asset.product}/${asset.name} frozen local subject must be a regular non-symlink file`);
  }
  if (stat.size !== asset.size || path.basename(file) !== asset.name) {
    throw new Error(`${asset.product}/${asset.name} frozen local subject path or size differs from the publication lock`);
  }
  return file;
}

export function ghBundleVerifyArgs({ bundlePath, file, head, repo }) {
  if (typeof head !== "string" || !/^[0-9a-f]{40}$/u.test(head)) {
    throw new Error("attestation source head must be a full lowercase commit SHA");
  }
  const canonicalRepo = normalizedRepository(repo);
  if (typeof file !== "string" || file.length === 0 || typeof bundlePath !== "string" || bundlePath.length === 0) {
    throw new Error("attestation verification requires local subject and bundle paths");
  }
  return [
    "attestation",
    "verify",
    file,
    "--repo",
    canonicalRepo,
    "--bundle",
    bundlePath,
    "--format",
    "json",
    "--signer-workflow",
    githubSignerWorkflow(canonicalRepo),
    "--signer-digest",
    head,
    "--source-ref",
    "refs/heads/main",
    "--source-digest",
    head,
    "--deny-self-hosted-runners",
  ];
}

function runGhBundleVerification({ bundle, bundlePath, file, head, repo }) {
  const args = ghBundleVerifyArgs({ bundlePath, file, head, repo });
  const result = spawnSync("gh", args, {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: GH_ATTESTATION_VERIFY_MAX_OUTPUT_BYTES,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: GH_ATTESTATION_VERIFY_TIMEOUT_MS,
  });
  if (result.error !== undefined) {
    throw new Error(`gh attestation verify failed to start or timed out for ${bundlePath}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    throw new Error(`gh attestation verify failed for ${bundlePath}${detail ? `: ${detail}` : ""}`);
  }
  const output = parseJsonBytes(Buffer.from(result.stdout), `gh verification output for ${bundlePath}`);
  if (!Array.isArray(output) || output.length !== 1) {
    throw new Error(`gh verification output for ${bundlePath} must contain exactly one verified attestation`);
  }
  const verified = requireObject(output[0], `gh verification output for ${bundlePath}`);
  const verifiedBundle = verified.attestation?.bundle;
  if (stableStringify(verifiedBundle) !== stableStringify(bundle)) {
    throw new Error(`gh verification output for ${bundlePath} does not contain the supplied bundle`);
  }
  const statement = verified.verificationResult?.statement;
  requireObject(statement, `gh verification statement for ${bundlePath}`);
  return statementSubjects(statement, `gh verified statement for ${bundlePath}`);
}

export async function verifyAttestationBundles(lock, bundlePaths, {
  repo = repository(),
  verifyBundleImpl = runGhBundleVerification,
} = {}) {
  const canonicalRepo = normalizedRepository(repo);
  if (!Array.isArray(bundlePaths)) {
    throw new Error("attestation bundle paths must be an array");
  }
  const assets = frozenGithubReleaseAssets(lock);
  if (assets.length === 0 && bundlePaths.length > 0) {
    throw new Error("attestation bundles contaminate a release selection with no frozen GitHub assets");
  }
  const expectedByKey = new Map(assets.map((asset) => [githubAssetSubjectKey(asset), asset]));
  const records = [];
  const suppliedPaths = new Set();
  const suppliedDigests = new Set();
  for (const bundlePath of bundlePaths) {
    const absolute = path.resolve(bundlePath);
    if (suppliedPaths.has(absolute)) {
      throw new Error(`attestation bundle path was supplied more than once: ${bundlePath}`);
    }
    suppliedPaths.add(absolute);
    const bytes = await readBoundedRegularFile(absolute, MAX_ATTESTATION_BUNDLE_BYTES, `attestation bundle ${bundlePath}`);
    const bundleSha256 = sha256Bytes(bytes);
    if (suppliedDigests.has(bundleSha256)) {
      throw new Error(`attestation bundle ${bundleSha256} was supplied more than once`);
    }
    suppliedDigests.add(bundleSha256);
    const bundle = parseJsonBytes(bytes, `attestation bundle ${bundlePath}`);
    const untrustedSubjects = statementSubjects(
      decodeBundleStatement(bundle, `attestation bundle ${bundlePath}`),
      `unverified statement for ${bundlePath}`,
    );
    const representatives = untrustedSubjects
      .map((subject) => expectedByKey.get(githubAssetSubjectKey(subject)))
      .filter((asset) => asset !== undefined)
      .sort((left, right) => left.size - right.size || compareText(left.name, right.name));
    if (representatives.length === 0) {
      throw new Error(`attestation bundle ${bundlePath} contains no frozen GitHub asset subject`);
    }
    const file = await lockedLocalSubject(representatives[0]);
    const verifiedSubjects = await verifyBundleImpl({
      bundle,
      bundlePath: absolute,
      file,
      head: lock.source.commit,
      repo: canonicalRepo,
    });
    if (stableStringify(verifiedSubjects) !== stableStringify(untrustedSubjects)) {
      throw new Error(`cryptographically verified subjects for ${bundlePath} differ from its DSSE statement`);
    }
    records.push({ bundleSha256, subjects: verifiedSubjects });
  }
  return assertAttestationSubjectCoverage(assets, records);
}

async function readReceipt(file) {
  const absolute = path.resolve(file);
  const bytes = await readBoundedRegularFile(absolute, MAX_ATTESTATION_RECEIPT_BYTES, `GitHub attestation receipt ${file}`);
  return parseJsonBytes(bytes, `GitHub attestation receipt ${file}`);
}

export async function writeImmutableReceipt(file, receipt, {
  linkImpl = (source, target) => fs.link(source, target),
} = {}) {
  const absolute = path.resolve(file);
  const body = `${JSON.stringify(receipt, null, 2)}\n`;
  if (Buffer.byteLength(body) > MAX_ATTESTATION_RECEIPT_BYTES) {
    throw new Error(`GitHub attestation receipt ${file} exceeds ${MAX_ATTESTATION_RECEIPT_BYTES} bytes`);
  }
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  const temporary = `${absolute}.tmp-${process.pid}-${randomUUID()}`;
  let operationError;
  try {
    await fs.writeFile(temporary, body, { encoding: "utf8", flag: "wx", mode: 0o600 });
    try {
      // Linking a fully-written temporary inode publishes the receipt in one
      // filesystem operation. An interruption can leave a disposable temp,
      // never a truncated immutable target that blocks safe recovery.
      await linkImpl(temporary, absolute);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const existing = await readBoundedRegularFile(
        absolute,
        MAX_ATTESTATION_RECEIPT_BYTES,
        `GitHub attestation receipt ${file}`,
      );
      if (existing.toString("utf8") !== body) {
        throw new Error(`refusing to replace existing non-identical GitHub attestation receipt ${file}`);
      }
    }
  } catch (error) {
    operationError = error;
  }
  let cleanupError;
  try {
    await fs.unlink(temporary);
  } catch (error) {
    if (error?.code !== "ENOENT") cleanupError = error;
  }
  if (operationError !== undefined && cleanupError !== undefined) {
    throw new AggregateError(
      [operationError, cleanupError],
      `GitHub attestation receipt ${file} failed and its temporary file could not be removed`,
    );
  }
  if (operationError !== undefined) throw operationError;
  if (cleanupError !== undefined) throw cleanupError;
  return absolute;
}

function parseReceiptArgs(command, argv) {
  const args = {
    attestationBundles: [],
    headRef: "HEAD",
    output: undefined,
    productsJson: undefined,
    publicationLock: undefined,
    receipt: undefined,
    repo: repository(),
  };
  const assign = (key, value, flag) => {
    if (value === undefined || (value.length === 0 && flag !== "--attestation-bundle")) {
      throw new Error(`${flag} requires a value`);
    }
    args[key] = value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const separator = argument.indexOf("=");
    const flag = separator === -1 ? argument : argument.slice(0, separator);
    const value = separator === -1 ? argv[++index] : argument.slice(separator + 1);
    if (flag === "--attestation-bundle") {
      if (value === undefined) throw new Error("--attestation-bundle requires a value");
      if (value.length > 0) args.attestationBundles.push(value);
    } else if (flag === "--head-ref") {
      assign("headRef", value, flag);
    } else if (flag === "--output") {
      assign("output", value, flag);
    } else if (flag === "--products-json") {
      assign("productsJson", value, flag);
    } else if (flag === "--publication-lock") {
      assign("publicationLock", value, flag);
    } else if (flag === "--receipt") {
      assign("receipt", value, flag);
    } else if (flag === "--repo") {
      assign("repo", value, flag);
    } else if (flag === "--help" || flag === "-h") {
      return { help: true };
    } else {
      throw new Error(`unknown ${command} argument ${argument}`);
    }
  }
  if (!args.publicationLock) {
    throw new Error(`${command} requires --publication-lock`);
  }
  if (command === "pre-mutation" && !args.output) {
    throw new Error("pre-mutation requires --output");
  }
  if (command === "finalize" && !args.receipt) {
    throw new Error("finalize requires --receipt");
  }
  if (command === "pre-mutation" && args.receipt !== undefined) {
    throw new Error("pre-mutation does not accept --receipt");
  }
  if (command === "finalize" && (args.output !== undefined || args.attestationBundles.length > 0)) {
    throw new Error("finalize does not accept --output or --attestation-bundle");
  }
  return args;
}

function assertRequestedProducts(lock, productsJson) {
  if (productsJson === undefined) return;
  let products;
  try {
    products = JSON.parse(productsJson);
  } catch (error) {
    throw new Error(`--products-json must be valid JSON: ${error.message}`);
  }
  if (!Array.isArray(products) || products.some((product) => typeof product !== "string" || product.length === 0)) {
    throw new Error("--products-json must be a JSON string array");
  }
  exactProductSet(
    lock.products.map((product) => product.id),
    products,
    "requested products and frozen publication lock products",
  );
}

function receiptUsage() {
  console.log("usage:");
  console.log("  tools/release/verify_github_release_attestations.mjs pre-mutation --publication-lock FILE --head-ref REF --output FILE [--products-json JSON] [--attestation-bundle FILE ...]");
  console.log("  tools/release/verify_github_release_attestations.mjs finalize --publication-lock FILE --head-ref REF --receipt FILE [--products-json JSON]");
}

async function receiptMain(command, argv) {
  const args = parseReceiptArgs(command, argv);
  if (args.help) {
    receiptUsage();
    return;
  }
  const lock = loadPublicationLock(path.resolve(args.publicationLock));
  assertPublicationLockSource(lock, args.headRef);
  assertRequestedProducts(lock, args.productsJson);
  const repo = normalizedRepository(args.repo);
  if (command === "pre-mutation") {
    const releases = await queryLockedGithubReleases(lock, { repo });
    const attestations = await verifyAttestationBundles(lock, args.attestationBundles, { repo });
    const receipt = buildGithubAttestationReceipt({ attestations, lock, releases, repo });
    const output = await writeImmutableReceipt(args.output, receipt);
    console.log(
      `GitHub release attestation receipt created at ${rel(output)} `
      + `(${receipt.releases.length} releases, ${frozenGithubReleaseAssets(lock).length} assets, `
      + `${receipt.attestations.length} signed bundles, ${receipt.receiptDigest})`,
    );
    return;
  }
  const receipt = validateGithubAttestationReceipt(await readReceipt(args.receipt), lock, { repo });
  const releases = await queryLockedGithubReleases(lock, { repo });
  assertGithubReleaseSnapshotMatchesReceipt(receipt, releases);
  console.log(
    `GitHub release attestation receipt finalized (${receipt.releases.length} releases, `
    + `${frozenGithubReleaseAssets(lock).length} assets, ${receipt.receiptDigest})`,
  );
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

function parseLegacyArgs(argv) {
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
      receiptUsage();
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
  const signerWorkflow = githubSignerWorkflow(repo);
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

async function legacyMain(argv) {
  const args = parseLegacyArgs(argv);
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

async function main(argv) {
  const command = argv[0];
  if (command === "pre-mutation" || command === "finalize") {
    try {
      await receiptMain(command, argv.slice(1));
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
    return;
  }
  await legacyMain(argv);
}

if (import.meta.main) {
  await main(Bun.argv.slice(2));
}
