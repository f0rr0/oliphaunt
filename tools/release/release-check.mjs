#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TOOL = "release-check.mjs";

function fail(message) {
  console.error(`${TOOL}: ${message}`);
  process.exit(1);
}

function run(args) {
  console.log(`\n==> ${args.join(" ")}`);
  const result = spawnSync(args[0], args.slice(1), {
    cwd: ROOT,
    stdio: "inherit",
  });
  if (result.error) {
    fail(`${args[0]} failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

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
  run(["tools/dev/bun.sh", "tools/policy/check-release-policy.mjs"]);
  run(["tools/dev/bun.sh", "tools/release/check_release_please_config.mjs"]);
  run(["tools/dev/bun.sh", "tools/release/check_artifact_targets.mjs"]);
  run(["tools/dev/bun.sh", "tools/release/sync-release-pr.mjs", "--check"]);
  run(["tools/dev/bun.sh", "tools/release/check_release_pr_coverage.mjs"]);
  run(["python3", "tools/release/check_release_metadata.py"]);
  run(["tools/release/check_consumer_shape.py", "--format", "json", "--require-ready"]);
  run([
    "tools/release/check_consumer_shape.py",
    "--format",
    "json",
    "--require-ready",
    "--products-json",
    '["oliphaunt-react-native"]',
  ]);
}

main(Bun.argv.slice(2));
