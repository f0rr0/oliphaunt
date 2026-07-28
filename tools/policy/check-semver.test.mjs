#!/usr/bin/env bun
import assert from "node:assert/strict";
import test from "node:test";

import { semverCheckPlan } from "./check-semver.mjs";

const base = {
  currentVersion: "0.0.0",
  initialVersion: "0.1.0",
  parentVersion: null,
  publicTags: [],
};

test("an explicitly unreleased crate does not require a fictitious registry baseline", () => {
  assert.deepEqual(semverCheckPlan(base), { kind: "unreleased" });
});

test("the exact first release compares against its introduction parent", () => {
  assert.deepEqual(
    semverCheckPlan({ ...base, currentVersion: "0.1.0", parentVersion: "0.0.0" }),
    { kind: "first-release", baselineRev: "HEAD^" },
  );
});

test("a published product uses its registry baseline", () => {
  assert.deepEqual(
    semverCheckPlan({ ...base, currentVersion: "0.2.0", publicTags: ["oliphaunt-wasix-rust-v0.1.0"] }),
    { kind: "registry" },
  );
});

test("missing tags cannot silently turn a later release into a first release", () => {
  assert.throws(
    () => semverCheckPlan({ ...base, currentVersion: "0.2.0", parentVersion: "0.1.0" }),
    /not the exact first-release transition/u,
  );
  assert.throws(
    () => semverCheckPlan({ ...base, currentVersion: "0.2.0", parentVersion: "0.0.0" }),
    /not the exact first-release transition/u,
  );
});

test("public tags and an unreleased manifest are rejected as contradictory", () => {
  assert.throws(
    () => semverCheckPlan({ ...base, publicTags: ["oliphaunt-wasix-rust-v0.1.0"] }),
    /public product tags exist/u,
  );
});
