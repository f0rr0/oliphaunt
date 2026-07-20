#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { lstatSync } from "node:fs";
import path from "node:path";

import { run } from "./release-cli-utils.mjs";

const TOOL = "release-check.mjs";
const ROOT = path.resolve(import.meta.dir, "../..");
export const DEDICATED_GATE_TESTS = new Set([
  "tools/policy/assertions/assert-ambient-js-tools.test.mjs",
  "tools/policy/assertions/assert-ordinal-release-ordering.test.mjs",
  "tools/release/toolchain-bootstrap.test.mjs",
]);
export const MUTATION_TEST_TIMEOUT_MS = 30_000;

export function mutationTests(root, { repositoryRoot = ROOT } = {}) {
  const normalizedRoot = root.split(path.sep).join("/").replace(/^[/]+|[/]+$/gu, "");
  if (!normalizedRoot || path.isAbsolute(root) || normalizedRoot.split("/").includes("..")) {
    throw new Error(`${TOOL}: mutation test root must be a repository-relative path`);
  }
  const result = spawnSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", normalizedRoot],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(
      `${TOOL}: cannot inventory repository-owned mutation tests: `
        + (result.error?.message ?? result.stderr.trim() ?? `git exited ${result.status}`),
    );
  }
  return result.stdout
    .split("\0")
    .filter(Boolean)
    .filter((file) => file.endsWith(".test.mjs"))
    .filter((file) => !DEDICATED_GATE_TESTS.has(file))
    .filter((file) => {
      try {
        const entry = lstatSync(path.join(repositoryRoot, ...file.split("/")));
        return entry.isFile() && !entry.isSymbolicLink();
      } catch {
        // A tracked deletion must not become an attempted test invocation.
        return false;
      }
    })
    .sort();
}

function parseArgs(argv) {
  for (const arg of argv) {
    if (arg === "-h" || arg === "--help") {
      console.log(`usage: tools/release/release-check.mjs [legacy passthrough args]

Runs the live repository-structure and release metadata gates followed by
release mutation unit tests. Current passthrough flags remain accepted for
compatibility with release workflow and Moon callers.
`);
      process.exit(0);
    }
  }
}

function main(argv) {
  parseArgs(argv);
  run(TOOL, ["bash", "tools/policy/check-repo-structure.sh"]);
  run(TOOL, [process.execPath, "tools/release/release-metadata-check.mjs", ...argv]);
  run(TOOL, [
    process.execPath,
    "test",
    `--timeout=${MUTATION_TEST_TIMEOUT_MS}`,
    ...mutationTests("tools/policy"),
    ...mutationTests("tools/release"),
  ]);
}

if (import.meta.main) {
  main(Bun.argv.slice(2));
}
