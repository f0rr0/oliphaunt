#!/usr/bin/env node

import { appendFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  GITHUB_CONTENT_WRITE_COLD_START_MS,
  GITHUB_CONTENT_WRITE_INTERVAL_MS,
  GITHUB_CONTENT_WRITES_PER_ROLLING_HOUR,
  GITHUB_CONTENT_WRITES_PER_ROLLING_MINUTE,
} from "./github-content-write-pacer.mjs";
import {
  concurrentGithubReleaseAssetUploadPlan,
  GITHUB_RELEASE_ATTESTATION_EVIDENCE_STEP_TIMEOUT_MS,
  GITHUB_RELEASE_ATTESTATION_STEP_TIMEOUT_MS,
  GITHUB_RELEASE_DRAFT_STAGE_STEP_TIMEOUT_MS,
  GITHUB_RELEASE_STAGING_VERIFY_STEP_TIMEOUT_MS,
  GITHUB_RELEASE_SWIFTPM_STEP_TIMEOUT_MS,
  GITHUB_RELEASE_TAG_VERIFY_STEP_TIMEOUT_MS,
} from "./github-release-asset-upload-plan.mjs";
import {
  GITHUB_CORE_REQUEST_RETRY_RESERVE,
  GITHUB_CORE_REQUEST_ROLLING_CEILING,
  readGitHubCoreRequestJournal,
} from "./github-core-request-journal.mjs";
import { isExtensionProduct, loadGraph } from "./release-graph.mjs";
import { readReleaseMapSync } from "./github-release-mutations.mjs";
import {
  loadPublicationLock,
  lockedProductArtifactPaths,
} from "./publication-lock.mjs";
import {
  RELEASE_CURRENT_MAIN_REVALIDATION_TIMEOUT_SECONDS,
  RELEASE_FINALIZATION_CLEANUP_MARGIN_SECONDS,
  RELEASE_FINALIZATION_STEP_TIMEOUT_SECONDS,
  RELEASE_MINIMUM_FINALIZATION_SECONDS,
} from "./release-finalization-budget.mjs";
import {
  NORMAL_PUBLICATION_RECOVERY_GITHUB_CORE_REQUEST_MAX,
  NORMAL_PUBLICATION_RECOVERY_STEP_TIMEOUT_MS,
} from "./normal-publication-recovery-contract.mjs";

const FULL_SHA = /^[0-9a-f]{40}$/u;
const GITHUB_ASSET_ROLES = new Set(["github-release-asset", "github-release-metadata"]);
const ATTESTED_BINARY_PRODUCTS = new Set([
  "liboliphaunt-native",
  "liboliphaunt-wasix",
  "oliphaunt-broker",
  "oliphaunt-node-direct",
]);

// Current exact first-release workflow transfer model after immutable run
// snapshots and exact-ID artifact downloads. These are core REST requests,
// not content writes. Each value is independently exercised by the artifact
// downloader/gate tests; this aggregate protects the 1,000/hour envelope.
export const FIRST_RELEASE_TRANSFER_REQUESTS = Object.freeze({
  artifactDownloads: 26,
  // One workflow-identity inventory plus one exact-workflow/exact-SHA
  // paginated run inventory for normal-publish bootstrap-ledger recovery.
  artifactRunSearches: 2,
  artifactRunSnapshots: 12,
  normalPublicationRecovery: NORMAL_PUBLICATION_RECOVERY_GITHUB_CORE_REQUEST_MAX,
  qualificationGates: 9,
  wasixRuntimeDownloadsAndGate: 11,
});
export const FIRST_RELEASE_TRANSFER_REQUEST_TOTAL = Object.values(
  FIRST_RELEASE_TRANSFER_REQUESTS,
).reduce((total, count) => total + count, 0);
export const FIRST_RELEASE_RELEASE_API_REQUESTS = 299;
export const FIRST_RELEASE_ATTESTATION_API_REQUESTS = 6;
export const FIRST_RELEASE_NOMINAL_CORE_REQUESTS =
  FIRST_RELEASE_TRANSFER_REQUEST_TOTAL
  + FIRST_RELEASE_RELEASE_API_REQUESTS
  + FIRST_RELEASE_ATTESTATION_API_REQUESTS;

export function pagesForRows(count) {
  if (!Number.isSafeInteger(count) || count < 0) fail("page row count must be a non-negative safe integer");
  return Math.max(1, Math.ceil(count / 100));
}

export function releasePageUpperBound(currentReleaseCount, productCount) {
  for (const [label, value] of Object.entries({ currentReleaseCount, productCount })) {
    if (!Number.isSafeInteger(value) || value < 0) fail(`${label} must be a non-negative safe integer`);
  }
  if (productCount < 1) fail("productCount must be positive");
  return pagesForRows(currentReleaseCount + productCount);
}

export function conservativeCoreRequestCount({
  assetCount,
  assetCounts,
  attestationWrites,
  productCount,
  releasePageCount = 1,
}) {
  for (const [label, value] of Object.entries({ assetCount, attestationWrites, productCount, releasePageCount })) {
    if (!Number.isSafeInteger(value) || value < 0) fail(`${label} must be a non-negative safe integer`);
  }
  if (productCount < 1) fail("productCount must be positive");
  if (!(assetCounts instanceof Map) || assetCounts.size !== productCount) {
    fail("assetCounts must contain one exact entry per selected product");
  }
  const countedAssets = [...assetCounts.values()].reduce((total, count) => {
    if (!Number.isSafeInteger(count) || count < 0) fail("product asset count must be a non-negative safe integer");
    return total + count;
  }, 0);
  if (countedAssets !== assetCount) fail("assetCount disagrees with per-product assetCounts");
  // Preflight, stage (before/after), verify, and promotion (before/after) each
  // read the complete release list. Tag/release/promotion mutations are one
  // content request per product.
  const draftManagementRequests = (3 * productCount) + (6 * releasePageCount);
  // Exact release-asset inventory never trusts an embedded release row. A
  // first publication snapshots nonempty products before and after upload;
  // an empty product needs one proof. Charge every selected product even if a
  // current publisher happens not to call the empty proof path.
  const releaseAssetRequests = assetCount + [...assetCounts.values()].reduce(
    (total, count) => total + ((count > 0 ? 2 : 1) * (1 + pagesForRows(count))),
    0,
  );
  // Both pre-mutation and final receipts read all release pages and one exact
  // paginated asset inventory per selected product.
  const assetInventoryPages = [...assetCounts.values()].reduce(
    (total, count) => total + pagesForRows(count),
    0,
  );
  const receiptRequests = 2 * (releasePageCount + assetInventoryPages);
  return FIRST_RELEASE_TRANSFER_REQUEST_TOTAL
    + draftManagementRequests
    + releaseAssetRequests
    + receiptRequests
    + attestationWrites;
}

function fail(message) {
  throw new Error(`github-release-request-budget: ${message}`);
}

function positiveInteger(value, label) {
  if (!/^[1-9][0-9]*$/u.test(String(value ?? ""))) fail(`${label} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) fail(`${label} is outside the safe integer range`);
  return parsed;
}

function parseProducts(value) {
  let products;
  try {
    products = JSON.parse(value);
  } catch (cause) {
    fail(`--products-json must be valid JSON: ${cause.message}`);
  }
  if (
    !Array.isArray(products)
    || products.length === 0
    || products.some((product) => typeof product !== "string" || product.length === 0)
    || new Set(products).size !== products.length
  ) {
    fail("--products-json must be a non-empty unique product string list");
  }
  return [...products].sort();
}

function attestationWriteCount(assetCounts) {
  const extensionAssets = [...assetCounts]
    .filter(([product]) => isExtensionProduct(product))
    .reduce((total, [, count]) => total + count, 0);
  // locked-attestation-subjects shards the complete extension subject set in
  // two; a one-subject partial selection has only one nonempty shard.
  const extensionBundles = extensionAssets === 0 ? 0 : extensionAssets === 1 ? 1 : 2;
  const binaryBundles = [...ATTESTED_BINARY_PRODUCTS]
    .filter((product) => (assetCounts.get(product) ?? 0) > 0)
    .length;
  return extensionBundles + binaryBundles;
}

export function sourceTagWriteCount(graph, products) {
  if (
    graph === null
    || Array.isArray(graph)
    || typeof graph !== "object"
    || graph.products === null
    || Array.isArray(graph.products)
    || typeof graph.products !== "object"
    || !Array.isArray(products)
  ) {
    fail("source-tag write derivation requires a release graph and selected products");
  }
  let writes = 0;
  for (const product of products) {
    const row = graph.products[product];
    if (row === undefined || !Array.isArray(row.publish_targets)) {
      fail(`cannot derive source-tag writes for unknown product ${product}`);
    }
    writes += row.publish_targets.filter((target) => target === "swift-package-source-tag").length;
  }
  return writes;
}

export function contentWriteBudgetFromCounts({
  assetCount,
  assetCounts,
  attestationWrites,
  coldStartRemainingMs = GITHUB_CONTENT_WRITE_COLD_START_MS,
  productCount,
  releasePageCount = 1,
  rollingCoreRequestCount = 0,
  sourceTagWrites = 0,
}) {
  for (const [label, value] of Object.entries({
    assetCount,
    attestationWrites,
    productCount,
    releasePageCount,
    rollingCoreRequestCount,
    sourceTagWrites,
  })) {
    if (!Number.isSafeInteger(value) || value < 0) fail(`${label} must be a non-negative safe integer`);
  }
  if (productCount < 1) fail("productCount must be positive");
  if (!Number.isSafeInteger(coldStartRemainingMs) || coldStartRemainingMs < 0 || coldStartRemainingMs > GITHUB_CONTENT_WRITE_COLD_START_MS) {
    fail("cold-start remaining time must be between zero and one hour");
  }
  const preRegistryContentWrites =
    (2 * productCount)
    + assetCount
    + attestationWrites
    + sourceTagWrites;
  const totalContentWrites = preRegistryContentWrites + productCount;
  const effectiveAssetCounts = assetCounts ?? new Map(Array.from(
    { length: productCount },
    (_, index) => [
      `product-${index}`,
      Math.floor(assetCount / productCount) + (index < (assetCount % productCount) ? 1 : 0),
    ],
  ));
  const assetUploadPlan = concurrentGithubReleaseAssetUploadPlan(effectiveAssetCounts);
  const conservativeCoreRequests = conservativeCoreRequestCount({
    assetCount,
    assetCounts: effectiveAssetCounts,
    attestationWrites,
    productCount,
    releasePageCount,
  });
  const restContentWrites = totalContentWrites - sourceTagWrites;
  const futureNonContentRequests = conservativeCoreRequests
    - FIRST_RELEASE_TRANSFER_REQUEST_TOTAL
    - restContentWrites
    // The first admission precedes optional bootstrap-ledger recovery. Charge
    // its exact workflow/run inventories at both admissions; the second pass
    // is deliberately conservative after those reads have completed.
    + FIRST_RELEASE_TRANSFER_REQUESTS.artifactRunSearches
    + NORMAL_PUBLICATION_RECOVERY_GITHUB_CORE_REQUEST_MAX;
  const projectedRollingCoreRequests = rollingCoreRequestCount
    + futureNonContentRequests
    + GITHUB_CONTENT_WRITES_PER_ROLLING_HOUR
    + GITHUB_CORE_REQUEST_RETRY_RESERVE;
  return {
    assetCount,
    attestationWrites,
    coldStartMs: coldStartRemainingMs,
    conservativeCoreRequests,
    futureNonContentRequests,
    contentWriteIntervalMs: GITHUB_CONTENT_WRITE_INTERVAL_MS,
    nominalCoreRequests: FIRST_RELEASE_NOMINAL_CORE_REQUESTS,
    preRegistryContentWrites,
    preRegistryPacingMs:
      coldStartRemainingMs
      + (preRegistryContentWrites * GITHUB_CONTENT_WRITE_INTERVAL_MS),
    preRegistryOperationMs:
      coldStartRemainingMs
      + GITHUB_RELEASE_DRAFT_STAGE_STEP_TIMEOUT_MS
      + GITHUB_RELEASE_TAG_VERIFY_STEP_TIMEOUT_MS
      + GITHUB_RELEASE_STAGING_VERIFY_STEP_TIMEOUT_MS
      + assetUploadPlan.totalWindowMs
      + (attestationWrites * (
        GITHUB_CONTENT_WRITE_INTERVAL_MS + GITHUB_RELEASE_ATTESTATION_STEP_TIMEOUT_MS
      ))
      + (sourceTagWrites * GITHUB_RELEASE_SWIFTPM_STEP_TIMEOUT_MS)
      + GITHUB_RELEASE_ATTESTATION_EVIDENCE_STEP_TIMEOUT_MS
      + NORMAL_PUBLICATION_RECOVERY_STEP_TIMEOUT_MS
      + (RELEASE_CURRENT_MAIN_REVALIDATION_TIMEOUT_SECONDS * 1_000),
    productCount,
    projectedRollingCoreRequests,
    releasePageCount,
    rollingCoreRequestCount,
    sourceTagWrites,
    totalContentWrites,
    totalPacingMs:
      coldStartRemainingMs
      + (totalContentWrites * GITHUB_CONTENT_WRITE_INTERVAL_MS),
    assetUploadPlan,
  };
}

export function releaseRequestBudget(lock, products, {
  coldStartRemainingMs = GITHUB_CONTENT_WRITE_COLD_START_MS,
  currentReleaseCount = 0,
  rollingCoreRequestCount = 0,
} = {}) {
  const selected = parseProducts(JSON.stringify(products));
  const locked = lock.products.map(({ id }) => id).sort();
  if (JSON.stringify(selected) !== JSON.stringify(locked)) {
    fail("requested products do not exactly match the frozen publication lock");
  }
  if (!FULL_SHA.test(lock.source.commit)) fail("publication lock source commit is malformed");
  const graph = loadGraph("github-release-request-budget");
  const assetCounts = new Map();
  for (const product of selected) {
    if (graph.products[product] === undefined) fail(`unknown release product ${product}`);
    const frozen = lockedProductArtifactPaths(lock, product)
      .filter(({ artifact }) => GITHUB_ASSET_ROLES.has(artifact.role));
    assetCounts.set(product, frozen.length);
  }
  const productCount = selected.length;
  const assetCount = [...assetCounts.values()].reduce((total, count) => total + count, 0);
  const attestationWrites = attestationWriteCount(assetCounts);
  const releasePageCount = releasePageUpperBound(currentReleaseCount, productCount);
  // The publish graph declares the plain semantic-version SwiftPM source tag
  // separately from product tags. Its git push is paced by the same durable
  // journal even though it is not a core REST request.
  const sourceTagWrites = sourceTagWriteCount(graph, selected);
  return {
    ...contentWriteBudgetFromCounts({
      assetCount,
      assetCounts,
      attestationWrites,
      coldStartRemainingMs,
      productCount,
      releasePageCount,
      rollingCoreRequestCount,
      sourceTagWrites,
    }),
    assetCounts,
  };
}

export function assertReleaseRequestWindow(budget, {
  cleanupMarginSeconds = RELEASE_FINALIZATION_CLEANUP_MARGIN_SECONDS,
  finalizationReserveSeconds,
  hardDeadlineEpochSeconds,
  minimumFinalizationSeconds = RELEASE_MINIMUM_FINALIZATION_SECONDS,
  nowMs = Date.now(),
} = {}) {
  const hardDeadlineMs = positiveInteger(hardDeadlineEpochSeconds, "hard deadline") * 1_000;
  const finalizationReserveMs = positiveInteger(finalizationReserveSeconds, "finalization reserve") * 1_000;
  const minimumFinalizationMs = positiveInteger(minimumFinalizationSeconds, "minimum finalization") * 1_000;
  const cleanupMarginMs = positiveInteger(cleanupMarginSeconds, "finalization cleanup margin") * 1_000;
  if (minimumFinalizationMs < (RELEASE_FINALIZATION_STEP_TIMEOUT_SECONDS * 1_000) + cleanupMarginMs) {
    fail(
      `minimum finalization must cover all ${RELEASE_FINALIZATION_STEP_TIMEOUT_SECONDS}s of bounded finalization steps `
      + `plus the ${cleanupMarginSeconds}s cleanup margin`,
    );
  }
  if (finalizationReserveMs < minimumFinalizationMs) {
    fail("finalization reserve must be at least the protected minimum finalization window");
  }
  if (!Number.isSafeInteger(budget.preRegistryOperationMs) || budget.preRegistryOperationMs < 1) {
    fail("pre-registry operation window must be a positive safe integer");
  }
  const requiredBeforeFinalizationMs = budget.preRegistryOperationMs + finalizationReserveMs;
  if (nowMs + requiredBeforeFinalizationMs >= hardDeadlineMs) {
    fail(
      `remaining job window cannot fit the ${Math.ceil(budget.preRegistryOperationMs / 1000)}s `
      + `bounded pre-registry GitHub stage/upload/attestation plan plus ${finalizationReserveSeconds}s finalization reserve`,
    );
  }
  if (GITHUB_CONTENT_WRITES_PER_ROLLING_HOUR > 361 || GITHUB_CONTENT_WRITES_PER_ROLLING_MINUTE > 7) {
    fail("content-write pacing constants no longer preserve the secondary-rate-limit margin");
  }
  if (budget.projectedRollingCoreRequests >= GITHUB_CORE_REQUEST_ROLLING_CEILING) {
    fail(
      `projected rolling core request envelope is ${budget.projectedRollingCoreRequests}, not below the `
      + `${GITHUB_CORE_REQUEST_ROLLING_CEILING}-request operational ceiling`,
    );
  }
  return {
    cleanupMarginSeconds,
    finalizationStepTimeoutSeconds: RELEASE_FINALIZATION_STEP_TIMEOUT_SECONDS,
    minimumFinalizationSeconds,
    preRegistryPacingSeconds: Math.ceil(budget.preRegistryPacingMs / 1_000),
    preRegistryOperationSeconds: Math.ceil(budget.preRegistryOperationMs / 1_000),
    simulatedRegistryDeadlineEpochSeconds:
      Math.floor((hardDeadlineMs - budget.preRegistryOperationMs - finalizationReserveMs) / 1_000),
  };
}

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!new Set(["--publication-lock", "--products-json", "--github-output"]).has(flag) || value === undefined) {
      fail("usage: github-release-request-budget.mjs --publication-lock FILE --products-json JSON --github-output FILE");
    }
    if (values.has(flag)) fail(`${flag} may be supplied only once`);
    values.set(flag, value);
  }
  for (const required of ["--publication-lock", "--products-json", "--github-output"]) {
    if (!values.has(required)) fail(`${required} is required`);
  }
  return values;
}

function main(argv) {
  const values = parseArgs(argv);
  const lock = loadPublicationLock(path.resolve(values.get("--publication-lock")));
  const products = parseProducts(values.get("--products-json"));
  const currentReleaseCount = readReleaseMapSync(process.env.GITHUB_REPOSITORY).size;
  // Take the durable count after the inventory read so this admission includes
  // the request attempt used to establish the live release-page bound.
  const coreJournal = readGitHubCoreRequestJournal();
  if (!coreJournal.enabled) fail("the GitHub core-request journal is not enabled");
  const nowMs = Date.now();
  const coldStartEpoch = positiveInteger(
    process.env.OLIPHAUNT_GITHUB_CONTENT_WRITE_COLD_START_EPOCH,
    "content-write cold-start epoch",
  );
  const coldStartedAtMs = coldStartEpoch * 1_000;
  if (coldStartedAtMs > nowMs) fail("content-write cold-start epoch is in the future");
  const budget = releaseRequestBudget(lock, products, {
    coldStartRemainingMs: Math.max(
      0,
      GITHUB_CONTENT_WRITE_COLD_START_MS - (nowMs - coldStartedAtMs),
    ),
    currentReleaseCount,
    rollingCoreRequestCount: coreJournal.rollingCount,
  });
  const window = assertReleaseRequestWindow(budget, {
    cleanupMarginSeconds: process.env.RELEASE_FINALIZATION_CLEANUP_MARGIN_SECONDS,
    finalizationReserveSeconds: process.env.RELEASE_FINALIZATION_RESERVE_SECONDS,
    hardDeadlineEpochSeconds:
      process.env.GITHUB_STAGE_JOB_HARD_DEADLINE_EPOCH
      ?? process.env.REGISTRY_JOB_HARD_DEADLINE_EPOCH,
    minimumFinalizationSeconds: process.env.RELEASE_MINIMUM_FINALIZATION_SECONDS,
    nowMs,
  });
  appendFileSync(
    values.get("--github-output"),
    [
      `pre_registry_pacing_seconds=${window.preRegistryPacingSeconds}`,
      `pre_registry_operation_seconds=${window.preRegistryOperationSeconds}`,
      `asset_upload_window_seconds=${Math.ceil(budget.assetUploadPlan.totalWindowMs / 1_000)}`,
      `asset_upload_wave_count=${budget.assetUploadPlan.waves.length}`,
      `finalization_step_timeout_seconds=${window.finalizationStepTimeoutSeconds}`,
      `finalization_cleanup_margin_seconds=${window.cleanupMarginSeconds}`,
      `minimum_finalization_seconds=${window.minimumFinalizationSeconds}`,
      `simulated_registry_deadline_epoch=${window.simulatedRegistryDeadlineEpochSeconds}`,
      `content_write_count=${budget.totalContentWrites}`,
      `conservative_core_requests=${budget.conservativeCoreRequests}`,
      `projected_rolling_core_requests=${budget.projectedRollingCoreRequests}`,
      `rolling_core_request_count=${budget.rollingCoreRequestCount}`,
      `release_page_count=${budget.releasePageCount}`,
      `nominal_core_requests=${budget.nominalCoreRequests}`,
      "",
    ].join("\n"),
  );
  console.log(
    `GitHub first-release budget admitted: ${budget.productCount} products, ${budget.assetCount} assets, `
    + `${budget.totalContentWrites} paced content writes, ${budget.nominalCoreRequests} nominal / `
    + `${budget.conservativeCoreRequests} conservative whole-job core requests, `
    + `${budget.projectedRollingCoreRequests}/${GITHUB_CORE_REQUEST_ROLLING_CEILING} projected rolling requests, `
    + `${window.preRegistryPacingSeconds}s cold-start/pre-registry pacing.`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (cause) {
    console.error(cause instanceof Error ? cause.message : String(cause));
    process.exit(1);
  }
}
