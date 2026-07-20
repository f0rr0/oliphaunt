import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
  CRATES_IO_DEFAULT_NEW_CRATE_BURST,
  CRATES_IO_DEFAULT_VERSION_BURST,
  CRATES_IO_NEW_CRATE_REFILL_SECONDS,
  REGISTRY_BOOTSTRAP_DEFAULT_CARGO_SECONDS_PER_CARRIER,
  REGISTRY_BOOTSTRAP_DEFAULT_NPM_SECONDS_PER_CARRIER,
  REGISTRY_BOOTSTRAP_DEFAULT_RECONCILIATION_SECONDS_PER_CARRIER,
  REGISTRY_BOOTSTRAP_DEFAULT_RESERVE_SECONDS,
  CRATES_IO_VERSION_REFILL_SECONDS,
  NORMAL_REGISTRY_NPM_SECONDS_PER_CARRIER,
  assessCratesIoBootstrapCapacity,
  assessCratesIoVersionCapacity,
  assertCratesIoBootstrapCapacity,
  assertCratesIoVersionCapacity,
  cratesIoCapacitySummary,
  cratesIoVersionCapacitySummary,
  cratesIoTokenBucketSchedule,
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
  test("normal capacity preflight inventories every mutable registry surface and reuses complete ledger receipts", () => {
    const source = readFileSync(
      new URL("../../.github/scripts/check-crates-io-publish-capacity.mjs", import.meta.url),
      "utf8",
    );
    expect(source).toContain("inspectCratesIoVersionState");
    expect(source).toContain("inspectNpmVersionState");
    expect(source).toContain("loadBootstrapLedger");
    expect(source).toContain("normalPlan,");
    expect(source).toContain("reconciledCarrierIds: [...receiptIds]");
  });

  test("runs the capacity inventory before the genesis checkpoint and all registry mutations", () => {
    const source = readFileSync(
      new URL("../../.github/scripts/bootstrap-registry-identities.mjs", import.meta.url),
      "utf8",
    );
    const inventory = source.indexOf("[cargoInventory, npmInventory] = await Promise.all");
    const npmInventory = source.indexOf("inspectNpmVersionState({ plan, deadlineEpochSeconds })");
    const assertion = source.indexOf("assertCratesIoBootstrapCapacity(capacityAssessment)");
    const ledgerLoad = source.indexOf("checkpoint = loadBootstrapLedger");
    const publicProof = source.indexOf("publicReceipts = await verifyLockedRegistryIntegrity");
    const genesis = source.indexOf("appendBootstrapCheckpoint(bootstrapLedger, lock, products, [])");
    const missingOnly = source.indexOf("executeBootstrapPublicationPlan({");
    const publication = source.indexOf('"tools/release/release-publish.mjs"');
    expect(inventory).toBeGreaterThan(0);
    expect(npmInventory).toBeGreaterThan(inventory);
    expect(npmInventory).toBeLessThan(assertion);
    expect(inventory).toBeLessThan(assertion);
    expect(assertion).toBeLessThan(ledgerLoad);
    expect(ledgerLoad).toBeLessThan(publicProof);
    expect(publicProof).toBeLessThan(genesis);
    expect(assertion).toBeLessThan(genesis);
    expect(genesis).toBeLessThan(missingOnly);
    expect(publication).toBeLessThan(missingOnly);
    expect(genesis).toBeLessThan(publication);
  });

  test("starts mutation clocks only after qualification, dry-runs, and lock matching", () => {
    const workflow = readFileSync(
      new URL("../../.github/workflows/release-execute.yml", import.meta.url),
      "utf8",
    );
    const qualification = workflow.indexOf("Require qualified release-commit CI run");
    const dryRuns = workflow.indexOf("Validate selected release product dry-runs");
    const lockMatch = workflow.indexOf("Match prior approved publication lock");
    const earlyCapacity = workflow.indexOf("Preflight normal all-registry publication capacity");
    const releaseRevalidate = workflow.indexOf("Revalidate current main immediately before release mutation");
    const registryRevalidate = workflow.indexOf("Revalidate current main immediately before registry mutation");
    const normalDeadline = workflow.indexOf("Start authoritative bounded normal registry mutation window");
    const finalCapacity = workflow.indexOf("Reprove all-registry publication capacity immediately before registry mutation");
    const registryMutation = workflow.indexOf("Publish exact-lock registry topology");
    const bootstrapDeadline = workflow.indexOf("Start bounded bootstrap mutation window");
    const bootstrapAuth = workflow.indexOf("Configure npm identity-bootstrap authentication");
    const bootstrapMutation = workflow.indexOf("Bootstrap missing Cargo and npm identities");
    expect(qualification).toBeGreaterThan(0);
    expect(qualification).toBeLessThan(dryRuns);
    expect(dryRuns).toBeLessThan(lockMatch);
    expect(lockMatch).toBeLessThan(earlyCapacity);
    expect(earlyCapacity).toBeLessThan(releaseRevalidate);
    expect(releaseRevalidate).toBeLessThan(registryRevalidate);
    expect(registryRevalidate).toBeLessThan(normalDeadline);
    expect(finalCapacity).toBeLessThan(normalDeadline);
    expect(normalDeadline).toBeLessThan(registryMutation);
    expect(registryMutation).toBeLessThan(bootstrapDeadline);
    expect(bootstrapDeadline).toBeLessThan(bootstrapAuth);
    expect(bootstrapAuth).toBeLessThan(bootstrapMutation);
    expect(workflow).toContain("qualification_timeout=0");
    expect(workflow).toContain("vars.REGISTRY_BOOTSTRAP_CARGO_SECONDS_PER_CARRIER || '30'");
    expect(workflow).toContain("vars.REGISTRY_BOOTSTRAP_NPM_SECONDS_PER_CARRIER || '30'");
    expect(workflow).toContain("vars.REGISTRY_BOOTSTRAP_RECONCILIATION_SECONDS_PER_CARRIER || '6'");
    expect(workflow).toContain("vars.REGISTRY_BOOTSTRAP_RESERVE_SECONDS || '600'");
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

    await expect(inspectCratesIoBootstrapNames({
      plan: cargoPlan(["later"]),
      deadlineEpochSeconds: 10_000,
      nowImpl: () => 1_000,
      fetchImpl: async () => new Response("", { status: 429, headers: { "Retry-After": "60" } }),
    })).rejects.toThrow(/retry the release later/u);

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

  test("overlaps version-bucket refill with work and admits the exact 193-carrier graph in 190 minutes", () => {
    expect(cratesIoTokenBucketSchedule({
      publicationCount: 6,
      burst: 5,
      refillSeconds: 60,
      workSeconds: 1,
    }).startSeconds).toEqual([0, 1, 2, 3, 4, 60]);
    expect(cratesIoTokenBucketSchedule({
      publicationCount: 197,
      burst: CRATES_IO_DEFAULT_VERSION_BURST,
      refillSeconds: CRATES_IO_VERSION_REFILL_SECONDS,
      workSeconds: 30,
    })).toMatchObject({
      elapsedSeconds: 10_050,
      waitSeconds: 4_140,
      workSeconds: 5_910,
    });
    const identities = Array.from({ length: 193 }, (_, index) => ({ name: `crate-${index}`, version: "1.0.0" }));
    const inventory = {
      selectedIdentities: identities,
      publishedIdentities: [],
      pendingVersions: identities,
      missingNames: [],
    };
    const assessment = assessCratesIoVersionCapacity({
      inventory,
      deadlineEpochSeconds: 12_400,
      nowEpochSeconds: 1_000,
    });
    expect(assessment.tokenBucketPublicationSeconds).toBe(9_810);
    expect(assessment.plannedExecutorSeconds).toBe(10_410);
    expect(assessment.remainingSeconds).toBe(11_400);
    expect(assessment.decision).toBe("execute");
    expect(() => assertCratesIoVersionCapacity(assessment)).not.toThrow();

    const ordinary = assessCratesIoVersionCapacity({
      inventory: {
        selectedIdentities: identities.slice(0, CRATES_IO_DEFAULT_VERSION_BURST),
        publishedIdentities: [],
        pendingVersions: identities.slice(0, CRATES_IO_DEFAULT_VERSION_BURST),
        missingNames: [],
      },
      deadlineEpochSeconds: 20_800,
      nowEpochSeconds: 1_000,
    });
    expect(ordinary.allowed).toBe(true);
    expect(() => assertCratesIoVersionCapacity(ordinary)).not.toThrow();

    const attemptedOverride = assessCratesIoVersionCapacity({
      inventory,
      configuredCapacity: "99999",
      deadlineEpochSeconds: 12_400,
      nowEpochSeconds: 1_000,
    });
    expect(attemptedOverride).toEqual(assessment);

    const oneSecondShort = assessCratesIoVersionCapacity({
      inventory,
      deadlineEpochSeconds: 11_409,
      nowEpochSeconds: 1_000,
    });
    expect(oneSecondShort.decision).toBe("defer");
    expect(oneSecondShort.notBeforeEpochSeconds).toBe(1_060);
    expect(() => assertCratesIoVersionCapacity(oneSecondShort)).not.toThrow();
  });

  test("budgets concurrent registry lanes, uncovered reconciliation, and executor reserve", () => {
    const assessment = assessCratesIoVersionCapacity({
      inventory: {
        selectedIdentities: [
          { name: "cargo-public", version: "1.0.0" },
          { name: "cargo-pending", version: "1.0.0" },
        ],
        publishedIdentities: [{ name: "cargo-public", version: "1.0.0" }],
        pendingVersions: [{ name: "cargo-pending", version: "1.0.0" }],
        missingNames: [],
      },
      npmInventory: {
        selectedIdentities: [
          { name: "@example/public", version: "1.0.0" },
          { name: "@example/pending", version: "1.0.0" },
        ],
        publishedIdentities: [{ name: "@example/public", version: "1.0.0" }],
        pendingVersions: [{ name: "@example/pending", version: "1.0.0" }],
        missingNames: [],
      },
      mavenOperationCount: 1,
      jsrCarrierCount: 1,
      reconciledCargoCount: 1,
      reconciledNpmCount: 0,
      deadlineEpochSeconds: 10_000,
      nowEpochSeconds: 1_000,
    });
    expect(assessment.plannedPublicationSeconds).toBe(30);
    expect(assessment.plannedNpmPublicationSeconds).toBe(300);
    expect(assessment.plannedMavenSeconds).toBe(2_100);
    expect(assessment.plannedJsrSeconds).toBe(300);
    expect(assessment.publicReconciliationCount).toBe(1);
    expect(assessment.plannedReconciliationSeconds).toBe(6);
    expect(assessment.plannedExecutorCriticalPathSeconds).toBe(2_100);
    expect(assessment.plannedExecutorSeconds).toBe(2_700);
    expect(assessment.minimumMutationWindowSeconds).toBe(2_700);
    expect(assessment.allowed).toBe(true);
    expect(cratesIoVersionCapacitySummary(assessment)).toContain("Normal all-registry token-bucket admission");
    expect(cratesIoVersionCapacitySummary(assessment)).toContain("Admitted-subset parallel lane/DAG critical path");
    expect(cratesIoVersionCapacitySummary(assessment)).toContain("calibrated admission estimate");
  });

  test("admits the exact 193-Cargo later-release graph inside the 11,400-second mutation window", () => {
    const cargo = Array.from({ length: 193 }, (_, index) => ({ name: `crate-${index}`, version: "2.0.0" }));
    const npm = Array.from({ length: 59 }, (_, index) => ({ name: `@oliphaunt/pkg-${index}`, version: "2.0.0" }));
    const operations = [];
    for (const identity of cargo) {
      operations.push({
        id: `carrier:cargo:${identity.name}`,
        kind: "carrier",
        ecosystem: "cargo",
        carrierId: `cargo:${identity.name}`,
        dependencies: [],
        operationOrder: operations.length,
      });
    }
    for (const identity of npm) {
      operations.push({
        id: `carrier:npm:${identity.name}`,
        kind: "carrier",
        ecosystem: "npm",
        carrierId: `npm:${identity.name}`,
        dependencies: [],
        operationOrder: operations.length,
      });
    }
    operations.push({
      id: "maven:atomic-deployment",
      kind: "maven-atomic-deployment",
      ecosystem: "maven",
      carrierIds: ["maven:dev.oliphaunt:runtime"],
      dependencies: [],
      operationOrder: operations.length,
    });
    operations.push({
      id: "carrier:jsr:@oliphaunt/ts",
      kind: "carrier",
      ecosystem: "jsr",
      carrierId: "jsr:@oliphaunt/ts",
      dependencies: [],
      operationOrder: operations.length,
    });
    const assessment = assessCratesIoVersionCapacity({
      inventory: {
        selectedIdentities: cargo,
        publishedIdentities: [],
        pendingVersions: cargo,
        missingNames: [],
      },
      npmInventory: {
        selectedIdentities: npm,
        publishedIdentities: [],
        pendingVersions: npm,
        missingNames: [],
      },
      normalPlan: { operations },
      reconciledCarrierIds: [],
      deadlineEpochSeconds: 12_400,
      nowEpochSeconds: 1_000,
    });
    expect(assessment.plannedPublicationSeconds).toBe(5_790);
    expect(assessment.plannedNpmPublicationSeconds).toBe(17_700);
    expect(assessment.fullRemainingCriticalPathSeconds).toBe(17_700);
    expect(assessment.plannedExecutorCriticalPathSeconds).toBe(10_800);
    expect(assessment.plannedExecutorSeconds).toBe(11_400);
    expect(assessment.minimumMutationWindowSeconds).toBe(11_400);
    expect(assessment.admittedCargoOperationCount).toBe(193);
    expect(assessment.admittedNpmOperationCount).toBe(36);
    expect(assessment.unadmittedOperationCount).toBe(23);
    expect(assessment.publicationCompleteAfterAdmission).toBe(false);
    expect(assessment.remainingSeconds).toBe(11_400);
    expect(assessment.allowed).toBe(true);
    expect(() => assertCratesIoVersionCapacity(assessment)).not.toThrow();
  });

  test("splits 59 npm later versions into a finite dependency-closed 36/23 continuation", () => {
    const identities = Array.from(
      { length: 59 },
      (_, index) => ({ name: `@oliphaunt/npm-${index}`, version: "2.0.0" }),
    );
    const operations = identities.map((identity, operationOrder) => ({
      id: `carrier:npm:${identity.name}`,
      kind: "carrier",
      ecosystem: "npm",
      carrierId: `npm:${identity.name}`,
      dependencies: [],
      operationOrder,
    }));
    const emptyCargo = {
      selectedIdentities: [],
      publishedIdentities: [],
      pendingVersions: [],
      missingNames: [],
    };
    const first = assessCratesIoVersionCapacity({
      inventory: emptyCargo,
      npmInventory: {
        selectedIdentities: identities,
        publishedIdentities: [],
        pendingVersions: identities,
        missingNames: [],
      },
      normalPlan: { operations },
      reconciledCarrierIds: [],
      completedOperationIds: [],
      authoritativeWindowSeconds: 11_400,
      deadlineEpochSeconds: 12_400,
      nowEpochSeconds: 1_000,
    });
    expect(NORMAL_REGISTRY_NPM_SECONDS_PER_CARRIER).toBe(300);
    expect(first.admittedOperationIds).toEqual(operations.slice(0, 36).map(({ id }) => id));
    expect(first.unadmittedOperationIds).toEqual(operations.slice(36).map(({ id }) => id));
    expect(first.minimumMutationWindowSeconds).toBe(11_400);
    expect(first.publicationCompleteAfterAdmission).toBe(false);

    const published = identities.slice(0, 36);
    const pending = identities.slice(36);
    const second = assessCratesIoVersionCapacity({
      inventory: emptyCargo,
      npmInventory: {
        selectedIdentities: identities,
        publishedIdentities: published,
        pendingVersions: pending,
        missingNames: [],
      },
      normalPlan: { operations },
      reconciledCarrierIds: [],
      completedOperationIds: operations.slice(0, 36).map(({ id }) => id),
      authoritativeWindowSeconds: 11_400,
      deadlineEpochSeconds: 13_400,
      nowEpochSeconds: 2_000,
    });
    expect(second.admittedOperationIds).toEqual(operations.slice(36).map(({ id }) => id));
    expect(second.unadmittedOperationIds).toEqual([]);
    expect(second.minimumMutationWindowSeconds).toBe(7_500);
    expect(second.publicationCompleteAfterAdmission).toBe(true);

    const complete = assessCratesIoVersionCapacity({
      inventory: emptyCargo,
      npmInventory: {
        selectedIdentities: identities,
        publishedIdentities: identities,
        pendingVersions: [],
        missingNames: [],
      },
      normalPlan: { operations },
      reconciledCarrierIds: [],
      completedOperationIds: operations.map(({ id }) => id),
      authoritativeWindowSeconds: 11_400,
      deadlineEpochSeconds: 14_400,
      nowEpochSeconds: 3_000,
    });
    expect(complete).toMatchObject({
      admittedOperationIds: [],
      unadmittedOperationIds: [],
      decision: "execute",
      minimumMutationWindowSeconds: 1,
      publicationCompleteAfterAdmission: true,
    });
  });

  test("admits bootstrap-proven first-release identities and completes an exact checkpoint rerun without mutation floor", () => {
    const cargoIdentity = { name: "first-cargo", version: "0.1.0" };
    const npmIdentity = { name: "@example/first", version: "0.1.0" };
    const operations = [
      {
        id: "carrier:cargo:first-cargo",
        kind: "carrier",
        ecosystem: "cargo",
        carrierId: "cargo:first-cargo",
        dependencies: [],
        operationOrder: 0,
      },
      {
        id: "carrier:npm:@example/first",
        kind: "carrier",
        ecosystem: "npm",
        carrierId: "npm:@example/first",
        dependencies: [],
        operationOrder: 1,
      },
      {
        id: "maven:atomic-deployment",
        kind: "maven-atomic-deployment",
        ecosystem: "maven",
        carrierIds: ["maven:dev.example:first"],
        dependencies: [],
        operationOrder: 2,
      },
      {
        id: "carrier:jsr:@example/first",
        kind: "carrier",
        ecosystem: "jsr",
        carrierId: "jsr:@example/first",
        dependencies: [],
        operationOrder: 3,
      },
    ];
    const inputs = {
      inventory: {
        selectedIdentities: [cargoIdentity],
        publishedIdentities: [cargoIdentity],
        pendingVersions: [],
        missingNames: [],
      },
      npmInventory: {
        selectedIdentities: [npmIdentity],
        publishedIdentities: [npmIdentity],
        pendingVersions: [],
        missingNames: [],
      },
      normalPlan: { operations },
      reconciledCarrierIds: ["cargo:first-cargo", "npm:@example/first"],
      authoritativeWindowSeconds: 11_400,
    };
    const first = assessCratesIoVersionCapacity({
      ...inputs,
      completedOperationIds: [],
      deadlineEpochSeconds: 12_400,
      nowEpochSeconds: 1_000,
    });
    expect(first.admittedOperationIds).toEqual(operations.map(({ id }) => id));
    expect(first.unadmittedOperationIds).toEqual([]);
    expect(first.minimumMutationWindowSeconds).toBe(2_700);

    const rerun = assessCratesIoVersionCapacity({
      ...inputs,
      completedOperationIds: operations.map(({ id }) => id),
      deadlineEpochSeconds: 2_001,
      nowEpochSeconds: 2_000,
    });
    expect(rerun).toMatchObject({
      admittedOperationIds: [],
      unadmittedOperationIds: [],
      decision: "execute",
      minimumMutationWindowSeconds: 1,
      plannedExecutorSeconds: 0,
      publicationCompleteAfterAdmission: true,
    });
  });

  test("completed cross-registry dependencies satisfy a later admitted atomic lane", () => {
    const cargoIdentity = { name: "input", version: "2.0.0" };
    const npmIdentity = { name: "@example/middle", version: "2.0.0" };
    const cargo = {
      id: "carrier:cargo:input",
      kind: "carrier",
      ecosystem: "cargo",
      carrierId: "cargo:input",
      dependencies: [],
      operationOrder: 0,
    };
    const npm = {
      id: "carrier:npm:@example/middle",
      kind: "carrier",
      ecosystem: "npm",
      carrierId: "npm:@example/middle",
      dependencies: [cargo.id],
      operationOrder: 1,
    };
    const maven = {
      id: "maven:atomic-deployment",
      kind: "maven-atomic-deployment",
      ecosystem: "maven",
      carrierIds: ["maven:dev.example:sdk"],
      dependencies: [npm.id],
      operationOrder: 2,
    };
    const jsr = {
      id: "carrier:jsr:@example/sdk",
      kind: "carrier",
      ecosystem: "jsr",
      carrierId: "jsr:@example/sdk",
      dependencies: [maven.id],
      operationOrder: 3,
    };
    const plan = { operations: [cargo, npm, maven, jsr] };
    const first = assessCratesIoVersionCapacity({
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
      normalPlan: plan,
      reconciledCarrierIds: [],
      completedOperationIds: [],
      authoritativeWindowSeconds: 3_000,
      deadlineEpochSeconds: 4_000,
      nowEpochSeconds: 1_000,
    });
    expect(first.admittedOperationIds).toEqual([cargo.id, npm.id]);
    expect(first.unadmittedOperationIds).toEqual([maven.id, jsr.id]);

    const second = assessCratesIoVersionCapacity({
      inventory: {
        selectedIdentities: [cargoIdentity],
        publishedIdentities: [cargoIdentity],
        pendingVersions: [],
        missingNames: [],
      },
      npmInventory: {
        selectedIdentities: [npmIdentity],
        publishedIdentities: [npmIdentity],
        pendingVersions: [],
        missingNames: [],
      },
      normalPlan: plan,
      reconciledCarrierIds: [],
      completedOperationIds: [cargo.id, npm.id],
      authoritativeWindowSeconds: 3_000,
      deadlineEpochSeconds: 5_000,
      nowEpochSeconds: 2_000,
    });
    expect(second.admittedOperationIds).toEqual([maven.id, jsr.id]);
    expect(second.unadmittedOperationIds).toEqual([]);
    expect(second.minimumMutationWindowSeconds).toBe(3_000);
  });

  test("hard-fails when the next dependency-eligible atomic operation cannot fit a fresh window", () => {
    expect(() => assessCratesIoVersionCapacity({
      inventory: {
        selectedIdentities: [],
        publishedIdentities: [],
        pendingVersions: [],
        missingNames: [],
      },
      normalPlan: {
        operations: [{
          id: "maven:atomic-deployment",
          kind: "maven-atomic-deployment",
          ecosystem: "maven",
          carrierIds: ["maven:dev.example:atomic"],
          dependencies: [],
          operationOrder: 0,
        }],
      },
      reconciledCarrierIds: [],
      completedOperationIds: [],
      authoritativeWindowSeconds: 2_000,
      deadlineEpochSeconds: 3_000,
      nowEpochSeconds: 1_000,
    })).toThrow(/maven:atomic-deployment atomic operation intrinsically requires 2700s.*authoritative fresh mutation window is only 2000s/u);
  });

  test("rejects a later intrinsically oversized atomic operation before admitting any earlier mutation", () => {
    const npmIdentity = { name: "@example/early", version: "1.0.0" };
    const npmOperation = {
      id: "carrier:npm:@example/early",
      kind: "carrier",
      ecosystem: "npm",
      carrierId: "npm:@example/early",
      dependencies: [],
      operationOrder: 0,
    };
    const mavenOperation = {
      id: "maven:atomic-deployment",
      kind: "maven-atomic-deployment",
      ecosystem: "maven",
      carrierIds: ["maven:dev.example:atomic"],
      dependencies: [npmOperation.id],
      operationOrder: 1,
    };
    expect(() => assessCratesIoVersionCapacity({
      inventory: {
        selectedIdentities: [],
        publishedIdentities: [],
        pendingVersions: [],
        missingNames: [],
      },
      npmInventory: {
        selectedIdentities: [npmIdentity],
        publishedIdentities: [],
        pendingVersions: [npmIdentity],
        missingNames: [],
      },
      normalPlan: { operations: [npmOperation, mavenOperation] },
      reconciledCarrierIds: [],
      completedOperationIds: [],
      authoritativeWindowSeconds: 2_000,
      deadlineEpochSeconds: 3_000,
      nowEpochSeconds: 1_000,
    })).toThrow(/maven:atomic-deployment atomic operation intrinsically requires 2700s.*authoritative fresh mutation window is only 2000s/u);
  });

  test("a long independent Maven operation overlaps npm and does not add an avoidable continuation", () => {
    const identities = Array.from(
      { length: 37 },
      (_, index) => ({ name: `@example/mixed-${index}`, version: "2.0.0" }),
    );
    const maven = {
      id: "maven:atomic-deployment",
      kind: "maven-atomic-deployment",
      ecosystem: "maven",
      carrierIds: ["maven:dev.example:mixed"],
      dependencies: [],
      operationOrder: 0,
    };
    const npmOperations = identities.map((identity, index) => ({
      id: `carrier:npm:${identity.name}`,
      kind: "carrier",
      ecosystem: "npm",
      carrierId: `npm:${identity.name}`,
      dependencies: [],
      operationOrder: index + 1,
    }));
    const plan = { operations: [maven, ...npmOperations] };
    const emptyCargo = {
      selectedIdentities: [],
      publishedIdentities: [],
      pendingVersions: [],
      missingNames: [],
    };
    const first = assessCratesIoVersionCapacity({
      inventory: emptyCargo,
      npmInventory: {
        selectedIdentities: identities,
        publishedIdentities: [],
        pendingVersions: identities,
        missingNames: [],
      },
      normalPlan: plan,
      reconciledCarrierIds: [],
      completedOperationIds: [],
      authoritativeWindowSeconds: 11_400,
      deadlineEpochSeconds: 12_400,
      nowEpochSeconds: 1_000,
    });
    expect(first.admittedOperationIds).toEqual([maven.id, ...npmOperations.slice(0, 36).map(({ id }) => id)]);
    expect(first.unadmittedOperationIds).toEqual([npmOperations[36].id]);
    expect(first.plannedExecutorCriticalPathSeconds).toBe(10_800);

    const second = assessCratesIoVersionCapacity({
      inventory: emptyCargo,
      npmInventory: {
        selectedIdentities: identities,
        publishedIdentities: identities.slice(0, 36),
        pendingVersions: identities.slice(36),
        missingNames: [],
      },
      normalPlan: plan,
      reconciledCarrierIds: [],
      completedOperationIds: first.admittedOperationIds,
      authoritativeWindowSeconds: 11_400,
      deadlineEpochSeconds: 13_400,
      nowEpochSeconds: 2_000,
    });
    expect(second.admittedOperationIds).toEqual([npmOperations[36].id]);
    expect(second.unadmittedOperationIds).toEqual([]);
    // The npm lane itself has a hard lower bound of two invocations (37 > 36
    // per window), so admitting Maven in the first one adds no continuation.
    expect(second.publicationCompleteAfterAdmission).toBe(true);
  });

  test("canonical maximal admission fills a same-lane gap with cheap reconciliation and cannot starve", () => {
    const pending = [
      { name: "@example/pending-a", version: "2.0.0" },
      { name: "@example/pending-b", version: "2.0.0" },
    ];
    const published = Array.from(
      { length: 50 },
      (_, index) => ({ name: `@example/public-${index}`, version: "2.0.0" }),
    );
    const identities = [...pending, ...published];
    const operations = identities.map((identity, operationOrder) => ({
      id: `carrier:npm:${identity.name}`,
      kind: "carrier",
      ecosystem: "npm",
      carrierId: `npm:${identity.name}`,
      dependencies: [],
      operationOrder,
    }));
    const emptyCargo = {
      selectedIdentities: [],
      publishedIdentities: [],
      pendingVersions: [],
      missingNames: [],
    };
    const first = assessCratesIoVersionCapacity({
      inventory: emptyCargo,
      npmInventory: {
        selectedIdentities: identities,
        publishedIdentities: published,
        pendingVersions: pending,
        missingNames: [],
      },
      normalPlan: { operations },
      reconciledCarrierIds: [],
      completedOperationIds: [],
      authoritativeWindowSeconds: 1_199,
      deadlineEpochSeconds: 2_199,
      nowEpochSeconds: 1_000,
    });
    expect(first.admittedOperationIds).toEqual([
      operations[0].id,
      ...operations.slice(2, 51).map(({ id }) => id),
    ]);
    expect(first.unadmittedOperationIds).toEqual([operations[1].id, operations[51].id]);
    expect(first.plannedExecutorCriticalPathSeconds).toBe(594);

    const secondPublished = [pending[0], ...published];
    const second = assessCratesIoVersionCapacity({
      inventory: emptyCargo,
      npmInventory: {
        selectedIdentities: identities,
        publishedIdentities: secondPublished,
        pendingVersions: [pending[1]],
        missingNames: [],
      },
      normalPlan: { operations },
      reconciledCarrierIds: [],
      completedOperationIds: first.admittedOperationIds,
      authoritativeWindowSeconds: 1_199,
      deadlineEpochSeconds: 3_199,
      nowEpochSeconds: 2_000,
    });
    expect(second.admittedOperationIds).toEqual(first.unadmittedOperationIds);
    expect(second.unadmittedOperationIds).toEqual([]);
  });

  test("adds explicit cross-registry edges to the lane critical path", () => {
    const npmIdentity = { name: "@example/input", version: "1.0.0" };
    const npmOperation = {
      id: "carrier:npm:@example/input",
      kind: "carrier",
      ecosystem: "npm",
      carrierId: "npm:@example/input",
      dependencies: [],
      operationOrder: 0,
    };
    const mavenOperation = {
      id: "maven:atomic-deployment",
      kind: "maven-atomic-deployment",
      ecosystem: "maven",
      carrierIds: ["maven:dev.example:sdk"],
      dependencies: [npmOperation.id],
      operationOrder: 1,
    };
    const jsrOperation = {
      id: "carrier:jsr:@example/output",
      kind: "carrier",
      ecosystem: "jsr",
      carrierId: "jsr:@example/output",
      dependencies: [mavenOperation.id],
      operationOrder: 2,
    };
    const assessment = assessCratesIoVersionCapacity({
      inventory: {
        selectedIdentities: [],
        publishedIdentities: [],
        pendingVersions: [],
        missingNames: [],
      },
      npmInventory: {
        selectedIdentities: [npmIdentity],
        publishedIdentities: [],
        pendingVersions: [npmIdentity],
        missingNames: [],
      },
      normalPlan: { operations: [npmOperation, mavenOperation, jsrOperation] },
      reconciledCarrierIds: [],
      deadlineEpochSeconds: 4_300,
      nowEpochSeconds: 1_000,
    });
    expect(assessment.plannedExecutorCriticalPathSeconds).toBe(2_700);
    expect(assessment.plannedExecutorSeconds).toBe(3_300);
    expect(assessment.minimumMutationWindowSeconds).toBe(3_300);
    expect(assessment.allowed).toBe(true);
  });

  test("exact-lock reruns budget public partial mutations for proof without requiring prior receipts", () => {
    const cargoIdentity = { name: "cargo-partial", version: "1.0.0" };
    const npmIdentity = { name: "@example/partial", version: "1.0.0" };
    const cargoOperation = {
      id: "carrier:cargo:cargo-partial",
      kind: "carrier",
      ecosystem: "cargo",
      carrierId: "cargo:cargo-partial",
      dependencies: [],
      operationOrder: 0,
    };
    const npmOperation = {
      id: "carrier:npm:@example/partial",
      kind: "carrier",
      ecosystem: "npm",
      carrierId: "npm:@example/partial",
      dependencies: [],
      operationOrder: 1,
    };
    const options = {
      inventory: {
        selectedIdentities: [cargoIdentity],
        publishedIdentities: [cargoIdentity],
        pendingVersions: [],
        missingNames: [],
      },
      npmInventory: {
        selectedIdentities: [npmIdentity],
        publishedIdentities: [npmIdentity],
        pendingVersions: [],
        missingNames: [],
      },
      normalPlan: { operations: [cargoOperation, npmOperation] },
      deadlineEpochSeconds: 2_000,
      nowEpochSeconds: 1_000,
    };
    const interruptedBeforeEvidence = assessCratesIoVersionCapacity({
      ...options,
      reconciledCarrierIds: [],
    });
    expect(interruptedBeforeEvidence.pendingCount).toBe(0);
    expect(interruptedBeforeEvidence.pendingNpmCount).toBe(0);
    expect(interruptedBeforeEvidence.publicReconciliationCount).toBe(2);
    expect(interruptedBeforeEvidence.plannedExecutorCriticalPathSeconds).toBe(6);
    expect(interruptedBeforeEvidence.allowed).toBe(true);

    const restoredEvidence = assessCratesIoVersionCapacity({
      ...options,
      reconciledCarrierIds: [cargoOperation.carrierId, npmOperation.carrierId],
    });
    expect(restoredEvidence.publicReconciliationCount).toBe(0);
    expect(restoredEvidence.plannedExecutorCriticalPathSeconds).toBe(0);
  });

  test("normal publication rejects missing crate names even with ample update capacity", () => {
    const assessment = assessCratesIoVersionCapacity({
      inventory: {
        selectedIdentities: [{ name: "not-created", version: "0.1.0" }],
        publishedIdentities: [],
        pendingVersions: [],
        missingNames: ["not-created"],
      },
      deadlineEpochSeconds: 20_800,
      nowEpochSeconds: 1_000,
    });
    expect(() => assertCratesIoVersionCapacity(assessment)).toThrow(/identity bootstrap first/u);
  });
});
