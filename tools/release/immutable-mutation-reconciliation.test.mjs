import { describe, expect, test } from "bun:test";

import { mutateOnceAndRequireExactState } from "./immutable-mutation-reconciliation.mjs";

describe("immutable mutation reconciliation", () => {
  test("requires a label and both operations before making a mutation", async () => {
    let mutations = 0;
    await expect(mutateOnceAndRequireExactState({
      label: "",
      mutate: () => { mutations += 1; },
      reconcile: () => {},
    })).rejects.toThrow("label must be a non-empty string");
    await expect(mutateOnceAndRequireExactState({
      label: "publish",
      mutate: null,
      reconcile: () => {},
    })).rejects.toThrow("mutate must be a function");
    await expect(mutateOnceAndRequireExactState({
      label: "publish",
      mutate: () => { mutations += 1; },
      reconcile: null,
    })).rejects.toThrow("reconcile must be a function");
    expect(mutations).toBe(0);
  });

  test("runs one mutation and one exact-state reconciliation on success", async () => {
    let mutations = 0;
    let reconciliations = 0;
    await expect(mutateOnceAndRequireExactState({
      label: "JSR publish for @scope/pkg@1.2.3",
      mutate: () => { mutations += 1; },
      reconcile: () => { reconciliations += 1; },
    })).resolves.toEqual({ reconciledMutationFailure: false });
    expect(mutations).toBe(1);
    expect(reconciliations).toBe(1);
  });

  test("accepts an applied-but-ambiguous mutation only after exact reconciliation", async () => {
    let mutations = 0;
    let reconciliations = 0;
    await expect(mutateOnceAndRequireExactState({
      label: "JSR publish for @scope/pkg@1.2.3",
      mutate: () => {
        mutations += 1;
        throw new Error("transport timed out");
      },
      reconcile: () => { reconciliations += 1; },
    })).resolves.toEqual({ reconciledMutationFailure: true });
    expect(mutations).toBe(1);
    expect(reconciliations).toBe(1);
  });

  test("never replays a failed mutation when exact state is absent", async () => {
    const mutationFailure = new Error("connection reset after upload");
    let mutations = 0;
    let reconciliations = 0;
    const promise = mutateOnceAndRequireExactState({
      label: "JSR publish for @scope/pkg@1.2.3",
      mutate: () => {
        mutations += 1;
        throw mutationFailure;
      },
      reconcile: () => {
        reconciliations += 1;
        throw new Error("exact version remains absent");
      },
    });
    await expect(promise).rejects.toThrow(
      "JSR publish for @scope/pkg@1.2.3 failed (connection reset after upload) and immutable state did not reconcile: exact version remains absent",
    );
    await promise.catch((error) => expect(error.cause).toBe(mutationFailure));
    expect(mutations).toBe(1);
    expect(reconciliations).toBe(1);
  });

  test("propagates reconciliation failure after a successful mutation", async () => {
    const reconciliationFailure = new Error("registry visibility deadline elapsed");
    const promise = mutateOnceAndRequireExactState({
      label: "JSR publish",
      mutate: () => {},
      reconcile: () => { throw reconciliationFailure; },
    });
    await expect(promise).rejects.toBe(reconciliationFailure);
  });
});
