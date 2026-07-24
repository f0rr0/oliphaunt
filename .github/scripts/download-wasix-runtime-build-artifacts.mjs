#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import process from "node:process";

function fail(message, code = 1) {
  console.error(message);
  process.exit(code);
}

function requireEnv(name) {
  const value = process.env[name];
  if (value === undefined || value === "") {
    fail(`${name} is required`);
  }
  return value;
}

function run(command, args) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    env: process.env,
  });
  if (result.error) {
    fail(result.error.message);
  }
  process.exit(result.status ?? 1);
}

requireEnv("GITHUB_TOKEN");
const releaseSha = process.env.RELEASE_HEAD_SHA ?? process.env.GITHUB_SHA ?? "";
if (releaseSha === "") {
  fail("RELEASE_HEAD_SHA or GITHUB_SHA is required", 2);
}

// Installs the portable and AOT WASIX runtime outputs from the selected release
// CI workflow whose artifact builder gate passed. This is a release artifact
// handoff, not a release-time runtime rebuild.
const args = ["run", "-p", "xtask", "--", "assets", "download"];
if (process.env.CI_RUN_ID) {
  args.push("--run-id", process.env.CI_RUN_ID);
} else {
  args.push("--sha", releaseSha);
}
args.push("--required-job", "Builds", "--all-targets");

run("cargo", args);
