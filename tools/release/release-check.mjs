#!/usr/bin/env bun
import { readdirSync } from "node:fs";
import path from "node:path";

import { run } from "./release-cli-utils.mjs";

const TOOL = "release-check.mjs";

function mutationTests(root) {
  const pending = [root];
  const files = [];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(file);
      else if (entry.isFile() && entry.name.endsWith(".test.mjs")) files.push(file);
    }
  }
  return files.sort();
}

function parseArgs(argv) {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "-h" || arg === "--help") {
      console.log(`usage: tools/release/release-check.mjs [legacy passthrough args]

Runs the repository release metadata, release-please, artifact target,
release PR, and consumer-shape readiness checks. Current passthrough flags are
accepted for compatibility with release workflow and Moon callers.
`);
      process.exit(0);
    }
  }
}

function main(argv) {
  parseArgs(argv);
  run(TOOL, ["tools/dev/bun.sh", "tools/policy/check-release-policy.mjs"]);
  run(TOOL, ["tools/dev/bun.sh", "tools/release/check_release_please_config.mjs"]);
  run(TOOL, ["tools/dev/bun.sh", "tools/release/check_artifact_targets.mjs"]);
  run(TOOL, [
    "tools/dev/bun.sh",
    "test",
    ...mutationTests("tools/policy"),
    ...mutationTests("tools/release"),
  ]);
  run(TOOL, ["tools/dev/bun.sh", "tools/release/sync-release-pr.mjs", "--check"]);
  run(TOOL, ["tools/dev/bun.sh", "tools/release/check_release_pr_coverage.mjs"]);
  run(TOOL, ["tools/dev/bun.sh", "tools/release/check-release-metadata.mjs"]);
  run(TOOL, ["tools/dev/bun.sh", "tools/release/example-cargo-policy.mjs", "--check"]);
  run(TOOL, ["tools/dev/bun.sh", "tools/release/release-consumer-shape.mjs", "--format", "json", "--require-ready"]);
  run(TOOL, [
    "tools/dev/bun.sh",
    "tools/release/release-consumer-shape.mjs",
    "--format",
    "json",
    "--require-ready",
    "--products-json",
    '["oliphaunt-react-native"]',
  ]);
}

main(Bun.argv.slice(2));
