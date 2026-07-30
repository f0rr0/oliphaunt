#!/usr/bin/env bun

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { execFileSync } from "../test/fd-backed-spawn-sync.mjs";
import {
  DEFAULT_SAME_VERSION_RECOVERY_SOURCES,
  loadSameVersionRecoverySources,
} from "./same-version-recovery-source.mjs";
import {
  verifyReleaseRecoveryLockEquivalence,
} from "./verify-release-recovery-lock.mjs";
import {
  RECOVERY_PROMOTION_PREDICATE_SCHEMA,
  RECOVERY_PROMOTION_PREDICATE_TYPE,
  assertRecoveryPromotionGitHubContext,
  canonicalRecoveryPromotionJson,
  createRecoveryPromotionPredicate,
  prettyCanonicalRecoveryPromotionJson,
  recoveryPromotionSubjectChecksums,
  recoveryPromotionSubjectsFromLock,
  validateRecoveryPromotionPredicate,
  validateRecoveryPromotionStatement,
} from "./recovery-promotion-attestation.mjs";
import {
  buildGithubAttestationReceipt,
  validateGithubAttestationReceipt,
} from "./verify_github_release_attestations.mjs";

const RELEASE_COMMIT = "9c398f4e5c05f494f9b752a8634e74e0bc11dd19";
const RELEASE_TREE = "396cf3b10adb1a5b625e66c5ebacf8c3d364b543";
const CONTROLLER_COMMIT = "3".repeat(40);
const CONTROLLER_TREE = "4".repeat(40);
const TOOL = path.join(import.meta.dir, "recovery-promotion-attestation.mjs");

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function digestValue(value) {
  return sha256(canonicalRecoveryPromotionJson(value));
}

function updateSource(record, source) {
  record.releaseSource = structuredClone(source);
  record.payloadQualification.run.headSha = source.commit;
  record.approvedDryRun.run.headSha = source.commit;
  record.bootstrapLedger.run.headSha = source.commit;
  record.approvedDryRun.capsuleManifest.source = structuredClone(source);
  record.bootstrapLedger.terminalCheckpoint.source = structuredClone(source);
}

function fixture() {
  const provenanceRecord = structuredClone(
    loadSameVersionRecoverySources(
      DEFAULT_SAME_VERSION_RECOVERY_SOURCES,
      { verifyGit: false },
    ).records[0],
  );
  const source = { commit: RELEASE_COMMIT, tree: RELEASE_TREE };
  updateSource(provenanceRecord, source);

  const lock = {
    schema: "oliphaunt-publication-lock-v1",
    catalogSchema: "oliphaunt-publication-catalog-v1",
    catalogDigest: "5".repeat(64),
    source,
    products: Array.from(
      { length: provenanceRecord.releaseEnvelope.productCount },
      (_, index) => ({ id: `product-${index}`, version: "1.0.0" }),
    ),
    carriers: Array.from(
      { length: provenanceRecord.releaseEnvelope.carrierCount },
      (_, index) => ({ id: `carrier-${index}` }),
    ),
    productArtifacts: Array.from(
      { length: provenanceRecord.releaseEnvelope.productArtifactCount },
      (_, index) => {
        if (index === 0) {
          return {
            id: "artifact-0",
            name: "alpha.zip",
            path: "target/release/alpha.zip",
            product: "product-0",
            role: "github-release-asset",
            sha256: "a".repeat(64),
            size: 100,
          };
        }
        if (index === 1) {
          return {
            id: "artifact-1",
            name: "zeta.tar.gz",
            path: "target/release/zeta.tar.gz",
            product: "product-0",
            role: "github-release-metadata",
            sha256: "b".repeat(64),
            size: 200,
          };
        }
        return { id: `artifact-${index}`, role: "registry-input" };
      },
    ),
    packageEnvelopeDigest: "6".repeat(64),
  };
  lock.lockDigest = digestValue(lock);
  for (const field of ["catalogDigest", "lockDigest", "packageEnvelopeDigest"]) {
    provenanceRecord.releaseEnvelope[field] = lock[field];
    provenanceRecord.approvedDryRun.capsuleManifest[field] = lock[field];
    provenanceRecord.bootstrapLedger.terminalCheckpoint[field] = lock[field];
  }

  const controller = {
    approvalRun: {
      workflow: ".github/workflows/release.yml",
      id: 9000,
      attempt: 1,
      artifacts: [
        {
          size: 400,
          name: "oliphaunt-release-recovery-equivalence",
          id: 7000,
          digest: `sha256:${"6".repeat(64)}`,
        },
      ],
    },
    source: {
      tree: CONTROLLER_TREE,
      commit: CONTROLLER_COMMIT,
    },
    qualificationRun: {
      workflow: ".github/workflows/ci.yml",
      id: 9001,
      attempt: 2,
      artifacts: [
        {
          size: 300,
          name: "oliphaunt-release-candidate",
          id: 7002,
          digest: `sha256:${"8".repeat(64)}`,
        },
        {
          size: 200,
          name: "artifact-build-plan",
          id: 7001,
          digest: `sha256:${"7".repeat(64)}`,
        },
      ],
    },
    promotionRun: {
      workflow: ".github/workflows/release.yml",
      id: 9002,
      attempt: 1,
    },
  };

  const recoveryApproval = verifyReleaseRecoveryLockEquivalence({
    original: lock,
    replay: structuredClone(lock),
    releaseSource: source,
    controllerSource: {
      commit: CONTROLLER_COMMIT,
      tree: CONTROLLER_TREE,
    },
    originalEvidence: {
      runId: provenanceRecord.approvedDryRun.run.id,
      artifacts: provenanceRecord.approvedDryRun.artifactInventory.artifacts
        .filter(({ name }) => name === "oliphaunt-publication-lock"),
    },
  });

  const subjects = [
    { sha256: "b".repeat(64), name: "zeta.tar.gz" },
    { sha256: "a".repeat(64), name: "alpha.zip" },
  ];
  return {
    controller,
    lock,
    provenanceRecord,
    recoveryApproval,
    subjects,
  };
}

function create(values = fixture()) {
  return createRecoveryPromotionPredicate(values);
}

function refreshPredicateDigest(predicate) {
  const body = structuredClone(predicate);
  delete body.evidenceDigest;
  predicate.evidenceDigest = digestValue(body);
  return predicate;
}

test("creates one deterministic canonical predicate binding both runs and every evidence identity", () => {
  const values = fixture();
  const predicate = create(values);
  assert.equal(predicate.schema, RECOVERY_PROMOTION_PREDICATE_SCHEMA);
  assert.match(
    RECOVERY_PROMOTION_PREDICATE_TYPE,
    /^https:\/\/github[.]com\/f0rr0\/oliphaunt\/attestations\//u,
  );
  assert.deepEqual(Object.keys(predicate), [
    "controller",
    "evidenceDigest",
    "originalLock",
    "recoveryApproval",
    "schema",
    "sourceProvenance",
    "subjects",
  ]);
  assert.deepEqual(predicate.controller.source, {
    commit: CONTROLLER_COMMIT,
    tree: CONTROLLER_TREE,
  });
  assert.deepEqual(predicate.controller.approvalRun, {
    artifacts: [{
      digest: `sha256:${"6".repeat(64)}`,
      id: 7000,
      name: "oliphaunt-release-recovery-equivalence",
      size: 400,
    }],
    attempt: 1,
    id: 9000,
    workflow: ".github/workflows/release.yml",
  });
  assert.deepEqual(
    predicate.controller.qualificationRun.artifacts.map(({ id, name }) => ({
      id,
      name,
    })),
    [
      { id: 7001, name: "artifact-build-plan" },
      { id: 7002, name: "oliphaunt-release-candidate" },
    ],
  );
  assert.deepEqual(predicate.subjects, [
    { name: "alpha.zip", sha256: "a".repeat(64) },
    { name: "zeta.tar.gz", sha256: "b".repeat(64) },
  ]);
  assert.equal(
    predicate.sourceProvenance.recordDigest,
    sha256(canonicalRecoveryPromotionJson(values.provenanceRecord)),
  );
  const body = structuredClone(predicate);
  delete body.evidenceDigest;
  assert.equal(predicate.evidenceDigest, digestValue(body));
  assert.equal(
    recoveryPromotionSubjectChecksums(values.subjects),
    `${"a".repeat(64)}  alpha.zip\n${"b".repeat(64)}  zeta.tar.gz\n`,
  );
  assert.deepEqual(
    recoveryPromotionSubjectsFromLock(values.lock),
    predicate.subjects,
  );

  const shuffled = structuredClone(values);
  shuffled.subjects.reverse();
  shuffled.controller.qualificationRun.artifacts.reverse();
  assert.deepEqual(create(shuffled), predicate);
  assert.equal(
    prettyCanonicalRecoveryPromotionJson(predicate),
    `${JSON.stringify(predicate, null, 2)}\n`,
  );
});

test("validates the decoded custom in-toto statement against lock, controller, provenance, and approval", () => {
  const values = fixture();
  const predicate = create(values);
  assert.equal(
    validateRecoveryPromotionPredicate(predicate, values),
    predicate,
  );
  const statement = {
    _type: "https://in-toto.io/Statement/v1",
    subject: predicate.subjects.map(({ name, sha256: digest }) => ({
      digest: { sha256: digest },
      name,
    })),
    predicateType: RECOVERY_PROMOTION_PREDICATE_TYPE,
    predicate,
  };
  assert.deepEqual(validateRecoveryPromotionStatement(statement, values), {
    predicate,
    subjects: predicate.subjects,
  });
});

test("persists the exact approval run and custom bundle in the downstream recovery receipt", () => {
  const values = fixture();
  const predicate = create(values);
  const attestations = [{
    bundleSha256: "c".repeat(64),
    subjects: predicate.subjects,
  }];
  let nextReleaseId = 100;
  let nextAssetId = 1_000;
  const releases = values.lock.products.map((product) => ({
    assets: values.lock.productArtifacts
      .filter((artifact) =>
        artifact.product === product.id
        && ["github-release-asset", "github-release-metadata"].includes(
          artifact.role,
        ))
      .map((artifact) => ({
        assetId: String(nextAssetId++),
        name: artifact.name,
        sha256: artifact.sha256,
        size: artifact.size,
      })),
    draft: true,
    prerelease: false,
    product: product.id,
    releaseId: String(nextReleaseId++),
    releaseName: `${product.id} v${product.version}`,
    tag: `${product.id}-v${product.version}`,
    targetCommitish: values.lock.source.commit,
    version: product.version,
  }));
  const receipt = buildGithubAttestationReceipt({
    attestations,
    lock: values.lock,
    recoveryPromotionPredicate: predicate,
    releases,
    repo: "f0rr0/oliphaunt",
  });
  assert.equal(
    receipt.schema,
    "oliphaunt-github-release-attestation-receipt-v2",
  );
  assert.equal(receipt.recoveryPromotion.bundleSha256, "c".repeat(64));
  assert.equal(
    receipt.recoveryPromotion.predicateEvidenceDigest,
    predicate.evidenceDigest,
  );
  assert.deepEqual(
    receipt.recoveryPromotion.controller.approvalRun,
    predicate.controller.approvalRun,
  );
  assert.equal(
    validateGithubAttestationReceipt(
      receipt,
      values.lock,
      { repo: "f0rr0/oliphaunt" },
    ),
    receipt,
  );

  const substituted = structuredClone(receipt);
  substituted.recoveryPromotion.predicate.controller.approvalRun.artifacts[0].id += 1;
  assert.throws(
    () =>
      validateGithubAttestationReceipt(
        substituted,
        values.lock,
        { repo: "f0rr0/oliphaunt" },
      ),
    /receipt digest mismatch|evidenceDigest mismatch/u,
  );
});

test("binds the claimed promotion run to the live GitHub Release workflow context", () => {
  const { controller } = fixture();
  const env = {
    GITHUB_ACTIONS: "true",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_REF: "refs/heads/main",
    GITHUB_REPOSITORY: "f0rr0/oliphaunt",
    GITHUB_RUN_ATTEMPT: String(controller.promotionRun.attempt),
    GITHUB_RUN_ID: String(controller.promotionRun.id),
    GITHUB_SHA: controller.source.commit,
    GITHUB_WORKFLOW: "Release",
    GITHUB_WORKFLOW_REF:
      "f0rr0/oliphaunt/.github/workflows/release.yml@refs/heads/main",
    GITHUB_WORKFLOW_SHA: controller.source.commit,
  };
  assert.deepEqual(
    assertRecoveryPromotionGitHubContext(controller, env),
    create(fixture()).controller,
  );
  assert.deepEqual(
    assertRecoveryPromotionGitHubContext(controller, {}),
    create(fixture()).controller,
  );
  for (const [field, value] of [
    ["GITHUB_RUN_ID", "9003"],
    ["GITHUB_RUN_ATTEMPT", "3"],
    ["GITHUB_SHA", RELEASE_COMMIT],
    ["GITHUB_REF", "refs/tags/not-main"],
    ["GITHUB_WORKFLOW_REF", "f0rr0/oliphaunt/.github/workflows/ci.yml@main"],
  ]) {
    assert.throws(
      () =>
        assertRecoveryPromotionGitHubContext(
          controller,
          { ...env, [field]: value },
        ),
      /does not match/u,
    );
  }
});

test("rejects non-canonical, duplicate, malformed, or self-inconsistent predicate bytes", () => {
  const values = fixture();
  const predicate = create(values);

  const extra = structuredClone(predicate);
  extra.untrusted = true;
  assert.throws(
    () => validateRecoveryPromotionPredicate(extra, values),
    /must contain exactly/u,
  );

  const unsorted = structuredClone(predicate);
  unsorted.subjects.reverse();
  refreshPredicateDigest(unsorted);
  assert.throws(
    () => validateRecoveryPromotionPredicate(unsorted, values),
    /canonical name\/digest order/u,
  );

  const duplicate = structuredClone(predicate);
  duplicate.subjects[1] = structuredClone(duplicate.subjects[0]);
  refreshPredicateDigest(duplicate);
  assert.throws(
    () => validateRecoveryPromotionPredicate(duplicate, values),
    /repeat or ambiguously reuse/u,
  );

  const badName = structuredClone(values);
  badName.subjects[0].name = "../escape";
  assert.throws(
    () => create(badName),
    /direct artifact basename/u,
  );

  const badHash = structuredClone(values);
  badHash.subjects[0].sha256 = "A".repeat(64);
  assert.throws(
    () => create(badHash),
    /lowercase SHA-256/u,
  );

  const badDigest = structuredClone(predicate);
  badDigest.evidenceDigest = "f".repeat(64);
  assert.throws(
    () => validateRecoveryPromotionPredicate(badDigest, values),
    /evidenceDigest mismatch/u,
  );
});

test("rejects substitution in every independently pinned evidence plane", () => {
  const values = fixture();
  const predicate = create(values);

  const lockDrift = structuredClone(values);
  lockDrift.lock.catalogDigest = "f".repeat(64);
  assert.throws(
    () => validateRecoveryPromotionPredicate(predicate, lockDrift),
    /lockDigest mismatch/u,
  );

  const controllerDrift = structuredClone(values);
  controllerDrift.controller.qualificationRun.id += 10;
  assert.throws(
    () => validateRecoveryPromotionPredicate(predicate, controllerDrift),
    /does not match/u,
  );

  const artifactDrift = structuredClone(values);
  artifactDrift.controller.qualificationRun.artifacts[0].digest =
    `sha256:${"f".repeat(64)}`;
  assert.throws(
    () => validateRecoveryPromotionPredicate(predicate, artifactDrift),
    /does not match/u,
  );

  const approvalRunDrift = structuredClone(values);
  approvalRunDrift.controller.approvalRun.id += 10;
  assert.throws(
    () => validateRecoveryPromotionPredicate(predicate, approvalRunDrift),
    /does not match/u,
  );

  const approvalArtifactDrift = structuredClone(values);
  approvalArtifactDrift.controller.approvalRun.artifacts[0].digest =
    `sha256:${"d".repeat(64)}`;
  assert.throws(
    () => validateRecoveryPromotionPredicate(predicate, approvalArtifactDrift),
    /does not match/u,
  );

  const originalSourceRunDrift = structuredClone(values);
  originalSourceRunDrift.recoveryApproval.originalLockArtifact.runId += 1;
  const approvalWithoutDigest = structuredClone(
    originalSourceRunDrift.recoveryApproval,
  );
  delete approvalWithoutDigest.evidenceDigest;
  originalSourceRunDrift.recoveryApproval.evidenceDigest =
    digestValue(approvalWithoutDigest);
  assert.throws(
    () => create(originalSourceRunDrift),
    /does not match the pinned source-provenance dry run/u,
  );

  const missingSubject = structuredClone(values);
  missingSubject.subjects.pop();
  assert.throws(
    () => create(missingSubject),
    /subjects must exactly match/u,
  );

  const provenanceDrift = structuredClone(values);
  provenanceDrift.provenanceRecord.payloadQualification.run.id += 1;
  assert.throws(
    () => validateRecoveryPromotionPredicate(predicate, provenanceDrift),
    /does not match/u,
  );

  const approvalDrift = structuredClone(values);
  approvalDrift.recoveryApproval.evidenceDigest = "e".repeat(64);
  assert.throws(
    () => validateRecoveryPromotionPredicate(predicate, approvalDrift),
    /evidenceDigest mismatch/u,
  );
});

test("rejects a wrong predicate type or any statement/predicate subject skew", () => {
  const values = fixture();
  const predicate = create(values);
  const statement = {
    _type: "https://in-toto.io/Statement/v1",
    predicate,
    predicateType: RECOVERY_PROMOTION_PREDICATE_TYPE,
    subject: predicate.subjects.map(({ name, sha256: digest }) => ({
      digest: { sha256: digest },
      name,
    })),
  };

  const wrongType = structuredClone(statement);
  wrongType.predicateType = "https://slsa.dev/provenance/v1";
  assert.throws(
    () => validateRecoveryPromotionStatement(wrongType, values),
    /predicate type/u,
  );

  const wrongSubject = structuredClone(statement);
  wrongSubject.subject[0].digest.sha256 = "f".repeat(64);
  assert.throws(
    () => validateRecoveryPromotionStatement(wrongSubject, values),
    /subjects differ/u,
  );

  const unsorted = structuredClone(statement);
  unsorted.subject.reverse();
  assert.throws(
    () => validateRecoveryPromotionStatement(unsorted, values),
    /canonical name\/digest order/u,
  );
});

test("CLI creates immutable canonical predicate bytes and revalidates them", () => {
  const root = mkdtempSync(
    path.join(tmpdir(), "oliphaunt-recovery-promotion-"),
  );
  try {
    const values = fixture();
    const env = {
      ...process.env,
      GITHUB_ACTIONS: "true",
      GITHUB_EVENT_NAME: "workflow_dispatch",
      GITHUB_REF: "refs/heads/main",
      GITHUB_REPOSITORY: "f0rr0/oliphaunt",
      GITHUB_RUN_ATTEMPT: String(values.controller.promotionRun.attempt),
      GITHUB_RUN_ID: String(values.controller.promotionRun.id),
      GITHUB_SHA: values.controller.source.commit,
      GITHUB_WORKFLOW: "Release",
      GITHUB_WORKFLOW_REF:
        "f0rr0/oliphaunt/.github/workflows/release.yml@refs/heads/main",
      GITHUB_WORKFLOW_SHA: values.controller.source.commit,
    };
    const files = Object.fromEntries(
      ["lock", "controller", "provenanceRecord", "recoveryApproval", "subjects"]
        .map((name) => [name, path.join(root, `${name}.json`)]),
    );
    for (const [name, file] of Object.entries(files)) {
      writeFileSync(file, `${JSON.stringify(values[name], null, 2)}\n`);
    }
    const output = path.join(root, "predicate.json");
    const common = [
      "--lock",
      files.lock,
      "--controller",
      files.controller,
      "--provenance",
      files.provenanceRecord,
      "--approval",
      files.recoveryApproval,
      "--subjects",
      files.subjects,
    ];
    const created = execFileSync(
      process.execPath,
      [TOOL, "create", ...common, "--output", output],
      { encoding: "utf8", env },
    );
    assert.match(created, new RegExp(RECOVERY_PROMOTION_PREDICATE_TYPE, "u"));
    const predicate = JSON.parse(readFileSync(output, "utf8"));
    assert.equal(
      readFileSync(output, "utf8"),
      prettyCanonicalRecoveryPromotionJson(predicate),
    );
    const verified = execFileSync(
      process.execPath,
      [TOOL, "verify", ...common, "--predicate", output],
      { encoding: "utf8", env },
    );
    assert.match(verified, /verified https:/u);

    const prepared = {
      checksums: path.join(root, "prepared.checksums"),
      controller: path.join(root, "prepared-controller.json"),
      githubOutput: path.join(root, "github-output"),
      predicate: path.join(root, "prepared-predicate.json"),
      subjects: path.join(root, "prepared-subjects.json"),
    };
    const preparedResult = execFileSync(
      process.execPath,
      [
        TOOL,
        "prepare",
        "--lock",
        files.lock,
        "--provenance",
        files.provenanceRecord,
        "--approval",
        files.recoveryApproval,
        "--approval-run-id",
        String(values.controller.approvalRun.id),
        "--approval-run-attempt",
        String(values.controller.approvalRun.attempt),
        "--approval-artifacts-json",
        JSON.stringify(values.controller.approvalRun.artifacts),
        "--controller-sha",
        values.controller.source.commit,
        "--controller-tree",
        values.controller.source.tree,
        "--qualification-run-id",
        String(values.controller.qualificationRun.id),
        "--qualification-run-attempt",
        String(values.controller.qualificationRun.attempt),
        "--qualification-artifacts-json",
        JSON.stringify(values.controller.qualificationRun.artifacts),
        "--promotion-run-id",
        String(values.controller.promotionRun.id),
        "--promotion-run-attempt",
        String(values.controller.promotionRun.attempt),
        "--controller-output",
        prepared.controller,
        "--subjects-output",
        prepared.subjects,
        "--predicate-output",
        prepared.predicate,
        "--checksums-output",
        prepared.checksums,
        "--github-output",
        prepared.githubOutput,
      ],
      { encoding: "utf8", env },
    );
    assert.match(preparedResult, /prepared https:/u);
    assert.deepEqual(
      JSON.parse(readFileSync(prepared.controller, "utf8")),
      create(values).controller,
    );
    assert.deepEqual(
      JSON.parse(readFileSync(prepared.subjects, "utf8")),
      create(values).subjects,
    );
    assert.deepEqual(
      JSON.parse(readFileSync(prepared.predicate, "utf8")),
      create(values),
    );
    assert.equal(
      readFileSync(prepared.checksums, "utf8"),
      recoveryPromotionSubjectChecksums(values.subjects),
    );
    assert.match(
      readFileSync(prepared.githubOutput, "utf8"),
      new RegExp(`predicate_type=${RECOVERY_PROMOTION_PREDICATE_TYPE}`, "u"),
    );

    writeFileSync(output, `${JSON.stringify(predicate)}\n`);
    assert.throws(
      () =>
        execFileSync(
          process.execPath,
          [TOOL, "verify", ...common, "--predicate", output],
          { encoding: "utf8", env, stdio: "pipe" },
        ),
      /canonical sorted JSON/u,
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
