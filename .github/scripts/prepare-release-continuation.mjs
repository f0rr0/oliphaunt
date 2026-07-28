#!/usr/bin/env node
import {
  appendFileSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  RELEASE_CONTINUATION_GENERATION_CEILING,
  RELEASE_CONTINUATION_DEADLINE_DEFERRAL_BUDGET,
  RELEASE_CONTINUATION_MAX_DISPATCH_DELAY_SECONDS,
  RELEASE_CONTINUATION_RATE_LIMIT_DEFERRAL_BUDGET,
  continuationStateIdentity,
  createReleaseContinuationContract,
  normalizeArtifactIdentity,
  parseContinuationJson,
  sha256File,
  stableJson,
  validateReleaseContinuationPointer,
  validateReleaseExecutionResult,
} from "../../tools/release/release-continuation-contract.mjs";
import { bootstrapPublicationPlan } from "../../tools/release/bootstrap-publication-plan.mjs";
import { runGitHubReadSync } from "../../tools/release/github-read.mjs";
import {
  CONTINUATION_CORE_JOURNAL_MEMBER,
  CONTINUATION_PACER_MEMBER,
  continuationGitHubStateIdentity,
} from "../../tools/release/github-release-continuation-state.mjs";
import { normalPublicationPlan } from "../../tools/release/normal-publication-plan.mjs";
import {
  RELEASE_CONTINUATION_METADATA_READ_DEADLINE_MS,
} from "../../tools/release/release-continuation-read-budget.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_CONTRACT = "target/release/release-continuation-contract.json";

function error(message) {
  return new Error(`prepare-release-continuation: ${message}`);
}

function required(name, environment = process.env) {
  const value = environment[name]?.trim();
  if (!value) throw error(`${name} is required`);
  return value;
}

function safeInteger(value, context) {
  const rendered = String(value ?? "");
  if (!/^[1-9][0-9]*$/u.test(rendered) || !Number.isSafeInteger(Number(rendered))) {
    throw error(`${context} must be a positive safe integer`);
  }
  return Number(rendered);
}

function json(raw, context) {
  try { return JSON.parse(raw); } catch (cause) { throw error(`${context} must be strict JSON: ${cause.message}`); }
}

function sortedProducts(raw) {
  const value = json(raw, "PRODUCTS_JSON");
  if (
    !Array.isArray(value)
    || value.length === 0
    || value.some((item) => typeof item !== "string" || item.length === 0)
    || new Set(value).size !== value.length
  ) {
    throw error("PRODUCTS_JSON must be a nonempty unique string list");
  }
  return [...value].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
}

export function continuationPointerFromEnvironment(environment = process.env) {
  const raw = environment.RELEASE_CONTINUATION_POINTER?.trim() ?? "";
  if (raw.length > 32 * 1024) {
    throw error("RELEASE_CONTINUATION_POINTER exceeds 32 KiB");
  }
  return parseContinuationJson(raw, "RELEASE_CONTINUATION_POINTER");
}

function lockBinding(lock) {
  return {
    catalogDigest: lock.catalogDigest,
    lockDigest: lock.lockDigest,
    packageEnvelopeDigest: lock.packageEnvelopeDigest,
  };
}

function githubJson(environment, repo, endpoint, label, githubReadOptions = {}) {
  const raw = runGitHubReadSync(["api", "-H", "X-GitHub-Api-Version: 2022-11-28", `repos/${repo}/${endpoint}`], {
    ...githubReadOptions,
    cwd: ROOT,
    deadlineMs: RELEASE_CONTINUATION_METADATA_READ_DEADLINE_MS,
    environment,
    label,
    maxBuffer: 4 * 1024 * 1024,
  });
  return json(raw, label);
}

function exactStageArtifact(environment, { operation, releaseCommit }, githubReadOptions = {}) {
  if (operation === "publish-bootstrap") return null;
  const repo = required("GH_REPO", environment);
  const id = safeInteger(required("STAGE_HANDOFF_ARTIFACT_ID", environment), "STAGE_HANDOFF_ARTIFACT_ID");
  const expectedDigest = required("STAGE_HANDOFF_ARTIFACT_DIGEST", environment);
  const expectedName = required("STAGE_HANDOFF_ARTIFACT_NAME", environment);
  const runId = safeInteger(required("STAGE_HANDOFF_RUN_ID", environment), "STAGE_HANDOFF_RUN_ID");
  const metadata = githubJson(
    environment,
    repo,
    `actions/artifacts/${id}`,
    `GitHub-stage artifact ${id}`,
    githubReadOptions,
  );
  const artifact = normalizeArtifactIdentity({
    digest: metadata.digest,
    id: metadata.id,
    name: metadata.name,
    size: metadata.size_in_bytes,
  }, "GitHub-stage artifact metadata");
  if (
    artifact.id !== id
    || artifact.digest !== expectedDigest
    || artifact.name !== expectedName
    || metadata.expired !== false
  ) {
    throw error("GitHub-stage artifact metadata does not match the sealed stage handoff");
  }
  if (metadata.workflow_run?.id !== undefined && Number(metadata.workflow_run.id) !== runId) {
    throw error("GitHub-stage artifact is bound to the wrong root Release run");
  }
  const run = githubJson(
    environment,
    repo,
    `actions/runs/${runId}`,
    `GitHub-stage Release run ${runId}`,
    githubReadOptions,
  );
  if (
    Number(run.id) !== runId
    || run.head_sha !== releaseCommit
    || run.event !== "workflow_dispatch"
  ) {
    throw error("GitHub-stage handoff run is not bound to the exact release workflow dispatch");
  }
  return { artifact, runId };
}

function atomicJson(file, value) {
  atomicBytes(file, Buffer.from(`${JSON.stringify(value, null, 2)}\n`));
}

function atomicBytes(file, bytes) {
  const absolute = path.resolve(ROOT, file);
  mkdirSync(path.dirname(absolute), { recursive: true });
  const temporary = `${absolute}.tmp-${process.pid}`;
  let descriptor;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, bytes);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, absolute);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    try { unlinkSync(temporary); } catch {}
  }
}

function snapshotGitHubState(environment, { currentPointer, currentRunId, operation, releaseCommit }) {
  if (operation === "publish-bootstrap") return null;
  const repository = required("GITHUB_REPOSITORY", environment);
  const rootRunId = safeInteger(
    required("OLIPHAUNT_RELEASE_ROOT_RUN_ID", environment),
    "OLIPHAUNT_RELEASE_ROOT_RUN_ID",
  );
  const expectedRootRunId = currentPointer === null ? currentRunId : currentPointer.rootRunId;
  if (rootRunId !== expectedRootRunId) {
    throw error("installed GitHub state does not belong to the exact continuation root run");
  }
  const pacerBytes = readFileSync(
    path.resolve(required("OLIPHAUNT_GITHUB_CONTENT_WRITE_PACER_PATH", environment)),
  );
  const journalBytes = readFileSync(
    path.resolve(required("OLIPHAUNT_GITHUB_CORE_REQUEST_JOURNAL_PATH", environment)),
  );
  const githubState = continuationGitHubStateIdentity({
    journalBytes,
    lineage: { headSha: releaseCommit, repository, rootRunId: String(rootRunId) },
    pacerBytes,
  });
  const pacerSnapshot = environment.RELEASE_CONTINUATION_GITHUB_PACER_SNAPSHOT_PATH
    || path.join("target/release", CONTINUATION_PACER_MEMBER);
  const journalSnapshot = environment.RELEASE_CONTINUATION_GITHUB_CORE_JOURNAL_SNAPSHOT_PATH
    || path.join("target/release", CONTINUATION_CORE_JOURNAL_MEMBER);
  atomicBytes(pacerSnapshot, pacerBytes);
  atomicBytes(journalSnapshot, journalBytes);
  return githubState;
}

export function captureContinuationGitHubState(
  environment,
  { currentPointer, currentRunId, operation, releaseCommit },
  { githubReadOptions = {} } = {},
) {
  const normalizedPointer = currentPointer === null
    ? null
    : validateReleaseContinuationPointer(currentPointer, { operation, releaseCommit });
  // The stage-handoff identity costs two journaled GitHub reads. Resolve it
  // before freezing the state so a child inherits every charged request.
  const stageHandoff = exactStageArtifact(
    environment,
    { operation, releaseCommit },
    githubReadOptions,
  );
  const githubState = snapshotGitHubState(environment, {
    currentPointer: normalizedPointer,
    currentRunId,
    operation,
    releaseCommit,
  });
  return { githubState, stageHandoff };
}

export function buildContinuationContract({
  operation,
  releaseCommit,
  releaseTree,
  lock,
  products,
  result,
  executionResultFile,
  githubState,
  state,
  approvedPublication,
  stageHandoff,
  currentPointer,
  currentRunId,
  currentRunAttempt,
  exactPlanIds,
  nowEpochSeconds = Math.floor(Date.now() / 1000),
}) {
  const normalizedResult = validateReleaseExecutionResult(result, {
    lock: lockBinding(lock),
    operation,
    products,
    releaseCommit,
    releaseTree,
  });
  if (normalizedResult.decision !== "deferred") {
    throw error("continuation may be prepared only from a typed deferred execution result");
  }
  if (
    !Array.isArray(exactPlanIds)
    || exactPlanIds.length === 0
    || exactPlanIds.some((id) => typeof id !== "string" || id.length === 0)
    || new Set(exactPlanIds).size !== exactPlanIds.length
  ) {
    throw error("independently derived exact publication plan IDs must be a nonempty unique list");
  }
  const exactPlanSet = new Set(exactPlanIds);
  for (const [key, ids] of [
    ["admittedIds", normalizedResult.admittedIds],
    ["completedIds", normalizedResult.completedIds],
    ["remainingIds", normalizedResult.remainingIds],
  ]) {
    const selected = new Set(ids);
    const projection = exactPlanIds.filter((id) => selected.has(id));
    if (stableJson(ids) !== stableJson(projection)) {
      throw error(`execution result ${key} is not an exact ordered projection of the lock-derived plan`);
    }
  }
  if (
    normalizedResult.completedIds.length + normalizedResult.remainingIds.length !== exactPlanIds.length
    || normalizedResult.completedIds.some((id) => !exactPlanSet.has(id))
    || normalizedResult.remainingIds.some((id) => !exactPlanSet.has(id))
  ) {
    throw error("execution result completed/remaining IDs do not exactly partition the lock-derived plan");
  }
  const exactPlanCount = exactPlanIds.length;
  let generation = 1;
  let capacityDeferralAllowance = normalizedResult.deferralMode === "pre-mutation-capacity";
  let maxGenerations = exactPlanCount
    + RELEASE_CONTINUATION_RATE_LIMIT_DEFERRAL_BUDGET
    + RELEASE_CONTINUATION_DEADLINE_DEFERRAL_BUDGET;
  let deadlineDeferralsUsed = normalizedResult.deferralMode === "pre-mutation-deadline" ? 1 : 0;
  let rateLimitDeferralsUsed = normalizedResult.deferralMode === "rate-limit" ? 1 : 0;
  let rootRunId = currentRunId;
  let parentPointer = null;
  if (
    normalizedResult.notBeforeEpochSeconds - nowEpochSeconds
      > RELEASE_CONTINUATION_MAX_DISPATCH_DELAY_SECONDS
  ) {
    throw error(
      `typed deferral exceeds the ${RELEASE_CONTINUATION_MAX_DISPATCH_DELAY_SECONDS}s `
        + "automatic dispatch ceiling",
    );
  }
  if (currentPointer !== null) {
    const pointer = validateReleaseContinuationPointer(currentPointer, {
      operation,
      releaseCommit,
    });
    parentPointer = pointer;
    if (normalizedResult.deferralMode === "pre-mutation-capacity") {
      throw error("pre-mutation capacity deferral cannot recur in a continuation generation");
    }
    if (pointer.generation >= pointer.maxGenerations) {
      throw error("deferred execution exhausted its exact-plan-derived continuation bound");
    }
    capacityDeferralAllowance = pointer.capacityDeferralAllowance;
    if (
      pointer.deadlineDeferralBudget !== RELEASE_CONTINUATION_DEADLINE_DEFERRAL_BUDGET
      || pointer.rateLimitDeferralBudget !== RELEASE_CONTINUATION_RATE_LIMIT_DEFERRAL_BUDGET
      || exactPlanCount + pointer.rateLimitDeferralBudget + pointer.deadlineDeferralBudget
        !== pointer.maxGenerations
    ) {
      throw error("execution result plan size drifted from the root continuation bound");
    }
    deadlineDeferralsUsed = pointer.deadlineDeferralsUsed;
    if (normalizedResult.deferralMode === "pre-mutation-deadline") {
      if (deadlineDeferralsUsed >= pointer.deadlineDeferralBudget) {
        throw error("typed pre-mutation deadline deferral exhausted its frozen one-shot lineage budget");
      }
      deadlineDeferralsUsed += 1;
    }
    rateLimitDeferralsUsed = pointer.rateLimitDeferralsUsed;
    if (normalizedResult.deferralMode === "rate-limit") {
      if (rateLimitDeferralsUsed >= pointer.rateLimitDeferralBudget) {
        throw error("typed rate-limit deferral exhausted its frozen finite lineage budget");
      }
      rateLimitDeferralsUsed += 1;
    }
    generation = pointer.generation + 1;
    maxGenerations = pointer.maxGenerations;
    rootRunId = pointer.rootRunId;
  }
  if (operation === "publish" && parentPointer !== null) {
    for (const key of ["pacer", "coreRequestJournal"]) {
      const previous = parentPointer.githubState[key];
      const current = githubState?.[key];
      if (
        current === undefined
        || current.sequence < previous.sequence
        || (current.sequence === previous.sequence && current.digest !== previous.digest)
        || (current.sequence > previous.sequence && current.digest === previous.digest)
        || (
          previous.lastReservedAtMs !== null
          && (current.lastReservedAtMs === null || current.lastReservedAtMs < previous.lastReservedAtMs)
        )
      ) {
        throw error(`GitHub ${key} state did not monotonically extend the exact parent continuation`);
      }
    }
  }
  if (maxGenerations > RELEASE_CONTINUATION_GENERATION_CEILING) {
    throw error(
      `exact publication plan plus its frozen zero-progress allowances exceeds the `
        + `${RELEASE_CONTINUATION_GENERATION_CEILING}-generation transport ceiling`,
    );
  }
  return createReleaseContinuationContract({
    approvedPublication,
    githubState,
    lineage: {
      capacityDeferralAllowance,
      deadlineDeferralBudget: RELEASE_CONTINUATION_DEADLINE_DEFERRAL_BUDGET,
      deadlineDeferralsUsed,
      generation,
      maxGenerations,
      parentRunAttempt: currentRunAttempt,
      parentRunId: currentRunId,
      rateLimitDeferralBudget: RELEASE_CONTINUATION_RATE_LIMIT_DEFERRAL_BUDGET,
      rateLimitDeferralsUsed,
      rootRunId,
    },
    lock: lockBinding(lock),
    operation,
    outcome: {
      completedCount: normalizedResult.completedIds.length,
      decision: "deferred",
      deferralMode: normalizedResult.deferralMode,
      executionResultDigest: sha256File(executionResultFile),
      notBeforeEpochSeconds: normalizedResult.notBeforeEpochSeconds,
      progressCount: normalizedResult.newlyCompletedIds.length,
      remainingCount: normalizedResult.remainingIds.length,
      stateDigest: state.digest,
    },
    products,
    source: { commit: releaseCommit, tree: releaseTree },
    stageHandoff,
    state,
  });
}

export async function main(environment = process.env) {
  const {
    assertPublicationLockSource,
    loadPublicationLock,
  } = await import("../../tools/release/publication-lock.mjs");
  const operation = required("RELEASE_OPERATION", environment);
  const releaseCommit = required("RELEASE_HEAD_SHA", environment);
  const publicationLockFile = path.resolve(ROOT, required("PUBLICATION_LOCK_PATH", environment));
  const executionResultFile = path.resolve(ROOT, required("RELEASE_EXECUTION_RESULT_PATH", environment));
  const statePath = path.resolve(ROOT, required("RELEASE_CONTINUATION_STATE_PATH", environment));
  const products = sortedProducts(required("PRODUCTS_JSON", environment));
  const lock = loadPublicationLock(publicationLockFile);
  assertPublicationLockSource(lock, releaseCommit);
  const releaseTree = lock.source.tree;
  const exactPlanIds = operation === "publish-bootstrap"
    ? bootstrapPublicationPlan(lock, products).map(({ id }) => id)
    : normalPublicationPlan(lock, products).operations.map(({ id }) => id);
  const result = json(readFileSync(executionResultFile, "utf8"), "release execution result");
  const state = continuationStateIdentity(operation, statePath);
  const approvedPublication = {
    artifacts: json(required("APPROVED_ARTIFACT_METADATA_JSON", environment), "APPROVED_ARTIFACT_METADATA_JSON"),
    runId: safeInteger(required("APPROVED_RUN_ID", environment), "APPROVED_RUN_ID"),
  };
  const currentPointer = continuationPointerFromEnvironment(environment);
  const currentRunId = safeInteger(required("GITHUB_RUN_ID", environment), "GITHUB_RUN_ID");
  const currentRunAttempt = safeInteger(required("GITHUB_RUN_ATTEMPT", environment), "GITHUB_RUN_ATTEMPT");
  const { githubState, stageHandoff } = captureContinuationGitHubState(environment, {
    currentPointer,
    currentRunId,
    operation,
    releaseCommit,
  });
  const contract = buildContinuationContract({
    approvedPublication,
    currentPointer,
    currentRunAttempt,
    currentRunId,
    exactPlanIds,
    lock,
    operation,
    products,
    releaseCommit,
    releaseTree,
    result,
    executionResultFile,
    githubState,
    stageHandoff,
    state,
  });
  const output = environment.RELEASE_CONTINUATION_CONTRACT_PATH || DEFAULT_CONTRACT;
  atomicJson(output, contract);
  if (environment.GITHUB_OUTPUT) {
    appendFileSync(
      environment.GITHUB_OUTPUT,
      `contract_digest=${contract.contractDigest}\nnext_generation=${contract.lineage.generation}\n`
        + `not_before_epoch=${contract.outcome.notBeforeEpochSeconds}\n`,
    );
  }
  console.log(
    `sealed ${operation} continuation generation ${contract.lineage.generation}/${contract.lineage.maxGenerations} `
      + `for ${contract.outcome.remainingCount} remaining immutable operation(s)`,
  );
  return contract;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((cause) => {
    console.error(cause instanceof Error ? cause.message : String(cause));
    process.exit(1);
  });
}
