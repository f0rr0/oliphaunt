const REASONS = new Set(["deadline", "rate-limit"]);
const RECORD_KEYS = ["context", "notBeforeEpochSeconds", "reason", "schema"];

export const REGISTRY_PUBLICATION_DEFERRAL_SCHEMA = "oliphaunt-registry-publication-deferral-v1";
export const REGISTRY_PUBLICATION_DEFERRAL_PREFIX = "OLIPHAUNT_REGISTRY_PUBLICATION_DEFERRED=";
export const REGISTRY_PUBLICATION_DEFERRAL_EXIT_CODE = 75;

function error(message) {
  return new Error(`registry-publication-deferral: ${message}`);
}

/**
 * Narrow, dependency-neutral control-flow signal for a known-safe registry
 * continuation. Callers may construct it only before any mutation request
 * starts, or after an explicit HTTP 429 proves that a registry rejected the
 * mutation without accepting its payload.
 */
export class RegistryPublicationDeferredError extends Error {
  constructor({ reason, notBeforeEpochSeconds, context }) {
    if (!REASONS.has(reason)) {
      throw error(`reason must be one of ${[...REASONS].join(", ")}`);
    }
    if (!Number.isSafeInteger(notBeforeEpochSeconds) || notBeforeEpochSeconds <= 0) {
      throw error("notBeforeEpochSeconds must be a positive Unix timestamp");
    }
    if (typeof context !== "string" || context.length === 0) {
      throw error("context must be a non-empty string");
    }
    super(`registry publication deferred (${reason}) until ${notBeforeEpochSeconds}: ${context}`);
    this.name = "RegistryPublicationDeferredError";
    this.code = "OLIPHAUNT_REGISTRY_PUBLICATION_DEFERRED";
    this.reason = reason;
    this.notBeforeEpochSeconds = notBeforeEpochSeconds;
    this.context = context;
  }
}

export function isRegistryPublicationDeferredError(cause) {
  return cause instanceof RegistryPublicationDeferredError;
}

/**
 * Admit an operation immediately before its first remote mutation. A caller
 * must not use this helper after an upload or state-changing request starts:
 * at that point deadline exhaustion is ambiguous and must remain terminal
 * until exact remote state has been reconciled.
 */
export function requirePreMutationRegistryWindow({
  deadlineEpochSeconds,
  minimumMilliseconds,
  context,
  reserveMilliseconds = 0,
  nowEpochMilliseconds = Date.now(),
}) {
  if (
    !Number.isSafeInteger(deadlineEpochSeconds)
    || deadlineEpochSeconds < 1
    || deadlineEpochSeconds > Math.floor(Number.MAX_SAFE_INTEGER / 1000)
  ) {
    throw error("deadlineEpochSeconds must be a positive safe Unix timestamp");
  }
  for (const [value, label] of [
    [minimumMilliseconds, "minimumMilliseconds"],
    [reserveMilliseconds, "reserveMilliseconds"],
    [nowEpochMilliseconds, "nowEpochMilliseconds"],
  ]) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw error(`${label} must be a non-negative safe integer`);
    }
  }
  if (minimumMilliseconds < 1) {
    throw error("minimumMilliseconds must be positive");
  }
  if (typeof context !== "string" || context.length === 0) {
    throw error("pre-mutation window context must be a non-empty string");
  }
  const availableMilliseconds = (deadlineEpochSeconds * 1000)
    - nowEpochMilliseconds
    - reserveMilliseconds;
  if (availableMilliseconds < minimumMilliseconds) {
    throw new RegistryPublicationDeferredError({
      reason: "deadline",
      notBeforeEpochSeconds: Math.floor(nowEpochMilliseconds / 1000) + 1,
      context: `${context} requires ${Math.ceil(minimumMilliseconds / 1000)}s before its first remote mutation; `
        + `${Math.max(0, Math.floor(availableMilliseconds / 1000))}s remain`,
    });
  }
  return availableMilliseconds;
}

export function encodeRegistryPublicationDeferral(cause) {
  if (!isRegistryPublicationDeferredError(cause)) {
    throw error("only a RegistryPublicationDeferredError can cross the safe child-process boundary");
  }
  const record = {
    schema: REGISTRY_PUBLICATION_DEFERRAL_SCHEMA,
    reason: cause.reason,
    notBeforeEpochSeconds: cause.notBeforeEpochSeconds,
    context: cause.context,
  };
  return `${REGISTRY_PUBLICATION_DEFERRAL_PREFIX}${Buffer.from(JSON.stringify(record), "utf8").toString("base64url")}`;
}

export function decodeRegistryPublicationDeferral(stderrTail) {
  if (typeof stderrTail !== "string") throw error("child stderr tail must be a string");
  const encoded = stderrTail
    .split(/\r?\n/u)
    .filter((line) => line.startsWith(REGISTRY_PUBLICATION_DEFERRAL_PREFIX))
    .map((line) => line.slice(REGISTRY_PUBLICATION_DEFERRAL_PREFIX.length));
  if (encoded.length !== 1 || !/^[A-Za-z0-9_-]+$/u.test(encoded[0])) {
    throw error("safe-deferral exit requires exactly one canonical typed deferral record");
  }
  const bytes = Buffer.from(encoded[0], "base64url");
  if (bytes.toString("base64url") !== encoded[0]) {
    throw error("typed deferral record is not canonical base64url");
  }
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch (cause) {
    throw error(`typed deferral record is not strict JSON: ${cause.message}`);
  }
  if (
    value === null
    || Array.isArray(value)
    || typeof value !== "object"
    || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(RECORD_KEYS)
  ) {
    throw error(`typed deferral record keys must be exactly ${RECORD_KEYS.join(", ")}`);
  }
  if (value.schema !== REGISTRY_PUBLICATION_DEFERRAL_SCHEMA) {
    throw error(`typed deferral record schema must be ${REGISTRY_PUBLICATION_DEFERRAL_SCHEMA}`);
  }
  return new RegistryPublicationDeferredError({
    reason: value.reason,
    notBeforeEpochSeconds: value.notBeforeEpochSeconds,
    context: value.context,
  });
}
