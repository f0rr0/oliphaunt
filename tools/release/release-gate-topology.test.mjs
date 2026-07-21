import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
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
  MUTATION_TEST_TIMEOUT_MS,
  mutationTests,
} from "./release-check.mjs";

const ROOT = path.resolve(import.meta.dir, "../..");
const TOOLCHAIN_GATE = "tools/release/toolchain-bootstrap.test.mjs";
const STRUCTURE_GATE_TESTS = [
  "tools/policy/assertions/assert-ambient-js-tools.test.mjs",
  "tools/policy/assertions/assert-ordinal-release-ordering.test.mjs",
];
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
  "tools/release/install-verdaccio-runtime.test.sh",
];

function read(relative) {
  return readFileSync(path.join(ROOT, relative), "utf8");
}

function occurrences(source, needle) {
  return source.split(needle).length - 1;
}

test("canonical release check owns repository structure suites exactly once", () => {
  assert.deepEqual([...DEDICATED_GATE_TESTS], [...STRUCTURE_GATE_TESTS, TOOLCHAIN_GATE]);
  for (const structureTest of STRUCTURE_GATE_TESTS) {
    assert(!mutationTests("tools/policy").includes(structureTest));
  }
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
    "/tools/release/install-verdaccio-runtime.sh",
    "/tools/release/install-verdaccio-runtime.test.sh",
    "/tools/release/verdaccio-runtime/package.json",
    "/tools/release/verdaccio-runtime/pnpm-lock.yaml",
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

test("qualified replay proves hosted evidence and clean source before omitting mutation tests", () => {
  const releaseCheck = read("tools/release/release-check.mjs");
  const structureCommand = Bun.YAML.parse(read("moon.yml")).tasks?.structure?.command;
  assert.equal(structureCommand, "bash tools/policy/check-repo-structure.sh");
  const canonicalStructureInvocation = `run(TOOL, ["bash", "tools/policy/check-repo-structure.sh"]);`;
  assert.equal(occurrences(releaseCheck, canonicalStructureInvocation), 1);
  assert.match(releaseCheck, /release-metadata-check[.]mjs/u);
  assert(
    releaseCheck.indexOf(canonicalStructureInvocation) < releaseCheck.indexOf("release-metadata-check.mjs"),
    "the live hosted structure entrypoint must run before release metadata and mutation tests",
  );
  assert.equal(MUTATION_TEST_TIMEOUT_MS, 30_000);
  assert.match(releaseCheck, /`--timeout=\$\{MUTATION_TEST_TIMEOUT_MS\}`/u);
  assert.doesNotMatch(releaseCheck, /metadata-only/u);
  const publisher = read("tools/release/release-publish.mjs");
  assert.match(publisher, /qualifiedCi && allowDirty/u);
  assert.match(publisher, /process[.]env[.]GITHUB_ACTIONS !== "true"/u);
  assert.match(publisher, /assertQualifiedReplaySourceState/u);
  assert.match(publisher, /verify-release-candidate[.]mjs/u);
  assert.match(publisher, /target\/release-candidate\/oliphaunt-release-candidate[.]json/u);
  assert.match(publisher, /release-metadata-check[.]mjs/u);
});

test("nested Bun policy tests inherit the bounded repository timeout", () => {
  const sourceInputs = read("tools/policy/assertions/assert-source-inputs.mjs");
  assert.match(sourceInputs, /\['test', '--timeout=30000'/u);
  assert.match(sourceInputs, /arg[.]startsWith\('--timeout='\)/u);
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
