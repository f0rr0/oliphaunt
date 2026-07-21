import { captureCommandOutput } from "../dev/capture-command-output.mjs";

const EXACT_SHA = /^[0-9a-f]{40}$/u;

function git(repo, args, { allowEmptyOutput = false, stdoutTerminator = undefined } = {}) {
  const result = captureCommandOutput("git", args, {
    allowEmptyOutput,
    cwd: repo,
    label: `git ${args.join(" ")}`,
    stdoutTerminator,
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
  const suppressedIndexEntries = git(repo, ["ls-files", "-v", "-z"], {
    allowEmptyOutput: true,
    stdoutTerminator: "\0",
  })
    .split("\0")
    .filter((entry) => entry && (entry[0] === "S" || /[a-z]/u.test(entry[0])));
  if (suppressedIndexEntries.length > 0) {
    const paths = suppressedIndexEntries.map((entry) => entry.slice(2)).join("\n");
    throw new Error(
      `qualified release replay rejects index suppression flags (assume-unchanged or skip-worktree):\n${paths}`,
    );
  }
  const dirty = git(repo, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
    allowEmptyOutput: true,
    stdoutTerminator: "\0",
  });
  if (dirty) {
    const paths = dirty.split("\0").filter(Boolean).join("\n");
    throw new Error(`qualified release replay requires a clean source checkout:\n${paths}`);
  }
  return { sha: resolved };
}
