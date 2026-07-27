import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createDeterministicZip } from "./archive_dir.mjs";
import {
  openContinuationEnvelope,
  openContinuationAuthorization,
  requireCompletedContinuationParent,
  selectContinuationAuthorizationArtifact,
  validateContinuationArtifactMetadata,
  validateContinuationRunLineage,
} from "../../.github/scripts/release-continuation-artifact.mjs";
import {
  continuationAuthorizationArtifactName,
  createReleaseContinuationAuthorization,
  serializeReleaseContinuationAuthorization,
} from "./release-continuation-authorization.mjs";
import {
  createReleaseContinuationContract,
  createReleaseContinuationPointer,
  sha256Bytes,
} from "./release-continuation-contract.mjs";

const SHA = "a".repeat(40);
const TREE = "b".repeat(40);
const DIGEST = "c".repeat(64);

function githubState({ journalDigest = DIGEST, journalSize = 100, pacerDigest = DIGEST, pacerSize = 100 } = {}) {
  return {
    coreRequestJournal: {
      digest: journalDigest,
      lastReservedAtMs: 900,
      sequence: 2,
      size: journalSize,
    },
    headSha: SHA,
    pacer: {
      digest: pacerDigest,
      lastReservedAtMs: 1_000,
      sequence: 1,
      size: pacerSize,
    },
    repository: "f0rr0/oliphaunt",
    rootRunId: 100,
  };
}

function pointer() {
  const contract = createReleaseContinuationContract({
    approvedPublication: {
      runId: 20,
      artifacts: [
        { id: 1, name: "oliphaunt-publication-lock", size: 1, digest: `sha256:${DIGEST}` },
        { id: 2, name: "oliphaunt-bootstrap-capsule", size: 1, digest: `sha256:${DIGEST}` },
      ],
    },
    githubState: null,
    lineage: {
      capacityDeferralAllowance: false,
      deadlineDeferralBudget: 1,
      deadlineDeferralsUsed: 0,
      generation: 1,
      maxGenerations: 3,
      parentRunAttempt: 2,
      parentRunId: 100,
      rateLimitDeferralBudget: 3,
      rateLimitDeferralsUsed: 0,
      rootRunId: 100,
    },
    lock: { lockDigest: DIGEST, catalogDigest: DIGEST, packageEnvelopeDigest: DIGEST },
    operation: "publish-bootstrap",
    outcome: {
      completedCount: 1,
      decision: "deferred",
      deferralMode: "progress",
      executionResultDigest: DIGEST,
      notBeforeEpochSeconds: 1_800_000_000,
      progressCount: 1,
      remainingCount: 2,
      stateDigest: DIGEST,
    },
    products: ["a"],
    source: { commit: SHA, tree: TREE },
    stageHandoff: null,
    state: { digest: DIGEST, entryCount: 1, kind: "bootstrap-ledger" },
  });
  return createReleaseContinuationPointer({
    contract,
    artifact: { id: 10, name: "oliphaunt-bootstrap-ledger", size: 100, digest: `sha256:${DIGEST}` },
  });
}

function run(id, workflow = 7, extra = {}) {
  return {
    id,
    workflow_id: workflow,
    head_sha: SHA,
    event: "workflow_dispatch",
    status: "completed",
    conclusion: "success",
    run_attempt: 2,
    ...extra,
  };
}

function renameZipMember(bytes, from, to) {
  const source = Buffer.from(from);
  const destination = Buffer.from(to);
  assert.equal(
    source.length,
    destination.length,
    "ZIP fixture member renames must preserve local and central record extents",
  );
  const renamed = Buffer.from(bytes);
  let cursor = 0;
  let replacements = 0;
  while (cursor < renamed.length) {
    const offset = renamed.indexOf(source, cursor);
    if (offset === -1) break;
    destination.copy(renamed, offset);
    replacements += 1;
    cursor = offset + destination.length;
  }
  assert.equal(
    replacements,
    2,
    "deterministic ZIP fixture must contain one local and one central member name",
  );
  return renamed;
}

async function authorizationZip(receiptBytes, { duplicate = false, extra = false } = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "oliphaunt-authorization-test-"));
  try {
    const authorizationName = "release-continuation-authorization.json";
    writeFileSync(path.join(directory, authorizationName), receiptBytes);
    let duplicateSourceName;
    if (duplicate) {
      duplicateSourceName = "another-continuation-authorization.json";
      writeFileSync(path.join(directory, duplicateSourceName), "{}\n");
    } else if (extra) {
      writeFileSync(path.join(directory, "unexpected.json"), "{}\n");
    }
    const archive = await createDeterministicZip(directory);
    return duplicateSourceName === undefined
      ? archive
      : renameZipMember(
        archive,
        duplicateSourceName,
        authorizationName,
      );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function authorizationArtifact(bytes) {
  return {
    digest: `sha256:${sha256Bytes(bytes)}`,
    id: 55,
    name: "release-continuation-authorization",
    size: bytes.length,
  };
}

async function normalContinuationZip(extraMembers = [], { tamperJournal = false, tamperPacer = false } = {}) {
  const checkpointBytes = Buffer.from("exact checkpoint bytes\n");
  const executionResult = {
    admittedIds: ["carrier:npm:a"],
    completedIds: ["carrier:npm:a"],
    decision: "deferred",
    deferralMode: "progress",
    lock: { catalogDigest: DIGEST, lockDigest: DIGEST, packageEnvelopeDigest: DIGEST },
    newlyCompletedIds: ["carrier:npm:a"],
    notBeforeEpochSeconds: 1_800_000_000,
    operation: "publish",
    products: ["a"],
    remainingIds: ["carrier:cargo:b"],
    schema: "oliphaunt-normal-publication-execution-result-v1",
    source: { commit: SHA, tree: TREE },
  };
  const executionResultBytes = Buffer.from(`${JSON.stringify(executionResult, null, 2)}\n`);
  const pacerBytes = Buffer.from(`${JSON.stringify({
    schema: "oliphaunt-github-content-write-pacer-v2",
    headSha: SHA,
    repository: "f0rr0/oliphaunt",
    rootRunId: "100",
    coldStartMs: 3_600_000,
    intervalMs: 10_000,
    sequence: 1,
    lastReservedAtMs: 1_000,
    lastLabel: "root stage",
    reservations: [{ label: "root stage", reservedAtMs: 1_000, sequence: 1 }],
  })}\n`);
  const journalBytes = Buffer.from(`${JSON.stringify({
    schema: "oliphaunt-github-core-request-journal-v2",
    headSha: SHA,
    repository: "f0rr0/oliphaunt",
    rootRunId: "100",
    sequence: 2,
    attempts: [
      { label: "read one", reservedAtMs: 800, sequence: 1 },
      { label: "read two", reservedAtMs: 900, sequence: 2 },
    ],
  })}\n`);
  const contract = createReleaseContinuationContract({
    approvedPublication: {
      runId: 20,
      artifacts: [
        { id: 1, name: "oliphaunt-publication-lock", size: 1, digest: `sha256:${DIGEST}` },
        { id: 2, name: "oliphaunt-bootstrap-capsule", size: 1, digest: `sha256:${DIGEST}` },
      ],
    },
    githubState: githubState({
      journalDigest: sha256Bytes(journalBytes),
      journalSize: journalBytes.length,
      pacerDigest: sha256Bytes(pacerBytes),
      pacerSize: pacerBytes.length,
    }),
    lineage: {
      capacityDeferralAllowance: false,
      deadlineDeferralBudget: 1,
      deadlineDeferralsUsed: 0,
      generation: 1,
      maxGenerations: 6,
      parentRunAttempt: 2,
      parentRunId: 100,
      rateLimitDeferralBudget: 3,
      rateLimitDeferralsUsed: 0,
      rootRunId: 100,
    },
    lock: { lockDigest: DIGEST, catalogDigest: DIGEST, packageEnvelopeDigest: DIGEST },
    operation: "publish",
    outcome: {
      completedCount: 1,
      decision: "deferred",
      deferralMode: "progress",
      executionResultDigest: sha256Bytes(executionResultBytes),
      notBeforeEpochSeconds: 1_800_000_000,
      progressCount: 1,
      remainingCount: 1,
      stateDigest: sha256Bytes(checkpointBytes),
    },
    products: ["a"],
    source: { commit: SHA, tree: TREE },
    stageHandoff: {
      artifact: {
        digest: `sha256:${DIGEST}`,
        id: 3,
        name: `github-stage-handoff-${SHA}-100-2`,
        size: 1,
      },
      runId: 100,
    },
    state: {
      digest: sha256Bytes(checkpointBytes),
      entryCount: 1,
      kind: "normal-publication-checkpoint",
    },
  });
  const directory = mkdtempSync(path.join(os.tmpdir(), "oliphaunt-normal-continuation-test-"));
  try {
    writeFileSync(path.join(directory, "normal-publication-checkpoint.json"), checkpointBytes);
    writeFileSync(path.join(directory, "normal-publication-execution-result.json"), executionResultBytes);
    const pacerMember = tamperPacer
      ? Buffer.from(pacerBytes.toString("utf8").replaceAll("root stage", "rewritten stage"))
      : pacerBytes;
    const journalMember = tamperJournal
      ? Buffer.from(journalBytes.toString("utf8").replace("read one", "rewritten read"))
      : journalBytes;
    writeFileSync(path.join(directory, "oliphaunt-github-content-write-pacer.json"), pacerMember);
    writeFileSync(path.join(directory, "oliphaunt-github-core-request-journal.json"), journalMember);
    writeFileSync(
      path.join(directory, "release-continuation-contract.json"),
      `${JSON.stringify(contract, null, 2)}\n`,
    );
    for (const member of extraMembers) writeFileSync(path.join(directory, member), "{}\n");
    const bytes = await createDeterministicZip(directory);
    const pointer = createReleaseContinuationPointer({
      contract,
      artifact: {
        digest: `sha256:${sha256Bytes(bytes)}`,
        id: 10,
        name: "normal-publication-continuation",
        size: bytes.length,
      },
    });
    return { bytes, pointer };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("artifact metadata and root/parent/current run lineage are exact", () => {
  const value = pointer();
  assert.equal(validateContinuationArtifactMetadata({
    id: 10,
    name: "oliphaunt-bootstrap-ledger",
    size_in_bytes: 100,
    digest: `sha256:${DIGEST}`,
    expired: false,
    workflow_run: { id: 100 },
  }, value).id, 10);
  assert.equal(validateContinuationRunLineage({
    parent: run(100),
    root: run(100),
    current: { id: 101, metadata: run(101) },
  }, value), 7);
});

test("lineage rejects failed parents, workflow substitution, and same-run consumption", () => {
  const value = pointer();
  assert.throws(
    () => validateContinuationRunLineage({
      parent: run(100, 7, { run_attempt: 1 }),
      root: run(100),
      current: { id: 101, metadata: run(101) },
    }, value),
    /attempt does not match/u,
  );
  assert.throws(
    () => validateContinuationRunLineage({
      parent: run(100, 7, { conclusion: "failure" }),
      root: run(100),
      current: { id: 101, metadata: run(101) },
    }, value),
    /successful completed/u,
  );
  assert.throws(
    () => validateContinuationRunLineage({
      parent: run(100),
      root: run(100),
      current: { id: 101, metadata: run(101, 8) },
    }, value),
    /different workflows/u,
  );
  assert.throws(
    () => validateContinuationRunLineage({
      parent: run(100),
      root: run(100),
      current: { id: 100, metadata: run(100) },
    }, value),
    /cannot consume its own/u,
  );
});

test("parent completion and authorization visibility fail closed while remaining retryable", () => {
  const value = pointer();
  assert.throws(
    () => requireCompletedContinuationParent(run(100, 7, {
      conclusion: null,
      status: "in_progress",
    }), value),
    /still running/u,
  );
  assert.throws(
    () => requireCompletedContinuationParent(run(100, 7, {
      conclusion: "failure",
    }), value),
    /completed without success/u,
  );
  assert.throws(
    () => selectContinuationAuthorizationArtifact({ artifacts: [], total_count: 0 }, value),
    /not visible yet/u,
  );
  const name = continuationAuthorizationArtifactName(value);
  assert.equal(selectContinuationAuthorizationArtifact({
    artifacts: [{
      digest: `sha256:${DIGEST}`,
      expired: false,
      id: 55,
      name,
      size_in_bytes: 123,
      workflow_run: { id: 100 },
    }],
    total_count: 1,
  }, value).id, 55);
});

test("authorization ZIP joins immutable transport, canonical receipt, pointer, and child identity", async () => {
  const value = pointer();
  const receipt = createReleaseContinuationAuthorization({
    childRunId: 101,
    pointer: value,
    repo: "f0rr0/oliphaunt",
  });
  const canonical = await authorizationZip(serializeReleaseContinuationAuthorization(receipt));
  assert.deepEqual(
    openContinuationAuthorization(canonical, authorizationArtifact(canonical), value, {
      currentRunId: 101,
      repo: "f0rr0/oliphaunt",
    }),
    receipt,
  );

  assert.throws(
    () => openContinuationAuthorization(canonical, authorizationArtifact(canonical), value, {
      currentRunId: 102,
      repo: "f0rr0/oliphaunt",
    }),
    /does not authorize this exact dispatched child run/u,
  );
  for (const options of [{ extra: true }, { duplicate: true }]) {
    const archive = await authorizationZip(
      serializeReleaseContinuationAuthorization(receipt),
      options,
    );
    assert.throws(
      () => openContinuationAuthorization(archive, authorizationArtifact(archive), value, {
        currentRunId: 101,
        repo: "f0rr0/oliphaunt",
      }),
      /must contain only release-continuation-authorization[.]json/u,
    );
  }

  const noncanonical = await authorizationZip(`${JSON.stringify(receipt, null, 2)}\n`);
  assert.throws(
    () => openContinuationAuthorization(noncanonical, authorizationArtifact(noncanonical), value, {
      currentRunId: 101,
      repo: "f0rr0/oliphaunt",
    }),
    /not canonical JSON/u,
  );
  assert.throws(
    () => openContinuationAuthorization(canonical, {
      ...authorizationArtifact(canonical),
      digest: `sha256:${"0".repeat(64)}`,
    }, value, { currentRunId: 101, repo: "f0rr0/oliphaunt" }),
    /does not match immutable GitHub metadata/u,
  );
  assert.throws(
    () => openContinuationAuthorization(canonical, {
      ...authorizationArtifact(canonical),
      size: canonical.length + 1,
    }, value, { currentRunId: 101, repo: "f0rr0/oliphaunt" }),
    /does not match immutable GitHub metadata/u,
  );
});

test("normal continuation envelope is exactly checkpoint, typed result, contract, and GitHub state", async () => {
  const exact = await normalContinuationZip();
  const envelope = openContinuationEnvelope(exact.bytes, exact.pointer);
  assert.equal(envelope.executionResult.deferralMode, "progress");
  assert.equal(envelope.stateBytes.toString("utf8"), "exact checkpoint bytes\n");
  assert.match(envelope.githubPacerBytes.toString("utf8"), /root stage/u);
  assert.match(envelope.githubCoreJournalBytes.toString("utf8"), /read one/u);

  for (const member of [
    "normal-publication-plan.json",
    "registry-integrity-receipts.json",
  ]) {
    const substituted = await normalContinuationZip([member]);
    assert.throws(
      () => openContinuationEnvelope(substituted.bytes, substituted.pointer),
      new RegExp(`unexpected member .*${member.replaceAll(".", "[.]")}`, "u"),
    );
  }
  for (const options of [{ tamperJournal: true }, { tamperPacer: true }]) {
    const substituted = await normalContinuationZip([], options);
    assert.throws(
      () => openContinuationEnvelope(substituted.bytes, substituted.pointer),
      /pacer\/journal bytes do not match the contract/u,
    );
  }
});
