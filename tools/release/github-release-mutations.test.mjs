#!/usr/bin/env bun
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createGitHubOperationBudget,
  githubPaginatedArrayReadSync,
  githubJsonReadSync,
  githubOptionalJsonReadSync,
  isExplicitGitHubNotFound,
  readReleaseMapSync,
  readTagRefSync,
  reconcileGitHubMutationSync,
  runGitHubMutationSync,
} from "./github-release-mutations.mjs";
import { readGitHubCoreRequestJournal } from "./github-core-request-journal.mjs";

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
  const root = mkdtempSync(path.join(os.tmpdir(), "oliphaunt-paginated-read-"));
  return {
    environment: {
      GITHUB_ACTIONS: "true",
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
      target_commitish: "a".repeat(40),
    };
  });
}

function includedJson(data, link = "") {
  return [
    "HTTP/2.0 200 OK",
    "Content-Type: application/json; charset=utf-8",
    ...(link === "" ? [] : [`Link: ${link}`]),
    "",
    JSON.stringify(data),
  ].join("\n");
}

function deterministicReadOptions(environment, spawn) {
  return {
    baseDelayMs: 0,
    coreJournalOptions: { now: () => 20_000 },
    deadlineMs: 1_000,
    environment,
    maxAttempts: 2,
    maxDelayMs: 0,
    now: () => 20_000,
    sleep: () => {},
    spawn,
  };
}

test("a successful mutation is followed by exact-state reconciliation", () => {
  let present = false;
  let mutationCalls = 0;
  const result = reconcileGitHubMutationSync({
    inspect: () => ({ kind: present ? "desired" : "absent" }),
    label: "create tag",
    mutate: () => {
      mutationCalls += 1;
      present = true;
    },
    options: { ...deterministic, budget: fixedBudget() },
  });
  assert.equal(mutationCalls, 1);
  assert.deepEqual(result, { mutationAttempts: 1, recovered: false });
});

test("pre-send failure retries only after a fresh read proves absence", () => {
  let present = false;
  let mutationCalls = 0;
  let inspections = 0;
  const result = reconcileGitHubMutationSync({
    inspect: () => {
      inspections += 1;
      return { kind: present ? "desired" : "absent" };
    },
    label: "create release",
    mutate: () => {
      mutationCalls += 1;
      if (mutationCalls === 1) throw new Error("connect failed before request write");
      present = true;
    },
    options: { ...deterministic, budget: fixedBudget() },
  });
  assert.equal(mutationCalls, 2);
  assert.ok(inspections >= 4, "state is inspected before and after each attempted mutation");
  assert.deepEqual(result, { mutationAttempts: 2, recovered: false });
});

test("an applied mutation followed by timeout is accepted without duplicate replay", () => {
  let present = false;
  let mutationCalls = 0;
  const result = reconcileGitHubMutationSync({
    inspect: () => ({ kind: present ? "desired" : "absent" }),
    label: "upload asset",
    mutate: () => {
      mutationCalls += 1;
      present = true;
      throw new Error("socket timed out after sending the response body");
    },
    options: { ...deterministic, budget: fixedBudget() },
  });
  assert.equal(mutationCalls, 1);
  assert.deepEqual(result, { mutationAttempts: 1, recovered: true });
});

test("pre-existing desired state resumes without issuing a mutation", () => {
  let mutationCalls = 0;
  const result = reconcileGitHubMutationSync({
    inspect: () => ({ kind: "desired" }),
    label: "promote release",
    mutate: () => {
      mutationCalls += 1;
    },
    options: { ...deterministic, budget: fixedBudget() },
  });
  assert.equal(mutationCalls, 0);
  assert.deepEqual(result, { mutationAttempts: 0, recovered: false });
});

test("conflicting post-mutation state is terminal", () => {
  let state = "absent";
  let mutationCalls = 0;
  assert.throws(
    () => reconcileGitHubMutationSync({
      inspect: () => state === "conflict"
        ? { detail: "tag points at another full SHA", kind: "conflict" }
        : { kind: state },
      label: "create tag",
      mutate: () => {
        mutationCalls += 1;
        state = "conflict";
        throw new Error("HTTP 422");
      },
      options: { ...deterministic, budget: fixedBudget() },
    }),
    /tag points at another full SHA/u,
  );
  assert.equal(mutationCalls, 1);
});

for (const [label, readError] of [
  ["auth", new Error("HTTP 401 bad credentials")],
  ["malformed", new Error("successful response contained malformed JSON")],
]) {
  test(`${label} failure during ambiguous reconciliation never replays the mutation`, () => {
    let inspections = 0;
    let mutationCalls = 0;
    assert.throws(
      () => reconcileGitHubMutationSync({
        inspect: () => {
          inspections += 1;
          if (inspections > 1) throw readError;
          return { kind: "absent" };
        },
        label: "create release",
        mutate: () => {
          mutationCalls += 1;
          throw new Error("ambiguous timeout");
        },
        options: { ...deterministic, budget: fixedBudget() },
      }),
      new RegExp(readError.message, "u"),
    );
    assert.equal(mutationCalls, 1);
  });
}

test("the shared deadline stops replay even when mutation attempts remain", () => {
  let nowMs = 0;
  let mutationCalls = 0;
  assert.throws(
    () => reconcileGitHubMutationSync({
      inspect: () => ({ kind: "absent" }),
      label: "create release",
      mutate: () => {
        mutationCalls += 1;
        nowMs = 99;
        throw new Error("pre-send failure");
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

test("mutation diagnostics redact credentials", () => {
  const token = "github_pat_123456789012345678901234567890";
  assert.throws(
    () => reconcileGitHubMutationSync({
      inspect: () => ({ kind: "absent" }),
      label: "create release",
      mutate: () => {
        const cause = new Error("upload failed");
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
    (cause) => !cause.message.includes(token) && cause.message.includes("<redacted>"),
  );
});

test("only an explicit HTTP 404 is classified as absence", () => {
  const notFound = new Error("read failed", { cause: Object.assign(new Error("gh failed"), {
    detail: "gh: Not Found (HTTP 404)",
  }) });
  assert.equal(isExplicitGitHubNotFound(notFound), true);
  assert.equal(isExplicitGitHubNotFound(new Error("HTTP 401 bad credentials")), false);
  assert.equal(isExplicitGitHubNotFound(new Error("repository was not found in local cache")), false);
});

test("optional reads distinguish 404 from auth and malformed successful JSON", () => {
  const spawn404 = () => ({ status: 1, stderr: "gh: Not Found (HTTP 404)", stdout: "" });
  assert.equal(githubOptionalJsonReadSync(["api", "repos/o/r/releases/tags/v1"], {
    baseDelayMs: 0,
    deadlineMs: 100,
    maxAttempts: 1,
    spawn: spawn404,
  }), null);

  const spawnAuth = () => ({ status: 1, stderr: "gh: Bad credentials (HTTP 401)", stdout: "" });
  assert.throws(
    () => githubOptionalJsonReadSync(["api", "repos/o/r/releases/tags/v1"], {
      baseDelayMs: 0,
      deadlineMs: 100,
      maxAttempts: 1,
      spawn: spawnAuth,
    }),
    /401|credentials/iu,
  );

  const spawnMalformed = () => ({ status: 0, stderr: "", stdout: "{" });
  assert.throws(
    () => githubJsonReadSync(["api", "repos/o/r/releases"], {
      baseDelayMs: 0,
      deadlineMs: 100,
      maxAttempts: 1,
      spawn: spawnMalformed,
    }),
    /malformed JSON/u,
  );
});

test("an exact 100-row release page stops from Link metadata without an empty trailing request", (t) => {
  const { environment, root } = journalFixture();
  t.after(() => rmSync(root, { force: true, recursive: true }));
  const endpoints = [];
  const releases = readReleaseMapSync("o/r", deterministicReadOptions(environment, (_command, args) => {
    endpoints.push(args.at(-1));
    return { status: 0, stderr: "", stdout: includedJson(releaseRows(1, 100)) };
  }));
  assert.equal(releases.size, 100);
  assert.deepEqual(endpoints, ["repos/o/r/releases?per_page=100&page=1"]);
  assert.deepEqual(
    readGitHubCoreRequestJournal({ environment, now: () => 20_000 }),
    { enabled: true, rollingCount: 1, sequence: 1 },
  );
});

test("each paginated REST page retry is independently journaled and exact 200 rows stop at page two", (t) => {
  const { environment, root } = journalFixture();
  t.after(() => rmSync(root, { force: true, recursive: true }));
  const endpoints = [];
  let pageTwoAttempts = 0;
  const releases = readReleaseMapSync("o/r", deterministicReadOptions(environment, (_command, args) => {
    const endpoint = args.at(-1);
    endpoints.push(endpoint);
    if (endpoint.endsWith("page=1")) {
      const next = "https://api.github.com/repositories/42/releases?per_page=100&page=2";
      const last = "https://api.github.com/repositories/42/releases?per_page=100&page=2";
      return {
        status: 0,
        stderr: "",
        stdout: includedJson(
          releaseRows(1, 100),
          `<${next}>; rel="next", <${last}>; rel="last"`,
        ),
      };
    }
    pageTwoAttempts += 1;
    if (pageTwoAttempts === 1) {
      return { status: 1, stderr: "gh: transient failure (HTTP 503)", stdout: "" };
    }
    return { status: 0, stderr: "", stdout: includedJson(releaseRows(101, 100)) };
  }));
  assert.equal(releases.size, 200);
  assert.deepEqual(endpoints, [
    "repos/o/r/releases?per_page=100&page=1",
    "repos/o/r/releases?per_page=100&page=2",
    "repos/o/r/releases?per_page=100&page=2",
  ]);
  assert.deepEqual(
    readGitHubCoreRequestJournal({ environment, now: () => 20_000 }),
    { enabled: true, rollingCount: 3, sequence: 3 },
  );
});

test("paginated reads reject cross-endpoint and query-mutating next links", () => {
  const invoke = (next) => githubPaginatedArrayReadSync("o/r", "releases", {
    baseDelayMs: 0,
    deadlineMs: 100,
    maxAttempts: 1,
    spawn: () => ({
      status: 0,
      stderr: "",
      stdout: includedJson(releaseRows(1, 100), `<${next}>; rel="next"`),
    }),
  });
  assert.throws(
    () => invoke("https://api.github.com/repositories/42/issues?per_page=100&page=2"),
    /changed repository or endpoint/u,
  );
  assert.throws(
    () => invoke("https://api.github.com/repositories/42/releases?per_page=100&page=2&extra=true"),
    /changed the exact page query/u,
  );
});

test("malformed tag-ref metadata fails closed", () => {
  const spawn = () => ({
    status: 0,
    stderr: "",
    stdout: JSON.stringify({ object: { sha: "a".repeat(40), type: "commit" }, ref: "refs/heads/main" }),
  });
  assert.throws(
    () => readTagRefSync("o/r", "v1", {
      baseDelayMs: 0,
      deadlineMs: 100,
      maxAttempts: 1,
      spawn,
    }),
    /malformed metadata/u,
  );
});

test("operation budget clamps to the release hard deadline and rejects expiry", () => {
  const budget = createGitHubOperationBudget({
    defaultWindowMs: 100_000,
    environment: {
      OLIPHAUNT_GITHUB_HARD_DEADLINE_RESERVE_MS: "1000",
      REGISTRY_JOB_HARD_DEADLINE_EPOCH: "12",
    },
    now: () => 10_000,
  });
  assert.equal(budget.deadlineMs, 11_000);
  assert.throws(
    () => createGitHubOperationBudget({
      environment: {
        OLIPHAUNT_GITHUB_HARD_DEADLINE_RESERVE_MS: "1000",
        REGISTRY_JOB_HARD_DEADLINE_EPOCH: "11",
      },
      now: () => 10_000,
    }),
    /already expired/u,
  );
});

test("journal lock admission cannot erode the complete mutation transport timeout", (t) => {
  const { environment, root } = journalFixture();
  delete environment.GITHUB_ACTIONS;
  t.after(() => rmSync(root, { force: true, recursive: true }));
  const journal = environment.OLIPHAUNT_GITHUB_CORE_REQUEST_JOURNAL_PATH;
  const lock = `${journal}.lock`;
  writeFileSync(lock, "occupied\n");
  let nowMs = 1_000;
  let spawned = false;
  assert.throws(
    () => runGitHubMutationSync(
      ["api", "repos/o/r/git/refs", "-X", "POST", "--input", "-"],
      {
        coreJournalOptions: {
          now: () => nowMs,
          sleep: (delayMs) => {
            nowMs += delayMs;
            rmSync(lock, { force: true });
          },
        },
        deadlineMs: 1_075,
        environment,
        input: JSON.stringify({ ref: "refs/tags/v1", sha: "a".repeat(40) }),
        now: () => nowMs,
        spawn: () => {
          spawned = true;
          return { status: 0, stderr: "", stdout: "" };
        },
        timeoutMs: 50,
      },
    ),
    /complete 50ms transport timeout after request-journal admission/u,
  );
  assert.equal(spawned, false);
  assert.deepEqual(
    readGitHubCoreRequestJournal({ environment, now: () => nowMs }),
    { enabled: true, rollingCount: 1, sequence: 1 },
  );
});

test("mutation command helper rejects moving-tag uploads and accepts only an exact release-id upload", () => {
  assert.throws(
    () => runGitHubMutationSync(
      ["release", "upload", "v1", "asset.tgz", "--clobber", "--repo", "o/r"],
      { spawn: () => ({ status: 0, stderr: "", stdout: "" }), timeoutMs: 123 },
    ),
    /only permits an exact GitHub API release mutation/u,
  );
  assert.throws(
    () => runGitHubMutationSync(
      ["release", "upload", "v1", "asset.tgz", "--repo", "o/r"],
      { spawn: () => ({ status: 0, stderr: "", stdout: "" }), timeoutMs: 123 },
    ),
    /only permits an exact GitHub API release mutation/u,
  );
  let observed;
  const args = [
    "api",
    "https://uploads.github.com/repos/o/r/releases/123/assets?name=asset.tgz",
    "-X",
    "POST",
    "-H",
    "Accept: application/vnd.github+json",
    "-H",
    "Content-Type: application/octet-stream",
    "-H",
    "X-GitHub-Api-Version: 2022-11-28",
    "--input",
    "/tmp/asset.tgz",
  ];
  runGitHubMutationSync(
    args,
    {
      environment: {},
      spawn: (_command, args) => {
        observed = args;
        return { status: 0, stderr: "", stdout: "" };
      },
      timeoutMs: 123,
    },
  );
  assert.deepEqual(observed, args);
  assert.throws(
    () => runGitHubMutationSync(
      [...args.slice(0, 2), "-X", "DELETE", ...args.slice(4)],
      { spawn: () => ({ status: 0, stderr: "", stdout: "" }), timeoutMs: 123 },
    ),
    /exact-ID binary request/u,
  );
});

test("a shared abort guard is rechecked after pacing and journal admission before transport", () => {
  let guardCalls = 0;
  let spawned = false;
  assert.throws(
    () => runGitHubMutationSync(
      ["api", "repos/o/r/git/refs", "-X", "POST", "--input", "-"],
      {
        assertMutationAllowed: () => {
          guardCalls += 1;
          if (guardCalls === 2) throw new Error("peer upload failed");
        },
        environment: {},
        input: JSON.stringify({ ref: "refs/tags/v1", sha: "a".repeat(40) }),
        spawn: () => {
          spawned = true;
          return { status: 0, stderr: "", stdout: "" };
        },
        timeoutMs: 123,
      },
    ),
    /peer upload failed/u,
  );
  assert.equal(guardCalls, 2);
  assert.equal(spawned, false);
});
