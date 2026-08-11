import assert from "node:assert/strict";
import { execFileSync } from "../test/fd-backed-spawn-sync.mjs";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  compatibilityEntriesForBumpedProducts,
  releasePleaseManifestTransitions,
  releasePleaseWorktreeTransitions,
} from "./release-please-transition.mjs";

const PRODUCT_PATHS = {
  "liboliphaunt-native": "packages/native",
  "liboliphaunt-wasix": "packages/wasix",
  "oliphaunt-extension-amcheck": "packages/amcheck",
  "oliphaunt-extension-vector": "packages/vector",
};

function git(root, ...args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function manifest(versions) {
  return Object.fromEntries(
    Object.entries(PRODUCT_PATHS).map(([product, packagePath]) => [packagePath, versions[product]]),
  );
}

function writeReleaseState(root, versions) {
  const config = {
    packages: Object.fromEntries(
      Object.entries(PRODUCT_PATHS).map(([product, packagePath]) => [packagePath, { component: product }]),
    ),
  };
  writeFileSync(path.join(root, "release-please-config.json"), `${JSON.stringify(config, null, 2)}\n`);
  writeFileSync(
    path.join(root, ".release-please-manifest.json"),
    `${JSON.stringify(manifest(versions), null, 2)}\n`,
  );
}

function commit(root, subject) {
  git(root, "add", ".");
  git(root, "commit", "-m", subject);
  return git(root, "rev-parse", "HEAD");
}

function fixture(t, versions = null) {
  const root = mkdtempSync(path.join(os.tmpdir(), "oliphaunt-release-please-transition-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, "init", "-q");
  git(root, "config", "user.name", "Release Test");
  git(root, "config", "user.email", "release-test@example.invalid");
  writeFileSync(path.join(root, "legacy.txt"), "legacy history\n");
  commit(root, "legacy history");
  if (versions !== null) {
    for (const directory of Object.values(PRODUCT_PATHS)) mkdirSync(path.join(root, directory), { recursive: true });
    writeReleaseState(root, versions);
    commit(root, "feat: introduce products");
  }
  return root;
}

const ZERO = Object.fromEntries(Object.keys(PRODUCT_PATHS).map((product) => [product, "0.0.0"]));
const V1 = Object.fromEntries(Object.keys(PRODUCT_PATHS).map((product) => [product, "1.0.0"]));

test("the unreleased introduction may have no parent release manifest", (t) => {
  const root = fixture(t);
  for (const directory of Object.values(PRODUCT_PATHS)) mkdirSync(path.join(root, directory), { recursive: true });
  writeReleaseState(root, ZERO);
  commit(root, "feat: introduce oliphaunt");

  assert.deepEqual(releasePleaseWorktreeTransitions(root, { prefix: "transition-test" }), []);
});

test("a missing parent manifest cannot conceal already-released versions", (t) => {
  const root = fixture(t);
  for (const directory of Object.values(PRODUCT_PATHS)) mkdirSync(path.join(root, directory), { recursive: true });
  writeReleaseState(root, V1);
  commit(root, "invalid introduction");

  assert.throws(
    () => releasePleaseWorktreeTransitions(root, { prefix: "transition-test" }),
    /missing parent release-please manifest is valid only for the unreleased 0[.]0[.]0 introduction state/u,
  );
});

test("the first release reports every product that advanced", (t) => {
  const root = fixture(t, ZERO);
  const released = Object.fromEntries(Object.keys(PRODUCT_PATHS).map((product) => [product, "0.1.0"]));
  writeReleaseState(root, released);
  commit(root, "chore(release): first release");

  const transitions = releasePleaseWorktreeTransitions(root, { prefix: "transition-test" });
  assert.deepEqual(transitions.map(({ product }) => product), Object.keys(PRODUCT_PATHS).sort());
});

test("a post-first runtime release leaves an independently versioned external sink untouched", (t) => {
  const root = fixture(t, V1);
  const released = {
    ...V1,
    "liboliphaunt-native": "1.1.0",
    "liboliphaunt-wasix": "1.1.0",
    "oliphaunt-extension-amcheck": "1.1.0",
  };
  writeReleaseState(root, released);
  commit(root, "chore(release): runtime release");

  const transitions = releasePleaseWorktreeTransitions(root, { prefix: "transition-test" });
  assert.deepEqual(
    transitions.map(({ product }) => product),
    ["liboliphaunt-native", "liboliphaunt-wasix", "oliphaunt-extension-amcheck"],
  );
  const entries = [
    { id: "contrib-native", product: "oliphaunt-extension-amcheck" },
    { id: "external-native", product: "oliphaunt-extension-vector" },
  ];
  assert.deepEqual(
    compatibilityEntriesForBumpedProducts(entries, transitions).map(({ id }) => id),
    ["contrib-native"],
  );
});

test("native can advance without WASIX or contrib", (t) => {
  const root = fixture(t, V1);
  writeReleaseState(root, { ...V1, "liboliphaunt-native": "1.1.0" });
  commit(root, "chore(release): incomplete runtime release");
  const transitions = releasePleaseWorktreeTransitions(root, { prefix: "transition-test" });

  assert.deepEqual(transitions.map(({ product }) => product), ["liboliphaunt-native"]);
});

test("independent products can advance to divergent versions", (t) => {
  const root = fixture(t, V1);
  writeReleaseState(root, {
    ...V1,
    "liboliphaunt-native": "1.1.0",
    "liboliphaunt-wasix": "1.2.0",
    "oliphaunt-extension-amcheck": "1.2.0",
  });
  commit(root, "chore(release): divergent runtime release");
  const transitions = releasePleaseWorktreeTransitions(root, { prefix: "transition-test" });

  assert.deepEqual(
    transitions.map(({ product, after }) => [product, after]),
    [
      ["liboliphaunt-native", "1.1.0"],
      ["liboliphaunt-wasix", "1.2.0"],
      ["oliphaunt-extension-amcheck", "1.2.0"],
    ],
  );
});

test("an external-only release remains independent", (t) => {
  const root = fixture(t, V1);
  writeReleaseState(root, { ...V1, "oliphaunt-extension-vector": "1.1.0" });
  commit(root, "chore(release): vector release");
  const transitions = releasePleaseWorktreeTransitions(root, { prefix: "transition-test" });

  assert.deepEqual(transitions.map(({ product }) => product), ["oliphaunt-extension-vector"]);
});

test("a manifest regression fails closed", (t) => {
  const root = fixture(t, V1);
  writeReleaseState(root, { ...V1, "oliphaunt-extension-vector": "0.9.0" });
  commit(root, "regress vector");

  assert.throws(
    () => releasePleaseWorktreeTransitions(root, { prefix: "transition-test" }),
    /oliphaunt-extension-vector manifest version regressed from 1[.]0[.]0 to 0[.]9[.]0/u,
  );
});
