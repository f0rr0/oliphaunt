import { describe, expect, test } from "bun:test";

import {
  concurrentGithubReleaseAssetUploadPlan,
  GITHUB_RELEASE_ASSET_SELECTION_VERIFY_MS,
  GITHUB_RELEASE_ASSET_WAVE_OVERHEAD_MS,
  githubReleaseAssetUploadWaveWindowMs,
  MAX_GITHUB_RELEASE_ASSET_HANDOFF_WINDOW_MS,
} from "./github-release-asset-upload-plan.mjs";
import { GITHUB_CONTENT_WRITE_INTERVAL_MS } from "./github-content-write-pacer.mjs";
import {
  expectedExtensionGithubReleaseAssetCount,
} from "./publication-lock.mjs";
import {
  allArtifactTargets,
  exactExtensionProducts,
} from "./release-artifact-targets.mjs";
import { loadGraph } from "./release-graph.mjs";
import {
  DEFAULT_GITHUB_RELEASE_ASSET_UPLOAD_TIMEOUT_MS,
  GITHUB_RELEASE_ASSET_UPLOAD_SNAPSHOT_RESERVE_MS,
} from "./upload_github_release_assets.mjs";

function liveAssetCounts() {
  const graph = loadGraph("github-release-asset-upload-plan.test");
  const extensions = new Set(exactExtensionProducts("github-release-asset-upload-plan.test"));
  const binaries = new Set([
    "liboliphaunt-native",
    "liboliphaunt-wasix",
    "oliphaunt-broker",
    "oliphaunt-node-direct",
  ]);
  return new Map(Object.keys(graph.products).map((product) => [
    product,
    extensions.has(product)
      ? expectedExtensionGithubReleaseAssetCount(product)
      : binaries.has(product)
        ? allArtifactTargets(
          { product, publishedOnly: true, surface: "github-release" },
          "github-release-asset-upload-plan.test",
        ).length
        : 0,
  ]));
}

describe("bounded concurrent GitHub release asset upload plan", () => {
  test("admits the exact 18-product/141-asset topology as three bounded five-lane waves", () => {
    const counts = liveAssetCounts();
    expect(counts.size).toBe(18);
    expect(counts.has("oliphaunt-extension-postgis")).toBe(true);
    const plan = concurrentGithubReleaseAssetUploadPlan(counts);
    expect(plan.productCount).toBe(12);
    expect(plan.assetCount).toBe(141);
    expect(plan.waves).toHaveLength(3);
    expect(plan.waves.map(({ rows }) => rows.length)).toEqual([5, 5, 2]);
    expect(plan.waves.map(({ assetCount }) => assetCount)).toEqual([74, 57, 10]);
    expect(plan.waves[0].largestProductAssetCount).toBe(19);
    expect(plan.waves.map(({ windowMs }) => windowMs)).toEqual([
      2_300_000,
      1_770_000,
      820_000,
    ]);
    expect(plan.selectionVerificationWindowMs).toBe(GITHUB_RELEASE_ASSET_SELECTION_VERIFY_MS);
    expect(plan.totalWindowMs).toBe(82.5 * 60_000);
    expect(plan.totalWindowMs).toBeLessThan(MAX_GITHUB_RELEASE_ASSET_HANDOFF_WINDOW_MS);
  });

  test("uses global pacing plus the longest sequential transport lane", () => {
    const rows = [
      { product: "large", assetCount: 8 },
      { product: "small-a", assetCount: 3 },
      { product: "small-b", assetCount: 0 },
    ];
    expect(githubReleaseAssetUploadWaveWindowMs(rows)).toBe(
      GITHUB_RELEASE_ASSET_WAVE_OVERHEAD_MS
        + GITHUB_RELEASE_ASSET_UPLOAD_SNAPSHOT_RESERVE_MS
        + (11 * GITHUB_CONTENT_WRITE_INTERVAL_MS)
        + (8 * DEFAULT_GITHUB_RELEASE_ASSET_UPLOAD_TIMEOUT_MS),
    );
  });

  test("splits only at the concurrency/window ceiling and rejects an oversized total handoff", () => {
    const counts = new Map(Array.from({ length: 5 }, (_, index) => [`product-${index}`, 1]));
    const plan = concurrentGithubReleaseAssetUploadPlan(counts, {
      maxConcurrentProducts: 2,
      maxHandoffWindowMs: 60 * 60_000,
    });
    expect(plan.waves.map(({ products }) => products.length)).toEqual([2, 2, 1]);
    expect(concurrentGithubReleaseAssetUploadPlan(
      new Map(Array.from({ length: 10 }, (_, index) => [`empty-${index}`, 0])),
    )).toEqual({
      assetCount: 0,
      productCount: 0,
      selectionVerificationWindowMs: GITHUB_RELEASE_ASSET_SELECTION_VERIFY_MS,
      totalWindowMs: GITHUB_RELEASE_ASSET_SELECTION_VERIFY_MS,
      waves: [],
    });
  });

  test("rejects malformed or individually unbounded products before a wave starts", () => {
    expect(() => concurrentGithubReleaseAssetUploadPlan(new Map())).toThrow(/non-empty product\/count map/u);
    expect(() => concurrentGithubReleaseAssetUploadPlan(new Map([["oversized", 294]]))).toThrow(
      /package the product into fewer aggregate assets/u,
    );
  });
});
