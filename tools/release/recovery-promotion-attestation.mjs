#!/usr/bin/env bun

import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import process from "node:process";

import {
  LEGACY_SAME_VERSION_RECOVERY_SOURCES_SCHEMA,
  SAME_VERSION_RECOVERY_SOURCES_SCHEMA,
  canonicalRecoverySourceJson,
  isSameVersionRecoverySourcesDocument,
  sameVersionRecoverySourceProvenanceSchema,
  selectSameVersionRecoverySource,
  validateSameVersionRecoverySource,
} from "./same-version-recovery-source.mjs";
import {
  RELEASE_RECOVERY_LOCK_EQUIVALENCE_SCHEMA,
} from "./verify-release-recovery-lock.mjs";

const TOOL = "recovery-promotion-attestation.mjs";
const PUBLICATION_LOCK_SCHEMA = "oliphaunt-publication-lock-v1";
const IN_TOTO_STATEMENT_V1 = "https://in-toto.io/Statement/v1";
const CI_WORKFLOW = ".github/workflows/ci.yml";
const RELEASE_WORKFLOW = ".github/workflows/release.yml";
const MAX_JSON_BYTES = 16 * 1024 * 1024;
const MAX_ATTESTATION_SUBJECTS = 1_024;
const MAX_QUALIFICATION_ARTIFACTS = 1_024;
const SHA = /^[0-9a-f]{40}$/u;
const HASH = /^[0-9a-f]{64}$/u;
const ACTIONS_ARTIFACT_DIGEST = /^sha256:[0-9a-f]{64}$/u;
const SAFE_ARTIFACT_NAME = /^[A-Za-z0-9][A-Za-z0-9._~-]*$/u;
const GITHUB_RELEASE_ARTIFACT_ROLES = new Set([
  "github-release-asset",
  "github-release-metadata",
]);

export const RECOVERY_PROMOTION_PREDICATE_SCHEMA =
  "oliphaunt-same-version-recovery-promotion-v1";
export const RECOVERY_PROMOTION_PREDICATE_TYPE =
  "https://github.com/f0rr0/oliphaunt/attestations/same-version-recovery-promotion/v1";

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

export function canonicalRecoveryPromotionJson(value) {
  return JSON.stringify(canonical(value));
}

export function prettyCanonicalRecoveryPromotionJson(value) {
  return `${JSON.stringify(canonical(value), null, 2)}\n`;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function digestValue(value) {
  return sha256(canonicalRecoveryPromotionJson(value));
}

function isPlainObject(value) {
  return (
    value !== null
    && !Array.isArray(value)
    && typeof value === "object"
    && [Object.prototype, null].includes(Object.getPrototypeOf(value))
  );
}

function strictObject(value, expectedKeys, context, { canonicalOrder = false } = {}) {
  if (!isPlainObject(value)) {
    throw error(`${context} must be a plain object`);
  }
  const expected = [...expectedKeys].sort(compareText);
  const actual = Object.keys(value);
  if (
    canonicalRecoveryPromotionJson([...actual].sort(compareText))
    !== canonicalRecoveryPromotionJson(expected)
  ) {
    throw error(
      `${context} must contain exactly ${expected.join(", ")}; `
        + `got ${actual.join(", ") || "<none>"}`,
    );
  }
  if (
    canonicalOrder
    && canonicalRecoveryPromotionJson(actual)
      !== canonicalRecoveryPromotionJson(expected)
  ) {
    throw error(`${context} keys must be in canonical order`);
  }
  return value;
}

function assertCanonicalObjectOrder(value, context) {
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      assertCanonicalObjectOrder(entry, `${context}[${index}]`));
    return;
  }
  if (!isPlainObject(value)) return;
  const actual = Object.keys(value);
  const expected = [...actual].sort(compareText);
  if (
    canonicalRecoveryPromotionJson(actual)
    !== canonicalRecoveryPromotionJson(expected)
  ) {
    throw error(`${context} keys must be in canonical order`);
  }
  for (const key of actual) {
    assertCanonicalObjectOrder(value[key], `${context}.${key}`);
  }
}

function requireSha(value, context) {
  if (typeof value !== "string" || !SHA.test(value)) {
    throw error(`${context} must be a lowercase full Git SHA`);
  }
  return value;
}

function requireHash(value, context) {
  if (typeof value !== "string" || !HASH.test(value)) {
    throw error(`${context} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function positiveInteger(value, context) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw error(`${context} must be a positive safe integer`);
  }
  return value;
}

function normalizeSource(value, context) {
  strictObject(value, ["commit", "tree"], context);
  return canonical({
    commit: requireSha(value.commit, `${context}.commit`),
    tree: requireSha(value.tree, `${context}.tree`),
  });
}

function normalizeQualificationArtifact(value, context) {
  strictObject(value, ["digest", "id", "name", "size"], context);
  if (!ACTIONS_ARTIFACT_DIGEST.test(value.digest ?? "")) {
    throw error(`${context}.digest must be a lowercase sha256: Actions artifact digest`);
  }
  if (typeof value.name !== "string" || !SAFE_ARTIFACT_NAME.test(value.name)) {
    throw error(`${context}.name must be a safe Actions artifact name`);
  }
  return canonical({
    digest: value.digest,
    id: positiveInteger(value.id, `${context}.id`),
    name: value.name,
    size: positiveInteger(value.size, `${context}.size`),
  });
}

function compareArtifacts(left, right) {
  return compareText(left.name, right.name) || left.id - right.id;
}

function normalizeQualificationArtifacts(value, context, { requireCanonical = false } = {}) {
  if (
    !Array.isArray(value)
    || value.length < 1
    || value.length > MAX_QUALIFICATION_ARTIFACTS
  ) {
    throw error(
      `${context} must contain 1-${MAX_QUALIFICATION_ARTIFACTS} artifacts`,
    );
  }
  const normalized = value
    .map((artifact, index) =>
      normalizeQualificationArtifact(artifact, `${context}[${index}]`))
    .sort(compareArtifacts);
  const ids = new Set();
  const names = new Set();
  for (const artifact of normalized) {
    if (ids.has(artifact.id)) {
      throw error(`${context} repeats Actions artifact id ${artifact.id}`);
    }
    if (names.has(artifact.name)) {
      throw error(`${context} repeats Actions artifact name ${artifact.name}`);
    }
    ids.add(artifact.id);
    names.add(artifact.name);
  }
  for (const required of ["artifact-build-plan", "oliphaunt-release-candidate"]) {
    if (!names.has(required)) {
      throw error(`${context} must bind required candidate artifact ${required}`);
    }
  }
  if (
    requireCanonical
    && canonicalRecoveryPromotionJson(value)
      !== canonicalRecoveryPromotionJson(normalized)
  ) {
    throw error(`${context} must be in canonical name/id order`);
  }
  return normalized;
}

function normalizeApprovalArtifacts(value, context, { requireCanonical = false } = {}) {
  if (!Array.isArray(value) || value.length !== 1) {
    throw error(`${context} must contain exactly one recovery-equivalence artifact`);
  }
  const normalized = [
    normalizeQualificationArtifact(value[0], `${context}[0]`),
  ];
  if (normalized[0].name !== "oliphaunt-release-recovery-equivalence") {
    throw error(
      `${context} must identify oliphaunt-release-recovery-equivalence`,
    );
  }
  if (
    requireCanonical
    && canonicalRecoveryPromotionJson(value)
      !== canonicalRecoveryPromotionJson(normalized)
  ) {
    throw error(`${context} must be in canonical name/id order`);
  }
  return normalized;
}

function normalizeRun(value, context, {
  artifacts = false,
  expectedWorkflow,
  requireCanonical = false,
} = {}) {
  const keys = artifacts
    ? ["artifacts", "attempt", "id", "workflow"]
    : ["attempt", "id", "workflow"];
  strictObject(value, keys, context, { canonicalOrder: requireCanonical });
  if (value.workflow !== expectedWorkflow) {
    throw error(`${context}.workflow must be ${expectedWorkflow}`);
  }
  const result = {
    ...(artifacts
      ? {
          artifacts: normalizeQualificationArtifacts(
            value.artifacts,
            `${context}.artifacts`,
            { requireCanonical },
          ),
        }
      : {}),
    attempt: positiveInteger(value.attempt, `${context}.attempt`),
    id: positiveInteger(value.id, `${context}.id`),
    workflow: value.workflow,
  };
  return canonical(result);
}

function normalizeApprovalRun(value, context, { requireCanonical = false } = {}) {
  strictObject(
    value,
    ["artifacts", "attempt", "id", "workflow"],
    context,
    { canonicalOrder: requireCanonical },
  );
  if (value.workflow !== RELEASE_WORKFLOW) {
    throw error(`${context}.workflow must be ${RELEASE_WORKFLOW}`);
  }
  return canonical({
    artifacts: normalizeApprovalArtifacts(
      value.artifacts,
      `${context}.artifacts`,
      { requireCanonical },
    ),
    attempt: positiveInteger(value.attempt, `${context}.attempt`),
    id: positiveInteger(value.id, `${context}.id`),
    workflow: value.workflow,
  });
}

export function normalizeRecoveryPromotionController(
  value,
  { requireCanonical = false } = {},
) {
  strictObject(
    value,
    ["approvalRun", "promotionRun", "qualificationRun", "source"],
    "recovery controller",
    { canonicalOrder: requireCanonical },
  );
  const controller = canonical({
    approvalRun: normalizeApprovalRun(
      value.approvalRun,
      "recovery controller.approvalRun",
      { requireCanonical },
    ),
    promotionRun: normalizeRun(
      value.promotionRun,
      "recovery controller.promotionRun",
      {
        expectedWorkflow: RELEASE_WORKFLOW,
        requireCanonical,
      },
    ),
    qualificationRun: normalizeRun(
      value.qualificationRun,
      "recovery controller.qualificationRun",
      {
        artifacts: true,
        expectedWorkflow: CI_WORKFLOW,
        requireCanonical,
      },
    ),
    source: normalizeSource(value.source, "recovery controller.source"),
  });
  const runIds = [
    controller.approvalRun.id,
    controller.promotionRun.id,
    controller.qualificationRun.id,
  ];
  if (new Set(runIds).size !== runIds.length) {
    throw error(
      "controller approval, promotion, and qualification must identify "
        + "distinct workflow runs",
    );
  }
  return controller;
}

export function assertRecoveryPromotionGitHubContext(
  value,
  env = process.env,
) {
  const controller = normalizeRecoveryPromotionController(value);
  if (env.GITHUB_ACTIONS !== "true") return controller;
  const required = [
    "GITHUB_EVENT_NAME",
    "GITHUB_REF",
    "GITHUB_REPOSITORY",
    "GITHUB_RUN_ATTEMPT",
    "GITHUB_RUN_ID",
    "GITHUB_SHA",
    "GITHUB_WORKFLOW",
    "GITHUB_WORKFLOW_REF",
    "GITHUB_WORKFLOW_SHA",
  ];
  const missing = required.filter((name) =>
    typeof env[name] !== "string" || env[name].length === 0);
  if (missing.length > 0) {
    throw error(
      `GitHub promotion context lacks ${missing.join(", ")}`,
    );
  }
  if (
    env.GITHUB_EVENT_NAME !== "workflow_dispatch"
    || env.GITHUB_REF !== "refs/heads/main"
    || env.GITHUB_REPOSITORY !== "f0rr0/oliphaunt"
    || env.GITHUB_WORKFLOW !== "Release"
    || env.GITHUB_WORKFLOW_REF
      !== "f0rr0/oliphaunt/.github/workflows/release.yml@refs/heads/main"
    || env.GITHUB_SHA !== controller.source.commit
    || env.GITHUB_WORKFLOW_SHA !== controller.source.commit
    || env.GITHUB_RUN_ID !== String(controller.promotionRun.id)
    || env.GITHUB_RUN_ATTEMPT !== String(controller.promotionRun.attempt)
  ) {
    throw error(
      "controller promotionRun/source does not match the current "
        + "GitHub Release workflow identity",
    );
  }
  return controller;
}

function normalizeSubject(value, context) {
  strictObject(value, ["name", "sha256"], context);
  const name = value.name;
  if (
    typeof name !== "string"
    || name.length === 0
    || name === "."
    || name === ".."
    || name.includes("/")
    || name.includes("\\")
    || /[\u0000-\u001f\u007f]/u.test(name)
    || Buffer.byteLength(name) > 255
  ) {
    throw error(`${context}.name must be a bounded direct artifact basename`);
  }
  return canonical({
    name,
    sha256: requireHash(value.sha256, `${context}.sha256`),
  });
}

function compareSubjects(left, right) {
  return compareText(left.name, right.name)
    || compareText(left.sha256, right.sha256);
}

export function normalizeRecoveryPromotionSubjects(
  value,
  { requireCanonical = false } = {},
) {
  if (
    !Array.isArray(value)
    || value.length < 1
    || value.length > MAX_ATTESTATION_SUBJECTS
  ) {
    throw error(
      `recovery promotion subjects must contain 1-${MAX_ATTESTATION_SUBJECTS} rows`,
    );
  }
  const normalized = value
    .map((subject, index) =>
      normalizeSubject(subject, `recovery promotion subjects[${index}]`))
    .sort(compareSubjects);
  const names = new Set();
  for (const subject of normalized) {
    if (names.has(subject.name)) {
      throw error(
        `recovery promotion subjects repeat or ambiguously reuse ${subject.name}`,
      );
    }
    names.add(subject.name);
  }
  if (
    requireCanonical
    && canonicalRecoveryPromotionJson(value)
      !== canonicalRecoveryPromotionJson(normalized)
  ) {
    throw error("recovery promotion subjects must be in canonical name/digest order");
  }
  return normalized;
}

export function recoveryPromotionSubjectChecksums(subjects) {
  return normalizeRecoveryPromotionSubjects(subjects)
    .map(({ name, sha256: digest }) => `${digest}  ${name}\n`)
    .join("");
}

export function recoveryPromotionSubjectsFromLock(lock) {
  validatePublicationLock(lock);
  const selectedProducts = new Set(lock.products.map(({ id }) => id));
  if (
    selectedProducts.size !== lock.products.length
    || [...selectedProducts].some((product) =>
      typeof product !== "string" || product.length === 0)
  ) {
    throw error("original publication lock contains invalid or duplicate products");
  }
  const subjects = lock.productArtifacts
    .filter(({ role }) => GITHUB_RELEASE_ARTIFACT_ROLES.has(role))
    .map((artifact, index) => {
      if (!selectedProducts.has(artifact?.product)) {
        throw error(
          `original publication lock GitHub artifact[${index}] belongs to an unselected product`,
        );
      }
      return {
        name: artifact.name,
        sha256: artifact.sha256,
      };
    });
  return normalizeRecoveryPromotionSubjects(subjects);
}

function validatePublicationLock(lock) {
  if (!isPlainObject(lock)) {
    throw error("original publication lock must be a plain object");
  }
  if (lock.schema !== PUBLICATION_LOCK_SCHEMA) {
    throw error(`original publication lock schema must be ${PUBLICATION_LOCK_SCHEMA}`);
  }
  const source = normalizeSource(lock.source, "original publication lock.source");
  for (const field of ["lockDigest", "catalogDigest", "packageEnvelopeDigest"]) {
    requireHash(lock[field], `original publication lock.${field}`);
  }
  for (const field of ["products", "carriers", "productArtifacts"]) {
    if (!Array.isArray(lock[field])) {
      throw error(`original publication lock.${field} must be an array`);
    }
  }
  const withoutDigest = structuredClone(lock);
  delete withoutDigest.lockDigest;
  const expectedDigest = digestValue(withoutDigest);
  if (lock.lockDigest !== expectedDigest) {
    throw error(
      `original publication lock lockDigest mismatch: `
        + `expected ${expectedDigest}, got ${lock.lockDigest}`,
    );
  }
  return {
    catalogDigest: lock.catalogDigest,
    lockDigest: lock.lockDigest,
    packageEnvelopeDigest: lock.packageEnvelopeDigest,
    schema: lock.schema,
    source,
  };
}

function validateSourceProvenanceRecord(record, lockBinding) {
  validateSameVersionRecoverySource(record);
  if (
    canonicalRecoveryPromotionJson(record.releaseSource)
      !== canonicalRecoveryPromotionJson(lockBinding.source)
  ) {
    throw error("source provenance releaseSource does not match the original lock");
  }
  for (const field of ["lockDigest", "catalogDigest", "packageEnvelopeDigest"]) {
    if (record.releaseEnvelope[field] !== lockBinding[field]) {
      throw error(`source provenance releaseEnvelope.${field} does not match the original lock`);
    }
  }
  return canonical({
    recordDigest: sha256(canonicalRecoverySourceJson(record)),
    schema: sameVersionRecoverySourceProvenanceSchema(record),
  });
}

function validateOriginalLockArtifact(value, context) {
  strictObject(value, ["artifact", "runId", "workflow"], context);
  if (value.workflow !== "Release") {
    throw error(`${context}.workflow must be Release`);
  }
  const runId = positiveInteger(value.runId, `${context}.runId`);
  const artifact = normalizeQualificationArtifact(value.artifact, `${context}.artifact`);
  if (artifact.name !== "oliphaunt-publication-lock") {
    throw error(`${context}.artifact must identify oliphaunt-publication-lock`);
  }
  return canonical({
    artifact,
    runId,
    workflow: value.workflow,
  });
}

function validateRecoveryApproval(
  approval,
  lock,
  lockBinding,
  controller,
  provenanceRecord,
) {
  strictObject(
    approval,
    [
      "carrierCount",
      "catalogDigest",
      "comparedFields",
      "controllerSource",
      "evidenceDigest",
      "originalLockArtifact",
      "originalLockDigest",
      "packageEnvelopeDigest",
      "productArtifactCount",
      "productCount",
      "releaseSource",
      "replayLockDigest",
      "schema",
    ],
    "recovery approval evidence",
  );
  if (approval.schema !== RELEASE_RECOVERY_LOCK_EQUIVALENCE_SCHEMA) {
    throw error(
      `recovery approval evidence schema must be `
        + RELEASE_RECOVERY_LOCK_EQUIVALENCE_SCHEMA,
    );
  }
  const releaseSource = normalizeSource(
    approval.releaseSource,
    "recovery approval evidence.releaseSource",
  );
  const controllerSource = normalizeSource(
    approval.controllerSource,
    "recovery approval evidence.controllerSource",
  );
  if (
    canonicalRecoveryPromotionJson(releaseSource)
      !== canonicalRecoveryPromotionJson(lockBinding.source)
    || canonicalRecoveryPromotionJson(controllerSource)
      !== canonicalRecoveryPromotionJson(controller.source)
  ) {
    throw error("recovery approval source/controller identity does not match promotion inputs");
  }
  if (
    approval.originalLockDigest !== lockBinding.lockDigest
    || approval.replayLockDigest !== lockBinding.lockDigest
    || approval.catalogDigest !== lockBinding.catalogDigest
    || approval.packageEnvelopeDigest !== lockBinding.packageEnvelopeDigest
  ) {
    throw error("recovery approval lock/catalog/package envelope does not match the original lock");
  }
  for (const [field, expected] of [
    ["productCount", lock.products.length],
    ["carrierCount", lock.carriers.length],
    ["productArtifactCount", lock.productArtifacts.length],
  ]) {
    if (!Number.isSafeInteger(approval[field]) || approval[field] !== expected) {
      throw error(`recovery approval ${field} does not match the original lock`);
    }
  }
  const originalLockArtifact = validateOriginalLockArtifact(
    approval.originalLockArtifact,
    "recovery approval evidence.originalLockArtifact",
  );
  const provenanceLockArtifacts =
    provenanceRecord.approvedDryRun.artifactInventory.artifacts
      .filter(({ name }) => name === "oliphaunt-publication-lock");
  if (provenanceLockArtifacts.length !== 1) {
    throw error(
      "source provenance must contain exactly one approved publication-lock artifact",
    );
  }
  const provenanceLockArtifact = normalizeQualificationArtifact(
    provenanceLockArtifacts[0],
    "source provenance approved publication-lock artifact",
  );
  if (
    originalLockArtifact.workflow !== provenanceRecord.approvedDryRun.workflow.name
    || originalLockArtifact.runId !== provenanceRecord.approvedDryRun.run.id
    || canonicalRecoveryPromotionJson(originalLockArtifact.artifact)
      !== canonicalRecoveryPromotionJson(provenanceLockArtifact)
  ) {
    throw error(
      "recovery approval original lock artifact does not match the pinned "
        + "source-provenance dry run",
    );
  }
  if (
    !Array.isArray(approval.comparedFields)
    || approval.comparedFields.some((field) => typeof field !== "string")
    || new Set(approval.comparedFields).size !== approval.comparedFields.length
  ) {
    throw error("recovery approval comparedFields must be a unique string list");
  }
  const expectedFields = Object.keys(lock).sort(compareText);
  if (
    canonicalRecoveryPromotionJson(approval.comparedFields)
      !== canonicalRecoveryPromotionJson(expectedFields)
  ) {
    throw error("recovery approval comparedFields do not cover the complete original lock");
  }
  requireHash(approval.evidenceDigest, "recovery approval evidence.evidenceDigest");
  const withoutDigest = structuredClone(approval);
  delete withoutDigest.evidenceDigest;
  const expectedDigest = digestValue(withoutDigest);
  if (approval.evidenceDigest !== expectedDigest) {
    throw error(
      `recovery approval evidenceDigest mismatch: `
        + `expected ${expectedDigest}, got ${approval.evidenceDigest}`,
    );
  }
  return canonical({
    evidenceDigest: approval.evidenceDigest,
    schema: approval.schema,
  });
}

function predicateDigest(predicate) {
  const withoutDigest = structuredClone(predicate);
  delete withoutDigest.evidenceDigest;
  return digestValue(withoutDigest);
}

export function createRecoveryPromotionPredicate({
  controller,
  lock,
  provenanceRecord,
  recoveryApproval,
  subjects,
} = {}) {
  const lockBinding = validatePublicationLock(lock);
  const normalizedController = normalizeRecoveryPromotionController(controller);
  if (
    lockBinding.source.commit === normalizedController.source.commit
    || lockBinding.source.tree === normalizedController.source.tree
  ) {
    throw error("recovery controller must have a distinct commit and tree");
  }
  const normalizedSubjects = normalizeRecoveryPromotionSubjects(subjects);
  const expectedSubjects = recoveryPromotionSubjectsFromLock(lock);
  if (
    canonicalRecoveryPromotionJson(normalizedSubjects)
      !== canonicalRecoveryPromotionJson(expectedSubjects)
  ) {
    throw error(
      "recovery promotion subjects must exactly match every frozen GitHub "
        + "release artifact in the original publication lock",
    );
  }
  const body = canonical({
    controller: normalizedController,
    originalLock: lockBinding,
    recoveryApproval: validateRecoveryApproval(
      recoveryApproval,
      lock,
      lockBinding,
      normalizedController,
      provenanceRecord,
    ),
    schema: RECOVERY_PROMOTION_PREDICATE_SCHEMA,
    sourceProvenance: validateSourceProvenanceRecord(
      provenanceRecord,
      lockBinding,
    ),
    subjects: normalizedSubjects,
  });
  return canonical({
    ...body,
    evidenceDigest: digestValue(body),
  });
}

function validatePredicateShape(predicate) {
  strictObject(
    predicate,
    [
      "controller",
      "evidenceDigest",
      "originalLock",
      "recoveryApproval",
      "schema",
      "sourceProvenance",
      "subjects",
    ],
    "recovery promotion predicate",
    { canonicalOrder: true },
  );
  assertCanonicalObjectOrder(predicate, "recovery promotion predicate");
  if (predicate.schema !== RECOVERY_PROMOTION_PREDICATE_SCHEMA) {
    throw error(
      `recovery promotion predicate schema must be `
        + RECOVERY_PROMOTION_PREDICATE_SCHEMA,
    );
  }
  normalizeRecoveryPromotionController(predicate.controller, {
    requireCanonical: true,
  });
  strictObject(
    predicate.originalLock,
    ["catalogDigest", "lockDigest", "packageEnvelopeDigest", "schema", "source"],
    "recovery promotion predicate.originalLock",
    { canonicalOrder: true },
  );
  if (predicate.originalLock.schema !== PUBLICATION_LOCK_SCHEMA) {
    throw error("recovery promotion predicate original lock schema is invalid");
  }
  normalizeSource(
    predicate.originalLock.source,
    "recovery promotion predicate.originalLock.source",
  );
  for (const field of ["catalogDigest", "lockDigest", "packageEnvelopeDigest"]) {
    requireHash(
      predicate.originalLock[field],
      `recovery promotion predicate.originalLock.${field}`,
    );
  }
  strictObject(
    predicate.recoveryApproval,
    ["evidenceDigest", "schema"],
    "recovery promotion predicate.recoveryApproval",
    { canonicalOrder: true },
  );
  if (
    predicate.recoveryApproval.schema
      !== RELEASE_RECOVERY_LOCK_EQUIVALENCE_SCHEMA
  ) {
    throw error("recovery promotion predicate recovery approval schema is invalid");
  }
  requireHash(
    predicate.recoveryApproval.evidenceDigest,
    "recovery promotion predicate.recoveryApproval.evidenceDigest",
  );
  strictObject(
    predicate.sourceProvenance,
    ["recordDigest", "schema"],
    "recovery promotion predicate.sourceProvenance",
    { canonicalOrder: true },
  );
  if (!new Set([
    LEGACY_SAME_VERSION_RECOVERY_SOURCES_SCHEMA,
    SAME_VERSION_RECOVERY_SOURCES_SCHEMA,
  ]).has(predicate.sourceProvenance.schema)) {
    throw error("recovery promotion predicate source provenance schema is invalid");
  }
  requireHash(
    predicate.sourceProvenance.recordDigest,
    "recovery promotion predicate.sourceProvenance.recordDigest",
  );
  normalizeRecoveryPromotionSubjects(predicate.subjects, {
    requireCanonical: true,
  });
  requireHash(
    predicate.evidenceDigest,
    "recovery promotion predicate.evidenceDigest",
  );
  const expectedDigest = predicateDigest(predicate);
  if (predicate.evidenceDigest !== expectedDigest) {
    throw error(
      `recovery promotion predicate evidenceDigest mismatch: `
        + `expected ${expectedDigest}, got ${predicate.evidenceDigest}`,
    );
  }
}

export function validateRecoveryPromotionPredicateEnvelope(predicate) {
  validatePredicateShape(predicate);
  return predicate;
}

export function validateRecoveryPromotionPredicate(
  predicate,
  {
    controller,
    lock,
    provenanceRecord,
    recoveryApproval,
    subjects = predicate?.subjects,
  } = {},
) {
  validatePredicateShape(predicate);
  const expected = createRecoveryPromotionPredicate({
    controller,
    lock,
    provenanceRecord,
    recoveryApproval,
    subjects,
  });
  if (
    canonicalRecoveryPromotionJson(predicate)
      !== canonicalRecoveryPromotionJson(expected)
  ) {
    throw error(
      "recovery promotion predicate does not match the original lock, "
        + "controller runs, source provenance, approval, or subjects",
    );
  }
  return predicate;
}

function normalizeStatementSubjects(subjects) {
  if (!Array.isArray(subjects)) {
    throw error("recovery promotion statement.subject must be an array");
  }
  const converted = subjects.map((subject, index) => {
    const context = `recovery promotion statement.subject[${index}]`;
    strictObject(subject, ["digest", "name"], context);
    strictObject(subject.digest, ["sha256"], `${context}.digest`);
    return {
      name: subject.name,
      sha256: subject.digest.sha256,
    };
  });
  return normalizeRecoveryPromotionSubjects(converted, {
    requireCanonical: true,
  });
}

export function validateRecoveryPromotionStatement(statement, expectations = {}) {
  strictObject(
    statement,
    ["_type", "predicate", "predicateType", "subject"],
    "recovery promotion statement",
  );
  if (
    statement._type !== IN_TOTO_STATEMENT_V1
    || statement.predicateType !== RECOVERY_PROMOTION_PREDICATE_TYPE
  ) {
    throw error(
      "recovery promotion statement must be an in-toto v1 statement "
        + `with predicate type ${RECOVERY_PROMOTION_PREDICATE_TYPE}`,
    );
  }
  const subjects = normalizeStatementSubjects(statement.subject);
  if (
    canonicalRecoveryPromotionJson(subjects)
      !== canonicalRecoveryPromotionJson(statement.predicate?.subjects)
  ) {
    throw error(
      "recovery promotion statement subjects differ from the predicate subject binding",
    );
  }
  const predicate = validateRecoveryPromotionPredicate(
    statement.predicate,
    {
      ...expectations,
      subjects,
    },
  );
  return { predicate, subjects };
}

function readBoundedJson(file, context) {
  const absolute = path.resolve(file);
  const metadata = lstatSync(absolute, { throwIfNoEntry: false });
  if (
    !metadata?.isFile()
    || metadata.isSymbolicLink()
    || metadata.size < 1
    || metadata.size > MAX_JSON_BYTES
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

function selectedProvenanceRecord(value, releaseSha) {
  if (isSameVersionRecoverySourcesDocument(value)) {
    return selectSameVersionRecoverySource(
      value,
      releaseSha,
    );
  }
  validateSameVersionRecoverySource(value);
  if (value.releaseSource.commit !== releaseSha) {
    throw error("selected provenance record does not match the original lock source");
  }
  return value;
}

function writeImmutableCanonicalJson(file, value) {
  const absolute = path.resolve(file);
  const body = prettyCanonicalRecoveryPromotionJson(value);
  if (Buffer.byteLength(body) > MAX_JSON_BYTES) {
    throw error(`recovery promotion predicate exceeds ${MAX_JSON_BYTES} bytes`);
  }
  mkdirSync(path.dirname(absolute), { recursive: true });
  const temporary = `${absolute}.tmp-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(temporary, body, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    try {
      linkSync(temporary, absolute);
    } catch (cause) {
      if (cause?.code !== "EEXIST") throw cause;
      const existing = lstatSync(absolute, { throwIfNoEntry: false });
      if (
        !existing?.isFile()
        || existing.isSymbolicLink()
        || existing.size !== Buffer.byteLength(body)
        || readFileSync(absolute, "utf8") !== body
      ) {
        throw error(`refusing to replace non-identical predicate ${absolute}`);
      }
    }
  } finally {
    rmSync(temporary, { force: true });
  }
  return absolute;
}

function writeImmutableText(file, body, context) {
  const absolute = path.resolve(file);
  if (
    typeof body !== "string"
    || body.length < 1
    || Buffer.byteLength(body) > MAX_JSON_BYTES
  ) {
    throw error(`${context} must be non-empty and at most ${MAX_JSON_BYTES} bytes`);
  }
  mkdirSync(path.dirname(absolute), { recursive: true });
  const temporary = `${absolute}.tmp-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(temporary, body, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    try {
      linkSync(temporary, absolute);
    } catch (cause) {
      if (cause?.code !== "EEXIST") throw cause;
      const existing = lstatSync(absolute, { throwIfNoEntry: false });
      if (
        !existing?.isFile()
        || existing.isSymbolicLink()
        || existing.size !== Buffer.byteLength(body)
        || readFileSync(absolute, "utf8") !== body
      ) {
        throw error(`refusing to replace non-identical ${context} ${absolute}`);
      }
    }
  } finally {
    rmSync(temporary, { force: true });
  }
  return absolute;
}

function parsePrepareArgs(argv) {
  const allowed = new Set([
    "approval",
    "approval-artifacts-json",
    "approval-run-attempt",
    "approval-run-id",
    "checksums-output",
    "controller-output",
    "controller-sha",
    "controller-tree",
    "github-output",
    "lock",
    "predicate-output",
    "promotion-run-attempt",
    "promotion-run-id",
    "provenance",
    "qualification-artifacts-json",
    "qualification-run-attempt",
    "qualification-run-id",
    "subjects-output",
  ]);
  const values = new Map();
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index];
    const name = flag?.startsWith("--") ? flag.slice(2) : "";
    const value = argv[index + 1];
    if (
      !allowed.has(name)
      || value === undefined
      || value.startsWith("--")
      || values.has(name)
    ) {
      throw error(`invalid or repeated prepare argument ${flag ?? "<missing>"}`);
    }
    values.set(name, value);
    index += 1;
  }
  const required = [...allowed].filter((name) => name !== "github-output");
  for (const name of required) {
    if (!values.has(name)) throw error(`prepare requires --${name}`);
  }
  return {
    approval: values.get("approval"),
    approvalArtifactsJson: values.get("approval-artifacts-json"),
    approvalRunAttempt: values.get("approval-run-attempt"),
    approvalRunId: values.get("approval-run-id"),
    checksumsOutput: values.get("checksums-output"),
    controllerOutput: values.get("controller-output"),
    controllerSha: values.get("controller-sha"),
    controllerTree: values.get("controller-tree"),
    githubOutput: values.get("github-output") ?? process.env.GITHUB_OUTPUT?.trim() ?? "",
    lock: values.get("lock"),
    operation: "prepare",
    predicateOutput: values.get("predicate-output"),
    promotionRunAttempt: values.get("promotion-run-attempt"),
    promotionRunId: values.get("promotion-run-id"),
    provenance: values.get("provenance"),
    qualificationArtifactsJson: values.get("qualification-artifacts-json"),
    qualificationRunAttempt: values.get("qualification-run-attempt"),
    qualificationRunId: values.get("qualification-run-id"),
    subjectsOutput: values.get("subjects-output"),
  };
}

function parseArgs(argv) {
  const operation = argv[0];
  if (operation === "prepare") return parsePrepareArgs(argv);
  if (!["create", "verify"].includes(operation)) {
    throw error(
      "usage: recovery-promotion-attestation.mjs prepare|create|verify "
        + "--lock FILE --controller FILE --provenance FILE "
        + "--approval FILE --subjects FILE "
        + "(--output FILE | --predicate FILE)",
    );
  }
  const allowed = new Set([
    "approval",
    "controller",
    "lock",
    "output",
    "predicate",
    "provenance",
    "subjects",
  ]);
  const values = new Map();
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index];
    const name = flag?.startsWith("--") ? flag.slice(2) : "";
    const value = argv[index + 1];
    if (
      !allowed.has(name)
      || value === undefined
      || value.startsWith("--")
      || values.has(name)
    ) {
      throw error(`invalid or repeated argument ${flag ?? "<missing>"}`);
    }
    values.set(name, value);
    index += 1;
  }
  for (const required of [
    "approval",
    "controller",
    "lock",
    "provenance",
    "subjects",
  ]) {
    if (!values.has(required)) {
      throw error(`--${required} is required`);
    }
  }
  if (
    operation === "create"
      ? !values.has("output") || values.has("predicate")
      : !values.has("predicate") || values.has("output")
  ) {
    throw error(
      operation === "create"
        ? "create requires --output and forbids --predicate"
        : "verify requires --predicate and forbids --output",
    );
  }
  return {
    approval: values.get("approval"),
    controller: values.get("controller"),
    lock: values.get("lock"),
    operation,
    output: values.get("output"),
    predicate: values.get("predicate"),
    provenance: values.get("provenance"),
    subjects: values.get("subjects"),
  };
}

function preparePositiveInteger(value, context) {
  if (!/^[1-9][0-9]*$/u.test(value ?? "")) {
    throw error(`${context} must be a positive safe integer`);
  }
  return positiveInteger(Number(value), context);
}

function prepareQualificationArtifacts(value) {
  let artifacts;
  try {
    artifacts = JSON.parse(value);
  } catch (cause) {
    throw error(`qualification artifact metadata is invalid JSON: ${cause.message}`);
  }
  return normalizeQualificationArtifacts(
    artifacts,
    "recovery controller.qualificationRun.artifacts",
  );
}

function prepareApprovalArtifacts(value) {
  let artifacts;
  try {
    artifacts = JSON.parse(value);
  } catch (cause) {
    throw error(`approval artifact metadata is invalid JSON: ${cause.message}`);
  }
  return normalizeApprovalArtifacts(
    artifacts,
    "recovery controller.approvalRun.artifacts",
  );
}

function appendPrepareGitHubOutput(file, values) {
  if (!file) return;
  const absolute = path.resolve(file);
  const metadata = lstatSync(absolute, { throwIfNoEntry: false });
  if (metadata !== undefined && (!metadata.isFile() || metadata.isSymbolicLink())) {
    throw error(`GITHUB_OUTPUT must be an absent or regular non-symlink file: ${absolute}`);
  }
  const lines = Object.entries(values).map(([name, value]) => {
    const rendered = String(value);
    if (/[\r\n]/u.test(rendered)) {
      throw error(`refusing multiline GITHUB_OUTPUT value for ${name}`);
    }
    return `${name}=${rendered}`;
  });
  appendFileSync(absolute, `${lines.join("\n")}\n`, "utf8");
}

function prepareRecoveryPromotionFiles(options) {
  const lock = readBoundedJson(options.lock, "original publication lock").value;
  const provenanceValue = readBoundedJson(
    options.provenance,
    "source provenance record",
  ).value;
  const provenanceRecord = selectedProvenanceRecord(
    provenanceValue,
    lock?.source?.commit,
  );
  const recoveryApproval = readBoundedJson(
    options.approval,
    "recovery approval evidence",
  ).value;
  const controller = normalizeRecoveryPromotionController({
    approvalRun: {
      artifacts: prepareApprovalArtifacts(options.approvalArtifactsJson),
      attempt: preparePositiveInteger(
        options.approvalRunAttempt,
        "approval run attempt",
      ),
      id: preparePositiveInteger(options.approvalRunId, "approval run id"),
      workflow: RELEASE_WORKFLOW,
    },
    promotionRun: {
      attempt: preparePositiveInteger(
        options.promotionRunAttempt,
        "promotion run attempt",
      ),
      id: preparePositiveInteger(options.promotionRunId, "promotion run id"),
      workflow: RELEASE_WORKFLOW,
    },
    qualificationRun: {
      artifacts: prepareQualificationArtifacts(
        options.qualificationArtifactsJson,
      ),
      attempt: preparePositiveInteger(
        options.qualificationRunAttempt,
        "qualification run attempt",
      ),
      id: preparePositiveInteger(
        options.qualificationRunId,
        "qualification run id",
      ),
      workflow: CI_WORKFLOW,
    },
    source: {
      commit: options.controllerSha,
      tree: options.controllerTree,
    },
  });
  assertRecoveryPromotionGitHubContext(controller);
  const subjects = recoveryPromotionSubjectsFromLock(lock);
  const predicate = createRecoveryPromotionPredicate({
    controller,
    lock,
    provenanceRecord,
    recoveryApproval,
    subjects,
  });
  const controllerPath = writeImmutableCanonicalJson(
    options.controllerOutput,
    controller,
  );
  const subjectsPath = writeImmutableCanonicalJson(
    options.subjectsOutput,
    subjects,
  );
  const predicatePath = writeImmutableCanonicalJson(
    options.predicateOutput,
    predicate,
  );
  const checksumsPath = writeImmutableText(
    options.checksumsOutput,
    recoveryPromotionSubjectChecksums(subjects),
    "recovery promotion subject checksums",
  );
  appendPrepareGitHubOutput(options.githubOutput, {
    checksums_path: checksumsPath,
    controller_path: controllerPath,
    evidence_digest: predicate.evidenceDigest,
    predicate_path: predicatePath,
    predicate_type: RECOVERY_PROMOTION_PREDICATE_TYPE,
    subjects_path: subjectsPath,
  });
  process.stdout.write(
    `prepared ${RECOVERY_PROMOTION_PREDICATE_TYPE} `
      + `${predicate.evidenceDigest} for ${subjects.length} subject(s)\n`,
  );
  return { controller, predicate, subjects };
}

export function main(argv = Bun.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.operation === "prepare") {
    return prepareRecoveryPromotionFiles(options);
  }
  const lock = readBoundedJson(options.lock, "original publication lock").value;
  const controller = readBoundedJson(options.controller, "recovery controller").value;
  assertRecoveryPromotionGitHubContext(controller);
  const provenanceValue = readBoundedJson(
    options.provenance,
    "source provenance record",
  ).value;
  const provenanceRecord = selectedProvenanceRecord(
    provenanceValue,
    lock?.source?.commit,
  );
  const recoveryApproval = readBoundedJson(
    options.approval,
    "recovery approval evidence",
  ).value;
  const subjects = readBoundedJson(
    options.subjects,
    "recovery promotion subjects",
  ).value;
  if (options.operation === "create") {
    const predicate = createRecoveryPromotionPredicate({
      controller,
      lock,
      provenanceRecord,
      recoveryApproval,
      subjects,
    });
    writeImmutableCanonicalJson(options.output, predicate);
    process.stdout.write(
      `created ${RECOVERY_PROMOTION_PREDICATE_TYPE} ${predicate.evidenceDigest}\n`,
    );
    return predicate;
  }
  const predicateFile = readBoundedJson(
    options.predicate,
    "recovery promotion predicate",
  );
  if (
    predicateFile.bytes.toString("utf8")
      !== prettyCanonicalRecoveryPromotionJson(predicateFile.value)
  ) {
    throw error(
      "recovery promotion predicate file must be canonical sorted JSON "
        + "with one trailing newline",
    );
  }
  const predicate = validateRecoveryPromotionPredicate(
    predicateFile.value,
    {
      controller,
      lock,
      provenanceRecord,
      recoveryApproval,
      subjects,
    },
  );
  process.stdout.write(
    `verified ${RECOVERY_PROMOTION_PREDICATE_TYPE} ${predicate.evidenceDigest}\n`,
  );
  return predicate;
}

if (import.meta.main) {
  try {
    main();
  } catch (cause) {
    console.error(cause instanceof Error ? cause.message : String(cause));
    process.exit(1);
  }
}
