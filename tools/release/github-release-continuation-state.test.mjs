import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  continuationGitHubStateIdentity,
  installContinuationGitHubState,
  validateContinuationCoreJournal,
} from "./github-release-continuation-state.mjs";

const SHA = "a".repeat(40);
const REPOSITORY = "f0rr0/oliphaunt";
const ROOT_RUN_ID = "100";
const ROOT_LINEAGE = { headSha: SHA, repository: REPOSITORY, rootRunId: ROOT_RUN_ID };

function bytes(value) {
  return Buffer.from(`${JSON.stringify(value)}\n`);
}

function pacer(rootRunId = ROOT_RUN_ID, reservations = [
  { label: "root stage", reservedAtMs: 10_000, sequence: 1 },
]) {
  return {
    schema: "oliphaunt-github-content-write-pacer-v2",
    headSha: SHA,
    repository: REPOSITORY,
    rootRunId: String(rootRunId),
    coldStartMs: 3_600_000,
    intervalMs: 10_000,
    sequence: reservations.length,
    lastReservedAtMs: reservations.at(-1).reservedAtMs,
    lastLabel: reservations.at(-1).label,
    reservations,
  };
}

function journal(rootRunId, labels, startAtMs) {
  return {
    schema: "oliphaunt-github-core-request-journal-v2",
    headSha: SHA,
    repository: REPOSITORY,
    rootRunId: String(rootRunId),
    sequence: labels.length,
    attempts: labels.map((label, index) => ({
      label,
      reservedAtMs: startAtMs + index * 100,
      sequence: index + 1,
    })),
  };
}

function write(file, value) {
  writeFileSync(file, Buffer.isBuffer(value) ? value : bytes(value));
}

test("root plus two child generations carry exact pacing state and merge every early request once", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "oliphaunt-continuation-github-state-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const originalPacer = path.join(root, "original-pacer.json");
  const originalJournal = path.join(root, "original-journal.json");
  const destinationPacer = path.join(root, "installed-pacer.json");
  const destinationJournal = path.join(root, "installed-journal.json");
  const childOneEarly = path.join(root, "child-one-early.json");
  const childTwoEarly = path.join(root, "child-two-early.json");
  write(originalPacer, pacer());
  write(originalJournal, journal(ROOT_RUN_ID, ["stage read 1", "stage read 2"], 10_000));
  write(childOneEarly, journal("200", ["child 1 inspect", "child 1 download"], 20_000));

  const first = installContinuationGitHubState({
    destinationJournal,
    destinationPacer,
    earlyJournal: childOneEarly,
    lineage: ROOT_LINEAGE,
    originalJournal,
    originalPacer,
    source: { runAttempt: 1, runId: 200 },
  });
  assert.equal(first.pacer.sequence, 1);
  assert.equal(first.coreRequestJournal.sequence, 4);
  let firstJournal = JSON.parse(readFileSync(destinationJournal, "utf8"));
  assert.deepEqual(
    firstJournal.attempts.slice(2).map(({ continuationSource }) => continuationSource),
    [
      { runAttempt: 1, runId: 200, sequence: 1 },
      { runAttempt: 1, runId: 200, sequence: 2 },
    ],
  );

  // Requests made after installation already use the root-lineage journal and
  // remain plain append-only entries. They must survive the next child too.
  firstJournal.attempts.push({ label: "child 1 registry verify", reservedAtMs: 21_000, sequence: 5 });
  firstJournal.sequence = 5;
  const childOneJournalBytes = bytes(firstJournal);
  const carriedPacer = pacer(ROOT_RUN_ID, [
    { label: "root stage", reservedAtMs: 10_000, sequence: 1 },
    { label: "conservative carried slot", reservedAtMs: 20_000, sequence: 2 },
  ]);
  const carriedPacerBytes = bytes(carriedPacer);
  const expectedFirst = continuationGitHubStateIdentity({
    journalBytes: childOneJournalBytes,
    lineage: ROOT_LINEAGE,
    pacerBytes: carriedPacerBytes,
  });
  write(childTwoEarly, journal("300", ["child 2 inspect"], 30_000));

  const second = installContinuationGitHubState({
    destinationJournal,
    destinationPacer,
    earlyJournal: childTwoEarly,
    expectedLatestState: expectedFirst,
    latestJournal: childOneJournalBytes,
    latestPacer: carriedPacerBytes,
    lineage: ROOT_LINEAGE,
    originalJournal,
    originalPacer,
    source: { runAttempt: 2, runId: 300 },
  });
  assert.equal(second.pacer.sequence, 2);
  assert.equal(second.coreRequestJournal.sequence, 6);
  const secondJournalBytes = readFileSync(destinationJournal);
  const secondJournal = JSON.parse(secondJournalBytes.toString("utf8"));
  assert.deepEqual(secondJournal.attempts.map(({ label }) => label), [
    "stage read 1",
    "stage read 2",
    "child 1 inspect",
    "child 1 download",
    "child 1 registry verify",
    "child 2 inspect",
  ]);
  assert.deepEqual(secondJournal.lineageMerges.map(({ runId, runAttempt }) => ({ runId, runAttempt })), [
    { runAttempt: 1, runId: 200 },
    { runAttempt: 2, runId: 300 },
  ]);

  const idempotent = installContinuationGitHubState({
    destinationJournal,
    destinationPacer,
    earlyJournal: childTwoEarly,
    expectedLatestState: second,
    latestJournal: secondJournalBytes,
    latestPacer: readFileSync(destinationPacer),
    lineage: ROOT_LINEAGE,
    originalJournal,
    originalPacer,
    source: { runAttempt: 2, runId: 300 },
  });
  assert.deepEqual(idempotent, second);
  assert.equal(JSON.parse(readFileSync(destinationJournal, "utf8")).sequence, 6);
});

test("contract identity, prefix, malformed provenance, and altered source replay fail closed", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "oliphaunt-continuation-github-tamper-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const originalPacer = path.join(root, "original-pacer.json");
  const originalJournal = path.join(root, "original-journal.json");
  const destinationPacer = path.join(root, "installed-pacer.json");
  const destinationJournal = path.join(root, "installed-journal.json");
  const early = path.join(root, "early.json");
  write(originalPacer, pacer());
  write(originalJournal, journal(ROOT_RUN_ID, ["stage"], 10_000));
  write(early, journal("200", ["inspect"], 20_000));
  const first = installContinuationGitHubState({
    destinationJournal,
    destinationPacer,
    earlyJournal: early,
    lineage: ROOT_LINEAGE,
    originalJournal,
    originalPacer,
    source: { runAttempt: 1, runId: 200 },
  });
  const carriedJournalBytes = readFileSync(destinationJournal);
  const carriedPacerBytes = readFileSync(destinationPacer);

  const tampered = JSON.parse(carriedJournalBytes.toString("utf8"));
  tampered.attempts[0].label = "rewritten root";
  assert.throws(
    () => installContinuationGitHubState({
      destinationJournal,
      destinationPacer,
      earlyJournal: early,
      expectedLatestState: first,
      latestJournal: bytes(tampered),
      latestPacer: carriedPacerBytes,
      lineage: ROOT_LINEAGE,
      originalJournal,
      originalPacer,
      source: { runAttempt: 1, runId: 200 },
    }),
    /exact prefix|contract-bound identity/u,
  );

  write(early, journal("200", ["altered replay"], 20_000));
  assert.throws(
    () => installContinuationGitHubState({
      destinationJournal,
      destinationPacer,
      earlyJournal: early,
      expectedLatestState: first,
      latestJournal: carriedJournalBytes,
      latestPacer: carriedPacerBytes,
      lineage: ROOT_LINEAGE,
      originalJournal,
      originalPacer,
      source: { runAttempt: 1, runId: 200 },
    }),
    /replayed with altered bytes/u,
  );

  const malformed = JSON.parse(carriedJournalBytes.toString("utf8"));
  malformed.attempts[1].continuationSource.sequence = 2;
  assert.throws(
    () => validateContinuationCoreJournal(malformed, ROOT_LINEAGE),
    /contiguous source attempt set|provenance digest/u,
  );
});
