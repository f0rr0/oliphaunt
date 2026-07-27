#!/usr/bin/env bun

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { verifyWasixQualificationBuild } from "./verify-extension-qualification-build.mjs";

function fixture(overrides = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "oliphaunt-qualification-build-"));
  mkdirSync(path.join(root, "extensions"));
  const bytes = Buffer.from("candidate-wasix-archive\n");
  writeFileSync(path.join(root, "extensions/fixture_extension.tar.zst"), bytes);
  const row = {
    "sql-name": "fixture_extension",
    archive: "extensions/fixture_extension.tar.zst",
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.length,
    stable: false,
    "smoke-status": { promoted: false },
    ...overrides,
  };
  writeFileSync(path.join(root, "manifest.json"), `${JSON.stringify({ extensions: [row] }, null, 2)}\n`);
  return root;
}

test("accepts a non-public deferred WASIX candidate with exact archive identity", () => {
  const root = fixture();
  try {
    assert.deepEqual(
      verifyWasixQualificationBuild({ assetRoot: root, sqlNames: ["fixture_extension"] }).sqlNames,
      ["fixture_extension"],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects promotion or byte drift in deferred WASIX candidate output", () => {
  const promoted = fixture({ stable: true, "smoke-status": { promoted: true } });
  try {
    assert.throws(
      () => verifyWasixQualificationBuild({ assetRoot: promoted, sqlNames: ["fixture_extension"] }),
      /must remain stable=false and promoted=false/u,
    );
  } finally {
    rmSync(promoted, { recursive: true, force: true });
  }

  const drifted = fixture({ sha256: "0".repeat(64) });
  try {
    assert.throws(
      () => verifyWasixQualificationBuild({ assetRoot: drifted, sqlNames: ["fixture_extension"] }),
      /size or SHA-256/u,
    );
  } finally {
    rmSync(drifted, { recursive: true, force: true });
  }
});
