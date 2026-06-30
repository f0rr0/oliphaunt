#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "../..");

function fail(message) {
  console.error(`affected.mjs: ${message}`);
  process.exit(2);
}

function moonBin() {
  if (process.env.MOON_BIN) {
    return process.env.MOON_BIN;
  }
  const protoMoon = path.join(process.env.HOME ?? "", ".proto/bin/moon");
  return existsSync(protoMoon) ? protoMoon : "moon";
}

function moon(args) {
  const result = spawnSync(moonBin(), args, {
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

function names(value) {
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

function affectedSummary() {
  const direct = moon(["query", "affected", "--upstream", "none", "--downstream", "none"]);
  const downstream = moon(["query", "affected", "--upstream", "none", "--downstream", "deep"]);
  return {
    directProjects: names(direct.projects),
    projects: names(downstream.projects),
    directTasks: names(direct.tasks),
  };
}

function usage() {
  fail("usage: tools/graph/affected.mjs summary");
}

const [command] = Bun.argv.slice(2);
if (command !== "summary") {
  usage();
}
console.log(JSON.stringify(affectedSummary()));
