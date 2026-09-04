import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";

import { captureCommandOutput } from "../dev/capture-command-output.mjs";
import { moonCommand, moonEnvironment } from "../dev/moon-command.mjs";
import { affectedNames, triggeringProjectNames } from "../graph/affected.mjs";
import { planJobsForAffected } from "../graph/ci_plan.mjs";
import { buildPlan, loadGraph, normalizeFiles } from "../release/release-graph.mjs";

const ROOT = path.resolve(import.meta.dir, "../..");
const GRAPH = loadGraph("ci-plan-node-products.test.mjs");

function effects(paths) {
  const relativePaths = Array.isArray(paths) ? paths : [paths];
  const environment = { ...process.env, MOON_CACHE: "off" };
  delete environment.MOON_BASE;
  delete environment.MOON_HEAD;
  const query = (downstream) =>
    captureCommandOutput(
      moonCommand(environment),
      ["query", "affected", "stdin", "--upstream", "none", "--downstream", downstream],
      {
        cwd: ROOT,
        env: moonEnvironment(environment),
        input: `${relativePaths.join("\n")}\n`,
        label: `Moon Node-product chaos fixture ${relativePaths.join(", ")}`,
      },
    );
  const direct = query("none");
  const downstream = query("direct");
  for (const result of [direct, downstream]) {
    assert.equal(result.error, undefined, result.error?.message ?? result.stderr);
    assert.equal(result.status, 0, result.stderr);
  }
  const projects = triggeringProjectNames(JSON.parse(direct.stdout).projects);
  const tasks = affectedNames(JSON.parse(downstream.stdout).tasks);
  return {
    jobs: [...planJobsForAffected(new Set(projects), new Set(tasks))].sort(),
    projects,
    releaseProducts: buildPlan(
      GRAPH,
      normalizeFiles(relativePaths),
      "ci-plan-node-products.test.mjs",
    ).releaseProducts,
    tasks,
  };
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

test("WASIX N-API prose and isolated unit fixtures do not start artifact builders", () => {
  for (const relativePath of [
    "src/runtimes/wasix-napi/README.md",
    "src/runtimes/wasix-napi/tools/portable-command.test.mjs",
  ]) {
    const result = effects(relativePath);
    assert.deepEqual(result.jobs, ["affected"]);
    assert.equal(result.tasks.includes("oliphaunt-wasix-napi:unit"), true);
  }
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
