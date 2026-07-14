#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { currentVersion } from "./product-version.mjs";

const ROOT = path.resolve(import.meta.dir, "../..");
const SEMVER_RE = /^(0|[1-9][0-9]*)[.](0|[1-9][0-9]*)[.](0|[1-9][0-9]*)(?:[-+][0-9A-Za-z.-]+)?$/u;
const FIRST_OLIPHAUNT_SWIFTPM_VERSION = [0, 6, 0];
const RELEASE_BOT_NAME = "oliphaunt-release-bot";
const RELEASE_BOT_EMAIL = "oliphaunt-release-bot@users.noreply.github.com";
const decoder = new TextDecoder();

function fail(message) {
  console.error(`publish_swiftpm_source_tag.mjs: ${message}`);
  process.exit(1);
}

function usage(status = 1) {
  const message =
    "usage: tools/release/publish_swiftpm_source_tag.mjs [--target COMMITISH] [--manifest PACKAGE_SWIFT] [--include-tree TREE]... [--push]";
  if (status === 0) {
    console.log(message);
    process.exit(0);
  }
  fail(message);
}

function valueArg(argv, index, name) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    fail(`${name} requires a value`);
  }
  return value;
}

function parseArgs(argv) {
  const args = {
    target: process.env.GITHUB_SHA || "HEAD",
    manifest: undefined,
    includeTrees: [],
    push: false,
  };
  for (let index = 0; index < argv.length; ) {
    const arg = argv[index];
    if (arg === "--target") {
      args.target = valueArg(argv, index, arg);
      index += 2;
    } else if (arg === "--manifest") {
      args.manifest = valueArg(argv, index, arg);
      index += 2;
    } else if (arg === "--include-tree") {
      args.includeTrees.push(valueArg(argv, index, arg));
      index += 2;
    } else if (arg === "--push") {
      args.push = true;
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      usage(0);
    } else {
      usage();
    }
  }
  if (!args.target) {
    fail("--target must not be empty");
  }
  return args;
}

function git(args, { root = ROOT, env = process.env, check = true, input = undefined } = {}) {
  const result = spawnSync("git", args, {
    cwd: root,
    env,
    input,
    encoding: input instanceof Buffer ? "buffer" : "utf8",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (check && result.status !== 0) {
    const stderr = Buffer.isBuffer(result.stderr)
      ? decoder.decode(result.stderr).trim()
      : String(result.stderr).trim();
    fail(`git ${args.join(" ")} failed${stderr ? `: ${stderr}` : ""}`);
  }
  const stdout = Buffer.isBuffer(result.stdout)
    ? decoder.decode(result.stdout)
    : String(result.stdout);
  return {
    status: result.status ?? 0,
    stdout: stdout.trim(),
  };
}

function commitForRef(ref, root) {
  return git(["rev-parse", `${ref}^{commit}`], { root }).stdout;
}

function tagRef(tag) {
  return `refs/tags/${tag}`;
}

function tagCommit(tag, root) {
  const result = git(["rev-parse", "--verify", "--quiet", `${tagRef(tag)}^{commit}`], {
    root,
    check: false,
  });
  return result.status === 0 ? result.stdout : null;
}

function stableVersionCore(version) {
  const match = SEMVER_RE.exec(version);
  return match === null ? null : match.slice(1, 4).map(Number);
}

function compareVersionCore(left, right) {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return left[index] - right[index];
    }
  }
  return 0;
}

async function swiftpmTag(versionOverride) {
  const version = versionOverride ?? await currentVersion("oliphaunt-swift");
  if (!SEMVER_RE.test(version)) {
    fail(`SwiftPM requires a semantic version tag; oliphaunt-swift version is ${JSON.stringify(version)}`);
  }
  if (compareVersionCore(stableVersionCore(version), FIRST_OLIPHAUNT_SWIFTPM_VERSION) < 0) {
    fail(
      `SwiftPM version tag ${version} collides with the legacy unscoped tag range; ` +
        "the first Oliphaunt SwiftPM version is 0.6.0",
    );
  }
  return version;
}

function commitParents(commit, root) {
  const parts = git(["rev-list", "--parents", "-n", "1", commit], { root }).stdout.split(/\s+/u).filter(Boolean);
  return parts.slice(1);
}

function treeForCommit(commit, root) {
  return git(["rev-parse", `${commit}^{tree}`], { root }).stdout;
}

function syntheticCommitMatches(commit, parent, expectedTree, root) {
  const parents = commitParents(commit, root);
  return parents.length === 1 && parents[0] === parent && treeForCommit(commit, root) === expectedTree;
}

function iterTreeFiles(root) {
  const files = [];
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(file);
      } else if (entry.isFile()) {
        files.push(file);
      } else {
        fail(`SwiftPM generated release tree contains unsupported file type: ${file}`);
      }
    }
  }
  visit(root);
  return files.sort();
}

function addBlobToIndex(root, env, indexPath, data) {
  const result = git(["hash-object", "-w", "--stdin"], { root, env, input: data });
  git(["update-index", "--add", "--cacheinfo", `100644,${result.stdout},${indexPath}`], { root, env });
}

export function createSwiftpmReleaseTree(targetCommit, manifest, includeTrees, { root = ROOT } = {}) {
  const baseTree = treeForCommit(targetCommit, root);
  const tempRoot = mkdtempSync(path.join(tmpdir(), "oliphaunt-swiftpm-index."));
  try {
    const env = { ...process.env, GIT_INDEX_FILE: path.join(tempRoot, "index") };
    git(["read-tree", baseTree], { root, env });
    addBlobToIndex(root, env, "Package.swift", manifest);
    for (const includeTree of includeTrees) {
      const includeRoot = path.resolve(root, includeTree);
      if (!statSync(includeRoot, { throwIfNoEntry: false })?.isDirectory()) {
        fail(`SwiftPM generated release tree does not exist: ${includeTree}`);
      }
      for (const file of iterTreeFiles(includeRoot)) {
        const relative = path.relative(includeRoot, file).split(path.sep).join("/");
        if (relative === "Package.swift" || relative.startsWith(".git/") || relative.includes("/.git/")) {
          fail(`SwiftPM generated release tree contains forbidden path: ${relative}`);
        }
        addBlobToIndex(root, env, relative, readFileSync(file));
      }
    }
    return git(["write-tree"], { root, env }).stdout;
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

function commitTimestamp(commit, root) {
  const timestamp = git(["show", "-s", "--format=%ct", commit], { root }).stdout;
  if (!/^[0-9]+$/u.test(timestamp)) {
    fail(`could not derive a deterministic timestamp from release commit ${commit}`);
  }
  return `${timestamp} +0000`;
}

export function createSwiftpmManifestCommit(
  targetCommit,
  tree,
  version,
  { root = ROOT, ambientEnv = process.env } = {},
) {
  const date = commitTimestamp(targetCommit, root);
  const env = {
    ...ambientEnv,
    GIT_AUTHOR_NAME: RELEASE_BOT_NAME,
    GIT_AUTHOR_EMAIL: RELEASE_BOT_EMAIL,
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_NAME: RELEASE_BOT_NAME,
    GIT_COMMITTER_EMAIL: RELEASE_BOT_EMAIL,
    GIT_COMMITTER_DATE: date,
  };
  return git([
    "commit-tree",
    tree,
    "-p",
    targetCommit,
    "-m",
    `Release Oliphaunt Swift ${version} SwiftPM manifest`,
  ], { root, env }).stdout;
}

export async function ensureTag(
  { target, manifest, includeTrees, push },
  { root = ROOT, version: versionOverride } = {},
) {
  const version = await swiftpmTag(versionOverride);
  const tag = version;
  const targetCommit = commitForRef(target, root);
  let tagTarget = targetCommit;
  let expectedTree = treeForCommit(targetCommit, root);
  let manifestText = null;

  if (manifest !== undefined) {
    manifestText = readFileSync(path.resolve(root, manifest), "utf8");
    if (!manifestText.includes("binaryTarget(") || !manifestText.includes("liboliphaunt-native-v")) {
      fail("SwiftPM release manifest must contain a checksum-pinned liboliphaunt binaryTarget");
    }
    expectedTree = createSwiftpmReleaseTree(targetCommit, manifestText, includeTrees, { root });
    tagTarget = createSwiftpmManifestCommit(targetCommit, expectedTree, version, { root });
  }

  const existing = tagCommit(tag, root);
  if (existing !== null) {
    if (manifestText !== null && syntheticCommitMatches(existing, targetCommit, expectedTree, root)) {
      console.log(`SwiftPM version tag ${tag} already points at a release manifest commit for ${targetCommit}`);
      tagTarget = existing;
    } else if (existing !== tagTarget) {
      fail(`SwiftPM version tag ${tag} already points at ${existing}, not expected SwiftPM release commit ${tagTarget}`);
    } else {
      console.log(`SwiftPM version tag ${tag} already points at ${tagTarget}`);
    }
  } else {
    git(["tag", tag, tagTarget], { root });
    console.log(`created SwiftPM version tag ${tag} at ${tagTarget}`);
  }

  if (push) {
    git(["push", "origin", tagRef(tag)], { root });
    console.log(`pushed SwiftPM version tag ${tag} to origin`);
  }
  return tag;
}

if (import.meta.main) {
  await ensureTag(parseArgs(Bun.argv.slice(2)));
}
