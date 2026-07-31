#!/usr/bin/env bun
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { redactGitHubReadDetail } from "../../tools/release/github-read.mjs";
import { captureCommandOutput } from "../../tools/dev/capture-command-output.mjs";
import {
  assertResumableReleaseMetadata,
  createGitHubOperationBudget,
  exactReleaseMetadata,
  exactTagRefPayload,
  GitHubReleaseSnapshotRaceError,
  GITHUB_RELEASE_SNAPSHOT_MAX_READ_ATTEMPTS,
  GITHUB_RELEASE_SNAPSHOT_VISIBILITY_DELAYS_MS,
  GITHUB_RELEASE_SNAPSHOT_READ_WINDOW_MS,
  GITHUB_RELEASE_SNAPSHOT_VISIBILITY_WINDOW_MS,
  readReleaseByTagSync,
  readReleaseMapSync,
  readTagRefSync,
  reconcileGitHubMutationSync,
  releaseNotesForVersion,
  remainingGitHubReadOptions,
  runGitHubMutationSync,
} from "../../tools/release/github-release-mutations.mjs";
import {
  RELEASE_FINALIZATION_STEP_TIMEOUT_MINUTES,
} from "../../tools/release/release-finalization-budget.mjs";
import { loadGraph } from "../../tools/release/release-graph.mjs";
import {
  RELEASE_PLEASE_ASSERT_MARKABLE_WINDOW_MS,
  RELEASE_PLEASE_MARK_TAGGED_WINDOW_MS,
} from "../../tools/release/release-please-pr-lifecycle.mjs";
import {
  DEFAULT_PUBLICATION_LOCK,
  loadPublicationLock,
} from "../../tools/release/publication-lock.mjs";

const FULL_SHA = /^[0-9a-f]{40}$/u;
const DEFAULT_GIT_SNAPSHOT_TIMEOUT_MS = 60_000;
const DEFAULT_FAST_MUTATION_TIMEOUT_MS = 60_000;
export const GITHUB_RELEASE_PROMOTION_MUTATION_TIMEOUT_MS = 10_000;
export const GITHUB_RELEASE_PROMOTION_TAG_SNAPSHOT_TIMEOUT_MS = 30_000;
const GITHUB_RELEASE_PROMOTION_LIFECYCLE_MARGIN_MS = 30_000;
const GITHUB_RELEASE_PROMOTION_STEP_WINDOW_MS =
  RELEASE_FINALIZATION_STEP_TIMEOUT_MINUTES.promoteDrafts * 60_000;
export const GITHUB_RELEASE_PROMOTION_COMMAND_WINDOW_MS =
  GITHUB_RELEASE_PROMOTION_STEP_WINDOW_MS
  - RELEASE_PLEASE_ASSERT_MARKABLE_WINDOW_MS
  - RELEASE_PLEASE_MARK_TAGGED_WINDOW_MS
  - GITHUB_RELEASE_PROMOTION_LIFECYCLE_MARGIN_MS;

export {
  assertResumableReleaseMetadata,
  exactReleaseMetadata,
  exactTagRefPayload,
  releaseNotesForVersion,
};

function error(message, options = {}) {
  return new Error(`release-drafts: ${message}`, options);
}

function usageError() {
  return error(
    "usage: manage-release-drafts.mjs <preflight|recovery-preflight|stage|verify|promote> "
      + "--products-json JSON --head-ref SHA [--state draft|public|staged]",
  );
}

function parseArgs(argv) {
  const command = argv.shift();
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined || values.has(key.slice(2))) {
      throw usageError();
    }
    values.set(key.slice(2), value);
  }
  return { command, values };
}

function selectedPublicationLock(command, products, headRef, environment) {
  const file = path.resolve(
    environment.PUBLICATION_LOCK_PATH
      ?? environment.OLIPHAUNT_PUBLICATION_LOCK
      ?? DEFAULT_PUBLICATION_LOCK,
  );
  if (!existsSync(file)) {
    if (command === "preflight" || command === "recovery-preflight") return null;
    throw error(`${command} requires the frozen publication lock: ${file}`);
  }
  const lock = loadPublicationLock(file);
  if (lock.source.commit !== headRef) {
    throw error(`publication lock targets ${lock.source.commit}, not ${headRef}`);
  }
  const lockedProducts = lock.products.map(({ id }) => id).sort();
  const requestedProducts = [...products].sort();
  if (JSON.stringify(lockedProducts) !== JSON.stringify(requestedProducts)) {
    throw error(
      `publication lock products ${JSON.stringify(lockedProducts)} do not match selected products ${JSON.stringify(requestedProducts)}`,
    );
  }
  return lock;
}

function selectedReleases(command, products, headRef, environment) {
  const graph = loadGraph("release-drafts");
  const publicationLock = selectedPublicationLock(command, products, headRef, environment);
  const lockedProducts = publicationLock === null
    ? new Map()
    : new Map(publicationLock.products.map((product) => [product.id, product]));
  return products.map((product) => {
    const config = graph.products[product];
    if (!config) throw error(`unknown release product ${product}`);
    const locked = lockedProducts.get(product);
    const version = locked?.version ?? config.version;
    if (config.version !== version) {
      throw error(`${product} graph version ${config.version} does not match publication lock version ${version}`);
    }
    let body;
    try {
      body = releaseNotesForVersion(readFileSync(config.changelog_path, "utf8"), version);
    } catch (cause) {
      throw error(`${product} release notes are invalid: ${cause.message}`, { cause });
    }
    const tag = `${config.tag_prefix}${version}`;
    return {
      metadata: exactReleaseMetadata({ body, headRef, product, tag, version }),
      product,
      tag,
      version,
    };
  });
}

function tagReconciliationState(ref, tag, headRef) {
  if (ref === null) return { kind: "absent" };
  if (ref.type !== "commit" || ref.sha !== headRef || ref.ref !== `refs/tags/${tag}`) {
    return {
      detail: `${tag} targets ${ref.type}:${ref.sha}, not commit:${headRef}`,
      kind: "conflict",
    };
  }
  return { kind: "desired" };
}

function releaseReconciliationState(release, expected, { allowPublic, expectedId } = {}) {
  if (release === null) {
    return expectedId === undefined
      ? { kind: "absent" }
      : { detail: `${expected.tag_name} release ${expectedId} disappeared`, kind: "conflict" };
  }
  try {
    assertResumableReleaseMetadata(release, expected);
  } catch (cause) {
    return { detail: cause.message, kind: "conflict" };
  }
  if (expectedId !== undefined && release.id !== expectedId) {
    return {
      detail: `${expected.tag_name} release id changed from ${expectedId} to ${release.id}`,
      kind: "conflict",
    };
  }
  if (allowPublic === true) return { kind: "desired" };
  return release.draft ? { kind: "unchanged" } : { kind: "desired" };
}

function mutationOptions(budget, environment, overrides) {
  return { budget, environment, ...overrides };
}

export function stageExactTagSync({ budget, environment, headRef, repo, tag }, dependencies = {}) {
  const readTag = dependencies.readTagRef ?? (() =>
    readTagRefSync(repo, tag, remainingGitHubReadOptions(budget)));
  const createTag = dependencies.createTag ?? (({ deadlineMs, now, timeoutMs }) =>
    runGitHubMutationSync(
      ["api", `repos/${repo}/git/refs`, "-X", "POST", "--input", "-"],
      {
        environment,
        deadlineMs,
        input: `${JSON.stringify(exactTagRefPayload(tag, headRef))}\n`,
        now,
        timeoutMs,
      },
    ));
  return reconcileGitHubMutationSync({
    inspect: () => tagReconciliationState(readTag(), tag, headRef),
    label: `create exact tag ${tag}`,
    mutate: createTag,
    options: mutationOptions(budget, environment, dependencies.mutationOptions),
  });
}

export function stageExactDraftReleaseSync(
  { budget, environment, metadata, repo, tag },
  dependencies = {},
) {
  const readRelease = dependencies.readRelease ?? (() =>
    readReleaseByTagSync(repo, tag, remainingGitHubReadOptions(budget)));
  const createRelease = dependencies.createRelease ?? (({ deadlineMs, now, timeoutMs }) =>
    runGitHubMutationSync(
      ["api", `repos/${repo}/releases`, "-X", "POST", "--input", "-"],
      {
        environment,
        deadlineMs,
        input: `${JSON.stringify({ ...metadata, draft: true })}\n`,
        now,
        timeoutMs,
      },
    ));
  return reconcileGitHubMutationSync({
    inspect: () => releaseReconciliationState(readRelease(), metadata, { allowPublic: true }),
    label: `create exact draft release ${tag}`,
    mutate: createRelease,
    options: mutationOptions(budget, environment, dependencies.mutationOptions),
  });
}

export function promoteExactReleaseSync(
  { budget, environment, expectedId, metadata, repo, tag },
  dependencies = {},
) {
  const readRelease = dependencies.readRelease ?? (() =>
    readReleaseByTagSync(repo, tag, remainingGitHubReadOptions(budget)));
  const promoteRelease = dependencies.promoteRelease ?? (({ deadlineMs, now, timeoutMs }) =>
    runGitHubMutationSync(
      ["api", `repos/${repo}/releases/${expectedId}`, "-X", "PATCH", "--input", "-"],
      {
        environment,
        deadlineMs,
        input: `${JSON.stringify({ draft: false })}\n`,
        now,
        timeoutMs,
      },
    ));
  return reconcileGitHubMutationSync({
    inspect: () => releaseReconciliationState(readRelease(), metadata, { expectedId }),
    label: `promote exact release ${tag} (${expectedId})`,
    mutate: promoteRelease,
    options: mutationOptions(budget, environment, dependencies.mutationOptions),
  });
}

function validateExistingReleases(selected, releasesByTag) {
  for (const { metadata, tag } of selected) {
    const release = releasesByTag.get(tag);
    if (release === undefined) continue;
    try {
      assertResumableReleaseMetadata(release, metadata);
    } catch (cause) {
      throw error(cause.message, { cause });
    }
  }
}

function sleepSync(milliseconds) {
  if (milliseconds <= 0) return;
  const cell = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  Atomics.wait(cell, 0, 0, milliseconds);
}

function pendingRequiredReleases(selected, releasesByTag, requiredState) {
  return selected.flatMap(({ tag }) => {
    const release = releasesByTag.get(tag);
    if (release === undefined) return [`${tag} (missing)`];
    if (requiredState === "public" && release.draft) return [`${tag} (still draft)`];
    if (requiredState === "draft" && !release.draft) return [`${tag} (already public)`];
    return [];
  });
}

function validateExpectedReleaseIds(selected, releasesByTag, expectedReleaseIds) {
  if (expectedReleaseIds === undefined) return;
  if (!(expectedReleaseIds instanceof Map)) {
    throw error("expected release identities must be a Map");
  }
  for (const { tag } of selected) {
    const expectedId = expectedReleaseIds.get(tag);
    if (!Number.isSafeInteger(expectedId) || expectedId <= 0) {
      throw error(`expected release identity for ${tag} must be a positive integer`);
    }
    const release = releasesByTag.get(tag);
    if (release !== undefined && release.id !== expectedId) {
      throw error(`${tag} release id changed from ${expectedId} to ${release.id}`);
    }
  }
}

function readRequiredReleaseMapSync({
  budget,
  expectedReleaseIds,
  readReleaseMap,
  requiredState,
  selected,
  sleep = sleepSync,
}) {
  if (!new Set(["draft", "public", "staged"]).has(requiredState)) {
    throw error("required release snapshot state must be draft, public, or staged");
  }
  if (typeof readReleaseMap !== "function" || typeof sleep !== "function") {
    throw error("required release snapshot reader and sleep callback are required");
  }
  let lastTransientSnapshotError = null;
  for (
    let attempt = 0;
    attempt <= GITHUB_RELEASE_SNAPSHOT_VISIBILITY_DELAYS_MS.length;
    attempt += 1
  ) {
    let pending;
    try {
      const releasesByTag = readReleaseMap();
      validateExistingReleases(selected, releasesByTag);
      validateExpectedReleaseIds(selected, releasesByTag, expectedReleaseIds);
      pending = pendingRequiredReleases(selected, releasesByTag, requiredState);
      if (pending.length === 0) return releasesByTag;
      lastTransientSnapshotError = null;
    } catch (cause) {
      if (!(cause instanceof GitHubReleaseSnapshotRaceError)) throw cause;
      if (cause.observedRelease !== undefined) {
        const observedReleaseMap =
          new Map([[cause.observedRelease.tag_name, cause.observedRelease]]);
        validateExistingReleases(selected, observedReleaseMap);
        validateExpectedReleaseIds(selected, observedReleaseMap, expectedReleaseIds);
      }
      lastTransientSnapshotError = cause;
      pending = selected.map(({ tag }) => `${tag} (inconsistent paginated snapshot)`);
    }
    if (attempt === GITHUB_RELEASE_SNAPSHOT_VISIBILITY_DELAYS_MS.length) {
      throw error(
        `GitHub release list did not converge to ${requiredState} state within `
          + `${GITHUB_RELEASE_SNAPSHOT_VISIBILITY_WINDOW_MS}ms: ${pending.join(", ")}`,
        { cause: lastTransientSnapshotError ?? undefined },
      );
    }
    const remainingVisibilityWindowMs = GITHUB_RELEASE_SNAPSHOT_VISIBILITY_DELAYS_MS
      .slice(attempt)
      .reduce((total, delay) => total + delay, 0);
    if (budget.deadlineMs - budget.now() < remainingVisibilityWindowMs) {
      throw error(
        `GitHub operation lacks the complete ${remainingVisibilityWindowMs}ms release-list `
          + `visibility window required for: ${pending.join(", ")}`,
        { cause: lastTransientSnapshotError ?? undefined },
      );
    }
    sleep(GITHUB_RELEASE_SNAPSHOT_VISIBILITY_DELAYS_MS[attempt]);
  }
  throw error("required release snapshot loop ended unexpectedly");
}

function boundedReleaseSnapshotReadOptions(budget) {
  const startedAtMs = budget.now();
  const snapshotBudget = {
    ...budget,
    deadlineMs: Math.min(
      budget.deadlineMs,
      startedAtMs + GITHUB_RELEASE_SNAPSHOT_READ_WINDOW_MS,
    ),
  };
  return remainingGitHubReadOptions(snapshotBudget, {
    attemptTimeoutMs: 4_000,
    baseDelayMs: 500,
    maxAttempts: GITHUB_RELEASE_SNAPSHOT_MAX_READ_ATTEMPTS,
    maxDelayMs: 500,
  });
}

function requireExactTags(selected, repo, headRef, budget) {
  for (const { product, tag } of selected) {
    const ref = readTagRefSync(repo, tag, remainingGitHubReadOptions(budget));
    const state = tagReconciliationState(ref, tag, headRef);
    if (state.kind !== "desired") {
      throw error(
        state.kind === "absent"
          ? `${product} tag ${tag} does not exist`
          : state.detail,
      );
    }
  }
}

function finalReleaseState(selected, releasesByTag, command, expectedState) {
  const wantDraft = command === "promote" ? false : expectedState === "draft";
  for (const { tag } of selected) {
    const release = releasesByTag.get(tag);
    if (release === undefined) {
      throw error(`GitHub release for ${tag} does not exist after ${command}`);
    }
    if (expectedState !== "staged" && release.draft !== wantDraft) {
      throw error(`${tag} is ${release.draft ? "draft" : "public"}; expected ${wantDraft ? "draft" : "public"}`);
    }
  }
  return wantDraft;
}

function parseMutationJson(output, label) {
  if (typeof output !== "string" || Buffer.byteLength(output, "utf8") > 4 * 1024 * 1024) {
    throw error(`${label} returned an invalid bounded response`);
  }
  try {
    return JSON.parse(output);
  } catch (cause) {
    throw error(`${label} returned malformed JSON`, { cause });
  }
}

function exactTagFromMutation(output, tag, headRef) {
  const value = parseMutationJson(output, `create exact tag ${tag}`);
  if (
    value === null
    || Array.isArray(value)
    || typeof value !== "object"
    || value.ref !== `refs/tags/${tag}`
    || value.object === null
    || Array.isArray(value.object)
    || typeof value.object !== "object"
    || value.object.sha !== headRef
    || value.object.type !== "commit"
  ) {
    throw error(`create exact tag ${tag} returned a response that does not bind commit:${headRef}`);
  }
  return { ref: value.ref, sha: value.object.sha, type: value.object.type };
}

function exactReleaseFromMutation(output, metadata, { draft, expectedId } = {}) {
  const value = parseMutationJson(output, `mutate exact release ${metadata.tag_name}`);
  assertResumableReleaseMetadata(value, metadata);
  if (value.draft !== draft) {
    throw error(
      `${metadata.tag_name} mutation response is ${value.draft ? "draft" : "public"}; `
        + `expected ${draft ? "draft" : "public"}`,
    );
  }
  if (expectedId !== undefined && value.id !== expectedId) {
    throw error(`${metadata.tag_name} mutation response id changed from ${expectedId} to ${value.id}`);
  }
  return value;
}

function selectedTagNames(selected) {
  const tags = selected.map(({ tag }) => tag);
  if (
    tags.length === 0
    || new Set(tags).size !== tags.length
    || tags.some((tag) => typeof tag !== "string" || tag.length === 0 || /[\s\u0000-\u001f\u007f]/u.test(tag))
  ) {
    throw error("selected release tags must be a non-empty unique printable string list");
  }
  return tags;
}

/**
 * Read every selected tag in one Git protocol advertisement rather than one
 * REST request per product. The canonical release repository is public, so
 * this snapshot intentionally carries no credential and consumes no
 * GITHUB_TOKEN REST quota.
 */
export function readSelectedRemoteTagMapSync(repo, selected, options = {}) {
  if (typeof repo !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repo)) {
    throw error("GitHub repository must be OWNER/NAME");
  }
  const tags = selectedTagNames(selected);
  const remainingMs = options.budget === undefined
    ? DEFAULT_GIT_SNAPSHOT_TIMEOUT_MS
    : options.budget.deadlineMs - options.budget.now();
  if (!Number.isSafeInteger(remainingMs) || remainingMs <= 0) {
    throw error("GitHub operation deadline has been reached before the remote tag snapshot");
  }
  const gitArgs = [
    "-c",
    "credential.helper=",
    "ls-remote",
    "--refs",
    "--tags",
    `https://github.com/${repo}.git`,
    ...tags.map((tag) => `refs/tags/${tag}`),
  ];
  const environment = {
    ...(options.environment ?? process.env),
    GIT_ASKPASS: "",
    GIT_TERMINAL_PROMPT: "0",
    SSH_ASKPASS: "",
  };
  const requestedTimeoutMs =
    options.timeoutMs ?? DEFAULT_GIT_SNAPSHOT_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(requestedTimeoutMs)
    || requestedTimeoutMs < 1
    || requestedTimeoutMs > DEFAULT_GIT_SNAPSHOT_TIMEOUT_MS
  ) {
    throw error(
      `remote tag snapshot timeout must be between 1 and ${DEFAULT_GIT_SNAPSHOT_TIMEOUT_MS}ms`,
    );
  }
  const timeout = Math.max(1, Math.min(requestedTimeoutMs, remainingMs));
  const result = options.spawn === undefined
    ? captureCommandOutput("git", gitArgs, {
        allowEmptyOutput: true,
        cwd: options.cwd,
        env: environment,
        label: "git ls-remote selected release tags",
        maxOutputBytes: 4 * 1024 * 1024,
        stdoutTerminator: "\n",
        timeout,
      })
    : options.spawn("git", gitArgs, {
        cwd: options.cwd,
        encoding: "utf8",
        env: environment,
        maxBuffer: 4 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
        timeout,
      });
  if (result.error !== undefined || result.status !== 0) {
    const detail = redactGitHubReadDetail(result.error?.message ?? result.stderr ?? "");
    throw error(`could not read the exact selected remote tag snapshot${detail ? `: ${detail}` : ""}`);
  }
  const wanted = new Set(tags.map((tag) => `refs/tags/${tag}`));
  const refs = new Map();
  const stdout = String(result.stdout ?? "");
  if (stdout.length > 0 && !stdout.endsWith("\n")) {
    throw error("remote tag snapshot ended with a partial record");
  }
  for (const line of stdout.split(/\r?\n/u).filter(Boolean)) {
    const match = /^([0-9a-f]{40})\t(refs\/tags\/[^\s\u0000-\u001f\u007f]+)$/u.exec(line);
    if (match === null || !wanted.has(match[2]) || refs.has(match[2])) {
      throw error("remote tag snapshot contained malformed, unexpected, or duplicate output");
    }
    refs.set(match[2], { ref: match[2], sha: match[1], type: "commit" });
  }
  return new Map(tags.map((tag) => [tag, refs.get(`refs/tags/${tag}`) ?? null]));
}

function requireExactTagSnapshot(selected, tagsByName, headRef) {
  if (!(tagsByName instanceof Map)) throw error("remote tag snapshot must be a Map");
  for (const { product, tag } of selected) {
    const state = tagReconciliationState(tagsByName.get(tag) ?? null, tag, headRef);
    if (state.kind !== "desired") {
      throw error(state.kind === "absent" ? `${product} tag ${tag} does not exist` : state.detail);
    }
  }
}

function requireCollisionFreeTagSnapshot(selected, tagsByName, headRef) {
  if (!(tagsByName instanceof Map)) throw error("remote tag snapshot must be a Map");
  for (const { tag } of selected) {
    const state = tagReconciliationState(tagsByName.get(tag) ?? null, tag, headRef);
    if (state.kind === "conflict") throw error(state.detail);
  }
}

function fastMutationTimeout(budget, requiredTimeoutMs = DEFAULT_FAST_MUTATION_TIMEOUT_MS) {
  const remainingMs = budget.deadlineMs - budget.now();
  if (remainingMs < requiredTimeoutMs) {
    throw error(
      `GitHub operation requires a complete ${requiredTimeoutMs}ms mutation timeout; `
        + `${Math.max(0, remainingMs)}ms remains`,
    );
  }
  return requiredTimeoutMs;
}

function defaultTagMutation({ deadlineMs, environment, headRef, now, repo, tag, timeoutMs }) {
  return runGitHubMutationSync(
    ["api", `repos/${repo}/git/refs`, "-X", "POST", "--input", "-"],
    {
      environment,
      deadlineMs,
      input: `${JSON.stringify(exactTagRefPayload(tag, headRef))}\n`,
      now,
      timeoutMs,
    },
  );
}

function defaultReleaseMutation({ deadlineMs, environment, metadata, now, repo, timeoutMs }) {
  return runGitHubMutationSync(
    ["api", `repos/${repo}/releases`, "-X", "POST", "--input", "-"],
    {
      environment,
      deadlineMs,
      input: `${JSON.stringify({ ...metadata, draft: true })}\n`,
      now,
      timeoutMs,
    },
  );
}

function defaultPromotionMutation({ deadlineMs, environment, expectedId, now, repo, timeoutMs }) {
  return runGitHubMutationSync(
    ["api", `repos/${repo}/releases/${expectedId}`, "-X", "PATCH", "--input", "-"],
    {
      environment,
      deadlineMs,
      input: `${JSON.stringify({ draft: false })}\n`,
      now,
      timeoutMs,
    },
  );
}

function stageMissingTagFromSnapshot(context, dependencies) {
  const mutateTag = dependencies.mutateTag ?? defaultTagMutation;
  try {
    const output = mutateTag({
      ...context,
      deadlineMs: context.budget.deadlineMs,
      now: context.budget.now,
      timeoutMs: fastMutationTimeout(context.budget),
    });
    exactTagFromMutation(output, context.tag, context.headRef);
    return { mutationAttempts: 1, recovered: false };
  } catch (cause) {
    const result = stageExactTagSync(context, {
      createTag: ({ deadlineMs, now, timeoutMs }) => mutateTag({
        ...context,
        deadlineMs,
        now,
        timeoutMs,
      }),
      mutationOptions: dependencies.mutationOptions,
      readTagRef: dependencies.readTagRef,
    });
    return { ...result, fastMutationError: cause };
  }
}

function stageMissingReleaseFromSnapshot(context, dependencies) {
  const mutateRelease = dependencies.mutateRelease ?? defaultReleaseMutation;
  try {
    const output = mutateRelease({
      ...context,
      deadlineMs: context.budget.deadlineMs,
      now: context.budget.now,
      timeoutMs: fastMutationTimeout(context.budget),
    });
    exactReleaseFromMutation(output, context.metadata, { draft: true });
    return { mutationAttempts: 1, recovered: false };
  } catch (cause) {
    let releasesByTag;
    try {
      releasesByTag = readRequiredReleaseMapSync({
        budget: context.budget,
        readReleaseMap: dependencies.readReleaseMap,
        requiredState: "staged",
        selected: [{ metadata: context.metadata, tag: context.tag }],
        sleep: dependencies.releaseSnapshotSleep,
      });
    } catch (observationCause) {
      const mutationDetail = redactGitHubReadDetail(
        cause instanceof Error ? cause.message : String(cause),
        context.environment,
      );
      throw error(
        `${observationCause instanceof Error ? observationCause.message : String(observationCause)}; `
          + `original draft mutation failure: ${mutationDetail || "unknown failure"}`,
        { cause },
      );
    }
    return {
      fastMutationError: cause,
      mutationAttempts: 1,
      recovered: releasesByTag.has(context.tag),
    };
  }
}

function promoteReleaseFromSnapshot(context, dependencies) {
  const mutatePromotion = dependencies.mutatePromotion ?? defaultPromotionMutation;
  try {
    const output = mutatePromotion({
      ...context,
      deadlineMs: context.budget.deadlineMs,
      now: context.budget.now,
      timeoutMs: fastMutationTimeout(
        context.budget,
        GITHUB_RELEASE_PROMOTION_MUTATION_TIMEOUT_MS,
      ),
    });
    exactReleaseFromMutation(output, context.metadata, { draft: false, expectedId: context.expectedId });
    return { mutationAttempts: 1, recovered: false };
  } catch (cause) {
    // PATCH is idempotent, but replay is unnecessary and makes the bounded
    // finalization proof depend on an error-shaped number of writes. Observe
    // the whole selected batch once below; a rerun safely resumes any draft
    // whose first PATCH was definitely not applied.
    return {
      fastMutationError: cause,
      mutationAttempts: 1,
      recovered: false,
    };
  }
}

export function reconcileSelectedReleasesSync(
  { budget, command, environment, expectedState, headRef, repo, selected },
  dependencies = {},
) {
  const readReleaseMap = dependencies.readReleaseMap ?? readReleaseMapSync;
  const snapshotReleaseMap = () =>
    readReleaseMap(repo, boundedReleaseSnapshotReadOptions(budget));
  const readTagMap = dependencies.readTagMap ?? readSelectedRemoteTagMapSync;
  const snapshotTagMap = () => readTagMap(repo, selected, {
    budget,
    environment,
    timeoutMs: command === "promote"
      ? GITHUB_RELEASE_PROMOTION_TAG_SNAPSHOT_TIMEOUT_MS
      : DEFAULT_GIT_SNAPSHOT_TIMEOUT_MS,
  });
  const perTagDependencies = {
    ...dependencies,
    readTagRef: dependencies.readTagRef ?? ((tag) =>
      readTagRefSync(repo, tag, remainingGitHubReadOptions(budget))),
  };
  const perReleaseDependencies = {
    ...dependencies,
    readRelease: dependencies.readRelease ?? ((tag) =>
      readReleaseByTagSync(repo, tag, remainingGitHubReadOptions(budget))),
  };
  const releaseSnapshotSleep = dependencies.releaseSnapshotSleep ?? sleepSync;
  const requiredReleaseMap = (requiredState, { expectedReleaseIds } = {}) =>
    readRequiredReleaseMapSync({
      budget,
      expectedReleaseIds,
      readReleaseMap: snapshotReleaseMap,
      requiredState,
      selected,
      sleep: releaseSnapshotSleep,
    });

  let releasesByTag;
  if (command === "verify") {
    releasesByTag = requiredReleaseMap(expectedState);
  } else if (command === "promote") {
    // No mutation has happened yet. A missing/stale precondition can fail and
    // be rerun safely, so it does not need the post-mutation visibility wait.
    releasesByTag = snapshotReleaseMap();
    validateExistingReleases(selected, releasesByTag);
  } else {
    releasesByTag = snapshotReleaseMap();
    validateExistingReleases(selected, releasesByTag);
  }
  let tagsByName = snapshotTagMap();
  requireCollisionFreeTagSnapshot(selected, tagsByName, headRef);

  if (command === "preflight") {
    console.log(`${selected.length} selected product tag/release names are absent or exact-SHA resumable`);
    return;
  }
  if (command === "recovery-preflight") {
    console.log(
      `${selected.length} selected product tag/release names are absent or exact-SHA resumable for same-version recovery`,
    );
    return;
  }

  if (command === "stage") {
    for (const { product, tag } of selected) {
      if (tagsByName.get(tag) !== null) continue;
      const result = stageMissingTagFromSnapshot(
        { budget, environment, headRef, repo, tag },
        {
          ...perTagDependencies,
          readTagRef: () => perTagDependencies.readTagRef(tag),
        },
      );
      if (result.mutationAttempts > 0) console.log(`reconciled exact-SHA tag ${tag} for ${product}`);
    }
    tagsByName = snapshotTagMap();
    requireExactTagSnapshot(selected, tagsByName, headRef);
    for (const { metadata, tag } of selected) {
      if (releasesByTag.has(tag)) continue;
      const result = stageMissingReleaseFromSnapshot(
        { budget, environment, metadata, repo, tag },
        {
          ...perReleaseDependencies,
          readReleaseMap: snapshotReleaseMap,
          readRelease: () => perReleaseDependencies.readRelease(tag),
          releaseSnapshotSleep,
        },
      );
      if (result.mutationAttempts > 0) console.log(`reconciled draft GitHub release ${tag}`);
    }
    releasesByTag = requiredReleaseMap("staged");
    tagsByName = snapshotTagMap();
    requireExactTagSnapshot(selected, tagsByName, headRef);
  } else {
    requireExactTagSnapshot(selected, tagsByName, headRef);
  }

  for (const { tag } of selected) {
    if (!releasesByTag.has(tag)) throw error(`GitHub release for ${tag} does not exist`);
  }

  if (command === "promote") {
    const promotionFailures = [];
    const expectedReleaseIds = new Map(
      selected.map(({ tag }) => [tag, releasesByTag.get(tag).id]),
    );
    for (const { metadata, tag } of selected) {
      const release = releasesByTag.get(tag);
      if (!release.draft) continue;
      const result = promoteReleaseFromSnapshot(
        {
          budget,
          environment,
          expectedId: release.id,
          metadata,
          repo,
          tag,
        },
        {
          ...perReleaseDependencies,
          readRelease: () => perReleaseDependencies.readRelease(tag),
        },
      );
      if (result.fastMutationError !== undefined) {
        promotionFailures.push({ cause: result.fastMutationError, tag });
      }
      if (result.mutationAttempts > 0) console.log(`reconciled promotion of ${tag}`);
    }
    try {
      releasesByTag = requiredReleaseMap("public", { expectedReleaseIds });
    } catch (observationCause) {
      if (promotionFailures.length === 0) throw observationCause;
      const firstFailure = promotionFailures[0];
      const mutationDetail = redactGitHubReadDetail(
        firstFailure.cause instanceof Error
          ? firstFailure.cause.message
          : String(firstFailure.cause),
        environment,
      );
      throw error(
        `${observationCause instanceof Error ? observationCause.message : String(observationCause)}; `
          + `${promotionFailures.length} promotion mutation failure(s); first failure for `
          + `${firstFailure.tag}: ${mutationDetail || "unknown failure"}`,
        { cause: firstFailure.cause },
      );
    }
    tagsByName = snapshotTagMap();
    requireExactTagSnapshot(selected, tagsByName, headRef);
  }

  const wantDraft = finalReleaseState(selected, releasesByTag, command, expectedState);
  if (expectedState === "staged" && command !== "promote") {
    console.log(`${selected.length} exact-SHA releases are staged (draft or already promoted by a resumable prior run)`);
  } else {
    console.log(`${selected.length} exact-SHA releases are ${wantDraft ? "draft" : "public"}`);
  }
}

function defaultWindowForCommand(command) {
  if (command === "stage") return 30 * 60_000;
  // Promotion count is release-plan-derived. Keep the command inside the
  // mandatory finalization reserve while leaving a bounded contingency margin.
  if (command === "promote") return GITHUB_RELEASE_PROMOTION_COMMAND_WINDOW_MS;
  return 5 * 60_000;
}

export function createReleaseDraftOperationBudget(
  command,
  { environment = process.env, now = Date.now } = {},
) {
  const defaultWindowMs = defaultWindowForCommand(command);
  const budget = createGitHubOperationBudget({
    defaultWindowMs,
    environment,
    now,
  });
  if (command !== "promote") return budget;
  const maximumDeadlineMs = budget.startedAtMs + defaultWindowMs;
  if (budget.deadlineMs <= maximumDeadlineMs) return budget;
  return Object.freeze({
    ...budget,
    deadlineMs: maximumDeadlineMs,
  });
}

export function main(argv, { environment = process.env, now = Date.now } = {}) {
  const { command, values } = parseArgs([...argv]);
  if (!["preflight", "recovery-preflight", "stage", "verify", "promote"].includes(command)) {
    throw error("command must be preflight, recovery-preflight, stage, verify, or promote");
  }
  const repo = environment.GITHUB_REPOSITORY?.trim();
  if (!repo || !environment.GH_TOKEN) {
    throw error("GITHUB_REPOSITORY and GH_TOKEN are required");
  }

  let products;
  try {
    products = JSON.parse(values.get("products-json") ?? "");
  } catch (cause) {
    throw error(`invalid --products-json: ${cause.message}`, { cause });
  }
  if (
    !Array.isArray(products)
    || products.length === 0
    || products.some((product) => typeof product !== "string" || product.length === 0)
    || new Set(products).size !== products.length
  ) {
    throw error("--products-json must be a non-empty unique product string list");
  }

  const headRef = values.get("head-ref");
  if (!headRef || !FULL_SHA.test(headRef)) {
    throw error("--head-ref must be a full lowercase commit SHA");
  }
  const expectedState = values.get("state") ?? "draft";
  if (!new Set(["draft", "public", "staged"]).has(expectedState)) {
    throw error("--state must be draft, public, or staged");
  }

  const selected = selectedReleases(command, products, headRef, environment);
  const budget = createReleaseDraftOperationBudget(command, { environment, now });
  reconcileSelectedReleasesSync({
    budget,
    command,
    environment: budget.environment,
    expectedState,
    headRef,
    repo,
    selected,
  });
}

if (import.meta.main) {
  try {
    main(process.argv.slice(2));
  } catch (cause) {
    console.error(redactGitHubReadDetail(cause instanceof Error ? cause.message : String(cause)));
    process.exit(1);
  }
}
