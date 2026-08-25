#!/usr/bin/env bun
import {
  existsSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import {
  ROOT,
  compareText,
  currentProductVersion,
  exactExtensionReleaseProducts,
  extensionRegistryPackageTargetSets,
  nativeToolsOptionalPackageProducts,
  typescriptOptionalRuntimePackageProducts,
} from "./release-artifact-targets.mjs";
import { compatibilityVersionEntries, loadGraph } from "./release-graph.mjs";
import {
  compatibilityEntriesForBumpedProducts,
  releasePleaseWorktreeTransitions,
  sharedContribReleaseCandidates,
} from "./release-please-transition.mjs";
import { extensionRegistryPackageStrings } from "./extension-registry-packages.mjs";
import {
  EXAMPLE_CARGO_POLICIES,
  exampleCargoReleaseVersionBindings,
} from "./example-cargo-policy.mjs";
import {
  synchronizeDependentReleaseCandidates,
  synchronizeReleaseCandidates,
} from "./release-dependent-candidates.mjs";
import { releasePleaseConfigAfterBootstrapConsumption } from "./release-please-bootstrap.mjs";
import { electronReleaseDependencies } from "../../examples/tools/example-release-dependencies.mjs";
import { captureCommandOutput } from "../dev/capture-command-output.mjs";

const PREFIX = "sync-release-pr.mjs";
const DEPENDENCY_TABLES = ["dependencies", "dev-dependencies", "build-dependencies"];
const LOCKFILES = [
  path.join(ROOT, "Cargo.lock"),
];
const PNPM_LOCKFILE = path.join(ROOT, "pnpm-lock.yaml");
const RELEASE_PLEASE_CONFIG = path.join(ROOT, "release-please-config.json");
const RELEASE_PLEASE_MANIFEST = path.join(ROOT, ".release-please-manifest.json");
const ELECTRON_EXAMPLE_PACKAGE = path.join(ROOT, "examples/electron/package.json");
const NATIVE_TOOLS_FACADE_PACKAGE = path.join(
  ROOT,
  "src/runtimes/liboliphaunt/native/tools-npm/package.json",
);
const WASIX_TOOLS_FACADE_PACKAGE = path.join(
  ROOT,
  "src/bindings/wasix-ts/tools-package/package.json",
);
const WASIX_TOOLS_CARRIER_PACKAGE = "@oliphaunt/liboliphaunt-wasix-tools";
const WASIX_TYPESCRIPT_BINDING_PACKAGE = "@oliphaunt/wasix-ts";
const PACKAGE_START_RE = /^\s*\[\[package\]\]\s*$/u;
const STRING_KEY_RE = /^\s*([A-Za-z0-9_-]+)\s*=\s*"([^"]*)"\s*(?:#.*)?$/u;
const VERSION_LINE_RE = /^(\s*version\s*=\s*)"[^"]*"(\s*(?:#.*)?)$/u;
const TOML_TABLE_RE = /^\s*\[([A-Za-z0-9_.-]+)\]\s*(?:#.*)?$/u;
const PNPM_TYPESCRIPT_OPTIONAL_RUNTIME_KEY_RE =
  /^(\s*)'(@oliphaunt\/(?:(?:broker|liboliphaunt|node-direct|tools)-[^']+|wasix-ts))':\s*$/u;
const PNPM_SPECIFIER_RE = /^(\s*specifier:\s*)(\S+)(\s*)$/u;
const EXTENSION_EVIDENCE_SUMMARY_PATH = path.join(
  ROOT,
  "src/extensions/generated/docs/extension-evidence.json",
);
const EXTENSION_MODEL_CHECK_PATH = "src/extensions/tools/check-extension-model.mjs";
function fail(message) {
  console.error(`${PREFIX}: ${message}`);
  process.exit(2);
}

function rel(file) {
  const relative = path.relative(ROOT, file);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return file.split(path.sep).join("/");
  }
  return relative.split(path.sep).join("/");
}

function readText(file) {
  return readFileSync(file, "utf8");
}

function readOptionalText(file) {
  return existsSync(file) ? readText(file) : undefined;
}

function readJsonObject(file) {
  const value = JSON.parse(readText(file));
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    fail(`${rel(file)} must contain a JSON object`);
  }
  return value;
}

function jsonText(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function writeTextIfChanged(file, text, changes, detail, { write }) {
  const before = readText(file);
  if (before === text) {
    return;
  }
  changes.push({ path: file, detail });
  if (write) {
    writeFileSync(file, text, "utf8");
  }
}

function stripNewline(line) {
  if (line.endsWith("\r\n")) {
    return [line.slice(0, -2), "\r\n"];
  }
  if (line.endsWith("\n")) {
    return [line.slice(0, -1), "\n"];
  }
  return [line, ""];
}

function graphProducts() {
  return loadGraph(PREFIX).products;
}

function productConfig(product) {
  const products = graphProducts();
  const config = products[product];
  if (!config) {
    fail(`unknown release product ${JSON.stringify(product)}`);
  }
  return config;
}

function packagePath(product) {
  return productConfig(product).path;
}

function compatibilityVersionLinks() {
  return compatibilityVersionEntries(graphProducts(), { requireSourceProduct: true, prefix: PREFIX });
}

function setJsonPath(data, dotted, expected, context) {
  let current = data;
  const parts = dotted.split(".");
  for (const part of parts.slice(0, -1)) {
    if (current === null || Array.isArray(current) || typeof current !== "object" || current[part] === null || Array.isArray(current[part]) || typeof current[part] !== "object") {
      fail(`${context} is missing object path ${parts.slice(0, -1).join(".")}`);
    }
    current = current[part];
  }
  if (current === null || Array.isArray(current) || typeof current !== "object") {
    fail(`${context} is missing object path ${parts.slice(0, -1).join(".")}`);
  }
  const key = parts.at(-1);
  const actual = current[key];
  if (actual === expected) {
    return undefined;
  }
  current[key] = expected;
  return `${context} ${JSON.stringify(actual)} -> ${JSON.stringify(expected)}`;
}

function setTomlStringPath(file, dotted, expected, context) {
  const parts = dotted.split(".");
  if (parts.length < 2) {
    fail(`${context} TOML parser must use table.key dotted syntax`);
  }
  const table = parts.slice(0, -1);
  const key = parts.at(-1);
  const lines = readText(file).split(/(?<=\n)/u);
  let currentTable = [];
  let sawTable = false;
  const keyPattern = new RegExp(`^(\\s*${escapeRegExp(key)}\\s*=\\s*)"([^"]*)"(.*)$`, "u");

  for (const [index, line] of lines.entries()) {
    const [body, newline] = stripNewline(line);
    const tableMatch = TOML_TABLE_RE.exec(body);
    if (tableMatch) {
      currentTable = tableMatch[1].split(".");
      sawTable = arraysEqual(currentTable, table);
      continue;
    }
    if (!arraysEqual(currentTable, table)) {
      continue;
    }
    const keyMatch = keyPattern.exec(body);
    if (!keyMatch) {
      continue;
    }
    const actual = keyMatch[2];
    if (actual === expected) {
      return [undefined, undefined];
    }
    lines[index] = `${keyMatch[1]}"${expected}"${keyMatch[3]}${newline}`;
    return [lines.join(""), `${context} ${JSON.stringify(actual)} -> ${JSON.stringify(expected)}`];
  }

  if (sawTable) {
    fail(`${context} did not find TOML key ${JSON.stringify(key)} in ${rel(file)}`);
  }
  fail(`${context} did not find TOML table ${JSON.stringify(table.join("."))} in ${rel(file)}`);
}

function setRustConstString(file, constName, expected, context) {
  const lines = readText(file).split(/(?<=\n)/u);
  const pattern = new RegExp(`^(\\s*(?:pub\\s+)?const\\s+${escapeRegExp(constName)}\\s*:\\s*&str\\s*=\\s*)"([^"]*)"(;.*)$`, "u");
  for (const [index, line] of lines.entries()) {
    const [body, newline] = stripNewline(line);
    const match = pattern.exec(body);
    if (!match) {
      continue;
    }
    const actual = match[2];
    if (actual === expected) {
      return [undefined, undefined];
    }
    lines[index] = `${match[1]}"${expected}"${match[3]}${newline}`;
    return [lines.join(""), `${context} ${JSON.stringify(actual)} -> ${JSON.stringify(expected)}`];
  }
  fail(`${context} did not find Rust const ${JSON.stringify(constName)} in ${rel(file)}`);
}

function tomlArrayAssignment(key, values) {
  if (values.length === 1) {
    return `${key} = [${JSON.stringify(values[0])}]\n`;
  }
  return `${key} = [\n${values.map((value) => `  ${JSON.stringify(value)},\n`).join("")}]\n`;
}

function replaceTopLevelArrayAssignment(text, key, values, context) {
  const lines = text.split(/(?<=\n)/u);
  const output = [];
  let index = 0;
  let replaced = false;
  const pattern = new RegExp(`^${escapeRegExp(key)}\\s*=\\s*\\[`, "u");
  while (index < lines.length) {
    const line = lines[index];
    if (!replaced && pattern.test(line)) {
      output.push(tomlArrayAssignment(key, values));
      replaced = true;
      if (!line.includes("]")) {
        index += 1;
        while (index < lines.length && !lines[index].includes("]")) {
          index += 1;
        }
      }
      index += 1;
      continue;
    }
    output.push(line);
    index += 1;
  }
  if (!replaced) {
    fail(`${context} did not find top-level TOML array ${JSON.stringify(key)}`);
  }
  return output.join("");
}

function syncExtensionRegistryMetadata(changes, { write }) {
  const expectedPublishTargets = ["github-release-assets", "npm", "maven-central", "crates-io"];
  for (const product of exactExtensionReleaseProducts(PREFIX)) {
    const releaseToml = path.join(ROOT, packagePath(product), "release.toml");
    const expectedRegistryPackages = extensionRegistryPackageStrings({
      product,
      ...extensionRegistryPackageTargetSets(product, PREFIX),
    });
    const text = readText(releaseToml);
    let updated = replaceTopLevelArrayAssignment(text, "publish_targets", expectedPublishTargets, product);
    updated = replaceTopLevelArrayAssignment(updated, "registry_packages", expectedRegistryPackages, product);
    if (updated !== text) {
      writeTextIfChanged(releaseToml, updated, changes, "synced explicit extension registry metadata", { write });
    }
  }
}

function syncReleasePleaseBootstrapBoundary(changes, { write }) {
  const config = readJsonObject(RELEASE_PLEASE_CONFIG);
  const manifest = readJsonObject(RELEASE_PLEASE_MANIFEST);
  const updated = releasePleaseConfigAfterBootstrapConsumption(config, manifest);
  if (updated !== config) {
    writeTextIfChanged(
      RELEASE_PLEASE_CONFIG,
      jsonText(updated),
      changes,
      "removed the consumed one-time bootstrap-sha history boundary",
      { write },
    );
  }
}

async function syncCompatibilityVersions(changes, { write, transitions }) {
  const links = compatibilityEntriesForBumpedProducts(compatibilityVersionLinks(), transitions);
  for (const { id: specId, sourceProduct, path: pathText, parser } of links) {
    const file = path.join(ROOT, pathText);
    const expected = await currentProductVersion(sourceProduct, PREFIX);
    if (parser === "raw") {
      writeTextIfChanged(file, `${expected}\n`, changes, `${specId} -> ${sourceProduct} ${expected}`, { write });
      continue;
    }
    if (parser.startsWith("json:")) {
      const data = readJsonObject(file);
      const detail = setJsonPath(data, parser.split(":", 2)[1], expected, specId);
      if (detail !== undefined) {
        writeTextIfChanged(file, jsonText(data), changes, detail, { write });
      }
      continue;
    }
    if (parser.startsWith("toml:")) {
      const [text, detail] = setTomlStringPath(file, parser.split(":", 2)[1], expected, specId);
      if (text !== undefined && detail !== undefined) {
        writeTextIfChanged(file, text, changes, detail, { write });
      }
      continue;
    }
    if (parser.startsWith("rust-const:")) {
      const [text, detail] = setRustConstString(file, parser.split(":", 2)[1], expected, specId);
      if (text !== undefined && detail !== undefined) {
        writeTextIfChanged(file, text, changes, detail, { write });
      }
      continue;
    }
    fail(`${specId} uses unsupported sync parser ${JSON.stringify(parser)}`);
  }
}

async function expectedTypescriptOptionalRuntimeVersions() {
  const versions = {};
  for (const { packageName, product } of typescriptOptionalRuntimePackageProducts(PREFIX)) {
    versions[packageName] = `workspace:${await currentProductVersion(product, PREFIX)}`;
  }
  return versions;
}

async function expectedNativeToolsOptionalVersions() {
  const versions = {};
  for (const { packageName, product } of nativeToolsOptionalPackageProducts(PREFIX)) {
    versions[packageName] = `workspace:${await currentProductVersion(product, PREFIX)}`;
  }
  return versions;
}

function typescriptOptionalRuntimePackages() {
  return typescriptOptionalRuntimePackageProducts(PREFIX).map(({ packageName }) => packageName);
}

function typescriptOptionalRuntimeVersionsFromPackage() {
  return optionalRuntimeVersionsFromPackage(
    path.join(ROOT, "src/sdks/js/package.json"),
    typescriptOptionalRuntimePackages(),
  );
}

function nativeToolsOptionalVersionsFromPackage() {
  return optionalRuntimeVersionsFromPackage(
    NATIVE_TOOLS_FACADE_PACKAGE,
    nativeToolsOptionalPackageProducts(PREFIX).map(({ packageName }) => packageName),
  );
}

function wasixToolsDependencyVersionsFromPackage() {
  const data = readJsonObject(WASIX_TOOLS_FACADE_PACKAGE);
  const dependencies = data.dependencies;
  const peerDependencies = data.peerDependencies;
  const devDependencies = data.devDependencies;
  if (
    dependencies === null ||
    Array.isArray(dependencies) ||
    typeof dependencies !== "object" ||
    !setsEqual(new Set(Object.keys(dependencies)), new Set([WASIX_TOOLS_CARRIER_PACKAGE])) ||
    peerDependencies === null ||
    Array.isArray(peerDependencies) ||
    typeof peerDependencies !== "object" ||
    !setsEqual(new Set(Object.keys(peerDependencies)), new Set([WASIX_TYPESCRIPT_BINDING_PACKAGE])) ||
    devDependencies === null ||
    Array.isArray(devDependencies) ||
    typeof devDependencies !== "object" ||
    devDependencies[WASIX_TYPESCRIPT_BINDING_PACKAGE] !==
      peerDependencies[WASIX_TYPESCRIPT_BINDING_PACKAGE]
  ) {
    fail(
      `${rel(WASIX_TOOLS_FACADE_PACKAGE)} must depend only on ${WASIX_TOOLS_CARRIER_PACKAGE}, peer only with ${WASIX_TYPESCRIPT_BINDING_PACKAGE}, and develop against that peer version`,
    );
  }
  return {
    [WASIX_TOOLS_CARRIER_PACKAGE]: dependencies[WASIX_TOOLS_CARRIER_PACKAGE],
    [WASIX_TYPESCRIPT_BINDING_PACKAGE]: peerDependencies[WASIX_TYPESCRIPT_BINDING_PACKAGE],
  };
}

async function syncWasixToolsDependencies(changes, { write, transitions }) {
  if (
    !transitions.some(({ product }) =>
      product === "liboliphaunt-wasix" || product === "oliphaunt-wasix-ts"
    )
  ) {
    return;
  }
  const data = readJsonObject(WASIX_TOOLS_FACADE_PACKAGE);
  const expected = {
    [WASIX_TOOLS_CARRIER_PACKAGE]: `workspace:${await currentProductVersion("liboliphaunt-wasix", PREFIX)}`,
    [WASIX_TYPESCRIPT_BINDING_PACKAGE]: `workspace:${await currentProductVersion("oliphaunt-wasix-ts", PREFIX)}`,
  };
  const details = [];
  const carrierVersion = expected[WASIX_TOOLS_CARRIER_PACKAGE];
  const actualCarrier = data.dependencies?.[WASIX_TOOLS_CARRIER_PACKAGE];
  if (actualCarrier !== carrierVersion) {
    data.dependencies[WASIX_TOOLS_CARRIER_PACKAGE] = carrierVersion;
    details.push(
      `${WASIX_TOOLS_CARRIER_PACKAGE} ${JSON.stringify(actualCarrier)} -> ${JSON.stringify(carrierVersion)}`,
    );
  }
  const bindingVersion = expected[WASIX_TYPESCRIPT_BINDING_PACKAGE];
  for (const dependencyTable of ["peerDependencies", "devDependencies"]) {
    const actual = data[dependencyTable]?.[WASIX_TYPESCRIPT_BINDING_PACKAGE];
    if (actual !== bindingVersion) {
      data[dependencyTable][WASIX_TYPESCRIPT_BINDING_PACKAGE] = bindingVersion;
      details.push(
        `${dependencyTable}.${WASIX_TYPESCRIPT_BINDING_PACKAGE} ${JSON.stringify(actual)} -> ${JSON.stringify(bindingVersion)}`,
      );
    }
  }
  if (details.length > 0) {
    writeTextIfChanged(
      WASIX_TOOLS_FACADE_PACKAGE,
      jsonText(data),
      changes,
      details.join("; "),
      { write },
    );
  }
}

function optionalRuntimeVersionsFromPackage(file, expectedPackages) {
  const data = readJsonObject(file);
  const optional = data.optionalDependencies;
  if (optional === null || Array.isArray(optional) || typeof optional !== "object") {
    fail(`${rel(file)} must declare optionalDependencies`);
  }
  const expectedKeys = new Set(expectedPackages);
  const actualKeys = new Set(Object.keys(optional));
  if (!setsEqual(actualKeys, expectedKeys)) {
    fail(`${rel(file)} optionalDependencies must be exactly ${expectedPackages.join(", ")}`);
  }
  return Object.fromEntries(expectedPackages.map((packageName) => [packageName, optional[packageName]]));
}

export async function syncTypescriptOptionalRuntimeDependencies(
  changes,
  {
    write,
    transitions,
    packageFile = path.join(ROOT, "src/sdks/js/package.json"),
    runtimeVersions,
  },
) {
  return syncOptionalRuntimeDependencies(changes, {
    write,
    transitions,
    ownerProduct: "oliphaunt-js",
    packageFile,
    runtimeVersions,
  });
}

async function syncNativeToolsOptionalDependencies(changes, { write, transitions }) {
  return syncOptionalRuntimeDependencies(changes, {
    write,
    transitions,
    ownerProduct: "liboliphaunt-native",
    packageFile: NATIVE_TOOLS_FACADE_PACKAGE,
    runtimeVersions: await expectedNativeToolsOptionalVersions(),
  });
}

async function syncOptionalRuntimeDependencies(
  changes,
  { write, transitions, ownerProduct, packageFile, runtimeVersions },
) {
  if (!transitions.some(({ product }) => product === ownerProduct)) {
    return;
  }
  const file = packageFile;
  const data = readJsonObject(file);
  const optional = data.optionalDependencies;
  const expectedVersions = runtimeVersions ?? await expectedTypescriptOptionalRuntimeVersions();
  let changed = false;
  const details = [];
  for (const packageName of Object.keys(expectedVersions).sort(compareText)) {
    const expectedVersion = expectedVersions[packageName];
    const actual = optional[packageName];
    if (actual !== expectedVersion) {
      optional[packageName] = expectedVersion;
      changed = true;
      details.push(`${packageName} ${JSON.stringify(actual)} -> ${JSON.stringify(expectedVersion)}`);
    }
  }
  if (changed) {
    writeTextIfChanged(file, jsonText(data), changes, details.join("; "), { write });
  }
}

function syncElectronExampleDependencies(changes, { write }) {
  const data = readJsonObject(ELECTRON_EXAMPLE_PACKAGE);
  const dependencies = data.dependencies;
  if (dependencies === null || Array.isArray(dependencies) || typeof dependencies !== "object") {
    fail(`${rel(ELECTRON_EXAMPLE_PACKAGE)} must declare dependencies`);
  }

  let changed = false;
  const details = [];
  for (const { packageName, version } of electronReleaseDependencies(ROOT)) {
    const actual = dependencies[packageName];
    if (actual === undefined) {
      fail(`${rel(ELECTRON_EXAMPLE_PACKAGE)} is missing release dependency ${packageName}`);
    }
    if (actual !== version) {
      dependencies[packageName] = version;
      changed = true;
      details.push(`${packageName} ${JSON.stringify(actual)} -> ${JSON.stringify(version)}`);
    }
  }
  if (changed) {
    writeTextIfChanged(ELECTRON_EXAMPLE_PACKAGE, jsonText(data), changes, details.join("; "), { write });
  }
}

async function syncPnpmTypescriptOptionalRuntimeSpecifiers(changes, { write }) {
  const expectedVersions = {
    ...typescriptOptionalRuntimeVersionsFromPackage(),
    ...nativeToolsOptionalVersionsFromPackage(),
    ...wasixToolsDependencyVersionsFromPackage(),
  };
  const lines = readText(PNPM_LOCKFILE).split(/(?<=\n)/u);
  const expectedPackages = new Set(Object.keys(expectedVersions));
  const seen = new Set();
  const fileChanges = [];

  for (const [index, line] of lines.entries()) {
    const [body] = stripNewline(line);
    const packageMatch = PNPM_TYPESCRIPT_OPTIONAL_RUNTIME_KEY_RE.exec(body);
    if (!packageMatch) {
      continue;
    }
    const packageName = packageMatch[2];
    if (!expectedPackages.has(packageName)) {
      fail(`${rel(PNPM_LOCKFILE)} contains unexpected managed TypeScript runtime dependency ${packageName}`);
    }
    seen.add(packageName);
    const packageIndent = packageMatch[1].length;
    const expectedVersion = expectedVersions[packageName];

    let found = false;
    for (let specifierIndex = index + 1; specifierIndex < lines.length; specifierIndex += 1) {
      const [specifierBody, specifierNewline] = stripNewline(lines[specifierIndex]);
      if (specifierBody.trim()) {
        const specifierIndent = specifierBody.length - specifierBody.trimStart().length;
        if (specifierIndent <= packageIndent) {
          break;
        }
      }
      const specifierMatch = PNPM_SPECIFIER_RE.exec(specifierBody);
      if (!specifierMatch) {
        continue;
      }
      found = true;
      const actual = specifierMatch[2];
      if (actual !== expectedVersion) {
        lines[specifierIndex] = `${specifierMatch[1]}${expectedVersion}${specifierMatch[3]}${specifierNewline}`;
        fileChanges.push(`${packageName} ${JSON.stringify(actual)} -> ${JSON.stringify(expectedVersion)}`);
      }
      break;
    }
    if (!found) {
      fail(`${rel(PNPM_LOCKFILE)} is missing a specifier for ${packageName}`);
    }
  }

  const missing = [...expectedPackages].filter((name) => !seen.has(name)).sort(compareText);
  if (missing.length > 0) {
    fail(`${rel(PNPM_LOCKFILE)} is missing managed TypeScript runtime dependency specifiers: ${missing.join(", ")}`);
  }
  if (fileChanges.length > 0) {
    writeTextIfChanged(PNPM_LOCKFILE, lines.join(""), changes, fileChanges.join("; "), { write });
  }
}

export function cargoManifestPaths({
  gitCommand = "git",
  gitCommandArgs = [],
  root = ROOT,
} = {}) {
  const result = captureCommandOutput(
    gitCommand,
    [...gitCommandArgs, "ls-files", "-z", "--", "Cargo.toml", ":(glob)**/Cargo.toml"],
    {
      cwd: root,
      label: "git ls-files Cargo manifests",
      stdoutTerminator: "\0",
    },
  );
  if (result.status !== 0 || result.error !== undefined) {
    fail(`could not enumerate tracked Cargo manifests: ${commandOutputForError(result)}`);
  }
  if (result.stdout.length === 0) {
    fail("could not enumerate tracked Cargo manifests: git returned an empty inventory");
  }
  return result.stdout
    .split("\0")
    .filter(Boolean)
    .map((file) => path.join(root, file))
    .filter((file) => existsSync(file))
    .sort(compareText);
}

function localCargoPackagesByManifest() {
  const packages = new Map();
  for (const manifest of cargoManifestPaths()) {
    const data = Bun.TOML.parse(readText(manifest));
    const packageConfig = data.package;
    if (packageConfig === null || Array.isArray(packageConfig) || typeof packageConfig !== "object") {
      continue;
    }
    const name = packageConfig.name;
    const version = packageConfig.version;
    if (typeof name !== "string" || typeof version !== "string") {
      continue;
    }
    packages.set(realpathSync(manifest), [name, version]);
  }
  return packages;
}

function localCargoPackageVersions() {
  const versions = new Map();
  for (const [manifest, [name, version]] of localCargoPackagesByManifest()) {
    const existing = versions.get(name);
    if (existing !== undefined && existing !== version) {
      fail(`local Cargo package ${name} has conflicting versions including ${rel(manifest)}`);
    }
    versions.set(name, version);
  }
  return versions;
}

function iterDependencyTables(manifest) {
  const tables = [];
  for (const tableName of DEPENDENCY_TABLES) {
    const table = manifest[tableName];
    if (table !== null && !Array.isArray(table) && typeof table === "object") {
      tables.push(table);
    }
  }
  const targets = manifest.target;
  if (targets !== null && !Array.isArray(targets) && typeof targets === "object") {
    for (const target of Object.values(targets)) {
      if (target === null || Array.isArray(target) || typeof target !== "object") {
        continue;
      }
      for (const tableName of DEPENDENCY_TABLES) {
        const table = target[tableName];
        if (table !== null && !Array.isArray(table) && typeof table === "object") {
          tables.push(table);
        }
      }
    }
  }
  return tables;
}

function desiredCargoPathDependencyVersions(manifestPath, localPackages) {
  const manifest = Bun.TOML.parse(readText(manifestPath));
  const desired = new Map();
  for (const table of iterDependencyTables(manifest)) {
    for (const [dependencyName, dependency] of Object.entries(table)) {
      if (dependency === null || Array.isArray(dependency) || typeof dependency !== "object") {
        continue;
      }
      const pathValue = dependency.path;
      const versionValue = dependency.version;
      if (typeof pathValue !== "string" || typeof versionValue !== "string") {
        continue;
      }
      const dependencyManifest = path.resolve(path.dirname(manifestPath), pathValue, "Cargo.toml");
      const packageInfo = localPackages.get(realpathIfExists(dependencyManifest));
      if (packageInfo === undefined) {
        continue;
      }
      const packageVersion = packageInfo[1];
      desired.set(dependencyName, versionValue.startsWith("=") ? `=${packageVersion}` : packageVersion);
    }
  }
  return desired;
}

function syncCargoPathDependencyPins(changes, { write, transitions }) {
  const localPackages = localCargoPackagesByManifest();
  const selectedRoots = transitions
    .map(({ product }) => path.join(ROOT, packagePath(product)))
    .sort((left, right) => right.length - left.length || compareText(left, right));
  for (const manifestPath of cargoManifestPaths()) {
    if (!selectedRoots.some((root) => manifestPath === root || manifestPath.startsWith(`${root}${path.sep}`))) {
      continue;
    }
    const desired = desiredCargoPathDependencyVersions(manifestPath, localPackages);
    if (desired.size === 0) {
      continue;
    }
    const lines = readText(manifestPath).split(/(?<=\n)/u);
    const seen = new Set();
    const fileChanges = [];
    for (const [index, line] of lines.entries()) {
      const [body, newline] = stripNewline(line);
      for (const [dependencyName, expected] of desired) {
        const pattern = new RegExp(`^(\\s*${escapeRegExp(dependencyName)}\\s*=\\s*\\{[^}]*\\bversion\\s*=\\s*")([^"]+)(".*)$`, "u");
        const match = pattern.exec(body);
        if (!match) {
          continue;
        }
        seen.add(dependencyName);
        const actual = match[2];
        if (actual !== expected) {
          lines[index] = `${match[1]}${expected}${match[3]}${newline}`;
          fileChanges.push(`${dependencyName} ${JSON.stringify(actual)} -> ${JSON.stringify(expected)}`);
        }
      }
    }
    const missing = [...desired.keys()].filter((name) => !seen.has(name)).sort(compareText);
    if (missing.length > 0) {
      fail(`${rel(manifestPath)} has non-inline local path dependency pins: ${missing.join(", ")}`);
    }
    if (fileChanges.length > 0) {
      writeTextIfChanged(manifestPath, lines.join(""), changes, fileChanges.join("; "), { write });
    }
  }
}

function valueAt(root, parts) {
  let current = root;
  for (const part of parts) {
    if (current === null || typeof current !== "object") return undefined;
    current = current[part];
  }
  return current;
}

function tomlAssignmentMatchesAtPath(text, entryParts) {
  const tableParts = entryParts.slice(0, -1);
  const key = entryParts.at(-1);
  const marker = "__oliphaunt_release_sync_table__";
  const keyPattern = new RegExp(
    `^(\\s*(?:${escapeRegExp(key)}|"${escapeRegExp(key)}"|'${escapeRegExp(key)}')\\s*=\\s*)`,
    "u",
  );
  const matches = [];
  let offset = 0;
  let inTable = false;

  for (const line of text.split(/(?<=\n)/u)) {
    const [body] = stripNewline(line);
    const tableMatch = /^\s*\[([^\[\]]+)\]\s*(?:#.*)?$/u.exec(body);
    if (tableMatch !== null) {
      const parsed = Bun.TOML.parse(`[${tableMatch[1]}]\n${marker} = true\n`);
      inTable = valueAt(parsed, [...tableParts, marker]) === true;
      offset += line.length;
      continue;
    }
    if (inTable) {
      const assignment = keyPattern.exec(body);
      if (assignment !== null) {
        matches.push({
          assignmentStart: offset + assignment.index,
          valueStart: offset + assignment.index + assignment[0].length,
        });
      }
    }
    offset += line.length;
  }
  return matches;
}

function quotedTomlStringEnd(text, start) {
  const quote = text[start];
  let escaped = false;
  for (let index = start + 1; index < text.length; index += 1) {
    const character = text[index];
    if (quote === '"' && character === "\\" && !escaped) {
      escaped = true;
      continue;
    }
    if (character === quote && !escaped) return index;
    escaped = false;
  }
  return -1;
}

function inlineTomlTableEnd(text, start) {
  let depth = 0;
  let quote;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (quote !== undefined) {
      if (quote === '"' && character === "\\" && !escaped) {
        escaped = true;
        continue;
      }
      if (character === quote && !escaped) quote = undefined;
      escaped = false;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
    } else if (character === "{") {
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return -1;
}

function replaceUniqueDependencyVersion(text, binding, label) {
  const matches = tomlAssignmentMatchesAtPath(text, binding.entryParts);
  if (matches.length !== 1) {
    throw new Error(
      `${label} must declare ${binding.entryParts.join(".")} exactly once as a direct TOML assignment, found ${matches.length}`,
    );
  }
  const { valueStart } = matches[0];
  const first = text[valueStart];
  if (first === '"' || first === "'") {
    const end = quotedTomlStringEnd(text, valueStart);
    if (end === -1) throw new Error(`${label} has an unterminated version string for ${binding.name}`);
    const actual = text.slice(valueStart + 1, end);
    return {
      text: actual === binding.expected
        ? text
        : `${text.slice(0, valueStart + 1)}${binding.expected}${text.slice(end)}`,
      detail: actual === binding.expected
        ? undefined
        : `${binding.name} ${JSON.stringify(actual)} -> ${JSON.stringify(binding.expected)}`,
    };
  }
  if (first !== "{") {
    throw new Error(`${label} ${binding.name} must use a string or inline-table dependency specification`);
  }
  const end = inlineTomlTableEnd(text, valueStart);
  if (end === -1) throw new Error(`${label} has an unterminated inline table for ${binding.name}`);
  const table = text.slice(valueStart, end);
  const versionPattern = /(\bversion\s*=\s*)(?:"([^"]*)"|'([^']*)')/gu;
  const versions = [...table.matchAll(versionPattern)];
  if (versions.length !== 1) {
    throw new Error(`${label} ${binding.name} inline table must declare version exactly once, found ${versions.length}`);
  }
  const match = versions[0];
  const actual = match[2] ?? match[3];
  if (actual === binding.expected) return { text, detail: undefined };
  const quote = match[2] === undefined ? "'" : '"';
  const replacement = `${match[1]}${quote}${binding.expected}${quote}`;
  const versionStart = valueStart + match.index;
  return {
    text: `${text.slice(0, versionStart)}${replacement}${text.slice(versionStart + match[0].length)}`,
    detail: `${binding.name} ${JSON.stringify(actual)} -> ${JSON.stringify(binding.expected)}`,
  };
}

function replaceUniqueStringAssignment(text, binding, label) {
  const matches = tomlAssignmentMatchesAtPath(text, binding.entryParts);
  if (matches.length !== 1) {
    throw new Error(`${label} must declare ${binding.entryParts.join(".")} exactly once, found ${matches.length}`);
  }
  const { valueStart } = matches[0];
  const quote = text[valueStart];
  if (quote !== '"' && quote !== "'") {
    throw new Error(`${label} ${binding.name} must be a TOML string`);
  }
  const end = quotedTomlStringEnd(text, valueStart);
  if (end === -1) throw new Error(`${label} has an unterminated string for ${binding.name}`);
  const actual = text.slice(valueStart + 1, end);
  return {
    text: actual === binding.expected
      ? text
      : `${text.slice(0, valueStart + 1)}${binding.expected}${text.slice(end)}`,
    detail: actual === binding.expected
      ? undefined
      : `${binding.name} ${JSON.stringify(actual)} -> ${JSON.stringify(binding.expected)}`,
  };
}

export function syncExampleCargoManifestText(text, { policy, bindings, label = `${policy.crateDir}/Cargo.toml` }) {
  const manifest = Bun.TOML.parse(text);
  const details = [];
  let updated = text;
  for (const binding of bindings) {
    if (valueAt(manifest, binding.entryParts) === undefined) {
      throw new Error(`${label} is missing release-bound TOML path ${binding.entryParts.join(".")}`);
    }
    const result = binding.kind === "dependency"
      ? replaceUniqueDependencyVersion(updated, binding, label)
      : replaceUniqueStringAssignment(updated, binding, label);
    updated = result.text;
    if (result.detail !== undefined) details.push(result.detail);
  }
  if (policy.runtime !== undefined) {
    const actualProduct = valueAt(manifest, policy.runtime.productParts);
    if (actualProduct !== policy.runtime.product) {
      throw new Error(
        `${label} runtime uses ${JSON.stringify(actualProduct)}; expected ${policy.runtime.product}`,
      );
    }
  }
  return { text: updated, details };
}

function syncExampleCargoRegistryPins(changes, { write }) {
  const bindings = exampleCargoReleaseVersionBindings();
  for (const policy of EXAMPLE_CARGO_POLICIES) {
    const file = path.join(ROOT, policy.crateDir, "Cargo.toml");
    let result;
    try {
      result = syncExampleCargoManifestText(readText(file), {
        policy,
        bindings: bindings.filter(({ policyId }) => policyId === policy.id),
        label: rel(file),
      });
    } catch (cause) {
      fail(cause.message);
    }
    if (result.details.length > 0) {
      writeTextIfChanged(file, result.text, changes, result.details.join("; "), { write });
    }
  }
}

function stringKey(line, key) {
  const [body] = stripNewline(line);
  const match = STRING_KEY_RE.exec(body);
  return match?.[1] === key ? match[2] : undefined;
}

function packageBlockRanges(lines) {
  const starts = lines.flatMap((line, index) => (PACKAGE_START_RE.test(line) ? [index] : []));
  return starts.map((start, index) => [start, index + 1 < starts.length ? starts[index + 1] : lines.length]);
}

function replaceVersionLine(line, version) {
  const [body, newline] = stripNewline(line);
  const match = VERSION_LINE_RE.exec(body);
  if (!match) {
    fail(`cannot update Cargo.lock version line: ${line.trimEnd()}`);
  }
  return `${match[1]}"${version}"${match[2]}${newline}`;
}

export function syncLockfile(lockfile, versions, changes, { write }) {
  const data = Bun.TOML.parse(readText(lockfile));
  if (!Array.isArray(data.package)) {
    fail(`${rel(lockfile)} is missing [[package]] entries`);
  }
  const lines = readText(lockfile).split(/(?<=\n)/u);
  const fileChanges = [];
  for (const [start, end] of packageBlockRanges(lines)) {
    const block = lines.slice(start, end);
    let name;
    let versionIndex;
    let currentVersion;
    let hasSource = false;
    for (const [offset, line] of block.entries()) {
      if (stringKey(line, "source") !== undefined) {
        hasSource = true;
      }
      const keyName = stringKey(line, "name");
      if (keyName !== undefined) {
        name = keyName;
      }
      const keyVersion = stringKey(line, "version");
      if (keyVersion !== undefined) {
        versionIndex = start + offset;
        currentVersion = keyVersion;
      }
    }
    if (!versions.has(name) || hasSource) {
      continue;
    }
    if (versionIndex === undefined || currentVersion === undefined) {
      fail(`${rel(lockfile)} package ${name} is missing version`);
    }
    const expectedVersion = versions.get(name);
    if (currentVersion !== expectedVersion) {
      lines[versionIndex] = replaceVersionLine(lines[versionIndex], expectedVersion);
      fileChanges.push(`${name} ${currentVersion} -> ${expectedVersion}`);
    }
  }
  if (fileChanges.length > 0) {
    writeTextIfChanged(lockfile, lines.join(""), changes, fileChanges.join("; "), { write });
  }
}

function syncLockfiles(changes, { write }) {
  const versions = localCargoPackageVersions();
  for (const lockfile of LOCKFILES) {
    syncLockfile(lockfile, versions, changes, { write });
  }
}

function commandOutputForError(result) {
  const parts = [result.error?.message, result.stdout, result.stderr]
    .map((value) => String(value ?? "").trim())
    .filter(Boolean);
  return parts.join("\n") || `exit ${result.status}`;
}

export function extensionEvidenceSummaryCommand({ write }) {
  return [
    process.execPath,
    EXTENSION_MODEL_CHECK_PATH,
    write ? "--write-evidence-summary" : "--check",
  ];
}

function evidenceSummarySourceDigest(text) {
  if (text === undefined) {
    return "<missing>";
  }
  try {
    const parsed = JSON.parse(text);
    return typeof parsed?.["source-digest"] === "string"
      ? parsed["source-digest"]
      : "<invalid>";
  } catch {
    return "<invalid>";
  }
}

function syncExtensionEvidenceSummary(changes, { write }) {
  const command = extensionEvidenceSummaryCommand({ write });
  const before = readOptionalText(EXTENSION_EVIDENCE_SUMMARY_PATH);
  const result = captureCommandOutput(command[0], command.slice(1), {
    cwd: ROOT,
    label: command.join(" "),
  });
  const output = commandOutputForError(result);
  if (result.status !== 0) {
    const operation = write
      ? "refreshing the deterministic extension evidence summary"
      : "validating the extension model and deterministic evidence summary";
    fail(
      `failed while ${operation}; summary regeneration reads but never rewrites the claim matrix ` +
        `or immutable observed evidence runs:\n${output}`,
    );
  }
  if (!write) {
    return;
  }
  const after = readOptionalText(EXTENSION_EVIDENCE_SUMMARY_PATH);
  if (after === undefined) {
    fail(
      `${EXTENSION_MODEL_CHECK_PATH} --write-evidence-summary succeeded without creating ` +
        rel(EXTENSION_EVIDENCE_SUMMARY_PATH),
    );
  }
  if (before !== after) {
    changes.push({
      path: EXTENSION_EVIDENCE_SUMMARY_PATH,
      detail:
        `deterministic source digest ${evidenceSummarySourceDigest(before)} -> ` +
        evidenceSummarySourceDigest(after),
    });
  }
}

function parseArgs(argv) {
  const args = {
    bootstrapSharedContrib: false,
    check: false,
    generatedReleaseCheck: false,
    normalCheck: false,
    sharedContribStatus: false,
  };
  for (const arg of argv) {
    if (arg === "--check") {
      if (args.generatedReleaseCheck) {
        fail("--check and --check-generated-release are mutually exclusive");
      }
      args.check = true;
      args.normalCheck = true;
    } else if (arg === "--check-generated-release") {
      if (args.check) {
        fail("--check and --check-generated-release are mutually exclusive");
      }
      args.check = true;
      args.generatedReleaseCheck = true;
    } else if (arg === "--bootstrap-shared-contrib") {
      args.bootstrapSharedContrib = true;
    } else if (arg === "--shared-contrib-status") {
      args.check = true;
      args.sharedContribStatus = true;
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        "usage: tools/release/sync-release-pr.mjs " +
        "[--check|--check-generated-release|--bootstrap-shared-contrib|--shared-contrib-status]",
      );
      process.exit(0);
    } else {
      fail(`unknown argument ${arg}`);
    }
  }
  const modes = [
    args.generatedReleaseCheck,
    args.bootstrapSharedContrib,
    args.sharedContribStatus,
    args.normalCheck,
  ].filter(Boolean);
  if (modes.length > 1) fail("release sync modes are mutually exclusive");
  return args;
}

export function sharedContribBootstrapRequired(transitions, discoverCandidates) {
  if (transitions.length > 0) return false;
  return discoverCandidates().length > 0;
}

async function main(argv) {
  const args = parseArgs(argv);
  const changes = [];
  const write = !args.check;
  let transitions = releasePleaseWorktreeTransitions(ROOT, { prefix: PREFIX });
  let graph = loadGraph(PREFIX);
  if (args.bootstrapSharedContrib && transitions.length > 0) {
    fail("--bootstrap-shared-contrib requires main release state with no existing manifest transition");
  }
  if (args.sharedContribStatus) {
    const required = sharedContribBootstrapRequired(
      transitions,
      () => sharedContribReleaseCandidates(ROOT, graph, [], {
        headRef: "HEAD",
        prefix: PREFIX,
      }),
    );
    console.log(`required=${String(required)}`);
    return;
  }
  const bridgeSharedContrib = transitions.length > 0
    || args.bootstrapSharedContrib;
  const sharedContribCandidates = bridgeSharedContrib
    ? sharedContribReleaseCandidates(ROOT, graph, transitions, {
      headRef: transitions.length > 0 ? "HEAD^" : "HEAD",
      prefix: PREFIX,
    })
    : [];
  if (args.bootstrapSharedContrib && sharedContribCandidates.length === 0) {
    fail("--bootstrap-shared-contrib found no unreleased shared contrib source change");
  }
  if (sharedContribCandidates.length > 0) {
    changes.push(...synchronizeReleaseCandidates({
      root: ROOT,
      graph,
      candidates: sharedContribCandidates,
      releasePleaseConfig: readJsonObject(RELEASE_PLEASE_CONFIG),
      manifest: readJsonObject(RELEASE_PLEASE_MANIFEST),
      write,
      prefix: PREFIX,
    }));
    if (write) {
      transitions = releasePleaseWorktreeTransitions(ROOT, { prefix: PREFIX });
      graph = loadGraph(PREFIX);
    }
  }
  if (transitions.length > 0) {
    const dependentCandidates = synchronizeDependentReleaseCandidates({
      root: ROOT,
      graph,
      transitions,
      releasePleaseConfig: readJsonObject(RELEASE_PLEASE_CONFIG),
      manifest: readJsonObject(RELEASE_PLEASE_MANIFEST),
      write,
      prefix: PREFIX,
    });
    changes.push(...dependentCandidates.changes);
    if (write && dependentCandidates.candidates.length > 0) {
      transitions = releasePleaseWorktreeTransitions(ROOT, { prefix: PREFIX });
    }
  }
  syncReleasePleaseBootstrapBoundary(changes, { write });
  await syncCompatibilityVersions(changes, { write, transitions });
  syncExtensionRegistryMetadata(changes, { write });
  await syncTypescriptOptionalRuntimeDependencies(changes, { write, transitions });
  await syncNativeToolsOptionalDependencies(changes, { write, transitions });
  await syncWasixToolsDependencies(changes, { write, transitions });
  syncElectronExampleDependencies(changes, { write });
  await syncPnpmTypescriptOptionalRuntimeSpecifiers(changes, { write });
  syncCargoPathDependencyPins(changes, { write, transitions });
  syncExampleCargoRegistryPins(changes, { write });
  syncLockfiles(changes, { write });
  if (!args.generatedReleaseCheck) {
    syncExtensionEvidenceSummary(changes, { write });
  }
  if (changes.length === 0) {
    console.log("release PR derived files are in sync");
    return;
  }
  for (const change of changes) {
    console.error(`${rel(change.path)}: ${change.detail}`);
  }
  if (args.check) {
    console.error("release PR derived files are stale; run `tools/release/sync-release-pr.mjs`");
    process.exit(1);
  }
  console.log("updated release PR derived files");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function arraysEqual(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function setsEqual(left, right) {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

function realpathIfExists(file) {
  try {
    return realpathSync(file);
  } catch {
    return file;
  }
}

export function releaseDerivedPathInventory() {
  return [...new Set([
    ...LOCKFILES,
    PNPM_LOCKFILE,
    RELEASE_PLEASE_CONFIG,
    ELECTRON_EXAMPLE_PACKAGE,
    EXTENSION_EVIDENCE_SUMMARY_PATH,
    ...compatibilityVersionLinks().map(({ path: pathText }) => path.join(ROOT, pathText)),
    ...exactExtensionReleaseProducts(PREFIX).map((product) => path.join(ROOT, packagePath(product), "release.toml")),
    path.join(ROOT, "src/sdks/js/package.json"),
    ...cargoManifestPaths(),
  ].map(rel))].sort(compareText);
}

if (import.meta.main) {
  await main(Bun.argv.slice(2));
}
