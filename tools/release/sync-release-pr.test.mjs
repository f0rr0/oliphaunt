#!/usr/bin/env bun
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  extensionEvidenceSummaryCommand,
  releaseDerivedPathInventory,
} from "./sync-release-pr.mjs";

const ROOT = path.resolve(import.meta.dir, "../..");
const SUMMARY_PATH = "src/extensions/generated/docs/extension-evidence.json";
const CHECKER_PATH = "src/extensions/tools/check-extension-model.mjs";
const EVIDENCE_SELF_TEST_PROCESS_TIMEOUT_MS = 15_000;

test("release sync selects the narrow evidence-summary mutation", () => {
  assert.deepEqual(extensionEvidenceSummaryCommand({ write: true }), [
    process.execPath,
    CHECKER_PATH,
    "--write-evidence-summary",
  ]);
  assert.deepEqual(extensionEvidenceSummaryCommand({ write: false }), [
    process.execPath,
    CHECKER_PATH,
    "--check",
  ]);
});

test("release commit inventory owns the deterministic evidence summary", () => {
  assert.equal(releaseDerivedPathInventory().includes(SUMMARY_PATH), true);
});

test("release sync refreshes the evidence summary after the asset fingerprint", () => {
  const source = readFileSync(path.join(ROOT, "tools/release/sync-release-pr.mjs"), "utf8");
  const fingerprintCall = source.indexOf("syncAssetInputFingerprint(changes, { write });");
  const summaryCall = source.indexOf("syncExtensionEvidenceSummary(changes, { write });");
  assert.notEqual(fingerprintCall, -1);
  assert.notEqual(summaryCall, -1);
  assert.equal(fingerprintCall < summaryCall, true);
});

test("extension evidence self-test proves summary writes preserve immutable inputs", () => {
  const result = spawnSync(
    "python3",
    ["src/extensions/tools/check-extension-model.py", "--self-test", "--check"],
    {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      timeout: EVIDENCE_SELF_TEST_PROCESS_TIMEOUT_MS,
    },
  );
  assert.equal(
    result.status,
    0,
    [result.stdout, result.stderr].filter(Boolean).join("\n"),
  );
});
