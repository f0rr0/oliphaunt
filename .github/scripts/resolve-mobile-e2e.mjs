#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { env, exit } from "node:process";

import {
  retryReadOperationSync,
  runGitHubPaginatedJsonSync,
  runGitHubReadSync,
} from "../../tools/release/github-read.mjs";

const FULL_SHA = /^[0-9a-f]{40}$/u;
const FULL_SHA_INPUT = /^[0-9a-f]{40}$/iu;
const RUN_ID = /^[1-9][0-9]*$/u;
const MOBILE_ARTIFACTS = Object.freeze({
  android: "react-native-mobile-android-app-android-x86_64",
  ios: "react-native-mobile-ios-app",
});

function run(command, args, { environment = process.env } = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    env: environment,
  });
  if (result.error) {
    throw new Error(result.error.message);
  }
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr]
      .map((value) => value?.trimEnd())
      .filter(Boolean)
      .join("\n");
    throw new Error(
      `${command} ${args.join(" ")} failed with exit code ${result.status}` +
        (detail ? `:\n${detail}` : ""),
    );
  }
  return result.stdout;
}

function parsedJson(output, label) {
  const text = output.trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} returned invalid JSON: ${error.message}`);
  }
}

function outputWriter(environment) {
  return (name, value) => {
    const rendered = `${name}=${value}\n`;
    if (environment.GITHUB_OUTPUT) {
      appendFileSync(environment.GITHUB_OUTPUT, rendered, "utf8");
    } else {
      process.stdout.write(rendered);
    }
  };
}

export function mobilePlatformSelection(value = "all") {
  if (!new Set(["all", "android", "ios"]).has(value)) {
    throw new Error(
      `unsupported mobile E2E platform ${JSON.stringify(value)}; expected all, android, or ios`,
    );
  }
  return {
    android: value === "all" || value === "android",
    ios: value === "all" || value === "ios",
  };
}

export function githubResolverDependencies(
  repo,
  { execute = undefined, retryOptions = {} } = {},
) {
  const executeLocal = execute ?? ((command, args) => run(command, args));
  const ghRead = (args, label) => {
    if (execute === undefined) {
      return runGitHubReadSync(args, { label, ...retryOptions });
    }
    return retryReadOperationSync(
      label,
      () => execute("gh", args),
      retryOptions,
    );
  };
  const paginationSpawn = execute === undefined
    ? undefined
    : (command, args) => {
        try {
          return {
            status: 0,
            stderr: "",
            stdout: execute(command, args),
          };
        } catch (error) {
          return {
            status: 1,
            stderr: error instanceof Error ? error.message : String(error),
            stdout: "",
          };
        }
      };
  const ghJson = (args, label) => parsedJson(ghRead(args, label), label);
  return {
    checkoutSha() {
      return executeLocal("git", ["rev-parse", "HEAD^{commit}"]).trim();
    },
    listRuns(sha) {
      return ghJson(
        [
          "run",
          "list",
          "--repo",
          repo,
          "--workflow",
          "ci.yml",
          "--commit",
          sha,
          "--limit",
          "100",
          "--json",
          "databaseId,status,conclusion,headSha",
        ],
        "gh run list",
      );
    },
    gateSucceeded(runId, gateJobName) {
      const data = ghJson(
        ["run", "view", String(runId), "--repo", repo, "--json", "jobs"],
        "gh run view",
      );
      if (!Array.isArray(data?.jobs)) {
        throw new Error(`CI run ${runId} jobs must be a list`);
      }
      const matches = data.jobs.filter((job) => job?.name === gateJobName);
      return matches.length === 1 && matches[0]?.conclusion === "success";
    },
    artifactNames(runId) {
      const label = `CI run ${runId} mobile artifact inventory`;
      const artifacts = runGitHubPaginatedJsonSync(
        `repos/${repo}/actions/runs/${runId}/artifacts`,
        {
          ...retryOptions,
          itemsField: "artifacts",
          label,
          ...(paginationSpawn === undefined ? {} : { spawn: paginationSpawn }),
        },
      );
      return artifacts
        .map((artifact) => {
          if (
            artifact === null
            || Array.isArray(artifact)
            || typeof artifact !== "object"
            || typeof artifact.name !== "string"
            || artifact.name.length === 0
            || typeof artifact.expired !== "boolean"
          ) {
            throw new Error(`${label} contains malformed artifact metadata`);
          }
          return artifact;
        })
        .filter((artifact) => artifact.expired === false)
        .map((artifact) => artifact.name);
    },
  };
}

function stringCounts(value, label) {
  if (value === null || value === undefined || typeof value[Symbol.iterator] !== "function") {
    throw new Error(`${label} must be an iterable of artifact names`);
  }
  const result = new Map();
  for (const item of value) {
    if (typeof item !== "string" || item.length === 0) {
      throw new Error(`${label} contains an invalid artifact name`);
    }
    result.set(item, (result.get(item) ?? 0) + 1);
  }
  return result;
}

export function resolveMobileE2e(
  {
    repo,
    requestedPlatform = "all",
    requestedSha,
    defaultSha,
    gateJobName = "Builds",
  },
  dependencies,
) {
  if (typeof repo !== "string" || repo.length === 0) {
    throw new Error("GH_REPO is required");
  }
  if (!dependencies || typeof dependencies !== "object") {
    throw new Error("mobile E2E resolver dependencies are required");
  }
  const requested = mobilePlatformSelection(requestedPlatform);
  const inputSha = requestedSha || defaultSha;
  if (!inputSha) {
    throw new Error("an input SHA or default SHA is required");
  }
  if (!FULL_SHA_INPUT.test(inputSha)) {
    throw new Error(`mobile E2E input must be a full commit SHA: ${inputSha}`);
  }

  const sha = String(dependencies.checkoutSha()).trim();
  if (!FULL_SHA.test(sha)) {
    throw new Error(`checked-out mobile E2E commit is not a full SHA: ${sha}`);
  }
  if (sha !== inputSha.toLowerCase()) {
    throw new Error(`checked-out mobile E2E commit ${sha} does not match requested SHA ${inputSha}`);
  }

  const runs = dependencies.listRuns(sha);
  if (runs !== null && !Array.isArray(runs)) {
    throw new Error("gh run list must return a JSON array");
  }
  const candidateIds = [];
  const seenRunIds = new Set();
  for (const candidate of runs ?? []) {
    if (candidate?.status !== "completed" || candidate?.conclusion !== "success") continue;
    if (!FULL_SHA.test(candidate.headSha ?? "")) {
      throw new Error("successful CI run metadata is missing a full lowercase headSha");
    }
    if (candidate.headSha !== sha) continue;
    const runId = String(candidate.databaseId ?? "");
    if (!RUN_ID.test(runId)) {
      throw new Error(`successful CI run for ${sha} has invalid databaseId ${JSON.stringify(candidate.databaseId)}`);
    }
    if (!seenRunIds.has(runId)) {
      seenRunIds.add(runId);
      candidateIds.push(runId);
    }
  }

  for (const runId of candidateIds) {
    if (dependencies.gateSucceeded(runId, gateJobName) !== true) continue;
    const names = stringCounts(dependencies.artifactNames(runId), `CI run ${runId} artifacts`);
    const selected = {
      android: requested.android && names.get(MOBILE_ARTIFACTS.android) === 1,
      ios: requested.ios && names.get(MOBILE_ARTIFACTS.ios) === 1,
    };
    if (Object.entries(requested).every(([platform, wanted]) => !wanted || selected[platform])) {
      return {
        android: selected.android,
        ios: selected.ios,
        platformJobs: [
          ...(selected.android ? ["android"] : []),
          ...(selected.ios ? ["ios"] : []),
        ],
        runId,
        sha,
      };
    }
  }

  throw new Error(`No successful CI run for ${sha} contains requested mobile app artifacts.`);
}

export function runMobileE2eResolver({
  environment = env,
  dependencies = undefined,
  writeOutput = undefined,
} = {}) {
  const repo = environment.GH_REPO;
  const resolved = resolveMobileE2e(
    {
      defaultSha: environment.DEFAULT_SHA,
      gateJobName: environment.BUILD_GATE_JOB || "Builds",
      repo,
      requestedPlatform: environment.INPUT_PLATFORM || "all",
      requestedSha: environment.INPUT_SHA,
    },
    dependencies ??
      githubResolverDependencies(repo, {
        execute: (command, args) => run(command, args, { environment }),
      }),
  );
  const emit = writeOutput ?? outputWriter(environment);
  emit("sha", resolved.sha);
  emit("run_id", resolved.runId);
  emit("android", String(resolved.android));
  emit("ios", String(resolved.ios));
  emit("platform_jobs", JSON.stringify(resolved.platformJobs));
  return resolved;
}

if (import.meta.main) {
  try {
    runMobileE2eResolver();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    exit(1);
  }
}
