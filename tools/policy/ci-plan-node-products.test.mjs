import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";

import { captureCommandOutput } from "../dev/capture-command-output.mjs";
import { moonCommand, moonEnvironment } from "../dev/moon-command.mjs";
import { affectedNames, triggeringProjectNames, triggeringTaskNames } from "../graph/affected.mjs";
import { planJobsForAffected } from "../graph/ci_plan.mjs";
import { buildPlan, loadGraph, normalizeFiles } from "../release/release-graph.mjs";

const ROOT = path.resolve(import.meta.dir, "../..");
const GRAPH = loadGraph("ci-plan-node-products.test.mjs");

function effects(paths) {
  const relativePaths = Array.isArray(paths) ? paths : [paths];
  const environment = { ...process.env, MOON_CACHE: "off" };
  delete environment.MOON_BASE;
  delete environment.MOON_HEAD;
  const result = captureCommandOutput(
    moonCommand(environment),
    ["query", "affected", "stdin", "--upstream", "none", "--downstream", "direct"],
    {
      cwd: ROOT,
      env: moonEnvironment(environment),
      input: `${relativePaths.join("\n")}\n`,
      label: `Moon Node-product chaos fixture ${relativePaths.join(", ")}`,
    },
  );
  assert.equal(result.error, undefined, result.error?.message ?? result.stderr);
  assert.equal(result.status, 0, result.stderr);
  const affected = JSON.parse(result.stdout);
  const projects = triggeringProjectNames(affected.projects);
  const directTasks = triggeringTaskNames(affected.tasks);
  const tasks = affectedNames(affected.tasks);
  return {
    directTasks,
    jobs: [...planJobsForAffected(new Set(directTasks))].sort(),
    projects,
    releaseProducts: buildPlan(
      GRAPH,
      normalizeFiles(relativePaths),
      "ci-plan-node-products.test.mjs",
    ).releaseProducts,
    tasks,
  };
}

function actionTargets(target) {
  const result = captureCommandOutput(moonCommand(), ["task-graph", target, "--json"], {
    cwd: ROOT,
    env: moonEnvironment(),
    label: `Moon action graph for ${target}`,
  });
  assert.equal(result.status, 0, result.stderr);
  return new Set(Object.values(JSON.parse(result.stdout).data).map((task) => task.target));
}

function taskRecord(target) {
  const result = captureCommandOutput(moonCommand(), ["task-graph", target, "--json"], {
    cwd: ROOT,
    env: moonEnvironment(),
    label: `Moon task record for ${target}`,
  });
  assert.equal(result.status, 0, result.stderr);
  return Object.values(JSON.parse(result.stdout).data).find((task) => task.target === target);
}

test("JavaScript SDK source does not rebuild the Node Direct addon", () => {
  const result = effects("src/sdks/js/src/client.ts");
  assert.deepEqual(result.jobs, ["affected", "js-sdk-package"]);
  assert.deepEqual(result.releaseProducts, ["oliphaunt-js"]);
  assert.equal(result.tasks.includes("oliphaunt-js:compile"), true);
  assert.equal(result.tasks.includes("oliphaunt-js:unit"), true);
  assert.equal(result.tasks.includes("release-tools:node-direct-runtime"), false);
  assert.equal(result.tasks.includes("release-tools:metadata"), false);
  assert.equal(result.tasks.includes("release-tools:unit"), false);
});

test("product prose selects packaging and the cold action graph includes required compilation", () => {
  const javascript = effects("src/sdks/js/README.md");
  assert.deepEqual(javascript.jobs, ["affected", "js-sdk-package"]);
  assert.equal(javascript.tasks.includes("oliphaunt-js:package"), true);
  for (const target of [
    "coverage-tools:js",
    "integration-examples:js-sdk-smoke",
    "oliphaunt-js:compile",
    "oliphaunt-js:unit",
    "sdk-contracts:native-boundaries",
  ]) {
    assert.equal(javascript.tasks.includes(target), false, `${target} does not consume SDK prose`);
  }
  const actions = actionTargets("release-tools:js-sdk-package");
  assert.equal(actions.has("oliphaunt-js:package"), true);
  assert.equal(actions.has("oliphaunt-js:compile"), true);
  assert.equal(actions.has("oliphaunt-js:unit"), false);

  const napi = effects("src/runtimes/wasix-napi/README.md");
  assert.deepEqual(napi.jobs, ["affected"]);
  assert.equal(napi.tasks.includes("oliphaunt-wasix-napi:unit"), false);
});

test("shared implementation documentation has no product consumers", () => {
  const result = effects("src/shared/js-core/README.md");
  assert.deepEqual(result.jobs, ["affected"]);
  assert.equal(result.tasks.includes("shared-js-core:check"), false);
  assert.equal(result.tasks.includes("shared-js-core:test"), false);
  assert.equal(result.tasks.some((target) => target.endsWith(":compile")), false);
});

test("extension evidence validates evidence without rebuilding products", () => {
  const result = effects("src/extensions/evidence/runs/2026-06-07-transitional-catalog-smoke.json");
  assert.equal(result.tasks.includes("extensions:lint"), true);
  assert.equal(result.tasks.includes("docs:check"), true);
  assert.equal(result.tasks.includes("sdk-contracts:fixtures"), false);
  for (const job of [
    "extension-artifacts-native",
    "extension-artifacts-wasix",
    "native-extension-lifecycle",
  ]) {
    assert.equal(result.jobs.includes(job), false, `${job} does not consume evidence records`);
  }
});

test("Node Direct source does not rebuild the independently versioned JavaScript SDK", () => {
  const result = effects("src/runtimes/node-direct/native/node-addon/oliphaunt_node.cc");
  assert.deepEqual(result.jobs, [
    "affected",
    "node-direct",
    "node-direct-release-assets",
  ]);
  assert.deepEqual(result.releaseProducts, ["oliphaunt-node-direct"]);
  assert.equal(result.tasks.includes("oliphaunt-node-direct:compile"), true);
  assert.equal(result.tasks.includes("oliphaunt-js:unit"), false);
});

test("native implementation does not compile the version-decoupled broker", () => {
  const result = effects("src/runtimes/liboliphaunt/native/src/liboliphaunt_process.c");
  assert.equal(result.tasks.includes("oliphaunt-broker:compile"), false);
  assert.equal(result.tasks.includes("liboliphaunt-native:lint"), false);
  assert.equal(result.tasks.includes("oliphaunt-rust:regression"), true);
  assert.equal(result.tasks.includes("oliphaunt-swift:smoke"), true);
});

test("combined JavaScript SDK and WASIX N-API changes release only changed products", () => {
  const result = effects([
    "src/runtimes/wasix-napi/src/lib.rs",
    "src/sdks/js/src/client.ts",
  ]);
  assert.deepEqual(result.jobs, [
    "affected",
    "extension-artifacts-wasix",
    "js-sdk-package",
    "liboliphaunt-wasix-aot",
    "liboliphaunt-wasix-runtime",
    "wasix-napi",
    "wasix-napi-release-assets",
    "wasix-ts-sdk-package",
  ]);
  assert.deepEqual(result.releaseProducts, [
    "oliphaunt-js",
    "oliphaunt-wasix-napi",
  ]);
});

test("shared contrib source releases only its two runtime owners", () => {
  const release = buildPlan(
    GRAPH,
    ["src/extensions/contrib/postgres18.toml"],
    "ci-plan-node-products.test.mjs",
  );
  assert.deepEqual(release.directProducts, ["liboliphaunt-native", "liboliphaunt-wasix"]);
  assert.deepEqual(release.releaseProducts, ["liboliphaunt-native", "liboliphaunt-wasix"]);
});

test("WASIX N-API source selects only its real WASIX artifact inputs", () => {
  const result = effects("src/runtimes/wasix-napi/src/lib.rs");
  assert.deepEqual(result.jobs, [
    "affected",
    "extension-artifacts-wasix",
    "liboliphaunt-wasix-aot",
    "liboliphaunt-wasix-runtime",
    "wasix-napi",
    "wasix-napi-release-assets",
    "wasix-ts-sdk-package",
  ]);
  assert.deepEqual(result.releaseProducts, ["oliphaunt-wasix-napi"]);
  assert.equal(result.tasks.includes("oliphaunt-wasix-napi:format-check"), true);
  assert.equal(result.tasks.includes("oliphaunt-wasix-napi:unit"), true);
});

test("WASIX N-API isolated unit fixtures do not start artifact builders", () => {
  const result = effects("src/runtimes/wasix-napi/tools/portable-command.test.mjs");
  assert.deepEqual(result.jobs, ["affected"]);
  assert.equal(result.tasks.includes("oliphaunt-wasix-napi:unit"), true);
});

test("WASIX test helpers invalidate only tasks that execute them", () => {
  const result = effects("src/runtimes/liboliphaunt/wasix/tools/cargo-test-filter.sh");
  for (const target of [
    "liboliphaunt-wasix:runtime-aot",
    "liboliphaunt-wasix:smoke",
    "liboliphaunt-wasix:regression",
  ]) {
    assert.equal(result.directTasks.includes(target), true, `${target} executes the helper`);
  }
  for (const target of [
    "coverage-tools:wasix-rust",
    "extension-artifacts-wasix:build-target",
    "liboliphaunt-wasix:assets-verify",
    "liboliphaunt-wasix:release-assets",
    "liboliphaunt-wasix:runtime-portable",
    "perf-tools:wasix-browser-measure",
    "perf-tools:wasix-node-measure",
  ]) {
    assert.equal(result.directTasks.includes(target), false, `${target} does not execute the helper`);
  }
});

test("WASIX extension staging follows its own code and produced runtime artifact", () => {
  const packager = effects("src/extensions/artifacts/wasix/tools/package-release-assets.mjs");
  assert.equal(packager.directTasks.includes("extension-artifacts-wasix:build-target"), true);

  const runtimeVersion = effects("src/runtimes/liboliphaunt/wasix/VERSION");
  assert.equal(runtimeVersion.directTasks.includes("extension-artifacts-wasix:build-target"), true);

  const releaseMetadata = effects("src/runtimes/liboliphaunt/wasix/release.toml");
  assert.equal(releaseMetadata.directTasks.includes("extension-artifacts-wasix:build-target"), false);
  assert.equal(releaseMetadata.directTasks.includes("release-tools:wasix-napi-runtime"), true);
});

test("extension artifact builders materialize overlapping source scopes once", () => {
  const native = actionTargets("extension-artifacts-native:build-target");
  assert.equal(native.has("source-inputs:source-fetch-native-runtime"), true);
  assert.equal(native.has("source-inputs:source-fetch-extensions"), false);

  const wasix = actionTargets("extension-artifacts-wasix:build-target");
  assert.equal(wasix.has("source-inputs:source-fetch-wasix-runtime"), true);
  assert.equal(wasix.has("source-inputs:source-fetch-extensions"), false);
});

test("executable packagers and Rust test configuration select their real owners", () => {
  const nativeExtensions = effects("src/extensions/artifacts/native/tools/package-release-assets.sh");
  assert.equal(nativeExtensions.directTasks.includes("extension-artifacts-native:build-target"), true);
  assert.equal(nativeExtensions.jobs.includes("extension-artifacts-native"), true);

  const mobile = effects("tools/release/package-liboliphaunt-mobile-assets.sh");
  for (const target of [
    "liboliphaunt-native:package-runtime-android-arm64-v8a",
    "liboliphaunt-native:package-runtime-android-x86_64",
    "liboliphaunt-native:package-runtime-ios-xcframework",
  ]) {
    assert.equal(mobile.directTasks.includes(target), true, `${target} executes the mobile packager`);
  }
  assert.equal(mobile.directTasks.some((target) => target.includes(":build-runtime-android-")), false);
  assert.equal(mobile.directTasks.includes("liboliphaunt-native:build-runtime-ios-xcframework"), false);

  const desktop = effects("tools/release/package-liboliphaunt-linux-assets.sh");
  assert.equal(desktop.directTasks.includes("liboliphaunt-native:package-runtime-desktop-target"), true);
  assert.equal(desktop.directTasks.includes("liboliphaunt-native:build-runtime-desktop-target"), false);

  const nextest = effects(".config/nextest.toml");
  assert.equal(nextest.directTasks.includes("coverage-tools:rust"), true);
  assert.equal(nextest.directTasks.includes("oliphaunt-rust:unit-distinct"), true);
  assert.equal(nextest.directTasks.includes("oliphaunt-rust:unit-shared"), true);
  assert.equal(taskRecord("oliphaunt-rust:unit-shared").options.runInCI, false);
  assert.equal(nextest.directTasks.includes("coverage-tools:wasix-rust"), true);
  assert.equal(nextest.directTasks.includes("oliphaunt-wasix-rust:unit-distinct"), true);
  assert.equal(nextest.directTasks.includes("oliphaunt-wasix-rust:unit-shared"), true);
  assert.equal(taskRecord("oliphaunt-wasix-rust:unit-shared").options.runInCI, false);
});

test("coverage owns shared hosted suites while distinct product checks remain selected", () => {
  const reactNative = effects("src/sdks/react-native/src/index.ts");
  for (const target of [
    "coverage-tools:react-native",
    "oliphaunt-react-native:unit-distinct",
    "oliphaunt-react-native:unit-shared",
  ]) {
    assert.equal(reactNative.directTasks.includes(target), true, target);
  }
  assert.equal(taskRecord("oliphaunt-react-native:unit-shared").options.runInCI, false);

  const wasixRust = effects("src/bindings/wasix-rust/crates/oliphaunt-wasix/src/lib.rs");
  for (const target of [
    "coverage-tools:wasix-rust",
    "oliphaunt-wasix-rust:unit-distinct",
    "oliphaunt-wasix-rust:unit-shared",
  ]) {
    assert.equal(wasixRust.directTasks.includes(target), true, target);
  }
  assert.equal(taskRecord("oliphaunt-wasix-rust:unit-shared").options.runInCI, false);
});

test("source acquisition and WASIX browser-host ownership stay narrow", () => {
  const extensionPin = effects("src/extensions/external/vector/source.toml");
  assert.equal(extensionPin.directTasks.includes("source-inputs:source-fetch-extensions"), true);
  assert.equal(extensionPin.directTasks.includes("source-inputs:source-fetch-native-runtime"), true);
  assert.equal(extensionPin.directTasks.includes("source-inputs:source-fetch-wasix-runtime"), true);

  const browserHost = effects("src/bindings/wasix-ts/host/source.toml");
  assert.equal(browserHost.directTasks.includes("oliphaunt-wasix-ts:browser-host"), true);
  assert.equal(browserHost.tasks.includes("oliphaunt-wasix-ts:package"), true);
  assert.equal(browserHost.jobs.includes("wasix-ts-sdk-package"), true);

  const cargoLock = effects("Cargo.lock");
  assert.equal(cargoLock.directTasks.includes("oliphaunt-wasix-ts:browser-host"), true);
});

test("docs changes select the production artifact and built-site smoke", () => {
  const result = effects("src/docs/src/app/docs/layout.tsx");
  assert.equal(result.directTasks.includes("docs:build"), true);
  assert.equal(result.tasks.includes("docs:smoke"), true);
});

test("WASIX N-API production helpers keep the release builder affected", () => {
  for (const relativePath of [
    "src/bindings/wasix-ts/tools/pgwire-client.mjs",
    "src/runtimes/wasix-napi/tools/portable-command.mjs",
    "tools/dev/deno.sh",
    "tools/release/wasix-aot-manifest.mjs",
  ]) {
    const result = effects(relativePath);
    assert.equal(
      result.tasks.includes("release-tools:wasix-napi-runtime"),
      true,
      `${relativePath} must invalidate the WASIX N-API release builder`,
    );
    assert.equal(result.jobs.includes("wasix-napi-release-assets"), true);
  }
});

test("CI planner changes select the focused graph proof", () => {
  const result = effects("tools/graph/ci_plan.mjs");
  assert.equal(result.tasks.includes("release-tools:graph-unit"), true);
  assert.equal(result.tasks.includes("release-tools:unit"), false);
});

test("release mutation tests follow release helpers, not policy or workflow files", () => {
  for (const relativePath of ["tools/policy/format.sh", ".github/workflows/ci.yml"]) {
    const result = effects(relativePath);
    assert.equal(result.tasks.includes("release-tools:unit"), false);
    if (relativePath === "tools/policy/format.sh") {
      assert.equal(result.tasks.includes("policy-tools:unit"), false);
    }
  }
  const result = effects(".github/scripts/release-candidate-lib.mjs");
  assert.equal(result.tasks.includes("release-tools:unit"), true);
  assert.equal(result.tasks.includes("release-tools:graph-unit"), false);
});

test("workflow changes run workflow checks without rebuilding product artifacts", () => {
  const result = effects(".github/workflows/ci.yml");
  assert.deepEqual(result.jobs, ["affected"]);
  assert.equal(result.tasks.includes("ci-workflows:check"), true);
  assert.equal(result.tasks.includes("release-tools:metadata"), true);
});

test("release helper changes invalidate only their product artifacts", () => {
  const kotlin = effects("tools/release/sdk-artifacts/kotlin.mjs");
  assert.deepEqual(kotlin.jobs, [
    "affected",
    "extension-artifacts-native",
    "kotlin-maven-staging",
    "kotlin-sdk-package",
    "liboliphaunt-native-android",
    "liboliphaunt-native-ios",
    "mobile-build-android",
    "mobile-extension-packages",
    "react-native-sdk-package",
  ]);

  const nodeDirect = effects("tools/release/check-node-direct-release-assets.mjs");
  assert.deepEqual(nodeDirect.jobs, ["affected", "node-direct", "node-direct-release-assets"]);
});

test("product Moon topology selects the focused release graph proof", () => {
  const result = effects("src/sdks/js/moon.yml");
  assert.deepEqual(result.jobs, ["affected", "js-sdk-package"]);
  assert.equal(result.tasks.includes("release-tools:graph-unit"), true);
  assert.equal(result.tasks.includes("release-tools:unit"), false);
});

test("JavaScript release metadata does not rebuild unrelated products", () => {
  const result = effects("src/sdks/js/release.toml");
  assert.deepEqual(result.jobs, ["affected", "js-sdk-package"]);
  assert.deepEqual(result.releaseProducts, ["oliphaunt-js"]);
  assert.equal(result.tasks.includes("release-tools:graph-unit"), true);
  assert.equal(result.tasks.includes("release-tools:metadata"), true);
  assert.equal(result.tasks.includes("release-tools:unit"), false);
  for (const target of [
    "release-tools:broker-runtime",
    "release-tools:react-native-sdk-package",
    "release-tools:swift-sdk-package",
    "release-tools:wasix-napi-runtime",
  ]) {
    assert.equal(result.tasks.includes(target), false, `${target} is unrelated to the JavaScript SDK`);
  }
});

test("release-please bookkeeping does not rebuild product artifacts", () => {
  const result = effects(".release-please-manifest.json");
  assert.deepEqual(result.jobs, ["affected"]);
  assert.equal(result.tasks.includes("release-tools:graph-unit"), true);
  assert.equal(result.tasks.includes("release-tools:metadata"), true);
  assert.equal(result.tasks.includes("release-tools:unit"), false);
  assert.equal(
    result.tasks.some((target) => /:(aggregate-release-assets|package-artifacts|release-assets|[a-z-]+-sdk-package)$/u.test(target)),
    false,
  );
});

test("extension sources select shared builders without leaf package wrappers", () => {
  for (const relativePath of [
    "src/extensions/external/pg_uuidv7/source.toml",
    "src/extensions/contrib/carriers.toml",
  ]) {
    const result = effects(relativePath);
    for (const job of [
      "extension-artifacts-native",
      "extension-artifacts-wasix",
      "extension-packages",
    ]) {
      assert.equal(result.jobs.includes(job), true, `${relativePath} must select ${job}`);
    }
    assert.equal(
      result.tasks.some((target) => /^oliphaunt-extension-[^:]+:package$/u.test(target)),
      false,
      `${relativePath} must not need a duplicate leaf package task`,
    );
  }
});

test("extension package tooling invalidates packaging without changing builders", () => {
  const result = effects("src/extensions/artifacts/packages/tools/package-release-assets.sh");
  assert.equal(result.tasks.includes("extension-packages:package"), true);
  assert.equal(result.tasks.includes("extension-packages:package-mobile"), false);
  for (const target of [
    "extension-artifacts-native:build-target",
    "extension-artifacts-wasix:build-target",
    "liboliphaunt-wasix:runtime-portable",
    "oliphaunt-rust:extension-regression",
  ]) {
    assert.equal(result.tasks.includes(target), false, `${target} does not consume package tooling`);
  }
});
