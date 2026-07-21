#!/usr/bin/env bun
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import {
  RELEASE_PLEASE_BOOTSTRAP_SHA,
  RELEASE_PLEASE_DISPLACED_MAIN_SHA,
  RELEASE_PLEASE_HISTORY_REPAIR_BEFORE_SHA,
  RELEASE_PLEASE_INTRODUCTION_SUBJECT,
} from "../release/release-please-bootstrap.mjs";

const ROOT = path.resolve(import.meta.dir, "../..");
const SCRIPT = path.join(ROOT, ".github/scripts/check-release-intent.sh");
const SUBJECT = RELEASE_PLEASE_INTRODUCTION_SUBJECT;

function command(commandName, args, options = {}) {
  const result = spawnSync(commandName, args, {
    cwd: ROOT,
    encoding: "utf8",
    ...options,
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      result.stderr?.trim()
        || result.error?.message
        || `${commandName} ${args.join(" ")} exited ${String(result.status)}`,
    );
  }
  return result.stdout.trim();
}

// Keep the synthetic sibling commits out of the checkout's shared object
// database. Git reads the real repository through the alternate and writes
// only the two test commits into this disposable object directory.
const alternateObjects = command(
  "git",
  ["rev-parse", "--path-format=absolute", "--git-path", "objects"],
);
const isolatedObjects = mkdtempSync(path.join(tmpdir(), "oliphaunt-release-intent-objects-"));
const gitEnvironment = {
  ...process.env,
  GIT_OBJECT_DIRECTORY: isolatedObjects,
  GIT_ALTERNATE_OBJECT_DIRECTORIES: [
    alternateObjects,
    process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES,
  ].filter(Boolean).join(path.delimiter),
};
const isolatedIndexEnvironment = {
  ...gitEnvironment,
  GIT_INDEX_FILE: path.join(isolatedObjects, "index"),
};

after(() => {
  rmSync(isolatedObjects, { recursive: true, force: true });
});

function isolatedGit(args, options = {}) {
  return command("git", args, {
    env: gitEnvironment,
    ...options,
  });
}

function findIntroductionCommit(head = "HEAD", runGit = (args) => command("git", args)) {
  const commits = runGit(["rev-list", "--first-parent", head]).split("\n");
  for (const commit of commits) {
    const commitAndParents = runGit(["rev-list", "--parents", "-n", "1", commit]).split(" ");
    if (
      commitAndParents.length !== 2
      || commitAndParents[1] !== RELEASE_PLEASE_BOOTSTRAP_SHA
      || runGit(["show", "-s", "--format=%s", commit]) !== SUBJECT
    ) continue;

    const config = JSON.parse(runGit(["show", `${commit}:release-please-config.json`]));
    const manifest = JSON.parse(runGit(["show", `${commit}:.release-please-manifest.json`]));
    const versions = manifest && !Array.isArray(manifest) && typeof manifest === "object"
      ? Object.values(manifest)
      : [];
    if (
      config?.["bootstrap-sha"] === RELEASE_PLEASE_BOOTSTRAP_SHA
      && versions.length > 0
      && versions.every((version) => version === "0.0.0")
    ) return commit;
  }
  throw new Error("could not locate the permanent exact introduction commit fixture");
}

const HISTORY_HEAD = process.env.OLIPHAUNT_RELEASE_INTENT_TEST_HEAD || "HEAD";
const INTRODUCTION_COMMIT = findIntroductionCommit(HISTORY_HEAD);
const INTRODUCTION_TREE = command("git", ["rev-parse", `${INTRODUCTION_COMMIT}^{tree}`]);

function commitTree(subject, timestamp, {
  parent = RELEASE_PLEASE_BOOTSTRAP_SHA,
  tree = INTRODUCTION_TREE,
} = {}) {
  return isolatedGit(
    ["commit-tree", tree, "-p", parent],
    {
      input: `${subject}\n`,
      env: {
        ...gitEnvironment,
        GIT_AUTHOR_NAME: "Release Intent Test",
        GIT_AUTHOR_EMAIL: "release-intent@example.invalid",
        GIT_AUTHOR_DATE: timestamp,
        GIT_COMMITTER_NAME: "Release Intent Test",
        GIT_COMMITTER_EMAIL: "release-intent@example.invalid",
        GIT_COMMITTER_DATE: timestamp,
      },
    },
  );
}

function treeWithJson(file, mutate) {
  const value = JSON.parse(isolatedGit(["show", `${INTRODUCTION_COMMIT}:${file}`]));
  mutate(value);
  const blob = isolatedGit(["hash-object", "-w", "--stdin"], {
    input: `${JSON.stringify(value, null, 2)}\n`,
  });
  isolatedGit(["read-tree", INTRODUCTION_TREE], { env: isolatedIndexEnvironment });
  isolatedGit(["update-index", "--add", "--cacheinfo", `100644,${blob},${file}`], {
    env: isolatedIndexEnvironment,
  });
  return isolatedGit(["write-tree"], { env: isolatedIndexEnvironment });
}

const rewriteCandidate = commitTree(SUBJECT, "2026-01-01T00:00:01Z");
assert.notEqual(
  spawnSync("git", ["merge-base", "--is-ancestor", RELEASE_PLEASE_HISTORY_REPAIR_BEFORE_SHA, rewriteCandidate], {
    cwd: ROOT,
    env: gitEnvironment,
  }).status,
  0,
  "the release-intent fixture must be a real non-fast-forward sibling rewrite",
);

function releaseIntent({
  base = RELEASE_PLEASE_HISTORY_REPAIR_BEFORE_SHA,
  branch = "main",
  eventName = "push",
  fullRef = "refs/heads/main",
  head = rewriteCandidate,
  subject = SUBJECT,
} = {}) {
  const result = spawnSync(
    "bash",
    [SCRIPT, subject, base, head, branch, eventName, fullRef],
    {
      cwd: ROOT,
      encoding: "utf8",
      env: gitEnvironment,
    },
  );
  return {
    status: result.status,
    output: `${result.stdout}${result.stderr}`,
  };
}

test("accepts only the exact current protected-main introduction repair", { timeout: 20_000 }, () => {
  const result = releaseIntent();
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /authorized current main history repair; comparing .* to its exact introduction parent/u);
});

test("keeps the immutable introduction fixture after a later release commit becomes HEAD", () => {
  const laterTree = treeWithJson(".release-please-manifest.json", (manifest) => {
    const first = Object.keys(manifest).sort()[0];
    assert.ok(first);
    manifest[first] = "0.1.0";
  });
  const laterHead = commitTree("chore(release): prepare first releases", "2026-01-01T00:00:02Z", {
    parent: INTRODUCTION_COMMIT,
    tree: laterTree,
  });
  assert.equal(findIntroductionCommit(laterHead, isolatedGit), INTRODUCTION_COMMIT);
});

test("rejects a fork PR whose head branch is named main", () => {
  const result = releaseIntent({ eventName: "pull_request", fullRef: "refs/pull/123/merge" });
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /release-intent base .* is not an ancestor/u);
  assert.doesNotMatch(result.output, /authorized current main history repair/u);
});

test("rejects a manual sibling dispatch whose ref name is main", () => {
  const result = releaseIntent({ eventName: "workflow_dispatch" });
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /release-intent base .* is not an ancestor/u);
  assert.doesNotMatch(result.output, /authorized current main history repair/u);
});

test("rejects the original displaced-main tip after the first repair completed", () => {
  const result = releaseIntent({ base: RELEASE_PLEASE_DISPLACED_MAIN_SHA });
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /exact current introduction repair/u);
});

test("rejects the superseded predecessor from the completed repair", () => {
  const result = releaseIntent({
    base: "1b27e2388260e23810cf2611f454432c6f724744",
  });
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /exact current introduction repair/u);
});

test("rejects a replay after the authorized repair predecessor has changed", () => {
  const replayCandidate = commitTree(SUBJECT, "2026-01-01T00:00:03Z");
  const result = releaseIntent({ base: rewriteCandidate, head: replayCandidate });
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /exact current introduction repair/u);
});

test("rejects a rewrite whose sole parent is not the canonical bootstrap boundary", () => {
  const noncanonicalParent = commitTree(
    "chore: isolate a noncanonical rewrite parent",
    "2026-01-01T00:00:04Z",
  );
  const wrongParent = commitTree(SUBJECT, "2026-01-01T00:00:04Z", {
    parent: noncanonicalParent,
  });
  assert.notEqual(
    spawnSync("git", ["merge-base", "--is-ancestor", RELEASE_PLEASE_HISTORY_REPAIR_BEFORE_SHA, wrongParent], {
      cwd: ROOT,
      env: gitEnvironment,
    }).status,
    0,
    "the wrong-parent fixture must exercise the non-fast-forward repair guard",
  );
  const result = releaseIntent({ head: wrongParent });
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /exact current introduction repair/u);
});

test("rejects a rewrite whose head changes the canonical bootstrap identity", () => {
  const tree = treeWithJson("release-please-config.json", (config) => {
    config["bootstrap-sha"] = "1111111111111111111111111111111111111111";
  });
  const head = commitTree(SUBJECT, "2026-01-01T00:00:05Z", { tree });
  const result = releaseIntent({ head });
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /exact current introduction repair/u);
});

test("rejects a rewrite after any product has left the unreleased manifest state", () => {
  const tree = treeWithJson(".release-please-manifest.json", (manifest) => {
    const first = Object.keys(manifest).sort()[0];
    assert.ok(first);
    manifest[first] = "0.1.0";
  });
  const head = commitTree(SUBJECT, "2026-01-01T00:00:06Z", { tree });
  const result = releaseIntent({ head });
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /exact current introduction repair/u);
});

test("rejects any other subject on the authorized before SHA", () => {
  const result = releaseIntent({ subject: "feat: replay history repair" });
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /exact current introduction repair/u);
});
