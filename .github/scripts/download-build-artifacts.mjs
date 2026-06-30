#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const USAGE =
  "usage: download-build-artifacts.mjs <workflow> <sha> <destination> [--run-id <id>] [--job <name>] --artifact <name> [--artifact <name>...]";

function fail(message, code = 1) {
  console.error(message);
  process.exit(code);
}

function parseArgs(argv) {
  if (argv.length < 3) {
    fail(USAGE, 2);
  }
  const [workflow, sha, destination, ...rest] = argv;
  const args = {
    workflow,
    sha,
    destination,
    artifacts: [],
    requiredJob: "",
    selectedRunId: "",
  };
  for (let index = 0; index < rest.length; ) {
    const arg = rest[index];
    if (arg === "--run-id") {
      args.selectedRunId = valueAfter(rest, index, "--run-id requires a run id");
      index += 2;
    } else if (arg === "--job") {
      args.requiredJob = valueAfter(rest, index, "--job requires a name");
      index += 2;
    } else if (arg === "--artifact") {
      args.artifacts.push(valueAfter(rest, index, "--artifact requires a name"));
      index += 2;
    } else {
      fail(`unknown argument: ${arg}`, 2);
    }
  }
  if (args.artifacts.length === 0) {
    fail("at least one --artifact is required", 2);
  }
  return args;
}

function valueAfter(argv, index, message) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    fail(message, 2);
  }
  return value;
}

function requireEnv(name) {
  const value = process.env[name];
  if (value === undefined || value === "") {
    fail(`${name} is required`);
  }
  return value;
}

function run(command, args, { capture = false } = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    env: process.env,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    if (capture) {
      process.stderr.write(result.stderr ?? "");
      process.stderr.write(result.stdout ?? "");
    }
    throw new Error(`${[command, ...args].join(" ")} exited with status ${result.status}`);
  }
  return result.stdout ?? "";
}

function gh(args, options) {
  return run("gh", args, options);
}

function artifactNames(repo, runId) {
  try {
    return gh(
      [
        "api",
        `repos/${repo}/actions/runs/${runId}/artifacts?per_page=100`,
        "--paginate",
        "--jq",
        ".artifacts[].name",
      ],
      { capture: true },
    )
      .split(/\r?\n/u)
      .filter(Boolean);
  } catch (error) {
    fail(`failed to list artifacts for run ${runId}: ${error.message}`);
  }
}

function artifactPresent(repo, runId, artifact) {
  return artifactNames(repo, runId).includes(artifact);
}

function requiredJobSuccess(repo, runId, requiredJob) {
  if (requiredJob === "") {
    return true;
  }
  let data;
  try {
    data = JSON.parse(gh(["run", "view", runId, "--repo", repo, "--json", "jobs"], { capture: true }));
  } catch {
    return false;
  }
  const job = (data.jobs ?? []).find((candidate) => candidate?.name === requiredJob);
  return job?.conclusion === "success";
}

function candidateRunIds(repo, workflow, sha, requiredJob) {
  const runs = JSON.parse(
    gh(
      [
        "run",
        "list",
        "--repo",
        repo,
        "--workflow",
        workflow,
        "--commit",
        sha,
        "--limit",
        "20",
        "--json",
        "databaseId,status,conclusion,event,createdAt",
      ],
      { capture: true },
    ),
  );
  return runs
    .filter((run) => requiredJob !== "" || (run.status === "completed" && run.conclusion === "success"))
    .map((run) => String(run.databaseId))
    .filter(Boolean);
}

function sortedFiles(root) {
  const files = [];
  function visit(directory) {
    const entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
      left.name.localeCompare(right.name),
    );
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(entryPath);
      } else if (entry.isFile()) {
        files.push(entryPath);
      }
    }
  }
  visit(root);
  return files;
}

function fileSha256(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(file);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function filesEqual(left, right) {
  const leftStat = statSync(left);
  const rightStat = statSync(right);
  return leftStat.size === rightStat.size && (await fileSha256(left)) === (await fileSha256(right));
}

function copyPreserve(source, target) {
  const sourceStat = statSync(source);
  copyFileSync(source, target);
  chmodSync(target, sourceStat.mode);
  utimesSync(target, sourceStat.atime, sourceStat.mtime);
}

function mergeChecksumManifest(existing, incoming) {
  const result = spawnSync("bun", [".github/scripts/merge-checksum-manifest.mjs", existing, incoming], {
    stdio: "inherit",
    env: process.env,
  });
  return !result.error && result.status === 0;
}

async function mergeDownloadedArtifact(artifact, sourceDir, destination) {
  for (const source of sortedFiles(sourceDir)) {
    const relativePath = path.relative(sourceDir, source);
    const target = path.join(destination, relativePath);
    mkdirSync(path.dirname(target), { recursive: true });
    if (existsSync(target)) {
      if (statSync(target).isFile() && (await filesEqual(source, target))) {
        continue;
      }
      if (
        statSync(target).isFile() &&
        statSync(source).isFile() &&
        path.basename(target).endsWith("-release-assets.sha256")
      ) {
        if (!mergeChecksumManifest(target, source)) {
          return false;
        }
        continue;
      }
      console.error(`artifact ${artifact} would overwrite ${relativePath} with different bytes`);
      return false;
    }
    copyPreserve(source, target);
  }
  return true;
}

function selectRunId(repo, args) {
  if (args.selectedRunId !== "") {
    const runId = args.selectedRunId;
    if (!requiredJobSuccess(repo, runId, args.requiredJob)) {
      fail(`${args.workflow} run ${runId} does not satisfy required job ${args.requiredJob || "<none>"}`);
    }
    for (const artifact of args.artifacts) {
      if (!artifactPresent(repo, runId, artifact)) {
        fail(`${args.workflow} run ${runId} is missing required artifact ${artifact}`);
      }
    }
    return runId;
  }

  for (const candidate of candidateRunIds(repo, args.workflow, args.sha, args.requiredJob)) {
    if (!requiredJobSuccess(repo, candidate, args.requiredJob)) {
      continue;
    }
    if (args.artifacts.every((artifact) => artifactPresent(repo, candidate, artifact))) {
      return candidate;
    }
  }
  fail(
    `no ${args.workflow} workflow run found for ${args.sha} with required job/artifacts: ${args.requiredJob || "<workflow-success>"} / ${args.artifacts.join(" ")}`,
  );
}

async function main() {
  const args = parseArgs(Bun.argv.slice(2));
  requireEnv("GH_TOKEN");
  const repo = requireEnv("GH_REPO");
  const runId = selectRunId(repo, args);
  mkdirSync(args.destination, { recursive: true });

  for (const artifact of args.artifacts) {
    console.log(`Downloading ${args.workflow} artifact ${artifact} from run ${runId}`);
    const artifactDir = mkdtempSync(path.join(os.tmpdir(), "oliphaunt-artifact-"));
    try {
      gh(["run", "download", runId, "--repo", repo, "--name", artifact, "--dir", artifactDir]);
      if (!(await mergeDownloadedArtifact(artifact, artifactDir, args.destination))) {
        process.exit(1);
      }
    } finally {
      rmSync(artifactDir, { recursive: true, force: true });
    }
  }
}

try {
  await main();
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
