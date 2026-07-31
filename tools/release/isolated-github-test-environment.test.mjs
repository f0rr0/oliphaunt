#!/usr/bin/env node

import assert from "node:assert/strict";
import test from "node:test";

import { isolatedGitHubTestEnvironment } from "../test/isolated-github-test-environment.mjs";

test("synthetic GitHub fixtures discard hostile credentials, state, lineage, and tuning", () => {
  const inherited = {
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: "live-oidc-token",
    BOOTSTRAP_LEDGER_PATH: "/live/bootstrap-ledger",
    CI_RUN_ID: "30358387218",
    GH_TOKEN: "live-gh-token",
    GITHUB_OUTPUT: "/live/github-output",
    GITHUB_REPOSITORY: "live/repository",
    GITHUB_RUN_ATTEMPT: "7",
    GITHUB_RUN_ID: "123",
    GITHUB_SHA: "a".repeat(40),
    GITHUB_TOKEN: "live-github-token",
    KEEP_ME: "preserved",
    OLIPHAUNT_GITHUB_CONTENT_WRITE_COLD_START_EPOCH: "1",
    OLIPHAUNT_GITHUB_CONTENT_WRITE_PACER_PATH: "/live/pacer.json",
    OLIPHAUNT_GITHUB_CONTENT_WRITE_PACER_TEST_MODE: "true",
    OLIPHAUNT_GITHUB_CORE_REQUEST_JOURNAL_PATH: "/live/journal.json",
    OLIPHAUNT_GITHUB_READ_ATTEMPT_TIMEOUT_MS: "1",
    OLIPHAUNT_GITHUB_READ_BASE_DELAY_MS: "2",
    OLIPHAUNT_GITHUB_READ_DEADLINE_MS: "3",
    OLIPHAUNT_GITHUB_READ_MAX_ATTEMPTS: "4",
    OLIPHAUNT_GITHUB_READ_MAX_DELAY_MS: "5",
    OLIPHAUNT_GITHUB_RUN_SNAPSHOT_DIR: "/live/snapshots",
    OLIPHAUNT_RELEASE_FUTURE_CONTROL: "live-future-control",
    OLIPHAUNT_RELEASE_ROOT_RUN_ID: "123",
    OLIPHAUNT_REQUIRE_GITHUB_CORE_REQUEST_JOURNAL: "true",
    RELEASE_CONTINUATION_ARCHIVE: "/live/continuation.zip",
    RELEASE_CONTINUATION_POINTER: '{"live":true}',
    RELEASE_CONTINUATION_STATE_PATH: "/live/continuation-state.json",
    RELEASE_FINALIZATION_RESERVE_SECONDS: "3000",
    RELEASE_FUTURE_CONTROL: "live-future-control",
    RELEASE_HEAD_SHA: "a".repeat(40),
    RELEASE_JOB_HARD_WINDOW_SECONDS: "21180",
    RELEASE_OPERATION: "publish",
    RELEASE_PR_TOKEN: "live-release-token",
    RELEASE_ROOT_RUN_ID: "123",
    RELEASE_TRANSPORT_CONTENT_WRITE_ADMISSION: "pre-reserved",
  };
  const environment = isolatedGitHubTestEnvironment(
    {
      BOOTSTRAP_LEDGER_PATH: "/fixture/bootstrap-ledger",
      GH_TOKEN: "fixture-token",
      GITHUB_RUN_ID: "900",
      OLIPHAUNT_GITHUB_READ_BASE_DELAY_MS: "0",
      RELEASE_HEAD_SHA: "b".repeat(40),
    },
    inherited,
  );

  assert.deepEqual(environment, {
    BOOTSTRAP_LEDGER_PATH: "/fixture/bootstrap-ledger",
    GH_TOKEN: "fixture-token",
    GITHUB_RUN_ID: "900",
    KEEP_ME: "preserved",
    OLIPHAUNT_GITHUB_READ_BASE_DELAY_MS: "0",
    RELEASE_HEAD_SHA: "b".repeat(40),
  });
  assert.deepEqual(inherited.GH_TOKEN, "live-gh-token", "the inherited environment must not be mutated");
});

test("future GitHub and release namespace entries are isolated without an enumerated denylist", () => {
  const inherited = {
    ACTIONS_FUTURE_CREDENTIAL: "live",
    GH_FUTURE_CREDENTIAL: "live",
    GITHUB_FUTURE_IDENTITY: "live",
    OLIPHAUNT_GITHUB_FUTURE_STATE: "live",
    OLIPHAUNT_RELEASE_FUTURE_STATE: "live",
    RELEASE_FUTURE_STATE: "live",
    RUNNER_TEMP: "/preserved/runner-temp",
  };

  assert.deepEqual(
    isolatedGitHubTestEnvironment({}, inherited),
    { RUNNER_TEMP: "/preserved/runner-temp" },
  );
});

test("environment isolation rejects non-object inputs instead of silently widening inheritance", () => {
  assert.throws(() => isolatedGitHubTestEnvironment([], {}), /environment overrides/u);
  assert.throws(() => isolatedGitHubTestEnvironment({}, null), /inherited environment/u);
});
