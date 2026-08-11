#!/usr/bin/env bun
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assertResumableReleaseMetadata,
  createReleaseDraftOperationBudget,
  exactReleaseMetadata,
  exactTagRefPayload,
  GITHUB_RELEASE_PROMOTION_COMMAND_WINDOW_MS,
  GITHUB_RELEASE_PROMOTION_MUTATION_TIMEOUT_MS,
  GITHUB_RELEASE_PROMOTION_TAG_SNAPSHOT_TIMEOUT_MS,
  promoteExactReleaseSync,
  readSelectedRemoteTagMapSync,
  reconcileSelectedReleasesSync,
  releaseNotesForVersion,
  stageExactDraftReleaseSync,
  stageExactTagSync,
} from "../../.github/scripts/manage-release-drafts.mjs";
import {
  GitHubReleaseSnapshotRaceError,
  GITHUB_RELEASE_SNAPSHOT_MAX_READ_ATTEMPTS,
  GITHUB_RELEASE_SNAPSHOT_READ_WINDOW_MS,
  GITHUB_RELEASE_SNAPSHOT_VISIBILITY_DELAYS_MS,
} from "./github-release-mutations.mjs";

function budget() {
  return { deadlineMs: 180_000, environment: {}, now: () => 0, startedAtMs: 0 };
}

function expectedRelease() {
  return exactReleaseMetadata({
    body: "### Features\n\n* immutable notes",
    headRef: "b".repeat(40),
    product: "oliphaunt-js",
    tag: "oliphaunt-js-v0.2.0",
    version: "0.2.0",
  });
}

const mutationOptions = {
  baseDelayMs: 0,
  maxAttempts: 3,
  sleep: () => {},
};

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

test("existing exact-tag releases are resumable only with exact frozen metadata", () => {
  const expected = expectedRelease();
  const release = {
    id: 42,
    draft: true,
    ...expected,
  };
  assert.equal(assertResumableReleaseMetadata(release, expected), release);
  assert.doesNotThrow(() => assertResumableReleaseMetadata({ ...release, draft: false }, expected));

  for (const [field, value] of [
    ["tag_name", "oliphaunt-js-v0.1.0"],
    ["name", "Oliphaunt JS"],
    ["body", "stale notes"],
    ["prerelease", true],
    ["target_commitish", "main"],
  ]) {
    assert.throws(
      () => assertResumableReleaseMetadata({ ...release, [field]: value }, expected),
      new RegExp(`${field}=`, "u"),
    );
  }
});

test("tag creation accepts an applied-but-timed-out exact full-SHA mutation without replay", () => {
  const headRef = "a".repeat(40);
  const tag = "oliphaunt-js-v0.2.0";
  let ref = null;
  let mutationCalls = 0;
  const result = stageExactTagSync(
    { budget: budget(), environment: {}, headRef, repo: "o/r", tag },
    {
      createTag: () => {
        mutationCalls += 1;
        ref = { ref: `refs/tags/${tag}`, sha: headRef, type: "commit" };
        throw new Error("response timed out");
      },
      mutationOptions,
      readTagRef: () => ref,
    },
  );
  assert.equal(mutationCalls, 1);
  assert.deepEqual(result, { mutationAttempts: 1, recovered: true });
});

test("tag creation treats another SHA or annotated-tag object as a terminal conflict", () => {
  let mutationCalls = 0;
  assert.throws(
    () => stageExactTagSync(
      {
        budget: budget(),
        environment: {},
        headRef: "a".repeat(40),
        repo: "o/r",
        tag: "oliphaunt-js-v0.2.0",
      },
      {
        createTag: () => {
          mutationCalls += 1;
        },
        mutationOptions,
        readTagRef: () => ({
          ref: "refs/tags/oliphaunt-js-v0.2.0",
          sha: "c".repeat(40),
          type: "tag",
        }),
      },
    ),
    /not commit:/u,
  );
  assert.equal(mutationCalls, 0);
});

test("draft creation reconciles frozen metadata after an ambiguous response", () => {
  const metadata = expectedRelease();
  let release = null;
  let mutationCalls = 0;
  const result = stageExactDraftReleaseSync(
    {
      budget: budget(),
      environment: {},
      metadata,
      repo: "o/r",
      tag: metadata.tag_name,
    },
    {
      createRelease: () => {
        mutationCalls += 1;
        release = { ...metadata, draft: true, id: 42 };
        throw new Error("timeout after request acceptance");
      },
      mutationOptions,
      readRelease: () => release,
    },
  );
  assert.equal(mutationCalls, 1);
  assert.deepEqual(result, { mutationAttempts: 1, recovered: true });
});

test("draft creation never overwrites malformed or conflicting release metadata", () => {
  const metadata = expectedRelease();
  let mutationCalls = 0;
  assert.throws(
    () => stageExactDraftReleaseSync(
      {
        budget: budget(),
        environment: {},
        metadata,
        repo: "o/r",
        tag: metadata.tag_name,
      },
      {
        createRelease: () => {
          mutationCalls += 1;
        },
        mutationOptions,
        readRelease: () => ({ ...metadata, body: "different", draft: true, id: 42 }),
      },
    ),
    /conflicts with frozen release metadata/u,
  );
  assert.equal(mutationCalls, 0);
});

test("promotion binds the original release id and reconciles applied timeout", () => {
  const metadata = expectedRelease();
  let release = { ...metadata, draft: true, id: 42 };
  let mutationCalls = 0;
  const result = promoteExactReleaseSync(
    {
      budget: budget(),
      environment: {},
      expectedId: 42,
      metadata,
      repo: "o/r",
      tag: metadata.tag_name,
    },
    {
      mutationOptions,
      promoteRelease: () => {
        mutationCalls += 1;
        release = { ...release, draft: false };
        throw new Error("PATCH response timed out");
      },
      readRelease: () => release,
    },
  );
  assert.equal(mutationCalls, 1);
  assert.deepEqual(result, { mutationAttempts: 1, recovered: true });
});

test("promotion refuses missing or replaced release ids without issuing PATCH", () => {
  const metadata = expectedRelease();
  for (const release of [null, { ...metadata, draft: true, id: 99 }]) {
    let mutationCalls = 0;
    assert.throws(
      () => promoteExactReleaseSync(
        {
          budget: budget(),
          environment: {},
          expectedId: 42,
          metadata,
          repo: "o/r",
          tag: metadata.tag_name,
        },
        {
          mutationOptions,
          promoteRelease: () => {
            mutationCalls += 1;
          },
          readRelease: () => release,
        },
      ),
      /disappeared|id changed/u,
    );
    assert.equal(mutationCalls, 0);
  }
});

test("batch promotion resumes an exact partially public release set without replaying completed mutations", () => {
  const selected = selection(3);
  const headRef = "d".repeat(40);
  const tags = new Map(selected.map(({ tag }) => [
    tag,
    { ref: `refs/tags/${tag}`, sha: headRef, type: "commit" },
  ]));
  const releases = new Map(selected.map(({ metadata, tag }, index) => [
    tag,
    { ...metadata, draft: true, id: index + 1 },
  ]));
  const interruptedTag = selected[1].tag;
  const mutations = [];
  let interrupted = true;
  const dependencies = {
    mutationOptions,
    mutatePromotion: ({ expectedId, metadata }) => {
      const tag = metadata.tag_name;
      mutations.push(tag);
      const release = releases.get(tag);
      assert.equal(release.id, expectedId);
      if (interrupted && tag === interruptedTag) {
        throw new Error("simulated runner interruption before PATCH");
      }
      const promoted = { ...release, draft: false };
      releases.set(tag, promoted);
      return JSON.stringify(promoted);
    },
    readRelease: (tag) => releases.get(tag) ?? null,
    readReleaseMap: () => new Map(releases),
    readTagMap: () => new Map(tags),
    releaseSnapshotSleep: () => {},
  };
  const reconcile = () => reconcileSelectedReleasesSync({
    budget: budget(),
    command: "promote",
    environment: {},
    expectedState: "public",
    headRef,
    repo: "o/r",
    selected,
  }, dependencies);

  assert.throws(
    reconcile,
    (cause) =>
      cause.cause instanceof Error
      && cause.cause.message === "simulated runner interruption before PATCH"
      && /did not converge to public state/u.test(cause.message)
      && /first failure for/u.test(cause.message),
  );
  assert.equal(releases.get(selected[0].tag).draft, false);
  assert.equal(releases.get(interruptedTag).draft, true);
  assert.equal(releases.get(selected[2].tag).draft, false);

  interrupted = false;
  assert.doesNotThrow(reconcile);
  assert.ok([...releases.values()].every(({ draft }) => draft === false));
  assert.equal(mutations.filter((tag) => tag === selected[0].tag).length, 1);
  assert.equal(mutations.filter((tag) => tag === interruptedTag).length, 2);
  assert.equal(mutations.filter((tag) => tag === selected[2].tag).length, 1);
});

function selection(count = 49) {
  const headRef = "d".repeat(40);
  return Array.from({ length: count }, (_, index) => {
    const product = `product-${String(index).padStart(2, "0")}`;
    const tag = `${product}-v1.0.0`;
    return {
      metadata: exactReleaseMetadata({
        body: `release notes ${index}`,
        headRef,
        product,
        tag,
        version: "1.0.0",
      }),
      product,
      tag,
      version: "1.0.0",
    };
  });
}

function releaseState(selected, { draft = true } = {}) {
  return new Map(selected.map(({ metadata, tag }, index) => [
    tag,
    { ...metadata, draft, id: index + 1 },
  ]));
}

function tagState(selected, headRef) {
  return new Map(selected.map(({ tag }) => [
    tag,
    { ref: `refs/tags/${tag}`, sha: headRef, type: "commit" },
  ]));
}

test("one remote advertisement returns an exact selected tag snapshot", () => {
  const selected = selection(3);
  const headRef = "d".repeat(40);
  const expectedRefs = selected.map(({ tag }) => `refs/tags/${tag}`);
  let args;
  const snapshot = readSelectedRemoteTagMapSync("o/r", selected, {
    budget: budget(),
    environment: {},
    spawn: (_command, commandArgs) => {
      args = commandArgs;
      return {
        status: 0,
        stderr: "",
        stdout: `${headRef}\t${expectedRefs[0]}\n${headRef}\t${expectedRefs[2]}\n`,
      };
    },
  });
  assert.ok(args.includes("https://github.com/o/r.git"));
  for (const ref of expectedRefs) assert.ok(args.includes(ref));
  assert.equal(snapshot.get(selected[0].tag).sha, headRef);
  assert.equal(snapshot.get(selected[1].tag), null);
  assert.equal(snapshot.get(selected[2].tag).sha, headRef);
  assert.throws(
    () => readSelectedRemoteTagMapSync("o/r", selected, {
      budget: budget(),
      environment: {},
      spawn: () => ({
        status: 0,
        stderr: "",
        stdout: `${headRef}\trefs/tags/unrequested-v1.0.0\n`,
      }),
    }),
    /unexpected/u,
  );
  assert.throws(
    () => readSelectedRemoteTagMapSync("o/r", selected, {
      budget: budget(),
      environment: {},
      spawn: () => ({
        status: 0,
        stderr: "",
        stdout: `${headRef}\t${expectedRefs[0]}`,
      }),
    }),
    /partial record/u,
  );
});

test("remote tag capture retains delayed records and accepts a complete empty first-release snapshot", (t) => {
  const selected = selection(3);
  const headRef = "d".repeat(40);
  const root = mkdtempSync(path.join(os.tmpdir(), "oliphaunt-tag-capture-"));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  const git = path.join(root, "git");
  writeFileSync(git, [
    `#!${process.execPath}`,
    `process.stdout.write(${JSON.stringify(`${headRef}\trefs/tags/${selected[0].tag}\n`)});`,
    `setImmediate(() => process.stdout.write(${JSON.stringify(`${headRef}\trefs/tags/${selected[2].tag}\n`)}));`,
    "",
  ].join("\n"));
  chmodSync(git, 0o755);

  const snapshot = readSelectedRemoteTagMapSync("o/r", selected, {
    budget: budget(),
    cwd: root,
    environment: {
      ...process.env,
      PATH: `${root}${path.delimiter}${process.env.PATH ?? ""}`,
    },
  });
  assert.equal(snapshot.get(selected[0].tag).sha, headRef);
  assert.equal(snapshot.get(selected[1].tag), null);
  assert.equal(snapshot.get(selected[2].tag).sha, headRef);

  writeFileSync(git, `#!${process.execPath}\n`);
  chmodSync(git, 0o755);
  const emptySnapshot = readSelectedRemoteTagMapSync("o/r", selected, {
    budget: budget(),
    cwd: root,
    environment: {
      ...process.env,
      PATH: `${root}${path.delimiter}${process.env.PATH ?? ""}`,
    },
  });
  assert.deepEqual([...emptySnapshot.values()], [null, null, null]);
});

test("the batch lifecycle mutates each exact tag, draft, and promotion once", () => {
  const selected = selection(3);
  const headRef = "d".repeat(40);
  const tags = new Map(selected.map(({ tag }) => [tag, null]));
  let releases = new Map();
  let restRequests = 0;
  let tagSnapshots = 0;
  const dependencies = {
    mutationOptions,
    mutateRelease: ({ metadata }) => {
      restRequests += 1;
      const release = { ...metadata, draft: true, id: releases.size + 1 };
      releases.set(metadata.tag_name, release);
      return JSON.stringify(release);
    },
    mutateTag: ({ headRef: target, tag }) => {
      restRequests += 1;
      const ref = { ref: `refs/tags/${tag}`, sha: target, type: "commit" };
      tags.set(tag, ref);
      return JSON.stringify({ ref: ref.ref, object: { sha: ref.sha, type: ref.type } });
    },
    readRelease: (tag) => releases.get(tag) ?? null,
    readReleaseMap: () => {
      restRequests += 1;
      return new Map(releases);
    },
    readTagMap: () => {
      tagSnapshots += 1;
      return new Map(tags);
    },
    readTagRef: (tag) => tags.get(tag) ?? null,
  };
  reconcileSelectedReleasesSync({
    budget: budget(),
    command: "preflight",
    environment: {},
    expectedState: "staged",
    headRef,
    repo: "o/r",
    selected,
  }, dependencies);
  assert.equal(restRequests, 1);
  assert.equal(tagSnapshots, 1);

  reconcileSelectedReleasesSync({
    budget: budget(),
    command: "stage",
    environment: {},
    expectedState: "staged",
    headRef,
    repo: "o/r",
    selected,
  }, dependencies);
  assert.equal(restRequests, 9, "stage adds two release snapshots plus six exact mutations");
  assert.equal(tagSnapshots, 4);

  reconcileSelectedReleasesSync({
    budget: budget(),
    command: "verify",
    environment: {},
    expectedState: "staged",
    headRef,
    repo: "o/r",
    selected,
  }, dependencies);
  assert.equal(restRequests, 10);
  assert.equal(tagSnapshots, 5);

  dependencies.mutatePromotion = ({ expectedId, metadata }) => {
    restRequests += 1;
    const release = { ...releases.get(metadata.tag_name), draft: false };
    assert.equal(release.id, expectedId);
    releases.set(metadata.tag_name, release);
    return JSON.stringify(release);
  };
  reconcileSelectedReleasesSync({
    budget: budget(),
    command: "promote",
    environment: {},
    expectedState: "public",
    headRef,
    repo: "o/r",
    selected,
  }, dependencies);
  assert.equal(restRequests, 15);
  assert.equal(tagSnapshots, 7);
});

test("batch staging waits for the complete draft list without replaying successful POSTs", () => {
  const selected = selection(2);
  const headRef = "d".repeat(40);
  const tags = new Map(selected.map(({ tag }) => [tag, null]));
  const releases = new Map();
  const mutations = [];
  const sleeps = [];
  let releaseListReads = 0;
  const dependencies = {
    mutationOptions,
    mutateRelease: ({ metadata }) => {
      mutations.push(metadata.tag_name);
      const release = { ...metadata, draft: true, id: releases.size + 1 };
      releases.set(metadata.tag_name, release);
      return JSON.stringify(release);
    },
    mutateTag: ({ headRef: target, tag }) => {
      const ref = { ref: `refs/tags/${tag}`, sha: target, type: "commit" };
      tags.set(tag, ref);
      return JSON.stringify({ ref: ref.ref, object: { sha: ref.sha, type: ref.type } });
    },
    readReleaseMap: () => {
      releaseListReads += 1;
      if (releaseListReads === 1) return new Map();
      if (releaseListReads <= 4) {
        return new Map([...releases].filter(([tag]) => tag !== selected.at(-1).tag));
      }
      return new Map(releases);
    },
    readTagMap: () => new Map(tags),
    releaseSnapshotSleep: (milliseconds) => sleeps.push(milliseconds),
  };

  reconcileSelectedReleasesSync({
    budget: budget(),
    command: "stage",
    environment: {},
    expectedState: "staged",
    headRef,
    repo: "o/r",
    selected,
  }, dependencies);

  assert.deepEqual(mutations, selected.map(({ tag }) => tag));
  assert.equal(releaseListReads, 5);
  assert.deepEqual(sleeps, GITHUB_RELEASE_SNAPSHOT_VISIBILITY_DELAYS_MS.slice(0, 3));
});

test("an applied draft POST with a lost response is observed before any replay", () => {
  const selected = selection(1);
  const headRef = "d".repeat(40);
  const tag = selected[0].tag;
  const metadata = selected[0].metadata;
  const tags = new Map([[tag, null]]);
  const releases = new Map();
  const sleeps = [];
  let releaseListReads = 0;
  let releaseMutations = 0;
  const dependencies = {
    mutationOptions,
    mutateRelease: () => {
      releaseMutations += 1;
      releases.set(tag, { ...metadata, draft: true, id: 1 });
      throw new Error("response lost after draft creation");
    },
    mutateTag: ({ headRef: target }) => {
      const ref = { ref: `refs/tags/${tag}`, sha: target, type: "commit" };
      tags.set(tag, ref);
      return JSON.stringify({ ref: ref.ref, object: { sha: ref.sha, type: ref.type } });
    },
    readRelease: () => {
      throw new Error("draft recovery must not use the by-tag REST endpoint");
    },
    readReleaseMap: () => {
      releaseListReads += 1;
      if (releaseListReads <= 3) return new Map();
      return new Map(releases);
    },
    readTagMap: () => new Map(tags),
    releaseSnapshotSleep: (milliseconds) => sleeps.push(milliseconds),
  };

  reconcileSelectedReleasesSync({
    budget: budget(),
    command: "stage",
    environment: {},
    expectedState: "staged",
    headRef,
    repo: "o/r",
    selected,
  }, dependencies);

  assert.equal(releaseMutations, 1);
  assert.equal(releaseListReads, 5);
  assert.deepEqual(sleeps, GITHUB_RELEASE_SNAPSHOT_VISIBILITY_DELAYS_MS.slice(0, 2));
});

test("failed draft visibility preserves the original mutation cause without replay", () => {
  const selected = selection(1);
  const headRef = "d".repeat(40);
  const tag = selected[0].tag;
  const tags = new Map([[tag, null]]);
  const mutationFailure = new Error("HTTP 503 after draft POST");
  let releaseMutations = 0;
  const dependencies = {
    mutationOptions,
    mutateRelease: () => {
      releaseMutations += 1;
      throw mutationFailure;
    },
    mutateTag: ({ headRef: target }) => {
      const ref = { ref: `refs/tags/${tag}`, sha: target, type: "commit" };
      tags.set(tag, ref);
      return JSON.stringify({ ref: ref.ref, object: { sha: ref.sha, type: ref.type } });
    },
    readReleaseMap: () => new Map(),
    readTagMap: () => new Map(tags),
    releaseSnapshotSleep: () => {},
  };

  assert.throws(
    () => reconcileSelectedReleasesSync({
      budget: budget(),
      command: "stage",
      environment: {},
      expectedState: "staged",
      headRef,
      repo: "o/r",
      selected,
    }, dependencies),
    (cause) =>
      cause.cause === mutationFailure
      && /original draft mutation failure: HTTP 503 after draft POST/u.test(cause.message)
      && /did not converge to staged state/u.test(cause.message),
  );
  assert.equal(releaseMutations, 1);
});

test("required snapshots retry only a recognized duplicate-across-pagination race", () => {
  const selected = selection(1);
  const headRef = "d".repeat(40);
  const releases = releaseState(selected);
  const tags = tagState(selected, headRef);
  const sleeps = [];
  let reads = 0;

  reconcileSelectedReleasesSync({
    budget: budget(),
    command: "verify",
    environment: {},
    expectedState: "staged",
    headRef,
    repo: "o/r",
    selected,
  }, {
    readReleaseMap: () => {
      reads += 1;
      if (reads === 1) {
        throw new GitHubReleaseSnapshotRaceError(
          "GitHub release list repeated release 1 across one paginated snapshot",
        );
      }
      return new Map(releases);
    },
    readTagMap: () => new Map(tags),
    releaseSnapshotSleep: (milliseconds) => sleeps.push(milliseconds),
  });

  assert.equal(reads, 2);
  assert.deepEqual(sleeps, GITHUB_RELEASE_SNAPSHOT_VISIBILITY_DELAYS_MS.slice(0, 1));
});

test("release-list snapshots receive a strict complete-read budget", () => {
  const selected = selection(1);
  const headRef = "d".repeat(40);
  const releases = releaseState(selected);
  const tags = tagState(selected, headRef);
  const readOptions = [];

  reconcileSelectedReleasesSync({
    budget: budget(),
    command: "verify",
    environment: {},
    expectedState: "staged",
    headRef,
    repo: "o/r",
    selected,
  }, {
    readReleaseMap: (_repo, options) => {
      readOptions.push(options);
      return new Map(releases);
    },
    readTagMap: () => new Map(tags),
  });

  assert.equal(GITHUB_RELEASE_PROMOTION_COMMAND_WINDOW_MS, 645_000);
  assert.equal(
    createReleaseDraftOperationBudget("promote", {
      environment: { OLIPHAUNT_GITHUB_MUTATION_WINDOW_MS: "3600000" },
      now: () => 0,
    }).deadlineMs,
    GITHUB_RELEASE_PROMOTION_COMMAND_WINDOW_MS,
  );
  assert.equal(
    createReleaseDraftOperationBudget("promote", {
      environment: { OLIPHAUNT_GITHUB_MUTATION_WINDOW_MS: "123000" },
      now: () => 0,
    }).deadlineMs,
    123_000,
  );
  assert.equal(readOptions.length, 1);
  assert.equal(readOptions[0].deadlineMs, GITHUB_RELEASE_SNAPSHOT_READ_WINDOW_MS);
  assert.equal(readOptions[0].attemptTimeoutMs, 4_000);
  assert.equal(
    readOptions[0].maxAttempts,
    GITHUB_RELEASE_SNAPSHOT_MAX_READ_ATTEMPTS,
  );
  assert.equal(GITHUB_RELEASE_SNAPSHOT_MAX_READ_ATTEMPTS, 1);
});

test("promotion uses one bounded precondition snapshot and does not wait before mutation", () => {
  const selected = selection(1);
  const headRef = "d".repeat(40);
  let releaseListReads = 0;
  let promotionMutations = 0;
  let sleeps = 0;

  assert.throws(
    () => reconcileSelectedReleasesSync({
      budget: budget(),
      command: "promote",
      environment: {},
      expectedState: "public",
      headRef,
      repo: "o/r",
      selected,
    }, {
      mutatePromotion: () => {
        promotionMutations += 1;
      },
      readReleaseMap: () => {
        releaseListReads += 1;
        return new Map();
      },
      readTagMap: () => tagState(selected, headRef),
      releaseSnapshotSleep: () => {
        sleeps += 1;
      },
    }),
    /does not exist/u,
  );

  assert.equal(releaseListReads, 1);
  assert.equal(promotionMutations, 0);
  assert.equal(sleeps, 0);
});

test("promotion mutation and tag snapshot transports use their conservative sub-bounds", () => {
  const selected = selection(1);
  const headRef = "d".repeat(40);
  const releases = releaseState(selected);
  const observedMutationTimeouts = [];
  const observedTagTimeouts = [];

  reconcileSelectedReleasesSync({
    budget: budget(),
    command: "promote",
    environment: {},
    expectedState: "public",
    headRef,
    repo: "o/r",
    selected,
  }, {
    mutatePromotion: ({ metadata, timeoutMs }) => {
      observedMutationTimeouts.push(timeoutMs);
      const promoted = { ...releases.get(metadata.tag_name), draft: false };
      releases.set(metadata.tag_name, promoted);
      return JSON.stringify(promoted);
    },
    readReleaseMap: () => new Map(releases),
    readTagMap: (_repo, _selected, options) => {
      observedTagTimeouts.push(options?.timeoutMs);
      return tagState(selected, headRef);
    },
  });

  assert.deepEqual(observedMutationTimeouts, [
    GITHUB_RELEASE_PROMOTION_MUTATION_TIMEOUT_MS,
  ]);
  assert.deepEqual(observedTagTimeouts, [
    GITHUB_RELEASE_PROMOTION_TAG_SNAPSHOT_TIMEOUT_MS,
    GITHUB_RELEASE_PROMOTION_TAG_SNAPSHOT_TIMEOUT_MS,
  ]);
  assert.equal(GITHUB_RELEASE_PROMOTION_TAG_SNAPSHOT_TIMEOUT_MS, 30_000);
});

test("verification waits for a semantically complete release snapshot without mutation", () => {
  const selected = selection(2);
  const headRef = "d".repeat(40);
  const releases = releaseState(selected);
  const tags = tagState(selected, headRef);
  const sleeps = [];
  let releaseListReads = 0;

  reconcileSelectedReleasesSync({
    budget: budget(),
    command: "verify",
    environment: {},
    expectedState: "staged",
    headRef,
    repo: "o/r",
    selected,
  }, {
    readReleaseMap: () => {
      releaseListReads += 1;
      if (releaseListReads <= 2) {
        return new Map([...releases].filter(([tag]) => tag !== selected.at(-1).tag));
      }
      return new Map(releases);
    },
    readTagMap: () => new Map(tags),
    releaseSnapshotSleep: (milliseconds) => sleeps.push(milliseconds),
  });

  assert.equal(releaseListReads, 3);
  assert.deepEqual(sleeps, GITHUB_RELEASE_SNAPSHOT_VISIBILITY_DELAYS_MS.slice(0, 2));
});

test("promotion waits for stale draft rows to become public without replaying PATCH", () => {
  const selected = selection(2);
  const headRef = "d".repeat(40);
  const tags = tagState(selected, headRef);
  const releases = releaseState(selected);
  const mutations = [];
  const sleeps = [];
  let releaseListReads = 0;
  const dependencies = {
    mutationOptions,
    mutatePromotion: ({ expectedId, metadata }) => {
      const release = releases.get(metadata.tag_name);
      assert.equal(release.id, expectedId);
      mutations.push(metadata.tag_name);
      const promoted = { ...release, draft: false };
      releases.set(metadata.tag_name, promoted);
      return JSON.stringify(promoted);
    },
    readReleaseMap: () => {
      releaseListReads += 1;
      if (releaseListReads === 1 || releaseListReads >= 4) return new Map(releases);
      const stale = new Map(releases);
      const finalTag = selected.at(-1).tag;
      stale.set(finalTag, { ...stale.get(finalTag), draft: true });
      return stale;
    },
    readTagMap: () => new Map(tags),
    releaseSnapshotSleep: (milliseconds) => sleeps.push(milliseconds),
  };

  reconcileSelectedReleasesSync({
    budget: budget(),
    command: "promote",
    environment: {},
    expectedState: "public",
    headRef,
    repo: "o/r",
    selected,
  }, dependencies);

  assert.deepEqual(mutations, selected.map(({ tag }) => tag));
  assert.equal(releaseListReads, 4);
  assert.deepEqual(sleeps, GITHUB_RELEASE_SNAPSHOT_VISIBILITY_DELAYS_MS.slice(0, 2));
});

test("promotion rejects a same-metadata release id replacement before lifecycle closure", () => {
  const selected = selection(1);
  const headRef = "d".repeat(40);
  const original = releaseState(selected);
  const replacement = new Map([[
    selected[0].tag,
    { ...original.get(selected[0].tag), draft: false, id: 99 },
  ]]);
  let releaseListReads = 0;
  let promotionMutations = 0;
  let sleeps = 0;

  assert.throws(
    () => reconcileSelectedReleasesSync({
      budget: budget(),
      command: "promote",
      environment: {},
      expectedState: "public",
      headRef,
      repo: "o/r",
      selected,
    }, {
      mutatePromotion: ({ expectedId, metadata }) => {
        promotionMutations += 1;
        return JSON.stringify({
          ...original.get(metadata.tag_name),
          draft: false,
          id: expectedId,
        });
      },
      readReleaseMap: () => {
        releaseListReads += 1;
        return releaseListReads === 1 ? new Map(original) : new Map(replacement);
      },
      readTagMap: () => tagState(selected, headRef),
      releaseSnapshotSleep: () => {
        sleeps += 1;
      },
    }),
    /release id changed from 1 to 99/u,
  );

  assert.equal(releaseListReads, 2);
  assert.equal(promotionMutations, 1);
  assert.equal(sleeps, 0);
});

test("required release snapshots fail boundedly when state never becomes visible", () => {
  const selected = selection(1);
  const sleeps = [];
  let releaseListReads = 0;
  assert.throws(
    () => reconcileSelectedReleasesSync({
      budget: budget(),
      command: "verify",
      environment: {},
      expectedState: "staged",
      headRef: "d".repeat(40),
      repo: "o/r",
      selected,
    }, {
      readReleaseMap: () => {
        releaseListReads += 1;
        return new Map();
      },
      readTagMap: () => tagState(selected, "d".repeat(40)),
      releaseSnapshotSleep: (milliseconds) => sleeps.push(milliseconds),
    }),
    new RegExp(
      `did not converge to staged state.*${selected[0].tag} \\(missing\\)`,
      "u",
    ),
  );
  assert.equal(releaseListReads, GITHUB_RELEASE_SNAPSHOT_VISIBILITY_DELAYS_MS.length + 1);
  assert.deepEqual(sleeps, GITHUB_RELEASE_SNAPSHOT_VISIBILITY_DELAYS_MS);
});

test("required release snapshots reject conflicting metadata without waiting", () => {
  const selected = selection(1);
  let sleeps = 0;
  assert.throws(
    () => reconcileSelectedReleasesSync({
      budget: budget(),
      command: "verify",
      environment: {},
      expectedState: "staged",
      headRef: "d".repeat(40),
      repo: "o/r",
      selected,
    }, {
      readReleaseMap: () => new Map([[
        selected[0].tag,
        { ...selected[0].metadata, body: "conflict", draft: true, id: 1 },
      ]]),
      readTagMap: () => tagState(selected, "d".repeat(40)),
      releaseSnapshotSleep: () => {
        sleeps += 1;
      },
    }),
    /conflicts with frozen release metadata/u,
  );
  assert.equal(sleeps, 0);

  assert.throws(
    () => reconcileSelectedReleasesSync({
      budget: budget(),
      command: "verify",
      environment: {},
      expectedState: "staged",
      headRef: "d".repeat(40),
      repo: "o/r",
      selected,
    }, {
      readReleaseMap: () => {
        const observedRelease = {
          ...selected[0].metadata,
          body: "conflict",
          draft: true,
          id: 1,
        };
        throw new GitHubReleaseSnapshotRaceError(
          "duplicate across pages",
          { observedRelease },
        );
      },
      readTagMap: () => tagState(selected, "d".repeat(40)),
      releaseSnapshotSleep: () => {
        sleeps += 1;
      },
    }),
    /conflicts with frozen release metadata/u,
  );
  assert.equal(sleeps, 0);
});

test("batch staging reconciles ambiguous responses once and exact reruns issue no mutations", () => {
  const selected = selection(1);
  const headRef = "d".repeat(40);
  const tag = selected[0].tag;
  const metadata = selected[0].metadata;
  const tags = new Map([[tag, null]]);
  let releases = new Map();
  let tagMutations = 0;
  let releaseMutations = 0;
  const dependencies = {
    mutationOptions,
    mutateRelease: () => {
      releaseMutations += 1;
      releases.set(tag, { ...metadata, draft: true, id: 1 });
      throw new Error("response lost after draft creation");
    },
    mutateTag: () => {
      tagMutations += 1;
      tags.set(tag, { ref: `refs/tags/${tag}`, sha: headRef, type: "commit" });
      throw new Error("response lost after tag creation");
    },
    readRelease: (value) => releases.get(value) ?? null,
    readReleaseMap: () => new Map(releases),
    readTagMap: () => new Map(tags),
    readTagRef: (value) => tags.get(value) ?? null,
  };
  const context = {
    budget: budget(),
    command: "stage",
    environment: {},
    expectedState: "staged",
    headRef,
    repo: "o/r",
    selected,
  };
  reconcileSelectedReleasesSync(context, dependencies);
  assert.equal(tagMutations, 1);
  assert.equal(releaseMutations, 1);

  reconcileSelectedReleasesSync(context, dependencies);
  assert.equal(tagMutations, 1, "an exact rerun does not replay tag creation");
  assert.equal(releaseMutations, 1, "an exact rerun does not replay release creation");
});
