#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TOOL = "validate-mobile-runtime-files.mjs";
const BASELINE_EXTENSION_SQL_NAMES = new Set(["plpgsql"]);
const PORTABLE_SQL_NAME = /^[A-Za-z0-9_-]{1,128}$/u;
const PORTABLE_SQL_FILE_NAME = /^[A-Za-z0-9_.-]{1,256}\.sql$/u;
const PORTABLE_SQL_FILE_PREFIX = /^[A-Za-z0-9_-]{1,128}$/u;

function fail(message) {
  throw new Error(`${TOOL}: ${message}`);
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalStringList(value, label, predicate = () => true) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !predicate(item))) {
    fail(`${label} must be an array of valid strings`);
  }
  const canonical = [...new Set(value)].sort(compareText);
  if (JSON.stringify(value) !== JSON.stringify(canonical)) {
    fail(`${label} must be sorted in ordinal order without duplicates`);
  }
  return canonical;
}

function portableRelativePath(value) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\\") || path.posix.isAbsolute(value)) {
    return false;
  }
  const segments = value.split("/");
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function extensionContracts(document, label) {
  if (!document || typeof document !== "object" || !Array.isArray(document.extensions)) {
    fail(`${label} must contain an extensions array`);
  }
  const contracts = [];
  const seen = new Set();
  for (const [index, row] of document.extensions.entries()) {
    const rowLabel = `${label} extensions[${index}]`;
    const sqlName = row?.["sql-name"];
    if (typeof sqlName !== "string" || !PORTABLE_SQL_NAME.test(sqlName)) {
      fail(`${rowLabel}.sql-name must be a portable SQL extension name`);
    }
    if (seen.has(sqlName)) fail(`${label} contains duplicate SQL extension ${sqlName}`);
    seen.add(sqlName);
    if (typeof row["creates-extension"] !== "boolean") {
      fail(`${rowLabel}.creates-extension must be boolean`);
    }
    contracts.push({
      createsExtension: row["creates-extension"],
      dataFiles: canonicalStringList(
        row["data-files"],
        `${rowLabel}.data-files`,
        portableRelativePath,
      ),
      extensionSqlFileNames: canonicalStringList(
        row["extension-sql-file-names"],
        `${rowLabel}.extension-sql-file-names`,
        (value) => PORTABLE_SQL_FILE_NAME.test(value) && path.posix.basename(value) === value,
      ),
      extensionSqlFilePrefixes: canonicalStringList(
        row["extension-sql-file-prefixes"],
        `${rowLabel}.extension-sql-file-prefixes`,
        (value) => PORTABLE_SQL_FILE_PREFIX.test(value),
      ),
      sqlName,
    });
  }
  return contracts;
}

function registryDataFileOwners(document, contracts, label) {
  if (!document || typeof document !== "object" || !Array.isArray(document.modules)) {
    fail(`${label} must contain a modules array`);
  }
  const contractsBySqlName = new Map(contracts.map((contract) => [contract.sqlName, contract]));
  const registryBySqlName = new Map();
  const ownersByDataFile = new Map();
  for (const [index, row] of document.modules.entries()) {
    const rowLabel = `${label} modules[${index}]`;
    const sqlName = row?.["sql-name"];
    if (typeof sqlName !== "string" || !contractsBySqlName.has(sqlName)) {
      fail(`${rowLabel}.sql-name must identify a generated React Native extension`);
    }
    if (registryBySqlName.has(sqlName)) fail(`${label} contains duplicate module ${sqlName}`);
    const dataFiles = canonicalStringList(
      row["data-files"],
      `${rowLabel}.data-files`,
      portableRelativePath,
    );
    registryBySqlName.set(sqlName, dataFiles);
    for (const dataFile of dataFiles) {
      const owners = ownersByDataFile.get(dataFile) ?? [];
      owners.push(sqlName);
      ownersByDataFile.set(dataFile, owners);
    }
  }
  for (const contract of contracts) {
    const registryFiles = registryBySqlName.get(contract.sqlName) ?? [];
    if (JSON.stringify(registryFiles) !== JSON.stringify(contract.dataFiles)) {
      fail(
        `${label} data-file inventory for ${contract.sqlName} differs from generated React Native metadata`,
      );
    }
  }
  return ownersByDataFile;
}

function isBaselineExtensionAsset(fileName) {
  for (const sqlName of BASELINE_EXTENSION_SQL_NAMES) {
    if (fileName === `${sqlName}.control`) return true;
    if (fileName.startsWith(`${sqlName}--`) && fileName.endsWith(".sql")) return true;
  }
  return false;
}

function ownsExtensionAsset(contract, fileName) {
  return (
    (contract.createsExtension && fileName === `${contract.sqlName}.control`)
    || (contract.createsExtension && fileName === `${contract.sqlName}.sql`)
    || (contract.createsExtension
      && fileName.startsWith(`${contract.sqlName}--`)
      && fileName.endsWith(".sql"))
    || contract.extensionSqlFileNames.includes(fileName)
    || (fileName.endsWith(".sql")
      && contract.extensionSqlFilePrefixes.some((prefix) => fileName.startsWith(prefix)))
  );
}

function isCanonicalInstallSql(fileName, sqlName) {
  const prefix = `${sqlName}--`;
  if (!fileName.startsWith(prefix) || !fileName.endsWith(".sql")) return false;
  const version = fileName.slice(prefix.length, -".sql".length);
  return /^[0-9][A-Za-z0-9._-]*$/u.test(version) && !version.includes("--");
}

function extensionSqlVersion(value) {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value) && !value.includes("--");
}

function canonicalUpdateEdge(fileName, sqlName) {
  const prefix = `${sqlName}--`;
  if (!fileName.startsWith(prefix) || !fileName.endsWith(".sql")) return null;
  const versions = fileName.slice(prefix.length, -".sql".length).split("--");
  return versions.length === 2 && versions.every(extensionSqlVersion) ? versions : null;
}

function selectedSqlNames(value) {
  if (typeof value !== "string") fail("selected extensions must be a string");
  const names = value.split(",").map((item) => item.trim()).filter(Boolean);
  if (names.some((name) => !PORTABLE_SQL_NAME.test(name))) {
    fail("--selected must contain portable comma-separated SQL extension names");
  }
  if (new Set(names).size !== names.length) fail("--selected must not contain duplicates");
  return new Set(names);
}

function controlDefaultVersion(control, sqlName, label) {
  const values = [];
  for (const [index, rawLine] of control.split(/\r?\n/u).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || !/^default_version(?:\s|=)/u.test(line)) continue;
    const match = line.match(/^default_version\s*=\s*'([^']+)'\s*(?:#.*)?$/u);
    if (match === null || !extensionSqlVersion(match[1])) {
      fail(`${label} has invalid default_version on line ${index + 1}`);
    }
    values.push(match[1]);
  }
  if (values.length > 1) fail(`${label} must not repeat default_version for ${sqlName}`);
  return values[0] ?? null;
}

export function runtimePathsFromFileList(contents) {
  const paths = new Set();
  for (const rawLine of contents.split(/\r?\n/u)) {
    const line = rawLine.trim().replaceAll("\\", "/");
    if (!line || line.endsWith("/")) continue;
    const marker = "runtime/files/";
    const markerIndex = line.indexOf(marker);
    if (markerIndex === -1) continue;
    const relative = line.slice(markerIndex + marker.length);
    if (!portableRelativePath(relative)) fail(`file list contains unsafe runtime path: ${rawLine}`);
    paths.add(relative);
  }
  return paths;
}

export function runtimePathsFromDirectory(root) {
  if (!fs.statSync(root, { throwIfNoEntry: false })?.isDirectory()) {
    fail(`runtime root is not a directory: ${root}`);
  }
  const paths = new Set();
  const pending = [[root, ""]];
  while (pending.length > 0) {
    const [directory, relativeDirectory] = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const relative = relativeDirectory
        ? `${relativeDirectory}/${entry.name}`
        : entry.name;
      if (!portableRelativePath(relative)) fail(`runtime root contains unsafe path: ${relative}`);
      if (entry.isDirectory()) {
        pending.push([path.join(directory, entry.name), relative]);
      } else {
        paths.add(relative);
      }
    }
  }
  return paths;
}

export function validateMobileRuntimeFiles({
  metadata,
  metadataLabel = "generated React Native metadata",
  platform,
  registry,
  registryLabel = "generated mobile static registry",
  runtimePaths,
  runtimeRoot = undefined,
  selected,
}) {
  if (typeof platform !== "string" || platform.length === 0) fail("platform label must be non-empty");
  if (!(runtimePaths instanceof Set) || [...runtimePaths].some((item) => !portableRelativePath(item))) {
    fail("runtimePaths must be a set of portable runtime-relative file paths");
  }
  const contracts = extensionContracts(metadata, metadataLabel);
  const contractsBySqlName = new Map(contracts.map((contract) => [contract.sqlName, contract]));
  const selectedNames = selectedSqlNames(selected);
  for (const sqlName of selectedNames) {
    if (!contractsBySqlName.has(sqlName)) {
      fail(`${platform} selected extension is absent from generated React Native metadata: ${sqlName}`);
    }
  }
  const dataFileOwners = registryDataFileOwners(registry, contracts, registryLabel);
  const selectedState = new Map(
    [...selectedNames].map((sqlName) => [sqlName, {
      control: false,
      installVersions: new Set(),
      sqlFileNames: new Set(),
    }]),
  );
  const extensionRoot = "share/postgresql/extension/";
  for (const relative of [...runtimePaths].sort(compareText)) {
    if (!relative.startsWith(extensionRoot)) continue;
    const fileName = relative.slice(extensionRoot.length);
    if (!fileName || fileName.includes("/")) {
      fail(`${platform} runtime contains a nested PostgreSQL extension asset: ${relative}`);
    }
    if (!fileName.endsWith(".control") && !fileName.endsWith(".sql")) {
      fail(`${platform} runtime includes unsupported PostgreSQL extension asset: ${relative}`);
    }
    if (isBaselineExtensionAsset(fileName)) continue;
    const owners = contracts.filter((contract) => ownsExtensionAsset(contract, fileName));
    if (owners.length === 0) {
      fail(`${platform} runtime includes undeclared PostgreSQL extension asset: ${relative}`);
    }
    if (owners.length !== 1) {
      fail(
        `${platform} runtime PostgreSQL extension asset has ambiguous ownership: ${relative} `
        + `(${owners.map((owner) => owner.sqlName).sort(compareText).join(",")})`,
      );
    }
    const owner = owners[0];
    if (!selectedNames.has(owner.sqlName)) {
      fail(`${platform} app includes unselected PostgreSQL extension asset: ${relative}`);
    }
    const state = selectedState.get(owner.sqlName);
    if (fileName === `${owner.sqlName}.control`) state.control = true;
    if (fileName.startsWith(`${owner.sqlName}--`) && fileName.endsWith(".sql")) {
      state.sqlFileNames.add(fileName);
    }
    if (isCanonicalInstallSql(fileName, owner.sqlName)) {
      state.installVersions.add(
        fileName.slice(`${owner.sqlName}--`.length, -".sql".length),
      );
    }
  }
  for (const sqlName of selectedNames) {
    const contract = contractsBySqlName.get(sqlName);
    if (!contract.createsExtension) continue;
    const state = selectedState.get(sqlName);
    if (!state.control) fail(`${platform} app is missing selected ${sqlName} extension control file`);
    if (state.installVersions.size === 0) {
      fail(`${platform} app is missing selected ${sqlName} canonical install SQL file`);
    }
    if (runtimeRoot !== undefined) {
      const controlPath = path.join(
        runtimeRoot,
        "share/postgresql/extension",
        `${sqlName}.control`,
      );
      const defaultVersion = controlDefaultVersion(
        fs.readFileSync(controlPath, "utf8"),
        sqlName,
        `${platform} runtime ${sqlName}.control`,
      );
      const reachable = new Set(state.installVersions);
      const updates = new Map();
      for (const fileName of state.sqlFileNames) {
        const edge = canonicalUpdateEdge(fileName, sqlName);
        if (edge === null) continue;
        const [from, to] = edge;
        const targets = updates.get(from) ?? new Set();
        targets.add(to);
        updates.set(from, targets);
      }
      const pending = [...reachable].sort(compareText);
      for (let index = 0; index < pending.length; index += 1) {
        for (const next of [...(updates.get(pending[index]) ?? [])].sort(compareText)) {
          if (reachable.has(next)) continue;
          reachable.add(next);
          pending.push(next);
        }
      }
      if (defaultVersion !== null && !reachable.has(defaultVersion)) {
        fail(
          `${platform} runtime selected ${sqlName} default_version=${defaultVersion} `
          + "is unreachable from its canonical install SQL files",
        );
      }
    }
  }
  for (const [dataFile, owners] of dataFileOwners) {
    const selectedOwners = owners.filter((owner) => selectedNames.has(owner));
    const present = runtimePaths.has(dataFile);
    if (selectedOwners.length > 0 && !present) {
      fail(
        `${platform} app is missing selected ${selectedOwners.join(",")} extension data file: ${dataFile}`,
      );
    }
    if (selectedOwners.length === 0 && present) {
      fail(`${platform} app includes unselected ${owners.join(",")} extension data file: ${dataFile}`);
    }
  }
}

function parseArgs(argv) {
  const options = new Map();
  const valued = new Set([
    "--file-list",
    "--metadata",
    "--platform",
    "--registry",
    "--runtime-root",
    "--selected",
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "-h" || flag === "--help") {
      process.stdout.write(
        `usage: ${TOOL} --metadata FILE --registry FILE --selected CSV --platform LABEL `
        + "(--runtime-root DIR | --file-list FILE)\n",
      );
      process.exit(0);
    }
    if (!valued.has(flag) || index + 1 >= argv.length || options.has(flag)) {
      fail(`invalid or repeated argument: ${flag}`);
    }
    options.set(flag, argv[index + 1]);
    index += 1;
  }
  for (const flag of ["--metadata", "--registry", "--selected", "--platform"]) {
    if (!options.has(flag)) fail(`missing required argument ${flag}`);
  }
  if (options.has("--runtime-root") === options.has("--file-list")) {
    fail("exactly one of --runtime-root or --file-list is required");
  }
  return options;
}

function readJson(file, label) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    fail(`cannot read ${label} ${file}: ${error.message}`);
  }
}

function main(argv) {
  const options = parseArgs(argv);
  const metadataPath = options.get("--metadata");
  const registryPath = options.get("--registry");
  const runtimeRoot = options.get("--runtime-root");
  const runtimePaths = runtimeRoot !== undefined
    ? runtimePathsFromDirectory(runtimeRoot)
    : runtimePathsFromFileList(fs.readFileSync(options.get("--file-list"), "utf8"));
  validateMobileRuntimeFiles({
    metadata: readJson(metadataPath, "metadata"),
    metadataLabel: metadataPath,
    platform: options.get("--platform"),
    registry: readJson(registryPath, "registry"),
    registryLabel: registryPath,
    runtimePaths,
    runtimeRoot,
    selected: options.get("--selected"),
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
