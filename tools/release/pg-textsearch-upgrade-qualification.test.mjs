#!/usr/bin/env bun

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { nativeExtensionQualificationPlan } from "./native-extension-qualification.mjs";

function writeFixture(root, relative, contents) {
  const file = path.join(root, relative);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, contents.trimStart());
}

function qualificationFixture(t, { runner = "tests/upgrade.sh", sqlName = "fixture_search" } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "oliphaunt-native-extension-qualification-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFixture(root, "src/extensions/external/fixture_search/source.toml", `
name = "fixture_search"
commit = "1111111111111111111111111111111111111111"

[extension-control]
sql-name = "fixture_search"
default-version = "2.0.0"
`);
  writeFixture(root, "src/extensions/external/fixture_search/tests/upgrade.sh", "#!/usr/bin/env bash\nexit 0\n");
  writeFixture(root, "src/extensions/external/fixture_search/tests/upgrade/source.toml", `
name = "fixture_search_upgrade_1_0_0"
url = "https://example.invalid/fixture-search.git"
branch = "v1.0.0"
commit = "2222222222222222222222222222222222222222"

[extension-control]
sql-name = "${sqlName}"
source-path = "fixture_search.control"
default-version = "1.0.0"

[qualification]
schema = "oliphaunt-extension-upgrade-qualification-v1"
targets = ["linux-x64-gnu"]
runner = "${runner}"
`);
  writeFixture(root, "src/extensions/external/fixture_search/tests/upstream.toml", `
schema = "oliphaunt-extension-upstream-tests-v1"
runner = "pgxs-installcheck"
status = "required"
reason = "The complete PGXS regression suite is required for this fixture."
targets = ["linux-x64-gnu"]
locale = "C.UTF-8"
included_suites = ["regress"]
suite_target_prefix = "test-"
aggregate_suites = ["test-all", "test-shell"]
excluded_suites = ["test-replication"]
shared_preload_libraries = ["fixture_search"]
`);
  return root;
}

test("the live plan derives the complete pg_textsearch Linux qualification", () => {
  const rows = nativeExtensionQualificationPlan({
    target: "linux-x64-gnu",
    selectedSqlNames: "pg_textsearch",
  });
  assert.deepEqual(rows, [
    {
      kind: "upgrade",
      sqlName: "pg_textsearch",
      target: "linux-x64-gnu",
      runner: "src/extensions/external/pg_textsearch/tests/upgrade.sh",
      sourceName: "pg_textsearch_upgrade_from",
      sourceCommit: "07936f7cd67f7a183659d3acd459c0a5efc93756",
      sourceControlPath: "pg_textsearch.control",
      fromVersion: "0.6.1",
      manifest: "src/extensions/external/pg_textsearch/tests/upgrade/source.toml",
    },
    {
      kind: "upstream",
      sqlName: "pg_textsearch",
      target: "linux-x64-gnu",
      runner: "pgxs-installcheck",
      sourceName: "pg_textsearch",
      sourceCommit: "578ff529894992fb9e67cae4c69424e65c84868e",
      locale: "C.UTF-8",
      includedSuites: ["regress"],
      suiteTargetPrefix: "test-",
      aggregateSuites: ["test-all", "test-local", "test-shell"],
      excludedSuites: [
        "test-cic",
        "test-concurrency",
        "test-logical-replication",
        "test-multi-index",
        "test-recovery",
        "test-reindex",
        "test-replication",
        "test-replication-extended",
        "test-segment",
        "test-stress",
      ],
      preloadLibraries: ["pg_textsearch"],
      manifest: "src/extensions/external/pg_textsearch/tests/upstream.toml",
    },
  ]);
});

test("the live plan is selected by extension and declared target", () => {
  assert.deepEqual(nativeExtensionQualificationPlan({
    target: "windows-x64-msvc",
    selectedSqlNames: "pg_textsearch",
  }), []);
  assert.deepEqual(nativeExtensionQualificationPlan({
    target: "linux-x64-gnu",
    selectedSqlNames: "vector",
  }), []);
});

test("the planner parses generic upgrade and upstream manifests", (t) => {
  const root = qualificationFixture(t);
  assert.deepEqual(nativeExtensionQualificationPlan({
    root,
    target: "linux-x64-gnu",
    selectedSqlNames: ["fixture_search"],
  }), [
    {
      kind: "upgrade",
      sqlName: "fixture_search",
      target: "linux-x64-gnu",
      runner: "src/extensions/external/fixture_search/tests/upgrade.sh",
      sourceName: "fixture_search_upgrade_1_0_0",
      sourceCommit: "2222222222222222222222222222222222222222",
      sourceControlPath: "fixture_search.control",
      fromVersion: "1.0.0",
      manifest: "src/extensions/external/fixture_search/tests/upgrade/source.toml",
    },
    {
      kind: "upstream",
      sqlName: "fixture_search",
      target: "linux-x64-gnu",
      runner: "pgxs-installcheck",
      sourceName: "fixture_search",
      sourceCommit: "1111111111111111111111111111111111111111",
      locale: "C.UTF-8",
      includedSuites: ["regress"],
      suiteTargetPrefix: "test-",
      aggregateSuites: ["test-all", "test-shell"],
      excludedSuites: ["test-replication"],
      preloadLibraries: ["fixture_search"],
      manifest: "src/extensions/external/fixture_search/tests/upstream.toml",
    },
  ]);
});

test("the planner rejects transition identity drift and escaping runners", (t) => {
  const identityRoot = qualificationFixture(t, { sqlName: "another_extension" });
  assert.throws(
    () => nativeExtensionQualificationPlan({
      root: identityRoot,
      target: "linux-x64-gnu",
      selectedSqlNames: "fixture_search",
    }),
    /extension-control[.]sql-name must equal fixture_search/u,
  );

  const runnerRoot = qualificationFixture(t, { runner: "../../outside.sh" });
  assert.throws(
    () => nativeExtensionQualificationPlan({
      root: runnerRoot,
      target: "linux-x64-gnu",
      selectedSqlNames: "fixture_search",
    }),
    /qualification[.]runner must remain beneath/u,
  );
});
