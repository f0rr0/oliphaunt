#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";

const ALLOWLIST = "tools/policy/python-entrypoints.allowlist";
const PYTHON_PATHSPEC = ":(glob)**/*.py";
const args = process.argv.slice(2);
const MIGRATION_DECISIONS = new Set([
  "defer-extension-model-port",
  "defer-wasix-packager-port",
]);

function fail(message) {
  console.error(`check-python-entrypoints.mjs: ${message}`);
  process.exit(1);
}

function usage() {
  console.log("usage: tools/policy/check-python-entrypoints.mjs [--list] [--json]");
}

let list = false;
let json = false;
for (const arg of args) {
  if (arg === "--list") {
    list = true;
  } else if (arg === "--json") {
    json = true;
  } else if (arg === "--help" || arg === "-h") {
    usage();
    process.exit(0);
  } else {
    fail(`unknown argument: ${arg}`);
  }
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
    const line = rawLine.trimEnd();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const fields = line.split("\t");
    if (fields.length !== 4) {
      fail(`${ALLOWLIST}:${index + 1} must use path<TAB>domain<TAB>migration-decision<TAB>rationale`);
    }
    const [path, domain, migrationDecision, rationale] = fields;
    if (path.startsWith("/") || path.includes("..") || !path.endsWith(".py")) {
      fail(`${ALLOWLIST}:${index + 1} is not a repo-relative Python path: ${path}`);
    }
    if (!/^[a-z][a-z0-9-]*$/u.test(domain)) {
      fail(`${ALLOWLIST}:${index + 1} has invalid domain ${JSON.stringify(domain)}`);
    }
    if (!MIGRATION_DECISIONS.has(migrationDecision)) {
      fail(`${ALLOWLIST}:${index + 1} has unsupported migration decision ${JSON.stringify(migrationDecision)}`);
    }
    if (rationale.length < 24) {
      fail(`${ALLOWLIST}:${index + 1} needs a concrete migration rationale`);
    }
    entries.push({ path, domain, migrationDecision, rationale });
  }
  return entries;
}

function assertSortedUnique(entries) {
  const paths = entries.map((entry) => entry.path);
  const sorted = [...paths].sort();
  if (paths.join("\n") !== sorted.join("\n")) {
    fail(`${ALLOWLIST} must be sorted lexicographically`);
  }
  for (let index = 1; index < entries.length; index += 1) {
    if (entries[index].path === entries[index - 1].path) {
      fail(`${ALLOWLIST} contains duplicate entry: ${entries[index].path}`);
    }
  }
}

// `git ls-files` includes an intentionally deleted path until the deletion is
// staged. Validate the effective worktree so migrations can be checked before
// the caller decides how to stage or commit them.
const trackedPython = gitLsFiles(PYTHON_PATHSPEC).filter((file) => existsSync(file));
const allowlistedEntries = parseAllowlist();
assertSortedUnique(allowlistedEntries);
const allowlistedPython = allowlistedEntries.map((entry) => entry.path);

const tracked = new Set(trackedPython);
const allowed = new Set(allowlistedPython);
const missing = trackedPython.filter((path) => !allowed.has(path));
const stale = allowlistedPython.filter((path) => !tracked.has(path));

if (missing.length > 0 || stale.length > 0) {
  if (missing.length > 0) {
    console.error("tracked Python files missing from the intentional tooling inventory:");
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
  fail("update the tooling inventory or port the Python file to Bun");
}

function inventoryEntry(path) {
  const text = readFileSync(path, "utf8");
  const allowlistEntry = allowlistedEntries.find((entry) => entry.path === path);
  if (allowlistEntry === undefined) {
    fail(`internal error: ${path} missing from parsed allowlist`);
  }
  const lineCount = text.length === 0 ? 0 : text.split(/\r?\n/u).length - (text.endsWith("\n") ? 1 : 0);
  return {
    path,
    domain: allowlistEntry.domain,
    migrationDecision: allowlistEntry.migrationDecision,
    rationale: allowlistEntry.rationale,
    lineCount,
    byteSize: statSync(path).size,
  };
}

const inventory = trackedPython.map(inventoryEntry);

if (json) {
  console.log(JSON.stringify({ count: inventory.length, entries: inventory }, null, 2));
} else if (list) {
  console.log(`Python tooling inventory verified (${trackedPython.length} tracked files):`);
  for (const entry of inventory) {
    console.log(
      `  ${entry.path} domain=${entry.domain} decision=${entry.migrationDecision} lines=${entry.lineCount} bytes=${entry.byteSize}`,
    );
  }
} else {
  console.log(`Python tooling inventory verified (${trackedPython.length} tracked files).`);
}
