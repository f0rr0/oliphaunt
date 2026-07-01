#!/usr/bin/env bun
import { spawnSync } from "node:child_process";

import { ROOT } from "./release-cli-utils.mjs";

const TOOL = "check-consumer-shape.mjs";

const result = spawnSync("python3", [
  "tools/release/check_consumer_shape.py",
  ...Bun.argv.slice(2),
], {
  cwd: ROOT,
  stdio: "inherit",
});

if (result.error !== undefined) {
  console.error(`${TOOL}: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 1);
