#!/usr/bin/env bun
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  accessSync,
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  manualCargoPackageSource,
  readCargoPackageNameVersion,
} from "./cargo-source-package.mjs";
import {
  allArtifactTargets,
  currentProductVersionSync,
} from "./release-artifact-targets.mjs";
import { fail, ROOT, run } from "./release-cli-utils.mjs";
import {
  currentOliphauntWasixSdkVersion,
  prepareOliphauntWasixReleaseSource,
} from "./package_oliphaunt_wasix_sdk_crate.mjs";
import {
  requiredRuntimeTools,
  requiredToolsPackageTools,
} from "./optimize_native_runtime_payload.mjs";

const TOOL = "local-registry-publish.mjs";
const DEFAULT_RUN_ID = "28049923289";
const DEFAULT_REPO = "f0rr0/oliphaunt";
const DEFAULT_CURRENT_ARTIFACT_ROOT = path.join(ROOT, "target/local-registry-current");
const DEFAULT_ARTIFACT_ROOT = path.join(ROOT, "target/local-registry-artifacts");
const NPM_PACKAGE_SIZE_LIMIT_BYTES = 10 * 1024 * 1024;
const CARGO_PACKAGE_SIZE_LIMIT_BYTES = 10 * 1024 * 1024;
const CARGO_EXTENSION_PART_BYTES = 7 * 1024 * 1024;
const CARGO_EXTENSION_SPLIT_THRESHOLD_BYTES = 9 * 1024 * 1024;
const CRATES_IO_INDEX = "https://github.com/rust-lang/crates.io-index";
const LEGACY_WASIX_ARTIFACT_CRATES = new Set([
  "oliphaunt-wasix-assets",
  "oliphaunt-wasix-aot-aarch64-apple-darwin",
  "oliphaunt-wasix-aot-aarch64-unknown-linux-gnu",
  "oliphaunt-wasix-aot-x86_64-pc-windows-msvc",
  "oliphaunt-wasix-aot-x86_64-unknown-linux-gnu",
]);
const NON_PUBLISHABLE_LOCAL_CARGO_CRATE_PREFIXES = ["oliphaunt-perf-"];
const DEFAULT_ROOTS = [
  DEFAULT_CURRENT_ARTIFACT_ROOT,
  DEFAULT_ARTIFACT_ROOT,
  path.join(ROOT, "target/sdk-artifacts"),
  path.join(ROOT, "target/package/tmp-crate"),
  path.join(ROOT, "target/package/tmp-registry"),
  path.join(ROOT, "target/local-registry-generated/broker-cargo"),
  path.join(ROOT, "target/oliphaunt-broker/cargo-artifacts"),
  path.join(ROOT, "target/extension-artifacts"),
];

function rel(file) {
  const relative = path.relative(ROOT, file);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative)
    ? relative.split(path.sep).join("/")
    : file.split(path.sep).join("/");
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function commandOutput(args) {
  const result = spawnSync(args[0], args.slice(1), {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) {
    fail(TOOL, `${args[0]} failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    fail(TOOL, detail || `${args.join(" ")} failed with exit code ${result.status}`, result.status ?? 1);
  }
  return result.stdout;
}

function commandResult(args, { timeout = undefined } = {}) {
  return spawnSync(args[0], args.slice(1), {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout,
  });
}

function tryCommandOutput(args) {
  const result = commandResult(args);
  if (result.error || result.status !== 0) {
    return null;
  }
  return result.stdout;
}

function runQuiet(args, { cwd = ROOT } = {}) {
  const result = spawnSync(args[0], args.slice(1), {
    cwd,
    stdio: "inherit",
  });
  if (result.error) {
    fail(TOOL, `${args[0]} failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function commandJson(args, label) {
  const output = commandOutput(args);
  try {
    return JSON.parse(output);
  } catch (error) {
    fail(TOOL, `${label} did not return valid JSON: ${error.message}`);
  }
}

function executableExists(name) {
  const pathEnv = process.env.PATH ?? "";
  const extensions = os.platform() === "win32"
    ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";")
    : [""];
  for (const directory of pathEnv.split(path.delimiter)) {
    if (!directory) {
      continue;
    }
    for (const extension of extensions) {
      const candidate = path.join(directory, os.platform() === "win32" && !name.includes(".") ? `${name}${extension}` : name);
      try {
        accessSync(candidate, constants.X_OK);
        return true;
      } catch {
        // Keep searching.
      }
    }
  }
  return false;
}

function requireCommand(name) {
  if (!executableExists(name)) {
    fail(TOOL, `missing required command: ${name}`);
  }
}

function walkFiles(root) {
  const files = [];
  const visit = (current) => {
    const entries = readdirSync(current, { withFileTypes: true })
      .sort((left, right) => compareText(left.name, right.name));
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        visit(entryPath);
      } else if (entry.isFile()) {
        files.push(entryPath);
      }
    }
  };
  visit(root);
  return files;
}

function walkDirsNamed(root, name) {
  const dirs = [];
  const visit = (current) => {
    const entries = readdirSync(current, { withFileTypes: true })
      .sort((left, right) => compareText(left.name, right.name));
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      if (!entry.isDirectory()) {
        continue;
      }
      if (entry.name === name) {
        dirs.push(entryPath);
      }
      visit(entryPath);
    }
  };
  visit(root);
  return dirs;
}

function discoverRoots(artifactRoots) {
  const roots = artifactRoots.length > 0 ? artifactRoots : DEFAULT_ROOTS;
  const seen = new Set();
  const result = [];
  for (const root of roots) {
    const resolved = path.resolve(ROOT, root);
    if (seen.has(resolved) || !existsSync(resolved)) {
      continue;
    }
    seen.add(resolved);
    result.push(resolved);
  }
  return result;
}

function discoverFiles(roots, suffixes) {
  const files = new Set();
  for (const root of roots) {
    const stats = statSync(root);
    if (stats.isFile() && suffixes.some((suffix) => path.basename(root).endsWith(suffix))) {
      files.add(root);
      continue;
    }
    if (stats.isDirectory()) {
      for (const file of walkFiles(root)) {
        if (suffixes.some((suffix) => path.basename(file).endsWith(suffix))) {
          files.add(file);
        }
      }
    }
  }
  return [...files].sort(compareText);
}

function copyTreeContents(source, destination) {
  let copied = 0;
  for (const file of walkFiles(source)) {
    const relative = path.relative(source, file);
    const target = path.join(destination, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(file, target);
    copied += 1;
  }
  return copied;
}

function localPublishArtifacts() {
  const names = commandJson([
    "tools/dev/bun.sh",
    "tools/release/local_registry_metadata.mjs",
    "local-publish-artifacts",
  ], "local registry metadata local-publish-artifacts");
  if (!Array.isArray(names) || names.some((name) => typeof name !== "string" || name.length === 0)) {
    fail(TOOL, "local registry metadata local-publish-artifacts must return a non-empty string list");
  }
  if (names.length === 0) {
    fail(TOOL, "local registry metadata returned no local-publish artifacts");
  }
  const duplicates = [...new Set(names.filter((name, index) => names.indexOf(name) !== index))].sort(compareText);
  if (duplicates.length > 0) {
    fail(TOOL, `local registry metadata returned duplicate local-publish artifacts: ${duplicates.join(", ")}`);
  }
  return names;
}

function discoverExtensionManifests(roots) {
  if (roots.length === 0) {
    return [];
  }
  const args = [
    "tools/dev/bun.sh",
    "tools/release/local_registry_metadata.mjs",
    "discover-extension-manifests",
  ];
  for (const root of roots) {
    args.push("--root", root);
  }
  const values = commandJson(args, "local registry metadata discover-extension-manifests");
  if (!Array.isArray(values) || values.some((value) => typeof value !== "string" || value.length === 0)) {
    fail(TOOL, "local registry metadata discover-extension-manifests must return a string list");
  }
  return values.map((value) => path.resolve(ROOT, value));
}

function listCiArtifacts(repo, runId) {
  requireCommand("gh");
  const data = commandJson([
    "gh",
    "api",
    `repos/${repo}/actions/runs/${runId}/artifacts?per_page=100`,
    "--paginate",
  ], `GitHub Actions artifacts for ${repo} run ${runId}`);
  if (Array.isArray(data)) {
    return data.flatMap((page) => Array.isArray(page?.artifacts) ? page.artifacts : []);
  }
  return Array.isArray(data?.artifacts) ? data.artifacts : [];
}

function parseDownloadArgs(argv) {
  const options = {
    repo: DEFAULT_REPO,
    runId: DEFAULT_RUN_ID,
    destination: DEFAULT_ARTIFACT_ROOT,
    artifacts: [],
    preset: null,
    force: false,
    dryRun: false,
  };
  const readValue = (index, flag) => {
    if (index + 1 >= argv.length) {
      fail(TOOL, `${flag} requires a value`, 2);
    }
    return argv[index + 1];
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "-h" || value === "--help") {
      downloadHelp();
      process.exit(0);
    }
    if (value === "--repo") {
      options.repo = readValue(index, value);
      index += 1;
      continue;
    }
    if (value.startsWith("--repo=")) {
      options.repo = value.slice("--repo=".length);
      continue;
    }
    if (value === "--run-id") {
      options.runId = readValue(index, value);
      index += 1;
      continue;
    }
    if (value.startsWith("--run-id=")) {
      options.runId = value.slice("--run-id=".length);
      continue;
    }
    if (value === "--destination") {
      options.destination = path.resolve(ROOT, readValue(index, value));
      index += 1;
      continue;
    }
    if (value.startsWith("--destination=")) {
      options.destination = path.resolve(ROOT, value.slice("--destination=".length));
      continue;
    }
    if (value === "--artifact") {
      options.artifacts.push(readValue(index, value));
      index += 1;
      continue;
    }
    if (value.startsWith("--artifact=")) {
      options.artifacts.push(value.slice("--artifact=".length));
      continue;
    }
    if (value === "--preset") {
      options.preset = readValue(index, value);
      index += 1;
      continue;
    }
    if (value.startsWith("--preset=")) {
      options.preset = value.slice("--preset=".length);
      continue;
    }
    if (value === "--force") {
      options.force = true;
      continue;
    }
    if (value === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    fail(TOOL, `unknown download argument ${value}`, 2);
  }
  if (options.preset !== null && options.preset !== "local-publish") {
    fail(TOOL, `download --preset must be local-publish, got ${options.preset}`, 2);
  }
  return options;
}

function downloadHelp() {
  console.log(`usage: local-registry-publish.mjs download [-h] [--repo REPO] [--run-id RUN_ID] [--destination DESTINATION] [--artifact ARTIFACT] [--preset local-publish] [--force] [--dry-run]

options:
  -h, --help            show this help message and exit
  --repo REPO
  --run-id RUN_ID
  --destination DESTINATION
  --artifact ARTIFACT
  --preset local-publish
  --force
  --dry-run
`);
}

function download(argv) {
  const options = parseDownloadArgs(argv);
  const selectedArtifacts = [
    ...options.artifacts,
    ...(options.preset === "local-publish" ? localPublishArtifacts() : []),
  ];
  const artifacts = [...new Set(selectedArtifacts)].sort(compareText);
  if (artifacts.length === 0) {
    console.error("No artifacts selected; pass --artifact or --preset local-publish.");
    process.exit(2);
  }

  const available = new Map(listCiArtifacts(options.repo, options.runId).map((artifact) => [artifact.name, artifact]));
  const missing = artifacts.filter((artifact) => !available.has(artifact));
  if (missing.length > 0) {
    console.error(`Run ${options.runId} is missing artifacts: ${missing.join(", ")}`);
    process.exit(1);
  }
  if (options.dryRun) {
    for (const artifact of artifacts) {
      console.log(`${artifact}\t${available.get(artifact).size_in_bytes ?? 0}`);
    }
    return;
  }

  mkdirSync(options.destination, { recursive: true });
  for (const artifact of artifacts) {
    const artifactDir = path.join(options.destination, artifact);
    if (existsSync(artifactDir) && readdirSync(artifactDir).length > 0 && !options.force) {
      console.log(`Skipping existing ${rel(artifactDir)}`);
      continue;
    }
    rmSync(artifactDir, { recursive: true, force: true });
    mkdirSync(artifactDir, { recursive: true });
    console.log(`Downloading ${artifact} from ${options.repo} run ${options.runId}`);
    runQuiet([
      "gh",
      "run",
      "download",
      options.runId,
      "--repo",
      options.repo,
      "--name",
      artifact,
      "--dir",
      artifactDir,
    ]);
  }
}

function surfaceResult(surface) {
  return {
    surface,
    published: [],
    staged: [],
    skipped: [],
  };
}

function reportSurfaceResult(result) {
  return {
    published: result.published,
    skipped: result.skipped,
    staged: result.staged,
    surface: result.surface,
  };
}

function addSkip(result, message, strict) {
  result.skipped.push(message);
  if (strict) {
    fail(TOOL, message);
  }
}

function publishMaven(roots, registryRoot, dryRun, strict) {
  const result = surfaceResult("maven");
  const candidates = roots
    .filter((root) => statSync(root).isDirectory())
    .flatMap((root) => walkDirsNamed(root, "maven"))
    .sort(compareText);
  if (candidates.length === 0) {
    addSkip(result, "no staged Maven repository directories named maven found", strict);
    return result;
  }
  const mavenRoot = path.join(registryRoot, "maven");
  if (dryRun) {
    result.published.push(...candidates.map((candidate) => `dry-run maven copy ${rel(candidate)}`));
    return result;
  }
  rmSync(mavenRoot, { recursive: true, force: true });
  mkdirSync(mavenRoot, { recursive: true });
  for (const candidate of candidates) {
    const count = copyTreeContents(candidate, mavenRoot);
    result.published.push(`${rel(candidate)} (${count} files)`);
  }
  result.staged.push(rel(mavenRoot));
  return result;
}

function publishSwift(roots, registryRoot, dryRun, strict) {
  const result = surfaceResult("swift");
  const swiftFiles = discoverFiles(roots, [".swift", ".zip"])
    .filter((file) => path.basename(file) === "Package.swift.release" || path.basename(file).endsWith("-source.zip") || file.includes("swift"));
  if (swiftFiles.length === 0) {
    addSkip(result, "no SwiftPM package artifacts found", strict);
    return result;
  }
  if (!executableExists("swift")) {
    result.skipped.push("swift is not installed; staged artifacts are copyable, registry publish skipped on this Linux host");
  }
  const swiftRoot = path.join(registryRoot, "swift");
  if (dryRun) {
    result.published.push(...swiftFiles.map((file) => `dry-run swift stage ${rel(file)}`));
    return result;
  }
  rmSync(swiftRoot, { recursive: true, force: true });
  mkdirSync(swiftRoot, { recursive: true });
  for (const file of swiftFiles) {
    const target = path.join(swiftRoot, path.basename(file));
    copyFileSync(file, target);
    result.staged.push(rel(target));
  }
  return result;
}

function hostCargoReleaseTarget() {
  const arch = os.arch();
  const platform = os.platform();
  if (platform === "linux" && arch === "x64") {
    return "linux-x64-gnu";
  }
  if (platform === "linux" && arch === "arm64") {
    return "linux-arm64-gnu";
  }
  if (platform === "darwin" && arch === "arm64") {
    return "macos-arm64";
  }
  if (platform === "win32" && arch === "x64") {
    return "windows-x64-msvc";
  }
  return null;
}

function hostNpmTarget() {
  return hostCargoReleaseTarget();
}

function localFail(message) {
  fail(TOOL, message);
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

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function globPatternMatches(name, pattern) {
  return new RegExp(`^${escapeRegExp(pattern).replaceAll("\\*", ".*")}$`, "u").test(name);
}

function releaseAssetCandidate(root, name, destination) {
  const destinationResolved = path.resolve(destination);
  if (isFile(root) && path.basename(root) === name) {
    return root;
  }
  if (!isDirectory(root)) {
    return null;
  }
  const candidates = walkFiles(root)
    .filter((file) => path.basename(file) === name && !pathIsUnder(file, destinationResolved))
    .sort(compareText);
  if (candidates.length === 0) {
    return null;
  }
  const selected = candidates[0];
  for (const candidate of candidates.slice(1)) {
    if (sha256File(candidate) !== sha256File(selected)) {
      throw new Error(`conflicting release asset ${name} within ${rel(root)}: ${rel(selected)} and ${rel(candidate)} differ`);
    }
  }
  return selected;
}

function copyReleaseAssetSet(roots, destination, names) {
  for (const root of roots) {
    const selected = [];
    for (const name of names) {
      const candidate = releaseAssetCandidate(root, name, destination);
      if (candidate === null) {
        break;
      }
      selected.push(candidate);
    }
    if (selected.length !== names.length) {
      continue;
    }
    rmSync(destination, { recursive: true, force: true });
    mkdirSync(destination, { recursive: true });
    const copied = [];
    for (const source of selected) {
      const target = path.join(destination, path.basename(source));
      copyFileSync(source, target);
      copied.push(target);
    }
    return copied;
  }
  return [];
}

function copyReleaseAssets(roots, destination, patterns) {
  const selected = new Map();
  const destinationResolved = path.resolve(destination);
  for (const root of roots) {
    if (!isDirectory(root)) {
      continue;
    }
    const rootCandidates = walkFiles(root)
      .filter((file) =>
        patterns.some((pattern) => globPatternMatches(path.basename(file), pattern)) &&
        !pathIsUnder(file, destinationResolved))
      .sort(compareText);
    for (const file of rootCandidates) {
      const existing = selected.get(path.basename(file));
      if (existing === undefined) {
        selected.set(path.basename(file), [file, root]);
        continue;
      }
      const [existingFile, existingRoot] = existing;
      if (path.resolve(existingRoot) !== path.resolve(root)) {
        continue;
      }
      if (sha256File(existingFile) !== sha256File(file)) {
        throw new Error(`conflicting release asset ${path.basename(file)} within ${rel(root)}: ${rel(existingFile)} and ${rel(file)} differ`);
      }
    }
  }
  if (selected.size === 0) {
    return [];
  }
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(destination, { recursive: true });
  const copied = [];
  for (const [source] of [...selected.values()].sort((left, right) => compareText(path.basename(left[0]), path.basename(right[0])))) {
    const target = path.join(destination, path.basename(source));
    copyFileSync(source, target);
    copied.push(target);
  }
  return copied;
}

function releaseAssetDirSelected(roots, assetDir) {
  const resolved = path.resolve(assetDir);
  return roots.some((root) => path.resolve(root) === resolved);
}

function releaseAssetDirHasFiles(assetDir, patterns) {
  if (!isDirectory(assetDir)) {
    return false;
  }
  return walkFiles(assetDir).some((file) => patterns.some((pattern) => globPatternMatches(path.basename(file), pattern)));
}

function releaseAssetDirHasExactFiles(assetDir, names) {
  return isDirectory(assetDir) && names.every((name) => isFile(path.join(assetDir, name)));
}

function missingReleaseAssetNames(assetDir, names) {
  return names.filter((name) => !isFile(path.join(assetDir, name)));
}

function nativeReleaseAssetName(version, targetId, kind) {
  const matches = allArtifactTargets({
    product: "liboliphaunt-native",
    kind,
    publishedOnly: true,
  }, TOOL)
    .filter((target) =>
      target.target === targetId &&
      (target.surfaces.includes("rust-native-direct") || target.surfaces.includes("typescript-native-direct")))
    .map((target) => target.asset.replaceAll("{version}", version));
  if (matches.length !== 1) {
    fail(TOOL, `expected exactly one published liboliphaunt-native ${kind} asset for ${targetId}, got ${JSON.stringify(matches)}`);
  }
  return matches[0];
}

function nativeSplitReleaseAssetNames(version, targetId) {
  return [
    nativeReleaseAssetName(version, targetId, "native-runtime"),
    nativeReleaseAssetName(version, targetId, "native-tools"),
  ];
}

function nativeNpmReleaseAssetNames(version, targetId) {
  return [
    ...nativeSplitReleaseAssetNames(version, targetId),
    `liboliphaunt-${version}-icu-data.tar.gz`,
  ];
}

function nativeSplitReleaseAssetsReady(assetDir, version, targetId) {
  const required = nativeSplitReleaseAssetNames(version, targetId);
  return {
    ready: releaseAssetDirHasExactFiles(assetDir, required),
    missing: missingReleaseAssetNames(assetDir, required),
  };
}

function nativeNpmReleaseAssetsReady(assetDir, version, targetId) {
  const required = nativeNpmReleaseAssetNames(version, targetId);
  return {
    ready: releaseAssetDirHasExactFiles(assetDir, required),
    missing: missingReleaseAssetNames(assetDir, required),
  };
}

function nativeSplitReleaseAssetMissingMessage(assetDir, version, targetId, missing) {
  const required = nativeSplitReleaseAssetNames(version, targetId).join(", ");
  return `native split release asset staging for ${targetId} requires runtime and tools assets (${required}) under ${rel(assetDir)}; missing ${missing.join(", ")}`;
}

function nativeNpmReleaseAssetMissingMessage(assetDir, version, targetId, missing) {
  const required = nativeNpmReleaseAssetNames(version, targetId).join(", ");
  return `native npm artifact staging for ${targetId} requires runtime, tools, and ICU assets (${required}) under ${rel(assetDir)}; missing ${missing.join(", ")}`;
}

function cargoTargetTriple(targetId) {
  if (targetId === "linux-x64-gnu") {
    return "x86_64-unknown-linux-gnu";
  }
  if (targetId === "linux-arm64-gnu") {
    return "aarch64-unknown-linux-gnu";
  }
  if (targetId === "macos-arm64") {
    return "aarch64-apple-darwin";
  }
  if (targetId === "windows-x64-msvc") {
    return "x86_64-pc-windows-msvc";
  }
  return null;
}

function extensionNpmPackage(sqlName) {
  return `@oliphaunt/extension-${sqlName.replaceAll("_", "-")}`;
}

function extensionNpmTargetPackage(sqlName, target) {
  return `${extensionNpmPackage(sqlName)}-${target}`;
}

function extensionNpmPayloadPackage(sqlName, target, index) {
  return `${extensionNpmTargetPackage(sqlName, target)}-payload-${index}`;
}

function nativeExtensionCargoPackageName(product, target) {
  return `${product}-${target}`;
}

function nativeExtensionCargoLinksName(product, target) {
  const stem = `extension_${product.replace(/^oliphaunt-extension-/u, "")}_${target}`;
  return `oliphaunt_artifact_${stem.replaceAll("-", "_")}`;
}

function nativeExtensionCargoPartPackageName(product, target, index) {
  return `${nativeExtensionCargoPackageName(product, target)}-part-${String(index).padStart(3, "0")}`;
}

function rustCrateIdent(crateName) {
  return crateName.replaceAll("-", "_");
}

function tomlString(value) {
  return JSON.stringify(value);
}

function npmPackageIdentity(tarball) {
  const members = tryCommandOutput(["tar", "-tzf", tarball]);
  if (members === null) {
    return null;
  }
  for (const member of members.split(/\r?\n/u).filter(Boolean)) {
    if (!member.endsWith("/package.json")) {
      continue;
    }
    const rawPackageJson = tryCommandOutput(["tar", "-xOzf", tarball, member]);
    if (rawPackageJson === null) {
      continue;
    }
    try {
      const packageJson = JSON.parse(rawPackageJson);
      if (typeof packageJson.name === "string" && typeof packageJson.version === "string") {
        return { name: packageJson.name, version: packageJson.version };
      }
    } catch {
      return null;
    }
  }
  return null;
}

function pathIsUnder(file, root) {
  const relative = path.relative(path.resolve(root), path.resolve(file));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function npmTarballPriority(tarball, registryRoot) {
  let priority = 20;
  for (const [root, value] of [
    [path.join(registryRoot, "npm-generated"), 110],
    [path.join(ROOT, "target/release/npm-packages"), 100],
    [path.join(ROOT, "target/sdk-artifacts"), 90],
    [path.join(registryRoot, "npm-extension-packages"), 80],
    [DEFAULT_CURRENT_ARTIFACT_ROOT, 60],
    [DEFAULT_ARTIFACT_ROOT, 30],
  ]) {
    if (pathIsUnder(tarball, root)) {
      priority = value;
      break;
    }
  }
  let modified = 0;
  try {
    modified = statSync(tarball).mtimeMs;
  } catch {
    // Missing tarballs are handled by the caller's artifact discovery.
  }
  return [priority, modified, tarball];
}

function compareNpmTarballPriority(left, right) {
  for (let index = 0; index < 2; index += 1) {
    if (left[index] !== right[index]) {
      return left[index] - right[index];
    }
  }
  return compareText(left[2], right[2]);
}

function selectNpmTarballs(tarballs, registryRoot, result) {
  const selected = new Map();
  const unidentified = [];
  for (const tarball of tarballs) {
    const identity = npmPackageIdentity(tarball);
    if (identity === null) {
      unidentified.push(tarball);
      continue;
    }
    const key = `${identity.name}\0${identity.version}`;
    const current = selected.get(key);
    if (current === undefined) {
      selected.set(key, tarball);
      continue;
    }
    const preferred = compareNpmTarballPriority(
      npmTarballPriority(tarball, registryRoot),
      npmTarballPriority(current, registryRoot),
    ) > 0
      ? tarball
      : current;
    const skipped = preferred === tarball ? current : tarball;
    selected.set(key, preferred);
    result.staged.push(
      `preferred ${rel(preferred)} over ${rel(skipped)} for ${identity.name}@${identity.version}`,
    );
  }
  return [...unidentified, ...selected.values()].sort(compareText);
}

function safeNpmPackageFilenamePrefix(packageName) {
  return packageName.replace(/^@/u, "").replaceAll("/", "-");
}

function readJsonFile(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    fail(TOOL, `${rel(file)} is not valid JSON: ${error.message}`);
  }
}

function npmPackageDirsUnder(packageRoot) {
  const packages = new Map();
  if (!isDirectory(packageRoot)) {
    fail(TOOL, `${rel(packageRoot)} does not contain npm package descriptors`);
  }
  for (const entry of readdirSync(packageRoot, { withFileTypes: true }).sort((left, right) => compareText(left.name, right.name))) {
    if (!entry.isDirectory()) {
      continue;
    }
    const packageDir = path.join(packageRoot, entry.name);
    const packageJsonPath = path.join(packageDir, "package.json");
    if (!isFile(packageJsonPath)) {
      continue;
    }
    const packageJson = readJsonFile(packageJsonPath);
    const packageName = packageJson.name;
    if (typeof packageName !== "string" || packageName.length === 0) {
      fail(TOOL, `${rel(packageJsonPath)} must declare name`);
    }
    if (packages.has(packageName)) {
      fail(TOOL, `duplicate npm package name ${packageName} in ${rel(packages.get(packageName))} and ${rel(packageDir)}`);
    }
    packages.set(packageName, packageDir);
  }
  if (packages.size === 0) {
    fail(TOOL, `${rel(packageRoot)} does not contain npm package descriptors`);
  }
  return packages;
}

function artifactNpmPackageTargets(product, kind, surface, packageRoot) {
  const packageDirs = npmPackageDirsUnder(packageRoot);
  const packages = [];
  for (const target of allArtifactTargets({ product, kind, surface, publishedOnly: true }, TOOL)) {
    const packageName = target.npmPackage;
    if (typeof packageName !== "string" || packageName.length === 0) {
      fail(TOOL, `${target.id} must declare npmPackage for npm artifact package publication`);
    }
    const packageDir = packageDirs.get(packageName);
    if (packageDir === undefined) {
      fail(TOOL, `${target.id} declares npm package ${packageName}, but no descriptor exists under ${rel(packageRoot)}`);
    }
    packages.push([packageName, packageDir, target]);
  }
  const expected = packages.map(([packageName]) => packageName).sort(compareText);
  const actual = [...packageDirs.keys()].sort(compareText);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(TOOL, `${rel(packageRoot)} package descriptors must match published ${product} npm artifact targets for ${surface}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
  return packages.sort((left, right) => compareText(left[2].target, right[2].target));
}

function validateNoConsumerInstallScripts(packageJson, label) {
  const scripts = packageJson.scripts;
  if (scripts === undefined || scripts === null || typeof scripts !== "object" || Array.isArray(scripts)) {
    return;
  }
  const forbidden = ["preinstall", "install", "postinstall", "prepare"].filter((script) => Object.hasOwn(scripts, script));
  if (forbidden.length > 0) {
    fail(TOOL, `${label} must not declare consumer install lifecycle scripts: ${forbidden.join(", ")}`);
  }
}

function validateNpmPackageMetadata(packageName, packageDir, version, { target = null } = {}) {
  const packageJsonPath = path.join(packageDir, "package.json");
  if (!isFile(packageJsonPath)) {
    fail(TOOL, `${rel(packageDir)} is missing package.json`);
  }
  const packageJson = readJsonFile(packageJsonPath);
  if (packageJson.name !== packageName) {
    fail(TOOL, `${rel(packageJsonPath)} name must be ${packageName}`);
  }
  if (packageJson.version !== version) {
    fail(TOOL, `${packageName} package version must match ${version}`);
  }
  if (target !== null && packageJson.oliphaunt?.target !== target) {
    fail(TOOL, `${packageName} package oliphaunt.target must be ${target}`);
  }
  validateNoConsumerInstallScripts(packageJson, `${packageName} npm package`);
}

function stageNpmPackageDescriptor(
  packageName,
  sourceDir,
  stageRoot,
  version,
  {
    extraDescriptors = [],
    target = null,
  } = {},
) {
  const stageDir = path.join(stageRoot, safeNpmPackageFilenamePrefix(packageName));
  rmSync(stageDir, { recursive: true, force: true });
  mkdirSync(stageDir, { recursive: true });
  for (const descriptor of ["package.json", "README.md", ...extraDescriptors]) {
    const source = path.join(sourceDir, descriptor);
    if (!isFile(source)) {
      fail(TOOL, `${rel(sourceDir)} is missing ${descriptor}`);
    }
    copyFileSync(source, path.join(stageDir, descriptor));
  }
  validateNpmPackageMetadata(packageName, stageDir, version, { target });
  return stageDir;
}

function runArchiveCommand(args, label) {
  const result = spawnSync(args[0], args.slice(1), {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) {
    fail(TOOL, `${label} failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    fail(TOOL, `${label} failed${detail ? `: ${detail}` : ""}`);
  }
  return result.stdout;
}

function archiveTempDir() {
  const root = path.join(ROOT, "target", "local-registry-archive-extract");
  mkdirSync(root, { recursive: true });
  return mkdtempSync(path.join(root, "extract-"));
}

function copyExtractedTree(source, destination) {
  if (!isDirectory(source)) {
    fail(TOOL, `release archive is missing extracted tree ${source}`);
  }
  rmSync(destination, { recursive: true, force: true });
  cpSync(source, destination, { recursive: true });
}

function extractArchiveMember(archive, member, destination, { mode = null } = {}) {
  const temp = archiveTempDir();
  try {
    if (archive.endsWith(".zip")) {
      requireCommand("unzip");
      runArchiveCommand(["unzip", "-q", archive, member, "-d", temp], `extract ${member} from ${rel(archive)}`);
    } else {
      requireCommand("tar");
      runArchiveCommand(["tar", "-xf", archive, "-C", temp, member], `extract ${member} from ${rel(archive)}`);
    }
    const extracted = path.join(temp, ...member.split("/"));
    if (!isFile(extracted)) {
      fail(TOOL, `${rel(archive)} is missing ${member}`);
    }
    mkdirSync(path.dirname(destination), { recursive: true });
    copyFileSync(extracted, destination);
    if (mode !== null) {
      chmodSync(destination, mode);
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

function extractArchiveTree(archive, sourcePrefix, destination) {
  const temp = archiveTempDir();
  const prefix = sourcePrefix.replace(/\/+$/u, "");
  try {
    if (archive.endsWith(".zip")) {
      requireCommand("unzip");
      runArchiveCommand(["unzip", "-q", archive, `${prefix}/*`, "-d", temp], `extract ${prefix} from ${rel(archive)}`);
    } else {
      requireCommand("tar");
      runArchiveCommand(["tar", "-xf", archive, "-C", temp, prefix], `extract ${prefix} from ${rel(archive)}`);
    }
    copyExtractedTree(path.join(temp, ...prefix.split("/")), destination);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

function runNativePayloadOptimizer(stage, target, toolSet) {
  runQuiet([
    "tools/dev/bun.sh",
    "tools/release/optimize_native_runtime_payload.mjs",
    stage,
    "--target",
    target,
    "--tool-set",
    toolSet,
  ]);
}

function ensureNativeToolsAbsentFromRuntime(stage, target) {
  const runtimeDir = path.join(stage, "runtime");
  const leaked = [];
  for (const tool of requiredToolsPackageTools(target, runtimeDir)) {
    if (existsSync(path.join(runtimeDir, "bin", tool))) {
      leaked.push(`runtime/bin/${tool}`);
    }
  }
  if (leaked.length > 0) {
    fail(TOOL, `${rel(stage)} root runtime package must not contain split native tools: ${leaked.join(", ")}`);
  }
}

function requiredRuntimeMemberPaths(target, prefix) {
  return requiredRuntimeTools(target).map((tool) => `${prefix.replace(/\/+$/u, "")}/${tool}`);
}

function requiredToolsMemberPaths(target, prefix) {
  return requiredToolsPackageTools(target).map((tool) => `${prefix.replace(/\/+$/u, "")}/${tool}`);
}

function pnpmPackForNpmPublish(packageDir, tarballRoot) {
  const packageJson = readJsonFile(path.join(packageDir, "package.json"));
  const packageName = packageJson.name;
  const packageVersion = packageJson.version;
  if (typeof packageName !== "string" || packageName.length === 0) {
    fail(TOOL, `${rel(path.join(packageDir, "package.json"))} must declare a package name`);
  }
  if (typeof packageVersion !== "string" || packageVersion.length === 0) {
    fail(TOOL, `${rel(path.join(packageDir, "package.json"))} must declare a package version`);
  }
  const packDir = path.join(tarballRoot, safeNpmPackageFilenamePrefix(packageName));
  rmSync(packDir, { recursive: true, force: true });
  mkdirSync(packDir, { recursive: true });
  const result = spawnSync("pnpm", ["pack", "--pack-destination", packDir, "--json"], {
    cwd: packageDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) {
    fail(TOOL, `pnpm pack for ${packageName} failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    fail(TOOL, `pnpm pack for ${packageName} failed${detail ? `: ${detail}` : ""}`);
  }
  let manifest;
  try {
    manifest = JSON.parse(result.stdout);
  } catch (error) {
    fail(TOOL, `pnpm pack for ${packageName} did not emit JSON: ${error.message}`);
  }
  const row = Array.isArray(manifest) ? manifest[0] : manifest;
  const filename = row?.filename;
  if (typeof filename !== "string" || !filename.endsWith(".tgz")) {
    fail(TOOL, `pnpm pack for ${packageName} did not report a .tgz filename`);
  }
  const destinationTarball = path.isAbsolute(filename)
    ? filename
    : path.join(packDir, path.basename(filename));
  if (!isFile(destinationTarball)) {
    fail(TOOL, `pnpm pack for ${packageName} did not create ${rel(destinationTarball)}`);
  }
  return destinationTarball;
}

function tarballMembers(tarball) {
  return runArchiveCommand(["tar", "-tzf", tarball], `list ${rel(tarball)}`)
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
}

function tarballPackageJson(tarball) {
  const text = runArchiveCommand(["tar", "-xOzf", tarball, "package/package.json"], `read package.json from ${rel(tarball)}`);
  try {
    return JSON.parse(text);
  } catch (error) {
    fail(TOOL, `${rel(tarball)} package/package.json is not valid JSON: ${error.message}`);
  }
}

function packedPackageContains(tarball, packageName, version, requiredMembers, { executableMembers = [] } = {}) {
  const members = new Set(tarballMembers(tarball));
  if (!members.has("package/package.json")) {
    fail(TOOL, `${rel(tarball)} is missing package/package.json`);
  }
  const packageJson = tarballPackageJson(tarball);
  if (packageJson.name !== packageName) {
    fail(TOOL, `${rel(tarball)} package name must be ${packageName}, got ${JSON.stringify(packageJson.name)}`);
  }
  if (packageJson.version !== version) {
    fail(TOOL, `${rel(tarball)} package version must be ${version}, got ${JSON.stringify(packageJson.version)}`);
  }
  for (const member of requiredMembers) {
    if (!members.has(member)) {
      fail(TOOL, `${rel(tarball)} is missing ${member}`);
    }
  }
  for (const member of executableMembers) {
    if (!members.has(member)) {
      fail(TOOL, `${rel(tarball)} is missing executable ${member}`);
    }
    const mode = runArchiveCommand(["tar", "-tvzf", tarball, member], `inspect ${member} in ${rel(tarball)}`).trim().split(/\s+/u)[0] ?? "";
    if (!/[xst]/u.test(mode)) {
      fail(TOOL, `${rel(tarball)} ${member} must be executable`);
    }
  }
}

function packedIcuPackageContains(tarball, packageName, version) {
  const members = new Set(tarballMembers(tarball));
  if (!members.has("package/package.json")) {
    fail(TOOL, `${rel(tarball)} is missing package/package.json`);
  }
  const packageJson = tarballPackageJson(tarball);
  if (packageJson.name !== packageName) {
    fail(TOOL, `${rel(tarball)} package name must be ${packageName}, got ${JSON.stringify(packageJson.name)}`);
  }
  if (packageJson.version !== version) {
    fail(TOOL, `${rel(tarball)} package version must be ${version}, got ${JSON.stringify(packageJson.version)}`);
  }
  const metadata = packageJson.oliphaunt;
  if (
    metadata?.product !== "oliphaunt-icu" ||
    metadata?.kind !== "icu-data" ||
    metadata?.target !== "portable" ||
    metadata?.dataRelativePath !== "share/icu"
  ) {
    fail(TOOL, `${rel(tarball)} package.json must declare portable oliphaunt-icu metadata`);
  }
  if (!members.has("package/OliphauntICU.podspec")) {
    fail(TOOL, `${rel(tarball)} is missing package/OliphauntICU.podspec`);
  }
  const hasIcuData = [...members].some((member) => {
    if (!member.startsWith("package/share/icu/")) {
      return false;
    }
    const relative = member.slice("package/share/icu/".length).split("/").filter(Boolean);
    return relative.length > 0 && relative[0].startsWith("icudt");
  });
  if (!hasIcuData) {
    fail(TOOL, `${rel(tarball)} is missing package/share/icu/icudt* data files`);
  }
}

function npmPackAndValidate(packageName, packageDir, version, tarballRoot, { requiredMembers, executableMembers = [], target = null }) {
  validateNpmPackageMetadata(packageName, packageDir, version, { target });
  const tarball = pnpmPackForNpmPublish(packageDir, tarballRoot);
  packedPackageContains(tarball, packageName, version, requiredMembers, { executableMembers });
  return tarball;
}

function stageLiboliphauntNpmPayloads(version, stageRoot, { targetSet = null } = {}) {
  const assetDir = path.join(ROOT, "target/liboliphaunt/release-assets");
  const packages = artifactNpmPackageTargets(
    "liboliphaunt-native",
    "native-runtime",
    "typescript-native-direct",
    path.join(ROOT, "src/runtimes/liboliphaunt/native/packages"),
  );
  const stages = new Map();
  for (const [packageName, packageDir, target] of packages) {
    if (targetSet !== null && !targetSet.has(target.target)) {
      continue;
    }
    if (typeof target.libraryRelativePath !== "string" || target.libraryRelativePath.length === 0) {
      fail(TOOL, `${target.id} must declare libraryRelativePath for npm artifact package publication`);
    }
    const stage = stageNpmPackageDescriptor(packageName, packageDir, stageRoot, version, { target: target.target });
    const archive = path.join(assetDir, target.asset.replaceAll("{version}", version));
    extractArchiveMember(archive, target.libraryRelativePath, path.join(stage, target.libraryRelativePath));
    extractArchiveTree(archive, "runtime", path.join(stage, "runtime"));
    ensureNativeToolsAbsentFromRuntime(stage, target.target);
    runNativePayloadOptimizer(stage, target.target, "runtime");
    stages.set(packageName, stage);
  }
  return stages;
}

function stageLiboliphauntToolsNpmPayloads(version, stageRoot, { targetSet = null } = {}) {
  const assetDir = path.join(ROOT, "target/liboliphaunt/release-assets");
  const packages = artifactNpmPackageTargets(
    "liboliphaunt-native",
    "native-tools",
    "typescript-native-direct",
    path.join(ROOT, "src/runtimes/liboliphaunt/native/tools-packages"),
  );
  const stages = new Map();
  for (const [packageName, packageDir, target] of packages) {
    if (targetSet !== null && !targetSet.has(target.target)) {
      continue;
    }
    const stage = stageNpmPackageDescriptor(packageName, packageDir, stageRoot, version, { target: target.target });
    const archive = path.join(assetDir, target.asset.replaceAll("{version}", version));
    for (const tool of requiredToolsPackageTools(target.target)) {
      const member = `runtime/bin/${tool}`;
      extractArchiveMember(archive, member, path.join(stage, member), { mode: archive.endsWith(".zip") ? 0o755 : null });
    }
    runNativePayloadOptimizer(stage, target.target, "tools");
    stages.set(packageName, stage);
  }
  return stages;
}

function stageLiboliphauntIcuNpmPayload(version, stageRoot) {
  const packageName = "@oliphaunt/icu";
  const stage = stageNpmPackageDescriptor(
    packageName,
    path.join(ROOT, "src/runtimes/liboliphaunt/native/icu-npm"),
    stageRoot,
    version,
    { extraDescriptors: ["OliphauntICU.podspec"], target: "portable" },
  );
  extractArchiveTree(
    path.join(ROOT, "target/liboliphaunt/release-assets", `liboliphaunt-${version}-icu-data.tar.gz`),
    "share/icu",
    path.join(stage, "share/icu"),
  );
  return stage;
}

function liboliphauntNpmTarballs(version, stageRoot, tarballRoot, { targetSet = null, includeIcu = true } = {}) {
  const packages = [];
  const runtimeStages = stageLiboliphauntNpmPayloads(version, stageRoot, { targetSet });
  const toolsStages = stageLiboliphauntToolsNpmPayloads(version, stageRoot, { targetSet });
  for (const [packageName, , target] of artifactNpmPackageTargets(
    "liboliphaunt-native",
    "native-runtime",
    "typescript-native-direct",
    path.join(ROOT, "src/runtimes/liboliphaunt/native/packages"),
  )) {
    if (targetSet !== null && !targetSet.has(target.target)) {
      continue;
    }
    const runtimeMembers = requiredRuntimeMemberPaths(target.target, "package/runtime/bin");
    const requiredMembers = [`package/${target.libraryRelativePath}`, ...runtimeMembers];
    packages.push([
      packageName,
      npmPackAndValidate(packageName, runtimeStages.get(packageName), version, tarballRoot, {
        requiredMembers,
        executableMembers: runtimeMembers,
        target: target.target,
      }),
    ]);
  }
  for (const [packageName, , target] of artifactNpmPackageTargets(
    "liboliphaunt-native",
    "native-tools",
    "typescript-native-direct",
    path.join(ROOT, "src/runtimes/liboliphaunt/native/tools-packages"),
  )) {
    if (targetSet !== null && !targetSet.has(target.target)) {
      continue;
    }
    const runtimeMembers = requiredToolsMemberPaths(target.target, "package/runtime/bin");
    packages.push([
      packageName,
      npmPackAndValidate(packageName, toolsStages.get(packageName), version, tarballRoot, {
        requiredMembers: runtimeMembers,
        executableMembers: runtimeMembers,
        target: target.target,
      }),
    ]);
  }
  if (includeIcu) {
    const packageName = "@oliphaunt/icu";
    const stage = stageLiboliphauntIcuNpmPayload(version, stageRoot);
    const tarball = pnpmPackForNpmPublish(stage, tarballRoot);
    packedIcuPackageContains(tarball, packageName, version);
    packages.push([packageName, tarball]);
  }
  return packages;
}

function stageBrokerNpmPayloads(version, stageRoot, { targetSet = null } = {}) {
  const assetDir = path.join(ROOT, "target/oliphaunt-broker/release-assets");
  const packages = artifactNpmPackageTargets(
    "oliphaunt-broker",
    "broker-helper",
    "typescript-broker",
    path.join(ROOT, "src/runtimes/broker/packages"),
  );
  const stages = new Map();
  for (const [packageName, packageDir, target] of packages) {
    if (targetSet !== null && !targetSet.has(target.target)) {
      continue;
    }
    if (typeof target.executableRelativePath !== "string" || target.executableRelativePath.length === 0) {
      fail(TOOL, `${target.id} must declare executableRelativePath for npm artifact package publication`);
    }
    const stage = stageNpmPackageDescriptor(packageName, packageDir, stageRoot, version, { target: target.target });
    const archive = path.join(assetDir, target.asset.replaceAll("{version}", version));
    extractArchiveMember(archive, target.executableRelativePath, path.join(stage, target.executableRelativePath), {
      mode: archive.endsWith(".zip") ? 0o755 : null,
    });
    stages.set(packageName, stage);
  }
  return stages;
}

function brokerNpmTarballs(version, stageRoot, tarballRoot, { targetSet = null } = {}) {
  const packages = [];
  const stages = stageBrokerNpmPayloads(version, stageRoot, { targetSet });
  for (const [packageName, , target] of artifactNpmPackageTargets(
    "oliphaunt-broker",
    "broker-helper",
    "typescript-broker",
    path.join(ROOT, "src/runtimes/broker/packages"),
  )) {
    if (targetSet !== null && !targetSet.has(target.target)) {
      continue;
    }
    const requiredMembers = [`package/${target.executableRelativePath}`];
    packages.push([
      packageName,
      npmPackAndValidate(packageName, stages.get(packageName), version, tarballRoot, {
        requiredMembers,
        executableMembers: requiredMembers,
        target: target.target,
      }),
    ]);
  }
  return packages;
}

function stageReleaseAssetNpmPackages(roots, registryRoot, result, strict) {
  const outputRoot = path.join(registryRoot, "npm-generated", "release-asset-packages");
  const stageRoot = path.join(outputRoot, "sources");
  const tarballRoot = path.join(outputRoot, "tarballs");
  rmSync(outputRoot, { recursive: true, force: true });
  mkdirSync(stageRoot, { recursive: true });
  mkdirSync(tarballRoot, { recursive: true });

  const tarballs = [];
  const target = hostNpmTarget();
  const targetSet = target === null ? null : new Set([target]);

  const libVersion = currentProductVersionSync("liboliphaunt-native", TOOL);
  const libAssetDir = path.join(ROOT, "target/liboliphaunt/release-assets");
  const copiedLibAssets = target === null
    ? []
    : copyReleaseAssetSet(roots, libAssetDir, nativeNpmReleaseAssetNames(libVersion, target));
  if (target === null) {
    result.skipped.push("current host does not map to a supported native npm artifact target");
  } else if (
    copiedLibAssets.length > 0 ||
    (releaseAssetDirSelected(roots, libAssetDir) && releaseAssetDirHasFiles(libAssetDir, [
      `liboliphaunt-${libVersion}-*`,
      `oliphaunt-tools-${libVersion}-*`,
    ]))
  ) {
    const { ready, missing } = nativeNpmReleaseAssetsReady(libAssetDir, libVersion, target);
    if (!ready) {
      const message = nativeNpmReleaseAssetMissingMessage(libAssetDir, libVersion, target, missing);
      result.skipped.push(message);
      if (strict) {
        fail(TOOL, message);
      }
    } else {
      if (copiedLibAssets.length > 0) {
        result.staged.push(`staged ${copiedLibAssets.length} liboliphaunt release asset(s)`);
      }
      tarballs.push(...liboliphauntNpmTarballs(libVersion, stageRoot, tarballRoot, { targetSet }).map(([, tarball]) => tarball));
    }
  } else {
    result.skipped.push("no liboliphaunt release assets found for native npm artifact packages");
  }

  const brokerVersion = currentProductVersionSync("oliphaunt-broker", TOOL);
  const brokerAssetDir = path.join(ROOT, "target/oliphaunt-broker/release-assets");
  const copiedBrokerAssets = copyReleaseAssets(roots, brokerAssetDir, [
    "oliphaunt-broker-*.tar.gz",
    "oliphaunt-broker-*.zip",
  ]);
  if (
    copiedBrokerAssets.length > 0 ||
    (releaseAssetDirSelected(roots, brokerAssetDir) && releaseAssetDirHasFiles(brokerAssetDir, [
      "oliphaunt-broker-*.tar.gz",
      "oliphaunt-broker-*.zip",
    ]))
  ) {
    if (copiedBrokerAssets.length > 0) {
      result.staged.push(`staged ${copiedBrokerAssets.length} broker release asset(s)`);
    }
    tarballs.push(...brokerNpmTarballs(brokerVersion, stageRoot, tarballRoot, { targetSet }).map(([, tarball]) => tarball));
  } else {
    result.skipped.push("no broker release assets found for broker npm artifact packages");
  }

  if (tarballs.length > 0) {
    result.staged.push(`generated ${tarballs.length} release-asset npm package(s)`);
  }
  return tarballs;
}

function npmPlatformConstraints(target) {
  if (target === "linux-x64-gnu") {
    return { os: ["linux"], cpu: ["x64"], libc: ["glibc"] };
  }
  if (target === "linux-arm64-gnu") {
    return { os: ["linux"], cpu: ["arm64"], libc: ["glibc"] };
  }
  if (target === "macos-arm64") {
    return { os: ["darwin"], cpu: ["arm64"] };
  }
  if (target === "windows-x64-msvc") {
    return { os: ["win32"], cpu: ["x64"] };
  }
  return {};
}

function writeJsonFile(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function extensionReleaseManifest(extensionDir, product, version) {
  const manifestPath = path.join(extensionDir, "release-assets", `${product}-${version}-manifest.json`);
  return isFile(manifestPath) ? readJsonFile(manifestPath) : {};
}

function extensionRuntimeAsset(extensionDir, manifest, target) {
  const assets = Array.isArray(manifest?.assets) ? manifest.assets : [];
  for (const asset of assets) {
    if (
      asset?.family === "native" &&
      asset?.kind === "runtime" &&
      asset?.target === target &&
      typeof asset?.name === "string" &&
      asset.name.length > 0
    ) {
      const assetPath = path.join(extensionDir, "release-assets", asset.name);
      if (isFile(assetPath)) {
        return assetPath;
      }
    }
  }
  return null;
}

function checkedArchiveMemberPath(name, archive) {
  const normalized = String(name).replaceAll("\\", "/");
  if (!normalized || normalized === "." || normalized === "./" || normalized.startsWith("/") || normalized.includes("\0")) {
    fail(TOOL, `${rel(archive)} contains unsafe archive member ${JSON.stringify(name)}`);
  }
  const parts = normalized.split("/").filter((part) => part && part !== ".");
  if (parts.length === 0 || parts.includes("..")) {
    fail(TOOL, `${rel(archive)} contains unsafe archive member ${JSON.stringify(name)}`);
  }
  return parts.join("/");
}

function extractExtensionRuntime(asset, runtimeDir) {
  const members = runArchiveCommand(["tar", "-tf", asset], `list ${rel(asset)}`)
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  for (const member of members) {
    const checked = checkedArchiveMemberPath(member, asset);
    if (checked !== "files" && !checked.startsWith("files/") && checked !== "manifest.properties") {
      fail(TOOL, `${rel(asset)} contains unexpected extension runtime member ${checked}`);
    }
  }
  const temp = archiveTempDir();
  try {
    runArchiveCommand(["tar", "-xf", asset, "-C", temp, "files"], `extract extension runtime from ${rel(asset)}`);
    copyExtractedTree(path.join(temp, "files"), runtimeDir);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

function extensionModuleDirectory(runtimeDir) {
  const postgresLib = path.join(runtimeDir, "lib", "postgresql");
  if (!isDirectory(postgresLib)) {
    return null;
  }
  for (const file of readdirSync(postgresLib).sort(compareText)) {
    const fullPath = path.join(postgresLib, file);
    if (isFile(fullPath) && [".so", ".dylib", ".dll"].includes(path.extname(file).toLowerCase())) {
      return postgresLib;
    }
  }
  return null;
}

function stripExtensionModules(runtimeDir, target) {
  const moduleDir = extensionModuleDirectory(runtimeDir);
  if (moduleDir === null || !target.startsWith("linux-") || !executableExists("strip")) {
    return;
  }
  for (const file of readdirSync(moduleDir).sort(compareText)) {
    const fullPath = path.join(moduleDir, file);
    if (!isFile(fullPath) || path.extname(file) !== ".so") {
      continue;
    }
    spawnSync("strip", ["--strip-unneeded", fullPath], {
      cwd: ROOT,
      stdio: "ignore",
    });
  }
}

function writeExtensionReadme(packageDir, packageName, sqlName, target) {
  const targetText = target === null ? "" : ` for \`${target}\``;
  writeFileSync(
    path.join(packageDir, "README.md"),
    [
      `# ${packageName}`,
      "",
      `Oliphaunt registry package for the \`${sqlName}\` PostgreSQL extension${targetText}.`,
      "",
      "This package is consumed by `@oliphaunt/ts` when an application opens a database with",
      `\`extensions: ['${sqlName}']\`.`,
      "",
    ].join("\n"),
  );
}

function writeExtensionMetaPackage(packageDir, { product, version, sqlName, target }) {
  const packageName = extensionNpmPackage(sqlName);
  const targetPackage = extensionNpmTargetPackage(sqlName, target);
  mkdirSync(packageDir, { recursive: true });
  writeExtensionReadme(packageDir, packageName, sqlName, null);
  writeJsonFile(path.join(packageDir, "package.json"), {
    name: packageName,
    version,
    description: `Oliphaunt extension package for PostgreSQL ${sqlName}.`,
    license: "MIT AND Apache-2.0 AND PostgreSQL",
    type: "module",
    optionalDependencies: { [targetPackage]: version },
    oliphaunt: {
      product,
      kind: "exact-extension",
      sqlName,
      targetPackageNames: { [target]: targetPackage },
    },
    publishConfig: { access: "public", provenance: false },
    files: ["README.md"],
    exports: { "./package.json": "./package.json" },
  });
}

function writeExtensionTargetPackage(packageDir, {
  product,
  version,
  sqlName,
  target,
  liboliphauntVersion,
  payloadPackageNames,
}) {
  const packageName = extensionNpmTargetPackage(sqlName, target);
  mkdirSync(packageDir, { recursive: true });
  writeExtensionReadme(packageDir, packageName, sqlName, target);
  writeJsonFile(path.join(packageDir, "package.json"), {
    name: packageName,
    version,
    description: `${target} Oliphaunt extension package selector for PostgreSQL ${sqlName}.`,
    license: "MIT AND Apache-2.0 AND PostgreSQL",
    type: "module",
    ...npmPlatformConstraints(target),
    optional: true,
    optionalDependencies: Object.fromEntries(payloadPackageNames.map((name) => [name, version])),
    oliphaunt: {
      product,
      kind: "exact-extension-target",
      sqlName,
      target,
      liboliphauntVersion,
      payloadPackageNames,
    },
    publishConfig: { access: "public", provenance: false },
    files: ["README.md"],
    exports: { "./package.json": "./package.json" },
  });
}

function copyRuntimeEntries(runtimeDir, payloadRuntimeDir, entries) {
  for (const entry of entries) {
    const relative = path.relative(runtimeDir, entry);
    const destination = path.join(payloadRuntimeDir, relative);
    if (isDirectory(entry)) {
      cpSync(entry, destination, { recursive: true });
    } else if (isFile(entry)) {
      mkdirSync(path.dirname(destination), { recursive: true });
      copyFileSync(entry, destination);
    }
  }
}

function writeExtensionPayloadPackage(packageDir, {
  packageName,
  product,
  version,
  sqlName,
  target,
  liboliphauntVersion,
}) {
  const runtimeDir = path.join(packageDir, "runtime");
  const moduleDir = extensionModuleDirectory(runtimeDir);
  const metadata = {
    product,
    kind: "exact-extension-payload",
    sqlName,
    target,
    runtimeRelativePath: "runtime",
    liboliphauntVersion,
  };
  if (moduleDir !== null) {
    metadata.moduleRelativePath = path.relative(packageDir, moduleDir).split(path.sep).join("/");
  }
  writeExtensionReadme(packageDir, packageName, sqlName, target);
  writeJsonFile(path.join(packageDir, "package.json"), {
    name: packageName,
    version,
    description: `${target} Oliphaunt extension runtime payload for PostgreSQL ${sqlName}.`,
    license: "MIT AND Apache-2.0 AND PostgreSQL",
    type: "module",
    ...npmPlatformConstraints(target),
    optional: true,
    oliphaunt: metadata,
    publishConfig: { access: "public", provenance: false },
    files: ["runtime", "README.md"],
    exports: { "./package.json": "./package.json" },
  });
}

function npmPackageSizeOk(tarball, result) {
  const size = statSync(tarball).size;
  if (size <= NPM_PACKAGE_SIZE_LIMIT_BYTES) {
    return true;
  }
  result.skipped.push(`${rel(tarball)} is ${size} bytes, exceeding the 10 MiB npm package limit`);
  rmSync(tarball, { force: true });
  return false;
}

function immediateRuntimeEntries(runtimeDir) {
  if (!isDirectory(runtimeDir)) {
    return [];
  }
  return readdirSync(runtimeDir)
    .sort(compareText)
    .map((entry) => path.join(runtimeDir, entry));
}

function stageExtensionPayloadGroup({
  runtimeDir,
  entries,
  packageRoot,
  tarballRoot,
  product,
  version,
  sqlName,
  target,
  liboliphauntVersion,
  payloadIndex,
  result,
}) {
  const packageName = extensionNpmPayloadPackage(sqlName, target, payloadIndex);
  const packageDir = path.join(packageRoot, safeNpmPackageFilenamePrefix(packageName));
  rmSync(packageDir, { recursive: true, force: true });
  const payloadRuntimeDir = path.join(packageDir, "runtime");
  mkdirSync(payloadRuntimeDir, { recursive: true });
  copyRuntimeEntries(runtimeDir, payloadRuntimeDir, entries);
  writeExtensionPayloadPackage(packageDir, {
    packageName,
    product,
    version,
    sqlName,
    target,
    liboliphauntVersion,
  });
  const tarball = pnpmPackForNpmPublish(packageDir, tarballRoot);
  if (statSync(tarball).size <= NPM_PACKAGE_SIZE_LIMIT_BYTES) {
    return { packageNames: [packageName], tarballs: [tarball] };
  }

  rmSync(tarball, { force: true });
  rmSync(packageDir, { recursive: true, force: true });
  if (entries.length === 1 && isDirectory(entries[0])) {
    const childEntries = readdirSync(entries[0])
      .sort(compareText)
      .map((entry) => path.join(entries[0], entry));
    if (childEntries.length > 0) {
      return stageExtensionPayloadGroups({
        runtimeDir,
        groups: childEntries.map((entry) => [entry]),
        packageRoot,
        tarballRoot,
        product,
        version,
        sqlName,
        target,
        liboliphauntVersion,
        startIndex: payloadIndex,
        result,
      });
    }
  }
  if (entries.length > 1) {
    return stageExtensionPayloadGroups({
      runtimeDir,
      groups: entries.map((entry) => [entry]),
      packageRoot,
      tarballRoot,
      product,
      version,
      sqlName,
      target,
      liboliphauntVersion,
      startIndex: payloadIndex,
      result,
    });
  }

  result.skipped.push(`${packageName} cannot be split below the 10 MiB npm package limit; largest entry is ${rel(entries[0])}`);
  return { packageNames: [], tarballs: [] };
}

function stageExtensionPayloadGroups({
  runtimeDir,
  groups,
  packageRoot,
  tarballRoot,
  product,
  version,
  sqlName,
  target,
  liboliphauntVersion,
  startIndex,
  result,
}) {
  const packageNames = [];
  const tarballs = [];
  let payloadIndex = startIndex;
  for (const entries of groups) {
    const staged = stageExtensionPayloadGroup({
      runtimeDir,
      entries,
      packageRoot,
      tarballRoot,
      product,
      version,
      sqlName,
      target,
      liboliphauntVersion,
      payloadIndex,
      result,
    });
    if (staged.packageNames.length === 0) {
      continue;
    }
    packageNames.push(...staged.packageNames);
    tarballs.push(...staged.tarballs);
    payloadIndex += staged.packageNames.length;
  }
  return { packageNames, tarballs };
}

function stageExtensionPayloadPackages({
  runtimeDir,
  packageRoot,
  tarballRoot,
  product,
  version,
  sqlName,
  target,
  liboliphauntVersion,
  result,
}) {
  return stageExtensionPayloadGroups({
    runtimeDir,
    groups: immediateRuntimeEntries(runtimeDir).map((entry) => [entry]),
    packageRoot,
    tarballRoot,
    product,
    version,
    sqlName,
    target,
    liboliphauntVersion,
    startIndex: 0,
    result,
  });
}

function stageExtensionNpmPackages(roots, stagingRoot, target, result) {
  const manifests = discoverExtensionManifests(roots);
  if (manifests.length === 0) {
    result.skipped.push("no extension-artifacts.json manifests found for npm extension packages");
    return null;
  }
  if (target === null) {
    result.skipped.push("current host does not map to a supported npm extension target");
    return null;
  }

  rmSync(stagingRoot, { recursive: true, force: true });
  const packageRoot = path.join(stagingRoot, "packages");
  const tarballRoot = path.join(stagingRoot, "tarballs");
  const workRoot = path.join(stagingRoot, "work");
  let stagedAny = false;

  for (const manifestPath of manifests) {
    const manifest = readJsonFile(manifestPath);
    const extensionDir = path.dirname(manifestPath);
    const { product, version, sqlName } = manifest;
    if (![product, version, sqlName].every((value) => typeof value === "string" && value.length > 0)) {
      result.skipped.push(`${rel(manifestPath)} is missing product, version, or sqlName`);
      continue;
    }
    const releaseManifest = extensionReleaseManifest(extensionDir, product, version);
    const asset = extensionRuntimeAsset(extensionDir, Object.keys(releaseManifest).length > 0 ? releaseManifest : manifest, target);
    if (asset === null) {
      result.skipped.push(`${product}@${version} has no ${target} native runtime asset`);
      continue;
    }
    const compatibility = releaseManifest.compatibility ?? {};
    const liboliphauntVersion = compatibility.nativeRuntimeVersion ?? version;
    if (typeof liboliphauntVersion !== "string" || liboliphauntVersion.length === 0) {
      result.skipped.push(`${product}@${version} is missing native runtime compatibility`);
      continue;
    }

    const metaDir = path.join(packageRoot, safeNpmPackageFilenamePrefix(extensionNpmPackage(sqlName)));
    const targetDir = path.join(packageRoot, safeNpmPackageFilenamePrefix(extensionNpmTargetPackage(sqlName, target)));
    const runtimeWorkDir = path.join(workRoot, safeNpmPackageFilenamePrefix(extensionNpmTargetPackage(sqlName, target)), "runtime");
    extractExtensionRuntime(asset, runtimeWorkDir);
    stripExtensionModules(runtimeWorkDir, target);
    const { packageNames: payloadPackageNames, tarballs: payloadTarballs } = stageExtensionPayloadPackages({
      runtimeDir: runtimeWorkDir,
      packageRoot,
      tarballRoot,
      product,
      version,
      sqlName,
      target,
      liboliphauntVersion,
      result,
    });
    if (payloadPackageNames.length === 0) {
      continue;
    }
    writeExtensionMetaPackage(metaDir, { product, version, sqlName, target });
    writeExtensionTargetPackage(targetDir, {
      product,
      version,
      sqlName,
      target,
      liboliphauntVersion,
      payloadPackageNames,
    });
    const targetTarball = pnpmPackForNpmPublish(targetDir, tarballRoot);
    if (!npmPackageSizeOk(targetTarball, result)) {
      for (const tarball of payloadTarballs) {
        rmSync(tarball, { force: true });
      }
      continue;
    }
    const metaTarball = pnpmPackForNpmPublish(metaDir, tarballRoot);
    if (!npmPackageSizeOk(metaTarball, result)) {
      rmSync(targetTarball, { force: true });
      for (const tarball of payloadTarballs) {
        rmSync(tarball, { force: true });
      }
      continue;
    }
    for (const tarball of payloadTarballs) {
      result.staged.push(rel(tarball));
    }
    result.staged.push(rel(targetTarball));
    result.staged.push(rel(metaTarball));
    stagedAny = true;
  }

  return stagedAny ? tarballRoot : null;
}

function stageExtensionNpmPackagesDryRun(roots, target, result) {
  const manifests = discoverExtensionManifests(roots);
  if (manifests.length === 0) {
    result.skipped.push("no extension-artifacts.json manifests found for npm extension packages");
    return;
  }
  if (target === null) {
    result.skipped.push("current host does not map to a supported npm extension target");
    return;
  }
  for (const manifestPath of manifests) {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const sqlName = manifest.sqlName;
    const version = manifest.version;
    if (typeof sqlName === "string" && typeof version === "string") {
      result.staged.push(`dry-run npm extension packages ${extensionNpmPackage(sqlName)}@${version} (${target})`);
    }
  }
}

function publishNpmDryRun(roots, registryRoot, strict, port) {
  const result = surfaceResult("npm");
  result.staged.push("dry-run generated liboliphaunt and broker npm artifact packages");
  stageExtensionNpmPackagesDryRun(roots, hostNpmTarget(), result);

  const tarballs = selectNpmTarballs(discoverFiles(roots, [".tgz"]), registryRoot, result);
  if (tarballs.length === 0) {
    addSkip(result, "no npm .tgz artifacts found", strict);
    return result;
  }

  result.staged.push(`verdaccio=http://127.0.0.1:${port}`);
  for (const tarball of tarballs) {
    const identity = npmPackageIdentity(tarball);
    const label = identity === null ? rel(tarball) : `${identity.name}@${identity.version}`;
    result.published.push(`dry-run npm publish ${label}`);
  }
  result.staged.push(`cleared local pnpm store ${rel(path.join(registryRoot, "pnpm-store"))}`);
  return result;
}

function npmTarballsRequirePythonGeneration(roots) {
  return false;
}

function writeNativeExtensionCargoPartCrate(crateDir, { product, version, sqlName, target, index }) {
  const name = nativeExtensionCargoPartPackageName(product, target, index);
  mkdirSync(path.join(crateDir, "src"), { recursive: true });
  writeFileSync(
    path.join(crateDir, "Cargo.toml"),
    `[package]
name = "${name}"
version = "${version}"
edition = "2024"
rust-version = "1.93"
description = "Cargo payload part ${String(index).padStart(3, "0")} for the ${sqlName} Oliphaunt native extension on ${target}."
readme = "README.md"
repository = "https://github.com/f0rr0/oliphaunt"
homepage = "https://oliphaunt.dev"
license = "MIT AND Apache-2.0 AND PostgreSQL"
include = ["Cargo.toml", "README.md", "src/**", "payload/**"]

[lib]
path = "src/lib.rs"

[workspace]
`,
  );
  writeFileSync(
    path.join(crateDir, "README.md"),
    `# ${name}

Cargo payload part for the \`${sqlName}\` Oliphaunt native extension on \`${target}\`.
Applications do not depend on this crate directly.
`,
  );
  writeFileSync(
    path.join(crateDir, "src/lib.rs"),
    `pub const PRODUCT: &str = "${product}";
pub const KIND: &str = "extension-part";
pub const SQL_NAME: &str = "${sqlName}";
pub const RELEASE_TARGET: &str = "${target}";
pub const PART_INDEX: usize = ${index};
pub const PAYLOAD_ROOT: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/payload");
`,
  );
}

function writeChunk(file, data) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, data);
}

function copyPayloadFile(source, destination) {
  mkdirSync(path.dirname(destination), { recursive: true });
  copyFileSync(source, destination);
}

function buildNativeExtensionPartCrates(runtimeDir, sourceRoot, {
  product,
  version,
  sqlName,
  target,
  partBytes = CARGO_EXTENSION_PART_BYTES,
}) {
  const partDirs = [];
  let currentDir = null;
  let currentSize = 0;

  const startPart = () => {
    const index = partDirs.length;
    const partDir = path.join(sourceRoot, nativeExtensionCargoPartPackageName(product, target, index));
    writeNativeExtensionCargoPartCrate(partDir, { product, version, sqlName, target, index });
    partDirs.push(partDir);
    return partDir;
  };

  for (const source of walkFiles(runtimeDir)) {
    const relative = path.relative(runtimeDir, source).split(path.sep).join("/");
    const size = statSync(source).size;
    if (size > partBytes) {
      currentDir = null;
      currentSize = 0;
      const fd = openSync(source, "r");
      try {
        let partIndex = 0;
        let offset = 0;
        while (offset < size) {
          const length = Math.min(partBytes, size - offset);
          const buffer = Buffer.allocUnsafe(length);
          const bytesRead = readSync(fd, buffer, 0, length, offset);
          if (bytesRead <= 0) {
            break;
          }
          const partDir = startPart();
          writeChunk(
            path.join(partDir, "payload", "chunks", `${relative}.part${String(partIndex).padStart(3, "0")}`),
            buffer.subarray(0, bytesRead),
          );
          offset += bytesRead;
          partIndex += 1;
        }
      } finally {
        closeSync(fd);
      }
      continue;
    }
    if (currentDir === null || currentSize + size > partBytes) {
      currentDir = startPart();
      currentSize = 0;
    }
    copyPayloadFile(source, path.join(currentDir, "payload", "files", relative));
    currentSize += size;
  }

  if (partDirs.length === 0) {
    throw new Error(`${product}@${version} generated no native extension Cargo part crates`);
  }
  return partDirs;
}

const NATIVE_EXTENSION_AGGREGATOR_BUILD_RS = String.raw`use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::env;
use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};

const SCHEMA: &str = __SCHEMA__;
const PRODUCT: &str = __PRODUCT__;
const VERSION: &str = env!("CARGO_PKG_VERSION");
const KIND: &str = "extension";
const TARGET: &str = __TARGET__;
const EXTENSION: &str = __EXTENSION__;
const PART_ROOTS: &[&str] = &[
__PART_ROOTS__
];

fn main() {
    emit_manifest();
}

fn emit_manifest() {
    let out_dir = PathBuf::from(env::var_os("OUT_DIR").expect("OUT_DIR is set"));
    let payload = out_dir.join("payload");
    if payload.exists() {
        fs::remove_dir_all(&payload).expect("remove stale Oliphaunt extension payload");
    }
    fs::create_dir_all(&payload).expect("create Oliphaunt extension payload directory");

    let part_roots = part_roots();
    if part_roots.is_empty() {
        if env::var_os("OLIPHAUNT_ARTIFACT_CRATE_REQUIRE_PAYLOAD").is_some() {
            panic!("missing Oliphaunt extension payload part crates");
        }
        return;
    }

    let mut chunk_files: BTreeMap<String, Vec<(usize, PathBuf)>> = BTreeMap::new();
    for root in part_roots {
        println!("cargo::rerun-if-changed={}", root.display());
        copy_complete_files(&root.join("files"), &payload).expect("copy complete extension payload files");
        collect_chunks(&root.join("chunks"), &root.join("chunks"), &mut chunk_files)
            .expect("collect extension payload chunks");
    }

    for (relative, mut chunks) in chunk_files {
        chunks.sort_by_key(|(index, _)| *index);
        for (expected, (actual, _)) in chunks.iter().enumerate() {
            if *actual != expected {
                panic!("non-contiguous Oliphaunt extension chunk indexes for {relative}");
            }
        }
        let output = payload.join(&relative);
        if let Some(parent) = output.parent() {
            fs::create_dir_all(parent).expect("create reconstructed extension file parent");
        }
        let mut writer = fs::File::create(&output).expect("create reconstructed extension payload file");
        for (_, path) in chunks {
            let mut reader = fs::File::open(&path).expect("open extension payload chunk");
            io::copy(&mut reader, &mut writer).expect("append extension payload chunk");
        }
    }

    let files = collect_files(&payload).expect("collect reconstructed extension payload files");
    if files.is_empty() {
        panic!("Oliphaunt extension payload part crates produced no files");
    }
    let manifest = out_dir.join("oliphaunt-artifact.toml");
    let mut text = format!(
        "schema = {SCHEMA:?}\nproduct = {PRODUCT:?}\nversion = {VERSION:?}\nkind = {KIND:?}\ntarget = {TARGET:?}\nextension = {EXTENSION:?}\n"
    );
    for file in files {
        let relative = file.strip_prefix(&payload)
            .expect("payload file stays under payload root")
            .to_string_lossy()
            .replace(std::path::MAIN_SEPARATOR, "/");
        let sha256 = sha256_file(&file).expect("hash extension payload file");
        text.push_str(&format!(
            "\n[[files]]\nsource = {:?}\nrelative = {:?}\nsha256 = {:?}\nexecutable = false\n",
            file.display().to_string(),
            relative,
            sha256,
        ));
    }
    fs::write(&manifest, text).expect("write Oliphaunt extension artifact manifest");
    println!("cargo::metadata=manifest={}", manifest.display());
}

fn part_roots() -> Vec<PathBuf> {
    PART_ROOTS.iter().map(PathBuf::from).collect()
}

fn copy_complete_files(source: &Path, destination: &Path) -> io::Result<()> {
    if !source.is_dir() {
        return Ok(());
    }
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let path = entry.path();
        let output = destination.join(path.strip_prefix(source).unwrap_or(&path));
        copy_tree_entry(&path, &output)?;
    }
    Ok(())
}

fn copy_tree_entry(source: &Path, destination: &Path) -> io::Result<()> {
    let metadata = fs::metadata(source)?;
    if metadata.is_dir() {
        fs::create_dir_all(destination)?;
        for entry in fs::read_dir(source)? {
            let entry = entry?;
            copy_tree_entry(&entry.path(), &destination.join(entry.file_name()))?;
        }
    } else if metadata.is_file() {
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::copy(source, destination)?;
    }
    Ok(())
}

fn collect_chunks(
    root: &Path,
    current: &Path,
    chunks: &mut BTreeMap<String, Vec<(usize, PathBuf)>>,
) -> io::Result<()> {
    if !current.is_dir() {
        return Ok(());
    }
    for entry in fs::read_dir(current)? {
        let entry = entry?;
        let path = entry.path();
        let metadata = fs::metadata(&path)?;
        if metadata.is_dir() {
            collect_chunks(root, &path, chunks)?;
            continue;
        }
        if !metadata.is_file() {
            continue;
        }
        let relative = path.strip_prefix(root).unwrap_or(&path).to_string_lossy().replace(std::path::MAIN_SEPARATOR, "/");
        let (file_relative, part_index) = split_part_relative(&relative)
            .unwrap_or_else(|| panic!("invalid Oliphaunt extension chunk file name {relative}"));
        chunks.entry(file_relative).or_default().push((part_index, path));
    }
    Ok(())
}

fn split_part_relative(relative: &str) -> Option<(String, usize)> {
    let (file, index) = relative.rsplit_once(".part")?;
    if file.is_empty() || index.len() != 3 || !index.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    Some((file.to_owned(), index.parse().ok()?))
}

fn collect_files(root: &Path) -> io::Result<Vec<PathBuf>> {
    let mut files = Vec::new();
    collect_files_inner(root, &mut files)?;
    files.sort();
    Ok(files)
}

fn collect_files_inner(path: &Path, files: &mut Vec<PathBuf>) -> io::Result<()> {
    if !path.is_dir() {
        return Ok(());
    }
    for entry in fs::read_dir(path)? {
        let entry = entry?;
        let entry_path = entry.path();
        let metadata = fs::metadata(&entry_path)?;
        if metadata.is_dir() {
            collect_files_inner(&entry_path, files)?;
        } else if metadata.is_file() {
            files.push(entry_path);
        }
    }
    Ok(())
}

fn sha256_file(path: &Path) -> io::Result<String> {
    let mut file = fs::File::open(path)?;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 1024 * 64];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    let digest = digest.finalize();
    let mut output = String::with_capacity(digest.len() * 2);
    for byte in digest {
        use std::fmt::Write as _;
        let _ = write!(&mut output, "{byte:02x}");
    }
    Ok(output)
}
`;

function writeNativeExtensionSplitAggregatorCrate(crateDir, {
  product,
  version,
  sqlName,
  target,
  triple,
  partDirs,
}) {
  const name = nativeExtensionCargoPackageName(product, target);
  const links = nativeExtensionCargoLinksName(product, target);
  rmSync(path.join(crateDir, "payload"), { recursive: true, force: true });
  const dependencyLines = [];
  const partRoots = [];
  for (let index = 0; index < partDirs.length; index += 1) {
    const dependencyName = nativeExtensionCargoPartPackageName(product, target, index);
    const dependencyPath = path.relative(crateDir, partDirs[index]).split(path.sep).join("/");
    dependencyLines.push(`${dependencyName} = { version = "=${version}", path = "${dependencyPath}" }`);
    partRoots.push(`    ${rustCrateIdent(dependencyName)}::PAYLOAD_ROOT,`);
  }
  writeFileSync(
    path.join(crateDir, "Cargo.toml"),
    `[package]
name = "${name}"
version = "${version}"
edition = "2024"
rust-version = "1.93"
description = "Cargo artifact crate for the ${sqlName} Oliphaunt native extension on ${target}."
readme = "README.md"
repository = "https://github.com/f0rr0/oliphaunt"
homepage = "https://oliphaunt.dev"
license = "MIT AND Apache-2.0 AND PostgreSQL"
links = "${links}"
build = "build.rs"
include = ["Cargo.toml", "README.md", "build.rs", "src/**"]

[lib]
path = "src/lib.rs"

[build-dependencies]
sha2 = "0.10"
${dependencyLines.join("\n")}

[workspace]
`,
  );
  writeFileSync(
    path.join(crateDir, "build.rs"),
    NATIVE_EXTENSION_AGGREGATOR_BUILD_RS
      .replace("__SCHEMA__", tomlString("oliphaunt-artifact-manifest-v1"))
      .replace("__PRODUCT__", tomlString(product))
      .replace("__TARGET__", tomlString(triple))
      .replace("__EXTENSION__", tomlString(sqlName))
      .replace("__PART_ROOTS__", partRoots.join("\n")),
  );
}

function cargoPackage(crateDir, targetDir, { noVerify = false } = {}) {
  const manifest = path.join(crateDir, "Cargo.toml");
  const { name, version } = readCargoPackageNameVersion(manifest, { fail: localFail, rel });
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
  const result = spawnSync(command[0], command.slice(1), {
    cwd: ROOT,
    env: { ...process.env, OLIPHAUNT_ARTIFACT_CRATE_REQUIRE_PAYLOAD: "1" },
    stdio: "inherit",
  });
  if (result.error) {
    fail(TOOL, `${command[0]} failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
  const cratePath = path.join(targetDir, "package", `${name}-${version}.crate`);
  if (!isFile(cratePath)) {
    fail(TOOL, `cargo package did not create ${rel(cratePath)}`);
  }
  return cratePath;
}

function discardCargoPackageArtifact(cratePath) {
  rmSync(cratePath, { force: true });
  rmSync(path.join(path.dirname(cratePath), "tmp-crate", path.basename(cratePath)), { force: true });
}

function writeNativeExtensionCargoCrate(crateDir, {
  product,
  version,
  sqlName,
  target,
  triple,
  asset,
}) {
  const name = nativeExtensionCargoPackageName(product, target);
  const links = nativeExtensionCargoLinksName(product, target);
  const runtimeDir = path.join(crateDir, "payload");
  extractExtensionRuntime(asset, runtimeDir);
  stripExtensionModules(runtimeDir, target);
  if (walkFiles(runtimeDir).length === 0) {
    throw new Error(`${rel(asset)} did not contain extension runtime files`);
  }
  mkdirSync(path.join(crateDir, "src"), { recursive: true });
  writeFileSync(
    path.join(crateDir, "README.md"),
    `# ${name}

Cargo artifact crate for the \`${sqlName}\` Oliphaunt native extension on \`${target}\`.
`,
  );
  writeFileSync(
    path.join(crateDir, "Cargo.toml"),
    `[package]
name = "${name}"
version = "${version}"
edition = "2024"
rust-version = "1.93"
description = "Cargo artifact crate for the ${sqlName} Oliphaunt native extension on ${target}."
readme = "README.md"
repository = "https://github.com/f0rr0/oliphaunt"
homepage = "https://oliphaunt.dev"
license = "MIT AND Apache-2.0 AND PostgreSQL"
links = "${links}"
build = "build.rs"
include = ["Cargo.toml", "README.md", "build.rs", "src/**", "payload/**"]

[lib]
path = "src/lib.rs"

[build-dependencies]
sha2 = "0.10"

[workspace]
`,
  );
  writeFileSync(
    path.join(crateDir, "src/lib.rs"),
    `pub const PRODUCT: &str = "${product}";
pub const KIND: &str = "extension";
pub const SQL_NAME: &str = "${sqlName}";
pub const RELEASE_TARGET: &str = "${target}";
pub const CARGO_TARGET: &str = "${triple}";
`,
  );
  writeFileSync(
    path.join(crateDir, "build.rs"),
    `use sha2::{Digest, Sha256};
use std::env;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

const SCHEMA: &str = "oliphaunt-artifact-manifest-v1";
const PRODUCT: &str = ${JSON.stringify(product)};
const VERSION: &str = env!("CARGO_PKG_VERSION");
const KIND: &str = "extension";
const TARGET: &str = ${JSON.stringify(triple)};
const EXTENSION: &str = ${JSON.stringify(sqlName)};

fn main() {
    let manifest_dir =
        PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR is set"));
    let payload = manifest_dir.join("payload");
    println!("cargo::rerun-if-changed={}", payload.display());
    if !payload.is_dir() {
        if env::var_os("OLIPHAUNT_ARTIFACT_CRATE_REQUIRE_PAYLOAD").is_some() {
            panic!("missing packaged extension payload under {}", payload.display());
        }
        return;
    }
    let out_dir = PathBuf::from(env::var_os("OUT_DIR").expect("OUT_DIR is set"));
    let manifest = out_dir.join("oliphaunt-artifact.toml");
    let mut text = format!(
        "schema = {SCHEMA:?}\\nproduct = {PRODUCT:?}\\nversion = {VERSION:?}\\nkind = {KIND:?}\\ntarget = {TARGET:?}\\nextension = {EXTENSION:?}\\n"
    );
    for file in payload_files(&payload) {
        let relative = file
            .strip_prefix(&payload)
            .expect("payload file stays under payload")
            .to_string_lossy()
            .replace(std::path::MAIN_SEPARATOR, "/");
        let sha256 = sha256_file(&file);
        text.push_str(&format!(
            "\\n[[files]]\\nsource = {:?}\\nrelative = {:?}\\nsha256 = {sha256:?}\\nexecutable = false\\n",
            file.display().to_string(),
            relative,
        ));
    }
    fs::write(&manifest, text).expect("write Oliphaunt extension artifact manifest");
    println!("cargo::metadata=manifest={}", manifest.display());
}

fn payload_files(root: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    collect_payload_files(root, &mut files);
    files.sort();
    files
}

fn collect_payload_files(root: &Path, files: &mut Vec<PathBuf>) {
    for entry in fs::read_dir(root).expect("read payload directory") {
        let path = entry.expect("read payload entry").path();
        if path.is_dir() {
            collect_payload_files(&path, files);
        } else if path.is_file() {
            files.push(path);
        }
    }
}

fn sha256_file(path: &Path) -> String {
    let mut file = fs::File::open(path).expect("open payload file for hashing");
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 8192];
    loop {
        let read = file.read(&mut buffer).expect("read payload file for hashing");
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    format!("{:x}", hasher.finalize())
}
`,
  );
}

function packageNativeExtensionCargoCrates(roots, stagingRoot, target, strict, result) {
  if (target === null) {
    result.skipped.push("current host does not map to a supported native extension Cargo target");
    return [];
  }
  const triple = cargoTargetTriple(target);
  if (triple === null) {
    result.skipped.push(`unsupported native extension Cargo target ${target}`);
    return [];
  }
  const manifests = discoverExtensionManifests(roots);
  if (manifests.length === 0) {
    result.skipped.push("no extension-artifacts.json manifests found for native extension Cargo crates");
    return [];
  }

  const sourceRoot = path.join(stagingRoot, "native-extension-sources");
  const outputDir = path.join(stagingRoot, "native-extension-crates");
  const cargoTargetDir = path.join(stagingRoot, "native-extension-cargo-target");
  rmSync(sourceRoot, { recursive: true, force: true });
  rmSync(outputDir, { recursive: true, force: true });
  rmSync(cargoTargetDir, { recursive: true, force: true });
  mkdirSync(sourceRoot, { recursive: true });
  mkdirSync(outputDir, { recursive: true });

  const outputs = [];
  const packageOptions = { root: ROOT, fail: localFail, rel };
  for (const manifestPath of manifests) {
    const manifest = readJsonFile(manifestPath);
    const extensionDir = path.dirname(manifestPath);
    const { product, version, sqlName } = manifest;
    if (![product, version, sqlName].every((value) => typeof value === "string" && value.length > 0)) {
      result.skipped.push(`${rel(manifestPath)} is missing product, version, or sqlName`);
      continue;
    }
    const releaseManifest = extensionReleaseManifest(extensionDir, product, version);
    const asset = extensionRuntimeAsset(extensionDir, Object.keys(releaseManifest).length > 0 ? releaseManifest : manifest, target);
    if (asset === null) {
      result.skipped.push(`${product}@${version} has no ${target} native runtime asset`);
      continue;
    }
    const name = nativeExtensionCargoPackageName(product, target);
    const crateDir = path.join(sourceRoot, name);
    try {
      writeNativeExtensionCargoCrate(crateDir, {
        product,
        version,
        sqlName,
        target,
        triple,
        asset,
      });
      let cratePath = cargoPackage(crateDir, cargoTargetDir);
      let size = statSync(cratePath).size;
      if (size > CARGO_EXTENSION_SPLIT_THRESHOLD_BYTES) {
        discardCargoPackageArtifact(cratePath);
        const partDirs = buildNativeExtensionPartCrates(path.join(crateDir, "payload"), sourceRoot, {
          product,
          version,
          sqlName,
          target,
        });
        writeNativeExtensionSplitAggregatorCrate(crateDir, {
          product,
          version,
          sqlName,
          target,
          triple,
          partDirs,
        });
        let partFailed = false;
        for (const partDir of partDirs) {
          const partCratePath = cargoPackage(partDir, cargoTargetDir);
          const partSize = statSync(partCratePath).size;
          if (partSize > CARGO_PACKAGE_SIZE_LIMIT_BYTES) {
            const message = `${rel(partCratePath)} is ${partSize} bytes, above the crates.io 10 MiB package limit`;
            result.skipped.push(message);
            if (strict) {
              fail(TOOL, message);
            }
            partFailed = true;
            continue;
          }
          const output = path.join(outputDir, path.basename(partCratePath));
          copyFileSync(partCratePath, output);
          outputs.push(output);
        }
        if (partFailed) {
          continue;
        }
        cratePath = manualCargoPackageSource(
          path.join(crateDir, "Cargo.toml"),
          path.join(cargoTargetDir, "manual-package"),
          packageOptions,
        );
        size = statSync(cratePath).size;
        if (size > CARGO_PACKAGE_SIZE_LIMIT_BYTES) {
          const message = `${rel(cratePath)} is ${size} bytes after splitting, above the crates.io 10 MiB package limit`;
          result.skipped.push(message);
          if (strict) {
            fail(TOOL, message);
          }
          continue;
        }
      }
      const output = path.join(outputDir, path.basename(cratePath));
      copyFileSync(cratePath, output);
      outputs.push(output);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.skipped.push(message);
      if (strict) {
        throw error;
      }
    }
  }
  result.staged.push(...outputs.map(rel));
  return outputs;
}

function writeVerdaccioConfig(root, port) {
  const resolvedRoot = path.resolve(root);
  const config = path.join(resolvedRoot, "config.yaml");
  const storage = path.join(resolvedRoot, "storage");
  mkdirSync(storage, { recursive: true });
  mkdirSync(path.join(resolvedRoot, "plugins"), { recursive: true });
  const text = [
    `storage: ${storage}`,
    "max_body_size: 100mb",
    "auth:",
    "  htpasswd:",
    `    file: ${path.join(resolvedRoot, "htpasswd")}`,
    "uplinks:",
    "  npmjs:",
    "    url: https://registry.npmjs.org/",
    "packages:",
    "  '@oliphaunt/*':",
    "    access: $all",
    "    publish: $authenticated",
    "    unpublish: $authenticated",
    "    proxy: npmjs",
    "  '**':",
    "    access: $all",
    "    publish: $authenticated",
    "    unpublish: $authenticated",
    "    proxy: npmjs",
    "middlewares:",
    "  audit:",
    "    enabled: false",
    "log:",
    "  - {type: stdout, format: pretty, level: http}",
    "",
  ].join("\n");
  const previous = existsSync(config) ? readFileSync(config, "utf8") : null;
  writeFileSync(config, text);
  writeFileSync(path.join(resolvedRoot, "registry-url.txt"), `http://127.0.0.1:${port}\n`);
  return { config, changed: previous !== text };
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function stopRecordedVerdaccio(root) {
  const pidFile = path.join(root, "verdaccio.pid");
  if (!existsSync(pidFile)) {
    return;
  }
  const pid = Number.parseInt(readFileSync(pidFile, "utf8").trim(), 10);
  if (!Number.isInteger(pid)) {
    rmSync(pidFile, { force: true });
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    rmSync(pidFile, { force: true });
    return;
  }
  for (let index = 0; index < 30; index += 1) {
    if (!processExists(pid)) {
      rmSync(pidFile, { force: true });
      return;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Process already exited.
  }
  rmSync(pidFile, { force: true });
}

function npmPing(registryUrl) {
  if (!executableExists("npm")) {
    return false;
  }
  const result = commandResult([
    "npm",
    "ping",
    "--registry",
    registryUrl,
    "--fetch-timeout=1000",
    "--fetch-retries=0",
  ], { timeout: 3000 });
  return !result.error && result.status === 0;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensureVerdaccio(root, port, dryRun) {
  const registryUrl = `http://127.0.0.1:${port}`;
  const { config, changed } = writeVerdaccioConfig(root, port);
  if (changed && !dryRun) {
    stopRecordedVerdaccio(root);
  }
  if (npmPing(registryUrl)) {
    return registryUrl;
  }
  if (dryRun) {
    return registryUrl;
  }

  requireCommand("pnpm");
  const logPath = path.join(root, "verdaccio.log");
  mkdirSync(path.dirname(logPath), { recursive: true });
  const log = openSync(logPath, "a");
  const child = spawn(
    "pnpm",
    ["dlx", "verdaccio@6", "--config", config, "--listen", registryUrl],
    {
      cwd: ROOT,
      detached: true,
      stdio: ["ignore", log, log],
    },
  );
  child.unref();
  closeSync(log);
  writeFileSync(path.join(root, "verdaccio.pid"), `${child.pid}\n`);
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (npmPing(registryUrl)) {
      return registryUrl;
    }
    if (child.exitCode !== null) {
      fail(TOOL, `Verdaccio exited early; see ${rel(logPath)}`);
    }
    await sleep(1000);
  }
  fail(TOOL, `Timed out waiting for Verdaccio; see ${rel(logPath)}`);
}

function npmAuthIsValid(registryUrl, npmrc) {
  const result = commandResult([
    "npm",
    "whoami",
    "--registry",
    registryUrl,
    "--userconfig",
    npmrc,
    "--loglevel=error",
  ], { timeout: 10000 });
  return !result.error && result.status === 0;
}

async function ensureVerdaccioNpmrc(root, registryUrl, dryRun) {
  if (dryRun) {
    return null;
  }
  const npmrc = path.join(root, "npmrc");
  if (existsSync(npmrc)) {
    const text = readFileSync(npmrc, "utf8");
    if (text.includes("always-auth")) {
      writeFileSync(npmrc, `${text.split(/\r?\n/u).filter((line) => !line.startsWith("always-auth=")).join("\n")}\n`);
    }
    if (npmAuthIsValid(registryUrl, npmrc)) {
      return npmrc;
    }
    rmSync(npmrc, { force: true });
  }
  const username = "oliphaunt-local";
  const response = await fetch(`${registryUrl}/-/user/org.couchdb.user:${username}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: username,
      password: "oliphaunt-local",
      email: "local-registry@oliphaunt.invalid",
      type: "user",
      roles: [],
      date: new Date().toISOString().replace(/\.\d{3}Z$/u, ".000Z"),
    }),
  });
  if (!response.ok) {
    fail(TOOL, `failed to create local Verdaccio user: HTTP ${response.status}: ${await response.text()}`);
  }
  const data = await response.json();
  if (typeof data.token !== "string" || data.token.length === 0) {
    fail(TOOL, "Verdaccio did not return an auth token for the local user");
  }
  const host = registryUrl.replace(/^https?:\/\//u, "");
  writeFileSync(npmrc, [`registry=${registryUrl}/`, `//${host}/:_authToken=${data.token}`, ""].join("\n"));
  return npmrc;
}

function npmPackageExists(registryUrl, npmrc, name, version) {
  const command = [
    "npm",
    "view",
    `${name}@${version}`,
    "version",
    "--registry",
    registryUrl,
    "--fetch-retries=0",
    "--loglevel=error",
  ];
  if (npmrc !== null) {
    command.push("--userconfig", npmrc);
  }
  const result = commandResult(command, { timeout: 10000 });
  return !result.error && result.status === 0 && result.stdout.trim() === version;
}

function runNpmPublishCommand(args) {
  const result = spawnSync(args[0], args.slice(1), {
    cwd: ROOT,
    stdio: "inherit",
  });
  if (result.error) {
    fail(TOOL, `${args[0]} failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

async function publishNpmTarballs(roots, registryRoot, strict, port) {
  const result = surfaceResult("npm");
  const generatedTarballs = stageReleaseAssetNpmPackages(roots, registryRoot, result, strict);
  const extensionTarballRoot = stageExtensionNpmPackages(
    roots,
    path.join(registryRoot, "npm-extension-packages"),
    hostNpmTarget(),
    result,
  );
  const npmRoots = extensionTarballRoot === null ? roots : [...roots, extensionTarballRoot];

  const tarballs = selectNpmTarballs([...discoverFiles(npmRoots, [".tgz"]), ...generatedTarballs], registryRoot, result);
  if (tarballs.length === 0) {
    addSkip(result, "no npm .tgz artifacts found", strict);
    return result;
  }
  for (const tarball of tarballs) {
    const size = statSync(tarball).size;
    if (size > NPM_PACKAGE_SIZE_LIMIT_BYTES) {
      addSkip(result, `${rel(tarball)} is ${size} bytes, exceeding the 10 MiB npm package limit`, strict);
      return result;
    }
  }

  const verdaccioRoot = path.join(registryRoot, "verdaccio");
  const registryUrl = await ensureVerdaccio(verdaccioRoot, port, false);
  const npmrc = await ensureVerdaccioNpmrc(verdaccioRoot, registryUrl, false);
  result.staged.push(`verdaccio=${registryUrl}`);

  for (const tarball of tarballs) {
    const identity = npmPackageIdentity(tarball);
    if (identity !== null && npmPackageExists(registryUrl, npmrc, identity.name, identity.version)) {
      const command = [
        "npm",
        "unpublish",
        `${identity.name}@${identity.version}`,
        "--registry",
        registryUrl,
        "--force",
        "--loglevel=error",
      ];
      if (npmrc !== null) {
        command.push("--userconfig", npmrc);
      }
      runNpmPublishCommand(command);
      result.staged.push(`replaced ${identity.name}@${identity.version}`);
    }
    const command = [
      "npm",
      "publish",
      tarball,
      "--registry",
      registryUrl,
      "--provenance=false",
      "--ignore-scripts",
      "--access",
      "public",
      "--loglevel=error",
    ];
    if (npmrc !== null) {
      command.push("--userconfig", npmrc);
    }
    runNpmPublishCommand(command);
    result.published.push(rel(tarball));
  }
  rmSync(path.join(registryRoot, "pnpm-store"), { recursive: true, force: true });
  result.staged.push(`cleared local pnpm store ${rel(path.join(registryRoot, "pnpm-store"))}`);
  return result;
}

function publishCargoDryRun(roots, strict) {
  const result = surfaceResult("cargo");
  result.staged.push("dry-run generated release-asset Cargo artifact crates");
  result.staged.push("dry-run generated local Cargo source crates");

  const target = hostCargoReleaseTarget();
  if (target === null) {
    result.skipped.push("current host does not map to a supported native extension Cargo target");
  } else if (discoverExtensionManifests(roots).length === 0) {
    result.skipped.push("no extension-artifacts.json manifests found for native extension Cargo crates");
  } else {
    result.staged.push(`dry-run native extension Cargo crates for ${target}`);
  }

  const crates = discoverFiles(roots, [".crate"]);
  if (crates.length === 0) {
    addSkip(result, "no .crate artifacts found", strict);
    return result;
  }
  result.published.push(...crates.map((cratePath) => `dry-run cargo index ${rel(cratePath)}`));
  return result;
}

function stageReleaseAssetCargoPackages(roots, registryRoot, result, strict) {
  const outputRoot = path.join(registryRoot, "cargo-generated", "release-asset-crates");
  rmSync(outputRoot, { recursive: true, force: true });
  mkdirSync(outputRoot, { recursive: true });
  const generatedRoots = [];
  const hostTarget = hostCargoReleaseTarget();

  const libVersion = currentProductVersionSync("liboliphaunt-native", TOOL);
  const libAssetDir = path.join(ROOT, "target/liboliphaunt/release-assets");
  const copiedLibAssets = hostTarget === null
    ? []
    : copyReleaseAssetSet(roots, libAssetDir, nativeSplitReleaseAssetNames(libVersion, hostTarget));
  const libOutputDir = path.join(outputRoot, "liboliphaunt-native");
  if (hostTarget === null) {
    result.skipped.push("current host does not map to a supported native runtime Cargo target");
  } else if (
    copiedLibAssets.length > 0 ||
    (releaseAssetDirSelected(roots, libAssetDir) && releaseAssetDirHasFiles(libAssetDir, [
      `liboliphaunt-${libVersion}-*`,
      `oliphaunt-tools-${libVersion}-*`,
    ]))
  ) {
    const { ready, missing } = nativeSplitReleaseAssetsReady(libAssetDir, libVersion, hostTarget);
    if (!ready) {
      const message = nativeSplitReleaseAssetMissingMessage(libAssetDir, libVersion, hostTarget, missing);
      result.skipped.push(message);
      if (strict) {
        fail(TOOL, message);
      }
    } else {
      if (copiedLibAssets.length > 0) {
        result.staged.push(`staged ${copiedLibAssets.length} liboliphaunt release asset(s) for Cargo`);
      }
      runQuiet([
        "tools/dev/bun.sh",
        "tools/release/package-liboliphaunt-cargo-artifacts.mjs",
        "--version",
        libVersion,
        "--output-dir",
        libOutputDir,
        "--target",
        hostTarget,
      ]);
      generatedRoots.push(libOutputDir);
    }
  } else {
    result.skipped.push("no liboliphaunt release assets found for native Cargo artifact packages");
  }

  const brokerVersion = currentProductVersionSync("oliphaunt-broker", TOOL);
  const brokerAssetDir = path.join(ROOT, "target/oliphaunt-broker/release-assets");
  const copiedBrokerAssets = copyReleaseAssets(roots, brokerAssetDir, [
    "oliphaunt-broker-*.tar.gz",
    "oliphaunt-broker-*.zip",
  ]);
  const brokerOutputDir = path.join(outputRoot, "oliphaunt-broker");
  if (hostTarget === null) {
    result.skipped.push("current host does not map to a supported broker Cargo target");
  } else if (
    copiedBrokerAssets.length > 0 ||
    (releaseAssetDirSelected(roots, brokerAssetDir) && releaseAssetDirHasFiles(brokerAssetDir, [
      "oliphaunt-broker-*.tar.gz",
      "oliphaunt-broker-*.zip",
    ]))
  ) {
    if (copiedBrokerAssets.length > 0) {
      result.staged.push(`staged ${copiedBrokerAssets.length} broker release asset(s) for Cargo`);
    }
    runQuiet([
      "tools/dev/bun.sh",
      "tools/release/package_broker_cargo_artifacts.mjs",
      "--version",
      brokerVersion,
      "--output-dir",
      brokerOutputDir,
      "--target",
      hostTarget,
    ]);
    generatedRoots.push(brokerOutputDir);
  } else {
    result.skipped.push("no broker release assets found for broker Cargo artifact packages");
  }

  const wasixVersion = currentProductVersionSync("liboliphaunt-wasix", TOOL);
  const wasixAssetDir = path.join(ROOT, "target/oliphaunt-wasix/release-assets");
  const copiedWasixAssets = copyReleaseAssets(roots, wasixAssetDir, [`liboliphaunt-wasix-${wasixVersion}-*`]);
  const wasixOutputDir = path.join(outputRoot, "liboliphaunt-wasix");
  if (
    copiedWasixAssets.length > 0 ||
    (releaseAssetDirSelected(roots, wasixAssetDir) && releaseAssetDirHasFiles(wasixAssetDir, [
      `liboliphaunt-wasix-${wasixVersion}-*`,
    ]))
  ) {
    if (copiedWasixAssets.length > 0) {
      result.staged.push(`staged ${copiedWasixAssets.length} WASIX release asset(s) for Cargo`);
    }
    runQuiet([
      "tools/dev/bun.sh",
      "tools/release/package_liboliphaunt_wasix_cargo_artifacts.mjs",
      "--version",
      wasixVersion,
      "--output-dir",
      wasixOutputDir,
    ]);
    generatedRoots.push(wasixOutputDir);
  } else {
    result.skipped.push("no WASIX release assets found for WASIX Cargo artifact packages");
  }

  const generatedCrates = discoverFiles(generatedRoots, [".crate"]);
  if (generatedCrates.length > 0) {
    result.staged.push(`generated ${generatedCrates.length} release-asset Cargo crate(s)`);
  }
  return generatedRoots;
}

function cargoPackageNameFromCrate(cratePath) {
  const members = tryCommandOutput(["tar", "-tzf", cratePath]);
  if (members === null) {
    return null;
  }
  const manifest = members
    .split(/\r?\n/u)
    .filter(Boolean)
    .find((member) => member.split("/").length === 2 && member.endsWith("/Cargo.toml"));
  if (manifest === undefined) {
    return null;
  }
  const text = tryCommandOutput(["tar", "-xOzf", cratePath, manifest]);
  if (text === null) {
    return null;
  }
  try {
    const packageData = Bun.TOML.parse(text)?.package;
    return typeof packageData?.name === "string" && packageData.name ? packageData.name : null;
  } catch {
    return null;
  }
}

function cargoPackageNamesFromRoots(roots) {
  const names = new Set();
  for (const cratePath of discoverFiles(roots, [".crate"])) {
    const name = cargoPackageNameFromCrate(cratePath);
    if (name !== null) {
      names.add(name);
    }
  }
  return names;
}

function cargoDependencyNameMatchesHostTarget(name) {
  const hostTarget = hostCargoReleaseTarget();
  if (hostTarget === null) {
    return true;
  }
  const hostTriple = cargoTargetTriple(hostTarget);
  const hostMarkers = hostTriple === null ? [hostTarget] : [hostTarget, hostTriple];
  return hostMarkers.some((marker) =>
    name.endsWith(`-${marker}`) ||
    name.includes(`-${marker}-`) ||
    name.includes(`-aot-${marker}`));
}

function pruneMissingFeatureDependencies(text, missingPackageNames) {
  if (missingPackageNames.size === 0) {
    return text;
  }
  const lines = text.split(/\r?\n/u);
  const output = [];
  let inFeatures = false;
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (/^\[features\]$/u.test(line)) {
      inFeatures = true;
      output.push(line);
      index += 1;
      continue;
    }
    if (line.startsWith("[") && !line.startsWith("[[")) {
      inFeatures = false;
      output.push(line);
      index += 1;
      continue;
    }
    if (!inFeatures) {
      output.push(line);
      index += 1;
      continue;
    }
    const match = line.match(/^([A-Za-z0-9_-]+)\s*=/u);
    if (match === null) {
      output.push(line);
      index += 1;
      continue;
    }
    const featureName = match[1];
    const block = [line];
    index += 1;
    let bracketDepth = [...line].filter((char) => char === "[").length - [...line].filter((char) => char === "]").length;
    while (bracketDepth > 0 && index < lines.length) {
      block.push(lines[index]);
      bracketDepth += [...lines[index]].filter((char) => char === "[").length - [...lines[index]].filter((char) => char === "]").length;
      index += 1;
    }
    let values;
    try {
      values = Bun.TOML.parse(`[features]\n${block.join("\n")}\n`).features?.[featureName];
    } catch {
      output.push(...block);
      continue;
    }
    if (!Array.isArray(values) || !values.every((value) => typeof value === "string")) {
      output.push(...block);
      continue;
    }
    const filtered = values.filter((value) => !(value.startsWith("dep:") && missingPackageNames.has(value.slice("dep:".length))));
    if (filtered.length === values.length) {
      output.push(...block);
      continue;
    }
    output.push(`${featureName} = [${filtered.map((value) => JSON.stringify(value)).join(", ")}]`);
  }
  return `${output.join("\n").trimEnd()}\n`;
}

function pruneMissingLocalArtifactTargetDependencies(manifest, availablePackageNames, result, strict) {
  const lines = readFileSync(manifest, "utf8").split(/\r?\n/u);
  const output = [];
  const removed = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!/^\[target\..*\.dependencies\]$/u.test(line)) {
      output.push(line);
      index += 1;
      continue;
    }
    const block = [line];
    index += 1;
    while (index < lines.length && !/^\[[^\]]+\]$/u.test(lines[index])) {
      block.push(lines[index]);
      index += 1;
    }
    const dependencyNames = [];
    for (const blockLine of block.slice(1)) {
      const match = blockLine.match(/^([A-Za-z0-9_-]+)\s*=/u);
      if (match !== null) {
        dependencyNames.push(match[1]);
      }
    }
    const missing = dependencyNames.filter((name) => !availablePackageNames.has(name)).sort(compareText);
    if (missing.length > 0) {
      removed.push([line, missing]);
      while (output.at(-1) === "") {
        output.pop();
      }
      continue;
    }
    if (output.length > 0 && output.at(-1) !== "") {
      output.push("");
    }
    output.push(...block);
  }
  if (removed.length === 0) {
    return;
  }
  const missingPackages = new Set(removed.flatMap(([, missing]) => missing));
  if (strict) {
    const hostMissingPackages = [...missingPackages]
      .filter((name) => cargoDependencyNameMatchesHostTarget(name))
      .sort(compareText);
    if (hostMissingPackages.length > 0) {
      throw new Error(`${rel(manifest)} is missing local registry inputs for host target artifact dependencies: ${hostMissingPackages.join(", ")}`);
    }
  }
  const pruned = pruneMissingFeatureDependencies(`${output.join("\n").trimEnd()}\n`, missingPackages);
  writeFileSync(manifest, pruned);
  for (const [header, missing] of removed) {
    result.skipped.push(`${rel(manifest)} pruned ${header} because local registry inputs are missing ${missing.join(", ")}`);
  }
}

function nativeRuntimeArtifactManifests(sourceRoot, { includeParts = false } = {}) {
  if (!isDirectory(sourceRoot)) {
    return [];
  }
  const manifests = [];
  const toolsFacade = path.join(sourceRoot, "oliphaunt-tools", "Cargo.toml");
  if (isFile(toolsFacade)) {
    manifests.push(toolsFacade);
  }
  for (const entry of readdirSync(sourceRoot, { withFileTypes: true }).sort((left, right) => compareText(left.name, right.name))) {
    if (!entry.isDirectory()) {
      continue;
    }
    if (!entry.name.startsWith("liboliphaunt-native-") && !entry.name.startsWith("oliphaunt-tools-")) {
      continue;
    }
    const manifest = path.join(sourceRoot, entry.name, "Cargo.toml");
    if (isFile(manifest)) {
      manifests.push(manifest);
    }
  }
  const seen = new Set();
  const result = [];
  for (const manifest of manifests.sort(compareText)) {
    if (seen.has(manifest)) {
      continue;
    }
    seen.add(manifest);
    const { name } = readCargoPackageNameVersion(manifest, { fail: localFail, rel });
    if (name.includes("-part-") && !includeParts) {
      continue;
    }
    result.push(manifest);
  }
  return result;
}

async function stageCargoSourceCrates(roots, registryRoot, result, strict) {
  const outputDir = path.join(registryRoot, "cargo-generated", "source-crates");
  rmSync(outputDir, { recursive: true, force: true });
  mkdirSync(outputDir, { recursive: true });

  const generated = [];
  const packageOptions = { root: ROOT, fail: localFail, rel };
  const buildManifest = path.join(ROOT, "src/sdks/rust/crates/oliphaunt-build/Cargo.toml");
  generated.push(manualCargoPackageSource(buildManifest, outputDir, packageOptions));

  const preparedRustSource = commandOutput([
    "tools/dev/bun.sh",
    "tools/release/prepare-rust-release-source.mjs",
  ]).trim().split(/\r?\n/u).filter(Boolean).at(-1);
  if (preparedRustSource === undefined) {
    fail(TOOL, "prepare-rust-release-source.mjs did not print a generated Cargo.toml path");
  }
  const oliphauntManifest = path.resolve(ROOT, preparedRustSource);
  const availablePackageNames = cargoPackageNamesFromRoots(roots);
  const nativeSourceRoot = path.join(ROOT, "target/liboliphaunt/cargo-package-sources");
  const nativeRuntimePublicManifests = nativeRuntimeArtifactManifests(nativeSourceRoot);
  const nativeRuntimeAllManifests = nativeRuntimeArtifactManifests(nativeSourceRoot, { includeParts: true });
  for (const manifest of nativeRuntimePublicManifests) {
    availablePackageNames.add(readCargoPackageNameVersion(manifest, { fail: localFail, rel }).name);
  }
  pruneMissingLocalArtifactTargetDependencies(oliphauntManifest, availablePackageNames, result, strict);
  generated.push(manualCargoPackageSource(oliphauntManifest, outputDir, packageOptions));

  const wasixManifest = await prepareOliphauntWasixReleaseSource(await currentOliphauntWasixSdkVersion());
  pruneMissingLocalArtifactTargetDependencies(wasixManifest, availablePackageNames, result, strict);
  generated.push(manualCargoPackageSource(wasixManifest, outputDir, packageOptions));

  for (const manifest of nativeRuntimeAllManifests) {
    generated.push(manualCargoPackageSource(manifest, outputDir, packageOptions));
  }

  result.staged.push(...generated.map(rel));
  return generated;
}

function cargoCratesRequirePythonGeneration(options, roots) {
  return false;
}

function cargoCratePriority(cratePath, registryRoot) {
  let priority = 20;
  for (const [root, value] of [
    [path.join(registryRoot, "cargo-generated"), 100],
    [path.join(ROOT, "target/oliphaunt-wasix/cargo-artifacts-check"), 90],
    [path.join(ROOT, "target/local-registry-generated"), 80],
    [path.join(ROOT, "target/oliphaunt-wasix/cargo-artifacts"), 70],
    [DEFAULT_CURRENT_ARTIFACT_ROOT, 60],
    [path.join(ROOT, "target/package/tmp-registry"), 40],
    [path.join(ROOT, "target/package/tmp-crate"), 30],
  ]) {
    if (pathIsUnder(cratePath, root)) {
      priority = value;
      break;
    }
  }
  return [priority, cratePath];
}

function compareCargoCratePriority(left, right) {
  if (left[0] !== right[0]) {
    return left[0] - right[0];
  }
  return compareText(left[1], right[1]);
}

function isDefaultCargoTmpCrateArtifact(cratePath) {
  return pathIsUnder(cratePath, path.join(ROOT, "target/package/tmp-crate"));
}

function crateIndexPath(name) {
  const lower = name.toLowerCase();
  if (lower.length === 1) {
    return path.join("1", lower);
  }
  if (lower.length === 2) {
    return path.join("2", lower);
  }
  if (lower.length === 3) {
    return path.join("3", lower.slice(0, 1), lower);
  }
  return path.join(lower.slice(0, 2), lower.slice(2, 4), lower);
}

function cargoPackageLinksFromManifest(manifest) {
  const lines = readFileSync(manifest, "utf8").split(/\r?\n/u);
  let inPackage = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "[package]") {
      inPackage = true;
      continue;
    }
    if (trimmed.startsWith("[") && trimmed !== "[package]") {
      inPackage = false;
      continue;
    }
    if (!inPackage) {
      continue;
    }
    const match = trimmed.match(/^links\s*=\s*"([^"]+)"\s*(?:#.*)?$/u);
    if (match !== null) {
      return match[1];
    }
  }
  return null;
}

function cargoMetadataForCrate(cratePath) {
  const temp = mkdtempSync(path.join(os.tmpdir(), "oliphaunt-crate-"));
  try {
    const result = commandResult(["tar", "-xzf", cratePath, "-C", temp]);
    if (result.error || result.status !== 0) {
      const detail = (result.stderr || result.stdout || result.error?.message || "").trim();
      throw new Error(`failed to extract ${rel(cratePath)}${detail ? `: ${detail}` : ""}`);
    }
    const manifests = readdirSync(temp, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(temp, entry.name, "Cargo.toml"))
      .filter((manifest) => existsSync(manifest))
      .sort(compareText);
    if (manifests.length === 0) {
      throw new Error(`${rel(cratePath)} does not contain Cargo.toml`);
    }
    const metadata = commandResult([
      "cargo",
      "metadata",
      "--manifest-path",
      manifests[0],
      "--format-version",
      "1",
      "--no-deps",
    ]);
    if (metadata.error || metadata.status !== 0) {
      const detail = (metadata.stderr || metadata.stdout || metadata.error?.message || "").trim();
      throw new Error(`cargo metadata failed for ${rel(cratePath)}${detail ? `: ${detail}` : ""}`);
    }
    let parsed;
    try {
      parsed = JSON.parse(metadata.stdout);
    } catch (error) {
      throw new Error(`cargo metadata for ${rel(cratePath)} did not return valid JSON: ${error.message}`);
    }
    const packages = parsed?.packages;
    if (!Array.isArray(packages) || packages.length === 0 || typeof packages[0] !== "object") {
      throw new Error(`cargo metadata for ${rel(cratePath)} did not return a package`);
    }
    return {
      ...packages[0],
      _oliphaunt_links: cargoPackageLinksFromManifest(manifests[0]),
    };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

function sha256File(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function cargoIndexDependency(dep, localPackageNames) {
  let registry = dep.registry ?? null;
  if (localPackageNames.has(dep.name)) {
    registry = null;
  } else if (registry === null) {
    registry = CRATES_IO_INDEX;
  }
  return {
    name: dep.name,
    req: dep.req ?? "*",
    features: dep.features ?? [],
    optional: Boolean(dep.optional),
    default_features: Boolean(dep.uses_default_features ?? dep.default_features ?? true),
    target: dep.target ?? null,
    kind: dep.kind ?? "normal",
    registry,
    package: dep.rename ?? dep.package ?? null,
  };
}

function cargoIndexEntry(cratePath, packageData, localPackageNames) {
  return {
    name: packageData.name,
    vers: packageData.version,
    deps: (packageData.dependencies ?? []).map((dep) => cargoIndexDependency(dep, localPackageNames)),
    features: packageData.features ?? {},
    features2: null,
    cksum: sha256File(cratePath),
    yanked: false,
    links: packageData._oliphaunt_links ?? null,
    rust_version: packageData.rust_version ?? null,
    v: 2,
  };
}

function clearLocalCargoHomeCache(registryRoot) {
  const cargoHomeRegistry = path.join(registryRoot, "cargo-home", "registry");
  const removed = [];
  for (const name of ["cache", "src", "index"]) {
    const target = path.join(cargoHomeRegistry, name);
    if (existsSync(target)) {
      rmSync(target, { recursive: true, force: true });
      removed.push(target);
    }
  }
  const packageCache = path.join(cargoHomeRegistry, ".package-cache");
  if (existsSync(packageCache)) {
    rmSync(packageCache, { force: true });
    removed.push(packageCache);
  }
  return removed;
}

async function publishCargoCrates(roots, registryRoot, strict) {
  const result = surfaceResult("cargo");
  const releaseAssetRoots = stageReleaseAssetCargoPackages(roots, registryRoot, result, strict);
  if (releaseAssetRoots.length > 0) {
    roots = [...roots, ...releaseAssetRoots];
  }
  const generatedRoots = await stageCargoSourceCrates(roots, registryRoot, result, strict);
  if (generatedRoots.length > 0) {
    roots = [...roots, ...generatedRoots];
  }
  const extensionRoots = packageNativeExtensionCargoCrates(
    roots,
    path.join(registryRoot, "cargo-generated"),
    hostCargoReleaseTarget(),
    strict,
    result,
  );
  if (extensionRoots.length > 0) {
    roots = [...roots, ...extensionRoots];
  }
  const crates = discoverFiles(roots, [".crate"]);
  if (crates.length === 0) {
    addSkip(result, "no .crate artifacts found", strict);
    return result;
  }
  requireCommand("cargo");
  requireCommand("git");

  const cargoRoot = path.join(registryRoot, "cargo");
  const cratesDir = path.join(cargoRoot, "crates");
  const indexDir = path.join(cargoRoot, "index");
  const configSnippet = path.join(cargoRoot, "config.toml");
  rmSync(cargoRoot, { recursive: true, force: true });
  mkdirSync(cratesDir, { recursive: true });
  mkdirSync(indexDir, { recursive: true });
  writeFileSync(
    path.join(indexDir, "config.json"),
    `${JSON.stringify({ dl: `file://${cratesDir}/{crate}-{version}.crate` })}\n`,
  );

  const packagesByTargetName = new Map();
  for (const cratePath of crates.sort((left, right) =>
    compareCargoCratePriority(cargoCratePriority(left, registryRoot), cargoCratePriority(right, registryRoot)))) {
    if (NON_PUBLISHABLE_LOCAL_CARGO_CRATE_PREFIXES.some((prefix) => path.basename(cratePath).startsWith(prefix))) {
      result.skipped.push(`ignored non-publishable local Cargo crate artifact ${path.basename(cratePath)}`);
      continue;
    }
    const size = statSync(cratePath).size;
    if (size > CARGO_PACKAGE_SIZE_LIMIT_BYTES) {
      const message = `${rel(cratePath)} is ${size} bytes, exceeding the crates.io 10 MiB package limit`;
      result.skipped.push(message);
      if (strict) {
        fail(TOOL, message);
      }
      continue;
    }
    let packageData;
    try {
      packageData = cargoMetadataForCrate(cratePath);
    } catch (error) {
      if (isDefaultCargoTmpCrateArtifact(cratePath) && error.message.includes("does not contain Cargo.toml")) {
        result.skipped.push(`ignored malformed Cargo scratch artifact ${rel(cratePath)}`);
        continue;
      }
      result.skipped.push(error.message);
      if (strict) {
        throw error;
      }
      continue;
    }
    if (LEGACY_WASIX_ARTIFACT_CRATES.has(packageData.name)) {
      const message = `ignored legacy WASIX artifact crate ${path.basename(cratePath)}`;
      result.skipped.push(message);
      if (strict) {
        fail(TOOL, message);
      }
      continue;
    }
    packagesByTargetName.set(`${packageData.name}-${packageData.version}.crate`, [cratePath, packageData]);
  }

  const localPackageNames = new Set(
    [...packagesByTargetName.values()]
      .map(([, packageData]) => packageData.name)
      .filter((name) => typeof name === "string"),
  );
  const entriesByPath = new Map();
  for (const [targetName, [cratePath, packageData]] of [...packagesByTargetName.entries()].sort((left, right) => compareText(left[0], right[0]))) {
    const entry = cargoIndexEntry(cratePath, packageData, localPackageNames);
    copyFileSync(cratePath, path.join(cratesDir, targetName));
    const indexPath = crateIndexPath(entry.name);
    const entries = entriesByPath.get(indexPath) ?? [];
    entries.push(entry);
    entriesByPath.set(indexPath, entries);
    result.published.push(targetName);
  }

  for (const [indexPath, entries] of entriesByPath.entries()) {
    const target = path.join(indexDir, indexPath);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(
      target,
      entries.map((entry) => `${JSON.stringify(entry)}\n`).join(""),
    );
  }

  runQuiet(["git", "init"], { cwd: indexDir });
  runQuiet(["git", "config", "user.name", "Oliphaunt Local Registry"], { cwd: indexDir });
  runQuiet(["git", "config", "user.email", "local-registry@oliphaunt.invalid"], { cwd: indexDir });
  runQuiet(["git", "add", "."], { cwd: indexDir });
  runQuiet(["git", "commit", "-m", "local cargo registry"], { cwd: indexDir });
  writeFileSync(configSnippet, [
    "[registries.oliphaunt-local]",
    `index = "file://${indexDir}"`,
    "",
  ].join("\n"));
  for (const removed of clearLocalCargoHomeCache(registryRoot)) {
    result.staged.push(`cleared ${rel(removed)}`);
  }
  result.staged.push(rel(indexDir), rel(configSnippet));
  return result;
}

function parsePublishArgs(argv) {
  const options = {
    artifactRoots: [],
    registryRoot: path.join(ROOT, "target/local-registries"),
    surfaces: [],
    verdaccioPort: "4873",
    dryRun: false,
    strict: false,
    help: false,
  };
  const readValue = (index, flag) => {
    if (index + 1 >= argv.length) {
      fail(TOOL, `${flag} requires a value`, 2);
    }
    return argv[index + 1];
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "-h" || value === "--help") {
      options.help = true;
      continue;
    }
    if (value === "--artifact-root") {
      options.artifactRoots.push(readValue(index, value));
      index += 1;
      continue;
    }
    if (value.startsWith("--artifact-root=")) {
      options.artifactRoots.push(value.slice("--artifact-root=".length));
      continue;
    }
    if (value === "--registry-root") {
      options.registryRoot = path.resolve(ROOT, readValue(index, value));
      index += 1;
      continue;
    }
    if (value.startsWith("--registry-root=")) {
      options.registryRoot = path.resolve(ROOT, value.slice("--registry-root=".length));
      continue;
    }
    if (value === "--surface") {
      options.surfaces.push(readValue(index, value));
      index += 1;
      continue;
    }
    if (value.startsWith("--surface=")) {
      options.surfaces.push(value.slice("--surface=".length));
      continue;
    }
    if (value === "--verdaccio-port") {
      options.verdaccioPort = readValue(index, value);
      index += 1;
      continue;
    }
    if (value.startsWith("--verdaccio-port=")) {
      options.verdaccioPort = value.slice("--verdaccio-port=".length);
      continue;
    }
    if (value === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (value === "--strict") {
      options.strict = true;
      continue;
    }
    fail(TOOL, `unknown publish argument ${value}`, 2);
  }
  const invalidSurfaces = options.surfaces.filter((surface) => !["npm", "cargo", "maven", "swift"].includes(surface));
  if (invalidSurfaces.length > 0) {
    fail(TOOL, `unsupported publish surface: ${invalidSurfaces[0]}`, 2);
  }
  return options;
}

function canPublishInBun(options, roots) {
  return !options.help
    && options.surfaces.length > 0
    && options.surfaces.every(
      (surface) =>
        surface === "maven" ||
        surface === "swift" ||
        (surface === "cargo" && (options.dryRun || !cargoCratesRequirePythonGeneration(options, roots))) ||
        (surface === "npm" && (options.dryRun || !npmTarballsRequirePythonGeneration(roots))),
    );
}

async function publish(argv) {
  const options = parsePublishArgs(argv);
  if (options.help) {
    publishHelp();
    return;
  }
  const roots = discoverRoots(options.artifactRoots);
  if (!canPublishInBun(options, roots)) {
    fail(TOOL, "publish surface is not implemented in the Bun local-registry entrypoint", 2);
  }
  mkdirSync(options.registryRoot, { recursive: true });
  const results = [];
  for (const surface of options.surfaces) {
    if (surface === "cargo") {
      results.push(options.dryRun
        ? publishCargoDryRun(roots, options.strict)
        : await publishCargoCrates(roots, options.registryRoot, options.strict));
    } else if (surface === "npm") {
      results.push(options.dryRun
        ? publishNpmDryRun(roots, options.registryRoot, options.strict, options.verdaccioPort)
        : await publishNpmTarballs(roots, options.registryRoot, options.strict, options.verdaccioPort));
    } else if (surface === "maven") {
      results.push(publishMaven(roots, options.registryRoot, options.dryRun, options.strict));
    } else if (surface === "swift") {
      results.push(publishSwift(roots, options.registryRoot, options.dryRun, options.strict));
    }
  }
  const report = {
    artifact_roots: roots,
    dry_run: options.dryRun,
    registry_root: options.registryRoot,
    surfaces: results.map(reportSurfaceResult),
  };
  const text = `${JSON.stringify(report, null, 2)}\n`;
  if (!options.dryRun) {
    writeFileSync(path.join(options.registryRoot, "report.json"), text);
  }
  process.stdout.write(text);
}

function publishHelp() {
  console.log(`usage: local-registry-publish.mjs publish [-h] [--artifact-root ARTIFACT_ROOT] [--registry-root REGISTRY_ROOT] [--surface {npm,cargo,maven,swift}] [--verdaccio-port VERDACCIO_PORT] [--dry-run] [--strict]

options:
  -h, --help            show this help message and exit
  --artifact-root ARTIFACT_ROOT
  --registry-root REGISTRY_ROOT
  --surface {npm,cargo,maven,swift}
                        publish only this surface; may be repeated
  --verdaccio-port VERDACCIO_PORT
  --dry-run
  --strict
`);
}

function parseStatusArgs(argv) {
  const artifactRoots = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--artifact-root") {
      if (index + 1 >= argv.length) {
        console.error(`${TOOL}: --artifact-root requires a value`);
        process.exit(2);
      }
      artifactRoots.push(argv[index + 1]);
      index += 1;
      continue;
    }
    if (value.startsWith("--artifact-root=")) {
      artifactRoots.push(value.slice("--artifact-root=".length));
      continue;
    }
    if (value === "-h" || value === "--help") {
      statusHelp();
      process.exit(0);
    }
    console.error(`${TOOL}: unknown status argument ${value}`);
    process.exit(2);
  }
  return { artifactRoots };
}

function statusHelp() {
  console.log(`usage: local-registry-publish.mjs status [-h] [--artifact-root ARTIFACT_ROOT]

options:
  -h, --help            show this help message and exit
  --artifact-root ARTIFACT_ROOT
`);
}

function status(argv) {
  const { artifactRoots } = parseStatusArgs(argv);
  const roots = discoverRoots(artifactRoots);
  const report = {
    artifact_roots: roots.map((root) => root),
    artifacts: {
      cargo: discoverFiles(roots, [".crate"]).map(rel),
      maven_roots: roots
        .filter((root) => statSync(root).isDirectory())
        .flatMap((root) => walkDirsNamed(root, "maven").map(rel)),
      npm: discoverFiles(roots, [".tgz"]).map(rel),
      swift: discoverFiles(roots, [".swift", ".zip"])
        .filter((file) => path.basename(file) === "Package.swift.release" || file.includes("swift"))
        .map(rel),
    },
    default_run_id: DEFAULT_RUN_ID,
    tools: {
      cargo: executableExists("cargo"),
      gh: executableExists("gh"),
      java: executableExists("java"),
      npm: executableExists("npm"),
      pnpm: executableExists("pnpm"),
      swift: executableExists("swift"),
    },
  };
  console.log(JSON.stringify(report, null, 2));
}

function mainHelp() {
  console.log(`usage: local-registry-publish.mjs [-h] {download,publish,status} ...

Stage Oliphaunt release artifacts into local package registries.

positional arguments:
  {download,publish,status}
    download            download GitHub Actions artifacts with gh
    publish             publish staged artifacts to local registries
    status              show locally available staged artifacts

options:
  -h, --help            show this help message and exit
`);
}

function unsupportedCommand(command) {
  const label = command === undefined ? "<missing>" : command;
  console.error(`${TOOL}: unsupported command ${label}; expected download, publish, or status`);
  mainHelp();
  process.exit(2);
}

const [command, ...args] = Bun.argv.slice(2);
if (command === "download") {
  download(args);
} else if (command === "publish") {
  await publish(args);
} else if (command === "status") {
  status(args);
} else if (command === "-h" || command === "--help") {
  mainHelp();
} else {
  unsupportedCommand(command);
}
