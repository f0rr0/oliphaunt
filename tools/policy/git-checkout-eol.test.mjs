import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, test } from "bun:test";

const ROOT = path.resolve(import.meta.dir, "../..");
const WASIX_ASSET_MANIFEST =
  "src/runtimes/liboliphaunt/wasix/assets/build/docker/pinned-wasixcc-assets.tsv";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("cross-platform Git checkout bytes", () => {
  test("all tracked paths are normalized to LF when Git classifies them as text", () => {
    const files = execFileSync("git", ["ls-files", "-z"], {
      cwd: ROOT,
      encoding: "utf8",
    }).split("\0").filter(Boolean);
    const fields = execFileSync("git", ["check-attr", "-z", "--stdin", "text", "eol"], {
      cwd: ROOT,
      encoding: "utf8",
      input: `${files.join("\0")}\0`,
    }).split("\0").filter(Boolean);

    expect(fields).toHaveLength(files.length * 6);
    for (let index = 0; index < fields.length; index += 6) {
      expect(fields[index]).toBe(files[index / 6]);
      expect(fields[index + 1]).toBe("text");
      expect(["auto", "set"]).toContain(fields[index + 2]);
      expect(fields[index + 3]).toBe(files[index / 6]);
      expect(fields[index + 4]).toBe("eol");
      expect(fields[index + 5]).toBe("lf");
    }
  });

  test("core.autocrlf=true preserves the pinned WASIX manifest digest", () => {
    const manifest = Bun.TOML.parse(
      readFileSync(path.join(ROOT, "src/sources/toolchains/wasix.toml"), "utf8"),
    );
    const checkout = mkdtempSync(path.join(tmpdir(), "oliphaunt-autocrlf-checkout-"));
    try {
      const prefix = `${checkout.split(path.sep).join("/")}/`;
      execFileSync("git", [
        "-c",
        "core.autocrlf=true",
        "checkout-index",
        "--force",
        `--prefix=${prefix}`,
        "--",
        WASIX_ASSET_MANIFEST,
      ], { cwd: ROOT });
      const bytes = readFileSync(path.join(checkout, WASIX_ASSET_MANIFEST));
      expect(bytes.includes(13)).toBe(false);
      expect(sha256(bytes)).toBe(manifest.toolchain.assets_manifest_sha256);
    } finally {
      rmSync(checkout, { force: true, recursive: true });
    }
  });
});
