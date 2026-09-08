#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import {
  GITHUB_CONTENT_WRITE_INTERVAL_MS,
  reserveGitHubContentWrite,
} from './github-content-write-pacer.mts';
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
  assert.deepEqual(state.reservations, [
    { label: 'first', reservedAtMs: 1_010_000, sequence: 1 },
    { label: 'second', reservedAtMs: 1_020_000, sequence: 2 },
  ]);
});

test('a malformed or identity-replaced durable journal fails closed', async (t) => {
  const f = fixture(t);
  await reserveGitHubContentWrite({
    environment: f.environment,
    label: 'first',
    now: f.now,
    sleep: f.sleep,
  });
  const file = f.environment.OLIPHAUNT_GITHUB_CONTENT_WRITE_PACER_PATH;
  const state = JSON.parse(readFileSync(file, 'utf8'));
  state.reservations[0].reservedAtMs += 1;
  writeFileSync(file, `${JSON.stringify(state)}\n`);
  await assert.rejects(
    async () =>
      await reserveGitHubContentWrite({
        environment: f.environment,
        label: 'second',
        now: f.now,
        sleep: f.sleep,
      }),
    /summary does not match.*journal/u,
  );
});

test('five concurrent product lanes serialize repeated shared pacer and core-request reservations without loss', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'oliphaunt-github-journal-processes-'));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  const pacer = path.join(root, 'pacer.json');
  const core = path.join(root, 'core.json');
  const worker = path.join(root, 'reserve-worker.mjs');
  writeFileSync(
    worker,
    `
import { reserveGitHubContentWrite } from ${JSON.stringify(pathToFileURL(path.resolve('tools/release/github-content-write-pacer.mts')).href)};
import { reserveGitHubCoreRequest } from ${JSON.stringify(pathToFileURL(path.resolve('tools/release/github-core-request-journal.mts')).href)};
for (let attempt = 0; attempt < 4; attempt += 1) {
  const label = \`asset-\${process.argv[2]}-\${attempt}\`;
  await reserveGitHubContentWrite({
    environment: process.env,
    label,
    timing: { intervalMs: 50, maxLockWaitMs: 2_000 },
  });
  await reserveGitHubCoreRequest({ environment: process.env, label });
}
`,
  );
  const environment = {
    ...process.env,
    GITHUB_ACTIONS: 'false',
    GITHUB_REPOSITORY: 'f0rr0/oliphaunt',
    GITHUB_RUN_ATTEMPT: '1',
    GITHUB_RUN_ID: '456',
    GITHUB_SHA: SHA,
    OLIPHAUNT_GITHUB_CONTENT_WRITE_PACER_PATH: pacer,
    OLIPHAUNT_GITHUB_CONTENT_WRITE_PACER_TEST_MODE: 'true',
    OLIPHAUNT_GITHUB_CORE_REQUEST_JOURNAL_PATH: core,
    OLIPHAUNT_REQUIRE_GITHUB_CORE_REQUEST_JOURNAL: 'true',
  };
  const seedReservedAtMs = Date.now() + 500;
  writeFileSync(
    pacer,
    `${JSON.stringify({
      schema: 'oliphaunt-github-content-write-pacer-v4',
      headSha: SHA,
      repository: 'f0rr0/oliphaunt',
      runId: '456',
      intervalMs: 50,
      sequence: 1,
      lastReservedAtMs: seedReservedAtMs,
      lastLabel: 'seed future slot',
      reservations: [
        {
          label: 'seed future slot',
          reservedAtMs: seedReservedAtMs,
          sequence: 1,
        },
      ],
    })}\n`,
  );
  const run = (index) =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [worker, String(index)], {
        env: environment,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stderr = '';
      child.stderr.on('data', (chunk) => {
        stderr += String(chunk);
      });
      child.once('error', reject);
      child.once('close', (code, signal) => {
        if (code === 0 && signal === null) resolve();
        else reject(new Error(`journal worker ${index} failed (${code}/${signal}): ${stderr}`));
      });
    });
  await Promise.all(Array.from({ length: 5 }, (_, index) => run(index)));
  const pacerState = JSON.parse(readFileSync(pacer, 'utf8'));
  const coreState = JSON.parse(readFileSync(core, 'utf8'));
  assert.equal(pacerState.sequence, 21);
  assert.equal(pacerState.reservations.length, 21);
  assert.deepEqual(
    pacerState.reservations.map(({ sequence }) => sequence),
    Array.from({ length: 21 }, (_, index) => index + 1),
  );
  const laneReservations = pacerState.reservations.slice(1);
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
  for (const [index, reservation] of pacerState.reservations.entries()) {
    if (index === 0) continue;
    assert.ok(reservation.reservedAtMs >= pacerState.reservations[index - 1].reservedAtMs + 50);
  }
  assert.equal(coreState.sequence, 20);
  assert.equal(coreState.attempts.length, 20);
  assert.deepEqual(
    new Set(coreState.attempts.map(({ label }) => label)),
    new Set(
      Array.from({ length: 5 }, (_, index) =>
        Array.from({ length: 4 }, (__, attempt) => `asset-${index}-${attempt}`),
      ).flat(),
    ),
  );
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
