#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { ROOT, run } from "./release-cli-utils.mjs";
import {
  cargoPackageIdentityFromCrate,
  npmPackageIdentity,
  packageNativeExtensionCargoCrates,
  stageExtensionNpmPackages,
} from "./local-registry-publish.mjs";
import {
  EXTENSION_NATIVE_CARGO_TARGETS,
  EXTENSION_NPM_TARGETS,
  extensionNpmPackage,
} from "./extension-registry-packages.mjs";
import {
  SUPPORTED_BUN_PRODUCT_DRY_RUNS,
  brokerNpmTarballs,
  buildMavenArtifactManifest,
  ensureBrokerReleaseAssets,
  ensureLiboliphauntReleaseAssets,
  ensureNodeDirectReleaseAssets,
  ensureWasixReleaseAssets,
  extensionAssetPaths,
  liboliphauntNativeCargoArtifactPackages,
  liboliphauntNpmTarballs,
  liboliphauntWasixCargoArtifactPackages,
  nodeDirectOptionalNpmTarballs,
  runBunProductDryRun,
  runMavenArtifactPublisher,
} from "./release-product-dry-run.mjs";
import {
  prepareStagedSwiftReleaseManifest,
  stagedKotlinMavenRepo,
  stagedJsrSourceDir,
  stagedSdkNpmPackageTarball,
  verifyStagedCargoProductCrates,
} from "./release-sdk-product-dry-run.mjs";
import { prepareOliphauntWasixReleaseSource } from "./package_oliphaunt_wasix_sdk_crate.mjs";
import {
  artifactTargets,
  compareText,
  currentProductVersionSync,
  exactExtensionProducts,
  extensionSqlName,
  registryPackageRows,
} from "./release-artifact-targets.mjs";

const TOOL = "release-publish.mjs";
const COMMANDS = new Set(["publish", "publish-dry-run"]);
const REGISTRY_PUBLICATION_CHECK = [
  "tools/dev/bun.sh",
  "tools/release/check_registry_publication.mjs",
];

function usage() {
  console.log(`usage: tools/release/release-publish.mjs <publish|publish-dry-run> [publish args]

Runs protected release publish and publish dry-run operations through the Bun
release command surface. The public no-product publish dry-run and product
dry-runs are handled in Bun, including the legacy --wasm shortcut for the WASIX
Rust SDK dry-run. Protected publish steps and no-product publish validation are
handled in Bun.
`);
}

function fail(message, exitCode = 2) {
  console.error(`${TOOL}: ${message}`);
  process.exit(exitCode);
}

const argv = Bun.argv.slice(2);
const command = argv[0];
const LEGACY_WASM_DRY_RUN_PRODUCT = "oliphaunt-wasix-rust";
const EXTENSION_PRODUCTS = new Set(exactExtensionProducts(TOOL));
const GITHUB_RELEASE_ASSET_PUBLISHERS = new Map([
  [
    "liboliphaunt-native",
    {
      assetDir: "target/liboliphaunt/release-assets",
      ensure: ensureLiboliphauntReleaseAssets,
      suffixes: [".tar.gz", ".tar.zst", ".tsv", ".zip", ".sha256"],
    },
  ],
  [
    "liboliphaunt-wasix",
    {
      assetDir: "target/oliphaunt-wasix/release-assets",
      ensure: ensureWasixReleaseAssets,
      suffixes: [".tar.zst", ".sha256"],
    },
  ],
  [
    "oliphaunt-broker",
    {
      assetDir: "target/oliphaunt-broker/release-assets",
      ensure: ensureBrokerReleaseAssets,
      suffixes: [".tar.gz", ".zip", ".sha256"],
    },
  ],
  [
    "oliphaunt-node-direct",
    {
      assetDir: "target/oliphaunt-node-direct/release-assets",
      ensure: ensureNodeDirectReleaseAssets,
      suffixes: [".tar.gz", ".zip", ".sha256"],
    },
  ],
]);

if (command === "-h" || command === "--help") {
  usage();
  process.exit(0);
}

if (!COMMANDS.has(command)) {
  usage();
  fail(`expected publish or publish-dry-run, got ${command ?? "<missing>"}`);
}

function isNoProductPublishDryRun(command, args) {
  return command === "publish-dry-run" && noProductPublishDryRunPassthrough(args) !== null;
}

function selectsProducts(args) {
  return args.some((arg) => arg === "--products-json" || arg.startsWith("--products-json="));
}

function flagValue(args, flag) {
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === flag) {
      if (index + 1 >= args.length) {
        fail(`${flag} requires a value`);
      }
      return args[index + 1];
    }
    if (value.startsWith(`${flag}=`)) {
      return value.slice(flag.length + 1);
    }
  }
  return null;
}

function rel(file) {
  return path.relative(ROOT, file).split(path.sep).join("/");
}

function isFile(file) {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

function isDirectory(file) {
  try {
    return statSync(file).isDirectory();
  } catch {
    return false;
  }
}

function globReleaseAssets(assetDir, suffixes) {
  if (!isDirectory(assetDir)) {
    fail(`release asset directory does not exist: ${rel(assetDir)}`);
  }
  const assets = readdirSync(assetDir)
    .map((name) => path.join(assetDir, name))
    .filter((file) => isFile(file) && suffixes.some((suffix) => file.endsWith(suffix)))
    .sort((left, right) => rel(left).localeCompare(rel(right)))
    .map(rel);
  if (assets.length === 0) {
    fail(`no release assets found in ${rel(assetDir)}`);
  }
  return assets;
}

function sortedStrings(values) {
  return [...values].sort(compareText);
}

function assertSameStringSet(label, actual, expected) {
  const actualSorted = sortedStrings(actual);
  const expectedSorted = sortedStrings(expected);
  if (JSON.stringify(actualSorted) !== JSON.stringify(expectedSorted)) {
    fail(`${label}: expected=${JSON.stringify(expectedSorted)}, actual=${JSON.stringify(actualSorted)}`);
  }
}

function noProductPublishDryRunPassthrough(args) {
  if (args.includes("--wasm") || selectsProducts(args)) {
    return null;
  }
  return args.filter((arg) => arg !== "--allow-dirty");
}

function legacyWasmPublishDryRunPlan(args) {
  if (!args.includes("--wasm") || selectsProducts(args)) {
    return null;
  }
  return {
    allowDirty: args.includes("--allow-dirty"),
    passthrough: args.filter((arg) => arg !== "--allow-dirty" && arg !== "--wasm"),
    product: LEGACY_WASM_DRY_RUN_PRODUCT,
  };
}

function parseProductsJson(args) {
  const productsJson = flagValue(args, "--products-json");
  if (productsJson === null) {
    return null;
  }
  let requested;
  try {
    requested = JSON.parse(productsJson);
  } catch (error) {
    fail(`--products-json must be valid JSON: ${error.message}`);
  }
  if (!Array.isArray(requested) || requested.length === 0 || !requested.every((item) => typeof item === "string")) {
    fail("--products-json must be a non-empty JSON string array");
  }
  return requested;
}

function releaseOrderedProducts(requested) {
  const ordered = jsonOutput([
    "tools/release/release_graph_query.mjs",
    "release-order",
    "--products-json",
    JSON.stringify(requested),
  ]);
  if (!Array.isArray(ordered) || ordered.length === 0 || !ordered.every((item) => typeof item === "string")) {
    fail("release graph could not resolve the selected publish products");
  }
  return ordered;
}

function publishProductStepPlan(args) {
  const product = flagValue(args, "--product");
  const step = flagValue(args, "--step");
  if (product === null && step === null) {
    return null;
  }
  if (product === null || step === null) {
    return null;
  }
  return {
    headRef: flagValue(args, "--head-ref") ?? "HEAD",
    product,
    step,
  };
}

function verifyReleaseTag(product, headRef) {
  run(TOOL, ["tools/dev/bun.sh", "tools/release/verify_product_tag.mjs", product, "--target", headRef]);
}

function uploadGithubReleaseAssets(product, assets) {
  const command = ["tools/dev/bun.sh", "tools/release/upload_github_release_assets.mjs", product];
  for (const asset of assets) {
    command.push("--asset", asset);
  }
  run(TOOL, command);
}

function publishGithubReleaseAssets(product, headRef, publisher) {
  verifyReleaseTag(product, headRef);
  publisher.ensure();
  uploadGithubReleaseAssets(
    product,
    globReleaseAssets(path.join(ROOT, publisher.assetDir), publisher.suffixes),
  );
}

function publishExtensionGithubReleaseAssets(product, headRef) {
  verifyReleaseTag(product, headRef);
  uploadGithubReleaseAssets(product, extensionAssetPaths(product));
}

function publishSelectedExtensionGithubReleaseAssets(products, headRef) {
  const extensions = products
    .filter((product) => EXTENSION_PRODUCTS.has(product))
    .sort(compareText);
  if (extensions.length === 0) {
    fail("no extension products selected");
  }
  for (const product of extensions) {
    publishExtensionGithubReleaseAssets(product, headRef);
  }
}

function selectedExtensionProducts(products) {
  const extensions = products
    .filter((product) => EXTENSION_PRODUCTS.has(product))
    .sort(compareText);
  if (extensions.length === 0) {
    fail("no extension products selected");
  }
  return extensions;
}

function requireSelectedExtensionArtifactRoots(extensions, headRef) {
  const roots = [];
  for (const product of extensions) {
    verifyReleaseTag(product, headRef);
    extensionAssetPaths(product);
    const root = path.join(ROOT, "target/extension-artifacts", product);
    if (!isDirectory(root)) {
      fail(`missing staged extension artifact root: ${rel(root)}`);
    }
    roots.push(root);
  }
  return roots;
}

function registryPublicationCheck(args) {
  run(TOOL, [...REGISTRY_PUBLICATION_CHECK, ...args]);
}

function registryPublicationCheckSucceeds(args) {
  const result = spawnSync(REGISTRY_PUBLICATION_CHECK[0], [...REGISTRY_PUBLICATION_CHECK.slice(1), ...args], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: "ignore",
  });
  if (result.error !== undefined) {
    fail(`registry publication check failed to start: ${result.error.message}`);
  }
  return result.status === 0;
}

function gitCommit(ref) {
  const result = spawnSync("git", ["rev-parse", `${ref}^{commit}`], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

function productTagPointsAt(product, headRef) {
  const version = currentProductVersionSync(product, TOOL);
  const tagCommit = gitCommit(`${product}-v${version}`);
  const headCommit = gitCommit(headRef);
  return tagCommit !== null && headCommit !== null && tagCommit === headCommit;
}

function publishedRerun(product, headRef) {
  return productTagPointsAt(product, headRef) && productRegistryPublished(product, null);
}

function extensionMavenArtifactsPublished(products) {
  return registryPublicationCheckSucceeds([
    "--products-json",
    JSON.stringify(products),
    "--registry-kind",
    "maven",
    "--require-published",
  ]);
}

function requireExtensionMavenArtifactsPublished(products) {
  registryPublicationCheck([
    "--products-json",
    JSON.stringify(products),
    "--registry-kind",
    "maven",
    "--require-published",
    "--retries",
    "12",
    "--retry-delay",
    "10",
  ]);
}

function extensionRegistryArtifactsPublished(products, registryKind) {
  return registryPublicationCheckSucceeds([
    "--products-json",
    JSON.stringify(products),
    "--registry-kind",
    registryKind,
    "--require-published",
  ]);
}

function requireExtensionRegistryArtifactsPublished(products, registryKind) {
  registryPublicationCheck([
    "--products-json",
    JSON.stringify(products),
    "--registry-kind",
    registryKind,
    "--require-published",
    "--retries",
    "12",
    "--retry-delay",
    "10",
  ]);
}

function productRegistryPublished(product, registryKind) {
  return registryPublicationCheckSucceeds([
    "--product",
    product,
    "--registry-kind",
    registryKind,
    "--require-published",
  ]);
}

function requireProductRegistryPublished(product, registryKind) {
  const args = [
    "--product",
    product,
    "--require-published",
    "--retries",
    "12",
    "--retry-delay",
    "10",
  ];
  if (registryKind !== null) {
    args.splice(2, 0, "--registry-kind", registryKind);
  }
  registryPublicationCheck(args);
}

function requireProductRegistryVersionPublished(product, registryKind, version) {
  registryPublicationCheck([
    "--product",
    product,
    "--registry-kind",
    registryKind,
    "--require-published",
    "--version",
    version,
  ]);
}

function npmPackagePublished(packageName, version) {
  const result = spawnSync("npm", ["view", `${packageName}@${version}`, "version"], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: "ignore",
  });
  if (result.error !== undefined) {
    fail(`npm view failed to start: ${result.error.message}`);
  }
  return result.status === 0;
}

function cratesioCrateVersionPublished(crateName, version) {
  const result = jsonOutput([
    "tools/release/check_registry_publication.mjs",
    "crate-version-exists",
    "--crate",
    crateName,
    "--version",
    version,
  ]);
  if (result === null || typeof result.exists !== "boolean") {
    fail(`crate-version-exists returned invalid JSON for ${crateName} ${version}`);
  }
  return result.exists;
}

async function waitForCratesioCrate(crateName, version) {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    if (cratesioCrateVersionPublished(crateName, version)) {
      return;
    }
    await Bun.sleep(10_000);
  }
  fail(`${crateName} ${version} did not appear on crates.io after publish`);
}

async function cargoPublishManifest(crateName, version, manifestPath) {
  if (cratesioCrateVersionPublished(crateName, version)) {
    console.log(`${crateName} ${version} is already published on crates.io; skipping cargo publish.`);
    return;
  }
  run(TOOL, [
    "cargo",
    "publish",
    "--manifest-path",
    manifestPath,
    "--target-dir",
    path.join(ROOT, "target/release/cargo-publish"),
  ]);
  await waitForCratesioCrate(crateName, version);
}

async function cargoPublishWorkspacePackage(crateName, version) {
  if (cratesioCrateVersionPublished(crateName, version)) {
    console.log(`${crateName} ${version} is already published on crates.io; skipping cargo publish.`);
    return;
  }
  run(TOOL, ["cargo", "publish", "-p", crateName, "--locked"]);
  await waitForCratesioCrate(crateName, version);
}

function commandOutput(args, { cwd = ROOT } = {}) {
  const result = spawnSync(args[0], args.slice(1), {
    cwd,
    encoding: "utf8",
    maxBuffer: 100 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error !== undefined) {
    fail(`${args[0]} failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    fail(`${args.join(" ")} failed${result.stderr ? `: ${result.stderr.trim()}` : ""}`);
  }
  return result.stdout;
}

function prepareRustSdkReleaseManifest() {
  const output = commandOutput(["tools/dev/bun.sh", "tools/release/prepare-rust-release-source.mjs"]);
  const manifest = output.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean).at(-1);
  if (typeof manifest !== "string" || !manifest.endsWith("Cargo.toml")) {
    fail(`prepare-rust-release-source.mjs did not print a generated Cargo.toml path: ${JSON.stringify(output)}`);
  }
  const manifestPath = path.isAbsolute(manifest) ? manifest : path.join(ROOT, manifest);
  if (!isFile(manifestPath)) {
    fail(`generated Rust SDK release manifest does not exist: ${rel(manifestPath)}`);
  }
  return manifestPath;
}

function npmPublishTarball(packageName, tarball, version) {
  if (npmPackagePublished(packageName, version)) {
    console.log(`${packageName} ${version} is already published on npm; skipping npm publish.`);
    return;
  }
  run(TOOL, ["npm", "publish", tarball, "--access", "public", "--provenance"]);
}

function brokerCargoArtifactCrates(version) {
  const product = "oliphaunt-broker";
  ensureBrokerReleaseAssets();
  const outputDir = path.join(ROOT, "target/oliphaunt-broker/cargo-artifacts");
  run(TOOL, [
    "tools/dev/bun.sh",
    "tools/release/package_broker_cargo_artifacts.mjs",
    "--version",
    version,
    "--output-dir",
    rel(outputDir),
  ]);

  const expectedCrates = new Set(
    artifactTargets(product, "broker-helper", TOOL)
      .filter((target) => target.surfaces.includes("rust-broker"))
      .map((target) => `${product}-${target.target}`),
  );
  const configuredCrates = new Set(
    registryPackageRows({ product, packageKind: "crates" }, TOOL)
      .map((row) => row.packageName),
  );
  assertSameStringSet(`${product} crates.io packages must match broker artifact targets`, configuredCrates, expectedCrates);

  const sourceRoot = path.join(ROOT, "target/oliphaunt-broker/cargo-package-sources");
  const expectedPaths = new Set();
  const packages = [];
  for (const crateName of sortedStrings(expectedCrates)) {
    const cratePath = path.join(outputDir, `${crateName}-${version}.crate`);
    const manifestPath = path.join(sourceRoot, crateName, "Cargo.toml");
    expectedPaths.add(path.resolve(cratePath));
    if (!isFile(cratePath)) {
      fail(`missing generated broker Cargo artifact crate: ${rel(cratePath)}`);
    }
    if (!isFile(manifestPath)) {
      fail(`missing generated broker Cargo artifact manifest: ${rel(manifestPath)}`);
    }
    packages.push([crateName, cratePath, manifestPath]);
  }
  const unexpected = readdirSync(outputDir)
    .filter((name) => name.endsWith(".crate"))
    .map((name) => path.join(outputDir, name))
    .filter((file) => !expectedPaths.has(path.resolve(file)))
    .map((file) => path.basename(file))
    .sort(compareText);
  if (unexpected.length > 0) {
    fail(`unexpected broker Cargo artifact crate(s): ${unexpected.join(", ")}`);
  }
  return packages;
}

async function publishNodeDirectNpmOptionalPackages(headRef) {
  const product = "oliphaunt-node-direct";
  verifyReleaseTag(product, headRef);
  const version = currentProductVersionSync(product, TOOL);
  ensureNodeDirectReleaseAssets();
  const tarballs = await nodeDirectOptionalNpmTarballs(version);
  for (const [packageName, tarball] of tarballs) {
    npmPublishTarball(packageName, tarball, version);
  }
  requireProductRegistryPublished(product, null);
}

function publishBrokerNpmPackages(headRef) {
  const product = "oliphaunt-broker";
  verifyReleaseTag(product, headRef);
  const version = currentProductVersionSync(product, TOOL);
  ensureBrokerReleaseAssets();
  for (const [packageName, tarball] of brokerNpmTarballs(version)) {
    npmPublishTarball(packageName, tarball, version);
  }
  requireProductRegistryPublished(product, "npm");
}

async function publishBrokerCargoArtifacts(headRef) {
  const product = "oliphaunt-broker";
  verifyReleaseTag(product, headRef);
  const version = currentProductVersionSync(product, TOOL);
  for (const [crateName, , manifestPath] of brokerCargoArtifactCrates(version)) {
    await cargoPublishManifest(crateName, version, manifestPath);
  }
  requireProductRegistryPublished(product, "crates");
}

async function publishLiboliphauntWasixCargoArtifacts(headRef) {
  const product = "liboliphaunt-wasix";
  verifyReleaseTag(product, headRef);
  const version = currentProductVersionSync(product, TOOL);
  for (const { name, manifestPath } of liboliphauntWasixCargoArtifactPackages(version)) {
    await cargoPublishManifest(name, version, manifestPath);
  }
  requireProductRegistryPublished(product, "crates");
}

async function publishLiboliphauntNativeCargoArtifacts(headRef) {
  const product = "liboliphaunt-native";
  verifyReleaseTag(product, headRef);
  const version = currentProductVersionSync(product, TOOL);
  for (const { name, manifestPath } of liboliphauntNativeCargoArtifactPackages(version)) {
    await cargoPublishManifest(name, version, manifestPath);
  }
  requireProductRegistryPublished(product, "crates");
}

function publishLiboliphauntNpmPackages(headRef) {
  const product = "liboliphaunt-native";
  verifyReleaseTag(product, headRef);
  const version = currentProductVersionSync(product, TOOL);
  ensureLiboliphauntReleaseAssets();
  for (const [packageName, tarball] of liboliphauntNpmTarballs(version)) {
    npmPublishTarball(packageName, tarball, version);
  }
  requireProductRegistryPublished(product, "npm");
}

function publishReactNativeNpm(headRef) {
  const product = "oliphaunt-react-native";
  const packageName = "@oliphaunt/react-native";
  verifyReleaseTag(product, headRef);
  const version = currentProductVersionSync(product, TOOL);
  if (npmPackagePublished(packageName, version)) {
    console.log(`${packageName} ${version} is already published on npm; skipping npm publish.`);
  } else {
    npmPublishTarball(packageName, stagedSdkNpmPackageTarball(product), version);
  }
  requireProductRegistryPublished(product, null);
  uploadGithubReleaseAssets(product, []);
}

function publishSwiftGithubRelease(headRef) {
  const product = "oliphaunt-swift";
  verifyReleaseTag(product, headRef);
  const manifest = prepareStagedSwiftReleaseManifest();
  run(TOOL, [
    "tools/dev/bun.sh",
    "tools/release/publish_swiftpm_source_tag.mjs",
    "--target",
    headRef,
    "--manifest",
    rel(manifest),
    "--include-tree",
    "target/oliphaunt-swift/release-tree",
    "--push",
  ]);
  uploadGithubReleaseAssets(product, []);
}

function publishKotlinMaven(headRef) {
  const product = "oliphaunt-kotlin";
  verifyReleaseTag(product, headRef);
  stagedKotlinMavenRepo();
  const version = currentProductVersionSync(product, TOOL);
  if (productRegistryPublished(product, "maven")) {
    console.log(`dev.oliphaunt Android artifacts ${version} are already published on Maven Central; skipping publishAndReleaseToMavenCentral.`);
  } else {
    run(TOOL, [
      "src/sdks/kotlin/gradlew",
      "-p",
      "src/sdks/kotlin",
      ":oliphaunt:publishAndReleaseToMavenCentral",
      ":oliphaunt-android-gradle-plugin:publishAndReleaseToMavenCentral",
      `-PoliphauntBuildRoot=${path.join(ROOT, "target/liboliphaunt-sdk-check/gradle/oliphaunt-kotlin-release")}`,
      `-PoliphauntCxxBuildRoot=${path.join(ROOT, "target/liboliphaunt-sdk-check/cxx/oliphaunt-kotlin-release")}`,
      "--project-cache-dir",
      path.join(ROOT, "target/liboliphaunt-sdk-check/gradle-cache/oliphaunt-kotlin-release"),
      "--configuration-cache",
    ]);
  }
  requireProductRegistryPublished(product, "maven");
  uploadGithubReleaseAssets(product, []);
}

function publishTypescriptNpmJsr(headRef) {
  const product = "oliphaunt-js";
  const packageName = "@oliphaunt/ts";
  verifyReleaseTag(product, headRef);
  run(TOOL, [
    "tools/dev/bun.sh",
    "tools/release/check_release_versions.mjs",
    "--products-json",
    JSON.stringify([product]),
    "--head-ref",
    headRef,
    "--check-registries",
  ]);
  const version = currentProductVersionSync(product, TOOL);
  npmPublishTarball(packageName, stagedSdkNpmPackageTarball(product), version);
  if (productRegistryPublished(product, "jsr")) {
    console.log(`jsr:${packageName} ${version} is already published; skipping jsr publish.`);
  } else {
    run(TOOL, ["pnpm", "exec", "jsr", "publish"], { cwd: stagedJsrSourceDir(product) });
  }
  requireProductRegistryPublished(product, null);
  uploadGithubReleaseAssets(product, []);
}

async function publishRustCratesIo(headRef) {
  const product = "oliphaunt-rust";
  if (publishedRerun(product, headRef)) {
    console.log("oliphaunt-rust is already published at this commit; skipping crates.io publish.");
    return;
  }
  verifyReleaseTag(product, headRef);
  const version = currentProductVersionSync(product, TOOL);
  run(TOOL, ["tools/dev/bun.sh", "tools/release/check-staged-artifacts.mjs", "--require-sdk-product", product]);
  verifyStagedCargoProductCrates(product);
  const nativeVersion = currentProductVersionSync("liboliphaunt-native", TOOL);
  const brokerVersion = currentProductVersionSync("oliphaunt-broker", TOOL);
  requireProductRegistryVersionPublished("liboliphaunt-native", "crates", nativeVersion);
  requireProductRegistryVersionPublished("oliphaunt-broker", "crates", brokerVersion);
  await cargoPublishWorkspacePackage("oliphaunt-build", version);
  await cargoPublishManifest("oliphaunt", version, prepareRustSdkReleaseManifest());
  requireProductRegistryPublished(product, null);
}

async function publishWasixRustCratesIo(headRef) {
  const product = "oliphaunt-wasix-rust";
  if (publishedRerun(product, headRef)) {
    console.log("oliphaunt-wasix-rust is already published at this commit; skipping crates.io publish.");
    return;
  }
  verifyReleaseTag(product, headRef);
  const runtimeVersion = currentProductVersionSync("liboliphaunt-wasix", TOOL);
  requireProductRegistryVersionPublished("liboliphaunt-wasix", "crates", runtimeVersion);
  const version = currentProductVersionSync(product, TOOL);
  run(TOOL, ["tools/dev/bun.sh", "tools/release/check-staged-artifacts.mjs", "--require-sdk-product", product]);
  verifyStagedCargoProductCrates(product);
  const releaseManifest = await prepareOliphauntWasixReleaseSource(version);
  await cargoPublishManifest("oliphaunt-wasix", version, releaseManifest);
  requireProductRegistryPublished(product, null);
}

function publishLiboliphauntRuntimeMaven(headRef) {
  const product = "liboliphaunt-native";
  verifyReleaseTag(product, headRef);
  ensureLiboliphauntReleaseAssets();
  const manifest = buildMavenArtifactManifest("liboliphaunt-native-runtime", {
    runtime: true,
  });
  const version = currentProductVersionSync(product, TOOL);
  if (productRegistryPublished(product, "maven")) {
    console.log(`dev.oliphaunt.runtime artifacts ${version} are already published on Maven Central; skipping publishAndReleaseToMavenCentral.`);
  } else {
    runMavenArtifactPublisher(
      manifest,
      ":oliphaunt-maven-artifacts:publishAndReleaseToMavenCentral",
      "liboliphaunt-native-maven-release",
    );
  }
  requireProductRegistryPublished(product, "maven");
}

function publishSelectedExtensionMaven(products, headRef) {
  const extensions = selectedExtensionProducts(products);
  requireSelectedExtensionArtifactRoots(extensions, headRef);
  const manifest = buildMavenArtifactManifest("selected-extensions", {
    extensions: true,
    extensionProducts: extensions,
  });
  if (extensionMavenArtifactsPublished(extensions)) {
    console.log("selected Oliphaunt extension Android artifacts are already published on Maven Central; skipping publishAndReleaseToMavenCentral.");
  } else {
    runMavenArtifactPublisher(
      manifest,
      ":oliphaunt-maven-artifacts:publishAndReleaseToMavenCentral",
      "oliphaunt-extensions-maven-release",
    );
  }
  requireExtensionMavenArtifactsPublished(extensions);
}

function releaseSurfaceResult(surface) {
  return { surface, staged: [], skipped: [] };
}

function stagedTarballs(result) {
  return result.staged
    .filter((entry) => entry.endsWith(".tgz"))
    .map((entry) => path.isAbsolute(entry) ? entry : path.join(ROOT, entry));
}

function packageIdentityLabel(identity) {
  return `${identity.name}@${identity.version}`;
}

function extensionNpmMetaPackageNames(extensions) {
  return new Set(extensions.map((product) => extensionNpmPackage(extensionSqlName(product, TOOL))));
}

function publishSelectedExtensionNpm(products, headRef) {
  const extensions = selectedExtensionProducts(products);
  const roots = requireSelectedExtensionArtifactRoots(extensions, headRef);
  if (extensionRegistryArtifactsPublished(extensions, "npm")) {
    console.log("selected Oliphaunt extension npm packages are already published; skipping npm publish.");
    return;
  }

  const metaPackages = extensionNpmMetaPackageNames(extensions);
  const staged = [];
  for (const target of EXTENSION_NPM_TARGETS) {
    const result = releaseSurfaceResult(`extension-npm-${target}`);
    const tarballRoot = stageExtensionNpmPackages(
      roots,
      path.join(ROOT, "target/release/extension-npm", target),
      target,
      result,
      { metaTargets: EXTENSION_NPM_TARGETS },
    );
    if (tarballRoot === null) {
      fail(`failed to stage selected extension npm packages for ${target}: ${result.skipped.join("; ")}`);
    }
    staged.push(...stagedTarballs(result));
  }

  const seen = new Set();
  const packages = [];
  for (const tarball of staged) {
    const identity = npmPackageIdentity(tarball);
    if (identity === null) {
      fail(`could not read npm package identity from ${rel(tarball)}`);
    }
    const key = packageIdentityLabel(identity);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    packages.push({ ...identity, tarball });
  }
  const ordered = [
    ...packages.filter((pkg) => !metaPackages.has(pkg.name)),
    ...packages.filter((pkg) => metaPackages.has(pkg.name)),
  ];
  for (const pkg of ordered) {
    npmPublishTarball(pkg.name, pkg.tarball, pkg.version);
  }
  requireExtensionRegistryArtifactsPublished(extensions, "npm");
}

function cargoPackageManifestPath(cratePath, stagingRoot, identity) {
  const manifestPath = path.join(stagingRoot, "native-extension-sources", identity.name, "Cargo.toml");
  if (!isFile(manifestPath)) {
    fail(`missing generated Cargo manifest for ${identity.name} from ${rel(cratePath)}: ${rel(manifestPath)}`);
  }
  return manifestPath;
}

function nativeExtensionCargoPackages(roots) {
  const packages = [];
  for (const target of EXTENSION_NATIVE_CARGO_TARGETS) {
    const stagingRoot = path.join(ROOT, "target/release/extension-cargo", `native-${target}`);
    const result = releaseSurfaceResult(`extension-cargo-${target}`);
    const crates = packageNativeExtensionCargoCrates(roots, stagingRoot, target, true, result);
    if (crates.length === 0) {
      fail(`failed to package native extension Cargo crates for ${target}: ${result.skipped.join("; ")}`);
    }
    for (const cratePath of crates) {
      const identity = cargoPackageIdentityFromCrate(cratePath);
      if (identity === null) {
        fail(`could not read Cargo package identity from ${rel(cratePath)}`);
      }
      packages.push({
        ...identity,
        manifestPath: cargoPackageManifestPath(cratePath, stagingRoot, identity),
      });
    }
  }
  return packages;
}

function wasixExtensionCargoPackages(roots) {
  const outputDir = path.join(ROOT, "target/release/extension-cargo/wasix");
  const command = [
    "tools/dev/bun.sh",
    "tools/release/package_liboliphaunt_wasix_cargo_artifacts.mjs",
    "--extensions-only",
    "--output-dir",
    outputDir,
  ];
  for (const root of roots) {
    command.push("--extension-artifact-root", root);
  }
  run(TOOL, command);
  const manifestPath = path.join(outputDir, "packages.json");
  if (!isFile(manifestPath)) {
    fail(`WASIX extension Cargo package manifest was not generated: ${rel(manifestPath)}`);
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    fail(`failed to parse ${rel(manifestPath)}: ${error.message}`);
  }
  const packages = manifest.packages;
  if (!Array.isArray(packages)) {
    fail(`${rel(manifestPath)} must contain a packages list`);
  }
  return packages
    .filter((pkg) => pkg?.kind === "wasix-extension" || pkg?.kind === "wasix-extension-aot")
    .map((pkg) => {
      if (
        typeof pkg.name !== "string"
        || typeof pkg.manifestPath !== "string"
        || typeof pkg.cratePath !== "string"
      ) {
        fail(`${rel(manifestPath)} contains an invalid WASIX extension Cargo package row`);
      }
      const generatedManifest = path.join(ROOT, pkg.manifestPath);
      if (!isFile(generatedManifest)) {
        fail(`missing generated WASIX extension Cargo manifest: ${pkg.manifestPath}`);
      }
      const identity = cargoPackageIdentityFromCrate(path.join(ROOT, pkg.cratePath));
      if (identity === null) {
        fail(`could not read Cargo package identity from ${pkg.cratePath}`);
      }
      if (identity.name !== pkg.name) {
        fail(`${pkg.cratePath} package name ${identity.name} does not match generated manifest row ${pkg.name}`);
      }
      return {
        name: pkg.name,
        version: identity.version,
        manifestPath: generatedManifest,
      };
    });
}

async function publishSelectedExtensionCargo(products, headRef) {
  const extensions = selectedExtensionProducts(products);
  const roots = requireSelectedExtensionArtifactRoots(extensions, headRef);
  if (extensionRegistryArtifactsPublished(extensions, "crates")) {
    console.log("selected Oliphaunt extension Cargo artifact crates are already published; skipping cargo publish.");
    return;
  }
  const packages = [
    ...nativeExtensionCargoPackages(roots),
    ...wasixExtensionCargoPackages(roots),
  ];
  for (const pkg of packages) {
    await cargoPublishManifest(pkg.name, pkg.version, pkg.manifestPath);
  }
  requireExtensionRegistryArtifactsPublished(extensions, "crates");
}

function jsonOutput(args) {
  const result = spawnSync("tools/dev/bun.sh", args, {
    cwd: ROOT,
    encoding: "utf8",
  });
  if (result.status !== 0 || result.error !== undefined) {
    return null;
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
}

function productPublishDryRunPlan(args) {
  const requested = parseProductsJson(args);
  if (requested === null) {
    return null;
  }
  const unsupportedRequested = requested.filter((product) => !SUPPORTED_BUN_PRODUCT_DRY_RUNS.has(product));
  if (unsupportedRequested.length > 0) {
    fail(`unsupported Bun product publish dry-run selection: ${unsupportedRequested.join(", ")}`);
  }
  const ordered = releaseOrderedProducts(requested);
  const unsupportedOrdered = ordered.filter((product) => !SUPPORTED_BUN_PRODUCT_DRY_RUNS.has(product));
  if (unsupportedOrdered.length > 0) {
    fail(`release graph selected unsupported Bun product publish dry-run dependencies: ${unsupportedOrdered.join(", ")}`);
  }
  return {
    allowDirty: args.includes("--allow-dirty"),
    passthrough: args.filter((arg) => arg !== "--allow-dirty" && arg !== "--wasm"),
    products: ordered,
  };
}

async function runProductDryRunPlan(productDryRunPlan) {
  run(TOOL, ["tools/dev/bun.sh", "tools/release/release-check.mjs"]);
  run(TOOL, ["tools/dev/bun.sh", "tools/release/release-check-registries.mjs", ...productDryRunPlan.passthrough]);
  for (const product of productDryRunPlan.products) {
    await runBunProductDryRun(product, { allowDirty: productDryRunPlan.allowDirty });
  }
}

async function publishNoProduct(args) {
  const productsJson = flagValue(args, "--products-json");
  const productDryRunPlan = productPublishDryRunPlan(args);
  if (productsJson !== null) {
    run(TOOL, ["tools/release/check_publish_environment.mjs", "--products-json", productsJson]);
  }
  if (productDryRunPlan !== null) {
    await runProductDryRunPlan(productDryRunPlan);
    console.log("publish environment and dry-run checks passed; package-native publish steps run in the Release workflow");
    return;
  }
  run(TOOL, ["tools/dev/bun.sh", "tools/release/release-check.mjs"]);
  const passthrough = args.filter((arg) => arg !== "--allow-dirty");
  if (passthrough.length > 0) {
    run(TOOL, ["tools/dev/bun.sh", "tools/release/release-check-registries.mjs", ...passthrough]);
  }
  console.log("No release products selected; publish environment and package publish steps skipped.");
}

if (isNoProductPublishDryRun(command, argv.slice(1))) {
  const passthrough = noProductPublishDryRunPassthrough(argv.slice(1));
  run(TOOL, ["tools/dev/bun.sh", "tools/release/release-check.mjs"]);
  if (passthrough.length > 0) {
    run(TOOL, ["tools/dev/bun.sh", "tools/release/release-check-registries.mjs", ...passthrough]);
  }
  process.exit(0);
}

const productDryRunPlan = command === "publish-dry-run" ? productPublishDryRunPlan(argv.slice(1)) : null;
if (productDryRunPlan !== null) {
  await runProductDryRunPlan(productDryRunPlan);
  process.exit(0);
}

const legacyWasmDryRunPlan = command === "publish-dry-run" ? legacyWasmPublishDryRunPlan(argv.slice(1)) : null;
if (legacyWasmDryRunPlan !== null) {
  run(TOOL, ["tools/dev/bun.sh", "tools/release/release-check.mjs"]);
  if (legacyWasmDryRunPlan.passthrough.length > 0) {
    run(TOOL, ["tools/dev/bun.sh", "tools/release/release-check-registries.mjs", ...legacyWasmDryRunPlan.passthrough]);
  }
  await runBunProductDryRun(legacyWasmDryRunPlan.product, { allowDirty: legacyWasmDryRunPlan.allowDirty });
  process.exit(0);
}

if (command === "publish-dry-run") {
  fail("publish-dry-run is Bun-owned; unsupported arguments must fail before the protected release.py publish fallback");
}

const publishProductStep = command === "publish" ? publishProductStepPlan(argv.slice(1)) : null;
if (publishProductStep?.step === "github-release-assets") {
  const publisher = GITHUB_RELEASE_ASSET_PUBLISHERS.get(publishProductStep.product);
  if (publisher !== undefined) {
    publishGithubReleaseAssets(publishProductStep.product, publishProductStep.headRef, publisher);
    process.exit(0);
  }
  if (EXTENSION_PRODUCTS.has(publishProductStep.product)) {
    publishExtensionGithubReleaseAssets(publishProductStep.product, publishProductStep.headRef);
    process.exit(0);
  }
}

if (command === "publish" && flagValue(argv.slice(1), "--step") === "github-release-assets" && flagValue(argv.slice(1), "--product") === null) {
  const requested = parseProductsJson(argv.slice(1));
  if (requested !== null) {
    publishSelectedExtensionGithubReleaseAssets(
      releaseOrderedProducts(requested),
      flagValue(argv.slice(1), "--head-ref") ?? "HEAD",
    );
    process.exit(0);
  }
}

if (publishProductStep?.product === "liboliphaunt-native" && publishProductStep.step === "maven-central") {
  publishLiboliphauntRuntimeMaven(publishProductStep.headRef);
  process.exit(0);
}

if (publishProductStep?.product === "liboliphaunt-native" && publishProductStep.step === "npm") {
  publishLiboliphauntNpmPackages(publishProductStep.headRef);
  process.exit(0);
}

if (publishProductStep?.product === "liboliphaunt-native" && publishProductStep.step === "crates-io") {
  await publishLiboliphauntNativeCargoArtifacts(publishProductStep.headRef);
  process.exit(0);
}

if (publishProductStep?.product === "liboliphaunt-wasix" && publishProductStep.step === "crates-io") {
  await publishLiboliphauntWasixCargoArtifacts(publishProductStep.headRef);
  process.exit(0);
}

if (publishProductStep?.product === "oliphaunt-node-direct" && publishProductStep.step === "npm") {
  await publishNodeDirectNpmOptionalPackages(publishProductStep.headRef);
  process.exit(0);
}

if (publishProductStep?.product === "oliphaunt-broker" && publishProductStep.step === "npm") {
  publishBrokerNpmPackages(publishProductStep.headRef);
  process.exit(0);
}

if (publishProductStep?.product === "oliphaunt-broker" && publishProductStep.step === "crates-io") {
  await publishBrokerCargoArtifacts(publishProductStep.headRef);
  process.exit(0);
}

if (publishProductStep?.product === "oliphaunt-react-native" && publishProductStep.step === "npm") {
  publishReactNativeNpm(publishProductStep.headRef);
  process.exit(0);
}

if (publishProductStep?.product === "oliphaunt-swift" && publishProductStep.step === "github-release") {
  publishSwiftGithubRelease(publishProductStep.headRef);
  process.exit(0);
}

if (publishProductStep?.product === "oliphaunt-kotlin" && publishProductStep.step === "maven-central") {
  publishKotlinMaven(publishProductStep.headRef);
  process.exit(0);
}

if (publishProductStep?.product === "oliphaunt-js" && publishProductStep.step === "npm-jsr") {
  publishTypescriptNpmJsr(publishProductStep.headRef);
  process.exit(0);
}

if (publishProductStep?.product === "oliphaunt-rust" && publishProductStep.step === "crates-io") {
  await publishRustCratesIo(publishProductStep.headRef);
  process.exit(0);
}

if (publishProductStep?.product === "oliphaunt-wasix-rust" && publishProductStep.step === "crates-io") {
  await publishWasixRustCratesIo(publishProductStep.headRef);
  process.exit(0);
}

if (publishProductStep?.step === "maven-central" && EXTENSION_PRODUCTS.has(publishProductStep.product)) {
  publishSelectedExtensionMaven([publishProductStep.product], publishProductStep.headRef);
  process.exit(0);
}

if (publishProductStep?.step === "npm" && EXTENSION_PRODUCTS.has(publishProductStep.product)) {
  publishSelectedExtensionNpm([publishProductStep.product], publishProductStep.headRef);
  process.exit(0);
}

if (publishProductStep?.step === "crates-io" && EXTENSION_PRODUCTS.has(publishProductStep.product)) {
  await publishSelectedExtensionCargo([publishProductStep.product], publishProductStep.headRef);
  process.exit(0);
}

if (command === "publish" && flagValue(argv.slice(1), "--step") === "maven-central" && flagValue(argv.slice(1), "--product") === null) {
  const requested = parseProductsJson(argv.slice(1));
  if (requested !== null) {
    publishSelectedExtensionMaven(
      releaseOrderedProducts(requested),
      flagValue(argv.slice(1), "--head-ref") ?? "HEAD",
    );
    process.exit(0);
  }
}

if (command === "publish" && flagValue(argv.slice(1), "--step") === "npm" && flagValue(argv.slice(1), "--product") === null) {
  const requested = parseProductsJson(argv.slice(1));
  if (requested !== null) {
    publishSelectedExtensionNpm(
      releaseOrderedProducts(requested),
      flagValue(argv.slice(1), "--head-ref") ?? "HEAD",
    );
    process.exit(0);
  }
}

if (command === "publish" && flagValue(argv.slice(1), "--step") === "crates-io" && flagValue(argv.slice(1), "--product") === null) {
  const requested = parseProductsJson(argv.slice(1));
  if (requested !== null) {
    await publishSelectedExtensionCargo(
      releaseOrderedProducts(requested),
      flagValue(argv.slice(1), "--head-ref") ?? "HEAD",
    );
    process.exit(0);
  }
}

if (command === "publish" && publishProductStep === null && flagValue(argv.slice(1), "--product") === null && flagValue(argv.slice(1), "--step") === null) {
  await publishNoProduct(argv.slice(1));
  process.exit(0);
}

fail(`unsupported publish arguments: ${argv.slice(1).join(" ") || "<none>"}`);
