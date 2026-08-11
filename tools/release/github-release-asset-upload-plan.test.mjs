import { describe, expect, test } from "bun:test";

import {
  concurrentGithubReleaseAssetUploadPlan,
  GITHUB_RELEASE_ASSET_SELECTION_VERIFY_MS,
  GITHUB_RELEASE_ASSET_WAVE_OVERHEAD_MS,
  githubReleaseAssetUploadWaveWindowMs,
} from "./github-release-asset-upload-plan.mjs";
import { GITHUB_CONTENT_WRITE_INTERVAL_MS } from "./github-content-write-pacer.mjs";
import {
  DEFAULT_GITHUB_RELEASE_ASSET_UPLOAD_TIMEOUT_MS,
  GITHUB_RELEASE_ASSET_UPLOAD_SNAPSHOT_RESERVE_MS,
} from "./upload_github_release_assets.mjs";

describe("bounded concurrent GitHub release asset upload plan", () => {
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
