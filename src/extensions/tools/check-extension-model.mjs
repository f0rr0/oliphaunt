#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { checkAndroidExtensionLegalCatalog } from "./android-extension-legal-catalog.mjs";

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

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

try {
  checkAndroidExtensionLegalCatalog({ write: Bun.argv.slice(2).includes("--write") });
} catch (cause) {
  console.error(`${TOOL}: ${cause.message}`);
  process.exit(1);
}
