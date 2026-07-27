import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildContinuationContract,
  captureContinuationGitHubState,
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
const GITHUB_STATE = {
  coreRequestJournal: { digest: DIGEST, lastReservedAtMs: 900, sequence: 2, size: 100 },
  headSha: SHA,
  pacer: { digest: DIGEST, lastReservedAtMs: 1_000, sequence: 1, size: 100 },
  repository: "f0rr0/oliphaunt",
  rootRunId: 100,
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
    githubState: null,
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
    githubState: GITHUB_STATE,
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
  const progressed = {
    ...value,
    admittedIds: ["a"],
    completedIds: ["a"],
    deferralMode: "progress",
    newlyCompletedIds: ["a"],
    remainingIds: ["b"],
  };
  writeFileSync(file, `${JSON.stringify(progressed)}\n`);
  assert.throws(
    () => buildContinuationContract({
      ...base,
      currentPointer: pointer,
      currentRunId: 101,
      githubState: {
        ...GITHUB_STATE,
        coreRequestJournal: { ...GITHUB_STATE.coreRequestJournal, sequence: 1 },
      },
      result: progressed,
    }),
    /did not monotonically extend/u,
  );
  const advanced = buildContinuationContract({
    ...base,
    currentPointer: pointer,
    currentRunId: 101,
    githubState: {
      ...GITHUB_STATE,
      coreRequestJournal: {
        digest: "d".repeat(64),
        lastReservedAtMs: 1_100,
        sequence: 3,
        size: 120,
      },
    },
    result: progressed,
  });
  assert.equal(advanced.lineage.generation, 2);
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

test("stage metadata reads are journaled before continuation GitHub state is frozen", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "oliphaunt-prepare-github-state-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pacerPath = path.join(root, "pacer.json");
  const journalPath = path.join(root, "journal.json");
  const pacerSnapshot = path.join(root, "snapshot-pacer.json");
  const journalSnapshot = path.join(root, "snapshot-journal.json");
  writeFileSync(pacerPath, `${JSON.stringify({
    schema: "oliphaunt-github-content-write-pacer-v2",
    headSha: SHA,
    repository: "f0rr0/oliphaunt",
    rootRunId: "100",
    coldStartMs: 3_600_000,
    intervalMs: 10_000,
    sequence: 1,
    lastReservedAtMs: 10_000,
    lastLabel: "stage mutation",
    reservations: [{ label: "stage mutation", reservedAtMs: 10_000, sequence: 1 }],
  })}\n`);
  writeFileSync(journalPath, `${JSON.stringify({
    schema: "oliphaunt-github-core-request-journal-v2",
    headSha: SHA,
    repository: "f0rr0/oliphaunt",
    rootRunId: "100",
    sequence: 1,
    attempts: [{ label: "stage read", reservedAtMs: 10_000, sequence: 1 }],
  })}\n`);
  const environment = {
    GH_REPO: "f0rr0/oliphaunt",
    GITHUB_REPOSITORY: "f0rr0/oliphaunt",
    GITHUB_RUN_ID: "100",
    OLIPHAUNT_GITHUB_CONTENT_WRITE_PACER_PATH: pacerPath,
    OLIPHAUNT_GITHUB_CORE_REQUEST_JOURNAL_PATH: journalPath,
    OLIPHAUNT_RELEASE_ROOT_RUN_ID: "100",
    OLIPHAUNT_REQUIRE_GITHUB_CORE_REQUEST_JOURNAL: "true",
    RELEASE_CONTINUATION_GITHUB_CORE_JOURNAL_SNAPSHOT_PATH: journalSnapshot,
    RELEASE_CONTINUATION_GITHUB_PACER_SNAPSHOT_PATH: pacerSnapshot,
    RELEASE_HEAD_SHA: SHA,
    STAGE_HANDOFF_ARTIFACT_DIGEST: `sha256:${DIGEST}`,
    STAGE_HANDOFF_ARTIFACT_ID: "88",
    STAGE_HANDOFF_ARTIFACT_NAME: "github-stage-handoff-root",
    STAGE_HANDOFF_RUN_ID: "100",
  };
  const spawn = (_command, args) => {
    const endpoint = args.at(-1);
    const value = endpoint.endsWith("actions/artifacts/88")
      ? {
        digest: `sha256:${DIGEST}`,
        expired: false,
        id: 88,
        name: "github-stage-handoff-root",
        size_in_bytes: 10,
        workflow_run: { id: 100 },
      }
      : { event: "workflow_dispatch", head_sha: SHA, id: 100 };
    return { status: 0, stderr: "", stdout: `${JSON.stringify(value)}\n` };
  };
  const captured = captureContinuationGitHubState(environment, {
    currentPointer: null,
    currentRunId: 100,
    operation: "publish",
    releaseCommit: SHA,
  }, {
    githubReadOptions: {
      now: () => 30_000,
      random: () => 0.5,
      sleep: () => {},
      spawn,
    },
  });
  assert.equal(captured.stageHandoff.artifact.id, 88);
  assert.equal(captured.githubState.coreRequestJournal.sequence, 3);
  const frozenJournal = JSON.parse(readFileSync(journalSnapshot, "utf8"));
  assert.deepEqual(frozenJournal.attempts.map(({ label }) => label), [
    "stage read",
    "GitHub-stage artifact 88 attempt",
    "GitHub-stage Release run 100 attempt",
  ]);
  assert.deepEqual(readFileSync(journalSnapshot), readFileSync(journalPath));
  assert.deepEqual(readFileSync(pacerSnapshot), readFileSync(pacerPath));
});
