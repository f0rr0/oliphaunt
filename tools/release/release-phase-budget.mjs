#!/usr/bin/env node

import { appendFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { RELEASE_MINIMUM_FINALIZATION_SECONDS } from "./release-finalization-budget.mjs";

export const GITHUB_STAGE_JOB_TIMEOUT_SECONDS = 360 * 60;
export const GITHUB_STAGE_JOB_HARD_WINDOW_SECONDS = 350 * 60;
export const GITHUB_STAGE_JOB_CLEANUP_SECONDS = 10 * 60;
export const GITHUB_STAGE_HANDOFF_ALLOWANCE_SECONDS = 30 * 60;

export const REGISTRY_JOB_TIMEOUT_SECONDS = 360 * 60;
export const REGISTRY_JOB_HARD_WINDOW_SECONDS = 350 * 60;
export const REGISTRY_JOB_CLEANUP_SECONDS = 10 * 60;
export const REGISTRY_EXACT_INPUT_TRANSFER_ALLOWANCE_SECONDS = 70 * 60;
export const REGISTRY_SETUP_ALLOWANCE_SECONDS = 45 * 60;
export const REGISTRY_INPUT_VALIDATION_ALLOWANCE_SECONDS = 25 * 60;
// At crates.io's documented default version bucket, the current exact carrier
// scale completes in under 174 minutes including the executor reserve. A
// 190-minute lane admits that graph while retaining the existing conservative
// transfer/setup/validation allowances and a strict five-minute hard-window
// margin. Larger future locks close an immutable checkpoint and continue.
export const REGISTRY_MUTATION_ALLOWANCE_SECONDS = 190 * 60;
export const REGISTRY_EVIDENCE_HANDOFF_ALLOWANCE_SECONDS = 15 * 60;

export const FINALIZE_JOB_TIMEOUT_SECONDS = 120 * 60;
export const FINALIZE_JOB_HARD_WINDOW_SECONDS = 114 * 60;
export const FINALIZE_JOB_CLEANUP_SECONDS = 6 * 60;
// Includes checkout, exact handoff installation, digest-verified Node/npm and
// the remaining finalization toolchains. The resulting phase still preserves
// a six-minute hard-window margin before the independent cleanup reserve.
export const FINALIZE_SETUP_HANDOFF_ALLOWANCE_SECONDS = 60 * 60;

export const RELEASE_PHASE_BUDGETS = Object.freeze({
  "github-staged": Object.freeze({
    jobTimeoutSeconds: GITHUB_STAGE_JOB_TIMEOUT_SECONDS,
    hardWindowSeconds: GITHUB_STAGE_JOB_HARD_WINDOW_SECONDS,
    cleanupSeconds: GITHUB_STAGE_JOB_CLEANUP_SECONDS,
    fixedComponents: Object.freeze({
      immutableHandoffSealAndUpload: GITHUB_STAGE_HANDOFF_ALLOWANCE_SECONDS,
    }),
  }),
  "registry-published": Object.freeze({
    jobTimeoutSeconds: REGISTRY_JOB_TIMEOUT_SECONDS,
    hardWindowSeconds: REGISTRY_JOB_HARD_WINDOW_SECONDS,
    cleanupSeconds: REGISTRY_JOB_CLEANUP_SECONDS,
    fixedComponents: Object.freeze({
      checkoutToolchainsAndAuthentication: REGISTRY_SETUP_ALLOWANCE_SECONDS,
      exactApprovedInputTransfer: REGISTRY_EXACT_INPUT_TRANSFER_ALLOWANCE_SECONDS,
      exactInputValidationAndPreMutationGates: REGISTRY_INPUT_VALIDATION_ALLOWANCE_SECONDS,
      registryMutation: REGISTRY_MUTATION_ALLOWANCE_SECONDS,
      evidenceRecoveryAndHandoff: REGISTRY_EVIDENCE_HANDOFF_ALLOWANCE_SECONDS,
    }),
  }),
  "github-finalized": Object.freeze({
    jobTimeoutSeconds: FINALIZE_JOB_TIMEOUT_SECONDS,
    hardWindowSeconds: FINALIZE_JOB_HARD_WINDOW_SECONDS,
    cleanupSeconds: FINALIZE_JOB_CLEANUP_SECONDS,
    fixedComponents: Object.freeze({
      checkoutToolchainsAndReceiptHandoff: FINALIZE_SETUP_HANDOFF_ALLOWANCE_SECONDS,
      boundedVerificationConsumersAndPromotion: RELEASE_MINIMUM_FINALIZATION_SECONDS,
    }),
  }),
});

function error(message) {
  return new Error(`release-phase-budget: ${message}`);
}

function positiveInteger(value, context) {
  if (!/^[1-9][0-9]*$/u.test(String(value ?? ""))) {
    throw error(`${context} must be a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw error(`${context} is outside the safe integer range`);
  return parsed;
}

function sumComponents(components) {
  return Object.values(components).reduce((total, seconds) => total + seconds, 0);
}

/**
 * Prove that one normal-release phase fits its own fresh job deadline.
 *
 * The GitHub stage admission is live-topology-derived, so its operation bound
 * is supplied by github-release-request-budget.mjs. Registry input transfer is
 * likewise accepted as a live bound but cannot exceed the enclosing 70-minute
 * exact-ID download step. The other phase bounds are literal workflow step
 * ceilings and deliberately include runner/action transition margin.
 */
export function assertReleasePhaseBudget(phase, {
  stageOperationSeconds,
  registryTransferSeconds = REGISTRY_EXACT_INPUT_TRANSFER_ALLOWANCE_SECONDS,
} = {}) {
  const budget = RELEASE_PHASE_BUDGETS[phase];
  if (budget === undefined) throw error(`unsupported phase ${JSON.stringify(phase)}`);
  const components = { ...budget.fixedComponents };
  if (phase === "github-staged") {
    components.liveGithubStageOperation = positiveInteger(
      stageOperationSeconds,
      "GitHub stage operation bound",
    );
  }
  if (phase === "registry-published") {
    const transfer = positiveInteger(registryTransferSeconds, "registry input transfer bound");
    if (transfer > REGISTRY_EXACT_INPUT_TRANSFER_ALLOWANCE_SECONDS) {
      throw error(
        `registry input transfer bound ${transfer}s exceeds the `
          + `${REGISTRY_EXACT_INPUT_TRANSFER_ALLOWANCE_SECONDS}s exact-download allowance`,
      );
    }
    components.exactApprovedInputTransfer = transfer;
  }
  for (const [name, seconds] of Object.entries(components)) {
    if (!Number.isSafeInteger(seconds) || seconds < 1) {
      throw error(`${phase}.${name} must be a positive safe integer`);
    }
  }
  if (budget.jobTimeoutSeconds - budget.hardWindowSeconds !== budget.cleanupSeconds) {
    throw error(`${phase} hard window does not preserve its exact cleanup reserve`);
  }
  const operationSeconds = sumComponents(components);
  const hardWindowMarginSeconds = budget.hardWindowSeconds - operationSeconds;
  if (hardWindowMarginSeconds <= 0) {
    throw error(
      `${phase} needs ${operationSeconds}s before cleanup, not less than its `
        + `${budget.hardWindowSeconds}s hard window`,
    );
  }
  const totalAccountedSeconds = operationSeconds + hardWindowMarginSeconds + budget.cleanupSeconds;
  if (totalAccountedSeconds !== budget.jobTimeoutSeconds) {
    throw error(`${phase} accounting does not exactly cover its job timeout`);
  }
  return {
    phase,
    components,
    operationSeconds,
    hardWindowSeconds: budget.hardWindowSeconds,
    hardWindowMarginSeconds,
    cleanupSeconds: budget.cleanupSeconds,
    jobTimeoutSeconds: budget.jobTimeoutSeconds,
    totalAccountedSeconds,
  };
}

export function releasePhaseHardDeadlineEpoch(phase, nowEpochSeconds) {
  const budget = RELEASE_PHASE_BUDGETS[phase];
  if (budget === undefined) throw error(`unsupported phase ${JSON.stringify(phase)}`);
  return positiveInteger(nowEpochSeconds, "current Unix time") + budget.hardWindowSeconds;
}

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!new Set([
      "--phase",
      "--stage-operation-seconds",
      "--registry-transfer-seconds",
      "--github-output",
    ]).has(flag) || value === undefined) {
      throw error(
        "usage: release-phase-budget.mjs --phase PHASE "
          + "[--stage-operation-seconds SECONDS] [--registry-transfer-seconds SECONDS] "
          + "[--github-output FILE]",
      );
    }
    if (values.has(flag)) throw error(`${flag} may be supplied only once`);
    values.set(flag, value);
  }
  if (!values.has("--phase")) throw error("--phase is required");
  return values;
}

function main(argv) {
  const values = parseArgs(argv);
  const report = assertReleasePhaseBudget(values.get("--phase"), {
    stageOperationSeconds: values.get("--stage-operation-seconds"),
    registryTransferSeconds: values.get("--registry-transfer-seconds")
      ?? REGISTRY_EXACT_INPUT_TRANSFER_ALLOWANCE_SECONDS,
  });
  const output = values.get("--github-output");
  if (output !== undefined) {
    appendFileSync(output, [
      `phase=${report.phase}`,
      `operation_seconds=${report.operationSeconds}`,
      `hard_window_seconds=${report.hardWindowSeconds}`,
      `hard_window_margin_seconds=${report.hardWindowMarginSeconds}`,
      `cleanup_seconds=${report.cleanupSeconds}`,
      `job_timeout_seconds=${report.jobTimeoutSeconds}`,
      "",
    ].join("\n"));
  }
  console.log(JSON.stringify(report, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (cause) {
    console.error(cause instanceof Error ? cause.message : String(cause));
    process.exit(1);
  }
}
