import assert from "node:assert/strict";
import { execFileSync } from "../test/fd-backed-spawn-sync.mjs";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  gitStdout,
  releasePleaseCoverageBootstrapBaseline,
} from "./check_release_pr_coverage.mjs";
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
const UNAFFECTED_PATHS = [
  "src/runtimes/liboliphaunt/native",
  "src/sdks/rust",
  "src/runtimes/broker",
  "src/runtimes/node-direct",
  "src/sdks/swift",
  "src/sdks/kotlin",
  "src/sdks/react-native",
  "src/sdks/js",
  "src/extensions/external/pg_hashids",
  "src/extensions/external/pg_ivm",
  "src/extensions/external/pg_textsearch",
  "src/extensions/external/pg_uuidv7",
  "src/extensions/external/pgtap",
  "src/extensions/external/postgis",
  "src/extensions/external/vector",
  "src/runtimes/liboliphaunt/wasix",
  "src/bindings/wasix-rust/crates/oliphaunt-wasix",
];

function qualificationTransportState() {
  const packages = Object.fromEntries(
    UNAFFECTED_PATHS.map((packagePath, index) => [packagePath, { component: `product-${index}` }]),
  );
  packages[CANONICAL_CONTRIB_PATH] = { component: "oliphaunt-extension-contrib-pg18" };
  return {
    config: {
      "bootstrap-sha": RELEASE_PLEASE_BOOTSTRAP_SHA,
      packages,
    },
    before: {
      ...Object.fromEntries(UNAFFECTED_PATHS.map((packagePath) => [packagePath, "0.0.0"])),
      ...Object.fromEntries(LEGACY_CONTRIB_PATHS.map((packagePath) => [packagePath, "0.0.0"])),
    },
    after: {
      ...Object.fromEntries(UNAFFECTED_PATHS.map((packagePath) => [packagePath, "0.0.0"])),
      [CANONICAL_CONTRIB_PATH]: "0.0.0",
    },
    parents: [RELEASE_PLEASE_DISPLACED_MAIN_SHA],
  };
}

function coverageBaseline(state) {
  return releasePleaseCoverageBootstrapBaseline(
    state.config,
    state.before,
    state.after,
    state.parents,
    { prefix: "coverage-test" },
  );
}

test("git identity reads remove the process newline before exact SHA comparison", (t) => {
  const repo = mkdtempSync(path.join(os.tmpdir(), "oliphaunt-release-coverage-git-"));
  t.after(() => rmSync(repo, { force: true, recursive: true }));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "Release Coverage Test"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "release-coverage@example.invalid"], { cwd: repo });
  writeFileSync(path.join(repo, "fixture"), "release\n");
  execFileSync("git", ["add", "fixture"], { cwd: repo });
  execFileSync("git", ["commit", "-q", "-m", "chore(release): fixture"], { cwd: repo });

  const expected = execFileSync("git", ["rev-parse", "HEAD^{commit}"], {
    cwd: repo,
    encoding: "utf8",
  }).trim();
  const observed = gitStdout(["rev-parse", "HEAD^{commit}"], { cwd: repo });
  assert.equal(observed, expected);
  assert.match(observed, /^[0-9a-f]{40}$/u);
});

test("coverage recognizes the exact production-shaped 49-to-18 qualification transport as a non-release baseline", () => {
  const state = qualificationTransportState();
  const baseline = coverageBaseline(state);
  assert.equal(Object.keys(state.before).length, 49);
  assert.equal(Object.keys(state.after).length, 18);
  assert.equal(baseline?.kind, "qualification-transport");
  assert.equal(baseline?.parentSha, RELEASE_PLEASE_DISPLACED_MAIN_SHA);
  assert.deepEqual(baseline?.normalizedBeforeManifest, state.after);
});

for (const [name, mutate, pattern] of [
  [
    "a missing legacy path",
    (state) => { delete state.before[LEGACY_CONTRIB_PATHS[0]]; },
    /replace exactly the 32 canonical legacy contrib package paths/u,
  ],
  [
    "an extra legacy path",
    (state) => { state.before["src/extensions/contrib/adminpack"] = "0.0.0"; },
    /replace exactly the 32 canonical legacy contrib package paths/u,
  ],
  [
    "a substituted legacy path",
    (state) => {
      delete state.before[LEGACY_CONTRIB_PATHS[0]];
      state.before["src/extensions/contrib/adminpack"] = "0.0.0";
    },
    /replace exactly the 32 canonical legacy contrib package paths/u,
  ],
  [
    "legacy version drift",
    (state) => { state.before[LEGACY_CONTRIB_PATHS[0]] = "0.0.1"; },
    /legacy contrib version continuity/u,
  ],
  [
    "unaffected version drift",
    (state) => { state.before[UNAFFECTED_PATHS[0]] = "0.0.1"; },
    /may change only the contrib package ownership/u,
  ],
  [
    "a released aggregate",
    (state) => { state.after[CANONICAL_CONTRIB_PATH] = "0.1.0"; },
    /valid only for the unreleased 0[.]0[.]0 qualification transport/u,
  ],
  [
    "a consumed bootstrap boundary",
    (state) => { delete state.config["bootstrap-sha"]; },
    /requires bootstrap-sha/u,
  ],
  [
    "a substituted aggregate component",
    (state) => { state.config.packages[CANONICAL_CONTRIB_PATH].component = "substituted"; },
    /component oliphaunt-extension-contrib-pg18/u,
  ],
]) {
  test(`coverage refuses to skip ${name}`, () => {
    const state = qualificationTransportState();
    mutate(state);
    assert.throws(() => coverageBaseline(state), pattern);
  });
}

test("coverage does not broaden the qualification skip to another parent or the first release", () => {
  const wrongParent = qualificationTransportState();
  wrongParent.parents = ["1111111111111111111111111111111111111111"];
  assert.equal(coverageBaseline(wrongParent), null);

  const firstRelease = qualificationTransportState();
  firstRelease.parents = [RELEASE_PLEASE_BOOTSTRAP_SHA];
  delete firstRelease.config["bootstrap-sha"];
  firstRelease.after[CANONICAL_CONTRIB_PATH] = "0.1.0";
  assert.equal(coverageBaseline(firstRelease), null);
});
