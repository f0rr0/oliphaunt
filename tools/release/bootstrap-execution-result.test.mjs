#!/usr/bin/env bun

import assert from "node:assert/strict";
import test from "node:test";

import { validateBootstrapExecutionResult } from "./bootstrap-execution-result.mjs";

const digest = "a".repeat(64);
const deferred = {
  schema: "oliphaunt-bootstrap-execution-result-v1",
  operation: "publish-bootstrap",
  decision: "deferred",
  deferralMode: "progress",
  source: { commit: "b".repeat(40), tree: "c".repeat(40) },
  lock: { catalogDigest: digest, lockDigest: digest, packageEnvelopeDigest: digest },
  products: ["sdk"],
  admittedIds: ["cargo:a", "cargo:b"],
  completedIds: ["cargo:a"],
  newlyCompletedIds: ["cargo:a"],
  remainingIds: ["cargo:b"],
  notBeforeEpochSeconds: 1_800_000_000,
};

test("bootstrap deferrals preserve a disjoint, lock-bound progress decision", () => {
  assert.equal(validateBootstrapExecutionResult(deferred).decision, "deferred");
  assert.throws(
    () => validateBootstrapExecutionResult({ ...deferred, completedIds: ["cargo:a", "cargo:b"] }),
    /must be disjoint/u,
  );
  assert.throws(
    () => validateBootstrapExecutionResult({ ...deferred, newlyCompletedIds: [] }),
    /requires nonzero newly completed IDs/u,
  );
});
