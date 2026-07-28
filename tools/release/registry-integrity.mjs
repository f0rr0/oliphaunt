#!/usr/bin/env bun
import { createHash } from "node:crypto";
import {
  lstatSync,
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import process from "node:process";

import { loadPublicationLock } from "./publication-lock.mjs";
import { ROOT, compareText } from "./release-graph.mjs";

const CRATES_IO_API = process.env.CRATES_IO_API || "https://crates.io/api/v1";
const DEFAULT_NPM_REGISTRY = "https://registry.npmjs.org";
const MAVEN_CENTRAL_BASE = process.env.MAVEN_CENTRAL_BASE || "https://repo1.maven.org/maven2";
const JSR_REGISTRY = process.env.JSR_REGISTRY || "https://jsr.io";
const USER_AGENT = "oliphaunt-release-integrity (https://github.com/f0rr0/oliphaunt)";
const IGNORED_DIRECTORIES = new Set([".git", "node_modules", "target"]);
const SUPPORTED_ECOSYSTEMS = new Set(["cargo", "npm", "maven", "jsr"]);
const RETRYABLE_HTTP_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const REQUEST_ATTEMPTS = 6;
const REQUEST_TIMEOUT_MS = 45_000;
const DEADLINE_RESERVE_MS = 5_000;
const MAX_RETRY_DELAY_MS = 30_000;
const MAX_METADATA_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_REGISTRY_RECEIPT_EVIDENCE_BYTES = 64 * 1024 * 1024;
export const REGISTRY_RECEIPT_EVIDENCE_SCHEMA = "oliphaunt-registry-integrity-receipts-v1";

class RegistryHttpError extends Error {
  constructor(url, status, retryAfter) {
    super(`registry returned HTTP ${status} for ${url}`);
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

class RegistryResponseError extends Error {}

function mutationDeadlineRemainingMilliseconds(context) {
  const raw = process.env.REGISTRY_MUTATION_DEADLINE_EPOCH?.trim();
  if (!raw) return null;
  if (!/^[1-9][0-9]*$/u.test(raw)) {
    throw new RegistryResponseError("REGISTRY_MUTATION_DEADLINE_EPOCH must be a positive Unix timestamp");
  }
  const deadline = Number(raw) * 1000;
  if (!Number.isSafeInteger(deadline)) {
    throw new RegistryResponseError("REGISTRY_MUTATION_DEADLINE_EPOCH exceeds the safe timestamp range");
  }
  const remaining = deadline - Date.now() - DEADLINE_RESERVE_MS;
  if (remaining <= 0) {
    throw new RegistryResponseError(`${context} refused because the shared registry mutation deadline has been reached`);
  }
  return remaining;
}

function error(message) {
  return new Error(`registry-integrity: ${message}`);
}

function canonicalNpmRegistry() {
  const raw = (process.env.NPM_REGISTRY ?? DEFAULT_NPM_REGISTRY).trim();
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw error(`npm registry must be the canonical public registry ${DEFAULT_NPM_REGISTRY}`);
  }
  const normalizedPath = parsed.pathname.replace(/\/+$/u, "") || "/";
  if (
    parsed.protocol !== "https:"
    || parsed.hostname !== "registry.npmjs.org"
    || (parsed.port !== "" && parsed.port !== "443")
    || normalizedPath !== "/"
    || parsed.username !== ""
    || parsed.password !== ""
    || parsed.search !== ""
    || parsed.hash !== ""
  ) {
    throw error(`npm registry must be the canonical public registry ${DEFAULT_NPM_REGISTRY}`);
  }
  return DEFAULT_NPM_REGISTRY;
}

function hashFile(file, algorithm, encoding = "hex") {
  return createHash(algorithm).update(readFileSync(file)).digest(encoding);
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort(compareText).map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function digestValue(value) {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function requireLockedFile(artifact, suffix, carrier) {
  if (!artifact.path.endsWith(suffix)) {
    throw error(`${carrier.id} locked artifact ${artifact.path} is not a ${suffix} publication archive`);
  }
  const file = path.resolve(ROOT, artifact.path);
  let stat;
  try {
    stat = statSync(file);
  } catch {
    throw error(`${carrier.id} locked artifact is unavailable: ${artifact.path}`);
  }
  if (!stat.isFile() || stat.size !== artifact.size || hashFile(file, "sha256") !== artifact.sha256) {
    throw error(`${carrier.id} local publication archive no longer matches the frozen lock: ${artifact.path}`);
  }
  return file;
}

function retryAfterMilliseconds(value) {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(Math.ceil(seconds * 1000), MAX_RETRY_DELAY_MS);
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return null;
  return Math.min(Math.max(0, timestamp - Date.now()), MAX_RETRY_DELAY_MS);
}

function retryDelay(attempt, cause) {
  if (cause instanceof RegistryHttpError && cause.retryAfter !== null) return cause.retryAfter;
  const exponential = Math.min(500 * (2 ** attempt), MAX_RETRY_DELAY_MS);
  return Math.round(exponential * (0.75 + Math.random() * 0.5));
}

function retryable(cause) {
  if (cause instanceof RegistryResponseError) return false;
  return !(cause instanceof RegistryHttpError) || RETRYABLE_HTTP_STATUS.has(cause.status);
}

function declaredResponseLength(response, context) {
  const contentLength = response.headers?.get?.("content-length");
  if (contentLength === null || contentLength === undefined) return null;
  const declared = Number(contentLength);
  if (!Number.isSafeInteger(declared) || declared < 0) {
    throw new RegistryResponseError(`${context} returned an invalid Content-Length`);
  }
  return declared;
}

async function boundedResponseBytes(response, maximum, context) {
  const declared = declaredResponseLength(response, context);
  if (declared !== null && declared > maximum) {
    await response.body?.cancel?.().catch(() => {});
    throw new RegistryResponseError(`${context} response exceeds ${maximum} bytes`);
  }
  const reader = response.body?.getReader?.();
  if (reader === undefined) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > maximum) {
      throw new RegistryResponseError(`${context} response exceeds ${maximum} bytes`);
    }
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
        throw new RegistryResponseError(`${context} response exceeds ${maximum} bytes`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}

async function request(url, accept, fetchImpl, consume) {
  let last;
  let usedAttempts = 0;
  for (let attempt = 0; attempt < REQUEST_ATTEMPTS; attempt += 1) {
    usedAttempts = attempt + 1;
    const controller = new AbortController();
    const deadlineRemaining = mutationDeadlineRemainingMilliseconds(`registry request for ${url}`);
    const timeoutMs = deadlineRemaining === null
      ? REQUEST_TIMEOUT_MS
      : Math.max(1, Math.min(REQUEST_TIMEOUT_MS, deadlineRemaining));
    const timeout = setTimeout(() => controller.abort(new Error(`registry request timed out after ${timeoutMs}ms`)), timeoutMs);
    try {
      const response = await fetchImpl(url, {
        headers: { accept, "user-agent": USER_AGENT },
        redirect: "follow",
        signal: controller.signal,
      });
      if (!response.ok) {
        const retryAfter = retryAfterMilliseconds(response.headers?.get?.("retry-after"));
        await response.body?.cancel?.().catch?.(() => {});
        throw new RegistryHttpError(url, response.status, retryAfter);
      }
      return await consume(response);
    } catch (cause) {
      clearTimeout(timeout);
      last = cause;
      if (attempt + 1 >= REQUEST_ATTEMPTS || !retryable(cause)) break;
      const delay = retryDelay(attempt, cause);
      const retryRemaining = mutationDeadlineRemainingMilliseconds(`registry retry for ${url}`);
      if (retryRemaining !== null && delay >= retryRemaining) {
        throw error(`registry retry for ${url} cannot complete before the shared registry mutation deadline`);
      }
      await new Promise((resolve) => setTimeout(resolve, delay));
    } finally {
      clearTimeout(timeout);
    }
  }
  throw error(`${last instanceof Error ? last.message : String(last)} after ${usedAttempts} attempt(s)`);
}

async function requestJson(url, fetchImpl) {
  return request(url, "application/json", fetchImpl, async (response) => {
    const bytes = await boundedResponseBytes(response, MAX_METADATA_RESPONSE_BYTES, url);
    try {
      return JSON.parse(bytes.toString("utf8"));
    } catch (cause) {
      throw new RegistryResponseError(`registry returned invalid JSON for ${url}: ${cause.message}`);
    }
  });
}

async function responseSha256(response, maximum, context) {
  const declared = declaredResponseLength(response, context);
  if (declared !== null && declared > maximum) {
    await response.body?.cancel?.().catch(() => {});
    throw new RegistryResponseError(`${context} response exceeds locked size ${maximum}`);
  }
  const hash = createHash("sha256");
  let size = 0;
  if (response.body?.getReader !== undefined) {
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const bytes = Buffer.from(value);
        size += bytes.length;
        if (size > maximum) {
          await reader.cancel().catch(() => {});
          throw new RegistryResponseError(`${context} response exceeds locked size ${maximum}`);
        }
        hash.update(bytes);
      }
    } finally {
      reader.releaseLock();
    }
  } else {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > maximum) {
      throw new RegistryResponseError(`${context} response exceeds locked size ${maximum}`);
    }
    hash.update(bytes);
    size = bytes.length;
  }
  return { sha256: hash.digest("hex"), size };
}

async function requestSha256(url, fetchImpl, maximum) {
  return request(url, "application/octet-stream", fetchImpl, (response) => responseSha256(response, maximum, url));
}

function lockedArtifactEnvelope(carrier) {
  return carrier.artifacts
    .map(({ sha256, size }) => ({ sha256, size }))
    .sort((left, right) => compareText(left.sha256, right.sha256));
}

function expectedCargoReceipt(carrier) {
  if (carrier.artifacts.length !== 1) {
    throw error(`${carrier.id} must freeze exactly one .crate archive for byte-level registry verification`);
  }
  const file = requireLockedFile(carrier.artifacts[0], ".crate", carrier);
  const digest = hashFile(file, "sha256");
  const url = `${CRATES_IO_API.replace(/\/+$/u, "")}/crates/${encodeURIComponent(carrier.name)}/${encodeURIComponent(carrier.version)}`;
  return {
    id: carrier.id,
    product: carrier.product,
    ecosystem: carrier.ecosystem,
    name: carrier.name,
    version: carrier.version,
    lockedArtifacts: lockedArtifactEnvelope(carrier),
    registryProof: {
      algorithm: "sha256",
      digest,
      source: "crates.io-version-checksum",
      url,
    },
  };
}

async function cargoReceipt(carrier, fetchImpl) {
  const receipt = expectedCargoReceipt(carrier);
  const metadata = await requestJson(receipt.registryProof.url, fetchImpl);
  const observed = metadata?.version?.checksum;
  if (observed !== receipt.registryProof.digest) {
    throw error(`${carrier.id} registry checksum mismatch: locked=${receipt.registryProof.digest}, registry=${String(observed)}`);
  }
  return receipt;
}

function expectedNpmReceipt(carrier) {
  if (carrier.artifacts.length !== 1) {
    throw error(`${carrier.id} must freeze exactly one npm .tgz archive for byte-level registry verification`);
  }
  const file = requireLockedFile(carrier.artifacts[0], ".tgz", carrier);
  const digest = hashFile(file, "sha512", "base64");
  const url = `${canonicalNpmRegistry()}/${encodeURIComponent(carrier.name)}/${encodeURIComponent(carrier.version)}`;
  return {
    id: carrier.id,
    product: carrier.product,
    ecosystem: carrier.ecosystem,
    name: carrier.name,
    version: carrier.version,
    lockedArtifacts: lockedArtifactEnvelope(carrier),
    registryProof: {
      algorithm: "sha512",
      digest,
      source: "npm-dist-integrity",
      url,
    },
  };
}

async function npmReceipt(carrier, fetchImpl) {
  const receipt = expectedNpmReceipt(carrier);
  const expectedIntegrity = `sha512-${receipt.registryProof.digest}`;
  const metadata = await requestJson(receipt.registryProof.url, fetchImpl);
  const integrity = metadata?.dist?.integrity;
  const tokens = typeof integrity === "string" ? integrity.trim().split(/\s+/u) : [];
  if (!tokens.includes(expectedIntegrity)) {
    throw error(`${carrier.id} registry integrity mismatch: locked=${expectedIntegrity}, registry=${String(integrity)}`);
  }
  return receipt;
}

function mavenCoordinate(carrier) {
  const separator = carrier.name.lastIndexOf(":");
  const group = separator > 0 ? carrier.name.slice(0, separator) : "";
  const artifact = separator > 0 ? carrier.name.slice(separator + 1) : "";
  if (!/^[A-Za-z0-9_.-]+$/u.test(group) || !/^[A-Za-z0-9_.-]+$/u.test(artifact)) {
    throw error(`${carrier.id} has invalid Maven coordinates ${JSON.stringify(carrier.name)}`);
  }
  if (!/^[A-Za-z0-9_.-]+$/u.test(carrier.version)) {
    throw error(`${carrier.id} has invalid Maven version ${JSON.stringify(carrier.version)}`);
  }
  const groupPath = group.split(".").map(encodeURIComponent).join("/");
  return { artifact, base: `${MAVEN_CENTRAL_BASE.replace(/\/+$/u, "")}/${groupPath}/${encodeURIComponent(artifact)}/${encodeURIComponent(carrier.version)}` };
}

function mavenRemoteFilename(carrier, artifact, artifactName) {
  const localName = path.basename(artifact.path);
  const prefix = `${artifactName}-${carrier.version}`;
  if (localName.startsWith(prefix) && localName.length > prefix.length) return localName;
  const compound = [".tar.gz", ".tar.zst"].find((suffix) => localName.endsWith(suffix));
  const suffix = compound ?? path.extname(localName);
  if (!suffix) throw error(`${carrier.id} cannot determine the Maven publication extension for ${artifact.path}`);
  return `${prefix}${suffix}`;
}

function expectedMavenReceipt(carrier) {
  if (carrier.artifacts.length === 0) throw error(`${carrier.id} freezes no Maven publication payloads`);
  const { artifact: artifactName, base } = mavenCoordinate(carrier);
  const proofs = [];
  const remoteNames = new Set();
  for (const artifact of carrier.artifacts) {
    const file = requireLockedFile(artifact, "", carrier);
    const remoteName = mavenRemoteFilename(carrier, artifact, artifactName);
    if (remoteNames.has(remoteName)) throw error(`${carrier.id} maps multiple locked payloads to Maven file ${remoteName}`);
    remoteNames.add(remoteName);
    const url = `${base}/${encodeURIComponent(remoteName)}`;
    proofs.push({ algorithm: "sha256", digest: hashFile(file, "sha256"), size: statSync(file).size, url });
  }
  return {
    id: carrier.id,
    product: carrier.product,
    ecosystem: carrier.ecosystem,
    name: carrier.name,
    version: carrier.version,
    lockedArtifacts: lockedArtifactEnvelope(carrier),
    registryProof: {
      algorithm: "sha256",
      digest: digestValue(proofs),
      files: proofs,
      source: "maven-central-payload-bytes",
    },
  };
}

async function mavenReceipt(carrier, fetchImpl) {
  const receipt = expectedMavenReceipt(carrier);
  for (const proof of receipt.registryProof.files) {
    const observed = await requestSha256(proof.url, fetchImpl, proof.size);
    if (observed.sha256 !== proof.digest || observed.size !== proof.size) {
      throw error(
        `${carrier.id} Maven payload mismatch for ${path.basename(new URL(proof.url).pathname)}: `
          + `locked=${proof.digest}/${proof.size}, registry=${observed.sha256}/${observed.size}`,
      );
    }
  }
  return receipt;
}

function walkDirectoryFiles(root) {
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => compareText(left.name, right.name))) {
      const child = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw error(`JSR publication source must not contain symlinks: ${path.relative(ROOT, child)}`);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) visit(child);
      } else if (entry.isFile()) {
        files.push(child);
      }
    }
  };
  visit(root);
  return files;
}

function directoryEnvelope(directory) {
  const hash = createHash("sha256");
  let size = 0;
  for (const file of walkDirectoryFiles(directory)) {
    const relative = path.relative(directory, file).split(path.sep).join("/");
    const bytes = readFileSync(file);
    hash.update(`${relative}\0${bytes.length}\0`);
    hash.update(bytes);
    size += bytes.length;
  }
  return { sha256: hash.digest("hex"), size };
}

function requireLockedDirectory(artifact, carrier) {
  const directory = path.resolve(ROOT, artifact.path);
  let stat;
  try { stat = lstatSync(directory); } catch { throw error(`${carrier.id} locked directory is unavailable: ${artifact.path}`); }
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw error(`${carrier.id} locked JSR artifact is not a directory: ${artifact.path}`);
  const observed = directoryEnvelope(directory);
  if (observed.sha256 !== artifact.sha256 || observed.size !== artifact.size) {
    throw error(`${carrier.id} local JSR source no longer matches the frozen lock: ${artifact.path}`);
  }
  return directory;
}

function safeJsrPublishPath(value, carrier) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\\") || path.posix.isAbsolute(value)) {
    throw error(`${carrier.id} has unsafe JSR publish.include path ${JSON.stringify(value)}`);
  }
  const normalized = path.posix.normalize(value);
  if (normalized === ".." || normalized.startsWith("../") || /[*?\[\]{}]/u.test(value)) {
    throw error(`${carrier.id} JSR byte verification requires explicit, repository-relative publish.include files; got ${JSON.stringify(value)}`);
  }
  return normalized.replace(/^\.\//u, "");
}

function expectedJsrManifest(directory, carrier) {
  let config;
  try { config = JSON.parse(readFileSync(path.join(directory, "jsr.json"), "utf8")); } catch (cause) {
    throw error(`${carrier.id} cannot read strict jsr.json: ${cause.message}`);
  }
  const include = config?.publish?.include;
  if (!Array.isArray(include) || include.length === 0) {
    throw error(`${carrier.id} jsr.json must declare a nonempty explicit publish.include list for registry byte verification`);
  }
  if (config.name !== carrier.name || config.version !== carrier.version) {
    throw error(`${carrier.id} jsr.json identity does not match the frozen carrier`);
  }
  const manifest = {};
  for (const value of include) {
    const relative = safeJsrPublishPath(value, carrier);
    const file = path.join(directory, ...relative.split("/"));
    let stat;
    try { stat = lstatSync(file); } catch { throw error(`${carrier.id} JSR publish.include file is unavailable: ${relative}`); }
    if (stat.isSymbolicLink() || !stat.isFile()) throw error(`${carrier.id} JSR publish.include entry is not a regular file: ${relative}`);
    manifest[`/${relative}`] = { checksum: `sha256-${hashFile(file, "sha256")}`, size: stat.size };
  }
  return Object.fromEntries(Object.entries(manifest).sort(([left], [right]) => compareText(left, right)));
}

function normalizeJsrManifest(value, carrier) {
  if (value === null || Array.isArray(value) || typeof value !== "object") throw error(`${carrier.id} JSR version metadata has no file manifest`);
  const normalized = {};
  for (const [name, entry] of Object.entries(value).sort(([left], [right]) => compareText(left, right))) {
    if (!name.startsWith("/") || entry === null || Array.isArray(entry) || typeof entry !== "object") {
      throw error(`${carrier.id} JSR version metadata has an invalid manifest entry ${JSON.stringify(name)}`);
    }
    if (!/^sha256-[0-9a-f]{64}$/u.test(entry.checksum) || !Number.isSafeInteger(entry.size) || entry.size < 0) {
      throw error(`${carrier.id} JSR version metadata has an invalid proof for ${name}`);
    }
    normalized[name] = { checksum: entry.checksum, size: entry.size };
  }
  return normalized;
}

function expectedJsrReceipt(carrier) {
  if (carrier.artifacts.length !== 1) throw error(`${carrier.id} must freeze exactly one JSR source-directory envelope`);
  const directory = requireLockedDirectory(carrier.artifacts[0], carrier);
  const match = carrier.name.match(/^@([^/]+)\/(.+)$/u);
  if (match === null) throw error(`${carrier.id} has invalid JSR package name ${JSON.stringify(carrier.name)}`);
  const url = `${JSR_REGISTRY.replace(/\/+$/u, "")}/@${encodeURIComponent(match[1])}/${encodeURIComponent(match[2])}/${encodeURIComponent(carrier.version)}_meta.json`;
  const manifest = expectedJsrManifest(directory, carrier);
  return {
    id: carrier.id,
    product: carrier.product,
    ecosystem: carrier.ecosystem,
    name: carrier.name,
    version: carrier.version,
    lockedArtifacts: lockedArtifactEnvelope(carrier),
    registryProof: { algorithm: "sha256", digest: digestValue(manifest), files: manifest, source: "jsr-version-file-manifest", url },
  };
}

async function jsrReceipt(carrier, fetchImpl) {
  const receipt = expectedJsrReceipt(carrier);
  const metadata = await requestJson(receipt.registryProof.url, fetchImpl);
  const observed = normalizeJsrManifest(metadata?.manifest, carrier);
  if (stableJson(observed) !== stableJson(receipt.registryProof.files)) {
    throw error(`${carrier.id} JSR published file manifest does not match the frozen publish.include bytes`);
  }
  return receipt;
}

function expectedLockedCarrierReceipt(carrier) {
  if (carrier.ecosystem === "cargo") return expectedCargoReceipt(carrier);
  if (carrier.ecosystem === "npm") return expectedNpmReceipt(carrier);
  if (carrier.ecosystem === "maven") return expectedMavenReceipt(carrier);
  if (carrier.ecosystem === "jsr") return expectedJsrReceipt(carrier);
  throw error(`${carrier.id} byte-level registry verification is unsupported for ${carrier.ecosystem}`);
}

function selectedLockedRegistryCarriers(lock, {
  products,
  ecosystems = ["cargo", "npm", "maven", "jsr"],
  carrierIds,
} = {}) {
  if (!Array.isArray(lock?.carriers)) throw error("publication lock has no carriers list");
  const productSet = products === undefined ? null : new Set(products);
  if (products !== undefined && (
    !Array.isArray(products)
    || products.length === 0
    || products.some((product) => typeof product !== "string" || product.length === 0)
    || productSet.size !== products.length
  )) {
    throw error("products must be a nonempty unique string list");
  }
  const ecosystemSet = new Set(ecosystems);
  if (!Array.isArray(ecosystems) || ecosystemSet.size !== ecosystems.length) {
    throw error("ecosystems must be a unique list");
  }
  for (const ecosystem of ecosystemSet) {
    if (!SUPPORTED_ECOSYSTEMS.has(ecosystem)) throw error(`unsupported registry ecosystem ${JSON.stringify(ecosystem)}`);
  }
  const idSet = carrierIds === undefined ? null : new Set(carrierIds);
  if (carrierIds !== undefined && (
    !Array.isArray(carrierIds)
    || carrierIds.some((id) => typeof id !== "string" || id.length === 0)
    || idSet.size !== carrierIds.length
  )) {
    throw error("carrierIds must be a unique string list");
  }
  const carriers = lock.carriers.filter((carrier) =>
    ecosystemSet.has(carrier.ecosystem)
    && (productSet === null || productSet.has(carrier.product))
    && (idSet === null || idSet.has(carrier.id)))
    .sort((left, right) => left.publishOrder - right.publishOrder || compareText(left.id, right.id));
  if (idSet !== null && carriers.length !== idSet.size) {
    throw error("one or more requested carrier IDs are absent from the publication lock");
  }
  return carriers;
}

export function validateLockedRegistryReceipts(lock, {
  products,
  ecosystems = ["cargo", "npm", "maven", "jsr"],
  carrierIds,
  receipts,
} = {}) {
  if (!Array.isArray(receipts)) throw error("registry receipts must be a list");
  const carriers = selectedLockedRegistryCarriers(lock, { products, ecosystems, carrierIds });
  const expectedById = new Map(carriers.map((carrier) => [carrier.id, expectedLockedCarrierReceipt(carrier)]));
  const observedById = new Map();
  for (const receipt of receipts) {
    if (receipt === null || Array.isArray(receipt) || typeof receipt !== "object" || typeof receipt.id !== "string") {
      throw error("every registry receipt must be an object with an id");
    }
    if (observedById.has(receipt.id)) throw error(`duplicate registry receipt ${receipt.id}`);
    if (!expectedById.has(receipt.id)) throw error(`unexpected registry receipt ${receipt.id}`);
    observedById.set(receipt.id, receipt);
  }
  const missing = carriers.filter(({ id }) => !observedById.has(id)).map(({ id }) => id);
  if (missing.length > 0) {
    throw error(`registry receipt evidence is incomplete; missing ${missing.slice(0, 8).join(", ")}${missing.length > 8 ? ` and ${missing.length - 8} more` : ""}`);
  }
  for (const [id, expected] of expectedById) {
    if (stableJson(observedById.get(id)) !== stableJson(expected)) {
      throw error(`${id} registry receipt does not exactly prove its frozen local bytes and canonical registry identity`);
    }
  }
  return carriers.map(({ id }) => observedById.get(id));
}

export function registryReceiptEvidence(lock, {
  products,
  ecosystems = ["cargo", "npm", "maven", "jsr"],
  receipts,
} = {}) {
  const validated = validateLockedRegistryReceipts(lock, { products, ecosystems, receipts });
  return {
    schema: REGISTRY_RECEIPT_EVIDENCE_SCHEMA,
    lockDigest: lock.lockDigest,
    source: lock.source,
    products: [...products].sort(compareText),
    ecosystems: [...ecosystems].sort(compareText),
    receipts: validated,
  };
}

export function writeRegistryReceiptEvidence(file, lock, options) {
  const evidence = registryReceiptEvidence(lock, options);
  const absolute = path.resolve(ROOT, file);
  mkdirSync(path.dirname(absolute), { recursive: true });
  const temporary = `${absolute}.tmp-${process.pid}-${Date.now()}`;
  const body = `${JSON.stringify(evidence, null, 2)}\n`;
  try {
    writeFileSync(temporary, body, { flag: "wx", mode: 0o644 });
    try {
      linkSync(temporary, absolute);
    } catch (cause) {
      if (cause?.code !== "EEXIST") throw cause;
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_REGISTRY_RECEIPT_EVIDENCE_BYTES) {
        throw error(`refusing to replace unsafe existing registry receipt evidence ${file}`);
      }
      if (readFileSync(absolute, "utf8") !== body) {
        throw error(`refusing to replace non-identical immutable registry receipt evidence ${file}`);
      }
    }
  } finally {
    try { unlinkSync(temporary); } catch {}
  }
  return evidence;
}

export function validateRegistryReceiptEvidence(file, lock, { products, ecosystems } = {}) {
  let evidence;
  try {
    const absolute = path.resolve(ROOT, file);
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_REGISTRY_RECEIPT_EVIDENCE_BYTES) {
      throw new Error(`must be a regular file no larger than ${MAX_REGISTRY_RECEIPT_EVIDENCE_BYTES} bytes`);
    }
    evidence = JSON.parse(readFileSync(absolute, "utf8"));
  } catch (cause) {
    throw error(`cannot read registry receipt evidence ${file}: ${cause.message}`);
  }
  if (evidence === null || Array.isArray(evidence) || typeof evidence !== "object") {
    throw error("registry receipt evidence must be an object");
  }
  if (evidence.schema !== REGISTRY_RECEIPT_EVIDENCE_SCHEMA) {
    throw error(`registry receipt evidence schema must be ${REGISTRY_RECEIPT_EVIDENCE_SCHEMA}`);
  }
  if (evidence.lockDigest !== lock.lockDigest || stableJson(evidence.source) !== stableJson(lock.source)) {
    throw error("registry receipt evidence is not bound to the active publication lock source/digest");
  }
  const expectedProducts = [...products].sort(compareText);
  const expectedEcosystems = [...(ecosystems ?? ["cargo", "npm", "maven", "jsr"])].sort(compareText);
  if (stableJson(evidence.products) !== stableJson(expectedProducts) || stableJson(evidence.ecosystems) !== stableJson(expectedEcosystems)) {
    throw error("registry receipt evidence product/ecosystem selection does not match the requested release");
  }
  validateLockedRegistryReceipts(lock, {
    products,
    ecosystems: expectedEcosystems,
    receipts: evidence.receipts,
  });
  return evidence;
}

export async function verifyLockedCarrierIntegrity(lock, carrierId, { fetchImpl = fetch } = {}) {
  const carrier = lock.carriers.find((entry) => entry.id === carrierId);
  if (carrier === undefined) throw error(`publication lock has no carrier ${carrierId}`);
  if (carrier.ecosystem === "cargo") return cargoReceipt(carrier, fetchImpl);
  if (carrier.ecosystem === "npm") return npmReceipt(carrier, fetchImpl);
  if (carrier.ecosystem === "maven") return mavenReceipt(carrier, fetchImpl);
  if (carrier.ecosystem === "jsr") return jsrReceipt(carrier, fetchImpl);
  throw error(`${carrier.id} byte-level registry verification is unsupported for ${carrier.ecosystem}`);
}

export async function verifyLockedRegistryIntegrity(lock, {
  products,
  ecosystems = ["cargo", "npm", "maven", "jsr"],
  carrierIds,
  fetchImpl = fetch,
  concurrency = Number(process.env.REGISTRY_INTEGRITY_CONCURRENCY ?? 8),
} = {}) {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 32) {
    throw error(`concurrency must be an integer from 1 through 32, got ${JSON.stringify(concurrency)}`);
  }
  const carriers = selectedLockedRegistryCarriers(lock, { products, ecosystems, carrierIds });
  const receipts = new Array(carriers.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= carriers.length) return;
      receipts[index] = await verifyLockedCarrierIntegrity(lock, carriers[index].id, { fetchImpl });
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, carriers.length) }, worker));
  return receipts;
}

function parseArgs(argv) {
  let lockFile = "";
  let carrierId = "";
  let productsJson = "";
  let verifyReceipts = "";
  let concurrency = 8;
  const ecosystems = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === "--lock") lockFile = value ?? "";
    else if (arg === "--carrier-id") carrierId = value ?? "";
    else if (arg === "--products-json") productsJson = value ?? "";
    else if (arg === "--verify-receipts") verifyReceipts = value ?? "";
    else if (arg === "--ecosystem") ecosystems.push(value ?? "");
    else if (arg === "--concurrency") concurrency = Number(value);
    else throw error(`unknown argument ${arg}`);
    index += 1;
  }
  if (!lockFile || Boolean(carrierId) === Boolean(productsJson) || (verifyReceipts && !productsJson)) {
    throw error("usage: registry-integrity.mjs --lock FILE (--carrier-id ID | --products-json JSON) [--ecosystem cargo|npm|maven|jsr] [--concurrency 1..32] [--verify-receipts FILE]");
  }
  let products;
  if (productsJson) {
    try { products = JSON.parse(productsJson); } catch (cause) { throw error(`invalid --products-json: ${cause.message}`); }
    if (!Array.isArray(products) || products.length === 0 || products.some((item) => typeof item !== "string" || item.length === 0) || new Set(products).size !== products.length) {
      throw error("--products-json must be a nonempty unique string list");
    }
  }
  for (const ecosystem of ecosystems) {
    if (!SUPPORTED_ECOSYSTEMS.has(ecosystem)) throw error(`unsupported --ecosystem ${JSON.stringify(ecosystem)}`);
  }
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 32) throw error("--concurrency must be an integer from 1 through 32");
  return {
    lockFile: path.resolve(ROOT, lockFile),
    carrierId,
    products,
    ecosystems,
    concurrency,
    verifyReceipts: verifyReceipts ? path.resolve(ROOT, verifyReceipts) : "",
  };
}

if (import.meta.main) {
  try {
    const args = parseArgs(Bun.argv.slice(2));
    const lock = loadPublicationLock(args.lockFile);
    if (args.verifyReceipts) {
      const evidence = validateRegistryReceiptEvidence(args.verifyReceipts, lock, {
        products: args.products,
        ecosystems: args.ecosystems.length > 0 ? args.ecosystems : ["cargo", "npm", "maven", "jsr"],
      });
      console.log(`Verified ${evidence.receipts.length} immutable registry receipts against the frozen publication lock.`);
      process.exit(0);
    }
    const receipts = await verifyLockedRegistryIntegrity(lock, {
      products: args.products,
      ecosystems: args.ecosystems.length > 0 ? args.ecosystems : ["cargo", "npm", "maven", "jsr"],
      carrierIds: args.carrierId ? [args.carrierId] : undefined,
      concurrency: args.concurrency,
    });
    console.log(JSON.stringify({ schema: REGISTRY_RECEIPT_EVIDENCE_SCHEMA, receipts }, null, 2));
  } catch (cause) {
    console.error(cause instanceof Error ? cause.message : String(cause));
    process.exit(1);
  }
}
