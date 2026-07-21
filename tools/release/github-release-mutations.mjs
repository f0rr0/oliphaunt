import { spawnSync } from "node:child_process";
import process from "node:process";

import {
  githubReadOptionsFromEnv,
  redactGitHubReadDetail,
  runGitHubPaginatedJsonSync,
  runGitHubReadSync,
} from "./github-read.mjs";
import { reserveGitHubContentWriteSync } from "./github-content-write-pacer.mjs";
import { reserveGitHubCoreRequestSync } from "./github-core-request-journal.mjs";

const DEFAULT_MUTATION_ATTEMPT_TIMEOUT_MS = 60_000;
const DEFAULT_MUTATION_BASE_DELAY_MS = 1_000;
const DEFAULT_MUTATION_MAX_ATTEMPTS = 3;
const DEFAULT_OPERATION_WINDOW_MS = 15 * 60_000;
const DEFAULT_HARD_DEADLINE_RESERVE_MS = 30_000;
const INTEGER = /^(?:0|[1-9][0-9]*)$/u;
const FULL_SHA = /^[0-9a-f]{40}$/u;
const MAX_MUTATION_CAPTURE_BYTES = 4 * 1024 * 1024;
const RECONCILIATION_KINDS = new Set(["absent", "conflict", "desired", "unchanged"]);

export class GitHubReleaseMutationError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = "GitHubReleaseMutationError";
  }
}

function mutationError(message, options = {}) {
  return new GitHubReleaseMutationError(message, options);
}

function nonNegativeInteger(environment, name, fallback, { maximum = Number.MAX_SAFE_INTEGER, minimum = 0 } = {}) {
  const raw = environment[name];
  if (raw === undefined || raw === "") return fallback;
  if (!INTEGER.test(raw)) {
    throw mutationError(`${name} must be an integer`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw mutationError(`${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function safeDetail(error, environment) {
  const parts = [];
  let current = error;
  for (let depth = 0; current !== undefined && current !== null && depth < 8; depth += 1) {
    if (typeof current === "string") {
      parts.push(current);
      break;
    }
    if (typeof current.message === "string") parts.push(current.message);
    if (typeof current.detail === "string") parts.push(current.detail);
    current = current.cause;
  }
  return redactGitHubReadDetail(parts.join("\n"), environment);
}

export function isExplicitGitHubNotFound(error) {
  let current = error;
  for (let depth = 0; current !== undefined && current !== null && depth < 8; depth += 1) {
    if (current.httpStatus === 404) return true;
    const text = [current.message, current.detail]
      .filter((value) => typeof value === "string")
      .join("\n");
    if (/\bHTTP(?: status)?[ :=]*(?:status code[ :=]*)?404\b/iu.test(text)) return true;
    current = current.cause;
  }
  return false;
}

export function releaseNotesForVersion(changelog, version) {
  if (typeof changelog !== "string" || typeof version !== "string" || version.length === 0) {
    throw new TypeError("releaseNotesForVersion requires changelog text and a version");
  }
  const lines = changelog.split(/\r?\n/u);
  const headingIndex = lines.findIndex((line) => {
    const heading = line.match(/^##[ \t]+(?:\[)?([^\] (]+)(?:\])?(?:[ \t(]|$)/u)?.[1];
    return heading === version;
  });
  if (headingIndex === -1) {
    throw new Error(`changelog has no release heading for ${version}`);
  }
  let end = lines.length;
  for (let index = headingIndex + 1; index < lines.length; index += 1) {
    if (/^##[ \t]+/u.test(lines[index])) {
      end = index;
      break;
    }
  }
  const notes = lines.slice(headingIndex + 1, end).join("\n").trim();
  return notes || `Release ${version}.`;
}

export function exactTagRefPayload(tag, headRef) {
  if (typeof tag !== "string" || tag.length === 0 || !FULL_SHA.test(headRef)) {
    throw new TypeError("exactTagRefPayload requires a tag and a full lowercase commit SHA");
  }
  return { ref: `refs/tags/${tag}`, sha: headRef };
}

export function exactReleaseMetadata({ body, headRef, product, tag, version }) {
  for (const [label, value] of Object.entries({ body, product, tag, version })) {
    if (typeof value !== "string" || value.length === 0) {
      throw new TypeError(`exactReleaseMetadata requires a non-empty ${label}`);
    }
  }
  if (!FULL_SHA.test(headRef)) {
    throw new TypeError("exactReleaseMetadata requires a full lowercase commit SHA");
  }
  return {
    body,
    name: `${product} v${version}`,
    prerelease: version.includes("-"),
    tag_name: tag,
    target_commitish: headRef,
  };
}

function assertReleaseShape(release, context = "GitHub release") {
  if (release === null || Array.isArray(release) || typeof release !== "object") {
    throw new TypeError(`${context} metadata must be an object`);
  }
  if (!Number.isSafeInteger(release.id) || release.id <= 0) {
    throw new TypeError(`${context} id must be a positive integer`);
  }
  if (typeof release.draft !== "boolean" || typeof release.prerelease !== "boolean") {
    throw new TypeError(`${context} draft and prerelease fields must be booleans`);
  }
  if (typeof release.tag_name !== "string" || release.tag_name.length === 0) {
    throw new TypeError(`${context} tag_name must be a non-empty string`);
  }
  for (const field of ["body", "name", "target_commitish"]) {
    if (release[field] !== null && typeof release[field] !== "string") {
      throw new TypeError(`${context} ${field} must be a string or null`);
    }
  }
  return release;
}

export function assertResumableReleaseMetadata(release, expected) {
  assertReleaseShape(release, "existing GitHub release");
  const conflicts = [];
  for (const field of ["tag_name", "name", "body", "prerelease", "target_commitish"]) {
    if (release[field] !== expected[field]) {
      conflicts.push(
        `${field}=${JSON.stringify(release[field])}, expected ${JSON.stringify(expected[field])}`,
      );
    }
  }
  if (conflicts.length > 0) {
    throw new Error(
      `${expected.tag_name} existing GitHub release ${release.id} conflicts with frozen release metadata: ${conflicts.join("; ")}`,
    );
  }
  return release;
}

function repositoryPath(repo) {
  if (typeof repo !== "string" || !/^[^/\s]+\/[^/\s]+$/u.test(repo)) {
    throw mutationError("GitHub repository must be OWNER/NAME");
  }
  return `repos/${repo}`;
}

function endpointSegment(value, label) {
  if (typeof value !== "string" || value.length === 0 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw mutationError(`${label} must be a non-empty printable string`);
  }
  return encodeURIComponent(value);
}

function parseJson(output, label) {
  let value;
  try {
    value = JSON.parse(output);
  } catch (error) {
    throw mutationError(`${label} returned malformed JSON`, { cause: error });
  }
  return value;
}

export function githubJsonReadSync(args, options = {}) {
  const label = options.label ?? "GitHub JSON read";
  return parseJson(runGitHubReadSync(args, { ...options, label }), label);
}

export function githubPaginatedArrayReadSync(repo, resource, options = {}) {
  const prefix = repositoryPath(repo);
  if (
    typeof resource !== "string"
    || resource.length === 0
    || !/^[A-Za-z0-9_.~%/-]+$/u.test(resource)
    || resource.startsWith("/")
    || resource.endsWith("/")
    || resource.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw mutationError("GitHub paginated resource path is malformed");
  }
  return runGitHubPaginatedJsonSync(`${prefix}/${resource}`, {
    ...options,
    itemsField: null,
    label: options.label ?? "GitHub paginated array read",
  });
}

export function githubOptionalJsonReadSync(args, options = {}) {
  try {
    return githubJsonReadSync(args, options);
  } catch (error) {
    if (isExplicitGitHubNotFound(error)) return null;
    throw error;
  }
}

export function readTagRefSync(repo, tag, options = {}) {
  const label = `GitHub tag ref ${tag}`;
  const value = githubOptionalJsonReadSync(
    ["api", `${repositoryPath(repo)}/git/ref/tags/${endpointSegment(tag, "tag")}`],
    { ...options, label },
  );
  if (value === null) return null;
  if (
    value === null
    || Array.isArray(value)
    || typeof value !== "object"
    || value.ref !== `refs/tags/${tag}`
    || value.object === null
    || Array.isArray(value.object)
    || typeof value.object !== "object"
    || typeof value.object.sha !== "string"
    || !FULL_SHA.test(value.object.sha)
    || typeof value.object.type !== "string"
  ) {
    throw mutationError(`${label} returned malformed metadata`);
  }
  return { ref: value.ref, sha: value.object.sha, type: value.object.type };
}

export function readReleaseByTagSync(repo, tag, options = {}) {
  const label = `GitHub release for tag ${tag}`;
  const value = githubOptionalJsonReadSync(
    ["api", `${repositoryPath(repo)}/releases/tags/${endpointSegment(tag, "tag")}`],
    { ...options, label },
  );
  return value === null ? null : assertReleaseShape(value, label);
}

export function readReleaseByIdSync(repo, releaseId, options = {}) {
  if (!Number.isSafeInteger(releaseId) || releaseId <= 0) {
    throw mutationError("GitHub release id must be a positive integer");
  }
  const label = `GitHub release ${releaseId}`;
  const value = githubOptionalJsonReadSync(
    ["api", `${repositoryPath(repo)}/releases/${releaseId}`],
    { ...options, label },
  );
  return value === null ? null : assertReleaseShape(value, label);
}

export function readReleaseMapSync(repo, options = {}) {
  const label = "GitHub release list";
  const releases = githubPaginatedArrayReadSync(repo, "releases", { ...options, label });
  const byTag = new Map();
  for (const release of releases) {
    assertReleaseShape(release);
    if (byTag.has(release.tag_name)) {
      throw mutationError(`GitHub returned duplicate releases for tag ${release.tag_name}`);
    }
    byTag.set(release.tag_name, release);
  }
  return byTag;
}

function assertReleaseAssetShape(asset, context) {
  if (asset === null || Array.isArray(asset) || typeof asset !== "object") {
    throw mutationError(`${context} must be an object`);
  }
  if (!Number.isSafeInteger(asset.id) || asset.id <= 0) {
    throw mutationError(`${context} id must be a positive integer`);
  }
  if (typeof asset.name !== "string" || asset.name.length === 0) {
    throw mutationError(`${context} name must be a non-empty string`);
  }
  if (!Number.isSafeInteger(asset.size) || asset.size < 0 || asset.state !== "uploaded") {
    throw mutationError(`${context} must have a non-negative size and uploaded state`);
  }
  if (
    asset.digest !== undefined
    && asset.digest !== null
    && !/^sha256:[0-9a-f]{64}$/u.test(asset.digest)
  ) {
    throw mutationError(`${context} digest is malformed`);
  }
  return asset;
}

export function readReleaseAssetsSync(repo, releaseId, options = {}) {
  if (!Number.isSafeInteger(releaseId) || releaseId <= 0) {
    throw mutationError("GitHub release id must be a positive integer");
  }
  const label = `GitHub release ${releaseId} asset list`;
  const assets = githubPaginatedArrayReadSync(repo, `releases/${releaseId}/assets`, { ...options, label });
  const byName = new Map();
  const ids = new Set();
  for (const asset of assets) {
    assertReleaseAssetShape(asset, `${label} entry`);
    if (byName.has(asset.name) || ids.has(asset.id)) {
      throw mutationError(`${label} contains a duplicate asset name or id`);
    }
    byName.set(asset.name, asset);
    ids.add(asset.id);
  }
  return byName;
}

export function createGitHubOperationBudget({
  defaultWindowMs = DEFAULT_OPERATION_WINDOW_MS,
  environment = process.env,
  now = Date.now,
} = {}) {
  if (!Number.isSafeInteger(defaultWindowMs) || defaultWindowMs <= 0) {
    throw mutationError("default GitHub operation window must be a positive integer");
  }
  const startedAtMs = now();
  const windowMs = nonNegativeInteger(
    environment,
    "OLIPHAUNT_GITHUB_MUTATION_WINDOW_MS",
    defaultWindowMs,
    { maximum: 60 * 60_000, minimum: 1 },
  );
  const reserveMs = nonNegativeInteger(
    environment,
    "OLIPHAUNT_GITHUB_HARD_DEADLINE_RESERVE_MS",
    DEFAULT_HARD_DEADLINE_RESERVE_MS,
    { maximum: 10 * 60_000 },
  );
  let deadlineMs = startedAtMs + windowMs;
  const hardDeadline = environment.REGISTRY_JOB_HARD_DEADLINE_EPOCH;
  if (hardDeadline !== undefined && hardDeadline !== "") {
    if (!/^[1-9][0-9]*$/u.test(hardDeadline)) {
      throw mutationError("REGISTRY_JOB_HARD_DEADLINE_EPOCH must be a positive Unix timestamp");
    }
    const hardDeadlineMs = Number(hardDeadline) * 1_000;
    if (!Number.isSafeInteger(hardDeadlineMs)) {
      throw mutationError("REGISTRY_JOB_HARD_DEADLINE_EPOCH exceeds the safe timestamp range");
    }
    deadlineMs = Math.min(deadlineMs, hardDeadlineMs - reserveMs);
  }
  if (deadlineMs <= startedAtMs) {
    throw mutationError("GitHub operation deadline has already expired");
  }
  return Object.freeze({ deadlineMs, environment, now, startedAtMs });
}

export function remainingGitHubReadOptions(budget, overrides = {}) {
  const remainingMs = budget.deadlineMs - budget.now();
  if (remainingMs <= 0) {
    throw mutationError("GitHub operation deadline has been reached");
  }
  const configured = githubReadOptionsFromEnv(budget.environment);
  return {
    ...overrides,
    deadlineMs: Math.max(1, Math.min(configured.deadlineMs, remainingMs)),
    environment: budget.environment,
  };
}

function mutationSettings(environment, overrides) {
  const settings = {
    attemptTimeoutMs: overrides.attemptTimeoutMs ?? nonNegativeInteger(
      environment,
      "OLIPHAUNT_GITHUB_MUTATION_ATTEMPT_TIMEOUT_MS",
      DEFAULT_MUTATION_ATTEMPT_TIMEOUT_MS,
      { maximum: 2 * 60_000, minimum: 1 },
    ),
    baseDelayMs: overrides.baseDelayMs ?? nonNegativeInteger(
      environment,
      "OLIPHAUNT_GITHUB_MUTATION_BASE_DELAY_MS",
      DEFAULT_MUTATION_BASE_DELAY_MS,
      { maximum: 30_000 },
    ),
    maxAttempts: overrides.maxAttempts ?? nonNegativeInteger(
      environment,
      "OLIPHAUNT_GITHUB_MUTATION_MAX_ATTEMPTS",
      DEFAULT_MUTATION_MAX_ATTEMPTS,
      { maximum: 5, minimum: 1 },
    ),
  };
  if (
    !Number.isSafeInteger(settings.attemptTimeoutMs)
    || settings.attemptTimeoutMs < 1
    || settings.attemptTimeoutMs > 2 * 60_000
    || !Number.isSafeInteger(settings.baseDelayMs)
    || settings.baseDelayMs < 0
    || settings.baseDelayMs > 30_000
    || !Number.isSafeInteger(settings.maxAttempts)
    || settings.maxAttempts < 1
    || settings.maxAttempts > 5
  ) {
    throw mutationError("GitHub mutation retry settings exceed their fixed safety bounds");
  }
  return settings;
}

function assertReconciliationState(state, label) {
  if (
    state === null
    || Array.isArray(state)
    || typeof state !== "object"
    || !RECONCILIATION_KINDS.has(state.kind)
  ) {
    throw mutationError(`${label}: state inspection returned an invalid reconciliation result`);
  }
  return state;
}

function reconciliationConflict(label, state, environment) {
  const detail = redactGitHubReadDetail(state.detail ?? "remote state conflicts", environment);
  return mutationError(`${label}: ${detail}`);
}

function sleepSync(milliseconds) {
  if (milliseconds <= 0) return;
  const cell = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  Atomics.wait(cell, 0, 0, milliseconds);
}

export function reconcileGitHubMutationSync({ inspect, label, mutate, options = {} }) {
  if (typeof label !== "string" || label.length === 0) {
    throw mutationError("GitHub mutation label is required");
  }
  if (typeof inspect !== "function" || typeof mutate !== "function") {
    throw mutationError(`${label}: inspect and mutate callbacks are required`);
  }
  const environment = options.environment ?? process.env;
  const now = options.now ?? options.budget?.now ?? Date.now;
  const sleep = options.sleep ?? sleepSync;
  const budget = options.budget ?? createGitHubOperationBudget({ environment, now });
  const settings = mutationSettings(environment, options);
  let mutationAttempts = 0;
  let lastMutationError = null;

  const inspectState = (phase) => {
    const remainingMs = budget.deadlineMs - now();
    if (remainingMs <= 0) {
      throw mutationError(`${label}: GitHub mutation deadline reached before ${phase}`);
    }
    return assertReconciliationState(
      inspect({ attempt: mutationAttempts, phase, remainingMs }),
      label,
    );
  };

  while (mutationAttempts < settings.maxAttempts) {
    const before = inspectState("pre-mutation reconciliation");
    if (before.kind === "desired") {
      return { mutationAttempts, recovered: mutationAttempts > 0 && lastMutationError !== null };
    }
    if (before.kind === "conflict") {
      throw reconciliationConflict(label, before, environment);
    }

    const remainingMs = budget.deadlineMs - now();
    if (remainingMs < settings.attemptTimeoutMs) {
      throw mutationError(`${label}: GitHub mutation deadline reached before attempt ${mutationAttempts + 1}`);
    }
    mutationAttempts += 1;
    lastMutationError = null;
    try {
      mutate({
        attempt: mutationAttempts,
        deadlineMs: budget.deadlineMs,
        now,
        timeoutMs: settings.attemptTimeoutMs,
      });
    } catch (error) {
      lastMutationError = error;
    }

    const after = inspectState("post-mutation reconciliation");
    if (after.kind === "desired") {
      return { mutationAttempts, recovered: lastMutationError !== null };
    }
    if (after.kind === "conflict") {
      throw reconciliationConflict(label, after, environment);
    }
    if (mutationAttempts >= settings.maxAttempts) break;

    const delayMs = settings.baseDelayMs * mutationAttempts;
    if (budget.deadlineMs - now() <= delayMs) {
      throw mutationError(`${label}: retry delay would exceed the GitHub mutation deadline`, {
        cause: lastMutationError ?? undefined,
      });
    }
    sleep(delayMs);
  }

  const detail = lastMutationError === null
    ? "mutation returned without the exact desired state becoming observable"
    : `mutation failed and exact state remained absent or unchanged: ${safeDetail(lastMutationError, environment)}`;
  throw mutationError(
    `${label}: exhausted ${mutationAttempts} mutation attempt(s); ${detail}`,
    { cause: lastMutationError ?? undefined },
  );
}

function assertExactKeys(value, expected, label) {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw mutationError(`${label} payload must be an object`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw mutationError(`${label} payload fields are not the frozen mutation shape`);
  }
}

function assertJsonMutation(endpoint, method, args, input) {
  if (
    args.length !== 6
    || args[2] !== "-X"
    || args[3] !== method
    || args[4] !== "--input"
    || args[5] !== "-"
    || typeof input !== "string"
    || Buffer.byteLength(input, "utf8") > 1024 * 1024
  ) {
    throw mutationError("GitHub JSON mutation must use one exact method and stdin payload");
  }
  let payload;
  try {
    payload = JSON.parse(input);
  } catch (error) {
    throw mutationError("GitHub JSON mutation payload is malformed", { cause: error });
  }
  if (/\/git\/refs$/u.test(endpoint)) {
    assertExactKeys(payload, ["ref", "sha"], "GitHub tag creation");
    if (!/^refs\/tags\/[^\u0000-\u001f\u007f]+$/u.test(payload.ref) || !FULL_SHA.test(payload.sha)) {
      throw mutationError("GitHub tag creation payload must bind one tag to a full lowercase commit SHA");
    }
    return;
  }
  if (/\/releases$/u.test(endpoint)) {
    assertExactKeys(
      payload,
      ["body", "draft", "name", "prerelease", "tag_name", "target_commitish"],
      "GitHub draft release creation",
    );
    if (
      payload.draft !== true
      || typeof payload.body !== "string"
      || typeof payload.name !== "string"
      || typeof payload.prerelease !== "boolean"
      || typeof payload.tag_name !== "string"
      || !FULL_SHA.test(payload.target_commitish)
    ) {
      throw mutationError("GitHub draft release payload is not exact-SHA frozen metadata");
    }
    return;
  }
  assertExactKeys(payload, ["draft"], "GitHub release promotion");
  if (payload.draft !== false) {
    throw mutationError("GitHub release promotion may only clear the draft flag");
  }
}

function assertAssetMutation(endpoint, args, input) {
  if (input !== undefined || args.length !== 12 || args[2] !== "-X" || args[3] !== "POST") {
    throw mutationError("GitHub release asset upload must use one exact-ID binary request");
  }
  let url;
  try {
    url = new URL(endpoint);
  } catch (error) {
    throw mutationError("GitHub release asset upload endpoint is malformed", { cause: error });
  }
  if (
    url.protocol !== "https:"
    || url.hostname !== "uploads.github.com"
    || !/^\/repos\/[^/\s]+\/[^/\s]+\/releases\/[1-9][0-9]*\/assets$/u.test(url.pathname)
    || [...url.searchParams.keys()].length !== 1
    || !url.searchParams.has("name")
  ) {
    throw mutationError("GitHub release asset upload must target one canonical exact release id");
  }
  const expectedHeaders = new Set([
    "Accept: application/vnd.github+json",
    "Content-Type: application/octet-stream",
    "X-GitHub-Api-Version: 2022-11-28",
  ]);
  const headers = [];
  for (let index = 4; index < 10; index += 2) {
    if (args[index] !== "-H") {
      throw mutationError("GitHub release asset upload headers are not the frozen request shape");
    }
    headers.push(args[index + 1]);
  }
  if (headers.length !== expectedHeaders.size || headers.some((header) => !expectedHeaders.has(header))) {
    throw mutationError("GitHub release asset upload headers are not the frozen request shape");
  }
  const file = args[10] === "--input" ? args[11] : "";
  const assetName = url.searchParams.get("name");
  if (
    typeof assetName !== "string"
    || assetName.length === 0
    || /[\/\\\u0000-\u001f\u007f]/u.test(assetName)
    || typeof file !== "string"
    || file.length === 0
    || file.split(/[\\/]/u).at(-1) !== assetName
  ) {
    throw mutationError("GitHub release asset input must retain its frozen safe asset name");
  }
}

function assertMutationArgs(args, input) {
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
    throw mutationError("GitHub mutation requires gh arguments");
  }
  if (args[0] !== "api") {
    throw mutationError("GitHub mutation helper only permits an exact GitHub API release mutation");
  }
  const endpoint = args[1];
  if (typeof endpoint !== "string") {
    throw mutationError("GitHub API mutation endpoint is required");
  }
  if (endpoint.startsWith("https://uploads.github.com/")) {
    assertAssetMutation(endpoint, args, input);
    return;
  }
  const tagCreate = /^repos\/[^/\s]+\/[^/\s]+\/git\/refs$/u.test(endpoint);
  const releaseCreate = /^repos\/[^/\s]+\/[^/\s]+\/releases$/u.test(endpoint);
  const releasePromote = /^repos\/[^/\s]+\/[^/\s]+\/releases\/[1-9][0-9]*$/u.test(endpoint);
  if (!tagCreate && !releaseCreate && !releasePromote) {
    throw mutationError("GitHub API mutation endpoint is outside the frozen release allowlist");
  }
  assertJsonMutation(endpoint, releasePromote ? "PATCH" : "POST", args, input);
}

export function runGitHubMutationSync(args, options = {}) {
  assertMutationArgs(args, options.input);
  if (
    options.assertMutationAllowed !== undefined
    && typeof options.assertMutationAllowed !== "function"
  ) {
    throw mutationError("GitHub mutation abort guard must be a function");
  }
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) {
    throw mutationError("GitHub mutation timeout must be a positive integer");
  }
  const environment = options.environment ?? process.env;
  const spawn = options.spawn ?? spawnSync;
  const now = options.now ?? options.pacerOptions?.now ?? Date.now;
  if (
    options.deadlineMs !== undefined
    && (!Number.isSafeInteger(options.deadlineMs) || options.deadlineMs <= 0)
  ) {
    throw mutationError("GitHub mutation deadline must be a positive absolute timestamp");
  }
  reserveGitHubContentWriteSync({
    environment,
    label: options.pacerLabel ?? (
      String(args[1]).startsWith("https://uploads.github.com/")
        ? "GitHub release asset upload"
        : `GitHub release ${args[2] === "-X" ? args[3] : "mutation"}`
    ),
    ...(options.pacerOptions ?? {}),
  });
  options.assertMutationAllowed?.();
  if (options.deadlineMs !== undefined) {
    const remainingAfterPacingMs = options.deadlineMs - now();
    if (remainingAfterPacingMs < options.timeoutMs) {
      throw mutationError(
        `GitHub mutation requires its complete ${options.timeoutMs}ms transport timeout after pacing; `
          + `${Math.max(0, remainingAfterPacingMs)}ms remains`,
      );
    }
  }
  reserveGitHubCoreRequestSync({
    environment,
    label: options.coreRequestLabel ?? "GitHub release mutation",
    ...(options.coreJournalOptions ?? {}),
  });
  // Recheck after the independently locked request journal so a peer failure
  // observed while this worker waited cannot leak a new mutation transport.
  options.assertMutationAllowed?.();
  if (options.deadlineMs !== undefined) {
    const remainingAfterJournalMs = options.deadlineMs - now();
    if (remainingAfterJournalMs < options.timeoutMs) {
      throw mutationError(
        `GitHub mutation requires its complete ${options.timeoutMs}ms transport timeout after request-journal admission; `
          + `${Math.max(0, remainingAfterJournalMs)}ms remains`,
      );
    }
  }
  const result = spawn("gh", args, {
    cwd: options.cwd,
    encoding: "utf8",
    env: environment,
    input: options.input,
    maxBuffer: options.maxBuffer ?? MAX_MUTATION_CAPTURE_BYTES,
    stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    // Pacing is admission time, not request execution time. The request keeps
    // its complete bounded transport timeout after the reserved slot opens.
    timeout: options.timeoutMs,
    windowsHide: true,
  });
  if (result.error !== undefined) {
    const error = mutationError("GitHub CLI could not complete the mutation");
    error.code = result.error.code;
    error.detail = result.error.message;
    throw error;
  }
  if (result.status !== 0) {
    const error = mutationError(`GitHub mutation exited with status ${result.status}`);
    error.status = result.status;
    error.detail = String(result.stderr ?? "");
    throw error;
  }
  return result.stdout ?? "";
}
