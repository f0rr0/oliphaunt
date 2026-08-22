#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import {
  GITHUB_CONTENT_WRITE_COLD_START_MS,
  GITHUB_CONTENT_WRITE_INTERVAL_MS,
  reserveGitHubContentWriteSync,
} from "./github-content-write-pacer.mjs";
import {
  runGitHubMutationSync,
} from "./github-release-mutations.mjs";

const SHA = "a".repeat(40);

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "oliphaunt-github-pacer-"));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  const environment = {
    GH_TOKEN: "test-token",
    GITHUB_ACTIONS: "true",
    GITHUB_REPOSITORY: "f0rr0/oliphaunt",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_RUN_ID: "123",
    GITHUB_SHA: SHA,
    OLIPHAUNT_GITHUB_CONTENT_WRITE_COLD_START_EPOCH: "1000",
    OLIPHAUNT_GITHUB_CONTENT_WRITE_PACER_PATH: path.join(root, "pacer.json"),
    OLIPHAUNT_GITHUB_CORE_REQUEST_JOURNAL_PATH: path.join(root, "core-requests.json"),
  };
  let nowMs = 1_010_000;
  const sleeps = [];
  return {
    environment,
    now: () => nowMs,
    setNow: (value) => { nowMs = value; },
    sleep: (milliseconds) => { sleeps.push(milliseconds); nowMs += milliseconds; },
    sleeps,
  };
}

test("a new runner waits out the remaining rolling hour and persists before each request slot", (t) => {
  const f = fixture(t);
  const first = reserveGitHubContentWriteSync({
    environment: f.environment,
    label: "first",
    now: f.now,
    sleep: f.sleep,
  });
  assert.equal(first.waitedMs, GITHUB_CONTENT_WRITE_COLD_START_MS - 10_000);
  assert.equal(first.sequence, 1);
  const second = reserveGitHubContentWriteSync({
    environment: f.environment,
    label: "second",
    now: f.now,
    sleep: f.sleep,
  });
  assert.equal(second.waitedMs, GITHUB_CONTENT_WRITE_INTERVAL_MS);
  assert.equal(second.sequence, 2);
  const state = JSON.parse(readFileSync(f.environment.OLIPHAUNT_GITHUB_CONTENT_WRITE_PACER_PATH, "utf8"));
  assert.equal(state.sequence, 2);
  assert.equal(state.lastLabel, "second");
  assert.deepEqual(state.reservations, [
    { label: "first", reservedAtMs: 4_600_000, sequence: 1 },
    { label: "second", reservedAtMs: 4_610_000, sequence: 2 },
  ]);
});

test("a malformed or identity-replaced durable journal fails closed", (t) => {
  const f = fixture(t);
  reserveGitHubContentWriteSync({
    environment: f.environment,
    label: "first",
    now: f.now,
    sleep: f.sleep,
  });
  const file = f.environment.OLIPHAUNT_GITHUB_CONTENT_WRITE_PACER_PATH;
  const state = JSON.parse(readFileSync(file, "utf8"));
  state.reservations[0].reservedAtMs += 1;
  writeFileSync(file, `${JSON.stringify(state)}\n`);
  assert.throws(
    () => reserveGitHubContentWriteSync({
      environment: f.environment,
      label: "second",
      now: f.now,
      sleep: f.sleep,
    }),
    /summary does not match.*journal/u,
  );
});

test("five concurrent product lanes serialize repeated shared pacer and core-request reservations without loss", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "oliphaunt-github-journal-processes-"));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  const pacer = path.join(root, "pacer.json");
  const core = path.join(root, "core.json");
  const worker = path.join(root, "reserve-worker.mjs");
  writeFileSync(worker, `
import { reserveGitHubContentWriteSync } from ${JSON.stringify(pathToFileURL(path.resolve("tools/release/github-content-write-pacer.mjs")).href)};
import { reserveGitHubCoreRequestSync } from ${JSON.stringify(pathToFileURL(path.resolve("tools/release/github-core-request-journal.mjs")).href)};
for (let attempt = 0; attempt < 4; attempt += 1) {
  const label = \`asset-\${process.argv[2]}-\${attempt}\`;
  reserveGitHubContentWriteSync({
    environment: process.env,
    label,
    timing: { coldStartMs: 0, intervalMs: 50, maxLockWaitMs: 2_000 },
  });
  reserveGitHubCoreRequestSync({ environment: process.env, label });
}
`);
  const environment = {
    ...process.env,
    GITHUB_ACTIONS: "false",
    GITHUB_REPOSITORY: "f0rr0/oliphaunt",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_RUN_ID: "456",
    GITHUB_SHA: SHA,
    OLIPHAUNT_GITHUB_CONTENT_WRITE_COLD_START_EPOCH: "1",
    OLIPHAUNT_GITHUB_CONTENT_WRITE_PACER_PATH: pacer,
    OLIPHAUNT_GITHUB_CONTENT_WRITE_PACER_TEST_MODE: "true",
    OLIPHAUNT_GITHUB_CORE_REQUEST_JOURNAL_PATH: core,
    OLIPHAUNT_REQUIRE_GITHUB_CORE_REQUEST_JOURNAL: "true",
  };
  const seedReservedAtMs = Date.now() + 500;
  writeFileSync(pacer, `${JSON.stringify({
    schema: "oliphaunt-github-content-write-pacer-v3",
    headSha: SHA,
    repository: "f0rr0/oliphaunt",
    runId: "456",
    coldStartMs: 0,
    intervalMs: 50,
    sequence: 1,
    lastReservedAtMs: seedReservedAtMs,
    lastLabel: "seed future slot",
    reservations: [{
      label: "seed future slot",
      reservedAtMs: seedReservedAtMs,
      sequence: 1,
    }],
  })}\n`);
  const run = (index) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [worker, String(index)], {
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0 && signal === null) resolve();
      else reject(new Error(`journal worker ${index} failed (${code}/${signal}): ${stderr}`));
    });
  });
  await Promise.all(Array.from({ length: 5 }, (_, index) => run(index)));
  const pacerState = JSON.parse(readFileSync(pacer, "utf8"));
  const coreState = JSON.parse(readFileSync(core, "utf8"));
  assert.equal(pacerState.sequence, 21);
  assert.equal(pacerState.reservations.length, 21);
  assert.deepEqual(pacerState.reservations.map(({ sequence }) => sequence),
    Array.from({ length: 21 }, (_, index) => index + 1));
  const laneReservations = pacerState.reservations.slice(1);
  assert.deepEqual(
    new Set(laneReservations.map(({ label }) => label)),
    new Set(Array.from(
      { length: 5 },
      (_, index) => Array.from({ length: 4 }, (__, attempt) => `asset-${index}-${attempt}`),
    ).flat()),
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
    assert.ok(
      reservation.reservedAtMs >= pacerState.reservations[index - 1].reservedAtMs + 50,
    );
  }
  assert.equal(coreState.sequence, 20);
  assert.equal(coreState.attempts.length, 20);
  assert.deepEqual(
    new Set(coreState.attempts.map(({ label }) => label)),
    new Set(Array.from(
      { length: 5 },
      (_, index) => Array.from({ length: 4 }, (__, attempt) => `asset-${index}-${attempt}`),
    ).flat()),
  );
});

test("GitHub Actions cannot weaken production pacer timing", (t) => {
  const f = fixture(t);
  assert.throws(
    () => reserveGitHubContentWriteSync({
      environment: { ...f.environment, OLIPHAUNT_GITHUB_CONTENT_WRITE_PACER_TEST_MODE: "true" },
      label: "forbidden-override",
      timing: { coldStartMs: 0, intervalMs: 1, maxLockWaitMs: 1 },
    }),
    /custom timing is test-only/u,
  );
});

test("cold-start pacing occurs outside a complete 60-second request timeout", (t) => {
  const f = fixture(t);
  let observedTimeout = 0;
  const output = runGitHubMutationSync(
    ["api", "repos/f0rr0/oliphaunt/git/refs", "-X", "POST", "--input", "-"],
    {
      environment: f.environment,
      input: `${JSON.stringify({ ref: "refs/tags/test-v1.0.0", sha: SHA })}\n`,
      pacerOptions: { now: f.now, sleep: f.sleep },
      spawn: (_command, _args, options) => {
        observedTimeout = options.timeout;
        return { status: 0, stdout: "{}", stderr: "" };
      },
      timeoutMs: 60_000,
    },
  );
  assert.equal(output, "{}");
  assert.equal(observedTimeout, 60_000);
  assert.equal(f.sleeps[0], GITHUB_CONTENT_WRITE_COLD_START_MS - 10_000);
});

test("pacing that crosses the absolute deadline issues no transport attempt", (t) => {
  const f = fixture(t);
  let spawnCalls = 0;
  assert.throws(
    () => runGitHubMutationSync(
      ["api", "repos/f0rr0/oliphaunt/git/refs", "-X", "POST", "--input", "-"],
      {
        deadlineMs: 4_659_999,
        environment: f.environment,
        input: `${JSON.stringify({ ref: "refs/tags/test-v1.0.0", sha: SHA })}\n`,
        now: f.now,
        pacerOptions: { now: f.now, sleep: f.sleep },
        spawn: () => {
          spawnCalls += 1;
          return { status: 0, stdout: "{}", stderr: "" };
        },
        timeoutMs: 60_000,
      },
    ),
    /requires its complete 60000ms transport timeout after pacing/u,
  );
  assert.equal(spawnCalls, 0);
});
