#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  createReleaseContinuationPointer,
  normalizeArtifactIdentity,
  RELEASE_CONTINUATION_MAX_DISPATCH_DELAY_SECONDS,
  sha256Bytes,
  validateReleaseContinuationContract,
} from "../../tools/release/release-continuation-contract.mjs";
import {
  continuationAuthorizationArtifactName,
  createReleaseContinuationAuthorization,
  serializeReleaseContinuationAuthorization,
} from "../../tools/release/release-continuation-authorization.mjs";
import { openContinuationEnvelope } from "./release-continuation-artifact.mjs";
import {
  retryReadOperationSync,
  runGitHubReadSync,
} from "../../tools/release/github-read.mjs";
import {
  RELEASE_CONTINUATION_ARTIFACT_DOWNLOAD_DEADLINE_MS,
  RELEASE_CONTINUATION_DISPATCH_REQUEST_DEADLINE_MS,
  RELEASE_CONTINUATION_METADATA_READ_DEADLINE_MS,
} from "../../tools/release/release-continuation-read-budget.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const MAX_ARTIFACT_BYTES = 128 * 1024 * 1024;
export const MAX_CONTINUATION_DISPATCH_DELAY_SECONDS =
  RELEASE_CONTINUATION_MAX_DISPATCH_DELAY_SECONDS;
export const CONTINUATION_DISPATCH_REQUEST_TIMEOUT_MS =
  RELEASE_CONTINUATION_DISPATCH_REQUEST_DEADLINE_MS;

function error(message) {
  return new Error(`dispatch-release-continuation: ${message}`);
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

function ghJson(repo, endpoint, label) {
  return json(runGitHubReadSync(
    ["api", "-H", "X-GitHub-Api-Version: 2022-11-28", `repos/${repo}/${endpoint}`],
    {
      cwd: ROOT,
      deadlineMs: RELEASE_CONTINUATION_METADATA_READ_DEADLINE_MS,
      label,
      maxBuffer: 4 * 1024 * 1024,
    },
  ), label);
}

function exactArtifactBytes(repo, artifact) {
  return retryReadOperationSync(
    `download sealed continuation artifact ${artifact.id}`,
    ({ attemptTimeoutMs }) => runGitHubReadSync(
      [
        "api",
        "-H",
        "X-GitHub-Api-Version: 2022-11-28",
        `repos/${repo}/actions/artifacts/${artifact.id}/zip`,
      ],
      {
        binary: true,
        cwd: ROOT,
        label: `download sealed continuation artifact ${artifact.id}`,
        maxBuffer: MAX_ARTIFACT_BYTES,
        attemptTimeoutMs,
        deadlineMs: attemptTimeoutMs,
        maxAttempts: 1,
        baseDelayMs: 0,
        maxDelayMs: 0,
      },
    ),
    {
      attemptTimeoutMs: 5 * 60_000,
      deadlineMs: RELEASE_CONTINUATION_ARTIFACT_DOWNLOAD_DEADLINE_MS,
      maxAttempts: 4,
    },
  );
}

function command(commandName, args, options = {}) {
  const result = spawnSync(commandName, args, {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: MAX_ARTIFACT_BYTES,
    stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    input: options.input,
    env: process.env,
    timeout: options.timeoutMs,
  });
  if (result.error !== undefined || result.status !== 0) {
    throw error(
      `${commandName} ${args.join(" ")} failed: `
      + `${(result.stderr || result.stdout || result.error?.message || "").trim()}`,
    );
  }
  return result.stdout;
}

function contractFromZip(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    throw error("sealed continuation artifact did not return a ZIP archive");
  }
  const directory = mkdtempSync(path.join(os.tmpdir(), "oliphaunt-continuation-dispatch-"));
  try {
    const archive = path.join(directory, "artifact.zip");
    writeFileSync(archive, bytes, { flag: "wx", mode: 0o600 });
    const members = command("unzip", ["-Z1", archive]).split(/\r?\n/u).filter(Boolean);
    if (members.filter((member) => member === "release-continuation-contract.json").length !== 1) {
      throw error("sealed continuation artifact must contain one root continuation contract");
    }
    return json(command("unzip", ["-p", archive, "release-continuation-contract.json"]), "continuation contract");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export function continuationDelaySeconds(notBeforeEpochSeconds, nowEpochSeconds) {
  if (!Number.isSafeInteger(notBeforeEpochSeconds) || notBeforeEpochSeconds < 1) {
    throw error("continuation not-before time must be a positive Unix timestamp");
  }
  if (!Number.isSafeInteger(nowEpochSeconds) || nowEpochSeconds < 1) {
    throw error("current time must be a positive Unix timestamp");
  }
  const delay = Math.max(0, notBeforeEpochSeconds - nowEpochSeconds);
  if (delay > MAX_CONTINUATION_DISPATCH_DELAY_SECONDS) {
    throw error(
      `continuation requests a ${delay}s delay; maximum automatic dispatch delay is `
      + `${MAX_CONTINUATION_DISPATCH_DELAY_SECONDS}s`,
    );
  }
  return delay;
}

export function validateDispatchResponse(value, { repo, parentRunId }) {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw error("workflow dispatch response must be an object");
  }
  const childRunId = positiveInteger(value.workflow_run_id, "workflow dispatch child run id");
  if (childRunId === parentRunId) throw error("workflow dispatch returned the parent run id as its child");
  const api = `https://api.github.com/repos/${repo}/actions/runs/${childRunId}`;
  const html = `https://github.com/${repo}/actions/runs/${childRunId}`;
  if (value.run_url !== api || value.html_url !== html) {
    throw error("workflow dispatch response URLs do not bind the returned child run id and repository");
  }
  return { childRunId, htmlUrl: html, runUrl: api };
}

export function parseDispatchResponse(raw) {
  if (typeof raw !== "string") {
    throw error("workflow dispatch response must include an HTTP status and JSON body");
  }
  const boundary = /\r?\n\r?\n/u.exec(raw);
  if (boundary === null || boundary.index === 0) {
    throw error("workflow dispatch response did not include one HTTP header block");
  }
  const statusLine = raw.slice(0, boundary.index).split(/\r?\n/u)[0] ?? "";
  if (!/^HTTP\/(?:1[.][01]|2(?:[.]0)?|3(?:[.]0)?) 200(?:\s|$)/u.test(statusLine)) {
    throw error(`workflow dispatch response must be HTTP 200; got ${JSON.stringify(statusLine)}`);
  }
  const body = raw.slice(boundary.index + boundary[0].length);
  return json(body, "workflow dispatch response");
}

function requireCurrentMain(repo, releaseCommit) {
  const ref = ghJson(repo, "git/ref/heads/main", "current main ref");
  if (ref?.ref !== "refs/heads/main" || ref.object?.type !== "commit" || ref.object?.sha !== releaseCommit) {
    throw error("main moved away from the exact release commit before continuation dispatch");
  }
}

export function buildDispatchRequest(repo, pointer) {
  const payload = JSON.stringify({
    ref: "main",
    inputs: {
      operation: pointer.operation,
      release_commit: pointer.releaseCommit,
      continuation_pointer: JSON.stringify(pointer),
    },
  });
  return {
    args: [
      "api",
      "--include",
      "--method",
      "POST",
      "-H",
      "Accept: application/vnd.github+json",
      "-H",
      "X-GitHub-Api-Version: 2026-03-10",
      `repos/${repo}/actions/workflows/release.yml/dispatches`,
      "--input",
      "-",
    ],
    payload,
  };
}

function dispatch(repo, pointer) {
  const request = buildDispatchRequest(repo, pointer);
  const raw = command(
    "gh",
    request.args,
    {
      input: request.payload,
      timeoutMs: CONTINUATION_DISPATCH_REQUEST_TIMEOUT_MS,
    },
  );
  return parseDispatchResponse(raw);
}

export async function main(environment = process.env) {
  const repo = required("GH_REPO", environment);
  const operation = required("RELEASE_OPERATION", environment);
  const releaseCommit = required("RELEASE_HEAD_SHA", environment);
  const parentRunId = positiveInteger(required("GITHUB_RUN_ID", environment), "GITHUB_RUN_ID");
  const parentRunAttempt = positiveInteger(required("GITHUB_RUN_ATTEMPT", environment), "GITHUB_RUN_ATTEMPT");
  const artifactId = positiveInteger(required("CONTINUATION_ARTIFACT_ID", environment), "CONTINUATION_ARTIFACT_ID");
  const expectedArtifactDigest = required("CONTINUATION_ARTIFACT_DIGEST", environment);
  const expectedContractDigest = required("CONTINUATION_CONTRACT_DIGEST", environment);
  const metadata = ghJson(repo, `actions/artifacts/${artifactId}`, `continuation artifact ${artifactId}`);
  const artifact = normalizeArtifactIdentity({
    digest: metadata.digest,
    id: metadata.id,
    name: metadata.name,
    size: metadata.size_in_bytes,
  }, "continuation artifact metadata");
  if (
    artifact.id !== artifactId
    || artifact.digest !== expectedArtifactDigest
    || metadata.expired !== false
    || (metadata.workflow_run?.id !== undefined && Number(metadata.workflow_run.id) !== parentRunId)
  ) {
    throw error("uploaded continuation artifact metadata does not match the completed parent job outputs");
  }
  const run = ghJson(repo, `actions/runs/${parentRunId}`, `parent Release run ${parentRunId}`);
  if (
    Number(run.id) !== parentRunId
    || Number(run.run_attempt) !== parentRunAttempt
    || run.head_sha !== releaseCommit
    || run.event !== "workflow_dispatch"
  ) {
    throw error("dispatcher parent run does not match its exact Release workflow identity");
  }
  const bytes = exactArtifactBytes(repo, artifact);
  if (!Buffer.isBuffer(bytes) || bytes.length !== artifact.size || `sha256:${sha256Bytes(bytes)}` !== artifact.digest) {
    throw error("uploaded continuation artifact bytes do not match immutable GitHub metadata");
  }
  const contract = validateReleaseContinuationContract(contractFromZip(bytes), {
    contractDigest: expectedContractDigest,
    operation,
    parentRunAttempt,
    parentRunId,
    releaseCommit,
  });
  const pointer = createReleaseContinuationPointer({ artifact, contract });
  openContinuationEnvelope(bytes, pointer);
  if (JSON.stringify(pointer).length > 32 * 1024) {
    throw error("canonical continuation pointer exceeds the bounded workflow input size");
  }
  requireCurrentMain(repo, releaseCommit);
  const delay = continuationDelaySeconds(contract.outcome.notBeforeEpochSeconds, Math.floor(Date.now() / 1000));
  if (delay > 0) {
    console.log(`waiting ${delay}s for the registry-authoritative continuation not-before time`);
    await new Promise((resolve) => setTimeout(resolve, delay * 1000));
  }
  requireCurrentMain(repo, releaseCommit);
  const response = validateDispatchResponse(dispatch(repo, pointer), { repo, parentRunId });
  const authorizationPath = required("CONTINUATION_AUTHORIZATION_PATH", environment);
  const authorization = createReleaseContinuationAuthorization({
    childRunId: response.childRunId,
    pointer,
    repo,
  });
  writeFileSync(
    authorizationPath,
    serializeReleaseContinuationAuthorization(authorization),
    { flag: "wx", mode: 0o600 },
  );
  const authorizationArtifactName = continuationAuthorizationArtifactName(pointer);
  if (environment.GITHUB_OUTPUT) {
    writeFileSync(
      environment.GITHUB_OUTPUT,
      `authorization_artifact_name=${authorizationArtifactName}\n`
        + `child_run_id=${response.childRunId}\nchild_run_url=${response.htmlUrl}\n`,
      { flag: "a" },
    );
  }
  if (environment.GITHUB_STEP_SUMMARY) {
    writeFileSync(
      environment.GITHUB_STEP_SUMMARY,
      `## Release continuation dispatched\n\n- Child run: [${response.childRunId}](${response.htmlUrl})\n`
        + `- Authorization artifact: \`${authorizationArtifactName}\`\n`
        + `- Generation: ${contract.lineage.generation}/${contract.lineage.maxGenerations}\n`
        + `- Remaining immutable operations: ${contract.outcome.remainingCount}\n`,
      { flag: "a" },
    );
  }
  console.log(
    `dispatched ${operation} continuation generation ${contract.lineage.generation} as child Release run `
      + `${response.childRunId}: ${response.htmlUrl}`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((cause) => {
    console.error(cause instanceof Error ? cause.message : String(cause));
    process.exit(1);
  });
}
