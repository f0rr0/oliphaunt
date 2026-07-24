import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const source = readFileSync(path.join(import.meta.dir, "release-verify.mjs"), "utf8");

describe("release verification composition", () => {
  test("reuses frozen registry and GitHub attestation receipts while consumer proof remains one explicit workflow gate", () => {
    expect(source).toContain("check_release_versions.mjs");
    expect(source).toContain("--check-registries");
    expect(source).toContain("--registry-receipts");
    expect(source).toContain("--github-release-receipt");
    expect(source).toContain('"finalize"');
    expect(source).toContain("verify_github_release_attestations.mjs");
    expect(source).toContain("registry-integrity.mjs");
    expect(source).not.toContain("release-consumer-shape.mjs");
  });
});
