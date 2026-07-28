import assert from "node:assert/strict";
import test from "node:test";

import { decideNormalRegistryMutationStart } from "./normal-registry-mutation-start.mjs";

const base = {
  authoritativeWindowSeconds: 11_400,
  evidenceHandoffReserveSeconds: 900,
  jobHardDeadlineEpochSeconds: 30_000,
  nowEpochSeconds: 10_000,
  requiredWindowSeconds: 11_400,
};

test("authoritative start admits the exact required-window boundary", () => {
  assert.deepEqual(decideNormalRegistryMutationStart(base), {
    admission: "execute",
    availableWindowSeconds: 11_400,
    mutationDeadlineEpochSeconds: 21_400,
    notBeforeEpochSeconds: null,
    requiredWindowSeconds: 11_400,
  });
});

test("one second of capacity-to-start shrink becomes a typed zero-mutation deferral", () => {
  assert.deepEqual(decideNormalRegistryMutationStart({
    ...base,
    jobHardDeadlineEpochSeconds: 22_299,
  }), {
    admission: "defer",
    availableWindowSeconds: 11_399,
    mutationDeadlineEpochSeconds: null,
    notBeforeEpochSeconds: 10_001,
    requiredWindowSeconds: 11_400,
  });
});

test("an exhausted protected handoff window defers and malformed bounds fail closed", () => {
  assert.equal(decideNormalRegistryMutationStart({
    ...base,
    jobHardDeadlineEpochSeconds: 10_500,
  }).availableWindowSeconds, 0);
  assert.throws(
    () => decideNormalRegistryMutationStart({ ...base, requiredWindowSeconds: 0 }),
    /positive safe integer/u,
  );
  assert.throws(
    () => decideNormalRegistryMutationStart({
      ...base,
      authoritativeWindowSeconds: 1,
      jobHardDeadlineEpochSeconds: Number.MAX_SAFE_INTEGER,
      nowEpochSeconds: Number.MAX_SAFE_INTEGER,
    }),
    /derived registry mutation deadline exceeds the safe integer range/u,
  );
  assert.throws(
    () => decideNormalRegistryMutationStart({
      ...base,
      authoritativeWindowSeconds: 1,
      evidenceHandoffReserveSeconds: Number.MAX_SAFE_INTEGER,
      jobHardDeadlineEpochSeconds: 1,
      nowEpochSeconds: Math.floor(Number.MAX_SAFE_INTEGER / 2),
    }),
    /derived registry mutation capacity exceeds the safe integer range/u,
  );
});
