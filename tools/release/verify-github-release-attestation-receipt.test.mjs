import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { afterAll, describe, expect, test } from "bun:test";

import {
  assertAttestationSubjectCoverage,
  assertGithubReleaseSnapshotMatchesReceipt,
  buildGithubAttestationReceipt,
  frozenGithubReleaseAssets,
  ghBundleVerifyArgs,
  queryLockedGithubReleases,
  requestGithubJsonWithRetry,
  validateGithubAttestationReceipt,
  verifyAttestationBundles,
  writeImmutableReceipt,
} from "./verify_github_release_attestations.mjs";

const COMMIT = "1".repeat(40);
const TREE = "2".repeat(40);
const LOCK_DIGEST = "3".repeat(64);
const ASSET_SHA = createHash("sha256").update("asset bytes\n").digest("hex");
const REPO = "f0rr0/oliphaunt";
const TOKEN = "github-test-token";
const fixtureRoots = [];

function lockFixture({ withAsset = true } = {}) {
  return {
    lockDigest: LOCK_DIGEST,
    productArtifacts: withAsset
      ? [{
          id: "github-release:product-a-1.2.3.tar.zst",
          kind: "runtime",
          name: "product-a-1.2.3.tar.zst",
          path: "target/receipt-fixture/product-a-1.2.3.tar.zst",
          product: "product-a",
          role: "github-release-asset",
          sha256: ASSET_SHA,
          size: Buffer.byteLength("asset bytes\n"),
          target: "portable",
        }]
      : [],
    products: [
      { id: "product-zero", version: "2.0.0" },
      { id: "product-a", version: "1.2.3" },
    ],
    source: { commit: COMMIT, tree: TREE },
  };
}

function zeroAssetLock(productCount) {
  return {
    lockDigest: LOCK_DIGEST,
    productArtifacts: [],
    products: Array.from({ length: productCount }, (_, index) => ({
      id: `product-${String(index).padStart(2, "0")}`,
      version: "1.0.0",
    })),
    source: { commit: COMMIT, tree: TREE },
  };
}

function manyAssetLock(assetCount) {
  const product = { id: "large-product", version: "1.0.0" };
  return {
    lockDigest: LOCK_DIGEST,
    productArtifacts: Array.from({ length: assetCount }, (_, index) => {
      const name = `large-product-${String(index).padStart(3, "0")}.bin`;
      return {
        id: `github-release:${name}`,
        kind: "runtime",
        name,
        path: `target/receipt-fixture/${name}`,
        product: product.id,
        role: "github-release-asset",
        sha256: createHash("sha256").update(name).digest("hex"),
        size: index + 1,
        target: "portable",
      };
    }),
    products: [product],
    source: { commit: COMMIT, tree: TREE },
  };
}

function remoteRelease(product, { assets, releaseId }) {
  return {
    assets,
    draft: true,
    id: releaseId,
    name: `${product.id} v${product.version}`,
    prerelease: product.version.includes("-"),
    tag_name: `${product.id}-v${product.version}`,
    target_commitish: COMMIT,
  };
}

function remoteAsset({ digest = `sha256:${ASSET_SHA}`, id = 101 } = {}) {
  return {
    digest,
    id,
    name: "product-a-1.2.3.tar.zst",
    size: Buffer.byteLength("asset bytes\n"),
    state: "uploaded",
  };
}

function releaseFetch(lock, { asset = remoteAsset(), contaminateZero = false } = {}) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ options, url });
    const parsed = new URL(url);
    const assetsFor = (product) => product.id === "product-a"
      ? (asset === null ? [] : [asset])
      : contaminateZero
        ? [{ ...remoteAsset(), id: 202, name: "unexpected.bin" }]
        : [];
    if (parsed.pathname.endsWith("/releases") && parsed.searchParams.get("page") === "1") {
      return Response.json(lock.products.map((product, index) =>
        remoteRelease(product, { assets: assetsFor(product), releaseId: index + 1 })));
    }
    const match = /\/releases\/([1-9][0-9]*)\/assets$/u.exec(parsed.pathname);
    if (match !== null && parsed.searchParams.get("page") === "1") {
      const product = lock.products[Number(match[1]) - 1];
      return product === undefined
        ? new Response("not found", { status: 404 })
        : Response.json(assetsFor(product));
    }
    return new Response("not found", { status: 404 });
  };
  return { calls, fetchImpl };
}

function receiptSubjects() {
  return [{
    bundleSha256: "a".repeat(64),
    subjects: [{ name: "product-a-1.2.3.tar.zst", sha256: ASSET_SHA }],
  }];
}

function bundleFor(subjects) {
  const statement = {
    _type: "https://in-toto.io/Statement/v1",
    predicate: {},
    predicateType: "https://slsa.dev/provenance/v1",
    subject: subjects.map(({ name, sha256 }) => ({ digest: { sha256 }, name })),
  };
  return {
    dsseEnvelope: {
      payload: Buffer.from(JSON.stringify(statement)).toString("base64"),
      payloadType: "application/vnd.in-toto+json",
      signatures: [{ keyid: "", sig: "test" }],
    },
    mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
    verificationMaterial: {},
  };
}

afterAll(async () => {
  await Promise.all(fixtureRoots.map((root) => fs.rm(root, { force: true, recursive: true })));
});

describe("GitHub release attestation receipt", () => {
  test("uses one release page plus one exact asset inventory per product in both phases", async () => {
    const lock = zeroAssetLock(49);
    const calls = [];
    const fetchImpl = async (url, options) => {
      calls.push({ options, url });
      const parsed = new URL(url);
      return Response.json(parsed.pathname.endsWith("/releases")
        ? lock.products.map((product, index) =>
          remoteRelease(product, { assets: [], releaseId: index + 1 }))
        : []);
    };

    const preMutation = await queryLockedGithubReleases(lock, {
      authToken: TOKEN,
      fetchImpl,
      repo: REPO,
    });
    const finalize = await queryLockedGithubReleases(lock, {
      authToken: TOKEN,
      fetchImpl,
      repo: REPO,
    });

    expect(preMutation).toHaveLength(49);
    expect(finalize).toEqual(preMutation);
    expect(calls).toHaveLength(100);
    expect(calls.filter(({ url }) => url.endsWith("/releases?per_page=100&page=1"))).toHaveLength(2);
    expect(calls.filter(({ url }) => /\/releases\/[1-9][0-9]*\/assets\?per_page=100&page=1$/u.test(url))).toHaveLength(98);
    expect(calls.every(({ options }) => options.headers.Authorization === `Bearer ${TOKEN}`)).toBe(true);
  });

  test("queries one authenticated draft-inclusive release snapshot and proves a zero-asset product has exactly no assets", async () => {
    const lock = lockFixture();
    const { calls, fetchImpl } = releaseFetch(lock);
    const releases = await queryLockedGithubReleases(lock, {
      authToken: TOKEN,
      fetchImpl,
      repo: REPO,
    });

    expect(calls).toHaveLength(3);
    expect(calls[0].url).toEndWith("/releases?per_page=100&page=1");
    expect(calls.every(({ options }) => options.headers.Authorization === `Bearer ${TOKEN}`)).toBe(true);
    expect(releases.map((release) => release.product)).toEqual(["product-a", "product-zero"]);
    expect(releases.every((release) => release.draft)).toBe(true);
    expect(releases.find((release) => release.product === "product-zero").assets).toEqual([]);
    expect(releases.find((release) => release.product === "product-a").assets).toEqual([{
      assetId: "101",
      name: "product-a-1.2.3.tar.zst",
      sha256: ASSET_SHA,
      size: Buffer.byteLength("asset bytes\n"),
    }]);
  });

  test("serializes authoritative asset inventories so a backoff stops the request stream", async () => {
    const lock = lockFixture();
    const assetReads = [];
    let firstAssetAttempts = 0;
    let now = 1_000;
    let releaseBackoff;
    const backoffReleased = new Promise((resolve) => {
      releaseBackoff = resolve;
    });
    let reportBackoff;
    const backoffStarted = new Promise((resolve) => {
      reportBackoff = resolve;
    });
    const query = queryLockedGithubReleases(lock, {
      authToken: TOKEN,
      fetchImpl: async (url) => {
        const parsed = new URL(url);
        if (parsed.pathname.endsWith("/releases")) {
          return Response.json(lock.products.map((product, index) =>
            remoteRelease(product, { assets: [], releaseId: index + 1 })));
        }
        assetReads.push(parsed.pathname);
        if (parsed.pathname.endsWith("/releases/2/assets")) {
          firstAssetAttempts += 1;
          if (firstAssetAttempts === 1) {
            return Response.json({ message: "secondary rate limit" }, { status: 429 });
          }
        }
        return Response.json(parsed.pathname.endsWith("/releases/2/assets") ? [remoteAsset()] : []);
      },
      deadlineMs: 180_000,
      nowImpl: () => now,
      repo: REPO,
      sleepImpl: async (milliseconds) => {
        expect(milliseconds).toBe(60_000);
        reportBackoff();
        await backoffReleased;
        now += milliseconds;
      },
    });
    await backoffStarted;
    expect(assetReads).toEqual(["/repos/f0rr0/oliphaunt/releases/2/assets"]);
    releaseBackoff();
    const releases = await query;
    expect(releases).toHaveLength(2);
    expect(assetReads).toEqual([
      "/repos/f0rr0/oliphaunt/releases/2/assets",
      "/repos/f0rr0/oliphaunt/releases/2/assets",
      "/repos/f0rr0/oliphaunt/releases/1/assets",
    ]);
  });

  test("paginates the repository release inventory and rejects duplicate selected tags", async () => {
    const lock = lockFixture();
    const historical = Array.from({ length: 100 }, (_, index) =>
      remoteRelease({ id: `historical-${index}`, version: "0.1.0" }, {
        assets: [],
        releaseId: index + 1_000,
      }));
    const selected = lock.products.map((product, index) =>
      remoteRelease(product, {
        assets: product.id === "product-a" ? [remoteAsset()] : [],
        releaseId: index + 1,
      }));
    const calls = [];
    const releases = await queryLockedGithubReleases(lock, {
      authToken: TOKEN,
      fetchImpl: async (url) => {
        calls.push(url);
        const parsed = new URL(url);
        if (parsed.pathname.endsWith("/releases")) {
          return parsed.searchParams.get("page") === "1"
            ? Response.json(historical, {
                headers: { Link: `<${url.replace("page=1", "page=2")}>; rel="next"` },
              })
            : Response.json(selected);
        }
        const match = /\/releases\/([1-9][0-9]*)\/assets$/u.exec(parsed.pathname);
        const product = match === null ? undefined : lock.products[Number(match[1]) - 1];
        return Response.json(product?.id === "product-a" ? [remoteAsset()] : []);
      },
      repo: REPO,
    });
    expect(releases).toHaveLength(2);
    expect(calls.filter((url) => new URL(url).pathname.endsWith("/releases"))
      .map((url) => new URL(url).searchParams.get("page"))).toEqual(["1", "2"]);

    const duplicatePages = [
      [selected[0], ...historical.slice(0, 99)],
      [{ ...selected[0], id: 999 }, selected[1]],
    ];
    await expect(queryLockedGithubReleases(lock, {
      authToken: TOKEN,
      fetchImpl: async (url) => {
        const page = Number(new URL(url).searchParams.get("page"));
        return Response.json(duplicatePages[page - 1], page === 1
          ? { headers: { Link: `<${url.replace("page=1", "page=2")}>; rel="next"` } }
          : undefined);
      },
      repo: REPO,
    })).rejects.toThrow("duplicate releases for selected tag");
  });

  test("exact 100- and 200-row release inventories do not request an empty trailing page", async () => {
    const lock = lockFixture();
    for (const totalRows of [100, 200]) {
      const historical = Array.from({ length: totalRows - lock.products.length }, (_, index) =>
        remoteRelease({ id: `historical-${totalRows}-${index}`, version: "0.1.0" }, {
          assets: [],
          releaseId: index + 1_000,
        }));
      const selected = lock.products.map((product, index) =>
        remoteRelease(product, { assets: [], releaseId: index + 1 }));
      const pages = [...historical, ...selected].reduce((output, row, index) => {
        const page = Math.floor(index / 100);
        (output[page] ??= []).push(row);
        return output;
      }, []);
      const releasePageCalls = [];
      const releases = await queryLockedGithubReleases(lock, {
        authToken: TOKEN,
        fetchImpl: async (url) => {
          const parsed = new URL(url);
          if (parsed.pathname.endsWith("/releases")) {
            const page = Number(parsed.searchParams.get("page"));
            releasePageCalls.push(page);
            return Response.json(pages[page - 1], page < pages.length
              ? { headers: { Link: `<${url.replace(`page=${page}`, `page=${page + 1}`)}>; rel="next"` } }
              : undefined);
          }
          return Response.json(parsed.pathname.endsWith("/releases/2/assets") ? [remoteAsset()] : []);
        },
        repo: REPO,
      });
      expect(releases).toHaveLength(2);
      expect(releasePageCalls).toEqual(Array.from({ length: totalRows / 100 }, (_, index) => index + 1));
    }
  });

  test("rejects selected release metadata conflicts without readiness retries", async () => {
    const lock = lockFixture();
    let calls = 0;
    let sleeps = 0;
    await expect(queryLockedGithubReleases(lock, {
      authToken: TOKEN,
      fetchImpl: async () => {
        calls += 1;
        return Response.json(lock.products.map((product, index) => ({
          ...remoteRelease(product, {
            assets: product.id === "product-a" ? [remoteAsset()] : [],
            releaseId: index + 1,
          }),
          ...(product.id === "product-a" ? { target_commitish: "f".repeat(40) } : {}),
        })));
      },
      repo: REPO,
      sleepImpl: async () => {
        sleeps += 1;
      },
    })).rejects.toThrow("metadata does not match the frozen publication lock");
    expect(calls).toBe(1);
    expect(sleeps).toBe(0);
  });

  test("uses a paginated per-release asset inventory above the safe embedded bound", async () => {
    const lock = manyAssetLock(30);
    const remoteAssets = lock.productArtifacts.map((asset, index) => ({
      digest: `sha256:${asset.sha256}`,
      id: index + 100,
      name: asset.name,
      size: asset.size,
      state: "uploaded",
    }));
    const calls = [];
    const releases = await queryLockedGithubReleases(lock, {
      authToken: TOKEN,
      fetchImpl: async (url) => {
        calls.push(url);
        const parsed = new URL(url);
        if (parsed.pathname.endsWith("/releases")) {
          return Response.json([
            remoteRelease(lock.products[0], { assets: remoteAssets.slice(0, 29), releaseId: 77 }),
          ]);
        }
        if (parsed.pathname.endsWith("/releases/77/assets")) return Response.json(remoteAssets);
        return new Response("not found", { status: 404 });
      },
      repo: REPO,
    });
    expect(releases[0].assets).toHaveLength(30);
    expect(calls).toEqual([
      "https://api.github.com/repos/f0rr0/oliphaunt/releases?per_page=100&page=1",
      "https://api.github.com/repos/f0rr0/oliphaunt/releases/77/assets?per_page=100&page=1",
    ]);
  });

  test("refuses to query draft releases without an explicit authenticated token", async () => {
    let calls = 0;
    await expect(queryLockedGithubReleases(lockFixture(), {
      authToken: "",
      fetchImpl: async () => {
        calls += 1;
        return Response.json([]);
      },
      repo: REPO,
    })).rejects.toThrow("require GH_TOKEN or GITHUB_TOKEN");
    expect(calls).toBe(0);
  });

  test("rejects a missing GitHub digest and contamination of a zero-asset release", async () => {
    const lock = lockFixture();
    await expect(queryLockedGithubReleases(lock, {
      authToken: TOKEN,
      fetchImpl: releaseFetch(lock, { asset: remoteAsset({ digest: null }) }).fetchImpl,
      repo: REPO,
      snapshotMaxAttempts: 1,
    })).rejects.toThrow("missing GitHub digest metadata");

    const zeroLock = lockFixture({ withAsset: false });
    await expect(queryLockedGithubReleases(zeroLock, {
      authToken: TOKEN,
      fetchImpl: releaseFetch(zeroLock, { asset: null, contaminateZero: true }).fetchImpl,
      repo: REPO,
    })).rejects.toThrow("asset set mismatch");
  });

  test("retries the whole exact snapshot beyond three seconds while GitHub digest metadata converges", async () => {
    const lock = lockFixture();
    let snapshotQueries = 0;
    let now = 1_000;
    const sleeps = [];
    const fetchImpl = async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname.endsWith("/releases")) {
        snapshotQueries += 1;
        return Response.json(lock.products.map((product, index) =>
          remoteRelease(product, { assets: [], releaseId: index + 1 })));
      }
      return Response.json(parsed.pathname.endsWith("/releases/2/assets")
        ? [remoteAsset({ digest: snapshotQueries <= 3 ? null : `sha256:${ASSET_SHA}` })]
        : []);
    };
    const releases = await queryLockedGithubReleases(lock, {
      authToken: TOKEN,
      deadlineMs: 20_000,
      fetchImpl,
      nowImpl: () => now,
      repo: REPO,
      sleepImpl: async (milliseconds) => {
        sleeps.push(milliseconds);
        now += milliseconds;
      },
    });
    expect(snapshotQueries).toBe(4);
    expect(sleeps).toEqual([1_000, 2_000, 4_000]);
    expect(releases.find((release) => release.product === "product-a").assets[0].sha256).toBe(ASSET_SHA);
  });

  test("bounds whole-snapshot readiness retries by the shared deadline", async () => {
    const lock = lockFixture();
    let snapshotQueries = 0;
    let now = 1_000;
    const sleeps = [];
    const { fetchImpl } = releaseFetch(lock, { asset: remoteAsset({ digest: null }) });
    await expect(queryLockedGithubReleases(lock, {
      authToken: TOKEN,
      deadlineMs: 5_000,
      fetchImpl: async (...args) => {
        if (new URL(args[0]).pathname.endsWith("/releases")) snapshotQueries += 1;
        const response = await fetchImpl(...args);
        return response;
      },
      nowImpl: () => now,
      repo: REPO,
      sleepImpl: async (milliseconds) => {
        sleeps.push(milliseconds);
        now += milliseconds;
      },
    })).rejects.toThrow("GitHub release snapshot retry would exceed its deadline");
    expect(snapshotQueries).toBe(3);
    expect(sleeps).toEqual([1_000, 2_000]);
  });

  test("caps persistent whole-snapshot readiness retries after a ninety-second schedule", async () => {
    const lock = lockFixture();
    let now = 0;
    const sleeps = [];
    await expect(queryLockedGithubReleases(lock, {
      authToken: TOKEN,
      deadlineMs: 120_000,
      fetchImpl: releaseFetch(lock, { asset: remoteAsset({ digest: null }) }).fetchImpl,
      nowImpl: () => now,
      repo: REPO,
      sleepImpl: async (milliseconds) => {
        sleeps.push(milliseconds);
        now += milliseconds;
      },
    })).rejects.toThrow("readiness retries exhausted after 10 attempts");
    expect(sleeps).toEqual([1_000, 2_000, 4_000, 8_000, 15_000, 15_000, 15_000, 15_000, 15_000]);
    expect(now).toBe(90_000);
  });

  test("does not retry a non-null digest mismatch or an extra release asset", async () => {
    const lock = lockFixture();
    let sleeps = 0;
    await expect(queryLockedGithubReleases(lock, {
      authToken: TOKEN,
      deadlineMs: 120_000,
      fetchImpl: releaseFetch(lock, {
        asset: remoteAsset({ digest: `sha256:${"f".repeat(64)}` }),
      }).fetchImpl,
      nowImpl: () => 0,
      repo: REPO,
      sleepImpl: async () => {
        sleeps += 1;
      },
    })).rejects.toThrow("does not match");
    expect(sleeps).toBe(0);

    const zeroLock = lockFixture({ withAsset: false });
    await expect(queryLockedGithubReleases(zeroLock, {
      authToken: TOKEN,
      deadlineMs: 120_000,
      fetchImpl: releaseFetch(zeroLock, { asset: null, contaminateZero: true }).fetchImpl,
      nowImpl: () => 0,
      repo: REPO,
      sleepImpl: async () => {
        sleeps += 1;
      },
    })).rejects.toThrow("asset set mismatch");
    expect(sleeps).toBe(0);
  });

  test("retries transient GitHub responses and honors bounded rate-limit waits", async () => {
    let attempts = 0;
    let now = 1_000;
    const sleeps = [];
    const value = await requestGithubJsonWithRetry("https://api.github.com/example", {
      deadlineMs: 20_000,
      fetchImpl: async () => {
        attempts += 1;
        return attempts === 1
          ? new Response("busy", { status: 502 })
          : Response.json({ ok: true });
      },
      nowImpl: () => now,
      sleepImpl: async (milliseconds) => {
        sleeps.push(milliseconds);
        now += milliseconds;
      },
    });
    expect(value).toEqual({ ok: true });
    expect(attempts).toBe(2);
    expect(sleeps).toEqual([250]);

    attempts = 0;
    now = 1_000;
    sleeps.length = 0;
    const unavailable = await requestGithubJsonWithRetry("https://api.github.com/example", {
      deadlineMs: 30_000,
      fetchImpl: async () => {
        attempts += 1;
        return attempts === 1
          ? new Response("temporarily unavailable", {
              headers: { "retry-after": "2" },
              status: 503,
            })
          : Response.json({ ok: true });
      },
      nowImpl: () => now,
      sleepImpl: async (milliseconds) => {
        sleeps.push(milliseconds);
        now += milliseconds;
      },
    });
    expect(unavailable).toEqual({ ok: true });
    expect(attempts).toBe(2);
    expect(sleeps).toEqual([2_000]);

    attempts = 0;
    now = 1_000;
    sleeps.length = 0;
    const rateLimited = await requestGithubJsonWithRetry("https://api.github.com/example", {
      deadlineMs: 180_000,
      fetchImpl: async () => {
        attempts += 1;
        return attempts === 1
          ? new Response("slow down", { headers: { "retry-after": "60" }, status: 429 })
          : Response.json({ ok: true });
      },
      nowImpl: () => now,
      sleepImpl: async (milliseconds) => {
        sleeps.push(milliseconds);
        now += milliseconds;
      },
    });
    expect(rateLimited).toEqual({ ok: true });
    expect(attempts).toBe(2);
    expect(sleeps).toEqual([60_000]);

    attempts = 0;
    now = 1_000;
    sleeps.length = 0;
    const secondary = await requestGithubJsonWithRetry("https://api.github.com/example", {
      deadlineMs: 180_000,
      fetchImpl: async () => {
        attempts += 1;
        return attempts === 1
          ? Response.json({ message: "You have exceeded a secondary rate limit." }, { status: 403 })
          : Response.json({ ok: true });
      },
      nowImpl: () => now,
      sleepImpl: async (milliseconds) => {
        sleeps.push(milliseconds);
        now += milliseconds;
      },
    });
    expect(secondary).toEqual({ ok: true });
    expect(attempts).toBe(2);
    expect(sleeps).toEqual([60_000]);

    attempts = 0;
    now = 1_000_000;
    sleeps.length = 0;
    const primary = await requestGithubJsonWithRetry("https://api.github.com/example", {
      deadlineMs: 1_180_000,
      fetchImpl: async () => {
        attempts += 1;
        return attempts === 1
          ? Response.json({ message: "API rate limit exceeded" }, {
              headers: {
                "x-ratelimit-remaining": "0",
                "x-ratelimit-reset": "1060",
              },
              status: 403,
            })
          : Response.json({ ok: true });
      },
      nowImpl: () => now,
      sleepImpl: async (milliseconds) => {
        sleeps.push(milliseconds);
        now += milliseconds;
      },
    });
    expect(primary).toEqual({ ok: true });
    expect(attempts).toBe(2);
    expect(sleeps).toEqual([61_000]);

    let missingResetSleeps = 0;
    await expect(requestGithubJsonWithRetry("https://api.github.com/example", {
      deadlineMs: 180_000,
      fetchImpl: async () => Response.json({ message: "API rate limit exceeded" }, {
        headers: { "x-ratelimit-remaining": "0" },
        status: 403,
      }),
      nowImpl: () => 1_000,
      sleepImpl: async () => {
        missingResetSleeps += 1;
      },
    })).rejects.toThrow("without X-RateLimit-Reset");
    expect(missingResetSleeps).toBe(0);

    attempts = 0;
    now = 1_000;
    sleeps.length = 0;
    const exponential = await requestGithubJsonWithRetry("https://api.github.com/example", {
      deadlineMs: 240_000,
      fetchImpl: async () => {
        attempts += 1;
        return attempts < 3
          ? Response.json({ message: "secondary rate limit" }, { status: 429 })
          : Response.json({ ok: true });
      },
      nowImpl: () => now,
      sleepImpl: async (milliseconds) => {
        sleeps.push(milliseconds);
        now += milliseconds;
      },
    });
    expect(exponential).toEqual({ ok: true });
    expect(attempts).toBe(3);
    expect(sleeps).toEqual([60_000, 120_000]);

    attempts = 0;
    now = 1_000;
    sleeps.length = 0;
    const mixedTransient = await requestGithubJsonWithRetry("https://api.github.com/example", {
      deadlineMs: 180_000,
      fetchImpl: async () => {
        attempts += 1;
        if (attempts === 1) return new Response("busy", { status: 502 });
        return attempts === 2
          ? Response.json({ message: "secondary rate limit" }, { status: 429 })
          : Response.json({ ok: true });
      },
      nowImpl: () => now,
      sleepImpl: async (milliseconds) => {
        sleeps.push(milliseconds);
        now += milliseconds;
      },
    });
    expect(mixedTransient).toEqual({ ok: true });
    expect(attempts).toBe(3);
    expect(sleeps).toEqual([250, 60_000]);

    let forbiddenSleeps = 0;
    await expect(requestGithubJsonWithRetry("https://api.github.com/example", {
      deadlineMs: 180_000,
      fetchImpl: async () => Response.json(
        { message: "Resource not accessible by integration" },
        { status: 403 },
      ),
      nowImpl: () => 1_000,
      sleepImpl: async () => {
        forbiddenSleeps += 1;
      },
    })).rejects.toThrow("HTTP 403");
    expect(forbiddenSleeps).toBe(0);

    await expect(requestGithubJsonWithRetry("https://api.github.com/example", {
      deadlineMs: 600_000,
      fetchImpl: async () => new Response("slow down", {
        headers: { "retry-after": "300" },
        status: 429,
      }),
      nowImpl: () => 1_000,
      sleepImpl: async () => {
        throw new Error("must not sleep");
      },
    })).rejects.toThrow("exceeding the 240000ms retry cap");
  });

  test("recomputes the transport deadline after request-journal admission", async () => {
    const root = await fs.mkdtemp(path.join(process.cwd(), "target/github-receipt-journal-test."));
    fixtureRoots.push(root);
    const journal = path.join(root, "journal.json");
    const lock = `${journal}.lock`;
    await fs.writeFile(lock, "occupied\n");
    let fetches = 0;
    let now = 1_000;
    await expect(requestGithubJsonWithRetry("https://api.github.com/example", {
      coreJournalOptions: {
        environment: {
          GITHUB_REPOSITORY: "f0rr0/oliphaunt",
          GITHUB_RUN_ATTEMPT: "1",
          GITHUB_RUN_ID: "123",
          GITHUB_SHA: COMMIT,
          OLIPHAUNT_GITHUB_CORE_REQUEST_JOURNAL_PATH: journal,
          OLIPHAUNT_REQUIRE_GITHUB_CORE_REQUEST_JOURNAL: "true",
        },
        now: () => now,
        sleep: (milliseconds) => {
          now += milliseconds;
          rmSync(lock, { force: true });
        },
      },
      deadlineMs: 1_075,
      fetchImpl: async () => {
        fetches += 1;
        return Response.json({ ok: true });
      },
      nowImpl: () => now,
      sleepImpl: async () => {
        throw new Error("must not retry");
      },
    })).rejects.toThrow("deadline expired during request-journal admission");
    expect(fetches).toBe(0);
  });

  test("requires an exact non-overlapping signed subject union", () => {
    const assets = frozenGithubReleaseAssets(lockFixture());
    expect(assertAttestationSubjectCoverage(assets, receiptSubjects())).toEqual(receiptSubjects());
    expect(() => assertAttestationSubjectCoverage(assets, [])).toThrow("missing signed subjects");
    expect(() => assertAttestationSubjectCoverage(assets, [
      ...receiptSubjects(),
      { bundleSha256: "b".repeat(64), subjects: receiptSubjects()[0].subjects },
    ])).toThrow("overlaps multiple attestation bundles");
    expect(() => assertAttestationSubjectCoverage(assets, [{
      bundleSha256: "b".repeat(64),
      subjects: [{ name: "unlocked.bin", sha256: "c".repeat(64) }],
    }])).toThrow("contains non-frozen subject unlocked.bin");
    expect(() => assertAttestationSubjectCoverage([], receiptSubjects())).toThrow(
      "contaminate a release selection with no frozen GitHub assets",
    );
  });

  test("builds a deterministic lock/head/release-ID-bound receipt", async () => {
    const lock = lockFixture();
    const releases = await queryLockedGithubReleases(lock, {
      authToken: TOKEN,
      fetchImpl: releaseFetch(lock).fetchImpl,
      repo: REPO,
    });
    const receipt = buildGithubAttestationReceipt({
      attestations: receiptSubjects(),
      lock,
      releases: [...releases].reverse(),
      repo: REPO,
    });
    expect(validateGithubAttestationReceipt(receipt, lock, { repo: REPO })).toBe(receipt);
    expect(receipt.signerWorkflow).toBe("f0rr0/oliphaunt/.github/workflows/release-execute.yml");
    expect(receipt.head).toBe(COMMIT);
    expect(receipt.lockDigest).toBe(LOCK_DIGEST);

    const changed = structuredClone(releases);
    changed[0].assets[0].assetId = "999";
    expect(() => assertGithubReleaseSnapshotMatchesReceipt(receipt, changed)).toThrow(
      "IDs, names, sizes, or digests changed",
    );

    const tampered = structuredClone(receipt);
    tampered.releases[0].releaseId = "999";
    expect(() => validateGithubAttestationReceipt(tampered, lock, { repo: REPO })).toThrow(
      "receipt digest mismatch",
    );
  });

  test("verifies one locked local subject per bundle and checks the complete signed statement", async () => {
    const root = await fs.mkdtemp(path.join(process.cwd(), "target/receipt-verifier-test."));
    fixtureRoots.push(root);
    const local = path.join(root, "product-a-1.2.3.tar.zst");
    await fs.writeFile(local, "asset bytes\n");
    const lock = lockFixture();
    lock.productArtifacts[0].path = path.relative(process.cwd(), local).split(path.sep).join("/");
    const subjects = [{ name: "product-a-1.2.3.tar.zst", sha256: ASSET_SHA }];
    const bundlePath = path.join(root, "attestation.json");
    await fs.writeFile(bundlePath, JSON.stringify(bundleFor(subjects)));
    const calls = [];
    const records = await verifyAttestationBundles(lock, [bundlePath], {
      repo: REPO,
      verifyBundleImpl: async (options) => {
        calls.push(options);
        return subjects;
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].file).toBe(local);
    expect(records[0].subjects).toEqual(subjects);

    await expect(verifyAttestationBundles(lock, [bundlePath], {
      repo: REPO,
      verifyBundleImpl: async () => [{ name: "different.bin", sha256: ASSET_SHA }],
    })).rejects.toThrow("differ from its DSSE statement");
  });

  test("builds exact reusable-signer and exact-source gh verification arguments", () => {
    const args = ghBundleVerifyArgs({
      bundlePath: "/tmp/bundle.json",
      file: "/tmp/asset.tar.zst",
      head: COMMIT,
      repo: REPO,
    });
    expect(args).toContain("f0rr0/oliphaunt/.github/workflows/release-execute.yml");
    expect(args.slice(args.indexOf("--source-ref"), args.indexOf("--source-ref") + 2)).toEqual([
      "--source-ref",
      "refs/heads/main",
    ]);
    expect(args.slice(args.indexOf("--source-digest"), args.indexOf("--source-digest") + 2)).toEqual([
      "--source-digest",
      COMMIT,
    ]);
    expect(args.slice(args.indexOf("--signer-digest"), args.indexOf("--signer-digest") + 2)).toEqual([
      "--signer-digest",
      COMMIT,
    ]);
    expect(args).toContain("--deny-self-hosted-runners");
  });

  test("publishes receipt files atomically, cleans interrupted temps, and permits only identical reruns", async () => {
    const root = await fs.mkdtemp(path.join(process.cwd(), "target/github-receipt-write-test."));
    fixtureRoots.push(root);
    const output = path.join(root, "receipt.json");
    const receipt = { lockDigest: LOCK_DIGEST, schema: "test-receipt" };

    await expect(writeImmutableReceipt(output, receipt, {
      linkImpl: async () => {
        const error = new Error("simulated interruption before atomic publication");
        error.code = "EINTR";
        throw error;
      },
    })).rejects.toThrow("simulated interruption");
    await expect(fs.access(output)).rejects.toThrow();
    expect(await fs.readdir(root)).toEqual([]);

    await writeImmutableReceipt(output, receipt);
    expect(JSON.parse(await fs.readFile(output, "utf8"))).toEqual(receipt);
    await expect(writeImmutableReceipt(output, receipt)).resolves.toBe(output);
    await expect(writeImmutableReceipt(output, { ...receipt, changed: true })).rejects.toThrow(
      "refusing to replace existing non-identical",
    );
    expect((await fs.readdir(root)).every((name) => !name.includes(".tmp-"))).toBe(true);

    await fs.rm(output);
    const decoy = path.join(root, "decoy.json");
    await fs.writeFile(decoy, JSON.stringify(receipt));
    await fs.symlink(decoy, output);
    await expect(writeImmutableReceipt(output, receipt)).rejects.toThrow("regular non-symlink file");
    expect((await fs.readdir(root)).every((name) => !name.includes(".tmp-"))).toBe(true);
  });
});
