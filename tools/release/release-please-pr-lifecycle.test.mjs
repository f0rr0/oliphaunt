#!/usr/bin/env bun
import assert from "node:assert/strict";
import test from "node:test";

import {
  assertCleanReleasePleaseState,
  assertExactReleasePleasePullRequestMarkable,
  markExactReleasePleasePullRequestTagged,
  mergedPendingReleasePullRequests,
  RELEASE_PLEASE_MARK_TAGGED_MAX_MUTATION_ATTEMPTS,
  releasePleaseClosedPullRequestQuery,
  releasePleaseLabelState,
  selectExactReleasePullRequest,
} from "./release-please-pr-lifecycle.mjs";

const REPOSITORY = "f0rr0/oliphaunt";
const RELEASE_SHA = "a".repeat(40);
const ENVIRONMENT = { GITHUB_REPOSITORY: REPOSITORY };

function labels(...names) {
  return names.map((name) => ({ name }));
}

function pullRequest(overrides = {}) {
  return {
    base: { ref: "main", repo: { full_name: REPOSITORY } },
    head: {
      ref: "release-please--branches--main",
      repo: { full_name: REPOSITORY },
    },
    html_url: "https://github.com/f0rr0/oliphaunt/pull/99",
    labels: labels("autorelease: pending"),
    merge_commit_sha: RELEASE_SHA,
    merged_at: "2026-07-28T00:00:00Z",
    number: 99,
    state: "closed",
    title: "chore(release): prepare main releases",
    ...overrides,
  };
}

function taggedRepositoryLabel() {
  return { name: "autorelease: tagged" };
}

function reconciliationOptions() {
  return {
    baseDelayMs: 0,
    budget: { deadlineMs: 100_000, environment: ENVIRONMENT, now: () => 0, startedAtMs: 0 },
    maxAttempts: 2,
    sleep: () => {},
  };
}

test("merged pending preflight uses exact current REST state", () => {
  const blocker = pullRequest();
  assert.deepEqual(
    mergedPendingReleasePullRequests([blocker], { base: "main", repository: REPOSITORY }),
    [{ number: 99, url: blocker.html_url }],
  );
  assert.throws(
    () => assertCleanReleasePleaseState({
      base: "main",
      environment: ENVIRONMENT,
      listPullRequests: () => [blocker],
    }),
    /autorelease: pending: #99/u,
  );
});

test("preflight narrows exact REST pagination to the canonical Release Please head", () => {
  const query = releasePleaseClosedPullRequestQuery(REPOSITORY);
  assert.equal(query.get("base"), "main");
  assert.equal(query.get("head"), "f0rr0:release-please--branches--main");
  assert.equal(query.get("state"), "closed");
  assert.equal(query.has("labels"), false);
});

test("preflight ignores unmerged, other-base, cross-repository, and cleared PRs", () => {
  const cases = [
    pullRequest({ merged_at: null }),
    pullRequest({ base: { ref: "next", repo: { full_name: REPOSITORY } } }),
    pullRequest({ head: { ref: "release-please--branches--main", repo: { full_name: "fork/repo" } } }),
    pullRequest({ labels: [] }),
  ];
  assert.deepEqual(
    mergedPendingReleasePullRequests(cases, { base: "main", repository: REPOSITORY }),
    [],
  );
  assert.deepEqual(
    assertCleanReleasePleaseState({
      base: "main",
      environment: ENVIRONMENT,
      listPullRequests: () => cases,
    }),
    { base: "main", blockers: [], repository: REPOSITORY },
  );
});

test("preflight rejects malformed and duplicate label state", () => {
  for (const candidate of [
    pullRequest({ labels: null }),
    pullRequest({ labels: labels("autorelease: pending", "autorelease: pending") }),
    pullRequest({ labels: [{ name: "bad\nlabel" }] }),
  ]) {
    assert.throws(
      () => mergedPendingReleasePullRequests([candidate], { base: "main", repository: REPOSITORY }),
      /labels/u,
    );
  }
});

test("selects only one exact merged same-repository release PR", () => {
  const selected = selectExactReleasePullRequest([pullRequest()], {
    base: "main",
    releaseSha: RELEASE_SHA,
    repository: REPOSITORY,
  });
  assert.equal(selected.number, 99);
  for (const changed of [
    { merge_commit_sha: "b".repeat(40) },
    { merged_at: null },
    { state: "open" },
    { base: { ref: "next", repo: { full_name: REPOSITORY } } },
    { head: { ref: "other", repo: { full_name: REPOSITORY } } },
    { head: { ref: "release-please--branches--main", repo: { full_name: "fork/repo" } } },
    { title: "chore: unrelated" },
  ]) {
    assert.throws(
      () => selectExactReleasePullRequest([pullRequest(changed)], {
        base: "main",
        releaseSha: RELEASE_SHA,
        repository: REPOSITORY,
      }),
      /exactly one/u,
    );
  }
  assert.throws(
    () => selectExactReleasePullRequest([pullRequest(), pullRequest({ number: 100 })], {
      base: "main",
      releaseSha: RELEASE_SHA,
      repository: REPOSITORY,
    }),
    /found 2/u,
  );
});

test("lifecycle state preserves unrelated labels and converges to tagged only", () => {
  const state = releasePleaseLabelState(
    pullRequest({ labels: labels("reviewed", "autorelease: pending") }),
    { base: "main", releaseSha: RELEASE_SHA, repository: REPOSITORY },
  );
  assert.equal(state.kind, "unchanged");
  assert.deepEqual(state.labels, ["reviewed", "autorelease: pending"]);
  assert.deepEqual(
    releasePleaseLabelState(
      pullRequest({ labels: labels("reviewed", "autorelease: tagged") }),
      { base: "main", releaseSha: RELEASE_SHA, repository: REPOSITORY },
    ),
    { kind: "desired", labels: ["reviewed", "autorelease: tagged"] },
  );
  assert.equal(
    releasePleaseLabelState(
      pullRequest({ labels: labels("reviewed") }),
      { base: "main", releaseSha: RELEASE_SHA, repository: REPOSITORY },
    ).kind,
    "conflict",
  );
});

test("assert-markable proves exact identity, current lifecycle state, and tagged-label existence", () => {
  const result = assertExactReleasePleasePullRequestMarkable({
    environment: ENVIRONMENT,
    listAssociatedPullRequests: () => [pullRequest()],
    now: () => 0,
    readPullRequest: () => pullRequest(),
    readTaggedLabel: taggedRepositoryLabel,
    releaseSha: RELEASE_SHA,
  });
  assert.deepEqual(result, {
    number: 99,
    repository: REPOSITORY,
    state: "unchanged",
  });
  assert.throws(
    () => assertExactReleasePleasePullRequestMarkable({
      environment: ENVIRONMENT,
      listAssociatedPullRequests: () => [pullRequest()],
      now: () => 0,
      readPullRequest: () => pullRequest(),
      readTaggedLabel: () => ({ name: "other" }),
      releaseSha: RELEASE_SHA,
    }),
    /repository label .* malformed/u,
  );
});

test("mark-tagged adds then removes labels without replacing concurrent unrelated labels", () => {
  let current = pullRequest({ labels: labels("reviewed", "autorelease: pending") });
  const mutations = [];
  const result = markExactReleasePleasePullRequestTagged({
    addTaggedLabel: ({ input, number }) => {
      mutations.push({ input, kind: "add", number });
      current = pullRequest({
        labels: labels("reviewed", "urgent", "autorelease: pending", "autorelease: tagged"),
      });
    },
    base: "main",
    environment: ENVIRONMENT,
    listAssociatedPullRequests: () => [current],
    readPullRequest: () => current,
    readTaggedLabel: taggedRepositoryLabel,
    reconciliationOptions: reconciliationOptions(),
    releaseSha: RELEASE_SHA,
    removePendingLabel: ({ number }) => {
      mutations.push({ kind: "remove", number });
      current = pullRequest({
        labels: current.labels.filter(({ name }) => name !== "autorelease: pending"),
      });
    },
  });
  assert.deepEqual(result, {
    mutationAttempts: 2,
    number: 99,
    recovered: false,
    repository: REPOSITORY,
  });
  assert.deepEqual(mutations, [
    {
      input: '{"labels":["autorelease: tagged"]}\n',
      kind: "add",
      number: 99,
    },
    { kind: "remove", number: 99 },
  ]);
  assert.deepEqual(
    current.labels.map(({ name }) => name),
    ["reviewed", "urgent", "autorelease: tagged"],
  );

  const rerun = markExactReleasePleasePullRequestTagged({
    addTaggedLabel: () => assert.fail("already-tagged state must not add a label"),
    base: "main",
    environment: ENVIRONMENT,
    listAssociatedPullRequests: () => [current],
    readPullRequest: () => current,
    readTaggedLabel: taggedRepositoryLabel,
    reconciliationOptions: reconciliationOptions(),
    releaseSha: RELEASE_SHA,
    removePendingLabel: () => assert.fail("already-tagged state must not remove a label"),
  });
  assert.equal(rerun.mutationAttempts, 0);
});

test("ambiguous mutation success is recovered by exact fresh state", () => {
  let current = pullRequest();
  let addCalls = 0;
  let removeCalls = 0;
  const result = markExactReleasePleasePullRequestTagged({
    addTaggedLabel: () => {
      addCalls += 1;
      current = pullRequest({
        labels: labels("autorelease: pending", "autorelease: tagged"),
      });
      throw new Error("timeout after server accepted the additive label mutation");
    },
    environment: ENVIRONMENT,
    listAssociatedPullRequests: () => [current],
    readPullRequest: () => current,
    readTaggedLabel: taggedRepositoryLabel,
    reconciliationOptions: reconciliationOptions(),
    releaseSha: RELEASE_SHA,
    removePendingLabel: () => {
      removeCalls += 1;
      current = pullRequest({ labels: labels("autorelease: tagged") });
    },
  });
  assert.equal(addCalls, 1);
  assert.equal(removeCalls, 1);
  assert.equal(result.recovered, true);
});

test("lifecycle mutation retries are capped at the exact admission bound", () => {
  let current = pullRequest();
  let addCalls = 0;
  let removeCalls = 0;
  const result = markExactReleasePleasePullRequestTagged({
    addTaggedLabel: () => {
      addCalls += 1;
      if (addCalls === RELEASE_PLEASE_MARK_TAGGED_MAX_MUTATION_ATTEMPTS) {
        current = pullRequest({
          labels: labels("autorelease: pending", "autorelease: tagged"),
        });
      }
    },
    environment: ENVIRONMENT,
    listAssociatedPullRequests: () => [current],
    readPullRequest: () => current,
    readTaggedLabel: taggedRepositoryLabel,
    reconciliationOptions: {
      ...reconciliationOptions(),
      maxAttempts: RELEASE_PLEASE_MARK_TAGGED_MAX_MUTATION_ATTEMPTS + 2,
    },
    releaseSha: RELEASE_SHA,
    removePendingLabel: () => {
      removeCalls += 1;
      if (removeCalls === RELEASE_PLEASE_MARK_TAGGED_MAX_MUTATION_ATTEMPTS) {
        current = pullRequest({ labels: labels("autorelease: tagged") });
      }
    },
  });
  assert.equal(addCalls, RELEASE_PLEASE_MARK_TAGGED_MAX_MUTATION_ATTEMPTS);
  assert.equal(removeCalls, RELEASE_PLEASE_MARK_TAGGED_MAX_MUTATION_ATTEMPTS);
  assert.equal(
    result.mutationAttempts,
    2 * RELEASE_PLEASE_MARK_TAGGED_MAX_MUTATION_ATTEMPTS,
  );
});

test("missing lifecycle labels and changed exact identity fail closed", () => {
  for (const current of [
    pullRequest({ labels: [] }),
    pullRequest({ merge_commit_sha: "b".repeat(40) }),
  ]) {
    assert.throws(
      () => markExactReleasePleasePullRequestTagged({
        addTaggedLabel: () => assert.fail("conflicting state must not add a label"),
        environment: ENVIRONMENT,
        listAssociatedPullRequests: () => [pullRequest()],
        readPullRequest: () => current,
        readTaggedLabel: taggedRepositoryLabel,
        reconciliationOptions: { ...reconciliationOptions(), maxAttempts: 1 },
        releaseSha: RELEASE_SHA,
        removePendingLabel: () => assert.fail("conflicting state must not remove a label"),
      }),
      /neither|identity changed/u,
    );
  }
});
