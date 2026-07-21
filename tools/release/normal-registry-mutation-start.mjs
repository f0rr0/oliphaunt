#!/usr/bin/env node

import { appendFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

function error(message) {
  return new Error(`normal-registry-mutation-start: ${message}`);
}

function positiveInteger(value, context) {
  const rendered = String(value ?? "");
  if (!/^[1-9][0-9]*$/u.test(rendered) || !Number.isSafeInteger(Number(rendered))) {
    throw error(`${context} must be a positive safe integer`);
  }
  return Number(rendered);
}

export function decideNormalRegistryMutationStart({
  authoritativeWindowSeconds,
  evidenceHandoffReserveSeconds,
  jobHardDeadlineEpochSeconds,
  nowEpochSeconds,
  requiredWindowSeconds,
}) {
  const authoritativeWindow = positiveInteger(
    authoritativeWindowSeconds,
    "authoritative mutation window",
  );
  const evidenceReserve = positiveInteger(
    evidenceHandoffReserveSeconds,
    "evidence handoff reserve",
  );
  const hardDeadline = positiveInteger(jobHardDeadlineEpochSeconds, "registry job hard deadline");
  const now = positiveInteger(nowEpochSeconds, "current Unix time");
  const requiredWindow = positiveInteger(requiredWindowSeconds, "admitted required window");
  const authoritativeDeadline = now + authoritativeWindow;
  const handoffDeadline = hardDeadline - evidenceReserve;
  if (!Number.isSafeInteger(authoritativeDeadline) || !Number.isSafeInteger(handoffDeadline)) {
    throw error("derived registry mutation deadline exceeds the safe integer range");
  }
  const mutationDeadline = Math.min(authoritativeDeadline, handoffDeadline);
  const availableWindowSeconds = mutationDeadline - now;
  if (!Number.isSafeInteger(availableWindowSeconds)) {
    throw error("derived registry mutation capacity exceeds the safe integer range");
  }
  if (availableWindowSeconds < requiredWindow) {
    if (!Number.isSafeInteger(now + 1)) throw error("continuation not-before time exceeds safe integer range");
    return {
      admission: "defer",
      availableWindowSeconds: Math.max(0, availableWindowSeconds),
      mutationDeadlineEpochSeconds: null,
      notBeforeEpochSeconds: now + 1,
      requiredWindowSeconds: requiredWindow,
    };
  }
  return {
    admission: "execute",
    availableWindowSeconds,
    mutationDeadlineEpochSeconds: mutationDeadline,
    notBeforeEpochSeconds: null,
    requiredWindowSeconds: requiredWindow,
  };
}

function required(name, environment) {
  const value = environment[name]?.trim();
  if (!value) throw error(`${name} is required`);
  return value;
}

export function main(environment = process.env, nowEpochSeconds = Math.floor(Date.now() / 1000)) {
  const decision = decideNormalRegistryMutationStart({
    authoritativeWindowSeconds: required("NORMAL_REGISTRY_MUTATION_WINDOW_SECONDS", environment),
    evidenceHandoffReserveSeconds: required(
      "REGISTRY_EVIDENCE_HANDOFF_RESERVE_SECONDS",
      environment,
    ),
    jobHardDeadlineEpochSeconds: required("REGISTRY_JOB_HARD_DEADLINE_EPOCH", environment),
    nowEpochSeconds,
    requiredWindowSeconds: required("REQUIRED_WINDOW_SECONDS", environment),
  });
  const output = required("GITHUB_OUTPUT", environment);
  appendFileSync(output, [
    `admission=${decision.admission}`,
    `available_window_seconds=${decision.availableWindowSeconds}`,
    `mutation_deadline_epoch=${decision.mutationDeadlineEpochSeconds ?? 0}`,
    `not_before_epoch=${decision.notBeforeEpochSeconds ?? 0}`,
    "",
  ].join("\n"));
  if (decision.admission === "execute") {
    appendFileSync(
      required("GITHUB_ENV", environment),
      `REGISTRY_MUTATION_DEADLINE_EPOCH=${decision.mutationDeadlineEpochSeconds}\n`,
    );
    console.log(
      `registry mutation admitted with ${decision.availableWindowSeconds}s available before protected handoff; `
        + `authoritative deadline is ${decision.mutationDeadlineEpochSeconds}`,
    );
  } else {
    console.log(
      `registry mutation start deferred without mutation: ${decision.availableWindowSeconds}s remain but `
        + `${decision.requiredWindowSeconds}s were admitted; continuation is allowed after `
        + `${decision.notBeforeEpochSeconds}`,
    );
  }
  return decision;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (cause) {
    console.error(cause instanceof Error ? cause.message : String(cause));
    process.exit(1);
  }
}
