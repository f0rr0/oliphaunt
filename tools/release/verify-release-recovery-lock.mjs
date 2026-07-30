#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { captureCommandOutput } from "../dev/capture-command-output.mjs";
import { ROOT } from "./release-graph.mjs";
import { loadPublicationLock } from "./publication-lock.mjs";

const TOOL = "verify-release-recovery-lock.mjs";
export const RELEASE_RECOVERY_LOCK_EQUIVALENCE_SCHEMA =
  "oliphaunt-release-recovery-lock-equivalence-v2";
const SHA = /^[0-9a-f]{40}$/u;
const HASH = /^[0-9a-f]{64}$/u;
const ARTIFACT_DIGEST = /^sha256:[0-9a-f]{64}$/u;

function error(message) {
  return new Error(`${TOOL}: ${message}`);
}

function gitCommitAndTree(repo, ref) {
  const result = captureCommandOutput(
    "git",
    ["show", "-s", "--format=%H%n%T", `${ref}^{commit}`],
    { cwd: repo, label: `git show -s --format=%H%n%T ${ref}^{commit}` },
  );
  if (result.error !== undefined || result.status !== 0) {
    const detail = (result.stderr || result.stdout || result.error?.message || "").trim();
    throw error(`cannot resolve ${ref}${detail ? `: ${detail}` : ""}`);
  }
  const [commit, tree, ...extra] = result.stdout.trimEnd().split("\n");
  if (!SHA.test(commit) || !SHA.test(tree) || extra.length > 0) {
    throw error(`${ref} did not resolve to one commit/tree identity`);
  }
  return { commit, tree };
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonical(value));
}

function requireLockIdentity(lock, expected, context) {
  if (
    lock?.source?.commit !== expected.commit
    || lock?.source?.tree !== expected.tree
  ) {
    throw error(
      `${context} source ${lock?.source?.commit ?? "<missing>"}/`
        + `${lock?.source?.tree ?? "<missing>"} does not match `
        + `${expected.commit}/${expected.tree}`,
    );
  }
  if (!HASH.test(lock.lockDigest)) {
    throw error(`${context} has an invalid lockDigest`);
  }
}

function originalLockArtifactEvidence(value) {
  if (
    value === null
    || Array.isArray(value)
    || typeof value !== "object"
    || !Number.isSafeInteger(value.runId)
    || value.runId < 1
    || !Array.isArray(value.artifacts)
    || value.artifacts.length !== 1
  ) {
    throw error("original lock evidence must identify one positive run and one artifact");
  }
  const [artifact] = value.artifacts;
  if (
    artifact === null
    || Array.isArray(artifact)
    || typeof artifact !== "object"
    || artifact.name !== "oliphaunt-publication-lock"
    || !Number.isSafeInteger(artifact.id)
    || artifact.id < 1
    || !Number.isSafeInteger(artifact.size)
    || artifact.size < 1
    || !ARTIFACT_DIGEST.test(artifact.digest ?? "")
    || Object.keys(artifact).sort().join(",") !== "digest,id,name,size"
  ) {
    throw error(
      "original lock evidence artifact must be the exact id/digest/size-bound "
        + "oliphaunt-publication-lock",
    );
  }
  return {
    workflow: "Release",
    runId: value.runId,
    artifact: {
      digest: artifact.digest,
      id: artifact.id,
      name: artifact.name,
      size: artifact.size,
    },
  };
}

export function verifyReleaseRecoveryLockEquivalence({
  original,
  replay,
  releaseSource,
  controllerSource,
  originalEvidence,
} = {}) {
  if (!SHA.test(releaseSource?.commit ?? "") || !SHA.test(releaseSource?.tree ?? "")) {
    throw error("releaseSource must contain lowercase full commit/tree SHAs");
  }
  if (
    !SHA.test(controllerSource?.commit ?? "")
    || !SHA.test(controllerSource?.tree ?? "")
  ) {
    throw error("controllerSource must contain lowercase full commit/tree SHAs");
  }
  if (
    releaseSource.commit === controllerSource.commit
    || releaseSource.tree === controllerSource.tree
  ) {
    throw error("recovery controller must have a distinct commit and tree");
  }
  requireLockIdentity(original, releaseSource, "original publication lock");
  requireLockIdentity(replay, releaseSource, "replayed publication lock");
  const originalLockArtifact = originalLockArtifactEvidence(originalEvidence);

  const comparedFields = [...new Set([
    ...Object.keys(original),
    ...Object.keys(replay),
  ])].sort();
  for (const field of comparedFields) {
    if (canonicalJson(original[field]) !== canonicalJson(replay[field])) {
      throw error(
        `replayed publication lock changes ${field}; `
          + "the existing version cannot be recovered and must not be republished",
      );
    }
  }

  const receipt = {
    schema: RELEASE_RECOVERY_LOCK_EQUIVALENCE_SCHEMA,
    releaseSource,
    controllerSource,
    originalLockDigest: original.lockDigest,
    replayLockDigest: replay.lockDigest,
    originalLockArtifact,
    catalogDigest: replay.catalogDigest,
    packageEnvelopeDigest: replay.packageEnvelopeDigest,
    productCount: replay.products.length,
    carrierCount: replay.carriers.length,
    productArtifactCount: replay.productArtifacts.length,
    comparedFields,
  };
  return {
    ...receipt,
    evidenceDigest: createHash("sha256").update(canonicalJson(receipt)).digest("hex"),
  };
}

function parseArgs(argv) {
  const options = {
    originalLock: "",
    replayLock: "",
    releaseSha: "",
    controllerSha: "",
    originalRunId: "",
    originalArtifactMetadataJson: "",
    output: "",
  };
  const flags = new Map([
    ["--original-lock", "originalLock"],
    ["--replay-lock", "replayLock"],
    ["--release-sha", "releaseSha"],
    ["--controller-sha", "controllerSha"],
    ["--original-run-id", "originalRunId"],
    ["--original-artifact-metadata-json", "originalArtifactMetadataJson"],
    ["--output", "output"],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const key = flags.get(argv[index]);
    if (key === undefined) throw error(`unknown argument ${argv[index]}`);
    options[key] = argv[index + 1] ?? "";
    index += 1;
  }
  if (Object.values(options).some((value) => !value)) {
    throw error(
      "usage: verify-release-recovery-lock.mjs "
        + "--original-lock FILE --replay-lock FILE "
        + "--release-sha SHA --controller-sha SHA "
        + "--original-run-id ID --original-artifact-metadata-json JSON --output FILE",
    );
  }
  if (!SHA.test(options.releaseSha) || !SHA.test(options.controllerSha)) {
    throw error("--release-sha and --controller-sha must be lowercase full commit SHAs");
  }
  if (!/^[1-9][0-9]*$/u.test(options.originalRunId)) {
    throw error("--original-run-id must be a positive integer");
  }
  try {
    options.originalArtifactMetadata = JSON.parse(options.originalArtifactMetadataJson);
  } catch (cause) {
    throw error(`--original-artifact-metadata-json is invalid JSON: ${cause.message}`);
  }
  return options;
}

if (import.meta.main) {
  try {
    const options = parseArgs(Bun.argv.slice(2));
    const original = loadPublicationLock(path.resolve(options.originalLock));
    const replay = loadPublicationLock(path.resolve(options.replayLock));
    const receipt = verifyReleaseRecoveryLockEquivalence({
      original,
      replay,
      releaseSource: gitCommitAndTree(ROOT, options.releaseSha),
      controllerSource: gitCommitAndTree(ROOT, options.controllerSha),
      originalEvidence: {
        runId: Number(options.originalRunId),
        artifacts: options.originalArtifactMetadata,
      },
    });
    const output = path.resolve(options.output);
    mkdirSync(path.dirname(output), { recursive: true });
    writeFileSync(output, `${JSON.stringify(receipt, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o644,
    });
    console.log(
      `verified exact same-version recovery replay for ${receipt.carrierCount} carrier(s) `
        + `and ${receipt.productArtifactCount} product artifact(s)`,
    );
  } catch (cause) {
    console.error(cause instanceof Error ? cause.message : String(cause));
    process.exit(1);
  }
}
