import assert from "node:assert/strict";
import { execFileSync } from "../test/fd-backed-spawn-sync.mjs";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  compatibilityVersionSource,
  requireCompatibilityVersionBinding,
} from "./compatibility-version-policy.mjs";

const NATIVE = "liboliphaunt-native";
const CONTRIB = "oliphaunt-extension-amcheck";
const EXTERNAL = "oliphaunt-extension-vector";
const SDK = "oliphaunt-js";
const RUNTIME_CONSUMER = "oliphaunt-node-direct";
const PATHS = {
  [NATIVE]: "packages/native",
  [CONTRIB]: "packages/amcheck",
  [EXTERNAL]: "packages/vector",
  [SDK]: "packages/js",
  [RUNTIME_CONSUMER]: "packages/node-direct",
};
const EXTERNAL_ENTRY = {
  id: "vector-native-runtime",
  product: EXTERNAL,
  sourceProduct: NATIVE,
  path: `${PATHS[EXTERNAL]}/release.toml`,
  parser: "toml:compatibility.native",
};

function git(root, ...args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function writeState(root, versions, { compatibilityByProduct = {} } = {}) {
  const releaseManifest = {};
  for (const [product, packagePath] of Object.entries(PATHS)) {
    const directory = path.join(root, packagePath);
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, "VERSION"), `${versions[product]}\n`);
    const compatibility = compatibilityByProduct[product] ?? versions[NATIVE];
    writeFileSync(path.join(directory, "release.toml"), `[compatibility]\nnative = ${JSON.stringify(compatibility)}\n`);
    releaseManifest[packagePath] = versions[product];
  }
  writeFileSync(
    path.join(root, ".release-please-manifest.json"),
    `${JSON.stringify(releaseManifest, null, 2)}\n`,
  );
}

function commit(root, subject) {
  git(root, "add", ".");
  git(root, "commit", "-m", subject);
  return git(root, "rev-parse", "HEAD");
}

function fixture(t, versions) {
  const root = mkdtempSync(path.join(os.tmpdir(), "oliphaunt-compatibility-policy-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, "init", "-q");
  git(root, "config", "user.name", "Release Test");
  git(root, "config", "user.email", "release-test@example.invalid");
  writeFileSync(path.join(root, "legacy.txt"), "legacy\n");
  commit(root, "legacy history");
  writeState(root, versions);
  commit(root, "release state");
  return root;
}

function products(versions) {
  return {
    [NATIVE]: {
      path: PATHS[NATIVE],
      tag_prefix: `${NATIVE}-v`,
      version: versions[NATIVE],
      version_files: [`${PATHS[NATIVE]}/VERSION`],
    },
    [CONTRIB]: {
      path: PATHS[CONTRIB],
      tag_prefix: `${CONTRIB}-v`,
      version: versions[CONTRIB],
      version_files: [`${PATHS[CONTRIB]}/VERSION`],
      extension: { class: "contrib" },
    },
    [EXTERNAL]: {
      path: PATHS[EXTERNAL],
      tag_prefix: `${EXTERNAL}-v`,
      version: versions[EXTERNAL],
      version_files: [`${PATHS[EXTERNAL]}/VERSION`],
      extension: { class: "external" },
    },
    [SDK]: {
      path: PATHS[SDK],
      tag_prefix: `${SDK}-v`,
      version: versions[SDK],
      version_files: [`${PATHS[SDK]}/VERSION`],
      kind: "sdk",
    },
    [RUNTIME_CONSUMER]: {
      path: PATHS[RUNTIME_CONSUMER],
      tag_prefix: `${RUNTIME_CONSUMER}-v`,
      version: versions[RUNTIME_CONSUMER],
      version_files: [`${PATHS[RUNTIME_CONSUMER]}/VERSION`],
      kind: "runtime",
    },
  };
}

const ZERO = Object.fromEntries(Object.keys(PATHS).map((product) => [product, "0.0.0"]));
const V1 = Object.fromEntries(Object.keys(PATHS).map((product) => [product, "1.0.0"]));

test("an untagged external in the first release follows the current runtime", (t) => {
  const root = fixture(t, ZERO);
  const released = Object.fromEntries(Object.keys(PATHS).map((product) => [product, "0.1.0"]));
  writeState(root, released);
  commit(root, "chore(release): first release");

  assert.deepEqual(
    compatibilityVersionSource(EXTERNAL_ENTRY, products(released), new Set([EXTERNAL]), {
      root,
      prefix: "compatibility-test",
    }),
    { kind: "current-source", ref: null, tag: null },
  );
});

test("an unchanged independently versioned external is bound to its immutable current tag", (t) => {
  const root = fixture(t, V1);
  const taggedCommit = git(root, "rev-parse", "HEAD");
  git(root, "tag", `${EXTERNAL}-v1.0.0`);
  const released = { ...V1, [NATIVE]: "1.1.0", [CONTRIB]: "1.1.0" };
  writeState(root, released, { compatibilityByProduct: { [EXTERNAL]: "1.0.0" } });
  commit(root, "chore(release): runtime release");

  assert.deepEqual(
    compatibilityVersionSource(EXTERNAL_ENTRY, products(released), new Set([NATIVE, CONTRIB]), {
      root,
      prefix: "compatibility-test",
    }),
    { kind: "tagged-sink", ref: taggedCommit, tag: `${EXTERNAL}-v1.0.0` },
  );
});

test("a newly bumped external without its not-yet-created tag follows the current runtime", (t) => {
  const root = fixture(t, V1);
  git(root, "tag", `${EXTERNAL}-v1.0.0`);
  const released = { ...V1, [EXTERNAL]: "1.1.0" };
  writeState(root, released);
  commit(root, "chore(release): vector release");

  assert.deepEqual(
    compatibilityVersionSource(EXTERNAL_ENTRY, products(released), new Set([EXTERNAL]), {
      root,
      prefix: "compatibility-test",
    }),
    { kind: "current-source", ref: null, tag: null },
  );
});

test("an unchanged released external without its current immutable tag fails closed", (t) => {
  const root = fixture(t, V1);
  assert.throws(
    () => compatibilityVersionSource(EXTERNAL_ENTRY, products(V1), new Set(), {
      root,
      prefix: "compatibility-test",
    }),
    /version 1[.]0[.]0 has no immutable current-version tag and did not advance in the current release commit/u,
  );
});

test("a current-version tag whose manifest names another version fails closed", (t) => {
  const mismatched = { ...V1, [EXTERNAL]: "0.9.0" };
  const root = fixture(t, mismatched);
  git(root, "tag", `${EXTERNAL}-v1.0.0`);
  writeState(root, V1);
  commit(root, "chore(release): vector 1.0.0");

  assert.throws(
    () => compatibilityVersionSource(EXTERNAL_ENTRY, products(V1), new Set([EXTERNAL]), {
      root,
      prefix: "compatibility-test",
    }),
    /tag .* names 1[.]0[.]0, but its manifest contains "0[.]9[.]0"/u,
  );
});

test("a current-version tag on unrelated history fails closed", (t) => {
  const root = fixture(t, V1);
  const candidate = git(root, "rev-parse", "HEAD");
  git(root, "checkout", "-q", "--orphan", "collision");
  git(root, "rm", "-q", "-rf", ".");
  writeState(root, V1);
  commit(root, "unrelated vector identity");
  git(root, "tag", `${EXTERNAL}-v1.0.0`);
  git(root, "checkout", "-q", "--detach", candidate);

  assert.throws(
    () => compatibilityVersionSource(EXTERNAL_ENTRY, products(V1), new Set(), {
      root,
      headRef: candidate,
      prefix: "compatibility-test",
    }),
    /current-version tag .* is not an ancestor of release candidate/u,
  );
});

test("a release commit cannot reuse a current-version tag from an ancestor", (t) => {
  const root = fixture(t, V1);
  git(root, "tag", `${EXTERNAL}-v1.0.0`);
  const regressed = { ...V1, [EXTERNAL]: "0.9.0" };
  writeState(root, regressed);
  commit(root, "regress vector identity");
  writeState(root, V1);
  commit(root, "chore(release): reuse vector 1.0.0");

  assert.throws(
    () => compatibilityVersionSource(EXTERNAL_ENTRY, products(V1), new Set([EXTERNAL]), {
      root,
      prefix: "compatibility-test",
    }),
    /cannot advance to already-tagged immutable version 1[.]0[.]0/u,
  );
});

test("unchanged SDK and runtime consumer sinks remain bound to their immutable product tags", (t) => {
  const root = fixture(t, V1);
  const taggedCommit = git(root, "rev-parse", "HEAD");
  for (const product of [SDK, RUNTIME_CONSUMER]) git(root, "tag", `${product}-v1.0.0`);
  const released = { ...V1, [NATIVE]: "1.1.0", [CONTRIB]: "1.1.0" };
  writeState(root, released, {
    compatibilityByProduct: {
      [SDK]: "1.0.0",
      [RUNTIME_CONSUMER]: "1.0.0",
    },
  });
  commit(root, "chore(release): runtime release");

  for (const product of [SDK, RUNTIME_CONSUMER]) {
    assert.deepEqual(
      compatibilityVersionSource({ ...EXTERNAL_ENTRY, product }, products(released), new Set([NATIVE, CONTRIB]), {
        root,
        prefix: "compatibility-test",
      }),
      { kind: "tagged-sink", ref: taggedCommit, tag: `${product}-v1.0.0` },
    );
  }
});

test("a newly bumped SDK without its not-yet-created tag follows the current source", (t) => {
  const root = fixture(t, V1);
  git(root, "tag", `${SDK}-v1.0.0`);
  const released = { ...V1, [SDK]: "1.1.0" };
  writeState(root, released);
  commit(root, "chore(release): JS SDK release");

  assert.deepEqual(
    compatibilityVersionSource({ ...EXTERNAL_ENTRY, product: SDK }, products(released), new Set([SDK]), {
      root,
      prefix: "compatibility-test",
    }),
    { kind: "current-source", ref: null, tag: null },
  );
});

test("a transitioned contrib sink follows current source, then binds to its tag on ordinary commits", (t) => {
  const root = fixture(t, V1);
  git(root, "tag", `${CONTRIB}-v1.0.0`);
  const released = { ...V1, [NATIVE]: "1.1.0", [CONTRIB]: "1.1.0" };
  writeState(root, released);
  const releaseCommit = commit(root, "chore(release): linked runtime release");
  const entry = { ...EXTERNAL_ENTRY, product: CONTRIB };

  assert.deepEqual(
    compatibilityVersionSource(entry, products(released), new Set([NATIVE, CONTRIB]), {
      root,
      prefix: "compatibility-test",
    }),
    { kind: "current-source", ref: null, tag: null },
  );

  git(root, "tag", `${CONTRIB}-v1.1.0`);
  writeFileSync(path.join(root, "ordinary-change.txt"), "ordinary change\n");
  commit(root, "docs: ordinary post-release commit");
  assert.deepEqual(
    compatibilityVersionSource(entry, products(released), new Set(), {
      root,
      prefix: "compatibility-test",
    }),
    { kind: "tagged-sink", ref: releaseCommit, tag: `${CONTRIB}-v1.1.0` },
  );
});

test("a tagged external compatibility field cannot drift with a later runtime release", () => {
  assert.throws(
    () => requireCompatibilityVersionBinding({
      id: EXTERNAL_ENTRY.id,
      value: "1.1.0",
      expected: "1.0.0",
      sourceProduct: NATIVE,
      sourceVersion: "1.1.0",
      provenance: `immutable ${EXTERNAL} tag ${EXTERNAL}-v1.0.0`,
    }, { prefix: "compatibility-test" }),
    /compatibility value "1[.]1[.]0" must match immutable .* tag/u,
  );
});

test("a compatibility field cannot claim a future runtime version", () => {
  assert.throws(
    () => requireCompatibilityVersionBinding({
      id: EXTERNAL_ENTRY.id,
      value: "2.0.0",
      expected: "2.0.0",
      sourceProduct: NATIVE,
      sourceVersion: "1.1.0",
      provenance: `${NATIVE} 2.0.0`,
    }, { prefix: "compatibility-test" }),
    /cannot be newer than liboliphaunt-native 1[.]1[.]0/u,
  );
});
