import { describe, expect, test } from "bun:test";

import { reconcileBootstrapRegistryState } from "./bootstrap-registry-reconciliation.mjs";

function carrier(ecosystem, index) {
  const name = ecosystem === "cargo" ? `crate-${index}` : `@oliphaunt/pkg-${index}`;
  return {
    id: `${ecosystem}:${name}`,
    product: "fixture",
    ecosystem,
    name,
    version: "1.0.0",
    publishOrder: index,
  };
}

function identity({ name, version }) {
  return { name, version };
}

describe("bootstrap registry reconciliation", () => {
  test("a 630/631 resume executes only the one still-absent name", () => {
    const cargo = Array.from({ length: 417 }, (_, index) => carrier("cargo", index));
    const npm = Array.from({ length: 214 }, (_, index) => carrier("npm", 417 + index));
    const plan = [...cargo, ...npm];
    const publicCarriers = plan.slice(0, 630);
    const checkpoint = {
      receipts: publicCarriers.map(({ id }) => ({ id })),
    };
    const result = reconcileBootstrapRegistryState({
      plan,
      cargoInventory: {
        selectedIdentities: cargo.map(identity),
        publishedIdentities: cargo.map(identity),
        pendingVersions: [],
        missingNames: [],
      },
      npmInventory: {
        selectedIdentities: npm.map(identity),
        publishedIdentities: npm.slice(0, 213).map(identity),
        pendingVersions: [],
        missingNames: [npm[213].name],
      },
      checkpoint,
    });

    expect(result.publicCarrierIds).toHaveLength(630);
    expect(result.receiptedCarrierIds).toHaveLength(630);
    expect(result.missingCarriers.map(({ id }) => id)).toEqual([npm[213].id]);
    expect(result.conflicts).toEqual([]);
  });

  test("classifies existing-name missing-version states as conflicts, never bootstrap writes", () => {
    const cargo = carrier("cargo", 0);
    const npm = carrier("npm", 1);
    const result = reconcileBootstrapRegistryState({
      plan: [cargo, npm],
      cargoInventory: {
        selectedIdentities: [identity(cargo)],
        publishedIdentities: [],
        pendingVersions: [identity(cargo)],
        missingNames: [],
      },
      npmInventory: {
        selectedIdentities: [identity(npm)],
        publishedIdentities: [],
        pendingVersions: [identity(npm)],
        missingNames: [],
      },
    });

    expect(result.missingCarriers).toEqual([]);
    expect(result.conflicts.map(({ id }) => id)).toEqual([cargo.id, npm.id]);
  });

  test("rejects a restored receipt unless its frozen exact version is public", () => {
    const cargo = carrier("cargo", 0);
    expect(() => reconcileBootstrapRegistryState({
      plan: [cargo],
      cargoInventory: {
        selectedIdentities: [identity(cargo)],
        publishedIdentities: [],
        pendingVersions: [],
        missingNames: [cargo.name],
      },
      npmInventory: {
        selectedIdentities: [],
        publishedIdentities: [],
        pendingVersions: [],
        missingNames: [],
      },
      checkpoint: { receipts: [{ id: cargo.id }] },
    })).toThrow(/immutable receipt.*exact registry version is not public/u);
  });

  test("rejects inventories that do not exactly partition the frozen plan", () => {
    const cargo = carrier("cargo", 0);
    expect(() => reconcileBootstrapRegistryState({
      plan: [cargo],
      cargoInventory: {
        selectedIdentities: [identity(cargo)],
        publishedIdentities: [identity(cargo)],
        pendingVersions: [identity(cargo)],
        missingNames: [],
      },
      npmInventory: {
        selectedIdentities: [],
        publishedIdentities: [],
        pendingVersions: [],
        missingNames: [],
      },
    })).toThrow(/must have exactly one registry inventory state/u);
  });
});
