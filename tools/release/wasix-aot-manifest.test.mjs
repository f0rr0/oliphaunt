#!/usr/bin/env bun
import assert from "node:assert/strict";
import test from "node:test";

import {
  assertCanonicalWasixAotManifest,
  canonicalWasixAotMetadata,
} from "./wasix-aot-manifest.mjs";

function manifest(overrides = {}) {
  const canonical = canonicalWasixAotMetadata();
  return {
    "format-version": 1,
    "source-lane": canonical.sourceLane,
    "target-triple": "x86_64-unknown-linux-gnu",
    engine: canonical.engine,
    "wasmer-version": canonical.wasmerVersion,
    "wasmer-wasix-version": canonical.wasmerWasixVersion,
    artifacts: [{ name: "runtime:oliphaunt", path: "oliphaunt.aot.zst" }],
    ...overrides,
  };
}

test("accepts AOT metadata that exactly matches the canonical WASIX toolchain", () => {
  assert.doesNotThrow(() =>
    assertCanonicalWasixAotManifest(manifest(), {
      expectedTarget: "x86_64-unknown-linux-gnu",
    }),
  );
});

test("rejects stale prerelease Wasmer metadata", () => {
  assert.throws(
    () =>
      assertCanonicalWasixAotManifest(
        manifest({
          "wasmer-version": "7.2.0-alpha.3",
          "wasmer-wasix-version": "0.702.0-alpha.3",
        }),
        { expectedTarget: "x86_64-unknown-linux-gnu" },
      ),
    /wasmer-version must match canonical WASIX metadata/u,
  );
});

test("rejects stale prerelease Wasmer-WASIX metadata", () => {
  assert.throws(
    () =>
      assertCanonicalWasixAotManifest(
        manifest({ "wasmer-wasix-version": "0.702.0-alpha.3" }),
        { expectedTarget: "x86_64-unknown-linux-gnu" },
      ),
    /wasmer-wasix-version must match canonical WASIX metadata/u,
  );
});

test("rejects an AOT archive labeled for another target", () => {
  assert.throws(
    () =>
      assertCanonicalWasixAotManifest(manifest(), {
        expectedTarget: "aarch64-apple-darwin",
      }),
    /target-triple must match canonical WASIX metadata/u,
  );
});
