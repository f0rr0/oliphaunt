import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const source = readFileSync(path.join(import.meta.dir, "release-verify.mjs"), "utf8");

describe("release verification composition", () => {
  test("keeps version and attestation checks while consumer proof remains one explicit workflow gate", () => {
    expect(source).toContain("check_release_versions.mjs");
    expect(source).toContain("--check-registries");
    expect(source).toContain("verify_github_release_attestations.mjs");
    expect(source).not.toContain("release-consumer-shape.mjs");
  });
});
