#!/usr/bin/env bun
import assert from "node:assert/strict";
import { spawnSync } from "../test/fd-backed-spawn-sync.mjs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const ROOT = path.resolve(import.meta.dir, "../..");
const SCRIPT = path.join(ROOT, ".github/scripts/check-release-intent.sh");

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

after(() => {
  rmSync(isolatedObjects, { recursive: true, force: true });
});

function commitTree(subject, timestamp, parent = "HEAD") {
  const tree = command("git", ["rev-parse", `${parent}^{tree}`], { env: gitEnvironment });
  return command(
    "git",
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

function releaseIntent({
  base,
  branch = "main",
  eventName = "workflow_dispatch",
  fullRef = "refs/heads/main",
  head,
  subject = "fix: validate release intent",
}) {
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

const firstChild = commitTree("fix: validate release intent", "2026-01-01T00:00:01Z");
const siblingChild = commitTree("fix: validate release intent", "2026-01-01T00:00:02Z");

test("accepts a manual main dispatch against its exact parent", { timeout: 20_000 }, () => {
  const result = releaseIntent({ base: "HEAD", head: firstChild });
  assert.equal(result.status, 0, result.output);
});

test("rejects a manual main dispatch whose base is not its exact parent", () => {
  const result = releaseIntent({ base: "HEAD^", head: firstChild });
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /base must resolve to the exact commit parent/u);
});

test("rejects a non-fast-forward comparison", () => {
  const result = releaseIntent({
    base: firstChild,
    branch: "feature",
    eventName: "push",
    fullRef: "refs/heads/feature",
    head: siblingChild,
  });
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /is not an ancestor/u);
});

test("manual main dispatch requires matching branch identities", () => {
  const result = releaseIntent({
    base: "HEAD",
    branch: "main",
    fullRef: "refs/heads/diagnostic",
    head: firstChild,
  });
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /requires matching main branch and full ref/u);
});
