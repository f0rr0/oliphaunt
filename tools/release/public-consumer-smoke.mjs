#!/usr/bin/env bun

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

import {
  DEFAULT_PUBLICATION_LOCK,
  loadPublicationLock,
} from "./publication-lock.mjs";
import { ROOT, compareText, loadGraph } from "./release-graph.mjs";
import { validateRegistryReceiptEvidence } from "./registry-integrity.mjs";
import { validateGithubAttestationReceipt } from "./verify_github_release_attestations.mjs";

export const PUBLIC_CONSUMER_EVIDENCE_SCHEMA = "oliphaunt-public-consumer-smoke-v1";

const TOOL = "public-consumer-smoke";
const REGISTRY_ECOSYSTEMS = ["cargo", "jsr", "maven", "npm"];
const SUPPORTED_PUBLISH_TARGETS = new Set([
  "crates-io",
  "github-release",
  "github-release-assets",
  "jsr",
  "maven-central",
  "npm",
  "swift-package-source-tag",
]);
const TARGET_ECOSYSTEM = new Map([
  ["crates-io", "cargo"],
  ["jsr", "jsr"],
  ["maven-central", "maven"],
  ["npm", "npm"],
]);
const CONSUMER_DEPENDENCY_SCOPES = Object.freeze({
  cargo: new Set(["build", "runtime"]),
  jsr: new Set(["runtime"]),
  maven: new Set(["compile", "runtime"]),
  npm: new Set(["optional", "peer", "runtime"]),
});
const DEFAULT_REPOSITORY = "f0rr0/oliphaunt";
const DEFAULT_OUTPUT = path.join(ROOT, "target/release/public-consumer-smoke.json");
const DEFAULT_OVERALL_TIMEOUT_SECONDS = 780;
const DEFAULT_POST_SMOKE_RESERVE_SECONDS = 600;
const MAX_SURFACE_ATTEMPTS = 8;
const MAX_COMMAND_ATTEMPT_MILLISECONDS = 240_000;
const RETRY_DELAYS_MILLISECONDS = [5_000, 10_000, 20_000, 30_000, 45_000, 60_000, 60_000];
const MAX_COMMAND_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_RECEIPT_BYTES = 64 * 1024 * 1024;
const MAX_EVIDENCE_BYTES = 8 * 1024 * 1024;
const SHA256_RE = /^[0-9a-f]{64}$/u;
const FULL_SHA_RE = /^[0-9a-f]{40}$/u;

class PublicCommandError extends Error {
  constructor(message, { retryable = false } = {}) {
    super(message);
    this.retryable = retryable;
  }
}

function error(message) {
  return new Error(`${TOOL}: ${message}`);
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort(compareText).map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sortedUniqueStrings(values, context, { allowEmpty = true } = {}) {
  if (
    !Array.isArray(values)
    || values.some((value) => typeof value !== "string" || value.length === 0 || /[\0\r\n]/u.test(value))
  ) {
    throw error(`${context} must be a list of non-empty single-line strings`);
  }
  const result = [...new Set(values)].sort(compareText);
  if (result.length !== values.length) throw error(`${context} must not contain duplicates`);
  if (!allowEmpty && result.length === 0) throw error(`${context} must not be empty`);
  return result;
}

function sameStrings(left, right) {
  return stableJson([...left].sort(compareText)) === stableJson([...right].sort(compareText));
}

function requirePositiveInteger(raw, context, fallback) {
  const value = raw === undefined || raw === null || String(raw).trim() === ""
    ? fallback
    : Number(String(raw).trim());
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw error(`${context} must be a positive safe integer`);
  }
  return value;
}

function selectedProductRows(lock, products) {
  const requested = sortedUniqueStrings(products, "products", { allowEmpty: false });
  const locked = lock.products.map(({ id }) => id).sort(compareText);
  if (!sameStrings(requested, locked)) {
    throw error(`requested products must exactly match the frozen publication lock: requested=${JSON.stringify(requested)}, locked=${JSON.stringify(locked)}`);
  }
  const byId = new Map(lock.products.map((product) => [product.id, product]));
  return requested.map((id) => byId.get(id));
}

function assertCarrier(carrier, productIds) {
  if (
    carrier === null
    || Array.isArray(carrier)
    || typeof carrier !== "object"
    || typeof carrier.id !== "string"
    || carrier.id !== `${carrier.ecosystem}:${carrier.name}`
    || !REGISTRY_ECOSYSTEMS.includes(carrier.ecosystem)
    || typeof carrier.name !== "string"
    || carrier.name.length === 0
    || typeof carrier.version !== "string"
    || carrier.version.length === 0
    || !productIds.has(carrier.product)
    || !Array.isArray(carrier.dependencies)
  ) {
    throw error(`publication lock contains an invalid selected carrier ${JSON.stringify(carrier?.id)}`);
  }
  sortedUniqueStrings(carrier.dependencies, `${carrier.id}.dependencies`);
}

function entryCarrierIds(carriers) {
  const carrierIds = new Set(carriers.map(({ id }) => id));
  const dependedOn = new Set();
  for (const carrier of carriers) {
    for (const dependency of carrier.dependencies) {
      if (carrierIds.has(dependency)) dependedOn.add(dependency);
    }
  }
  return carriers.filter(({ id }) => !dependedOn.has(id)).map(({ id }) => id).sort(compareText);
}

function consumerDependencyIds(carrier, selectedCarrierIds) {
  if (!Array.isArray(carrier.packageDependencies)) {
    // Synthetic plan tests and callers predating the frozen artifact envelope
    // can still exercise graph behavior. A validated publication lock always
    // carries packageDependencies and therefore always takes the scope-aware
    // branch below.
    return carrier.dependencies.filter((id) => selectedCarrierIds.has(id)).sort(compareText);
  }
  const scopes = CONSUMER_DEPENDENCY_SCOPES[carrier.ecosystem];
  if (scopes === undefined) throw error(`no public consumer dependency-scope policy for ${carrier.ecosystem}`);
  return [...new Set(carrier.packageDependencies
    .filter((dependency) => scopes.has(dependency.scope))
    .map((dependency) => `${dependency.ecosystem}:${dependency.name}`)
    .filter((id) => selectedCarrierIds.has(id)))]
    .sort(compareText);
}

function lockedEntryClosures(carriers, entries, ecosystem) {
  if (carriers.length === 0) return [];
  if (entries.length === 0) {
    throw error(`${ecosystem} selected carrier graph has no public consumer entry root`);
  }
  const byId = new Map(carriers.map((carrier) => [carrier.id, carrier]));
  const covered = new Set();
  const closures = entries.map((entryCarrierId) => {
    const closure = new Set();
    const pending = [entryCarrierId];
    while (pending.length > 0) {
      const id = pending.pop();
      if (closure.has(id)) continue;
      const carrier = byId.get(id);
      if (carrier === undefined) throw error(`${ecosystem} public entry closure refers to unknown carrier ${id}`);
      closure.add(id);
      covered.add(id);
      for (const dependency of carrier.dependencies) {
        // Cross-registry edges order publication, but this registry's clean
        // consumer cannot resolve them. The selected-lock validation above
        // still requires those carriers, and their own surfaces prove them.
        if (byId.has(dependency)) pending.push(dependency);
      }
    }
    return { entryCarrierId, carrierIds: [...closure].sort(compareText) };
  });
  const missing = carriers.map(({ id }) => id).filter((id) => !covered.has(id)).sort(compareText);
  if (missing.length > 0) {
    throw error(`${ecosystem} public consumer roots omit locked carrier dependencies: ${missing.join(", ")}`);
  }
  return closures;
}

function repositoryUrl(repository) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) {
    throw error(`repository must use owner/name, got ${JSON.stringify(repository)}`);
  }
  return `https://github.com/${repository}.git`;
}

/**
 * Derive the complete public-consumer surface from the same selected frozen
 * lock used for publication. Registry byte receipts already prove every
 * payload. This plan chooses dependency-graph roots for real consumer install
 * probes while retaining the complete transitive carrier set as a fail-closed
 * resolution assertion.
 */
export function publicConsumerPlan(lock, products, graph, {
  repository = process.env.GITHUB_REPOSITORY || DEFAULT_REPOSITORY,
} = {}) {
  if (lock === null || Array.isArray(lock) || typeof lock !== "object") {
    throw error("publication lock must be an object");
  }
  if (!SHA256_RE.test(lock.lockDigest ?? "") || !FULL_SHA_RE.test(lock.source?.commit ?? "") || !FULL_SHA_RE.test(lock.source?.tree ?? "")) {
    throw error("publication lock must contain an exact digest and source commit/tree");
  }
  const productRows = selectedProductRows(lock, products);
  const productIds = new Set(productRows.map(({ id }) => id));
  for (const product of productRows) {
    const targets = sortedUniqueStrings(product.publishTargets, `${product.id}.publishTargets`);
    const unsupported = targets.filter((target) => !SUPPORTED_PUBLISH_TARGETS.has(target));
    if (unsupported.length > 0) {
      throw error(`${product.id} has unsupported public consumer targets: ${unsupported.join(", ")}`);
    }
  }
  const carriers = lock.carriers
    .filter(({ product }) => productIds.has(product))
    .slice()
    .sort((left, right) => left.publishOrder - right.publishOrder || compareText(left.id, right.id));
  for (const carrier of carriers) assertCarrier(carrier, productIds);
  if (new Set(carriers.map(({ id }) => id)).size !== carriers.length) {
    throw error("publication lock contains duplicate selected carrier identities");
  }
  const selectedCarrierIds = new Set(carriers.map(({ id }) => id));
  const allCarriersById = new Map(lock.carriers.map((carrier) => [carrier.id, carrier]));
  for (const carrier of carriers) {
    const omitted = carrier.dependencies.filter((dependency) => {
      const locked = allCarriersById.get(dependency);
      return locked !== undefined && !selectedCarrierIds.has(dependency);
    });
    if (omitted.length > 0) {
      throw error(`${carrier.id} public consumer selection omits locked dependencies: ${omitted.join(", ")}`);
    }
  }
  const surfaces = [];
  for (const ecosystem of REGISTRY_ECOSYSTEMS) {
    const ecosystemCarriers = carriers.filter((carrier) => carrier.ecosystem === ecosystem);
    const targetProducts = productRows
      .filter((product) => product.publishTargets.some((target) => TARGET_ECOSYSTEM.get(target) === ecosystem))
      .map(({ id }) => id)
      .sort(compareText);
    const carrierProducts = [...new Set(ecosystemCarriers.map(({ product }) => product))].sort(compareText);
    if (!sameStrings(targetProducts, carrierProducts)) {
      throw error(`${ecosystem} publish targets and frozen carrier products disagree: targets=${JSON.stringify(targetProducts)}, carriers=${JSON.stringify(carrierProducts)}`);
    }
    if (ecosystemCarriers.length === 0) continue;
    const consumerCarriers = ecosystemCarriers.map((carrier) => ({
      ...carrier,
      dependencies: consumerDependencyIds(carrier, selectedCarrierIds),
    }));
    const entries = entryCarrierIds(consumerCarriers);
    const entryClosures = lockedEntryClosures(consumerCarriers, entries, ecosystem);
    surfaces.push({
      ecosystem,
      carrierIds: ecosystemCarriers.map(({ id }) => id).sort(compareText),
      entryCarrierIds: entries,
      entryClosures,
      dependencyScopes: [...CONSUMER_DEPENDENCY_SCOPES[ecosystem]].sort(compareText),
    });
  }

  const productTags = productRows.map((product) => {
    const config = graph?.products?.[product.id];
    if (typeof config?.tag_prefix !== "string" || config.tag_prefix.length === 0 || config.version !== product.version) {
      throw error(`${product.id} release graph tag/version does not match the frozen publication lock`);
    }
    return { product: product.id, tag: `${config.tag_prefix}${product.version}`, commit: lock.source.commit };
  }).sort((left, right) => compareText(left.product, right.product));

  const swiftProducts = productRows.filter((product) => product.publishTargets.includes("swift-package-source-tag"));
  if (swiftProducts.length > 1) throw error("only one selected SwiftPM source-tag product is supported");
  const swift = swiftProducts.length === 0 ? null : {
    product: swiftProducts[0].id,
    version: swiftProducts[0].version,
    tag: swiftProducts[0].version,
    parentCommit: lock.source.commit,
  };
  return {
    repository,
    repositoryUrl: repositoryUrl(repository),
    products: productRows.map(({ id }) => id).sort(compareText),
    surfaces,
    github: { productTags, swift },
  };
}

function boundedRegularJson(file, maximum, context) {
  const absolute = path.resolve(file);
  const stat = lstatSync(absolute);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > maximum) {
    throw error(`${context} must be a regular non-symlink file no larger than ${maximum} bytes`);
  }
  try {
    const bytes = readFileSync(absolute);
    return { absolute, bytes, value: JSON.parse(bytes.toString("utf8")) };
  } catch (cause) {
    throw error(`${context} is not valid JSON: ${cause.message}`);
  }
}

export function sanitizedPublicEnvironment(overrides = {}, inherited = process.env) {
  const env = { ...inherited };
  for (const name of Object.keys(env)) {
    if (
      /(?:^|_)(?:AUTH|PASSWORD|PASSPHRASE|SECRET|TOKEN|USERNAME)(?:_|$)/iu.test(name)
      || /^CARGO_(?:REGISTRIES|REGISTRY|SOURCE)_/iu.test(name)
      || /^GIT_/iu.test(name)
      || /^NPM_CONFIG_/iu.test(name)
      || /^ORG_GRADLE_PROJECT_/iu.test(name)
      || /^(?:DENO_CONFIG|DENO_DIR|DENO_IMPORT_MAP|DENO_LOCK|GRADLE_OPTS|JAVA_OPTS|JAVA_TOOL_OPTIONS|JDK_JAVA_OPTIONS|_JAVA_OPTIONS)$/iu.test(name)
    ) delete env[name];
  }
  for (const name of [
    "CARGO_REGISTRY_TOKEN",
    "CARGO_REGISTRIES_CRATES_IO_TOKEN",
    "CRATES_IO_BOOTSTRAP_TOKEN",
    "DENO_AUTH_TOKENS",
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "NODE_AUTH_TOKEN",
    "NPM_CONFIG__AUTH",
    "NPM_CONFIG__AUTHTOKEN",
    "NPM_TOKEN",
    "ORG_GRADLE_PROJECT_mavenCentralPassword",
    "ORG_GRADLE_PROJECT_mavenCentralUsername",
  ]) {
    delete env[name];
  }
  return { ...env, ...overrides };
}

function commandText(command, args) {
  return [command, ...args].map((part) => /[^A-Za-z0-9_./:@=+-]/u.test(part) ? JSON.stringify(part) : part).join(" ");
}

function looksLikeTransientPublicVisibilityFailure(detail) {
  return /(?:\b(?:404|408|425|429|500|502|503|504)\b|eai_again|econnreset|econnrefused|enotfound|etimedout|could(?:\s+not|n't)\s+find(?:\s+remote\s+ref)?|failed\s+to\s+(?:download|fetch|resolve)|no\s+matching\s+package|not\s+found|network\s+error|registry\s+index.*(?:unavailable|update)|remote\s+end\s+hung\s+up|spurious\s+network\s+error|temporary\s+failure|timed?\s*out|tls\s+(?:error|handshake))/iu.test(detail);
}

export async function runBoundedCommand(command, args, {
  cwd,
  env,
  deadlineMilliseconds,
  input,
  signal,
} = {}) {
  if (signal?.aborted) {
    throw error(`${commandText(command, args)} was cancelled before it could access a public endpoint`);
  }
  const sharedRemaining = deadlineMilliseconds - Date.now();
  if (!Number.isSafeInteger(deadlineMilliseconds) || sharedRemaining <= 0) {
    throw error(`shared public-consumer deadline reached before ${commandText(command, args)}`);
  }
  const commandWindow = Math.min(sharedRemaining, MAX_COMMAND_ATTEMPT_MILLISECONDS);
  const commandWindowIsSharedRemainder = commandWindow === sharedRemaining;
  return await new Promise((resolve, reject) => {
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let outputExceeded = false;
    let timedOut = false;
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    const append = (current, chunk) => {
      if (current.length + chunk.length > MAX_COMMAND_OUTPUT_BYTES) {
        outputExceeded = true;
        child.kill("SIGTERM");
        return current;
      }
      return Buffer.concat([current, chunk]);
    };
    child.stdout.on("data", (chunk) => { stdout = append(stdout, Buffer.from(chunk)); });
    child.stderr.on("data", (chunk) => { stderr = append(stderr, Buffer.from(chunk)); });
    if (input !== undefined) child.stdin.end(input);
    const terminate = () => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    };
    let abortKillTimer;
    const abort = () => {
      terminate();
      abortKillTimer ??= setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, 5_000);
    };
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, commandWindow);
    const killTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }, commandWindow + 5_000);
    child.on("error", (cause) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      clearTimeout(abortKillTimer);
      signal?.removeEventListener("abort", abort);
      reject(new PublicCommandError(`${TOOL}: ${commandText(command, args)} could not start: ${cause.message}`));
    });
    child.on("close", (status, childSignal) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      clearTimeout(abortKillTimer);
      signal?.removeEventListener("abort", abort);
      if (status === 0 && !timedOut && !outputExceeded && !signal?.aborted) {
        resolve({ stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8") });
        return;
      }
      const detail = stderr.toString("utf8").trim() || stdout.toString("utf8").trim();
      const reason = outputExceeded
        ? `exceeded ${MAX_COMMAND_OUTPUT_BYTES} output bytes`
        : timedOut
          ? "reached the shared public-consumer deadline"
          : signal?.aborted
            ? "was cancelled after a peer consumer probe failed"
            : `failed with status ${status ?? `<signal ${childSignal}>`}`;
      const rendered = `${commandText(command, args)} ${reason}${detail ? `: ${detail.slice(-8_192)}` : ""}`;
      reject(new PublicCommandError(`${TOOL}: ${rendered}`, {
        retryable: !signal?.aborted && (
          (timedOut && !commandWindowIsSharedRemainder)
          || (!timedOut && looksLikeTransientPublicVisibilityFailure(detail))
        ),
      }));
    });
  });
}

async function boundedRetryDelay(milliseconds, deadlineMilliseconds, signal) {
  if (signal?.aborted) throw error("public consumer retry cancelled after a peer surface failed");
  if (deadlineMilliseconds - Date.now() <= milliseconds + 30_000) {
    throw error("public consumer retry would cross the shared deadline");
  }
  await new Promise((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(error("public consumer retry cancelled after a peer surface failed"));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

export async function runSurfaceWithRetries(
  surface,
  parentRoot,
  deadlineMilliseconds,
  signal,
  execute,
  {
    maxAttempts = MAX_SURFACE_ATTEMPTS,
    retryDelays = RETRY_DELAYS_MILLISECONDS,
  } = {},
) {
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || !Array.isArray(retryDelays) || retryDelays.length < maxAttempts - 1) {
    throw error("public consumer retry policy must provide one bounded non-negative delay per retry");
  }
  if (retryDelays.some((delay) => !Number.isSafeInteger(delay) || delay < 0)) {
    throw error("public consumer retry delays must be non-negative safe integers");
  }
  let last;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const root = path.join(parentRoot, `${surface}-attempt-${String(attempt).padStart(2, "0")}`);
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });
    try {
      return await execute(root);
    } catch (cause) {
      last = cause;
      rmSync(root, { recursive: true, force: true });
      if (!(cause instanceof PublicCommandError) || !cause.retryable || attempt >= maxAttempts || signal?.aborted) {
        throw cause;
      }
      const delay = retryDelays[attempt - 1];
      console.warn(`${TOOL}: ${surface} public visibility attempt ${attempt} was transient; retrying from an empty consumer/cache in ${delay / 1_000}s.`);
      await boundedRetryDelay(delay, deadlineMilliseconds, signal);
    }
  }
  throw last;
}

function carrierRows(lock, surface) {
  const ids = new Set(surface.carrierIds);
  return lock.carriers.filter(({ id }) => ids.has(id)).sort((left, right) => compareText(left.id, right.id));
}

function resolvedSurfaceCoverage(surface, entries, rows) {
  const closureByEntry = new Map(surface.entryClosures.map((entry) => [entry.entryCarrierId, entry.carrierIds]));
  if (!sameStrings(entries.map(({ entryCarrierId }) => entryCarrierId), surface.entryCarrierIds)) {
    throw error(`${surface.ecosystem} consumer probes omit one or more exact-lock entry roots`);
  }
  const merged = new Map();
  for (const row of rows.flat()) {
    const prior = merged.get(row.id);
    if (prior !== undefined && stableJson(prior) !== stableJson(row)) {
      throw error(`${surface.ecosystem} consumer probes returned conflicting resolution evidence for ${row.id}`);
    }
    merged.set(row.id, row);
  }
  const carrierIds = new Set(surface.carrierIds);
  const normalizedEntries = entries.map((entry) => {
    const planned = new Set(closureByEntry.get(entry.entryCarrierId) ?? []);
    const resolvedCarrierIds = sortedUniqueStrings(entry.resolvedCarrierIds, `${surface.ecosystem} ${entry.entryCarrierId} resolvedCarrierIds`);
    if (!resolvedCarrierIds.includes(entry.entryCarrierId)) {
      throw error(`${surface.ecosystem} public consumer entry ${entry.entryCarrierId} did not resolve itself exactly`);
    }
    const outside = resolvedCarrierIds.filter((id) => !planned.has(id));
    if (outside.length > 0) {
      throw error(`${surface.ecosystem} public consumer entry ${entry.entryCarrierId} resolved selected carriers outside its frozen dependency closure: ${outside.join(", ")}`);
    }
    const missing = [...planned].filter((id) => !resolvedCarrierIds.includes(id)).sort(compareText);
    if (missing.length > 0) {
      throw error(`${surface.ecosystem} public consumer entry ${entry.entryCarrierId} omitted frozen platform-independent lock dependencies: ${missing.join(", ")}`);
    }
    return { entryCarrierId: entry.entryCarrierId, resolvedCarrierIds };
  }).sort((left, right) => compareText(left.entryCarrierId, right.entryCarrierId));
  const resolved = [...merged.values()].sort((left, right) => compareText(left.id, right.id));
  const unknown = resolved.map(({ id }) => id).filter((id) => !carrierIds.has(id));
  if (unknown.length > 0) throw error(`${surface.ecosystem} consumer probes returned unknown selected carriers: ${unknown.join(", ")}`);
  if (!sameStrings(resolved.map(({ id }) => id), surface.carrierIds)) {
    throw error(`${surface.ecosystem} public entry lock closures do not resolve the exhaustive frozen carrier set`);
  }
  return {
    carrierIds: surface.carrierIds,
    dependencyScopes: surface.dependencyScopes,
    entryCarrierIds: surface.entryCarrierIds,
    plannedEntryClosures: surface.entryClosures,
    entries: normalizedEntries,
    resolved,
  };
}

function tomlString(value) {
  return JSON.stringify(value);
}

export function validateCargoResolution(lockText, carriers, requiredCarrierIds = carriers.map(({ id }) => id)) {
  let parsed;
  try {
    parsed = Bun.TOML.parse(lockText);
  } catch (cause) {
    throw error(`clean Cargo.lock is invalid: ${cause.message}`);
  }
  const packages = Array.isArray(parsed.package) ? parsed.package : [];
  const byName = new Map(carriers.map((carrier) => [carrier.name, carrier]));
  const rows = [];
  for (const entry of packages) {
    const carrier = byName.get(entry?.name);
    if (carrier === undefined) continue;
    if (entry.version !== carrier.version) {
      throw error(`${carrier.id} resolved substituted Cargo version ${entry.version}, expected exact ${carrier.version}`);
    }
    if (entry.source !== "registry+https://github.com/rust-lang/crates.io-index") {
      throw error(`${carrier.id}@${carrier.version} resolved through non-public or substituted Cargo source ${JSON.stringify(entry.source)}`);
    }
    if (!SHA256_RE.test(entry.checksum ?? "")) {
      throw error(`${carrier.id}@${carrier.version} clean resolution has no crates.io checksum`);
    }
    rows.push({ id: carrier.id, version: carrier.version, checksum: entry.checksum });
  }
  const ids = rows.map(({ id }) => id);
  if (new Set(ids).size !== ids.length) throw error("clean Cargo resolution contains duplicate exact selected carrier identities");
  const missing = requiredCarrierIds.filter((id) => !ids.includes(id));
  if (missing.length > 0) throw error(`clean Cargo resolution omitted required exact carriers: ${missing.join(", ")}`);
  return rows.sort((left, right) => compareText(left.id, right.id));
}

async function runCargoSurface({ lock, surface, root, deadlineMilliseconds, signal }) {
  const directory = path.join(root, "cargo");
  const home = path.join(root, "cargo-home");
  mkdirSync(home, { recursive: true });
  const carriers = carrierRows(lock, surface);
  const byId = new Map(carriers.map((carrier) => [carrier.id, carrier]));
  const env = sanitizedPublicEnvironment({
    CARGO_HOME: home,
    CARGO_NET_GIT_FETCH_WITH_CLI: "true",
    CARGO_REGISTRIES_CRATES_IO_PROTOCOL: "sparse",
    HOME: path.join(root, "cargo-user-home"),
  });
  const entries = [];
  const rows = [];
  for (const [index, entryCarrierId] of surface.entryCarrierIds.entries()) {
    const carrier = byId.get(entryCarrierId);
    const consumer = path.join(directory, `entry-${String(index).padStart(3, "0")}`);
    mkdirSync(path.join(consumer, "src"), { recursive: true });
    writeFileSync(
      path.join(consumer, "Cargo.toml"),
      `[package]\nname = "oliphaunt-public-consumer-smoke-${String(index).padStart(3, "0")}"\nversion = "0.0.0"\nedition = "2021"\npublish = false\n\n[dependencies]\nlocked_entry = { package = ${tomlString(carrier.name)}, version = ${tomlString(`=${carrier.version}`)} }\n`,
    );
    writeFileSync(path.join(consumer, "src/lib.rs"), "// dependency resolution only; immutable receipts prove target payload bytes.\n");
    await runBoundedCommand("cargo", ["generate-lockfile"], { cwd: consumer, env, deadlineMilliseconds, signal });
    const resolved = validateCargoResolution(
      readFileSync(path.join(consumer, "Cargo.lock"), "utf8"),
      carriers,
      [entryCarrierId],
    );
    rows.push(resolved);
    entries.push({ entryCarrierId, resolvedCarrierIds: resolved.map(({ id }) => id) });
  }
  return {
    surface: "cargo",
    mode: "anonymous-public-independent-entry-resolution-no-compile",
    registry: "https://crates.io",
    ...resolvedSurfaceCoverage(surface, entries, rows),
    receiptCoveredWithoutPayloadFetchCarrierIds: surface.carrierIds,
  };
}

function npmPackagePath(root, packageName) {
  return path.join(root, "node_modules", ...packageName.split("/"));
}

export function validateNpmResolution(packageLock, carriers, requiredEntryIds, nodeModules) {
  if (packageLock === null || Array.isArray(packageLock) || typeof packageLock !== "object" || packageLock.lockfileVersion < 3) {
    throw error("clean npm install must emit package-lock v3 or newer");
  }
  const packages = packageLock.packages;
  if (packages === null || Array.isArray(packages) || typeof packages !== "object") {
    throw error("clean npm package lock has no packages map");
  }
  const entries = new Set(requiredEntryIds);
  const resolved = [];
  for (const carrier of carriers) {
    const suffix = `node_modules/${carrier.name}`;
    const matches = Object.entries(packages).filter(([key]) => key === suffix || key.endsWith(`/${suffix}`));
    if (matches.length === 0) {
      if (entries.has(carrier.id)) throw error(`${carrier.id}@${carrier.version} is missing from the clean npm lock`);
      continue;
    }
    if (matches.length !== 1 || matches[0][1]?.version !== carrier.version) {
      throw error(`${carrier.id}@${carrier.version} must be the only selected version in the clean npm lock; found ${matches.length}`);
    }
    const row = matches[0][1];
    if (
      row.link === true
      || typeof row.resolved !== "string"
      || !row.resolved.startsWith("https://registry.npmjs.org/")
      || typeof row.integrity !== "string"
      || !row.integrity.startsWith("sha512-")
    ) {
      throw error(`${carrier.id}@${carrier.version} resolved through a non-public, linked, or integrity-free npm source`);
    }
    if (entries.has(carrier.id)) {
      const manifestFile = path.join(npmPackagePath(nodeModules, carrier.name), "package.json");
      let installed;
      try { installed = JSON.parse(readFileSync(manifestFile, "utf8")); } catch (cause) {
        throw error(`${carrier.id}@${carrier.version} entry package was not installed from the public registry: ${cause.message}`);
      }
      if (installed.name !== carrier.name || installed.version !== carrier.version) {
        throw error(`${carrier.id} installed package identity does not match ${carrier.name}@${carrier.version}`);
      }
    }
    resolved.push({ id: carrier.id, version: carrier.version, integrity: row.integrity });
  }
  resolved.sort((left, right) => compareText(left.id, right.id));
  const installedCarrierIds = carriers
    .filter((carrier) => {
      try { return statSync(path.join(npmPackagePath(nodeModules, carrier.name), "package.json")).isFile(); } catch { return false; }
    })
    .map(({ id }) => id)
    .sort(compareText);
  return { resolved, installedCarrierIds };
}

async function runNpmSurface({ lock, surface, root, deadlineMilliseconds, signal }) {
  const directory = path.join(root, "npm");
  const home = path.join(root, "npm-home");
  mkdirSync(directory, { recursive: true });
  mkdirSync(home, { recursive: true });
  const carriers = carrierRows(lock, surface);
  const byId = new Map(carriers.map((carrier) => [carrier.id, carrier]));
  const userConfig = path.join(home, ".npmrc");
  const globalConfig = path.join(home, "global.npmrc");
  writeFileSync(userConfig, "registry=https://registry.npmjs.org/\nalways-auth=false\n");
  writeFileSync(globalConfig, "registry=https://registry.npmjs.org/\nalways-auth=false\n");
  const env = sanitizedPublicEnvironment({
    HOME: home,
    NPM_CONFIG_CACHE: path.join(root, "npm-cache"),
    NPM_CONFIG_GLOBALCONFIG: globalConfig,
    NPM_CONFIG_REGISTRY: "https://registry.npmjs.org/",
    NPM_CONFIG_USERCONFIG: userConfig,
  });
  const entries = [];
  const rows = [];
  const installed = new Set();
  for (const [index, entryCarrierId] of surface.entryCarrierIds.entries()) {
    const carrier = byId.get(entryCarrierId);
    const consumer = path.join(directory, `entry-${String(index).padStart(3, "0")}`);
    mkdirSync(consumer, { recursive: true });
    writeFileSync(path.join(consumer, "package.json"), `${JSON.stringify({
      name: `oliphaunt-public-consumer-smoke-${String(index).padStart(3, "0")}`,
      version: "0.0.0",
      private: true,
      dependencies: { [carrier.name]: carrier.version },
    }, null, 2)}\n`);
    await runBoundedCommand("npm", [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--omit=peer",
      "--registry=https://registry.npmjs.org/",
    ], { cwd: consumer, env, deadlineMilliseconds, signal });
    const lockJson = JSON.parse(readFileSync(path.join(consumer, "package-lock.json"), "utf8"));
    const result = validateNpmResolution(lockJson, carriers, [entryCarrierId], consumer);
    rows[index] = result.resolved;
    entries[index] = { entryCarrierId, resolvedCarrierIds: result.resolved.map(({ id }) => id) };
    for (const id of result.installedCarrierIds) installed.add(id);
  }
  return {
    surface: "npm",
    mode: "anonymous-public-independent-entry-host-install-and-lock-resolution",
    registry: "https://registry.npmjs.org",
    host: `${process.platform}-${process.arch}`,
    ...resolvedSurfaceCoverage(surface, entries, rows),
    installedCarrierIds: [...installed].sort(compareText),
    receiptCoveredNotHostInstalledCarrierIds: surface.carrierIds.filter((id) => !installed.has(id)).sort(compareText),
  };
}

function mavenCoordinate(name, version) {
  const parts = name.split(":");
  if (parts.length !== 2 || parts.some((value) => value.length === 0)) {
    throw error(`invalid locked Maven coordinate ${JSON.stringify(name)}`);
  }
  return `${name}:${version}`;
}

export function validateMavenResolution(output, carriers, entryCarrierIds = carriers.map(({ id }) => id)) {
  const prefix = "OLIPHAUNT_PUBLIC_COMPONENT\t";
  const rows = output.split(/\r?\n/u)
    .filter((line) => line.startsWith(prefix))
    .map((line) => line.slice(prefix.length).split("\t"));
  if (rows.some((parts) => parts.length !== 4)) throw error("clean Maven resolution emitted malformed component evidence");
  const byName = new Map(carriers.map((carrier) => [carrier.name, carrier]));
  const resolvedByEntry = new Map(entryCarrierIds.map((id) => [id, new Map()]));
  for (const [entryCarrierId, group, artifact, version] of rows) {
    const entry = resolvedByEntry.get(entryCarrierId);
    if (entry === undefined) throw error(`clean Maven resolution emitted unknown entry root ${entryCarrierId}`);
    const carrier = byName.get(`${group}:${artifact}`);
    if (carrier === undefined) continue;
    if (version !== carrier.version) {
      throw error(`${carrier.id} resolved substituted Maven version ${version}, expected exact ${carrier.version}`);
    }
    entry.set(carrier.id, { id: carrier.id, version: carrier.version });
  }
  const entries = entryCarrierIds.map((entryCarrierId) => {
    const resolved = resolvedByEntry.get(entryCarrierId);
    if (!resolved.has(entryCarrierId)) {
      throw error(`${entryCarrierId} was omitted from its independent clean Maven Central resolution`);
    }
    return { entryCarrierId, resolvedCarrierIds: [...resolved.keys()].sort(compareText) };
  });
  const resolved = new Map();
  for (const values of resolvedByEntry.values()) {
    for (const [id, row] of values) resolved.set(id, row);
  }
  return { entries, resolved: [...resolved.values()].sort((left, right) => compareText(left.id, right.id)) };
}

export async function runMavenSurface({ lock, surface, root, deadlineMilliseconds, signal }) {
  const directory = path.join(root, "maven");
  mkdirSync(directory, { recursive: true });
  const carriers = carrierRows(lock, surface);
  const byId = new Map(carriers.map((carrier) => [carrier.id, carrier]));
  writeFileSync(path.join(directory, "settings.gradle"), "rootProject.name = 'oliphaunt-public-consumer-smoke'\n");
  const probes = surface.entryCarrierIds.map((entryCarrierId, index) => ({
    carrier: byId.get(entryCarrierId),
    configuration: `smoke${String(index).padStart(3, "0")}`,
    entryCarrierId,
  }));
  const configurations = probes.map(({ configuration }) => `  ${configuration} {\n    canBeConsumed = false\n    canBeResolved = true\n  }`);
  const dependencies = probes.map(({ carrier, configuration }) =>
    `  ${configuration}(${JSON.stringify(mavenCoordinate(carrier.name, carrier.version))}) { version { strictly(${JSON.stringify(carrier.version)}) } }`);
  const probeRows = probes.map(({ configuration, entryCarrierId }) =>
    `    [${JSON.stringify(entryCarrierId)}, ${JSON.stringify(configuration)}]`).join(",\n");
  writeFileSync(path.join(directory, "build.gradle"), `
repositories {
  mavenCentral()
  google()
}

configurations {
${configurations.join("\n")}
}

dependencies {
${dependencies.join("\n")}
}

tasks.register("resolveOliphauntPublicConsumers") {
  doLast {
    def probes = [
${probeRows}
    ]
    probes.each { probe ->
      def entryCarrierId = probe[0]
      def configuration = configurations.getByName(probe[1])
      configuration.files
      def ids = configuration.incoming.resolutionResult.allComponents
        .collect { it.id }
        .findAll { it instanceof org.gradle.api.artifacts.component.ModuleComponentIdentifier }
        .collect { "${"$"}{it.group}\\t${"$"}{it.module}\\t${"$"}{it.version}" }
        .toSorted()
      ids.each { println("OLIPHAUNT_PUBLIC_COMPONENT\\t" + entryCarrierId + "\\t" + it) }
    }
  }
}
`);
  const wrapper = path.join(ROOT, "src/sdks/kotlin/gradlew");
  if (!statSync(wrapper, { throwIfNoEntry: false })?.isFile()) throw error("Gradle wrapper is unavailable");
  const env = sanitizedPublicEnvironment({
    GRADLE_USER_HOME: path.join(root, "gradle-home"),
    HOME: path.join(root, "gradle-user-home"),
  });
  const result = await runBoundedCommand(wrapper, [
    "--no-daemon",
    "--console=plain",
    "--project-dir",
    directory,
    "resolveOliphauntPublicConsumers",
  ], { cwd: directory, env, deadlineMilliseconds, signal });
  const resolution = validateMavenResolution(result.stdout, carriers, surface.entryCarrierIds);
  return {
    surface: "maven",
    mode: "anonymous-public-independent-entry-coordinate-resolution-no-compile",
    registries: ["https://repo1.maven.org/maven2", "https://dl.google.com/dl/android/maven2"],
    ...resolvedSurfaceCoverage(surface, resolution.entries, [resolution.resolved]),
  };
}

function jsrSpecifier(name, version) {
  if (!name.startsWith("@") || !name.includes("/")) throw error(`invalid locked JSR package name ${JSON.stringify(name)}`);
  return `jsr:${name}@${version}`;
}

export function validateJsrResolution(denoLock, carriers, requiredCarrierIds = carriers.map(({ id }) => id)) {
  if (
    denoLock === null
    || Array.isArray(denoLock)
    || typeof denoLock !== "object"
    || denoLock.jsr === null
    || Array.isArray(denoLock.jsr)
    || typeof denoLock.jsr !== "object"
  ) {
    throw error("Deno did not emit a JSR package lock map");
  }
  const resolved = [];
  for (const carrier of carriers) {
    const prefix = `${carrier.name}@`;
    const matches = Object.entries(denoLock.jsr).filter(([name]) => name.startsWith(prefix));
    if (matches.length === 0) continue;
    const exact = `${carrier.name}@${carrier.version}`;
    if (matches.length !== 1 || matches[0][0] !== exact) {
      throw error(`${carrier.id} resolved a substituted or duplicate JSR version instead of exact ${carrier.version}`);
    }
    const integrity = matches[0][1]?.integrity;
    if (!SHA256_RE.test(integrity ?? "")) throw error(`${carrier.id}@${carrier.version} clean JSR lock has no SHA-256 integrity`);
    resolved.push({ id: carrier.id, version: carrier.version, integrity });
  }
  const resolvedIds = new Set(resolved.map(({ id }) => id));
  const missing = requiredCarrierIds.filter((id) => !resolvedIds.has(id));
  if (missing.length > 0) throw error(`required exact JSR entries were omitted from clean resolution: ${missing.join(", ")}`);
  return resolved.sort((left, right) => compareText(left.id, right.id));
}

async function runJsrSurface({ lock, surface, root, deadlineMilliseconds, signal }) {
  const directory = path.join(root, "jsr");
  mkdirSync(directory, { recursive: true });
  const carriers = carrierRows(lock, surface);
  const byId = new Map(carriers.map((carrier) => [carrier.id, carrier]));
  const env = sanitizedPublicEnvironment({
    DENO_DIR: path.join(root, "deno-cache"),
    HOME: path.join(root, "deno-home"),
  });
  const entries = [];
  const rows = [];
  for (const [index, entryCarrierId] of surface.entryCarrierIds.entries()) {
    const carrier = byId.get(entryCarrierId);
    const consumer = path.join(directory, `entry-${String(index).padStart(3, "0")}`);
    mkdirSync(consumer, { recursive: true });
    writeFileSync(path.join(consumer, "smoke.ts"), `import ${JSON.stringify(jsrSpecifier(carrier.name, carrier.version))};\n`);
    await runBoundedCommand("deno", ["cache", "--reload", "--lock=deno.lock", "smoke.ts"], {
      cwd: consumer, env, deadlineMilliseconds, signal,
    });
    let denoLock;
    try { denoLock = JSON.parse(readFileSync(path.join(consumer, "deno.lock"), "utf8")); } catch (cause) {
      throw error(`Deno emitted an invalid package lock: ${cause.message}`);
    }
    const resolved = validateJsrResolution(denoLock, carriers, [entryCarrierId]);
    rows.push(resolved);
    entries.push({ entryCarrierId, resolvedCarrierIds: resolved.map(({ id }) => id) });
  }
  return {
    surface: "jsr",
    mode: "anonymous-public-independent-entry-exact-source-cache",
    registry: "https://jsr.io",
    ...resolvedSurfaceCoverage(surface, entries, rows),
  };
}

function gitEnvironment(root) {
  const home = path.join(root, "git-home");
  mkdirSync(home, { recursive: true });
  return sanitizedPublicEnvironment({
    GIT_ASKPASS: "",
    GIT_CONFIG_GLOBAL: path.join(root, "empty-gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    HOME: home,
    SSH_ASKPASS: "",
  });
}

async function git(commandArgs, options) {
  return await runBoundedCommand("git", [
    "-c", "credential.helper=",
    "-c", "http.extraHeader=",
    ...commandArgs,
  ], options);
}

async function runGithubSurface({ plan, root, deadlineMilliseconds, signal }) {
  const directory = path.join(root, "github.git");
  const env = gitEnvironment(root);
  await git(["init", "--bare", directory], { cwd: root, env, deadlineMilliseconds, signal });
  const tags = [...plan.github.productTags.map(({ tag }) => tag)];
  if (plan.github.swift !== null) tags.push(plan.github.swift.tag);
  const uniqueTags = [...new Set(tags)].sort(compareText);
  await git([
    "--git-dir", directory,
    "fetch", "--no-tags", "--force", plan.repositoryUrl,
    ...uniqueTags.map((tag) => `refs/tags/${tag}:refs/tags/${tag}`),
  ], { cwd: root, env, deadlineMilliseconds, signal });
  const resolvedProductTags = [];
  for (const row of plan.github.productTags) {
    const result = await git(["--git-dir", directory, "rev-parse", `${row.tag}^{commit}`], {
      cwd: root, env, deadlineMilliseconds, signal,
    });
    const commit = result.stdout.trim();
    if (commit !== row.commit) throw error(`anonymous public tag ${row.tag} resolves to ${commit}, not exact ${row.commit}`);
    resolvedProductTags.push(row);
  }
  let swift = null;
  if (plan.github.swift !== null) {
    const row = plan.github.swift;
    const commitResult = await git(["--git-dir", directory, "rev-parse", `${row.tag}^{commit}`], {
      cwd: root, env, deadlineMilliseconds, signal,
    });
    const commit = commitResult.stdout.trim();
    const parentsResult = await git(["--git-dir", directory, "rev-list", "--parents", "-n", "1", commit], {
      cwd: root, env, deadlineMilliseconds, signal,
    });
    const parents = parentsResult.stdout.trim().split(/\s+/u).slice(1);
    if (parents.length !== 1 || parents[0] !== row.parentCommit) {
      throw error(`SwiftPM source tag ${row.tag} must be a single synthetic child of exact ${row.parentCommit}`);
    }
    const checkout = path.join(root, "swift-source");
    mkdirSync(checkout, { recursive: true });
    await git(["--git-dir", directory, "--work-tree", checkout, "checkout", "--force", commit, "--", "."], {
      cwd: root, env, deadlineMilliseconds, signal,
    });
    const swiftEnv = sanitizedPublicEnvironment({
      CLANG_MODULE_CACHE_PATH: path.join(root, "swift-module-cache"),
      HOME: path.join(root, "swift-home"),
      SWIFTPM_MODULECACHE_OVERRIDE: path.join(root, "swift-module-cache"),
    });
    const manifest = await runBoundedCommand("swift", ["package", "dump-package"], {
      cwd: checkout, env: swiftEnv, deadlineMilliseconds, signal,
    });
    let packageDescription;
    try { packageDescription = JSON.parse(manifest.stdout); } catch (cause) {
      throw error(`SwiftPM source tag ${row.tag} package manifest is invalid: ${cause.message}`);
    }
    if (typeof packageDescription.name !== "string" || packageDescription.name.length === 0) {
      throw error(`SwiftPM source tag ${row.tag} has no package name`);
    }
    const treeResult = await git(["--git-dir", directory, "rev-parse", `${commit}^{tree}`], {
      cwd: root, env, deadlineMilliseconds, signal,
    });
    swift = {
      ...row,
      commit,
      tree: treeResult.stdout.trim(),
      packageName: packageDescription.name,
      proofScope: "anonymous-source-tag-and-manifest-only",
    };
  }
  return {
    surface: "github",
    mode: "anonymous-public-exact-tag-resolution",
    repository: plan.repository,
    productTags: resolvedProductTags,
    swift,
    limitation: plan.github.swift === null
      ? null
      : "Draft GitHub binaryTarget assets are not anonymously public before promotion; their exact bytes are covered by the bound immutable GitHub receipt, not this source-tag probe.",
  };
}

export function publicConsumerEvidence({ lock, plan, registryReceiptSha256, githubReceiptDigest, surfaces }) {
  const result = {
    schema: PUBLIC_CONSUMER_EVIDENCE_SCHEMA,
    lockDigest: lock.lockDigest,
    source: lock.source,
    products: plan.products,
    repository: plan.repository,
    proofScope: {
      host: `${process.platform}-${process.arch}`,
      statement: "Anonymous public dependency resolution/install on the publish host; same-SHA CI and immutable receipts cover the complete supported platform artifact matrix.",
    },
    receiptBindings: {
      githubReceiptDigest,
      registryReceiptSha256,
    },
    surfaces: surfaces.slice().sort((left, right) => compareText(left.surface, right.surface)),
  };
  result.evidenceDigest = sha256Bytes(stableJson(result));
  return result;
}

export function validatePublicConsumerEvidence(evidence, lock, plan) {
  if (evidence === null || Array.isArray(evidence) || typeof evidence !== "object") throw error("public consumer evidence must be an object");
  if (evidence.schema !== PUBLIC_CONSUMER_EVIDENCE_SCHEMA) throw error(`public consumer evidence schema must be ${PUBLIC_CONSUMER_EVIDENCE_SCHEMA}`);
  if (evidence.lockDigest !== lock.lockDigest || stableJson(evidence.source) !== stableJson(lock.source)) {
    throw error("public consumer evidence is not bound to the active publication lock");
  }
  if (!sameStrings(evidence.products ?? [], plan.products)) throw error("public consumer evidence products differ from the exact lock selection");
  if (!SHA256_RE.test(evidence.receiptBindings?.registryReceiptSha256 ?? "") || !SHA256_RE.test(evidence.receiptBindings?.githubReceiptDigest ?? "")) {
    throw error("public consumer evidence has invalid immutable receipt bindings");
  }
  const expectedSurfaces = [...plan.surfaces.map(({ ecosystem }) => ecosystem), "github"].sort(compareText);
  const actualSurfaces = Array.isArray(evidence.surfaces) ? evidence.surfaces.map(({ surface }) => surface) : [];
  if (!sameStrings(actualSurfaces, expectedSurfaces)) {
    throw error(`public consumer evidence surface coverage mismatch: expected=${JSON.stringify(expectedSurfaces)}, actual=${JSON.stringify(actualSurfaces)}`);
  }
  for (const surface of plan.surfaces) {
    const observed = evidence.surfaces.find(({ surface: name }) => name === surface.ecosystem);
    if (!sameStrings(observed?.carrierIds ?? [], surface.carrierIds) || !sameStrings(observed?.entryCarrierIds ?? [], surface.entryCarrierIds)) {
      throw error(`${surface.ecosystem} public consumer evidence omits exact-lock carriers or entry roots`);
    }
    if (stableJson(observed?.plannedEntryClosures) !== stableJson(surface.entryClosures)) {
      throw error(`${surface.ecosystem} public consumer evidence changed the frozen entry dependency closures`);
    }
    if (stableJson(observed?.dependencyScopes) !== stableJson(surface.dependencyScopes)) {
      throw error(`${surface.ecosystem} public consumer evidence changed the package-manager dependency scope policy`);
    }
    const coverage = resolvedSurfaceCoverage(surface, observed?.entries ?? [], [observed?.resolved ?? []]);
    for (const field of [
      "carrierIds",
      "dependencyScopes",
      "entryCarrierIds",
      "plannedEntryClosures",
      "entries",
      "resolved",
    ]) {
      if (stableJson(observed?.[field]) !== stableJson(coverage[field])) {
        throw error(`${surface.ecosystem} public consumer evidence has non-canonical ${field} coverage`);
      }
    }
    if (surface.ecosystem === "npm") {
      const installed = sortedUniqueStrings(observed?.installedCarrierIds ?? [], "npm installedCarrierIds");
      const resolved = new Set(coverage.resolved.map(({ id }) => id));
      if (installed.some((id) => !resolved.has(id)) || stableJson(installed) !== stableJson(observed.installedCarrierIds)) {
        throw error("npm host-installed carriers must be a canonical subset of its exact public resolution");
      }
      const notInstalled = surface.carrierIds.filter((id) => !installed.includes(id)).sort(compareText);
      if (stableJson(observed.receiptCoveredNotHostInstalledCarrierIds) !== stableJson(notInstalled)) {
        throw error("npm evidence must explicitly distinguish exhaustive lock resolution from the publish-host installed subset");
      }
    }
    if (
      surface.ecosystem === "cargo"
      && stableJson(observed.receiptCoveredWithoutPayloadFetchCarrierIds) !== stableJson(surface.carrierIds)
    ) {
      throw error("Cargo evidence must explicitly distinguish registry resolution from receipt-proved payload bytes");
    }
  }
  const github = evidence.surfaces.find(({ surface }) => surface === "github");
  if (stableJson(github?.productTags) !== stableJson(plan.github.productTags)) {
    throw error("GitHub public consumer evidence does not resolve every exact product tag");
  }
  if (plan.github.swift === null ? github?.swift !== null : github?.swift?.tag !== plan.github.swift.tag) {
    throw error("GitHub public consumer evidence SwiftPM source-tag coverage mismatch");
  }
  const withoutDigest = structuredClone(evidence);
  delete withoutDigest.evidenceDigest;
  const expectedDigest = sha256Bytes(stableJson(withoutDigest));
  if (evidence.evidenceDigest !== expectedDigest) throw error(`public consumer evidence digest mismatch: expected ${expectedDigest}`);
  return evidence;
}

export function writeImmutablePublicConsumerEvidence(file, evidence) {
  const absolute = path.resolve(file);
  const body = `${JSON.stringify(evidence, null, 2)}\n`;
  if (Buffer.byteLength(body) > MAX_EVIDENCE_BYTES) throw error(`public consumer evidence exceeds ${MAX_EVIDENCE_BYTES} bytes`);
  mkdirSync(path.dirname(absolute), { recursive: true });
  const temporary = `${absolute}.tmp-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(temporary, body, { flag: "wx", mode: 0o644 });
    try {
      linkSync(temporary, absolute);
    } catch (cause) {
      if (cause?.code !== "EEXIST") throw cause;
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_EVIDENCE_BYTES) {
        throw error(`refusing to replace unsafe existing public consumer evidence ${file}`);
      }
      if (readFileSync(absolute, "utf8") !== body) {
        throw error(`refusing to replace non-identical immutable public consumer evidence ${file}`);
      }
    }
  } finally {
    try { unlinkSync(temporary); } catch {}
  }
  return absolute;
}

function parseArgs(argv) {
  const options = {
    githubReceipt: "",
    lock: DEFAULT_PUBLICATION_LOCK,
    output: DEFAULT_OUTPUT,
    productsJson: "",
    registryReceipts: "",
    repository: process.env.GITHUB_REPOSITORY || DEFAULT_REPOSITORY,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") return { help: true };
    const separator = argument.indexOf("=");
    const flag = separator === -1 ? argument : argument.slice(0, separator);
    const value = separator === -1 ? argv[++index] : argument.slice(separator + 1);
    if (value === undefined || value.length === 0) throw error(`${flag} requires a value`);
    if (flag === "--github-release-receipt") options.githubReceipt = value;
    else if (flag === "--publication-lock") options.lock = value;
    else if (flag === "--output") options.output = value;
    else if (flag === "--products-json") options.productsJson = value;
    else if (flag === "--registry-receipts") options.registryReceipts = value;
    else if (flag === "--repository") options.repository = value;
    else throw error(`unknown argument ${argument}`);
  }
  if (!options.productsJson || !options.registryReceipts || !options.githubReceipt) {
    throw error("--products-json, --registry-receipts, and --github-release-receipt are required");
  }
  let products;
  try { products = JSON.parse(options.productsJson); } catch (cause) { throw error(`--products-json is invalid: ${cause.message}`); }
  return { ...options, products };
}

function usage() {
  console.log("usage: tools/release/public-consumer-smoke.mjs --publication-lock FILE --products-json JSON --registry-receipts FILE --github-release-receipt FILE --output FILE");
}

function sharedDeadlineMilliseconds() {
  const timeoutSeconds = requirePositiveInteger(
    process.env.PUBLIC_CONSUMER_SMOKE_TIMEOUT_SECONDS,
    "PUBLIC_CONSUMER_SMOKE_TIMEOUT_SECONDS",
    DEFAULT_OVERALL_TIMEOUT_SECONDS,
  );
  const reserveSeconds = requirePositiveInteger(
    process.env.PUBLIC_CONSUMER_FINALIZATION_RESERVE_SECONDS,
    "PUBLIC_CONSUMER_FINALIZATION_RESERVE_SECONDS",
    DEFAULT_POST_SMOKE_RESERVE_SECONDS,
  );
  let deadline = Date.now() + timeoutSeconds * 1_000;
  const hardRaw = process.env.REGISTRY_JOB_HARD_DEADLINE_EPOCH?.trim();
  if (hardRaw) {
    if (!/^[1-9][0-9]*$/u.test(hardRaw)) throw error("REGISTRY_JOB_HARD_DEADLINE_EPOCH must be a positive Unix timestamp");
    const hard = Number(hardRaw) * 1_000;
    if (!Number.isSafeInteger(hard)) throw error("REGISTRY_JOB_HARD_DEADLINE_EPOCH exceeds the safe timestamp range");
    deadline = Math.min(deadline, hard - reserveSeconds * 1_000);
  }
  if (deadline - Date.now() < 30_000) {
    throw error("less than 30 seconds remain before the shared public-consumer deadline after preserving final promotion reserve");
  }
  return deadline;
}

async function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    usage();
    return;
  }
  const lock = loadPublicationLock(path.resolve(ROOT, args.lock));
  const graph = loadGraph(TOOL);
  const plan = publicConsumerPlan(lock, args.products, graph, { repository: args.repository });
  const registryEvidence = validateRegistryReceiptEvidence(args.registryReceipts, lock, {
    products: plan.products,
    ecosystems: REGISTRY_ECOSYSTEMS,
  });
  const githubFile = boundedRegularJson(args.githubReceipt, MAX_RECEIPT_BYTES, "GitHub release receipt");
  const githubReceipt = validateGithubAttestationReceipt(githubFile.value, lock, { repo: plan.repository });
  const registryFile = boundedRegularJson(args.registryReceipts, MAX_RECEIPT_BYTES, "registry receipt evidence");
  if (registryFile.value.lockDigest !== registryEvidence.lockDigest) throw error("registry receipt changed during public consumer setup");

  const scratch = mkdtempSync(path.join(realpathSync(tmpdir()), "oliphaunt-public-consumer-"));
  const deadlineMilliseconds = sharedDeadlineMilliseconds();
  const controller = new AbortController();
  const tasks = plan.surfaces.map((surface) => runSurfaceWithRetries(
    surface.ecosystem,
    scratch,
    deadlineMilliseconds,
    controller.signal,
    (root) => {
      const options = { lock, plan, surface, root, deadlineMilliseconds, signal: controller.signal };
      if (surface.ecosystem === "cargo") return runCargoSurface(options);
      if (surface.ecosystem === "npm") return runNpmSurface(options);
      if (surface.ecosystem === "maven") return runMavenSurface(options);
      if (surface.ecosystem === "jsr") return runJsrSurface(options);
      throw error(`no public consumer runner for ${surface.ecosystem}`);
    },
  ));
  tasks.push(runSurfaceWithRetries(
    "github",
    scratch,
    deadlineMilliseconds,
    controller.signal,
    (root) => runGithubSurface({ plan, root, deadlineMilliseconds, signal: controller.signal }),
  ));
  let surfaces;
  try {
    const guarded = tasks.map(async (task) => {
      try { return await task; } catch (cause) { controller.abort(); throw cause; }
    });
    const settled = await Promise.allSettled(guarded);
    const failures = settled.filter(({ status }) => status === "rejected").map(({ reason }) => reason);
    if (failures.length > 0) throw failures.length === 1 ? failures[0] : new AggregateError(failures, `${TOOL}: multiple public consumer surfaces failed`);
    surfaces = settled.map(({ value }) => value);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  const evidence = publicConsumerEvidence({
    lock,
    plan,
    registryReceiptSha256: sha256Bytes(registryFile.bytes),
    githubReceiptDigest: githubReceipt.receiptDigest,
    surfaces,
  });
  validatePublicConsumerEvidence(evidence, lock, plan);
  writeImmutablePublicConsumerEvidence(path.resolve(ROOT, args.output), evidence);
  console.log(`Verified ${plan.products.length} products across ${surfaces.length} anonymous public consumer surfaces; immutable evidence: ${path.relative(ROOT, args.output)} (${evidence.evidenceDigest}).`);
}

if (import.meta.main) {
  try {
    await main(Bun.argv.slice(2));
  } catch (cause) {
    console.error(cause instanceof AggregateError
      ? `${cause.message}\n${cause.errors.map((item) => `- ${item instanceof Error ? item.message : String(item)}`).join("\n")}`
      : cause instanceof Error ? cause.message : String(cause));
    process.exit(1);
  }
}
