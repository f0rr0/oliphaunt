#!/usr/bin/env node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveSwiftCarrierSelection } from "./swift-carrier-resolver.mjs";

const PREFIX = "render-extension-products.mjs";
const INPUT_SCHEMA = "oliphaunt-swiftpm-extension-input-v1";
const OUTPUT_SCHEMA = "oliphaunt-swiftpm-extension-products-v1";
const DEFAULT_CARRIER = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../Carriers/oliphaunt-react-native-ios-carriers.json",
);

function fail(message) {
  throw new Error(`${PREFIX}: ${message}`);
}

function usage() {
  console.error(
    `usage: ${PREFIX} (--input <selection.json> | [--carrier <carrier.json>] --extensions <csv>) ` +
      `--output-dir <directory> [--cache-dir <directory>] [--offline] [--allow-file-urls] ` +
      `[--base-package-url <git-url>] [--base-package-version <semver>] ` +
      `[--base-package-path <local-oliphaunt-checkout>]`,
  );
}

function parseArgs(argv) {
  const args = { allowFileUrls: false, offline: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    }
    if (arg === "--allow-file-urls" || arg === "--offline") {
      if (arg === "--allow-file-urls") args.allowFileUrls = true;
      else args.offline = true;
      continue;
    }
    if (!["--input", "--carrier", "--extensions", "--cache-dir", "--output-dir", "--base-package-path", "--base-package-url", "--base-package-version"].includes(arg)) {
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
    if (arg === "--extensions") args.extensions = value.split(",").map((row) => row.trim()).filter(Boolean);
    if (arg === "--cache-dir") args.cacheDir = path.resolve(value);
    if (arg === "--output-dir") args.outputDir = value;
    if (arg === "--base-package-path") args.basePackagePath = path.resolve(value);
    if (arg === "--base-package-url") args.basePackageUrl = value;
    if (arg === "--base-package-version") args.basePackageVersion = value;
  }
  if (!args.outputDir || (args.input && (args.carrier || args.extensions?.length)) || (!args.input && !args.extensions?.length)) {
    usage();
    fail("choose --input, or --extensions with an optional --carrier, and provide --output-dir");
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
  return items.sort((left, right) => left.localeCompare(right));
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

function expectedProduct(sqlName) {
  return `oliphaunt-extension-${sqlName.replaceAll("_", "-")}`;
}

function expectedSymbolPrefix(stem) {
  return `oliphaunt_static_${stem.replaceAll(/[^A-Za-z0-9_]/gu, "_")}`;
}

function validateAsset(value, label, allowFileUrls = false) {
  const asset = object(value, label);
  exactKeys(asset, ["checksum", "name", "url"], label);
  if (typeof asset.name !== "string" || path.basename(asset.name) !== asset.name) {
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
  return { checksum: asset.checksum, name: asset.name, url: asset.url };
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
    `${left.name}\0${left.address}`.localeCompare(`${right.name}\0${right.address}`),
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

function validateNativeDependencies(value, label, allowFileUrls = false) {
  if (!Array.isArray(value)) {
    fail(`${label} must be an array of separately checksum-pinned XCFramework assets`);
  }
  const dependencies = value.map((raw, index) => {
    const dependency = object(raw, `${label}[${index}]`);
    exactKeys(dependency, ["asset", "name"], `${label}[${index}]`);
    const name = portable(dependency.name, `${label}[${index}].name`);
    return {
      asset: validateAsset(dependency.asset, `${label}[${index}].asset`, allowFileUrls),
      binaryTarget: `OliphauntNativeDependency${swiftSuffix(name)}`,
      name,
    };
  });
  dependencies.sort((left, right) => left.name.localeCompare(right.name));
  if (new Set(dependencies.map(({ name }) => name)).size !== dependencies.length) {
    fail(`${label} repeats a native dependency name`);
  }
  return dependencies;
}

function validateSelection(input, inputDirectory, { allowFileUrls = false } = {}) {
  const root = object(input, "input");
  exactKeys(root, ["basePackage", "extensions", "schema"], "input");
  if (root.schema !== INPUT_SCHEMA) {
    fail(`input schema must be ${INPUT_SCHEMA}`);
  }
  if (!Array.isArray(root.extensions) || root.extensions.length === 0) {
    fail("input extensions must be a non-empty selected extension array");
  }
  const basePackage = validateBasePackage(root.basePackage);
  const extensions = root.extensions.map((raw, index) => {
    const row = object(raw, `extensions[${index}]`);
    exactKeys(
      row,
      [
        "asset",
        "dependencies",
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
    if (product !== expectedProduct(sqlName)) {
      fail(`extensions[${index}].product must be ${expectedProduct(sqlName)}; got ${product}`);
    }
    const nativeModuleStem = nullablePortable(
      row.nativeModuleStem,
      `extensions[${index}].nativeModuleStem`,
    );
    const cModuleStem = nativeModuleStem?.replaceAll(/[^A-Za-z0-9_]/gu, "_");
    const suffix = swiftSuffix(sqlName);
    if (nativeModuleStem === null && row.registration !== null) {
      fail(`extensions[${index}] SQL-only extension must use null registration metadata`);
    }
    const asset = row.asset === null ? null : validateAsset(row.asset, `extensions[${index}].asset`, allowFileUrls);
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
    return {
      asset,
      binaryTarget: nativeModuleStem === null ? null : `OliphauntExtension${suffix}Binary`,
      cFunction: nativeModuleStem === null ? null : `oliphaunt_extension_${cModuleStem}_descriptor`,
      cTarget: nativeModuleStem === null ? null : `COliphauntExtension${suffix}`,
      dependencies: uniquePortableList(row.dependencies, `extensions[${index}].dependencies`),
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
      version: portable(row.version, `extensions[${index}].version`),
    };
  });
  extensions.sort((left, right) => left.sqlName.localeCompare(right.sqlName));
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
    nativeDependencies: [...nativeDependencies.values()].sort((left, right) =>
      left.name.localeCompare(right.name),
    ),
  };
}

function parseProperties(text, source) {
  const properties = new Map();
  for (const [index, rawLine] of text.split(/\r?\n/u).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) fail(`${source}:${index + 1} is not a key=value property`);
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (properties.has(key)) fail(`${source}:${index + 1} repeats property ${key}`);
    properties.set(key, value);
  }
  return properties;
}

function property(properties, key, expected, source) {
  const actual = properties.get(key);
  if (actual !== expected) {
    fail(`${source} must declare ${key}=${expected}; got ${actual ?? "<missing>"}`);
  }
}

function propertyList(properties, key, source) {
  if (!properties.has(key)) fail(`${source} is missing ${key}`);
  const value = properties.get(key);
  return value ? uniquePortableList(value.split(","), `${source} ${key}`) : [];
}

async function safeResourceFiles(root) {
  const files = [];
  async function visit(current, relative) {
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink()) fail(`extension resource artifact contains symlink: ${current}`);
    if (stat.isDirectory()) {
      const entries = await fs.readdir(current);
      entries.sort((left, right) => left.localeCompare(right));
      for (const entry of entries) {
        await visit(path.join(current, entry), relative ? `${relative}/${entry}` : entry);
      }
      return;
    }
    if (!stat.isFile()) fail(`extension resource artifact contains unsupported entry: ${current}`);
    files.push({ absolute: current, bytes: stat.size, relative });
  }
  try {
    await visit(root, "");
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  return files;
}

async function validateResourceArtifact(extension) {
  const manifestFile = path.join(extension.resourceRoot, "manifest.properties");
  let manifestText;
  try {
    manifestText = await fs.readFile(manifestFile, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") fail(`${extension.sqlName} resourceRoot is missing ${manifestFile}`);
    throw error;
  }
  const properties = parseProperties(manifestText, manifestFile);
  const allowed = new Set([
    "packageLayout",
    "pgMajor",
    "sqlName",
    "createsExtension",
    "nativeModuleStem",
    "nativeModuleFile",
    "nativeTarget",
    "dependencies",
    "dataFiles",
    "sharedPreloadLibraries",
    "mobilePrebuilt",
    "mobileStaticArchives",
    "mobileStaticDependencyArchives",
    "staticSymbolPrefix",
    "staticSymbolAliases",
    "files",
  ]);
  const extras = [...properties.keys()].filter((key) => !allowed.has(key)).sort();
  if (extras.length > 0) fail(`${manifestFile} contains unsupported field(s): ${extras.join(", ")}`);
  property(properties, "packageLayout", "oliphaunt-extension-artifact-v1", manifestFile);
  property(properties, "pgMajor", "18", manifestFile);
  property(properties, "sqlName", extension.sqlName, manifestFile);
  property(properties, "files", "files", manifestFile);
  property(properties, "mobilePrebuilt", "yes", manifestFile);
  const createsExtension = properties.get("createsExtension");
  if (createsExtension !== "yes" && createsExtension !== "no") {
    fail(`${manifestFile} createsExtension must be yes or no`);
  }
  const manifestStem = properties.get("nativeModuleStem") || null;
  if (manifestStem !== extension.nativeModuleStem) {
    fail(
      `${manifestFile} nativeModuleStem=${manifestStem ?? "<empty>"} does not match selected ` +
        `${extension.nativeModuleStem ?? "<SQL-only>"}`,
    );
  }
  const manifestDependencies = propertyList(properties, "dependencies", manifestFile);
  if (JSON.stringify(manifestDependencies) !== JSON.stringify(extension.dependencies)) {
    fail(`${manifestFile} dependencies do not match the selected exact-extension dependency set`);
  }
  const sharedPreloadLibraries = propertyList(
    properties,
    "sharedPreloadLibraries",
    manifestFile,
  );
  if (JSON.stringify(sharedPreloadLibraries) !== JSON.stringify(extension.sharedPreloadLibraries)) {
    fail(`${manifestFile} sharedPreloadLibraries do not match selected metadata`);
  }

  const shareRoot = path.join(extension.resourceRoot, "files", "share", "postgresql");
  const files = await safeResourceFiles(shareRoot);
  if (createsExtension === "yes") {
    const control = `extension/${extension.sqlName}.control`;
    const installPrefix = `extension/${extension.sqlName}--`;
    if (!files.some(({ relative }) => relative === control)) {
      fail(`${manifestFile} declares a CREATE EXTENSION product but is missing files/share/postgresql/${control}`);
    }
    if (!files.some(({ relative }) => relative.startsWith(installPrefix) && relative.endsWith(".sql"))) {
      fail(`${manifestFile} declares a CREATE EXTENSION product but is missing ${extension.sqlName}--*.sql`);
    }
  }
  return {
    bytes: files.reduce((total, file) => total + file.bytes, 0),
    createsExtension: createsExtension === "yes",
    files,
  };
}

async function copyResourceArtifact(extension, swiftRoot) {
  const resourceTarget = path.join(swiftRoot, "Resources", "extension-artifact");
  const shareTarget = path.join(resourceTarget, "files", "share", "postgresql");
  await fs.mkdir(shareTarget, { recursive: true });
  for (const file of extension.resources.files) {
    const destination = path.join(shareTarget, ...file.relative.split("/"));
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(file.absolute, destination);
    await fs.chmod(destination, 0o644);
  }
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

function targetIR(extension, bySqlName) {
  const swiftPath = `Sources/${extension.swiftTarget}`;
  const targets = [];
  if (extension.nativeModuleStem !== null) {
    targets.push(
      {
        checksum: extension.asset.checksum,
        kind: "binaryTarget",
        name: extension.binaryTarget,
        url: extension.asset.url,
      },
      {
        dependencies: [
          baseProduct("COliphaunt"),
          extension.binaryTarget,
          ...extension.nativeDependencies.map(({ binaryTarget }) => binaryTarget),
        ],
        kind: "target",
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
      return `    .target(\n        name: ${swiftString(target.name)},\n        dependencies: [${target.dependencies
        .map(renderTargetDependency)
        .join(", ")}],\n        path: ${swiftString(target.path)}${headers}${resources}\n    )`;
    })
    .join(",\n");
  const baseDependency = basePackagePath
    ? `.package(name: "oliphaunt", path: ${swiftString(basePackagePath)})`
    : `.package(\n            url: ${swiftString(manifest.basePackage.url)},\n            exact: ${swiftString(manifest.basePackage.version)}\n        )`;
  return `// swift-tools-version: 6.0\n\n` +
    `import PackageDescription\n\n` +
    `// Generated by ${PREFIX}. Do not edit. This local package belongs to the\n` +
    `// consuming application; exact extension carriers remain independently versioned assets.\n` +
    `let package = Package(\n` +
    `    name: "OliphauntSelectedExtensions",\n` +
    `    platforms: [.iOS(.v17), .macOS(.v14)],\n` +
    `    products: [\n${products}\n    ],\n` +
    `    dependencies: [\n        ${baseDependency}\n    ],\n` +
    `    targets: [\n${targets}\n    ]\n` +
    `)\n`;
}

async function writeGenerated(selection, outputDir, basePackagePath) {
  await fs.rm(outputDir, { force: true, recursive: true });
  await fs.mkdir(outputDir, { recursive: true });
  const products = [];
  const targets = [];
  const selected = [];
  for (const dependency of selection.nativeDependencies) {
    targets.push({
      checksum: dependency.asset.checksum,
      kind: "binaryTarget",
      name: dependency.binaryTarget,
      url: dependency.asset.url,
    });
  }
  for (const extension of selection.extensions) {
    const swiftRoot = path.join(outputDir, "Sources", extension.swiftTarget);
    if (extension.cTarget) {
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
    targets.push(...targetIR(extension, selection.bySqlName));
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
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let input;
  let inputDirectory;
  if (args.input) {
    const inputFile = path.resolve(args.input);
    input = JSON.parse(await fs.readFile(inputFile, "utf8"));
    inputDirectory = path.dirname(inputFile);
  } else {
    const toolDirectory = path.dirname(fileURLToPath(import.meta.url));
    const version = args.basePackageVersion ??
      (await fs.readFile(path.resolve(toolDirectory, "../VERSION"), "utf8")).trim();
    input = await resolveSwiftCarrierSelection({
      allowFileUrls: args.allowFileUrls,
      basePackageUrl: args.basePackageUrl,
      basePackageVersion: version,
      cacheDir: args.cacheDir ?? path.join(os.homedir(), ".cache", "oliphaunt", "swift-extensions"),
      carrierFile: path.resolve(args.carrier),
      extensions: args.extensions,
      offline: args.offline,
    });
    inputDirectory = process.cwd();
  }
  const selection = validateSelection(input, inputDirectory, { allowFileUrls: args.allowFileUrls });
  if (args.basePackagePath !== undefined) {
    const baseManifest = path.join(args.basePackagePath, "Package.swift");
    const stat = await fs.stat(baseManifest).catch(() => null);
    if (stat?.isFile() !== true) {
      fail(`--base-package-path does not contain Package.swift: ${args.basePackagePath}`);
    }
  }
  for (const extension of selection.extensions) {
    extension.resources = await validateResourceArtifact(extension);
  }
  await writeGenerated(selection, path.resolve(args.outputDir), args.basePackagePath);
  console.log(
    `${PREFIX}: generated ${selection.extensions.length} selected extension product(s) in ${path.resolve(args.outputDir)}`,
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
