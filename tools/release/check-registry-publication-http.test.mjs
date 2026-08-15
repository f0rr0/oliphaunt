import { describe, expect, test } from "bun:test";

import {
  CRATES_IO_RATE_LIMIT_FALLBACK_SECONDS,
  CRATES_IO_READ_INTERVAL_SECONDS,
  CRATES_IO_READ_RETRY_BUDGET_SECONDS,
  boundedRegistrySleep,
  cratesioUrlExists,
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

  test("paces every crates.io existence read and honors Retry-After before retrying", async () => {
    let calls = 0;
    let now = 1_000_000;
    const sleeps = [];
    const exists = await cratesioUrlExists(
      "https://crates.example.test/api/v1/crates/example/1.0.0",
      "example 1.0.0",
      {
        nowImpl: () => now,
        sleepImpl: async (milliseconds) => {
          sleeps.push(milliseconds);
          now += milliseconds;
        },
        fetchImpl: async () => {
          calls += 1;
          return calls === 1
            ? new Response("", { status: 429, headers: { "Retry-After": "2" } })
            : new Response("", { status: 200 });
        },
      },
    );

    expect(exists).toBe(true);
    expect(calls).toBe(2);
    expect(sleeps).toEqual([
      CRATES_IO_READ_INTERVAL_SECONDS * 1000,
      2_000,
      CRATES_IO_READ_INTERVAL_SECONDS * 1000,
    ]);
  });

  test("uses a conservative bounded crates.io 429 fallback and never retries before an excessive Retry-After", async () => {
    let calls = 0;
    let now = 1_000_000;
    const fallbackSleeps = [];
    await expect(cratesioUrlExists(
      "https://crates.example.test/api/v1/crates/absent/1.0.0",
      "absent 1.0.0",
      {
        nowImpl: () => now,
        sleepImpl: async (milliseconds) => {
          fallbackSleeps.push(milliseconds);
          now += milliseconds;
        },
        fetchImpl: async () => {
          calls += 1;
          return calls === 1
            ? new Response("", { status: 429 })
            : new Response("", { status: 404 });
        },
      },
    )).resolves.toBe(false);
    expect(fallbackSleeps).toEqual([
      CRATES_IO_READ_INTERVAL_SECONDS * 1000,
      CRATES_IO_RATE_LIMIT_FALLBACK_SECONDS * 1000,
      CRATES_IO_READ_INTERVAL_SECONDS * 1000,
    ]);

    calls = 0;
    const excessiveSleeps = [];
    await expect(cratesioUrlExists(
      "https://crates.example.test/api/v1/crates/later/1.0.0",
      "later 1.0.0",
      {
        nowImpl: () => 1_000_000,
        sleepImpl: async (milliseconds) => excessiveSleeps.push(milliseconds),
        fetchImpl: async () => {
          calls += 1;
          return new Response("", {
            status: 429,
            headers: { "Retry-After": String(CRATES_IO_READ_RETRY_BUDGET_SECONDS + 1) },
          });
        },
      },
    )).rejects.toThrow(
      `exceeds its bounded ${CRATES_IO_READ_RETRY_BUDGET_SECONDS}s retry-delay budget`,
    );
    expect(calls).toBe(1);
    expect(excessiveSleeps).toEqual([CRATES_IO_READ_INTERVAL_SECONDS * 1000]);
  });
});
