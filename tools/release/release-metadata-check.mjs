#!/usr/bin/env bun

import { run } from "./release-cli-utils.mjs";

const TOOL = "release-metadata-check.mjs";

function parseArgs(argv) {
  for (const arg of argv) {
    if (arg === "-h" || arg === "--help") {
      console.log(`usage: tools/release/release-metadata-check.mjs [legacy passthrough args]

Runs live release policy, Release Please, artifact-target, release-PR,
metadata, generated-docs, and consumer-shape checks without replaying mutation
unit tests.
This is an internal post-qualification or generated-metadata replay surface;
use release-check.mjs for the full local gate.
`);
      process.exit(0);
    }
  }
}

function main(argv) {
  parseArgs(argv);
  run(TOOL, [process.execPath, "tools/policy/check-release-policy.mjs"]);
  run(TOOL, [process.execPath, "tools/release/check_release_please_config.mjs"]);
  run(TOOL, [process.execPath, "tools/release/check_artifact_targets.mjs"]);
  run(TOOL, [process.execPath, "tools/release/sync-release-pr.mjs", "--check"]);
  run(TOOL, [process.execPath, "tools/release/check_release_pr_coverage.mjs"]);
  run(TOOL, [process.execPath, "tools/release/check-release-metadata.mjs"]);
  run(TOOL, ["node", "src/docs/tools/check-docs-product.mjs"]);
  run(TOOL, [process.execPath, "tools/release/example-cargo-policy.mjs", "--check"]);
  run(TOOL, [process.execPath, "tools/release/release-consumer-shape.mjs", "--format", "json", "--require-ready"]);
  run(TOOL, [
    process.execPath,
    "tools/release/release-consumer-shape.mjs",
    "--format",
    "json",
    "--require-ready",
    "--products-json",
    '["oliphaunt-react-native"]',
  ]);
}

if (import.meta.main) {
  main(Bun.argv.slice(2));
}
