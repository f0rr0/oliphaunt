#!/usr/bin/env bun

import assert from "node:assert/strict";
import { spawnSync } from "../test/fd-backed-spawn-sync.mjs";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const SCRIPT = path.resolve(".github/scripts/normalize-release-please-pr.mjs");
const BRANCH = "release-please--branches--main";
const TITLE = "chore(release): prepare main releases";

function run(command, args, { cwd, check = true } = {}) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (check) assert.equal(result.status, 0, `${command} ${args.join(" ")}\n${result.stderr}`);
  return result;
}

function git(cwd, args, options = {}) {
  return run("git", args, { cwd, ...options });
}

function gitText(cwd, args) {
  return git(cwd, args).stdout.trim();
}

function commitFiles(cwd, prefix, count) {
  for (let index = 1; index <= count; index += 1) {
    const file = `${prefix}-${String(index).padStart(3, "0")}.txt`;
    writeFileSync(path.join(cwd, file), `${file}\n`);
  }
  git(cwd, ["add", "."]);
  git(cwd, ["commit", "-m", TITLE]);
  return gitText(cwd, ["rev-parse", "HEAD"]);
}

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "oliphaunt-release-pr-normalize-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const remote = path.join(root, "remote.git");
  const seed = path.join(root, "seed");
  const work = path.join(root, "work");
  mkdirSync(seed);
  git(root, ["init", "--bare", remote]);
  git(seed, ["init"]);
  git(seed, ["config", "user.name", "Release Test"]);
  git(seed, ["config", "user.email", "release-test@example.invalid"]);
  writeFileSync(path.join(seed, "release-please-config.json"), `${JSON.stringify({
    "group-pull-request-title-pattern": "chore(release): prepare ${branch} releases",
  }, null, 2)}\n`);
  writeFileSync(path.join(seed, "seed.txt"), "main\n");
  git(seed, ["add", "."]);
  git(seed, ["commit", "-m", "feat: introduce oliphaunt"]);
  git(seed, ["branch", "-M", "main"]);
  git(seed, ["remote", "add", "origin", remote]);
  git(seed, ["push", "-u", "origin", "main"]);
  git(remote, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  const mainSha = gitText(seed, ["rev-parse", "HEAD"]);
  git(seed, ["switch", "-c", BRANCH]);
  const firstChunk = commitFiles(seed, "first", 100);
  const secondChunk = commitFiles(seed, "second", 35);
  git(seed, ["push", "-u", "origin", BRANCH]);
  const headSha = secondChunk;
  git(root, ["clone", remote, work]);
  return { root, remote, seed, work, mainSha, headSha, firstChunk, secondChunk };
}

function identity(f, overrides = {}) {
  const values = {
    prNumber: "123",
    observedPrNumber: "123",
    base: "main",
    head: BRANCH,
    headSha: f.headSha,
    headRepository: "f0rr0/oliphaunt",
    crossRepository: "false",
    state: "OPEN",
    title: TITLE,
    mainSha: f.mainSha,
    remote: "origin",
    ...overrides,
  };
  return [
    "--pr-number", values.prNumber,
    "--observed-pr-number", values.observedPrNumber,
    "--base", values.base,
    "--head", values.head,
    "--head-sha", values.headSha,
    "--head-repository", values.headRepository,
    "--cross-repository", values.crossRepository,
    "--state", values.state,
    "--title", values.title,
    "--main-sha", values.mainSha,
    "--remote", values.remote,
  ];
}

function invoke(f, command, overrides = {}) {
  return run(process.execPath, [SCRIPT, command, ...identity(f, overrides)], { cwd: f.work, check: false });
}

test("normalizes the historical 100+35 file Release Please shape to one tree-identical exact-parent commit and pushes it", (t) => {
  const f = fixture(t);
  assert.equal(gitText(f.seed, ["diff-tree", "--no-commit-id", "--name-only", "-r", f.firstChunk]).split("\n").length, 100);
  assert.equal(gitText(f.seed, ["diff-tree", "--no-commit-id", "--name-only", "-r", f.secondChunk]).split("\n").length, 35);
  const generatedTree = gitText(f.seed, ["rev-parse", `${f.headSha}^{tree}`]);

  const normalized = invoke(f, "normalize");
  assert.equal(normalized.status, 0, normalized.stderr);
  assert.match(normalized.stdout, /normalized=true/u);
  assert.equal(gitText(f.work, ["branch", "--show-current"]), BRANCH);
  assert.equal(gitText(f.work, ["rev-list", "--count", `${f.mainSha}..HEAD`]), "1");
  assert.equal(gitText(f.work, ["rev-parse", "HEAD^"]), f.mainSha);
  assert.equal(gitText(f.work, ["rev-parse", "HEAD^{tree}"]), generatedTree);
  assert.equal(gitText(f.work, ["show", "-s", "--format=%s", "HEAD"]), TITLE);

  const pushed = invoke(f, "push");
  assert.equal(pushed.status, 0, pushed.stderr);
  const remoteHead = gitText(f.work, ["ls-remote", "--heads", "origin", `refs/heads/${BRANCH}`]).split(/\s+/u)[0];
  assert.equal(remoteHead, gitText(f.work, ["rev-parse", "HEAD"]));
  assert.notEqual(remoteHead, f.headSha);
});

test("rejects wrong PR number, base, and branch identities before checkout", (t) => {
  const f = fixture(t);
  const cases = [
    [{ observedPrNumber: "124" }, /release PR identity changed/u],
    [{ base: "develop" }, /release PR base must be main/u],
    [{ head: "release-please--branches--develop" }, /release PR head must be/u],
  ];
  for (const [overrides, pattern] of cases) {
    const result = invoke(f, "normalize", overrides);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, pattern);
    assert.equal(gitText(f.work, ["branch", "--show-current"]), "main");
  }
});

test("rejects a canonical-looking release branch that is not descended from exact main", (t) => {
  const f = fixture(t);
  git(f.seed, ["switch", "--orphan", "unrelated"]);
  writeFileSync(path.join(f.seed, "release-please-config.json"), `${JSON.stringify({
    "group-pull-request-title-pattern": "chore(release): prepare ${branch} releases",
  }, null, 2)}\n`);
  writeFileSync(path.join(f.seed, "unrelated.txt"), "unrelated\n");
  git(f.seed, ["add", "."]);
  git(f.seed, ["commit", "-m", TITLE]);
  const unrelated = gitText(f.seed, ["rev-parse", "HEAD"]);
  git(f.seed, ["push", "--force", "origin", `HEAD:refs/heads/${BRANCH}`]);

  const result = invoke(f, "normalize", { headSha: unrelated });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /not descended from exact main/u);
  assert.equal(gitText(f.work, ["branch", "--show-current"]), "main");
});

test("an exact force-with-lease preserves a release PR head that moved after inspection", (t) => {
  const f = fixture(t);
  const normalized = invoke(f, "normalize");
  assert.equal(normalized.status, 0, normalized.stderr);
  const localNormalized = gitText(f.work, ["rev-parse", "HEAD"]);

  writeFileSync(path.join(f.seed, "late.txt"), "late\n");
  git(f.seed, ["add", "late.txt"]);
  git(f.seed, ["commit", "-m", TITLE]);
  git(f.seed, ["push", "origin", BRANCH]);
  const movedHead = gitText(f.seed, ["rev-parse", "HEAD"]);

  const pushed = invoke(f, "push");
  assert.equal(pushed.status, 1, pushed.stderr);
  assert.match(pushed.stderr, /stale info|fetch first|failed to push/u);
  const remoteHead = gitText(f.work, ["ls-remote", "--heads", "origin", `refs/heads/${BRANCH}`]).split(/\s+/u)[0];
  assert.equal(remoteHead, movedHead);
  assert.notEqual(remoteHead, localNormalized);
  assert.equal(readFileSync(path.join(f.work, "first-001.txt"), "utf8"), "first-001.txt\n");
});
