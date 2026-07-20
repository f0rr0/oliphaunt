#!/usr/bin/env node

import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const GITHUB_CONTENT_WRITE_INTERVAL_MS = 10_000;
export const GITHUB_CONTENT_WRITE_COLD_START_MS = 60 * 60_000;
export const GITHUB_CONTENT_WRITES_PER_ROLLING_HOUR =
  Math.floor((60 * 60_000) / GITHUB_CONTENT_WRITE_INTERVAL_MS) + 1;
export const GITHUB_CONTENT_WRITES_PER_ROLLING_MINUTE =
  Math.floor(60_000 / GITHUB_CONTENT_WRITE_INTERVAL_MS) + 1;

const SCHEMA = "oliphaunt-github-content-write-pacer-v1";
const FULL_SHA = /^[0-9a-f]{40}$/u;
const POSITIVE_INTEGER = /^[1-9][0-9]*$/u;
const MAX_LOCK_WAIT_MS = 60_000;
const TEST_TIMING_ENV = "OLIPHAUNT_GITHUB_CONTENT_WRITE_PACER_TEST_MODE";

export class GitHubContentWritePacerError extends Error {
  constructor(message, options = {}) {
    super(`github-content-write-pacer: ${message}`, options);
    this.name = "GitHubContentWritePacerError";
  }
}

function fail(message, options = {}) {
  throw new GitHubContentWritePacerError(message, options);
}

function sleepSync(milliseconds) {
  if (milliseconds <= 0) return;
  const cell = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  Atomics.wait(cell, 0, 0, milliseconds);
}

function identity(environment) {
  const repository = environment.GITHUB_REPOSITORY?.trim() ?? "";
  const runId = environment.GITHUB_RUN_ID?.trim() ?? "";
  const runAttempt = environment.GITHUB_RUN_ATTEMPT?.trim() ?? "";
  const headSha = (environment.RELEASE_HEAD_SHA ?? environment.GITHUB_SHA ?? "").trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) {
    fail("GITHUB_REPOSITORY must be OWNER/NAME");
  }
  if (!POSITIVE_INTEGER.test(runId) || !POSITIVE_INTEGER.test(runAttempt)) {
    fail("GITHUB_RUN_ID and GITHUB_RUN_ATTEMPT must be positive integers");
  }
  if (!FULL_SHA.test(headSha)) {
    fail("RELEASE_HEAD_SHA or GITHUB_SHA must be a full lowercase commit SHA");
  }
  return { headSha, repository, runAttempt, runId };
}

function pacerPath(environment) {
  const configured = environment.OLIPHAUNT_GITHUB_CONTENT_WRITE_PACER_PATH?.trim() ?? "";
  if (configured === "") {
    if (environment.GITHUB_ACTIONS === "true") {
      fail("OLIPHAUNT_GITHUB_CONTENT_WRITE_PACER_PATH is required in GitHub Actions");
    }
    return null;
  }
  if (configured.includes("\0")) fail("pacer path contains a NUL byte");
  return path.resolve(configured);
}

function assertRegularFile(file, label) {
  const stat = lstatSync(file, { throwIfNoEntry: false });
  if (stat !== undefined && (!stat.isFile() || stat.isSymbolicLink())) {
    fail(`${label} must be an absent or regular non-symbolic-link file`);
  }
}

function parseState(file, expectedIdentity, timing) {
  if (!existsSync(file)) return null;
  assertRegularFile(file, "pacer state");
  let state;
  try {
    state = JSON.parse(readFileSync(file, "utf8"));
  } catch (cause) {
    fail("pacer state is not valid JSON", { cause });
  }
  if (
    state === null
    || Array.isArray(state)
    || typeof state !== "object"
    || state.schema !== SCHEMA
    || state.coldStartMs !== timing.coldStartMs
    || state.intervalMs !== timing.intervalMs
    || !Number.isSafeInteger(state.sequence)
    || state.sequence < 1
    || !Number.isSafeInteger(state.lastReservedAtMs)
    || state.lastReservedAtMs < 0
    || typeof state.lastLabel !== "string"
    || state.lastLabel.length === 0
    || /[\u0000-\u001f\u007f]/u.test(state.lastLabel)
    || !Array.isArray(state.reservations)
    || state.reservations.length !== state.sequence
  ) {
    fail("pacer state has a malformed envelope");
  }
  for (const field of ["headSha", "repository", "runAttempt", "runId"]) {
    if (state[field] !== expectedIdentity[field]) {
      fail(`pacer state ${field} does not match the current release run`);
    }
  }
  let previousReservedAtMs = null;
  for (const [index, reservation] of state.reservations.entries()) {
    if (
      reservation === null
      || Array.isArray(reservation)
      || typeof reservation !== "object"
      || reservation.sequence !== index + 1
      || !Number.isSafeInteger(reservation.reservedAtMs)
      || reservation.reservedAtMs < 0
      || typeof reservation.label !== "string"
      || reservation.label.length === 0
      || reservation.label.length > 200
      || /[\u0000-\u001f\u007f]/u.test(reservation.label)
      || (previousReservedAtMs !== null
        && reservation.reservedAtMs < previousReservedAtMs + timing.intervalMs)
    ) {
      fail("pacer state contains a malformed or insufficiently paced reservation journal");
    }
    previousReservedAtMs = reservation.reservedAtMs;
  }
  const last = state.reservations.at(-1);
  if (last.reservedAtMs !== state.lastReservedAtMs || last.label !== state.lastLabel) {
    fail("pacer state summary does not match its complete reservation journal");
  }
  return state;
}

function writeState(file, state) {
  const directory = path.dirname(file);
  mkdirSync(directory, { recursive: true });
  assertRegularFile(file, "pacer state");
  const temporary = `${file}.tmp-${process.pid}-${state.sequence}`;
  assertRegularFile(temporary, "temporary pacer state");
  try {
    writeFileSync(temporary, `${JSON.stringify(state)}\n`, { flag: "wx", mode: 0o600 });
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function acquireLock(file, { maxLockWaitMs, now, sleep }) {
  const lock = `${file}.lock`;
  const startedAt = now();
  while (true) {
    let descriptor;
    try {
      descriptor = openSync(lock, "wx", 0o600);
      writeFileSync(descriptor, `${process.pid}\n`);
      closeSync(descriptor);
      return lock;
    } catch (cause) {
      if (descriptor !== undefined) closeSync(descriptor);
      if (cause?.code !== "EEXIST") rmSync(lock, { force: true });
      if (cause?.code !== "EEXIST") fail("could not acquire the pacer lock", { cause });
      if (now() - startedAt >= maxLockWaitMs) fail("timed out waiting for the pacer lock");
      sleep(100);
    }
  }
}

function hardDeadlineMs(environment) {
  const value = environment.REGISTRY_JOB_HARD_DEADLINE_EPOCH;
  if (value === undefined || value === "") return null;
  if (!POSITIVE_INTEGER.test(value)) fail("REGISTRY_JOB_HARD_DEADLINE_EPOCH must be a positive Unix timestamp");
  const result = Number(value) * 1_000;
  if (!Number.isSafeInteger(result)) fail("REGISTRY_JOB_HARD_DEADLINE_EPOCH is outside the safe timestamp range");
  return result;
}

function coldWindowStartedAtMs(environment, observedAt) {
  const value = environment.OLIPHAUNT_GITHUB_CONTENT_WRITE_COLD_START_EPOCH;
  if (value === undefined || value === "") {
    if (environment.GITHUB_ACTIONS === "true") {
      fail("OLIPHAUNT_GITHUB_CONTENT_WRITE_COLD_START_EPOCH is required in GitHub Actions");
    }
    return observedAt;
  }
  if (!POSITIVE_INTEGER.test(value)) {
    fail("OLIPHAUNT_GITHUB_CONTENT_WRITE_COLD_START_EPOCH must be a positive Unix timestamp");
  }
  const result = Number(value) * 1_000;
  if (!Number.isSafeInteger(result) || result > observedAt) {
    fail("content-write cold-start epoch is outside the valid elapsed job window");
  }
  return result;
}

function timingOptions(environment, timing) {
  if (timing === undefined) {
    return {
      coldStartMs: GITHUB_CONTENT_WRITE_COLD_START_MS,
      intervalMs: GITHUB_CONTENT_WRITE_INTERVAL_MS,
      maxLockWaitMs: MAX_LOCK_WAIT_MS,
    };
  }
  if (environment.GITHUB_ACTIONS === "true" || environment[TEST_TIMING_ENV] !== "true") {
    fail(`custom timing is test-only and requires ${TEST_TIMING_ENV}=true outside GitHub Actions`);
  }
  if (timing === null || Array.isArray(timing) || typeof timing !== "object") {
    fail("custom timing must be an object");
  }
  const result = {
    coldStartMs: timing.coldStartMs,
    intervalMs: timing.intervalMs,
    maxLockWaitMs: timing.maxLockWaitMs,
  };
  if (!Number.isSafeInteger(result.coldStartMs) || result.coldStartMs < 0) {
    fail("custom cold-start timing must be a non-negative safe integer");
  }
  for (const [label, value] of Object.entries({
    "interval timing": result.intervalMs,
    "lock-wait timing": result.maxLockWaitMs,
  })) {
    if (!Number.isSafeInteger(value) || value < 1) fail(`custom ${label} must be a positive safe integer`);
  }
  return result;
}

export function reserveGitHubContentWriteSync({
  environment = process.env,
  label,
  now = Date.now,
  sleep = sleepSync,
  timing = undefined,
} = {}) {
  if (
    typeof label !== "string"
    || label.length === 0
    || label.length > 200
    || /[\u0000-\u001f\u007f]/u.test(label)
  ) {
    fail("reservation label must be a non-empty printable string of at most 200 characters");
  }
  const file = pacerPath(environment);
  if (file === null) return { enabled: false, sequence: 0, waitedMs: 0 };
  const resolvedTiming = timingOptions(environment, timing);
  const expectedIdentity = identity(environment);
  mkdirSync(path.dirname(file), { recursive: true });
  const lock = acquireLock(file, { maxLockWaitMs: resolvedTiming.maxLockWaitMs, now, sleep });
  try {
    const previous = parseState(file, expectedIdentity, resolvedTiming);
    const observedAt = now();
    if (!Number.isSafeInteger(observedAt) || observedAt < 0) fail("clock returned an invalid timestamp");
    if (previous !== null && observedAt < previous.lastReservedAtMs) {
      fail("clock moved backwards behind the last content-write reservation");
    }
    // A fresh runner cannot prove whether an interrupted predecessor consumed
    // secondary-rate-limit write slots without leaving remote state. Charge a
    // complete rolling-hour cooldown before its first write. Persisting the
    // reservation before the request makes every later process in this job
    // crash-conservative; a new runner starts the cooldown again.
    const earliest = previous === null
      ? coldWindowStartedAtMs(environment, observedAt) + resolvedTiming.coldStartMs
      : previous.lastReservedAtMs + resolvedTiming.intervalMs;
    const waitMs = Math.max(0, earliest - observedAt);
    const deadline = hardDeadlineMs(environment);
    if (deadline !== null && earliest >= deadline) {
      fail("the next content-write reservation would reach the hard release deadline");
    }
    sleep(waitMs);
    const reservedAt = now();
    if (!Number.isSafeInteger(reservedAt) || reservedAt < earliest) {
      fail("clock did not advance through the required content-write pacing interval");
    }
    if (deadline !== null && reservedAt >= deadline) {
      fail("the content-write reservation reached the hard release deadline while waiting");
    }
    const sequence = (previous?.sequence ?? 0) + 1;
    const reservation = { label, reservedAtMs: reservedAt, sequence };
    const state = {
      schema: SCHEMA,
      ...expectedIdentity,
      coldStartMs: resolvedTiming.coldStartMs,
      intervalMs: resolvedTiming.intervalMs,
      sequence,
      lastReservedAtMs: reservedAt,
      lastLabel: label,
      reservations: [...(previous?.reservations ?? []), reservation],
    };
    writeState(file, state);
    return { enabled: true, sequence: state.sequence, waitedMs: waitMs };
  } finally {
    rmSync(lock, { force: true });
  }
}

function main(argv) {
  if (argv[0] !== "reserve" || argv.length !== 3 || argv[1] !== "--label") {
    fail("usage: github-content-write-pacer.mjs reserve --label LABEL");
  }
  const result = reserveGitHubContentWriteSync({ label: argv[2] });
  if (!result.enabled) fail("the content-write pacer is not enabled");
  console.log(`reserved GitHub content write ${result.sequence} after ${result.waitedMs}ms`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (cause) {
    console.error(cause instanceof Error ? cause.message : String(cause));
    process.exit(1);
  }
}
