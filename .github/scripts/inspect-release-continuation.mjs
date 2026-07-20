#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  parseContinuationJson,
  stableJson,
  validateReleaseContinuationPointer,
} from "../../tools/release/release-continuation-contract.mjs";
import {
  currentRunMetadata,
  openContinuationEnvelope,
  readContinuationAuthorization,
  readExactContinuationArtifact,
  validateContinuationRunLineage,
} from "./release-continuation-artifact.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function error(message) {
  return new Error(`inspect-release-continuation: ${message}`);
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

function json(raw, context) {
  try { return JSON.parse(raw); } catch (cause) { throw error(`${context} must be strict JSON: ${cause.message}`); }
}

function products(raw) {
  const value = json(raw, "PRODUCTS_JSON");
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

function gitTree(releaseCommit) {
  const result = spawnSync("git", ["rev-parse", `${releaseCommit}^{tree}`], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error !== undefined || result.status !== 0 || !/^[0-9a-f]{40,64}\s*$/u.test(result.stdout)) {
    throw error(`cannot resolve exact release tree: ${(result.stderr || result.error?.message || "").trim()}`);
  }
  return result.stdout.trim();
}

function atomicBytes(file, bytes) {
  const absolute = path.resolve(file);
  mkdirSync(path.dirname(absolute), { recursive: true });
  const temporary = `${absolute}.tmp-${process.pid}`;
  let descriptor;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, bytes);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, absolute);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    try { unlinkSync(temporary); } catch {}
  }
}

function emit(output, key, value) {
  appendFileSync(output, `${key}=${typeof value === "string" ? value : JSON.stringify(value)}\n`);
}

export async function main(environment = process.env) {
  const output = environment.GITHUB_OUTPUT;
  const rawPointer = environment.RELEASE_CONTINUATION_POINTER?.trim() ?? "";
  if (rawPointer === "") {
    if (output) emit(output, "found", "false");
    console.log("no automatic release continuation pointer was supplied");
    return null;
  }
  if (rawPointer.length > 32 * 1024) throw error("RELEASE_CONTINUATION_POINTER exceeds 32 KiB");
  const repo = required("GH_REPO", environment);
  const operation = required("RELEASE_OPERATION", environment);
  const releaseCommit = required("RELEASE_HEAD_SHA", environment);
  const currentRunId = positiveInteger(required("GITHUB_RUN_ID", environment), "GITHUB_RUN_ID");
  const currentProducts = products(required("PRODUCTS_JSON", environment));
  const pointer = validateReleaseContinuationPointer(
    parseContinuationJson(rawPointer, "RELEASE_CONTINUATION_POINTER"),
    { operation, releaseCommit },
  );
  const exact = readExactContinuationArtifact(repo, pointer);
  const current = currentRunMetadata(repo, currentRunId);
  validateContinuationRunLineage({
    current: { id: currentRunId, metadata: current },
    parent: exact.parent,
    root: exact.root,
  }, pointer);
  readContinuationAuthorization(repo, pointer, currentRunId);
  const envelope = openContinuationEnvelope(exact.bytes, pointer);
  const tree = gitTree(releaseCommit);
  if (envelope.contract.source.tree !== tree) {
    throw error("continuation contract release tree does not match the exact checked-out commit");
  }
  if (stableJson(envelope.contract.products) !== stableJson(currentProducts)) {
    throw error("continuation products do not match the current exact release plan");
  }
  const cache = required("RELEASE_CONTINUATION_ARCHIVE", environment);
  atomicBytes(cache, exact.bytes);
  let continuedPacerPath = null;
  let continuedJournalPath = null;
  if (operation === "publish") {
    continuedPacerPath = required("RELEASE_CONTINUATION_GITHUB_PACER_PATH", environment);
    continuedJournalPath = required(
      "RELEASE_CONTINUATION_GITHUB_CORE_JOURNAL_PATH",
      environment,
    );
    atomicBytes(continuedPacerPath, envelope.githubPacerBytes);
    atomicBytes(continuedJournalPath, envelope.githubCoreJournalBytes);
  }
  if (output) {
    emit(output, "found", "true");
    emit(output, "products_json", envelope.contract.products);
    emit(output, "approved_run_id", envelope.contract.approvedPublication.runId);
    emit(output, "approved_artifact_metadata_json", envelope.contract.approvedPublication.artifacts);
    emit(output, "root_run_id", envelope.contract.lineage.rootRunId);
    emit(output, "generation", envelope.contract.lineage.generation);
    emit(output, "max_generations", envelope.contract.lineage.maxGenerations);
    emit(output, "contract_digest", envelope.contract.contractDigest);
    if (operation === "publish") {
      emit(output, "continued_github_pacer_path", path.resolve(continuedPacerPath));
      emit(output, "continued_github_core_journal_path", path.resolve(continuedJournalPath));
      emit(output, "continued_github_state_json", envelope.contract.githubState);
    }
    if (envelope.contract.stageHandoff !== null) {
      emit(output, "stage_handoff_run_id", envelope.contract.stageHandoff.runId);
      emit(output, "stage_handoff_artifact_id", envelope.contract.stageHandoff.artifact.id);
      emit(output, "stage_handoff_artifact_name", envelope.contract.stageHandoff.artifact.name);
      emit(output, "stage_handoff_artifact_digest", envelope.contract.stageHandoff.artifact.digest);
      emit(output, "stage_handoff_artifact_size", envelope.contract.stageHandoff.artifact.size);
      emit(output, "stage_handoff_artifact_metadata_json", [envelope.contract.stageHandoff.artifact]);
    }
  }
  console.log(
    `verified ${operation} continuation generation ${envelope.contract.lineage.generation}/`
      + `${envelope.contract.lineage.maxGenerations} from exact parent run ${pointer.parentRunId}, `
      + `artifact ${pointer.artifact.id}`,
  );
  return envelope;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((cause) => {
    console.error(cause instanceof Error ? cause.message : String(cause));
    process.exit(1);
  });
}
