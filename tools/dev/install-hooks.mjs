#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import path from "node:path";
import process from "node:process";

function fail(message) {
  console.error(message);
  process.exit(1);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    ...options,
  });
  if (result.error) {
    fail(result.error.message);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function output(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
  });
  if (result.error) {
    fail(result.error.message);
  }
  if (result.status !== 0) {
    fail(result.stderr.trim() || `${command} ${args.join(" ")} failed`);
  }
  return result.stdout.trim();
}

function hasCommand(command) {
  const pathValue = process.env.PATH ?? "";
  const extensions =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";")
      : [""];
  for (const directory of pathValue.split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = path.join(directory, `${command}${extension}`);
      try {
        accessSync(candidate, constants.X_OK);
        return true;
      } catch {
        // Keep scanning PATH.
      }
    }
  }
  return false;
}

const root = output("git", ["rev-parse", "--show-toplevel"]);
process.chdir(root);

if (!hasCommand("prek")) {
  fail(`missing required command: prek

Install prek first, then rerun this script:
  brew install prek

Other installation methods are documented at https://prek.j178.dev/installation/`);
}

const hooksPath = spawnSync(
  "git",
  ["config", "--local", "--get", "core.hooksPath"],
  { encoding: "utf8" },
);
if (hooksPath.status === 0 && hooksPath.stdout.trim() === ".githooks") {
  run("git", ["config", "--local", "--unset", "core.hooksPath"]);
}

run("prek", ["install", "--prepare-hooks", "--overwrite"]);
console.log("Installed prek hooks from prek.toml");
