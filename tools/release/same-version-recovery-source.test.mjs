#!/usr/bin/env bun

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdirSync,
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
  LEGACY_SAME_VERSION_RECOVERY_SOURCES_SCHEMA,
  SAME_VERSION_RECOVERY_SOURCES_SCHEMA,
  appendSameVersionRecoverySourceGitHubOutput,
  canonicalRecoverySourceJson,
  loadSameVersionRecoverySources,
  sameVersionRecoverySourceProvenanceSchema,
  selectSameVersionRecoverySource,
  validateSameVersionRecoveryEvidence,
  validateSameVersionRecoverySource,
  validateSameVersionRecoverySources,
} from "./same-version-recovery-source.mjs";

const RELEASE_SHA = "9c398f4e5c05f494f9b752a8634e74e0bc11dd19";
const RELEASE_TREE = "396cf3b10adb1a5b625e66c5ebacf8c3d364b543";
const GITHUB_STAGED_RELEASE_SHA = "ae3d29ba16245e9345a8d337cd17c53f9bf2e853";
const TOOL = path.join(import.meta.dir, "same-version-recovery-source.mjs");

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function digestValue(value) {
  return sha256(canonicalRecoverySourceJson(value));
}

function document({ verifyGit = false } = {}) {
  return structuredClone(
    loadSameVersionRecoverySources(
      DEFAULT_SAME_VERSION_RECOVERY_SOURCES,
      { verifyGit },
    ),
  );
}

function record() {
  return document().records[0];
}

function setSource(value, source) {
  value.releaseSource = structuredClone(source);
  value.payloadQualification.run.headSha = source.commit;
  value.approvedDryRun.run.headSha = source.commit;
  value.bootstrapLedger.run.headSha = source.commit;
  value.approvedDryRun.capsuleManifest.source = structuredClone(source);
  value.bootstrapLedger.terminalCheckpoint.source = structuredClone(source);
}

function git(repo, ...args) {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
}

function writeJson(file, value) {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  writeFileSync(file, bytes);
  return bytes;
}

function catalogCarrier(carrier) {
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

function packageCarrier(carrier) {
  return {
    artifacts: carrier.artifacts.map(({ path: artifactPath, sha256: digest, size }) => ({
      path: artifactPath,
      sha256: digest,
      size,
    })),
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

function packageProductArtifact(artifact) {
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

function evidenceFixture({
  corruptCatalogDigest = false,
  corruptCheckpointDigest = false,
  corruptLockDigest = false,
  corruptPackageEnvelopeDigest = false,
} = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "oliphaunt-recovery-source-"));
  const repo = path.join(root, "repo");
  const evidence = path.join(root, "evidence");
  mkdirSync(repo);
  mkdirSync(evidence);
  git(repo, "init", "--quiet");
  git(repo, "config", "user.name", "Oliphaunt Test");
  git(repo, "config", "user.email", "test@oliphaunt.dev");
  writeFileSync(path.join(repo, "tracked.txt"), "fixture\n");
  git(repo, "add", "tracked.txt");
  git(repo, "commit", "--quiet", "-m", "test: fixture");
  const source = {
    commit: git(repo, "rev-parse", "HEAD"),
    tree: git(repo, "show", "-s", "--format=%T", "HEAD"),
  };
  const selected = record();
  setSource(selected, source);
  selected.releaseEnvelope.productCount = 1;
  selected.releaseEnvelope.carrierCount = 1;
  selected.releaseEnvelope.productArtifactCount = 1;
  selected.approvedDryRun.capsuleManifest.productCount = 1;
  selected.approvedDryRun.capsuleManifest.carrierCount = 1;
  selected.bootstrapLedger.terminalCheckpoint.productCount = 1;
  selected.bootstrapLedger.terminalCheckpoint.publicationCount = 1;
  selected.bootstrapLedger.terminalCheckpoint.receiptCount = 1;
  selected.bootstrapLedger.terminalCheckpoint.sequence = 7;
  selected.bootstrapLedger.terminalCheckpoint.previousCheckpointDigest =
    "c".repeat(64);

  const products = [{
    dependencies: [],
    id: "alpha",
    kind: "source-sdk",
    path: "alpha",
    publishTargets: [],
    version: "1.0.0",
  }];
  const carriers = [{
    artifacts: [{
      path: "target/release/alpha.crate",
      sha256: "d".repeat(64),
      size: 1,
    }],
    declared: true,
    dependencies: [],
    ecosystem: "cargo",
    id: "cargo:alpha",
    name: "alpha",
    packageDependencies: [],
    product: "alpha",
    publishOrder: 0,
    role: "root",
    target: null,
    version: "1.0.0",
  }];
  const productArtifacts = [{
    id: "github:alpha",
    identity: null,
    kind: "archive",
    name: "alpha.tar.gz",
    path: "target/release/alpha.tar.gz",
    product: "alpha",
    role: "release-asset",
    sha256: "e".repeat(64),
    size: 1,
    target: "portable",
  }];
  const computedCatalogDigest = digestValue({
    carriers: carriers.map(catalogCarrier),
    products,
    schema: "oliphaunt-publication-catalog-v1",
  });
  const computedPackageEnvelopeDigest = digestValue({
    carriers: carriers.map(packageCarrier),
    productArtifacts: productArtifacts.map(packageProductArtifact),
  });
  selected.releaseEnvelope.catalogDigest = corruptCatalogDigest
    ? "7".repeat(64)
    : computedCatalogDigest;
  selected.releaseEnvelope.packageEnvelopeDigest = corruptPackageEnvelopeDigest
    ? "8".repeat(64)
    : computedPackageEnvelopeDigest;
  selected.approvedDryRun.capsuleManifest.catalogDigest =
    selected.releaseEnvelope.catalogDigest;
  selected.approvedDryRun.capsuleManifest.packageEnvelopeDigest =
    selected.releaseEnvelope.packageEnvelopeDigest;
  selected.bootstrapLedger.terminalCheckpoint.catalogDigest =
    selected.releaseEnvelope.catalogDigest;
  selected.bootstrapLedger.terminalCheckpoint.packageEnvelopeDigest =
    selected.releaseEnvelope.packageEnvelopeDigest;

  const publicationLock = {
    schema: "oliphaunt-publication-lock-v1",
    catalogSchema: "oliphaunt-publication-catalog-v1",
    catalogDigest: selected.releaseEnvelope.catalogDigest,
    source,
    products,
    carriers,
    productArtifacts,
    packageEnvelopeDigest: selected.releaseEnvelope.packageEnvelopeDigest,
  };
  const computedLockDigest = digestValue(publicationLock);
  publicationLock.lockDigest = corruptLockDigest
    ? "f".repeat(64)
    : computedLockDigest;
  selected.releaseEnvelope.lockDigest = publicationLock.lockDigest;
  selected.approvedDryRun.capsuleManifest.lockDigest = publicationLock.lockDigest;
  selected.bootstrapLedger.terminalCheckpoint.lockDigest = publicationLock.lockDigest;

  const publicationLockFile = path.join(evidence, "publication-lock.json");
  const lockBytes = writeJson(publicationLockFile, publicationLock);
  const lockFileIdentity = {
    path: "target/release/publication-lock.json",
    sha256: sha256(lockBytes),
    size: lockBytes.length,
  };
  selected.releaseEnvelope.publicationLock = structuredClone(lockFileIdentity);
  selected.approvedDryRun.capsuleManifest.publicationLock =
    structuredClone(lockFileIdentity);

  const capsuleManifest = {
    schema: "oliphaunt-bootstrap-publication-capsule-v1",
    source,
    lockDigest: publicationLock.lockDigest,
    packageEnvelopeDigest: selected.releaseEnvelope.packageEnvelopeDigest,
    catalogDigest: selected.releaseEnvelope.catalogDigest,
    products: ["alpha"],
    publicationLock: structuredClone(lockFileIdentity),
    carriers: [{ id: "cargo:alpha" }],
  };
  const capsuleManifestFile = path.join(evidence, "bootstrap-capsule-manifest.json");
  const capsuleBytes = writeJson(capsuleManifestFile, capsuleManifest);
  selected.approvedDryRun.capsuleManifest.file = {
    path: "target/release/bootstrap-capsule-manifest.json",
    sha256: sha256(capsuleBytes),
    size: capsuleBytes.length,
  };

  const terminalLedger = {
    schema: "oliphaunt-bootstrap-ledger-checkpoint-v1",
    lockDigest: publicationLock.lockDigest,
    packageEnvelopeDigest: selected.releaseEnvelope.packageEnvelopeDigest,
    catalogDigest: selected.releaseEnvelope.catalogDigest,
    source,
    products: ["alpha"],
    publications: [{ id: "cargo:alpha" }],
    sequence: 7,
    previousCheckpointDigest: "c".repeat(64),
    receipts: [{ id: "cargo:alpha" }],
    complete: true,
  };
  const computedCheckpointDigest = digestValue(terminalLedger);
  terminalLedger.checkpointDigest = corruptCheckpointDigest
    ? "e".repeat(64)
    : computedCheckpointDigest;
  selected.bootstrapLedger.terminalCheckpoint.checkpointDigest =
    terminalLedger.checkpointDigest;
  const terminalName =
    `checkpoint-000007-${terminalLedger.checkpointDigest}.json`;
  const terminalLedgerFile = path.join(evidence, terminalName);
  const terminalBytes = writeJson(terminalLedgerFile, terminalLedger);
  selected.bootstrapLedger.terminalCheckpoint.file = {
    path: terminalName,
    sha256: sha256(terminalBytes),
    size: terminalBytes.length,
  };

  validateSameVersionRecoverySource(selected, { repo });
  return {
    capsuleManifest: capsuleManifestFile,
    cleanup: () => rmSync(root, { force: true, recursive: true }),
    publicationLock: publicationLockFile,
    record: selected,
    repo,
    root,
    terminalLedger: terminalLedgerFile,
  };
}

test("committed record selects the exact original release and complete frozen inventories", () => {
  const sources = loadSameVersionRecoverySources();
  const selected = selectSameVersionRecoverySource(sources, RELEASE_SHA);
  const githubStaged = selectSameVersionRecoverySource(
    sources,
    GITHUB_STAGED_RELEASE_SHA,
  );
  assert.equal(sources.schema, SAME_VERSION_RECOVERY_SOURCES_SCHEMA);
  assert.deepEqual(selected.releaseSource, {
    commit: RELEASE_SHA,
    tree: RELEASE_TREE,
  });
  assert.equal(selected.payloadQualification.run.id, 30358387218);
  assert.equal(selected.payloadQualification.artifactInventory.count, 73);
  assert.equal(
    selected.payloadQualification.artifactInventory.totalSize,
    1516373495,
  );
  assert.equal(selected.approvedDryRun.run.id, 30366650928);
  assert.deepEqual(
    selected.approvedDryRun.artifactInventory.artifacts.map(
      ({ id, name }) => ({ id, name }),
    ),
    [
      { id: 8692161467, name: "oliphaunt-bootstrap-capsule" },
      { id: 8692153698, name: "oliphaunt-publication-lock" },
    ],
  );
  assert.equal(selected.bootstrapLedger.run.id, 30548314727);
  assert.equal(Object.hasOwn(selected, "recoveryBoundary"), false);
  assert.equal(
    sameVersionRecoverySourceProvenanceSchema(selected),
    LEGACY_SAME_VERSION_RECOVERY_SOURCES_SCHEMA,
  );
  assert.equal(
    digestValue(selected),
    "65a998a7af8be6fb043223e95fc2cf50e92ce9659fe6b1e55533e6b0525f34b9",
  );
  assert.equal(
    selected.bootstrapLedger.artifactInventory.artifacts[0].id,
    8761717044,
  );
  assert.equal(
    selected.releaseEnvelope.lockDigest,
    "5ee675ab3066cca7df21dd425a5c80fd6c9b9c4b276757fc1aa84e2020761266",
  );
  assert.equal(
    sameVersionRecoverySourceProvenanceSchema(githubStaged),
    SAME_VERSION_RECOVERY_SOURCES_SCHEMA,
  );
  assert.equal(githubStaged.recoveryBoundary.kind, "github-staged");
  assert.equal(githubStaged.bootstrapLedger, null);
});

test("CLI and GITHUB_OUTPUT emit the same canonical selected record and exact metadata", () => {
  const root = mkdtempSync(path.join(tmpdir(), "oliphaunt-recovery-output-"));
  try {
    const output = path.join(root, "github-output");
    const selected = selectSameVersionRecoverySource(document(), RELEASE_SHA, {
      verifyGit: false,
    });
    const lines = appendSameVersionRecoverySourceGitHubOutput(output, selected);
    assert.equal(lines.release_sha, RELEASE_SHA);
    assert.equal(lines.release_tree, RELEASE_TREE);
    assert.equal(lines.payload_ci_run_id, "30358387218");
    assert.equal(lines.bootstrap_ledger_required, "true");
    assert.equal(lines.recovery_boundary_kind, "registry-partial");
    assert.equal(
      JSON.parse(lines.payload_ci_artifact_metadata_json).length,
      73,
    );
    assert.deepEqual(JSON.parse(lines.approved_lock_artifact_metadata_json), [{
      digest: "sha256:b5513012c3260112a484ff25a9d62fd0fb93087f2125448bbd20658a17cd81e5",
      id: 8692153698,
      name: "oliphaunt-publication-lock",
      size: 41287,
    }]);
    assert.equal(lines.record_json, canonicalRecoverySourceJson(selected));
    assert.equal(lines.record_digest, digestValue(selected));
    assert.match(readFileSync(output, "utf8"), /^record_json=\{/mu);

    const stdout = execFileSync(
      process.execPath,
      [TOOL, "--release-sha", RELEASE_SHA],
      { encoding: "utf8" },
    );
    assert.equal(stdout, `${canonicalRecoverySourceJson(selected)}\n`);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("GitHub-staged recovery boundaries bind one exact failed staging run", () => {
  const selected = record();
  selected.recoveryBoundary = {
    evidenceArtifact: {
      digest: `sha256:${"a".repeat(64)}`,
      id: 123,
      name: `github-staging-recovery-${RELEASE_SHA}-456-1`,
      size: 789,
    },
    job: {
      conclusion: "failure",
      id: 321,
      name: "Prepare and stage release",
    },
    kind: "github-staged",
    run: {
      attempt: 1,
      conclusion: "failure",
      event: "workflow_dispatch",
      headSha: RELEASE_SHA,
      id: 456,
      status: "completed",
    },
  };
  assert.equal(
    validateSameVersionRecoverySource(selected, { verifyGit: false }),
    selected,
  );
  selected.recoveryBoundary.run.headSha = "f".repeat(40);
  assert.throws(
    () => validateSameVersionRecoverySource(selected, { verifyGit: false }),
    /source-bound workflow_dispatch/u,
  );
});

test("a post-bootstrap release may explicitly bind no bootstrap ledger", () => {
  const selected = record();
  selected.recoveryBoundary = { kind: "registry-partial" };
  selected.bootstrapLedger = null;
  assert.equal(
    validateSameVersionRecoverySource(selected, { verifyGit: false }),
    selected,
  );

  const root = mkdtempSync(path.join(tmpdir(), "oliphaunt-recovery-no-ledger-"));
  try {
    const lines = appendSameVersionRecoverySourceGitHubOutput(
      path.join(root, "github-output"),
      selected,
    );
    assert.equal(lines.bootstrap_ledger_required, "false");
    assert.equal(lines.bootstrap_ledger_run_id, "");
    assert.deepEqual(JSON.parse(lines.bootstrap_ledger_artifact_metadata_json), []);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("strict document and inventory mutations fail closed", () => {
  const cases = [
    {
      mutate: (value) => {
        value.future = true;
      },
      pattern: /must contain exactly records, schema/u,
    },
    {
      mutate: (value) => {
        value.records[0].payloadQualification.artifactInventory.artifacts[1].id =
          value.records[0].payloadQualification.artifactInventory.artifacts[0].id;
      },
      pattern: /repeats artifact id/u,
    },
    {
      mutate: (value) => {
        value.records[0].payloadQualification.artifactInventory.artifacts[0].digest =
          `sha256:${"f".repeat(64)}`;
      },
      pattern: /inventoryDigest mismatch/u,
    },
    {
      mutate: (value) => {
        value.records[0].payloadQualification.artifactInventory.totalSize += 1;
      },
      pattern: /totalSize does not match/u,
    },
    {
      mutate: (value) => {
        value.records[0].payloadQualification.requiredArtifactNames[0] =
          "absent-artifact";
      },
      pattern: /names missing from the complete inventory/u,
    },
    {
      mutate: (value) => {
        value.records[0].approvedDryRun.capsuleManifest.lockDigest =
          "f".repeat(64);
      },
      pattern: /does not match the approved publication lock/u,
    },
    {
      mutate: (value) => {
        value.records.splice(1, 0, structuredClone(value.records[0]));
      },
      pattern: /duplicate recovery source commit/u,
    },
  ];
  for (const { mutate, pattern } of cases) {
    const value = document();
    mutate(value);
    assert.throws(
      () => validateSameVersionRecoverySources(value, { verifyGit: false }),
      pattern,
    );
  }
});

test("source identity is resolved as an exact git commit/tree, not trusted from JSON", () => {
  const value = document();
  const mutatedSource = {
    commit: RELEASE_SHA,
    tree: "f".repeat(40),
  };
  setSource(value.records[0], mutatedSource);
  assert.throws(
    () => validateSameVersionRecoverySources(value),
    /committed recovery record source .* does not match/u,
  );
  assert.throws(
    () => selectSameVersionRecoverySource(document(), "F".repeat(40), {
      verifyGit: false,
    }),
    /lowercase full commit SHA/u,
  );
  assert.throws(
    () => selectSameVersionRecoverySource(document(), "0".repeat(40), {
      verifyGit: false,
    }),
    /found 0/u,
  );
});

test("record file must remain canonical JSON", () => {
  const root = mkdtempSync(path.join(tmpdir(), "oliphaunt-recovery-json-"));
  try {
    const file = path.join(root, "sources.json");
    writeFileSync(
      file,
      `${readFileSync(DEFAULT_SAME_VERSION_RECOVERY_SOURCES, "utf8")}\n`,
    );
    assert.throws(
      () => loadSameVersionRecoverySources(file, { verifyGit: false }),
      /canonical sorted JSON/u,
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("downloaded lock, capsule manifest, and terminal ledger verify as one envelope", () => {
  const fixture = evidenceFixture();
  try {
    assert.deepEqual(
      validateSameVersionRecoveryEvidence(fixture.record, fixture),
      {
        capsuleManifestSha256:
          fixture.record.approvedDryRun.capsuleManifest.file.sha256,
        publicationLockSha256:
          fixture.record.releaseEnvelope.publicationLock.sha256,
        terminalLedgerSha256:
          fixture.record.bootstrapLedger.terminalCheckpoint.file.sha256,
      },
    );
  } finally {
    fixture.cleanup();
  }
});

test("no-bootstrap recovery verifies the lock and capsule without invented ledger evidence", () => {
  const fixture = evidenceFixture();
  try {
    fixture.record.recoveryBoundary = { kind: "registry-partial" };
    fixture.record.bootstrapLedger = null;
    assert.deepEqual(
      validateSameVersionRecoveryEvidence(fixture.record, {
        capsuleManifest: fixture.capsuleManifest,
        publicationLock: fixture.publicationLock,
      }),
      {
        capsuleManifestSha256:
          fixture.record.approvedDryRun.capsuleManifest.file.sha256,
        publicationLockSha256:
          fixture.record.releaseEnvelope.publicationLock.sha256,
        terminalLedgerSha256: null,
      },
    );
    assert.throws(
      () => validateSameVersionRecoveryEvidence(fixture.record, fixture),
      /must not supply terminal ledger evidence/u,
    );
  } finally {
    fixture.cleanup();
  }
});

test("raw evidence substitution and internally forged digests fail closed", () => {
  {
    const fixture = evidenceFixture();
    try {
      writeFileSync(
        fixture.publicationLock,
        Buffer.concat([readFileSync(fixture.publicationLock), Buffer.from(" ")]),
      );
      assert.throws(
        () => validateSameVersionRecoveryEvidence(fixture.record, fixture),
        /bytes do not match the recorded/u,
      );
    } finally {
      fixture.cleanup();
    }
  }
  {
    const fixture = evidenceFixture({ corruptLockDigest: true });
    try {
      assert.throws(
        () => validateSameVersionRecoveryEvidence(fixture.record, fixture),
        /invalid internal lockDigest/u,
      );
    } finally {
      fixture.cleanup();
    }
  }
  {
    const fixture = evidenceFixture({ corruptCatalogDigest: true });
    try {
      assert.throws(
        () => validateSameVersionRecoveryEvidence(fixture.record, fixture),
        /invalid internal catalogDigest/u,
      );
    } finally {
      fixture.cleanup();
    }
  }
  {
    const fixture = evidenceFixture({ corruptPackageEnvelopeDigest: true });
    try {
      assert.throws(
        () => validateSameVersionRecoveryEvidence(fixture.record, fixture),
        /invalid internal packageEnvelopeDigest/u,
      );
    } finally {
      fixture.cleanup();
    }
  }
  {
    const fixture = evidenceFixture({ corruptCheckpointDigest: true });
    try {
      assert.throws(
        () => validateSameVersionRecoveryEvidence(fixture.record, fixture),
        /invalid internal checkpointDigest/u,
      );
    } finally {
      fixture.cleanup();
    }
  }
});
