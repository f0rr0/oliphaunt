#!/usr/bin/env bun

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  extensionArtifactsNativeMatrix,
  extensionArtifactsWasixMatrix,
} from "./artifact_target_matrix.mjs";
import {
  extensionQualificationCandidates,
  qualificationCandidateSqlNamesForTarget,
  qualificationCandidateTargets,
} from "./extension-qualification-candidates.mjs";
import { loadPublicationCatalog } from "./publication-catalog.mjs";

const POSTGIS_PRODUCT = "oliphaunt-extension-postgis";
const NATIVE_TARGETS = [
  "android-arm64-v8a",
  "android-x86_64",
  "ios-xcframework",
  "linux-arm64-gnu",
  "linux-x64-gnu",
  "macos-arm64",
  "windows-x64-msvc",
];

function csv(value) {
  return value === "" ? [] : value.split(",");
}

function writeFixture(root, relative, contents) {
  const file = path.join(root, relative);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, contents);
}

function deferredCandidateFixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), "oliphaunt-deferred-extension-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const blocker = "The fixture remains private until its publication contract is deliberately cleared.";
  writeFixture(root, "src/extensions/catalog/extensions.promoted.toml", `
format-version = 1

[[extensions]]
id = "fixture_extension"
build = true
stable = false
blocker = ${JSON.stringify(blocker)}
`.trimStart());
  writeFixture(root, "tools/release/extension-target-profiles.toml", `
schema = "oliphaunt-extension-artifact-target-profiles-v1"

[[profiles]]
id = "native-desktop-v1"
[[profiles.targets]]
family = "native"
kind = "native-dynamic"
target = "linux-x64-gnu"

[[profiles]]
id = "native-mobile-v1"
[[profiles.targets]]
family = "native"
kind = "native-static-registry"
target = "android-arm64-v8a"

[[profiles]]
id = "wasix-portable-v1"
[[profiles.targets]]
family = "wasix"
kind = "wasix-runtime"
target = "wasix-portable"
`.trimStart());
  writeFixture(root, "src/extensions/external/fixture_extension/publication-blocker.toml", "fixture\n");
  writeFixture(root, "src/extensions/external/fixture_extension/recipe.toml", `
sql_name = "fixture_extension"
source = "fixture_extension"
`.trimStart());
  writeFixture(root, "src/extensions/external/fixture_extension/source.toml", `
name = "fixture_extension"
commit = "0123456789abcdef0123456789abcdef01234567"

[extension-control]
sql-name = "fixture_extension"
default-version = "1.2.3"
`.trimStart());
  writeFixture(root, "src/extensions/external/fixture_extension/targets/artifacts.toml", `
schema = "oliphaunt-extension-artifact-targets-v1"
profiles = ["native-desktop-v1", "native-mobile-v1", "wasix-portable-v1"]
`.trimStart());
  return { blocker, root };
}

test("the live tree has no deferred qualification candidates", () => {
  assert.deepEqual(extensionQualificationCandidates(), []);
  const qualificationRows = readFileSync(
    "src/extensions/generated/mobile/qualification-static-extensions.tsv",
    "utf8",
  )
    .split(/\r?\n/u)
    .filter((line) => line && !line.startsWith("#") && !line.startsWith("sql-name\t"));
  assert.deepEqual(qualificationRows, []);
});

test("derives a fixture candidate identity and all declared qualification targets", (t) => {
  const { blocker, root } = deferredCandidateFixture(t);
  const candidates = extensionQualificationCandidates({ root });
  assert.equal(candidates.length, 1);
  const [candidate] = candidates;
  assert.deepEqual(
    {
      schema: candidate.schema,
      extensionId: candidate.extensionId,
      sqlName: candidate.sqlName,
      sourceName: candidate.sourceName,
      sourceVersion: candidate.sourceVersion,
      sourceCommit: candidate.sourceCommit,
      requested: candidate.requested,
      stable: candidate.stable,
      targetProfiles: candidate.targetProfiles,
    },
    {
      schema: "oliphaunt-extension-qualification-candidate-v1",
      extensionId: "fixture_extension",
      sqlName: "fixture_extension",
      sourceName: "fixture_extension",
      sourceVersion: "1.2.3",
      sourceCommit: "0123456789abcdef0123456789abcdef01234567",
      requested: true,
      stable: false,
      targetProfiles: ["native-desktop-v1", "native-mobile-v1", "wasix-portable-v1"],
    },
  );
  assert.equal(candidate.blocker, blocker);
  assert.deepEqual(
    qualificationCandidateTargets(candidate, { root }).map(
      ({ family, target, kind }) => `${family}:${target}:${kind}`,
    ),
    [
      "native:android-arm64-v8a:native-static-registry",
      "native:linux-x64-gnu:native-dynamic",
      "wasix:wasix-portable:wasix-runtime",
    ],
  );
  assert.deepEqual(
    qualificationCandidateSqlNamesForTarget("linux-x64-gnu", { family: "native", root }),
    ["fixture_extension"],
  );
  assert.deepEqual(
    qualificationCandidateSqlNamesForTarget("wasix-portable", { family: "wasix", root }),
    ["fixture_extension"],
  );
});

test("keeps live build matrices candidate-free and PostGIS public", () => {
  const native = extensionArtifactsNativeMatrix().include;
  assert.deepEqual(native.map(({ target }) => target), NATIVE_TARGETS);
  for (const row of native) {
    assert.deepEqual(csv(row.qualification_sql_names_csv), []);
    assert.equal(csv(row.sql_names_csv).length, 39);
    assert.equal(csv(row.sql_names_csv).includes("postgis"), true);
    assert.equal(csv(row.extensions_csv).includes(POSTGIS_PRODUCT), true);
  }

  const wasix = extensionArtifactsWasixMatrix().include;
  assert.equal(wasix.length, 1);
  assert.equal(wasix[0].target, "wasix-portable");
  assert.deepEqual(csv(wasix[0].qualification_sql_names_csv), []);
  assert.equal(csv(wasix[0].sql_names_csv).length, 39);
  assert.equal(csv(wasix[0].sql_names_csv).includes("postgis"), true);
  assert.equal(csv(wasix[0].extensions_csv).includes(POSTGIS_PRODUCT), true);
});

test("keeps PostGIS in every public publication and generated runtime surface", () => {
  const catalog = loadPublicationCatalog("extension-qualification-candidates.test.mjs");
  assert.equal(catalog.products.length, 18);
  assert.equal(catalog.carriers.length, 186);
  assert.equal(catalog.products.some(({ id }) => id === POSTGIS_PRODUCT), true);
  assert.equal(catalog.carriers.filter(({ product }) => product === POSTGIS_PRODUCT).length, 17);

  for (const file of [
    "src/extensions/generated/mobile/static-extensions.tsv",
    "src/extensions/generated/mobile/static-registry.json",
    "src/extensions/generated/wasix/extensions.json",
    "src/extensions/generated/sdk/js.json",
    "src/extensions/generated/sdk/kotlin.json",
    "src/extensions/generated/sdk/react-native.json",
    "src/extensions/generated/sdk/rust.json",
    "src/extensions/generated/sdk/swift.json",
  ]) {
    assert.match(readFileSync(file, "utf8"), /postgis/u, `${file} must expose public PostGIS support`);
  }
});
