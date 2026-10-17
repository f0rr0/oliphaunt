import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readPortableArchiveEntries } from '../packaging/portable-archive.mts';
import {
  authHeaders,
  boundedResponseBytes,
  requestGithubDownload,
  requestGithubPages,
  requestGithubRepositoryJson,
} from './github-read.mts';

const REPOSITORY = 'f0rr0/oliphaunt';
const API = `repos/${REPOSITORY}`;
const RELEASE = { name: 'Release', path: '.github/workflows/release.yml' };
const NATIVE = { name: 'Native Bazel qualification', path: '.github/workflows/bazel.yml' };
const REQUEST_JOB = 'Resolve native qualification for preparation';
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

function oneJob(jobs, name, attempt) {
  const matches = jobs.filter((job) => job.name === name);
  assert.equal(matches.length, 1, `Expected one ${name} job`);
  assert.equal(matches[0].run_attempt, attempt, `${name} job attempt mismatch`);
  assert.equal(matches[0].status, 'completed', `${name} job is incomplete`);
  return matches[0];
}

function githubIo(environment) {
  return {
    read: (endpoint) => requestGithubRepositoryJson(endpoint, { environment }),
    list: (endpoint, itemsField) => requestGithubPages(endpoint, { environment, itemsField }),
    download: async (id) =>
      boundedResponseBytes(
        await requestGithubDownload(`https://api.github.com/${API}/actions/artifacts/${id}/zip`, {
          environment,
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
export async function reconcileNativePrepare(event, io) {
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
  const sourceSha = trigger.head_sha;
  const repository = await io.read(API);
  assert.equal(repository.full_name, REPOSITORY);
  assert(positive(repository.id), 'Canonical repository ID is missing');
  const workflows = await io.list(`${API}/actions/workflows`, 'workflows');
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
      : await io.list(
          `${API}/actions/workflows/${releaseId}/runs?head_sha=${sourceSha}&event=workflow_dispatch`,
          'workflow_runs',
        );
  const resumed = [];
  for (const candidate of originals) {
    if (candidate.display_title !== 'Release / prepare-release-pr / main') continue;
    const original = await io.read(`${API}/actions/runs/${candidate.id}`);
    assertRun(original, RELEASE, sourceSha);
    assert.equal(original.workflow_id, releaseId);
    assert.equal(original.event, 'workflow_dispatch');
    assert.equal(original.display_title, 'Release / prepare-release-pr / main');
    if (original.status !== 'completed') continue; // The Release completion event will reconcile later.
    if (original.conclusion !== 'success') continue; // Never revive a failed/cancelled request automatically.
    const artifacts = await io.list(`${API}/actions/runs/${original.id}/artifacts`, 'artifacts');
    const matches = artifacts.filter(
      (row) => row.name === nativePrepareIntentName(original.run_attempt),
    );
    if (matches.length === 0) continue; // No pending preparation intent in this attempt.
    assert.equal(matches.length, 1, 'Prepare intent artifact is ambiguous');
    const intent = await readIntentArtifact(matches[0], original, repository.id, io);
    assert.equal(intent.originalRunId, original.id);
    assert.equal(intent.originalAttempt, original.run_attempt);
    assert.equal(intent.sourceSha, sourceSha);
    const commit = await io.read(`${API}/git/commits/${sourceSha}`);
    assert.equal(commit.sha, sourceSha);
    assert.equal(commit.tree?.sha, intent.sourceTree, 'Prepare intent source tree mismatch');
    const requestJobs = await io.list(
      `${API}/actions/runs/${original.id}/attempts/${intent.originalAttempt}/jobs`,
      'jobs',
    );
    const producer = oneJob(requestJobs, REQUEST_JOB, intent.originalAttempt);
    assert.equal(producer.conclusion, 'success', 'Prepare intent producer did not succeed');
    const native = await io.read(`${API}/actions/runs/${intent.nativeRunId}`);
    assertRun(native, NATIVE, sourceSha);
    assert.equal(native.workflow_id, nativeId);
    // The retained attempt is the minimum observed for routing. A later
    // attempt needs its own current full gate on this same run and source.
    assert(
      native.run_attempt >= intent.nativeAttempt,
      `Bound Native attempt predates observed intent; rerun original Prepare https://github.com/${REPOSITORY}/actions/runs/${original.id} to select current proof`,
    );
    if (
      workflow === NATIVE &&
      (trigger.id !== native.id || trigger.run_attempt !== native.run_attempt)
    )
      continue;
    if (native.status !== 'completed') continue;
    assert.equal(
      native.conclusion,
      'success',
      `Bound Native qualification failed: ${native.html_url}`,
    );
    const nativeJobs = await io.list(
      `${API}/actions/runs/${native.id}/attempts/${native.run_attempt}/jobs`,
      'jobs',
    );
    const required = oneJob(nativeJobs, 'Required', native.run_attempt);
    // A successful scoped push only wakes the request stage, which dispatches
    // full Native next; it cannot supply the Prepare job's run_id output.
    assert(
      required.conclusion === 'success' ||
        (native.run_attempt === intent.nativeAttempt &&
          native.event === 'push' &&
          required.conclusion === 'skipped'),
      'Bound Native run did not pass Required or finish as a successful scoped push',
    );
    const currentMain = await io.read(`${API}/git/ref/heads/main`);
    assert.equal(currentMain.object?.sha, sourceSha, 'Prepare source is no longer current main');
    // Recheck after all reads under the controller's per-source concurrency lock.
    const latest = await io.read(`${API}/actions/runs/${original.id}`);
    assertRun(latest, RELEASE, sourceSha);
    if (latest.run_attempt > intent.originalAttempt) continue; // Another completion already resumed it.
    assert.equal(latest.run_attempt, intent.originalAttempt);
    if (latest.status !== 'completed') continue;
    assert.equal(latest.conclusion, 'success');
    await io.rerun(original.id);
    resumed.push({
      runId: original.id,
      url: `https://github.com/${REPOSITORY}/actions/runs/${original.id}`,
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
      : 'No completed pending Prepare request needs resuming.';
    console.log(message);
    if (process.env.GITHUB_STEP_SUMMARY)
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, message + '\n');
  } else throw new Error('usage: native-prepare-continuation.mts record|resume <file>');
}
