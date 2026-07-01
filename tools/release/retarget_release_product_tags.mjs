#!/usr/bin/env bun
import { spawnSync } from "node:child_process";

import { currentProductVersionSync } from "./release-artifact-targets.mjs";
import { compareText, ROOT } from "./release-graph.mjs";

const TOOL = "retarget_release_product_tags.mjs";

function fail(message) {
  console.error(`${TOOL}: ${message}`);
  process.exit(1);
}

function usage() {
  fail(
    "usage: tools/release/retarget_release_product_tags.mjs --products-json <json-array> --target <commitish> [--repo OWNER/NAME]",
  );
}

function valueArg(argv, index) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    usage();
  }
  return value;
}

function parseArgs(argv) {
  const args = {
    productsJson: "",
    repo: process.env.GITHUB_REPOSITORY || "",
    target: process.env.GITHUB_SHA || "HEAD",
  };
  for (let index = 0; index < argv.length; ) {
    const arg = argv[index];
    if (arg === "--products-json") {
      args.productsJson = valueArg(argv, index);
      index += 2;
    } else if (arg === "--repo") {
      args.repo = valueArg(argv, index);
      index += 2;
    } else if (arg === "--target") {
      args.target = valueArg(argv, index);
      index += 2;
    } else {
      usage();
    }
  }
  if (!args.productsJson || !args.repo || !args.target) {
    usage();
  }
  return args;
}

function parseProducts(productsJson) {
  let products;
  try {
    products = JSON.parse(productsJson);
  } catch (error) {
    fail(`--products-json must be valid JSON: ${error.message}`);
  }
  if (
    !Array.isArray(products) ||
    products.length === 0 ||
    !products.every((product) => typeof product === "string" && product)
  ) {
    fail("--products-json must be a non-empty JSON string array");
  }
  return [...new Set(products)].sort(compareText);
}

function run(command, args, { check = true } = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error !== undefined) {
    fail(`${command} failed to start: ${result.error.message}`);
  }
  if (check && result.status !== 0) {
    const stderr = (result.stderr || "").trim();
    fail(`${command} ${args.join(" ")} failed${stderr ? `: ${stderr}` : ""}`);
  }
  return {
    status: result.status ?? 1,
    stdout: (result.stdout || "").trim(),
    stderr: (result.stderr || "").trim(),
  };
}

function git(args, options = {}) {
  return run("git", args, options);
}

function gh(args, options = {}) {
  return run("gh", args, options);
}

function targetCommit(target) {
  return git(["rev-parse", `${target}^{commit}`]).stdout;
}

function remoteTagObject(tag) {
  const output = git(["ls-remote", "--tags", "origin", `refs/tags/${tag}`]).stdout;
  const lines = output.split(/\r?\n/u).filter(Boolean);
  if (lines.length !== 1) {
    fail(`${tag} must exist exactly once on origin before retargeting`);
  }
  const [object, ref] = lines[0].split(/\s+/u);
  if (ref !== `refs/tags/${tag}` || !/^[0-9a-f]{40}$/iu.test(object)) {
    fail(`origin returned malformed tag ref for ${tag}: ${JSON.stringify(lines[0])}`);
  }
  return object;
}

function refreshTag(tag) {
  git(["fetch", "--force", "--no-tags", "origin", `refs/tags/${tag}:refs/tags/${tag}`]);
}

function tagCommit(tag) {
  return git(["rev-parse", "--verify", `${tag}^{commit}`]).stdout;
}

function isAncestor(ancestor, descendant) {
  return git(["merge-base", "--is-ancestor", ancestor, descendant], { check: false }).status === 0;
}

function releaseMetadata(tag, repo) {
  const output = gh(["release", "view", tag, "--repo", repo, "--json", "assets,tagName,targetCommitish"]).stdout;
  let data;
  try {
    data = JSON.parse(output);
  } catch (error) {
    fail(`gh release view ${tag} returned malformed JSON: ${error.message}`);
  }
  if (
    data === null ||
    Array.isArray(data) ||
    typeof data !== "object" ||
    data.tagName !== tag ||
    !Array.isArray(data.assets)
  ) {
    fail(`GitHub release ${tag} returned malformed release metadata`);
  }
  return data;
}

function tagForProduct(product) {
  return `${product}-v${currentProductVersionSync(product, TOOL)}`;
}

function setupGitAuth() {
  gh(["auth", "setup-git"]);
}

function retargetTag({ product, tag, repo, target }) {
  const remoteObject = remoteTagObject(tag);
  refreshTag(tag);
  const existingCommit = tagCommit(tag);
  const metadata = releaseMetadata(tag, repo);
  if (metadata.assets.length !== 0) {
    fail(
      `${tag} already has ${metadata.assets.length} GitHub release asset(s); ` +
        "refusing to move a published release tag",
    );
  }
  if (existingCommit === target) {
    console.log(`${tag} already points at ${target}`);
  } else {
    if (!isAncestor(existingCommit, target)) {
      fail(`${tag} points at ${existingCommit}, which is not an ancestor of release commit ${target}`);
    }
    git(["tag", "--force", tag, target]);
    git([
      "push",
      `--force-with-lease=refs/tags/${tag}:${remoteObject}`,
      "origin",
      `refs/tags/${tag}:refs/tags/${tag}`,
    ]);
    console.log(`${product}: moved ${tag} from ${existingCommit} to ${target}`);
  }
  if (metadata.targetCommitish !== target) {
    gh(["release", "edit", tag, "--repo", repo, "--target", target, "--verify-tag"]);
    console.log(`${product}: updated GitHub release ${tag} target to ${target}`);
  }
}

const args = parseArgs(Bun.argv.slice(2));
const products = parseProducts(args.productsJson);
const target = targetCommit(args.target);
setupGitAuth();
for (const product of products) {
  retargetTag({ product, tag: tagForProduct(product), repo: args.repo, target });
}
console.log(`retargeted ${products.length} release product tag(s) to ${target}`);
