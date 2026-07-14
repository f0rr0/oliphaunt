import process from "node:process";

import {
  registryRetryDelaySeconds,
  registryStatusRetryable,
} from "./registry-http-retry.mjs";
import {
  CRATES_IO_TRUSTED_PUBLISH_PLANNING_SECONDS_PER_CARRIER,
  CRATES_IO_TRUSTED_TOKEN_DEFAULT_BATCH_SIZE,
  CRATES_IO_TRUSTED_TOKEN_MAX_BATCH_AGE_MS,
} from "./crates-io-trusted-publishing.mjs";

// Primary contract: https://crates.io/docs/rate-limits. The upstream
// implementation independently defines these per-user leaky buckets in
// rust-lang/crates.io/src/rate_limiter.rs. Keep tests and maintainer setup in
// sync if crates.io changes either published limit.
export const CRATES_IO_DEFAULT_NEW_CRATE_BURST = 5;
export const CRATES_IO_NEW_CRATE_REFILL_SECONDS = 10 * 60;
export const CRATES_IO_CAPACITY_VARIABLE = "CRATES_IO_NEW_CRATE_RUN_CAPACITY";
export const CRATES_IO_DEFAULT_VERSION_BURST = 30;
export const CRATES_IO_VERSION_REFILL_SECONDS = 60;
export const CRATES_IO_VERSION_CAPACITY_VARIABLE = "CRATES_IO_VERSION_RUN_CAPACITY";
export const REGISTRY_MUTATION_DEADLINE_VARIABLE = "REGISTRY_MUTATION_DEADLINE_EPOCH";

const DEFAULT_CRATES_IO_API = "https://crates.io/api/v1";
const USER_AGENT = "oliphaunt-bootstrap-capacity/1; https://github.com/f0rr0/oliphaunt";
const REQUEST_ATTEMPTS = 5;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_READ_RETRY_DELAY_SECONDS = 30;
const MINIMUM_MUTATION_WINDOW_SECONDS = 15 * 60;
const MAX_OPERATOR_CAPACITY = 100_000;

function error(message) {
  return new Error(`crates-io-bootstrap-capacity: ${message}`);
}

function strictNonNegativeInteger(raw, context, maximum = Number.MAX_SAFE_INTEGER) {
  const text = typeof raw === "number" ? String(raw) : raw?.trim?.();
  if (typeof text !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(text)) {
    throw error(`${context} must be a base-10 non-negative integer`);
  }
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value > maximum) {
    throw error(`${context} must not exceed ${maximum}`);
  }
  return value;
}

export function parseCratesIoRunCapacity(raw) {
  if (raw === undefined || raw === null || String(raw).trim().length === 0) {
    return null;
  }
  return strictNonNegativeInteger(raw, CRATES_IO_CAPACITY_VARIABLE, MAX_OPERATOR_CAPACITY);
}

export function parseCratesIoVersionRunCapacity(raw) {
  if (raw === undefined || raw === null || String(raw).trim().length === 0) {
    return null;
  }
  return strictNonNegativeInteger(raw, CRATES_IO_VERSION_CAPACITY_VARIABLE, MAX_OPERATOR_CAPACITY);
}

export function parseRegistryMutationDeadline(raw) {
  return strictNonNegativeInteger(
    raw,
    REGISTRY_MUTATION_DEADLINE_VARIABLE,
    Math.floor(Number.MAX_SAFE_INTEGER / 1000),
  );
}

function selectedCargoIdentities(plan) {
  if (!Array.isArray(plan)) {
    throw error("bootstrap publication plan must be a list");
  }
  const identities = plan
    .filter(({ ecosystem }) => ecosystem === "cargo")
    .map(({ name, version }, index) => {
      if (typeof name !== "string" || name.length === 0 || typeof version !== "string" || version.length === 0) {
        throw error(`Cargo plan entry ${index} must have a package name and version`);
      }
      return { name, version };
    });
  const names = identities.map(({ name }) => name);
  const unique = [...new Set(names)].sort((left, right) => left.localeCompare(right));
  if (unique.length !== names.length) {
    throw error("exact publication lock selects duplicate Cargo package names");
  }
  return identities.sort((left, right) => left.name.localeCompare(right.name));
}

function selectedCargoNames(plan) {
  return selectedCargoIdentities(plan).map(({ name }) => name);
}

async function closeResponse(response) {
  try {
    await response.body?.cancel?.();
  } catch {
    // The bounded existence check does not need the response body.
  }
}

async function crateResourceExists(resourceSegments, label, {
  apiBase,
  fetchImpl,
  sleepImpl,
  nowImpl,
  deadlineEpochSeconds,
}) {
  const resource = resourceSegments.map((segment) => encodeURIComponent(segment)).join("/");
  const url = `${apiBase.replace(/\/+$/u, "")}/crates/${resource}`;
  let lastFailure = null;
  for (let attempt = 0; attempt < REQUEST_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        headers: {
          Accept: "application/json",
          "User-Agent": USER_AGENT,
        },
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (response.status === 200) {
        await closeResponse(response);
        return true;
      }
      if (response.status === 404) {
        await closeResponse(response);
        return false;
      }
      const retryable = registryStatusRetryable(response.status);
      const status = response.status;
      const headers = response.headers;
      await closeResponse(response);
      lastFailure = `HTTP ${status}`;
      if (!retryable || attempt + 1 >= REQUEST_ATTEMPTS) {
        break;
      }
      const delaySeconds = registryRetryDelaySeconds({ headers, attempt, now: nowImpl() * 1000 });
      if (delaySeconds > MAX_READ_RETRY_DELAY_SECONDS) {
        throw error(
          `read-only existence check for ${label} was rate limited until more than ${MAX_READ_RETRY_DELAY_SECONDS}s from now; retry the release later`,
        );
      }
      if (nowImpl() + Math.ceil(delaySeconds) >= deadlineEpochSeconds) {
        throw error(`read-only existence check for ${label} cannot retry before the registry mutation deadline`);
      }
      await sleepImpl(Math.ceil(delaySeconds * 1000));
    } catch (cause) {
      if (cause instanceof Error && cause.message.startsWith("crates-io-bootstrap-capacity:")) {
        throw cause;
      }
      lastFailure = cause instanceof Error ? cause.message : String(cause);
      if (attempt + 1 >= REQUEST_ATTEMPTS) {
        break;
      }
      const delaySeconds = registryRetryDelaySeconds({ attempt, now: nowImpl() * 1000 });
      if (nowImpl() + Math.ceil(delaySeconds) >= deadlineEpochSeconds) {
        throw error(`read-only existence check for ${label} cannot retry before the registry mutation deadline`);
      }
      await sleepImpl(Math.ceil(delaySeconds * 1000));
    }
  }
  throw error(`cannot determine whether Cargo identity ${label} exists on crates.io: ${lastFailure ?? "unknown response"}`);
}

export async function inspectCratesIoBootstrapNames({
  plan,
  apiBase = process.env.CRATES_IO_API ?? DEFAULT_CRATES_IO_API,
  fetchImpl = fetch,
  sleepImpl = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  nowImpl = () => Math.floor(Date.now() / 1000),
  deadlineEpochSeconds,
  concurrency = 8,
}) {
  if (!Number.isSafeInteger(deadlineEpochSeconds) || deadlineEpochSeconds <= nowImpl()) {
    throw error(`${REGISTRY_MUTATION_DEADLINE_VARIABLE} must be a future Unix timestamp`);
  }
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 32) {
    throw error("existence-check concurrency must be an integer from 1 through 32");
  }
  const names = selectedCargoNames(plan);
  const observed = new Array(names.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, names.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= names.length) return;
      observed[index] = await crateResourceExists([names[index]], names[index], {
        apiBase,
        fetchImpl,
        sleepImpl,
        nowImpl,
        deadlineEpochSeconds,
      });
    }
  });
  await Promise.all(workers);
  return {
    selectedNames: names,
    existingNames: names.filter((_, index) => observed[index]),
    missingNames: names.filter((_, index) => !observed[index]),
  };
}

export async function inspectCratesIoVersionState({
  plan,
  apiBase = process.env.CRATES_IO_API ?? DEFAULT_CRATES_IO_API,
  fetchImpl = fetch,
  sleepImpl = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  nowImpl = () => Math.floor(Date.now() / 1000),
  deadlineEpochSeconds,
  concurrency = 8,
}) {
  if (!Number.isSafeInteger(deadlineEpochSeconds) || deadlineEpochSeconds <= nowImpl()) {
    throw error(`${REGISTRY_MUTATION_DEADLINE_VARIABLE} must be a future Unix timestamp`);
  }
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 32) {
    throw error("existence-check concurrency must be an integer from 1 through 32");
  }
  const identities = selectedCargoIdentities(plan);
  const observed = new Array(identities.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, identities.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= identities.length) return;
      const identity = identities[index];
      const label = `${identity.name}@${identity.version}`;
      const versionExists = await crateResourceExists([identity.name, identity.version], label, {
        apiBase,
        fetchImpl,
        sleepImpl,
        nowImpl,
        deadlineEpochSeconds,
      });
      if (versionExists) {
        observed[index] = "published";
        continue;
      }
      const nameExists = await crateResourceExists([identity.name], identity.name, {
        apiBase,
        fetchImpl,
        sleepImpl,
        nowImpl,
        deadlineEpochSeconds,
      });
      observed[index] = nameExists ? "pending-version" : "missing-name";
    }
  });
  await Promise.all(workers);
  const withState = identities.map((identity, index) => ({ ...identity, state: observed[index] }));
  return {
    selectedIdentities: identities,
    publishedIdentities: withState.filter(({ state }) => state === "published").map(({ name, version }) => ({ name, version })),
    pendingVersions: withState.filter(({ state }) => state === "pending-version").map(({ name, version }) => ({ name, version })),
    missingNames: withState.filter(({ state }) => state === "missing-name").map(({ name }) => name),
  };
}

export function assessCratesIoBootstrapCapacity({
  inventory,
  configuredCapacity,
  deadlineEpochSeconds,
  nowEpochSeconds = Math.floor(Date.now() / 1000),
}) {
  if (
    inventory === null
    || typeof inventory !== "object"
    || !Array.isArray(inventory.selectedNames)
    || !Array.isArray(inventory.existingNames)
    || !Array.isArray(inventory.missingNames)
  ) {
    throw error("inventory must contain selectedNames, existingNames, and missingNames lists");
  }
  const operatorCapacity = parseCratesIoRunCapacity(configuredCapacity);
  const effectiveCapacity = operatorCapacity ?? CRATES_IO_DEFAULT_NEW_CRATE_BURST;
  const missingCount = inventory.missingNames.length;
  const defaultRateLimitedPublishes = Math.max(0, missingCount - CRATES_IO_DEFAULT_NEW_CRATE_BURST);
  const defaultMinimumSeconds = defaultRateLimitedPublishes * CRATES_IO_NEW_CRATE_REFILL_SECONDS;
  const remainingSeconds = deadlineEpochSeconds - nowEpochSeconds;
  const capacitySatisfied = missingCount <= effectiveCapacity;
  const timeSatisfied = remainingSeconds >= MINIMUM_MUTATION_WINDOW_SECONDS;
  return {
    selectedCount: inventory.selectedNames.length,
    existingCount: inventory.existingNames.length,
    missingCount,
    missingNames: inventory.missingNames,
    operatorCapacity,
    effectiveCapacity,
    capacitySource: operatorCapacity === null ? "official-default" : "protected-environment-assertion",
    defaultMinimumSeconds,
    remainingSeconds,
    minimumMutationWindowSeconds: MINIMUM_MUTATION_WINDOW_SECONDS,
    capacitySatisfied,
    timeSatisfied,
    allowed: capacitySatisfied && timeSatisfied,
  };
}

export function assessCratesIoVersionCapacity({
  inventory,
  configuredCapacity,
  deadlineEpochSeconds,
  nowEpochSeconds = Math.floor(Date.now() / 1000),
}) {
  if (
    inventory === null
    || typeof inventory !== "object"
    || !Array.isArray(inventory.selectedIdentities)
    || !Array.isArray(inventory.publishedIdentities)
    || !Array.isArray(inventory.pendingVersions)
    || !Array.isArray(inventory.missingNames)
  ) {
    throw error("version inventory must contain selected, published, pending, and missing-name lists");
  }
  const operatorCapacity = parseCratesIoVersionRunCapacity(configuredCapacity);
  const effectiveCapacity = operatorCapacity ?? CRATES_IO_DEFAULT_VERSION_BURST;
  const pendingCount = inventory.pendingVersions.length;
  const defaultRateLimitedPublishes = Math.max(0, pendingCount - CRATES_IO_DEFAULT_VERSION_BURST);
  const defaultMinimumSeconds = defaultRateLimitedPublishes * CRATES_IO_VERSION_REFILL_SECONDS;
  const remainingSeconds = deadlineEpochSeconds - nowEpochSeconds;
  const plannedPublicationSeconds = pendingCount * CRATES_IO_TRUSTED_PUBLISH_PLANNING_SECONDS_PER_CARRIER;
  const requiredWindowSeconds = Math.max(MINIMUM_MUTATION_WINDOW_SECONDS, plannedPublicationSeconds);
  const namesSatisfied = inventory.missingNames.length === 0;
  const capacitySatisfied = pendingCount <= effectiveCapacity;
  const timeSatisfied = remainingSeconds >= requiredWindowSeconds;
  return {
    selectedCount: inventory.selectedIdentities.length,
    publishedCount: inventory.publishedIdentities.length,
    pendingCount,
    pendingVersions: inventory.pendingVersions,
    missingNames: inventory.missingNames,
    operatorCapacity,
    effectiveCapacity,
    capacitySource: operatorCapacity === null ? "official-default" : "protected-environment-assertion",
    defaultMinimumSeconds,
    remainingSeconds,
    minimumMutationWindowSeconds: requiredWindowSeconds,
    plannedPublicationSeconds,
    planningSecondsPerCarrier: CRATES_IO_TRUSTED_PUBLISH_PLANNING_SECONDS_PER_CARRIER,
    trustedTokenBatchSize: CRATES_IO_TRUSTED_TOKEN_DEFAULT_BATCH_SIZE,
    trustedTokenMaxBatchAgeMs: CRATES_IO_TRUSTED_TOKEN_MAX_BATCH_AGE_MS,
    namesSatisfied,
    capacitySatisfied,
    timeSatisfied,
    allowed: namesSatisfied && capacitySatisfied && timeSatisfied,
  };
}

function durationText(seconds) {
  const minutes = Math.ceil(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return hours === 0 ? `${minutes}m` : `${hours}h ${remainder}m`;
}

export function cratesIoCapacitySummary(assessment) {
  const capacity = assessment.operatorCapacity === null
    ? `${assessment.effectiveCapacity} (official default burst)`
    : `${assessment.effectiveCapacity} (operator assertion from the protected release-bootstrap environment)`;
  return [
    "### crates.io new-identity capacity gate",
    "",
    `- Exact-lock Cargo names selected: ${assessment.selectedCount}`,
    `- Names already present on crates.io: ${assessment.existingCount}`,
    `- Brand-new names still missing: ${assessment.missingCount}`,
    `- Immediately available run capacity: ${capacity}`,
    `- Official-default minimum rate-limit wait: ${durationText(assessment.defaultMinimumSeconds)}`,
    `- Remaining bounded mutation window: ${durationText(Math.max(0, assessment.remainingSeconds))}`,
    `- Decision: ${assessment.allowed ? "PASS" : "FAIL"}`,
    "",
  ].join("\n");
}

export function cratesIoVersionCapacitySummary(assessment) {
  const capacity = assessment.operatorCapacity === null
    ? `${assessment.effectiveCapacity} (official default burst)`
    : `${assessment.effectiveCapacity} (operator assertion from the protected release-publish environment)`;
  return [
    "### crates.io version-publication capacity gate",
    "",
    `- Exact-lock Cargo versions selected: ${assessment.selectedCount}`,
    `- Versions already present on crates.io: ${assessment.publishedCount}`,
    `- Existing names with versions still pending: ${assessment.pendingCount}`,
    `- Brand-new names incorrectly reaching normal publish: ${assessment.missingNames.length}`,
    `- Immediately available version capacity: ${capacity}`,
    `- Official-default minimum rate-limit wait: ${durationText(assessment.defaultMinimumSeconds)}`,
    `- Trusted-token batches: at most ${assessment.trustedTokenBatchSize} carriers or ${durationText(assessment.trustedTokenMaxBatchAgeMs / 1000)} old`,
    `- Reserved executor time: ${durationText(assessment.plannedPublicationSeconds)} (${assessment.planningSecondsPerCarrier}s per pending carrier)`,
    `- Remaining bounded mutation window: ${durationText(Math.max(0, assessment.remainingSeconds))}`,
    `- Decision: ${assessment.allowed ? "PASS" : "FAIL"}`,
    "",
  ].join("\n");
}

export function assertCratesIoBootstrapCapacity(assessment) {
  if (!assessment.timeSatisfied) {
    throw error(
      `only ${durationText(Math.max(0, assessment.remainingSeconds))} remains before the registry mutation deadline; `
        + `at least ${durationText(assessment.minimumMutationWindowSeconds)} is required before starting an irreversible bootstrap`,
    );
  }
  if (!assessment.capacitySatisfied) {
    const names = assessment.missingNames.slice(0, 8).join(", ");
    const omitted = Math.max(0, assessment.missingNames.length - 8);
    throw error(
      `${assessment.missingCount} brand-new Cargo names are missing, but immediate run capacity is only ${assessment.effectiveCapacity}; `
        + `the crates.io default would require at least ${durationText(assessment.defaultMinimumSeconds)}, beyond a single release job. `
        + `Obtain a crates.io exception, then set ${CRATES_IO_CAPACITY_VARIABLE} in the protected release-bootstrap environment `
        + `to the support-confirmed currently available count (at least ${assessment.missingCount}). `
        + `Missing names include ${names}${omitted > 0 ? `, and ${omitted} more` : ""}`,
    );
  }
}

export function assertCratesIoVersionCapacity(assessment) {
  if (!assessment.timeSatisfied) {
    throw error(
      `only ${durationText(Math.max(0, assessment.remainingSeconds))} remains before the registry mutation deadline; `
        + `at least ${durationText(assessment.minimumMutationWindowSeconds)} is required before normal publication`,
    );
  }
  if (!assessment.namesSatisfied) {
    const names = assessment.missingNames.slice(0, 8).join(", ");
    const omitted = Math.max(0, assessment.missingNames.length - 8);
    throw error(
      `normal trusted publication cannot create ${assessment.missingNames.length} missing Cargo name(s): ${names}`
        + `${omitted > 0 ? `, and ${omitted} more` : ""}; run the protected identity bootstrap first`,
    );
  }
  if (!assessment.capacitySatisfied) {
    if (assessment.operatorCapacity === null) {
      throw error(
        `${assessment.pendingCount} Cargo versions are pending, above the official default burst of `
          + `${assessment.effectiveCapacity}; the default bucket would require at least `
          + `${durationText(assessment.defaultMinimumSeconds)}. Obtain sufficient crates.io capacity, then set `
          + `${CRATES_IO_VERSION_CAPACITY_VARIABLE} in the protected release-publish environment to the `
          + `support-confirmed currently available count (at least ${assessment.pendingCount})`,
      );
    }
    throw error(
      `${assessment.pendingCount} Cargo versions are pending, but ${CRATES_IO_VERSION_CAPACITY_VARIABLE} asserts only `
        + `${assessment.operatorCapacity}; the default bucket would require at least ${durationText(assessment.defaultMinimumSeconds)}. `
        + `Obtain sufficient crates.io capacity before rerunning publish`,
    );
  }
}
