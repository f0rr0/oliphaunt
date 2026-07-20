#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import path from "node:path";

import { moonCommand } from "../dev/moon-command.mjs";

const ROOT = path.resolve(import.meta.dir, "../..");

function fail(message) {
  console.error(`affected.mjs: ${message}`);
  process.exit(2);
}

function moon(args) {
  const result = spawnSync(moonCommand(), args, {
    cwd: ROOT,
    env: process.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  if (result.error !== undefined) {
    fail(`failed to run moon: ${result.error.message}`);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    fail(`moon query did not return JSON: ${error.message}`);
  }
}

export function affectedNames(value) {
  if (value !== null && !Array.isArray(value) && typeof value === "object") {
    return Object.keys(value).sort();
  }
  if (Array.isArray(value)) {
    const result = new Set();
    for (const item of value) {
      if (typeof item === "string") {
        result.add(item);
      } else if (item !== null && typeof item === "object") {
        const identifier = item.id ?? item.target;
        if (identifier !== undefined && identifier !== null && identifier !== "") {
          result.add(String(identifier));
        }
      }
    }
    return [...result].sort();
  }
  return [];
}

export function triggeringProjectNames(value) {
  if (value !== null && !Array.isArray(value) && typeof value === "object") {
    return Object.entries(value)
      .filter(([, detail]) => {
        if (detail === null || Array.isArray(detail) || typeof detail !== "object") return false;
        return detail.other === true || (Array.isArray(detail.tasks) && detail.tasks.length > 0);
      })
      .map(([project]) => project)
      .sort();
  }
  // Preserve compatibility with Moon versions that return a flat list and do
  // not expose the task-vs-ownership distinction.
  return affectedNames(value);
}

function affectedSummary() {
  const direct = moon(["query", "affected", "--upstream", "none", "--downstream", "none"]);
  const downstream = moon(["query", "affected", "--upstream", "none", "--downstream", "deep"]);
  return {
    directProjects: triggeringProjectNames(direct.projects),
    projects: affectedNames(downstream.projects),
    directTasks: affectedNames(direct.tasks),
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
