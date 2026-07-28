import { expect, test } from "bun:test";

import { parseSwiftpmPreflightArgs } from "./preflight-swiftpm-source-tag.mjs";

test("requires one exact lock and release commit for SwiftPM preflight", () => {
  const sha = "A".repeat(40);
  expect(parseSwiftpmPreflightArgs([
    "--publication-lock", "target/release/publication-lock.json",
    "--release-commit", sha,
  ])).toEqual({
    publicationLock: `${process.cwd()}/target/release/publication-lock.json`,
    releaseCommit: sha.toLowerCase(),
  });
  for (const argv of [
    [],
    ["--unknown", "x"],
    ["--publication-lock", "a", "--publication-lock", "b", "--release-commit", sha],
    ["--publication-lock", "a", "--release-commit", "short"],
  ]) expect(() => parseSwiftpmPreflightArgs(argv)).toThrow();
});
