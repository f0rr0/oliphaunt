#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as zlibConstants, gzipSync, zstdCompressSync } from "node:zlib";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createDeterministicTar } from "./cargo-source-package.mjs";
import { compareText } from "./release-graph.mjs";
import { currentProductVersionSync } from "./release-artifact-targets.mjs";
import {
  AOT_PACKAGES,
  AOT_TARGET_CFGS,
  AOT_TARGET_TRIPLES,
  CORE_RUNTIME_ARCHIVE_FILES,
  FORBIDDEN_RUNTIME_ARCHIVE_TOOL_FILES,
  ICU_PACKAGE,
  ICU_PAYLOAD_ARCHIVE,
  RUNTIME_PACKAGE,
  TOOLS_AOT_ARTIFACTS,
  TOOLS_AOT_PACKAGES,
  TOOLS_PACKAGE,
  TOOLS_PAYLOAD_FILES,
  WASIX_CARGO_ARTIFACT_SCHEMA,
  expectedExtensionAotTargets,
  wasixExtensionAotPackageName,
  wasixExtensionPackageName,
} from "./wasix-cargo-artifact-contract.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PRODUCT = "liboliphaunt-wasix";
const PREFIX = "package_liboliphaunt_wasix_cargo_artifacts.mjs";
const CRATES_IO_MAX_BYTES = 10 * 1024 * 1024;
const EXTENSION_AOT_SPLIT_THRESHOLD_BYTES = 9 * 1024 * 1024;
const EXPECTED_EXTENSION_AOT_TARGETS = new Set(expectedExtensionAotTargets());

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

function run(args, { cwd = ROOT, env = process.env, capture = false, label = args.join(" ") } = {}) {
  if (!capture) {
    console.log(`\n==> ${args.join(" ")}`);
  }
  const result = spawnSync(args[0], args.slice(1), {
    cwd,
    env,
    encoding: capture ? "utf8" : undefined,
    maxBuffer: 200 * 1024 * 1024,
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (result.error) {
    fail(`${label} failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const stderr = capture && result.stderr ? result.stderr.trim() : "";
    fail(`${label} failed${stderr ? `: ${stderr}` : ""}`);
  }
  return capture ? result.stdout : "";
}

function sha256File(file) {
  const digest = createHash("sha256");
  const data = readFileSync(file);
  digest.update(data);
  return digest.digest("hex");
}

function checkedTarMember(name, archive) {
  const normalized = String(name).replaceAll("\\", "/").replace(/\/+$/u, "");
  const parts = normalized.split("/").filter((part) => part && part !== ".");
  if (parts.length === 0 || normalized.startsWith("/") || parts.includes("..")) {
    fail(`${rel(archive)} contains unsafe archive member ${JSON.stringify(name)}`);
  }
  return parts.join("/");
}

function tarZstdMembers(archive) {
  const output = run(["tar", "--zstd", "-tf", archive], {
    capture: true,
    label: `list ${rel(archive)}`,
  });
  const members = output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/\/+$/u, ""));
  for (const member of members) {
    checkedTarMember(member, archive);
  }
  return members;
}

function extractTarZstd(archive, destination) {
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(destination, { recursive: true });
  tarZstdMembers(archive);
  run(["tar", "--zstd", "-xf", archive, "-C", destination]);
}

function writeTarZstdArchive(sourceRoot, output, archiveRoot) {
  mkdirSync(path.dirname(output), { recursive: true });
  rmSync(output, { force: true });
  const tar = createDeterministicTar(sourceRoot, archiveRoot, { fail });
  writeFileSync(output, zstdCompressSync(tar, {
    params: {
      [zlibConstants.ZSTD_c_compressionLevel]: 19,
    },
  }));
}

function payloadFiles(sourceRoot) {
  const files = [];
  if (!existsSync(sourceRoot)) {
    return files;
  }
  for (const entry of fs.readdirSync(sourceRoot, { withFileTypes: true })) {
    const fullPath = path.join(sourceRoot, entry.name);
    if (entry.isDirectory()) {
      files.push(...payloadFiles(fullPath));
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }
  return files.sort(compareText);
}

function targetAssetRoot(extracted) {
  const root = path.join(extracted, "target/oliphaunt-wasix/assets");
  if (!isFile(path.join(root, "manifest.json"))) {
    fail(`${rel(extracted)} does not contain target/oliphaunt-wasix/assets/manifest.json`);
  }
  return root;
}

function targetAotRoot(extracted, triple) {
  const root = path.join(extracted, "target/oliphaunt-wasix/aot", triple);
  if (!isFile(path.join(root, "manifest.json"))) {
    fail(`${rel(extracted)} does not contain target/oliphaunt-wasix/aot/${triple}/manifest.json`);
  }
  return root;
}

function targetIcuRoot(extracted) {
  const root = path.join(extracted, "target/oliphaunt-wasix/icu/share/icu");
  if (!isDirectory(root)) {
    fail(`${rel(extracted)} does not contain target/oliphaunt-wasix/icu/share/icu`);
  }
  return root;
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    fail(`${rel(file)} is not valid JSON: ${error.message}`);
  }
}

function validateRuntimePayload(root) {
  const extensionRoot = path.join(root, "extensions");
  const extensionFiles = isDirectory(extensionRoot) ? payloadFiles(extensionRoot) : [];
  if (extensionFiles.length > 0) {
    fail(`WASIX runtime Cargo payload must not contain extension archives: ${extensionFiles.slice(0, 5).map(rel).join(", ")}`);
  }
  const manifestPath = path.join(root, "manifest.json");
  const manifest = readJson(manifestPath);
  if (JSON.stringify(manifest.extensions) !== "[]") {
    fail(`${rel(manifestPath)} must have an empty extensions array`);
  }
  for (const toolKey of ["pg-dump", "psql"]) {
    if (Object.hasOwn(manifest, toolKey)) {
      fail(`${rel(manifestPath)} must not contain split WASIX tool entry ${toolKey}`);
    }
  }
  for (const required of [
    "oliphaunt.wasix.tar.zst",
    "bin/initdb.wasix.wasm",
    "prepopulated/pgdata-template.tar.zst",
    "prepopulated/pgdata-template.json",
  ]) {
    if (!isFile(path.join(root, required))) {
      fail(`WASIX runtime Cargo payload is missing ${required}`);
    }
  }
  const runtimeMembers = tarZstdMembers(path.join(root, "oliphaunt.wasix.tar.zst"));
  const missingCoreRuntimeFiles = CORE_RUNTIME_ARCHIVE_FILES.filter((member) => !runtimeMembers.includes(member)).sort(compareText);
  if (missingCoreRuntimeFiles.length > 0) {
    fail(`WASIX runtime Cargo payload must bundle postgres/initdb inside oliphaunt.wasix.tar.zst; missing ${missingCoreRuntimeFiles.join(", ")}`);
  }
  const bundledIcu = runtimeMembers.filter((member) => member === "oliphaunt/share/icu" || member.startsWith("oliphaunt/share/icu/"));
  if (bundledIcu.length > 0) {
    fail(`WASIX runtime Cargo payload must not bundle ICU data; found ${bundledIcu[0]} in oliphaunt.wasix.tar.zst`);
  }
  const bundledTools = runtimeMembers.filter((member) => FORBIDDEN_RUNTIME_ARCHIVE_TOOL_FILES.includes(member)).sort(compareText);
  if (bundledTools.length > 0) {
    fail(`WASIX runtime Cargo payload must not bundle standalone tools inside oliphaunt.wasix.tar.zst; found ${bundledTools[0]}`);
  }
}

function validateToolsPayload(root) {
  const actual = new Set(payloadFiles(root).map((file) => relPath(root, file)));
  const expected = new Set(TOOLS_PAYLOAD_FILES);
  if (!sameSet(actual, expected)) {
    fail(`WASIX tools Cargo payload file set mismatch for ${rel(root)}: expected ${JSON.stringify([...expected].sort(compareText))}, got ${JSON.stringify([...actual].sort(compareText))}`);
  }
}

function relPath(root, file) {
  return path.relative(root, file).split(path.sep).join("/");
}

function sameSet(left, right) {
  if (left.size !== right.size) {
    return false;
  }
  for (const item of left) {
    if (!right.has(item)) {
      return false;
    }
  }
  return true;
}

function pruneEmptyDirs(root) {
  if (!isDirectory(root)) {
    return;
  }
  const dirs = [];
  for (const item of fs.readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, item.name);
    if (item.isDirectory()) {
      pruneEmptyDirs(fullPath);
      dirs.push(fullPath);
    }
  }
  for (const dir of dirs.sort(compareText).reverse()) {
    try {
      fs.rmdirSync(dir);
    } catch {
      // Directory still has payload files.
    }
  }
}

function pruneRuntimeArchiveTools(archive, scratch) {
  const runtimeMembers = tarZstdMembers(archive);
  if (!runtimeMembers.some((member) => FORBIDDEN_RUNTIME_ARCHIVE_TOOL_FILES.includes(member))) {
    return;
  }
  extractTarZstd(archive, scratch);
  for (const member of FORBIDDEN_RUNTIME_ARCHIVE_TOOL_FILES) {
    const file = path.join(scratch, member);
    if (existsSync(file)) {
      fs.unlinkSync(file);
    }
  }
  pruneEmptyDirs(scratch);
  const replacement = `${archive}.tmp`;
  writeTarZstdArchive(path.join(scratch, "oliphaunt"), replacement, "oliphaunt");
  fs.renameSync(replacement, archive);
}

function rewriteRuntimeCoreManifest(root) {
  const manifestPath = path.join(root, "manifest.json");
  const manifest = readJson(manifestPath);
  if (!manifest.runtime || typeof manifest.runtime !== "object" || Array.isArray(manifest.runtime)) {
    fail(`${rel(manifestPath)} is missing runtime metadata`);
  }
  manifest.runtime.sha256 = sha256File(path.join(root, "oliphaunt.wasix.tar.zst"));
  manifest.extensions = [];
  delete manifest["pg-dump"];
  delete manifest.psql;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

function splitRuntimeToolsPayload(runtimeRoot, extractRoot) {
  const coreRoot = path.join(extractRoot, "runtime-core-payload");
  const toolsRoot = path.join(extractRoot, "tools-payload");
  rmSync(coreRoot, { recursive: true, force: true });
  rmSync(toolsRoot, { recursive: true, force: true });
  cpSync(runtimeRoot, coreRoot, { recursive: true });
  rmSync(path.join(coreRoot, "extensions"), { recursive: true, force: true });
  const missing = [];
  for (const relative of TOOLS_PAYLOAD_FILES) {
    const source = path.join(runtimeRoot, relative);
    if (!isFile(source)) {
      missing.push(relative);
      continue;
    }
    const destination = path.join(toolsRoot, relative);
    mkdirSync(path.dirname(destination), { recursive: true });
    copyFileSync(source, destination);
    const coreFile = path.join(coreRoot, relative);
    if (existsSync(coreFile)) {
      fs.unlinkSync(coreFile);
    }
  }
  if (missing.length > 0) {
    fail(`WASIX tools Cargo payload is missing ${missing.join(", ")}`);
  }
  pruneRuntimeArchiveTools(
    path.join(coreRoot, "oliphaunt.wasix.tar.zst"),
    path.join(extractRoot, "runtime-archive-core-pruned"),
  );
  rewriteRuntimeCoreManifest(coreRoot);
  pruneEmptyDirs(coreRoot);
  return [coreRoot, toolsRoot];
}

function icuRootContainsData(root) {
  if (!isDirectory(root)) {
    return false;
  }
  for (const name of fs.readdirSync(root).sort(compareText)) {
    const child = path.join(root, name);
    if (isFile(child) && name.startsWith("icudt") && name.endsWith(".dat")) {
      return true;
    }
    if (isDirectory(child) && name.startsWith("icudt") && payloadFiles(child).length > 0) {
      return true;
    }
  }
  return false;
}

function canonicalIcuRoot(root) {
  if (icuRootContainsData(root)) {
    return root;
  }
  const candidates = fs.readdirSync(root)
    .map((name) => path.join(root, name))
    .filter((child) => isDirectory(child) && icuRootContainsData(child))
    .sort(compareText);
  if (candidates.length !== 1) {
    fail(`${rel(root)} must contain exactly one ICU data directory, found ${candidates.length}`);
  }
  return candidates[0];
}

function validateIcuPayload(root) {
  if (!icuRootContainsData(root)) {
    fail(`ICU Cargo payload is missing icudt data under ${rel(root)}`);
  }
}

function writeIcuPayloadArchive(root, payloadRoot) {
  const stage = path.join(path.dirname(payloadRoot), "icu-payload-stage");
  rmSync(stage, { recursive: true, force: true });
  rmSync(payloadRoot, { recursive: true, force: true });
  mkdirSync(path.join(stage, "share"), { recursive: true });
  mkdirSync(payloadRoot, { recursive: true });
  cpSync(root, path.join(stage, "share/icu"), { recursive: true });
  const archive = path.join(payloadRoot, ICU_PAYLOAD_ARCHIVE);
  writeTarZstdArchive(path.join(stage, "share/icu"), archive, "share/icu");
  const members = tarZstdMembers(archive);
  const unexpected = [];
  let hasIcuData = false;
  for (const member of members) {
    if (member === "share/icu") {
      continue;
    }
    if (!member.startsWith("share/icu/")) {
      unexpected.push(member);
      continue;
    }
    const relative = member.slice("share/icu/".length).split("/");
    if (relative.length >= 2 && relative[0].startsWith("icudt")) {
      hasIcuData = true;
    }
  }
  if (!hasIcuData) {
    fail(`${rel(archive)} is missing share/icu/icudt* data`);
  }
  if (unexpected.length > 0) {
    fail(`${rel(archive)} must contain only share/icu data, found ${unexpected[0]}`);
  }
  return payloadRoot;
}

function validateAotPayload(root) {
  const manifestPath = path.join(root, "manifest.json");
  const manifest = readJson(manifestPath);
  const artifacts = manifest.artifacts;
  if (!Array.isArray(artifacts) || artifacts.length === 0) {
    fail(`${rel(manifestPath)} must contain AOT artifacts`);
  }
  const expected = new Set(["manifest.json"]);
  for (const artifact of artifacts) {
    const name = artifact?.name;
    const artifactPath = artifact?.path;
    if (typeof name !== "string" || !name) {
      fail(`${rel(manifestPath)} contains an artifact without a name`);
    }
    if (name.startsWith("extension:")) {
      fail(`WASIX AOT Cargo payload must not contain extension artifact ${name}`);
    }
    if (typeof artifactPath !== "string" || !artifactPath) {
      fail(`AOT artifact ${name} is missing path`);
    }
    checkedTarMember(artifactPath, manifestPath);
    if (!isFile(path.join(root, artifactPath))) {
      fail(`AOT artifact ${name} file is missing: ${rel(path.join(root, artifactPath))}`);
    }
    expected.add(artifactPath);
  }
  const actual = new Set(payloadFiles(root).map((file) => relPath(root, file)));
  if (!sameSet(actual, expected)) {
    fail(`WASIX AOT Cargo payload file set mismatch for ${rel(root)}: expected ${JSON.stringify([...expected].sort(compareText))}, got ${JSON.stringify([...actual].sort(compareText))}`);
  }
}

function splitAotToolsPayload(aotRoot, extractRoot, targetId) {
  const manifestPath = path.join(aotRoot, "manifest.json");
  const manifest = readJson(manifestPath);
  if (!Array.isArray(manifest.artifacts)) {
    fail(`${rel(manifestPath)} must contain an artifacts array`);
  }
  const coreRoot = path.join(extractRoot, `${targetId}-aot-core-payload`);
  const toolsRoot = path.join(extractRoot, `${targetId}-aot-tools-payload`);
  rmSync(coreRoot, { recursive: true, force: true });
  rmSync(toolsRoot, { recursive: true, force: true });
  const coreArtifacts = [];
  const toolsArtifacts = [];
  for (const artifact of manifest.artifacts) {
    if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) {
      fail(`${rel(manifestPath)} contains a non-object artifact`);
    }
    const name = artifact.name;
    const artifactPath = artifact.path;
    if (typeof name !== "string" || typeof artifactPath !== "string") {
      fail(`${rel(manifestPath)} contains an artifact without name/path`);
    }
    const targetRoot = TOOLS_AOT_ARTIFACTS.includes(name) ? toolsRoot : coreRoot;
    const targetArtifacts = TOOLS_AOT_ARTIFACTS.includes(name) ? toolsArtifacts : coreArtifacts;
    const source = path.join(aotRoot, artifactPath);
    if (!isFile(source)) {
      fail(`${rel(manifestPath)} references missing AOT artifact ${artifactPath}`);
    }
    const destination = path.join(targetRoot, artifactPath);
    mkdirSync(path.dirname(destination), { recursive: true });
    copyFileSync(source, destination);
    targetArtifacts.push(artifact);
  }
  const missing = TOOLS_AOT_ARTIFACTS.filter((name) => !toolsArtifacts.some((item) => item.name === name)).sort(compareText);
  if (missing.length > 0) {
    fail(`${rel(manifestPath)} is missing WASIX tools AOT artifacts: ${missing.join(", ")}`);
  }
  if (coreArtifacts.length === 0) {
    fail(`${rel(manifestPath)} generated no core WASIX AOT artifacts`);
  }
  for (const [targetRoot, targetArtifacts] of [[coreRoot, coreArtifacts], [toolsRoot, toolsArtifacts]]) {
    mkdirSync(targetRoot, { recursive: true });
    writeFileSync(
      path.join(targetRoot, "manifest.json"),
      `${JSON.stringify({ ...manifest, artifacts: targetArtifacts }, null, 2)}\n`,
    );
  }
  return [coreRoot, toolsRoot];
}

function patchToolsAotTemplate(crateDir, target) {
  const manifest = path.join(crateDir, "Cargo.toml");
  let text = readFileSync(manifest, "utf8");
  const links = `oliphaunt_artifact_oliphaunt_wasix_tools_aot_${target.replaceAll("-", "_")}`;
  text = text.replace(/^links = "[^"]+"$/mu, `links = "${links}"`);
  text = text.replace(
    /^description = "[^"]+"$/mu,
    `description = "Wasmer AOT pg_dump and psql artifacts for oliphaunt-wasix on ${target}"`,
  );
  writeFileSync(manifest, text);

  const buildRs = path.join(crateDir, "build.rs");
  text = readFileSync(buildRs, "utf8");
  text = text
    .replace('const ARTIFACT_PRODUCT: &str = "liboliphaunt-wasix";', 'const ARTIFACT_PRODUCT: &str = "oliphaunt-wasix-tools";')
    .replace('const ARTIFACT_KIND: &str = "wasix-aot";', 'const ARTIFACT_KIND: &str = "wasix-tools-aot";')
    .replace('.strip_prefix("liboliphaunt-wasix-aot-")', '.strip_prefix("oliphaunt-wasix-tools-aot-")')
    .replace("AOT crate name starts with liboliphaunt-wasix-aot-", "AOT crate name starts with oliphaunt-wasix-tools-aot-");
  writeFileSync(buildRs, text);
}

function rewriteCargoManifest(manifest, { packageName, version, extensionSources, extensionAotSources }) {
  let text = readFileSync(manifest, "utf8");
  text = text.replace(/^name = "[^"]+"$/mu, `name = "${packageName}"`);
  text = text.replace(/^version = "[^"]+"$/mu, `version = "${version}"`);
  text = text.replace(/^publish = false\n?/gmu, "");
  if (packageName === RUNTIME_PACKAGE && extensionSources.length > 0) {
    text = injectRuntimeExtensionDependencies(text, extensionSources, extensionAotSources);
  }
  if (!text.includes("\n[workspace]")) {
    text = `${text.trimEnd()}\n\n[workspace]\n`;
  }
  writeFileSync(manifest, text);
  const packageData = cargoMetadataPackage(manifest);
  if (packageData.name !== packageName || packageData.version !== version) {
    fail(`${rel(manifest)} generated the wrong package metadata: name=${JSON.stringify(packageData.name)}, version=${JSON.stringify(packageData.version)}`);
  }
}

function extensionFeatureName(packageName) {
  if (!packageName.startsWith("oliphaunt-extension-")) {
    fail(`invalid extension package name ${packageName}`);
  }
  return `extension-${packageName.slice("oliphaunt-extension-".length)}`;
}

function injectRuntimeExtensionDependencies(text, extensionSources, extensionAotSources) {
  const dependencyLines = [];
  const targetDependencyLines = new Map();
  const aotByExtension = new Map();
  for (const source of extensionAotSources) {
    const list = aotByExtension.get(source.spec.sqlName) ?? [];
    list.push(source);
    aotByExtension.set(source.spec.sqlName, list);
  }
  for (const source of extensionSources) {
    const packageName = source.spec.name;
    dependencyLines.push(`${packageName} = { version = "=${source.spec.version}", path = "../${packageName}", optional = true }`);
    const feature = extensionFeatureName(source.spec.product);
    const featureDeps = [`dep:${packageName}`];
    for (const aotSource of (aotByExtension.get(source.spec.sqlName) ?? []).sort((left, right) => compareText(left.spec.name, right.spec.name))) {
      featureDeps.push(`dep:${aotSource.spec.name}`);
    }
    const replacement = `${feature} = [${featureDeps.map((dep) => JSON.stringify(dep)).join(", ")}]`;
    const pattern = new RegExp(`^${escapeRegExp(feature)} = \\[[^\\n]*\\]$`, "mu");
    if (pattern.test(text)) {
      text = text.replace(pattern, replacement);
    } else {
      text = text.replace("[features]\n", `[features]\n${replacement}\n`);
    }
  }
  for (const source of extensionAotSources) {
    const cfg = AOT_TARGET_CFGS[source.spec.target];
    if (cfg === undefined) {
      fail(`unsupported extension AOT target ${source.spec.target}`);
    }
    const line = `${source.spec.name} = { version = "=${source.spec.version}", path = "../${source.spec.name}", optional = true }`;
    const lines = targetDependencyLines.get(cfg) ?? [];
    lines.push(line);
    targetDependencyLines.set(cfg, lines);
  }
  if (dependencyLines.length > 0) {
    text = text.replace("\n[build-dependencies]", `\n${dependencyLines.join("\n")}\n\n[build-dependencies]`);
  }
  if (targetDependencyLines.size > 0) {
    const blocks = [...targetDependencyLines.entries()]
      .sort(([left], [right]) => compareText(left, right))
      .map(([cfg, lines]) => `[target.'${cfg}'.dependencies]\n${lines.sort(compareText).join("\n")}`);
    text = text.replace("\n[build-dependencies]", `\n${blocks.join("\n\n")}\n\n[build-dependencies]`);
  }
  return text;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function copyPackageSource(spec, sourceRoot, version, extensionSources, extensionAotSources) {
  const crateDir = path.join(sourceRoot, spec.name);
  if (existsSync(crateDir)) {
    fail(`duplicate generated WASIX Cargo package source: ${rel(crateDir)}`);
  }
  cpSync(spec.templateDir, crateDir, {
    recursive: true,
    filter: (source) => !["target", "payload", "artifacts"].includes(path.basename(source)),
  });
  if (spec.kind === "wasix-tools-aot") {
    patchToolsAotTemplate(crateDir, spec.target);
  }
  cpSync(spec.payloadRoot, path.join(crateDir, spec.payloadDirName), { recursive: true });
  rewriteCargoManifest(path.join(crateDir, "Cargo.toml"), {
    packageName: spec.name,
    version,
    extensionSources,
    extensionAotSources,
  });
  return crateDir;
}

function cargoMetadataPackage(manifest) {
  const stdout = run(["cargo", "metadata", "--no-deps", "--format-version", "1", "--manifest-path", manifest], {
    capture: true,
    label: `cargo metadata ${rel(manifest)}`,
  });
  const data = JSON.parse(stdout);
  if (!Array.isArray(data.packages) || data.packages.length !== 1 || typeof data.packages[0] !== "object") {
    fail(`cargo metadata for ${rel(manifest)} did not return exactly one package`);
  }
  return data.packages[0];
}

function cargoPackage(crateDir, targetDir, { noVerify = false } = {}) {
  const manifest = path.join(crateDir, "Cargo.toml");
  const packageData = cargoMetadataPackage(manifest);
  const command = [
    "cargo",
    "package",
    "--manifest-path",
    manifest,
    "--target-dir",
    targetDir,
    "--allow-dirty",
  ];
  if (noVerify) {
    command.push("--no-verify");
  }
  run(command, {
    env: { ...process.env, OLIPHAUNT_ARTIFACT_CRATE_REQUIRE_PAYLOAD: "1" },
  });
  const cratePath = path.join(targetDir, "package", `${packageData.name}-${packageData.version}.crate`);
  if (!isFile(cratePath)) {
    fail(`cargo package did not create ${rel(cratePath)}`);
  }
  return cratePath;
}

function packagedManifestText(text) {
  return text.replace(/, path = "\.\.\/[^"]+"/gu, "");
}

function cargoPackageWithoutDependencyResolution(crateDir, targetDir) {
  const manifest = path.join(crateDir, "Cargo.toml");
  const packageData = cargoMetadataPackage(manifest);
  const packageRoot = `${packageData.name}-${packageData.version}`;
  const stageRoot = path.join(targetDir, "manual-package-stage");
  const stageDir = path.join(stageRoot, packageRoot);
  const cratePath = path.join(targetDir, "package", `${packageRoot}.crate`);
  rmSync(stageDir, { recursive: true, force: true });
  mkdirSync(path.dirname(cratePath), { recursive: true });
  cpSync(crateDir, stageDir, {
    recursive: true,
    filter: (source) => !["target", ".git"].includes(path.basename(source)),
  });
  const stagedManifest = path.join(stageDir, "Cargo.toml");
  writeFileSync(stagedManifest, packagedManifestText(readFileSync(stagedManifest, "utf8")));
  cargoMetadataPackage(stagedManifest);
  rmSync(cratePath, { force: true });
  writeFileSync(cratePath, gzipSync(createDeterministicTar(stageDir, packageRoot, { fail }), { mtime: 0 }));
  if (!isFile(cratePath)) {
    fail(`manual package did not create ${rel(cratePath)}`);
  }
  return cratePath;
}

function validateCrateSize(cratePath) {
  const size = statSync(cratePath).size;
  if (size > CRATES_IO_MAX_BYTES) {
    fail(`${rel(cratePath)} is ${size} bytes, above the crates.io 10 MiB package limit; reduce the WASIX Cargo payload before publishing`);
  }
}

function packageSpec(spec, { version, sourceRoot, outputDir, cargoTargetDir, extensionSources, extensionAotSources }) {
  const crateDir = copyPackageSource(spec, sourceRoot, version, extensionSources, extensionAotSources);
  const cratePath = spec.name === RUNTIME_PACKAGE && extensionSources.length > 0
    ? cargoPackageWithoutDependencyResolution(crateDir, cargoTargetDir)
    : cargoPackage(crateDir, cargoTargetDir);
  validateCrateSize(cratePath);
  const output = path.join(outputDir, path.basename(cratePath));
  copyFileSync(cratePath, output);
  return {
    name: spec.name,
    manifestPath: path.join(crateDir, "Cargo.toml"),
    cratePath: output,
    target: spec.target,
    kind: spec.kind,
    size: statSync(output).size,
    sha256: sha256File(output),
  };
}

function wasixExtensionAotPartPackageName(packageName, index) {
  return `${packageName}-part-${String(index).padStart(3, "0")}`;
}

function rustCrateIdent(packageName) {
  return packageName.replaceAll("-", "_");
}

function discoverExtensionManifests(roots) {
  const manifests = [];
  for (const root of roots) {
    if (isFile(root) && path.basename(root) === "extension-artifacts.json") {
      manifests.push(root);
      continue;
    }
    if (isDirectory(root)) {
      for (const file of payloadFiles(root)) {
        if (path.basename(file) === "extension-artifacts.json") {
          manifests.push(file);
        }
      }
    }
  }
  return [...new Set(manifests)].sort(compareText);
}

function extensionWasixAsset(extensionDir, manifest) {
  for (const asset of manifest.assets ?? []) {
    if (
      asset &&
      typeof asset === "object" &&
      asset.family === "wasix" &&
      asset.kind === "wasix-runtime" &&
      asset.target === "wasix-portable" &&
      typeof asset.name === "string"
    ) {
      const assetPath = path.join(extensionDir, "release-assets", asset.name);
      if (isFile(assetPath)) {
        return assetPath;
      }
    }
  }
  return null;
}

function extensionAotSpecs(extensionDir, { product, version, sqlName }) {
  const aotRoot = path.join(extensionDir, "wasix-aot");
  if (!isDirectory(aotRoot)) {
    return [];
  }
  const specs = [];
  const seenTargets = new Set();
  for (const targetDir of fs.readdirSync(aotRoot).map((name) => path.join(aotRoot, name)).filter(isDirectory).sort(compareText)) {
    const manifestPath = path.join(targetDir, "manifest.json");
    if (!isFile(manifestPath)) {
      continue;
    }
    const data = readJson(manifestPath);
    const target = data["target-triple"];
    const artifacts = data.artifacts;
    if (typeof target !== "string" || !target) {
      fail(`${rel(manifestPath)} is missing target-triple`);
    }
    if (seenTargets.has(target)) {
      fail(`${rel(aotRoot)} has duplicate extension AOT target ${target}`);
    }
    if (!Array.isArray(artifacts) || artifacts.length === 0) {
      fail(`${rel(manifestPath)} must contain extension AOT artifacts`);
    }
    const expectedPrefix = `extension:${sqlName}`;
    for (const artifact of artifacts) {
      const name = artifact?.name;
      const artifactPath = artifact?.path;
      if (typeof name !== "string" || !(name === expectedPrefix || name.startsWith(`${expectedPrefix}:`))) {
        fail(`${rel(manifestPath)} contains AOT artifact ${JSON.stringify(name)} for ${sqlName}`);
      }
      if (typeof artifactPath !== "string" || !artifactPath) {
        fail(`${rel(manifestPath)} artifact ${JSON.stringify(name)} is missing path`);
      }
      checkedTarMember(artifactPath, manifestPath);
      if (!isFile(path.join(path.dirname(manifestPath), artifactPath))) {
        fail(`${rel(manifestPath)} references missing AOT artifact ${artifactPath}`);
      }
    }
    seenTargets.add(target);
    specs.push({
      name: wasixExtensionAotPackageName(product, target),
      version,
      sqlName,
      target,
      sourceDir: path.dirname(manifestPath),
    });
  }
  return specs.sort((left, right) => compareText(left.target, right.target));
}

function extensionCargoSpecs(extensionRoots) {
  const specs = [];
  for (const manifestPath of discoverExtensionManifests(extensionRoots)) {
    const manifest = readJson(manifestPath);
    const { product, version, sqlName, nativeModuleStem } = manifest;
    if (![product, version, sqlName].every((value) => typeof value === "string" && value)) {
      fail(`${rel(manifestPath)} is missing product, version, or sqlName`);
    }
    const archive = extensionWasixAsset(path.dirname(manifestPath), manifest);
    if (archive === null) {
      continue;
    }
    specs.push({
      name: wasixExtensionPackageName(product),
      product,
      version,
      sqlName,
      archive,
      sha256: sha256File(archive),
      size: statSync(archive).size,
      requiresAot: typeof nativeModuleStem === "string" && Boolean(nativeModuleStem),
      aotTargets: extensionAotSpecs(path.dirname(manifestPath), { product, version, sqlName }),
    });
  }
  return specs.sort((left, right) => compareText(left.name, right.name));
}

function validateExtensionAotCoverage(extensionSpecs) {
  for (const spec of extensionSpecs) {
    if (!spec.requiresAot) {
      continue;
    }
    const actualTargets = new Set(spec.aotTargets.map((aotSpec) => aotSpec.target));
    if (!sameSet(actualTargets, EXPECTED_EXTENSION_AOT_TARGETS)) {
      fail(`${spec.product} has a WASIX native module but incomplete extension AOT artifacts; expected=${JSON.stringify([...EXPECTED_EXTENSION_AOT_TARGETS].sort(compareText))}, actual=${JSON.stringify([...actualTargets].sort(compareText))}`);
    }
  }
}

function writeExtensionCargoSource(spec, sourceRoot) {
  const crateDir = path.join(sourceRoot, spec.name);
  if (existsSync(crateDir)) {
    fail(`duplicate generated WASIX extension Cargo package source: ${rel(crateDir)}`);
  }
  mkdirSync(path.join(crateDir, "src"), { recursive: true });
  mkdirSync(path.join(crateDir, "payload"), { recursive: true });
  copyFileSync(spec.archive, path.join(crateDir, "payload/extension.tar.zst"));
  writeFileSync(path.join(crateDir, "README.md"), [
    `# ${spec.name}`,
    "",
    `Cargo artifact package for the \`${spec.sqlName}\` Oliphaunt WASIX extension.`,
    "",
  ].join("\n"));
  writeFileSync(path.join(crateDir, "Cargo.toml"), [
    "[package]",
    `name = "${spec.name}"`,
    `version = "${spec.version}"`,
    'edition = "2024"',
    'rust-version = "1.93"',
    `description = "Oliphaunt WASIX artifact package for the ${spec.sqlName} PostgreSQL extension"`,
    'repository = "https://github.com/f0rr0/oliphaunt"',
    'homepage = "https://oliphaunt.dev"',
    'license = "MIT AND Apache-2.0 AND PostgreSQL"',
    'include = ["Cargo.toml", "README.md", "src/**", "payload/**"]',
    "",
    "[lib]",
    'path = "src/lib.rs"',
    "",
    "[workspace]",
    "",
  ].join("\n"));
  writeFileSync(path.join(crateDir, "src/lib.rs"), [
    "#![deny(unsafe_code)]",
    "",
    `pub const SQL_NAME: &str = "${spec.sqlName}";`,
    `pub const ARCHIVE_SHA256: &str = "${spec.sha256}";`,
    `pub const ARCHIVE_SIZE: u64 = ${spec.size};`,
    "",
    "pub fn archive() -> Option<&'static [u8]> {",
    '    Some(include_bytes!("../payload/extension.tar.zst"))',
    "}",
    "",
  ].join("\n"));
  return { spec, sourceDir: crateDir };
}

function writeExtensionAotCargoSource(spec, sourceRoot) {
  const crateDir = path.join(sourceRoot, spec.name);
  if (existsSync(crateDir)) {
    fail(`duplicate generated WASIX extension AOT Cargo package source: ${rel(crateDir)}`);
  }
  mkdirSync(path.join(crateDir, "src"), { recursive: true });
  const manifestPath = path.join(spec.sourceDir, "manifest.json");
  const manifest = readJson(manifestPath);
  const artifacts = [];
  for (const artifact of [...(manifest.artifacts ?? [])].sort((left, right) => compareText(left?.name ?? "", right?.name ?? ""))) {
    const name = artifact?.name;
    const artifactPath = artifact?.path;
    if (typeof name !== "string" || typeof artifactPath !== "string") {
      fail(`${rel(manifestPath)} contains an AOT artifact without name/path`);
    }
    const source = path.join(spec.sourceDir, artifactPath);
    if (!isFile(source)) {
      fail(`${rel(manifestPath)} references missing AOT artifact ${artifactPath}`);
    }
    artifacts.push([name, artifactPath, source, statSync(source).size]);
  }
  if (artifacts.length === 0) {
    fail(`${rel(manifestPath)} must contain extension AOT artifacts`);
  }
  const splitParts = artifacts.reduce((sum, item) => sum + item[3], 0) > EXTENSION_AOT_SPLIT_THRESHOLD_BYTES;
  const partSources = [];
  if (splitParts) {
    mkdirSync(path.join(crateDir, "artifacts"), { recursive: true });
    copyFileSync(manifestPath, path.join(crateDir, "artifacts/manifest.json"));
    artifacts.forEach(([name, artifactPath, source], index) => {
      const partName = wasixExtensionAotPartPackageName(spec.name, index);
      const partDir = path.join(sourceRoot, partName);
      if (existsSync(partDir)) {
        fail(`duplicate generated WASIX extension AOT Cargo package source: ${rel(partDir)}`);
      }
      mkdirSync(path.join(partDir, "src"), { recursive: true });
      const destination = path.join(partDir, "artifacts", artifactPath);
      mkdirSync(path.dirname(destination), { recursive: true });
      copyFileSync(source, destination);
      writeFileSync(path.join(partDir, "README.md"), [
        `# ${partName}`,
        "",
        `Cargo artifact package part for \`${spec.sqlName}\` Oliphaunt WASIX AOT artifacts on \`${spec.target}\`.`,
        "",
      ].join("\n"));
      writeFileSync(path.join(partDir, "Cargo.toml"), [
        "[package]",
        `name = "${partName}"`,
        `version = "${spec.version}"`,
        'edition = "2024"',
        'rust-version = "1.93"',
        `description = "Oliphaunt WASIX AOT artifact package part for the ${spec.sqlName} PostgreSQL extension on ${spec.target}"`,
        'repository = "https://github.com/f0rr0/oliphaunt"',
        'homepage = "https://oliphaunt.dev"',
        'license = "MIT AND Apache-2.0 AND PostgreSQL"',
        'include = ["Cargo.toml", "README.md", "src/**", "artifacts/**"]',
        "",
        "[lib]",
        'path = "src/lib.rs"',
        "",
        "[workspace]",
        "",
      ].join("\n"));
      writeFileSync(path.join(partDir, "src/lib.rs"), [
        "#![deny(unsafe_code)]",
        "",
        `pub const SQL_NAME: &str = "${spec.sqlName}";`,
        `pub const TARGET_TRIPLE: &str = "${spec.target}";`,
        "",
        "pub fn aot_artifact_bytes(name: &str) -> Option<&'static [u8]> {",
        "    match name {",
        `        ${JSON.stringify(name)} => Some(include_bytes!("../artifacts/${artifactPath}")),`,
        "        _ => None,",
        "    }",
        "}",
        "",
      ].join("\n"));
      partSources.push({
        name: partName,
        version: spec.version,
        sqlName: spec.sqlName,
        target: spec.target,
        sourceDir: partDir,
      });
    });
  } else {
    cpSync(spec.sourceDir, path.join(crateDir, "artifacts"), { recursive: true });
  }

  const dependencyLines = partSources.map((part) => `${part.name} = { version = "=${part.version}", path = "../${part.name}" }`);
  writeFileSync(path.join(crateDir, "README.md"), [
    `# ${spec.name}`,
    "",
    `Cargo artifact package for \`${spec.sqlName}\` Oliphaunt WASIX AOT artifacts on \`${spec.target}\`.`,
    "",
  ].join("\n"));
  writeFileSync(path.join(crateDir, "Cargo.toml"), [
    "[package]",
    `name = "${spec.name}"`,
    `version = "${spec.version}"`,
    'edition = "2024"',
    'rust-version = "1.93"',
    `description = "Oliphaunt WASIX AOT artifact package for the ${spec.sqlName} PostgreSQL extension on ${spec.target}"`,
    'repository = "https://github.com/f0rr0/oliphaunt"',
    'homepage = "https://oliphaunt.dev"',
    'license = "MIT AND Apache-2.0 AND PostgreSQL"',
    'include = ["Cargo.toml", "README.md", "src/**", "artifacts/**"]',
    "",
    "[lib]",
    'path = "src/lib.rs"',
    "",
    ...(partSources.length > 0 ? ["[dependencies]", ...dependencyLines, ""] : []),
    "[workspace]",
    "",
  ].join("\n"));

  const artifactBytesBody = partSources.length > 0
    ? partSources.flatMap((part) => [
      `    if let Some(bytes) = ${rustCrateIdent(part.name)}::aot_artifact_bytes(name) {`,
      "        return Some(bytes);",
      "    }",
    ])
    : [
      "    match name {",
      ...artifacts.map(([name, artifactPath]) => `        ${JSON.stringify(name)} => Some(include_bytes!("../artifacts/${artifactPath}")),`),
      "        _ => None,",
      "    }",
    ];
  writeFileSync(path.join(crateDir, "src/lib.rs"), [
    "#![deny(unsafe_code)]",
    "",
    `pub const SQL_NAME: &str = "${spec.sqlName}";`,
    `pub const TARGET_TRIPLE: &str = "${spec.target}";`,
    'pub const MANIFEST_JSON: &str = include_str!("../artifacts/manifest.json");',
    "",
    "pub fn aot_manifest_json() -> Option<&'static str> {",
    "    Some(MANIFEST_JSON)",
    "}",
    "",
    "pub fn aot_artifact_bytes(name: &str) -> Option<&'static [u8]> {",
    ...artifactBytesBody,
    ...(partSources.length > 0 ? ["    None"] : []),
    "}",
    "",
  ].join("\n"));
  return { spec, sourceDir: crateDir, partSources };
}

function packageExtensionSource(source, { outputDir, cargoTargetDir }) {
  const cratePath = cargoPackage(source.sourceDir, cargoTargetDir);
  validateCrateSize(cratePath);
  const output = path.join(outputDir, path.basename(cratePath));
  copyFileSync(cratePath, output);
  return {
    name: source.spec.name,
    manifestPath: path.join(source.sourceDir, "Cargo.toml"),
    cratePath: output,
    target: "wasix-portable",
    kind: "wasix-extension",
    size: statSync(output).size,
    sha256: sha256File(output),
  };
}

function packageExtensionAotSource(source, { outputDir, cargoTargetDir }) {
  const packages = [];
  for (const part of source.partSources ?? []) {
    const cratePath = cargoPackage(part.sourceDir, cargoTargetDir);
    validateCrateSize(cratePath);
    const output = path.join(outputDir, path.basename(cratePath));
    copyFileSync(cratePath, output);
    packages.push({
      name: part.name,
      manifestPath: path.join(part.sourceDir, "Cargo.toml"),
      cratePath: output,
      target: part.target,
      kind: "wasix-extension-aot",
      size: statSync(output).size,
      sha256: sha256File(output),
    });
  }
  const cratePath = source.partSources?.length > 0
    ? cargoPackageWithoutDependencyResolution(source.sourceDir, cargoTargetDir)
    : cargoPackage(source.sourceDir, cargoTargetDir);
  validateCrateSize(cratePath);
  const output = path.join(outputDir, path.basename(cratePath));
  copyFileSync(cratePath, output);
  packages.push({
    name: source.spec.name,
    manifestPath: path.join(source.sourceDir, "Cargo.toml"),
    cratePath: output,
    target: source.spec.target,
    kind: "wasix-extension-aot",
    size: statSync(output).size,
    sha256: sha256File(output),
  });
  return packages;
}

function packageSpecs(assetDir, extractRoot, version) {
  const specs = [];
  const runtimeArchive = path.join(assetDir, `liboliphaunt-wasix-${version}-runtime-portable.tar.zst`);
  if (!isFile(runtimeArchive)) {
    fail(`missing WASIX portable runtime release asset: ${rel(runtimeArchive)}`);
  }
  const runtimeExtract = path.join(extractRoot, "runtime-extracted");
  extractTarZstd(runtimeArchive, runtimeExtract);
  const runtimeRoot = targetAssetRoot(runtimeExtract);
  const [runtimeCoreRoot, toolsRoot] = splitRuntimeToolsPayload(runtimeRoot, extractRoot);
  validateRuntimePayload(runtimeCoreRoot);
  validateToolsPayload(toolsRoot);
  specs.push({
    name: RUNTIME_PACKAGE,
    target: "portable",
    kind: "wasix-runtime",
    templateDir: path.join(ROOT, "src/runtimes/liboliphaunt/wasix/crates/assets"),
    payloadRoot: runtimeCoreRoot,
    payloadDirName: "payload",
  });
  specs.push({
    name: TOOLS_PACKAGE,
    target: "portable",
    kind: "wasix-tools",
    templateDir: path.join(ROOT, "src/runtimes/liboliphaunt/wasix/crates/tools"),
    payloadRoot: toolsRoot,
    payloadDirName: "payload",
  });

  const icuArchive = path.join(assetDir, `liboliphaunt-wasix-${version}-icu-data.tar.zst`);
  if (!isFile(icuArchive)) {
    fail(`missing WASIX ICU data release asset: ${rel(icuArchive)}`);
  }
  const icuExtract = path.join(extractRoot, "icu-extracted");
  extractTarZstd(icuArchive, icuExtract);
  const icuRoot = canonicalIcuRoot(targetIcuRoot(icuExtract));
  validateIcuPayload(icuRoot);
  const icuPayloadRoot = writeIcuPayloadArchive(icuRoot, path.join(extractRoot, "icu-payload"));
  specs.push({
    name: ICU_PACKAGE,
    target: "portable",
    kind: "icu-data",
    templateDir: path.join(ROOT, "src/runtimes/liboliphaunt/icu"),
    payloadRoot: icuPayloadRoot,
    payloadDirName: "payload",
  });

  for (const [targetId, packageName] of Object.entries(AOT_PACKAGES).sort(([left], [right]) => compareText(left, right))) {
    const archive = path.join(assetDir, `liboliphaunt-wasix-${version}-runtime-aot-${targetId}.tar.zst`);
    if (!isFile(archive)) {
      fail(`missing WASIX AOT release asset: ${rel(archive)}`);
    }
    const extracted = path.join(extractRoot, `${targetId}-extracted`);
    extractTarZstd(archive, extracted);
    const triple = AOT_TARGET_TRIPLES[targetId];
    const aotRoot = targetAotRoot(extracted, triple);
    validateAotPayload(aotRoot);
    const [aotCoreRoot, toolsAotRoot] = splitAotToolsPayload(aotRoot, extractRoot, targetId);
    specs.push({
      name: packageName,
      target: triple,
      kind: "wasix-aot",
      templateDir: path.join(ROOT, "src/runtimes/liboliphaunt/wasix/crates/aot", triple),
      payloadRoot: aotCoreRoot,
      payloadDirName: "artifacts",
    });
    specs.push({
      name: TOOLS_AOT_PACKAGES[targetId],
      target: triple,
      kind: "wasix-tools-aot",
      templateDir: path.join(ROOT, "src/runtimes/liboliphaunt/wasix/crates/tools-aot", triple),
      payloadRoot: toolsAotRoot,
      payloadDirName: "artifacts",
    });
  }
  return specs;
}

function writePackagesManifest(packages, outputDir) {
  const data = {
    schema: WASIX_CARGO_ARTIFACT_SCHEMA,
    product: PRODUCT,
    packages: packages.map((packageData) => ({
      name: packageData.name,
      target: packageData.target,
      kind: packageData.kind,
      role: "artifact",
      manifestPath: rel(packageData.manifestPath),
      cratePath: rel(packageData.cratePath),
      size: packageData.size,
      sha256: packageData.sha256,
    })),
  };
  writeFileSync(path.join(outputDir, "packages.json"), `${JSON.stringify(data, null, 2)}\n`);
}

function parseArgs(argv) {
  const args = {
    assetDir: "target/oliphaunt-wasix/release-assets",
    extensionsOnly: false,
    outputDir: "target/oliphaunt-wasix/cargo-artifacts",
    version: null,
    extensionArtifactRoots: [],
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--help" || value === "-h") {
      console.log("usage: tools/release/package_liboliphaunt_wasix_cargo_artifacts.mjs [--asset-dir DIR] [--extensions-only] [--output-dir DIR] [--version VERSION] [--extension-artifact-root DIR...]");
      process.exit(0);
    } else if (value === "--asset-dir") {
      args.assetDir = requiredValue(argv, ++index, value);
    } else if (value.startsWith("--asset-dir=")) {
      args.assetDir = value.slice("--asset-dir=".length);
    } else if (value === "--extensions-only") {
      args.extensionsOnly = true;
    } else if (value === "--output-dir") {
      args.outputDir = requiredValue(argv, ++index, value);
    } else if (value.startsWith("--output-dir=")) {
      args.outputDir = value.slice("--output-dir=".length);
    } else if (value === "--version") {
      args.version = requiredValue(argv, ++index, value);
    } else if (value.startsWith("--version=")) {
      args.version = value.slice("--version=".length);
    } else if (value === "--extension-artifact-root") {
      args.extensionArtifactRoots.push(requiredValue(argv, ++index, value));
    } else if (value.startsWith("--extension-artifact-root=")) {
      args.extensionArtifactRoots.push(value.slice("--extension-artifact-root=".length));
    } else {
      fail(`unknown argument ${value}`);
    }
  }
  if (args.extensionArtifactRoots.length === 0) {
    args.extensionArtifactRoots.push("target/extension-artifacts");
  }
  args.version ??= currentProductVersionSync(PRODUCT, PREFIX);
  return args;
}

function requiredValue(argv, index, option) {
  const value = argv[index];
  if (value === undefined || value.startsWith("--")) {
    fail(`${option} requires a value`);
  }
  return value;
}

function repoPath(value) {
  return path.isAbsolute(value) ? value : path.join(ROOT, value);
}

function main(argv) {
  const args = parseArgs(argv);
  const assetDir = repoPath(args.assetDir);
  const outputDir = repoPath(args.outputDir);
  const extensionRoots = args.extensionArtifactRoots.map(repoPath);
  if (!args.extensionsOnly && !isDirectory(assetDir)) {
    fail(`WASIX release asset directory does not exist: ${rel(assetDir)}`);
  }

  const sourceRoot = path.join(ROOT, "target/oliphaunt-wasix/cargo-package-sources");
  const extractRoot = path.join(ROOT, "target/oliphaunt-wasix/cargo-package-extracted");
  const cargoTargetDir = path.join(ROOT, "target/oliphaunt-wasix/cargo-package-target");
  rmSync(sourceRoot, { recursive: true, force: true });
  rmSync(extractRoot, { recursive: true, force: true });
  rmSync(outputDir, { recursive: true, force: true });
  rmSync(cargoTargetDir, { recursive: true, force: true });
  mkdirSync(sourceRoot, { recursive: true });
  mkdirSync(extractRoot, { recursive: true });
  mkdirSync(outputDir, { recursive: true });

  const extensionSpecs = extensionCargoSpecs(extensionRoots);
  validateExtensionAotCoverage(extensionSpecs);
  const extensionSources = extensionSpecs.map((spec) => writeExtensionCargoSource(spec, sourceRoot));
  const extensionAotSources = extensionSpecs.flatMap((spec) => spec.aotTargets.map((aotSpec) => writeExtensionAotCargoSource(aotSpec, sourceRoot)));
  const specs = args.extensionsOnly ? [] : packageSpecs(assetDir, extractRoot, args.version);
  const packages = [
    ...extensionSources.map((source) => packageExtensionSource(source, { outputDir, cargoTargetDir })),
    ...extensionAotSources.flatMap((source) => packageExtensionAotSource(source, { outputDir, cargoTargetDir })),
    ...specs.map((spec) => packageSpec(spec, {
      version: args.version,
      sourceRoot,
      outputDir,
      cargoTargetDir,
      extensionSources,
      extensionAotSources,
    })),
  ];
  writePackagesManifest(packages, outputDir);
  console.log(args.extensionsOnly
    ? "generated WASIX extension Cargo artifact crates:"
    : "generated liboliphaunt-wasix Cargo artifact crates:");
  for (const packageData of packages) {
    console.log(`${packageData.name} ${rel(packageData.cratePath)} ${packageData.size} bytes`);
  }
}

main(Bun.argv.slice(2));
