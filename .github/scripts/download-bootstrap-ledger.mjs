#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const ROOT = path.resolve(import.meta.dir, "../..");
const ARTIFACT = "oliphaunt-bootstrap-ledger";

function fail(message) {
  throw new Error(`download-bootstrap-ledger: ${message}`);
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) fail(`${name} is required`);
  return value;
}

function gh(args) {
  const result = spawnSync("gh", args, { cwd: ROOT, env: process.env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.error !== undefined || result.status !== 0) {
    fail(`gh ${args.join(" ")} failed: ${(result.stderr || result.stdout || result.error?.message || "").trim()}`);
  }
  return result.stdout.trim();
}

function files(directory) {
  const result = [];
  const visit = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile()) result.push(file);
      else fail(`artifact contains unsupported entry ${file}`);
    }
  };
  visit(directory);
  return result.sort();
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function same(left, right) {
  return statSync(left).size === statSync(right).size && sha256(left) === sha256(right);
}

async function main() {
  const repo = required("GH_REPO");
  const sha = required("RELEASE_HEAD_SHA");
  const destination = path.resolve(ROOT, process.env.BOOTSTRAP_LEDGER_PATH || "target/release/bootstrap-ledger");
  const currentRun = process.env.GITHUB_RUN_ID || "";
  const runs = JSON.parse(gh([
    "run", "list", "--repo", repo, "--workflow", "Release", "--commit", sha,
    "--event", "workflow_dispatch", "--limit", "50", "--json", "databaseId,createdAt",
  ]));
  for (const run of runs) {
    const runId = String(run.databaseId ?? "");
    if (!runId || runId === currentRun) continue;
    const response = JSON.parse(gh(["api", `repos/${repo}/actions/runs/${runId}/artifacts?per_page=100`]));
    const artifact = response.artifacts?.find((entry) => entry.name === ARTIFACT && entry.expired !== true);
    if (!artifact) continue;
    const temporary = mkdtempSync(path.join(os.tmpdir(), "oliphaunt-bootstrap-ledger-"));
    try {
      gh(["run", "download", runId, "--repo", repo, "--name", ARTIFACT, "--dir", temporary]);
      mkdirSync(destination, { recursive: true });
      for (const source of files(temporary)) {
        const name = path.basename(source);
        if (!/^checkpoint-[0-9]{6}-[0-9a-f]{64}[.]json$/u.test(name)) {
          fail(`prior bootstrap artifact contains unexpected file ${name}`);
        }
        const target = path.join(destination, name);
        if (statSync(target, { throwIfNoEntry: false })?.isFile()) {
          if (!same(source, target)) fail(`prior checkpoint conflicts with local ${name}`);
        } else {
          copyFileSync(source, target);
        }
      }
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
    if (process.env.GITHUB_OUTPUT) {
      appendFileSync(process.env.GITHUB_OUTPUT, `found=true\nrun_id=${runId}\n`);
    }
    console.log(`restored immutable bootstrap checkpoint chain from Release run ${runId}`);
    return;
  }
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, "found=false\n");
  }
  console.log("no prior bootstrap checkpoint artifact exists for this release SHA; starting a genesis chain");
}

main().catch((cause) => {
  console.error(cause instanceof Error ? cause.message : String(cause));
  process.exit(1);
});
