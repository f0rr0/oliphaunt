import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  reconcileNativePrepare,
  recordNativePrepareIntent,
} from './native-prepare-continuation.mts';
import { nativePrepareContinuationFixture } from './testdata/native-prepare-continuation-fixture.mts';

test('completion controller retains workflow_dispatch authority without idle waiting or publication credentials', () => {
  const workflow = Bun.YAML.parse(
    readFileSync(
      new URL('../../.github/workflows/continue-release-prepare.yml', import.meta.url),
      'utf8',
    ),
  );
  assert.deepEqual(workflow.on.workflow_run, {
    workflows: ['Native Bazel qualification', 'Release'],
    types: ['completed'],
  });
  assert.equal(
    workflow.concurrency.group,
    'prepare-continuation-${{ github.event.workflow_run.head_sha }}',
  );
  assert.equal(workflow.concurrency['cancel-in-progress'], false);
  const job = workflow.jobs['resume-prepare'];
  assert.deepEqual(job.permissions, { actions: 'write', contents: 'read' });
  assert.equal(job.environment, undefined);
  assert.equal(job.steps[0].with.ref, '${{ github.sha }}');
  assert.match(job.if, /github\.repository == 'f0rr0\/oliphaunt'/u);
  assert.match(job.if, /head_repository\.full_name == 'f0rr0\/oliphaunt'/u);
  assert.match(job.if, /head_branch == 'main'/u);
  assert.equal(job.steps.at(-1).env.GH_TOKEN, '${{ github.token }}');
  assert.equal(
    job.steps.at(-1).run,
    'bun tools/release/native-prepare-continuation.mts resume "$GITHUB_EVENT_PATH"',
  );
  assert.doesNotMatch(JSON.stringify(workflow), /secrets\.|release-mutation|sleep/u);
});

test('both completion orders resume the original exact-source request once', async () => {
  for (const first of ['native', 'release']) {
    const { state, io, event } = nativePrepareContinuationFixture();
    const second = first === 'native' ? 'release' : 'native';
    state[second === 'release' ? 'original' : 'native'].status = 'in_progress';
    assert.deepEqual(await reconcileNativePrepare(event(first), io), []);
    state[second === 'release' ? 'original' : 'native'].status = 'completed';
    const result = await reconcileNativePrepare(event(second), io);
    assert.deepEqual(result, [
      { runId: 41, url: 'https://github.com/f0rr0/oliphaunt/actions/runs/41' },
    ]);
    assert.deepEqual(state.posts, [41]);
    state.original.status = 'completed';
    assert.deepEqual(await reconcileNativePrepare(event('release'), io), []);
    assert.deepEqual(state.posts, [41]);
  }
});

test('successful scoped push wakes only the original request stage and dispatch never treats skipped Required as scoped', async () => {
  const { state, io, event } = nativePrepareContinuationFixture();
  state.native.event = 'push';
  state.required = 'skipped';
  assert.equal((await reconcileNativePrepare(event(), io))[0].runId, 41);
  const full = nativePrepareContinuationFixture();
  full.state.required = 'skipped';
  await assert.rejects(reconcileNativePrepare(full.event(), full.io), /did not pass Required/u);
  assert.deepEqual(full.state.posts, []);
});

test('retained bytes, producer, source tree, bound Native attempt and current main guard the rerun', async () => {
  const faults = [
    [
      (state) => {
        state.bytes = Buffer.from('changed artifact');
      },
      /artifact size mismatch/u,
    ],
    [
      (state) => {
        state.artifact.digest = `sha256:${'0'.repeat(64)}`;
      },
      /artifact digest mismatch/u,
    ],
    [
      (state) => {
        state.artifact.workflow_run.id = 42;
      },
      /artifact producer mismatch/u,
    ],
    [
      (state) => {
        state.producer = 'failure';
      },
      /producer did not succeed/u,
    ],
    [
      (state) => {
        state.sourceTree = 'c'.repeat(40);
      },
      /source tree mismatch/u,
    ],
    [
      (state) => {
        state.native.conclusion = 'failure';
      },
      /Bound Native qualification failed/u,
    ],
    [
      (state) => {
        state.currentMain = 'c'.repeat(40);
      },
      /no longer current main/u,
    ],
    [
      (state) => {
        state.native.head_repository = { full_name: 'attacker/fork' };
      },
      /source repository mismatch/u,
    ],
  ];
  for (const [fault, message] of faults) {
    const { state, io, event } = nativePrepareContinuationFixture();
    fault(state);
    await assert.rejects(reconcileNativePrepare(event('release'), io), message);
    assert.deepEqual(state.posts, []);
  }
});

test('a failed bound Native attempt can recover automatically through successful full proof on the same run', async () => {
  const { state, io, event } = nativePrepareContinuationFixture();
  state.native.conclusion = 'failure';
  await assert.rejects(reconcileNativePrepare(event(), io), /Bound Native qualification failed/u);
  assert.deepEqual(state.posts, []);
  state.native.run_attempt = 2;
  state.native.conclusion = 'success';
  assert.equal((await reconcileNativePrepare(event(), io))[0].runId, 41);
  assert.deepEqual(state.posts, [41]);
  assert.ok(state.requests.includes('repos/f0rr0/oliphaunt/actions/runs/88/attempts/2/jobs'));
  assert.equal(
    state.intent.nativeAttempt,
    1,
    'retained attempt 1 remains routing intent, never attempt 2 proof',
  );
});

test('recovery refuses stale completion, old Required jobs, skipped current Required, failure and an earlier attempt', async () => {
  const stale = nativePrepareContinuationFixture();
  const previousCompletion = stale.event();
  stale.state.native.run_attempt = 2;
  assert.deepEqual(await reconcileNativePrepare(previousCompletion, stale.io), []);
  assert.deepEqual(stale.state.posts, []);
  for (const mode of ['old-job', 'skipped', 'required-failed', 'failed', 'earlier']) {
    const fixture =
      mode === 'earlier'
        ? nativePrepareContinuationFixture('a'.repeat(40), 'b'.repeat(40), 88, 2)
        : nativePrepareContinuationFixture();
    const { state, io, event } = fixture;
    state.native.run_attempt = mode === 'earlier' ? 1 : 2;
    if (mode === 'old-job') state.requiredAttempt = 1;
    if (mode === 'skipped') {
      state.native.event = 'push';
      state.required = 'skipped';
    }
    if (mode === 'required-failed') state.required = 'failure';
    if (mode === 'failed') state.native.conclusion = 'failure';
    const message = {
      'old-job': /Required job attempt mismatch/u,
      skipped: /did not pass Required/u,
      'required-failed': /did not pass Required/u,
      failed: /Bound Native qualification failed/u,
      earlier: /predates observed intent/u,
    }[mode];
    await assert.rejects(reconcileNativePrepare(event(), io), message);
    assert.deepEqual(state.posts, []);
  }
});

test('an explicit rerun racing the final read wins, and an ambiguous mutation is never retried', async () => {
  const advanced = nativePrepareContinuationFixture();
  advanced.state.advanceBeforePost = true;
  assert.deepEqual(await reconcileNativePrepare(advanced.event(), advanced.io), []);
  assert.deepEqual(advanced.state.posts, []);
  const ambiguous = nativePrepareContinuationFixture();
  ambiguous.state.ambiguous = true;
  await assert.rejects(
    reconcileNativePrepare(ambiguous.event(), ambiguous.io),
    /outcome is unknown/u,
  );
  assert.deepEqual(ambiguous.state.posts, [41]);
});

test('ordinary releases without a pending intent and failed original requests never resume', async () => {
  for (const mode of ['no-intent', 'failed', 'publish']) {
    const { state, io, event } = nativePrepareContinuationFixture();
    if (mode === 'no-intent') state.hasIntent = false;
    if (mode === 'failed') state.original.conclusion = 'failure';
    if (mode === 'publish') state.original.display_title = 'Release / publish / main';
    assert.deepEqual(await reconcileNativePrepare(event('release'), io), []);
    assert.deepEqual(state.posts, []);
  }
});

test('intent records the actual source checkout and cannot route another release operation', () => {
  const { state } = nativePrepareContinuationFixture();
  assert.throws(
    () =>
      recordNativePrepareIntent(state.environment, { sha: 'c'.repeat(40), tree: state.sourceTree }),
    /actual checkout/u,
  );
  assert.throws(
    () =>
      recordNativePrepareIntent(
        { ...state.environment, RELEASE_OPERATION: 'publish' },
        { sha: state.intent.sourceSha, tree: state.sourceTree },
      ),
    /prepare-release-pr/u,
  );
});
