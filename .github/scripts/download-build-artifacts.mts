#!/usr/bin/env bun
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  createReadStream,
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import {
  createSiblingStage,
  promoteDirectory,
  releaseTemporaryPath,
  removeTemporaryPath,
  stageExistingDirectory,
} from '../../tools/packaging/atomic-directory.mts';
import { validateZipEntryTypes } from '../../tools/packaging/portable-archive.mts';
import {
  isRetryableGitHubReadError,
  RetryableReadError,
  requestGithubDownload,
  requestGithubJsonWithRetry,
  requestGithubPages,
} from '../../tools/release/github-read.mts';
import { mergeChecksumManifest } from './merge-checksum-manifest.mts';

const USAGE =
  'usage: download-build-artifacts.sh <workflow> <sha> <destination> [--run-id <id>] [--job <name>] ' +
  '[--artifact-metadata-json <json>] --artifact <name> [--artifact <name>...]';
const SNAPSHOT_SCHEMA = 'oliphaunt-github-actions-run-snapshot-v1';
const FULL_SHA = /^[0-9a-f]{40}$/u;
const MAX_CAPTURE_BYTES = 128 * 1024 * 1024;
const ARTIFACT_DOWNLOAD_TOTAL_DEADLINE_MS = 65 * 60_000;
const ARTIFACT_DOWNLOAD_ATTEMPT_TIMEOUT_MS = 40 * 60_000;

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function fail(message, code = 1) {
  throw Object.assign(new Error(message), { exitCode: code });
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
    requiredJob: '',
    selectedRunId: '',
    artifactMetadataJson: '',
  };
  for (let index = 0; index < rest.length; ) {
    const arg = rest[index];
    if (arg === '--run-id') {
      args.selectedRunId = valueAfter(rest, index, '--run-id requires a run id');
      index += 2;
    } else if (arg === '--job') {
      args.requiredJob = valueAfter(rest, index, '--job requires a name');
      index += 2;
    } else if (arg === '--artifact') {
      args.artifacts.push(valueAfter(rest, index, '--artifact requires a name'));
      index += 2;
    } else if (arg === '--artifact-metadata-json') {
      args.artifactMetadataJson = valueAfter(rest, index, '--artifact-metadata-json requires JSON');
      index += 2;
    } else {
      fail(`unknown argument: ${arg}`, 2);
    }
  }
  if (args.artifacts.length === 0) {
    fail('at least one --artifact is required', 2);
  }
  if (new Set(args.artifacts).size !== args.artifacts.length) {
    fail('each --artifact identity must be requested exactly once', 2);
  }
  args.expectedArtifactMetadata = parseExpectedArtifactMetadata(
    args.artifactMetadataJson,
    args.artifacts,
  );
  if (args.expectedArtifactMetadata !== null && args.selectedRunId === '') {
    fail(
      '--artifact-metadata-json requires --run-id so immutable artifact IDs cannot drift between runs',
      2,
    );
  }
  return args;
}

function parseExpectedArtifactMetadata(raw, requested) {
  if (raw === '') return null;
  let rows;
  try {
    rows = JSON.parse(raw);
  } catch (cause) {
    fail(`--artifact-metadata-json must be strict JSON: ${cause.message}`, 2);
  }
  if (!Array.isArray(rows) || rows.length < requested.length) {
    fail('--artifact-metadata-json must contain every requested artifact', 2);
  }
  const expectedNames = [...requested].sort();
  const normalized = rows
    .map((row) => {
      if (
        row === null ||
        Array.isArray(row) ||
        typeof row !== 'object' ||
        JSON.stringify(Object.keys(row).sort()) !==
          JSON.stringify(['digest', 'id', 'name', 'size']) ||
        typeof row.name !== 'string' ||
        !Number.isSafeInteger(row.id) ||
        row.id < 1 ||
        !Number.isSafeInteger(row.size) ||
        row.size < 1 ||
        typeof row.digest !== 'string' ||
        !/^sha256:[0-9a-f]{64}$/u.test(row.digest)
      ) {
        fail('--artifact-metadata-json contains a malformed immutable artifact identity', 2);
      }
      return { digest: row.digest, id: row.id, name: row.name, size: row.size };
    })
    .sort((left, right) => compareText(left.name, right.name));
  if (new Set(normalized.map(({ name }) => name)).size !== normalized.length) {
    fail('--artifact-metadata-json must contain unique artifact names', 2);
  }
  const all = new Map(normalized.map((row) => [row.name, row]));
  if (expectedNames.some((name) => !all.has(name))) {
    fail('--artifact-metadata-json is missing a requested artifact name', 2);
  }
  // A gate can authorize a larger immutable artifact set than one consumer
  // needs. Keep every row schema-validated while returning only the explicitly
  // requested subset; this avoids re-downloading a large capsule merely to
  // install its companion lock.
  return new Map(expectedNames.map((name) => [name, all.get(name)]));
}

function valueAfter(argv, index, message) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    fail(message, 2);
  }
  return value;
}

function requireEnv(name) {
  const value = process.env[name];
  if (value === undefined || value === '') {
    fail(`${name} is required`);
  }
  return value;
}

function parsedJson(text, label) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} returned invalid JSON: ${error.message}`);
  }
}

function safeRunId(value) {
  const rendered = String(value ?? '');
  if (!/^[1-9][0-9]*$/u.test(rendered))
    throw new Error('workflow run id must be a positive integer');
  return rendered;
}

function snapshotFile(runId) {
  const directory = process.env.OLIPHAUNT_GITHUB_RUN_SNAPSHOT_DIR?.trim() ?? '';
  if (directory === '') return null;
  return path.join(path.resolve(directory), `run-${safeRunId(runId)}.json`);
}

function assertRegularSnapshotFile(file) {
  const metadata = lstatSync(file, { throwIfNoEntry: false });
  if (metadata !== undefined && (!metadata.isFile() || metadata.isSymbolicLink())) {
    throw new Error(`GitHub run snapshot must be an absent or regular non-symlink file: ${file}`);
  }
}

function normalizeArtifact(entry, runId) {
  if (
    entry === null ||
    Array.isArray(entry) ||
    typeof entry !== 'object' ||
    typeof entry.name !== 'string' ||
    entry.name.length === 0 ||
    !Number.isSafeInteger(entry.id) ||
    entry.id <= 0 ||
    !Number.isSafeInteger(entry.size_in_bytes) ||
    entry.size_in_bytes < 0 ||
    typeof entry.expired !== 'boolean' ||
    typeof entry.digest !== 'string' ||
    !/^sha256:[0-9a-f]{64}$/u.test(entry.digest)
  ) {
    throw new Error(`artifact inventory for run ${runId} contains malformed immutable metadata`);
  }
  if (entry.workflow_run?.id !== undefined && String(entry.workflow_run.id) !== String(runId)) {
    throw new Error(`artifact ${entry.id} is not bound to workflow run ${runId}`);
  }
  return {
    digest: entry.digest,
    expired: entry.expired,
    id: entry.id,
    name: entry.name,
    size_in_bytes: entry.size_in_bytes,
  };
}

async function artifactRecords(repo, runId, options = {}) {
  const records = await requestGithubPages(`repos/${repo}/actions/runs/${runId}/artifacts`, {
    ...options,
    itemsField: 'artifacts',
    label: `artifact inventory for run ${runId}`,
  });
  return records.map((entry) => normalizeArtifact(entry, runId));
}

function exactArtifact(records, runId, name) {
  const matches = records.filter((entry) => entry.name === name && entry.expired === false);
  if (matches.length !== 1) {
    throw new Error(
      `${runId} must contain exactly one non-expired artifact named ${name}; found ${matches.length}`,
    );
  }
  return matches[0];
}

function exactExpectedArtifact(records, runId, name, expectedMetadata = null) {
  const observed = exactArtifact(records, runId, name);
  const expected = expectedMetadata?.get(name);
  if (
    expected !== undefined &&
    (observed.id !== expected.id ||
      observed.digest !== expected.digest ||
      observed.size_in_bytes !== expected.size)
  ) {
    throw new Error(
      `${runId}/${name} immutable identity drifted: expected id=${expected.id} size=${expected.size} digest=${expected.digest}; ` +
        `observed id=${observed.id} size=${observed.size_in_bytes} digest=${observed.digest}`,
    );
  }
  return observed;
}

async function jobRecords(repo, runId) {
  const records = await requestGithubPages(
    `repos/${repo}/actions/runs/${runId}/jobs?filter=latest`,
    {
      itemsField: 'jobs',
      label: `jobs for run ${runId}`,
    },
  );
  const jobs = [];
  for (const job of records) {
    if (
      job === null ||
      Array.isArray(job) ||
      typeof job !== 'object' ||
      !Number.isSafeInteger(job.id) ||
      job.id <= 0 ||
      typeof job.name !== 'string' ||
      job.name.length === 0 ||
      typeof job.status !== 'string' ||
      (job.conclusion !== null && typeof job.conclusion !== 'string') ||
      !Number.isSafeInteger(job.run_attempt) ||
      job.run_attempt <= 0
    ) {
      throw new Error(`job inventory for run ${runId} contains malformed metadata`);
    }
    jobs.push({
      conclusion: job.conclusion,
      id: job.id,
      name: job.name,
      run_attempt: job.run_attempt,
      status: job.status,
    });
  }
  return jobs;
}

function validateSnapshot(snapshot) {
  if (
    snapshot === null ||
    Array.isArray(snapshot) ||
    typeof snapshot !== 'object' ||
    snapshot.schema !== SNAPSHOT_SCHEMA ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(snapshot.repo) ||
    !/^[1-9][0-9]*$/u.test(snapshot.runId) ||
    !FULL_SHA.test(snapshot.headSha) ||
    !Number.isSafeInteger(snapshot.workflowId) ||
    snapshot.workflowId <= 0 ||
    typeof snapshot.workflowName !== 'string' ||
    snapshot.workflowName.length === 0 ||
    snapshot.status !== 'completed' ||
    snapshot.conclusion !== 'success' ||
    !Number.isSafeInteger(snapshot.runAttempt) ||
    snapshot.runAttempt <= 0 ||
    !Array.isArray(snapshot.jobs) ||
    !Array.isArray(snapshot.artifacts)
  ) {
    throw new Error('cached GitHub workflow run snapshot is malformed or not completed/success');
  }
  const artifacts = snapshot.artifacts.map((entry) => normalizeArtifact(entry, snapshot.runId));
  const artifactIds = new Set();
  for (const artifact of artifacts) {
    if (artifactIds.has(artifact.id))
      throw new Error('cached GitHub workflow run snapshot repeats an artifact id');
    artifactIds.add(artifact.id);
  }
  for (const job of snapshot.jobs) {
    if (
      job === null ||
      Array.isArray(job) ||
      typeof job !== 'object' ||
      !Number.isSafeInteger(job.id) ||
      job.id <= 0 ||
      typeof job.name !== 'string' ||
      typeof job.status !== 'string' ||
      (job.conclusion !== null && typeof job.conclusion !== 'string') ||
      job.run_attempt !== snapshot.runAttempt
    ) {
      throw new Error(
        'cached GitHub workflow run snapshot contains malformed or cross-attempt jobs',
      );
    }
  }
  return { ...snapshot, artifacts };
}

async function createRunSnapshot(repo, runId) {
  const data = await requestGithubJsonWithRetry(
    `https://api.github.com/repos/${repo}/actions/runs/${runId}`,
  );
  if (
    String(data?.id ?? '') !== String(runId) ||
    !FULL_SHA.test(data?.head_sha ?? '') ||
    !Number.isSafeInteger(data?.workflow_id) ||
    data.workflow_id <= 0 ||
    data.status !== 'completed' ||
    data.conclusion !== 'success' ||
    !Number.isSafeInteger(data.run_attempt) ||
    data.run_attempt <= 0
  ) {
    throw new Error(`workflow run ${runId} is malformed or not completed/success`);
  }
  const workflow = await requestGithubJsonWithRetry(
    `https://api.github.com/repos/${repo}/actions/workflows/${data.workflow_id}`,
  );
  if (
    workflow?.id !== data.workflow_id ||
    typeof workflow?.name !== 'string' ||
    workflow.name.length === 0
  ) {
    throw new Error(`workflow ${data.workflow_id} metadata is malformed`);
  }
  return validateSnapshot({
    artifacts: await artifactRecords(repo, runId),
    conclusion: data.conclusion,
    headSha: data.head_sha.toLowerCase(),
    jobs: await jobRecords(repo, runId),
    repo,
    runAttempt: data.run_attempt,
    runId: String(runId),
    schema: SNAPSHOT_SCHEMA,
    status: data.status,
    workflowId: data.workflow_id,
    workflowName: workflow.name,
  });
}

async function runSnapshot(repo, runId) {
  const file = snapshotFile(runId);
  if (file !== null && existsSync(file)) {
    assertRegularSnapshotFile(file);
    const snapshot = validateSnapshot(
      parsedJson(readFileSync(file, 'utf8'), `cached run ${runId} snapshot`),
    );
    if (snapshot.repo !== repo || snapshot.runId !== String(runId)) {
      throw new Error(`cached run ${runId} snapshot belongs to a different repository or run`);
    }
    return snapshot;
  }
  const snapshot = await createRunSnapshot(repo, runId);
  if (file !== null) {
    mkdirSync(path.dirname(file), { recursive: true });
    assertRegularSnapshotFile(file);
    const temporary = `${file}.tmp-${process.pid}`;
    assertRegularSnapshotFile(temporary);
    try {
      writeFileSync(temporary, `${JSON.stringify(snapshot)}\n`, { flag: 'wx', mode: 0o600 });
      renameSync(temporary, file);
    } finally {
      rmSync(temporary, { force: true });
    }
  }
  return snapshot;
}

function requiredJobSuccess(snapshot, requiredJob) {
  if (requiredJob === '') {
    return true;
  }
  const matches = snapshot.jobs.filter((candidate) => candidate.name === requiredJob);
  return matches.length === 1 && matches[0]?.conclusion === 'success';
}

function runMatchesRequest(snapshot, workflow, sha) {
  return snapshot.headSha === sha.toLowerCase() && snapshot.workflowName === workflow;
}

async function candidateRunIds(repo, workflow, sha) {
  const workflows = await requestGithubPages(`repos/${repo}/actions/workflows`, {
    itemsField: 'workflows',
    label: `${workflow} workflow identity inventory`,
    maxBuffer: MAX_CAPTURE_BYTES,
  });
  const matches = workflows.filter((row) => row?.name === workflow);
  if (matches.length !== 1 || !Number.isSafeInteger(matches[0]?.id) || matches[0].id < 1) {
    throw new Error(`expected exactly one workflow named ${workflow}; found ${matches.length}`);
  }
  const runs = await requestGithubPages(
    `repos/${repo}/actions/workflows/${matches[0].id}/runs?head_sha=${encodeURIComponent(sha)}`,
    {
      itemsField: 'workflow_runs',
      label: `exact-SHA workflow runs for ${workflow} at ${sha}`,
      maxBuffer: MAX_CAPTURE_BYTES,
    },
  );
  const ids = new Set();
  const result = [];
  for (const run of runs) {
    const id = safeRunId(run?.id);
    if (
      ids.has(id) ||
      run.head_sha !== sha ||
      run.workflow_id !== matches[0].id ||
      typeof run.status !== 'string' ||
      ![
        null,
        'success',
        'failure',
        'cancelled',
        'timed_out',
        'action_required',
        'neutral',
        'skipped',
        'stale',
        'startup_failure',
      ].includes(run.conclusion)
    ) {
      throw new Error(
        `workflow run inventory for ${workflow} at ${sha} contains malformed, duplicate, or inexact metadata`,
      );
    }
    ids.add(id);
    if (run.status === 'completed' && run.conclusion === 'success') result.push(id);
  }
  return result;
}

function sortedFiles(root) {
  const files = [];
  function visit(directory) {
    const entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
      compareText(left.name, right.name),
    );
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      const entryStat = lstatSync(entryPath);
      if (entryStat.isSymbolicLink()) {
        throw new Error(
          `downloaded artifact contains symbolic link ${path.relative(root, entryPath)}`,
        );
      }
      if (entryStat.isDirectory()) {
        visit(entryPath);
      } else if (entryStat.isFile()) {
        files.push(entryPath);
      } else {
        throw new Error(
          `downloaded artifact contains special file ${path.relative(root, entryPath)}`,
        );
      }
    }
  }
  visit(root);
  return files;
}

function fileSha256(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(file);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
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

function validateDownloadedArtifact(artifact, directory) {
  const files = sortedFiles(directory);
  if (files.length === 0) {
    throw new RetryableReadError(`artifact ${artifact} downloaded with an empty file envelope`);
  }
  for (const file of files) {
    const relative = path.relative(directory, file);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`artifact ${artifact} escaped its download directory`);
    }
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`artifact ${artifact} contains unsupported entry ${relative}`);
    }
  }
}

function validateZipMembers(archive, listingFile) {
  const artifact = path.basename(archive);
  if (statSync(listingFile).size > MAX_CAPTURE_BYTES)
    fail('ZIP member inventory exceeds its byte limit');
  const listing = new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(listingFile));
  if (!listing.endsWith('\n')) fail('ZIP inventory is missing its terminal newline');
  const members = listing.split(/\r?\n/u).filter(Boolean);
  if (members.length === 0)
    throw new RetryableReadError(`artifact ${artifact} ZIP archive is empty`);
  const seen = new Set();
  for (const member of members) {
    const normalized = member.endsWith('/') ? member.slice(0, -1) : member;
    if (
      normalized === '' ||
      member.includes('\\') ||
      member.startsWith('/') ||
      normalized
        .split('/')
        .some((segment) => segment === '' || segment === '.' || segment === '..') ||
      /[\u0000-\u001f\u007f]/u.test(member) ||
      seen.has(member)
    ) {
      throw new Error(
        `artifact ${artifact} ZIP contains unsafe or duplicate member ${JSON.stringify(member)}`,
      );
    }
    seen.add(member);
  }
  validateZipEntryTypes(archive);
}

async function downloadArchiveOnce(repo, identity, archive, attemptTimeoutMs) {
  try {
    const response = await requestGithubDownload(
      `https://api.github.com/repos/${repo}/actions/artifacts/${identity.id}/zip`,
      { timeoutMs: attemptTimeoutMs },
    );
    let size = 0;
    await pipeline(
      Readable.fromWeb(response.body),
      new Transform({
        transform(chunk, _encoding, callback) {
          size += chunk.length;
          callback(
            size > identity.size_in_bytes
              ? new RetryableReadError('artifact exceeds its approved byte size')
              : null,
            chunk,
          );
        },
      }),
      createWriteStream(archive, { flags: 'wx', mode: 0o600 }),
    );
  } catch (error) {
    rmSync(archive, { force: true });
    throw error;
  }
}

async function downloadArtifact(repo, artifact, expectedIdentity, destination, sharedDeadlineMs) {
  let lastError;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const remainingMs = sharedDeadlineMs - Date.now();
    if (remainingMs <= 0) {
      throw new RetryableReadError(
        `shared exact-artifact download deadline exhausted after ${attempt - 1} attempt(s)`,
        { cause: lastError },
      );
    }
    const temporary = createSiblingStage(
      destination,
      `download-${artifact.replace(/[^A-Za-z0-9_.-]/gu, '-')}`,
    );
    const archive = path.join(temporary, '.artifact.zip');
    try {
      await downloadArchiveOnce(
        repo,
        expectedIdentity,
        archive,
        Math.max(1, Math.min(ARTIFACT_DOWNLOAD_ATTEMPT_TIMEOUT_MS, remainingMs)),
      );
      const actualSize = statSync(archive).size;
      let actualDigest;
      try {
        actualDigest = await fileSha256(archive);
      } catch (cause) {
        throw new RetryableReadError(`could not hash artifact ${artifact} ZIP`, { cause });
      }
      const expectedDigest = expectedIdentity.digest.slice('sha256:'.length);
      if (actualSize !== expectedIdentity.size_in_bytes || actualDigest !== expectedDigest) {
        throw new RetryableReadError(
          `artifact ${artifact} ZIP identity mismatch: expected ${expectedIdentity.size_in_bytes}/${expectedDigest}, ` +
            `got ${actualSize}/${actualDigest}`,
        );
      }
      return temporary;
    } catch (error) {
      removeTemporaryPath(temporary);
      lastError = error;
      if (!isRetryableGitHubReadError(error)) {
        throw new Error(
          `permanent read failure for exact-ID artifact ${artifact}: ${error.message}`,
          { cause: error },
        );
      }
      if (attempt === 2) {
        throw new RetryableReadError(
          `exact-ID artifact download retry budget exhausted after ${attempt} attempts: ${error.message}`,
          { cause: error },
        );
      }
    }
  }
  throw lastError;
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
        path.basename(target).endsWith('-release-assets.sha256')
      ) {
        try {
          await mergeChecksumManifest(target, source);
        } catch (error) {
          console.error(error.message);
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

async function selectRunId(repo, args) {
  if (args.selectedRunId !== '') {
    const runId = args.selectedRunId;
    const snapshot = await runSnapshot(repo, runId);
    if (!runMatchesRequest(snapshot, args.workflow, args.sha)) {
      fail(`${args.workflow} run ${runId} does not belong to commit ${args.sha}`);
    }
    if (!requiredJobSuccess(snapshot, args.requiredJob)) {
      fail(
        `${args.workflow} run ${runId} does not satisfy required job ${args.requiredJob || '<none>'}`,
      );
    }
    for (const artifact of args.artifacts) {
      exactExpectedArtifact(snapshot.artifacts, runId, artifact, args.expectedArtifactMetadata);
    }
    return snapshot;
  }

  for (const candidate of await candidateRunIds(repo, args.workflow, args.sha)) {
    const snapshot = await runSnapshot(repo, candidate);
    if (!runMatchesRequest(snapshot, args.workflow, args.sha)) {
      continue;
    }
    if (!requiredJobSuccess(snapshot, args.requiredJob)) {
      continue;
    }
    try {
      for (const artifact of args.artifacts)
        exactExpectedArtifact(snapshot.artifacts, candidate, artifact);
      return snapshot;
    } catch {
      // A successfully read inventory that lacks the exact envelope is not a matching candidate.
    }
  }
  fail(
    `no ${args.workflow} workflow run found for ${args.sha} with required job/artifacts: ${args.requiredJob || '<workflow-success>'} / ${args.artifacts.join(' ')}`,
  );
}

async function downloadArchives(argv, scratch) {
  let repo;
  const args = parseArgs(argv);
  requireEnv('GH_TOKEN');
  repo ??= requireEnv('GH_REPO');
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/u.test(repo))
    fail('GH_REPO must be owner/repository');
  const snapshot = await selectRunId(repo, args);
  const runId = snapshot.runId;
  const identities = new Map();
  for (const artifact of args.artifacts) {
    identities.set(
      artifact,
      exactExpectedArtifact(snapshot.artifacts, runId, artifact, args.expectedArtifactMetadata),
    );
  }
  const sharedDownloadDeadlineMs = Date.now() + ARTIFACT_DOWNLOAD_TOTAL_DEADLINE_MS;

  const downloads = [];
  for (const [index, artifact] of args.artifacts.entries()) {
    console.log(`Downloading ${args.workflow} artifact ${artifact} from run ${runId}`);
    const directory = await downloadArtifact(
      repo,
      artifact,
      identities.get(artifact),
      path.join(scratch, String(index)),
      sharedDownloadDeadlineMs,
    );
    downloads.push({ artifact, directory });
  }
  writeFileSync(
    path.join(scratch, 'plan.json'),
    JSON.stringify({ destination: path.resolve(args.destination), downloads }),
    { flag: 'wx', mode: 0o600 },
  );
  writeFileSync(
    path.join(scratch, 'archives'),
    downloads.map(({ directory }) => directory + '\0').join(''),
    { flag: 'wx', mode: 0o600 },
  );
  // The enclosing Shell owns scratch cleanup across the extraction phases.
  for (const { directory } of downloads) releaseTemporaryPath(directory);
}

async function mergeArchives(scratch) {
  const { destination, downloads } = JSON.parse(
    readFileSync(path.join(scratch, 'plan.json'), 'utf8'),
  );
  const stage = stageExistingDirectory(destination, 'merge');
  try {
    for (const { artifact, directory } of downloads) {
      validateDownloadedArtifact(artifact, directory);
      if (!(await mergeDownloadedArtifact(artifact, directory, stage)))
        throw new Error(`artifact ${artifact} conflicts with the durable destination`);
    }
    promoteDirectory(stage, destination);
  } finally {
    removeTemporaryPath(stage);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [phase, scratch, ...args] = process.argv.slice(2);
    if (phase === 'download') await downloadArchives(args, scratch);
    else if (phase === 'validate-zip' && args.length === 1) validateZipMembers(scratch, args[0]);
    else if (phase === 'merge' && args.length === 0) await mergeArchives(scratch);
    else fail(USAGE, 2);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = error.exitCode ?? 1;
  }
}
