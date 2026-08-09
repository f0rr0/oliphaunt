#!/usr/bin/env bun

import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { captureCommandBytes, captureCommandOutput } from "../dev/capture-command-output.mjs";
import {
  runGitHubPaginatedJsonSync,
  runGitHubReadSync,
} from "./github-read.mjs";
import { validatePublicationLock } from "./publication-lock.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PREFIX = "verify-github-staged-recovery-boundary";
const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024;
const MAX_JSON_BYTES = 16 * 1024 * 1024;
const RELEASE_WORKFLOW_PATH = ".github/workflows/release.yml";
const RELEASE_WORKFLOW_NAME = "Release / publish / main";
const STAGING_JOB_NAME = "Prepare and stage release";
const FAILING_STEP_NAME = "Freeze exact GitHub release asset and attestation evidence";
const LOCK_MEMBER = "oliphaunt/oliphaunt/target/release/publication-lock.json";
const UTF8 = new TextDecoder("utf-8", { fatal: true });

export const EXPECTED_RECOVERY_ARCHIVE_MEMBERS = Object.freeze([
  "_temp/oliphaunt-github-content-write-pacer.json",
  "_temp/oliphaunt-github-core-request-journal.json",
  "_temp/oliphaunt-github-release-asset-upload-report.json",
  "oliphaunt/oliphaunt/target/release/normal-publication-plan.json",
  LOCK_MEMBER,
].sort(compareText));

export const EXPECTED_RELEASE_JOB_OUTCOMES = Object.freeze(new Map([
  ["Bootstrap registry identities", "skipped"],
  ["Dispatch verified bootstrap continuation", "skipped"],
  ["Dispatch verified registry continuation", "skipped"],
  [STAGING_JOB_NAME, "failure"],
  ["Prepare release dry run", "skipped"],
  ["Prepare release PR", "skipped"],
  ["Publish exact registry topology", "skipped"],
  ["Validate release inputs", "success"],
  ["Verify consumers and publish GitHub releases", "skipped"],
]));

export const EXPECTED_STAGING_STEP_OUTCOMES = Object.freeze(new Map([
  ["Freeze exhaustive publication lock", { conclusion: "success", number: 56 }],
  ["Match prior approved publication lock", { conclusion: "success", number: 60 }],
  ["Classify pre-tag registry publication state", { conclusion: "success", number: 68 }],
  ["Upload publication lock audit evidence", { conclusion: "success", number: 75 }],
  ["Re-admit the live GitHub request envelope immediately before mutation", { conclusion: "success", number: 76 }],
  ["Cool down and open the shared GitHub content-write journal", { conclusion: "success", number: 77 }],
  ["Admit or recover exact immutable release transport ref", { conclusion: "success", number: 78 }],
  ["Stage exact-SHA product tags and draft releases", { conclusion: "success", number: 79 }],
  ["Verify exact product tags", { conclusion: "success", number: 80 }],
  ["Verify exact-SHA GitHub release staging", { conclusion: "success", number: 81 }],
  ["Publish all selected GitHub release asset sets concurrently", { conclusion: "success", number: 82 }],
  ["Resolve exact selected extension attestation subjects", { conclusion: "success", number: 86 }],
  ["Reserve extension attestation content write (shard 1)", { conclusion: "success", number: 87 }],
  ["Attest selected extension release assets (shard 1)", { conclusion: "success", number: 88 }],
  ["Reserve extension attestation content write (shard 2)", { conclusion: "success", number: 89 }],
  ["Attest selected extension release assets (shard 2)", { conclusion: "success", number: 90 }],
  ["Reserve liboliphaunt attestation content write", { conclusion: "success", number: 91 }],
  ["Attest liboliphaunt release assets", { conclusion: "success", number: 92 }],
  ["Publish Swift SDK GitHub release and SwiftPM tags", { conclusion: "success", number: 93 }],
  ["Reserve broker attestation content write", { conclusion: "success", number: 94 }],
  ["Attest broker release assets", { conclusion: "success", number: 95 }],
  ["Reserve Node direct attestation content write", { conclusion: "success", number: 96 }],
  ["Attest Node direct release assets", { conclusion: "success", number: 97 }],
  ["Reserve WASIX attestation content write", { conclusion: "success", number: 98 }],
  ["Attest WASIX release assets", { conclusion: "success", number: 99 }],
  [FAILING_STEP_NAME, { conclusion: "failure", number: 100 }],
  ["Seal immutable GitHub-stage handoff", { conclusion: "skipped", number: 101 }],
  ["Preserve immutable GitHub-stage handoff", { conclusion: "skipped", number: 102 }],
  ["Preserve failed GitHub staging evidence", { conclusion: "success", number: 103 }],
]));

function fail(message) {
  throw new Error(`${PREFIX}: ${message}`);
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function plainObject(value) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function assertObject(value, label) {
  if (!plainObject(value)) fail(`${label} must be an object`);
  return value;
}

function assertKeySet(value, expected, label) {
  assertObject(value, label);
  const actual = Object.keys(value).sort(compareText);
  const wanted = [...expected].sort(compareText);
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    fail(`${label} keys must be exactly ${wanted.join(", ")}`);
  }
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) fail(`${label} must be a positive safe integer`);
  return value;
}

function sha(value, label) {
  if (typeof value !== "string" || !/^[0-9a-f]{40}$/u.test(value)) {
    fail(`${label} must be a lowercase full commit SHA`);
  }
  return value;
}

function digest(value, label) {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(value)) {
    fail(`${label} must be a lowercase sha256 digest`);
  }
  return value;
}

function hash(value, label) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
    fail(`${label} must be a lowercase SHA-256 hash`);
  }
  return value;
}

function exact(value, expected, label) {
  if (value !== expected) {
    fail(`${label} must be ${JSON.stringify(expected)}, got ${JSON.stringify(value)}`);
  }
}

function boundedBuffer(value, maximum, label) {
  if (!Buffer.isBuffer(value)) fail(`${label} must be bytes`);
  if (value.length === 0 || value.length > maximum) {
    fail(`${label} must contain between 1 and ${maximum} bytes`);
  }
  return value;
}

function parseJsonBytes(bytes, label) {
  boundedBuffer(bytes, MAX_JSON_BYTES, label);
  let text;
  try {
    text = UTF8.decode(bytes);
  } catch {
    fail(`${label} is not valid UTF-8`);
  }
  try {
    return JSON.parse(text);
  } catch (cause) {
    fail(`${label} is not strict JSON: ${cause.message}`);
  }
}

function unwrapBoundary(value) {
  const document = assertObject(value, "boundary document");
  if (Object.hasOwn(document, "recoveryBoundary")) {
    if (!Object.hasOwn(document, "releaseSource")) {
      fail("selected recovery record must contain releaseSource");
    }
    assertKeySet(document.releaseSource, ["commit", "tree"], "releaseSource");
    return {
      boundary: document.recoveryBoundary,
      releaseSource: document.releaseSource,
    };
  }
  return { boundary: document, releaseSource: null };
}

export function validateGithubStagedRecoveryBoundary(value) {
  const { boundary, releaseSource } = unwrapBoundary(value);
  assertKeySet(boundary, ["evidenceArtifact", "job", "kind", "run"], "recoveryBoundary");
  exact(boundary.kind, "github-staged", "recoveryBoundary.kind");

  assertKeySet(
    boundary.run,
    ["attempt", "conclusion", "event", "headSha", "id", "status"],
    "recoveryBoundary.run",
  );
  const run = {
    attempt: positiveInteger(boundary.run.attempt, "recoveryBoundary.run.attempt"),
    conclusion: boundary.run.conclusion,
    event: boundary.run.event,
    headSha: sha(boundary.run.headSha, "recoveryBoundary.run.headSha"),
    id: positiveInteger(boundary.run.id, "recoveryBoundary.run.id"),
    status: boundary.run.status,
  };
  exact(run.status, "completed", "recoveryBoundary.run.status");
  exact(run.conclusion, "failure", "recoveryBoundary.run.conclusion");
  exact(run.event, "workflow_dispatch", "recoveryBoundary.run.event");

  assertKeySet(boundary.job, ["conclusion", "id", "name"], "recoveryBoundary.job");
  const job = {
    conclusion: boundary.job.conclusion,
    id: positiveInteger(boundary.job.id, "recoveryBoundary.job.id"),
    name: boundary.job.name,
  };
  exact(job.conclusion, "failure", "recoveryBoundary.job.conclusion");
  exact(job.name, STAGING_JOB_NAME, "recoveryBoundary.job.name");

  assertKeySet(
    boundary.evidenceArtifact,
    ["digest", "id", "name", "size"],
    "recoveryBoundary.evidenceArtifact",
  );
  const evidenceArtifact = {
    digest: digest(boundary.evidenceArtifact.digest, "recoveryBoundary.evidenceArtifact.digest"),
    id: positiveInteger(boundary.evidenceArtifact.id, "recoveryBoundary.evidenceArtifact.id"),
    name: boundary.evidenceArtifact.name,
    size: positiveInteger(boundary.evidenceArtifact.size, "recoveryBoundary.evidenceArtifact.size"),
  };
  if (evidenceArtifact.size > MAX_ARTIFACT_BYTES) {
    fail(`recoveryBoundary.evidenceArtifact.size exceeds ${MAX_ARTIFACT_BYTES} bytes`);
  }
  exact(
    evidenceArtifact.name,
    `github-staging-recovery-${run.headSha}-${run.id}-${run.attempt}`,
    "recoveryBoundary.evidenceArtifact.name",
  );

  if (releaseSource !== null) {
    sha(releaseSource.commit, "releaseSource.commit");
    sha(releaseSource.tree, "releaseSource.tree");
    exact(releaseSource.commit, run.headSha, "releaseSource.commit");
  }
  return { evidenceArtifact, job, releaseSource, run };
}

function jsonRead(repo, endpoint, label) {
  let value;
  try {
    value = JSON.parse(runGitHubReadSync(
      ["api", "-H", "X-GitHub-Api-Version: 2022-11-28", `repos/${repo}/${endpoint}`],
      {
        cwd: ROOT,
        label,
        maxBuffer: 8 * 1024 * 1024,
        onRetry: ({ attempt, delayMs }) => {
          console.error(`${PREFIX}: ${label} transiently failed after attempt ${attempt}; retrying in ${delayMs}ms`);
        },
      },
    ));
  } catch (cause) {
    fail(`${label} failed: ${cause.message}`);
  }
  return value;
}

function defaultGithub() {
  return {
    downloadArtifact({ artifactId, repo }) {
      try {
        return runGitHubReadSync(
          [
            "api",
            "-H",
            "X-GitHub-Api-Version: 2022-11-28",
            `repos/${repo}/actions/artifacts/${artifactId}/zip`,
          ],
          {
            binary: true,
            cwd: ROOT,
            label: `download pinned recovery artifact ${artifactId}`,
            maxBuffer: MAX_ARTIFACT_BYTES,
            onRetry: ({ attempt, delayMs }) => {
              console.error(
                `${PREFIX}: recovery artifact download transiently failed after attempt ${attempt}; `
                + `retrying in ${delayMs}ms`,
              );
            },
          },
        );
      } catch (cause) {
        fail(`cannot download pinned recovery artifact ${artifactId}: ${cause.message}`);
      }
    },
    getArtifact({ artifactId, repo }) {
      return jsonRead(repo, `actions/artifacts/${artifactId}`, `read pinned recovery artifact ${artifactId}`);
    },
    getJobs({ attempt, repo, runId }) {
      try {
        return runGitHubPaginatedJsonSync(
          `repos/${repo}/actions/runs/${runId}/attempts/${attempt}/jobs`,
          {
            cwd: ROOT,
            itemsField: "jobs",
            label: `read pinned Release run ${runId} attempt ${attempt} jobs`,
            maxPages: 2,
            onRetry: ({ attempt: readAttempt, delayMs }) => {
              console.error(
                `${PREFIX}: job inventory read transiently failed after attempt ${readAttempt}; `
                + `retrying in ${delayMs}ms`,
              );
            },
          },
        );
      } catch (cause) {
        fail(`cannot read pinned Release run job inventory: ${cause.message}`);
      }
    },
    getRun({ repo, runId }) {
      return jsonRead(repo, `actions/runs/${runId}`, `read pinned Release run ${runId}`);
    },
  };
}

function validateLiveRun(live, boundary, repo) {
  assertObject(live, "live Release run");
  exact(live.id, boundary.id, "live Release run id");
  exact(live.run_attempt, boundary.attempt, "live Release run attempt");
  exact(live.status, boundary.status, "live Release run status");
  exact(live.conclusion, boundary.conclusion, "live Release run conclusion");
  exact(live.event, boundary.event, "live Release run event");
  exact(live.head_sha, boundary.headSha, "live Release run head SHA");
  exact(live.head_branch, "main", "live Release run head branch");
  exact(live.path, RELEASE_WORKFLOW_PATH, "live Release workflow path");
  exact(live.name, RELEASE_WORKFLOW_NAME, "live Release workflow name");
  exact(live.display_title, RELEASE_WORKFLOW_NAME, "live Release display title");
  exact(live.repository?.full_name, repo, "live Release repository");
  exact(live.head_repository?.full_name, repo, "live Release head repository");
  exact(live.head_commit?.id, boundary.headSha, "live Release head commit");
}

function validateCriticalStagingSteps(steps) {
  if (!Array.isArray(steps) || steps.length === 0) fail("live staging job has no steps");
  const byName = new Map();
  const seenNumbers = new Set();
  let previousNumber = 0;
  for (const step of steps) {
    assertObject(step, "live staging step");
    if (typeof step.name !== "string" || step.name.length === 0 || byName.has(step.name)) {
      fail("live staging steps must have unique nonempty names");
    }
    positiveInteger(step.number, `live staging step ${step.name} number`);
    if (seenNumbers.has(step.number) || step.number <= previousNumber) {
      fail("live staging steps must have unique strictly increasing numbers");
    }
    previousNumber = step.number;
    seenNumbers.add(step.number);
    exact(step.status, "completed", `live staging step ${step.name} status`);
    byName.set(step.name, step);
  }
  for (const [name, expected] of EXPECTED_STAGING_STEP_OUTCOMES) {
    const step = byName.get(name);
    if (step === undefined) fail(`live staging job is missing critical step ${JSON.stringify(name)}`);
    exact(step.number, expected.number, `live staging step ${name} number`);
    exact(step.conclusion, expected.conclusion, `live staging step ${name} conclusion`);
  }
  const failed = steps.filter(({ conclusion }) => conclusion === "failure");
  if (failed.length !== 1 || failed[0].name !== FAILING_STEP_NAME) {
    fail(`live staging job must have exactly one failed step: ${FAILING_STEP_NAME}`);
  }
  const disallowed = steps.filter(({ conclusion }) =>
    !["success", "skipped", "failure"].includes(conclusion));
  if (disallowed.length > 0) {
    fail(`live staging job contains unsupported step outcome ${JSON.stringify(disallowed[0].conclusion)}`);
  }
}

function validateLiveJobs(jobs, boundary, run) {
  if (!Array.isArray(jobs)) fail("live Release job inventory must be an array");
  if (jobs.length !== EXPECTED_RELEASE_JOB_OUTCOMES.size) {
    fail(
      `live Release job inventory must contain exactly ${EXPECTED_RELEASE_JOB_OUTCOMES.size} jobs, `
      + `got ${jobs.length}`,
    );
  }
  const byName = new Map();
  const ids = new Set();
  for (const job of jobs) {
    assertObject(job, "live Release job");
    positiveInteger(job.id, "live Release job id");
    if (ids.has(job.id)) fail(`live Release job inventory repeats job id ${job.id}`);
    ids.add(job.id);
    if (typeof job.name !== "string" || job.name.length === 0 || byName.has(job.name)) {
      fail("live Release jobs must have unique nonempty names");
    }
    exact(job.run_id, run.id, `live Release job ${job.name} run id`);
    exact(job.run_attempt, run.attempt, `live Release job ${job.name} run attempt`);
    exact(job.head_sha, run.headSha, `live Release job ${job.name} head SHA`);
    exact(job.status, "completed", `live Release job ${job.name} status`);
    exact(job.workflow_name, RELEASE_WORKFLOW_NAME, `live Release job ${job.name} workflow name`);
    byName.set(job.name, job);
  }
  for (const [name, expectedConclusion] of EXPECTED_RELEASE_JOB_OUTCOMES) {
    const job = byName.get(name);
    if (job === undefined) fail(`live Release job inventory is missing ${JSON.stringify(name)}`);
    exact(job.conclusion, expectedConclusion, `live Release job ${name} conclusion`);
    if (expectedConclusion === "skipped" && (!Array.isArray(job.steps) || job.steps.length !== 0)) {
      fail(`skipped Release job ${name} must expose no executed steps`);
    }
  }
  const staging = byName.get(STAGING_JOB_NAME);
  exact(staging.id, boundary.id, "live staging job id");
  exact(staging.conclusion, boundary.conclusion, "live staging job conclusion");
  if (JSON.stringify(staging.labels) !== JSON.stringify(["macos-26"])) {
    fail("live staging job must have the exact macos-26 runner label");
  }
  validateCriticalStagingSteps(staging.steps);
}

function validateLiveArtifact(live, boundary, run, repo) {
  assertObject(live, "live recovery artifact");
  exact(live.id, boundary.id, "live recovery artifact id");
  exact(live.name, boundary.name, "live recovery artifact name");
  exact(live.size_in_bytes, boundary.size, "live recovery artifact size");
  exact(live.digest, boundary.digest, "live recovery artifact digest");
  exact(live.expired, false, "live recovery artifact expired state");
  exact(live.workflow_run?.id, run.id, "live recovery artifact workflow run id");
  exact(live.workflow_run?.head_sha, run.headSha, "live recovery artifact workflow run head SHA");
  exact(live.workflow_run?.head_branch, "main", "live recovery artifact workflow run head branch");
  exact(
    live.url,
    `https://api.github.com/repos/${repo}/actions/artifacts/${boundary.id}`,
    "live recovery artifact API URL",
  );
  exact(
    live.archive_download_url,
    `https://api.github.com/repos/${repo}/actions/artifacts/${boundary.id}/zip`,
    "live recovery artifact download URL",
  );
}

function checkedCommand(command, args, { binary = false, maxOutputBytes, stdoutTerminator } = {}) {
  const capture = binary ? captureCommandBytes : captureCommandOutput;
  const result = capture(command, args, {
    cwd: ROOT,
    label: `${command} ${args.join(" ")}`,
    maxOutputBytes,
    stdoutTerminator,
  });
  if (result.error !== undefined || result.status !== 0) {
    const stderr = Buffer.isBuffer(result.stderr) ? result.stderr.toString("utf8") : result.stderr;
    fail(`${command} ${args.join(" ")} failed: ${(stderr || result.error?.message || "unknown error").trim()}`);
  }
  return result.stdout;
}

export function extractBoundaryPublicationLock(archiveBytes) {
  boundedBuffer(archiveBytes, MAX_ARTIFACT_BYTES, "recovery artifact ZIP");
  if (archiveBytes.length < 4 || archiveBytes[0] !== 0x50 || archiveBytes[1] !== 0x4b) {
    fail("recovery artifact is not a ZIP archive");
  }
  const directory = mkdtempSync(path.join(os.tmpdir(), "oliphaunt-github-stage-boundary-"));
  try {
    const archive = path.join(directory, "artifact.zip");
    writeFileSync(archive, archiveBytes, { flag: "wx", mode: 0o600 });
    checkedCommand("unzip", ["-tqq", archive], { maxOutputBytes: 64 * 1024 });
    const memberOutput = checkedCommand("unzip", ["-Z1", archive], {
      maxOutputBytes: 64 * 1024,
      stdoutTerminator: "\n",
    });
    const members = memberOutput.split(/\r?\n/u).filter(Boolean);
    if (new Set(members).size !== members.length) {
      fail("recovery artifact ZIP repeats a member");
    }
    const canonicalMembers = [...members].sort(compareText);
    if (JSON.stringify(canonicalMembers) !== JSON.stringify(EXPECTED_RECOVERY_ARCHIVE_MEMBERS)) {
      fail("recovery artifact ZIP member inventory is not the exact pinned GitHub-staging evidence set");
    }
    return checkedCommand("unzip", ["-p", archive, LOCK_MEMBER], {
      binary: true,
      maxOutputBytes: MAX_JSON_BYTES,
    });
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

function defaultValidateApprovedLock(bytes) {
  const parsed = parseJsonBytes(bytes, "approved publication lock");
  try {
    return validatePublicationLock(parsed);
  } catch (cause) {
    fail(`approved publication lock is invalid: ${cause.message}`);
  }
}

export function verifyGithubStagedRecoveryBoundary({
  approvedLockBytes,
  boundaryDocument,
  repo,
}, dependencies = {}) {
  if (typeof repo !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repo)) {
    fail("repo must be owner/repository");
  }
  boundedBuffer(approvedLockBytes, MAX_JSON_BYTES, "approved publication lock");
  const boundary = validateGithubStagedRecoveryBoundary(boundaryDocument);
  const github = dependencies.github ?? defaultGithub();
  const validateApprovedLock = dependencies.validateApprovedLock ?? defaultValidateApprovedLock;
  const extractPublicationLock = dependencies.extractPublicationLock ?? extractBoundaryPublicationLock;
  const approvedLock = validateApprovedLock(approvedLockBytes);
  assertObject(approvedLock, "validated approved publication lock");
  exact(approvedLock.schema, "oliphaunt-publication-lock-v1", "approved publication lock schema");
  exact(approvedLock.source?.commit, boundary.run.headSha, "approved publication lock source commit");
  if (boundary.releaseSource !== null) {
    exact(
      approvedLock.source?.tree,
      boundary.releaseSource.tree,
      "approved publication lock source tree",
    );
  }
  hash(approvedLock.lockDigest, "approved publication lock lockDigest");

  const liveRun = github.getRun({ repo, runId: boundary.run.id });
  validateLiveRun(liveRun, boundary.run, repo);
  const liveJobs = github.getJobs({ attempt: boundary.run.attempt, repo, runId: boundary.run.id });
  validateLiveJobs(liveJobs, boundary.job, boundary.run);
  const liveArtifact = github.getArtifact({ artifactId: boundary.evidenceArtifact.id, repo });
  validateLiveArtifact(liveArtifact, boundary.evidenceArtifact, boundary.run, repo);

  const archiveBytes = boundedBuffer(
    github.downloadArtifact({ artifactId: boundary.evidenceArtifact.id, repo }),
    MAX_ARTIFACT_BYTES,
    "downloaded recovery artifact",
  );
  exact(archiveBytes.length, boundary.evidenceArtifact.size, "downloaded recovery artifact size");
  exact(
    `sha256:${sha256(archiveBytes)}`,
    boundary.evidenceArtifact.digest,
    "downloaded recovery artifact digest",
  );
  const recoveredLockBytes = boundedBuffer(
    extractPublicationLock(archiveBytes),
    MAX_JSON_BYTES,
    "recovered embedded publication lock",
  );
  if (!recoveredLockBytes.equals(approvedLockBytes)) {
    fail("recovered embedded publication-lock bytes do not equal the approved lock");
  }

  return Object.freeze({
    artifactDigest: boundary.evidenceArtifact.digest,
    artifactId: boundary.evidenceArtifact.id,
    failedStep: FAILING_STEP_NAME,
    jobId: boundary.job.id,
    lockDigest: approvedLock.lockDigest,
    releaseSource: boundary.run.headSha,
    runAttempt: boundary.run.attempt,
    runId: boundary.run.id,
  });
}

function readBoundedRegularFile(file, maximum, label) {
  const absolute = path.resolve(file);
  let metadata;
  try {
    metadata = lstatSync(absolute);
  } catch (cause) {
    fail(`cannot inspect ${label} ${file}: ${cause.message}`);
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size === 0 || metadata.size > maximum) {
    fail(`${label} ${file} must be a nonempty regular non-symlink file of at most ${maximum} bytes`);
  }
  return readFileSync(absolute);
}

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!["--approved-lock", "--boundary", "--repo"].includes(flag)) {
      fail(`unknown argument ${JSON.stringify(flag)}`);
    }
    if (value === undefined || value.length === 0 || value.startsWith("--")) {
      fail(`${flag} requires a value`);
    }
    if (values.has(flag)) fail(`${flag} may be supplied only once`);
    values.set(flag, value);
  }
  const approvedLock = values.get("--approved-lock");
  const boundary = values.get("--boundary");
  const repo = values.get("--repo") ?? process.env.GH_REPO;
  if (!approvedLock || !boundary) {
    fail("usage: verify-github-staged-recovery-boundary.mjs --boundary FILE --approved-lock FILE [--repo OWNER/REPO]");
  }
  if (!repo) fail("--repo or GH_REPO is required");
  return { approvedLock, boundary, repo };
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const boundaryDocument = parseJsonBytes(
    readBoundedRegularFile(args.boundary, MAX_JSON_BYTES, "boundary document"),
    "boundary document",
  );
  const approvedLockBytes = readBoundedRegularFile(
    args.approvedLock,
    MAX_JSON_BYTES,
    "approved publication lock",
  );
  const result = verifyGithubStagedRecoveryBoundary({
    approvedLockBytes,
    boundaryDocument,
    repo: args.repo,
  });
  console.log(
    `GitHub-staged recovery boundary verified: run ${result.runId} attempt ${result.runAttempt}, `
    + `job ${result.jobId}, artifact ${result.artifactId}, lock ${result.lockDigest}`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (cause) {
    console.error(cause instanceof Error ? cause.message : String(cause));
    process.exit(1);
  }
}
