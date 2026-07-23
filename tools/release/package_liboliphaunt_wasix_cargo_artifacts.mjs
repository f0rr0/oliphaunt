#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as zlibConstants, zstdCompressSync } from "node:zlib";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createDeterministicTar,
  manualCargoPackageSource,
} from "./cargo-source-package.mjs";
import { RUST_BUILD_SCRIPT_SHA256 } from "./rust-build-script-sha256.mjs";
import { captureCommandOutput } from "../dev/capture-command-output.mjs";
import { assertWasixAotArtifactPayloads } from "./check-liboliphaunt-wasix-release-assets.mjs";
import {
  canonicalGzipSync,
  portableMemberName,
  readPortableArchiveEntries,
  readPortableTarZstdBufferEntries,
} from "./portable-archive.mjs";
import { compareText } from "./release-graph.mjs";
import { currentProductVersionSync, extensionMetadata, extensionSqlNames } from "./release-artifact-targets.mjs";
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
import { assertCanonicalWasixAotManifest } from "./wasix-aot-manifest.mjs";
import {
  assertReleaseNoticesInArchive,
  assertReleaseNoticesInDirectory,
  releaseNoticeRows,
  releaseProfilePackageLicense,
  stageReleaseNotices,
} from "./release-notices.mjs";
import {
  assertExtensionUpstreamLicensesInArchive,
  assertExtensionUpstreamLicensesInDirectory,
  extensionRegistryLicense,
  stageExtensionUpstreamLicenses,
} from "./extension-upstream-licenses.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PRODUCT = "liboliphaunt-wasix";
const PREFIX = "package_liboliphaunt_wasix_cargo_artifacts.mjs";
const CRATES_IO_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_EXTENSION_PART_BYTES = 8 * 1024 * 1024;
const EXPECTED_EXTENSION_AOT_TARGETS = new Set(expectedExtensionAotTargets());

function fail(message) {
  throw new Error(`${PREFIX}: ${message}`);
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
    const metadata = lstatSync(file);
    return metadata.isFile() && !metadata.isSymbolicLink();
  } catch {
    return false;
  }
}

function isDirectory(file) {
  try {
    const metadata = lstatSync(file);
    return metadata.isDirectory() && !metadata.isSymbolicLink();
  } catch {
    return false;
  }
}

function run(args, { cwd = ROOT, env = process.env, capture = false, label = args.join(" ") } = {}) {
  if (!capture) {
    console.log(`\n==> ${args.join(" ")}`);
  }
  const result = capture
    ? captureCommandOutput(args[0], args.slice(1), {
        cwd,
        env,
        label,
        maxOutputBytes: 200 * 1024 * 1024,
      })
    : spawnSync(args[0], args.slice(1), {
        cwd,
        env,
        stdio: "inherit",
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
  if (typeof name !== "string" || name.length === 0) {
    fail(`${rel(archive)} contains an empty archive member path`);
  }
  let normalized;
  try {
    normalized = portableMemberName(name, "file", rel(archive));
  } catch (error) {
    fail(error.message);
  }
  if (normalized !== name) {
    fail(`${rel(archive)} archive member path must already be normalized: ${JSON.stringify(name)}`);
  }
  return normalized;
}

function tarZstdMembers(archive) {
  try {
    return [...readPortableArchiveEntries(archive, { format: "tar.zst" }).keys()];
  } catch (error) {
    fail(error.message);
  }
}

export function extractTarZstd(archive, destination) {
  let entries;
  try {
    entries = readPortableArchiveEntries(archive, { format: "tar.zst" });
  } catch (error) {
    fail(error.message);
  }
  rmSync(destination, { recursive: true, force: true });
  const root = path.resolve(destination);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);

  const outputPath = (member) => {
    const output = path.resolve(root, ...member.split("/"));
    if (!output.startsWith(`${root}${path.sep}`)) {
      fail(`${rel(archive)} resolved outside its extraction destination: ${member}`);
    }
    return output;
  };
  const directoryModes = new Map();
  for (const entry of entries.values()) {
    const parts = entry.name.split("/");
    const parentLength = entry.isDirectory ? parts.length : parts.length - 1;
    for (let length = 1; length <= parentLength; length += 1) {
      const member = parts.slice(0, length).join("/");
      if (!directoryModes.has(member)) directoryModes.set(member, 0o755);
    }
    if (entry.isDirectory) directoryModes.set(entry.name, entry.mode & 0o777);
  }
  const directories = [...directoryModes].sort(([left], [right]) => {
    const depth = left.split("/").length - right.split("/").length;
    return depth || compareText(left, right);
  });
  for (const [member, finalMode] of directories) {
    const output = outputPath(member);
    mkdirSync(output, { recursive: true, mode: finalMode | 0o700 });
    // Creation modes are filtered by the process umask. Keep the complete
    // tree owner-writable/traversable until every descendant has been staged.
    chmodSync(output, finalMode | 0o700);
  }

  const files = [...entries.values()]
    .filter((entry) => !entry.isDirectory)
    .sort((left, right) => compareText(left.name, right.name));
  for (const entry of files) {
    const output = outputPath(entry.name);
    if (!entry.isFile || entry.isSymbolicLink) {
      fail(`${rel(archive)} contains a non-regular extraction member ${entry.name}`);
    }
    writeFileSync(output, entry.data(), { flag: "wx", mode: 0o600 });
    // chmod after creation makes the archive contract independent of umask.
    chmodSync(output, entry.mode & 0o777);
  }

  for (const [member, finalMode] of directories.reverse()) {
    chmodSync(outputPath(member), finalMode);
  }
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

function validateCanonicalAotManifest(manifest, manifestPath, expectedTarget) {
  try {
    assertCanonicalWasixAotManifest(manifest, {
      context: rel(manifestPath),
      expectedTarget,
    });
  } catch (error) {
    fail(error.message);
  }
}

export function validateRuntimePayload(root) {
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
  if (manifest.runtime === null || Array.isArray(manifest.runtime) || typeof manifest.runtime !== "object") {
    fail(`${rel(manifestPath)} is missing runtime metadata`);
  }
  if (manifest.runtime.archive !== "oliphaunt.wasix.tar.zst") {
    fail(`${rel(manifestPath)} runtime.archive must be oliphaunt.wasix.tar.zst`);
  }
  if (typeof manifest.runtime.sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(manifest.runtime.sha256)) {
    fail(`${rel(manifestPath)} runtime.sha256 must be a lowercase SHA-256 digest`);
  }
  const runtimeArchivePath = path.join(root, "oliphaunt.wasix.tar.zst");
  const runtimeBytes = readFileSync(runtimeArchivePath);
  const runtimeSha256 = createHash("sha256").update(runtimeBytes).digest("hex");
  if (runtimeSha256 !== manifest.runtime.sha256) {
    fail(
      `${rel(manifestPath)} runtime.sha256 mismatch: expected ${manifest.runtime.sha256}, got ${runtimeSha256}`,
    );
  }
  let runtimeEntries;
  try {
    runtimeEntries = readPortableTarZstdBufferEntries(runtimeBytes, {
      label: `${rel(manifestPath)} runtime archive`,
    });
  } catch (error) {
    fail(error.message);
  }
  const runtimeMembers = [...runtimeEntries.keys()];
  const missingCoreRuntimeFiles = CORE_RUNTIME_ARCHIVE_FILES.filter((member) => {
    const entry = runtimeEntries.get(member);
    return entry === undefined || !entry.isFile || entry.isSymbolicLink || entry.size <= 0;
  }).sort(compareText);
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

export function validateAotPayload(root, expectedTarget) {
  const manifestPath = path.join(root, "manifest.json");
  const manifest = readJson(manifestPath);
  validateCanonicalAotManifest(manifest, manifestPath, expectedTarget);
  let artifactRows;
  try {
    artifactRows = assertWasixAotArtifactPayloads(manifest, {
      context: rel(manifestPath),
      readArtifact(artifactPath) {
        const file = path.join(root, ...artifactPath.split("/"));
        if (!isFile(file) || statSync(file).size <= 0) {
          throw new Error(`${rel(manifestPath)} AOT artifact ${artifactPath} must be a non-empty regular file`);
        }
        return readFileSync(file);
      },
    });
  } catch (error) {
    fail(error.message);
  }
  const expected = new Set([
    "manifest.json",
    ...releaseNoticeRows({ profile: "wasix-aot" }).map((row) => row.member),
  ]);
  for (const row of artifactRows) {
    if (row.name.startsWith("extension:")) {
      fail(`WASIX AOT Cargo payload must not contain extension artifact ${row.name}`);
    }
    expected.add(row.path);
  }
  assertReleaseNoticesInDirectory(root, { profile: "wasix-aot" });
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

function noticeProfileForSpec(spec) {
  if (spec.kind === "icu-data") return "wasix-icu-data";
  if (spec.kind === "wasix-runtime") return "wasix-runtime";
  if (spec.kind === "wasix-tools") return "wasix-tools";
  if (spec.kind === "wasix-aot" || spec.kind === "wasix-tools-aot") return "wasix-aot";
  fail(`WASIX Cargo package ${spec.name} has no release notice profile for kind ${spec.kind}`);
}

function injectCargoNoticeIncludes(text, profile) {
  const members = releaseNoticeRows({ profile }).map((row) => row.member);
  const match = text.match(/^include = \[(?<body>[\s\S]*?)^\]$/mu)
    ?? text.match(/^include = \[(?<body>[^\n]*?)\]$/mu);
  if (!match?.groups) fail("Cargo package template must declare one include array");
  const existing = [...match.groups.body.matchAll(/"([^"]+)"/gu)].map((item) => item[1]);
  const values = [...new Set([...existing, ...members])];
  const replacement = `include = [\n${values.map((value) => `  ${JSON.stringify(value)},`).join("\n")}\n]`;
  return text.slice(0, match.index) + replacement + text.slice(match.index + match[0].length);
}

function rewriteCargoManifest(manifest, { packageName, version, extensionSources, extensionAotSources, noticeProfile }) {
  let text = readFileSync(manifest, "utf8");
  text = text.replace(/^name = "[^"]+"$/mu, `name = "${packageName}"`);
  text = text.replace(/^version = "[^"]+"$/mu, `version = "${version}"`);
  text = text.replace(/^publish = false\n?/gmu, "");
  text = text.replace(
    /^license = "[^"]+"$/mu,
    `license = ${JSON.stringify(releaseProfilePackageLicense(noticeProfile).spdx)}`,
  );
  text = injectCargoNoticeIncludes(text, noticeProfile);
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

function extensionSqlFeatureName(sqlName) {
  if (typeof sqlName !== "string" || !/^[a-z0-9][a-z0-9_-]*$/u.test(sqlName)) {
    fail(`invalid extension SQL feature name ${JSON.stringify(sqlName)}`);
  }
  return `extension-${sqlName.replaceAll("_", "-")}`;
}

export function extensionDependencyRequirement(version, versioning) {
  const match = version.match(/^([0-9]+)\.([0-9]+)\.([0-9]+)$/u);
  if (match === null) {
    fail(`extension dependency version must be stable x.y.z, got ${JSON.stringify(version)}`);
  }
  if (versioning !== "upstream-bound") {
    return `=${version}`;
  }
  const major = Number.parseInt(match[1], 10);
  const minor = Number.parseInt(match[2], 10);
  const upper = major >= 1 ? `${major + 1}.0.0` : `0.${minor + 1}.0`;
  return `>=${version},<${upper}`;
}

export function injectRuntimeExtensionDependencies(text, extensionSources, extensionAotSources) {
  const dependencyLines = [];
  const targetDependencyLines = new Map();
  const aotByExtension = new Map();
  for (const source of extensionAotSources) {
    const list = aotByExtension.get(source.spec.product) ?? [];
    list.push(source);
    aotByExtension.set(source.spec.product, list);
  }
  for (const source of extensionSources) {
    const packageName = source.spec.name;
    dependencyLines.push(`${packageName} = { version = "${source.spec.dependencyRequirement}", path = "../${packageName}", optional = true }`);
    const carrierDependencies = [`dep:${packageName}`];
    for (const aotSource of (aotByExtension.get(source.spec.product) ?? []).sort((left, right) => compareText(left.spec.name, right.spec.name))) {
      carrierDependencies.push(`dep:${aotSource.spec.name}`);
    }
    for (const member of source.spec.members) {
      const feature = extensionSqlFeatureName(member.sqlName);
      const closureFeatures = member.dependencies.map(extensionSqlFeatureName);
      const featureDeps = [...new Set([...closureFeatures, ...carrierDependencies])];
      const replacement = `${feature} = [${featureDeps.map((dep) => JSON.stringify(dep)).join(", ")}]`;
      const pattern = new RegExp(`^${escapeRegExp(feature)} = \\[[^\\n]*\\]$`, "mu");
      if (pattern.test(text)) {
        text = text.replace(pattern, replacement);
      } else {
        text = text.replace("[features]\n", `[features]\n${replacement}\n`);
      }
    }
  }
  for (const source of extensionAotSources) {
    const cfg = AOT_TARGET_CFGS[source.spec.target];
    if (cfg === undefined) {
      fail(`unsupported extension AOT target ${source.spec.target}`);
    }
    const line = `${source.spec.name} = { version = "${source.spec.dependencyRequirement}", path = "../${source.spec.name}", optional = true }`;
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
  const noticeProfile = noticeProfileForSpec(spec);
  stageReleaseNotices(crateDir, { profile: noticeProfile });
  rewriteCargoManifest(path.join(crateDir, "Cargo.toml"), {
    packageName: spec.name,
    version,
    extensionSources,
    extensionAotSources,
    noticeProfile,
  });
  assertReleaseNoticesInDirectory(crateDir, { profile: noticeProfile });
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
  const cargoCratePath = path.join(targetDir, "package", `${packageData.name}-${packageData.version}.crate`);
  if (!isFile(cargoCratePath)) {
    fail(`cargo package did not create ${rel(cargoCratePath)}`);
  }
  return manualCargoPackageSource(
    manifest,
    path.join(targetDir, "strict-package", packageData.name),
    { root: ROOT, fail, rel },
  );
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
  writeFileSync(cratePath, canonicalGzipSync(createDeterministicTar(stageDir, packageRoot, { fail })));
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
  const noticeProfile = noticeProfileForSpec(spec);
  assertReleaseNoticesInArchive(output, {
    prefix: `${spec.name}-${version}`,
    profile: noticeProfile,
  });
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

function wasixExtensionPartPackageName(packageName, index) {
  if (!Number.isSafeInteger(index) || index < 1 || index > 999) {
    fail(`WASIX extension Cargo part index must be 1-based in the range 1..999, got ${JSON.stringify(index)}`);
  }
  return `${packageName}-part-${String(index).padStart(3, "0")}`;
}

function rustCrateIdent(packageName) {
  return packageName.replaceAll("-", "_");
}

function extensionCarrierLegal(spec, carriesBytes) {
  if (!carriesBytes) {
    return { profile: "code-facade", packageSpdx: "MIT", upstreamMembers: [] };
  }
  const sqlNames = spec.members.map((member) => member.sqlName);
  const registry = extensionRegistryLicense(spec.product, sqlNames);
  const contrib = spec.product === "oliphaunt-extension-contrib-pg18";
  const profile = contrib
    ? sqlNames.includes("pgcrypto") ? "contrib-wasix-openssl" : "contrib-wasix"
    : "external-wasix";
  return {
    profile,
    packageSpdx: contrib ? releaseProfilePackageLicense(profile).spdx : registry.packageSpdx,
    upstreamMembers: contrib ? [] : sqlNames,
  };
}

function stageExtensionCarrierLegal(crateDir, spec, carriesBytes) {
  const legal = extensionCarrierLegal(spec, carriesBytes);
  stageReleaseNotices(crateDir, { profile: legal.profile });
  if (legal.upstreamMembers.length > 0) {
    for (const sqlName of legal.upstreamMembers) stageExtensionUpstreamLicenses(sqlName, crateDir);
    assertExtensionUpstreamLicensesInDirectory(legal.upstreamMembers, crateDir);
  }
  assertReleaseNoticesInDirectory(crateDir, { profile: legal.profile });
  return legal;
}

function extensionCargoIncludes(crateDir, profile, values) {
  const legal = releaseNoticeRows({ profile }).map((row) => row.member);
  if (isDirectory(path.join(crateDir, "share/licenses"))) legal.push("share/licenses/**");
  return [...new Set([...values, ...legal])];
}

function writeExtensionPayloadPartSources({ parentName, product, version, target, subject, members, files, sourceRoot, partBytes }) {
  if (!Number.isSafeInteger(partBytes) || partBytes < 1 || partBytes > DEFAULT_EXTENSION_PART_BYTES) {
    fail(`extension Cargo --part-bytes must be an integer in 1..${DEFAULT_EXTENSION_PART_BYTES}, got ${JSON.stringify(partBytes)}`);
  }
  const sortedFiles = [...files].sort((left, right) => compareText(left.payloadRelative, right.payloadRelative));
  if (new Set(sortedFiles.map((file) => file.payloadRelative)).size !== sortedFiles.length) {
    fail(`${product} ${target} extension Cargo payload repeats a relative file path`);
  }
  const parts = [];
  let current = null;
  const startPart = () => {
    const index = parts.length + 1;
    const name = wasixExtensionPartPackageName(parentName, index);
    if (name.length > 64) fail(`generated crates.io package name exceeds 64 characters: ${name}`);
    const sourceDir = path.join(sourceRoot, name);
    if (existsSync(sourceDir)) fail(`duplicate generated WASIX extension Cargo part source: ${rel(sourceDir)}`);
    mkdirSync(path.join(sourceDir, "src"), { recursive: true });
    current = { index, name, sourceDir, size: 0, target, version };
    parts.push(current);
    return current;
  };
  for (const file of sortedFiles) {
    checkedTarMember(file.payloadRelative, file.source);
    const size = statSync(file.source).size;
    if (size > partBytes) {
      current = null;
      const bytes = readFileSync(file.source);
      for (let offset = 0, chunk = 0; offset < bytes.length; offset += partBytes, chunk += 1) {
        const part = startPart();
        const destination = path.join(
          part.sourceDir,
          "payload/chunks",
          `${file.payloadRelative}.part${String(chunk).padStart(6, "0")}`,
        );
        mkdirSync(path.dirname(destination), { recursive: true });
        writeFileSync(destination, bytes.subarray(offset, Math.min(offset + partBytes, bytes.length)));
        part.size = Math.min(partBytes, bytes.length - offset);
      }
      current = null;
      continue;
    }
    if (current === null || current.size + size > partBytes) startPart();
    const destination = path.join(current.sourceDir, "payload/files", file.payloadRelative);
    mkdirSync(path.dirname(destination), { recursive: true });
    copyFileSync(file.source, destination);
    current.size += size;
  }
  if (parts.length > 999) fail(`${product}@${version} requires more than 999 Cargo payload parts for ${target}`);
  for (const part of parts) {
    const spec = { product, members };
    const legal = stageExtensionCarrierLegal(part.sourceDir, spec, true);
    part.noticeProfile = legal.profile;
    part.upstreamMembers = legal.upstreamMembers;
    const includes = extensionCargoIncludes(part.sourceDir, legal.profile, ["Cargo.toml", "README.md", "src/**", "payload/**"]);
    writeFileSync(path.join(part.sourceDir, "README.md"), [
      `# ${part.name}`,
      "",
      `Cargo payload part ${String(part.index).padStart(3, "0")} for the ${subject} on \`${target}\`.`,
      "Applications do not depend on this crate directly.",
      "",
    ].join("\n"));
    writeFileSync(path.join(part.sourceDir, "Cargo.toml"), [
      "[package]",
      `name = ${JSON.stringify(part.name)}`,
      `version = ${JSON.stringify(version)}`,
      'edition = "2024"',
      'rust-version = "1.93"',
      `description = ${JSON.stringify(`Cargo payload part for the ${subject} on ${target}`)}`,
      'repository = "https://github.com/f0rr0/oliphaunt"',
      'homepage = "https://oliphaunt.dev"',
      `license = ${JSON.stringify(legal.packageSpdx)}`,
      `include = [${includes.map((value) => JSON.stringify(value)).join(", ")}]`,
      "",
      "[lib]",
      'path = "src/lib.rs"',
      "",
      "[workspace]",
      "",
    ].join("\n"));
    writeFileSync(path.join(part.sourceDir, "src/lib.rs"), [
      "#![deny(unsafe_code)]",
      `pub const PRODUCT: &str = ${JSON.stringify(product)};`,
      `pub const TARGET: &str = ${JSON.stringify(target)};`,
      `pub const PART_INDEX: usize = ${part.index};`,
      'pub const PAYLOAD_ROOT: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/payload");',
      "",
    ].join("\n"));
  }
  return parts;
}

function extensionArtifactBuildRs(spec, files, partSources) {
  const schema = spec.members.length > 1
    ? "oliphaunt-artifact-manifest-v2"
    : "oliphaunt-artifact-manifest-v1";
  const extensionRows = spec.members.map((member) =>
    `    (${JSON.stringify(member.sqlName)}, &[${member.dependencies.map((dependency) => JSON.stringify(dependency)).join(", ")}]),`).join("\n");
  const fileRows = files.map((file) =>
    `    (${JSON.stringify(file.sqlName)}, ${JSON.stringify(file.payloadRelative)}, ${JSON.stringify(file.artifactRelative)}, ${JSON.stringify(file.sha256)}),`).join("\n");
  const partRoots = partSources.map((part) => `    ${rustCrateIdent(part.name)}::PAYLOAD_ROOT,`).join("\n");
  return `use std::collections::{BTreeMap, BTreeSet};
use std::env;
use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};

const SCHEMA: &str = ${JSON.stringify(schema)};
const PRODUCT: &str = ${JSON.stringify(spec.product)};
const VERSION: &str = env!("CARGO_PKG_VERSION");
const TARGET: &str = ${JSON.stringify(spec.target ?? "portable")};
const RUNTIME_PRODUCT: &str = ${JSON.stringify(spec.runtimeProduct)};
const RUNTIME_VERSION: &str = ${JSON.stringify(spec.runtimeVersion)};
const EXTENSIONS: &[(&str, &[&str])] = &[
${extensionRows}
];
const FILES: &[(&str, &str, &str, &str)] = &[
${fileRows}
];
const PART_ROOTS: &[&str] = &[
${partRoots}
];

fn main() {
    let manifest_dir = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    let out = PathBuf::from(env::var_os("OUT_DIR").expect("OUT_DIR"));
    let payload = out.join("payload");
    if payload.exists() { fs::remove_dir_all(&payload).expect("remove stale extension payload"); }
    fs::create_dir_all(&payload).expect("create extension payload");
    let roots: Vec<PathBuf> = if PART_ROOTS.is_empty() {
        vec![manifest_dir.join("payload")]
    } else {
        PART_ROOTS.iter().map(PathBuf::from).collect()
    };
    let mut chunks: BTreeMap<String, Vec<(usize, PathBuf)>> = BTreeMap::new();
    for root in roots {
        println!("cargo::rerun-if-changed={}", root.display());
        copy_complete_files(&root.join("files"), &payload).expect("copy extension payload files");
        collect_chunks(&root.join("chunks"), &root.join("chunks"), &mut chunks).expect("collect extension payload chunks");
    }
    for (relative, mut rows) in chunks {
        rows.sort_by_key(|(index, _)| *index);
        for (expected, (actual, _)) in rows.iter().enumerate() {
            if *actual != expected { panic!("non-contiguous extension chunks for {relative}"); }
        }
        let destination = payload.join(&relative);
        fs::create_dir_all(destination.parent().expect("payload parent")).expect("create payload parent");
        let mut writer = fs::File::create(&destination).expect("create reconstructed payload");
        for (_, chunk) in rows {
            let mut reader = fs::File::open(chunk).expect("open payload chunk");
            io::copy(&mut reader, &mut writer).expect("append payload chunk");
        }
    }
    let actual: BTreeSet<String> = collect_files(&payload).expect("collect payload")
        .into_iter().map(|file| file.strip_prefix(&payload).expect("payload relative").to_string_lossy().replace(std::path::MAIN_SEPARATOR, "/")).collect();
    let expected: BTreeSet<String> = FILES.iter().map(|(_, relative, _, _)| (*relative).to_owned()).collect();
    if actual != expected { panic!("extension Cargo payload file set mismatch: expected {expected:?}, got {actual:?}"); }
    let mut text = format!("schema = {SCHEMA:?}\\nproduct = {PRODUCT:?}\\nversion = {VERSION:?}\\nkind = \\"extension\\"\\ntarget = {TARGET:?}\\nruntime-product = {RUNTIME_PRODUCT:?}\\nruntime-version = {RUNTIME_VERSION:?}\\n");
    for (extension, dependencies) in EXTENSIONS {
        if SCHEMA == "oliphaunt-artifact-manifest-v1" {
            text.push_str(&format!("extension = {extension:?}\\ndependencies = {dependencies:?}\\n"));
        } else {
            text.push_str(&format!("\\n[[extensions]]\\nextension = {extension:?}\\ndependencies = {dependencies:?}\\n"));
        }
        for (_, payload_relative, artifact_relative, expected_sha256) in FILES.iter().filter(|(owner, _, _, _)| owner == extension) {
            let source = payload.join(payload_relative);
            let actual_sha256 = sha256_file(&source).expect("hash extension payload");
            if actual_sha256 != *expected_sha256 { panic!("extension payload digest mismatch for {}", source.display()); }
            let table = if SCHEMA == "oliphaunt-artifact-manifest-v1" { "[[files]]" } else { "[[extensions.files]]" };
            text.push_str(&format!("\\n{table}\\nsource = {:?}\\nrelative = {artifact_relative:?}\\nsha256 = {expected_sha256:?}\\nexecutable = false\\n", source.display().to_string()));
        }
    }
    let manifest = out.join("oliphaunt-artifact.toml");
    fs::write(&manifest, text).expect("write extension artifact manifest");
    println!("cargo::metadata=manifest={}", manifest.display());
}

fn copy_complete_files(source: &Path, destination: &Path) -> io::Result<()> {
    if !source.is_dir() { return Ok(()); }
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let path = entry.path();
        let target = destination.join(entry.file_name());
        if entry.file_type()?.is_dir() { copy_complete_files(&path, &target)?; }
        else { fs::create_dir_all(target.parent().expect("file parent"))?; fs::copy(path, target)?; }
    }
    Ok(())
}

fn collect_chunks(root: &Path, current: &Path, output: &mut BTreeMap<String, Vec<(usize, PathBuf)>>) -> io::Result<()> {
    if !current.is_dir() { return Ok(()); }
    for entry in fs::read_dir(current)? {
        let entry = entry?;
        let path = entry.path();
        if entry.file_type()?.is_dir() { collect_chunks(root, &path, output)?; continue; }
        let relative = path.strip_prefix(root).expect("chunk relative").to_string_lossy().replace(std::path::MAIN_SEPARATOR, "/");
        let (name, suffix) = relative.rsplit_once(".part").unwrap_or_else(|| panic!("invalid extension chunk {relative}"));
        let index = suffix.parse::<usize>().unwrap_or_else(|_| panic!("invalid extension chunk index {relative}"));
        output.entry(name.to_owned()).or_default().push((index, path));
    }
    Ok(())
}

fn collect_files(root: &Path) -> io::Result<Vec<PathBuf>> {
    fn visit(root: &Path, output: &mut Vec<PathBuf>) -> io::Result<()> {
        for entry in fs::read_dir(root)? {
            let entry = entry?;
            let path = entry.path();
            if entry.file_type()?.is_dir() { visit(&path, output)?; } else { output.push(path); }
        }
        Ok(())
    }
    let mut output = Vec::new();
    visit(root, &mut output)?;
    output.sort();
    Ok(output)
}

${RUST_BUILD_SCRIPT_SHA256}
`;
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

function extensionManifestMembers(manifest) {
  if (manifest?.schema === "oliphaunt-extension-ci-artifacts-v1") {
    return typeof manifest.sqlName === "string" && manifest.sqlName ? [manifest] : [];
  }
  if (manifest?.schema === "oliphaunt-extension-ci-artifacts-v2") {
    return Array.isArray(manifest.extensions) ? manifest.extensions : [];
  }
  return [];
}

export function extractArchiveMemberToFile(archive, member, destination) {
  const normalized = checkedTarMember(member, archive);
  let entries;
  try {
    entries = readPortableArchiveEntries(archive);
  } catch (error) {
    fail(error.message);
  }
  const entry = entries.get(normalized);
  if (entry === undefined || !entry.isFile || entry.isSymbolicLink || entry.size <= 0) {
    fail(`${rel(archive)} member ${normalized} must be exactly one non-empty regular file`);
  }
  mkdirSync(path.dirname(destination), { recursive: true });
  try {
    writeFileSync(destination, entry.data(), { flag: "wx", mode: 0o600 });
  } catch (error) {
    fail(`cannot materialize ${normalized} from ${rel(archive)}: ${error.message}`);
  }
  const metadata = lstatSync(destination);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    rmSync(destination, { force: true });
    fail(`extracted ${normalized} from ${rel(archive)} is not a regular non-symlink file`);
  }
  return destination;
}

function extensionWasixMembers(extensionDir, manifest, materializeRoot) {
  const members = extensionManifestMembers(manifest);
  if (members.length === 0) return [];
  const rows = members.map((member) => {
    const matches = Array.isArray(member.assets)
      ? member.assets.filter((asset) =>
          asset?.family === "wasix"
          && asset.kind === "wasix-runtime"
          && asset.target === "wasix-portable"
        )
      : [];
    if (matches.length !== 1) {
      fail(`${manifest.product}/${member.sqlName} must declare exactly one portable WASIX runtime asset`);
    }
    return { member, asset: matches[0] };
  });
  if (manifest.schema === "oliphaunt-extension-ci-artifacts-v1") {
    const [{ member, asset }] = rows;
    const archive = path.join(extensionDir, "release-assets", asset.name);
    if (!isFile(archive) || sha256File(archive) !== asset.sha256 || statSync(archive).size !== asset.bytes) {
      fail(`${manifest.product}/${member.sqlName} portable WASIX asset is missing or changed`);
    }
    return [{
      sqlName: member.sqlName,
      dependencies: [...(member.dependencies ?? [])],
      nativeModuleStem: member.nativeModuleStem,
      archive,
      sha256: asset.sha256,
      size: asset.bytes,
    }];
  }

  const carrierNames = new Set(rows.map(({ asset }) => asset.carrierAsset));
  if (carrierNames.size !== 1 || carrierNames.has(undefined)) {
    fail(`${manifest.product} portable WASIX members must share one aggregate carrier`);
  }
  const carrierName = [...carrierNames][0];
  const carrierRows = Array.isArray(manifest.carrierAssets)
    ? manifest.carrierAssets.filter((carrier) =>
        carrier?.name === carrierName
        && carrier.family === "wasix"
        && carrier.target === "wasix-portable"
        && carrier.kind === "extension-bundle"
      )
    : [];
  if (carrierRows.length !== 1) {
    fail(`${manifest.product} must declare exactly one portable WASIX aggregate carrier row`);
  }
  const carrier = carrierRows[0];
  const carrierPath = path.join(extensionDir, "release-assets", carrierName);
  if (!isFile(carrierPath) || sha256File(carrierPath) !== carrier.sha256 || statSync(carrierPath).size !== carrier.bytes) {
    fail(`${manifest.product} portable WASIX aggregate carrier is missing or changed`);
  }
  return rows.map(({ member, asset }) => {
    const expectedRoot = carrierName.replace(/\.tar\.gz$/u, "");
    if (asset.carrierRoot !== expectedRoot || typeof asset.memberPath !== "string") {
      fail(`${manifest.product}/${member.sqlName} has an invalid aggregate carrier locator`);
    }
    const archive = path.join(materializeRoot, manifest.product, member.sqlName, "extension.tar.zst");
    extractArchiveMemberToFile(carrierPath, `${asset.carrierRoot}/${asset.memberPath}`, archive);
    if (statSync(archive).size !== asset.bytes || sha256File(archive) !== asset.sha256) {
      rmSync(archive, { force: true });
      fail(`${manifest.product}/${member.sqlName} nested portable WASIX bytes do not match the frozen member digest`);
    }
    return {
      sqlName: member.sqlName,
      dependencies: [...(member.dependencies ?? [])],
      nativeModuleStem: member.nativeModuleStem,
      archive,
      sha256: asset.sha256,
      size: asset.bytes,
    };
  });
}

function extensionAotSpecs(extensionDir, { product, version, members, versioning, dependencyRequirement, runtimeProduct, runtimeVersion }) {
  const aotRoot = path.join(extensionDir, "wasix-aot");
  if (!isDirectory(aotRoot)) {
    return [];
  }
  const specs = [];
  const seenTargets = new Set();
  for (const targetDir of fs.readdirSync(aotRoot).map((name) => path.join(aotRoot, name)).filter(isDirectory).sort(compareText)) {
    const targetId = path.basename(targetDir);
    const expectedTarget = AOT_TARGET_TRIPLES[targetId];
    if (expectedTarget === undefined) {
      fail(`${rel(aotRoot)} contains unknown extension AOT target id ${targetId}`);
    }
    const aotMembers = [];
    for (const member of members.filter((candidate) => candidate.requiresAot)) {
      const sourceDir = isFile(path.join(targetDir, "manifest.json"))
        ? targetDir
        : path.join(targetDir, member.sqlName);
      const manifestPath = path.join(sourceDir, "manifest.json");
      if (!isFile(manifestPath)) {
        fail(`${product}/${member.sqlName} is missing WASIX AOT manifest for ${targetId}`);
      }
      const data = readJson(manifestPath);
      validateCanonicalAotManifest(data, manifestPath, expectedTarget);
      let artifactRows;
      try {
        artifactRows = assertWasixAotArtifactPayloads(data, {
          context: rel(manifestPath),
          readArtifact(artifactPath) {
            const file = path.join(sourceDir, ...artifactPath.split("/"));
            if (!isFile(file) || statSync(file).size <= 0) {
              throw new Error(`${rel(manifestPath)} references missing or empty AOT artifact ${artifactPath}`);
            }
            return readFileSync(file);
          },
        });
      } catch (error) {
        fail(error.message);
      }
      const expectedPrefix = `extension:${member.sqlName}`;
      for (const artifact of artifactRows) {
        const { name, path: artifactPath } = artifact;
        if (typeof name !== "string" || !(name === expectedPrefix || name.startsWith(`${expectedPrefix}:`))) {
          fail(`${rel(manifestPath)} contains AOT artifact ${JSON.stringify(name)} for ${member.sqlName}`);
        }
      }
      aotMembers.push({
        sqlName: member.sqlName,
        dependencies: member.dependencies,
        sourceDir,
      });
    }
    if (aotMembers.length === 0) continue;
    if (seenTargets.has(expectedTarget)) fail(`${rel(aotRoot)} has duplicate extension AOT target ${expectedTarget}`);
    seenTargets.add(expectedTarget);
    specs.push({
      name: wasixExtensionAotPackageName(product, expectedTarget),
      product,
      version,
      members: aotMembers,
      target: expectedTarget,
      versioning,
      dependencyRequirement,
      runtimeProduct,
      runtimeVersion,
    });
  }
  return specs.sort((left, right) => compareText(left.target, right.target));
}

function extensionCargoSpecs(extensionRoots, materializeRoot) {
  const specs = [];
  for (const manifestPath of discoverExtensionManifests(extensionRoots)) {
    const manifest = readJson(manifestPath);
    const { product, version } = manifest;
    if (![product, version].every((value) => typeof value === "string" && value)) {
      fail(`${rel(manifestPath)} is missing product or version`);
    }
    const metadata = extensionMetadata(product, PREFIX);
    const expectedMembers = extensionSqlNames(product, PREFIX);
    const manifestMembers = extensionManifestMembers(manifest).map((member) => member.sqlName);
    if (JSON.stringify(manifestMembers) !== JSON.stringify(expectedMembers)) {
      fail(`${rel(manifestPath)} member set does not match ${product} release metadata`);
    }
    const runtimeProduct = metadata.compatibility.wasixRuntimeProduct;
    const runtimeVersion = metadata.compatibility.wasixRuntimeVersion;
    const members = extensionWasixMembers(path.dirname(manifestPath), manifest, materializeRoot)
      .map((member) => ({ ...member, requiresAot: typeof member.nativeModuleStem === "string" && Boolean(member.nativeModuleStem) }));
    const dependencyRequirement = extensionDependencyRequirement(version, metadata.versioning);
    const spec = {
      name: wasixExtensionPackageName(product),
      product,
      version,
      members,
      versioning: metadata.versioning,
      dependencyRequirement,
      runtimeProduct,
      runtimeVersion,
    };
    spec.aotTargets = extensionAotSpecs(path.dirname(manifestPath), {
      ...spec,
      versioning: metadata.versioning,
      dependencyRequirement,
    });
    specs.push(spec);
  }
  return specs.sort((left, right) => compareText(left.name, right.name));
}

function validateExtensionAotCoverage(extensionSpecs) {
  for (const spec of extensionSpecs) {
    if (!spec.members.some((member) => member.requiresAot)) {
      continue;
    }
    const actualTargets = new Set(spec.aotTargets.map((aotSpec) => aotSpec.target));
    if (!sameSet(actualTargets, EXPECTED_EXTENSION_AOT_TARGETS)) {
      fail(`${spec.product} has a WASIX native module but incomplete extension AOT artifacts; expected=${JSON.stringify([...EXPECTED_EXTENSION_AOT_TARGETS].sort(compareText))}, actual=${JSON.stringify([...actualTargets].sort(compareText))}`);
    }
  }
}

function writeExtensionCargoSource(spec, sourceRoot, partBytes) {
  const crateDir = path.join(sourceRoot, spec.name);
  if (existsSync(crateDir)) {
    fail(`duplicate generated WASIX extension Cargo package source: ${rel(crateDir)}`);
  }
  mkdirSync(path.join(crateDir, "src"), { recursive: true });
  const subject = spec.members.length === 1
    ? spec.members[0].sqlName
    : `${spec.members.length}-member PostgreSQL 18 contrib bundle`;
  const files = spec.members.map((member) => ({
    sqlName: member.sqlName,
    source: member.archive,
    payloadRelative: `extensions/${member.sqlName}/extension.tar.zst`,
    artifactRelative: `extensions/${member.sqlName}.tar.zst`,
    sha256: member.sha256,
  }));
  const split = files.reduce((sum, file) => sum + statSync(file.source).size, 0) > partBytes;
  const partSources = split
    ? writeExtensionPayloadPartSources({
        parentName: spec.name,
        product: spec.product,
        version: spec.version,
        target: "portable",
        subject: `${subject} Oliphaunt WASIX extension carrier`,
        members: spec.members,
        files,
        sourceRoot,
        partBytes,
      })
    : [];
  if (!split) {
    for (const file of files) {
      const destination = path.join(crateDir, "payload/files", file.payloadRelative);
      mkdirSync(path.dirname(destination), { recursive: true });
      copyFileSync(file.source, destination);
    }
  }
  const legal = stageExtensionCarrierLegal(crateDir, spec, !split);
  const includes = extensionCargoIncludes(
    crateDir,
    legal.profile,
    ["Cargo.toml", "README.md", "build.rs", "src/**", ...(split ? [] : ["payload/**"])],
  );
  const links = `oliphaunt_artifact_extension_${spec.product.replace(/^oliphaunt-extension-/u, "").replaceAll("-", "_")}_wasix`;
  writeFileSync(path.join(crateDir, "README.md"), [
    `# ${spec.name}`,
    "",
    `Cargo artifact package for the ${subject} Oliphaunt WASIX extension carrier.`,
    "",
  ].join("\n"));
  writeFileSync(path.join(crateDir, "Cargo.toml"), [
    "[package]",
    `name = "${spec.name}"`,
    `version = "${spec.version}"`,
    'edition = "2024"',
    'rust-version = "1.93"',
    `description = "Oliphaunt WASIX artifact package for the ${subject}"`,
    'repository = "https://github.com/f0rr0/oliphaunt"',
    'homepage = "https://oliphaunt.dev"',
    `license = ${JSON.stringify(legal.packageSpdx)}`,
    `links = "${links}"`,
    'build = "build.rs"',
    `include = [${includes.map((value) => JSON.stringify(value)).join(", ")}]`,
    "",
    "[lib]",
    'path = "src/lib.rs"',
    "",
    "[build-dependencies]",
    ...partSources.map((part) => `${part.name} = { version = "=${spec.version}", path = "../${part.name}" }`),
    "",
    "[workspace]",
    "",
  ].join("\n"));
  writeFileSync(path.join(crateDir, "src/lib.rs"), [
    "#![deny(unsafe_code)]",
    "",
    `pub const SQL_NAMES: &[&str] = &[${spec.members.map((member) => JSON.stringify(member.sqlName)).join(", ")}];`,
    ...(spec.members.length === 1 ? [`pub const SQL_NAME: &str = ${JSON.stringify(spec.members[0].sqlName)};`] : []),
    "",
    "pub fn archive(sql_name: &str) -> Option<&'static [u8]> {",
    "    match sql_name {",
    ...spec.members.map((member) => `        ${JSON.stringify(member.sqlName)} => Some(include_bytes!(concat!(env!("OUT_DIR"), "/payload/extensions/${member.sqlName}/extension.tar.zst"))),`),
    "        _ => None,",
    "    }",
    "}",
    "",
    "pub fn archive_sha256(sql_name: &str) -> Option<&'static str> {",
    "    match sql_name {",
    ...spec.members.map((member) => `        ${JSON.stringify(member.sqlName)} => Some(${JSON.stringify(member.sha256)}),`),
    "        _ => None,",
    "    }",
    "}",
    "",
  ].join("\n"));
  writeFileSync(path.join(crateDir, "build.rs"), extensionArtifactBuildRs({ ...spec, target: "portable" }, files, partSources));
  return {
    spec,
    sourceDir: crateDir,
    partSources,
    noticeProfile: legal.profile,
    upstreamMembers: legal.upstreamMembers,
  };
}

function writeExtensionAotCargoSource(spec, sourceRoot, partBytes) {
  const crateDir = path.join(sourceRoot, spec.name);
  if (existsSync(crateDir)) {
    fail(`duplicate generated WASIX extension AOT Cargo package source: ${rel(crateDir)}`);
  }
  mkdirSync(path.join(crateDir, "src"), { recursive: true });
  const artifacts = [];
  for (const member of spec.members) {
    const manifestPath = path.join(member.sourceDir, "manifest.json");
    const manifest = readJson(manifestPath);
    const manifestDestination = path.join(crateDir, "manifests", `${member.sqlName}.json`);
    mkdirSync(path.dirname(manifestDestination), { recursive: true });
    copyFileSync(manifestPath, manifestDestination);
    for (const artifact of [...(manifest.artifacts ?? [])].sort((left, right) => compareText(left?.name ?? "", right?.name ?? ""))) {
      const name = artifact?.name;
      const artifactPath = artifact?.path;
      if (typeof name !== "string" || typeof artifactPath !== "string") {
        fail(`${rel(manifestPath)} contains an AOT artifact without name/path`);
      }
      const source = path.join(member.sourceDir, artifactPath);
      if (!isFile(source)) fail(`${rel(manifestPath)} references missing AOT artifact ${artifactPath}`);
      artifacts.push({
        sqlName: member.sqlName,
        name,
        source,
        payloadRelative: `extensions/${member.sqlName}/${artifactPath}`,
        artifactRelative: `extensions/${member.sqlName}/${artifactPath}`,
        sha256: sha256File(source),
      });
    }
  }
  if (artifacts.length === 0) {
    fail(`${spec.product} ${spec.target} must contain extension AOT artifacts`);
  }
  if (new Set(artifacts.map((artifact) => artifact.name)).size !== artifacts.length) {
    fail(`${spec.product} ${spec.target} repeats an extension AOT artifact name`);
  }
  const split = artifacts.reduce((sum, artifact) => sum + statSync(artifact.source).size, 0) > partBytes;
  const partSources = split
    ? writeExtensionPayloadPartSources({
        parentName: spec.name,
        product: spec.product,
        version: spec.version,
        target: spec.target,
        subject: `${spec.members.length}-member Oliphaunt WASIX extension AOT carrier`,
        members: spec.members,
        files: artifacts,
        sourceRoot,
        partBytes,
      })
    : [];
  if (!split) {
    for (const artifact of artifacts) {
      const destination = path.join(crateDir, "payload/files", artifact.payloadRelative);
      mkdirSync(path.dirname(destination), { recursive: true });
      copyFileSync(artifact.source, destination);
    }
  }
  const legal = stageExtensionCarrierLegal(crateDir, spec, !split);
  const includes = extensionCargoIncludes(
    crateDir,
    legal.profile,
    ["Cargo.toml", "README.md", "build.rs", "src/**", "manifests/**", ...(split ? [] : ["payload/**"])],
  );
  const subject = spec.members.length === 1 ? spec.members[0].sqlName : `${spec.members.length}-member bundle`;
  const links = `oliphaunt_artifact_extension_${spec.product.replace(/^oliphaunt-extension-/u, "").replaceAll("-", "_")}_aot_${spec.target.replaceAll("-", "_")}`;
  writeFileSync(path.join(crateDir, "README.md"), [
    `# ${spec.name}`,
    "",
    `Cargo artifact package for the ${subject} Oliphaunt WASIX AOT artifacts on \`${spec.target}\`.`,
    "",
  ].join("\n"));
  writeFileSync(path.join(crateDir, "Cargo.toml"), [
    "[package]",
    `name = "${spec.name}"`,
    `version = "${spec.version}"`,
    'edition = "2024"',
    'rust-version = "1.93"',
    `description = "Oliphaunt WASIX AOT artifact package for the ${subject} on ${spec.target}"`,
    'repository = "https://github.com/f0rr0/oliphaunt"',
    'homepage = "https://oliphaunt.dev"',
    `license = ${JSON.stringify(legal.packageSpdx)}`,
    `links = ${JSON.stringify(links)}`,
    'build = "build.rs"',
    `include = [${includes.map((value) => JSON.stringify(value)).join(", ")}]`,
    "",
    "[lib]",
    'path = "src/lib.rs"',
    "",
    "[build-dependencies]",
    ...partSources.map((part) => `${part.name} = { version = "=${spec.version}", path = "../${part.name}" }`),
    "",
    "[workspace]",
    "",
  ].join("\n"));
  writeFileSync(path.join(crateDir, "src/lib.rs"), [
    "#![deny(unsafe_code)]",
    "",
    `pub const SQL_NAMES: &[&str] = &[${spec.members.map((member) => JSON.stringify(member.sqlName)).join(", ")}];`,
    ...(spec.members.length === 1 ? [`pub const SQL_NAME: &str = ${JSON.stringify(spec.members[0].sqlName)};`] : []),
    `pub const TARGET_TRIPLE: &str = "${spec.target}";`,
    "",
    "pub fn aot_manifest_json(sql_name: &str) -> Option<&'static str> {",
    "    match sql_name {",
    ...spec.members.map((member) => `        ${JSON.stringify(member.sqlName)} => Some(include_str!("../manifests/${member.sqlName}.json")),`),
    "        _ => None,",
    "    }",
    "}",
    "",
    "pub fn aot_artifact_bytes(name: &str) -> Option<&'static [u8]> {",
    "    match name {",
    ...artifacts.map((artifact) => `        ${JSON.stringify(artifact.name)} => Some(include_bytes!(concat!(env!("OUT_DIR"), "/payload/${artifact.payloadRelative}"))),`),
    "        _ => None,",
    "    }",
    "}",
    "",
  ].join("\n"));
  writeFileSync(path.join(crateDir, "build.rs"), extensionArtifactBuildRs(spec, artifacts, partSources));
  return {
    spec,
    sourceDir: crateDir,
    partSources,
    noticeProfile: legal.profile,
    upstreamMembers: legal.upstreamMembers,
  };
}

function assertPackedExtensionLegal(output, carrier) {
  const prefix = `${carrier.name ?? carrier.spec.name}-${carrier.version ?? carrier.spec.version}`;
  assertReleaseNoticesInArchive(output, {
    prefix,
    profile: carrier.noticeProfile,
  });
  if (carrier.upstreamMembers.length > 0) {
    assertExtensionUpstreamLicensesInArchive(carrier.upstreamMembers, output, { prefix });
  }
}

function packageExtensionSource(source, { outputDir, cargoTargetDir }) {
  const packages = [];
  for (const part of source.partSources ?? []) {
    const cratePath = cargoPackage(part.sourceDir, cargoTargetDir);
    validateCrateSize(cratePath);
    const output = path.join(outputDir, path.basename(cratePath));
    copyFileSync(cratePath, output);
    assertPackedExtensionLegal(output, part);
    packages.push({
      name: part.name,
      manifestPath: path.join(part.sourceDir, "Cargo.toml"),
      cratePath: output,
      target: "wasix-portable",
      kind: "wasix-extension",
      size: statSync(output).size,
      sha256: sha256File(output),
      versioning: source.spec.versioning,
      dependencyRequirement: source.spec.dependencyRequirement,
    });
  }
  const cratePath = source.partSources?.length > 0
    ? cargoPackageWithoutDependencyResolution(source.sourceDir, cargoTargetDir)
    : cargoPackage(source.sourceDir, cargoTargetDir);
  validateCrateSize(cratePath);
  const output = path.join(outputDir, path.basename(cratePath));
  copyFileSync(cratePath, output);
  assertPackedExtensionLegal(output, source);
  packages.push({
    name: source.spec.name,
    manifestPath: path.join(source.sourceDir, "Cargo.toml"),
    cratePath: output,
    target: "wasix-portable",
    kind: "wasix-extension",
    size: statSync(output).size,
    sha256: sha256File(output),
    versioning: source.spec.versioning,
    dependencyRequirement: source.spec.dependencyRequirement,
  });
  return packages;
}

function packageExtensionAotSource(source, { outputDir, cargoTargetDir }) {
  const packages = [];
  for (const part of source.partSources ?? []) {
    const cratePath = cargoPackage(part.sourceDir, cargoTargetDir);
    validateCrateSize(cratePath);
    const output = path.join(outputDir, path.basename(cratePath));
    copyFileSync(cratePath, output);
    assertPackedExtensionLegal(output, part);
    packages.push({
      name: part.name,
      manifestPath: path.join(part.sourceDir, "Cargo.toml"),
      cratePath: output,
      target: part.target,
      kind: "wasix-extension-aot",
      size: statSync(output).size,
      sha256: sha256File(output),
      versioning: source.spec.versioning,
      dependencyRequirement: source.spec.dependencyRequirement,
    });
  }
  const cratePath = source.partSources?.length > 0
    ? cargoPackageWithoutDependencyResolution(source.sourceDir, cargoTargetDir)
    : cargoPackage(source.sourceDir, cargoTargetDir);
  validateCrateSize(cratePath);
  const output = path.join(outputDir, path.basename(cratePath));
  copyFileSync(cratePath, output);
  assertPackedExtensionLegal(output, source);
  packages.push({
    name: source.spec.name,
    manifestPath: path.join(source.sourceDir, "Cargo.toml"),
    cratePath: output,
    target: source.spec.target,
    kind: "wasix-extension-aot",
    size: statSync(output).size,
    sha256: sha256File(output),
    versioning: source.spec.versioning,
    dependencyRequirement: source.spec.dependencyRequirement,
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
  validateRuntimePayload(runtimeRoot);
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
    validateAotPayload(aotRoot, triple);
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
      ...(packageData.dependencyRequirement === undefined ? {} : {
        versioning: packageData.versioning,
        dependencyRequirement: packageData.dependencyRequirement,
      }),
    })),
  };
  writeFileSync(path.join(outputDir, "packages.json"), `${JSON.stringify(data, null, 2)}\n`);
}

function parseArgs(argv) {
  const args = {
    assetDir: "target/oliphaunt-wasix/release-assets",
    extensionsOnly: false,
    outputDir: "target/oliphaunt-wasix/cargo-artifacts",
    workDir: "target/oliphaunt-wasix",
    version: null,
    extensionArtifactRoots: [],
    extensionPartBytes: DEFAULT_EXTENSION_PART_BYTES,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--help" || value === "-h") {
      console.log("usage: tools/release/package_liboliphaunt_wasix_cargo_artifacts.mjs [--asset-dir DIR] [--extensions-only] [--extension-part-bytes BYTES] [--output-dir DIR] [--work-dir DIR] [--version VERSION] [--extension-artifact-root DIR...]");
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
    } else if (value === "--work-dir") {
      args.workDir = requiredValue(argv, ++index, value);
    } else if (value.startsWith("--work-dir=")) {
      args.workDir = value.slice("--work-dir=".length);
    } else if (value === "--version") {
      args.version = requiredValue(argv, ++index, value);
    } else if (value.startsWith("--version=")) {
      args.version = value.slice("--version=".length);
    } else if (value === "--extension-artifact-root") {
      args.extensionArtifactRoots.push(requiredValue(argv, ++index, value));
    } else if (value.startsWith("--extension-artifact-root=")) {
      args.extensionArtifactRoots.push(value.slice("--extension-artifact-root=".length));
    } else if (value === "--extension-part-bytes") {
      args.extensionPartBytes = Number(requiredValue(argv, ++index, value));
    } else if (value.startsWith("--extension-part-bytes=")) {
      args.extensionPartBytes = Number(value.slice("--extension-part-bytes=".length));
    } else {
      fail(`unknown argument ${value}`);
    }
  }
  if (args.extensionArtifactRoots.length === 0) {
    args.extensionArtifactRoots.push("target/extension-artifacts");
  }
  if (!Number.isSafeInteger(args.extensionPartBytes) || args.extensionPartBytes < 1 || args.extensionPartBytes > DEFAULT_EXTENSION_PART_BYTES) {
    fail(`--extension-part-bytes must be an integer in 1..${DEFAULT_EXTENSION_PART_BYTES}`);
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
  const workDir = repoPath(args.workDir);
  const extensionRoots = args.extensionArtifactRoots.map(repoPath);
  if (!args.extensionsOnly && !isDirectory(assetDir)) {
    fail(`WASIX release asset directory does not exist: ${rel(assetDir)}`);
  }

  const sourceRoot = path.join(workDir, "cargo-package-sources");
  const extractRoot = path.join(workDir, "cargo-package-extracted");
  const cargoTargetDir = path.join(workDir, "cargo-package-target");
  rmSync(sourceRoot, { recursive: true, force: true });
  rmSync(extractRoot, { recursive: true, force: true });
  rmSync(outputDir, { recursive: true, force: true });
  rmSync(cargoTargetDir, { recursive: true, force: true });
  mkdirSync(sourceRoot, { recursive: true });
  mkdirSync(extractRoot, { recursive: true });
  mkdirSync(outputDir, { recursive: true });

  const extensionSpecs = extensionCargoSpecs(extensionRoots, extractRoot);
  validateExtensionAotCoverage(extensionSpecs);
  const extensionSources = extensionSpecs.map((spec) => writeExtensionCargoSource(spec, sourceRoot, args.extensionPartBytes));
  const extensionAotSources = extensionSpecs.flatMap((spec) => spec.aotTargets.map((aotSpec) => writeExtensionAotCargoSource(aotSpec, sourceRoot, args.extensionPartBytes)));
  const specs = args.extensionsOnly ? [] : packageSpecs(assetDir, extractRoot, args.version);
  const packages = [
    ...extensionSources.flatMap((source) => packageExtensionSource(source, { outputDir, cargoTargetDir })),
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

if (import.meta.main) {
  try {
    main(Bun.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message.startsWith(`${PREFIX}:`) ? message : `${PREFIX}: ${message}`);
    process.exitCode = 1;
  }
}
