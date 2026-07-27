#!/usr/bin/env bun
import { appendFileSync, rmSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import {
  assessCratesIoVersionCapacity,
  assertCratesIoVersionCapacity,
  cratesIoVersionCapacitySummary,
  inspectCratesIoVersionState,
  parseRegistryMutationDeadline,
} from "../../tools/release/crates-io-bootstrap-capacity.mjs";
import { loadBootstrapLedger } from "../../tools/release/bootstrap-ledger.mjs";
import { inspectNpmVersionState } from "../../tools/release/frozen-npm-publish.mjs";
import {
  DEFAULT_NORMAL_PUBLICATION_ADMISSION,
  writeNormalPublicationAdmission,
} from "../../tools/release/normal-publication-admission.mjs";
import {
  DEFAULT_NORMAL_PUBLICATION_CHECKPOINT,
  openNormalPublicationCheckpoint,
} from "../../tools/release/normal-publication-checkpoint.mjs";
import { normalPublicationPlan } from "../../tools/release/normal-publication-plan.mjs";
import { loadPublicationLock, lockedCarriers } from "../../tools/release/publication-lock.mjs";

function fail(message) {
  console.error(`check-crates-io-publish-capacity: ${message}`);
  process.exit(1);
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) fail(`${name} is required`);
  return value;
}

function positiveIntegerEnv(name) {
  const raw = requiredEnv(name);
  if (!/^[1-9][0-9]*$/u.test(raw) || !Number.isSafeInteger(Number(raw))) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return Number(raw);
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

try {
  const deadlineEpochSeconds = parseRegistryMutationDeadline(
    requiredEnv("REGISTRY_MUTATION_DEADLINE_EPOCH"),
  );
  const lock = loadPublicationLock(requiredEnv("PUBLICATION_LOCK_PATH"));
  const normalPlan = normalPublicationPlan(lock, products);
  const cargoCarrierIds = new Set(normalPlan.operations
    .filter(({ ecosystem }) => ecosystem === "cargo")
    .map(({ carrierId }) => carrierId));
  const npmCarrierIds = new Set(normalPlan.operations
    .filter(({ ecosystem }) => ecosystem === "npm")
    .map(({ carrierId }) => carrierId));
  const carriers = lockedCarriers(lock);
  const cargoPlan = carriers.filter(({ id }) => cargoCarrierIds.has(id));
  const npmPlan = carriers.filter(({ id }) => npmCarrierIds.has(id));
  if (cargoPlan.length !== cargoCarrierIds.size) {
    throw new Error("normal publication plan and exact-lock Cargo carriers disagree");
  }
  if (npmPlan.length !== npmCarrierIds.size) {
    throw new Error("normal publication plan and exact-lock npm carriers disagree");
  }
  const [inventory, npmInventory] = await Promise.all([
    inspectCratesIoVersionState({ plan: cargoPlan, deadlineEpochSeconds }),
    inspectNpmVersionState({ plan: npmPlan, deadlineEpochSeconds }),
  ]);
  const ledger = loadBootstrapLedger(
    process.env.BOOTSTRAP_LEDGER_PATH?.trim() || "target/release/bootstrap-ledger",
    lock,
    products,
    { allowEmpty: true, requireComplete: true },
  );
  const receiptIds = new Set((ledger?.receipts ?? []).map(({ id }) => id));
  const checkpoint = openNormalPublicationCheckpoint({
    file: process.env.NORMAL_PUBLICATION_CHECKPOINT_PATH?.trim()
      || DEFAULT_NORMAL_PUBLICATION_CHECKPOINT,
    initialReceipts: ledger?.receipts ?? [],
    lock,
    plan: normalPlan,
    products,
  });
  const authoritativeWindowSeconds = positiveIntegerEnv(
    "NORMAL_REGISTRY_MUTATION_WINDOW_SECONDS",
  );
  const assessment = assessCratesIoVersionCapacity({
    inventory,
    npmInventory,
    normalPlan,
    reconciledCarrierIds: [...receiptIds],
    completedOperationIds: checkpoint.checkpoint.completedOperations,
    authoritativeWindowSeconds,
    deadlineEpochSeconds,
  });
  const summary = cratesIoVersionCapacitySummary(assessment);
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY?.trim()) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  }
  assertCratesIoVersionCapacity(assessment);
  const admissionFile = path.resolve(
    process.env.NORMAL_PUBLICATION_ADMISSION_PATH?.trim()
      || DEFAULT_NORMAL_PUBLICATION_ADMISSION,
  );
  rmSync(admissionFile, { force: true });
  const admission = assessment.decision === "execute"
    ? writeNormalPublicationAdmission(admissionFile, {
        assessment,
        checkpoint: checkpoint.checkpoint,
        lock,
        plan: normalPlan,
        products,
      })
    : null;
  if (
    assessment.decision === "defer"
    && (!assessment.namesSatisfied
      || !Number.isSafeInteger(assessment.notBeforeEpochSeconds)
      || assessment.notBeforeEpochSeconds < 1)
  ) {
    throw new Error(
      "pre-mutation capacity deferral requires existing identities and a positive authoritative not-before time",
    );
  }
  if (process.env.GITHUB_OUTPUT?.trim()) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `admission=${assessment.decision}\n`
        + `deferred=${assessment.decision === "defer" ? "true" : "false"}\n`
        + `names_satisfied=${assessment.namesSatisfied ? "true" : "false"}\n`
        + `not_before_epoch=${assessment.notBeforeEpochSeconds ?? 0}\n`
        + `required_window_seconds=${assessment.minimumMutationWindowSeconds}\n`
        + `authoritative_window_seconds=${authoritativeWindowSeconds}\n`
        + `admitted_operation_ids_json=${JSON.stringify(assessment.admittedOperationIds)}\n`
        + `unadmitted_operation_ids_json=${JSON.stringify(assessment.unadmittedOperationIds)}\n`
        + `complete_after_admission=${assessment.publicationCompleteAfterAdmission ? "true" : "false"}\n`
        + `admission_file=${admission === null ? "" : admissionFile}\n`
        + `admission_digest=${admission?.admissionDigest ?? ""}\n`,
    );
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
