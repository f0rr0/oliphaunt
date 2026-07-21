#!/usr/bin/env bun
import { existsSync, readFileSync, statSync } from "node:fs";

import { captureCommandBytes } from "../dev/capture-command-output.mjs";

const ALLOWLIST = "tools/policy/rust-helper-crates.allowlist";
const RUST_HELPER_PATHSPEC = ":(glob)tools/**/Cargo.toml";
const args = process.argv.slice(2);
const MIGRATION_DECISIONS = new Set(["keep-rust-domain-tool"]);

function fail(message) {
  console.error(`check-rust-helper-crates.mjs: ${message}`);
  process.exit(1);
}

function usage() {
  console.log("usage: tools/policy/check-rust-helper-crates.mjs [--list] [--json]");
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
  const result = captureCommandBytes(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", pathspec],
    {
      allowEmptyOutput: true,
      label: `git ls-files ${pathspec}`,
      stdoutTerminator: "\0",
    },
  );
  if (result.error || result.status !== 0) {
    fail(result.error?.message ?? (result.stderr.toString("utf8").trim() || "git ls-files failed"));
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
    if (path.startsWith("/") || path.includes("..") || !path.endsWith("/Cargo.toml")) {
      fail(`${ALLOWLIST}:${index + 1} is not a repo-relative Cargo.toml path: ${path}`);
    }
    if (!path.startsWith("tools/")) {
      fail(`${ALLOWLIST}:${index + 1} must stay under tools/: ${path}`);
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

function assertHelperCratePolicy(path) {
  const text = readFileSync(path, "utf8");
  if (!text.includes("publish = false")) {
    fail(`${path} must be unpublished internal tooling`);
  }
  if (!text.includes("default = []")) {
    fail(`${path} must keep default features empty so policy checks do not compile optional runtime-heavy paths`);
  }
}

// Validate the effective worktree, including non-ignored helpers that have not
// been staged yet. A tracked deletion remains in the Git index until staging,
// so omit paths that no longer exist on disk.
const rustHelpers = gitLsFiles(RUST_HELPER_PATHSPEC).filter((file) => existsSync(file));
const allowlistedEntries = parseAllowlist();
assertSortedUnique(allowlistedEntries);
const allowlistedRustHelpers = allowlistedEntries.map((entry) => entry.path);

const tracked = new Set(rustHelpers);
const allowed = new Set(allowlistedRustHelpers);
const missing = rustHelpers.filter((path) => !allowed.has(path));
const stale = allowlistedRustHelpers.filter((path) => !tracked.has(path));

if (missing.length > 0 || stale.length > 0) {
  if (missing.length > 0) {
    console.error("Rust helper crates missing from the intentional inventory:");
    for (const path of missing) {
      console.error(`  ${path}`);
    }
  }
  if (stale.length > 0) {
    console.error("stale Rust helper inventory entries:");
    for (const path of stale) {
      console.error(`  ${path}`);
    }
  }
  fail("update the inventory or move the helper to Bun");
}

for (const path of rustHelpers) {
  assertHelperCratePolicy(path);
}

function inventoryEntry(path) {
  const entry = allowlistedEntries.find((candidate) => candidate.path === path);
  if (entry === undefined) {
    fail(`internal error: ${path} missing from parsed allowlist`);
  }
  const manifest = Bun.TOML.parse(readFileSync(path, "utf8"));
  const packageName = manifest?.package?.name;
  return {
    path,
    packageName: typeof packageName === "string" ? packageName : null,
    domain: entry.domain,
    migrationDecision: entry.migrationDecision,
    rationale: entry.rationale,
    byteSize: statSync(path).size,
  };
}

const inventory = rustHelpers.map(inventoryEntry);

if (json) {
  console.log(JSON.stringify({ count: inventory.length, entries: inventory }, null, 2));
} else if (list) {
  console.log(`Rust helper crate inventory verified (${rustHelpers.length} worktree crates):`);
  for (const entry of inventory) {
    console.log(`  ${entry.path} package=${entry.packageName ?? "<unknown>"} domain=${entry.domain} decision=${entry.migrationDecision}`);
  }
} else {
  console.log(`Rust helper crate inventory verified (${rustHelpers.length} worktree crates).`);
}
