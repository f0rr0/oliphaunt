import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "../test/fd-backed-spawn-sync.mjs";
import { afterEach, test } from "node:test";

import { extensionSqlNames } from "./release-artifact-targets.mjs";

const ROOT = path.resolve(import.meta.dir, "../..");
const TEST_BASH = process.env.OLIPHAUNT_TEST_BASH
  ? path.resolve(ROOT, process.env.OLIPHAUNT_TEST_BASH)
  : (process.platform === "darwin" ? "/bin/bash" : "bash");
const RELEASE_SCRIPT = "src/extensions/artifacts/packages/tools/package-release-assets.sh";
const MOBILE_SCRIPT = "src/extensions/artifacts/packages/tools/package-mobile-release-assets.sh";
const WASIX_ASSET_PACKAGER = "src/extensions/artifacts/wasix/tools/package-release-assets.mjs";
const CONTRIB_PRODUCT = "oliphaunt-extension-contrib-pg18";
const roots = [];

function fixtureRun(script, { environment = {}, failTool = "" } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "oliphaunt-extension-package-"));
  roots.push(root);
  const initialized = spawnSync("git", ["init", "--quiet"], { cwd: root, encoding: "utf8" });
  assert.equal(initialized.status, 0, initialized.stderr);

  const toolDirectory = path.join(root, "tools/dev");
  mkdirSync(toolDirectory, { recursive: true });
  const callsFile = path.join(root, "calls.txt");
  const bunShim = path.join(toolDirectory, "bun.sh");
  writeFileSync(bunShim, `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$OLIPHAUNT_TEST_CALLS_FILE"
if [[ "\${OLIPHAUNT_TEST_FAIL_TOOL:-}" == "$1" ]]; then
  exit 73
fi
`);
  chmodSync(bunShim, 0o755);

  const execution = spawnSync(TEST_BASH, [path.join(ROOT, script)], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      ...environment,
      OLIPHAUNT_TEST_CALLS_FILE: callsFile,
      OLIPHAUNT_TEST_FAIL_TOOL: failTool,
    },
  });
  const calls = existsSync(callsFile)
    ? readFileSync(callsFile, "utf8").trimEnd().split("\n")
    : [];
  return { calls, execution };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

test("full extension assembly validates exactly the planner-selected products and all targets", () => {
  const { calls, execution } = fixtureRun(RELEASE_SCRIPT, {
    environment: {
      OLIPHAUNT_EXTENSION_PACKAGE_PRODUCTS:
        "oliphaunt-extension-postgis, oliphaunt-extension-vector",
    },
  });
  assert.equal(execution.status, 0, execution.stderr);
  assert.deepEqual(calls, [
    "tools/release/build-extension-ci-artifacts.mjs --all --require-native --require-wasix",
    "tools/release/check-staged-artifacts.mjs --require-full-extension-targets --require-extension-product oliphaunt-extension-postgis --require-extension-product oliphaunt-extension-vector",
  ]);
});

test("full extension assembly requires every product when no focused selection exists", () => {
  const { calls, execution } = fixtureRun(RELEASE_SCRIPT);
  assert.equal(execution.status, 0, execution.stderr);
  assert.deepEqual(calls, [
    "tools/release/build-extension-ci-artifacts.mjs --all --require-native --require-wasix",
    "tools/release/check-staged-artifacts.mjs --require-full-extension-targets --require-extension-product all",
  ]);
});

test("extension assembly stops after producer failure and propagates validator failure", () => {
  const producerFailure = fixtureRun(RELEASE_SCRIPT, {
    failTool: "tools/release/build-extension-ci-artifacts.mjs",
  });
  assert.equal(producerFailure.execution.status, 73);
  assert.deepEqual(producerFailure.calls, [
    "tools/release/build-extension-ci-artifacts.mjs --all --require-native --require-wasix",
  ]);

  const validatorFailure = fixtureRun(RELEASE_SCRIPT, {
    failTool: "tools/release/check-staged-artifacts.mjs",
  });
  assert.equal(validatorFailure.execution.status, 73);
  assert.deepEqual(validatorFailure.calls, [
    "tools/release/build-extension-ci-artifacts.mjs --all --require-native --require-wasix",
    "tools/release/check-staged-artifacts.mjs --require-full-extension-targets --require-extension-product all",
  ]);
});

test("mobile contrib assembly scopes both staging and validation to native carriers", () => {
  const { calls, execution } = fixtureRun(MOBILE_SCRIPT, {
    environment: {
      OLIPHAUNT_EXTENSION_PACKAGE_NATIVE_TARGETS: "android-arm64-v8a,ios-xcframework",
      OLIPHAUNT_EXTENSION_PACKAGE_PRODUCTS: "oliphaunt-extension-contrib-pg18",
    },
    failTool: "tools/release/check-staged-artifacts.mjs",
  });
  assert.equal(execution.status, 73);
  assert.deepEqual(calls, [
    "tools/release/build-extension-ci-artifacts.mjs --family native oliphaunt-extension-contrib-pg18 --require-native-target android-arm64-v8a --require-native-target ios-xcframework",
    "tools/release/check-staged-artifacts.mjs --family native --require-extension-product oliphaunt-extension-contrib-pg18",
  ]);
});

test("mobile extension assembly rejects delimiter-only selections without nounset errors", () => {
  const emptyProducts = fixtureRun(MOBILE_SCRIPT, {
    environment: {
      OLIPHAUNT_EXTENSION_PACKAGE_NATIVE_TARGETS: "android-arm64-v8a",
      OLIPHAUNT_EXTENSION_PACKAGE_PRODUCTS: ", ,",
    },
  });
  assert.equal(emptyProducts.execution.status, 1);
  assert.match(emptyProducts.execution.stderr, /did not contain any products/u);
  assert.doesNotMatch(emptyProducts.execution.stderr, /unbound variable/u);

  const emptyTargets = fixtureRun(MOBILE_SCRIPT, {
    environment: {
      OLIPHAUNT_EXTENSION_PACKAGE_NATIVE_TARGETS: ", ,",
      OLIPHAUNT_EXTENSION_PACKAGE_PRODUCTS: "oliphaunt-extension-postgis",
    },
  });
  assert.equal(emptyTargets.execution.status, 1);
  assert.match(emptyTargets.execution.stderr, /did not contain any targets/u);
  assert.doesNotMatch(emptyTargets.execution.stderr, /unbound variable/u);
});

test("WASIX release staging resolves runtime-owned contrib through its logical artifact product", () => {
  const fixture = mkdtempSync(path.join(tmpdir(), "oliphaunt-wasix-extension-package-"));
  roots.push(fixture);
  const assetRoot = path.join(fixture, "assets");
  const extensionRoot = path.join(assetRoot, "extensions");
  const metadataPath = path.join(fixture, "extensions.json");
  const outDir = path.join(fixture, "out");
  mkdirSync(extensionRoot, { recursive: true });

  const sqlNames = extensionSqlNames(CONTRIB_PRODUCT, "extension-package-assembly.test");
  const extensions = sqlNames.map((sqlName) => {
    const archive = `extensions/${sqlName}.tar.zst`;
    writeFileSync(path.join(assetRoot, archive), `archive:${sqlName}\n`);
    return { "sql-name": sqlName, archive };
  });
  writeFileSync(metadataPath, `${JSON.stringify({ extensions }, null, 2)}\n`);

  const execution = spawnSync(
    TEST_BASH,
    [
      path.join(ROOT, "tools/dev/bun.sh"),
      path.join(ROOT, WASIX_ASSET_PACKAGER),
      "--root",
      ROOT,
      "--asset-root",
      assetRoot,
      "--metadata",
      metadataPath,
      "--out-dir",
      outDir,
      "--target",
      "wasix-portable",
      "--extension-products",
      CONTRIB_PRODUCT,
    ],
    { cwd: ROOT, encoding: "utf8" },
  );

  assert.equal(execution.status, 0, execution.stderr);
  assert.match(execution.stdout, new RegExp(`staged ${sqlNames.length} WASIX exact-extension artifact`));
  const staged = readdirSync(outDir).sort();
  assert.equal(staged.length, sqlNames.length + 1);
  const index = staged.find((entry) => entry.endsWith("-wasix-extension-assets.tsv"));
  assert.ok(index);
  const indexedSqlNames = readFileSync(path.join(outDir, index), "utf8")
    .trimEnd()
    .split("\n")
    .slice(1)
    .map((line) => line.split("\t", 1)[0])
    .sort();
  assert.deepEqual(indexedSqlNames, sqlNames);
});
