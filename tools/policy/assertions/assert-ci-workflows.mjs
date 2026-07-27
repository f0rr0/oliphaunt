#!/usr/bin/env bun
import process from "node:process";

import { BUILDER_JOBS } from "../../graph/ci_plan.mjs";
import { captureCommandOutput } from "../../dev/capture-command-output.mjs";
import { assertStableWorkflowInvariants } from "./workflow-semantics.mjs";

function workspaceRoot() {
  const result = captureCommandOutput("git", ["rev-parse", "--show-toplevel"], {
    label: "git rev-parse --show-toplevel",
  });
  return result.status === 0 && result.stdout.trim() ? result.stdout.trim() : process.cwd();
}

if (process.argv.includes("--help")) {
  console.log("usage: assert-ci-workflows.mjs");
  process.exit(0);
}

const root = workspaceRoot();
try {
  assertStableWorkflowInvariants(root, { builderJobs: [...BUILDER_JOBS] });
  console.log("semantic CI, mobile E2E, and release workflow invariants passed");
} catch (cause) {
  console.error(cause instanceof Error ? cause.message : String(cause));
  process.exit(1);
}
