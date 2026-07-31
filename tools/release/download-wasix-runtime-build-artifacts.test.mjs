#!/usr/bin/env node

import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { spawnSync } from "../test/fd-backed-spawn-sync.mjs";
import { isolatedGitHubTestEnvironment } from "../test/isolated-github-test-environment.mjs";

const SCRIPT = path.resolve(".github/scripts/download-wasix-runtime-build-artifacts.mjs");
const CONTROL_SHA = "a".repeat(40);
const ARTIFACT_SHA = "b".repeat(40);

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "oliphaunt-wasix-artifact-download-"));
  const bin = path.join(root, "bin");
  const capture = path.join(root, "capture.json");
  mkdirSync(bin);
  const cargo = path.join(bin, "cargo");
  writeFileSync(cargo, `#!/usr/bin/env node
const { writeFileSync } = require("node:fs");
writeFileSync(process.env.CAPTURE_PATH, JSON.stringify({
  args: process.argv.slice(2),
  releaseArtifactSha: process.env.RELEASE_ARTIFACT_SHA,
  releaseHeadSha: process.env.RELEASE_HEAD_SHA,
}));
`);
  chmodSync(cargo, 0o755);
  t.after(() => rmSync(root, { force: true, recursive: true }));
  return { bin, capture };
}

function runWrapper(t, overrides = {}) {
  const { bin, capture } = fixture(t);
  const result = spawnSync("bun", [SCRIPT], {
    encoding: "utf8",
    env: isolatedGitHubTestEnvironment({
      CAPTURE_PATH: capture,
      GITHUB_TOKEN: "fixture-token",
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
      RELEASE_ARTIFACT_SHA: ARTIFACT_SHA,
      RELEASE_HEAD_SHA: CONTROL_SHA,
      ...overrides,
    }),
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(readFileSync(capture, "utf8"));
}

test("exact run download preserves controller lineage while selecting frozen payload artifacts", (t) => {
  const capture = runWrapper(t, { CI_RUN_ID: "30358387218" });
  assert.deepEqual(capture, {
    args: [
      "run",
      "-p",
      "xtask",
      "--",
      "assets",
      "download",
      "--run-id",
      "30358387218",
      "--required-job",
      "Builds",
      "--all-targets",
    ],
    releaseArtifactSha: ARTIFACT_SHA,
    releaseHeadSha: CONTROL_SHA,
  });
});

test("artifact SHA wins only as the payload selector when no run ID is supplied", (t) => {
  const capture = runWrapper(t);
  assert.deepEqual(capture.args.slice(6, 8), ["--sha", ARTIFACT_SHA]);
  assert.equal(capture.releaseHeadSha, CONTROL_SHA);
});
