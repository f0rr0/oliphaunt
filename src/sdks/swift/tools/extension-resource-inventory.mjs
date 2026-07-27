import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";

const PROPERTY_KEYS = Object.freeze([
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
const LEGAL_MEMBERS_BY_PROFILE = Object.freeze({
  "contrib-native": Object.freeze([
    "LICENSE",
    "THIRD_PARTY_LICENSES/PostgreSQL-COPYRIGHT",
    "THIRD_PARTY_NOTICES.md",
  ]),
  "contrib-native-openssl": Object.freeze([
    "LICENSE",
    "THIRD_PARTY_LICENSES/OpenSSL-LICENSE.txt",
    "THIRD_PARTY_LICENSES/PostgreSQL-COPYRIGHT",
    "THIRD_PARTY_NOTICES.md",
  ]),
  "external-native": Object.freeze([
    "LICENSE",
    "THIRD_PARTY_NOTICES.md",
  ]),
});
const PORTABLE = /^[A-Za-z0-9._-]{1,128}$/u;
const C_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const STABLE_SEMVER = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u;
const MAX_FILES = 4096;
const MAX_FILE_BYTES = 48 * 1024 * 1024;
const MAX_TREE_BYTES = 256 * 1024 * 1024;
const OWNER_CATALOG_FILENAME = "extension-owner-catalog.json";
const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function fail(label, message) {
  throw new Error(`${label}: ${message}`);
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalRelativePath(value, label) {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.includes("\\")
    || value !== value.normalize("NFC")
    || /[\u0000-\u001f\u007f]/u.test(value)
    || value.startsWith("/")
    || /^[A-Za-z]:/u.test(value)
  ) {
    fail(label, "must be a canonical NFC relative path without backslashes");
  }
  const parts = value.split("/");
  if (parts.some((part) => part.length === 0 || part === "." || part === "..")) {
    fail(label, "must not contain empty, '.' or '..' components");
  }
  return parts.join("/");
}

export function createPortablePathCollisionTracker(label) {
  const paths = new Map();
  return (relative) => {
    if (typeof relative !== "string") fail(label, "contains a non-string path");
    // The upper/lower round-trip catches multi-code-point folds such as
    // sharp-s while NFC gives canonically equivalent spellings one key.
    const collisionKey = relative
      .normalize("NFC")
      .toUpperCase()
      .toLowerCase()
      .normalize("NFC");
    const collision = paths.get(collisionKey);
    if (collision !== undefined && collision !== relative) {
      fail(label, `contains case/NFC-colliding paths ${collision} and ${relative}`);
    }
    paths.set(collisionKey, relative);
  };
}

function canonicalList(value, label, validator = undefined) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    fail(label, "must be a string array");
  }
  const rows = value.map((item, index) => validator?.(item, `${label}[${index}]`) ?? item);
  const sorted = [...rows].sort(compareText);
  if (new Set(rows).size !== rows.length || JSON.stringify(rows) !== JSON.stringify(sorted)) {
    fail(label, "must be sorted and unique");
  }
  return rows;
}

function portable(value, label) {
  if (typeof value !== "string" || !PORTABLE.test(value)) fail(label, "must be a portable identifier");
  return value;
}

function normalizeCanonicalRow(row, label) {
  const sqlName = portable(row?.["sql-name"], `${label}.sql-name`);
  const product = portable(row?.["release-product"], `${label}.release-product`);
  const createsExtension = row?.["creates-extension"];
  if (typeof createsExtension !== "boolean") fail(label, "creates-extension must be boolean");
  const nativeModuleStem = row?.["native-module-stem"] ?? null;
  if (nativeModuleStem !== null) portable(nativeModuleStem, `${label}.native-module-stem`);
  const extensionSqlFileNames = canonicalList(
    row?.["extension-sql-file-names"],
    `${label}.extension-sql-file-names`,
  );
  if (extensionSqlFileNames.some((name) =>
    !PORTABLE.test(name) || path.posix.basename(name) !== name || !name.endsWith(".sql"))) {
    fail(label, "extension-sql-file-names must contain SQL basenames");
  }
  const extensionSqlFilePrefixes = canonicalList(
    row?.["extension-sql-file-prefixes"],
    `${label}.extension-sql-file-prefixes`,
  );
  if (extensionSqlFilePrefixes.some((prefix) => !PORTABLE.test(prefix) || prefix.includes("."))) {
    fail(label, "extension-sql-file-prefixes must contain portable basename prefixes");
  }
  return {
    sqlName,
    product,
    createsExtension,
    nativeModuleStem,
    dependencies: canonicalList(
      row?.["selected-extension-dependencies"],
      `${label}.selected-extension-dependencies`,
      portable,
    ),
    dataFiles: canonicalList(
      row?.["runtime-share-data-files"],
      `${label}.runtime-share-data-files`,
      canonicalRelativePath,
    ),
    extensionSqlFileNames,
    extensionSqlFilePrefixes,
    sharedPreloadLibraries: canonicalList(
      row?.["shared-preload-libraries"],
      `${label}.shared-preload-libraries`,
      portable,
    ),
  };
}

function normalizeFrozenRuntimeContract(row, label) {
  const sqlName = portable(row?.sqlName, `${label}.sqlName`);
  const product = portable(row?.product, `${label}.product`);
  if (typeof row?.createsExtension !== "boolean") fail(label, "createsExtension must be boolean");
  const nativeModuleStem = row?.nativeModuleStem ?? null;
  if (nativeModuleStem !== null) portable(nativeModuleStem, `${label}.nativeModuleStem`);
  const dependencies = canonicalList(
    row?.dependencies,
    `${label}.dependencies`,
    portable,
  );
  if (dependencies.includes(sqlName)) fail(label, "dependencies must not include the extension itself");
  const extensionSqlFileNames = canonicalList(
    row?.extensionSqlFileNames,
    `${label}.extensionSqlFileNames`,
    portable,
  );
  if (extensionSqlFileNames.some((name) => !name.endsWith(".sql"))) {
    fail(label, "extensionSqlFileNames must contain SQL basenames");
  }
  const extensionSqlFilePrefixes = canonicalList(
    row?.extensionSqlFilePrefixes,
    `${label}.extensionSqlFilePrefixes`,
  );
  if (extensionSqlFilePrefixes.some((prefix) => !/^[A-Za-z0-9_-]{1,128}$/u.test(prefix))) {
    fail(label, "extensionSqlFilePrefixes must contain dot-free portable basename prefixes");
  }
  return {
    createsExtension: row.createsExtension,
    dataFiles: canonicalList(
      row?.dataFiles,
      `${label}.dataFiles`,
      canonicalRelativePath,
    ),
    dependencies,
    extensionSqlFileNames,
    extensionSqlFilePrefixes,
    nativeModuleStem,
    product,
    sharedPreloadLibraries: canonicalList(
      row?.sharedPreloadLibraries,
      `${label}.sharedPreloadLibraries`,
      portable,
    ),
    sqlName,
  };
}

export async function loadSwiftExtensionInventoryCatalog(ownerCatalogFile = undefined) {
  const candidates = ownerCatalogFile === undefined
    ? [
        path.join(import.meta.dirname, OWNER_CATALOG_FILENAME),
        path.resolve(import.meta.dirname, "../../../extensions/generated/sdk/swift.json"),
      ]
    : [path.resolve(ownerCatalogFile)];
  let selected;
  for (const candidate of candidates) {
    const metadata = await fs.stat(candidate).catch(() => null);
    if (metadata?.isFile() === true) {
      selected = candidate;
      break;
    }
  }
  if (selected === undefined) {
    fail("Swift extension inventory", `canonical owner catalog is missing; expected ${candidates.join(" or ")}`);
  }
  let document;
  try {
    document = JSON.parse(await fs.readFile(selected, "utf8"));
  } catch (error) {
    fail("Swift extension inventory", `could not read ${selected}: ${error.message}`);
  }
  if (document?.consumer !== "swift" || !Array.isArray(document.extensions) || document.extensions.length === 0) {
    fail(selected, "is not a generated Swift extension catalog");
  }
  const rows = new Map();
  for (const [index, row] of document.extensions.entries()) {
    const normalized = normalizeCanonicalRow(row, `${selected}.extensions[${index}]`);
    if (rows.has(normalized.sqlName)) fail(selected, `repeats canonical SQL name ${normalized.sqlName}`);
    rows.set(normalized.sqlName, normalized);
  }
  return rows;
}

function parseProperties(text, label) {
  if (
    typeof text !== "string"
    || text.startsWith("\uFEFF")
    || text.includes("\r")
    || text.includes("\\")
    || text !== text.normalize("NFC")
    || /[\u0000-\u0009\u000b-\u001f\u007f]/u.test(text)
    || !text.endsWith("\n")
    || text.endsWith("\n\n")
  ) {
    fail(label, "must be canonical NFC UTF-8 key=value text with LF and one final newline");
  }
  const properties = new Map();
  for (const [index, line] of text.slice(0, -1).split("\n").entries()) {
    const separator = line.indexOf("=");
    if (line.length === 0 || separator <= 0 || line.trim() !== line) {
      fail(label, `has malformed physical line ${index + 1}`);
    }
    const key = line.slice(0, separator);
    if (properties.has(key)) fail(label, `repeats property ${key}`);
    properties.set(key, line.slice(separator + 1));
  }
  if (JSON.stringify([...properties.keys()]) !== JSON.stringify(PROPERTY_KEYS)) {
    fail(label, `must contain the exact canonical fields in canonical order: ${PROPERTY_KEYS.join(",")}`);
  }
  return properties;
}

function decodeUtf8(bytes, label) {
  try {
    return UTF8.decode(bytes);
  } catch (error) {
    fail(label, `contains invalid UTF-8: ${error.message}`);
  }
}

function csv(value, label) {
  if (typeof value !== "string") fail(label, "must be a string");
  if (value === "") return [];
  const rows = value.split(",");
  if (
    rows.some((row) => row.length === 0 || row.trim() !== row)
    || new Set(rows).size !== rows.length
    || JSON.stringify(rows) !== JSON.stringify([...rows].sort(compareText))
  ) {
    fail(label, "must be a sorted unique canonical CSV");
  }
  return rows;
}

function orderedCsv(value, label) {
  if (typeof value !== "string") fail(label, "must be a string");
  if (value === "") return [];
  const rows = value.split(",");
  if (
    rows.some((row) => row.length === 0 || row.trim() !== row)
    || new Set(rows).size !== rows.length
  ) {
    fail(label, "must be a unique canonical CSV");
  }
  return rows;
}

function legalPaths(properties, extension, contract, label) {
  const licenseFiles = csv(
    properties.get("licenseFiles"),
    `${label} licenseFiles`,
  ).map((relative, index) => canonicalRelativePath(
    relative,
    `${label} licenseFiles[${index}]`,
  ));
  if (licenseFiles.some((relative) => !relative.startsWith("share/licenses/"))) {
    fail(label, "manifest licenseFiles must live under share/licenses/");
  }
  const contrib = extension.product === "oliphaunt-extension-contrib-pg18";
  const dependencyNames = Array.isArray(extension?.nativeDependencies)
    ? extension.nativeDependencies.map(({ name }) => name)
    : [];
  const expectedProfile = contrib
    ? contract.sqlName === "pgcrypto" && dependencyNames.includes("openssl")
      ? "contrib-native-openssl"
      : "contrib-native"
    : "external-native";
  if (properties.get("licenseProfile") !== expectedProfile) {
    fail(label, `manifest licenseProfile must be ${JSON.stringify(expectedProfile)}`);
  }
  if (contrib && licenseFiles.length !== 0) {
    fail(label, "contrib artifacts must not declare external upstream licenseFiles");
  }
  if (!contrib && licenseFiles.length === 0) {
    fail(label, "external artifacts must declare at least one upstream licenseFile");
  }
  return [
    ...LEGAL_MEMBERS_BY_PROFILE[expectedProfile],
    ...licenseFiles.map((relative) => `files/${relative}`),
  ].sort(compareText);
}

function mobileStaticPaths(
  properties,
  extension,
  contract,
  label,
  allowMobileCarrierArchives,
) {
  const archiveRows = csv(
    properties.get("mobileStaticArchives"),
    `${label} mobileStaticArchives`,
  );
  const dependencyRows = orderedCsv(
    properties.get("mobileStaticDependencyArchives"),
    `${label} mobileStaticDependencyArchives`,
  );
  if (!Array.isArray(extension?.nativeDependencies)) {
    fail(label, "nativeDependencies must be an array");
  }
  const dependencyNames = canonicalList(
    extension.nativeDependencies.map((dependency, index) =>
      portable(dependency?.name, `${label}.nativeDependencies[${index}].name`)),
    `${label}.nativeDependencies`,
  );
  if (allowMobileCarrierArchives !== true) {
    if (archiveRows.length > 0 || dependencyRows.length > 0) {
      fail(label, "manifest mobile static archives are only valid for carrier-resolved inputs");
    }
    return [];
  }
  if (contract.nativeModuleStem === null) {
    if (dependencyNames.length > 0) {
      fail(label, "SQL-only artifacts must not declare native dependencies");
    }
    if (archiveRows.length > 0 || dependencyRows.length > 0) {
      fail(label, "SQL-only artifacts must not declare mobile static archives");
    }
    return [];
  }

  const targets = ["ios-device", "ios-simulator"];
  const expectedArchives = targets.map(
    (target) =>
      `${target}:mobile-static/${target}/extensions/${contract.nativeModuleStem}/` +
      `liboliphaunt_extension_${contract.nativeModuleStem}.a`,
  );
  if (JSON.stringify(archiveRows) !== JSON.stringify(expectedArchives)) {
    fail(
      label,
      `mobileStaticArchives must exactly cover ${expectedArchives.join(",")}`,
    );
  }

  const parsedDependencies = dependencyRows.map((row, index) => {
    const fields = row.split(":");
    if (fields.length !== 3) {
      fail(label, `mobileStaticDependencyArchives[${index}] is malformed`);
    }
    const [target, dependency, relative] = fields;
    if (!targets.includes(target) || !dependencyNames.includes(dependency)) {
      fail(
        label,
        `mobileStaticDependencyArchives[${index}] has an unknown target or dependency`,
      );
    }
    const canonical = canonicalRelativePath(
      relative,
      `${label} mobileStaticDependencyArchives[${index}] path`,
    );
    const directory = `mobile-static/${target}/dependencies/${dependency}`;
    const archiveName = path.posix.basename(canonical);
    if (
      path.posix.dirname(canonical) !== directory ||
      !/^lib[A-Za-z0-9._-]+\.a$/u.test(archiveName)
    ) {
      fail(
        label,
        `mobileStaticDependencyArchives[${index}] must name a portable lib*.a directly under ${directory}`,
      );
    }
    return { archiveName, dependency, relative: canonical, target };
  });
  const expectedDependencyKeys = targets.flatMap((target) =>
    dependencyNames.map((dependency) => `${target}\0${dependency}`));
  const dependencyKeys = parsedDependencies.map(
    ({ dependency, target }) => `${target}\0${dependency}`,
  );
  if (JSON.stringify(dependencyKeys) !== JSON.stringify(expectedDependencyKeys)) {
    fail(
      label,
      "mobileStaticDependencyArchives must exactly cover both iOS targets and every native dependency",
    );
  }
  const archiveNameByDependency = new Map();
  for (const { archiveName, dependency } of parsedDependencies) {
    const prior = archiveNameByDependency.get(dependency);
    if (prior !== undefined && archiveName !== prior) {
      fail(
        label,
        `mobileStaticDependencyArchives must use the same archive file name across both iOS targets for ${dependency}`,
      );
    }
    archiveNameByDependency.set(dependency, archiveName);
  }
  return [
    ...archiveRows.map((row) => row.slice(row.indexOf(":") + 1)),
    ...parsedDependencies.map(({ relative }) => relative),
  ];
}

function sameFileIdentity(left, right) {
  return (
    left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs
  );
}

async function snapshotRegularFile(absolute, label, maxFileBytes) {
  const before = await fs.lstat(absolute, { bigint: true });
  if (before.isSymbolicLink() || !before.isFile()) {
    fail(label, "must remain a regular file and must not be a symlink");
  }
  if (before.size > BigInt(maxFileBytes)) {
    fail(label, "exceeds the bounded member size");
  }
  let handle;
  try {
    handle = await fs.open(
      absolute,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
    );
  } catch (error) {
    fail(label, `could not be opened without following a symlink: ${error.message}`);
  }
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || !sameFileIdentity(before, opened)) {
      fail(label, "changed between path validation and opening");
    }
    const contents = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (
      !sameFileIdentity(opened, after)
      || BigInt(contents.length) !== opened.size
    ) {
      fail(label, "changed while its bytes were being read");
    }
    return {
      bytes: contents.length,
      contents,
      device: opened.dev.toString(),
      inode: opened.ino.toString(),
      mode: Number(opened.mode & 0o777n),
      sha256: createHash("sha256").update(contents).digest("hex"),
    };
  } finally {
    await handle.close();
  }
}

export async function readSafeFileSnapshot(file, label = file?.absolute ?? "file snapshot") {
  if (
    file === null
    || typeof file !== "object"
    || typeof file.absolute !== "string"
    || !Number.isSafeInteger(file.bytes)
    || file.bytes < 0
    || typeof file.device !== "string"
    || typeof file.inode !== "string"
    || !Number.isInteger(file.mode)
    || file.mode < 0
    || file.mode > 0o777
    || typeof file.sha256 !== "string"
    || !/^[a-f0-9]{64}$/u.test(file.sha256)
  ) {
    fail(label, "is not a validated file snapshot");
  }
  const current = await snapshotRegularFile(
    file.absolute,
    label,
    Math.max(file.bytes, 1),
  );
  if (
    current.bytes !== file.bytes
    || current.device !== file.device
    || current.inode !== file.inode
    || current.mode !== file.mode
    || current.sha256 !== file.sha256
  ) {
    fail(label, "changed after validation; refusing to copy unvalidated bytes");
  }
  return current.contents;
}

export async function snapshotSafeFileTree(
  root,
  label,
  {
    maxFiles = MAX_FILES,
    maxFileBytes = MAX_FILE_BYTES,
    maxTreeBytes = MAX_TREE_BYTES,
  } = {},
) {
  for (const [value, name] of [
    [maxFiles, "maxFiles"],
    [maxFileBytes, "maxFileBytes"],
    [maxTreeBytes, "maxTreeBytes"],
  ]) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      fail(label, `${name} must be a positive safe integer`);
    }
  }
  const files = [];
  const directories = [];
  const trackPortablePath = createPortablePathCollisionTracker(label);
  let totalBytes = 0;
  const visit = async (absolute, relative) => {
    if (relative !== "") {
      trackPortablePath(relative);
      canonicalRelativePath(relative, `${label} path`);
    }
    const metadata = await fs.lstat(absolute, { bigint: true });
    if (metadata.isSymbolicLink()) fail(label, `contains symlink ${relative || "."}`);
    if (metadata.isDirectory()) {
      const entries = (await fs.readdir(absolute)).sort(compareText);
      for (const entry of entries) {
        await visit(path.join(absolute, entry), relative === "" ? entry : `${relative}/${entry}`);
      }
      const after = await fs.lstat(absolute, { bigint: true });
      if (!after.isDirectory() || !sameFileIdentity(metadata, after)) {
        fail(label, `directory ${relative || "."} changed while it was being inventoried`);
      }
      if (relative !== "") {
        directories.push({
          device: after.dev.toString(),
          inode: after.ino.toString(),
          mode: Number(after.mode & 0o777n),
          relative,
        });
      }
      return;
    }
    if (!metadata.isFile()) fail(label, `contains unsupported entry ${relative}`);
    const snapshot = await snapshotRegularFile(absolute, `${label} file ${relative}`, maxFileBytes);
    totalBytes += snapshot.bytes;
    if (totalBytes > maxTreeBytes) fail(label, "exceeds the bounded expanded tree size");
    files.push({
      absolute,
      bytes: snapshot.bytes,
      device: snapshot.device,
      inode: snapshot.inode,
      mode: snapshot.mode,
      relative,
      sha256: snapshot.sha256,
    });
    if (files.length > maxFiles) fail(label, "contains too many files");
  };
  await visit(root, "");
  directories.sort((left, right) => compareText(left.relative, right.relative));
  Object.defineProperty(files, "directories", {
    configurable: false,
    enumerable: false,
    value: directories,
    writable: false,
  });
  return files;
}

function sqlOwned(fileName, canonical) {
  return (
    (canonical.createsExtension && fileName === `${canonical.sqlName}.control`)
    || (canonical.createsExtension && fileName === `${canonical.sqlName}.sql`)
    || (canonical.createsExtension
      && fileName.startsWith(`${canonical.sqlName}--`)
      && fileName.endsWith(".sql"))
    || canonical.extensionSqlFileNames.includes(fileName)
    || (fileName.endsWith(".sql")
      && canonical.extensionSqlFilePrefixes.some((prefix) => fileName.startsWith(prefix)))
  );
}

function isCanonicalInstallSql(fileName, sqlName) {
  if (fileName === `${sqlName}.sql`) return true;
  const prefix = `${sqlName}--`;
  if (!fileName.startsWith(prefix) || !fileName.endsWith(".sql")) return false;
  const version = fileName.slice(prefix.length, -".sql".length);
  return /^[0-9][A-Za-z0-9._-]*$/u.test(version) && !version.includes("--");
}

export function assertSwiftExtensionMatchesCanonical(extension, canonical, label) {
  if (canonical === undefined) fail(label, `has no generated canonical metadata for ${extension.sqlName}`);
  if (extension.product !== canonical.product) {
    fail(label, "product does not match generated canonical ownership metadata");
  }
}

export async function validateSwiftExtensionResourceArtifact({
  extension,
  canonical,
  nativeRuntime,
  label = extension.resourceRoot,
  allowMobileCarrierArchives = false,
}) {
  assertSwiftExtensionMatchesCanonical(extension, canonical, label);
  const contract = normalizeFrozenRuntimeContract(extension, `${label} frozen carrier contract`);
  if (nativeRuntime?.product !== "liboliphaunt-native" || !STABLE_SEMVER.test(nativeRuntime?.version ?? "")) {
    fail(label, "requires liboliphaunt-native at a stable X.Y.Z version");
  }
  const files = await snapshotSafeFileTree(extension.resourceRoot, label);
  const byPath = new Map(files.map((file) => [file.relative, file]));
  const manifestFile = byPath.get("manifest.properties");
  if (manifestFile === undefined) fail(label, "is missing manifest.properties");
  const properties = parseProperties(
    decodeUtf8(
      await readSafeFileSnapshot(manifestFile, manifestFile.absolute),
      manifestFile.absolute,
    ),
    manifestFile.absolute,
  );
  const expected = new Map([
    ["packageLayout", "oliphaunt-extension-artifact-v1"],
    ["pgMajor", "18"],
    ["sqlName", contract.sqlName],
    ["createsExtension", contract.createsExtension ? "yes" : "no"],
    ["nativeModuleStem", contract.nativeModuleStem ?? ""],
    ["nativeModuleFile", contract.nativeModuleStem === null ? "" : `${contract.nativeModuleStem}.dylib`],
    ["nativeTarget", "ios-xcframework"],
    ["nativeRuntimeProduct", nativeRuntime.product],
    ["nativeRuntimeVersion", nativeRuntime.version],
    ["dependencies", contract.dependencies.join(",")],
    ["dataFiles", contract.dataFiles.join(",")],
    ["extensionSqlFileNames", contract.extensionSqlFileNames.join(",")],
    ["extensionSqlFilePrefixes", contract.extensionSqlFilePrefixes.join(",")],
    ["sharedPreloadLibraries", contract.sharedPreloadLibraries.join(",")],
    ["mobilePrebuilt", contract.nativeModuleStem === null ? "no" : "yes"],
    ["files", "files"],
  ]);
  for (const [key, value] of expected) {
    if (properties.get(key) !== value) fail(label, `manifest ${key} must be ${JSON.stringify(value)}`);
  }
  const symbolPrefix = contract.nativeModuleStem === null
    ? ""
    : `oliphaunt_static_${contract.nativeModuleStem.replaceAll(/[^A-Za-z0-9_]/gu, "_")}`;
  if (properties.get("staticSymbolPrefix") !== symbolPrefix) {
    fail(label, `manifest staticSymbolPrefix must be ${JSON.stringify(symbolPrefix)}`);
  }
  const aliases = extension.registration?.symbols
    .filter(({ name, address }) => name !== address)
    .map(({ name, address }) => `${name}:${address}`)
    .sort(compareText) ?? [];
  const aliasSqlNames = aliases.map((alias) => alias.split(":")[0]);
  if (
    aliases.some((alias) => alias.split(":").length !== 2 || alias.split(":").some((item) => !C_IDENTIFIER.test(item)))
    || new Set(aliasSqlNames).size !== aliasSqlNames.length
  ) {
    fail(label, "carrier registration contains a non-C-identifier alias pair");
  }
  if (properties.get("staticSymbolAliases") !== aliases.join(",")) {
    fail(label, "manifest staticSymbolAliases do not match carrier registration metadata");
  }
  const allowed = new Set(["manifest.properties"]);
  const legalFiles = legalPaths(properties, extension, contract, label);
  for (const legalFile of legalFiles) allowed.add(legalFile);
  for (const mobilePath of mobileStaticPaths(
    properties,
    extension,
    contract,
    label,
    allowMobileCarrierArchives,
  )) {
    allowed.add(mobilePath);
  }
  const sqlPrefix = "files/share/postgresql/extension/";
  let hasControl = false;
  let hasSql = false;
  for (const file of files) {
    if (!file.relative.startsWith(sqlPrefix)) continue;
    const fileName = file.relative.slice(sqlPrefix.length);
    if (fileName.includes("/") || !sqlOwned(fileName, contract)) {
      fail(label, `contains undeclared extension SQL/control file ${file.relative}`);
    }
    allowed.add(file.relative);
    if (fileName === `${contract.sqlName}.control`) hasControl = true;
    if (isCanonicalInstallSql(fileName, contract.sqlName)) hasSql = true;
  }
  if (contract.createsExtension && (!hasControl || !hasSql)) {
    fail(label, `must contain ${contract.sqlName}.control and canonical base installation SQL`);
  }
  for (const dataFile of contract.dataFiles) allowed.add(`files/share/postgresql/${dataFile}`);
  if (contract.nativeModuleStem !== null) {
    allowed.add(`files/lib/postgresql/${contract.nativeModuleStem}.dylib`);
  }
  const actual = [...byPath.keys()].sort(compareText);
  const wanted = [...allowed].sort(compareText);
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    const undeclared = actual.filter((name) => !allowed.has(name));
    const missing = wanted.filter((name) => !byPath.has(name));
    fail(
      label,
      `leaf inventory mismatch${undeclared.length ? `; undeclared: ${undeclared.join(",")}` : ""}`
        + `${missing.length ? `; missing: ${missing.join(",")}` : ""}`,
    );
  }
  for (const legalFile of legalFiles) {
    const snapshot = byPath.get(legalFile);
    if (snapshot.bytes === 0 || (snapshot.mode & 0o111) !== 0) {
      fail(label, `legal file ${legalFile} must be non-empty and non-executable`);
    }
  }
  return {
    bytes: files
      .filter(({ relative }) => relative.startsWith("files/share/postgresql/"))
      .reduce((sum, file) => sum + file.bytes, 0),
    createsExtension: contract.createsExtension,
    files: files
      .filter(({ relative }) => relative.startsWith("files/share/postgresql/"))
      .map((file) => ({
        ...file,
        relative: file.relative.slice("files/share/postgresql/".length),
      })),
  };
}
