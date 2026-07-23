#!/usr/bin/env node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveSwiftCarrierSelection } from "./swift-carrier-resolver.mjs";
import {
  loadSwiftExtensionInventoryCatalog,
  readSafeFileSnapshot,
  snapshotSafeFileTree,
  validateSwiftExtensionResourceArtifact,
} from "./extension-resource-inventory.mjs";

const PREFIX = "render-extension-products.mjs";
const INPUT_SCHEMA = "oliphaunt-swiftpm-extension-input-v1";
const OUTPUT_SCHEMA = "oliphaunt-swiftpm-extension-products-v1";
const NATIVE_RUNTIME_PRODUCT = "liboliphaunt-native";
const OUTPUT_OWNER_MARKER = ".oliphaunt-swiftpm-extension-products";
const OUTPUT_OWNER_MARKER_CONTENT = `${PREFIX}\n${OUTPUT_SCHEMA}\n`;
const MAX_XCFRAMEWORK_FILES = 32768;
const MAX_XCFRAMEWORK_FILE_BYTES = 512 * 1024 * 1024;
const MAX_XCFRAMEWORK_TREE_BYTES = 2 * 1024 * 1024 * 1024;
const DEFAULT_CARRIER = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../Carriers/oliphaunt-react-native-ios-carriers.json",
);

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function fail(message) {
  throw new Error(`${PREFIX}: ${message}`);
}

function usage() {
  console.error(
    `usage: ${PREFIX} (--input <selection.json> | [--carrier <base-carrier.json>] ` +
      `[--extension-carrier <exact-extension-carrier.json> ...] --extensions <csv>) ` +
      `--output-dir <directory> [--cache-dir <directory>] [--offline] [--allow-file-urls] ` +
      `[--local-binary-targets] ` +
      `[--base-package-url <git-url>] [--base-package-version <semver>] ` +
      `[--base-package-path <local-oliphaunt-checkout>]`,
  );
}

function parseArgs(argv) {
  const args = { allowFileUrls: false, extensionCarriers: [], localBinaryTargets: false, offline: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    }
    if (arg === "--allow-file-urls" || arg === "--local-binary-targets" || arg === "--offline") {
      if (arg === "--allow-file-urls") args.allowFileUrls = true;
      else if (arg === "--local-binary-targets") args.localBinaryTargets = true;
      else args.offline = true;
      continue;
    }
    if (!["--input", "--carrier", "--extension-carrier", "--extensions", "--cache-dir", "--output-dir", "--base-package-path", "--base-package-url", "--base-package-version"].includes(arg)) {
      usage();
      fail(`unknown argument ${arg}`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      fail(`${arg} requires a value`);
    }
    index += 1;
    if (arg === "--input") args.input = value;
    if (arg === "--carrier") args.carrier = value;
    if (arg === "--extension-carrier") args.extensionCarriers.push(value);
    if (arg === "--extensions") args.extensions = value.split(",").map((row) => row.trim()).filter(Boolean);
    if (arg === "--cache-dir") args.cacheDir = path.resolve(value);
    if (arg === "--output-dir") args.outputDir = value;
    if (arg === "--base-package-path") args.basePackagePath = path.resolve(value);
    if (arg === "--base-package-url") args.basePackageUrl = value;
    if (arg === "--base-package-version") args.basePackageVersion = value;
  }
  if (!args.outputDir || (args.input && (args.carrier || args.extensionCarriers.length > 0 || args.extensions?.length)) || (!args.input && !args.extensions?.length)) {
    usage();
    fail("choose --input, or --extensions with optional base/extension carriers, and provide --output-dir");
  }
  if (!args.input && !args.carrier) args.carrier = DEFAULT_CARRIER;
  return args;
}

function object(value, label) {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    fail(`${label} must be an object`);
  }
  return value;
}

function exactKeys(value, allowed, label) {
  const extras = Object.keys(value).filter((key) => !allowed.includes(key)).sort();
  if (extras.length > 0) {
    fail(`${label} contains unsupported field(s): ${extras.join(", ")}`);
  }
}

function portable(value, label) {
  if (typeof value !== "string" || !/^[A-Za-z0-9._-]+$/u.test(value)) {
    fail(`${label} must contain only ASCII letters, digits, '.', '_' or '-'`);
  }
  return value;
}

function cIdentifier(value, label) {
  if (typeof value !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(value)) {
    fail(`${label} must be a C identifier`);
  }
  return value;
}

function uniquePortableList(value, label) {
  if (!Array.isArray(value)) {
    fail(`${label} must be an array`);
  }
  const items = value.map((item, index) => portable(item, `${label}[${index}]`));
  if (new Set(items).size !== items.length) {
    fail(`${label} must not contain duplicates`);
  }
  const canonical = [...items].sort(compareText);
  if (JSON.stringify(items) !== JSON.stringify(canonical)) {
    fail(`${label} must be sorted in ordinal order`);
  }
  return items;
}

function frozenDataFiles(value, label) {
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  const rows = value.map((item, index) => {
    if (
      typeof item !== "string" || item.length === 0 || item.includes("\\") || item.startsWith("/")
      || /^[A-Za-z]:/u.test(item) || item.split("/").some((part) => !part || part === "." || part === "..")
    ) {
      fail(`${label}[${index}] must be a safe canonical relative file path`);
    }
    return item;
  });
  const canonical = [...rows].sort(compareText);
  if (new Set(rows).size !== rows.length) fail(`${label} must not contain duplicates`);
  if (JSON.stringify(rows) !== JSON.stringify(canonical)) fail(`${label} must be sorted in ordinal order`);
  return rows;
}

function frozenSqlFileNames(value, label) {
  const rows = uniquePortableList(value, label);
  if (rows.some((name) => !name.endsWith(".sql"))) fail(`${label} must contain SQL basenames`);
  return rows;
}

function frozenSqlFilePrefixes(value, label) {
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  const rows = value.map((item, index) => {
    if (typeof item !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(item)) {
      fail(`${label}[${index}] must be a dot-free portable SQL basename prefix`);
    }
    return item;
  });
  const canonical = [...rows].sort(compareText);
  if (new Set(rows).size !== rows.length) fail(`${label} must not contain duplicates`);
  if (JSON.stringify(rows) !== JSON.stringify(canonical)) fail(`${label} must be sorted in ordinal order`);
  return rows;
}

function nullablePortable(value, label) {
  if (value === null) {
    return null;
  }
  return portable(value, label);
}

function localResourceRoot(value, label) {
  if (typeof value !== "string" || value.trim().length === 0 || value.includes("\0")) {
    fail(`${label} must be a non-empty local directory path`);
  }
  return value;
}

function semanticVersion(value, label) {
  if (
    typeof value !== "string" ||
    !/^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u.test(value)
  ) {
    fail(`${label} must be a semantic version accepted by SwiftPM`);
  }
  return value;
}

function stableSemanticVersion(value, label) {
  if (
    typeof value !== "string" ||
    !/^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u.test(value)
  ) {
    fail(`${label} must be a stable semantic version in X.Y.Z form`);
  }
  return value;
}

function validateBasePackage(value) {
  const base = object(value, "basePackage");
  exactKeys(base, ["name", "url", "version"], "basePackage");
  if (base.name !== "Oliphaunt") {
    fail("basePackage.name must be Oliphaunt");
  }
  if (typeof base.url !== "string") {
    fail("basePackage.url must be an HTTPS Git URL");
  }
  let url;
  try {
    url = new URL(base.url);
  } catch {
    fail("basePackage.url must be a valid HTTPS Git URL");
  }
  if (url.protocol !== "https:" || !url.pathname.endsWith(".git")) {
    fail("basePackage.url must be an HTTPS Git URL ending in .git");
  }
  return {
    name: base.name,
    url: base.url,
    version: semanticVersion(base.version, "basePackage.version"),
  };
}

function validateNativeRuntime(value) {
  const runtime = object(value, "nativeRuntime");
  exactKeys(runtime, ["product", "version"], "nativeRuntime");
  if (runtime.product !== NATIVE_RUNTIME_PRODUCT) {
    fail(`nativeRuntime.product must be ${NATIVE_RUNTIME_PRODUCT}`);
  }
  return {
    product: runtime.product,
    version: stableSemanticVersion(runtime.version, "nativeRuntime.version"),
  };
}

function swiftSuffix(sqlName) {
  const words = sqlName.split(/[^A-Za-z0-9]+/u).filter(Boolean);
  if (words.length === 0) {
    fail(`cannot derive a Swift product name from ${sqlName}`);
  }
  const suffix = words
    .map((word) => `${word[0].toUpperCase()}${word.slice(1)}`)
    .join("");
  if (!/^[A-Za-z][A-Za-z0-9]*$/u.test(suffix)) {
    fail(`cannot derive a Swift identifier from ${sqlName}`);
  }
  return suffix;
}

function swiftString(value) {
  return JSON.stringify(value);
}

function expectedSymbolPrefix(stem) {
  return `oliphaunt_static_${stem.replaceAll(/[^A-Za-z0-9_]/gu, "_")}`;
}

function validateAsset(value, label, allowFileUrls = false, localBinaryTargets = false) {
  const asset = object(value, label);
  exactKeys(asset, ["checksum", "localPath", "name", "url"], label);
  if (
    typeof asset.name !== "string"
    || asset.name.length === 0
    || path.posix.basename(asset.name) !== asset.name
    || /[<>:"/\\|?*\u0000-\u001f\u007f]/u.test(asset.name)
    || /[ .]$/u.test(asset.name)
    || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(asset.name)
  ) {
    fail(`${label}.name must be a plain release asset file name`);
  }
  if (typeof asset.url !== "string") {
    fail(`${label}.url must be an HTTPS URL`);
  }
  let url;
  try {
    url = new URL(asset.url);
  } catch {
    fail(`${label}.url must be a valid HTTPS URL`);
  }
  if (
    (url.protocol !== "https:" && !(allowFileUrls && url.protocol === "file:")) ||
    decodeURIComponent(path.basename(url.pathname)) !== asset.name
  ) {
    fail(`${label}.url must be HTTPS${allowFileUrls ? " or an explicitly enabled file URL" : ""} and end with ${asset.name}`);
  }
  if (typeof asset.checksum !== "string" || !/^[a-f0-9]{64}$/u.test(asset.checksum)) {
    fail(`${label}.checksum must be a lowercase SHA-256 digest`);
  }
  let localPath;
  if (localBinaryTargets || asset.localPath !== undefined) {
    if (
      typeof asset.localPath !== "string" ||
      !path.isAbsolute(asset.localPath) ||
      path.extname(asset.localPath) !== ".xcframework"
    ) {
      fail(`${label}.localPath must be an absolute XCFramework directory path`);
    }
    localPath = path.normalize(asset.localPath);
  }
  return {
    checksum: asset.checksum,
    name: asset.name,
    url: asset.url,
    ...(localPath === undefined ? {} : { localPath }),
  };
}

function validateRegistration(value, stem, label) {
  const registration = object(value, label);
  exactKeys(registration, ["hasInit", "symbols"], label);
  if (typeof registration.hasInit !== "boolean") {
    fail(`${label}.hasInit must be a boolean`);
  }
  if (!Array.isArray(registration.symbols)) {
    fail(`${label}.symbols must be an array derived from the built extension archive`);
  }
  const symbols = registration.symbols.map((raw, index) => {
    const symbol = object(raw, `${label}.symbols[${index}]`);
    exactKeys(symbol, ["address", "name"], `${label}.symbols[${index}]`);
    return {
      address: cIdentifier(symbol.address, `${label}.symbols[${index}].address`),
      name: cIdentifier(symbol.name, `${label}.symbols[${index}].name`),
    };
  });
  const names = symbols.map(({ name }) => name);
  if (new Set(names).size !== names.length) {
    fail(`${label}.symbols repeats a SQL-visible symbol name`);
  }
  symbols.sort((left, right) =>
    compareText(`${left.name}\0${left.address}`, `${right.name}\0${right.address}`),
  );
  const symbolPrefix = expectedSymbolPrefix(stem);
  return {
    hasInit: registration.hasInit,
    initSymbol: registration.hasInit ? `${symbolPrefix}__PG_init` : undefined,
    magicSymbol: `${symbolPrefix}_Pg_magic_func`,
    symbolPrefix,
    symbols,
  };
}

function validateNativeDependencies(
  value,
  label,
  allowFileUrls = false,
  localBinaryTargets = false,
) {
  if (!Array.isArray(value)) {
    fail(`${label} must be an array of separately checksum-pinned XCFramework assets`);
  }
  const dependencies = value.map((raw, index) => {
    const dependency = object(raw, `${label}[${index}]`);
    exactKeys(dependency, ["asset", "name"], `${label}[${index}]`);
    const name = portable(dependency.name, `${label}[${index}].name`);
    return {
      asset: validateAsset(
        dependency.asset,
        `${label}[${index}].asset`,
        allowFileUrls,
        localBinaryTargets,
      ),
      binaryTarget: `OliphauntNativeDependency${swiftSuffix(name)}`,
      name,
    };
  });
  dependencies.sort((left, right) => compareText(left.name, right.name));
  if (new Set(dependencies.map(({ name }) => name)).size !== dependencies.length) {
    fail(`${label} repeats a native dependency name`);
  }
  return dependencies;
}

function validateSelection(
  input,
  inputDirectory,
  { allowFileUrls = false, localBinaryTargets = false } = {},
) {
  const root = object(input, "input");
  exactKeys(root, ["basePackage", "extensions", "nativeRuntime", "schema"], "input");
  if (root.schema !== INPUT_SCHEMA) {
    fail(`input schema must be ${INPUT_SCHEMA}`);
  }
  if (!Array.isArray(root.extensions) || root.extensions.length === 0) {
    fail("input extensions must be a non-empty selected extension array");
  }
  const basePackage = validateBasePackage(root.basePackage);
  const nativeRuntime = validateNativeRuntime(root.nativeRuntime);
  const extensions = root.extensions.map((raw, index) => {
    const row = object(raw, `extensions[${index}]`);
    exactKeys(
      row,
      [
        "asset",
        "createsExtension",
        "dataFiles",
        "dependencies",
        "extensionSqlFileNames",
        "extensionSqlFilePrefixes",
        "nativeModuleStem",
        "nativeDependencies",
        "product",
        "registration",
        "resourceRoot",
        "sharedPreloadLibraries",
        "sqlName",
        "version",
      ],
      `extensions[${index}]`,
    );
    const sqlName = portable(row.sqlName, `extensions[${index}].sqlName`);
    const product = portable(row.product, `extensions[${index}].product`);
    if (!product.startsWith("oliphaunt-extension-")) {
      fail(`extensions[${index}].product must be an exact-extension release owner; got ${product}`);
    }
    const nativeModuleStem = nullablePortable(
      row.nativeModuleStem,
      `extensions[${index}].nativeModuleStem`,
    );
    if (typeof row.createsExtension !== "boolean") {
      fail(`extensions[${index}].createsExtension must be boolean`);
    }
    const cModuleStem = nativeModuleStem?.replaceAll(/[^A-Za-z0-9_]/gu, "_");
    const suffix = swiftSuffix(sqlName);
    if (nativeModuleStem === null && row.registration !== null) {
      fail(`extensions[${index}] SQL-only extension must use null registration metadata`);
    }
    const asset = row.asset === null
      ? null
      : validateAsset(
          row.asset,
          `extensions[${index}].asset`,
          allowFileUrls,
          localBinaryTargets,
        );
    const registration =
      row.registration === null
        ? null
        : validateRegistration(
            row.registration,
            nativeModuleStem,
            `extensions[${index}].registration`,
          );
    const nativeDependencies = validateNativeDependencies(
      row.nativeDependencies,
      `extensions[${index}].nativeDependencies`,
      allowFileUrls,
      localBinaryTargets,
    );
    if (nativeModuleStem === null) {
      if (asset !== null || registration !== null || nativeDependencies.length > 0) {
        fail(
          `extensions[${index}] is SQL-only and must use null asset/registration with no nativeDependencies`,
        );
      }
    } else if (asset === null || registration === null) {
      fail(`extensions[${index}] native extension requires asset and registration metadata`);
    }
    const dependencies = uniquePortableList(
      row.dependencies,
      `extensions[${index}].dependencies`,
    );
    if (dependencies.includes(sqlName)) {
      fail(`extensions[${index}].dependencies must not include ${sqlName} itself`);
    }
    return {
      asset,
      binaryTarget: nativeModuleStem === null ? null : `OliphauntExtension${suffix}Binary`,
      cFunction: nativeModuleStem === null ? null : `oliphaunt_extension_${cModuleStem}_descriptor`,
      cTarget: nativeModuleStem === null ? null : `COliphauntExtension${suffix}`,
      createsExtension: row.createsExtension,
      dataFiles: frozenDataFiles(row.dataFiles, `extensions[${index}].dataFiles`),
      dependencies,
      extensionSqlFileNames: frozenSqlFileNames(
        row.extensionSqlFileNames,
        `extensions[${index}].extensionSqlFileNames`,
      ),
      extensionSqlFilePrefixes: frozenSqlFilePrefixes(
        row.extensionSqlFilePrefixes,
        `extensions[${index}].extensionSqlFilePrefixes`,
      ),
      nativeDependencies,
      nativeModuleStem,
      product,
      registration,
      resourceRoot: path.resolve(
        inputDirectory,
        localResourceRoot(row.resourceRoot, `extensions[${index}].resourceRoot`),
      ),
      sharedPreloadLibraries: uniquePortableList(
        row.sharedPreloadLibraries,
        `extensions[${index}].sharedPreloadLibraries`,
      ),
      sqlName,
      swiftTarget: `OliphauntExtension${suffix}`,
      version: stableSemanticVersion(row.version, `extensions[${index}].version`),
    };
  });
  extensions.sort((left, right) => compareText(left.sqlName, right.sqlName));
  const bySqlName = new Map();
  const targetNames = new Set();
  const nativeDependencies = new Map();
  for (const extension of extensions) {
    if (bySqlName.has(extension.sqlName)) {
      fail(`selected extension ${extension.sqlName} is duplicated`);
    }
    bySqlName.set(extension.sqlName, extension);
    for (const name of [extension.binaryTarget, extension.cTarget, extension.swiftTarget].filter(Boolean)) {
      if (targetNames.has(name)) {
        fail(`generated SwiftPM target name collision: ${name}`);
      }
      targetNames.add(name);
    }
    for (const dependency of extension.nativeDependencies) {
      const existing = nativeDependencies.get(dependency.name);
      if (existing !== undefined) {
        if (JSON.stringify(existing.asset) !== JSON.stringify(dependency.asset)) {
          fail(
            `selected extensions require conflicting ${dependency.name} native dependency assets`,
          );
        }
      } else {
        nativeDependencies.set(dependency.name, dependency);
      }
    }
  }
  for (const dependency of nativeDependencies.values()) {
    if (targetNames.has(dependency.binaryTarget)) {
      fail(`generated SwiftPM target name collision: ${dependency.binaryTarget}`);
    }
    targetNames.add(dependency.binaryTarget);
  }
  for (const extension of extensions) {
    for (const dependency of extension.dependencies) {
      if (!bySqlName.has(dependency)) {
        fail(`${extension.sqlName} dependency ${dependency} is not present in the selected input`);
      }
    }
  }
  const visiting = new Set();
  const visited = new Set();
  function visit(sqlName) {
    if (visiting.has(sqlName)) fail(`selected extension dependency cycle includes ${sqlName}`);
    if (visited.has(sqlName)) return;
    visiting.add(sqlName);
    for (const dependency of bySqlName.get(sqlName).dependencies) visit(dependency);
    visiting.delete(sqlName);
    visited.add(sqlName);
  }
  for (const extension of extensions) visit(extension.sqlName);
  return {
    basePackage,
    bySqlName,
    extensions,
    nativeRuntime,
    nativeDependencies: [...nativeDependencies.values()].sort((left, right) =>
      compareText(left.name, right.name),
    ),
  };
}

function snapshotRows(files, { includeIdentity = false, mode = undefined } = {}) {
  return files.map((file) => ({
    bytes: file.bytes,
    ...(includeIdentity ? { device: file.device, inode: file.inode } : {}),
    mode: mode ?? file.mode,
    relative: file.relative,
    sha256: file.sha256,
  }));
}

function snapshotDirectoryRows(
  directories,
  { includeIdentity = false } = {},
) {
  return directories.map((directory) => ({
    ...(includeIdentity
      ? { device: directory.device, inode: directory.inode }
      : {}),
    mode: directory.mode,
    relative: directory.relative,
  }));
}

function assertSnapshotRowsEqual(expected, actual, label, options = {}) {
  const filesChanged = (
    JSON.stringify(snapshotRows(expected, options))
    !== JSON.stringify(snapshotRows(actual, { includeIdentity: options.includeIdentity }))
  );
  const directoriesChanged = options.includeDirectories === true && (
    JSON.stringify(snapshotDirectoryRows(
      options.expectedDirectories ?? expected.directories ?? [],
      options,
    ))
    !== JSON.stringify(snapshotDirectoryRows(actual.directories ?? [], options))
  );
  if (filesChanged || directoriesChanged) {
    fail(`${label} tree inventory changed`);
  }
}

function safeSnapshotRelativePath(value, label) {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.includes("\\")
    || value.startsWith("/")
    || /^[A-Za-z]:/u.test(value)
    || value.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    fail(`${label} contains unsafe snapshot path ${JSON.stringify(value)}`);
  }
  return value;
}

export async function materializeFileSnapshots(
  files,
  destinationRoot,
  label,
  { mode = undefined } = {},
) {
  if (!Array.isArray(files)) {
    fail(`${label} must be an array of validated file snapshots`);
  }
  if ((await lstatIfPresent(destinationRoot)) !== null) {
    fail(`${label} destination already exists: ${destinationRoot}`);
  }
  await fs.mkdir(destinationRoot, { recursive: true, mode: 0o755 });
  const preserveDirectories = Object.hasOwn(files, "directories");
  const directories = preserveDirectories ? files.directories : [];
  for (const directory of [...directories].sort((left, right) => {
    const depth = left.relative.split("/").length - right.relative.split("/").length;
    return depth === 0 ? compareText(left.relative, right.relative) : depth;
  })) {
    const relative = safeSnapshotRelativePath(directory.relative, label);
    const destination = path.join(destinationRoot, ...relative.split("/"));
    await fs.mkdir(destination, { recursive: true, mode: directory.mode });
    await fs.chmod(destination, directory.mode);
  }
  for (const file of files) {
    const relative = safeSnapshotRelativePath(file.relative, label);
    const destination = path.join(destinationRoot, ...relative.split("/"));
    await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o755 });
    const contents = await readSafeFileSnapshot(file, `${label} source ${relative}`);
    const fileMode = mode ?? file.mode;
    await fs.writeFile(destination, contents, { flag: "wx", mode: fileMode });
    await fs.chmod(destination, fileMode);
  }
  const expectedBytes = files.reduce((sum, file) => sum + file.bytes, 0);
  const staged = await snapshotSafeFileTree(destinationRoot, `${label} staged copy`, {
    maxFiles: Math.max(files.length, 1),
    maxFileBytes: Math.max(...files.map(({ bytes }) => bytes), 1),
    maxTreeBytes: Math.max(expectedBytes, 1),
  });
  assertSnapshotRowsEqual(files, staged, `${label} staged copy`, {
    expectedDirectories: directories,
    includeDirectories: preserveDirectories,
    mode,
  });
}

async function copyResourceArtifact(extension, swiftRoot) {
  const resourceTarget = path.join(swiftRoot, "Resources", "extension-artifact");
  const shareTarget = path.join(resourceTarget, "files", "share", "postgresql");
  await materializeFileSnapshots(
    extension.resources.files,
    shareTarget,
    `${extension.sqlName} Swift resource artifact`,
    { mode: 0o644 },
  );
  const manifest = [
    "schema=oliphaunt-swift-extension-resource-v1",
    `product=${extension.product}`,
    `version=${extension.version}`,
    `sqlName=${extension.sqlName}`,
    `createsExtension=${extension.resources.createsExtension ? "yes" : "no"}`,
    `dependencies=${extension.dependencies.join(",")}`,
    `nativeModuleStem=${extension.nativeModuleStem ?? ""}`,
    `nativeDependencies=${extension.nativeDependencies.map(({ name }) => name).join(",")}`,
    `sharedPreloadLibraries=${extension.sharedPreloadLibraries.join(",")}`,
    "files=files",
    "",
  ].join("\n");
  await fs.writeFile(path.join(resourceTarget, "manifest.properties"), manifest);
}

function renderHeader(extension) {
  const guard = `${extension.cTarget.replaceAll(/[^A-Za-z0-9]/gu, "_").toUpperCase()}_H`;
  return `#ifndef ${guard}\n#define ${guard}\n\n#include "COliphaunt.h"\n\n` +
    `const OliphauntStaticExtension *${extension.cFunction}(void);\n\n#endif\n`;
}

function renderC(extension) {
  const registration = extension.registration;
  const externs = new Set([
    `extern const void *${registration.magicSymbol}(void);`,
    ...(registration.initSymbol ? [`extern void ${registration.initSymbol}(void);`] : []),
    ...registration.symbols.map(({ address }) => `extern void ${address}(void);`),
  ]);
  const symbols = registration.symbols.length
    ? `static const OliphauntStaticExtensionSymbol extension_symbols[] = {\n${registration.symbols
        .map(
          ({ name, address }) =>
            `    { .name = ${JSON.stringify(name)}, .address = (void *)${address} },`,
        )
        .join("\n")}\n};\n\n`
    : "";
  const symbolPointer = registration.symbols.length ? "extension_symbols" : "NULL";
  const symbolCount = registration.symbols.length
    ? "sizeof(extension_symbols) / sizeof(extension_symbols[0])"
    : "0";
  return `/* Generated by ${PREFIX}. Do not edit. */\n` +
    `#include "${extension.cTarget}.h"\n\n${[...externs].sort().join("\n")}\n\n${symbols}` +
    `static const OliphauntStaticExtension extension_descriptor = {\n` +
    `    .abi_version = OLIPHAUNT_STATIC_EXTENSION_ABI_VERSION,\n` +
    `    .name = ${JSON.stringify(extension.nativeModuleStem)},\n` +
    `    .magic = ${registration.magicSymbol},\n` +
    `    .init = ${registration.initSymbol ?? "NULL"},\n` +
    `    .symbols = ${symbolPointer},\n` +
    `    .symbol_count = ${symbolCount},\n` +
    `    .reserved_flags = 0,\n};\n\n` +
    `const OliphauntStaticExtension *${extension.cFunction}(void) {\n` +
    `    return &extension_descriptor;\n}\n`;
}

function renderSwift(extension, bySqlName) {
  const dependencyImports = extension.dependencies
    .map((dependency) => `import ${bySqlName.get(dependency).swiftTarget}`)
    .join("\n");
  const dependencyRegistrations = extension.dependencies
    .map((dependency) => `        try ${bySqlName.get(dependency).swiftTarget}.register()`)
    .join("\n");
  const cImport = extension.cTarget ? `import ${extension.cTarget}\nimport COliphaunt\n` : "";
  const descriptor = extension.cFunction
    ? `        guard let descriptor = ${extension.cFunction}() else {\n` +
      `            throw OliphauntError.engine("${extension.sqlName} static-extension descriptor is unavailable")\n` +
      `        }\n`
    : "";
  return `${cImport}import Foundation\nimport Oliphaunt\nimport OliphauntExtensionSupport` +
    `${dependencyImports ? `\n${dependencyImports}` : ""}\n\n` +
    `public enum ${extension.swiftTarget} {\n` +
    `    public static let product = ${swiftString(extension.product)}\n` +
    `    public static let sqlName = ${swiftString(extension.sqlName)}\n` +
    `    public static let version = ${swiftString(extension.version)}\n` +
    `    public static let dependencies: [String] = [${extension.dependencies.map(swiftString).join(", ")}]\n\n` +
    `    public static let nativeDependencies: [String] = [${extension.nativeDependencies.map(({ name }) => swiftString(name)).join(", ")}]\n\n` +
    `    public static let sharedPreloadLibraries: [String] = [${extension.sharedPreloadLibraries.map(swiftString).join(", ")}]\n\n` +
    `    public static func register() throws {\n` +
    `${dependencyRegistrations ? `${dependencyRegistrations}\n` : ""}` +
    `        guard let resourceRoot = Bundle.module.url(forResource: "extension-artifact", withExtension: nil) else {\n` +
    `            throw OliphauntError.engine("${extension.sqlName} SwiftPM resource fragment is unavailable")\n` +
    `        }\n` +
    descriptor +
    `        try OliphauntExtensionSupport.register(\n` +
    `            product: product,\n` +
    `            sqlName: sqlName,\n` +
    `            version: version,\n` +
    `            dependencies: dependencies,\n` +
    `            nativeDependencies: nativeDependencies,\n` +
    `            sharedPreloadLibraries: sharedPreloadLibraries,\n` +
    `            nativeModuleStem: ${extension.nativeModuleStem === null ? "nil" : swiftString(extension.nativeModuleStem)},\n` +
    `            resourceRoot: resourceRoot,\n` +
    `            descriptor: ${extension.cFunction ? "descriptor" : "nil"}\n` +
    `        )\n` +
    `    }\n}\n`;
}

function baseProduct(name) {
  return { package: "oliphaunt", product: name };
}

function binaryTargetIR(name, asset, localBinaryTargets) {
  return localBinaryTargets || asset.localPath !== undefined
    ? {
        kind: "binaryTarget",
        name,
        path: `Artifacts/${name}.xcframework`,
      }
    : {
        checksum: asset.checksum,
        kind: "binaryTarget",
        name,
        url: asset.url,
      };
}

function targetIR(extension, bySqlName, localBinaryTargets) {
  const swiftPath = `Sources/${extension.swiftTarget}`;
  const targets = [];
  if (extension.nativeModuleStem !== null) {
    const nativeDependencyNames = new Set(
      extension.nativeDependencies.map(({ name }) => name),
    );
    const linkedLibraries = ["geos", "geos-c", "proj"].some((name) => nativeDependencyNames.has(name))
      ? ["c++"]
      : [];
    targets.push(
      binaryTargetIR(extension.binaryTarget, extension.asset, localBinaryTargets),
      {
        dependencies: [
          baseProduct("COliphaunt"),
          extension.binaryTarget,
          ...extension.nativeDependencies.map(({ binaryTarget }) => binaryTarget),
        ],
        kind: "target",
        linkedLibraries,
        name: extension.cTarget,
        path: `Sources/${extension.cTarget}`,
        publicHeadersPath: "include",
      },
    );
  }
  targets.push({
    dependencies: [
      ...(extension.cTarget ? [baseProduct("COliphaunt")] : []),
      baseProduct("Oliphaunt"),
      baseProduct("OliphauntExtensionSupport"),
      ...(extension.cTarget ? [extension.cTarget] : []),
      ...extension.dependencies.map((dependency) => bySqlName.get(dependency).swiftTarget),
    ],
    kind: "target",
    name: extension.swiftTarget,
    path: swiftPath,
    resources: [{ path: "Resources/extension-artifact", rule: "copy" }],
  });
  return targets;
}

function renderTargetDependency(dependency) {
  if (typeof dependency === "string") {
    return swiftString(dependency);
  }
  return `.product(name: ${swiftString(dependency.product)}, package: ${swiftString(dependency.package)})`;
}

function renderPackage(manifest, basePackagePath) {
  const products = manifest.products
    .map(
      (product) =>
        `    .library(name: ${swiftString(product.name)}, targets: [${product.targets
          .map(swiftString)
          .join(", ")}])`,
    )
    .join(",\n");
  const targets = manifest.targets
    .map((target) => {
      if (target.kind === "binaryTarget") {
        if (target.path !== undefined) {
          return `    .binaryTarget(\n        name: ${swiftString(target.name)},\n        path: ${swiftString(target.path)}\n    )`;
        }
        return `    .binaryTarget(\n        name: ${swiftString(target.name)},\n        url: ${swiftString(target.url)},\n        checksum: ${swiftString(target.checksum)}\n    )`;
      }
      const headers = target.publicHeadersPath
        ? `,\n        publicHeadersPath: ${swiftString(target.publicHeadersPath)}`
        : "";
      const resources = target.resources
        ? `,\n        resources: [${target.resources
            .map((resource) => `.${resource.rule}(${swiftString(resource.path)})`)
            .join(", ")}]`
        : "";
      const linkerSettings = target.linkedLibraries?.length
        ? `,\n        linkerSettings: [${target.linkedLibraries
            .map((library) => `.linkedLibrary(${swiftString(library)})`)
            .join(", ")}]`
        : "";
      return `    .target(\n        name: ${swiftString(target.name)},\n        dependencies: [${target.dependencies
        .map(renderTargetDependency)
        .join(", ")}],\n        path: ${swiftString(target.path)}${headers}${resources}${linkerSettings}\n    )`;
    })
    .join(",\n");
  const baseDependency = basePackagePath
    ? `.package(name: "oliphaunt", path: ${swiftString(basePackagePath)})`
    : `.package(\n            url: ${swiftString(manifest.basePackage.url)},\n            exact: ${swiftString(manifest.basePackage.version)}\n        )`;
  return `// swift-tools-version: 6.0\n\n` +
    `import PackageDescription\n\n` +
    `// Generated by ${PREFIX}. Do not edit. This local package belongs to the\n` +
    `// consuming application; exact-extension assets remain separately released.\n` +
    `let package = Package(\n` +
    `    name: "OliphauntSelectedExtensions",\n` +
    `    platforms: [.iOS(.v17), .macOS(.v14)],\n` +
    `    products: [\n${products}\n    ],\n` +
    `    dependencies: [\n        ${baseDependency}\n    ],\n` +
    `    targets: [\n${targets}\n    ]\n` +
    `)\n`;
}

async function copyLocalBinaryArtifact(asset, targetName, outputDir) {
  const source = asset.localPath;
  const sourceStat = await fs.lstat(source).catch(() => null);
  if (sourceStat?.isDirectory() !== true || sourceStat.isSymbolicLink()) {
    fail(`local binary target ${targetName} is not a real XCFramework directory: ${source}`);
  }
  const label = `local binary target ${targetName}`;
  const sourceFiles = await snapshotSafeFileTree(source, label, {
    maxFiles: MAX_XCFRAMEWORK_FILES,
    maxFileBytes: MAX_XCFRAMEWORK_FILE_BYTES,
    maxTreeBytes: MAX_XCFRAMEWORK_TREE_BYTES,
  });
  if (!sourceFiles.some(({ relative }) => relative === "Info.plist")) {
    fail(`${label} is missing Info.plist: ${source}`);
  }
  const destination = path.join(outputDir, "Artifacts", `${targetName}.xcframework`);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await materializeFileSnapshots(sourceFiles, destination, label);
  const sourceAfterCopy = await snapshotSafeFileTree(source, `${label} post-copy source`, {
    maxFiles: MAX_XCFRAMEWORK_FILES,
    maxFileBytes: MAX_XCFRAMEWORK_FILE_BYTES,
    maxTreeBytes: MAX_XCFRAMEWORK_TREE_BYTES,
  });
  assertSnapshotRowsEqual(sourceFiles, sourceAfterCopy, `${label} source`, {
    includeDirectories: true,
    includeIdentity: true,
  });
}

async function writeGeneratedTree(selection, outputDir, basePackagePath, localBinaryTargets) {
  const products = [];
  const targets = [];
  const selected = [];
  for (const dependency of selection.nativeDependencies) {
    if (localBinaryTargets || dependency.asset.localPath !== undefined) {
      await copyLocalBinaryArtifact(dependency.asset, dependency.binaryTarget, outputDir);
    }
    targets.push(binaryTargetIR(dependency.binaryTarget, dependency.asset, localBinaryTargets));
  }
  for (const extension of selection.extensions) {
    const swiftRoot = path.join(outputDir, "Sources", extension.swiftTarget);
    if (extension.cTarget) {
      if (localBinaryTargets || extension.asset.localPath !== undefined) {
        await copyLocalBinaryArtifact(extension.asset, extension.binaryTarget, outputDir);
      }
      const cRoot = path.join(outputDir, "Sources", extension.cTarget);
      await fs.mkdir(path.join(cRoot, "include"), { recursive: true });
      await fs.writeFile(
        path.join(cRoot, "include", `${extension.cTarget}.h`),
        renderHeader(extension),
      );
      await fs.writeFile(path.join(cRoot, "registration.c"), renderC(extension));
    }
    await fs.mkdir(swiftRoot, { recursive: true });
    await copyResourceArtifact(extension, swiftRoot);
    await fs.writeFile(
      path.join(swiftRoot, `${extension.swiftTarget}.swift`),
      renderSwift(extension, selection.bySqlName),
    );
    products.push({ name: extension.swiftTarget, targets: [extension.swiftTarget], type: "library" });
    targets.push(...targetIR(extension, selection.bySqlName, localBinaryTargets));
    selected.push({
      asset: extension.asset,
      createsExtension: extension.resources.createsExtension,
      dependencies: extension.dependencies,
      nativeDependencies: extension.nativeDependencies,
      nativeModuleStem: extension.nativeModuleStem,
      product: extension.product,
      registration: extension.registration,
      resourceBytes: extension.resources.bytes,
      resourceFiles: extension.resources.files.length,
      sharedPreloadLibraries: extension.sharedPreloadLibraries,
      sqlName: extension.sqlName,
      swiftProduct: extension.swiftTarget,
      version: extension.version,
    });
  }
  const manifest = {
    basePackage: selection.basePackage,
    consumerOwned: true,
    nativeRuntime: selection.nativeRuntime,
    products,
    requiredBaseProducts: ["COliphaunt", "Oliphaunt", "OliphauntExtensionSupport"],
    schema: OUTPUT_SCHEMA,
    selected,
    targets,
  };
  await fs.writeFile(
    path.join(outputDir, "extension-products.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  await fs.writeFile(path.join(outputDir, "Package.swift"), renderPackage(manifest, basePackagePath));
  await fs.writeFile(
    path.join(outputDir, OUTPUT_OWNER_MARKER),
    OUTPUT_OWNER_MARKER_CONTENT,
    { flag: "wx", mode: 0o644 },
  );
}

async function lstatIfPresent(target) {
  try {
    return await fs.lstat(target);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function canonicalPathAllowMissing(target) {
  let existing = path.resolve(target);
  const suffix = [];
  while ((await lstatIfPresent(existing)) === null) {
    const parent = path.dirname(existing);
    if (parent === existing) {
      fail(`cannot resolve an existing ancestor for ${path.resolve(target)}`);
    }
    suffix.unshift(path.basename(existing));
    existing = parent;
  }
  return path.resolve(await fs.realpath(existing), ...suffix);
}

function isEqualOrAncestor(ancestor, descendant) {
  return ancestor === descendant || descendant.startsWith(`${ancestor}${path.sep}`);
}

export async function safeGeneratedOutput(outputDir, protectedPaths) {
  const requested = path.resolve(outputDir);
  if (requested === path.parse(requested).root) {
    fail(`refusing filesystem root as the generated output: ${requested}`);
  }
  const requestedStat = await lstatIfPresent(requested);
  if (requestedStat?.isSymbolicLink()) {
    fail(`generated output already exists as a symbolic link; refusing to replace it: ${requested}`);
  }
  const output = await canonicalPathAllowMissing(requested);
  for (const protection of protectedPaths.filter(({ path: protectedPath }) => Boolean(protectedPath))) {
    if (
      protection.mode !== "containment"
      && protection.mode !== "disjoint"
    ) {
      fail(`internal protected-path mode is invalid for ${protection.label}`);
    }
    const protectedCanonical = await canonicalPathAllowMissing(protection.path);
    const outputContainsProtected = isEqualOrAncestor(output, protectedCanonical);
    const protectedContainsOutput = isEqualOrAncestor(protectedCanonical, output);
    if (
      outputContainsProtected
      || (protection.mode === "disjoint" && protectedContainsOutput)
    ) {
      const relationship = protection.mode === "disjoint"
        ? "overlaps"
        : "is equal to or contains";
      fail(
        `refusing generated output ${output}; it ${relationship} protected ${protection.label} ${protectedCanonical}`,
      );
    }
  }
  if (requestedStat !== null) {
    fail(`generated output already exists; create-only generation refuses to replace it: ${output}`);
  }
  return output;
}

async function validatedStagingEntries(staging) {
  const required = new Set([
    OUTPUT_OWNER_MARKER,
    "Package.swift",
    "Sources",
    "extension-products.json",
  ]);
  const allowed = new Set([...required, "Artifacts"]);
  const entries = (await fs.readdir(staging)).sort(compareText);
  const missing = [...required].filter((entry) => !entries.includes(entry));
  const unexpected = entries.filter((entry) => !allowed.has(entry));
  if (missing.length > 0 || unexpected.length > 0) {
    fail(
      `private staging tree has an invalid top-level inventory`
      + `${missing.length > 0 ? `; missing: ${missing.join(", ")}` : ""}`
      + `${unexpected.length > 0 ? `; unexpected: ${unexpected.join(", ")}` : ""}`,
    );
  }
  for (const entry of entries) {
    const metadata = await fs.lstat(path.join(staging, entry));
    const shouldBeDirectory = entry === "Sources" || entry === "Artifacts";
    if (
      metadata.isSymbolicLink()
      || (shouldBeDirectory ? !metadata.isDirectory() : !metadata.isFile())
    ) {
      fail(`private staging entry has an invalid filesystem type: ${entry}`);
    }
  }
  return entries;
}

export async function publishCreateOnly(staging, output, entries, onClaim = () => {}) {
  try {
    await fs.mkdir(output, { mode: 0o700, recursive: false });
  } catch (error) {
    if ((await lstatIfPresent(output)) !== null) {
      fail(`generated output appeared during publication; refusing to replace it: ${output}`);
    }
    throw error;
  }
  await onClaim();
  const publicationOrder = [
    "Artifacts",
    "Sources",
    "extension-products.json",
    "Package.swift",
  ].filter((entry) => entries.includes(entry));
  for (const entry of publicationOrder) {
    await fs.rename(path.join(staging, entry), path.join(output, entry));
  }
  await fs.chmod(output, 0o755);
  await fs.rename(
    path.join(staging, OUTPUT_OWNER_MARKER),
    path.join(output, OUTPUT_OWNER_MARKER),
  );
}

async function writeGenerated(
  selection,
  outputDir,
  basePackagePath,
  localBinaryTargets,
  protectedPaths,
) {
  const resolvedOutput = await safeGeneratedOutput(outputDir, protectedPaths);
  const parent = path.dirname(resolvedOutput);
  await fs.mkdir(parent, { recursive: true });
  const confirmedParent = await fs.realpath(parent);
  if (path.join(confirmedParent, path.basename(resolvedOutput)) !== resolvedOutput) {
    fail(`generated output parent changed while resolving ${resolvedOutput}`);
  }
  const staging = await fs.mkdtemp(
    path.join(parent, `.${path.basename(resolvedOutput)}.tmp-`),
  );
  await fs.chmod(staging, 0o700);
  let outputClaimed = false;
  let outputComplete = false;
  let operationError;
  try {
    await writeGeneratedTree(selection, staging, basePackagePath, localBinaryTargets);
    const stagingEntries = await validatedStagingEntries(staging);
    const publishOutput = await safeGeneratedOutput(outputDir, protectedPaths);
    if (publishOutput !== resolvedOutput) {
      fail(`generated output resolution changed before publication: ${resolvedOutput}`);
    }
    await publishCreateOnly(staging, resolvedOutput, stagingEntries, () => {
      outputClaimed = true;
    });
    outputComplete = true;
    await fs.rmdir(staging);
  } catch (error) {
    operationError = error;
  }
  if (operationError) {
    const detail = operationError instanceof Error ? operationError.message : String(operationError);
    const retained = outputClaimed
      ? `${outputComplete ? "completed" : "incomplete"} create-only output is retained at ${resolvedOutput}; private staging, if any, is retained at ${staging}`
      : `private staging is retained for explicit cleanup at ${staging}`;
    throw new Error(`${detail}; ${retained}`, { cause: operationError });
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let input;
  let inputDirectory;
  let carrierCacheDir;
  let inputFile;
  if (args.input) {
    inputFile = path.resolve(args.input);
    input = JSON.parse(await fs.readFile(inputFile, "utf8"));
    inputDirectory = path.dirname(inputFile);
  } else {
    const toolDirectory = path.dirname(fileURLToPath(import.meta.url));
    const version = args.basePackageVersion ??
      (await fs.readFile(path.resolve(toolDirectory, "../VERSION"), "utf8")).trim();
    carrierCacheDir = args.cacheDir ?? path.join(os.homedir(), ".cache", "oliphaunt", "swift-extensions");
    input = await resolveSwiftCarrierSelection({
      allowFileUrls: args.allowFileUrls,
      basePackageUrl: args.basePackageUrl,
      basePackageVersion: version,
      cacheDir: carrierCacheDir,
      carrierFile: path.resolve(args.carrier),
      extensionCarrierFiles: args.extensionCarriers.map((file) => path.resolve(file)),
      extensions: args.extensions,
      offline: args.offline,
      localBinaryTargets: args.localBinaryTargets,
    });
    inputDirectory = process.cwd();
  }
  const selection = validateSelection(input, inputDirectory, {
    allowFileUrls: args.allowFileUrls,
    localBinaryTargets: args.localBinaryTargets,
  });
  const canonicalInventory = await loadSwiftExtensionInventoryCatalog();
  if (args.basePackagePath !== undefined) {
    const baseManifest = path.join(args.basePackagePath, "Package.swift");
    const stat = await fs.stat(baseManifest).catch(() => null);
    if (stat?.isFile() !== true) {
      fail(`--base-package-path does not contain Package.swift: ${args.basePackagePath}`);
    }
  }
  for (const extension of selection.extensions) {
    extension.resources = await validateSwiftExtensionResourceArtifact({
      extension,
      canonical: canonicalInventory.get(extension.sqlName),
      nativeRuntime: selection.nativeRuntime,
      label: `${extension.sqlName} resource artifact`,
      allowMobileCarrierArchives: args.carrier !== undefined,
    });
  }
  await writeGenerated(
    selection,
    path.resolve(args.outputDir),
    args.basePackagePath,
    args.localBinaryTargets,
    [
      { label: "working directory", mode: "containment", path: process.cwd() },
      { label: "selection input", mode: "containment", path: inputFile },
      { label: "base carrier", mode: "containment", path: args.carrier },
      ...args.extensionCarriers.map((carrier) => ({
        label: "extension carrier",
        mode: "containment",
        path: carrier,
      })),
      {
        label: "carrier cache",
        mode: "disjoint",
        path: args.cacheDir ?? carrierCacheDir,
      },
      { label: "base package", mode: "disjoint", path: args.basePackagePath },
      ...selection.extensions.flatMap((extension) => [
        { label: `${extension.sqlName} resource root`, mode: "disjoint", path: extension.resourceRoot },
        { label: `${extension.sqlName} XCFramework`, mode: "disjoint", path: extension.asset?.localPath },
        ...extension.nativeDependencies.map((dependency) => ({
          label: `${dependency.name} XCFramework`,
          mode: "disjoint",
          path: dependency.asset.localPath,
        })),
      ]),
    ].filter(({ path: protectedPath }) => protectedPath !== undefined),
  );
  console.log(
    `${PREFIX}: generated ${selection.extensions.length} selected extension product(s) in ${path.resolve(args.outputDir)}`,
  );
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
