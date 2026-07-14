import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import {
  createSwiftpmManifestCommit,
  createSwiftpmReleaseTree,
  ensureTag,
} from "./publish_swiftpm_source_tag.mjs";

function git(root, args, { env = process.env } = {}) {
  const result = spawnSync("git", args, {
    cwd: root,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

test("SwiftPM source tag is deterministic, resumable, and exact-release-tree bound", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "oliphaunt-swiftpm-tag-test."));
  try {
    git(root, ["init", "--quiet"]);
    git(root, ["config", "user.name", "fixture"]);
    git(root, ["config", "user.email", "fixture@example.invalid"]);
    mkdirSync(path.join(root, "Sources"), { recursive: true });
    writeFileSync(path.join(root, "Package.swift"), "// development manifest\n", "utf8");
    writeFileSync(path.join(root, "Sources/Base.swift"), "public let base = true\n", "utf8");
    git(root, ["add", "."]);
    git(root, ["commit", "--quiet", "-m", "release source"], {
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: "1700000000 +0000",
        GIT_COMMITTER_DATE: "1700000000 +0000",
      },
    });
    const releaseCommit = git(root, ["rev-parse", "HEAD^{commit}"]);

    const manifest = [
      "// swift-tools-version: 6.0",
      "import PackageDescription",
      "let package = Package(name: \"Oliphaunt\", targets: [",
      "  .binaryTarget(name: \"COliphaunt\", url: \"https://example.invalid/liboliphaunt-native-v0.1.0/apple-spm-xcframework.zip\", checksum: \"abc\")",
      "])",
      "",
    ].join("\n");
    writeFileSync(path.join(root, "Package.swift.release"), manifest, "utf8");
    mkdirSync(path.join(root, "frozen-tree/generated/swiftpm"), { recursive: true });
    writeFileSync(
      path.join(root, "frozen-tree/generated/swiftpm/Frozen.swift"),
      "public let frozen = true\n",
      "utf8",
    );

    const tree = createSwiftpmReleaseTree(
      releaseCommit,
      manifest,
      ["frozen-tree"],
      { root },
    );
    const firstSyntheticCommit = createSwiftpmManifestCommit(
      releaseCommit,
      tree,
      "0.6.0",
      {
        root,
        ambientEnv: {
          ...process.env,
          GIT_AUTHOR_DATE: "946684800 +0000",
          GIT_COMMITTER_DATE: "946684800 +0000",
        },
      },
    );
    const secondSyntheticCommit = createSwiftpmManifestCommit(
      releaseCommit,
      tree,
      "0.6.0",
      {
        root,
        ambientEnv: {
          ...process.env,
          GIT_AUTHOR_DATE: "1893456000 +0000",
          GIT_COMMITTER_DATE: "1893456000 +0000",
        },
      },
    );
    expect(secondSyntheticCommit).toBe(firstSyntheticCommit);

    await ensureTag(
      {
        target: releaseCommit,
        manifest: "Package.swift.release",
        includeTrees: ["frozen-tree"],
        push: false,
      },
      { root, version: "0.6.0" },
    );
    const tagCommit = git(root, ["rev-parse", "refs/tags/0.6.0^{commit}"]);
    expect(tagCommit).toBe(firstSyntheticCommit);
    expect(git(root, ["rev-parse", `${tagCommit}^`])).toBe(releaseCommit);
    expect(git(root, ["rev-parse", `${tagCommit}^{tree}`])).toBe(tree);
    expect(git(root, ["show", `${tagCommit}:Package.swift`])).toBe(manifest.trim());
    expect(git(root, ["show", `${tagCommit}:Sources/Base.swift`])).toBe("public let base = true");
    expect(git(root, ["show", `${tagCommit}:generated/swiftpm/Frozen.swift`])).toBe(
      "public let frozen = true",
    );

    await ensureTag(
      {
        target: releaseCommit,
        manifest: "Package.swift.release",
        includeTrees: ["frozen-tree"],
        push: false,
      },
      { root, version: "0.6.0" },
    );
    expect(git(root, ["rev-parse", "refs/tags/0.6.0^{commit}"])).toBe(tagCommit);

    writeFileSync(
      path.join(root, "frozen-tree/generated/swiftpm/Frozen.swift"),
      "public let frozen = false\n",
      "utf8",
    );
    const changedTree = createSwiftpmReleaseTree(
      releaseCommit,
      readFileSync(path.join(root, "Package.swift.release"), "utf8"),
      ["frozen-tree"],
      { root },
    );
    expect(changedTree).not.toBe(tree);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
