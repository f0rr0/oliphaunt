#!/usr/bin/env bun
import { spawn } from "node:child_process";
import { lstatSync } from "node:fs";
import path from "node:path";

import { captureCommandOutput } from "../dev/capture-command-output.mjs";
import { isolatedGitHubTestEnvironment } from "../test/isolated-github-test-environment.mjs";
import { run } from "./release-cli-utils.mjs";

const TOOL = "release-check.mjs";
const ROOT = path.resolve(import.meta.dir, "../..");
export const DEDICATED_GATE_TESTS = new Set([
  "tools/release/toolchain-bootstrap.test.mjs",
]);
export const MUTATION_TEST_PROCESS_CONCURRENCY = 4;
export const MUTATION_TEST_MAX_CONCURRENCY = 1;
export const MUTATION_TEST_TIMEOUT_MS = 30_000;

export function mutationTestEnvironment(inheritedEnvironment = process.env) {
  return isolatedGitHubTestEnvironment({}, inheritedEnvironment);
}

export function mutationTests(
  root,
  { gitCommand = "git", gitCommandArgs = [], repositoryRoot = ROOT } = {},
) {
  const normalizedRoot = root.split(path.sep).join("/").replace(/^[/]+|[/]+$/gu, "");
  if (!normalizedRoot || path.isAbsolute(root) || normalizedRoot.split("/").includes("..")) {
    throw new Error(`${TOOL}: mutation test root must be a repository-relative path`);
  }
  const result = captureCommandOutput(
    gitCommand,
    [
      ...gitCommandArgs,
      "ls-files",
      "-z",
      "--cached",
      "--others",
      "--exclude-standard",
      "--",
      normalizedRoot,
    ],
    {
      cwd: repositoryRoot,
      label: `git ls-files ${normalizedRoot}`,
      maxOutputBytes: 16 * 1024 * 1024,
      stdoutTerminator: "\0",
    },
  );
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(
      `${TOOL}: cannot inventory repository-owned mutation tests: `
        + (result.error?.message || result.stderr.trim() || `git exited ${result.status}`),
    );
  }
  if (result.stdout.length === 0) {
    throw new Error(`${TOOL}: cannot inventory repository-owned mutation tests: git returned an empty inventory`);
  }
  const tests = result.stdout
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
  if (tests.length === 0) {
    throw new Error(`${TOOL}: ${normalizedRoot} contains no repository-owned mutation tests`);
  }
  return tests;
}

export function mutationTestWaves(tests, concurrency = MUTATION_TEST_PROCESS_CONCURRENCY) {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new Error(`${TOOL}: mutation test process concurrency must be a positive integer`);
  }
  const waves = [];
  for (let offset = 0; offset < tests.length; offset += concurrency) {
    waves.push(tests.slice(offset, offset + concurrency));
  }
  return waves;
}

export function mutationTestCommand(test) {
  return [
    process.execPath,
    "test",
    // Positional paths are filters, so Bun still discovers recursively from
    // the workspace root. Generated build trees are never mutation tests and
    // can contain hundreds of thousands of files after local qualification.
    "--path-ignore-patterns=target/**",
    "--isolate",
    `--max-concurrency=${MUTATION_TEST_MAX_CONCURRENCY}`,
    `--timeout=${MUTATION_TEST_TIMEOUT_MS}`,
    test,
  ];
}

function runMutationTest(test, environment) {
  const command = mutationTestCommand(test);
  console.log(`\n==> ${command.join(" ")}`);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const child = spawn(command[0], command.slice(1), {
      cwd: ROOT,
      env: environment,
      stdio: "inherit",
    });
    child.once("error", (error) => finish({ error, status: null, signal: null, test }));
    child.once("close", (status, signal) => finish({ error: null, status, signal, test }));
  });
}

function parseArgs(argv) {
  for (const arg of argv) {
    if (arg === "-h" || arg === "--help") {
      console.log(`usage: tools/release/release-check.mjs [legacy passthrough args]

Runs release metadata gates followed by release mutation unit tests. Current passthrough flags remain
accepted for compatibility with release workflow and Moon callers.
`);
      process.exit(0);
    }
  }
}

async function main(argv) {
  parseArgs(argv);
  run(TOOL, [process.execPath, "tools/release/release-metadata-check.mjs", ...argv]);
  const tests = [
    ...mutationTests("tools/policy"),
    ...mutationTests("tools/release"),
  ];
  // Bun 1.3 can retain stale epoll registrations while moving between test
  // files. Give every file a fresh process, and preserve bounded throughput by
  // draining a fixed-size wave before starting the next one.
  const environment = mutationTestEnvironment();
  for (const wave of mutationTestWaves(tests)) {
    const results = await Promise.all(wave.map((test) => runMutationTest(test, environment)));
    const failure = results.find(({ error, status }) => error !== null || status !== 0);
    if (failure !== undefined) {
      if (failure.error !== null) {
        throw new Error(`${TOOL}: ${failure.test} failed to start: ${failure.error.message}`);
      }
      if (failure.signal !== null) {
        throw new Error(`${TOOL}: ${failure.test} terminated by ${failure.signal}`);
      }
      process.exit(failure.status ?? 1);
    }
  }
}

if (import.meta.main) {
  await main(Bun.argv.slice(2));
}
