import assert from "node:assert/strict";
import { execFileSync } from "../test/fd-backed-spawn-sync.mjs";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { assertQualifiedReplaySourceState } from "./qualified-release-replay.mjs";

function git(repo, ...args) {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
}

function fixture() {
  const repo = mkdtempSync(path.join(tmpdir(), "oliphaunt-qualified-replay-"));
  git(repo, "init", "--quiet");
  git(repo, "config", "user.name", "Oliphaunt Test");
  git(repo, "config", "user.email", "test@oliphaunt.dev");
  writeFileSync(path.join(repo, "tracked.txt"), "clean\n");
  git(repo, "add", "tracked.txt");
  git(repo, "commit", "--quiet", "-m", "test: fixture");
  return { repo, sha: git(repo, "rev-parse", "HEAD") };
}

test("qualified replay binds a clean checkout to one exact commit", () => {
  const { repo, sha } = fixture();
  try {
    assert.deepEqual(
      assertQualifiedReplaySourceState({ repo, headRef: "HEAD", expectedSha: sha }),
      { sha },
    );
    assert.throws(
      () => assertQualifiedReplaySourceState({ repo, headRef: "HEAD", expectedSha: "0".repeat(40) }),
      /head mismatch/iu,
    );
    assert.throws(
      () => assertQualifiedReplaySourceState({ repo, headRef: "HEAD", expectedSha: "abc" }),
      /exact 40-character/u,
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("qualified replay rejects tracked, staged, and untracked source changes", () => {
  for (const mutate of [
    (repo) => writeFileSync(path.join(repo, "tracked.txt"), "modified\n"),
    (repo) => {
      writeFileSync(path.join(repo, "tracked.txt"), "staged\n");
      git(repo, "add", "tracked.txt");
    },
    (repo) => writeFileSync(path.join(repo, "untracked.txt"), "untracked\n"),
  ]) {
    const { repo, sha } = fixture();
    try {
      mutate(repo);
      assert.throws(
        () => assertQualifiedReplaySourceState({ repo, headRef: "HEAD", expectedSha: sha }),
        /clean source checkout/u,
      );
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }
});

test("qualified replay treats a newline-bearing untracked path as one complete dirty record", () => {
  const { repo, sha } = fixture();
  try {
    writeFileSync(path.join(repo, "untracked\nrecord.txt"), "untracked\n");
    assert.throws(
      () => assertQualifiedReplaySourceState({ repo, headRef: "HEAD", expectedSha: sha }),
      (error) => /clean source checkout/u.test(error.message)
        && error.message.includes("untracked\nrecord.txt"),
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("qualified replay rejects a clean checkout whose actual HEAD is not the qualified commit", () => {
  const { repo, sha } = fixture();
  try {
    writeFileSync(path.join(repo, "tracked.txt"), "second commit\n");
    git(repo, "add", "tracked.txt");
    git(repo, "commit", "--quiet", "-m", "test: move checkout head");
    assert.throws(
      () => assertQualifiedReplaySourceState({ repo, headRef: sha, expectedSha: sha }),
      /checkout HEAD mismatch/u,
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("qualified replay rejects index flags that suppress tracked modifications", () => {
  for (const flag of ["--assume-unchanged", "--skip-worktree"]) {
    const { repo, sha } = fixture();
    try {
      git(repo, "update-index", flag, "tracked.txt");
      writeFileSync(path.join(repo, "tracked.txt"), `${flag}\n`);
      assert.equal(git(repo, "status", "--porcelain=v1", "--untracked-files=all"), "");
      assert.throws(
        () => assertQualifiedReplaySourceState({ repo, headRef: "HEAD", expectedSha: sha }),
        /index suppression flags/u,
      );
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }
});
