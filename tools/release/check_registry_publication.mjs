#!/usr/bin/env bun
import { readFile } from "node:fs/promises";
import path from "node:path";
import { currentVersion } from "./product-version.mjs";
import {
  loadPublicationCatalog,
  REGISTRY_KIND_TO_ECOSYSTEM,
} from "./publication-catalog.mjs";
import { loadPublicationLock, lockedCarriers } from "./publication-lock.mjs";
import {
  retryAfterSeconds,
  registryRetryDelaySeconds,
  registryStatusRetryable,
} from "./registry-http-retry.mjs";

const ROOT = path.resolve(import.meta.dir, "../..");
const CRATES_IO_API = process.env.CRATES_IO_API || "https://crates.io/api/v1";
const NPM_REGISTRY = process.env.NPM_REGISTRY || "https://registry.npmjs.org";
const JSR_REGISTRY = process.env.JSR_REGISTRY || "https://jsr.io";
const JSR_API_BASE = process.env.JSR_API_BASE || "https://api.jsr.io";
const MAVEN_CENTRAL_BASE = process.env.MAVEN_CENTRAL_BASE || "https://repo1.maven.org/maven2";
const REQUEST_ATTEMPTS = Math.max(1, Number.parseInt(process.env.OLIPHAUNT_REGISTRY_QUERY_ATTEMPTS || "8", 10) || 8);
const REQUEST_RETRY_DELAY_SECONDS = Math.max(0, Number.parseFloat(process.env.OLIPHAUNT_REGISTRY_QUERY_RETRY_DELAY || "1.0") || 0);
const REQUEST_TIMEOUT_MS = 20_000;
const DEADLINE_CLEANUP_RESERVE_MS = 5_000;
export const CRATES_IO_READ_INTERVAL_SECONDS = 1;
export const CRATES_IO_READ_RETRY_BUDGET_SECONDS = 10 * 60;
export const CRATES_IO_RATE_LIMIT_FALLBACK_SECONDS = 60;
const MAX_REGISTRY_JSON_BYTES = 8 * 1024 * 1024;
const REGISTRY_TARGETS = new Set(["crates-io", "npm", "jsr", "maven-central"]);
const REGISTRY_KINDS = new Set(["crates", "npm", "jsr", "maven"]);
const REGISTRY_KIND_BY_ECOSYSTEM = new Map(
  Object.entries(REGISTRY_KIND_TO_ECOSYSTEM).map(([kind, ecosystem]) => [ecosystem, kind]),
);
const USER_AGENT = "oliphaunt-release-check (https://github.com/f0rr0/oliphaunt)";
const JSR_PACKAGE_IDENTITY_RE = /^@([a-z][a-z0-9]*(?:-[a-z0-9]+)*)\/([a-z][a-z0-9]*(?:-[a-z0-9]+)*)$/u;

const caches = {
  releaseConfig: undefined,
  packageByProduct: undefined,
  publicationLock: undefined,
};

class RegistryHttpError extends Error {
  constructor(status, label) {
    super(`HTTP ${status} for ${label}`);
    this.status = status;
  }
}

class RegistryResponseError extends Error {}

function registryDeadlineRemainingMilliseconds(context, nowImpl = () => Date.now()) {
  const raw = process.env.REGISTRY_MUTATION_DEADLINE_EPOCH?.trim();
  if (!raw) return null;
  if (!/^[1-9][0-9]*$/u.test(raw)) {
    throw new RegistryResponseError("REGISTRY_MUTATION_DEADLINE_EPOCH must be a positive Unix timestamp");
  }
  const deadlineMilliseconds = Number(raw) * 1000;
  if (!Number.isSafeInteger(deadlineMilliseconds)) {
    throw new RegistryResponseError("REGISTRY_MUTATION_DEADLINE_EPOCH exceeds the safe timestamp range");
  }
  const remaining = deadlineMilliseconds - nowImpl() - DEADLINE_CLEANUP_RESERVE_MS;
  if (remaining <= 0) {
    throw new RegistryResponseError(
      `${context} refused because the shared registry mutation deadline has been reached`,
    );
  }
  return remaining;
}

export function registryRequestTimeoutMilliseconds(context, {
  nowImpl = () => Date.now(),
} = {}) {
  const remaining = registryDeadlineRemainingMilliseconds(context, nowImpl);
  return remaining === null ? REQUEST_TIMEOUT_MS : Math.max(1, Math.min(REQUEST_TIMEOUT_MS, remaining));
}

export async function boundedRegistrySleep(seconds, context, {
  nowImpl = () => Date.now(),
  sleepImpl = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
} = {}) {
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw new RegistryResponseError(`${context} requested an invalid registry retry delay`);
  }
  const milliseconds = seconds * 1000;
  const remaining = registryDeadlineRemainingMilliseconds(context, nowImpl);
  if (remaining !== null && milliseconds >= remaining) {
    throw new RegistryResponseError(
      `${context} cannot wait ${Math.ceil(seconds)}s before the shared registry mutation deadline`,
    );
  }
  if (milliseconds > 0) await sleepImpl(milliseconds);
}

export async function readBoundedRegistryJson(response, label, maximum = MAX_REGISTRY_JSON_BYTES) {
  if (!Number.isSafeInteger(maximum) || maximum < 1) {
    throw new RegistryResponseError("registry response byte limit must be a positive safe integer");
  }
  const contentLength = response.headers?.get?.("content-length");
  if (contentLength !== null && contentLength !== undefined) {
    const declared = Number(contentLength);
    if (!Number.isSafeInteger(declared) || declared < 0) {
      await response.body?.cancel?.().catch(() => {});
      throw new RegistryResponseError(`${label} returned an invalid Content-Length`);
    }
    if (declared > maximum) {
      await response.body?.cancel?.().catch(() => {});
      throw new RegistryResponseError(`${label} response exceeds ${maximum} bytes`);
    }
  }
  const reader = response.body?.getReader?.();
  let bytes;
  if (reader === undefined) {
    bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > maximum) {
      throw new RegistryResponseError(`${label} response exceeds ${maximum} bytes`);
    }
  } else {
    const chunks = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maximum) {
          await reader.cancel().catch(() => {});
          throw new RegistryResponseError(`${label} response exceeds ${maximum} bytes`);
        }
        chunks.push(Buffer.from(value));
      }
    } finally {
      reader.releaseLock();
    }
    bytes = Buffer.concat(chunks, size);
  }
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new RegistryResponseError(`${label} returned invalid JSON: ${error.message}`);
  }
}

function fail(message) {
  console.error(`check_registry_publication.mjs: ${message}`);
  process.exit(1);
}

function rel(file) {
  const relative = path.relative(ROOT, file);
  return relative.startsWith("..") || path.isAbsolute(relative) ? file : relative.split(path.sep).join("/");
}

async function readJson(file) {
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch {
    fail(`missing ${rel(file)}`);
  }
  const value = JSON.parse(text);
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    fail(`${rel(file)} must contain a JSON object`);
  }
  return value;
}

async function releaseConfig() {
  if (caches.releaseConfig === undefined) {
    caches.releaseConfig = await readJson(path.join(ROOT, "release-please-config.json"));
  }
  return caches.releaseConfig;
}

function assertRelative(value, context) {
  if (typeof value !== "string" || value.length === 0) {
    fail(`${context} must be a non-empty string`);
  }
  const parts = value.split(/[\\/]/u);
  if (path.isAbsolute(value) || /^[A-Za-z]:[\\/]/u.test(value) || parts.includes("..")) {
    fail(`${context} must stay inside the repository: ${JSON.stringify(value)}`);
  }
  return value;
}

async function packageByProduct() {
  if (caches.packageByProduct !== undefined) {
    return caches.packageByProduct;
  }
  const config = await releaseConfig();
  const packages = config.packages;
  if (packages === null || Array.isArray(packages) || typeof packages !== "object") {
    fail("release-please-config.json must define packages");
  }
  const byProduct = new Map();
  for (const [rawPackagePath, packageConfig] of Object.entries(packages)) {
    if (packageConfig === null || Array.isArray(packageConfig) || typeof packageConfig !== "object") {
      fail(`${rawPackagePath} release-please config must be an object`);
    }
    const component = packageConfig.component;
    if (typeof component !== "string" || component.length === 0) {
      fail(`${rawPackagePath}.component must be a non-empty string`);
    }
    if (byProduct.has(component)) {
      fail(`duplicate release-please component ${component}`);
    }
    const packagePath = assertRelative(rawPackagePath, `${component}.packagePath`);
    byProduct.set(component, { packagePath, packageConfig });
  }
  caches.packageByProduct = byProduct;
  return byProduct;
}

async function productIds() {
  return [...(await packageByProduct()).keys()];
}

async function productCrates(product) {
  const catalog = loadPublicationCatalog("check_registry_publication.mjs", { products: [product] });
  const productRow = catalog.products.find((row) => row.id === product);
  if (!productRow?.publishTargets.includes("crates-io")) {
    fail(`${product} does not publish to crates.io`);
  }
  const crates = catalog.carriers
    .filter((carrier) => carrier.product === product && carrier.ecosystem === "cargo")
    .map((carrier) => carrier.name);
  if (crates.length === 0) {
    fail(`${product} does not declare Cargo registry packages`);
  }
  const duplicates = [...new Set(crates.filter((crate, index) => crates.indexOf(crate) !== index))].sort();
  if (duplicates.length > 0) {
    fail(`${product} declares duplicate Cargo registry packages: ${duplicates.join(", ")}`);
  }
  return crates.sort();
}

function packageLabel(pkg) {
  return `${pkg.kind}:${pkg.name}@${pkg.version}`;
}

function identityLabel(pkg) {
  return `${pkg.kind}:${pkg.name}`;
}

export function productRegistryPackagesFromLock(
  publicationLock,
  product,
  { versionOverride = undefined, registryKind = undefined } = {},
) {
  const productRow = publicationLock.products.find((row) => row.id === product);
  if (productRow === undefined) {
    fail(`publication lock does not contain release product ${JSON.stringify(product)}`);
  }
  if (versionOverride !== undefined && versionOverride !== productRow.version) {
    fail(`${product} requested version ${versionOverride} does not match frozen publication-lock version ${productRow.version}`);
  }
  const ecosystemByKind = new Map([["crates", "cargo"], ["npm", "npm"], ["maven", "maven"], ["jsr", "jsr"]]);
  if (registryKind !== undefined && !ecosystemByKind.has(registryKind)) {
    fail(`unsupported registry kind ${JSON.stringify(registryKind)}`);
  }
  const ecosystem = registryKind === undefined ? undefined : ecosystemByKind.get(registryKind);
  const kindByEcosystem = new Map([["cargo", "crates"], ["npm", "npm"], ["maven", "maven"], ["jsr", "jsr"]]);
  const packages = lockedCarriers(publicationLock, { product, ecosystem }).map((carrier) => ({
    kind: kindByEcosystem.get(carrier.ecosystem),
    name: carrier.name,
    version: carrier.version,
  }));
  if (registryKind !== undefined && packages.length === 0) {
    fail(`${product} has no ${registryKind} registry packages in the publication lock`);
  }
  return packages;
}

export async function productRegistryPackages(product, { versionOverride = undefined, registryKind = undefined } = {}) {
  const publicationLockPath = process.env.OLIPHAUNT_PUBLICATION_LOCK;
  if (publicationLockPath) {
    if (caches.publicationLock === undefined) {
      caches.publicationLock = loadPublicationLock(path.resolve(ROOT, publicationLockPath));
    }
    return productRegistryPackagesFromLock(caches.publicationLock, product, {
      versionOverride,
      registryKind,
    });
  }
  const version = versionOverride || (await currentVersion(product));
  const catalog = loadPublicationCatalog("check_registry_publication.mjs", { products: [product] });
  const productRow = catalog.products.find((row) => row.id === product);
  const publishTargets = new Set(productRow?.publishTargets ?? []);
  const expectedKinds = new Map([
    ["crates-io", "crates"],
    ["npm", "npm"],
    ["jsr", "jsr"],
    ["maven-central", "maven"],
  ]);
  const packages = catalog.carriers
    .filter((carrier) => carrier.product === product)
    .map((carrier) => ({
      kind: REGISTRY_KIND_BY_ECOSYSTEM.get(carrier.ecosystem),
      name: carrier.name,
      version,
    }));
  const targetByKind = new Map([...expectedKinds].map(([target, kind]) => [kind, target]));
  const stalePackages = packages
    .filter((pkg) => !publishTargets.has(targetByKind.get(pkg.kind)))
    .map(identityLabel)
    .sort();
  if (stalePackages.length > 0) {
    fail(`${product} publication catalog contains entries without a matching registry publish target: ${stalePackages.join(", ")}`);
  }
  const duplicateIdentities = packages
    .map(identityLabel)
    .filter((identity, index, identities) => identities.indexOf(identity) !== index);
  if (duplicateIdentities.length > 0) {
    fail(`${product}.registry_packages contains duplicate identities: ${[...new Set(duplicateIdentities)].sort().join(", ")}`);
  }
  const missingKinds = [];
  for (const [target, kind] of expectedKinds.entries()) {
    if (publishTargets.has(target) && !packages.some((pkg) => pkg.kind === kind)) {
      missingKinds.push(kind);
    }
  }
  if (missingKinds.length > 0) {
    const selectedTargets = [...publishTargets].filter((target) => REGISTRY_TARGETS.has(target)).sort();
    fail(`${product} publishes to ${JSON.stringify(selectedTargets)} but is missing registry_packages entries for: ${missingKinds.join(", ")}`);
  }
  let filtered = packages;
  if (registryKind !== undefined) {
    if (!REGISTRY_KINDS.has(registryKind)) {
      fail(`unsupported registry kind ${JSON.stringify(registryKind)}`);
    }
    filtered = packages.filter((pkg) => pkg.kind === registryKind);
    if (filtered.length === 0) {
      fail(`${product} has no ${registryKind} registry packages to check`);
    }
  }
  return filtered;
}

async function requestJson(url, label, { fetchImpl = fetch } = {}) {
  let lastError;
  for (let attempt = 0; attempt < REQUEST_ATTEMPTS; attempt += 1) {
    let retryHeaders;
    try {
      const response = await fetchImpl(url, {
        headers: {
          Accept: "application/json",
          "User-Agent": USER_AGENT,
        },
        redirect: "follow",
        signal: AbortSignal.timeout(registryRequestTimeoutMilliseconds(`registry request for ${label}`)),
      });
      if (response.ok) {
        return await readBoundedRegistryJson(response, label);
      }
      const error = new RegistryHttpError(response.status, label);
      const headers = response.headers;
      await response.body?.cancel?.().catch(() => {});
      if (!registryStatusRetryable(response.status)) {
        throw error;
      }
      retryHeaders = headers;
      lastError = error;
    } catch (error) {
      lastError = error;
      if (error instanceof RegistryResponseError) {
        throw error;
      }
      if (error instanceof RegistryHttpError && !registryStatusRetryable(error.status)) {
        throw error;
      }
    }
    if (attempt + 1 < REQUEST_ATTEMPTS) {
      await boundedRegistrySleep(registryRetryDelaySeconds({
        headers: retryHeaders,
        attempt,
        baseSeconds: REQUEST_RETRY_DELAY_SECONDS,
      }), `registry retry for ${label}`);
    }
  }
  throw lastError ?? new Error(`failed to query ${label}`);
}

async function urlExistsViaGet(url, options = {}) {
  return urlExists(url, { ...options, method: "GET", allowMethodFallback: false });
}

export function cratesIoReadRetryDelaySeconds({ headers, status, attempt, now = Date.now() }) {
  if (status === 429) {
    const requested = retryAfterSeconds(headers, now);
    if (requested !== null) return requested;
    return Math.min(300, CRATES_IO_RATE_LIMIT_FALLBACK_SECONDS * (2 ** attempt));
  }
  return registryRetryDelaySeconds({ headers, attempt, now });
}

export async function urlExists(url, {
  method = "HEAD",
  allowMethodFallback = true,
  fetchImpl = fetch,
  sleepImpl = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  nowImpl = () => Date.now(),
  beforeRequestSeconds = 0,
  retryBudgetSeconds = null,
  retryDelayImpl = ({ headers, attempt, now }) =>
    registryRetryDelaySeconds({ headers, attempt, baseSeconds: REQUEST_RETRY_DELAY_SECONDS, now }),
  retryContext = `registry retry for ${url}`,
} = {}) {
  let lastError;
  let retryDelaySpentSeconds = 0;
  for (let attempt = 0; attempt < REQUEST_ATTEMPTS; attempt += 1) {
    let retryHeaders;
    let retryStatus;
    try {
      await boundedRegistrySleep(beforeRequestSeconds, `registry read pacing for ${url}`, {
        nowImpl,
        sleepImpl,
      });
      const response = await fetchImpl(url, {
        method,
        headers: {
          Accept: "application/json",
          "User-Agent": USER_AGENT,
        },
        redirect: "follow",
        signal: AbortSignal.timeout(registryRequestTimeoutMilliseconds(`registry request for ${url}`, { nowImpl })),
      });
      if (response.ok) {
        await response.body?.cancel?.().catch(() => {});
        return true;
      }
      if (response.status === 404) {
        await response.body?.cancel?.().catch(() => {});
        return false;
      }
      if (response.status === 405 && method === "HEAD" && allowMethodFallback) {
        await response.body?.cancel?.().catch(() => {});
        return urlExistsViaGet(url, {
          fetchImpl,
          sleepImpl,
          nowImpl,
          beforeRequestSeconds,
          retryBudgetSeconds,
          retryDelayImpl,
          retryContext,
        });
      }
      const error = new RegistryHttpError(response.status, url);
      const headers = response.headers;
      await response.body?.cancel?.().catch(() => {});
      if (!registryStatusRetryable(response.status)) {
        fail(`registry returned HTTP ${response.status} for ${url}`);
      }
      retryHeaders = headers;
      retryStatus = response.status;
      lastError = error;
    } catch (error) {
      lastError = error;
      if (error instanceof RegistryResponseError) {
        throw error;
      }
      if (error instanceof RegistryHttpError && !registryStatusRetryable(error.status)) {
        fail(`registry returned HTTP ${error.status} for ${url}`);
      }
    }
    if (attempt + 1 < REQUEST_ATTEMPTS) {
      const delaySeconds = retryDelayImpl({
        headers: retryHeaders,
        status: retryStatus,
        attempt,
        now: nowImpl(),
      });
      if (!Number.isFinite(delaySeconds) || delaySeconds < 0) {
        throw new RegistryResponseError(`${retryContext} requested an invalid delay`);
      }
      if (
        retryBudgetSeconds !== null
        && delaySeconds > retryBudgetSeconds - retryDelaySpentSeconds
      ) {
        throw new RegistryResponseError(
          `${retryContext} exceeds its bounded ${retryBudgetSeconds}s retry-delay budget`,
        );
      }
      retryDelaySpentSeconds += delaySeconds;
      await boundedRegistrySleep(delaySeconds, retryContext, { nowImpl, sleepImpl });
    }
  }
  if (lastError instanceof RegistryHttpError) {
    fail(`registry returned HTTP ${lastError.status} for ${url}`);
  }
  fail(`failed to query registry URL ${url}: ${lastError}`);
}

export async function cratesioUrlExists(url, label, {
  fetchImpl = fetch,
  sleepImpl = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  nowImpl = () => Date.now(),
} = {}) {
  try {
    return await urlExists(url, {
      method: "GET",
      allowMethodFallback: false,
      fetchImpl,
      sleepImpl,
      nowImpl,
      beforeRequestSeconds: CRATES_IO_READ_INTERVAL_SECONDS,
      retryBudgetSeconds: CRATES_IO_READ_RETRY_BUDGET_SECONDS,
      retryDelayImpl: cratesIoReadRetryDelaySeconds,
      retryContext: `crates.io existence retry for ${label}`,
    });
  } catch (error) {
    if (error instanceof RegistryHttpError && error.status === 404) {
      return false;
    }
    throw error;
  }
}

async function crateVersionExists(crate, version) {
  const cratePath = encodeURIComponent(crate);
  const versionPath = encodeURIComponent(version);
  const url = `${CRATES_IO_API.replace(/\/+$/u, "")}/crates/${cratePath}/${versionPath}`;
  return cratesioUrlExists(url, `${crate} ${version}`);
}

async function crateExists(crate) {
  const cratePath = encodeURIComponent(crate);
  const url = `${CRATES_IO_API.replace(/\/+$/u, "")}/crates/${cratePath}`;
  return cratesioUrlExists(url, crate);
}

async function npmPackageMetadata(packageName) {
  const packagePath = encodeURIComponent(packageName);
  const url = `${NPM_REGISTRY.replace(/\/+$/u, "")}/${packagePath}`;
  try {
    const data = await requestJson(url, packageName);
    return data && !Array.isArray(data) && typeof data === "object" ? data : undefined;
  } catch (error) {
    if (error instanceof RegistryHttpError && error.status === 404) {
      return undefined;
    }
    if (error instanceof RegistryHttpError) {
      fail(`npm registry returned HTTP ${error.status} for ${packageName}`);
    }
    fail(`failed to query npm registry for ${packageName}: ${error}`);
  }
}

async function npmVersionExists(packageName, version) {
  const data = await npmPackageMetadata(packageName);
  if (data === undefined) {
    return false;
  }
  const versions = data.versions;
  return versions !== null && !Array.isArray(versions) && typeof versions === "object" && version in versions;
}

async function npmPackageExists(packageName) {
  return (await npmPackageMetadata(packageName)) !== undefined;
}

function mavenCoordinatePaths(coordinate, version = undefined) {
  const parts = coordinate.split(":");
  if (parts.length !== 2 || parts.some((part) => part.length === 0)) {
    fail(`invalid Maven coordinate ${JSON.stringify(coordinate)}; expected group:artifact`);
  }
  const [group, artifact] = parts;
  const groupPath = group.split(".").map((part) => encodeURIComponent(part)).join("/");
  const artifactPath = encodeURIComponent(artifact);
  if (version === undefined) {
    return `${MAVEN_CENTRAL_BASE.replace(/\/+$/u, "")}/${groupPath}/${artifactPath}/maven-metadata.xml`;
  }
  const versionPath = encodeURIComponent(version);
  return `${MAVEN_CENTRAL_BASE.replace(/\/+$/u, "")}/${groupPath}/${artifactPath}/${versionPath}/${artifactPath}-${versionPath}.pom`;
}

async function mavenVersionExists(coordinate, version) {
  return urlExists(mavenCoordinatePaths(coordinate, version));
}

async function mavenCoordinateExists(coordinate) {
  return urlExists(mavenCoordinatePaths(coordinate));
}

function jsrPackageIdentity(packageName) {
  const match = typeof packageName === "string" ? packageName.match(JSR_PACKAGE_IDENTITY_RE) : null;
  if (match === null) {
    throw new RegistryResponseError(`invalid JSR package ${JSON.stringify(packageName)}; expected @scope/name`);
  }
  return { scope: match[1], name: match[2] };
}

function jsrMetaUrl(packageName) {
  let identity;
  try {
    identity = jsrPackageIdentity(packageName);
  } catch (error) {
    fail(error.message);
  }
  const { scope, name } = identity;
  return `${JSR_REGISTRY.replace(/\/+$/u, "")}/@${encodeURIComponent(scope)}/${encodeURIComponent(name)}/meta.json`;
}

function jsrManagementPackageUrl(packageName, apiBase = JSR_API_BASE) {
  const { scope, name } = jsrPackageIdentity(packageName);
  return `${apiBase.replace(/\/+$/u, "")}/scopes/${encodeURIComponent(scope)}/packages/${encodeURIComponent(name)}`;
}

export async function jsrManagementPackageExists(packageName, {
  apiBase = JSR_API_BASE,
  fetchImpl = fetch,
} = {}) {
  // A package created and linked for OIDC has no registry meta.json until its
  // first version exists. The anonymous management GET is authoritative only
  // for identity existence; jsrVersionExists deliberately stays on jsr.io.
  const expected = jsrPackageIdentity(packageName);
  let data;
  try {
    data = await requestJson(
      jsrManagementPackageUrl(packageName, apiBase),
      `JSR package identity ${packageName}`,
      { fetchImpl },
    );
  } catch (error) {
    if (error instanceof RegistryHttpError && error.status === 404) {
      return false;
    }
    throw error;
  }
  if (
    data === null
    || Array.isArray(data)
    || typeof data !== "object"
    || data.scope !== expected.scope
    || data.name !== expected.name
  ) {
    throw new RegistryResponseError(
      `JSR management API returned mismatched identity metadata for ${packageName}`,
    );
  }
  return true;
}

async function jsrPackageMetadata(packageName) {
  try {
    const data = await requestJson(jsrMetaUrl(packageName), packageName);
    return data && !Array.isArray(data) && typeof data === "object" ? data : undefined;
  } catch (error) {
    if (error instanceof RegistryHttpError && error.status === 404) {
      return undefined;
    }
    if (error instanceof RegistryHttpError) {
      fail(`JSR registry returned HTTP ${error.status} for ${packageName}`);
    }
    fail(`failed to query JSR registry for ${packageName}: ${error}`);
  }
}

async function jsrVersionExists(packageName, version) {
  const data = await jsrPackageMetadata(packageName);
  if (data === undefined) {
    return false;
  }
  const versions = data.versions;
  return versions !== null && !Array.isArray(versions) && typeof versions === "object" && version in versions;
}

async function jsrPackageExists(packageName) {
  try {
    return await jsrManagementPackageExists(packageName);
  } catch (error) {
    if (error instanceof RegistryHttpError) {
      fail(`JSR management API returned HTTP ${error.status} for ${packageName}`);
    }
    fail(`failed to query JSR management API for ${packageName}: ${error}`);
  }
}

async function packageExists(pkg) {
  if (pkg.kind === "crates") {
    return crateVersionExists(pkg.name, pkg.version);
  }
  if (pkg.kind === "npm") {
    return npmVersionExists(pkg.name, pkg.version);
  }
  if (pkg.kind === "jsr") {
    return jsrVersionExists(pkg.name, pkg.version);
  }
  if (pkg.kind === "maven") {
    return mavenVersionExists(pkg.name, pkg.version);
  }
  fail(`unsupported registry package kind ${JSON.stringify(pkg.kind)}`);
}

async function packageIdentityExists(pkg) {
  if (pkg.kind === "crates") {
    return crateExists(pkg.name);
  }
  if (pkg.kind === "npm") {
    return npmPackageExists(pkg.name);
  }
  if (pkg.kind === "jsr") {
    return jsrPackageExists(pkg.name);
  }
  if (pkg.kind === "maven") {
    return mavenCoordinateExists(pkg.name);
  }
  fail(`unsupported registry package kind ${JSON.stringify(pkg.kind)}`);
}

async function queryProductPublication(product, { versionOverride = undefined, registryKind = undefined, retries = 0, retryDelay = 0 } = {}) {
  const packages = await productRegistryPackages(product, { versionOverride, registryKind });
  const attempts = Math.max(1, retries + 1);
  let lastMissing = [];
  let lastPublished = [];
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const missing = [];
    const published = [];
    for (const pkg of packages) {
      if (await packageExists(pkg)) {
        published.push(pkg);
      } else {
        missing.push(pkg);
      }
    }
    lastMissing = missing;
    lastPublished = published;
    if (missing.length === 0 || attempt === attempts - 1) {
      break;
    }
    await boundedRegistrySleep(retryDelay, `publication visibility retry for ${product}`);
  }
  return { packages, missing: lastMissing, published: lastPublished };
}

async function productIdentityStatus(product, { registryKind = undefined } = {}) {
  const packages = await productRegistryPackages(product, { registryKind });
  const present = [];
  const missing = [];
  for (const pkg of packages) {
    if (await packageIdentityExists(pkg)) {
      present.push(pkg);
    } else {
      missing.push(pkg);
    }
  }
  return { packages, present, missing };
}

function parseFlags(argv) {
  const flags = new Map();
  const positionals = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    if (eq !== -1) {
      flags.set(arg.slice(2, eq), arg.slice(eq + 1));
      continue;
    }
    const name = arg.slice(2);
    if (["require-published", "require-unpublished", "report", "require-identities", "report-identities", "json"].includes(name)) {
      flags.set(name, true);
      continue;
    }
    if (index + 1 >= argv.length) {
      fail(`${arg} requires a value`);
    }
    flags.set(name, argv[index + 1]);
    index += 1;
  }
  return { flags, positionals };
}

function flagString(flags, name, { required = false } = {}) {
  const value = flags.get(name);
  if (value === undefined) {
    if (required) {
      fail(`--${name} is required`);
    }
    return undefined;
  }
  if (value === true) {
    fail(`--${name} requires a value`);
  }
  return value;
}

function flagNumber(flags, name, defaultValue) {
  const raw = flagString(flags, name);
  if (raw === undefined) {
    return defaultValue;
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    fail(`--${name} must be numeric`);
  }
  return value;
}

function activatePublicationLockFlag(flags) {
  const publicationLock = flagString(flags, "publication-lock");
  if (publicationLock !== undefined) {
    process.env.OLIPHAUNT_PUBLICATION_LOCK = path.resolve(ROOT, publicationLock);
  }
}

async function parseProducts(flags) {
  const rawProducts = flagString(flags, "products-json");
  const product = flagString(flags, "product");
  if (Boolean(rawProducts) === Boolean(product)) {
    fail("pass exactly one of --product or --products-json");
  }
  if (product !== undefined) {
    return [product];
  }
  let value;
  try {
    value = JSON.parse(rawProducts);
  } catch (error) {
    fail(`--products-json must be valid JSON: ${error.message}`);
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    fail("--products-json must be a JSON string list");
  }
  const known = new Set(await productIds());
  const unknown = value.filter((item) => !known.has(item)).sort();
  if (unknown.length > 0) {
    fail(`unknown release products: ${unknown.join(", ")}`);
  }
  return value;
}

function serializeQueryResult(result) {
  return {
    packages: result.packages.map((pkg) => ({ ...pkg, label: packageLabel(pkg) })),
    missing: result.missing.map((pkg) => ({ ...pkg, label: packageLabel(pkg) })),
    published: result.published.map((pkg) => ({ ...pkg, label: packageLabel(pkg) })),
  };
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

async function runProductCrates(flags) {
  const product = flagString(flags, "product", { required: true });
  const version = flagString(flags, "version") ?? (await currentVersion(product));
  printJson({ product, version, crates: await productCrates(product) });
}

async function runCrateVersionExists(flags) {
  const crate = flagString(flags, "crate", { required: true });
  const version = flagString(flags, "version", { required: true });
  printJson({ crate, version, exists: await crateVersionExists(crate, version) });
}

async function runCrateExists(flags) {
  const crate = flagString(flags, "crate", { required: true });
  printJson({ crate, exists: await crateExists(crate) });
}

async function runQueryProductPublication(flags) {
  const product = flagString(flags, "product", { required: true });
  const registryKind = flagString(flags, "registry-kind");
  const versionOverride = flagString(flags, "version");
  const retries = flagNumber(flags, "retries", 0);
  const retryDelay = flagNumber(flags, "retry-delay", 0);
  if (retries < 0 || retryDelay < 0) {
    fail("--retries and --retry-delay must be non-negative");
  }
  printJson(serializeQueryResult(await queryProductPublication(product, {
    versionOverride,
    registryKind,
    retries,
    retryDelay,
  })));
}

async function runProductRegistryPackages(flags) {
  const product = flagString(flags, "product", { required: true });
  const registryKind = flagString(flags, "registry-kind");
  const versionOverride = flagString(flags, "version");
  printJson({
    packages: (await productRegistryPackages(product, { versionOverride, registryKind })).map((pkg) => ({
      ...pkg,
      label: packageLabel(pkg),
    })),
  });
}

async function runPublicationCli(flags) {
  const versionOverride = flagString(flags, "version");
  const registryKind = flagString(flags, "registry-kind");
  const retries = flagNumber(flags, "retries", 0);
  const retryDelay = flagNumber(flags, "retry-delay", 0);
  if (versionOverride !== undefined && flagString(flags, "product") === undefined) {
    fail("--version can only be used with --product");
  }
  if (retries < 0 || retryDelay < 0) {
    fail("--retries and --retry-delay must be non-negative");
  }
  const modes = ["require-published", "require-unpublished", "report", "require-identities", "report-identities"].filter((mode) => flags.has(mode));
  if (modes.length !== 1) {
    fail("pass exactly one publication mode");
  }
  const products = await parseProducts(flags);
  const mode = modes[0];
  if (mode === "require-identities") {
    const missingMessages = [];
    for (const product of products) {
      const status = await productIdentityStatus(product, { registryKind });
      if (status.packages.length === 0) {
        console.log(`${product} has no external registry package identities to check`);
      } else if (status.missing.length > 0) {
        missingMessages.push(`${product}: ${status.missing.map(identityLabel).join(", ")}`);
      } else {
        console.log(`${product} registry identity check passed: ${status.packages.map(identityLabel).join(", ")}`);
      }
    }
    if (missingMessages.length > 0) {
      fail(`registry package identities are missing:\n  - ${missingMessages.join("\n  - ")}`);
    }
    return;
  }
  for (const product of products) {
    if (mode === "report-identities") {
      const status = await productIdentityStatus(product, { registryKind });
      if (status.packages.length === 0) {
        console.log(`${product} has no external registry package identities to check`);
      }
      if (status.present.length > 0) {
        console.log(`${product} registry identities present: ${status.present.map(identityLabel).join(", ")}`);
      }
      if (status.missing.length > 0) {
        console.log(`${product} registry identities missing: ${status.missing.map(identityLabel).join(", ")}`);
      }
      continue;
    }
    const result = await queryProductPublication(product, {
      versionOverride,
      registryKind,
      retries,
      retryDelay,
    });
    if (result.packages.length === 0) {
      console.log(`${product} has no external registry packages to check`);
      continue;
    }
    if (mode === "report") {
      if (result.published.length > 0) {
        console.log(`${product} registry versions already present: ${result.published.map(packageLabel).join(", ")}`);
      }
      if (result.missing.length > 0) {
        console.log(`${product} registry versions not yet present: ${result.missing.map(packageLabel).join(", ")}`);
      }
      continue;
    }
    if (mode === "require-published" && result.missing.length > 0) {
      fail(`${product} registry publication is missing: ${result.missing.map(packageLabel).join(", ")}`);
    }
    if (mode === "require-unpublished" && result.published.length > 0) {
      fail(`${product} version is already published in public registries: ${result.published.map(packageLabel).join(", ")}`);
    }
    const state = mode === "require-published" ? "published" : "unpublished";
    console.log(`${product} registry ${state} check passed: ${result.packages.map(packageLabel).join(", ")}`);
  }
}

async function main(argv) {
  const subcommands = new Map([
    ["product-crates", runProductCrates],
    ["crate-version-exists", runCrateVersionExists],
    ["crate-exists", runCrateExists],
    ["query-product-publication", runQueryProductPublication],
    ["product-registry-packages", runProductRegistryPackages],
  ]);
  const first = argv[0];
  if (subcommands.has(first)) {
    const { flags, positionals } = parseFlags(argv.slice(1));
    activatePublicationLockFlag(flags);
    if (positionals.length > 0) {
      fail(`unexpected positional arguments: ${positionals.join(", ")}`);
    }
    await subcommands.get(first)(flags);
    return;
  }
  const { flags, positionals } = parseFlags(argv);
  activatePublicationLockFlag(flags);
  if (positionals.length > 0) {
    fail(`unexpected positional arguments: ${positionals.join(", ")}`);
  }
  await runPublicationCli(flags);
}

if (import.meta.main) {
  await main(Bun.argv.slice(2));
}
