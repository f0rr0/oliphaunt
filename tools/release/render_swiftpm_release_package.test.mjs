import { describe, expect, test } from "bun:test";

import { fetchText, missingRequiredAppleArm64Slices } from "./render_swiftpm_release_package.mjs";

describe("SwiftPM Apple carrier architecture contract", () => {
  test("accepts the three published arm64 slices", () => {
    expect(missingRequiredAppleArm64Slices(new Set([
      "macos\0\0arm64",
      "ios\0\0arm64",
      "ios\0simulator\0arm64",
    ]))).toEqual([]);
  });

  test("does not mistake Intel-only slices for the published arm64 support", () => {
    expect(missingRequiredAppleArm64Slices(new Set([
      "macos\0\0x86_64",
      "ios\0simulator\0x86_64",
    ]))).toEqual([
      "ios-arm64",
      "ios-simulator-arm64",
      "macos-arm64",
    ]);
  });
});

describe("SwiftPM remote checksum manifest", () => {
  test("uses a bounded, timed request that permits the release-asset redirect", async () => {
    let request;
    const text = await fetchText("https://github.example/release/checksums", {
      fetchImpl: async (url, options) => {
        request = { url, options };
        return new Response("a".repeat(64) + "  ./asset.zip\n");
      },
      timeoutMs: 1_000,
    });
    expect(text).toContain("./asset.zip");
    expect(request.options.redirect).toBe("follow");
    expect(request.options.signal).toBeInstanceOf(AbortSignal);
  });

  test("rejects an oversized checksum manifest before reading it", async () => {
    await expect(fetchText("https://github.example/release/checksums", {
      fetchImpl: async () => new Response("x", {
        headers: { "content-length": String(1024 * 1024 + 1) },
      }),
    })).rejects.toThrow("checksum manifest exceeds 1048576 bytes");
  });
});
