#!/usr/bin/env bun
import { run } from "./release-cli-utils.mjs";

const TOOL = "release-check.mjs";

function parseArgs(argv) {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "-h" || arg === "--help") {
      console.log(`usage: tools/release/release-check.mjs [release.py check passthrough args]

Runs the repository release metadata, release-please, artifact target,
release PR, and consumer-shape readiness checks. Current passthrough flags are
accepted for compatibility with release.py check and release workflow callers.
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
  run(TOOL, ["tools/dev/bun.sh", "tools/release/sync-release-pr.mjs", "--check"]);
  run(TOOL, ["tools/dev/bun.sh", "tools/release/check_release_pr_coverage.mjs"]);
  run(TOOL, ["python3", "tools/release/check_release_metadata.py"]);
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
