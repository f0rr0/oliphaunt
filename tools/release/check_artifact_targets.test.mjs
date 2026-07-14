import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { parseWorkflow } from "../policy/assertions/workflow-semantics.mjs";
import {
  repositoryInventory,
  validateArtifactTargetContract,
  validateCarrierCoverage,
  validateCiArtifactCoverage,
  validateExtensionCarrierCoverage,
  validateExtensionCoverage,
  validateMatrixCoverage,
} from "./check_artifact_targets.mjs";
import { ROOT } from "./release-graph.mjs";

const inventory = repositoryInventory();
const ci = parseWorkflow(ROOT, ".github/workflows/ci.yml");
const jsManifest = JSON.parse(readFileSync(path.join(ROOT, "src/sdks/js/package.json"), "utf8"));
const rustManifest = Bun.TOML.parse(readFileSync(path.join(ROOT, "src/sdks/rust/Cargo.toml"), "utf8"));
const targetNpmPackages = new Set(inventory.targets.map(({ npmPackage }) => npmPackage).filter(Boolean));
const platformManifests = new Map();
for (const config of Object.values(inventory.graph.products)) {
  for (const relativePath of config.version_files ?? []) {
    if (path.basename(relativePath) !== "package.json") continue;
    const manifest = JSON.parse(readFileSync(path.join(ROOT, relativePath), "utf8"));
    if (targetNpmPackages.has(manifest.name)) platformManifests.set(manifest.name, manifest);
  }
}

function clone(value) {
  return structuredClone(value);
}

describe("artifact target support contract", () => {
  test("accepts the canonical inventory", () => {
    expect(() => validateArtifactTargetContract(inventory.targets)).not.toThrow();
  });

  test("rejects a silently removed OS target", () => {
    const targets = clone(inventory.targets);
    targets.splice(targets.findIndex(({ id }) => id === "liboliphaunt-native.windows-x64-msvc"), 1);
    expect(() => validateArtifactTargetContract(targets)).toThrow(/artifact target ids/u);
  });

  test("rejects asset and consumer-surface drift", () => {
    const targets = clone(inventory.targets);
    const target = targets.find(({ id }) => id === "liboliphaunt-native.ios-xcframework");
    target.asset = "liboliphaunt-{version}-ios.zip";
    target.surfaces = target.surfaces.filter((surface) => surface !== "react-native-ios");
    expect(() => validateArtifactTargetContract(targets)).toThrow(/public target contract differs/u);
  });
});

describe("extension and CI exact-set projections", () => {
  test("rejects a missing independently versioned extension target", () => {
    const extensions = clone(inventory.extensions);
    extensions.splice(extensions.findIndex(({ product, target }) => product === inventory.products[0] && target === "android-x86_64"), 1);
    expect(() => validateExtensionCoverage(inventory.targets, inventory.products, extensions)).toThrow(/product\/family\/target pairs/u);
  });

  test("rejects a wrong extension artifact family", () => {
    const extensions = clone(inventory.extensions);
    const row = extensions.find(({ family, target }) => family === "native" && target === "ios-xcframework");
    row.kind = "native-dynamic";
    expect(() => validateExtensionCoverage(inventory.targets, inventory.products, extensions)).toThrow(/native-static-registry/u);
  });

  test("rejects a runtime matrix that drops a published target", () => {
    const matrices = clone(inventory.matrices);
    matrices.native.include.pop();
    expect(() => validateMatrixCoverage(inventory.targets, inventory.extensions, matrices)).toThrow(/native runtime CI matrix/u);
  });

  test("rejects an extension matrix that drops one product-target pair", () => {
    const matrices = clone(inventory.matrices);
    const row = matrices.extensionNative.include[0];
    row.extensions_csv = row.extensions_csv.split(",").slice(1).join(",");
    expect(() => validateMatrixCoverage(inventory.targets, inventory.extensions, matrices)).toThrow(/native extension CI matrix/u);
  });
});

describe("publication and workflow artifact handoff", () => {
  test("rejects an SDK that omits a platform runtime selector", () => {
    const manifest = clone(jsManifest);
    delete manifest.optionalDependencies[Object.keys(manifest.optionalDependencies)[0]];
    expect(() => validateCarrierCoverage({
      graph: inventory.graph,
      catalog: inventory.catalog,
      targets: inventory.targets,
      jsManifest: manifest,
      rustManifest,
      platformManifests,
    })).toThrow(/TypeScript optional runtime packages/u);
  });

  test("rejects a missing extension registry carrier", () => {
    const catalog = clone(inventory.catalog);
    const product = inventory.products[0];
    catalog.carriers.splice(catalog.carriers.findIndex(({ product: owner }) => owner === product), 1);
    expect(() => validateExtensionCarrierCoverage(inventory.graph, catalog, [product])).toThrow(/registry carriers/u);
  });

  test("rejects a renamed target-scoped CI artifact", () => {
    const workflow = clone(ci);
    const uploads = workflow.jobs["broker-runtime"].steps.filter(({ uses }) => String(uses ?? "").startsWith("actions/upload-artifact@"));
    uploads.find(({ with: options }) => String(options?.name ?? "").startsWith("oliphaunt-broker-release-assets-")).with.name = "renamed-${{ matrix.target }}";
    expect(() => validateCiArtifactCoverage(workflow, inventory)).toThrow(/must upload oliphaunt-broker-release-assets/u);
  });

  test("rejects a consumer detached from its producer", () => {
    const workflow = clone(ci);
    workflow.jobs["swift-sdk-package"].needs = workflow.jobs["swift-sdk-package"].needs.filter((job) => job !== "liboliphaunt-native-ios");
    expect(() => validateCiArtifactCoverage(workflow, inventory)).toThrow(/must depend on artifact producer liboliphaunt-native-ios/u);
  });

  test("rejects a missing target-scoped consumer download", () => {
    const workflow = clone(ci);
    const downloads = workflow.jobs["liboliphaunt-native-release-assets"].steps.filter(({ uses }) => String(uses ?? "").startsWith("actions/download-artifact@"));
    downloads.find(({ with: options }) => options?.pattern === "liboliphaunt-native-release-assets-*").with.pattern = "liboliphaunt-native-release-assets-linux-*";
    expect(() => validateCiArtifactCoverage(workflow, inventory)).toThrow(/does not download required artifact/u);
  });
});
