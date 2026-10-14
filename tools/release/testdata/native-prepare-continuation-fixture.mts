import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { zipArchive } from '../../packaging/testdata/zip-fixture.mts';
import {
  nativePrepareIntentName,
  recordNativePrepareIntent,
} from '../native-prepare-continuation.mts';

export function nativePrepareContinuationFixture(
  sourceSha = 'a'.repeat(40),
  sourceTree = 'b'.repeat(40),
  nativeRunId = 88,
  nativeAttempt = 1,
) {
  const repository = { full_name: 'f0rr0/oliphaunt', id: 123 };
  const original = {
    id: 41,
    workflow_id: 7,
    name: 'Release',
    path: '.github/workflows/release.yml',
    event: 'workflow_dispatch',
    display_title: 'Release / prepare-release-pr / main',
    head_sha: sourceSha,
    head_branch: 'main',
    repository,
    head_repository: repository,
    run_attempt: 1,
    status: 'completed',
    conclusion: 'success',
  };
  const native = {
    ...original,
    id: nativeRunId,
    workflow_id: 9,
    name: 'Native Bazel qualification',
    path: '.github/workflows/bazel.yml',
    display_title: 'Native / main',
    html_url: `https://github.com/f0rr0/oliphaunt/actions/runs/${nativeRunId}`,
    run_attempt: nativeAttempt,
  };
  const environment = {
    GITHUB_REPOSITORY: repository.full_name,
    GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_REF: 'refs/heads/main',
    GITHUB_WORKFLOW_REF: 'f0rr0/oliphaunt/.github/workflows/release.yml@refs/heads/main',
    GITHUB_SHA: sourceSha,
    GITHUB_RUN_ID: '41',
    GITHUB_RUN_ATTEMPT: '1',
    RELEASE_OPERATION: 'prepare-release-pr',
    NATIVE_PENDING_RUN_ID: String(nativeRunId),
    NATIVE_PENDING_RUN_ATTEMPT: String(nativeAttempt),
  };
  const intent = recordNativePrepareIntent(environment, { sha: sourceSha, tree: sourceTree });
  const bytes = zipArchive([{ name: 'intent.json', data: JSON.stringify(intent) }]);
  const artifact = {
    id: 501,
    name: nativePrepareIntentName(1),
    size_in_bytes: bytes.length,
    expired: false,
    digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    workflow_run: {
      id: original.id,
      repository_id: 123,
      head_repository_id: 123,
      head_sha: sourceSha,
      head_branch: 'main',
    },
  };
  const state = {
    original,
    native,
    intent,
    artifact,
    bytes,
    environment,
    sourceTree,
    currentMain: sourceSha,
    required: 'success',
    producer: 'success',
    hasIntent: true,
    requests: [],
    posts: [],
    originalReads: 0,
    advanceBeforePost: false,
    ambiguous: false,
    requiredAttempt: undefined,
  };
  const prefix = 'repos/f0rr0/oliphaunt';
  const io = {
    read: async (endpoint) => {
      state.requests.push(endpoint);
      if (endpoint === prefix) return repository;
      if (endpoint === `${prefix}/actions/runs/41`) {
        if (++state.originalReads === 2 && state.advanceBeforePost) state.original.run_attempt = 2;
        return { ...state.original };
      }
      if (endpoint === `${prefix}/actions/runs/${nativeRunId}`) return state.native;
      if (endpoint === `${prefix}/git/commits/${sourceSha}`)
        return { sha: sourceSha, tree: { sha: state.sourceTree } };
      if (endpoint === `${prefix}/git/ref/heads/main`)
        return { object: { sha: state.currentMain } };
      throw new Error(`Unexpected continuation read: ${endpoint}`);
    },
    list: async (endpoint, field) => {
      state.requests.push(endpoint);
      if (endpoint === `${prefix}/actions/workflows` && field === 'workflows')
        return [state.original, state.native].map((row) => ({
          id: row.workflow_id,
          name: row.name,
          path: row.path,
        }));
      if (
        endpoint ===
          `${prefix}/actions/workflows/7/runs?head_sha=${sourceSha}&event=workflow_dispatch` &&
        field === 'workflow_runs'
      )
        return [state.original];
      if (endpoint === `${prefix}/actions/runs/41/artifacts` && field === 'artifacts')
        return state.hasIntent ? [state.artifact] : [];
      if (endpoint === `${prefix}/actions/runs/41/attempts/1/jobs` && field === 'jobs')
        return [
          {
            name: 'Resolve native qualification for preparation',
            run_attempt: 1,
            status: 'completed',
            conclusion: state.producer,
          },
        ];
      if (
        endpoint ===
          `${prefix}/actions/runs/${nativeRunId}/attempts/${state.native.run_attempt}/jobs` &&
        field === 'jobs'
      )
        return [
          {
            name: 'Required',
            run_attempt: state.requiredAttempt ?? state.native.run_attempt,
            status: 'completed',
            conclusion: state.required,
          },
        ];
      throw new Error(`Unexpected continuation list: ${endpoint} (${field})`);
    },
    download: async (id) => {
      assert.equal(id, 501);
      return state.bytes;
    },
    rerun: async (id) => {
      assert.equal(id, 41);
      state.posts.push(id);
      if (state.ambiguous) throw new Error('Prepare rerun outcome is unknown');
      state.original.run_attempt = 2;
      state.original.status = 'queued';
    },
  };
  const event = (which = 'native') => ({
    repository,
    action: 'completed',
    workflow_run: { ...(which === 'native' ? state.native : state.original) },
  });
  return { state, io, event };
}
