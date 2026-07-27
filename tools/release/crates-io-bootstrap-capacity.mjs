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
export {
  RegistryPublicationDeferredError,
  isRegistryPublicationDeferredError,
} from "./registry-publication-deferral.mjs";

// Primary contract: https://crates.io/docs/rate-limits. The upstream
// implementation independently defines these per-user leaky buckets in
// rust-lang/crates.io/src/rate_limiter.rs. Keep tests and maintainer setup in
// sync if crates.io changes either published limit.
export const CRATES_IO_DEFAULT_NEW_CRATE_BURST = 5;
export const CRATES_IO_NEW_CRATE_REFILL_SECONDS = 10 * 60;
export const CRATES_IO_DEFAULT_VERSION_BURST = 30;
export const CRATES_IO_VERSION_REFILL_SECONDS = 60;
export const REGISTRY_MUTATION_DEADLINE_VARIABLE = "REGISTRY_MUTATION_DEADLINE_EPOCH";
export const REGISTRY_BOOTSTRAP_CARGO_SECONDS_VARIABLE = "REGISTRY_BOOTSTRAP_CARGO_SECONDS_PER_CARRIER";
export const REGISTRY_BOOTSTRAP_NPM_SECONDS_VARIABLE = "REGISTRY_BOOTSTRAP_NPM_SECONDS_PER_CARRIER";
export const REGISTRY_BOOTSTRAP_RECONCILIATION_SECONDS_VARIABLE = "REGISTRY_BOOTSTRAP_RECONCILIATION_SECONDS_PER_CARRIER";
export const REGISTRY_BOOTSTRAP_RESERVE_SECONDS_VARIABLE = "REGISTRY_BOOTSTRAP_RESERVE_SECONDS";
export const REGISTRY_BOOTSTRAP_DEFAULT_CARGO_SECONDS_PER_CARRIER = 30;
export const REGISTRY_BOOTSTRAP_DEFAULT_NPM_SECONDS_PER_CARRIER = 30;
export const REGISTRY_BOOTSTRAP_INTEGRITY_CONCURRENCY = 8;
// registry-integrity bounds one request at 45s. At the fixed concurrency of
// eight, six seconds per public carrier covers a complete worst-case request
// wave; the separate reserve covers bounded retry and local ledger overhead.
export const REGISTRY_BOOTSTRAP_DEFAULT_RECONCILIATION_SECONDS_PER_CARRIER = 6;
// These timing values are calibrated admission estimates, not upper bounds on third-party
// registry latency. A separate absolute deadline stops mutation; immutable
// public versions and checkpoint receipts make interrupted runs resumable.
export const REGISTRY_BOOTSTRAP_DEFAULT_RESERVE_SECONDS = 10 * 60;
// npm trusted publication includes OIDC exchange, the immutable upload, and
// exact public-integrity visibility. Keep the five-minute carrier allowance
// aligned with the normal publisher's bounded mutation/reconciliation path.
export const NORMAL_REGISTRY_NPM_SECONDS_PER_CARRIER = 5 * 60;
// Maven Central can spend one 15-minute visibility phase reaching VALIDATED
// and a second reaching PUBLISHED. Reserve both phases plus five minutes for
// lookup, bundle upload, and the explicit publish request before admitting the
// atomic Maven lane.
export const NORMAL_REGISTRY_MAVEN_OPERATION_SECONDS = 35 * 60;
export const NORMAL_REGISTRY_JSR_SECONDS_PER_CARRIER = 5 * 60;
export const NORMAL_REGISTRY_RECONCILIATION_SECONDS_PER_CARRIER = 6;
export const NORMAL_REGISTRY_EXECUTOR_RESERVE_SECONDS = 10 * 60;

const DEFAULT_CRATES_IO_API = "https://crates.io/api/v1";
const USER_AGENT = "oliphaunt-bootstrap-capacity/1; https://github.com/f0rr0/oliphaunt";
const REQUEST_ATTEMPTS = 5;
const REQUEST_TIMEOUT_MS = 30_000;
const DEADLINE_RESERVE_MS = 5_000;
const MAX_READ_RETRY_DELAY_SECONDS = 30;
const MINIMUM_MUTATION_WINDOW_SECONDS = 15 * 60;
const MAX_PLANNING_SECONDS_PER_CARRIER = 60 * 60;
const MAX_RESERVE_SECONDS = 6 * 60 * 60;

function error(message) {
  return new Error(`crates-io-bootstrap-capacity: ${message}`);
}

function compareText(left, right) {
  const a = String(left);
  const b = String(right);
  return a < b ? -1 : a > b ? 1 : 0;
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

export function parseRegistryMutationDeadline(raw) {
  return strictNonNegativeInteger(
    raw,
    REGISTRY_MUTATION_DEADLINE_VARIABLE,
    Math.floor(Number.MAX_SAFE_INTEGER / 1000),
  );
}

function planningSeconds(raw, variable, fallback, { minimum, maximum }) {
  if (raw === undefined || raw === null || String(raw).trim().length === 0) {
    return fallback;
  }
  const value = strictNonNegativeInteger(raw, variable, maximum);
  if (value < minimum) {
    throw error(`${variable} must be at least ${minimum}`);
  }
  return value;
}

export function parseRegistryBootstrapCargoSeconds(raw) {
  return planningSeconds(
    raw,
    REGISTRY_BOOTSTRAP_CARGO_SECONDS_VARIABLE,
    REGISTRY_BOOTSTRAP_DEFAULT_CARGO_SECONDS_PER_CARRIER,
    {
      minimum: REGISTRY_BOOTSTRAP_DEFAULT_CARGO_SECONDS_PER_CARRIER,
      maximum: MAX_PLANNING_SECONDS_PER_CARRIER,
    },
  );
}

export function parseRegistryBootstrapNpmSeconds(raw) {
  return planningSeconds(
    raw,
    REGISTRY_BOOTSTRAP_NPM_SECONDS_VARIABLE,
    REGISTRY_BOOTSTRAP_DEFAULT_NPM_SECONDS_PER_CARRIER,
    {
      minimum: REGISTRY_BOOTSTRAP_DEFAULT_NPM_SECONDS_PER_CARRIER,
      maximum: MAX_PLANNING_SECONDS_PER_CARRIER,
    },
  );
}

export function parseRegistryBootstrapReconciliationSeconds(raw) {
  return planningSeconds(
    raw,
    REGISTRY_BOOTSTRAP_RECONCILIATION_SECONDS_VARIABLE,
    REGISTRY_BOOTSTRAP_DEFAULT_RECONCILIATION_SECONDS_PER_CARRIER,
    {
      minimum: REGISTRY_BOOTSTRAP_DEFAULT_RECONCILIATION_SECONDS_PER_CARRIER,
      maximum: MAX_PLANNING_SECONDS_PER_CARRIER,
    },
  );
}

export function parseRegistryBootstrapReserveSeconds(raw) {
  return planningSeconds(
    raw,
    REGISTRY_BOOTSTRAP_RESERVE_SECONDS_VARIABLE,
    REGISTRY_BOOTSTRAP_DEFAULT_RESERVE_SECONDS,
    {
      minimum: REGISTRY_BOOTSTRAP_DEFAULT_RESERVE_SECONDS,
      maximum: MAX_RESERVE_SECONDS,
    },
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
  const unique = [...new Set(names)].sort(compareText);
  if (unique.length !== names.length) {
    throw error("exact publication lock selects duplicate Cargo package names");
  }
  return identities.sort((left, right) => compareText(left.name, right.name));
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
      const remainingMilliseconds = (deadlineEpochSeconds - nowImpl()) * 1000 - DEADLINE_RESERVE_MS;
      if (remainingMilliseconds <= 0) {
        throw error(`read-only existence check for ${label} cannot start before the registry mutation deadline`);
      }
      const response = await fetchImpl(url, {
        headers: {
          Accept: "application/json",
          "User-Agent": USER_AGENT,
        },
        redirect: "error",
        signal: AbortSignal.timeout(Math.max(1, Math.min(REQUEST_TIMEOUT_MS, remainingMilliseconds))),
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
      const delayMilliseconds = Math.ceil(delaySeconds * 1000);
      const retryRemainingMilliseconds = (deadlineEpochSeconds - nowImpl()) * 1000 - DEADLINE_RESERVE_MS;
      if (delayMilliseconds >= retryRemainingMilliseconds) {
        throw error(`read-only existence check for ${label} cannot retry before the registry mutation deadline`);
      }
      await sleepImpl(delayMilliseconds);
    } catch (cause) {
      if (cause instanceof Error && cause.message.startsWith("crates-io-bootstrap-capacity:")) {
        throw cause;
      }
      lastFailure = cause instanceof Error ? cause.message : String(cause);
      if (attempt + 1 >= REQUEST_ATTEMPTS) {
        break;
      }
      const delaySeconds = registryRetryDelaySeconds({ attempt, now: nowImpl() * 1000 });
      const delayMilliseconds = Math.ceil(delaySeconds * 1000);
      const retryRemainingMilliseconds = (deadlineEpochSeconds - nowImpl()) * 1000 - DEADLINE_RESERVE_MS;
      if (delayMilliseconds >= retryRemainingMilliseconds) {
        throw error(`read-only existence check for ${label} cannot retry before the registry mutation deadline`);
      }
      await sleepImpl(delayMilliseconds);
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

function validateBootstrapPublicationPlan(bootstrapPlan) {
  if (!Array.isArray(bootstrapPlan)) throw error("bootstrap publication plan must be a carrier list");
  const positions = new Map();
  let priorCarrier = null;
  for (const [index, carrier] of bootstrapPlan.entries()) {
    if (
      carrier === null
      || typeof carrier !== "object"
      || typeof carrier.id !== "string"
      || carrier.id !== `${carrier.ecosystem}:${carrier.name}`
      || !new Set(["cargo", "npm"]).has(carrier.ecosystem)
      || !Number.isSafeInteger(carrier.publishOrder)
      || carrier.publishOrder < 0
      || (priorCarrier !== null && (
        carrier.publishOrder < priorCarrier.publishOrder
        || (carrier.publishOrder === priorCarrier.publishOrder && carrier.id <= priorCarrier.id)
      ))
    ) {
      throw error(`bootstrap carrier ${index} is not in strict canonical publish order`);
    }
    if (positions.has(carrier.id)) throw error(`bootstrap carrier ${carrier.id} is duplicated`);
    if (
      !Array.isArray(carrier.dependencies)
      || new Set(carrier.dependencies).size !== carrier.dependencies.length
      || carrier.dependencies.some((dependency) => typeof dependency !== "string" || dependency.length === 0)
    ) {
      throw error(`bootstrap carrier ${carrier.id} dependencies must be a unique string list`);
    }
    positions.set(carrier.id, index);
    priorCarrier = carrier;
  }
  for (const [index, carrier] of bootstrapPlan.entries()) {
    for (const dependency of carrier.dependencies) {
      const position = positions.get(dependency);
      if (position === undefined) throw error(`${carrier.id} refers to unknown bootstrap dependency ${dependency}`);
      if (position >= index) throw error(`${carrier.id} is not ordered after bootstrap dependency ${dependency}`);
    }
  }
}

function validatedTokenBucketInputs({ publicationCount, burst, refillSeconds, workSeconds, initialTokens }) {
  for (const [value, context] of [
    [publicationCount, "publicationCount"],
    [burst, "burst"],
    [refillSeconds, "refillSeconds"],
    [workSeconds, "workSeconds"],
    [initialTokens, "initialTokens"],
  ]) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw error(`${context} must be a non-negative integer`);
    }
  }
  if (burst < 1 || refillSeconds < 1 || initialTokens > burst) {
    throw error("token bucket burst/refill must be positive and initialTokens cannot exceed burst");
  }
}

/**
 * Model crates.io's documented per-user token bucket without double-counting
 * upload work. Tokens refill while a frozen carrier is being published; when
 * work is slower than refill, the bucket may recover completely between
 * operations. Returned times are conservative whole seconds.
 */
export function cratesIoTokenBucketSchedule({
  publicationCount,
  burst,
  refillSeconds,
  workSeconds,
  initialTokens = burst,
}) {
  validatedTokenBucketInputs({ publicationCount, burst, refillSeconds, workSeconds, initialTokens });
  let elapsedSeconds = 0;
  let tokenClockSeconds = 0;
  // One token is exactly `refillSeconds` integer credit units. All planning
  // inputs are whole seconds, so this rational representation cannot drift
  // across a refill boundary and conservatively round 60s into 61s.
  const capacityUnits = burst * refillSeconds;
  let tokenUnits = initialTokens * refillSeconds;
  let waitSeconds = 0;
  const startSeconds = [];
  for (let index = 0; index < publicationCount; index += 1) {
    tokenUnits = Math.min(capacityUnits, tokenUnits + (elapsedSeconds - tokenClockSeconds));
    tokenClockSeconds = elapsedSeconds;
    if (tokenUnits < refillSeconds) {
      const wait = refillSeconds - tokenUnits;
      elapsedSeconds += wait;
      waitSeconds += wait;
      tokenUnits = refillSeconds;
      tokenClockSeconds = elapsedSeconds;
    }
    startSeconds.push(elapsedSeconds);
    tokenUnits -= refillSeconds;
    elapsedSeconds += workSeconds;
  }
  return {
    elapsedSeconds: Math.ceil(elapsedSeconds),
    waitSeconds: Math.ceil(waitSeconds),
    workSeconds: publicationCount * workSeconds,
    publicationCount,
    initialTokens,
    startSeconds,
  };
}

function consumeTokenAtOrAfter(state, earliestStartSeconds) {
  let startSeconds = earliestStartSeconds;
  state.tokenUnits = Math.min(
    state.burst * state.refillSeconds,
    state.tokenUnits + (startSeconds - state.clockSeconds),
  );
  state.clockSeconds = startSeconds;
  if (state.tokenUnits < state.refillSeconds) {
    startSeconds += state.refillSeconds - state.tokenUnits;
    state.tokenUnits = state.refillSeconds;
    state.clockSeconds = startSeconds;
  }
  state.tokenUnits -= state.refillSeconds;
  return startSeconds;
}

export function bootstrapPublicationCriticalPathSeconds(bootstrapPlan, carrierSeconds) {
  validateBootstrapPublicationPlan(bootstrapPlan);
  if (!(carrierSeconds instanceof Map)) {
    throw error("bootstrap carrier seconds must be a Map keyed by carrier ID");
  }
  const finishById = new Map();
  const priorByEcosystem = new Map();
  let criticalPathSeconds = 0;
  for (const carrier of bootstrapPlan) {
    const seconds = carrierSeconds.get(carrier.id);
    if (!Number.isSafeInteger(seconds) || seconds < 0) {
      throw error(`${carrier.id} must have a non-negative integer bootstrap budget`);
    }
    let startSeconds = 0;
    for (const dependency of carrier.dependencies) {
      startSeconds = Math.max(startSeconds, finishById.get(dependency));
    }
    const prior = priorByEcosystem.get(carrier.ecosystem);
    if (prior !== undefined) startSeconds = Math.max(startSeconds, finishById.get(prior));
    const finishSeconds = startSeconds + seconds;
    if (!Number.isSafeInteger(finishSeconds)) throw error("bootstrap publication critical path exceeds the safe integer range");
    finishById.set(carrier.id, finishSeconds);
    priorByEcosystem.set(carrier.ecosystem, carrier.id);
    criticalPathSeconds = Math.max(criticalPathSeconds, finishSeconds);
  }
  return criticalPathSeconds;
}

function bootstrapPublicationSchedule({
  bootstrapPlan,
  cargoInventory,
  npmInventory,
  cargoSecondsPerCarrier,
  npmSecondsPerCarrier,
  selectedCarrierIds,
  initialCargoTokens,
}) {
  validateBootstrapPublicationPlan(bootstrapPlan);
  const cargoState = exactVersionStateByName(cargoInventory, "Cargo");
  const npmState = exactVersionStateByName(npmInventory, "npm");
  const stateByEcosystem = new Map([["cargo", cargoState], ["npm", npmState]]);
  for (const ecosystem of ["cargo", "npm"]) {
    const planned = new Set(bootstrapPlan
      .filter((carrier) => carrier.ecosystem === ecosystem)
      .map(({ name }) => name));
    const states = stateByEcosystem.get(ecosystem);
    if (planned.size !== states.size || [...states.keys()].some((name) => !planned.has(name))) {
      throw error(`${ecosystem} bootstrap plan disagrees with the exact version inventory`);
    }
  }
  const selected = new Set(selectedCarrierIds);
  if (selected.size !== selectedCarrierIds.length) {
    throw error("selected bootstrap carrier IDs must be unique");
  }
  const finishById = new Map();
  const priorByEcosystem = new Map();
  const tokenState = {
    burst: CRATES_IO_DEFAULT_NEW_CRATE_BURST,
    refillSeconds: CRATES_IO_NEW_CRATE_REFILL_SECONDS,
    tokenUnits: initialCargoTokens * CRATES_IO_NEW_CRATE_REFILL_SECONDS,
    clockSeconds: 0,
  };
  let criticalPathSeconds = 0;
  let selectedCargoCount = 0;
  let selectedNpmCount = 0;
  for (const carrier of bootstrapPlan) {
    const state = stateByEcosystem.get(carrier.ecosystem).get(carrier.name).state;
    if (state === "published") {
      finishById.set(carrier.id, 0);
      continue;
    }
    if (!selected.has(carrier.id)) continue;
    if (state !== "missing") {
      throw error(`selected bootstrap carrier ${carrier.id} is not a brand-new identity`);
    }
    let startSeconds = 0;
    for (const dependency of carrier.dependencies) {
      const finish = finishById.get(dependency);
      if (finish === undefined) {
        throw error(`selected bootstrap carrier ${carrier.id} omits unsatisfied dependency ${dependency}`);
      }
      startSeconds = Math.max(startSeconds, finish);
    }
    const prior = priorByEcosystem.get(carrier.ecosystem);
    if (prior !== undefined) startSeconds = Math.max(startSeconds, finishById.get(prior));
    if (carrier.ecosystem === "cargo") {
      startSeconds = consumeTokenAtOrAfter(tokenState, startSeconds);
      selectedCargoCount += 1;
    } else {
      selectedNpmCount += 1;
    }
    const finishSeconds = startSeconds
      + (carrier.ecosystem === "cargo" ? cargoSecondsPerCarrier : npmSecondsPerCarrier);
    finishById.set(carrier.id, finishSeconds);
    priorByEcosystem.set(carrier.ecosystem, carrier.id);
    criticalPathSeconds = Math.max(criticalPathSeconds, finishSeconds);
  }
  const unknown = [...selected].filter((id) => !finishById.has(id));
  if (unknown.length > 0) {
    throw error(`selected bootstrap carrier IDs are absent or dependency-ineligible: ${unknown.join(", ")}`);
  }
  return {
    criticalPathSeconds: Math.ceil(criticalPathSeconds),
    selectedCargoCount,
    selectedNpmCount,
  };
}

function selectBootstrapPublicationBatch({
  bootstrapPlan,
  cargoInventory,
  npmInventory,
  cargoSecondsPerCarrier,
  npmSecondsPerCarrier,
  initialCargoTokens,
  availableSeconds,
}) {
  validateBootstrapPublicationPlan(bootstrapPlan);
  const cargoState = exactVersionStateByName(cargoInventory, "Cargo");
  const npmState = exactVersionStateByName(npmInventory, "npm");
  const states = new Map([["cargo", cargoState], ["npm", npmState]]);
  const carrierById = new Map(bootstrapPlan.map((carrier) => [carrier.id, carrier]));
  const selectedCarrierIds = [];
  const selected = new Set();
  for (const carrier of bootstrapPlan) {
    const state = states.get(carrier.ecosystem).get(carrier.name).state;
    if (state !== "missing") continue;
    const dependencyClosed = carrier.dependencies.every((dependency) => {
      const dependencyCarrier = carrierById.get(dependency);
      const dependencyState = states.get(dependencyCarrier.ecosystem).get(dependencyCarrier.name).state;
      return dependencyState === "published" || selected.has(dependency);
    });
    if (!dependencyClosed) continue;
    const tentative = [...selectedCarrierIds, carrier.id];
    const schedule = bootstrapPublicationSchedule({
      bootstrapPlan,
      cargoInventory,
      npmInventory,
      cargoSecondsPerCarrier,
      npmSecondsPerCarrier,
      selectedCarrierIds: tentative,
      initialCargoTokens,
    });
    if (schedule.criticalPathSeconds <= availableSeconds) {
      selectedCarrierIds.push(carrier.id);
      selected.add(carrier.id);
    }
  }
  const schedule = bootstrapPublicationSchedule({
    bootstrapPlan,
    cargoInventory,
    npmInventory,
    cargoSecondsPerCarrier,
    npmSecondsPerCarrier,
    selectedCarrierIds,
    initialCargoTokens,
  });
  return { selectedCarrierIds, ...schedule };
}

export function assessCratesIoBootstrapCapacity({
  inventory,
  npmInventory = {
    selectedIdentities: [],
    publishedIdentities: [],
    pendingVersions: [],
    missingNames: [],
  },
  bootstrapPlan = undefined,
  cargoSecondsPerCarrier,
  npmSecondsPerCarrier,
  reconciliationSecondsPerCarrier,
  reserveSeconds,
  deadlineEpochSeconds,
  nowEpochSeconds = Math.floor(Date.now() / 1000),
}) {
  const nameInventory = inventory !== null
    && typeof inventory === "object"
    && Array.isArray(inventory.selectedNames)
    && Array.isArray(inventory.existingNames)
    && Array.isArray(inventory.missingNames);
  const versionInventory = inventory !== null
    && typeof inventory === "object"
    && Array.isArray(inventory.selectedIdentities)
    && Array.isArray(inventory.publishedIdentities)
    && Array.isArray(inventory.pendingVersions)
    && Array.isArray(inventory.missingNames);
  if (!nameInventory && !versionInventory) {
    throw error("Cargo inventory must contain either name state or exact-version state lists");
  }
  if (
    npmInventory === null
    || typeof npmInventory !== "object"
    || !Array.isArray(npmInventory.selectedIdentities)
    || !Array.isArray(npmInventory.publishedIdentities)
    || !Array.isArray(npmInventory.pendingVersions)
    || !Array.isArray(npmInventory.missingNames)
  ) {
    throw error("npm inventory must contain selected, published, pending-version, and missing-name lists");
  }
  const missingCount = inventory.missingNames.length;
  const selectedCount = versionInventory ? inventory.selectedIdentities.length : inventory.selectedNames.length;
  const existingCount = selectedCount - missingCount;
  const publishedCargoCount = versionInventory ? inventory.publishedIdentities.length : existingCount;
  const cargoConflictCount = versionInventory ? inventory.pendingVersions.length : 0;
  const pendingCargoCount = missingCount;
  const selectedNpmCount = npmInventory.selectedIdentities.length;
  const publishedNpmCount = npmInventory.publishedIdentities.length;
  const npmConflictCount = npmInventory.pendingVersions.length;
  const missingNpmCount = npmInventory.missingNames.length;
  const pendingNpmCount = missingNpmCount;
  if (publishedNpmCount + npmConflictCount + missingNpmCount !== selectedNpmCount) {
    throw error("npm exact-version inventory does not partition every selected identity");
  }
  if (versionInventory && publishedCargoCount + cargoConflictCount + pendingCargoCount !== selectedCount) {
    throw error("Cargo exact-version inventory does not partition every selected identity");
  }
  const remainingSeconds = deadlineEpochSeconds - nowEpochSeconds;
  const parsedCargoSeconds = parseRegistryBootstrapCargoSeconds(cargoSecondsPerCarrier);
  const parsedNpmSeconds = parseRegistryBootstrapNpmSeconds(npmSecondsPerCarrier);
  const parsedReconciliationSeconds = parseRegistryBootstrapReconciliationSeconds(reconciliationSecondsPerCarrier);
  const parsedReserveSeconds = parseRegistryBootstrapReserveSeconds(reserveSeconds);
  const plannedPublicationSeconds = (pendingCargoCount * parsedCargoSeconds) + (pendingNpmCount * parsedNpmSeconds);
  const reconciliationCount = publishedCargoCount + publishedNpmCount;
  const plannedReconciliationSeconds = reconciliationCount * parsedReconciliationSeconds;
  const identityCreationOnlySatisfied = cargoConflictCount === 0 && npmConflictCount === 0;
  const initialCargoTokens = publishedCargoCount === 0
    ? CRATES_IO_DEFAULT_NEW_CRATE_BURST
    : 0;
  const defaultTokenBucket = cratesIoTokenBucketSchedule({
    publicationCount: pendingCargoCount,
    burst: CRATES_IO_DEFAULT_NEW_CRATE_BURST,
    refillSeconds: CRATES_IO_NEW_CRATE_REFILL_SECONDS,
    workSeconds: parsedCargoSeconds,
    initialTokens: initialCargoTokens,
  });
  let admittedCarrierIds = [];
  let admittedCargoCount = 0;
  let admittedNpmCount = 0;
  let plannedPublicationCriticalPathSeconds = plannedPublicationSeconds;
  const availablePublicationSeconds = Math.max(
    0,
    remainingSeconds - plannedReconciliationSeconds - parsedReserveSeconds,
  );
  if (bootstrapPlan !== undefined) {
    if (!versionInventory) throw error("exact-version Cargo inventory is required with a bootstrap publication plan");
    const batch = selectBootstrapPublicationBatch({
      bootstrapPlan,
      cargoInventory: inventory,
      npmInventory,
      cargoSecondsPerCarrier: parsedCargoSeconds,
      npmSecondsPerCarrier: parsedNpmSeconds,
      initialCargoTokens,
      availableSeconds: remainingSeconds < MINIMUM_MUTATION_WINDOW_SECONDS ? 0 : availablePublicationSeconds,
    });
    admittedCarrierIds = batch.selectedCarrierIds;
    admittedCargoCount = batch.selectedCargoCount;
    admittedNpmCount = batch.selectedNpmCount;
    plannedPublicationCriticalPathSeconds = batch.criticalPathSeconds;
  } else if (missingCount + missingNpmCount > 0 && remainingSeconds >= MINIMUM_MUTATION_WINDOW_SECONDS) {
    // Compatibility for name-only callers: admit the Cargo count that fits
    // the official bucket and all npm identities only when their two-lane
    // estimate fits. Exact release execution always supplies bootstrapPlan.
    for (let count = 1; count <= pendingCargoCount; count += 1) {
      const schedule = cratesIoTokenBucketSchedule({
        publicationCount: count,
        burst: CRATES_IO_DEFAULT_NEW_CRATE_BURST,
        refillSeconds: CRATES_IO_NEW_CRATE_REFILL_SECONDS,
        workSeconds: parsedCargoSeconds,
        initialTokens: initialCargoTokens,
      });
      if (schedule.elapsedSeconds <= availablePublicationSeconds) admittedCargoCount = count;
    }
    admittedNpmCount = pendingNpmCount * parsedNpmSeconds <= availablePublicationSeconds ? pendingNpmCount : 0;
    plannedPublicationCriticalPathSeconds = Math.max(
      cratesIoTokenBucketSchedule({
        publicationCount: admittedCargoCount,
        burst: CRATES_IO_DEFAULT_NEW_CRATE_BURST,
        refillSeconds: CRATES_IO_NEW_CRATE_REFILL_SECONDS,
        workSeconds: parsedCargoSeconds,
        initialTokens: initialCargoTokens,
      }).elapsedSeconds,
      admittedNpmCount * parsedNpmSeconds,
    );
  }
  const admittedCount = bootstrapPlan === undefined
    ? admittedCargoCount + admittedNpmCount
    : admittedCarrierIds.length;
  const remainingMutationCount = pendingCargoCount + pendingNpmCount - admittedCount;
  const requiredWindowSeconds = Math.max(
    MINIMUM_MUTATION_WINDOW_SECONDS,
    plannedPublicationCriticalPathSeconds + plannedReconciliationSeconds + parsedReserveSeconds,
  );
  const timeSatisfied = remainingSeconds >= requiredWindowSeconds;
  const makesProgress = admittedCount > 0 || remainingMutationCount === 0;
  const decision = identityCreationOnlySatisfied && timeSatisfied && makesProgress ? "execute" : "defer";
  return {
    selectedCount,
    existingCount,
    publishedCargoCount,
    cargoConflictCount,
    pendingCargoCount,
    selectedNpmCount,
    publishedNpmCount,
    npmConflictCount,
    missingNpmCount,
    pendingNpmCount,
    missingCount,
    missingNames: inventory.missingNames,
    initialCargoTokens,
    tokenBucketPublicationSeconds: defaultTokenBucket.elapsedSeconds,
    tokenBucketWaitSeconds: defaultTokenBucket.waitSeconds,
    defaultMinimumSeconds: defaultTokenBucket.elapsedSeconds,
    remainingSeconds,
    minimumMutationWindowSeconds: requiredWindowSeconds,
    planningHeadroomSeconds: Math.max(0, remainingSeconds - requiredWindowSeconds),
    plannedPublicationSeconds,
    plannedPublicationCriticalPathSeconds,
    reconciliationCount,
    plannedReconciliationSeconds,
    cargoSecondsPerCarrier: parsedCargoSeconds,
    npmSecondsPerCarrier: parsedNpmSeconds,
    reconciliationSecondsPerCarrier: parsedReconciliationSeconds,
    reserveSeconds: parsedReserveSeconds,
    admittedCarrierIds,
    admittedCargoCount,
    admittedNpmCount,
    admittedCount,
    remainingMutationCount,
    completeAfterExecution: remainingMutationCount === 0,
    notBeforeEpochSeconds: decision === "defer"
      ? nowEpochSeconds + CRATES_IO_NEW_CRATE_REFILL_SECONDS
      : null,
    decision,
    timeSatisfied,
    identityCreationOnlySatisfied,
    allowed: decision === "execute",
  };
}

function exactVersionStateByName(inventory, ecosystem) {
  const selected = new Map();
  for (const [index, identity] of inventory.selectedIdentities.entries()) {
    if (
      identity === null
      || typeof identity !== "object"
      || typeof identity.name !== "string"
      || identity.name.length === 0
      || typeof identity.version !== "string"
      || identity.version.length === 0
    ) {
      throw error(`${ecosystem} selected identity ${index} must contain a name and version`);
    }
    if (selected.has(identity.name)) {
      throw error(`${ecosystem} version inventory selects duplicate package name ${identity.name}`);
    }
    selected.set(identity.name, { version: identity.version, state: null });
  }

  function recordIdentities(identities, state) {
    const observed = new Set();
    for (const [index, identity] of identities.entries()) {
      if (
        identity === null
        || typeof identity !== "object"
        || typeof identity.name !== "string"
        || typeof identity.version !== "string"
      ) {
        throw error(`${ecosystem} ${state} identity ${index} must contain a name and version`);
      }
      const expected = selected.get(identity.name);
      if (expected === undefined || expected.version !== identity.version) {
        throw error(`${ecosystem} ${state} identity ${identity.name}@${identity.version} is absent from the exact selection`);
      }
      if (observed.has(identity.name) || expected.state !== null) {
        throw error(`${ecosystem} identity ${identity.name} is duplicated across version-inventory states`);
      }
      observed.add(identity.name);
      expected.state = state;
    }
  }

  recordIdentities(inventory.publishedIdentities, "published");
  recordIdentities(inventory.pendingVersions, "pending");
  const missing = new Set();
  for (const [index, name] of inventory.missingNames.entries()) {
    if (typeof name !== "string" || name.length === 0) {
      throw error(`${ecosystem} missing-name identity ${index} must be a nonempty string`);
    }
    const expected = selected.get(name);
    if (expected === undefined) {
      throw error(`${ecosystem} missing name ${name} is absent from the exact selection`);
    }
    if (missing.has(name) || expected.state !== null) {
      throw error(`${ecosystem} identity ${name} is duplicated across version-inventory states`);
    }
    missing.add(name);
    expected.state = "missing";
  }
  const unclassified = [...selected].filter(([, value]) => value.state === null).map(([name]) => name);
  if (unclassified.length > 0) {
    throw error(`${ecosystem} version inventory does not classify ${unclassified.join(", ")}`);
  }
  return selected;
}

function validateNormalPublicationOperations(normalPlan) {
  if (normalPlan === null || typeof normalPlan !== "object" || !Array.isArray(normalPlan.operations)) {
    throw error("normal publication plan must contain an operations list");
  }
  const positions = new Map();
  for (const [index, operation] of normalPlan.operations.entries()) {
    if (
      operation === null
      || typeof operation !== "object"
      || operation.operationOrder !== index
      || typeof operation.id !== "string"
      || operation.id.length === 0
    ) {
      throw error(`normal publication operation ${index} is not in contiguous canonical order`);
    }
    if (positions.has(operation.id)) throw error(`normal publication operation ${operation.id} is duplicated`);
    positions.set(operation.id, index);
    if (
      !Array.isArray(operation.dependencies)
      || new Set(operation.dependencies).size !== operation.dependencies.length
      || operation.dependencies.some((dependency) => typeof dependency !== "string" || dependency.length === 0)
    ) {
      throw error(`normal publication operation ${operation.id} dependencies must be a unique string list`);
    }
    if (operation.kind === "carrier") {
      if (
        !new Set(["cargo", "npm", "jsr"]).has(operation.ecosystem)
        || typeof operation.carrierId !== "string"
        || !operation.carrierId.startsWith(`${operation.ecosystem}:`)
      ) {
        throw error(`normal publication carrier operation ${operation.id} is invalid`);
      }
    } else if (
      operation.kind !== "maven-atomic-deployment"
      || operation.ecosystem !== "maven"
      || !Array.isArray(operation.carrierIds)
      || operation.carrierIds.length === 0
    ) {
      throw error(`normal publication operation ${operation.id} has an unsupported shape`);
    }
  }
  for (const [index, operation] of normalPlan.operations.entries()) {
    for (const dependency of operation.dependencies) {
      const position = positions.get(dependency);
      if (position === undefined) throw error(`${operation.id} refers to unknown dependency ${dependency}`);
      if (position >= index) throw error(`${operation.id} is not ordered after dependency ${dependency}`);
    }
  }
}

export function normalPublicationCriticalPathSeconds(normalPlan, operationSeconds) {
  validateNormalPublicationOperations(normalPlan);
  if (!(operationSeconds instanceof Map)) {
    throw error("normal publication operation seconds must be a Map keyed by operation ID");
  }
  const finishById = new Map();
  const priorByEcosystem = new Map();
  let criticalPathSeconds = 0;
  for (const operation of normalPlan.operations) {
    const seconds = operationSeconds.get(operation.id);
    if (!Number.isSafeInteger(seconds) || seconds < 0) {
      throw error(`${operation.id} must have a non-negative integer publication budget`);
    }
    let startSeconds = 0;
    for (const dependency of operation.dependencies) {
      startSeconds = Math.max(startSeconds, finishById.get(dependency));
    }
    const prior = priorByEcosystem.get(operation.ecosystem);
    if (prior !== undefined) startSeconds = Math.max(startSeconds, finishById.get(prior));
    const finishSeconds = startSeconds + seconds;
    if (!Number.isSafeInteger(finishSeconds)) throw error("normal publication critical path exceeds the safe integer range");
    finishById.set(operation.id, finishSeconds);
    priorByEcosystem.set(operation.ecosystem, operation.id);
    criticalPathSeconds = Math.max(criticalPathSeconds, finishSeconds);
  }
  return criticalPathSeconds;
}

function canonicalCompletedOperationIds(normalPlan, completedOperationIds) {
  const values = completedOperationIds ?? [];
  if (
    !Array.isArray(values)
    || values.some((id) => typeof id !== "string" || id.length === 0)
    || new Set(values).size !== values.length
  ) {
    throw error("completed normal-publication operation IDs must be a unique string list");
  }
  const operationById = new Map(normalPlan.operations.map((operation) => [operation.id, operation]));
  if (values.some((id) => !operationById.has(id))) {
    throw error("completed normal-publication operation IDs must be an exact plan projection");
  }
  const canonical = normalPlan.operations.filter(({ id }) => values.includes(id)).map(({ id }) => id);
  if (canonical.some((id, index) => id !== values[index])) {
    throw error("completed normal-publication operation IDs must retain exact plan order");
  }
  const completed = new Set(canonical);
  for (const id of canonical) {
    const missing = operationById.get(id).dependencies.filter((dependency) => !completed.has(dependency));
    if (missing.length > 0) {
      throw error(`completed operation ${id} is missing completed dependencies: ${missing.join(", ")}`);
    }
  }
  return canonical;
}

function normalPublicationCapacityModel({
  normalPlan,
  cargoInventory,
  npmInventory,
  reconciledCarrierIds,
  completedOperationIds,
  initialCargoTokens,
}) {
  validateNormalPublicationOperations(normalPlan);
  if (
    !Array.isArray(reconciledCarrierIds)
    || reconciledCarrierIds.some((id) => typeof id !== "string" || id.length === 0)
    || new Set(reconciledCarrierIds).size !== reconciledCarrierIds.length
  ) {
    throw error("reconciled carrier IDs must be a unique string list");
  }
  const canonicalCompletedIds = canonicalCompletedOperationIds(normalPlan, completedOperationIds);
  const completed = new Set(canonicalCompletedIds);
  const cargoState = exactVersionStateByName(cargoInventory, "Cargo");
  const npmState = exactVersionStateByName(npmInventory, "npm");
  const stateByEcosystem = new Map([["cargo", cargoState], ["npm", npmState]]);
  const carrierOperationById = new Map();
  const selectedNamesByEcosystem = new Map([["cargo", new Set()], ["npm", new Set()]]);
  for (const operation of normalPlan.operations) {
    if (operation.kind !== "carrier" || !new Set(["cargo", "npm"]).has(operation.ecosystem)) continue;
    if (carrierOperationById.has(operation.carrierId)) {
      throw error(`normal publication carrier ${operation.carrierId} is assigned to multiple operations`);
    }
    carrierOperationById.set(operation.carrierId, operation);
    selectedNamesByEcosystem.get(operation.ecosystem).add(
      operation.carrierId.slice(operation.ecosystem.length + 1),
    );
  }
  for (const [ecosystem, states] of stateByEcosystem) {
    const planned = selectedNamesByEcosystem.get(ecosystem);
    if (planned.size !== states.size || [...states.keys()].some((name) => !planned.has(name))) {
      throw error(`${ecosystem} normal publication operations disagree with the exact version inventory`);
    }
  }

  const reconciled = new Set(reconciledCarrierIds);
  let reconciledCargoCount = 0;
  let reconciledNpmCount = 0;
  for (const id of reconciled) {
    const operation = carrierOperationById.get(id);
    if (operation === undefined) {
      throw error(`reconciled carrier ${id} is absent from the Cargo/npm normal publication plan`);
    }
    const name = id.slice(operation.ecosystem.length + 1);
    if (stateByEcosystem.get(operation.ecosystem).get(name)?.state !== "published") {
      throw error(`reconciled carrier ${id} is not present in the exact public registry inventory`);
    }
    if (operation.ecosystem === "cargo") reconciledCargoCount += 1;
    else reconciledNpmCount += 1;
  }

  const operationSeconds = new Map();
  const consumesCargoToken = new Set();
  let mavenOperationCount = 0;
  let jsrCarrierCount = 0;
  let publicReconciliationCount = 0;
  for (const operation of normalPlan.operations) {
    let seconds;
    if (operation.kind === "maven-atomic-deployment") {
      seconds = NORMAL_REGISTRY_MAVEN_OPERATION_SECONDS;
      if (!completed.has(operation.id)) mavenOperationCount += 1;
    } else if (operation.ecosystem === "jsr") {
      seconds = NORMAL_REGISTRY_JSR_SECONDS_PER_CARRIER;
      if (!completed.has(operation.id)) jsrCarrierCount += 1;
    } else {
      const name = operation.carrierId.slice(operation.ecosystem.length + 1);
      const state = stateByEcosystem.get(operation.ecosystem).get(name).state;
      if (completed.has(operation.id) && state !== "published") {
        throw error(`checkpointed operation ${operation.id} is not present in the exact public registry inventory`);
      }
      seconds = state === "published"
        ? (reconciled.has(operation.carrierId) ? 0 : NORMAL_REGISTRY_RECONCILIATION_SECONDS_PER_CARRIER)
        : operation.ecosystem === "cargo"
          ? CRATES_IO_TRUSTED_PUBLISH_PLANNING_SECONDS_PER_CARRIER
          : NORMAL_REGISTRY_NPM_SECONDS_PER_CARRIER;
      if (!completed.has(operation.id) && state === "published" && !reconciled.has(operation.carrierId)) {
        publicReconciliationCount += 1;
      }
      if (!completed.has(operation.id) && operation.ecosystem === "cargo" && state === "pending") {
        consumesCargoToken.add(operation.id);
      }
    }
    operationSeconds.set(operation.id, seconds);
  }
  return {
    normalPlan,
    completedOperationIds: canonicalCompletedIds,
    completed,
    operationSeconds,
    consumesCargoToken,
    initialCargoTokens,
    mavenOperationCount,
    jsrCarrierCount,
    reconciledCargoCount,
    reconciledNpmCount,
    publicReconciliationCount,
  };
}

function emptyCargoTokenState(initialCargoTokens) {
  return {
    burst: CRATES_IO_DEFAULT_VERSION_BURST,
    refillSeconds: CRATES_IO_VERSION_REFILL_SECONDS,
    tokenUnits: initialCargoTokens * CRATES_IO_VERSION_REFILL_SECONDS,
    clockSeconds: 0,
  };
}

function requiredNormalPublicationWindow(criticalPathSeconds) {
  return Math.max(
    MINIMUM_MUTATION_WINDOW_SECONDS,
    Math.ceil(criticalPathSeconds) + NORMAL_REGISTRY_EXECUTOR_RESERVE_SECONDS,
  );
}

function validateAdmittedOperationIds(model, admittedOperationIds) {
  if (
    !Array.isArray(admittedOperationIds)
    || admittedOperationIds.some((id) => typeof id !== "string" || id.length === 0)
    || new Set(admittedOperationIds).size !== admittedOperationIds.length
  ) {
    throw error("admitted normal-publication operation IDs must be a unique string list");
  }
  const admitted = new Set(admittedOperationIds);
  const canonical = model.normalPlan.operations
    .filter(({ id }) => admitted.has(id))
    .map(({ id }) => id);
  if (
    canonical.length !== admitted.size
    || canonical.some((id, index) => id !== admittedOperationIds[index])
    || admittedOperationIds.some((id) => model.completed.has(id))
  ) {
    throw error("admitted normal-publication operation IDs must be an ordered remaining-plan projection");
  }
  const satisfied = new Set([...model.completed, ...admitted]);
  for (const id of admittedOperationIds) {
    const operation = model.normalPlan.operations.find((candidate) => candidate.id === id);
    const missing = operation.dependencies.filter((dependency) => !satisfied.has(dependency));
    if (missing.length > 0) {
      throw error(`admitted operation ${id} omits unsatisfied dependencies: ${missing.join(", ")}`);
    }
  }
  return admitted;
}

function normalPublicationSubsetSchedule(model, admittedOperationIds) {
  const admitted = validateAdmittedOperationIds(model, admittedOperationIds);
  const finishById = new Map(model.completedOperationIds.map((id) => [id, 0]));
  const priorByEcosystem = new Map();
  const tokenState = emptyCargoTokenState(model.initialCargoTokens);
  let criticalPathSeconds = 0;
  for (const operation of model.normalPlan.operations) {
    if (!admitted.has(operation.id)) continue;
    let startSeconds = 0;
    for (const dependency of operation.dependencies) {
      const finish = finishById.get(dependency);
      if (finish === undefined) {
        throw error(`admitted operation ${operation.id} omits unsatisfied dependency ${dependency}`);
      }
      startSeconds = Math.max(startSeconds, finish);
    }
    const prior = priorByEcosystem.get(operation.ecosystem);
    if (prior !== undefined) startSeconds = Math.max(startSeconds, finishById.get(prior));
    if (model.consumesCargoToken.has(operation.id)) {
      startSeconds = consumeTokenAtOrAfter(tokenState, startSeconds);
    }
    const finishSeconds = startSeconds + model.operationSeconds.get(operation.id);
    finishById.set(operation.id, finishSeconds);
    priorByEcosystem.set(operation.ecosystem, operation.id);
    criticalPathSeconds = Math.max(criticalPathSeconds, finishSeconds);
  }
  return {
    criticalPathSeconds: Math.ceil(criticalPathSeconds),
    requiredWindowSeconds: requiredNormalPublicationWindow(criticalPathSeconds),
  };
}

/**
 * Deterministically admit a canonical first-fit maximal subset that fits one
 * fresh registry window. This is intentionally not a maximum-cardinality
 * optimizer: canonical dependency progress is more important than preferring
 * many cheap reconciliation rows over an earlier frozen mutation. The plan
 * order is already topological. An operation is considered only after every
 * dependency is either checkpoint-complete or admitted; a rejected operation
 * cannot become insertable after more non-negative work is admitted, while a
 * later independent registry lane may still fill otherwise idle critical-path
 * capacity. Maven remains one indivisible operation.
 *
 * If work remains, the intrinsic-capacity check below requires this set to be
 * nonempty. Every successful partial invocation therefore adds at least one
 * checkpointed operation, so a fixed N-operation plan completes in at most N
 * invocations; an operation that cannot ever fit fails before mutation instead
 * of starving behind unbounded continuations.
 */
export function selectNormalPublicationOperationSubset(model, availableWindowSeconds) {
  if (!Number.isSafeInteger(availableWindowSeconds) || availableWindowSeconds < 0) {
    throw error("normal-publication available window must be a non-negative safe integer");
  }
  const finishById = new Map(model.completedOperationIds.map((id) => [id, 0]));
  const priorByEcosystem = new Map();
  let tokenState = emptyCargoTokenState(model.initialCargoTokens);
  let criticalPathSeconds = 0;
  const admittedOperationIds = [];
  const admitted = new Set();
  for (const operation of model.normalPlan.operations) {
    if (model.completed.has(operation.id)) continue;
    if (operation.dependencies.some((dependency) => !finishById.has(dependency))) continue;
    let startSeconds = 0;
    for (const dependency of operation.dependencies) {
      startSeconds = Math.max(startSeconds, finishById.get(dependency));
    }
    const prior = priorByEcosystem.get(operation.ecosystem);
    if (prior !== undefined) startSeconds = Math.max(startSeconds, finishById.get(prior));
    const candidateTokenState = { ...tokenState };
    if (model.consumesCargoToken.has(operation.id)) {
      startSeconds = consumeTokenAtOrAfter(candidateTokenState, startSeconds);
    }
    const finishSeconds = startSeconds + model.operationSeconds.get(operation.id);
    const candidateCriticalPathSeconds = Math.max(criticalPathSeconds, finishSeconds);
    if (requiredNormalPublicationWindow(candidateCriticalPathSeconds) > availableWindowSeconds) continue;
    admittedOperationIds.push(operation.id);
    admitted.add(operation.id);
    finishById.set(operation.id, finishSeconds);
    priorByEcosystem.set(operation.ecosystem, operation.id);
    tokenState = candidateTokenState;
    criticalPathSeconds = candidateCriticalPathSeconds;
  }
  const unadmittedOperationIds = model.normalPlan.operations
    .filter(({ id }) => !model.completed.has(id) && !admitted.has(id))
    .map(({ id }) => id);
  return {
    admittedOperationIds,
    unadmittedOperationIds,
    criticalPathSeconds: Math.ceil(criticalPathSeconds),
    requiredWindowSeconds: requiredNormalPublicationWindow(criticalPathSeconds),
  };
}

function isolatedNormalPublicationOperationSchedule(model, operation) {
  let startSeconds = 0;
  if (model.consumesCargoToken.has(operation.id)) {
    startSeconds = consumeTokenAtOrAfter(emptyCargoTokenState(model.initialCargoTokens), 0);
  }
  const criticalPathSeconds = startSeconds + model.operationSeconds.get(operation.id);
  return {
    criticalPathSeconds,
    requiredWindowSeconds: requiredNormalPublicationWindow(criticalPathSeconds),
  };
}

function intrinsicCapacityError(model, operation, authoritativeWindowSeconds) {
  const schedule = isolatedNormalPublicationOperationSchedule(model, operation);
  const atomic = operation.kind === "maven-atomic-deployment" ? " atomic" : "";
  return error(
    `${operation.id}${atomic} operation intrinsically requires ${schedule.requiredWindowSeconds}s `
      + `(${model.operationSeconds.get(operation.id)}s operation plus `
      + `${NORMAL_REGISTRY_EXECUTOR_RESERVE_SECONDS}s executor reserve, with a `
      + `${MINIMUM_MUTATION_WINDOW_SECONDS}s minimum), but the authoritative fresh mutation window is only `
      + `${authoritativeWindowSeconds}s; split or redesign the operation before publishing`,
  );
}

function assertNoIntrinsicallyOversizedNormalOperation(model, authoritativeWindowSeconds) {
  // Check the entire remaining frozen plan, not only the first currently
  // dependency-eligible row. Otherwise an early cheap mutation could be made
  // before a later indivisible operation is discovered to be impossible in
  // every fresh continuation window.
  const oversized = model.normalPlan.operations.find(
    (operation) => !model.completed.has(operation.id)
      && isolatedNormalPublicationOperationSchedule(model, operation).requiredWindowSeconds
        > authoritativeWindowSeconds,
  );
  if (oversized !== undefined) {
    throw intrinsicCapacityError(model, oversized, authoritativeWindowSeconds);
  }
}

export function assessCratesIoVersionCapacity({
  inventory,
  npmInventory = {
    selectedIdentities: [],
    publishedIdentities: [],
    pendingVersions: [],
    missingNames: [],
  },
  normalPlan = undefined,
  reconciledCarrierIds = undefined,
  completedOperationIds = undefined,
  authoritativeWindowSeconds = undefined,
  mavenOperationCount = undefined,
  jsrCarrierCount = undefined,
  reconciledCargoCount = undefined,
  reconciledNpmCount = undefined,
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
  if (
    npmInventory === null
    || typeof npmInventory !== "object"
    || !Array.isArray(npmInventory.selectedIdentities)
    || !Array.isArray(npmInventory.publishedIdentities)
    || !Array.isArray(npmInventory.pendingVersions)
    || !Array.isArray(npmInventory.missingNames)
  ) {
    throw error("npm version inventory must contain selected, published, pending, and missing-name lists");
  }
  for (const [value, context] of [
    [mavenOperationCount, "Maven operation count"],
    [jsrCarrierCount, "JSR carrier count"],
    [reconciledCargoCount, "ledger-reconciled Cargo count"],
    [reconciledNpmCount, "ledger-reconciled npm count"],
  ]) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
      throw error(`${context} must be a non-negative integer`);
    }
  }
  if (
    inventory.publishedIdentities.length + inventory.pendingVersions.length + inventory.missingNames.length
      !== inventory.selectedIdentities.length
    || npmInventory.publishedIdentities.length + npmInventory.pendingVersions.length + npmInventory.missingNames.length
      !== npmInventory.selectedIdentities.length
  ) {
    throw error("Cargo/npm exact-version inventories must partition every selected identity");
  }
  const pendingCount = inventory.pendingVersions.length;
  const remainingSeconds = deadlineEpochSeconds - nowEpochSeconds;
  const exactAuthoritativeWindowSeconds = authoritativeWindowSeconds === undefined
    ? Math.max(MINIMUM_MUTATION_WINDOW_SECONDS, remainingSeconds)
    : strictNonNegativeInteger(
        authoritativeWindowSeconds,
        "authoritative normal-registry mutation window",
        MAX_RESERVE_SECONDS,
      );
  if (exactAuthoritativeWindowSeconds < MINIMUM_MUTATION_WINDOW_SECONDS) {
    throw error(
      `authoritative normal-registry mutation window must be at least ${MINIMUM_MUTATION_WINDOW_SECONDS}s`,
    );
  }
  const plannedPublicationSeconds = pendingCount * CRATES_IO_TRUSTED_PUBLISH_PLANNING_SECONDS_PER_CARRIER;
  const pendingNpmCount = npmInventory.pendingVersions.length;
  const plannedNpmPublicationSeconds = pendingNpmCount * NORMAL_REGISTRY_NPM_SECONDS_PER_CARRIER;
  const publishedCargoCount = inventory.publishedIdentities.length;
  const publishedNpmCount = npmInventory.publishedIdentities.length;
  let exactReconciledCargoCount = reconciledCargoCount ?? 0;
  let exactReconciledNpmCount = reconciledNpmCount ?? 0;
  let exactMavenOperationCount = mavenOperationCount ?? 0;
  let exactJsrCarrierCount = jsrCarrierCount ?? 0;
  let plannedExecutorCriticalPathSeconds;
  let fullRemainingCriticalPathSeconds;
  let fullRemainingWindowSeconds;
  let admittedOperationIds = [];
  let unadmittedOperationIds = [];
  let canonicalCompletedIds = [];
  let publicationCompleteAfterAdmission = true;
  let requiredWindowSeconds;
  let publicReconciliationCount;
  const initialCargoTokens = publishedCargoCount === 0
    ? CRATES_IO_DEFAULT_VERSION_BURST
    : 0;
  const tokenBucket = cratesIoTokenBucketSchedule({
    publicationCount: pendingCount,
    burst: CRATES_IO_DEFAULT_VERSION_BURST,
    refillSeconds: CRATES_IO_VERSION_REFILL_SECONDS,
    workSeconds: CRATES_IO_TRUSTED_PUBLISH_PLANNING_SECONDS_PER_CARRIER,
    initialTokens: initialCargoTokens,
  });
  if (normalPlan !== undefined) {
    const model = normalPublicationCapacityModel({
      normalPlan,
      cargoInventory: inventory,
      npmInventory,
      reconciledCarrierIds: reconciledCarrierIds ?? [],
      completedOperationIds: completedOperationIds ?? [],
      initialCargoTokens,
    });
    exactReconciledCargoCount = model.reconciledCargoCount;
    exactReconciledNpmCount = model.reconciledNpmCount;
    exactMavenOperationCount = model.mavenOperationCount;
    exactJsrCarrierCount = model.jsrCarrierCount;
    canonicalCompletedIds = model.completedOperationIds;
    publicReconciliationCount = model.publicReconciliationCount;
    assertNoIntrinsicallyOversizedNormalOperation(model, exactAuthoritativeWindowSeconds);
    const remainingOperationIds = normalPlan.operations
      .filter(({ id }) => !model.completed.has(id))
      .map(({ id }) => id);
    const fullSchedule = normalPublicationSubsetSchedule(model, remainingOperationIds);
    fullRemainingCriticalPathSeconds = fullSchedule.criticalPathSeconds;
    fullRemainingWindowSeconds = remainingOperationIds.length === 0 ? 1 : fullSchedule.requiredWindowSeconds;
    const intrinsic = selectNormalPublicationOperationSubset(model, exactAuthoritativeWindowSeconds);
    if (remainingOperationIds.length > 0 && intrinsic.admittedOperationIds.length === 0) {
      throw error(
        "remaining normal-publication plan has no dependency-eligible operation after its completed checkpoint projection",
      );
    }
    const liveWindowSeconds = Math.max(
      0,
      Math.min(exactAuthoritativeWindowSeconds, remainingSeconds),
    );
    const live = selectNormalPublicationOperationSubset(model, liveWindowSeconds);
    if (remainingOperationIds.length === 0) {
      // No registry operation remains to admit. Keep a positive workflow
      // handoff value without imposing the mutation floor; the publisher only
      // reconciles the completed checkpoint and assembles final evidence.
      requiredWindowSeconds = 1;
      plannedExecutorCriticalPathSeconds = 0;
    } else if (live.admittedOperationIds.length > 0) {
      admittedOperationIds = live.admittedOperationIds;
      unadmittedOperationIds = live.unadmittedOperationIds;
      requiredWindowSeconds = live.requiredWindowSeconds;
      plannedExecutorCriticalPathSeconds = live.criticalPathSeconds;
    } else {
      // The plan has at least one intrinsically admissible operation, but this
      // invocation no longer retains enough of its live window to begin it.
      // Preserve the fresh-window requirement for the typed capacity deferral.
      unadmittedOperationIds = remainingOperationIds;
      requiredWindowSeconds = intrinsic.requiredWindowSeconds;
      plannedExecutorCriticalPathSeconds = 0;
    }
    publicationCompleteAfterAdmission = unadmittedOperationIds.length === 0;
    for (const [declared, observed, context] of [
      [reconciledCargoCount, exactReconciledCargoCount, "ledger-reconciled Cargo count"],
      [reconciledNpmCount, exactReconciledNpmCount, "ledger-reconciled npm count"],
      [mavenOperationCount, exactMavenOperationCount, "Maven operation count"],
      [jsrCarrierCount, exactJsrCarrierCount, "JSR carrier count"],
    ]) {
      if (declared !== undefined && declared !== observed) {
        throw error(`${context} disagrees with the exact normal publication plan`);
      }
    }
  } else if (reconciledCarrierIds !== undefined || completedOperationIds !== undefined) {
    throw error("reconciled carrier and completed operation IDs require the exact normal publication plan");
  }
  const plannedMavenSeconds = exactMavenOperationCount * NORMAL_REGISTRY_MAVEN_OPERATION_SECONDS;
  const plannedJsrSeconds = exactJsrCarrierCount * NORMAL_REGISTRY_JSR_SECONDS_PER_CARRIER;
  if (exactReconciledCargoCount > publishedCargoCount || exactReconciledNpmCount > publishedNpmCount) {
    throw error("ledger-reconciled carrier counts cannot exceed published registry inventory");
  }
  publicReconciliationCount ??= (publishedCargoCount - exactReconciledCargoCount)
    + (publishedNpmCount - exactReconciledNpmCount);
  const plannedReconciliationSeconds = publicReconciliationCount
    * NORMAL_REGISTRY_RECONCILIATION_SECONDS_PER_CARRIER;
  if (plannedExecutorCriticalPathSeconds === undefined) {
    const cargoLaneSeconds = tokenBucket.elapsedSeconds
      + ((publishedCargoCount - exactReconciledCargoCount) * NORMAL_REGISTRY_RECONCILIATION_SECONDS_PER_CARRIER);
    const npmLaneSeconds = plannedNpmPublicationSeconds
      + ((publishedNpmCount - exactReconciledNpmCount) * NORMAL_REGISTRY_RECONCILIATION_SECONDS_PER_CARRIER);
    plannedExecutorCriticalPathSeconds = Math.max(
      cargoLaneSeconds,
      npmLaneSeconds,
      plannedMavenSeconds,
      plannedJsrSeconds,
    );
    fullRemainingCriticalPathSeconds = plannedExecutorCriticalPathSeconds;
    fullRemainingWindowSeconds = requiredNormalPublicationWindow(plannedExecutorCriticalPathSeconds);
    requiredWindowSeconds = fullRemainingWindowSeconds;
  }
  const checkpointAlreadyComplete = normalPlan !== undefined
    && canonicalCompletedIds.length === normalPlan.operations.length;
  const plannedExecutorSeconds = checkpointAlreadyComplete
    ? 0
    : plannedExecutorCriticalPathSeconds + NORMAL_REGISTRY_EXECUTOR_RESERVE_SECONDS;
  requiredWindowSeconds ??= Math.max(MINIMUM_MUTATION_WINDOW_SECONDS, plannedExecutorSeconds);
  const namesSatisfied = inventory.missingNames.length === 0 && npmInventory.missingNames.length === 0;
  const remainingOperationCount = admittedOperationIds.length + unadmittedOperationIds.length;
  const hasAdmittedProgress = admittedOperationIds.length > 0;
  const noRemainingOperations = normalPlan !== undefined && remainingOperationCount === 0;
  const timeSatisfied = remainingSeconds >= requiredWindowSeconds
    && (normalPlan === undefined || hasAdmittedProgress || noRemainingOperations);
  const decision = namesSatisfied && timeSatisfied ? "execute" : "defer";
  return {
    selectedCount: inventory.selectedIdentities.length,
    publishedCount: inventory.publishedIdentities.length,
    pendingCount,
    pendingVersions: inventory.pendingVersions,
    missingNames: inventory.missingNames,
    selectedNpmCount: npmInventory.selectedIdentities.length,
    publishedNpmCount,
    pendingNpmCount,
    missingNpmNames: npmInventory.missingNames,
    mavenOperationCount: exactMavenOperationCount,
    jsrCarrierCount: exactJsrCarrierCount,
    reconciledCargoCount: exactReconciledCargoCount,
    reconciledNpmCount: exactReconciledNpmCount,
    publicReconciliationCount,
    initialCargoTokens,
    tokenBucketPublicationSeconds: tokenBucket.elapsedSeconds,
    tokenBucketWaitSeconds: tokenBucket.waitSeconds,
    defaultMinimumSeconds: tokenBucket.elapsedSeconds,
    authoritativeMutationWindowSeconds: exactAuthoritativeWindowSeconds,
    remainingSeconds,
    minimumMutationWindowSeconds: requiredWindowSeconds,
    planningHeadroomSeconds: Math.max(0, remainingSeconds - requiredWindowSeconds),
    plannedPublicationSeconds,
    plannedNpmPublicationSeconds,
    plannedMavenSeconds,
    plannedJsrSeconds,
    plannedReconciliationSeconds,
    plannedExecutorCriticalPathSeconds,
    plannedExecutorSeconds,
    fullRemainingCriticalPathSeconds,
    fullRemainingWindowSeconds,
    executorReserveSeconds: NORMAL_REGISTRY_EXECUTOR_RESERVE_SECONDS,
    reconciliationSecondsPerCarrier: NORMAL_REGISTRY_RECONCILIATION_SECONDS_PER_CARRIER,
    planningSecondsPerCarrier: CRATES_IO_TRUSTED_PUBLISH_PLANNING_SECONDS_PER_CARRIER,
    trustedTokenBatchSize: CRATES_IO_TRUSTED_TOKEN_DEFAULT_BATCH_SIZE,
    trustedTokenMaxBatchAgeMs: CRATES_IO_TRUSTED_TOKEN_MAX_BATCH_AGE_MS,
    completedOperationIds: canonicalCompletedIds,
    admittedOperationIds,
    unadmittedOperationIds,
    admittedOperationCount: admittedOperationIds.length,
    unadmittedOperationCount: unadmittedOperationIds.length,
    remainingOperationCount,
    admittedCargoOperationCount: admittedOperationIds.filter((id) => id.startsWith("carrier:cargo:")).length,
    admittedNpmOperationCount: admittedOperationIds.filter((id) => id.startsWith("carrier:npm:")).length,
    publicationCompleteAfterAdmission,
    namesSatisfied,
    timeSatisfied,
    decision,
    notBeforeEpochSeconds: decision === "defer" && namesSatisfied
      ? nowEpochSeconds + CRATES_IO_VERSION_REFILL_SECONDS
      : null,
    allowed: decision === "execute",
  };
}

function durationText(seconds) {
  const minutes = Math.ceil(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return hours === 0 ? `${minutes}m` : `${hours}h ${remainder}m`;
}

export function cratesIoCapacitySummary(assessment) {
  return [
    "### Cargo/npm bootstrap token-bucket admission",
    "",
    `- Exact-lock Cargo names selected: ${assessment.selectedCount}`,
    `- Names already present on crates.io: ${assessment.existingCount}`,
    `- Brand-new names still missing: ${assessment.missingCount}`,
    `- Cargo versions already public: ${assessment.publishedCargoCount}`,
    `- Existing Cargo names with a different locked version pending (forbidden): ${assessment.cargoConflictCount}`,
    `- Brand-new Cargo names still requiring their first version: ${assessment.pendingCargoCount}`,
    `- Exact-lock npm versions selected: ${assessment.selectedNpmCount}`,
    `- npm versions already public: ${assessment.publishedNpmCount}`,
    `- Existing npm names with a different locked version pending (forbidden): ${assessment.npmConflictCount}`,
    `- Brand-new npm names still requiring their first version: ${assessment.pendingNpmCount}`,
    `- Conservatively available Cargo tokens at invocation start: ${assessment.initialCargoTokens}`,
    `- Official token-bucket time for every pending Cargo identity: ${durationText(assessment.tokenBucketPublicationSeconds)} (${durationText(assessment.tokenBucketWaitSeconds)} waiting, with publication work overlapping refill)`,
    `- Aggregate carrier publication work: ${durationText(assessment.plannedPublicationSeconds)} (${assessment.cargoSecondsPerCarrier}s/Cargo + ${assessment.npmSecondsPerCarrier}s/npm)`,
    `- Cargo/npm lane + dependency-DAG critical path: ${durationText(assessment.plannedPublicationCriticalPathSeconds)}`,
    `- Planned public-version reconciliation time: ${durationText(assessment.plannedReconciliationSeconds)} (${assessment.reconciliationSecondsPerCarrier}s across ${assessment.reconciliationCount} carriers)`,
    `- Non-publication reserve: ${durationText(assessment.reserveSeconds)}`,
    `- Admission-model mutation window: ${durationText(assessment.minimumMutationWindowSeconds)}`,
    `- Remaining bounded mutation window: ${durationText(Math.max(0, assessment.remainingSeconds))}`,
    `- Additional planning headroom: ${durationText(assessment.planningHeadroomSeconds)}`,
    `- Dependency-closed carriers admitted for this invocation: ${assessment.admittedCount} (${assessment.admittedCargoCount} Cargo, ${assessment.admittedNpmCount} npm)`,
    `- Carriers remaining after the admitted invocation: ${assessment.remainingMutationCount}`,
    "- Model boundary: timing is a calibrated admission estimate, not an upper bound on external registry latency; the hard deadline and exact-lock checkpoint recovery remain authoritative.",
    `- Decision: ${assessment.decision.toUpperCase()}`,
    "",
  ].join("\n");
}

export function cratesIoVersionCapacitySummary(assessment) {
  return [
    "### Normal all-registry token-bucket admission",
    "",
    `- Exact-lock Cargo versions selected: ${assessment.selectedCount}`,
    `- Versions already present on crates.io: ${assessment.publishedCount}`,
    `- Existing names with versions still pending: ${assessment.pendingCount}`,
    `- Brand-new names incorrectly reaching normal publish: ${assessment.missingNames.length}`,
    `- Exact-lock npm versions selected/already public/pending: ${assessment.selectedNpmCount}/${assessment.publishedNpmCount}/${assessment.pendingNpmCount}`,
    `- Brand-new npm names incorrectly reaching normal publish: ${assessment.missingNpmNames.length}`,
    `- Maven atomic deployments budgeted: ${assessment.mavenOperationCount}`,
    `- JSR carriers budgeted: ${assessment.jsrCarrierCount}`,
    `- Public Cargo/npm carriers covered by the verified bootstrap ledger: ${assessment.reconciledCargoCount + assessment.reconciledNpmCount}`,
    `- Public Cargo/npm carriers still requiring executor reconciliation: ${assessment.publicReconciliationCount}`,
    `- Conservatively available Cargo tokens at invocation start: ${assessment.initialCargoTokens}`,
    `- Official token-bucket Cargo time: ${durationText(assessment.tokenBucketPublicationSeconds)} (${durationText(assessment.tokenBucketWaitSeconds)} waiting, with publication work overlapping refill)`,
    `- Trusted-token batches: at most ${assessment.trustedTokenBatchSize} carriers or ${durationText(assessment.trustedTokenMaxBatchAgeMs / 1000)} old`,
    `- Pending Cargo publication budget: ${durationText(assessment.plannedPublicationSeconds)} (${assessment.planningSecondsPerCarrier}s per carrier)`,
    `- Pending npm publication budget: ${durationText(assessment.plannedNpmPublicationSeconds)} (${NORMAL_REGISTRY_NPM_SECONDS_PER_CARRIER}s per carrier)`,
    `- Maven/JSR operation budget: ${durationText(assessment.plannedMavenSeconds + assessment.plannedJsrSeconds)}`,
    `- Public-version reconciliation budget: ${durationText(assessment.plannedReconciliationSeconds)} (${assessment.reconciliationSecondsPerCarrier}s per uncovered carrier)`,
    `- Complete remaining-plan parallel lane/DAG critical path: ${durationText(assessment.fullRemainingCriticalPathSeconds)}`,
    `- Admitted-subset parallel lane/DAG critical path: ${durationText(assessment.plannedExecutorCriticalPathSeconds)}`,
    `- Executor contingency reserve: ${durationText(assessment.executorReserveSeconds)}`,
    `- Authoritative fresh mutation window: ${durationText(assessment.authoritativeMutationWindowSeconds)}`,
    `- Admitted-subset required mutation window: ${durationText(assessment.minimumMutationWindowSeconds)}`,
    `- Remaining bounded mutation window: ${durationText(Math.max(0, assessment.remainingSeconds))}`,
    `- Additional planning headroom: ${durationText(assessment.planningHeadroomSeconds)}`,
    `- Checkpoint-complete operations: ${assessment.completedOperationIds.length}`,
    `- Operations admitted for this invocation: ${assessment.admittedOperationCount} (${assessment.admittedCargoOperationCount} Cargo, ${assessment.admittedNpmOperationCount} npm)`,
    `- Operations reserved for exact-parent continuation: ${assessment.unadmittedOperationCount}`,
    `- Complete after admitted invocation: ${assessment.publicationCompleteAfterAdmission ? "yes" : "no"}`,
    "- Model boundary: timing is a calibrated admission estimate, not an upper bound on external registry latency; matching partial mutations are recovered from immutable registry bytes on an exact-lock rerun.",
    `- Decision: ${assessment.decision.toUpperCase()}`,
    "",
  ].join("\n");
}

export function assertCratesIoBootstrapCapacity(assessment) {
  if (!assessment.identityCreationOnlySatisfied) {
    throw error(
      `identity bootstrap is first-version creation only, but ${assessment.cargoConflictCount} Cargo and `
        + `${assessment.npmConflictCount} npm package name(s) already exist without the locked exact version; `
        + "publish later versions only through the normal trusted release path",
    );
  }
}

export function assertCratesIoVersionCapacity(assessment) {
  if (!assessment.namesSatisfied) {
    const missing = [
      ...assessment.missingNames.map((name) => `cargo:${name}`),
      ...assessment.missingNpmNames.map((name) => `npm:${name}`),
    ];
    const names = missing.slice(0, 8).join(", ");
    const omitted = Math.max(0, missing.length - 8);
    throw error(
      `normal trusted publication cannot create ${missing.length} missing Cargo/npm name(s): ${names}`
        + `${omitted > 0 ? `, and ${omitted} more` : ""}; run the protected identity bootstrap first`,
    );
  }
}
