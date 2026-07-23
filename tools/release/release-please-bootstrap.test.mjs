#!/usr/bin/env bun
import assert from "node:assert/strict";
import test from "node:test";

import {
  RELEASE_PLEASE_BOOTSTRAP_SHA,
  RELEASE_PLEASE_DISPLACED_MAIN_SHA,
  RELEASE_PLEASE_HISTORY_REPAIR_CANDIDATE_BRANCH,
  RELEASE_PLEASE_HISTORY_REPAIR_BEFORE_SHA,
  exactReleasePleaseUnpublishedFirstReleaseRollbackTransport,
  isExactReleasePleaseIntroductionCommit,
  isUnreleasedReleasePleaseManifest,
  releasePleaseBootstrapLifecycleError,
  releasePleaseConfigAfterBootstrapConsumption,
} from "./release-please-bootstrap.mjs";

const seedManifest = { "packages/alpha": "0.0.0", "packages/beta": "0.0.0" };
const releasedManifest = { ...seedManifest, "packages/alpha": "0.1.0" };
const seedConfig = { "bootstrap-sha": RELEASE_PLEASE_BOOTSTRAP_SHA, packages: {} };
const rollbackConfig = {
  "bootstrap-sha": RELEASE_PLEASE_BOOTSTRAP_SHA,
  "initial-version": "0.1.0",
  packages: {
    "packages/alpha": { component: "alpha" },
    "packages/beta": { component: "beta", "initial-version": "0.6.0" },
  },
};
const firstReleaseManifest = {
  "packages/alpha": "0.1.0",
  "packages/beta": "0.6.0",
};

test("keeps release-metadata and current history-repair boundaries distinct", () => {
  assert.match(RELEASE_PLEASE_DISPLACED_MAIN_SHA, /^[0-9a-f]{40}$/u);
  assert.equal(
    RELEASE_PLEASE_HISTORY_REPAIR_BEFORE_SHA,
    "eb90ff251e8863666f101de43577a10478944df3",
  );
  assert.equal(
    RELEASE_PLEASE_HISTORY_REPAIR_CANDIDATE_BRANCH,
    "f0rr0/history-repair-candidate-4",
  );
  assert.notEqual(RELEASE_PLEASE_HISTORY_REPAIR_BEFORE_SHA, RELEASE_PLEASE_DISPLACED_MAIN_SHA);
  assert.notEqual(
    RELEASE_PLEASE_HISTORY_REPAIR_BEFORE_SHA,
    "48d4acea4633e96c725377b5c0a0e4b466ee4f1e",
  );
});

test("normalizes only the exact unpublished first-release rollback transport", () => {
  assert.deepEqual(
    exactReleasePleaseUnpublishedFirstReleaseRollbackTransport(
      rollbackConfig,
      firstReleaseManifest,
      seedManifest,
      [RELEASE_PLEASE_HISTORY_REPAIR_BEFORE_SHA],
    ),
    {
      kind: "unpublished-first-release-rollback-transport",
      parentSha: RELEASE_PLEASE_HISTORY_REPAIR_BEFORE_SHA,
      normalizedBeforeManifest: seedManifest,
    },
  );
  for (const parents of [
    [],
    [RELEASE_PLEASE_DISPLACED_MAIN_SHA],
    [
      RELEASE_PLEASE_HISTORY_REPAIR_BEFORE_SHA,
      RELEASE_PLEASE_BOOTSTRAP_SHA,
    ],
  ]) {
    assert.equal(
      exactReleasePleaseUnpublishedFirstReleaseRollbackTransport(
        rollbackConfig,
        firstReleaseManifest,
        seedManifest,
        parents,
      ),
      null,
    );
  }
});

test("the authorized rollback parent rejects every near-miss release shape", () => {
  const cases = [
    {
      name: "missing bootstrap boundary",
      config: { ...rollbackConfig, "bootstrap-sha": undefined },
      before: firstReleaseManifest,
      after: seedManifest,
      pattern: /requires bootstrap-sha/u,
    },
    {
      name: "wrong global initial version",
      config: { ...rollbackConfig, "initial-version": "0.2.0" },
      before: firstReleaseManifest,
      after: seedManifest,
      pattern: /parent version 0[.]2[.]0, got 0[.]1[.]0/u,
    },
    {
      name: "zero configured initial version",
      config: { ...rollbackConfig, "initial-version": "0.0.0" },
      before: firstReleaseManifest,
      after: seedManifest,
      pattern: /must advance beyond unreleased 0[.]0[.]0/u,
    },
    {
      name: "wrong package-specific initial version",
      config: {
        ...rollbackConfig,
        packages: {
          ...rollbackConfig.packages,
          "packages/beta": {
            ...rollbackConfig.packages["packages/beta"],
            "initial-version": "0.7.0",
          },
        },
      },
      before: firstReleaseManifest,
      after: seedManifest,
      pattern: /parent version 0[.]7[.]0, got 0[.]6[.]0/u,
    },
    {
      name: "partially released rollback",
      config: rollbackConfig,
      before: firstReleaseManifest,
      after: { ...seedManifest, "packages/beta": "0.6.0" },
      pattern: /restore every package to unreleased 0[.]0[.]0/u,
    },
    {
      name: "missing manifest path",
      config: rollbackConfig,
      before: firstReleaseManifest,
      after: { "packages/alpha": "0.0.0" },
      pattern: /manifests must exactly match/u,
    },
    {
      name: "wrong first-release parent version",
      config: rollbackConfig,
      before: { ...firstReleaseManifest, "packages/alpha": "0.2.0" },
      after: seedManifest,
      pattern: /parent version 0[.]1[.]0, got 0[.]2[.]0/u,
    },
    {
      name: "duplicate component",
      config: {
        ...rollbackConfig,
        packages: {
          ...rollbackConfig.packages,
          "packages/beta": {
            ...rollbackConfig.packages["packages/beta"],
            component: "alpha",
          },
        },
      },
      before: firstReleaseManifest,
      after: seedManifest,
      pattern: /declare one unique component/u,
    },
  ];
  for (const { name, config, before, after, pattern } of cases) {
    assert.throws(
      () => exactReleasePleaseUnpublishedFirstReleaseRollbackTransport(
        config,
        before,
        after,
        [RELEASE_PLEASE_HISTORY_REPAIR_BEFORE_SHA],
      ),
      pattern,
      name,
    );
  }
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
