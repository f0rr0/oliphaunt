#!/usr/bin/env bun

import { createHash } from "node:crypto";
import {
  existsSync,
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const EXAMPLE_CARGO_REGISTRY_INDEX = "https://cargo.oliphaunt.invalid/index";
export const EXAMPLE_CARGO_REGISTRY_SOURCE = `registry+${EXAMPLE_CARGO_REGISTRY_INDEX}`;

const CARGO_PACKAGE_NAME = /^[A-Za-z0-9_-]+$/u;
const CARGO_VERSION = /^\d+[.]\d+[.]\d+(?:-[0-9A-Za-z.-]+)?(?:[+][0-9A-Za-z.-]+)?$/u;
const HEX_SHA256 = /^[0-9a-f]{64}$/u;
const HASH_BUFFER_BYTES = 1024 * 1024;

function registryError(message) {
  return new Error(`example-cargo-registry.mjs: ${message}`);
}

function tomlString(value) {
  return JSON.stringify(value);
}

function sha256File(file) {
  const hash = createHash("sha256");
  const descriptor = openSync(file, "r");
  const buffer = Buffer.allocUnsafe(HASH_BUFFER_BYTES);
  try {
    while (true) {
      const bytes = readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytes === 0) break;
      hash.update(buffer.subarray(0, bytes));
    }
  } finally {
    closeSync(descriptor);
  }
  return hash.digest("hex");
}

export function cargoIndexRelativePath(crateName) {
  const name = crateName.toLowerCase();
  if (name.length === 1) return path.join("1", name);
  if (name.length === 2) return path.join("2", name);
  if (name.length === 3) return path.join("3", name[0], name);
  return path.join(name.slice(0, 2), name.slice(2, 4), name);
}

function cratePrefix(name, lower = false) {
  const value = lower ? name.toLowerCase() : name;
  if (value.length === 1) return "1";
  if (value.length === 2) return "2";
  if (value.length === 3) return `3/${value[0]}`;
  return `${value.slice(0, 2)}/${value.slice(2, 4)}`;
}

function parseIndexRow(file, line, lineNumber) {
  let row;
  try {
    row = JSON.parse(line);
  } catch (error) {
    throw registryError(`${file}:${lineNumber} is not valid JSON: ${error.message}`);
  }
  if (
    row === null ||
    typeof row !== "object" ||
    typeof row.name !== "string" ||
    !CARGO_PACKAGE_NAME.test(row.name) ||
    typeof row.vers !== "string" ||
    !CARGO_VERSION.test(row.vers) ||
    !Array.isArray(row.deps) ||
    row.features === null ||
    typeof row.features !== "object" ||
    Array.isArray(row.features) ||
    !HEX_SHA256.test(row.cksum ?? "") ||
    row.yanked !== false
  ) {
    throw registryError(`${file}:${lineNumber} contains an invalid candidate Cargo index row`);
  }
  return row;
}

export function candidateRegistryPackages(indexDirectory) {
  const indexDir = path.resolve(indexDirectory);
  if (!existsSync(indexDir) || !statSync(indexDir).isDirectory()) {
    throw registryError(`missing local Cargo registry index: ${indexDir}`);
  }
  const configFile = path.join(indexDir, "config.json");
  if (!existsSync(configFile)) {
    throw registryError(`candidate Cargo registry is missing ${configFile}`);
  }
  const configStat = lstatSync(configFile);
  if (!configStat.isFile() || configStat.isSymbolicLink()) {
    throw registryError(`candidate Cargo registry config must be a regular non-symlink file: ${configFile}`);
  }

  const packages = [];
  const pending = [indexDir];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === ".git" || (directory === indexDir && entry.name === "config.json")) continue;
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw registryError(`candidate Cargo index must not contain symlink ${file}`);
      }
      if (entry.isDirectory()) {
        pending.push(file);
        continue;
      }
      if (!entry.isFile()) {
        throw registryError(`candidate Cargo index contains unsupported entry ${file}`);
      }
      const lines = readFileSync(file, "utf8").split(/\n/u);
      for (let index = 0; index < lines.length; index += 1) {
        if (lines[index].trim().length === 0) continue;
        const row = parseIndexRow(file, lines[index], index + 1);
        const actualPath = path.relative(indexDir, file);
        const expectedPath = cargoIndexRelativePath(row.name);
        if (actualPath !== expectedPath) {
          throw registryError(`${file}:${index + 1} contains ${row.name}, expected index path ${expectedPath}`);
        }
        packages.push(row);
      }
    }
  }
  packages.sort((left, right) => `${left.name}\0${left.vers}`.localeCompare(`${right.name}\0${right.vers}`));
  if (packages.length === 0) {
    throw registryError(`candidate Cargo registry ${indexDir} contains no packages`);
  }

  const identities = new Set();
  const versionsByName = new Map();
  for (const row of packages) {
    const identity = `${row.name}@${row.vers}`;
    if (identities.has(identity)) {
      throw registryError(`candidate Cargo registry contains duplicate ${identity}`);
    }
    identities.add(identity);
    const previous = versionsByName.get(row.name);
    if (previous !== undefined && previous !== row.vers) {
      throw registryError(
        `candidate Cargo registry contains multiple versions for ${row.name}: ${previous} and ${row.vers}`,
      );
    }
    versionsByName.set(row.name, row.vers);
  }
  return packages;
}

function readDownloadTemplate(indexDirectory) {
  const configPath = path.join(path.resolve(indexDirectory), "config.json");
  let config;
  try {
    config = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (error) {
    throw registryError(`cannot read ${configPath}: ${error.message}`);
  }
  if (typeof config.dl !== "string" || !config.dl.startsWith("file://")) {
    throw registryError(`${configPath} must use an exact local file:// download template`);
  }
  return config.dl;
}

export function candidateRegistryArchivePath(indexDirectory, entry) {
  const template = readDownloadTemplate(indexDirectory);
  const url = template
    .replaceAll("{crate}", entry.name)
    .replaceAll("{version}", entry.vers)
    .replaceAll("{prefix}", cratePrefix(entry.name))
    .replaceAll("{lowerprefix}", cratePrefix(entry.name, true))
    .replaceAll("{sha256-checksum}", entry.cksum);
  if (/[{}]/u.test(url)) {
    throw registryError(`unsupported placeholder in candidate Cargo download template ${template}`);
  }
  try {
    const archive = path.resolve(fileURLToPath(url));
    const cratesDirectory = path.resolve(indexDirectory, "..", "crates");
    if (archive !== cratesDirectory && !archive.startsWith(`${cratesDirectory}${path.sep}`)) {
      throw registryError(
        `candidate Cargo archive ${archive} escapes sibling crates directory ${cratesDirectory}`,
      );
    }
    return archive;
  } catch (error) {
    if (error.message.startsWith("example-cargo-registry.mjs:")) throw error;
    throw registryError(`invalid candidate Cargo archive URL ${url}: ${error.message}`);
  }
}

export function verifyCandidateRegistryPackage(indexDirectory, entry) {
  const cratePath = candidateRegistryArchivePath(indexDirectory, entry);
  if (!existsSync(cratePath) || !statSync(cratePath).isFile()) {
    throw registryError(`candidate registry is missing ${entry.name}@${entry.vers} archive ${cratePath}`);
  }
  const cratesDirectory = path.resolve(indexDirectory, "..", "crates");
  if (!existsSync(cratesDirectory) || !statSync(cratesDirectory).isDirectory()) {
    throw registryError(`candidate registry is missing sibling crates directory ${cratesDirectory}`);
  }
  const realCratesDirectory = realpathSync(cratesDirectory);
  const realIndexDirectory = realpathSync(path.resolve(indexDirectory));
  const expectedRealCratesDirectory = path.join(path.dirname(realIndexDirectory), "crates");
  if (realCratesDirectory !== expectedRealCratesDirectory) {
    throw registryError(
      `candidate Cargo crates directory ${cratesDirectory} resolves outside candidate registry root ${path.dirname(realIndexDirectory)}`,
    );
  }
  const realArchive = realpathSync(cratePath);
  if (realArchive !== realCratesDirectory && !realArchive.startsWith(`${realCratesDirectory}${path.sep}`)) {
    throw registryError(
      `candidate Cargo archive ${cratePath} resolves outside sibling crates directory ${realCratesDirectory}`,
    );
  }
  const actual = sha256File(cratePath);
  if (actual !== entry.cksum) {
    throw registryError(
      `candidate registry ${entry.name}@${entry.vers} index checksum ${entry.cksum} does not match archive ${actual}`,
    );
  }
  return cratePath;
}

export function candidateRegistryDigest(packages) {
  const canonical = [...packages]
    .sort((left, right) => `${left.name}\0${left.vers}`.localeCompare(`${right.name}\0${right.vers}`))
    .map((entry) => `${entry.name}\0${entry.vers}\0${entry.cksum}\n`)
    .join("");
  return createHash("sha256").update(canonical).digest("hex");
}

function normalizedPatchPackages(packages) {
  const normalized = packages.map((entry) => ({
    name: entry?.name,
    version: entry?.vers ?? entry?.version,
  }));
  const versions = new Map();
  for (const entry of normalized) {
    if (!CARGO_PACKAGE_NAME.test(entry.name ?? "") || typeof entry.version !== "string" || !CARGO_VERSION.test(entry.version)) {
      throw registryError("candidate patch packages must declare valid name and version strings");
    }
    const previous = versions.get(entry.name);
    if (previous !== undefined) {
      const detail = previous === entry.version ? `duplicate ${entry.name}@${entry.version}` :
        `multiple versions for ${entry.name}: ${previous} and ${entry.version}`;
      throw registryError(`candidate patch packages contain ${detail}`);
    }
    versions.set(entry.name, entry.version);
  }
  return normalized.sort((left, right) => left.name.localeCompare(right.name));
}

export function exampleCargoCandidatePatchConfig(packages) {
  const normalized = normalizedPatchPackages(packages);
  if (normalized.length === 0) return "";
  return [
    "[patch.crates-io]",
    ...normalized.map((entry) =>
      `${tomlString(entry.name)} = { version = ${tomlString(`=${entry.version}`)}, registry = "oliphaunt-local" }`
    ),
    "",
  ].join("\n");
}

export function exampleCargoRegistryConfig(indexDirectory, { candidatePackages = [] } = {}) {
  const registryIndex = pathToFileURL(path.resolve(indexDirectory)).href;
  return [
    "[registries.oliphaunt-local]",
    `index = ${tomlString(EXAMPLE_CARGO_REGISTRY_INDEX)}`,
    "",
    "[source.oliphaunt-local]",
    `registry = ${tomlString(EXAMPLE_CARGO_REGISTRY_INDEX)}`,
    'replace-with = "oliphaunt-local-staged"',
    "",
    "[source.oliphaunt-local-staged]",
    `registry = ${tomlString(registryIndex)}`,
    "",
    exampleCargoCandidatePatchConfig(candidatePackages),
  ].filter((part) => part.length > 0).join("\n");
}

export function configureExampleCargoRegistry({ cargoHome, indexDirectory, candidatePackages = [] }) {
  if (!existsSync(indexDirectory)) {
    throw registryError(`missing local Cargo registry index: ${indexDirectory}`);
  }
  mkdirSync(cargoHome, { recursive: true });
  const config = path.join(cargoHome, "config.toml");
  const temporary = `${config}.tmp-${process.pid}`;
  writeFileSync(temporary, exampleCargoRegistryConfig(indexDirectory, { candidatePackages }));
  renameSync(temporary, config);
  return config;
}

function fail(message) {
  console.error(registryError(message).message);
  process.exit(1);
}

function option(args, name) {
  const index = args.indexOf(name);
  if (index === -1 || index + 1 >= args.length) {
    fail(`${name} is required`);
  }
  return args[index + 1];
}

function main(args) {
  const command = args.shift();
  if (command !== "configure") {
    fail("usage: example-cargo-registry.mjs configure --cargo-home PATH --index PATH [--patch-candidates]");
  }
  const cargoHome = path.resolve(option(args, "--cargo-home"));
  const indexDirectory = path.resolve(option(args, "--index"));
  const patchCandidates = args.includes("--patch-candidates");
  const unknown = args.filter((arg, index) => {
    if (arg === "--cargo-home" || arg === "--index") return false;
    if (index > 0 && (args[index - 1] === "--cargo-home" || args[index - 1] === "--index")) return false;
    return arg !== "--patch-candidates";
  });
  if (unknown.length > 0) fail(`unknown arguments: ${unknown.join(" ")}`);
  const candidatePackages = patchCandidates ? candidateRegistryPackages(indexDirectory) : [];
  configureExampleCargoRegistry({ cargoHome, indexDirectory, candidatePackages });
  process.stdout.write(`${EXAMPLE_CARGO_REGISTRY_INDEX}\n`);
}

if (import.meta.main) {
  try {
    main(Bun.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
