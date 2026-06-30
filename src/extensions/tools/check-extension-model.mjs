#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const TOOL = "check-extension-model.mjs";
const ROOT = fileURLToPath(new URL("../../..", import.meta.url));

const result = spawnSync("python3", [
  "src/extensions/tools/check-extension-model.py",
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
