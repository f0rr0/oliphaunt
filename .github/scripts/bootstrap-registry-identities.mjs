#!/usr/bin/env bun
import { spawn } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import process from "node:process";

import { bootstrapCarrierEnvironment } from "./bootstrap-registry-credential-env.mjs";
import { bootstrapPublicationPlan } from "../../tools/release/bootstrap-publication-plan.mjs";
import { executeBootstrapPublicationPlan } from "../../tools/release/bootstrap-publication-executor.mjs";
import {
  appendBootstrapCheckpoint,
  loadBootstrapLedger,
} from "../../tools/release/bootstrap-ledger.mjs";
import { reconcileBootstrapRegistryState } from "../../tools/release/bootstrap-registry-reconciliation.mjs";
import {
  assessCratesIoBootstrapCapacity,
  assertCratesIoBootstrapCapacity,
  cratesIoCapacitySummary,
  inspectCratesIoVersionState,
  parseRegistryMutationDeadline,
  CRATES_IO_NEW_CRATE_REFILL_SECONDS,
  REGISTRY_BOOTSTRAP_INTEGRITY_CONCURRENCY,
} from "../../tools/release/crates-io-bootstrap-capacity.mjs";
import {
  decodeRegistryPublicationDeferral,
  REGISTRY_PUBLICATION_DEFERRAL_EXIT_CODE,
} from "../../tools/release/registry-publication-deferral.mjs";
import { validateReleaseExecutionResult } from "../../tools/release/release-continuation-contract.mjs";
import { inspectNpmVersionState } from "../../tools/release/frozen-npm-publish.mjs";
import { loadPublicationLock } from "../../tools/release/publication-lock.mjs";
import { verifyLockedRegistryIntegrity } from "../../tools/release/registry-integrity.mjs";

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

const EXECUTION_RESULT_PATH = path.resolve(
  process.env.OLIPHAUNT_BOOTSTRAP_EXECUTION_RESULT?.trim()
    || "target/release/bootstrap-execution-result.json",
);
const CHILD_STDERR_TAIL_BYTES = 128 * 1024;

function writeExecutionResult(value) {
  const normalized = validateReleaseExecutionResult(value, {
    operation: "publish-bootstrap",
    releaseCommit: value.source.commit,
    releaseTree: value.source.tree,
    lock: value.lock,
    products: value.products,
  });
  mkdirSync(path.dirname(EXECUTION_RESULT_PATH), { recursive: true });
  const temporary = `${EXECUTION_RESULT_PATH}.tmp-${process.pid}`;
  rmSync(temporary, { force: true });
  writeFileSync(temporary, `${JSON.stringify(normalized, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  renameSync(temporary, EXECUTION_RESULT_PATH);
  if (process.env.GITHUB_OUTPUT?.trim()) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `complete=${normalized.decision === "complete" ? "true" : "false"}\n`
        + `deferred=${normalized.decision === "deferred" ? "true" : "false"}\n`
        + `deferral_mode=${normalized.deferralMode ?? ""}\n`
        + `progress_count=${normalized.newlyCompletedIds.length}\n`
        + `completed_count=${normalized.completedIds.length}\n`
        + `remaining_count=${normalized.remainingIds.length}\n`
        + `not_before_epoch=${normalized.notBeforeEpochSeconds ?? 0}\n`,
    );
  }
  return normalized;
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
let lock;
let plan;
try {
  lock = loadPublicationLock(publicationLock);
  plan = bootstrapPublicationPlan(lock, products);
  rmSync(EXECUTION_RESULT_PATH, { force: true });
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

// This read-only inventory and official token-bucket admission must complete
// before the genesis ledger is initialized and, critically, before npm or
// crates.io receives any publication request. Oversized first-release graphs
// are split into dependency-closed batches and resumed from immutable receipts.
let cargoInventory;
let npmInventory;
let capacityAssessment;
try {
  const deadlineEpochSeconds = parseRegistryMutationDeadline(
    requiredEnv("REGISTRY_MUTATION_DEADLINE_EPOCH"),
  );
  [cargoInventory, npmInventory] = await Promise.all([
    inspectCratesIoVersionState({ plan, deadlineEpochSeconds }),
    inspectNpmVersionState({ plan, deadlineEpochSeconds }),
  ]);
  capacityAssessment = assessCratesIoBootstrapCapacity({
    inventory: cargoInventory,
    npmInventory,
    bootstrapPlan: plan,
    cargoSecondsPerCarrier: process.env.REGISTRY_BOOTSTRAP_CARGO_SECONDS_PER_CARRIER,
    npmSecondsPerCarrier: process.env.REGISTRY_BOOTSTRAP_NPM_SECONDS_PER_CARRIER,
    reconciliationSecondsPerCarrier: process.env.REGISTRY_BOOTSTRAP_RECONCILIATION_SECONDS_PER_CARRIER,
    reserveSeconds: process.env.REGISTRY_BOOTSTRAP_RESERVE_SECONDS,
    deadlineEpochSeconds,
  });
  const summary = cratesIoCapacitySummary(capacityAssessment);
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY?.trim()) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  }
  assertCratesIoBootstrapCapacity(capacityAssessment);
  if (capacityAssessment.decision !== "execute") {
    throw new Error(
      `bounded bootstrap invocation cannot make dependency-closed progress before its deadline; `
        + `${capacityAssessment.remainingMutationCount} carrier(s) remain and continuation requires nonzero progress`,
    );
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

// Validate a restored immutable chain before using its receipts. Inventory is
// authoritative for current public visibility; a receipt whose exact version
// disappeared is a hard pre-mutation failure. Existing names lacking the
// locked exact version were already rejected by the admission check above.
let checkpoint;
let reconciliation;
let startingCompletedIds;
try {
  checkpoint = loadBootstrapLedger(bootstrapLedger, lock, products, { allowEmpty: true });
  startingCompletedIds = new Set(checkpoint?.receipts.map(({ id }) => id) ?? []);
  reconciliation = reconcileBootstrapRegistryState({
    plan,
    cargoInventory,
    npmInventory,
    checkpoint,
  });
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

// Prove every matching public version against the frozen bytes in one bounded,
// concurrent preflight. This both recovers publications accepted before an
// interrupted checkpoint and ensures public recovery skips cannot conceal an
// immutable checksum/SRI conflict. No registry mutation has happened yet.
let publicReceipts = [];
try {
  if (reconciliation.publicCarrierIds.length > 0) {
    publicReceipts = await verifyLockedRegistryIntegrity(lock, {
      carrierIds: reconciliation.publicCarrierIds,
      concurrency: REGISTRY_BOOTSTRAP_INTEGRITY_CONCURRENCY,
    });
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

// A genesis checkpoint is written only after every pre-mutation conflict and
// public-byte proof has passed. Every later file is append-only and
// content-addressed, so `if: always()` can upload a useful resume chain.
try {
  if (checkpoint === null) {
    checkpoint = appendBootstrapCheckpoint(bootstrapLedger, lock, products, []);
  }
  if (publicReceipts.length > 0) {
    checkpoint = appendBootstrapCheckpoint(bootstrapLedger, lock, products, publicReceipts);
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

// Only completely absent names reach a publisher subprocess. Cargo and npm
// each retain one sequential mutation lane, while independent lanes overlap
// and explicit cross-registry dependency edges remain barriers. Node's async
// spawn is required here: spawnSync would silently serialize both lanes.
function publishCarrier(carrier) {
  console.log(`reconciling pending ${carrier.ecosystem} identity ${carrier.id} (${carrier.product})`);
  return new Promise((resolve, reject) => {
    let stderrTail = Buffer.alloc(0);
    let settled = false;
    const child = spawn(
      process.execPath,
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
      {
        stdio: ["inherit", "inherit", "pipe"],
        env: bootstrapCarrierEnvironment(carrier.ecosystem, process.env),
      },
    );
    child.stderr.on("data", (chunk) => {
      process.stderr.write(chunk);
      stderrTail = Buffer.concat([stderrTail, Buffer.from(chunk)]).subarray(-CHILD_STDERR_TAIL_BYTES);
    });
    child.once("error", (cause) => {
      if (!settled) {
        settled = true;
        reject(cause);
      }
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      if (code === 0) {
        resolve();
      } else if (signal === null && code === REGISTRY_PUBLICATION_DEFERRAL_EXIT_CODE) {
        try {
          reject(decodeRegistryPublicationDeferral(stderrTail.toString("utf8")));
        } catch (cause) {
          reject(cause);
        }
      } else {
        reject(new Error(`${carrier.id} failed with ${signal === null ? `status ${String(code)}` : `signal ${signal}`}`));
      }
    });
  });
}

let execution;
try {
  const admitted = new Set(capacityAssessment.admittedCarrierIds);
  const admittedPlan = reconciliation.missingCarriers.filter(({ id }) => admitted.has(id));
  if (admittedPlan.length !== admitted.size) {
    throw new Error("token-bucket admission contains a carrier outside the exact missing-identity inventory");
  }
  execution = await executeBootstrapPublicationPlan({
    plan: admittedPlan,
    satisfiedCarrierIds: reconciliation.publicCarrierIds,
    publishCarrier,
    checkpointCarrierIds: async (carrierIds) => {
      const receipts = await verifyLockedRegistryIntegrity(lock, {
        carrierIds,
        concurrency: REGISTRY_BOOTSTRAP_INTEGRITY_CONCURRENCY,
      });
      checkpoint = appendBootstrapCheckpoint(bootstrapLedger, lock, products, receipts);
    },
  });
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

let result;
try {
  checkpoint = loadBootstrapLedger(bootstrapLedger, lock, products, { allowEmpty: true });
  const completedSet = new Set(checkpoint?.receipts.map(({ id }) => id) ?? []);
  const completedIds = plan.filter(({ id }) => completedSet.has(id)).map(({ id }) => id);
  if (completedIds.length !== completedSet.size) {
    throw new Error("bootstrap ledger contains a receipt outside the exact canonical plan");
  }
  const remainingIds = plan.filter(({ id }) => !completedSet.has(id)).map(({ id }) => id);
  const newlyCompletedIds = completedIds.filter((id) => !startingCompletedIds.has(id));
  const decision = remainingIds.length === 0 ? "complete" : "deferred";
  if (decision === "complete") {
    checkpoint = loadBootstrapLedger(bootstrapLedger, lock, products, { requireComplete: true });
  }
  const remainingHasCargo = plan.some(({ id, ecosystem }) => ecosystem === "cargo" && remainingIds.includes(id));
  const notBeforeEpochSeconds = decision === "complete"
    ? null
    : execution.notBeforeEpochSeconds
      ?? Math.floor(Date.now() / 1000) + (remainingHasCargo ? CRATES_IO_NEW_CRATE_REFILL_SECONDS : 1);
  const deferralMode = decision === "complete"
    ? null
    : newlyCompletedIds.length > 0
      ? "progress"
      : execution.deferReason === "rate-limit"
        ? "rate-limit"
        : execution.deferReason === "deadline"
          ? "pre-mutation-deadline"
          : (() => {
              throw new Error(
                `zero-progress bootstrap deferral requires an explicit rate-limit or deadline reason; got `
                  + `${execution.deferReason ?? "none"}`,
              );
            })();
  result = writeExecutionResult({
    schema: "oliphaunt-bootstrap-execution-result-v1",
    operation: "publish-bootstrap",
    decision,
    deferralMode,
    source: { commit: lock.source.commit, tree: lock.source.tree },
    lock: {
      lockDigest: lock.lockDigest,
      catalogDigest: lock.catalogDigest,
      packageEnvelopeDigest: lock.packageEnvelopeDigest,
    },
    products: [...products].sort(),
    admittedIds: plan
      .filter(({ id }) => capacityAssessment.admittedCarrierIds.includes(id))
      .map(({ id }) => id),
    completedIds,
    newlyCompletedIds,
    remainingIds,
    notBeforeEpochSeconds,
  });
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
if (result.decision === "complete") {
  console.log(
    `completed ${execution.completedCarrierIds.length} dependency-ordered first-version Cargo/npm bootstrap mutation(s), `
      + `reconciled ${reconciliation.publicCarrierIds.length} lock-matching public version(s), `
      + `and sealed immutable checkpoint ${checkpoint.sequence} (${checkpoint.receipts.length}/${checkpoint.publications.length})`,
  );
} else {
  console.log(
    `checkpointed ${result.newlyCompletedIds.length} new exact bootstrap receipt(s); `
      + `${result.remainingIds.length} carrier(s) remain for a continuation no earlier than ${result.notBeforeEpochSeconds}`,
  );
}
