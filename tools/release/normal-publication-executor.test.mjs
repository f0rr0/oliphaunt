import { describe, expect, test } from "bun:test";

import {
  collectNormalPublicationReceipts,
  executeNormalPublicationPlan,
} from "./normal-publication-executor.mjs";
import { runOrThrow } from "./release-cli-utils.mjs";
import { RegistryPublicationDeferredError } from "./registry-publication-deferral.mjs";

function operation(ecosystem, index, carrierId = `${ecosystem}:package-${index}`) {
  return {
    id: `carrier:${carrierId}`,
    kind: "carrier",
    ecosystem,
    carrierId,
    dependencies: [],
    operationOrder: index,
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

function tokenFetch(methods, tokens = ["cargo-token"]) {
  let tokenIndex = 0;
  return async (_url, init) => {
    methods.push(init.method);
    if (init.method === "GET") return Response.json({ value: `jwt-${tokenIndex}` });
    if (init.method === "POST") return Response.json({ token: tokens[tokenIndex++] ?? `token-${tokenIndex}` });
    return new Response("", { status: 200 });
  };
}

const tokenEnvironment = {
  GITHUB_ACTIONS: "true",
  ACTIONS_ID_TOKEN_REQUEST_URL: "https://pipelines.actions.example/token",
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-token",
};

describe("normal publication executor", () => {
  test("collects exact per-operation receipts without omission, addition, duplication, or bootstrap replacement", () => {
    const cargo = operation("cargo", 0);
    const npm = operation("npm", 1);
    const maven = {
      id: "maven:atomic-deployment",
      kind: "maven-atomic-deployment",
      ecosystem: "maven",
      carrierIds: ["maven:a", "maven:b"],
      dependencies: [],
      operationOrder: 2,
    };
    const cargoReceipt = { id: cargo.carrierId, proof: "bootstrap" };
    const npmReceipt = { id: npm.carrierId, proof: "npm" };
    const mavenReceipts = maven.carrierIds.map((id) => ({ id, proof: "maven" }));
    const plan = { operations: [cargo, npm, maven] };
    const collected = collectNormalPublicationReceipts({
      plan,
      initialReceipts: [cargoReceipt],
      operationResults: [undefined, npmReceipt, mavenReceipts],
    });
    expect([...collected.values()]).toEqual([cargoReceipt, npmReceipt, ...mavenReceipts]);
    expect(() => collectNormalPublicationReceipts({
      plan,
      initialReceipts: [cargoReceipt],
      operationResults: [undefined, undefined, mavenReceipts],
    })).toThrow(/exact non-bootstrap carrier set/u);
    expect(() => collectNormalPublicationReceipts({
      plan,
      initialReceipts: [cargoReceipt],
      operationResults: [cargoReceipt, npmReceipt, mavenReceipts],
    })).toThrow(/exact non-bootstrap carrier set/u);
    expect(() => collectNormalPublicationReceipts({
      plan,
      initialReceipts: [cargoReceipt],
      operationResults: [undefined, npmReceipt, [mavenReceipts[0], mavenReceipts[0]]],
    })).toThrow(/duplicate registry receipt/u);
  });

  test("executes lock-derived operations and gives Maven one atomic callback", async () => {
    const calls = [];
    const plan = {
      operations: [
        operation("npm", 0),
        {
          id: "maven:atomic-deployment",
          kind: "maven-atomic-deployment",
          ecosystem: "maven",
          carrierIds: ["maven:a", "maven:b"],
          dependencies: [],
          operationOrder: 1,
        },
        operation("jsr", 2),
      ],
    };
    const results = await executeNormalPublicationPlan({
      plan,
      cargoVersionPublished: () => { throw new Error("must not inspect Cargo"); },
      publishCarrier: async ({ carrierId }) => {
        calls.push(carrierId);
        return `receipt:${carrierId}`;
      },
      publishMaven: async ({ carrierIds }) => {
        calls.push(carrierIds.join("+"));
        return carrierIds.map((carrierId) => `receipt:${carrierId}`);
      },
    });
    expect(calls.toSorted()).toEqual(["jsr:package-2", "maven:a+maven:b", "npm:package-0"]);
    expect(results.decision).toBe("complete");
    expect(results.operationResults).toEqual([
      "receipt:npm:package-0",
      ["receipt:maven:a", "receipt:maven:b"],
      "receipt:jsr:package-2",
    ]);
  });

  test("overlaps independent lanes while serializing operations within each registry", async () => {
    const npmStarted = deferred();
    const cargoStarted = deferred();
    const releaseNpm = deferred();
    const releaseCargo = deferred();
    let secondNpmStarted = false;
    const run = executeNormalPublicationPlan({
      plan: {
        operations: [
          operation("npm", 0),
          operation("cargo", 1),
          operation("npm", 2),
        ],
      },
      cargoVersionPublished: async () => true,
      publishCarrier: async ({ carrierId }) => {
        if (carrierId === "npm:package-0") {
          npmStarted.resolve();
          await releaseNpm.promise;
        } else if (carrierId === "cargo:package-1") {
          cargoStarted.resolve();
          await releaseCargo.promise;
        } else {
          secondNpmStarted = true;
        }
        return carrierId;
      },
      publishMaven: () => { throw new Error("must not publish Maven"); },
      tokenOptions: { fetchImpl: () => { throw new Error("must not acquire token"); } },
    });

    await Promise.all([npmStarted.promise, cargoStarted.promise]);
    expect(secondNpmStarted).toBe(false);
    releaseNpm.resolve();
    releaseCargo.resolve();
    const result = await run;
    expect(result.decision).toBe("complete");
    expect(result.operationResults).toEqual(["npm:package-0", "cargo:package-1", "npm:package-2"]);
    expect(secondNpmStarted).toBe(true);
  });

  test("honors cross-registry dependencies without serializing independent lanes", async () => {
    const npmStarted = deferred();
    const cargoStarted = deferred();
    const mavenStarted = deferred();
    const releaseNpm = deferred();
    const releaseMaven = deferred();
    const events = [];
    const npm = operation("npm", 0);
    const cargo = operation("cargo", 1);
    const maven = {
      id: "maven:atomic-deployment",
      kind: "maven-atomic-deployment",
      ecosystem: "maven",
      carrierIds: ["maven:a"],
      dependencies: [npm.id],
      operationOrder: 2,
    };
    const jsr = {
      ...operation("jsr", 3),
      dependencies: [maven.id],
    };
    const run = executeNormalPublicationPlan({
      plan: { operations: [npm, cargo, maven, jsr] },
      cargoVersionPublished: async () => true,
      publishCarrier: async ({ carrierId }) => {
        events.push(`start:${carrierId}`);
        if (carrierId === npm.carrierId) {
          npmStarted.resolve();
          await releaseNpm.promise;
        } else if (carrierId === cargo.carrierId) {
          cargoStarted.resolve();
        }
        events.push(`finish:${carrierId}`);
        return carrierId;
      },
      publishMaven: async () => {
        events.push("start:maven");
        mavenStarted.resolve();
        await releaseMaven.promise;
        events.push("finish:maven");
        return ["maven:a"];
      },
      tokenOptions: { fetchImpl: () => { throw new Error("must not acquire token"); } },
    });

    await Promise.all([npmStarted.promise, cargoStarted.promise]);
    expect(events).not.toContain("start:maven");
    releaseNpm.resolve();
    await mavenStarted.promise;
    expect(events).not.toContain(`start:${jsr.carrierId}`);
    releaseMaven.resolve();
    await run;
    expect(events.indexOf(`finish:${npm.carrierId}`)).toBeLessThan(events.indexOf("start:maven"));
    expect(events.indexOf("finish:maven")).toBeLessThan(events.indexOf(`start:${jsr.carrierId}`));
  });

  test("splits Cargo token batches at cross-registry dependency barriers", async () => {
    const events = [];
    const cargoBefore = operation("cargo", 0);
    const npm = {
      ...operation("npm", 1),
      dependencies: [cargoBefore.id],
    };
    const cargoAfter = {
      ...operation("cargo", 2),
      dependencies: [npm.id],
    };
    await executeNormalPublicationPlan({
      plan: { operations: [cargoBefore, npm, cargoAfter] },
      cargoVersionPublished: async () => true,
      publishCarrier: async ({ carrierId }) => {
        events.push(carrierId);
        return carrierId;
      },
      publishMaven: () => { throw new Error("must not publish Maven"); },
      tokenOptions: { fetchImpl: () => { throw new Error("must not acquire token"); } },
    });
    expect(events).toEqual([cargoBefore.carrierId, npm.carrierId, cargoAfter.carrierId]);
  });

  test("does not acquire a token for lock-matching published Cargo carriers", async () => {
    const calls = [];
    const results = await executeNormalPublicationPlan({
      plan: { operations: [operation("cargo", 0), operation("cargo", 1)] },
      cargoVersionPublished: async () => true,
      publishCarrier: async ({ carrierId }, context) => {
        calls.push({ carrierId, context });
        return { id: carrierId, proof: "recovered-public-bytes" };
      },
      publishMaven: () => { throw new Error("must not publish Maven"); },
      tokenOptions: { fetchImpl: () => { throw new Error("must not acquire token"); } },
    });
    expect(calls).toEqual([
      { carrierId: "cargo:package-0", context: { alreadyPublished: true } },
      { carrierId: "cargo:package-1", context: { alreadyPublished: true } },
    ]);
    expect(results.operationResults).toEqual([
      { id: "cargo:package-0", proof: "recovered-public-bytes" },
      { id: "cargo:package-1", proof: "recovered-public-bytes" },
    ]);
  });

  test("uses fresh masked and revoked tokens for bounded contiguous Cargo batches", async () => {
    const methods = [];
    const masks = [];
    const calls = [];
    await executeNormalPublicationPlan({
      plan: { operations: [0, 1, 2, 3, 4].map((index) => operation("cargo", index)) },
      cargoVersionPublished: async () => false,
      publishCarrier: async ({ carrierId }, context) => calls.push({ carrierId, ...context }),
      publishMaven: () => { throw new Error("must not publish Maven"); },
      batchSize: 2,
      nowImpl: () => 1000,
      tokenOptions: {
        env: tokenEnvironment,
        fetchImpl: tokenFetch(methods, ["token-a", "token-b", "token-c"]),
        maskImpl: (value) => masks.push(value),
      },
    });
    expect(methods).toEqual(["GET", "POST", "DELETE", "GET", "POST", "DELETE", "GET", "POST", "DELETE"]);
    expect(masks).toEqual(["::add-mask::token-a\n", "::add-mask::token-b\n", "::add-mask::token-c\n"]);
    expect(calls.map(({ cargoToken }) => cargoToken)).toEqual(["token-a", "token-a", "token-b", "token-b", "token-c"]);
    expect(new Set(calls.map(({ tokenDeadlineEpochMs }) => tokenDeadlineEpochMs))).toEqual(new Set([1_201_000]));
  });

  test("defers before the next upload when a Cargo batch ages out and still revokes", async () => {
    const methods = [];
    let now = 1_000;
    const first = operation("cargo", 0);
    const second = operation("cargo", 1);
    const uploads = [];
    const result = await executeNormalPublicationPlan({
      plan: { operations: [first, second] },
      cargoVersionPublished: async () => false,
      publishCarrier: async ({ carrierId }) => {
        uploads.push(carrierId);
        now = 1_201_000;
        return carrierId;
      },
      publishMaven: () => { throw new Error("must not publish Maven"); },
      nowImpl: () => now,
      tokenOptions: {
        env: tokenEnvironment,
        fetchImpl: tokenFetch(methods),
        maskImpl: () => {},
      },
    });
    expect(uploads).toEqual([first.carrierId]);
    expect(methods).toEqual(["GET", "POST", "DELETE"]);
    expect(result).toMatchObject({
      decision: "deferred",
      completedOperationIds: [first.id],
      newlyCompletedOperationIds: [first.id],
      remainingOperationIds: [second.id],
      deferReason: "deadline",
      notBeforeEpochSeconds: 1_202,
    });
  });

  test("releases the temporary token after a carrier failure", async () => {
    const methods = [];
    await expect(executeNormalPublicationPlan({
      plan: { operations: [operation("cargo", 0)] },
      cargoVersionPublished: async () => false,
      publishCarrier: async () => { throw new Error("upload failed"); },
      publishMaven: () => { throw new Error("must not publish Maven"); },
      tokenOptions: {
        env: tokenEnvironment,
        fetchImpl: tokenFetch(methods),
        maskImpl: () => {},
      },
    })).rejects.toThrow("upload failed");
    expect(methods).toEqual(["GET", "POST", "DELETE"]);
  });

  test("drains an in-flight Cargo mutation and revokes its token after a peer-lane failure", async () => {
    const methods = [];
    const cargoStarted = deferred();
    const releaseCargo = deferred();
    const npmMayFail = deferred();
    const run = executeNormalPublicationPlan({
      plan: { operations: [operation("cargo", 0), operation("npm", 1)] },
      cargoVersionPublished: async () => false,
      publishCarrier: async ({ ecosystem }) => {
        if (ecosystem === "cargo") {
          cargoStarted.resolve();
          await releaseCargo.promise;
          return;
        }
        await cargoStarted.promise;
        await npmMayFail.promise;
        throw new Error("npm peer failed");
      },
      publishMaven: () => { throw new Error("must not publish Maven"); },
      tokenOptions: {
        env: tokenEnvironment,
        fetchImpl: tokenFetch(methods),
        maskImpl: () => {},
      },
    });
    await cargoStarted.promise;
    npmMayFail.resolve();
    await Promise.resolve();
    releaseCargo.resolve();
    await expect(run).rejects.toThrow("npm peer failed");
    expect(methods).toEqual(["GET", "POST", "DELETE"]);
  });

  test("turns a real peer command exit into a drained failure before Cargo token revocation", async () => {
    const methods = [];
    const cargoStarted = deferred();
    const releaseCargo = deferred();
    const peerFailed = deferred();
    const run = executeNormalPublicationPlan({
      plan: { operations: [operation("cargo", 0), operation("jsr", 1)] },
      cargoVersionPublished: async () => false,
      publishCarrier: async ({ ecosystem }) => {
        if (ecosystem === "cargo") {
          cargoStarted.resolve();
          await releaseCargo.promise;
          return;
        }
        await cargoStarted.promise;
        try {
          runOrThrow("normal-publication-executor.test", [
            process.execPath,
            "-e",
            "process.exit(23)",
          ]);
        } finally {
          peerFailed.resolve();
        }
      },
      publishMaven: () => { throw new Error("must not publish Maven"); },
      tokenOptions: {
        env: tokenEnvironment,
        fetchImpl: tokenFetch(methods),
        maskImpl: () => {},
      },
    });
    await peerFailed.promise;
    expect(methods).toEqual(["GET", "POST"]);
    releaseCargo.resolve();
    await expect(run).rejects.toThrow("exited with status 23");
    expect(methods).toEqual(["GET", "POST", "DELETE"]);
  });

  test("treats mandatory token revocation time as unavailable to Cargo publication", async () => {
    const methods = [];
    const contexts = [];
    await executeNormalPublicationPlan({
      plan: { operations: [operation("cargo", 0)] },
      cargoVersionPublished: async () => false,
      publishCarrier: async (_operation, context) => contexts.push(context),
      publishMaven: () => { throw new Error("must not publish Maven"); },
      nowImpl: () => 800_000,
      tokenOptions: {
        env: tokenEnvironment,
        deadlineEpochMs: 1_000_000,
        fetchImpl: tokenFetch(methods),
        maskImpl: () => {},
      },
    });
    expect(methods).toEqual(["GET", "POST", "DELETE"]);
    expect(contexts[0].tokenDeadlineEpochMs).toBe(940_000);
  });

  test("returns typed partial progress only for a genuine safe registry deferral", async () => {
    const cargo = operation("cargo", 0);
    const npm = operation("npm", 1);
    const checkpointed = [];
    const result = await executeNormalPublicationPlan({
      plan: { operations: [cargo, npm] },
      cargoVersionPublished: async () => true,
      publishCarrier: async ({ id, carrierId }) => {
        if (id === cargo.id) {
          throw new RegistryPublicationDeferredError({
            reason: "deadline",
            notBeforeEpochSeconds: 1_800_000_000,
            context: "no Cargo request started before the bounded deadline",
          });
        }
        return carrierId;
      },
      publishMaven: () => { throw new Error("must not publish Maven"); },
      onOperationComplete: async ({ id }) => checkpointed.push(id),
      tokenOptions: { fetchImpl: () => { throw new Error("must not acquire token"); } },
    });
    expect(result).toEqual({
      decision: "deferred",
      operationResults: [undefined, npm.carrierId],
      admittedOperationIds: [cargo.id, npm.id],
      completedOperationIds: [npm.id],
      newlyCompletedOperationIds: [npm.id],
      remainingOperationIds: [cargo.id],
      deferReason: "deadline",
      notBeforeEpochSeconds: 1_800_000_000,
    });
    expect(checkpointed).toEqual([npm.id]);

    const first = operation("npm", 0);
    const zeroProgress = await executeNormalPublicationPlan({
      plan: { operations: [first] },
      cargoVersionPublished: async () => true,
      publishCarrier: async () => {
        throw new RegistryPublicationDeferredError({
          reason: "rate-limit",
          notBeforeEpochSeconds: 1_800_000_060,
          context: "explicit registry 429 on the first operation",
        });
      },
      publishMaven: async () => {
        throw new Error("must not publish Maven");
      },
    });
    expect(zeroProgress).toEqual({
      decision: "deferred",
      operationResults: [undefined],
      admittedOperationIds: [first.id],
      completedOperationIds: [],
      newlyCompletedOperationIds: [],
      remainingOperationIds: [first.id],
      deferReason: "rate-limit",
      notBeforeEpochSeconds: 1_800_000_060,
    });

    const lookalike = Object.assign(new Error("ambiguous transport failure"), {
      reason: "rate-limit",
      notBeforeEpochSeconds: 1_800_000_000,
    });
    await expect(executeNormalPublicationPlan({
      plan: { operations: [{ ...npm, operationOrder: 0 }] },
      cargoVersionPublished: async () => true,
      publishCarrier: async () => { throw lookalike; },
      publishMaven: async () => {},
    })).rejects.toBe(lookalike);
  });

  test("never invokes callbacks for unadmitted operations and checkpoints a typed progress continuation", async () => {
    const cargo = operation("cargo", 0);
    const npmFirst = operation("npm", 1);
    const npmLater = {
      ...operation("npm", 2),
      dependencies: [npmFirst.id],
    };
    const maven = {
      id: "maven:atomic-deployment",
      kind: "maven-atomic-deployment",
      ecosystem: "maven",
      carrierIds: ["maven:a", "maven:b"],
      dependencies: [],
      operationOrder: 3,
    };
    const calls = [];
    const checkpointed = [];
    const result = await executeNormalPublicationPlan({
      plan: { operations: [cargo, npmFirst, npmLater, maven] },
      admittedOperationIds: [cargo.id, npmFirst.id],
      cargoVersionPublished: async () => true,
      publishCarrier: async ({ id, carrierId }) => {
        calls.push(id);
        return carrierId;
      },
      publishMaven: async () => {
        throw new Error("unadmitted Maven callback must not run");
      },
      onOperationComplete: async ({ id }) => checkpointed.push(id),
      tokenOptions: { fetchImpl: () => { throw new Error("must not acquire token"); } },
      nowImpl: () => 1_800_000_000_000,
    });
    expect(calls.toSorted()).toEqual([cargo.id, npmFirst.id]);
    expect(checkpointed.toSorted()).toEqual([cargo.id, npmFirst.id]);
    expect(result).toMatchObject({
      decision: "deferred",
      deferReason: "capacity",
      admittedOperationIds: [cargo.id, npmFirst.id],
      completedOperationIds: [cargo.id, npmFirst.id],
      newlyCompletedOperationIds: [cargo.id, npmFirst.id],
      remainingOperationIds: [npmLater.id, maven.id],
      notBeforeEpochSeconds: 1_800_000_001,
    });
  });

  test("rejects a non-closed or reordered admission before any callback", async () => {
    const first = operation("npm", 0);
    const second = { ...operation("jsr", 1), dependencies: [first.id] };
    let called = false;
    const callbacks = {
      cargoVersionPublished: async () => { called = true; },
      publishCarrier: async () => { called = true; },
      publishMaven: async () => { called = true; },
    };
    await expect(executeNormalPublicationPlan({
      plan: { operations: [first, second] },
      admittedOperationIds: [second.id],
      ...callbacks,
    })).rejects.toThrow(/omits dependencies/u);
    await expect(executeNormalPublicationPlan({
      plan: { operations: [first, second] },
      admittedOperationIds: [second.id, first.id],
      ...callbacks,
    })).rejects.toThrow(/ordered projection/u);
    expect(called).toBe(false);
  });

  test("treats checkpoint errors as hard even when they use the deferral type", async () => {
    const npm = operation("npm", 0);
    await expect(executeNormalPublicationPlan({
      plan: { operations: [npm] },
      cargoVersionPublished: async () => true,
      publishCarrier: async () => npm.carrierId,
      publishMaven: async () => {},
      onOperationComplete: async () => {
        throw new RegistryPublicationDeferredError({
          reason: "deadline",
          notBeforeEpochSeconds: 1_800_000_000,
          context: "invalid checkpoint control flow",
        });
      },
    })).rejects.toThrow(/immutable checkpoint failed/u);
  });

  test("rejects malformed plans and oversized batches before mutation", async () => {
    const callbacks = {
      cargoVersionPublished: () => { throw new Error("must not inspect"); },
      publishCarrier: () => { throw new Error("must not publish"); },
      publishMaven: () => { throw new Error("must not publish"); },
    };
    await expect(executeNormalPublicationPlan({
      plan: { operations: [{ ...operation("cargo", 0), operationOrder: 2 }] },
      ...callbacks,
    })).rejects.toThrow("contiguous canonical order");
    await expect(executeNormalPublicationPlan({
      plan: { operations: [] },
      batchSize: 21,
      ...callbacks,
    })).rejects.toThrow("from 1 through 20");
  });
});
