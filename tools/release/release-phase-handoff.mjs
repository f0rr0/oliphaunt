#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  closeSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { normalPublicationPlan } from "./normal-publication-plan.mjs";
import { openNormalPublicationCheckpoint } from "./normal-publication-checkpoint.mjs";
import {
  assertPublicationLockSource,
  loadPublicationLock,
} from "./publication-lock.mjs";
import { validateRegistryReceiptEvidence } from "./registry-integrity.mjs";
import { validateGithubAttestationReceipt } from "./verify_github_release_attestations.mjs";

export const RELEASE_PHASE_HANDOFF_SCHEMA = "oliphaunt-release-phase-handoff-v1";
export const RELEASE_PHASE_HANDOFF_MANIFEST = "release-phase-handoff.json";
export const RELEASE_PHASES = Object.freeze(["github-staged", "registry-published"]);
export const GITHUB_STAGE_HANDOFF_MAX_BYTES = 512 * 1024 * 1024;
export const APPROVED_BOOTSTRAP_CAPSULE_MAX_BYTES = 1024 * 1024 * 1024;
export const REGISTRY_INPUT_TRANSFER_MAX_BYTES = 1536 * 1024 * 1024;
export const REGISTRY_INPUT_MINIMUM_BYTES_PER_SECOND = 512 * 1024;
export const REGISTRY_INPUT_TRANSFER_ALLOWANCE_SECONDS = 60 * 60;
export const GITHUB_STAGE_HANDOFF_CONTROL_RESERVE_BYTES = 64 * 1024 * 1024;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const HASH = /^[0-9a-f]{64}$/u;
const GIT_OBJECT = /^[0-9a-f]{40,64}$/u;
const IGNORED_DIRECTORY_NAMES = new Set([".git", "node_modules", "target"]);
const MAX_FILE_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_FILES = 25_000;
const MAX_HANDOFF_FILES = 10_000;
const CAPSULE_ARTIFACT = "oliphaunt-bootstrap-capsule";
const LOCK_ARTIFACT = "oliphaunt-publication-lock";
const REGISTRY_SUPPORT_PRODUCTS = new Set(["oliphaunt-react-native"]);
const WORKSPACE = "workspace";
const RUNNER = "runner";
const CONTROL_FILES = Object.freeze({
  publicationLock: "target/release/publication-lock.json",
  normalPlan: "target/release/normal-publication-plan.json",
  githubReceipt: "target/release/github-release-attestation-receipt.json",
  checkpoint: "target/release/normal-publication-checkpoint.json",
  registryReceipts: "target/release/registry-integrity-receipts.json",
});
const RUNNER_FILES = Object.freeze([
  "oliphaunt-github-content-write-pacer.json",
  "oliphaunt-github-core-request-journal.json",
  "oliphaunt-github-release-asset-upload-report.json",
]);

function error(message) {
  return new Error(`release-phase-handoff: ${message}`);
}

function compareText(left, right) {
  const leftText = String(left);
  const rightText = String(right);
  return leftText < rightText ? -1 : leftText > rightText ? 1 : 0;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort(compareText).map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function canonicalJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function digest(value) {
  return sha256(stableJson(value));
}

function object(value, context) {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw error(`${context} must be an object`);
  }
  return value;
}

function exactKeys(value, expected, context) {
  object(value, context);
  const actual = Object.keys(value).sort(compareText);
  const wanted = [...expected].sort(compareText);
  if (stableJson(actual) !== stableJson(wanted)) {
    throw error(`${context} keys must be exactly ${wanted.join(", ")}`);
  }
}

function safeProducts(value) {
  let products = value;
  if (typeof value === "string") {
    try {
      products = JSON.parse(value);
    } catch (cause) {
      throw error(`products JSON is invalid: ${cause.message}`);
    }
  }
  if (
    !Array.isArray(products)
    || products.length === 0
    || products.some((product) => typeof product !== "string" || product.length === 0)
    || new Set(products).size !== products.length
  ) {
    throw error("products must be a nonempty unique string list");
  }
  // Product order is part of the frozen normal-publication plan.  The release
  // graph emits dependency order rather than lexical order, so preserve the
  // exact caller sequence and compare sets separately where order is
  // irrelevant.
  return [...products];
}

function positiveInteger(value, context) {
  const rendered = String(value ?? "");
  if (!/^[1-9][0-9]*$/u.test(rendered)) throw error(`${context} must be a positive integer`);
  const parsed = Number(rendered);
  if (!Number.isSafeInteger(parsed)) throw error(`${context} is outside the safe integer range`);
  return parsed;
}

function approvedDryRun(runId, artifactsValue) {
  let artifacts = artifactsValue;
  if (typeof artifactsValue === "string") {
    try {
      artifacts = JSON.parse(artifactsValue);
    } catch (cause) {
      throw error(`approved artifact metadata JSON is invalid: ${cause.message}`);
    }
  }
  if (!Array.isArray(artifacts) || artifacts.length !== 2) {
    throw error("approved artifact metadata must contain exactly the publication lock and bootstrap capsule");
  }
  const normalized = artifacts.map((row, index) => {
    exactKeys(row, ["digest", "id", "name", "size"], `approved artifact metadata[${index}]`);
    if (
      !new Set([LOCK_ARTIFACT, CAPSULE_ARTIFACT]).has(row.name)
      || !HASH.test(String(row.digest ?? "").replace(/^sha256:/u, ""))
      || !String(row.digest).startsWith("sha256:")
      || !Number.isSafeInteger(row.id)
      || row.id < 1
      || !Number.isSafeInteger(row.size)
      || row.size < 1
    ) {
      throw error(`approved artifact metadata[${index}] is malformed`);
    }
    return { digest: row.digest, id: row.id, name: row.name, size: row.size };
  }).sort((left, right) => compareText(left.name, right.name));
  if (new Set(normalized.map(({ name }) => name)).size !== 2) {
    throw error("approved artifact metadata must contain each required artifact exactly once");
  }
  const capsule = normalized.find(({ name }) => name === CAPSULE_ARTIFACT);
  if (capsule.size > APPROVED_BOOTSTRAP_CAPSULE_MAX_BYTES) {
    throw error(
      `approved bootstrap capsule is ${capsule.size} bytes, above the ${APPROVED_BOOTSTRAP_CAPSULE_MAX_BYTES}-byte transfer ceiling`,
    );
  }
  return { runId: positiveInteger(runId, "approved dry-run id"), artifacts: normalized };
}

function safeRelative(value, context) {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.includes("\\")
    || value.startsWith("/")
    || value.endsWith("/")
    || value.normalize("NFC") !== value
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw error(`${context} is not a canonical relative POSIX path`);
  }
  if (value.split("/").some((component) => component === "" || component === "." || component === "..")) {
    throw error(`${context} contains an unsafe path component: ${value}`);
  }
  return value;
}

function within(root, relative, context) {
  const safe = safeRelative(relative, context);
  const absolute = path.resolve(root, ...safe.split("/"));
  const observed = path.relative(path.resolve(root), absolute);
  if (observed === "" || observed.startsWith(`..${path.sep}`) || path.isAbsolute(observed)) {
    throw error(`${context} escapes its root: ${relative}`);
  }
  return absolute;
}

function regularFile(file, context) {
  let stat;
  try {
    stat = lstatSync(file);
  } catch (cause) {
    throw error(`${context} is unavailable: ${cause.message}`);
  }
  if (stat.isSymbolicLink() || !stat.isFile()) throw error(`${context} must be a regular non-symlink file`);
  if (!Number.isSafeInteger(stat.size) || stat.size < 0 || stat.size > MAX_FILE_BYTES) {
    throw error(`${context} has unsupported size ${stat.size}`);
  }
  return stat;
}

function fileEnvelope(file, context) {
  const stat = regularFile(file, context);
  const bytes = readFileSync(file);
  if (bytes.length !== stat.size) throw error(`${context} changed while it was read`);
  return { sha256: sha256(bytes), size: stat.size };
}

function walkFiles(directory, { ignoreBuildDirectories = false } = {}) {
  const root = path.resolve(directory);
  const rootStat = lstatSync(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw error(`${directory} must be a regular non-symlink directory`);
  }
  const files = [];
  const visit = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => compareText(a.name, b.name))) {
      const file = path.join(current, entry.name);
      if (entry.isSymbolicLink()) throw error(`handoff inputs must not contain symlinks: ${file}`);
      if (entry.isDirectory()) {
        if (ignoreBuildDirectories && IGNORED_DIRECTORY_NAMES.has(entry.name)) continue;
        visit(file);
      } else if (entry.isFile()) {
        files.push(file);
        if (files.length > MAX_FILES) throw error(`handoff exceeds ${MAX_FILES} files`);
      } else {
        throw error(`handoff inputs must contain only regular files and directories: ${file}`);
      }
    }
  };
  visit(root);
  return files;
}

function directoryEnvelope(directory) {
  const files = walkFiles(directory, { ignoreBuildDirectories: true });
  const hash = createHash("sha256");
  let size = 0;
  for (const file of files) {
    const relative = path.relative(directory, file).split(path.sep).join("/");
    const bytes = readFileSync(file);
    hash.update(`${relative}\0${bytes.length}\0`);
    hash.update(bytes);
    size += bytes.length;
  }
  return { sha256: hash.digest("hex"), size };
}

function readJson(file, context) {
  const { size } = regularFile(file, context);
  if (size > 64 * 1024 * 1024) throw error(`${context} is too large`);
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (cause) {
    throw error(`${context} is not strict JSON: ${cause.message}`);
  }
}

function addFile(entries, seen, { destination, source, target }) {
  if (!new Set([WORKSPACE, RUNNER]).has(destination)) throw error(`invalid destination ${destination}`);
  const safeTarget = safeRelative(target, "handoff target");
  if (destination === WORKSPACE && !safeTarget.startsWith("target/")) {
    throw error(`workspace handoff target must remain under target/: ${safeTarget}`);
  }
  if (destination === RUNNER && safeTarget.includes("/")) {
    throw error(`runner handoff target must be a flat file name: ${safeTarget}`);
  }
  const sourceStat = regularFile(source, source);
  if ((sourceStat.mode & 0o111) !== 0) {
    throw error(
      `handoff source ${source} is executable; pre-archive permission-sensitive payloads before Actions transport`,
    );
  }
  const envelope = fileEnvelope(source, source);
  const key = `${destination}:${safeTarget}`;
  const prior = seen.get(key);
  if (prior !== undefined) {
    if (prior.sha256 !== envelope.sha256 || prior.size !== envelope.size) {
      throw error(`two handoff sources disagree for ${key}`);
    }
    return;
  }
  const row = { destination, path: safeTarget, ...envelope };
  entries.push({ ...row, source });
  seen.set(key, row);
}

function addDirectory(entries, seen, { destination, source, target, ignoreBuildDirectories = false }) {
  for (const file of walkFiles(source, { ignoreBuildDirectories })) {
    const relative = path.relative(source, file).split(path.sep).join("/");
    addFile(entries, seen, {
      destination,
      source: file,
      target: `${safeRelative(target, "handoff directory target")}/${relative}`,
    });
  }
}

function assertProductsMatchLock(lock, products) {
  const locked = lock.products.map(({ id }) => id).sort(compareText);
  const selected = [...products].sort(compareText);
  if (stableJson(locked) !== stableJson(selected)) {
    throw error(`products do not exactly match the publication lock: selected=${JSON.stringify(products)}, lock=${JSON.stringify(locked)}`);
  }
}

function assertNormalPlan(file, lock, products) {
  const observed = readJson(file, "normal publication plan");
  const expected = normalPublicationPlan(lock, products);
  if (stableJson(observed) !== stableJson(expected)) {
    throw error("normal publication plan is not the canonical plan for the handoff lock and products");
  }
  return expected;
}

function assertGithubReceipt(file, lock, repository) {
  return validateGithubAttestationReceipt(readJson(file, "GitHub attestation receipt"), lock, { repo: repository });
}

function assertCheckpoint(file, lock, products, plan) {
  const checkpoint = openNormalPublicationCheckpoint({ file, lock, products, plan }).checkpoint;
  if (checkpoint.completedOperations.length !== plan.operations.length) {
    throw error(
      `registry-published checkpoint proves ${checkpoint.completedOperations.length}/${plan.operations.length} completed operations`,
    );
  }
  return checkpoint;
}

function registryHandoffArtifactEnvelopes(lock) {
  const records = [];
  const seen = new Set();
  const add = (artifact) => {
    const key = `${artifact.path}:${artifact.sha256}:${artifact.size}`;
    if (seen.has(key)) return;
    seen.add(key);
    records.push(artifact);
  };
  for (const carrier of lock.carriers) {
    if (new Set(["cargo", "npm"]).has(carrier.ecosystem)) continue;
    for (const artifact of carrier.artifacts) add(artifact);
  }
  for (const artifact of lock.productArtifacts) {
    if (REGISTRY_SUPPORT_PRODUCTS.has(artifact.product)) add(artifact);
  }
  return records.sort((left, right) => compareText(left.path, right.path));
}

function registryHandoffArtifacts(lock, workspaceRoot) {
  const records = [];
  for (const artifact of registryHandoffArtifactEnvelopes(lock)) {
    const source = within(workspaceRoot, artifact.path, `registry handoff artifact ${artifact.path}`);
    const stat = lstatSync(source);
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) {
      throw error(`registry handoff artifact must be a regular file or directory: ${artifact.path}`);
    }
    const observed = stat.isFile() ? fileEnvelope(source, artifact.path) : directoryEnvelope(source);
    if (observed.sha256 !== artifact.sha256 || observed.size !== artifact.size) {
      throw error(`registry handoff artifact bytes disagree with the publication lock: ${artifact.path}`);
    }
    records.push({
      path: artifact.path,
      sha256: artifact.sha256,
      size: artifact.size,
      type: stat.isFile() ? "file" : "directory",
    });
  }
  return records.sort((left, right) => compareText(left.path, right.path));
}

export function auditReleasePhaseTransfer({
  products,
  headRef = "HEAD",
  workspaceRoot = ROOT,
  approvedRunId,
  approvedArtifacts,
}) {
  const selected = safeProducts(products);
  const approved = approvedDryRun(approvedRunId, approvedArtifacts);
  const root = path.resolve(workspaceRoot);
  const lock = loadPublicationLock(path.join(root, CONTROL_FILES.publicationLock));
  assertPublicationLockSource(lock, headRef);
  assertProductsMatchLock(lock, selected);
  const artifacts = registryHandoffArtifacts(lock, root);
  const payloadBytes = artifacts.reduce((total, { size }) => total + size, 0);
  const payloadPaths = new Set();
  for (const artifact of artifacts) {
    const source = within(root, artifact.path, `registry transfer audit artifact ${artifact.path}`);
    if (artifact.type === "file") payloadPaths.add(artifact.path);
    else {
      for (const file of walkFiles(source, { ignoreBuildDirectories: true })) {
        payloadPaths.add(path.relative(root, file).split(path.sep).join("/"));
      }
    }
  }
  const projectedHandoffBytes = payloadBytes + GITHUB_STAGE_HANDOFF_CONTROL_RESERVE_BYTES;
  const capsuleBytes = approved.artifacts.find(({ name }) => name === CAPSULE_ARTIFACT).size;
  const projectedRegistryInputBytes = capsuleBytes + projectedHandoffBytes;
  const worstCaseRegistryInputTransferSeconds = Math.ceil(
    projectedRegistryInputBytes / REGISTRY_INPUT_MINIMUM_BYTES_PER_SECOND,
  );
  if (projectedHandoffBytes > GITHUB_STAGE_HANDOFF_MAX_BYTES) {
    throw error(
      `projected stage handoff is ${projectedHandoffBytes} bytes including control reserve, above ${GITHUB_STAGE_HANDOFF_MAX_BYTES}`,
    );
  }
  if (projectedRegistryInputBytes > REGISTRY_INPUT_TRANSFER_MAX_BYTES) {
    throw error(
      `projected registry inputs total ${projectedRegistryInputBytes} bytes, above ${REGISTRY_INPUT_TRANSFER_MAX_BYTES}`,
    );
  }
  if (payloadPaths.size + 32 > MAX_HANDOFF_FILES) {
    throw error(`projected stage handoff exceeds ${MAX_HANDOFF_FILES} files`);
  }
  if (worstCaseRegistryInputTransferSeconds >= REGISTRY_INPUT_TRANSFER_ALLOWANCE_SECONDS) {
    throw error(
      `projected registry input transfer needs ${worstCaseRegistryInputTransferSeconds}s at `
        + `${REGISTRY_INPUT_MINIMUM_BYTES_PER_SECOND} B/s, not less than ${REGISTRY_INPUT_TRANSFER_ALLOWANCE_SECONDS}s`,
    );
  }
  return {
    approvedCapsuleBytes: capsuleBytes,
    controlReserveBytes: GITHUB_STAGE_HANDOFF_CONTROL_RESERVE_BYTES,
    maximumHandoffBytes: GITHUB_STAGE_HANDOFF_MAX_BYTES,
    maximumRegistryInputBytes: REGISTRY_INPUT_TRANSFER_MAX_BYTES,
    minimumBytesPerSecond: REGISTRY_INPUT_MINIMUM_BYTES_PER_SECOND,
    payloadArtifactCount: artifacts.length,
    payloadBytes,
    payloadFileCount: payloadPaths.size,
    projectedHandoffBytes,
    projectedRegistryInputBytes,
    transferAllowanceSeconds: REGISTRY_INPUT_TRANSFER_ALLOWANCE_SECONDS,
    worstCaseRegistryInputTransferSeconds,
  };
}

function validateRegistryHandoffArtifacts(lock, records, sourceRoot) {
  const expected = registryHandoffArtifactEnvelopes(lock);
  if (records.length !== expected.length) throw error("registry handoff artifact set is incomplete");
  for (const [index, record] of records.entries()) {
    exactKeys(record, ["path", "sha256", "size", "type"], `carrierArtifacts[${index}]`);
    const wanted = expected[index];
    if (
      record.path !== wanted.path
      || record.sha256 !== wanted.sha256
      || record.size !== wanted.size
      || !new Set(["file", "directory"]).has(record.type)
    ) {
      throw error(`registry handoff artifact ${record.path ?? index} disagrees with the publication lock`);
    }
    const source = within(sourceRoot, `workspace/${record.path}`, `carrier artifact ${record.path}`);
    const stat = lstatSync(source);
    const observed = record.type === "file"
      ? fileEnvelope(source, record.path)
      : stat.isSymbolicLink() || !stat.isDirectory()
        ? null
        : directoryEnvelope(source);
    if (observed === null || observed.sha256 !== record.sha256 || observed.size !== record.size) {
      throw error(`registry handoff artifact payload is invalid: ${record.path}`);
    }
  }
}

function manifestWithoutDigest(manifest) {
  const copy = structuredClone(manifest);
  delete copy.manifestDigest;
  return copy;
}

function writeSafely(file, bytes) {
  mkdirSync(path.dirname(file), { recursive: true });
  const descriptor = openSync(file, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o644);
  try {
    writeFileSync(descriptor, bytes);
  } finally {
    closeSync(descriptor);
  }
}

export function sealReleasePhaseHandoff({
  phase,
  output,
  products,
  headRef = "HEAD",
  workspaceRoot = ROOT,
  runnerRoot = process.env.RUNNER_TEMP,
  repository = process.env.GITHUB_REPOSITORY,
  approvedRunId,
  approvedArtifacts,
}) {
  if (!RELEASE_PHASES.includes(phase)) throw error(`unsupported phase ${phase}`);
  if (!runnerRoot) throw error("runner root is required");
  if (!repository) throw error("repository is required");
  const selected = safeProducts(products);
  const approved = approvedDryRun(approvedRunId, approvedArtifacts);
  const root = path.resolve(workspaceRoot);
  const destination = path.resolve(output);
  if (existsSync(destination)) throw error(`handoff output must be absent: ${destination}`);
  const lockFile = path.join(root, CONTROL_FILES.publicationLock);
  const lock = loadPublicationLock(lockFile);
  assertPublicationLockSource(lock, headRef);
  assertProductsMatchLock(lock, selected);
  const planFile = path.join(root, CONTROL_FILES.normalPlan);
  const plan = assertNormalPlan(planFile, lock, selected);
  assertGithubReceipt(path.join(root, CONTROL_FILES.githubReceipt), lock, repository);
  if (phase === "registry-published") {
    assertCheckpoint(path.join(root, CONTROL_FILES.checkpoint), lock, selected, plan);
    validateRegistryReceiptEvidence(path.join(root, CONTROL_FILES.registryReceipts), lock, {
      products: selected,
      ecosystems: ["cargo", "npm", "maven", "jsr"],
    });
  }

  const stage = mkdtempSync(path.join(path.dirname(destination), ".release-phase-handoff-"));
  try {
    const entries = [];
    const seen = new Map();
    const controlNames = phase === "github-staged"
      ? ["publicationLock", "normalPlan", "githubReceipt"]
      : ["publicationLock", "normalPlan", "githubReceipt", "checkpoint", "registryReceipts"];
    for (const name of controlNames) {
      addFile(entries, seen, {
        destination: WORKSPACE,
        source: path.join(root, CONTROL_FILES[name]),
        target: CONTROL_FILES[name],
      });
    }
    const artifacts = phase === "github-staged" ? registryHandoffArtifacts(lock, root) : [];
    for (const artifact of artifacts) {
      const source = within(root, artifact.path, `carrier artifact ${artifact.path}`);
      if (artifact.type === "file") {
        addFile(entries, seen, { destination: WORKSPACE, source, target: artifact.path });
      } else {
        addDirectory(entries, seen, {
          destination: WORKSPACE,
          source,
          target: artifact.path,
          ignoreBuildDirectories: true,
        });
      }
    }
    const ledger = path.join(root, "target/release/bootstrap-ledger");
    const hasBootstrapLedger = phase === "github-staged" && existsSync(ledger);
    if (hasBootstrapLedger) {
      addDirectory(entries, seen, {
        destination: WORKSPACE,
        source: ledger,
        target: "target/release/bootstrap-ledger",
      });
    }
    for (const name of RUNNER_FILES) {
      addFile(entries, seen, {
        destination: RUNNER,
        source: path.join(runnerRoot, name),
        target: name,
      });
    }
    entries.sort((left, right) => compareText(`${left.destination}:${left.path}`, `${right.destination}:${right.path}`));
    const manifest = {
      schema: RELEASE_PHASE_HANDOFF_SCHEMA,
      phase,
      source: { commit: lock.source.commit, tree: lock.source.tree },
      lockDigest: lock.lockDigest,
      catalogDigest: lock.catalogDigest,
      packageEnvelopeDigest: lock.packageEnvelopeDigest,
      products: selected,
      approvedDryRun: approved,
      hasBootstrapLedger,
      registryArtifacts: artifacts,
      files: entries.map(({ source: _source, ...entry }) => entry),
    };
    const handoffBytes = manifest.files.reduce((total, { size }) => total + size, 0);
    const capsuleBytes = approved.artifacts.find(({ name }) => name === CAPSULE_ARTIFACT).size;
    if (handoffBytes > GITHUB_STAGE_HANDOFF_MAX_BYTES) {
      throw error(`phase handoff is ${handoffBytes} bytes, above the ${GITHUB_STAGE_HANDOFF_MAX_BYTES}-byte ceiling`);
    }
    if (handoffBytes + capsuleBytes > REGISTRY_INPUT_TRANSFER_MAX_BYTES) {
      throw error(
        `registry inputs total ${handoffBytes + capsuleBytes} bytes, above the ${REGISTRY_INPUT_TRANSFER_MAX_BYTES}-byte cold-transfer ceiling`,
      );
    }
    if (manifest.files.length > MAX_HANDOFF_FILES) {
      throw error(`phase handoff has ${manifest.files.length} files, above the ${MAX_HANDOFF_FILES}-file ceiling`);
    }
    manifest.transfer = {
      approvedCapsuleBytes: capsuleBytes,
      handoffBytes,
      maximumRegistryInputBytes: REGISTRY_INPUT_TRANSFER_MAX_BYTES,
      minimumBytesPerSecond: REGISTRY_INPUT_MINIMUM_BYTES_PER_SECOND,
      transferAllowanceSeconds: REGISTRY_INPUT_TRANSFER_ALLOWANCE_SECONDS,
      worstCaseRegistryInputTransferSeconds: Math.ceil(
        (handoffBytes + capsuleBytes) / REGISTRY_INPUT_MINIMUM_BYTES_PER_SECOND,
      ),
    };
    manifest.manifestDigest = digest(manifest);
    for (const entry of entries) {
      const target = within(stage, `${entry.destination}/${entry.path}`, `staged ${entry.destination} file`);
      mkdirSync(path.dirname(target), { recursive: true });
      copyFileSync(entry.source, target, constants.COPYFILE_EXCL);
    }
    writeSafely(path.join(stage, RELEASE_PHASE_HANDOFF_MANIFEST), canonicalJson(manifest));
    renameSync(stage, destination);
    return manifest;
  } catch (cause) {
    rmSync(stage, { recursive: true, force: true });
    throw cause;
  }
}

function validateManifest(directory, { phase, products, headRef, workspaceRoot, repository }) {
  const manifest = readJson(path.join(directory, RELEASE_PHASE_HANDOFF_MANIFEST), "handoff manifest");
  exactKeys(manifest, [
    "schema", "phase", "source", "lockDigest", "catalogDigest", "packageEnvelopeDigest",
    "products", "approvedDryRun", "hasBootstrapLedger", "registryArtifacts", "files", "transfer", "manifestDigest",
  ], "handoff manifest");
  if (manifest.schema !== RELEASE_PHASE_HANDOFF_SCHEMA || manifest.phase !== phase) {
    throw error(`handoff manifest is not a ${phase} ${RELEASE_PHASE_HANDOFF_SCHEMA} document`);
  }
  if (!HASH.test(manifest.manifestDigest ?? "") || manifest.manifestDigest !== digest(manifestWithoutDigest(manifest))) {
    throw error("handoff manifest digest is invalid");
  }
  exactKeys(manifest.source, ["commit", "tree"], "handoff source");
  if (!GIT_OBJECT.test(manifest.source.commit ?? "") || !GIT_OBJECT.test(manifest.source.tree ?? "")) {
    throw error("handoff source contains malformed Git object IDs");
  }
  for (const field of ["lockDigest", "catalogDigest", "packageEnvelopeDigest"]) {
    if (!HASH.test(manifest[field] ?? "")) throw error(`handoff ${field} is malformed`);
  }
  const selected = safeProducts(products);
  if (stableJson(selected) !== stableJson(manifest.products)) throw error("handoff products do not match the selected products");
  if (typeof manifest.hasBootstrapLedger !== "boolean") throw error("handoff hasBootstrapLedger must be boolean");
  if (phase === "registry-published" && manifest.hasBootstrapLedger) {
    throw error("registry-published handoff must not duplicate the bootstrap ledger");
  }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0 || manifest.files.length > MAX_HANDOFF_FILES) {
    throw error("handoff files must be a bounded nonempty list");
  }
  const observedRows = [];
  const keys = new Set();
  for (const [index, row] of manifest.files.entries()) {
    exactKeys(row, ["destination", "path", "sha256", "size"], `handoff files[${index}]`);
    if (!new Set([WORKSPACE, RUNNER]).has(row.destination)) throw error(`handoff files[${index}] has invalid destination`);
    safeRelative(row.path, `handoff files[${index}].path`);
    if (row.destination === WORKSPACE && !row.path.startsWith("target/")) {
      throw error(`handoff workspace file escapes target/: ${row.path}`);
    }
    if (row.destination === RUNNER && row.path.includes("/")) throw error(`handoff runner file is not flat: ${row.path}`);
    if (!HASH.test(row.sha256 ?? "") || !Number.isSafeInteger(row.size) || row.size < 0 || row.size > MAX_FILE_BYTES) {
      throw error(`handoff file envelope is malformed: ${row.path}`);
    }
    const key = `${row.destination}:${row.path}`;
    if (keys.has(key)) throw error(`handoff contains duplicate file ${key}`);
    keys.add(key);
    const file = within(directory, `${row.destination}/${row.path}`, `handoff file ${key}`);
    const observed = fileEnvelope(file, key);
    if (observed.sha256 !== row.sha256 || observed.size !== row.size) throw error(`handoff file bytes changed: ${key}`);
    observedRows.push(key);
  }
  const actual = walkFiles(directory)
    .map((file) => path.relative(directory, file).split(path.sep).join("/"))
    .filter((relative) => relative !== RELEASE_PHASE_HANDOFF_MANIFEST)
    .sort(compareText);
  const expected = manifest.files.map(({ destination, path: relative }) => `${destination}/${relative}`).sort(compareText);
  if (stableJson(actual) !== stableJson(expected)) throw error("handoff contains missing or unmanifested files");

  const embeddedLockFile = within(directory, `${WORKSPACE}/${CONTROL_FILES.publicationLock}`, "embedded publication lock");
  const lock = loadPublicationLock(embeddedLockFile);
  assertPublicationLockSource(lock, headRef);
  assertProductsMatchLock(lock, selected);
  if (
    lock.source.commit !== manifest.source.commit
    || lock.source.tree !== manifest.source.tree
    || lock.lockDigest !== manifest.lockDigest
    || lock.catalogDigest !== manifest.catalogDigest
    || lock.packageEnvelopeDigest !== manifest.packageEnvelopeDigest
  ) {
    throw error("handoff manifest identity disagrees with its embedded publication lock");
  }
  const plan = assertNormalPlan(
    within(directory, `${WORKSPACE}/${CONTROL_FILES.normalPlan}`, "embedded normal plan"),
    lock,
    selected,
  );
  assertGithubReceipt(
    within(directory, `${WORKSPACE}/${CONTROL_FILES.githubReceipt}`, "embedded GitHub receipt"),
    lock,
    repository,
  );
  if (!Array.isArray(manifest.registryArtifacts)) throw error("handoff registryArtifacts must be a list");
  if (phase === "github-staged") {
    validateRegistryHandoffArtifacts(lock, manifest.registryArtifacts, directory);
    const ledgerPrefix = `${WORKSPACE}/target/release/bootstrap-ledger/`;
    const observedLedger = expected.some((entry) => entry.startsWith(ledgerPrefix));
    if (observedLedger !== manifest.hasBootstrapLedger) throw error("handoff bootstrap ledger presence flag is incorrect");
  } else {
    if (manifest.registryArtifacts.length !== 0) throw error("registry-published handoff must not duplicate registry artifacts");
    assertCheckpoint(
      within(directory, `${WORKSPACE}/${CONTROL_FILES.checkpoint}`, "embedded checkpoint"),
      lock,
      selected,
      plan,
    );
    validateRegistryReceiptEvidence(
      within(directory, `${WORKSPACE}/${CONTROL_FILES.registryReceipts}`, "embedded registry receipts"),
      lock,
      { products: selected, ecosystems: ["cargo", "npm", "maven", "jsr"] },
    );
  }
  for (const name of RUNNER_FILES) {
    if (!keys.has(`${RUNNER}:${name}`)) throw error(`handoff is missing runner evidence ${name}`);
  }
  const approved = approvedDryRun(manifest.approvedDryRun?.runId, manifest.approvedDryRun?.artifacts);
  if (stableJson(approved) !== stableJson(manifest.approvedDryRun)) {
    throw error("approved dry-run metadata is not canonical");
  }
  exactKeys(manifest.transfer, [
    "approvedCapsuleBytes", "handoffBytes", "maximumRegistryInputBytes", "minimumBytesPerSecond",
    "transferAllowanceSeconds", "worstCaseRegistryInputTransferSeconds",
  ], "handoff transfer budget");
  const handoffBytes = manifest.files.reduce((total, { size }) => total + size, 0);
  const capsuleBytes = approved.artifacts.find(({ name }) => name === CAPSULE_ARTIFACT).size;
  const expectedTransfer = {
    approvedCapsuleBytes: capsuleBytes,
    handoffBytes,
    maximumRegistryInputBytes: REGISTRY_INPUT_TRANSFER_MAX_BYTES,
    minimumBytesPerSecond: REGISTRY_INPUT_MINIMUM_BYTES_PER_SECOND,
    transferAllowanceSeconds: REGISTRY_INPUT_TRANSFER_ALLOWANCE_SECONDS,
    worstCaseRegistryInputTransferSeconds: Math.ceil(
      (handoffBytes + capsuleBytes) / REGISTRY_INPUT_MINIMUM_BYTES_PER_SECOND,
    ),
  };
  if (
    stableJson(expectedTransfer) !== stableJson(manifest.transfer)
    || handoffBytes > GITHUB_STAGE_HANDOFF_MAX_BYTES
    || handoffBytes + capsuleBytes > REGISTRY_INPUT_TRANSFER_MAX_BYTES
    || expectedTransfer.worstCaseRegistryInputTransferSeconds >= REGISTRY_INPUT_TRANSFER_ALLOWANCE_SECONDS
  ) {
    throw error("handoff transfer budget is invalid or exceeds the bounded cold-transfer allowance");
  }
  return { lock, manifest };
}

export function installReleasePhaseHandoff({
  phase,
  input,
  products,
  headRef = "HEAD",
  workspaceRoot = ROOT,
  runnerRoot,
  repository = process.env.GITHUB_REPOSITORY,
  approvedRunId,
  approvedArtifacts,
  mergeExistingTarget = false,
}) {
  if (!RELEASE_PHASES.includes(phase)) throw error(`unsupported phase ${phase}`);
  if (!runnerRoot) throw error("runner root is required");
  if (!repository) throw error("repository is required");
  const source = path.resolve(input);
  const root = path.resolve(workspaceRoot);
  const runner = path.resolve(runnerRoot);
  const { manifest } = validateManifest(source, { phase, products, headRef, workspaceRoot: root, repository });
  const expectedApproved = approvedDryRun(approvedRunId, approvedArtifacts);
  if (stableJson(expectedApproved) !== stableJson(manifest.approvedDryRun)) {
    throw error("handoff approved dry-run identity disagrees with the requested exact artifacts");
  }
  const target = path.join(root, "target");
  if (existsSync(target) && !mergeExistingTarget) {
    throw error(`atomic handoff installation requires absent workspace target: ${target}`);
  }
  for (const row of manifest.files.filter(({ destination }) => destination === RUNNER)) {
    if (existsSync(path.join(runner, row.path))) throw error(`runner handoff destination already exists: ${row.path}`);
  }
  const stage = mkdtempSync(path.join(root, ".release-phase-install-"));
  const createdWorkspaceFiles = [];
  const createdWorkspaceTemporaryFiles = [];
  try {
    for (const row of manifest.files.filter(({ destination }) => destination === WORKSPACE)) {
      const from = within(source, `${WORKSPACE}/${row.path}`, `handoff source ${row.path}`);
      if (mergeExistingTarget) {
        const to = within(root, row.path, `handoff destination ${row.path}`);
        if (existsSync(to)) {
          const observed = fileEnvelope(to, `existing handoff destination ${row.path}`);
          if (observed.sha256 !== row.sha256 || observed.size !== row.size) {
            throw error(`existing handoff destination is not byte-identical: ${row.path}`);
          }
          continue;
        }
        mkdirSync(path.dirname(to), { recursive: true });
        const temporary = `${to}.handoff-${process.pid}`;
        createdWorkspaceTemporaryFiles.push(temporary);
        copyFileSync(from, temporary, constants.COPYFILE_EXCL);
        renameSync(temporary, to);
        createdWorkspaceFiles.push(to);
      } else {
        const to = within(stage, row.path, `handoff stage ${row.path}`);
        mkdirSync(path.dirname(to), { recursive: true });
        copyFileSync(from, to, constants.COPYFILE_EXCL);
      }
    }
    if (!mergeExistingTarget) renameSync(path.join(stage, "target"), target);
    for (const row of manifest.files.filter(({ destination }) => destination === RUNNER)) {
      const from = within(source, `${RUNNER}/${row.path}`, `runner source ${row.path}`);
      const temporary = path.join(runner, `.${row.path}.handoff-${process.pid}`);
      copyFileSync(from, temporary, constants.COPYFILE_EXCL);
      renameSync(temporary, path.join(runner, row.path));
    }
    return manifest;
  } catch (cause) {
    if (mergeExistingTarget) {
      for (const file of createdWorkspaceTemporaryFiles) rmSync(file, { force: true });
      for (const file of createdWorkspaceFiles.reverse()) rmSync(file, { force: true });
    } else {
      rmSync(target, { recursive: true, force: true });
    }
    for (const row of manifest.files.filter(({ destination }) => destination === RUNNER)) {
      rmSync(path.join(runner, row.path), { force: true });
      rmSync(path.join(runner, `.${row.path}.handoff-${process.pid}`), { force: true });
    }
    throw cause;
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

function parseArgs(argv) {
  const command = argv[0];
  if (!new Set(["audit", "seal", "install"]).has(command)) {
    throw error("usage: release-phase-handoff.mjs <audit|seal|install> --phase PHASE --products-json JSON --head-ref SHA ...");
  }
  const values = new Map();
  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined || value.startsWith("--")) throw error(`invalid ${flag ?? "argument"}`);
    const name = flag.slice(2);
    if (values.has(name)) throw error(`duplicate --${name}`);
    values.set(name, value);
  }
  const common = command === "audit" ? ["products-json", "head-ref"] : ["phase", "products-json", "head-ref"];
  const specific = command === "seal"
    ? ["output", "runner-root"]
    : command === "install"
      ? ["input", "runner-root"]
      : ["github-output"];
  const allowed = new Set([
    ...common, ...specific, "workspace-root", "repository", "approved-run-id", "approved-artifacts-json",
    "merge-existing-target",
  ]);
  const unknown = [...values.keys()].filter((name) => !allowed.has(name));
  if (unknown.length > 0) throw error(`unsupported arguments: ${unknown.map((name) => `--${name}`).join(" ")}`);
  for (const name of [...common, ...specific, "approved-run-id", "approved-artifacts-json"]) {
    if (!values.get(name)) throw error(`${command} requires --${name}`);
  }
  return { command, values };
}

function main(argv) {
  const { command, values } = parseArgs(argv);
  const common = {
    phase: values.get("phase"),
    products: values.get("products-json"),
    headRef: values.get("head-ref"),
    workspaceRoot: values.get("workspace-root") ?? ROOT,
    runnerRoot: values.get("runner-root"),
    repository: values.get("repository") ?? process.env.GITHUB_REPOSITORY,
    approvedRunId: values.get("approved-run-id"),
    approvedArtifacts: values.get("approved-artifacts-json"),
  };
  if (command === "audit") {
    const report = auditReleasePhaseTransfer(common);
    appendFileSync(values.get("github-output"), [
      `approved_capsule_bytes=${report.approvedCapsuleBytes}`,
      `payload_artifact_count=${report.payloadArtifactCount}`,
      `payload_file_count=${report.payloadFileCount}`,
      `payload_bytes=${report.payloadBytes}`,
      `projected_handoff_bytes=${report.projectedHandoffBytes}`,
      `projected_registry_input_bytes=${report.projectedRegistryInputBytes}`,
      `worst_case_registry_input_transfer_seconds=${report.worstCaseRegistryInputTransferSeconds}`,
      "",
    ].join("\n"));
    console.log(JSON.stringify(report));
    return;
  }
  const manifest = command === "seal"
    ? sealReleasePhaseHandoff({ ...common, output: values.get("output") })
    : installReleasePhaseHandoff({
        ...common,
        input: values.get("input"),
        mergeExistingTarget: values.get("merge-existing-target") === "true",
      });
  console.log(
    `${command === "seal" ? "sealed" : "installed"} ${manifest.phase} handoff ${manifest.manifestDigest} `
      + `for ${manifest.products.length} products and ${manifest.files.length} files`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (cause) {
    console.error(cause instanceof Error ? cause.message : String(cause));
    process.exit(1);
  }
}
