#!/usr/bin/env bun
import { createHash } from "node:crypto";
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { inflateRawSync } from "node:zlib";

import {
  ROOT,
  allArtifactTargets,
  compareText,
  currentProductVersion,
  exactExtensionProducts,
  extensionArtifactTargets,
  extensionMetadata,
  extensionSourceIdentity,
} from "./release-artifact-targets.mjs";
import { loadGraph } from "./release-graph.mjs";
import {
  assertSameNativeTargetSet,
  rustNativeTargetCfg,
} from "./rust-native-targets.mjs";
import {
  AOT_PACKAGES as WASIX_AOT_PACKAGES,
  AOT_TARGET_CFGS as WASIX_AOT_TARGET_CFGS,
  AOT_TARGET_TRIPLES as WASIX_AOT_TARGET_TRIPLES,
  ICU_PACKAGE,
  RUNTIME_PACKAGE as WASIX_RUNTIME_PACKAGE,
  TOOLS_AOT_PACKAGES as WASIX_TOOLS_AOT_PACKAGES,
  TOOLS_PACKAGE as WASIX_TOOLS_PACKAGE,
} from "./wasix-cargo-artifact-contract.mjs";

const PREFIX = "check-staged-artifacts.mjs";
const SDK_ROOT = path.join(ROOT, "target/sdk-artifacts");
const EXTENSION_ROOT = path.join(ROOT, "target/extension-artifacts");
const MOBILE_ROOT = path.join(ROOT, "target/mobile-build/react-native");
const SWIFT_SOURCE_FIXTURE_REPOSITORY_ROOT = path.join(
  ROOT,
  "src/sdks/swift/Tests/Fixtures/swiftpm-extension-resources",
);
const SWIFT_SOURCE_FIXTURE_ARCHIVE_ROOT = "package/Tests/Fixtures/swiftpm-extension-resources";

const PUBLIC_EXTENSION_RELEASE_MANIFEST_KEYS = new Set([
  "schema",
  "product",
  "version",
  "sqlName",
  "extensionClass",
  "versioning",
  "sourceIdentity",
  "compatibility",
  "createsExtension",
  "dependencies",
  "nativeDependencies",
  "nativeModuleStem",
  "iosNativeDependencies",
  "iosRegistration",
  "sharedPreloadLibraries",
  "mobileReleaseReady",
  "desktopReleaseReady",
  "assets",
]);
const PUBLIC_EXTENSION_RELEASE_ASSET_KEYS = new Set([
  "name",
  "family",
  "target",
  "kind",
  "identity",
  "sha256",
  "bytes",
]);
const PUBLIC_EXTENSION_RELEASE_ASSET_KEY_ORDER = [
  "name",
  "family",
  "target",
  "kind",
  "identity",
  "sha256",
  "bytes",
];
const SDK_RUNTIME_PAYLOAD_PATTERNS = [
  /(^|\/)assets\/oliphaunt\/runtime\//u,
  /(^|\/)assets\/oliphaunt\/template-pgdata\//u,
  /(^|\/)assets\/oliphaunt\/static-registry\/archives\//u,
  /(^|\/)oliphaunt\/runtime\/files\//u,
  /(^|\/)runtime\/files\/share\/postgresql\//u,
  /(^|\/)share\/postgresql\/extension\/[^/]+\.(control|sql)$/u,
  /(^|\/)release-assets\//u,
  /(^|\/)extension-artifacts\.json$/u,
  /(^|\/)liboliphaunt\.(so|dylib|dll|a|lib)$/u,
  /(^|\/)liboliphaunt_extensions\.(so|dylib|dll|a|lib)$/u,
  /(^|\/)liboliphaunt_extension_[^/]+\.(so|dylib|dll|a|lib)$/u,
  /\.xcframework(\/|$)/u,
];
const KOTLIN_ALLOWED_NATIVE_PAYLOADS = new Set(["liboliphaunt_kotlin_android.so"]);
const KOTLIN_RELEASE_ABIS = new Set(["arm64-v8a", "x86_64"]);
const BASELINE_POSTGRES_EXTENSIONS = new Set(["plpgsql"]);

function fail(message) {
  console.error(`${PREFIX}: ${message}`);
  process.exit(1);
}

function rel(file) {
  const relative = path.relative(ROOT, String(file));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return String(file).split(path.sep).join("/");
  }
  return relative.split(path.sep).join("/");
}

function isFile(file) {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

function isDirectory(file) {
  try {
    return statSync(file).isDirectory();
  } catch {
    return false;
  }
}

function sha256File(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function readJson(file) {
  let data;
  try {
    data = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    fail(`${rel(file)} is not valid JSON: ${error.message}`);
  }
  if (data === null || Array.isArray(data) || typeof data !== "object") {
    fail(`${rel(file)} must contain a JSON object`);
  }
  return data;
}

function readPropertiesText(text) {
  const parsed = {};
  for (const raw of text.split(/\r?\n/u)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const equals = line.indexOf("=");
    if (equals < 0) {
      fail(`invalid properties line: ${JSON.stringify(raw)}`);
    }
    parsed[line.slice(0, equals)] = line.slice(equals + 1);
  }
  return parsed;
}

function csvValues(value) {
  if (!value) {
    return [];
  }
  return String(value).split(",").map((item) => item.trim()).filter(Boolean);
}

function runCapture(command, args, label) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: "buffer",
    maxBuffer: 100 * 1024 * 1024,
  });
  if (result.status !== 0) {
    const stderr = result.stderr.toString("utf8").trim();
    fail(`${label} failed${stderr ? `: ${stderr}` : ""}`);
  }
  return result.stdout;
}

function archiveTarNames(file) {
  const output = runCapture("tar", ["-tf", file], `${rel(file)} tar listing`).toString("utf8");
  return output.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line && !line.endsWith("/")).sort(compareText);
}

function tarReadText(file, member) {
  return runCapture("tar", ["-xOf", file, member], `${rel(file)} ${member}`).toString("utf8");
}

function cargoCrateManifest(file) {
  const manifests = archiveTarNames(file).filter((name) => name.split("/").length === 2 && name.endsWith("/Cargo.toml"));
  if (manifests.length !== 1) {
    fail(`${rel(file)} must contain exactly one top-level Cargo.toml`);
  }
  let data;
  try {
    data = Bun.TOML.parse(tarReadText(file, manifests[0]));
  } catch (error) {
    fail(`${rel(file)} contains an invalid Cargo.toml: ${error.message}`);
  }
  if (data === null || Array.isArray(data) || typeof data !== "object") {
    fail(`${rel(file)} Cargo.toml must contain a TOML table`);
  }
  return data;
}

function checkedArchiveMember(name, archive) {
  const normalized = name.replaceAll("\\", "/");
  const parts = normalized.split("/").filter((part) => part && part !== ".");
  if (parts.length === 0) {
    return null;
  }
  if (normalized.startsWith("/") || parts.includes("..")) {
    fail(`${rel(archive)} contains unsafe archive member ${JSON.stringify(name)}`);
  }
  return parts.join("/");
}

function findEndOfCentralDirectory(buffer, file) {
  for (let offset = buffer.length - 22; offset >= Math.max(0, buffer.length - 65557); offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) {
      return offset;
    }
  }
  fail(`${rel(file)} is missing zip end of central directory`);
}

function zipEntryData(buffer, file, offset, compressedSize, method) {
  if (buffer.readUInt32LE(offset) !== 0x04034b50) {
    fail(`${rel(file)} has an invalid zip local file header`);
  }
  const nameLength = buffer.readUInt16LE(offset + 26);
  const extraLength = buffer.readUInt16LE(offset + 28);
  const dataStart = offset + 30 + nameLength + extraLength;
  const compressed = buffer.subarray(dataStart, dataStart + compressedSize);
  if (method === 0) {
    return compressed;
  }
  if (method === 8) {
    return inflateRawSync(compressed);
  }
  fail(`${rel(file)} contains unsupported zip compression method ${method}`);
}

function readZipEntries(file) {
  const buffer = readFileSync(file);
  const eocd = findEndOfCentralDirectory(buffer, file);
  const total = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let index = 0; index < total; index += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) {
      fail(`${rel(file)} has an invalid zip central directory`);
    }
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const size = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const externalAttributes = buffer.readUInt32LE(offset + 38);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const rawName = buffer.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    const name = checkedArchiveMember(rawName, file);
    if (name) {
      entries.set(name, {
        size,
        isFile: !rawName.endsWith("/") && (externalAttributes & 0x10) === 0,
        isDirectory: rawName.endsWith("/") || (externalAttributes & 0x10) !== 0,
        data: () => zipEntryData(buffer, file, localOffset, compressedSize, method),
      });
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function archiveZipNames(file) {
  return [...readZipEntries(file)]
    .filter(([, entry]) => entry.isFile)
    .map(([name]) => name)
    .sort(compareText);
}

function zipReadText(file, name) {
  const entry = readZipEntries(file).get(name);
  if (!entry || !entry.isFile) {
    fail(`${rel(file)} is missing ${name}`);
  }
  try {
    return Buffer.from(entry.data()).toString("utf8");
  } catch (error) {
    fail(`${rel(file)} member ${name} is not readable UTF-8: ${error.message}`);
  }
}

function validateZstdArchiveMagic(file) {
  if (!readFileSync(file).subarray(0, 4).equals(Buffer.from([0x28, 0xb5, 0x2f, 0xfd]))) {
    fail(`${rel(file)} is not a zstd archive`);
  }
}

function validateReleaseArchivePayload(file) {
  if (file.endsWith(".tar.gz") || file.endsWith(".tgz") || file.endsWith(".crate")) {
    if (archiveTarNames(file).length === 0) {
      fail(`${rel(file)} must contain at least one file`);
    }
    return;
  }
  if (file.endsWith(".zip") || file.endsWith(".aar") || file.endsWith(".jar")) {
    if (archiveZipNames(file).length === 0) {
      fail(`${rel(file)} must contain at least one file`);
    }
    return;
  }
  if (file.endsWith(".tar.zst")) {
    validateZstdArchiveMagic(file);
  }
}

function directoryNames(root) {
  const result = [];
  const visit = (dir) => {
    if (!isDirectory(dir)) {
      return;
    }
    for (const name of readdirSync(dir).sort(compareText)) {
      const file = path.join(dir, name);
      if (isDirectory(file)) {
        visit(file);
      } else if (isFile(file)) {
        result.push(relFrom(root, file));
      }
    }
  };
  visit(root);
  return result.sort(compareText);
}

function relFrom(root, file) {
  return path.relative(root, file).split(path.sep).join("/");
}

function pathBytes(file) {
  if (isFile(file)) {
    return statSync(file).size;
  }
  if (isDirectory(file)) {
    let total = 0;
    for (const name of directoryNames(file)) {
      total += statSync(path.join(file, ...name.split("/"))).size;
    }
    return total;
  }
  fail(`missing path while measuring bytes: ${rel(file)}`);
}

function dirReadText(root, name) {
  const file = path.join(root, ...name.split("/"));
  if (!isFile(file)) {
    fail(`${rel(root)} is missing ${name}`);
  }
  return readFileSync(file, "utf8");
}

function graphProducts() {
  return loadGraph(PREFIX).products;
}

function productConfig(product) {
  const config = graphProducts()[product];
  if (!config) {
    fail(`unknown release product ${product}`);
  }
  return config;
}

function sdkProducts() {
  return Object.entries(graphProducts())
    .filter(([, config]) => config.kind === "sdk")
    .map(([product]) => product)
    .sort(compareText);
}

function publicAotCargoDependencies() {
  return Object.fromEntries(
    Object.entries(WASIX_AOT_PACKAGES).map(([target, name]) => [
      WASIX_AOT_TARGET_CFGS[WASIX_AOT_TARGET_TRIPLES[target]],
      name,
    ]),
  );
}

function publicToolsAotCargoDependencies() {
  return Object.fromEntries(
    Object.entries(WASIX_TOOLS_AOT_PACKAGES).map(([target, name]) => [
      WASIX_AOT_TARGET_CFGS[WASIX_AOT_TARGET_TRIPLES[target]],
      name,
    ]),
  );
}

function exactSortedStrings(label, actual, expected) {
  const actualSorted = [...actual].sort(compareText);
  const expectedSorted = [...expected].sort(compareText);
  if (JSON.stringify(actualSorted) !== JSON.stringify(expectedSorted)) {
    fail(`${label} mismatch: expected=${JSON.stringify(expectedSorted)}, actual=${JSON.stringify(actualSorted)}`);
  }
}

function rustSdkArtifactTargets(product, kind, surface) {
  return allArtifactTargets({ product, kind, surface, publishedOnly: true }, PREFIX);
}

function requireRegistryTargetDependency(crate, dependencies, cfg, name, version) {
  const dependency = dependencies[name];
  if (
    dependency === null
    || Array.isArray(dependency)
    || typeof dependency !== "object"
    || dependency.version !== `=${version}`
    || ["path", "git", "registry"].some((key) => key in dependency)
  ) {
    fail(
      `${rel(crate)} target dependency ${cfg}:${name} must use registry version `
      + `=${version} without path, git, or alternate-registry metadata`,
    );
  }
}

async function validateRustSdkCrate(crate) {
  const manifest = cargoCrateManifest(crate);
  const packageConfig = manifest.package;
  if (packageConfig === null || Array.isArray(packageConfig) || typeof packageConfig !== "object") {
    fail(`${rel(crate)} must declare a Cargo package`);
  }
  const packageName = packageConfig.name;
  if (!["oliphaunt", "oliphaunt-build"].includes(packageName)) {
    fail(`${rel(crate)} contains unexpected oliphaunt-rust package ${JSON.stringify(packageName)}`);
  }
  const sdkVersion = await currentProductVersion("oliphaunt-rust", PREFIX);
  if (packageConfig.version !== sdkVersion) {
    fail(`${rel(crate)} package ${packageName} must use oliphaunt-rust version ${sdkVersion}`);
  }
  if (packageName === "oliphaunt-build") {
    return packageName;
  }

  const nativeTargets = rustSdkArtifactTargets("liboliphaunt-native", "native-runtime", "rust-native-direct");
  const toolsTargets = rustSdkArtifactTargets("liboliphaunt-native", "native-tools", "rust-native-direct");
  const brokerTargets = rustSdkArtifactTargets("oliphaunt-broker", "broker-helper", "rust-broker");
  const targetIds = nativeTargets.map((target) => target.target);
  try {
    assertSameNativeTargetSet(
      "staged oliphaunt Rust SDK native runtime/tools",
      targetIds,
      toolsTargets.map((target) => target.target),
    );
    assertSameNativeTargetSet(
      "staged oliphaunt Rust SDK native runtime/broker",
      targetIds,
      brokerTargets.map((target) => target.target),
    );
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }

  const targetTables = manifest.target;
  if (targetTables === null || Array.isArray(targetTables) || typeof targetTables !== "object") {
    fail(`${rel(crate)} oliphaunt package must declare target-specific native release dependencies`);
  }
  const expectedCfgs = targetIds.map((target) => `cfg(${rustNativeTargetCfg(target)})`);
  exactSortedStrings(`${rel(crate)} native target tables`, Object.keys(targetTables), expectedCfgs);

  const [nativeVersion, brokerVersion] = await Promise.all([
    currentProductVersion("liboliphaunt-native", PREFIX),
    currentProductVersion("oliphaunt-broker", PREFIX),
  ]);
  for (const target of nativeTargets) {
    const cfg = `cfg(${rustNativeTargetCfg(target)})`;
    const table = targetTables[cfg];
    const dependencies = table && typeof table === "object" && !Array.isArray(table)
      ? table.dependencies
      : null;
    if (dependencies === null || Array.isArray(dependencies) || typeof dependencies !== "object") {
      fail(`${rel(crate)} target table ${cfg} must declare release dependencies`);
    }
    const expectedDependencies = [
      `liboliphaunt-native-${target.target}`,
      "oliphaunt-tools",
      `oliphaunt-broker-${target.target}`,
    ];
    exactSortedStrings(
      `${rel(crate)} target dependencies for ${cfg}`,
      Object.keys(dependencies),
      expectedDependencies,
    );
    requireRegistryTargetDependency(crate, dependencies, cfg, expectedDependencies[0], nativeVersion);
    requireRegistryTargetDependency(crate, dependencies, cfg, expectedDependencies[1], nativeVersion);
    requireRegistryTargetDependency(crate, dependencies, cfg, expectedDependencies[2], brokerVersion);
  }

  const sourceMembers = archiveTarNames(crate).filter((name) => name.endsWith("/src/lib.rs"));
  if (sourceMembers.length !== 1) {
    fail(`${rel(crate)} oliphaunt package must contain exactly one src/lib.rs`);
  }
  const source = tarReadText(crate, sourceMembers[0]);
  for (const fragment of [
    "Generated release-only native target guard.",
    "compile_error!",
    "oliphaunt-wasix",
    ...targetIds,
  ]) {
    if (!source.includes(fragment)) {
      fail(`${rel(crate)} oliphaunt release source is missing ${JSON.stringify(fragment)}`);
    }
  }
  return packageName;
}

async function validateWasixSdkCrate(crate) {
  const manifest = cargoCrateManifest(crate);
  const packageConfig = manifest.package;
  if (packageConfig === null || Array.isArray(packageConfig) || typeof packageConfig !== "object" || packageConfig.name !== "oliphaunt-wasix") {
    fail(`${rel(crate)} must package the oliphaunt-wasix crate`);
  }
  const runtimeVersion = await currentProductVersion("liboliphaunt-wasix", PREFIX);
  const dependencies = manifest.dependencies;
  if (dependencies === null || Array.isArray(dependencies) || typeof dependencies !== "object") {
    fail(`${rel(crate)} must declare Cargo dependencies`);
  }
  for (const name of [WASIX_RUNTIME_PACKAGE, WASIX_TOOLS_PACKAGE, ICU_PACKAGE].sort(compareText)) {
    const dependency = dependencies[name];
    if (dependency === null || Array.isArray(dependency) || typeof dependency !== "object" || dependency.version !== `=${runtimeVersion}` || "path" in dependency) {
      fail(`${rel(crate)} dependency ${name} must use registry version =${runtimeVersion} without a path`);
    }
  }
  const targetTables = manifest.target;
  if (targetTables === null || Array.isArray(targetTables) || typeof targetTables !== "object") {
    fail(`${rel(crate)} must declare target-specific WASIX AOT dependencies`);
  }
  const expectedTargets = new Map();
  for (const [cfg, name] of Object.entries(publicAotCargoDependencies())) {
    if (!expectedTargets.has(cfg)) {
      expectedTargets.set(cfg, []);
    }
    expectedTargets.get(cfg).push(name);
  }
  for (const [cfg, name] of Object.entries(publicToolsAotCargoDependencies())) {
    if (!expectedTargets.has(cfg)) {
      expectedTargets.set(cfg, []);
    }
    expectedTargets.get(cfg).push(name);
  }
  for (const [cfg, crates] of [...expectedTargets].sort(([left], [right]) => compareText(left, right))) {
    const target = targetTables[cfg];
    const targetDependencies = target && typeof target === "object" && !Array.isArray(target) ? (target.dependencies ?? {}) : {};
    for (const name of crates.sort(compareText)) {
      const dependency = targetDependencies[name];
      if (dependency === null || Array.isArray(dependency) || typeof dependency !== "object" || dependency.version !== `=${runtimeVersion}` || "path" in dependency) {
        fail(`${rel(crate)} target dependency ${cfg}:${name} must use registry version =${runtimeVersion} without a path`);
      }
    }
  }
}

function generatedExtensionRows() {
  const metadata = path.join(ROOT, "src/extensions/generated/sdk/react-native.json");
  const data = readJson(metadata);
  const rows = data.extensions;
  if (!Array.isArray(rows)) {
    fail(`${rel(metadata)} must contain an extensions array`);
  }
  const result = new Map();
  for (const row of rows) {
    if (row && typeof row === "object" && !Array.isArray(row)) {
      const sqlName = row["sql-name"];
      if (typeof sqlName === "string" && sqlName) {
        result.set(sqlName, row);
      }
    }
  }
  return result;
}

function createsExtension(sqlName, rows) {
  const row = rows.get(sqlName);
  if (!row) {
    fail(`selected extension ${JSON.stringify(sqlName)} is missing from generated extension metadata`);
  }
  return row["creates-extension"] !== false;
}

function nativeModuleStem(sqlName, rows) {
  const row = rows.get(sqlName);
  if (!row) {
    fail(`selected extension ${JSON.stringify(sqlName)} is missing from generated extension metadata`);
  }
  return typeof row["native-module-stem"] === "string" ? row["native-module-stem"] : "";
}

function nativeModuleExtensions(selected, rows) {
  return selected
    .filter((extension) => {
      const stem = nativeModuleStem(extension, rows);
      return stem && stem !== "-";
    })
    .sort(compareText);
}

function extensionNameForAsset(pathName) {
  const name = path.basename(pathName);
  if (name.endsWith(".control")) {
    return name.slice(0, -".control".length);
  }
  if (name.includes("--") && name.endsWith(".sql")) {
    return name.split("--", 1)[0];
  }
  return null;
}

export function findSdkRuntimePayloadViolation(product, names, allowedNames = new Set()) {
  for (const name of names) {
    if (allowedNames.has(name)) {
      continue;
    }
    const basename = path.basename(name);
    if (product === "oliphaunt-kotlin" && KOTLIN_ALLOWED_NATIVE_PAYLOADS.has(basename)) {
      continue;
    }
    for (const pattern of SDK_RUNTIME_PAYLOAD_PATTERNS) {
      if (pattern.test(name)) {
        return name;
      }
    }
  }
  return null;
}

function rejectSdkRuntimePayload(product, artifact, names, allowedNames = new Set()) {
  const violation = findSdkRuntimePayloadViolation(product, names, allowedNames);
  if (violation !== null) {
    fail(`${product} SDK artifact ${rel(artifact)} must not include runtime/extension payload ${violation}`);
  }
}

export function validateSwiftSourceFixtureEntries(artifact, entries) {
  if (!(entries instanceof Map)) {
    throw new Error(`${rel(artifact)} Swift source fixture entries must be a Map`);
  }
  if (!isDirectory(SWIFT_SOURCE_FIXTURE_REPOSITORY_ROOT)) {
    throw new Error(
      `${rel(artifact)} cannot validate Swift source fixtures because `
      + `${rel(SWIFT_SOURCE_FIXTURE_REPOSITORY_ROOT)} is missing`,
    );
  }

  const prefix = `${SWIFT_SOURCE_FIXTURE_ARCHIVE_ROOT}/`;
  const expectedNames = directoryNames(SWIFT_SOURCE_FIXTURE_REPOSITORY_ROOT)
    .map((name) => `${prefix}${name}`)
    .sort(compareText);
  const actualNames = [...entries]
    .filter(([name, entry]) => name.startsWith(prefix) && entry.isFile)
    .map(([name]) => name)
    .sort(compareText);
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
    const expected = new Set(expectedNames);
    const actual = new Set(actualNames);
    const missing = expectedNames.filter((name) => !actual.has(name));
    const extra = actualNames.filter((name) => !expected.has(name));
    throw new Error(
      `${rel(artifact)} Swift source fixture file set must exactly match `
      + `${rel(SWIFT_SOURCE_FIXTURE_REPOSITORY_ROOT)}; missing=${JSON.stringify(missing)}, `
      + `extra=${JSON.stringify(extra)}`,
    );
  }

  for (const archiveName of expectedNames) {
    const repositoryName = archiveName.slice(prefix.length);
    const repositoryFile = path.join(
      SWIFT_SOURCE_FIXTURE_REPOSITORY_ROOT,
      ...repositoryName.split("/"),
    );
    const actual = Buffer.from(entries.get(archiveName).data());
    const expected = readFileSync(repositoryFile);
    if (!actual.equals(expected)) {
      throw new Error(
        `${rel(artifact)} Swift source fixture ${archiveName} must byte-for-byte match `
        + rel(repositoryFile),
      );
    }
  }

  return new Set(expectedNames);
}

function validateKotlinAndroidAar(artifact, names) {
  const presentAbis = new Set(
    names
      .map((name) => name.split("/"))
      .filter((parts) => parts.length === 3 && parts[0] === "jni" && parts[2] === "liboliphaunt_kotlin_android.so")
      .map((parts) => parts[1]),
  );
  if (presentAbis.size !== KOTLIN_RELEASE_ABIS.size || [...presentAbis].some((abi) => !KOTLIN_RELEASE_ABIS.has(abi))) {
    fail(
      `Kotlin Android release AAR ${rel(artifact)} must contain JNI adapters for ` +
        `${[...KOTLIN_RELEASE_ABIS].sort(compareText).join(", ")}; got ${[...presentAbis].sort(compareText).join(", ") || "(none)"}`,
    );
  }
}

async function checkSdkProduct(product, { require }) {
  const root = path.join(SDK_ROOT, product);
  if (!existsSync(root)) {
    if (require) {
      fail(`missing staged SDK artifacts for ${product} under ${rel(root)}`);
    }
    return false;
  }
  let checked = false;
  if (["oliphaunt-js", "oliphaunt-react-native"].includes(product)) {
    const tarballs = readdirSync(root).filter((name) => name.endsWith(".tgz")).map((name) => path.join(root, name)).sort(compareText);
    if (tarballs.length === 0 && require) {
      fail(`${product} must stage an npm tarball under ${rel(root)}`);
    }
    for (const tarball of tarballs) {
      rejectSdkRuntimePayload(product, tarball, archiveTarNames(tarball));
      checked = true;
    }
  } else if (product === "oliphaunt-swift") {
    const archives = readdirSync(root).filter((name) => name.endsWith(".zip")).map((name) => path.join(root, name)).sort(compareText);
    if (archives.length === 0 && require) {
      fail(`${product} must stage a source zip under ${rel(root)}`);
    }
    for (const archive of archives) {
      const entries = readZipEntries(archive);
      const names = [...entries]
        .filter(([, entry]) => entry.isFile)
        .map(([name]) => name)
        .sort(compareText);
      let allowedFixtureNames;
      try {
        allowedFixtureNames = validateSwiftSourceFixtureEntries(archive, entries);
      } catch (error) {
        fail(error instanceof Error ? error.message : String(error));
      }
      rejectSdkRuntimePayload(product, archive, names, allowedFixtureNames);
      checked = true;
    }
    const releaseManifest = path.join(root, "Package.swift.release");
    if (!existsSync(releaseManifest) && require) {
      fail(`${product} must stage ${rel(releaseManifest)} for release installation`);
    }
    if (existsSync(releaseManifest)) {
      const text = readFileSync(releaseManifest, "utf8");
      if (text.includes("file://")) {
        fail(`${rel(releaseManifest)} must not contain local file URLs`);
      }
      if (!text.includes("liboliphaunt-native-v") || !text.includes("checksum:")) {
        fail(`${rel(releaseManifest)} must reference checksummed public liboliphaunt assets`);
      }
    }
  } else if (product === "oliphaunt-kotlin") {
    const mavenRoot = path.join(root, "maven");
    if (!isDirectory(mavenRoot)) {
      if (require) {
        fail(`${product} must stage a Maven repository under ${rel(mavenRoot)}`);
      }
      return false;
    }
    for (const archive of walkFiles(root).filter((file) => file.endsWith(".aar") || file.endsWith(".jar")).sort(compareText)) {
      const names = archiveZipNames(archive);
      rejectSdkRuntimePayload(product, archive, names);
      if (archive.endsWith(".aar")) {
        validateKotlinAndroidAar(archive, names);
      }
      checked = true;
    }
  } else if (product === "oliphaunt-rust") {
    const crates = readdirSync(root).filter((name) => name.endsWith(".crate")).map((name) => path.join(root, name)).sort(compareText);
    if (crates.length === 0 && require) {
      fail(`${product} must stage a Cargo crate under ${rel(root)}`);
    }
    const packageNames = [];
    for (const crate of crates) {
      rejectSdkRuntimePayload(product, crate, archiveTarNames(crate));
      packageNames.push(await validateRustSdkCrate(crate));
      checked = true;
    }
    if (crates.length > 0) {
      exactSortedStrings(
        `${product} staged Cargo packages`,
        packageNames,
        ["oliphaunt", "oliphaunt-build"],
      );
    }
  } else if (product === "oliphaunt-wasix-rust") {
    const crates = readdirSync(root).filter((name) => name.endsWith(".crate")).map((name) => path.join(root, name)).sort(compareText);
    if (crates.length === 0 && require) {
      fail(`${product} must stage a Cargo crate under ${rel(root)}`);
    }
    for (const crate of crates) {
      rejectSdkRuntimePayload(product, crate, archiveTarNames(crate));
      await validateWasixSdkCrate(crate);
      checked = true;
    }
    const listing = path.join(root, "cargo-package-files.txt");
    if (!isFile(listing)) {
      if (require) {
        fail(`${product} must stage a Cargo package file list under ${rel(root)}`);
      }
      return false;
    }
    const entries = new Set(readFileSync(listing, "utf8").split(/\r?\n/u).map((line) => line.trim()).filter(Boolean));
    for (const requiredEntry of [
      "Cargo.toml",
      "README.md",
      "src/lib.rs",
      "src/bin/oliphaunt_wasix_dump.rs",
      "src/bin/oliphaunt_wasix_proxy.rs",
      "src/oliphaunt/assets.rs",
    ]) {
      if (!entries.has(requiredEntry)) {
        fail(`${product} package file list is missing ${requiredEntry}`);
      }
    }
    for (const entry of entries) {
      if (entry.startsWith("target/") || entry.startsWith("src/runtimes/") || entry.startsWith("src/extensions/generated/")) {
        fail(`${product} package file list contains generated or external payload entry ${entry}`);
      }
    }
    checked = true;
  } else {
    fail(`unsupported SDK product ${product}`);
  }
  if (require && !checked) {
    fail(`${product} did not contain any inspectable staged package artifacts under ${rel(root)}`);
  }
  if (checked) {
    console.log(`validated SDK artifact cleanliness: ${product}`);
  }
  return checked;
}

function walkFiles(root) {
  if (!isDirectory(root)) {
    return [];
  }
  const result = [];
  const visit = (dir) => {
    for (const name of readdirSync(dir).sort(compareText)) {
      const file = path.join(dir, name);
      if (isDirectory(file)) {
        visit(file);
      } else if (isFile(file)) {
        result.push(file);
      }
    }
  };
  visit(root);
  return result;
}

function extensionArtifactKindAllowed(family, target, kind) {
  if (family === "wasix") {
    return target === "wasix-portable" && kind === "wasix-runtime";
  }
  if (family !== "native") {
    return false;
  }
  if (target === "ios-xcframework") {
    return new Set(["runtime", "ios-xcframework", "ios-dependency-xcframework"]).has(kind);
  }
  if (target.startsWith("android-")) {
    return kind === "runtime";
  }
  return kind === "runtime";
}

function publicExtensionAsset(asset) {
  const result = {};
  for (const key of PUBLIC_EXTENSION_RELEASE_ASSET_KEY_ORDER) {
    if (Object.hasOwn(asset, key)) {
      result[key] = asset[key];
    }
  }
  return result;
}

async function checkExtensionProduct(product, { require, requireFullTargets }) {
  const root = path.join(EXTENSION_ROOT, product);
  const manifest = path.join(root, "extension-artifacts.json");
  if (!existsSync(manifest)) {
    if (require) {
      fail(`missing staged exact-extension package manifest for ${product} under ${rel(root)}`);
    }
    return false;
  }
  const data = readJson(manifest);
  const expected = {
    schema: "oliphaunt-extension-ci-artifacts-v1",
    product,
    version: await currentProductVersion(product, PREFIX),
  };
  for (const [key, value] of Object.entries(expected)) {
    if (data[key] !== value) {
      fail(`${rel(manifest)} has ${key}=${JSON.stringify(data[key])}, expected ${JSON.stringify(value)}`);
    }
  }
  const expectedSqlName = productConfig(product).extension_sql_name;
  if (data.sqlName !== expectedSqlName) {
    fail(`${rel(manifest)} has sqlName=${JSON.stringify(data.sqlName)}, expected ${JSON.stringify(expectedSqlName)}`);
  }
  const assets = data.assets;
  if (!Array.isArray(assets) || assets.length === 0) {
    fail(`${rel(manifest)} must declare at least one asset`);
  }
  const seenNames = new Set();
  const seenRoles = new Set();
  const stagedTargets = new Set();
  const allowedTargets = new Set(extensionArtifactTargets({ product, publishedOnly: true }, PREFIX).map((target) => target.target));
  for (const asset of assets) {
    if (asset === null || Array.isArray(asset) || typeof asset !== "object") {
      fail(`${rel(manifest)} contains a non-object asset entry`);
    }
    const { family, target, kind, identity, name, path: pathValue, sha256, bytes } = asset;
    if (![family, target, kind, name, pathValue, sha256].every((value) => typeof value === "string" && value)) {
      fail(`${rel(manifest)} contains an incomplete asset entry: ${JSON.stringify(asset)}`);
    }
    if (!Number.isInteger(bytes) || bytes <= 0) {
      fail(`${rel(manifest)} asset ${name} must declare positive bytes`);
    }
    if (seenNames.has(name)) {
      fail(`${rel(manifest)} declares duplicate asset name ${name}`);
    }
    seenNames.add(name);
    if (!(identity === null || typeof identity === "string" && identity.length > 0)) {
      fail(`${rel(manifest)} asset ${name} identity must be null or a non-empty string`);
    }
    if (kind === "ios-dependency-xcframework" && identity === null) {
      fail(`${rel(manifest)} iOS dependency XCFramework ${name} must declare its identity`);
    }
    if (kind !== "ios-dependency-xcframework" && kind !== "ios-xcframework" && identity !== null) {
      fail(`${rel(manifest)} asset ${name} must not declare identity for kind=${kind}`);
    }
    const role = `${family}:${target}:${kind}:${identity ?? ""}`;
    if (seenRoles.has(role)) {
      fail(`${rel(manifest)} repeats artifact role ${role}`);
    }
    seenRoles.add(role);
    stagedTargets.add(target);
    if (!allowedTargets.has(target)) {
      fail(`${rel(manifest)} stages undeclared target=${JSON.stringify(target)}`);
    }
    if (!extensionArtifactKindAllowed(family, target, kind)) {
      fail(`${rel(manifest)} stages invalid artifact kind=${JSON.stringify(kind)} for family=${JSON.stringify(family)} target=${JSON.stringify(target)}`);
    }
    const assetPath = path.join(ROOT, pathValue);
    if (path.dirname(assetPath) !== path.join(root, "release-assets") || path.basename(assetPath) !== name) {
      fail(`${rel(manifest)} asset ${name} must live directly under ${rel(path.join(root, "release-assets"))}`);
    }
    if (!isFile(assetPath)) {
      fail(`${rel(manifest)} references missing asset ${rel(assetPath)}`);
    }
    if (statSync(assetPath).size !== bytes) {
      fail(`${rel(assetPath)} size does not match ${rel(manifest)}`);
    }
    if (sha256File(assetPath) !== sha256) {
      fail(`${rel(assetPath)} checksum does not match ${rel(manifest)}`);
    }
    validateReleaseArchivePayload(assetPath);
  }
  const nativeStem = typeof data.nativeModuleStem === "string" && data.nativeModuleStem.length > 0
    ? data.nativeModuleStem
    : null;
  const iosDependencies = Array.isArray(data.iosNativeDependencies)
    ? data.iosNativeDependencies
    : fail(`${rel(manifest)} must declare iosNativeDependencies`);
  if (
    iosDependencies.some((value) => typeof value !== "string" || value.length === 0)
    || new Set(iosDependencies).size !== iosDependencies.length
    || JSON.stringify([...iosDependencies].sort(compareText)) !== JSON.stringify(iosDependencies)
  ) {
    fail(`${rel(manifest)} iosNativeDependencies must be a sorted unique string list`);
  }
  const stagesIos = stagedTargets.has("ios-xcframework");
  if (nativeStem === null && (iosDependencies.length > 0 || data.iosRegistration !== null)) {
    fail(`${rel(manifest)} SQL-only extension must not fabricate iOS native dependencies or registration`);
  }
  if (nativeStem !== null && stagesIos) {
    if (data.iosRegistration === null || typeof data.iosRegistration !== "object" || Array.isArray(data.iosRegistration)) {
      fail(`${rel(manifest)} native extension must include build-derived iOS registration metadata`);
    }
    if (data.iosRegistration.sqlName !== data.sqlName || data.iosRegistration.nativeModuleStem !== nativeStem) {
      fail(`${rel(manifest)} iOS registration metadata does not match ${data.sqlName}/${nativeStem}`);
    }
  }
  if (!stagesIos && (iosDependencies.length > 0 || data.iosRegistration !== null)) {
    fail(`${rel(manifest)} must not claim iOS dependency/registration metadata without staging the iOS target`);
  }
  const expectedRoles = [];
  const targetsToCheck = requireFullTargets ? allowedTargets : stagedTargets;
  for (const target of [...targetsToCheck].sort(compareText)) {
    if (target === "wasix-portable") {
      expectedRoles.push(`wasix:${target}:wasix-runtime:`);
    } else {
      expectedRoles.push(`native:${target}:runtime:`);
      if (target === "ios-xcframework" && nativeStem !== null) {
        expectedRoles.push(`native:${target}:ios-xcframework:${nativeStem}`);
        for (const dependency of iosDependencies) {
          expectedRoles.push(`native:${target}:ios-dependency-xcframework:${dependency}`);
        }
      }
    }
  }
  const actualRoles = [...seenRoles].sort(compareText);
  expectedRoles.sort(compareText);
  if (JSON.stringify(actualRoles) !== JSON.stringify(expectedRoles)) {
    fail(`${rel(manifest)} artifact roles are not dependency-closed: expected=${JSON.stringify(expectedRoles)}, actual=${JSON.stringify(actualRoles)}`);
  }
  const releaseManifest = path.join(root, "release-assets", `${product}-${expected.version}-manifest.json`);
  if (!existsSync(releaseManifest)) {
    fail(`${product} must stage release manifest ${rel(releaseManifest)}`);
  }
  const releaseData = readJson(releaseManifest);
  const expectedRelease = {
    schema: "oliphaunt-extension-release-manifest-v1",
    product,
    version: String(expected.version),
    sqlName: String(expectedSqlName),
  };
  for (const [key, value] of Object.entries(expectedRelease)) {
    if (releaseData[key] !== value) {
      fail(`${rel(releaseManifest)} has ${key}=${JSON.stringify(releaseData[key])}, expected ${JSON.stringify(value)}`);
    }
  }
  if (!setEquals(new Set(Object.keys(releaseData)), PUBLIC_EXTENSION_RELEASE_MANIFEST_KEYS)) {
    fail(`${rel(releaseManifest)} public manifest keys must be ${JSON.stringify([...PUBLIC_EXTENSION_RELEASE_MANIFEST_KEYS].sort(compareText))}, got ${JSON.stringify(Object.keys(releaseData).sort(compareText))}`);
  }
  const metadata = extensionMetadata(product, PREFIX);
  if (releaseData.extensionClass !== metadata.class) {
    fail(`${rel(releaseManifest)} has stale extensionClass`);
  }
  if (releaseData.versioning !== metadata.versioning) {
    fail(`${rel(releaseManifest)} has stale versioning`);
  }
  if (!deepEqual(releaseData.sourceIdentity, extensionSourceIdentity(product, PREFIX))) {
    fail(`${rel(releaseManifest)} has stale sourceIdentity`);
  }
  if (!deepEqual(releaseData.compatibility, metadata.compatibility)) {
    fail(`${rel(releaseManifest)} has stale compatibility metadata`);
  }
  const publicAssets = releaseData.assets;
  if (!Array.isArray(publicAssets) || publicAssets.length === 0) {
    fail(`${rel(releaseManifest)} must declare release assets`);
  }
  const expectedPublicAssets = assets.map(publicExtensionAsset);
  if (!deepEqual(publicAssets, expectedPublicAssets)) {
    fail(`${rel(releaseManifest)} public assets must match staged CI manifest without local paths`);
  }
  for (const asset of publicAssets) {
    if (asset === null || Array.isArray(asset) || typeof asset !== "object") {
      fail(`${rel(releaseManifest)} contains a non-object public asset row`);
    }
    if (!setEquals(new Set(Object.keys(asset)), PUBLIC_EXTENSION_RELEASE_ASSET_KEYS)) {
      fail(`${rel(releaseManifest)} public asset ${JSON.stringify(asset.name)} keys must be ${JSON.stringify([...PUBLIC_EXTENSION_RELEASE_ASSET_KEYS].sort(compareText))}, got ${JSON.stringify(Object.keys(asset).sort(compareText))}`);
    }
  }
  const propertiesManifest = path.join(root, "release-assets", `${product}-${expected.version}-manifest.properties`);
  if (!existsSync(propertiesManifest)) {
    fail(`${product} must stage properties manifest ${rel(propertiesManifest)}`);
  }
  const properties = readPropertiesText(readFileSync(propertiesManifest, "utf8"));
  const expectedProperties = {
    schema: "oliphaunt-extension-release-manifest-v1",
    product,
    version: String(expected.version),
    sqlName: String(expectedSqlName),
    extensionClass: String(releaseData.extensionClass),
    versioning: String(releaseData.versioning),
    sourceKind: String(releaseData.sourceIdentity.kind),
  };
  for (const [key, value] of Object.entries(expectedProperties)) {
    if (properties[key] !== value) {
      fail(`${rel(propertiesManifest)} has ${key}=${JSON.stringify(properties[key])}, expected ${JSON.stringify(value)}`);
    }
  }
  const expectedPropertyAssets = Object.fromEntries(
    assets.map((asset) => [`${asset.family}.${asset.target}.${asset.kind}`, asset.name]),
  );
  const actualPropertyAssets = Object.fromEntries(
    Object.entries(properties)
      .filter(([key]) => key.startsWith("asset."))
      .map(([key, value]) => [key.slice("asset.".length), value]),
  );
  if (JSON.stringify(sortObject(actualPropertyAssets)) !== JSON.stringify(sortObject(expectedPropertyAssets))) {
    fail(`${rel(propertiesManifest)} asset rows must match ${rel(manifest)} exactly: ${JSON.stringify(actualPropertyAssets)} vs ${JSON.stringify(expectedPropertyAssets)}`);
  }
  const checksumManifest = path.join(root, "release-assets", `${product}-${expected.version}-release-assets.sha256`);
  if (!existsSync(checksumManifest)) {
    fail(`${product} must stage checksum manifest ${rel(checksumManifest)}`);
  }
  validateChecksumManifest(checksumManifest, path.join(root, "release-assets"));
  if (requireFullTargets) {
    const missing = [...allowedTargets].filter((target) => !stagedTargets.has(target)).sort(compareText);
    if (missing.length > 0) {
      fail(`${product} is missing published exact-extension targets: ${missing.join(", ")}`);
    }
  }
  console.log(`validated exact-extension package artifacts: ${product}`);
  return true;
}

function setEquals(left, right) {
  return left.size === right.size && [...left].every((item) => right.has(item));
}

function sortObject(value) {
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => compareText(left, right)));
}

function sortValue(value) {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort(compareText).map((key) => [key, sortValue(value[key])]));
  }
  return value;
}

function deepEqual(left, right) {
  return JSON.stringify(sortValue(left)) === JSON.stringify(sortValue(right));
}

function validateChecksumManifest(file, assetDir) {
  const declared = new Map();
  const lines = readFileSync(file, "utf8").split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) {
      continue;
    }
    const parts = line.split(/\s+/u);
    if (parts.length !== 2) {
      fail(`${rel(file)}:${index + 1} must contain '<sha256> ./<asset>'`);
    }
    const [sha, name] = parts;
    if (!/^[0-9a-f]{64}$/u.test(sha) || !name.startsWith("./") || name.slice(2).includes("/")) {
      fail(`${rel(file)}:${index + 1} contains an invalid checksum entry`);
    }
    const assetName = name.slice(2);
    if (declared.has(assetName)) {
      fail(`${rel(file)} declares duplicate checksum entry for ${assetName}`);
    }
    declared.set(assetName, sha);
  }
  const expectedNames = readdirSync(assetDir)
    .map((name) => path.join(assetDir, name))
    .filter((candidate) => isFile(candidate) && candidate !== file)
    .map((candidate) => path.basename(candidate))
    .sort(compareText);
  if (JSON.stringify([...declared.keys()].sort(compareText)) !== JSON.stringify(expectedNames)) {
    fail(`${rel(file)} must cover release assets exactly`);
  }
  for (const [name, expectedSha] of declared) {
    const actual = sha256File(path.join(assetDir, name));
    if (actual !== expectedSha) {
      fail(`${rel(file)} checksum mismatch for ${name}`);
    }
  }
}

function discoverMobileArtifacts(platform) {
  if (platform === "android") {
    const root = path.join(MOBILE_ROOT, "android");
    return existsSync(root)
      ? readdirSync(root).filter((name) => name.endsWith(".apk")).map((name) => {
          const file = path.join(root, name);
          return { platform: "android", path: file, names: archiveZipNames(file), readText: (member) => zipReadText(file, member) };
        }).sort((left, right) => compareText(left.path, right.path))
      : [];
  }
  if (platform === "ios") {
    const root = path.join(MOBILE_ROOT, "ios");
    return existsSync(root)
      ? readdirSync(root).filter((name) => name.endsWith(".app") && isDirectory(path.join(root, name))).map((name) => {
          const app = path.join(root, name);
          return { platform: "ios", path: app, names: directoryNames(app), readText: (member) => dirReadText(app, member) };
        }).sort((left, right) => compareText(left.path, right.path))
      : [];
  }
  fail(`unsupported mobile platform ${platform}`);
}

function mobilePrefix(platform) {
  if (platform === "android") {
    return "assets/oliphaunt/";
  }
  if (platform === "ios") {
    return "OliphauntReactNativeResources.bundle/oliphaunt/";
  }
  fail(`unsupported mobile platform ${platform}`);
}

function mobileTargetForArtifact(artifact) {
  if (artifact.platform === "ios") {
    return "ios-xcframework";
  }
  const abis = artifact.names
    .map((name) => name.split("/"))
    .filter((parts) => parts.length === 3 && parts[0] === "lib" && parts[2] === "liboliphaunt.so")
    .map((parts) => parts[1])
    .sort(compareText);
  if (abis.length !== 1) {
    fail(`${rel(artifact.path)} must contain exactly one Android liboliphaunt ABI, got ${JSON.stringify(abis)}`);
  }
  if (abis[0] === "arm64-v8a") {
    return "android-arm64-v8a";
  }
  if (abis[0] === "x86_64") {
    return "android-x86_64";
  }
  fail(`${rel(artifact.path)} contains unsupported Android ABI ${abis[0]}`);
}

function mobileBuildReport(platform) {
  const report = path.join(MOBILE_ROOT, platform, "build-report.json");
  if (!isFile(report)) {
    return null;
  }
  const data = readJson(report);
  if (data.schema !== "oliphaunt-react-native-mobile-build-v1") {
    fail(`${rel(report)} has invalid mobile build report schema`);
  }
  if (data.platform !== platform) {
    fail(`${rel(report)} has platform=${JSON.stringify(data.platform)}, expected ${JSON.stringify(platform)}`);
  }
  return data;
}

function resolveReportPath(value, reportPath, field) {
  if (typeof value !== "string" || !value) {
    fail(`${rel(reportPath)} must declare ${field}`);
  }
  return path.isAbsolute(value) ? value : path.join(ROOT, value);
}

function checkExtensionPackageHasMobileTarget(sqlName, target) {
  for (const product of exactExtensionProducts(PREFIX)) {
    const manifest = path.join(EXTENSION_ROOT, product, "extension-artifacts.json");
    if (!isFile(manifest)) {
      continue;
    }
    const data = readJson(manifest);
    if (data.sqlName !== sqlName) {
      continue;
    }
    const assets = data.assets;
    if (!Array.isArray(assets)) {
      fail(`${rel(manifest)} must declare assets`);
    }
    const runtimeMatches = assets.filter((asset) => asset && asset.family === "native" && asset.target === target && asset.kind === "runtime");
    if (runtimeMatches.length !== 1) {
      fail(`${sqlName} exact-extension package must contain one native runtime asset for ${target}`);
    }
    if (target === "ios-xcframework") {
      const frameworkMatches = assets.filter((asset) => asset && asset.family === "native" && asset.target === target && asset.kind === "ios-xcframework");
      const dependencyMatches = assets.filter((asset) => asset && asset.family === "native" && asset.target === target && asset.kind === "ios-dependency-xcframework");
      const hasNativeModule = typeof data.nativeModuleStem === "string" && data.nativeModuleStem.length > 0;
      if (frameworkMatches.length !== (hasNativeModule ? 1 : 0)) {
        fail(`${sqlName} exact-extension package has the wrong iOS XCFramework role count for ${hasNativeModule ? "native" : "SQL-only"} metadata`);
      }
      const expectedDependencies = hasNativeModule && Array.isArray(data.iosNativeDependencies)
        ? data.iosNativeDependencies
        : [];
      if (JSON.stringify(dependencyMatches.map((asset) => asset.identity).sort(compareText)) !== JSON.stringify(expectedDependencies)) {
        fail(`${sqlName} exact-extension package iOS dependency XCFrameworks do not match its frozen dependency closure`);
      }
    }
    return;
  }
  fail(`no exact-extension package found for selected mobile extension ${sqlName}`);
}

function checkIosPrebuiltExtensionLinkage(artifact, stems) {
  if (stems.length === 0) {
    return;
  }
  const sourceLeaks = artifact.names
    .filter((name) => name.includes("/static-registry/oliphaunt_static_registry.c") || name.includes("/extension-frameworks/") || name.endsWith(".xcframework"))
    .sort(compareText);
  if (sourceLeaks.length > 0) {
    fail(`${rel(artifact.path)} includes build-only iOS static-extension inputs as app resources: ${sourceLeaks.slice(0, 10).join(", ")}`);
  }
  const report = mobileBuildReport("ios");
  if (report === null) {
    fail(`${rel(artifact.path)} requires ${rel(path.join(MOBILE_ROOT, "ios/build-report.json"))} for iOS extension link evidence`);
  }
  const scratchRoot = report.scratchRoot;
  if (typeof scratchRoot !== "string" || !scratchRoot) {
    fail(`${rel(path.join(MOBILE_ROOT, "ios/build-report.json"))} must declare scratchRoot for iOS extension link evidence`);
  }
  const scratchPath = scratchRoot;
  const xcodeLog = path.join(scratchPath, "xcodebuild.log");
  if (!isFile(xcodeLog)) {
    fail(`iOS extension link evidence is missing xcodebuild log: ${rel(xcodeLog)}`);
  }
  const logText = readFileSync(xcodeLog, "utf8");
  if (!logText.includes("** BUILD SUCCEEDED **")) {
    fail(`iOS extension link evidence requires a successful xcodebuild log: ${rel(xcodeLog)}`);
  }
  const podsSupport = path.join(
    scratchPath,
    "src/sdks/react-native/examples/expo/ios/Pods/Target Support Files/OliphauntReactNative",
  );
  const inputFile = path.join(podsSupport, "OliphauntReactNative-xcframeworks-input-files.xcfilelist");
  const outputFile = path.join(podsSupport, "OliphauntReactNative-xcframeworks-output-files.xcfilelist");
  if (!isFile(inputFile)) {
    fail(`iOS extension link evidence is missing CocoaPods XCFramework input file list: ${rel(inputFile)}`);
  }
  if (!isFile(outputFile)) {
    fail(`iOS extension link evidence is missing CocoaPods XCFramework output file list: ${rel(outputFile)}`);
  }
  const expectedFrameworks = new Set(stems.map((stem) => `liboliphaunt_extension_${stem}`));
  const podText = `${readFileSync(inputFile, "utf8")}\n${readFileSync(outputFile, "utf8")}`;
  const podFrameworks = new Set([...podText.matchAll(/liboliphaunt_extension_[A-Za-z0-9_]+/gu)].map((match) => match[0]));
  const productsRoot = path.join(scratchPath, "DerivedData/Build/Products");
  if (!isDirectory(productsRoot)) {
    fail(`iOS extension link evidence is missing Xcode build products: ${rel(productsRoot)}`);
  }
  const builtFrameworks = new Set(
    walkFiles(productsRoot)
      .map((file) => path.basename(file))
      .filter((name) => /^liboliphaunt_extension_.*(\.a|\.framework)$/u.test(name))
      .map((name) => name.replace(/\.a$/u, "").replace(/\.framework$/u, "")),
  );
  const missingPods = [...expectedFrameworks].filter((item) => !podFrameworks.has(item)).sort(compareText);
  if (missingPods.length > 0) {
    fail(`CocoaPods file lists do not include selected iOS extension link input(s): ${missingPods.join(", ")}`);
  }
  const missingBuilt = [...expectedFrameworks].filter((item) => !builtFrameworks.has(item)).sort(compareText);
  if (missingBuilt.length > 0) {
    fail(`Xcode build products do not include selected iOS extension linked artifact(s): ${missingBuilt.join(", ")}`);
  }
  const unexpectedPods = [...podFrameworks].filter((item) => !expectedFrameworks.has(item)).sort(compareText);
  if (unexpectedPods.length > 0) {
    fail(`CocoaPods file lists include unselected iOS extension link input(s): ${unexpectedPods.join(", ")}`);
  }
  const unexpectedBuilt = [...builtFrameworks].filter((item) => !expectedFrameworks.has(item)).sort(compareText);
  if (unexpectedBuilt.length > 0) {
    fail(`Xcode build products include unselected iOS extension linked artifact(s): ${unexpectedBuilt.join(", ")}`);
  }
}

function checkAndroidPrebuiltExtensionLinkage(artifact, stems, report, reportPath, expectedAbi, staticRegistry, target) {
  if (stems.length === 0) {
    return;
  }
  const evidencePath = resolveReportPath(report.androidLinkEvidence, reportPath, "androidLinkEvidence");
  if (!isFile(evidencePath)) {
    fail(`Android extension link evidence is missing: ${rel(evidencePath)}`);
  }
  const linkedStems = new Set();
  const linkedDependencies = new Set();
  let evidenceAbi = "";
  let runtimePath = "";
  let schemaRows = 0;
  let abiRows = 0;
  const requireExistingPath = (rawPath, lineNumber, rowKind) => {
    const resolved = path.isAbsolute(rawPath) ? rawPath : path.join(path.dirname(evidencePath), rawPath);
    if (!isFile(resolved)) {
      fail(`${rel(evidencePath)}:${lineNumber} ${rowKind} path does not exist: ${resolved}`);
    }
    return resolved;
  };
  const lines = readFileSync(evidencePath, "utf8").split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const parts = lines[index].split("\t");
    if (!parts.length || !parts[0]) {
      continue;
    }
    const lineNumber = index + 1;
    const kind = parts[0];
    if (kind === "schema") {
      if (JSON.stringify(parts) !== JSON.stringify(["schema", "oliphaunt-android-static-extension-link-v1"])) {
        fail(`${rel(evidencePath)}:${lineNumber} has invalid schema row`);
      }
      schemaRows += 1;
    } else if (kind === "abi") {
      if (parts.length !== 2) {
        fail(`${rel(evidencePath)}:${lineNumber} has invalid abi row`);
      }
      evidenceAbi = parts[1];
      abiRows += 1;
    } else if (kind === "runtime") {
      if (parts.length !== 3 || parts[1] !== "liboliphaunt") {
        fail(`${rel(evidencePath)}:${lineNumber} has invalid runtime row`);
      }
      const runtime = requireExistingPath(parts[2], lineNumber, "runtime");
      if (path.basename(runtime) !== "liboliphaunt.so") {
        fail(`${rel(evidencePath)}:${lineNumber} runtime path must end in liboliphaunt.so`);
      }
      if (runtimePath) {
        fail(`${rel(evidencePath)} contains duplicate runtime rows`);
      }
      runtimePath = runtime;
    } else if (kind === "extension") {
      if (parts.length !== 3) {
        fail(`${rel(evidencePath)}:${lineNumber} has invalid extension row`);
      }
      const [stem, archive] = [parts[1], parts[2]];
      const expectedName = `liboliphaunt_extension_${stem}.a`;
      const archivePath = requireExistingPath(archive, lineNumber, "extension");
      const expectedRelative = staticRegistry[`module.${stem}.archive.${target}`];
      if (!expectedRelative) {
        fail(`${rel(artifact.path)} static registry manifest has no module.${stem}.archive.${target} entry`);
      }
      if (path.basename(archivePath) !== expectedName) {
        fail(`${rel(evidencePath)}:${lineNumber} archive ${JSON.stringify(archive)} does not match stem ${JSON.stringify(stem)}`);
      }
      if (!archivePath.split(path.sep).join("/").endsWith(expectedRelative)) {
        fail(`${rel(evidencePath)}:${lineNumber} archive ${JSON.stringify(archive)} does not match static-registry path ${JSON.stringify(expectedRelative)}`);
      }
      linkedStems.add(stem);
    } else if (kind === "dependency") {
      if (parts.length !== 3 || !parts[1]) {
        fail(`${rel(evidencePath)}:${lineNumber} has invalid dependency row`);
      }
      const dependencyName = parts[1];
      const dependencyPath = requireExistingPath(parts[2], lineNumber, "dependency");
      const expectedRelative = staticRegistry[`dependency.${dependencyName}.archive.${target}`];
      if (!expectedRelative) {
        fail(`${rel(evidencePath)}:${lineNumber} dependency ${JSON.stringify(dependencyName)} is not declared by the static-registry manifest for ${target}`);
      }
      if (!dependencyPath.split(path.sep).join("/").endsWith(expectedRelative)) {
        fail(`${rel(evidencePath)}:${lineNumber} dependency path ${JSON.stringify(parts[2])} does not match static-registry path ${JSON.stringify(expectedRelative)}`);
      }
      linkedDependencies.add(dependencyName);
    } else {
      fail(`${rel(evidencePath)}:${lineNumber} has unknown row kind ${JSON.stringify(kind)}`);
    }
  }
  if (schemaRows !== 1) {
    fail(`${rel(evidencePath)} must contain exactly one schema row`);
  }
  if (abiRows !== 1) {
    fail(`${rel(evidencePath)} must contain exactly one abi row`);
  }
  if (evidenceAbi !== expectedAbi) {
    fail(`${rel(evidencePath)} declares abi=${JSON.stringify(evidenceAbi)}, expected ${JSON.stringify(expectedAbi)}`);
  }
  if (!runtimePath) {
    fail(`${rel(evidencePath)} does not show liboliphaunt runtime link input`);
  }
  const expectedStems = new Set(stems);
  const missing = [...expectedStems].filter((stem) => !linkedStems.has(stem)).sort(compareText);
  if (missing.length > 0) {
    fail(`${rel(evidencePath)} does not show selected Android extension archive link input(s): ${missing.join(", ")}`);
  }
  const unexpected = [...linkedStems].filter((stem) => !expectedStems.has(stem)).sort(compareText);
  if (unexpected.length > 0) {
    fail(`${rel(evidencePath)} shows unselected Android extension archive link input(s): ${unexpected.join(", ")}`);
  }
  const expectedDependencies = new Set(csvValues(staticRegistry.dependencyArchives));
  const missingDependencies = [...expectedDependencies].filter((dependency) => !linkedDependencies.has(dependency)).sort(compareText);
  if (missingDependencies.length > 0) {
    fail(`${rel(evidencePath)} does not show required Android extension dependency archive link input(s): ${missingDependencies.join(", ")}`);
  }
  const unexpectedDependencies = [...linkedDependencies].filter((dependency) => !expectedDependencies.has(dependency)).sort(compareText);
  if (unexpectedDependencies.length > 0) {
    fail(`${rel(evidencePath)} shows unselected Android extension dependency archive link input(s): ${unexpectedDependencies.join(", ")}`);
  }
}

function checkMobileArtifact(artifact, { requirePrebuiltExtensions }) {
  const prefix = mobilePrefix(artifact.platform);
  const runtimeManifestName = `${prefix}runtime/manifest.properties`;
  const staticRegistryManifestName = `${prefix}static-registry/manifest.properties`;
  const packageSizeName = `${prefix}package-size.tsv`;
  const runtime = readPropertiesText(artifact.readText(runtimeManifestName));
  if (runtime.schema !== "oliphaunt-runtime-resources-v1") {
    fail(`${rel(artifact.path)} has invalid runtime resource manifest schema`);
  }
  const selected = csvValues(runtime.extensions);
  const selectedSet = new Set(selected);
  const rows = generatedExtensionRows();
  const target = mobileTargetForArtifact(artifact);
  const reportPath = path.join(MOBILE_ROOT, artifact.platform, "build-report.json");
  const report = mobileBuildReport(artifact.platform);
  if (report === null) {
    fail(`${rel(artifact.path)} requires mobile build report ${rel(reportPath)}`);
  }
  const reportArtifact = resolveReportPath(report.appArtifact, reportPath, "appArtifact");
  if (path.resolve(reportArtifact) !== path.resolve(artifact.path)) {
    fail(`${rel(reportPath)} appArtifact=${reportArtifact} does not match inspected artifact ${artifact.path}`);
  }
  if (report.appArtifactBytes !== pathBytes(artifact.path)) {
    fail(`${rel(reportPath)} appArtifactBytes does not match inspected artifact size`);
  }
  if (!Array.isArray(report.selectedExtensions)) {
    fail(`${rel(reportPath)} selectedExtensions must be an array`);
  }
  const reportSelected = report.selectedExtensions.map((value) => String(value)).filter(Boolean).sort(compareText);
  if (JSON.stringify(reportSelected) !== JSON.stringify([...selected].sort(compareText))) {
    fail(`${rel(reportPath)} selectedExtensions=${JSON.stringify(reportSelected)} must match runtime manifest ${JSON.stringify([...selected].sort(compareText))}`);
  }
  let expectedAbi = "";
  if (artifact.platform === "android") {
    expectedAbi = target === "android-arm64-v8a" ? "arm64-v8a" : "x86_64";
    if (report.abi !== expectedAbi) {
      fail(`${rel(reportPath)} abi=${JSON.stringify(report.abi)}, expected ${JSON.stringify(expectedAbi)}`);
    }
  }
  const extensionAssetNames = artifact.names.filter(
    (name) =>
      name.includes(`${prefix}runtime/files/share/postgresql/extension/`) &&
      (name.endsWith(".control") || name.endsWith(".sql")),
  );
  const presentExtensions = new Set(extensionAssetNames.map(extensionNameForAsset).filter(Boolean));
  const unexpected = [...presentExtensions].filter((extension) => !selectedSet.has(extension) && !BASELINE_POSTGRES_EXTENSIONS.has(extension)).sort(compareText);
  if (unexpected.length > 0) {
    fail(`${rel(artifact.path)} includes unselected extension assets: ${unexpected.join(", ")}`);
  }
  for (const extension of selected) {
    if (createsExtension(extension, rows)) {
      const hasControl = extensionAssetNames.some((name) => name.endsWith(`/${extension}.control`));
      const hasSql = extensionAssetNames.some((name) => name.includes(`/${extension}--`) && name.endsWith(".sql"));
      if (!hasControl || !hasSql) {
        fail(`${rel(artifact.path)} is missing selected ${extension} control/SQL assets`);
      }
    }
    if (requirePrebuiltExtensions) {
      checkExtensionPackageHasMobileTarget(extension, target);
    }
  }
  const stems = selected.map((extension) => nativeModuleStem(extension, rows)).filter((stem) => stem && stem !== "-").sort(compareText);
  const staticRegistry = readPropertiesText(artifact.readText(staticRegistryManifestName));
  const registered = csvValues(staticRegistry.registeredExtensions).sort(compareText);
  const nativeSelected = nativeModuleExtensions(selected, rows);
  if (stems.length > 0) {
    if (runtime.mobileStaticRegistryState !== "complete") {
      fail(`${rel(artifact.path)} must mark mobile static registry complete for native-module extensions`);
    }
    if (JSON.stringify(registered) !== JSON.stringify(nativeSelected)) {
      fail(`${rel(artifact.path)} static registry registeredExtensions=${JSON.stringify(registered)}, expected ${JSON.stringify(nativeSelected)}`);
    }
    if (artifact.platform === "android" && !artifact.names.some((name) => name.endsWith("/liboliphaunt_extensions.so"))) {
      fail(`${rel(artifact.path)} Android app is missing liboliphaunt_extensions.so`);
    }
    if (artifact.platform === "android" && requirePrebuiltExtensions) {
      checkAndroidPrebuiltExtensionLinkage(artifact, stems, report, reportPath, expectedAbi, staticRegistry, target);
    }
    if (artifact.platform === "ios" && requirePrebuiltExtensions) {
      checkIosPrebuiltExtensionLinkage(artifact, stems);
    }
    if (artifact.names.some((name) => name.includes("static-registry/archives/"))) {
      fail(`${rel(artifact.path)} must not ship build-only static-registry archives`);
    }
  } else if (![undefined, "", "not-required"].includes(runtime.mobileStaticRegistryState)) {
    fail(`${rel(artifact.path)} must not claim a static registry for SQL-only extensions`);
  }
  const packageSize = artifact.readText(packageSizeName);
  const packageSizeExtensions = packageSize
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("extension\t"))
    .map((line) => line.split("\t")[1])
    .filter(Boolean)
    .sort(compareText);
  if (JSON.stringify(packageSizeExtensions) !== JSON.stringify([...selected].sort(compareText))) {
    fail(`${rel(artifact.path)} package-size extension rows ${JSON.stringify(packageSizeExtensions)} must exactly match selected extensions ${JSON.stringify([...selected].sort(compareText))}`);
  }
  console.log(`validated mobile app extension contents: ${artifact.platform} ${rel(artifact.path)}`);
}

function checkMobilePlatform(platform, { require, requirePrebuiltExtensions }) {
  const artifacts = discoverMobileArtifacts(platform);
  if (artifacts.length === 0) {
    if (require) {
      fail(`missing staged React Native ${platform} mobile app artifacts under ${rel(path.join(MOBILE_ROOT, platform))}`);
    }
    return false;
  }
  for (const artifact of artifacts) {
    checkMobileArtifact(artifact, { requirePrebuiltExtensions });
  }
  return true;
}

function expandProducts(values, { allProducts, label }) {
  const expanded = [];
  for (const value of values) {
    if (value === "all") {
      expanded.push(...[...allProducts].sort(compareText));
    } else if (!allProducts.has(value)) {
      fail(`unknown ${label} ${value}; expected one of: all, ${[...allProducts].sort(compareText).join(", ")}`);
    } else {
      expanded.push(value);
    }
  }
  return [...new Set(expanded)].sort(compareText);
}

function usage() {
  return `usage: tools/release/check-staged-artifacts.mjs [options]

Options:
  --require-sdk-product PRODUCT        SDK product to require, or all
  --require-extension-product PRODUCT  exact-extension product to require, or all
  --require-full-extension-targets     require every published exact-extension target
  --require-mobile android|ios|all     mobile app artifact platform to require
  --require-mobile-prebuilt-extensions require matching exact-extension package inputs
  --inspect-present                    also inspect any present staged artifacts
  -h, --help                           show this help
`;
}

function parseArgs(argv) {
  const args = {
    requireSdkProduct: [],
    requireExtensionProduct: [],
    requireFullExtensionTargets: false,
    requireMobile: [],
    requireMobilePrebuiltExtensions: false,
    inspectPresent: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--require-sdk-product") {
      const value = argv[index + 1];
      if (!value) {
        fail("--require-sdk-product requires a value");
      }
      args.requireSdkProduct.push(value);
      index += 1;
    } else if (arg === "--require-extension-product") {
      const value = argv[index + 1];
      if (!value) {
        fail("--require-extension-product requires a value");
      }
      args.requireExtensionProduct.push(value);
      index += 1;
    } else if (arg === "--require-full-extension-targets") {
      args.requireFullExtensionTargets = true;
    } else if (arg === "--require-mobile") {
      const value = argv[index + 1];
      if (!["android", "ios", "all"].includes(value)) {
        fail("--require-mobile requires one of: android, ios, all");
      }
      args.requireMobile.push(value);
      index += 1;
    } else if (arg === "--require-mobile-prebuilt-extensions") {
      args.requireMobilePrebuiltExtensions = true;
    } else if (arg === "--inspect-present") {
      args.inspectPresent = true;
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write(usage());
      process.exit(0);
    } else {
      fail(`unknown argument ${arg}`);
    }
  }
  return args;
}

async function main(argv) {
  const args = parseArgs(argv);
  let checked = 0;

  const sdkProductSet = new Set(sdkProducts());
  const requiredSdkProducts = expandProducts(args.requireSdkProduct, {
    allProducts: sdkProductSet,
    label: "SDK product",
  });
  for (const product of requiredSdkProducts) {
    checked += Number(await checkSdkProduct(product, { require: true }));
  }
  if (args.inspectPresent) {
    for (const product of [...sdkProductSet].filter((product) => !requiredSdkProducts.includes(product)).sort(compareText)) {
      checked += Number(await checkSdkProduct(product, { require: false }));
    }
  }

  const extensionProductSet = new Set(exactExtensionProducts(PREFIX));
  const requiredExtensionProducts = expandProducts(args.requireExtensionProduct, {
    allProducts: extensionProductSet,
    label: "exact-extension product",
  });
  for (const product of requiredExtensionProducts) {
    checked += Number(await checkExtensionProduct(product, {
      require: true,
      requireFullTargets: args.requireFullExtensionTargets,
    }));
  }
  if (args.inspectPresent) {
    for (const product of [...extensionProductSet].filter((product) => !requiredExtensionProducts.includes(product)).sort(compareText)) {
      checked += Number(await checkExtensionProduct(product, {
        require: false,
        requireFullTargets: false,
      }));
    }
  }

  const requiredMobile = new Set();
  for (const value of args.requireMobile) {
    if (value === "all") {
      requiredMobile.add("android");
      requiredMobile.add("ios");
    } else {
      requiredMobile.add(value);
    }
  }
  for (const platform of [...requiredMobile].sort(compareText)) {
    checked += Number(checkMobilePlatform(platform, {
      require: true,
      requirePrebuiltExtensions: args.requireMobilePrebuiltExtensions,
    }));
  }
  if (args.inspectPresent) {
    for (const platform of ["android", "ios"].filter((value) => !requiredMobile.has(value))) {
      checked += Number(checkMobilePlatform(platform, {
        require: false,
        requirePrebuiltExtensions: args.requireMobilePrebuiltExtensions,
      }));
    }
  }

  if (checked === 0) {
    fail("no staged artifacts were checked; pass --require-* or --inspect-present");
  }
}

if (import.meta.main) {
  await main(Bun.argv.slice(2));
}
