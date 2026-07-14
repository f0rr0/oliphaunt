#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
import process from "node:process";

import {
  assessCratesIoVersionCapacity,
  assertCratesIoVersionCapacity,
  cratesIoVersionCapacitySummary,
  inspectCratesIoVersionState,
  parseRegistryMutationDeadline,
} from "../../tools/release/crates-io-bootstrap-capacity.mjs";
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
  const plan = lockedCarriers(lock).filter(({ id }) => cargoCarrierIds.has(id));
  if (plan.length !== cargoCarrierIds.size) {
    throw new Error("normal publication plan and exact-lock Cargo carriers disagree");
  }
  const inventory = await inspectCratesIoVersionState({
    plan,
    deadlineEpochSeconds,
  });
  const assessment = assessCratesIoVersionCapacity({
    inventory,
    configuredCapacity: process.env.CRATES_IO_VERSION_RUN_CAPACITY,
    deadlineEpochSeconds,
  });
  const summary = cratesIoVersionCapacitySummary(assessment);
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY?.trim()) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  }
  assertCratesIoVersionCapacity(assessment);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
