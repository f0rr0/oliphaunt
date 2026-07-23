#!/usr/bin/env bun
import {
  appendFileSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { loadBootstrapLedger } from "./bootstrap-ledger.mjs";
import {
  DEFAULT_NORMAL_PUBLICATION_CHECKPOINT,
  openNormalPublicationCheckpoint,
} from "./normal-publication-checkpoint.mjs";
import { normalPublicationPlan } from "./normal-publication-plan.mjs";
import {
  assertPublicationLockSource,
  loadPublicationLock,
} from "./publication-lock.mjs";
import {
  stableJson,
  validateReleaseExecutionResult,
} from "./release-continuation-contract.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_RESULT = "target/release/normal-publication-execution-result.json";
const DEFAULT_PLAN = "target/release/normal-publication-plan.json";

function error(message) {
  return new Error(`record-normal-publication-capacity-deferral: ${message}`);
}

function required(name, environment = process.env) {
  const value = environment[name]?.trim();
  if (!value) throw error(`${name} is required`);
  return value;
}

function positiveInteger(value, context) {
  const rendered = String(value ?? "");
  if (!/^[1-9][0-9]*$/u.test(rendered) || !Number.isSafeInteger(Number(rendered))) {
    throw error(`${context} must be a positive safe integer`);
  }
  return Number(rendered);
}

function products(raw) {
  let value;
  try { value = JSON.parse(raw); } catch (cause) { throw error(`PRODUCTS_JSON must be strict JSON: ${cause.message}`); }
  if (
    !Array.isArray(value)
    || value.length === 0
    || value.some((item) => typeof item !== "string" || item.length === 0)
    || new Set(value).size !== value.length
  ) {
    throw error("PRODUCTS_JSON must be a nonempty unique string list");
  }
  return [...value].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
}

export function validateCapacityDeferralAdmission({
  continuationPointer,
  namesSatisfied,
  notBeforeEpochSeconds,
  requiredWindowSeconds,
  authoritativeWindowSeconds,
  forcedDeferralMode,
}) {
  if (namesSatisfied !== true) {
    throw error("pre-mutation capacity deferral requires every selected Cargo/npm identity to exist");
  }
  for (const [value, context] of [
    [notBeforeEpochSeconds, "not-before time"],
    [requiredWindowSeconds, "lock-derived required mutation window"],
    [authoritativeWindowSeconds, "authoritative mutation window"],
  ]) positiveInteger(value, context);
  if (requiredWindowSeconds > authoritativeWindowSeconds) {
    throw error(
      `lock-derived registry plan requires ${requiredWindowSeconds}s but the authoritative fresh window is only `
        + `${authoritativeWindowSeconds}s; increase the modeled window or split the release before retrying`,
    );
  }
  if (
    forcedDeferralMode !== undefined
    && forcedDeferralMode !== "pre-mutation-deadline"
  ) {
    throw error("forced deferral mode must be pre-mutation-deadline");
  }
  return {
    authoritativeWindowSeconds,
    deferralMode: forcedDeferralMode
      ?? (continuationPointer === "" ? "pre-mutation-capacity" : "pre-mutation-deadline"),
    namesSatisfied,
    notBeforeEpochSeconds,
    requiredWindowSeconds,
  };
}

export function buildCapacityDeferralResult({
  checkpoint,
  deferralMode = "pre-mutation-capacity",
  lock,
  notBeforeEpochSeconds,
  plan,
  products: selectedProducts,
}) {
  const completedIds = [...checkpoint.completedOperations];
  const completed = new Set(completedIds);
  const planIds = plan.operations.map(({ id }) => id);
  if (
    completedIds.some((id) => !planIds.includes(id))
    || new Set(completedIds).size !== completedIds.length
  ) {
    throw error("checkpoint completed operations are not an exact subset of the lock-derived plan");
  }
  const remainingIds = planIds.filter((id) => !completed.has(id));
  if (remainingIds.length === 0) {
    throw error("capacity cannot defer a registry plan that is already complete");
  }
  if (!new Set(["pre-mutation-capacity", "pre-mutation-deadline"]).has(deferralMode)) {
    throw error(`unsupported pre-mutation deferral mode ${JSON.stringify(deferralMode)}`);
  }
  const admittedIds = deferralMode === "pre-mutation-capacity"
    ? []
    : (() => {
        const operation = plan.operations.find(({ id, dependencies = [] }) =>
          !completed.has(id) && dependencies.every((dependency) => completed.has(dependency)));
        if (operation === undefined) {
          throw error("continuation deadline deferral cannot identify dependency-eligible remaining work");
        }
        return [operation.id];
      })();
  return validateReleaseExecutionResult({
    admittedIds,
    completedIds,
    decision: "deferred",
    deferralMode,
    lock: {
      catalogDigest: lock.catalogDigest,
      lockDigest: lock.lockDigest,
      packageEnvelopeDigest: lock.packageEnvelopeDigest,
    },
    newlyCompletedIds: [],
    notBeforeEpochSeconds,
    operation: "publish",
    products: selectedProducts,
    remainingIds,
    schema: "oliphaunt-normal-publication-execution-result-v1",
    source: { commit: lock.source.commit, tree: lock.source.tree },
  }, {
    lock: {
      catalogDigest: lock.catalogDigest,
      lockDigest: lock.lockDigest,
      packageEnvelopeDigest: lock.packageEnvelopeDigest,
    },
    operation: "publish",
    products: selectedProducts,
    releaseCommit: lock.source.commit,
    releaseTree: lock.source.tree,
  });
}

function atomicJson(file, value) {
  const absolute = path.resolve(file);
  mkdirSync(path.dirname(absolute), { recursive: true });
  const temporary = `${absolute}.tmp-${process.pid}`;
  rmSync(temporary, { force: true });
  let descriptor;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, absolute);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporary, { force: true });
  }
}

export async function main(environment = process.env) {
  const selectedProducts = products(required("PRODUCTS_JSON", environment));
  const releaseCommit = required("RELEASE_HEAD_SHA", environment);
  const admission = validateCapacityDeferralAdmission({
    authoritativeWindowSeconds: positiveInteger(
      required("NORMAL_REGISTRY_MUTATION_WINDOW_SECONDS", environment),
      "NORMAL_REGISTRY_MUTATION_WINDOW_SECONDS",
    ),
    continuationPointer: environment.RELEASE_CONTINUATION_POINTER?.trim() ?? "",
    forcedDeferralMode: environment.PRE_MUTATION_DEFERRAL_MODE?.trim() || undefined,
    namesSatisfied: required("CAPACITY_NAMES_SATISFIED", environment) === "true",
    notBeforeEpochSeconds: positiveInteger(
      required("CAPACITY_NOT_BEFORE_EPOCH", environment),
      "CAPACITY_NOT_BEFORE_EPOCH",
    ),
    requiredWindowSeconds: positiveInteger(
      required("CAPACITY_REQUIRED_WINDOW_SECONDS", environment),
      "CAPACITY_REQUIRED_WINDOW_SECONDS",
    ),
  });
  const lockFile = path.resolve(ROOT, required("PUBLICATION_LOCK_PATH", environment));
  const lock = loadPublicationLock(lockFile);
  assertPublicationLockSource(lock, releaseCommit);
  const plan = normalPublicationPlan(lock, selectedProducts);
  const frozenPlanFile = path.resolve(
    ROOT,
    environment.NORMAL_PUBLICATION_PLAN_PATH?.trim() || DEFAULT_PLAN,
  );
  let frozenPlan;
  try { frozenPlan = JSON.parse(readFileSync(frozenPlanFile, "utf8")); } catch (cause) {
    throw error(`cannot read exact frozen normal-publication plan: ${cause.message}`);
  }
  if (stableJson(frozenPlan) !== stableJson(plan)) {
    throw error("frozen normal-publication plan differs from the installed lock-derived plan");
  }
  const ledger = loadBootstrapLedger(
    environment.BOOTSTRAP_LEDGER_PATH?.trim() || "target/release/bootstrap-ledger",
    lock,
    selectedProducts,
    { allowEmpty: true, requireComplete: true },
  );
  const checkpoint = openNormalPublicationCheckpoint({
    file: path.resolve(
      ROOT,
      environment.NORMAL_PUBLICATION_CHECKPOINT_PATH?.trim()
        || DEFAULT_NORMAL_PUBLICATION_CHECKPOINT,
    ),
    initialReceipts: ledger?.receipts ?? [],
    lock,
    plan,
    products: selectedProducts,
  });
  const reconciled = await checkpoint.reconcileCompleted();
  if (reconciled.size !== checkpoint.checkpoint.completedOperations.length) {
    throw error("reconciled checkpoint operation count changed during pre-mutation admission");
  }
  const result = buildCapacityDeferralResult({
    checkpoint: checkpoint.checkpoint,
    deferralMode: admission.deferralMode,
    lock,
    notBeforeEpochSeconds: admission.notBeforeEpochSeconds,
    plan,
    products: selectedProducts,
  });
  const resultFile = path.resolve(
    ROOT,
    environment.OLIPHAUNT_NORMAL_PUBLICATION_EXECUTION_RESULT?.trim() || DEFAULT_RESULT,
  );
  atomicJson(resultFile, result);
  if (environment.GITHUB_OUTPUT) {
    appendFileSync(
      environment.GITHUB_OUTPUT,
      `complete=false\ndeferred=true\ndeferral_mode=${result.deferralMode}\nprogress_count=0\n`
        + `completed_count=${result.completedIds.length}\nremaining_count=${result.remainingIds.length}\n`
        + `not_before_epoch=${result.notBeforeEpochSeconds}\n`,
    );
  }
  console.log(
    `sealed ${result.deferralMode} deferral with ${result.completedIds.length} prior `
      + `checkpointed operation(s), ${result.remainingIds.length} remaining operation(s), and no mutation; `
      + `continuation is authorized no earlier than ${result.notBeforeEpochSeconds}`,
  );
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((cause) => {
    console.error(cause instanceof Error ? cause.message : String(cause));
    process.exit(1);
  });
}
