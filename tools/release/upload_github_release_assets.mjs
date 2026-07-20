#!/usr/bin/env bun
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

import {
  redactGitHubReadDetail,
  RetryableReadError,
  retryReadOperationSync,
} from "./github-read.mjs";
import {
  assertResumableReleaseMetadata,
  createGitHubOperationBudget,
  exactReleaseMetadata,
  readReleaseAssetsSync,
  readReleaseByTagSync,
  releaseNotesForVersion,
  remainingGitHubReadOptions,
  runGitHubMutationSync,
} from "./github-release-mutations.mjs";
import { GITHUB_CONTENT_WRITE_INTERVAL_MS } from "./github-content-write-pacer.mjs";
import { loadGraph } from "./release-graph.mjs";
import {
  DEFAULT_PUBLICATION_LOCK,
  loadPublicationLock,
  lockedProductArtifactPaths,
} from "./publication-lock.mjs";

const ROOT = path.resolve(import.meta.dir, "../..");
const FULL_SHA = /^[0-9a-f]{40}$/u;
const GITHUB_ASSET_ROLES = new Set(["github-release-asset", "github-release-metadata"]);
const GITHUB_ASSET_STATES = new Set(["open", "uploaded"]);
// Retained for compatibility with policy/tests that document the old embedded
// optimization. Exact inventories now always use the dedicated paginated
// release-assets endpoint because the release object's embedded array has no
// separately documented completeness contract.
export const MAX_SAFE_EMBEDDED_RELEASE_ASSETS = 0;
export const DEFAULT_GITHUB_RELEASE_ASSET_UPLOAD_TIMEOUT_MS = 60_000;
// Two complete default three-minute GitHub read windows: one for the frozen
// pre-upload snapshot and one for final exact-set verification. Fast failed
// transports leave their separately reserved timeout available for ambiguity
// reconciliation.
export const GITHUB_RELEASE_ASSET_UPLOAD_SNAPSHOT_RESERVE_MS = 6 * 60_000;
export const MAX_GITHUB_RELEASE_ASSET_UPLOAD_WINDOW_MS = 60 * 60_000;
const MIN_GITHUB_RELEASE_ASSET_UPLOAD_WINDOW_MS = 20 * 60_000;
const SHARED_UPLOAD_ABORT_CODE = "OLIPHAUNT_SHARED_UPLOAD_ABORT";

function error(message, options = {}) {
  return new Error(`upload_github_release_assets.mjs: ${message}`, options);
}

export function assertSharedUploadMutationAllowed(environment = process.env) {
  const configured = environment.OLIPHAUNT_GITHUB_UPLOAD_ABORT_PATH?.trim() ?? "";
  if (configured === "") return;
  if (configured.includes("\0")) throw error("shared upload abort path contains a NUL byte");
  const marker = path.resolve(configured);
  const metadata = lstatSync(marker, { throwIfNoEntry: false });
  if (metadata === undefined) return;
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 4 * 1024) {
    throw error("shared upload abort marker must be a bounded regular non-symlink file");
  }
  const cause = error("a peer product upload lane failed; refusing a new GitHub release asset mutation");
  cause.code = SHARED_UPLOAD_ABORT_CODE;
  throw cause;
}

function positiveSafeInteger(value, label, { allowZero = false } = {}) {
  if (
    !Number.isSafeInteger(value)
    || value < (allowZero ? 0 : 1)
  ) {
    throw error(`${label} must be ${allowZero ? "a non-negative" : "a positive"} safe integer`);
  }
  return value;
}

/**
 * Return a fail-closed per-product upload window derived from the frozen asset
 * count. The bound reserves a complete transport timeout and one content-write
 * pacing interval for every asset, plus a shared window for the exact pre/post
 * snapshots and any ambiguity reconciliation reads.
 *
 * A product whose worst-case bounded upload cannot fit the one-hour operation
 * ceiling must be repackaged into fewer aggregate assets instead of beginning
 * a release that cannot complete deterministically.
 */
export function githubReleaseAssetUploadWindowMs(
  assetCount,
  {
    contentWriteIntervalMs = GITHUB_CONTENT_WRITE_INTERVAL_MS,
    snapshotReserveMs = GITHUB_RELEASE_ASSET_UPLOAD_SNAPSHOT_RESERVE_MS,
    uploadTimeoutMs = DEFAULT_GITHUB_RELEASE_ASSET_UPLOAD_TIMEOUT_MS,
  } = {},
) {
  positiveSafeInteger(assetCount, "GitHub release asset count", { allowZero: true });
  positiveSafeInteger(contentWriteIntervalMs, "GitHub content-write interval");
  positiveSafeInteger(snapshotReserveMs, "GitHub release asset snapshot reserve");
  positiveSafeInteger(uploadTimeoutMs, "GitHub release asset upload timeout");
  const perAssetMs = contentWriteIntervalMs + uploadTimeoutMs;
  if (!Number.isSafeInteger(perAssetMs)) {
    throw error("GitHub release asset per-upload budget exceeds the safe integer range");
  }
  const requiredMs = (assetCount * perAssetMs) + snapshotReserveMs;
  if (!Number.isSafeInteger(requiredMs)) {
    throw error("GitHub release asset upload budget exceeds the safe integer range");
  }
  const windowMs = Math.max(MIN_GITHUB_RELEASE_ASSET_UPLOAD_WINDOW_MS, requiredMs);
  if (windowMs > MAX_GITHUB_RELEASE_ASSET_UPLOAD_WINDOW_MS) {
    throw error(
      `${assetCount} frozen GitHub release assets require ${requiredMs}ms, exceeding the `
        + `${MAX_GITHUB_RELEASE_ASSET_UPLOAD_WINDOW_MS}ms per-product ceiling; package the product into fewer aggregate assets`,
    );
  }
  return windowMs;
}

function usageError() {
  return error(
    "usage: upload_github_release_assets.mjs <product> [--tag TAG] [--repo OWNER/NAME] "
      + "[--publication-lock FILE] [--asset PATH]...",
  );
}

function valueArg(argv, index, name) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw usageError();
  return value;
}

function parseArgs(argv, environment) {
  const args = {
    assets: [],
    product: undefined,
    publicationLock: environment.OLIPHAUNT_PUBLICATION_LOCK ?? DEFAULT_PUBLICATION_LOCK,
    repo: environment.GITHUB_REPOSITORY || "",
    tag: undefined,
  };
  let index = 0;
  while (index < argv.length) {
    const arg = argv[index];
    if (arg === "--tag") {
      args.tag = valueArg(argv, index, arg);
      index += 2;
    } else if (arg === "--repo") {
      args.repo = valueArg(argv, index, arg);
      index += 2;
    } else if (arg === "--publication-lock") {
      args.publicationLock = valueArg(argv, index, arg);
      index += 2;
    } else if (arg === "--asset") {
      args.assets.push(valueArg(argv, index, arg));
      index += 2;
    } else if (arg.startsWith("--") || args.product !== undefined) {
      throw usageError();
    } else {
      args.product = arg;
      index += 1;
    }
  }
  if (!args.product) throw usageError();
  return args;
}

function sha256FileSync(file) {
  const digest = createHash("sha256");
  const descriptor = openSync(file, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const length = readSync(descriptor, buffer, 0, buffer.length, null);
      if (length === 0) break;
      digest.update(buffer.subarray(0, length));
    }
  } finally {
    closeSync(descriptor);
  }
  return digest.digest("hex");
}

function assertSafeAssetName(name) {
  if (
    typeof name !== "string"
    || name.length === 0
    || path.basename(name) !== name
    || /[\u0000-\u001f\u007f]/u.test(name)
    || ["#", "*", "?", "[", "]", "\\"].some((character) => name.includes(character))
  ) {
    throw error(`release asset has an unsafe or glob-ambiguous name: ${JSON.stringify(name)}`);
  }
}

function resolveAssetSync(asset) {
  for (const candidate of [path.join(ROOT, asset), path.resolve(asset)]) {
    try {
      const stat = lstatSync(candidate);
      if (stat.isFile() && !stat.isSymbolicLink()) return candidate;
    } catch {
      // Try the next exact path.
    }
  }
  throw error(`release asset is not a regular non-symlink file: ${asset}`);
}

function sameSet(left, right) {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

export function assertExactFrozenUploadSelection(frozen, requestedPaths, product) {
  if (!Array.isArray(frozen) || !(requestedPaths instanceof Set)) {
    throw new TypeError("frozen GitHub release assets and requested paths must be canonical collections");
  }
  if (frozen.some(({ type }) => type !== "file")) {
    throw error(`${product} frozen GitHub release asset set must contain only regular files`);
  }
  const frozenPaths = new Set(frozen.map(({ path: file }) => path.resolve(file)));
  if (!sameSet(requestedPaths, frozenPaths)) {
    throw error("requested GitHub release assets do not exactly match the frozen product asset set");
  }
}

export function frozenUploadPlan({ assets, product, publicationLock, repo, tag }) {
  if (!/^[^/\s]+\/[^/\s]+$/u.test(repo)) {
    throw error("--repo or GITHUB_REPOSITORY must be OWNER/NAME");
  }
  const lockFile = path.resolve(ROOT, publicationLock);
  if (!existsSync(lockFile)) throw error(`frozen publication lock does not exist: ${lockFile}`);
  const lock = loadPublicationLock(lockFile);
  if (!FULL_SHA.test(lock.source.commit)) {
    throw error("frozen publication lock source commit is not a full lowercase SHA");
  }
  const lockedProduct = lock.products.find((row) => row.id === product);
  if (lockedProduct === undefined) {
    throw error(`frozen publication lock does not select ${product}`);
  }
  const graph = loadGraph("github-release-assets");
  const config = graph.products[product];
  if (config === undefined || config.version !== lockedProduct.version) {
    throw error(`${product} release graph does not match frozen version ${lockedProduct.version}`);
  }
  const expectedTag = `${config.tag_prefix}${lockedProduct.version}`;
  if (tag !== undefined && tag !== expectedTag) {
    throw error(`requested tag ${tag} does not match frozen product tag ${expectedTag}`);
  }
  let body;
  try {
    body = releaseNotesForVersion(
      readFileSync(path.resolve(ROOT, config.changelog_path), "utf8"),
      lockedProduct.version,
    );
  } catch (cause) {
    throw error(`${product} frozen release notes are invalid: ${cause.message}`, { cause });
  }
  const metadata = exactReleaseMetadata({
    body,
    headRef: lock.source.commit,
    product,
    tag: expectedTag,
    version: lockedProduct.version,
  });
  const frozen = lockedProductArtifactPaths(lock, product)
    .filter(({ artifact }) => GITHUB_ASSET_ROLES.has(artifact.role));
  const requestedPaths = new Set(assets.map(resolveAssetSync).map((file) => path.resolve(file)));
  if (requestedPaths.size !== assets.length) {
    throw error("requested GitHub release assets contain duplicate paths");
  }
  assertExactFrozenUploadSelection(frozen, requestedPaths, product);
  const names = new Set();
  const plannedAssets = frozen.map(({ artifact, path: file }) => {
    assertSafeAssetName(artifact.name);
    if (path.basename(file) !== artifact.name || names.has(artifact.name)) {
      throw error(`${product} frozen GitHub release asset names are non-canonical or duplicated`);
    }
    names.add(artifact.name);
    return {
      file,
      name: artifact.name,
      sha256: artifact.sha256,
      size: artifact.size,
    };
  });
  return {
    assets: plannedAssets,
    headRef: lock.source.commit,
    lockDigest: lock.lockDigest,
    metadata,
    product,
    repo,
    tag: expectedTag,
  };
}

export function withStagedFrozenAssetSync(asset, operation, dependencies = {}) {
  const makeTemporary = dependencies.mkdtemp ?? mkdtempSync;
  const removeTemporary = dependencies.rm ?? rmSync;
  const temporary = makeTemporary(path.join(tmpdir(), "oliphaunt-release-upload-"));
  try {
    const staged = path.join(temporary, asset.name);
    copyFileSync(asset.file, staged, constants.COPYFILE_EXCL);
    const stat = lstatSync(staged);
    const digest = sha256FileSync(staged);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== asset.size || digest !== asset.sha256) {
      throw error(`${asset.name} staged bytes do not match the frozen publication lock`);
    }
    return operation(staged);
  } finally {
    removeTemporary(temporary, { force: true, recursive: true });
  }
}

function exactReleaseState(release, plan, releaseId) {
  if (release === null) {
    return { detail: `${plan.tag} GitHub release is missing`, kind: "conflict" };
  }
  try {
    assertResumableReleaseMetadata(release, plan.metadata);
  } catch (cause) {
    return { detail: cause.message, kind: "conflict" };
  }
  if (release.id !== releaseId) {
    return {
      detail: `${plan.tag} release id changed from ${releaseId} to ${release.id}`,
      kind: "conflict",
    };
  }
  return null;
}

function permanentError(message, options = {}) {
  const cause = error(message, options);
  cause.retryable = false;
  return cause;
}

function pendingError(message, options = {}) {
  return new RetryableReadError(`upload_github_release_assets.mjs: ${message}`, options);
}

function singleSnapshotReadOptions(budget, dependencies) {
  return remainingGitHubReadOptions(budget, {
    ...dependencies.singleReadOptions,
    maxAttempts: 1,
  });
}

function assertRemoteAssetInventory(value, plan) {
  if (!(value instanceof Map)) {
    throw permanentError(`${plan.product} GitHub release ${plan.tag} returned a non-canonical asset inventory`);
  }
  const ids = new Set();
  for (const [name, asset] of value) {
    if (
      typeof name !== "string"
      || asset === null
      || Array.isArray(asset)
      || typeof asset !== "object"
      || asset.name !== name
      || !Number.isSafeInteger(asset.id)
      || asset.id <= 0
      || !Number.isSafeInteger(asset.size)
      || asset.size < 0
      || !GITHUB_ASSET_STATES.has(asset.state)
      || (
        asset.digest !== null
        && asset.digest !== undefined
        && asset.digest !== ""
        && !/^sha256:[0-9a-f]{64}$/u.test(asset.digest)
      )
      || ids.has(asset.id)
    ) {
      throw permanentError(`${plan.product} GitHub release ${plan.tag} returned malformed asset metadata`);
    }
    ids.add(asset.id);
  }
  return value;
}

export function readExactReleaseAssetSnapshotSync(
  { budget, expectedReleaseId, phase, plan },
  dependencies = {},
) {
  const context = { expectedReleaseId, phase, plan };
  const readOptions = () => singleSnapshotReadOptions(budget, dependencies);
  const readRelease = dependencies.readRelease ?? (() =>
    readReleaseByTagSync(plan.repo, plan.tag, readOptions()));
  const readAssets = dependencies.readAssets ?? ((releaseId) =>
    readReleaseAssetsSync(plan.repo, releaseId, readOptions()));

  const release = readRelease(context);
  if (release === null) {
    throw permanentError(
      `${plan.product} GitHub release ${plan.tag} does not exist. `
        + "The protected workflow must stage the exact-SHA draft before asset publication.",
    );
  }
  const releaseId = expectedReleaseId ?? release.id;
  const releaseConflict = exactReleaseState(release, plan, releaseId);
  if (releaseConflict !== null) throw permanentError(releaseConflict.detail);
  const assets = assertRemoteAssetInventory(readAssets(releaseId, context), plan);
  return { assets, release, releaseId };
}

function inspectFrozenReleaseAssetSnapshot(
  { allowMissing, knownAssetIds, plan, requiredNames, snapshot },
) {
  const expected = new Map(plan.assets.map((asset) => [asset.name, asset]));
  if (expected.size !== plan.assets.length) {
    throw permanentError(`${plan.product} frozen GitHub release assets contain duplicate names`);
  }
  for (const name of requiredNames) {
    if (!expected.has(name)) {
      throw permanentError(`${plan.product} snapshot required unknown frozen asset ${name}`);
    }
  }
  const extras = [...snapshot.assets.keys()].filter((name) => !expected.has(name)).sort();
  if (extras.length > 0) {
    throw permanentError(
      `${plan.product} frozen GitHub release asset set excludes unexpected remote assets: ${extras.join(", ")}`,
    );
  }

  const pendingMetadata = [];
  for (const [name, remote] of snapshot.assets) {
    const asset = expected.get(name);
    const knownId = knownAssetIds.get(name);
    if (knownId !== undefined && knownId !== remote.id) {
      throw permanentError(`${name} remote asset id changed from ${knownId} to ${remote.id}`);
    }
    knownAssetIds.set(name, remote.id);
    if (remote.state !== "uploaded") {
      pendingMetadata.push(`${name} (state=${remote.state})`);
      continue;
    }
    if (remote.size !== asset.size) {
      throw permanentError(`${name} remote size ${remote.size} conflicts with frozen size ${asset.size}`);
    }
    if (remote.digest === null || remote.digest === undefined || remote.digest === "") {
      pendingMetadata.push(`${name} (SHA-256 digest)`);
    } else if (remote.digest !== `sha256:${asset.sha256}`) {
      throw permanentError(`${name} remote digest conflicts with frozen bytes`);
    }
  }

  const missing = plan.assets.filter((asset) => !snapshot.assets.has(asset.name));
  if (!snapshot.release.draft && missing.length > 0) {
    throw permanentError(
      `${plan.tag} is already public but is missing frozen assets: ${missing.map(({ name }) => name).join(", ")}`,
    );
  }
  const requiredMissing = missing.filter(({ name }) => requiredNames.has(name));
  if (pendingMetadata.length > 0 || requiredMissing.length > 0 || (!allowMissing && missing.length > 0)) {
    const details = [];
    if (pendingMetadata.length > 0) details.push(`pending asset metadata: ${pendingMetadata.sort().join(", ")}`);
    if (requiredMissing.length > 0) details.push(`required asset absent: ${requiredMissing.map(({ name }) => name).join(", ")}`);
    if (!allowMissing && missing.length > 0) details.push(`frozen asset absent: ${missing.map(({ name }) => name).join(", ")}`);
    throw pendingError(`${plan.tag} exact asset snapshot is not ready (${details.join("; ")})`);
  }
  return { ...snapshot, missing };
}

export function requireExactReleaseAssetSnapshotSync(
  {
    allowMissing,
    budget,
    expectedReleaseId,
    knownAssetIds,
    phase,
    plan,
    requiredNames = new Set(),
  },
  dependencies = {},
) {
  const options = remainingGitHubReadOptions(budget, dependencies.snapshotReadOptions);
  return retryReadOperationSync(
    `${plan.product} ${phase} exact GitHub release asset snapshot`,
    () => inspectFrozenReleaseAssetSnapshot({
      allowMissing,
      knownAssetIds,
      plan,
      requiredNames,
      snapshot: readExactReleaseAssetSnapshotSync(
        { budget, expectedReleaseId, phase, plan },
        dependencies,
      ),
    }),
    options,
  );
}

export function exactReleaseAssetUploadArgs({ assetName, file, releaseId, repo }) {
  assertSafeAssetName(assetName);
  if (!Number.isSafeInteger(releaseId) || releaseId <= 0) {
    throw error("release asset upload requires a positive release id");
  }
  if (!/^[^/\s]+\/[^/\s]+$/u.test(repo)) {
    throw error("release asset upload repository must be OWNER/NAME");
  }
  if (typeof file !== "string" || file.length === 0 || path.basename(file) !== assetName) {
    throw error("release asset upload file must retain its frozen asset name");
  }
  return [
    "api",
    `https://uploads.github.com/repos/${repo}/releases/${releaseId}/assets?name=${encodeURIComponent(assetName)}`,
    "-X",
    "POST",
    "-H",
    "Accept: application/vnd.github+json",
    "-H",
    "Content-Type: application/octet-stream",
    "-H",
    "X-GitHub-Api-Version: 2022-11-28",
    "--input",
    file,
  ];
}

export function uploadFrozenReleaseAssetsSync(plan, dependencies = {}) {
  const environment = dependencies.environment ?? process.env;
  const uploadTimeoutMs = dependencies.uploadTimeoutMs
    ?? DEFAULT_GITHUB_RELEASE_ASSET_UPLOAD_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(uploadTimeoutMs)
    || uploadTimeoutMs <= 0
    || uploadTimeoutMs > 120_000
  ) {
    throw error("GitHub release asset upload timeout must be between 1 and 120000 milliseconds");
  }
  let budget = dependencies.budget;
  if (budget === undefined) {
    const requiredWindowMs = githubReleaseAssetUploadWindowMs(plan.assets.length, { uploadTimeoutMs });
    budget = createGitHubOperationBudget({
      defaultWindowMs: requiredWindowMs,
      environment,
      now: dependencies.now ?? Date.now,
    });
    const availableMs = budget.deadlineMs - budget.startedAtMs;
    const requiredMs = (plan.assets.length * (GITHUB_CONTENT_WRITE_INTERVAL_MS + uploadTimeoutMs))
      + GITHUB_RELEASE_ASSET_UPLOAD_SNAPSHOT_RESERVE_MS;
    if (availableMs < requiredMs) {
      throw error(
        `${plan.product} exact ${plan.assets.length}-asset upload requires at least ${requiredMs}ms before mutation, `
          + `but the configured/hard GitHub deadline permits ${Math.max(0, availableMs)}ms`,
      );
    }
  }
  const knownAssetIds = new Map();
  const initial = requireExactReleaseAssetSnapshotSync({
    allowMissing: true,
    budget,
    expectedReleaseId: undefined,
    knownAssetIds,
    phase: "pre-upload",
    plan,
  }, dependencies);
  const releaseId = initial.releaseId;
  if (initial.missing.length === 0) {
    console.log(
      `${plan.product} GitHub release ${plan.tag} already has its exact ${plan.assets.length}-asset frozen set `
        + `(publication lock ${plan.lockDigest}).`,
    );
    return { recoveredUploads: 0, uploadedAssets: 0 };
  }
  const stage = dependencies.withStagedAsset ?? withStagedFrozenAssetSync;
  let recoveredUploads = 0;
  let uploadedAssets = 0;
  const completedMutationNames = new Set();
  const reconcileCompletedMutationsBeforeAbort = () => {
    if (completedMutationNames.size === 0) return;
    requireExactReleaseAssetSnapshotSync({
      allowMissing: true,
      budget,
      expectedReleaseId: releaseId,
      knownAssetIds,
      phase: "peer-abort-reconciliation",
      plan,
      requiredNames: completedMutationNames,
    }, dependencies);
  };
  for (const asset of initial.missing) {
    try {
      assertSharedUploadMutationAllowed(environment);
    } catch (cause) {
      if (cause?.code === SHARED_UPLOAD_ABORT_CODE) {
        reconcileCompletedMutationsBeforeAbort();
      }
      throw cause;
    }
    let mutationFailure;
    stage(asset, (stagedFile) => {
      const remainingMs = budget.deadlineMs - budget.now();
      if (remainingMs <= 0) {
        throw error(`${plan.product} GitHub asset upload deadline reached before ${asset.name}`);
      }
      if (remainingMs < uploadTimeoutMs) {
        throw error(
          `${plan.product} GitHub asset upload requires its complete ${uploadTimeoutMs}ms timeout before `
            + `${asset.name}; ${Math.max(0, remainingMs)}ms remains`,
        );
      }
      const timeoutMs = uploadTimeoutMs;
      try {
        if (dependencies.uploadAsset === undefined) {
          runGitHubMutationSync(
            exactReleaseAssetUploadArgs({
              assetName: asset.name,
              file: stagedFile,
              releaseId,
              repo: plan.repo,
            }),
            {
              assertMutationAllowed: () => assertSharedUploadMutationAllowed(environment),
              deadlineMs: budget.deadlineMs,
              environment,
              now: budget.now,
              timeoutMs,
            },
          );
        } else {
          dependencies.uploadAsset({
            asset,
            assertMutationAllowed: () => assertSharedUploadMutationAllowed(environment),
            deadlineMs: budget.deadlineMs,
            now: budget.now,
            plan,
            releaseId,
            stagedFile,
            timeoutMs,
          });
        }
      } catch (cause) {
        mutationFailure = cause;
      }
    });
    uploadedAssets += 1;
    if (mutationFailure === undefined) {
      completedMutationNames.add(asset.name);
      continue;
    }
    if (mutationFailure?.code === SHARED_UPLOAD_ABORT_CODE) {
      reconcileCompletedMutationsBeforeAbort();
      throw mutationFailure;
    }

    try {
      requireExactReleaseAssetSnapshotSync({
        allowMissing: true,
        budget,
        expectedReleaseId: releaseId,
        knownAssetIds,
        phase: `ambiguous-${asset.name}`,
        plan,
        requiredNames: new Set([asset.name]),
      }, dependencies);
    } catch (reconciliationFailure) {
      const mutationDetail = mutationFailure instanceof Error ? mutationFailure.message : String(mutationFailure);
      const reconciliationDetail = reconciliationFailure instanceof Error
        ? reconciliationFailure.message
        : String(reconciliationFailure);
      throw error(
        `${asset.name} upload failed (${mutationDetail}) and exact immutable state did not reconcile: `
          + reconciliationDetail,
        { cause: mutationFailure },
      );
    }
    recoveredUploads += 1;
    completedMutationNames.add(asset.name);
    console.log(`${asset.name} became exact after an ambiguous upload response; the mutation was not replayed.`);
  }

  requireExactReleaseAssetSnapshotSync({
    allowMissing: false,
    budget,
    expectedReleaseId: releaseId,
    knownAssetIds,
    phase: "post-upload",
    plan,
  }, dependencies);
  console.log(
    `${plan.product} GitHub release ${plan.tag} has all ${plan.assets.length} frozen assets `
      + `(publication lock ${plan.lockDigest}).`,
  );
  return { recoveredUploads, uploadedAssets };
}

export function main(argv, { environment = process.env } = {}) {
  const args = parseArgs([...argv], environment);
  const plan = frozenUploadPlan(args);
  uploadFrozenReleaseAssetsSync(plan, { environment });
}

if (import.meta.main) {
  try {
    main(Bun.argv.slice(2));
  } catch (cause) {
    console.error(redactGitHubReadDetail(cause instanceof Error ? cause.message : String(cause)));
    process.exit(1);
  }
}
