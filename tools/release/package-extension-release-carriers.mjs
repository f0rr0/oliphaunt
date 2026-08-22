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

import { parseNpmExtensionLicenseFiles } from "../../src/sdks/js/src/native/extension-contract.ts";
import { captureCommandBytes, captureCommandOutput } from "../dev/capture-command-output.mjs";
import {
  manualCargoPackageSource,
  readCargoPackageNameVersion,
} from "./cargo-source-package.mjs";
import { RUST_BUILD_SCRIPT_SHA256 } from "./rust-build-script-sha256.mjs";
import {
  compareText,
  extensionRegistryPackageTargetSets,
} from "./release-artifact-targets.mjs";
import { localWindowsTarInvocation } from "./tar-command.mjs";
import {
  extensionNpmPackageForProduct,
  extensionNpmTargetPackageForProduct,
  extensionNpmWasixPackageForProduct,
  nativeExtensionCargoLinksName,
  nativeExtensionCargoPackageName,
  nativeExtensionCargoPartPackageName,
} from "./extension-registry-packages.mjs";
import { CORE_RUNTIME_ARCHIVE_FILES } from "./wasix-cargo-artifact-contract.mjs";
import {
  readPortableArchiveEntries,
  readPortableTarZstdBufferEntries,
} from "./portable-archive.mjs";
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
import {
  assertExtensionUpstreamLicensesInArchive,
  assertExtensionUpstreamLicensesInDirectory,
  extensionCarrierLegalContract,
  extensionUpstreamLicenseFileInventory,
  stageExtensionUpstreamLicenses,
} from "./extension-upstream-licenses.mjs";
import {
  assertReleaseNoticesInArchive,
  assertReleaseNoticesInDirectory,
  releaseNoticeRows,
  stageReleaseNotices,
} from "./release-notices.mjs";
import {
  assertWasixExtensionArchiveInstall,
  assertWasixExtensionInstall,
  assertWasixExtensionMemberInstall,
  EXTENSION_RUNTIME_CONTRACT_PATH,
  EXTENSION_RUNTIME_CONTRACT_SCHEMA,
  WASIX_EXTENSION_INSTALL_SCHEMA,
  WASIX_EXTENSION_INSTALL_SIDECAR_SCHEMA,
} from "./wasix-extension-install-contract.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");
const TOOL = "package-extension-release-carriers.mjs";
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

export function packageCommandInvocation(
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

function capturePackageCommandOutput(command, args, options = {}) {
  const cwd = options.cwd ?? ROOT;
  const invocation = packageCommandInvocation(command, args, { cwd });
  return captureCommandOutput(invocation.command, invocation.args, {
    ...options,
    cwd: invocation.cwd ?? cwd,
    shell: invocation.shell,
  });
}

function capturePackageCommandBytes(command, args, options = {}) {
  const cwd = options.cwd ?? ROOT;
  const invocation = packageCommandInvocation(command, args, { cwd });
  return captureCommandBytes(invocation.command, invocation.args, {
    ...options,
    cwd: invocation.cwd ?? cwd,
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
  const result = capturePackageCommandOutput(args[0], args.slice(1), {
    cwd: ROOT,
    label,
    maxOutputBytes: MAX_COMMAND_CAPTURE_BYTES,
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
  const root = path.join(ROOT, "target", "extension-carrier-archive-extract");
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
  // Keep Corepack's version selection rooted at the repository. Package staging
  // may live under the system temporary directory, where invoking the pnpm shim
  // directly would select Corepack's unrelated global default before pnpm ever
  // sees the package directory.
  const result = capturePackageCommandOutput(
    "pnpm",
    ["--dir", packageDir, "pack", "--pack-destination", packDir, "--json"],
    {
      cwd: ROOT,
      label: `pnpm pack for ${packageName}`,
      maxOutputBytes: MAX_COMMAND_CAPTURE_BYTES,
    },
  );
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

export function nativeExtensionCarrierLegal(product, members, { target = null, carriesPayload }) {
  if (
    typeof product !== "string"
    || !Array.isArray(members)
    || members.length === 0
    || members.some((member) => typeof member !== "string" || !member)
    || new Set(members).size !== members.length
    || typeof carriesPayload !== "boolean"
  ) {
    throw new Error(`${TOOL}: native extension carrier legal lookup requires a product, unique members, and carriesPayload`);
  }
  try {
    return extensionCarrierLegalContract(product, members, {
      family: "native",
      target,
      carriesPayload,
    });
  } catch (cause) {
    throw new Error(
      `${TOOL}: cannot derive the canonical native extension carrier legal contract: ${cause.message}`,
      { cause },
    );
  }
}

export function wasixExtensionCarrierLegal(product, members) {
  if (
    typeof product !== "string"
    || !Array.isArray(members)
    || members.length === 0
    || members.some((member) => typeof member !== "string" || !member)
    || new Set(members).size !== members.length
  ) {
    throw new Error(`${TOOL}: WASIX extension carrier legal lookup requires a product and unique members`);
  }
  try {
    return extensionCarrierLegalContract(product, members, {
      family: "wasix",
      target: WASIX_PORTABLE_TARGET,
      carriesPayload: true,
    });
  } catch (cause) {
    throw new Error(
      `${TOOL}: cannot derive the canonical WASIX extension carrier legal contract: ${cause.message}`,
      { cause },
    );
  }
}

function carrierLegalMembers(legal) {
  return [
    ...releaseNoticeRows({ profile: legal.profile }).map((row) => row.member),
    ...(legal.upstreamMembers.length > 0 ? ["share/licenses/**"] : []),
  ];
}

function stageExtensionCarrierLegal(directory, legal) {
  stageReleaseNotices(directory, { profile: legal.profile });
  const upstreamRoot = path.join(directory, "share/licenses");
  if (legal.upstreamMembers.length > 0) {
    for (const sqlName of legal.upstreamMembers) {
      stageExtensionUpstreamLicenses(sqlName, directory);
    }
    assertExtensionUpstreamLicensesInDirectory(legal.upstreamMembers, directory);
  } else if (existsSync(upstreamRoot)) {
    const stat = lstatSync(upstreamRoot);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      fail(TOOL, `stale upstream license root must be a real directory: ${rel(upstreamRoot)}`);
    }
    rmSync(upstreamRoot, { recursive: true });
  }
  assertReleaseNoticesInDirectory(directory, { profile: legal.profile });
}

function assertExtensionCarrierArchive(archive, legal, prefix) {
  assertReleaseNoticesInArchive(archive, { profile: legal.profile, prefix });
  if (legal.upstreamMembers.length > 0) {
    assertExtensionUpstreamLicensesInArchive(legal.upstreamMembers, archive, { prefix });
  }
}

function assertNpmExtensionRuntimeLegalArchive(archive, {
  product,
  members,
  target,
  bundle,
  memberRuntimeRelativePaths,
}) {
  for (const sqlName of members) {
    const legal = nativeExtensionCarrierLegal(product, [sqlName], {
      carriesPayload: true,
      target,
    });
    if (legal.upstreamMembers.length === 0) continue;
    const runtimeRelativePath = bundle
      ? memberRuntimeRelativePaths?.[sqlName]
      : "runtime";
    if (typeof runtimeRelativePath !== "string" || runtimeRelativePath.length === 0) {
      fail(TOOL, `${product} ${target} is missing the runtime path for legal member ${sqlName}`);
    }
    assertExtensionUpstreamLicensesInArchive(legal.upstreamMembers, archive, {
      prefix: `package/${runtimeRelativePath}`,
    });
  }
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

export function npmExtensionMemberContract(product, version, target, member) {
  const inventory = frozenExtensionMemberInventory(member, { product, version });
  const legal = nativeExtensionCarrierLegal(product, [inventory.sqlName], {
    target,
    carriesPayload: true,
  });
  const licenseFiles = Object.freeze(parseNpmExtensionLicenseFiles(
    legal.upstreamMembers.length === 0
      ? []
      : extensionUpstreamLicenseFileInventory([inventory.sqlName]),
    `${product}@${version}/${inventory.sqlName} npm extension licenseFiles`,
  ).map((file) => Object.freeze(file)));
  if (
    JSON.stringify(licenseFiles.map(({ path: file }) => file))
    !== JSON.stringify([...legal.licenseFiles])
  ) {
    fail(
      TOOL,
      `${product}@${version}/${inventory.sqlName} license file integrity rows disagree with the canonical carrier legal contract`,
    );
  }
  if (
    Object.hasOwn(member, "licenseFiles")
    && JSON.stringify(member.licenseFiles) !== JSON.stringify(licenseFiles)
  ) {
    fail(
      TOOL,
      `${product}@${version}/${inventory.sqlName} supplied licenseFiles disagree with the canonical carrier legal contract`,
    );
  }
  return Object.freeze({ ...inventory, licenseFiles });
}

export function renderNpmExtensionContractManifest({ product, version, target, members }) {
  return {
    schema: "oliphaunt-npm-extension-contract-v1",
    product,
    version,
    family: "native",
    target,
    members: members.map((member) => npmExtensionMemberContract(product, version, target, member)),
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
    || value.extensionRuntimeContract !== EXTENSION_RUNTIME_CONTRACT_PATH
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

function frozenExtensionRelease(manifestPath, manifest, releaseManifest) {
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
      `${TOOL}: ${rel(manifestPath)} and release manifest must freeze the same sorted unique members`,
    );
  }
  const frozenMembers = members.map((member, index) => {
    const metadata = frozenExtensionMemberInventory(member, { product, version });
    const releaseMetadata = frozenExtensionMemberInventory(releaseMembers[index], { product, version });
    if (!sameFrozenValue(metadata, releaseMetadata)) {
      throw new Error(`${TOOL}: ${product}@${version}/${member.sqlName} CI and release inventory contracts differ`);
    }
    return { sqlName: member.sqlName, metadata, member, releaseMember: releaseMembers[index] };
  });
  return {
    bundle,
    compatibility: manifestCompatibility,
    members: frozenMembers,
    product,
    releaseManifest,
    version,
    versioning: releaseManifest.versioning,
  };
}

function extensionRuntimeAssets(extensionDir, manifest, releaseManifest, target) {
  const frozen = frozenExtensionRelease(
    path.join(extensionDir, "extension-artifacts.json"),
    manifest,
    releaseManifest,
  );
  if (frozen === null) return null;
  const { product, version } = frozen;
  const runtimeMembers = frozen.members.map(({ sqlName, metadata, member, releaseMember }) => {
    const matches = Array.isArray(member.assets)
      ? member.assets.filter((asset) => asset?.family === "native" && asset?.kind === "runtime" && asset?.target === target)
      : [];
    const releaseMatches = Array.isArray(releaseMember.assets)
      ? releaseMember.assets.filter((asset) => asset?.family === "native" && asset?.kind === "runtime" && asset?.target === target)
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
    return { sqlName, metadata, asset: matches[0] };
  });
  if (runtimeMembers.some((member) => member === null)) {
    return null;
  }
  if (!frozen.bundle) {
    const asset = runtimeMembers[0].asset;
    const assetPath = path.join(extensionDir, "release-assets", asset.name);
    if (!isFile(assetPath) || sha256File(assetPath) !== asset.sha256 || statSync(assetPath).size !== asset.bytes) {
      fail(TOOL, `${product}@${version} ${target} runtime asset is missing or does not match its frozen digest`);
    }
    runtimeMembers[0].archive = assetPath;
    return {
      bundle: false,
      members: runtimeMembers,
      compatibility: frozen.compatibility,
      versioning: frozen.versioning,
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
    compatibility: frozen.compatibility,
    versioning: frozen.versioning,
  };
}

const WASIX_PORTABLE_TARGET = "wasix-portable";
const WASIX_EXTENSION_SQL_NAME = /^[a-z0-9][a-z0-9_-]*$/u;
const WASIX_RUNTIME_SUPPORT_SQL_NAMES = new Set(
  CORE_RUNTIME_ARCHIVE_FILES.flatMap((member) => {
    const match = member.match(/^oliphaunt\/share\/postgresql\/extension\/([^/]+)[.]control$/u);
    return match === null ? [] : [match[1]];
  }),
);

function portableWasixMemberBytes(bytes, label) {
  try {
    readPortableTarZstdBufferEntries(bytes, { label });
  } catch (cause) {
    throw new Error(`${TOOL}: ${cause.message}`, { cause });
  }
  return bytes;
}

function checkedPortableWasixMemberBytes(member, bytes, label) {
  const portable = portableWasixMemberBytes(bytes, label);
  try {
    assertWasixExtensionArchiveInstall(portable, {
      schema: WASIX_EXTENSION_INSTALL_SIDECAR_SCHEMA,
      sqlName: member.sqlName,
      archive: `extensions/${member.sqlName}.tar.zst`,
      sha256: member.asset.sha256,
      size: member.asset.bytes,
      install: member.install,
    }, { label });
  } catch (error) {
    fail(TOOL, error instanceof Error ? error.message : String(error));
  }
  return portable;
}

function portableWasixExtensionAssets(extensionDir, manifest, releaseManifest) {
  const manifestPath = path.join(extensionDir, "extension-artifacts.json");
  const frozen = frozenExtensionRelease(manifestPath, manifest, releaseManifest);
  if (frozen === null) return null;
  const { product, version } = frozen;
  const members = frozen.members.map(({ sqlName, metadata, member, releaseMember }) => {
    if (!WASIX_EXTENSION_SQL_NAME.test(sqlName)) {
      fail(TOOL, `${product}@${version} has an invalid WASIX extension SQL name ${JSON.stringify(sqlName)}`);
    }
    const select = (row) =>
      row?.family === "wasix"
      && row?.kind === "wasix-runtime"
      && row?.target === WASIX_PORTABLE_TARGET;
    const matches = Array.isArray(member.assets) ? member.assets.filter(select) : [];
    const releaseMatches = Array.isArray(releaseMember.assets)
      ? releaseMember.assets.filter(select)
      : [];
    let install;
    let releaseInstall;
    try {
      install = assertWasixExtensionMemberInstall(member, {
        label: `${product}@${version}/${sqlName} CI member`,
      });
      releaseInstall = assertWasixExtensionMemberInstall(releaseMember, {
        label: `${product}@${version}/${sqlName} release member`,
      });
    } catch (error) {
      fail(TOOL, error instanceof Error ? error.message : String(error));
    }
    if (install === null && releaseInstall === null) return null;
    if (
      install === null
      || releaseInstall === null
      || matches.length !== 1
      || releaseMatches.length !== 1
      || !sameFrozenValue(
        extensionRuntimeAssetContract(matches[0]),
        extensionRuntimeAssetContract(releaseMatches[0]),
      )
    ) {
      fail(TOOL, `${product}@${version}/${sqlName} CI and release portable WASIX asset contracts differ`);
    }
    const asset = matches[0];
    if (asset.identity !== null) {
      fail(TOOL, `${product}@${version}/${sqlName} portable WASIX runtime asset must declare identity=null`);
    }
    if (!sameFrozenValue(install, releaseInstall)) {
      fail(TOOL, `${product}@${version}/${sqlName} CI and release WASIX install contracts differ`);
    }
    if (install.dependencies.some((dependency) => dependency === sqlName)) {
      fail(TOOL, `${product}@${version}/${sqlName} WASIX install dependencies must exclude itself`);
    }
    return { sqlName, metadata, asset, install };
  });
  if (members.every((member) => member === null)) return null;
  if (members.some((member) => member === null)) {
    fail(TOOL, `${product}@${version} has an incomplete portable WASIX extension member set`);
  }

  const memberNames = new Set(members.map(({ sqlName }) => sqlName));
  for (const { sqlName, install } of members) {
    for (const dependency of install.dependencies) {
      if (memberNames.has(dependency) || WASIX_RUNTIME_SUPPORT_SQL_NAMES.has(dependency)) continue;
      fail(
        TOOL,
        `${product}@${version}/${sqlName} has unsupported cross-product or unavailable WASIX dependency ${JSON.stringify(dependency)}`,
      );
    }
  }

  if (!frozen.bundle) {
    const [member] = members;
    const archive = path.join(extensionDir, "release-assets", member.asset.name);
    if (
      !isFile(archive)
      || statSync(archive).size !== member.asset.bytes
      || sha256File(archive) !== member.asset.sha256
    ) {
      fail(TOOL, `${product}@${version}/${member.sqlName} portable WASIX asset is missing or changed`);
    }
    const bytes = checkedPortableWasixMemberBytes(
      member,
      readFileSync(archive),
      `${product}@${version}/${member.sqlName} portable WASIX archive`,
    );
    return {
      bundle: false,
      compatibility: frozen.compatibility,
      members: [{ ...member, bytes }],
      versioning: frozen.versioning,
    };
  }

  const carrierNames = new Set(members.map(({ asset }) => asset.carrierAsset));
  if (carrierNames.size !== 1 || carrierNames.has(undefined)) {
    fail(TOOL, `${product}@${version} portable WASIX members must share one aggregate carrier`);
  }
  const carrierName = [...carrierNames][0];
  const selectCarrier = (row) =>
    row?.name === carrierName
    && row?.family === "wasix"
    && row?.kind === "extension-bundle"
    && row?.target === WASIX_PORTABLE_TARGET;
  const carrierRows = Array.isArray(manifest.carrierAssets)
    ? manifest.carrierAssets.filter(selectCarrier)
    : [];
  const releaseCarrierRows = Array.isArray(releaseManifest.assets)
    ? releaseManifest.assets.filter(selectCarrier)
    : [];
  if (
    carrierRows.length !== 1
    || releaseCarrierRows.length !== 1
    || !sameFrozenValue(
      extensionRuntimeAssetContract(carrierRows[0]),
      extensionRuntimeAssetContract(releaseCarrierRows[0]),
    )
  ) {
    fail(TOOL, `${product}@${version} CI and release portable WASIX aggregate carrier contracts differ`);
  }
  const carrier = carrierRows[0];
  const carrierPath = path.join(extensionDir, "release-assets", carrierName);
  if (
    !isFile(carrierPath)
    || statSync(carrierPath).size !== carrier.bytes
    || sha256File(carrierPath) !== carrier.sha256
  ) {
    fail(TOOL, `${product}@${version} portable WASIX aggregate carrier is missing or changed`);
  }
  let entries;
  try {
    entries = readPortableArchiveEntries(carrierPath, { format: "tar.gz" });
  } catch (cause) {
    throw new Error(`${TOOL}: ${cause.message}`, { cause });
  }
  return {
    bundle: true,
    compatibility: frozen.compatibility,
    members: members.map((member) => {
      const carrierRoot = carrierName.replace(/[.]tar[.]gz$/u, "");
      const expectedMember = `${carrierRoot}/extensions/${member.sqlName}/${member.asset.name}`;
      if (
        member.asset.carrierRoot !== carrierRoot
        || member.asset.memberPath !== `extensions/${member.sqlName}/${member.asset.name}`
      ) {
        fail(TOOL, `${product}@${version}/${member.sqlName} has a noncanonical portable WASIX carrier locator`);
      }
      const entry = entries.get(expectedMember);
      if (entry === undefined || !entry.isFile || entry.isSymbolicLink) {
        fail(TOOL, `${rel(carrierPath)} must contain regular member ${expectedMember}`);
      }
      const bytes = entry.data();
      if (bytes.length !== member.asset.bytes || createHash("sha256").update(bytes).digest("hex") !== member.asset.sha256) {
        fail(TOOL, `${product}@${version}/${member.sqlName} nested portable WASIX bytes do not match their frozen digest`);
      }
      return {
        ...member,
        bytes: checkedPortableWasixMemberBytes(
          member,
          bytes,
          `${product}@${version}/${member.sqlName} nested portable WASIX archive`,
        ),
      };
    }),
    versioning: frozen.versioning,
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
  // builders. Carrier assembly preserves those qualified bytes; host-side
  // binary rewriting would make output coordinator-dependent.
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
  const result = capturePackageCommandOutput("tar", ["-tvf", archive, member], {
    cwd: ROOT,
    label: `inspect ${member} in ${rel(archive)}`,
    maxOutputBytes: MAX_COMMAND_CAPTURE_BYTES,
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
  let destinationCreated = false;
  let extractionError;
  try {
    descriptor = openSync(
      destination,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    destinationCreated = true;
    result = capturePackageCommandBytes("tar", ["-xOf", archive, member], {
      cwd: ROOT,
      label: `read ${member} from ${rel(archive)}`,
      maxOutputBytes: MAX_COMMAND_CAPTURE_BYTES,
      stdoutDescriptor: descriptor,
    });
  } catch (error) {
    extractionError = error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  if (extractionError !== undefined) {
    if (destinationCreated) rmSync(destination, { force: true });
    throw extractionError;
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

function wasixDescriptorClosure(runtimeSet, rootSqlName) {
  const bySqlName = new Map(runtimeSet.members.map((member) => [member.sqlName, member]));
  const visiting = new Set();
  const visited = new Set();
  const closure = [];
  const visit = (sqlName) => {
    if (visited.has(sqlName)) return;
    if (!visiting.add(sqlName)) {
      fail(TOOL, `portable WASIX extension dependency cycle involving ${JSON.stringify(sqlName)}`);
    }
    const member = bySqlName.get(sqlName);
    if (member === undefined) {
      fail(TOOL, `portable WASIX extension descriptor has no carrier for ${JSON.stringify(sqlName)}`);
    }
    for (const dependency of member.install.dependencies) {
      if (bySqlName.has(dependency)) visit(dependency);
    }
    visiting.delete(sqlName);
    visited.add(sqlName);
    closure.push(member);
  };
  visit(rootSqlName);
  return closure;
}

function descriptorAssetSource(descriptorPath, sqlName) {
  const asset = `extensions/${sqlName}/extension.tar.zst`;
  const relative = path.posix.relative(path.posix.dirname(descriptorPath), asset);
  return relative.startsWith(".") ? relative : `./${relative}`;
}

export function renderWasixExtensionDescriptorModule({
  product,
  version,
  sqlName,
  carriers,
  compatibility,
  descriptorPath = "index.js",
}) {
  let frozenCompatibility;
  try {
    frozenCompatibility = frozenExtensionCompatibility(
      compatibility,
      `${product}@${version} portable WASIX descriptor`,
    );
  } catch {
    throw new TypeError(`${TOOL}: invalid portable WASIX extension descriptor compatibility`);
  }
  if (
    ![product, version, sqlName, descriptorPath].every((value) => typeof value === "string" && value.length > 0)
    || !Array.isArray(carriers)
    || carriers.length === 0
    || carriers.some((carrier) =>
      typeof carrier?.sqlName !== "string"
      || !WASIX_EXTENSION_SQL_NAME.test(carrier.sqlName)
      || typeof carrier?.sha256 !== "string"
      || !/^[0-9a-f]{64}$/u.test(carrier.sha256)
      || !Number.isSafeInteger(carrier?.size)
      || carrier.size <= 0
      || carrier?.install === null
      || typeof carrier?.install !== "object"
    )
    || new Set(carriers.map((carrier) => carrier.sqlName)).size !== carriers.length
    || !carriers.some((carrier) => carrier.sqlName === sqlName)
  ) {
    throw new TypeError(`${TOOL}: invalid portable WASIX extension descriptor input`);
  }
  const checkedCarriers = carriers.map((carrier, index) => ({
    ...carrier,
    install: assertWasixExtensionInstall(carrier.install, {
      expectedSqlName: carrier.sqlName,
      label: `${product}@${version} descriptor carrier ${index} install`,
    }),
  }));
  const installRows = checkedCarriers.flatMap((carrier, index) => [
    `const install${index} = deepFreeze(${JSON.stringify(carrier.install, null, 2)});`,
  ]);
  const carrierRows = checkedCarriers.map((carrier, index) => [
    "  {",
    `    product: ${JSON.stringify(product)},`,
    `    version: ${JSON.stringify(version)},`,
    `    sqlName: ${JSON.stringify(carrier.sqlName)},`,
    `    archive: ${JSON.stringify(`extensions/${carrier.sqlName}.tar.zst`)},`,
    `    sha256: ${JSON.stringify(carrier.sha256)},`,
    `    size: ${carrier.size},`,
    `    source: new URL(${JSON.stringify(descriptorAssetSource(descriptorPath, carrier.sqlName))}, import.meta.url),`,
    `    install: install${index},`,
    "  },",
  ].join("\n"));
  return [
    "function deepFreeze(value) {",
    '  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {',
    "    for (const child of Object.values(value)) deepFreeze(child);",
    "    Object.freeze(value);",
    "  }",
    "  return value;",
    "}",
    "",
    ...installRows,
    ...(installRows.length === 0 ? [] : [""]),
    "const compatibility = deepFreeze({",
    `  extensionRuntimeContract: ${JSON.stringify(EXTENSION_RUNTIME_CONTRACT_SCHEMA)},`,
    `  postgresMajor: ${JSON.stringify(frozenCompatibility.postgresMajor)},`,
    `  wasixRuntimeProduct: ${JSON.stringify(frozenCompatibility.wasixRuntimeProduct)},`,
    `  wasixRuntimeVersion: ${JSON.stringify(frozenCompatibility.wasixRuntimeVersion)},`,
    "});",
    "",
    "const carriers = deepFreeze([",
    ...carrierRows,
    "]);",
    "",
    "const descriptor = deepFreeze({",
    '  schema: "oliphaunt-wasix-extension-v1",',
    '  runtime: "wasix",',
    `  product: ${JSON.stringify(product)},`,
    `  version: ${JSON.stringify(version)},`,
    "  compatibility,",
    `  sqlName: ${JSON.stringify(sqlName)},`,
    "  carriers,",
    "});",
    "",
    "export { descriptor };",
    "export default descriptor;",
    "",
  ].join("\n");
}

export function renderWasixExtensionDescriptorTypes() {
  return `export type OliphauntWasixExtensionNativeModule = Readonly<{
  name: string;
  path: string;
  sha256: string;
  moduleSha256: string;
  size: number;
}>;

export type OliphauntWasixExtensionImport = Readonly<{
  module: string;
  name: string;
  kind: string;
}>;

export type OliphauntWasixExtensionLifecycle = Readonly<{
  createExtension: boolean;
  createSchema: string | null;
  loadSql: readonly string[];
  postCreateSql: readonly string[];
  startupConfig: readonly string[];
  preloadRequired: boolean;
  restartRequired: boolean;
  sharedMemoryRequired: boolean;
}>;

export type OliphauntWasixExtensionInstall = Readonly<{
  schema: "${WASIX_EXTENSION_INSTALL_SCHEMA}";
  name: string;
  nativeModule: string | null;
  nativeModules: readonly OliphauntWasixExtensionNativeModule[];
  coreExportsRequired: readonly string[];
  dependencies: readonly string[];
  loadOrder: readonly string[];
  lifecycle: OliphauntWasixExtensionLifecycle;
  installedFiles: readonly string[];
  unresolvedImports: readonly OliphauntWasixExtensionImport[];
}>;

export type OliphauntWasixExtensionCarrier = Readonly<{
  product: string;
  version: string;
  sqlName: string;
  archive: string;
  sha256: string;
  size: number;
  source: URL;
  install: OliphauntWasixExtensionInstall;
}>;

export type OliphauntWasixExtensionCompatibility = Readonly<{
  extensionRuntimeContract: "${EXTENSION_RUNTIME_CONTRACT_SCHEMA}";
  postgresMajor: string;
  wasixRuntimeProduct: "liboliphaunt-wasix";
  wasixRuntimeVersion: string;
}>;

export type OliphauntWasixExtensionDescriptor = Readonly<{
  schema: "oliphaunt-wasix-extension-v1";
  runtime: "wasix";
  product: string;
  version: string;
  compatibility: OliphauntWasixExtensionCompatibility;
  sqlName: string;
  carriers: readonly OliphauntWasixExtensionCarrier[];
}>;

declare const descriptor: OliphauntWasixExtensionDescriptor;
export { descriptor };
export default descriptor;
`;
}

function writeWasixExtensionReadme(packageDir, packageName, members, bundle) {
  const selectedMembers = bundle ? members.slice(0, 2) : members;
  const imports = selectedMembers.map((sqlName) => {
    const localName = sqlName.replaceAll("-", "_");
    return `import ${localName} from '${packageName}${bundle ? `/${sqlName}` : ""}';`;
  });
  const selectedDescriptors = selectedMembers.map((sqlName) => sqlName.replaceAll("-", "_"));
  writeFileSync(path.join(packageDir, "README.md"), [
    `# ${packageName}`,
    "",
    "Host-neutral portable WASIX carrier for exact Oliphaunt PostgreSQL extension bytes.",
    "The carrier does not itself claim qualification for any particular browser or Node host.",
    "",
    "Consumer API:",
    "",
    "```ts",
    "import Oliphaunt from '@oliphaunt/wasix-ts';",
    ...imports,
    "",
    "const database = await Oliphaunt.open({",
    `  extensions: [${selectedDescriptors.join(", ")}],`,
    "});",
    "```",
    "",
    "Import only the extension descriptors your application needs. The WASIX runtime",
    "carrier and package-relative archives are resolved and verified by the binding.",
    "This carrier is selected by the binding and is not a standalone database host.",
    "",
    "The package version, tag, and changelog belong to the unsuffixed extension release product.",
    "",
  ].join("\n"));
}

function writeWasixExtensionNpmPackage(packageDir, {
  product,
  version,
  runtimeSet,
}) {
  const members = runtimeSet.members.map(({ sqlName }) => sqlName);
  const bundle = members.length > 1;
  const packageName = extensionNpmWasixPackageForProduct(product);
  const legal = wasixExtensionCarrierLegal(product, members);
  mkdirSync(packageDir, { recursive: true });
  for (const member of runtimeSet.members) {
    const output = path.join(packageDir, "extensions", member.sqlName, "extension.tar.zst");
    mkdirSync(path.dirname(output), { recursive: true });
    writeFileSync(output, member.bytes, { flag: "wx", mode: 0o644 });
    chmodSync(output, 0o644);
  }

  const exports = {};
  const memberExports = {};
  for (const member of runtimeSet.members) {
    const descriptorPath = bundle ? `descriptors/${member.sqlName}.js` : "index.js";
    const typesPath = descriptorPath.replace(/[.]js$/u, ".d.ts");
    const closure = wasixDescriptorClosure(runtimeSet, member.sqlName);
    const module = renderWasixExtensionDescriptorModule({
      product,
      version,
      sqlName: member.sqlName,
      compatibility: runtimeSet.compatibility,
      carriers: closure.map((carrier) => ({
        sqlName: carrier.sqlName,
        sha256: carrier.asset.sha256,
        size: carrier.asset.bytes,
        install: carrier.install,
      })),
      descriptorPath,
    });
    const modulePath = path.join(packageDir, ...descriptorPath.split("/"));
    mkdirSync(path.dirname(modulePath), { recursive: true });
    writeFileSync(modulePath, module);
    writeFileSync(path.join(packageDir, ...typesPath.split("/")), renderWasixExtensionDescriptorTypes());
    const exportName = bundle ? `./${member.sqlName}` : ".";
    memberExports[member.sqlName] = exportName;
    exports[exportName] = {
      types: `./${typesPath}`,
      import: `./${descriptorPath}`,
      default: `./${descriptorPath}`,
    };
  }
  exports["./package.json"] = "./package.json";

  writeWasixExtensionReadme(packageDir, packageName, members, bundle);
  writeJsonFile(path.join(packageDir, "package.json"), {
    name: packageName,
    version,
    description: bundle
      ? `Portable Oliphaunt WASIX carrier for ${members.length} exact PostgreSQL contrib extensions.`
      : `Portable Oliphaunt WASIX carrier for PostgreSQL ${members[0]}.`,
    license: legal.packageSpdx,
    type: "module",
    sideEffects: false,
    repository: { type: "git", url: NPM_TRUSTED_PUBLISHING_REPOSITORY },
    oliphaunt: {
      product,
      kind: bundle ? "exact-extension-wasix-bundle" : "exact-extension-wasix",
      runtime: "wasix",
      descriptorSchema: "oliphaunt-wasix-extension-v1",
      members,
      memberExports,
      target: WASIX_PORTABLE_TARGET,
      wasixRuntimeProduct: runtimeSet.compatibility.wasixRuntimeProduct,
      wasixRuntimeVersion: runtimeSet.compatibility.wasixRuntimeVersion,
      runtimeBound: runtimeSet.versioning === "runtime-bound",
    },
    publishConfig: { access: "public", provenance: true },
    files: [
      "README.md",
      ...(bundle ? ["descriptors"] : ["index.js", "index.d.ts"]),
      "extensions",
      ...carrierLegalMembers(legal),
    ],
    exports,
  });
  stageExtensionCarrierLegal(packageDir, legal);
  return { legal, packageName };
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
  legal,
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
    license: legal.packageSpdx,
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
    files: ["README.md", IOS_CARRIER_FILENAME, ...carrierLegalMembers(legal)],
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
  legal,
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
    license: legal.packageSpdx,
    type: "module",
    repository: { type: "git", url: NPM_TRUSTED_PUBLISHING_REPOSITORY },
    ...npmPlatformConstraints(target),
    optional: true,
    oliphaunt: metadata,
    publishConfig: { access: "public", provenance: true },
    files: [
      ...(bundle
        ? ["extensions", "bundle-manifest.json", NPM_EXTENSION_CONTRACT_FILENAME, "README.md"]
        : ["runtime", NPM_EXTENSION_CONTRACT_FILENAME, "README.md"]),
      ...carrierLegalMembers(legal),
    ],
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

export function stageExtensionNativeNpmPackages(roots, stagingRoot, target, result, options = {}) {
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
        fail(TOOL, `conflicting extension packages discovered for ${identity}`);
      }
      result.skipped.push(`deduplicated byte-identical extension package ${identity} from ${rel(manifestPath)}`);
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
    const metaLegal = nativeExtensionCarrierLegal(product, members, {
      carriesPayload: false,
    });
    const targetLegal = nativeExtensionCarrierLegal(product, members, {
      carriesPayload: true,
      target,
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
      legal: metaLegal,
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
      legal: targetLegal,
    });
    stageExtensionCarrierLegal(metaDir, metaLegal);
    stageExtensionCarrierLegal(targetDir, targetLegal);
    const targetTarball = pnpmPackForNpmPublish(targetDir, tarballRoot);
    assertExtensionCarrierArchive(targetTarball, targetLegal, "package");
    assertNpmExtensionRuntimeLegalArchive(targetTarball, {
      product,
      members,
      target,
      bundle: runtimeSet.bundle,
      memberRuntimeRelativePaths,
    });
    if (!npmPackageSizeSafe(targetTarball, result)) {
      continue;
    }
    const metaTarball = pnpmPackForNpmPublish(metaDir, tarballRoot);
    assertExtensionCarrierArchive(metaTarball, metaLegal, "package");
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

function assertWasixExtensionNpmArchive(archive, {
  legal,
  packageName,
  product,
  runtimeSet,
  version,
}) {
  assertExtensionCarrierArchive(archive, legal, "package");
  let entries;
  try {
    entries = readPortableArchiveEntries(archive, { format: "tar.gz" });
  } catch (cause) {
    throw new Error(`${TOOL}: ${cause.message}`, { cause });
  }
  const packageJsonEntry = entries.get("package/package.json");
  if (packageJsonEntry === undefined || !packageJsonEntry.isFile || packageJsonEntry.isSymbolicLink) {
    fail(TOOL, `${rel(archive)} lacks a regular package/package.json`);
  }
  let packageJson;
  try {
    packageJson = JSON.parse(packageJsonEntry.data().toString("utf8"));
  } catch (cause) {
    fail(TOOL, `${rel(archive)} package/package.json is invalid JSON: ${cause.message}`);
  }
  if (
    packageJson.name !== packageName
    || packageJson.version !== version
    || packageJson.oliphaunt?.product !== product
    || packageJson.oliphaunt?.runtime !== "wasix"
  ) {
    fail(TOOL, `${rel(archive)} does not preserve its exact WASIX extension package identity`);
  }
  for (const member of runtimeSet.members) {
    const memberPath = `package/extensions/${member.sqlName}/extension.tar.zst`;
    const entry = entries.get(memberPath);
    if (entry === undefined || !entry.isFile || entry.isSymbolicLink) {
      fail(TOOL, `${rel(archive)} lacks regular WASIX carrier ${memberPath}`);
    }
    const bytes = entry.data();
    if (
      bytes.length !== member.asset.bytes
      || createHash("sha256").update(bytes).digest("hex") !== member.asset.sha256
    ) {
      fail(TOOL, `${rel(archive)} changed portable WASIX bytes for ${member.sqlName}`);
    }
  }
}

export function stageExtensionWasixNpmPackages(roots, stagingRoot, result) {
  const manifests = discoverExtensionManifests(roots);
  if (manifests.length === 0) return null;

  rmSync(stagingRoot, { recursive: true, force: true });
  const packageRoot = path.join(stagingRoot, "packages");
  const tarballRoot = path.join(stagingRoot, "tarballs");
  const stagedIdentities = new Map();
  let stagedAny = false;
  for (const manifestPath of manifests) {
    const manifest = readJsonFile(manifestPath);
    const extensionDir = path.dirname(manifestPath);
    const { product, version } = manifest;
    if (![product, version].every((value) => typeof value === "string" && value.length > 0)) continue;
    const releaseManifest = extensionReleaseManifest(extensionDir, product, version);
    const runtimeSet = portableWasixExtensionAssets(extensionDir, manifest, releaseManifest);
    if (runtimeSet === null) continue;
    const runtimeVersion = runtimeSet.compatibility.wasixRuntimeVersion;
    if (runtimeSet.versioning === "runtime-bound" && version !== runtimeVersion) {
      fail(TOOL, `${product}@${version} is runtime-bound but declares WASIX runtime version ${runtimeVersion}`);
    }
    const identity = `${extensionNpmWasixPackageForProduct(product)}@${version}`;
    const digest = JSON.stringify({
      compatibility: runtimeSet.compatibility,
      members: runtimeSet.members.map(({ metadata, asset, install }) => ({
        metadata,
        sha256: asset.sha256,
        bytes: asset.bytes,
        install,
      })),
      versioning: runtimeSet.versioning,
    });
    const previous = stagedIdentities.get(identity);
    if (previous !== undefined) {
      if (previous !== digest) {
        fail(TOOL, `conflicting portable WASIX npm candidates discovered for ${identity}`);
      }
      result.skipped.push(`deduplicated byte-identical portable WASIX npm candidate ${identity}`);
      continue;
    }
    stagedIdentities.set(identity, digest);

    const packageDir = path.join(
      packageRoot,
      safeNpmPackageFilenamePrefix(extensionNpmWasixPackageForProduct(product)),
    );
    const { legal, packageName } = writeWasixExtensionNpmPackage(packageDir, {
      product,
      version,
      runtimeSet,
    });
    const tarball = pnpmPackForNpmPublish(packageDir, tarballRoot);
    assertWasixExtensionNpmArchive(tarball, {
      legal,
      packageName,
      product,
      runtimeSet,
      version,
    });
    if (!npmPackageSizeSafe(tarball, result)) continue;
    result.staged.push(rel(tarball));
    stagedAny = true;
  }
  return stagedAny ? tarballRoot : null;
}

export function stageExtensionNpmPackages(roots, stagingRoot, target, result, options = {}) {
  rmSync(stagingRoot, { recursive: true, force: true });
  const nativeRoot = stageExtensionNativeNpmPackages(
    roots,
    path.join(stagingRoot, "native"),
    target,
    result,
    options,
  );
  const wasixRoot = stageExtensionWasixNpmPackages(
    roots,
    path.join(stagingRoot, "wasix"),
    result,
  );
  return nativeRoot === null && wasixRoot === null ? null : stagingRoot;
}

export function stageExtensionNpmPackagesForTargets(
  roots,
  stagingRoot,
  targets,
  result,
  options = {},
) {
  if (
    !Array.isArray(targets)
    || targets.length === 0
    || targets.some((target) => typeof target !== "string" || target.length === 0)
    || new Set(targets).size !== targets.length
  ) {
    throw new TypeError(`${TOOL}: extension npm target-set staging requires a non-empty unique target list`);
  }
  const canonicalTargets = [...targets].sort(compareText);
  rmSync(stagingRoot, { recursive: true, force: true });
  const nativeRoots = Object.fromEntries(canonicalTargets.map((target) => [
    target,
    stageExtensionNativeNpmPackages(
      roots,
      path.join(stagingRoot, target),
      target,
      result,
      {
        ...options,
        metaTargets: options.metaTargets ?? canonicalTargets,
      },
    ),
  ]));
  const wasixRoot = stageExtensionWasixNpmPackages(
    roots,
    path.join(stagingRoot, "wasix"),
    result,
  );
  return Object.freeze({
    nativeRoots: Object.freeze(nativeRoots),
    wasixRoot,
    root: Object.values(nativeRoots).some((root) => root !== null) || wasixRoot !== null
      ? stagingRoot
      : null,
  });
}


function writeNativeExtensionCargoPartCrate(crateDir, { product, version, members, target, index, legal }) {
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
license = ${tomlString(legal.packageSpdx)}
include = ${tomlString(["Cargo.toml", "README.md", "src/**", "payload/**", ...carrierLegalMembers(legal)])}

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
  stageExtensionCarrierLegal(crateDir, legal);
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
  const legal = nativeExtensionCarrierLegal(product, members, { target, carriesPayload: true });
  const partDirs = [];
  let currentDir = null;
  let currentSize = 0;

  const startPart = () => {
    const index = partDirs.length + 1;
    if (index > 999) {
      throw new Error(`${product}@${version} requires more than 999 Cargo payload parts for ${target}`);
    }
    const partDir = path.join(sourceRoot, nativeExtensionCargoPartPackageName(product, target, index));
    writeNativeExtensionCargoPartCrate(partDir, { product, version, members, target, index, legal });
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

const NATIVE_EXTENSION_AGGREGATOR_BUILD_RS = String.raw`use std::collections::BTreeMap;
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

${RUST_BUILD_SCRIPT_SHA256}
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
  const legal = nativeExtensionCarrierLegal(product, members, { carriesPayload: false });
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
license = ${tomlString(legal.packageSpdx)}
links = "${links}"
build = "build.rs"
include = ${tomlString(["Cargo.toml", "README.md", "build.rs", "src/**", ...carrierLegalMembers(legal)])}

[lib]
path = "src/lib.rs"

[build-dependencies]
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
  stageExtensionCarrierLegal(crateDir, legal);
  return legal;
}

function cargoPackage(crateDir, targetDir, legal, { noVerify = false } = {}) {
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
  const invocation = packageCommandInvocation(command[0], command.slice(1), { cwd: ROOT });
  const result = nodeSpawnSync(invocation.command, invocation.args, {
    cwd: invocation.cwd ?? ROOT,
    env: { ...process.env, OLIPHAUNT_ARTIFACT_CRATE_REQUIRE_PAYLOAD: "1" },
    shell: invocation.shell,
    stdio: "inherit",
  });
  if (result.error) {
    fail(TOOL, `${command[0]} failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    fail(TOOL, `${command[0]} failed with exit code ${result.status ?? 1}`);
  }
  const cargoCratePath = path.join(targetDir, "package", `${name}-${version}.crate`);
  if (!isFile(cargoCratePath)) {
    fail(TOOL, `cargo package did not create ${rel(cargoCratePath)}`);
  }
  // Cargo's tar writer may choose GNU LongLink records for paths that fit in
  // ustar's prefix/name fields. Re-materialize the already verified source as
  // the repository's strict deterministic ustar so the final carrier can be
  // parsed and validated without accepting link-like extension records.
  let cratePath;
  try {
    cratePath = manualCargoPackageSource(
      manifest,
      path.join(targetDir, "strict-package", name),
      {
        root: ROOT,
        fail: localFail,
        rel,
        // The caller uses the strict package's actual size to decide whether to
        // split. Do not let the generic 10 MiB guard preempt that role-aware path.
        packageSizeLimitBytes: Number.MAX_SAFE_INTEGER,
      },
    );
    assertExtensionCarrierArchive(cratePath, legal, `${name}-${version}`);
  } finally {
    // `cargo package` is the verifier here, while `cratePath` is the one
    // deterministic archive eligible for publication. Cargo also retains a
    // byte-distinct copy under package/tmp-crate in addition to its ordinary
    // package archive and expanded verification tree. The complete package
    // subtree is transient and dedicated to this target directory, so remove
    // it rather than trying to enumerate Cargo's internal paths.
    rmSync(path.join(targetDir, "package"), { recursive: true, force: true });
  }
  return cratePath;
}

function discardCargoPackageArtifact(cratePath) {
  // manualCargoPackageSource gives each generated crate a dedicated output
  // directory containing the archive and its verification stage.
  rmSync(path.dirname(cratePath), { recursive: true, force: true });
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
  const legal = nativeExtensionCarrierLegal(product, members, { target, carriesPayload: true });
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
license = ${tomlString(legal.packageSpdx)}
links = "${links}"
build = "build.rs"
include = ${tomlString(["Cargo.toml", "README.md", "build.rs", "src/**", "payload/**", ...carrierLegalMembers(legal)])}

[lib]
path = "src/lib.rs"

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
    `use std::env;
use std::fs;
use std::io::{self, Read};
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
        let sha256 = sha256_file(&file).expect("hash payload file");
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

${RUST_BUILD_SCRIPT_SHA256}
`,
  );
  stageExtensionCarrierLegal(crateDir, legal);
  return legal;
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
  try {
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
        fail(TOOL, `conflicting native extension Cargo packages discovered for ${identity}`);
      }
      result.skipped.push(`deduplicated byte-identical native extension Cargo package ${identity}`);
      continue;
    }
    stagedIdentities.set(identity, digest);
    const name = nativeExtensionCargoPackageName(product, target);
    const crateDir = path.join(sourceRoot, name);
    try {
      const crateLegal = writeNativeExtensionCargoCrate(crateDir, {
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
      let cratePath = cargoPackage(crateDir, cargoTargetDir, crateLegal);
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
        const partLegal = nativeExtensionCarrierLegal(product, members, { target, carriesPayload: true });
        const aggregatorLegal = writeNativeExtensionSplitAggregatorCrate(crateDir, {
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
          const partCratePath = cargoPackage(partDir, cargoTargetDir, partLegal);
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
        assertExtensionCarrierArchive(
          cratePath,
          aggregatorLegal,
          path.basename(cratePath, ".crate"),
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
  } finally {
    // Only native-extension-crates is a publication surface. Source and Cargo
    // work roots can contain verifier-created .crate files, including
    // package/tmp-crate copies whose bytes differ from the deterministic final
    // carrier. Removing both work roots in finally keeps success and failure
    // staging trees fail-closed for recursive artifact discovery.
    rmSync(sourceRoot, { recursive: true, force: true });
    rmSync(cargoTargetDir, { recursive: true, force: true });
  }
}
