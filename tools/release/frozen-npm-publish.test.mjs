import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  frozenNpmIntegrity,
  inspectNpmExactVersion,
  inspectNpmVersionState,
  publishFrozenNpmPackage,
} from "./frozen-npm-publish.mjs";
import { isRegistryPublicationDeferredError } from "./registry-publication-deferral.mjs";

const temporaryDirectories = [];

function tarball() {
  const root = mkdtempSync(path.join(os.tmpdir(), "oliphaunt-frozen-npm-"));
  temporaryDirectories.push(root);
  const file = path.join(root, "fixture-1.2.3.tgz");
  writeFileSync(file, "immutable npm fixture\n");
  return file;
}

function publishedResponse(integrity) {
  return Response.json({ name: "@oliphaunt/fixture", version: "1.2.3", dist: { integrity } });
}

function timeoutResult() {
  const cause = new Error("spawnSync npm ETIMEDOUT");
  cause.code = "ETIMEDOUT";
  return { error: cause, status: null, signal: "SIGTERM" };
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop(), { recursive: true, force: true });
  }
});

describe("frozen npm registry publication", () => {
  test("classifies exact versions and rejects immutable SRI conflicts", async () => {
    const file = tarball();
    const expectedIntegrity = frozenNpmIntegrity(file);
    const urls = [];
    const state = await inspectNpmExactVersion({
      packageName: "@oliphaunt/fixture",
      version: "1.2.3",
      expectedIntegrity,
      deadlineEpochSeconds: 2_000,
      nowImpl: () => 1_000_000,
      fetchImpl: async (url, options) => {
        urls.push(url);
        expect(options.headers.Accept).toBe("application/json");
        return publishedResponse(expectedIntegrity);
      },
    });
    expect(state.published).toBe(true);
    expect(urls).toEqual(["https://registry.npmjs.org/%40oliphaunt%2Ffixture/1.2.3"]);

    await expect(inspectNpmExactVersion({
      packageName: "@oliphaunt/fixture",
      version: "1.2.3",
      expectedIntegrity,
      deadlineEpochSeconds: 2_000,
      nowImpl: () => 1_000_000,
      fetchImpl: async () => publishedResponse("sha512-conflicting"),
    })).rejects.toThrow(/immutable npm version.*conflicts/u);
  });

  test("inventories npm exact versions so resumptions omit public carriers", async () => {
    const calls = [];
    const inventory = await inspectNpmVersionState({
      plan: [
        { ecosystem: "cargo", name: "not-npm", version: "1.0.0" },
        { ecosystem: "npm", name: "@oliphaunt/missing", version: "1.0.0" },
        { ecosystem: "npm", name: "@oliphaunt/pending", version: "1.0.0" },
        { ecosystem: "npm", name: "@oliphaunt/published", version: "1.0.0" },
      ],
      deadlineEpochSeconds: 2_000,
      nowImpl: () => 1_000_000,
      concurrency: 1,
      fetchImpl: async (url, options) => {
        calls.push({ url, options });
        if (url.includes("published")) return publishedResponse("sha512-present");
        if (url === "https://registry.npmjs.org/%40oliphaunt%2Fpending") {
          return Response.json({ name: "@oliphaunt/pending" });
        }
        return new Response("", { status: 404 });
      },
    });

    expect(inventory).toEqual({
      selectedIdentities: [
        { name: "@oliphaunt/missing", version: "1.0.0" },
        { name: "@oliphaunt/pending", version: "1.0.0" },
        { name: "@oliphaunt/published", version: "1.0.0" },
      ],
      publishedIdentities: [{ name: "@oliphaunt/published", version: "1.0.0" }],
      pendingVersions: [{ name: "@oliphaunt/pending", version: "1.0.0" }],
      missingNames: ["@oliphaunt/missing"],
    });
    expect(calls.every(({ options }) => options.headers.Accept === "application/json")).toBe(true);
    expect(calls.map(({ url }) => url)).toContain("https://registry.npmjs.org/%40oliphaunt%2Fpending");
  });

  test("identity bootstrap refuses an existing package name whose locked exact version is absent", async () => {
    const file = tarball();
    let spawns = 0;
    await expect(publishFrozenNpmPackage({
      packageName: "@oliphaunt/fixture",
      version: "1.2.3",
      tarball: file,
      deadlineEpochSeconds: 2_000,
      nowImpl: () => 1_000_000,
      identityCreationOnly: true,
      fetchImpl: async (url, options) => {
        expect(options.headers.Accept).toBe("application/json");
        return url.endsWith("/1.2.3")
          ? new Response("", { status: 404 })
          : Response.json({ name: "@oliphaunt/fixture" });
      },
      spawnImpl: () => {
        spawns += 1;
        return { status: 0 };
      },
    })).rejects.toThrow(/identity bootstrap cannot publish.*package name.*already exists/u);
    expect(spawns).toBe(0);
  });

  test("skips an already-public lock-matching version without invoking npm", async () => {
    const file = tarball();
    let spawns = 0;
    const result = await publishFrozenNpmPackage({
      packageName: "@oliphaunt/fixture",
      version: "1.2.3",
      tarball: file,
      deadlineEpochSeconds: 2_000,
      nowImpl: () => 1_000_000,
      fetchImpl: async () => publishedResponse(frozenNpmIntegrity(file)),
      spawnImpl: () => {
        spawns += 1;
        return { status: 0 };
      },
    });

    expect(result.skipped).toBe(true);
    expect(spawns).toBe(0);
  });

  test("bounds npm publish and proves the resulting immutable version plus SRI", async () => {
    const file = tarball();
    const expectedIntegrity = frozenNpmIntegrity(file);
    let reads = 0;
    const spawnCalls = [];
    const result = await publishFrozenNpmPackage({
      packageName: "@oliphaunt/fixture",
      version: "1.2.3",
      tarball: file,
      deadlineEpochSeconds: 1_100,
      nowImpl: () => 1_000_000,
      fetchImpl: async () => {
        reads += 1;
        return reads === 1 ? new Response("", { status: 404 }) : publishedResponse(expectedIntegrity);
      },
      spawnImpl: (...args) => {
        spawnCalls.push(args);
        return { status: 0 };
      },
    });

    expect(result).toMatchObject({ skipped: false, reconciledTimeout: false });
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0][0]).toBe("npm");
    expect(spawnCalls[0][1]).toEqual([
      "publish",
      file,
      "--access",
      "public",
      "--provenance",
      "--registry",
      "https://registry.npmjs.org",
    ]);
    expect(spawnCalls[0][2].timeout).toBe(95_000);
  });

  test("rejects noncanonical npm registries before any read or mutation", async () => {
    const file = tarball();
    for (const registry of [
      "http://registry.npmjs.org",
      "https://registry.example.invalid",
      "https://registry.npmjs.org/custom",
      "https://user:secret@registry.npmjs.org",
    ]) {
      let reads = 0;
      let spawns = 0;
      await expect(publishFrozenNpmPackage({
        packageName: "@oliphaunt/fixture",
        version: "1.2.3",
        tarball: file,
        registry,
        deadlineEpochSeconds: 2_000,
        nowImpl: () => 1_000_000,
        fetchImpl: async () => {
          reads += 1;
          return new Response("", { status: 404 });
        },
        spawnImpl: () => {
          spawns += 1;
          return { status: 0 };
        },
      })).rejects.toThrow(/canonical public registry/u);
      expect(reads).toBe(0);
      expect(spawns).toBe(0);
    }
  });

  test("reconciles an ambiguous npm timeout from exact registry SRI without retrying publish", async () => {
    const file = tarball();
    const expectedIntegrity = frozenNpmIntegrity(file);
    let reads = 0;
    let spawns = 0;
    const result = await publishFrozenNpmPackage({
      packageName: "@oliphaunt/fixture",
      version: "1.2.3",
      tarball: file,
      deadlineEpochSeconds: 2_000,
      nowImpl: () => 1_000_000,
      fetchImpl: async () => {
        reads += 1;
        return reads === 1 ? new Response("", { status: 404 }) : publishedResponse(expectedIntegrity);
      },
      spawnImpl: () => {
        spawns += 1;
        return timeoutResult();
      },
    });

    expect(result.reconciledTimeout).toBe(true);
    expect(result.reconciledMutationFailure).toBe(true);
    expect(spawns).toBe(1);
  });

  test("reconciles a status-one mutation failure from exact SRI without replaying publish", async () => {
    const file = tarball();
    const expectedIntegrity = frozenNpmIntegrity(file);
    let reads = 0;
    let spawns = 0;
    const result = await publishFrozenNpmPackage({
      packageName: "@oliphaunt/fixture",
      version: "1.2.3",
      tarball: file,
      deadlineEpochSeconds: 2_000,
      nowImpl: () => 1_000_000,
      fetchImpl: async () => {
        reads += 1;
        return reads === 1 ? new Response("", { status: 404 }) : publishedResponse(expectedIntegrity);
      },
      spawnImpl: () => {
        spawns += 1;
        return { status: 1, signal: null };
      },
    });

    expect(result).toMatchObject({
      reconciledMutationFailure: true,
      reconciledTimeout: false,
      skipped: false,
    });
    expect(spawns).toBe(1);
  });

  test("surfaces a status-one failure when immutable registry state remains absent", async () => {
    const file = tarball();
    let spawns = 0;
    let now = 1_000_000;
    await expect(publishFrozenNpmPackage({
      packageName: "@oliphaunt/fixture",
      version: "1.2.3",
      tarball: file,
      deadlineEpochSeconds: 2_000,
      nowImpl: () => now,
      sleepImpl: async (milliseconds) => {
        now += milliseconds;
      },
      fetchImpl: async () => new Response("", { status: 404 }),
      spawnImpl: () => {
        spawns += 1;
        return { status: 1, signal: null };
      },
      visibilityAttempts: 2,
      visibilityDelayMilliseconds: 1_000,
    })).rejects.toThrow(/failed \(npm exited with status 1\).*immutable registry state did not reconcile/u);
    expect(spawns).toBe(1);
  });

  test("never blindly retries a timed-out mutation when the exact version remains absent", async () => {
    const file = tarball();
    let spawns = 0;
    let now = 1_000_000;
    await expect(publishFrozenNpmPackage({
      packageName: "@oliphaunt/fixture",
      version: "1.2.3",
      tarball: file,
      deadlineEpochSeconds: 2_000,
      nowImpl: () => now,
      sleepImpl: async (milliseconds) => {
        now += milliseconds;
      },
      fetchImpl: async () => new Response("", { status: 404 }),
      spawnImpl: () => {
        spawns += 1;
        return timeoutResult();
      },
      visibilityAttempts: 2,
      visibilityDelayMilliseconds: 1_000,
    })).rejects.toThrow(/timed out and immutable registry state did not reconcile/u);
    expect(spawns).toBe(1);
  });

  test("rejects a timed-out mutation that resolves to conflicting immutable SRI", async () => {
    const file = tarball();
    let reads = 0;
    let spawns = 0;
    await expect(publishFrozenNpmPackage({
      packageName: "@oliphaunt/fixture",
      version: "1.2.3",
      tarball: file,
      deadlineEpochSeconds: 2_000,
      nowImpl: () => 1_000_000,
      fetchImpl: async () => {
        reads += 1;
        return reads === 1
          ? new Response("", { status: 404 })
          : publishedResponse("sha512-conflicting");
      },
      spawnImpl: () => {
        spawns += 1;
        return timeoutResult();
      },
    })).rejects.toThrow(/timed out.*immutable npm version.*conflicts/u);
    expect(spawns).toBe(1);
  });

  test("refuses mutation and visibility sleeps that cannot fit the absolute deadline", async () => {
    const file = tarball();
    let spawns = 0;
    let preMutationFailure;
    try {
      await publishFrozenNpmPackage({
        packageName: "@oliphaunt/fixture",
        version: "1.2.3",
        tarball: file,
        deadlineEpochSeconds: 1_020,
        nowImpl: () => 1_000_000,
        fetchImpl: async () => new Response("", { status: 404 }),
        spawnImpl: () => {
          spawns += 1;
          return { status: 0 };
        },
      });
    } catch (cause) {
      preMutationFailure = cause;
    }
    expect(isRegistryPublicationDeferredError(preMutationFailure)).toBe(true);
    expect(preMutationFailure.message).toMatch(/requires 30s.*15s remain/u);
    expect(spawns).toBe(0);

    let postMutationFailure;
    try {
      await publishFrozenNpmPackage({
        packageName: "@oliphaunt/fixture",
        version: "1.2.3",
        tarball: file,
        deadlineEpochSeconds: 1_040,
        nowImpl: () => 1_000_000,
        fetchImpl: async () => new Response("", { status: 404 }),
        spawnImpl: () => ({ status: 0 }),
        visibilityAttempts: 2,
        visibilityDelayMilliseconds: 40_000,
      });
    } catch (cause) {
      postMutationFailure = cause;
    }
    expect(isRegistryPublicationDeferredError(postMutationFailure)).toBe(false);
    expect(postMutationFailure.message).toMatch(/cannot wait 40s before the shared registry mutation deadline/u);
  });
});
