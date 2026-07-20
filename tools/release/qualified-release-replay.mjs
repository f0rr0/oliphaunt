import { spawnSync } from "node:child_process";

const EXACT_SHA = /^[0-9a-f]{40}$/u;

function git(repo, args) {
  const result = spawnSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      result.stderr?.trim()
        || result.error?.message
        || `git ${args.join(" ")} failed`,
    );
  }
  return result.stdout.trim();
}

export function assertQualifiedReplaySourceState({ repo, headRef, expectedSha }) {
  const normalizedExpected = String(expectedSha ?? "").toLowerCase();
  if (!EXACT_SHA.test(normalizedExpected)) {
    throw new Error("qualified release replay requires an exact 40-character RELEASE_HEAD_SHA");
  }
  const checkoutHead = git(repo, ["rev-parse", "HEAD^{commit}"]).toLowerCase();
  if (checkoutHead !== normalizedExpected) {
    throw new Error(
      `qualified release replay checkout HEAD mismatch: expected ${normalizedExpected}, got ${checkoutHead}`,
    );
  }
  const resolved = git(repo, ["rev-parse", `${headRef}^{commit}`]).toLowerCase();
  if (resolved !== normalizedExpected) {
    throw new Error(`qualified release replay head mismatch: expected ${normalizedExpected}, got ${resolved}`);
  }
  const suppressedIndexEntries = git(repo, ["ls-files", "-v", "-z"])
    .split("\0")
    .filter((entry) => entry && (entry[0] === "S" || /[a-z]/u.test(entry[0])));
  if (suppressedIndexEntries.length > 0) {
    const paths = suppressedIndexEntries.map((entry) => entry.slice(2)).join("\n");
    throw new Error(
      `qualified release replay rejects index suppression flags (assume-unchanged or skip-worktree):\n${paths}`,
    );
  }
  const dirty = git(repo, ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (dirty) {
    throw new Error(`qualified release replay requires a clean source checkout:\n${dirty}`);
  }
  return { sha: resolved };
}
