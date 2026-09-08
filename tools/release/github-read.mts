#!/usr/bin/env node

import path from 'node:path';
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { reserveGitHubCoreRequest } from './github-core-request-journal.mts';

const DEFAULTS = Object.freeze({
  attemptTimeoutMs: 45_000,
  baseDelayMs: 750,
  deadlineMs: 180_000,
  maxAttempts: 4,
  maxDelayMs: 8_000,
});
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
  constructor(
    message,
    { attempts = 0, cause = undefined, deadlineExhausted = false, retryable = false } = {},
  ) {
    super(message, { cause });
    this.name = 'GitHubReadError';
    this.attempts = attempts;
    this.deadlineExhausted = deadlineExhausted;
    this.retryable = retryable;
  }
}

export class RetryableReadError extends Error {
  constructor(message, { cause = undefined } = {}) {
    super(message, { cause });
    this.name = 'RetryableReadError';
    this.retryable = true;
  }
}

function integerSetting(
  environment,
  name,
  fallback,
  { maximum = Number.MAX_SAFE_INTEGER, minimum = 0 } = {},
) {
  const raw = environment[name];
  if (raw === undefined || raw === '') return fallback;
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
      'OLIPHAUNT_GITHUB_READ_ATTEMPT_TIMEOUT_MS',
      DEFAULTS.attemptTimeoutMs,
      { maximum: 10 * 60_000, minimum: 1 },
    ),
    baseDelayMs: integerSetting(
      environment,
      'OLIPHAUNT_GITHUB_READ_BASE_DELAY_MS',
      DEFAULTS.baseDelayMs,
      { maximum: 30_000 },
    ),
    deadlineMs: integerSetting(
      environment,
      'OLIPHAUNT_GITHUB_READ_DEADLINE_MS',
      DEFAULTS.deadlineMs,
      { maximum: 60 * 60_000, minimum: 1 },
    ),
    maxAttempts: integerSetting(
      environment,
      'OLIPHAUNT_GITHUB_READ_MAX_ATTEMPTS',
      DEFAULTS.maxAttempts,
      { maximum: 10, minimum: 1 },
    ),
    maxDelayMs: integerSetting(
      environment,
      'OLIPHAUNT_GITHUB_READ_MAX_DELAY_MS',
      DEFAULTS.maxDelayMs,
      { maximum: 60_000 },
    ),
    ...overrides,
  };
  for (const [name, value, minimum, maximum] of [
    ['attemptTimeoutMs', result.attemptTimeoutMs, 1, 10 * 60_000],
    ['baseDelayMs', result.baseDelayMs, 0, 30_000],
    ['deadlineMs', result.deadlineMs, 1, 60 * 60_000],
    ['maxAttempts', result.maxAttempts, 1, 10],
    ['maxDelayMs', result.maxDelayMs, 0, 60_000],
  ]) {
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
      throw new GitHubReadError(`${name} must be between ${minimum} and ${maximum}`);
    }
  }
  if (result.maxDelayMs < result.baseDelayMs) {
    throw new GitHubReadError(
      'OLIPHAUNT_GITHUB_READ_MAX_DELAY_MS must be at least OLIPHAUNT_GITHUB_READ_BASE_DELAY_MS',
    );
  }
  return result;
}

function renderedError(error) {
  if (error instanceof Error) {
    const detail = error.detail ? `${error.message}\n${error.detail}` : error.message;
    return detail;
  }
  return String(error);
}

export function redactGitHubReadDetail(value, environment = process.env) {
  let result = String(value ?? '');
  for (const name of ['GH_TOKEN', 'GITHUB_TOKEN']) {
    const secret = environment[name];
    if (secret) result = result.split(secret).join('<redacted>');
  }
  result = result
    .replace(/(authorization\s*:\s*)(?:bearer|token)\s+[^\s]+/giu, '$1<redacted>')
    .replace(/([?&](?:access_?token|auth|token)=)[^&#\s]+/giu, '$1<redacted>')
    .replace(/https:\/\/[^/@\s]+@/giu, 'https://<redacted>@')
    .replace(/\b(?:gh[opusr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/gu, '<redacted>')
    .trim();
  if (result.length > 800) result = `${result.slice(0, 797)}...`;
  return result;
}

function statusFromText(text) {
  const match = /(?:http(?: status)?|status code)\s*[:=]?\s*([1-5][0-9]{2})\b/iu.exec(text);
  return match ? Number(match[1]) : undefined;
}

export function isRetryableGitHubReadError(error) {
  if (typeof error?.retryable === 'boolean') return error.retryable;
  if (['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN'].includes(error?.code)) return true;
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
  const exponential = Math.min(maxDelayMs, baseDelayMs * 2 ** Math.max(0, attempt - 1));
  const jitter = 0.8 + Math.max(0, Math.min(1, random())) * 0.4;
  return Math.round(exponential * jitter);
}

export async function retryReadOperation(label, operation, options = {}) {
  if (typeof label !== 'string' || label.trim() === '') {
    throw new GitHubReadError('GitHub read label is required');
  }
  if (typeof operation !== 'function') {
    throw new GitHubReadError(`${label}: read operation must be a function`);
  }
  const settings = githubReadOptionsFromEnv(options.environment ?? process.env, options);
  const now = settings.now ?? Date.now;
  const random = settings.random ?? Math.random;
  const wait = settings.sleep ?? sleep;
  const classify = settings.classify ?? isRetryableGitHubReadError;
  const onRetry = settings.onRetry ?? (() => {});
  const startedAt = now();
  const deadline = startedAt + settings.deadlineMs;
  let attempts = 0;
  let lastError;

  while (attempts < settings.maxAttempts) {
    const remainingMs = deadline - now();
    if (remainingMs <= 0) {
      throw new GitHubReadError(
        `${label}: overall deadline exhausted after ${attempts} attempt(s)`,
        {
          attempts,
          cause: lastError,
          deadlineExhausted: true,
          retryable: true,
        },
      );
    }
    attempts += 1;
    try {
      return await operation({
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
          `${label}: permanent read failure on attempt ${attempts}${safeDetail ? `: ${safeDetail}` : ''}`,
          { attempts, cause: error, retryable: false },
        );
      }
      if (error?.deadlineExhausted === true) {
        throw new GitHubReadError(
          `${label}: overall deadline exhausted after ${attempts} attempt(s)`,
          {
            attempts,
            cause: error,
            deadlineExhausted: true,
            retryable: true,
          },
        );
      }
      if (attempts >= settings.maxAttempts) {
        throw new GitHubReadError(
          `${label}: retry budget exhausted after ${attempts} attempt(s)${safeDetail ? `: ${safeDetail}` : ''}`,
          { attempts, cause: error, retryable: true },
        );
      }
      const delay = retryDelay(attempts, { ...settings, random });
      const beforeSleepRemaining = deadline - now();
      if (beforeSleepRemaining <= delay) {
        throw new GitHubReadError(
          `${label}: overall deadline exhausted after ${attempts} attempt(s)`,
          {
            attempts,
            cause: error,
            deadlineExhausted: true,
            retryable: true,
          },
        );
      }
      onRetry({ attempt: attempts, delayMs: delay, error, label });
      await wait(delay);
    }
  }
  throw new GitHubReadError(`${label}: retry budget exhausted`, {
    attempts,
    cause: lastError,
    retryable: true,
  });
}

function validateGithubEndpoint(endpoint) {
  if (typeof endpoint !== 'string')
    throw new GitHubReadError('GitHub API endpoint must be a string');
  const relative = endpoint.startsWith('repos/')
    ? endpoint
    : endpoint.startsWith('https://api.github.com/repos/')
      ? endpoint.slice('https://api.github.com/'.length)
      : null;
  if (
    relative === null ||
    endpoint.includes('#') ||
    !/^repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:[/?][^\s\\\u0000-\u001f\u007f]*)?$/u.test(relative)
  ) {
    throw new GitHubReadError('GitHub API read endpoint is outside the repository allowlist');
  }
  let decoded;
  try {
    decoded = decodeURIComponent(relative.split('?', 1)[0]);
  } catch (error) {
    throw new GitHubReadError('GitHub API read endpoint contains malformed encoding', {
      cause: error,
    });
  }
  if (decoded.split('/').some((segment) => segment === '.' || segment === '..')) {
    throw new GitHubReadError('GitHub API read endpoint contains a traversal segment');
  }
}

function assertSafeGraphqlQuery(document) {
  if (typeof document !== 'string' || document.length === 0 || document.length > 32 * 1024) {
    throw new GitHubReadError('GitHub GraphQL read requires one bounded query document');
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(document)) {
    throw new GitHubReadError('GitHub GraphQL query contains unsupported control characters');
  }
  const normalized = document.trim();
  const operations = [...normalized.matchAll(/\b(query|mutation|subscription)\b/gu)];
  if (
    operations.length !== 1 ||
    operations[0][1] !== 'query' ||
    !/^query\s+[A-Za-z_][A-Za-z0-9_]*(?:\s*\([^)]*\))?\s*\{[\s\S]*\}$/u.test(normalized) ||
    /["'`#]/u.test(normalized)
  ) {
    throw new GitHubReadError('GitHub GraphQL read requires exactly one named query operation');
  }
  let depth = 0;
  for (const character of normalized) {
    if (character === '{') depth += 1;
    else if (character === '}') depth -= 1;
    if (depth < 0) break;
  }
  if (depth !== 0) {
    throw new GitHubReadError('GitHub GraphQL query has unbalanced selection braces');
  }
}

function validateGraphqlVariables(variables) {
  if (
    variables === null ||
    typeof variables !== 'object' ||
    Array.isArray(variables) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(variables))
  ) {
    throw new GitHubReadError('GitHub GraphQL variables must be a plain object');
  }
  for (const name of Object.keys(variables).sort()) {
    const value = variables[name];
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) {
      throw new GitHubReadError(`GitHub GraphQL variable name is invalid: ${name}`);
    }
    if (typeof value !== 'string' || value.length > 4_096 || /[\u0000-\u001f\u007f]/u.test(value)) {
      throw new GitHubReadError(
        `GitHub GraphQL variable ${name} must be a bounded printable string`,
      );
    }
  }
}

export async function requestGithubGraphql(document, variables = {}, options = {}) {
  assertSafeGraphqlQuery(document);
  validateGraphqlVariables(variables);
  const environment = options.environment ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  return await requestGithubJsonWithRetry('https://api.github.com/graphql', {
    ...options,
    authToken: environment.GH_TOKEN || environment.GITHUB_TOKEN || '',
    coreJournalOptions: { environment, ...options.coreJournalOptions },
    fetchImpl: (url, init) =>
      fetchImpl(url, {
        ...init,
        method: 'POST',
        headers: { ...init.headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: document, variables }),
      }),
  });
}

function parseGithubPaginationLinks(value, label) {
  if (value === '') return new Map();
  const links = new Map();
  for (const rawEntry of value.split(/,\s*(?=<)/u)) {
    const match = /^<([^<>]+)>;\s*rel="(first|last|next|prev)"$/u.exec(rawEntry.trim());
    if (match === null || links.has(match[2])) {
      throw new GitHubReadError(
        `${label} returned a malformed or duplicate pagination Link relation`,
      );
    }
    links.set(match[2], match[1]);
  }
  return links;
}

function escapedRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function exactQueryEntries(url, label) {
  const entries = [...url.searchParams.entries()];
  if (new Set(entries.map(([name]) => name)).size !== entries.length) {
    throw new GitHubReadError(`${label} contains a duplicate query parameter`);
  }
  return entries.sort(
    ([leftName, leftValue], [rightName, rightValue]) =>
      compareText(leftName, rightName) || compareText(leftValue, rightValue),
  );
}

function paginationEndpoint(endpoint) {
  if (typeof endpoint !== 'string' || !endpoint.startsWith('repos/')) {
    throw new GitHubReadError('journal-aware pagination requires a repository API endpoint');
  }
  validateGithubEndpoint(endpoint);
  const url = new URL(endpoint, 'https://api.github.com/');
  if (url.origin !== 'https://api.github.com' || url.hash !== '') {
    throw new GitHubReadError('journal-aware pagination requires the canonical GitHub API origin');
  }
  const match = /^\/repos\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/(.+)$/u.exec(url.pathname);
  if (match === null || match[3].endsWith('/')) {
    throw new GitHubReadError(
      'journal-aware pagination endpoint must name one repository resource',
    );
  }
  const fixedQuery = exactQueryEntries(url, 'journal-aware pagination endpoint');
  if (fixedQuery.some(([name]) => name === 'page' || name === 'per_page')) {
    throw new GitHubReadError('journal-aware pagination owns the page and per_page parameters');
  }
  return {
    fixedQuery,
    owner: match[1],
    repo: match[2],
    requestedPath: url.pathname,
    resource: match[3],
  };
}

function validateGithubPaginationLink(
  rawUrl,
  expected,
  relation,
  currentPage,
  canonicalRepositoryPath,
) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch (cause) {
    throw new GitHubReadError(`${expected.label} returned a malformed pagination URL`, { cause });
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'api.github.com' ||
    url.port !== '' ||
    url.username !== '' ||
    url.password !== '' ||
    url.hash !== ''
  ) {
    throw new GitHubReadError(
      `${expected.label} pagination URL must use the canonical GitHub API origin`,
    );
  }
  const canonicalMatch = new RegExp(
    `^/repositories/([1-9][0-9]*)/${escapedRegex(expected.resource)}$`,
    'u',
  ).exec(url.pathname);
  if (url.pathname !== expected.requestedPath && canonicalMatch === null) {
    throw new GitHubReadError(`${expected.label} pagination URL changed repository or endpoint`);
  }
  let nextCanonicalPath = canonicalRepositoryPath;
  if (canonicalMatch !== null) {
    if (canonicalRepositoryPath !== null && url.pathname !== canonicalRepositoryPath) {
      throw new GitHubReadError(
        `${expected.label} pagination URL changed canonical repository identity`,
      );
    }
    nextCanonicalPath = url.pathname;
  }
  const pageValue = url.searchParams.get('page');
  if (!/^[1-9][0-9]*$/u.test(pageValue ?? '')) {
    throw new GitHubReadError(`${expected.label} pagination URL has an invalid page number`);
  }
  const linkedPage = Number(pageValue);
  if (!Number.isSafeInteger(linkedPage)) {
    throw new GitHubReadError(`${expected.label} pagination page exceeds the safe integer range`);
  }
  const wantedPage =
    relation === 'next'
      ? currentPage + 1
      : relation === 'prev'
        ? currentPage - 1
        : relation === 'first'
          ? 1
          : linkedPage;
  if (linkedPage !== wantedPage || (relation === 'last' && linkedPage < currentPage)) {
    throw new GitHubReadError(`${expected.label} returned a non-canonical ${relation} page number`);
  }
  const actualQuery = exactQueryEntries(url, `${expected.label} pagination URL`);
  const expectedQuery = [
    ...expected.fixedQuery,
    ['page', String(linkedPage)],
    ['per_page', String(GITHUB_PAGINATION_PAGE_SIZE)],
  ].sort(
    ([leftName, leftValue], [rightName, rightValue]) =>
      compareText(leftName, rightName) || compareText(leftValue, rightValue),
  );
  if (JSON.stringify(actualQuery) !== JSON.stringify(expectedQuery)) {
    throw new GitHubReadError(`${expected.label} pagination URL changed the exact page query`);
  }
  return nextCanonicalPath;
}

export async function requestGithubPages(endpoint, options = {}) {
  const environment = options.environment ?? process.env;
  const expected = paginationEndpoint(endpoint);
  const label = options.label ?? 'GitHub paginated JSON read';
  const itemsField = options.itemsField ?? null;
  const maxPages = options.maxPages ?? GITHUB_PAGINATION_MAX_PAGES;
  const settings = githubReadOptionsFromEnv(options.environment ?? process.env, options);
  const now = settings.now ?? Date.now;
  const paginationStartedAtMs = now();
  const paginationDeadlineMs = Math.min(
    paginationStartedAtMs + settings.deadlineMs,
    githubReleaseQueryDeadline(paginationStartedAtMs, environment),
  );
  if (!Number.isSafeInteger(paginationDeadlineMs)) {
    throw new GitHubReadError(`${label} pagination deadline exceeds the safe timestamp range`);
  }
  if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > GITHUB_PAGINATION_MAX_PAGES) {
    throw new GitHubReadError(
      `paginated JSON maxPages must be between 1 and ${GITHUB_PAGINATION_MAX_PAGES}`,
    );
  }
  if (
    itemsField !== null &&
    (typeof itemsField !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(itemsField))
  ) {
    throw new GitHubReadError('paginated JSON itemsField must be null or a safe object field name');
  }
  const rows = [];
  let canonicalRepositoryPath = null;
  for (let page = 1; page <= maxPages; page += 1) {
    const query = new URLSearchParams(expected.fixedQuery);
    query.set('per_page', String(GITHUB_PAGINATION_PAGE_SIZE));
    query.set('page', String(page));
    const pageEndpoint = `${expected.requestedPath.slice(1)}?${query.toString()}`;
    const pageLabel = `${label} page ${page}`;
    const pageStartedAtMs = now();
    const remainingPaginationMs = paginationDeadlineMs - pageStartedAtMs;
    if (remainingPaginationMs <= 0) {
      throw new GitHubReadError(`${label}: pagination deadline exhausted before page ${page}`, {
        deadlineExhausted: true,
        retryable: true,
      });
    }
    const { data, link } = await requestGithubJsonWithRetry(
      'https://api.github.com/' + pageEndpoint,
      {
        authToken: environment.GH_TOKEN || environment.GITHUB_TOKEN || '',
        coreJournalOptions: { environment, ...options.coreJournalOptions },
        deadlineMs: paginationDeadlineMs,
        fetchImpl: options.fetchImpl,
        nowImpl: now,
        sleepImpl: options.sleepImpl ?? options.sleep,
        attemptTimeoutMs: settings.attemptTimeoutMs,
        maxAttempts: settings.maxAttempts,
        responseMetadata: true,
      },
    );
    const pageRows =
      itemsField === null
        ? data
        : data !== null && !Array.isArray(data) && typeof data === 'object'
          ? data[itemsField]
          : undefined;
    if (!Array.isArray(pageRows) || pageRows.length > GITHUB_PAGINATION_PAGE_SIZE) {
      throw new GitHubReadError(
        `${pageLabel} must contain an array of at most ${GITHUB_PAGINATION_PAGE_SIZE} rows` +
          (itemsField === null ? '' : ` in ${itemsField}`),
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
    if (!links.has('next')) return rows;
    if (pageRows.length !== GITHUB_PAGINATION_PAGE_SIZE) {
      throw new GitHubReadError(
        `${pageLabel} advertised a next page after only ${pageRows.length} rows`,
      );
    }
  }
  throw new GitHubReadError(`${label} exceeds ${maxPages} pages`);
}

export async function requestGithubRepositoryJson(endpoint, options = {}) {
  validateGithubEndpoint(endpoint);
  const environment = options.environment ?? process.env;
  const settings = githubReadOptionsFromEnv(environment, options);
  const now = options.now ?? Date.now;
  return await requestGithubJsonWithRetry(
    endpoint.startsWith('https:') ? endpoint : 'https://api.github.com/' + endpoint,
    {
      authToken: environment.GH_TOKEN || environment.GITHUB_TOKEN || '',
      coreJournalOptions: { environment, ...options.coreJournalOptions },
      deadlineMs: Math.min(
        now() + settings.deadlineMs,
        githubReleaseQueryDeadline(now(), environment),
      ),
      attemptTimeoutMs: settings.attemptTimeoutMs,
      fetchImpl: options.fetchImpl,
      nowImpl: now,
      sleepImpl: options.sleepImpl ?? options.sleep,
      maxAttempts: settings.maxAttempts,
    },
  );
}

const MAX_GITHUB_JSON_BYTES = 8 * 1024 * 1024;
const MAX_GITHUB_ERROR_BYTES = 64 * 1024;
const GITHUB_API_TIMEOUT_MS = 30_000;
const GITHUB_RELEASE_QUERY_WINDOW_MS = 5 * 60 * 1000;
const GITHUB_RELEASE_QUERY_MAX_ATTEMPTS = 3;
const GITHUB_RELEASE_QUERY_MAX_RETRY_AFTER_MS = 4 * 60 * 1000;

export function authHeaders(accept, token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN) {
  const headers = {
    Accept: accept,
    'User-Agent': 'oliphaunt-release-check',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (token) {
    if (typeof token !== 'string' || /[\0\r\n]/u.test(token)) {
      throw new Error('GitHub API token is invalid');
    }
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

export function responseContentLength(response, context) {
  const raw = response.headers?.get?.('content-length');
  if (raw === null || raw === undefined) return null;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${context} returned an invalid Content-Length`);
  }
  return value;
}

export async function boundedResponseBytes(response, maximum, context) {
  const declared = responseContentLength(response, context);
  if (declared !== null && declared > maximum) {
    await response.body?.cancel?.().catch(() => {});
    throw new Error(`${context} exceeds ${maximum} bytes`);
  }
  const reader = response.body?.getReader?.();
  if (reader === undefined) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maximum) throw new Error(`${context} exceeds ${maximum} bytes`);
    return bytes;
  }
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) {
        await reader.cancel().catch(() => {});
        throw new Error(`${context} exceeds ${maximum} bytes`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return new Uint8Array(Buffer.concat(chunks, size));
}

export async function requestBoundedGithubJson(
  url,
  { fetchImpl = fetch, timeoutMs = GITHUB_API_TIMEOUT_MS } = {},
) {
  const response = await fetchImpl(url, {
    headers: authHeaders('application/vnd.github+json'),
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    await response.body?.cancel?.().catch(() => {});
    throw new Error(`GitHub API returned HTTP ${response.status} for ${url}`);
  }
  const bytes = await boundedResponseBytes(response, MAX_GITHUB_JSON_BYTES, 'GitHub API response');
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    throw new GitHubReadError(`GitHub API returned invalid JSON for ${url}: ${error.message}`);
  }
}

function githubRateLimitedResponse(response, detail) {
  if (response.status === 429) return true;
  if (response.status !== 403) return false;
  return (
    response.headers?.has?.('retry-after') === true ||
    response.headers?.get?.('x-ratelimit-remaining')?.trim() === '0' ||
    /(?:abuse|rate limit|secondary limit)/iu.test(detail)
  );
}

function retryableGithubResponse(response, rateLimited) {
  return (
    rateLimited ||
    response.status === 408 ||
    response.status === 425 ||
    (response.status >= 500 && response.status <= 599)
  );
}

async function githubErrorDetail(response) {
  try {
    const bytes = await boundedResponseBytes(
      response,
      MAX_GITHUB_ERROR_BYTES,
      `GitHub API HTTP ${response.status} error response`,
    );
    const text = new TextDecoder().decode(bytes);
    try {
      const parsed = JSON.parse(text);
      return typeof parsed?.message === 'string' ? parsed.message : text;
    } catch {
      return text;
    }
  } catch {
    await response.body?.cancel?.().catch(() => {});
    return '';
  }
}

function retryAfterDelay(response, nowMs, context) {
  const raw = response.headers?.get?.('retry-after')?.trim();
  if (!raw) return null;
  let delay;
  if (/^[0-9]+$/u.test(raw)) {
    delay = Number(raw) * 1000;
  } else {
    const date = Date.parse(raw);
    if (!Number.isFinite(date)) {
      throw new Error(`${context} returned an invalid Retry-After header`);
    }
    delay = Math.max(0, date - nowMs);
  }
  if (!Number.isSafeInteger(delay) || delay > GITHUB_RELEASE_QUERY_MAX_RETRY_AFTER_MS) {
    throw new Error(
      `${context} requested Retry-After ${JSON.stringify(raw)}, exceeding the ${GITHUB_RELEASE_QUERY_MAX_RETRY_AFTER_MS}ms retry cap`,
    );
  }
  return delay;
}

function rateLimitDelay(response, nowMs, headerlessSecondaryAttempt, context) {
  const retryAfter = retryAfterDelay(response, nowMs, context);
  if (retryAfter !== null) return retryAfter;

  if (response.headers?.get?.('x-ratelimit-remaining')?.trim() === '0') {
    const rawReset = response.headers?.get?.('x-ratelimit-reset')?.trim();
    if (rawReset === undefined || rawReset === null || rawReset === '') {
      throw new Error(`${context} exhausted the primary rate limit without X-RateLimit-Reset`);
    }
    if (!/^[1-9][0-9]*$/u.test(rawReset)) {
      throw new Error(`${context} returned an invalid X-RateLimit-Reset header`);
    }
    const resetMs = Number(rawReset) * 1000;
    const delay = Math.max(0, resetMs - nowMs) + 1_000;
    if (!Number.isSafeInteger(resetMs) || delay > GITHUB_RELEASE_QUERY_MAX_RETRY_AFTER_MS) {
      throw new Error(
        `${context} requires a primary-rate-limit wait exceeding the ${GITHUB_RELEASE_QUERY_MAX_RETRY_AFTER_MS}ms retry cap`,
      );
    }
    return delay;
  }

  // GitHub requires at least a one-minute pause for a secondary limit without
  // usable rate-limit headers, followed by exponential backoff.
  return Math.min(
    GITHUB_RELEASE_QUERY_MAX_RETRY_AFTER_MS,
    60_000 * 2 ** Math.max(0, headerlessSecondaryAttempt - 1),
  );
}

export function githubReleaseQueryDeadline(nowMs = Date.now(), env = process.env) {
  let deadline = nowMs + GITHUB_RELEASE_QUERY_WINDOW_MS;
  const raw = env.REGISTRY_JOB_HARD_DEADLINE_EPOCH?.trim();
  if (raw !== undefined && raw !== '') {
    if (!/^[1-9][0-9]*$/u.test(raw)) {
      throw new Error('REGISTRY_JOB_HARD_DEADLINE_EPOCH must be a positive Unix timestamp');
    }
    const hardDeadline = Number(raw) * 1000;
    if (!Number.isSafeInteger(hardDeadline)) {
      throw new Error('REGISTRY_JOB_HARD_DEADLINE_EPOCH exceeds the safe timestamp range');
    }
    deadline = Math.min(deadline, hardDeadline);
  }
  if (deadline <= nowMs) {
    throw new Error('GitHub release query deadline has already expired');
  }
  return deadline;
}

export async function requestGithubJsonWithRetry(
  url,
  {
    attemptTimeoutMs = GITHUB_API_TIMEOUT_MS,
    authToken,
    coreJournalOptions,
    deadlineMs,
    fetchImpl = fetch,
    maxAttempts = GITHUB_RELEASE_QUERY_MAX_ATTEMPTS,
    nowImpl = Date.now,
    responseMetadata = false,
    sleepImpl = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  } = {},
) {
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts <= 0) {
    throw new Error('GitHub request maxAttempts must be a positive safe integer');
  }
  const effectiveDeadline = deadlineMs ?? githubReleaseQueryDeadline(nowImpl());
  let headerlessSecondaryFailures = 0;
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const now = nowImpl();
    const remaining = effectiveDeadline - now;
    if (remaining <= 0) {
      throw new Error(`GitHub release query deadline expired for ${url}`);
    }
    let response;
    let rateLimited = false;
    await reserveGitHubCoreRequest({
      ...(coreJournalOptions ?? {}),
      label: `GitHub release JSON ${new URL(url).pathname}`,
    });
    const transportRemaining = effectiveDeadline - nowImpl();
    if (transportRemaining <= 0) {
      throw new Error(
        `GitHub release query deadline expired during request-journal admission for ${url}`,
      );
    }
    try {
      response = await fetchImpl(url, {
        headers: authHeaders('application/vnd.github+json', authToken),
        redirect: 'error',
        signal: AbortSignal.timeout(Math.max(1, Math.min(attemptTimeoutMs, transportRemaining))),
      });
    } catch (error) {
      lastError = error;
      if (attempt === maxAttempts) break;
    }
    if (response?.ok) {
      const bytes = await boundedResponseBytes(
        response,
        MAX_GITHUB_JSON_BYTES,
        'GitHub API response',
      );
      try {
        const data = JSON.parse(new TextDecoder().decode(bytes));
        return responseMetadata ? { data, link: response.headers?.get?.('link') ?? '' } : data;
      } catch (error) {
        throw new GitHubReadError(`GitHub API returned invalid JSON for ${url}: ${error.message}`);
      }
    }
    if (response !== undefined) {
      const detail = await githubErrorDetail(response);
      rateLimited = githubRateLimitedResponse(response, detail);
      if (!retryableGithubResponse(response, rateLimited)) {
        throw new Error(`GitHub API returned HTTP ${response.status} for ${url}`);
      }
      lastError = new Error(`GitHub API returned transient HTTP ${response.status} for ${url}`);
      if (attempt === maxAttempts) break;
    }
    const current = nowImpl();
    const retryAfter =
      response === undefined
        ? null
        : retryAfterDelay(response, current, `GitHub API HTTP ${response.status}`);
    const headerlessSecondary =
      response !== undefined &&
      rateLimited &&
      retryAfter === null &&
      response.headers?.get?.('x-ratelimit-remaining')?.trim() !== '0';
    headerlessSecondaryFailures = headerlessSecondary ? headerlessSecondaryFailures + 1 : 0;
    const delay =
      retryAfter ??
      (rateLimited
        ? rateLimitDelay(
            response,
            current,
            headerlessSecondaryFailures,
            `GitHub API HTTP ${response.status}`,
          )
        : Math.min(2_000, 250 * 2 ** (attempt - 1)));
    if (current + delay >= effectiveDeadline) {
      throw new Error(`GitHub release query retry for ${url} would exceed its deadline`);
    }
    await sleepImpl(delay);
  }
  throw new Error(
    `${lastError?.message ?? `GitHub API request failed for ${url}`} after ${maxAttempts} attempts`,
  );
}

// Actions downloads redirect to short-lived storage URLs. Never forward the
// GitHub credential to storage, and keep the whole transfer under one timeout.
export async function requestGithubDownload(
  url,
  { environment = process.env, fetchImpl = fetch, timeoutMs = 5 * 60_000 } = {},
) {
  let location = new URL(url);
  if (
    location.origin !== 'https://api.github.com' ||
    location.username ||
    location.password ||
    location.hash
  )
    throw new GitHubReadError('GitHub download must start at the canonical API origin');
  const signal = AbortSignal.timeout(timeoutMs);
  await reserveGitHubCoreRequest({ environment, label: `GitHub download ${location.pathname}` });
  for (let redirects = 0; redirects <= 5; redirects++) {
    if (location.protocol !== 'https:' || location.username || location.password || location.hash)
      throw new GitHubReadError(
        'GitHub download redirect must use HTTPS without credentials or fragments',
      );
    let response;
    try {
      response = await fetchImpl(location, {
        headers:
          redirects === 0
            ? authHeaders(
                'application/vnd.github+json',
                environment.GH_TOKEN || environment.GITHUB_TOKEN || '',
              )
            : {},
        redirect: 'manual',
        signal,
      });
    } catch (cause) {
      throw new RetryableReadError('GitHub artifact transfer failed', { cause });
    }
    if (response.ok) return response;
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const next = response.headers.get('location');
      await response.body?.cancel?.().catch(() => {});
      if (!next) throw new GitHubReadError('GitHub download redirect omitted Location');
      location = new URL(next, location);
      continue;
    }
    const detail = await githubErrorDetail(response);
    throw new GitHubReadError(`GitHub artifact download returned HTTP ${response.status}`, {
      retryable:
        RETRYABLE_STATUS.has(response.status) || githubRateLimitedResponse(response, detail),
    });
  }
  throw new GitHubReadError('GitHub artifact download exceeds five redirects');
}

async function cli(argv) {
  let label = 'GitHub read',
    field;
  while (argv[0]?.startsWith('--') && argv[0] !== '--') {
    const flag = argv.shift();
    const value = argv.shift();
    if (!value) throw new GitHubReadError(`${flag} requires a value`);
    if (flag === '--label') label = value;
    else if (flag === '--paginate-field') field = value;
    else throw new GitHubReadError(`unknown github-read option: ${flag}`);
  }
  if (argv[0] === '--') argv.shift();
  if (argv.length !== 1 || !argv[0].startsWith('repos/'))
    throw new GitHubReadError('GitHub read requires exactly one repository API endpoint');
  validateGithubEndpoint(argv[0]);
  const data =
    field === undefined
      ? await requestGithubRepositoryJson(argv[0], { label })
      : await requestGithubPages(argv[0], { label, itemsField: field === '-' ? null : field });
  process.stdout.write(JSON.stringify(data) + '\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    await cli(process.argv.slice(2));
  } catch (error) {
    console.error(redactGitHubReadDetail(error instanceof Error ? error.message : String(error)));
    process.exit(isRetryableGitHubReadError(error) ? 75 : 64);
  }
}
