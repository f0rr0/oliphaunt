#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import process from "node:process";

import {
  bootstrapCheckpointBatches,
  bootstrapPublicationPlan,
} from "../../tools/release/bootstrap-publication-plan.mjs";
import {
  assessCratesIoBootstrapCapacity,
  assertCratesIoBootstrapCapacity,
  cratesIoCapacitySummary,
  inspectCratesIoBootstrapNames,
  parseRegistryMutationDeadline,
} from "../../tools/release/crates-io-bootstrap-capacity.mjs";
import { loadPublicationLock } from "../../tools/release/publication-lock.mjs";

function fail(message) {
  console.error(`bootstrap-registry-identities: ${message}`);
  process.exit(1);
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    fail(`${name} is required`);
  }
  return value;
}

let products;
try {
  products = JSON.parse(requiredEnv("PRODUCTS_JSON"));
} catch (error) {
  fail(`invalid PRODUCTS_JSON: ${error.message}`);
}
if (!Array.isArray(products) || products.length === 0 || products.some((product) => typeof product !== "string")) {
  fail("PRODUCTS_JSON must be a non-empty product string list");
}

const headRef = requiredEnv("RELEASE_HEAD_SHA");
const publicationLock = requiredEnv("PUBLICATION_LOCK_PATH");
const bootstrapLedger = requiredEnv("BOOTSTRAP_LEDGER_PATH");
let plan;
try {
  const lock = loadPublicationLock(publicationLock);
  plan = bootstrapPublicationPlan(lock, products);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

// This read-only inventory and numeric capacity contract must complete before
// the genesis ledger is initialized and, critically, before npm or crates.io
// receives any publication request. The protected environment assertion is
// required when the exact lock exceeds crates.io's documented default burst.
try {
  const deadlineEpochSeconds = parseRegistryMutationDeadline(
    requiredEnv("REGISTRY_MUTATION_DEADLINE_EPOCH"),
  );
  const inventory = await inspectCratesIoBootstrapNames({
    plan,
    deadlineEpochSeconds,
  });
  const assessment = assessCratesIoBootstrapCapacity({
    inventory,
    configuredCapacity: process.env.CRATES_IO_NEW_CRATE_RUN_CAPACITY,
    deadlineEpochSeconds,
  });
  const summary = cratesIoCapacitySummary(assessment);
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY?.trim()) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  }
  assertCratesIoBootstrapCapacity(assessment);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

function ledger(command, extra = []) {
  const result = spawnSync(
    "tools/dev/bun.sh",
    [
      "tools/release/bootstrap-ledger.mjs",
      command,
      "--lock",
      publicationLock,
      "--ledger",
      bootstrapLedger,
      "--products-json",
      JSON.stringify(products),
      ...extra,
    ],
    { stdio: "inherit", env: process.env },
  );
  if (result.error || result.status !== 0) {
    fail(result.error?.message || `bootstrap ledger ${command} failed with status ${result.status}`);
  }
}

// A genesis checkpoint is written before the first network mutation. Every
// later file is append-only and content-addressed, so `if: always()` can upload
// a useful resume chain even when a six-hour bootstrap is interrupted.
ledger("init");

const checkpointBatches = bootstrapCheckpointBatches(plan);
let operations = 0;
for (const carrierIds of checkpointBatches) {
  for (const carrierId of carrierIds) {
    const carrier = plan[operations];
    if (carrier?.id !== carrierId) {
      fail(`internal bootstrap plan drift at operation ${operations}: expected ${carrier?.id}, got ${carrierId}`);
    }
    console.log(`bootstrapping missing ${carrier.ecosystem} identity ${carrier.id} (${carrier.product})`);
    const result = spawnSync(
      "tools/dev/bun.sh",
      [
        "tools/release/release-publish.mjs",
        "publish",
        "--bootstrap-identities",
        "--carrier-id",
        carrier.id,
        "--head-ref",
        headRef,
        "--publication-lock",
        publicationLock,
        "--bootstrap-ledger",
        bootstrapLedger,
      ],
      { stdio: "inherit", env: process.env },
    );
    if (result.error || result.status !== 0) {
      fail(result.error?.message || `${carrier.id} failed with status ${result.status}`);
    }
    operations += 1;
  }
  ledger("checkpoint", ["--carrier-ids-json", JSON.stringify(carrierIds)]);
}

ledger("seal", ["--verify-registries"]);
console.log(
  `completed ${operations} dependency-ordered, idempotent Cargo/npm bootstrap operations `
    + `with ${checkpointBatches.length} resumable checkpoints and sealed the immutable ledger`,
);
