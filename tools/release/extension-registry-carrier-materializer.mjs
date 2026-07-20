#!/usr/bin/env bun
import { spawnSync as nodeSpawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import {
  manualCargoPackageSource,
  readCargoPackageNameVersion,
} from "./cargo-source-package.mjs";
import {
  compareText,
  extensionRegistryPackageTargetSets,
} from "./release-artifact-targets.mjs";
import { localWindowsTarInvocation } from "./tar-command.mjs";
import {
  extensionNpmPackageForProduct,
  extensionNpmTargetPackageForProduct,
  nativeExtensionCargoLinksName,
  nativeExtensionCargoPackageName,
  nativeExtensionCargoPartPackageName,
} from "./extension-registry-packages.mjs";
import {
  IOS_CARRIER_FILENAME,
  buildIosCarrierManifest,
} from "./ios-carrier-manifest.mjs";
import {
  NPM_TRUSTED_PUBLISHING_REPOSITORY,
  validateNpmTrustedPublishingManifest,
} from "./npm-trusted-publishing.mjs";
import { validateExtensionArtifactArchive } from "./extension-artifact-inventory.mjs";
import { extensionRuntimeAssetContract } from "./extension-runtime-asset-contract.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");
// Keep the established diagnostic prefix for callers importing the public
// compatibility surface from local-registry-publish.mjs.
const TOOL = "local-registry-publish.mjs";
// npm does not impose crates.io's 10 MiB package limit. Keep one deliberately
// generous guard against accidentally publishing an unbounded staging tree,
// but never manufacture package identities merely to satisfy a repository-
// local threshold.
const NPM_PACKAGE_SAFETY_LIMIT_BYTES = 100 * 1024 * 1024;
const CARGO_PACKAGE_SIZE_LIMIT_BYTES = 10 * 1024 * 1024;
const CARGO_EXTENSION_PART_BYTES = 7 * 1024 * 1024;
const CARGO_EXTENSION_SPLIT_THRESHOLD_BYTES = 9 * 1024 * 1024;
const NPM_EXTENSION_CONTRACT_FILENAME = "extension-contract.json";
const MAX_COMMAND_CAPTURE_BYTES = 32 * 1024 * 1024;

function fail(tool, message) {
  throw new Error(`${tool}: ${message}`);
}

function windowsCommandShim(command, platform = process.platform) {
  return platform === "win32" && command === "pnpm"
    ? `${command}.cmd`
    : command;
}

export function localRegistryCommandInvocation(
  command,
  args,
  { platform = process.platform, cwd = ROOT } = {},
) {
  const shimmed = windowsCommandShim(command, platform);
  const tar = command === "tar"
    ? localWindowsTarInvocation(args, { cwd, platform })
    : { args: [...args], cwd };
  return {
    command: shimmed,
    args: tar.args,
    ...(platform === "win32" && command === "tar" ? { cwd: tar.cwd } : {}),
    shell: platform === "win32" && shimmed.endsWith(".cmd"),
  };
}

function spawnSync(command, args, options) {
  const invocation = localRegistryCommandInvocation(command, args, { cwd: options.cwd ?? ROOT });
  return nodeSpawnSync(invocation.command, invocation.args, {
    ...options,
    cwd: invocation.cwd ?? options.cwd,
    shell: invocation.shell,
  });
}

export function canonicalExtensionNpmTargets(product) {
  return extensionRegistryPackageTargetSets(product, TOOL).npmTargets;
}

function rel(file) {
  const relative = path.relative(ROOT, file);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative)
    ? relative.split(path.sep).join("/")
    : file.split(path.sep).join("/");
}

function walkFiles(root) {
  const files = [];
  const visit = (current) => {
    const entries = readdirSync(current, { withFileTypes: true })
      .sort((left, right) => compareText(left.name, right.name));
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        visit(entryPath);
      } else if (entry.isFile()) {
        files.push(entryPath);
      }
    }
  };
  visit(root);
  return files;
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

function safeNpmPackageFilenamePrefix(packageName) {
  return packageName.replace(/^@/u, "").replaceAll("/", "-");
}

function readJsonFile(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    fail(TOOL, `${rel(file)} is not valid JSON: ${error.message}`);
  }
}

function extensionManifestIdentity(manifest) {
  let data;
  try {
    data = JSON.parse(readFileSync(manifest, "utf8"));
  } catch {
    return ["path", realpathSync(manifest)];
  }
  const { product, version, sqlName } = data;
  if ([product, version, sqlName].every((value) => typeof value === "string" && value.length > 0)) {
    return ["extension", product, version, sqlName];
  }
  return ["path", realpathSync(manifest)];
}

function extensionManifestCandidates(root) {
  if (!existsSync(root)) return [];
  const metadata = lstatSync(root);
  if (metadata.isSymbolicLink()) {
    fail(TOOL, `extension manifest input must not be a symbolic link or junction: ${rel(root)}`);
  }
  if (metadata.isFile() && path.basename(root) === "extension-artifacts.json") return [root];
  if (metadata.isFile()) return [];
  if (!metadata.isDirectory()) {
    fail(TOOL, `extension manifest input has an unsupported filesystem type: ${rel(root)}`);
  }
  // Bun.Glob opens its cwd with a Windows access mask that is rejected by the
  // deliberately read-only standard-user release token. The Node-compatible
  // directory APIs use the narrower list/read contract already proven by the
  // launcher. Keep this traversal explicit so a symlink, Windows junction, or
  // special entry cannot be silently skipped while constructing release input.
  const manifests = [];
  const visit = (directory) => {
    const entries = readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => compareText(left.name, right.name));
    for (const entry of entries) {
      const candidate = path.join(directory, entry.name);
      const candidateMetadata = lstatSync(candidate);
      if (candidateMetadata.isSymbolicLink()) {
        fail(TOOL, `extension manifest input must not contain a symbolic link or junction: ${rel(candidate)}`);
      }
      if (candidateMetadata.isDirectory()) {
        visit(candidate);
      } else if (candidateMetadata.isFile()) {
        if (entry.name === "extension-artifacts.json") manifests.push(candidate);
      } else {
        fail(TOOL, `extension manifest input contains an unsupported filesystem entry: ${rel(candidate)}`);
      }
    }
  };
  visit(root);
  return manifests;
}

export function discoverExtensionManifests(roots) {
  const manifests = new Map();
  const seenPaths = new Set();
  for (const root of roots) {
    for (const manifest of extensionManifestCandidates(root)) {
      const resolved = realpathSync(manifest);
      if (seenPaths.has(resolved)) continue;
      seenPaths.add(resolved);
      const identity = JSON.stringify(extensionManifestIdentity(manifest));
      if (!manifests.has(identity)) manifests.set(identity, manifest);
    }
  }
  return [...manifests.values()];
}

function runArchiveCommand(args, label) {
  const result = spawnSync(args[0], args.slice(1), {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: MAX_COMMAND_CAPTURE_BYTES,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) {
    fail(TOOL, `${label} failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    fail(TOOL, `${label} failed${detail ? `: ${detail}` : ""}`);
  }
  return result.stdout;
}

function archiveTempDir() {
  const root = path.join(ROOT, "target", "local-registry-archive-extract");
  mkdirSync(root, { recursive: true });
  return mkdtempSync(path.join(root, "extract-"));
}

function tarballPackageJson(tarball) {
  const text = runArchiveCommand(
    ["tar", "-xOzf", tarball, "package/package.json"],
    `read package.json from ${rel(tarball)}`,
  );
  try {
    return JSON.parse(text);
  } catch (error) {
    fail(TOOL, `${rel(tarball)} package/package.json is not valid JSON: ${error.message}`);
  }
}

function pnpmPackForNpmPublish(packageDir, tarballRoot) {
  const packageJson = readJsonFile(path.join(packageDir, "package.json"));
  const packageName = packageJson.name;
  const packageVersion = packageJson.version;
  if (typeof packageName !== "string" || packageName.length === 0) {
    fail(TOOL, `${rel(path.join(packageDir, "package.json"))} must declare a package name`);
  }
  if (typeof packageVersion !== "string" || packageVersion.length === 0) {
    fail(TOOL, `${rel(path.join(packageDir, "package.json"))} must declare a package version`);
  }
  try {
    validateNpmTrustedPublishingManifest(packageJson, rel(path.join(packageDir, "package.json")));
  } catch (error) {
    fail(TOOL, error instanceof Error ? error.message : String(error));
  }
  const packDir = path.join(tarballRoot, safeNpmPackageFilenamePrefix(packageName));
  rmSync(packDir, { recursive: true, force: true });
  mkdirSync(packDir, { recursive: true });
  const result = spawnSync("pnpm", ["pack", "--pack-destination", packDir, "--json"], {
    cwd: packageDir,
    encoding: "utf8",
    maxBuffer: MAX_COMMAND_CAPTURE_BYTES,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) {
    fail(TOOL, `pnpm pack for ${packageName} failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    fail(TOOL, `pnpm pack for ${packageName} failed${detail ? `: ${detail}` : ""}`);
  }
  let manifest;
  try {
    manifest = JSON.parse(result.stdout);
  } catch (error) {
    fail(TOOL, `pnpm pack for ${packageName} did not emit JSON: ${error.message}`);
  }
  const row = Array.isArray(manifest) ? manifest[0] : manifest;
  const filename = row?.filename;
  if (typeof filename !== "string" || !filename.endsWith(".tgz")) {
    fail(TOOL, `pnpm pack for ${packageName} did not report a .tgz filename`);
  }
  const destinationTarball = path.isAbsolute(filename)
    ? filename
    : path.join(packDir, path.basename(filename));
  if (!isFile(destinationTarball)) {
    fail(TOOL, `pnpm pack for ${packageName} did not create ${rel(destinationTarball)}`);
  }
  try {
    validateNpmTrustedPublishingManifest(
      tarballPackageJson(destinationTarball),
      `${rel(destinationTarball)} package/package.json`,
    );
  } catch (error) {
    fail(TOOL, error instanceof Error ? error.message : String(error));
  }
  return destinationTarball;
}

function cargoTargetTriple(targetId) {
  if (targetId === "linux-x64-gnu") return "x86_64-unknown-linux-gnu";
  if (targetId === "linux-arm64-gnu") return "aarch64-unknown-linux-gnu";
  if (targetId === "macos-arm64") return "aarch64-apple-darwin";
  if (targetId === "windows-x64-msvc") return "x86_64-pc-windows-msvc";
  return null;
}

function rustCrateIdent(crateName) {
  return crateName.replaceAll("-", "_");
}

function tomlString(value) {
  return JSON.stringify(value);
}

function localFail(message) {
  fail(TOOL, message);
}

function sha256File(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function npmPlatformConstraints(target) {
  if (target === "linux-x64-gnu") {
    return { os: ["linux"], cpu: ["x64"], libc: ["glibc"] };
  }
  if (target === "linux-arm64-gnu") {
    return { os: ["linux"], cpu: ["arm64"], libc: ["glibc"] };
  }
  if (target === "macos-arm64") {
    return { os: ["darwin"], cpu: ["arm64"] };
  }
  if (target === "windows-x64-msvc") {
    return { os: ["win32"], cpu: ["x64"] };
  }
  return {};
}

function writeJsonFile(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function renderNpmExtensionBundleManifest({ product, version, target, members }) {
  return {
    schema: "oliphaunt-npm-extension-bundle-v1",
    product,
    version,
    family: "native",
    target,
    members,
  };
}

export function renderNpmExtensionContractManifest({ product, version, target, members }) {
  return {
    schema: "oliphaunt-npm-extension-contract-v1",
    product,
    version,
    family: "native",
    target,
    members,
  };
}

function extensionReleaseManifest(extensionDir, product, version) {
  const manifestPath = path.join(extensionDir, "release-assets", `${product}-${version}-manifest.json`);
  return isFile(manifestPath) ? readJsonFile(manifestPath) : {};
}

export function extensionManifestMembers(manifest) {
  if (manifest?.schema === "oliphaunt-extension-ci-artifacts-v1") {
    return typeof manifest.sqlName === "string" && manifest.sqlName
      ? [manifest]
      : [];
  }
  if (manifest?.schema === "oliphaunt-extension-ci-artifacts-v2") {
    return Array.isArray(manifest.extensions) ? manifest.extensions : [];
  }
  return [];
}

const FROZEN_EXTENSION_INVENTORY_LIST_FIELDS = Object.freeze([
  "dependencies",
  "dataFiles",
  "extensionSqlFileNames",
  "extensionSqlFilePrefixes",
  "sharedPreloadLibraries",
]);

/**
 * Return the exact desktop inventory frozen into one product/member release row.
 *
 * Registry materialization deliberately does not consult the repository-wide
 * generated SDK catalog: independently versioned external products must remain
 * bound to the metadata that was qualified and versioned with that product.
 */
export function frozenExtensionMemberInventory(member, { product, version } = {}) {
  const owner = [product, version].every((value) => typeof value === "string" && value.length > 0)
    ? `${product}@${version}`
    : "extension release";
  const sqlName = member?.sqlName;
  if (typeof sqlName !== "string" || sqlName.length === 0) {
    throw new Error(`${TOOL}: ${owner} has an invalid frozen extension sqlName`);
  }
  if (typeof member.createsExtension !== "boolean") {
    throw new Error(`${TOOL}: ${owner}/${sqlName} must freeze createsExtension as a boolean`);
  }
  if (
    member.nativeModuleStem !== null
    && (typeof member.nativeModuleStem !== "string" || member.nativeModuleStem.length === 0)
  ) {
    throw new Error(`${TOOL}: ${owner}/${sqlName} must freeze nativeModuleStem as null or a non-empty string`);
  }
  const inventory = {
    sqlName,
    createsExtension: member.createsExtension,
    nativeModuleStem: member.nativeModuleStem,
  };
  for (const field of FROZEN_EXTENSION_INVENTORY_LIST_FIELDS) {
    const values = member[field];
    if (
      !Array.isArray(values)
      || values.some((value) => typeof value !== "string" || value.length === 0)
    ) {
      throw new Error(`${TOOL}: ${owner}/${sqlName} must freeze ${field} as a string array`);
    }
    const canonical = [...new Set(values)].sort(compareText);
    if (JSON.stringify(values) !== JSON.stringify(canonical)) {
      throw new Error(`${TOOL}: ${owner}/${sqlName} frozen ${field} must be sorted and unique`);
    }
    inventory[field] = canonical;
  }
  if (inventory.dependencies.includes(sqlName)) {
    throw new Error(`${TOOL}: ${owner}/${sqlName} frozen dependencies must exclude itself`);
  }
  return Object.freeze(inventory);
}

const FROZEN_EXTENSION_COMPATIBILITY_FIELDS = Object.freeze([
  "extensionRuntimeContract",
  "nativeRuntimeProduct",
  "nativeRuntimeVersion",
  "postgresMajor",
  "wasixRuntimeProduct",
  "wasixRuntimeVersion",
]);

function frozenExtensionCompatibility(value, label) {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new Error(`${TOOL}: ${label} must freeze extension compatibility as an object`);
  }
  const keys = Object.keys(value).sort(compareText);
  if (JSON.stringify(keys) !== JSON.stringify([...FROZEN_EXTENSION_COMPATIBILITY_FIELDS].sort(compareText))) {
    throw new Error(`${TOOL}: ${label} must freeze the exact extension compatibility fields`);
  }
  if (
    value.postgresMajor !== "18"
    || value.nativeRuntimeProduct !== "liboliphaunt-native"
    || value.wasixRuntimeProduct !== "liboliphaunt-wasix"
    || typeof value.extensionRuntimeContract !== "string"
    || value.extensionRuntimeContract.length === 0
    || !/^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u.test(value.nativeRuntimeVersion ?? "")
    || !/^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u.test(value.wasixRuntimeVersion ?? "")
  ) {
    throw new Error(`${TOOL}: ${label} contains invalid frozen extension compatibility values`);
  }
  return Object.freeze(Object.fromEntries(
    FROZEN_EXTENSION_COMPATIBILITY_FIELDS.map((field) => [field, value[field]]),
  ));
}

function extensionReleaseManifestMembers(manifest) {
  if (manifest?.schema === "oliphaunt-extension-release-manifest-v1") {
    return typeof manifest.sqlName === "string" && manifest.sqlName.length > 0 ? [manifest] : [];
  }
  if (manifest?.schema === "oliphaunt-extension-release-manifest-v2") {
    return Array.isArray(manifest.extensions) ? manifest.extensions : [];
  }
  return [];
}

function sameFrozenValue(left, right) {
  const normalize = (value) => {
    if (Array.isArray(value)) return value.map(normalize);
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(
        Object.keys(value).sort(compareText).map((key) => [key, normalize(value[key])]),
      );
    }
    return value;
  };
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}

function extensionRuntimeAssets(extensionDir, manifest, releaseManifest, target) {
  const { product, version } = manifest;
  const members = extensionManifestMembers(manifest);
  const releaseMembers = extensionReleaseManifestMembers(releaseManifest);
  const bundle = manifest?.schema === "oliphaunt-extension-ci-artifacts-v2";
  const expectedReleaseSchema = bundle
    ? "oliphaunt-extension-release-manifest-v2"
    : "oliphaunt-extension-release-manifest-v1";
  if (
    typeof product !== "string"
    || !product
    || typeof version !== "string"
    || !version
    || members.length === 0
    || releaseManifest?.schema !== expectedReleaseSchema
    || releaseManifest.product !== product
    || releaseManifest.version !== version
    || releaseMembers.length !== members.length
  ) {
    return null;
  }
  const manifestCompatibility = frozenExtensionCompatibility(
    manifest.compatibility,
    `${product}@${version} CI manifest`,
  );
  const releaseCompatibility = frozenExtensionCompatibility(
    releaseManifest.compatibility,
    `${product}@${version} release manifest`,
  );
  if (!sameFrozenValue(manifestCompatibility, releaseCompatibility)) {
    throw new Error(`${TOOL}: ${product}@${version} CI and release compatibility contracts differ`);
  }
  const memberNames = members.map((member) => member?.sqlName);
  const releaseMemberNames = releaseMembers.map((member) => member?.sqlName);
  const canonicalMemberNames = [...new Set(memberNames)].sort(compareText);
  if (
    JSON.stringify(memberNames) !== JSON.stringify(canonicalMemberNames)
    || JSON.stringify(releaseMemberNames) !== JSON.stringify(memberNames)
  ) {
    throw new Error(
      `${TOOL}: ${rel(path.join(extensionDir, "extension-artifacts.json"))} and release manifest must freeze the same sorted unique members`,
    );
  }
  const runtimeMembers = members.map((member, index) => {
    const metadata = frozenExtensionMemberInventory(member, { product, version });
    const releaseMetadata = frozenExtensionMemberInventory(releaseMembers[index], { product, version });
    if (!sameFrozenValue(metadata, releaseMetadata)) {
      throw new Error(`${TOOL}: ${product}@${version}/${member.sqlName} CI and release inventory contracts differ`);
    }
    const matches = Array.isArray(member.assets)
      ? member.assets.filter((asset) => asset?.family === "native" && asset?.kind === "runtime" && asset?.target === target)
      : [];
    const releaseMatches = Array.isArray(releaseMembers[index].assets)
      ? releaseMembers[index].assets.filter((asset) => asset?.family === "native" && asset?.kind === "runtime" && asset?.target === target)
      : [];
    if (matches.length !== 1) {
      return null;
    }
    if (
      releaseMatches.length !== 1
      || !sameFrozenValue(
        extensionRuntimeAssetContract(matches[0]),
        extensionRuntimeAssetContract(releaseMatches[0]),
      )
    ) {
      throw new Error(`${TOOL}: ${product}@${version}/${member.sqlName} CI and release runtime asset contracts differ`);
    }
    return { sqlName: member.sqlName, metadata, asset: matches[0] };
  });
  if (runtimeMembers.some((member) => member === null)) {
    return null;
  }
  if (manifest.schema === "oliphaunt-extension-ci-artifacts-v1") {
    const asset = runtimeMembers[0].asset;
    const assetPath = path.join(extensionDir, "release-assets", asset.name);
    if (!isFile(assetPath) || sha256File(assetPath) !== asset.sha256 || statSync(assetPath).size !== asset.bytes) {
      fail(TOOL, `${product}@${version} ${target} runtime asset is missing or does not match its frozen digest`);
    }
    runtimeMembers[0].archive = assetPath;
    return {
      bundle: false,
      members: runtimeMembers,
      compatibility: manifestCompatibility,
      versioning: releaseManifest.versioning,
    };
  }

  const carrierNames = new Set(runtimeMembers.map(({ asset }) => asset.carrierAsset));
  if (carrierNames.size !== 1 || carrierNames.has(undefined)) {
    fail(TOOL, `${product}@${version} ${target} bundle runtime members must share one aggregate carrier`);
  }
  const carrierName = [...carrierNames][0];
  const carrierRows = Array.isArray(manifest.carrierAssets)
    ? manifest.carrierAssets.filter((carrier) => carrier?.name === carrierName && carrier.family === "native" && carrier.target === target)
    : [];
  if (carrierRows.length !== 1) {
    fail(TOOL, `${product}@${version} ${target} bundle must declare exactly one aggregate carrier row`);
  }
  const carrier = carrierRows[0];
  const releaseCarrierRows = Array.isArray(releaseManifest.assets)
    ? releaseManifest.assets.filter((row) => row?.name === carrierName && row.family === "native" && row.target === target)
    : [];
  if (
    releaseCarrierRows.length !== 1
    || !sameFrozenValue(
      extensionRuntimeAssetContract(carrier),
      extensionRuntimeAssetContract(releaseCarrierRows[0]),
    )
  ) {
    throw new Error(`${TOOL}: ${product}@${version} CI and release aggregate carrier contracts differ`);
  }
  const carrierPath = path.join(extensionDir, "release-assets", carrierName);
  if (!isFile(carrierPath) || statSync(carrierPath).size !== carrier.bytes || sha256File(carrierPath) !== carrier.sha256) {
    fail(TOOL, `${product}@${version} ${target} aggregate carrier is missing or does not match its frozen outer digest`);
  }
  return {
    bundle: true,
    members: runtimeMembers,
    carrier,
    carrierPath,
    compatibility: manifestCompatibility,
    versioning: releaseManifest.versioning,
  };
}

function checkedArchiveMemberPath(name, archive) {
  const normalized = String(name).replaceAll("\\", "/");
  if (!normalized || normalized === "." || normalized === "./" || normalized.startsWith("/") || normalized.includes("\0")) {
    fail(TOOL, `${rel(archive)} contains unsafe archive member ${JSON.stringify(name)}`);
  }
  const parts = normalized.split("/").filter((part) => part && part !== ".");
  if (parts.length === 0 || parts.includes("..")) {
    fail(TOOL, `${rel(archive)} contains unsafe archive member ${JSON.stringify(name)}`);
  }
  return parts.join("/");
}

function extractExtensionRuntime(asset, runtimeDir, { metadata, target, nativeRuntimeVersion }) {
  // Native release assets are stripped and platform-validated on their target
  // builders. Registry carrier assembly must preserve those qualified bytes;
  // host-side binary rewriting would make candidates coordinator-dependent.
  let validated;
  try {
    validated = validateExtensionArtifactArchive({
      file: asset,
      label: rel(asset),
      metadata,
      target,
      nativeRuntimeVersion,
    });
  } catch (error) {
    throw new Error(
      `${TOOL}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  rmSync(runtimeDir, { recursive: true, force: true });
  for (const row of validated.runtimeFiles) {
    const archivePath = `files/${row.path}`;
    const entry = validated.entries.get(archivePath);
    if (entry === undefined) {
      fail(TOOL, `${rel(asset)} validated runtime inventory lost ${archivePath}`);
    }
    const destination = path.join(runtimeDir, ...row.path.split("/"));
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, entry.data, { flag: "wx", mode: entry.mode });
    chmodSync(destination, entry.mode);
  }
  return validated.runtimeFiles;
}

function assertRegularArchiveMember(archive, member) {
  const result = spawnSync("tar", ["-tvf", archive, member], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: MAX_COMMAND_CAPTURE_BYTES,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) {
    fail(TOOL, `inspect ${member} in ${rel(archive)} failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = String(result.stderr ?? result.stdout ?? "").trim();
    fail(TOOL, `inspect ${member} in ${rel(archive)} failed${detail ? `: ${detail}` : ""}`);
  }
  const entries = String(result.stdout ?? "").split(/\r?\n/u).filter(Boolean);
  if (entries.length !== 1 || !entries[0].startsWith("-")) {
    fail(TOOL, `${rel(archive)} member ${member} must be exactly one regular file`);
  }
}

function extractArchiveMemberToFile(archive, member, destination) {
  assertRegularArchiveMember(archive, member);
  mkdirSync(path.dirname(destination), { recursive: true });
  let descriptor;
  let result;
  try {
    descriptor = openSync(
      destination,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    result = spawnSync("tar", ["-xOf", archive, member], {
      cwd: ROOT,
      encoding: "buffer",
      maxBuffer: MAX_COMMAND_CAPTURE_BYTES,
      // Stream the binary member directly to the exclusively created regular
      // file. Capturing stdout would inherit Node's small maxBuffer and makes
      // legitimate nested extension archives fail once they exceed ~1 MiB.
      stdio: ["ignore", descriptor, "pipe"],
    });
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  if (result?.error) {
    rmSync(destination, { force: true });
    fail(TOOL, `read ${member} from ${rel(archive)} failed to start: ${result.error.message}`);
  }
  if (result?.status !== 0) {
    const detail = Buffer.from(result?.stderr ?? "").toString("utf8").trim();
    rmSync(destination, { force: true });
    fail(TOOL, `read ${member} from ${rel(archive)} failed${detail ? `: ${detail}` : ""}`);
  }
  const metadata = lstatSync(destination);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    rmSync(destination, { force: true });
    fail(TOOL, `extracted ${member} from ${rel(archive)} is not a regular non-symlink file`);
  }
}

function materializeBundleMemberArchive(runtimeSet, member, destination) {
  const { asset, sqlName } = member;
  const expectedRoot = runtimeSet.carrier.name.replace(/\.tar\.gz$/u, "");
  const expectedMemberPath = `extensions/${sqlName}/${asset.name}`;
  if (asset.carrierRoot !== expectedRoot || asset.memberPath !== expectedMemberPath) {
    fail(TOOL, `${runtimeSet.carrier.name} has a noncanonical nested locator for ${sqlName}`);
  }
  const composed = checkedArchiveMemberPath(`${asset.carrierRoot}/${asset.memberPath}`, runtimeSet.carrierPath);
  const listed = runArchiveCommand(["tar", "-tf", runtimeSet.carrierPath], `list ${rel(runtimeSet.carrierPath)}`)
    .split(/\r?\n/u)
    .map((name) => name.trim())
    .filter(Boolean)
    .map((name) => checkedArchiveMemberPath(name, runtimeSet.carrierPath));
  if (listed.filter((name) => name === composed).length !== 1) {
    fail(TOOL, `${rel(runtimeSet.carrierPath)} must contain nested member ${composed} exactly once`);
  }
  extractArchiveMemberToFile(runtimeSet.carrierPath, composed, destination);
  const bytes = statSync(destination).size;
  const digest = sha256File(destination);
  if (bytes !== asset.bytes || digest !== asset.sha256) {
    rmSync(destination, { force: true });
    fail(TOOL, `${rel(runtimeSet.carrierPath)} nested member ${composed} does not match its frozen size/digest`);
  }
  chmodSync(destination, 0o644);
  return destination;
}

function extensionModuleDirectory(runtimeDir) {
  for (const candidate of [
    path.join(runtimeDir, "lib", "modules"),
    path.join(runtimeDir, "lib", "postgresql"),
  ]) {
    if (!isDirectory(candidate)) continue;
    for (const file of readdirSync(candidate).sort(compareText)) {
      const fullPath = path.join(candidate, file);
      if (isFile(fullPath) && [".so", ".dylib", ".dll"].includes(path.extname(file).toLowerCase())) {
        return candidate;
      }
    }
  }
  return null;
}

function writeExtensionReadme(packageDir, packageName, members, target) {
  const targetText = target === null ? "" : ` for \`${target}\``;
  const memberText = members.length === 1
    ? `the \`${members[0]}\` PostgreSQL extension`
    : `${members.length} PostgreSQL contrib extensions`;
  const selectionExample = members.length === 1 ? members[0] : members.slice(0, 2).join("', '");
  writeFileSync(
    path.join(packageDir, "README.md"),
    [
      `# ${packageName}`,
      "",
      `Oliphaunt registry package for ${memberText}${targetText}.`,
      "",
      "This package is consumed by `@oliphaunt/ts` when an application opens a database with",
      `\`extensions: ['${selectionExample}']\`.`,
      "",
    ].join("\n"),
  );
}

function writeExtensionMetaPackage(packageDir, {
  product,
  version,
  members,
  target,
  targets = [target],
  iosCarrier,
  liboliphauntVersion,
  runtimeBound,
}) {
  const bundle = members.length > 1;
  const packageName = extensionNpmPackageForProduct(product);
  const targetPackageNames = Object.fromEntries(
    targets
      .filter((item) => typeof item === "string" && item.length > 0)
      .sort(compareText)
      .map((item) => [item, extensionNpmTargetPackageForProduct(product, item)]),
  );
  mkdirSync(packageDir, { recursive: true });
  writeExtensionReadme(packageDir, packageName, members, null);
  writeJsonFile(path.join(packageDir, IOS_CARRIER_FILENAME), iosCarrier);
  writeJsonFile(path.join(packageDir, "package.json"), {
    name: packageName,
    version,
    description: bundle
      ? `Oliphaunt PostgreSQL contrib extension bundle (${members.length} exact members).`
      : `Oliphaunt extension package for PostgreSQL ${members[0]}.`,
    license: "MIT AND Apache-2.0 AND PostgreSQL",
    type: "module",
    repository: { type: "git", url: NPM_TRUSTED_PUBLISHING_REPOSITORY },
    optionalDependencies: Object.fromEntries(Object.values(targetPackageNames).map((name) => [name, version])),
    oliphaunt: {
      product,
      kind: bundle ? "exact-extension-bundle" : "exact-extension",
      ...(bundle ? {} : { sqlName: members[0] }),
      members,
      targetPackageNames,
      iosCarrierManifest: `./${IOS_CARRIER_FILENAME}`,
      liboliphauntVersion,
      runtimeBound,
    },
    publishConfig: { access: "public", provenance: true },
    files: ["README.md", IOS_CARRIER_FILENAME],
    exports: {
      "./ios-carriers": `./${IOS_CARRIER_FILENAME}`,
      "./package.json": "./package.json",
    },
  });
}

function writeExtensionTargetPackage(packageDir, {
  product,
  version,
  members,
  memberContracts,
  target,
  liboliphauntVersion,
  memberRuntimeRelativePaths = null,
  memberModuleRelativePaths = null,
}) {
  const bundle = members.length > 1;
  if (
    !Array.isArray(memberContracts)
    || JSON.stringify(memberContracts.map((contract) => contract?.sqlName)) !== JSON.stringify(members)
  ) {
    fail(TOOL, `${product}@${version} target package member contracts must exactly match its members`);
  }
  const packageName = extensionNpmTargetPackageForProduct(product, target);
  const runtimeDir = bundle ? null : path.join(packageDir, "runtime");
  const moduleDir = runtimeDir === null ? null : extensionModuleDirectory(runtimeDir);
  const metadata = {
    product,
    kind: bundle ? "exact-extension-bundle-target" : "exact-extension-target",
    ...(bundle ? {} : { sqlName: members[0] }),
    members,
    extensionContract: NPM_EXTENSION_CONTRACT_FILENAME,
    target,
    ...(bundle
      ? {
          bundleManifest: "bundle-manifest.json",
          memberRuntimeRelativePaths,
          ...(memberModuleRelativePaths !== null && Object.keys(memberModuleRelativePaths).length > 0
            ? { memberModuleRelativePaths }
            : {}),
        }
      : { runtimeRelativePath: "runtime" }),
    liboliphauntVersion,
  };
  if (moduleDir !== null) {
    metadata.moduleRelativePath = path.relative(packageDir, moduleDir).split(path.sep).join("/");
  }
  mkdirSync(packageDir, { recursive: true });
  writeExtensionReadme(packageDir, packageName, members, target);
  writeJsonFile(
    path.join(packageDir, NPM_EXTENSION_CONTRACT_FILENAME),
    renderNpmExtensionContractManifest({ product, version, target, members: memberContracts }),
  );
  writeJsonFile(path.join(packageDir, "package.json"), {
    name: packageName,
    version,
    description: bundle
      ? `${target} Oliphaunt runtime bundle for ${members.length} exact PostgreSQL contrib extensions.`
      : `${target} Oliphaunt extension runtime package for PostgreSQL ${members[0]}.`,
    license: "MIT AND Apache-2.0 AND PostgreSQL",
    type: "module",
    repository: { type: "git", url: NPM_TRUSTED_PUBLISHING_REPOSITORY },
    ...npmPlatformConstraints(target),
    optional: true,
    oliphaunt: metadata,
    publishConfig: { access: "public", provenance: true },
    files: bundle
      ? ["extensions", "bundle-manifest.json", NPM_EXTENSION_CONTRACT_FILENAME, "README.md"]
      : ["runtime", NPM_EXTENSION_CONTRACT_FILENAME, "README.md"],
    exports: {
      ...(bundle ? { "./bundle-manifest": "./bundle-manifest.json" } : {}),
      "./extension-contract": `./${NPM_EXTENSION_CONTRACT_FILENAME}`,
      "./package.json": "./package.json",
    },
  });
}

function npmPackageSizeSafe(tarball, result) {
  const size = statSync(tarball).size;
  if (size <= NPM_PACKAGE_SAFETY_LIMIT_BYTES) {
    return true;
  }
  result.skipped.push(`${rel(tarball)} is ${size} bytes, exceeding the 100 MiB release safety limit`);
  rmSync(tarball, { force: true });
  return false;
}

export function stageExtensionNpmPackages(roots, stagingRoot, target, result, options = {}) {
  const manifests = discoverExtensionManifests(roots);
  if (manifests.length === 0) {
    result.skipped.push("no extension-artifacts.json manifests found for npm extension packages");
    return null;
  }
  if (target === null) {
    result.skipped.push("current host does not map to a supported npm extension target");
    return null;
  }

  rmSync(stagingRoot, { recursive: true, force: true });
  const packageRoot = path.join(stagingRoot, "packages");
  const tarballRoot = path.join(stagingRoot, "tarballs");
  let stagedAny = false;
  const stagedIdentities = new Map();

  for (const manifestPath of manifests) {
    const manifest = readJsonFile(manifestPath);
    const extensionDir = path.dirname(manifestPath);
    const { product, version } = manifest;
    const members = extensionManifestMembers(manifest).map((member) => member.sqlName);
    if (![product, version].every((value) => typeof value === "string" && value.length > 0) || members.length === 0) {
      result.skipped.push(`${rel(manifestPath)} is missing product, version, or exact member rows`);
      continue;
    }
    const releaseManifest = extensionReleaseManifest(extensionDir, product, version);
    const expectedReleaseSchema = members.length > 1
      ? "oliphaunt-extension-release-manifest-v2"
      : "oliphaunt-extension-release-manifest-v1";
    if (
      releaseManifest.schema !== expectedReleaseSchema
      || releaseManifest.product !== product
      || releaseManifest.version !== version
    ) {
      result.skipped.push(`${product}@${version} is missing its exact ${expectedReleaseSchema} release manifest`);
      continue;
    }
    const runtimeSet = extensionRuntimeAssets(extensionDir, manifest, releaseManifest, target);
    if (runtimeSet === null) {
      result.skipped.push(`${product}@${version} has no complete ${target} native runtime member set`);
      continue;
    }
    const compatibility = runtimeSet.compatibility;
    const liboliphauntVersion = compatibility.nativeRuntimeVersion;
    const runtimeBound = runtimeSet.versioning === "runtime-bound";
    if (runtimeBound && version !== liboliphauntVersion) {
      fail(TOOL, `${product}@${version} is runtime-bound but declares liboliphauntVersion=${liboliphauntVersion}`);
    }
    const identity = `${product}@${version}:${target}`;
    const identityDigest = JSON.stringify({
      release: createHash("sha256").update(JSON.stringify(releaseManifest)).digest("hex"),
      members: runtimeSet.members.map(({ metadata, asset }) => ({
        metadata,
        sha256: asset.sha256,
        bytes: asset.bytes,
      })),
      carrier: runtimeSet.carrier === undefined
        ? null
        : { sha256: runtimeSet.carrier.sha256, bytes: runtimeSet.carrier.bytes },
    });
    const previousIdentityDigest = stagedIdentities.get(identity);
    if (previousIdentityDigest !== undefined) {
      if (previousIdentityDigest !== identityDigest) {
        fail(TOOL, `conflicting exact extension candidates discovered for ${identity}`);
      }
      result.skipped.push(`deduplicated byte-identical extension candidate ${identity} from ${rel(manifestPath)}`);
      continue;
    }
    stagedIdentities.set(identity, identityDigest);

    const metaDir = path.join(packageRoot, safeNpmPackageFilenamePrefix(extensionNpmPackageForProduct(product)));
    const targetDir = path.join(packageRoot, safeNpmPackageFilenamePrefix(extensionNpmTargetPackageForProduct(product, target)));
    const memberRuntimeRelativePaths = {};
    const memberModuleRelativePaths = {};
    const bundleManifestMembers = [];
    if (runtimeSet.bundle) {
      for (const member of runtimeSet.members) {
        const archiveRelativePath = `extensions/${member.sqlName}/${member.asset.name}`;
        const archive = materializeBundleMemberArchive(
          runtimeSet,
          member,
          path.join(targetDir, ...archiveRelativePath.split("/")),
        );
        const runtimeRelativePath = `extensions/${member.sqlName}/runtime`;
        const runtimeDir = path.join(targetDir, ...runtimeRelativePath.split("/"));
        extractExtensionRuntime(archive, runtimeDir, {
          metadata: member.metadata,
          target,
          nativeRuntimeVersion: liboliphauntVersion,
        });
        if (walkFiles(runtimeDir).length === 0) {
          fail(TOOL, `${product}@${version} produced an empty ${target} npm runtime payload for ${member.sqlName}`);
        }
        memberRuntimeRelativePaths[member.sqlName] = runtimeRelativePath;
        const moduleDir = extensionModuleDirectory(runtimeDir);
        const moduleRelativePath = moduleDir === null
          ? null
          : path.relative(targetDir, moduleDir).split(path.sep).join("/");
        if (moduleRelativePath !== null) {
          memberModuleRelativePaths[member.sqlName] = moduleRelativePath;
        }
        if (!Object.hasOwn(member.asset, "identity") || member.asset.identity !== null) {
          fail(
            TOOL,
            `${product}@${version} ${target} runtime member ${member.sqlName} must declare identity=null`,
          );
        }
        bundleManifestMembers.push({
          sqlName: member.sqlName,
          kind: member.asset.kind,
          identity: null,
          path: archiveRelativePath,
          sha256: member.asset.sha256,
          bytes: member.asset.bytes,
          runtimeRelativePath,
          ...(moduleRelativePath === null ? {} : { moduleRelativePath }),
        });
      }
      writeJsonFile(
        path.join(targetDir, "bundle-manifest.json"),
        renderNpmExtensionBundleManifest({
          product,
          version,
          target,
          members: bundleManifestMembers,
        }),
      );
    } else {
      const runtimeDir = path.join(targetDir, "runtime");
      extractExtensionRuntime(runtimeSet.members[0].archive, runtimeDir, {
        metadata: runtimeSet.members[0].metadata,
        target,
        nativeRuntimeVersion: liboliphauntVersion,
      });
      if (walkFiles(runtimeDir).length === 0) {
        result.skipped.push(`${product}@${version} produced an empty ${target} npm runtime payload`);
        continue;
      }
    }
    const metaTargets = typeof options.metaTargetsForProduct === "function"
      ? options.metaTargetsForProduct(product)
      : options.metaTargets;
    const iosCarrier = buildIosCarrierManifest({
      baseAssetDir: options.baseAssetDir
        ?? path.join(ROOT, "target/liboliphaunt/release-assets"),
      baseCarrierManifest: options.baseCarrierManifest,
      extensionManifests: [manifestPath],
    });
    writeExtensionMetaPackage(metaDir, {
      product,
      version,
      members,
      target,
      targets: metaTargets ?? [target],
      iosCarrier,
      liboliphauntVersion,
      runtimeBound,
    });
    writeExtensionTargetPackage(targetDir, {
      product,
      version,
      members,
      memberContracts: runtimeSet.members.map(({ metadata }) => metadata),
      target,
      liboliphauntVersion,
      memberRuntimeRelativePaths: runtimeSet.bundle ? memberRuntimeRelativePaths : null,
      memberModuleRelativePaths: runtimeSet.bundle ? memberModuleRelativePaths : null,
    });
    const targetTarball = pnpmPackForNpmPublish(targetDir, tarballRoot);
    if (!npmPackageSizeSafe(targetTarball, result)) {
      continue;
    }
    const metaTarball = pnpmPackForNpmPublish(metaDir, tarballRoot);
    if (!npmPackageSizeSafe(metaTarball, result)) {
      rmSync(targetTarball, { force: true });
      continue;
    }
    result.staged.push(rel(targetTarball));
    result.staged.push(rel(metaTarball));
    stagedAny = true;
  }

  return stagedAny ? tarballRoot : null;
}


function writeNativeExtensionCargoPartCrate(crateDir, { product, version, members, target, index }) {
  const name = nativeExtensionCargoPartPackageName(product, target, index);
  const subject = members.length === 1 ? members[0] : `${members.length}-member bundle`;
  mkdirSync(path.join(crateDir, "src"), { recursive: true });
  writeFileSync(
    path.join(crateDir, "Cargo.toml"),
    `[package]
name = "${name}"
version = "${version}"
edition = "2024"
rust-version = "1.93"
description = "Cargo payload part ${String(index).padStart(3, "0")} for the ${subject} Oliphaunt native extension carrier on ${target}."
readme = "README.md"
repository = "https://github.com/f0rr0/oliphaunt"
homepage = "https://oliphaunt.dev"
license = "MIT AND Apache-2.0 AND PostgreSQL"
include = ["Cargo.toml", "README.md", "src/**", "payload/**"]

[lib]
path = "src/lib.rs"

[workspace]
`,
  );
  writeFileSync(
    path.join(crateDir, "README.md"),
    `# ${name}

Cargo payload part for the ${subject} Oliphaunt native extension carrier on \`${target}\`.
Applications do not depend on this crate directly.
`,
  );
  writeFileSync(
    path.join(crateDir, "src/lib.rs"),
    `pub const PRODUCT: &str = "${product}";
pub const KIND: &str = "extension-part";
pub const MEMBERS: &[&str] = &[${members.map((member) => JSON.stringify(member)).join(", ")}];
pub const RELEASE_TARGET: &str = "${target}";
pub const PART_INDEX: usize = ${index};
pub const PAYLOAD_ROOT: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/payload");
`,
  );
}

function writeChunk(file, data) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, data);
}

function copyPayloadFile(source, destination) {
  mkdirSync(path.dirname(destination), { recursive: true });
  copyFileSync(source, destination);
}

function buildNativeExtensionPartCrates(runtimeDir, sourceRoot, {
  product,
  version,
  members,
  target,
  partBytes = CARGO_EXTENSION_PART_BYTES,
}) {
  const partDirs = [];
  let currentDir = null;
  let currentSize = 0;

  const startPart = () => {
    const index = partDirs.length + 1;
    if (index > 999) {
      throw new Error(`${product}@${version} requires more than 999 Cargo payload parts for ${target}`);
    }
    const partDir = path.join(sourceRoot, nativeExtensionCargoPartPackageName(product, target, index));
    writeNativeExtensionCargoPartCrate(partDir, { product, version, members, target, index });
    partDirs.push(partDir);
    return partDir;
  };

  for (const source of walkFiles(runtimeDir)) {
    const relative = path.relative(runtimeDir, source).split(path.sep).join("/");
    const size = statSync(source).size;
    if (size > partBytes) {
      currentDir = null;
      currentSize = 0;
      const fd = openSync(source, "r");
      try {
        let partIndex = 0;
        let offset = 0;
        while (offset < size) {
          const length = Math.min(partBytes, size - offset);
          const buffer = Buffer.allocUnsafe(length);
          const bytesRead = readSync(fd, buffer, 0, length, offset);
          if (bytesRead <= 0) {
            break;
          }
          const partDir = startPart();
          writeChunk(
            path.join(partDir, "payload", "chunks", `${relative}.part${String(partIndex).padStart(3, "0")}`),
            buffer.subarray(0, bytesRead),
          );
          offset += bytesRead;
          partIndex += 1;
        }
      } finally {
        closeSync(fd);
      }
      continue;
    }
    if (currentDir === null || currentSize + size > partBytes) {
      currentDir = startPart();
      currentSize = 0;
    }
    copyPayloadFile(source, path.join(currentDir, "payload", "files", relative));
    currentSize += size;
  }

  if (partDirs.length === 0) {
    throw new Error(`${product}@${version} generated no native extension Cargo part crates`);
  }
  return partDirs;
}

const NATIVE_EXTENSION_AGGREGATOR_BUILD_RS = String.raw`use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::env;
use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};

const SCHEMA: &str = __SCHEMA__;
const PRODUCT: &str = __PRODUCT__;
const VERSION: &str = env!("CARGO_PKG_VERSION");
const KIND: &str = "extension";
const TARGET: &str = __TARGET__;
const RUNTIME_PRODUCT: &str = __RUNTIME_PRODUCT__;
const RUNTIME_VERSION: &str = __RUNTIME_VERSION__;
const EXTENSIONS: &[&str] = &[
__EXTENSIONS__
];
const EXTENSION_DEPENDENCIES: &[(&str, &[&str])] = &[
__EXTENSION_DEPENDENCIES__
];
const PART_ROOTS: &[&str] = &[
__PART_ROOTS__
];

fn main() {
    emit_manifest();
}

fn emit_manifest() {
    let out_dir = PathBuf::from(env::var_os("OUT_DIR").expect("OUT_DIR is set"));
    let payload = out_dir.join("payload");
    if payload.exists() {
        fs::remove_dir_all(&payload).expect("remove stale Oliphaunt extension payload");
    }
    fs::create_dir_all(&payload).expect("create Oliphaunt extension payload directory");

    let part_roots = part_roots();
    if part_roots.is_empty() {
        if env::var_os("OLIPHAUNT_ARTIFACT_CRATE_REQUIRE_PAYLOAD").is_some() {
            panic!("missing Oliphaunt extension payload part crates");
        }
        return;
    }

    let mut chunk_files: BTreeMap<String, Vec<(usize, PathBuf)>> = BTreeMap::new();
    for root in part_roots {
        println!("cargo::rerun-if-changed={}", root.display());
        copy_complete_files(&root.join("files"), &payload).expect("copy complete extension payload files");
        collect_chunks(&root.join("chunks"), &root.join("chunks"), &mut chunk_files)
            .expect("collect extension payload chunks");
    }

    for (relative, mut chunks) in chunk_files {
        chunks.sort_by_key(|(index, _)| *index);
        for (expected, (actual, _)) in chunks.iter().enumerate() {
            if *actual != expected {
                panic!("non-contiguous Oliphaunt extension chunk indexes for {relative}");
            }
        }
        let output = payload.join(&relative);
        if let Some(parent) = output.parent() {
            fs::create_dir_all(parent).expect("create reconstructed extension file parent");
        }
        let mut writer = fs::File::create(&output).expect("create reconstructed extension payload file");
        for (_, path) in chunks {
            let mut reader = fs::File::open(&path).expect("open extension payload chunk");
            io::copy(&mut reader, &mut writer).expect("append extension payload chunk");
        }
    }

    let files = collect_files(&payload).expect("collect reconstructed extension payload files");
    if files.is_empty() {
        panic!("Oliphaunt extension payload part crates produced no files");
    }
    let manifest = out_dir.join("oliphaunt-artifact.toml");
    let mut text = format!(
        "schema = {SCHEMA:?}\nproduct = {PRODUCT:?}\nversion = {VERSION:?}\nkind = {KIND:?}\ntarget = {TARGET:?}\nruntime-product = {RUNTIME_PRODUCT:?}\nruntime-version = {RUNTIME_VERSION:?}\n"
    );
    if SCHEMA == "oliphaunt-artifact-manifest-v1" {
        if EXTENSIONS.len() != 1 {
            panic!("v1 extension manifest requires exactly one member");
        }
        text.push_str(&format!("extension = {:?}\n", EXTENSIONS[0]));
        append_dependencies(&mut text, EXTENSIONS[0]);
        append_manifest_files(&mut text, &payload, "[[files]]");
    } else if SCHEMA == "oliphaunt-artifact-manifest-v2" {
        let extensions_root = payload.join("extensions");
        let actual_members = directory_names(&extensions_root).expect("read reconstructed extension bundle members");
        let expected_members: Vec<String> = EXTENSIONS.iter().map(|value| (*value).to_owned()).collect();
        if actual_members != expected_members {
            panic!("reconstructed extension bundle member set mismatch: expected {expected_members:?}, got {actual_members:?}");
        }
        for extension in EXTENSIONS {
            text.push_str(&format!("\n[[extensions]]\nextension = {extension:?}\n"));
            append_dependencies(&mut text, extension);
            append_manifest_files(&mut text, &extensions_root.join(extension), "[[extensions.files]]");
        }
    } else {
        panic!("unsupported extension artifact manifest schema {SCHEMA}");
    }
    fs::write(&manifest, text).expect("write Oliphaunt extension artifact manifest");
    println!("cargo::metadata=manifest={}", manifest.display());
}

fn append_dependencies(text: &mut String, extension: &str) {
    let dependencies = EXTENSION_DEPENDENCIES.iter()
        .find(|(candidate, _)| *candidate == extension)
        .map(|(_, dependencies)| *dependencies)
        .unwrap_or_else(|| panic!("missing dependency metadata for extension {extension}"));
    text.push_str(&format!("dependencies = {dependencies:?}\n"));
}

fn append_manifest_files(text: &mut String, root: &Path, table: &str) {
    let files = collect_files(root).expect("collect extension member payload files");
    if files.is_empty() {
        panic!("Oliphaunt extension member payload produced no files under {}", root.display());
    }
    for file in files {
        let relative = file.strip_prefix(root)
            .expect("payload file stays under member root")
            .to_string_lossy()
            .replace(std::path::MAIN_SEPARATOR, "/");
        let sha256 = sha256_file(&file).expect("hash extension payload file");
        text.push_str(&format!(
            "\n{table}\nsource = {:?}\nrelative = {:?}\nsha256 = {:?}\nexecutable = false\n",
            file.display().to_string(), relative, sha256,
        ));
    }
}

fn directory_names(root: &Path) -> io::Result<Vec<String>> {
    let mut names = Vec::new();
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        if entry.file_type()?.is_dir() {
            names.push(entry.file_name().to_string_lossy().into_owned());
        }
    }
    names.sort();
    Ok(names)
}

fn part_roots() -> Vec<PathBuf> {
    PART_ROOTS.iter().map(PathBuf::from).collect()
}

fn copy_complete_files(source: &Path, destination: &Path) -> io::Result<()> {
    if !source.is_dir() {
        return Ok(());
    }
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let path = entry.path();
        let output = destination.join(path.strip_prefix(source).unwrap_or(&path));
        copy_tree_entry(&path, &output)?;
    }
    Ok(())
}

fn copy_tree_entry(source: &Path, destination: &Path) -> io::Result<()> {
    let metadata = fs::metadata(source)?;
    if metadata.is_dir() {
        fs::create_dir_all(destination)?;
        for entry in fs::read_dir(source)? {
            let entry = entry?;
            copy_tree_entry(&entry.path(), &destination.join(entry.file_name()))?;
        }
    } else if metadata.is_file() {
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::copy(source, destination)?;
    }
    Ok(())
}

fn collect_chunks(
    root: &Path,
    current: &Path,
    chunks: &mut BTreeMap<String, Vec<(usize, PathBuf)>>,
) -> io::Result<()> {
    if !current.is_dir() {
        return Ok(());
    }
    for entry in fs::read_dir(current)? {
        let entry = entry?;
        let path = entry.path();
        let metadata = fs::metadata(&path)?;
        if metadata.is_dir() {
            collect_chunks(root, &path, chunks)?;
            continue;
        }
        if !metadata.is_file() {
            continue;
        }
        let relative = path.strip_prefix(root).unwrap_or(&path).to_string_lossy().replace(std::path::MAIN_SEPARATOR, "/");
        let (file_relative, part_index) = split_part_relative(&relative)
            .unwrap_or_else(|| panic!("invalid Oliphaunt extension chunk file name {relative}"));
        chunks.entry(file_relative).or_default().push((part_index, path));
    }
    Ok(())
}

fn split_part_relative(relative: &str) -> Option<(String, usize)> {
    let (file, index) = relative.rsplit_once(".part")?;
    if file.is_empty() || index.len() != 3 || !index.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    Some((file.to_owned(), index.parse().ok()?))
}

fn collect_files(root: &Path) -> io::Result<Vec<PathBuf>> {
    let mut files = Vec::new();
    collect_files_inner(root, &mut files)?;
    files.sort();
    Ok(files)
}

fn collect_files_inner(path: &Path, files: &mut Vec<PathBuf>) -> io::Result<()> {
    if !path.is_dir() {
        return Ok(());
    }
    for entry in fs::read_dir(path)? {
        let entry = entry?;
        let entry_path = entry.path();
        let metadata = fs::metadata(&entry_path)?;
        if metadata.is_dir() {
            collect_files_inner(&entry_path, files)?;
        } else if metadata.is_file() {
            files.push(entry_path);
        }
    }
    Ok(())
}

fn sha256_file(path: &Path) -> io::Result<String> {
    let mut file = fs::File::open(path)?;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 1024 * 64];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    let digest = digest.finalize();
    let mut output = String::with_capacity(digest.len() * 2);
    for byte in digest {
        use std::fmt::Write as _;
        let _ = write!(&mut output, "{byte:02x}");
    }
    Ok(output)
}
`;

export function exactNativeExtensionMemberDependencies(members, memberDependencies) {
  if (
    !Array.isArray(members) ||
    members.length === 0 ||
    members.some((member) => typeof member !== "string" || member.length === 0) ||
    new Set(members).size !== members.length
  ) {
    throw new Error(`${TOOL}: native extension members must be a non-empty, unique string list`);
  }
  if (memberDependencies === null || typeof memberDependencies !== "object" || Array.isArray(memberDependencies)) {
    throw new Error(`${TOOL}: native extension member dependencies must be an object keyed by every exact member`);
  }

  const expectedMembers = [...members].sort(compareText);
  const actualMembers = Object.keys(memberDependencies).sort(compareText);
  const missing = expectedMembers.filter((member) => !Object.hasOwn(memberDependencies, member));
  const extra = actualMembers.filter((member) => !expectedMembers.includes(member));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `${TOOL}: native extension member dependency keys must exactly match members; missing=${JSON.stringify(missing)}, extra=${JSON.stringify(extra)}`,
    );
  }

  return members.map((member) => {
    const dependencies = memberDependencies[member];
    if (
      !Array.isArray(dependencies) ||
      dependencies.some((dependency) => typeof dependency !== "string" || dependency.length === 0)
    ) {
      throw new Error(`${TOOL}: native extension member ${member} dependencies must be a string list`);
    }
    const normalized = [...new Set(dependencies)].sort(compareText);
    if (JSON.stringify(normalized) !== JSON.stringify(dependencies) || dependencies.includes(member)) {
      throw new Error(`${TOOL}: native extension member ${member} dependencies must be sorted, unique, and exclude itself`);
    }
    return [member, normalized];
  });
}

function writeNativeExtensionSplitAggregatorCrate(crateDir, {
  product,
  version,
  members,
  memberDependencies,
  target,
  triple,
  runtimeProduct,
  runtimeVersion,
  partDirs,
}) {
  const name = nativeExtensionCargoPackageName(product, target);
  const links = nativeExtensionCargoLinksName(product, target);
  const subject = members.length === 1 ? members[0] : `${members.length}-member bundle`;
  const dependencyRows = exactNativeExtensionMemberDependencies(members, memberDependencies);
  rmSync(path.join(crateDir, "payload"), { recursive: true, force: true });
  const dependencyLines = [];
  const partRoots = [];
  for (let offset = 0; offset < partDirs.length; offset += 1) {
    const dependencyName = nativeExtensionCargoPartPackageName(product, target, offset + 1);
    const dependencyPath = path.relative(crateDir, partDirs[offset]).split(path.sep).join("/");
    dependencyLines.push(`${dependencyName} = { version = "=${version}", path = "${dependencyPath}" }`);
    partRoots.push(`    ${rustCrateIdent(dependencyName)}::PAYLOAD_ROOT,`);
  }
  writeFileSync(
    path.join(crateDir, "Cargo.toml"),
    `[package]
name = "${name}"
version = "${version}"
edition = "2024"
rust-version = "1.93"
description = "Cargo artifact crate for the ${subject} Oliphaunt native extension carrier on ${target}."
readme = "README.md"
repository = "https://github.com/f0rr0/oliphaunt"
homepage = "https://oliphaunt.dev"
license = "MIT AND Apache-2.0 AND PostgreSQL"
links = "${links}"
build = "build.rs"
include = ["Cargo.toml", "README.md", "build.rs", "src/**"]

[lib]
path = "src/lib.rs"

[build-dependencies]
sha2 = "0.10"
${dependencyLines.join("\n")}

[workspace]
`,
  );
  writeFileSync(
    path.join(crateDir, "build.rs"),
    NATIVE_EXTENSION_AGGREGATOR_BUILD_RS
      .replace("__SCHEMA__", tomlString(members.length > 1 ? "oliphaunt-artifact-manifest-v2" : "oliphaunt-artifact-manifest-v1"))
      .replace("__PRODUCT__", tomlString(product))
      .replace("__TARGET__", tomlString(triple))
      .replace("__RUNTIME_PRODUCT__", tomlString(runtimeProduct))
      .replace("__RUNTIME_VERSION__", tomlString(runtimeVersion))
      .replace("__EXTENSIONS__", members.map((member) => `    ${tomlString(member)},`).join("\n"))
      .replace("__EXTENSION_DEPENDENCIES__", dependencyRows.map(([member, dependencies]) => `    (${tomlString(member)}, &[${dependencies.map((dependency) => tomlString(dependency)).join(", ")}]),`).join("\n"))
      .replace("__PART_ROOTS__", partRoots.join("\n")),
  );
}

function cargoPackage(crateDir, targetDir, { noVerify = false } = {}) {
  const manifest = path.join(crateDir, "Cargo.toml");
  const { name, version } = readCargoPackageNameVersion(manifest, { fail: localFail, rel });
  const command = [
    "cargo",
    "package",
    "--manifest-path",
    manifest,
    "--target-dir",
    targetDir,
    "--allow-dirty",
  ];
  if (noVerify) {
    command.push("--no-verify");
  }
  const result = spawnSync(command[0], command.slice(1), {
    cwd: ROOT,
    env: { ...process.env, OLIPHAUNT_ARTIFACT_CRATE_REQUIRE_PAYLOAD: "1" },
    stdio: "inherit",
  });
  if (result.error) {
    fail(TOOL, `${command[0]} failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    fail(TOOL, `${command[0]} failed with exit code ${result.status ?? 1}`);
  }
  const cratePath = path.join(targetDir, "package", `${name}-${version}.crate`);
  if (!isFile(cratePath)) {
    fail(TOOL, `cargo package did not create ${rel(cratePath)}`);
  }
  return cratePath;
}

function discardCargoPackageArtifact(cratePath) {
  rmSync(cratePath, { force: true });
  rmSync(path.join(path.dirname(cratePath), "tmp-crate", path.basename(cratePath)), { force: true });
}

function stageNativeExtensionCargoPayload(crateDir, runtimeSet, { target, nativeRuntimeVersion }) {
  const payload = path.join(crateDir, "payload");
  rmSync(payload, { recursive: true, force: true });
  if (!runtimeSet.bundle) {
    extractExtensionRuntime(runtimeSet.members[0].archive, payload, {
      metadata: runtimeSet.members[0].metadata,
      target,
      nativeRuntimeVersion,
    });
    return payload;
  }
  const temp = archiveTempDir();
  try {
    for (const member of runtimeSet.members) {
      const archive = materializeBundleMemberArchive(
        runtimeSet,
        member,
        path.join(temp, `${member.sqlName}.tar.gz`),
      );
      extractExtensionRuntime(archive, path.join(payload, "extensions", member.sqlName), {
        metadata: member.metadata,
        target,
        nativeRuntimeVersion,
      });
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
  return payload;
}

function writeNativeExtensionCargoCrate(crateDir, {
  product,
  version,
  members,
  memberDependencies,
  target,
  triple,
  runtimeProduct,
  runtimeVersion,
  runtimeSet,
}) {
  const name = nativeExtensionCargoPackageName(product, target);
  const links = nativeExtensionCargoLinksName(product, target);
  const subject = members.length === 1 ? members[0] : `${members.length}-member bundle`;
  const dependencyRows = exactNativeExtensionMemberDependencies(members, memberDependencies);
  const runtimeDir = stageNativeExtensionCargoPayload(crateDir, runtimeSet, {
    target,
    nativeRuntimeVersion: runtimeVersion,
  });
  if (walkFiles(runtimeDir).length === 0) {
    throw new Error(`${product}@${version} did not contain extension runtime files`);
  }
  mkdirSync(path.join(crateDir, "src"), { recursive: true });
  writeFileSync(
    path.join(crateDir, "README.md"),
    `# ${name}

Cargo artifact crate for the ${subject} Oliphaunt native extension carrier on \`${target}\`.
`,
  );
  writeFileSync(
    path.join(crateDir, "Cargo.toml"),
    `[package]
name = "${name}"
version = "${version}"
edition = "2024"
rust-version = "1.93"
description = "Cargo artifact crate for the ${subject} Oliphaunt native extension carrier on ${target}."
readme = "README.md"
repository = "https://github.com/f0rr0/oliphaunt"
homepage = "https://oliphaunt.dev"
license = "MIT AND Apache-2.0 AND PostgreSQL"
links = "${links}"
build = "build.rs"
include = ["Cargo.toml", "README.md", "build.rs", "src/**", "payload/**"]

[lib]
path = "src/lib.rs"

[build-dependencies]
sha2 = "0.10"

[workspace]
`,
  );
  writeFileSync(
    path.join(crateDir, "src/lib.rs"),
    `pub const PRODUCT: &str = "${product}";
pub const KIND: &str = "extension";
pub const MEMBERS: &[&str] = &[${members.map((member) => JSON.stringify(member)).join(", ")}];
pub const RELEASE_TARGET: &str = "${target}";
pub const CARGO_TARGET: &str = "${triple}";
`,
  );
  writeFileSync(
    path.join(crateDir, "build.rs"),
    `use sha2::{Digest, Sha256};
use std::env;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

const SCHEMA: &str = ${JSON.stringify(members.length > 1 ? "oliphaunt-artifact-manifest-v2" : "oliphaunt-artifact-manifest-v1")};
const PRODUCT: &str = ${JSON.stringify(product)};
const VERSION: &str = env!("CARGO_PKG_VERSION");
const KIND: &str = "extension";
const TARGET: &str = ${JSON.stringify(triple)};
const RUNTIME_PRODUCT: &str = ${JSON.stringify(runtimeProduct)};
const RUNTIME_VERSION: &str = ${JSON.stringify(runtimeVersion)};
const EXTENSIONS: &[&str] = &[${members.map((member) => JSON.stringify(member)).join(", ")}];
const EXTENSION_DEPENDENCIES: &[(&str, &[&str])] = &[${dependencyRows.map(([member, dependencies]) => `(${JSON.stringify(member)}, &[${dependencies.map((dependency) => JSON.stringify(dependency)).join(", ")}])`).join(", ")}];

fn main() {
    let manifest_dir =
        PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR is set"));
    let payload = manifest_dir.join("payload");
    println!("cargo::rerun-if-changed={}", payload.display());
    if !payload.is_dir() {
        if env::var_os("OLIPHAUNT_ARTIFACT_CRATE_REQUIRE_PAYLOAD").is_some() {
            panic!("missing packaged extension payload under {}", payload.display());
        }
        return;
    }
    let out_dir = PathBuf::from(env::var_os("OUT_DIR").expect("OUT_DIR is set"));
    let manifest = out_dir.join("oliphaunt-artifact.toml");
    let mut text = format!(
        "schema = {SCHEMA:?}\\nproduct = {PRODUCT:?}\\nversion = {VERSION:?}\\nkind = {KIND:?}\\ntarget = {TARGET:?}\\nruntime-product = {RUNTIME_PRODUCT:?}\\nruntime-version = {RUNTIME_VERSION:?}\\n"
    );
    if SCHEMA == "oliphaunt-artifact-manifest-v1" {
        if EXTENSIONS.len() != 1 { panic!("v1 extension manifest requires exactly one member"); }
        text.push_str(&format!("extension = {:?}\\n", EXTENSIONS[0]));
        append_dependencies(&mut text, EXTENSIONS[0]);
        append_manifest_files(&mut text, &payload, "[[files]]");
    } else {
        let extensions_root = payload.join("extensions");
        let mut actual_members: Vec<String> = fs::read_dir(&extensions_root)
            .expect("read extension bundle members")
            .filter_map(|entry| entry.ok())
            .filter(|entry| entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false))
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect();
        actual_members.sort();
        let expected_members: Vec<String> = EXTENSIONS.iter().map(|value| (*value).to_owned()).collect();
        if actual_members != expected_members {
            panic!("extension bundle member set mismatch: expected {expected_members:?}, got {actual_members:?}");
        }
        for extension in EXTENSIONS {
            text.push_str(&format!("\\n[[extensions]]\\nextension = {extension:?}\\n"));
            append_dependencies(&mut text, extension);
            append_manifest_files(&mut text, &extensions_root.join(extension), "[[extensions.files]]");
        }
    }
    fs::write(&manifest, text).expect("write Oliphaunt extension artifact manifest");
    println!("cargo::metadata=manifest={}", manifest.display());
}

fn append_dependencies(text: &mut String, extension: &str) {
    let dependencies = EXTENSION_DEPENDENCIES.iter()
        .find(|(candidate, _)| *candidate == extension)
        .map(|(_, dependencies)| *dependencies)
        .unwrap_or_else(|| panic!("missing dependency metadata for extension {extension}"));
    text.push_str(&format!("dependencies = {dependencies:?}\\n"));
}

fn append_manifest_files(text: &mut String, root: &Path, table: &str) {
    let files = payload_files(root);
    if files.is_empty() { panic!("empty extension payload under {}", root.display()); }
    for file in files {
        let relative = file
            .strip_prefix(root)
            .expect("payload file stays under member root")
            .to_string_lossy()
            .replace(std::path::MAIN_SEPARATOR, "/");
        let sha256 = sha256_file(&file);
        text.push_str(&format!(
            "\\n{table}\\nsource = {:?}\\nrelative = {:?}\\nsha256 = {sha256:?}\\nexecutable = false\\n",
            file.display().to_string(),
            relative,
        ));
    }
}

fn payload_files(root: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    collect_payload_files(root, &mut files);
    files.sort();
    files
}

fn collect_payload_files(root: &Path, files: &mut Vec<PathBuf>) {
    for entry in fs::read_dir(root).expect("read payload directory") {
        let path = entry.expect("read payload entry").path();
        if path.is_dir() {
            collect_payload_files(&path, files);
        } else if path.is_file() {
            files.push(path);
        }
    }
}

fn sha256_file(path: &Path) -> String {
    let mut file = fs::File::open(path).expect("open payload file for hashing");
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 8192];
    loop {
        let read = file.read(&mut buffer).expect("read payload file for hashing");
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    format!("{:x}", hasher.finalize())
}
`,
  );
}

export function packageNativeExtensionCargoCrates(roots, stagingRoot, target, strict, result) {
  if (target === null) {
    result.skipped.push("current host does not map to a supported native extension Cargo target");
    return [];
  }
  const triple = cargoTargetTriple(target);
  if (triple === null) {
    result.skipped.push(`unsupported native extension Cargo target ${target}`);
    return [];
  }
  const manifests = discoverExtensionManifests(roots);
  if (manifests.length === 0) {
    result.skipped.push("no extension-artifacts.json manifests found for native extension Cargo crates");
    return [];
  }

  const sourceRoot = path.join(stagingRoot, "native-extension-sources");
  const outputDir = path.join(stagingRoot, "native-extension-crates");
  const cargoTargetDir = path.join(stagingRoot, "native-extension-cargo-target");
  rmSync(sourceRoot, { recursive: true, force: true });
  rmSync(outputDir, { recursive: true, force: true });
  rmSync(cargoTargetDir, { recursive: true, force: true });
  mkdirSync(sourceRoot, { recursive: true });
  mkdirSync(outputDir, { recursive: true });

  const outputs = [];
  const packageOptions = { root: ROOT, fail: localFail, rel };
  const stagedIdentities = new Map();
  for (const manifestPath of manifests) {
    const manifest = readJsonFile(manifestPath);
    const extensionDir = path.dirname(manifestPath);
    const { product, version } = manifest;
    const memberRows = extensionManifestMembers(manifest);
    const members = memberRows.map((member) => member.sqlName);
    if (![product, version].every((value) => typeof value === "string" && value.length > 0) || members.length === 0) {
      result.skipped.push(`${rel(manifestPath)} is missing product, version, or exact member rows`);
      continue;
    }
    const memberDependencies = Object.fromEntries(memberRows.map((member) => {
      if (!Array.isArray(member.dependencies) || member.dependencies.some((dependency) => typeof dependency !== "string" || !dependency)) {
        fail(TOOL, `${product}@${version} member ${member.sqlName} has invalid dependency metadata`);
      }
      const dependencies = [...new Set(member.dependencies)].sort(compareText);
      if (JSON.stringify(dependencies) !== JSON.stringify(member.dependencies) || dependencies.includes(member.sqlName)) {
        fail(TOOL, `${product}@${version} member ${member.sqlName} dependencies must be sorted, unique, and exclude itself`);
      }
      return [member.sqlName, dependencies];
    }));
    const releaseManifest = extensionReleaseManifest(extensionDir, product, version);
    const runtimeSet = extensionRuntimeAssets(
      extensionDir,
      manifest,
      releaseManifest,
      target,
    );
    if (runtimeSet === null) {
      result.skipped.push(`${product}@${version} has no complete ${target} native runtime member set`);
      continue;
    }
    const runtimeProduct = runtimeSet.compatibility.nativeRuntimeProduct;
    const runtimeVersion = runtimeSet.compatibility.nativeRuntimeVersion;
    const identity = `${product}@${version}:${target}`;
    const digest = JSON.stringify({
      compatibility: runtimeSet.compatibility,
      members: runtimeSet.members.map(({ metadata: inventory, asset }) => ({
        inventory,
        sha256: asset.sha256,
        bytes: asset.bytes,
      })),
      carrier: runtimeSet.carrier === undefined
        ? null
        : { sha256: runtimeSet.carrier.sha256, bytes: runtimeSet.carrier.bytes },
    });
    if (stagedIdentities.has(identity)) {
      if (stagedIdentities.get(identity) !== digest) {
        fail(TOOL, `conflicting native extension Cargo candidates discovered for ${identity}`);
      }
      result.skipped.push(`deduplicated byte-identical native extension Cargo candidate ${identity}`);
      continue;
    }
    stagedIdentities.set(identity, digest);
    const name = nativeExtensionCargoPackageName(product, target);
    const crateDir = path.join(sourceRoot, name);
    try {
      writeNativeExtensionCargoCrate(crateDir, {
        product,
        version,
        members,
        memberDependencies,
        target,
        triple,
        runtimeProduct,
        runtimeVersion,
        runtimeSet,
      });
      let cratePath = cargoPackage(crateDir, cargoTargetDir);
      let size = statSync(cratePath).size;
      if (size > CARGO_EXTENSION_SPLIT_THRESHOLD_BYTES) {
        discardCargoPackageArtifact(cratePath);
        const partDirs = buildNativeExtensionPartCrates(path.join(crateDir, "payload"), sourceRoot, {
          product,
          version,
          members,
          memberDependencies,
          target,
        });
        writeNativeExtensionSplitAggregatorCrate(crateDir, {
          product,
          version,
          members,
          memberDependencies,
          target,
          triple,
          runtimeProduct,
          runtimeVersion,
          partDirs,
        });
        let partFailed = false;
        for (const partDir of partDirs) {
          const partCratePath = cargoPackage(partDir, cargoTargetDir);
          const partSize = statSync(partCratePath).size;
          if (partSize > CARGO_PACKAGE_SIZE_LIMIT_BYTES) {
            const message = `${rel(partCratePath)} is ${partSize} bytes, above the crates.io 10 MiB package limit`;
            result.skipped.push(message);
            if (strict) {
              fail(TOOL, message);
            }
            partFailed = true;
            continue;
          }
          const output = path.join(outputDir, path.basename(partCratePath));
          copyFileSync(partCratePath, output);
          outputs.push(output);
        }
        if (partFailed) {
          continue;
        }
        cratePath = manualCargoPackageSource(
          path.join(crateDir, "Cargo.toml"),
          path.join(cargoTargetDir, "manual-package"),
          packageOptions,
        );
        size = statSync(cratePath).size;
        if (size > CARGO_PACKAGE_SIZE_LIMIT_BYTES) {
          const message = `${rel(cratePath)} is ${size} bytes after splitting, above the crates.io 10 MiB package limit`;
          result.skipped.push(message);
          if (strict) {
            fail(TOOL, message);
          }
          continue;
        }
        if (partDirs.length === 0 || partDirs.length > 999) {
          fail(TOOL, `${product}@${version} generated invalid Cargo payload part count ${partDirs.length}`);
        }
      }
      if (size > CARGO_PACKAGE_SIZE_LIMIT_BYTES) {
        fail(TOOL, `${rel(cratePath)} is ${size} bytes, above the crates.io 10 MiB package limit`);
      }
      const output = path.join(outputDir, path.basename(cratePath));
      copyFileSync(cratePath, output);
      outputs.push(output);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.skipped.push(message);
      if (strict) {
        throw error;
      }
    }
  }
  result.staged.push(...outputs.map(rel));
  return outputs;
}
