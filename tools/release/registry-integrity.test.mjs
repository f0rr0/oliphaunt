#!/usr/bin/env bun
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  validateLockedRegistryReceipts,
  validateRegistryReceiptEvidence,
  verifyLockedCarrierIntegrity,
  verifyLockedRegistryIntegrity,
  writeRegistryReceiptEvidence,
} from "./registry-integrity.mjs";
import { createCratesIoReadGate } from "./registry-http-retry.mjs";

const ROOT = path.resolve(import.meta.dir, "../..");
const sha = (bytes, algorithm, encoding = "hex") => createHash(algorithm).update(bytes).digest(encoding);

test("proves Cargo checksum and npm SRI against frozen archive bytes and rejects same-version byte conflicts", async () => {
  mkdirSync(path.join(ROOT, "target"), { recursive: true });
  const root = mkdtempSync(path.join(ROOT, "target", "registry-integrity-test-"));
  try {
    const crateBytes = Buffer.from("exact crate bytes\n");
    const npmBytes = Buffer.from("exact npm tarball bytes\n");
    const crateFile = path.join(root, "alpha-1.0.0.crate");
    const npmFile = path.join(root, "alpha-1.0.0.tgz");
    writeFileSync(crateFile, crateBytes);
    writeFileSync(npmFile, npmBytes);
    const lock = {
      lockDigest: "a".repeat(64),
      source: { commit: "b".repeat(40), tree: "c".repeat(40) },
      carriers: [
        { id: "cargo:alpha", product: "alpha", ecosystem: "cargo", name: "alpha", version: "1.0.0", publishOrder: 0, artifacts: [{ path: path.relative(ROOT, crateFile), sha256: sha(crateBytes, "sha256"), size: statSync(crateFile).size }] },
        { id: "npm:@example/alpha", product: "alpha", ecosystem: "npm", name: "@example/alpha", version: "1.0.0", publishOrder: 1, artifacts: [{ path: path.relative(ROOT, npmFile), sha256: sha(npmBytes, "sha256"), size: statSync(npmFile).size }] },
      ],
    };
    const requestedUrls = [];
    const goodFetch = async (url) => {
      requestedUrls.push(url);
      return Response.json(
        url.includes("crates")
          ? { version: { checksum: sha(crateBytes, "sha256") } }
          : { dist: { integrity: `sha512-${sha(npmBytes, "sha512", "base64")}` } },
      );
    };
    const cargo = await verifyLockedCarrierIntegrity(lock, "cargo:alpha", { fetchImpl: goodFetch });
    const npm = await verifyLockedCarrierIntegrity(lock, "npm:@example/alpha", { fetchImpl: goodFetch });
    assert.equal(cargo.registryProof.digest, sha(crateBytes, "sha256"));
    assert.equal(npm.registryProof.digest, sha(npmBytes, "sha512", "base64"));
    assert.equal(npm.registryProof.url, "https://registry.npmjs.org/%40example%2Falpha/1.0.0");
    assert.ok(requestedUrls.includes("https://registry.npmjs.org/%40example%2Falpha/1.0.0"));
    const cargoReadStarts = [];
    const bulk = await verifyLockedRegistryIntegrity(lock, {
      products: ["alpha"], ecosystems: ["cargo", "npm"], fetchImpl: goodFetch, concurrency: 2,
      cratesIoReadGate: {
        beforeRequest: async (label) => cargoReadStarts.push(label),
        defer: () => {},
      },
    });
    assert.deepEqual(bulk.map((receipt) => receipt.id), ["cargo:alpha", "npm:@example/alpha"]);
    assert.deepEqual(cargoReadStarts, ["https://crates.io/api/v1/crates/alpha/1.0.0"]);
    assert.deepEqual(validateLockedRegistryReceipts(lock, {
      products: ["alpha"],
      ecosystems: ["cargo", "npm"],
      receipts: bulk,
    }), bulk);
    const evidenceFile = path.join(root, "registry-receipts.json");
    writeRegistryReceiptEvidence(evidenceFile, lock, {
      products: ["alpha"],
      ecosystems: ["cargo", "npm"],
      receipts: bulk,
    });
    assert.equal(validateRegistryReceiptEvidence(evidenceFile, lock, {
      products: ["alpha"],
      ecosystems: ["cargo", "npm"],
    }).receipts.length, 2);
    const conflicting = structuredClone(bulk);
    conflicting[0].registryProof.digest = "0".repeat(64);
    assert.throws(() => validateLockedRegistryReceipts(lock, {
      products: ["alpha"], ecosystems: ["cargo", "npm"], receipts: conflicting,
    }), /does not exactly prove/u);
    await assert.rejects(
      () => verifyLockedRegistryIntegrity(lock, { products: ["alpha"], ecosystems: ["cargo"], fetchImpl: goodFetch, concurrency: 0 }),
      /concurrency/u,
    );

    const badFetch = async (url) => Response.json(
      url.includes("crates")
        ? { version: { checksum: "0".repeat(64) } }
        : { dist: { integrity: `sha512-${Buffer.alloc(64).toString("base64")}` } },
    );
    await assert.rejects(() => verifyLockedCarrierIntegrity(lock, "cargo:alpha", { fetchImpl: badFetch }), /checksum mismatch/u);
    await assert.rejects(() => verifyLockedCarrierIntegrity(lock, "npm:@example/alpha", { fetchImpl: badFetch }), /integrity mismatch/u);

    let rateLimitedAttempts = 0;
    const rateLimitedThenGood = async () => {
      rateLimitedAttempts += 1;
      if (rateLimitedAttempts === 1) {
        return {
          ok: false,
          status: 429,
          headers: { get: (name) => name === "retry-after" ? "0" : null },
          body: { cancel: async () => {} },
        };
      }
      return Response.json({ version: { checksum: sha(crateBytes, "sha256") } });
    };
    await verifyLockedCarrierIntegrity(lock, "cargo:alpha", { fetchImpl: rateLimitedThenGood });
    assert.equal(rateLimitedAttempts, 2);

    let authoritativeRetryAttempts = 0;
    const authoritativeDeferrals = [];
    const authoritativeRetryGate = {
      beforeRequest: async () => {},
      defer: (seconds) => authoritativeDeferrals.push(seconds),
    };
    await verifyLockedCarrierIntegrity(lock, "cargo:alpha", {
      cratesIoReadGate: authoritativeRetryGate,
      fetchImpl: async () => {
        authoritativeRetryAttempts += 1;
        if (authoritativeRetryAttempts === 1) {
          return {
            ok: false,
            status: 429,
            headers: { get: (name) => name === "retry-after" ? "45" : null },
            body: { cancel: async () => {} },
          };
        }
        return Response.json({ version: { checksum: sha(crateBytes, "sha256") } });
      },
    });
    assert.equal(authoritativeRetryAttempts, 2);
    assert.deepEqual(authoritativeDeferrals, [45]);

    let excessiveRetryAttempts = 0;
    await assert.rejects(
      () => verifyLockedCarrierIntegrity(lock, "cargo:alpha", {
        cratesIoReadGate: {
          beforeRequest: async () => {},
          defer: () => assert.fail("an excessive Retry-After must fail before deferring the read gate"),
        },
        fetchImpl: async () => {
          excessiveRetryAttempts += 1;
          return {
            ok: false,
            status: 429,
            headers: { get: (name) => name === "retry-after" ? "601" : null },
            body: { cancel: async () => {} },
          };
        },
      }),
      /bounded 600s retry-delay budget/u,
    );
    assert.equal(excessiveRetryAttempts, 1);

    let logicalNowSeconds = 1_000;
    const sharedGateSleeps = [];
    const sharedGate = createCratesIoReadGate({
      nowImpl: () => logicalNowSeconds,
      sleepImpl: async (milliseconds) => {
        sharedGateSleeps.push(milliseconds);
        logicalNowSeconds += milliseconds / 1000;
      },
    });
    await verifyLockedCarrierIntegrity(lock, "cargo:alpha", { fetchImpl: goodFetch, cratesIoReadGate: sharedGate });
    await verifyLockedCarrierIntegrity(lock, "cargo:alpha", { fetchImpl: goodFetch, cratesIoReadGate: sharedGate });
    assert.deepEqual(sharedGateSleeps, [250]);

    let notFoundAttempts = 0;
    const notFound = async () => {
      notFoundAttempts += 1;
      return { ok: false, status: 404, headers: { get: () => null } };
    };
    await assert.rejects(() => verifyLockedCarrierIntegrity(lock, "cargo:alpha", { fetchImpl: notFound }), /HTTP 404.*after 1 attempt/u);
    assert.equal(notFoundAttempts, 1);

    let oversizedAttempts = 0;
    const oversizedMetadata = async () => {
      oversizedAttempts += 1;
      return new Response("{}", {
        headers: { "content-length": String(8 * 1024 * 1024 + 1) },
      });
    };
    await assert.rejects(
      () => verifyLockedCarrierIntegrity(lock, "cargo:alpha", { fetchImpl: oversizedMetadata }),
      /response exceeds 8388608 bytes.*after 1 attempt/u,
    );
    assert.equal(oversizedAttempts, 1);

    const previousDeadline = process.env.REGISTRY_MUTATION_DEADLINE_EPOCH;
    let afterDeadlineRequests = 0;
    try {
      process.env.REGISTRY_MUTATION_DEADLINE_EPOCH = String(Math.floor(Date.now() / 1000) - 1);
      await assert.rejects(
        () => verifyLockedCarrierIntegrity(lock, "npm:@example/alpha", {
          fetchImpl: async () => {
            afterDeadlineRequests += 1;
            return goodFetch("npm");
          },
        }),
        /shared registry mutation deadline has been reached/u,
      );
      assert.equal(afterDeadlineRequests, 0);
    } finally {
      if (previousDeadline === undefined) delete process.env.REGISTRY_MUTATION_DEADLINE_EPOCH;
      else process.env.REGISTRY_MUTATION_DEADLINE_EPOCH = previousDeadline;
    }

    rmSync(crateFile);
    rmSync(npmFile);
    assert.equal(validateRegistryReceiptEvidence(evidenceFile, lock, {
      products: ["alpha"],
      ecosystems: ["cargo", "npm"],
      receiptMode: "sealed",
    }).receipts.length, 2);
    assert.throws(() => validateRegistryReceiptEvidence(evidenceFile, lock, {
      products: ["alpha"],
      ecosystems: ["cargo", "npm"],
    }), /locked artifact is unavailable/u);

    const changedCargo = structuredClone(bulk);
    changedCargo[0].registryProof.digest = "0".repeat(64);
    assert.throws(() => validateLockedRegistryReceipts(lock, {
      products: ["alpha"],
      ecosystems: ["cargo", "npm"],
      receiptMode: "sealed",
      receipts: changedCargo,
    }), /sealed Cargo proof changed/u);
    const changedNpm = structuredClone(bulk);
    changedNpm[1].registryProof.digest = "not-base64";
    assert.throws(() => validateLockedRegistryReceipts(lock, {
      products: ["alpha"],
      ecosystems: ["cargo", "npm"],
      receiptMode: "sealed",
      receipts: changedNpm,
    }), /canonical SHA-512 base64/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("proves every frozen Maven payload before an immutable-version skip", async () => {
  mkdirSync(path.join(ROOT, "target"), { recursive: true });
  const root = mkdtempSync(path.join(ROOT, "target", "registry-integrity-maven-test-"));
  try {
    const mavenBytes = Buffer.from("exact Maven payload bytes\n");
    const mavenFile = path.join(root, "native-runtime.tar.gz");
    writeFileSync(mavenFile, mavenBytes);

    const lock = {
      carriers: [
        {
          id: "maven:dev.example:alpha-native",
          product: "alpha",
          ecosystem: "maven",
          name: "dev.example:alpha-native",
          version: "1.0.0",
          publishOrder: 0,
          artifacts: [{ path: path.relative(ROOT, mavenFile), sha256: sha(mavenBytes, "sha256"), size: mavenBytes.length }],
        },
      ],
    };
    const goodFetch = async () => new Response(mavenBytes);

    const maven = await verifyLockedCarrierIntegrity(lock, "maven:dev.example:alpha-native", { fetchImpl: goodFetch });
    assert.equal(maven.registryProof.files[0].digest, sha(mavenBytes, "sha256"));

    const wrongMavenFetch = async () => new Response(Buffer.from("different immutable bytes\n"));
    await assert.rejects(
      () => verifyLockedCarrierIntegrity(lock, "maven:dev.example:alpha-native", { fetchImpl: wrongMavenFetch }),
      /Maven payload mismatch/u,
    );
    let oversizedPayloadAttempts = 0;
    const oversizedMavenFetch = async () => {
      oversizedPayloadAttempts += 1;
      return new Response(mavenBytes, {
        headers: { "content-length": String(mavenBytes.length + 1) },
      });
    };
    await assert.rejects(
      () => verifyLockedCarrierIntegrity(lock, "maven:dev.example:alpha-native", { fetchImpl: oversizedMavenFetch }),
      /response exceeds locked size.*after 1 attempt/u,
    );
    assert.equal(oversizedPayloadAttempts, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("writes and revalidates exhaustive empty evidence for a selected source-only release", () => {
  mkdirSync(path.join(ROOT, "target"), { recursive: true });
  const root = mkdtempSync(path.join(ROOT, "target", "registry-integrity-empty-test-"));
  try {
    const lock = {
      lockDigest: "d".repeat(64),
      source: { commit: "e".repeat(40), tree: "f".repeat(40) },
      carriers: [],
    };
    const file = path.join(root, "empty-receipts.json");
    const ecosystems = ["cargo", "npm", "maven"];
    const written = writeRegistryReceiptEvidence(file, lock, {
      products: ["oliphaunt-swift"],
      ecosystems,
      receipts: [],
    });
    assert.deepEqual(written.receipts, []);
    const verified = validateRegistryReceiptEvidence(file, lock, {
      products: ["oliphaunt-swift"],
      ecosystems,
    });
    assert.deepEqual(verified.products, ["oliphaunt-swift"]);
    assert.deepEqual(verified.receipts, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
