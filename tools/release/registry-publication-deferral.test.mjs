import { describe, expect, test } from "bun:test";

import {
  decodeRegistryPublicationDeferral,
  encodeRegistryPublicationDeferral,
  isRegistryPublicationDeferredError,
  requirePreMutationRegistryWindow,
  RegistryPublicationDeferredError,
  REGISTRY_PUBLICATION_DEFERRAL_PREFIX,
} from "./registry-publication-deferral.mjs";

describe("registry publication deferral child boundary", () => {
  test("round-trips one canonical typed record embedded in ordinary stderr", () => {
    const original = new RegistryPublicationDeferredError({
      reason: "rate-limit",
      notBeforeEpochSeconds: 1_800_000_000,
      context: "explicit crates.io 429 with valid Retry-After",
    });
    const encoded = encodeRegistryPublicationDeferral(original);
    expect(encoded).toStartWith(REGISTRY_PUBLICATION_DEFERRAL_PREFIX);
    const decoded = decodeRegistryPublicationDeferral(`ordinary diagnostic\n${encoded}\n`);
    expect(isRegistryPublicationDeferredError(decoded)).toBe(true);
    expect(decoded).toMatchObject({
      reason: original.reason,
      notBeforeEpochSeconds: original.notBeforeEpochSeconds,
      context: original.context,
    });
  });

  test("rejects lookalikes, duplicate markers, noncanonical bytes, extra keys, and schemas", () => {
    expect(() => encodeRegistryPublicationDeferral(Object.assign(new Error("lookalike"), {
      reason: "deadline",
      notBeforeEpochSeconds: 1_800_000_000,
    }))).toThrow(/only a RegistryPublicationDeferredError/u);
    expect(() => decodeRegistryPublicationDeferral("ordinary failure only")).toThrow(/exactly one/u);

    const valid = encodeRegistryPublicationDeferral(new RegistryPublicationDeferredError({
      reason: "deadline",
      notBeforeEpochSeconds: 1_800_000_000,
      context: "no upload started",
    }));
    expect(() => decodeRegistryPublicationDeferral(`${valid}\n${valid}\n`)).toThrow(/exactly one/u);
    expect(() => decodeRegistryPublicationDeferral(`${REGISTRY_PUBLICATION_DEFERRAL_PREFIX}***\n`)).toThrow(/exactly one/u);

    for (const record of [
      {
        schema: "oliphaunt-registry-publication-deferral-v1",
        reason: "deadline",
        notBeforeEpochSeconds: 1_800_000_000,
        context: "no upload started",
        extra: true,
      },
      {
        schema: "future-schema",
        reason: "deadline",
        notBeforeEpochSeconds: 1_800_000_000,
        context: "no upload started",
      },
    ]) {
      const line = `${REGISTRY_PUBLICATION_DEFERRAL_PREFIX}${Buffer.from(JSON.stringify(record)).toString("base64url")}`;
      expect(() => decodeRegistryPublicationDeferral(line)).toThrow(/keys must be exactly|schema must be/u);
    }
  });

  test("types only a pre-mutation operation that cannot fit its reserved window", () => {
    expect(requirePreMutationRegistryWindow({
      deadlineEpochSeconds: 1_100,
      minimumMilliseconds: 30_000,
      reserveMilliseconds: 5_000,
      nowEpochMilliseconds: 1_000_000,
      context: "npm publish for @example/package@1.0.0",
    })).toBe(95_000);

    let observed;
    try {
      requirePreMutationRegistryWindow({
        deadlineEpochSeconds: 1_030,
        minimumMilliseconds: 30_000,
        reserveMilliseconds: 5_000,
        nowEpochMilliseconds: 1_000_000,
        context: "npm publish for @example/package@1.0.0",
      });
    } catch (cause) {
      observed = cause;
    }
    expect(isRegistryPublicationDeferredError(observed)).toBe(true);
    expect(observed).toMatchObject({
      reason: "deadline",
      notBeforeEpochSeconds: 1_001,
    });
    expect(observed.context).toContain("requires 30s before its first remote mutation");
  });
});
