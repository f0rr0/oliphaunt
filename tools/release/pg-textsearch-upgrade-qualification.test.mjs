#!/usr/bin/env bun
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dir, "../..");
const upgrade = readFileSync(
  path.join(root, "src/extensions/external/pg_textsearch/tests/upgrade.sh"),
  "utf8",
);
const upgradeSource = readFileSync(
  path.join(root, "src/extensions/external/pg_textsearch/tests/upgrade/source.toml"),
  "utf8",
);
const nativePackager = readFileSync(
  path.join(root, "src/extensions/artifacts/native/tools/package-release-assets.sh"),
  "utf8",
);

test("pg_textsearch qualification proves the pinned upgrade lifecycle", () => {
  assert.match(upgrade, /old_version="0[.]6[.]1"/u);
  assert.match(upgrade, /old_commit="07936f7cd67f7a183659d3acd459c0a5efc93756"/u);
  assert.match(upgradeSource, /name = "pg_textsearch_upgrade_0_6_1"/u);
  assert.match(upgradeSource, /branch = "v0[.]6[.]1"/u);
  assert.match(upgradeSource, /commit = "07936f7cd67f7a183659d3acd459c0a5efc93756"/u);
  assert.match(upgrade, /source-fetch-native-runtime dependency/u);
  assert.doesNotMatch(upgrade, /fetch-pinned-git-checkout/u);
  assert.match(upgrade, /CREATE EXTENSION pg_textsearch VERSION '0[.]6[.]1'/u);
  assert.match(upgrade, /pre-upgrade query with the current library/u);
  assert.match(upgrade, /ALTER EXTENSION pg_textsearch UPDATE/u);
  assert.match(upgrade, /INSERT INTO upgrade_docs VALUES/u);
  assert.match(upgrade, /bm25_force_merge/u);
  assert.match(upgrade, /pg_dump/u);
  assert.match(upgrade, /pg_textsearch_upgrade_restore/u);
});

test("the Linux x64 exact pg_textsearch candidate runs upgrade qualification", () => {
  assert.match(
    nativePackager,
    /\[ "\$target_id" = "linux-x64-gnu" \] && selected_sql_name_matches "pg_textsearch"/u,
  );
  assert.match(
    nativePackager,
    /OLIPHAUNT_PG_TEXTSEARCH_CURRENT_RUNTIME="\$source_runtime"[\s\S]*src\/extensions\/external\/pg_textsearch\/tests\/upgrade[.]sh/u,
  );
});
