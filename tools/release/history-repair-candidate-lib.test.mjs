import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "bun:test";

import { affectedPlanBinding } from "../../.github/scripts/release-candidate-lib.mjs";
import { verifyHistoryRepairCandidateBinding } from "../../.github/scripts/history-repair-candidate-lib.mjs";
import {
  RELEASE_PLEASE_HISTORY_REPAIR_CANDIDATE_BRANCH,
} from "./release-please-bootstrap.mjs";

const PLAN = fileURLToPath(new URL("../../target/history-repair-candidate-test-plan.json", import.meta.url));
const CANDIDATE_SHA = "1111111111111111111111111111111111111111";
const INTRODUCTION_SHA = "2222222222222222222222222222222222222222";
const TREE = "3333333333333333333333333333333333333333";
const REPOSITORY = "f0rr0/oliphaunt";
const RUN_ID = "123456";
const CANDIDATE_REF = `refs/heads/${RELEASE_PLEASE_HISTORY_REPAIR_CANDIDATE_BRANCH}`;

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
    workflowRef: `${REPOSITORY}/.github/workflows/ci.yml@${CANDIDATE_REF}`,
    runId: RUN_ID,
    runAttempt: 1,
    eventName: "workflow_dispatch",
    ref: CANDIDATE_REF,
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
      branch: RELEASE_PLEASE_HISTORY_REPAIR_CANDIDATE_BRANCH,
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
    ["ref", (value) => { value.ref = "refs/heads/main"; }, "candidate ref mismatch"],
    ["repository", (value) => { value.repository = "attacker/fork"; }, "candidate repository mismatch"],
    ["event", (value) => { value.eventName = "push"; }, "candidate eventName mismatch"],
  ]) {
    test(`rejects a mismatched ${label}`, () => {
      const candidate = fixture();
      mutate(candidate);
      expect(() => verify(candidate)).toThrow(message);
    });
  }

  test("rejects another retained non-main candidate branch", () => {
    const candidate = fixture();
    candidate.ref = "refs/heads/f0rr0/history-repair-candidate-2";
    candidate.workflowRef =
      `${REPOSITORY}/.github/workflows/ci.yml@${candidate.ref}`;
    expect(() => verify(candidate)).toThrow(
      `expected ${CANDIDATE_REF}`,
    );
  });

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

  test("rejects workflow identity drift even when the candidate ref remains exact", () => {
    const candidate = fixture();
    candidate.workflowRef =
      `${REPOSITORY}/.github/workflows/release.yml@${CANDIDATE_REF}`;
    expect(() => verify(candidate)).toThrow("candidate workflowRef mismatch");
  });

  test("rejects a candidate commit tree that differs from its artifact tree", () => {
    expect(() => verify(fixture(), {
      candidateCommitTree: "7777777777777777777777777777777777777777",
    })).toThrow("candidate commit tree mismatch");
  });

  test("rejects reusing the introduction commit as its own qualification candidate", () => {
    expect(() => verify(fixture(), {
      expectedIntroductionSha: CANDIDATE_SHA,
    })).toThrow("candidate must not be the introduction commit itself");
  });
});
