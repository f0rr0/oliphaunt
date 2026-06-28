#!/usr/bin/env bun
import { spawn, spawnSync } from "node:child_process";
import {
  accessSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
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
import { fail, ROOT, run } from "./release-cli-utils.mjs";

const TOOL = "local-registry-publish.mjs";
const DEFAULT_RUN_ID = "28049923289";
const DEFAULT_REPO = "f0rr0/oliphaunt";
const DEFAULT_CURRENT_ARTIFACT_ROOT = path.join(ROOT, "target/local-registry-current");
const DEFAULT_ARTIFACT_ROOT = path.join(ROOT, "target/local-registry-artifacts");
const NPM_PACKAGE_SIZE_LIMIT_BYTES = 10 * 1024 * 1024;
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

function runQuiet(args) {
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

function extensionNpmPackage(sqlName) {
  return `@oliphaunt/extension-${sqlName.replaceAll("_", "-")}`;
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
  const manifests = discoverExtensionManifests(roots);
  if (manifests.length > 0) {
    return true;
  }
  for (const root of roots) {
    if (!statSync(root).isDirectory()) {
      continue;
    }
    for (const file of walkFiles(root)) {
      const name = path.basename(file);
      if (
        /^(liboliphaunt|oliphaunt-tools)-[^/]+\.(tar\.gz|zip)$/u.test(name) ||
        /^oliphaunt-broker-[^/]+\.(tar\.gz|zip)$/u.test(name)
      ) {
        return true;
      }
    }
  }
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
  result.skipped.push("no liboliphaunt release assets found for native npm artifact packages");
  result.skipped.push("no broker release assets found for broker npm artifact packages");
  if (discoverExtensionManifests(roots).length === 0) {
    result.skipped.push("no extension-artifacts.json manifests found for npm extension packages");
  }

  const tarballs = selectNpmTarballs(discoverFiles(roots, [".tgz"]), registryRoot, result);
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
        (surface === "cargo" && options.dryRun) ||
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
    run(TOOL, ["python3", "tools/release/local_registry_publish.py", "publish", ...argv]);
    return;
  }
  mkdirSync(options.registryRoot, { recursive: true });
  const results = [];
  for (const surface of options.surfaces) {
    if (surface === "cargo") {
      results.push(publishCargoDryRun(roots, options.strict));
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
