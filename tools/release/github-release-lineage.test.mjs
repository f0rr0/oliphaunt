import { expect, test } from "bun:test";

import { githubReleaseLineageIdentity } from "./github-release-lineage.mjs";

const base = {
  GITHUB_REPOSITORY: "f0rr0/oliphaunt",
  GITHUB_RUN_ID: "200",
  GITHUB_SHA: "a".repeat(40),
};

test("uses the current run for the runner-local journal", () => {
  expect(githubReleaseLineageIdentity(base)).toEqual({
    headSha: "a".repeat(40),
    repository: "f0rr0/oliphaunt",
    runId: "200",
  });
});

test("rejects a malformed current run identity", () => {
  expect(() => githubReleaseLineageIdentity({ ...base, GITHUB_RUN_ID: "" })).toThrow("GITHUB_RUN_ID");
});
