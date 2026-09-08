#!/usr/bin/env node
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  githubResolverDependencies,
  resolveMobileE2e,
  runMobileE2eResolver,
} from './resolve-mobile-e2e.mts';
const SHA = 'a'.repeat(40);
const OTHER_SHA = 'b'.repeat(40);
const ANDROID_ARTIFACT = 'react-native-mobile-android-app-android-x86_64';
const IOS_ARTIFACT = 'react-native-mobile-ios-app';
function successfulRun(databaseId, headSha = SHA) {
  return { conclusion: 'success', databaseId, headSha, status: 'completed' };
}
function dependencies({
  sha = SHA,
  runs = [successfulRun(101)],
  gates = new Map([['101', true]]),
  artifacts = new Map([['101', new Set([ANDROID_ARTIFACT, IOS_ARTIFACT])]]),
} = {}) {
  const calls = { artifacts: [], gates: [], listRuns: [] };
  return {
    calls,
    checkoutSha: () => sha,
    listRuns(value) {
      calls.listRuns.push(value);
      return runs;
    },
    gateSucceeded(runId, gateJobName) {
      calls.gates.push([runId, gateJobName]);
      return gates.get(runId) ?? false;
    },
    artifactNames(runId) {
      calls.artifacts.push(runId);
      return artifacts.get(runId) ?? new Set();
    },
  };
}
function resolve(options = {}, injected = dependencies()) {
  return resolveMobileE2e(
    {
      repo: 'f0rr0/oliphaunt',
      requestedPlatform: 'all',
      requestedSha: SHA,
      ...options,
    },
    injected,
  );
}
test('resolves only an exact-SHA successful run with the successful aggregate build gate', async () => {
  const injected = dependencies({
    runs: [
      successfulRun(1, OTHER_SHA),
      { ...successfulRun(2), status: 'in_progress', conclusion: null },
      { ...successfulRun(3), conclusion: 'failure' },
      successfulRun(4),
      successfulRun(5),
      successfulRun(6),
    ],
    gates: new Map([
      ['4', false],
      ['5', true],
      ['6', true],
    ]),
    artifacts: new Map([
      ['5', new Set([ANDROID_ARTIFACT])],
      ['6', new Set([ANDROID_ARTIFACT, IOS_ARTIFACT])],
    ]),
  });
  assert.deepEqual(await resolve({}, injected), {
    android: true,
    ios: true,
    platformJobs: ['android', 'ios'],
    runId: '6',
    sha: SHA,
  });
  assert.deepEqual(injected.calls.listRuns, [SHA]);
  assert.deepEqual(injected.calls.gates, [
    ['4', 'Builds'],
    ['5', 'Builds'],
    ['6', 'Builds'],
  ]);
  assert.deepEqual(injected.calls.artifacts, ['5', '6']);
});
test('platform selection requires only the exact requested artifact identity', async () => {
  const androidOnly = dependencies({
    artifacts: new Map([['101', new Set([ANDROID_ARTIFACT, `${IOS_ARTIFACT}-near-match`])]]),
  });
  assert.deepEqual((await resolve({ requestedPlatform: 'android' }, androidOnly)).platformJobs, [
    'android',
  ]);
  const iosOnly = dependencies({
    artifacts: new Map([['101', new Set([IOS_ARTIFACT, `${ANDROID_ARTIFACT}-near-match`])]]),
  });
  assert.deepEqual((await resolve({ requestedPlatform: 'ios' }, iosOnly)).platformJobs, ['ios']);
  await assert.rejects(
    async () => await resolve({}, androidOnly),
    /contains requested mobile app artifacts/u,
  );
  await assert.rejects(
    async () => await resolve({}, iosOnly),
    /contains requested mobile app artifacts/u,
  );
});
test('rejects abbreviated, malformed, mismatched, or non-canonical checkout SHAs', async () => {
  for (const requestedSha of ['a'.repeat(39), `${'a'.repeat(40)}0`, 'not-a-sha']) {
    await assert.rejects(
      async () => await resolve({ requestedSha }, dependencies()),
      /input must be a full commit SHA/u,
    );
  }
  await assert.rejects(
    async () => await resolve({ requestedSha: OTHER_SHA }, dependencies()),
    /does not match requested SHA/u,
  );
  await assert.rejects(
    async () => await resolve({}, dependencies({ sha: SHA.toUpperCase() })),
    /checked-out mobile E2E commit is not a full SHA/u,
  );
  assert.equal((await resolve({ requestedSha: SHA.toUpperCase() })).sha, SHA);
});
test('fails closed on malformed successful-run metadata and artifact responses', async () => {
  await assert.rejects(
    async () => await resolve({}, dependencies({ runs: [successfulRun(undefined)] })),
    /invalid databaseId/u,
  );
  await assert.rejects(
    async () =>
      await resolve({}, dependencies({ runs: [{ ...successfulRun(1), headSha: 'abc' }] })),
    /missing a full lowercase headSha/u,
  );
  await assert.rejects(
    async () => await resolve({}, dependencies({ runs: {} })),
    /gh run list must return a JSON array/u,
  );
  await assert.rejects(
    async () =>
      await resolve({}, dependencies({ artifacts: new Map([['101', [ANDROID_ARTIFACT, null]]]) })),
    /invalid artifact name/u,
  );
});
test('deduplicates repeated attempts and preserves GitHub run ordering', async () => {
  const injected = dependencies({
    runs: [successfulRun(201), successfulRun(201), successfulRun(202)],
    gates: new Map([
      ['201', true],
      ['202', true],
    ]),
    artifacts: new Map([
      ['201', new Set([ANDROID_ARTIFACT])],
      ['202', new Set([ANDROID_ARTIFACT, IOS_ARTIFACT])],
    ]),
  });
  assert.equal((await resolve({}, injected)).runId, '202');
  assert.deepEqual(injected.calls.gates, [
    ['201', 'Builds'],
    ['202', 'Builds'],
  ]);
});
test('skips ambiguous duplicate gate and artifact identities', async () => {
  const duplicateArtifacts = dependencies({
    runs: [successfulRun(301), successfulRun(302)],
    gates: new Map([
      ['301', true],
      ['302', true],
    ]),
    artifacts: new Map([
      ['301', [ANDROID_ARTIFACT, ANDROID_ARTIFACT, IOS_ARTIFACT]],
      ['302', [ANDROID_ARTIFACT, IOS_ARTIFACT]],
    ]),
  });
  assert.equal((await resolve({}, duplicateArtifacts)).runId, '302');
});
test('environment entry point emits the complete exact resolver contract', async () => {
  const emitted = [];
  const result = await runMobileE2eResolver({
    environment: {
      BUILD_GATE_JOB: 'Builds',
      GH_REPO: 'f0rr0/oliphaunt',
      INPUT_PLATFORM: 'ios',
      INPUT_SHA: SHA,
    },
    dependencies: dependencies({ artifacts: new Map([['101', new Set([IOS_ARTIFACT])]]) }),
    writeOutput: (name, value) => emitted.push([name, value]),
  });
  assert.deepEqual(result.platformJobs, ['ios']);
  assert.deepEqual(emitted, [
    ['sha', SHA],
    ['run_id', '101'],
    ['android', 'false'],
    ['ios', 'true'],
    ['platform_jobs', '["ios"]'],
  ]);
});
test('HTTP adapter retries, paginates the latest jobs and live artifacts, and rejects duplicate build gates', async () => {
  const requests = [],
    delays = [];
  let attempts = 0;
  const adapter = githubResolverDependencies('f0rr0/oliphaunt', {
    environment: { CHECKOUT_SHA: SHA, GH_TOKEN: 'test-token' },
    retryOptions: {
      sleepImpl: async (delay) => delays.push(delay),
      fetchImpl: async (url, options) => {
        const request = new URL(url);
        assert.equal(request.origin, 'https://api.github.com');
        assert.equal(options.headers.Authorization, 'Bearer test-token');
        assert.equal(options.redirect, 'error');
        requests.push(request.pathname + request.search);
        if (request.pathname.endsWith('/workflows/ci.yml/runs')) {
          assert.equal(request.searchParams.get('head_sha'), SHA);
          if (++attempts === 1) return new Response('temporary', { status: 503 });
          return Response.json({
            workflow_runs: [901, 902].map((id) => ({
              id,
              head_sha: SHA,
              status: 'completed',
              conclusion: 'success',
            })),
          });
        }
        if (request.pathname.includes('/901/')) {
          assert.ok(request.pathname.endsWith('/jobs'));
          return Response.json({
            total_count: 2,
            jobs: [1, 2].map(() => ({ name: 'Builds', conclusion: 'success' })),
          });
        }
        assert.equal(request.searchParams.get('per_page'), '100');
        const page = Number(request.searchParams.get('page'));
        if (request.pathname.endsWith('/jobs')) {
          assert.equal(request.searchParams.get('filter'), 'latest');
          return Response.json({
            total_count: 101,
            jobs:
              page === 1
                ? Array.from({ length: 100 }, (_, index) => ({
                    name: 'job-' + index,
                    conclusion: 'success',
                  }))
                : [{ name: 'Builds', conclusion: 'success' }],
          });
        }
        assert.ok(request.pathname.endsWith('/902/artifacts'));
        return Response.json({
          total_count: 102,
          artifacts:
            page === 1
              ? Array.from({ length: 100 }, (_, index) => ({
                  name: 'expired-' + index,
                  expired: true,
                }))
              : [ANDROID_ARTIFACT, IOS_ARTIFACT].map((name) => ({ name, expired: false })),
        });
      },
    },
  });
  const result = await resolve({}, adapter);
  assert.equal(result.runId, '902');
  assert.deepEqual(result.platformJobs, ['android', 'ios']);
  assert.equal(attempts, 2);
  assert.deepEqual(delays, [250]);
  assert.equal(
    requests.some((request) => request.includes('/901/artifacts')),
    false,
  );
  assert.equal(requests.filter((request) => request.includes('/902/artifacts')).length, 2);
});
test('HTTP adapter fails closed on incomplete or changing pagination and malformed artifact identities', async () => {
  for (const [data, pattern] of [
    [{ total_count: 1, artifacts: [] }, /incomplete/],
    [{ total_count: 1, artifacts: [{ name: ANDROID_ARTIFACT }] }, /malformed artifact/],
    [{ total_count: 0, artifacts: [{ name: ANDROID_ARTIFACT, expired: false }] }, /incomplete/],
  ]) {
    const adapter = githubResolverDependencies('f0rr0/oliphaunt', {
      environment: { CHECKOUT_SHA: SHA },
      retryOptions: { fetchImpl: async () => Response.json(data) },
    });
    await assert.rejects(() => adapter.artifactNames('901'), pattern);
  }
  let calls = 0;
  const adapter = githubResolverDependencies('f0rr0/oliphaunt', {
    environment: { CHECKOUT_SHA: SHA },
    retryOptions: {
      fetchImpl: async () =>
        Response.json({
          total_count: ++calls === 1 ? 101 : 102,
          artifacts: Array.from({ length: 100 }, (_, index) => ({
            name: 'artifact-' + index,
            expired: true,
          })),
        }),
    },
  });
  await assert.rejects(() => adapter.artifactNames('901'), /changed during pagination/);
});
