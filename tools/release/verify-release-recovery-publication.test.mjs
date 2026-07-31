#!/usr/bin/env bun

import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyReleaseRecoveryPublication,
  RECOVERY_PUBLICATION_STATE_SCHEMA,
  releaseRecoveryPublicationReceipt,
  validateReleaseRecoveryPublicationReceipt,
} from "./verify-release-recovery-publication.mjs";

const COMMIT = "1".repeat(40);
const TREE = "2".repeat(40);

function carrier(ecosystem, name, product = "alpha") {
  return {
    id: `${ecosystem}:${name}`,
    ecosystem,
    name,
    product,
    version: "0.1.0",
  };
}

function lock() {
  return {
    source: { commit: COMMIT, tree: TREE },
    lockDigest: "3".repeat(64),
    products: [{ id: "alpha" }, { id: "beta" }],
    carriers: [
      carrier("cargo", "alpha"),
      carrier("npm", "@example/alpha"),
      carrier("maven", "dev.example:beta", "beta"),
      carrier("jsr", "@example/beta", "beta"),
    ],
  };
}

function pkg(kind, name) {
  return { kind, name, version: "0.1.0" };
}

function inventory() {
  const cargo = pkg("crates", "alpha");
  const npm = pkg("npm", "@example/alpha");
  const maven = pkg("maven", "dev.example:beta");
  const jsr = pkg("jsr", "@example/beta");
  return {
    schema: "oliphaunt-release-registry-inventory-v1",
    source: { commit: COMMIT },
    products: ["alpha", "beta"],
    results: [
      {
        product: "alpha",
        packages: [cargo, npm],
        published: [cargo],
        missing: [npm],
      },
      {
        product: "beta",
        packages: [maven, jsr],
        published: [],
        missing: [maven, jsr],
      },
    ],
  };
}

test("classifies an exact partial publication and derives only actually needed bootstrap tokens", () => {
  const classification = classifyReleaseRecoveryPublication({
    lock: lock(),
    inventory: inventory(),
    products: ["alpha", "beta"],
  });
  assert.deepEqual(classification.publicCarrierIds, ["cargo:alpha"]);
  assert.deepEqual(
    classification.missingCarrierIds,
    ["jsr:@example/beta", "maven:dev.example:beta", "npm:@example/alpha"],
  );
  assert.equal(classification.needsCargoToken, false);
  assert.equal(classification.needsNpmToken, true);

  const receipt = releaseRecoveryPublicationReceipt(
    classification,
    [{ id: "cargo:alpha", proof: "exact" }],
  );
  assert.equal(receipt.schema, RECOVERY_PUBLICATION_STATE_SCHEMA);
  assert.equal(receipt.publicCarrierCount, 1);
  assert.equal(receipt.missingCarrierCount, 3);
  assert.match(receipt.evidenceDigest, /^[0-9a-f]{64}$/u);
  assert.equal(
    validateReleaseRecoveryPublicationReceipt({
      lock: lock(),
      receipt,
      products: ["alpha", "beta"],
      validateReceipts: (_lock, { carrierIds, receipts }) => {
        assert.deepEqual(carrierIds, ["cargo:alpha"]);
        assert.deepEqual(receipts, [{ id: "cargo:alpha", proof: "exact" }]);
      },
    }),
    receipt,
  );

  const tampered = structuredClone(receipt);
  tampered.needsCargoToken = true;
  assert.throws(
    () => validateReleaseRecoveryPublicationReceipt({
      lock: lock(),
      receipt: tampered,
      products: ["alpha", "beta"],
      validateReceipts: () => {},
    }),
    /carrier partition is inconsistent/u,
  );
});

test("rejects recovery before any immutable carrier is public", () => {
  const value = inventory();
  for (const result of value.results) {
    result.missing = result.packages;
    result.published = [];
  }
  assert.throws(
    () => classifyReleaseRecoveryPublication({
      lock: lock(),
      inventory: value,
      products: ["alpha", "beta"],
    }),
    /at least one already-public immutable registry carrier/u,
  );
});

test("rejects incomplete, conflicting, or lock-divergent registry inventories", () => {
  const cases = [
    (value) => value.results.pop(),
    (value) => value.results[0].missing.push(value.results[0].published[0]),
    (value) => {
      value.results[0].packages[0] = pkg("crates", "renamed");
      value.results[0].published[0] = value.results[0].packages[0];
    },
    (value) => {
      value.source.commit = "f".repeat(40);
    },
  ];
  for (const mutate of cases) {
    const value = inventory();
    mutate(value);
    assert.throws(
      () => classifyReleaseRecoveryPublication({
        lock: lock(),
        inventory: value,
        products: ["alpha", "beta"],
      }),
      /registry|carrier|source/u,
    );
  }
});

test("requires byte receipts for exactly every public carrier", () => {
  const classification = classifyReleaseRecoveryPublication({
    lock: lock(),
    inventory: inventory(),
    products: ["alpha", "beta"],
  });
  for (const receipts of [
    [],
    [{ id: "npm:@example/alpha" }],
    [{ id: "cargo:alpha" }, { id: "cargo:alpha" }],
  ]) {
    assert.throws(
      () => releaseRecoveryPublicationReceipt(classification, receipts),
      /every classified public carrier exactly once/u,
    );
  }
});
