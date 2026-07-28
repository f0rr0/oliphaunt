import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCapacityDeferralResult,
  validateCapacityDeferralAdmission,
} from "./record-normal-publication-capacity-deferral.mjs";

const DIGEST = "a".repeat(64);
const lock = {
  catalogDigest: DIGEST,
  lockDigest: "b".repeat(64),
  packageEnvelopeDigest: "c".repeat(64),
  source: { commit: "d".repeat(40), tree: "e".repeat(40) },
};
const plan = {
  operations: [
    { id: "carrier:cargo:a" },
    { id: "carrier:npm:a" },
  ],
};

test("root-only capacity deferral records zero admitted/mutated operations and exact remaining plan", () => {
  const result = buildCapacityDeferralResult({
    checkpoint: { completedOperations: ["carrier:cargo:a"] },
    lock,
    notBeforeEpochSeconds: 2_000,
    plan,
    products: ["a"],
  });
  assert.equal(result.deferralMode, "pre-mutation-capacity");
  assert.deepEqual(result.admittedIds, []);
  assert.deepEqual(result.newlyCompletedIds, []);
  assert.deepEqual(result.completedIds, ["carrier:cargo:a"]);
  assert.deepEqual(result.remainingIds, ["carrier:npm:a"]);
});

test("capacity admission selects root capacity or one-shot continuation deadline mode", () => {
  const base = {
    authoritativeWindowSeconds: 100,
    continuationPointer: "",
    namesSatisfied: true,
    notBeforeEpochSeconds: 1_100,
    requiredWindowSeconds: 90,
  };
  assert.deepEqual(validateCapacityDeferralAdmission(base), {
    authoritativeWindowSeconds: 100,
    deferralMode: "pre-mutation-capacity",
    namesSatisfied: true,
    notBeforeEpochSeconds: 1_100,
    requiredWindowSeconds: 90,
  });
  assert.equal(
    validateCapacityDeferralAdmission({ ...base, continuationPointer: "{}" }).deferralMode,
    "pre-mutation-deadline",
  );
  assert.equal(
    validateCapacityDeferralAdmission({
      ...base,
      forcedDeferralMode: "pre-mutation-deadline",
    }).deferralMode,
    "pre-mutation-deadline",
  );
  assert.throws(
    () => validateCapacityDeferralAdmission({ ...base, forcedDeferralMode: "progress" }),
    /forced deferral mode/u,
  );
  assert.throws(
    () => validateCapacityDeferralAdmission({ ...base, namesSatisfied: false }),
    /requires every selected/u,
  );
  assert.deepEqual(
    validateCapacityDeferralAdmission({ ...base, notBeforeEpochSeconds: 1 }),
    { ...validateCapacityDeferralAdmission(base), notBeforeEpochSeconds: 1 },
  );
  assert.throws(
    () => validateCapacityDeferralAdmission({ ...base, requiredWindowSeconds: 101 }),
    /increase the modeled window or split the release/u,
  );
});

test("continuation deadline deferral admits one exact dependency-eligible operation without mutation", () => {
  const dependentPlan = {
    operations: [
      { id: "carrier:cargo:a", dependencies: [] },
      { id: "carrier:npm:a", dependencies: ["carrier:cargo:a"] },
    ],
  };
  const result = buildCapacityDeferralResult({
    checkpoint: { completedOperations: ["carrier:cargo:a"] },
    deferralMode: "pre-mutation-deadline",
    lock,
    notBeforeEpochSeconds: 2_000,
    plan: dependentPlan,
    products: ["a"],
  });
  assert.equal(result.deferralMode, "pre-mutation-deadline");
  assert.deepEqual(result.admittedIds, ["carrier:npm:a"]);
  assert.deepEqual(result.newlyCompletedIds, []);
  assert.deepEqual(result.remainingIds, ["carrier:npm:a"]);
});
