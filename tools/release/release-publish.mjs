#!/usr/bin/env bun
import { spawnSync } from "node:child_process";

import { ROOT } from "./release-cli-utils.mjs";

const TOOL = "release-publish.mjs";
const COMMANDS = new Set(["publish", "publish-dry-run"]);

function usage() {
  console.log(`usage: tools/release/release-publish.mjs <publish|publish-dry-run> [release.py passthrough args]

Runs protected release publish and publish dry-run operations through the Bun
release command surface. The current implementation delegates to release.py
while publish dispatch is ported.
`);
}

function fail(message, exitCode = 2) {
  console.error(`${TOOL}: ${message}`);
  process.exit(exitCode);
}

const argv = Bun.argv.slice(2);
const command = argv[0];

if (command === "-h" || command === "--help") {
  usage();
  process.exit(0);
}

if (!COMMANDS.has(command)) {
  usage();
  fail(`expected publish or publish-dry-run, got ${command ?? "<missing>"}`);
}

const result = spawnSync("tools/release/release.py", argv, {
  cwd: ROOT,
  stdio: "inherit",
});

if (result.error !== undefined) {
  console.error(`${TOOL}: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 1);
