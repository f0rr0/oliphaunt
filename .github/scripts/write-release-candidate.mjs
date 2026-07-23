#!/usr/bin/env bun
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import process from "node:process";

import { captureCommandOutput } from "../../tools/dev/capture-command-output.mjs";

import {
  affectedPlanBinding,
  assertCandidateBindingShape,
  wasixEvidenceBinding,
} from "./release-candidate-lib.mjs";

function fail(message) {
  console.error(message);
  process.exit(1);
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    fail(`${name} is required`);
  }
  return value;
}

function git(args) {
  const result = captureCommandOutput("git", args, {
    label: `git ${args.join(" ")}`,
  });
  if (result.error || result.status !== 0) {
    fail(result.stderr?.trim() || result.error?.message || `git ${args.join(" ")} failed`);
  }
  return result.stdout.trim();
}

const outputPath = process.argv[2] ?? "target/qualification/oliphaunt-release-candidate.json";
const expectedSha = requiredEnv("CI_HEAD_SHA").toLowerCase();
if (!/^[0-9a-f]{40}$/u.test(expectedSha)) {
  fail(`CI_HEAD_SHA must be a full commit SHA, got ${expectedSha}`);
}

const checkedOutSha = git(["rev-parse", "HEAD^{commit}"]).toLowerCase();
if (checkedOutSha !== expectedSha) {
  fail(`checked-out commit ${checkedOutSha} does not match CI_HEAD_SHA ${expectedSha}`);
}

const tree = git(["rev-parse", "HEAD^{tree}"]).toLowerCase();
const wasixRequiredRaw = requiredEnv("WASIX_RELEASE_REGRESSION_REQUIRED");
if (!["true", "false"].includes(wasixRequiredRaw)) {
  fail(`WASIX_RELEASE_REGRESSION_REQUIRED must be true or false, got ${wasixRequiredRaw}`);
}
const wasixRequired = wasixRequiredRaw === "true";
let affectedPlan;
try {
  affectedPlan = affectedPlanBinding(requiredEnv("CI_PLAN_PATH"), wasixRequired);
} catch (error) {
  fail(error.message);
}

const runAttempt = Number.parseInt(requiredEnv("GITHUB_RUN_ATTEMPT"), 10);
if (!Number.isSafeInteger(runAttempt) || runAttempt < 1) {
  fail(`invalid GITHUB_RUN_ATTEMPT: ${process.env.GITHUB_RUN_ATTEMPT}`);
}

let wasixEvidence = null;
if (wasixRequired) {
  try {
    wasixEvidence = wasixEvidenceBinding(requiredEnv("WASIX_EVIDENCE_ROOT"), {
      repository: requiredEnv("GITHUB_REPOSITORY"),
      workflow: requiredEnv("GITHUB_WORKFLOW"),
      runId: requiredEnv("GITHUB_RUN_ID"),
      runAttempt,
      sha: checkedOutSha,
      tree,
    });
  } catch (error) {
    fail(error.message);
  }
}

const candidate = {
  schemaVersion: 2,
  repository: requiredEnv("GITHUB_REPOSITORY"),
  workflow: requiredEnv("GITHUB_WORKFLOW"),
  workflowRef: requiredEnv("GITHUB_WORKFLOW_REF"),
  runId: requiredEnv("GITHUB_RUN_ID"),
  runAttempt,
  eventName: requiredEnv("GITHUB_EVENT_NAME"),
  ref: requiredEnv("GITHUB_REF"),
  sha: checkedOutSha,
  tree,
  affectedPlan,
  evidenceRequirements: {
    wasixReleaseRegression: wasixRequired,
    artifacts: wasixRequired ? ["wasix-release-regression-evidence"] : [],
  },
  evidence: {
    wasixReleaseRegression: wasixEvidence,
  },
};

try {
  assertCandidateBindingShape(candidate);
} catch (error) {
  fail(error.message);
}

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(candidate, null, 2)}\n`, "utf8");
console.log(`wrote release qualification record for ${candidate.sha} to ${outputPath}`);
