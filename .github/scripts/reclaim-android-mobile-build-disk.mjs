#!/usr/bin/env bun
import { existsSync } from "node:fs";
import process from "node:process";
import { spawnSync } from "node:child_process";

const WORKSPACE = process.env.GITHUB_WORKSPACE || ".";

function fail(message) {
  console.error(`reclaim-android-mobile-build-disk.mjs: ${message}`);
  process.exit(1);
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error) {
    fail(result.error.message);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

if (process.env.RUNNER_OS !== "Linux") {
  process.exit(0);
}

console.log("Disk before Android mobile cleanup:");
run("df", ["-h", WORKSPACE]);

run("sudo", [
  "rm",
  "-rf",
  "/opt/ghc",
  "/opt/hostedtoolcache/CodeQL",
  "/usr/local/share/boost",
  "/usr/share/dotnet",
]);

const androidHome = process.env.ANDROID_HOME;
if (androidHome && existsSync(androidHome)) {
  run("sudo", [
    "rm",
    "-rf",
    `${androidHome}/emulator`,
    `${androidHome}/system-images`,
  ]);
}

console.log("Disk after Android mobile cleanup:");
run("df", ["-h", WORKSPACE]);
