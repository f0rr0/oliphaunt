import { createHash } from "node:crypto";
import {
  lstatSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import path from "node:path";

export const RELEASE_CONTINUATION_CONTRACT_SCHEMA = "oliphaunt-release-continuation-contract-v1";
export const RELEASE_CONTINUATION_POINTER_SCHEMA = "oliphaunt-release-continuation-pointer-v1";
// This is a parser/resource ceiling, not the release's continuation bound.
// Each root contract freezes a tighter exact-plan-derived maxGenerations, and
// nonzero progress makes that many generations sufficient even at one newly
// completed immutable operation per run.
export const RELEASE_CONTINUATION_GENERATION_CEILING = 4096;
export const RELEASE_CONTINUATION_MAX_DISPATCH_DELAY_SECONDS = 15 * 60;
export const RELEASE_CONTINUATION_RATE_LIMIT_DEFERRAL_BUDGET = 3;
export const RELEASE_CONTINUATION_DEADLINE_DEFERRAL_BUDGET = 1;

const SHA256 = /^[0-9a-f]{64}$/u;
const GIT_OBJECT = /^[0-9a-f]{40,64}$/u;
const CHECKPOINT = /^checkpoint-[0-9]{6}-[0-9a-f]{64}[.]json$/u;
const OPERATIONS = new Set(["publish-bootstrap", "publish"]);
const EXECUTION_RESULT_SCHEMAS = new Map([
  ["publish-bootstrap", "oliphaunt-bootstrap-execution-result-v1"],
  ["publish", "oliphaunt-normal-publication-execution-result-v1"],
]);

function error(message) {
  return new Error(`release-continuation-contract: ${message}`);
}

function compareText(left, right) {
  const renderedLeft = String(left);
  const renderedRight = String(right);
  return renderedLeft < renderedRight ? -1 : renderedLeft > renderedRight ? 1 : 0;
}

export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort(compareText).map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function sha256File(file) {
  const metadata = lstatSync(file);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw error(`${file} must be a regular non-symlink file`);
  }
  return sha256Bytes(readFileSync(file));
}

function object(value, context) {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw error(`${context} must be an object`);
  }
  return value;
}

function exactKeys(value, keys, context) {
  object(value, context);
  const actual = Object.keys(value).sort(compareText);
  const expected = [...keys].sort(compareText);
  if (stableJson(actual) !== stableJson(expected)) {
    throw error(`${context} keys must be exactly ${expected.join(", ")}`);
  }
}

function safeInteger(value, context, { minimum = 0 } = {}) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw error(`${context} must be a safe integer >= ${minimum}`);
  }
  return value;
}

function positiveInteger(value, context) {
  return safeInteger(value, context, { minimum: 1 });
}

function uniqueStrings(value, context, { allowEmpty = true, canonical = true } = {}) {
  if (
    !Array.isArray(value)
    || (!allowEmpty && value.length === 0)
    || value.some((item) => typeof item !== "string" || item.length === 0)
    || new Set(value).size !== value.length
  ) {
    throw error(`${context} must be a ${allowEmpty ? "" : "nonempty "}unique string list`);
  }
  if (canonical && stableJson(value) !== stableJson([...value].sort(compareText))) {
    throw error(`${context} must be in canonical lexical order`);
  }
  return [...value];
}

function orderedUniqueStrings(value, context, { allowEmpty = true } = {}) {
  return uniqueStrings(value, context, { allowEmpty, canonical: false });
}

function operation(value) {
  if (!OPERATIONS.has(value)) throw error(`unsupported continuation operation ${JSON.stringify(value)}`);
  return value;
}

function source(value, context = "source") {
  exactKeys(value, ["commit", "tree"], context);
  for (const key of ["commit", "tree"]) {
    if (typeof value[key] !== "string" || !GIT_OBJECT.test(value[key])) {
      throw error(`${context}.${key} must be a lowercase Git object id`);
    }
  }
  return { commit: value.commit, tree: value.tree };
}

function lockBinding(value, context = "lock") {
  exactKeys(value, ["catalogDigest", "lockDigest", "packageEnvelopeDigest"], context);
  for (const key of ["catalogDigest", "lockDigest", "packageEnvelopeDigest"]) {
    if (typeof value[key] !== "string" || !SHA256.test(value[key])) {
      throw error(`${context}.${key} must be a lowercase SHA-256 digest`);
    }
  }
  return {
    catalogDigest: value.catalogDigest,
    lockDigest: value.lockDigest,
    packageEnvelopeDigest: value.packageEnvelopeDigest,
  };
}

export function normalizeArtifactIdentity(value, context = "artifact") {
  exactKeys(value, ["digest", "id", "name", "size"], context);
  const id = positiveInteger(value.id, `${context}.id`);
  const size = positiveInteger(value.size, `${context}.size`);
  if (typeof value.name !== "string" || value.name.length === 0 || /[\u0000-\u001f\u007f]/u.test(value.name)) {
    throw error(`${context}.name must be a nonempty printable string`);
  }
  if (typeof value.digest !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(value.digest)) {
    throw error(`${context}.digest must be an immutable sha256: digest`);
  }
  return { digest: value.digest, id, name: value.name, size };
}

function approvedPublication(value) {
  exactKeys(value, ["artifacts", "runId"], "approvedPublication");
  const runId = positiveInteger(value.runId, "approvedPublication.runId");
  if (!Array.isArray(value.artifacts) || value.artifacts.length !== 2) {
    throw error("approvedPublication.artifacts must contain the exact lock and capsule identities");
  }
  const artifacts = value.artifacts.map((row, index) => normalizeArtifactIdentity(
    row,
    `approvedPublication.artifacts[${index}]`,
  )).sort((left, right) => compareText(left.name, right.name));
  if (new Set(artifacts.map(({ name }) => name)).size !== artifacts.length) {
    throw error("approvedPublication.artifacts repeats an artifact name");
  }
  if (stableJson(artifacts.map(({ name }) => name)) !== stableJson([
    "oliphaunt-bootstrap-capsule",
    "oliphaunt-publication-lock",
  ])) {
    throw error("approvedPublication.artifacts must be the frozen lock and bootstrap capsule");
  }
  return { artifacts, runId };
}

function stageHandoff(value, expectedOperation) {
  if (expectedOperation === "publish-bootstrap") {
    if (value !== null) throw error("bootstrap continuation must not contain a GitHub-stage handoff");
    return null;
  }
  exactKeys(value, ["artifact", "runId"], "stageHandoff");
  const runId = positiveInteger(value.runId, "stageHandoff.runId");
  const artifact = normalizeArtifactIdentity(value.artifact, "stageHandoff.artifact");
  if (!artifact.name.startsWith("github-stage-handoff-")) {
    throw error("stageHandoff.artifact must be an immutable GitHub-stage handoff");
  }
  return { artifact, runId };
}

function lineage(value) {
  exactKeys(
    value,
    [
      "capacityDeferralAllowance",
      "deadlineDeferralBudget",
      "deadlineDeferralsUsed",
      "generation",
      "maxGenerations",
      "parentRunAttempt",
      "parentRunId",
      "rateLimitDeferralBudget",
      "rateLimitDeferralsUsed",
      "rootRunId",
    ],
    "lineage",
  );
  if (typeof value.capacityDeferralAllowance !== "boolean") {
    throw error("lineage.capacityDeferralAllowance must be a boolean");
  }
  const normalized = {
    capacityDeferralAllowance: value.capacityDeferralAllowance,
    deadlineDeferralBudget: positiveInteger(
      value.deadlineDeferralBudget,
      "lineage.deadlineDeferralBudget",
    ),
    deadlineDeferralsUsed: safeInteger(
      value.deadlineDeferralsUsed,
      "lineage.deadlineDeferralsUsed",
    ),
    generation: positiveInteger(value.generation, "lineage.generation"),
    maxGenerations: positiveInteger(value.maxGenerations, "lineage.maxGenerations"),
    parentRunAttempt: positiveInteger(value.parentRunAttempt, "lineage.parentRunAttempt"),
    parentRunId: positiveInteger(value.parentRunId, "lineage.parentRunId"),
    rateLimitDeferralBudget: positiveInteger(
      value.rateLimitDeferralBudget,
      "lineage.rateLimitDeferralBudget",
    ),
    rateLimitDeferralsUsed: safeInteger(
      value.rateLimitDeferralsUsed,
      "lineage.rateLimitDeferralsUsed",
    ),
    rootRunId: positiveInteger(value.rootRunId, "lineage.rootRunId"),
  };
  if (
    normalized.deadlineDeferralBudget !== RELEASE_CONTINUATION_DEADLINE_DEFERRAL_BUDGET
    || normalized.deadlineDeferralsUsed > normalized.deadlineDeferralBudget
  ) {
    throw error(
      `lineage deadline deferrals must stay within the frozen `
        + `${RELEASE_CONTINUATION_DEADLINE_DEFERRAL_BUDGET}-generation budget`,
    );
  }
  if (
    normalized.rateLimitDeferralBudget !== RELEASE_CONTINUATION_RATE_LIMIT_DEFERRAL_BUDGET
    || normalized.rateLimitDeferralsUsed > normalized.rateLimitDeferralBudget
  ) {
    throw error(
      `lineage rate-limit deferrals must stay within the frozen `
        + `${RELEASE_CONTINUATION_RATE_LIMIT_DEFERRAL_BUDGET}-generation budget`,
    );
  }
  if (
    normalized.maxGenerations > RELEASE_CONTINUATION_GENERATION_CEILING
    || normalized.generation > normalized.maxGenerations
  ) {
    throw error(
      `continuation generation must be within its exact-plan bound and the `
      + `${RELEASE_CONTINUATION_GENERATION_CEILING}-generation parser ceiling`,
    );
  }
  if (normalized.generation === 1 && normalized.rootRunId !== normalized.parentRunId) {
    throw error("generation one must bind the root run as its parent");
  }
  return normalized;
}

function outcome(value) {
  exactKeys(
    value,
    [
      "completedCount",
      "decision",
      "deferralMode",
      "executionResultDigest",
      "notBeforeEpochSeconds",
      "progressCount",
      "remainingCount",
      "stateDigest",
    ],
    "outcome",
  );
  if (value.decision !== "deferred") throw error("a continuation contract requires a deferred execution result");
  for (const key of ["executionResultDigest", "stateDigest"]) {
    if (typeof value[key] !== "string" || !SHA256.test(value[key])) {
      throw error(`outcome.${key} must be a lowercase SHA-256 digest`);
    }
  }
  const normalized = {
    completedCount: safeInteger(value.completedCount, "outcome.completedCount"),
    decision: value.decision,
    deferralMode: value.deferralMode,
    executionResultDigest: value.executionResultDigest,
    notBeforeEpochSeconds: positiveInteger(value.notBeforeEpochSeconds, "outcome.notBeforeEpochSeconds"),
    progressCount: safeInteger(value.progressCount, "outcome.progressCount"),
    remainingCount: positiveInteger(value.remainingCount, "outcome.remainingCount"),
    stateDigest: value.stateDigest,
  };
  if (normalized.progressCount > normalized.completedCount) {
    throw error("outcome.progressCount cannot exceed outcome.completedCount");
  }
  if (!new Set([
    "pre-mutation-capacity",
    "pre-mutation-deadline",
    "progress",
    "rate-limit",
  ]).has(normalized.deferralMode)) {
    throw error(
      "outcome.deferralMode must be pre-mutation-capacity, pre-mutation-deadline, progress, or rate-limit",
    );
  }
  if (
    (new Set([
      "pre-mutation-capacity",
      "pre-mutation-deadline",
      "rate-limit",
    ]).has(normalized.deferralMode)
      && normalized.progressCount !== 0)
    || (normalized.deferralMode === "progress" && normalized.progressCount < 1)
  ) {
    throw error("outcome progress must match its explicit deferral mode");
  }
  return normalized;
}

function state(value, expectedOperation) {
  exactKeys(value, ["digest", "entryCount", "kind"], "state");
  const expectedKind = expectedOperation === "publish-bootstrap"
    ? "bootstrap-ledger"
    : "normal-publication-checkpoint";
  if (value.kind !== expectedKind) throw error(`state.kind must be ${expectedKind}`);
  if (typeof value.digest !== "string" || !SHA256.test(value.digest)) {
    throw error("state.digest must be a lowercase SHA-256 digest");
  }
  const entryCount = positiveInteger(value.entryCount, "state.entryCount");
  if (expectedOperation === "publish" && entryCount !== 1) {
    throw error("normal-publication checkpoint state must contain exactly one entry");
  }
  return { digest: value.digest, entryCount, kind: value.kind };
}

function contractBase(value) {
  exactKeys(
    value,
    [
      "approvedPublication",
      "lineage",
      "lock",
      "operation",
      "outcome",
      "products",
      "schema",
      "source",
      "stageHandoff",
      "state",
    ],
    "continuation contract body",
  );
  if (value.schema !== RELEASE_CONTINUATION_CONTRACT_SCHEMA) {
    throw error(`contract schema must be ${RELEASE_CONTINUATION_CONTRACT_SCHEMA}`);
  }
  const normalizedOperation = operation(value.operation);
  const normalized = {
    approvedPublication: approvedPublication(value.approvedPublication),
    lineage: lineage(value.lineage),
    lock: lockBinding(value.lock),
    operation: normalizedOperation,
    outcome: outcome(value.outcome),
    products: uniqueStrings(value.products, "products", { allowEmpty: false }),
    schema: value.schema,
    source: source(value.source),
    stageHandoff: stageHandoff(value.stageHandoff, normalizedOperation),
    state: state(value.state, normalizedOperation),
  };
  if (
    normalized.operation === "publish"
    && normalized.stageHandoff.runId !== normalized.lineage.rootRunId
  ) {
    throw error("normal continuation stage handoff must belong to the exact root Release run");
  }
  if (normalized.outcome.deferralMode === "pre-mutation-capacity") {
    if (
      normalized.operation !== "publish"
      || normalized.lineage.generation !== 1
      || normalized.lineage.capacityDeferralAllowance !== true
    ) {
      throw error("pre-mutation capacity deferral is allowed only on a root normal-publication generation");
    }
  } else if (
    normalized.lineage.generation === 1
    && normalized.lineage.capacityDeferralAllowance
  ) {
    throw error("root capacity deferral allowance requires an explicit pre-mutation capacity outcome");
  }
  if (
    normalized.outcome.deferralMode === "rate-limit"
    && normalized.lineage.rateLimitDeferralsUsed < 1
  ) {
    throw error("rate-limit deferral must consume a finite lineage allowance");
  }
  if (
    normalized.outcome.deferralMode === "pre-mutation-deadline"
    && normalized.lineage.deadlineDeferralsUsed < 1
  ) {
    throw error("pre-mutation deadline deferral must consume its one-shot lineage allowance");
  }
  if (normalized.lineage.generation === 1) {
    const expectedRateLimitUse = normalized.outcome.deferralMode === "rate-limit" ? 1 : 0;
    const expectedDeadlineUse = normalized.outcome.deferralMode === "pre-mutation-deadline" ? 1 : 0;
    if (normalized.lineage.rateLimitDeferralsUsed !== expectedRateLimitUse) {
      throw error("root lineage rate-limit use must match its explicit outcome");
    }
    if (normalized.lineage.deadlineDeferralsUsed !== expectedDeadlineUse) {
      throw error("root lineage deadline use must match its explicit outcome");
    }
  }
  return normalized;
}

export function createReleaseContinuationContract(value) {
  const base = contractBase({
    schema: RELEASE_CONTINUATION_CONTRACT_SCHEMA,
    ...value,
  });
  return { ...base, contractDigest: sha256Bytes(stableJson(base)) };
}

export function validateReleaseContinuationContract(value, expected = {}) {
  exactKeys(
    value,
    [
      "approvedPublication",
      "contractDigest",
      "lineage",
      "lock",
      "operation",
      "outcome",
      "products",
      "schema",
      "source",
      "stageHandoff",
      "state",
    ],
    "continuation contract",
  );
  const { contractDigest, ...rawBase } = value;
  const base = contractBase(rawBase);
  const observed = sha256Bytes(stableJson(base));
  if (typeof contractDigest !== "string" || contractDigest !== observed) {
    throw error("continuation contract digest does not match its canonical body");
  }
  const normalized = { ...base, contractDigest };
  for (const [key, actual] of [
    ["operation", normalized.operation],
    ["releaseCommit", normalized.source.commit],
    ["releaseTree", normalized.source.tree],
    ["generation", normalized.lineage.generation],
    ["rootRunId", normalized.lineage.rootRunId],
    ["parentRunId", normalized.lineage.parentRunId],
    ["parentRunAttempt", normalized.lineage.parentRunAttempt],
  ]) {
    if (expected[key] !== undefined && String(actual) !== String(expected[key])) {
      throw error(`${key} does not match the continuation transport`);
    }
  }
  if (expected.contractDigest !== undefined && contractDigest !== expected.contractDigest) {
    throw error("contract digest does not match the continuation pointer");
  }
  return normalized;
}

export function createReleaseContinuationPointer({ contract, artifact }) {
  const normalizedContract = validateReleaseContinuationContract(contract);
  const body = {
    artifact: normalizeArtifactIdentity(artifact, "pointer.artifact"),
    capacityDeferralAllowance: normalizedContract.lineage.capacityDeferralAllowance,
    deadlineDeferralBudget: normalizedContract.lineage.deadlineDeferralBudget,
    deadlineDeferralsUsed: normalizedContract.lineage.deadlineDeferralsUsed,
    contractDigest: normalizedContract.contractDigest,
    generation: normalizedContract.lineage.generation,
    maxGenerations: normalizedContract.lineage.maxGenerations,
    operation: normalizedContract.operation,
    parentRunAttempt: normalizedContract.lineage.parentRunAttempt,
    parentRunId: normalizedContract.lineage.parentRunId,
    rateLimitDeferralBudget: normalizedContract.lineage.rateLimitDeferralBudget,
    rateLimitDeferralsUsed: normalizedContract.lineage.rateLimitDeferralsUsed,
    releaseCommit: normalizedContract.source.commit,
    rootRunId: normalizedContract.lineage.rootRunId,
    schema: RELEASE_CONTINUATION_POINTER_SCHEMA,
  };
  return { ...body, pointerDigest: sha256Bytes(stableJson(body)) };
}

export function validateReleaseContinuationPointer(value, expected = {}) {
  exactKeys(
    value,
    [
      "artifact",
      "capacityDeferralAllowance",
      "contractDigest",
      "deadlineDeferralBudget",
      "deadlineDeferralsUsed",
      "generation",
      "maxGenerations",
      "operation",
      "parentRunAttempt",
      "parentRunId",
      "pointerDigest",
      "rateLimitDeferralBudget",
      "rateLimitDeferralsUsed",
      "releaseCommit",
      "rootRunId",
      "schema",
    ],
    "continuation pointer",
  );
  if (value.schema !== RELEASE_CONTINUATION_POINTER_SCHEMA) {
    throw error(`pointer schema must be ${RELEASE_CONTINUATION_POINTER_SCHEMA}`);
  }
  const body = {
    artifact: normalizeArtifactIdentity(value.artifact, "pointer.artifact"),
    capacityDeferralAllowance: value.capacityDeferralAllowance,
    contractDigest: value.contractDigest,
    deadlineDeferralBudget: positiveInteger(
      value.deadlineDeferralBudget,
      "pointer.deadlineDeferralBudget",
    ),
    deadlineDeferralsUsed: safeInteger(
      value.deadlineDeferralsUsed,
      "pointer.deadlineDeferralsUsed",
    ),
    generation: positiveInteger(value.generation, "pointer.generation"),
    maxGenerations: positiveInteger(value.maxGenerations, "pointer.maxGenerations"),
    operation: operation(value.operation),
    parentRunAttempt: positiveInteger(value.parentRunAttempt, "pointer.parentRunAttempt"),
    parentRunId: positiveInteger(value.parentRunId, "pointer.parentRunId"),
    rateLimitDeferralBudget: positiveInteger(
      value.rateLimitDeferralBudget,
      "pointer.rateLimitDeferralBudget",
    ),
    rateLimitDeferralsUsed: safeInteger(
      value.rateLimitDeferralsUsed,
      "pointer.rateLimitDeferralsUsed",
    ),
    releaseCommit: value.releaseCommit,
    rootRunId: positiveInteger(value.rootRunId, "pointer.rootRunId"),
    schema: value.schema,
  };
  if (typeof body.capacityDeferralAllowance !== "boolean") {
    throw error("pointer.capacityDeferralAllowance must be a boolean");
  }
  if (
    body.deadlineDeferralBudget !== RELEASE_CONTINUATION_DEADLINE_DEFERRAL_BUDGET
    || body.deadlineDeferralsUsed > body.deadlineDeferralBudget
  ) {
    throw error("pointer deadline deferral use exceeds its frozen one-shot budget");
  }
  if (
    body.rateLimitDeferralBudget !== RELEASE_CONTINUATION_RATE_LIMIT_DEFERRAL_BUDGET
    || body.rateLimitDeferralsUsed > body.rateLimitDeferralBudget
  ) {
    throw error("pointer rate-limit deferral use exceeds its frozen finite budget");
  }
  if (!SHA256.test(body.contractDigest)) throw error("pointer.contractDigest must be a lowercase SHA-256 digest");
  if (typeof body.releaseCommit !== "string" || !GIT_OBJECT.test(body.releaseCommit)) {
    throw error("pointer.releaseCommit must be a lowercase Git object id");
  }
  if (
    body.generation > body.maxGenerations
    || body.maxGenerations > RELEASE_CONTINUATION_GENERATION_CEILING
  ) {
    throw error("pointer generation exceeds its exact-plan-derived bound");
  }
  const observed = sha256Bytes(stableJson(body));
  if (typeof value.pointerDigest !== "string" || value.pointerDigest !== observed) {
    throw error("continuation pointer digest does not match its canonical body");
  }
  const normalized = { ...body, pointerDigest: value.pointerDigest };
  for (const key of ["operation", "releaseCommit", "generation", "maxGenerations", "rootRunId", "parentRunId"] ) {
    if (expected[key] !== undefined && String(normalized[key]) !== String(expected[key])) {
      throw error(`pointer ${key} does not match the current dispatch`);
    }
  }
  return normalized;
}

export function continuationStateIdentity(operationName, statePath) {
  const normalizedOperation = operation(operationName);
  if (normalizedOperation === "publish") {
    return {
      digest: sha256File(statePath),
      entryCount: 1,
      kind: "normal-publication-checkpoint",
    };
  }
  const metadata = lstatSync(statePath);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw error(`${statePath} must be a regular bootstrap-ledger directory`);
  }
  const entries = readdirSync(statePath, { withFileTypes: true }).map((entry) => {
    if (!entry.isFile() || !CHECKPOINT.test(entry.name)) {
      throw error(`bootstrap ledger contains unexpected entry ${entry.name}`);
    }
    const file = path.join(statePath, entry.name);
    const fileMetadata = lstatSync(file);
    if (!fileMetadata.isFile() || fileMetadata.isSymbolicLink()) {
      throw error(`bootstrap ledger entry ${entry.name} must be a regular non-symlink file`);
    }
    return { name: entry.name, sha256: sha256File(file), size: fileMetadata.size };
  }).sort((left, right) => compareText(left.name, right.name));
  if (entries.length === 0) throw error("bootstrap ledger must contain at least one checkpoint");
  return {
    digest: sha256Bytes(stableJson(entries)),
    entryCount: entries.length,
    kind: "bootstrap-ledger",
  };
}

export function parseContinuationJson(raw, context = "RELEASE_CONTINUATION") {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  try {
    return JSON.parse(raw);
  } catch (cause) {
    throw error(`${context} must be strict JSON: ${cause.message}`);
  }
}

export function validateReleaseExecutionResult(value, expected = {}) {
  exactKeys(
    value,
    [
      "admittedIds",
      "completedIds",
      "decision",
      "deferralMode",
      "lock",
      "newlyCompletedIds",
      "notBeforeEpochSeconds",
      "operation",
      "products",
      "remainingIds",
      "schema",
      "source",
    ],
    "execution result",
  );
  const normalizedOperation = operation(value.operation);
  if (value.schema !== EXECUTION_RESULT_SCHEMAS.get(normalizedOperation)) {
    throw error(`execution result schema does not match ${normalizedOperation}`);
  }
  if (!new Set(["complete", "deferred"]).has(value.decision)) {
    throw error("execution result decision must be complete or deferred");
  }
  const normalized = {
    schema: value.schema,
    operation: normalizedOperation,
    decision: value.decision,
    deferralMode: value.deferralMode,
    source: source(value.source, "execution result source"),
    lock: lockBinding(value.lock, "execution result lock"),
    products: uniqueStrings(value.products, "execution result products", { allowEmpty: false }),
    admittedIds: orderedUniqueStrings(value.admittedIds, "execution result admittedIds"),
    completedIds: orderedUniqueStrings(value.completedIds, "execution result completedIds"),
    newlyCompletedIds: orderedUniqueStrings(value.newlyCompletedIds, "execution result newlyCompletedIds"),
    remainingIds: orderedUniqueStrings(value.remainingIds, "execution result remainingIds"),
    notBeforeEpochSeconds: value.notBeforeEpochSeconds,
  };
  const completed = new Set(normalized.completedIds);
  const remaining = new Set(normalized.remainingIds);
  const exactPlan = new Set([...normalized.completedIds, ...normalized.remainingIds]);
  if (normalized.admittedIds.some((id) => !exactPlan.has(id))) {
    throw error("execution result admittedIds must be a projection of completedIds and remainingIds");
  }
  if (normalized.newlyCompletedIds.some((id) => !completed.has(id))) {
    throw error("execution result newlyCompletedIds must be a subset of completedIds");
  }
  const admitted = new Set(normalized.admittedIds);
  if (normalized.newlyCompletedIds.some((id) => !admitted.has(id))) {
    throw error("execution result newlyCompletedIds must be a subset of admittedIds");
  }
  if (normalized.completedIds.some((id) => remaining.has(id))) {
    throw error("execution result completedIds and remainingIds must be disjoint");
  }
  if (normalized.decision === "complete") {
    if (
      normalized.deferralMode !== null
      || normalized.remainingIds.length !== 0
      || normalized.notBeforeEpochSeconds !== null
    ) {
      throw error("complete execution result must have no deferral mode, remaining IDs, or not-before time");
    }
  } else {
    if (
      normalized.remainingIds.length === 0
      || !Number.isSafeInteger(normalized.notBeforeEpochSeconds)
      || normalized.notBeforeEpochSeconds < 1
    ) {
      throw error("deferred execution result requires remaining work and a positive not-before time");
    }
    if (normalized.deferralMode === "progress") {
      if (normalized.newlyCompletedIds.length === 0) {
        throw error("progress deferral requires nonzero newly completed IDs");
      }
    } else if (normalized.deferralMode === "pre-mutation-capacity") {
      if (
        normalized.operation !== "publish"
        || normalized.admittedIds.length !== 0
        || normalized.newlyCompletedIds.length !== 0
      ) {
        throw error("pre-mutation capacity deferral must admit and mutate zero normal-publication operations");
      }
    } else if (normalized.deferralMode === "rate-limit") {
      const admittedRemainingCargo = normalized.admittedIds.some((id) =>
        remaining.has(id) && (/^cargo:/u.test(id) || /^carrier:cargo:/u.test(id)));
      if (normalized.newlyCompletedIds.length !== 0 || !admittedRemainingCargo) {
        throw error(
          "rate-limit zero-progress deferral requires an admitted remaining Cargo operation and no new completion",
        );
      }
    } else if (normalized.deferralMode === "pre-mutation-deadline") {
      if (
        normalized.newlyCompletedIds.length !== 0
        || !normalized.admittedIds.some((id) => remaining.has(id))
      ) {
        throw error(
          "pre-mutation deadline deferral requires admitted remaining work and no new completion",
        );
      }
    } else {
      throw error("deferred execution result requires an explicit supported deferral mode");
    }
  }
  for (const [key, actual] of [
    ["operation", normalized.operation],
    ["releaseCommit", normalized.source.commit],
    ["releaseTree", normalized.source.tree],
  ]) {
    if (expected[key] !== undefined && String(actual) !== String(expected[key])) {
      throw error(`execution result ${key} does not match the continuation context`);
    }
  }
  if (expected.lock !== undefined && stableJson(normalized.lock) !== stableJson(lockBinding(expected.lock, "expected lock"))) {
    throw error("execution result lock does not match the continuation context");
  }
  if (expected.products !== undefined && stableJson(normalized.products) !== stableJson(expected.products)) {
    throw error("execution result products do not match the continuation context");
  }
  return normalized;
}
