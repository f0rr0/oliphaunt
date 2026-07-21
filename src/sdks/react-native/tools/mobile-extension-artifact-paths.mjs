#!/usr/bin/env bun
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  createReadStream,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { createGunzip } from "node:zlib";

import { captureCommandOutput } from "../../../../tools/dev/capture-command-output.mjs";

const OPTION_NAMES = new Set([
  "--root",
  "--artifact-root",
  "--materialize-root",
  "--extensions",
  "--asset-kind",
  "--asset-target",
  "--required",
]);
const MOBILE_TARGETS = new Set(["android-arm64-v8a", "android-x86_64", "ios-xcframework"]);
const STABLE_SEMVER = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u;
const C_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_BUNDLE_MEMBERS = 4096;
const MAX_BUNDLE_EXPANDED_BYTES = 4 * 1024 * 1024 * 1024;
const EXTENSION_MEMBER_KEYS = new Set([
  "sqlName",
  "createsExtension",
  "dependencies",
  "dataFiles",
  "extensionSqlFileNames",
  "extensionSqlFilePrefixes",
  "nativeDependencies",
  "nativeModuleStem",
  "iosNativeDependencies",
  "iosRegistration",
  "sharedPreloadLibraries",
  "mobileReleaseReady",
  "desktopReleaseReady",
  "assets",
]);
const DIRECT_MANIFEST_KEYS = new Set([
  "schema",
  "product",
  "version",
  "compatibility",
  ...EXTENSION_MEMBER_KEYS,
]);
const BUNDLE_MANIFEST_KEYS = new Set([
  "schema",
  "product",
  "version",
  "compatibility",
  "extensions",
  "carrierAssets",
]);
const DIRECT_ASSET_KEYS = new Set([
  "name",
  "path",
  "source",
  "sha256",
  "bytes",
  "family",
  "kind",
  "target",
  "identity",
]);
const BUNDLE_MEMBER_ASSET_KEYS = new Set([
  ...DIRECT_ASSET_KEYS,
  "carrierAsset",
  "carrierRoot",
  "memberPath",
]);
const BUNDLE_CARRIER_ASSET_KEYS = new Set([
  "name",
  "path",
  "sha256",
  "bytes",
  "family",
  "target",
  "kind",
  "memberCount",
]);

class CliFailure extends Error {
  constructor(message, code = 1) {
    super(message);
    this.code = code;
  }
}

function fail(message, code = 1) {
  throw new CliFailure(message, code);
}

function usage() {
  fail(
    "usage: mobile-extension-artifact-paths.mjs --root PATH --artifact-root PATH --materialize-root PATH --extensions CSV --asset-kind runtime|ios-xcframework --asset-target TARGET|* --required 0|1",
    2,
  );
}

function parseOptions(args) {
  if (args.length % 2 !== 0) {
    usage();
  }
  const options = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!OPTION_NAMES.has(name)) {
      fail(`unknown option: ${name}`, 2);
    }
    if (options.has(name)) {
      fail(`duplicate option: ${name}`, 2);
    }
    if (value === undefined || value.startsWith("--")) {
      usage();
    }
    options.set(name, value);
  }
  for (const name of OPTION_NAMES) {
    if (!options.has(name)) {
      usage();
    }
  }
  return options;
}

function isObject(value) {
  return value !== null && !Array.isArray(value) && typeof value === "object";
}

function requireExactKeys(value, expected, context) {
  if (!isObject(value)) {
    fail(`${context} must be an object`);
  }
  const actual = Object.keys(value).sort(compareText);
  const canonical = [...expected].sort(compareText);
  if (!isDeepStrictEqual(actual, canonical)) {
    fail(
      `${context} fields must be exactly ${canonical.join(",")}; got ${actual.join(",")}`,
    );
  }
}

function isFile(file) {
  try {
    const metadata = lstatSync(file);
    return metadata.isFile() && !metadata.isSymbolicLink();
  } catch {
    return false;
  }
}

async function sha256File(file) {
  return await new Promise((resolve, reject) => {
    const digest = createHash("sha256");
    const stream = createReadStream(file);
    stream.on("data", (chunk) => digest.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(digest.digest("hex")));
  });
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function safeComponent(value, context) {
  if (
    typeof value !== "string"
    || value.length === 0
    || value === "."
    || value === ".."
    || value.includes("/")
    || value.includes("\\")
    || value.includes("\0")
  ) {
    fail(`${context} must be a safe non-empty path component`);
  }
  return value;
}

function safeArchiveMember(value, context) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\\") || value.includes("\0")) {
    fail(`${context} must be a safe relative archive path`);
  }
  const parts = value.split("/");
  if (value.startsWith("/") || parts.some((part) => part.length === 0 || part === "." || part === "..")) {
    fail(`${context} must be a safe relative archive path`);
  }
  return value;
}

function validatePublishedPath(value, name, context) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\\") || value.includes("\0")) {
    fail(`${context} must declare a release-assets path`);
  }
  const suffix = `/release-assets/${name}`;
  if (value !== `release-assets/${name}` && !value.endsWith(suffix)) {
    fail(`${context} must point to release-assets/${name}`);
  }
}

function validateDigestRow(value, context) {
  if (!/^[0-9a-f]{64}$/u.test(value.sha256 ?? "")) {
    fail(`${context} must declare a lowercase SHA-256 digest`);
  }
  if (!Number.isSafeInteger(value.bytes) || value.bytes <= 0) {
    fail(`${context} must declare a positive safe-integer byte count`);
  }
  if (value.bytes > MAX_ARTIFACT_BYTES) {
    fail(`${context} exceeds the maximum supported size of ${MAX_ARTIFACT_BYTES} bytes`);
  }
}

function canonicalStringList(value, context, validate = safeComponent) {
  if (!Array.isArray(value)) {
    fail(`${context} must be an array`);
  }
  const result = value.map((item, index) => validate(item, `${context}[${index}]`)).sort(compareText);
  if (new Set(result).size !== result.length) {
    fail(`${context} must not contain duplicates`);
  }
  return result;
}

function sqlFileName(value, context) {
  if (typeof value !== "string" || !/^[A-Za-z0-9._-]{1,128}$/u.test(value) || !value.endsWith(".sql")) {
    fail(`${context} must be a portable SQL basename ending in .sql`);
  }
  return value;
}

function sqlFilePrefix(value, context) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(value)) {
    fail(`${context} must be a dot-free portable SQL basename prefix`);
  }
  return value;
}

function parseIosDependencyContract(text, source) {
  const lines = text.split(/\r?\n/u).filter((line) => line.length > 0 && !line.startsWith("#"));
  if (lines.length === 0) fail(`${source} is empty`);
  const header = lines[0].split("\t");
  const sqlIndex = header.indexOf("sql-name");
  const dependenciesIndex = header.indexOf("ios-static-dependencies");
  if (sqlIndex < 0 || dependenciesIndex < 0) {
    fail(`${source} must declare sql-name and ios-static-dependencies columns`);
  }
  const result = new Map();
  for (const [index, line] of lines.slice(1).entries()) {
    const fields = line.split("\t");
    const sqlName = safeComponent(fields[sqlIndex], `${source}:${index + 2} sql-name`);
    const dependencies = canonicalStringList(
      (fields[dependenciesIndex] ?? "").split(",").filter(Boolean),
      `${source}:${index + 2} ios-static-dependencies`,
    );
    if (result.has(sqlName)) fail(`${source} repeats iOS dependency owner ${sqlName}`);
    result.set(sqlName, dependencies);
  }
  return result;
}

async function loadRepositoryContract(root) {
  const metadataPath = join(root, "src/extensions/generated/sdk/react-native.json");
  const iosDependenciesPath = join(root, "src/extensions/generated/mobile/static-extensions.tsv");
  const nativeVersionPath = join(root, "src/runtimes/liboliphaunt/native/VERSION");
  const wasixVersionPath = join(root, "src/runtimes/liboliphaunt/wasix/VERSION");
  let metadata;
  let iosDependenciesText;
  let nativeRuntimeVersion;
  let wasixRuntimeVersion;
  try {
    [metadata, iosDependenciesText, nativeRuntimeVersion, wasixRuntimeVersion] = await Promise.all([
      readFile(metadataPath, "utf8").then((value) => JSON.parse(value)),
      readFile(iosDependenciesPath, "utf8"),
      readFile(nativeVersionPath, "utf8").then((value) => value.trim()),
      readFile(wasixVersionPath, "utf8").then((value) => value.trim()),
    ]);
  } catch (error) {
    fail(`could not load generated mobile extension ownership and runtime versions: ${error.message}`);
  }
  if (!STABLE_SEMVER.test(nativeRuntimeVersion) || !STABLE_SEMVER.test(wasixRuntimeVersion)) {
    fail("native and WASIX runtime VERSION files must contain stable SemVer");
  }
  if (!isObject(metadata) || !Array.isArray(metadata.extensions)) {
    fail(`${metadataPath} must declare extensions`);
  }
  const iosDependencies = parseIosDependencyContract(iosDependenciesText, iosDependenciesPath);
  const products = new Map();
  const sqlOwners = new Map();
  for (const [index, row] of metadata.extensions.entries()) {
    if (!isObject(row)) {
      fail(`${metadataPath} extension ${index} must be an object`);
    }
    const sqlName = safeComponent(row["sql-name"], `${metadataPath} extension ${index} sql-name`);
    const product = safeComponent(row["release-product"], `${metadataPath} extension ${sqlName} release-product`);
    if (sqlOwners.has(sqlName)) {
      fail(`${metadataPath} repeats SQL extension owner ${sqlName}`);
    }
    sqlOwners.set(sqlName, product);
    const postgresMajor = String(row["postgres-major"] ?? "");
    if (!/^[1-9][0-9]*$/u.test(postgresMajor)) {
      fail(`${metadataPath} extension ${sqlName} has invalid postgres-major`);
    }
    if (typeof row["creates-extension"] !== "boolean") {
      fail(`${metadataPath} extension ${sqlName} creates-extension must be boolean`);
    }
    if (typeof row["mobile-release-ready"] !== "boolean" || typeof row["desktop-release-ready"] !== "boolean") {
      fail(`${metadataPath} extension ${sqlName} release readiness flags must be boolean`);
    }
    const nativeModuleStem = row["native-module-stem"] === null
      ? null
      : safeComponent(row["native-module-stem"], `${metadataPath} extension ${sqlName} native-module-stem`);
    const generatedIosDependencies = canonicalStringList(
      row["ios-static-dependencies"],
      `${metadataPath} extension ${sqlName} ios-static-dependencies`,
    );
    const staticIosDependencies = iosDependencies.get(sqlName)
      ?? (nativeModuleStem === null
        ? []
        : fail(`${iosDependenciesPath} has no row for native extension ${sqlName}`));
    if (!isDeepStrictEqual(generatedIosDependencies, staticIosDependencies)) {
      fail(`${metadataPath} and ${iosDependenciesPath} disagree for iOS dependencies of ${sqlName}`);
    }
    if (nativeModuleStem === null && generatedIosDependencies.length > 0) {
      fail(`${metadataPath} SQL-only extension ${sqlName} must not declare iOS dependencies`);
    }
    const dependencies = canonicalStringList(
      row["selected-extension-dependencies"],
      `${metadataPath} extension ${sqlName} selected-extension-dependencies`,
    );
    if (dependencies.includes(sqlName)) {
      fail(`${metadataPath} extension ${sqlName} must not depend on itself`);
    }
    const canonical = {
      sqlName,
      createsExtension: row["creates-extension"],
      dependencies,
      dataFiles: canonicalStringList(
        row["runtime-share-data-files"],
        `${metadataPath} extension ${sqlName} runtime-share-data-files`,
        safeArchiveMember,
      ),
      extensionSqlFileNames: canonicalStringList(
        row["extension-sql-file-names"],
        `${metadataPath} extension ${sqlName} extension-sql-file-names`,
        sqlFileName,
      ),
      extensionSqlFilePrefixes: canonicalStringList(
        row["extension-sql-file-prefixes"],
        `${metadataPath} extension ${sqlName} extension-sql-file-prefixes`,
        sqlFilePrefix,
      ),
      nativeDependencies: canonicalStringList(
        row["native-dependencies"],
        `${metadataPath} extension ${sqlName} native-dependencies`,
      ),
      nativeModuleStem,
      canonicalIosNativeDependencies: generatedIosDependencies,
      sharedPreloadLibraries: canonicalStringList(
        row["shared-preload-libraries"],
        `${metadataPath} extension ${sqlName} shared-preload-libraries`,
      ),
      mobileReleaseReady: row["mobile-release-ready"],
      desktopReleaseReady: row["desktop-release-ready"],
    };
    const owner = products.get(product) ?? { members: new Map(), postgresMajor, sqlNames: [] };
    if (owner.postgresMajor !== postgresMajor) {
      fail(`${metadataPath} product ${product} spans multiple PostgreSQL majors`);
    }
    owner.sqlNames.push(sqlName);
    owner.members.set(sqlName, canonical);
    products.set(product, owner);
  }
  for (const owner of products.values()) {
    owner.sqlNames.sort(compareText);
  }
  return { nativeRuntimeVersion, products, wasixRuntimeVersion };
}

function validateCompatibility(manifest, manifestPath, repositoryContract) {
  const owner = repositoryContract.products.get(manifest.product);
  if (owner === undefined) {
    fail(`${manifestPath} product ${manifest.product} has no generated React Native extension owner`);
  }
  const expected = {
    extensionRuntimeContract: "src/shared/extension-runtime-contract/contract.toml",
    nativeRuntimeProduct: "liboliphaunt-native",
    nativeRuntimeVersion: repositoryContract.nativeRuntimeVersion,
    postgresMajor: owner.postgresMajor,
    wasixRuntimeProduct: "liboliphaunt-wasix",
    wasixRuntimeVersion: repositoryContract.wasixRuntimeVersion,
  };
  if (!isDeepStrictEqual(manifest.compatibility, expected)) {
    fail(`${manifestPath} compatibility metadata must exactly match the generated runtime contract`);
  }
  return owner;
}

function validateIdentity(asset, context) {
  if (asset.kind === "runtime") {
    if (asset.identity !== null) {
      fail(`${context} runtime identity must be null`);
    }
    return;
  }
  if (asset.kind === "ios-dependency-xcframework") {
    if (typeof asset.identity !== "string" || asset.identity.length === 0) {
      fail(`${context} iOS dependency identity must be a non-empty string`);
    }
    return;
  }
  if (asset.kind === "ios-xcframework") {
    if (!(asset.identity === null || typeof asset.identity === "string" && asset.identity.length > 0)) {
      fail(`${context} iOS XCFramework identity must be null or a non-empty string`);
    }
    return;
  }
  if (asset.identity !== null) {
    fail(`${context} identity must be null for kind=${asset.kind}`);
  }
}

function validateIosRegistration(value, expected, context) {
  if (!isObject(value)) {
    fail(`${context} must contain build-derived iOS registration metadata`);
  }
  requireExactKeys(
    value,
    new Set(["initSymbol", "magicSymbol", "nativeModuleStem", "schema", "sqlName", "symbols"]),
    context,
  );
  const prefix = `oliphaunt_static_${expected.nativeModuleStem.replaceAll(/[^A-Za-z0-9_]/gu, "_")}`;
  if (
    value.schema !== "oliphaunt-ios-extension-registration-v1"
    || value.sqlName !== expected.sqlName
    || value.nativeModuleStem !== expected.nativeModuleStem
    || value.magicSymbol !== `${prefix}_Pg_magic_func`
    || ![null, `${prefix}__PG_init`].includes(value.initSymbol)
    || !C_IDENTIFIER.test(value.magicSymbol)
    || !(value.initSymbol === null || C_IDENTIFIER.test(value.initSymbol))
    || !Array.isArray(value.symbols)
  ) {
    fail(`${context} does not match canonical native module identity ${expected.sqlName}/${expected.nativeModuleStem}`);
  }
  const normalized = value.symbols.map((row, index) => {
    requireExactKeys(row, new Set(["address", "name"]), `${context}.symbols[${index}]`);
    if (!C_IDENTIFIER.test(row.name ?? "") || !C_IDENTIFIER.test(row.address ?? "")) {
      fail(`${context}.symbols[${index}] must map canonical C identifiers`);
    }
    return `${row.name}\0${row.address}`;
  });
  if (
    new Set(value.symbols.map(({ name }) => name)).size !== value.symbols.length
    || !isDeepStrictEqual(normalized, [...normalized].sort(compareText))
  ) {
    fail(`${context}.symbols must be sorted with unique public names`);
  }
}

function expectedMobileRoles(member, target) {
  const roles = ["runtime:"];
  if (target === "ios-xcframework" && member.nativeModuleStem !== null) {
    roles.push(`ios-xcframework:${member.nativeModuleStem}`);
    roles.push(...member.iosNativeDependencies.map((dependency) =>
      `ios-dependency-xcframework:${dependency}`));
  }
  return roles.sort(compareText);
}

function validateExactMobileRoles(member, target, assets, context) {
  const actual = assets.map((asset, index) => {
    const assetContext = `${context} asset ${index}`;
    safeComponent(asset.name, `${assetContext} name`);
    validateDigestRow(asset, assetContext);
    if (asset.family !== "native" || asset.target !== target) {
      fail(`${assetContext} must belong to native/${target}`);
    }
    validateIdentity(asset, assetContext);
    return `${asset.kind}:${asset.identity ?? ""}`;
  }).sort(compareText);
  const expected = expectedMobileRoles(member, target);
  if (!isDeepStrictEqual(actual, expected)) {
    fail(
      `${context} mobile artifact roles are not exact and dependency-closed: ` +
      `expected=${JSON.stringify(expected)}, actual=${JSON.stringify(actual)}`,
    );
  }
}

function validateMemberContract(member, expected, context) {
  for (const field of [
    "sqlName",
    "createsExtension",
    "dependencies",
    "dataFiles",
    "extensionSqlFileNames",
    "extensionSqlFilePrefixes",
    "nativeDependencies",
    "nativeModuleStem",
    "sharedPreloadLibraries",
    "mobileReleaseReady",
    "desktopReleaseReady",
  ]) {
    if (!isDeepStrictEqual(member[field], expected[field])) {
      fail(`${context}.${field} must exactly match generated React Native extension metadata`);
    }
  }
  if (!Array.isArray(member.assets)) fail(`${context}.assets must be an array`);
  const mobileGroups = new Map();
  for (const [index, asset] of member.assets.entries()) {
    if (!isObject(asset) || !MOBILE_TARGETS.has(asset.target)) continue;
    if (asset.family !== "native") {
      fail(`${context}.assets[${index}] mobile target ${asset.target} must use the native family`);
    }
    const group = mobileGroups.get(asset.target) ?? [];
    group.push(asset);
    mobileGroups.set(asset.target, group);
  }
  const stagesIos = mobileGroups.has("ios-xcframework");
  const expectedIosDependencies = stagesIos && expected.nativeModuleStem !== null
    ? expected.canonicalIosNativeDependencies
    : [];
  if (!isDeepStrictEqual(member.iosNativeDependencies, expectedIosDependencies)) {
    fail(`${context}.iosNativeDependencies must exactly match the canonical staged iOS dependency closure`);
  }
  if (expected.nativeModuleStem === null || !stagesIos) {
    if (member.iosRegistration !== null) {
      fail(`${context}.iosRegistration must be null without a staged native iOS module`);
    }
  } else {
    validateIosRegistration(member.iosRegistration, expected, `${context}.iosRegistration`);
  }
  for (const [target, assets] of mobileGroups) {
    validateExactMobileRoles(member, target, assets, `${context} ${target}`);
  }
}

async function manifestPaths(artifactRoot) {
  const entries = await readdir(artifactRoot, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(artifactRoot, entry.name, "extension-artifacts.json"))
    .filter((file) => isFile(file))
    .sort(compareText);
}

function assetMatches(asset, assetKind, assetTarget) {
  if (!isObject(asset) || asset.family !== "native") {
    return false;
  }
  if (assetTarget !== "*" && asset.target !== assetTarget) {
    return false;
  }
  return asset.kind === assetKind;
}

function validateManifestEnvelope(manifest, manifestPath, repositoryContract, members) {
  safeComponent(manifest.product, `${manifestPath} product`);
  if (!STABLE_SEMVER.test(manifest.version ?? "")) {
    fail(`${manifestPath} version must be stable SemVer`);
  }
  const owner = validateCompatibility(manifest, manifestPath, repositoryContract);
  const actualSqlNames = members.map((member) => member?.sqlName);
  if (new Set(actualSqlNames).size !== actualSqlNames.length) {
    fail(`${manifestPath} repeats an extension SQL identity`);
  }
  if (!isDeepStrictEqual(actualSqlNames, owner.sqlNames)) {
    fail(
      `${manifestPath} member set must exactly match generated owner ${manifest.product}: `
      + `expected=${JSON.stringify(owner.sqlNames)}, actual=${JSON.stringify(actualSqlNames)}`,
    );
  }
  for (const [index, member] of members.entries()) {
    const expected = owner.members.get(member.sqlName);
    if (expected === undefined) {
      fail(`${manifestPath} extension member ${index} has no generated React Native owner metadata`);
    }
    validateMemberContract(member, expected, `${manifestPath} extension member ${member.sqlName}`);
  }
}

function manifestMembers(manifest, manifestPath, repositoryContract) {
  if (!isObject(manifest)) {
    fail(`${manifestPath} must contain an extension artifact manifest object`);
  }
  let members;
  if (manifest.schema === "oliphaunt-extension-ci-artifacts-v1") {
    requireExactKeys(manifest, DIRECT_MANIFEST_KEYS, manifestPath);
    if (!Array.isArray(manifest.assets)) {
      fail(`${manifestPath} must declare an assets array`);
    }
    for (const [index, asset] of manifest.assets.entries()) {
      requireExactKeys(asset, DIRECT_ASSET_KEYS, `${manifestPath} asset ${index}`);
    }
    members = [manifest];
  } else if (manifest.schema === "oliphaunt-extension-ci-artifacts-v2") {
    requireExactKeys(manifest, BUNDLE_MANIFEST_KEYS, manifestPath);
    if (!Array.isArray(manifest.extensions) || manifest.extensions.length === 0) {
      fail(`${manifestPath} must declare a non-empty extensions array`);
    }
    for (const [index, member] of manifest.extensions.entries()) {
      requireExactKeys(member, EXTENSION_MEMBER_KEYS, `${manifestPath} extension member ${index}`);
      if (!Array.isArray(member.assets)) {
        fail(`${manifestPath} extension member ${index} must declare an assets array`);
      }
      for (const [assetIndex, asset] of member.assets.entries()) {
        requireExactKeys(
          asset,
          BUNDLE_MEMBER_ASSET_KEYS,
          `${manifestPath} extension member ${index} asset ${assetIndex}`,
        );
      }
    }
    if (!Array.isArray(manifest.carrierAssets)) {
      fail(`${manifestPath} must declare a carrierAssets array`);
    }
    for (const [index, carrier] of manifest.carrierAssets.entries()) {
      requireExactKeys(carrier, BUNDLE_CARRIER_ASSET_KEYS, `${manifestPath} aggregate carrier ${index}`);
    }
    members = manifest.extensions;
  } else {
    fail(`${manifestPath} has unsupported extension artifact schema ${JSON.stringify(manifest.schema)}`);
  }
  validateManifestEnvelope(manifest, manifestPath, repositoryContract, members);
  return members;
}

function validateDirectAsset(asset, entry, sqlName) {
  const context = `${entry.manifestPath} ${asset.kind} asset for ${sqlName}`;
  requireExactKeys(asset, DIRECT_ASSET_KEYS, context);
  safeComponent(asset.name, `${context} name`);
  validateDigestRow(asset, context);
  validateIdentity(asset, context);
  validatePublishedPath(asset.path, asset.name, context);
}

function validateBundleCarrier(manifest, manifestPath, carrier) {
  const context = `${manifestPath} aggregate carrier`;
  requireExactKeys(carrier, BUNDLE_CARRIER_ASSET_KEYS, context);
  safeComponent(carrier.name, `${context} name`);
  safeComponent(carrier.target, `${context} target`);
  validateDigestRow(carrier, `${context} ${carrier.name}`);
  if (
    !Number.isSafeInteger(carrier.memberCount) || carrier.memberCount <= 0
    || carrier.memberCount > MAX_BUNDLE_MEMBERS
  ) {
    fail(`${context} ${carrier.name} must declare a bounded positive memberCount`);
  }
  if (carrier.kind !== "extension-bundle" || carrier.family !== "native") {
    fail(`${context} ${carrier.name} must be a native extension-bundle`);
  }
  if (!MOBILE_TARGETS.has(carrier.target)) {
    fail(`${context} ${carrier.name} has unsupported mobile target ${JSON.stringify(carrier.target)}`);
  }
  const expectedName = `${manifest.product}-${manifest.version}-${carrier.family}-${carrier.target}-bundle.tar.gz`;
  if (carrier.name !== expectedName) {
    fail(`${context} ${carrier.name} must use canonical name ${expectedName}`);
  }
  validatePublishedPath(carrier.path, carrier.name, `${context} ${carrier.name}`);
}

function bundleCarrierFor(entry, asset) {
  const carriers = Array.isArray(entry.manifest.carrierAssets)
    ? entry.manifest.carrierAssets.filter((carrier) =>
        isObject(carrier)
        && carrier.family === asset.family
        && carrier.target === asset.target
        && carrier.kind === "extension-bundle"
      )
    : [];
  if (carriers.length !== 1) {
    fail(
      `${entry.manifestPath} must declare exactly one native extension-bundle carrier for ${asset.target}, got ${carriers.length}`,
    );
  }
  const carrier = carriers[0];
  validateBundleCarrier(entry.manifest, entry.manifestPath, carrier);
  if (asset.carrierAsset !== carrier.name) {
    fail(`${entry.manifestPath} ${entry.sqlName} asset references the wrong aggregate carrier`);
  }
  return carrier;
}

function validateBundleMemberAsset({ manifestPath, carrier, member, asset }) {
  const context = `${manifestPath} aggregate member ${member.sqlName}/${asset?.kind ?? "unknown"}`;
  requireExactKeys(asset, BUNDLE_MEMBER_ASSET_KEYS, context);
  safeComponent(asset.name, `${context} name`);
  validateDigestRow(asset, context);
  if (asset.family !== carrier.family || asset.target !== carrier.target) {
    fail(`${context} must match carrier ${carrier.family}/${carrier.target}`);
  }
  const allowedKinds = carrier.target === "ios-xcframework"
    ? new Set(["runtime", "ios-xcframework", "ios-dependency-xcframework"])
    : new Set(["runtime"]);
  if (!allowedKinds.has(asset.kind)) {
    fail(`${context} has invalid kind for ${carrier.target}`);
  }
  validateIdentity(asset, context);
  if (asset.carrierAsset !== carrier.name) {
    fail(`${context} references the wrong aggregate carrier`);
  }
  const expectedRoot = carrier.name.replace(/\.tar\.gz$/u, "");
  const expectedMemberPath = `extensions/${member.sqlName}/${asset.name}`;
  if (asset.carrierRoot !== expectedRoot || asset.memberPath !== expectedMemberPath) {
    fail(`${context} has a noncanonical nested locator`);
  }
  safeArchiveMember(`${asset.carrierRoot}/${asset.memberPath}`, `${context} locator`);
  return {
    sqlName: member.sqlName,
    kind: asset.kind,
    identity: asset.identity,
    path: asset.memberPath,
    sha256: asset.sha256,
    bytes: asset.bytes,
  };
}

function expectedBundleManifest(manifest, manifestPath, carrier) {
  const rows = [];
  const allSqlNames = [];
  const identities = new Set();
  const roles = new Set();
  const memberPaths = new Set();
  for (const member of manifest.extensions) {
    if (!isObject(member)) {
      fail(`${manifestPath} aggregate member must be an object`);
    }
    const sqlName = safeComponent(member.sqlName, `${manifestPath} aggregate member sqlName`);
    allSqlNames.push(sqlName);
    const assets = Array.isArray(member.assets) ? member.assets : [];
    const carrierAssets = assets.filter((asset) =>
      isObject(asset) && asset.family === carrier.family && asset.target === carrier.target
    );
    if (carrierAssets.length === 0) {
      fail(`${manifestPath} aggregate carrier ${carrier.name} is missing exact member ${sqlName}`);
    }
    validateExactMobileRoles(
      member,
      carrier.target,
      carrierAssets,
      `${manifestPath} aggregate carrier ${carrier.name} member ${sqlName}`,
    );
    for (const asset of carrierAssets) {
      const row = validateBundleMemberAsset({ manifestPath, carrier, member, asset });
      const identityKey = `${row.sqlName}\0${row.kind}\0${row.path}`;
      if (identities.has(identityKey)) {
        fail(`${manifestPath} aggregate carrier ${carrier.name} repeats member identity ${sqlName}/${row.kind}/${row.path}`);
      }
      identities.add(identityKey);
      const roleKey = `${row.sqlName}\0${row.kind}\0${row.identity ?? ""}`;
      if (roles.has(roleKey)) {
        fail(`${manifestPath} aggregate carrier ${carrier.name} repeats member role ${sqlName}/${row.kind}/${row.identity ?? ""}`);
      }
      roles.add(roleKey);
      if (memberPaths.has(row.path)) {
        fail(`${manifestPath} aggregate carrier ${carrier.name} repeats nested member path ${row.path}`);
      }
      memberPaths.add(row.path);
      rows.push(row);
    }
    for (const asset of assets) {
      if (isObject(asset) && asset.carrierAsset === carrier.name && !carrierAssets.includes(asset)) {
        fail(`${manifestPath} aggregate carrier ${carrier.name} contains a member with the wrong family/target`);
      }
    }
  }
  if (new Set(allSqlNames).size !== allSqlNames.length) {
    fail(`${manifestPath} aggregate manifest repeats an extension SQL identity`);
  }
  if (carrier.memberCount !== allSqlNames.length) {
    fail(`${manifestPath} aggregate carrier ${carrier.name} must declare memberCount=${allSqlNames.length}`);
  }
  rows.sort((left, right) => compareText(
    `${left.sqlName}\0${left.kind}\0${left.identity ?? ""}`,
    `${right.sqlName}\0${right.kind}\0${right.identity ?? ""}`,
  ));
  return {
    schema: "oliphaunt-extension-bundle-v1",
    product: manifest.product,
    version: manifest.version,
    compatibility: manifest.compatibility,
    family: carrier.family,
    target: carrier.target,
    members: rows,
  };
}

function runTar(args, context) {
  const result = captureCommandOutput("tar", args, {
    label: context,
    maxOutputBytes: 16 * 1024 * 1024,
  });
  if (result.error) {
    fail(`${context} failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = String(result.stderr ?? result.stdout ?? "").trim();
    fail(`${context} failed${detail ? `: ${detail}` : ""}`);
  }
  return String(result.stdout ?? "");
}

function sortValue(value) {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (isObject(value)) {
    return Object.fromEntries(
      Object.keys(value).sort(compareText).map((key) => [key, sortValue(value[key])]),
    );
  }
  return value;
}

function canonicalJson(value) {
  return `${JSON.stringify(sortValue(value), null, 2)}\n`;
}

function tarString(header, offset, length, carrierPath) {
  const field = header.subarray(offset, offset + length);
  const end = field.indexOf(0);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(field.subarray(0, end < 0 ? field.length : end));
  } catch {
    fail(`${carrierPath} contains a non-UTF-8 ustar header field`);
  }
}

function tarOctal(header, offset, length, field, carrierPath) {
  const value = header.subarray(offset, offset + length).toString("ascii").replaceAll("\0", "").trim();
  if (!/^[0-7]+$/u.test(value)) {
    fail(`${carrierPath} has invalid ustar ${field}`);
  }
  const parsed = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    fail(`${carrierPath} has unsafe ustar ${field}`);
  }
  return parsed;
}

function gzipHeader(carrierPath) {
  const header = Buffer.alloc(10);
  let descriptor;
  let bytes;
  try {
    descriptor = openSync(carrierPath, "r");
    bytes = readSync(descriptor, header, 0, header.length, 0);
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
  }
  const canonical = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03]);
  if (bytes !== header.length || !header.equals(canonical)) {
    fail(`${carrierPath} must use the canonical gzip method, flags, mtime, XFL, and OS header`);
  }
}

async function verifyCanonicalArchive(carrierPath, expectedSizes) {
  gzipHeader(carrierPath);
  const expectedNames = [...expectedSizes.keys()].sort(compareText);
  if (expectedNames.length > MAX_BUNDLE_MEMBERS + 1) {
    fail(`${carrierPath} exceeds the maximum supported bundle member count`);
  }
  const expectedTarBytes = [...expectedSizes.values()].reduce(
    (total, bytes) => total + 512 + Math.ceil(bytes / 512) * 512,
    1024,
  );
  if (!Number.isSafeInteger(expectedTarBytes) || expectedTarBytes > MAX_BUNDLE_EXPANDED_BYTES) {
    fail(`${carrierPath} declared ustar size exceeds the supported expanded bundle limit`);
  }
  const actualNames = [];
  let buffer = Buffer.alloc(0);
  let currentEntry = "archive header";
  let payloadRemaining = 0;
  let paddingRemaining = 0;
  let terminated = false;
  let totalBytes = 0;
  let zeroBlocks = 0;
  try {
    const stream = createReadStream(carrierPath).pipe(createGunzip());
    for await (const chunk of stream) {
      totalBytes += chunk.length;
      if (totalBytes > expectedTarBytes) {
        fail(`${carrierPath} expands beyond its exact declared ustar size`);
      }
      buffer = buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([buffer, chunk]);
      while (buffer.length > 0) {
        if (terminated) {
          if (!buffer.every((value) => value === 0)) {
            fail(`${carrierPath} has data after its ustar end marker`);
          }
          buffer = Buffer.alloc(0);
          break;
        }
        if (payloadRemaining > 0) {
          const consumed = Math.min(payloadRemaining, buffer.length);
          payloadRemaining -= consumed;
          buffer = buffer.subarray(consumed);
          continue;
        }
        if (paddingRemaining > 0) {
          const consumed = Math.min(paddingRemaining, buffer.length);
          if (!buffer.subarray(0, consumed).every((value) => value === 0)) {
            fail(`${carrierPath} member ${currentEntry} has nonzero ustar padding`);
          }
          paddingRemaining -= consumed;
          buffer = buffer.subarray(consumed);
          continue;
        }
        if (buffer.length < 512) {
          break;
        }
        const header = buffer.subarray(0, 512);
        buffer = buffer.subarray(512);
        if (header.every((value) => value === 0)) {
          zeroBlocks += 1;
          if (zeroBlocks === 2) {
            terminated = true;
          }
          continue;
        }
        if (zeroBlocks > 0) {
          fail(`${carrierPath} has an incomplete ustar end marker`);
        }
        if (
          !header.subarray(257, 263).equals(Buffer.from("ustar\0"))
          || !header.subarray(263, 265).equals(Buffer.from("00"))
        ) {
          fail(`${carrierPath} must use canonical POSIX ustar headers`);
        }
        const checksumField = header.subarray(148, 156).toString("latin1");
        if (!/^[0-7]{6}\0 $/u.test(checksumField)) {
          fail(`${carrierPath} has a noncanonical ustar checksum field`);
        }
        const expectedChecksum = tarOctal(header, 148, 8, "checksum", carrierPath);
        let actualChecksum = 0;
        for (let index = 0; index < 512; index += 1) {
          actualChecksum += index >= 148 && index < 156 ? 0x20 : header[index];
        }
        if (expectedChecksum !== actualChecksum) {
          fail(`${carrierPath} has an invalid ustar header checksum`);
        }
        const name = tarString(header, 0, 100, carrierPath);
        const prefix = tarString(header, 345, 155, carrierPath);
        const archiveName = safeArchiveMember(prefix ? `${prefix}/${name}` : name, `${carrierPath} member`);
        currentEntry = JSON.stringify(archiveName);
        if (header[156] !== 0x30) {
          fail(`${carrierPath} member ${archiveName} must be a canonical regular file`);
        }
        const mode = tarOctal(header, 100, 8, `mode for ${currentEntry}`, carrierPath);
        const uid = tarOctal(header, 108, 8, `uid for ${currentEntry}`, carrierPath);
        const gid = tarOctal(header, 116, 8, `gid for ${currentEntry}`, carrierPath);
        const size = tarOctal(header, 124, 12, `size for ${currentEntry}`, carrierPath);
        const mtime = tarOctal(header, 136, 12, `mtime for ${currentEntry}`, carrierPath);
        if (mode !== 0o644 || uid !== 0 || gid !== 0 || mtime !== 0) {
          fail(`${carrierPath} member ${archiveName} must use mode=0644 uid=0 gid=0 mtime=0`);
        }
        if (
          !header.subarray(157, 257).every((value) => value === 0)
          || !header.subarray(265, 345).every((value) => value === 0)
          || !header.subarray(500, 512).every((value) => value === 0)
        ) {
          fail(`${carrierPath} member ${archiveName} has noncanonical ustar metadata`);
        }
        const expectedSize = expectedSizes.get(archiveName);
        if (expectedSize === undefined || size !== expectedSize) {
          fail(`${carrierPath} member ${archiveName} is undeclared or has the wrong ustar size`);
        }
        if (actualNames.includes(archiveName)) {
          fail(`${carrierPath} contains duplicate bundle member ${archiveName}`);
        }
        actualNames.push(archiveName);
        payloadRemaining = size;
        paddingRemaining = (512 - size % 512) % 512;
      }
    }
  } catch (error) {
    if (error instanceof CliFailure) {
      throw error;
    }
    fail(`${carrierPath} is not a readable canonical gzip/ustar archive: ${error.message}`);
  }
  if (payloadRemaining > 0 || paddingRemaining > 0) {
    fail(`${carrierPath} has a truncated member ${currentEntry}`);
  }
  if (buffer.length > 0) {
    fail(`${carrierPath} has a truncated ustar header`);
  }
  if (!terminated || totalBytes !== expectedTarBytes || totalBytes % 512 !== 0) {
    fail(`${carrierPath} must end at its exact two-block ustar marker`);
  }
  if (!isDeepStrictEqual(actualNames, expectedNames)) {
    fail(`${carrierPath} contents do not exactly match its sorted declared bundle members`);
  }
}

async function verifyFrozenFile(file, row, context) {
  if (!isFile(file)) {
    fail(`${context} is missing or is not a regular non-symlink file`);
  }
  if (statSync(file).size !== row.bytes || await sha256File(file) !== row.sha256) {
    fail(`${context} does not match its frozen size/digest`);
  }
}

function cacheMetadata(file) {
  try {
    return lstatSync(file);
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

function requireCacheDirectory(materializeRoot, directory) {
  const root = resolve(materializeRoot);
  const target = resolve(directory);
  const suffix = relative(root, target);
  if (suffix === ".." || suffix.startsWith(`..${sep}`)) {
    fail(`cache directory escapes materialization root: ${target}`);
  }

  mkdirSync(root, { recursive: true, mode: 0o700 });
  const rootMetadata = cacheMetadata(root);
  if (rootMetadata?.isSymbolicLink() || rootMetadata?.isDirectory() !== true) {
    fail(`materialization cache root must be a real directory, not a symlink: ${root}`);
  }

  let current = root;
  for (const component of suffix.split(sep).filter(Boolean)) {
    current = join(current, component);
    let metadata = cacheMetadata(current);
    if (metadata === undefined) {
      try {
        mkdirSync(current, { mode: 0o700 });
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
      }
      metadata = cacheMetadata(current);
    }
    if (metadata?.isSymbolicLink() || metadata?.isDirectory() !== true) {
      fail(`materialization cache path component must be a real directory, not a symlink: ${current}`);
    }
  }
  return target;
}

async function installCacheFile(source, destination, row, context, materializeRoot) {
  requireCacheDirectory(materializeRoot, dirname(destination));
  const destinationMetadata = cacheMetadata(destination);
  if (destinationMetadata?.isSymbolicLink()) {
    fail(`materialization cache destination must not be a symlink: ${destination}`);
  }
  if (destinationMetadata !== undefined && !destinationMetadata.isFile()) {
    fail(`materialization cache destination must be a regular file: ${destination}`);
  }
  if (destinationMetadata?.isFile()) {
    if (statSync(destination).size === row.bytes && await sha256File(destination) === row.sha256) {
      return destination;
    }
    rmSync(destination, { force: true });
  }
  const beforeRename = cacheMetadata(destination);
  if (beforeRename?.isSymbolicLink() || beforeRename !== undefined) {
    fail(`materialization cache destination changed while being prepared: ${destination}`);
  }
  renameSync(source, destination);
  chmodSync(destination, 0o644);
  await verifyFrozenFile(destination, row, `${context} after cache materialization`);
  return destination;
}

async function materializeDirectAsset(entry, asset, source, materializeRoot) {
  const safeMaterializeRoot = requireCacheDirectory(materializeRoot, materializeRoot);
  const destination = join(
    safeMaterializeRoot,
    entry.manifest.product,
    "direct",
    asset.family,
    asset.target,
    asset.sha256,
    entry.sqlName,
    asset.name,
  );
  const stage = mkdtempSync(join(safeMaterializeRoot, ".direct-"));
  try {
    const snapshot = join(stage, asset.name);
    copyFileSync(source, snapshot);
    chmodSync(snapshot, 0o600);
    await verifyFrozenFile(snapshot, asset, `${entry.manifestPath} immutable snapshot for ${entry.sqlName}`);
    await verifyFrozenFile(source, asset, `${entry.manifestPath} direct source for ${entry.sqlName} after snapshot`);
    return await installCacheFile(
      snapshot,
      destination,
      asset,
      `${entry.manifestPath} direct asset for ${entry.sqlName}`,
      safeMaterializeRoot,
    );
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

async function materializeBundlePlan(plan, materializeRoot) {
  const { manifest, manifestPath, carrier } = plan;
  const expected = expectedBundleManifest(manifest, manifestPath, carrier);
  const expectedText = canonicalJson(expected);
  const carrierRoot = carrier.name.replace(/\.tar\.gz$/u, "");
  const carrierPath = join(dirname(manifestPath), "release-assets", carrier.name);
  await verifyFrozenFile(carrierPath, carrier, `${manifestPath} aggregate carrier ${carrier.name}`);
  const safeMaterializeRoot = requireCacheDirectory(materializeRoot, materializeRoot);
  const stage = mkdtempSync(join(safeMaterializeRoot, ".extract-"));
  try {
    // All structural validation and extraction operate on this private verified
    // snapshot, so a mutable release-assets path cannot be swapped between the
    // validation and extraction opens.
    const carrierSnapshot = join(stage, carrier.name);
    copyFileSync(carrierPath, carrierSnapshot);
    chmodSync(carrierSnapshot, 0o600);
    await verifyFrozenFile(
      carrierSnapshot,
      carrier,
      `${manifestPath} aggregate carrier ${carrier.name} immutable snapshot`,
    );
    await verifyFrozenFile(
      carrierPath,
      carrier,
      `${manifestPath} aggregate carrier ${carrier.name} after snapshot`,
    );
    const expectedSizes = new Map([
      [`${carrierRoot}/bundle-manifest.json`, Buffer.byteLength(expectedText)],
      ...expected.members.map((member) => [`${carrierRoot}/${member.path}`, member.bytes]),
    ]);
    await verifyCanonicalArchive(carrierSnapshot, expectedSizes);
    const requestedNames = [
      `${carrierRoot}/bundle-manifest.json`,
      ...plan.selected.map(({ asset }) => `${asset.carrierRoot}/${asset.memberPath}`),
    ].sort(compareText);
    runTar(
      ["-xf", carrierSnapshot, "-C", stage, ...new Set(requestedNames)],
      `extract selected members from ${carrierSnapshot}`,
    );
    await verifyFrozenFile(
      carrierSnapshot,
      carrier,
      `${manifestPath} aggregate carrier ${carrier.name} immutable snapshot after extraction`,
    );

    const embeddedPath = join(stage, carrierRoot, "bundle-manifest.json");
    if (!isFile(embeddedPath)) {
      fail(`${carrierPath} is missing a regular bundle-manifest.json`);
    }
    let embedded;
    try {
      embedded = JSON.parse(readFileSync(embeddedPath, "utf8"));
    } catch (error) {
      fail(`${carrierPath} has invalid bundle-manifest.json: ${error.message}`);
    }
    if (readFileSync(embeddedPath, "utf8") !== expectedText || !isDeepStrictEqual(embedded, expected)) {
      fail(`${carrierPath} bundle-manifest.json does not exactly describe its product, compatibility, target, and nested members`);
    }

    for (const selected of plan.selected) {
      const source = join(stage, selected.asset.carrierRoot, ...selected.asset.memberPath.split("/"));
      await verifyFrozenFile(
        source,
        selected.asset,
        `${carrierPath} nested member ${selected.asset.carrierRoot}/${selected.asset.memberPath}`,
      );
      const destination = join(
        safeMaterializeRoot,
        manifest.product,
        carrier.family,
        carrier.target,
        carrier.sha256,
        selected.sqlName,
        selected.asset.name,
      );
      selected.destination = await installCacheFile(
        source,
        destination,
        selected.asset,
        `${carrierPath} nested member ${selected.asset.memberPath}`,
        safeMaterializeRoot,
      );
    }
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

async function main() {
  const options = parseOptions(Bun.argv.slice(2));
  const root = options.get("--root");
  const artifactRoot = options.get("--artifact-root");
  const materializeRoot = options.get("--materialize-root");
  const selected = options.get("--extensions")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const assetKind = options.get("--asset-kind");
  const assetTarget = options.get("--asset-target");
  const requiredValue = options.get("--required");
  if (!new Set(["runtime", "ios-xcframework"]).has(assetKind)) {
    fail(`unknown extension asset kind: ${assetKind}`, 2);
  }
  if (assetTarget !== "*" && !MOBILE_TARGETS.has(assetTarget)) {
    fail(`unknown mobile extension asset target: ${assetTarget}`, 2);
  }
  if (!new Set(["0", "1"]).has(requiredValue)) {
    usage();
  }
  const required = requiredValue === "1";
  if (new Set(selected).size !== selected.length) {
    fail("selected exact-extension list must not contain duplicates");
  }
  const repositoryContract = await loadRepositoryContract(root);

  const bySqlName = new Map();
  for (const manifestPath of await manifestPaths(artifactRoot)) {
    let manifest;
    try {
      manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    } catch (error) {
      fail(`${manifestPath} is not valid JSON: ${error.message}`);
    }
    for (const [index, member] of manifestMembers(manifest, manifestPath, repositoryContract).entries()) {
      if (!isObject(member)) {
        fail(`${manifestPath} extension member ${index} must be an object`);
      }
      const sqlName = safeComponent(member.sqlName, `${manifestPath} extension member ${index} sqlName`);
      if (bySqlName.has(sqlName)) {
        fail(`duplicate exact-extension artifact package for SQL extension ${sqlName}`);
      }
      bySqlName.set(sqlName, { manifestPath, manifest, member, sqlName });
    }
  }

  const resolved = new Array(selected.length);
  const missing = [];
  const bundlePlans = new Map();
  for (const [index, sqlName] of selected.entries()) {
    const entry = bySqlName.get(sqlName);
    if (entry === undefined) {
      missing.push(`${sqlName}: package`);
      continue;
    }
    const assets = Array.isArray(entry.member.assets) ? entry.member.assets : [];
    const matches = assets.filter((asset) => assetMatches(asset, assetKind, assetTarget));
    if (matches.length === 0) {
      missing.push(`${sqlName}: ${assetKind} asset`);
      continue;
    }
    if (matches.length !== 1) {
      fail(`${entry.manifestPath} must contain exactly one ${assetKind} asset for ${sqlName}, got ${matches.length}`);
    }
    const asset = matches[0];
    if (entry.manifest.schema === "oliphaunt-extension-ci-artifacts-v1") {
      validateDirectAsset(asset, entry, sqlName);
      const file = join(dirname(entry.manifestPath), "release-assets", asset.name);
      if (!isFile(file)) {
        missing.push(`${sqlName}: ${file}`);
        continue;
      }
      await verifyFrozenFile(file, asset, `${entry.manifestPath} ${assetKind} asset for ${sqlName}`);
      resolved[index] = await materializeDirectAsset(entry, asset, file, materializeRoot);
      continue;
    }

    const carrier = bundleCarrierFor(entry, asset);
    const key = `${entry.manifestPath}\0${carrier.name}`;
    const plan = bundlePlans.get(key) ?? {
      manifest: entry.manifest,
      manifestPath: entry.manifestPath,
      carrier,
      selected: [],
    };
    plan.selected.push({ index, sqlName, asset, destination: null });
    bundlePlans.set(key, plan);
  }

  for (const plan of bundlePlans.values()) {
    const carrierPath = join(dirname(plan.manifestPath), "release-assets", plan.carrier.name);
    if (!isFile(carrierPath)) {
      missing.push(`${plan.manifest.product}: ${carrierPath}`);
    }
  }
  if (missing.length > 0) {
    fail(`missing exact-extension artifact(s): ${missing.join(", ")}`, required ? 1 : 3);
  }

  for (const plan of bundlePlans.values()) {
    await materializeBundlePlan(plan, materializeRoot);
    for (const selectedAsset of plan.selected) {
      resolved[selectedAsset.index] = selectedAsset.destination;
    }
  }
  if (resolved.some((file) => typeof file !== "string" || file.length === 0)) {
    fail("internal error: exact-extension artifact selection was not fully resolved");
  }
  for (const file of resolved) {
    console.log(file);
  }
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(error instanceof CliFailure ? error.code : 1);
}
