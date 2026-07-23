import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "bun:test";

import { affectedPlanBinding } from "../../.github/scripts/release-candidate-lib.mjs";
import { verifyHistoryRepairCandidateBinding } from "../../.github/scripts/history-repair-candidate-lib.mjs";

const PLAN = fileURLToPath(new URL("../../target/history-repair-candidate-test-plan.json", import.meta.url));
const CANDIDATE_SHA = "1111111111111111111111111111111111111111";
const INTRODUCTION_SHA = "2222222222222222222222222222222222222222";
const TREE = "3333333333333333333333333333333333333333";
const REPOSITORY = "f0rr0/oliphaunt";
const RUN_ID = "123456";

writeFileSync(PLAN, `${JSON.stringify({
  extension_package_products: [],
  jobs: [],
  projects: [],
}, null, 2)}\n`);

function fixture() {
  return {
    schemaVersion: 2,
    repository: REPOSITORY,
    workflow: "CI",
    workflowRef: `${REPOSITORY}/.github/workflows/ci.yml@refs/heads/f0rr0/release-candidate`,
    runId: RUN_ID,
    runAttempt: 1,
    eventName: "workflow_dispatch",
    ref: "refs/heads/f0rr0/release-candidate",
    sha: CANDIDATE_SHA,
    tree: TREE,
    affectedPlan: affectedPlanBinding(PLAN, false),
    evidenceRequirements: {
      wasixReleaseRegression: false,
      artifacts: [],
    },
    evidence: {
      wasixReleaseRegression: null,
    },
  };
}

function verify(candidate = fixture(), overrides = {}) {
  return verifyHistoryRepairCandidateBinding({
    candidate,
    candidateCommitTree: TREE,
    candidateRemoteSha: CANDIDATE_SHA,
    expectedCandidateSha: CANDIDATE_SHA,
    expectedIntroductionSha: INTRODUCTION_SHA,
    expectedIntroductionTree: TREE,
    expectedRepository: REPOSITORY,
    expectedRunId: RUN_ID,
    planPath: PLAN,
    ...overrides,
  });
}

describe("history-repair candidate binding", () => {
  test("accepts different commits only when their trees and exact run binding agree", () => {
    expect(verify()).toEqual({
      branch: "f0rr0/release-candidate",
      sha: CANDIDATE_SHA,
      tree: TREE,
    });
  });

  test("rejects a one-byte-equivalent tree identity mismatch", () => {
    expect(() => verify(fixture(), {
      expectedIntroductionTree: "4333333333333333333333333333333333333333",
    })).toThrow("history-repair candidate tree mismatch");
  });

  for (const [label, mutate, message] of [
    ["candidate SHA", (value) => { value.sha = "4444444444444444444444444444444444444444"; }, "candidate sha mismatch"],
    ["run", (value) => { value.runId = "654321"; }, "candidate runId mismatch"],
    ["ref", (value) => { value.ref = "refs/heads/main"; }, "must be a non-main branch"],
    ["repository", (value) => { value.repository = "attacker/fork"; }, "candidate repository mismatch"],
    ["event", (value) => { value.eventName = "push"; }, "candidate eventName mismatch"],
  ]) {
    test(`rejects a mismatched ${label}`, () => {
      const candidate = fixture();
      mutate(candidate);
      expect(() => verify(candidate)).toThrow(message);
    });
  }

  test("rejects a changed affected plan", () => {
    const candidate = fixture();
    candidate.affectedPlan.digest = `sha256:${"5".repeat(64)}`;
    expect(() => verify(candidate)).toThrow("affected plan binding does not match");
  });

  test("rejects a candidate commit that is not the retained remote branch tip", () => {
    expect(() => verify(fixture(), {
      candidateRemoteSha: "6666666666666666666666666666666666666666",
    })).toThrow("remote branch tip mismatch");
  });
});
