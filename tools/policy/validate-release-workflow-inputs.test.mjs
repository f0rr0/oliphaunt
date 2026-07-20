#!/usr/bin/env bun

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";

const ROOT = path.resolve(import.meta.dir, "../..");
const SCRIPT = path.join(ROOT, ".github/scripts/validate-release-workflow-inputs.sh");
const SHA = "84d90b9853530ab72e48a1aa6fb616aaed7a0dc6";

function validate({
  operation = "prepare-release-pr",
  releaseCommit = "",
  continuationPointer = "",
  workflowSha = SHA,
} = {}) {
  const result = spawnSync("bash", [SCRIPT], {
    cwd: ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      GITHUB_SHA: workflowSha,
      RELEASE_OPERATION: operation,
      RELEASE_COMMIT: releaseCommit,
      RELEASE_CONTINUATION_POINTER: continuationPointer,
    },
  });
  return {
    status: result.status,
    output: `${result.stdout}${result.stderr}`,
  };
}

test("accepts every supported root operation with its implicit workflow commit", () => {
  for (const operation of ["prepare-release-pr", "publish-dry-run", "publish-bootstrap", "publish"]) {
    const result = validate({ operation });
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

test("accepts continuations only for publish operations with the exact commit assertion", () => {
  for (const operation of ["publish", "publish-bootstrap"]) {
    const result = validate({ operation, releaseCommit: SHA, continuationPointer: "verified-pointer" });
    assert.equal(result.status, 0, `${operation}: ${result.output}`);
  }

  for (const operation of ["prepare-release-pr", "publish-dry-run"]) {
    const result = validate({ operation, releaseCommit: SHA, continuationPointer: "verified-pointer" });
    assert.notEqual(result.status, 0, `${operation} unexpectedly accepted a continuation`);
    assert.match(result.output, /continuation_pointer is not valid/u);
  }
});

test("rejects a continuation without an explicit exact commit assertion", () => {
  const result = validate({ operation: "publish", continuationPointer: "verified-pointer" });
  assert.notEqual(result.status, 0, result.output);
  assert.match(result.output, /automatic continuation requires release_commit/u);
});

test("rejects an oversized continuation pointer", () => {
  const result = validate({
    operation: "publish",
    releaseCommit: SHA,
    continuationPointer: "x".repeat(32769),
  });
  assert.notEqual(result.status, 0, result.output);
  assert.match(result.output, /32 KiB transport bound/u);
});

test("rejects unsupported operations and malformed workflow identities", () => {
  const unsupported = validate({ operation: "delete-everything" });
  assert.notEqual(unsupported.status, 0, unsupported.output);
  assert.match(unsupported.output, /Unsupported release operation/u);

  const malformedSha = validate({ workflowSha: "84d90b9" });
  assert.notEqual(malformedSha.status, 0, malformedSha.output);
  assert.match(malformedSha.output, /GITHUB_SHA must be a full 40-character commit SHA/u);
});
