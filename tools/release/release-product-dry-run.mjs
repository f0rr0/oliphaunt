#!/usr/bin/env bun
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";

import { captureCommandBytes, captureCommandOutput } from "../dev/capture-command-output.mjs";
import { ROOT, run } from "./release-cli-utils.mjs";
import {
  SUPPORTED_SDK_PRODUCT_DRY_RUNS,
  runSdkProductDryRun,
} from "./release-sdk-product-dry-run.mjs";
import {
  artifactTargets,
  compareText,
  currentProductVersionSync,
  exactExtensionProducts,
  extensionRegistryPackageTargetSets,
  registryPackageRows,
} from "./release-artifact-targets.mjs";
import {
  packageNativeExtensionCargoCrates,
  stageExtensionNpmPackages,
} from "./extension-registry-carrier-materializer.mjs";
import {
  cargoPackageIdentityFromCrate,
  npmPackageIdentity,
} from "./local-registry-publish.mjs";
import { packageExtensionCargoFacades } from "./package-extension-cargo-facades.mjs";
import {
  WASIX_CARGO_ARTIFACT_SCHEMA,
  publicCargoPackageNames as wasixPublicCargoPackageNames,
} from "./wasix-cargo-artifact-contract.mjs";
import {
  requiredRuntimeMemberPaths,
  requiredToolsMemberPaths,
  requiredToolsPackageTools,
} from "./optimize_native_runtime_payload.mjs";
import { validateNpmTrustedPublishingManifest } from "./npm-trusted-publishing.mjs";
import {
  WINDOWS_VC_RUNTIME_RECEIPT,
  parseWindowsVcRuntimeReceipt,
  windowsVcRuntimeProfileNames,
} from "./windows-vc-runtime-closure.mjs";
import {
  assertReleaseNoticesInArchive,
  assertReleaseNoticesInDirectory,
  releaseNoticeRows,
  stageReleaseNotices,
} from "./release-notices.mjs";
import {
  assertBrokerDependencyLicensesInArchive,
  assertBrokerDependencyLicensesInDirectory,
  brokerDependencyLicenseMembers,
  normalizeBrokerDependencyLicenseModes,
} from "./broker-dependency-license-contract.mjs";

const TOOL = "release-product-dry-run.mjs";
const LIBOLIPHAUNT_NATIVE_PRODUCT = "liboliphaunt-native";
const LIBOLIPHAUNT_NATIVE_KIND = "native-runtime";
const LIBOLIPHAUNT_NATIVE_TOOLS_PRODUCT = "oliphaunt-tools";
const LIBOLIPHAUNT_NATIVE_TOOLS_KIND = "native-tools";
const LIBOLIPHAUNT_NATIVE_PACKAGE_ROOT = path.join(ROOT, "src/runtimes/liboliphaunt/native/packages");
const LIBOLIPHAUNT_NATIVE_TOOLS_PACKAGE_ROOT = path.join(ROOT, "src/runtimes/liboliphaunt/native/tools-packages");
const LIBOLIPHAUNT_ICU_PACKAGE_NAME = "@oliphaunt/icu";
const LIBOLIPHAUNT_ICU_PACKAGE_ROOT = path.join(ROOT, "src/runtimes/liboliphaunt/native/icu-npm");
const BROKER_PRODUCT = "oliphaunt-broker";
const BROKER_KIND = "broker-helper";
const BROKER_PACKAGE_ROOT = path.join(ROOT, "src/runtimes/broker/packages");
const WASIX_PRODUCT = "liboliphaunt-wasix";
const NODE_DIRECT_PRODUCT = "oliphaunt-node-direct";
const NODE_DIRECT_KIND = "node-direct-addon";
const NODE_DIRECT_PACKAGE_ROOT = path.join(ROOT, "src/runtimes/node-direct/packages");

export const SUPPORTED_BUN_PRODUCT_DRY_RUNS = new Set([
  ...SUPPORTED_SDK_PRODUCT_DRY_RUNS,
  ...exactExtensionProducts(TOOL),
  LIBOLIPHAUNT_NATIVE_PRODUCT,
  BROKER_PRODUCT,
  WASIX_PRODUCT,
  NODE_DIRECT_PRODUCT,
]);

function fail(message, exitCode = 1) {
  console.error(`${TOOL}: ${message}`);
  process.exit(exitCode);
}

function rel(file) {
  return path.relative(ROOT, file).split(path.sep).join("/");
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

function sha256File(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function commandOutput(command, args, { cwd = ROOT } = {}) {
  const result = captureCommandOutput(command, args, {
    cwd,
    label: `${command} ${args.join(" ")}`,
    maxOutputBytes: 100 * 1024 * 1024,
  });
  if (result.error !== undefined) {
    fail(`${command} failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const stderr = Buffer.isBuffer(result.stderr) ? result.stderr.toString("utf8") : result.stderr;
    fail(`${command} ${args.join(" ")} failed${stderr ? `: ${stderr.trim()}` : ""}`);
  }
  return result.stdout;
}

function stagedRuntimeInputDirs(envName) {
  const raw = process.env[envName] ?? process.env.OLIPHAUNT_RELEASE_ASSET_INPUT_DIRS ?? "";
  return raw
    .split(path.delimiter)
    .filter(Boolean)
    .map((item) => {
      const expanded = item === "~" || item.startsWith("~/")
        ? path.join(process.env.HOME ?? "", item.slice(1))
        : item;
      return path.isAbsolute(expanded) ? expanded : path.join(ROOT, expanded);
    });
}

function globRegex(pattern) {
  return new RegExp(`^${pattern.split("*").map(escapeRegExp).join(".*")}$`, "u");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function copyStagedRuntimeAssets({
  product,
  destination,
  envName,
  patterns,
}) {
  const sourceDirs = stagedRuntimeInputDirs(envName);
  if (sourceDirs.length === 0) {
    fail(
      `${product} requires staged runtime artifacts; set ${envName} or OLIPHAUNT_RELEASE_ASSET_INPUT_DIRS to the downloaded CI artifact directory`,
    );
  }
  mkdirSync(destination, { recursive: true });
  const regexes = patterns.map(globRegex);
  let copied = 0;
  for (const sourceDir of sourceDirs) {
    if (!isDirectory(sourceDir)) {
      fail(`${product} release asset input directory does not exist: ${sourceDir}`);
    }
    for (const name of readdirSync(sourceDir).sort(compareText)) {
      if (!regexes.some((regex) => regex.test(name))) {
        continue;
      }
      const source = path.join(sourceDir, name);
      if (!isFile(source)) {
        continue;
      }
      const output = path.join(destination, name);
      if (isFile(output)) {
        if (sha256File(output) !== sha256File(source)) {
          fail(`${product} release asset input collision for ${name}: ${rel(output)} and ${rel(source)} have different bytes`);
        }
        continue;
      }
      copyFileSync(source, output);
      copied += 1;
    }
  }
  if (copied === 0) {
    fail(`${product} found no staged runtime artifacts matching ${JSON.stringify(patterns)} under ${JSON.stringify(sourceDirs)}`);
  }
}

function hasNodeDirectReleaseArchive(assetDir) {
  if (!isDirectory(assetDir)) {
    return false;
  }
  return readdirSync(assetDir).some((name) =>
    name.startsWith("oliphaunt-node-direct-") && (name.endsWith(".tar.gz") || name.endsWith(".zip")),
  );
}

function hasBrokerReleaseArchive(assetDir) {
  if (!isDirectory(assetDir)) {
    return false;
  }
  return readdirSync(assetDir).some((name) =>
    name.startsWith("oliphaunt-broker-") && (name.endsWith(".tar.gz") || name.endsWith(".zip")),
  );
}

function hasWasixReleaseArchive(assetDir) {
  if (!isDirectory(assetDir)) {
    return false;
  }
  return readdirSync(assetDir).some((name) =>
    name.startsWith("liboliphaunt-wasix-") && name.endsWith(".tar.zst"),
  );
}

function hasLiboliphauntReleaseArchive(assetDir) {
  if (!isDirectory(assetDir)) {
    return false;
  }
  return readdirSync(assetDir).some((name) =>
    (
      name.startsWith("liboliphaunt-") ||
      name.startsWith("oliphaunt-tools-")
    ) && (name.endsWith(".tar.gz") || name.endsWith(".zip") || name.endsWith(".tsv")),
  );
}

export function ensureLiboliphauntReleaseAssets() {
  const assetDir = path.join(ROOT, "target/liboliphaunt/release-assets");
  if (!hasLiboliphauntReleaseArchive(assetDir)) {
    copyStagedRuntimeAssets({
      product: LIBOLIPHAUNT_NATIVE_PRODUCT,
      destination: assetDir,
      envName: "OLIPHAUNT_LIBOLIPHAUNT_RELEASE_ASSET_INPUT_DIRS",
      patterns: [
        "liboliphaunt-*.tar.gz",
        "liboliphaunt-*.zip",
        "liboliphaunt-*.tsv",
        "liboliphaunt-*.sha256",
        "oliphaunt-tools-*.tar.gz",
        "oliphaunt-tools-*.zip",
      ],
    });
  }
  const version = currentProductVersionSync(LIBOLIPHAUNT_NATIVE_PRODUCT, TOOL);
  run(TOOL, [
    process.execPath,
    "tools/release/write_checksum_manifest.mjs",
    "--asset-dir",
    rel(assetDir),
    "--output",
    `liboliphaunt-${version}-release-assets.sha256`,
    "--pattern",
    "liboliphaunt-*.tar.gz",
    "--pattern",
    "liboliphaunt-*.zip",
    "--pattern",
    "liboliphaunt-*.tsv",
    "--pattern",
    "oliphaunt-tools-*.tar.gz",
    "--pattern",
    "oliphaunt-tools-*.zip",
  ]);
  run(TOOL, [
    process.execPath,
    "tools/release/check-liboliphaunt-release-assets.mjs",
    "--asset-dir",
    rel(assetDir),
  ]);
}

export function ensureBrokerReleaseAssets() {
  const assetDir = path.join(ROOT, "target/oliphaunt-broker/release-assets");
  if (!hasBrokerReleaseArchive(assetDir)) {
    copyStagedRuntimeAssets({
      product: BROKER_PRODUCT,
      destination: assetDir,
      envName: "OLIPHAUNT_BROKER_RELEASE_ASSET_INPUT_DIRS",
      patterns: ["oliphaunt-broker-*.tar.gz", "oliphaunt-broker-*.zip"],
    });
  }
  const version = currentProductVersionSync(BROKER_PRODUCT, TOOL);
  run(TOOL, [
    process.execPath,
    "tools/release/write_checksum_manifest.mjs",
    "--asset-dir",
    rel(assetDir),
    "--output",
    `oliphaunt-broker-${version}-release-assets.sha256`,
    "--pattern",
    "oliphaunt-broker-*.tar.gz",
    "--pattern",
    "oliphaunt-broker-*.zip",
  ]);
  run(TOOL, [
    process.execPath,
    "tools/release/check-broker-release-assets.mjs",
    "--asset-dir",
    rel(assetDir),
  ]);
}

export function ensureWasixReleaseAssets() {
  const assetDir = path.join(ROOT, "target/oliphaunt-wasix/release-assets");
  if (!hasWasixReleaseArchive(assetDir)) {
    copyStagedRuntimeAssets({
      product: WASIX_PRODUCT,
      destination: assetDir,
      envName: "OLIPHAUNT_WASIX_RELEASE_ASSET_INPUT_DIRS",
      patterns: ["liboliphaunt-wasix-*.tar.zst"],
    });
  }
  const version = currentProductVersionSync(WASIX_PRODUCT, TOOL);
  run(TOOL, [
    process.execPath,
    "tools/release/write_checksum_manifest.mjs",
    "--asset-dir",
    rel(assetDir),
    "--output",
    `liboliphaunt-wasix-${version}-release-assets.sha256`,
    "--pattern",
    "liboliphaunt-wasix-*.tar.zst",
  ]);
  run(TOOL, [
    process.execPath,
    "tools/release/check-liboliphaunt-wasix-release-assets.mjs",
    "--asset-dir",
    rel(assetDir),
    "--version",
    version,
  ]);
}

export function ensureNodeDirectReleaseAssets() {
  const assetDir = path.join(ROOT, "target/oliphaunt-node-direct/release-assets");
  if (!hasNodeDirectReleaseArchive(assetDir)) {
    copyStagedRuntimeAssets({
      product: NODE_DIRECT_PRODUCT,
      destination: assetDir,
      envName: "OLIPHAUNT_NODE_ADDON_ASSET_INPUT_DIRS",
      patterns: ["oliphaunt-node-direct-*.tar.gz", "oliphaunt-node-direct-*.zip"],
    });
  }
  const version = currentProductVersionSync(NODE_DIRECT_PRODUCT, TOOL);
  run(TOOL, [
    process.execPath,
    "tools/release/write_checksum_manifest.mjs",
    "--asset-dir",
    rel(assetDir),
    "--output",
    `oliphaunt-node-direct-${version}-release-assets.sha256`,
    "--pattern",
    "oliphaunt-node-direct-*.tar.gz",
    "--pattern",
    "oliphaunt-node-direct-*.zip",
  ]);
  run(TOOL, [
    process.execPath,
    "tools/release/check-node-direct-release-assets.mjs",
    "--asset-dir",
    rel(assetDir),
  ]);
}

function npmPackageDirsUnder(packageRoot) {
  const packages = new Map();
  if (!isDirectory(packageRoot)) {
    fail(`${rel(packageRoot)} does not contain npm package descriptors`);
  }
  for (const packageDirName of readdirSync(packageRoot).sort(compareText)) {
    const packageDir = path.join(packageRoot, packageDirName);
    const packageJsonPath = path.join(packageDir, "package.json");
    if (!isFile(packageJsonPath)) {
      continue;
    }
    let packageJson;
    try {
      packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    } catch (error) {
      fail(`${rel(packageJsonPath)} is not valid JSON: ${error.message}`);
    }
    const packageName = packageJson.name;
    if (typeof packageName !== "string" || packageName.length === 0) {
      fail(`${rel(packageJsonPath)} must declare name`);
    }
    if (packages.has(packageName)) {
      fail(`duplicate npm package name ${packageName} in ${rel(packages.get(packageName))} and ${rel(packageDir)}`);
    }
    packages.set(packageName, packageDir);
  }
  if (packages.size === 0) {
    fail(`${rel(packageRoot)} does not contain npm package descriptors`);
  }
  return packages;
}

function artifactNpmPackageTargets({
  product,
  kind,
  surface,
  packageRoot,
  version,
}) {
  const packageDirs = npmPackageDirsUnder(packageRoot);
  const packages = [];
  for (const target of artifactTargets(product, kind, TOOL).filter((candidate) => candidate.surfaces.includes(surface))) {
    const packageName = target.npm_package;
    if (typeof packageName !== "string" || packageName.length === 0) {
      fail(`${target.id} must declare npm_package for npm artifact package publication`);
    }
    const packageDir = packageDirs.get(packageName);
    if (packageDir === undefined) {
      fail(`${target.id} declares unknown npm package ${packageName}`);
    }
    const packageJson = JSON.parse(readFileSync(path.join(packageDir, "package.json"), "utf8"));
    if (packageJson.name !== packageName) {
      fail(`${rel(packageDir)}/package.json name must be ${packageName}`);
    }
    if (packageJson.version !== version) {
      fail(`${packageName} package version must match ${product} ${version}`);
    }
    packages.push([packageName, packageDir, target]);
  }
  const expected = packages.map(([packageName]) => packageName).sort(compareText);
  const actual = [...packageDirs.keys()].sort(compareText);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`${rel(packageRoot)} package descriptors must match published ${product} npm artifact targets for ${surface}`);
  }
  return packages.sort((left, right) => compareText(left[0], right[0]));
}

function nodeDirectOptionalPackageTargets(version) {
  return artifactNpmPackageTargets({
    product: NODE_DIRECT_PRODUCT,
    kind: NODE_DIRECT_KIND,
    surface: "npm-optional",
    packageRoot: NODE_DIRECT_PACKAGE_ROOT,
    version,
  });
}

function brokerNpmPackageTargets(version) {
  return artifactNpmPackageTargets({
    product: BROKER_PRODUCT,
    kind: BROKER_KIND,
    surface: "typescript-broker",
    packageRoot: BROKER_PACKAGE_ROOT,
    version,
  });
}

function safeNpmPackageFilenamePrefix(packageName) {
  return packageName.replace(/^@/u, "").replace("/", "-");
}

function nodeDirectNpmPackageDir() {
  return path.join(ROOT, "target/oliphaunt-node-direct/npm-packages");
}

function expectedNodeDirectNpmTarball(packageName, version) {
  return path.join(nodeDirectNpmPackageDir(), `${safeNpmPackageFilenamePrefix(packageName)}-${version}.tgz`);
}

function parseTarString(buffer, start, length) {
  const end = buffer.indexOf(0, start);
  return buffer
    .subarray(start, end >= start && end < start + length ? end : start + length)
    .toString("utf8")
    .trim();
}

function parseTarOctal(buffer, start, length) {
  const text = parseTarString(buffer, start, length).replaceAll("\0", "").trim();
  return text ? Number.parseInt(text, 8) : 0;
}

function readTarGzMember(file, expectedName) {
  const buffer = gunzipSync(readFileSync(file));
  for (let offset = 0; offset + 512 <= buffer.length;) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      break;
    }
    const rawName = parseTarString(header, 0, 100);
    const prefix = parseTarString(header, 345, 155);
    const name = prefix ? `${prefix}/${rawName}` : rawName;
    const size = parseTarOctal(header, 124, 12);
    const dataOffset = offset + 512;
    if (name === expectedName) {
      return buffer.subarray(dataOffset, dataOffset + size);
    }
    offset = dataOffset + Math.ceil(size / 512) * 512;
  }
  return null;
}

function readTarGzEntries(file) {
  const buffer = gunzipSync(readFileSync(file));
  const entries = new Map();
  for (let offset = 0; offset + 512 <= buffer.length;) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      break;
    }
    const rawName = parseTarString(header, 0, 100);
    const prefix = parseTarString(header, 345, 155);
    const name = prefix ? `${prefix}/${rawName}` : rawName;
    const mode = parseTarOctal(header, 100, 8);
    const size = parseTarOctal(header, 124, 12);
    const type = header.subarray(156, 157).toString("utf8");
    entries.set(name, { mode, size, isFile: type === "" || type === "0" });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

function validateNoConsumerInstallScripts(packageJson, context) {
  const scripts = packageJson.scripts;
  if (scripts === undefined) {
    return;
  }
  if (scripts === null || typeof scripts !== "object" || Array.isArray(scripts)) {
    fail(`${context} scripts must be an object when present`);
  }
  for (const scriptName of ["preinstall", "install", "postinstall", "prepare"]) {
    if (Object.hasOwn(scripts, scriptName)) {
      fail(`${context} must not declare consumer install lifecycle script ${scriptName}`);
    }
  }
}

function npmPackageSourceStageDir(packageName) {
  return path.join(ROOT, "target/release/npm-package-sources", safeNpmPackageFilenamePrefix(packageName));
}

function stageNpmPackageDescriptor(
  packageName,
  sourceDir,
  version,
  {
    extraDescriptors = [],
    target = null,
  } = {},
) {
  const stageDir = npmPackageSourceStageDir(packageName);
  rmSync(stageDir, { recursive: true, force: true });
  mkdirSync(stageDir, { recursive: true });
  for (const descriptor of ["package.json", "README.md", ...extraDescriptors]) {
    const source = path.join(sourceDir, descriptor);
    if (!isFile(source)) {
      fail(`${rel(sourceDir)} is missing ${descriptor}`);
    }
    copyFileSync(source, path.join(stageDir, descriptor));
  }
  const packageJsonPath = path.join(stageDir, "package.json");
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  if (packageJson.name !== packageName) {
    fail(`${rel(packageJsonPath)} name must be ${packageName}`);
  }
  if (packageJson.version !== version) {
    fail(`${packageName} package version must match ${version}`);
  }
  if (target !== null && packageJson.oliphaunt?.target !== target) {
    fail(`${packageName} package oliphaunt.target must be ${target}`);
  }
  validateNoConsumerInstallScripts(packageJson, `${packageName} npm package`);
  return stageDir;
}

function readReleaseArchiveMember(archive, memberName) {
  if (archive.endsWith(".tar.gz")) {
    for (const candidate of [memberName, `./${memberName}`]) {
      const data = readTarGzMember(archive, candidate);
      if (data !== null) {
        return data;
      }
    }
    fail(`${rel(archive)} is missing ${memberName}`);
  }
  if (path.extname(archive) === ".zip") {
    for (const candidate of [memberName, `./${memberName}`]) {
      const result = captureCommandBytes("unzip", ["-p", archive, candidate], {
        cwd: ROOT,
        label: `read ${candidate} from ${rel(archive)}`,
        maxOutputBytes: 100 * 1024 * 1024,
      });
      if (result.error !== undefined) {
        fail(`unzip failed to start: ${result.error.message}`);
      }
      if (result.status === 0) {
        return result.stdout;
      }
    }
    fail(`${rel(archive)} is missing ${memberName}`);
  }
  fail(`${rel(archive)} has unsupported release archive extension`);
}

function extractReleaseArchiveFile(archive, memberName, destination, { mode = null } = {}) {
  const data = readReleaseArchiveMember(archive, memberName);
  mkdirSync(path.dirname(destination), { recursive: true });
  writeFileSync(destination, data);
  if (mode !== null) {
    chmodSync(destination, mode);
  }
}

function archiveTempDir() {
  const root = path.join(ROOT, "target/release/archive-extract");
  mkdirSync(root, { recursive: true });
  return mkdtempSync(path.join(root, "extract-"));
}

function runArchiveCommand(args, label) {
  const result = captureCommandOutput(args[0], args.slice(1), {
    cwd: ROOT,
    label,
    maxOutputBytes: 100 * 1024 * 1024,
  });
  if (result.error !== undefined) {
    fail(`${label} failed to start: ${result.error.message}`);
  }
  return result;
}

function copyExtractedTree(source, destination) {
  if (!isDirectory(source)) {
    fail(`release archive is missing extracted tree ${source}`);
  }
  rmSync(destination, { recursive: true, force: true });
  cpSync(source, destination, { recursive: true });
}

export function extractReleaseArchiveTree(archive, sourcePrefix, destination) {
  const temp = archiveTempDir();
  const prefix = sourcePrefix.replace(/\/+$/u, "");
  try {
    if (archive.endsWith(".zip")) {
      // Info-ZIP wildcard recursion differs between Unix and Windows builds.
      // Extract into isolated scratch and copy only the requested tree into
      // the package stage below.
      const result = runArchiveCommand(
        ["unzip", "-q", archive, "-d", temp],
        `extract ${prefix} from ${rel(archive)}`,
      );
      const extracted = path.join(temp, ...prefix.split("/"));
      if (result.status === 0 && isDirectory(extracted)) {
        copyExtractedTree(extracted, destination);
        return;
      }
    } else {
      for (const candidate of [prefix, `./${prefix}`]) {
        const result = runArchiveCommand(
          ["tar", "-xf", archive, "-C", temp, candidate],
          `extract ${candidate} from ${rel(archive)}`,
        );
        const extracted = path.join(temp, ...candidate.replace(/^\.\//u, "").split("/"));
        if (result.status === 0 && isDirectory(extracted)) {
          copyExtractedTree(extracted, destination);
          return;
        }
      }
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
  fail(`${rel(archive)} is missing ${prefix}`);
}

function runNativePayloadOptimizer(stage, target, toolSet) {
  run(TOOL, [
    process.execPath,
    "tools/release/optimize_native_runtime_payload.mjs",
    rel(stage),
    "--target",
    target,
    "--tool-set",
    toolSet,
  ]);
}

function ensureNativeToolsAbsentFromRuntime(stage, target) {
  const runtimeDir = path.join(stage, "runtime");
  const leaked = [];
  for (const tool of requiredToolsPackageTools(target, runtimeDir)) {
    if (existsSync(path.join(runtimeDir, "bin", tool))) {
      leaked.push(`runtime/bin/${tool}`);
    }
  }
  if (leaked.length > 0) {
    fail(`${rel(stage)} root runtime package must not contain split native tools: ${leaked.join(", ")}`);
  }
}

function pnpmPackForNpmPublish(packageDir) {
  const packageJson = JSON.parse(readFileSync(path.join(packageDir, "package.json"), "utf8"));
  const packageName = packageJson.name;
  if (typeof packageName !== "string" || packageName.length === 0) {
    fail(`${rel(packageDir)}/package.json must declare a package name`);
  }
  try {
    validateNpmTrustedPublishingManifest(packageJson, `${rel(packageDir)}/package.json`);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  const packDir = path.join(ROOT, "target/release/npm-packages", safeNpmPackageFilenamePrefix(packageName));
  rmSync(packDir, { recursive: true, force: true });
  mkdirSync(packDir, { recursive: true });
  const rendered = commandOutput("pnpm", ["pack", "--pack-destination", packDir, "--json"], { cwd: packageDir });
  let manifest;
  try {
    manifest = JSON.parse(rendered);
  } catch (error) {
    fail(`pnpm pack for ${packageName} did not emit JSON: ${error.message}`);
  }
  const filename = Array.isArray(manifest) ? manifest[0]?.filename : manifest?.filename;
  if (typeof filename !== "string" || !filename.endsWith(".tgz")) {
    fail(`pnpm pack for ${packageName} did not report a .tgz filename`);
  }
  const tarball = path.isAbsolute(filename) ? filename : path.join(packDir, filename);
  if (!isFile(tarball)) {
    fail(`pnpm pack for ${packageName} did not create ${rel(tarball)}`);
  }
  try {
    const packed = readTarGzMember(tarball, "package/package.json");
    if (packed === null) {
      fail(`${rel(tarball)} is missing package/package.json`);
    }
    validateNpmTrustedPublishingManifest(
      JSON.parse(packed.toString("utf8")),
      `${rel(tarball)} package/package.json`,
    );
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  return tarball;
}

function validatePackedNpmPackage({
  packageName,
  version,
  tarball,
  requiredMembers,
  executableMembers = [],
}) {
  let entries;
  try {
    entries = readTarGzEntries(tarball);
  } catch (error) {
    fail(`${rel(tarball)} is not a valid npm tarball: ${error.message}`);
  }
  if (!entries.has("package/package.json")) {
    fail(`${rel(tarball)} is missing package/package.json`);
  }
  let packageJson;
  try {
    const packageData = readTarGzMember(tarball, "package/package.json");
    if (packageData === null) {
      fail(`${rel(tarball)} package/package.json could not be read`);
    }
    packageJson = JSON.parse(packageData.toString("utf8"));
  } catch (error) {
    fail(`${rel(tarball)} package/package.json is not valid JSON: ${error.message}`);
  }
  if (packageJson.name !== packageName) {
    fail(`${rel(tarball)} package name must be ${packageName}, got ${JSON.stringify(packageJson.name)}`);
  }
  if (packageJson.version !== version) {
    fail(`${rel(tarball)} package version must be ${version}, got ${JSON.stringify(packageJson.version)}`);
  }
  try {
    validateNpmTrustedPublishingManifest(packageJson, `${rel(tarball)} package/package.json`);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  for (const member of requiredMembers) {
    const entry = entries.get(member);
    if (entry === undefined) {
      fail(`${rel(tarball)} is missing ${member}`);
    }
    if (!entry.isFile || entry.size <= 0) {
      fail(`${rel(tarball)} ${member} must be a non-empty regular file`);
    }
  }
  for (const member of executableMembers) {
    const entry = entries.get(member);
    if (entry === undefined) {
      fail(`${rel(tarball)} is missing executable ${member}`);
    }
    if (!entry.isFile || entry.size <= 0 || (entry.mode & 0o111) === 0) {
      fail(`${rel(tarball)} ${member} must be a non-empty executable file`);
    }
  }
}

function liboliphauntRuntimeNpmPackageTargets(version) {
  return artifactNpmPackageTargets({
    product: LIBOLIPHAUNT_NATIVE_PRODUCT,
    kind: LIBOLIPHAUNT_NATIVE_KIND,
    surface: "typescript-native-direct",
    packageRoot: LIBOLIPHAUNT_NATIVE_PACKAGE_ROOT,
    version,
  });
}

function liboliphauntToolsNpmPackageTargets(version) {
  return artifactNpmPackageTargets({
    product: LIBOLIPHAUNT_NATIVE_PRODUCT,
    kind: LIBOLIPHAUNT_NATIVE_TOOLS_KIND,
    surface: "typescript-native-direct",
    packageRoot: LIBOLIPHAUNT_NATIVE_TOOLS_PACKAGE_ROOT,
    version,
  });
}

function embeddedCoreModuleMember(target, prefix) {
  const filename = target === "windows-x64-msvc"
    ? "plpgsql.dll"
    : target === "macos-arm64"
      ? "plpgsql.dylib"
      : "plpgsql.so";
  return `${prefix.replace(/\/+$/u, "")}/${filename}`;
}

export function stageWindowsVcRuntimeMembers(
  archive,
  stage,
  target,
  prefix,
  { alreadyExtracted = false, profile } = {},
) {
  if (target !== "windows-x64-msvc") return [];
  const normalizedPrefix = prefix.replace(/\/+$/u, "");
  const receiptMember = `${normalizedPrefix}/${WINDOWS_VC_RUNTIME_RECEIPT}`;
  const receiptPath = path.join(stage, ...receiptMember.split("/"));
  extractReleaseArchiveFile(archive, receiptMember, receiptPath);
  const receipt = parseWindowsVcRuntimeReceipt(readFileSync(receiptPath), `${rel(archive)}:${receiptMember}`);
  const names = [...receipt.keys()].sort(compareText);
  if (profile !== undefined) {
    assertSameStringSet(
      `${rel(archive)} ${normalizedPrefix} ${profile} VC runtime profile`,
      names,
      windowsVcRuntimeProfileNames(profile),
    );
  }
  for (const name of names) {
    const member = `${normalizedPrefix}/${name}`;
    const destination = path.join(stage, ...member.split("/"));
    const expectedDigest = receipt.get(name);
    if (
      !alreadyExtracted
      || !isFile(destination)
      || sha256File(destination) !== expectedDigest
    ) {
      extractReleaseArchiveFile(archive, member, destination);
    }
    if (!isFile(destination) || sha256File(destination) !== expectedDigest) {
      fail(`${rel(archive)} exact VC runtime member ${member} does not match ${receiptMember}`);
    }
  }
  return [receiptMember, ...names.map((name) => `${normalizedPrefix}/${name}`)];
}

function stageLiboliphauntNpmPayloads(version) {
  const assetDir = path.join(ROOT, "target/liboliphaunt/release-assets");
  const stages = new Map();
  for (const [packageName, packageDir, target] of liboliphauntRuntimeNpmPackageTargets(version)) {
    const libraryRelativePath = target.libraryRelativePath ?? target.library_relative_path;
    if (typeof libraryRelativePath !== "string" || libraryRelativePath.length === 0) {
      fail(`${target.id} must declare library_relative_path for npm artifact package publication`);
    }
    const stage = stageNpmPackageDescriptor(packageName, packageDir, version, { target: target.target });
    stageReleaseNotices(stage, { profile: "native-runtime" });
    const archive = path.join(assetDir, target.asset.replaceAll("{version}", version));
    extractReleaseArchiveFile(archive, libraryRelativePath, path.join(stage, libraryRelativePath));
    extractReleaseArchiveTree(archive, "lib/modules", path.join(stage, "lib/modules"));
    extractReleaseArchiveTree(archive, "runtime", path.join(stage, "runtime"));
    const vcRuntimeMembers = [
      ...stageWindowsVcRuntimeMembers(archive, stage, target.target, "bin", { profile: "provider" }),
      ...stageWindowsVcRuntimeMembers(archive, stage, target.target, "runtime/bin", {
        alreadyExtracted: true,
        profile: "provider",
      }),
    ];
    ensureNativeToolsAbsentFromRuntime(stage, target.target);
    runNativePayloadOptimizer(stage, target.target, "runtime");
    assertReleaseNoticesInDirectory(stage, { profile: "native-runtime" });
    stages.set(packageName, { stage, vcRuntimeMembers });
  }
  return stages;
}

function stageLiboliphauntToolsNpmPayloads(version) {
  const assetDir = path.join(ROOT, "target/liboliphaunt/release-assets");
  const stages = new Map();
  for (const [packageName, packageDir, target] of liboliphauntToolsNpmPackageTargets(version)) {
    const stage = stageNpmPackageDescriptor(packageName, packageDir, version, { target: target.target });
    stageReleaseNotices(stage, { profile: "native-tools" });
    const archive = path.join(assetDir, target.asset.replaceAll("{version}", version));
    for (const member of requiredToolsMemberPaths(target.target, "runtime/bin")) {
      extractReleaseArchiveFile(archive, member, path.join(stage, member), {
        mode: 0o755,
      });
    }
    const vcRuntimeMembers = stageWindowsVcRuntimeMembers(archive, stage, target.target, "runtime/bin");
    runNativePayloadOptimizer(stage, target.target, "tools");
    assertReleaseNoticesInDirectory(stage, { profile: "native-tools" });
    stages.set(packageName, { stage, vcRuntimeMembers });
  }
  return stages;
}

function stageLiboliphauntIcuNpmPayload(version) {
  const stage = stageNpmPackageDescriptor(
    LIBOLIPHAUNT_ICU_PACKAGE_NAME,
    LIBOLIPHAUNT_ICU_PACKAGE_ROOT,
    version,
    {
      extraDescriptors: ["OliphauntICU.podspec"],
      target: "portable",
    },
  );
  extractReleaseArchiveTree(
    path.join(ROOT, "target/liboliphaunt/release-assets", `liboliphaunt-${version}-icu-data.tar.gz`),
    "share/icu",
    path.join(stage, "share/icu"),
  );
  stageReleaseNotices(stage, { profile: "native-icu-data" });
  assertReleaseNoticesInDirectory(stage, { profile: "native-icu-data" });
  return stage;
}

function validatePackedIcuPackage(packageName, version, tarball) {
  let entries;
  try {
    entries = readTarGzEntries(tarball);
  } catch (error) {
    fail(`${rel(tarball)} is not a valid ICU npm tarball: ${error.message}`);
  }
  if (!entries.has("package/package.json")) {
    fail(`${rel(tarball)} is missing package/package.json`);
  }
  let packageJson;
  try {
    const packageData = readTarGzMember(tarball, "package/package.json");
    if (packageData === null) {
      fail(`${rel(tarball)} package/package.json could not be read`);
    }
    packageJson = JSON.parse(packageData.toString("utf8"));
  } catch (error) {
    fail(`${rel(tarball)} package/package.json is not valid JSON: ${error.message}`);
  }
  if (packageJson.name !== packageName) {
    fail(`${rel(tarball)} package name must be ${packageName}, got ${JSON.stringify(packageJson.name)}`);
  }
  if (packageJson.version !== version) {
    fail(`${rel(tarball)} package version must be ${version}, got ${JSON.stringify(packageJson.version)}`);
  }
  const metadata = packageJson.oliphaunt;
  if (
    metadata?.product !== "oliphaunt-icu" ||
    metadata?.kind !== "icu-data" ||
    metadata?.target !== "portable" ||
    metadata?.dataRelativePath !== "share/icu"
  ) {
    fail(`${rel(tarball)} package.json must declare portable oliphaunt-icu metadata`);
  }
  if (!entries.has("package/OliphauntICU.podspec")) {
    fail(`${rel(tarball)} is missing package/OliphauntICU.podspec`);
  }
  const hasIcuData = [...entries.keys()].some((member) => {
    if (!member.startsWith("package/share/icu/")) {
      return false;
    }
    const relative = member.slice("package/share/icu/".length).split("/").filter(Boolean);
    return relative.length > 0 && relative[0].startsWith("icudt");
  });
  if (!hasIcuData) {
    fail(`${rel(tarball)} is missing package/share/icu/icudt* data files`);
  }
  assertReleaseNoticesInArchive(tarball, { profile: "native-icu-data", prefix: "package" });
}

export function liboliphauntNpmTarballs(version) {
  const packages = [];
  const runtimeStages = stageLiboliphauntNpmPayloads(version);
  const toolsStages = stageLiboliphauntToolsNpmPayloads(version);
  for (const [packageName, , target] of liboliphauntRuntimeNpmPackageTargets(version)) {
    const payload = runtimeStages.get(packageName);
    const libraryRelativePath = target.libraryRelativePath ?? target.library_relative_path;
    const runtimeMembers = requiredRuntimeMemberPaths(target.target, "package/runtime/bin");
    const requiredMembers = [
      `package/${libraryRelativePath}`,
      embeddedCoreModuleMember(target.target, "package/lib/modules"),
      ...runtimeMembers,
      ...payload.vcRuntimeMembers.map((member) => `package/${member}`),
      ...releaseNoticeRows({ profile: "native-runtime" }).map((row) => `package/${row.member}`),
    ];
    const tarball = pnpmPackForNpmPublish(payload.stage);
    validatePackedNpmPackage({
      packageName,
      version,
      tarball,
      requiredMembers,
      executableMembers: runtimeMembers,
    });
    assertReleaseNoticesInArchive(tarball, { profile: "native-runtime", prefix: "package" });
    packages.push([packageName, tarball]);
  }
  for (const [packageName, , target] of liboliphauntToolsNpmPackageTargets(version)) {
    const payload = toolsStages.get(packageName);
    const runtimeMembers = requiredToolsMemberPaths(target.target, "package/runtime/bin");
    const tarball = pnpmPackForNpmPublish(payload.stage);
    validatePackedNpmPackage({
      packageName,
      version,
      tarball,
      requiredMembers: [
        ...runtimeMembers,
        ...payload.vcRuntimeMembers.map((member) => `package/${member}`),
        ...releaseNoticeRows({ profile: "native-tools" }).map((row) => `package/${row.member}`),
      ],
      executableMembers: runtimeMembers,
    });
    assertReleaseNoticesInArchive(tarball, { profile: "native-tools", prefix: "package" });
    packages.push([packageName, tarball]);
  }
  const icuStage = stageLiboliphauntIcuNpmPayload(version);
  const icuTarball = pnpmPackForNpmPublish(icuStage);
  validatePackedIcuPackage(LIBOLIPHAUNT_ICU_PACKAGE_NAME, version, icuTarball);
  packages.push([LIBOLIPHAUNT_ICU_PACKAGE_NAME, icuTarball]);
  return packages;
}

export function brokerNpmTarballs(
  version,
  { assetDir = path.join(ROOT, "target/oliphaunt-broker/release-assets") } = {},
) {
  const tarballs = [];
  for (const [packageName, packageDir, target] of brokerNpmPackageTargets(version)) {
    const executableRelativePath = target.executable_relative_path;
    if (typeof executableRelativePath !== "string" || executableRelativePath.length === 0) {
      fail(`${target.id} must declare executable_relative_path for npm artifact package publication`);
    }
    const stageDir = stageNpmPackageDescriptor(packageName, packageDir, version, { target: target.target });
    stageReleaseNotices(stageDir, { profile: "broker" });
    assertReleaseNoticesInDirectory(stageDir, { profile: "broker" });
    const archive = path.join(assetDir, target.asset.replaceAll("{version}", version));
    assertBrokerDependencyLicensesInArchive(archive, { target: target.target });
    extractReleaseArchiveFile(archive, executableRelativePath, path.join(stageDir, executableRelativePath), { mode: 0o755 });
    extractReleaseArchiveTree(
      archive,
      "THIRD_PARTY_LICENSES/rust",
      path.join(stageDir, "THIRD_PARTY_LICENSES/rust"),
    );
    normalizeBrokerDependencyLicenseModes(stageDir, target.target);
    assertBrokerDependencyLicensesInDirectory(stageDir, { target: target.target });
    const vcRuntimeMembers = stageWindowsVcRuntimeMembers(archive, stageDir, target.target, "bin");
    const tarball = pnpmPackForNpmPublish(stageDir);
    const requiredMembers = [
      `package/${executableRelativePath}`,
      ...vcRuntimeMembers.map((member) => `package/${member}`),
      ...releaseNoticeRows({ profile: "broker" }).map((row) => `package/${row.member}`),
      ...brokerDependencyLicenseMembers(target.target, { prefix: "package" }),
    ];
    validatePackedNpmPackage({
      packageName,
      version,
      tarball,
      requiredMembers,
      executableMembers: [`package/${executableRelativePath}`],
    });
    assertBrokerDependencyLicensesInArchive(tarball, { target: target.target, prefix: "package" });
    tarballs.push([packageName, tarball]);
  }
  return tarballs;
}

async function validateNodeDirectOptionalTarball(packageName, version, tarball) {
  if (!isFile(tarball)) {
    fail(`missing Node direct optional npm package artifact: ${rel(tarball)}`);
  }
  let entries;
  try {
    entries = readTarGzEntries(tarball);
  } catch (error) {
    fail(`${rel(tarball)} is not a valid Node direct optional npm tarball: ${error.message}`);
  }
  for (const required of ["package/package.json", "package/prebuilds/oliphaunt_node.node"]) {
    if (!entries.has(required)) {
      fail(`${rel(tarball)} is missing ${required}`);
    }
  }
  const prebuild = entries.get("package/prebuilds/oliphaunt_node.node");
  if (!prebuild.isFile || prebuild.size <= 0) {
    fail(`${rel(tarball)} prebuilt addon must be a non-empty regular file`);
  }
  let packageJson;
  try {
    const packageData = readTarGzMember(tarball, "package/package.json");
    if (packageData === null) {
      fail(`${rel(tarball)} package/package.json could not be read`);
    }
    packageJson = JSON.parse(packageData.toString("utf8"));
  } catch (error) {
    fail(`${rel(tarball)} package/package.json is not valid JSON: ${error.message}`);
  }
  if (packageJson.name !== packageName) {
    fail(`${rel(tarball)} package name must be ${packageName}, got ${JSON.stringify(packageJson.name)}`);
  }
  if (packageJson.version !== version) {
    fail(`${rel(tarball)} package version must be ${version}, got ${JSON.stringify(packageJson.version)}`);
  }
}

export async function nodeDirectOptionalNpmTarballs(version) {
  const tarballs = [];
  for (const [packageName] of nodeDirectOptionalPackageTargets(version)) {
    const tarball = expectedNodeDirectNpmTarball(packageName, version);
    await validateNodeDirectOptionalTarball(packageName, version, tarball);
    tarballs.push([packageName, tarball]);
  }
  const expected = new Set(tarballs.map(([, tarball]) => path.resolve(tarball)));
  const unexpected = isDirectory(nodeDirectNpmPackageDir())
    ? readdirSync(nodeDirectNpmPackageDir())
      .filter((name) => name.endsWith(".tgz"))
      .map((name) => path.join(nodeDirectNpmPackageDir(), name))
      .filter((file) => !expected.has(path.resolve(file)))
      .map((file) => path.basename(file))
      .sort(compareText)
    : [];
  if (unexpected.length > 0) {
    fail(`unexpected Node direct optional npm package artifact(s): ${unexpected.join(", ")}`);
  }
  return tarballs;
}

async function runNodeDirectDryRun() {
  run(TOOL, ["src/runtimes/node-direct/tools/check-package.sh", "package-shape"]);
  ensureNodeDirectReleaseAssets();
  await nodeDirectOptionalNpmTarballs(currentProductVersionSync(NODE_DIRECT_PRODUCT, TOOL));
}

function runBrokerDryRun() {
  const version = currentProductVersionSync(BROKER_PRODUCT, TOOL);
  ensureBrokerReleaseAssets();
  brokerNpmTarballs(version);
  run(TOOL, [
    process.execPath,
    "tools/release/package_broker_cargo_artifacts.mjs",
    "--version",
    version,
    "--output-dir",
    "target/oliphaunt-broker/cargo-artifacts",
  ]);
}

function nativeCargoArtifactTargets(kind) {
  return artifactTargets(LIBOLIPHAUNT_NATIVE_PRODUCT, kind, TOOL)
    .filter((target) => target.surfaces.includes("rust-native-direct"))
    .sort((left, right) => compareText(left.target, right.target));
}

function validateNativeCargoArtifacts(outputDir) {
  const manifestPath = path.join(outputDir, "packages.json");
  if (!isFile(manifestPath)) {
    fail(`missing generated ${LIBOLIPHAUNT_NATIVE_PRODUCT} Cargo artifact manifest: ${rel(manifestPath)}`);
  }
  let data;
  try {
    data = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    fail(`${rel(manifestPath)} is not valid JSON: ${error.message}`);
  }
  if (data?.schema !== "oliphaunt-liboliphaunt-cargo-artifacts-v1" || !Array.isArray(data.packages)) {
    fail(`${rel(manifestPath)} has an invalid liboliphaunt native Cargo artifact schema`);
  }

  const expectedAggregators = new Set([
    ...nativeCargoArtifactTargets(LIBOLIPHAUNT_NATIVE_KIND)
      .map((target) => `${LIBOLIPHAUNT_NATIVE_PRODUCT}-${target.target}`),
    ...nativeCargoArtifactTargets(LIBOLIPHAUNT_NATIVE_TOOLS_KIND)
      .map((target) => `${LIBOLIPHAUNT_NATIVE_TOOLS_PRODUCT}-${target.target}`),
  ]);
  const expectedRegistryCrates = new Set([...expectedAggregators, LIBOLIPHAUNT_NATIVE_TOOLS_PRODUCT]);
  const configuredCrates = new Set(
    registryPackageRows({ product: LIBOLIPHAUNT_NATIVE_PRODUCT, packageKind: "crates" }, TOOL)
      .map((row) => row.packageName),
  );
  assertSameStringSet(
    `${LIBOLIPHAUNT_NATIVE_PRODUCT} crates.io packages must match native runtime/tool artifact packages`,
    configuredCrates,
    expectedRegistryCrates,
  );
  const aggregators = new Set();
  const facades = new Set();
  const expectedCratePaths = new Set();
  const packages = [];

  for (const item of data.packages) {
    if (item === null || Array.isArray(item) || typeof item !== "object") {
      fail(`${rel(manifestPath)} package entries must be objects`);
    }
    const { name, role, manifestPath: rawManifest, cratePath: rawCrate } = item;
    if (![name, role, rawManifest].every((value) => typeof value === "string" && value.length > 0)) {
      fail(`${rel(manifestPath)} has an invalid package row: ${JSON.stringify(item)}`);
    }
    const sourceManifest = path.join(ROOT, rawManifest);
    if (!isFile(sourceManifest)) {
      fail(`missing generated ${LIBOLIPHAUNT_NATIVE_PRODUCT} Cargo source manifest: ${rawManifest}`);
    }
    if (typeof rawCrate !== "string" || rawCrate.length === 0) {
      fail(`generated ${LIBOLIPHAUNT_NATIVE_PRODUCT} registry crate ${name} must freeze a .crate archive`);
    }
    const cratePath = path.join(ROOT, rawCrate);
    if (!isFile(cratePath) || !cratePath.endsWith(".crate")) {
      fail(`missing generated ${LIBOLIPHAUNT_NATIVE_PRODUCT} Cargo archive for ${name}: ${rawCrate}`);
    }
    expectedCratePaths.add(path.resolve(cratePath));
    if (role === "part") {
      const aggregator = name.replace(/-part-\d{3}$/u, "");
      if (aggregator === name || !expectedAggregators.has(aggregator)) {
        fail(`unexpected ${LIBOLIPHAUNT_NATIVE_PRODUCT} Cargo part crate ${name}`);
      }
      packages.push({ name, cratePath, manifestPath: sourceManifest, role });
      continue;
    }
    if (role === "aggregator") {
      if (!expectedAggregators.has(name)) {
        fail(`unexpected ${LIBOLIPHAUNT_NATIVE_PRODUCT} Cargo aggregator crate ${name}`);
      }
      aggregators.add(name);
      packages.push({ name, cratePath, manifestPath: sourceManifest, role });
      continue;
    }
    if (role === "facade") {
      if (name !== LIBOLIPHAUNT_NATIVE_TOOLS_PRODUCT) {
        fail(`unexpected ${LIBOLIPHAUNT_NATIVE_PRODUCT} Cargo facade crate ${name}`);
      }
      facades.add(name);
      packages.push({ name, cratePath, manifestPath: sourceManifest, role });
      continue;
    }
    fail(`${rel(manifestPath)} has unsupported Cargo artifact role ${JSON.stringify(role)}`);
  }

  const missingAggregators = [...expectedAggregators]
    .filter((name) => !aggregators.has(name))
    .sort(compareText);
  if (missingAggregators.length > 0) {
    fail(`generated ${LIBOLIPHAUNT_NATIVE_PRODUCT} Cargo artifacts are missing aggregator crates: ${missingAggregators.join(", ")}`);
  }
  if (!facades.has(LIBOLIPHAUNT_NATIVE_TOOLS_PRODUCT)) {
    fail(`generated ${LIBOLIPHAUNT_NATIVE_PRODUCT} Cargo artifacts are missing ${LIBOLIPHAUNT_NATIVE_TOOLS_PRODUCT} facade crate`);
  }
  const unexpected = readdirSync(outputDir)
    .filter((name) => name.endsWith(".crate"))
    .map((name) => path.join(outputDir, name))
    .filter((file) => !expectedCratePaths.has(path.resolve(file)))
    .map((file) => path.basename(file))
    .sort(compareText);
  if (unexpected.length > 0) {
    fail(`unexpected ${LIBOLIPHAUNT_NATIVE_PRODUCT} Cargo artifact crate(s): ${unexpected.join(", ")}`);
  }
  const roleOrder = new Map([
    ["part", 0],
    ["aggregator", 1],
    ["facade", 2],
  ]);
  return packages.sort((left, right) =>
    (roleOrder.get(left.role) ?? 99) - (roleOrder.get(right.role) ?? 99) ||
    compareText(left.name, right.name),
  );
}

export function liboliphauntNativeCargoArtifactPackages(version = currentProductVersionSync(LIBOLIPHAUNT_NATIVE_PRODUCT, TOOL)) {
  const outputDir = path.join(ROOT, "target/liboliphaunt/cargo-artifacts");
  ensureLiboliphauntReleaseAssets();
  run(TOOL, [
    process.execPath,
    "tools/release/package-liboliphaunt-cargo-artifacts.mjs",
    "--version",
    version,
    "--output-dir",
    rel(outputDir),
  ]);
  return validateNativeCargoArtifacts(outputDir);
}

function runLiboliphauntNativeDryRun() {
  const version = currentProductVersionSync(LIBOLIPHAUNT_NATIVE_PRODUCT, TOOL);
  liboliphauntNativeCargoArtifactPackages(version);
  liboliphauntNpmTarballs(version);
  const manifest = buildMavenArtifactManifest("liboliphaunt-native-runtime", { runtime: true });
  runMavenArtifactPublisher(
    manifest,
    ":oliphaunt-maven-artifacts:publishToMavenLocal",
    "liboliphaunt-native-maven-dry-run",
  );
}

function isExpectedWasixExtensionPackage(name, kind) {
  if (kind === "wasix-extension") {
    return exactExtensionProducts(TOOL).some((product) => name === `${product}-wasix`);
  }
  if (kind === "wasix-extension-aot") {
    return exactExtensionProducts(TOOL).some((product) => name.startsWith(`${product}-wasix-aot-`));
  }
  return false;
}

function validateWasixCargoArtifacts(outputDir) {
  const manifestPath = path.join(outputDir, "packages.json");
  if (!isFile(manifestPath)) {
    fail(`missing generated ${WASIX_PRODUCT} Cargo artifact manifest: ${rel(manifestPath)}`);
  }
  let data;
  try {
    data = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    fail(`${rel(manifestPath)} is not valid JSON: ${error.message}`);
  }
  if (data?.schema !== WASIX_CARGO_ARTIFACT_SCHEMA || !Array.isArray(data.packages)) {
    fail(`${rel(manifestPath)} has an invalid WASIX Cargo artifact schema`);
  }

  const expectedBaseCrates = new Set(wasixPublicCargoPackageNames());
  const configuredCrates = new Set(
    registryPackageRows({ product: WASIX_PRODUCT, packageKind: "crates" }, TOOL)
      .map((row) => row.packageName),
  );
  assertSameStringSet(
    `${WASIX_PRODUCT} crates.io packages must match WASIX runtime/AOT artifact packages`,
    configuredCrates,
    expectedBaseCrates,
  );
  const generatedCrates = new Set();
  const expectedCratePaths = new Set();
  const packages = [];
  const allowedKinds = new Set([
    "wasix-runtime",
    "wasix-tools",
    "wasix-aot",
    "wasix-tools-aot",
    "icu-data",
    "wasix-extension",
    "wasix-extension-aot",
  ]);
  for (const item of data.packages) {
    if (item === null || Array.isArray(item) || typeof item !== "object") {
      fail(`${rel(manifestPath)} package entries must be objects`);
    }
    const { name, role, kind, manifestPath: rawManifest, cratePath: rawCrate } = item;
    if (![name, role, kind, rawManifest].every((value) => typeof value === "string" && value.length > 0)) {
      fail(`${rel(manifestPath)} has an invalid package row: ${JSON.stringify(item)}`);
    }
    if (role !== "artifact") {
      fail(`${rel(manifestPath)} must contain direct WASIX artifact packages, got role ${JSON.stringify(role)}`);
    }
    if (!allowedKinds.has(kind)) {
      fail(`${rel(manifestPath)} has unsupported WASIX Cargo artifact kind ${JSON.stringify(kind)}`);
    }
    if (!expectedBaseCrates.has(name) && !isExpectedWasixExtensionPackage(name, kind)) {
      fail(`unexpected ${WASIX_PRODUCT} Cargo artifact crate ${name}`);
    }
    const sourceManifest = path.join(ROOT, rawManifest);
    if (!isFile(sourceManifest)) {
      fail(`missing generated ${WASIX_PRODUCT} Cargo source manifest: ${rawManifest}`);
    }
    if (typeof rawCrate !== "string" || rawCrate.length === 0) {
      fail(`generated ${WASIX_PRODUCT} Cargo artifact ${name} must have a cratePath`);
    }
    const cratePath = path.join(ROOT, rawCrate);
    if (!isFile(cratePath)) {
      fail(`missing generated ${WASIX_PRODUCT} Cargo artifact crate for ${name}: ${rawCrate}`);
    }
    generatedCrates.add(name);
    expectedCratePaths.add(path.resolve(cratePath));
    packages.push({ name, cratePath, manifestPath: sourceManifest });
  }

  const missingBaseCrates = [...expectedBaseCrates]
    .filter((name) => !generatedCrates.has(name))
    .sort(compareText);
  if (missingBaseCrates.length > 0) {
    fail(`generated ${WASIX_PRODUCT} Cargo artifacts are missing configured runtime crates: ${missingBaseCrates.join(", ")}`);
  }
  const unexpected = readdirSync(outputDir)
    .filter((name) => name.endsWith(".crate"))
    .map((name) => path.join(outputDir, name))
    .filter((file) => !expectedCratePaths.has(path.resolve(file)))
    .map((file) => path.basename(file))
    .sort(compareText);
  if (unexpected.length > 0) {
    fail(`unexpected ${WASIX_PRODUCT} Cargo artifact crate(s): ${unexpected.join(", ")}`);
  }
  return packages.sort((left, right) => compareText(left.name, right.name));
}

export function liboliphauntWasixCargoArtifactPackages(version = currentProductVersionSync(WASIX_PRODUCT, TOOL)) {
  const outputDir = path.join(ROOT, "target/oliphaunt-wasix/cargo-artifacts");
  ensureWasixReleaseAssets();
  run(TOOL, [
    process.execPath,
    "tools/release/package_liboliphaunt_wasix_cargo_artifacts.mjs",
    "--version",
    version,
    "--output-dir",
    rel(outputDir),
  ]);
  return validateWasixCargoArtifacts(outputDir);
}

function runWasixRuntimeDryRun() {
  liboliphauntWasixCargoArtifactPackages(currentProductVersionSync(WASIX_PRODUCT, TOOL));
}

function extensionPackageDir(product) {
  return path.join(ROOT, "target/extension-artifacts", product);
}

function releaseSurfaceResult(surface) {
  return { surface, staged: [], skipped: [] };
}

function stagedTarballs(result) {
  return result.staged
    .filter((entry) => entry.endsWith(".tgz"))
    .map((entry) => path.isAbsolute(entry) ? entry : path.join(ROOT, entry));
}

export function extensionAssetPaths(product) {
  run(TOOL, [
    process.execPath,
    "tools/release/check-staged-artifacts.mjs",
    "--require-extension-product",
    product,
    "--require-full-extension-targets",
  ]);
  const assetDir = path.join(extensionPackageDir(product), "release-assets");
  if (!isDirectory(assetDir)) {
    fail(`${product} extension package did not create ${rel(assetDir)}`);
  }
  const assets = readdirSync(assetDir)
    .sort(compareText)
    .map((name) => path.join(assetDir, name))
    .filter(isFile);
  if (assets.length === 0) {
    fail(`${product} extension package produced no release assets`);
  }
  return assets.map(rel);
}

export function buildMavenArtifactManifest(name, { runtime = false, extensions = false, extensionProducts = [] } = {}) {
  const outputPath = path.join(ROOT, "target/release/maven-artifacts", `${name}.tsv`);
  const command = [
    process.execPath,
    "tools/release/build_maven_artifact_manifest.mjs",
    "--output",
    rel(outputPath),
  ];
  if (runtime) {
    command.push("--runtime");
  }
  if (extensions) {
    command.push("--extensions");
  }
  for (const extensionProduct of extensionProducts) {
    command.push("--extension-product", extensionProduct);
  }
  run(TOOL, command);
  return outputPath;
}

export function runMavenArtifactPublisher(manifest, task, cacheSlug) {
  const args = [
    "src/sdks/kotlin/gradlew",
    "-p",
    "src/sdks/kotlin",
    task,
    `-PoliphauntMavenArtifactsManifest=${manifest}`,
    `-PoliphauntBuildRoot=${path.join(ROOT, "target/liboliphaunt-sdk-check/gradle", cacheSlug)}`,
    "--project-cache-dir",
    path.join(ROOT, "target/liboliphaunt-sdk-check/gradle-cache", cacheSlug),
    "--configure-on-demand",
    "--no-configuration-cache",
  ];
  if (task.endsWith("publishToMavenLocal")) {
    args.splice(4, 0, `-Dmaven.repo.local=${path.join(ROOT, "target/release/maven-staging", cacheSlug)}`);
  }
  run(TOOL, args);
}

function runExtensionMavenArtifactDryRun(product) {
  const manifest = buildMavenArtifactManifest(product, {
    extensions: true,
    extensionProducts: [product],
  });
  runMavenArtifactPublisher(
    manifest,
    ":oliphaunt-maven-artifacts:publishToMavenLocal",
    `${product}-maven-dry-run`,
  );
}

function runExtensionNpmArtifactDryRun(product) {
  const roots = [extensionPackageDir(product)];
  const packages = new Set();
  const targets = extensionRegistryPackageTargetSets(product, TOOL).npmTargets;
  for (const target of targets) {
    const result = releaseSurfaceResult(`${product}-npm-${target}`);
    const tarballRoot = stageExtensionNpmPackages(
      roots,
      path.join(ROOT, "target/release/extension-dry-run/npm", product, target),
      target,
      result,
      { metaTargets: targets },
    );
    if (tarballRoot === null) {
      fail(`${product} npm dry-run failed for ${target}: ${result.skipped.join("; ")}`);
    }
    for (const tarball of stagedTarballs(result)) {
      const identity = npmPackageIdentity(tarball);
      if (identity === null) {
        fail(`${product} npm dry-run could not read package identity from ${rel(tarball)}`);
      }
      packages.add(`${identity.name}@${identity.version}`);
    }
  }
  console.log(`${product} npm dry-run packages: ${[...packages].sort(compareText).join(", ")}`);
}

function runExtensionNativeCargoArtifactDryRun(product) {
  const roots = [extensionPackageDir(product)];
  const packages = [];
  for (const target of extensionRegistryPackageTargetSets(product, TOOL).nativeCargoTargets) {
    const result = releaseSurfaceResult(`${product}-cargo-${target}`);
    const crates = packageNativeExtensionCargoCrates(
      roots,
      path.join(ROOT, "target/release/extension-dry-run/cargo", product, `native-${target}`),
      target,
      true,
      result,
    );
    if (crates.length === 0) {
      fail(`${product} native Cargo dry-run failed for ${target}: ${result.skipped.join("; ")}`);
    }
    for (const cratePath of crates) {
      const identity = cargoPackageIdentityFromCrate(cratePath);
      if (identity === null) {
        fail(`${product} native Cargo dry-run could not read package identity from ${rel(cratePath)}`);
      }
      packages.push(`${identity.name}@${identity.version}`);
    }
  }
  console.log(`${product} native Cargo dry-run packages: ${packages.sort(compareText).join(", ")}`);
}

function runExtensionWasixCargoArtifactDryRun(product) {
  const outputDir = path.join(ROOT, "target/release/extension-dry-run/cargo", product, "wasix");
  run(TOOL, [
    process.execPath,
    "tools/release/package_liboliphaunt_wasix_cargo_artifacts.mjs",
    "--extensions-only",
    "--output-dir",
    rel(outputDir),
    "--extension-artifact-root",
    rel(extensionPackageDir(product)),
  ]);
  const manifestPath = path.join(outputDir, "packages.json");
  if (!isFile(manifestPath)) {
    fail(`${product} WASIX Cargo dry-run did not generate ${rel(manifestPath)}`);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const packages = (manifest.packages ?? [])
    .filter((pkg) => pkg?.kind === "wasix-extension" || pkg?.kind === "wasix-extension-aot")
    .map((pkg) => pkg.name)
    .sort(compareText);
  if (packages.length === 0) {
    fail(`${product} WASIX Cargo dry-run generated no extension packages`);
  }
  console.log(`${product} WASIX Cargo dry-run packages: ${packages.join(", ")}`);
}

function runExtensionCargoFacadeDryRun(product) {
  const packages = packageExtensionCargoFacades(
    [product],
    path.join(ROOT, "target/release/extension-dry-run/cargo", product, "facade"),
  );
  if (packages.length !== 1 || packages[0].name !== product) {
    fail(`${product} Cargo facade dry-run did not generate its canonical facade crate`);
  }
  console.log(`${product} Cargo facade dry-run package: ${product}@${packages[0].version}`);
}

function runExtensionDryRun(product) {
  for (const asset of extensionAssetPaths(product)) {
    console.log(`${product} release asset: ${asset}`);
  }
  runExtensionMavenArtifactDryRun(product);
  runExtensionNpmArtifactDryRun(product);
  runExtensionNativeCargoArtifactDryRun(product);
  runExtensionWasixCargoArtifactDryRun(product);
  runExtensionCargoFacadeDryRun(product);
}

export async function runBunProductDryRun(product, { allowDirty = false } = {}) {
  if (SUPPORTED_SDK_PRODUCT_DRY_RUNS.has(product)) {
    await runSdkProductDryRun(product, { allowDirty });
    return;
  }
  if (product === LIBOLIPHAUNT_NATIVE_PRODUCT) {
    runLiboliphauntNativeDryRun();
    return;
  }
  if (product === BROKER_PRODUCT) {
    runBrokerDryRun();
    return;
  }
  if (product === WASIX_PRODUCT) {
    runWasixRuntimeDryRun();
    return;
  }
  if (product === NODE_DIRECT_PRODUCT) {
    await runNodeDirectDryRun();
    return;
  }
  if (exactExtensionProducts(TOOL).includes(product)) {
    runExtensionDryRun(product);
    return;
  }
  fail(`no Bun publish dry-run handler for ${product}`, 2);
}

function usage() {
  console.log(`usage: tools/release/release-product-dry-run.mjs --product PRODUCT [--allow-dirty]

Runs Bun-owned product publish dry-run checks. Release-wide checks and registry
dependency checks are owned by release-publish.mjs before this helper is invoked
from the public publish dry-run command surface.
`);
}

function parseArgs(argv) {
  const args = {
    allowDirty: false,
    product: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--allow-dirty") {
      args.allowDirty = true;
    } else if (arg === "--product") {
      const value = argv[index + 1];
      if (!value) {
        usage();
        fail("--product requires a value", 2);
      }
      args.product = value;
      index += 1;
    } else if (arg.startsWith("--product=")) {
      args.product = arg.slice("--product=".length);
    } else if (arg === "-h" || arg === "--help") {
      usage();
      process.exit(0);
    } else {
      usage();
      fail(`unknown argument ${arg}`, 2);
    }
  }
  if (args.product === null) {
    usage();
    fail("--product is required", 2);
  }
  return args;
}

if (import.meta.main) {
  const args = parseArgs(Bun.argv.slice(2));
  await runBunProductDryRun(args.product, { allowDirty: args.allowDirty });
}
