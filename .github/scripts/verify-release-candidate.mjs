#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import process from "node:process";

import { captureCommandOutput } from "../../tools/dev/capture-command-output.mjs";

import {
  affectedPlanBinding,
  assertBindingMatches,
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

function parseArgs(argv) {
  const candidatePath = argv[0];
  const values = new Map();
  for (let index = 1; index < argv.length; index += 1) {
    const name = argv[index];
    if (!["--plan", "--wasix-evidence-required", "--wasix-evidence-root"].includes(name)) {
      fail(`unknown argument: ${name}`);
    }
    if (index + 1 >= argv.length) {
      fail(`${name} requires a value`);
    }
    values.set(name.slice(2), argv[index + 1]);
    index += 1;
  }
  if (!candidatePath || !values.has("plan") || !values.has("wasix-evidence-required")) {
    fail(
      "usage: verify-release-candidate.mjs <candidate-json> --plan <ci-plan.json> "
      + "--wasix-evidence-required true|false [--wasix-evidence-root <directory>]",
    );
  }
  const required = values.get("wasix-evidence-required");
  if (!["true", "false"].includes(required)) {
    fail("--wasix-evidence-required must be true or false");
  }
  if (required === "true" && !values.has("wasix-evidence-root")) {
    fail("--wasix-evidence-root is required when WASIX evidence is required");
  }
  return {
    candidatePath,
    planPath: values.get("plan"),
    wasixEvidenceRequired: required === "true",
    wasixEvidenceRoot: values.get("wasix-evidence-root"),
  };
}

const args = parseArgs(process.argv.slice(2));

let candidate;
try {
  candidate = JSON.parse(readFileSync(args.candidatePath, "utf8"));
} catch (error) {
  fail(`invalid release candidate ${args.candidatePath}: ${error.message}`);
}

try {
  assertCandidateBindingShape(candidate);
} catch (error) {
  fail(error.message);
}

const expected = {
  repository: requiredEnv("GITHUB_REPOSITORY"),
  runId: requiredEnv("CI_RUN_ID"),
  sha: requiredEnv("RELEASE_HEAD_SHA").toLowerCase(),
};
const expectedTree = git(["rev-parse", `${expected.sha}^{tree}`]).toLowerCase();

for (const [field, value] of Object.entries({
  schemaVersion: 2,
  repository: expected.repository,
  workflow: "CI",
  runId: expected.runId,
  ref: "refs/heads/main",
  sha: expected.sha,
  tree: expectedTree,
})) {
  if (candidate?.[field] !== value) {
    fail(`release candidate ${field} mismatch: expected ${value}, got ${candidate?.[field]}`);
  }
}

if (!["push", "workflow_dispatch"].includes(candidate.eventName)) {
  fail(`release candidate event must be push or workflow_dispatch, got ${candidate.eventName}`);
}
if (!Number.isSafeInteger(candidate.runAttempt) || candidate.runAttempt < 1) {
  fail(`release candidate has invalid runAttempt: ${candidate.runAttempt}`);
}
if (typeof candidate.workflowRef !== "string" || !candidate.workflowRef.includes("/.github/workflows/ci.yml@")) {
  fail(`release candidate has invalid workflowRef: ${candidate.workflowRef}`);
}

let expectedPlan;
try {
  expectedPlan = affectedPlanBinding(
    args.planPath,
    candidate.affectedPlan.wasixReleaseRegressionRequired,
  );
} catch (error) {
  fail(error.message);
}
try {
  assertBindingMatches(candidate.affectedPlan, expectedPlan, "release candidate affected plan");
} catch (error) {
  fail(error.message);
}

if (args.wasixEvidenceRequired) {
  if (!candidate.evidenceRequirements.wasixReleaseRegression) {
    fail("selected release products require WASIX evidence, but the qualified CI plan did not require it");
  }
  let evidence;
  try {
    evidence = wasixEvidenceBinding(args.wasixEvidenceRoot, {
      repository: expected.repository,
      workflow: "CI",
      runId: expected.runId,
      runAttempt: candidate.runAttempt,
      sha: expected.sha,
      tree: expectedTree,
    });
  } catch (error) {
    fail(error.message);
  }
  try {
    assertBindingMatches(
      candidate.evidence.wasixReleaseRegression,
      evidence,
      "release candidate WASIX evidence",
    );
  } catch (error) {
    fail(error.message);
  }
}

console.log(`verified qualified CI run ${candidate.runId} for ${candidate.sha}`);
