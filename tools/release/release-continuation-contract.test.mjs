import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  RELEASE_CONTINUATION_GENERATION_CEILING,
  continuationStateIdentity,
  createReleaseContinuationContract,
  createReleaseContinuationPointer,
  validateReleaseExecutionResult,
  validateReleaseContinuationContract,
  validateReleaseContinuationPointer,
} from "./release-continuation-contract.mjs";

const SHA = "a".repeat(40);
const TREE = "b".repeat(40);
const DIGEST = "c".repeat(64);
const GITHUB_STATE = {
  coreRequestJournal: { digest: DIGEST, lastReservedAtMs: 900, sequence: 2, size: 100 },
  headSha: SHA,
  pacer: { digest: DIGEST, lastReservedAtMs: 1_000, sequence: 1, size: 100 },
  repository: "f0rr0/oliphaunt",
  rootRunId: 100,
};

function artifact(name, id = 10) {
  return { digest: `sha256:${DIGEST}`, id, name, size: 123 };
}

function contract(overrides = {}) {
  return createReleaseContinuationContract({
    approvedPublication: {
      artifacts: [
        artifact("oliphaunt-publication-lock", 1),
        artifact("oliphaunt-bootstrap-capsule", 2),
      ],
      runId: 50,
    },
    githubState: null,
    lineage: {
      capacityDeferralAllowance: false,
      deadlineDeferralBudget: 1,
      deadlineDeferralsUsed: 0,
      generation: 1,
      maxGenerations: 25,
      parentRunAttempt: 1,
      parentRunId: 100,
      rateLimitDeferralBudget: 3,
      rateLimitDeferralsUsed: 0,
      rootRunId: 100,
    },
    lock: { catalogDigest: DIGEST, lockDigest: DIGEST, packageEnvelopeDigest: DIGEST },
    operation: "publish-bootstrap",
    outcome: {
      completedCount: 5,
      decision: "deferred",
      deferralMode: "progress",
      executionResultDigest: DIGEST,
      notBeforeEpochSeconds: 1_800_000_000,
      progressCount: 5,
      remainingCount: 20,
      stateDigest: DIGEST,
    },
    products: ["a", "b"],
    source: { commit: SHA, tree: TREE },
    stageHandoff: null,
    state: { digest: DIGEST, entryCount: 2, kind: "bootstrap-ledger" },
    ...overrides,
  });
}

test("contract and pointer bind exact release, lock, products, lineage, and parent artifact identity", () => {
  const value = contract();
  const pointer = createReleaseContinuationPointer({
    contract: value,
    artifact: artifact("oliphaunt-bootstrap-ledger", 99),
  });
  assert.equal(validateReleaseContinuationContract(value, {
    operation: "publish-bootstrap",
    releaseCommit: SHA,
    releaseTree: TREE,
    generation: 1,
    rootRunId: 100,
    parentRunId: 100,
  }).contractDigest, value.contractDigest);
  assert.equal(validateReleaseContinuationPointer(pointer, {
    operation: "publish-bootstrap",
    releaseCommit: SHA,
    generation: 1,
  }).artifact.id, 99);
});

test("tampering, zero progress, unbounded generations, and mismatched first parent fail closed", () => {
  const value = contract();
  assert.throws(
    () => validateReleaseContinuationContract({ ...value, products: ["b", "a"] }),
    /canonical lexical order/u,
  );
  assert.throws(
    () => contract({ outcome: { ...value.outcome, progressCount: 0 } }),
    /progress must match its explicit deferral mode/u,
  );
  assert.throws(
    () => contract({ lineage: { ...value.lineage, generation: 26 } }),
    /exact-plan bound/u,
  );
  assert.throws(
    () => contract({ lineage: { ...value.lineage, maxGenerations: RELEASE_CONTINUATION_GENERATION_CEILING + 1 } }),
    /parser ceiling/u,
  );
  assert.throws(
    () => contract({ lineage: { ...value.lineage, rootRunId: 99 } }),
    /generation one must bind the root run/u,
  );
  const pointer = createReleaseContinuationPointer({ contract: value, artifact: artifact("x") });
  assert.throws(
    () => validateReleaseContinuationPointer({ ...pointer, generation: 2 }),
    /pointer digest does not match/u,
  );
  const rateLimited = contract({
    lineage: {
      ...value.lineage,
      rateLimitDeferralsUsed: 1,
    },
    outcome: {
      ...value.outcome,
      completedCount: 0,
      deferralMode: "rate-limit",
      progressCount: 0,
    },
  });
  assert.equal(rateLimited.lineage.rateLimitDeferralsUsed, 1);
  assert.throws(
    () => contract({
      lineage: { ...value.lineage, rateLimitDeferralsUsed: 0 },
      outcome: { ...value.outcome, deferralMode: "rate-limit", progressCount: 0 },
    }),
    /must consume a finite lineage allowance/u,
  );
  assert.throws(
    () => contract({
      lineage: { ...value.lineage, rateLimitDeferralsUsed: 4 },
    }),
    /frozen 3-generation budget/u,
  );
  const deadline = contract({
    lineage: {
      ...value.lineage,
      deadlineDeferralsUsed: 1,
    },
    outcome: {
      ...value.outcome,
      completedCount: 0,
      deferralMode: "pre-mutation-deadline",
      progressCount: 0,
    },
  });
  assert.equal(deadline.lineage.deadlineDeferralsUsed, 1);
  assert.throws(
    () => contract({
      lineage: { ...value.lineage, deadlineDeferralsUsed: 0 },
      outcome: {
        ...value.outcome,
        deferralMode: "pre-mutation-deadline",
        progressCount: 0,
      },
    }),
    /must consume its one-shot lineage allowance/u,
  );
});

test("normal continuation requires the exact reusable stage handoff", () => {
  const value = contract({
    githubState: GITHUB_STATE,
    operation: "publish",
    stageHandoff: { artifact: artifact(`github-stage-handoff-${SHA}-100-1`), runId: 100 },
    state: { digest: DIGEST, entryCount: 1, kind: "normal-publication-checkpoint" },
  });
  assert.equal(validateReleaseContinuationContract(value).stageHandoff.runId, 100);
  assert.throws(
    () => contract({
      githubState: GITHUB_STATE,
      operation: "publish",
      stageHandoff: { artifact: artifact(`github-stage-handoff-${SHA}-99-1`), runId: 99 },
      state: { digest: DIGEST, entryCount: 1, kind: "normal-publication-checkpoint" },
    }),
    /must belong to the exact root Release run/u,
  );
  assert.throws(
    () => contract({
      githubState: GITHUB_STATE,
      operation: "publish",
      stageHandoff: null,
      state: { digest: DIGEST, entryCount: 1, kind: "normal-publication-checkpoint" },
    }),
    /stageHandoff must be an object/u,
  );
  assert.throws(
    () => contract({
      githubState: { ...GITHUB_STATE, rootRunId: 99 },
      operation: "publish",
      stageHandoff: { artifact: artifact(`github-stage-handoff-${SHA}-100-1`), runId: 100 },
      state: { digest: DIGEST, entryCount: 1, kind: "normal-publication-checkpoint" },
    }),
    /GitHub state must bind the exact source and root lineage/u,
  );
});

test("state identities cover every immutable bootstrap checkpoint and exact normal bytes", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "oliphaunt-continuation-state-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ledger = path.join(root, "ledger");
  mkdirSync(ledger);
  writeFileSync(path.join(ledger, `checkpoint-000000-${"d".repeat(64)}.json`), "one\n");
  writeFileSync(path.join(ledger, `checkpoint-000001-${"e".repeat(64)}.json`), "two\n");
  const first = continuationStateIdentity("publish-bootstrap", ledger);
  assert.equal(first.entryCount, 2);
  writeFileSync(path.join(ledger, `checkpoint-000001-${"e".repeat(64)}.json`), "changed\n");
  assert.notEqual(continuationStateIdentity("publish-bootstrap", ledger).digest, first.digest);
  writeFileSync(path.join(ledger, "unexpected.json"), "{}\n");
  assert.throws(() => continuationStateIdentity("publish-bootstrap", ledger), /unexpected entry/u);

  const checkpoint = path.join(root, "normal.json");
  writeFileSync(checkpoint, "normal\n");
  assert.equal(continuationStateIdentity("publish", checkpoint).entryCount, 1);
});

test("typed execution results require progress before deferral and exhaustion before completion", () => {
  const deferred = {
    schema: "oliphaunt-bootstrap-execution-result-v1",
    operation: "publish-bootstrap",
    decision: "deferred",
    deferralMode: "progress",
    source: { commit: SHA, tree: TREE },
    lock: { lockDigest: DIGEST, catalogDigest: DIGEST, packageEnvelopeDigest: DIGEST },
    products: ["a", "b"],
    admittedIds: ["a", "b"],
    completedIds: ["a"],
    newlyCompletedIds: ["a"],
    remainingIds: ["b"],
    notBeforeEpochSeconds: 1_800_000_000,
  };
  assert.equal(validateReleaseExecutionResult(deferred).newlyCompletedIds.length, 1);
  assert.throws(
    () => validateReleaseExecutionResult({ ...deferred, newlyCompletedIds: [] }),
    /requires nonzero newly completed IDs/u,
  );
  assert.throws(
    () => validateReleaseExecutionResult({ ...deferred, admittedIds: ["b"] }),
    /newlyCompletedIds must be a subset of admittedIds/u,
  );
  assert.equal(validateReleaseExecutionResult({
    ...deferred,
    admittedIds: ["carrier:cargo:a", "carrier:cargo:b"],
    completedIds: [],
    deferralMode: "rate-limit",
    newlyCompletedIds: [],
    remainingIds: ["carrier:cargo:a", "carrier:cargo:b"],
  }).deferralMode, "rate-limit");
  assert.equal(validateReleaseExecutionResult({
    ...deferred,
    completedIds: [],
    deferralMode: "pre-mutation-deadline",
    newlyCompletedIds: [],
    remainingIds: ["a", "b"],
  }).deferralMode, "pre-mutation-deadline");
  assert.throws(
    () => validateReleaseExecutionResult({
      ...deferred,
      deferralMode: "pre-mutation-deadline",
    }),
    /requires admitted remaining work and no new completion/u,
  );
  assert.throws(
    () => validateReleaseExecutionResult({ ...deferred, remainingIds: ["a", "b"] }),
    /must be disjoint/u,
  );
  assert.throws(
    () => validateReleaseExecutionResult({ ...deferred, admittedIds: ["attacker"] }),
    /must be a projection/u,
  );
  assert.equal(validateReleaseExecutionResult({
    ...deferred,
    decision: "complete",
    deferralMode: null,
    completedIds: ["a", "b"],
    newlyCompletedIds: [],
    remainingIds: [],
    notBeforeEpochSeconds: null,
  }).decision, "complete");
});
