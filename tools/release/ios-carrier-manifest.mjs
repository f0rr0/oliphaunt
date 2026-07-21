#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";

import {
  ROOT,
  compareText,
  tagPrefix,
} from "./release-graph.mjs";
import {
  currentProductVersionSync,
  extensionProductForSqlName,
  extensionSqlNames,
} from "./release-artifact-targets.mjs";
import { localWindowsTarInvocation } from "./tar-command.mjs";

export const IOS_CARRIER_SCHEMA = "oliphaunt-react-native-ios-carrier-v1";
export const IOS_CARRIER_FILENAME = "oliphaunt-react-native-ios-carriers.json";
export const SWIFT_EXTENSION_CARRIER_SCHEMA = "oliphaunt-swift-extension-carrier-v1";
export const DEFAULT_IOS_CARRIER = path.join(
  ROOT,
  "target/release/ios-carriers",
  IOS_CARRIER_FILENAME,
);

const DEFAULT_REPOSITORY = "f0rr0/oliphaunt";
const STABLE_SEMVER = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u;
const PORTABLE_IDENTIFIER = /^[A-Za-z0-9._-]{1,128}$/u;
const C_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/u;

function error(message) {
  return new Error(`ios-carrier-manifest: ${message}`);
}

function stableVersion(value, label) {
  if (typeof value !== "string" || !STABLE_SEMVER.test(value)) {
    throw error(`${label} must be a stable SemVer X.Y.Z version`);
  }
  return value;
}

function exactObjectKeys(value, expected, label) {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort(compareText);
  const canonical = [...expected].sort(compareText);
  if (JSON.stringify(actual) !== JSON.stringify(canonical)) {
    throw error(`${label} fields must be exactly ${canonical.join(",")}; got ${actual.join(",")}`);
  }
  return value;
}

function portableIdentifier(value, label) {
  if (typeof value !== "string" || !PORTABLE_IDENTIFIER.test(value)) {
    throw error(`${label} must be a portable identifier`);
  }
  return value;
}

function canonicalStringList(value, label, validate = portableIdentifier) {
  if (!Array.isArray(value)) throw error(`${label} must be an array`);
  const rows = value.map((item, index) => validate(item, `${label}[${index}]`));
  if (new Set(rows).size !== rows.length) throw error(`${label} must not contain duplicates`);
  const canonical = [...rows].sort(compareText);
  if (JSON.stringify(value) !== JSON.stringify(canonical)) {
    throw error(`${label} must be sorted in ordinal order`);
  }
  return canonical;
}

function compatibilityMetadata(value, label) {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw error(`${label} must be an object`);
  }
  const expectedKeys = [
    "extensionRuntimeContract",
    "nativeRuntimeProduct",
    "nativeRuntimeVersion",
    "postgresMajor",
    "wasixRuntimeProduct",
    "wasixRuntimeVersion",
  ];
  const actualKeys = Object.keys(value).sort(compareText);
  if (JSON.stringify(actualKeys) !== JSON.stringify([...expectedKeys].sort(compareText))) {
    throw error(`${label} must contain the exact stable compatibility fields`);
  }
  if (value.postgresMajor !== "18") throw error(`${label}.postgresMajor must be 18`);
  if (value.nativeRuntimeProduct !== "liboliphaunt-native") {
    throw error(`${label}.nativeRuntimeProduct must be liboliphaunt-native`);
  }
  if (value.wasixRuntimeProduct !== "liboliphaunt-wasix") {
    throw error(`${label}.wasixRuntimeProduct must be liboliphaunt-wasix`);
  }
  if (
    typeof value.extensionRuntimeContract !== "string" ||
    value.extensionRuntimeContract.length === 0
  ) {
    throw error(`${label}.extensionRuntimeContract must be a non-empty path`);
  }
  return {
    extensionRuntimeContract: value.extensionRuntimeContract,
    nativeRuntimeProduct: value.nativeRuntimeProduct,
    nativeRuntimeVersion: stableVersion(
      value.nativeRuntimeVersion,
      `${label}.nativeRuntimeVersion`,
    ),
    postgresMajor: value.postgresMajor,
    wasixRuntimeProduct: value.wasixRuntimeProduct,
    wasixRuntimeVersion: stableVersion(
      value.wasixRuntimeVersion,
      `${label}.wasixRuntimeVersion`,
    ),
  };
}

function validateRepository(repository) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) {
    throw error(`invalid GitHub repository ${repository}`);
  }
  return repository;
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function requireFile(file, label) {
  if (!existsSync(file) || !statSync(file).isFile()) {
    throw error(`missing ${label}: ${path.relative(ROOT, file)}`);
  }
  return file;
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort(compareText).map((key) => [key, stable(value[key])]));
  }
  return value;
}

export function iosCarrierArchiveListInvocation(
  file,
  format,
  {
    cwd = ROOT,
    platform = process.platform,
    pathApi = platform === "win32" ? path.win32 : path,
  } = {},
) {
  if (format === "tar.gz") {
    const invocation = localWindowsTarInvocation(["-tzf", file], {
      cwd,
      platform,
      pathApi,
    });
    return { command: "tar", ...invocation };
  }
  if (format !== "zip") throw error(`unsupported archive listing format ${format}`);

  const invocation = { command: "unzip", args: ["-Z1", file], cwd };
  if (!pathApi.isAbsolute(file)) {
    if (platform === "win32" && file.includes(":")) {
      throw error(`ZIP archive path must not use a drive-relative or alternate-stream form: ${file}`);
    }
    return invocation;
  }
  const basename = pathApi.basename(file);
  if (basename.length === 0 || basename === pathApi.parse(file).root) {
    throw error(`ZIP archive path does not name a file: ${file}`);
  }
  invocation.cwd = pathApi.dirname(file);
  invocation.args[1] = basename;
  return invocation;
}

function listArchive(file, format) {
  const invocation = iosCarrierArchiveListInvocation(file, format);
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: invocation.cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error !== undefined || result.status !== 0) {
    throw error(`cannot inspect ${path.basename(file)}: ${(result.stderr || result.error?.message || "").trim()}`);
  }
  const members = result.stdout
    .split(/\r?\n/u)
    .map((value) => value.replace(/^\.\//u, "").replace(/\/$/u, ""))
    .filter((value) => value.length > 0 && value !== ".");
  if (members.length === 0) throw error(`${path.basename(file)} is empty`);
  return members;
}

function verifyMember(file, format, member) {
  const members = listArchive(file, format);
  if (member === ".") return;
  if (!members.some((value) => value === member || value.startsWith(`${member}/`))) {
    throw error(`${path.basename(file)} is missing declared archive member ${member}`);
  }
}

function verifyFileMember(file, format, member, expected) {
  if (format !== "tar.gz") {
    throw error(`${path.basename(file)} aggregate carrier must be a tar.gz archive`);
  }
  if (
    !Number.isSafeInteger(expected.bytes)
    || expected.bytes <= 0
    || expected.bytes > 2 * 1024 * 1024 * 1024
    || typeof expected.sha256 !== "string"
    || !/^[0-9a-f]{64}$/u.test(expected.sha256)
  ) {
    throw error(`${path.basename(file)} declares invalid nested payload metadata for ${member}`);
  }
  const result = spawnSync("tar", ["-xOzf", path.basename(file), member], {
    cwd: path.dirname(file),
    encoding: null,
    maxBuffer: expected.bytes + (64 * 1024),
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error !== undefined || result.status !== 0 || !Buffer.isBuffer(result.stdout)) {
    const detail = Buffer.isBuffer(result.stderr) ? result.stderr.toString("utf8").trim() : result.error?.message ?? "";
    throw error(`${path.basename(file)} is missing or cannot read declared archive file ${member}${detail ? `: ${detail}` : ""}`);
  }
  const actualSha256 = createHash("sha256").update(result.stdout).digest("hex");
  if (result.stdout.length !== expected.bytes || actualSha256 !== expected.sha256) {
    throw error(`${path.basename(file)} nested payload ${member} does not match its declared bytes/SHA-256`);
  }
}

function portableAssetName(value, label = "release asset name") {
  if (
    typeof value !== "string"
    || value.length === 0
    || path.posix.basename(value) !== value
    || /[<>:"/\\|?*\u0000-\u001f\u007f]/u.test(value)
    || /[ .]$/u.test(value)
    || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(value)
  ) {
    throw error(`${label} is not a portable release asset filename: ${JSON.stringify(value)}`);
  }
  return value;
}

function archiveFormat(name, label = "release asset") {
  portableAssetName(name, `${label} name`);
  if (name.endsWith(".zip")) return "zip";
  if (name.endsWith(".tar.gz")) return "tar.gz";
  throw error(`${label} ${name} must be a .zip or .tar.gz archive`);
}

function safeArchivePath(value, label) {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.includes("\\")
    || value.startsWith("/")
    || /^[A-Za-z]:/u.test(value)
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw error(`${label} must be a safe POSIX archive path`);
  }
  const parts = value.replace(/^\.\//u, "").split("/");
  if (parts.some((part) => part.length === 0 || part === "." || part === "..")) {
    throw error(`${label} must be a safe POSIX archive path`);
  }
  return parts.join("/");
}

function assetUrl({ file, name, tag, repository, localUrls }) {
  if (localUrls) return pathToFileURL(file).href;
  return `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`;
}

function asset({ file, role, member, tag, repository, localUrls, verifyMembers }) {
  requireFile(file, `${role} asset`);
  const name = portableAssetName(path.basename(file), `${role} asset name`);
  const format = archiveFormat(name, `${role} asset`);
  if (verifyMembers) verifyMember(file, format, member);
  return {
    role,
    name,
    url: assetUrl({ file, name, tag, repository, localUrls }),
    sha256: sha256(file),
    bytes: statSync(file).size,
    format,
    member,
  };
}

function carrierEnvelope({ file, tag, repository, localUrls }) {
  requireFile(file, "carrier archive");
  const name = portableAssetName(path.basename(file), "carrier archive name");
  return {
    name,
    url: assetUrl({ file, name, tag, repository, localUrls }),
    sha256: sha256(file),
    bytes: statSync(file).size,
    format: archiveFormat(name, "carrier archive"),
  };
}

function baseCarrier({ baseAssetDir, repository, localUrls, verifyMembers }) {
  const product = "liboliphaunt-native";
  const version = currentProductVersionSync(product, "ios-carrier-manifest");
  const tag = `${tagPrefix(product, "ios-carrier-manifest")}${version}`;
  const rows = [
    {
      role: "base-xcframework",
      name: `liboliphaunt-${version}-apple-spm-xcframework.zip`,
      member: "liboliphaunt.xcframework",
    },
    {
      role: "runtime-resources",
      name: `liboliphaunt-${version}-runtime-resources.tar.gz`,
      member: "oliphaunt",
    },
    {
      role: "icu-data",
      name: `liboliphaunt-${version}-icu-data.tar.gz`,
      member: "share/icu",
    },
  ];
  return {
    product,
    version,
    tag,
    assets: rows.map((row) => asset({
      ...row,
      file: path.join(baseAssetDir, row.name),
      tag,
      repository,
      localUrls,
      verifyMembers,
    })),
  };
}

function frozenBaseCarrier(file) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(requireFile(path.resolve(file), "base carrier manifest"), "utf8"));
  } catch (cause) {
    throw error(`cannot read base carrier manifest ${file}: ${cause.message}`);
  }
  const base = manifest?.schema === IOS_CARRIER_SCHEMA ? manifest.base : manifest;
  const product = "liboliphaunt-native";
  const version = currentProductVersionSync(product, "ios-carrier-manifest");
  const tag = `${tagPrefix(product, "ios-carrier-manifest")}${version}`;
  if (base?.product !== product || base.version !== version || base.tag !== tag || !Array.isArray(base.assets)) {
    throw error(`${file} does not freeze the current ${product} base carrier`);
  }
  const expectedRoles = ["base-xcframework", "runtime-resources", "icu-data"];
  if (JSON.stringify(base.assets.map(({ role }) => role)) !== JSON.stringify(expectedRoles)) {
    throw error(`${file} base carrier roles must be exactly ${expectedRoles.join(", ")}`);
  }
  for (const [index, row] of base.assets.entries()) {
    if (
      typeof row.name !== "string"
      || typeof row.url !== "string" || !row.url.startsWith("https://")
      || typeof row.sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(row.sha256)
      || !Number.isSafeInteger(row.bytes) || row.bytes <= 0
      || !["zip", "tar.gz"].includes(row.format)
      || typeof row.member !== "string" || row.member.length === 0
    ) {
      throw error(`${file} contains invalid base asset ${index}`);
    }
    portableAssetName(row.name, `${file} base asset ${index} name`);
    if (archiveFormat(row.name, `${file} base asset ${index}`) !== row.format) {
      throw error(`${file} base asset ${index} name does not match its archive format`);
    }
  }
  return stable(base);
}

function validateRegistration(
  value,
  manifestPath,
  { nativeModuleStem: expectedNativeModuleStem, sqlName: expectedSqlName },
) {
  exactObjectKeys(
    value,
    ["initSymbol", "magicSymbol", "nativeModuleStem", "schema", "sqlName", "symbols"],
    `${manifestPath} iOS registration`,
  );
  const { schema, sqlName, nativeModuleStem, magicSymbol, initSymbol, symbols } = value;
  if (
    schema !== "oliphaunt-ios-extension-registration-v1"
    || sqlName !== expectedSqlName
    || nativeModuleStem !== expectedNativeModuleStem
    || typeof magicSymbol !== "string" || !C_IDENTIFIER.test(magicSymbol)
    || !(initSymbol === null || (typeof initSymbol === "string" && C_IDENTIFIER.test(initSymbol)))
    || !Array.isArray(symbols)
  ) {
    throw error(`${manifestPath} contains invalid iOS registration metadata`);
  }
  const canonicalSymbols = symbols.map((row, index) => {
    exactObjectKeys(row, ["address", "name"], `${manifestPath} iOS registration symbol ${index}`);
    if (!C_IDENTIFIER.test(row.name) || !C_IDENTIFIER.test(row.address)) {
      throw error(`${manifestPath} iOS registration symbol ${index} must use C identifiers`);
    }
    return { name: row.name, address: row.address };
  }).sort((left, right) => compareText(
    `${left.name}\0${left.address}`,
    `${right.name}\0${right.address}`,
  ));
  if (new Set(canonicalSymbols.map(({ name }) => name)).size !== canonicalSymbols.length) {
    throw error(`${manifestPath} iOS registration repeats a SQL symbol name`);
  }
  return {
    magicSymbol,
    initSymbol,
    symbols: canonicalSymbols,
  };
}

function extensionCarrier(
  manifest,
  manifestPath,
  { aggregateCarriers, repository, localUrls, release, verifyMembers },
) {
  if (
    typeof manifest.product !== "string"
    || typeof manifest.version !== "string"
    || typeof manifest.sqlName !== "string"
    || !Array.isArray(manifest.assets)
  ) {
    throw error(`${manifestPath} is not an exact-extension CI artifact manifest`);
  }
  if (manifest.product !== release.product || manifest.version !== release.version) {
    throw error(`${manifestPath} extension member identity does not match its release owner/version`);
  }
  const sqlName = portableIdentifier(manifest.sqlName, `${manifestPath}.sqlName`);
  if (typeof manifest.createsExtension !== "boolean") {
    throw error(`${manifestPath} ${sqlName}.createsExtension must be boolean`);
  }
  const dependencies = canonicalStringList(
    manifest.dependencies,
    `${manifestPath} ${sqlName}.dependencies`,
  );
  if (dependencies.includes(sqlName)) {
    throw error(`${manifestPath} ${sqlName}.dependencies must not include itself`);
  }
  const dataFiles = canonicalStringList(
    manifest.dataFiles,
    `${manifestPath} ${sqlName}.dataFiles`,
    (value, label) => {
      const relative = safeArchivePath(value, label);
      if (relative === ".") throw error(`${label} must name a file`);
      return relative;
    },
  );
  const extensionSqlFileNames = canonicalStringList(
    manifest.extensionSqlFileNames,
    `${manifestPath} ${sqlName}.extensionSqlFileNames`,
    (value, label) => {
      const name = portableIdentifier(value, label);
      if (!name.endsWith(".sql")) throw error(`${label} must name a SQL file`);
      return name;
    },
  );
  const extensionSqlFilePrefixes = canonicalStringList(
    manifest.extensionSqlFilePrefixes,
    `${manifestPath} ${sqlName}.extensionSqlFilePrefixes`,
    (value, label) => {
      if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(value)) {
        throw error(`${label} must be a dot-free portable SQL basename prefix`);
      }
      return value;
    },
  );
  const sharedPreloadLibraries = canonicalStringList(
    manifest.sharedPreloadLibraries,
    `${manifestPath} ${sqlName}.sharedPreloadLibraries`,
  );
  const tag = release.tag;
  const iOS = manifest.assets.filter((row) => row?.family === "native" && row.target === "ios-xcframework");
  const allowedKinds = new Set(["runtime", "ios-xcframework", "ios-dependency-xcframework"]);
  if (iOS.some((row) => !allowedKinds.has(row.kind))) {
    throw error(`${manifestPath} contains an unsupported iOS asset role`);
  }
  const carriers = new Map();
  const rows = iOS.map((row) => {
    const file = path.resolve(ROOT, row.path);
    requireFile(file, `${manifest.product} ${row.kind}`);
    const logicalName = portableAssetName(row.name, `${manifest.product} ${row.kind} name`);
    const logicalFormat = archiveFormat(logicalName, `${manifest.product} ${row.kind}`);
    if (statSync(file).size !== row.bytes || sha256(file) !== row.sha256 || path.basename(file) !== logicalName) {
      throw error(`${manifestPath} metadata does not match ${row.path}`);
    }
    let envelope;
    let memberPath;
    if (row.carrierAsset === undefined) {
      if (aggregateCarriers.size > 0) {
        throw error(`${manifestPath} bundle member ${manifest.sqlName} lacks an aggregate carrier locator`);
      }
      envelope = carrierEnvelope({ file, tag, repository, localUrls });
      memberPath = ".";
    } else {
      const carrierName = portableAssetName(row.carrierAsset, `${manifest.product} carrierAsset`);
      const aggregate = aggregateCarriers.get(carrierName);
      if (aggregate === undefined) {
        throw error(`${manifestPath} references undeclared aggregate carrier ${carrierName}`);
      }
      if (aggregate.family !== row.family || aggregate.target !== row.target) {
        throw error(`${manifestPath} ${manifest.sqlName}/${row.kind} references a carrier for the wrong family/target`);
      }
      const carrierRoot = safeArchivePath(row.carrierRoot, `${manifestPath} carrierRoot`);
      const nestedPath = safeArchivePath(row.memberPath, `${manifestPath} memberPath`);
      memberPath = `${carrierRoot}/${nestedPath}`;
      envelope = aggregate.envelope;
      if (verifyMembers) verifyFileMember(aggregate.file, envelope.format, memberPath, row);
    }
    const prior = carriers.get(envelope.name);
    if (prior !== undefined && JSON.stringify(prior) !== JSON.stringify(envelope)) {
      throw error(`${manifestPath} has conflicting carrier envelopes named ${envelope.name}`);
    }
    carriers.set(envelope.name, envelope);
    if (row.kind === "runtime") {
      return { row, logicalFormat, envelope, role: "runtime-resources", member: ".", memberPath };
    }
    if (row.kind === "ios-xcframework") {
      return {
        row,
        logicalFormat,
        envelope,
        role: "extension-xcframework",
        member: `liboliphaunt_extension_${row.identity}.xcframework`,
        memberPath,
      };
    }
    return {
      row,
      logicalFormat,
      envelope,
      role: "dependency-xcframework",
      member: `liboliphaunt_dependency_${row.identity}.xcframework`,
      memberPath,
    };
  });
  const assets = rows.map(({ row, logicalFormat, envelope, role, member, memberPath }) => {
    if (verifyMembers) verifyMember(path.resolve(ROOT, row.path), logicalFormat, member);
    return {
      role,
      carrier: envelope.name,
      path: memberPath,
      sha256: row.sha256,
      bytes: row.bytes,
      format: logicalFormat,
      member,
    };
  }).sort((left, right) => compareText(
    `${left.role}\0${left.member}\0${left.path}`,
    `${right.role}\0${right.member}\0${right.path}`,
  ));
  const runtimeCount = assets.filter(({ role }) => role === "runtime-resources").length;
  const nativeModuleStem = manifest.nativeModuleStem === null
    ? null
    : portableIdentifier(manifest.nativeModuleStem, `${manifestPath} ${sqlName}.nativeModuleStem`);
  const nativeDependencies = canonicalStringList(
    manifest.iosNativeDependencies,
    `${manifestPath} ${sqlName}.iosNativeDependencies`,
  );
  if (runtimeCount !== 1) throw error(`${manifestPath} must contain exactly one iOS runtime-resources asset`);
  if (nativeModuleStem === null) {
    if (assets.some(({ role }) => role !== "runtime-resources") || nativeDependencies.length > 0 || manifest.iosRegistration !== null) {
      throw error(`${manifestPath} SQL-only extension fabricates iOS native roles`);
    }
  } else {
    const primary = rows.filter(({ row }) => row.kind === "ios-xcframework");
    const dependencies = rows
      .filter(({ row }) => row.kind === "ios-dependency-xcframework")
      .map(({ row }) => row.identity)
      .sort(compareText);
    if (primary.length !== 1 || primary[0].row.identity !== nativeModuleStem) {
      throw error(`${manifestPath} lacks its canonical primary iOS XCFramework`);
    }
    if (JSON.stringify(dependencies) !== JSON.stringify(nativeDependencies)) {
      throw error(`${manifestPath} iOS dependency assets do not match iosNativeDependencies`);
    }
  }
  const registration = nativeModuleStem === null
    ? null
    : validateRegistration(manifest.iosRegistration, manifestPath, { nativeModuleStem, sqlName });
  return {
    carriers: [...carriers.values()].sort((left, right) => compareText(left.name, right.name)),
    extension: {
      product: release.product,
      version: release.version,
      tag,
      sqlName,
      createsExtension: manifest.createsExtension,
      dataFiles,
      dependencies,
      extensionSqlFileNames,
      extensionSqlFilePrefixes,
      nativeDependencies,
      nativeModuleStem,
      sharedPreloadLibraries,
      registration,
      assets,
    },
  };
}

function extensionArtifactDocument(manifestPath) {
  const document = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (
    document?.schema === "oliphaunt-extension-ci-artifacts-v1"
    && typeof document.product === "string"
    && typeof document.version === "string"
  ) {
    if (document.carrierAssets !== undefined) {
      throw error(`${manifestPath} singleton manifest must not declare carrierAssets`);
    }
    return {
      schema: document.schema,
      product: document.product,
      version: document.version,
      compatibility: compatibilityMetadata(
        document.compatibility,
        `${manifestPath}.compatibility`,
      ),
      carrierAssets: [],
      rows: [document],
    };
  }
  if (
    document?.schema === "oliphaunt-extension-ci-artifacts-v2"
    && typeof document.product === "string"
    && typeof document.version === "string"
    && Array.isArray(document.extensions)
    && document.extensions.length > 0
  ) {
    return {
      schema: document.schema,
      product: document.product,
      version: document.version,
      compatibility: compatibilityMetadata(
        document.compatibility,
        `${manifestPath}.compatibility`,
      ),
      carrierAssets: document.carrierAssets,
      rows: document.extensions.map((row, index) => {
        if (row === null || Array.isArray(row) || typeof row !== "object") {
          throw error(`${manifestPath}.extensions[${index}] must be an object`);
        }
        return { ...row, product: document.product, version: document.version };
      }),
    };
  }
  throw error(`${manifestPath} has unsupported exact-extension CI artifact schema`);
}

function aggregateCarrierMap(document, manifestPath, { repository, localUrls, release }) {
  if (document.schema === "oliphaunt-extension-ci-artifacts-v1") return new Map();
  if (!Array.isArray(document.carrierAssets) || document.carrierAssets.length === 0) {
    throw error(`${manifestPath} bundle manifest must declare aggregate carrierAssets`);
  }
  const result = new Map();
  const groups = new Set();
  const expectedMemberCount = extensionSqlNames(document.product, "ios-carrier-manifest").length;
  for (const [index, row] of document.carrierAssets.entries()) {
    if (
      row === null
      || Array.isArray(row)
      || typeof row !== "object"
      || row.kind !== "extension-bundle"
      || typeof row.family !== "string"
      || row.family.length === 0
      || typeof row.target !== "string"
      || row.target.length === 0
      || typeof row.path !== "string"
      || typeof row.sha256 !== "string"
      || !/^[0-9a-f]{64}$/u.test(row.sha256)
      || !Number.isSafeInteger(row.bytes)
      || row.bytes <= 0
      || row.memberCount !== expectedMemberCount
    ) {
      throw error(`${manifestPath}.carrierAssets[${index}] is not an exact aggregate carrier row`);
    }
    const name = portableAssetName(row.name, `${manifestPath}.carrierAssets[${index}].name`);
    const file = requireFile(path.resolve(ROOT, row.path), `${document.product} aggregate carrier`);
    if (path.basename(file) !== name || statSync(file).size !== row.bytes || sha256(file) !== row.sha256) {
      throw error(`${manifestPath}.carrierAssets[${index}] metadata does not match ${row.path}`);
    }
    const group = `${row.family}\0${row.target}`;
    if (result.has(name) || groups.has(group)) {
      throw error(`${manifestPath} repeats an aggregate carrier name or family/target`);
    }
    groups.add(group);
    result.set(name, {
      envelope: carrierEnvelope({ file, tag: release.tag, repository, localUrls }),
      family: row.family,
      file,
      target: row.target,
    });
  }
  return result;
}

function extensionCarriers(manifestPath, options) {
  const document = extensionArtifactDocument(manifestPath);
  stableVersion(document.version, `${document.product} version`);
  if (options.nativeRuntimeVersion !== undefined) {
    const requested = stableVersion(
      options.nativeRuntimeVersion,
      "caller-supplied liboliphaunt-native version",
    );
    if (requested !== document.compatibility.nativeRuntimeVersion) {
      throw error(
        `${manifestPath} pins liboliphaunt-native ${document.compatibility.nativeRuntimeVersion}, ` +
          `but caller supplied ${requested}`,
      );
    }
  }
  const release = {
    product: document.product,
    tag: `${tagPrefix(document.product, "ios-carrier-manifest")}${document.version}`,
    version: document.version,
  };
  const aggregateCarriers = aggregateCarrierMap(document, manifestPath, { ...options, release });
  const built = document.rows.map((row) => extensionCarrier(row, manifestPath, {
    ...options,
    aggregateCarriers,
    release,
  }));
  const rows = built.map(({ extension }) => extension);
  if (new Set(rows.map(({ sqlName }) => sqlName)).size !== rows.length) {
    throw error(`${manifestPath} repeats an extension SQL name`);
  }
  const actualSqlNames = rows.map(({ sqlName }) => sqlName).sort(compareText);
  const expectedSqlNames = extensionSqlNames(document.product, "ios-carrier-manifest");
  if (JSON.stringify(actualSqlNames) !== JSON.stringify(expectedSqlNames)) {
    throw error(`${manifestPath} does not contain the exact ${document.product} extension member set`);
  }
  const carriers = new Map();
  for (const carrier of built.flatMap((row) => row.carriers)) {
    const existing = carriers.get(carrier.name);
    if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(carrier)) {
      throw error(`${manifestPath} has conflicting carrier envelopes named ${carrier.name}`);
    }
    carriers.set(carrier.name, carrier);
  }
  return {
    carriers: [...carriers.values()].sort((left, right) => compareText(left.name, right.name)),
    nativeRuntimeVersion: document.compatibility.nativeRuntimeVersion,
    release,
    rows,
  };
}

export function swiftExtensionCarrierAssetName(product, version) {
  if (typeof product !== "string" || !/^oliphaunt-extension-[A-Za-z0-9._-]+$/u.test(product)) {
    throw error(`invalid exact-extension product ${product}`);
  }
  stableVersion(version, `${product} version`);
  return `${product}-${version}-swift-extension-carrier.json`;
}

function dependencyCarrierReference(sqlName) {
  const product = extensionProductForSqlName(sqlName, "ios-carrier-manifest");
  const version = currentProductVersionSync(product, "ios-carrier-manifest");
  stableVersion(version, `${product} version`);
  return {
    product,
    sqlName,
    tag: `${tagPrefix(product, "ios-carrier-manifest")}${version}`,
    version,
  };
}

/**
 * Build the immutable, single-extension carrier published on the exact
 * extension's own GitHub release. It deliberately references, rather than
 * duplicates, the compatible native base so independently versioned extension
 * releases do not require a Swift SDK release.
 */
export function buildSwiftExtensionCarrierManifest({
  extensionManifest,
  nativeRuntimeVersion = undefined,
  repository = DEFAULT_REPOSITORY,
  localUrls = false,
  verifyMembers = true,
} = {}) {
  validateRepository(repository);
  if (typeof extensionManifest !== "string" || extensionManifest.length === 0) {
    throw error("extensionManifest must be an exact-extension CI artifact manifest path");
  }
  const resolved = extensionCarriers(path.resolve(extensionManifest), {
    repository,
    localUrls,
    nativeRuntimeVersion,
    verifyMembers,
  });
  const { carriers, release, rows } = resolved;
  const version = resolved.nativeRuntimeVersion;
  return stable({
    schema: SWIFT_EXTENSION_CARRIER_SCHEMA,
    release,
    base: {
      product: "liboliphaunt-native",
      tag: `${tagPrefix("liboliphaunt-native", "ios-carrier-manifest")}${version}`,
      version,
    },
    carriers,
    entries: rows.map((extension) => ({
      dependencyCarriers: extension.dependencies.map(dependencyCarrierReference),
      extension,
    })),
  });
}

export function writeSwiftExtensionCarrierManifest(output, options = {}) {
  const manifest = buildSwiftExtensionCarrierManifest(options);
  mkdirSync(path.dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifest;
}

function discoveredExtensionManifests(root) {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(root, entry.name, "extension-artifacts.json"))
    .filter((file) => existsSync(file))
    .sort(compareText);
}

export function buildIosCarrierManifest({
  baseAssetDir = path.join(ROOT, "target/liboliphaunt/release-assets"),
  baseCarrierManifest = undefined,
  extensionManifests = discoveredExtensionManifests(path.join(ROOT, "target/extension-artifacts")),
  repository = DEFAULT_REPOSITORY,
  localUrls = false,
  verifyMembers = true,
} = {}) {
  validateRepository(repository);
  const base = baseCarrierManifest === undefined
    ? baseCarrier({ baseAssetDir: path.resolve(baseAssetDir), repository, localUrls, verifyMembers })
    : frozenBaseCarrier(baseCarrierManifest);
  const documents = extensionManifests.map((file) => {
    const document = extensionCarriers(path.resolve(file), {
      repository,
      localUrls,
      verifyMembers,
    });
    if (document.nativeRuntimeVersion !== base.version) {
      throw error(
        `${file} pins liboliphaunt-native ${document.nativeRuntimeVersion}, ` +
          `but the selected base carrier is ${base.version}`,
      );
    }
    return document;
  });
  const extensions = documents
    .flatMap(({ rows }) => rows)
    .sort((left, right) => compareText(left.sqlName, right.sqlName));
  if (new Set(extensions.map(({ sqlName }) => sqlName)).size !== extensions.length) {
    throw error("extension carrier set contains duplicate SQL names");
  }
  const carriers = new Map();
  for (const carrier of documents.flatMap((document) => document.carriers)) {
    const existing = carriers.get(carrier.name);
    if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(carrier)) {
      throw error(`extension carrier set has conflicting envelopes named ${carrier.name}`);
    }
    carriers.set(carrier.name, carrier);
  }
  return stable({
    schema: IOS_CARRIER_SCHEMA,
    base,
    carriers: [...carriers.values()].sort((left, right) => compareText(left.name, right.name)),
    extensions,
  });
}

export function writeIosCarrierManifest(output, options = {}) {
  const manifest = buildIosCarrierManifest(options);
  mkdirSync(path.dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifest;
}

function parseArgs(argv) {
  const options = { extensionManifests: [] };
  let output = DEFAULT_IOS_CARRIER;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--local-urls") {
      options.localUrls = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      console.log(
        `usage: ${path.basename(import.meta.path)} [--base-asset-dir DIR] [--extension-manifest FILE ...] ` +
          `[--base-carrier FILE] [--extension-root DIR] [--repository OWNER/REPO] [--output FILE] [--local-urls]`,
      );
      process.exit(0);
    }
    const value = argv[index + 1];
    if (value === undefined) throw error(`${arg} requires a value`);
    index += 1;
    if (arg === "--base-asset-dir") options.baseAssetDir = value;
    else if (arg === "--base-carrier") options.baseCarrierManifest = value;
    else if (arg === "--extension-manifest") options.extensionManifests.push(value);
    else if (arg === "--extension-root") options.extensionManifests.push(...discoveredExtensionManifests(path.resolve(value)));
    else if (arg === "--repository") options.repository = value;
    else if (arg === "--output") output = path.resolve(value);
    else throw error(`unknown argument ${arg}`);
  }
  if (options.extensionManifests.length === 0) delete options.extensionManifests;
  return { options, output };
}

if (import.meta.main) {
  try {
    const { options, output } = parseArgs(Bun.argv.slice(2));
    const manifest = writeIosCarrierManifest(output, options);
    console.log(`${path.relative(ROOT, output)}\t${manifest.extensions.length} extensions`);
  } catch (cause) {
    console.error(cause instanceof Error ? cause.message : String(cause));
    process.exit(1);
  }
}
