import { describe, expect, test } from "bun:test";

import {
  registryRetryDelaySeconds,
  registryStatusRetryable,
  retryAfterSeconds,
} from "./registry-http-retry.mjs";

describe("registry HTTP backoff", () => {
  test("honors Retry-After seconds and dates", () => {
    expect(retryAfterSeconds(new Headers({ "Retry-After": "42" }))).toBe(42);
    expect(retryAfterSeconds(
      new Headers({ "Retry-After": "Wed, 21 Oct 2015 07:28:00 GMT" }),
      Date.parse("Wed, 21 Oct 2015 07:27:00 GMT"),
    )).toBe(60);
    expect(registryRetryDelaySeconds({ headers: new Headers({ "Retry-After": "999" }), attempt: 0 })).toBe(300);
  });

  test("uses bounded exponential jitter without a server delay", () => {
    expect(registryRetryDelaySeconds({ attempt: 3, baseSeconds: 2, random: () => 0.5 })).toBe(16);
    expect(registryRetryDelaySeconds({ attempt: 20, baseSeconds: 2, random: () => 0.5 })).toBe(60);
  });

  test("retries only transient registry statuses", () => {
    for (const status of [408, 425, 429, 500, 502, 503, 504]) expect(registryStatusRetryable(status)).toBe(true);
    for (const status of [400, 401, 403, 404, 409, 501]) expect(registryStatusRetryable(status)).toBe(false);
  });
});
