import { expect, test } from "bun:test";

import { githubReleaseLineageIdentity } from "./github-release-lineage.mjs";

const base = {
  GITHUB_REPOSITORY: "f0rr0/oliphaunt",
  GITHUB_RUN_ID: "200",
  GITHUB_SHA: "a".repeat(40),
};

test("uses the verified root run across child runs and rerun attempts", () => {
  expect(githubReleaseLineageIdentity({
    ...base,
    GITHUB_RUN_ATTEMPT: "9",
    OLIPHAUNT_RELEASE_ROOT_RUN_ID: "100",
  })).toEqual({
    headSha: "a".repeat(40),
    repository: "f0rr0/oliphaunt",
    rootRunId: "100",
  });
});
test("defaults to the current run only for a root release", () => {
  expect(githubReleaseLineageIdentity(base).rootRunId).toBe("200");
});

test("rejects malformed current and root run identities", () => {
  expect(() => githubReleaseLineageIdentity({ ...base, GITHUB_RUN_ID: "" })).toThrow("GITHUB_RUN_ID");
  expect(() => githubReleaseLineageIdentity({ ...base, OLIPHAUNT_RELEASE_ROOT_RUN_ID: "child" })).toThrow(
    "OLIPHAUNT_RELEASE_ROOT_RUN_ID",
  );
});
