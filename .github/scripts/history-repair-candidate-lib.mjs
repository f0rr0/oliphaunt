import {
  affectedPlanBinding,
  assertBindingMatches,
  assertCandidateBindingShape,
} from "./release-candidate-lib.mjs";

const FULL_SHA = /^[0-9a-f]{40}$/u;
const CANDIDATE_KEYS = [
  "affectedPlan",
  "eventName",
  "evidence",
  "evidenceRequirements",
  "ref",
  "repository",
  "runAttempt",
  "runId",
  "schemaVersion",
  "sha",
  "tree",
  "workflow",
  "workflowRef",
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function same(actual, expected, context) {
  assert(actual === expected, `${context} mismatch: expected ${expected}, got ${actual}`);
}

export function verifyHistoryRepairCandidateBinding({
  candidate,
  candidateCommitTree,
  candidateRemoteSha,
  expectedCandidateSha,
  expectedIntroductionSha,
  expectedIntroductionTree,
  expectedRepository,
  expectedRunId,
  planPath,
}) {
  assertCandidateBindingShape(candidate);
  assert(
    JSON.stringify(Object.keys(candidate).sort()) === JSON.stringify(CANDIDATE_KEYS),
    "history-repair candidate must contain only the canonical qualification fields",
  );
  assert(FULL_SHA.test(expectedCandidateSha), "expected history-repair candidate SHA must be lowercase and full");
  assert(FULL_SHA.test(expectedIntroductionSha), "expected introduction SHA must be lowercase and full");
  assert(FULL_SHA.test(expectedIntroductionTree), "expected introduction tree must be lowercase and full");
  assert(candidate.sha !== expectedIntroductionSha, "history-repair candidate must not be the introduction commit itself");
  same(candidate.schemaVersion, 2, "history-repair candidate schemaVersion");
  same(candidate.repository, expectedRepository, "history-repair candidate repository");
  same(candidate.workflow, "CI", "history-repair candidate workflow");
  same(candidate.runId, expectedRunId, "history-repair candidate runId");
  same(candidate.eventName, "workflow_dispatch", "history-repair candidate eventName");
  same(candidate.sha, expectedCandidateSha, "history-repair candidate sha");
  same(candidate.tree, expectedIntroductionTree, "history-repair candidate tree");
  same(candidateCommitTree, expectedIntroductionTree, "history-repair candidate commit tree");
  same(candidateRemoteSha, expectedCandidateSha, "history-repair candidate remote branch tip");
  assert(Number.isSafeInteger(candidate.runAttempt) && candidate.runAttempt > 0, "history-repair candidate runAttempt is invalid");
  assert(
    typeof candidate.ref === "string"
      && candidate.ref.startsWith("refs/heads/")
      && candidate.ref !== "refs/heads/main",
    `history-repair candidate ref must be a non-main branch, got ${candidate.ref}`,
  );
  same(
    candidate.workflowRef,
    `${expectedRepository}/.github/workflows/ci.yml@${candidate.ref}`,
    "history-repair candidate workflowRef",
  );

  const expectedPlan = affectedPlanBinding(
    planPath,
    candidate.affectedPlan.wasixReleaseRegressionRequired,
  );
  assertBindingMatches(candidate.affectedPlan, expectedPlan, "history-repair candidate affected plan");
  return Object.freeze({
    branch: candidate.ref.slice("refs/heads/".length),
    sha: candidate.sha,
    tree: candidate.tree,
  });
}
