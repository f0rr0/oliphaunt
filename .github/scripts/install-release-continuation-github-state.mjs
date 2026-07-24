#!/usr/bin/env node

import { appendFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { installContinuationGitHubState } from "../../tools/release/github-release-continuation-state.mjs";

function error(message) {
  return new Error(`install-release-continuation-github-state: ${message}`);
}

function required(name, environment) {
  const value = environment[name]?.trim();
  if (!value) throw error(`${name} is required`);
  return value;
}

function positiveInteger(name, environment) {
  const raw = required(name, environment);
  if (!/^[1-9][0-9]*$/u.test(raw) || !Number.isSafeInteger(Number(raw))) {
    throw error(`${name} must be a positive safe integer`);
  }
  return Number(raw);
}

function optionalPair(environment, leftName, rightName) {
  const left = environment[leftName]?.trim() ?? "";
  const right = environment[rightName]?.trim() ?? "";
  if ((left === "") !== (right === "")) {
    throw error(`${leftName} and ${rightName} must be supplied together`);
  }
  return left === "" ? null : { left, right };
}

function expectedState(environment, continued) {
  const raw = environment.RELEASE_CONTINUATION_GITHUB_STATE_JSON?.trim() ?? "";
  if (continued === null) {
    if (raw !== "") throw error("root registry state must not claim a parent continuation identity");
    return undefined;
  }
  if (raw === "") throw error("continued registry state requires RELEASE_CONTINUATION_GITHUB_STATE_JSON");
  try {
    return JSON.parse(raw);
  } catch (cause) {
    throw error(`RELEASE_CONTINUATION_GITHUB_STATE_JSON must be strict JSON: ${cause.message}`);
  }
}

export function main(environment = process.env) {
  const continued = optionalPair(
    environment,
    "RELEASE_CONTINUATION_GITHUB_PACER_PATH",
    "RELEASE_CONTINUATION_GITHUB_CORE_JOURNAL_PATH",
  );
  const result = installContinuationGitHubState({
    destinationJournal: required("OLIPHAUNT_GITHUB_CORE_REQUEST_JOURNAL_PATH", environment),
    destinationPacer: required("OLIPHAUNT_GITHUB_CONTENT_WRITE_PACER_PATH", environment),
    earlyJournal: required("PREINSTALL_GITHUB_CORE_JOURNAL_PATH", environment),
    expectedLatestState: expectedState(environment, continued),
    latestJournal: continued?.right,
    latestPacer: continued?.left,
    lineage: {
      headSha: required("RELEASE_HEAD_SHA", environment),
      repository: required("GITHUB_REPOSITORY", environment),
      rootRunId: required("OLIPHAUNT_RELEASE_ROOT_RUN_ID", environment),
    },
    originalJournal: required("ORIGINAL_GITHUB_CORE_JOURNAL_PATH", environment),
    originalPacer: required("ORIGINAL_GITHUB_PACER_PATH", environment),
    source: {
      runAttempt: positiveInteger("GITHUB_RUN_ATTEMPT", environment),
      runId: positiveInteger("GITHUB_RUN_ID", environment),
    },
  });
  if (environment.GITHUB_OUTPUT) {
    appendFileSync(environment.GITHUB_OUTPUT, `github_state_json=${JSON.stringify(result)}\n`);
  }
  console.log(
    `installed continuation-safe GitHub state: pacer sequence ${result.pacer.sequence}, `
      + `core-request sequence ${result.coreRequestJournal.sequence}`,
  );
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (cause) {
    console.error(cause instanceof Error ? cause.message : String(cause));
    process.exit(1);
  }
}
