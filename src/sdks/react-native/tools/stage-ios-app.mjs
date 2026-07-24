#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  constants as fsConstants,
  createReadStream,
  createWriteStream,
} from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createGunzip } from "node:zlib";

const PREFIX = "stage-ios-app.mjs";
const SCHEMA = "oliphaunt-react-native-ios-carrier-v1";
const OUTPUT_SCHEMA = "oliphaunt-react-native-ios-selection-v1";
const PORTABLE_RE = /^[A-Za-z0-9._-]{1,128}$/u;
const C_IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const STABLE_SEMVER_RE = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u;
const EXTRACTED_CACHE_SCHEMA = "oliphaunt-extracted-carrier-tree-v1";
// GitHub release assets are bounded at the transport boundary and archives are
// bounded again at their expanded boundary. These ceilings are intentionally
// well above the production iOS payloads while making archive bombs fail before
// extraction can consume unbounded disk or memory.
const MAX_CARRIER_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_ZIP_CARRIER_BYTES = 512 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 4096;
// The canonical ICU data payload contains one file per locale/resource and is
// legitimately larger than the general carrier ceiling. Keep that exception
// tied to the validated base-carrier role instead of weakening extension and
// framework archive protection globally.
const MAX_ICU_ARCHIVE_ENTRIES = 8192;
const MAX_ARCHIVE_MEMBER_BYTES = 1024 * 1024 * 1024;
const MAX_ARCHIVE_EXPANDED_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_LEGAL_FILE_BYTES = 16 * 1024 * 1024;
const MAX_LEGAL_FILES = 1024;
const SPDX_ID_RE = /^[A-Za-z0-9][A-Za-z0-9.-]*$/u;
const ALLOWED_ZIP_EXTRA_FIELDS = new Set([0x5455, 0x5855, 0x7875]);
const EXTENSION_ARTIFACT_PROPERTY_KEYS = new Set([
  "packageLayout",
  "pgMajor",
  "sqlName",
  "createsExtension",
  "nativeModuleStem",
  "nativeModuleFile",
  "nativeTarget",
  "nativeRuntimeProduct",
  "nativeRuntimeVersion",
  "dependencies",
  "dataFiles",
  "extensionSqlFileNames",
  "extensionSqlFilePrefixes",
  "sharedPreloadLibraries",
  "mobilePrebuilt",
  "mobileStaticArchives",
  "mobileStaticDependencyArchives",
  "staticSymbolPrefix",
  "staticSymbolAliases",
  "licenseFiles",
  "licenseProfile",
  "files",
]);
const GENERATED_EXTENSION_CATALOG = JSON.parse(
  await fs.readFile(new URL("../src/generated/extensions.json", import.meta.url), "utf8"),
);

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function fail(message) {
  throw new Error(`${PREFIX}: ${message}`);
}

function usage() {
  console.error(
    `usage: ${PREFIX} --carrier <manifest.json> [--carrier <manifest.json>]... ` +
      `--output-dir <ios/oliphaunt> [--extensions <sql,csv>] [--icu] ` +
      `[--cache-dir <directory>] [--allow-file-urls]`,
  );
}

function parseArgs(argv) {
  const args = {
    allowFileUrls: false,
    cacheDir: path.join(os.homedir(), ".cache", "oliphaunt", "react-native-ios"),
    carriers: [],
    extensions: [],
    icu: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--allow-file-urls") {
      args.allowFileUrls = true;
      continue;
    }
    if (arg === "--icu") {
      args.icu = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    }
    if (
      ![
        "--carrier",
        "--base-carrier",
        "--cache-dir",
        "--extension-carrier",
        "--extensions",
        "--output-dir",
      ].includes(arg)
    ) {
      usage();
      fail(`unknown argument ${arg}`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      fail(`${arg} requires a value`);
    }
    index += 1;
    if (arg === "--carrier" || arg === "--base-carrier") args.carriers.push(path.resolve(value));
    if (arg === "--cache-dir") args.cacheDir = path.resolve(value);
    if (arg === "--extension-carrier") args.carriers.push(path.resolve(value));
    if (arg === "--output-dir") args.outputDir = path.resolve(value);
    if (arg === "--extensions") {
      args.extensions.push(...value.split(",").map((item) => item.trim()).filter(Boolean));
    }
  }
  if (args.carriers.length === 0 || !args.outputDir) {
    usage();
    fail("at least one --carrier and --output-dir are required");
  }
  args.extensions = uniquePortable(args.extensions, "selected extension");
  return args;
}

function object(value, label) {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    fail(`${label} must be an object`);
  }
  return value;
}

function exactKeys(value, allowed, label) {
  const actual = Object.keys(value).sort(compareText);
  const expected = [...allowed].sort(compareText);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`${label} fields must be exactly ${expected.join(",")}; got ${actual.join(",")}`);
  }
}

function portable(value, label) {
  if (typeof value !== "string" || !PORTABLE_RE.test(value)) {
    fail(`${label} must be a portable identifier`);
  }
  return value;
}

function stableVersion(value, label) {
  if (typeof value !== "string" || !STABLE_SEMVER_RE.test(value)) {
    fail(`${label} must be a stable SemVer X.Y.Z version`);
  }
  return value;
}

function cIdentifier(value, label) {
  if (typeof value !== "string" || !C_IDENTIFIER_RE.test(value)) {
    fail(`${label} must be a C identifier`);
  }
  return value;
}

function uniquePortable(value, label) {
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  const result = value.map((item, index) => portable(item, `${label}[${index}]`));
  if (new Set(result).size !== result.length) fail(`${label} must not contain duplicates`);
  return result.sort(compareText);
}

function canonicalPortableList(value, label) {
  const canonical = uniquePortable(value, label);
  if (JSON.stringify(value) !== JSON.stringify(canonical)) {
    fail(`${label} must be sorted in ordinal order`);
  }
  return canonical;
}

function generatedExtensionCatalog(value) {
  const catalog = object(value, "generated React Native extension catalog");
  if (!Array.isArray(catalog.extensions)) {
    fail("generated React Native extension catalog.extensions must be an array");
  }
  const rows = new Map();
  for (const [index, raw] of catalog.extensions.entries()) {
    const row = object(raw, `generated React Native extension catalog.extensions[${index}]`);
    const sqlName = portable(
      row["sql-name"],
      `generated React Native extension catalog.extensions[${index}].sql-name`,
    );
    const releaseProduct = portable(
      row["release-product"],
      `generated React Native extension catalog.extensions[${index}].release-product`,
    );
    if (!releaseProduct.startsWith("oliphaunt-extension-")) {
      fail(`generated release owner for ${sqlName} must be an extension release product`);
    }
    if (row["mobile-release-ready"] !== true) {
      fail(`generated React Native extension ${sqlName} must be mobile release ready`);
    }
    if (typeof row["runtime-bound"] !== "boolean") {
      fail(`generated runtime-bound flag for ${sqlName} must be boolean`);
    }
    if (rows.has(sqlName)) fail(`generated React Native extension catalog repeats ${sqlName}`);
    rows.set(sqlName, {
      releaseProduct,
      runtimeBound: row["runtime-bound"],
    });
  }
  return rows;
}

const GENERATED_EXTENSION_BY_SQL_NAME = generatedExtensionCatalog(GENERATED_EXTENSION_CATALOG);

function safeRelative(value, label) {
  if (
    typeof value !== "string" || value.length === 0 || value.includes("\\") ||
    /[\u0000-\u001f\u007f]/u.test(value) || /^[A-Za-z]:/u.test(value)
  ) {
    fail(`${label} must be a non-empty archive-relative path`);
  }
  if (value === ".") return value;
  const normalized = value.replace(/^\.\//u, "");
  const parts = normalized.split("/");
  if (path.isAbsolute(value) || parts.some((part) => !part || part === "." || part === "..")) {
    fail(`${label} is not a safe archive-relative path: ${JSON.stringify(value)}`);
  }
  return normalized;
}

function spdxConjunction(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    fail(`${label} must be a non-empty SPDX conjunction`);
  }
  const terms = value.split(" AND ");
  if (terms.some((term) => !SPDX_ID_RE.test(term))) {
    fail(`${label} must contain only SPDX identifiers joined by AND`);
  }
  if (new Set(terms).size !== terms.length) fail(`${label} repeats an SPDX identifier`);
  return value;
}

function validateLegalFiles(value, label) {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_LEGAL_FILES) {
    fail(`${label} must contain between 1 and ${MAX_LEGAL_FILES} legal file locators`);
  }
  const rows = value.map((raw, index) => {
    const row = object(raw, `${label}[${index}]`);
    exactKeys(row, ["bytes", "kind", "member", "sha256"], `${label}[${index}]`);
    const member = safeRelative(row.member, `${label}[${index}].member`);
    if (member === ".") fail(`${label}[${index}].member must name a file`);
    if (!Number.isSafeInteger(row.bytes) || row.bytes <= 0 || row.bytes > MAX_LEGAL_FILE_BYTES) {
      fail(`${label}[${index}].bytes must be between 1 and ${MAX_LEGAL_FILE_BYTES}`);
    }
    if (!new Set(["license", "notice"]).has(row.kind)) {
      fail(`${label}[${index}].kind must be license or notice`);
    }
    if (typeof row.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(row.sha256)) {
      fail(`${label}[${index}].sha256 must be a lowercase SHA-256 digest`);
    }
    return { bytes: row.bytes, kind: row.kind, member, sha256: row.sha256 };
  });
  const canonical = [...rows].sort((left, right) => compareText(left.member, right.member));
  if (JSON.stringify(rows) !== JSON.stringify(canonical)) {
    fail(`${label} must be sorted by archive member in ordinal order`);
  }
  const folded = new Map();
  for (const row of rows) {
    const key = row.member.normalize("NFC").toLowerCase();
    const prior = folded.get(key);
    if (prior !== undefined) {
      fail(`${label} has colliding legal members ${prior} and ${row.member}`);
    }
    folded.set(key, row.member);
  }
  return rows;
}

function validateLegalGroup(value, label, { sqlName = undefined } = {}) {
  const row = object(value, label);
  const keys = sqlName === undefined
    ? ["assetRole", "files", "profile", "spdx"]
    : ["assetRole", "files", "profile", "spdx", "sqlName"];
  exactKeys(row, keys, label);
  if (sqlName !== undefined && row.sqlName !== sqlName) {
    fail(`${label}.sqlName must be ${sqlName}`);
  }
  return {
    assetRole: portable(row.assetRole, `${label}.assetRole`),
    files: validateLegalFiles(row.files, `${label}.files`),
    profile: portable(row.profile, `${label}.profile`),
    spdx: spdxConjunction(row.spdx, `${label}.spdx`),
    ...(sqlName === undefined ? {} : { sqlName }),
  };
}

function portableAssetName(value, label) {
  if (
    typeof value !== "string" || value.length === 0 || path.posix.basename(value) !== value ||
    /[<>:"/\\|?*\u0000-\u001f\u007f]/u.test(value) || /[ .]$/u.test(value) ||
    /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(value)
  ) {
    fail(`${label} must be a portable release asset file name`);
  }
  return value;
}

function canonicalRelativeFileList(value, label) {
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  const rows = value.map((item, index) => {
    const relative = safeRelative(item, `${label}[${index}]`);
    if (relative === ".") fail(`${label}[${index}] must name a file`);
    return relative;
  });
  const canonical = [...rows].sort(compareText);
  if (new Set(rows).size !== rows.length) fail(`${label} must not contain duplicates`);
  if (JSON.stringify(rows) !== JSON.stringify(canonical)) {
    fail(`${label} must be sorted in ordinal order`);
  }
  return rows;
}

function canonicalSqlFileNameList(value, label) {
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  const rows = value.map((item, index) => {
    const name = portable(item, `${label}[${index}]`);
    if (!name.endsWith(".sql")) fail(`${label}[${index}] must name a SQL file`);
    return name;
  });
  const canonical = [...rows].sort(compareText);
  if (new Set(rows).size !== rows.length) fail(`${label} must not contain duplicates`);
  if (JSON.stringify(rows) !== JSON.stringify(canonical)) {
    fail(`${label} must be sorted in ordinal order`);
  }
  return rows;
}

function canonicalSqlFilePrefixList(value, label) {
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  const rows = value.map((item, index) => {
    if (typeof item !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(item)) {
      fail(`${label}[${index}] must be a dot-free portable SQL basename prefix`);
    }
    return item;
  });
  const canonical = [...rows].sort(compareText);
  if (new Set(rows).size !== rows.length) fail(`${label} must not contain duplicates`);
  if (JSON.stringify(rows) !== JSON.stringify(canonical)) {
    fail(`${label} must be sorted in ordinal order`);
  }
  return rows;
}

function boundedBytes(value, label, maximum = MAX_CARRIER_BYTES) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    fail(`${label} must be a positive safe integer`);
  }
  if (value > maximum) {
    fail(`${label} exceeds the maximum supported size of ${maximum} bytes`);
  }
  return value;
}

function archiveEntryLimit(asset) {
  return asset.role === "icu-data" ? MAX_ICU_ARCHIVE_ENTRIES : MAX_ARCHIVE_ENTRIES;
}

function archiveStreamLimit(maxEntries) {
  // Each ustar member contributes one 512-byte header and up to 511 bytes of
  // payload padding in addition to its declared expanded size.
  return MAX_ARCHIVE_EXPANDED_BYTES + maxEntries * 1024 + 1024;
}

function validateAsset(value, label, allowFileUrls) {
  const asset = object(value, label);
  exactKeys(asset, ["bytes", "format", "member", "name", "role", "sha256", "url"], label);
  const role = portable(asset.role, `${label}.role`);
  portableAssetName(asset.name, `${label}.name`);
  if (!["tar.gz", "zip"].includes(asset.format)) {
    fail(`${label}.format must be tar.gz or zip`);
  }
  if (typeof asset.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(asset.sha256)) {
    fail(`${label}.sha256 must be a lowercase SHA-256 digest`);
  }
  boundedBytes(asset.bytes, `${label}.bytes`);
  let url;
  try {
    url = new URL(asset.url);
  } catch {
    fail(`${label}.url must be an absolute URL`);
  }
  if (url.protocol !== "https:" && !(allowFileUrls && url.protocol === "file:")) {
    fail(`${label}.url must use HTTPS${allowFileUrls ? " or an explicitly enabled file URL" : ""}`);
  }
  let urlName;
  try {
    urlName = decodeURIComponent(path.basename(url.pathname));
  } catch {
    fail(`${label}.url contains invalid escaping`);
  }
  if (urlName !== asset.name) {
    fail(`${label}.url must end with ${asset.name}`);
  }
  if (
    (asset.format === "zip" && !asset.name.endsWith(".zip")) ||
    (asset.format === "tar.gz" && !asset.name.endsWith(".tar.gz"))
  ) {
    fail(`${label}.name does not match format ${asset.format}`);
  }
  return {
    bytes: asset.bytes,
    format: asset.format,
    member: safeRelative(asset.member, `${label}.member`),
    name: asset.name,
    role,
    sha256: asset.sha256,
    url: url.href,
  };
}

function validateCarrierEnvelope(value, label, allowFileUrls) {
  const carrier = object(value, label);
  exactKeys(carrier, ["bytes", "format", "name", "sha256", "url"], label);
  portableAssetName(carrier.name, `${label}.name`);
  boundedBytes(carrier.bytes, `${label}.bytes`);
  if (typeof carrier.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(carrier.sha256)) {
    fail(`${label}.sha256 must be a lowercase SHA-256 digest`);
  }
  if (!["tar.gz", "zip"].includes(carrier.format)) {
    fail(`${label}.format must be tar.gz or zip`);
  }
  if (
    (carrier.format === "zip" && !carrier.name.endsWith(".zip")) ||
    (carrier.format === "tar.gz" && !carrier.name.endsWith(".tar.gz"))
  ) {
    fail(`${label}.name does not match format ${carrier.format}`);
  }
  let url;
  try {
    url = new URL(carrier.url);
  } catch {
    fail(`${label}.url must be an absolute URL`);
  }
  if (url.protocol !== "https:" && !(allowFileUrls && url.protocol === "file:")) {
    fail(`${label}.url must use HTTPS${allowFileUrls ? " or an explicitly enabled file URL" : ""}`);
  }
  let urlName;
  try {
    urlName = decodeURIComponent(path.posix.basename(url.pathname));
  } catch {
    fail(`${label}.url contains invalid escaping`);
  }
  if (urlName !== carrier.name) fail(`${label}.url must end with ${carrier.name}`);
  return {
    bytes: carrier.bytes,
    format: carrier.format,
    name: carrier.name,
    sha256: carrier.sha256,
    url: url.href,
  };
}

function validateCarrierEnvelopes(value, label, allowFileUrls) {
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  const rows = value.map((row, index) =>
    validateCarrierEnvelope(row, `${label}[${index}]`, allowFileUrls));
  if (new Set(rows.map(({ name }) => name)).size !== rows.length) {
    fail(`${label} repeats a carrier name`);
  }
  rows.sort((left, right) => compareText(left.name, right.name));
  return new Map(rows.map((row) => [row.name, row]));
}

function validateAssetLocator(value, label, carriers) {
  const asset = object(value, label);
  exactKeys(asset, ["bytes", "carrier", "format", "member", "path", "role", "sha256"], label);
  const role = portable(asset.role, `${label}.role`);
  const carrierName = portableAssetName(asset.carrier, `${label}.carrier`);
  const envelope = carriers.get(carrierName);
  if (envelope === undefined) {
    fail(`${label}.carrier references undeclared envelope ${carrierName}`);
  }
  const logicalPath = safeRelative(asset.path, `${label}.path`);
  const member = safeRelative(asset.member, `${label}.member`);
  boundedBytes(asset.bytes, `${label}.bytes`);
  if (typeof asset.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(asset.sha256)) {
    fail(`${label}.sha256 must be a lowercase SHA-256 digest`);
  }
  if (!["tar.gz", "zip"].includes(asset.format)) {
    fail(`${label}.format must be tar.gz or zip`);
  }
  if (logicalPath === ".") {
    if (
      asset.bytes !== envelope.bytes || asset.sha256 !== envelope.sha256 ||
      asset.format !== envelope.format
    ) {
      fail(`${label} direct payload metadata must exactly match carrier ${carrierName}`);
    }
  } else {
    if (envelope.format !== "tar.gz") {
      fail(`${label} nested payload carrier must be a tar.gz archive`);
    }
    const nestedName = path.posix.basename(logicalPath);
    portableAssetName(nestedName, `${label}.path basename`);
    if (
      (asset.format === "zip" && !nestedName.endsWith(".zip")) ||
      (asset.format === "tar.gz" && !nestedName.endsWith(".tar.gz"))
    ) {
      fail(`${label}.path does not match logical payload format ${asset.format}`);
    }
  }
  return {
    bytes: asset.bytes,
    carrier: carrierName,
    envelope,
    format: asset.format,
    member,
    path: logicalPath,
    role,
    sha256: asset.sha256,
  };
}

function validateAssetLocatorList(value, label, carriers) {
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  const assets = value.map((asset, index) =>
    validateAssetLocator(asset, `${label}[${index}]`, carriers));
  const identities = assets.map(({ carrier, member, path: logicalPath, role }) =>
    `${role}\0${member}\0${carrier}\0${logicalPath}`);
  if (new Set(identities).size !== assets.length) {
    fail(`${label} repeats an asset locator identity`);
  }
  return assets.sort((left, right) => compareText(
    `${left.role}\0${left.member}\0${left.carrier}\0${left.path}`,
    `${right.role}\0${right.member}\0${right.carrier}\0${right.path}`,
  ));
}

function validateRegistration(value, label) {
  const registration = object(value, label);
  exactKeys(registration, ["initSymbol", "magicSymbol", "symbols"], label);
  const initSymbol = registration.initSymbol === null
    ? null
    : cIdentifier(registration.initSymbol, `${label}.initSymbol`);
  const magicSymbol = cIdentifier(registration.magicSymbol, `${label}.magicSymbol`);
  if (!Array.isArray(registration.symbols)) fail(`${label}.symbols must be an array`);
  const declaredSymbols = registration.symbols.map((raw, index) => {
    const row = object(raw, `${label}.symbols[${index}]`);
    exactKeys(row, ["address", "name"], `${label}.symbols[${index}]`);
    return {
      address: cIdentifier(row.address, `${label}.symbols[${index}].address`),
      name: cIdentifier(row.name, `${label}.symbols[${index}].name`),
    };
  });
  const symbols = [...declaredSymbols].sort((left, right) => compareText(
    `${left.name}\0${left.address}`,
    `${right.name}\0${right.address}`,
  ));
  if (JSON.stringify(declaredSymbols) !== JSON.stringify(symbols)) {
    fail(`${label}.symbols must be sorted in ordinal name/address order`);
  }
  if (new Set(symbols.map(({ name }) => name)).size !== symbols.length) {
    fail(`${label}.symbols repeats a SQL symbol`);
  }
  return { initSymbol, magicSymbol, symbols };
}

function validateAssetList(value, label, allowFileUrls) {
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  const assets = value.map((asset, index) =>
    validateAsset(asset, `${label}[${index}]`, allowFileUrls));
  const identities = assets.map(({ role, member }) => `${role}\0${member}`);
  if (new Set(identities).size !== identities.length) {
    fail(`${label} repeats an asset role/member identity`);
  }
  if (new Set(assets.map(({ name }) => name)).size !== assets.length) {
    fail(`${label} repeats an asset name`);
  }
  return assets.sort((left, right) => compareText(
    `${left.role}\0${left.member}`,
    `${right.role}\0${right.member}`,
  ));
}

function exactlyOneRole(assets, role, label) {
  const matches = assets.filter((asset) => asset.role === role);
  if (matches.length !== 1) fail(`${label} must contain exactly one ${role} asset`);
  return matches[0];
}

function noOtherRoles(assets, roles, label) {
  const extras = assets.filter((asset) => !roles.includes(asset.role));
  if (extras.length > 0) {
    fail(`${label} contains unsupported asset role(s): ${[...new Set(extras.map(({ role }) => role))].sort(compareText).join(",")}`);
  }
}

function validateBase(value, label, allowFileUrls) {
  const base = object(value, label);
  exactKeys(base, ["assets", "product", "tag", "version"], label);
  if (base.product !== "liboliphaunt-native") fail(`${label}.product must be liboliphaunt-native`);
  const assets = validateAssetList(base.assets, `${label}.assets`, allowFileUrls);
  noOtherRoles(assets, ["base-xcframework", "icu-data", "runtime-resources"], `${label}.assets`);
  const framework = exactlyOneRole(assets, "base-xcframework", `${label}.assets`);
  const runtime = exactlyOneRole(assets, "runtime-resources", `${label}.assets`);
  const icu = exactlyOneRole(assets, "icu-data", `${label}.assets`);
  const frameworkName = portable(
    path.posix.basename(framework.member),
    `${label} base-xcframework member basename`,
  );
  if (!frameworkName.endsWith(".xcframework")) {
    fail(`${label} base-xcframework member must be an XCFramework directory`);
  }
  const version = stableVersion(base.version, `${label}.version`);
  const expectedTag = `${base.product}-v${version}`;
  if (base.tag !== expectedTag) fail(`${label}.tag must be ${expectedTag}`);
  return {
    assets: { framework, icu, runtime },
    kind: "base",
    product: base.product,
    tag: base.tag,
    version,
  };
}

function validateExtension(value, label, carriers) {
  const root = object(value, label);
  exactKeys(
    root,
    [
      "assets", "createsExtension", "dataFiles", "dependencies", "extensionSqlFileNames",
      "extensionSqlFilePrefixes", "nativeDependencies", "nativeModuleStem", "product",
      "registration", "sharedPreloadLibraries", "sqlName", "tag", "version",
    ],
    label,
  );
  const sqlName = portable(root.sqlName, `${label}.sqlName`);
  const generated = GENERATED_EXTENSION_BY_SQL_NAME.get(sqlName);
  if (generated === undefined) {
    fail(`${label}.sqlName is not in the generated React Native extension catalog`);
  }
  const releaseProduct = portable(root.product, `${label}.product`);
  if (releaseProduct !== generated.releaseProduct) {
    fail(
      `${label}.product must be canonical owner ${generated.releaseProduct} for SQL member ${sqlName}`,
    );
  }
  const version = stableVersion(root.version, `${label}.version`);
  const expectedTag = `${releaseProduct}-v${version}`;
  if (root.tag !== expectedTag) fail(`${label}.tag must be ${expectedTag}`);
  if (typeof root.createsExtension !== "boolean") fail(`${label}.createsExtension must be boolean`);
  const dataFiles = canonicalRelativeFileList(root.dataFiles, `${label}.dataFiles`);
  const dependencies = canonicalPortableList(root.dependencies, `${label}.dependencies`);
  if (dependencies.includes(sqlName)) fail(`${label}.dependencies must not include ${sqlName} itself`);
  const extensionSqlFileNames = canonicalSqlFileNameList(
    root.extensionSqlFileNames,
    `${label}.extensionSqlFileNames`,
  );
  const extensionSqlFilePrefixes = canonicalSqlFilePrefixList(
    root.extensionSqlFilePrefixes,
    `${label}.extensionSqlFilePrefixes`,
  );
  const nativeDependencies = canonicalPortableList(
    root.nativeDependencies,
    `${label}.nativeDependencies`,
  );
  const nativeModuleStem = root.nativeModuleStem === null
    ? null
    : portable(root.nativeModuleStem, `${label}.nativeModuleStem`);
  const sharedPreloadLibraries = canonicalPortableList(
    root.sharedPreloadLibraries,
    `${label}.sharedPreloadLibraries`,
  );
  const assets = validateAssetLocatorList(root.assets, `${label}.assets`, carriers);
  noOtherRoles(
    assets,
    ["dependency-xcframework", "extension-xcframework", "runtime-resources"],
    `${label}.assets`,
  );
  const runtime = exactlyOneRole(assets, "runtime-resources", `${label}.assets`);
  let extension = null;
  let dependencyFrameworks = [];
  let registration = null;
  if (nativeModuleStem === null) {
    if (assets.some(({ role }) => role !== "runtime-resources") || root.registration !== null || nativeDependencies.length > 0) {
      fail(`${label} SQL-only carrier must not fabricate frameworks, registration, or native dependencies`);
    }
  } else {
    extension = exactlyOneRole(assets, "extension-xcframework", `${label}.assets`);
    const expectedExtension = `liboliphaunt_extension_${nativeModuleStem}.xcframework`;
    if (path.posix.basename(extension.member) !== expectedExtension) {
      fail(`${label} extension-xcframework member must end with ${expectedExtension}`);
    }
    dependencyFrameworks = assets
      .filter(({ role }) => role === "dependency-xcframework")
      .map((asset) => {
        const basename = path.posix.basename(asset.member);
        const match = /^liboliphaunt_dependency_(.+)\.xcframework$/u.exec(basename);
        if (!match || !PORTABLE_RE.test(match[1])) {
          fail(`${label} dependency-xcframework member has invalid canonical name ${basename}`);
        }
        return { asset, dependency: match[1] };
      })
      .sort((left, right) => compareText(left.dependency, right.dependency));
    if (new Set(dependencyFrameworks.map(({ dependency }) => dependency)).size !== dependencyFrameworks.length) {
      fail(`${label} repeats a dependency carrier identity`);
    }
    if (
      JSON.stringify(dependencyFrameworks.map(({ dependency }) => dependency)) !==
      JSON.stringify(nativeDependencies)
    ) {
      fail(`${label} dependency-xcframework roles do not exactly match nativeDependencies`);
    }
    if (root.registration === null) fail(`${label} native carrier requires registration metadata`);
    registration = validateRegistration(root.registration, `${label}.registration`);
    const prefix = `oliphaunt_static_${nativeModuleStem.replaceAll(/[^A-Za-z0-9_]/gu, "_")}`;
    if (registration.magicSymbol !== `${prefix}_Pg_magic_func`) {
      fail(`${label}.registration.magicSymbol does not match nativeModuleStem`);
    }
    if (![null, `${prefix}__PG_init`].includes(registration.initSymbol)) {
      fail(`${label}.registration.initSymbol does not match nativeModuleStem`);
    }
  }
  return {
    assets: { dependencyFrameworks, extension, runtime },
    createsExtension: root.createsExtension,
    dataFiles,
    dependencies,
    extensionSqlFileNames,
    extensionSqlFilePrefixes,
    kind: "extension",
    nativeDependencies,
    nativeModuleStem,
    product: releaseProduct,
    registration,
    sharedPreloadLibraries,
    sqlName,
    tag: root.tag,
    version,
    runtimeBound: generated.runtimeBound,
  };
}

function validateLegalDocument(value, label, base, extensions) {
  const legal = object(value, label);
  exactKeys(legal, ["base", "extensions"], label);
  if (!Array.isArray(legal.base)) fail(`${label}.base must be an array`);
  const baseGroups = legal.base.map((row, index) =>
    validateLegalGroup(row, `${label}.base[${index}]`));
  const expectedBaseRoles = ["base-xcframework", "runtime-resources", "icu-data"];
  if (JSON.stringify(baseGroups.map(({ assetRole }) => assetRole)) !== JSON.stringify(expectedBaseRoles)) {
    fail(`${label}.base asset roles must be exactly ${expectedBaseRoles.join(",")}`);
  }
  const baseAssets = new Map([
    [base.assets.framework.role, base.assets.framework],
    [base.assets.runtime.role, base.assets.runtime],
    [base.assets.icu.role, base.assets.icu],
  ]);
  for (const group of baseGroups) {
    if (!baseAssets.has(group.assetRole)) {
      fail(`${label}.base legal group references missing asset role ${group.assetRole}`);
    }
  }

  if (!Array.isArray(legal.extensions)) fail(`${label}.extensions must be an array`);
  const extensionByName = new Map(extensions.map((extension) => [extension.sqlName, extension]));
  const extensionGroups = legal.extensions.map((row, index) => {
    const raw = object(row, `${label}.extensions[${index}]`);
    const sqlName = portable(raw.sqlName, `${label}.extensions[${index}].sqlName`);
    const extension = extensionByName.get(sqlName);
    if (extension === undefined) {
      fail(`${label}.extensions[${index}] references undeclared extension ${sqlName}`);
    }
    const group = validateLegalGroup(raw, `${label}.extensions[${index}]`, { sqlName });
    if (group.assetRole !== "runtime-resources" || extension.assets.runtime.role !== group.assetRole) {
      fail(`${label}.extensions[${index}] legal bytes must come from its runtime-resources asset`);
    }
    return group;
  });
  const expectedNames = [...extensionByName.keys()].sort(compareText);
  const actualNames = extensionGroups.map(({ sqlName }) => sqlName);
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
    fail(`${label}.extensions must exactly cover carrier extensions in ordinal order`);
  }
  const legalByName = new Map(extensionGroups.map((group) => [group.sqlName, group]));
  return {
    base: baseGroups,
    extensions: legalByName,
  };
}

function assertExactCarrierCoverage(carriers, extensions, label) {
  const referenced = new Set(
    extensions.flatMap((extension) => [
      extension.assets.runtime,
      extension.assets.extension,
      ...extension.assets.dependencyFrameworks.map(({ asset }) => asset),
    ].filter(Boolean).map(({ carrier }) => carrier)),
  );
  const declared = [...carriers.keys()].sort(compareText);
  const used = [...referenced].sort(compareText);
  if (JSON.stringify(declared) !== JSON.stringify(used)) {
    fail(
      `${label} carrier envelopes must exactly cover referenced logical payloads; ` +
        `declared=${declared.join(",")}, used=${used.join(",")}`,
    );
  }
}

async function readCarrierDocument(file, allowFileUrls) {
  let value;
  try {
    value = JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    fail(`could not read carrier ${file}: ${error.message}`);
  }
  const root = object(value, file);
  if (root.schema !== SCHEMA) fail(`${file} schema must be ${SCHEMA}`);
  exactKeys(root, ["base", "carriers", "extensions", "legal", "schema"], file);
  if (!Array.isArray(root.extensions)) fail(`${file}.extensions must be an array`);
  const base = validateBase(root.base, `${file}.base`, allowFileUrls);
  const carriers = validateCarrierEnvelopes(
    root.carriers,
    `${file}.carriers`,
    allowFileUrls,
  );
  const extensions = root.extensions.map((extension, index) =>
    validateExtension(extension, `${file}.extensions[${index}]`, carriers));
  const names = extensions.map(({ sqlName }) => sqlName);
  if (new Set(names).size !== names.length) fail(`${file}.extensions repeats an exact extension row`);
  const legal = validateLegalDocument(root.legal, `${file}.legal`, base, extensions);
  base.legal = legal.base;
  for (const extension of extensions) extension.legal = legal.extensions.get(extension.sqlName);
  assertExactCarrierCoverage(carriers, extensions, file);
  const releases = new Map();
  for (const extension of extensions) {
    const prior = releases.get(extension.product);
    const release = { tag: extension.tag, version: extension.version };
    if (prior !== undefined && JSON.stringify(prior) !== JSON.stringify(release)) {
      fail(`${file} contains conflicting release versions for owner ${extension.product}`);
    }
    releases.set(extension.product, release);
    if (extension.runtimeBound && extension.version !== base.version) {
      fail(
        `${file} runtime-bound owner ${extension.product} version ${extension.version} ` +
          `must match base runtime ${base.version}`,
      );
    }
  }
  return { base, carriers, extensions, source: file };
}

async function sha256File(file) {
  const hash = createHash("sha256");
  await pipeline(createReadStream(file), hash);
  return hash.digest("hex");
}

async function statOrUndefined(file) {
  return fs.lstat(file).catch((error) => {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  });
}

async function requireCacheDirectory(cacheDir, directory) {
  const root = path.resolve(cacheDir);
  const target = path.resolve(directory);
  const suffix = path.relative(root, target);
  if (suffix === ".." || suffix.startsWith(`..${path.sep}`)) {
    fail(`cache directory escapes configured cache root: ${target}`);
  }

  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const rootStat = await statOrUndefined(root);
  if (rootStat?.isSymbolicLink() || rootStat?.isDirectory() !== true) {
    fail(`cache root must be a real directory, not a symlink: ${root}`);
  }

  let current = root;
  for (const component of suffix.split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    let stat = await statOrUndefined(current);
    if (stat === undefined) {
      try {
        await fs.mkdir(current, { mode: 0o700 });
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
      }
      stat = await statOrUndefined(current);
    }
    if (stat?.isSymbolicLink() || stat?.isDirectory() !== true) {
      fail(`cache path component must be a real directory, not a symlink: ${current}`);
    }
  }
  return target;
}

async function rejectCacheLeafSymlink(file) {
  if ((await statOrUndefined(file))?.isSymbolicLink()) {
    fail(`cache entry must not be a symlink: ${file}`);
  }
}

function byteLimitTransform(limit, label) {
  let bytes = 0;
  return new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > limit) {
        callback(new Error(`${PREFIX}: ${label} exceeds its frozen ${limit}-byte limit`));
        return;
      }
      callback(null, chunk);
    },
  });
}

async function requirePayloadDirectory(file, label) {
  if ((await statOrUndefined(file))?.isDirectory() !== true) {
    fail(`${label} is missing: ${file}`);
  }
}

async function materializeAsset(asset, cacheDir) {
  const objects = await requireCacheDirectory(cacheDir, path.join(cacheDir, "objects"));
  const cached = path.join(objects, `${asset.sha256}-${asset.name}`);
  await rejectCacheLeafSymlink(cached);
  if ((await statOrUndefined(cached))?.isFile() === true) {
    const stat = await fs.stat(cached);
    if (stat.size === asset.bytes && (await sha256File(cached)) === asset.sha256) return cached;
  }
  await fs.rm(cached, { force: true, recursive: true });
  const temporary = `${cached}.tmp-${process.pid}-${Date.now()}`;
  const url = new URL(asset.url);
  try {
    if (url.protocol === "file:") {
      const source = fileURLToPath(url);
      const sourceStat = await statOrUndefined(source);
      if (sourceStat?.isFile() !== true || sourceStat.isSymbolicLink()) {
        fail(`file URL is not a regular non-symlink file: ${asset.url}`);
      }
      if (sourceStat.size !== asset.bytes) {
        fail(`size mismatch for ${asset.name}; expected ${asset.bytes}, got ${sourceStat.size}`);
      }
      await fs.copyFile(source, temporary, fsConstants.COPYFILE_EXCL);
    } else {
      const response = await fetch(url, { redirect: "follow" });
      if (!response.ok || response.body === null) {
        fail(`download ${asset.url} failed with HTTP ${response.status}`);
      }
      if (new URL(response.url).protocol !== "https:") {
        fail(`download ${asset.url} redirected outside HTTPS`);
      }
      await pipeline(
        Readable.fromWeb(response.body),
        byteLimitTransform(asset.bytes, `download ${asset.name}`),
        createWriteStream(temporary, { flags: "wx", mode: 0o600 }),
      );
    }
    const actualBytes = (await fs.stat(temporary)).size;
    if (actualBytes !== asset.bytes) {
      fail(`size mismatch for ${asset.name}; expected ${asset.bytes}, got ${actualBytes}`);
    }
    const actual = await sha256File(temporary);
    if (actual !== asset.sha256) {
      fail(`checksum mismatch for ${asset.name}; expected ${asset.sha256}, got ${actual}`);
    }
    await fs.rename(temporary, cached).catch(async (error) => {
      const existing = await statOrUndefined(cached);
      if (existing?.isFile() !== true || existing.isSymbolicLink()) throw error;
    });
    const cachedStat = await statOrUndefined(cached);
    if (
      cachedStat?.isFile() !== true || cachedStat.isSymbolicLink() ||
      cachedStat.size !== asset.bytes || (await sha256File(cached)) !== asset.sha256
    ) {
      fail(`cached object failed checksum verification after materialization: ${cached}`);
    }
    return cached;
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

async function materializeLogicalPayload(locator, carrierFile, cacheDir, carrierMemberCache) {
  if (locator.path === ".") return carrierFile;
  const directory = await requireCacheDirectory(cacheDir, path.join(cacheDir, "payloads"));
  const output = path.join(directory, `${locator.sha256}-${path.posix.basename(locator.path)}`);
  await rejectCacheLeafSymlink(output);
  const existing = await statOrUndefined(output);
  if (
    existing?.isFile() === true && !existing.isSymbolicLink() &&
    existing.size === locator.bytes && (await sha256File(output)) === locator.sha256
  ) {
    return output;
  }
  await fs.rm(output, { force: true, recursive: true });

  let members = carrierMemberCache.get(locator.envelope.sha256);
  if (members === undefined) {
    members = await archiveMembers(carrierFile, locator.envelope.format);
    carrierMemberCache.set(locator.envelope.sha256, members);
  }
  if (!members.has(locator.path)) {
    fail(`${locator.envelope.name} is missing nested logical payload ${locator.path}`);
  }

  const temporaryRoot = path.join(
    directory,
    `.tmp-${process.pid}-${Date.now()}-${locator.sha256}`,
  );
  await fs.rm(temporaryRoot, { force: true, recursive: true });
  await fs.mkdir(temporaryRoot, { recursive: true, mode: 0o700 });
  try {
    runWithCwd(
      "tar",
      ["-xzf", path.basename(carrierFile), "-C", temporaryRoot, locator.path],
      path.dirname(carrierFile),
      `extract ${locator.path} from ${locator.envelope.name}`,
    );
    const selected = path.join(temporaryRoot, ...locator.path.split("/"));
    const selectedStat = await statOrUndefined(selected);
    if (selectedStat?.isFile() !== true || selectedStat.isSymbolicLink()) {
      fail(`${locator.envelope.name} nested payload ${locator.path} is not a regular file`);
    }
    const actualSha256 = await sha256File(selected);
    if (selectedStat.size !== locator.bytes || actualSha256 !== locator.sha256) {
      fail(
        `${locator.envelope.name} nested payload ${locator.path} does not match ` +
          `its frozen size/checksum`,
      );
    }
    await fs.rename(selected, output);
    const outputStat = await statOrUndefined(output);
    if (
      outputStat?.isFile() !== true || outputStat.isSymbolicLink() ||
      outputStat.size !== locator.bytes || (await sha256File(output)) !== locator.sha256
    ) {
      fail(`nested payload cache entry failed verification after materialization: ${output}`);
    }
    return output;
  } finally {
    await fs.rm(temporaryRoot, { force: true, recursive: true });
  }
}

function run(command, args, label) {
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.error) fail(`${label}: ${result.error.message}`);
  if (result.status !== 0) {
    fail(`${label} failed (${result.status}): ${(result.stderr || result.stdout).trim()}`);
  }
  return result.stdout;
}

function runWithCwd(command, args, cwd, label) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) fail(`${label}: ${result.error.message}`);
  if (result.status !== 0) {
    fail(`${label} failed (${result.status}): ${(result.stderr || result.stdout).trim()}`);
  }
  return result.stdout;
}

const ZIP_UTF8 = new TextDecoder("utf-8", { fatal: true });

function zipRange(buffer, offset, length, archive, label) {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset > buffer.length - length) {
    fail(`${archive} has a truncated ZIP ${label}`);
  }
  return buffer.subarray(offset, offset + length);
}

function zipName(bytes, flags, archive, label) {
  if (bytes.length === 0) fail(`${archive} has an empty ZIP ${label}`);
  if ((flags & 0x0800) === 0 && bytes.some((value) => value >= 0x80)) {
    fail(`${archive} has a non-UTF-8 ZIP ${label}`);
  }
  try {
    return ZIP_UTF8.decode(bytes);
  } catch {
    fail(`${archive} has an invalid UTF-8 ZIP ${label}`);
  }
}

function zipExtraFields(bytes, archive, label) {
  const seen = new Set();
  let offset = 0;
  while (offset < bytes.length) {
    if (bytes.length - offset < 4) fail(`${archive} has a truncated ZIP ${label}`);
    const id = bytes.readUInt16LE(offset);
    const size = bytes.readUInt16LE(offset + 2);
    offset += 4;
    if (size > bytes.length - offset) fail(`${archive} has a truncated ZIP ${label} field 0x${id.toString(16)}`);
    if (seen.has(id)) fail(`${archive} repeats ZIP ${label} field 0x${id.toString(16)}`);
    if (!ALLOWED_ZIP_EXTRA_FIELDS.has(id)) {
      fail(`${archive} uses unsupported ZIP ${label} field 0x${id.toString(16)}`);
    }
    seen.add(id);
    offset += size;
  }
}

function zipDirectory(buffer, archive) {
  if (buffer.length < 22) fail(`${archive} is too short to contain a ZIP end record`);
  const minimum = Math.max(0, buffer.length - 65_557);
  let eocd = -1;
  for (let offset = buffer.length - 22; offset >= minimum; offset -= 1) {
    if (
      buffer.readUInt32LE(offset) === 0x06054b50
      && offset + 22 + buffer.readUInt16LE(offset + 20) === buffer.length
    ) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) fail(`${archive} has no well-formed ZIP end record`);
  const disk = buffer.readUInt16LE(eocd + 4);
  const centralDisk = buffer.readUInt16LE(eocd + 6);
  const diskEntries = buffer.readUInt16LE(eocd + 8);
  const entries = buffer.readUInt16LE(eocd + 10);
  const centralSize = buffer.readUInt32LE(eocd + 12);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  if (
    disk === 0xffff || centralDisk === 0xffff || diskEntries === 0xffff || entries === 0xffff
    || centralSize === 0xffffffff || centralOffset === 0xffffffff
  ) {
    fail(`${archive} uses unsupported ZIP64 metadata`);
  }
  if (disk !== 0 || centralDisk !== 0 || diskEntries !== entries) {
    fail(`${archive} uses unsupported multi-disk ZIP metadata`);
  }
  if (entries === 0 || centralOffset > eocd || centralSize !== eocd - centralOffset) {
    fail(`${archive} has an invalid or ambiguous ZIP central-directory extent`);
  }
  return { centralEnd: eocd, centralOffset, entries };
}

function zipDescriptor(buffer, entry, offset, length, archive) {
  if (length !== 12 && length !== 16) {
    fail(`${archive} has an ambiguous ${length}-byte ZIP gap after ${JSON.stringify(entry.raw)}`);
  }
  const descriptor = zipRange(buffer, offset, length, archive, `data descriptor for ${JSON.stringify(entry.raw)}`);
  let cursor = 0;
  if (length === 16) {
    if (descriptor.readUInt32LE(0) !== 0x08074b50) {
      fail(`${archive} has an invalid ZIP data-descriptor signature for ${JSON.stringify(entry.raw)}`);
    }
    cursor = 4;
  }
  if (
    descriptor.readUInt32LE(cursor) !== entry.crc32
    || descriptor.readUInt32LE(cursor + 4) !== entry.compressedSize
    || descriptor.readUInt32LE(cursor + 8) !== entry.size
  ) {
    fail(`${archive} has a ZIP data descriptor that disagrees with ${JSON.stringify(entry.raw)}`);
  }
}

function zipMemberType(versionMadeBy, externalAttributes, raw, archive) {
  const host = versionMadeBy >>> 8;
  const unixType = (externalAttributes >>> 16) & 0o170000;
  const pathDirectory = raw.endsWith("/");
  const dosDirectory = (externalAttributes & 0x10) !== 0;
  let type;

  if (host === 3) {
    if (unixType === 0o100000) {
      type = "-";
      if (dosDirectory) {
        fail(`${archive} Unix regular file also carries the DOS directory bit: ${raw}`);
      }
    } else if (unixType === 0o040000) {
      type = "d";
    } else if (unixType === 0) {
      fail(`${archive} has an ambiguous Unix member type: ${raw}`);
    } else {
      fail(`${archive} contains a link or special entry: ${raw}`);
    }
  } else if (host === 0) {
    if (unixType !== 0) {
      fail(`${archive} FAT-origin member carries conflicting Unix type metadata: ${raw}`);
    }
    if (dosDirectory !== pathDirectory) {
      fail(`${archive} FAT-origin member has inconsistent directory metadata: ${raw}`);
    }
    type = pathDirectory ? "d" : "-";
  } else {
    fail(`${archive} uses unsupported ZIP creator host ${host} for ${raw}`);
  }

  if ((type === "d") !== pathDirectory) {
    fail(`${archive} member type/path marker mismatch: ${raw}`);
  }
  return type;
}

async function zipEntries(archive, maxEntries) {
  const buffer = await fs.readFile(archive);
  const { centralEnd, centralOffset, entries: entryCount } = zipDirectory(buffer, archive);
  if (entryCount > maxEntries) {
    fail(`${archive} exceeds the maximum supported ${maxEntries} archive entries`);
  }
  const entries = [];
  let offset = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    const header = zipRange(buffer, offset, 46, archive, `central header ${index + 1}`);
    if (header.readUInt32LE(0) !== 0x02014b50) fail(`${archive} has an invalid ZIP central header ${index + 1}`);
    const versionMadeBy = header.readUInt16LE(4);
    const flags = header.readUInt16LE(8);
    const method = header.readUInt16LE(10);
    if ((flags & 0x0001) !== 0 || (flags & 0x0040) !== 0) {
      fail(`${archive} contains an encrypted ZIP member`);
    }
    if ((flags & ~0x080e) !== 0) {
      fail(`${archive} uses unsupported ZIP general-purpose flags 0x${flags.toString(16)}`);
    }
    if (method !== 0 && method !== 8) fail(`${archive} uses unsupported ZIP compression method ${method}`);
    if (method !== 8 && (flags & 0x0006) !== 0) {
      fail(`${archive} uses deflate-only ZIP flags with compression method ${method}`);
    }
    const compressedSize = header.readUInt32LE(20);
    const size = header.readUInt32LE(24);
    const nameLength = header.readUInt16LE(28);
    const extraLength = header.readUInt16LE(30);
    const commentLength = header.readUInt16LE(32);
    const diskStart = header.readUInt16LE(34);
    const externalAttributes = header.readUInt32LE(38);
    const localOffset = header.readUInt32LE(42);
    if (compressedSize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff || diskStart === 0xffff) {
      fail(`${archive} uses unsupported ZIP64 entry metadata`);
    }
    if (diskStart !== 0) fail(`${archive} contains a multi-disk ZIP member`);
    const recordLength = 46 + nameLength + extraLength + commentLength;
    const record = zipRange(buffer, offset, recordLength, archive, `central entry ${index + 1}`);
    const rawName = Buffer.from(record.subarray(46, 46 + nameLength));
    const raw = zipName(rawName, flags, archive, `member name ${index + 1}`);
    zipExtraFields(
      record.subarray(46 + nameLength, 46 + nameLength + extraLength),
      archive,
      `central extra metadata for ${JSON.stringify(raw)}`,
    );
    const type = zipMemberType(versionMadeBy, externalAttributes, raw, archive);
    if (type === "d" && (compressedSize !== 0 || size !== 0)) fail(`${archive} has a non-empty directory entry: ${raw}`);
    if (method === 0 && compressedSize !== size) fail(`${archive} has an invalid stored ZIP size for ${raw}`);

    const local = zipRange(buffer, localOffset, 30, archive, `local header for ${JSON.stringify(raw)}`);
    if (local.readUInt32LE(0) !== 0x04034b50) fail(`${archive} has an invalid ZIP local header for ${raw}`);
    if (local.readUInt16LE(6) !== flags || local.readUInt16LE(8) !== method) {
      fail(`${archive} ZIP local metadata disagrees with ${raw}`);
    }
    const localNameLength = local.readUInt16LE(26);
    const localExtraLength = local.readUInt16LE(28);
    const localName = zipRange(buffer, localOffset + 30, localNameLength, archive, `local name for ${JSON.stringify(raw)}`);
    if (!localName.equals(rawName)) fail(`${archive} ZIP local name disagrees with ${raw}`);
    zipExtraFields(
      zipRange(buffer, localOffset + 30 + localNameLength, localExtraLength, archive, `local extra metadata for ${JSON.stringify(raw)}`),
      archive,
      `local extra metadata for ${JSON.stringify(raw)}`,
    );
    const descriptor = (flags & 0x0008) !== 0;
    const localCrc32 = local.readUInt32LE(14);
    const localCompressedSize = local.readUInt32LE(18);
    const localSize = local.readUInt32LE(22);
    if (descriptor) {
      if (
        (localCrc32 !== 0 && localCrc32 !== header.readUInt32LE(16))
        || (localCompressedSize !== 0 && localCompressedSize !== compressedSize)
        || (localSize !== 0 && localSize !== size)
      ) {
        fail(`${archive} ZIP local descriptor metadata disagrees with ${raw}`);
      }
    } else if (
      localCrc32 !== header.readUInt32LE(16)
      || localCompressedSize !== compressedSize
      || localSize !== size
    ) {
      fail(`${archive} ZIP local CRC or sizes disagree with ${raw}`);
    }
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    if (dataOffset > centralOffset || compressedSize > centralOffset - dataOffset) {
      fail(`${archive} ZIP payload overlaps the central directory for ${raw}`);
    }
    entries.push({
      compressedSize,
      crc32: header.readUInt32LE(16),
      dataEnd: dataOffset + compressedSize,
      descriptor,
      localOffset,
      raw,
      size,
      type,
    });
    offset += recordLength;
  }
  if (offset !== centralEnd) fail(`${archive} ZIP central directory contains trailing or missing records`);
  const extents = [...entries].sort((left, right) => left.localOffset - right.localOffset || left.dataEnd - right.dataEnd);
  if (extents[0]?.localOffset !== 0) fail(`${archive} has unreferenced bytes before its first ZIP local record`);
  for (let index = 0; index < extents.length; index += 1) {
    const entry = extents[index];
    const nextOffset = extents[index + 1]?.localOffset ?? centralOffset;
    if (entry.dataEnd > nextOffset) fail(`${archive} has overlapping ZIP local records`);
    const gap = nextOffset - entry.dataEnd;
    if (entry.descriptor) zipDescriptor(buffer, entry, entry.dataEnd, gap, archive);
    else if (gap !== 0) fail(`${archive} has an ambiguous ${gap}-byte ZIP gap after ${JSON.stringify(entry.raw)}`);
  }
  return entries;
}

function tarString(header, offset, length, archive) {
  const field = header.subarray(offset, offset + length);
  const end = field.indexOf(0);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(field.subarray(0, end < 0 ? field.length : end));
  } catch {
    fail(`${archive} contains a non-UTF-8 ustar header field`);
  }
}

function tarOctal(header, offset, length, label, archive) {
  const value = header.subarray(offset, offset + length).toString("ascii").replaceAll("\0", "").trim();
  if (value !== "" && !/^[0-7]+$/u.test(value)) fail(`${archive} has invalid ustar ${label}`);
  const parsed = value === "" ? 0 : Number.parseInt(value, 8);
  if (!Number.isSafeInteger(parsed) || parsed < 0) fail(`${archive} has unsafe ustar ${label}`);
  return parsed;
}

async function tarEntries(archive, maxEntries = MAX_ARCHIVE_ENTRIES) {
  const entries = [];
  let currentEntry = "archive header";
  let pending = Buffer.alloc(0);
  let remainingPayload = 0;
  let expandedBytes = 0;
  let streamedBytes = 0;
  let terminated = false;
  let zeroBlocks = 0;
  try {
    const stream = createReadStream(archive).pipe(createGunzip());
    for await (const chunk of stream) {
      streamedBytes += chunk.length;
      if (streamedBytes > archiveStreamLimit(maxEntries)) {
        fail(`${archive} expands beyond the maximum supported archive size`);
      }
      let offset = 0;
      while (offset < chunk.length) {
        if (terminated) {
          if (!chunk.subarray(offset).every((value) => value === 0)) {
            fail(`${archive} has data after its ustar end marker`);
          }
          break;
        }
        if (remainingPayload > 0) {
          const consumed = Math.min(remainingPayload, chunk.length - offset);
          remainingPayload -= consumed;
          offset += consumed;
          continue;
        }
        const consumed = Math.min(512 - pending.length, chunk.length - offset);
        pending = pending.length === 0
          ? Buffer.from(chunk.subarray(offset, offset + consumed))
          : Buffer.concat([pending, chunk.subarray(offset, offset + consumed)]);
        offset += consumed;
        if (pending.length < 512) continue;

        const header = pending;
        pending = Buffer.alloc(0);
        if (header.every((value) => value === 0)) {
          zeroBlocks += 1;
          if (zeroBlocks >= 2) terminated = true;
          continue;
        }
        if (zeroBlocks > 0) fail(`${archive} has an incomplete ustar end marker`);

        const posixUstar = header.subarray(257, 263).equals(Buffer.from("ustar\0"))
          && header.subarray(263, 265).equals(Buffer.from("00"));
        const gnuUstar = header.subarray(257, 263).equals(Buffer.from("ustar "))
          && header[263] === 0x20 && header[264] === 0;
        if (!posixUstar && !gnuUstar) fail(`${archive} contains a non-ustar header`);

        const expectedChecksum = tarOctal(header, 148, 8, "checksum", archive);
        let actualChecksum = 0;
        for (let index = 0; index < 512; index += 1) {
          actualChecksum += index >= 148 && index < 156 ? 0x20 : header[index];
        }
        if (expectedChecksum !== actualChecksum) fail(`${archive} has an invalid ustar header checksum`);

        const name = tarString(header, 0, 100, archive);
        const prefix = tarString(header, 345, 155, archive);
        const raw = prefix ? `${prefix}/${name}` : name;
        currentEntry = JSON.stringify(raw);
        const size = tarOctal(header, 124, 12, `size for ${currentEntry}`, archive);
        if (size > MAX_ARCHIVE_MEMBER_BYTES) {
          fail(
            `${archive} member ${currentEntry} exceeds the maximum expanded member size ` +
              `of ${MAX_ARCHIVE_MEMBER_BYTES} bytes`,
          );
        }
        expandedBytes += size;
        if (!Number.isSafeInteger(expandedBytes) || expandedBytes > MAX_ARCHIVE_EXPANDED_BYTES) {
          fail(`${archive} exceeds the maximum supported expanded archive size`);
        }
        const typeFlag = header[156];
        const type = typeFlag === 0 || typeFlag === 0x30 ? "-" : typeFlag === 0x35 ? "d" : null;
        if (type === null) fail(`${archive} contains a link or special entry: ${raw}`);
        if (type === "d" && size !== 0) fail(`${archive} has a non-empty directory entry: ${raw}`);
        remainingPayload = Math.ceil(size / 512) * 512;
        if (!Number.isSafeInteger(remainingPayload)) fail(`${archive} has unsafe padded size for ${currentEntry}`);
        entries.push({ raw, size, type });
        if (entries.length > maxEntries) {
          fail(`${archive} exceeds the maximum supported ${maxEntries} archive entries`);
        }
      }
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(`${PREFIX}:`)) throw error;
    fail(`${archive} is not a readable gzip tar archive: ${error.message}`);
  }
  if (remainingPayload > 0) fail(`${archive} has a truncated entry: ${currentEntry}`);
  if (pending.length > 0) fail(`${archive} has a truncated ustar header`);
  if (!terminated) fail(`${archive} is missing its two-block ustar end marker`);
  return entries;
}

async function archiveMembers(archive, format, maxEntries = MAX_ARCHIVE_ENTRIES) {
  const archiveStat = await statOrUndefined(archive);
  if (archiveStat?.isFile() !== true || archiveStat.isSymbolicLink()) {
    fail(`${archive} is not a regular archive file`);
  }
  if (archiveStat.size <= 0 || archiveStat.size > MAX_CARRIER_BYTES) {
    fail(`${archive} exceeds the maximum supported carrier size of ${MAX_CARRIER_BYTES} bytes`);
  }
  if (format === "zip" && archiveStat.size > MAX_ZIP_CARRIER_BYTES) {
    fail(`${archive} exceeds the maximum supported ZIP carrier size of ${MAX_ZIP_CARRIER_BYTES} bytes`);
  }
  let entries;
  if (format === "tar.gz") {
    entries = await tarEntries(archive, maxEntries);
  } else {
    const zipRows = await zipEntries(archive, maxEntries);
    let expandedBytes = 0;
    entries = zipRows.map(({ raw, size, type }) => {
      if (size > MAX_ARCHIVE_MEMBER_BYTES) {
        fail(
          `${archive} member ${JSON.stringify(raw)} exceeds the maximum expanded member size ` +
            `of ${MAX_ARCHIVE_MEMBER_BYTES} bytes`,
        );
      }
      expandedBytes += size;
      if (!Number.isSafeInteger(expandedBytes) || expandedBytes > MAX_ARCHIVE_EXPANDED_BYTES) {
        fail(`${archive} exceeds the maximum supported expanded archive size`);
      }
      return { raw, size, type };
    });
  }
  if (entries.length === 0) fail(`${archive} has no archive members`);
  const normalizedEntries = entries.map(({ raw, size, type }) => {
    if (!["-", "d"].includes(type)) fail(`${archive} contains a link or special entry: ${raw}`);
    const directoryMarker = raw.endsWith("/");
    // POSIX tar headers establish directories with typeflag 5; unlike ZIP, a
    // trailing slash in the stored path is conventional rather than required.
    // Keep rejecting file entries that masquerade as directories, and retain
    // the stricter two-signal check for ZIP metadata.
    const markerMismatch = format === "zip"
      ? (type === "d") !== directoryMarker
      : type !== "d" && directoryMarker;
    if (markerMismatch && raw !== "." && raw !== "./") {
      fail(`${archive} member type/path marker mismatch: ${raw}`);
    }
    return {
      name: safeRelative(raw.replace(/\/$/u, "") || ".", `${archive} member`),
      size,
      type: type === "d" ? "directory" : "file",
    };
  });
  const names = normalizedEntries.map(({ name }) => name);
  if (new Set(names).size !== names.length) fail(`${archive} repeats a normalized archive member`);
  const folded = names.map((name) => name.normalize("NFC").toLocaleLowerCase("en-US"));
  if (new Set(folded).size !== folded.length) {
    fail(`${archive} has case-colliding archive members or Unicode-normalization collisions`);
  }
  const files = new Set(normalizedEntries.filter(({ type }) => type === "file").map(({ name }) => name));
  for (const entry of normalizedEntries) {
    let separator = entry.name.indexOf("/");
    while (separator >= 0) {
      const parent = entry.name.slice(0, separator);
      if (files.has(parent)) fail(`${archive} uses file ${parent} as an archive directory`);
      separator = entry.name.indexOf("/", separator + 1);
    }
  }
  return new Map(normalizedEntries.map(({ name, type }) => [name, type]));
}

function jsonDigest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function extractedTree(root, maxEntries = MAX_ARCHIVE_ENTRIES) {
  const result = [];
  const pending = [{ directory: root, relative: "" }];
  let expandedBytes = 0;
  while (pending.length > 0) {
    const { directory, relative } = pending.pop();
    for (const name of (await fs.readdir(directory)).sort(compareText).reverse()) {
      const file = path.join(directory, name);
      const fileRelative = relative ? `${relative}/${name}` : name;
      safeRelative(fileRelative, `${root} extracted member`);
      const stat = await fs.lstat(file);
      if (stat.isSymbolicLink()) fail(`extracted carrier contains symlink: ${file}`);
      if (stat.isDirectory()) {
        result.push({ path: fileRelative, type: "directory" });
        pending.push({ directory: file, relative: fileRelative });
      } else if (stat.isFile()) {
        if (stat.size > MAX_ARCHIVE_MEMBER_BYTES) {
          fail(`${root} extracted member ${fileRelative} exceeds the maximum supported member size`);
        }
        expandedBytes += stat.size;
        if (!Number.isSafeInteger(expandedBytes) || expandedBytes > MAX_ARCHIVE_EXPANDED_BYTES) {
          fail(`${root} extracted tree exceeds the maximum supported expanded size`);
        }
        result.push({
          bytes: stat.size,
          executable: (stat.mode & 0o111) !== 0,
          path: fileRelative,
          sha256: await sha256File(file),
          type: "file",
        });
      } else {
        fail(`extracted carrier contains unsupported entry: ${file}`);
      }
      if (result.length > maxEntries) {
        fail(`${root} extracted tree exceeds the maximum supported ${maxEntries} entries`);
      }
    }
  }
  result.sort((left, right) => compareText(left.path, right.path));
  return result;
}

function assertArchiveTreeMatches(members, tree, archive) {
  const expected = [...members]
    .filter(([name]) => name !== ".")
    .sort(([left], [right]) => compareText(left, right));
  const actual = tree
    .map(({ path: name, type }) => [name, type])
    .sort(([left], [right]) => compareText(left, right));
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`${archive} extracted tree does not exactly match its validated archive member plan`);
  }
}

async function extractedCacheValid(
  root,
  manifestFile,
  archiveSha256,
  maxEntries = MAX_ARCHIVE_ENTRIES,
) {
  if ((await statOrUndefined(root))?.isDirectory() !== true || (await statOrUndefined(manifestFile))?.isFile() !== true) return false;
  try {
    const manifest = object(JSON.parse(await fs.readFile(manifestFile, "utf8")), manifestFile);
    exactKeys(manifest, ["archiveSha256", "entries", "schema", "treeSha256"], manifestFile);
    if (manifest.schema !== EXTRACTED_CACHE_SCHEMA || manifest.archiveSha256 !== archiveSha256 || !Array.isArray(manifest.entries)) return false;
    if (manifest.treeSha256 !== jsonDigest(manifest.entries)) return false;
    const actual = await extractedTree(root, maxEntries);
    return manifest.treeSha256 === jsonDigest(actual) && JSON.stringify(manifest.entries) === JSON.stringify(actual);
  } catch {
    return false;
  }
}

async function extractedAsset(asset, archive, cacheDir) {
  const maxEntries = archiveEntryLimit(asset);
  const parent = await requireCacheDirectory(cacheDir, path.join(cacheDir, "extracted"));
  const root = path.join(parent, asset.sha256);
  const cacheManifest = `${root}.tree.json`;
  await rejectCacheLeafSymlink(root);
  await rejectCacheLeafSymlink(cacheManifest);
  if (await extractedCacheValid(root, cacheManifest, asset.sha256, maxEntries)) return root;
  await fs.rm(root, { force: true, recursive: true });
  await fs.rm(cacheManifest, { force: true });
  const members = await archiveMembers(archive, asset.format, maxEntries);
  if (asset.member !== "." && !members.has(asset.member) && ![...members.keys()].some((entry) => entry.startsWith(`${asset.member}/`))) {
    fail(`${asset.name} is missing declared member ${asset.member}`);
  }
  const temporary = path.join(parent, `.${asset.sha256}.tmp-${process.pid}-${Date.now()}`);
  const temporaryManifest = `${cacheManifest}.tmp-${process.pid}-${Date.now()}`;
  await fs.rm(temporary, { force: true, recursive: true });
  await fs.mkdir(temporary, { recursive: true });
  try {
    if (asset.format === "zip") {
      run("unzip", ["-q", archive, "-d", temporary], `extract ${asset.name}`);
    } else {
      runWithCwd(
        "tar",
        ["-xzf", path.basename(archive), "-C", temporary],
        path.dirname(archive),
        `extract ${asset.name}`,
      );
    }
    const tree = await extractedTree(temporary, maxEntries);
    if (asset.format === "zip") assertArchiveTreeMatches(members, tree, archive);
    const manifest = {
      archiveSha256: asset.sha256,
      entries: tree,
      schema: EXTRACTED_CACHE_SCHEMA,
      treeSha256: jsonDigest(tree),
    };
    const selected = asset.member === "." ? temporary : path.join(temporary, ...asset.member.split("/"));
    if ((await statOrUndefined(selected))?.isDirectory() !== true) {
      fail(`${asset.name} member is not a directory: ${asset.member}`);
    }
    await fs.writeFile(temporaryManifest, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
    await fs.rename(temporary, root);
    await fs.rename(temporaryManifest, cacheManifest);
    const rootStat = await statOrUndefined(root);
    const manifestStat = await statOrUndefined(cacheManifest);
    if (
      rootStat?.isDirectory() !== true || rootStat.isSymbolicLink() ||
      manifestStat?.isFile() !== true || manifestStat.isSymbolicLink() ||
      !(await extractedCacheValid(root, cacheManifest, asset.sha256, maxEntries))
    ) {
      fail(`extracted cache failed verification after materialization: ${root}`);
    }
    return root;
  } catch (error) {
    await fs.rm(temporary, { force: true, recursive: true });
    await fs.rm(temporaryManifest, { force: true });
    await fs.rm(root, { force: true, recursive: true });
    await fs.rm(cacheManifest, { force: true });
    throw error;
  }
}

async function resolveAssetArchiveRoot(asset, cacheDir) {
  const archive = await materializeAsset(asset, cacheDir);
  return extractedAsset(asset, archive, cacheDir);
}

async function resolveAsset(asset, cacheDir) {
  const extracted = await resolveAssetArchiveRoot(asset, cacheDir);
  const member = asset.member === "."
    ? extracted
    : path.join(extracted, ...asset.member.split("/"));
  const stat = await statOrUndefined(member);
  if (stat?.isDirectory() !== true) fail(`${asset.name} member is not a directory: ${asset.member}`);
  return member;
}

async function resolveLogicalArchiveRoot(locator, cacheDir, carrierMemberCache) {
  const carrierFile = await materializeAsset(locator.envelope, cacheDir);
  const archive = await materializeLogicalPayload(
    locator,
    carrierFile,
    cacheDir,
    carrierMemberCache,
  );
  const logicalAsset = {
    ...locator,
    name: locator.path === "." ? locator.envelope.name : path.posix.basename(locator.path),
  };
  return extractedAsset(logicalAsset, archive, cacheDir);
}

async function resolveLogicalAsset(locator, cacheDir, carrierMemberCache) {
  const extracted = await resolveLogicalArchiveRoot(locator, cacheDir, carrierMemberCache);
  const member = locator.member === "."
    ? extracted
    : path.join(extracted, ...locator.member.split("/"));
  const stat = await statOrUndefined(member);
  if (stat?.isDirectory() !== true) {
    fail(`${locator.envelope.name} logical member is not a directory: ${locator.member}`);
  }
  return member;
}

async function copyTree(source, destination) {
  const stat = await fs.lstat(source);
  if (stat.isSymbolicLink()) fail(`refusing to copy carrier symlink: ${source}`);
  if (stat.isDirectory()) {
    await fs.mkdir(destination, { recursive: true });
    const entries = (await fs.readdir(source)).sort(compareText);
    for (const name of entries) {
      await copyTree(path.join(source, name), path.join(destination, name));
    }
  } else if (stat.isFile()) {
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(source, destination);
    await fs.chmod(destination, stat.mode & 0o111 ? 0o755 : 0o644);
  } else {
    fail(`unsupported carrier entry: ${source}`);
  }
}

async function mergeTree(source, destination) {
  const stat = await fs.lstat(source);
  if (stat.isSymbolicLink()) fail(`refusing to merge carrier symlink: ${source}`);
  if (stat.isDirectory()) {
    await fs.mkdir(destination, { recursive: true });
    for (const name of (await fs.readdir(source)).sort(compareText)) {
      await mergeTree(path.join(source, name), path.join(destination, name));
    }
    return;
  }
  if (!stat.isFile()) fail(`unsupported carrier entry: ${source}`);
  const existing = await statOrUndefined(destination);
  if (existing !== undefined) {
    if (!existing.isFile() || (await sha256File(source)) !== (await sha256File(destination))) {
      fail(`selected carrier resources conflict at ${destination}`);
    }
    return;
  }
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.copyFile(source, destination);
  await fs.chmod(destination, stat.mode & 0o111 ? 0o755 : 0o644);
}

function legalRelativeMember(group, asset, member) {
  const prefix = asset.member === "." ? "" : `${asset.member}/`;
  if (prefix && member.startsWith(prefix)) return member.slice(prefix.length);
  return member;
}

function checkedLegalDestinations(rows) {
  const exact = new Set();
  const portable = new Map();
  for (const row of rows) {
    const destination = safeRelative(row.destination, "staged legal destination");
    if (destination === "." || exact.has(destination)) {
      fail(`staged legal destination is repeated or invalid: ${destination}`);
    }
    const folded = destination.normalize("NFC").toLowerCase();
    const prior = portable.get(folded);
    if (prior !== undefined) {
      fail(`staged legal destinations collide across case or Unicode normalization: ${prior}, ${destination}`);
    }
    exact.add(destination);
    portable.set(folded, destination);
  }
  for (const destination of exact) {
    let separator = destination.indexOf("/");
    while (separator >= 0) {
      const parent = destination.slice(0, separator);
      if (exact.has(parent)) {
        fail(`staged legal file ${parent} is also used as a directory`);
      }
      separator = destination.indexOf("/", separator + 1);
    }
  }
}

async function readVerifiedLegalFile(root, row, label) {
  const rootStat = await fs.lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    fail(`${label} archive root must be a real directory`);
  }
  const parts = row.member.split("/");
  let cursor = root;
  for (const part of parts.slice(0, -1)) {
    cursor = path.join(cursor, part);
    const stat = await fs.lstat(cursor).catch((error) => {
      fail(`${label} legal parent is missing: ${row.member} (${error.message})`);
    });
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      fail(`${label} legal parent must be a real directory: ${row.member}`);
    }
  }
  const file = path.join(cursor, parts.at(-1));
  const leaf = await fs.lstat(file).catch((error) => {
    fail(`${label} legal file is missing: ${row.member} (${error.message})`);
  });
  if (!leaf.isFile() || leaf.isSymbolicLink()) {
    fail(`${label} legal member must be a regular non-symlink file: ${row.member}`);
  }
  const handle = await fs.open(
    file,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
  );
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size !== row.bytes) {
      fail(`${label} legal member has the wrong type or byte count: ${row.member}`);
    }
    const bytes = await handle.readFile();
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== row.sha256) {
      fail(`${label} legal member checksum mismatch: ${row.member}`);
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

async function writeSafeLegalFile(root, relative, bytes) {
  const parts = relative.split("/");
  let cursor = root;
  for (const part of parts.slice(0, -1)) {
    cursor = path.join(cursor, part);
    await fs.mkdir(cursor, { mode: 0o755 }).catch((error) => {
      if (error?.code !== "EEXIST") throw error;
    });
    const stat = await fs.lstat(cursor);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      fail(`staged legal parent must be a real directory: ${cursor}`);
    }
    await fs.chmod(cursor, 0o755);
  }
  const destination = path.join(root, ...parts);
  await fs.writeFile(destination, bytes, { flag: "wx", mode: 0o644 });
  await fs.chmod(destination, 0o644);
}

function combinedSpdx(groups) {
  const terms = [];
  const seen = new Set();
  for (const group of groups) {
    for (const term of group.spdx.split(" AND ")) {
      if (!seen.has(term)) {
        seen.add(term);
        terms.push(term);
      }
    }
  }
  return terms.join(" AND ");
}

function renderLegalNotice(spdx, files) {
  return [
    "# Oliphaunt app-owned iOS payload legal notices",
    "",
    `SPDX-License-Identifier: ${spdx}`,
    "",
    "This file indexes the exact legal files materialized from the selected frozen carriers.",
    "",
    ...files.map((row) => `- \`${row.destination}\` (${row.kind}; SHA-256 \`${row.sha256}\`)`),
    "",
  ].join("\n");
}

async function stageSelectedLegalFiles({
  args,
  base,
  carrierMemberCache,
  selected,
  temporary,
}) {
  const baseAssets = new Map([
    [base.assets.framework.role, base.assets.framework],
    [base.assets.runtime.role, base.assets.runtime],
    [base.assets.icu.role, base.assets.icu],
  ]);
  const groups = [];
  for (const group of base.legal) {
    if (group.assetRole === "icu-data" && !args.icu) continue;
    const asset = baseAssets.get(group.assetRole);
    if (asset === undefined) fail(`base legal group references missing ${group.assetRole} asset`);
    groups.push({
      asset,
      group,
      label: `base ${group.assetRole}`,
      scope: `base/${group.assetRole}`,
      source: "base",
    });
  }
  for (const extension of [...selected].sort((left, right) => compareText(left.sqlName, right.sqlName))) {
    groups.push({
      asset: extension.assets.runtime,
      group: extension.legal,
      label: `extension ${extension.sqlName}`,
      scope: `extensions/${extension.sqlName}`,
      source: "extension",
    });
  }
  const planned = groups
    .flatMap(({ asset, group, label, scope, source }) =>
      group.files.map((row) => ({
        ...row,
        asset,
        destination: `licenses/${scope}/${legalRelativeMember(group, asset, row.member)}`,
        label,
        source,
      })))
    .sort((left, right) => compareText(left.destination, right.destination));
  checkedLegalDestinations(planned);
  const legalRoot = path.join(temporary, "licenses");
  await fs.mkdir(legalRoot, { recursive: true, mode: 0o755 });
  await fs.chmod(legalRoot, 0o755);
  for (const row of planned) {
    const sourceRoot = row.source === "base"
      ? await resolveAssetArchiveRoot(row.asset, args.cacheDir)
      : await resolveLogicalArchiveRoot(row.asset, args.cacheDir, carrierMemberCache);
    const bytes = await readVerifiedLegalFile(sourceRoot, row, row.label);
    await writeSafeLegalFile(temporary, row.destination, bytes);
  }
  const spdx = combinedSpdx(groups.map(({ group }) => group));
  const notice = "licenses/NOTICE.md";
  await writeSafeLegalFile(temporary, notice, Buffer.from(renderLegalNotice(spdx, planned), "utf8"));
  return {
    file: notice,
    files: planned.map(({ bytes, destination, kind, member, sha256, source }) => ({
      bytes,
      destination,
      kind,
      member,
      sha256,
      source,
    })),
    spdx,
  };
}

function parseProperties(text, source) {
  const values = new Map();
  for (const [index, raw] of text.split(/\r?\n/u).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) fail(`${source}:${index + 1} is not key=value`);
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (values.has(key)) fail(`${source}:${index + 1} repeats ${key}`);
    values.set(key, value);
  }
  return values;
}

function csv(value, label) {
  return value ? uniquePortable(value.split(","), label) : [];
}

function requireProperty(values, key, expected, source) {
  if (values.get(key) !== expected) {
    fail(`${source} must declare ${key}=${expected}; got ${values.get(key) ?? "<missing>"}`);
  }
}

function rejectUnsupportedProperties(values, allowed, source) {
  const extras = [...values.keys()].filter((key) => !allowed.has(key)).sort(compareText);
  if (extras.length > 0) {
    fail(`${source} contains unsupported field(s): ${extras.join(", ")}`);
  }
}

function requireExactPropertySet(values, expected, source) {
  const missing = [...expected].filter((key) => !values.has(key)).sort(compareText);
  if (missing.length > 0) {
    fail(`${source} is missing canonical field(s): ${missing.join(", ")}`);
  }
}

function requireExtensionNativeRuntime(values, base, source) {
  const product = values.get("nativeRuntimeProduct");
  if (product === undefined) fail(`${source} is missing nativeRuntimeProduct`);
  portable(product, `${source} nativeRuntimeProduct`);
  if (product !== base.product) {
    fail(`${source} must declare nativeRuntimeProduct=${base.product}; got ${product}`);
  }

  const rawVersion = values.get("nativeRuntimeVersion");
  if (rawVersion === undefined) fail(`${source} is missing nativeRuntimeVersion`);
  const version = stableVersion(rawVersion, `${source} nativeRuntimeVersion`);
  if (version !== base.version) {
    fail(`${source} must declare nativeRuntimeVersion=${base.version}; got ${version}`);
  }
}

function requireExtensionLinkageMetadata(values, carrier, source) {
  const stem = carrier.nativeModuleStem;
  requireProperty(values, "nativeModuleFile", stem === null ? "" : `${stem}.dylib`, source);
  requireProperty(
    values,
    "staticSymbolPrefix",
    stem === null ? "" : `oliphaunt_static_${stem.replaceAll(/[^A-Za-z0-9_]/gu, "_")}`,
    source,
  );
  const aliases = carrier.registration?.symbols
    .filter(({ name, address }) => name !== address)
    .map(({ name, address }) => `${name}:${address}`)
    .sort(compareText) ?? [];
  requireProperty(values, "staticSymbolAliases", aliases.join(","), source);
}

function propertyRows(values, key, source) {
  const raw = values.get(key);
  if (raw === undefined) fail(`${source} is missing ${key}`);
  if (raw === "") return [];
  const rows = raw.split(",");
  if (rows.some((row) => row.length === 0)) fail(`${source} ${key} contains an empty row`);
  if (new Set(rows).size !== rows.length) fail(`${source} ${key} must not contain duplicates`);
  return rows;
}

function mobileStaticArchivePaths(values, carrier, source) {
  const rows = propertyRows(values, "mobileStaticArchives", source).map((row, index) => {
    const fields = row.split(":");
    if (fields.length !== 2) {
      fail(`${source} mobileStaticArchives[${index}] must be target:path`);
    }
    const target = portable(fields[0], `${source} mobileStaticArchives[${index}] target`);
    const relative = safeRelative(fields[1], `${source} mobileStaticArchives[${index}] path`);
    if (relative === ".") fail(`${source} mobileStaticArchives[${index}] must name a file`);
    return { relative, target };
  });
  const expectedTargets = carrier.nativeModuleStem === null
    ? []
    : ["ios-device", "ios-simulator"];
  if (JSON.stringify(rows.map(({ target }) => target)) !== JSON.stringify(expectedTargets)) {
    fail(
      `${source} mobileStaticArchives targets must be exactly ` +
      `${expectedTargets.join(",") || "<none>"}`,
    );
  }
  for (const { relative, target } of rows) {
    const stem = carrier.nativeModuleStem;
    const expected = `mobile-static/${target}/extensions/${stem}/liboliphaunt_extension_${stem}.a`;
    if (relative !== expected) {
      fail(`${source} mobileStaticArchives for ${target} must declare ${expected}; got ${relative}`);
    }
  }
  return rows.map(({ relative }) => relative);
}

function mobileStaticDependencyArchivePaths(values, carrier, source) {
  const rows = propertyRows(values, "mobileStaticDependencyArchives", source).map((row, index) => {
    const fields = row.split(":");
    if (fields.length !== 3) {
      fail(`${source} mobileStaticDependencyArchives[${index}] must be target:dependency:path`);
    }
    const target = portable(
      fields[0],
      `${source} mobileStaticDependencyArchives[${index}] target`,
    );
    const dependency = portable(
      fields[1],
      `${source} mobileStaticDependencyArchives[${index}] dependency`,
    );
    const relative = safeRelative(
      fields[2],
      `${source} mobileStaticDependencyArchives[${index}] path`,
    );
    if (relative === ".") {
      fail(`${source} mobileStaticDependencyArchives[${index}] must name a file`);
    }
    const directory = `mobile-static/${target}/dependencies/${dependency}`;
    const archiveName = path.posix.basename(relative);
    portableAssetName(archiveName, `${source} mobileStaticDependencyArchives[${index}] file`);
    if (
      path.posix.dirname(relative) !== directory ||
      !/^lib[A-Za-z0-9._-]+\.a$/u.test(archiveName)
    ) {
      fail(
        `${source} mobileStaticDependencyArchives[${index}] must name a portable static archive ` +
        `lib*.a directly under ${directory}; got ${relative}`,
      );
    }
    return { archiveName, dependency, relative, target };
  });
  const targets = carrier.nativeModuleStem === null ? [] : ["ios-device", "ios-simulator"];
  const expectedKeys = targets.flatMap((target) =>
    carrier.nativeDependencies.map((dependency) => `${target}\0${dependency}`));
  const actualKeys = rows.map(({ dependency, target }) => `${target}\0${dependency}`);
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
    fail(
      `${source} mobileStaticDependencyArchives must exactly cover both iOS static targets ` +
      `for nativeDependencies=${carrier.nativeDependencies.join(",") || "<none>"}`,
    );
  }
  const archiveNameByDependency = new Map();
  for (const { archiveName, dependency } of rows) {
    const prior = archiveNameByDependency.get(dependency);
    if (prior !== undefined && archiveName !== prior) {
      fail(
        `${source} mobileStaticDependencyArchives must use the same archive file name across ` +
        `both iOS static targets for dependency ${dependency}; got ${prior} and ${archiveName}`,
      );
    }
    archiveNameByDependency.set(dependency, archiveName);
  }
  return rows.map(({ relative }) => relative);
}

async function extensionArtifactEntries(root) {
  const entries = [];
  const collisions = new Map();
  const pending = [{ absolute: root, relative: "" }];
  while (pending.length > 0) {
    const { absolute, relative } = pending.pop();
    for (const name of (await fs.readdir(absolute)).sort(compareText).reverse()) {
      const file = path.join(absolute, name);
      const fileRelative = relative ? `${relative}/${name}` : name;
      safeRelative(fileRelative, `${root} extension artifact entry`);
      const folded = fileRelative.normalize("NFC").toLocaleLowerCase("en-US");
      const prior = collisions.get(folded);
      if (prior !== undefined && prior !== fileRelative) {
        fail(`${root} extension artifact paths collide across case or Unicode normalization: ${prior}, ${fileRelative}`);
      }
      collisions.set(folded, fileRelative);
      const stat = await fs.lstat(file);
      if (stat.isSymbolicLink()) fail(`${root} extension artifact contains symlink: ${fileRelative}`);
      if (stat.isDirectory()) {
        entries.push({ path: fileRelative, type: "directory" });
        pending.push({ absolute: file, relative: fileRelative });
      } else if (stat.isFile()) {
        entries.push({ path: fileRelative, type: "file" });
      } else {
        fail(`${root} extension artifact contains a special entry: ${fileRelative}`);
      }
    }
  }
  return entries.sort((left, right) => compareText(left.path, right.path));
}

function expectedExtensionArtifactEntries(files, source) {
  const expected = new Map();
  for (const file of files) {
    const relative = safeRelative(file, `${source} expected artifact file`);
    if (relative === ".") fail(`${source} expected artifact file must not be the root`);
    const existing = expected.get(relative);
    if (existing !== undefined && existing !== "file") {
      fail(`${source} expected artifact path is both a file and directory: ${relative}`);
    }
    expected.set(relative, "file");
    let parent = path.posix.dirname(relative);
    while (parent !== ".") {
      if (expected.get(parent) === "file") {
        fail(`${source} expected artifact file is used as a directory: ${parent}`);
      }
      expected.set(parent, "directory");
      parent = path.posix.dirname(parent);
    }
  }
  const collisions = new Map();
  for (const relative of expected.keys()) {
    const folded = relative.normalize("NFC").toLocaleLowerCase("en-US");
    const prior = collisions.get(folded);
    if (prior !== undefined && prior !== relative) {
      fail(`${source} expected artifact paths collide across case or Unicode normalization: ${prior}, ${relative}`);
    }
    collisions.set(folded, relative);
  }
  return expected;
}

async function validateExactExtensionArtifactInventory(
  root,
  carrier,
  dataFiles,
  extensionSqlFileNames,
  extensionSqlFilePrefixes,
  mobileStaticArchives,
  mobileStaticDependencyArchives,
  source,
) {
  const actualEntries = await extensionArtifactEntries(root);
  const actualFiles = new Set(
    actualEntries.filter(({ type }) => type === "file").map(({ path: entry }) => entry),
  );
  const expectedFiles = new Set(["manifest.properties"]);
  for (const legalFile of carrier.legal.files) expectedFiles.add(legalFile.member);
  if (carrier.createsExtension) {
    const extensionRoot = "files/share/postgresql/extension";
    const control = `${extensionRoot}/${carrier.sqlName}.control`;
    if (!actualFiles.has(control)) fail(`${source} is missing canonical control file ${control}`);
    expectedFiles.add(control);
    const ownedSqlFiles = [...actualFiles].filter((file) => {
      if (path.posix.dirname(file) !== extensionRoot) return false;
      const name = path.posix.basename(file);
      if (name === `${carrier.sqlName}.sql`) return true;
      const prefix = `${carrier.sqlName}--`;
      if (!name.startsWith(prefix) || !name.endsWith(".sql")) return false;
      const versionPath = name.slice(prefix.length, -".sql".length);
      return /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(versionPath);
    });
    const installSqlFiles = ownedSqlFiles.filter((file) => {
      const name = path.posix.basename(file);
      const prefix = `${carrier.sqlName}--`;
      if (!name.startsWith(prefix) || !name.endsWith(".sql")) return false;
      const version = name.slice(prefix.length, -".sql".length);
      return !version.includes("--") && /^[0-9][A-Za-z0-9._-]*$/u.test(version);
    });
    if (installSqlFiles.length === 0) {
      fail(`${source} is missing an install SQL file owned by ${carrier.sqlName}`);
    }
    const ancillarySqlFiles = [...actualFiles].filter((file) => {
      if (path.posix.dirname(file) !== extensionRoot) return false;
      const name = path.posix.basename(file);
      return (
        extensionSqlFileNames.includes(name) ||
        extensionSqlFilePrefixes.some(
          (prefix) => name.startsWith(prefix) && name.endsWith(".sql"),
        )
      );
    });
    for (const file of [...ownedSqlFiles, ...ancillarySqlFiles]) expectedFiles.add(file);
  }
  for (const dataFile of dataFiles) {
    expectedFiles.add(`files/share/postgresql/${dataFile}`);
  }
  if (carrier.nativeModuleStem !== null) {
    expectedFiles.add(`files/lib/postgresql/${carrier.nativeModuleStem}.dylib`);
  }
  for (const file of [...mobileStaticArchives, ...mobileStaticDependencyArchives]) {
    expectedFiles.add(file);
  }

  const expected = expectedExtensionArtifactEntries(expectedFiles, source);
  const actual = new Map(actualEntries.map((entry) => [entry.path, entry.type]));
  const missing = [...expected].filter(([entry, type]) => actual.get(entry) !== type)
    .map(([entry]) => entry);
  const extra = [...actual].filter(([entry, type]) => expected.get(entry) !== type)
    .map(([entry]) => entry);
  if (missing.length > 0 || extra.length > 0) {
    fail(
      `${source} extension artifact inventory must be exact; ` +
      `missing=${missing.slice(0, 10).join(",") || "<none>"}; ` +
      `extra=${extra.slice(0, 10).join(",") || "<none>"}`,
    );
  }
}

async function validateBaseResources(root) {
  const manifestFile = path.join(root, "runtime", "manifest.properties");
  const manifest = parseProperties(await fs.readFile(manifestFile, "utf8"), manifestFile);
  requireProperty(manifest, "schema", "oliphaunt-runtime-resources-v1", manifestFile);
  requireProperty(manifest, "layout", "postgres-runtime-files-v1", manifestFile);
  const createable = csv(manifest.get("extensions"), `${manifestFile} extensions`);
  const selected = manifest.has("selectedExtensions")
    ? csv(manifest.get("selectedExtensions"), `${manifestFile} selectedExtensions`)
    : createable;
  if (selected.length > 0 || createable.length > 0) {
    fail("base React Native iOS carrier is not extension-free");
  }
  if (csv(manifest.get("nativeModuleStems"), `${manifestFile} stems`).length > 0) {
    fail("base React Native iOS carrier contains native extension stems");
  }
  requireProperty(manifest, "mobileStaticRegistryState", "not-required", manifestFile);
  const template = path.join(root, "template-pgdata", "manifest.properties");
  const templateManifest = parseProperties(await fs.readFile(template, "utf8"), template);
  requireProperty(templateManifest, "schema", "oliphaunt-runtime-resources-v1", template);
  requireProperty(templateManifest, "layout", "postgres-template-pgdata-v1", template);
  return manifest;
}

async function extensionResourceRoot(carrier, base, cacheDir, carrierMemberCache) {
  const root = await resolveLogicalAsset(carrier.assets.runtime, cacheDir, carrierMemberCache);
  const manifestFile = path.join(root, "manifest.properties");
  const manifest = parseProperties(await fs.readFile(manifestFile, "utf8"), manifestFile);
  rejectUnsupportedProperties(manifest, EXTENSION_ARTIFACT_PROPERTY_KEYS, manifestFile);
  requireProperty(manifest, "packageLayout", "oliphaunt-extension-artifact-v1", manifestFile);
  requireProperty(manifest, "pgMajor", "18", manifestFile);
  requireProperty(manifest, "sqlName", carrier.sqlName, manifestFile);
  requireProperty(manifest, "nativeTarget", "ios-xcframework", manifestFile);
  requireExtensionNativeRuntime(manifest, base, manifestFile);
  requireProperty(manifest, "createsExtension", carrier.createsExtension ? "yes" : "no", manifestFile);
  requireProperty(manifest, "dependencies", carrier.dependencies.join(","), manifestFile);
  const extensionSqlFileNames = propertyRows(manifest, "extensionSqlFileNames", manifestFile)
    .map((value, index) => {
      const name = portable(value, `${manifestFile} extensionSqlFileNames[${index}]`);
      if (!name.endsWith(".sql")) {
        fail(`${manifestFile} extensionSqlFileNames[${index}] must name a SQL file`);
      }
      return name;
    });
  const extensionSqlFilePrefixes = propertyRows(
    manifest,
    "extensionSqlFilePrefixes",
    manifestFile,
  ).map((value, index) => {
    if (!/^[A-Za-z0-9_-]{1,128}$/u.test(value)) {
      fail(
        `${manifestFile} extensionSqlFilePrefixes[${index}] must be a dot-free ` +
          "portable SQL basename prefix",
      );
    }
    return value;
  });
  if (JSON.stringify(extensionSqlFileNames) !== JSON.stringify(carrier.extensionSqlFileNames)) {
    fail(`${manifestFile} extensionSqlFileNames must exactly match the frozen carrier contract for ${carrier.sqlName}`);
  }
  if (JSON.stringify(extensionSqlFilePrefixes) !== JSON.stringify(carrier.extensionSqlFilePrefixes)) {
    fail(`${manifestFile} extensionSqlFilePrefixes must exactly match the frozen carrier contract for ${carrier.sqlName}`);
  }
  requireProperty(manifest, "nativeModuleStem", carrier.nativeModuleStem ?? "", manifestFile);
  requireExtensionLinkageMetadata(manifest, carrier, manifestFile);
  requireProperty(
    manifest,
    "sharedPreloadLibraries",
    carrier.sharedPreloadLibraries.join(","),
    manifestFile,
  );
  requireProperty(manifest, "mobilePrebuilt", carrier.nativeModuleStem === null ? "no" : "yes", manifestFile);
  requireProperty(manifest, "licenseProfile", carrier.legal.profile, manifestFile);
  const expectedUpstreamLicenses = carrier.legal.files
    .map(({ member }) => /^files\/(share\/licenses\/.+)$/u.exec(member)?.[1])
    .filter((member) => member !== undefined)
    .sort(compareText);
  requireProperty(manifest, "licenseFiles", expectedUpstreamLicenses.join(","), manifestFile);
  requireProperty(manifest, "files", "files", manifestFile);
  const filesRoot = path.join(root, "files");
  if ((await statOrUndefined(filesRoot))?.isDirectory() !== true) {
    fail(`${carrier.sqlName} runtime carrier is missing files`);
  }

  if (!manifest.has("dataFiles")) fail(`${manifestFile} must declare dataFiles`);
  const dataFiles = manifest.get("dataFiles") === ""
    ? []
    : manifest.get("dataFiles").split(",").map((value, index) => {
        const relative = safeRelative(value, `${manifestFile} dataFiles[${index}]`);
        if (relative === ".") fail(`${manifestFile} dataFiles[${index}] must name a file`);
        return relative;
      });
  if (new Set(dataFiles).size !== dataFiles.length) fail(`${manifestFile} dataFiles must not contain duplicates`);
  if (JSON.stringify(dataFiles) !== JSON.stringify(carrier.dataFiles)) {
    fail(`${manifestFile} dataFiles must exactly match the frozen carrier contract for ${carrier.sqlName}`);
  }
  requireExactPropertySet(manifest, EXTENSION_ARTIFACT_PROPERTY_KEYS, manifestFile);
  const mobileStaticArchives = mobileStaticArchivePaths(manifest, carrier, manifestFile);
  const mobileStaticDependencyArchives = mobileStaticDependencyArchivePaths(
    manifest,
    carrier,
    manifestFile,
  );
  await validateExactExtensionArtifactInventory(
    root,
    carrier,
    dataFiles,
    extensionSqlFileNames,
    extensionSqlFilePrefixes,
    mobileStaticArchives,
    mobileStaticDependencyArchives,
    manifestFile,
  );

  const share = path.join(filesRoot, "share", "postgresql");
  const shareStat = await statOrUndefined(share);
  if (shareStat !== undefined && !shareStat.isDirectory()) {
    fail(`${carrier.sqlName} runtime carrier files/share/postgresql is not a directory`);
  }
  if (shareStat === undefined && (carrier.createsExtension || dataFiles.length > 0)) {
    fail(`${carrier.sqlName} runtime carrier is missing files/share/postgresql`);
  }
  return { root, share: shareStat === undefined ? null : share };
}

function selectedClosure(requested, bySqlName) {
  const ordered = [];
  const visiting = new Set();
  const visited = new Set();
  function visit(sqlName, requiredBy) {
    if (visited.has(sqlName)) return;
    if (visiting.has(sqlName)) fail(`extension dependency cycle includes ${sqlName}`);
    const carrier = bySqlName.get(sqlName);
    if (!carrier) fail(`missing iOS carrier for ${sqlName}${requiredBy ? ` required by ${requiredBy}` : ""}`);
    visiting.add(sqlName);
    for (const dependency of carrier.dependencies) visit(dependency, sqlName);
    visiting.delete(sqlName);
    visited.add(sqlName);
    ordered.push(carrier);
  }
  for (const sqlName of requested) visit(sqlName, undefined);
  return ordered;
}

function writeProperties(values) {
  const preferred = [
    "schema", "layout", "cacheKey", "source", "selectedExtensions", "extensions", "runtimeFeatures",
    "sharedPreloadLibraries", "mobileStaticRegistryState", "mobileStaticRegistryRegistered",
    "mobileStaticRegistryPending", "nativeModuleStems", "mobileStaticRegistrySource",
  ];
  const keys = [
    ...preferred.filter((key) => values.has(key)),
    ...[...values.keys()].filter((key) => !preferred.includes(key)).sort(compareText),
  ];
  return `${keys.map((key) => `${key}=${values.get(key)}`).join("\n")}\n`;
}

function renderRegistrySource(nativeCarriers) {
  const declarations = [];
  const arrays = [];
  const descriptors = [];
  for (const carrier of nativeCarriers) {
    const suffix = carrier.nativeModuleStem.replaceAll(/[^A-Za-z0-9_]/gu, "_");
    const array = `oliphaunt_${suffix}_symbols`;
    declarations.push(`extern const void *${carrier.registration.magicSymbol}(void);`);
    if (carrier.registration.initSymbol) declarations.push(`extern void ${carrier.registration.initSymbol}(void);`);
    for (const symbol of carrier.registration.symbols) declarations.push(`extern void ${symbol.address}(void);`);
    if (carrier.registration.symbols.length > 0) {
      arrays.push(
        `static const OliphauntStaticExtensionSymbol ${array}[] = {\n` +
          carrier.registration.symbols
            .map(({ name, address }) => `    { .name = ${JSON.stringify(name)}, .address = (void *)${address} },`)
            .join("\n") +
          `\n};`,
      );
    }
    descriptors.push(
      `    {\n` +
        `        .abi_version = OLIPHAUNT_STATIC_EXTENSION_ABI_VERSION,\n` +
        `        .name = ${JSON.stringify(carrier.nativeModuleStem)},\n` +
        `        .magic = ${carrier.registration.magicSymbol},\n` +
        `        .init = ${carrier.registration.initSymbol ?? "NULL"},\n` +
        `        .symbols = ${carrier.registration.symbols.length > 0 ? array : "NULL"},\n` +
        `        .symbol_count = ${carrier.registration.symbols.length > 0 ? `sizeof(${array}) / sizeof(${array}[0])` : "0"},\n` +
        `        .reserved_flags = 0,\n` +
        `    },`,
    );
  }
  return `/* Generated by ${PREFIX}. Do not edit. */\n` +
    `#include <stddef.h>\n#include "oliphaunt.h"\n\n` +
    `${[...new Set(declarations)].sort(compareText).join("\n")}\n\n` +
    `${arrays.join("\n\n")}\n\n` +
    `static const OliphauntStaticExtension liboliphaunt_static_extensions[] = {\n` +
    `${descriptors.join("\n")}\n};\n\n` +
    `const OliphauntStaticExtension *liboliphaunt_selected_static_extensions(size_t *count) {\n` +
    `    if (count != NULL) *count = sizeof(liboliphaunt_static_extensions) / sizeof(liboliphaunt_static_extensions[0]);\n` +
    `    return liboliphaunt_static_extensions;\n}\n`;
}

async function treeSize(root) {
  if ((await statOrUndefined(root)) === undefined) return { bytes: 0, files: 0 };
  let bytes = 0;
  let files = 0;
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const name of await fs.readdir(current)) {
      const file = path.join(current, name);
      const stat = await fs.lstat(file);
      if (stat.isDirectory()) pending.push(file);
      else if (stat.isFile()) { bytes += stat.size; files += 1; }
      else fail(`generated payload contains unsupported entry: ${file}`);
    }
  }
  return { bytes, files };
}

function renderPayloadPodspec(version, hasNative, baseFrameworkName, legal) {
  const baseFramework = JSON.stringify(`frameworks/base/${baseFrameworkName}`);
  return `Pod::Spec.new do |s|\n` +
    `  s.name = "OliphauntReactNativePayload"\n` +
    `  s.version = ${JSON.stringify(version)}\n` +
    `  s.summary = "Generated app-owned Oliphaunt iOS runtime payload."\n` +
    `  s.license = { :type => ${JSON.stringify(legal.spdx)}, :file => ${JSON.stringify(legal.file)} }\n` +
    `  s.homepage = "https://oliphaunt.dev"\n` +
    `  s.authors = { "Oliphaunt" => "opensource@oliphaunt.dev" }\n` +
    `  s.source = { :git => "https://github.com/f0rr0/oliphaunt.git", :tag => "app-owned-payload" }\n` +
    `  s.platforms = { :ios => "17.0" }\n` +
    `  s.resources = "resources/OliphauntReactNativeResources.bundle"\n` +
    `  s.preserve_paths = "licenses/**/*"\n` +
    `  s.vendored_frameworks = ${baseFramework}, "frameworks/extensions/**/*.xcframework"\n` +
    (hasNative
      ? `  s.source_files = "generated/static-registry/*.c"\n  s.user_target_xcconfig = { "OTHER_LDFLAGS" => "$(inherited) -u _liboliphaunt_selected_static_extensions" }\n`
      : "") +
    `  s.dependency "COliphaunt"\n` +
    `end\n`;
}

async function stage(args, base, selected) {
  const selectionHash = createHash("sha256")
    .update(JSON.stringify({ base, icu: args.icu, selected }))
    .digest("hex");
  const outputParent = path.dirname(args.outputDir);
  const temporary = path.join(outputParent, `.${path.basename(args.outputDir)}.tmp-${process.pid}-${Date.now()}`);
  await fs.mkdir(outputParent, { recursive: true });
  await fs.rm(temporary, { force: true, recursive: true });
  try {
    const carrierMemberCache = new Map();
    const baseResources = await resolveAsset(base.assets.runtime, args.cacheDir);
    const baseManifest = await validateBaseResources(baseResources);
    const resourceRoot = path.join(
      temporary,
      "resources",
      "OliphauntReactNativeResources.bundle",
      "oliphaunt",
    );
    await copyTree(baseResources, resourceRoot);
    if (args.icu) {
      const icuData = await resolveAsset(base.assets.icu, args.cacheDir);
      await requirePayloadDirectory(icuData, "ICU data carrier member");
      await mergeTree(icuData, path.join(resourceRoot, "runtime", "files", "share", "icu"));
    }
    const baseFramework = await resolveAsset(base.assets.framework, args.cacheDir);
    const baseFrameworkName = path.posix.basename(base.assets.framework.member);
    if (
      !baseFrameworkName.endsWith(".xcframework") ||
      path.basename(baseFramework) !== baseFrameworkName
    ) {
      fail("base framework carrier member must resolve to its declared .xcframework directory");
    }
    await copyTree(baseFramework, path.join(temporary, "frameworks", "base", baseFrameworkName));

    const extensionRows = [];
    const nativeCarriers = selected.filter(({ nativeModuleStem }) => nativeModuleStem !== null);
    for (const carrier of selected) {
      const extensionResources = await extensionResourceRoot(
        carrier,
        base,
        args.cacheDir,
        carrierMemberCache,
      );
      if (extensionResources.share !== null) {
        await mergeTree(
          extensionResources.share,
          path.join(resourceRoot, "runtime", "files", "share", "postgresql"),
        );
      }
      extensionRows.push({
        ...(extensionResources.share === null
          ? { bytes: 0, files: 0 }
          : await treeSize(extensionResources.share)),
        sqlName: carrier.sqlName,
      });
      if (carrier.assets.extension) {
        const frameworkAssets = [
          { asset: carrier.assets.extension, expected: `liboliphaunt_extension_${carrier.nativeModuleStem}.xcframework` },
          ...carrier.assets.dependencyFrameworks.map(({ asset, dependency }) => ({
            asset,
            expected: `liboliphaunt_dependency_${dependency}.xcframework`,
          })),
        ];
        for (const { asset, expected } of frameworkAssets) {
          const source = await resolveLogicalAsset(asset, args.cacheDir, carrierMemberCache);
          if (path.basename(source) !== expected) {
            fail(`${carrier.sqlName} framework asset resolved to ${path.basename(source)}, expected ${expected}`);
          }
          await mergeTree(
            source,
            path.join(temporary, "frameworks", "extensions", expected),
          );
        }
      }
    }

    const legal = await stageSelectedLegalFiles({
      args,
      base,
      carrierMemberCache,
      selected,
      temporary,
    });

    const selectedExtensions = selected.map(({ sqlName }) => sqlName).sort(compareText);
    const createExtensions = selected.filter(({ createsExtension }) => createsExtension).map(({ sqlName }) => sqlName).sort(compareText);
    const nativeStems = nativeCarriers.map(({ nativeModuleStem }) => nativeModuleStem).sort(compareText);
    const nativeExtensions = nativeCarriers.map(({ sqlName }) => sqlName).sort(compareText);
    const nativeDependencies = [...new Set(nativeCarriers.flatMap(({ nativeDependencies }) => nativeDependencies))].sort(compareText);
    const sharedPreload = [...new Set(selected.flatMap(({ sharedPreloadLibraries }) => sharedPreloadLibraries))].sort(compareText);
    baseManifest.set("cacheKey", `react-native-ios-${selectionHash.slice(0, 32)}`);
    baseManifest.set("selectedExtensions", selectedExtensions.join(","));
    baseManifest.set("extensions", createExtensions.join(","));
    const runtimeFeatures = new Set(csv(baseManifest.get("runtimeFeatures"), "base runtime features"));
    if (args.icu) runtimeFeatures.add("icu");
    else runtimeFeatures.delete("icu");
    baseManifest.set("runtimeFeatures", [...runtimeFeatures].sort(compareText).join(","));
    baseManifest.set("sharedPreloadLibraries", sharedPreload.join(","));
    baseManifest.set("mobileStaticRegistryState", nativeStems.length > 0 ? "complete" : "not-required");
    baseManifest.set("mobileStaticRegistryRegistered", nativeExtensions.join(","));
    baseManifest.set("mobileStaticRegistryPending", "");
    baseManifest.set("nativeModuleStems", nativeStems.join(","));
    baseManifest.set("mobileStaticRegistrySource", nativeStems.length > 0 ? "oliphaunt_static_registry.c" : "");
    await fs.writeFile(path.join(resourceRoot, "runtime", "manifest.properties"), writeProperties(baseManifest));

    const registryRoot = path.join(resourceRoot, "static-registry");
    await fs.rm(registryRoot, { force: true, recursive: true });
    await fs.mkdir(registryRoot, { recursive: true });
    await fs.writeFile(
      path.join(registryRoot, "manifest.properties"),
      [
        "packageLayout=oliphaunt-static-registry-v1",
        "abiVersion=1",
        `state=${nativeStems.length > 0 ? "complete" : "not-required"}`,
        `source=${nativeStems.length > 0 ? "oliphaunt_static_registry.c" : ""}`,
        `registeredExtensions=${nativeExtensions.join(",")}`,
        "pendingExtensions=",
        `nativeModuleStems=${nativeStems.join(",")}`,
        `modules=${nativeStems.join(",")}`,
        `archiveTargets=${nativeStems.length > 0 ? "ios-device,ios-simulator" : ""}`,
        `dependencyArchiveTargets=${nativeDependencies.length > 0 ? "ios-device,ios-simulator" : ""}`,
        `dependencyArchives=${nativeDependencies.join(",")}`,
        "",
      ].join("\n"),
    );
    if (nativeCarriers.length > 0) {
      const generated = path.join(temporary, "generated", "static-registry");
      await fs.mkdir(generated, { recursive: true });
      await fs.writeFile(
        path.join(generated, "oliphaunt_static_registry.c"),
        renderRegistrySource(nativeCarriers),
      );
    }

    const runtimeSize = await treeSize(path.join(resourceRoot, "runtime"));
    const templateSize = await treeSize(path.join(resourceRoot, "template-pgdata"));
    const registrySize = await treeSize(registryRoot);
    const selectedBytes = extensionRows.reduce((total, row) => total + row.bytes, 0);
    const selectedFiles = extensionRows.reduce((total, row) => total + row.files, 0);
    const extensionNames = selectedExtensions.length > 0 ? selectedExtensions.join(",") : "-";
    await fs.writeFile(
      path.join(resourceRoot, "package-size.tsv"),
      [
        "kind\tid\textensions\tfiles\tbytes",
        `package\ttotal\t${extensionNames}\t${runtimeSize.files + templateSize.files + registrySize.files}\t${runtimeSize.bytes + templateSize.bytes + registrySize.bytes}`,
        `package\truntime\t${extensionNames}\t${runtimeSize.files}\t${runtimeSize.bytes}`,
        `package\ttemplate-pgdata\t-\t${templateSize.files}\t${templateSize.bytes}`,
        `package\tstatic-registry\t${extensionNames}\t${registrySize.files}\t${registrySize.bytes}`,
        `extensions\tselected\t${extensionNames}\t${selectedFiles}\t${selectedBytes}`,
        ...extensionRows.sort((left, right) => compareText(left.sqlName, right.sqlName))
          .map((row) => `extension\t${row.sqlName}\t-\t${row.files}\t${row.bytes}`),
        "",
      ].join("\n"),
    );

    const frozen = {
      base: { product: base.product, version: base.version, assets: base.assets },
      cacheKey: `react-native-ios-${selectionHash.slice(0, 32)}`,
      extensions: selected.map((carrier) => ({
        assets: carrier.assets,
        createsExtension: carrier.createsExtension,
        dependencies: carrier.dependencies,
        nativeDependencies: carrier.nativeDependencies,
        nativeModuleStem: carrier.nativeModuleStem,
        product: carrier.product,
        sqlName: carrier.sqlName,
        version: carrier.version,
      })),
      requestedExtensions: args.extensions,
      icu: args.icu,
      legal,
      schema: OUTPUT_SCHEMA,
    };
    await fs.writeFile(path.join(temporary, "selection.json"), `${JSON.stringify(frozen, null, 2)}\n`);
    await fs.writeFile(
      path.join(temporary, "OliphauntReactNativePayload.podspec"),
      renderPayloadPodspec(base.version, nativeCarriers.length > 0, baseFrameworkName, legal),
    );
    await fs.rm(args.outputDir, { force: true, recursive: true });
    await fs.rename(temporary, args.outputDir);
  } catch (error) {
    await fs.rm(temporary, { force: true, recursive: true });
    throw error;
  }
}

export async function stageIosApp(options) {
  const carriers = options.carriers ?? [
    ...(options.baseCarrier ? [options.baseCarrier] : []),
    ...(options.extensionCarriers ?? []),
  ];
  const args = {
    allowFileUrls: options.allowFileUrls === true,
    carriers: carriers.map((file) => path.resolve(file)),
    cacheDir: path.resolve(options.cacheDir ?? path.join(os.homedir(), ".cache", "oliphaunt", "react-native-ios")),
    extensions: uniquePortable(options.extensions ?? [], "selected extension"),
    icu: options.icu === true,
    outputDir: path.resolve(options.outputDir),
  };
  if (args.carriers.length === 0) fail("at least one carrier manifest is required");
  let base;
  const bySqlName = new Map();
  const carriersByName = new Map();
  const releasesByOwner = new Map();
  for (const file of args.carriers) {
    const document = await readCarrierDocument(file, args.allowFileUrls);
    if (base === undefined) {
      base = document.base;
    } else if (JSON.stringify(base) !== JSON.stringify(document.base)) {
      fail(`${file} pins a different base carrier than the other selected manifests`);
    }
    for (const [name, envelope] of document.carriers) {
      const existing = carriersByName.get(name);
      if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(envelope)) {
        fail(`carrier manifests disagree about envelope ${name}`);
      }
      carriersByName.set(name, envelope);
    }
    for (const carrier of document.extensions) {
      const release = { tag: carrier.tag, version: carrier.version };
      const existingRelease = releasesByOwner.get(carrier.product);
      if (
        existingRelease !== undefined &&
        JSON.stringify(existingRelease) !== JSON.stringify(release)
      ) {
        fail(`carrier manifests disagree about release version for owner ${carrier.product}`);
      }
      releasesByOwner.set(carrier.product, release);
      const existing = bySqlName.get(carrier.sqlName);
      if (existing && JSON.stringify(existing) !== JSON.stringify(carrier)) {
        fail(`carrier manifests disagree for exact extension ${carrier.sqlName}`);
      }
      bySqlName.set(carrier.sqlName, carrier);
    }
  }
  for (const carrier of bySqlName.values()) {
    if (carrier.runtimeBound && carrier.version !== base.version) {
      fail(
        `runtime-bound owner ${carrier.product} version ${carrier.version} ` +
          `must match base runtime ${base.version}`,
      );
    }
  }
  const selected = selectedClosure(args.extensions, bySqlName);
  await stage(args, base, selected);
  return { outputDir: args.outputDir, selected: selected.map(({ sqlName }) => sqlName) };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await stageIosApp(args);
  console.log(
    `${PREFIX}: staged ${result.outputDir} (extensions=${result.selected.join(",") || "none"})`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
