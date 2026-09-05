const SCHEMA = "oliphaunt-bootstrap-execution-result-v1";
const SHA = /^[0-9a-f]{40,64}$/u;
const DIGEST = /^[0-9a-f]{64}$/u;

function error(message) {
  return new Error(`bootstrap-execution-result: ${message}`);
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function exactKeys(value, keys, context) {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw error(`${context} must be an object`);
  }
  if (stable(Object.keys(value).sort()) !== stable([...keys].sort())) {
    throw error(`${context} keys must be exactly ${[...keys].sort().join(", ")}`);
  }
}

function uniqueStrings(value, context, { ordered = false, nonempty = false } = {}) {
  if (
    !Array.isArray(value)
    || (nonempty && value.length === 0)
    || value.some((item) => typeof item !== "string" || item.length === 0)
    || new Set(value).size !== value.length
    || (!ordered && stable(value) !== stable([...value].sort()))
  ) {
    throw error(`${context} must be a ${nonempty ? "nonempty " : ""}unique string list`);
  }
  return [...value];
}

export function validateBootstrapExecutionResult(value, expected = {}) {
  exactKeys(value, [
    "admittedIds", "completedIds", "decision", "deferralMode", "lock", "newlyCompletedIds",
    "notBeforeEpochSeconds", "operation", "products", "remainingIds", "schema", "source",
  ], "execution result");
  if (value.schema !== SCHEMA || value.operation !== "publish-bootstrap") {
    throw error("execution result schema or operation is invalid");
  }
  if (!new Set(["complete", "deferred"]).has(value.decision)) {
    throw error("execution result decision must be complete or deferred");
  }
  exactKeys(value.source, ["commit", "tree"], "execution result source");
  if (!SHA.test(value.source.commit) || !SHA.test(value.source.tree)) {
    throw error("execution result source must contain lowercase Git object IDs");
  }
  exactKeys(value.lock, ["catalogDigest", "lockDigest", "packageEnvelopeDigest"], "execution result lock");
  if (Object.values(value.lock).some((digest) => typeof digest !== "string" || !DIGEST.test(digest))) {
    throw error("execution result lock must contain lowercase SHA-256 digests");
  }
  const normalized = {
    ...value,
    products: uniqueStrings(value.products, "execution result products", { nonempty: true }),
    admittedIds: uniqueStrings(value.admittedIds, "execution result admittedIds", { ordered: true }),
    completedIds: uniqueStrings(value.completedIds, "execution result completedIds", { ordered: true }),
    newlyCompletedIds: uniqueStrings(value.newlyCompletedIds, "execution result newlyCompletedIds", { ordered: true }),
    remainingIds: uniqueStrings(value.remainingIds, "execution result remainingIds", { ordered: true }),
  };
  const completed = new Set(normalized.completedIds);
  const remaining = new Set(normalized.remainingIds);
  const plan = new Set([...completed, ...remaining]);
  if (normalized.admittedIds.some((id) => !plan.has(id))) {
    throw error("execution result admittedIds must be a projection of completedIds and remainingIds");
  }
  if (normalized.newlyCompletedIds.some((id) => !completed.has(id) || !normalized.admittedIds.includes(id))) {
    throw error("execution result newlyCompletedIds must be a subset of completedIds and admittedIds");
  }
  if (normalized.completedIds.some((id) => remaining.has(id))) {
    throw error("execution result completedIds and remainingIds must be disjoint");
  }
  if (normalized.decision === "complete") {
    if (normalized.deferralMode !== null || remaining.size !== 0 || normalized.notBeforeEpochSeconds !== null) {
      throw error("complete execution result must have no deferral mode, remaining IDs, or not-before time");
    }
  } else {
    if (remaining.size === 0 || !Number.isSafeInteger(normalized.notBeforeEpochSeconds) || normalized.notBeforeEpochSeconds < 1) {
      throw error("deferred execution result requires remaining work and a positive not-before time");
    }
    const zeroProgress = normalized.newlyCompletedIds.length === 0;
    if (normalized.deferralMode === "progress" && zeroProgress) {
      throw error("progress deferral requires nonzero newly completed IDs");
    }
    if (normalized.deferralMode === "pre-mutation-capacity" && (!zeroProgress || normalized.admittedIds.length !== 0)) {
      throw error("pre-mutation capacity deferral must admit and mutate zero bootstrap operations");
    }
    if (normalized.deferralMode === "rate-limit" && (!zeroProgress || !normalized.admittedIds.some((id) => remaining.has(id) && /^(?:carrier:)?cargo:/u.test(id)))) {
      throw error("rate-limit deferral requires admitted remaining Cargo work and no new completion");
    }
    if (normalized.deferralMode === "pre-mutation-deadline" && (!zeroProgress || !normalized.admittedIds.some((id) => remaining.has(id)))) {
      throw error("pre-mutation deadline deferral requires admitted remaining work and no new completion");
    }
    if (!["progress", "pre-mutation-capacity", "rate-limit", "pre-mutation-deadline"].includes(normalized.deferralMode)) {
      throw error("deferred execution result requires an explicit supported deferral mode");
    }
  }
  for (const [key, actual] of [["releaseCommit", normalized.source.commit], ["releaseTree", normalized.source.tree]]) {
    if (expected[key] !== undefined && String(actual) !== String(expected[key])) {
      throw error(`execution result ${key} does not match the bootstrap context`);
    }
  }
  if (expected.lock !== undefined && stable(normalized.lock) !== stable(expected.lock)) {
    throw error("execution result lock does not match the bootstrap context");
  }
  if (expected.products !== undefined && stable(normalized.products) !== stable(expected.products)) {
    throw error("execution result products do not match the bootstrap context");
  }
  return normalized;
}
