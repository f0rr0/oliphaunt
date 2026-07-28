import assert from "node:assert/strict";
import { execFileSync } from "../test/fd-backed-spawn-sync.mjs";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildPlanFromProductTags } from "./release-graph.mjs";
import { releaseProductVersionCoverage } from "./release-product-version-coverage.mjs";

const PRODUCTS = {
  "liboliphaunt-native": "packages/native",
  "liboliphaunt-wasix": "packages/wasix",
  "oliphaunt-extension-vector": "packages/vector",
};

function git(root, ...args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function writeSnapshot(
  root,
  versions,
  { vectorCompatibility = "native=1.0.0,wasix=1.0.0", vectorSource = "vector" } = {},
) {
  writeFileSync(
    path.join(root, ".release-please-manifest.json"),
    `${JSON.stringify(Object.fromEntries(Object.entries(PRODUCTS).map(([product, packagePath]) => [packagePath, versions[product]])), null, 2)}\n`,
  );
  for (const [product, packagePath] of Object.entries(PRODUCTS)) {
    const directory = path.join(root, packagePath);
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, "VERSION"), `${versions[product]}\n`);
    writeFileSync(path.join(directory, "CHANGELOG.md"), `## ${versions[product]}\n`);
    const compatibility = Object.fromEntries(
      vectorCompatibility.split(",").map((entry) => entry.split("=", 2)),
    );
    const body = product === "oliphaunt-extension-vector"
      ? [
        `id = ${JSON.stringify(product)}`,
        `source = ${JSON.stringify(vectorSource)}`,
        "[extension]",
        'sql_name = "vector"',
        "[extension.compatibility]",
        `native_runtime_version = ${JSON.stringify(compatibility.native)}`,
        `wasix_runtime_version = ${JSON.stringify(compatibility.wasix)}`,
        "",
      ].join("\n")
      : `id = ${JSON.stringify(product)}\n`;
    writeFileSync(path.join(directory, "release.toml"), body);
  }
}

function commit(root, subject) {
  git(root, "add", ".");
  git(root, "commit", "-m", subject);
  return git(root, "rev-parse", "HEAD");
}

function fixture(t, versions) {
  const root = mkdtempSync(path.join(os.tmpdir(), "oliphaunt-release-transition-"));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  git(root, "init", "-q");
  git(root, "config", "user.email", "release-test@example.invalid");
  git(root, "config", "user.name", "Release Test");
  writeSnapshot(root, versions);
  const head = commit(root, "initial products");
  return { root, head };
}

function graph(versions) {
  return {
    policy: { versioning: "independent" },
    products: {
      "liboliphaunt-native": {
        path: PRODUCTS["liboliphaunt-native"],
        tag_prefix: "liboliphaunt-native-v",
        version: versions["liboliphaunt-native"],
        version_files: [`${PRODUCTS["liboliphaunt-native"]}/VERSION`],
      },
      "liboliphaunt-wasix": {
        path: PRODUCTS["liboliphaunt-wasix"],
        tag_prefix: "liboliphaunt-wasix-v",
        version: versions["liboliphaunt-wasix"],
        version_files: [`${PRODUCTS["liboliphaunt-wasix"]}/VERSION`],
      },
      "oliphaunt-extension-vector": {
        extension: { class: "external" },
        path: PRODUCTS["oliphaunt-extension-vector"],
        tag_prefix: "oliphaunt-extension-vector-v",
        version: versions["oliphaunt-extension-vector"],
        version_files: [`${PRODUCTS["oliphaunt-extension-vector"]}/VERSION`],
        compatibility_versions: {
          "vector-native-runtime": {
            source_product: "liboliphaunt-native",
            path: `${PRODUCTS["oliphaunt-extension-vector"]}/release.toml`,
            parser: "toml:extension.compatibility.native_runtime_version",
          },
          "vector-wasix-runtime": {
            source_product: "liboliphaunt-wasix",
            path: `${PRODUCTS["oliphaunt-extension-vector"]}/release.toml`,
            parser: "toml:extension.compatibility.wasix_runtime_version",
          },
        },
      },
    },
    moon_projects: {
      "liboliphaunt-native": {
        id: "liboliphaunt-native",
        source: PRODUCTS["liboliphaunt-native"],
        dependsOn: [],
        dependencyScopes: {},
      },
      "liboliphaunt-wasix": {
        id: "liboliphaunt-wasix",
        source: PRODUCTS["liboliphaunt-wasix"],
        dependsOn: [],
        dependencyScopes: {},
      },
      "oliphaunt-extension-vector": {
        id: "oliphaunt-extension-vector",
        source: PRODUCTS["oliphaunt-extension-vector"],
        dependsOn: ["liboliphaunt-native", "liboliphaunt-wasix"],
        dependencyScopes: {
          "liboliphaunt-native": "build",
          "liboliphaunt-wasix": "build",
        },
      },
    },
  };
}

function tagVersions(root, versions) {
  for (const product of Object.keys(PRODUCTS)) {
    git(root, "tag", `${product}-v${versions[product]}`);
  }
}

const V1 = {
  "liboliphaunt-native": "1.0.0",
  "liboliphaunt-wasix": "1.0.0",
  "oliphaunt-extension-vector": "1.0.0",
};

test("compatibility-only external sink edits cannot select its unchanged release identity", (t) => {
  const f = fixture(t, V1);
  tagVersions(f.root, V1);
  const versions = { ...V1, "liboliphaunt-native": "2.0.0", "liboliphaunt-wasix": "2.0.0" };
  writeSnapshot(f.root, versions, { vectorCompatibility: "native=2.0.0,wasix=2.0.0" });
  commit(f.root, "release runtimes");

  const plan = buildPlanFromProductTags(graph(versions), "HEAD", { prefix: "transition-test", root: f.root });
  assert.deepEqual(plan.releaseProducts, ["liboliphaunt-native", "liboliphaunt-wasix"]);
  assert.equal(plan.changedFiles.includes("packages/vector/release.toml"), true);
  assert.equal(plan.releaseProducts.includes("oliphaunt-extension-vector"), false);
  assert.deepEqual(
    releaseProductVersionCoverage(
      graph(versions),
      ["liboliphaunt-native", "liboliphaunt-wasix"],
      "transition-test",
    ),
    {
      missingProducts: ["oliphaunt-extension-vector"],
      requiredProducts: ["liboliphaunt-native", "liboliphaunt-wasix", "oliphaunt-extension-vector"],
      versionedProducts: ["liboliphaunt-native", "liboliphaunt-wasix"],
    },
  );
});

test("an unchanged external product cannot hide a source edit beside compatibility fields", (t) => {
  const f = fixture(t, V1);
  tagVersions(f.root, V1);
  const versions = { ...V1, "liboliphaunt-native": "2.0.0", "liboliphaunt-wasix": "2.0.0" };
  writeSnapshot(f.root, versions, {
    vectorCompatibility: "native=2.0.0,wasix=2.0.0",
    vectorSource: "vector-v2",
  });
  commit(f.root, "runtime release with omitted vector bump");

  assert.throws(
    () => buildPlanFromProductTags(graph(versions), "HEAD", { prefix: "transition-test", root: f.root }),
    /oliphaunt-extension-vector has release-affecting changes .* manifest version remains 1[.]0[.]0.*packages\/vector\/release[.]toml/u,
  );
});

test("an unchanged external product cannot hide a changed source file", (t) => {
  const f = fixture(t, V1);
  tagVersions(f.root, V1);
  const versions = { ...V1, "liboliphaunt-native": "2.0.0", "liboliphaunt-wasix": "2.0.0" };
  writeSnapshot(f.root, versions, { vectorCompatibility: "native=2.0.0,wasix=2.0.0" });
  writeFileSync(path.join(f.root, PRODUCTS["oliphaunt-extension-vector"], "source.toml"), 'rev = "v2"\n');
  commit(f.root, "runtime release with changed vector source");

  assert.throws(
    () => buildPlanFromProductTags(graph(versions), "HEAD", { prefix: "transition-test", root: f.root }),
    /oliphaunt-extension-vector has release-affecting changes .*packages\/vector\/source[.]toml/u,
  );
});

test("a compatibility edit with the wrong source-product version cannot be ignored", (t) => {
  const f = fixture(t, V1);
  tagVersions(f.root, V1);
  const versions = { ...V1, "liboliphaunt-native": "2.0.0", "liboliphaunt-wasix": "2.0.0" };
  writeSnapshot(f.root, versions, { vectorCompatibility: "native=9.9.9,wasix=2.0.0" });
  commit(f.root, "runtime release with invalid vector compatibility");

  assert.throws(
    () => buildPlanFromProductTags(graph(versions), "HEAD", { prefix: "transition-test", root: f.root }),
    /oliphaunt-extension-vector has release-affecting changes .*packages\/vector\/release[.]toml/u,
  );
});

test("runtime-tied expansion fails when a required peer did not advance", (t) => {
  const f = fixture(t, V1);
  tagVersions(f.root, V1);
  const versions = { ...V1, "liboliphaunt-native": "2.0.0" };
  writeSnapshot(f.root, versions, { vectorCompatibility: "native=2.0.0,wasix=1.0.0" });
  commit(f.root, "incomplete runtime release");

  assert.throws(
    () => buildPlanFromProductTags(graph(versions), "HEAD", { prefix: "transition-test", root: f.root }),
    /liboliphaunt-wasix has release-affecting changes .* manifest version remains 1[.]0[.]0/u,
  );
});

test("production closure fails instead of reintroducing an unchanged downstream product", (t) => {
  const f = fixture(t, V1);
  tagVersions(f.root, V1);
  const versions = { ...V1, "liboliphaunt-native": "2.0.0", "liboliphaunt-wasix": "2.0.0" };
  writeSnapshot(f.root, versions, { vectorCompatibility: "native=2.0.0,wasix=2.0.0" });
  commit(f.root, "release runtimes");
  const releaseGraph = graph(versions);
  releaseGraph.moon_projects["oliphaunt-extension-vector"].dependencyScopes = {
    "liboliphaunt-native": "production",
    "liboliphaunt-wasix": "production",
  };

  assert.throws(
    () => buildPlanFromProductTags(releaseGraph, "HEAD", { prefix: "transition-test", root: f.root }),
    /oliphaunt-extension-vector has release-affecting changes .* manifest version remains 1[.]0[.]0/u,
  );
});

test("a real external manifest version bump selects the independent product", (t) => {
  const f = fixture(t, V1);
  tagVersions(f.root, V1);
  const runtimeVersions = { ...V1, "liboliphaunt-native": "2.0.0", "liboliphaunt-wasix": "2.0.0" };
  writeSnapshot(f.root, runtimeVersions, { vectorCompatibility: "native=2.0.0,wasix=2.0.0" });
  commit(f.root, "release runtimes");
  git(f.root, "tag", "liboliphaunt-native-v2.0.0");
  git(f.root, "tag", "liboliphaunt-wasix-v2.0.0");

  const versions = { ...runtimeVersions, "oliphaunt-extension-vector": "1.1.0" };
  writeSnapshot(f.root, versions, { vectorCompatibility: "native=2.0.0,wasix=2.0.0", vectorSource: "vector-v1.1" });
  commit(f.root, "release vector");

  const plan = buildPlanFromProductTags(graph(versions), "HEAD", { prefix: "transition-test", root: f.root });
  assert.deepEqual(plan.directProducts, ["oliphaunt-extension-vector"]);
  assert.deepEqual(plan.releaseProducts, ["oliphaunt-extension-vector"]);
});

test("products without tags retain first-release selection", (t) => {
  const versions = {
    "liboliphaunt-native": "0.1.0",
    "liboliphaunt-wasix": "0.1.0",
    "oliphaunt-extension-vector": "0.1.0",
  };
  const f = fixture(t, versions);
  const plan = buildPlanFromProductTags(graph(versions), f.head, { prefix: "transition-test", root: f.root });
  assert.deepEqual(plan.releaseProducts, [
    "liboliphaunt-native",
    "liboliphaunt-wasix",
    "oliphaunt-extension-vector",
  ]);
});

test("untagged bootstrap 0.0.0 products are not first-release candidates", (t) => {
  const versions = {
    "liboliphaunt-native": "0.0.0",
    "liboliphaunt-wasix": "0.0.0",
    "oliphaunt-extension-vector": "0.0.0",
  };
  const f = fixture(t, versions);
  const plan = buildPlanFromProductTags(graph(versions), f.head, { prefix: "transition-test", root: f.root });
  assert.deepEqual(plan.releaseProducts, []);
});

test("an exact existing current-version tag is selected only for explicit recovery", (t) => {
  const f = fixture(t, V1);
  tagVersions(f.root, V1);
  const excluded = buildPlanFromProductTags(graph(V1), f.head, { prefix: "transition-test", root: f.root });
  assert.deepEqual(excluded.releaseProducts, []);

  const recovered = buildPlanFromProductTags(graph(V1), f.head, {
    includeCurrentTags: true,
    prefix: "transition-test",
    root: f.root,
  });
  assert.deepEqual(recovered.releaseProducts, [
    "liboliphaunt-native",
    "liboliphaunt-wasix",
    "oliphaunt-extension-vector",
  ]);
  assert.deepEqual(recovered.currentTaggedProducts, recovered.releaseProducts);
});

test("a tooling-only descendant cannot recover an older same-version tag", (t) => {
  const f = fixture(t, V1);
  tagVersions(f.root, V1);
  mkdirSync(path.join(f.root, "tools/release"), { recursive: true });
  writeFileSync(path.join(f.root, "tools/release/recovery-note.mjs"), "export const recovery = true;\n");
  commit(f.root, "repair release tooling");

  const plan = buildPlanFromProductTags(graph(V1), "HEAD", {
    includeCurrentTags: true,
    prefix: "transition-test",
    root: f.root,
  });
  assert.deepEqual(plan.releaseProducts, []);
  assert.deepEqual(plan.currentTaggedProducts, []);
});

test("a regressed head manifest cannot recover through an older current-version tag", (t) => {
  const f = fixture(t, V1);
  tagVersions(f.root, V1);
  const v2 = { ...V1, "liboliphaunt-native": "2.0.0", "liboliphaunt-wasix": "2.0.0" };
  writeSnapshot(f.root, v2);
  commit(f.root, "release runtimes v2");
  git(f.root, "tag", "liboliphaunt-native-v2.0.0");
  git(f.root, "tag", "liboliphaunt-wasix-v2.0.0");
  const regressed = { ...v2, "liboliphaunt-native": "1.0.0" };
  writeSnapshot(f.root, regressed);
  commit(f.root, "regress native manifest");

  assert.throws(
    () => buildPlanFromProductTags(graph(regressed), "HEAD", {
      includeCurrentTags: true,
      prefix: "transition-test",
      root: f.root,
    }),
    /manifest version 1[.]0[.]0 is older than tagged version 2[.]0[.]0/u,
  );
});

test("a tag whose canonical version file disagrees with its identity fails closed", (t) => {
  const f = fixture(t, V1);
  writeFileSync(path.join(f.root, PRODUCTS["oliphaunt-extension-vector"], "VERSION"), "9.9.9\n");
  commit(f.root, "corrupt tagged canonical version");
  tagVersions(f.root, V1);

  assert.throws(
    () => buildPlanFromProductTags(graph(V1), "HEAD", {
      includeCurrentTags: true,
      prefix: "transition-test",
      root: f.root,
    }),
    /canonical version "9[.]9[.]9" does not match its manifest version "1[.]0[.]0"/u,
  );
});

test("an eligible transition with no owning changed path fails instead of disappearing", (t) => {
  const f = fixture(t, V1);
  mkdirSync(path.join(f.root, "metadata"), { recursive: true });
  writeFileSync(path.join(f.root, "metadata/vector-version"), "1.0.0\n");
  commit(f.root, "add detached version metadata");
  tagVersions(f.root, V1);

  const versions = { ...V1, "oliphaunt-extension-vector": "1.1.0" };
  writeFileSync(
    path.join(f.root, ".release-please-manifest.json"),
    `${JSON.stringify(Object.fromEntries(Object.entries(PRODUCTS).map(([product, packagePath]) => [packagePath, versions[product]])), null, 2)}\n`,
  );
  writeFileSync(path.join(f.root, "metadata/vector-version"), "1.1.0\n");
  commit(f.root, "detached vector version bump");
  const releaseGraph = graph(versions);
  releaseGraph.products["oliphaunt-extension-vector"].version_files = ["metadata/vector-version"];

  assert.throws(
    () => buildPlanFromProductTags(releaseGraph, "HEAD", { prefix: "transition-test", root: f.root }),
    /manifest advanced .* changed paths do not select the product/u,
  );
});

test("a current-version tag on a mismatched tree fails closed", (t) => {
  const f = fixture(t, V1);
  const candidate = f.head;
  git(f.root, "checkout", "-q", "--orphan", "collision");
  git(f.root, "rm", "-q", "-rf", ".");
  writeSnapshot(f.root, V1, { vectorSource: "different-tree" });
  commit(f.root, "conflicting vector identity");
  git(f.root, "tag", "oliphaunt-extension-vector-v1.0.0");
  git(f.root, "checkout", "-q", "--detach", candidate);

  assert.throws(
    () => buildPlanFromProductTags(graph(V1), candidate, {
      includeCurrentTags: true,
      prefix: "transition-test",
      root: f.root,
    }),
    /current-version tag .* is not an ancestor of release candidate/u,
  );
});
