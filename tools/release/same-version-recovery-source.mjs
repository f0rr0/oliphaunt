#!/usr/bin/env bun

import { createHash } from "node:crypto";
import {
  appendFileSync,
  lstatSync,
  readFileSync,
} from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { captureCommandOutput } from "../dev/capture-command-output.mjs";

const TOOL = "same-version-recovery-source.mjs";
export const SAME_VERSION_RECOVERY_SOURCES_SCHEMA =
  "oliphaunt-same-version-recovery-sources-v1";
const PUBLICATION_LOCK_SCHEMA = "oliphaunt-publication-lock-v1";
const CAPSULE_SCHEMA = "oliphaunt-bootstrap-publication-capsule-v1";
const LEDGER_SCHEMA = "oliphaunt-bootstrap-ledger-checkpoint-v1";
const SHA = /^[0-9a-f]{40}$/u;
const HASH = /^[0-9a-f]{64}$/u;
const ARTIFACT_DIGEST = /^sha256:[0-9a-f]{64}$/u;
const SAFE_ARTIFACT_NAME = /^[A-Za-z0-9][A-Za-z0-9._~-]*$/u;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const DEFAULT_SAME_VERSION_RECOVERY_SOURCES = path.join(
  ROOT,
  "tools/release/same-version-recovery-sources.json",
);

function error(message) {
  return new Error(`${TOOL}: ${message}`);
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort(compareText)
        .map((key) => [key, canonical(value[key])]),
    );
  }
  return value;
}

export function canonicalRecoverySourceJson(value) {
  return JSON.stringify(canonical(value));
}

function prettyCanonicalJson(value) {
  return `${JSON.stringify(canonical(value), null, 2)}\n`;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function digestValue(value) {
  return sha256(canonicalRecoverySourceJson(value));
}

function strictObject(value, expectedKeys, context) {
  if (
    value === null
    || Array.isArray(value)
    || typeof value !== "object"
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) {
    throw error(`${context} must be a plain object`);
  }
  const actual = Object.keys(value).sort(compareText);
  const expected = [...expectedKeys].sort(compareText);
  if (canonicalRecoverySourceJson(actual) !== canonicalRecoverySourceJson(expected)) {
    throw error(
      `${context} must contain exactly ${expected.join(", ")}; got ${actual.join(", ") || "<none>"}`,
    );
  }
  return value;
}

function positiveInteger(value, context) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw error(`${context} must be a positive safe integer`);
  }
  return value;
}

function nonNegativeInteger(value, context) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw error(`${context} must be a non-negative safe integer`);
  }
  return value;
}

function hash(value, context) {
  if (typeof value !== "string" || !HASH.test(value)) {
    throw error(`${context} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function sourceIdentity(value, context) {
  strictObject(value, ["commit", "tree"], context);
  if (!SHA.test(value.commit) || !SHA.test(value.tree)) {
    throw error(`${context} must contain lowercase full commit/tree SHAs`);
  }
  return value;
}

function sameSource(left, right, context) {
  if (left.commit !== right.commit || left.tree !== right.tree) {
    throw error(
      `${context} source ${left.commit}/${left.tree} does not match `
        + `${right.commit}/${right.tree}`,
    );
  }
}

function fileIdentity(value, context, expectedPath = undefined) {
  strictObject(value, ["path", "sha256", "size"], context);
  if (
    typeof value.path !== "string"
    || value.path.length === 0
    || value.path.startsWith("/")
    || value.path.includes("\\")
    || value.path.split("/").some((part) => part === "" || part === "." || part === "..")
    || /[\u0000-\u001f\u007f]/u.test(value.path)
  ) {
    throw error(`${context}.path must be a safe relative POSIX path`);
  }
  if (expectedPath !== undefined && value.path !== expectedPath) {
    throw error(`${context}.path must be ${expectedPath}`);
  }
  hash(value.sha256, `${context}.sha256`);
  positiveInteger(value.size, `${context}.size`);
  return value;
}

function artifactIdentity(value, context) {
  strictObject(value, ["digest", "id", "name", "size"], context);
  if (!ARTIFACT_DIGEST.test(value.digest ?? "")) {
    throw error(`${context}.digest must be a lowercase sha256: Actions artifact digest`);
  }
  positiveInteger(value.id, `${context}.id`);
  positiveInteger(value.size, `${context}.size`);
  if (typeof value.name !== "string" || !SAFE_ARTIFACT_NAME.test(value.name)) {
    throw error(`${context}.name is not a safe Actions artifact name`);
  }
  return value;
}

function compareArtifacts(left, right) {
  return compareText(left.name, right.name) || left.id - right.id;
}

function artifactInventory(value, context) {
  strictObject(value, ["artifacts", "count", "inventoryDigest", "totalSize"], context);
  if (!Array.isArray(value.artifacts) || value.artifacts.length === 0) {
    throw error(`${context}.artifacts must be a non-empty list`);
  }
  value.artifacts.forEach((entry, index) =>
    artifactIdentity(entry, `${context}.artifacts[${index}]`));
  const sorted = [...value.artifacts].sort(compareArtifacts);
  if (
    canonicalRecoverySourceJson(sorted)
    !== canonicalRecoverySourceJson(value.artifacts)
  ) {
    throw error(`${context}.artifacts must be sorted by name and id`);
  }
  const ids = new Set();
  const names = new Set();
  for (const artifact of value.artifacts) {
    if (ids.has(artifact.id)) throw error(`${context} repeats artifact id ${artifact.id}`);
    if (names.has(artifact.name)) throw error(`${context} repeats artifact name ${artifact.name}`);
    ids.add(artifact.id);
    names.add(artifact.name);
  }
  if (value.count !== value.artifacts.length) {
    throw error(`${context}.count does not match the complete artifact inventory`);
  }
  const totalSize = value.artifacts.reduce((total, artifact) => total + artifact.size, 0);
  if (!Number.isSafeInteger(totalSize) || value.totalSize !== totalSize) {
    throw error(`${context}.totalSize does not match the complete artifact inventory`);
  }
  hash(value.inventoryDigest, `${context}.inventoryDigest`);
  const expectedDigest = digestValue(value.artifacts);
  if (value.inventoryDigest !== expectedDigest) {
    throw error(
      `${context}.inventoryDigest mismatch: expected ${expectedDigest}, got ${value.inventoryDigest}`,
    );
  }
  return value;
}

function exactArtifactNames(inventory, expectedNames, context) {
  const actual = inventory.artifacts.map((artifact) => artifact.name);
  if (canonicalRecoverySourceJson(actual) !== canonicalRecoverySourceJson(expectedNames)) {
    throw error(`${context} must contain exactly ${expectedNames.join(", ")}`);
  }
}

function workflow(value, context, expected) {
  strictObject(value, ["id", "name", "path"], context);
  positiveInteger(value.id, `${context}.id`);
  if (
    value.name !== expected.name
    || value.path !== expected.path
  ) {
    throw error(`${context} must identify ${expected.name} at ${expected.path}`);
  }
  return value;
}

function successfulRun(value, context, source) {
  strictObject(
    value,
    ["attempt", "conclusion", "event", "headSha", "id", "status"],
    context,
  );
  positiveInteger(value.id, `${context}.id`);
  positiveInteger(value.attempt, `${context}.attempt`);
  if (
    value.event !== "workflow_dispatch"
    || value.status !== "completed"
    || value.conclusion !== "success"
  ) {
    throw error(`${context} must be a completed/success workflow_dispatch`);
  }
  if (value.headSha !== source.commit) {
    throw error(`${context}.headSha does not match the frozen release commit`);
  }
  return value;
}

function releaseEnvelope(value, context) {
  strictObject(
    value,
    [
      "carrierCount",
      "catalogDigest",
      "lockDigest",
      "packageEnvelopeDigest",
      "productArtifactCount",
      "productCount",
      "publicationLock",
      "schema",
    ],
    context,
  );
  if (value.schema !== PUBLICATION_LOCK_SCHEMA) {
    throw error(`${context}.schema must be ${PUBLICATION_LOCK_SCHEMA}`);
  }
  for (const field of ["lockDigest", "catalogDigest", "packageEnvelopeDigest"]) {
    hash(value[field], `${context}.${field}`);
  }
  for (const field of ["carrierCount", "productArtifactCount", "productCount"]) {
    positiveInteger(value[field], `${context}.${field}`);
  }
  fileIdentity(
    value.publicationLock,
    `${context}.publicationLock`,
    "target/release/publication-lock.json",
  );
  return value;
}

function capsuleManifest(value, context, source, envelope) {
  strictObject(
    value,
    [
      "carrierCount",
      "catalogDigest",
      "file",
      "lockDigest",
      "packageEnvelopeDigest",
      "productCount",
      "publicationLock",
      "schema",
      "source",
    ],
    context,
  );
  if (value.schema !== CAPSULE_SCHEMA) {
    throw error(`${context}.schema must be ${CAPSULE_SCHEMA}`);
  }
  sourceIdentity(value.source, `${context}.source`);
  sameSource(value.source, source, context);
  fileIdentity(
    value.file,
    `${context}.file`,
    "target/release/bootstrap-capsule-manifest.json",
  );
  fileIdentity(
    value.publicationLock,
    `${context}.publicationLock`,
    "target/release/publication-lock.json",
  );
  for (const field of ["lockDigest", "catalogDigest", "packageEnvelopeDigest"]) {
    hash(value[field], `${context}.${field}`);
    if (value[field] !== envelope[field]) {
      throw error(`${context}.${field} does not match the approved publication lock`);
    }
  }
  for (const field of ["productCount", "carrierCount"]) {
    positiveInteger(value[field], `${context}.${field}`);
  }
  if (value.productCount !== envelope.productCount) {
    throw error(`${context}.productCount does not match the approved publication lock`);
  }
  if (
    canonicalRecoverySourceJson(value.publicationLock)
    !== canonicalRecoverySourceJson(envelope.publicationLock)
  ) {
    throw error(`${context}.publicationLock does not match the approved publication lock bytes`);
  }
  return value;
}

function terminalCheckpoint(value, context, source, envelope, capsule) {
  strictObject(
    value,
    [
      "catalogDigest",
      "checkpointDigest",
      "complete",
      "file",
      "lockDigest",
      "packageEnvelopeDigest",
      "previousCheckpointDigest",
      "productCount",
      "publicationCount",
      "receiptCount",
      "schema",
      "sequence",
      "source",
    ],
    context,
  );
  if (value.schema !== LEDGER_SCHEMA) {
    throw error(`${context}.schema must be ${LEDGER_SCHEMA}`);
  }
  sourceIdentity(value.source, `${context}.source`);
  sameSource(value.source, source, context);
  for (const field of [
    "lockDigest",
    "catalogDigest",
    "packageEnvelopeDigest",
    "checkpointDigest",
    "previousCheckpointDigest",
  ]) {
    hash(value[field], `${context}.${field}`);
  }
  for (const field of ["lockDigest", "catalogDigest", "packageEnvelopeDigest"]) {
    if (value[field] !== envelope[field]) {
      throw error(`${context}.${field} does not match the approved publication lock`);
    }
  }
  nonNegativeInteger(value.sequence, `${context}.sequence`);
  for (const field of ["productCount", "publicationCount", "receiptCount"]) {
    positiveInteger(value[field], `${context}.${field}`);
  }
  if (value.complete !== true || value.publicationCount !== value.receiptCount) {
    throw error(`${context} must identify a terminal complete bootstrap ledger`);
  }
  if (
    value.productCount !== envelope.productCount
    || value.publicationCount !== capsule.carrierCount
  ) {
    throw error(`${context} counts do not match the approved lock/capsule envelope`);
  }
  const expectedName =
    `checkpoint-${String(value.sequence).padStart(6, "0")}-${value.checkpointDigest}.json`;
  fileIdentity(value.file, `${context}.file`, expectedName);
  return value;
}

function requiredArtifactNames(value, inventory, context) {
  if (
    !Array.isArray(value)
    || value.length === 0
    || value.some((name) => typeof name !== "string" || !SAFE_ARTIFACT_NAME.test(name))
    || new Set(value).size !== value.length
  ) {
    throw error(`${context} must be a non-empty unique artifact-name list`);
  }
  const sorted = [...value].sort(compareText);
  if (canonicalRecoverySourceJson(sorted) !== canonicalRecoverySourceJson(value)) {
    throw error(`${context} must be sorted`);
  }
  const available = new Set(inventory.artifacts.map((artifact) => artifact.name));
  const missing = value.filter((name) => !available.has(name));
  if (missing.length > 0) {
    throw error(`${context} names missing from the complete inventory: ${missing.join(", ")}`);
  }
  return value;
}

function validateRecord(value, index) {
  const context = `records[${index}]`;
  strictObject(
    value,
    [
      "approvedDryRun",
      "bootstrapLedger",
      "payloadQualification",
      "releaseEnvelope",
      "releaseSource",
    ],
    context,
  );
  const source = sourceIdentity(value.releaseSource, `${context}.releaseSource`);
  const envelope = releaseEnvelope(value.releaseEnvelope, `${context}.releaseEnvelope`);

  strictObject(
    value.payloadQualification,
    ["artifactInventory", "requiredArtifactNames", "run", "workflow"],
    `${context}.payloadQualification`,
  );
  workflow(
    value.payloadQualification.workflow,
    `${context}.payloadQualification.workflow`,
    { name: "CI", path: ".github/workflows/ci.yml" },
  );
  successfulRun(
    value.payloadQualification.run,
    `${context}.payloadQualification.run`,
    source,
  );
  const payloadInventory = artifactInventory(
    value.payloadQualification.artifactInventory,
    `${context}.payloadQualification.artifactInventory`,
  );
  requiredArtifactNames(
    value.payloadQualification.requiredArtifactNames,
    payloadInventory,
    `${context}.payloadQualification.requiredArtifactNames`,
  );

  strictObject(
    value.approvedDryRun,
    ["artifactInventory", "capsuleManifest", "run", "workflow"],
    `${context}.approvedDryRun`,
  );
  workflow(
    value.approvedDryRun.workflow,
    `${context}.approvedDryRun.workflow`,
    { name: "Release", path: ".github/workflows/release.yml" },
  );
  successfulRun(value.approvedDryRun.run, `${context}.approvedDryRun.run`, source);
  const dryRunInventory = artifactInventory(
    value.approvedDryRun.artifactInventory,
    `${context}.approvedDryRun.artifactInventory`,
  );
  exactArtifactNames(
    dryRunInventory,
    ["oliphaunt-bootstrap-capsule", "oliphaunt-publication-lock"],
    `${context}.approvedDryRun.artifactInventory`,
  );
  const capsule = capsuleManifest(
    value.approvedDryRun.capsuleManifest,
    `${context}.approvedDryRun.capsuleManifest`,
    source,
    envelope,
  );

  strictObject(
    value.bootstrapLedger,
    ["artifactInventory", "run", "terminalCheckpoint", "workflow"],
    `${context}.bootstrapLedger`,
  );
  workflow(
    value.bootstrapLedger.workflow,
    `${context}.bootstrapLedger.workflow`,
    { name: "Release", path: ".github/workflows/release.yml" },
  );
  successfulRun(value.bootstrapLedger.run, `${context}.bootstrapLedger.run`, source);
  const ledgerInventory = artifactInventory(
    value.bootstrapLedger.artifactInventory,
    `${context}.bootstrapLedger.artifactInventory`,
  );
  exactArtifactNames(
    ledgerInventory,
    ["oliphaunt-bootstrap-ledger"],
    `${context}.bootstrapLedger.artifactInventory`,
  );
  terminalCheckpoint(
    value.bootstrapLedger.terminalCheckpoint,
    `${context}.bootstrapLedger.terminalCheckpoint`,
    source,
    envelope,
    capsule,
  );

  const runIds = [
    value.payloadQualification.run.id,
    value.approvedDryRun.run.id,
    value.bootstrapLedger.run.id,
  ];
  if (new Set(runIds).size !== runIds.length) {
    throw error(`${context} must bind three distinct workflow runs`);
  }
  if (
    value.approvedDryRun.workflow.id !== value.bootstrapLedger.workflow.id
    || value.payloadQualification.workflow.id === value.approvedDryRun.workflow.id
  ) {
    throw error(`${context} workflow identities are inconsistent`);
  }
  return value;
}

function gitCommitAndTree(repo, commit) {
  const result = captureCommandOutput(
    "git",
    ["show", "-s", "--format=%H%n%T", `${commit}^{commit}`],
    {
      cwd: repo,
      label: `git show -s --format=%H%n%T ${commit}^{commit}`,
    },
  );
  if (result.error !== undefined || result.status !== 0) {
    const detail = (result.stderr || result.stdout || result.error?.message || "").trim();
    throw error(`cannot resolve frozen release commit ${commit}${detail ? `: ${detail}` : ""}`);
  }
  const [resolvedCommit, tree, ...extra] = result.stdout.trimEnd().split("\n");
  if (!SHA.test(resolvedCommit) || !SHA.test(tree) || extra.length > 0) {
    throw error(`git returned malformed source identity for ${commit}`);
  }
  return { commit: resolvedCommit, tree };
}

export function validateSameVersionRecoverySource(
  record,
  { repo = ROOT, verifyGit = true } = {},
) {
  validateRecord(record, 0);
  if (verifyGit) {
    const resolved = gitCommitAndTree(repo, record.releaseSource.commit);
    sameSource(resolved, record.releaseSource, "committed recovery record");
  }
  return record;
}

export function validateSameVersionRecoverySources(
  document,
  { repo = ROOT, verifyGit = true } = {},
) {
  strictObject(document, ["records", "schema"], "recovery source document");
  if (document.schema !== SAME_VERSION_RECOVERY_SOURCES_SCHEMA) {
    throw error(
      `recovery source document schema must be ${SAME_VERSION_RECOVERY_SOURCES_SCHEMA}`,
    );
  }
  if (!Array.isArray(document.records) || document.records.length === 0) {
    throw error("recovery source document records must be a non-empty list");
  }
  document.records.forEach((record) =>
    validateSameVersionRecoverySource(record, { repo, verifyGit: false }));
  const sorted = [...document.records].sort((left, right) =>
    compareText(left.releaseSource.commit, right.releaseSource.commit));
  if (canonicalRecoverySourceJson(sorted) !== canonicalRecoverySourceJson(document.records)) {
    throw error("recovery source records must be sorted by release commit");
  }
  const commits = new Set();
  const trees = new Set();
  for (const record of document.records) {
    if (commits.has(record.releaseSource.commit)) {
      throw error(`duplicate recovery source commit ${record.releaseSource.commit}`);
    }
    if (trees.has(record.releaseSource.tree)) {
      throw error(`duplicate recovery source tree ${record.releaseSource.tree}`);
    }
    commits.add(record.releaseSource.commit);
    trees.add(record.releaseSource.tree);
    if (verifyGit) {
      const resolved = gitCommitAndTree(repo, record.releaseSource.commit);
      sameSource(resolved, record.releaseSource, "committed recovery record");
    }
  }
  return document;
}

export function loadSameVersionRecoverySources(
  file = DEFAULT_SAME_VERSION_RECOVERY_SOURCES,
  options = {},
) {
  const absolute = path.resolve(file);
  const metadata = lstatSync(absolute, { throwIfNoEntry: false });
  if (!metadata?.isFile() || metadata.isSymbolicLink() || metadata.size > 16 * 1024 * 1024) {
    throw error(`recovery source record must be a regular non-symlink file: ${absolute}`);
  }
  const bytes = readFileSync(absolute, "utf8");
  let document;
  try {
    document = JSON.parse(bytes);
  } catch (cause) {
    throw error(`recovery source record is invalid JSON: ${cause.message}`);
  }
  if (bytes !== prettyCanonicalJson(document)) {
    throw error("recovery source record must be canonical sorted JSON with one trailing newline");
  }
  return validateSameVersionRecoverySources(document, options);
}

export function selectSameVersionRecoverySource(
  document,
  releaseSha,
  options = {},
) {
  if (!SHA.test(releaseSha ?? "")) {
    throw error("release SHA must be a lowercase full commit SHA");
  }
  validateSameVersionRecoverySources(document, options);
  const matches = document.records.filter((record) =>
    record.releaseSource.commit === releaseSha);
  if (matches.length !== 1) {
    throw error(
      `expected exactly one same-version recovery source for ${releaseSha}; found ${matches.length}`,
    );
  }
  return matches[0];
}

function readEvidenceFile(file, context, maximum = 64 * 1024 * 1024) {
  const absolute = path.resolve(file);
  const metadata = lstatSync(absolute, { throwIfNoEntry: false });
  if (
    !metadata?.isFile()
    || metadata.isSymbolicLink()
    || metadata.size < 1
    || metadata.size > maximum
  ) {
    throw error(`${context} must be a bounded regular non-symlink file`);
  }
  const bytes = readFileSync(absolute);
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch (cause) {
    throw error(`${context} is invalid JSON: ${cause.message}`);
  }
  return { bytes, value };
}

function verifyFileBytes(bytes, expected, context) {
  if (bytes.length !== expected.size || sha256(bytes) !== expected.sha256) {
    throw error(
      `${context} bytes do not match the recorded ${expected.size}/${expected.sha256} identity`,
    );
  }
}

function verifyCoreEnvelope(value, record, context) {
  const source = sourceIdentity(value.source, `${context}.source`);
  sameSource(source, record.releaseSource, context);
  for (const field of ["lockDigest", "catalogDigest", "packageEnvelopeDigest"]) {
    hash(value[field], `${context}.${field}`);
    if (value[field] !== record.releaseEnvelope[field]) {
      throw error(`${context}.${field} does not match the recovery record`);
    }
  }
}

function catalogCarrierEnvelope(carrier) {
  return {
    declared: carrier.declared,
    ecosystem: carrier.ecosystem,
    id: carrier.id,
    name: carrier.name,
    product: carrier.product,
    role: carrier.role,
    target: carrier.target,
    version: carrier.version,
  };
}

function carrierPackageEnvelope(carrier) {
  return {
    artifacts: Array.isArray(carrier.artifacts)
      ? carrier.artifacts.map(({ path: artifactPath, sha256: artifactSha256, size }) => ({
        path: artifactPath,
        sha256: artifactSha256,
        size,
      }))
      : carrier.artifacts,
    declared: carrier.declared,
    dependencies: carrier.dependencies,
    ecosystem: carrier.ecosystem,
    id: carrier.id,
    name: carrier.name,
    packageDependencies: carrier.packageDependencies,
    parentCarrier: carrier.parentCarrier ?? null,
    part: carrier.part ?? null,
    product: carrier.product,
    publishOrder: carrier.publishOrder,
    role: carrier.role,
    target: carrier.target,
    version: carrier.version,
  };
}

function productArtifactPackageEnvelope(artifact) {
  return {
    id: artifact.id,
    identity: artifact.identity,
    kind: artifact.kind,
    name: artifact.name,
    path: artifact.path,
    product: artifact.product,
    role: artifact.role,
    sha256: artifact.sha256,
    size: artifact.size,
    target: artifact.target,
  };
}

function validatePublicationLockEvidence(value, record) {
  strictObject(
    value,
    [
      "carriers",
      "catalogDigest",
      "catalogSchema",
      "lockDigest",
      "packageEnvelopeDigest",
      "productArtifacts",
      "products",
      "schema",
      "source",
    ],
    "publication lock evidence",
  );
  if (value.schema !== PUBLICATION_LOCK_SCHEMA) {
    throw error(`publication lock evidence schema must be ${PUBLICATION_LOCK_SCHEMA}`);
  }
  verifyCoreEnvelope(value, record, "publication lock evidence");
  for (const [field, expected] of [
    ["products", record.releaseEnvelope.productCount],
    ["carriers", record.releaseEnvelope.carrierCount],
    ["productArtifacts", record.releaseEnvelope.productArtifactCount],
  ]) {
    if (!Array.isArray(value[field]) || value[field].length !== expected) {
      throw error(`publication lock evidence ${field} count does not match the recovery record`);
    }
  }
  const expectedCatalogDigest = digestValue({
    carriers: value.carriers
      .filter((carrier) => carrier?.declared === true)
      .map(catalogCarrierEnvelope)
      .sort((left, right) => compareText(left.id, right.id)),
    products: value.products,
    schema: value.catalogSchema,
  });
  if (value.catalogDigest !== expectedCatalogDigest) {
    throw error(
      "publication lock evidence has an invalid internal catalogDigest: "
        + `expected ${expectedCatalogDigest}`,
    );
  }
  const expectedPackageEnvelopeDigest = digestValue({
    carriers: value.carriers.map(carrierPackageEnvelope),
    productArtifacts: value.productArtifacts.map(productArtifactPackageEnvelope),
  });
  if (value.packageEnvelopeDigest !== expectedPackageEnvelopeDigest) {
    throw error(
      "publication lock evidence has an invalid internal packageEnvelopeDigest: "
        + `expected ${expectedPackageEnvelopeDigest}`,
    );
  }
  const withoutDigest = structuredClone(value);
  delete withoutDigest.lockDigest;
  const expectedDigest = digestValue(withoutDigest);
  if (value.lockDigest !== expectedDigest) {
    throw error(
      `publication lock evidence has an invalid internal lockDigest: expected ${expectedDigest}`,
    );
  }
  return value;
}

function validateCapsuleManifestEvidence(value, record) {
  strictObject(
    value,
    [
      "carriers",
      "catalogDigest",
      "lockDigest",
      "packageEnvelopeDigest",
      "products",
      "publicationLock",
      "schema",
      "source",
    ],
    "capsule manifest evidence",
  );
  if (value.schema !== CAPSULE_SCHEMA) {
    throw error(`capsule manifest evidence schema must be ${CAPSULE_SCHEMA}`);
  }
  verifyCoreEnvelope(value, record, "capsule manifest evidence");
  const expected = record.approvedDryRun.capsuleManifest;
  if (
    !Array.isArray(value.products)
    || value.products.length !== expected.productCount
    || new Set(value.products).size !== value.products.length
    || !Array.isArray(value.carriers)
    || value.carriers.length !== expected.carrierCount
  ) {
    throw error("capsule manifest evidence counts do not match the recovery record");
  }
  strictObject(
    value.publicationLock,
    ["path", "sha256", "size"],
    "capsule manifest evidence.publicationLock",
  );
  if (
    canonicalRecoverySourceJson(value.publicationLock)
    !== canonicalRecoverySourceJson(expected.publicationLock)
  ) {
    throw error("capsule manifest embedded publication-lock identity does not match the recovery record");
  }
  return value;
}

function validateTerminalLedgerEvidence(value, record) {
  strictObject(
    value,
    [
      "catalogDigest",
      "checkpointDigest",
      "complete",
      "lockDigest",
      "packageEnvelopeDigest",
      "previousCheckpointDigest",
      "products",
      "publications",
      "receipts",
      "schema",
      "sequence",
      "source",
    ],
    "terminal bootstrap ledger evidence",
  );
  if (value.schema !== LEDGER_SCHEMA) {
    throw error(`terminal bootstrap ledger evidence schema must be ${LEDGER_SCHEMA}`);
  }
  verifyCoreEnvelope(value, record, "terminal bootstrap ledger evidence");
  const expected = record.bootstrapLedger.terminalCheckpoint;
  for (const field of [
    "checkpointDigest",
    "previousCheckpointDigest",
    "sequence",
    "complete",
  ]) {
    if (value[field] !== expected[field]) {
      throw error(`terminal bootstrap ledger evidence.${field} does not match the recovery record`);
    }
  }
  if (
    !Array.isArray(value.products)
    || value.products.length !== expected.productCount
    || new Set(value.products).size !== value.products.length
    || !Array.isArray(value.publications)
    || value.publications.length !== expected.publicationCount
    || !Array.isArray(value.receipts)
    || value.receipts.length !== expected.receiptCount
  ) {
    throw error("terminal bootstrap ledger evidence counts do not match the recovery record");
  }
  const withoutDigest = structuredClone(value);
  delete withoutDigest.checkpointDigest;
  const expectedDigest = digestValue(withoutDigest);
  if (value.checkpointDigest !== expectedDigest) {
    throw error(
      `terminal bootstrap ledger evidence has an invalid internal checkpointDigest: expected ${expectedDigest}`,
    );
  }
  return value;
}

export function validateSameVersionRecoveryEvidence(
  record,
  { publicationLock, capsuleManifest, terminalLedger },
) {
  validateRecord(record, 0);
  const lock = readEvidenceFile(publicationLock, "publication lock evidence");
  const capsule = readEvidenceFile(capsuleManifest, "capsule manifest evidence");
  const ledger = readEvidenceFile(terminalLedger, "terminal bootstrap ledger evidence");
  verifyFileBytes(
    lock.bytes,
    record.releaseEnvelope.publicationLock,
    "publication lock evidence",
  );
  verifyFileBytes(
    capsule.bytes,
    record.approvedDryRun.capsuleManifest.file,
    "capsule manifest evidence",
  );
  verifyFileBytes(
    ledger.bytes,
    record.bootstrapLedger.terminalCheckpoint.file,
    "terminal bootstrap ledger evidence",
  );
  validatePublicationLockEvidence(lock.value, record);
  validateCapsuleManifestEvidence(capsule.value, record);
  validateTerminalLedgerEvidence(ledger.value, record);
  return {
    capsuleManifestSha256: sha256(capsule.bytes),
    publicationLockSha256: sha256(lock.bytes),
    terminalLedgerSha256: sha256(ledger.bytes),
  };
}

function outputLines(record) {
  const artifactJson = (artifacts) => canonicalRecoverySourceJson(artifacts);
  const lock = record.approvedDryRun.artifactInventory.artifacts
    .filter((artifact) => artifact.name === "oliphaunt-publication-lock");
  const capsule = record.approvedDryRun.artifactInventory.artifacts
    .filter((artifact) => artifact.name === "oliphaunt-bootstrap-capsule");
  return {
    approved_capsule_artifact_metadata_json: artifactJson(capsule),
    approved_dry_run_artifact_metadata_json: artifactJson(
      record.approvedDryRun.artifactInventory.artifacts,
    ),
    approved_dry_run_id: String(record.approvedDryRun.run.id),
    approved_lock_artifact_metadata_json: artifactJson(lock),
    bootstrap_ledger_artifact_metadata_json: artifactJson(
      record.bootstrapLedger.artifactInventory.artifacts,
    ),
    bootstrap_ledger_run_id: String(record.bootstrapLedger.run.id),
    catalog_digest: record.releaseEnvelope.catalogDigest,
    lock_digest: record.releaseEnvelope.lockDigest,
    package_envelope_digest: record.releaseEnvelope.packageEnvelopeDigest,
    payload_ci_artifact_metadata_json: artifactJson(
      record.payloadQualification.artifactInventory.artifacts,
    ),
    payload_ci_run_id: String(record.payloadQualification.run.id),
    record_digest: digestValue(record),
    record_json: canonicalRecoverySourceJson(record),
    release_sha: record.releaseSource.commit,
    release_tree: record.releaseSource.tree,
  };
}

export function appendSameVersionRecoverySourceGitHubOutput(file, record) {
  const absolute = path.resolve(file);
  const metadata = lstatSync(absolute, { throwIfNoEntry: false });
  if (metadata !== undefined && (!metadata.isFile() || metadata.isSymbolicLink())) {
    throw error(`GITHUB_OUTPUT must be an absent or regular non-symlink file: ${absolute}`);
  }
  const lines = outputLines(record);
  for (const [name, value] of Object.entries(lines)) {
    if (value.includes("\n") || value.includes("\r")) {
      throw error(`refusing multiline GITHUB_OUTPUT value for ${name}`);
    }
  }
  appendFileSync(
    absolute,
    `${Object.entries(lines).map(([name, value]) => `${name}=${value}`).join("\n")}\n`,
    "utf8",
  );
  return lines;
}

function parseArgs(argv) {
  const values = new Map();
  const allowed = new Set([
    "capsule-manifest",
    "github-output",
    "publication-lock",
    "record-file",
    "release-sha",
    "terminal-ledger",
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!flag?.startsWith("--") || !allowed.has(flag.slice(2))) {
      throw error(`unknown argument ${flag ?? "<missing>"}`);
    }
    const name = flag.slice(2);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--") || values.has(name)) {
      throw error(`--${name} requires one value and may be supplied only once`);
    }
    values.set(name, value);
    index += 1;
  }
  const releaseSha = values.get("release-sha") ?? "";
  if (!SHA.test(releaseSha)) {
    throw error("usage: same-version-recovery-source.mjs --release-sha SHA [--record-file FILE] "
      + "[--github-output FILE] [--publication-lock FILE --capsule-manifest FILE "
      + "--terminal-ledger FILE]");
  }
  const evidenceNames = ["publication-lock", "capsule-manifest", "terminal-ledger"];
  const evidenceCount = evidenceNames.filter((name) => values.has(name)).length;
  if (![0, evidenceNames.length].includes(evidenceCount)) {
    throw error("publication-lock, capsule-manifest, and terminal-ledger must be supplied together");
  }
  return {
    capsuleManifest: values.get("capsule-manifest"),
    githubOutput: values.get("github-output") ?? process.env.GITHUB_OUTPUT?.trim() ?? "",
    publicationLock: values.get("publication-lock"),
    recordFile: values.get("record-file") ?? DEFAULT_SAME_VERSION_RECOVERY_SOURCES,
    releaseSha,
    terminalLedger: values.get("terminal-ledger"),
  };
}

export function main(argv = Bun.argv.slice(2)) {
  const options = parseArgs(argv);
  const document = loadSameVersionRecoverySources(options.recordFile);
  const record = selectSameVersionRecoverySource(document, options.releaseSha);
  if (options.publicationLock !== undefined) {
    validateSameVersionRecoveryEvidence(record, {
      capsuleManifest: options.capsuleManifest,
      publicationLock: options.publicationLock,
      terminalLedger: options.terminalLedger,
    });
  }
  if (options.githubOutput !== "") {
    appendSameVersionRecoverySourceGitHubOutput(options.githubOutput, record);
  }
  process.stdout.write(`${canonicalRecoverySourceJson(record)}\n`);
  return record;
}

if (import.meta.main) {
  try {
    main();
  } catch (cause) {
    console.error(cause instanceof Error ? cause.message : String(cause));
    process.exit(1);
  }
}
