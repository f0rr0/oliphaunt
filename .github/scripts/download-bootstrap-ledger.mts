#!/usr/bin/env bun
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  createSiblingStage,
  promoteDirectory,
  removeTemporaryPath,
  stageExistingDirectory,
} from '../../tools/packaging/atomic-directory.mts';
import { readPortableArchiveEntries } from '../../tools/packaging/portable-archive.mts';
import {
  boundedResponseBytes,
  GitHubReadError,
  requestGithubDownload,
  requestGithubJsonWithRetry,
  requestGithubPages,
} from '../../tools/release/github-read.mts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ARTIFACT = 'oliphaunt-bootstrap-ledger';
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

function timestamp(value, label) {
  if (typeof value !== 'string' || !value.endsWith('Z')) fail(`${label} must be a UTC timestamp`);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) fail(`${label} must be a valid UTC timestamp`);
  return milliseconds;
}

function positiveIntegerString(value, label) {
  const rendered = String(value ?? '');
  if (!/^[1-9][0-9]*$/u.test(rendered)) fail(`${label} must be a positive integer`);
  return rendered;
}

function attemptNumber(value) {
  const rendered = positiveIntegerString(value, 'GITHUB_RUN_ATTEMPT');
  const parsed = Number(rendered);
  if (!Number.isSafeInteger(parsed)) fail('GITHUB_RUN_ATTEMPT must be a safe integer');
  return parsed;
}

async function ledgerArtifactInventory(repo, sha, currentRun) {
  const artifacts = await requestGithubPages(
    `repos/${repo}/actions/artifacts?name=${encodeURIComponent(ARTIFACT)}`,
    {
      cwd: ROOT,
      itemsField: 'artifacts',
      label: `repository ${ARTIFACT} inventory`,
      maxBuffer: MAX_ARTIFACT_BYTES,
    },
  );
  const byRun = new Map();
  for (const entry of artifacts) {
    if (
      entry === null ||
      Array.isArray(entry) ||
      typeof entry !== 'object' ||
      entry.name !== ARTIFACT ||
      entry.workflow_run === null ||
      Array.isArray(entry.workflow_run) ||
      typeof entry.workflow_run !== 'object' ||
      !/^[1-9][0-9]*$/u.test(String(entry.workflow_run.id ?? '')) ||
      typeof entry.workflow_run.head_sha !== 'string'
    ) {
      fail(`repository ${ARTIFACT} inventory contains malformed workflow binding`);
    }
    const runId = String(entry.workflow_run.id);
    if (runId !== currentRun) continue;
    if (entry.workflow_run.head_sha !== sha) {
      fail(`current Release run ${currentRun} artifact disagrees with its exact-SHA binding`);
    }
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
    if (entry === null || Array.isArray(entry) || typeof entry !== 'object') {
      fail(`Release run ${runId} contains malformed ${ARTIFACT} metadata`);
    }
    if (entry.expired !== false)
      fail(`${ARTIFACT} in Release run ${runId} has ambiguous expiry metadata`);
    const id = positiveIntegerString(entry.id, `${ARTIFACT} artifact id in Release run ${runId}`);
    if (!Number.isSafeInteger(entry.size_in_bytes) || entry.size_in_bytes <= 0) {
      fail(`${ARTIFACT} artifact ${id} has an invalid immutable byte size`);
    }
    if (typeof entry.digest !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(entry.digest)) {
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
  const normalizedRunId = positiveIntegerString(runId, 'current Release run id');
  const boundary = timestamp(currentAttemptStartedAt, 'current Release run attempt start');
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

export function validateAttemptMetadata(metadata, { runId, attempt, sha }) {
  if (metadata === null || Array.isArray(metadata) || typeof metadata !== 'object') {
    fail('current Release run attempt metadata must be an object');
  }
  const normalizedRunId = positiveIntegerString(runId, 'current Release run id');
  if (String(metadata.id ?? '') !== normalizedRunId)
    fail('current attempt metadata has the wrong run id');
  if (metadata.run_attempt !== attempt)
    fail('current attempt metadata has the wrong attempt number');
  if (metadata.head_sha !== sha) fail('current attempt metadata has the wrong release SHA');
  if (metadata.event !== 'workflow_dispatch')
    fail('current attempt metadata is not a workflow_dispatch run');
  timestamp(metadata.run_started_at, 'current Release run attempt run_started_at');
  return metadata.run_started_at;
}

export function validateCurrentRunMetadata(metadata, { runId, sha }) {
  if (metadata === null || Array.isArray(metadata) || typeof metadata !== 'object') {
    fail('current Release run metadata must be an object');
  }
  const normalizedRunId = positiveIntegerString(runId, 'current Release run id');
  if (String(metadata.id ?? '') !== normalizedRunId)
    fail('current Release run metadata has the wrong run id');
  if (metadata.head_sha !== sha) fail('current Release run metadata has the wrong release SHA');
  if (metadata.event !== 'workflow_dispatch')
    fail('current Release run metadata is not a workflow_dispatch run');
  positiveIntegerString(metadata.workflow_id, 'current Release workflow id');
  timestamp(metadata.created_at, 'current Release run created_at');
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
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function same(left, right) {
  return statSync(left).size === statSync(right).size && sha256(left) === sha256(right);
}

export async function downloadBootstrapArtifact(repo, artifact, destination) {
  const id = positiveIntegerString(artifact.id, 'bootstrap ledger artifact id');
  if (
    artifact.name !== ARTIFACT ||
    artifact.expired !== false ||
    !Number.isSafeInteger(artifact.size_in_bytes) ||
    artifact.size_in_bytes <= 0 ||
    artifact.size_in_bytes > MAX_ARTIFACT_BYTES ||
    !/^sha256:[0-9a-f]{64}$/u.test(artifact.digest ?? '')
  )
    fail('bootstrap ledger artifact has invalid immutable metadata');
  const deadline = Date.now() + 15 * 60_000;
  for (let attempt = 1; attempt <= 4; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) fail('bootstrap ledger download deadline expired');
    const directory = createSiblingStage(destination, `artifact-${id}`);
    const archive = path.join(directory, '.artifact.zip');
    try {
      const response = await requestGithubDownload(
        `https://api.github.com/repos/${repo}/actions/artifacts/${id}/zip`,
        { timeoutMs: Math.min(5 * 60_000, remaining) },
      );
      const bytes = await boundedResponseBytes(
        response,
        MAX_ARTIFACT_BYTES,
        'bootstrap ledger artifact',
      );
      if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
        fail(`bootstrap ledger artifact ${id} did not return a ZIP archive`);
      }
      const digest = createHash('sha256').update(bytes).digest('hex');
      if (
        bytes.length !== artifact.size_in_bytes ||
        digest !== artifact.digest.slice('sha256:'.length)
      ) {
        fail(
          `bootstrap ledger artifact ${id} transport identity mismatch: expected ` +
            `${artifact.size_in_bytes}/${artifact.digest}, got ${bytes.length}/sha256:${digest}`,
        );
      }
      writeFileSync(archive, bytes, { flag: 'wx' });
      const entries = readPortableArchiveEntries(archive, {
        maxArchiveBytes: MAX_ARTIFACT_BYTES,
      });
      for (const [name, entry] of entries) {
        if (!CHECKPOINT.test(name) || !entry.isFile) {
          fail(
            `bootstrap ledger artifact contains unexpected archive member ${JSON.stringify(name)}`,
          );
        }
      }
      for (const [name, entry] of entries) {
        writeFileSync(path.join(directory, name), entry.data(), { flag: 'wx', mode: 0o600 });
      }
      rmSync(archive, { force: true });
      if (files(directory).length === 0) {
        fail(`bootstrap ledger artifact ${id} contains no checkpoints`);
      }
      return directory;
    } catch (error) {
      removeTemporaryPath(directory);
      if (error instanceof GitHubReadError && !error.retryable) throw error;
      if (attempt === 4) fail(`bootstrap ledger retry budget exhausted: ${error.message}`);
      await new Promise((resolve) => setTimeout(resolve, 750 * attempt));
    }
  }
}

async function restoreArtifact(repo, runId, artifact, destination, sourceDescription) {
  const artifactId = positiveIntegerString(artifact.id, 'bootstrap ledger artifact id');
  const temporary = await downloadBootstrapArtifact(repo, artifact, destination);
  const stage = stageExistingDirectory(destination, 'restore');
  try {
    const sources = files(temporary);
    if (sources.length === 0)
      fail(`bootstrap ledger artifact ${artifactId} contains no checkpoints`);
    for (const source of sources) {
      const name = path.basename(source);
      const relative = path.relative(temporary, source).split(path.sep).join('/');
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

export async function main() {
  const repo = required('GH_REPO');
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/u.test(repo))
    fail('GH_REPO must be owner/repository');
  const sha = process.env.GITHUB_SHA || required('RELEASE_HEAD_SHA');
  if (!/^[0-9a-f]{40}$/u.test(sha)) fail('RELEASE_HEAD_SHA must be a full lowercase commit SHA');
  const destination = path.resolve(
    ROOT,
    process.env.BOOTSTRAP_LEDGER_PATH || 'target/release/bootstrap-ledger',
  );
  const currentRun = positiveIntegerString(required('GITHUB_RUN_ID'), 'GITHUB_RUN_ID');
  const currentAttempt = attemptNumber(required('GITHUB_RUN_ATTEMPT'));
  const currentRunMetadata = await requestGithubJsonWithRetry(
    `https://api.github.com/repos/${repo}/actions/runs/${currentRun}`,
  );
  validateCurrentRunMetadata(currentRunMetadata, {
    runId: currentRun,
    sha,
  });
  const artifactsByRun = await ledgerArtifactInventory(repo, sha, currentRun);

  let excludedCurrentAttemptIds = [];
  if (currentAttempt > 1) {
    const metadata = await requestGithubJsonWithRetry(
      `https://api.github.com/repos/${repo}/actions/runs/${currentRun}/attempts/${currentAttempt}`,
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
      await restoreArtifact(
        repo,
        currentRun,
        selected.artifact,
        destination,
        'an earlier attempt of the current run',
      );
      return;
    }
  }

  if (excludedCurrentAttemptIds.length > 0) {
    fail(
      'the current rerun attempt has bootstrap ledger artifact(s), but no artifact can be proven to ' +
        `predate the attempt; refusing genesis ` +
        `(excluded artifact ids: ${excludedCurrentAttemptIds.join(', ')})`,
    );
  }
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, 'found=false\n');
  console.log(
    'no prior bootstrap checkpoint artifact exists for this release SHA; starting a genesis chain',
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((cause) => {
    console.error(cause instanceof Error ? cause.message : String(cause));
    process.exit(1);
  });
}
