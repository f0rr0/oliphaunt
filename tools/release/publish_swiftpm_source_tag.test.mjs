import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import {
  createSwiftpmManifestCommit,
  createSwiftpmReleaseTree,
  ensureTag,
  preflightSwiftpmSourceTagExactly,
  pushSwiftpmSourceTagExactly,
  SWIFTPM_PUSH_ATTEMPT_TIMEOUT_MS,
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
  const remote = mkdtempSync(path.join(tmpdir(), "oliphaunt-swiftpm-tag-remote-test."));
  try {
    git(root, ["init", "--quiet"]);
    git(remote, ["init", "--quiet", "--bare"]);
    git(root, ["remote", "add", "origin", remote]);
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

    const reservations = [];
    await ensureTag(
      {
        target: releaseCommit,
        manifest: "Package.swift.release",
        includeTrees: ["frozen-tree"],
        push: true,
      },
      {
        reserveContentWrite: ({ label }) => {
          expect(git(root, ["ls-remote", "--tags", "origin", "refs/tags/0.6.0"])).toBe("");
          reservations.push(label);
        },
        root,
        version: "0.6.0",
      },
    );
    expect(reservations).toEqual(["SwiftPM source tag 0.6.0 push"]);
    expect(git(root, ["ls-remote", "--tags", "origin", "refs/tags/0.6.0"])).toContain(tagCommit);

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
    rmSync(remote, { recursive: true, force: true });
  }
});

test("SwiftPM push refuses to start unless pacing leaves two complete bounded attempts", () => {
  let nowMs = 0;
  let gitCalls = 0;
  expect(() => pushSwiftpmSourceTagExactly({
    budget: { deadlineMs: (2 * SWIFTPM_PUSH_ATTEMPT_TIMEOUT_MS), now: () => nowMs },
    gitRunner: () => { gitCalls += 1; return { status: 0, stderr: "", stdout: "" }; },
    reserveContentWrite: () => { nowMs = 1; },
    tag: "0.6.0",
    tagTarget: "a".repeat(40),
  })).toThrow(/requires two complete 60000ms transport intervals after pacing/u);
  expect(gitCalls).toBe(0);
});

test("SwiftPM push reconciles an applied timeout to one exact remote tag", () => {
  const target = "a".repeat(40);
  const calls = [];
  const outcome = pushSwiftpmSourceTagExactly({
    budget: { deadlineMs: 180_000, now: () => 0 },
    gitRunner: (args, options) => {
      calls.push({ args, timeoutMs: options.timeoutMs });
      if (args[0] === "push") {
        return {
          error: Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }),
          status: 1,
          stderr: "",
          stdout: "",
        };
      }
      return { status: 0, stderr: "", stdout: `${target}\trefs/tags/0.6.0` };
    },
    reserveContentWrite: () => {},
    tag: "0.6.0",
    tagTarget: target,
  });
  expect(outcome.reconciledAfterFailure).toBe(true);
  expect(calls.map(({ timeoutMs }) => timeoutMs)).toEqual([60_000, 60_000]);
  expect(calls[0].args).toEqual([
    "push",
    "--porcelain",
    "origin",
    "refs/tags/0.6.0:refs/tags/0.6.0",
  ]);
  expect(calls[1].args).toEqual([
    "ls-remote",
    "--refs",
    "--tags",
    "origin",
    "refs/tags/0.6.0",
  ]);
});

test("SwiftPM push rejects absent and conflicting reconciled remote state", () => {
  const invoke = (remoteOutput) => pushSwiftpmSourceTagExactly({
    budget: { deadlineMs: 180_000, now: () => 0 },
    gitRunner: (args) => args[0] === "push"
      ? { status: 1, stderr: "rejected", stdout: "" }
      : { status: 0, stderr: "", stdout: remoteOutput },
    reserveContentWrite: () => {},
    tag: "0.6.0",
    tagTarget: "a".repeat(40),
  });
  expect(() => invoke("")).toThrow(/is absent after the bounded push attempt/u);
  expect(() => invoke(`${"b".repeat(40)}\trefs/tags/0.6.0`)).toThrow(
    /points at .* not expected release commit/u,
  );
});

test("SwiftPM preflight computes the exact release commit without creating a local tag or writing remotely", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "oliphaunt-swiftpm-preflight-test."));
  const remote = mkdtempSync(path.join(tmpdir(), "oliphaunt-swiftpm-preflight-remote-test."));
  try {
    git(root, ["init", "--quiet"]);
    git(remote, ["init", "--quiet", "--bare"]);
    git(root, ["remote", "add", "origin", remote]);
    git(root, ["config", "user.name", "fixture"]);
    git(root, ["config", "user.email", "fixture@example.invalid"]);
    writeFileSync(path.join(root, "Package.swift"), "// development manifest\n", "utf8");
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
    const tree = createSwiftpmReleaseTree(releaseCommit, manifest, [], { root });
    const expected = createSwiftpmManifestCommit(releaseCommit, tree, "0.6.0", { root });

    await ensureTag({
      target: releaseCommit,
      manifest: "Package.swift.release",
      includeTrees: [],
      preflight: true,
    }, { root, version: "0.6.0" });
    expect(git(root, ["tag", "--list", "0.6.0"])).toBe("");
    expect(git(root, ["ls-remote", "--refs", "--tags", "origin", "refs/tags/0.6.0"])).toBe("");

    git(root, ["push", "--quiet", "origin", `${expected}:refs/tags/0.6.0`]);
    await ensureTag({
      target: releaseCommit,
      manifest: "Package.swift.release",
      includeTrees: [],
      preflight: true,
    }, { root, version: "0.6.0" });
    expect(git(root, ["tag", "--list", "0.6.0"])).toBe("");
    expect(git(root, ["ls-remote", "--refs", "--tags", "origin", "refs/tags/0.6.0"])).toBe(
      `${expected}\trefs/tags/0.6.0`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(remote, { recursive: true, force: true });
  }
});

test("SwiftPM preflight rejects conflicting, malformed, and ambiguous exact remote tag metadata", () => {
  const tagTarget = "a".repeat(40);
  const invoke = (stdout) => preflightSwiftpmSourceTagExactly({
    gitRunner: () => ({ status: 0, stderr: "", stdout }),
    tag: "0.6.0",
    tagTarget,
  });
  expect(() => invoke(`${"b".repeat(40)}\trefs/tags/0.6.0`)).toThrow(
    /points at .* not expected release commit/u,
  );
  expect(() => invoke(`not-a-sha\trefs/tags/0.6.0`)).toThrow(/malformed metadata/u);
  expect(() => invoke(
    `${tagTarget}\trefs/tags/0.6.0\n${tagTarget}\trefs/tags/0.6.0`,
  )).toThrow(/ambiguous result/u);
});

test("SwiftPM preflight and push modes are mutually exclusive", async () => {
  await expect(ensureTag({
    target: "HEAD",
    preflight: true,
    push: true,
  }, { version: "0.6.0" })).rejects.toThrow(/mutually exclusive/u);
});
