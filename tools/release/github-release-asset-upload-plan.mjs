import {
  DEFAULT_GITHUB_RELEASE_ASSET_UPLOAD_TIMEOUT_MS,
  githubReleaseAssetUploadWindowMs,
  GITHUB_RELEASE_ASSET_UPLOAD_SNAPSHOT_RESERVE_MS,
  MAX_GITHUB_RELEASE_ASSET_UPLOAD_WINDOW_MS,
} from "./upload_github_release_assets.mjs";
import { GITHUB_CONTENT_WRITE_INTERVAL_MS } from "./github-content-write-pacer.mjs";

// The durable content-write pacer holds its filesystem lock while it waits for
// the next 10-second reservation. Keep a complete upload wave below the
// pacer's 60-second production lock-wait ceiling even when every lane reaches
// the pacer at once. A five-lane wave has at most four predecessors (40s).
export const MAX_CONCURRENT_GITHUB_RELEASE_ASSET_PRODUCTS = 5;
export const GITHUB_RELEASE_ASSET_WAVE_OVERHEAD_MS = 60_000;
export const GITHUB_RELEASE_ASSET_SELECTION_VERIFY_MS = 60_000;
export const MAX_GITHUB_RELEASE_ASSET_HANDOFF_WINDOW_MS = 90 * 60_000;
// These are the protected workflow's hard per-step bounds between the final
// read-only admission and the authoritative registry mutation gate. Policy
// checks keep the YAML values equal to these constants.
export const GITHUB_RELEASE_DRAFT_STAGE_STEP_TIMEOUT_MS = 31 * 60_000;
export const GITHUB_RELEASE_TAG_VERIFY_STEP_TIMEOUT_MS = 5 * 60_000;
export const GITHUB_RELEASE_STAGING_VERIFY_STEP_TIMEOUT_MS = 5 * 60_000;
export const GITHUB_RELEASE_ATTESTATION_STEP_TIMEOUT_MS = 5 * 60_000;
export const GITHUB_RELEASE_ATTESTATION_EVIDENCE_STEP_TIMEOUT_MS = 10 * 60_000;
export const GITHUB_RELEASE_SWIFTPM_STEP_TIMEOUT_MS = 6 * 60_000;

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function error(message) {
  return new Error(`github-release-asset-upload-plan: ${message}`);
}

function positiveSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw error(`${label} must be a positive safe integer`);
  }
  return value;
}

function rowsFromAssetCounts(assetCounts) {
  if (!(assetCounts instanceof Map) || assetCounts.size === 0) {
    throw error("assetCounts must be a non-empty product/count map");
  }
  const rows = [];
  for (const [product, assetCount] of assetCounts) {
    if (
      typeof product !== "string"
      || product.length === 0
      || !Number.isSafeInteger(assetCount)
      || assetCount < 0
    ) {
      throw error("assetCounts must contain non-empty product names and non-negative safe integer counts");
    }
    // Keep the per-product uploader ceiling authoritative even though all
    // products in a wave receive the larger shared wave deadline.
    githubReleaseAssetUploadWindowMs(assetCount);
    // Products without GitHub release assets do not need an uploader process.
    // Both pre-mutation and final attestation receipts independently snapshot
    // every selected release and prove those products have an exact empty
    // asset set.
    if (assetCount > 0) rows.push({ assetCount, product });
  }
  return rows.sort((left, right) =>
    right.assetCount - left.assetCount || compareText(left.product, right.product));
}

/**
 * Bound one concurrent upload wave under the real shared content-write pacer.
 *
 * Every product has at most one upload transport in flight. Across a wave, all
 * starts remain serialized by the durable 10-second pacer, while transports
 * overlap. A product can therefore finish no later than the complete wave's
 * pacing budget plus its own sequential transports. The largest product is the
 * longest such lane. Pre/post/ambiguity snapshots use the uploader's shared
 * reserve and run concurrently across product lanes.
 */
export function githubReleaseAssetUploadWaveWindowMs(rows, {
  contentWriteIntervalMs = GITHUB_CONTENT_WRITE_INTERVAL_MS,
  snapshotReserveMs = GITHUB_RELEASE_ASSET_UPLOAD_SNAPSHOT_RESERVE_MS,
  uploadTimeoutMs = DEFAULT_GITHUB_RELEASE_ASSET_UPLOAD_TIMEOUT_MS,
  waveOverheadMs = GITHUB_RELEASE_ASSET_WAVE_OVERHEAD_MS,
} = {}) {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw error("an upload wave must contain at least one product");
  }
  for (const [label, value] of Object.entries({
    contentWriteIntervalMs,
    snapshotReserveMs,
    uploadTimeoutMs,
    waveOverheadMs,
  })) {
    positiveSafeInteger(value, label);
  }
  let assetCount = 0;
  let largestProductAssetCount = 0;
  const products = new Set();
  for (const row of rows) {
    if (
      row === null
      || Array.isArray(row)
      || typeof row !== "object"
      || typeof row.product !== "string"
      || row.product.length === 0
      || !Number.isSafeInteger(row.assetCount)
      || row.assetCount < 0
      || products.has(row.product)
    ) {
      throw error("upload wave rows must contain unique products and non-negative safe integer counts");
    }
    products.add(row.product);
    assetCount += row.assetCount;
    largestProductAssetCount = Math.max(largestProductAssetCount, row.assetCount);
  }
  const windowMs = waveOverheadMs
    + snapshotReserveMs
    + (assetCount * contentWriteIntervalMs)
    + (largestProductAssetCount * uploadTimeoutMs);
  if (!Number.isSafeInteger(windowMs)) {
    throw error("upload wave window exceeds the safe integer range");
  }
  return windowMs;
}

export function concurrentGithubReleaseAssetUploadPlan(assetCounts, {
  maxConcurrentProducts = MAX_CONCURRENT_GITHUB_RELEASE_ASSET_PRODUCTS,
  maxHandoffWindowMs = MAX_GITHUB_RELEASE_ASSET_HANDOFF_WINDOW_MS,
  maxWaveWindowMs = MAX_GITHUB_RELEASE_ASSET_UPLOAD_WINDOW_MS,
} = {}) {
  positiveSafeInteger(maxConcurrentProducts, "maximum concurrent products");
  positiveSafeInteger(maxHandoffWindowMs, "maximum handoff window");
  positiveSafeInteger(maxWaveWindowMs, "maximum wave window");
  const rows = rowsFromAssetCounts(assetCounts);
  if (rows.length === 0) {
    return {
      assetCount: 0,
      productCount: 0,
      selectionVerificationWindowMs: GITHUB_RELEASE_ASSET_SELECTION_VERIFY_MS,
      totalWindowMs: GITHUB_RELEASE_ASSET_SELECTION_VERIFY_MS,
      waves: [],
    };
  }
  const waves = [];
  let pending = [];

  const flush = () => {
    if (pending.length === 0) return;
    const windowMs = githubReleaseAssetUploadWaveWindowMs(pending);
    waves.push({
      assetCount: pending.reduce((total, row) => total + row.assetCount, 0),
      largestProductAssetCount: Math.max(...pending.map(({ assetCount }) => assetCount)),
      products: pending.map(({ product }) => product),
      rows: pending.map((row) => ({ ...row })),
      windowMs,
    });
    pending = [];
  };

  for (const row of rows) {
    const candidate = [...pending, row];
    const candidateWindowMs = githubReleaseAssetUploadWaveWindowMs(candidate);
    if (
      pending.length > 0
      && (candidate.length > maxConcurrentProducts || candidateWindowMs > maxWaveWindowMs)
    ) {
      flush();
    }
    const singleOrNewWave = [...pending, row];
    const newWindowMs = githubReleaseAssetUploadWaveWindowMs(singleOrNewWave);
    if (singleOrNewWave.length > maxConcurrentProducts || newWindowMs > maxWaveWindowMs) {
      throw error(
        `${row.product} cannot fit a bounded concurrent upload wave: ${newWindowMs}ms exceeds `
          + `${maxWaveWindowMs}ms or the ${maxConcurrentProducts}-product concurrency ceiling`,
      );
    }
    pending = singleOrNewWave;
  }
  flush();

  const totalWindowMs = GITHUB_RELEASE_ASSET_SELECTION_VERIFY_MS
    + waves.reduce((total, wave) => total + wave.windowMs, 0);
  if (!Number.isSafeInteger(totalWindowMs) || totalWindowMs > maxHandoffWindowMs) {
    throw error(
      `the complete ${rows.length}-product GitHub release asset handoff requires ${totalWindowMs}ms, `
        + `exceeding the ${maxHandoffWindowMs}ms pre-registry ceiling`,
    );
  }
  return {
    assetCount: rows.reduce((total, row) => total + row.assetCount, 0),
    productCount: rows.length,
    selectionVerificationWindowMs: GITHUB_RELEASE_ASSET_SELECTION_VERIFY_MS,
    totalWindowMs,
    waves,
  };
}
