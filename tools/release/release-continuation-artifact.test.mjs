import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  stableJson,
} from "./release-continuation-contract.mjs";

const SHA = "a".repeat(40);
const TREE = "b".repeat(40);
const DIGEST = "c".repeat(64);

function pointer() {
  const contract = createReleaseContinuationContract({
    approvedPublication: {
      runId: 20,
      artifacts: [
        { id: 1, name: "oliphaunt-publication-lock", size: 1, digest: `sha256:${DIGEST}` },
        { id: 2, name: "oliphaunt-bootstrap-capsule", size: 1, digest: `sha256:${DIGEST}` },
      ],
    },
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

test("bootstrap continuation envelope contains only its ledger, result, and contract", async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "oliphaunt-bootstrap-envelope-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const ledger = path.join(directory, "bootstrap-ledger");
  mkdirSync(ledger);
  const checkpointName = `checkpoint-000000-${DIGEST}.json`;
  const checkpointBytes = Buffer.from("exact checkpoint bytes\n");
  writeFileSync(path.join(ledger, checkpointName), checkpointBytes);
  const stateDigest = sha256Bytes(stableJson([{
    name: checkpointName,
    sha256: sha256Bytes(checkpointBytes),
    size: checkpointBytes.length,
  }]));
  const executionResult = {
    admittedIds: ["cargo:a"],
    completedIds: ["cargo:a"],
    decision: "deferred",
    deferralMode: "progress",
    lock: { catalogDigest: DIGEST, lockDigest: DIGEST, packageEnvelopeDigest: DIGEST },
    newlyCompletedIds: ["cargo:a"],
    notBeforeEpochSeconds: 1_800_000_000,
    operation: "publish-bootstrap",
    products: ["a"],
    remainingIds: ["cargo:b"],
    schema: "oliphaunt-bootstrap-execution-result-v1",
    source: { commit: SHA, tree: TREE },
  };
  const executionResultBytes = Buffer.from(`${JSON.stringify(executionResult, null, 2)}\n`);
  writeFileSync(path.join(directory, "bootstrap-execution-result.json"), executionResultBytes);
  const contract = createReleaseContinuationContract({
    approvedPublication: {
      runId: 20,
      artifacts: [
        { id: 1, name: "oliphaunt-publication-lock", size: 1, digest: `sha256:${DIGEST}` },
        { id: 2, name: "oliphaunt-bootstrap-capsule", size: 1, digest: `sha256:${DIGEST}` },
      ],
    },
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
    operation: "publish-bootstrap",
    outcome: {
      completedCount: 1,
      decision: "deferred",
      deferralMode: "progress",
      executionResultDigest: sha256Bytes(executionResultBytes),
      notBeforeEpochSeconds: 1_800_000_000,
      progressCount: 1,
      remainingCount: 1,
      stateDigest,
    },
    products: ["a"],
    source: { commit: SHA, tree: TREE },
    state: { digest: stateDigest, entryCount: 1, kind: "bootstrap-ledger" },
  });
  writeFileSync(
    path.join(directory, "release-continuation-contract.json"),
    `${JSON.stringify(contract, null, 2)}\n`,
  );
  const bytes = await createDeterministicZip(directory);
  const continuationPointer = createReleaseContinuationPointer({
    contract,
    artifact: {
      digest: `sha256:${sha256Bytes(bytes)}`,
      id: 10,
      name: "oliphaunt-bootstrap-ledger",
      size: bytes.length,
    },
  });

  const envelope = openContinuationEnvelope(bytes, continuationPointer);
  assert.equal(envelope.executionResult.deferralMode, "progress");
  assert.equal(envelope.checkpointEntries[0].bytes.toString("utf8"), "exact checkpoint bytes\n");
});
