import { describe, expect, test } from "bun:test";

import { executeBootstrapPublicationPlan } from "./bootstrap-publication-executor.mjs";
import { RegistryPublicationDeferredError } from "./registry-publication-deferral.mjs";

function carrier(ecosystem, publishOrder, dependencies = []) {
  const name = ecosystem === "cargo" ? `crate-${publishOrder}` : `@example/pkg-${publishOrder}`;
  return {
    id: `${ecosystem}:${name}`,
    product: "fixture",
    ecosystem,
    name,
    version: "1.0.0",
    publishOrder,
    dependencies,
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

describe("bootstrap publication executor", () => {
  test("overlaps independent registry lanes, serializes each lane, and checkpoints canonical IDs once", async () => {
    const cargoFirst = carrier("cargo", 0);
    const npmFirst = carrier("npm", 1);
    const cargoSecond = carrier("cargo", 2);
    const npmSecond = carrier("npm", 3);
    const cargoStarted = deferred();
    const cargoSecondStarted = deferred();
    const npmStarted = deferred();
    const releaseCargo = deferred();
    const releaseNpm = deferred();
    const started = [];
    const checkpoints = [];
    const run = executeBootstrapPublicationPlan({
      plan: [cargoFirst, npmFirst, cargoSecond, npmSecond],
      checkpointBatchSize: 3,
      publishCarrier: async ({ id }) => {
        started.push(id);
        if (id === cargoFirst.id) {
          cargoStarted.resolve();
          await releaseCargo.promise;
        } else if (id === cargoSecond.id) {
          cargoSecondStarted.resolve();
        } else if (id === npmFirst.id) {
          npmStarted.resolve();
          await releaseNpm.promise;
        }
      },
      checkpointCarrierIds: async (ids) => checkpoints.push(ids),
    });

    await Promise.all([cargoStarted.promise, npmStarted.promise]);
    expect(started).toEqual([cargoFirst.id, npmFirst.id]);
    releaseCargo.resolve();
    await cargoSecondStarted.promise;
    expect(started).toContain(cargoSecond.id);
    expect(started).not.toContain(npmSecond.id);
    releaseNpm.resolve();
    const result = await run;
    const canonical = [cargoFirst.id, npmFirst.id, cargoSecond.id, npmSecond.id];
    expect(result.completedCarrierIds).toEqual(canonical);
    expect(result.checkpointedCarrierIds).toEqual(canonical);
    expect(checkpoints.flat()).toEqual(canonical);
    expect(new Set(checkpoints.flat()).size).toBe(canonical.length);
  });

  test("honors cross-registry dependency barriers without deadlock", async () => {
    const cargoBefore = carrier("cargo", 0);
    const npmMiddle = carrier("npm", 1, [cargoBefore.id]);
    const cargoAfter = carrier("cargo", 2, [npmMiddle.id]);
    const events = [];
    await executeBootstrapPublicationPlan({
      plan: [cargoBefore, npmMiddle, cargoAfter],
      publishCarrier: async ({ id }) => events.push(id),
      checkpointCarrierIds: async (ids) => events.push(`checkpoint:${ids.join("+")}`),
    });
    expect(events).toEqual([
      cargoBefore.id,
      npmMiddle.id,
      cargoAfter.id,
      `checkpoint:${cargoBefore.id}+${npmMiddle.id}+${cargoAfter.id}`,
    ]);
  });

  test("drains a peer in-flight mutation and checkpoints it after a publication failure", async () => {
    const cargoFirst = carrier("cargo", 0);
    const npmFirst = carrier("npm", 1);
    const cargoSecond = carrier("cargo", 2);
    const npmSecond = carrier("npm", 3);
    const cargoStarted = deferred();
    const npmStarted = deferred();
    const releaseCargo = deferred();
    const failNpm = deferred();
    const started = [];
    const checkpoints = [];
    const run = executeBootstrapPublicationPlan({
      plan: [cargoFirst, npmFirst, cargoSecond, npmSecond],
      publishCarrier: async ({ id }) => {
        started.push(id);
        if (id === cargoFirst.id) {
          cargoStarted.resolve();
          await releaseCargo.promise;
        } else if (id === npmFirst.id) {
          npmStarted.resolve();
          await failNpm.promise;
          throw new Error("npm publication failed");
        }
      },
      checkpointCarrierIds: async (ids) => checkpoints.push(ids),
    });
    await Promise.all([cargoStarted.promise, npmStarted.promise]);
    failNpm.resolve();
    await Promise.resolve();
    releaseCargo.resolve();
    await expect(run).rejects.toThrow("npm publication failed");
    expect(started).toEqual([cargoFirst.id, npmFirst.id]);
    expect(checkpoints).toEqual([[cargoFirst.id]]);
  });

  test("a checkpoint failure aborts new mutations, drains the peer, and retries only uncheckpointed IDs", async () => {
    const cargoFirst = carrier("cargo", 0);
    const npmFirst = carrier("npm", 1);
    const cargoSecond = carrier("cargo", 2);
    const npmSecond = carrier("npm", 3);
    const npmStarted = deferred();
    const releaseNpm = deferred();
    const started = [];
    const checkpointCalls = [];
    let attempts = 0;
    const run = executeBootstrapPublicationPlan({
      plan: [cargoFirst, npmFirst, cargoSecond, npmSecond],
      checkpointBatchSize: 1,
      publishCarrier: async ({ id }) => {
        started.push(id);
        if (id === npmFirst.id) {
          npmStarted.resolve();
          await releaseNpm.promise;
        }
      },
      checkpointCarrierIds: async (ids) => {
        checkpointCalls.push(ids);
        attempts += 1;
        if (attempts === 1) throw new Error("checkpoint unavailable");
      },
    });
    await npmStarted.promise;
    // Cargo's first completion starts the failing checkpoint while npm is in
    // flight. Let npm drain only after the shared abort is established.
    await Promise.resolve();
    releaseNpm.resolve();
    await expect(run).rejects.toThrow("checkpoint unavailable");
    expect(started).toEqual([cargoFirst.id, npmFirst.id]);
    expect(checkpointCalls).toEqual([
      [cargoFirst.id],
      [cargoFirst.id, npmFirst.id],
    ]);
  });

  test("aggregates a primary publication failure with final checkpoint failure", async () => {
    const cargo = carrier("cargo", 0);
    const npm = carrier("npm", 1);
    const cargoStarted = deferred();
    const releaseCargo = deferred();
    let observed;
    try {
      await executeBootstrapPublicationPlan({
        plan: [cargo, npm],
        publishCarrier: async ({ id }) => {
          if (id === cargo.id) {
            cargoStarted.resolve();
            await releaseCargo.promise;
            return;
          }
          await cargoStarted.promise;
          releaseCargo.resolve();
          throw new Error("npm primary failure");
        },
        checkpointCarrierIds: async () => {
          throw new Error("final checkpoint failure");
        },
      });
    } catch (cause) {
      observed = cause;
    }
    expect(observed).toBeInstanceOf(AggregateError);
    expect(observed.errors.map(({ message }) => message)).toEqual([
      "npm primary failure",
      "final checkpoint failure",
    ]);
  });

  test("accepts dependencies already proved public and rejects malformed plans before mutation", async () => {
    const satisfied = carrier("cargo", 0);
    const pending = carrier("npm", 1, [satisfied.id]);
    const calls = [];
    await executeBootstrapPublicationPlan({
      plan: [pending],
      satisfiedCarrierIds: [satisfied.id],
      publishCarrier: async ({ id }) => calls.push(id),
      checkpointCarrierIds: async (ids) => calls.push(...ids),
    });
    expect(calls).toEqual([pending.id, pending.id]);

    await expect(executeBootstrapPublicationPlan({
      plan: [{ ...pending, dependencies: ["cargo:unknown"] }],
      publishCarrier: () => { throw new Error("must not publish"); },
      checkpointCarrierIds: () => { throw new Error("must not checkpoint"); },
    })).rejects.toThrow(/unknown unsatisfied dependency/u);
  });

  test("drains and checkpoints peer progress for a typed rate-limit deferral", async () => {
    const cargo = carrier("cargo", 0);
    const npm = carrier("npm", 1);
    const checkpoints = [];
    const result = await executeBootstrapPublicationPlan({
      plan: [cargo, npm],
      publishCarrier: async ({ id }) => {
        if (id === cargo.id) {
          throw new RegistryPublicationDeferredError({
            reason: "rate-limit",
            notBeforeEpochSeconds: 1_800_000_000,
            context: "explicit crates.io 429 with valid Retry-After",
          });
        }
      },
      checkpointCarrierIds: async (ids) => checkpoints.push(ids),
    });
    expect(result).toEqual({
      decision: "deferred",
      completedCarrierIds: [npm.id],
      checkpointedCarrierIds: [npm.id],
      remainingCarrierIds: [cargo.id],
      deferReason: "rate-limit",
      notBeforeEpochSeconds: 1_800_000_000,
    });
    expect(checkpoints).toEqual([[npm.id]]);
  });

  test("preserves a genuine first-operation 429 as a typed zero-progress rate-limit deferral", async () => {
    const cargo = carrier("cargo", 0);
    const result = await executeBootstrapPublicationPlan({
      plan: [cargo],
      publishCarrier: async () => {
        throw new RegistryPublicationDeferredError({
          reason: "rate-limit",
          notBeforeEpochSeconds: 1_800_000_060,
          context: "explicit crates.io 429 before the first accepted upload",
        });
      },
      checkpointCarrierIds: async () => {
        throw new Error("zero progress must not create a checkpoint");
      },
    });
    expect(result).toEqual({
      decision: "deferred",
      completedCarrierIds: [],
      checkpointedCarrierIds: [],
      remainingCarrierIds: [cargo.id],
      deferReason: "rate-limit",
      notBeforeEpochSeconds: 1_800_000_060,
    });
  });

  test("never converts a lookalike or checkpoint failure into a safe deferral", async () => {
    const cargo = carrier("cargo", 0);
    const lookalike = Object.assign(new Error("ambiguous upload"), {
      reason: "rate-limit",
      notBeforeEpochSeconds: 1_800_000_000,
    });
    await expect(executeBootstrapPublicationPlan({
      plan: [cargo],
      publishCarrier: async () => { throw lookalike; },
      checkpointCarrierIds: async () => {},
    })).rejects.toBe(lookalike);

    await expect(executeBootstrapPublicationPlan({
      plan: [cargo],
      publishCarrier: async () => {},
      checkpointCarrierIds: async () => {
        throw new RegistryPublicationDeferredError({
          reason: "deadline",
          notBeforeEpochSeconds: 1_800_000_000,
          context: "invalid checkpoint control flow",
        });
      },
    })).rejects.toThrow(/invalid during immutable checkpoint reconciliation/u);
  });
});
