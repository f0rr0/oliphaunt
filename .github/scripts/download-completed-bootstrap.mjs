#!/usr/bin/env bun
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { captureCommandOutput } from "../../tools/dev/capture-command-output.mjs";
import { loadPublicationLock } from "../../tools/release/publication-lock.mjs";
import { loadBootstrapLedger } from "../../tools/release/bootstrap-ledger.mjs";
import { assertPublicationChanges } from "../../tools/release/publication-controller.mjs";
import { runGitHubPaginatedJsonSync } from "../../tools/release/github-read.mjs";
import { createSiblingStage, promoteDirectory, removeTemporaryPath } from "../../tools/release/atomic-directory.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ARTIFACT = "oliphaunt-bootstrap-ledger";

export function isCompletedMainRelease(run, repo) {
  return Number.isSafeInteger(run?.id) && run.id > 0
    && run.status === "completed" && run.conclusion === "success"
    && run.event === "workflow_dispatch" && run.head_branch === "main"
    && run.path === ".github/workflows/release.yml"
    && run.repository?.full_name === repo && run.head_repository?.full_name === repo
    && /^[0-9a-f]{40}$/u.test(run.head_sha ?? "");
}

export function matchesBootstrapLock(directory, lock) {
  const files = readdirSync(directory).sort();
  if (files.length === 0 || files.some((file) => !/^checkpoint-[0-9]{6}-[0-9a-f]{64}[.]json$/u.test(file))) {
    throw new Error("completed bootstrap artifact must contain only checkpoint files");
  }
  const first = JSON.parse(readFileSync(path.join(directory, files[0]), "utf8"));
  // Discovery only. Matching evidence still undergoes full chain/envelope validation.
  return first.lockDigest === lock.lockDigest;
}

export function restoreCompletedBootstrap({ repo, lock, destination }, {
  list = runGitHubPaginatedJsonSync,
  download = (run, artifact, stage) => {
    const result = captureCommandOutput(process.execPath, [
      path.join(ROOT, ".github/scripts/download-build-artifacts.mjs"),
      "Release", run.head_sha, stage, "--run-id", String(run.id),
      "--job", "Bootstrap registry identities", "--artifact", ARTIFACT,
      "--artifact-metadata-json", JSON.stringify([{
        id: artifact.id, name: artifact.name, digest: artifact.digest, size: artifact.size_in_bytes,
      }]),
    ], { cwd: ROOT, label: `download completed bootstrap ${run.id}` });
    if (result.error || result.status !== 0) throw new Error(result.stderr || "completed bootstrap download failed");
  },
  assertSource = (run) => assertPublicationChanges({ source: lock.source.commit, controller: run.head_sha }),
} = {}) {
  if (repo !== "f0rr0/oliphaunt") throw new Error("completed bootstrap must come from the canonical repository");
  const runs = list(`repos/${repo}/actions/workflows/release.yml/runs?event=workflow_dispatch&status=success&branch=main`, {
    itemsField: "workflow_runs", label: "completed main Release runs",
  }).filter((run) => isCompletedMainRelease(run, repo)).sort((a, b) => b.id - a.id);
  for (const run of runs) {
    const artifacts = list(`repos/${repo}/actions/runs/${run.id}/artifacts`, {
      itemsField: "artifacts", label: `completed bootstrap artifacts ${run.id}`,
    }).filter((artifact) => artifact.name === ARTIFACT && artifact.expired === false);
    if (artifacts.length === 0) continue;
    if (artifacts.length !== 1) throw new Error(`run ${run.id} repeats the completed bootstrap artifact`);
    const stage = createSiblingStage(destination);
    try {
      download(run, artifacts[0], stage);
      if (!matchesBootstrapLock(stage, lock)) continue;
      assertSource(run);
      loadBootstrapLedger(stage, lock, lock.products.map(({ id }) => id), { requireComplete: true });
      promoteDirectory(stage, destination);
      return run.id;
    } finally { removeTemporaryPath(stage); }
  }
  throw new Error(`no completed main bootstrap matches approved lock ${lock.lockDigest}; existing bootstrap must not be restarted`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const lock = loadPublicationLock(process.env.PUBLICATION_LOCK_PATH || "target/release/publication-lock.json");
    const destination = path.resolve(process.env.BOOTSTRAP_LEDGER_PATH || "target/release/bootstrap-ledger");
    const runId = restoreCompletedBootstrap({ repo: process.env.GH_REPO, lock, destination });
    console.log(`verified completed bootstrap run ${runId} for approved lock ${lock.lockDigest}`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
