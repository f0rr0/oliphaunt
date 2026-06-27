#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const ALLOWLIST = "tools/policy/rust-helper-crates.allowlist";
const RUST_HELPER_PATHSPEC = ":(glob)tools/**/Cargo.toml";
const args = process.argv.slice(2);

function fail(message) {
  console.error(`check-rust-helper-crates.mjs: ${message}`);
  process.exit(1);
}

function usage() {
  console.log("usage: tools/policy/check-rust-helper-crates.mjs [--list]");
}

let list = false;
for (const arg of args) {
  if (arg === "--list") {
    list = true;
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
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    if (line.startsWith("/") || line.includes("..") || !line.endsWith("/Cargo.toml")) {
      fail(`${ALLOWLIST}:${index + 1} is not a repo-relative Cargo.toml path: ${line}`);
    }
    if (!line.startsWith("tools/")) {
      fail(`${ALLOWLIST}:${index + 1} must stay under tools/: ${line}`);
    }
    entries.push(line);
  }
  return entries;
}

function assertSortedUnique(entries) {
  const sorted = [...entries].sort();
  if (entries.join("\n") !== sorted.join("\n")) {
    fail(`${ALLOWLIST} must be sorted lexicographically`);
  }
  for (let index = 1; index < entries.length; index += 1) {
    if (entries[index] === entries[index - 1]) {
      fail(`${ALLOWLIST} contains duplicate entry: ${entries[index]}`);
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

const trackedRustHelpers = gitLsFiles(RUST_HELPER_PATHSPEC);
const allowlistedRustHelpers = parseAllowlist();
assertSortedUnique(allowlistedRustHelpers);

const tracked = new Set(trackedRustHelpers);
const allowed = new Set(allowlistedRustHelpers);
const missing = trackedRustHelpers.filter((path) => !allowed.has(path));
const stale = allowlistedRustHelpers.filter((path) => !tracked.has(path));

if (missing.length > 0 || stale.length > 0) {
  if (missing.length > 0) {
    console.error("tracked Rust helper crates missing from the intentional inventory:");
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

for (const path of trackedRustHelpers) {
  assertHelperCratePolicy(path);
}

if (list) {
  console.log(`Rust helper crate inventory verified (${trackedRustHelpers.length} tracked crates):`);
  for (const path of trackedRustHelpers) {
    console.log(`  ${path}`);
  }
} else {
  console.log(`Rust helper crate inventory verified (${trackedRustHelpers.length} tracked crates).`);
}
