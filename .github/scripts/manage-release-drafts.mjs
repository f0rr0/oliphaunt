#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { redactGitHubReadDetail } from "../../tools/release/github-read.mjs";
import {
  assertResumableReleaseMetadata,
  createGitHubOperationBudget,
  exactReleaseMetadata,
  exactTagRefPayload,
  readReleaseByTagSync,
  readReleaseMapSync,
  readTagRefSync,
  reconcileGitHubMutationSync,
  releaseNotesForVersion,
  remainingGitHubReadOptions,
  runGitHubMutationSync,
} from "../../tools/release/github-release-mutations.mjs";
import { loadGraph } from "../../tools/release/release-graph.mjs";
import {
  DEFAULT_PUBLICATION_LOCK,
  loadPublicationLock,
} from "../../tools/release/publication-lock.mjs";

const FULL_SHA = /^[0-9a-f]{40}$/u;
const DEFAULT_GIT_SNAPSHOT_TIMEOUT_MS = 60_000;
const DEFAULT_FAST_MUTATION_TIMEOUT_MS = 60_000;

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
    "usage: manage-release-drafts.mjs <preflight|stage|verify|promote> "
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
    if (command === "preflight") return null;
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
  const spawn = options.spawn ?? spawnSync;
  const result = spawn("git", [
    "-c",
    "credential.helper=",
    "ls-remote",
    "--refs",
    "--tags",
    `https://github.com/${repo}.git`,
    ...tags.map((tag) => `refs/tags/${tag}`),
  ], {
    cwd: options.cwd,
    encoding: "utf8",
    env: {
      ...(options.environment ?? process.env),
      GIT_ASKPASS: "",
      GIT_TERMINAL_PROMPT: "0",
      SSH_ASKPASS: "",
    },
    maxBuffer: 4 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: Math.max(1, Math.min(DEFAULT_GIT_SNAPSHOT_TIMEOUT_MS, remainingMs)),
  });
  if (result.error !== undefined || result.status !== 0) {
    const detail = redactGitHubReadDetail(result.error?.message ?? result.stderr ?? "");
    throw error(`could not read the exact selected remote tag snapshot${detail ? `: ${detail}` : ""}`);
  }
  const wanted = new Set(tags.map((tag) => `refs/tags/${tag}`));
  const refs = new Map();
  for (const line of String(result.stdout ?? "").split(/\r?\n/u).filter(Boolean)) {
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

function fastMutationTimeout(budget) {
  const remainingMs = budget.deadlineMs - budget.now();
  if (remainingMs < DEFAULT_FAST_MUTATION_TIMEOUT_MS) {
    throw error(
      `GitHub operation requires a complete ${DEFAULT_FAST_MUTATION_TIMEOUT_MS}ms mutation timeout; `
        + `${Math.max(0, remainingMs)}ms remains`,
    );
  }
  return DEFAULT_FAST_MUTATION_TIMEOUT_MS;
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
    const result = stageExactDraftReleaseSync(context, {
      createRelease: ({ deadlineMs, now, timeoutMs }) => mutateRelease({
        ...context,
        deadlineMs,
        now,
        timeoutMs,
      }),
      mutationOptions: dependencies.mutationOptions,
      readRelease: dependencies.readRelease,
    });
    return { ...result, fastMutationError: cause };
  }
}

function promoteReleaseFromSnapshot(context, dependencies) {
  const mutatePromotion = dependencies.mutatePromotion ?? defaultPromotionMutation;
  try {
    const output = mutatePromotion({
      ...context,
      deadlineMs: context.budget.deadlineMs,
      now: context.budget.now,
      timeoutMs: fastMutationTimeout(context.budget),
    });
    exactReleaseFromMutation(output, context.metadata, { draft: false, expectedId: context.expectedId });
    return { mutationAttempts: 1, recovered: false };
  } catch (cause) {
    const result = promoteExactReleaseSync(context, {
      mutationOptions: dependencies.mutationOptions,
      promoteRelease: ({ deadlineMs, now, timeoutMs }) => mutatePromotion({
        ...context,
        deadlineMs,
        now,
        timeoutMs,
      }),
      readRelease: dependencies.readRelease,
    });
    return { ...result, fastMutationError: cause };
  }
}

export function reconcileSelectedReleasesSync(
  { budget, command, environment, expectedState, headRef, repo, selected },
  dependencies = {},
) {
  const readReleaseMap = dependencies.readReleaseMap ?? ((targetRepo) =>
    readReleaseMapSync(targetRepo, remainingGitHubReadOptions(budget)));
  const readTagMap = dependencies.readTagMap ?? ((targetRepo, targetSelected) =>
    readSelectedRemoteTagMapSync(targetRepo, targetSelected, { budget, environment }));
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

  let releasesByTag = readReleaseMap(repo);
  validateExistingReleases(selected, releasesByTag);
  let tagsByName = readTagMap(repo, selected);
  requireCollisionFreeTagSnapshot(selected, tagsByName, headRef);

  if (command === "preflight") {
    console.log(`${selected.length} selected product tag/release names are absent or exact-SHA resumable`);
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
    tagsByName = readTagMap(repo, selected);
    requireExactTagSnapshot(selected, tagsByName, headRef);
    for (const { metadata, tag } of selected) {
      if (releasesByTag.has(tag)) continue;
      const result = stageMissingReleaseFromSnapshot(
        { budget, environment, metadata, repo, tag },
        {
          ...perReleaseDependencies,
          readRelease: () => perReleaseDependencies.readRelease(tag),
        },
      );
      if (result.mutationAttempts > 0) console.log(`reconciled draft GitHub release ${tag}`);
    }
    releasesByTag = readReleaseMap(repo);
    validateExistingReleases(selected, releasesByTag);
    tagsByName = readTagMap(repo, selected);
    requireExactTagSnapshot(selected, tagsByName, headRef);
  } else {
    requireExactTagSnapshot(selected, tagsByName, headRef);
  }

  for (const { tag } of selected) {
    if (!releasesByTag.has(tag)) throw error(`GitHub release for ${tag} does not exist`);
  }

  if (command === "promote") {
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
      if (result.mutationAttempts > 0) console.log(`reconciled promotion of ${tag}`);
    }
    releasesByTag = readReleaseMap(repo);
    validateExistingReleases(selected, releasesByTag);
    tagsByName = readTagMap(repo, selected);
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
  if (command === "promote") return 12 * 60_000;
  return 5 * 60_000;
}

export function main(argv, { environment = process.env, now = Date.now } = {}) {
  const { command, values } = parseArgs([...argv]);
  if (!["preflight", "stage", "verify", "promote"].includes(command)) {
    throw error("command must be preflight, stage, verify, or promote");
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
  const budget = createGitHubOperationBudget({
    defaultWindowMs: defaultWindowForCommand(command),
    environment,
    now,
  });
  reconcileSelectedReleasesSync({
    budget,
    command,
    environment,
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
