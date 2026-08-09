import { captureCommandOutput } from "../dev/capture-command-output.mjs";

const EXACT_SHA = /^[0-9a-f]{40}$/u;
const POSITIVE_INTEGER = /^[1-9][0-9]*$/u;

export function qualifiedReplayCandidateBinding({
  candidateMode,
  controllerSha,
  releaseSourceSha,
  runId,
}) {
  const controller = String(controllerSha ?? "").toLowerCase();
  const source = String(releaseSourceSha ?? "").toLowerCase();
  const normalizedRunId = String(runId ?? "");
  if (!EXACT_SHA.test(controller) || !EXACT_SHA.test(source)) {
    throw new Error("qualified release replay candidate binding requires exact controller and source SHAs");
  }
  if (!POSITIVE_INTEGER.test(normalizedRunId)) {
    throw new Error("qualified release replay candidate binding requires a positive CI run ID");
  }
  if (!new Set(["release-bump", "release-recovery"]).has(candidateMode)) {
    throw new Error(`qualified release replay candidate mode is invalid: ${candidateMode}`);
  }
  const recovery = candidateMode === "release-recovery";
  if (recovery && controller === source) {
    throw new Error("qualified recovery replay requires distinct controller and release source SHAs");
  }
  if (!recovery && controller !== source) {
    throw new Error("ordinary qualified replay requires identical controller and release source SHAs");
  }
  return Object.freeze({
    candidateRoot: recovery
      ? "target/recovery-payload-candidate"
      : "target/release-candidate",
    candidateSha: recovery ? source : controller,
    qualificationMode: "full-payload",
    runId: normalizedRunId,
  });
}

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

export function assertQualifiedReplaySourceState({
  repo,
  headRef,
  expectedSha,
  releaseSourceRef = headRef,
  expectedReleaseSourceSha = expectedSha,
}) {
  const normalizedExpected = String(expectedSha ?? "").toLowerCase();
  if (!EXACT_SHA.test(normalizedExpected)) {
    throw new Error("qualified release replay requires an exact 40-character RELEASE_HEAD_SHA");
  }
  const normalizedExpectedReleaseSource = String(
    expectedReleaseSourceSha ?? "",
  ).toLowerCase();
  if (!EXACT_SHA.test(normalizedExpectedReleaseSource)) {
    throw new Error(
      "qualified release replay requires an exact 40-character RELEASE_SOURCE_SHA",
    );
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
  const resolvedReleaseSource = git(
    repo,
    ["rev-parse", `${releaseSourceRef}^{commit}`],
  ).toLowerCase();
  if (resolvedReleaseSource !== normalizedExpectedReleaseSource) {
    throw new Error(
      "qualified release replay source mismatch: "
        + `expected ${normalizedExpectedReleaseSource}, got ${resolvedReleaseSource}`,
    );
  }
  const mergeBase = git(
    repo,
    ["merge-base", resolvedReleaseSource, resolved],
  ).toLowerCase();
  if (mergeBase !== resolvedReleaseSource) {
    throw new Error(
      `qualified release replay source ${resolvedReleaseSource} is not an ancestor of ${resolved}`,
    );
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
