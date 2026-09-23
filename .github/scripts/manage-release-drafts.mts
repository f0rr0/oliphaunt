#!/usr/bin/env bun
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { setTimeout as sleepAsync } from 'node:timers/promises';
import { loadProducts } from '../../tools/release/release-graph.mts';
import { redactGitHubReadDetail, requestGithubGraphql } from '../../tools/release/github-read.mts';
import {
  assertResumableReleaseMetadata,
  createGitHubOperationBudget,
  exactReleaseMetadata,
  exactTagRefPayload,
  GITHUB_RELEASE_SNAPSHOT_MAX_READ_ATTEMPTS,
  GITHUB_RELEASE_SNAPSHOT_READ_WINDOW_MS,
  GITHUB_RELEASE_SNAPSHOT_VISIBILITY_DELAYS_MS,
  GITHUB_RELEASE_SNAPSHOT_VISIBILITY_WINDOW_MS,
  GitHubReleaseSnapshotRaceError,
  readReleaseMap as githubReleaseMap,
  readReleaseByTag,
  readTagRef,
  reconcileGitHubMutation,
  releaseNotesForVersion,
  remainingGitHubReadOptions,
  requestGithubMutation,
} from '../../tools/release/github-release-mutations.mts';
import {
  DEFAULT_PUBLICATION_LOCK,
  loadPublicationLock,
} from '../../tools/release/publication-lock.mts';
import {
  RELEASE_PLEASE_ASSERT_MARKABLE_WINDOW_MS,
  RELEASE_PLEASE_MARK_TAGGED_WINDOW_MS,
} from '../../tools/release/release-please-pr-lifecycle.mts';

const FULL_SHA = /^[0-9a-f]{40}$/u;
const DEFAULT_TAG_SNAPSHOT_TIMEOUT_MS = 60_000;
const DEFAULT_FAST_MUTATION_TIMEOUT_MS = 60_000;
export const GITHUB_RELEASE_PROMOTION_MUTATION_TIMEOUT_MS = 10_000;
export const GITHUB_RELEASE_PROMOTION_TAG_SNAPSHOT_TIMEOUT_MS = 30_000;
const GITHUB_RELEASE_PROMOTION_LIFECYCLE_MARGIN_MS = 30_000;
const GITHUB_RELEASE_PROMOTION_STEP_WINDOW_MS = 16 * 60_000;
export const GITHUB_RELEASE_PROMOTION_COMMAND_WINDOW_MS =
  GITHUB_RELEASE_PROMOTION_STEP_WINDOW_MS -
  RELEASE_PLEASE_ASSERT_MARKABLE_WINDOW_MS -
  RELEASE_PLEASE_MARK_TAGGED_WINDOW_MS -
  GITHUB_RELEASE_PROMOTION_LIFECYCLE_MARGIN_MS;

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
    'usage: manage-release-drafts.mts <preflight|stage|verify|promote> ' +
      '--products-json JSON --head-ref SHA [--state draft|public|staged]',
  );
}

function parseArgs(argv) {
  const command = argv.shift();
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || value === undefined || values.has(key.slice(2))) {
      throw usageError();
    }
    values.set(key.slice(2), value);
  }
  return { command, values };
}

function selectedPublicationLock(command, products, headRef, environment) {
  const file = path.resolve(
    environment.PUBLICATION_LOCK_PATH ??
      environment.OLIPHAUNT_PUBLICATION_LOCK ??
      DEFAULT_PUBLICATION_LOCK,
  );
  if (!existsSync(file)) {
    if (command === 'preflight') return null;
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
  const productMetadata = loadProducts('release-drafts');
  const publicationLock = selectedPublicationLock(command, products, headRef, environment);
  const lockedProducts =
    publicationLock === null
      ? new Map()
      : new Map(publicationLock.products.map((product) => [product.id, product]));
  return products.map((product) => {
    const config = productMetadata[product];
    if (!config) throw error(`unknown release product ${product}`);
    const locked = lockedProducts.get(product);
    const version = locked?.version ?? config.version;
    if (config.version !== version) {
      throw error(
        `${product} graph version ${config.version} does not match publication lock version ${version}`,
      );
    }
    let body;
    try {
      body = releaseNotesForVersion(readFileSync(config.changelog_path, 'utf8'), version);
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
  if (ref === null) return { kind: 'absent' };
  if (ref.type !== 'commit' || ref.sha !== headRef || ref.ref !== `refs/tags/${tag}`) {
    return {
      detail: `${tag} targets ${ref.type}:${ref.sha}, not commit:${headRef}`,
      kind: 'conflict',
    };
  }
  return { kind: 'desired' };
}

function releaseReconciliationState(release, expected, { allowPublic, expectedId } = {}) {
  if (release === null) {
    return expectedId === undefined
      ? { kind: 'absent' }
      : { detail: `${expected.tag_name} release ${expectedId} disappeared`, kind: 'conflict' };
  }
  try {
    assertResumableReleaseMetadata(release, expected);
  } catch (cause) {
    return { detail: cause.message, kind: 'conflict' };
  }
  if (expectedId !== undefined && release.id !== expectedId) {
    return {
      detail: `${expected.tag_name} release id changed from ${expectedId} to ${release.id}`,
      kind: 'conflict',
    };
  }
  if (allowPublic === true) return { kind: 'desired' };
  return release.draft ? { kind: 'unchanged' } : { kind: 'desired' };
}

function mutationOptions(budget, environment, overrides) {
  return { budget, environment, ...overrides };
}

export async function stageExactTag(
  { budget, environment, headRef, repo, tag },
  dependencies = {},
) {
  const readTag =
    dependencies.readTagRef ??
    (async () => await readTagRef(repo, tag, remainingGitHubReadOptions(budget)));
  const createTag =
    dependencies.createTag ??
    (async ({ deadlineMs, now, timeoutMs }) =>
      await requestGithubMutation(`repos/${repo}/git/refs`, {
        method: 'POST',
        environment,
        deadlineMs,
        input: `${JSON.stringify(exactTagRefPayload(tag, headRef))}\n`,
        now,
        timeoutMs,
      }));
  return await reconcileGitHubMutation({
    inspect: async () => tagReconciliationState(await readTag(), tag, headRef),
    label: `create exact tag ${tag}`,
    mutate: createTag,
    options: mutationOptions(budget, environment, dependencies.mutationOptions),
  });
}

export async function stageExactDraftRelease(
  { budget, environment, metadata, repo, tag },
  dependencies = {},
) {
  const readRelease =
    dependencies.readRelease ??
    (async () => await readReleaseByTag(repo, tag, remainingGitHubReadOptions(budget)));
  const createRelease =
    dependencies.createRelease ??
    (async ({ deadlineMs, now, timeoutMs }) =>
      await requestGithubMutation(`repos/${repo}/releases`, {
        method: 'POST',
        environment,
        deadlineMs,
        input: `${JSON.stringify({ ...metadata, draft: true })}\n`,
        now,
        timeoutMs,
      }));
  return await reconcileGitHubMutation({
    inspect: async () =>
      releaseReconciliationState(await readRelease(), metadata, { allowPublic: true }),
    label: `create exact draft release ${tag}`,
    mutate: createRelease,
    options: mutationOptions(budget, environment, dependencies.mutationOptions),
  });
}

export async function promoteExactRelease(
  { budget, environment, expectedId, metadata, repo, tag },
  dependencies = {},
) {
  const readRelease =
    dependencies.readRelease ??
    (async () => await readReleaseByTag(repo, tag, remainingGitHubReadOptions(budget)));
  const promoteRelease =
    dependencies.promoteRelease ??
    (async ({ deadlineMs, now, timeoutMs }) =>
      await requestGithubMutation(`repos/${repo}/releases/${expectedId}`, {
        method: 'PATCH',
        environment,
        deadlineMs,
        input: `${JSON.stringify({ draft: false })}\n`,
        now,
        timeoutMs,
      }));
  return await reconcileGitHubMutation({
    inspect: async () => releaseReconciliationState(await readRelease(), metadata, { expectedId }),
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

function pendingRequiredReleases(selected, releasesByTag, requiredState) {
  return selected.flatMap(({ tag }) => {
    const release = releasesByTag.get(tag);
    if (release === undefined) return [`${tag} (missing)`];
    if (requiredState === 'public' && release.draft) return [`${tag} (still draft)`];
    if (requiredState === 'draft' && !release.draft) return [`${tag} (already public)`];
    return [];
  });
}

function validateExpectedReleaseIds(selected, releasesByTag, expectedReleaseIds) {
  if (expectedReleaseIds === undefined) return;
  if (!(expectedReleaseIds instanceof Map)) {
    throw error('expected release identities must be a Map');
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

async function readRequiredReleaseMap({
  budget,
  expectedReleaseIds,
  readReleaseMap,
  requiredState,
  selected,
  sleep = sleepAsync,
}) {
  if (!new Set(['draft', 'public', 'staged']).has(requiredState)) {
    throw error('required release snapshot state must be draft, public, or staged');
  }
  if (typeof readReleaseMap !== 'function' || typeof sleep !== 'function') {
    throw error('required release snapshot reader and sleep callback are required');
  }
  let lastTransientSnapshotError = null;
  for (
    let attempt = 0;
    attempt <= GITHUB_RELEASE_SNAPSHOT_VISIBILITY_DELAYS_MS.length;
    attempt += 1
  ) {
    let pending;
    try {
      const releasesByTag = await readReleaseMap();
      validateExistingReleases(selected, releasesByTag);
      validateExpectedReleaseIds(selected, releasesByTag, expectedReleaseIds);
      pending = pendingRequiredReleases(selected, releasesByTag, requiredState);
      if (pending.length === 0) return releasesByTag;
      lastTransientSnapshotError = null;
    } catch (cause) {
      if (!(cause instanceof GitHubReleaseSnapshotRaceError)) throw cause;
      if (cause.observedRelease !== undefined) {
        const observedReleaseMap = new Map([
          [cause.observedRelease.tag_name, cause.observedRelease],
        ]);
        validateExistingReleases(selected, observedReleaseMap);
        validateExpectedReleaseIds(selected, observedReleaseMap, expectedReleaseIds);
      }
      lastTransientSnapshotError = cause;
      pending = selected.map(({ tag }) => `${tag} (inconsistent paginated snapshot)`);
    }
    if (attempt === GITHUB_RELEASE_SNAPSHOT_VISIBILITY_DELAYS_MS.length) {
      throw error(
        `GitHub release list did not converge to ${requiredState} state within ` +
          `${GITHUB_RELEASE_SNAPSHOT_VISIBILITY_WINDOW_MS}ms: ${pending.join(', ')}`,
        { cause: lastTransientSnapshotError ?? undefined },
      );
    }
    const remainingVisibilityWindowMs = GITHUB_RELEASE_SNAPSHOT_VISIBILITY_DELAYS_MS.slice(
      attempt,
    ).reduce((total, delay) => total + delay, 0);
    if (budget.deadlineMs - budget.now() < remainingVisibilityWindowMs) {
      throw error(
        `GitHub operation lacks the complete ${remainingVisibilityWindowMs}ms release-list ` +
          `visibility window required for: ${pending.join(', ')}`,
        { cause: lastTransientSnapshotError ?? undefined },
      );
    }
    await sleep(GITHUB_RELEASE_SNAPSHOT_VISIBILITY_DELAYS_MS[attempt]);
  }
  throw error('required release snapshot loop ended unexpectedly');
}

function boundedReleaseSnapshotReadOptions(budget) {
  const startedAtMs = budget.now();
  const snapshotBudget = {
    ...budget,
    deadlineMs: Math.min(budget.deadlineMs, startedAtMs + GITHUB_RELEASE_SNAPSHOT_READ_WINDOW_MS),
  };
  return remainingGitHubReadOptions(snapshotBudget, {
    attemptTimeoutMs: 4_000,
    baseDelayMs: 500,
    maxAttempts: GITHUB_RELEASE_SNAPSHOT_MAX_READ_ATTEMPTS,
    maxDelayMs: 500,
  });
}

async function requireExactTags(selected, repo, headRef, budget) {
  for (const { product, tag } of selected) {
    const ref = await readTagRef(repo, tag, remainingGitHubReadOptions(budget));
    const state = tagReconciliationState(ref, tag, headRef);
    if (state.kind !== 'desired') {
      throw error(state.kind === 'absent' ? `${product} tag ${tag} does not exist` : state.detail);
    }
  }
}

function finalReleaseState(selected, releasesByTag, command, expectedState) {
  const wantDraft = command === 'promote' ? false : expectedState === 'draft';
  for (const { tag } of selected) {
    const release = releasesByTag.get(tag);
    if (release === undefined) {
      throw error(`GitHub release for ${tag} does not exist after ${command}`);
    }
    if (expectedState !== 'staged' && release.draft !== wantDraft) {
      throw error(
        `${tag} is ${release.draft ? 'draft' : 'public'}; expected ${wantDraft ? 'draft' : 'public'}`,
      );
    }
  }
  return wantDraft;
}

function parseMutationJson(output, label) {
  if (typeof output !== 'string' || Buffer.byteLength(output, 'utf8') > 4 * 1024 * 1024) {
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
    value === null ||
    Array.isArray(value) ||
    typeof value !== 'object' ||
    value.ref !== `refs/tags/${tag}` ||
    value.object === null ||
    Array.isArray(value.object) ||
    typeof value.object !== 'object' ||
    value.object.sha !== headRef ||
    value.object.type !== 'commit'
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
      `${metadata.tag_name} mutation response is ${value.draft ? 'draft' : 'public'}; ` +
        `expected ${draft ? 'draft' : 'public'}`,
    );
  }
  if (expectedId !== undefined && value.id !== expectedId) {
    throw error(
      `${metadata.tag_name} mutation response id changed from ${expectedId} to ${value.id}`,
    );
  }
  return value;
}

function selectedTagNames(selected) {
  const tags = selected.map(({ tag }) => tag);
  if (
    tags.length === 0 ||
    new Set(tags).size !== tags.length ||
    tags.some(
      (tag) => typeof tag !== 'string' || tag.length === 0 || /[\s\u0000-\u001f\u007f]/u.test(tag),
    )
  ) {
    throw error('selected release tags must be a non-empty unique printable string list');
  }
  return tags;
}

// One bounded query returns only the selected refs, including explicit absences.
export async function readSelectedRemoteTagMap(repo, selected, options = {}) {
  if (typeof repo !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repo)) {
    throw error('GitHub repository must be OWNER/NAME');
  }
  const tags = selectedTagNames(selected);
  const now = options.budget?.now ?? Date.now;
  const timeout = options.timeoutMs ?? DEFAULT_TAG_SNAPSHOT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > DEFAULT_TAG_SNAPSHOT_TIMEOUT_MS) {
    throw error('remote tag snapshot timeout must be between 1 and 60000ms');
  }
  const deadlineMs = Math.min(options.budget?.deadlineMs ?? Infinity, now() + timeout);
  if (deadlineMs <= now())
    throw error('GitHub operation deadline has been reached before the remote tag snapshot');
  const [owner, name] = repo.split('/');
  const variables = { owner, name };
  for (const [index, tag] of tags.entries()) variables['tag' + index] = 'refs/tags/' + tag;
  const declarations = Object.keys(variables)
    .map((key) => '$' + key + ': String!')
    .join(', ');
  const fields = tags
    .map(
      (_, index) =>
        'tag' +
        index +
        ': ref(qualifiedName: $tag' +
        index +
        ') { prefix name target { __typename oid } }',
    )
    .join('\n');
  const result = await requestGithubGraphql(
    'query SelectedReleaseTags(' +
      declarations +
      ') { repository(owner: $owner, name: $name) { nameWithOwner ' +
      fields +
      ' } }',
    variables,
    {
      environment: options.environment ?? options.budget?.environment ?? process.env,
      deadlineMs,
      nowImpl: now,
      attemptTimeoutMs: timeout,
      maxAttempts: 2,
      fetchImpl: options.fetchImpl,
    },
  );
  const repository = result?.data?.repository;
  if (
    (result?.errors !== undefined && (!Array.isArray(result.errors) || result.errors.length > 0)) ||
    repository?.nameWithOwner !== repo ||
    Object.keys(repository).length !== tags.length + 1
  ) {
    throw error('remote tag snapshot returned an incomplete or unexpected repository');
  }
  return new Map(
    tags.map((tag, index) => {
      const ref = repository['tag' + index];
      if (ref === null) return [tag, null];
      if (
        ref?.prefix !== 'refs/tags/' ||
        ref.name !== tag ||
        !FULL_SHA.test(ref.target?.oid ?? '') ||
        !['Commit', 'Tag', 'Tree', 'Blob'].includes(ref.target?.__typename)
      ) {
        throw error('remote tag snapshot contained malformed or unexpected ref data');
      }
      return [
        tag,
        {
          ref: ref.prefix + ref.name,
          sha: ref.target.oid,
          type: ref.target.__typename.toLowerCase(),
        },
      ];
    }),
  );
}

function requireExactTagSnapshot(selected, tagsByName, headRef) {
  if (!(tagsByName instanceof Map)) throw error('remote tag snapshot must be a Map');
  for (const { product, tag } of selected) {
    const state = tagReconciliationState(tagsByName.get(tag) ?? null, tag, headRef);
    if (state.kind !== 'desired') {
      throw error(state.kind === 'absent' ? `${product} tag ${tag} does not exist` : state.detail);
    }
  }
}

function requireCollisionFreeTagSnapshot(selected, tagsByName, headRef) {
  if (!(tagsByName instanceof Map)) throw error('remote tag snapshot must be a Map');
  for (const { tag } of selected) {
    const state = tagReconciliationState(tagsByName.get(tag) ?? null, tag, headRef);
    if (state.kind === 'conflict') throw error(state.detail);
  }
}

function fastMutationTimeout(budget, requiredTimeoutMs = DEFAULT_FAST_MUTATION_TIMEOUT_MS) {
  const remainingMs = budget.deadlineMs - budget.now();
  if (remainingMs < requiredTimeoutMs) {
    throw error(
      `GitHub operation requires a complete ${requiredTimeoutMs}ms mutation timeout; ` +
        `${Math.max(0, remainingMs)}ms remains`,
    );
  }
  return requiredTimeoutMs;
}

async function defaultTagMutation({ deadlineMs, environment, headRef, now, repo, tag, timeoutMs }) {
  return await requestGithubMutation(`repos/${repo}/git/refs`, {
    method: 'POST',
    environment,
    deadlineMs,
    input: `${JSON.stringify(exactTagRefPayload(tag, headRef))}\n`,
    now,
    timeoutMs,
  });
}

async function defaultReleaseMutation({ deadlineMs, environment, metadata, now, repo, timeoutMs }) {
  return await requestGithubMutation(`repos/${repo}/releases`, {
    method: 'POST',
    environment,
    deadlineMs,
    input: `${JSON.stringify({ ...metadata, draft: true })}\n`,
    now,
    timeoutMs,
  });
}

async function defaultPromotionMutation({
  deadlineMs,
  environment,
  expectedId,
  now,
  repo,
  timeoutMs,
}) {
  return await requestGithubMutation(`repos/${repo}/releases/${expectedId}`, {
    method: 'PATCH',
    environment,
    deadlineMs,
    input: `${JSON.stringify({ draft: false })}\n`,
    now,
    timeoutMs,
  });
}

async function stageMissingTagFromSnapshot(context, dependencies) {
  const mutateTag = dependencies.mutateTag ?? defaultTagMutation;
  try {
    const output = await mutateTag({
      ...context,
      deadlineMs: context.budget.deadlineMs,
      now: context.budget.now,
      timeoutMs: fastMutationTimeout(context.budget),
    });
    exactTagFromMutation(output, context.tag, context.headRef);
    return { mutationAttempts: 1, recovered: false };
  } catch (cause) {
    const result = await stageExactTag(context, {
      createTag: async ({ deadlineMs, now, timeoutMs }) =>
        await mutateTag({
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

async function stageMissingReleaseFromSnapshot(context, dependencies) {
  const mutateRelease = dependencies.mutateRelease ?? defaultReleaseMutation;
  try {
    const output = await mutateRelease({
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
      releasesByTag = await readRequiredReleaseMap({
        budget: context.budget,
        readReleaseMap: dependencies.readReleaseMap,
        requiredState: 'staged',
        selected: [{ metadata: context.metadata, tag: context.tag }],
        sleep: dependencies.releaseSnapshotSleep,
      });
    } catch (observationCause) {
      const mutationDetail = redactGitHubReadDetail(
        cause instanceof Error ? cause.message : String(cause),
        context.environment,
      );
      throw error(
        `${observationCause instanceof Error ? observationCause.message : String(observationCause)}; ` +
          `original draft mutation failure: ${mutationDetail || 'unknown failure'}`,
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

async function promoteReleaseFromSnapshot(context, dependencies) {
  const mutatePromotion = dependencies.mutatePromotion ?? defaultPromotionMutation;
  try {
    const output = await mutatePromotion({
      ...context,
      deadlineMs: context.budget.deadlineMs,
      now: context.budget.now,
      timeoutMs: fastMutationTimeout(context.budget, GITHUB_RELEASE_PROMOTION_MUTATION_TIMEOUT_MS),
    });
    exactReleaseFromMutation(output, context.metadata, {
      draft: false,
      expectedId: context.expectedId,
    });
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

export async function reconcileSelectedReleases(
  { budget, command, environment, expectedState, headRef, repo, selected },
  dependencies = {},
) {
  const readReleaseMap = dependencies.readReleaseMap ?? githubReleaseMap;
  const snapshotReleaseMap = async () =>
    await readReleaseMap(repo, boundedReleaseSnapshotReadOptions(budget));
  const readTagMap = dependencies.readTagMap ?? readSelectedRemoteTagMap;
  const snapshotTagMap = () =>
    readTagMap(repo, selected, {
      budget,
      environment,
      timeoutMs:
        command === 'promote'
          ? GITHUB_RELEASE_PROMOTION_TAG_SNAPSHOT_TIMEOUT_MS
          : DEFAULT_TAG_SNAPSHOT_TIMEOUT_MS,
    });
  const perTagDependencies = {
    ...dependencies,
    readTagRef:
      dependencies.readTagRef ??
      (async (tag) => await readTagRef(repo, tag, remainingGitHubReadOptions(budget))),
  };
  const perReleaseDependencies = {
    ...dependencies,
    readRelease:
      dependencies.readRelease ??
      (async (tag) => await readReleaseByTag(repo, tag, remainingGitHubReadOptions(budget))),
  };
  const releaseSnapshotSleep = dependencies.releaseSnapshotSleep ?? sleepAsync;
  const requiredReleaseMap = async (requiredState, { expectedReleaseIds } = {}) =>
    await readRequiredReleaseMap({
      budget,
      expectedReleaseIds,
      readReleaseMap: snapshotReleaseMap,
      requiredState,
      selected,
      sleep: releaseSnapshotSleep,
    });

  let releasesByTag;
  if (command === 'verify') {
    releasesByTag = await requiredReleaseMap(expectedState);
  } else if (command === 'promote') {
    // No mutation has happened yet. A missing/stale precondition can fail and
    // be rerun safely, so it does not need the post-mutation visibility wait.
    releasesByTag = await snapshotReleaseMap();
    validateExistingReleases(selected, releasesByTag);
  } else {
    releasesByTag = await snapshotReleaseMap();
    validateExistingReleases(selected, releasesByTag);
  }
  let tagsByName = await snapshotTagMap();
  requireCollisionFreeTagSnapshot(selected, tagsByName, headRef);

  if (command === 'preflight') {
    console.log(
      `${selected.length} selected product tag/release names are absent or exact-SHA resumable`,
    );
    return;
  }
  if (command === 'stage') {
    for (const { product, tag } of selected) {
      if (tagsByName.get(tag) !== null) continue;
      const result = await stageMissingTagFromSnapshot(
        { budget, environment, headRef, repo, tag },
        {
          ...perTagDependencies,
          readTagRef: async () => await perTagDependencies.readTagRef(tag),
        },
      );
      if (result.mutationAttempts > 0)
        console.log(`reconciled exact-SHA tag ${tag} for ${product}`);
    }
    tagsByName = await snapshotTagMap();
    requireExactTagSnapshot(selected, tagsByName, headRef);
    for (const { metadata, tag } of selected) {
      if (releasesByTag.has(tag)) continue;
      const result = await stageMissingReleaseFromSnapshot(
        { budget, environment, metadata, repo, tag },
        {
          ...perReleaseDependencies,
          readReleaseMap: snapshotReleaseMap,
          readRelease: async () => await perReleaseDependencies.readRelease(tag),
          releaseSnapshotSleep,
        },
      );
      if (result.mutationAttempts > 0) console.log(`reconciled draft GitHub release ${tag}`);
    }
    releasesByTag = await requiredReleaseMap('staged');
    tagsByName = await snapshotTagMap();
    requireExactTagSnapshot(selected, tagsByName, headRef);
  } else {
    requireExactTagSnapshot(selected, tagsByName, headRef);
  }

  for (const { tag } of selected) {
    if (!releasesByTag.has(tag)) throw error(`GitHub release for ${tag} does not exist`);
  }

  if (command === 'promote') {
    const promotionFailures = [];
    const expectedReleaseIds = new Map(selected.map(({ tag }) => [tag, releasesByTag.get(tag).id]));
    for (const { metadata, tag } of selected) {
      const release = releasesByTag.get(tag);
      if (!release.draft) continue;
      const result = await promoteReleaseFromSnapshot(
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
          readRelease: async () => await perReleaseDependencies.readRelease(tag),
        },
      );
      if (result.fastMutationError !== undefined) {
        promotionFailures.push({ cause: result.fastMutationError, tag });
      }
      if (result.mutationAttempts > 0) console.log(`reconciled promotion of ${tag}`);
    }
    try {
      releasesByTag = await requiredReleaseMap('public', { expectedReleaseIds });
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
        `${observationCause instanceof Error ? observationCause.message : String(observationCause)}; ` +
          `${promotionFailures.length} promotion mutation failure(s); first failure for ` +
          `${firstFailure.tag}: ${mutationDetail || 'unknown failure'}`,
        { cause: firstFailure.cause },
      );
    }
    tagsByName = await snapshotTagMap();
    requireExactTagSnapshot(selected, tagsByName, headRef);
  }

  const wantDraft = finalReleaseState(selected, releasesByTag, command, expectedState);
  if (expectedState === 'staged' && command !== 'promote') {
    console.log(
      `${selected.length} exact-SHA releases are staged (draft or already promoted by a resumable prior run)`,
    );
  } else {
    console.log(`${selected.length} exact-SHA releases are ${wantDraft ? 'draft' : 'public'}`);
  }
}

function defaultWindowForCommand(command) {
  if (command === 'stage') return 30 * 60_000;
  // Promotion count is release-plan-derived. Keep the command inside the
  // mandatory finalization reserve while leaving a bounded contingency margin.
  if (command === 'promote') return GITHUB_RELEASE_PROMOTION_COMMAND_WINDOW_MS;
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
  if (command !== 'promote') return budget;
  const maximumDeadlineMs = budget.startedAtMs + defaultWindowMs;
  if (budget.deadlineMs <= maximumDeadlineMs) return budget;
  return Object.freeze({
    ...budget,
    deadlineMs: maximumDeadlineMs,
  });
}

export async function main(argv, { environment = process.env, now = Date.now } = {}) {
  const { command, values } = parseArgs([...argv]);
  if (!['preflight', 'stage', 'verify', 'promote'].includes(command)) {
    throw error('command must be preflight, stage, verify, or promote');
  }
  const repo = environment.GITHUB_REPOSITORY?.trim();
  if (!repo || !environment.GH_TOKEN) {
    throw error('GITHUB_REPOSITORY and GH_TOKEN are required');
  }

  let products;
  try {
    products = JSON.parse(values.get('products-json') ?? '');
  } catch (cause) {
    throw error(`invalid --products-json: ${cause.message}`, { cause });
  }
  if (
    !Array.isArray(products) ||
    products.length === 0 ||
    products.some((product) => typeof product !== 'string' || product.length === 0) ||
    new Set(products).size !== products.length
  ) {
    throw error('--products-json must be a non-empty unique product string list');
  }

  const headRef = values.get('head-ref');
  if (!headRef || !FULL_SHA.test(headRef)) {
    throw error('--head-ref must be a full lowercase commit SHA');
  }
  const expectedState = values.get('state') ?? 'draft';
  if (!new Set(['draft', 'public', 'staged']).has(expectedState)) {
    throw error('--state must be draft, public, or staged');
  }

  const selected = selectedReleases(command, products, headRef, environment);
  const budget = createReleaseDraftOperationBudget(command, { environment, now });
  await reconcileSelectedReleases({
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
    await main(process.argv.slice(2));
  } catch (cause) {
    console.error(redactGitHubReadDetail(cause instanceof Error ? cause.message : String(cause)));
    process.exit(1);
  }
}
