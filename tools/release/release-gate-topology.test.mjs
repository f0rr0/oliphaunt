import assert from "node:assert/strict";
import { execFileSync } from "../test/fd-backed-spawn-sync.mjs";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  DEDICATED_GATE_TESTS,
  mutationTestEnvironment,
  mutationTests,
} from "./release-check.mjs";
import { uniqueValueFlag } from "./release-cli-utils.mjs";

const ROOT = path.resolve(import.meta.dir, "../..");
const TOOLCHAIN_GATE = "tools/release/toolchain-bootstrap.test.mjs";
const INSTALLER_FAULT_SUITES = [
  "tools/dev/extract-pinned-zip.test.sh",
  "tools/dev/install-pinned-js-runtime.test.sh",
  "tools/dev/install-pinned-winflexbison.test.sh",
  "tools/dev/setup-android-sdk.test.sh",
  "tools/dev/start-android-emulator-ci.test.sh",
  ".github/actions/setup-moon/install-pinned-node.test.sh",
  ".github/actions/setup-moon/install-pinned-toolchain.test.sh",
  ".github/actions/setup-node-pnpm/install-pinned-pnpm.test.sh",
  ".github/actions/setup-npm-publisher/install.test.sh",
];

function read(relative) {
  return readFileSync(path.join(ROOT, relative), "utf8");
}

function occurrences(source, needle) {
  return source.split(needle).length - 1;
}

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

test("workflow qualification owns every installer fault suite exactly once", () => {
  assert(DEDICATED_GATE_TESTS.has(TOOLCHAIN_GATE));
  assert(!mutationTests("tools/release").includes(TOOLCHAIN_GATE));
  assert(mutationTests("tools/release").includes("tools/release/release-gate-topology.test.mjs"));

  const workflowGate = read("tools/policy/check-workflows.sh");
  assert.equal(occurrences(workflowGate, TOOLCHAIN_GATE), 1);
  for (const suite of INSTALLER_FAULT_SUITES) {
    assert.equal(occurrences(workflowGate, suite), 0, `${suite} must run through the one dedicated gate`);
  }

  const toolchainGate = read(TOOLCHAIN_GATE);
  for (const suite of INSTALLER_FAULT_SUITES) {
    assert.equal(occurrences(toolchainGate, suite), 1, `${suite} must have one fault-suite owner`);
  }

  const workflowProject = Bun.YAML.parse(read(".github/moon.yml"));
  const workflowInputs = new Set(workflowProject.tasks?.check?.inputs ?? []);
  for (const input of [
    "/.moon/toolchains.yml",
    "/.prototools",
    "/tools/dev/curl-platform-flags.sh",
    "/tools/dev/install-pinned-winflexbison.sh",
    "/tools/dev/install-pinned-winflexbison.test.sh",
  ]) {
    assert(workflowInputs.has(input), `${input} must invalidate the installer qualification gate`);
  }
  assert(
    workflowInputs.has("/src/sources/toolchains/**/*"),
    "the toolchain manifest family must invalidate installer qualification",
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

test("Moon release aliases delegate to one canonical check target", () => {
  for (const [file, dependency] of [
    ["moon.yml", "release-tools:check"],
    ["tools/release/moon.yml", "release-tools:check"],
    [".github/moon.yml", "ci-workflows:check"],
  ]) {
    const config = Bun.YAML.parse(read(file));
    const releaseCheck = config.tasks?.["release-check"];
    assert.equal(releaseCheck?.command, "true", `${file} release-check must be an aggregate`);
    assert.deepEqual(releaseCheck?.deps, [dependency], `${file} must delegate to ${dependency}`);
  }
});
