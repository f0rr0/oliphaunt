import { describe, expect, test } from "bun:test";

import {
  boundedRegistrySleep,
  jsrManagementPackageExists,
  readBoundedRegistryJson,
  registryRequestTimeoutMilliseconds,
} from "./check_registry_publication.mjs";

describe("registry publication HTTP response boundary", () => {
  test("parses a response only within the configured byte limit", async () => {
    await expect(readBoundedRegistryJson(Response.json({ present: true }), "registry", 64))
      .resolves.toEqual({ present: true });
    await expect(readBoundedRegistryJson(new Response("{}", {
      headers: { "content-length": "65" },
    }), "registry", 64)).rejects.toThrow("registry response exceeds 64 bytes");
  });

  test("rejects streamed overflow and malformed JSON deterministically", async () => {
    await expect(readBoundedRegistryJson(new Response("12345"), "registry", 4))
      .rejects.toThrow("registry response exceeds 4 bytes");
    await expect(readBoundedRegistryJson(new Response("not-json"), "registry", 64))
      .rejects.toThrow("registry returned invalid JSON");
  });

  test("clamps requests and all retry sleeps before the shared mutation deadline reserve", async () => {
    const previousDeadline = process.env.REGISTRY_MUTATION_DEADLINE_EPOCH;
    const now = 1_000_000;
    const sleeps = [];
    try {
      process.env.REGISTRY_MUTATION_DEADLINE_EPOCH = "1010";
      expect(registryRequestTimeoutMilliseconds("registry request", { nowImpl: () => now })).toBe(5_000);
      await expect(boundedRegistrySleep(4, "HTTP Retry-After", {
        nowImpl: () => now,
        sleepImpl: async (milliseconds) => sleeps.push(milliseconds),
      })).resolves.toBeUndefined();
      expect(sleeps).toEqual([4_000]);
      await expect(boundedRegistrySleep(5, "outer publication retry", {
        nowImpl: () => now,
        sleepImpl: async () => {
          throw new Error("must not consume the cleanup reserve");
        },
      })).rejects.toThrow("cannot wait 5s before the shared registry mutation deadline");

      process.env.REGISTRY_MUTATION_DEADLINE_EPOCH = "1005";
      expect(() => registryRequestTimeoutMilliseconds("registry request", { nowImpl: () => now }))
        .toThrow("shared registry mutation deadline has been reached");
    } finally {
      if (previousDeadline === undefined) delete process.env.REGISTRY_MUTATION_DEADLINE_EPOCH;
      else process.env.REGISTRY_MUTATION_DEADLINE_EPOCH = previousDeadline;
    }
  });

  test("retains the ordinary read-only timeout and sleep behavior when no mutation deadline is present", async () => {
    const previousDeadline = process.env.REGISTRY_MUTATION_DEADLINE_EPOCH;
    const sleeps = [];
    try {
      delete process.env.REGISTRY_MUTATION_DEADLINE_EPOCH;
      expect(registryRequestTimeoutMilliseconds("registry request", { nowImpl: () => 1_000_000 })).toBe(20_000);
      await boundedRegistrySleep(30, "read-only retry", {
        nowImpl: () => 1_000_000,
        sleepImpl: async (milliseconds) => sleeps.push(milliseconds),
      });
      expect(sleeps).toEqual([30_000]);
    } finally {
      if (previousDeadline === undefined) delete process.env.REGISTRY_MUTATION_DEADLINE_EPOCH;
      else process.env.REGISTRY_MUTATION_DEADLINE_EPOCH = previousDeadline;
    }
  });

  test("detects a zero-version JSR identity through the credential-free management endpoint", async () => {
    const requests = [];
    const exists = await jsrManagementPackageExists("@oliphaunt/ts", {
      apiBase: "https://api.example.test/",
      fetchImpl: async (url, init) => {
        requests.push({ url: String(url), init });
        return Response.json({
          scope: "oliphaunt",
          name: "ts",
          versionCount: 0,
          latestVersion: null,
          githubRepository: { owner: "f0rr0", name: "oliphaunt" },
        });
      },
    });

    expect(exists).toBe(true);
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe("https://api.example.test/scopes/oliphaunt/packages/ts");
    expect(new Headers(requests[0].init.headers).has("authorization")).toBe(false);
  });

  test("distinguishes a missing JSR identity and rejects mismatched management metadata", async () => {
    await expect(jsrManagementPackageExists("@oliphaunt/absent", {
      apiBase: "https://api.example.test",
      fetchImpl: async () => new Response("not found", { status: 404 }),
    })).resolves.toBe(false);

    await expect(jsrManagementPackageExists("@oliphaunt/ts", {
      apiBase: "https://api.example.test",
      fetchImpl: async () => Response.json({ scope: "another-scope", name: "ts", versionCount: 0 }),
    })).rejects.toThrow("JSR management API returned mismatched identity metadata for @oliphaunt/ts");
  });
});
