#!/usr/bin/env bun

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { readGitHubCoreRequestJournal } from './github-core-request-journal.mts';
import {
  GitHubReadError,
  githubReadOptionsFromEnv,
  RetryableReadError,
  redactGitHubReadDetail,
  requestGithubGraphql,
  requestGithubRepositoryJson,
  retryReadOperation,
} from './github-read.mts';

function deterministic(overrides = {}) {
  let time = 1_000;
  return {
    attemptTimeoutMs: 50,
    baseDelayMs: 10,
    deadlineMs: 1_000,
    environment: {},
    maxAttempts: 4,
    maxDelayMs: 40,
    now: () => time,
    random: () => 0.5,
    sleep: (delay) => {
      time += delay;
    },
    ...overrides,
  };
}

function journalFixture(t, label) {
  const root = mkdtempSync(path.join(os.tmpdir(), `oliphaunt-github-read-${label}-`));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  return {
    environment: {
      GITHUB_REPOSITORY: 'o/r',
      GITHUB_RUN_ATTEMPT: '1',
      GITHUB_RUN_ID: '123',
      GITHUB_SHA: 'a'.repeat(40),
      OLIPHAUNT_GITHUB_CORE_REQUEST_JOURNAL_PATH: path.join(root, 'journal.json'),
      OLIPHAUNT_REQUIRE_GITHUB_CORE_REQUEST_JOURNAL: 'true',
    },
    root,
  };
}

test('bounded read retries a transient failure and returns the successful result', async () => {
  const attempts = [];
  const retries = [];
  const result = await retryReadOperation(
    'artifact inventory',
    ({ attempt, attemptTimeoutMs }) => {
      attempts.push([attempt, attemptTimeoutMs]);
      if (attempt === 1) throw new Error('HTTP 503 temporary failure');
      return 'complete';
    },
    deterministic({ onRetry: (event) => retries.push([event.attempt, event.delayMs]) }),
  );
  assert.equal(result, 'complete');
  assert.deepEqual(attempts, [
    [1, 50],
    [2, 50],
  ]);
  assert.deepEqual(retries, [[1, 10]]);
});

test('permanent authentication and usage failures never consume the retry budget', async () => {
  let attempts = 0;
  await assert.rejects(
    async () =>
      await retryReadOperation(
        'run metadata',
        () => {
          attempts += 1;
          const error = new Error('HTTP 401 Bad credentials');
          error.status = 1;
          throw error;
        },
        deterministic(),
      ),
    (error) =>
      error instanceof GitHubReadError && error.retryable === false && error.attempts === 1,
  );
  assert.equal(attempts, 1);
});

test('rate-limited HTTP 403 reads remain retryable but ordinary forbidden reads do not', async () => {
  let attempts = 0;
  const result = await retryReadOperation(
    'rate-limited inventory',
    () => {
      attempts += 1;
      if (attempts === 1) throw new Error('HTTP 403 secondary rate limit exceeded');
      return 'ok';
    },
    deterministic(),
  );
  assert.equal(result, 'ok');
  assert.equal(attempts, 2);
  await assert.rejects(
    async () =>
      await retryReadOperation(
        'forbidden inventory',
        () => {
          throw new Error('HTTP 403 Resource not accessible by integration');
        },
        deterministic(),
      ),
    (error) => error.retryable === false && error.attempts === 1,
  );
});

test('retry budget and overall deadline are independent fail-closed bounds', async () => {
  let budgetAttempts = 0;
  await assert.rejects(
    async () =>
      await retryReadOperation(
        'workflow search',
        () => {
          budgetAttempts += 1;
          throw new RetryableReadError('socket hang up');
        },
        deterministic({ maxAttempts: 3 }),
      ),
    (error) =>
      error.retryable === true &&
      error.attempts === 3 &&
      /retry budget exhausted/u.test(error.message),
  );
  assert.equal(budgetAttempts, 3);

  let time = 5_000;
  let deadlineAttempts = 0;
  await assert.rejects(
    async () =>
      await retryReadOperation(
        'artifact download',
        () => {
          deadlineAttempts += 1;
          time += 25;
          throw new RetryableReadError('unexpected EOF');
        },
        {
          ...deterministic(),
          baseDelayMs: 10,
          deadlineMs: 30,
          maxDelayMs: 10,
          now: () => time,
          sleep: (delay) => {
            time += delay;
          },
        },
      ),
    (error) => error.deadlineExhausted === true && error.attempts === 1,
  );
  assert.equal(deadlineAttempts, 1);
});

test('journal admission delay clamps the read transport to the live deadline remainder', async (t) => {
  const { environment } = journalFixture(t, 'clamp');
  const journal = environment.OLIPHAUNT_GITHUB_CORE_REQUEST_JOURNAL_PATH;
  const lock = `${journal}.lock`;
  writeFileSync(lock, 'occupied\n');
  let nowMs = 1_000;
  let observedTimeout;
  const originalTimeout = AbortSignal.timeout;
  AbortSignal.timeout = (ms) => {
    observedTimeout = ms;
    return originalTimeout(ms);
  };
  t.after(() => {
    AbortSignal.timeout = originalTimeout;
  });
  const output = await requestGithubRepositoryJson('repos/o/r/releases', {
    attemptTimeoutMs: 100,
    baseDelayMs: 0,
    coreJournalOptions: {
      now: () => nowMs,
      sleep: (delayMs) => {
        nowMs += delayMs;
        rmSync(lock, { force: true });
      },
    },
    deadlineMs: 175,
    environment,
    maxAttempts: 1,
    maxDelayMs: 0,
    now: () => nowMs,
    fetchImpl: () => Response.json([]),
  });
  assert.deepEqual(output, []);
  assert.equal(observedTimeout, 75);
});

test('journal admission that exhausts the read deadline never starts transport', async (t) => {
  const { environment } = journalFixture(t, 'expiry');
  const journal = environment.OLIPHAUNT_GITHUB_CORE_REQUEST_JOURNAL_PATH;
  const lock = `${journal}.lock`;
  writeFileSync(lock, 'occupied\n');
  let nowMs = 1_000;
  let spawned = false;
  await assert.rejects(
    async () =>
      await requestGithubRepositoryJson('repos/o/r/releases', {
        attemptTimeoutMs: 50,
        baseDelayMs: 0,
        coreJournalOptions: {
          now: () => nowMs,
          sleep: (delayMs) => {
            nowMs += delayMs;
            rmSync(lock, { force: true });
          },
        },
        deadlineMs: 75,
        environment,
        maxAttempts: 2,
        maxDelayMs: 0,
        now: () => nowMs,
        fetchImpl: () => {
          spawned = true;
          return Response.json([]);
        },
      }),
    /deadline expired during request-journal/u,
  );
  assert.equal(spawned, false);
  assert.deepEqual(readGitHubCoreRequestJournal({ environment, now: () => nowMs }), {
    enabled: true,
    rollingCount: 1,
    sequence: 1,
  });
});

test('repository reads reject foreign URLs and traversal before HTTP', async () => {
  let calls = 0;
  for (const endpoint of [
    'graphql',
    'https://example.invalid/repos/o/r',
    'https://secret@api.github.com/repos/o/r',
    'repos/o/r/../issues',
    'repos/o/r/%2e%2e/issues',
    'repos/o/r#fragment',
    'repos/o/r\\issues',
  ]) {
    await assert.rejects(
      async () =>
        await requestGithubRepositoryJson(endpoint, {
          fetchImpl: () => {
            calls++;
          },
        }),
      /allowlist|traversal/u,
    );
  }
  assert.equal(calls, 0);
});

test('narrow GraphQL reads are query-only, journaled, and built from scalar variables', async (t) => {
  const { environment } = journalFixture(t, 'graphql');
  const document = `
query ReleaseControls($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    nameWithOwner
  }
}`;
  let observed;
  const output = await requestGithubGraphql(
    document,
    { owner: 'f0rr0', name: 'oliphaunt' },
    {
      coreJournalOptions: { now: () => 1_000 },
      environment,
      fetchImpl: async (url, options) => {
        assert.equal(url, 'https://api.github.com/graphql');
        assert.equal(options.method, 'POST');
        assert.equal(options.redirect, 'error');
        observed = JSON.parse(options.body);
        return Response.json({ data: { repository: { nameWithOwner: 'f0rr0/oliphaunt' } } });
      },
    },
  );
  assert.equal(output.data.repository.nameWithOwner, 'f0rr0/oliphaunt');
  assert.deepEqual(observed, { query: document, variables: { owner: 'f0rr0', name: 'oliphaunt' } });
  assert.deepEqual(readGitHubCoreRequestJournal({ environment, now: () => 1_000 }), {
    enabled: true,
    rollingCount: 1,
    sequence: 1,
  });
});

test('narrow GraphQL reads reject non-query documents and unsafe variables before any HTTP request', async () => {
  let spawned = false;
  const options = {
    ...deterministic(),
    fetchImpl: () => {
      spawned = true;
    },
  };
  for (const document of [
    'mutation Bad { viewer { login } }',
    'subscription Bad { viewer { login } }',
    '{ viewer { login } }',
    'query One { viewer { login } } query Two { viewer { login } }',
    'query Literal { repository(owner: "f0rr0", name: "oliphaunt") { name } }',
  ]) {
    await assert.rejects(
      async () => await requestGithubGraphql(document, {}, options),
      /exactly one named query|query document/u,
    );
  }
  for (const variables of [[], { owner: 42 }, { owner: 'bad\nvalue' }, { 'bad-name': 'value' }]) {
    await assert.rejects(
      async () => await requestGithubGraphql('query Safe { viewer { login } }', variables, options),
      /variables|variable/u,
    );
  }
  assert.equal(spawned, false);
});

test('diagnostics redact tokens, authorization headers, query credentials, and URL userinfo', () => {
  const secret = 'github_pat_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const rendered = redactGitHubReadDetail(
    `Authorization: Bearer ${secret}\nhttps://user:pass@example.invalid/a?token=${secret}\n${secret}`,
    { GH_TOKEN: secret },
  );
  assert.equal(rendered.includes(secret), false);
  assert.match(rendered, /<redacted>/u);
  assert.equal(rendered.includes('user:pass'), false);
});

test('environment and override settings enforce fixed retry, timeout, and memory bounds', () => {
  assert.throws(
    () => githubReadOptionsFromEnv({ OLIPHAUNT_GITHUB_READ_MAX_ATTEMPTS: '0' }),
    /must be between 1 and 10/u,
  );
  assert.throws(
    () => githubReadOptionsFromEnv({ OLIPHAUNT_GITHUB_READ_DEADLINE_MS: '0' }),
    /must be between 1 and 3600000/u,
  );
  assert.throws(
    () =>
      githubReadOptionsFromEnv({
        OLIPHAUNT_GITHUB_READ_BASE_DELAY_MS: '10',
        OLIPHAUNT_GITHUB_READ_MAX_DELAY_MS: '9',
      }),
    /must be at least/u,
  );
  assert.throws(
    () => githubReadOptionsFromEnv({ OLIPHAUNT_GITHUB_READ_MAX_ATTEMPTS: '11' }),
    /between 1 and 10/u,
  );
  assert.throws(
    () => githubReadOptionsFromEnv({}, { deadlineMs: 60 * 60_000 + 1 }),
    /deadlineMs must be between/u,
  );
});

test('native HTTP pagination retains exact page queries, link validation, and one deadline', async () => {
  const { requestGithubPages } = await import('./github-read.mts');
  const endpoint = 'repos/f0rr0/oliphaunt/actions/runs/9/jobs?filter=latest';
  const full = Array.from({ length: 100 }, (_, id) => ({ id }));
  const next =
    'https://api.github.com/repositories/123/actions/runs/9/jobs?filter=latest&per_page=100&page=2';
  const calls = [];
  const rows = await requestGithubPages(endpoint, {
    environment: {},
    itemsField: 'jobs',
    fetchImpl: async (url, options) => {
      calls.push(url);
      assert.equal(options.redirect, 'error');
      return calls.length === 1
        ? Response.json({ jobs: full }, { headers: { link: `<${next}>; rel="next"` } })
        : Response.json({ jobs: [{ id: 100 }] });
    },
  });
  assert.equal(rows.length, 101);
  assert.deepEqual(
    calls.map((url) => new URL(url).search),
    ['?filter=latest&per_page=100&page=1', '?filter=latest&per_page=100&page=2'],
  );
  for (const [link, jobs, message] of [
    [next.replace('api.github.com', 'example.invalid'), full, /canonical GitHub API origin/u],
    [next.replace('filter=latest', 'filter=all'), full, /exact page query/u],
    [next, [], /advertised a next page/u],
  ]) {
    let reads = 0;
    await assert.rejects(
      requestGithubPages(endpoint, {
        environment: {},
        itemsField: 'jobs',
        fetchImpl: async () => {
          reads++;
          return Response.json({ jobs }, { headers: { link: `<${link}>; rel="next"` } });
        },
      }),
      message,
    );
    assert.equal(reads, 1);
  }
  let now = 0;
  await assert.rejects(
    requestGithubPages(endpoint, {
      environment: {},
      itemsField: 'jobs',
      deadlineMs: 100,
      now: () => now,
      fetchImpl: async () => {
        now = 101;
        return Response.json({ jobs: full }, { headers: { link: `<${next}>; rel="next"` } });
      },
    }),
    /pagination deadline exhausted/u,
  );
});

test('native artifact redirects omit credentials and reject insecure destinations', async () => {
  const { requestGithubDownload } = await import('./github-read.mts');
  const url = 'https://api.github.com/repos/f0rr0/oliphaunt/actions/artifacts/1/zip';
  const calls = [];
  const response = await requestGithubDownload(url, {
    environment: { GH_TOKEN: 'test-token' },
    fetchImpl: async (location, options) => {
      calls.push({ location: location.href, options });
      return calls.length === 1
        ? new Response(null, {
            status: 302,
            headers: { location: 'https://storage.example.invalid/archive' },
          })
        : new Response('archive');
    },
  });
  assert.equal(await response.text(), 'archive');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer test-token');
  assert.deepEqual(calls[1].options.headers, {});
  assert.equal(calls[0].options.signal, calls[1].options.signal);
  for (const location of [
    'http://storage.example.invalid/a',
    'https://user:secret@storage.example.invalid/a',
  ]) {
    let reads = 0;
    await assert.rejects(
      requestGithubDownload(url, {
        environment: {},
        fetchImpl: async () => {
          reads++;
          return new Response(null, { status: 302, headers: { location } });
        },
      }),
      /HTTPS without credentials/u,
    );
    assert.equal(reads, 1);
  }
});
