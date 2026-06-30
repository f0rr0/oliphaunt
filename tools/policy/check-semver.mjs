#!/usr/bin/env bun
import { chdirRepoRoot, run } from "./lib/run-command.mjs";

const PREFIX = "check-semver.mjs";

chdirRepoRoot(PREFIX);
run(PREFIX, "cargo", [
  "semver-checks",
  "check-release",
  "--package",
  "oliphaunt-wasix",
  "--manifest-path",
  "src/bindings/wasix-rust/crates/oliphaunt-wasix/Cargo.toml",
]);
