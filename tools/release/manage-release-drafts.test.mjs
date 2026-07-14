#!/usr/bin/env bun
import assert from "node:assert/strict";
import test from "node:test";

import {
  exactTagRefPayload,
  releaseNotesForVersion,
} from "../../.github/scripts/manage-release-drafts.mjs";

test("exact-SHA draft staging never represents a moving branch", () => {
  const sha = "a".repeat(40);
  assert.deepEqual(exactTagRefPayload("oliphaunt-js-v0.1.0", sha), {
    ref: "refs/tags/oliphaunt-js-v0.1.0",
    sha,
  });
  assert.throws(
    () => exactTagRefPayload("oliphaunt-js-v0.1.0", "main"),
    /full lowercase commit SHA/u,
  );
});

test("release notes select only the exact version section", () => {
  const changelog = `# Changelog

## [0.2.0](https://example.invalid/compare) (2026-07-14)

### Features

* exact release notes

## 0.1.0 (2026-07-01)

* older notes
`;
  assert.equal(
    releaseNotesForVersion(changelog, "0.2.0"),
    "### Features\n\n* exact release notes",
  );
  assert.throws(() => releaseNotesForVersion(changelog, "0.3.0"), /no release heading/u);
});
