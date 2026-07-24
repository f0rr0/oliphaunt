import { describe, expect, test } from "bun:test";

import { uploadCargoOnceAndReconcileExactVersion } from "./cargo-upload-reconciliation.mjs";
import { RegistryPublicationDeferredError } from "./registry-publication-deferral.mjs";

function laggingExactVersionFixture({ uploadFailure = null } = {}) {
  const events = [];
  const registryStates = ["missing-name", "pending-version", "published-exact-version"];
  return {
    events,
    options: {
      crateName: "oliphaunt-fixture",
      version: "1.2.3",
      upload: async () => {
        events.push("upload");
        if (uploadFailure !== null) throw uploadFailure;
      },
      exactVersionPublished: async () => {
        const state = registryStates.shift();
        events.push(`inspect:${state}`);
        return state === "published-exact-version";
      },
      waitBeforeNextProbe: async () => {
        events.push("wait");
      },
    },
  };
}

describe("Cargo upload reconciliation", () => {
  test("a successful upload tolerates name visibility before exact-version visibility", async () => {
    const fixture = laggingExactVersionFixture();

    await expect(uploadCargoOnceAndReconcileExactVersion(fixture.options)).resolves.toEqual({
      reconciledMutationFailure: false,
    });
    expect(fixture.events).toEqual([
      "upload",
      "inspect:missing-name",
      "wait",
      "inspect:pending-version",
      "wait",
      "inspect:published-exact-version",
    ]);
    expect(fixture.events.filter((event) => event === "upload")).toHaveLength(1);
  });

  test("an ambiguous upload failure polls through the same lag without replaying mutation", async () => {
    const fixture = laggingExactVersionFixture({ uploadFailure: new Error("connection reset after request body") });

    await expect(uploadCargoOnceAndReconcileExactVersion(fixture.options)).resolves.toEqual({
      reconciledMutationFailure: true,
    });
    expect(fixture.events).toEqual([
      "upload",
      "inspect:missing-name",
      "wait",
      "inspect:pending-version",
      "wait",
      "inspect:published-exact-version",
    ]);
    expect(fixture.events.filter((event) => event === "upload")).toHaveLength(1);
  });

  test("a typed pre-upload or explicit 429 deferral is preserved without visibility polling", async () => {
    const deferral = new RegistryPublicationDeferredError({
      reason: "rate-limit",
      notBeforeEpochSeconds: 1_234,
      context: "crates.io returned an explicit Retry-After before accepting the upload",
    });
    const events = [];

    await expect(uploadCargoOnceAndReconcileExactVersion({
      crateName: "oliphaunt-fixture",
      version: "1.2.3",
      upload: async () => {
        events.push("upload");
        throw deferral;
      },
      exactVersionPublished: async () => {
        events.push("inspect");
        return false;
      },
      waitBeforeNextProbe: async () => {
        events.push("wait");
      },
    })).rejects.toBe(deferral);
    expect(events).toEqual(["upload"]);
  });
});
