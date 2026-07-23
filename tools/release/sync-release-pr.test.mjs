#!/usr/bin/env bun
import assert from "node:assert/strict";
import { spawnSync } from "../test/fd-backed-spawn-sync.mjs";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  cargoManifestPaths,
  extensionEvidenceSummaryCommand,
  releaseDerivedPathInventory,
  releaseSemanticFingerprintDerivedEntries,
  syncLockfile,
} from "./sync-release-pr.mjs";

const ROOT = path.resolve(import.meta.dir, "../..");
const SUMMARY_PATH = "src/extensions/generated/docs/extension-evidence.json";
const RUST_RELEASE_CONSUMER_LOCK = "src/sdks/rust/tests/release-consumer/Cargo.lock";
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

test("release commit inventory owns every tracked Cargo lock used by an exact consumer", () => {
  const inventory = releaseDerivedPathInventory();
  assert.equal(inventory.includes("Cargo.lock"), true);
  assert.equal(inventory.includes(RUST_RELEASE_CONSUMER_LOCK), true);
});

test("Cargo manifest inventory retains a successful child's final NUL record", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "oliphaunt-cargo-manifest-inventory-"));
  try {
    mkdirSync(path.join(directory, "nested"), { recursive: true });
    writeFileSync(path.join(directory, "Cargo.toml"), "[package]\nname = \"root\"\nversion = \"0.0.0\"\n");
    writeFileSync(path.join(directory, "nested/Cargo.toml"), "[package]\nname = \"nested\"\nversion = \"0.0.0\"\n");
    const stub = path.join(directory, "git-stub.mjs");
    writeFileSync(
      stub,
      [
        "process.stdout.write('Cargo.toml\\0');",
        "setImmediate(() => process.stdout.write('nested/Cargo.toml\\0'));",
        "",
      ].join("\n"),
    );
    assert.deepEqual(
      cargoManifestPaths({
        gitCommand: process.execPath,
        gitCommandArgs: [stub],
        root: directory,
      }),
      [path.join(directory, "Cargo.toml"), path.join(directory, "nested/Cargo.toml")],
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Cargo manifest inventory rejects a successful partial NUL record", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "oliphaunt-cargo-manifest-partial-"));
  try {
    const stub = path.join(directory, "git-stub.mjs");
    writeFileSync(stub, "process.stdout.write('Cargo.toml');\n");
    assert.throws(
      () => cargoManifestPaths({
        gitCommand: process.execPath,
        gitCommandArgs: [stub],
        root: directory,
      }),
      /missing its required terminal/u,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("release sync updates only unsourced local packages in a nested Cargo lock", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "oliphaunt-release-consumer-lock-"));
  try {
    const lockfile = path.join(directory, "Cargo.lock");
    const initial = `version = 4

[[package]]
name = "oliphaunt"
version = "0.0.0"

[[package]]
name = "serde"
version = "1.0.0"
source = "registry+https://github.com/rust-lang/crates.io-index"
`;
    writeFileSync(lockfile, initial);
    const versions = new Map([
      ["oliphaunt", "0.1.0"],
      ["serde", "9.9.9"],
    ]);
    const checkChanges = [];
    syncLockfile(lockfile, versions, checkChanges, { write: false });
    assert.equal(readFileSync(lockfile, "utf8"), initial);
    assert.deepEqual(checkChanges.map(({ detail }) => detail), ["oliphaunt 0.0.0 -> 0.1.0"]);

    const writeChanges = [];
    syncLockfile(lockfile, versions, writeChanges, { write: true });
    const updated = readFileSync(lockfile, "utf8");
    assert.match(updated, /name = "oliphaunt"\nversion = "0[.]1[.]0"/u);
    assert.match(updated, /name = "serde"\nversion = "1[.]0[.]0"\nsource =/u);
    assert.deepEqual(writeChanges.map(({ detail }) => detail), ["oliphaunt 0.0.0 -> 0.1.0"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("release sync refreshes the evidence summary after the asset fingerprint", () => {
  const source = readFileSync(path.join(ROOT, "tools/release/sync-release-pr.mjs"), "utf8");
  const fingerprintCall = source.indexOf("syncAssetInputFingerprint(changes, { write });");
  const summaryCall = source.indexOf("syncExtensionEvidenceSummary(changes, { write });");
  assert.notEqual(fingerprintCall, -1);
  assert.notEqual(summaryCall, -1);
  assert.equal(fingerprintCall < summaryCall, true);
});

test("release sync closes semantic fingerprints after every derived byte input", () => {
  const source = readFileSync(path.join(ROOT, "tools/release/sync-release-pr.mjs"), "utf8");
  const summaryCall = source.indexOf("syncExtensionEvidenceSummary(changes, { write });");
  const semanticCall = source.indexOf("syncDerivedReleaseSemanticFingerprints(changes, { write });");
  assert.notEqual(summaryCall, -1);
  assert.notEqual(semanticCall, -1);
  assert.equal(summaryCall < semanticCall, true);

  const inventory = new Set(releaseDerivedPathInventory());
  const entries = releaseSemanticFingerprintDerivedEntries();
  assert.equal(entries.length > 0, true);
  assert.equal(new Set(entries.map(({ product }) => product)).size, entries.length);
  assert.equal(new Set(entries.map(({ path: fingerprintPath }) => fingerprintPath)).size, entries.length);
  for (const { path: fingerprintPath } of entries) {
    assert.equal(inventory.has(fingerprintPath), true, fingerprintPath);
  }
});

test("generated release readiness closes the cheap pre-fanout fixed point", () => {
  const result = spawnSync(
    process.execPath,
    ["tools/release/sync-release-pr.mjs", "--check-generated-release"],
    {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      timeout: 10_000,
    },
  );
  assert.equal(
    result.status,
    0,
    [result.stdout, result.stderr].filter(Boolean).join("\n"),
  );
  assert.match(result.stdout, /release PR derived files are in sync/u);

  const conflicting = spawnSync(
    process.execPath,
    [
      "tools/release/sync-release-pr.mjs",
      "--check",
      "--check-generated-release",
    ],
    { cwd: ROOT, encoding: "utf8", timeout: 10_000 },
  );
  assert.equal(conflicting.status, 2);
  assert.match(conflicting.stderr, /mutually exclusive/u);
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
