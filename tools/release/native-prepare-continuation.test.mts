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

const api = 'repos/f0rr0/oliphaunt';
const requestJob = (attempt, steps = []) => ({
  id: 701,
  name: 'Resolve native qualification for preparation',
  run_attempt: attempt,
  status: 'completed',
  conclusion: 'success',
  steps,
});
const pendingJob = (id, name, attempt) => ({
  id,
  name,
  run_attempt: attempt,
  status: 'in_progress',
  conclusion: null,
});

test('completed callbacks converge each expected API stage in either completion order', async () => {
  for (const which of ['release', 'native'])
    for (const stage of [
      'original-attempt',
      'original-status',
      'request-missing',
      'request-pending',
      'upload-missing',
      'upload-pending',
      'artifact-missing',
      'required-missing',
      'required-pending',
    ]) {
      const fixture = nativePrepareContinuationFixture('a'.repeat(40), 'b'.repeat(40), 88, 2, 2);
      const { state, io, event, readOptions } = fixture;
      const trigger = event(which);
      const original = `${api}/actions/runs/41`;
      const request = `${original}/attempts/2/jobs`;
      const required = `${api}/actions/runs/88/attempts/2/jobs`;
      const [endpoint, value] = {
        'original-attempt': [original, { ...state.original, run_attempt: 1 }],
        'original-status': [
          original,
          { ...state.original, status: 'in_progress', conclusion: null },
        ],
        'request-missing': [request, []],
        'request-pending': [
          request,
          [pendingJob(701, 'Resolve native qualification for preparation', 2)],
        ],
        'upload-missing': [request, [requestJob(2)]],
        'upload-pending': [
          request,
          [
            requestJob(2, [
              { name: 'Retain pending Prepare intent', status: 'in_progress', conclusion: null },
            ]),
          ],
        ],
        'artifact-missing': [`${original}/artifacts`, []],
        'required-missing': [required, []],
        'required-pending': [required, [pendingJob(702, 'Required', 2)]],
      }[stage];
      state.responses.set(endpoint, [value]);
      assert.equal(
        (await reconcileNativePrepare(trigger, io, readOptions))[0].runId,
        41,
        `${which}/${stage}`,
      );
      assert.equal(state.sleeps.length, 1, `${which}/${stage}`);
      assert.deepEqual(state.posts, [41]);
      assert.deepEqual(state.downloads, [501], 'authenticated intent is acquired once');
      assert(state.budgets.every((value) => value > 0 && value <= 300_000));
    }
});

test('Native completion catches up to its trigger attempt and status without changing selected proof', async () => {
  const { state, io, event, readOptions } = nativePrepareContinuationFixture(
    'a'.repeat(40),
    'b'.repeat(40),
    88,
    2,
  );
  const trigger = event();
  state.responses.set(`${api}/actions/runs/88`, [
    { ...state.native, run_attempt: 1 },
    { ...state.native, status: 'in_progress', conclusion: null },
  ]);
  assert.equal((await reconcileNativePrepare(trigger, io, readOptions))[0].runId, 41);
  assert.equal(state.sleeps.length, 2);
  assert.deepEqual(state.downloads, [501]);
  assert.deepEqual(state.posts, [41]);
});

test('Release completion catches up to the positively observed Native minimum without replacing it', async () => {
  const { state, io, event, readOptions } = nativePrepareContinuationFixture(
    'a'.repeat(40),
    'b'.repeat(40),
    88,
    2,
  );
  state.responses.set(`${api}/actions/runs/88`, [
    { ...state.native, run_attempt: 1, conclusion: 'failure' },
  ]);
  assert.equal((await reconcileNativePrepare(event('release'), io, readOptions))[0].runId, 41);
  assert.equal(state.sleeps.length, 1);
  assert.deepEqual(state.downloads, [501]);
});

test('same-attempt terminal API results must agree with either completed trigger', async () => {
  for (const which of ['release', 'native'])
    for (const conclusion of ['failure', 'cancelled']) {
      const { state, io, event, readOptions } = nativePrepareContinuationFixture();
      const trigger = event(which);
      trigger.workflow_run.conclusion = conclusion;
      await assert.rejects(
        reconcileNativePrepare(trigger, io, readOptions),
        /result conflicts with its trigger/u,
      );
      assert.deepEqual(state.sleeps, []);
      assert.deepEqual(state.posts, []);
    }
});

test('unknown indexed absence, skipped upload and genuinely running counterparts return without polling', async () => {
  for (const mode of ['unindexed', 'no-intent', 'release-running', 'native-running']) {
    const { state, io, event, readOptions } = nativePrepareContinuationFixture();
    const which = mode === 'native-running' ? 'release' : 'native';
    if (mode === 'unindexed') state.indexedOriginals = [];
    if (mode === 'no-intent') state.hasIntent = false;
    if (mode === 'release-running') state.original.status = 'in_progress';
    if (mode === 'native-running') state.native.status = 'in_progress';
    assert.deepEqual(await reconcileNativePrepare(event(which), io, readOptions), []);
    assert.deepEqual(state.sleeps, []);
    assert.deepEqual(state.posts, []);
    if (mode !== 'native-running') assert.deepEqual(state.downloads, []);
  }
});

test('expected intent and Required visibility exhaust visibly within the existing retry budget', async () => {
  for (const mode of ['intent', 'required']) {
    const { state, io, event, readOptions } = nativePrepareContinuationFixture();
    if (mode === 'intent') {
      state.hasIntent = false;
      state.upload = 'success';
    } else state.responses.set(`${api}/actions/runs/88/attempts/1/jobs`, Array(3).fill([]));
    await assert.rejects(
      reconcileNativePrepare(event(), io, { ...readOptions, maxAttempts: 3 }),
      /Prepare run 41.*retry budget exhausted after 3 attempt.*not yet visible/u,
    );
    assert.equal(state.sleeps.length, 2);
    assert.deepEqual(state.posts, []);
    assert.equal(state.downloads.length, mode === 'intent' ? 0 : 1);
  }
});

test('one five-minute deadline bounds nested reads despite a larger ambient setting', async () => {
  const { state, io, event, readOptions } = nativePrepareContinuationFixture();
  state.responses.set(`${api}/actions/runs/41`, [
    () => {
      state.now += 299_999;
      return { ...state.original, status: 'in_progress', conclusion: null };
    },
  ]);
  await assert.rejects(
    reconcileNativePrepare(event('release'), io, { ...readOptions, deadlineMs: 3_600_000 }),
    /overall deadline exhausted/u,
  );
  assert.deepEqual(state.posts, []);
  assert.deepEqual(state.sleeps, []);
  assert(state.budgets.every((value) => value > 0 && value <= 300_000));
  const shared = nativePrepareContinuationFixture();
  shared.state.responses.set(api, [
    () => {
      shared.state.now += 300_000;
      return shared.state.original.repository;
    },
  ]);
  await assert.rejects(
    reconcileNativePrepare(shared.event(), shared.io, shared.readOptions),
    /metadata deadline exhausted/u,
  );
  assert.equal(shared.state.requests.length, 1, 'discovery reads share the readiness deadline');
});

test('observed producer identities and terminal failures never become readiness retries', async () => {
  for (const mode of [
    'job-drift',
    'source-drift',
    'failure',
    'ambiguous',
    'wrong-attempt',
    'upload-failed',
    'artifact-ambiguous',
    'http404',
  ]) {
    const { state, io, event, readOptions } = nativePrepareContinuationFixture();
    const required = `${api}/actions/runs/88/attempts/1/jobs`;
    if (mode === 'job-drift')
      state.responses.set(required, [
        [pendingJob(702, 'Required', 1)],
        [{ ...pendingJob(703, 'Required', 1), status: 'completed', conclusion: 'success' }],
      ]);
    if (mode === 'source-drift') {
      state.responses.set(required, [[pendingJob(702, 'Required', 1)]]);
      state.responses.set(`${api}/actions/runs/88`, [
        state.native,
        { ...state.native, head_sha: 'f'.repeat(40) },
      ]);
    }
    if (mode === 'failure') state.required = 'failure';
    if (mode === 'ambiguous')
      state.responses.set(required, [
        [pendingJob(702, 'Required', 1), pendingJob(703, 'Required', 1)],
      ]);
    if (mode === 'wrong-attempt') state.requiredAttempt = 2;
    if (mode === 'upload-failed') state.upload = 'failure';
    if (mode === 'artifact-ambiguous')
      state.responses.set(`${api}/actions/runs/41/artifacts`, [
        [state.artifact, { ...state.artifact, id: 502 }],
      ]);
    if (mode === 'http404')
      state.responses.set(`${api}/actions/runs/88`, [new Error('GitHub API returned HTTP 404')]);
    await assert.rejects(
      reconcileNativePrepare(event(), io, readOptions),
      /permanent read failure/u,
    );
    assert.equal(state.sleeps.length, ['job-drift', 'source-drift'].includes(mode) ? 1 : 0, mode);
    assert.deepEqual(state.posts, []);
  }
});

test('a newer actual Native attempt supersedes the trigger or selected proof before any POST', async () => {
  for (const which of ['native', 'release']) {
    const { state, io, event, readOptions } = nativePrepareContinuationFixture();
    state.advanceNativeBeforePost = true;
    assert.deepEqual(await reconcileNativePrepare(event(which), io, readOptions), []);
    assert.deepEqual(state.posts, []);
    assert.deepEqual(state.sleeps, []);
  }
  const { state, io, event, readOptions } = nativePrepareContinuationFixture();
  const trigger = event();
  state.native.run_attempt = 2;
  assert.deepEqual(await reconcileNativePrepare(trigger, io, readOptions), []);
  assert.deepEqual(state.posts, []);
});

test('a Native attempt advancing during Required convergence is never substituted', async () => {
  for (const which of ['release', 'native']) {
    const { state, io, event, readOptions } = nativePrepareContinuationFixture();
    state.responses.set(`${api}/actions/runs/88`, [
      state.native,
      { ...state.native, run_attempt: 2 },
    ]);
    state.responses.set(`${api}/actions/runs/88/attempts/1/jobs`, [
      [pendingJob(702, 'Required', 1)],
    ]);
    assert.deepEqual(await reconcileNativePrepare(event(which), io, readOptions), []);
    assert.equal(state.sleeps.length, 1);
    assert.deepEqual(state.posts, []);
  }
});

test('metadata convergence never retries an ambiguous POST and preserves final source guards', async () => {
  for (const mode of ['post', 'original', 'main']) {
    const { state, io, event, readOptions } = nativePrepareContinuationFixture();
    state.responses.set(`${api}/actions/runs/88/attempts/1/jobs`, [
      [pendingJob(702, 'Required', 1)],
    ]);
    if (mode === 'post') state.ambiguous = true;
    if (mode === 'original')
      state.responses.set(`${api}/actions/runs/41`, [
        state.original,
        state.original,
        { ...state.original, run_attempt: 2 },
      ]);
    if (mode === 'main') state.currentMain = 'c'.repeat(40);
    if (mode === 'original')
      assert.deepEqual(await reconcileNativePrepare(event(), io, readOptions), []);
    else
      await assert.rejects(
        reconcileNativePrepare(event(), io, readOptions),
        mode === 'post' ? /outcome is unknown/u : /no longer current main/u,
      );
    assert.equal(state.sleeps.length, 1);
    assert.deepEqual(state.posts, mode === 'post' ? [41] : []);
    assert.deepEqual(state.downloads, [501]);
  }
});
