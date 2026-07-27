const FULL_SHA = /^[0-9a-f]{40}$/u;
const POSITIVE_INTEGER = /^[1-9][0-9]*$/u;

export class GitHubReleaseLineageError extends Error {
  constructor(message) {
    super(`github-release-lineage: ${message}`);
    this.name = "GitHubReleaseLineageError";
  }
}
function fail(message) {
  throw new GitHubReleaseLineageError(message);
}

/**
 * The root run is the immutable release lineage. A registry continuation is a
 * different Actions run, and a rerun has a different attempt, but both must
 * retain the original root run ID carried by the verified continuation
 * contract. This identity deliberately excludes the current run attempt.
 */
export function githubReleaseLineageIdentity(environment = process.env) {
  const repository = environment.GITHUB_REPOSITORY?.trim() ?? "";
  const currentRunId = environment.GITHUB_RUN_ID?.trim() ?? "";
  const rootRunId = environment.OLIPHAUNT_RELEASE_ROOT_RUN_ID?.trim() || currentRunId;
  const headSha = (environment.RELEASE_HEAD_SHA ?? environment.GITHUB_SHA ?? "").trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) {
    fail("GITHUB_REPOSITORY must be OWNER/NAME");
  }
  if (!POSITIVE_INTEGER.test(currentRunId)) {
    fail("GITHUB_RUN_ID must be a positive integer");
  }
  if (!POSITIVE_INTEGER.test(rootRunId)) {
    fail("OLIPHAUNT_RELEASE_ROOT_RUN_ID must be a positive integer when supplied");
  }
  if (!FULL_SHA.test(headSha)) {
    fail("RELEASE_HEAD_SHA or GITHUB_SHA must be a full lowercase commit SHA");
  }
  return { headSha, repository, rootRunId };
}
