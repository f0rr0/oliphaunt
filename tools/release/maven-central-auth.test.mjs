import { describe, expect, test } from "bun:test";

import { mavenCentralAuthorization } from "./maven-central-auth.mjs";

describe("Maven Central Portal authorization", () => {
  test("uses the Portal Bearer credential format", () => {
    expect(mavenCentralAuthorization("publisher", "s3cr3t:with-colon")).toBe(
      "Bearer cHVibGlzaGVyOnMzY3IzdDp3aXRoLWNvbG9u",
    );
  });

  test("rejects absent credentials instead of constructing an ambiguous header", () => {
    expect(() => mavenCentralAuthorization("", "secret")).toThrow("username");
    expect(() => mavenCentralAuthorization("publisher", "")).toThrow("password");
  });
});
