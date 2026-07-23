#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import process from "node:process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { reserveGitHubContentWriteSync } from "../../tools/release/github-content-write-pacer.mjs";
import { reserveGitHubCoreRequestSync } from "../../tools/release/github-core-request-journal.mjs";
import { RELEASE_TRANSPORT_REF_STEP_TIMEOUT_MINUTES } from "../../tools/release/release-continuation-read-budget.mjs";

export const RELEASE_TRANSPORT_TAG_PREFIX = "oliphaunt-release-transport/";
export const RELEASE_TRANSPORT_REQUEST_TIMEOUT_MS = 30_000;
export const RELEASE_TRANSPORT_MAX_RESPONSE_BYTES = 64 * 1024;
export const RELEASE_TRANSPORT_STEP_TIMEOUT_MINUTES =
  RELEASE_TRANSPORT_REF_STEP_TIMEOUT_MINUTES;

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const REQUIRE_CURRENT_MAIN = path.join(
  REPOSITORY_ROOT,
  ".github/scripts/require-current-main.sh",
);
const CURRENT_MAIN_PROOF_TIMEOUT_MS = 60_000;

const CONTENT_WRITE_ADMISSIONS = new Set([
  "self-paced",
  "pre-reserved",
  "isolated-bootstrap",
]);

const FULL_SHA = /^[0-9a-f]{40}$/u;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;

function error(message) {
  return new Error(`release-transport-ref: ${message}`);
}

export function normalizeReleaseTransportCommit(value) {
  const commit = String(value ?? "").trim().toLowerCase();
  if (!FULL_SHA.test(commit)) {
    throw error("release commit must be a full lowercase-compatible 40-character SHA");
  }
  return commit;
}

export function releaseTransportTagName(commit) {
  return `${RELEASE_TRANSPORT_TAG_PREFIX}${normalizeReleaseTransportCommit(commit)}`;
}

export function releaseTransportFullRef(commit) {
  return `refs/tags/${releaseTransportTagName(commit)}`;
}

export function validateReleaseTransportRef(value, commit) {
  const expectedCommit = normalizeReleaseTransportCommit(commit);
  const expectedRef = releaseTransportFullRef(expectedCommit);
  if (
    value === null
    || Array.isArray(value)
    || typeof value !== "object"
    || value.ref !== expectedRef
    || value.object === null
    || Array.isArray(value.object)
    || typeof value.object !== "object"
    || value.object.type !== "commit"
    || value.object.sha !== expectedCommit
  ) {
    throw error(`transport ref ${expectedRef} does not point directly to exact release commit ${expectedCommit}`);
  }
  return { commit: expectedCommit, fullRef: expectedRef, tag: releaseTransportTagName(expectedCommit) };
}

function requiredEnvironment(environment, name) {
  const value = environment[name]?.trim();
  if (!value) throw error(`${name} is required`);
  return value;
}

function safeRepository(value) {
  const repo = String(value ?? "").trim();
  if (!REPOSITORY.test(repo)) throw error("GH_REPO must be OWNER/REPOSITORY");
  return repo;
}

function safeToken(value) {
  const token = String(value ?? "");
  if (token.length === 0 || token.length > 16 * 1024 || /[\u0000-\u001f\u007f]/u.test(token)) {
    throw error("GH_TOKEN must be a non-empty control-free secret");
  }
  return token;
}

function rootAdmission(contentWriteAdmission, commit, environment) {
  if (contentWriteAdmission === "self-paced") return { root: false, runAttempt: null };
  const expectedOperation = contentWriteAdmission === "isolated-bootstrap"
    ? "publish-bootstrap"
    : "publish";
  const runAttempt = String(environment.GITHUB_RUN_ATTEMPT ?? "");
  let workflowSha;
  try {
    workflowSha = normalizeReleaseTransportCommit(environment.GITHUB_SHA);
  } catch {
    throw error(
      `${contentWriteAdmission} admission requires the exact root ${expectedOperation} GitHub run`,
    );
  }
  if (
    environment.GITHUB_ACTIONS !== "true"
    || environment.RELEASE_OPERATION !== expectedOperation
    || (environment.RELEASE_CONTINUATION_POINTER ?? "") !== ""
    || environment.GITHUB_REF !== "refs/heads/main"
    || workflowSha !== commit
    || !/^[1-9][0-9]*$/u.test(runAttempt)
    || !Number.isSafeInteger(Number(runAttempt))
  ) {
    throw error(
      `${contentWriteAdmission} admission requires the exact root ${expectedOperation} GitHub run`,
    );
  }
  return { root: true, runAttempt: Number(runAttempt) };
}

export function proveCurrentMainSync({ commit, environment = process.env } = {}) {
  const normalizedCommit = normalizeReleaseTransportCommit(commit);
  const result = spawnSync("bash", [REQUIRE_CURRENT_MAIN, normalizedCommit], {
    cwd: REPOSITORY_ROOT,
    env: environment,
    stdio: "inherit",
    timeout: CURRENT_MAIN_PROOF_TIMEOUT_MS,
    windowsHide: true,
  });
  if (result.error !== undefined) {
    throw error(`current-main proof could not execute: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const outcome = result.signal === null
      ? `exit ${result.status}`
      : `signal ${result.signal}`;
    throw error(`current-main proof failed with ${outcome}`);
  }
}

async function boundedText(response, context) {
  const declared = response.headers?.get?.("content-length");
  if (declared !== null && declared !== undefined) {
    const length = Number(declared);
    if (!Number.isSafeInteger(length) || length < 0 || length > RELEASE_TRANSPORT_MAX_RESPONSE_BYTES) {
      await response.body?.cancel?.().catch(() => {});
      throw error(`${context} returned an invalid or oversized Content-Length`);
    }
  }
  const reader = response.body?.getReader?.();
  if (reader === undefined) {
    const text = await response.text();
    if (Buffer.byteLength(text) > RELEASE_TRANSPORT_MAX_RESPONSE_BYTES) {
      throw error(`${context} exceeded ${RELEASE_TRANSPORT_MAX_RESPONSE_BYTES} bytes`);
    }
    return text;
  }
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > RELEASE_TRANSPORT_MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => {});
      throw error(`${context} exceeded ${RELEASE_TRANSPORT_MAX_RESPONSE_BYTES} bytes`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, size).toString("utf8");
}

async function responseJson(response, context) {
  const text = await boundedText(response, context);
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw error(`${context} returned invalid JSON: ${cause.message}`);
  }
}

function requestHeaders(token, json = false) {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "User-Agent": "oliphaunt-release-transport/1; https://github.com/f0rr0/oliphaunt",
    "X-GitHub-Api-Version": "2022-11-28",
    ...(json ? { "Content-Type": "application/json" } : {}),
  };
}

function apiUrl(repo, suffix) {
  return `https://api.github.com/repos/${repo}/${suffix}`;
}

async function request(fetchImpl, url, options, context) {
  try {
    return await fetchImpl(url, {
      ...options,
      redirect: "error",
      signal: AbortSignal.timeout(RELEASE_TRANSPORT_REQUEST_TIMEOUT_MS),
    });
  } catch (cause) {
    throw error(`${context} failed before a complete response: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

async function readTransportRef({ commit, environment, fetchImpl, repo, token }) {
  reserveGitHubCoreRequestSync({
    environment,
    label: `release transport ref read ${commit}`,
  });
  const response = await request(
    fetchImpl,
    apiUrl(repo, `git/ref/tags/${releaseTransportTagName(commit)}`),
    { headers: requestHeaders(token), method: "GET" },
    "transport ref read",
  );
  if (response.status === 404) {
    await boundedText(response, "transport ref absence response");
    return null;
  }
  if (response.status !== 200) {
    await boundedText(response, "transport ref read failure response");
    throw error(`transport ref read returned HTTP ${response.status}`);
  }
  return validateReleaseTransportRef(await responseJson(response, "transport ref read"), commit);
}

export async function verifyReleaseTransportRef({
  commit,
  environment = process.env,
  fetchImpl = fetch,
  repo = environment.GH_REPO,
  token = environment.GH_TOKEN,
} = {}) {
  const normalizedCommit = normalizeReleaseTransportCommit(commit);
  const safeRepo = safeRepository(repo);
  const secret = safeToken(token);
  const observed = await readTransportRef({
    commit: normalizedCommit,
    environment,
    fetchImpl,
    repo: safeRepo,
    token: secret,
  });
  if (observed === null) {
    throw error(`transport ref ${releaseTransportFullRef(normalizedCommit)} does not exist`);
  }
  return observed;
}

export async function ensureReleaseTransportRef({
  commit,
  contentWriteAdmission = "self-paced",
  environment = process.env,
  fetchImpl = fetch,
  proveCurrentMain = proveCurrentMainSync,
  repo = environment.GH_REPO,
  token = environment.GH_TOKEN,
} = {}) {
  if (!CONTENT_WRITE_ADMISSIONS.has(contentWriteAdmission)) {
    throw error(
      "contentWriteAdmission must be self-paced, pre-reserved, or isolated-bootstrap",
    );
  }
  const normalizedCommit = normalizeReleaseTransportCommit(commit);
  const admission = rootAdmission(
    contentWriteAdmission,
    normalizedCommit,
    environment,
  );
  const safeRepo = safeRepository(repo);
  const secret = safeToken(token);
  const existing = await readTransportRef({
    commit: normalizedCommit,
    environment,
    fetchImpl,
    repo: safeRepo,
    token: secret,
  });
  const genuineRootRerun = admission.root && admission.runAttempt > 1;
  if (existing !== null && genuineRootRerun) {
    return { ...existing, created: false };
  }

  if (existing === null && contentWriteAdmission === "self-paced") {
    reserveGitHubContentWriteSync({
      environment,
      label: `create release transport ref ${normalizedCommit}`,
    });
  }
  await proveCurrentMain({ commit: normalizedCommit, environment });
  if (existing !== null) return { ...existing, created: false };

  reserveGitHubCoreRequestSync({
    environment,
    label: `release transport ref create ${normalizedCommit}`,
  });
  let mutationFailure;
  try {
    const response = await request(
      fetchImpl,
      apiUrl(safeRepo, "git/refs"),
      {
        body: JSON.stringify({
          ref: releaseTransportFullRef(normalizedCommit),
          sha: normalizedCommit,
        }),
        headers: requestHeaders(secret, true),
        method: "POST",
      },
      "transport ref create",
    );
    if (response.status === 201) {
      const created = validateReleaseTransportRef(
        await responseJson(response, "transport ref create"),
        normalizedCommit,
      );
      return { ...created, created: true };
    }
    await boundedText(response, "transport ref create failure response");
    mutationFailure = error(`transport ref create returned HTTP ${response.status}`);
  } catch (cause) {
    mutationFailure = cause;
  }

  // A create can take effect even when its response is lost, or another exact
  // root invocation can win the race. Never replay the mutation: perform one
  // read-only reconciliation and accept only the exact immutable target.
  let reconciled;
  try {
    reconciled = await readTransportRef({
      commit: normalizedCommit,
      environment,
      fetchImpl,
      repo: safeRepo,
      token: secret,
    });
  } catch (cause) {
    throw new AggregateError(
      [mutationFailure, cause],
      "release transport ref creation failed and exact reconciliation could not be completed",
    );
  }
  if (reconciled === null) throw mutationFailure;
  return { ...reconciled, created: true };
}

async function main(argv, environment = process.env) {
  if (argv.length !== 2 || !new Set(["ensure", "verify"]).has(argv[0])) {
    throw error("usage: release-transport-ref.mjs <ensure|verify> <release-commit-sha>");
  }
  const [operation, commit] = argv;
  const contentWriteAdmission = environment.RELEASE_TRANSPORT_CONTENT_WRITE_ADMISSION
    ?? "self-paced";
  const result = operation === "ensure"
    ? await ensureReleaseTransportRef({ commit, contentWriteAdmission, environment })
    : await verifyReleaseTransportRef({ commit, environment });
  console.log(
    `${operation === "ensure" ? (result.created ? "created" : "verified") : "verified"} `
      + `${result.fullRef} at ${result.commit}`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main(process.argv.slice(2)).catch((cause) => {
    console.error(cause instanceof Error ? cause.message : String(cause));
    process.exit(1);
  });
}
