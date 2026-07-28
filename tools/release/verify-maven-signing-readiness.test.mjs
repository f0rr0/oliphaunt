import { describe, expect, test } from "bun:test";

import { verifyPublishedMavenSigningKey } from "./verify-maven-signing-readiness.mjs";

const FINGERPRINT = "A".repeat(40);
const SERVERS = [
  { name: "first.invalid", url: () => "https://first.invalid/key" },
  { name: "second.invalid", url: () => "https://second.invalid/key" },
];

describe("Maven signing key publication readiness", () => {
  test("accepts the exact primary fingerprint from a fallback supported keyserver", async () => {
    const calls = [];
    const result = await verifyPublishedMavenSigningKey(FINGERPRINT, {
      keyServers: SERVERS,
      fetchImpl: async (url) => {
        calls.push(url);
        return url.includes("first")
          ? new Response("missing", { status: 404 })
          : new Response("armored public key", { status: 200 });
      },
      inspectImpl: () => [FINGERPRINT],
    });
    expect(result).toEqual({ fingerprint: FINGERPRINT, server: "second.invalid" });
    expect(calls).toEqual(["https://first.invalid/key", "https://second.invalid/key"]);
  });

  test("rejects keyserver content for a different primary fingerprint", async () => {
    await expect(verifyPublishedMavenSigningKey(FINGERPRINT, {
      keyServers: SERVERS,
      fetchImpl: async () => new Response("armored public key", { status: 200 }),
      inspectImpl: () => ["B".repeat(40)],
    })).rejects.toThrow("is not verifiably published on a Central-supported keyserver");
  });

  test("rejects oversized keyserver responses before OpenPGP inspection", async () => {
    let inspected = false;
    await expect(verifyPublishedMavenSigningKey(FINGERPRINT, {
      keyServers: [SERVERS[0]],
      fetchImpl: async () => new Response("x", {
        status: 200,
        headers: { "content-length": String(1024 * 1024 + 1) },
      }),
      inspectImpl: () => {
        inspected = true;
        return [FINGERPRINT];
      },
    })).rejects.toThrow("is not verifiably published on a Central-supported keyserver");
    expect(inspected).toBe(false);
  });
});
