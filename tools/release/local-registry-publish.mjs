#!/usr/bin/env bun
import { spawn as nodeSpawn, spawnSync as nodeSpawnSync } from "node:child_process";
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
import { captureCommandOutput } from "../dev/capture-command-output.mjs";
import {
  allArtifactTargets,
  currentProductVersionSync,
} from "./release-artifact-targets.mjs";
import { fail, ROOT, run } from "./release-cli-utils.mjs";
import {
  extensionNpmPackageForProduct,
} from "./extension-registry-packages.mjs";
import {
  canonicalExtensionNpmTargets,
  discoverExtensionManifests,
  extensionManifestMembers,
  localRegistryCommandInvocation,
  packageNativeExtensionCargoCrates,
  stageExtensionNpmPackages,
} from "./extension-registry-carrier-materializer.mjs";
export {
  canonicalExtensionNpmTargets,
  exactNativeExtensionMemberDependencies,
  frozenExtensionMemberInventory,
  localRegistryCommandInvocation,
  packageNativeExtensionCargoCrates,
  renderNpmExtensionBundleManifest,
  stageExtensionNpmPackages,
} from "./extension-registry-carrier-materializer.mjs";
import {
  currentOliphauntWasixSdkVersion,
  prepareOliphauntWasixReleaseSource,
} from "./package_oliphaunt_wasix_sdk_crate.mjs";
import {
  requiredRuntimeTools,
  requiredToolsPackageTools,
} from "./optimize_native_runtime_payload.mjs";
import {
  loadPublicationCatalog,
  resolveActualCarrier,
} from "./publication-catalog.mjs";
import {
  NPM_TRUSTED_PUBLISHING_REPOSITORY,
  validateNpmTrustedPublishingManifest,
} from "./npm-trusted-publishing.mjs";
import {
  WINDOWS_VC_RUNTIME_RECEIPT,
  parseWindowsVcRuntimeReceipt,
  windowsVcRuntimeProfileNames,
} from "./windows-vc-runtime-closure.mjs";
import {
  assertReleaseNoticesInArchive,
  assertReleaseNoticesInDirectory,
  releaseNoticeRows,
  stageReleaseNotices,
} from "./release-notices.mjs";
import {
  prepareOliphauntBuildReleaseSource,
  prepareRustReleaseSource,
} from "./prepare-rust-release-source.mjs";
import {
  assertBrokerDependencyLicensesInArchive,
  assertBrokerDependencyLicensesInDirectory,
  brokerDependencyLicenseMembers,
  normalizeBrokerDependencyLicenseModes,
} from "./broker-dependency-license-contract.mjs";

const TOOL = "local-registry-publish.mjs";
const DEFAULT_REPO = "f0rr0/oliphaunt";
const DEFAULT_WORKFLOW = "CI";
const DEFAULT_CURRENT_ARTIFACT_ROOT = path.join(ROOT, "target/local-registry-current");
const DEFAULT_ARTIFACT_ROOT = path.join(ROOT, "target/local-registry-artifacts");
const VERDACCIO_RUNTIME_INSTALLER = path.join(ROOT, "tools/release/install-verdaccio-runtime.sh");
const VERDACCIO_RUNTIME_ROOT = path.join(ROOT, "tools/release/verdaccio-runtime");
// npm does not impose crates.io's 10 MiB package limit. Keep one deliberately
// generous guard against accidentally publishing an unbounded staging tree,
// but never manufacture package identities merely to satisfy a repository-
// local threshold.
const NPM_PACKAGE_SAFETY_LIMIT_BYTES = 100 * 1024 * 1024;
const CARGO_PACKAGE_SIZE_LIMIT_BYTES = 10 * 1024 * 1024;
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

function spawn(command, args, options) {
  const invocation = localRegistryCommandInvocation(command, args, { cwd: options.cwd ?? ROOT });
  return nodeSpawn(invocation.command, invocation.args, {
    ...options,
    cwd: invocation.cwd ?? options.cwd,
    shell: invocation.shell,
  });
}

function captureLocalCommand(
  command,
  args,
  {
    cwd = ROOT,
    env = undefined,
    label = `${command} ${args.join(" ")}`,
    maxOutputBytes = 64 * 1024 * 1024,
    timeout = undefined,
  } = {},
) {
  const invocation = localRegistryCommandInvocation(command, args, { cwd });
  return captureCommandOutput(invocation.command, invocation.args, {
    cwd: invocation.cwd ?? cwd,
    env,
    label,
    maxOutputBytes,
    shell: invocation.shell,
    timeout,
  });
}

function cargoCandidateScopeError(message) {
  return new Error(`${TOOL}: ${message}`);
}

export function parseCargoCandidateProductsJson(raw) {
  let products;
  try {
    products = JSON.parse(raw);
  } catch (error) {
    throw cargoCandidateScopeError(`--products-json must be valid JSON: ${error.message}`);
  }
  if (
    !Array.isArray(products)
    || products.length === 0
    || products.some((product) => typeof product !== "string" || product.length === 0)
  ) {
    throw cargoCandidateScopeError("--products-json must be a non-empty JSON string list");
  }
  if (new Set(products).size !== products.length) {
    throw cargoCandidateScopeError("--products-json must not contain duplicate products");
  }
  return products;
}

export function createCargoCandidateScope(products) {
  const fullCatalog = loadPublicationCatalog(TOOL);
  const selectedCatalog = loadPublicationCatalog(TOOL, { products });
  const expectedCarriers = new Map(
    selectedCatalog.carriers
      .filter((carrier) => carrier.ecosystem === "cargo")
      .map((carrier) => [carrier.name, carrier]),
  );
  if (expectedCarriers.size === 0) {
    throw cargoCandidateScopeError("selected products declare no Cargo publication carriers");
  }
  return {
    products: [...products],
    selectedProducts: new Set(products),
    expectedCarriers,
    fullCatalog,
  };
}

export function selectScopedCargoCandidates(scope, candidates) {
  const selectedByIdentity = new Map();
  const skipped = [];
  for (const candidate of candidates) {
    const carrier = resolveActualCarrier(scope.fullCatalog, "cargo", candidate.packageData.name, TOOL);
    if (!scope.selectedProducts.has(carrier.product)) {
      skipped.push(
        `excluded unselected Cargo carrier ${candidate.packageData.name}@${candidate.packageData.version} (${carrier.product})`,
      );
      continue;
    }
    if (candidate.packageData.version !== carrier.version) {
      throw cargoCandidateScopeError(
        `selected Cargo carrier ${candidate.packageData.name} has artifact version ${candidate.packageData.version}; expected ${carrier.version} for ${carrier.product}`,
      );
    }
    const identity = `${candidate.packageData.name}@${candidate.packageData.version}`;
    const previous = selectedByIdentity.get(identity);
    if (previous !== undefined) {
      if (previous.checksum !== candidate.checksum) {
        throw cargoCandidateScopeError(
          `selected Cargo carrier ${identity} has conflicting candidate bytes: ${rel(previous.cratePath)} (${previous.checksum}) and ${rel(candidate.cratePath)} (${candidate.checksum})`,
        );
      }
      skipped.push(`deduplicated byte-identical selected Cargo carrier ${identity} from ${rel(candidate.cratePath)}`);
      continue;
    }
    selectedByIdentity.set(identity, candidate);
  }

  const selectedNames = new Set(
    [...selectedByIdentity.values()].map((candidate) => candidate.packageData.name),
  );
  const missing = [...scope.expectedCarriers.values()]
    .filter((carrier) => !selectedNames.has(carrier.name))
    .map((carrier) => `${carrier.name}@${carrier.version} (${carrier.product})`)
    .sort(compareText);
  if (missing.length > 0) {
    throw cargoCandidateScopeError(
      `exact candidate artifacts are missing selected Cargo carriers: ${missing.join(", ")}`,
    );
  }

  return {
    selected: [...selectedByIdentity.values()].sort((left, right) =>
      compareText(
        `${left.packageData.name}-${left.packageData.version}`,
        `${right.packageData.name}-${right.packageData.version}`,
      )),
    skipped,
  };
}

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
  const result = captureLocalCommand(args[0], args.slice(1), {
    cwd: ROOT,
    label: args.join(" "),
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

function commandResult(args, { env = process.env, timeout = undefined } = {}) {
  return captureLocalCommand(args[0], args.slice(1), {
    cwd: ROOT,
    env,
    label: args.join(" "),
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

function runQuiet(args, { cwd = ROOT, env = process.env } = {}) {
  const invocation = localRegistryCommandInvocation(args[0], args.slice(1), { cwd });
  const result = nodeSpawnSync(invocation.command, invocation.args, {
    cwd: invocation.cwd ?? cwd,
    env,
    shell: invocation.shell,
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
    process.execPath,
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

function parseDownloadArgs(argv) {
  const options = {
    repo: DEFAULT_REPO,
    workflow: DEFAULT_WORKFLOW,
    sha: null,
    runId: null,
    requiredJob: null,
    destination: DEFAULT_ARTIFACT_ROOT,
    artifacts: [],
    preset: null,
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
    if (value === "--workflow") {
      options.workflow = readValue(index, value);
      index += 1;
      continue;
    }
    if (value.startsWith("--workflow=")) {
      options.workflow = value.slice("--workflow=".length);
      continue;
    }
    if (value === "--sha") {
      options.sha = readValue(index, value);
      index += 1;
      continue;
    }
    if (value.startsWith("--sha=")) {
      options.sha = value.slice("--sha=".length);
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
    if (value === "--job") {
      options.requiredJob = readValue(index, value);
      index += 1;
      continue;
    }
    if (value.startsWith("--job=")) {
      options.requiredJob = value.slice("--job=".length);
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
    fail(TOOL, `unknown download argument ${value}`, 2);
  }
  if (options.preset !== null && options.preset !== "local-publish") {
    fail(TOOL, `download --preset must be local-publish, got ${options.preset}`, 2);
  }
  if (options.sha === null || !/^[0-9a-f]{40}$/u.test(options.sha)) {
    fail(TOOL, "download requires --sha with the exact 40-character lowercase commit SHA", 2);
  }
  if (options.runId !== null && !/^[1-9][0-9]*$/u.test(options.runId)) {
    fail(TOOL, "download --run-id must be a positive integer", 2);
  }
  if (options.workflow.length === 0) {
    fail(TOOL, "download --workflow must be non-empty", 2);
  }
  return options;
}

function downloadHelp() {
  console.log(`usage: local-registry-publish.mjs download [-h] [--repo REPO] [--workflow WORKFLOW] --sha SHA [--run-id RUN_ID] [--job JOB] [--destination DESTINATION] [--artifact ARTIFACT] [--preset local-publish]

options:
  -h, --help            show this help message and exit
  --repo REPO
  --workflow WORKFLOW   exact workflow name (default: CI)
  --sha SHA             exact qualified 40-character commit SHA
  --run-id RUN_ID
  --job JOB             require this exact successful job
  --destination DESTINATION
  --artifact ARTIFACT
  --preset local-publish
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

  const command = [
    "node",
    ".github/scripts/download-build-artifacts.mjs",
    options.workflow,
    options.sha,
    options.destination,
  ];
  if (options.runId !== null) command.push("--run-id", options.runId);
  if (options.requiredJob !== null) command.push("--job", options.requiredJob);
  for (const artifact of artifacts) {
    command.push("--artifact", artifact);
  }
  runQuiet(command, {
    env: {
      ...process.env,
      GH_REPO: options.repo,
    },
  });
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

function rustCrateIdent(crateName) {
  return crateName.replaceAll("-", "_");
}

function tomlString(value) {
  return JSON.stringify(value);
}

export function npmPackageIdentity(tarball) {
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
  const result = captureLocalCommand(args[0], args.slice(1), {
    cwd: ROOT,
    label,
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

export function extractArchiveTree(archive, sourcePrefix, destination) {
  const temp = archiveTempDir();
  const prefix = sourcePrefix.replace(/\/+$/u, "");
  try {
    if (archive.endsWith(".zip")) {
      requireCommand("unzip");
      // Info-ZIP wildcard recursion differs between Unix and Windows builds.
      // Extract into the isolated scratch directory without a member glob,
      // then copy only the requested tree into the package stage.
      runArchiveCommand(["unzip", "-q", archive, "-d", temp], `extract ${prefix} from ${rel(archive)}`);
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
    process.execPath,
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

function embeddedCoreModuleMember(target, prefix) {
  const filename = target === "windows-x64-msvc"
    ? "plpgsql.dll"
    : target === "macos-arm64"
      ? "plpgsql.dylib"
      : "plpgsql.so";
  return `${prefix.replace(/\/+$/u, "")}/${filename}`;
}

export function stageWindowsVcRuntimeMembers(
  archive,
  stage,
  target,
  prefix,
  { alreadyExtracted = false, profile } = {},
) {
  if (target !== "windows-x64-msvc") return [];
  const normalizedPrefix = prefix.replace(/\/+$/u, "");
  const receiptMember = `${normalizedPrefix}/${WINDOWS_VC_RUNTIME_RECEIPT}`;
  const receiptPath = path.join(stage, ...receiptMember.split("/"));
  // Bulk ZIP tree extraction is not consistent across the Info-ZIP builds on
  // GitHub's Unix and Windows runners. Always recover the small canonical
  // receipt by exact archive identity, then checksum every staged DLL against
  // it. Existing-but-truncated bulk output is no more trustworthy than a
  // missing member.
  extractArchiveMember(archive, receiptMember, receiptPath);
  const receipt = parseWindowsVcRuntimeReceipt(readFileSync(receiptPath), `${rel(archive)}:${receiptMember}`);
  const names = [...receipt.keys()].sort();
  if (profile !== undefined) {
    const expected = windowsVcRuntimeProfileNames(profile).sort();
    if (JSON.stringify(names) !== JSON.stringify(expected)) {
      fail(
        TOOL,
        `${rel(archive)} ${normalizedPrefix} ${profile} VC runtime profile expected ${expected.join(", ")}, got ${names.join(", ")}`,
      );
    }
  }
  for (const name of names) {
    const member = `${normalizedPrefix}/${name}`;
    const destination = path.join(stage, ...member.split("/"));
    const expectedDigest = receipt.get(name);
    if (
      !alreadyExtracted
      || !isFile(destination)
      || sha256File(destination) !== expectedDigest
    ) {
      extractArchiveMember(archive, member, destination);
    }
    if (!isFile(destination) || sha256File(destination) !== expectedDigest) {
      fail(
        TOOL,
        `${rel(archive)} exact VC runtime member ${member} does not match ${receiptMember}`,
      );
    }
  }
  return [receiptMember, ...names.map((name) => `${normalizedPrefix}/${name}`)];
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
  try {
    validateNpmTrustedPublishingManifest(packageJson, rel(path.join(packageDir, "package.json")));
  } catch (error) {
    fail(TOOL, error instanceof Error ? error.message : String(error));
  }
  const packDir = path.join(tarballRoot, safeNpmPackageFilenamePrefix(packageName));
  rmSync(packDir, { recursive: true, force: true });
  mkdirSync(packDir, { recursive: true });
  const result = captureLocalCommand("pnpm", ["pack", "--pack-destination", packDir, "--json"], {
    cwd: packageDir,
    label: `pnpm pack for ${packageName}`,
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
  try {
    validateNpmTrustedPublishingManifest(
      tarballPackageJson(destinationTarball),
      `${rel(destinationTarball)} package/package.json`,
    );
  } catch (error) {
    fail(TOOL, error instanceof Error ? error.message : String(error));
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

function stageLiboliphauntNpmPayloads(version, stageRoot, assetDir, { targetSet = null } = {}) {
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
    stageReleaseNotices(stage, { profile: "native-runtime" });
    const archive = path.join(assetDir, target.asset.replaceAll("{version}", version));
    extractArchiveMember(archive, target.libraryRelativePath, path.join(stage, target.libraryRelativePath));
    extractArchiveTree(archive, "lib/modules", path.join(stage, "lib/modules"));
    extractArchiveTree(archive, "runtime", path.join(stage, "runtime"));
    const vcRuntimeMembers = [
      ...stageWindowsVcRuntimeMembers(archive, stage, target.target, "bin", { profile: "provider" }),
      ...stageWindowsVcRuntimeMembers(archive, stage, target.target, "runtime/bin", {
        alreadyExtracted: true,
        profile: "provider",
      }),
    ];
    ensureNativeToolsAbsentFromRuntime(stage, target.target);
    runNativePayloadOptimizer(stage, target.target, "runtime");
    assertReleaseNoticesInDirectory(stage, { profile: "native-runtime" });
    stages.set(packageName, { stage, vcRuntimeMembers });
  }
  return stages;
}

function stageLiboliphauntToolsNpmPayloads(version, stageRoot, assetDir, { targetSet = null } = {}) {
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
    stageReleaseNotices(stage, { profile: "native-tools" });
    const archive = path.join(assetDir, target.asset.replaceAll("{version}", version));
    for (const tool of requiredToolsPackageTools(target.target)) {
      const member = `runtime/bin/${tool}`;
      extractArchiveMember(archive, member, path.join(stage, member), { mode: archive.endsWith(".zip") ? 0o755 : null });
    }
    const vcRuntimeMembers = stageWindowsVcRuntimeMembers(archive, stage, target.target, "runtime/bin");
    runNativePayloadOptimizer(stage, target.target, "tools");
    assertReleaseNoticesInDirectory(stage, { profile: "native-tools" });
    stages.set(packageName, { stage, vcRuntimeMembers });
  }
  return stages;
}

function stageLiboliphauntIcuNpmPayload(version, stageRoot, assetDir) {
  const packageName = "@oliphaunt/icu";
  const stage = stageNpmPackageDescriptor(
    packageName,
    path.join(ROOT, "src/runtimes/liboliphaunt/native/icu-npm"),
    stageRoot,
    version,
    { extraDescriptors: ["OliphauntICU.podspec"], target: "portable" },
  );
  extractArchiveTree(
    path.join(assetDir, `liboliphaunt-${version}-icu-data.tar.gz`),
    "share/icu",
    path.join(stage, "share/icu"),
  );
  stageReleaseNotices(stage, { profile: "native-icu-data" });
  assertReleaseNoticesInDirectory(stage, { profile: "native-icu-data" });
  return stage;
}

function liboliphauntNpmTarballs(
  version,
  stageRoot,
  tarballRoot,
  assetDir,
  { targetSet = null, includeIcu = true } = {},
) {
  const packages = [];
  const runtimeStages = stageLiboliphauntNpmPayloads(version, stageRoot, assetDir, { targetSet });
  const toolsStages = stageLiboliphauntToolsNpmPayloads(version, stageRoot, assetDir, { targetSet });
  for (const [packageName, , target] of artifactNpmPackageTargets(
    "liboliphaunt-native",
    "native-runtime",
    "typescript-native-direct",
    path.join(ROOT, "src/runtimes/liboliphaunt/native/packages"),
  )) {
    if (targetSet !== null && !targetSet.has(target.target)) {
      continue;
    }
    const payload = runtimeStages.get(packageName);
    const runtimeMembers = requiredRuntimeMemberPaths(target.target, "package/runtime/bin");
    const requiredMembers = [
      `package/${target.libraryRelativePath}`,
      embeddedCoreModuleMember(target.target, "package/lib/modules"),
      ...runtimeMembers,
      ...payload.vcRuntimeMembers.map((member) => `package/${member}`),
      ...releaseNoticeRows({ profile: "native-runtime" }).map((row) => `package/${row.member}`),
    ];
    const tarball = npmPackAndValidate(packageName, payload.stage, version, tarballRoot, {
      requiredMembers,
      executableMembers: runtimeMembers,
      target: target.target,
    });
    assertReleaseNoticesInArchive(tarball, { profile: "native-runtime", prefix: "package" });
    packages.push([packageName, tarball]);
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
    const payload = toolsStages.get(packageName);
    const runtimeMembers = requiredToolsMemberPaths(target.target, "package/runtime/bin");
    const tarball = npmPackAndValidate(packageName, payload.stage, version, tarballRoot, {
      requiredMembers: [
        ...runtimeMembers,
        ...payload.vcRuntimeMembers.map((member) => `package/${member}`),
        ...releaseNoticeRows({ profile: "native-tools" }).map((row) => `package/${row.member}`),
      ],
      executableMembers: runtimeMembers,
      target: target.target,
    });
    assertReleaseNoticesInArchive(tarball, { profile: "native-tools", prefix: "package" });
    packages.push([packageName, tarball]);
  }
  if (includeIcu) {
    const packageName = "@oliphaunt/icu";
    const stage = stageLiboliphauntIcuNpmPayload(version, stageRoot, assetDir);
    const tarball = pnpmPackForNpmPublish(stage, tarballRoot);
    packedIcuPackageContains(tarball, packageName, version);
    assertReleaseNoticesInArchive(tarball, { profile: "native-icu-data", prefix: "package" });
    packages.push([packageName, tarball]);
  }
  return packages;
}

function stageBrokerNpmPayloads(version, stageRoot, assetDir, { targetSet = null } = {}) {
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
    stageReleaseNotices(stage, { profile: "broker" });
    assertReleaseNoticesInDirectory(stage, { profile: "broker" });
    const archive = path.join(assetDir, target.asset.replaceAll("{version}", version));
    assertBrokerDependencyLicensesInArchive(archive, { target: target.target });
    extractArchiveMember(archive, target.executableRelativePath, path.join(stage, target.executableRelativePath), {
      mode: archive.endsWith(".zip") ? 0o755 : null,
    });
    extractArchiveTree(
      archive,
      "THIRD_PARTY_LICENSES/rust",
      path.join(stage, "THIRD_PARTY_LICENSES/rust"),
    );
    normalizeBrokerDependencyLicenseModes(stage, target.target);
    assertBrokerDependencyLicensesInDirectory(stage, { target: target.target });
    const vcRuntimeMembers = stageWindowsVcRuntimeMembers(archive, stage, target.target, "bin");
    stages.set(packageName, { stage, vcRuntimeMembers });
  }
  return stages;
}

export function brokerNpmTarballs(version, stageRoot, tarballRoot, assetDir, { targetSet = null } = {}) {
  const packages = [];
  const stages = stageBrokerNpmPayloads(version, stageRoot, assetDir, { targetSet });
  for (const [packageName, , target] of artifactNpmPackageTargets(
    "oliphaunt-broker",
    "broker-helper",
    "typescript-broker",
    path.join(ROOT, "src/runtimes/broker/packages"),
  )) {
    if (targetSet !== null && !targetSet.has(target.target)) {
      continue;
    }
    const payload = stages.get(packageName);
    const executableMember = `package/${target.executableRelativePath}`;
    const requiredMembers = [
      executableMember,
      ...payload.vcRuntimeMembers.map((member) => `package/${member}`),
      ...releaseNoticeRows({ profile: "broker" }).map((row) => `package/${row.member}`),
      ...brokerDependencyLicenseMembers(target.target, { prefix: "package" }),
    ];
    const tarball = npmPackAndValidate(packageName, payload.stage, version, tarballRoot, {
      requiredMembers,
      executableMembers: [executableMember],
      target: target.target,
    });
    assertBrokerDependencyLicensesInArchive(tarball, { target: target.target, prefix: "package" });
    packages.push([packageName, tarball]);
  }
  return packages;
}

export function npmReleaseAssetStagingLayout(registryRoot) {
  const outputRoot = path.join(
    path.resolve(registryRoot),
    "npm-generated",
    "release-asset-packages",
  );
  const assetRoot = path.join(outputRoot, "release-assets");
  return {
    outputRoot,
    liboliphauntAssetDir: path.join(assetRoot, "liboliphaunt"),
    brokerAssetDir: path.join(assetRoot, "oliphaunt-broker"),
  };
}

function stageReleaseAssetNpmPackages(roots, registryRoot, result, strict) {
  const {
    outputRoot,
    liboliphauntAssetDir: libAssetDir,
    brokerAssetDir,
  } = npmReleaseAssetStagingLayout(registryRoot);
  const stageRoot = path.join(outputRoot, "sources");
  const tarballRoot = path.join(outputRoot, "tarballs");
  rmSync(outputRoot, { recursive: true, force: true });
  mkdirSync(stageRoot, { recursive: true });
  mkdirSync(tarballRoot, { recursive: true });

  const tarballs = [];
  const target = hostNpmTarget();
  const targetSet = target === null ? null : new Set([target]);

  const libVersion = currentProductVersionSync("liboliphaunt-native", TOOL);
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
      tarballs.push(...liboliphauntNpmTarballs(
        libVersion,
        stageRoot,
        tarballRoot,
        libAssetDir,
        { targetSet },
      ).map(([, tarball]) => tarball));
    }
  } else {
    result.skipped.push("no liboliphaunt release assets found for native npm artifact packages");
  }

  const brokerVersion = currentProductVersionSync("oliphaunt-broker", TOOL);
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
    tarballs.push(...brokerNpmTarballs(
      brokerVersion,
      stageRoot,
      tarballRoot,
      brokerAssetDir,
      { targetSet },
    ).map(([, tarball]) => tarball));
  } else {
    result.skipped.push("no broker release assets found for broker npm artifact packages");
  }

  if (tarballs.length > 0) {
    result.staged.push(`generated ${tarballs.length} release-asset npm package(s)`);
  }
  return tarballs;
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
    const product = manifest.product;
    const members = extensionManifestMembers(manifest).map((member) => member.sqlName);
    const version = manifest.version;
    if (typeof product === "string" && typeof version === "string" && members.length > 0) {
      result.staged.push(`dry-run npm extension packages ${extensionNpmPackageForProduct(product)}@${version} (${target}; ${members.length} member(s))`);
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
    "    proxy: false",
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

function pnpmPing(registryUrl) {
  if (!executableExists("pnpm")) {
    return false;
  }
  const result = commandResult([
    "pnpm",
    "ping",
    "--registry",
    registryUrl,
  ], { timeout: 3000 });
  return !result.error && result.status === 0;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function installVerdaccioRuntime() {
  const result = captureLocalCommand("bash", [VERDACCIO_RUNTIME_INSTALLER], {
    cwd: ROOT,
    label: "Verdaccio runtime installer",
  });
  if (result.error) {
    fail(TOOL, `Verdaccio runtime installer failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    fail(
      TOOL,
      `Verdaccio runtime installer failed with exit code ${result.status ?? 1}${detail ? `: ${detail}` : ""}`,
    );
  }
}

async function ensureVerdaccio(root, port, dryRun) {
  const registryUrl = `http://127.0.0.1:${port}`;
  const { config, changed } = writeVerdaccioConfig(root, port);
  if (changed && !dryRun) {
    stopRecordedVerdaccio(root);
  }
  if (pnpmPing(registryUrl)) {
    return registryUrl;
  }
  if (dryRun) {
    return registryUrl;
  }

  requireCommand("pnpm");
  installVerdaccioRuntime();
  const logPath = path.join(root, "verdaccio.log");
  mkdirSync(path.dirname(logPath), { recursive: true });
  const log = openSync(logPath, "a");
  const child = spawn(
    "pnpm",
    ["--dir", VERDACCIO_RUNTIME_ROOT, "exec", "verdaccio", "--config", config, "--listen", registryUrl],
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
    if (pnpmPing(registryUrl)) {
      return registryUrl;
    }
    if (child.exitCode !== null) {
      fail(TOOL, `Verdaccio exited early; see ${rel(logPath)}`);
    }
    await sleep(1000);
  }
  fail(TOOL, `Timed out waiting for Verdaccio; see ${rel(logPath)}`);
}

function pnpmRegistryEnv(registryUrl, npmrc = null) {
  return {
    ...process.env,
    NPM_CONFIG_FETCH_RETRIES: "0",
    NPM_CONFIG_LOGLEVEL: "error",
    NPM_CONFIG_PROVENANCE: "false",
    NPM_CONFIG_REGISTRY: registryUrl,
    ...(npmrc === null ? {} : { NPM_CONFIG_USERCONFIG: npmrc }),
  };
}

function pnpmAuthIsValid(registryUrl, npmrc) {
  const result = commandResult(["pnpm", "whoami"], {
    env: pnpmRegistryEnv(registryUrl, npmrc),
    timeout: 10000,
  });
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
    if (pnpmAuthIsValid(registryUrl, npmrc)) {
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
  const result = commandResult(["pnpm", "view", `${name}@${version}`, "version"], {
    env: pnpmRegistryEnv(registryUrl, npmrc),
    timeout: 10000,
  });
  return !result.error && result.status === 0 && result.stdout.trim() === version;
}

function runPnpmRegistryCommand(args, registryUrl, npmrc) {
  const result = captureLocalCommand("pnpm", args, {
    cwd: ROOT,
    env: pnpmRegistryEnv(registryUrl, npmrc),
    label: `pnpm ${args.join(" ")}`,
  });
  if (result.error) {
    fail(TOOL, `pnpm failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    fail(
      TOOL,
      `pnpm ${args[0] ?? "registry command"} failed with exit code ${result.status ?? 1}`
        + `${detail ? `: ${detail}` : ""}`,
      result.status ?? 1,
    );
  }
}

async function publishNpmTarballs(
  roots,
  registryRoot,
  strict,
  port,
  { iosBaseAssetDir } = {},
) {
  const result = surfaceResult("npm");
  const generatedTarballs = stageReleaseAssetNpmPackages(roots, registryRoot, result, strict);
  const extensionTarballRoot = stageExtensionNpmPackages(
    roots,
    path.join(registryRoot, "npm-extension-packages"),
    hostNpmTarget(),
    result,
    {
      baseAssetDir: iosBaseAssetDir,
      metaTargetsForProduct: (product) =>
        canonicalExtensionNpmTargets(product),
    },
  );
  const npmRoots = extensionTarballRoot === null ? roots : [...roots, extensionTarballRoot];

  const tarballs = selectNpmTarballs([...discoverFiles(npmRoots, [".tgz"]), ...generatedTarballs], registryRoot, result);
  if (tarballs.length === 0) {
    addSkip(result, "no npm .tgz artifacts found", strict);
    return result;
  }
  for (const tarball of tarballs) {
    const size = statSync(tarball).size;
    if (size > NPM_PACKAGE_SAFETY_LIMIT_BYTES) {
      addSkip(result, `${rel(tarball)} is ${size} bytes, exceeding the 100 MiB npm release safety limit`, strict);
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
        "unpublish",
        `${identity.name}@${identity.version}`,
        "--force",
      ];
      runPnpmRegistryCommand(command, registryUrl, npmrc);
      result.staged.push(`replaced ${identity.name}@${identity.version}`);
    }
    const command = [
      "publish",
      tarball,
      "--ignore-scripts",
      "--access",
      "public",
      "--no-git-checks",
    ];
    runPnpmRegistryCommand(command, registryUrl, npmrc);
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
        process.execPath,
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
      process.execPath,
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
      process.execPath,
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

export function cargoPackageIdentityFromCrate(cratePath) {
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
    if (
      typeof packageData?.name === "string"
      && packageData.name
      && typeof packageData?.version === "string"
      && packageData.version
    ) {
      return { name: packageData.name, version: packageData.version };
    }
    return null;
  } catch {
    return null;
  }
}

function cargoPackageNameFromCrate(cratePath) {
  return cargoPackageIdentityFromCrate(cratePath)?.name ?? null;
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
  const releaseSourceRoot = path.join(registryRoot, "cargo-generated", "release-sources");
  const buildManifest = prepareOliphauntBuildReleaseSource({
    stageDir: path.join(releaseSourceRoot, "oliphaunt-build"),
    log: false,
  });
  const buildCrate = manualCargoPackageSource(buildManifest, outputDir, packageOptions);
  assertReleaseNoticesInArchive(buildCrate, {
    profile: "source-sdk",
    prefix: path.basename(buildCrate, ".crate"),
  });
  generated.push(buildCrate);

  const oliphauntManifest = prepareRustReleaseSource({
    stageDir: path.join(releaseSourceRoot, "oliphaunt"),
    log: false,
  });
  const availablePackageNames = cargoPackageNamesFromRoots(roots);
  const nativeSourceRoot = path.join(ROOT, "target/liboliphaunt/cargo-package-sources");
  const nativeRuntimePublicManifests = nativeRuntimeArtifactManifests(nativeSourceRoot);
  const nativeRuntimeAllManifests = nativeRuntimeArtifactManifests(nativeSourceRoot, { includeParts: true });
  for (const manifest of nativeRuntimePublicManifests) {
    availablePackageNames.add(readCargoPackageNameVersion(manifest, { fail: localFail, rel }).name);
  }
  pruneMissingLocalArtifactTargetDependencies(oliphauntManifest, availablePackageNames, result, strict);
  const oliphauntCrate = manualCargoPackageSource(oliphauntManifest, outputDir, packageOptions);
  assertReleaseNoticesInArchive(oliphauntCrate, {
    profile: "source-sdk",
    prefix: path.basename(oliphauntCrate, ".crate"),
  });
  generated.push(oliphauntCrate);

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

function cargoMetadataTempDir() {
  // Keep the extraction on the checkout's filesystem/Windows drive, but make
  // it a sibling of the Git root so Cargo cannot discover this repository's
  // workspace while inspecting an immutable registry candidate.
  const parent = path.dirname(ROOT);
  if (parent === ROOT) {
    throw new Error("cannot allocate Cargo metadata scratch outside the repository root");
  }
  return mkdtempSync(path.join(parent, ".oliphaunt-cargo-metadata-"));
}

export function cargoMetadataForCrate(cratePath) {
  const temp = cargoMetadataTempDir();
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

async function publishCargoCrates(
  roots,
  registryRoot,
  strict,
  { exactArtifacts = false, candidateScope = null } = {},
) {
  const result = surfaceResult("cargo");
  if (exactArtifacts) {
    result.staged.push("exact-artifacts mode: generation disabled; indexing only qualified candidate archives");
  } else {
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

  const packageCandidates = [];
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
    packageCandidates.push({
      cratePath,
      packageData,
      checksum: sha256File(cratePath),
    });
  }

  const packagesByTargetName = new Map();
  if (candidateScope !== null) {
    const scoped = selectScopedCargoCandidates(candidateScope, packageCandidates);
    result.skipped.push(...scoped.skipped);
    for (const candidate of scoped.selected) {
      packagesByTargetName.set(
        `${candidate.packageData.name}-${candidate.packageData.version}.crate`,
        [candidate.cratePath, candidate.packageData],
      );
    }
    result.staged.push(
      `selected ${packagesByTargetName.size} exact Cargo candidate archive(s) for ${candidateScope.products.length} release product(s)`,
    );
  } else {
    for (const candidate of packageCandidates) {
      packagesByTargetName.set(
        `${candidate.packageData.name}-${candidate.packageData.version}.crate`,
        [candidate.cratePath, candidate.packageData],
      );
    }
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
    iosBaseAssetDir: undefined,
    registryRoot: path.join(ROOT, "target/local-registries"),
    surfaces: [],
    verdaccioPort: "4873",
    productsJson: undefined,
    exactArtifacts: false,
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
    if (value === "--ios-base-asset-dir") {
      options.iosBaseAssetDir = path.resolve(ROOT, readValue(index, value));
      index += 1;
      continue;
    }
    if (value.startsWith("--ios-base-asset-dir=")) {
      options.iosBaseAssetDir = path.resolve(
        ROOT,
        value.slice("--ios-base-asset-dir=".length),
      );
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
    if (value === "--products-json") {
      options.productsJson = readValue(index, value);
      index += 1;
      continue;
    }
    if (value.startsWith("--products-json=")) {
      options.productsJson = value.slice("--products-json=".length);
      continue;
    }
    if (value === "--exact-artifacts") {
      options.exactArtifacts = true;
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
  if (options.iosBaseAssetDir !== undefined && !options.surfaces.includes("npm")) {
    fail(TOOL, "--ios-base-asset-dir requires --surface npm", 2);
  }
  if (options.exactArtifacts) {
    if (options.surfaces.length !== 1 || options.surfaces[0] !== "cargo") {
      fail(TOOL, "--exact-artifacts requires exactly one --surface cargo", 2);
    }
    if (options.dryRun) {
      fail(TOOL, "--exact-artifacts cannot be combined with --dry-run", 2);
    }
    if (options.productsJson === undefined) {
      fail(TOOL, "--exact-artifacts requires --products-json", 2);
    }
    if (options.artifactRoots.length === 0) {
      fail(TOOL, "--exact-artifacts requires at least one explicit --artifact-root", 2);
    }
    options.strict = true;
  } else if (options.productsJson !== undefined) {
    fail(TOOL, "--products-json is supported only with --exact-artifacts", 2);
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
  if (options.exactArtifacts) {
    const missingRoots = options.artifactRoots
      .map((root) => path.resolve(ROOT, root))
      .filter((root) => !existsSync(root));
    if (missingRoots.length > 0) {
      fail(TOOL, `exact artifact roots do not exist: ${missingRoots.map(rel).join(", ")}`, 2);
    }
  }
  const roots = discoverRoots(options.artifactRoots);
  if (
    options.iosBaseAssetDir !== undefined
    && (
      !isDirectory(options.iosBaseAssetDir)
      || !roots.some((root) => pathIsUnder(options.iosBaseAssetDir, root))
    )
  ) {
    fail(
      TOOL,
      "--ios-base-asset-dir must be a directory within an explicit artifact root",
      2,
    );
  }
  if (!canPublishInBun(options, roots)) {
    fail(TOOL, "publish surface is not implemented in the Bun local-registry entrypoint", 2);
  }
  mkdirSync(options.registryRoot, { recursive: true });
  let candidateScope = null;
  if (options.productsJson !== undefined) {
    try {
      candidateScope = createCargoCandidateScope(parseCargoCandidateProductsJson(options.productsJson));
    } catch (error) {
      fail(TOOL, error.message.replace(`${TOOL}: `, ""), 2);
    }
  }
  const results = [];
  for (const surface of options.surfaces) {
    if (surface === "cargo") {
      results.push(options.dryRun
        ? publishCargoDryRun(roots, options.strict)
        : await publishCargoCrates(roots, options.registryRoot, options.strict, {
          exactArtifacts: options.exactArtifacts,
          candidateScope,
        }));
    } else if (surface === "npm") {
      requireCommand("pnpm");
      results.push(options.dryRun
        ? publishNpmDryRun(roots, options.registryRoot, options.strict, options.verdaccioPort)
        : await publishNpmTarballs(
          roots,
          options.registryRoot,
          options.strict,
          options.verdaccioPort,
          { iosBaseAssetDir: options.iosBaseAssetDir },
        ));
    } else if (surface === "maven") {
      results.push(publishMaven(roots, options.registryRoot, options.dryRun, options.strict));
    } else if (surface === "swift") {
      results.push(publishSwift(roots, options.registryRoot, options.dryRun, options.strict));
    }
  }
  const report = {
    artifact_roots: roots,
    ios_base_asset_dir: options.iosBaseAssetDir ?? null,
    exact_artifacts: options.exactArtifacts,
    dry_run: options.dryRun,
    products: candidateScope?.products ?? null,
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
  console.log(`usage: local-registry-publish.mjs publish [-h] [--artifact-root ARTIFACT_ROOT] [--registry-root REGISTRY_ROOT] [--surface {npm,cargo,maven,swift}] [--verdaccio-port VERDACCIO_PORT] [--products-json JSON] [--exact-artifacts] [--dry-run] [--strict]

options:
  -h, --help            show this help message and exit
  --artifact-root ARTIFACT_ROOT
  --ios-base-asset-dir IOS_BASE_ASSET_DIR
                        exact Apple base-carrier directory within an artifact root
  --registry-root REGISTRY_ROOT
  --surface {npm,cargo,maven,swift}
                        publish only this surface; may be repeated
  --verdaccio-port VERDACCIO_PORT
  --products-json JSON  exact release product selection (requires --exact-artifacts)
  --exact-artifacts     index only supplied .crate archives; disable package generation
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
    download_contract: {
      default_workflow: DEFAULT_WORKFLOW,
      exact_commit_sha_required: true,
      transactional_destination: true,
    },
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

if (import.meta.main) {
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
}
