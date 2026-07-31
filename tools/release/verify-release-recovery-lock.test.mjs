#!/usr/bin/env bun

import assert from "node:assert/strict";
import test from "node:test";

import {
  RELEASE_RECOVERY_LOCK_EQUIVALENCE_SCHEMA,
  verifyReleaseRecoveryLockEquivalence,
} from "./verify-release-recovery-lock.mjs";

const RELEASE_COMMIT = "1".repeat(40);
const RELEASE_TREE = "2".repeat(40);
const PUBLICATION_COMMIT = "3".repeat(40);
const PUBLICATION_TREE = "4".repeat(40);

function lock(source, lockDigest) {
  return {
    schema: "oliphaunt-publication-lock-v1",
    catalogSchema: "oliphaunt-publication-catalog-v1",
    catalogDigest: "5".repeat(64),
    source,
    products: [{ id: "alpha", version: "0.1.0" }],
    carriers: [{
      id: "cargo:alpha",
      product: "alpha",
      version: "0.1.0",
      artifacts: [{ path: "alpha.crate", sha256: "6".repeat(64), size: 42 }],
    }],
    productArtifacts: [{
      product: "alpha",
      id: "github:alpha",
      path: "alpha.tar.gz",
      sha256: "7".repeat(64),
      size: 84,
    }],
    packageEnvelopeDigest: "8".repeat(64),
    lockDigest,
  };
}

function verify(original, recovery) {
  return verifyReleaseRecoveryLockEquivalence({
    original,
    replay: recovery,
    releaseSource: { commit: RELEASE_COMMIT, tree: RELEASE_TREE },
    controllerSource: { commit: PUBLICATION_COMMIT, tree: PUBLICATION_TREE },
    originalEvidence: {
      runId: 123,
      artifacts: [{
        digest: `sha256:${"b".repeat(64)}`,
        id: 456,
        name: "oliphaunt-publication-lock",
        size: 789,
      }],
    },
  });
}

test("accepts only an exact original-source lock replay under a distinct controller", () => {
  const original = lock(
    { commit: RELEASE_COMMIT, tree: RELEASE_TREE },
    "9".repeat(64),
  );
  const recovery = lock(
    { commit: RELEASE_COMMIT, tree: RELEASE_TREE },
    "9".repeat(64),
  );
  const receipt = verify(original, recovery);
  assert.equal(receipt.schema, RELEASE_RECOVERY_LOCK_EQUIVALENCE_SCHEMA);
  assert.equal(receipt.originalLockDigest, "9".repeat(64));
  assert.equal(receipt.replayLockDigest, "9".repeat(64));
  assert.equal(receipt.productCount, 1);
  assert.equal(receipt.carrierCount, 1);
  assert.equal(receipt.productArtifactCount, 1);
  assert.deepEqual(receipt.originalLockArtifact, {
    workflow: "Release",
    runId: 123,
    artifact: {
      digest: `sha256:${"b".repeat(64)}`,
      id: 456,
      name: "oliphaunt-publication-lock",
      size: 789,
    },
  });
  assert.deepEqual(
    receipt.comparedFields,
    [
      "carriers",
      "catalogDigest",
      "catalogSchema",
      "lockDigest",
      "packageEnvelopeDigest",
      "productArtifacts",
      "products",
      "schema",
      "source",
    ],
  );
  assert.match(receipt.evidenceDigest, /^[0-9a-f]{64}$/u);
});

test("rejects every changed lock field and mismatched source identity", () => {
  const original = lock(
    { commit: RELEASE_COMMIT, tree: RELEASE_TREE },
    "9".repeat(64),
  );
  for (const field of [
    "catalogSchema",
    "catalogDigest",
    "products",
    "carriers",
    "productArtifacts",
    "packageEnvelopeDigest",
  ]) {
    const recovery = lock(
      { commit: RELEASE_COMMIT, tree: RELEASE_TREE },
      "9".repeat(64),
    );
    recovery[field] = field.endsWith("Digest")
      ? "b".repeat(64)
      : field === "catalogSchema"
        ? "changed-schema"
        : [];
    assert.throws(
      () => verify(original, recovery),
      new RegExp(`changes ${field}`, "u"),
    );
  }

  const wrongSource = lock(
    { commit: "f".repeat(40), tree: PUBLICATION_TREE },
    "9".repeat(64),
  );
  assert.throws(
    () => verify(original, wrongSource),
    /replayed publication lock source/u,
  );

  const futureOriginal = structuredClone(original);
  const futureRecovery = lock(
    { commit: RELEASE_COMMIT, tree: RELEASE_TREE },
    "9".repeat(64),
  );
  futureOriginal.futureEnvelope = { digest: "c".repeat(64) };
  futureRecovery.futureEnvelope = { digest: "d".repeat(64) };
  assert.throws(
    () => verify(futureOriginal, futureRecovery),
    /changes futureEnvelope/u,
  );
});

test("rejects relabeling the original lock to the controller source", () => {
  const original = lock(
    { commit: RELEASE_COMMIT, tree: RELEASE_TREE },
    "9".repeat(64),
  );
  const recovery = lock(
    { commit: PUBLICATION_COMMIT, tree: PUBLICATION_TREE },
    "9".repeat(64),
  );
  assert.throws(
    () => verify(original, recovery),
    /replayed publication lock source/u,
  );
  assert.throws(
    () => verifyReleaseRecoveryLockEquivalence({
      original,
      replay: original,
      releaseSource: { commit: RELEASE_COMMIT, tree: RELEASE_TREE },
      controllerSource: { commit: RELEASE_COMMIT, tree: RELEASE_TREE },
      originalEvidence: {
        runId: 123,
        artifacts: [{
          digest: `sha256:${"b".repeat(64)}`,
          id: 456,
          name: "oliphaunt-publication-lock",
          size: 789,
        }],
      },
    }),
    /distinct commit and tree/u,
  );
});

test("binds one exact original lock run/artifact identity", () => {
  const original = lock(
    { commit: RELEASE_COMMIT, tree: RELEASE_TREE },
    "9".repeat(64),
  );
  const recovery = lock(
    { commit: RELEASE_COMMIT, tree: RELEASE_TREE },
    "9".repeat(64),
  );
  for (const originalEvidence of [
    undefined,
    { runId: 0, artifacts: [] },
    { runId: 123, artifacts: [] },
    {
      runId: 123,
      artifacts: [{
        digest: `sha256:${"b".repeat(64)}`,
        id: 456,
        name: "wrong",
        size: 789,
      }],
    },
  ]) {
    assert.throws(
      () => verifyReleaseRecoveryLockEquivalence({
        original,
        replay: recovery,
        releaseSource: { commit: RELEASE_COMMIT, tree: RELEASE_TREE },
        controllerSource: { commit: PUBLICATION_COMMIT, tree: PUBLICATION_TREE },
        originalEvidence,
      }),
      /original lock evidence/u,
    );
  }
});
