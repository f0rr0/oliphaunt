#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";

import { ROOT, run } from "./release-cli-utils.mjs";
import {
  SUPPORTED_BUN_PRODUCT_DRY_RUNS,
  buildMavenArtifactManifest,
  ensureBrokerReleaseAssets,
  ensureLiboliphauntReleaseAssets,
  ensureNodeDirectReleaseAssets,
  ensureWasixReleaseAssets,
  extensionAssetPaths,
  nodeDirectOptionalNpmTarballs,
  runBunProductDryRun,
  runMavenArtifactPublisher,
} from "./release-product-dry-run.mjs";
import {
  compareText,
  currentProductVersionSync,
  exactExtensionProducts,
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
Rust SDK dry-run. Protected publish dispatch still delegates to release.py while
the protected implementation is ported.
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

function npmPublishTarball(packageName, tarball, version) {
  if (npmPackagePublished(packageName, version)) {
    console.log(`${packageName} ${version} is already published on npm; skipping npm publish.`);
    return;
  }
  run(TOOL, ["npm", "publish", tarball, "--access", "public", "--provenance"]);
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
  const extensions = products
    .filter((product) => EXTENSION_PRODUCTS.has(product))
    .sort(compareText);
  if (extensions.length === 0) {
    fail("no extension products selected");
  }
  for (const product of extensions) {
    verifyReleaseTag(product, headRef);
    extensionAssetPaths(product);
  }
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
  run(TOOL, ["tools/dev/bun.sh", "tools/release/release-check.mjs"]);
  run(TOOL, ["tools/dev/bun.sh", "tools/release/release-check-registries.mjs", ...productDryRunPlan.passthrough]);
  for (const product of productDryRunPlan.products) {
    await runBunProductDryRun(product, { allowDirty: productDryRunPlan.allowDirty });
  }
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

if (publishProductStep?.product === "oliphaunt-node-direct" && publishProductStep.step === "npm") {
  await publishNodeDirectNpmOptionalPackages(publishProductStep.headRef);
  process.exit(0);
}

if (publishProductStep?.step === "maven-central" && EXTENSION_PRODUCTS.has(publishProductStep.product)) {
  publishSelectedExtensionMaven([publishProductStep.product], publishProductStep.headRef);
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

const result = spawnSync("tools/release/release.py", argv, {
  cwd: ROOT,
  stdio: "inherit",
});

if (result.error !== undefined) {
  console.error(`${TOOL}: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 1);
