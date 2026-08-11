#!/usr/bin/env bun
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  createGitHubOperationBudget,
  githubJsonReadSync,
  remainingGitHubReadOptions,
  reconcileGitHubMutationSync,
  runGitHubMutationSync,
} from "./github-release-mutations.mjs";
import { runGitHubPaginatedJsonSync } from "./github-read.mjs";

const TOOL = "release-please-pr-lifecycle.mjs";
const FULL_SHA = /^[0-9a-f]{40}$/u;
const PENDING_LABEL = "autorelease: pending";
const TAGGED_LABEL = "autorelease: tagged";
const RELEASE_BRANCH = "release-please--branches--main";
const RELEASE_TITLE = "chore(release): prepare main releases";
export const RELEASE_PLEASE_ASSERT_MARKABLE_WINDOW_MS = 45_000;
export const RELEASE_PLEASE_MARK_TAGGED_WINDOW_MS = 4 * 60_000;
export const RELEASE_PLEASE_MARK_TAGGED_MAX_MUTATION_ATTEMPTS = 3;
const LIFECYCLE_READ_ATTEMPT_TIMEOUT_MS = 15_000;
const LIFECYCLE_MUTATION_ATTEMPT_TIMEOUT_MS = 30_000;

function lifecycleError(message, options = {}) {
  return new Error(`${TOOL}: ${message}`, options);
}

function requiredRepository(environment) {
  const repository = environment.GITHUB_REPOSITORY?.trim() ?? "";
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)
    || repository.split("/").some((part) => part === "." || part === "..")
  ) {
    throw lifecycleError("GITHUB_REPOSITORY must be a canonical OWNER/NAME");
  }
  return repository;
}

function lifecycleBudget({
  environment,
  now = Date.now,
  windowMs,
}) {
  return createGitHubOperationBudget({
    defaultWindowMs: windowMs,
    environment: {
      ...environment,
      OLIPHAUNT_GITHUB_MUTATION_WINDOW_MS: String(windowMs),
    },
    now,
  });
}

function lifecycleReadOptions(budget, overrides = {}) {
  return remainingGitHubReadOptions(budget, {
    attemptTimeoutMs: LIFECYCLE_READ_ATTEMPT_TIMEOUT_MS,
    baseDelayMs: 500,
    maxAttempts: 3,
    maxDelayMs: 2_000,
    ...overrides,
  });
}

function requireBase(base) {
  if (base !== "main") {
    throw lifecycleError(`the Release Please lifecycle base must be main, got ${JSON.stringify(base)}`);
  }
  return base;
}

function object(value, context) {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw lifecycleError(`${context} must be an object`);
  }
  return value;
}

function pullRequestLabels(pullRequest, context) {
  object(pullRequest, context);
  if (!Array.isArray(pullRequest.labels)) {
    throw lifecycleError(`${context}.labels must be an array`);
  }
  const labels = pullRequest.labels.map((entry, index) => {
    object(entry, `${context}.labels[${index}]`);
    if (
      typeof entry.name !== "string"
      || entry.name.length === 0
      || /[\u0000-\u001f\u007f]/u.test(entry.name)
    ) {
      throw lifecycleError(`${context}.labels[${index}].name must be a non-empty printable string`);
    }
    return entry.name;
  });
  if (new Set(labels).size !== labels.length) {
    throw lifecycleError(`${context}.labels contains duplicate names`);
  }
  return labels;
}

function sameRepositoryPullRequest(pullRequest, repository, base) {
  return pullRequest?.base?.ref === base
    && pullRequest?.base?.repo?.full_name === repository
    && pullRequest?.head?.repo?.full_name === repository;
}

export function mergedPendingReleasePullRequests(pullRequests, {
  base = "main",
  repository,
} = {}) {
  requireBase(base);
  if (!Array.isArray(pullRequests)) {
    throw lifecycleError("closed pull request response must be an array");
  }
  const blockers = [];
  for (const [index, pullRequest] of pullRequests.entries()) {
    const context = `closed pull request response[${index}]`;
    object(pullRequest, context);
    const labels = pullRequestLabels(pullRequest, context);
    if (
      pullRequest.merged_at === null
      || pullRequest.merged_at === undefined
      || !sameRepositoryPullRequest(pullRequest, repository, base)
      || !labels.includes(PENDING_LABEL)
    ) {
      continue;
    }
    if (
      !Number.isSafeInteger(pullRequest.number)
      || pullRequest.number <= 0
      || typeof pullRequest.html_url !== "string"
      || pullRequest.html_url.length === 0
    ) {
      throw lifecycleError(`${context} has malformed blocker identity`);
    }
    blockers.push({ number: pullRequest.number, url: pullRequest.html_url });
  }
  return blockers.sort((left, right) => left.number - right.number);
}

export function releasePleaseClosedPullRequestQuery(repository, base = "main") {
  requireBase(base);
  const [owner] = requiredRepository({ GITHUB_REPOSITORY: repository }).split("/");
  return new URLSearchParams({
    base,
    direction: "desc",
    head: `${owner}:${RELEASE_BRANCH}`,
    sort: "updated",
    state: "closed",
  });
}

export function assertCleanReleasePleaseState({
  base = "main",
  environment = process.env,
  listPullRequests,
} = {}) {
  requireBase(base);
  const repository = requiredRepository(environment);
  const list = listPullRequests ?? (() => {
    const query = releasePleaseClosedPullRequestQuery(repository, base);
    return runGitHubPaginatedJsonSync(
      `repos/${repository}/pulls?${query.toString()}`,
      {
        attemptTimeoutMs: LIFECYCLE_READ_ATTEMPT_TIMEOUT_MS,
        baseDelayMs: 500,
        deadlineMs: RELEASE_PLEASE_ASSERT_MARKABLE_WINDOW_MS,
        environment,
        itemsField: null,
        label: "merged Release Please lifecycle preflight",
        maxAttempts: 3,
        maxDelayMs: 2_000,
      },
    );
  });
  const blockers = mergedPendingReleasePullRequests(list(), { base, repository });
  if (blockers.length > 0) {
    throw lifecycleError(
      "merged main Release Please PRs still have autorelease: pending: "
        + blockers.map(({ number, url }) => `#${number} ${url}`).join(", ")
        + "; finish publication before preparing another release",
    );
  }
  return { base, blockers: [], repository };
}

function exactReleasePullRequestIdentity(pullRequest, {
  base,
  number,
  releaseSha,
  repository,
} = {}) {
  object(pullRequest, "associated release pull request");
  return pullRequest.merge_commit_sha === releaseSha
    && pullRequest.merged_at !== null
    && pullRequest.merged_at !== undefined
    && pullRequest.state === "closed"
    && sameRepositoryPullRequest(pullRequest, repository, base)
    && pullRequest.head.ref === RELEASE_BRANCH
    && pullRequest.title === RELEASE_TITLE
    && (number === undefined || pullRequest.number === number);
}

export function selectExactReleasePullRequest(pullRequests, {
  base = "main",
  releaseSha,
  repository,
} = {}) {
  requireBase(base);
  if (!FULL_SHA.test(releaseSha ?? "")) {
    throw lifecycleError("release SHA must be a full lowercase commit SHA");
  }
  if (!Array.isArray(pullRequests)) {
    throw lifecycleError("associated pull request response must be an array");
  }
  const matches = pullRequests.filter((pullRequest) =>
    exactReleasePullRequestIdentity(pullRequest, { base, releaseSha, repository }));
  if (matches.length !== 1) {
    throw lifecycleError(
      `release commit ${releaseSha} must have exactly one canonical merged Release Please PR; found ${matches.length}`,
    );
  }
  const [pullRequest] = matches;
  if (!Number.isSafeInteger(pullRequest.number) || pullRequest.number <= 0) {
    throw lifecycleError("associated release pull request number must be a positive integer");
  }
  return pullRequest;
}

export function releasePleaseLabelState(pullRequest, expectedIdentity) {
  if (!exactReleasePullRequestIdentity(pullRequest, expectedIdentity)) {
    return { detail: "the exact merged Release Please PR identity changed", kind: "conflict" };
  }
  const labels = pullRequestLabels(pullRequest, `pull request #${pullRequest.number}`);
  const pending = labels.includes(PENDING_LABEL);
  const tagged = labels.includes(TAGGED_LABEL);
  if (!pending && tagged) {
    return { kind: "desired", labels };
  }
  if (!pending && !tagged) {
    return {
      detail: `pull request #${pullRequest.number} has neither ${PENDING_LABEL} nor ${TAGGED_LABEL}`,
      kind: "conflict",
    };
  }
  return { kind: "unchanged", labels };
}

function assertMarkableState(state, number) {
  if (state.kind === "conflict") {
    throw lifecycleError(state.detail);
  }
  if (state.kind !== "desired" && state.kind !== "unchanged") {
    throw lifecycleError(`pull request #${number} returned an invalid lifecycle state`);
  }
  return state;
}

function assertTaggedRepositoryLabel(label) {
  object(label, `repository label ${TAGGED_LABEL}`);
  if (label.name !== TAGGED_LABEL) {
    throw lifecycleError(`repository label ${TAGGED_LABEL} returned malformed metadata`);
  }
  return label;
}

function resolveExactReleasePleasePullRequest({
  base,
  budget,
  environment,
  listAssociatedPullRequests,
  readPullRequest,
  readTaggedLabel,
  releaseSha,
}) {
  const repository = requiredRepository(environment);
  const list = listAssociatedPullRequests ?? (() =>
    runGitHubPaginatedJsonSync(
      `repos/${repository}/commits/${releaseSha}/pulls`,
      {
        ...lifecycleReadOptions(budget),
        itemsField: null,
        label: `pull requests associated with release ${releaseSha}`,
      },
    ));
  const selected = selectExactReleasePullRequest(list(), {
    base,
    releaseSha,
    repository,
  });
  const expectedIdentity = { base, number: selected.number, releaseSha, repository };
  const read = readPullRequest ?? (() =>
    githubJsonReadSync(
      ["api", `repos/${repository}/pulls/${selected.number}`],
      {
        ...lifecycleReadOptions(budget),
        label: `release pull request #${selected.number}`,
      },
    ));
  const current = read();
  const state = assertMarkableState(
    releasePleaseLabelState(current, expectedIdentity),
    selected.number,
  );
  const readLabel = readTaggedLabel ?? (() =>
    githubJsonReadSync(
      ["api", `repos/${repository}/labels/${encodeURIComponent(TAGGED_LABEL)}`],
      {
        ...lifecycleReadOptions(budget),
        label: `repository label ${TAGGED_LABEL}`,
      },
    ));
  assertTaggedRepositoryLabel(readLabel());
  return {
    current,
    expectedIdentity,
    number: selected.number,
    read,
    repository,
    state,
  };
}

export function assertExactReleasePleasePullRequestMarkable({
  base = "main",
  environment = process.env,
  listAssociatedPullRequests,
  now = Date.now,
  readPullRequest,
  readTaggedLabel,
  releaseSha,
} = {}) {
  requireBase(base);
  if (!FULL_SHA.test(releaseSha ?? "")) {
    throw lifecycleError("release SHA must be a full lowercase commit SHA");
  }
  const budget = lifecycleBudget({
    environment,
    now,
    windowMs: RELEASE_PLEASE_ASSERT_MARKABLE_WINDOW_MS,
  });
  const resolved = resolveExactReleasePleasePullRequest({
    base,
    budget,
    environment: budget.environment,
    listAssociatedPullRequests,
    readPullRequest,
    readTaggedLabel,
    releaseSha,
  });
  return {
    number: resolved.number,
    repository: resolved.repository,
    state: resolved.state.kind,
  };
}

function ensureTaggedState(pullRequest, expectedIdentity) {
  const state = releasePleaseLabelState(pullRequest, expectedIdentity);
  if (state.kind === "conflict") return state;
  return {
    kind: state.labels.includes(TAGGED_LABEL) ? "desired" : "unchanged",
  };
}

function ensurePendingRemovedState(pullRequest, expectedIdentity) {
  const state = releasePleaseLabelState(pullRequest, expectedIdentity);
  if (state.kind === "conflict") return state;
  const pending = state.labels.includes(PENDING_LABEL);
  const tagged = state.labels.includes(TAGGED_LABEL);
  if (!tagged) {
    return {
      detail: `pull request #${pullRequest.number} lost ${TAGGED_LABEL} before pending-label removal`,
      kind: "conflict",
    };
  }
  return { kind: pending ? "unchanged" : "desired" };
}

export function markExactReleasePleasePullRequestTagged({
  addTaggedLabel,
  base = "main",
  environment = process.env,
  listAssociatedPullRequests,
  now = Date.now,
  readTaggedLabel,
  removePendingLabel,
  readPullRequest,
  releaseSha,
  reconciliationOptions = {},
} = {}) {
  requireBase(base);
  if (!FULL_SHA.test(releaseSha ?? "")) {
    throw lifecycleError("release SHA must be a full lowercase commit SHA");
  }
  const budget = reconciliationOptions.budget ?? lifecycleBudget({
    environment,
    now,
    windowMs: RELEASE_PLEASE_MARK_TAGGED_WINDOW_MS,
  });
  const operationEnvironment = budget.environment ?? environment;
  const resolved = resolveExactReleasePleasePullRequest({
    base,
    budget,
    environment: operationEnvironment,
    listAssociatedPullRequests,
    readPullRequest,
    readTaggedLabel,
    releaseSha,
  });
  const reconciliation = {
    ...reconciliationOptions,
    attemptTimeoutMs: Math.min(
      reconciliationOptions.attemptTimeoutMs ?? LIFECYCLE_MUTATION_ATTEMPT_TIMEOUT_MS,
      LIFECYCLE_MUTATION_ATTEMPT_TIMEOUT_MS,
    ),
    budget,
    environment: operationEnvironment,
    maxAttempts: Math.min(
      reconciliationOptions.maxAttempts
        ?? RELEASE_PLEASE_MARK_TAGGED_MAX_MUTATION_ATTEMPTS,
      RELEASE_PLEASE_MARK_TAGGED_MAX_MUTATION_ATTEMPTS,
    ),
  };
  const taggedResult = reconcileGitHubMutationSync({
    inspect: () => ensureTaggedState(resolved.read(), resolved.expectedIdentity),
    label: `add ${TAGGED_LABEL} to Release Please PR #${resolved.number}`,
    mutate: ({ deadlineMs, timeoutMs }) => {
      const input = `${JSON.stringify({ labels: [TAGGED_LABEL] })}\n`;
      if (addTaggedLabel !== undefined) {
        addTaggedLabel({ deadlineMs, input, number: resolved.number, timeoutMs });
        return;
      }
      runGitHubMutationSync(
        [
          "api",
          `repos/${resolved.repository}/issues/${resolved.number}/labels`,
          "-X",
          "POST",
          "--input",
          "-",
        ],
        {
          deadlineMs,
          environment: operationEnvironment,
          input,
          pacerLabel: `add ${TAGGED_LABEL} to Release Please PR #${resolved.number}`,
          timeoutMs,
        },
      );
    },
    options: reconciliation,
  });
  const pendingResult = reconcileGitHubMutationSync({
    inspect: () => ensurePendingRemovedState(resolved.read(), resolved.expectedIdentity),
    label: `remove ${PENDING_LABEL} from Release Please PR #${resolved.number}`,
    mutate: ({ deadlineMs, timeoutMs }) => {
      if (removePendingLabel !== undefined) {
        removePendingLabel({ deadlineMs, number: resolved.number, timeoutMs });
        return;
      }
      runGitHubMutationSync(
        [
          "api",
          `repos/${resolved.repository}/issues/${resolved.number}/labels/${encodeURIComponent(PENDING_LABEL)}`,
          "-X",
          "DELETE",
        ],
        {
          deadlineMs,
          environment: operationEnvironment,
          pacerLabel: `remove ${PENDING_LABEL} from Release Please PR #${resolved.number}`,
          timeoutMs,
        },
      );
    },
    options: reconciliation,
  });
  return {
    mutationAttempts: taggedResult.mutationAttempts + pendingResult.mutationAttempts,
    number: resolved.number,
    recovered: taggedResult.recovered || pendingResult.recovered,
    repository: resolved.repository,
  };
}

function usage() {
  return `${TOOL}: usage: ${TOOL} assert-clean --base main | `
    + `${TOOL} assert-markable --release-sha <full-sha> --base main | `
    + `${TOOL} mark-tagged --release-sha <full-sha> --base main`;
}

function parseCli(args) {
  const [operation, ...rest] = args;
  if (operation === "assert-clean" && rest.length === 2 && rest[0] === "--base") {
    return { base: rest[1], operation };
  }
  if (
    (operation === "assert-markable" || operation === "mark-tagged")
    && rest.length === 4
    && rest[0] === "--release-sha"
    && rest[2] === "--base"
  ) {
    return { base: rest[3], operation, releaseSha: rest[1] };
  }
  throw lifecycleError(usage());
}

function main() {
  const options = parseCli(process.argv.slice(2));
  if (options.operation === "assert-clean") {
    const result = assertCleanReleasePleaseState(options);
    console.log(`Release Please lifecycle is clear for ${result.repository}:${result.base}`);
    return;
  }
  if (options.operation === "assert-markable") {
    const result = assertExactReleasePleasePullRequestMarkable(options);
    console.log(
      `Release Please PR #${result.number} is markable for ${result.repository} `
        + `(state: ${result.state})`,
    );
    return;
  }
  const result = markExactReleasePleasePullRequestTagged(options);
  console.log(
    `Release Please PR #${result.number} is tagged and no longer pending `
      + `(mutation attempts: ${result.mutationAttempts})`,
  );
}

const invokedPath = process.argv[1] === undefined ? "" : path.resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (cause) {
    console.error(cause instanceof Error ? cause.message : String(cause));
    process.exit(1);
  }
}
