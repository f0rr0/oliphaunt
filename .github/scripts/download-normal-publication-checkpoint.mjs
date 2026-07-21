#!/usr/bin/env bun
// The publication lock/plan graph is Bun-owned. Keep every parsed child stream
// on the file-backed capture helper while this entrypoint remains on Bun.
import { createHash } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_NORMAL_PUBLICATION_CHECKPOINT,
  openNormalPublicationCheckpoint,
} from "../../tools/release/normal-publication-checkpoint.mjs";
import { normalPublicationPlan } from "../../tools/release/normal-publication-plan.mjs";
import {
  NORMAL_PUBLICATION_RECOVERY_DOWNLOAD_DEADLINE_MS,
  NORMAL_PUBLICATION_RECOVERY_MAX_ATTEMPTS,
  NORMAL_PUBLICATION_RECOVERY_MAX_CANDIDATES,
  NORMAL_PUBLICATION_RECOVERY_MAX_PAGES_PER_INVENTORY,
  NORMAL_PUBLICATION_RECOVERY_READ_DEADLINE_MS,
} from "../../tools/release/normal-publication-recovery-contract.mjs";
import {
  assertPublicationLockSource,
  loadPublicationLock,
} from "../../tools/release/publication-lock.mjs";
import {
  retryReadOperationSync,
  runGitHubPaginatedJsonSync,
  runGitHubReadSync,
} from "../../tools/release/github-read.mjs";
import {
  parseContinuationJson,
  sha256Bytes,
  stableJson,
  validateReleaseContinuationPointer,
} from "../../tools/release/release-continuation-contract.mjs";
import { captureCommandOutput } from "../../tools/dev/capture-command-output.mjs";
import { openContinuationEnvelope } from "./release-continuation-artifact.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const MAX_ARTIFACT_BYTES = 128 * 1024 * 1024;
const ALLOWED_ZIP_MEMBERS = new Set([
  "normal-publication-checkpoint.json",
  "normal-publication-plan.json",
  "registry-integrity-receipts.json",
]);

function fail(message) {
  throw new Error(`download-normal-publication-checkpoint: ${message}`);
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) fail(`${name} is required`);
  return value;
}

function positiveInteger(value, context) {
  const rendered = String(value ?? "");
  if (!/^[1-9][0-9]*$/u.test(rendered) || !Number.isSafeInteger(Number(rendered))) {
    fail(`${context} must be a positive safe integer`);
  }
  return rendered;
}

function json(value, context) {
  try { return JSON.parse(value); } catch (cause) { fail(`${context} is not strict JSON: ${cause.message}`); }
}

function command(commandName, args, {
  maxOutputBytes = MAX_ARTIFACT_BYTES,
  stdoutTerminator = undefined,
} = {}) {
  const result = captureCommandOutput(commandName, args, {
    cwd: ROOT,
    env: process.env,
    label: `${commandName} ${args.join(" ")}`,
    maxOutputBytes,
    stdoutTerminator,
  });
  if (result.error !== undefined || result.status !== 0) {
    fail(
      `${commandName} ${args.join(" ")} failed: `
      + `${(result.stderr || result.stdout || result.error?.message || "").trim()}`,
    );
  }
  return result.stdout;
}

function ghJson(repo, endpoint, label) {
  return json(runGitHubReadSync(["api", `repos/${repo}/${endpoint}`], {
    cwd: ROOT,
    label,
    maxBuffer: MAX_ARTIFACT_BYTES,
    attemptTimeoutMs: NORMAL_PUBLICATION_RECOVERY_READ_DEADLINE_MS,
    deadlineMs: NORMAL_PUBLICATION_RECOVERY_READ_DEADLINE_MS,
    maxAttempts: NORMAL_PUBLICATION_RECOVERY_MAX_ATTEMPTS,
  }), label);
}

function artifactName(sha) {
  return `normal-publication-recovery-${sha}`;
}

function validateCurrentRun(metadata, { currentRunId, sha }) {
  if (metadata === null || Array.isArray(metadata) || typeof metadata !== "object") {
    fail("current Release run metadata must be an object");
  }
  if (String(metadata.id ?? "") !== currentRunId) fail("current Release run metadata has the wrong run id");
  if (metadata.head_sha !== sha) fail("current Release run metadata has the wrong exact release SHA");
  if (metadata.event !== "workflow_dispatch") fail("current Release run is not a workflow_dispatch");
  return positiveInteger(metadata.workflow_id, "current Release workflow id");
}

export function eligibleRecoveryArtifacts({
  runs,
  artifacts,
  currentRunId,
  workflowId,
  sha,
  name = artifactName(sha),
}) {
  if (!Array.isArray(runs) || !Array.isArray(artifacts)) fail("run and artifact inventories must be lists");
  const eligibleRuns = new Set();
  const seenRuns = new Set();
  for (const run of runs) {
    const runId = positiveInteger(run?.id, "exact-SHA Release run id");
    if (seenRuns.has(runId)) fail(`exact-SHA Release run inventory repeats run ${runId}`);
    seenRuns.add(runId);
    if (
      String(run.workflow_id ?? "") !== workflowId
      || run.head_sha !== sha
      || run.event !== "workflow_dispatch"
    ) {
      fail(`exact-SHA Release run inventory contains a run outside workflow ${workflowId} and SHA ${sha}`);
    }
    if (runId !== currentRunId && run.status === "completed") eligibleRuns.add(runId);
  }
  const seenArtifacts = new Set();
  const byRun = new Map();
  for (const artifact of artifacts) {
    if (artifact === null || Array.isArray(artifact) || typeof artifact !== "object" || artifact.name !== name) {
      fail(`named recovery artifact inventory contains malformed artifact metadata`);
    }
    const id = positiveInteger(artifact.id, "recovery artifact id");
    if (seenArtifacts.has(id)) fail(`recovery artifact inventory repeats immutable artifact id ${id}`);
    seenArtifacts.add(id);
    if (
      artifact.workflow_run === null
      || Array.isArray(artifact.workflow_run)
      || typeof artifact.workflow_run !== "object"
    ) {
      fail(`recovery artifact ${id} has no immutable workflow-run binding`);
    }
    const runId = positiveInteger(artifact.workflow_run.id, `recovery artifact ${id} run id`);
    if (artifact.workflow_run.head_sha !== sha) continue;
    if (!eligibleRuns.has(runId)) continue;
    if (artifact.expired !== false) fail(`recovery artifact ${id} has expired or ambiguous expiry metadata`);
    if (!Number.isSafeInteger(artifact.size_in_bytes) || artifact.size_in_bytes < 4 || artifact.size_in_bytes > MAX_ARTIFACT_BYTES) {
      fail(`recovery artifact ${id} has an invalid bounded byte size`);
    }
    if (typeof artifact.digest !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(artifact.digest)) {
      fail(`recovery artifact ${id} has an invalid immutable SHA-256 digest`);
    }
    const candidates = byRun.get(runId) ?? [];
    candidates.push({ ...artifact, id, runId });
    byRun.set(runId, candidates);
  }
  for (const [runId, candidates] of byRun) {
    if (candidates.length !== 1) {
      fail(`completed Release run ${runId} exposes duplicate same-name recovery artifacts`);
    }
  }
  const result = [...byRun.values()].flat();
  if (result.length > NORMAL_PUBLICATION_RECOVERY_MAX_CANDIDATES) {
    fail(
      `exact-SHA recovery has ${result.length} candidates; maximum audited inventory is ` +
      `${NORMAL_PUBLICATION_RECOVERY_MAX_CANDIDATES}`,
    );
  }
  return result.sort((left, right) => BigInt(left.id) < BigInt(right.id) ? -1 : 1);
}

function strictSuperset(left, right) {
  return left.size > right.size && [...right].every((value) => left.has(value));
}

export function selectMaximalCheckpointCandidate(candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  const byDigest = new Map();
  const completedSetDigests = new Map();
  for (const candidate of candidates) {
    const checkpoint = candidate?.checkpoint;
    if (
      checkpoint === null
      || Array.isArray(checkpoint)
      || typeof checkpoint !== "object"
      || typeof checkpoint.checkpointDigest !== "string"
      || !Array.isArray(checkpoint.completedOperations)
    ) {
      fail("validated recovery candidates must contain checkpoint identity and completed operations");
    }
    const completed = new Set(checkpoint.completedOperations);
    if (completed.size !== checkpoint.completedOperations.length) fail("recovery checkpoint repeats a completed operation");
    const completedKey = [...completed].sort().join("\0");
    const previousDigest = completedSetDigests.get(completedKey);
    if (previousDigest !== undefined && previousDigest !== checkpoint.checkpointDigest) {
      fail("recovery candidates conflict for the same completed operation set");
    }
    completedSetDigests.set(completedKey, checkpoint.checkpointDigest);
    const group = byDigest.get(checkpoint.checkpointDigest) ?? { candidates: [], completed };
    if (group.completed.size !== completed.size || [...completed].some((id) => !group.completed.has(id))) {
      fail("one checkpoint digest is reused for conflicting completed operation sets");
    }
    group.candidates.push(candidate);
    byDigest.set(checkpoint.checkpointDigest, group);
  }
  const groups = [...byDigest.values()];
  const maximal = groups.filter((candidate) => !groups.some(
    (other) => other !== candidate && strictSuperset(other.completed, candidate.completed),
  ));
  if (maximal.length !== 1) {
    fail(`recovery candidates have ${maximal.length} incomparable maximal checkpoints`);
  }
  return maximal[0].candidates.sort(
    (left, right) => BigInt(left.artifact.id) < BigInt(right.artifact.id) ? -1 : 1,
  )[0];
}

function validateZipMembers(archive) {
  const members = command("unzip", ["-Z1", archive], { stdoutTerminator: "\n" })
    .split(/\r?\n/u)
    .filter(Boolean);
  if (members.length === 0) fail("recovery artifact ZIP is empty");
  const seen = new Set();
  for (const member of members) {
    if (
      member.includes("/")
      || member.includes("\\")
      || /[\u0000-\u001f\u007f]/u.test(member)
      || !ALLOWED_ZIP_MEMBERS.has(member)
      || seen.has(member)
    ) {
      fail(`recovery artifact ZIP contains unexpected or repeated member ${JSON.stringify(member)}`);
    }
    seen.add(member);
  }
  if (!seen.has("normal-publication-checkpoint.json")) {
    fail("recovery artifact ZIP is missing normal-publication-checkpoint.json");
  }
}

function downloadArtifact(repo, artifact) {
  return retryReadOperationSync(
    `download normal publication recovery artifact ${artifact.id}`,
    ({ attemptTimeoutMs }) => {
      const result = runGitHubReadSync(
        ["api", "-H", "X-GitHub-Api-Version: 2022-11-28", `repos/${repo}/actions/artifacts/${artifact.id}/zip`],
        {
          binary: true,
          cwd: ROOT,
          label: `download normal publication recovery artifact ${artifact.id}`,
          maxBuffer: MAX_ARTIFACT_BYTES,
          attemptTimeoutMs,
          maxAttempts: 1,
          baseDelayMs: 0,
          maxDelayMs: 0,
          deadlineMs: attemptTimeoutMs,
        },
      );
      if (!Buffer.isBuffer(result) || result.length < 4 || result[0] !== 0x50 || result[1] !== 0x4b) {
        fail(`recovery artifact ${artifact.id} did not return a ZIP archive`);
      }
      const observed = createHash("sha256").update(result).digest("hex");
      if (result.length !== artifact.size_in_bytes || `sha256:${observed}` !== artifact.digest) {
        fail(`recovery artifact ${artifact.id} transport size/digest does not match immutable metadata`);
      }
      return result;
    },
    {
      attemptTimeoutMs: NORMAL_PUBLICATION_RECOVERY_READ_DEADLINE_MS,
      deadlineMs: NORMAL_PUBLICATION_RECOVERY_DOWNLOAD_DEADLINE_MS,
      maxAttempts: NORMAL_PUBLICATION_RECOVERY_MAX_ATTEMPTS,
      baseDelayMs: 500,
      maxDelayMs: 2_000,
    },
  );
}

function checkpointCandidate(artifact, bytes, { lock, products, plan }) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "oliphaunt-normal-publication-recovery-"));
  try {
    const archive = path.join(directory, "artifact.zip");
    writeFileSync(archive, bytes, { flag: "wx", mode: 0o600 });
    validateZipMembers(archive);
    const checkpointFile = path.join(directory, "normal-publication-checkpoint.json");
    command("unzip", ["-q", archive, "normal-publication-checkpoint.json", "-d", directory]);
    const checkpointMetadata = lstatSync(checkpointFile, { throwIfNoEntry: false });
    if (
      !checkpointMetadata?.isFile()
      || checkpointMetadata.isSymbolicLink()
      || checkpointMetadata.size === 0
      || checkpointMetadata.size > MAX_ARTIFACT_BYTES
    ) {
      fail(`recovery artifact ${artifact.id} contains an invalid checkpoint size`);
    }
    const checkpointBytes = readFileSync(checkpointFile);
    const manager = openNormalPublicationCheckpoint({ file: checkpointFile, lock, products, plan });
    return { artifact, checkpoint: manager.checkpoint, checkpointBytes };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function atomicRestore(file, bytes) {
  const absolute = path.resolve(file);
  if (existsSync(absolute)) fail(`refusing to replace pre-existing local checkpoint ${file}`);
  mkdirSync(path.dirname(absolute), { recursive: true });
  const temporary = `${absolute}.restore-${process.pid}`;
  let descriptor;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, absolute);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    try { unlinkSync(temporary); } catch {}
  }
  if (!statSync(absolute).isFile()) fail(`atomic checkpoint restore did not create ${file}`);
}

function productsFromEnvironment() {
  const value = json(required("PRODUCTS_JSON"), "PRODUCTS_JSON");
  if (
    !Array.isArray(value)
    || value.length === 0
    || value.some((product) => typeof product !== "string" || product.length === 0)
    || new Set(value).size !== value.length
  ) {
    fail("PRODUCTS_JSON must be a nonempty unique string list");
  }
  return value;
}

export async function main() {
  const repo = required("GH_REPO");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repo)) fail("GH_REPO must be owner/repository");
  const sha = required("RELEASE_HEAD_SHA");
  if (!/^[0-9a-f]{40}$/u.test(sha)) fail("RELEASE_HEAD_SHA must be a full lowercase commit SHA");
  const currentRunId = positiveInteger(required("GITHUB_RUN_ID"), "GITHUB_RUN_ID");
  const destination = path.resolve(
    ROOT,
    process.env.NORMAL_PUBLICATION_CHECKPOINT_PATH || DEFAULT_NORMAL_PUBLICATION_CHECKPOINT,
  );
  const lockFile = path.resolve(ROOT, required("PUBLICATION_LOCK_PATH"));
  const products = productsFromEnvironment();
  const lock = loadPublicationLock(lockFile);
  assertPublicationLockSource(lock, sha);
  const plan = normalPublicationPlan(lock, products);
  const rawPointer = process.env.RELEASE_CONTINUATION_POINTER?.trim() ?? "";
  if (rawPointer !== "") {
    if (rawPointer.length > 32 * 1024) fail("RELEASE_CONTINUATION_POINTER exceeds 32 KiB");
    const pointer = validateReleaseContinuationPointer(
      parseContinuationJson(rawPointer, "RELEASE_CONTINUATION_POINTER"),
      { operation: "publish", releaseCommit: sha },
    );
    const archive = path.resolve(required("RELEASE_CONTINUATION_ARCHIVE"));
    const archiveMetadata = lstatSync(archive, { throwIfNoEntry: false });
    if (
      !archiveMetadata?.isFile()
      || archiveMetadata.isSymbolicLink()
      || archiveMetadata.size !== pointer.artifact.size
    ) {
      fail("cached exact continuation archive has the wrong file identity");
    }
    const bytes = readFileSync(archive);
    if (`sha256:${sha256Bytes(bytes)}` !== pointer.artifact.digest) {
      fail("cached exact continuation archive digest differs from its pointer");
    }
    const envelope = openContinuationEnvelope(bytes, pointer);
    const expectedLock = {
      catalogDigest: lock.catalogDigest,
      lockDigest: lock.lockDigest,
      packageEnvelopeDigest: lock.packageEnvelopeDigest,
    };
    if (
      stableJson(envelope.contract.lock) !== stableJson(expectedLock)
      || stableJson(envelope.contract.products) !== stableJson(
        [...products].sort((left, right) => left < right ? -1 : left > right ? 1 : 0),
      )
      || envelope.contract.source.tree !== lock.source.tree
    ) {
      fail("exact continuation contract disagrees with the installed publication lock and release plan");
    }
    const temporary = path.join(os.tmpdir(), `oliphaunt-exact-normal-checkpoint-${process.pid}.json`);
    try {
      writeFileSync(temporary, envelope.stateBytes, { flag: "wx", mode: 0o600 });
      openNormalPublicationCheckpoint({ file: temporary, lock, products, plan });
    } finally {
      rmSync(temporary, { force: true });
    }
    atomicRestore(destination, envelope.stateBytes);
    if (process.env.GITHUB_OUTPUT) {
      appendFileSync(
        process.env.GITHUB_OUTPUT,
        `found=true\nrun_id=${pointer.parentRunId}\nartifact_id=${pointer.artifact.id}\n`
          + `completed_operations=${envelope.executionResult.completedIds.length}\n`
          + `generation=${pointer.generation}\n`,
      );
    }
    console.log(
      `restored exact normal-publication continuation generation ${pointer.generation}/${pointer.maxGenerations} `
        + `from parent run ${pointer.parentRunId}, artifact ${pointer.artifact.id}`,
    );
    return;
  }
  const current = ghJson(repo, `actions/runs/${currentRunId}`, `current Release run ${currentRunId}`);
  const workflowId = validateCurrentRun(current, { currentRunId, sha });
  const runs = runGitHubPaginatedJsonSync(
    `repos/${repo}/actions/workflows/${workflowId}/runs?head_sha=${encodeURIComponent(sha)}&event=workflow_dispatch`,
    {
      cwd: ROOT,
      itemsField: "workflow_runs",
      label: `exact-SHA Release workflow ${workflowId} run inventory`,
      maxBuffer: MAX_ARTIFACT_BYTES,
      maxPages: NORMAL_PUBLICATION_RECOVERY_MAX_PAGES_PER_INVENTORY,
      attemptTimeoutMs: NORMAL_PUBLICATION_RECOVERY_READ_DEADLINE_MS,
      deadlineMs: NORMAL_PUBLICATION_RECOVERY_READ_DEADLINE_MS,
      maxAttempts: NORMAL_PUBLICATION_RECOVERY_MAX_ATTEMPTS,
    },
  );
  const name = artifactName(sha);
  const artifacts = runGitHubPaginatedJsonSync(
    `repos/${repo}/actions/artifacts?name=${encodeURIComponent(name)}`,
    {
      cwd: ROOT,
      itemsField: "artifacts",
      label: `repository ${name} artifact inventory`,
      maxBuffer: MAX_ARTIFACT_BYTES,
      maxPages: NORMAL_PUBLICATION_RECOVERY_MAX_PAGES_PER_INVENTORY,
      attemptTimeoutMs: NORMAL_PUBLICATION_RECOVERY_READ_DEADLINE_MS,
      deadlineMs: NORMAL_PUBLICATION_RECOVERY_READ_DEADLINE_MS,
      maxAttempts: NORMAL_PUBLICATION_RECOVERY_MAX_ATTEMPTS,
    },
  );
  const inventory = eligibleRecoveryArtifacts({ runs, artifacts, currentRunId, workflowId, sha, name });
  if (inventory.length === 0) {
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, "found=false\n");
    console.log("no earlier exact-SHA normal-publication checkpoint exists; starting a new checkpoint");
    return;
  }
  const candidates = inventory.map((artifact) => checkpointCandidate(
    artifact,
    downloadArtifact(repo, artifact),
    { lock, products, plan },
  ));
  const selected = selectMaximalCheckpointCandidate(candidates);
  atomicRestore(destination, selected.checkpointBytes);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `found=true\nrun_id=${selected.artifact.runId}\nartifact_id=${selected.artifact.id}\n` +
      `completed_operations=${selected.checkpoint.completedOperations.length}\n`,
    );
  }
  console.log(
    `restored ${selected.checkpoint.completedOperations.length} completed normal-publication operations ` +
    `from exact-SHA Release run ${selected.artifact.runId}, artifact ${selected.artifact.id}`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((cause) => {
    console.error(cause instanceof Error ? cause.message : String(cause));
    process.exit(1);
  });
}
