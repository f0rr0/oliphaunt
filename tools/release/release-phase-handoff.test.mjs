#!/usr/bin/env bun

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { normalPublicationPlan } from "./normal-publication-plan.mjs";
import { openNormalPublicationCheckpoint } from "./normal-publication-checkpoint.mjs";
import { loadPublicationCatalog } from "./publication-catalog.mjs";
import {
  buildPublicationCandidate,
  freezePublicationCandidate,
} from "./publication-lock.mjs";
import {
  auditReleasePhaseTransfer,
  installReleasePhaseHandoff,
  REGISTRY_INPUT_TRANSFER_ALLOWANCE_SECONDS,
  RELEASE_PHASE_HANDOFF_MANIFEST,
  sealReleasePhaseHandoff,
} from "./release-phase-handoff.mjs";
import {
  verifyLockedCarrierIntegrity,
  writeRegistryReceiptEvidence,
} from "./registry-integrity.mjs";
import { buildGithubAttestationReceipt } from "./verify_github_release_attestations.mjs";

const ROOT = path.resolve(import.meta.dir, "../..");
const REPOSITORY = "f0rr0/oliphaunt";
const APPROVED_RUN_ID = 123456;

function hash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function approvedArtifacts() {
  return [
    { digest: `sha256:${"1".repeat(64)}`, id: 101, name: "oliphaunt-publication-lock", size: 4096 },
    { digest: `sha256:${"2".repeat(64)}`, id: 102, name: "oliphaunt-bootstrap-capsule", size: 16 * 1024 * 1024 },
  ];
}

function tarGzip(output, cwd, member) {
  const result = spawnSync("tar", ["-czf", output, "-C", cwd, member], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

function cargoFixture(stageRoot, artifacts, name, version) {
  const directoryName = `${name}-${version}`;
  const stage = path.join(stageRoot, directoryName);
  mkdirSync(path.join(stage, "src"), { recursive: true });
  writeFileSync(
    path.join(stage, "Cargo.toml"),
    `[package]\nname = ${JSON.stringify(name)}\nversion = ${JSON.stringify(version)}\nedition = "2024"\n`,
  );
  writeFileSync(path.join(stage, "src/lib.rs"), "pub const HANDOFF_FIXTURE: bool = true;\n");
  const output = path.join(artifacts, `${directoryName}.crate`);
  tarGzip(output, stageRoot, directoryName);
}

function npmFixture(stageRoot, artifacts, name, version) {
  const stage = path.join(stageRoot, "npm", "package");
  mkdirSync(stage, { recursive: true });
  writeFileSync(path.join(stage, "index.js"), "export const handoffFixture = true;\n");
  writeFileSync(path.join(stage, "package.json"), `${JSON.stringify({
    name,
    version,
    type: "module",
    repository: { type: "git", url: "git+https://github.com/f0rr0/oliphaunt.git" },
    publishConfig: { access: "public", provenance: true },
  }, null, 2)}\n`);
  tarGzip(path.join(artifacts, "oliphaunt-ts.tgz"), path.dirname(stage), "package");
}

function jsrFixture(artifacts, name, version) {
  const directory = path.join(artifacts, "jsr-source");
  mkdirSync(path.join(directory, "src"), { recursive: true });
  writeFileSync(path.join(directory, "jsr.json"), `${JSON.stringify({
    name,
    version,
    exports: "./src/mod.ts",
    publish: { include: ["jsr.json", "src/mod.ts"] },
  }, null, 2)}\n`);
  writeFileSync(path.join(directory, "src/mod.ts"), "export const handoffFixture = true;\n");
}

function copyWorkspaceArtifact(source, workspace, relative) {
  const destination = path.join(workspace, relative);
  mkdirSync(path.dirname(destination), { recursive: true });
  copyFileSync(source, destination);
}

function releaseSnapshot(lock) {
  return lock.products.map((product, index) => ({
    assets: [],
    draft: true,
    prerelease: product.version.includes("-"),
    product: product.id,
    releaseId: index + 1,
    releaseName: `${product.id} v${product.version}`,
    tag: `${product.id}-v${product.version}`,
    targetCommitish: lock.source.commit,
    version: product.version,
  }));
}

function writeControls(workspace, lock, products) {
  const release = path.join(workspace, "target/release");
  mkdirSync(release, { recursive: true });
  writeFileSync(path.join(release, "publication-lock.json"), `${JSON.stringify(lock, null, 2)}\n`);
  const plan = normalPublicationPlan(lock, products);
  writeFileSync(path.join(release, "normal-publication-plan.json"), `${JSON.stringify(plan, null, 2)}\n`);
  const receipt = buildGithubAttestationReceipt({
    attestations: [],
    lock,
    releases: releaseSnapshot(lock),
    repo: REPOSITORY,
  });
  writeFileSync(path.join(release, "github-release-attestation-receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);
  return { plan, release };
}

function runnerEvidence(root) {
  const runner = path.join(root, "runner");
  mkdirSync(runner, { recursive: true });
  for (const name of [
    "oliphaunt-github-content-write-pacer.json",
    "oliphaunt-github-core-request-journal.json",
    "oliphaunt-github-release-asset-upload-report.json",
  ]) {
    writeFileSync(path.join(runner, name), `${JSON.stringify({ fixture: name })}\n`);
  }
  return runner;
}

function fixture(t, products) {
  mkdirSync(path.join(ROOT, "target"), { recursive: true });
  const original = mkdtempSync(path.join(ROOT, "target", "release-phase-handoff-fixture-"));
  const source = mkdtempSync(path.join(os.tmpdir(), "oliphaunt-release-phase-source-"));
  const root = mkdtempSync(path.join(os.tmpdir(), "oliphaunt-release-phase-test-"));
  t.after(() => {
    rmSync(original, { recursive: true, force: true });
    rmSync(source, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });
  const stage = path.join(original, "stage");
  const artifacts = path.join(original, "artifacts");
  mkdirSync(stage, { recursive: true });
  mkdirSync(artifacts, { recursive: true });
  const catalog = loadPublicationCatalog("release-phase-handoff.test", { products });
  for (const carrier of catalog.carriers) {
    const product = catalog.products.find(({ id }) => id === carrier.product);
    if (carrier.ecosystem === "cargo") cargoFixture(stage, artifacts, carrier.name, product.version);
    else if (carrier.ecosystem === "npm") npmFixture(stage, artifacts, carrier.name, product.version);
    else if (carrier.ecosystem === "jsr") jsrFixture(artifacts, carrier.name, product.version);
    else throw new Error(`fixture does not support ${carrier.ecosystem}`);
  }
  const lock = freezePublicationCandidate(buildPublicationCandidate({
    products,
    artifactRoots: [artifacts],
    headRef: "HEAD",
  }));
  for (const artifact of [
    ...lock.carriers.flatMap(({ artifacts: rows }) => rows),
    ...lock.productArtifacts,
  ]) {
    const from = path.join(ROOT, artifact.path);
    const stat = statSync(from);
    if (stat.isFile()) copyWorkspaceArtifact(from, source, artifact.path);
    else {
      for (const file of ["jsr.json", "src/mod.ts"]) {
        const child = path.join(from, file);
        if (statSync(child, { throwIfNoEntry: false })?.isFile()) {
          copyWorkspaceArtifact(child, source, `${artifact.path}/${file}`);
        }
      }
    }
  }
  const controls = writeControls(source, lock, products);
  return {
    ...controls,
    approved: approvedArtifacts(),
    lock,
    original,
    products,
    root,
    runner: runnerEvidence(root),
    source,
  };
}

function seal(f, phase) {
  const output = path.join(f.root, `${phase}-handoff`);
  const manifest = sealReleasePhaseHandoff({
    approvedArtifacts: f.approved,
    approvedRunId: APPROVED_RUN_ID,
    headRef: "HEAD",
    output,
    phase,
    products: f.products,
    repository: REPOSITORY,
    runnerRoot: f.runner,
    workspaceRoot: f.source,
  });
  return { manifest, output };
}

test("audits exact non-capsule payload topology against cold-transfer ceilings before mutation", (t) => {
  const f = fixture(t, ["oliphaunt-rust", "oliphaunt-js"]);
  const report = auditReleasePhaseTransfer({
    approvedArtifacts: f.approved,
    approvedRunId: APPROVED_RUN_ID,
    products: f.products,
    workspaceRoot: f.source,
  });
  assert.ok(report.payloadArtifactCount >= 1, "JSR source must cross the small stage handoff");
  assert.ok(report.payloadFileCount >= 2);
  assert.ok(report.projectedRegistryInputBytes > report.approvedCapsuleBytes);
  assert.ok(report.worstCaseRegistryInputTransferSeconds < REGISTRY_INPUT_TRANSFER_ALLOWANCE_SECONDS);
});

test("installs a manifest-exact GitHub-stage handoff beside the approved Cargo/npm capsule", (t) => {
  const f = fixture(t, ["oliphaunt-rust", "oliphaunt-js"]);
  const { manifest, output } = seal(f, "github-staged");
  assert.ok(manifest.registryArtifacts.some(({ type }) => type === "directory"));
  const destination = path.join(f.root, "installed-stage");
  const destinationRunner = path.join(f.root, "installed-stage-runner");
  mkdirSync(destination, { recursive: true });
  mkdirSync(destinationRunner, { recursive: true });
  // Simulate the separately verified bootstrap capsule: embedded lock plus all
  // Cargo/npm carriers are already installed before the small handoff merges.
  copyWorkspaceArtifact(
    path.join(f.source, "target/release/publication-lock.json"),
    destination,
    "target/release/publication-lock.json",
  );
  for (const carrier of f.lock.carriers.filter(({ ecosystem }) => new Set(["cargo", "npm"]).has(ecosystem))) {
    for (const artifact of carrier.artifacts) {
      copyWorkspaceArtifact(path.join(f.source, artifact.path), destination, artifact.path);
    }
  }
  installReleasePhaseHandoff({
    approvedArtifacts: f.approved,
    approvedRunId: APPROVED_RUN_ID,
    headRef: "HEAD",
    input: output,
    mergeExistingTarget: true,
    phase: "github-staged",
    products: f.products,
    repository: REPOSITORY,
    runnerRoot: destinationRunner,
    workspaceRoot: destination,
  });
  assert.equal(
    readFileSync(path.join(destination, "target/release/publication-lock.json"), "utf8"),
    readFileSync(path.join(f.source, "target/release/publication-lock.json"), "utf8"),
  );
  const jsr = f.lock.carriers.find(({ ecosystem }) => ecosystem === "jsr").artifacts[0].path;
  assert.ok(statSync(path.join(destination, jsr, "jsr.json")).isFile());
  assert.ok(statSync(path.join(destinationRunner, "oliphaunt-github-core-request-journal.json")).isFile());
});

test("rejects handoff byte drift before creating any durable workspace target", (t) => {
  const f = fixture(t, ["oliphaunt-rust", "oliphaunt-js"]);
  const { manifest, output } = seal(f, "github-staged");
  const payload = manifest.files.find(({ destination, path: file }) =>
    destination === "workspace" && file.endsWith("src/mod.ts"));
  assert.ok(payload);
  writeFileSync(path.join(output, "workspace", payload.path), "tampered\n");
  const destination = path.join(f.root, "tampered-destination");
  const destinationRunner = path.join(f.root, "tampered-runner");
  mkdirSync(destination, { recursive: true });
  mkdirSync(destinationRunner, { recursive: true });
  assert.throws(
    () => installReleasePhaseHandoff({
      approvedArtifacts: f.approved,
      approvedRunId: APPROVED_RUN_ID,
      input: output,
      phase: "github-staged",
      products: f.products,
      repository: REPOSITORY,
      runnerRoot: destinationRunner,
      workspaceRoot: destination,
    }),
    /handoff file bytes changed/u,
  );
  assert.equal(statSync(path.join(destination, "target"), { throwIfNoEntry: false }), undefined);
});

test("rejects unexpected transport files and approved-run identity drift", (t) => {
  const f = fixture(t, ["oliphaunt-rust", "oliphaunt-js"]);
  const { output } = seal(f, "github-staged");
  writeFileSync(path.join(output, "unexpected.txt"), "not in manifest\n");
  const destination = path.join(f.root, "unexpected-destination");
  const destinationRunner = path.join(f.root, "unexpected-runner");
  mkdirSync(destination, { recursive: true });
  mkdirSync(destinationRunner, { recursive: true });
  assert.throws(
    () => installReleasePhaseHandoff({
      approvedArtifacts: f.approved,
      approvedRunId: APPROVED_RUN_ID,
      input: output,
      phase: "github-staged",
      products: f.products,
      repository: REPOSITORY,
      runnerRoot: destinationRunner,
      workspaceRoot: destination,
    }),
    /missing or unmanifested files/u,
  );
  rmSync(path.join(output, "unexpected.txt"));
  assert.throws(
    () => installReleasePhaseHandoff({
      approvedArtifacts: f.approved.map((row) => row.name === "oliphaunt-publication-lock"
        ? { ...row, id: row.id + 1000 }
        : row),
      approvedRunId: APPROVED_RUN_ID,
      input: output,
      phase: "github-staged",
      products: f.products,
      repository: REPOSITORY,
      runnerRoot: destinationRunner,
      workspaceRoot: destination,
    }),
    /approved dry-run identity disagrees/u,
  );
  assert.equal(statSync(path.join(destination, "target"), { throwIfNoEntry: false }), undefined);
});

test("requires permission-sensitive payloads to be pre-archived", (t) => {
  const f = fixture(t, ["oliphaunt-rust"]);
  const runnerFile = path.join(f.runner, "oliphaunt-github-core-request-journal.json");
  chmodSync(runnerFile, 0o755);
  assert.throws(() => seal(f, "github-staged"), /is executable; pre-archive permission-sensitive payloads/u);
});

test("registry handoff requires a complete checkpoint and immutable receipt envelope", async (t) => {
  const f = fixture(t, ["oliphaunt-rust"]);
  const receiptById = new Map();
  for (const carrier of f.lock.carriers) {
    const [artifact] = carrier.artifacts;
    const receipt = await verifyLockedCarrierIntegrity(f.lock, carrier.id, {
      fetchImpl: async () => Response.json({ version: { checksum: artifact.sha256 } }),
    });
    receiptById.set(carrier.id, receipt);
  }
  const checkpointFile = path.join(f.release, "normal-publication-checkpoint.json");
  const checkpoint = openNormalPublicationCheckpoint({
    file: checkpointFile,
    lock: f.lock,
    plan: f.plan,
    products: f.products,
  });
  for (const operation of f.plan.operations) {
    checkpoint.recordOperation(operation, receiptById.get(operation.carrierId));
  }
  writeRegistryReceiptEvidence(
    path.join(f.release, "registry-integrity-receipts.json"),
    f.lock,
    {
      ecosystems: ["cargo", "npm", "maven", "jsr"],
      products: f.products,
      receipts: [...receiptById.values()],
    },
  );
  const { manifest, output } = seal(f, "registry-published");
  assert.deepEqual(manifest.registryArtifacts, []);
  assert.equal(manifest.files.some(({ path: file }) => file.endsWith("registry-integrity-receipts.json")), true);
  assert.ok(statSync(path.join(output, RELEASE_PHASE_HANDOFF_MANIFEST)).isFile());

  const destination = path.join(f.root, "installed-registry");
  const destinationRunner = path.join(f.root, "installed-registry-runner");
  mkdirSync(destination, { recursive: true });
  mkdirSync(destinationRunner, { recursive: true });
  installReleasePhaseHandoff({
    approvedArtifacts: f.approved,
    approvedRunId: APPROVED_RUN_ID,
    input: output,
    phase: "registry-published",
    products: f.products,
    repository: REPOSITORY,
    runnerRoot: destinationRunner,
    workspaceRoot: destination,
  });
  assert.equal(
    hash(readFileSync(path.join(destination, "target/release/registry-integrity-receipts.json"))),
    hash(readFileSync(path.join(f.release, "registry-integrity-receipts.json"))),
  );
});
