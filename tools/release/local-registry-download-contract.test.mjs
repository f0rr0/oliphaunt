import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { spawnSync } from "../test/fd-backed-spawn-sync.mjs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "../..");
const SCRIPT = path.join(ROOT, "tools/release/local-registry-publish.mjs");
const source = readFileSync(SCRIPT, "utf8");

function invoke(args) {
  return spawnSync(process.execPath, [SCRIPT, "download", ...args], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

describe("local registry artifact download contract", () => {
  test("delegates to the shared exact-SHA transactional downloader", () => {
    expect(source).toContain('".github/scripts/download-build-artifacts.mjs"');
    expect(source).toContain('[\n    "node",\n    ".github/scripts/download-build-artifacts.mjs"');
    expect(source).not.toContain('[\n    process.execPath,\n    ".github/scripts/download-build-artifacts.mjs"');
    expect(source).toContain("options.sha");
    expect(source).toContain("GH_REPO: options.repo");
    expect(source).not.toContain("function listCiArtifacts");
    expect(source).not.toContain('"gh",\n      "run",\n      "download"');
    expect(source).not.toContain("DEFAULT_RUN_ID");
  });

  test("refuses an artifact request without an exact commit SHA before network access", () => {
    const result = invoke(["--artifact", "example"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("download requires --sha");
  });

  test("rejects abbreviated, uppercase, and malformed commit identities", () => {
    for (const sha of ["abc123", "A".repeat(40), "g".repeat(40)]) {
      const result = invoke(["--sha", sha, "--artifact", "example"]);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("exact 40-character lowercase commit SHA");
    }
  });

  test("rejects malformed run identities before invoking GitHub", () => {
    const result = invoke(["--sha", "a".repeat(40), "--run-id", "0", "--artifact", "example"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("--run-id must be a positive integer");
  });
});
