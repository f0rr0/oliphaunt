#!/usr/bin/env bun
import path from "node:path";

import { captureCommandOutput } from "../dev/capture-command-output.mjs";
import { moonCommand, moonEnvironment } from "../dev/moon-command.mjs";

const ROOT = path.resolve(import.meta.dir, "../..");

function fail(message) {
  console.error(`affected.mjs: ${message}`);
  process.exit(2);
}

function moon(args) {
  const result = captureCommandOutput(moonCommand(), args, {
    cwd: ROOT,
    env: moonEnvironment(),
    label: `moon ${args.join(" ")}`,
    maxOutputBytes: 100 * 1024 * 1024,
  });
  if (result.error !== undefined) {
    fail(`failed to run moon: ${result.error.message}`);
  }
  if (result.status !== 0) {
    if (result.stderr) process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  }
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    fail(`moon query did not return JSON: ${error.message}`);
  }
}

export function affectedNames(value) {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new TypeError("Moon affected query must return an object");
  }
  return Object.keys(value).sort();
}

export function triggeringProjectNames(value) {
  affectedNames(value);
  return Object.entries(value)
    .filter(([, detail]) => {
      if (detail === null || Array.isArray(detail) || typeof detail !== "object") return false;
      return detail.other === true || (Array.isArray(detail.tasks) && detail.tasks.length > 0);
    })
    .map(([project]) => project)
    .sort();
}

export function triggeringTaskNames(value) {
  affectedNames(value);
  return Object.entries(value)
    .filter(([, detail]) => {
      if (detail === null || Array.isArray(detail) || typeof detail !== "object") return false;
      return detail.other === true || (Array.isArray(detail.files) && detail.files.length > 0);
    })
    .map(([task]) => task)
    .sort();
}

function affectedSummary() {
  const affected = moon(["query", "affected", "--upstream", "none", "--downstream", "direct"]);
  return {
    directProjects: triggeringProjectNames(affected.projects),
    projects: affectedNames(affected.projects),
    tasks: triggeringTaskNames(affected.tasks),
  };
}

function usage() {
  fail("usage: tools/graph/affected.mjs summary");
}

if (import.meta.main) {
  const [command] = Bun.argv.slice(2);
  if (command !== "summary") {
    usage();
  }
  console.log(JSON.stringify(affectedSummary()));
}
