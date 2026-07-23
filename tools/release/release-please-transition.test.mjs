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
  requireCompleteRuntimeLinkedTransitions,
} from "./release-please-transition.mjs";
import {
  RELEASE_PLEASE_BOOTSTRAP_SHA,
  RELEASE_PLEASE_DISPLACED_MAIN_SHA,
} from "./release-please-bootstrap.mjs";

const CANONICAL_CONTRIB_PATH = "src/extensions/contrib";
const LEGACY_CONTRIB_PATHS = [
  "src/extensions/contrib/amcheck",
  "src/extensions/contrib/auto_explain",
  "src/extensions/contrib/bloom",
  "src/extensions/contrib/btree_gin",
  "src/extensions/contrib/btree_gist",
  "src/extensions/contrib/citext",
  "src/extensions/contrib/cube",
  "src/extensions/contrib/dict_int",
  "src/extensions/contrib/dict_xsyn",
  "src/extensions/contrib/earthdistance",
  "src/extensions/contrib/file_fdw",
  "src/extensions/contrib/fuzzystrmatch",
  "src/extensions/contrib/hstore",
  "src/extensions/contrib/intarray",
  "src/extensions/contrib/isn",
  "src/extensions/contrib/lo",
  "src/extensions/contrib/ltree",
  "src/extensions/contrib/pageinspect",
  "src/extensions/contrib/pg_buffercache",
  "src/extensions/contrib/pg_freespacemap",
  "src/extensions/contrib/pg_surgery",
  "src/extensions/contrib/pg_trgm",
  "src/extensions/contrib/pg_visibility",
  "src/extensions/contrib/pg_walinspect",
  "src/extensions/contrib/pgcrypto",
  "src/extensions/contrib/seg",
  "src/extensions/contrib/tablefunc",
  "src/extensions/contrib/tcn",
  "src/extensions/contrib/tsm_system_rows",
  "src/extensions/contrib/tsm_system_time",
  "src/extensions/contrib/unaccent",
  "src/extensions/contrib/uuid_ossp",
];
const HISTORY_REPAIR_RUNTIME_PATH = "src/runtimes/liboliphaunt/native";

const PRODUCT_PATHS = {
  "liboliphaunt-native": "packages/native",
  "liboliphaunt-wasix": "packages/wasix",
  "oliphaunt-extension-amcheck": "packages/amcheck",
  "oliphaunt-extension-vector": "packages/vector",
};

const PRODUCTS = {
  "liboliphaunt-native": { path: PRODUCT_PATHS["liboliphaunt-native"] },
  "liboliphaunt-wasix": { path: PRODUCT_PATHS["liboliphaunt-wasix"] },
  "oliphaunt-extension-amcheck": {
    path: PRODUCT_PATHS["oliphaunt-extension-amcheck"],
    extension: { class: "contrib" },
  },
  "oliphaunt-extension-vector": {
    path: PRODUCT_PATHS["oliphaunt-extension-vector"],
    extension: { class: "external" },
  },
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

function historyRepairContribState() {
  return {
    config: {
      "bootstrap-sha": RELEASE_PLEASE_BOOTSTRAP_SHA,
      packages: {
        [HISTORY_REPAIR_RUNTIME_PATH]: { component: "liboliphaunt-native" },
        [CANONICAL_CONTRIB_PATH]: { component: "oliphaunt-extension-contrib-pg18" },
      },
    },
    before: {
      [HISTORY_REPAIR_RUNTIME_PATH]: "0.0.0",
      ...Object.fromEntries(LEGACY_CONTRIB_PATHS.map((packagePath) => [packagePath, "0.0.0"])),
    },
    after: {
      [HISTORY_REPAIR_RUNTIME_PATH]: "0.0.0",
      [CANONICAL_CONTRIB_PATH]: "0.0.0",
    },
  };
}

function historyRepairTransitions(state, parentSha = RELEASE_PLEASE_DISPLACED_MAIN_SHA) {
  return releasePleaseManifestTransitions(state.config, state.before, state.after, {
    parentSha,
    prefix: "transition-test",
  });
}

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

test("the exact displaced-main contrib consolidation is an unchanged bootstrap baseline", () => {
  assert.deepEqual(historyRepairTransitions(historyRepairContribState()), []);
});

for (const [name, mutate] of Object.entries({
  missing: (state) => {
    delete state.before[LEGACY_CONTRIB_PATHS[0]];
  },
  extra: (state) => {
    state.before["src/extensions/contrib/adminpack"] = "0.0.0";
  },
  substituted: (state) => {
    delete state.before[LEGACY_CONTRIB_PATHS[0]];
    state.before["src/extensions/contrib/adminpack"] = "0.0.0";
  },
})) {
  test(`the displaced-main contrib baseline rejects ${name} legacy paths`, () => {
    const state = historyRepairContribState();
    mutate(state);
    assert.throws(
      () => historyRepairTransitions(state),
      /must replace exactly the 32 canonical legacy contrib package paths and no other package path/u,
    );
  });
}

for (const [name, mutate] of Object.entries({
  "a changed legacy leaf": (state) => {
    state.before[LEGACY_CONTRIB_PATHS[0]] = "0.1.0";
  },
  "a released aggregate": (state) => {
    state.after[CANONICAL_CONTRIB_PATH] = "0.1.0";
  },
  "a changed unaffected product": (state) => {
    state.before[HISTORY_REPAIR_RUNTIME_PATH] = "0.1.0";
  },
})) {
  test(`the displaced-main contrib baseline rejects ${name}`, () => {
    const state = historyRepairContribState();
    mutate(state);
    assert.throws(
      () => historyRepairTransitions(state),
      /version continuity|unreleased 0[.]0[.]0|may change only the contrib package ownership/u,
    );
  });
}

test("the contrib consolidation rejects a wrong parent", () => {
  assert.throws(
    () => historyRepairTransitions(
      historyRepairContribState(),
      "1111111111111111111111111111111111111111",
    ),
    /package paths cannot disappear across normalization/u,
  );
});

test("the contrib consolidation rejects missing parent context", () => {
  const state = historyRepairContribState();
  assert.throws(
    () => releasePleaseManifestTransitions(
      state.config,
      state.before,
      state.after,
      { prefix: "transition-test" },
    ),
    /package paths cannot disappear across normalization/u,
  );
});

test("the contrib consolidation rejects a wrong bootstrap boundary", () => {
  const state = historyRepairContribState();
  state.config["bootstrap-sha"] = "1111111111111111111111111111111111111111";
  assert.throws(
    () => historyRepairTransitions(state),
    /requires bootstrap-sha/u,
  );
});

test("the contrib consolidation rejects a substituted canonical component", () => {
  const state = historyRepairContribState();
  state.config.packages[CANONICAL_CONTRIB_PATH].component = "oliphaunt-extension-amcheck";
  assert.throws(
    () => historyRepairTransitions(state),
    /component oliphaunt-extension-contrib-pg18/u,
  );
});

test("a lookalike consolidation on an arbitrary Git parent remains forbidden", (t) => {
  const root = fixture(t);
  const state = historyRepairContribState();
  writeFileSync(
    path.join(root, "release-please-config.json"),
    `${JSON.stringify(state.config, null, 2)}\n`,
  );
  writeFileSync(
    path.join(root, ".release-please-manifest.json"),
    `${JSON.stringify(state.before, null, 2)}\n`,
  );
  commit(root, "legacy contrib release ownership");
  writeFileSync(
    path.join(root, ".release-please-manifest.json"),
    `${JSON.stringify(state.after, null, 2)}\n`,
  );
  commit(root, "lookalike contrib consolidation");

  assert.throws(
    () => releasePleaseWorktreeTransitions(root, { prefix: "transition-test" }),
    /package paths cannot disappear across normalization/u,
  );
});

test("the first release deterministically advances the complete linked group", (t) => {
  const root = fixture(t, ZERO);
  const released = Object.fromEntries(Object.keys(PRODUCT_PATHS).map((product) => [product, "0.1.0"]));
  writeReleaseState(root, released);
  commit(root, "chore(release): first release");

  const transitions = releasePleaseWorktreeTransitions(root, { prefix: "transition-test" });
  assert.deepEqual(transitions.map(({ product }) => product), Object.keys(PRODUCT_PATHS).sort());
  assert.equal(requireCompleteRuntimeLinkedTransitions(PRODUCTS, transitions, { prefix: "transition-test" }), "0.1.0");
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
  assert.equal(requireCompleteRuntimeLinkedTransitions(PRODUCTS, transitions, { prefix: "transition-test" }), "1.1.0");

  const entries = [
    { id: "contrib-native", product: "oliphaunt-extension-amcheck" },
    { id: "external-native", product: "oliphaunt-extension-vector" },
  ];
  assert.deepEqual(
    compatibilityEntriesForBumpedProducts(entries, transitions).map(({ id }) => id),
    ["contrib-native"],
  );
});

test("an incomplete linked group fails before derived synchronization", (t) => {
  const root = fixture(t, V1);
  writeReleaseState(root, { ...V1, "liboliphaunt-native": "1.1.0" });
  commit(root, "chore(release): incomplete runtime release");
  const transitions = releasePleaseWorktreeTransitions(root, { prefix: "transition-test" });

  assert.throws(
    () => requireCompleteRuntimeLinkedTransitions(PRODUCTS, transitions, { prefix: "transition-test" }),
    /linked-versions output is incomplete.*liboliphaunt-wasix.*oliphaunt-extension-amcheck/u,
  );
});

test("linked products cannot advance to divergent versions", (t) => {
  const root = fixture(t, V1);
  writeReleaseState(root, {
    ...V1,
    "liboliphaunt-native": "1.1.0",
    "liboliphaunt-wasix": "1.2.0",
    "oliphaunt-extension-amcheck": "1.2.0",
  });
  commit(root, "chore(release): divergent runtime release");
  const transitions = releasePleaseWorktreeTransitions(root, { prefix: "transition-test" });

  assert.throws(
    () => requireCompleteRuntimeLinkedTransitions(PRODUCTS, transitions, { prefix: "transition-test" }),
    /must advance every runtime-tied product to one version; got 1[.]1[.]0, 1[.]2[.]0/u,
  );
});

test("an external-only release does not force the runtime linked group", (t) => {
  const root = fixture(t, V1);
  writeReleaseState(root, { ...V1, "oliphaunt-extension-vector": "1.1.0" });
  commit(root, "chore(release): vector release");
  const transitions = releasePleaseWorktreeTransitions(root, { prefix: "transition-test" });

  assert.equal(requireCompleteRuntimeLinkedTransitions(PRODUCTS, transitions, { prefix: "transition-test" }), null);
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
