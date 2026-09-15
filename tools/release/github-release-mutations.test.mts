import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readGitHubCoreRequestJournal } from './github-core-request-journal.mts';
import { requestGithubRepositoryJson } from './github-read.mts';
import {
  createGitHubOperationBudget,
  GitHubReleaseSnapshotRaceError,
  githubOptionalJsonRead,
  githubPaginatedArrayRead,
  isExplicitGitHubNotFound,
  readReleaseMap,
  readTagRef,
  reconcileGitHubMutation,
  requestGithubMutation,
} from './github-release-mutations.mts';

function fixedBudget(deadlineMs = 180_000, now = () => 0, environment = {}) {
  return { deadlineMs, environment, now, startedAtMs: now() };
}

const deterministic = {
  baseDelayMs: 0,
  environment: {},
  maxAttempts: 3,
  sleep: () => {},
};

function journalFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'oliphaunt-paginated-read-'));
  return {
    environment: {
      GITHUB_ACTIONS: 'true',
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

function releaseRows(firstId, count) {
  return Array.from({ length: count }, (_, offset) => {
    const id = firstId + offset;
    return {
      body: `release ${id}`,
      draft: true,
      id,
      name: `release ${id}`,
      prerelease: false,
      tag_name: `v${id}`,
      target_commitish: 'a'.repeat(40),
    };
  });
}

function includedJson(data, link = '') {
  return Response.json(data, { headers: link ? { Link: link } : {} });
}

function deterministicReadOptions(environment, fetchImpl) {
  return {
    baseDelayMs: 0,
    coreJournalOptions: { now: () => 20_000 },
    deadlineMs: 1_000,
    environment,
    maxAttempts: 2,
    maxDelayMs: 0,
    now: () => 20_000,
    sleep: () => {},
    fetchImpl,
  };
}

test('a successful mutation is followed by exact-state reconciliation', async () => {
  let present = false;
  let mutationCalls = 0;
  const result = await reconcileGitHubMutation({
    inspect: () => ({ kind: present ? 'desired' : 'absent' }),
    label: 'create tag',
    mutate: () => {
      mutationCalls += 1;
      present = true;
    },
    options: { ...deterministic, budget: fixedBudget() },
  });
  assert.equal(mutationCalls, 1);
  assert.deepEqual(result, { mutationAttempts: 1, recovered: false });
});

test('pre-send failure retries only after a fresh read proves absence', async () => {
  let present = false;
  let mutationCalls = 0;
  let inspections = 0;
  const result = await reconcileGitHubMutation({
    inspect: () => {
      inspections += 1;
      return { kind: present ? 'desired' : 'absent' };
    },
    label: 'create release',
    mutate: () => {
      mutationCalls += 1;
      if (mutationCalls === 1) throw new Error('connect failed before request write');
      present = true;
    },
    options: { ...deterministic, budget: fixedBudget() },
  });
  assert.equal(mutationCalls, 2);
  assert.ok(inspections >= 4, 'state is inspected before and after each attempted mutation');
  assert.deepEqual(result, { mutationAttempts: 2, recovered: false });
});

test('an applied mutation followed by timeout is accepted without duplicate replay', async () => {
  let present = false;
  let mutationCalls = 0;
  const result = await reconcileGitHubMutation({
    inspect: () => ({ kind: present ? 'desired' : 'absent' }),
    label: 'upload asset',
    mutate: () => {
      mutationCalls += 1;
      present = true;
      throw new Error('socket timed out after sending the response body');
    },
    options: { ...deterministic, budget: fixedBudget() },
  });
  assert.equal(mutationCalls, 1);
  assert.deepEqual(result, { mutationAttempts: 1, recovered: true });
});

test('pre-existing desired state resumes without issuing a mutation', async () => {
  let mutationCalls = 0;
  const result = await reconcileGitHubMutation({
    inspect: () => ({ kind: 'desired' }),
    label: 'promote release',
    mutate: () => {
      mutationCalls += 1;
    },
    options: { ...deterministic, budget: fixedBudget() },
  });
  assert.equal(mutationCalls, 0);
  assert.deepEqual(result, { mutationAttempts: 0, recovered: false });
});

test('conflicting post-mutation state is terminal', async () => {
  let state = 'absent';
  let mutationCalls = 0;
  await assert.rejects(
    async () =>
      await reconcileGitHubMutation({
        inspect: () =>
          state === 'conflict'
            ? { detail: 'tag points at another full SHA', kind: 'conflict' }
            : { kind: state },
        label: 'create tag',
        mutate: () => {
          mutationCalls += 1;
          state = 'conflict';
          throw new Error('HTTP 422');
        },
        options: { ...deterministic, budget: fixedBudget() },
      }),
    /tag points at another full SHA/u,
  );
  assert.equal(mutationCalls, 1);
});

for (const [label, readError] of [
  ['auth', new Error('HTTP 401 bad credentials')],
  ['malformed', new Error('successful response contained malformed JSON')],
]) {
  test(`${label} failure during ambiguous reconciliation never replays the mutation`, async () => {
    let inspections = 0;
    let mutationCalls = 0;
    await assert.rejects(
      async () =>
        await reconcileGitHubMutation({
          inspect: () => {
            inspections += 1;
            if (inspections > 1) throw readError;
            return { kind: 'absent' };
          },
          label: 'create release',
          mutate: () => {
            mutationCalls += 1;
            throw new Error('ambiguous timeout');
          },
          options: { ...deterministic, budget: fixedBudget() },
        }),
      new RegExp(readError.message, 'u'),
    );
    assert.equal(mutationCalls, 1);
  });
}

test('the shared deadline stops replay even when mutation attempts remain', async () => {
  let nowMs = 0;
  let mutationCalls = 0;
  await assert.rejects(
    async () =>
      await reconcileGitHubMutation({
        inspect: () => ({ kind: 'absent' }),
        label: 'create release',
        mutate: () => {
          mutationCalls += 1;
          nowMs = 99;
          throw new Error('pre-send failure');
        },
        options: {
          ...deterministic,
          attemptTimeoutMs: 50,
          baseDelayMs: 2,
          budget: fixedBudget(100, () => nowMs),
          now: () => nowMs,
        },
      }),
    /deadline/u,
  );
  assert.equal(mutationCalls, 1);
});

test('mutation diagnostics redact credentials', async () => {
  const token = 'github_pat_123456789012345678901234567890';
  await assert.rejects(
    async () =>
      await reconcileGitHubMutation({
        inspect: () => ({ kind: 'absent' }),
        label: 'create release',
        mutate: () => {
          const cause = new Error('upload failed');
          cause.detail = `Authorization: Bearer ${token}`;
          throw cause;
        },
        options: {
          ...deterministic,
          budget: fixedBudget(180_000, () => 0, { GH_TOKEN: token }),
          environment: { GH_TOKEN: token },
          maxAttempts: 1,
        },
      }),
    (cause) => !cause.message.includes(token) && cause.message.includes('<redacted>'),
  );
});

test('only an explicit HTTP 404 is classified as absence', () => {
  const notFound = new Error('read failed', {
    cause: Object.assign(new Error('gh failed'), {
      detail: 'gh: Not Found (HTTP 404)',
    }),
  });
  assert.equal(isExplicitGitHubNotFound(notFound), true);
  assert.equal(isExplicitGitHubNotFound(new Error('HTTP 401 bad credentials')), false);
  assert.equal(
    isExplicitGitHubNotFound(new Error('repository was not found in local cache')),
    false,
  );
});

test('optional reads distinguish 404 from auth and malformed successful JSON', async () => {
  const spawn404 = () => new Response('', { status: 404 });
  assert.equal(
    await githubOptionalJsonRead('repos/o/r/releases/tags/v1', {
      baseDelayMs: 0,
      deadlineMs: 100,
      maxAttempts: 1,
      fetchImpl: spawn404,
    }),
    null,
  );

  const spawnAuth = () => new Response('', { status: 401 });
  await assert.rejects(
    async () =>
      await githubOptionalJsonRead('repos/o/r/releases/tags/v1', {
        baseDelayMs: 0,
        deadlineMs: 100,
        maxAttempts: 1,
        fetchImpl: spawnAuth,
      }),
    /401|credentials/iu,
  );

  const spawnMalformed = () => new Response('{', { status: 200 });
  await assert.rejects(
    async () =>
      await requestGithubRepositoryJson('repos/o/r/releases', {
        baseDelayMs: 0,
        deadlineMs: 100,
        maxAttempts: 1,
        fetchImpl: spawnMalformed,
      }),
    /invalid JSON/u,
  );
});

test('an exact 100-row release page stops from Link metadata without an empty trailing request', async (t) => {
  const { environment, root } = journalFixture();
  t.after(() => rmSync(root, { force: true, recursive: true }));
  const endpoints = [];
  const releases = await readReleaseMap(
    'o/r',
    deterministicReadOptions(environment, (url) => {
      endpoints.push(String(url).replace('https://api.github.com/', ''));
      return includedJson(releaseRows(1, 100));
    }),
  );
  assert.equal(releases.size, 100);
  assert.deepEqual(endpoints, ['repos/o/r/releases?per_page=100&page=1']);
  assert.deepEqual(readGitHubCoreRequestJournal({ environment, now: () => 20_000 }), {
    enabled: true,
    rollingCount: 1,
    sequence: 1,
  });
});

test('each paginated REST page retry is independently journaled and exact 200 rows stop at page two', async (t) => {
  const { environment, root } = journalFixture();
  t.after(() => rmSync(root, { force: true, recursive: true }));
  const endpoints = [];
  let pageTwoAttempts = 0;
  const releases = await readReleaseMap(
    'o/r',
    deterministicReadOptions(environment, (url) => {
      const endpoint = String(url).replace('https://api.github.com/', '');
      endpoints.push(endpoint);
      if (endpoint.endsWith('page=1')) {
        const next = 'https://api.github.com/repositories/42/releases?per_page=100&page=2';
        const last = 'https://api.github.com/repositories/42/releases?per_page=100&page=2';
        return includedJson(releaseRows(1, 100), `<${next}>; rel="next", <${last}>; rel="last"`);
      }
      pageTwoAttempts += 1;
      if (pageTwoAttempts === 1) {
        return new Response('', { status: 503 });
      }
      return includedJson(releaseRows(101, 100));
    }),
  );
  assert.equal(releases.size, 200);
  assert.deepEqual(endpoints, [
    'repos/o/r/releases?per_page=100&page=1',
    'repos/o/r/releases?per_page=100&page=2',
    'repos/o/r/releases?per_page=100&page=2',
  ]);
  assert.deepEqual(readGitHubCoreRequestJournal({ environment, now: () => 20_000 }), {
    enabled: true,
    rollingCount: 3,
    sequence: 3,
  });
});

test('a repeated release id across pagination is the only retryable snapshot race shape', async () => {
  const next = 'https://api.github.com/repositories/42/releases?per_page=100&page=2';
  const spawnWithSecondPage = (rows) => (url) => {
    const endpoint = String(url).replace('https://api.github.com/', '');
    if (endpoint.endsWith('page=1')) {
      return includedJson(releaseRows(1, 100), `<${next}>; rel="next"`);
    }
    return includedJson(rows);
  };
  await assert.rejects(
    async () =>
      await readReleaseMap('o/r', {
        baseDelayMs: 0,
        deadlineMs: 1_000,
        maxAttempts: 1,
        fetchImpl: spawnWithSecondPage(releaseRows(100, 1)),
      }),
    (cause) =>
      cause instanceof GitHubReleaseSnapshotRaceError &&
      /repeated release 100 across one paginated snapshot/u.test(cause.message),
  );

  const conflictingTag = {
    ...releaseRows(101, 1)[0],
    tag_name: 'v100',
  };
  await assert.rejects(
    async () =>
      await readReleaseMap('o/r', {
        baseDelayMs: 0,
        deadlineMs: 1_000,
        maxAttempts: 1,
        fetchImpl: spawnWithSecondPage([conflictingTag]),
      }),
    (cause) =>
      !(cause instanceof GitHubReleaseSnapshotRaceError) &&
      /duplicate releases for tag v100/u.test(cause.message),
  );
});

test('one pagination deadline is shared across every physical page', async () => {
  let nowMs = 0;
  const endpoints = [];
  await assert.rejects(
    async () =>
      await githubPaginatedArrayRead('o/r', 'releases', {
        baseDelayMs: 0,
        deadlineMs: 100,
        maxAttempts: 1,
        now: () => nowMs,
        fetchImpl: (url) => {
          const endpoint = String(url).replace('https://api.github.com/', '');
          endpoints.push(endpoint);
          nowMs = 101;
          const next = 'https://api.github.com/repositories/42/releases?per_page=100&page=2';
          return includedJson(releaseRows(1, 100), `<${next}>; rel="next"`);
        },
      }),
    /pagination deadline exhausted before page 2/u,
  );
  assert.deepEqual(endpoints, ['repos/o/r/releases?per_page=100&page=1']);
});

test('paginated reads reject cross-endpoint and query-mutating next links', async () => {
  const invoke = async (next) =>
    await githubPaginatedArrayRead('o/r', 'releases', {
      baseDelayMs: 0,
      deadlineMs: 100,
      maxAttempts: 1,
      fetchImpl: () => includedJson(releaseRows(1, 100), `<${next}>; rel="next"`),
    });
  await assert.rejects(
    async () => await invoke('https://api.github.com/repositories/42/issues?per_page=100&page=2'),
    /changed repository or endpoint/u,
  );
  await assert.rejects(
    async () =>
      await invoke(
        'https://api.github.com/repositories/42/releases?per_page=100&page=2&extra=true',
      ),
    /changed the exact page query/u,
  );
});

test('malformed tag-ref metadata fails closed', async () => {
  const fetchImpl = () =>
    new Response(
      JSON.stringify({
        object: { sha: 'a'.repeat(40), type: 'commit' },
        ref: 'refs/heads/main',
      }),
      { status: 200 },
    );
  await assert.rejects(
    async () =>
      await readTagRef('o/r', 'v1', {
        baseDelayMs: 0,
        deadlineMs: 100,
        maxAttempts: 1,
        fetchImpl,
      }),
    /malformed metadata/u,
  );
});

test('operation budget clamps to the release hard deadline and rejects expiry', () => {
  const budget = createGitHubOperationBudget({
    defaultWindowMs: 100_000,
    environment: {
      OLIPHAUNT_GITHUB_HARD_DEADLINE_RESERVE_MS: '1000',
      REGISTRY_JOB_HARD_DEADLINE_EPOCH: '12',
    },
    now: () => 10_000,
  });
  assert.equal(budget.deadlineMs, 11_000);
  assert.throws(
    () =>
      createGitHubOperationBudget({
        environment: {
          OLIPHAUNT_GITHUB_HARD_DEADLINE_RESERVE_MS: '1000',
          REGISTRY_JOB_HARD_DEADLINE_EPOCH: '11',
        },
        now: () => 10_000,
      }),
    /already expired/u,
  );
});

test('journal lock admission cannot erode the complete mutation transport timeout', async (t) => {
  const { environment, root } = journalFixture();
  delete environment.GITHUB_ACTIONS;
  t.after(() => rmSync(root, { force: true, recursive: true }));
  const journal = environment.OLIPHAUNT_GITHUB_CORE_REQUEST_JOURNAL_PATH;
  const lock = `${journal}.lock`;
  writeFileSync(lock, 'occupied\n');
  let nowMs = 1_000;
  let spawned = false;
  await assert.rejects(
    async () =>
      await requestGithubMutation('repos/o/r/git/refs', {
        method: 'POST',
        coreJournalOptions: {
          now: () => nowMs,
          sleep: (delayMs) => {
            nowMs += delayMs;
            rmSync(lock, { force: true });
          },
        },
        deadlineMs: 1_075,
        environment,
        input: JSON.stringify({ ref: 'refs/tags/v1', sha: 'a'.repeat(40) }),
        now: () => nowMs,
        fetchImpl: () => {
          spawned = true;
          return new Response('');
        },
        timeoutMs: 50,
      }),
    /complete 50ms transport timeout after request-journal admission/u,
  );
  assert.equal(spawned, false);
  assert.deepEqual(readGitHubCoreRequestJournal({ environment, now: () => nowMs }), {
    enabled: true,
    rollingCount: 1,
    sequence: 1,
  });
});

test('asset upload streams frozen bytes to an exact release id and rejects changed identities', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'github-upload-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'asset+linux.tgz');
  const bytes = Buffer.from([0, 255, 127, 10]);
  writeFileSync(file, bytes);
  const endpoint =
    'https://uploads.github.com/repos/o/r/releases/123/assets?name=asset%2Blinux.tgz';
  let calls = 0;
  const fetchImpl = async (url, options) => {
    calls++;
    assert.equal(url, endpoint);
    assert.equal(options.method, 'POST');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers['Content-Length'], String(bytes.length));
    assert.equal(options.headers.Authorization, 'Bearer fixture-token');
    assert.equal(options.headers['Content-Type'], 'application/octet-stream');
    assert.equal(options.headers['X-GitHub-Api-Version'], '2022-11-28');
    assert.ok(options.signal instanceof AbortSignal);
    const chunks = [];
    for await (const chunk of options.body) chunks.push(chunk);
    assert.deepEqual(Buffer.concat(chunks), bytes);
    return Response.json({ id: 42 });
  };
  const options = {
    file,
    method: 'POST',
    environment: { GH_TOKEN: 'fixture-token' },
    fetchImpl,
    timeoutMs: 1_000,
  };
  assert.equal(await requestGithubMutation(endpoint, options), '{"id":42}');
  for (const [url, changed] of [
    [endpoint.replace('/123/', '/tags/v1/'), {}],
    [endpoint.replace('uploads.github.com', 'example.invalid'), {}],
    [endpoint.replace('https://', 'https://secret@'), {}],
    [endpoint + '#fragment', {}],
    [endpoint + '&name=other.tgz', {}],
    [endpoint, { method: 'DELETE' }],
    [endpoint, { input: '{}' }],
    [endpoint, { file: path.join(root, 'other.tgz') }],
  ])
    await assert.rejects(
      async () => await requestGithubMutation(url, { ...options, ...changed }),
      /mutation|upload|repository|asset/u,
    );
  assert.equal(calls, 1);
});

test('lifecycle writes admit only exact additive label transitions', async () => {
  const endpoint = 'repos/o/r/issues/99/labels';
  const deletion = endpoint + '/autorelease%3A%20pending';
  const input = JSON.stringify({ labels: ['autorelease: tagged'] });
  const observed = [];
  const options = {
    environment: {},
    timeoutMs: 123,
    fetchImpl: (url, init) => {
      observed.push([url, init.method, init.body]);
      assert.equal(init.redirect, 'error');
      assert.equal(init.headers.Authorization, undefined);
      return new Response('[]');
    },
  };
  await requestGithubMutation(endpoint, { ...options, method: 'POST', input });
  await requestGithubMutation(deletion, { ...options, method: 'DELETE' });
  assert.deepEqual(observed, [
    ['https://api.github.com/' + endpoint, 'POST', input],
    ['https://api.github.com/' + deletion, 'DELETE', undefined],
  ]);
  for (const [url, changed] of [
    [endpoint, { method: 'PUT', input }],
    [endpoint.replace('/99/', '/0/'), { method: 'POST', input }],
    [
      endpoint,
      {
        method: 'POST',
        input: JSON.stringify({ labels: ['autorelease: pending', 'autorelease: tagged'] }),
      },
    ],
    [endpoint, { method: 'POST', input: JSON.stringify({ labels: ['reviewed'] }) }],
    [
      endpoint,
      {
        method: 'POST',
        input: JSON.stringify({ labels: ['autorelease: tagged', 'autorelease: tagged'] }),
      },
    ],
    [
      endpoint,
      { method: 'POST', input: JSON.stringify({ labels: ['autorelease: tagged'], extra: true }) },
    ],
    [deletion, { method: 'DELETE', input: '{}' }],
    [deletion, { method: 'POST' }],
    [deletion.replace('autorelease%3A%20pending', 'reviewed'), { method: 'DELETE' }],
  ])
    await assert.rejects(
      async () => await requestGithubMutation(url, { ...options, ...changed }),
      /mutation|lifecycle|payload|allowlist/u,
    );
  assert.equal(observed.length, 2);
});

test('mutation HTTP failures never replay a write and bound response bytes', async () => {
  const endpoint = 'repos/o/r/git/refs';
  const base = {
    environment: { GH_TOKEN: 'fixture-secret' },
    method: 'POST',
    input: JSON.stringify({ ref: 'refs/tags/v1', sha: 'a'.repeat(40) }),
    timeoutMs: 1_000,
  };
  let calls = 0;
  for (const response of [
    new Response('fixture-secret', { status: 503 }),
    new Response('', { headers: { 'content-length': String(4 * 1024 * 1024 + 1) } }),
  ]) {
    await assert.rejects(
      async () =>
        await requestGithubMutation(endpoint, {
          ...base,
          fetchImpl: () => {
            calls++;
            return response;
          },
        }),
      (error) => {
        assert.ok(!String(error.detail ?? error.message).includes('fixture-secret'));
        return /HTTP 503|exceeds/u.test(error.message);
      },
    );
  }
  assert.equal(calls, 2);
});

test('a shared abort guard is rechecked after pacing and journal admission before transport', async () => {
  let guardCalls = 0;
  let spawned = false;
  await assert.rejects(
    async () =>
      await requestGithubMutation('repos/o/r/git/refs', {
        method: 'POST',
        assertMutationAllowed: () => {
          guardCalls += 1;
          if (guardCalls === 2) throw new Error('peer upload failed');
        },
        environment: {},
        input: JSON.stringify({ ref: 'refs/tags/v1', sha: 'a'.repeat(40) }),
        fetchImpl: () => {
          spawned = true;
          return new Response('');
        },
        timeoutMs: 123,
      }),
    /peer upload failed/u,
  );
  assert.equal(guardCalls, 2);
  assert.equal(spawned, false);
});
