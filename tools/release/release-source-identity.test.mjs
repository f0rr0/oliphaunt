#!/usr/bin/env bun

import assert from "node:assert/strict";
import test from "node:test";

import { resolveReleaseSourceCommit } from "./release-source-identity.mjs";

const CONTROL = "a".repeat(40);
const SOURCE = "b".repeat(40);

test("normal publication defaults the immutable source to the control commit", () => {
  assert.equal(resolveReleaseSourceCommit({ controlCommit: CONTROL }), CONTROL);
  assert.equal(
    resolveReleaseSourceCommit({ controlCommit: CONTROL, sourceCommit: "  " }),
    CONTROL,
  );
});

test("same-version recovery retains a distinct immutable release source", () => {
  assert.equal(
    resolveReleaseSourceCommit({
      controlCommit: CONTROL,
      sourceCommit: ` ${SOURCE} `,
    }),
    SOURCE,
  );
});

test("release identities reject moving refs and malformed SHAs", () => {
  assert.throws(
    () => resolveReleaseSourceCommit({ controlCommit: "main" }),
    /control commit must be a full lowercase commit SHA/u,
  );
  assert.throws(
    () => resolveReleaseSourceCommit({
      controlCommit: CONTROL,
      sourceCommit: "release/v0.1.0",
    }),
    /source commit must be a full lowercase commit SHA/u,
  );
});
