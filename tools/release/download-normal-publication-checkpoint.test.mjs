#!/usr/bin/env bun
import assert from "node:assert/strict";
import test from "node:test";

import {
  eligibleRecoveryArtifacts,
  selectMaximalCheckpointCandidate,
} from "../../.github/scripts/download-normal-publication-checkpoint.mjs";
import {
  NORMAL_PUBLICATION_RECOVERY_GITHUB_CORE_REQUEST_MAX,
  NORMAL_PUBLICATION_RECOVERY_MAX_ATTEMPTS,
  NORMAL_PUBLICATION_RECOVERY_MAX_CANDIDATES,
  NORMAL_PUBLICATION_RECOVERY_MAX_DURATION_MS,
  NORMAL_PUBLICATION_RECOVERY_MAX_PAGES_PER_INVENTORY,
  NORMAL_PUBLICATION_RECOVERY_STEP_TIMEOUT_MS,
} from "./normal-publication-recovery-contract.mjs";

const SHA = "a".repeat(40);
const WORKFLOW = "42";
const CURRENT = "900";
const NAME = `normal-publication-recovery-${SHA}`;

function run(id, extra = {}) {
  return {
    id,
    workflow_id: Number(WORKFLOW),
    head_sha: SHA,
    event: "workflow_dispatch",
    status: "completed",
    ...extra,
  };
}

function artifact(id, runId, extra = {}) {
  return {
    id,
    name: NAME,
    expired: false,
    size_in_bytes: 100,
    digest: `sha256:${"b".repeat(64)}`,
    workflow_run: { id: runId, head_sha: SHA },
    ...extra,
  };
}

function candidate(artifactId, runId, completedOperations, digestCharacter) {
  return {
    artifact: { id: String(artifactId), runId: String(runId) },
    checkpoint: {
      checkpointDigest: digestCharacter.repeat(64),
      completedOperations,
    },
    checkpointBytes: Buffer.from(`${digestCharacter}\n`),
  };
}

test("joins exact workflow/SHA runs to immutable artifacts and excludes the current run", () => {
  const selected = eligibleRecoveryArtifacts({
    runs: [
      run(CURRENT, { status: "in_progress" }),
      run(800),
      run(700, { status: "in_progress" }),
    ],
    artifacts: [
      artifact(1, CURRENT),
      artifact(2, 800),
      artifact(3, 700),
      artifact(4, 600, { workflow_run: { id: 600, head_sha: "c".repeat(40) } }),
    ],
    currentRunId: CURRENT,
    workflowId: WORKFLOW,
    sha: SHA,
    name: NAME,
  });
  assert.deepEqual(selected.map(({ id, runId }) => [id, runId]), [["2", "800"]]);
});

test("rejects duplicate same-run artifacts and inventory identity drift", () => {
  assert.throws(
    () => eligibleRecoveryArtifacts({
      runs: [run(800)],
      artifacts: [artifact(1, 800), artifact(2, 800)],
      currentRunId: CURRENT,
      workflowId: WORKFLOW,
      sha: SHA,
      name: NAME,
    }),
    /duplicate same-name recovery artifacts/u,
  );
  assert.throws(
    () => eligibleRecoveryArtifacts({
      runs: [run(800, { workflow_id: 99 })],
      artifacts: [],
      currentRunId: CURRENT,
      workflowId: WORKFLOW,
      sha: SHA,
      name: NAME,
    }),
    /outside workflow 42 and SHA/u,
  );
});

test("selects the unique dependency-superset checkpoint and collapses identical evidence", () => {
  const small = candidate(30, 700, ["a"], "a");
  const largeOlderArtifact = candidate(20, 800, ["a", "b"], "b");
  const largeDuplicate = candidate(21, 801, ["a", "b"], "b");
  const selected = selectMaximalCheckpointCandidate([small, largeDuplicate, largeOlderArtifact]);
  assert.equal(selected.artifact.id, "20", "identical maximal evidence uses the lowest immutable artifact ID");
  assert.deepEqual(selected.checkpoint.completedOperations, ["a", "b"]);
});

test("rejects incomparable maxima and conflicting digests for one completion set", () => {
  assert.throws(
    () => selectMaximalCheckpointCandidate([
      candidate(1, 800, ["a"], "a"),
      candidate(2, 801, ["b"], "b"),
    ]),
    /incomparable maximal checkpoints/u,
  );
  assert.throws(
    () => selectMaximalCheckpointCandidate([
      candidate(1, 800, ["a"], "a"),
      candidate(2, 801, ["a"], "b"),
    ]),
    /conflict for the same completed operation set/u,
  );
});

test("the admission contract has a finite request and duration ceiling", () => {
  assert.equal(NORMAL_PUBLICATION_RECOVERY_MAX_PAGES_PER_INVENTORY, 4);
  assert.equal(NORMAL_PUBLICATION_RECOVERY_MAX_CANDIDATES, 4);
  assert.equal(NORMAL_PUBLICATION_RECOVERY_MAX_ATTEMPTS, 2);
  assert.equal(NORMAL_PUBLICATION_RECOVERY_GITHUB_CORE_REQUEST_MAX, 26);
  assert.equal(NORMAL_PUBLICATION_RECOVERY_MAX_DURATION_MS, 360_000);
  assert.equal(NORMAL_PUBLICATION_RECOVERY_STEP_TIMEOUT_MS, 420_000);
  assert.ok(NORMAL_PUBLICATION_RECOVERY_MAX_DURATION_MS < NORMAL_PUBLICATION_RECOVERY_STEP_TIMEOUT_MS);
});
