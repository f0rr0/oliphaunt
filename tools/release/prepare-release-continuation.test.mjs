import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildContinuationContract,
  continuationPointerFromEnvironment,
} from "../../.github/scripts/prepare-release-continuation.mjs";
import { createReleaseContinuationPointer } from "./release-continuation-contract.mjs";

const SHA = "a".repeat(40);
const TREE = "b".repeat(40);
const DIGEST = "c".repeat(64);
const PRODUCTS = ["a", "b"];
const LOCK = {
  source: { commit: SHA, tree: TREE },
  lockDigest: DIGEST,
  catalogDigest: DIGEST,
  packageEnvelopeDigest: DIGEST,
};

function approved() {
  return {
    runId: 50,
    artifacts: [
      { id: 1, name: "oliphaunt-publication-lock", size: 10, digest: `sha256:${DIGEST}` },
      { id: 2, name: "oliphaunt-bootstrap-capsule", size: 20, digest: `sha256:${DIGEST}` },
    ],
  };
}

function result(file, {
  admitted = ["a"],
  completed = ["a"],
  newly = ["a"],
  remaining = ["b"],
} = {}) {
  const value = {
    schema: "oliphaunt-bootstrap-execution-result-v1",
    operation: "publish-bootstrap",
    decision: "deferred",
    deferralMode: "progress",
    source: { commit: SHA, tree: TREE },
    lock: { lockDigest: DIGEST, catalogDigest: DIGEST, packageEnvelopeDigest: DIGEST },
    products: PRODUCTS,
    admittedIds: admitted,
    completedIds: completed,
    newlyCompletedIds: newly,
    remainingIds: remaining,
    notBeforeEpochSeconds: 1_800_000_000,
  };
  writeFileSync(file, `${JSON.stringify(value)}\n`);
  return value;
}

function options(file, overrides = {}) {
  return {
    operation: "publish-bootstrap",
    releaseCommit: SHA,
    releaseTree: TREE,
    lock: LOCK,
    products: PRODUCTS,
    result: result(file),
    executionResultFile: file,
    state: { kind: "bootstrap-ledger", digest: DIGEST, entryCount: 1 },
    approvedPublication: approved(),
    stageHandoff: null,
    currentPointer: null,
    currentRunId: 100,
    currentRunAttempt: 1,
    exactPlanIds: ["a", "b"],
    nowEpochSeconds: 1_799_999_940,
    ...overrides,
  };
}

test("root and child contracts retain one exact-plan bound and advance parent lineage", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "oliphaunt-prepare-continuation-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "result.json");
  const first = buildContinuationContract(options(file));
  assert.equal(first.lineage.generation, 1);
  assert.equal(first.lineage.maxGenerations, 6);
  const pointer = createReleaseContinuationPointer({
    contract: first,
    artifact: { id: 99, name: "ledger", size: 10, digest: `sha256:${DIGEST}` },
  });
  const currentPointer = continuationPointerFromEnvironment({
    RELEASE_CONTINUATION_POINTER: JSON.stringify(pointer),
  });
  const second = buildContinuationContract(options(file, {
    currentPointer,
    currentRunId: 101,
  }));
  assert.equal(second.lineage.generation, 2);
  assert.equal(second.lineage.rootRunId, first.lineage.rootRunId);
  assert.equal(
    continuationPointerFromEnvironment({ RELEASE_CONTINUATION: JSON.stringify(pointer) }),
    null,
    "the obsolete variable must not silently reset or substitute workflow lineage",
  );
  assert.throws(
    () => continuationPointerFromEnvironment({
      RELEASE_CONTINUATION_POINTER: "x".repeat(32 * 1024 + 1),
    }),
    /RELEASE_CONTINUATION_POINTER exceeds 32 KiB/u,
  );
  const secondResult = result(file, {
    admitted: ["b"],
    completed: ["a", "b"],
    newly: ["b"],
    remaining: ["c"],
  });
  assert.throws(
    () => buildContinuationContract(options(file, {
      currentPointer: pointer,
      currentRunId: 101,
      exactPlanIds: ["a", "b", "c"],
      result: secondResult,
    })),
    /plan size drifted/u,
  );
});

test("typed first-operation rate limits consume a finite monotonic lineage budget", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "oliphaunt-rate-limit-continuation-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "result.json");
  const value = result(file, {
    completed: [],
    newly: [],
    remaining: ["a", "b"],
  });
  value.admittedIds = ["cargo:a", "cargo:b"];
  value.deferralMode = "rate-limit";
  value.remainingIds = ["cargo:a", "cargo:b"];
  writeFileSync(file, `${JSON.stringify(value)}\n`);
  let contract = buildContinuationContract(options(file, {
    exactPlanIds: ["cargo:a", "cargo:b"],
    nowEpochSeconds: 1_799_999_940,
    result: value,
  }));
  assert.equal(contract.lineage.maxGenerations, 6);
  assert.equal(contract.lineage.rateLimitDeferralsUsed, 1);
  for (const expectedUse of [2, 3]) {
    const pointer = createReleaseContinuationPointer({
      contract,
      artifact: { id: 90 + expectedUse, name: "ledger", size: 10, digest: `sha256:${DIGEST}` },
    });
    contract = buildContinuationContract(options(file, {
      currentPointer: pointer,
      currentRunId: 100 + expectedUse,
      exactPlanIds: ["cargo:a", "cargo:b"],
      nowEpochSeconds: 1_799_999_940,
      result: value,
    }));
    assert.equal(contract.lineage.rateLimitDeferralsUsed, expectedUse);
  }
  const exhausted = createReleaseContinuationPointer({
    contract,
    artifact: { id: 99, name: "ledger", size: 10, digest: `sha256:${DIGEST}` },
  });
  assert.throws(
    () => buildContinuationContract(options(file, {
      currentPointer: exhausted,
      currentRunId: 104,
      exactPlanIds: ["cargo:a", "cargo:b"],
      nowEpochSeconds: 1_799_999_940,
      result: value,
    })),
    /exhausted its frozen finite lineage budget/u,
  );
  assert.throws(
    () => buildContinuationContract(options(file, {
      exactPlanIds: ["cargo:a", "cargo:b"],
      nowEpochSeconds: 1_799_999_000,
      result: value,
    })),
    /automatic dispatch ceiling/u,
  );
});

test("zero-mutation capacity mode is root-only and does not claim rate-limit use", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "oliphaunt-capacity-continuation-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "result.json");
  const value = {
    ...result(file, { completed: [], newly: [], remaining: ["a", "b"] }),
    admittedIds: [],
    deferralMode: "pre-mutation-capacity",
    operation: "publish",
    schema: "oliphaunt-normal-publication-execution-result-v1",
  };
  writeFileSync(file, `${JSON.stringify(value)}\n`);
  const base = options(file, {
    operation: "publish",
    result: value,
    stageHandoff: {
      artifact: {
        digest: `sha256:${DIGEST}`,
        id: 88,
        name: "github-stage-handoff-root",
        size: 10,
      },
      runId: 100,
    },
    state: { digest: DIGEST, entryCount: 1, kind: "normal-publication-checkpoint" },
  });
  const contract = buildContinuationContract(base);
  assert.equal(contract.lineage.capacityDeferralAllowance, true);
  assert.equal(contract.lineage.rateLimitDeferralsUsed, 0);
  const pointer = createReleaseContinuationPointer({
    contract,
    artifact: { id: 99, name: "checkpoint", size: 10, digest: `sha256:${DIGEST}` },
  });
  assert.throws(
    () => buildContinuationContract({
      ...base,
      currentPointer: pointer,
      currentRunId: 101,
    }),
    /cannot recur/u,
  );
});

test("pre-mutation deadline deferral is one-shot and progress cannot replenish it", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "oliphaunt-deadline-continuation-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "result.json");
  const value = result(file, { completed: [], newly: [], remaining: ["a", "b"] });
  value.deferralMode = "pre-mutation-deadline";
  writeFileSync(file, `${JSON.stringify(value)}\n`);
  const first = buildContinuationContract(options(file, {
    nowEpochSeconds: 1_799_999_940,
    result: value,
  }));
  assert.equal(first.lineage.deadlineDeferralsUsed, 1);
  const pointer = createReleaseContinuationPointer({
    contract: first,
    artifact: { id: 89, name: "ledger", size: 10, digest: `sha256:${DIGEST}` },
  });
  assert.throws(
    () => buildContinuationContract(options(file, {
      currentPointer: pointer,
      currentRunId: 101,
      nowEpochSeconds: 1_799_999_940,
      result: value,
    })),
    /exhausted its frozen one-shot lineage budget/u,
  );
  const progress = result(file);
  const second = buildContinuationContract(options(file, {
    currentPointer: pointer,
    currentRunId: 101,
    result: progress,
  }));
  assert.equal(second.lineage.deadlineDeferralsUsed, 1);
});
