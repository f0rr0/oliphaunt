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

function git(args, { env = process.env, check = true, input = undefined } = {}) {
  const result = spawnSync("git", args, {
    cwd: ROOT,
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

function commitForRef(ref) {
  return git(["rev-parse", `${ref}^{commit}`]).stdout;
}

function tagRef(tag) {
  return `refs/tags/${tag}`;
}

function tagCommit(tag) {
  const result = git(["rev-parse", "--verify", "--quiet", `${tagRef(tag)}^{commit}`], {
    check: false,
  });
  return result.status === 0 ? result.stdout : null;
}

async function swiftpmTag() {
  const version = await currentVersion("oliphaunt-swift");
  if (!SEMVER_RE.test(version)) {
    fail(`SwiftPM requires a semantic version tag; oliphaunt-swift version is ${JSON.stringify(version)}`);
  }
  return version;
}

function commitParents(commit) {
  const parts = git(["rev-list", "--parents", "-n", "1", commit]).stdout.split(/\s+/u).filter(Boolean);
  return parts.slice(1);
}

function treeForCommit(commit) {
  return git(["rev-parse", `${commit}^{tree}`]).stdout;
}

function syntheticCommitMatches(commit, parent, expectedTree) {
  const parents = commitParents(commit);
  return parents.length === 1 && parents[0] === parent && treeForCommit(commit) === expectedTree;
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

function addBlobToIndex(env, indexPath, data) {
  const result = git(["hash-object", "-w", "--stdin"], { env, input: data });
  git(["update-index", "--add", "--cacheinfo", `100644,${result.stdout},${indexPath}`], { env });
}

function createSwiftpmReleaseTree(targetCommit, manifest, includeTrees) {
  const baseTree = treeForCommit(targetCommit);
  const tempRoot = mkdtempSync(path.join(tmpdir(), "oliphaunt-swiftpm-index."));
  try {
    const env = { ...process.env, GIT_INDEX_FILE: path.join(tempRoot, "index") };
    git(["read-tree", baseTree], { env });
    addBlobToIndex(env, "Package.swift", manifest);
    for (const includeTree of includeTrees) {
      const root = path.resolve(ROOT, includeTree);
      if (!statSync(root, { throwIfNoEntry: false })?.isDirectory()) {
        fail(`SwiftPM generated release tree does not exist: ${includeTree}`);
      }
      for (const file of iterTreeFiles(root)) {
        const relative = path.relative(root, file).split(path.sep).join("/");
        if (relative === "Package.swift" || relative.startsWith(".git/") || relative.includes("/.git/")) {
          fail(`SwiftPM generated release tree contains forbidden path: ${relative}`);
        }
        addBlobToIndex(env, relative, readFileSync(file));
      }
    }
    return git(["write-tree"], { env }).stdout;
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

function createSwiftpmManifestCommit(targetCommit, tree, version) {
  return git([
    "commit-tree",
    tree,
    "-p",
    targetCommit,
    "-m",
    `Release Oliphaunt Swift ${version} SwiftPM manifest`,
  ]).stdout;
}

async function ensureTag({ target, manifest, includeTrees, push }) {
  const tag = await swiftpmTag();
  const version = await currentVersion("oliphaunt-swift");
  const targetCommit = commitForRef(target);
  let tagTarget = targetCommit;
  let expectedTree = treeForCommit(targetCommit);
  let manifestText = null;

  if (manifest !== undefined) {
    manifestText = readFileSync(path.resolve(ROOT, manifest), "utf8");
    if (!manifestText.includes("binaryTarget(") || !manifestText.includes("liboliphaunt-native-v")) {
      fail("SwiftPM release manifest must contain a checksum-pinned liboliphaunt binaryTarget");
    }
    expectedTree = createSwiftpmReleaseTree(targetCommit, manifestText, includeTrees);
    tagTarget = createSwiftpmManifestCommit(targetCommit, expectedTree, version);
  }

  const existing = tagCommit(tag);
  if (existing !== null) {
    if (manifestText !== null && syntheticCommitMatches(existing, targetCommit, expectedTree)) {
      console.log(`SwiftPM version tag ${tag} already points at a release manifest commit for ${targetCommit}`);
      tagTarget = existing;
    } else if (existing !== tagTarget) {
      fail(`SwiftPM version tag ${tag} already points at ${existing}, not expected SwiftPM release commit ${tagTarget}`);
    } else {
      console.log(`SwiftPM version tag ${tag} already points at ${tagTarget}`);
    }
  } else {
    git(["tag", tag, tagTarget]);
    console.log(`created SwiftPM version tag ${tag} at ${tagTarget}`);
  }

  if (push) {
    git(["push", "origin", tagRef(tag)]);
    console.log(`pushed SwiftPM version tag ${tag} to origin`);
  }
  return tag;
}

await ensureTag(parseArgs(Bun.argv.slice(2)));
