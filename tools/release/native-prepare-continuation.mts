import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPortableArchiveEntries } from '../packaging/portable-archive.mts';
import {
  authHeaders,
  boundedResponseBytes,
  githubReadOptionsFromEnv,
  requestGithubDownload,
  requestGithubPages,
  requestGithubRepositoryJson,
  retryReadOperation,
} from './github-read.mts';

const REPOSITORY = 'f0rr0/oliphaunt';
const API = `repos/${REPOSITORY}`;
const RELEASE = { name: 'Release', path: '.github/workflows/release.yml' };
const NATIVE = { name: 'Native Bazel qualification', path: '.github/workflows/bazel.yml' };
const REQUEST_JOB = 'Resolve native qualification for preparation';
const INTENT_UPLOAD_STEP = 'Retain pending Prepare intent';
const MAX_INTENT_BYTES = 64 * 1024;
const positive = (value) => Number.isSafeInteger(value) && value > 0;
const sha = (value) => typeof value === 'string' && /^[0-9a-f]{40}$/u.test(value);
export const nativePrepareIntentName = (attempt) => {
  assert(positive(attempt), 'Prepare intent requires a positive original attempt');
  return `native-prepare-intent-${attempt}`;
};

function assertIntent(intent) {
  assert(
    intent?.schema === 1 &&
      intent.repository === REPOSITORY &&
      sha(intent.sourceSha) &&
      sha(intent.sourceTree) &&
      [
        intent.originalRunId,
        intent.originalAttempt,
        intent.nativeRunId,
        intent.nativeAttempt,
      ].every(positive),
    'Malformed native Prepare intent',
  );
  assert.equal(
    Object.keys(intent).sort().join(','),
    'nativeAttempt,nativeRunId,originalAttempt,originalRunId,repository,schema,sourceSha,sourceTree',
    'Unexpected native Prepare intent fields',
  );
  return intent;
}

export function recordNativePrepareIntent(environment, checkout) {
  assert.equal(environment.GITHUB_REPOSITORY, REPOSITORY);
  assert.equal(environment.GITHUB_EVENT_NAME, 'workflow_dispatch');
  assert.equal(environment.GITHUB_REF, 'refs/heads/main');
  assert.equal(environment.GITHUB_WORKFLOW_REF, `${REPOSITORY}/${RELEASE.path}@refs/heads/main`);
  assert.equal(environment.RELEASE_OPERATION, 'prepare-release-pr');
  assert.equal(
    environment.GITHUB_SHA,
    checkout.sha,
    'Prepare intent must describe the actual checkout',
  );
  return assertIntent({
    schema: 1,
    repository: REPOSITORY,
    sourceSha: checkout.sha,
    sourceTree: checkout.tree,
    originalRunId: Number(environment.GITHUB_RUN_ID),
    originalAttempt: Number(environment.GITHUB_RUN_ATTEMPT),
    nativeRunId: Number(environment.NATIVE_PENDING_RUN_ID),
    nativeAttempt: Number(environment.NATIVE_PENDING_RUN_ATTEMPT),
  });
}

function assertRun(run, workflow, sourceSha) {
  assert(
    positive(run?.id) && positive(run.workflow_id) && positive(run.run_attempt),
    'Malformed workflow run identity',
  );
  assert.equal(run.repository?.full_name, REPOSITORY, 'Workflow run repository mismatch');
  assert.equal(
    run.head_repository?.full_name,
    REPOSITORY,
    'Workflow run source repository mismatch',
  );
  assert.equal(run.name, workflow.name, 'Workflow run name mismatch');
  assert.equal(run.path, workflow.path, 'Workflow run path mismatch');
  assert.equal(run.head_branch, 'main', 'Workflow run must originate from main');
  assert.equal(run.head_sha, sourceSha, 'Workflow run source mismatch');
  assert(['push', 'workflow_dispatch'].includes(run.event), 'Workflow run event is ineligible');
}

class PendingCompletionMetadata extends Error {}

function requireCompleted(value, label) {
  if (value.status === 'completed') return;
  assert(
    ['queued', 'in_progress', 'waiting', 'pending', 'requested'].includes(value.status) &&
      value.conclusion === null,
    `${label} has malformed completion metadata`,
  );
  throw new PendingCompletionMetadata(`${label} is not yet visible as completed`);
}

function oneJob(jobs, name, attempt, previous) {
  const matches = jobs.filter((job) => job.name === name);
  assert(matches.length <= 1, `Expected one ${name} job`);
  if (!matches.length) throw new PendingCompletionMetadata(`${name} job is not yet visible`);
  const job = matches[0];
  assert.equal(job.run_attempt, attempt, `${name} job attempt mismatch`);
  assert(positive(job.id), `${name} job identity is invalid`);
  if (previous) assert.equal(job.id, previous.id, `${name} job identity changed`);
  return job;
}

function githubIo(environment) {
  return {
    read: (endpoint, options) => requestGithubRepositoryJson(endpoint, { environment, ...options }),
    list: (endpoint, itemsField, options) =>
      requestGithubPages(endpoint, { environment, itemsField, ...options }),
    download: async (id, { timeoutMs }) =>
      boundedResponseBytes(
        await requestGithubDownload(`https://api.github.com/${API}/actions/artifacts/${id}/zip`, {
          environment,
          timeoutMs: Math.min(30_000, timeoutMs),
        }),
        MAX_INTENT_BYTES,
        'Native Prepare intent artifact',
      ),
    rerun: async (id) => {
      // A mutation is sent once. An ambiguous response needs operator inspection.
      let response;
      try {
        response = await fetch(`https://api.github.com/${API}/actions/runs/${id}/rerun`, {
          method: 'POST',
          redirect: 'error',
          signal: AbortSignal.timeout(30_000),
          headers: {
            ...authHeaders('application/vnd.github+json', environment.GH_TOKEN),
            'X-GitHub-Api-Version': '2026-03-10',
          },
        });
      } catch (cause) {
        throw new Error(
          `Prepare rerun outcome is unknown; inspect Release run ${id} before retrying`,
          { cause },
        );
      }
      assert.equal(
        response.status,
        201,
        `Prepare rerun was not acknowledged; inspect Release run ${id} before retrying`,
      );
      await response.body?.cancel?.();
    },
  };
}

async function readIntentArtifact(artifact, original, repositoryId, io) {
  assert(
    positive(artifact.id) &&
      !artifact.expired &&
      positive(artifact.size_in_bytes) &&
      artifact.size_in_bytes <= MAX_INTENT_BYTES &&
      /^sha256:[0-9a-f]{64}$/u.test(artifact.digest ?? ''),
    'Prepare intent artifact metadata is invalid or expired',
  );
  assert.equal(artifact.workflow_run?.id, original.id, 'Prepare intent artifact producer mismatch');
  assert.equal(artifact.workflow_run?.repository_id, repositoryId);
  assert.equal(artifact.workflow_run?.head_repository_id, repositoryId);
  assert.equal(artifact.workflow_run?.head_branch, 'main');
  assert.equal(artifact.workflow_run?.head_sha, original.head_sha);
  const bytes = await io.download(artifact.id);
  assert.equal(bytes.length, artifact.size_in_bytes, 'Prepare intent artifact size mismatch');
  assert.equal(
    `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    artifact.digest,
    'Prepare intent artifact digest mismatch',
  );
  const scratch = mkdtempSync(path.join(tmpdir(), 'native-prepare-intent-'));
  try {
    const archive = path.join(scratch, 'intent.zip');
    writeFileSync(archive, bytes);
    const entries = readPortableArchiveEntries(archive, {
      maxArchiveBytes: MAX_INTENT_BYTES,
      maxEntries: 1,
      maxEntryBytes: MAX_INTENT_BYTES,
      maxExpandedBytes: MAX_INTENT_BYTES,
    });
    assert.equal(entries.size, 1, 'Prepare intent artifact must contain only intent.json');
    const entry = entries.get('intent.json');
    assert.equal(entry?.type, 'file', 'Prepare intent artifact must contain intent.json');
    return assertIntent(JSON.parse(entry.data().toString('utf8')));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// Intent routes an existing Prepare request. It never substitutes for Required
// or authorizes publication: the rerun repeats the original preparation gates.
export async function reconcileNativePrepare(event, io, readOptions = {}) {
  assert.equal(event.repository?.full_name, REPOSITORY, 'Continuation repository mismatch');
  assert.equal(event.action, 'completed', 'Continuation requires a completion event');
  const trigger = event.workflow_run;
  assert(sha(trigger?.head_sha), 'Continuation trigger source is invalid');
  const workflow = trigger.name === RELEASE.name ? RELEASE : NATIVE;
  assertRun(trigger, workflow, trigger.head_sha);
  assert.equal(trigger.status, 'completed');
  if (
    workflow === RELEASE &&
    (trigger.event !== 'workflow_dispatch' ||
      trigger.display_title !== 'Release / prepare-release-pr / main')
  )
    return [];
  const settings = githubReadOptionsFromEnv(
    {
      OLIPHAUNT_GITHUB_READ_DEADLINE_MS: '300000',
      OLIPHAUNT_GITHUB_READ_MAX_ATTEMPTS: '10',
      OLIPHAUNT_GITHUB_READ_BASE_DELAY_MS: '5000',
      OLIPHAUNT_GITHUB_READ_MAX_DELAY_MS: '30000',
      ...(readOptions.environment ?? process.env),
    },
    readOptions,
  );
  const now = settings.now ?? Date.now;
  const deadline = now() + Math.min(300_000, settings.deadlineMs);
  const remaining = () => {
    const milliseconds = deadline - now();
    assert(
      milliseconds > 0,
      'Prepare continuation metadata deadline exhausted; rerun original Prepare',
    );
    return milliseconds;
  };
  const reads = {
    read: (endpoint) => io.read(endpoint, { deadlineMs: remaining(), now, sleep: settings.sleep }),
    list: (endpoint, field) =>
      io.list(endpoint, field, { deadlineMs: remaining(), now, sleep: settings.sleep }),
    download: (id) => io.download(id, { timeoutMs: remaining() }),
  };
  const sourceSha = trigger.head_sha;
  const repository = await reads.read(API);
  assert.equal(repository.full_name, REPOSITORY);
  assert(positive(repository.id), 'Canonical repository ID is missing');
  const workflows = await reads.list(`${API}/actions/workflows`, 'workflows');
  const workflowId = (expected) => {
    const rows = workflows.filter(
      (row) => row.name === expected.name && row.path === expected.path,
    );
    assert.equal(rows.length, 1, `Expected one ${expected.name} workflow`);
    assert(positive(rows[0].id), 'Workflow ID is invalid');
    return rows[0].id;
  };
  const releaseId = workflowId(RELEASE),
    nativeId = workflowId(NATIVE);
  assert.equal(trigger.workflow_id, workflow === RELEASE ? releaseId : nativeId);
  const originals =
    workflow === RELEASE
      ? [trigger]
      : await reads.list(
          `${API}/actions/workflows/${releaseId}/runs?head_sha=${sourceSha}&event=workflow_dispatch`,
          'workflow_runs',
        );
  const resumed = [];
  for (const candidate of originals) {
    if (candidate.display_title !== 'Release / prepare-release-pr / main') continue;
    assert(positive(candidate.id), 'Prepare candidate run identity is invalid');
    if (candidate.status === 'completed')
      assert(positive(candidate.run_attempt), 'Completed Prepare candidate attempt is invalid');
    let originalAttempt = workflow === RELEASE ? trigger.run_attempt : undefined;
    let originalCompleted = workflow === RELEASE;
    let selectedNativeAttempt = workflow === NATIVE ? trigger.run_attempt : undefined;
    let nativeCompleted = workflow === NATIVE;
    let nativeEvent;
    let intent;
    let producer;
    let required;
    const readRun = async (id, expected) => {
      const run = await reads.read(`${API}/actions/runs/${id}`);
      assertRun(run, expected, sourceSha);
      assert.equal(run.id, id, 'Workflow run ID mismatch');
      assert.equal(run.workflow_id, expected === RELEASE ? releaseId : nativeId);
      if (expected === RELEASE) {
        assert.equal(run.event, 'workflow_dispatch');
        assert.equal(run.display_title, 'Release / prepare-release-pr / main');
      }
      return run;
    };
    const runId = await retryReadOperation(
      `Prepare run ${candidate.id} completion metadata; rerun original Prepare if readiness does not converge`,
      async () => {
        const original = await readRun(candidate.id, RELEASE);
        if (originalAttempt === undefined) {
          originalAttempt = Math.max(
            original.run_attempt,
            candidate.status === 'completed' ? candidate.run_attempt : 0,
          );
          originalCompleted =
            candidate.status === 'completed' && candidate.run_attempt === originalAttempt;
        }
        if (original.run_attempt > originalAttempt) return;
        if (
          workflow === RELEASE &&
          trigger.conclusion !== 'success' &&
          original.status !== 'completed'
        )
          return; // No need to await metadata for an unsuccessful request.
        if (original.run_attempt < originalAttempt)
          throw new PendingCompletionMetadata('Original Prepare attempt is not yet visible');
        if (original.status !== 'completed' && !originalCompleted) return;
        requireCompleted(original, 'Original Prepare');
        originalCompleted = true;
        if (workflow === RELEASE)
          assert.equal(
            original.conclusion,
            trigger.conclusion,
            'Completed Prepare result conflicts with its trigger',
          );
        if (original.conclusion !== 'success') return; // Never revive a failed/cancelled request.
        if (!intent) {
          const requestJobs = await reads.list(
            `${API}/actions/runs/${original.id}/attempts/${originalAttempt}/jobs`,
            'jobs',
          );
          producer = oneJob(requestJobs, REQUEST_JOB, originalAttempt, producer);
          requireCompleted(producer, REQUEST_JOB);
          assert.equal(producer.conclusion, 'success', 'Prepare intent producer did not succeed');
          const upload = producer.steps?.filter((step) => step.name === INTENT_UPLOAD_STEP) ?? [];
          assert(upload.length <= 1, 'Prepare intent upload step is ambiguous');
          if (!upload.length)
            throw new PendingCompletionMetadata('Prepare intent upload step is not yet visible');
          requireCompleted(upload[0], INTENT_UPLOAD_STEP);
          if (upload[0].conclusion === 'skipped') return;
          assert.equal(upload[0].conclusion, 'success', 'Prepare intent upload did not succeed');
          const artifacts = await reads.list(
            `${API}/actions/runs/${original.id}/artifacts`,
            'artifacts',
          );
          const matches = artifacts.filter(
            (row) => row.name === nativePrepareIntentName(originalAttempt),
          );
          assert(matches.length <= 1, 'Prepare intent artifact is ambiguous');
          if (!matches.length)
            throw new PendingCompletionMetadata(
              'Uploaded Prepare intent artifact is not yet visible',
            );
          const captured = await readIntentArtifact(matches[0], original, repository.id, reads);
          assert.equal(captured.originalRunId, original.id);
          assert.equal(captured.originalAttempt, originalAttempt);
          assert.equal(captured.sourceSha, sourceSha);
          const commit = await reads.read(`${API}/git/commits/${sourceSha}`);
          assert.equal(commit.sha, sourceSha);
          assert.equal(
            commit.tree?.sha,
            captured.sourceTree,
            'Prepare intent source tree mismatch',
          );
          intent = captured;
        }
        if (workflow === NATIVE && trigger.id !== intent.nativeRunId) return;
        const native = await readRun(intent.nativeRunId, NATIVE);
        nativeEvent ??= native.event;
        assert.equal(native.event, nativeEvent, 'Bound Native event changed');
        if (workflow === NATIVE)
          assert.equal(native.event, trigger.event, 'Native trigger event mismatch');
        selectedNativeAttempt ??= Math.max(native.run_attempt, intent.nativeAttempt);
        if (native.run_attempt > selectedNativeAttempt) return;
        if (
          workflow === NATIVE &&
          trigger.conclusion !== 'success' &&
          native.status !== 'completed'
        )
          assert.fail(`Bound Native qualification failed: ${trigger.html_url}`);
        if (native.run_attempt < selectedNativeAttempt)
          throw new PendingCompletionMetadata('Completed Native attempt is not yet visible');
        assert(
          native.run_attempt >= intent.nativeAttempt,
          `Bound Native attempt predates observed intent; rerun original Prepare https://github.com/${REPOSITORY}/actions/runs/${original.id} to select current proof`,
        );
        if (native.status !== 'completed' && !nativeCompleted) return;
        requireCompleted(native, 'Bound Native run');
        nativeCompleted = true;
        if (workflow === NATIVE)
          assert.equal(
            native.conclusion,
            trigger.conclusion,
            'Native completion result conflicts with its trigger',
          );
        assert.equal(
          native.conclusion,
          'success',
          `Bound Native qualification failed: ${native.html_url}`,
        );
        const nativeJobs = await reads.list(
          `${API}/actions/runs/${native.id}/attempts/${selectedNativeAttempt}/jobs`,
          'jobs',
        );
        required = oneJob(nativeJobs, 'Required', selectedNativeAttempt, required);
        requireCompleted(required, 'Required');
        assert(
          required.conclusion === 'success' ||
            (selectedNativeAttempt === intent.nativeAttempt &&
              native.event === 'push' &&
              required.conclusion === 'skipped'),
          'Bound Native run did not pass Required or finish as a successful scoped push',
        );
        const currentMain = await reads.read(`${API}/git/ref/heads/main`);
        assert.equal(
          currentMain.object?.sha,
          sourceSha,
          'Prepare source is no longer current main',
        );
        const latestNative = await readRun(native.id, NATIVE);
        assert.equal(latestNative.event, nativeEvent, 'Bound Native event changed');
        if (latestNative.run_attempt > selectedNativeAttempt) return;
        if (latestNative.run_attempt < selectedNativeAttempt)
          throw new PendingCompletionMetadata('Completed Native attempt is not yet visible');
        requireCompleted(latestNative, 'Bound Native run');
        assert.equal(latestNative.conclusion, 'success', 'Bound Native qualification changed');
        // Recheck after all reads under the controller's per-source concurrency lock.
        const latest = await readRun(original.id, RELEASE);
        if (latest.run_attempt > originalAttempt) return;
        if (latest.run_attempt < originalAttempt)
          throw new PendingCompletionMetadata('Original Prepare attempt is not yet visible');
        requireCompleted(latest, 'Original Prepare');
        assert.equal(latest.conclusion, 'success');
        return original.id;
      },
      {
        ...settings,
        deadlineMs: remaining(),
        classify: (error) => error instanceof PendingCompletionMetadata,
      },
    );
    if (runId === undefined) continue;
    await io.rerun(runId); // A mutation is never inside the metadata retry.
    resumed.push({
      runId,
      url: `https://github.com/${REPOSITORY}/actions/runs/${runId}`,
    });
  }
  return resumed;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, file] = process.argv.slice(2);
  if (command === 'record' && file) {
    const intent = recordNativePrepareIntent(process.env, {
      sha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      tree: execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim(),
    });
    writeFileSync(file, JSON.stringify(intent) + '\n');
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `artifact_name=${nativePrepareIntentName(intent.originalAttempt)}\n`,
    );
  } else if (command === 'resume' && file) {
    assert.equal(process.env.GITHUB_REPOSITORY, REPOSITORY);
    assert.equal(process.env.GITHUB_EVENT_NAME, 'workflow_run');
    assert.equal(
      process.env.GITHUB_WORKFLOW_REF,
      `${REPOSITORY}/.github/workflows/continue-release-prepare.yml@refs/heads/main`,
    );
    const resumed = await reconcileNativePrepare(
      JSON.parse(readFileSync(file, 'utf8')),
      githubIo(process.env),
    );
    const message = resumed.length
      ? resumed.map((run) => `Resumed original Prepare: ${run.url}`).join('\n')
      : 'No resumable Prepare request observed. If a pending request was missed, rerun original Prepare; indexed discovery has no automatic retry.';
    console.log(message);
    if (process.env.GITHUB_STEP_SUMMARY)
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, message + '\n');
  } else throw new Error('usage: native-prepare-continuation.mts record|resume <file>');
}
