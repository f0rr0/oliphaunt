#!/usr/bin/env bun
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  dependentReleaseClosure,
  planDependentReleaseCandidates,
  synchronizeDependentReleaseCandidates,
  withDependentReleaseClosure,
} from "./release-dependent-candidates.mjs";
import { buildPlan, loadGraph } from "./release-graph.mjs";

const NATIVE = "liboliphaunt-native";
const WASIX = "liboliphaunt-wasix";
const CONTRIB = "oliphaunt-extension-contrib-pg18";
const WASIX_RUST = "oliphaunt-wasix-rust";
const RUST = "oliphaunt-rust";
const BROKER = "oliphaunt-broker";
const JS = "oliphaunt-js";
const SWIFT = "oliphaunt-swift";
const REACT_NATIVE = "oliphaunt-react-native";
const EXTERNAL = "oliphaunt-extension-vector";

function product(id, version = "1.0.0", extra = {}) {
  return {
    path: `packages/${id}`,
    version,
    version_files: [`packages/${id}/VERSION`],
    ...extra,
  };
}

function project(id, dependsOn = [], dependencyScopes = {}) {
  return {
    id,
    source: `packages/${id}`,
    dependsOn,
    dependencyScopes,
  };
}

function topologyGraph(overrides = {}) {
  const versions = overrides.versions ?? {};
  const products = {
    [NATIVE]: product(NATIVE, versions[NATIVE]),
    [WASIX]: product(WASIX, versions[WASIX]),
    [CONTRIB]: product(CONTRIB, versions[CONTRIB], { extension: { class: "contrib" } }),
    [WASIX_RUST]: product(WASIX_RUST, versions[WASIX_RUST]),
    [RUST]: product(RUST, versions[RUST], {
      compatibility_versions: {
        broker_protocol: { source_product: BROKER },
      },
    }),
    [BROKER]: product(BROKER, versions[BROKER]),
    [JS]: product(JS, versions[JS]),
    [SWIFT]: product(SWIFT, versions[SWIFT]),
    [REACT_NATIVE]: product(REACT_NATIVE, versions[REACT_NATIVE]),
    [EXTERNAL]: product(EXTERNAL, versions[EXTERNAL], {
      extension: { class: "external" },
      compatibility_versions: {
        native_runtime: { source_product: NATIVE },
        wasix_runtime: { source_product: WASIX },
      },
    }),
  };
  const moon_projects = {
    [NATIVE]: project(NATIVE),
    [WASIX]: project(WASIX),
    [CONTRIB]: project(
      CONTRIB,
      [NATIVE, WASIX],
      { [NATIVE]: "production", [WASIX]: "production" },
    ),
    [WASIX_RUST]: project(WASIX_RUST, [WASIX], { [WASIX]: "production" }),
    [RUST]: project(RUST, [NATIVE], { [NATIVE]: "production" }),
    [BROKER]: project(BROKER, [NATIVE, RUST], { [NATIVE]: "production", [RUST]: "production" }),
    [JS]: project(JS, [NATIVE, RUST, BROKER], {
      [NATIVE]: "peer",
      [RUST]: "production",
      [BROKER]: "production",
    }),
    [SWIFT]: project(SWIFT, [NATIVE], { [NATIVE]: "production" }),
    [REACT_NATIVE]: project(REACT_NATIVE, [SWIFT], { [SWIFT]: "production" }),
    [EXTERNAL]: project(EXTERNAL, [NATIVE, WASIX], { [NATIVE]: "build", [WASIX]: "build" }),
  };
  return { products, moon_projects };
}

function set(value) {
  return new Set(value);
}

test("runtime-only closure includes linked runtimes and every true downstream consumer", () => {
  const closure = dependentReleaseClosure(topologyGraph(), [NATIVE], { prefix: "closure-test" });
  assert.deepEqual(
    set(closure.requiredProducts),
    set([NATIVE, WASIX, CONTRIB, WASIX_RUST, RUST, BROKER, JS, SWIFT, REACT_NATIVE, EXTERNAL]),
  );
  assert.deepEqual(
    closure.reasons[EXTERNAL].map(({ kind, sourceProduct }) => [kind, sourceProduct]),
    [["compatibility", NATIVE], ["compatibility", WASIX]],
    "build-scoped Moon edges do not select the external extension, but directed compatibility fields do",
  );
});

test("the real runtime plan distinguishes Moon build impact from the final publish fixed point", () => {
  const graph = loadGraph("release-dependent-candidates.test");
  const plan = withDependentReleaseClosure(
    graph,
    buildPlan(
      graph,
      ["src/runtimes/liboliphaunt/native/src/lib.rs"],
      "release-dependent-candidates.test",
    ),
    { prefix: "release-dependent-candidates.test" },
  );
  const externalProducts = Object.entries(graph.products)
    .filter(([, config]) => config.extension?.class === "external")
    .map(([productId]) => productId)
    .sort();

  assert.equal(plan.releaseProductsScope, "moon-build-impact");
  assert.deepEqual(plan.buildImpactProducts, plan.releaseProducts);
  assert.equal(plan.dependencyClosed, false);
  for (const productId of externalProducts) {
    assert.equal(plan.releaseProducts.includes(productId), false, `${productId} is not a Moon build-impact release`);
    assert.equal(plan.requiredReleaseProducts.includes(productId), true, `${productId} is a required compatibility release`);
    assert.equal(plan.dependentReleaseProducts.includes(productId), true);
    assert.equal(
      plan.dependentReleaseReasons[productId].some(({ kind }) => kind === "compatibility"),
      true,
    );
  }
  assert.equal(plan.requiredReleaseProducts.includes(WASIX_RUST), true);
});

test("WASIX-only closure reaches the same linked runtime fixed point", () => {
  const closure = dependentReleaseClosure(topologyGraph(), [WASIX], { prefix: "closure-test" });
  assert.deepEqual(
    set(closure.requiredProducts),
    set([NATIVE, WASIX, CONTRIB, WASIX_RUST, RUST, BROKER, JS, SWIFT, REACT_NATIVE, EXTERNAL]),
  );
});

test("Rust-only closure follows production consumers and terminates across a compatibility cycle", () => {
  const closure = dependentReleaseClosure(topologyGraph(), [RUST], { prefix: "closure-test" });
  assert.deepEqual(closure.requiredProducts, [RUST, BROKER, JS]);
  assert.deepEqual(closure.missingProducts, [BROKER, JS]);
});

test("Swift-only closure selects React Native and nothing unrelated", () => {
  const closure = dependentReleaseClosure(topologyGraph(), [SWIFT], { prefix: "closure-test" });
  assert.deepEqual(closure.requiredProducts, [SWIFT, REACT_NATIVE]);
});

test("external-only closure remains one independently versioned package", () => {
  const closure = dependentReleaseClosure(topologyGraph(), [EXTERNAL], { prefix: "closure-test" });
  assert.deepEqual(closure.requiredProducts, [EXTERNAL]);
  assert.deepEqual(closure.missingProducts, []);
});

test("missing post-first-release dependents receive deterministic patch candidates", () => {
  const graph = topologyGraph({ versions: { [RUST]: "1.1.0" } });
  const plan = planDependentReleaseCandidates(
    graph,
    [{ product: RUST, packagePath: graph.products[RUST].path, before: "1.0.0", after: "1.1.0" }],
    { prefix: "closure-test" },
  );
  assert.deepEqual(
    plan.candidates.map(({ product, before, after }) => ({ product, before, after })),
    [
      { product: BROKER, before: "1.0.0", after: "1.0.1" },
      { product: JS, before: "1.0.0", after: "1.0.1" },
    ],
  );
  assert.deepEqual(
    plan.candidates[1].reasons.map(({ sourceProduct, sourceVersion }) => [sourceProduct, sourceVersion]),
    [[BROKER, "1.0.1"], [RUST, "1.1.0"]],
  );
});

test("an otherwise-missing first release fails closed instead of guessing policy", () => {
  const graph = topologyGraph({ versions: { [RUST]: "0.1.0", [BROKER]: "0.0.0" } });
  assert.throws(
    () => planDependentReleaseCandidates(
      graph,
      [{ product: RUST, packagePath: graph.products[RUST].path, before: "0.0.0", after: "0.1.0" }],
      { prefix: "closure-test" },
    ),
    /oliphaunt-broker current version is still 0[.]0[.]0.*Release Please must create its first release candidate/u,
  );
});

test("planner refuses to replace incomplete Release Please linked candidates", () => {
  const graph = topologyGraph({ versions: { [NATIVE]: "1.1.0" } });
  assert.throws(
    () => planDependentReleaseCandidates(
      graph,
      [{ product: NATIVE, packagePath: graph.products[NATIVE].path, before: "1.0.0", after: "1.1.0" }],
      { prefix: "closure-test" },
    ),
    /linked runtime candidates are incomplete.*liboliphaunt-wasix.*oliphaunt-extension-contrib-pg18/u,
  );
});

test("planner rejects SemVer components outside the safe integer range", () => {
  const graph = topologyGraph({
    versions: { [RUST]: "1.1.0", [BROKER]: "1.0.9007199254740992" },
  });
  assert.throws(
    () => planDependentReleaseCandidates(
      graph,
      [{ product: RUST, packagePath: graph.products[RUST].path, before: "1.0.0", after: "1.1.0" }],
      { prefix: "closure-test" },
    ),
    /oliphaunt-broker current version contains a numeric component outside JavaScript's safe integer range/u,
  );
});

function write(root, relative, contents) {
  const file = path.join(root, relative);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, contents, "utf8");
}

function read(root, relative) {
  return readFileSync(path.join(root, relative), "utf8");
}

test("synchronizer writes only declared release files and is closed on its expanded transitions", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "oliphaunt-dependent-candidates-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const SOURCE = "source";
  const SIMPLE = "simple-consumer";
  const RUST_CONSUMER = "rust-consumer";
  const NODE_CONSUMER = "node-consumer";
  const packagePath = (product) => `packages/${product}`;
  const versions = {
    [NATIVE]: "1.0.0",
    [WASIX]: "1.0.0",
    [SOURCE]: "1.1.0",
    [SIMPLE]: "1.0.0",
    [RUST_CONSUMER]: "1.0.0",
    [NODE_CONSUMER]: "1.0.0",
  };
  const products = {
    [NATIVE]: { path: packagePath(NATIVE), version: versions[NATIVE], version_files: [`${packagePath(NATIVE)}/VERSION`] },
    [WASIX]: { path: packagePath(WASIX), version: versions[WASIX], version_files: [`${packagePath(WASIX)}/VERSION`] },
    [SOURCE]: { path: packagePath(SOURCE), version: versions[SOURCE], version_files: [`${packagePath(SOURCE)}/VERSION`] },
    [SIMPLE]: {
      path: packagePath(SIMPLE),
      version: versions[SIMPLE],
      changelog_path: `${packagePath(SIMPLE)}/CHANGELOG.md`,
      version_files: [
        `${packagePath(SIMPLE)}/VERSION`,
        `${packagePath(SIMPLE)}/marker.txt`,
        `${packagePath(SIMPLE)}/marker-block.txt`,
      ],
    },
    [RUST_CONSUMER]: {
      path: packagePath(RUST_CONSUMER),
      version: versions[RUST_CONSUMER],
      changelog_path: `${packagePath(RUST_CONSUMER)}/CHANGELOG.md`,
      version_files: [
        `${packagePath(RUST_CONSUMER)}/Cargo.toml`,
        `${packagePath(RUST_CONSUMER)}/crates/helper/Cargo.toml`,
      ],
    },
    [NODE_CONSUMER]: {
      path: packagePath(NODE_CONSUMER),
      version: versions[NODE_CONSUMER],
      changelog_path: `${packagePath(NODE_CONSUMER)}/CHANGELOG.md`,
      version_files: [
        `${packagePath(NODE_CONSUMER)}/package.json`,
        `${packagePath(NODE_CONSUMER)}/metadata.json`,
      ],
    },
  };
  const moon_projects = Object.fromEntries(Object.keys(products).map((product) => [
    product,
    project(
      product,
      [SIMPLE, RUST_CONSUMER, NODE_CONSUMER].includes(product) ? [SOURCE] : [],
      [SIMPLE, RUST_CONSUMER, NODE_CONSUMER].includes(product) ? { [SOURCE]: "production" } : {},
    ),
  ]));
  for (const [product, config] of Object.entries(moon_projects)) {
    config.source = packagePath(product);
  }
  const graph = { products, moon_projects };
  const packageConfig = {
    [NATIVE]: { "release-type": "simple", component: NATIVE, "version-file": "VERSION" },
    [WASIX]: { "release-type": "simple", component: WASIX, "version-file": "VERSION" },
    [SOURCE]: { "release-type": "simple", component: SOURCE, "version-file": "VERSION" },
    [SIMPLE]: {
      "release-type": "simple",
      component: SIMPLE,
      "version-file": "VERSION",
      "extra-files": ["marker.txt", { type: "generic", path: "marker-block.txt" }],
    },
    [RUST_CONSUMER]: {
      "release-type": "rust",
      component: RUST_CONSUMER,
      "extra-files": [{ type: "toml", path: "crates/helper/Cargo.toml", jsonpath: "$.package.version" }],
    },
    [NODE_CONSUMER]: {
      "release-type": "node",
      component: NODE_CONSUMER,
      "extra-files": [{ type: "json", path: "metadata.json", jsonpath: "$.release.version" }],
    },
  };
  const releasePleaseConfig = {
    packages: Object.fromEntries(Object.keys(products).map((product) => [packagePath(product), packageConfig[product]])),
  };
  const manifest = Object.fromEntries(Object.keys(products).map((product) => [packagePath(product), versions[product]]));

  for (const product of [NATIVE, WASIX, SOURCE]) write(root, `${packagePath(product)}/VERSION`, `${versions[product]}\n`);
  write(root, `${packagePath(SIMPLE)}/VERSION`, "1.0.0\n");
  write(root, `${packagePath(SIMPLE)}/marker.txt`, "VERSION = '1.0.0' # x-release-please-version\n");
  write(root, `${packagePath(SIMPLE)}/marker-block.txt`, "# x-release-please-start-version\nversion=1.0.0\n# x-release-please-end\n");
  write(root, `${packagePath(RUST_CONSUMER)}/Cargo.toml`, "[package]\nname = \"rust-consumer\"\nversion = \"1.0.0\"\n");
  write(root, `${packagePath(RUST_CONSUMER)}/crates/helper/Cargo.toml`, "[package]\nname = \"helper\"\nversion = \"1.0.0\"\n");
  write(root, `${packagePath(NODE_CONSUMER)}/package.json`, '{\n  "name": "node-consumer",\n  "version": "1.0.0"\n}\n');
  write(root, `${packagePath(NODE_CONSUMER)}/metadata.json`, '{\n  "release": {\n    "version": "1.0.0"\n  }\n}\n');
  for (const product of [SIMPLE, RUST_CONSUMER, NODE_CONSUMER]) {
    write(root, `${packagePath(product)}/CHANGELOG.md`, "# Changelog\n\n## 1.0.0 (2026-01-01)\n\n* Initial release.\n");
  }
  write(root, ".release-please-manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);

  const transitions = [{ product: SOURCE, packagePath: packagePath(SOURCE), before: "1.0.0", after: "1.1.0" }];
  const checked = synchronizeDependentReleaseCandidates({
    root,
    graph,
    transitions,
    releasePleaseConfig,
    manifest,
    write: false,
    prefix: "closure-test",
  });
  assert.equal(checked.changes.length, 11);
  assert.equal(read(root, `${packagePath(SIMPLE)}/VERSION`), "1.0.0\n", "check mode is read-only");

  const written = synchronizeDependentReleaseCandidates({
    root,
    graph,
    transitions,
    releasePleaseConfig,
    manifest,
    write: true,
    prefix: "closure-test",
  });
  assert.equal(written.changes.length, 11);
  assert.equal(read(root, `${packagePath(SIMPLE)}/VERSION`), "1.0.1\n");
  assert.match(read(root, `${packagePath(SIMPLE)}/marker.txt`), /VERSION = '1[.]0[.]1'/u);
  assert.match(read(root, `${packagePath(SIMPLE)}/marker-block.txt`), /version=1[.]0[.]1/u);
  assert.match(read(root, `${packagePath(RUST_CONSUMER)}/Cargo.toml`), /version = "1[.]0[.]1"/u);
  assert.equal(JSON.parse(read(root, `${packagePath(NODE_CONSUMER)}/metadata.json`)).release.version, "1.0.1");
  assert.match(
    read(root, `${packagePath(NODE_CONSUMER)}/CHANGELOG.md`),
    /## 1[.]0[.]1[\s\S]*\* \*\*dependencies:\*\* align with `source` 1[.]1[.]0 \(Moon production dependency/u,
  );
  assert.equal(JSON.parse(read(root, ".release-please-manifest.json"))[packagePath(NODE_CONSUMER)], "1.0.1");

  const closedGraph = structuredClone(graph);
  for (const product of [SIMPLE, RUST_CONSUMER, NODE_CONSUMER]) closedGraph.products[product].version = "1.0.1";
  const expanded = [
    ...transitions,
    ...[SIMPLE, RUST_CONSUMER, NODE_CONSUMER].map((product) => ({
      product,
      packagePath: packagePath(product),
      before: "1.0.0",
      after: "1.0.1",
    })),
  ];
  assert.deepEqual(
    planDependentReleaseCandidates(closedGraph, expanded, { prefix: "closure-test" }).candidates,
    [],
  );
});
