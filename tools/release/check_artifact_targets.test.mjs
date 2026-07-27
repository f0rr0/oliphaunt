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
  test("validates every iOS carrier in its producer job before artifact upload", () => {
    for (const [jobId, buildStep, validationId, uploadStep, root, conditional] of [
      [
        "extension-artifacts-native",
        "Build native exact-extension artifacts",
        "validate_ios_extension_carriers",
        "Upload native exact-extension artifacts",
        "target/extensions/native/release-assets/ios-xcframework",
        "${{ matrix.target == 'ios-xcframework' }}",
      ],
      [
        "liboliphaunt-native-ios",
        "Package liboliphaunt iOS release asset",
        "validate_ios_base_carrier",
        "Upload liboliphaunt release assets",
        "target/liboliphaunt/release-assets",
        undefined,
      ],
    ]) {
      const steps = ci.jobs[jobId].steps;
      const buildIndex = steps.findIndex(({ name }) => name === buildStep);
      const validationIndex = steps.findIndex(({ id }) => id === validationId);
      const uploadIndex = steps.findIndex(({ name }) => name === uploadStep);
      expect(buildIndex).toBeGreaterThanOrEqual(0);
      expect(validationIndex).toBeGreaterThan(buildIndex);
      expect(uploadIndex).toBeGreaterThan(validationIndex);
      const validation = steps[validationIndex];
      expect(validation.run).toBe(`node tools/release/validate-ios-carrier-zips.mjs --root ${root}`);
      expect(validation.if).toBe(conditional);
      expect(validation["continue-on-error"]).toBeUndefined();
      expect(steps[uploadIndex].if).toBeUndefined();
    }
  });

  test("keeps the iOS extension compiler cache bounded and ccache-only", () => {
    const job = ci.jobs["extension-artifacts-native"];
    const cache = job.steps.find(({ name }) => name === "Restore native compiler cache");
    const android = job.steps.find(({ name }) => name === "Set up Android");
    const stats = job.steps.find(({ name }) => name === "Show native compiler cache stats");

    expect(job.env.CCACHE_DIR).toContain("native-extension/${{ matrix.target }}");
    expect(job.env.CCACHE_BASEDIR).toBe("${{ github.workspace }}");
    expect(job.env.CCACHE_COMPILERCHECK).toBe("content");
    expect(job.env.CCACHE_COMPRESS).toBe("true");
    expect(job.env.OLIPHAUNT_CCACHE_MAX_SIZE).toContain("'ios-xcframework' && '512M'");
    expect(job.env.OLIPHAUNT_CCACHE_ZERO_STATS).toBe("1");
    expect(cache.if).toBe("${{ matrix.target == 'ios-xcframework' }}");
    expect(cache.with.path).toBe("${{ env.CCACHE_DIR }}");
    expect(cache.with.key).toContain("liboliphaunt-native-extension-ccache-v2-");
    expect(cache.with["restore-keys"]).not.toContain("build");
    expect(android.with?.["native-ccache"]).toBeUndefined();
    expect(stats.run).toContain("ccache --show-stats");
  });

  test("keeps target-scoped compiler state job-local for desktop and iOS runtimes", () => {
    for (const jobId of ["liboliphaunt-native-desktop", "liboliphaunt-native-ios"]) {
      const job = ci.jobs[jobId];
      const prepare = job.steps.find(({ name }) => name === "Prepare native build paths");

      expect(job.env.CCACHE_DIR).toBe(
        "${{ github.workspace }}/.ci-cache/ccache/native-runtime/${{ matrix.target }}",
      );
      expect(job.env.CCACHE_BASEDIR).toBe("${{ github.workspace }}");
      expect(job.env.CCACHE_COMPILERCHECK).toBe("content");
      expect(job.env.CCACHE_COMPRESS).toBe("true");
      expect(job.env.OLIPHAUNT_CCACHE_ZERO_STATS).toBe("1");
      expect(job.steps.some(({ uses }) => String(uses ?? "").startsWith("actions/cache/"))).toBe(false);
      expect(prepare.env.NATIVE_BUILD_ROOT).toBe("${{ matrix.build-root }}");
      expect(prepare.run).toContain('mkdir -p');
      expect(prepare.run).toContain('$NATIVE_BUILD_ROOT');
      if (jobId === "liboliphaunt-native-desktop") {
        expect(prepare.run).toContain('if [[ "$RUNNER_OS" != "Windows" ]]');
        expect(prepare.run).toContain('mkdir -p "$CCACHE_DIR"');
      } else {
        expect(prepare.run).toContain('mkdir -p "$CCACHE_DIR" "$NATIVE_BUILD_ROOT"');
      }
    }
  });

  test("rejects a missing exact-extension product target", () => {
    const extensions = clone(inventory.extensions);
    extensions.splice(extensions.findIndex(({ product, target }) => product === inventory.products[0] && target === "android-x86_64"), 1);
    expect(() => validateExtensionCoverage(inventory.targets, inventory.products, extensions)).toThrow(/product\/member\/family\/target pairs/u);
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

  test("rejects WASIX AOT archive identity drift", () => {
    for (const [field, pattern] of [
      ["llvm_url", /declared LLVM URL/u],
      ["llvm_sha256", /exact LLVM SHA-256/u],
      ["llvm_bytes", /exact supported LLVM byte size/u],
    ]) {
      const matrices = clone(inventory.matrices);
      const row = matrices.wasixAot.include[0];
      row[field] = field === "llvm_bytes" ? row[field] + 1 : `${row[field]}-drift`;
      expect(() => validateMatrixCoverage(inventory.targets, inventory.extensions, matrices)).toThrow(pattern);
    }
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

  test("rejects a native helper aggregate detached from its matrix producer", () => {
    const workflow = clone(ci);
    workflow.jobs["broker-release-assets"].needs = workflow.jobs["broker-release-assets"].needs
      .filter((job) => job !== "broker-runtime");
    expect(() => validateCiArtifactCoverage(workflow, inventory)).toThrow(
      /broker-release-assets must depend on artifact producer broker-runtime/u,
    );
  });

  test("rejects an incomplete Node direct aggregate handoff", () => {
    const workflow = clone(ci);
    workflow.jobs["node-direct-release-assets"].steps = workflow.jobs["node-direct-release-assets"].steps
      .filter(({ with: options }) => options?.pattern !== "oliphaunt-node-direct-npm-package-*");
    expect(() => validateCiArtifactCoverage(workflow, inventory)).toThrow(
      /node-direct-release-assets does not download required artifact oliphaunt-node-direct-npm-package-/u,
    );
  });

  test("rejects a native helper aggregate download outside its canonical merged directory", () => {
    const workflow = clone(ci);
    const download = workflow.jobs["node-direct-release-assets"].steps
      .find(({ with: options }) => options?.pattern === "oliphaunt-node-direct-release-assets-*");
    download.with.path = "target/unverified-node-assets";
    download.with["merge-multiple"] = false;
    expect(() => validateCiArtifactCoverage(workflow, inventory)).toThrow(
      /must merge exact same-run artifacts into target[/]oliphaunt-node-direct[/]release-assets/u,
    );
  });

  test("rejects duplicate product uploads from native helper aggregate gates", () => {
    const workflow = clone(ci);
    workflow.jobs["broker-release-assets"].steps.push({
      uses: "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
      with: { name: "duplicate-broker-release-assets", path: "target/oliphaunt-broker/release-assets" },
    });
    expect(() => validateCiArtifactCoverage(workflow, inventory)).toThrow(
      /without uploading a duplicate product artifact/u,
    );
  });

  test("rejects a missing target-scoped consumer download", () => {
    const workflow = clone(ci);
    const downloads = workflow.jobs["liboliphaunt-native-release-assets"].steps.filter(({ uses }) => String(uses ?? "").startsWith("actions/download-artifact@"));
    downloads.find(({ with: options }) => options?.pattern === "liboliphaunt-native-release-assets-*").with.pattern = "liboliphaunt-native-release-assets-linux-*";
    expect(() => validateCiArtifactCoverage(workflow, inventory)).toThrow(/does not download required artifact/u);
  });

  test("rejects a Rust exact-candidate consumer detached from its SDK artifact", () => {
    const workflow = clone(ci);
    workflow.jobs["rust-sdk-exact-candidate-consumer"].steps = workflow.jobs["rust-sdk-exact-candidate-consumer"].steps
      .filter(({ with: options }) => options?.name !== "oliphaunt-rust-sdk-package-artifacts");
    expect(() => validateCiArtifactCoverage(workflow, inventory)).toThrow(
      /does not download required artifact oliphaunt-rust-sdk-package-artifacts/u,
    );
  });

  test("rejects a WASIX Rust exact-candidate consumer detached from its SDK artifact", () => {
    const workflow = clone(ci);
    workflow.jobs["wasix-rust-exact-candidate-consumer"].steps = workflow.jobs["wasix-rust-exact-candidate-consumer"].steps
      .filter(({ with: options }) => options?.name !== "oliphaunt-wasix-rust-package-artifacts");
    expect(() => validateCiArtifactCoverage(workflow, inventory)).toThrow(
      /does not download required artifact oliphaunt-wasix-rust-package-artifacts/u,
    );
  });

  test("rejects a WASIX Rust exact-candidate consumer detached from its runtime candidates", () => {
    const workflow = clone(ci);
    workflow.jobs["wasix-rust-exact-candidate-consumer"].needs = workflow.jobs["wasix-rust-exact-candidate-consumer"].needs
      .filter((job) => job !== "liboliphaunt-wasix-release-assets");
    expect(() => validateCiArtifactCoverage(workflow, inventory)).toThrow(
      /must depend on artifact producer liboliphaunt-wasix-release-assets/u,
    );
  });

  test("rejects a JavaScript exact-candidate consumer coupled to the aggregate instead of desktop producers", () => {
    const workflow = clone(ci);
    workflow.jobs["js-sdk-exact-candidate-consumer"].needs = workflow.jobs["js-sdk-exact-candidate-consumer"].needs
      .filter((job) => job !== "liboliphaunt-native-desktop");
    expect(() => validateCiArtifactCoverage(workflow, inventory)).toThrow(
      /must depend on artifact producer liboliphaunt-native-desktop/u,
    );
  });

  test("rejects a JavaScript exact-candidate consumer without its iOS base carrier producer", () => {
    const workflow = clone(ci);
    workflow.jobs["js-sdk-exact-candidate-consumer"].needs = workflow.jobs["js-sdk-exact-candidate-consumer"].needs
      .filter((job) => job !== "liboliphaunt-native-ios");
    expect(() => validateCiArtifactCoverage(workflow, inventory)).toThrow(
      /must depend on artifact producer liboliphaunt-native-ios/u,
    );
  });

  test("rejects a JavaScript exact-candidate consumer without the same-run iOS base carrier", () => {
    const workflow = clone(ci);
    workflow.jobs["js-sdk-exact-candidate-consumer"].steps = workflow.jobs["js-sdk-exact-candidate-consumer"].steps
      .filter(({ with: options }) => options?.name !== "liboliphaunt-native-release-assets-ios-xcframework");
    expect(() => validateCiArtifactCoverage(workflow, inventory)).toThrow(
      /does not download required artifact liboliphaunt-native-release-assets-ios-xcframework/u,
    );
  });

  test("rejects a JavaScript exact-candidate consumer without the same-run iOS extension carrier", () => {
    const workflow = clone(ci);
    workflow.jobs["js-sdk-exact-candidate-consumer"].steps = workflow.jobs["js-sdk-exact-candidate-consumer"].steps
      .filter(({ with: options }) => options?.name !== "liboliphaunt-native-extension-artifacts-ios-xcframework");
    expect(() => validateCiArtifactCoverage(workflow, inventory)).toThrow(
      /does not download required artifact liboliphaunt-native-extension-artifacts-ios-xcframework/u,
    );
  });

  test("rejects a mutable or aliased iOS extension input path", () => {
    const workflow = clone(ci);
    workflow.jobs["js-sdk-exact-candidate-consumer"].steps
      .find(({ with: options }) => options?.name === "liboliphaunt-native-extension-artifacts-ios-xcframework")
      .with.path = "target/js-exact-candidate-input/extensions";
    expect(() => validateCiArtifactCoverage(workflow, inventory)).toThrow(
      /must use same-run immutable input path target\/js-exact-candidate-input\/ios-extensions/u,
    );
  });

  test("rejects an iOS extension input selected from another workflow run", () => {
    const workflow = clone(ci);
    workflow.jobs["js-sdk-exact-candidate-consumer"].steps
      .find(({ with: options }) => options?.name === "liboliphaunt-native-extension-artifacts-ios-xcframework")
      .with["run-id"] = "123";
    expect(() => validateCiArtifactCoverage(workflow, inventory)).toThrow(
      /must use same-run immutable input path target\/js-exact-candidate-input\/ios-extensions/u,
    );
  });

  test("rejects an iOS extension download not bound to the named consumer input", () => {
    const workflow = clone(ci);
    const step = workflow.jobs["js-sdk-exact-candidate-consumer"].steps
      .find(({ id }) => id === "js_exact_candidate_consumer");
    step.run = step.run.replace(
      /\s*--ios-extension-artifact-root target\/js-exact-candidate-input\/ios-extensions \\\n/u,
      "\n",
    );
    expect(() => validateCiArtifactCoverage(workflow, inventory)).toThrow(
      /--ios-extension-artifact-root values/u,
    );
  });

  test("rejects portable ICU artifact-name collisions across desktop rows", () => {
    const workflow = clone(ci);
    workflow.jobs["liboliphaunt-native-desktop"].steps
      .find(({ with: options }) => options?.name === "liboliphaunt-native-icu-data")
      .if = "${{ always() }}";
    expect(() => validateCiArtifactCoverage(workflow, inventory)).toThrow(
      /exactly the macos-arm64 desktop matrix row/u,
    );
  });
});
