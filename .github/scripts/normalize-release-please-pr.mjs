#!/usr/bin/env bun

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import process from "node:process";

const TOOL = "normalize-release-please-pr.mjs";
const CANONICAL_REPOSITORY = "f0rr0/oliphaunt";
const MAIN_BRANCH = "main";
const RELEASE_BRANCH = "release-please--branches--main";
const FULL_SHA = /^[0-9a-f]{40}$/u;
const POSITIVE_INTEGER = /^[1-9][0-9]*$/u;
const SAFE_REMOTE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

function fail(message) {
  throw new Error(`${TOOL}: ${message}`);
}

function run(command, args, { cwd = process.cwd(), check = true } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error !== undefined) fail(`${command} failed: ${result.error.message}`);
  if (check && result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    fail(`${command} ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`);
  }
  return result;
}

function git(args, options = {}) {
  return run("git", args, options);
}

function gitText(args, options = {}) {
  return git(args, options).stdout.trimEnd();
}

function parseArgs(argv) {
  const command = argv[0];
  if (!new Set(["normalize", "push"]).has(command)) {
    fail("usage: normalize-release-please-pr.mjs <normalize|push> --pr-number N --observed-pr-number N --base main --head release-please--branches--main --head-sha SHA --head-repository f0rr0/oliphaunt --cross-repository false --state OPEN --title TITLE --main-sha SHA [--remote origin]");
  }
  const values = { command, remote: "origin" };
  const known = new Set([
    "--pr-number",
    "--observed-pr-number",
    "--base",
    "--head",
    "--head-sha",
    "--head-repository",
    "--cross-repository",
    "--state",
    "--title",
    "--main-sha",
    "--remote",
  ]);
  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!known.has(flag) || value === undefined) fail(`unknown or incomplete argument ${flag ?? "<missing>"}`);
    const key = flag.slice(2).replaceAll(/-([a-z])/gu, (_match, letter) => letter.toUpperCase());
    if (Object.hasOwn(values, key) && key !== "remote") fail(`${flag} must be supplied exactly once`);
    values[key] = value;
  }
  for (const key of [
    "prNumber",
    "observedPrNumber",
    "base",
    "head",
    "headSha",
    "headRepository",
    "crossRepository",
    "state",
    "title",
    "mainSha",
  ]) {
    if (typeof values[key] !== "string" || values[key].length === 0) fail(`--${key.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`)} is required`);
  }
  return values;
}

function expectedTitle(repo, base) {
  let config;
  try {
    config = JSON.parse(readFileSync(`${repo}/release-please-config.json`, "utf8"));
  } catch (cause) {
    fail(`release-please-config.json is unreadable: ${cause.message}`);
  }
  const pattern = config?.["group-pull-request-title-pattern"];
  if (typeof pattern !== "string" || pattern.length === 0) {
    fail("release-please-config.json must define group-pull-request-title-pattern");
  }
  const title = pattern.replaceAll("${branch}", base);
  if (title.includes("${") || !/^chore\(release\): .+/u.test(title) || /[\r\n]/u.test(title)) {
    fail("group-pull-request-title-pattern must render one conventional release title using only ${branch}");
  }
  return title;
}

function validateIdentity(args, repo) {
  if (!POSITIVE_INTEGER.test(args.prNumber) || !POSITIVE_INTEGER.test(args.observedPrNumber)) {
    fail("release PR numbers must be positive integers");
  }
  if (args.prNumber !== args.observedPrNumber) {
    fail(`release PR identity changed: requested #${args.prNumber}, observed #${args.observedPrNumber}`);
  }
  if (args.base !== MAIN_BRANCH) fail(`release PR base must be ${MAIN_BRANCH}, got ${args.base}`);
  if (args.head !== RELEASE_BRANCH) fail(`release PR head must be ${RELEASE_BRANCH}, got ${args.head}`);
  if (args.headRepository !== CANONICAL_REPOSITORY) {
    fail(`release PR head repository must be ${CANONICAL_REPOSITORY}, got ${args.headRepository}`);
  }
  if (args.crossRepository !== "false") fail("release PR must not be cross-repository");
  if (args.state !== "OPEN") fail(`release PR must be OPEN, got ${args.state}`);
  if (!FULL_SHA.test(args.headSha) || !FULL_SHA.test(args.mainSha)) {
    fail("release PR head and main identities must be lowercase full commit SHAs");
  }
  if (!SAFE_REMOTE.test(args.remote)) fail(`unsafe Git remote name ${JSON.stringify(args.remote)}`);
  const title = expectedTitle(repo, args.base);
  if (args.title !== title) fail(`release PR title must be ${JSON.stringify(title)}, got ${JSON.stringify(args.title)}`);
  return title;
}

function requireClean(repo) {
  const status = gitText(["status", "--porcelain", "--untracked-files=all"], { cwd: repo });
  if (status !== "") fail(`working tree must be clean before release PR normalization or push: ${status}`);
}

function requireCommit(repo, ref, expected, context) {
  const actual = gitText(["rev-parse", "--verify", `${ref}^{commit}`], { cwd: repo });
  if (actual !== expected) fail(`${context} is ${actual}, expected ${expected}`);
  return actual;
}

function releaseRangeShape(repo, mainSha, headRef, title) {
  if (git(["merge-base", "--is-ancestor", mainSha, headRef], { cwd: repo, check: false }).status !== 0) {
    fail(`release PR head is not descended from exact main ${mainSha}`);
  }
  const countText = gitText(["rev-list", "--count", `${mainSha}..${headRef}`], { cwd: repo });
  const count = Number(countText);
  if (!Number.isSafeInteger(count) || count < 1) fail("release PR must contain at least one commit above exact main");
  const merges = gitText(["rev-list", "--merges", `${mainSha}..${headRef}`], { cwd: repo });
  if (merges !== "") fail("release PR history must be linear and contain no merge commits");
  const subjects = gitText(["log", "--format=%s", `${mainSha}..${headRef}`], { cwd: repo }).split(/\r?\n/u);
  if (subjects.length !== count || subjects.some((subject) => subject !== title)) {
    fail(`every generated release PR chunk must use exact title ${JSON.stringify(title)}`);
  }
  const mainTree = gitText(["rev-parse", `${mainSha}^{tree}`], { cwd: repo });
  const headTree = gitText(["rev-parse", `${headRef}^{tree}`], { cwd: repo });
  if (mainTree === headTree) fail("release PR tree must differ from exact main");
  return { count, headTree };
}

function normalize(args, repo) {
  const title = validateIdentity(args, repo);
  requireClean(repo);
  const mainRemoteRef = `refs/remotes/${args.remote}/${MAIN_BRANCH}`;
  const headRemoteRef = `refs/remotes/${args.remote}/${RELEASE_BRANCH}`;
  git(["fetch", "--no-tags", args.remote, `+refs/heads/${MAIN_BRANCH}:${mainRemoteRef}`], { cwd: repo });
  git(["fetch", "--no-tags", args.remote, `+refs/heads/${RELEASE_BRANCH}:${headRemoteRef}`], { cwd: repo });
  requireCommit(repo, mainRemoteRef, args.mainSha, "current remote main");
  requireCommit(repo, headRemoteRef, args.headSha, "inspected release PR head");
  const shape = releaseRangeShape(repo, args.mainSha, headRemoteRef, title);

  git(["switch", "-C", RELEASE_BRANCH, headRemoteRef], { cwd: repo });
  const directParent = gitText(["rev-parse", "HEAD^"], { cwd: repo, check: false });
  let normalized = false;
  if (shape.count !== 1 || directParent !== args.mainSha) {
    git(["reset", "--soft", args.mainSha], { cwd: repo });
    if (git(["diff", "--cached", "--quiet", "--exit-code"], { cwd: repo, check: false }).status === 0) {
      fail("release PR normalization produced no staged tree change");
    }
    git([
      "-c", "user.name=oliphaunt-release-bot",
      "-c", "user.email=oliphaunt-release-bot@users.noreply.github.com",
      "commit", "-m", title,
    ], { cwd: repo });
    normalized = true;
  }

  const localShape = releaseRangeShape(repo, args.mainSha, "HEAD", title);
  if (localShape.count !== 1 || gitText(["rev-parse", "HEAD^"], { cwd: repo }) !== args.mainSha) {
    fail("normalized release PR must be exactly one commit above exact main");
  }
  if (localShape.headTree !== shape.headTree) fail("normalization changed the generated release PR tree");
  requireClean(repo);
  console.log(`release PR #${args.prNumber} checked out at ${gitText(["rev-parse", "HEAD"], { cwd: repo })}; normalized=${normalized}`);
}

function remoteRefSha(repo, remote, ref) {
  const output = gitText(["ls-remote", "--heads", remote, ref], { cwd: repo });
  const rows = output.split(/\r?\n/u).filter(Boolean);
  if (rows.length !== 1) fail(`expected exactly one remote ref ${ref}; found ${rows.length}`);
  const [sha, observedRef, ...extra] = rows[0].split(/\s+/u);
  if (!FULL_SHA.test(sha) || observedRef !== ref || extra.length !== 0) fail(`remote ref ${ref} returned malformed metadata`);
  return sha;
}

function push(args, repo) {
  const title = validateIdentity(args, repo);
  requireClean(repo);
  const branch = gitText(["branch", "--show-current"], { cwd: repo });
  if (branch !== RELEASE_BRANCH) fail(`local branch must be ${RELEASE_BRANCH}, got ${branch || "<detached>"}`);
  const localShape = releaseRangeShape(repo, args.mainSha, "HEAD", title);
  if (localShape.count !== 1 || gitText(["rev-parse", "HEAD^"], { cwd: repo }) !== args.mainSha) {
    fail("release PR push requires exactly one local commit above exact main");
  }
  const remoteMain = remoteRefSha(repo, args.remote, `refs/heads/${MAIN_BRANCH}`);
  if (remoteMain !== args.mainSha) fail(`main moved before release PR push: ${remoteMain}, expected ${args.mainSha}`);
  const localHead = gitText(["rev-parse", "HEAD"], { cwd: repo });
  git([
    "push",
    `--force-with-lease=refs/heads/${RELEASE_BRANCH}:${args.headSha}`,
    args.remote,
    `HEAD:refs/heads/${RELEASE_BRANCH}`,
  ], { cwd: repo });
  const remoteHead = remoteRefSha(repo, args.remote, `refs/heads/${RELEASE_BRANCH}`);
  if (remoteHead !== localHead) fail(`release PR push produced ${remoteHead}, expected ${localHead}`);
  console.log(`release PR #${args.prNumber} pushed as one exact release commit ${localHead}`);
}

export function main(argv, { repo = process.cwd() } = {}) {
  const args = parseArgs(argv);
  if (args.command === "normalize") normalize(args, repo);
  else push(args, repo);
}

if (import.meta.main) {
  try {
    main(Bun.argv.slice(2));
  } catch (cause) {
    console.error(cause instanceof Error ? cause.message : String(cause));
    process.exit(1);
  }
}
