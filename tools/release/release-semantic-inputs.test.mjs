#!/usr/bin/env bun
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ROOT,
  buildPlan,
  loadGraph,
  releaseOwnerProjectsForPath,
  releaseProductProjectId,
} from "./release-graph.mjs";
import { withDependentReleaseClosure } from "./release-dependent-candidates.mjs";
import {
  RELEASE_SEMANTIC_INPUT_SCHEMA,
  parseReleaseSemanticInputs,
  releaseSemanticFingerprintPath,
  releaseSemanticFingerprints,
  releaseSemanticProductsForPath,
  releaseSemanticRepositoryFiles,
} from "./release-semantic-inputs.mjs";

const graph = loadGraph("release-semantic-inputs.test");
const manifest = graph.release_semantic_inputs;
const extensionProducts = Object.entries(graph.products)
  .filter(([, config]) => ["exact-extension-artifact", "exact-extension-bundle"].includes(config.kind))
  .map(([product]) => product)
  .sort();
const sdkProducts = Object.entries(graph.products)
  .filter(([, config]) => config.kind === "sdk")
  .map(([product]) => product)
  .sort();
const allProducts = Object.keys(graph.products).sort();
const nativeBinaryProducts = [
  "liboliphaunt-native",
  "oliphaunt-broker",
  "oliphaunt-node-direct",
  ...extensionProducts,
].sort();
const releaseProductDryRunDirectByteProducts = [
  "liboliphaunt-native",
  "oliphaunt-broker",
].sort();

function sorted(values) {
  return [...values].sort();
}

function repositoryFiles(directory) {
  const files = [];
  const visit = (relative) => {
    for (const entry of readdirSync(path.join(ROOT, relative), { withFileTypes: true })) {
      const child = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) visit(child);
      else if (entry.isFile()) files.push(child);
    }
  };
  visit(directory);
  return sorted(files);
}

function localImportSpecifiers(source, candidate) {
  const specifiers = [];
  for (const match of source.matchAll(/\b(?:from|import)\s*["'](\.[^"']+)["']/gu)) {
    specifiers.push(match[1]);
  }
  const recognizedDynamicImports = new Set();
  for (const match of source.matchAll(/\bimport\s*\(\s*(["'])([^"'\\]+)\1\s*\)/gu)) {
    recognizedDynamicImports.add(match.index);
    if (match[2].startsWith(".")) specifiers.push(match[2]);
  }
  for (const match of source.matchAll(/\bimport\s*\(/gu)) {
    assert.equal(
      recognizedDynamicImports.has(match.index),
      true,
      `${candidate} contains a non-literal or otherwise unrecognized dynamic import`,
    );
  }
  return specifiers;
}

function localImportClosure(entry) {
  const closure = new Set();
  const visit = (candidate) => {
    if (closure.has(candidate)) return;
    closure.add(candidate);
    const source = readFileSync(path.join(ROOT, candidate), "utf8");
    for (const specifier of localImportSpecifiers(source, candidate)) {
      let absolute = path.resolve(path.dirname(path.join(ROOT, candidate)), specifier);
      if (path.extname(absolute) === "") absolute += ".mjs";
      assert.equal(
        absolute === ROOT || absolute.startsWith(`${ROOT}${path.sep}`),
        true,
        `${candidate} imports outside the repository: ${specifier}`,
      );
      assert.equal(existsSync(absolute), true, `${candidate} imports missing module ${specifier}`);
      visit(path.relative(ROOT, absolute).split(path.sep).join("/"));
    }
  };
  visit(entry);
  return sorted(closure);
}

test("release-semantic repository inventory retains the final successful child write", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "oliphaunt-semantic-inventory-"));
  try {
    const stub = path.join(root, "git-stub.mjs");
    writeFileSync(
      stub,
      [
        "process.stdout.write('first.txt\\0');",
        "setImmediate(() => process.stdout.write('nested/last.txt\\0'));",
        "",
      ].join("\n"),
    );
    assert.deepEqual(
      releaseSemanticRepositoryFiles(root, "semantic inventory test", {
        gitCommand: process.execPath,
        gitCommandArgs: [stub],
      }),
      ["first.txt", "nested/last.txt"],
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("release-semantic repository inventory rejects a successful partial record", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "oliphaunt-semantic-partial-"));
  try {
    const stub = path.join(root, "git-stub.mjs");
    writeFileSync(stub, "process.stdout.write('partial.txt');\n");
    assert.throws(
      () => releaseSemanticRepositoryFiles(root, "semantic inventory test", {
        gitCommand: process.execPath,
        gitCommandArgs: [stub],
      }),
      /missing its required terminal/u,
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("real shared shipped-byte inputs have exact declarative product owners", () => {
  const cases = [
    ["src/extensions/artifacts/native/tools/extension-artifact-packager.mjs", extensionProducts],
    ["src/extensions/artifacts/wasix/tools/package-release-assets.mjs", extensionProducts],
    ["tools/release/bounded-gunzip-to-file.mjs", extensionProducts],
    ["tools/release/build-extension-ci-artifacts.mjs", extensionProducts],
    ["tools/release/extension-artifact-inventory.mjs", extensionProducts],
    ["tools/release/extension-registry-carrier-materializer.mjs", extensionProducts],
    [
      "tools/release/ios-carrier-manifest.mjs",
      [...extensionProducts, "oliphaunt-react-native", "oliphaunt-swift"],
    ],
    ["tools/release/npm-trusted-publishing.mjs", extensionProducts],
    ["tools/release/package-extension-cargo-facades.mjs", extensionProducts],
    ["tools/release/release-product-dry-run.mjs", releaseProductDryRunDirectByteProducts],
    ["tools/xtask/Cargo.toml", ["liboliphaunt-wasix"]],
    ["tools/xtask/src/aot_serializer.rs", ["liboliphaunt-wasix"]],
    ["tools/xtask/src/asset_checks.rs", ["liboliphaunt-wasix"]],
    ["tools/xtask/src/asset_manifest.rs", ["liboliphaunt-wasix"]],
    ["tools/xtask/src/asset_pipeline.rs", ["liboliphaunt-wasix"]],
    ["tools/xtask/src/extension_catalog.rs", ["liboliphaunt-wasix"]],
    ["tools/xtask/src/fs_utils.rs", ["liboliphaunt-wasix"]],
    ["tools/xtask/src/main.rs", ["liboliphaunt-wasix"]],
    ["tools/xtask/src/postgres_guard.rs", ["liboliphaunt-wasix"]],
    ["tools/xtask/src/release_workspace.rs", ["liboliphaunt-wasix"]],
    ["tools/xtask/src/source_spine.rs", ["liboliphaunt-wasix"]],
    ["tools/xtask/src/template_runner.rs", ["liboliphaunt-wasix"]],
    ["src/extensions/generated/extensions.catalog.json", ["liboliphaunt-wasix"]],
    [
      "src/extensions/generated/sdk/kotlin.json",
      ["liboliphaunt-wasix", ...extensionProducts],
    ],
    [
      "src/extensions/generated/sdk/swift.json",
      ["liboliphaunt-wasix", "oliphaunt-swift"],
    ],
    ["tools/release/build_maven_artifact_manifest.mjs", ["liboliphaunt-native", ...extensionProducts]],
    ["src/sdks/kotlin/oliphaunt-maven-artifacts/build.gradle.kts", ["liboliphaunt-native", ...extensionProducts]],
    ["tools/release/package-liboliphaunt-cargo-artifacts.mjs", ["liboliphaunt-native"]],
    ["tools/release/package_broker_cargo_artifacts.mjs", ["oliphaunt-broker"]],
    [
      "tools/release/package_liboliphaunt_wasix_cargo_artifacts.mjs",
      ["liboliphaunt-wasix", ...extensionProducts],
    ],
    ["tools/release/build-sdk-ci-artifacts.mjs", sdkProducts],
    ["tools/release/release-artifact-targets.mjs", allProducts],
    [
      "tools/release/platform-compatibility-policy.mjs",
      [
        "liboliphaunt-native",
        "liboliphaunt-wasix",
        "oliphaunt-broker",
        "oliphaunt-node-direct",
        ...extensionProducts,
      ],
    ],
    [
      "tools/release/archive_dir.mjs",
      ["liboliphaunt-native", "oliphaunt-broker", "oliphaunt-node-direct"],
    ],
    [
      "src/runtimes/liboliphaunt/native/include/oliphaunt.h",
      ["oliphaunt-node-direct"],
    ],
    ["tools/release/package-liboliphaunt-linux-assets.sh", ["liboliphaunt-native"]],
    ["tools/release/package-liboliphaunt-macos-assets.sh", ["liboliphaunt-native"]],
    ["tools/release/package-liboliphaunt-mobile-assets.sh", ["liboliphaunt-native"]],
    ["tools/release/package-liboliphaunt-windows-assets.ps1", ["liboliphaunt-native"]],
    ["src/sdks/rust/src/bin/package_resources.rs", ["liboliphaunt-native"]],
    ["src/sdks/rust/src/build_resources.rs", ["liboliphaunt-native"]],
    ["src/sdks/rust/src/lib.rs", ["liboliphaunt-native"]],
    ["src/sdks/rust/src/liboliphaunt/mod.rs", ["liboliphaunt-native"]],
    ["src/sdks/rust/src/liboliphaunt/root/runtime/cache_key.rs", ["liboliphaunt-native"]],
    ["src/sdks/rust/src/liboliphaunt/root/runtime/install.rs", ["liboliphaunt-native"]],
    ["src/sdks/rust/src/runtime_resources.rs", ["liboliphaunt-native"]],
    ["src/sdks/rust/src/runtime_resources/package.rs", ["liboliphaunt-native"]],
    ["src/sdks/rust/src/runtime_resources/static_registry.rs", ["liboliphaunt-native"]],
    ["tools/release/package-broker-assets.sh", ["oliphaunt-broker"]],
    ["tools/release/strip_native_release_binaries.mjs", nativeBinaryProducts],
    [
      "tools/release/materialize-release-symlinks.mjs",
      ["liboliphaunt-native", ...extensionProducts],
    ],
    [
      "tools/release/windows-vc-runtime-closure.mjs",
      ["liboliphaunt-native", "oliphaunt-broker", ...extensionProducts],
    ],
    [
      "tools/release/write_checksum_manifest.mjs",
      ["liboliphaunt-native", "liboliphaunt-wasix", "oliphaunt-broker", "oliphaunt-node-direct"],
    ],
    ["tools/release/render_swiftpm_release_package.mjs", ["oliphaunt-swift"]],
    [
      "Cargo.lock",
      [
        "liboliphaunt-native",
        "liboliphaunt-wasix",
        "oliphaunt-broker",
        "oliphaunt-rust",
        "oliphaunt-wasix-rust",
        ...extensionProducts,
      ],
    ],
    ["pnpm-lock.yaml", ["oliphaunt-js", "oliphaunt-react-native"]],
  ];
  for (const [candidate, expected] of cases) {
    assert.deepEqual(
      releaseSemanticProductsForPath(manifest, candidate, { prefix: "release-semantic-inputs.test" }),
      sorted(expected),
      candidate,
    );
    assert.deepEqual(buildPlan(graph, [candidate], "release-semantic-inputs.test").semanticInputProducts, sorted(expected));
  }
});

test("the native runtime-resource Rust byte path has focused ownership", () => {
  const nativeProduct = "liboliphaunt-native";
  const semanticOwners = (candidate) =>
    releaseSemanticProductsForPath(manifest, candidate, {
      prefix: "release-semantic-inputs.test",
    });

  const runtimeResourceModulesWithoutNativeOwnership = repositoryFiles(
    "src/sdks/rust/src/runtime_resources",
  ).filter((candidate) => !semanticOwners(candidate).includes(nativeProduct));
  assert.deepEqual(runtimeResourceModulesWithoutNativeOwnership, [
    "src/sdks/rust/src/runtime_resources/extension_artifact.rs",
    "src/sdks/rust/src/runtime_resources/extension_index.rs",
    "src/sdks/rust/src/runtime_resources/manifest.rs",
  ]);

  const materializerModulesWithoutNativeOwnership = repositoryFiles(
    "src/sdks/rust/src/liboliphaunt/root",
  ).filter((candidate) => !semanticOwners(candidate).includes(nativeProduct));
  assert.deepEqual(materializerModulesWithoutNativeOwnership, [
    "src/sdks/rust/src/liboliphaunt/root/manifest.rs",
  ]);

  for (const candidate of [
    "src/sdks/rust/src/bin/extension_artifact.rs",
    "src/sdks/rust/src/bin/extension_index.rs",
    "src/sdks/rust/src/database.rs",
    "src/sdks/rust/src/query.rs",
  ]) {
    assert.deepEqual(semanticOwners(candidate), [], candidate);
  }

  const cacheKeyPlan = buildPlan(
    graph,
    ["src/sdks/rust/src/liboliphaunt/root/runtime/cache_key.rs"],
    "release-semantic-inputs.test",
  );
  assert.deepEqual(cacheKeyPlan.semanticInputProducts, [nativeProduct]);
  assert.equal(cacheKeyPlan.directProducts.includes("oliphaunt-rust"), true);
});

test("every file copied wholesale into the WASIX portable carrier has a WASIX semantic owner", () => {
  const generatedFiles = repositoryFiles("src/extensions/generated");
  assert.ok(generatedFiles.length > 0);
  for (const candidate of generatedFiles) {
    assert.equal(
      releaseSemanticProductsForPath(manifest, candidate, {
        prefix: "release-semantic-inputs.test",
      }).includes("liboliphaunt-wasix"),
      true,
      candidate,
    );
  }
});

test("the WASIX xtask producer closure excludes only download, install, and validation transport", () => {
  const unowned = repositoryFiles("tools/xtask/src").filter((candidate) =>
    !releaseSemanticProductsForPath(manifest, candidate, {
      prefix: "release-semantic-inputs.test",
    }).includes("liboliphaunt-wasix")
  );
  assert.deepEqual(unowned, ["tools/xtask/src/asset_io.rs"]);
});

test("validators, workflow ceremony, and test fixtures remain non-release semantic inputs", () => {
  for (const candidate of [
    ".github/workflows/release.yml",
    "src/extensions/tools/check-extension-model.py",
    "src/shared/fixtures/protocol/query-response-cases.json",
    "tools/release/extension-manifest-discovery-proof.mjs",
    "tools/release/local-registry-publish.mjs",
    "tools/release/release-sdk-product-dry-run.mjs",
    "tools/policy/check-release-policy.mjs",
  ]) {
    assert.deepEqual(
      releaseSemanticProductsForPath(manifest, candidate, { prefix: "release-semantic-inputs.test" }),
      [],
      candidate,
    );
  }
  assert.deepEqual(
    buildPlan(graph, [".github/workflows/release.yml"], "release-semantic-inputs.test").releaseProducts,
    [],
  );
  assert.deepEqual(
    buildPlan(graph, ["src/shared/fixtures/protocol/query-response-cases.json"], "release-semantic-inputs.test").releaseProducts,
    [],
  );
});

test("focused extension carrier byte imports fail closed on unowned transitive helpers", () => {
  assert.equal(extensionProducts.length, 8, "the exact-extension product inventory changed");
  const entry = "tools/release/extension-registry-carrier-materializer.mjs";
  const transport = "tools/release/local-registry-publish.mjs";
  assert.deepEqual(
    releaseSemanticProductsForPath(manifest, entry, { prefix: "release-semantic-inputs.test" }),
    extensionProducts,
  );
  assert.deepEqual(
    releaseSemanticProductsForPath(manifest, transport, { prefix: "release-semantic-inputs.test" }),
    [],
  );
  assert.deepEqual(buildPlan(graph, [transport], "release-semantic-inputs.test").semanticInputProducts, []);

  // These modules are reached because canonical target helpers share generic
  // release-graph infrastructure, or because an imported package-name module
  // also exports unrelated WASIX names. They do not create extension carrier
  // bytes on this path. Keeping the exact list here makes any new unowned
  // transitive import fail until it is classified and, when byte-relevant,
  // added to release-semantic-inputs.toml.
  const explicitNonByteImports = sorted([
    "tools/dev/moon-command.mjs",
    "tools/dev/capture-command-output.mjs",
    "tools/release/portable-archive.mjs",
    "tools/release/release-graph.mjs",
    "tools/release/release-semantic-inputs.mjs",
    "tools/release/wasix-cargo-artifact-contract.mjs",
  ]);
  const unowned = [];
  for (const candidate of localImportClosure(entry)) {
    const owners = releaseSemanticProductsForPath(manifest, candidate, {
      prefix: "release-semantic-inputs.test",
    });
    if (!extensionProducts.every((product) => owners.includes(product))) unowned.push(candidate);
  }
  assert.deepEqual(sorted(unowned), explicitNonByteImports);
});

test("focused carrier import closure recognizes literal dynamic imports and rejects computed imports", () => {
  assert.deepEqual(
    localImportSpecifiers('import value from "./static.mjs"; const module = import("./dynamic.mjs");', "fixture"),
    ["./static.mjs", "./dynamic.mjs"],
  );
  assert.throws(
    () => localImportSpecifiers('const module = import(`./${name}.mjs`);', "computed fixture"),
    /non-literal or otherwise unrecognized dynamic import/u,
  );
});

test("focused carrier materializer is import-only and transport keeps no carrier byte producers", () => {
  const focused = readFileSync(
    path.join(ROOT, "tools/release/extension-registry-carrier-materializer.mjs"),
    "utf8",
  );
  const discoveryProof = readFileSync(
    path.join(ROOT, "tools/release/extension-manifest-discovery-proof.mjs"),
    "utf8",
  );
  for (const forbidden of [
    /\bimport\.meta\.main\b/u,
    /\bprocess\.argv\b/u,
    /\bprocess\.exit\b/u,
    /\bfetch\s*\(/u,
    /\bverdaccio\b/iu,
  ]) {
    assert.doesNotMatch(focused, forbidden);
  }
  assert.match(
    discoveryProof,
    /import \{ discoverExtensionManifests \} from "\.\/extension-registry-carrier-materializer\.mjs"/u,
  );
  assert.doesNotMatch(focused, /WINDOWS_STANDARD_USER_EXTENSION_DISCOVERY_PROOF/u);
  assert.doesNotMatch(focused, /proveWindowsStandardUserExtensionDiscovery/u);

  const transport = readFileSync(path.join(ROOT, "tools/release/local-registry-publish.mjs"), "utf8");
  assert.match(transport, /from "\.\/extension-registry-carrier-materializer\.mjs"/u);
  for (const forbidden of [
    /function\s+renderNpmExtensionBundleManifest\b/u,
    /function\s+stageExtensionNpmPackages\b/u,
    /function\s+packageNativeExtensionCargoCrates\b/u,
    /function\s+writeNativeExtension(?:SplitAggregator|CargoCrate)\b/u,
    /function\s+stageNativeExtensionCargoPayload\b/u,
    /\bCARGO_EXTENSION_(?:PART_BYTES|SPLIT_THRESHOLD_BYTES)\b/u,
  ]) {
    assert.doesNotMatch(transport, forbidden);
  }
});

test("existing product-local and Moon-owned semantic inputs retain their precise ownership", () => {
  const swiftExtensionInventory = buildPlan(
    graph,
    ["src/sdks/swift/tools/extension-resource-inventory.mjs"],
    "release-semantic-inputs.test",
  );
  assert.deepEqual(swiftExtensionInventory.directProducts, ["oliphaunt-swift"]);
  assert.deepEqual(swiftExtensionInventory.releaseProducts, ["oliphaunt-swift", "oliphaunt-react-native"]);

  const vector = buildPlan(
    graph,
    ["src/extensions/external/vector/targets/artifacts.toml"],
    "release-semantic-inputs.test",
  );
  assert.deepEqual(vector.semanticInputProducts, []);
  assert.deepEqual(vector.directProducts, ["oliphaunt-extension-vector"]);

  const toolchain = buildPlan(
    graph,
    ["src/sources/toolchains/wasix.toml"],
    "release-semantic-inputs.test",
  );
  assert.deepEqual(toolchain.semanticInputProducts, []);
  assert.equal(toolchain.releaseProducts.includes("liboliphaunt-wasix"), true);
});

test("publication fixed points close over semantic owners without changing direct ownership", () => {
  const cases = [
    ["pnpm-lock.yaml", ["oliphaunt-js", "oliphaunt-react-native"]],
    [
      "tools/release/package_broker_cargo_artifacts.mjs",
      ["oliphaunt-rust", "oliphaunt-broker", "oliphaunt-js"],
    ],
    ["tools/release/build-extension-ci-artifacts.mjs", Object.keys(graph.products)],
  ];
  for (const [candidate, expected] of cases) {
    const plan = withDependentReleaseClosure(
      graph,
      buildPlan(graph, [candidate], "release-semantic-inputs.test"),
      { prefix: "release-semantic-inputs.test" },
    );
    assert.deepEqual(sorted(plan.requiredReleaseProducts), sorted(expected), candidate);
  }
});

test("every semantic owner has a product-local Release Please fingerprint trigger", () => {
  const fingerprints = releaseSemanticFingerprints(graph, manifest, {
    root: ROOT,
    prefix: "release-semantic-inputs.test",
  });
  assert.deepEqual(sorted(fingerprints.keys()), manifest.products);
  for (const product of manifest.products) {
    const fingerprintPath = releaseSemanticFingerprintPath(graph, product, {
      prefix: "release-semantic-inputs.test",
    });
    assert.equal(fingerprintPath.startsWith(`${graph.products[product].path}/`), true, product);
    assert.equal(
      releaseOwnerProjectsForPath(graph.products, graph.moon_projects, fingerprintPath, "release-semantic-inputs.test")
        .includes(releaseProductProjectId(product, graph.products, graph.moon_projects, "release-semantic-inputs.test")),
      true,
      product,
    );
    assert.equal(buildPlan(graph, [fingerprintPath], "release-semantic-inputs.test").directProducts.includes(product), true);
  }
});

test("ownership declarations fail closed on overlaps and unknown selectors", () => {
  const fixtureGraph = {
    products: {
      alpha: { kind: "sdk", path: "packages/alpha" },
      beta: { kind: "runtime", path: "packages/beta" },
    },
  };
  const rule = (id, paths, products) => ({ id, paths, products });
  assert.throws(
    () => parseReleaseSemanticInputs(
      {
        schema: RELEASE_SEMANTIC_INPUT_SCHEMA,
        rules: [
          rule("parent", ["shared/**"], ["alpha"]),
          rule("child", ["shared/child.txt"], ["beta"]),
        ],
      },
      fixtureGraph,
      { prefix: "release-semantic-inputs.test", checkPaths: false },
    ),
    /overlaps.*one shared input must have exactly one ownership rule/u,
  );
  assert.throws(
    () => parseReleaseSemanticInputs(
      {
        schema: RELEASE_SEMANTIC_INPUT_SCHEMA,
        rules: [rule("unknown-product", ["shared.txt"], ["missing"])],
      },
      fixtureGraph,
      { prefix: "release-semantic-inputs.test", checkPaths: false },
    ),
    /names unknown product\(s\): missing/u,
  );
  assert.throws(
    () => parseReleaseSemanticInputs(
      {
        schema: RELEASE_SEMANTIC_INPUT_SCHEMA,
        rules: [{ id: "unknown-kind", paths: ["shared.txt"], product_kinds: ["ghost"] }],
      },
      fixtureGraph,
      { prefix: "release-semantic-inputs.test", checkPaths: false },
    ),
    /names unknown product kind\(s\): ghost/u,
  );
});
