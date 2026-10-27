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
  originalAttempt = 1,
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
    run_attempt: originalAttempt,
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
    GITHUB_RUN_ATTEMPT: String(originalAttempt),
    RELEASE_OPERATION: 'prepare-release-pr',
    NATIVE_PENDING_RUN_ID: String(nativeRunId),
    NATIVE_PENDING_RUN_ATTEMPT: String(nativeAttempt),
  };
  const intent = recordNativePrepareIntent(environment, { sha: sourceSha, tree: sourceTree });
  const bytes = zipArchive([{ name: 'intent.json', data: JSON.stringify(intent) }]);
  const artifact = {
    id: 501,
    name: nativePrepareIntentName(originalAttempt),
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
    upload: undefined,
    indexedOriginals: undefined,
    responses: new Map<string, any[]>(),
    budgets: [],
    downloads: [],
    sleeps: [],
    now: 0,
    nativeReads: 0,
    advanceNativeBeforePost: false,
  };
  const prefix = 'repos/f0rr0/oliphaunt';
  const observe = (endpoint, value, options) => {
    state.requests.push(endpoint);
    state.budgets.push(options?.deadlineMs ?? options?.timeoutMs);
    const sequence = state.responses.get(endpoint);
    let result = sequence?.length ? sequence.shift() : value;
    if (typeof result === 'function') result = result();
    if (result instanceof Error) throw result;
    return structuredClone(result);
  };
  const io = {
    read: async (endpoint, options) => {
      if (endpoint === prefix) return observe(endpoint, repository, options);
      if (endpoint === `${prefix}/actions/runs/41`) {
        if (++state.originalReads === 2 && state.advanceBeforePost)
          state.original.run_attempt = originalAttempt + 1;
        return observe(endpoint, state.original, options);
      }
      if (endpoint === `${prefix}/actions/runs/${nativeRunId}`) {
        if (++state.nativeReads === 2 && state.advanceNativeBeforePost)
          state.native.run_attempt = nativeAttempt + 1;
        return observe(endpoint, state.native, options);
      }
      if (endpoint === `${prefix}/git/commits/${sourceSha}`)
        return observe(endpoint, { sha: sourceSha, tree: { sha: state.sourceTree } }, options);
      if (endpoint === `${prefix}/git/ref/heads/main`)
        return observe(endpoint, { object: { sha: state.currentMain } }, options);
      throw new Error(`Unexpected continuation read: ${endpoint}`);
    },
    list: async (endpoint, field, options) => {
      if (endpoint === `${prefix}/actions/workflows` && field === 'workflows')
        return observe(
          endpoint,
          [state.original, state.native].map((row) => ({
            id: row.workflow_id,
            name: row.name,
            path: row.path,
          })),
          options,
        );
      if (
        endpoint ===
          `${prefix}/actions/workflows/7/runs?head_sha=${sourceSha}&event=workflow_dispatch` &&
        field === 'workflow_runs'
      )
        return observe(endpoint, state.indexedOriginals ?? [state.original], options);
      if (endpoint === `${prefix}/actions/runs/41/artifacts` && field === 'artifacts')
        return observe(endpoint, state.hasIntent ? [state.artifact] : [], options);
      if (/\/actions\/runs\/41\/attempts\/[1-9][0-9]*\/jobs$/u.test(endpoint) && field === 'jobs')
        return observe(
          endpoint,
          [
            {
              id: 701,
              name: 'Resolve native qualification for preparation',
              run_attempt: Number(endpoint.split('/').at(-2)),
              status: 'completed',
              conclusion: state.producer,
              steps: [
                {
                  name: 'Retain pending Prepare intent',
                  status: 'completed',
                  conclusion:
                    state.upload ??
                    (state.hasIntent && endpoint.includes(`/attempts/${originalAttempt}/`)
                      ? 'success'
                      : 'skipped'),
                },
              ],
            },
          ],
          options,
        );
      if (
        endpoint ===
          `${prefix}/actions/runs/${nativeRunId}/attempts/${state.native.run_attempt}/jobs` &&
        field === 'jobs'
      )
        return observe(
          endpoint,
          [
            {
              id: 702,
              name: 'Required',
              run_attempt: state.requiredAttempt ?? state.native.run_attempt,
              status: 'completed',
              conclusion: state.required,
            },
          ],
          options,
        );
      throw new Error(`Unexpected continuation list: ${endpoint} (${field})`);
    },
    download: async (id, options) => {
      assert.equal(id, 501);
      state.downloads.push(id);
      state.budgets.push(options?.timeoutMs);
      return state.bytes;
    },
    rerun: async (id) => {
      assert.equal(id, 41);
      state.posts.push(id);
      if (state.ambiguous) throw new Error('Prepare rerun outcome is unknown');
      state.original.run_attempt = originalAttempt + 1;
      state.original.status = 'queued';
    },
  };
  const event = (which = 'native') => ({
    repository,
    action: 'completed',
    workflow_run: { ...(which === 'native' ? state.native : state.original) },
  });
  const readOptions = {
    environment: {},
    now: () => state.now,
    sleep: async (milliseconds) => {
      state.sleeps.push(milliseconds);
      state.now += milliseconds;
    },
    random: () => 0.5,
  };
  return { state, io, event, readOptions };
}
