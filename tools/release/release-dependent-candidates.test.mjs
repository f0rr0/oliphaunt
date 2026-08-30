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
  synchronizeReleaseCandidates,
  withDependentReleaseClosure,
} from "./release-dependent-candidates.mjs";
import { exactExtensionProducts } from "./release-artifact-targets.mjs";
import { buildPlan, loadGraph } from "./release-graph.mjs";

const NATIVE = "liboliphaunt-native";
const WASIX = "liboliphaunt-wasix";
const WASIX_RUST = "oliphaunt-wasix-rust";
const WASIX_NAPI = "oliphaunt-wasix-napi";
const WASIX_TS = "oliphaunt-wasix-ts";
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

function project(id, dependencies = []) {
  return {
    id,
    source: `packages/${id}`,
    dependencies,
  };
}

function dependency(id, scope = "production") {
  return { id, scope, source: "explicit" };
}

function topologyGraph(overrides = {}) {
  const versions = overrides.versions ?? {};
  const products = {
    [NATIVE]: product(NATIVE, versions[NATIVE]),
    [WASIX]: product(WASIX, versions[WASIX]),
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
    [WASIX_RUST]: project(WASIX_RUST, [dependency(WASIX)]),
    [RUST]: project(RUST, [dependency(NATIVE)]),
    [BROKER]: project(BROKER, [dependency(NATIVE), dependency(RUST)]),
    [JS]: project(JS, [dependency(NATIVE, "peer"), dependency(RUST), dependency(BROKER)]),
    [SWIFT]: project(SWIFT, [dependency(NATIVE)]),
    [REACT_NATIVE]: project(REACT_NATIVE, [dependency(SWIFT)]),
    [EXTERNAL]: project(EXTERNAL, [dependency(NATIVE, "build"), dependency(WASIX, "build")]),
  };
  return { products, moon_projects };
}

function set(value) {
  return new Set(value);
}

test("native closure includes its directed consumers without forcing WASIX", () => {
  const closure = dependentReleaseClosure(topologyGraph(), [NATIVE], { prefix: "closure-test" });
  assert.deepEqual(
    set(closure.requiredProducts),
    set([NATIVE, RUST, BROKER, JS, SWIFT, REACT_NATIVE, EXTERNAL]),
  );
  assert.deepEqual(
    closure.reasons[EXTERNAL].map(({ kind, sourceProduct }) => [kind, sourceProduct]),
    [["compatibility", NATIVE]],
    "only the selected runtime's directed compatibility edge applies",
  );
  assert.equal(closure.requiredProducts.includes(WASIX), false);
  assert.equal(closure.requiredProducts.includes(WASIX_RUST), false);
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
  assert.equal(plan.requiredReleaseProducts.includes(WASIX), false);
  assert.equal(plan.requiredReleaseProducts.includes(WASIX_RUST), false);
});

test("shared contrib source directly selects both runtime owners and no contrib release product", () => {
  const graph = loadGraph("release-dependent-candidates.test");
  const plan = buildPlan(
    graph,
    ["src/extensions/contrib/postgres18.toml"],
    "release-dependent-candidates.test",
  );
  assert.deepEqual(plan.directProducts, [NATIVE, WASIX]);
  assert.equal(plan.releaseProducts.includes(WASIX_NAPI), true);
  assert.equal(Object.hasOwn(graph.products, "oliphaunt-extension-contrib-pg18"), false);
  assert.equal(graph.moon_projects[NATIVE].dependencies.some(({ id }) => id === WASIX), false);
  assert.equal(graph.moon_projects[WASIX].dependencies.some(({ id }) => id === NATIVE), false);
  for (const file of [
    "src/postgres/versions/18/source.toml",
    "tools/release/extension-target-profiles.toml",
    "src/shared/extension-runtime-contract/contract.toml",
  ]) {
    assert.deepEqual(
      buildPlan(graph, [file], "release-dependent-candidates.test").directProducts,
      [NATIVE, WASIX],
    );
  }
  for (const file of ["src/extensions/contrib/moon.yml"]) {
    const metadataPlan = buildPlan(graph, [file], "release-dependent-candidates.test");
    assert.deepEqual(metadataPlan.directProducts, []);
    assert.deepEqual(metadataPlan.releaseProducts, [WASIX_NAPI, WASIX_TS]);
  }
});

test("every exact extension product schedules and releases the embedded WASIX N-API carriers", () => {
  const graph = loadGraph("release-dependent-candidates.test");
  const exactProducts = exactExtensionProducts("release-dependent-candidates.test");
  const dependencies = graph.moon_projects[WASIX_NAPI].dependencies
    .filter(({ scope }) => scope === "production")
    .map(({ id }) => id);
  for (const product of exactProducts) {
    assert.equal(dependencies.includes(product), true, `${product} is a production dependency`);
    if (!(product in graph.products)) continue;
    const closure = dependentReleaseClosure(graph, [product], {
      prefix: "release-dependent-candidates.test",
    });
    assert.equal(closure.requiredProducts.includes(WASIX_NAPI), true, `${product} releases N-API`);
    assert.equal(
      closure.reasons[WASIX_NAPI].some(
        ({ kind, sourceProduct, scope }) =>
          kind === "moon" && sourceProduct === product && scope === "production",
      ),
      true,
      `${product} records the production closure reason`,
    );
  }
});

test("WASIX closure includes its directed consumers without forcing native", () => {
  const closure = dependentReleaseClosure(topologyGraph(), [WASIX], { prefix: "closure-test" });
  assert.deepEqual(set(closure.requiredProducts), set([WASIX, WASIX_RUST, EXTERNAL]));
  assert.equal(closure.requiredProducts.includes(NATIVE), false);
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

test("planner does not synthesize the independent WASIX runtime from a native transition", () => {
  const graph = topologyGraph({ versions: { [NATIVE]: "1.1.0" } });
  const plan = planDependentReleaseCandidates(
    graph,
    [{ product: NATIVE, packagePath: graph.products[NATIVE].path, before: "1.0.0", after: "1.1.0" }],
    { prefix: "closure-test" },
  );
  assert.equal(plan.requiredProducts.includes(WASIX), false);
  assert.equal(plan.requiredProducts.includes(WASIX_RUST), false);
  assert.equal(plan.candidates.some(({ product }) => product === EXTERNAL), true);
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

function singleProductRelease(root, version, changelog) {
  const packagePath = "packages/native";
  const graph = {
    products: {
      [NATIVE]: {
        path: packagePath,
        version,
        version_files: [`${packagePath}/VERSION`],
        changelog_path: `${packagePath}/CHANGELOG.md`,
      },
    },
  };
  const releasePleaseConfig = {
    packages: {
      [packagePath]: {
        component: NATIVE,
        "release-type": "simple",
        "version-file": "VERSION",
        "changelog-path": "CHANGELOG.md",
      },
    },
  };
  const manifest = { [packagePath]: version };
  write(root, `${packagePath}/VERSION`, `${version}\n`);
  write(root, `${packagePath}/CHANGELOG.md`, changelog);
  write(root, ".release-please-manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);
  return { graph, manifest, packagePath, releasePleaseConfig };
}

function sharedSourceCandidate(packagePath, before, after) {
  return {
    product: NATIVE,
    packagePath,
    before,
    after,
    changelogMode: "merge-existing",
    changelogSection: "Features",
    reasons: [{
      kind: "shared-source",
      commit: "1234567890abcdef",
      summary: "add a bundled SQL capability",
    }],
  };
}

test("shared-source candidates reuse the release writer with an outcome-specific changelog", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "oliphaunt-shared-contrib-candidate-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const packagePath = "packages/native";
  const graph = {
    products: {
      [NATIVE]: {
        path: packagePath,
        version: "1.0.0",
        version_files: [`${packagePath}/VERSION`],
        changelog_path: `${packagePath}/CHANGELOG.md`,
      },
    },
  };
  const releasePleaseConfig = {
    packages: {
      [packagePath]: {
        component: NATIVE,
        "release-type": "simple",
        "version-file": "VERSION",
        "changelog-path": "CHANGELOG.md",
      },
    },
  };
  const manifest = { [packagePath]: "1.0.0" };
  write(root, `${packagePath}/VERSION`, "1.0.0\n");
  write(root, `${packagePath}/CHANGELOG.md`, "# Changelog\n\n## 1.0.0\n");
  write(root, ".release-please-manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);

  synchronizeReleaseCandidates({
    root,
    graph,
    candidates: [{
      product: NATIVE,
      packagePath,
      before: "1.0.0",
      after: "1.0.1",
      changelogSection: "Bug Fixes",
      reasons: [{
        kind: "shared-source",
        commit: "1234567890abcdef",
        summary: "update PostgreSQL source baseline",
      }],
    }],
    releasePleaseConfig,
    manifest,
    write: true,
    prefix: "shared-source-test",
  });

  assert.equal(read(root, `${packagePath}/VERSION`), "1.0.1\n");
  assert.match(
    read(root, `${packagePath}/CHANGELOG.md`),
    /### Bug Fixes[\s\S]*\* \*\*contrib:\*\* shared contrib carrier source: update PostgreSQL source baseline \(12345678\)/u,
  );
});

test("shared-source reasons merge into an existing sufficient release without changing its version", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "oliphaunt-shared-contrib-merge-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const state = singleProductRelease(
    root,
    "1.1.0",
    [
      "# Changelog",
      "",
      "## [1.1.0](https://example.test/compare/v1.0.0...v1.1.0) (2026-08-12)",
      "",
      "### Features",
      "",
      "* **native:** preserve the existing runtime fix",
      "",
      "## 1.0.0",
      "",
    ].join("\n"),
  );
  const candidate = sharedSourceCandidate(state.packagePath, "1.1.0", "1.1.0");
  const synchronize = (writeChanges) => synchronizeReleaseCandidates({
    root,
    graph: state.graph,
    candidates: [candidate],
    releasePleaseConfig: state.releasePleaseConfig,
    manifest: state.manifest,
    write: writeChanges,
    prefix: "shared-source-merge-test",
  });

  assert.deepEqual(
    synchronize(false).map(({ path: file }) => path.relative(root, file)),
    [`${state.packagePath}/CHANGELOG.md`],
  );
  synchronize(true);

  assert.equal(read(root, `${state.packagePath}/VERSION`), "1.1.0\n");
  assert.deepEqual(JSON.parse(read(root, ".release-please-manifest.json")), state.manifest);
  assert.match(
    read(root, `${state.packagePath}/CHANGELOG.md`),
    /## \[1\.1\.0\][\s\S]*### Features[\s\S]*\* \*\*contrib:\*\* shared contrib carrier source: add a bundled SQL capability \(12345678\)/u,
  );
  assert.match(
    read(root, `${state.packagePath}/CHANGELOG.md`),
    /\* \*\*native:\*\* preserve the existing runtime fix/u,
  );
  assert.deepEqual(synchronize(false), [], "re-running the merge is idempotent");
});

test("shared-source promotion retitles an existing release and preserves its changelog", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "oliphaunt-shared-contrib-promote-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const state = singleProductRelease(
    root,
    "1.0.1",
    [
      "# Changelog",
      "",
      "## [1.0.1](https://example.test/compare/v1.0.0...v1.0.1) (2026-08-12)",
      "",
      "### Bug Fixes",
      "",
      "* **native:** preserve the existing runtime fix",
      "",
      "## 1.0.0",
      "",
    ].join("\n"),
  );
  const candidate = sharedSourceCandidate(state.packagePath, "1.0.1", "1.1.0");

  synchronizeReleaseCandidates({
    root,
    graph: state.graph,
    candidates: [candidate],
    releasePleaseConfig: state.releasePleaseConfig,
    manifest: state.manifest,
    write: true,
    prefix: "shared-source-promotion-test",
  });

  assert.equal(read(root, `${state.packagePath}/VERSION`), "1.1.0\n");
  assert.deepEqual(JSON.parse(read(root, ".release-please-manifest.json")), {
    [state.packagePath]: "1.1.0",
  });
  const changelog = read(root, `${state.packagePath}/CHANGELOG.md`);
  assert.match(
    changelog,
    /## \[1\.1\.0\]\(https:\/\/example\.test\/compare\/v1\.0\.0\.\.\.v1\.1\.0\) \(2026-08-12\)/u,
  );
  assert.doesNotMatch(changelog, /^## \[1\.0\.1\]/mu);
  assert.match(changelog, /\* \*\*native:\*\* preserve the existing runtime fix/u);
  assert.match(
    changelog,
    /### Features[\s\S]*\* \*\*contrib:\*\* shared contrib carrier source: add a bundled SQL capability \(12345678\)/u,
  );

  state.graph.products[NATIVE].version = "1.1.0";
  state.manifest[state.packagePath] = "1.1.0";
  assert.deepEqual(
    synchronizeReleaseCandidates({
      root,
      graph: state.graph,
      candidates: [sharedSourceCandidate(state.packagePath, "1.1.0", "1.1.0")],
      releasePleaseConfig: state.releasePleaseConfig,
      manifest: state.manifest,
      prefix: "shared-source-promotion-test",
    }),
    [],
    "the recomputed promoted candidate is idempotent",
  );
});

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
      [SIMPLE, RUST_CONSUMER, NODE_CONSUMER].includes(product) ? [dependency(SOURCE)] : [],
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
