#!/usr/bin/env bun
import assert from "node:assert/strict";
import test from "node:test";

import {
  RELEASE_PLEASE_BOOTSTRAP_SHA,
  isUnreleasedReleasePleaseManifest,
  releasePleaseBootstrapLifecycleError,
  releasePleaseConfigAfterBootstrapConsumption,
} from "./release-please-bootstrap.mjs";

const seedManifest = { "packages/alpha": "0.0.0", "packages/beta": "0.0.0" };
const releasedManifest = { ...seedManifest, "packages/alpha": "0.1.0" };
const seedConfig = { "bootstrap-sha": RELEASE_PLEASE_BOOTSTRAP_SHA, packages: {} };

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
