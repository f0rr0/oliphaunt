#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "../test/fd-backed-spawn-sync.mjs";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  GitHubReadError,
  RetryableReadError,
  githubReadOptionsFromEnv,
  redactGitHubReadDetail,
  retryReadOperationSync,
  runGitHubGraphqlReadSync,
  runGitHubPaginatedJsonSync,
  runGitHubReadSync,
} from "./github-read.mjs";
import { readGitHubCoreRequestJournal } from "./github-core-request-journal.mjs";

function deterministic(overrides = {}) {
  let time = 1_000;
  return {
    attemptTimeoutMs: 50,
    baseDelayMs: 10,
    deadlineMs: 1_000,
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
      GITHUB_REPOSITORY: "o/r",
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_RUN_ID: "123",
      GITHUB_SHA: "a".repeat(40),
      OLIPHAUNT_GITHUB_CORE_REQUEST_JOURNAL_PATH: path.join(root, "journal.json"),
      OLIPHAUNT_REQUIRE_GITHUB_CORE_REQUEST_JOURNAL: "true",
    },
    root,
  };
}

test("bounded read retries a transient failure and returns the successful result", () => {
  const attempts = [];
  const retries = [];
  const result = retryReadOperationSync(
    "artifact inventory",
    ({ attempt, attemptTimeoutMs }) => {
      attempts.push([attempt, attemptTimeoutMs]);
      if (attempt === 1) throw new Error("HTTP 503 temporary failure");
      return "complete";
    },
    deterministic({ onRetry: (event) => retries.push([event.attempt, event.delayMs]) }),
  );
  assert.equal(result, "complete");
  assert.deepEqual(attempts, [[1, 50], [2, 50]]);
  assert.deepEqual(retries, [[1, 10]]);
});

test("permanent authentication and usage failures never consume the retry budget", () => {
  let attempts = 0;
  assert.throws(
    () => retryReadOperationSync(
      "run metadata",
      () => {
        attempts += 1;
        const error = new Error("HTTP 401 Bad credentials");
        error.status = 1;
        throw error;
      },
      deterministic(),
    ),
    (error) => error instanceof GitHubReadError && error.retryable === false && error.attempts === 1,
  );
  assert.equal(attempts, 1);
});

test("rate-limited HTTP 403 reads remain retryable but ordinary forbidden reads do not", () => {
  let attempts = 0;
  const result = retryReadOperationSync(
    "rate-limited inventory",
    () => {
      attempts += 1;
      if (attempts === 1) throw new Error("HTTP 403 secondary rate limit exceeded");
      return "ok";
    },
    deterministic(),
  );
  assert.equal(result, "ok");
  assert.equal(attempts, 2);
  assert.throws(
    () => retryReadOperationSync(
      "forbidden inventory",
      () => {
        throw new Error("HTTP 403 Resource not accessible by integration");
      },
      deterministic(),
    ),
    (error) => error.retryable === false && error.attempts === 1,
  );
});

test("retry budget and overall deadline are independent fail-closed bounds", () => {
  let budgetAttempts = 0;
  assert.throws(
    () => retryReadOperationSync(
      "workflow search",
      () => {
        budgetAttempts += 1;
        throw new RetryableReadError("socket hang up");
      },
      deterministic({ maxAttempts: 3 }),
    ),
    (error) => error.retryable === true && error.attempts === 3 && /retry budget exhausted/u.test(error.message),
  );
  assert.equal(budgetAttempts, 3);

  let time = 5_000;
  let deadlineAttempts = 0;
  assert.throws(
    () => retryReadOperationSync(
      "artifact download",
      () => {
        deadlineAttempts += 1;
        time += 25;
        throw new RetryableReadError("unexpected EOF");
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

test("GitHub CLI wrapper applies a per-attempt timeout and retries read-only commands", () => {
  const calls = [];
  const spawn = (command, args, options) => {
    calls.push({ args, command, timeout: options.timeout });
    if (calls.length === 1) {
      return { error: undefined, status: 1, stderr: "HTTP 502", stdout: "partial-secret-output" };
    }
    return { error: undefined, status: 0, stderr: "", stdout: '[{"databaseId":9}]' };
  };
  const output = runGitHubReadSync(
    ["run", "list", "--repo", "f0rr0/oliphaunt", "--json", "databaseId"],
    { ...deterministic(), label: "CI run list", spawn },
  );
  assert.equal(output, '[{"databaseId":9}]');
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map(({ timeout }) => timeout), [50, 50]);
});

test("binary GitHub reads retain non-UTF-8 bytes from a successful delayed final write", (t) => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), "oliphaunt-github-binary-capture-"));
  t.after(() => rmSync(temporary, { force: true, recursive: true }));
  const gh = path.join(temporary, "gh");
  writeFileSync(gh, [
    `#!${process.execPath}`,
    "process.stdout.write(Buffer.from([0x00, 0xff]));",
    "setImmediate(() => process.stdout.write(Buffer.from([0x7f, 0x0a])));",
    "",
  ].join("\n"), { mode: 0o755 });
  const output = runGitHubReadSync(
    ["run", "download", "123"],
    {
      ...deterministic({ attemptTimeoutMs: 1_000, deadlineMs: 5_000, maxAttempts: 1 }),
      binary: true,
      environment: {
        HOME: process.env.HOME ?? temporary,
        PATH: `${temporary}${path.delimiter}${process.env.PATH ?? ""}`,
      },
    },
  );
  assert.deepEqual(output, Buffer.from([0x00, 0xff, 0x7f, 0x0a]));
});

test("journal admission delay clamps the read transport to the live deadline remainder", (t) => {
  const { environment } = journalFixture(t, "clamp");
  const journal = environment.OLIPHAUNT_GITHUB_CORE_REQUEST_JOURNAL_PATH;
  const lock = `${journal}.lock`;
  writeFileSync(lock, "occupied\n");
  let nowMs = 1_000;
  let observedTimeout;
  const output = runGitHubReadSync(
    ["api", "repos/o/r/releases"],
    {
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
      spawn: (_command, _args, options) => {
        observedTimeout = options.timeout;
        return { status: 0, stderr: "", stdout: "[]" };
      },
    },
  );
  assert.equal(output, "[]");
  assert.equal(observedTimeout, 75);
});

test("journal admission that exhausts the read deadline never starts transport", (t) => {
  const { environment } = journalFixture(t, "expiry");
  const journal = environment.OLIPHAUNT_GITHUB_CORE_REQUEST_JOURNAL_PATH;
  const lock = `${journal}.lock`;
  writeFileSync(lock, "occupied\n");
  let nowMs = 1_000;
  let spawned = false;
  assert.throws(
    () => runGitHubReadSync(
      ["api", "repos/o/r/releases"],
      {
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
        spawn: () => {
          spawned = true;
          return { status: 0, stderr: "", stdout: "[]" };
        },
      },
    ),
    (error) => error instanceof GitHubReadError
      && error.deadlineExhausted === true
      && error.attempts === 1,
  );
  assert.equal(spawned, false);
  assert.deepEqual(
    readGitHubCoreRequestJournal({ environment, now: () => nowMs }),
    { enabled: true, rollingCount: 1, sequence: 1 },
  );
});

test("GitHub CLI wrapper refuses mutation-shaped commands before spawning", () => {
  let spawned = false;
  const spawn = () => {
    spawned = true;
  };
  for (const args of [
    ["api", "repos/f0rr0/oliphaunt/releases", "--method", "POST"],
    ["api", "repos/f0rr0/oliphaunt/releases", "--method=POST"],
    ["api", "repos/f0rr0/oliphaunt/releases", "--field=name=value"],
    ["api", "repos/f0rr0/oliphaunt/releases", "-Fname=value"],
    ["api", "repos/f0rr0/oliphaunt/releases", "--raw-field=name=value"],
    ["api", "repos/f0rr0/oliphaunt/releases", "-fname=value"],
    ["api", "repos/f0rr0/oliphaunt/releases", "--input=-"],
    ["api", "repos/f0rr0/oliphaunt/releases", "-XPOST"],
    ["release", "delete", "v1"],
    ["api", "graphql"],
    ["api", "https://example.invalid/repos/f0rr0/oliphaunt"],
    ["api", "repos/f0rr0/oliphaunt", "--hostname", "example.invalid"],
    ["api", "repos/f0rr0/oliphaunt", "-H", "Authorization: Bearer secret"],
    ["api", "repos/f0rr0/oliphaunt/releases", "--paginate"],
    ["api", "repos/f0rr0/oliphaunt/releases", "--slurp"],
    ["api", "repos/f0rr0/oliphaunt", "repos/other/repository"],
    ["api", "repos/f0rr0/oliphaunt/%2e%2e/actions/runs"],
    ["run", "view", "1", "--hostname=example.invalid"],
  ]) {
    assert.throws(
      () => runGitHubReadSync(args, { ...deterministic(), spawn }),
      /refuses|allowlist|requires|traversal/u,
    );
  }
  assert.equal(spawned, false);
});

test("narrow GraphQL reads are query-only, journaled, and built from scalar variables", (t) => {
  const { environment } = journalFixture(t, "graphql");
  const document = `
query ReleaseControls($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    nameWithOwner
  }
}`;
  let observedArgs;
  const output = runGitHubGraphqlReadSync(
    document,
    { owner: "f0rr0", name: "oliphaunt" },
    {
      ...deterministic(),
      coreJournalOptions: { now: () => 1_000 },
      environment,
      spawn: (_command, args) => {
        observedArgs = args;
        return { status: 0, stderr: "", stdout: '{"data":{"repository":{"nameWithOwner":"f0rr0/oliphaunt"}}}' };
      },
    },
  );
  assert.match(output, /f0rr0\/oliphaunt/u);
  assert.deepEqual(observedArgs, [
    "api",
    "graphql",
    "-f",
    `query=${document}`,
    "-f",
    "name=oliphaunt",
    "-f",
    "owner=f0rr0",
  ]);
  assert.deepEqual(
    readGitHubCoreRequestJournal({ environment, now: () => 1_000 }),
    { enabled: true, rollingCount: 1, sequence: 1 },
  );
});

test("narrow GraphQL reads reject non-query documents and unsafe variables before spawning", () => {
  let spawned = false;
  const options = { ...deterministic(), spawn: () => { spawned = true; } };
  for (const document of [
    "mutation Bad { viewer { login } }",
    "subscription Bad { viewer { login } }",
    "{ viewer { login } }",
    "query One { viewer { login } } query Two { viewer { login } }",
    'query Literal { repository(owner: "f0rr0", name: "oliphaunt") { name } }',
  ]) {
    assert.throws(
      () => runGitHubGraphqlReadSync(document, {}, options),
      /exactly one named query|query document/u,
    );
  }
  for (const variables of [
    [],
    { owner: 42 },
    { owner: "bad\nvalue" },
    { "bad-name": "value" },
  ]) {
    assert.throws(
      () => runGitHubGraphqlReadSync("query Safe { viewer { login } }", variables, options),
      /variables|variable/u,
    );
  }
  assert.equal(spawned, false);
});

test("journal-aware envelope pagination owns page queries and follows an exact next Link", () => {
  const calls = [];
  const firstPage = Array.from({ length: 100 }, (_, index) => ({ id: index + 1 }));
  const secondPage = [{ id: 101 }];
  const spawn = (_command, args) => {
    calls.push(args);
    const page = calls.length;
    const link = page === 1
      ? '<https://api.github.com/repositories/123/actions/runs/9/jobs?filter=latest&per_page=100&page=2>; rel="next"'
      : "";
    return {
      status: 0,
      stderr: "",
      stdout: `HTTP/2.0 200 OK\n${link === "" ? "" : `Link: ${link}\n`}\n${JSON.stringify({
        jobs: page === 1 ? firstPage : secondPage,
      })}`,
    };
  };
  const rows = runGitHubPaginatedJsonSync(
    "repos/f0rr0/oliphaunt/actions/runs/9/jobs?filter=latest",
    {
      ...deterministic(),
      itemsField: "jobs",
      spawn,
    },
  );
  assert.equal(rows.length, 101);
  assert.deepEqual(calls, [
    ["api", "--include", "repos/f0rr0/oliphaunt/actions/runs/9/jobs?filter=latest&per_page=100&page=1"],
    ["api", "--include", "repos/f0rr0/oliphaunt/actions/runs/9/jobs?filter=latest&per_page=100&page=2"],
  ]);
});

test("diagnostics redact tokens, authorization headers, query credentials, and URL userinfo", () => {
  const secret = "github_pat_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  const rendered = redactGitHubReadDetail(
    `Authorization: Bearer ${secret}\nhttps://user:pass@example.invalid/a?token=${secret}\n${secret}`,
    { GH_TOKEN: secret },
  );
  assert.equal(rendered.includes(secret), false);
  assert.match(rendered, /<redacted>/u);
  assert.equal(rendered.includes("user:pass"), false);
});

test("environment and override settings enforce fixed retry, timeout, and memory bounds", () => {
  assert.throws(
    () => githubReadOptionsFromEnv({ OLIPHAUNT_GITHUB_READ_MAX_ATTEMPTS: "0" }),
    /must be between 1 and 10/u,
  );
  assert.throws(
    () => githubReadOptionsFromEnv({ OLIPHAUNT_GITHUB_READ_DEADLINE_MS: "0" }),
    /must be between 1 and 3600000/u,
  );
  assert.throws(
    () => githubReadOptionsFromEnv({
      OLIPHAUNT_GITHUB_READ_BASE_DELAY_MS: "10",
      OLIPHAUNT_GITHUB_READ_MAX_DELAY_MS: "9",
    }),
    /must be at least/u,
  );
  assert.throws(
    () => githubReadOptionsFromEnv({ OLIPHAUNT_GITHUB_READ_MAX_ATTEMPTS: "11" }),
    /between 1 and 10/u,
  );
  assert.throws(
    () => githubReadOptionsFromEnv({}, { deadlineMs: 60 * 60_000 + 1 }),
    /deadlineMs must be between/u,
  );
  assert.throws(
    () => runGitHubReadSync(
      ["api", "repos/f0rr0/oliphaunt"],
      { ...deterministic(), maxBuffer: 128 * 1024 * 1024 + 1, spawn: () => ({ status: 0 }) },
    ),
    /maxBuffer must be between/u,
  );
});

test("CLI entrypoint runs through Bun with both repository-relative and absolute script paths", (t) => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), "oliphaunt-github-read-cli-"));
  t.after(() => rmSync(temporary, { force: true, recursive: true }));
  const gh = path.join(temporary, "gh");
  writeFileSync(gh, [
    `#!${process.execPath}`,
    "process.stdout.write('[{\"databaseId\":');",
    "setImmediate(() => process.stdout.write('42}]\\n'));",
    "",
  ].join("\n"), { mode: 0o755 });
  chmodSync(gh, 0o755);
  const script = path.resolve("tools/release/github-read.mjs");
  const common = {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${temporary}${path.delimiter}${process.env.PATH}`,
      OLIPHAUNT_GITHUB_READ_BASE_DELAY_MS: "0",
      OLIPHAUNT_GITHUB_READ_MAX_DELAY_MS: "0",
    },
  };
  for (const entrypoint of [path.relative(process.cwd(), script), script]) {
    const result = spawnSync(
      process.execPath,
      [entrypoint, "--", "run", "list", "--json", "databaseId"],
      common,
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), '[{"databaseId":42}]');
  }
});
