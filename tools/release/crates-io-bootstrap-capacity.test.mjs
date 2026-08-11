import { describe, expect, test } from "bun:test";

import {
  CRATES_IO_DEFAULT_NEW_CRATE_BURST,
  CRATES_IO_NEW_CRATE_REFILL_SECONDS,
  CRATES_IO_READ_START_INTERVAL_MILLISECONDS,
  REGISTRY_BOOTSTRAP_DEFAULT_CARGO_SECONDS_PER_CARRIER,
  REGISTRY_BOOTSTRAP_DEFAULT_NPM_SECONDS_PER_CARRIER,
  REGISTRY_BOOTSTRAP_DEFAULT_RECONCILIATION_SECONDS_PER_CARRIER,
  REGISTRY_BOOTSTRAP_DEFAULT_RESERVE_SECONDS,
  assessCratesIoBootstrapCapacity,
  assertCratesIoBootstrapCapacity,
  cratesIoCapacitySummary,
  cratesIoTokenBucketSchedule,
  createCratesIoReadGate,
  inspectCratesIoBootstrapNames,
  inspectCratesIoVersionState,
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
  test("shares one paced read-start and Retry-After barrier across concurrent workers", async () => {
    let now = 1_000;
    const sleeps = [];
    const starts = [];
    const gate = createCratesIoReadGate({
      nowImpl: () => now,
      sleepImpl: async (milliseconds) => {
        sleeps.push(milliseconds);
        now += milliseconds / 1000;
      },
    });

    await Promise.all(["first", "second", "third"].map(async (label) => {
      starts.push(await gate.beforeRequest(label, 2_000));
    }));
    gate.defer(2);
    await Promise.all(["after-limit-1", "after-limit-2"].map(async (label) => {
      starts.push(await gate.beforeRequest(label, 2_000));
    }));

    expect(starts).toEqual([1_000, 1_000.25, 1_000.5, 1_002.5, 1_002.75]);
    expect(sleeps).toEqual([
      CRATES_IO_READ_START_INTERVAL_MILLISECONDS,
      CRATES_IO_READ_START_INTERVAL_MILLISECONDS,
      2_000,
      CRATES_IO_READ_START_INTERVAL_MILLISECONDS,
    ]);
  });

  test("admits a dependency-closed first bootstrap batch without pretending 193 Cargo names fit one runner", () => {
    const cargo = Array.from({ length: 193 }, (_, index) => ({ name: `crate-${index}`, version: "0.1.0" }));
    const npm = Array.from({ length: 59 }, (_, index) => ({ name: `@oliphaunt/pkg-${index}`, version: "0.1.0" }));
    const bootstrapPlan = [
      ...cargo.map((identity, publishOrder) => ({
        id: `cargo:${identity.name}`,
        product: "fixture",
        ecosystem: "cargo",
        ...identity,
        publishOrder,
        dependencies: [],
      })),
      ...npm.map((identity, index) => ({
        id: `npm:${identity.name}`,
        product: "fixture",
        ecosystem: "npm",
        ...identity,
        publishOrder: cargo.length + index,
        dependencies: [],
      })),
    ];
    const assessment = assessCratesIoBootstrapCapacity({
      inventory: {
        selectedIdentities: cargo,
        publishedIdentities: [],
        pendingVersions: [],
        missingNames: cargo.map(({ name }) => name),
      },
      npmInventory: {
        selectedIdentities: npm,
        publishedIdentities: [],
        pendingVersions: [],
        missingNames: npm.map(({ name }) => name),
      },
      bootstrapPlan,
      deadlineEpochSeconds: 20_800,
      nowEpochSeconds: 1_000,
    });

    expect(assessment.pendingCargoCount).toBe(193);
    expect(assessment.pendingNpmCount).toBe(59);
    expect(assessment.plannedPublicationSeconds).toBe(
      (193 * REGISTRY_BOOTSTRAP_DEFAULT_CARGO_SECONDS_PER_CARRIER)
        + (59 * REGISTRY_BOOTSTRAP_DEFAULT_NPM_SECONDS_PER_CARRIER),
    );
    expect(assessment.tokenBucketPublicationSeconds).toBe(112_830);
    expect(assessment.admittedCargoCount).toBe(36);
    expect(assessment.admittedNpmCount).toBe(59);
    expect(assessment.admittedCount).toBe(95);
    expect(assessment.remainingMutationCount).toBe(157);
    expect(assessment.plannedPublicationCriticalPathSeconds).toBe(18_630);
    expect(assessment.reserveSeconds).toBe(REGISTRY_BOOTSTRAP_DEFAULT_RESERVE_SECONDS);
    expect(assessment.minimumMutationWindowSeconds).toBe(19_230);
    expect(assessment.planningHeadroomSeconds).toBe(570);
    expect(assessment.allowed).toBe(true);
    expect(assessment.completeAfterExecution).toBe(false);
    expect(cratesIoCapacitySummary(assessment)).toContain("calibrated admission estimate");

    const tooShortToMakeProgress = assessCratesIoBootstrapCapacity({
      inventory: {
        selectedIdentities: cargo,
        publishedIdentities: [],
        pendingVersions: [],
        missingNames: cargo.map(({ name }) => name),
      },
      npmInventory: {
        selectedIdentities: npm,
        publishedIdentities: [],
        pendingVersions: [],
        missingNames: npm.map(({ name }) => name),
      },
      bootstrapPlan,
      deadlineEpochSeconds: 1_899,
      nowEpochSeconds: 1_000,
    });
    expect(tooShortToMakeProgress.decision).toBe("defer");
    expect(tooShortToMakeProgress.admittedCount).toBe(0);
    expect(() => assertCratesIoBootstrapCapacity(tooShortToMakeProgress)).not.toThrow();
  });

  test("resume inventory removes already-public exact versions from the time requirement", () => {
    const cargo = Array.from({ length: 4 }, (_, index) => ({ name: `crate-${index}`, version: "0.1.0" }));
    const npm = Array.from({ length: 3 }, (_, index) => ({ name: `@oliphaunt/pkg-${index}`, version: "0.1.0" }));
    const assessment = assessCratesIoBootstrapCapacity({
      inventory: {
        selectedIdentities: cargo,
        publishedIdentities: cargo.slice(0, 3),
        pendingVersions: [],
        missingNames: [cargo[3].name],
      },
      npmInventory: {
        selectedIdentities: npm,
        publishedIdentities: npm.slice(0, 2),
        pendingVersions: [],
        missingNames: [npm[2].name],
      },
      cargoSecondsPerCarrier: "45",
      npmSecondsPerCarrier: "60",
      reserveSeconds: "600",
      deadlineEpochSeconds: 1_900,
      nowEpochSeconds: 1_000,
    });

    expect(assessment.pendingCargoCount).toBe(1);
    expect(assessment.pendingNpmCount).toBe(1);
    expect(assessment.plannedPublicationSeconds).toBe(105);
    expect(assessment.minimumMutationWindowSeconds).toBe(900);
    expect(assessment.allowed).toBe(true);
  });

  test("bootstrap capacity adds cross-registry dependencies to its two-lane critical path", () => {
    const cargo = { name: "input", version: "0.1.0" };
    const npm = { name: "@example/output", version: "0.1.0" };
    const cargoCarrier = {
      id: "cargo:input",
      product: "fixture",
      ecosystem: "cargo",
      ...cargo,
      publishOrder: 0,
      dependencies: [],
    };
    const npmCarrier = {
      id: "npm:@example/output",
      product: "fixture",
      ecosystem: "npm",
      ...npm,
      publishOrder: 1,
      dependencies: [cargoCarrier.id],
    };
    const assessment = assessCratesIoBootstrapCapacity({
      inventory: {
        selectedIdentities: [cargo],
        publishedIdentities: [],
        pendingVersions: [],
        missingNames: [cargo.name],
      },
      npmInventory: {
        selectedIdentities: [npm],
        publishedIdentities: [],
        pendingVersions: [],
        missingNames: [npm.name],
      },
      bootstrapPlan: [cargoCarrier, npmCarrier],
      deadlineEpochSeconds: 2_000,
      nowEpochSeconds: 1_000,
    });
    expect(assessment.plannedPublicationSeconds).toBe(60);
    expect(assessment.plannedPublicationCriticalPathSeconds).toBe(60);
    const independent = assessCratesIoBootstrapCapacity({
      inventory: {
        selectedIdentities: [cargo],
        publishedIdentities: [],
        pendingVersions: [],
        missingNames: [cargo.name],
      },
      npmInventory: {
        selectedIdentities: [npm],
        publishedIdentities: [],
        pendingVersions: [],
        missingNames: [npm.name],
      },
      bootstrapPlan: [cargoCarrier, { ...npmCarrier, dependencies: [] }],
      deadlineEpochSeconds: 2_000,
      nowEpochSeconds: 1_000,
    });
    expect(independent.plannedPublicationCriticalPathSeconds).toBe(30);
  });

  test("skips an over-budget dependency chain while admitting later independent work", () => {
    const publicCargo = { name: "already-public", version: "0.1.0" };
    const pendingCargo = { name: "needs-token", version: "0.1.0" };
    const dependentNpm = { name: "@example/dependent", version: "0.1.0" };
    const independentNpm = { name: "@example/independent", version: "0.1.0" };
    const bootstrapPlan = [
      {
        id: `cargo:${publicCargo.name}`,
        product: "fixture",
        ecosystem: "cargo",
        ...publicCargo,
        publishOrder: 0,
        dependencies: [],
      },
      {
        id: `cargo:${pendingCargo.name}`,
        product: "fixture",
        ecosystem: "cargo",
        ...pendingCargo,
        publishOrder: 1,
        dependencies: [],
      },
      {
        id: `npm:${dependentNpm.name}`,
        product: "fixture",
        ecosystem: "npm",
        ...dependentNpm,
        publishOrder: 2,
        dependencies: [`cargo:${pendingCargo.name}`],
      },
      {
        id: `npm:${independentNpm.name}`,
        product: "fixture",
        ecosystem: "npm",
        ...independentNpm,
        publishOrder: 3,
        dependencies: [],
      },
    ];
    const assessment = assessCratesIoBootstrapCapacity({
      inventory: {
        selectedIdentities: [publicCargo, pendingCargo],
        publishedIdentities: [publicCargo],
        pendingVersions: [],
        missingNames: [pendingCargo.name],
      },
      npmInventory: {
        selectedIdentities: [dependentNpm, independentNpm],
        publishedIdentities: [],
        pendingVersions: [],
        missingNames: [dependentNpm.name, independentNpm.name],
      },
      bootstrapPlan,
      deadlineEpochSeconds: 1_900,
      nowEpochSeconds: 1_000,
    });
    expect(assessment.initialCargoTokens).toBe(0);
    expect(assessment.admittedCarrierIds).toEqual([`npm:${independentNpm.name}`]);
    expect(assessment.remainingMutationCount).toBe(2);
    expect(assessment.decision).toBe("execute");
  });

  test("accounts for concurrent integrity reconciliation on a 630/631 resume", () => {
    const cargo = Array.from({ length: 417 }, (_, index) => ({ name: `crate-${index}`, version: "0.1.0" }));
    const npm = Array.from({ length: 214 }, (_, index) => ({ name: `@oliphaunt/pkg-${index}`, version: "0.1.0" }));
    const assessment = assessCratesIoBootstrapCapacity({
      inventory: {
        selectedIdentities: cargo,
        publishedIdentities: cargo.slice(0, 416),
        pendingVersions: [],
        missingNames: [cargo[416].name],
      },
      npmInventory: {
        selectedIdentities: npm,
        publishedIdentities: npm,
        pendingVersions: [],
        missingNames: [],
      },
      deadlineEpochSeconds: 6_010,
      nowEpochSeconds: 1_000,
    });

    expect(assessment.reconciliationCount).toBe(630);
    expect(assessment.plannedReconciliationSeconds).toBe(
      630 * REGISTRY_BOOTSTRAP_DEFAULT_RECONCILIATION_SECONDS_PER_CARRIER,
    );
    expect(assessment.plannedPublicationSeconds).toBe(30);
    expect(assessment.minimumMutationWindowSeconds).toBe(5_010);
    expect(assessment.allowed).toBe(true);

    const oneSecondShort = assessCratesIoBootstrapCapacity({
      inventory: {
        selectedIdentities: cargo,
        publishedIdentities: cargo.slice(0, 416),
        pendingVersions: [],
        missingNames: [cargo[416].name],
      },
      npmInventory: {
        selectedIdentities: npm,
        publishedIdentities: npm,
        pendingVersions: [],
        missingNames: [],
      },
      deadlineEpochSeconds: 6_009,
      nowEpochSeconds: 1_000,
    });
    expect(oneSecondShort.decision).toBe("defer");
    expect(oneSecondShort.admittedCargoCount).toBe(0);
    expect(() => assertCratesIoBootstrapCapacity(oneSecondShort)).not.toThrow();
  });

  test("rejects later-version misuse in either immutable-name registry", () => {
    const cargoIdentity = { name: "already-cargo", version: "2.0.0" };
    const npmIdentity = { name: "@oliphaunt/already-npm", version: "2.0.0" };
    const assessment = assessCratesIoBootstrapCapacity({
      inventory: {
        selectedIdentities: [cargoIdentity],
        publishedIdentities: [],
        pendingVersions: [cargoIdentity],
        missingNames: [],
      },
      npmInventory: {
        selectedIdentities: [npmIdentity],
        publishedIdentities: [],
        pendingVersions: [npmIdentity],
        missingNames: [],
      },
      deadlineEpochSeconds: 10_000,
      nowEpochSeconds: 1_000,
    });
    expect(assessment.identityCreationOnlySatisfied).toBe(false);
    expect(assessment.plannedPublicationSeconds).toBe(0);
    expect(() => assertCratesIoBootstrapCapacity(assessment)).toThrow(/first-version creation only.*1 Cargo.*1 npm/u);
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

  test("uses the official token bucket and ignores unverifiable numeric capacity assertions", () => {
    const inventory = {
      selectedNames: Array.from({ length: 193 }, (_, index) => `crate-${index}`),
      existingNames: [],
      missingNames: Array.from({ length: 193 }, (_, index) => `crate-${index}`),
    };
    const defaultAssessment = assessCratesIoBootstrapCapacity({
      inventory,
      deadlineEpochSeconds: 20_800,
      nowEpochSeconds: 1_000,
    });
    expect(defaultAssessment.initialCargoTokens).toBe(CRATES_IO_DEFAULT_NEW_CRATE_BURST);
    expect(defaultAssessment.tokenBucketPublicationSeconds).toBe(112_830);
    expect(defaultAssessment.admittedCargoCount).toBe(36);
    expect(defaultAssessment.allowed).toBe(true);
    expect(() => assertCratesIoBootstrapCapacity(defaultAssessment)).not.toThrow();
    expect(cratesIoCapacitySummary(defaultAssessment)).toContain("31h 21m");

    const attemptedOverride = assessCratesIoBootstrapCapacity({
      inventory,
      configuredCapacity: "99999",
      deadlineEpochSeconds: 20_800,
      nowEpochSeconds: 1_000,
    });
    expect(attemptedOverride).toEqual(defaultAssessment);
  });

  test("fails malformed timing and duplicate contracts, and types a late admission as defer", async () => {
    expect(() => assessCratesIoBootstrapCapacity({
      inventory: { selectedNames: ["new"], existingNames: [], missingNames: ["new"] },
      cargoSecondsPerCarrier: "29",
      deadlineEpochSeconds: 10_000,
      nowEpochSeconds: 1_000,
    })).toThrow(/CARGO_SECONDS_PER_CARRIER must be at least 30/u);
    expect(() => assessCratesIoBootstrapCapacity({
      inventory: { selectedNames: ["new"], existingNames: [], missingNames: ["new"] },
      reserveSeconds: "599",
      deadlineEpochSeconds: 10_000,
      nowEpochSeconds: 1_000,
    })).toThrow(/RESERVE_SECONDS must be at least 600/u);
    await expect(inspectCratesIoBootstrapNames({
      plan: cargoPlan(["same", "same"]),
      deadlineEpochSeconds: 10_000,
      nowImpl: () => 1_000,
      fetchImpl: async () => new Response("", { status: 404 }),
    })).rejects.toThrow(/duplicate Cargo package names/u);

    const late = assessCratesIoBootstrapCapacity({
      inventory: { selectedNames: ["new"], existingNames: [], missingNames: ["new"] },
      deadlineEpochSeconds: 1_500,
      nowEpochSeconds: 1_000,
    });
    expect(late.decision).toBe("defer");
    expect(late.notBeforeEpochSeconds).toBe(1_600);
    expect(() => assertCratesIoBootstrapCapacity(late)).not.toThrow();
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

    let rateLimitedCalls = 0;
    let rateLimitedNow = 1_000;
    const rateLimitedSleeps = [];
    const rateLimitedInventory = await inspectCratesIoBootstrapNames({
      plan: cargoPlan(["later"]),
      deadlineEpochSeconds: 10_000,
      nowImpl: () => rateLimitedNow,
      sleepImpl: async (milliseconds) => {
        rateLimitedSleeps.push(milliseconds);
        rateLimitedNow += milliseconds / 1000;
      },
      fetchImpl: async () => {
        rateLimitedCalls += 1;
        return rateLimitedCalls === 1
          ? new Response("", { status: 429, headers: { "Retry-After": "60" } })
          : new Response("", { status: 404 });
      },
    });
    expect(rateLimitedInventory.missingNames).toEqual(["later"]);
    expect(rateLimitedSleeps).toEqual([60_000]);

    await expect(inspectCratesIoBootstrapNames({
      plan: cargoPlan(["too-late"]),
      deadlineEpochSeconds: 10_000,
      nowImpl: () => 1_000,
      fetchImpl: async () => new Response("", { status: 429, headers: { "Retry-After": "181" } }),
    })).rejects.toThrow(/bounded 180s retry-delay budget/u);

    let sustainedCalls = 0;
    let sustainedNow = 1_000;
    const sustainedSleeps = [];
    await expect(inspectCratesIoBootstrapNames({
      plan: cargoPlan(["sustained"]),
      deadlineEpochSeconds: 10_000,
      nowImpl: () => sustainedNow,
      sleepImpl: async (milliseconds) => {
        sustainedSleeps.push(milliseconds);
        sustainedNow += milliseconds / 1000;
      },
      fetchImpl: async () => {
        sustainedCalls += 1;
        return new Response("", { status: 429 });
      },
    })).rejects.toThrow(/bounded 180s retry-delay budget/u);
    expect(sustainedCalls).toBe(3);
    expect(sustainedSleeps).toEqual([60_000, 120_000]);

    let deadlineCalls = 0;
    await expect(inspectCratesIoBootstrapNames({
      plan: cargoPlan(["deadline-clamped"]),
      deadlineEpochSeconds: 1_005,
      nowImpl: () => 1_000,
      fetchImpl: async () => {
        deadlineCalls += 1;
        return new Response("", { status: 404 });
      },
    })).rejects.toThrow(/cannot start before the registry mutation deadline/u);
    expect(deadlineCalls).toBe(0);

    const deadlineSleeps = [];
    await expect(inspectCratesIoBootstrapNames({
      plan: cargoPlan(["retry-crosses-deadline"]),
      deadlineEpochSeconds: 1_007,
      nowImpl: () => 1_000,
      sleepImpl: async (milliseconds) => deadlineSleeps.push(milliseconds),
      fetchImpl: async () => new Response("", { status: 503, headers: { "Retry-After": "2" } }),
    })).rejects.toThrow(/cannot retry before the registry mutation deadline/u);
    expect(deadlineSleeps).toEqual([]);
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
});
