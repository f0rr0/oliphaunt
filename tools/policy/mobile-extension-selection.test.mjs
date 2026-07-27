#!/usr/bin/env bun

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "../test/fd-backed-spawn-sync.mjs";
import test from "node:test";

import { extensionSqlNamesForProducts } from "../graph/ci_plan.mjs";
import { exactExtensionProducts } from "../release/release-artifact-targets.mjs";
import { ROOT } from "../release/release-graph.mjs";

const METADATA_FILE = path.join(ROOT, "src/extensions/generated/sdk/react-native.json");
const REGISTRY_FILE = path.join(ROOT, "src/extensions/generated/mobile/static-registry.json");
const MOBILE_HELPER_PROCESS_TIMEOUT_MS = 20_000;
const SHELL = String.raw`
set -euo pipefail
root="$1"
metadata_override="$2"
mode="$3"
selection="$4"
platform="$5"
runtime_root="$6"
fail() {
  printf '%s\n' "$*" >&2
  return 1
}
. "$root/src/sdks/react-native/tools/mobile-extension-runtime.sh"
if [ -n "$metadata_override" ]; then
  oliphaunt_dev_sdk_extension_json() {
    printf '%s\n' "$metadata_override"
  }
fi
case "$mode" in
  normalize)
    oliphaunt_dev_normalize_mobile_extensions "$selection" "$platform"
    ;;
  inspect)
    normalized="$(oliphaunt_dev_normalize_mobile_extensions "$selection" "$platform")"
    static_extensions="$(oliphaunt_dev_mobile_static_extensions_for_selection "$normalized")"
    stems="$(oliphaunt_dev_mobile_module_stems_for_selection "$normalized")"
    registered="$(oliphaunt_dev_mobile_module_extensions_for_selection "$normalized")"
    printf '%s\n%s\n%s\n%s\n' "$normalized" "$static_extensions" "$stems" "$registered"
    ;;
  frameworks)
    oliphaunt_dev_prebuilt_extension_asset_paths_for_selection() {
      printf '%s|%s|%s\n' "$1" "$2" "$3"
    }
    oliphaunt_dev_prebuilt_ios_extension_framework_zips_for_selection "$selection"
    ;;
  unpack-sql-only)
    oliphaunt_dev_prebuilt_extension_asset_paths_for_selection() {
      fail "SQL-only selection unexpectedly requested a native iOS framework"
    }
    mkdir -p "$platform/stale.xcframework"
    oliphaunt_dev_unpack_ios_extension_frameworks_for_selection "$selection" "$platform"
    [ ! -e "$platform" ] || fail "SQL-only selection retained stale native iOS frameworks"
    ;;
  validate-list)
    oliphaunt_dev_assert_runtime_file_list "$selection" "$platform"
    ;;
  validate-tree)
    oliphaunt_dev_assert_runtime_extension_tree "$runtime_root" "$selection" "$platform"
    ;;
  *)
    fail "unknown test mode: $mode"
    ;;
esac
`;

function runHelper(
  mode,
  selection,
  platform,
  { input = undefined, metadataFile = "", runtimeRoot = "" } = {},
) {
  return spawnSync(
    "bash",
    [
      "-c",
      SHELL,
      "mobile-extension-selection-test",
      ROOT,
      metadataFile,
      mode,
      selection,
      platform,
      runtimeRoot,
    ],
    {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, TZ: "UTC" },
      input,
      maxBuffer: 16 * 1024 * 1024,
      timeout: MOBILE_HELPER_PROCESS_TIMEOUT_MS,
    },
  );
}

function packagedRuntimeFileList(extensionFiles, dataFiles = []) {
  return [
    ...extensionFiles.map(
      (file) => `assets/oliphaunt/runtime/files/share/postgresql/extension/${file}`,
    ),
    ...dataFiles.map((file) => `assets/oliphaunt/runtime/files/${file}`),
  ].join("\n");
}

function inspect(selection, platform) {
  const result = runHelper("inspect", selection, platform);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const [normalized = "", staticExtensions = "", stems = "", registered = ""] = result.stdout.split("\n");
  return {
    normalized: normalized.split(",").filter(Boolean),
    staticExtensions: staticExtensions.split(",").filter(Boolean),
    stems: stems.split(",").filter(Boolean),
    registered: registered.split(",").filter(Boolean),
  };
}

function exactPlannerSelection() {
  return extensionSqlNamesForProducts(exactExtensionProducts("mobile-extension-selection-test"));
}

test("the exact planner selection keeps SQL-only pgtap out of native static registration", () => {
  const metadata = JSON.parse(readFileSync(METADATA_FILE, "utf8"));
  const bySqlName = new Map(metadata.extensions.map((row) => [row["sql-name"], row]));
  const selected = exactPlannerSelection();
  const expectedStatic = selected.filter((sqlName) => bySqlName.get(sqlName)?.["native-module-stem"] !== null);
  const expectedStems = expectedStatic.map((sqlName) => bySqlName.get(sqlName)["native-module-stem"]);

  assert(selected.includes("pgtap"), "the canonical planner fixture must cover SQL-only pgtap");
  assert(selected.includes("postgis"), "the public planner must include PostGIS");
  assert(bySqlName.has("postgis"), "the public React Native SDK metadata must include PostGIS");
  const registry = JSON.parse(readFileSync(REGISTRY_FILE, "utf8"));
  assert(registry.modules.some((row) => row["sql-name"] === "postgis"));
  assert.equal(bySqlName.get("pgtap")?.["mobile-release-ready"], true);
  assert.equal(bySqlName.get("pgtap")?.["native-module-stem"], null);

  for (const platform of ["Android", "iOS"]) {
    const result = inspect(selected.join(","), platform);
    assert.deepEqual(result.normalized, selected, `${platform} must retain the exact planner selection`);
    assert.deepEqual(result.staticExtensions, expectedStatic, `${platform} must derive only native static rows`);
    assert.deepEqual(result.registered, expectedStatic, `${platform} must register only native static rows`);
    assert.deepEqual(result.stems, expectedStems, `${platform} must emit exact generated module stems`);
    assert(!result.staticExtensions.includes("pgtap"));
    assert(!result.registered.includes("pgtap"));
  }
});

test("a SQL-only pgtap selection requires resources but no native mobile carrier", () => {
  for (const platform of ["Android", "iOS"]) {
    assert.deepEqual(inspect("pgtap", platform), {
      normalized: ["pgtap"],
      staticExtensions: [],
      stems: [],
      registered: [],
    });
  }

  const frameworks = runHelper("frameworks", "pgtap,vector", "unused");
  assert.equal(frameworks.status, 0, frameworks.stderr || frameworks.stdout);
  assert.equal(frameworks.stdout, "vector|ios-xcframework|ios-xcframework\n");

  const temp = mkdtempSync(path.join(os.tmpdir(), "oliphaunt-sql-only-frameworks-"));
  const destination = path.join(temp, "frameworks");
  try {
    const unpack = runHelper("unpack-sql-only", "pgtap", destination);
    assert.equal(unpack.status, 0, unpack.stderr || unpack.stdout);
  } finally {
    rmSync(temp, { force: true, recursive: true });
  }
});

test("mobile selection closes extension dependencies before carrier projection", () => {
  for (const platform of ["Android", "iOS"]) {
    const result = inspect("earthdistance", platform);
    assert.deepEqual(result.normalized, ["cube", "earthdistance"]);
    assert.deepEqual(result.staticExtensions, ["cube", "earthdistance"]);
    assert.deepEqual(result.registered, ["cube", "earthdistance"]);
    assert.equal(result.stems.length, 2);
  }
});

test("mobile selection rejects unknown extension SQL names", () => {
  const result = runHelper("normalize", "vector,not_a_real_extension", "Android");
  assert.notEqual(result.status, 0, "unknown extension unexpectedly normalized");
  assert.match(`${result.stderr}\n${result.stdout}`, /unsupported mobile extension for Android Expo smoke: not_a_real_extension/u);
});

test("mobile selection enforces explicit platform support without hiding SQL-only extensions", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "oliphaunt-mobile-selection-"));
  try {
    const metadata = JSON.parse(readFileSync(METADATA_FILE, "utf8"));
    const pgtap = metadata.extensions.find((row) => row["sql-name"] === "pgtap");
    assert(pgtap, "missing canonical pgtap metadata fixture");
    pgtap.support.mobile.android = "unsupported";
    pgtap.support.mobile.ios = "supported";
    const fixture = path.join(root, "react-native.json");
    writeFileSync(fixture, `${JSON.stringify(metadata, null, 2)}\n`);

    const android = runHelper("normalize", "pgtap", "Android", { metadataFile: fixture });
    assert.notEqual(android.status, 0, "platform-unsupported pgtap unexpectedly normalized for Android");
    assert.match(`${android.stderr}\n${android.stdout}`, /unsupported mobile extension for Android Expo smoke: pgtap/u);

    const ios = runHelper("normalize", "pgtap", "iOS", { metadataFile: fixture });
    assert.equal(ios.status, 0, ios.stderr || ios.stdout);
    assert.equal(ios.stdout, "pgtap");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("mobile selection rejects unknown platform labels", () => {
  const result = runHelper("normalize", "vector", "desktop");
  assert.notEqual(result.status, 0, "unknown platform unexpectedly normalized");
  assert.match(`${result.stderr}\n${result.stdout}`, /unsupported mobile extension platform: desktop/u);
});

test("mobile runtime inventory accepts pgtap ancillary SQL without inventing extensions", () => {
  const result = runHelper("validate-list", "pgtap", "Android", {
    input: packagedRuntimeFileList([
      "pgtap.control",
      "pgtap--1.3.4.sql",
      "pgtap--1.3.4--1.3.5.sql",
      "pgtap.sql",
      "pgtap-core--1.3.5.sql",
      "pgtap-schema.sql",
      "uninstall_pgtap.sql",
      "plpgsql.control",
      "plpgsql--1.0.sql",
    ]),
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("mobile runtime inventory accepts every declared PostGIS ancillary prefix", () => {
  const registry = JSON.parse(readFileSync(REGISTRY_FILE, "utf8"));
  const postgis = registry.modules.find((row) => row["sql-name"] === "postgis");
  assert(postgis, "missing generated PostGIS mobile registry fixture");
  const result = runHelper("validate-list", "postgis", "iOS", {
    input: packagedRuntimeFileList(
      [
        "postgis.control",
        "postgis--3.6.3.sql",
        "postgis_comments.sql",
        "postgis_proc_set_search_path--3.6.3.sql",
        "rtpostgis.sql",
        "uninstall_postgis.sql",
      ],
      postgis["data-files"],
    ),
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("mobile runtime inventory rejects ancillary SQL owned by an unselected extension", () => {
  const result = runHelper("validate-list", "", "Android", {
    input: packagedRuntimeFileList(["pgtap-core--1.3.5.sql"]),
  });
  assert.notEqual(result.status, 0, "unselected pgtap ancillary SQL unexpectedly passed");
  assert.match(
    `${result.stderr}\n${result.stdout}`,
    /unselected PostgreSQL extension asset: .*pgtap-core--1\.3\.5\.sql/u,
  );
});

test("mobile runtime inventory rejects undeclared and ambiguously owned SQL", () => {
  const undeclared = runHelper("validate-list", "", "Android", {
    input: packagedRuntimeFileList(["foreign--1.0.sql"]),
  });
  assert.notEqual(undeclared.status, 0, "undeclared extension SQL unexpectedly passed");
  assert.match(`${undeclared.stderr}\n${undeclared.stdout}`, /undeclared PostgreSQL extension asset/u);

  const temp = mkdtempSync(path.join(os.tmpdir(), "oliphaunt-mobile-ownership-"));
  try {
    const metadata = JSON.parse(readFileSync(METADATA_FILE, "utf8"));
    const vector = metadata.extensions.find((row) => row["sql-name"] === "vector");
    assert(vector, "missing generated vector metadata fixture");
    vector["extension-sql-file-prefixes"] = ["pgtap-core"];
    const fixture = path.join(temp, "react-native.json");
    writeFileSync(fixture, `${JSON.stringify(metadata, null, 2)}\n`);
    const ambiguous = runHelper("validate-list", "pgtap", "Android", {
      input: packagedRuntimeFileList([
        "pgtap.control",
        "pgtap--1.3.5.sql",
        "pgtap-core--1.3.5.sql",
      ]),
      metadataFile: fixture,
    });
    assert.notEqual(ambiguous.status, 0, "ambiguously owned extension SQL unexpectedly passed");
    assert.match(`${ambiguous.stderr}\n${ambiguous.stdout}`, /ambiguous ownership/u);
  } finally {
    rmSync(temp, { force: true, recursive: true });
  }
});

test("pgtap ancillary SQL cannot satisfy the canonical install-script contract", () => {
  const result = runHelper("validate-list", "pgtap", "Android", {
    input: packagedRuntimeFileList([
      "pgtap.control",
      "pgtap.sql",
      "pgtap-core--1.3.5.sql",
      "pgtap-schema.sql",
      "uninstall_pgtap.sql",
    ]),
  });
  assert.notEqual(result.status, 0, "pgtap ancillary SQL unexpectedly counted as an install script");
  assert.match(`${result.stderr}\n${result.stdout}`, /missing selected pgtap canonical install SQL file/u);
});

test("directory and packaged-list validation share the same ancillary ownership contract", () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), "oliphaunt-mobile-runtime-tree-"));
  try {
    const extensionDirectory = path.join(temp, "share/postgresql/extension");
    mkdirSync(extensionDirectory, { recursive: true });
    for (const file of [
      "pgtap.control",
      "pgtap--1.3.4.sql",
      "pgtap--1.3.4--1.3.5.sql",
      "pgtap-core--1.3.5.sql",
      "pgtap-schema.sql",
      "uninstall_pgtap.sql",
    ]) {
      writeFileSync(
        path.join(extensionDirectory, file),
        file === "pgtap.control" ? "default_version = '1.3.5'\n" : "-- fixture\n",
      );
    }
    const result = runHelper("validate-tree", "pgtap", "Android", { runtimeRoot: temp });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    rmSync(temp, { force: true, recursive: true });
  }
});
