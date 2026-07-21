#!/usr/bin/env bun
import assert from "node:assert/strict";
import test from "node:test";

import {
  RELEASE_PLEASE_BOOTSTRAP_SHA,
  RELEASE_PLEASE_DISPLACED_MAIN_SHA,
  RELEASE_PLEASE_HISTORY_REPAIR_BEFORE_SHA,
  isExactReleasePleaseIntroductionCommit,
  isUnreleasedReleasePleaseManifest,
  releasePleaseBootstrapLifecycleError,
  releasePleaseConfigAfterBootstrapConsumption,
} from "./release-please-bootstrap.mjs";

const seedManifest = { "packages/alpha": "0.0.0", "packages/beta": "0.0.0" };
const releasedManifest = { ...seedManifest, "packages/alpha": "0.1.0" };
const seedConfig = { "bootstrap-sha": RELEASE_PLEASE_BOOTSTRAP_SHA, packages: {} };

test("keeps release-metadata and current history-repair boundaries distinct", () => {
  assert.match(RELEASE_PLEASE_DISPLACED_MAIN_SHA, /^[0-9a-f]{40}$/u);
  assert.equal(
    RELEASE_PLEASE_HISTORY_REPAIR_BEFORE_SHA,
    "e0a468dfb6970f8afd66700b72e29a2d7c76c555",
  );
  assert.notEqual(RELEASE_PLEASE_HISTORY_REPAIR_BEFORE_SHA, RELEASE_PLEASE_DISPLACED_MAIN_SHA);
  assert.notEqual(
    RELEASE_PLEASE_HISTORY_REPAIR_BEFORE_SHA,
    "1b27e2388260e23810cf2611f454432c6f724744",
  );
});

test("requires the exact full history boundary while every product is unreleased", () => {
  assert.equal(isUnreleasedReleasePleaseManifest(seedManifest), true);
  assert.equal(releasePleaseBootstrapLifecycleError(seedConfig, seedManifest), undefined);
  assert.match(
    releasePleaseBootstrapLifecycleError({ packages: {} }, seedManifest),
    /bootstrap-sha must be the full legacy-history boundary/u,
  );
  assert.match(
    releasePleaseBootstrapLifecycleError({ ...seedConfig, "bootstrap-sha": "07a9054" }, seedManifest),
    /bootstrap-sha must be the full legacy-history boundary/u,
  );
});

test("removes bootstrap-sha exactly once after a generated release bump", () => {
  assert.equal(isUnreleasedReleasePleaseManifest(releasedManifest), false);
  assert.match(
    releasePleaseBootstrapLifecycleError(seedConfig, releasedManifest),
    /one-time state/u,
  );
  const updated = releasePleaseConfigAfterBootstrapConsumption(seedConfig, releasedManifest);
  assert.deepEqual(updated, { packages: {} });
  assert.notEqual(updated, seedConfig);
  assert.equal(releasePleaseBootstrapLifecycleError(updated, releasedManifest), undefined);
  assert.equal(releasePleaseConfigAfterBootstrapConsumption(updated, releasedManifest), updated);
});

test("does not remove the boundary before release-please consumes it", () => {
  assert.equal(releasePleaseConfigAfterBootstrapConsumption(seedConfig, seedManifest), seedConfig);
});

test("recognizes only the exact one-parent unreleased introduction commit", () => {
  assert.equal(
    isExactReleasePleaseIntroductionCommit(
      seedConfig,
      seedManifest,
      [RELEASE_PLEASE_BOOTSTRAP_SHA],
    ),
    true,
  );
  assert.equal(
    isExactReleasePleaseIntroductionCommit(seedConfig, releasedManifest, [RELEASE_PLEASE_BOOTSTRAP_SHA]),
    false,
  );
  assert.equal(
    isExactReleasePleaseIntroductionCommit(seedConfig, seedManifest, []),
    false,
  );
  assert.equal(
    isExactReleasePleaseIntroductionCommit(seedConfig, seedManifest, [
      RELEASE_PLEASE_BOOTSTRAP_SHA,
      "1111111111111111111111111111111111111111",
    ]),
    false,
  );
  assert.equal(
    isExactReleasePleaseIntroductionCommit(seedConfig, seedManifest, [
      "1111111111111111111111111111111111111111",
    ]),
    false,
  );
  assert.equal(
    isExactReleasePleaseIntroductionCommit(
      { ...seedConfig, "bootstrap-sha": "1111111111111111111111111111111111111111" },
      seedManifest,
      [RELEASE_PLEASE_BOOTSTRAP_SHA],
    ),
    false,
  );
});
