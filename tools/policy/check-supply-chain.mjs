#!/usr/bin/env bun
import { chdirRepoRoot, run } from "./lib/run-command.mjs";

const PREFIX = "check-supply-chain.mjs";

chdirRepoRoot(PREFIX);
run(PREFIX, "cargo", ["deny", "check"]);
