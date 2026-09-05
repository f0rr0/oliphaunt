#!/usr/bin/env bun

import assert from "node:assert/strict";
import { spawnSync } from "../test/fd-backed-spawn-sync.mjs";
import path from "node:path";
import test from "node:test";

const ROOT = path.resolve(import.meta.dir, "../..");
const SCRIPT = path.join(ROOT, ".github/scripts/validate-release-workflow-inputs.sh");
const SHA = "84d90b9853530ab72e48a1aa6fb616aaed7a0dc6";
const BASH = process.env.OLIPHAUNT_TEST_BASH
  ? path.resolve(ROOT, process.env.OLIPHAUNT_TEST_BASH)
  : (process.platform === "darwin" ? "/bin/bash" : "bash");

function validate({
  operation = "prepare-release-pr",
  releaseCommit = "",
  approvalRunId = "",
  workflowSha = SHA,
  workflowRef = "refs/heads/main",
} = {}) {
  const result = spawnSync(BASH, [SCRIPT], {
    cwd: ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      GITHUB_REF: workflowRef,
      GITHUB_SHA: workflowSha,
      RELEASE_OPERATION: operation,
      RELEASE_COMMIT: releaseCommit,
      RELEASE_APPROVAL_RUN_ID: approvalRunId,
    },
  });
  return {
    status: result.status,
    output: `${result.stdout}${result.stderr}`,
  };
}

test("accepts every supported root operation with its implicit workflow commit", () => {
  for (const operation of ["prepare-release-pr", "publish-dry-run", "publish-bootstrap", "publish"]) {
    const approvalRunId = operation === "publish" || operation === "publish-bootstrap" ? "33989155433" : "";
    const result = validate({ operation, approvalRunId });
    assert.equal(result.status, 0, `${operation}: ${result.output}`);
  }
});

test("accepts a supplied exact release commit assertion without case sensitivity", () => {
  for (const releaseCommit of [SHA, SHA.toUpperCase()]) {
    const result = validate({ releaseCommit });
    assert.equal(result.status, 0, result.output);
  }
});

test("rejects malformed and stale release commit assertions before every operation", () => {
  for (const [operation, releaseCommit] of [
    ["prepare-release-pr", "84d90b9"],
    ["publish-dry-run", "1111111111111111111111111111111111111111"],
    ["publish-bootstrap", "1111111111111111111111111111111111111111"],
    ["publish", "1111111111111111111111111111111111111111"],
  ]) {
    const result = validate({ operation, releaseCommit });
    assert.notEqual(result.status, 0, `${operation} unexpectedly accepted ${releaseCommit}`);
    assert.match(result.output, /release_commit must (?:be a full 40-character commit SHA|equal the exact workflow SHA)/u);
  }
});

test("release operations are main-only", () => {
  const rootOnTag = validate({
    operation: "publish",
    approvalRunId: "33989155433",
    workflowRef: `refs/tags/oliphaunt-release-transport/${SHA}`,
  });
  assert.notEqual(rootOnTag.status, 0, rootOnTag.output);
  assert.match(rootOnTag.output, /release operations must execute from refs\/heads\/main/u);
});

test("requires one pinned approval run only for publish operations", () => {
  for (const operation of ["publish", "publish-bootstrap"]) {
    for (const approvalRunId of ["", "0", "latest", "12.5"]) {
      const result = validate({ operation, approvalRunId });
      assert.notEqual(result.status, 0, `${operation} unexpectedly accepted ${approvalRunId}`);
      assert.match(result.output, /requires approval_run_id/u);
    }
  }
  for (const operation of ["prepare-release-pr", "publish-dry-run"]) {
    const result = validate({ operation, approvalRunId: "33989155433" });
    assert.notEqual(result.status, 0, `${operation} unexpectedly accepted approval_run_id`);
    assert.match(result.output, /approval_run_id is not valid/u);
  }
});

test("rejects unsupported operations and malformed workflow identities", () => {
  const unsupported = validate({ operation: "delete-everything" });
  assert.notEqual(unsupported.status, 0, unsupported.output);
  assert.match(unsupported.output, /Unsupported release operation/u);

  const malformedSha = validate({ workflowSha: "84d90b9" });
  assert.notEqual(malformedSha.status, 0, malformedSha.output);
  assert.match(malformedSha.output, /GITHUB_SHA must be a full 40-character commit SHA/u);
});
