#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { reserveGitHubCoreRequestSync } from "./github-core-request-journal.mjs";

const DEFAULTS = Object.freeze({
  attemptTimeoutMs: 45_000,
  baseDelayMs: 750,
  deadlineMs: 180_000,
  maxAttempts: 4,
  maxDelayMs: 8_000,
});
const MAX_CAPTURE_BYTES = 128 * 1024 * 1024;
const GITHUB_PAGINATION_PAGE_SIZE = 100;
const GITHUB_PAGINATION_MAX_PAGES = 1_000;
const INTEGER = /^(?:0|[1-9][0-9]*)$/u;
const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
const RETRYABLE_TEXT = [
  /connection (?:closed|refused|reset|timed out)/iu,
  /could not resolve host/iu,
  /econn(?:refused|reset)/iu,
  /http (?:408|409|425|429|5[0-9]{2})\b/iu,
  /i\/o timeout/iu,
  /rate limit/iu,
  /remote end closed/iu,
  /socket hang up/iu,
  /temporary failure/iu,
  /tls handshake timeout/iu,
  /unexpected eof/iu,
];
const PERMANENT_TEXT = [
  /bad credentials/iu,
  /http (?:400|401|404|405|410|422)\b/iu,
  /not found/iu,
  /permission denied/iu,
  /requires authentication/iu,
  /resource not accessible by integration/iu,
  /unknown (?:command|flag)/iu,
  /usage:/iu,
];

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export class GitHubReadError extends Error {
  constructor(message, { attempts = 0, cause = undefined, deadlineExhausted = false, retryable = false } = {}) {
    super(message, { cause });
    this.name = "GitHubReadError";
    this.attempts = attempts;
    this.deadlineExhausted = deadlineExhausted;
    this.retryable = retryable;
  }
}

export class RetryableReadError extends Error {
  constructor(message, { cause = undefined } = {}) {
    super(message, { cause });
    this.name = "RetryableReadError";
    this.retryable = true;
  }
}

function integerSetting(environment, name, fallback, { maximum = Number.MAX_SAFE_INTEGER, minimum = 0 } = {}) {
  const raw = environment[name];
  if (raw === undefined || raw === "") return fallback;
  if (!INTEGER.test(raw)) {
    throw new GitHubReadError(`${name} must be an integer`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new GitHubReadError(`${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

export function githubReadOptionsFromEnv(environment = process.env, overrides = {}) {
  const result = {
    attemptTimeoutMs: integerSetting(
      environment,
      "OLIPHAUNT_GITHUB_READ_ATTEMPT_TIMEOUT_MS",
      DEFAULTS.attemptTimeoutMs,
      { maximum: 10 * 60_000, minimum: 1 },
    ),
    baseDelayMs: integerSetting(
      environment,
      "OLIPHAUNT_GITHUB_READ_BASE_DELAY_MS",
      DEFAULTS.baseDelayMs,
      { maximum: 30_000 },
    ),
    deadlineMs: integerSetting(
      environment,
      "OLIPHAUNT_GITHUB_READ_DEADLINE_MS",
      DEFAULTS.deadlineMs,
      { maximum: 60 * 60_000, minimum: 1 },
    ),
    maxAttempts: integerSetting(
      environment,
      "OLIPHAUNT_GITHUB_READ_MAX_ATTEMPTS",
      DEFAULTS.maxAttempts,
      { maximum: 10, minimum: 1 },
    ),
    maxDelayMs: integerSetting(
      environment,
      "OLIPHAUNT_GITHUB_READ_MAX_DELAY_MS",
      DEFAULTS.maxDelayMs,
      { maximum: 60_000 },
    ),
    ...overrides,
  };
  for (const [name, value, minimum, maximum] of [
    ["attemptTimeoutMs", result.attemptTimeoutMs, 1, 10 * 60_000],
    ["baseDelayMs", result.baseDelayMs, 0, 30_000],
    ["deadlineMs", result.deadlineMs, 1, 60 * 60_000],
    ["maxAttempts", result.maxAttempts, 1, 10],
    ["maxDelayMs", result.maxDelayMs, 0, 60_000],
  ]) {
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
      throw new GitHubReadError(`${name} must be between ${minimum} and ${maximum}`);
    }
  }
  if (result.maxDelayMs < result.baseDelayMs) {
    throw new GitHubReadError(
      "OLIPHAUNT_GITHUB_READ_MAX_DELAY_MS must be at least OLIPHAUNT_GITHUB_READ_BASE_DELAY_MS",
    );
  }
  return result;
}

function sleepSync(milliseconds) {
  if (milliseconds <= 0) return;
  const cell = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  Atomics.wait(cell, 0, 0, milliseconds);
}

function renderedError(error) {
  if (error instanceof Error) {
    const detail = error.detail ? `${error.message}\n${error.detail}` : error.message;
    return detail;
  }
  return String(error);
}

export function redactGitHubReadDetail(value, environment = process.env) {
  let result = String(value ?? "");
  for (const name of ["GH_TOKEN", "GITHUB_TOKEN"]) {
    const secret = environment[name];
    if (secret) result = result.split(secret).join("<redacted>");
  }
  result = result
    .replace(/(authorization\s*:\s*)(?:bearer|token)\s+[^\s]+/giu, "$1<redacted>")
    .replace(/([?&](?:access_?token|auth|token)=)[^&#\s]+/giu, "$1<redacted>")
    .replace(/https:\/\/[^/@\s]+@/giu, "https://<redacted>@")
    .replace(/\b(?:gh[opusr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/gu, "<redacted>")
    .trim();
  if (result.length > 800) result = `${result.slice(0, 797)}...`;
  return result;
}

function statusFromText(text) {
  const match = /(?:http(?: status)?|status code)\s*[:=]?\s*([1-5][0-9]{2})\b/iu.exec(text);
  return match ? Number(match[1]) : undefined;
}

export function isRetryableGitHubReadError(error) {
  if (typeof error?.retryable === "boolean") return error.retryable;
  if (["ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "EAI_AGAIN"].includes(error?.code)) return true;
  if ([2, 126, 127].includes(error?.status)) return false;
  const text = renderedError(error);
  const status = error?.httpStatus ?? statusFromText(text);
  if (status !== undefined) {
    if (status === 403 && /(?:abuse|rate limit|secondary rate)/iu.test(text)) return true;
    if (RETRYABLE_STATUS.has(status)) return true;
    if (status >= 400 && status < 500) return false;
  }
  if (PERMANENT_TEXT.some((pattern) => pattern.test(text))) return false;
  if (RETRYABLE_TEXT.some((pattern) => pattern.test(text))) return true;
  // Reads are idempotent. Unknown transport/CLI exit-1 failures are retried inside the fixed budget.
  return true;
}

function retryDelay(attempt, { baseDelayMs, maxDelayMs, random }) {
  const exponential = Math.min(maxDelayMs, baseDelayMs * (2 ** Math.max(0, attempt - 1)));
  const jitter = 0.8 + (Math.max(0, Math.min(1, random())) * 0.4);
  return Math.round(exponential * jitter);
}

export function retryReadOperationSync(label, operation, options = {}) {
  if (typeof label !== "string" || label.trim() === "") {
    throw new GitHubReadError("GitHub read label is required");
  }
  if (typeof operation !== "function") {
    throw new GitHubReadError(`${label}: read operation must be a function`);
  }
  const settings = githubReadOptionsFromEnv(options.environment ?? process.env, options);
  const now = settings.now ?? Date.now;
  const random = settings.random ?? Math.random;
  const sleep = settings.sleep ?? sleepSync;
  const classify = settings.classify ?? isRetryableGitHubReadError;
  const onRetry = settings.onRetry ?? (() => {});
  const startedAt = now();
  const deadline = startedAt + settings.deadlineMs;
  let attempts = 0;
  let lastError;

  while (attempts < settings.maxAttempts) {
    const remainingMs = deadline - now();
    if (remainingMs <= 0) {
      throw new GitHubReadError(`${label}: overall deadline exhausted after ${attempts} attempt(s)`, {
        attempts,
        cause: lastError,
        deadlineExhausted: true,
        retryable: true,
      });
    }
    attempts += 1;
    try {
      return operation({
        attempt: attempts,
        attemptTimeoutMs: Math.max(1, Math.min(settings.attemptTimeoutMs, remainingMs)),
        deadlineMs: deadline,
        remainingMs,
        remainingTimeMs: () => deadline - now(),
      });
    } catch (error) {
      lastError = error;
      const retryable = classify(error);
      const safeDetail = redactGitHubReadDetail(renderedError(error), settings.environment);
      if (!retryable) {
        throw new GitHubReadError(
          `${label}: permanent read failure on attempt ${attempts}${safeDetail ? `: ${safeDetail}` : ""}`,
          { attempts, cause: error, retryable: false },
        );
      }
      if (error?.deadlineExhausted === true) {
        throw new GitHubReadError(`${label}: overall deadline exhausted after ${attempts} attempt(s)`, {
          attempts,
          cause: error,
          deadlineExhausted: true,
          retryable: true,
        });
      }
      if (attempts >= settings.maxAttempts) {
        throw new GitHubReadError(
          `${label}: retry budget exhausted after ${attempts} attempt(s)${safeDetail ? `: ${safeDetail}` : ""}`,
          { attempts, cause: error, retryable: true },
        );
      }
      const delay = retryDelay(attempts, { ...settings, random });
      const beforeSleepRemaining = deadline - now();
      if (beforeSleepRemaining <= delay) {
        throw new GitHubReadError(`${label}: overall deadline exhausted after ${attempts} attempt(s)`, {
          attempts,
          cause: error,
          deadlineExhausted: true,
          retryable: true,
        });
      }
      onRetry({ attempt: attempts, delayMs: delay, error, label });
      sleep(delay);
    }
  }
  throw new GitHubReadError(`${label}: retry budget exhausted`, {
    attempts,
    cause: lastError,
    retryable: true,
  });
}

function ensureSafeApiReadArgs(args) {
  let endpoint = null;
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--include") continue;
    if (arg === "--paginate" || arg === "--slurp") {
      throw new GitHubReadError(
        `GitHub read helper refuses opaque ${arg} requests; use the journal-aware pagination helper`,
      );
    }
    if (arg === "--jq" || arg === "-q" || arg === "--header" || arg === "-H") {
      const value = args[index + 1];
      if (value === undefined) {
        throw new GitHubReadError(`GitHub API read flag ${arg} requires a value`);
      }
      if (arg === "--header" || arg === "-H") {
        if (!new Set([
          "Accept: application/octet-stream",
          "Accept: application/vnd.github+json",
          "X-GitHub-Api-Version: 2022-11-28",
        ]).has(value)) {
          throw new GitHubReadError("GitHub API read helper refuses non-canonical headers");
        }
      }
      index += 1;
      continue;
    }
    if (arg.startsWith("--jq=") || arg.startsWith("-q=")) continue;
    if (arg.startsWith("-")) {
      throw new GitHubReadError(`GitHub API read helper refuses unsupported flag ${arg}`);
    }
    if (endpoint !== null) {
      throw new GitHubReadError("GitHub API read helper requires exactly one endpoint");
    }
    endpoint = arg;
  }
  if (endpoint === null) {
    throw new GitHubReadError("GitHub API read helper requires exactly one endpoint");
  }
  const relative = endpoint.startsWith("repos/")
    ? endpoint
    : endpoint.startsWith("https://api.github.com/repos/")
      ? endpoint.slice("https://api.github.com/".length)
      : null;
  if (
    relative === null
    || !/^repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:[/?][^\s\\\u0000-\u001f\u007f]*)?$/u.test(relative)
  ) {
    throw new GitHubReadError("GitHub API read endpoint is outside the repository allowlist");
  }
  let decoded;
  try {
    decoded = decodeURIComponent(relative.split("?", 1)[0]);
  } catch (error) {
    throw new GitHubReadError("GitHub API read endpoint contains malformed encoding", { cause: error });
  }
  if (decoded.split("/").some((segment) => segment === "." || segment === "..")) {
    throw new GitHubReadError("GitHub API read endpoint contains a traversal segment");
  }
}

function ensureReadOnlyGhArgs(args) {
  if (!Array.isArray(args) || args.length < 2 || args.some((arg) => typeof arg !== "string")) {
    throw new GitHubReadError("GitHub read command requires gh arguments");
  }
  const [group, verb] = args;
  if (group === "api") {
    const mutationFlags = /^(?:--field(?:=|$)|--input(?:=|$)|--method(?:=|$)|--raw-field(?:=|$)|-[FfX](?:.|$))/u;
    if (args.some((arg) => mutationFlags.test(arg))) {
      throw new GitHubReadError("GitHub read helper refuses API mutation arguments");
    }
    if (verb === "graphql") {
      throw new GitHubReadError("GitHub read helper refuses implicit POST GraphQL requests");
    }
    ensureSafeApiReadArgs(args);
    return;
  }
  const allowed = new Set(["release:download", "release:view", "run:download", "run:list", "run:view"]);
  if (!allowed.has(`${group}:${verb}`)) {
    throw new GitHubReadError(`GitHub read helper refuses non-read command gh ${group} ${verb}`);
  }
  if (args.some((arg) => /^(?:--hostname|--web)(?:=|$)/u.test(arg))) {
    throw new GitHubReadError("GitHub read helper refuses alternate hosts and browser side effects");
  }
}

class CommandReadError extends Error {
  constructor(message, { code, detail, httpStatus, retryable, status } = {}) {
    super(message);
    this.name = "CommandReadError";
    this.code = code;
    this.detail = detail;
    this.httpStatus = httpStatus;
    this.retryable = retryable;
    this.status = status;
  }
}

function runGitHubCommandReadSync(args, options = {}) {
  const environment = options.environment ?? process.env;
  const spawn = options.spawn ?? spawnSync;
  const label = options.label ?? `GitHub ${args[0]} ${args[1]} read`;
  const binary = options.binary === true;
  const maxBuffer = options.maxBuffer ?? MAX_CAPTURE_BYTES;
  if (!Number.isSafeInteger(maxBuffer) || maxBuffer < 1 || maxBuffer > MAX_CAPTURE_BYTES) {
    throw new GitHubReadError(`GitHub read maxBuffer must be between 1 and ${MAX_CAPTURE_BYTES}`);
  }
  return retryReadOperationSync(
    label,
    ({ attemptTimeoutMs, remainingTimeMs }) => {
      reserveGitHubCoreRequestSync({
        environment,
        label: `${label} attempt`,
        ...(options.coreJournalOptions ?? {}),
      });
      const remainingAfterJournalMs = remainingTimeMs();
      if (remainingAfterJournalMs <= 0) {
        const error = new RetryableReadError(
          `${label}: overall deadline exhausted during request-journal admission`,
        );
        error.deadlineExhausted = true;
        throw error;
      }
      const transportTimeoutMs = Math.max(1, Math.min(attemptTimeoutMs, remainingAfterJournalMs));
      const result = spawn("gh", args, {
        cwd: options.cwd,
        encoding: binary ? null : "utf8",
        env: environment,
        maxBuffer,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: transportTimeoutMs,
        windowsHide: true,
      });
      if (result.error) {
        throw new CommandReadError("GitHub CLI could not complete the read", {
          code: result.error.code,
          detail: result.error.message,
          status: result.status,
        });
      }
      if (result.status !== 0) {
        const stderr = Buffer.isBuffer(result.stderr)
          ? result.stderr.toString("utf8")
          : String(result.stderr ?? "");
        throw new CommandReadError("GitHub CLI read failed", {
          detail: stderr,
          status: result.status,
        });
      }
      return result.stdout ?? (binary ? Buffer.alloc(0) : "");
    },
    { ...options, environment },
  );
}

export function runGitHubReadSync(args, options = {}) {
  ensureReadOnlyGhArgs(args);
  return runGitHubCommandReadSync(args, options);
}

function assertSafeGraphqlQuery(document) {
  if (typeof document !== "string" || document.length === 0 || document.length > 32 * 1024) {
    throw new GitHubReadError("GitHub GraphQL read requires one bounded query document");
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(document)) {
    throw new GitHubReadError("GitHub GraphQL query contains unsupported control characters");
  }
  const normalized = document.trim();
  const operations = [...normalized.matchAll(/\b(query|mutation|subscription)\b/gu)];
  if (
    operations.length !== 1
    || operations[0][1] !== "query"
    || !/^query\s+[A-Za-z_][A-Za-z0-9_]*(?:\s*\([^)]*\))?\s*\{[\s\S]*\}$/u.test(normalized)
    || /["'`#]/u.test(normalized)
  ) {
    throw new GitHubReadError("GitHub GraphQL read requires exactly one named query operation");
  }
  let depth = 0;
  for (const character of normalized) {
    if (character === "{") depth += 1;
    else if (character === "}") depth -= 1;
    if (depth < 0) break;
  }
  if (depth !== 0) {
    throw new GitHubReadError("GitHub GraphQL query has unbalanced selection braces");
  }
}

function graphqlVariableArguments(variables) {
  if (
    variables === null
    || typeof variables !== "object"
    || Array.isArray(variables)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(variables))
  ) {
    throw new GitHubReadError("GitHub GraphQL variables must be a plain object");
  }
  const args = [];
  for (const name of Object.keys(variables).sort()) {
    const value = variables[name];
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) {
      throw new GitHubReadError(`GitHub GraphQL variable name is invalid: ${name}`);
    }
    if (
      typeof value !== "string"
      || value.length > 4_096
      || /[\u0000-\u001f\u007f]/u.test(value)
    ) {
      throw new GitHubReadError(`GitHub GraphQL variable ${name} must be a bounded printable string`);
    }
    args.push("-f", `${name}=${value}`);
  }
  return args;
}

export function runGitHubGraphqlReadSync(document, variables = {}, options = {}) {
  assertSafeGraphqlQuery(document);
  const variableArgs = graphqlVariableArguments(variables);
  return runGitHubCommandReadSync(
    ["api", "graphql", "-f", `query=${document}`, ...variableArgs],
    { ...options, label: options.label ?? "GitHub GraphQL read" },
  );
}

function parseIncludedGithubJson(output, label) {
  if (typeof output !== "string") {
    throw new GitHubReadError(`${label} returned a non-text included response`);
  }
  const boundary = /\r?\n\r?\n/u.exec(output);
  if (boundary === null || boundary.index === 0) {
    throw new GitHubReadError(`${label} did not include one HTTP response header block`);
  }
  const headerBlock = output.slice(0, boundary.index);
  const body = output.slice(boundary.index + boundary[0].length);
  const lines = headerBlock.split(/\r?\n/u);
  if (!/^HTTP\/(?:1[.][01]|2(?:[.]0)?|3(?:[.]0)?) 200(?:\s|$)/u.test(lines[0] ?? "")) {
    throw new GitHubReadError(`${label} did not include an HTTP 200 status line`);
  }
  const headers = new Map();
  for (const line of lines.slice(1)) {
    if (/^[ \t]/u.test(line)) {
      throw new GitHubReadError(`${label} returned an obsolete folded HTTP header`);
    }
    const separator = line.indexOf(":");
    if (separator <= 0) throw new GitHubReadError(`${label} returned a malformed HTTP header`);
    const name = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (!/^[a-z0-9-]+$/u.test(name) || /[\u0000-\u001f\u007f]/u.test(value)) {
      throw new GitHubReadError(`${label} returned a malformed HTTP header`);
    }
    headers.set(name, headers.has(name) ? `${headers.get(name)}, ${value}` : value);
  }
  let data;
  try {
    data = JSON.parse(body);
  } catch (cause) {
    throw new GitHubReadError(`${label} returned malformed JSON`, { cause });
  }
  return { data, link: headers.get("link") ?? "" };
}

function parseGithubPaginationLinks(value, label) {
  if (value === "") return new Map();
  const links = new Map();
  for (const rawEntry of value.split(/,\s*(?=<)/u)) {
    const match = /^<([^<>]+)>;\s*rel="(first|last|next|prev)"$/u.exec(rawEntry.trim());
    if (match === null || links.has(match[2])) {
      throw new GitHubReadError(`${label} returned a malformed or duplicate pagination Link relation`);
    }
    links.set(match[2], match[1]);
  }
  return links;
}

function escapedRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function exactQueryEntries(url, label) {
  const entries = [...url.searchParams.entries()];
  if (new Set(entries.map(([name]) => name)).size !== entries.length) {
    throw new GitHubReadError(`${label} contains a duplicate query parameter`);
  }
  return entries.sort(([leftName, leftValue], [rightName, rightValue]) =>
    compareText(leftName, rightName) || compareText(leftValue, rightValue));
}

function paginationEndpoint(endpoint) {
  if (typeof endpoint !== "string" || !endpoint.startsWith("repos/")) {
    throw new GitHubReadError("journal-aware pagination requires a repository API endpoint");
  }
  ensureSafeApiReadArgs(["api", endpoint]);
  const url = new URL(endpoint, "https://api.github.com/");
  if (url.origin !== "https://api.github.com" || url.hash !== "") {
    throw new GitHubReadError("journal-aware pagination requires the canonical GitHub API origin");
  }
  const match = /^\/repos\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/(.+)$/u.exec(url.pathname);
  if (match === null || match[3].endsWith("/")) {
    throw new GitHubReadError("journal-aware pagination endpoint must name one repository resource");
  }
  const fixedQuery = exactQueryEntries(url, "journal-aware pagination endpoint");
  if (fixedQuery.some(([name]) => name === "page" || name === "per_page")) {
    throw new GitHubReadError("journal-aware pagination owns the page and per_page parameters");
  }
  return {
    fixedQuery,
    owner: match[1],
    repo: match[2],
    requestedPath: url.pathname,
    resource: match[3],
  };
}

function validateGithubPaginationLink(rawUrl, expected, relation, currentPage, canonicalRepositoryPath) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch (cause) {
    throw new GitHubReadError(`${expected.label} returned a malformed pagination URL`, { cause });
  }
  if (
    url.protocol !== "https:"
    || url.hostname !== "api.github.com"
    || url.port !== ""
    || url.username !== ""
    || url.password !== ""
    || url.hash !== ""
  ) {
    throw new GitHubReadError(`${expected.label} pagination URL must use the canonical GitHub API origin`);
  }
  const canonicalMatch = new RegExp(
    `^/repositories/([1-9][0-9]*)/${escapedRegex(expected.resource)}$`,
    "u",
  ).exec(url.pathname);
  if (url.pathname !== expected.requestedPath && canonicalMatch === null) {
    throw new GitHubReadError(`${expected.label} pagination URL changed repository or endpoint`);
  }
  let nextCanonicalPath = canonicalRepositoryPath;
  if (canonicalMatch !== null) {
    if (canonicalRepositoryPath !== null && url.pathname !== canonicalRepositoryPath) {
      throw new GitHubReadError(`${expected.label} pagination URL changed canonical repository identity`);
    }
    nextCanonicalPath = url.pathname;
  }
  const pageValue = url.searchParams.get("page");
  if (!/^[1-9][0-9]*$/u.test(pageValue ?? "")) {
    throw new GitHubReadError(`${expected.label} pagination URL has an invalid page number`);
  }
  const linkedPage = Number(pageValue);
  if (!Number.isSafeInteger(linkedPage)) {
    throw new GitHubReadError(`${expected.label} pagination page exceeds the safe integer range`);
  }
  const wantedPage = relation === "next"
    ? currentPage + 1
    : relation === "prev"
      ? currentPage - 1
      : relation === "first"
        ? 1
        : linkedPage;
  if (linkedPage !== wantedPage || (relation === "last" && linkedPage < currentPage)) {
    throw new GitHubReadError(`${expected.label} returned a non-canonical ${relation} page number`);
  }
  const actualQuery = exactQueryEntries(url, `${expected.label} pagination URL`);
  const expectedQuery = [
    ...expected.fixedQuery,
    ["page", String(linkedPage)],
    ["per_page", String(GITHUB_PAGINATION_PAGE_SIZE)],
  ].sort(([leftName, leftValue], [rightName, rightValue]) =>
    compareText(leftName, rightName) || compareText(leftValue, rightValue));
  if (JSON.stringify(actualQuery) !== JSON.stringify(expectedQuery)) {
    throw new GitHubReadError(`${expected.label} pagination URL changed the exact page query`);
  }
  return nextCanonicalPath;
}

export function runGitHubPaginatedJsonSync(endpoint, options = {}) {
  const expected = paginationEndpoint(endpoint);
  const label = options.label ?? "GitHub paginated JSON read";
  const itemsField = options.itemsField ?? null;
  const maxPages = options.maxPages ?? GITHUB_PAGINATION_MAX_PAGES;
  if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > GITHUB_PAGINATION_MAX_PAGES) {
    throw new GitHubReadError(`paginated JSON maxPages must be between 1 and ${GITHUB_PAGINATION_MAX_PAGES}`);
  }
  if (itemsField !== null && (typeof itemsField !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(itemsField))) {
    throw new GitHubReadError("paginated JSON itemsField must be null or a safe object field name");
  }
  const rows = [];
  let canonicalRepositoryPath = null;
  for (let page = 1; page <= maxPages; page += 1) {
    const query = new URLSearchParams(expected.fixedQuery);
    query.set("per_page", String(GITHUB_PAGINATION_PAGE_SIZE));
    query.set("page", String(page));
    const pageEndpoint = `${expected.requestedPath.slice(1)}?${query.toString()}`;
    const pageLabel = `${label} page ${page}`;
    const { data, link } = parseIncludedGithubJson(
      runGitHubReadSync(["api", "--include", pageEndpoint], { ...options, label: pageLabel }),
      pageLabel,
    );
    const pageRows = itemsField === null
      ? data
      : data !== null && !Array.isArray(data) && typeof data === "object"
        ? data[itemsField]
        : undefined;
    if (!Array.isArray(pageRows) || pageRows.length > GITHUB_PAGINATION_PAGE_SIZE) {
      throw new GitHubReadError(
        `${pageLabel} must contain an array of at most ${GITHUB_PAGINATION_PAGE_SIZE} rows`
          + (itemsField === null ? "" : ` in ${itemsField}`),
      );
    }
    rows.push(...pageRows);
    const links = parseGithubPaginationLinks(link, pageLabel);
    for (const [relation, rawUrl] of links) {
      canonicalRepositoryPath = validateGithubPaginationLink(
        rawUrl,
        { ...expected, label: pageLabel },
        relation,
        page,
        canonicalRepositoryPath,
      );
    }
    if (!links.has("next")) return rows;
    if (pageRows.length !== GITHUB_PAGINATION_PAGE_SIZE) {
      throw new GitHubReadError(`${pageLabel} advertised a next page after only ${pageRows.length} rows`);
    }
  }
  throw new GitHubReadError(`${label} exceeds ${maxPages} pages`);
}

function cli(argv) {
  let label = "GitHub CLI read";
  let binary = false;
  let paginateField;
  let index = 0;
  while (index < argv.length && argv[index] !== "--" && argv[index].startsWith("--")) {
    if (argv[index] === "--label") {
      label = argv[index + 1] ?? "";
      index += 2;
    } else if (argv[index] === "--binary") {
      binary = true;
      index += 1;
    } else if (argv[index] === "--paginate-field") {
      paginateField = argv[index + 1];
      if (paginateField === undefined || paginateField === "") {
        throw new GitHubReadError("--paginate-field requires a field name or - for a top-level array");
      }
      index += 2;
    } else {
      throw new GitHubReadError(`unknown github-read option: ${argv[index]}`);
    }
  }
  if (argv[index] === "--") index += 1;
  if (paginateField !== undefined) {
    if (binary || argv.length - index !== 1) {
      throw new GitHubReadError("journal-aware pagination requires exactly one non-binary API endpoint");
    }
    const output = runGitHubPaginatedJsonSync(argv[index], {
      itemsField: paginateField === "-" ? null : paginateField,
      label,
    });
    process.stdout.write(`${JSON.stringify(output)}\n`);
    return;
  }
  const output = runGitHubReadSync(argv.slice(index), {
    binary,
    label,
    onRetry: ({ attempt, delayMs }) => {
      console.error(`${label}: transient failure after attempt ${attempt}; retrying in ${delayMs}ms`);
    },
  });
  process.stdout.write(output);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    cli(process.argv.slice(2));
  } catch (error) {
    console.error(redactGitHubReadDetail(error instanceof Error ? error.message : String(error)));
    process.exit(error?.retryable ? 75 : 64);
  }
}
