import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";

import { captureCommandOutput } from "../dev/capture-command-output.mjs";
import { moonCommand } from "../dev/moon-command.mjs";
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
  const result = captureCommandOutput(
    moonCommand(environment),
    ["query", "affected", "stdin", "--upstream", "none", "--downstream", "none"],
    {
      cwd: ROOT,
      env: environment,
      input: `${relativePaths.join("\n")}\n`,
      label: `Moon Node-product chaos fixture ${relativePaths.join(", ")}`,
    },
  );
  assert.equal(result.error, undefined, result.error?.message ?? result.stderr);
  assert.equal(result.status, 0, result.stderr);
  const affected = JSON.parse(result.stdout);
  const projects = triggeringProjectNames(affected.projects);
  const tasks = affectedNames(affected.tasks);
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
  assert.equal(result.tasks.includes("oliphaunt-node-direct:release-assets"), false);
  assert.equal(result.tasks.includes("release-tools:metadata"), false);
  assert.equal(result.tasks.includes("release-tools:unit"), false);
});

test("Node Direct source qualifies its addon and downstream JavaScript SDK", () => {
  const result = effects("src/runtimes/node-direct/native/node-addon/oliphaunt_node.cc");
  assert.deepEqual(result.jobs, [
    "affected",
    "js-sdk-package",
    "node-direct",
    "node-direct-release-assets",
  ]);
  assert.deepEqual(result.releaseProducts, ["oliphaunt-node-direct", "oliphaunt-js"]);
  assert.equal(result.tasks.includes("oliphaunt-node-direct:compile"), true);
  assert.equal(result.tasks.includes("oliphaunt-js:unit"), true);
});

test("combined JavaScript SDK and WASIX N-API changes preserve both release closures", () => {
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
    "oliphaunt-wasix-ts",
  ]);
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
  assert.deepEqual(result.releaseProducts, ["oliphaunt-wasix-napi", "oliphaunt-wasix-ts"]);
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
      result.tasks.includes("oliphaunt-wasix-napi:release-assets"),
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
    "oliphaunt-broker:release-assets",
    "oliphaunt-react-native:package-artifacts",
    "oliphaunt-swift:package-artifacts",
    "oliphaunt-wasix-napi:release-assets",
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
    result.tasks.some((target) => /:(aggregate-release-assets|package-artifacts|release-assets)$/u.test(target)),
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
