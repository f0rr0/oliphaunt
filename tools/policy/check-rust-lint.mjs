#!/usr/bin/env bun
import { chdirRepoRoot, run } from "./lib/run-command.mjs";

const PREFIX = "check-rust-lint.mjs";

chdirRepoRoot(PREFIX);
run(PREFIX, "bash", ["tools/policy/check-dependency-invariants.sh"], {
  announce: true,
});
run(
  PREFIX,
  "cargo",
  ["clippy", "--workspace", "--all-targets", "--locked", "--", "-D", "warnings"],
  { announce: true },
);
