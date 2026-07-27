#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import process from "node:process";

import { captureCommandOutput } from "../../tools/dev/capture-command-output.mjs";
import {
  RELEASE_PLEASE_HISTORY_REPAIR_BEFORE_SHA,
  RELEASE_PLEASE_HISTORY_REPAIR_CANDIDATE_BRANCH,
} from "../../tools/release/release-please-bootstrap.mjs";
import { verifyHistoryRepairCandidateBinding } from "./history-repair-candidate-lib.mjs";

function fail(message) {
  console.error(message);
  process.exit(1);
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) fail(`${name} is required`);
  return value;
}

function git(args, { acceptStatusOne = false } = {}) {
  const result = captureCommandOutput("git", args, { label: `git ${args.join(" ")}` });
  if (result.error || (result.status !== 0 && !(acceptStatusOne && result.status === 1))) {
    fail(result.stderr?.trim() || result.error?.message || `git ${args.join(" ")} failed`);
  }
  return { status: result.status, stdout: result.stdout.trim().toLowerCase() };
}

const [candidatePath, planFlag, planPath, ...extra] = process.argv.slice(2);
if (!candidatePath || planFlag !== "--plan" || !planPath || extra.length > 0) {
  fail("usage: verify-history-repair-candidate.mjs <candidate-json> --plan <ci-plan.json>");
}

let candidate;
try {
  candidate = JSON.parse(readFileSync(candidatePath, "utf8"));
} catch (error) {
  fail(`invalid history-repair candidate ${candidatePath}: ${error.message}`);
}

const expectedCandidateSha = requiredEnv("HISTORY_REPAIR_CANDIDATE_SHA").toLowerCase();
const expectedIntroductionSha = requiredEnv("HISTORY_REPAIR_HEAD_SHA").toLowerCase();
const expectedIntroductionTree = git(["rev-parse", `${expectedIntroductionSha}^{tree}`]).stdout;
const candidateCommitTree = git(["rev-parse", `${expectedCandidateSha}^{tree}`]).stdout;
const expectedCandidateRef = `refs/heads/${RELEASE_PLEASE_HISTORY_REPAIR_CANDIDATE_BRANCH}`;
if (candidate.ref !== expectedCandidateRef) {
  fail(
    `history-repair candidate ref must be ${expectedCandidateRef}, got ${candidate.ref}`,
  );
}
const branch = RELEASE_PLEASE_HISTORY_REPAIR_CANDIDATE_BRANCH;
if (git(["check-ref-format", "--branch", branch], {
  acceptStatusOne: true,
}).status !== 0) {
  fail(`history-repair candidate ref is not a canonical branch: ${candidate.ref}`);
}
const candidateRemoteSha = git(["rev-parse", `refs/remotes/origin/${branch}^{commit}`]).stdout;
if (git([
  "merge-base",
  "--is-ancestor",
  `${RELEASE_PLEASE_HISTORY_REPAIR_BEFORE_SHA}^{commit}`,
  `${expectedCandidateSha}^{commit}`,
], { acceptStatusOne: true }).status !== 0) {
  fail(
    `history-repair candidate ${expectedCandidateSha} is not descended from the exact superseded main tip `
      + RELEASE_PLEASE_HISTORY_REPAIR_BEFORE_SHA,
  );
}

try {
  verifyHistoryRepairCandidateBinding({
    candidate,
    candidateCommitTree,
    candidateRemoteSha,
    expectedCandidateSha,
    expectedIntroductionSha,
    expectedIntroductionTree,
    expectedRepository: requiredEnv("GITHUB_REPOSITORY"),
    expectedRunId: requiredEnv("CI_RUN_ID"),
    planPath,
  });
} catch (error) {
  fail(error.message);
}

console.log(
  `verified history-repair introduction tree ${expectedIntroductionTree} against qualified transport candidate `
    + `${expectedCandidateSha}`,
);
