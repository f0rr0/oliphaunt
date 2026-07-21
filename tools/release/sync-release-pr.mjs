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
  exactExtensionProducts,
  extensionRegistryPackageTargetSets,
  typescriptOptionalRuntimePackageProducts,
} from "./release-artifact-targets.mjs";
import { compatibilityVersionEntries, loadGraph } from "./release-graph.mjs";
import {
  compatibilityEntriesForBumpedProducts,
  releasePleaseWorktreeTransitions,
  requireCompleteRuntimeLinkedTransitions,
} from "./release-please-transition.mjs";
import { extensionRegistryPackageStrings } from "./extension-registry-packages.mjs";
import { synchronizeDependentReleaseCandidates } from "./release-dependent-candidates.mjs";
import {
  releaseSemanticFingerprintPath,
  syncReleaseSemanticInputFingerprints,
} from "./release-semantic-inputs.mjs";
import { releasePleaseConfigAfterBootstrapConsumption } from "./release-please-bootstrap.mjs";
import { electronReleaseDependencies } from "../../examples/tools/example-release-dependencies.mjs";
import { captureCommandOutput } from "../dev/capture-command-output.mjs";

const PREFIX = "sync-release-pr.mjs";
const DEPENDENCY_TABLES = ["dependencies", "dev-dependencies", "build-dependencies"];
const LOCKFILES = [
  path.join(ROOT, "Cargo.lock"),
  path.join(ROOT, "src/sdks/rust/tests/release-consumer/Cargo.lock"),
];
const PNPM_LOCKFILE = path.join(ROOT, "pnpm-lock.yaml");
const RELEASE_PLEASE_CONFIG = path.join(ROOT, "release-please-config.json");
const RELEASE_PLEASE_MANIFEST = path.join(ROOT, ".release-please-manifest.json");
const ELECTRON_EXAMPLE_PACKAGE = path.join(ROOT, "examples/electron/package.json");
const PACKAGE_START_RE = /^\s*\[\[package\]\]\s*$/u;
const STRING_KEY_RE = /^\s*([A-Za-z0-9_-]+)\s*=\s*"([^"]*)"\s*(?:#.*)?$/u;
const VERSION_LINE_RE = /^(\s*version\s*=\s*)"[^"]*"(\s*(?:#.*)?)$/u;
const TOML_TABLE_RE = /^\s*\[([A-Za-z0-9_.-]+)\]\s*(?:#.*)?$/u;
const PNPM_TYPESCRIPT_OPTIONAL_RUNTIME_KEY_RE =
  /^(\s*)'(@oliphaunt\/(?:broker|liboliphaunt|node-direct|tools)-[^']+)':\s*$/u;
const PNPM_SPECIFIER_RE = /^(\s*specifier:\s*)(\S+)(\s*)$/u;
const ASSET_INPUT_FINGERPRINT_PATH = path.join(
  ROOT,
  "src/runtimes/liboliphaunt/wasix/assets/generated/asset-inputs.sha256",
);
const ASSET_INPUT_FINGERPRINT_MISMATCH_RE =
  /committed asset input fingerprint must be '([0-9a-f]+)', got '([0-9a-f]+)'/u;
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
  for (const product of exactExtensionProducts(PREFIX)) {
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

function typescriptOptionalRuntimePackages() {
  return typescriptOptionalRuntimePackageProducts(PREFIX).map(({ packageName }) => packageName);
}

async function syncTypescriptOptionalRuntimeDependencies(changes, { write }) {
  const file = path.join(ROOT, "src/sdks/js/package.json");
  const data = readJsonObject(file);
  const optional = data.optionalDependencies;
  if (optional === null || Array.isArray(optional) || typeof optional !== "object") {
    fail(`${rel(file)} must declare optionalDependencies`);
  }
  const expectedPackages = typescriptOptionalRuntimePackages();
  const expectedKeys = new Set(expectedPackages);
  const actualKeys = new Set(Object.keys(optional));
  if (!setsEqual(actualKeys, expectedKeys)) {
    fail(`${rel(file)} optionalDependencies must be exactly ${expectedPackages.join(", ")}`);
  }
  const expectedVersions = await expectedTypescriptOptionalRuntimeVersions();
  let changed = false;
  const details = [];
  for (const packageName of expectedPackages) {
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
  const expectedVersions = await expectedTypescriptOptionalRuntimeVersions();
  const lines = readText(PNPM_LOCKFILE).split(/(?<=\n)/u);
  const expectedPackages = new Set(typescriptOptionalRuntimePackages());
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
      fail(`${rel(PNPM_LOCKFILE)} contains unexpected TypeScript optional runtime package ${packageName}`);
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
    fail(`${rel(PNPM_LOCKFILE)} is missing TypeScript optional runtime package specifiers: ${missing.join(", ")}`);
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

function syncCargoPathDependencyPins(changes, { write }) {
  const localPackages = localCargoPackagesByManifest();
  for (const manifestPath of cargoManifestPaths()) {
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

function syncAssetInputFingerprint(changes, { write }) {
  const command = ["run", "-p", "xtask", "--", "assets", "input-fingerprint"];
  if (write) {
    command.push("--write");
  }
  const before = readOptionalText(ASSET_INPUT_FINGERPRINT_PATH);
  const result = captureCommandOutput("cargo", command, {
    cwd: ROOT,
    label: `cargo ${command.join(" ")}`,
  });
  const output = commandOutputForError(result);
  if (result.status !== 0) {
    const mismatch = ASSET_INPUT_FINGERPRINT_MISMATCH_RE.exec(output);
    if (!write && mismatch !== null) {
      changes.push({
        path: ASSET_INPUT_FINGERPRINT_PATH,
        detail: `${mismatch[1]} -> ${mismatch[2]}`,
      });
      return;
    }
    fail(`\`cargo ${command.join(" ")}\` failed:\n${output}`);
  }
  if (!write) {
    return;
  }
  const after = readOptionalText(ASSET_INPUT_FINGERPRINT_PATH);
  if (before !== after) {
    changes.push({
      path: ASSET_INPUT_FINGERPRINT_PATH,
      detail: `${before?.trim() ?? "<missing>"} -> ${after?.trim() ?? "<missing>"}`,
    });
  }
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

function syncDerivedReleaseSemanticFingerprints(changes, { write }) {
  const graph = loadGraph(PREFIX);
  const result = syncReleaseSemanticInputFingerprints(graph, {
    root: ROOT,
    write,
    prefix: PREFIX,
  });
  for (const change of result.changes) {
    changes.push({
      path: path.join(ROOT, change.path),
      detail: `${change.product} release-semantic fingerprint refreshed after derived release input changes`,
    });
  }
}

function parseArgs(argv) {
  const args = { check: false, generatedReleaseCheck: false };
  for (const arg of argv) {
    if (arg === "--check") {
      if (args.generatedReleaseCheck) {
        fail("--check and --check-generated-release are mutually exclusive");
      }
      args.check = true;
    } else if (arg === "--check-generated-release") {
      if (args.check) {
        fail("--check and --check-generated-release are mutually exclusive");
      }
      args.check = true;
      args.generatedReleaseCheck = true;
    } else if (arg === "--help" || arg === "-h") {
      console.log("usage: tools/release/sync-release-pr.mjs [--check|--check-generated-release]");
      process.exit(0);
    } else {
      fail(`unknown argument ${arg}`);
    }
  }
  return args;
}

async function main(argv) {
  const args = parseArgs(argv);
  const changes = [];
  const write = !args.check;
  const initialGraph = loadGraph(PREFIX);
  let products = initialGraph.products;
  let transitions = releasePleaseWorktreeTransitions(ROOT, { prefix: PREFIX });
  requireCompleteRuntimeLinkedTransitions(products, transitions, { prefix: PREFIX });
  if (transitions.length > 0) {
    const dependentCandidates = synchronizeDependentReleaseCandidates({
      root: ROOT,
      graph: loadGraph(PREFIX),
      transitions,
      releasePleaseConfig: readJsonObject(RELEASE_PLEASE_CONFIG),
      manifest: readJsonObject(RELEASE_PLEASE_MANIFEST),
      write,
      prefix: PREFIX,
    });
    changes.push(...dependentCandidates.changes);
    if (write && dependentCandidates.candidates.length > 0) {
      products = graphProducts();
      transitions = releasePleaseWorktreeTransitions(ROOT, { prefix: PREFIX });
      requireCompleteRuntimeLinkedTransitions(products, transitions, { prefix: PREFIX });
    }
  }
  syncReleasePleaseBootstrapBoundary(changes, { write });
  await syncCompatibilityVersions(changes, { write, transitions });
  syncExtensionRegistryMetadata(changes, { write });
  await syncTypescriptOptionalRuntimeDependencies(changes, { write });
  syncElectronExampleDependencies(changes, { write });
  await syncPnpmTypescriptOptionalRuntimeSpecifiers(changes, { write });
  syncCargoPathDependencyPins(changes, { write });
  syncLockfiles(changes, { write });
  if (!args.generatedReleaseCheck) {
    syncAssetInputFingerprint(changes, { write });
    syncExtensionEvidenceSummary(changes, { write });
  }
  syncDerivedReleaseSemanticFingerprints(changes, { write });

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
    ASSET_INPUT_FINGERPRINT_PATH,
    EXTENSION_EVIDENCE_SUMMARY_PATH,
    ...releaseSemanticFingerprintDerivedEntries().map(({ path: pathText }) => path.join(ROOT, pathText)),
    ...compatibilityVersionLinks().map(({ path: pathText }) => path.join(ROOT, pathText)),
    ...exactExtensionProducts(PREFIX).map((product) => path.join(ROOT, packagePath(product), "release.toml")),
    path.join(ROOT, "src/sdks/js/package.json"),
    ...cargoManifestPaths(),
  ].map(rel))].sort(compareText);
}

export function releaseSemanticFingerprintDerivedEntries() {
  const graph = loadGraph(PREFIX);
  return graph.release_semantic_inputs.products
    .map((product) => ({
      product,
      path: releaseSemanticFingerprintPath(graph, product, { prefix: PREFIX }),
    }))
    .sort((left, right) => compareText(left.path, right.path));
}

if (import.meta.main) {
  await main(Bun.argv.slice(2));
}
