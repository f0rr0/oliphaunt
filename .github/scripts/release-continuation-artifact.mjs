#!/usr/bin/env node
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  normalizeArtifactIdentity,
  sha256Bytes,
  stableJson,
  validateReleaseContinuationContract,
  validateReleaseContinuationPointer,
  validateReleaseExecutionResult,
} from "../../tools/release/release-continuation-contract.mjs";
import {
  RELEASE_CONTINUATION_ARTIFACT_DOWNLOAD_DEADLINE_MS,
  RELEASE_CONTINUATION_AUTHORIZATION_DISCOVERY_DEADLINE_MS,
  RELEASE_CONTINUATION_METADATA_READ_DEADLINE_MS,
  RELEASE_CONTINUATION_PARENT_COMPLETION_DEADLINE_MS,
} from "../../tools/release/release-continuation-read-budget.mjs";
import {
  continuationAuthorizationArtifactName,
  serializeReleaseContinuationAuthorization,
  validateReleaseContinuationAuthorization,
} from "../../tools/release/release-continuation-authorization.mjs";
import {
  RetryableReadError,
  retryReadOperationSync,
  runGitHubReadSync,
} from "../../tools/release/github-read.mjs";
import {
  CONTINUATION_CORE_JOURNAL_MEMBER,
  CONTINUATION_PACER_MEMBER,
  continuationGitHubStateIdentity,
} from "../../tools/release/github-release-continuation-state.mjs";
import {
  captureCommandBytes,
  captureCommandOutput,
} from "../../tools/dev/capture-command-output.mjs";

const MAX_ARTIFACT_BYTES = 128 * 1024 * 1024;
const CHECKPOINT = /^checkpoint-[0-9]{6}-[0-9a-f]{64}[.]json$/u;
const AUTHORIZATION_MEMBER = "release-continuation-authorization.json";

function error(message) {
  return new Error(`release-continuation-artifact: ${message}`);
}

function permanentError(message) {
  const cause = error(message);
  cause.retryable = false;
  return cause;
}

function json(raw, context) {
  try { return JSON.parse(raw); } catch (cause) { throw error(`${context} must be strict JSON: ${cause.message}`); }
}

function command(commandName, args, { stdoutTerminator = undefined } = {}) {
  const result = captureCommandOutput(commandName, args, {
    label: `${commandName} ${args.join(" ")}`,
    maxOutputBytes: MAX_ARTIFACT_BYTES,
    stdoutTerminator,
  });
  if (result.error !== undefined || result.status !== 0) {
    throw error(
      `${commandName} ${args.join(" ")} failed: `
      + `${(result.stderr || result.stdout || result.error?.message || "").trim()}`,
    );
  }
  return result.stdout;
}

function commandBytes(commandName, args, { maxOutputBytes = MAX_ARTIFACT_BYTES } = {}) {
  const result = captureCommandBytes(commandName, args, {
    label: `${commandName} ${args.join(" ")}`,
    maxOutputBytes,
  });
  if (result.error !== undefined || result.status !== 0) {
    throw error(
      `${commandName} ${args.join(" ")} failed: `
      + `${(result.stderr.toString("utf8") || result.error?.message || "").trim()}`,
    );
  }
  return result.stdout;
}

function ghJson(repo, endpoint, label) {
  return json(runGitHubReadSync(
    ["api", "-H", "X-GitHub-Api-Version: 2022-11-28", `repos/${repo}/${endpoint}`],
    {
      deadlineMs: RELEASE_CONTINUATION_METADATA_READ_DEADLINE_MS,
      label,
      maxBuffer: 4 * 1024 * 1024,
    },
  ), label);
}

export function validateContinuationArtifactMetadata(metadata, pointer) {
  const normalizedPointer = validateReleaseContinuationPointer(pointer);
  if (metadata === null || Array.isArray(metadata) || typeof metadata !== "object") {
    throw error("continuation artifact metadata must be an object");
  }
  const observed = normalizeArtifactIdentity({
    digest: metadata.digest,
    id: metadata.id,
    name: metadata.name,
    size: metadata.size_in_bytes,
  }, "continuation artifact metadata");
  if (stableJson(observed) !== stableJson(normalizedPointer.artifact)) {
    throw error("continuation artifact metadata does not match the exact pointer identity");
  }
  if (metadata.expired !== false) throw error("continuation artifact is expired or has ambiguous expiry metadata");
  if (
    metadata.workflow_run?.id !== undefined
    && Number(metadata.workflow_run.id) !== normalizedPointer.parentRunId
  ) {
    throw error("continuation artifact is bound to the wrong parent run");
  }
  return observed;
}

export function validateContinuationRunLineage({ parent, root, current }, pointer) {
  const normalized = validateReleaseContinuationPointer(pointer);
  const validate = (run, id, context, { requireComplete = false } = {}) => {
    if (run === null || Array.isArray(run) || typeof run !== "object") throw error(`${context} metadata must be an object`);
    if (
      Number(run.id) !== id
      || run.head_sha !== normalized.releaseCommit
      || run.event !== "workflow_dispatch"
      || !Number.isSafeInteger(Number(run.workflow_id))
    ) {
      throw error(`${context} is not bound to the exact Release workflow and release commit`);
    }
    if (requireComplete && (run.status !== "completed" || run.conclusion !== "success")) {
      throw error(`${context} must be a successful completed continuation parent`);
    }
    return Number(run.workflow_id);
  };
  const parentWorkflow = validate(parent, normalized.parentRunId, "parent Release run", { requireComplete: true });
  if (Number(parent.run_attempt) !== normalized.parentRunAttempt) {
    throw error("parent Release run attempt does not match the continuation pointer");
  }
  const rootWorkflow = validate(root, normalized.rootRunId, "root Release run", { requireComplete: true });
  const currentWorkflow = validate(current.metadata, current.id, "current Release run");
  if (parentWorkflow !== rootWorkflow || parentWorkflow !== currentWorkflow) {
    throw error("continuation root, parent, and current run use different workflows");
  }
  if (current.id === normalized.parentRunId) throw error("continuation cannot consume its own parent artifact");
  return parentWorkflow;
}

export function requireCompletedContinuationParent(run, pointer) {
  const normalized = validateReleaseContinuationPointer(pointer);
  if (run === null || Array.isArray(run) || typeof run !== "object") {
    throw permanentError("parent Release run metadata must be an object");
  }
  if (
    Number(run.id) !== normalized.parentRunId
    || Number(run.run_attempt) !== normalized.parentRunAttempt
    || run.head_sha !== normalized.releaseCommit
    || run.event !== "workflow_dispatch"
  ) {
    throw permanentError("parent Release run metadata does not match the continuation pointer");
  }
  if (run.status !== "completed") {
    throw new RetryableReadError("exact continuation parent is still running");
  }
  if (run.conclusion !== "success") {
    throw permanentError("exact continuation parent completed without success");
  }
  return run;
}

function completedContinuationParent(repo, pointer) {
  return retryReadOperationSync(
    `wait for exact continuation parent ${pointer.parentRunId} attempt ${pointer.parentRunAttempt}`,
    () => requireCompletedContinuationParent(
      ghJson(repo, `actions/runs/${pointer.parentRunId}`, `parent Release run ${pointer.parentRunId}`),
      pointer,
    ),
    {
      attemptTimeoutMs: 60_000,
      baseDelayMs: 2_000,
      deadlineMs: RELEASE_CONTINUATION_PARENT_COMPLETION_DEADLINE_MS,
      maxAttempts: 10,
      maxDelayMs: 60_000,
    },
  );
}

export function selectContinuationAuthorizationArtifact(listing, pointer) {
  const normalized = validateReleaseContinuationPointer(pointer);
  if (
    listing === null
    || Array.isArray(listing)
    || typeof listing !== "object"
    || !Array.isArray(listing.artifacts)
  ) {
    throw permanentError("continuation authorization artifact listing must be an object");
  }
  const expectedName = continuationAuthorizationArtifactName(normalized);
  const matches = listing.artifacts.filter((candidate) => candidate?.name === expectedName);
  if (matches.length === 0) {
    throw new RetryableReadError("exact dispatched-child authorization artifact is not visible yet");
  }
  if (matches.length !== 1) {
    throw permanentError("exact dispatched-child authorization artifact identity is ambiguous");
  }
  const [metadata] = matches;
  const artifact = normalizeArtifactIdentity({
    digest: metadata.digest,
    id: metadata.id,
    name: metadata.name,
    size: metadata.size_in_bytes,
  }, "continuation authorization artifact metadata");
  if (
    metadata.expired !== false
    || Number(metadata.workflow_run?.id) !== normalized.parentRunId
  ) {
    throw permanentError("continuation authorization artifact is expired or bound to the wrong parent run");
  }
  return artifact;
}

function exactAuthorizationArtifact(repo, pointer) {
  const name = continuationAuthorizationArtifactName(pointer);
  return retryReadOperationSync(
    `wait for dispatched-child authorization ${name}`,
    () => selectContinuationAuthorizationArtifact(
      ghJson(
        repo,
        `actions/runs/${pointer.parentRunId}/artifacts?name=${encodeURIComponent(name)}&per_page=100`,
        `continuation authorization artifacts for parent ${pointer.parentRunId}`,
      ),
      pointer,
    ),
    {
      attemptTimeoutMs: 60_000,
      baseDelayMs: 2_000,
      deadlineMs: RELEASE_CONTINUATION_AUTHORIZATION_DISCOVERY_DEADLINE_MS,
      maxAttempts: 10,
      maxDelayMs: 60_000,
    },
  );
}

function exactArtifactZip(repo, artifact, label) {
  return retryReadOperationSync(
    label,
    ({ attemptTimeoutMs }) => runGitHubReadSync(
      [
        "api",
        "-H",
        "X-GitHub-Api-Version: 2022-11-28",
        `repos/${repo}/actions/artifacts/${artifact.id}/zip`,
      ],
      {
        binary: true,
        label,
        maxBuffer: MAX_ARTIFACT_BYTES,
        attemptTimeoutMs,
        deadlineMs: attemptTimeoutMs,
        maxAttempts: 1,
        baseDelayMs: 0,
        maxDelayMs: 0,
      },
    ),
    {
      attemptTimeoutMs: 5 * 60_000,
      deadlineMs: RELEASE_CONTINUATION_ARTIFACT_DOWNLOAD_DEADLINE_MS,
      maxAttempts: 4,
    },
  );
}

export function openContinuationAuthorization(bytes, artifact, pointer, { currentRunId, repo }) {
  if (
    !Buffer.isBuffer(bytes)
    || bytes.length !== artifact.size
    || `sha256:${sha256Bytes(bytes)}` !== artifact.digest
  ) {
    throw error("continuation authorization ZIP does not match immutable GitHub metadata");
  }
  const directory = mkdtempSync(path.join(os.tmpdir(), "oliphaunt-continuation-authorization-"));
  try {
    const archive = path.join(directory, "authorization.zip");
    writeFileSync(archive, bytes, { flag: "wx", mode: 0o600 });
    const members = command("unzip", ["-Z1", archive], { stdoutTerminator: "\n" })
      .split(/\r?\n/u)
      .filter(Boolean);
    if (members.length !== 1 || members[0] !== AUTHORIZATION_MEMBER) {
      throw error(`continuation authorization artifact must contain only ${AUTHORIZATION_MEMBER}`);
    }
    const receiptBytes = commandBytes(
      "unzip",
      ["-p", archive, AUTHORIZATION_MEMBER],
      { maxOutputBytes: 32 * 1024 },
    );
    if (!Buffer.isBuffer(receiptBytes) || receiptBytes.length === 0 || receiptBytes.length > 32 * 1024) {
      throw error("continuation authorization receipt has an invalid size");
    }
    const receipt = validateReleaseContinuationAuthorization(
      json(receiptBytes.toString("utf8"), "continuation authorization receipt"),
      { currentRunId, pointer, repo },
    );
    if (receiptBytes.toString("utf8") !== serializeReleaseContinuationAuthorization(receipt)) {
      throw error("continuation authorization receipt is not canonical JSON");
    }
    return receipt;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export function readContinuationAuthorization(repo, pointer, currentRunId) {
  const artifact = exactAuthorizationArtifact(repo, pointer);
  const bytes = exactArtifactZip(
    repo,
    artifact,
    `download dispatched-child authorization artifact ${artifact.id}`,
  );
  return openContinuationAuthorization(bytes, artifact, pointer, { currentRunId, repo });
}

export function readExactContinuationArtifact(repo, pointer) {
  const normalized = validateReleaseContinuationPointer(pointer);
  const metadata = ghJson(repo, `actions/artifacts/${normalized.artifact.id}`, `continuation artifact ${normalized.artifact.id}`);
  validateContinuationArtifactMetadata(metadata, normalized);
  const bytes = exactArtifactZip(
    repo,
    normalized.artifact,
    `download continuation artifact ${normalized.artifact.id}`,
  );
  if (!Buffer.isBuffer(bytes) || bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    throw error("continuation artifact transport did not return a ZIP archive");
  }
  const observedDigest = `sha256:${sha256Bytes(bytes)}`;
  if (bytes.length !== normalized.artifact.size || observedDigest !== normalized.artifact.digest) {
    throw error("continuation artifact ZIP size/digest does not match the exact pointer");
  }
  const parent = completedContinuationParent(repo, normalized);
  const root = normalized.rootRunId === normalized.parentRunId
    ? parent
    : ghJson(repo, `actions/runs/${normalized.rootRunId}`, `root Release run ${normalized.rootRunId}`);
  return { bytes, metadata, parent, root };
}

function memberContract(operation) {
  const common = new Set(["release-continuation-contract.json"]);
  if (operation === "publish-bootstrap") {
    common.add("bootstrap-execution-result.json");
    common.add("bootstrap-ledger/");
  } else {
    common.add("normal-publication-execution-result.json");
    common.add("normal-publication-checkpoint.json");
    common.add(CONTINUATION_PACER_MEMBER);
    common.add(CONTINUATION_CORE_JOURNAL_MEMBER);
  }
  return common;
}

function memberBytes(archive, member) {
  const bytes = commandBytes("unzip", ["-p", archive, member]);
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MAX_ARTIFACT_BYTES) {
    throw error(`continuation artifact member ${member} has an invalid size`);
  }
  return bytes;
}

export function openContinuationEnvelope(bytes, pointer) {
  const normalizedPointer = validateReleaseContinuationPointer(pointer);
  if (!Buffer.isBuffer(bytes)) throw error("continuation envelope must be opened from exact ZIP bytes");
  const directory = mkdtempSync(path.join(os.tmpdir(), "oliphaunt-release-continuation-"));
  try {
    const archive = path.join(directory, "continuation.zip");
    writeFileSync(archive, bytes, { flag: "wx", mode: 0o600 });
    const members = command("unzip", ["-Z1", archive], { stdoutTerminator: "\n" })
      .split(/\r?\n/u)
      .filter(Boolean);
    const allowed = memberContract(normalizedPointer.operation);
    const seen = new Set();
    const checkpoints = [];
    for (const member of members) {
      if (
        member.startsWith("/")
        || member.includes("\\")
        || member.split("/").includes("..")
        || /[\u0000-\u001f\u007f]/u.test(member)
        || seen.has(member)
      ) {
        throw error(`continuation artifact contains unsafe or repeated member ${JSON.stringify(member)}`);
      }
      seen.add(member);
      const checkpointName = member.startsWith("bootstrap-ledger/")
        ? member.slice("bootstrap-ledger/".length)
        : member;
      if (normalizedPointer.operation === "publish-bootstrap" && CHECKPOINT.test(checkpointName)) {
        if (member !== checkpointName && member !== `bootstrap-ledger/${checkpointName}`) {
          throw error(`bootstrap checkpoint has unexpected archive path ${member}`);
        }
        checkpoints.push({ member, name: checkpointName });
      } else if (!allowed.has(member)) {
        throw error(`continuation artifact contains unexpected member ${JSON.stringify(member)}`);
      }
    }
    const resultName = normalizedPointer.operation === "publish-bootstrap"
      ? "bootstrap-execution-result.json"
      : "normal-publication-execution-result.json";
    const stateName = "normal-publication-checkpoint.json";
    const requiredMembers = ["release-continuation-contract.json", resultName];
    if (normalizedPointer.operation === "publish") {
      requiredMembers.push(CONTINUATION_PACER_MEMBER, CONTINUATION_CORE_JOURNAL_MEMBER);
    }
    for (const required of requiredMembers) {
      if (!seen.has(required)) throw error(`continuation artifact is missing ${required}`);
    }
    if (normalizedPointer.operation === "publish" && !seen.has(stateName)) {
      throw error(`continuation artifact is missing ${stateName}`);
    }
    if (normalizedPointer.operation === "publish-bootstrap" && checkpoints.length === 0) {
      throw error("bootstrap continuation artifact contains no immutable checkpoints");
    }
    const contractBytes = memberBytes(archive, "release-continuation-contract.json");
    const contract = validateReleaseContinuationContract(
      json(contractBytes.toString("utf8"), "continuation contract"),
      {
        contractDigest: normalizedPointer.contractDigest,
        generation: normalizedPointer.generation,
        operation: normalizedPointer.operation,
        parentRunAttempt: normalizedPointer.parentRunAttempt,
        parentRunId: normalizedPointer.parentRunId,
        releaseCommit: normalizedPointer.releaseCommit,
        rootRunId: normalizedPointer.rootRunId,
      },
    );
    if (
      contract.lineage.maxGenerations !== normalizedPointer.maxGenerations
      || contract.lineage.capacityDeferralAllowance
        !== normalizedPointer.capacityDeferralAllowance
      || contract.lineage.deadlineDeferralBudget
        !== normalizedPointer.deadlineDeferralBudget
      || contract.lineage.deadlineDeferralsUsed
        !== normalizedPointer.deadlineDeferralsUsed
      || contract.lineage.rateLimitDeferralBudget
        !== normalizedPointer.rateLimitDeferralBudget
      || contract.lineage.rateLimitDeferralsUsed
        !== normalizedPointer.rateLimitDeferralsUsed
      || stableJson(contract.githubState) !== stableJson(normalizedPointer.githubState)
    ) {
      throw error("continuation contract generation policy differs from its pointer");
    }
    const executionResultBytes = memberBytes(archive, resultName);
    if (sha256Bytes(executionResultBytes) !== contract.outcome.executionResultDigest) {
      throw error("continuation execution-result bytes do not match the contract");
    }
    const executionResult = validateReleaseExecutionResult(
      json(executionResultBytes.toString("utf8"), "continuation execution result"),
      {
        lock: contract.lock,
        operation: contract.operation,
        products: contract.products,
        releaseCommit: contract.source.commit,
        releaseTree: contract.source.tree,
      },
    );
    if (
      executionResult.decision !== "deferred"
      || executionResult.deferralMode !== contract.outcome.deferralMode
      || executionResult.completedIds.length !== contract.outcome.completedCount
      || executionResult.newlyCompletedIds.length !== contract.outcome.progressCount
      || executionResult.remainingIds.length !== contract.outcome.remainingCount
      || executionResult.notBeforeEpochSeconds !== contract.outcome.notBeforeEpochSeconds
    ) {
      throw error("continuation execution result disagrees with the sealed outcome envelope");
    }
    let stateBytes = null;
    let githubPacerBytes = null;
    let githubCoreJournalBytes = null;
    let checkpointEntries = [];
    if (normalizedPointer.operation === "publish") {
      stateBytes = memberBytes(archive, stateName);
      if (sha256Bytes(stateBytes) !== contract.state.digest || contract.state.entryCount !== 1) {
        throw error("normal-publication checkpoint bytes do not match the continuation contract");
      }
      githubPacerBytes = memberBytes(archive, CONTINUATION_PACER_MEMBER);
      githubCoreJournalBytes = memberBytes(archive, CONTINUATION_CORE_JOURNAL_MEMBER);
      const observedGitHubState = continuationGitHubStateIdentity({
        journalBytes: githubCoreJournalBytes,
        lineage: {
          headSha: contract.source.commit,
          repository: contract.githubState.repository,
          rootRunId: String(contract.lineage.rootRunId),
        },
        pacerBytes: githubPacerBytes,
      });
      if (stableJson(observedGitHubState) !== stableJson(contract.githubState)) {
        throw error("continuation GitHub pacer/journal bytes do not match the contract");
      }
    } else {
      checkpointEntries = checkpoints
        .map(({ member, name }) => ({ bytes: memberBytes(archive, member), name }))
        .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
      if (new Set(checkpointEntries.map(({ name }) => name)).size !== checkpointEntries.length) {
        throw error("bootstrap continuation artifact repeats a checkpoint identity");
      }
      const identity = checkpointEntries.map(({ bytes: entryBytes, name }) => ({
        name,
        sha256: sha256Bytes(entryBytes),
        size: entryBytes.length,
      }));
      if (
        sha256Bytes(stableJson(identity)) !== contract.state.digest
        || checkpointEntries.length !== contract.state.entryCount
      ) {
        throw error("bootstrap checkpoint set does not match the continuation contract");
      }
    }
    return {
      checkpointEntries,
      contract,
      contractBytes,
      executionResult,
      executionResultBytes,
      githubCoreJournalBytes,
      githubPacerBytes,
      stateBytes,
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export function currentRunMetadata(repo, currentRunId) {
  return ghJson(repo, `actions/runs/${currentRunId}`, `current Release run ${currentRunId}`);
}
