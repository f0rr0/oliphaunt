#!/usr/bin/env bun
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";

import { ROOT, run } from "./release-cli-utils.mjs";
import { resolvePinnedJsrInvocation } from "./jsr-cli.mjs";
import { currentProductVersionSync, registryPackageRows, releaseMetadata } from "./release-artifact-targets.mjs";
import {
  validateSelectionNeutralSwiftSourceCarrierFile,
  validateSwiftSourceReleaseContract,
} from "./swift-source-carrier-contract.mjs";
import {
  currentOliphauntWasixSdkVersion,
  prepareOliphauntWasixReleaseSource,
} from "./package_oliphaunt_wasix_sdk_crate.mjs";

const TOOL = "release-sdk-product-dry-run.mjs";

export const SUPPORTED_SDK_PRODUCT_DRY_RUNS = new Set([
  "oliphaunt-js",
  "oliphaunt-kotlin",
  "oliphaunt-react-native",
  "oliphaunt-rust",
  "oliphaunt-wasix-rust",
  "oliphaunt-swift",
]);

function fail(message, exitCode = 1) {
  console.error(`${TOOL}: ${message}`);
  process.exit(exitCode);
}

function usage() {
  console.log(`usage: tools/release/release-sdk-product-dry-run.mjs --product PRODUCT [--allow-dirty]

Runs Bun-owned low-risk SDK product publish dry-run checks. Release-wide checks
and registry dependency checks are owned by release-publish.mjs before this
helper is invoked from the public publish dry-run command surface.
`);
}

function isDirectory(file) {
  try {
    return statSync(file).isDirectory();
  } catch {
    return false;
  }
}

function isFile(file) {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

function requireFile(file, message) {
  if (!isFile(file)) {
    fail(message);
  }
}

function requireDirectory(file, message) {
  if (!isDirectory(file)) {
    fail(message);
  }
}

function sdkArtifactDir(product) {
  return path.join(ROOT, "target", "sdk-artifacts", product);
}

function rel(file) {
  return path.relative(ROOT, file).split(path.sep).join("/");
}

export function validateStagedSwiftSourceCarrier(carrier) {
  return validateSelectionNeutralSwiftSourceCarrierFile(carrier, rel(carrier));
}

function requireStagedSdkArtifact(product, description, suffixes) {
  const directory = sdkArtifactDir(product);
  requireDirectory(
    directory,
    `${product} requires staged ${description} artifact(s) under target/sdk-artifacts/${product}; download the CI workflow SDK package artifacts before release validation or publishing`,
  );
  const matches = readdirSync(directory)
    .map((name) => path.join(directory, name))
    .filter((file) => isFile(file) && path.basename(file) !== "artifacts.txt" && suffixes.some((suffix) => file.endsWith(suffix)))
    .sort();
  if (matches.length === 0) {
    fail(
      `${product} requires staged ${description} artifact(s) under target/sdk-artifacts/${product}; download the CI workflow SDK package artifacts before release validation or publishing`,
    );
  }
  return matches;
}

export function stagedJsrSourceDir(product) {
  const directory = path.join(sdkArtifactDir(product), "jsr-source");
  requireDirectory(
    directory,
    `${product} requires staged JSR source under target/sdk-artifacts/${product}/jsr-source; download the CI workflow SDK package artifacts before release validation or publishing`,
  );
  for (const name of ["jsr.json", "package.json", "src"]) {
    const candidate = path.join(directory, name);
    if (name === "src") {
      requireDirectory(candidate, `${product} staged JSR source is missing: ${name}`);
    } else {
      requireFile(candidate, `${product} staged JSR source is missing: ${name}`);
    }
  }
  return directory;
}

function stagedSwiftReleaseArtifacts() {
  const matches = requireStagedSdkArtifact("oliphaunt-swift", "Swift package", [".zip", ".release"]);
  const sourceArchives = matches.filter((file) => path.basename(file) === "Oliphaunt-source.zip");
  const manifests = matches.filter((file) => path.basename(file) === "Package.swift.release");
  const releaseTree = path.join(sdkArtifactDir("oliphaunt-swift"), "release-tree");
  if (sourceArchives.length !== 1 || manifests.length !== 1) {
    fail(
      "oliphaunt-swift release requires exactly one staged Oliphaunt-source.zip and one staged Package.swift.release under target/sdk-artifacts/oliphaunt-swift",
    );
  }
  requireFile(
    path.join(releaseTree, "generated", "swiftpm", "OliphauntICU", "OliphauntICU.swift"),
    "oliphaunt-swift release requires staged SwiftPM release-tree files, including generated/swiftpm/OliphauntICU/OliphauntICU.swift",
  );
  const carrier = path.join(
    releaseTree,
    "src/sdks/swift/Carriers/oliphaunt-react-native-ios-carriers.json",
  );
  requireFile(
    carrier,
    "oliphaunt-swift release requires the canonical iOS carrier manifest in its source-tag tree",
  );
  let carrierDocument;
  try {
    carrierDocument = validateStagedSwiftSourceCarrier(carrier);
  } catch (cause) {
    fail(cause instanceof Error ? cause.message : String(cause));
  }
  for (const name of [
    "extension-owner-catalog.json",
    "extension-resource-inventory.mjs",
    "render-extension-products.mjs",
    "swift-carrier-resolver.mjs",
    "swiftpm-extension-input.schema.json",
  ]) {
    requireFile(
      path.join(sdkArtifactDir("oliphaunt-swift"), "extension-generator", name),
      `oliphaunt-swift release requires frozen extension generator input ${name}`,
    );
  }
  const manifestText = readFileSync(manifests[0], "utf8");
  try {
    validateSwiftSourceReleaseContract({
      carrier: carrierDocument,
      expectedNativeVersion: currentProductVersionSync("liboliphaunt-native", TOOL),
      label: "staged oliphaunt-swift source release",
      manifestText,
    });
  } catch (cause) {
    fail(cause instanceof Error ? cause.message : String(cause));
  }
  for (const fragment of [
    "binaryTarget(",
    "liboliphaunt-native-v",
    "liboliphaunt-",
    "apple-spm-xcframework.zip",
    "checksum:",
    '.library(name: "COliphaunt"',
    '.library(name: "OliphauntExtensionSupport"',
    'path: "src/sdks/swift/Sources/OliphauntExtensionSupport"',
  ]) {
    if (!manifestText.includes(fragment)) {
      fail(`oliphaunt-swift staged Package.swift.release is missing ${JSON.stringify(fragment)}`);
    }
  }
  return { manifest: manifests[0], releaseTree };
}

export function prepareStagedSwiftReleaseManifest() {
  const { manifest, releaseTree: stagedReleaseTree } = stagedSwiftReleaseArtifacts();
  const outputDir = path.join(ROOT, "target", "oliphaunt-swift");
  const releaseTree = path.join(outputDir, "release-tree");
  rmSync(releaseTree, { force: true, recursive: true });
  mkdirSync(outputDir, { recursive: true });
  cpSync(stagedReleaseTree, releaseTree, { recursive: true });
  const outputManifest = path.join(outputDir, "Package.swift.release");
  cpSync(manifest, outputManifest);
  return outputManifest;
}

function walkFiles(root) {
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const child = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkFiles(child));
    } else if (entry.isFile()) {
      files.push(child);
    }
  }
  return files;
}

export function stagedKotlinMavenRepo() {
  const root = path.join(sdkArtifactDir("oliphaunt-kotlin"), "maven");
  requireDirectory(
    root,
    "oliphaunt-kotlin requires staged Maven repository artifacts under target/sdk-artifacts/oliphaunt-kotlin/maven; download the CI workflow Kotlin SDK package artifacts before release validation or publishing",
  );
  const version = currentProductVersionSync("oliphaunt-kotlin", TOOL);
  const required = [
    `dev/oliphaunt/oliphaunt-android/${version}/oliphaunt-android-${version}.aar`,
    `dev/oliphaunt/oliphaunt-android/${version}/oliphaunt-android-${version}.pom`,
    `dev/oliphaunt/oliphaunt-android/${version}/oliphaunt-android-${version}.module`,
    `dev/oliphaunt/oliphaunt-android/${version}/oliphaunt-android-${version}-sources.jar`,
    `dev/oliphaunt/oliphaunt-android/${version}/oliphaunt-android-${version}-javadoc.jar`,
    `dev/oliphaunt/oliphaunt-android-gradle-plugin/${version}/oliphaunt-android-gradle-plugin-${version}.jar`,
    `dev/oliphaunt/oliphaunt-android-gradle-plugin/${version}/oliphaunt-android-gradle-plugin-${version}.pom`,
    `dev/oliphaunt/oliphaunt-android-gradle-plugin/${version}/oliphaunt-android-gradle-plugin-${version}.module`,
    `dev/oliphaunt/oliphaunt-android-gradle-plugin/${version}/oliphaunt-android-gradle-plugin-${version}-sources.jar`,
    `dev/oliphaunt/oliphaunt-android-gradle-plugin/${version}/oliphaunt-android-gradle-plugin-${version}-javadoc.jar`,
    `dev/oliphaunt/android/dev.oliphaunt.android.gradle.plugin/${version}/dev.oliphaunt.android.gradle.plugin-${version}.pom`,
  ];
  const missing = required.filter((file) => !isFile(path.join(root, file)));
  if (missing.length > 0) {
    fail(`oliphaunt-kotlin staged Maven repository is missing: ${missing.map((file) => `target/sdk-artifacts/oliphaunt-kotlin/maven/${file}`).join(", ")}`);
  }
  for (const file of walkFiles(root)) {
    const relative = path.relative(root, file).split(path.sep);
    if (relative[0] !== "dev" || relative[1] !== "oliphaunt") {
      fail(`oliphaunt-kotlin staged Maven repository contains unexpected path ${rel(file)}`);
    }
    const suffix = path.extname(file);
    if (suffix === ".lastUpdated" || suffix === ".lock") {
      fail(`oliphaunt-kotlin staged Maven repository contains local resolver state ${rel(file)}`);
    }
  }
  console.log(`validated staged Kotlin Maven repository: ${rel(root)}`);
  return root;
}

function safeNpmPackageFilenamePrefix(packageName) {
  return packageName.replace(/^@/u, "").replaceAll("/", "-");
}

function jsonContainsWorkspaceProtocol(value) {
  if (typeof value === "string") {
    return value.startsWith("workspace:");
  }
  if (Array.isArray(value)) {
    return value.some((item) => jsonContainsWorkspaceProtocol(item));
  }
  if (value !== null && typeof value === "object") {
    return Object.values(value).some((item) => jsonContainsWorkspaceProtocol(item));
  }
  return false;
}

function tarString(bytes, offset, length) {
  const end = bytes.indexOf(0, offset);
  const effectiveEnd = end >= offset && end < offset + length ? end : offset + length;
  return bytes.toString("utf8", offset, effectiveEnd);
}

function tarOctal(bytes, offset, length) {
  const raw = tarString(bytes, offset, length).trim().replace(/\0.*$/u, "");
  if (raw.length === 0) {
    return 0;
  }
  const value = Number.parseInt(raw, 8);
  if (!Number.isFinite(value)) {
    throw new Error(`invalid tar octal field ${JSON.stringify(raw)}`);
  }
  return value;
}

function tarEntryName(bytes, offset) {
  const name = tarString(bytes, offset, 100);
  const prefix = tarString(bytes, offset + 345, 155);
  return prefix ? `${prefix}/${name}` : name;
}

function readTarGzEntries(tarball) {
  const bytes = gunzipSync(readFileSync(tarball));
  const entries = new Map();
  for (let offset = 0; offset + 512 <= bytes.length;) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      break;
    }
    const name = tarEntryName(bytes, offset);
    const size = tarOctal(bytes, offset + 124, 12);
    const bodyStart = offset + 512;
    const bodyEnd = bodyStart + size;
    if (bodyEnd > bytes.length) {
      throw new Error(`${rel(tarball)} has a truncated tar entry ${name}`);
    }
    entries.set(name, bytes.subarray(bodyStart, bodyEnd));
    offset = bodyStart + Math.ceil(size / 512) * 512;
  }
  return entries;
}

function validateStagedNpmPackageTarball(product, tarball) {
  const packageRoot = path.join(ROOT, releaseMetadata(product, TOOL).packagePath);
  const packageJsonPath = path.join(packageRoot, "package.json");
  requireFile(packageJsonPath, `${product} has no package.json at ${rel(packageJsonPath)}`);
  const sourcePackage = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  const expectedName = sourcePackage.name;
  const expectedVersion = currentProductVersionSync(product, TOOL);
  if (typeof expectedName !== "string" || expectedName.length === 0) {
    fail(`${rel(packageJsonPath)} must declare a package name`);
  }
  const expectedFilename = `${safeNpmPackageFilenamePrefix(expectedName)}-${expectedVersion}.tgz`;
  if (path.basename(tarball) !== expectedFilename) {
    fail(`${product} staged npm tarball must be named ${expectedFilename}, got ${path.basename(tarball)}`);
  }
  try {
    const entries = readTarGzEntries(tarball);
    if (!entries.has("package/package.json")) {
      fail(`${rel(tarball)} is missing package/package.json`);
    }
    const packedPackage = JSON.parse(entries.get("package/package.json").toString("utf8"));
    if (packedPackage.name !== expectedName) {
      fail(`${rel(tarball)} package name must be ${expectedName}, got ${JSON.stringify(packedPackage.name)}`);
    }
    if (packedPackage.version !== expectedVersion) {
      fail(`${rel(tarball)} package version must be ${expectedVersion}, got ${JSON.stringify(packedPackage.version)}`);
    }
    if (jsonContainsWorkspaceProtocol(packedPackage)) {
      fail(`${rel(tarball)} must not contain workspace: dependency specifiers`);
    }
    if (![...entries.keys()].some((name) => name.startsWith("package/lib/"))) {
      fail(`${rel(tarball)} must contain built package/lib output`);
    }
  } catch (error) {
    fail(`${rel(tarball)} is not a valid staged npm package tarball: ${error.message}`);
  }
}

export function stagedSdkNpmPackageTarball(product) {
  const matches = requireStagedSdkArtifact(product, "npm package", [".tgz"]);
  if (matches.length !== 1) {
    fail(`${product} release requires exactly one staged npm package tarball, found ${matches.length}: ${matches.map(rel).join(", ")}`);
  }
  validateStagedNpmPackageTarball(product, matches[0]);
  return matches[0];
}

function stagedCargoCrates(product) {
  const matches = requireStagedSdkArtifact(product, "Cargo package", [".crate"]);
  const names = matches.map((file) => path.basename(file));
  if (names.length !== new Set(names).size) {
    fail(`${product} staged Cargo artifacts contain duplicate crate filenames: ${names.join(", ")}`);
  }
  return matches;
}

function cratesioProductCrates(product) {
  const crates = registryPackageRows({ product, packageKind: "crates" }, TOOL)
    .map((row) => row.packageName)
    .sort();
  if (crates.length === 0) {
    fail(`${product} declares no crates.io packages`);
  }
  return crates;
}

export function verifyStagedCargoProductCrates(product) {
  const version = currentProductVersionSync(product, TOOL);
  const stagedNames = stagedCargoCrates(product).map((file) => path.basename(file)).sort();
  const expectedNames = cratesioProductCrates(product)
    .map((crate) => `${crate}-${version}.crate`)
    .sort();
  for (const expectedName of expectedNames) {
    if (!stagedNames.includes(expectedName)) {
      fail(
        `${product} staged Cargo artifacts must contain exactly one ${expectedName}; staged=${JSON.stringify(stagedNames)}`,
      );
    }
    console.log(`validated staged Cargo crate identity: ${product} -> target/sdk-artifacts/${product}/${expectedName}`);
  }
  if (JSON.stringify(stagedNames) !== JSON.stringify(expectedNames)) {
    fail(`${product} staged Cargo artifacts mismatch: expected=${JSON.stringify(expectedNames)}, staged=${JSON.stringify(stagedNames)}`);
  }
}

function runRustSdkDryRun() {
  verifyStagedCargoProductCrates("oliphaunt-rust");
  run(TOOL, [process.execPath, "tools/release/prepare-rust-release-source.mjs"]);
  console.log("validated staged Rust SDK crates; skipping source cargo publish dry-run.");
}

async function runWasixRustSdkDryRun() {
  verifyStagedCargoProductCrates("oliphaunt-wasix-rust");
  const version = await currentOliphauntWasixSdkVersion();
  const manifest = await prepareOliphauntWasixReleaseSource(version);
  console.log(`validated generated WASIX Rust binding release source: ${rel(manifest)}`);
  console.log(
    "validated staged WASIX Rust binding package shape and generated publish manifest; source publish runs after WASIX artifact crates are published.",
  );
}

export async function runSdkProductDryRun(product, { allowDirty = false } = {}) {
  if (!SUPPORTED_SDK_PRODUCT_DRY_RUNS.has(product)) {
    fail(`no Bun publish dry-run handler for ${product}`, 2);
  }
  run(TOOL, [process.execPath, "tools/release/check-staged-artifacts.mjs", "--require-sdk-product", product]);
  if (product === "oliphaunt-swift") {
    prepareStagedSwiftReleaseManifest();
    return;
  }
  if (product === "oliphaunt-kotlin") {
    stagedKotlinMavenRepo();
    return;
  }
  if (product === "oliphaunt-rust") {
    runRustSdkDryRun();
    return;
  }
  if (product === "oliphaunt-wasix-rust") {
    await runWasixRustSdkDryRun();
    return;
  }
  if (product === "oliphaunt-react-native") {
    stagedSdkNpmPackageTarball(product);
    return;
  }
  if (product === "oliphaunt-js") {
    stagedSdkNpmPackageTarball(product);
    const command = resolvePinnedJsrInvocation(["publish", "--dry-run"]);
    if (allowDirty) {
      command.push("--allow-dirty");
    }
    run(TOOL, command, { cwd: stagedJsrSourceDir(product) });
  }
}

function parseArgs(argv) {
  const args = {
    allowDirty: false,
    product: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--product") {
      if (index + 1 >= argv.length) {
        fail("--product requires a value", 2);
      }
      args.product = argv[index + 1];
      index += 1;
    } else if (arg.startsWith("--product=")) {
      args.product = arg.slice("--product=".length);
    } else if (arg === "--allow-dirty") {
      args.allowDirty = true;
    } else if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    } else {
      fail(`unknown argument ${arg}`, 2);
    }
  }
  if (!args.product) {
    fail("--product is required", 2);
  }
  return args;
}

if (import.meta.main) {
  const args = parseArgs(Bun.argv.slice(2));
  await runSdkProductDryRun(args.product, { allowDirty: args.allowDirty });
}
