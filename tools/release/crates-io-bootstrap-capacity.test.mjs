import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
  CRATES_IO_DEFAULT_NEW_CRATE_BURST,
  CRATES_IO_DEFAULT_VERSION_BURST,
  CRATES_IO_NEW_CRATE_REFILL_SECONDS,
  CRATES_IO_VERSION_REFILL_SECONDS,
  assessCratesIoBootstrapCapacity,
  assessCratesIoVersionCapacity,
  assertCratesIoBootstrapCapacity,
  assertCratesIoVersionCapacity,
  cratesIoCapacitySummary,
  cratesIoVersionCapacitySummary,
  inspectCratesIoBootstrapNames,
  inspectCratesIoVersionState,
  parseCratesIoRunCapacity,
  parseCratesIoVersionRunCapacity,
} from "./crates-io-bootstrap-capacity.mjs";

function cargoPlan(names) {
  return names.map((name, publishOrder) => ({
    id: `cargo:${name}`,
    product: "fixture",
    ecosystem: "cargo",
    name,
    version: "0.1.0",
    publishOrder,
  }));
}

describe("crates.io release capacity gates", () => {
  test("runs the capacity inventory before the genesis checkpoint and all registry mutations", () => {
    const source = readFileSync(
      new URL("../../.github/scripts/bootstrap-registry-identities.mjs", import.meta.url),
      "utf8",
    );
    const inventory = source.indexOf("const inventory = await inspectCratesIoBootstrapNames");
    const assertion = source.indexOf("assertCratesIoBootstrapCapacity(assessment)");
    const genesis = source.indexOf('ledger("init")');
    const publication = source.indexOf('"tools/release/release-publish.mjs"');
    expect(inventory).toBeGreaterThan(0);
    expect(inventory).toBeLessThan(assertion);
    expect(assertion).toBeLessThan(genesis);
    expect(genesis).toBeLessThan(publication);
  });

  test("counts only missing exact-lock Cargo names using read-only requests", async () => {
    const calls = [];
    const inventory = await inspectCratesIoBootstrapNames({
      plan: [
        ...cargoPlan(["already-owned", "brand-new"]),
        { id: "npm:fixture", ecosystem: "npm", name: "fixture", version: "0.1.0" },
      ],
      deadlineEpochSeconds: 10_000,
      nowImpl: () => 1_000,
      concurrency: 1,
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        return new Response("", { status: url.endsWith("/already-owned") ? 200 : 404 });
      },
    });

    expect(inventory).toEqual({
      selectedNames: ["already-owned", "brand-new"],
      existingNames: ["already-owned"],
      missingNames: ["brand-new"],
    });
    expect(calls).toHaveLength(2);
    expect(calls.every(({ init }) => init.method === undefined && init.redirect === "error")).toBe(true);
  });

  test("rejects the 417-name default-rate bootstrap and accepts only sufficient asserted capacity", () => {
    const inventory = {
      selectedNames: Array.from({ length: 417 }, (_, index) => `crate-${index}`),
      existingNames: [],
      missingNames: Array.from({ length: 417 }, (_, index) => `crate-${index}`),
    };
    const defaultAssessment = assessCratesIoBootstrapCapacity({
      inventory,
      configuredCapacity: "",
      deadlineEpochSeconds: 20_800,
      nowEpochSeconds: 1_000,
    });
    expect(defaultAssessment.effectiveCapacity).toBe(CRATES_IO_DEFAULT_NEW_CRATE_BURST);
    expect(defaultAssessment.defaultMinimumSeconds).toBe((417 - 5) * CRATES_IO_NEW_CRATE_REFILL_SECONDS);
    expect(defaultAssessment.allowed).toBe(false);
    expect(() => assertCratesIoBootstrapCapacity(defaultAssessment)).toThrow(/at least 417/u);
    expect(cratesIoCapacitySummary(defaultAssessment)).toContain("68h 40m");

    const approved = assessCratesIoBootstrapCapacity({
      inventory,
      configuredCapacity: "417",
      deadlineEpochSeconds: 20_800,
      nowEpochSeconds: 1_000,
    });
    expect(approved.capacitySource).toBe("protected-environment-assertion");
    expect(approved.allowed).toBe(true);
    expect(() => assertCratesIoBootstrapCapacity(approved)).not.toThrow();
  });

  test("fails malformed, too-low, duplicate, and late contracts", async () => {
    for (const value of ["5.0", "-1", "1e3", "unlimited", "100001"]) {
      expect(() => parseCratesIoRunCapacity(value)).toThrow(/non-negative integer|must not exceed/u);
    }
    await expect(inspectCratesIoBootstrapNames({
      plan: cargoPlan(["same", "same"]),
      deadlineEpochSeconds: 10_000,
      nowImpl: () => 1_000,
      fetchImpl: async () => new Response("", { status: 404 }),
    })).rejects.toThrow(/duplicate Cargo package names/u);

    const late = assessCratesIoBootstrapCapacity({
      inventory: { selectedNames: ["new"], existingNames: [], missingNames: ["new"] },
      configuredCapacity: "1",
      deadlineEpochSeconds: 1_500,
      nowEpochSeconds: 1_000,
    });
    expect(() => assertCratesIoBootstrapCapacity(late)).toThrow(/before the registry mutation deadline/u);
  });

  test("honors bounded transient read retry and rejects an excessive Retry-After", async () => {
    let calls = 0;
    let now = 1_000;
    const sleeps = [];
    const inventory = await inspectCratesIoBootstrapNames({
      plan: cargoPlan(["retry-me"]),
      deadlineEpochSeconds: 10_000,
      nowImpl: () => now,
      sleepImpl: async (milliseconds) => {
        sleeps.push(milliseconds);
        now += milliseconds / 1000;
      },
      fetchImpl: async () => {
        calls += 1;
        return calls === 1
          ? new Response("", { status: 503, headers: { "Retry-After": "2" } })
          : new Response("", { status: 404 });
      },
    });
    expect(inventory.missingNames).toEqual(["retry-me"]);
    expect(sleeps).toEqual([2_000]);

    await expect(inspectCratesIoBootstrapNames({
      plan: cargoPlan(["later"]),
      deadlineEpochSeconds: 10_000,
      nowImpl: () => 1_000,
      fetchImpl: async () => new Response("", { status: 429, headers: { "Retry-After": "60" } }),
    })).rejects.toThrow(/retry the release later/u);
  });

  test("classifies published versions, pending updates, and names that still need bootstrap", async () => {
    const inventory = await inspectCratesIoVersionState({
      plan: cargoPlan(["missing", "pending", "published"]),
      deadlineEpochSeconds: 10_000,
      nowImpl: () => 1_000,
      concurrency: 1,
      fetchImpl: async (url) => {
        if (url.endsWith("/crates/published/0.1.0")) return new Response("", { status: 200 });
        if (url.endsWith("/crates/pending")) return new Response("", { status: 200 });
        return new Response("", { status: 404 });
      },
    });

    expect(inventory).toEqual({
      selectedIdentities: [
        { name: "missing", version: "0.1.0" },
        { name: "pending", version: "0.1.0" },
        { name: "published", version: "0.1.0" },
      ],
      publishedIdentities: [{ name: "published", version: "0.1.0" }],
      pendingVersions: [{ name: "pending", version: "0.1.0" }],
      missingNames: ["missing"],
    });
  });

  test("uses the official 30-version burst and requires protected capacity only above it", () => {
    const identities = Array.from({ length: 417 }, (_, index) => ({ name: `crate-${index}`, version: "1.0.0" }));
    const inventory = {
      selectedIdentities: identities,
      publishedIdentities: [],
      pendingVersions: identities,
      missingNames: [],
    };
    const absent = assessCratesIoVersionCapacity({
      inventory,
      configuredCapacity: "",
      deadlineEpochSeconds: 20_800,
      nowEpochSeconds: 1_000,
    });
    expect(absent.defaultMinimumSeconds).toBe((417 - CRATES_IO_DEFAULT_VERSION_BURST) * CRATES_IO_VERSION_REFILL_SECONDS);
    expect(absent.defaultMinimumSeconds).toBe(6 * 60 * 60 + 27 * 60);
    expect(absent.effectiveCapacity).toBe(CRATES_IO_DEFAULT_VERSION_BURST);
    expect(absent.capacitySource).toBe("official-default");
    expect(absent.allowed).toBe(false);
    expect(() => assertCratesIoVersionCapacity(absent)).toThrow(/official default burst of 30/u);
    expect(cratesIoVersionCapacitySummary(absent)).toContain("6h 27m");

    const ordinary = assessCratesIoVersionCapacity({
      inventory: {
        selectedIdentities: identities.slice(0, CRATES_IO_DEFAULT_VERSION_BURST),
        publishedIdentities: [],
        pendingVersions: identities.slice(0, CRATES_IO_DEFAULT_VERSION_BURST),
        missingNames: [],
      },
      configuredCapacity: "",
      deadlineEpochSeconds: 20_800,
      nowEpochSeconds: 1_000,
    });
    expect(ordinary.allowed).toBe(true);
    expect(() => assertCratesIoVersionCapacity(ordinary)).not.toThrow();

    const insufficient = assessCratesIoVersionCapacity({
      inventory,
      configuredCapacity: "416",
      deadlineEpochSeconds: 20_800,
      nowEpochSeconds: 1_000,
    });
    expect(() => assertCratesIoVersionCapacity(insufficient)).toThrow(/asserts only 416/u);

    const approved = assessCratesIoVersionCapacity({
      inventory,
      configuredCapacity: "417",
      deadlineEpochSeconds: 20_800,
      nowEpochSeconds: 1_000,
    });
    expect(approved.allowed).toBe(true);
    expect(approved.capacitySource).toBe("protected-environment-assertion");
    expect(approved.plannedPublicationSeconds).toBe(417 * 30);
    expect(() => assertCratesIoVersionCapacity(approved)).not.toThrow();

    const tooLate = assessCratesIoVersionCapacity({
      inventory,
      configuredCapacity: "417",
      deadlineEpochSeconds: 13_000,
      nowEpochSeconds: 1_000,
    });
    expect(tooLate.allowed).toBe(false);
    expect(() => assertCratesIoVersionCapacity(tooLate)).toThrow(/at least 3h 29m is required/u);
  });

  test("normal publication rejects missing crate names even with ample update capacity", () => {
    const assessment = assessCratesIoVersionCapacity({
      inventory: {
        selectedIdentities: [{ name: "not-created", version: "0.1.0" }],
        publishedIdentities: [],
        pendingVersions: [],
        missingNames: ["not-created"],
      },
      configuredCapacity: "417",
      deadlineEpochSeconds: 20_800,
      nowEpochSeconds: 1_000,
    });
    expect(() => assertCratesIoVersionCapacity(assessment)).toThrow(/identity bootstrap first/u);
    expect(() => parseCratesIoVersionRunCapacity("unlimited")).toThrow(/non-negative integer/u);
  });
});
