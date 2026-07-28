#!/usr/bin/env node
import { createHash } from "node:crypto";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  createSiblingStage,
  promoteDirectory,
  removeTemporaryPath,
  stageExistingDirectory,
} from "../../tools/release/atomic-directory.mjs";
import {
  retryReadOperationSync,
  runGitHubPaginatedJsonSync,
  runGitHubReadSync,
} from "../../tools/release/github-read.mjs";
import {
  parseContinuationJson,
  sha256Bytes,
  validateReleaseContinuationPointer,
} from "../../tools/release/release-continuation-contract.mjs";
import { captureCommandOutput } from "../../tools/dev/capture-command-output.mjs";
import { openContinuationEnvelope } from "./release-continuation-artifact.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ARTIFACT = "oliphaunt-bootstrap-ledger";
const CHECKPOINT = /^checkpoint-[0-9]{6}-[0-9a-f]{64}[.]json$/u;
const MAX_ARTIFACT_BYTES = 128 * 1024 * 1024;

function fail(message) {
  throw new Error(`download-bootstrap-ledger: ${message}`);
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) fail(`${name} is required`);
  return value;
}

function command(commandName, args, { stdoutTerminator = undefined } = {}) {
  const result = captureCommandOutput(commandName, args, {
    cwd: ROOT,
    env: process.env,
    label: `${commandName} ${args.join(" ")}`,
    maxOutputBytes: MAX_ARTIFACT_BYTES,
    stdoutTerminator,
  });
  if (result.error !== undefined || result.status !== 0) {
    fail(
      `${commandName} ${args.join(" ")} failed: ` +
        `${(result.stderr || result.stdout || result.error?.message || "").trim()}`,
    );
  }
  return result.stdout;
}

function gh(args) {
  return runGitHubReadSync(args, {
    cwd: ROOT,
    label: `bootstrap ledger GitHub ${args[0]} ${args[1]} read`,
    maxBuffer: MAX_ARTIFACT_BYTES,
  }).trim();
}

function ghBinary(args, options = {}) {
  const result = runGitHubReadSync(args, {
    binary: true,
    cwd: ROOT,
    label: options.label ?? `bootstrap ledger GitHub ${args[0]} ${args[1]} read`,
    maxBuffer: MAX_ARTIFACT_BYTES,
    ...options,
  });
  if (!Buffer.isBuffer(result)) fail("gh artifact download did not return binary data");
  return result;
}

function json(text, label) {
  try {
    return JSON.parse(text);
  } catch (error) {
    fail(`${label} returned invalid JSON: ${error.message}`);
  }
}

function timestamp(value, label) {
  if (typeof value !== "string" || !value.endsWith("Z")) fail(`${label} must be a UTC timestamp`);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) fail(`${label} must be a valid UTC timestamp`);
  return milliseconds;
}

function positiveIntegerString(value, label) {
  const rendered = String(value ?? "");
  if (!/^[1-9][0-9]*$/u.test(rendered)) fail(`${label} must be a positive integer`);
  return rendered;
}

function attemptNumber(value) {
  const rendered = positiveIntegerString(value, "GITHUB_RUN_ATTEMPT");
  const parsed = Number(rendered);
  if (!Number.isSafeInteger(parsed)) fail("GITHUB_RUN_ATTEMPT must be a safe integer");
  return parsed;
}

function ledgerArtifactInventory(repo, sha) {
  const artifacts = runGitHubPaginatedJsonSync(
    `repos/${repo}/actions/artifacts?name=${encodeURIComponent(ARTIFACT)}`,
    {
      cwd: ROOT,
      itemsField: "artifacts",
      label: `repository ${ARTIFACT} inventory`,
      maxBuffer: MAX_ARTIFACT_BYTES,
    },
  );
  const byRun = new Map();
  for (const entry of artifacts) {
    if (
      entry === null
      || Array.isArray(entry)
      || typeof entry !== "object"
      || entry.name !== ARTIFACT
      || entry.workflow_run === null
      || Array.isArray(entry.workflow_run)
      || typeof entry.workflow_run !== "object"
      || !/^[1-9][0-9]*$/u.test(String(entry.workflow_run.id ?? ""))
      || typeof entry.workflow_run.head_sha !== "string"
    ) {
      fail(`repository ${ARTIFACT} inventory contains malformed workflow binding`);
    }
    if (entry.workflow_run.head_sha !== sha) continue;
    const runId = String(entry.workflow_run.id);
    const runArtifacts = byRun.get(runId) ?? [];
    runArtifacts.push(entry);
    byRun.set(runId, runArtifacts);
  }
  return byRun;
}

function ledgerArtifacts(artifacts, runId) {
  if (!Array.isArray(artifacts)) fail(`artifact inventory for Release run ${runId} must be a list`);
  const result = [];
  for (const entry of artifacts) {
    if (entry?.name !== ARTIFACT || entry.expired === true) continue;
    if (entry === null || Array.isArray(entry) || typeof entry !== "object") {
      fail(`Release run ${runId} contains malformed ${ARTIFACT} metadata`);
    }
    if (entry.expired !== false) fail(`${ARTIFACT} in Release run ${runId} has ambiguous expiry metadata`);
    const id = positiveIntegerString(entry.id, `${ARTIFACT} artifact id in Release run ${runId}`);
    if (!Number.isSafeInteger(entry.size_in_bytes) || entry.size_in_bytes <= 0) {
      fail(`${ARTIFACT} artifact ${id} has an invalid immutable byte size`);
    }
    if (typeof entry.digest !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(entry.digest)) {
      fail(`${ARTIFACT} artifact ${id} has an invalid immutable SHA-256 digest`);
    }
    const createdAt = timestamp(entry.created_at, `${ARTIFACT} artifact ${id} created_at`);
    const updatedAt = timestamp(entry.updated_at, `${ARTIFACT} artifact ${id} updated_at`);
    if (updatedAt < createdAt) fail(`${ARTIFACT} artifact ${id} was updated before it was created`);
    if (entry.workflow_run?.id !== undefined && String(entry.workflow_run.id) !== runId) {
      fail(`${ARTIFACT} artifact ${id} is not bound to Release run ${runId}`);
    }
    result.push({ createdAt, id, raw: entry, updatedAt });
  }
  return result;
}

function newest(left, right) {
  if (left.updatedAt !== right.updatedAt) return right.updatedAt - left.updatedAt;
  if (left.createdAt !== right.createdAt) return right.createdAt - left.createdAt;
  const leftId = BigInt(left.id);
  const rightId = BigInt(right.id);
  return leftId < rightId ? 1 : leftId > rightId ? -1 : 0;
}

export function selectEarlierAttemptArtifact(artifacts, { runId, currentAttemptStartedAt }) {
  const normalizedRunId = positiveIntegerString(runId, "current Release run id");
  const boundary = timestamp(currentAttemptStartedAt, "current Release run attempt start");
  const candidates = ledgerArtifacts(artifacts, normalizedRunId);
  const earlier = candidates
    .filter(({ createdAt, updatedAt }) => createdAt < boundary && updatedAt < boundary)
    .sort(newest);
  const excludedCurrentAttemptIds = candidates
    .filter(({ createdAt, updatedAt }) => createdAt >= boundary || updatedAt >= boundary)
    .map(({ id }) => id)
    .sort((left, right) => (BigInt(left) < BigInt(right) ? -1 : 1));
  return {
    artifact: earlier[0]?.raw ?? null,
    excludedCurrentAttemptIds,
  };
}

export function selectLatestArtifact(artifacts, { runId }) {
  const normalizedRunId = positiveIntegerString(runId, "prior Release run id");
  return ledgerArtifacts(artifacts, normalizedRunId).sort(newest)[0]?.raw ?? null;
}

export function validateAttemptMetadata(metadata, { runId, attempt, sha }) {
  if (metadata === null || Array.isArray(metadata) || typeof metadata !== "object") {
    fail("current Release run attempt metadata must be an object");
  }
  const normalizedRunId = positiveIntegerString(runId, "current Release run id");
  if (String(metadata.id ?? "") !== normalizedRunId) fail("current attempt metadata has the wrong run id");
  if (metadata.run_attempt !== attempt) fail("current attempt metadata has the wrong attempt number");
  if (metadata.head_sha !== sha) fail("current attempt metadata has the wrong release SHA");
  if (metadata.event !== "workflow_dispatch") fail("current attempt metadata is not a workflow_dispatch run");
  timestamp(metadata.run_started_at, "current Release run attempt run_started_at");
  return metadata.run_started_at;
}

export function validateCurrentRunMetadata(metadata, { runId, sha }) {
  if (metadata === null || Array.isArray(metadata) || typeof metadata !== "object") {
    fail("current Release run metadata must be an object");
  }
  const normalizedRunId = positiveIntegerString(runId, "current Release run id");
  if (String(metadata.id ?? "") !== normalizedRunId) fail("current Release run metadata has the wrong run id");
  if (metadata.head_sha !== sha) fail("current Release run metadata has the wrong release SHA");
  if (metadata.event !== "workflow_dispatch") fail("current Release run metadata is not a workflow_dispatch run");
  const workflowId = positiveIntegerString(metadata.workflow_id, "current Release workflow id");
  timestamp(metadata.created_at, "current Release run created_at");
  return { workflowId };
}

export function validatePriorRunMetadata(metadata, { runId, sha, workflowId }) {
  if (metadata === null || Array.isArray(metadata) || typeof metadata !== "object") {
    fail(`prior Release run ${runId} metadata must be an object`);
  }
  const normalizedRunId = positiveIntegerString(runId, "prior Release run id");
  if (String(metadata.id ?? "") !== normalizedRunId) {
    fail(`prior Release run ${normalizedRunId} metadata has the wrong run id`);
  }
  if (metadata.head_sha !== sha) {
    fail(`prior Release run ${normalizedRunId} metadata disagrees with its exact-SHA artifact binding`);
  }
  const candidateWorkflowId = positiveIntegerString(
    metadata.workflow_id,
    `prior Release run ${normalizedRunId} workflow id`,
  );
  const createdAt = timestamp(metadata.created_at, `prior Release run ${normalizedRunId} created_at`);
  if (candidateWorkflowId !== workflowId || metadata.event !== "workflow_dispatch") return null;
  if (typeof metadata.status !== "string" || metadata.status.length === 0) {
    fail(`prior Release run ${normalizedRunId} has malformed status metadata`);
  }
  if (metadata.status !== "completed") return null;
  return { createdAt, runId: normalizedRunId };
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

function validateZipMembers(archive) {
  const members = command("unzip", ["-Z1", archive], { stdoutTerminator: "\n" })
    .split(/\r?\n/u)
    .filter(Boolean);
  if (members.length === 0) fail("bootstrap ledger artifact archive is empty");
  const seen = new Set();
  for (const member of members) {
    if (
      member.includes("\\") ||
      member.includes("/") ||
      member === "." ||
      member === ".." ||
      /[\u0000-\u001f\u007f]/u.test(member) ||
      !CHECKPOINT.test(member)
    ) {
      fail(`bootstrap ledger artifact contains unexpected archive member ${JSON.stringify(member)}`);
    }
    if (seen.has(member)) fail(`bootstrap ledger artifact repeats archive member ${member}`);
    seen.add(member);
  }
}

function downloadArtifactById(repo, artifact, destination) {
  const id = positiveIntegerString(artifact.id, "bootstrap ledger artifact id");
  return retryReadOperationSync(
    `download bootstrap ledger artifact ${id}`,
    ({ attemptTimeoutMs }) => {
      const directory = createSiblingStage(destination, `artifact-${id}`);
      const archive = path.join(directory, ".artifact.zip");
      try {
        const bytes = ghBinary(
          [
            "api",
            "-H",
            "X-GitHub-Api-Version: 2022-11-28",
            `repos/${repo}/actions/artifacts/${id}/zip`,
          ],
          {
            attemptTimeoutMs,
            baseDelayMs: 0,
            deadlineMs: attemptTimeoutMs,
            label: `download bootstrap ledger artifact ${id}`,
            maxAttempts: 1,
            maxDelayMs: 0,
          },
        );
        if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
          fail(`bootstrap ledger artifact ${id} did not return a ZIP archive`);
        }
        const digest = createHash("sha256").update(bytes).digest("hex");
        if (bytes.length !== artifact.size_in_bytes || digest !== artifact.digest.slice("sha256:".length)) {
          fail(
            `bootstrap ledger artifact ${id} transport identity mismatch: expected `
            + `${artifact.size_in_bytes}/${artifact.digest}, got ${bytes.length}/sha256:${digest}`,
          );
        }
        writeFileSync(archive, bytes, { flag: "wx" });
        validateZipMembers(archive);
        command("unzip", ["-q", archive, "-d", directory]);
        rmSync(archive, { force: true });
        if (files(directory).length === 0) {
          fail(`bootstrap ledger artifact ${id} contains no checkpoints`);
        }
        return directory;
      } catch (error) {
        removeTemporaryPath(directory);
        throw error;
      }
    },
    {
      attemptTimeoutMs: 5 * 60_000,
      deadlineMs: 15 * 60_000,
      maxAttempts: 4,
    },
  );
}

function restoreArtifact(repo, runId, artifact, destination, sourceDescription) {
  const artifactId = positiveIntegerString(artifact.id, "bootstrap ledger artifact id");
  const temporary = downloadArtifactById(repo, artifact, destination);
  const stage = stageExistingDirectory(destination, "restore");
  try {
    const sources = files(temporary);
    if (sources.length === 0) fail(`bootstrap ledger artifact ${artifactId} contains no checkpoints`);
    for (const source of sources) {
      const name = path.basename(source);
      const relative = path.relative(temporary, source).split(path.sep).join("/");
      if (relative !== name || !CHECKPOINT.test(name)) {
        fail(`bootstrap ledger artifact contains unexpected file ${relative}`);
      }
      const target = path.join(stage, name);
      if (statSync(target, { throwIfNoEntry: false })?.isFile()) {
        if (!same(source, target)) fail(`prior checkpoint conflicts with local ${name}`);
      } else {
        copyFileSync(source, target);
      }
    }
    promoteDirectory(stage, destination);
  } finally {
    removeTemporaryPath(temporary);
    if (existsSync(stage)) removeTemporaryPath(stage);
  }
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `found=true\nrun_id=${runId}\n`);
  }
  console.log(
    `restored immutable bootstrap checkpoint chain from ${sourceDescription} ` +
      `(Release run ${runId}, artifact ${artifactId})`,
  );
}

export function restoreExactContinuationLedger(envelope, destination) {
  if (!Array.isArray(envelope?.checkpointEntries) || envelope.checkpointEntries.length === 0) {
    fail("exact continuation envelope contains no bootstrap checkpoints");
  }
  const stage = stageExistingDirectory(destination, "exact-continuation");
  try {
    for (const entry of envelope.checkpointEntries) {
      if (
        entry === null
        || typeof entry !== "object"
        || !CHECKPOINT.test(entry.name)
        || !Buffer.isBuffer(entry.bytes)
        || entry.bytes.length === 0
      ) {
        fail("exact continuation envelope contains a malformed bootstrap checkpoint");
      }
      const target = path.join(stage, entry.name);
      if (statSync(target, { throwIfNoEntry: false })?.isFile()) {
        const existing = readFileSync(target);
        if (existing.length !== entry.bytes.length || sha256Bytes(existing) !== sha256Bytes(entry.bytes)) {
          fail(`exact continuation checkpoint conflicts with local ${entry.name}`);
        }
      } else {
        writeFileSync(target, entry.bytes, { flag: "wx", mode: 0o600 });
      }
    }
    promoteDirectory(stage, destination);
  } finally {
    if (existsSync(stage)) removeTemporaryPath(stage);
  }
}

function priorRuns(repo, sha, currentRun, workflowId, artifactsByRun) {
  const document = runGitHubPaginatedJsonSync(
    `repos/${repo}/actions/workflows/${workflowId}/runs?head_sha=${encodeURIComponent(sha)}&event=workflow_dispatch`,
    {
      cwd: ROOT,
      itemsField: "workflow_runs",
      label: `exact-SHA Release workflow ${workflowId} run inventory`,
      maxBuffer: MAX_ARTIFACT_BYTES,
    },
  );
  const result = [];
  const seen = new Set();
  for (const metadata of document) {
    const runId = positiveIntegerString(metadata?.id, "exact-SHA Release run id");
    if (seen.has(runId)) fail(`exact-SHA Release run inventory repeats run ${runId}`);
    seen.add(runId);
    if (runId === currentRun) continue;
    const candidate = validatePriorRunMetadata(metadata, { runId, sha, workflowId });
    if (candidate !== null && artifactsByRun.has(runId)) result.push(candidate);
  }
  return result.sort((left, right) =>
    right.createdAt - left.createdAt
      || (BigInt(left.runId) < BigInt(right.runId) ? 1 : -1));
}

export async function main() {
  const repo = required("GH_REPO");
  const sha = required("RELEASE_HEAD_SHA");
  if (!/^[0-9a-f]{40}$/u.test(sha)) fail("RELEASE_HEAD_SHA must be a full lowercase commit SHA");
  const destination = path.resolve(
    ROOT,
    process.env.BOOTSTRAP_LEDGER_PATH || "target/release/bootstrap-ledger",
  );
  const currentRun = positiveIntegerString(required("GITHUB_RUN_ID"), "GITHUB_RUN_ID");
  const rawPointer = process.env.RELEASE_CONTINUATION_POINTER?.trim() ?? "";
  if (rawPointer !== "") {
    if (rawPointer.length > 32 * 1024) fail("RELEASE_CONTINUATION_POINTER exceeds 32 KiB");
    const pointer = validateReleaseContinuationPointer(
      parseContinuationJson(rawPointer, "RELEASE_CONTINUATION_POINTER"),
      { operation: "publish-bootstrap", releaseCommit: sha },
    );
    const archive = path.resolve(required("RELEASE_CONTINUATION_ARCHIVE"));
    const metadata = lstatSync(archive, { throwIfNoEntry: false });
    if (!metadata?.isFile() || metadata.isSymbolicLink() || metadata.size !== pointer.artifact.size) {
      fail("cached exact continuation archive has the wrong file identity");
    }
    const bytes = readFileSync(archive);
    if (`sha256:${sha256Bytes(bytes)}` !== pointer.artifact.digest) {
      fail("cached exact continuation archive digest differs from its pointer");
    }
    const envelope = openContinuationEnvelope(bytes, pointer);
    restoreExactContinuationLedger(envelope, destination);
    if (process.env.GITHUB_OUTPUT) {
      appendFileSync(
        process.env.GITHUB_OUTPUT,
        `found=true\nrun_id=${pointer.parentRunId}\nartifact_id=${pointer.artifact.id}\n`
          + `generation=${pointer.generation}\n`,
      );
    }
    console.log(
      `restored exact bootstrap continuation generation ${pointer.generation}/${pointer.maxGenerations} `
        + `from parent run ${pointer.parentRunId}, artifact ${pointer.artifact.id}`,
    );
    return;
  }
  const currentAttempt = attemptNumber(required("GITHUB_RUN_ATTEMPT"));
  const currentRunMetadata = json(
    gh(["api", `repos/${repo}/actions/runs/${currentRun}`]),
    `current Release run ${currentRun}`,
  );
  const { workflowId } = validateCurrentRunMetadata(currentRunMetadata, {
    runId: currentRun,
    sha,
  });
  const artifactsByRun = ledgerArtifactInventory(repo, sha);

  let excludedCurrentAttemptIds = [];
  if (currentAttempt > 1) {
    const metadata = json(
      gh(["api", `repos/${repo}/actions/runs/${currentRun}/attempts/${currentAttempt}`]),
      `Release run ${currentRun} attempt ${currentAttempt}`,
    );
    const currentAttemptStartedAt = validateAttemptMetadata(metadata, {
      attempt: currentAttempt,
      runId: currentRun,
      sha,
    });
    const selected = selectEarlierAttemptArtifact(artifactsByRun.get(currentRun) ?? [], {
      currentAttemptStartedAt,
      runId: currentRun,
    });
    excludedCurrentAttemptIds = selected.excludedCurrentAttemptIds;
    if (selected.artifact !== null) {
      restoreArtifact(
        repo,
        currentRun,
        selected.artifact,
        destination,
        "an earlier attempt of the current run",
      );
      return;
    }
  }

  for (const run of priorRuns(repo, sha, currentRun, workflowId, artifactsByRun)) {
    const { runId } = run;
    const artifact = selectLatestArtifact(artifactsByRun.get(runId) ?? [], { runId });
    if (artifact === null) continue;
    restoreArtifact(repo, runId, artifact, destination, "a prior completed dispatch");
    return;
  }

  if (excludedCurrentAttemptIds.length > 0) {
    fail(
      "the current rerun attempt has bootstrap ledger artifact(s), but no artifact can be proven to " +
        `predate the attempt and no prior dispatch can recover the chain; refusing genesis ` +
        `(excluded artifact ids: ${excludedCurrentAttemptIds.join(", ")})`,
    );
  }
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, "found=false\n");
  console.log("no prior bootstrap checkpoint artifact exists for this release SHA; starting a genesis chain");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((cause) => {
    console.error(cause instanceof Error ? cause.message : String(cause));
    process.exit(1);
  });
}
