import assert from "node:assert/strict";
import test from "node:test";

import {
  continuationAuthorizationArtifactName,
  createReleaseContinuationAuthorization,
  serializeReleaseContinuationAuthorization,
  validateReleaseContinuationAuthorization,
} from "./release-continuation-authorization.mjs";
import {
  createReleaseContinuationContract,
  createReleaseContinuationPointer,
} from "./release-continuation-contract.mjs";

const SHA = "a".repeat(40);
const TREE = "b".repeat(40);
const DIGEST = "c".repeat(64);

function pointer() {
  const contract = createReleaseContinuationContract({
    approvedPublication: {
      artifacts: [
        { digest: `sha256:${DIGEST}`, id: 1, name: "oliphaunt-publication-lock", size: 1 },
        { digest: `sha256:${DIGEST}`, id: 2, name: "oliphaunt-bootstrap-capsule", size: 1 },
      ],
      runId: 20,
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
    lock: { catalogDigest: DIGEST, lockDigest: DIGEST, packageEnvelopeDigest: DIGEST },
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
    artifact: {
      digest: `sha256:${DIGEST}`,
      id: 10,
      name: "bootstrap-continuation",
      size: 100,
    },
    contract,
  });
}

test("authorization binds one canonical pointer to the returned child run", () => {
  const continuation = pointer();
  const receipt = createReleaseContinuationAuthorization({
    childRunId: 101,
    pointer: continuation,
    repo: "f0rr0/oliphaunt",
  });
  assert.equal(
    continuationAuthorizationArtifactName(continuation),
    `release-continuation-authorization-100-2-${continuation.pointerDigest}`,
  );
  assert.deepEqual(validateReleaseContinuationAuthorization(receipt, {
    currentRunId: 101,
    pointer: continuation,
    repo: "f0rr0/oliphaunt",
  }), receipt);
  assert.equal(serializeReleaseContinuationAuthorization(receipt).endsWith("\n"), true);
});

test("a valid pointer and receipt cannot be replayed into a different child run", () => {
  const continuation = pointer();
  const receipt = createReleaseContinuationAuthorization({
    childRunId: 101,
    pointer: continuation,
    repo: "f0rr0/oliphaunt",
  });
  assert.throws(
    () => validateReleaseContinuationAuthorization(receipt, {
      currentRunId: 102,
      pointer: continuation,
      repo: "f0rr0/oliphaunt",
    }),
    /does not authorize this exact dispatched child run/u,
  );
});
