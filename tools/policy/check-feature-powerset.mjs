#!/usr/bin/env bun
import { chdirRepoRoot, run } from "./lib/run-command.mjs";

const PREFIX = "check-feature-powerset.mjs";

chdirRepoRoot(PREFIX);
run(PREFIX, "cargo", [
  "hack",
  "check",
  "--workspace",
  "--feature-powerset",
  "--no-dev-deps",
  "--exclude-features",
  "aot-serializer,template-runner",
]);
