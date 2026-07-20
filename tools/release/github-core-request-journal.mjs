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

export const GITHUB_CORE_REQUEST_ROLLING_WINDOW_MS = 60 * 60_000;
export const GITHUB_CORE_REQUEST_ROLLING_CEILING = 900;
export const GITHUB_CORE_REQUEST_RETRY_RESERVE = 100;

const SCHEMA = "oliphaunt-github-core-request-journal-v1";
const FULL_SHA = /^[0-9a-f]{40}$/u;
const POSITIVE_INTEGER = /^[1-9][0-9]*$/u;
const MAX_LOCK_WAIT_MS = 60_000;

export class GitHubCoreRequestJournalError extends Error {
  constructor(message, options = {}) {
    super(`github-core-request-journal: ${message}`, options);
    this.name = "GitHubCoreRequestJournalError";
  }
}

function fail(message, options = {}) {
  throw new GitHubCoreRequestJournalError(message, options);
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

function journalPath(environment) {
  const configured = environment.OLIPHAUNT_GITHUB_CORE_REQUEST_JOURNAL_PATH?.trim() ?? "";
  const required = environment.OLIPHAUNT_REQUIRE_GITHUB_CORE_REQUEST_JOURNAL ?? "false";
  if (required !== "true" && required !== "false") {
    fail("OLIPHAUNT_REQUIRE_GITHUB_CORE_REQUEST_JOURNAL must be true or false");
  }
  if (configured === "") {
    if (required === "true") {
      fail("OLIPHAUNT_GITHUB_CORE_REQUEST_JOURNAL_PATH is required for this release operation");
    }
    return null;
  }
  if (configured.includes("\0")) fail("journal path contains a NUL byte");
  return path.resolve(configured);
}

function assertRegularFile(file, label) {
  const stat = lstatSync(file, { throwIfNoEntry: false });
  if (stat !== undefined && (!stat.isFile() || stat.isSymbolicLink())) {
    fail(`${label} must be an absent or regular non-symbolic-link file`);
  }
}

function emptyState(expectedIdentity) {
  return {
    schema: SCHEMA,
    ...expectedIdentity,
    sequence: 0,
    attempts: [],
  };
}

function parseState(file, expectedIdentity) {
  if (!existsSync(file)) return emptyState(expectedIdentity);
  assertRegularFile(file, "core-request journal");
  let state;
  try {
    state = JSON.parse(readFileSync(file, "utf8"));
  } catch (cause) {
    fail("core-request journal is not valid JSON", { cause });
  }
  if (
    state === null
    || Array.isArray(state)
    || typeof state !== "object"
    || state.schema !== SCHEMA
    || !Number.isSafeInteger(state.sequence)
    || state.sequence < 0
    || !Array.isArray(state.attempts)
    || state.attempts.length !== state.sequence
  ) {
    fail("core-request journal has a malformed envelope");
  }
  for (const field of ["headSha", "repository", "runAttempt", "runId"]) {
    if (state[field] !== expectedIdentity[field]) {
      fail(`core-request journal ${field} does not match the current release run`);
    }
  }
  let previousAtMs = null;
  for (const [index, attempt] of state.attempts.entries()) {
    if (
      attempt === null
      || Array.isArray(attempt)
      || typeof attempt !== "object"
      || attempt.sequence !== index + 1
      || !Number.isSafeInteger(attempt.reservedAtMs)
      || attempt.reservedAtMs < 0
      || typeof attempt.label !== "string"
      || attempt.label.length === 0
      || attempt.label.length > 200
      || /[\u0000-\u001f\u007f]/u.test(attempt.label)
      || (previousAtMs !== null && attempt.reservedAtMs < previousAtMs)
    ) {
      fail("core-request journal contains a malformed attempt");
    }
    previousAtMs = attempt.reservedAtMs;
  }
  return state;
}

function writeState(file, state) {
  mkdirSync(path.dirname(file), { recursive: true });
  assertRegularFile(file, "core-request journal");
  const temporary = `${file}.tmp-${process.pid}-${state.sequence}`;
  assertRegularFile(temporary, "temporary core-request journal");
  try {
    writeFileSync(temporary, `${JSON.stringify(state)}\n`, { flag: "wx", mode: 0o600 });
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function acquireLock(file, { now, sleep }) {
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
      if (cause?.code !== "EEXIST") fail("could not acquire the core-request journal lock", { cause });
      if (now() - startedAt >= MAX_LOCK_WAIT_MS) fail("timed out waiting for the core-request journal lock");
      sleep(100);
    }
  }
}

function validateLabel(label) {
  if (
    typeof label !== "string"
    || label.length === 0
    || label.length > 200
    || /[\u0000-\u001f\u007f]/u.test(label)
  ) {
    fail("request label must be a non-empty printable string of at most 200 characters");
  }
}

function rollingAttempts(state, nowMs) {
  const boundary = nowMs - GITHUB_CORE_REQUEST_ROLLING_WINDOW_MS;
  return state.attempts.filter(({ reservedAtMs }) => reservedAtMs >= boundary);
}

export function readGitHubCoreRequestJournal({ environment = process.env, now = Date.now } = {}) {
  const file = journalPath(environment);
  if (file === null) return { enabled: false, rollingCount: 0, sequence: 0 };
  const nowMs = now();
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) fail("clock returned an invalid timestamp");
  const state = parseState(file, identity(environment));
  if (state.attempts.at(-1)?.reservedAtMs > nowMs) fail("clock moved backwards behind the request journal");
  return {
    enabled: true,
    rollingCount: rollingAttempts(state, nowMs).length,
    sequence: state.sequence,
  };
}

export function reserveGitHubCoreRequestSync({
  environment = process.env,
  label,
  now = Date.now,
  sleep = sleepSync,
} = {}) {
  validateLabel(label);
  const file = journalPath(environment);
  if (file === null) return { enabled: false, rollingCount: 0, sequence: 0 };
  const expectedIdentity = identity(environment);
  mkdirSync(path.dirname(file), { recursive: true });
  const lock = acquireLock(file, { now, sleep });
  try {
    const state = parseState(file, expectedIdentity);
    const reservedAtMs = now();
    if (!Number.isSafeInteger(reservedAtMs) || reservedAtMs < 0) fail("clock returned an invalid timestamp");
    if (state.attempts.at(-1)?.reservedAtMs > reservedAtMs) {
      fail("clock moved backwards behind the request journal");
    }
    const rollingCount = rollingAttempts(state, reservedAtMs).length;
    if (rollingCount >= GITHUB_CORE_REQUEST_ROLLING_CEILING) {
      fail(
        `refusing request ${JSON.stringify(label)} because ${rollingCount} attempts already occupy the `
          + `${GITHUB_CORE_REQUEST_ROLLING_WINDOW_MS / 60_000}-minute safety window`,
      );
    }
    const sequence = state.sequence + 1;
    const next = {
      ...state,
      sequence,
      attempts: [...state.attempts, { label, reservedAtMs, sequence }],
    };
    writeState(file, next);
    return { enabled: true, rollingCount: rollingCount + 1, sequence };
  } finally {
    rmSync(lock, { force: true });
  }
}

function main(argv) {
  if (argv[0] === "reserve" && argv.length === 3 && argv[1] === "--label") {
    const result = reserveGitHubCoreRequestSync({ label: argv[2] });
    if (!result.enabled) fail("the core-request journal is not enabled");
    console.log(`reserved GitHub core request ${result.sequence} (${result.rollingCount} in the safety window)`);
    return;
  }
  if (argv[0] === "status" && argv.length === 1) {
    const result = readGitHubCoreRequestJournal();
    if (!result.enabled) fail("the core-request journal is not enabled");
    console.log(JSON.stringify(result));
    return;
  }
  fail("usage: github-core-request-journal.mjs <reserve --label LABEL|status>");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (cause) {
    console.error(cause instanceof Error ? cause.message : String(cause));
    process.exit(1);
  }
}
