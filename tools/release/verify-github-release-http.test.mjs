import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";

import {
  requestBoundedGithubJson,
  requestReleaseAssetProof,
  requestReleaseControlBytes,
} from "./verify_github_release_attestations.mjs";

describe("GitHub release HTTP boundaries", () => {
  test("bounds and times the release metadata request without redirects", async () => {
    let request;
    const value = await requestBoundedGithubJson("https://api.github.com/repos/f0rr0/oliphaunt/releases/tags/test", {
      fetchImpl: async (url, options) => {
        request = { url, options };
        return Response.json({ assets: [] });
      },
      timeoutMs: 1_000,
    });
    expect(value).toEqual({ assets: [] });
    expect(request.options.redirect).toBe("error");
    expect(request.options.signal).toBeInstanceOf(AbortSignal);
  });

  test("rejects oversized release metadata before JSON parsing", async () => {
    await expect(requestBoundedGithubJson("https://api.github.com/repos/f0rr0/oliphaunt/releases/tags/test", {
      fetchImpl: async () => new Response("{}", {
        headers: { "content-length": String(8 * 1024 * 1024 + 1) },
      }),
    })).rejects.toThrow("GitHub API response exceeds 8388608 bytes");
  });

  test("streams an asset into an exact size and sha256 proof", async () => {
    const bytes = Buffer.from("exact release asset bytes\n");
    let request;
    const proof = await requestReleaseAssetProof(
      "https://api.github.com/repos/f0rr0/oliphaunt/releases/assets/1",
      "asset.tar.zst",
      bytes.length,
      {
        fetchImpl: async (url, options) => {
          request = { url, options };
          return new Response(bytes);
        },
        timeoutMs: 1_000,
      },
    );
    expect(proof).toEqual({
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
    expect(request.options.redirect).toBe("follow");
    expect(request.options.signal).toBeInstanceOf(AbortSignal);
  });

  test("rejects size mismatches before buffering or hashing an unbounded asset", async () => {
    await expect(requestReleaseAssetProof(
      "https://api.github.com/repos/f0rr0/oliphaunt/releases/assets/1",
      "asset.tar.zst",
      4,
      {
        fetchImpl: async () => new Response("x", {
          headers: { "content-length": "5" },
        }),
      },
    )).rejects.toThrow("Content-Length 5 does not match expected size 4");
  });

  test("caps control manifests and rejects asset URLs outside the GitHub API origin", async () => {
    await expect(requestReleaseControlBytes(
      "https://api.github.com/repos/f0rr0/oliphaunt/releases/assets/1",
      "manifest.json",
      8 * 1024 * 1024 + 1,
      { fetchImpl: async () => new Response("{}") },
    )).rejects.toThrow("invalid size");
    await expect(requestReleaseAssetProof(
      "https://attacker.invalid/releases/assets/1",
      "asset.tar.zst",
      1,
      { fetchImpl: async () => new Response("x") },
    )).rejects.toThrow("must use https://api.github.com");
  });
});
