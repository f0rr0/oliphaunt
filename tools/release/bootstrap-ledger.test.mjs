#!/usr/bin/env bun
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  BOOTSTRAP_LEDGER_SCHEMA,
  appendBootstrapCheckpoint,
  buildBootstrapLedger,
  loadBootstrapLedger,
  validateBootstrapLedger,
} from "./bootstrap-ledger.mjs";

const ROOT = path.resolve(import.meta.dir, "../..");
const hash = (bytes, algorithm, encoding = "hex") => createHash(algorithm).update(bytes).digest(encoding);
const fixedHash = (character) => character.repeat(64);

test("immutable checkpoints resume 417 Cargo plus 214 npm identities and reject registry-byte conflicts", () => {
  mkdirSync(path.join(ROOT, "target"), { recursive: true });
  const root = mkdtempSync(path.join(ROOT, "target", "bootstrap-ledger-test-"));
  try {
    const crateBytes = Buffer.from("shared exact crate fixture\n");
    const npmBytes = Buffer.from("shared exact npm fixture\n");
    const crateFile = path.join(root, "fixture.crate");
    const npmFile = path.join(root, "fixture.tgz");
    writeFileSync(crateFile, crateBytes);
    writeFileSync(npmFile, npmBytes);
    const carriers = [];
    for (let index = 0; index < 417; index += 1) {
      carriers.push({
        id: `cargo:fixture-${index}`,
        product: "alpha",
        ecosystem: "cargo",
        name: `fixture-${index}`,
        version: "1.2.3",
        role: "platform-leaf",
        target: `target-${index}`,
        publishOrder: index,
        artifacts: [{ path: path.relative(ROOT, crateFile), sha256: hash(crateBytes, "sha256"), size: statSync(crateFile).size }],
      });
    }
    for (let index = 0; index < 214; index += 1) {
      carriers.push({
        id: `npm:@example/fixture-${index}`,
        product: "alpha",
        ecosystem: "npm",
        name: `@example/fixture-${index}`,
        version: "1.2.3",
        role: "platform-leaf",
        target: `target-${index}`,
        publishOrder: 417 + index,
        artifacts: [{ path: path.relative(ROOT, npmFile), sha256: hash(npmBytes, "sha256"), size: statSync(npmFile).size }],
      });
    }
    const lock = {
      lockDigest: fixedHash("a"),
      packageEnvelopeDigest: fixedHash("b"),
      catalogDigest: fixedHash("c"),
      source: { commit: "1".repeat(40), tree: "2".repeat(40) },
      products: [{ id: "alpha" }],
      carriers,
    };
    const template = buildBootstrapLedger(lock, ["alpha"]);
    assert.equal(template.schema, BOOTSTRAP_LEDGER_SCHEMA);
    assert.equal(template.publications.length, 631);
    const receipts = template.publications.map((publication) => ({
      id: publication.id,
      product: publication.product,
      ecosystem: publication.ecosystem,
      name: publication.name,
      version: publication.version,
      lockedArtifacts: publication.artifacts,
      registryProof: {
        ...publication.registryExpectation,
        url: `https://registry.example.invalid/${encodeURIComponent(publication.name)}/${publication.version}`,
      },
    }));

    const chain = path.join(root, "chain");
    const genesis = appendBootstrapCheckpoint(chain, lock, ["alpha"], []);
    assert.equal(genesis.sequence, 0);
    assert.equal(genesis.complete, false);
    const interrupted = appendBootstrapCheckpoint(chain, lock, ["alpha"], receipts.slice(0, 271));
    assert.equal(interrupted.receipts.length, 271);
    const resumed = loadBootstrapLedger(chain, lock, ["alpha"]);
    assert.equal(resumed.checkpointDigest, interrupted.checkpointDigest);
    const complete = appendBootstrapCheckpoint(chain, lock, ["alpha"], receipts.slice(271));
    assert.equal(complete.sequence, 2);
    assert.equal(complete.receipts.length, 631);
    assert.equal(complete.complete, true);
    assert.equal(loadBootstrapLedger(chain, lock, ["alpha"], { requireComplete: true }).checkpointDigest, complete.checkpointDigest);
    assert.equal(validateBootstrapLedger(complete, lock, ["alpha"]), complete);

    const conflicting = structuredClone(receipts[0]);
    conflicting.registryProof.digest = conflicting.ecosystem === "cargo" ? fixedHash("9") : Buffer.alloc(64).toString("base64");
    assert.throws(
      () => appendBootstrapCheckpoint(chain, lock, ["alpha"], [conflicting]),
      /conflicts with its immutable prior checkpoint/u,
    );

    const tamperedChain = structuredClone(complete);
    tamperedChain.receipts[0].registryProof.digest = fixedHash("8");
    assert.throws(() => validateBootstrapLedger(tamperedChain, lock, ["alpha"]), /digest mismatch/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
