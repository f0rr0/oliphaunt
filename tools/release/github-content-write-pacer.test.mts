#!/usr/bin/env bun

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  GITHUB_CONTENT_WRITE_INTERVAL_MS,
  reserveGitHubContentWrite,
} from './github-content-write-pacer.mts';
import { reserveGitHubCoreRequest } from './github-core-request-journal.mts';
import { requestGithubMutation } from './github-release-mutations.mts';

const SHA = 'a'.repeat(40);

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'oliphaunt-github-pacer-'));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  const environment = {
    GH_TOKEN: 'test-token',
    GITHUB_ACTIONS: 'true',
    GITHUB_REPOSITORY: 'f0rr0/oliphaunt',
    GITHUB_RUN_ATTEMPT: '1',
    GITHUB_RUN_ID: '123',
    GITHUB_SHA: SHA,
    OLIPHAUNT_GITHUB_CONTENT_WRITE_PACER_PATH: path.join(root, 'pacer.json'),
    OLIPHAUNT_GITHUB_CORE_REQUEST_JOURNAL_PATH: path.join(root, 'core-requests.json'),
  };
  let nowMs = 1_010_000;
  const sleeps = [];
  return {
    environment,
    now: () => nowMs,
    setNow: (value) => {
      nowMs = value;
    },
    sleep: (milliseconds) => {
      sleeps.push(milliseconds);
      nowMs += milliseconds;
    },
    sleeps,
  };
}

const [mode, lane] = process.argv.slice(2);
if (mode === 'seed') {
  await reserveGitHubContentWrite({
    environment: process.env,
    label: 'seed future slot',
    timing: { intervalMs: 50, maxLockWaitMs: 2000 },
    now: () => Date.now() + 500,
    sleep: async () => {},
  });
  process.exit(0);
}
if (mode === 'worker') {
  for (let attempt = 0; attempt < 4; attempt++) {
    const label = `asset-${lane}-${attempt}`;
    const reservation = await reserveGitHubContentWrite({
      environment: process.env,
      label,
      timing: { intervalMs: 50, maxLockWaitMs: 2000 },
    });
    await reserveGitHubCoreRequest({ environment: process.env, label });
    console.log(JSON.stringify({ label, ...reservation }));
  }
  process.exit(0);
}
if (mode === 'assert') {
  const pacer = process.env.OLIPHAUNT_GITHUB_CONTENT_WRITE_PACER_PATH;
  const core = process.env.OLIPHAUNT_GITHUB_CORE_REQUEST_JOURNAL_PATH;
  const pacerState = JSON.parse(readFileSync(pacer, 'utf8'));
  const coreState = JSON.parse(readFileSync(core, 'utf8'));
  assert.equal(pacerState.sequence, 21);
  const laneReservations = Array.from({ length: 5 }, (_, lane) =>
    readFileSync(path.join(path.dirname(pacer), `${lane}.log`), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line)),
  )
    .flat()
    .sort((a, b) => a.sequence - b.sequence);
  assert.deepEqual(
    laneReservations.map(({ sequence }) => sequence),
    Array.from({ length: 20 }, (_, i) => i + 2),
  );
  assert.deepEqual(
    new Set(laneReservations.map(({ label }) => label)),
    new Set(
      Array.from({ length: 5 }, (_, index) =>
        Array.from({ length: 4 }, (__, attempt) => `asset-${index}-${attempt}`),
      ).flat(),
    ),
  );
  for (let index = 0; index < 5; index += 1) {
    assert.deepEqual(
      laneReservations
        .map(({ label }) => label)
        .filter((label) => label.startsWith(`asset-${index}-`)),
      Array.from({ length: 4 }, (_, attempt) => `asset-${index}-${attempt}`),
    );
  }
  for (let index = 1; index < laneReservations.length; index++) {
    assert.ok(
      laneReservations[index].reservedAtMs >= laneReservations[index - 1].reservedAtMs + 50,
    );
  }
  assert.equal(pacerState.lastReservedAtMs, laneReservations.at(-1).reservedAtMs);
  assert.equal(coreState.sequence, 20);
  assert.equal(coreState.attempts.length, 20);

  process.exit(0);
}

test('a new runner reserves immediately and persists each subsequent request slot', async (t) => {
  const f = fixture(t);
  const first = await reserveGitHubContentWrite({
    environment: f.environment,
    label: 'first',
    now: f.now,
    sleep: f.sleep,
  });
  assert.equal(first.waitedMs, 0);
  assert.equal(first.sequence, 1);
  const second = await reserveGitHubContentWrite({
    environment: f.environment,
    label: 'second',
    now: f.now,
    sleep: f.sleep,
  });
  assert.equal(second.waitedMs, GITHUB_CONTENT_WRITE_INTERVAL_MS);
  assert.equal(second.sequence, 2);
  const state = JSON.parse(
    readFileSync(f.environment.OLIPHAUNT_GITHUB_CONTENT_WRITE_PACER_PATH, 'utf8'),
  );
  assert.equal(state.sequence, 2);
  assert.equal(state.lastLabel, 'second');
  assert.equal(state.lastReservedAtMs, 1_020_000);
  assert.equal(state.reservations, undefined);
});

test('malformed or identity-replaced reservation state fails closed', async (t) => {
  const f = fixture(t);
  await reserveGitHubContentWrite({
    environment: f.environment,
    label: 'first',
    now: f.now,
    sleep: f.sleep,
  });
  const file = f.environment.OLIPHAUNT_GITHUB_CONTENT_WRITE_PACER_PATH;
  const valid = JSON.parse(readFileSync(file, 'utf8'));
  for (const change of [
    { lastReservedAtMs: -1 },
    { headSha: 'b'.repeat(40) },
    { sequence: Number.MAX_SAFE_INTEGER },
  ]) {
    writeFileSync(file, JSON.stringify({ ...valid, ...change }));
    const before = readFileSync(file, 'utf8');
    await assert.rejects(() =>
      reserveGitHubContentWrite({
        environment: f.environment,
        label: 'second',
        now: f.now,
        sleep: f.sleep,
      }),
    );
    assert.equal(readFileSync(file, 'utf8'), before);
  }
});

test('GitHub Actions cannot weaken production pacer timing', async (t) => {
  const f = fixture(t);
  await assert.rejects(
    async () =>
      await reserveGitHubContentWrite({
        environment: { ...f.environment, OLIPHAUNT_GITHUB_CONTENT_WRITE_PACER_TEST_MODE: 'true' },
        label: 'forbidden-override',
        timing: { intervalMs: 1, maxLockWaitMs: 1 },
      }),
    /custom timing is test-only/u,
  );
});

test('pacing occurs outside a complete 60-second request timeout', async (t) => {
  const f = fixture(t);
  await reserveGitHubContentWrite({
    environment: f.environment,
    label: 'first',
    now: f.now,
    sleep: f.sleep,
  });
  f.sleeps.length = 0;
  let observedSignal;
  const output = await requestGithubMutation('repos/f0rr0/oliphaunt/git/refs', {
    method: 'POST',
    environment: f.environment,
    input: `${JSON.stringify({ ref: 'refs/tags/test-v1.0.0', sha: SHA })}\n`,
    pacerOptions: { now: f.now, sleep: f.sleep },
    fetchImpl: (_url, options) => {
      observedSignal = options.signal;
      return new Response('{}');
    },
    timeoutMs: 60_000,
  });
  assert.equal(output, '{}');
  assert.ok(observedSignal instanceof AbortSignal);
  assert.equal(observedSignal.aborted, false);
  assert.equal(f.sleeps[0], GITHUB_CONTENT_WRITE_INTERVAL_MS);
});

test('pacing that crosses the absolute deadline issues no transport attempt', async (t) => {
  const f = fixture(t);
  await reserveGitHubContentWrite({
    environment: f.environment,
    label: 'first',
    now: f.now,
    sleep: f.sleep,
  });
  let spawnCalls = 0;
  await assert.rejects(
    async () =>
      await requestGithubMutation('repos/f0rr0/oliphaunt/git/refs', {
        method: 'POST',
        deadlineMs: 1_079_999,
        environment: f.environment,
        input: `${JSON.stringify({ ref: 'refs/tags/test-v1.0.0', sha: SHA })}\n`,
        now: f.now,
        pacerOptions: { now: f.now, sleep: f.sleep },
        fetchImpl: () => {
          spawnCalls += 1;
          return new Response('{}');
        },
        timeoutMs: 60_000,
      }),
    /requires its complete 60000ms transport timeout after pacing/u,
  );
  assert.equal(spawnCalls, 0);
});

test('pacing waits leave the event loop available to in-flight uploads', async (t) => {
  const f = fixture(t);
  const options = {
    environment: {
      ...f.environment,
      GITHUB_ACTIONS: 'false',
      OLIPHAUNT_GITHUB_CONTENT_WRITE_PACER_TEST_MODE: 'true',
    },
    timing: { intervalMs: 50, maxLockWaitMs: 1_000 },
  };
  await reserveGitHubContentWrite({ ...options, label: 'first' });
  let progressed = false;
  const timer = setTimeout(() => {
    progressed = true;
  }, 0);
  t.after(() => clearTimeout(timer));
  await reserveGitHubContentWrite({ ...options, label: 'second' });
  assert.equal(progressed, true);
});
