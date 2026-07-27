#!/usr/bin/env node

import { lstatSync, mkdirSync, openSync, closeSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import {
  GITHUB_CONTENT_WRITE_COLD_START_MS,
  GITHUB_CONTENT_WRITE_INTERVAL_MS,
} from "./github-content-write-pacer.mjs";
import { sha256Bytes, stableJson } from "./release-continuation-contract.mjs";

export const CONTINUATION_PACER_MEMBER = "oliphaunt-github-content-write-pacer.json";
export const CONTINUATION_CORE_JOURNAL_MEMBER = "oliphaunt-github-core-request-journal.json";

const PACER_SCHEMA = "oliphaunt-github-content-write-pacer-v2";
const JOURNAL_SCHEMA = "oliphaunt-github-core-request-journal-v2";
const FULL_SHA = /^[0-9a-f]{40}$/u;
const POSITIVE_INTEGER = /^[1-9][0-9]*$/u;
const PRINTABLE = /^[^\u0000-\u001f\u007f]+$/u;

export class GitHubReleaseContinuationStateError extends Error {
  constructor(message, options = {}) {
    super(`github-release-continuation-state: ${message}`, options);
    this.name = "GitHubReleaseContinuationStateError";
  }
}

function fail(message, options = {}) {
  throw new GitHubReleaseContinuationStateError(message, options);
}

function object(value, context) {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    fail(`${context} must be an object`);
  }
  return value;
}

function exactKeys(value, keys, context) {
  object(value, context);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (stableJson(actual) !== stableJson(expected)) {
    fail(`${context} keys must be exactly ${expected.join(", ")}`);
  }
}

function safeInteger(value, context, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    fail(`${context} must be a safe integer >= ${minimum}`);
  }
  return value;
}

function positiveInteger(value, context) {
  return safeInteger(value, context, 1);
}

function label(value, context) {
  if (typeof value !== "string" || value.length === 0 || value.length > 200 || !PRINTABLE.test(value)) {
    fail(`${context} must be a nonempty printable string of at most 200 characters`);
  }
  return value;
}

function normalizedLineage(value, context = "lineage") {
  exactKeys(value, ["headSha", "repository", "rootRunId"], context);
  if (typeof value.headSha !== "string" || !FULL_SHA.test(value.headSha)) {
    fail(`${context}.headSha must be a full lowercase commit SHA`);
  }
  if (typeof value.repository !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(value.repository)) {
    fail(`${context}.repository must be OWNER/NAME`);
  }
  const rootRunId = String(value.rootRunId ?? "");
  if (!POSITIVE_INTEGER.test(rootRunId) || !Number.isSafeInteger(Number(rootRunId))) {
    fail(`${context}.rootRunId must be a positive safe integer`);
  }
  return { headSha: value.headSha, repository: value.repository, rootRunId };
}

function assertLineage(state, expected, context) {
  for (const key of ["headSha", "repository", "rootRunId"]) {
    if (state[key] !== expected[key]) {
      fail(`${context}.${key} does not match the current release lineage`);
    }
  }
}

function source(value, context = "continuation source") {
  exactKeys(value, ["runAttempt", "runId"], context);
  return {
    runAttempt: positiveInteger(value.runAttempt, `${context}.runAttempt`),
    runId: positiveInteger(value.runId, `${context}.runId`),
  };
}

function continuationSource(value, context) {
  exactKeys(value, ["runAttempt", "runId", "sequence"], context);
  return {
    runAttempt: positiveInteger(value.runAttempt, `${context}.runAttempt`),
    runId: positiveInteger(value.runId, `${context}.runId`),
    sequence: positiveInteger(value.sequence, `${context}.sequence`),
  };
}

function normalizeAttempt(value, index, context, { allowSource }) {
  const hasSource = value !== null && typeof value === "object" && "continuationSource" in value;
  exactKeys(
    value,
    hasSource ? ["continuationSource", "label", "reservedAtMs", "sequence"] : ["label", "reservedAtMs", "sequence"],
    context,
  );
  if (hasSource && !allowSource) fail(`${context} must be a fresh pre-install attempt without lineage provenance`);
  const normalized = {
    label: label(value.label, `${context}.label`),
    reservedAtMs: safeInteger(value.reservedAtMs, `${context}.reservedAtMs`),
    sequence: positiveInteger(value.sequence, `${context}.sequence`),
  };
  if (normalized.sequence !== index + 1) fail(`${context}.sequence is not contiguous`);
  if (hasSource) normalized.continuationSource = continuationSource(value.continuationSource, `${context}.continuationSource`);
  return normalized;
}

function normalizeMerge(value, context) {
  exactKeys(
    value,
    ["attemptCount", "digest", "firstReservedAtMs", "lastReservedAtMs", "runAttempt", "runId"],
    context,
  );
  if (typeof value.digest !== "string" || !/^[0-9a-f]{64}$/u.test(value.digest)) {
    fail(`${context}.digest must be a lowercase SHA-256 digest`);
  }
  return {
    attemptCount: positiveInteger(value.attemptCount, `${context}.attemptCount`),
    digest: value.digest,
    firstReservedAtMs: safeInteger(value.firstReservedAtMs, `${context}.firstReservedAtMs`),
    lastReservedAtMs: safeInteger(value.lastReservedAtMs, `${context}.lastReservedAtMs`),
    runAttempt: positiveInteger(value.runAttempt, `${context}.runAttempt`),
    runId: positiveInteger(value.runId, `${context}.runId`),
  };
}

export function validateContinuationPacerState(value, expectedLineage) {
  const expected = normalizedLineage(expectedLineage);
  exactKeys(
    value,
    [
      "coldStartMs",
      "headSha",
      "intervalMs",
      "lastLabel",
      "lastReservedAtMs",
      "repository",
      "reservations",
      "rootRunId",
      "schema",
      "sequence",
    ],
    "pacer state",
  );
  if (value.schema !== PACER_SCHEMA) fail(`pacer state schema must be ${PACER_SCHEMA}`);
  assertLineage(value, expected, "pacer state");
  if (
    value.coldStartMs !== GITHUB_CONTENT_WRITE_COLD_START_MS
    || value.intervalMs !== GITHUB_CONTENT_WRITE_INTERVAL_MS
  ) {
    fail("pacer state weakens or changes the production pacing interval");
  }
  const sequence = positiveInteger(value.sequence, "pacer state.sequence");
  if (!Array.isArray(value.reservations) || value.reservations.length !== sequence) {
    fail("pacer state reservations do not match its sequence");
  }
  let previous = null;
  const reservations = value.reservations.map((entry, index) => {
    exactKeys(entry, ["label", "reservedAtMs", "sequence"], `pacer reservation ${index + 1}`);
    const normalized = {
      label: label(entry.label, `pacer reservation ${index + 1}.label`),
      reservedAtMs: safeInteger(entry.reservedAtMs, `pacer reservation ${index + 1}.reservedAtMs`),
      sequence: positiveInteger(entry.sequence, `pacer reservation ${index + 1}.sequence`),
    };
    if (normalized.sequence !== index + 1) fail("pacer reservation sequences are not contiguous");
    if (previous !== null && normalized.reservedAtMs < previous + value.intervalMs) {
      fail("pacer reservations are not separated by the production interval");
    }
    previous = normalized.reservedAtMs;
    return normalized;
  });
  const last = reservations.at(-1);
  if (value.lastReservedAtMs !== last.reservedAtMs || value.lastLabel !== last.label) {
    fail("pacer state summary does not match its reservation journal");
  }
  return {
    coldStartMs: value.coldStartMs,
    ...expected,
    intervalMs: value.intervalMs,
    lastLabel: value.lastLabel,
    lastReservedAtMs: value.lastReservedAtMs,
    reservations,
    schema: value.schema,
    sequence,
  };
}

function earlyJournalProjection(journal, mergeSource) {
  return {
    attempts: journal.attempts.map(({ label: attemptLabel, reservedAtMs }, index) => ({
      label: attemptLabel,
      reservedAtMs,
      sequence: index + 1,
    })),
    headSha: journal.headSha,
    repository: journal.repository,
    rootRunId: String(mergeSource.runId),
    schema: JOURNAL_SCHEMA,
    sequence: journal.attempts.length,
  };
}

function validateMergeProvenance(journal) {
  const keys = new Set();
  for (const [index, merge] of journal.lineageMerges.entries()) {
    const key = `${merge.runId}/${merge.runAttempt}`;
    if (keys.has(key)) fail(`core-request journal repeats continuation merge source ${key}`);
    keys.add(key);
    const projected = journal.attempts
      .filter(({ continuationSource: candidate }) =>
        candidate?.runId === merge.runId && candidate.runAttempt === merge.runAttempt)
      .sort((left, right) => left.continuationSource.sequence - right.continuationSource.sequence);
    if (
      projected.length !== merge.attemptCount
      || projected.some(({ continuationSource: candidate }, attemptIndex) => candidate.sequence !== attemptIndex + 1)
    ) {
      fail(`core-request journal merge ${index + 1} does not own one exact contiguous source attempt set`);
    }
    const reconstructed = earlyJournalProjection({
      attempts: projected,
      headSha: journal.headSha,
      repository: journal.repository,
    }, merge);
    if (
      sha256Bytes(stableJson(reconstructed)) !== merge.digest
      || reconstructed.attempts[0].reservedAtMs !== merge.firstReservedAtMs
      || reconstructed.attempts.at(-1).reservedAtMs !== merge.lastReservedAtMs
    ) {
      fail(`core-request journal merge ${index + 1} provenance digest does not match its attempts`);
    }
  }
}

export function validateContinuationCoreJournal(value, expectedLineage, { fresh = false } = {}) {
  const expected = normalizedLineage(expectedLineage);
  const hasMerges = value !== null && typeof value === "object" && "lineageMerges" in value;
  exactKeys(
    value,
    hasMerges
      ? ["attempts", "headSha", "lineageMerges", "repository", "rootRunId", "schema", "sequence"]
      : ["attempts", "headSha", "repository", "rootRunId", "schema", "sequence"],
    "core-request journal",
  );
  if (value.schema !== JOURNAL_SCHEMA) fail(`core-request journal schema must be ${JOURNAL_SCHEMA}`);
  assertLineage(value, expected, "core-request journal");
  const sequence = safeInteger(value.sequence, "core-request journal.sequence");
  if (!Array.isArray(value.attempts) || value.attempts.length !== sequence) {
    fail("core-request journal attempts do not match its sequence");
  }
  let previous = null;
  const attempts = value.attempts.map((entry, index) => {
    const normalized = normalizeAttempt(entry, index, `core-request attempt ${index + 1}`, {
      allowSource: !fresh,
    });
    if (previous !== null && normalized.reservedAtMs < previous) {
      fail("core-request journal attempts are not timestamp ordered");
    }
    previous = normalized.reservedAtMs;
    return normalized;
  });
  if (fresh && hasMerges) fail("fresh pre-install core-request journal must not contain lineage merges");
  if (hasMerges && !Array.isArray(value.lineageMerges)) {
    fail("core-request journal lineageMerges must be a list");
  }
  const lineageMerges = hasMerges
    ? value.lineageMerges.map((entry, index) => normalizeMerge(entry, `core-request merge ${index + 1}`))
    : [];
  const normalized = {
    attempts,
    ...expected,
    ...(lineageMerges.length > 0 ? { lineageMerges } : {}),
    schema: value.schema,
    sequence,
  };
  if (!fresh) validateMergeProvenance({ ...normalized, lineageMerges });
  return normalized;
}

function parseBytes(bytes, context) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) fail(`${context} must be nonempty exact bytes`);
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch (cause) {
    fail(`${context} is not strict JSON`, { cause });
  }
}

function stateIdentity(bytes, state) {
  return {
    digest: sha256Bytes(bytes),
    lastReservedAtMs: state.sequence === 0
      ? null
      : (state.lastReservedAtMs ?? state.attempts.at(-1).reservedAtMs),
    sequence: state.sequence,
    size: bytes.length,
  };
}

export function continuationStateIdentity(value, kind, expectedLineage) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(`${JSON.stringify(value)}\n`);
  const parsed = Buffer.isBuffer(value) ? parseBytes(value, `${kind} bytes`) : value;
  const state = kind === "pacer"
    ? validateContinuationPacerState(parsed, expectedLineage)
    : kind === "coreRequestJournal"
      ? validateContinuationCoreJournal(parsed, expectedLineage)
      : fail(`unsupported continuation GitHub state kind ${JSON.stringify(kind)}`);
  return stateIdentity(bytes, state);
}

export function continuationGitHubStateIdentity({ pacerBytes, journalBytes, lineage }) {
  const normalized = normalizedLineage(lineage);
  const pacer = validateContinuationPacerState(parseBytes(pacerBytes, "pacer bytes"), normalized);
  const journal = validateContinuationCoreJournal(parseBytes(journalBytes, "core-request journal bytes"), normalized);
  return {
    coreRequestJournal: stateIdentity(journalBytes, journal),
    headSha: normalized.headSha,
    pacer: stateIdentity(pacerBytes, pacer),
    repository: normalized.repository,
    rootRunId: Number(normalized.rootRunId),
  };
}

export function assertContinuationStatePrefix(originalValue, latestValue, kind, expectedLineage) {
  const original = kind === "pacer"
    ? validateContinuationPacerState(originalValue, expectedLineage)
    : validateContinuationCoreJournal(originalValue, expectedLineage);
  const latest = kind === "pacer"
    ? validateContinuationPacerState(latestValue, expectedLineage)
    : validateContinuationCoreJournal(latestValue, expectedLineage);
  const entries = kind === "pacer" ? "reservations" : "attempts";
  if (
    original.sequence > latest.sequence
    || stableJson(latest[entries].slice(0, original.sequence)) !== stableJson(original[entries])
  ) {
    fail(`latest ${kind} state does not retain the original GitHub-stage state as an exact prefix`);
  }
  if (kind === "coreRequestJournal") {
    const originalMerges = original.lineageMerges ?? [];
    const latestMerges = latest.lineageMerges ?? [];
    if (stableJson(latestMerges.slice(0, originalMerges.length)) !== stableJson(originalMerges)) {
      fail("latest coreRequestJournal state rewrites prior continuation merge provenance");
    }
  }
  return latest;
}

export function mergeContinuationCoreJournal({ carried, early, lineage, source: rawSource }) {
  const expected = normalizedLineage(lineage);
  const mergeSource = source(rawSource);
  const current = validateContinuationCoreJournal(carried, expected);
  const earlyLineage = { ...expected, rootRunId: String(mergeSource.runId) };
  const fresh = validateContinuationCoreJournal(early, earlyLineage, { fresh: true });
  if (fresh.sequence === 0) return current;
  const projection = earlyJournalProjection(fresh, mergeSource);
  const digest = sha256Bytes(stableJson(projection));
  const existing = (current.lineageMerges ?? []).find(({ runAttempt, runId }) =>
    runId === mergeSource.runId && runAttempt === mergeSource.runAttempt);
  if (existing !== undefined) {
    if (existing.digest !== digest || existing.attemptCount !== fresh.sequence) {
      fail("continuation core-request journal source was replayed with altered bytes");
    }
    return current;
  }
  const lastCarriedAt = current.attempts.at(-1)?.reservedAtMs ?? null;
  if (lastCarriedAt !== null && fresh.attempts[0].reservedAtMs < lastCarriedAt) {
    fail("fresh pre-install requests predate the carried lineage journal");
  }
  const attempts = [
    ...current.attempts,
    ...fresh.attempts.map(({ label: attemptLabel, reservedAtMs }, index) => ({
      continuationSource: {
        runAttempt: mergeSource.runAttempt,
        runId: mergeSource.runId,
        sequence: index + 1,
      },
      label: attemptLabel,
      reservedAtMs,
      sequence: current.sequence + index + 1,
    })),
  ];
  const merged = {
    attempts,
    ...expected,
    lineageMerges: [
      ...(current.lineageMerges ?? []),
      {
        attemptCount: fresh.sequence,
        digest,
        firstReservedAtMs: fresh.attempts[0].reservedAtMs,
        lastReservedAtMs: fresh.attempts.at(-1).reservedAtMs,
        runAttempt: mergeSource.runAttempt,
        runId: mergeSource.runId,
      },
    ],
    schema: JOURNAL_SCHEMA,
    sequence: attempts.length,
  };
  return validateContinuationCoreJournal(merged, expected);
}

function readInput(value, context) {
  if (Buffer.isBuffer(value)) return value;
  if (typeof value !== "string" || value.length === 0) fail(`${context} must be a path or Buffer`);
  const metadata = lstatSync(value, { throwIfNoEntry: false });
  if (metadata === undefined || !metadata.isFile() || metadata.isSymbolicLink()) {
    fail(`${context} must be a regular non-symlink file`);
  }
  return readFileSync(value);
}

export function atomicWriteContinuationState(file, bytes) {
  if (typeof file !== "string" || file.length === 0 || !Buffer.isBuffer(bytes)) {
    fail("atomic continuation state write requires a path and Buffer");
  }
  const absolute = path.resolve(file);
  mkdirSync(path.dirname(absolute), { recursive: true });
  const temporary = `${absolute}.tmp-${process.pid}-${Date.now()}`;
  let descriptor;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, bytes);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, absolute);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporary, { force: true });
  }
}

export function installContinuationGitHubState({
  destinationJournal,
  destinationPacer,
  earlyJournal,
  expectedLatestState = undefined,
  latestJournal = undefined,
  latestPacer = undefined,
  lineage,
  originalJournal,
  originalPacer,
  source: rawSource,
}) {
  const expected = normalizedLineage(lineage);
  const originalPacerBytes = readInput(originalPacer, "original stage pacer");
  const originalJournalBytes = readInput(originalJournal, "original stage core-request journal");
  const latestPacerBytes = latestPacer === undefined
    ? originalPacerBytes
    : readInput(latestPacer, "latest continuation pacer");
  const latestJournalBytes = latestJournal === undefined
    ? originalJournalBytes
    : readInput(latestJournal, "latest continuation core-request journal");
  const originalPacerState = validateContinuationPacerState(parseBytes(originalPacerBytes, "original stage pacer"), expected);
  const originalJournalState = validateContinuationCoreJournal(parseBytes(originalJournalBytes, "original stage journal"), expected);
  const latestPacerState = assertContinuationStatePrefix(
    originalPacerState,
    parseBytes(latestPacerBytes, "latest continuation pacer"),
    "pacer",
    expected,
  );
  const latestJournalState = assertContinuationStatePrefix(
    originalJournalState,
    parseBytes(latestJournalBytes, "latest continuation journal"),
    "coreRequestJournal",
    expected,
  );
  const observedLatest = continuationGitHubStateIdentity({
    journalBytes: latestJournalBytes,
    lineage: expected,
    pacerBytes: latestPacerBytes,
  });
  if (expectedLatestState !== undefined && stableJson(observedLatest) !== stableJson(expectedLatestState)) {
    fail("latest continuation GitHub state does not match its contract-bound identity");
  }
  const mergedJournal = mergeContinuationCoreJournal({
    carried: latestJournalState,
    early: parseBytes(readInput(earlyJournal, "fresh pre-install core-request journal"), "fresh pre-install journal"),
    lineage: expected,
    source: rawSource,
  });
  const mergedJournalBytes = Buffer.from(`${JSON.stringify(mergedJournal)}\n`);
  atomicWriteContinuationState(destinationPacer, latestPacerBytes);
  atomicWriteContinuationState(destinationJournal, mergedJournalBytes);
  return continuationGitHubStateIdentity({
    journalBytes: mergedJournalBytes,
    lineage: expected,
    pacerBytes: latestPacerBytes,
  });
}
