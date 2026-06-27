#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "../..");
const PREFIX = "check_artifact_targets.mjs";
const graphCache = new Map();

function fail(message) {
  console.error(`${PREFIX}: ${message}`);
  process.exit(1);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sorted(values) {
  return [...values].sort();
}

function sameSet(left, right) {
  if (left.size !== right.size) {
    return false;
  }
  for (const value of left) {
    if (!right.has(value)) {
      return false;
    }
  }
  return true;
}

function isSubset(left, right) {
  for (const value of left) {
    if (!right.has(value)) {
      return false;
    }
  }
  return true;
}

function formatList(values) {
  return JSON.stringify(sorted(values));
}

function readText(repoPath) {
  return readFileSync(path.join(ROOT, repoPath), "utf8");
}

function readToml(repoPath) {
  const file = path.isAbsolute(repoPath) ? repoPath : path.join(ROOT, repoPath);
  try {
    const data = Bun.TOML.parse(readFileSync(file, "utf8"));
    if (!isObject(data)) {
      fail(`${path.relative(ROOT, file)} must contain a TOML table`);
    }
    return data;
  } catch (error) {
    fail(`${path.relative(ROOT, file)} is invalid TOML: ${error.message}`);
  }
}

function bunJson(args) {
  const result = spawnSync("tools/dev/bun.sh", args, {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 100 * 1024 * 1024,
  });
  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    fail(output || `tools/dev/bun.sh ${args.join(" ")} failed`);
  }
  return JSON.parse(result.stdout);
}

function releaseGraphRows(command, args = []) {
  const cacheKey = JSON.stringify([command, args]);
  if (!graphCache.has(cacheKey)) {
    const value = bunJson(["tools/release/release_graph_query.mjs", command, ...args]);
    if (!Array.isArray(value) || !value.every(isObject)) {
      fail(`release graph ${command} query did not return an object list`);
    }
    graphCache.set(cacheKey, value);
  }
  return graphCache.get(cacheKey);
}

function objectRow(row) {
  return {
    triple: null,
    runner: null,
    library_relative_path: null,
    executable_relative_path: null,
    npm_package: null,
    npm_os: null,
    npm_cpu: null,
    npm_libc: null,
    llvm_url: null,
    extension_artifacts: true,
    ...row,
  };
}

function artifactTargetArgs({ product = null, kind = null, surface = null, publishedOnly = false } = {}) {
  const args = [];
  if (product !== null) {
    args.push("--product", product);
  }
  if (kind !== null) {
    args.push("--kind", kind);
  }
  if (surface !== null) {
    args.push("--surface", surface);
  }
  if (publishedOnly) {
    args.push("--published-only");
  }
  return args;
}

function artifactTargets({ product = null, kind = null, surface = null, publishedOnly = false } = {}) {
  return releaseGraphRows(
    "artifact-targets",
    artifactTargetArgs({ product, kind, surface, publishedOnly }),
  ).map(objectRow);
}

function rawArtifactTargetTables() {
  return releaseGraphRows("raw-artifact-targets").map((row) => ({ ...row }));
}

function legacyCentralArtifactTargetRows() {
  return releaseGraphRows("legacy-central-artifact-targets");
}

function moonReleaseMetadata(product) {
  const rows = releaseGraphRows("moon-release-metadata", ["--product", product]);
  if (rows.length !== 1) {
    fail(`release graph moon-release-metadata returned ${rows.length} rows for ${product}`);
  }
  const row = { ...rows[0] };
  delete row.product;
  return row;
}

function extensionProductIds() {
  const products = [];
  for (const row of releaseGraphRows("extension-metadata")) {
    const product = row.product;
    if (typeof product !== "string" || product.length === 0) {
      fail("release graph extension-metadata rows must declare non-empty products");
    }
    products.push(product);
  }
  if (products.length !== new Set(products).size) {
    fail("release graph extension-metadata query returned duplicate products");
  }
  return products.sort();
}

function extensionArtifactTargets({ product = null, family = null, publishedOnly = false } = {}) {
  const args = [];
  if (product !== null) {
    args.push("--product", product);
  }
  if (family !== null) {
    args.push("--family", family);
  }
  if (publishedOnly) {
    args.push("--published-only");
  }
  return releaseGraphRows("extension-targets", args).map(objectRow);
}

function productConfig(product) {
  const rows = releaseGraphRows("product-configs", ["--product", product]);
  if (rows.length !== 1) {
    fail(`release graph product-configs returned ${rows.length} rows for ${product}`);
  }
  return { ...rows[0] };
}

function packagePath(product) {
  const productPath = productConfig(product).path;
  if (typeof productPath !== "string" || productPath.length === 0) {
    fail(`release graph product-configs ${product}.path must be a non-empty string`);
  }
  return path.join(ROOT, productPath);
}

function sdkPackageProducts() {
  const products = [];
  for (const row of releaseGraphRows("sdk-package-products")) {
    const product = row.product;
    if (typeof product !== "string" || product.length === 0) {
      fail("release graph sdk-package-products rows must declare non-empty products");
    }
    products.push(product);
  }
  if (products.length !== new Set(products).size) {
    fail("release graph sdk-package-products query returned duplicate products");
  }
  return products;
}

function ciSdkPackageArtifactNames() {
  const artifacts = [];
  for (const row of releaseGraphRows("sdk-package-products")) {
    const artifact = row.artifactName;
    if (typeof artifact !== "string" || artifact.length === 0) {
      fail("release graph sdk-package-products rows must declare non-empty artifactName");
    }
    artifacts.push(artifact);
  }
  if (artifacts.length !== new Set(artifacts).size) {
    fail("release graph sdk-package-products query returned duplicate artifacts");
  }
  return artifacts;
}

function readCurrentVersion(product) {
  const rows = releaseGraphRows("product-versions", ["--product", product]);
  if (rows.length !== 1) {
    fail(`release graph product-versions returned ${rows.length} rows for ${product}`);
  }
  const version = rows[0].version;
  if (typeof version !== "string" || version.length === 0) {
    fail(`release graph product-versions ${product}.version must be a non-empty string`);
  }
  return version;
}

function artifactTargetMatrix(matrix) {
  const value = bunJson(["tools/release/artifact_target_matrix.mjs", matrix]);
  if (!isObject(value) || !Array.isArray(value.include)) {
    fail(`${matrix} matrix query did not return a matrix object`);
  }
  return value;
}

function ciPlanFullRun({ wasmTarget = "all", nativeTarget = "all", mobileTarget = "all" } = {}) {
  const value = bunJson([
    "tools/graph/ci_plan.mjs",
    "plan-full",
    "--wasm-target",
    wasmTarget,
    "--native-target",
    nativeTarget,
    "--mobile-target",
    mobileTarget,
  ]);
  if (!isObject(value)) {
    fail("CI planner full-run query did not return an object");
  }
  return value;
}

function tsTemplate(asset) {
  return asset.replaceAll("{version}", "${version}");
}

function requireText(repoPath, text, message) {
  if (!readText(repoPath).includes(text)) {
    fail(message);
  }
}

function rejectText(repoPath, text, message) {
  if (readText(repoPath).includes(text)) {
    fail(message);
  }
}

function validateTargetShape() {
  const targets = artifactTargets();
  if (targets.length === 0) {
    fail("artifact target metadata must define targets");
  }
  const rawTargets = new Map(
    rawArtifactTargetTables()
      .filter((raw) => isObject(raw) && typeof raw.id === "string")
      .map((raw) => [raw.id, raw]),
  );

  const seenAssets = new Map();
  for (const target of targets) {
    const rawTarget = rawTargets.get(target.id) ?? {};
    if (!target.asset.includes("{version}")) {
      fail(`${target.id} asset template must contain {version}`);
    }
    if (target.published && !target.surfaces.includes("github-release") && !new Set(["native-tools"]).has(target.kind)) {
      fail(`${target.id} is published but is not a GitHub release asset`);
    }
    if (!target.published) {
      if (rawTarget.tier !== "planned") {
        fail(`${target.id} is unpublished and must declare tier = "planned"`);
      }
      const reason = rawTarget.unsupported_reason;
      if (typeof reason !== "string" || reason.trim().length < 40) {
        fail(`${target.id} is unpublished and must declare a concrete unsupported_reason`);
      }
    }
    if (["native-runtime", "broker-helper", "node-direct-addon"].includes(target.kind)) {
      if (target.triple === null) {
        fail(`${target.id} must declare a target triple`);
      }
      if (target.runner === null) {
        fail(`${target.id} must declare the CI/release runner`);
      }
    }
    if (target.kind === "wasix-aot-runtime") {
      if (target.triple === null) {
        fail(`${target.id} must declare a target triple`);
      }
      if (target.runner === null) {
        fail(`${target.id} must declare the CI/release runner`);
      }
      if (target.llvm_url === null) {
        fail(`${target.id} must declare llvm_url for AOT generation`);
      }
    }
    if (["native-runtime", "node-direct-addon"].includes(target.kind) && target.library_relative_path === null) {
      fail(`${target.id} must declare library_relative_path`);
    }
    if (target.kind === "native-runtime" && target.target.startsWith("android-")) {
      const expectedPrefix = `jni/${target.target.replace(/^android-/u, "")}/`;
      if (target.library_relative_path === null || !target.library_relative_path.startsWith(expectedPrefix)) {
        fail(
          `${target.id} library_relative_path must describe the Android release archive layout under ` +
            `${expectedPrefix}, got ${target.library_relative_path}`,
        );
      }
    }
    if (target.kind === "broker-helper" && target.executable_relative_path === null) {
      fail(`${target.id} must declare executable_relative_path`);
    }
    if (target.surfaces.includes("github-release")) {
      const dedupeKey = `${target.product}\0${target.asset}`;
      const previous = seenAssets.get(dedupeKey);
      if (previous !== undefined) {
        fail(`${target.id} and ${previous} use the same asset template ${target.asset}`);
      }
      seenAssets.set(dedupeKey, target.id);
    }
  }
}

function validateMoonRuntimeTargets() {
  const centralTargets = legacyCentralArtifactTargetRows().map((raw) => raw.id);
  if (centralTargets.length > 0) {
    fail(
      "artifact targets must be derived from Moon release metadata, " +
        `not central release metadata: ${JSON.stringify(centralTargets)}`,
    );
  }

  const runtimeTargetDirs = {
    "liboliphaunt-native": "src/runtimes/liboliphaunt/native/targets",
    "liboliphaunt-wasix": "src/runtimes/liboliphaunt/wasix/targets",
    "oliphaunt-broker": "src/runtimes/broker/targets",
    "oliphaunt-node-direct": "src/runtimes/node-direct/targets",
  };
  for (const [product, directory] of Object.entries(runtimeTargetDirs)) {
    const dir = path.join(ROOT, directory);
    const files = existsSync(dir)
      ? Array.from(new Bun.Glob("*.toml").scanSync({ cwd: dir })).sort()
      : [];
    if (files.length > 0) {
      fail(
        `${product} runtime artifact targets must be derived from Moon release metadata, ` +
          "not product-local target TOML files: " +
          files.map((file) => path.posix.join(directory, file)).join(", "),
      );
    }
  }

  const expectedPresets = {
    "liboliphaunt-native": "liboliphaunt-native",
    "liboliphaunt-wasix": "liboliphaunt-wasix",
    "oliphaunt-broker": "broker-helper",
    "oliphaunt-node-direct": "node-direct-addon",
  };
  for (const [product, preset] of Object.entries(expectedPresets)) {
    const release = moonReleaseMetadata(product);
    const targets = release.artifactTargets;
    if (!isObject(targets)) {
      fail(`${product} Moon release metadata must declare artifactTargets`);
    }
    if (targets.preset !== preset) {
      fail(`${product} Moon artifactTargets.preset must be ${JSON.stringify(preset)}`);
    }
    const published = targets.publishedTargets;
    if (!Array.isArray(published) || published.length === 0 || !published.every((item) => typeof item === "string")) {
      fail(`${product} Moon artifactTargets.publishedTargets must be a non-empty string list`);
    }
  }
}

function wasmExtensionTargetId(runtimeTarget) {
  return runtimeTarget === "portable" ? "wasix-portable" : runtimeTarget;
}

function validateExtensionArtifactTargets() {
  const extensionProducts = extensionProductIds();
  if (extensionProducts.length === 0) {
    fail("exact-extension release products must be modeled as release products");
  }

  const expectedNativeTargets = new Set(
    artifactTargets({ product: "liboliphaunt-native", kind: "native-runtime", publishedOnly: true })
      .filter((target) => target.extension_artifacts)
      .map((target) => target.target),
  );
  const expectedWasixTargets = new Set(
    artifactTargets({ product: "liboliphaunt-wasix", publishedOnly: true })
      .filter((target) => target.kind === "wasix-runtime")
      .map((target) => wasmExtensionTargetId(target.target)),
  );
  if (expectedNativeTargets.size === 0) {
    fail("published native runtime targets are required before extension artifacts can be published");
  }
  if (expectedWasixTargets.size === 0) {
    fail("published WASIX runtime targets are required before extension artifacts can be published");
  }

  for (const product of extensionProducts) {
    const rows = extensionArtifactTargets({ product });
    const publishedNativeTargets = new Set(rows.filter((target) => target.family === "native" && target.published).map((target) => target.target));
    const declaredNativeTargets = new Set(rows.filter((target) => target.family === "native").map((target) => target.target));
    const publishedWasixTargets = new Set(rows.filter((target) => target.family === "wasix" && target.published).map((target) => target.target));
    if (!sameSet(declaredNativeTargets, expectedNativeTargets)) {
      fail(
        `${product} native extension target rows must cover published liboliphaunt native runtimes, ` +
          `including explicit unpublished opt-outs: ${formatList(declaredNativeTargets)} vs ${formatList(expectedNativeTargets)}`,
      );
    }
    if (publishedNativeTargets.size === 0) {
      fail(`${product} must publish at least one native extension artifact target`);
    }
    if (!isSubset(publishedNativeTargets, expectedNativeTargets)) {
      fail(
        `${product} published native extension targets must be published liboliphaunt native runtimes: ` +
          `${formatList(publishedNativeTargets)} vs ${formatList(expectedNativeTargets)}`,
      );
    }
    if (!sameSet(publishedWasixTargets, expectedWasixTargets)) {
      fail(
        `${product} published WASIX extension targets must match published liboliphaunt WASIX runtimes: ` +
          `${formatList(publishedWasixTargets)} vs ${formatList(expectedWasixTargets)}`,
      );
    }
    for (const row of rows) {
      if (row.family === "native") {
        const expectedKind = row.target === "ios-xcframework" || row.target.startsWith("android-")
          ? "native-static-registry"
          : "native-dynamic";
        if (row.kind !== expectedKind) {
          fail(`${product} ${row.target} must use extension artifact kind ${expectedKind}, got ${row.kind}`);
        }
        if (row.published && row.kind === "native-static-registry") {
          const staticRecipe = path.join(packagePath(product), "targets", "native-static-registry.toml");
          if (existsSync(staticRecipe) && statSync(staticRecipe).isFile()) {
            const staticData = readToml(staticRecipe);
            const status = staticData.status;
            if (status !== "supported") {
              fail(
                `${product} publishes ${row.target} native static-registry artifacts, ` +
                  `but ${path.relative(ROOT, staticRecipe)} declares status=${JSON.stringify(status)}`,
              );
            }
          }
        }
      }
      if (row.family === "wasix" && row.kind !== "wasix-runtime") {
        fail(`${product} ${row.target} must use wasix-runtime extension artifacts`);
      }
    }
  }
}

function validateGithubAssetHelpers() {
  requireText(
    "tools/release/package-liboliphaunt-macos-assets.sh",
    "liboliphaunt-${version}-${target_id}.tar.gz",
    "macOS liboliphaunt target packager must emit the release-shaped macOS archive",
  );
  requireText(
    "tools/release/package-liboliphaunt-macos-assets.sh",
    "target/liboliphaunt/release-assets",
    "macOS liboliphaunt target packager must write into the release asset directory",
  );
  requireText(
    "tools/release/check_github_release_assets.mjs",
    "expectedAssets",
    "GitHub release asset checks must derive product assets from product-local artifact targets",
  );
  requireText(
    "tools/release/check-liboliphaunt-release-assets.mjs",
    "allArtifactTargets",
    "liboliphaunt release asset checks must derive required assets from product-local artifact targets",
  );
  requireText(
    "tools/release/check-broker-release-assets.mjs",
    "expectedAssets(PRODUCT, KIND, version",
    "Rust broker release asset checks must derive required assets from product-local artifact targets",
  );
  requireText(
    "src/runtimes/liboliphaunt/native/tools/run-host-c-smoke.mjs",
    "OLIPHAUNT_SMOKE_BIN_DIR",
    "liboliphaunt C ABI smoke runner must support staged-release smoke binaries outside release layouts",
  );
  for (const packager of [
    "tools/release/package-liboliphaunt-macos-assets.sh",
    "tools/release/package-liboliphaunt-linux-assets.sh",
    "tools/release/package-liboliphaunt-windows-assets.ps1",
  ]) {
    requireText(
      packager,
      "OLIPHAUNT_SMOKE_BIN_DIR",
      `${packager} must smoke the staged release layout without writing smoke binaries into the archive`,
    );
    requireText(
      packager,
      "run-host-c-smoke.mjs",
      `${packager} must run the liboliphaunt C ABI smoke against the staged release layout`,
    );
    requireText(
      packager,
      "plpgsql",
      `${packager} must include embedded core PostgreSQL modules for native SDK materialization`,
    );
  }
}

function validateCiReleaseArtifacts() {
  const ci = readText(".github/workflows/ci.yml");
  const release = readText(".github/workflows/release.yml");
  const requiredCiSnippets = new Map([
    ["Package liboliphaunt macOS release asset", "CI must build a release-shaped liboliphaunt macOS target archive"],
    ["tools/release/package-liboliphaunt-macos-assets.sh", "CI must use the macOS liboliphaunt target packager"],
    ["Package liboliphaunt Linux release asset", "CI must build release-shaped liboliphaunt Linux target archives"],
    ["tools/release/package-liboliphaunt-linux-assets.sh", "CI must use the Linux liboliphaunt target packager"],
    ["Package liboliphaunt Windows release asset", "CI must build a release-shaped liboliphaunt Windows target archive"],
    ["package-liboliphaunt-windows-assets.ps1", "CI must use the Windows liboliphaunt target packager"],
    ["Package liboliphaunt Android release asset", "CI must package release-shaped liboliphaunt Android target archives"],
    ["Package liboliphaunt iOS release asset", "CI must package release-shaped liboliphaunt iOS target archives"],
    ["tools/release/package-liboliphaunt-mobile-assets.sh", "CI must use the mobile liboliphaunt target packager"],
    ["liboliphaunt-native-release-assets-${{ matrix.target }}", "CI must upload liboliphaunt release-shaped artifacts per target"],
    ["liboliphaunt-native-release-assets:", "CI must aggregate complete public liboliphaunt release assets"],
    ["Download liboliphaunt target release assets", "CI must aggregate liboliphaunt target archive outputs"],
    [
      ".github/scripts/run-planned-moon-job.sh liboliphaunt-native-release-assets",
      "CI must aggregate liboliphaunt native release assets through the Moon-modeled builder",
    ],
    ["Upload aggregate liboliphaunt release assets", "CI must upload complete liboliphaunt release assets for release consumption"],
    ["Download Apple liboliphaunt release assets", "Swift SDK package artifacts must consume the Apple SwiftPM liboliphaunt release asset"],
    ["liboliphaunt-native-release-assets-ios-xcframework", "Swift SDK package artifacts must download the Apple target release asset directly"],
    ["OLIPHAUNT_SWIFT_RELEASE_ASSET_DIR", "Swift SDK package artifacts must render Package.swift.release from real liboliphaunt release assets in CI"],
    [".github/scripts/run-planned-moon-job.sh broker-runtime", "CI must invoke the planned broker Moon job that includes release-shaped helper artifacts"],
    ["oliphaunt-broker-release-assets-${{ matrix.target }}", "CI must upload broker helper release-shaped artifacts per target"],
    [".github/scripts/run-planned-moon-job.sh node-direct", "CI must invoke the planned Node direct Moon job that includes release-shaped addon artifacts"],
    ["oliphaunt-node-direct-release-assets-${{ matrix.target }}", "CI must upload Node direct release-shaped artifacts per target"],
    ["oliphaunt-node-direct-npm-package-${{ matrix.target }}", "CI must upload Node direct optional npm package artifacts per target"],
    ["oliphaunt-extension-package-artifacts", "CI must upload exact-extension package artifacts"],
    ["oliphaunt-mobile-extension-package-artifacts", "CI must upload target-scoped mobile exact-extension package artifacts"],
    ["target/extension-artifacts", "CI must use the shared exact-extension package staging layout"],
    [".github/scripts/run-planned-moon-job.sh extension-packages", "CI must invoke the Moon-modeled exact-extension package builder"],
    [".github/scripts/run-planned-moon-job.sh mobile-extension-packages", "CI must invoke the Moon-modeled mobile exact-extension package builder"],
    ["Download exact-extension package artifacts", "Mobile build jobs must consume package-shaped exact-extension artifacts"],
    ["Download WASIX exact-extension artifacts", "CI exact-extension package assembly must consume WASIX extension artifact builder outputs"],
    ["pattern: liboliphaunt-wasix-extension-artifacts-*", "CI exact-extension package assembly must download every WASIX extension artifact target output"],
    ["target/extensions/wasix/release-assets", "CI must use the shared WASIX exact-extension release asset staging layout"],
    [
      "extension-artifacts-native:\n    name: Builds / extension-native (${{ matrix.target }})\n    needs:\n      - affected",
      "Native exact-extension artifact builders must be grouped by target",
    ],
    [
      "OLIPHAUNT_EXTENSION_PRODUCTS: ${{ matrix.extensions_csv }}",
      "Exact-extension artifact builder jobs must pass the selected extension product set into the producer",
    ],
    [
      "liboliphaunt-native-extension-artifacts-${{ matrix.target }}",
      "Native exact-extension artifact uploads must be addressable by target",
    ],
    [
      "liboliphaunt-native-extension-ccache-${{ matrix.target }}",
      "Native exact-extension artifact builders must restore target-scoped compiler/build caches",
    ],
    [
      "liboliphaunt-wasix-extension-artifacts-${{ matrix.target }}",
      "WASIX exact-extension artifact uploads must be addressable by target",
    ],
    [
      "MOON_CACHE=off .github/scripts/run-planned-moon-job.sh extension-artifacts-native",
      "Native exact-extension artifact builders must inherit Moon source/check prerequisites inside the job",
    ],
    [
      "OLIPHAUNT_MOON_UPSTREAM=none MOON_CACHE=off .github/scripts/run-planned-moon-job.sh extension-artifacts-wasix",
      "WASIX exact-extension artifact builders must consume downloaded runtime outputs, not re-run upstream producers",
    ],
    ["OLIPHAUNT_EXPO_REQUIRE_PREBUILT_EXTENSIONS", "Mobile build jobs must require prebuilt exact-extension artifacts instead of source-built extension fallbacks"],
    ["OLIPHAUNT_EXPO_REQUIRE_SDK_ARTIFACTS", "Mobile build jobs must require staged SDK package artifacts instead of silent source fallbacks"],
    ["OLIPHAUNT_EXPO_SDK_ARTIFACT_ROOT", "Mobile build jobs must resolve SDK artifacts from the staged package artifact root"],
    ["OLIPHAUNT_EXPO_EXTENSION_ARTIFACT_ROOT", "Mobile build jobs must resolve exact-extension artifacts from the staged package artifact root"],
    ["Validate Android mobile app artifacts", "Android mobile build jobs must inspect the built app for exact selected-extension contents"],
    ["Validate iOS mobile app artifacts", "iOS mobile build jobs must inspect the built app for exact selected-extension contents"],
    [
      "check-staged-artifacts.mjs --require-mobile android --require-mobile-prebuilt-extensions",
      "Android mobile artifact validation must require prebuilt exact-extension package inputs",
    ],
    [
      "check-staged-artifacts.mjs --require-mobile ios --require-mobile-prebuilt-extensions",
      "iOS mobile artifact validation must require prebuilt exact-extension package inputs",
    ],
    ["OLIPHAUNT_EXPO_IOS_OLIPHAUNT_XCFRAMEWORK", "iOS mobile build jobs must consume the linked liboliphaunt XCFramework artifact"],
    ["liboliphaunt-wasix-release-assets:", "CI must aggregate WASIX portable and AOT outputs into public release assets"],
    [
      "liboliphaunt_wasix_aot_runtime_matrix: ${{ steps.plan.outputs.liboliphaunt_wasix_aot_runtime_matrix }}",
      "CI affected planning must emit the WASIX AOT target matrix without a separate planning job",
    ],
    [
      "matrix: ${{ fromJson(needs.affected.outputs.liboliphaunt_wasix_aot_runtime_matrix",
      "WASIX AOT builders must consume the affected-plan target matrix directly",
    ],
    [
      "contains(fromJson(needs.affected.outputs.jobs), 'liboliphaunt-wasix-aot')",
      "CI must only build WASIX AOT artifacts when the affected planner selected AOT work",
    ],
    [
      "contains(fromJson(needs.affected.outputs.jobs), 'liboliphaunt-wasix-release-assets')",
      "CI must only aggregate WASIX release assets when the affected planner selected release aggregation",
    ],
    [".github/scripts/run-planned-moon-job.sh liboliphaunt-wasix-release-assets", "CI must package WASIX public release assets through the planned Moon task"],
    [
      "target/oliphaunt-wasix/wasix-build/work/icu-wasix/share/icu/**",
      "CI must pass the WASIX ICU sidecar produced by the portable runtime job into release asset packaging",
    ],
    ["target/oliphaunt-wasix/release-assets", "CI must upload WASIX public release assets"],
    ["Stage target AOT artifact envelope", "WASIX AOT builders must upload a deterministic artifact envelope"],
    ["target-triple.txt", "WASIX AOT artifact envelopes must identify their target triple explicitly"],
    ["target/oliphaunt-wasix/aot-upload/**", "WASIX AOT upload must use the staged artifact envelope, not an implicit target path"],
    ["Invalid WASIX AOT artifact envelope", "WASIX AOT consumers must validate the downloaded artifact envelope before restoring it"],
  ]);
  for (const [snippet, message] of requiredCiSnippets.entries()) {
    if (!ci.includes(snippet)) {
      fail(message);
    }
  }
  for (const artifact of ciSdkPackageArtifactNames()) {
    if (!ci.includes(artifact)) {
      fail(`CI must upload SDK package artifact ${artifact}`);
    }
  }
  for (const product of sdkPackageProducts()) {
    if (!ci.includes(`target/sdk-artifacts/${product}`)) {
      fail(`CI must use the shared SDK artifact staging layout for ${product}`);
    }
  }
  requireText(
    ".github/workflows/release.yml",
    'tools/dev/bun.sh tools/release/release_graph_query.mjs ci-artifact-names --product "$product" --family sdk-package --format lines',
    "release workflow must derive SDK package artifact names from release metadata",
  );
  requireText(
    ".github/workflows/release.yml",
    'tools/dev/bun.sh tools/release/release_graph_query.mjs ci-products --family sdk-package --products-json "$PRODUCTS_JSON" --format lines',
    "release workflow must derive selected SDK package products from release metadata",
  );
  for (const legacyEnv of [
    "PRODUCT_OLIPHAUNT_RUST",
    "PRODUCT_OLIPHAUNT_SWIFT",
    "PRODUCT_OLIPHAUNT_KOTLIN",
    "PRODUCT_OLIPHAUNT_REACT_NATIVE",
    "PRODUCT_OLIPHAUNT_JS",
    "PRODUCT_OLIPHAUNT_WASIX_RUST",
  ]) {
    rejectText(
      ".github/workflows/release.yml",
      legacyEnv,
      `release workflow must not hard-code SDK product selection with ${legacyEnv}`,
    );
  }
  requireText(
    "src/runtimes/broker/moon.yml",
    'tags: ["release", "artifact", "ci-broker-runtime"]',
    "Broker release-assets must be selected by the ci-broker-runtime Moon tag",
  );
  requireText(
    "src/runtimes/node-direct/moon.yml",
    'tags: ["release", "artifact", "ci-node-direct"]',
    "Node direct release-assets must be selected by the ci-node-direct Moon tag",
  );
  requireText(
    "src/runtimes/node-direct/moon.yml",
    "/target/oliphaunt-node-direct/npm-packages/**/*",
    "Node direct Moon release-assets task must declare optional npm tarballs as outputs",
  );
  requireText(
    "src/runtimes/node-direct/tools/build-node-addon.sh",
    "Node direct optional npm package staged",
    "Node direct CI builder must stage optional npm tarballs for release publishing",
  );
  requireText(
    ".github/workflows/release.yml",
    "Download Node direct optional npm packages",
    "release workflow must download Node direct optional npm package artifacts from CI",
  );
  requireText(
    "tools/release/release.py",
    "node_direct_optional_npm_tarballs",
    "Node direct release publish must validate staged optional npm tarballs",
  );
  requireText(
    "tools/release/release.py",
    'run(["npm", "publish", str(tarball), "--access", "public", "--provenance"])',
    "Node direct optional npm publish must publish CI-built tarballs directly",
  );
  for (const projectId of sdkPackageProducts()) {
    const moonFile = projectId === "oliphaunt-wasix-rust"
      ? "src/bindings/wasix-rust/moon.yml"
      : `src/sdks/${projectId === "oliphaunt-js" ? "js" : projectId.replace(/^oliphaunt-/u, "")}/moon.yml`;
    requireText(
      moonFile,
      `tools/release/build-sdk-ci-artifacts.mjs ${projectId}`,
      `${projectId} package task must stage publishable SDK artifacts`,
    );
    requireText(
      moonFile,
      `/target/sdk-artifacts/${projectId}/**/*`,
      `${projectId} package task must declare staged SDK package artifacts as Moon outputs`,
    );
  }
  const focusedWasixJobs = new Set(ciPlanFullRun({ wasmTarget: "linux-x64-gnu" }).jobs ?? []);
  if (!sameSet(focusedWasixJobs, new Set(["affected", "liboliphaunt-wasix-runtime", "liboliphaunt-wasix-aot"]))) {
    fail(
      "focused WASIX target runs must build only the portable runtime and requested AOT producer, " +
        `got ${formatList(focusedWasixJobs)}`,
    );
  }
  requireText(
    "tools/graph/ci_plan.mjs",
    "extension_artifacts_wasix_matrix:",
    "CI planner must model WASIX exact-extension artifact matrix output",
  );
  requireText(
    "tools/graph/ci_plan.mjs",
    'jobs.has("extension-artifacts-wasix")',
    "CI planner must emit WASIX exact-extension rows only when the WASIX extension builder is selected",
  );
  requireText(
    "tools/graph/ci_plan.mjs",
    'extensionArtifactsWasixMatrix("all", selectedExtensionProducts',
    "WASIX extension artifacts are portable and must use the portable selector, not the AOT target selector",
  );
  const wasixReleaseNeeds = [
    "liboliphaunt-wasix-release-assets:",
    "    name: Builds / liboliphaunt-wasix-release-assets",
    "    needs:",
    "      - affected",
    "      - liboliphaunt-wasix-runtime",
    "      - liboliphaunt-wasix-aot",
  ].join("\n");
  if (!ci.includes(wasixReleaseNeeds)) {
    fail("WASIX release asset builder must consume portable and AOT runtime builders");
  }
  if (ci.includes('OLIPHAUNT_EXPO_MOBILE_EXTENSIONS: ""')) {
    fail('mobile build jobs must not disable selected extensions with OLIPHAUNT_EXPO_MOBILE_EXTENSIONS=""');
  }
  if (ci.includes("run: cargo run -p xtask -- release package-assets")) {
    fail("CI must not bypass Moon for WASIX release asset packaging");
  }
  if (ci.includes("run: src/runtimes/liboliphaunt/wasix/tools/build-runtime-portable.sh")) {
    fail("CI must not bypass Moon for portable WASIX runtime builds");
  }
  if (ci.includes("target/oliphaunt-wasix/aot/${{ matrix.target }}/**")) {
    fail("WASIX AOT uploads must use the explicit target-triple artifact envelope");
  }
  if (ci.includes("run: src/runtimes/liboliphaunt/wasix/tools/build-aot-target.sh")) {
    fail("CI must not bypass Moon for WASIX AOT builds");
  }
  if (ci.indexOf("mobile-build-android:") < ci.indexOf("mobile-extension-packages:")) {
    fail("mobile exact-extension package producer must be declared before mobile Android build consumers");
  }
  if (!ci.includes("mobile-build-android:\n    name: Builds / mobile-android (${{ matrix.target }})\n    needs:\n      - affected\n      - mobile-extension-packages\n      - liboliphaunt-native-android")) {
    fail("Android mobile build must depend on mobile-extension-packages and the Android liboliphaunt target builder");
  }
  if (!ci.includes("mobile-build-ios:\n    name: Builds / mobile-ios\n    needs:\n      - affected\n      - mobile-extension-packages\n      - liboliphaunt-native-ios")) {
    fail("iOS mobile build must depend on mobile-extension-packages and the iOS liboliphaunt target builder");
  }
  if (!ci.includes("mobile-build-android:\n    name: Builds / mobile-android (${{ matrix.target }})\n    needs:\n      - affected\n      - mobile-extension-packages\n      - liboliphaunt-native-android\n      - kotlin-sdk-package\n      - react-native-sdk-package")) {
    fail("Android mobile build must depend on Android runtime, Kotlin, and React Native package artifacts");
  }
  requireText(
    ".github/workflows/ci.yml",
    "matrix: ${{ fromJson(needs.affected.outputs.react_native_android_mobile_app_matrix) }}",
    "Android mobile build must use the React Native Android runtime target matrix",
  );
  requireText(
    ".github/workflows/ci.yml",
    "react-native-mobile-android-app-${{ matrix.target }}",
    "Android mobile build artifacts must be target-specific",
  );
  if (!ci.includes("mobile-build-ios:\n    name: Builds / mobile-ios\n    needs:\n      - affected\n      - mobile-extension-packages\n      - liboliphaunt-native-ios\n      - react-native-sdk-package\n      - swift-sdk-package")) {
    fail("iOS mobile build must depend on iOS runtime, React Native, and Swift package artifacts");
  }
  if (!ci.includes("swift-sdk-package:\n    name: Builds / swift-sdk\n    needs:\n      - affected\n      - liboliphaunt-native-ios")) {
    fail("Swift SDK package artifacts must depend on the iOS native target builder that produces the Apple release asset");
  }
  requireText(
    "tools/graph/ci_plan.mjs",
    'jobs.has("swift-sdk-package")',
    "CI affected planner must make Swift SDK package builds imply liboliphaunt target asset producers",
  );
  requireText(
    "tools/graph/ci_plan.mjs",
    'targets.add("ios-xcframework")',
    "CI affected planner must narrow Swift SDK liboliphaunt target builds to the Apple SwiftPM target when possible",
  );
  requireText(
    "src/sdks/react-native/tools/expo-runner-common.sh",
    "expo_single_sdk_artifact_file",
    "React Native mobile runners must have a shared required-SDK-artifact resolver",
  );
  requireText(
    "src/sdks/react-native/tools/expo-android-runner.sh",
    "install_kotlin_sdk_maven_artifacts_if_required",
    "Android mobile runner must consume staged Kotlin Maven artifacts when CI requires SDK artifacts",
  );
  requireText(
    "src/sdks/react-native/tools/expo-ios-runner.sh",
    "prepare_swift_sdk_artifact_git_repo_if_required",
    "iOS mobile runner must consume the staged Swift source artifact when CI requires SDK artifacts",
  );
  requireText(
    "tools/release/build-sdk-ci-artifacts.mjs",
    "publishAndroidReleasePublicationToMavenLocal",
    "Kotlin SDK package builder must stage a Maven repository layout for Android consumers",
  );
  requireText(
    "tools/release/build-sdk-ci-artifacts.mjs",
    'path.join(artifactRoot, "maven")',
    "Kotlin SDK package builder must stage Maven artifacts under target/sdk-artifacts/oliphaunt-kotlin/maven",
  );
  requireText(
    "tools/release/build-sdk-ci-artifacts.mjs",
    '"tools/release/check-staged-artifacts.mjs", "--require-sdk-product", product',
    "SDK package builders must validate staged package artifacts for runtime/extension payload leaks",
  );
  rejectText(
    "tools/release/build-sdk-ci-artifacts.mjs",
    "outputs/aar/*-release.aar",
    "Kotlin SDK package staging must not copy loose AARs; the staged Maven repository is the package boundary",
  );
  requireText(
    "tools/release/build-sdk-ci-artifacts.mjs",
    "oliphaunt-android-gradle-plugin:publishToMavenLocal",
    "Kotlin SDK package builder must stage the Android Gradle plugin Maven artifact",
  );
  requireText(
    "src/extensions/artifacts/packages/tools/package-mobile-release-assets.sh",
    'check-staged-artifacts.mjs "${validation_args[@]}"',
    "mobile exact-extension package assembly must validate the staged package manifests and checksums it selected",
  );
  requireText(
    "src/extensions/artifacts/packages/tools/package-mobile-release-assets.sh",
    "OLIPHAUNT_EXTENSION_PACKAGE_PRODUCTS must list selected exact-extension products for mobile packaging",
    "mobile exact-extension package assembly must fail closed without an explicit selected product list",
  );
  rejectText(
    "src/extensions/artifacts/packages/tools/package-mobile-release-assets.sh",
    "args+=(--all)",
    "mobile exact-extension package assembly must not fall back to all extension products",
  );
  requireText(
    "src/runtimes/liboliphaunt/native/moon.yml",
    "tools/release/package-liboliphaunt-aggregate-assets.sh",
    "liboliphaunt native aggregate assets must have one Moon-modeled packager/checker entrypoint",
  );
  requireText(
    "tools/release/check-staged-artifacts.mjs",
    "validateReleaseArchivePayload(assetPath)",
    "staged exact-extension artifact checks must reject placeholder files that are not readable release archives",
  );
  requireText(
    "tools/graph/ci_plan.mjs",
    'jobs.add("mobile-extension-packages")',
    "affected planner must select target-scoped exact-extension packages whenever mobile jobs are selected",
  );
  rejectText(
    "tools/graph/ci_plan.mjs",
    'if "extension-artifacts-native" in jobs:\n        jobs.add("liboliphaunt-native")',
    "affected planner must not create a coarse native-runtime waterfall for exact-extension artifact builds",
  );
  rejectText(
    ".github/workflows/release.yml",
    "product_liboliphaunt_native == 'true' || steps.release_plan.outputs.product_oliphaunt_swift == 'true'",
    "Swift SDK releases must consume staged Swift package artifacts, not force aggregate liboliphaunt asset downloads",
  );
  requireText(
    ".github/workflows/release.yml",
    "steps.release_plan.outputs.product_liboliphaunt_native == 'true' }}",
    "release workflow must still download aggregate liboliphaunt assets for liboliphaunt-native releases",
  );
  requireText(
    "tools/release/release.py",
    "prepare_staged_swift_release_manifest",
    "Swift SDK release must use the Package.swift.release produced by the SDK package builder",
  );
  requireText(
    "tools/release/release.py",
    "def validate_staged_sdk_package",
    "release dry-runs must validate staged SDK package artifacts before publish checks",
  );
  for (const productId of sdkPackageProducts()) {
    requireText(
      "tools/release/release.py",
      `validate_staged_sdk_package("${productId}")`,
      `${productId} release dry-run must validate the staged SDK package artifact`,
    );
  }
  requireText(
    ".github/scripts/run-planned-moon-job.sh",
    "OLIPHAUNT_MOON_UPSTREAM",
    "CI must be able to run downloaded-artifact consumer jobs without re-running Moon upstream producer tasks",
  );
  for (const consumerJob of [
    "extension-packages",
    "mobile-extension-packages",
    "liboliphaunt-native-release-assets",
    "liboliphaunt-wasix-aot",
    "liboliphaunt-wasix-release-assets",
    "mobile-build-android",
    "mobile-build-ios",
  ]) {
    requireText(
      ".github/workflows/ci.yml",
      `OLIPHAUNT_MOON_UPSTREAM=none MOON_CACHE=off .github/scripts/run-planned-moon-job.sh ${consumerJob}`,
      `${consumerJob} must consume downloaded builder artifacts without re-running upstream producer tasks`,
    );
  }
  if (ci.includes("Stage mobile exact-extension packages")) {
    fail("mobile build jobs must not locally stage extension packages; they must consume extension-package builder artifacts");
  }
  if (ci.includes("extension-packages-native")) {
    fail("CI must not keep a native-only extension package shortcut; mobile must consume target-scoped exact-extension packages");
  }
  if (ci.includes("oliphaunt-extension-native-package-artifacts")) {
    fail("CI must not publish native-only exact-extension package artifacts");
  }
  if (ci.includes("target/extension-artifacts-native")) {
    fail("CI must not use a separate native-only extension package staging layout");
  }
  requireText(
    "tools/release/release.py",
    "requires staged exact-extension package artifacts",
    "release CLI must fail closed when extension releases lack staged CI-built package artifacts",
  );
  requireText(
    "tools/release/release.py",
    "validate_extension_release_package",
    "release CLI must validate staged exact-extension package manifests before dry-run or publish",
  );
  requireText(
    "tools/release/release.py",
    "staged_native_targets != declared_native_targets",
    "release CLI must reject partial native exact-extension package artifacts",
  );
  requireText(
    "tools/release/release.py",
    "staged_wasix_targets != declared_wasix_targets",
    "release CLI must reject partial WASIX exact-extension package artifacts",
  );
  requireText(
    "tools/release/release.py",
    "sha256_file(asset_path) != sha_value",
    "release CLI must verify staged exact-extension artifact checksums",
  );
  requireText(
    "tools/release/release.py",
    "validate_checksum_manifest(checksum_manifest, asset_dir)",
    "release CLI must verify staged exact-extension checksum manifests exactly",
  );
  requireText(
    "tools/release/build-extension-ci-artifacts.mjs",
    "nativeAssetName(product, version",
    "exact-extension package artifacts must be named by extension product version",
  );
  requireText(
    "src/extensions/artifacts/native/tools/package-release-assets.sh",
    "native-extension-assets.tsv",
    "native exact-extension artifact producers must emit a target-addressed native asset index",
  );
  requireText(
    "src/extensions/artifacts/native/tools/package-release-assets.sh",
    "OLIPHAUNT_EXTENSION_PRODUCT",
    "native exact-extension artifact producers must support product-scoped builds",
  );
  requireText(
    "src/extensions/artifacts/wasix/tools/package-release-assets.sh",
    "OLIPHAUNT_EXTENSION_PRODUCT",
    "WASIX exact-extension artifact producers must support product-scoped builds",
  );
  requireText(
    "tools/release/build-extension-ci-artifacts.mjs",
    "nativeAssetsFromTargetIndexes",
    "exact-extension package staging must consume target-addressed native asset indexes",
  );
  requireText(
    "tools/release/build-extension-ci-artifacts.mjs",
    'publishedTargetIds("native")',
    "exact-extension package staging must only read declared published native target artifact indexes",
  );
  requireText(
    "tools/release/build-extension-ci-artifacts.mjs",
    'publishedTargetIds("wasix")',
    "exact-extension package staging must only read declared published WASIX target artifact indexes",
  );
  requireText(
    "tools/release/build-extension-ci-artifacts.mjs",
    "if (requireNativeTargets.size > 0 && !requireNativeTargets.has(target))",
    "mobile exact-extension package staging must filter out native targets that the mobile build did not request",
  );
  requireText(
    "tools/release/build-extension-ci-artifacts.mjs",
    "indexContainsSqlName(productIndex, sqlName)",
    "exact-extension package staging must not let stale empty product-scoped native indexes shadow target-level indexes",
  );
  requireText(
    "tools/release/build-extension-ci-artifacts.mjs",
    "-manifest.json",
    "exact-extension package artifacts must publish a machine-readable release manifest",
  );
  requireText(
    "tools/release/check_github_release_assets.mjs",
    "verifyReleaseAssets",
    "GitHub release verification must derive exact-extension asset expectations from staged extension package manifests",
  );
  requireText(
    "tools/release/verify_github_release_attestations.mjs",
    "exact-extension-artifact",
    "Release attestation verification must include exact-extension artifact products",
  );
  requireText(
    "tools/release/release.py",
    "liboliphaunt-native requires staged release assets",
    "release CLI must fail closed when liboliphaunt releases lack staged CI-built runtime artifacts",
  );
  requireText(
    "tools/release/release.py",
    "liboliphaunt-wasix requires staged release assets",
    "release CLI must fail closed when WASIX releases lack staged CI-built runtime artifacts",
  );
  requireText(
    "tools/release/release.py",
    "requires staged JSR source",
    "release CLI must fail closed when TypeScript JSR release artifacts are not staged",
  );
  requireText(
    ".github/workflows/release.yml",
    "Download SDK package artifacts",
    "release workflow must download SDK package artifacts from the CI workflow before publishing",
  );
  requireText(
    ".github/workflows/release.yml",
    "Download liboliphaunt release assets",
    "release workflow must download complete liboliphaunt assets from the CI workflow before publishing",
  );
  requireText(
    ".github/workflows/release.yml",
    "Download native helper release assets",
    "release workflow must download broker and Node direct helper assets from the CI workflow before publishing those helper products",
  );
  requireText(
    ".github/workflows/release.yml",
    "Download WASIX release assets",
    "release workflow must download complete WASIX runtime release assets from the CI workflow before publishing",
  );
  requireText(
    ".github/workflows/release.yml",
    "Upload WASIX GitHub release assets",
    "release workflow must publish WASIX GitHub assets through the liboliphaunt-wasix runtime product",
  );
  requireText(
    ".github/workflows/release.yml",
    "--product liboliphaunt-wasix --step github-release-assets",
    "release workflow must publish WASIX GitHub assets through the liboliphaunt-wasix runtime product",
  );
  requireText(
    ".github/workflows/release.yml",
    "--product liboliphaunt-wasix --step crates-io",
    "release workflow must publish liboliphaunt-wasix Cargo artifact packages before the WASIX Rust binding",
  );
  requireText(
    ".github/workflows/release.yml",
    'tools/dev/bun.sh tools/release/release_graph_query.mjs ci-artifact-names --product "$product" --kind "$kind" --family release-assets --format lines',
    "release workflow must derive native helper release artifact names from target metadata",
  );
  requireText(
    ".github/workflows/release.yml",
    '[ "$PRODUCT_OLIPHAUNT_BROKER" = "true" ]',
    "broker helper releases must download broker artifacts from CI",
  );
  requireText(
    ".github/workflows/release.yml",
    '[ "$PRODUCT_OLIPHAUNT_NODE_DIRECT" = "true" ]',
    "Node direct helper releases must download Node direct artifacts from CI",
  );
  requireText(
    ".github/workflows/release.yml",
    "tools/dev/bun.sh tools/release/release_graph_query.mjs ci-artifact-names --product oliphaunt-node-direct --kind node-direct-addon --family npm-package --format lines",
    "release workflow must derive Node direct npm package artifact names from target metadata",
  );
  requireText(
    ".github/workflows/release.yml",
    "target/oliphaunt-broker/release-assets",
    "release workflow must download broker artifacts into the canonical broker release asset root",
  );
  requireText(
    ".github/workflows/release.yml",
    "target/oliphaunt-node-direct/release-assets",
    "release workflow must download Node direct artifacts into the canonical Node direct release asset root",
  );
  requireText(
    ".github/workflows/release.yml",
    "--product liboliphaunt-native --step npm",
    "release workflow must publish liboliphaunt artifact packages to npm before dependent SDK packages",
  );
  requireText(
    ".github/workflows/release.yml",
    "--product oliphaunt-broker --step npm",
    "release workflow must publish broker artifact packages to npm before dependent SDK packages",
  );
  requireText(
    ".github/workflows/release.yml",
    "--product liboliphaunt-native --step crates-io",
    "release workflow must publish liboliphaunt native Cargo artifact packages before dependent Rust SDK packages",
  );
  requireText(
    ".github/workflows/release.yml",
    "--product oliphaunt-broker --step crates-io",
    "release workflow must publish broker artifact packages to crates.io before dependent Rust SDK packages",
  );
  requireText(
    "tools/release/release.py",
    "npm-package-sources",
    "npm artifact packages must be assembled from staged package sources instead of mutating checked-in package directories",
  );
  requireText(
    "tools/release/release.py",
    "package-liboliphaunt-cargo-artifacts.mjs",
    "liboliphaunt native Cargo artifact packages must be generated from staged native release assets",
  );
  requireText(
    "tools/release/release.py",
    "package_broker_cargo_artifacts.mjs",
    "broker Cargo artifact packages must be generated from staged broker release assets",
  );
  requireText(
    "tools/release/release.py",
    "package_liboliphaunt_wasix_cargo_artifacts.mjs",
    "liboliphaunt-wasix Cargo artifact packages must be generated from staged WASIX release assets",
  );
  requireText(
    "tools/release/release.py",
    "liboliphaunt_wasix_cargo_artifact_crates",
    "release CLI must package and validate direct WASIX Cargo artifact crates",
  );
  requireText(
    "tools/release/package_liboliphaunt_wasix_cargo_artifacts.mjs",
    "CRATES_IO_MAX_BYTES",
    "WASIX Cargo artifact packager must enforce the crates.io package size limit",
  );
  requireText(
    "tools/release/package_liboliphaunt_wasix_cargo_artifacts.mjs",
    "validateCrateSize",
    "WASIX Cargo artifact packager must validate direct artifact crate sizes",
  );
  rejectText(
    "tools/release/package_liboliphaunt_wasix_cargo_artifacts.mjs",
    "DEFAULT_PART_COUNT",
    "WASIX Cargo artifact packager must not generate reserved part crates",
  );
  requireText(
    "tools/release/package_liboliphaunt_wasix_cargo_artifacts.mjs",
    "wasixExtensionAotPartPackageName",
    "WASIX Cargo artifact packager may only generate named part crates for oversized extension AOT artifacts",
  );
  requireText(
    "tools/release/package_liboliphaunt_wasix_cargo_artifacts.mjs",
    "EXTENSION_AOT_SPLIT_THRESHOLD_BYTES",
    "WASIX Cargo artifact packager must keep extension AOT part splitting behind an explicit size threshold",
  );
  requireText(
    "tools/release/release.py",
    "artifact_npm_package_targets",
    "liboliphaunt and broker npm artifact packages must derive package targets from artifact target metadata",
  );
  rejectText(
    "tools/release/release.py",
    "LIBOLIPHAUNT_NPM_PACKAGE_DIRS",
    "liboliphaunt npm package target mapping must not be duplicated outside artifact target metadata",
  );
  rejectText(
    "tools/release/release.py",
    "BROKER_NPM_PACKAGE_DIRS",
    "broker npm package target mapping must not be duplicated outside artifact target metadata",
  );
  requireText(
    "tools/release/release.py",
    "required_runtime_member_paths",
    "liboliphaunt npm artifact packages must include the selected platform runtime tree",
  );
  requireText(
    "tools/release/package-liboliphaunt-cargo-artifacts.mjs",
    "optimizeNativePayload(",
    "liboliphaunt Cargo artifact packages must prune and validate native runtime payloads before splitting",
  );
  rejectText(
    ".github/workflows/release.yml",
    "target/release-assets/native",
    "release workflow must not stage native helper artifacts in a generic release-assets/native bucket",
  );
  requireText(
    "tools/release/build-sdk-ci-artifacts.mjs",
    'stageJsrSourceWorkspace(packageShapeDir, path.join(artifactRoot, "jsr-source"))',
    "TypeScript SDK builder must stage source for JSR publishing in addition to the npm tarball",
  );
  requireText(
    "tools/release/release.py",
    'staged_jsr_source_dir("oliphaunt-js")',
    "TypeScript SDK release must publish JSR from staged CI-built source artifacts",
  );
  requireText(
    "tools/release/release.py",
    "validate_staged_npm_package_tarball",
    "npm SDK release steps must validate CI-built package tarballs before dry-run or publish",
  );
  requireText(
    "tools/release/release.py",
    "must not contain workspace: dependency specifiers",
    "staged npm SDK package validation must reject unpublished workspace protocol specs",
  );
  requireText(
    "tools/release/release.py",
    "verify_staged_cargo_crate_identity",
    "Cargo SDK release steps must verify staged CI-built .crate identity before dry-run or publish",
  );
  for (const forbidden of [
    "tools/release/package-liboliphaunt-assets.sh",
    "tools/release/package-broker-assets.sh",
    "src/runtimes/node-direct/tools/build-node-addon.sh",
    "src/extensions/artifacts/native/tools/package-release-assets.sh",
    "src/extensions/artifacts/wasix/tools/package-release-assets.sh",
    "tools/release/build-extension-ci-artifacts.mjs",
    "src/sdks/kotlin/tools/check-sdk.sh",
    "src/sdks/react-native/tools/check-sdk.sh",
    "src/sdks/js/tools/check-sdk.sh",
    'xtask(["release", "stage"])',
    '"--staged-wasm"',
    '"--staged-wasix-runtime"',
    "OLIPHAUNT_RELEASE_REQUIRE_STAGED_",
    "OLIPHAUNT_WASM_RELEASE_STAGED",
  ]) {
    rejectText(
      "tools/release/release.py",
      forbidden,
      `release CLI must consume staged CI artifacts, not retain local fallback path ${forbidden}`,
    );
  }
  for (const forbidden of ["OLIPHAUNT_RELEASE_REQUIRE_STAGED_", "OLIPHAUNT_WASM_RELEASE_STAGED"]) {
    rejectText(
      ".github/workflows/release.yml",
      forbidden,
      `release workflow must not rely on staged-mode env flag ${forbidden}; release CLI is staged-artifact-only`,
    );
  }
  rejectText(
    ".github/workflows/release.yml",
    "Build liboliphaunt Linux asset",
    "release workflow must not rebuild liboliphaunt Linux assets; it must consume CI artifacts",
  );
  rejectText(
    ".github/workflows/release.yml",
    "Build liboliphaunt Windows asset",
    "release workflow must not rebuild liboliphaunt Windows assets; it must consume CI artifacts",
  );
  rejectText(
    ".github/workflows/release.yml",
    "Build broker Linux asset",
    "release workflow must not rebuild broker Linux assets; it must consume CI artifacts",
  );
  rejectText(
    ".github/workflows/release.yml",
    "Build Node direct native asset",
    "release workflow must not rebuild Node direct assets; it must consume CI artifacts",
  );
  requireText(
    ".github/scripts/download-build-artifacts.mjs",
    "artifactPresent",
    "shared artifact downloader must select a successful CI run containing every requested artifact",
  );
  requireText(
    ".github/scripts/download-build-artifacts.mjs",
    "requiredJobSuccess",
    "shared artifact downloader must support the builder-gate handoff when non-builder checks fail",
  );
  requireText(
    ".github/workflows/release.yml",
    'require-workflow-success.sh CI "$RELEASE_HEAD_SHA" 7200 --job Builds',
    "release workflow must require the selected release commit CI artifact builder gate instead of the whole workflow conclusion",
  );
  requireText(
    ".github/workflows/release.yml",
    "--job Builds",
    "release workflow artifact downloads must select artifacts from a run whose builds job succeeded",
  );
  requireText(
    ".github/scripts/download-wasix-runtime-build-artifacts.mjs",
    'args.push("--required-job", "Builds", "--all-targets")',
    "WASIX runtime artifact handoff must download from a CI run whose builds job succeeded",
  );
  requireText(
    "tools/xtask/src/asset_io.rs",
    "run_has_required_job_success",
    "xtask WASIX artifact downloads must support filtering selected release runs by required builder job",
  );
  if (release.indexOf("Download SDK package artifacts") > release.indexOf("Validate selected release product dry-runs")) {
    fail("release workflow must stage SDK artifacts before selected release product dry-runs");
  }
  if (release.indexOf("Download liboliphaunt release assets") > release.indexOf("Validate selected release product dry-runs")) {
    fail("release workflow must stage liboliphaunt runtime artifacts before selected release product dry-runs");
  }
  if (release.indexOf("Download native helper release assets") > release.indexOf("Validate selected release product dry-runs")) {
    fail("release workflow must stage native helper artifacts before selected release product dry-runs");
  }
  if (release.indexOf("Download WASIX release assets") > release.indexOf("Validate selected release product dry-runs")) {
    fail("release workflow must stage WASIX runtime release assets before selected release product dry-runs");
  }
  if (release.indexOf("--product liboliphaunt-wasix --step crates-io") > release.indexOf("--product oliphaunt-wasix-rust --step crates-io")) {
    fail("release workflow must publish liboliphaunt-wasix Cargo artifact crates before oliphaunt-wasix");
  }
  const extensionPackagesBlock = ci.slice(ci.indexOf("extension-packages:"), ci.indexOf("  liboliphaunt-native-desktop:"));
  if (extensionPackagesBlock.includes("Download portable WASIX runtime outputs")) {
    fail("extension-packages must consume WASIX extension artifact outputs, not raw portable runtime outputs");
  }
}

function validateTargetMatrices() {
  const ci = readText(".github/workflows/ci.yml");
  const release = readText(".github/workflows/release.yml");
  const planner = readText("tools/graph/ci_plan.mjs");
  for (const outputName of [
    "liboliphaunt_native_desktop_runtime_matrix",
    "liboliphaunt_native_android_runtime_matrix",
    "liboliphaunt_native_ios_runtime_matrix",
  ]) {
    if (!ci.includes(outputName) || !ci.includes(`fromJson(needs.affected.outputs.${outputName})`)) {
      fail(`CI ${outputName} matrix must come from affected planner output`);
    }
  }
  for (const [outputName, helper] of [
    ["liboliphaunt_native_desktop_runtime_matrix", "liboliphauntNativeDesktopRuntimeMatrix"],
    ["liboliphaunt_native_android_runtime_matrix", "liboliphauntNativeAndroidRuntimeMatrix"],
    ["liboliphaunt_native_ios_runtime_matrix", "liboliphauntNativeIosRuntimeMatrix"],
  ]) {
    requireText(
      "tools/graph/ci_plan.mjs",
      helper,
      `CI affected planner must derive ${outputName} from release metadata artifact targets`,
    );
  }
  if (!ci.includes("broker_runtime_matrix") || !ci.includes("fromJson(needs.affected.outputs.broker_runtime_matrix)")) {
    fail("CI broker matrix must come from affected planner output");
  }
  if (!ci.includes("node_direct_runtime_matrix") || !ci.includes("fromJson(needs.affected.outputs.node_direct_runtime_matrix)")) {
    fail("CI Node direct matrix must come from affected planner output");
  }
  if (!ci.includes("extension_artifacts_wasix_matrix") || !ci.includes("fromJson(needs.affected.outputs.extension_artifacts_wasix_matrix)")) {
    fail("CI WASIX extension artifact matrix must come from affected planner output");
  }
  requireText(
    ".github/workflows/ci.yml",
    "Build native exact-extension artifacts",
    "CI must build native exact-extension artifacts in their own producer job",
  );
  if (!ci.includes("extension_artifacts_native_matrix") || !ci.includes("fromJson(needs.affected.outputs.extension_artifacts_native_matrix)")) {
    fail("CI native extension artifact matrix must come from affected planner output");
  }
  requireText(
    "src/extensions/artifacts/native/moon.yml",
    "src/extensions/artifacts/native/tools/package-release-assets.sh",
    "CI native exact-extension artifact producer must use the release-shaped native extension packager",
  );
  requireText(
    "src/extensions/artifacts/packages/moon.yml",
    "tools/release/build-extension-ci-artifacts.mjs --all --require-native --require-wasix",
    "CI exact-extension package producer must use the shared product artifact builder",
  );
  requireText(
    "src/extensions/artifacts/packages/moon.yml",
    "/target/extensions/wasix/aot-artifacts/**/*",
    "CI exact-extension package producer must consume WASIX extension AOT artifacts",
  );
  requireText(
    "src/runtimes/liboliphaunt/wasix/tools/build-runtime-portable.sh",
    "cargo run -p xtask -- assets check --strict-generated",
    "WASIX portable runtime build must validate generated extension/runtime assets",
  );
  requireText(
    "src/runtimes/liboliphaunt/wasix/tools/build-aot-target.sh",
    'cargo run -p xtask -- assets package-extension-aot --target-triple "$target"',
    "WASIX AOT target build must package extension AOT artifacts for extension Cargo crates",
  );
  requireText(
    "src/runtimes/liboliphaunt/wasix/tools/build-aot-target.sh",
    'cargo run -p xtask -- assets check-aot --target-triple "$target"',
    "WASIX AOT target build must validate target AOT artifacts",
  );
  if (release.includes("native-release-targets:") || release.includes("native-release-assets:")) {
    fail("release workflow must not define separate native asset builder jobs; CI owns runtime/helper artifacts");
  }
  if (release.includes("artifact_target_matrix.py native-release-hosts")) {
    fail("release workflow must not use the removed native-release-hosts matrix");
  }
  if (!planner.includes("../release/artifact_target_matrix.mjs")) {
    fail("shared affected planner must query the release artifact target matrix helper");
  }

  const liboliphauntMatrix = artifactTargetMatrix("liboliphaunt-native-runtime");
  const liboliphauntTargets = new Set(liboliphauntMatrix.include.map((item) => item.target));
  const expectedLiboliphauntTargets = new Set(
    artifactTargets({ product: "liboliphaunt-native", kind: "native-runtime", publishedOnly: true }).map((target) => target.target),
  );
  if (!sameSet(liboliphauntTargets, expectedLiboliphauntTargets)) {
    fail(
      "liboliphaunt CI matrix does not match published native runtime targets: " +
        `${formatList(liboliphauntTargets)} vs ${formatList(expectedLiboliphauntTargets)}`,
    );
  }

  const extensionNativeMatrix = artifactTargetMatrix("extension-artifacts-native");
  const extensionNativePairs = new Set();
  for (const item of extensionNativeMatrix.include) {
    for (const product of item.extensions_csv.split(",")) {
      if (product) {
        extensionNativePairs.add(`${product}\0${item.target}`);
      }
    }
  }
  const expectedExtensionNativePairs = new Set(
    extensionArtifactTargets({ family: "native", publishedOnly: true }).map((target) => `${target.product}\0${target.target}`),
  );
  if (!sameSet(extensionNativePairs, expectedExtensionNativePairs)) {
    fail(
      "native extension artifact CI matrix does not match published exact-extension native product/target pairs: " +
        `${formatList([...extensionNativePairs].map((item) => item.split("\0")))} vs ${formatList([...expectedExtensionNativePairs].map((item) => item.split("\0")))}`,
    );
  }

  const brokerMatrix = artifactTargetMatrix("broker-runtime");
  const brokerTargets = new Set(brokerMatrix.include.map((item) => item.target));
  const expectedBrokerTargets = new Set(
    artifactTargets({ product: "oliphaunt-broker", kind: "broker-helper", publishedOnly: true }).map((target) => target.target),
  );
  if (!sameSet(brokerTargets, expectedBrokerTargets)) {
    fail(`broker CI matrix does not match published broker helper targets: ${formatList(brokerTargets)} vs ${formatList(expectedBrokerTargets)}`);
  }

  const nodeDirectMatrix = artifactTargetMatrix("node-direct-runtime");
  const nodeDirectTargets = new Set(nodeDirectMatrix.include.map((item) => item.target));
  const expectedNodeDirectTargets = new Set(
    artifactTargets({ product: "oliphaunt-node-direct", kind: "node-direct-addon", publishedOnly: true }).map((target) => target.target),
  );
  if (!sameSet(nodeDirectTargets, expectedNodeDirectTargets)) {
    fail(`Node direct CI matrix does not match published Node direct targets: ${formatList(nodeDirectTargets)} vs ${formatList(expectedNodeDirectTargets)}`);
  }

  const extensionWasixMatrix = artifactTargetMatrix("extension-artifacts-wasix");
  const extensionWasixPairs = new Set();
  for (const item of extensionWasixMatrix.include) {
    for (const product of item.extensions_csv.split(",")) {
      if (product) {
        extensionWasixPairs.add(`${product}\0${item.target}`);
      }
    }
  }
  const expectedExtensionWasixPairs = new Set(
    extensionArtifactTargets({ family: "wasix", publishedOnly: true }).map((target) => `${target.product}\0${target.target}`),
  );
  if (!sameSet(extensionWasixPairs, expectedExtensionWasixPairs)) {
    fail(
      "WASIX extension artifact CI matrix does not match published exact-extension WASIX product/target pairs: " +
        `${formatList([...extensionWasixPairs].map((item) => item.split("\0")))} vs ${formatList([...expectedExtensionWasixPairs].map((item) => item.split("\0")))}`,
    );
  }
}

function validateTypescriptRuntimeTargets() {
  for (const target of artifactTargets({ product: "liboliphaunt-native", kind: "native-runtime", surface: "typescript-native-direct" })) {
    const source = "src/sdks/js/src/native/common.ts";
    if (target.published) {
      if (target.npm_package === null) {
        fail(`${target.id} must declare npm_package for TypeScript native resolution`);
      }
      if (target.library_relative_path === null) {
        fail(`${target.id} must declare library_relative_path for TypeScript native resolution`);
      }
      requireText(source, target.npm_package, `TypeScript native resolver must advertise ${target.id}`);
      requireText(source, target.target, `TypeScript native resolver must expose target id ${target.target}`);
      requireText(source, target.library_relative_path, `TypeScript native resolver must expose library path for ${target.id}`);
      requireText(source, "runtimeRelativePath", `TypeScript native resolver must expose runtime package path for ${target.id}`);
    } else {
      if (target.npm_package !== null) {
        rejectText(source, target.npm_package, `TypeScript native resolver must not advertise unpublished target ${target.id}`);
      }
      rejectText(source, target.target, `TypeScript native resolver must not expose unpublished target id ${target.target}`);
    }
  }

  for (const target of artifactTargets({ product: "oliphaunt-broker", kind: "broker-helper", surface: "typescript-broker" })) {
    const source = "src/sdks/js/src/runtime/broker.ts";
    if (target.published) {
      if (target.npm_package === null) {
        fail(`${target.id} must declare npm_package for TypeScript broker resolution`);
      }
      if (target.executable_relative_path === null) {
        fail(`${target.id} must declare executable_relative_path for TypeScript broker resolution`);
      }
      requireText(source, target.npm_package, `TypeScript broker resolver must advertise ${target.id}`);
      requireText(source, target.target, `TypeScript broker resolver must expose target id ${target.target}`);
      requireText(source, target.executable_relative_path, `TypeScript broker resolver must expose executable path for ${target.id}`);
    } else {
      if (target.npm_package !== null) {
        rejectText(source, target.npm_package, `TypeScript broker resolver must not advertise unpublished target ${target.id}`);
      }
      rejectText(source, target.target, `TypeScript broker resolver must not expose unpublished target id ${target.target}`);
    }
  }

  for (const target of artifactTargets({ product: "oliphaunt-node-direct", kind: "node-direct-addon", surface: "npm-optional" })) {
    const source = "src/sdks/js/src/native/node-addon.ts";
    if (target.published) {
      if (target.npm_package === null) {
        fail(`${target.id} must declare npm_package for TypeScript Node direct resolution`);
      }
      requireText(source, target.npm_package, `TypeScript Node direct resolver must advertise ${target.id}`);
      requireText(source, target.target, `TypeScript Node direct resolver must expose target id ${target.target}`);
      requireText(source, "ADDON_STEM", `TypeScript Node direct resolver must expose addon path for ${target.id}`);
    } else {
      if (target.npm_package !== null) {
        rejectText(source, target.npm_package, `TypeScript Node direct resolver must not advertise unpublished target ${target.id}`);
      }
      rejectText(source, target.target, `TypeScript Node direct resolver must not expose unpublished target id ${target.target}`);
    }
  }
}

function validateRustBrokerTargets() {
  const manifest = "src/sdks/rust/Cargo.toml";
  const source = "src/sdks/rust/src/broker.rs";
  requireText(
    manifest,
    'broker-helper = "oliphaunt-broker"',
    "Rust SDK package metadata must identify the broker helper runtime it consumes",
  );
  requireText(
    manifest,
    `broker-version = "${readCurrentVersion("oliphaunt-broker")}"`,
    "Rust SDK package metadata must pin the compatible broker helper version",
  );
  requireText(
    source,
    "OLIPHAUNT_BROKER_ASSET_DIR",
    "Rust broker resolver must support package-shaped broker artifact fixtures",
  );
  for (const target of artifactTargets({ product: "oliphaunt-broker", kind: "broker-helper", surface: "rust-broker" })) {
    if (target.published) {
      requireText(source, target.asset, `Rust broker resolver must advertise ${target.id}`);
      requireText(source, target.target, `Rust broker resolver must expose target id ${target.target}`);
      if (target.executable_relative_path !== null) {
        requireText(source, target.executable_relative_path, `Rust broker resolver must expose helper path for ${target.id}`);
      }
    } else {
      rejectText(source, target.asset, `Rust broker resolver must not advertise unpublished target ${target.id}`);
      rejectText(source, target.target, `Rust broker resolver must not expose unpublished target id ${target.target}`);
    }
  }
}

function validateExpectedProductAssets() {
  const expected = {
    "liboliphaunt-native": new Set([
      "liboliphaunt-{version}-macos-arm64.tar.gz",
      "oliphaunt-tools-{version}-macos-arm64.tar.gz",
      "liboliphaunt-{version}-linux-x64-gnu.tar.gz",
      "oliphaunt-tools-{version}-linux-x64-gnu.tar.gz",
      "liboliphaunt-{version}-linux-arm64-gnu.tar.gz",
      "oliphaunt-tools-{version}-linux-arm64-gnu.tar.gz",
      "liboliphaunt-{version}-windows-x64-msvc.zip",
      "oliphaunt-tools-{version}-windows-x64-msvc.zip",
      "liboliphaunt-{version}-ios-xcframework.tar.gz",
      "liboliphaunt-{version}-apple-spm-xcframework.zip",
      "liboliphaunt-{version}-android-arm64-v8a.tar.gz",
      "liboliphaunt-{version}-android-x86_64.tar.gz",
      "liboliphaunt-{version}-runtime-resources.tar.gz",
      "liboliphaunt-{version}-icu-data.tar.gz",
      "liboliphaunt-{version}-package-size.tsv",
      "liboliphaunt-{version}-release-assets.sha256",
    ]),
    "oliphaunt-broker": new Set([
      "oliphaunt-broker-{version}-macos-arm64.tar.gz",
      "oliphaunt-broker-{version}-linux-x64-gnu.tar.gz",
      "oliphaunt-broker-{version}-linux-arm64-gnu.tar.gz",
      "oliphaunt-broker-{version}-windows-x64-msvc.zip",
      "oliphaunt-broker-{version}-release-assets.sha256",
    ]),
    "oliphaunt-node-direct": new Set([
      "oliphaunt-node-direct-{version}-macos-arm64.tar.gz",
      "oliphaunt-node-direct-{version}-linux-x64-gnu.tar.gz",
      "oliphaunt-node-direct-{version}-linux-arm64-gnu.tar.gz",
      "oliphaunt-node-direct-{version}-windows-x64-msvc.zip",
      "oliphaunt-node-direct-{version}-release-assets.sha256",
    ]),
    "liboliphaunt-wasix": new Set([
      "liboliphaunt-wasix-{version}-runtime-portable.tar.zst",
      "liboliphaunt-wasix-{version}-icu-data.tar.zst",
      "liboliphaunt-wasix-{version}-runtime-aot-macos-arm64.tar.zst",
      "liboliphaunt-wasix-{version}-runtime-aot-linux-x64-gnu.tar.zst",
      "liboliphaunt-wasix-{version}-runtime-aot-linux-arm64-gnu.tar.zst",
      "liboliphaunt-wasix-{version}-runtime-aot-windows-x64-msvc.tar.zst",
      "liboliphaunt-wasix-{version}-release-assets.sha256",
    ]),
  };
  for (const [product, assets] of Object.entries(expected)) {
    const actual = new Set(
      artifactTargets({ product, surface: "github-release", publishedOnly: true }).map((target) => target.asset),
    );
    if (!sameSet(actual, assets)) {
      fail(`${product} published artifact targets expected ${formatList(assets)}, got ${formatList(actual)}`);
    }
  }
}

function main() {
  validateTargetShape();
  validateMoonRuntimeTargets();
  validateExtensionArtifactTargets();
  validateGithubAssetHelpers();
  validateCiReleaseArtifacts();
  validateTargetMatrices();
  validateTypescriptRuntimeTargets();
  validateRustBrokerTargets();
  validateExpectedProductAssets();
  console.log("artifact target checks passed");
  return 0;
}

try {
  process.exit(main());
} catch (error) {
  fail(error?.message ?? String(error));
}
