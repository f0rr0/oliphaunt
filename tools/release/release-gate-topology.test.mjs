import assert from "node:assert/strict";
import { execFileSync } from "../test/fd-backed-spawn-sync.mjs";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  MUTATION_TEST_PROCESS_CONCURRENCY,
  mutationTestCommand,
  mutationTestEnvironment,
  mutationTests,
  mutationTestWaves,
} from "./release-check.mjs";
import { uniqueValueFlag } from "./release-cli-utils.mjs";

test("release CLI value flags reject ambiguous duplicate identities", () => {
  assert.equal(
    uniqueValueFlag(["--head-ref", "a".repeat(40)], "--head-ref"),
    "a".repeat(40),
  );
  assert.equal(
    uniqueValueFlag(["--products-json=[\"sdk\"]"], "--products-json"),
    "[\"sdk\"]",
  );
  assert.throws(
    () => uniqueValueFlag(
      ["--head-ref", "a".repeat(40), `--head-ref=${"b".repeat(40)}`],
      "--head-ref",
    ),
    /--head-ref must be provided at most once/u,
  );
  assert.throws(
    () => uniqueValueFlag(
      ["--products-json=[\"sdk\"]", "--products-json", "[\"extension\"]"],
      "--products-json",
    ),
    /--products-json must be provided at most once/u,
  );
  assert.throws(
    () => uniqueValueFlag(
      ["--head-ref", `--head-ref=${"b".repeat(40)}`],
      "--head-ref",
    ),
    /--head-ref must be provided at most once/u,
  );
  assert.throws(
    () => uniqueValueFlag(["--head-ref"], "--head-ref"),
    /--head-ref requires a value/u,
  );
});

test("mutation test discovery includes repository sources but excludes ignored dependency trees", () => {
  const repository = mkdtempSync(path.join(tmpdir(), "oliphaunt-release-test-inventory-"));
  try {
    execFileSync("git", ["init", "--quiet"], { cwd: repository });
    mkdirSync(path.join(repository, "tools/release/node_modules/dependency"), { recursive: true });
    writeFileSync(path.join(repository, ".gitignore"), "node_modules/\n");
    writeFileSync(path.join(repository, "tools/release/owned.test.mjs"), "// tracked\n");
    writeFileSync(path.join(repository, "tools/release/deleted.test.mjs"), "// deleted\n");
    writeFileSync(path.join(repository, "tools/release/new.test.mjs"), "// untracked\n");
    writeFileSync(
      path.join(repository, "tools/release/node_modules/dependency/upstream.test.mjs"),
      "// ignored dependency\n",
    );
    execFileSync(
      "git",
      ["add", ".gitignore", "tools/release/owned.test.mjs", "tools/release/deleted.test.mjs"],
      { cwd: repository },
    );
    unlinkSync(path.join(repository, "tools/release/deleted.test.mjs"));

    assert.deepEqual(mutationTests("tools/release", { repositoryRoot: repository }), [
      "tools/release/new.test.mjs",
      "tools/release/owned.test.mjs",
    ]);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("mutation test waves preserve the exact ordered inventory across single-file processes", () => {
  const inventory = Array.from(
    { length: (MUTATION_TEST_PROCESS_CONCURRENCY * 2) + 3 },
    (_, index) => `tools/release/fixture-${String(index).padStart(2, "0")}.test.mjs`,
  );
  const waves = mutationTestWaves(inventory);

  assert.deepEqual(waves.map((wave) => wave.length), [
    MUTATION_TEST_PROCESS_CONCURRENCY,
    MUTATION_TEST_PROCESS_CONCURRENCY,
    3,
  ]);
  assert.deepEqual(waves.flat(), inventory);
  assert.deepEqual(mutationTestWaves([]), []);
  assert.throws(
    () => mutationTestWaves(inventory, 0),
    /process concurrency must be a positive integer/u,
  );
  for (const testFile of inventory) {
    const command = mutationTestCommand(testFile);
    assert.equal(command.at(-1), testFile);
    assert.equal(command.filter((argument) => argument.endsWith(".test.mjs")).length, 1);
  }
});

test("mutation test discovery retains a successful child's final inventory write", () => {
  const repository = mkdtempSync(path.join(tmpdir(), "oliphaunt-release-test-capture-"));
  try {
    mkdirSync(path.join(repository, "tools/release"), { recursive: true });
    writeFileSync(path.join(repository, "tools/release/first.test.mjs"), "// first\n");
    writeFileSync(path.join(repository, "tools/release/last.test.mjs"), "// last\n");
    const stub = path.join(repository, "git-stub.mjs");
    writeFileSync(
      stub,
      [
        "process.stdout.write('tools/release/first.test.mjs\\0');",
        "setImmediate(() => process.stdout.write('tools/release/last.test.mjs\\0'));",
        "",
      ].join("\n"),
    );
    chmodSync(stub, 0o755);
    assert.deepEqual(
      mutationTests("tools/release", {
        gitCommand: process.execPath,
        gitCommandArgs: [stub],
        repositoryRoot: repository,
      }),
      ["tools/release/first.test.mjs", "tools/release/last.test.mjs"],
    );
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("mutation test discovery rejects a successful partial NUL inventory", () => {
  const repository = mkdtempSync(path.join(tmpdir(), "oliphaunt-release-test-partial-"));
  try {
    const stub = path.join(repository, "git-stub.mjs");
    writeFileSync(stub, "process.stdout.write('tools/release/partial.test.mjs');\n");
    assert.throws(
      () => mutationTests("tools/release", {
        gitCommand: process.execPath,
        gitCommandArgs: [stub],
        repositoryRoot: repository,
      }),
      /missing its required terminal/u,
    );
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("release mutation tests cannot consume a live publish request journal", () => {
  assert.deepEqual(
    mutationTestEnvironment({
      GITHUB_ACTIONS: "true",
      GITHUB_REPOSITORY: "f0rr0/oliphaunt",
      GITHUB_RUN_ID: "30593859032",
      KEEP_ME: "preserved",
      OLIPHAUNT_GITHUB_CORE_REQUEST_JOURNAL_PATH: "/live/journal.json",
      OLIPHAUNT_REQUIRE_GITHUB_CORE_REQUEST_JOURNAL: "true",
      RELEASE_HEAD_SHA: "a".repeat(40),
    }),
    { KEEP_ME: "preserved" },
  );
});
