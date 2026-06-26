#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const ALLOWLIST = "tools/policy/python-entrypoints.allowlist";
const PYTHON_PATHSPEC = ":(glob)**/*.py";

function fail(message) {
  console.error(`check-python-entrypoints.mjs: ${message}`);
  process.exit(1);
}

function gitLsFiles(pathspec) {
  const result = spawnSync("git", ["ls-files", "-z", "--", pathspec], {
    encoding: "buffer",
  });
  if (result.status !== 0) {
    fail(result.stderr.toString("utf8").trim() || "git ls-files failed");
  }
  return result.stdout
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .sort();
}

function parseAllowlist() {
  const text = readFileSync(ALLOWLIST, "utf8");
  const entries = [];
  for (const [index, rawLine] of text.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    if (line.startsWith("/") || line.includes("..") || !line.endsWith(".py")) {
      fail(`${ALLOWLIST}:${index + 1} is not a repo-relative Python path: ${line}`);
    }
    entries.push(line);
  }
  return entries;
}

function assertSortedUnique(entries) {
  const sorted = [...entries].sort();
  const sortedText = sorted.join("\n");
  if (entries.join("\n") !== sortedText) {
    fail(`${ALLOWLIST} must be sorted lexicographically`);
  }
  for (let index = 1; index < entries.length; index += 1) {
    if (entries[index] === entries[index - 1]) {
      fail(`${ALLOWLIST} contains duplicate entry: ${entries[index]}`);
    }
  }
}

const trackedPython = gitLsFiles(PYTHON_PATHSPEC);
const allowlistedPython = parseAllowlist();
assertSortedUnique(allowlistedPython);

const tracked = new Set(trackedPython);
const allowed = new Set(allowlistedPython);
const missing = trackedPython.filter((path) => !allowed.has(path));
const stale = allowlistedPython.filter((path) => !tracked.has(path));

if (missing.length > 0 || stale.length > 0) {
  if (missing.length > 0) {
    console.error("tracked Python files missing from the intentional inventory:");
    for (const path of missing) {
      console.error(`  ${path}`);
    }
  }
  if (stale.length > 0) {
    console.error("stale Python inventory entries:");
    for (const path of stale) {
      console.error(`  ${path}`);
    }
  }
  fail("update the inventory or port the Python file to Bun");
}

console.log(`Python entrypoint inventory verified (${trackedPython.length} tracked files).`);
