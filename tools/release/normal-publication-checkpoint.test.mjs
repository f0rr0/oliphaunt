#!/usr/bin/env bun
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  NORMAL_PUBLICATION_CHECKPOINT_SCHEMA,
  openNormalPublicationCheckpoint,
} from "./normal-publication-checkpoint.mjs";
import { executeNormalPublicationPlan } from "./normal-publication-executor.mjs";
import { verifyLockedCarrierIntegrity } from "./registry-integrity.mjs";

const ROOT = path.resolve(import.meta.dir, "../..");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function operation({ id, kind, ecosystem, carrierIds, products = ["alpha"], dependencies = [], order, publishOrders }) {
  const row = {
    id,
    kind,
    ecosystem,
    products,
    carrierIds,
    firstPublishOrder: Math.min(...publishOrders),
    lastPublishOrder: Math.max(...publishOrders),
    dependencies,
    operationOrder: order,
  };
  if (kind === "carrier") {
    row.product = products[0];
    row.carrierId = carrierIds[0];
  }
  return row;
}

test("atomically preserves aggregate Maven progress and resumes after a later lane failure", async (t) => {
  mkdirSync(path.join(ROOT, "target"), { recursive: true });
  const root = mkdtempSync(path.join(ROOT, "target", "normal-publication-checkpoint-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const files = {
    cargo: path.join(root, "alpha-1.0.0.crate"),
    mavenA: path.join(root, "alpha-a-1.0.0.jar"),
    mavenB: path.join(root, "alpha-b-1.0.0.jar"),
    npm: path.join(root, "alpha-1.0.0.tgz"),
  };
  const bytes = {
    cargo: Buffer.from("cargo bytes\n"),
    mavenA: Buffer.from("maven a bytes\n"),
    mavenB: Buffer.from("maven b bytes\n"),
    npm: Buffer.from("npm bytes\n"),
  };
  for (const key of Object.keys(files)) writeFileSync(files[key], bytes[key]);
  const artifact = (file, value) => ({
    path: path.relative(ROOT, file),
    sha256: sha256(value),
    size: statSync(file).size,
  });
  const carriers = [
    {
      id: "cargo:alpha",
      product: "alpha",
      ecosystem: "cargo",
      name: "alpha",
      version: "1.0.0",
      publishOrder: 0,
      artifacts: [artifact(files.cargo, bytes.cargo)],
    },
    {
      id: "maven:dev.example:alpha-a",
      product: "alpha",
      ecosystem: "maven",
      name: "dev.example:alpha-a",
      version: "1.0.0",
      publishOrder: 1,
      artifacts: [artifact(files.mavenA, bytes.mavenA)],
    },
    {
      id: "maven:dev.example:alpha-b",
      product: "alpha",
      ecosystem: "maven",
      name: "dev.example:alpha-b",
      version: "1.0.0",
      publishOrder: 2,
      artifacts: [artifact(files.mavenB, bytes.mavenB)],
    },
    {
      id: "npm:@example/alpha",
      product: "alpha",
      ecosystem: "npm",
      name: "@example/alpha",
      version: "1.0.0",
      publishOrder: 3,
      artifacts: [artifact(files.npm, bytes.npm)],
    },
  ];
  const lock = {
    lockDigest: "a".repeat(64),
    catalogDigest: "b".repeat(64),
    packageEnvelopeDigest: "c".repeat(64),
    source: { commit: "d".repeat(40), tree: "e".repeat(40) },
    carriers,
  };
  const cargo = operation({
    id: "carrier:cargo:alpha",
    kind: "carrier",
    ecosystem: "cargo",
    carrierIds: ["cargo:alpha"],
    order: 0,
    publishOrders: [0],
  });
  const maven = operation({
    id: "maven:atomic-deployment",
    kind: "maven-atomic-deployment",
    ecosystem: "maven",
    carrierIds: ["maven:dev.example:alpha-a", "maven:dev.example:alpha-b"],
    dependencies: [cargo.id],
    order: 1,
    publishOrders: [1, 2],
  });
  const npm = operation({
    id: "carrier:npm:@example/alpha",
    kind: "carrier",
    ecosystem: "npm",
    carrierIds: ["npm:@example/alpha"],
    dependencies: [maven.id],
    order: 2,
    publishOrders: [3],
  });
  const plan = { products: ["alpha"], carrierCount: 4, operations: [cargo, maven, npm] };
  const fetchImpl = async (url) => {
    if (url.includes("crates.io")) return Response.json({ version: { checksum: sha256(bytes.cargo) } });
    if (url.includes("registry.npmjs.org")) {
      const digest = createHash("sha512").update(bytes.npm).digest("base64");
      return Response.json({ dist: { integrity: `sha512-${digest}` } });
    }
    if (url.includes("alpha-a")) return new Response(bytes.mavenA);
    if (url.includes("alpha-b")) return new Response(bytes.mavenB);
    throw new Error(`unexpected registry URL ${url}`);
  };
  const receipts = new Map();
  for (const carrier of carriers) {
    receipts.set(carrier.id, await verifyLockedCarrierIntegrity(lock, carrier.id, { fetchImpl }));
  }
  const checkpointFile = path.join(root, "normal-publication-checkpoint.json");
  const checkpoint = openNormalPublicationCheckpoint({
    file: checkpointFile,
    lock,
    products: ["alpha"],
    plan,
  });
  assert.equal(JSON.parse(readFileSync(checkpointFile, "utf8")).schema, NORMAL_PUBLICATION_CHECKPOINT_SCHEMA);

  await assert.rejects(
    () => executeNormalPublicationPlan({
      plan,
      cargoVersionPublished: async () => true,
      publishCarrier: async ({ carrierId }) => {
        if (carrierId === npm.carrierId) throw new Error("simulated runner-lane failure after Maven");
        return receipts.get(carrierId);
      },
      publishMaven: async () => maven.carrierIds.map((id) => receipts.get(id)),
      onOperationComplete: checkpoint.recordOperation,
    }),
    /simulated runner-lane failure after Maven/u,
  );
  const interrupted = JSON.parse(readFileSync(checkpointFile, "utf8"));
  assert.deepEqual(interrupted.completedOperations, [cargo.id, maven.id]);
  assert.deepEqual(interrupted.receipts.map(({ id }) => id), [cargo.carrierId, ...maven.carrierIds]);
  assert.equal(readdirSync(root).some((name) => name.includes(".tmp-")), false);

  const resumed = openNormalPublicationCheckpoint({ file: checkpointFile, lock, products: ["alpha"], plan });
  const completedOperationResults = await resumed.reconcileCompleted({
    verifyImpl: async (_lock, { carrierIds }) => carrierIds.map((id) => receipts.get(id)),
  });
  const calls = [];
  const results = await executeNormalPublicationPlan({
    plan,
    completedOperationResults,
    cargoVersionPublished: async () => { throw new Error("resumed Cargo must not be inspected"); },
    publishCarrier: async ({ carrierId }) => {
      calls.push(carrierId);
      return receipts.get(carrierId);
    },
    publishMaven: async () => { throw new Error("resumed Maven must not be published"); },
    onOperationComplete: resumed.recordOperation,
  });
  assert.deepEqual(calls, [npm.carrierId]);
  assert.deepEqual(results.operationResults, [
    receipts.get(cargo.carrierId),
    maven.carrierIds.map((id) => receipts.get(id)),
    receipts.get(npm.carrierId),
  ]);
  assert.deepEqual(resumed.checkpoint.completedOperations, [cargo.id, maven.id, npm.id]);

  assert.throws(
    () => openNormalPublicationCheckpoint({
      file: checkpointFile,
      lock: { ...lock, packageEnvelopeDigest: "f".repeat(64) },
      products: ["alpha"],
      plan,
    }),
    /stale for the active lock source, package envelope, product selection, or publication plan/u,
  );

  const malformed = JSON.parse(readFileSync(checkpointFile, "utf8"));
  malformed.unexpected = true;
  writeFileSync(checkpointFile, `${JSON.stringify(malformed)}\n`);
  assert.throws(
    () => openNormalPublicationCheckpoint({ file: checkpointFile, lock, products: ["alpha"], plan }),
    /checkpoint keys must be exactly/u,
  );
});

test("executor rejects a resumed operation whose dependencies were not checkpointed", async () => {
  const first = operation({
    id: "carrier:npm:first",
    kind: "carrier",
    ecosystem: "npm",
    carrierIds: ["npm:first"],
    order: 0,
    publishOrders: [0],
  });
  const second = operation({
    id: "carrier:jsr:second",
    kind: "carrier",
    ecosystem: "jsr",
    carrierIds: ["jsr:second"],
    dependencies: [first.id],
    order: 1,
    publishOrders: [1],
  });
  await assert.rejects(
    () => executeNormalPublicationPlan({
      plan: { operations: [first, second] },
      completedOperationResults: new Map([[second.id, { id: second.carrierId }]]),
      cargoVersionPublished: async () => true,
      publishCarrier: async () => {},
      publishMaven: async () => {},
    }),
    /completed operation .* is missing completed dependencies/u,
  );
});
