import assert from "node:assert/strict";
import test from "node:test";

import {
  assertReleasePhaseBudget,
  FINALIZE_JOB_HARD_WINDOW_SECONDS,
  FINALIZE_JOB_TIMEOUT_SECONDS,
  GITHUB_STAGE_HANDOFF_ALLOWANCE_SECONDS,
  GITHUB_STAGE_JOB_HARD_WINDOW_SECONDS,
  GITHUB_STAGE_JOB_TIMEOUT_SECONDS,
  REGISTRY_EXACT_INPUT_TRANSFER_ALLOWANCE_SECONDS,
  REGISTRY_JOB_HARD_WINDOW_SECONDS,
  REGISTRY_JOB_TIMEOUT_SECONDS,
  REGISTRY_MUTATION_ALLOWANCE_SECONDS,
  releasePhaseHardDeadlineEpoch,
} from "./release-phase-budget.mjs";

test("all three normal release phases retain explicit positive margins", () => {
  const stage = assertReleasePhaseBudget("github-staged", { stageOperationSeconds: 14_370 });
  const registry = assertReleasePhaseBudget("registry-published");
  const finalize = assertReleasePhaseBudget("github-finalized");
  for (const report of [stage, registry, finalize]) {
    assert.ok(report.hardWindowMarginSeconds > 0);
    assert.equal(report.totalAccountedSeconds, report.jobTimeoutSeconds);
    assert.equal(
      report.hardWindowSeconds + report.cleanupSeconds,
      report.jobTimeoutSeconds,
    );
  }
  assert.equal(stage.jobTimeoutSeconds, GITHUB_STAGE_JOB_TIMEOUT_SECONDS);
  assert.equal(registry.jobTimeoutSeconds, REGISTRY_JOB_TIMEOUT_SECONDS);
  assert.equal(registry.jobTimeoutSeconds, 360 * 60);
  assert.equal(registry.hardWindowSeconds, 350 * 60);
  assert.equal(registry.components.registryMutation, 190 * 60);
  assert.equal(REGISTRY_MUTATION_ALLOWANCE_SECONDS, 190 * 60);
  assert.equal(finalize.jobTimeoutSeconds, FINALIZE_JOB_TIMEOUT_SECONDS);
});

test("stage equality and overflow fail closed rather than consuming cleanup", () => {
  const equality = GITHUB_STAGE_JOB_HARD_WINDOW_SECONDS - GITHUB_STAGE_HANDOFF_ALLOWANCE_SECONDS;
  assert.throws(
    () => assertReleasePhaseBudget("github-staged", { stageOperationSeconds: equality }),
    /not less than its .* hard window/u,
  );
  assert.throws(
    () => assertReleasePhaseBudget("github-staged", { stageOperationSeconds: equality + 1 }),
    /not less than its .* hard window/u,
  );
});

test("registry transfer is live-bound but cannot exceed its exact download step", () => {
  const report = assertReleasePhaseBudget("registry-published", {
    registryTransferSeconds: REGISTRY_EXACT_INPUT_TRANSFER_ALLOWANCE_SECONDS - 1,
  });
  assert.equal(
    report.components.exactApprovedInputTransfer,
    REGISTRY_EXACT_INPUT_TRANSFER_ALLOWANCE_SECONDS - 1,
  );
  assert.throws(
    () => assertReleasePhaseBudget("registry-published", {
      registryTransferSeconds: REGISTRY_EXACT_INPUT_TRANSFER_ALLOWANCE_SECONDS + 1,
    }),
    /exceeds the .* exact-download allowance/u,
  );
});

test("fresh phase deadlines use the matching hard window", () => {
  assert.equal(releasePhaseHardDeadlineEpoch("github-staged", 1_000), 1_000 + GITHUB_STAGE_JOB_HARD_WINDOW_SECONDS);
  assert.equal(releasePhaseHardDeadlineEpoch("registry-published", 1_000), 1_000 + REGISTRY_JOB_HARD_WINDOW_SECONDS);
  assert.equal(releasePhaseHardDeadlineEpoch("github-finalized", 1_000), 1_000 + FINALIZE_JOB_HARD_WINDOW_SECONDS);
});

test("malformed and unknown phase inputs fail closed", () => {
  assert.throws(() => assertReleasePhaseBudget("github-staged"), /must be a positive integer/u);
  assert.throws(() => assertReleasePhaseBudget("unknown", {}), /unsupported phase/u);
  assert.throws(() => releasePhaseHardDeadlineEpoch("github-finalized", 0), /positive integer/u);
});
