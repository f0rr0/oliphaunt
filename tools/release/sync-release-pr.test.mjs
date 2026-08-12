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
  sharedContribBootstrapRequired,
  syncExampleCargoManifestText,
  syncLockfile,
  syncTypescriptOptionalRuntimeDependencies,
} from "./sync-release-pr.mjs";

const ROOT = path.resolve(import.meta.dir, "../..");
const SUMMARY_PATH = "src/extensions/generated/docs/extension-evidence.json";
const CHECKER_PATH = "src/extensions/tools/check-extension-model.mjs";
const EVIDENCE_SELF_TEST_PROCESS_TIMEOUT_MS = 15_000;

test("shared contrib bootstrap is allowed only from unreleased main state", () => {
  assert.equal(
    sharedContribBootstrapRequired([], () => [{ product: "liboliphaunt-native" }]),
    true,
  );
  assert.equal(sharedContribBootstrapRequired([], () => []), false);
  let discoveries = 0;
  assert.equal(
    sharedContribBootstrapRequired(
      [{ product: "liboliphaunt-native", before: "0.1.0", after: "0.1.1" }],
      () => {
        discoveries += 1;
        throw new Error("released main must not run shared candidate discovery");
      },
    ),
    false,
    "a released or pending main transition must not seed another release PR",
  );
  assert.equal(discoveries, 0);
});

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

test("release commit inventory owns the workspace Cargo lock", () => {
  const inventory = releaseDerivedPathInventory();
  assert.equal(inventory.includes("Cargo.lock"), true);
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
  const directory = mkdtempSync(path.join(os.tmpdir(), "oliphaunt-release-lock-"));
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

test("release sync closes registry example pins and runtime metadata across Cargo scopes", () => {
  const target = 'cfg(all(target_os = "linux", target_arch = "x86_64", target_env = "gnu"))';
  const policy = {
    crateDir: "fixture",
    runtime: {
      product: "liboliphaunt-native",
      productParts: ["package", "metadata", "oliphaunt", "runtime"],
    },
  };
  const dependency = (name, entryParts) => ({
    kind: "dependency",
    name,
    entryParts,
    expected: "=0.1.1",
  });
  const bindings = [
    dependency("oliphaunt-build", ["build-dependencies", "oliphaunt-build"]),
    dependency("oliphaunt", ["dependencies", "oliphaunt"]),
    dependency("oliphaunt-dev", ["dev-dependencies", "oliphaunt-dev"]),
    dependency("oliphaunt-target", ["target", target, "dependencies", "oliphaunt-target"]),
    {
      kind: "runtime",
      name: "runtime-version",
      entryParts: ["package", "metadata", "oliphaunt", "runtime-version"],
      expected: "0.1.1",
    },
  ];
  const initial = `[package]
name = "fixture"
version = "0.0.0"

[package.metadata.oliphaunt]
runtime = "liboliphaunt-native"
runtime-version = "0.1.0" # exact native payload contract

[build-dependencies]
oliphaunt-build = { version = "=0.1.0" }

[dependencies]
oliphaunt = "=0.1.0"

[dev-dependencies]
'oliphaunt-dev' = { version = '=0.1.0', optional = false }

[target.'${target}'.dependencies]
oliphaunt-target = { version = "=0.1.0", features = [
  "preserved-feature",
] }
`;

  const first = syncExampleCargoManifestText(initial, { policy, bindings, label: "fixture/Cargo.toml" });
  assert.equal(first.details.length, 5);
  assert.equal((first.text.match(/0[.]1[.]1/gu) ?? []).length, 5);
  assert.equal(first.text.includes("0.1.0"), false);
  assert.match(first.text, /features = \[\n  "preserved-feature",\n\]/u);
  assert.match(first.text, /runtime-version = "0[.]1[.]1" # exact native payload contract/u);

  const second = syncExampleCargoManifestText(first.text, { policy, bindings, label: "fixture/Cargo.toml" });
  assert.equal(second.text, first.text);
  assert.deepEqual(second.details, []);

  const duplicate = initial.replace("[dev-dependencies]\n", "[dev-dependencies]\noliphaunt = \"=0.1.0\"\n");
  assert.throws(
    () => syncExampleCargoManifestText(duplicate, { policy, bindings, label: "fixture/Cargo.toml" }),
    /must declare oliphaunt exactly once.*found 2/u,
  );
  const unsupported = initial.replace('oliphaunt = "=0.1.0"', "oliphaunt = true");
  assert.throws(
    () => syncExampleCargoManifestText(unsupported, { policy, bindings, label: "fixture/Cargo.toml" }),
    /must use a string or inline-table dependency specification/u,
  );
});

test("a JavaScript release transition synchronizes its optional runtime versions", async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "oliphaunt-js-runtime-sync-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const packageFile = path.join(directory, "package.json");
  writeFileSync(
    packageFile,
    `${JSON.stringify({
      name: "fixture",
      optionalDependencies: {
        "@oliphaunt/liboliphaunt-native": "workspace:0.1.0",
        "@oliphaunt/liboliphaunt-wasix": "workspace:0.1.0",
      },
    }, null, 2)}\n`,
  );
  const changes = [];
  await syncTypescriptOptionalRuntimeDependencies(changes, {
    write: true,
    transitions: [{ product: "oliphaunt-js" }],
    packageFile,
    runtimeVersions: {
      "@oliphaunt/liboliphaunt-native": "workspace:0.1.1",
      "@oliphaunt/liboliphaunt-wasix": "workspace:0.2.0",
    },
  });

  assert.deepEqual(JSON.parse(readFileSync(packageFile, "utf8")).optionalDependencies, {
    "@oliphaunt/liboliphaunt-native": "workspace:0.1.1",
    "@oliphaunt/liboliphaunt-wasix": "workspace:0.2.0",
  });
  assert.equal(changes.length, 1);
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
