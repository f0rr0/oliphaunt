import { describe, expect, test } from "bun:test";

import { parseMavenBundlePreflightArgs } from "./preflight-maven-central-bundle.mjs";

const sha = "A".repeat(40);

describe("preflight Maven Central bundle CLI", () => {
  test("requires exact lock, product, and release identities", () => {
    expect(parseMavenBundlePreflightArgs([
      "--publication-lock", "target/release/publication-lock.json",
      "--products-json", '["oliphaunt-kotlin"]',
      "--release-commit", sha,
    ])).toEqual({
      products: ["oliphaunt-kotlin"],
      publicationLock: `${process.cwd()}/target/release/publication-lock.json`,
      releaseCommit: sha.toLowerCase(),
    });
  });

  test("rejects unknown, duplicate, missing, malformed, and ambiguous inputs", () => {
    for (const args of [
      [],
      ["--unknown", "value"],
      ["--publication-lock", "a", "--publication-lock", "b", "--products-json", '["p"]', "--release-commit", sha],
      ["--publication-lock", "a", "--products-json", "{}", "--release-commit", sha],
      ["--publication-lock", "a", "--products-json", '["p","p"]', "--release-commit", sha],
      ["--publication-lock", "a", "--products-json", '["p"]', "--release-commit", "short"],
    ]) {
      expect(() => parseMavenBundlePreflightArgs(args)).toThrow();
    }
  });
});
