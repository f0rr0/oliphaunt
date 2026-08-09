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
  EXPECTED_RECOVERY_ARCHIVE_MEMBERS,
  EXPECTED_RELEASE_JOB_OUTCOMES,
  EXPECTED_STAGING_STEP_OUTCOMES,
  extractBoundaryPublicationLock,
  validateGithubStagedRecoveryBoundary,
  verifyGithubStagedRecoveryBoundary,
} from "./verify-github-staged-recovery-boundary.mjs";

const REPO = "f0rr0/oliphaunt";
const RELEASE_SHA = "ae3d29ba16245e9345a8d337cd17c53f9bf2e853";
const RELEASE_TREE = "673e8f249d2f51d10997f0036a7e471bf35a388e";
const RUN_ID = 31281649203;
const JOB_ID = 93163883359;
const ARTIFACT_ID = 9029551798;
const ARCHIVE_BYTES = Buffer.from("exact pinned recovery artifact fixture");
const APPROVED_LOCK_BYTES = Buffer.from("exact approved publication lock fixture\n");

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function boundaryDocument() {
  return {
    evidenceArtifact: {
      digest: `sha256:${sha256(ARCHIVE_BYTES)}`,
      id: ARTIFACT_ID,
      name: `github-staging-recovery-${RELEASE_SHA}-${RUN_ID}-1`,
      size: ARCHIVE_BYTES.length,
    },
    job: {
      conclusion: "failure",
      id: JOB_ID,
      name: "Prepare and stage release",
    },
    kind: "github-staged",
    run: {
      attempt: 1,
      conclusion: "failure",
      event: "workflow_dispatch",
      headSha: RELEASE_SHA,
      id: RUN_ID,
      status: "completed",
    },
  };
}

function liveRun() {
  return {
    conclusion: "failure",
    display_title: "Release / publish / main",
    event: "workflow_dispatch",
    head_branch: "main",
    head_commit: { id: RELEASE_SHA },
    head_repository: { full_name: REPO },
    head_sha: RELEASE_SHA,
    id: RUN_ID,
    name: "Release / publish / main",
    path: ".github/workflows/release.yml",
    repository: { full_name: REPO },
    run_attempt: 1,
    status: "completed",
  };
}

function stagingSteps() {
  const rows = [
    { conclusion: "success", name: "Set up job", number: 1 },
    ...[...EXPECTED_STAGING_STEP_OUTCOMES].map(([name, expected]) => ({
      conclusion: expected.conclusion,
      name,
      number: expected.number,
    })),
    { conclusion: "success", name: "Complete job", number: 207 },
  ].sort((left, right) => left.number - right.number);
  return rows.map((row) => ({ ...row, status: "completed" }));
}

function liveJobs() {
  let nextId = JOB_ID + 1;
  return [...EXPECTED_RELEASE_JOB_OUTCOMES].map(([name, conclusion]) => {
    const staging = name === "Prepare and stage release";
    return {
      conclusion,
      head_sha: RELEASE_SHA,
      id: staging ? JOB_ID : nextId++,
      labels: staging ? ["macos-26"] : [],
      name,
      run_attempt: 1,
      run_id: RUN_ID,
      status: "completed",
      steps: staging ? stagingSteps() : [],
      workflow_name: "Release / publish / main",
    };
  });
}

function liveArtifact() {
  const boundary = boundaryDocument();
  return {
    archive_download_url: `https://api.github.com/repos/${REPO}/actions/artifacts/${ARTIFACT_ID}/zip`,
    digest: boundary.evidenceArtifact.digest,
    expired: false,
    id: ARTIFACT_ID,
    name: boundary.evidenceArtifact.name,
    size_in_bytes: ARCHIVE_BYTES.length,
    url: `https://api.github.com/repos/${REPO}/actions/artifacts/${ARTIFACT_ID}`,
    workflow_run: {
      head_branch: "main",
      head_sha: RELEASE_SHA,
      id: RUN_ID,
    },
  };
}

function fixture() {
  const state = {
    artifact: liveArtifact(),
    archive: Buffer.from(ARCHIVE_BYTES),
    jobs: liveJobs(),
    recoveredLock: Buffer.from(APPROVED_LOCK_BYTES),
    run: liveRun(),
  };
  const dependencies = {
    extractPublicationLock: () => state.recoveredLock,
    github: {
      downloadArtifact: () => state.archive,
      getArtifact: () => state.artifact,
      getJobs: () => state.jobs,
      getRun: () => state.run,
    },
    validateApprovedLock: () => ({
      lockDigest: "a".repeat(64),
      schema: "oliphaunt-publication-lock-v1",
      source: { commit: RELEASE_SHA, tree: RELEASE_TREE },
    }),
  };
  return { dependencies, state };
}

function verify(document = boundaryDocument(), mutate = () => {}) {
  const { dependencies, state } = fixture();
  mutate(state, dependencies);
  return verifyGithubStagedRecoveryBoundary({
    approvedLockBytes: APPROVED_LOCK_BYTES,
    boundaryDocument: document,
    repo: REPO,
  }, dependencies);
}

test("accepts only the exact pinned failed GitHub-stage boundary", () => {
  const result = verify();
  assert.deepEqual(result, {
    artifactDigest: `sha256:${sha256(ARCHIVE_BYTES)}`,
    artifactId: ARTIFACT_ID,
    failedStep: "Freeze exact GitHub release asset and attestation evidence",
    jobId: JOB_ID,
    lockDigest: "a".repeat(64),
    releaseSource: RELEASE_SHA,
    runAttempt: 1,
    runId: RUN_ID,
  });
});

test("binds a full selected recovery record to its release source", () => {
  const document = {
    recoveryBoundary: boundaryDocument(),
    releaseSource: { commit: RELEASE_SHA, tree: RELEASE_TREE },
  };
  assert.equal(validateGithubStagedRecoveryBoundary(document).releaseSource.tree, RELEASE_TREE);
  verify(document);

  document.releaseSource.commit = "b".repeat(40);
  assert.throws(
    () => validateGithubStagedRecoveryBoundary(document),
    /releaseSource[.]commit/u,
  );
});

test("rejects unpinned boundary shapes and non-GitHub-stage kinds", () => {
  const extra = boundaryDocument();
  extra.unchecked = true;
  assert.throws(
    () => validateGithubStagedRecoveryBoundary(extra),
    /keys must be exactly/u,
  );

  const wrongKind = boundaryDocument();
  wrongKind.kind = "registry-partial";
  assert.throws(
    () => validateGithubStagedRecoveryBoundary(wrongKind),
    /recoveryBoundary[.]kind/u,
  );
});

test("rejects live run identity, attempt, event, status, and failure drift", () => {
  for (const [field, value, pattern] of [
    ["head_sha", "b".repeat(40), /head SHA/u],
    ["run_attempt", 2, /run attempt/u],
    ["event", "push", /run event/u],
    ["status", "in_progress", /run status/u],
    ["conclusion", "success", /run conclusion/u],
  ]) {
    assert.throws(
      () => verify(boundaryDocument(), (state) => { state.run[field] = value; }),
      pattern,
    );
  }
});

test("rejects any failed-step or critical staging-outcome drift", () => {
  assert.throws(
    () => verify(boundaryDocument(), (state) => {
      const step = state.jobs
        .find(({ name }) => name === "Prepare and stage release")
        .steps.find(({ name }) => name === "Attest WASIX release assets");
      step.conclusion = "skipped";
    }),
    /Attest WASIX release assets conclusion/u,
  );
  assert.throws(
    () => verify(boundaryDocument(), (state) => {
      const step = state.jobs
        .find(({ name }) => name === "Prepare and stage release")
        .steps.find(({ name }) => name === "Freeze exact GitHub release asset and attestation evidence");
      step.conclusion = "success";
    }),
    /Freeze exact GitHub release asset and attestation evidence conclusion/u,
  );
});

test("requires registry, continuation, and finalization jobs to remain skipped", () => {
  for (const jobName of [
    "Dispatch verified registry continuation",
    "Publish exact registry topology",
    "Verify consumers and publish GitHub releases",
  ]) {
    assert.throws(
      () => verify(boundaryDocument(), (state) => {
        state.jobs.find(({ name }) => name === jobName).conclusion = "success";
      }),
      new RegExp(`${jobName} conclusion`, "u"),
    );
  }
});

test("rejects artifact metadata, workflow binding, expiry, and downloaded-byte drift", () => {
  assert.throws(
    () => verify(boundaryDocument(), (state) => { state.artifact.expired = true; }),
    /expired state/u,
  );
  assert.throws(
    () => verify(boundaryDocument(), (state) => { state.artifact.workflow_run.id += 1; }),
    /workflow run id/u,
  );
  assert.throws(
    () => verify(boundaryDocument(), (state) => { state.artifact.digest = `sha256:${"b".repeat(64)}`; }),
    /artifact digest/u,
  );
  assert.throws(
    () => verify(boundaryDocument(), (state) => { state.archive = Buffer.from("different archive bytes"); }),
    /downloaded recovery artifact size/u,
  );
  assert.throws(
    () => verify(boundaryDocument(), (state) => {
      state.archive = Buffer.from(ARCHIVE_BYTES);
      state.archive[0] ^= 0xff;
    }),
    /downloaded recovery artifact digest/u,
  );
});

test("requires the recovery artifact's embedded lock bytes to equal the approved lock", () => {
  assert.throws(
    () => verify(boundaryDocument(), (state) => {
      state.recoveredLock = Buffer.from("different publication lock\n");
    }),
    /do not equal the approved lock/u,
  );
});

test("extracts only the exact pinned artifact member inventory", () => {
  const root = mkdtempSync(path.join(tmpdir(), "oliphaunt-github-stage-boundary-test-"));
  try {
    const archiveRoot = path.join(root, "archive-root");
    mkdirSync(archiveRoot);
    for (const member of EXPECTED_RECOVERY_ARCHIVE_MEMBERS) {
      const file = path.join(archiveRoot, member);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, member.endsWith("publication-lock.json") ? APPROVED_LOCK_BYTES : `${member}\n`);
    }
    const archive = path.join(root, "artifact.zip");
    execFileSync("zip", ["-q", archive, ...EXPECTED_RECOVERY_ARCHIVE_MEMBERS], { cwd: archiveRoot });
    assert.deepEqual(extractBoundaryPublicationLock(readFileSync(archive)), APPROVED_LOCK_BYTES);

    writeFileSync(path.join(archiveRoot, "unexpected.json"), "{}\n");
    execFileSync("zip", ["-q", archive, "unexpected.json"], { cwd: archiveRoot });
    assert.throws(
      () => extractBoundaryPublicationLock(readFileSync(archive)),
      /member inventory is not the exact pinned/u,
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
