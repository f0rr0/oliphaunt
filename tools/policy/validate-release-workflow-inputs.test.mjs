#!/usr/bin/env bun

import assert from "node:assert/strict";
import { spawnSync } from "../test/fd-backed-spawn-sync.mjs";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const ROOT = path.resolve(import.meta.dir, "../..");
const SCRIPT = path.join(ROOT, ".github/scripts/validate-release-workflow-inputs.sh");
const SHA = "84d90b9853530ab72e48a1aa6fb616aaed7a0dc6";
const BASH = process.env.OLIPHAUNT_TEST_BASH
  ?? (process.platform === "darwin" ? "/bin/bash" : "bash");

function validate({
  operation = "prepare-release-pr",
  releaseCommit = "",
  continuationPointer = "",
  workflowSha = SHA,
  workflowRef,
} = {}) {
  const resolvedWorkflowRef = workflowRef ?? (
    continuationPointer === ""
      ? "refs/heads/main"
      : `refs/tags/oliphaunt-release-transport/${workflowSha.toLowerCase()}`
  );
  const result = spawnSync(BASH, [SCRIPT], {
    cwd: ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      GITHUB_REF: resolvedWorkflowRef,
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

test("remains compatible with the stock macOS Bash 3.2 feature set", () => {
  const source = readFileSync(SCRIPT, "utf8");
  for (const [feature, pattern] of [
    ["case-transforming parameter expansion", /\$\{[^}\n]*(?:,,|\^\^)[^}\n]*\}/u],
    ["associative arrays", /\b(?:declare|local|typeset)\s+(?:-[A-Za-z]*A[A-Za-z]*\s+)/u],
    ["nameref variables", /\b(?:declare|local|typeset)\s+(?:-[A-Za-z]*n[A-Za-z]*\s+)/u],
    ["mapfile/readarray", /\b(?:mapfile|readarray)\b/u],
    ["coprocesses", /(?:^|\n)\s*coproc\b/u],
  ]) {
    assert.doesNotMatch(source, pattern, `${feature} requires Bash newer than 3.2`);
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

test("root operations are main-only and continuations are exact transport-ref-only", () => {
  const rootOnTag = validate({
    operation: "publish",
    workflowRef: `refs/tags/oliphaunt-release-transport/${SHA}`,
  });
  assert.notEqual(rootOnTag.status, 0, rootOnTag.output);
  assert.match(rootOnTag.output, /root release operations must execute from refs\/heads\/main/u);

  for (const workflowRef of [
    "refs/heads/main",
    `refs/tags/oliphaunt-release-transport/${"1".repeat(40)}`,
    `refs/tags/unrelated/${SHA}`,
  ]) {
    const continuation = validate({
      continuationPointer: "verified-pointer",
      operation: "publish",
      releaseCommit: SHA,
      workflowRef,
    });
    assert.notEqual(continuation.status, 0, `${workflowRef} unexpectedly accepted`);
    assert.match(continuation.output, /exact immutable transport ref/u);
  }

  const uppercaseIdentity = validate({
    continuationPointer: "verified-pointer",
    operation: "publish-bootstrap",
    releaseCommit: SHA.toUpperCase(),
    workflowRef: `refs/tags/oliphaunt-release-transport/${SHA}`,
    workflowSha: SHA.toUpperCase(),
  });
  assert.equal(uppercaseIdentity.status, 0, uppercaseIdentity.output);
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
