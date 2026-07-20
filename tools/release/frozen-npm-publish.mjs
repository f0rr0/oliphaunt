import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import process from "node:process";

import {
  registryRetryDelaySeconds,
  registryStatusRetryable,
} from "./registry-http-retry.mjs";
import { requirePreMutationRegistryWindow } from "./registry-publication-deferral.mjs";

const DEFAULT_NPM_REGISTRY = "https://registry.npmjs.org";
const USER_AGENT = "oliphaunt-frozen-npm-publisher/1; https://github.com/f0rr0/oliphaunt";
const REQUEST_ATTEMPTS = 5;
const REQUEST_TIMEOUT_MS = 30_000;
const PUBLISH_TIMEOUT_MS = 2 * 60_000;
const MINIMUM_PUBLISH_ATTEMPT_MS = 30_000;
const DEADLINE_RESERVE_MS = 5_000;
const MAX_METADATA_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_READ_RETRY_DELAY_SECONDS = 30;
const VISIBILITY_ATTEMPTS = 12;
const VISIBILITY_DELAY_MS = 10_000;

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function error(message) {
  return new Error(`frozen-npm-publish: ${message}`);
}

function requiredText(value, context) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw error(`${context} is required`);
  }
  return value.trim();
}

function deadlineMilliseconds(deadlineEpochSeconds) {
  if (!Number.isSafeInteger(deadlineEpochSeconds) || deadlineEpochSeconds < 1) {
    throw error("registry mutation deadline must be a positive Unix timestamp");
  }
  return deadlineEpochSeconds * 1000;
}

function remainingBeforeReserve({ deadlineEpochSeconds, nowImpl, context }) {
  const remaining = deadlineMilliseconds(deadlineEpochSeconds) - nowImpl() - DEADLINE_RESERVE_MS;
  if (remaining <= 0) {
    throw error(`${context} refused because the shared registry mutation deadline has been reached`);
  }
  return remaining;
}

function requestTimeout({ deadlineEpochSeconds, nowImpl, context }) {
  return Math.max(1, Math.min(
    REQUEST_TIMEOUT_MS,
    remainingBeforeReserve({ deadlineEpochSeconds, nowImpl, context }),
  ));
}

async function closeResponse(response) {
  try {
    await response.body?.cancel?.();
  } catch {
    // The exact-version existence response has no useful body on 404.
  }
}

async function boundedJson(response, context) {
  const declared = response.headers?.get?.("content-length");
  if (declared !== null && declared !== undefined) {
    const length = Number(declared);
    if (!Number.isSafeInteger(length) || length < 0) {
      await closeResponse(response);
      throw error(`${context} returned an invalid Content-Length`);
    }
    if (length > MAX_METADATA_RESPONSE_BYTES) {
      await closeResponse(response);
      throw error(`${context} response exceeds ${MAX_METADATA_RESPONSE_BYTES} bytes`);
    }
  }
  let bytes;
  const reader = response.body?.getReader?.();
  if (reader === undefined) {
    bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > MAX_METADATA_RESPONSE_BYTES) {
      throw error(`${context} response exceeds ${MAX_METADATA_RESPONSE_BYTES} bytes`);
    }
  } else {
    const chunks = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_METADATA_RESPONSE_BYTES) {
          await reader.cancel().catch(() => {});
          throw error(`${context} response exceeds ${MAX_METADATA_RESPONSE_BYTES} bytes`);
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
  } catch (cause) {
    throw error(`${context} returned invalid JSON: ${cause.message}`);
  }
}

async function boundedSleep(milliseconds, {
  deadlineEpochSeconds,
  nowImpl,
  sleepImpl,
  context,
}) {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) {
    throw error(`${context} requested an invalid retry delay`);
  }
  const remaining = remainingBeforeReserve({ deadlineEpochSeconds, nowImpl, context });
  if (milliseconds >= remaining) {
    throw error(`${context} cannot wait ${Math.ceil(milliseconds / 1000)}s before the shared registry mutation deadline`);
  }
  await sleepImpl(milliseconds);
}

function npmVersionUrl(registry, packageName, version) {
  return `${registry.replace(/\/+$/u, "")}/${encodeURIComponent(packageName)}/${encodeURIComponent(version)}`;
}

function npmPackageUrl(registry, packageName) {
  return `${registry.replace(/\/+$/u, "")}/${encodeURIComponent(packageName)}`;
}

function canonicalNpmRegistry(value) {
  const raw = requiredText(value, "npm registry");
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw error(`npm registry must be ${DEFAULT_NPM_REGISTRY}`);
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

async function inspectNpmJsonResource({
  url,
  context,
  consumeJson,
  deadlineEpochSeconds,
  fetchImpl,
  sleepImpl,
  nowImpl,
}) {
  let lastFailure = null;
  for (let attempt = 0; attempt < REQUEST_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timeoutMs = requestTimeout({ deadlineEpochSeconds, nowImpl, context });
    const timeout = setTimeout(
      () => controller.abort(new Error(`${context} timed out`)),
      timeoutMs,
    );
    try {
      const response = await fetchImpl(url, {
        headers: {
          Accept: "application/json",
          "User-Agent": USER_AGENT,
        },
        redirect: "error",
        signal: controller.signal,
      });
      if (response.status === 404) {
        await closeResponse(response);
        return { found: false, metadata: null };
      }
      if (response.status !== 200) {
        const status = response.status;
        const headers = response.headers;
        await closeResponse(response);
        lastFailure = `HTTP ${status}`;
        if (!registryStatusRetryable(status) || attempt + 1 >= REQUEST_ATTEMPTS) break;
        const delaySeconds = registryRetryDelaySeconds({ headers, attempt, now: nowImpl() });
        if (delaySeconds > MAX_READ_RETRY_DELAY_SECONDS) {
          throw error(`${context} was rate limited for too long; retry the release later`);
        }
        await boundedSleep(Math.ceil(delaySeconds * 1000), {
          deadlineEpochSeconds,
          nowImpl,
          sleepImpl,
          context,
        });
        continue;
      }
      if (!consumeJson) {
        await closeResponse(response);
        return { found: true, metadata: null };
      }
      return {
        found: true,
        metadata: await boundedJson(response, `${context} metadata`),
      };
    } catch (cause) {
      if (cause instanceof Error && cause.message.startsWith("frozen-npm-publish:")) throw cause;
      lastFailure = cause instanceof Error ? cause.message : String(cause);
      if (attempt + 1 >= REQUEST_ATTEMPTS) break;
      const delaySeconds = registryRetryDelaySeconds({ attempt, now: nowImpl() });
      await boundedSleep(Math.ceil(delaySeconds * 1000), {
        deadlineEpochSeconds,
        nowImpl,
        sleepImpl,
        context,
      });
    } finally {
      clearTimeout(timeout);
    }
  }
  throw error(`cannot classify ${context}: ${lastFailure ?? "unknown registry response"}`);
}

export async function inspectNpmPackageName({
  packageName,
  registry = process.env.NPM_REGISTRY ?? DEFAULT_NPM_REGISTRY,
  deadlineEpochSeconds,
  fetchImpl = fetch,
  sleepImpl = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  nowImpl = () => Date.now(),
}) {
  const name = requiredText(packageName, "npm package name");
  const canonicalRegistry = canonicalNpmRegistry(registry);
  const url = npmPackageUrl(canonicalRegistry, name);
  const state = await inspectNpmJsonResource({
    url,
    context: `npm package-name check for ${name}`,
    consumeJson: false,
    deadlineEpochSeconds,
    fetchImpl,
    sleepImpl,
    nowImpl,
  });
  return { packageName: name, exists: state.found, url };
}

export function frozenNpmIntegrity(tarball) {
  const file = requiredText(tarball, "frozen npm tarball");
  let stat;
  try {
    stat = statSync(file);
  } catch {
    throw error(`frozen npm tarball is unavailable: ${file}`);
  }
  if (!stat.isFile()) {
    throw error(`frozen npm tarball is not a file: ${file}`);
  }
  const digest = createHash("sha512").update(readFileSync(file)).digest("base64");
  return `sha512-${digest}`;
}

export async function inspectNpmExactVersion({
  packageName,
  version,
  expectedIntegrity = undefined,
  registry = process.env.NPM_REGISTRY ?? DEFAULT_NPM_REGISTRY,
  deadlineEpochSeconds,
  fetchImpl = fetch,
  sleepImpl = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  nowImpl = () => Date.now(),
}) {
  const name = requiredText(packageName, "npm package name");
  const exactVersion = requiredText(version, "npm package version");
  const canonicalRegistry = canonicalNpmRegistry(registry);
  const url = npmVersionUrl(canonicalRegistry, name, exactVersion);
  const exact = await inspectNpmJsonResource({
    url,
    context: `npm exact-version check for ${name}@${exactVersion}`,
    consumeJson: true,
    deadlineEpochSeconds,
    fetchImpl,
    sleepImpl,
    nowImpl,
  });
  if (!exact.found) {
    // A version-level 404 is ambiguous: bootstrap is allowed to create only a
    // completely absent package name, never a later version of an existing
    // package. Resolve the package-name state with a normal JSON registry GET.
    const packageState = await inspectNpmPackageName({
      packageName: name,
      registry: canonicalRegistry,
      deadlineEpochSeconds,
      fetchImpl,
      sleepImpl,
      nowImpl,
    });
    return {
      packageName: name,
      version: exactVersion,
      published: false,
      nameExists: packageState.exists,
      state: packageState.exists ? "pending-version" : "missing-name",
      integrity: null,
      url,
      packageUrl: packageState.url,
    };
  }
  const integrity = exact.metadata?.dist?.integrity;
  if (typeof integrity !== "string" || integrity.trim().length === 0) {
    throw error(`npm metadata for ${name}@${exactVersion} lacks dist.integrity`);
  }
  const tokens = integrity.trim().split(/\s+/u);
  if (expectedIntegrity !== undefined && !tokens.includes(expectedIntegrity)) {
    throw error(
      `immutable npm version ${name}@${exactVersion} conflicts with the frozen tarball: expected ${expectedIntegrity}, registry=${integrity}`,
    );
  }
  return {
    packageName: name,
    version: exactVersion,
    published: true,
    nameExists: true,
    state: "published",
    integrity,
    url,
    packageUrl: npmPackageUrl(canonicalRegistry, name),
  };
}

function selectedNpmIdentities(plan) {
  if (!Array.isArray(plan)) throw error("bootstrap publication plan must be a list");
  const identities = plan
    .filter(({ ecosystem }) => ecosystem === "npm")
    .map(({ name, version }, index) => ({
      name: requiredText(name, `npm plan entry ${index} name`),
      version: requiredText(version, `npm plan entry ${index} version`),
    }))
    .sort((left, right) => compareText(`${left.name}@${left.version}`, `${right.name}@${right.version}`));
  const unique = new Set(identities.map(({ name }) => name));
  if (unique.size !== identities.length) {
    throw error("exact publication lock selects duplicate npm package names");
  }
  return identities;
}

export async function inspectNpmVersionState({
  plan,
  registry = process.env.NPM_REGISTRY ?? DEFAULT_NPM_REGISTRY,
  deadlineEpochSeconds,
  fetchImpl = fetch,
  sleepImpl = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  nowImpl = () => Date.now(),
  concurrency = 8,
}) {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 32) {
    throw error("npm existence-check concurrency must be an integer from 1 through 32");
  }
  const identities = selectedNpmIdentities(plan);
  const observed = new Array(identities.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, identities.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= identities.length) return;
      const identity = identities[index];
      observed[index] = await inspectNpmExactVersion({
        packageName: identity.name,
        version: identity.version,
        registry,
        deadlineEpochSeconds,
        fetchImpl,
        sleepImpl,
        nowImpl,
      });
    }
  });
  await Promise.all(workers);
  return {
    selectedIdentities: identities,
    publishedIdentities: identities.filter((_, index) => observed[index].published),
    pendingVersions: identities.filter((_, index) => observed[index].state === "pending-version"),
    missingNames: identities.filter((_, index) => observed[index].state === "missing-name").map(({ name }) => name),
  };
}

export async function waitForNpmExactVersion({
  packageName,
  version,
  expectedIntegrity,
  registry = process.env.NPM_REGISTRY ?? DEFAULT_NPM_REGISTRY,
  deadlineEpochSeconds,
  fetchImpl = fetch,
  sleepImpl = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  nowImpl = () => Date.now(),
  attempts = VISIBILITY_ATTEMPTS,
  delayMilliseconds = VISIBILITY_DELAY_MS,
}) {
  if (!Number.isSafeInteger(attempts) || attempts < 1) throw error("npm visibility attempts must be positive");
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const state = await inspectNpmExactVersion({
      packageName,
      version,
      expectedIntegrity,
      registry,
      deadlineEpochSeconds,
      fetchImpl,
      sleepImpl,
      nowImpl,
    });
    if (state.published) return state;
    if (attempt + 1 < attempts) {
      await boundedSleep(delayMilliseconds, {
        deadlineEpochSeconds,
        nowImpl,
        sleepImpl,
        context: `npm visibility wait for ${packageName}@${version}`,
      });
    }
  }
  throw error(`${packageName}@${version} did not become visible with frozen SRI before the bounded visibility attempts ended`);
}

function publishTimedOut(result) {
  return result?.error?.code === "ETIMEDOUT";
}

export async function publishFrozenNpmPackage({
  packageName,
  version,
  tarball,
  cwd = process.cwd(),
  registry = process.env.NPM_REGISTRY ?? DEFAULT_NPM_REGISTRY,
  deadlineEpochSeconds,
  fetchImpl = fetch,
  spawnImpl = spawnSync,
  sleepImpl = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  nowImpl = () => Date.now(),
  visibilityAttempts = VISIBILITY_ATTEMPTS,
  visibilityDelayMilliseconds = VISIBILITY_DELAY_MS,
  identityCreationOnly = false,
}) {
  const name = requiredText(packageName, "npm package name");
  const exactVersion = requiredText(version, "npm package version");
  const file = requiredText(tarball, "frozen npm tarball");
  const canonicalRegistry = canonicalNpmRegistry(registry);
  const expectedIntegrity = frozenNpmIntegrity(file);
  const existing = await inspectNpmExactVersion({
    packageName: name,
    version: exactVersion,
    expectedIntegrity,
    registry: canonicalRegistry,
    deadlineEpochSeconds,
    fetchImpl,
    sleepImpl,
    nowImpl,
  });
  if (existing.published) {
    return {
      state: existing,
      skipped: true,
      reconciledMutationFailure: false,
      reconciledTimeout: false,
    };
  }
  if (identityCreationOnly && existing.nameExists) {
    throw error(
      `identity bootstrap cannot publish ${name}@${exactVersion}: package name ${name} already exists while the locked exact version is absent`,
    );
  }

  const available = requirePreMutationRegistryWindow({
    deadlineEpochSeconds,
    nowEpochMilliseconds: nowImpl(),
    minimumMilliseconds: MINIMUM_PUBLISH_ATTEMPT_MS,
    reserveMilliseconds: DEADLINE_RESERVE_MS,
    context: `npm publish for ${name}@${exactVersion}`,
  });
  const timeout = Math.min(PUBLISH_TIMEOUT_MS, available);
  const result = spawnImpl(
    "npm",
    ["publish", file, "--access", "public", "--provenance", "--registry", canonicalRegistry],
    { cwd, env: process.env, stdio: "inherit", timeout },
  );

  if (result?.error !== undefined || result?.status !== 0) {
    const timedOut = publishTimedOut(result);
    const detail = result?.error?.message ?? `npm exited with status ${String(result?.status)}`;
    try {
      const state = await waitForNpmExactVersion({
        packageName: name,
        version: exactVersion,
        expectedIntegrity,
        registry: canonicalRegistry,
        deadlineEpochSeconds,
        fetchImpl,
        sleepImpl,
        nowImpl,
        attempts: visibilityAttempts,
        delayMilliseconds: visibilityDelayMilliseconds,
      });
      return {
        state,
        skipped: false,
        reconciledMutationFailure: true,
        reconciledTimeout: timedOut,
      };
    } catch (cause) {
      throw error(
        `npm publish for ${name}@${exactVersion} ${timedOut ? "timed out" : `failed (${detail})`} `
          + `and immutable registry state did not reconcile: ${cause.message}`,
      );
    }
  }

  const state = await waitForNpmExactVersion({
    packageName: name,
    version: exactVersion,
    expectedIntegrity,
    registry: canonicalRegistry,
    deadlineEpochSeconds,
    fetchImpl,
    sleepImpl,
    nowImpl,
    attempts: visibilityAttempts,
    delayMilliseconds: visibilityDelayMilliseconds,
  });
  return {
    state,
    skipped: false,
    reconciledMutationFailure: false,
    reconciledTimeout: false,
  };
}
