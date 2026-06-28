#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";

import { ROOT, run } from "./release-cli-utils.mjs";
import {
  SUPPORTED_SDK_PRODUCT_DRY_RUNS,
  runSdkProductDryRun,
} from "./release-sdk-product-dry-run.mjs";
import {
  artifactTargets,
  compareText,
  currentProductVersionSync,
} from "./release-artifact-targets.mjs";

const TOOL = "release-product-dry-run.mjs";
const BROKER_PRODUCT = "oliphaunt-broker";
const BROKER_KIND = "broker-helper";
const BROKER_PACKAGE_ROOT = path.join(ROOT, "src/runtimes/broker/packages");
const NODE_DIRECT_PRODUCT = "oliphaunt-node-direct";
const NODE_DIRECT_KIND = "node-direct-addon";
const NODE_DIRECT_PACKAGE_ROOT = path.join(ROOT, "src/runtimes/node-direct/packages");

export const SUPPORTED_BUN_PRODUCT_DRY_RUNS = new Set([
  ...SUPPORTED_SDK_PRODUCT_DRY_RUNS,
  BROKER_PRODUCT,
  NODE_DIRECT_PRODUCT,
]);

function fail(message, exitCode = 1) {
  console.error(`${TOOL}: ${message}`);
  process.exit(exitCode);
}

function rel(file) {
  return path.relative(ROOT, file).split(path.sep).join("/");
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

function commandOutput(command, args, { cwd = ROOT, encoding = "utf8" } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding,
    maxBuffer: 100 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error !== undefined) {
    fail(`${command} failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const stderr = Buffer.isBuffer(result.stderr) ? result.stderr.toString("utf8") : result.stderr;
    fail(`${command} ${args.join(" ")} failed${stderr ? `: ${stderr.trim()}` : ""}`);
  }
  return result.stdout;
}

function stagedRuntimeInputDirs(envName) {
  const raw = process.env[envName] ?? process.env.OLIPHAUNT_RELEASE_ASSET_INPUT_DIRS ?? "";
  return raw
    .split(path.delimiter)
    .filter(Boolean)
    .map((item) => {
      const expanded = item === "~" || item.startsWith("~/")
        ? path.join(process.env.HOME ?? "", item.slice(1))
        : item;
      return path.isAbsolute(expanded) ? expanded : path.join(ROOT, expanded);
    });
}

function globRegex(pattern) {
  return new RegExp(`^${pattern.split("*").map(escapeRegExp).join(".*")}$`, "u");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function copyStagedRuntimeAssets({
  product,
  destination,
  envName,
  patterns,
}) {
  const sourceDirs = stagedRuntimeInputDirs(envName);
  if (sourceDirs.length === 0) {
    fail(
      `${product} requires staged runtime artifacts; set ${envName} or OLIPHAUNT_RELEASE_ASSET_INPUT_DIRS to the downloaded CI artifact directory`,
    );
  }
  mkdirSync(destination, { recursive: true });
  const regexes = patterns.map(globRegex);
  let copied = 0;
  for (const sourceDir of sourceDirs) {
    if (!isDirectory(sourceDir)) {
      fail(`${product} release asset input directory does not exist: ${sourceDir}`);
    }
    for (const name of readdirSync(sourceDir).sort(compareText)) {
      if (!regexes.some((regex) => regex.test(name))) {
        continue;
      }
      const source = path.join(sourceDir, name);
      if (!isFile(source)) {
        continue;
      }
      const output = path.join(destination, name);
      if (isFile(output)) {
        if (sha256File(output) !== sha256File(source)) {
          fail(`${product} release asset input collision for ${name}: ${rel(output)} and ${rel(source)} have different bytes`);
        }
        continue;
      }
      copyFileSync(source, output);
      copied += 1;
    }
  }
  if (copied === 0) {
    fail(`${product} found no staged runtime artifacts matching ${JSON.stringify(patterns)} under ${JSON.stringify(sourceDirs)}`);
  }
}

function hasNodeDirectReleaseArchive(assetDir) {
  if (!isDirectory(assetDir)) {
    return false;
  }
  return readdirSync(assetDir).some((name) =>
    name.startsWith("oliphaunt-node-direct-") && (name.endsWith(".tar.gz") || name.endsWith(".zip")),
  );
}

function hasBrokerReleaseArchive(assetDir) {
  if (!isDirectory(assetDir)) {
    return false;
  }
  return readdirSync(assetDir).some((name) =>
    name.startsWith("oliphaunt-broker-") && (name.endsWith(".tar.gz") || name.endsWith(".zip")),
  );
}

function ensureBrokerReleaseAssets() {
  const assetDir = path.join(ROOT, "target/oliphaunt-broker/release-assets");
  if (!hasBrokerReleaseArchive(assetDir)) {
    copyStagedRuntimeAssets({
      product: BROKER_PRODUCT,
      destination: assetDir,
      envName: "OLIPHAUNT_BROKER_RELEASE_ASSET_INPUT_DIRS",
      patterns: ["oliphaunt-broker-*.tar.gz", "oliphaunt-broker-*.zip"],
    });
  }
  const version = currentProductVersionSync(BROKER_PRODUCT, TOOL);
  run(TOOL, [
    "tools/dev/bun.sh",
    "tools/release/write_checksum_manifest.mjs",
    "--asset-dir",
    rel(assetDir),
    "--output",
    `oliphaunt-broker-${version}-release-assets.sha256`,
    "--pattern",
    "oliphaunt-broker-*.tar.gz",
    "--pattern",
    "oliphaunt-broker-*.zip",
  ]);
  run(TOOL, [
    "tools/dev/bun.sh",
    "tools/release/check-broker-release-assets.mjs",
    "--asset-dir",
    rel(assetDir),
  ]);
}

function ensureNodeDirectReleaseAssets() {
  const assetDir = path.join(ROOT, "target/oliphaunt-node-direct/release-assets");
  if (!hasNodeDirectReleaseArchive(assetDir)) {
    copyStagedRuntimeAssets({
      product: NODE_DIRECT_PRODUCT,
      destination: assetDir,
      envName: "OLIPHAUNT_NODE_ADDON_ASSET_INPUT_DIRS",
      patterns: ["oliphaunt-node-direct-*.tar.gz", "oliphaunt-node-direct-*.zip"],
    });
  }
  const version = currentProductVersionSync(NODE_DIRECT_PRODUCT, TOOL);
  run(TOOL, [
    "tools/dev/bun.sh",
    "tools/release/write_checksum_manifest.mjs",
    "--asset-dir",
    rel(assetDir),
    "--output",
    `oliphaunt-node-direct-${version}-release-assets.sha256`,
    "--pattern",
    "oliphaunt-node-direct-*.tar.gz",
    "--pattern",
    "oliphaunt-node-direct-*.zip",
  ]);
  run(TOOL, [
    "tools/dev/bun.sh",
    "tools/release/check-node-direct-release-assets.mjs",
    "--asset-dir",
    rel(assetDir),
  ]);
}

function npmPackageDirsUnder(packageRoot) {
  const packages = new Map();
  if (!isDirectory(packageRoot)) {
    fail(`${rel(packageRoot)} does not contain npm package descriptors`);
  }
  for (const packageDirName of readdirSync(packageRoot).sort(compareText)) {
    const packageDir = path.join(packageRoot, packageDirName);
    const packageJsonPath = path.join(packageDir, "package.json");
    if (!isFile(packageJsonPath)) {
      continue;
    }
    let packageJson;
    try {
      packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    } catch (error) {
      fail(`${rel(packageJsonPath)} is not valid JSON: ${error.message}`);
    }
    const packageName = packageJson.name;
    if (typeof packageName !== "string" || packageName.length === 0) {
      fail(`${rel(packageJsonPath)} must declare name`);
    }
    if (packages.has(packageName)) {
      fail(`duplicate npm package name ${packageName} in ${rel(packages.get(packageName))} and ${rel(packageDir)}`);
    }
    packages.set(packageName, packageDir);
  }
  if (packages.size === 0) {
    fail(`${rel(packageRoot)} does not contain npm package descriptors`);
  }
  return packages;
}

function artifactNpmPackageTargets({
  product,
  kind,
  surface,
  packageRoot,
  version,
}) {
  const packageDirs = npmPackageDirsUnder(packageRoot);
  const packages = [];
  for (const target of artifactTargets(product, kind, TOOL).filter((candidate) => candidate.surfaces.includes(surface))) {
    const packageName = target.npm_package;
    if (typeof packageName !== "string" || packageName.length === 0) {
      fail(`${target.id} must declare npm_package for npm artifact package publication`);
    }
    const packageDir = packageDirs.get(packageName);
    if (packageDir === undefined) {
      fail(`${target.id} declares unknown npm package ${packageName}`);
    }
    const packageJson = JSON.parse(readFileSync(path.join(packageDir, "package.json"), "utf8"));
    if (packageJson.name !== packageName) {
      fail(`${rel(packageDir)}/package.json name must be ${packageName}`);
    }
    if (packageJson.version !== version) {
      fail(`${packageName} package version must match ${product} ${version}`);
    }
    packages.push([packageName, packageDir, target]);
  }
  const expected = packages.map(([packageName]) => packageName).sort(compareText);
  const actual = [...packageDirs.keys()].sort(compareText);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`${rel(packageRoot)} package descriptors must match published ${product} npm artifact targets for ${surface}`);
  }
  return packages.sort((left, right) => compareText(left[0], right[0]));
}

function nodeDirectOptionalPackageTargets(version) {
  return artifactNpmPackageTargets({
    product: NODE_DIRECT_PRODUCT,
    kind: NODE_DIRECT_KIND,
    surface: "npm-optional",
    packageRoot: NODE_DIRECT_PACKAGE_ROOT,
    version,
  });
}

function brokerNpmPackageTargets(version) {
  return artifactNpmPackageTargets({
    product: BROKER_PRODUCT,
    kind: BROKER_KIND,
    surface: "typescript-broker",
    packageRoot: BROKER_PACKAGE_ROOT,
    version,
  });
}

function safeNpmPackageFilenamePrefix(packageName) {
  return packageName.replace(/^@/u, "").replace("/", "-");
}

function nodeDirectNpmPackageDir() {
  return path.join(ROOT, "target/oliphaunt-node-direct/npm-packages");
}

function expectedNodeDirectNpmTarball(packageName, version) {
  return path.join(nodeDirectNpmPackageDir(), `${safeNpmPackageFilenamePrefix(packageName)}-${version}.tgz`);
}

function parseTarString(buffer, start, length) {
  const end = buffer.indexOf(0, start);
  return buffer
    .subarray(start, end >= start && end < start + length ? end : start + length)
    .toString("utf8")
    .trim();
}

function parseTarOctal(buffer, start, length) {
  const text = parseTarString(buffer, start, length).replaceAll("\0", "").trim();
  return text ? Number.parseInt(text, 8) : 0;
}

function readTarGzMember(file, expectedName) {
  const buffer = gunzipSync(readFileSync(file));
  for (let offset = 0; offset + 512 <= buffer.length;) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      break;
    }
    const rawName = parseTarString(header, 0, 100);
    const prefix = parseTarString(header, 345, 155);
    const name = prefix ? `${prefix}/${rawName}` : rawName;
    const size = parseTarOctal(header, 124, 12);
    const dataOffset = offset + 512;
    if (name === expectedName) {
      return buffer.subarray(dataOffset, dataOffset + size);
    }
    offset = dataOffset + Math.ceil(size / 512) * 512;
  }
  return null;
}

function readTarGzEntries(file) {
  const buffer = gunzipSync(readFileSync(file));
  const entries = new Map();
  for (let offset = 0; offset + 512 <= buffer.length;) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      break;
    }
    const rawName = parseTarString(header, 0, 100);
    const prefix = parseTarString(header, 345, 155);
    const name = prefix ? `${prefix}/${rawName}` : rawName;
    const mode = parseTarOctal(header, 100, 8);
    const size = parseTarOctal(header, 124, 12);
    const type = header.subarray(156, 157).toString("utf8");
    entries.set(name, { mode, size, isFile: type === "" || type === "0" });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

function validateNoConsumerInstallScripts(packageJson, context) {
  const scripts = packageJson.scripts;
  if (scripts === undefined) {
    return;
  }
  if (scripts === null || typeof scripts !== "object" || Array.isArray(scripts)) {
    fail(`${context} scripts must be an object when present`);
  }
  for (const scriptName of ["preinstall", "install", "postinstall", "prepare"]) {
    if (Object.hasOwn(scripts, scriptName)) {
      fail(`${context} must not declare consumer install lifecycle script ${scriptName}`);
    }
  }
}

function npmPackageSourceStageDir(packageName) {
  return path.join(ROOT, "target/release/npm-package-sources", safeNpmPackageFilenamePrefix(packageName));
}

function stageNpmPackageDescriptor(packageName, sourceDir, version, { target = null } = {}) {
  const stageDir = npmPackageSourceStageDir(packageName);
  rmSync(stageDir, { recursive: true, force: true });
  mkdirSync(stageDir, { recursive: true });
  for (const descriptor of ["package.json", "README.md"]) {
    const source = path.join(sourceDir, descriptor);
    if (!isFile(source)) {
      fail(`${rel(sourceDir)} is missing ${descriptor}`);
    }
    copyFileSync(source, path.join(stageDir, descriptor));
  }
  const packageJsonPath = path.join(stageDir, "package.json");
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  if (packageJson.name !== packageName) {
    fail(`${rel(packageJsonPath)} name must be ${packageName}`);
  }
  if (packageJson.version !== version) {
    fail(`${packageName} package version must match ${version}`);
  }
  if (target !== null && packageJson.oliphaunt?.target !== target) {
    fail(`${packageName} package oliphaunt.target must be ${target}`);
  }
  validateNoConsumerInstallScripts(packageJson, `${packageName} npm package`);
  return stageDir;
}

function readReleaseArchiveMember(archive, memberName) {
  if (archive.endsWith(".tar.gz")) {
    for (const candidate of [memberName, `./${memberName}`]) {
      const data = readTarGzMember(archive, candidate);
      if (data !== null) {
        return data;
      }
    }
    fail(`${rel(archive)} is missing ${memberName}`);
  }
  if (path.extname(archive) === ".zip") {
    for (const candidate of [memberName, `./${memberName}`]) {
      const result = spawnSync("unzip", ["-p", archive, candidate], {
        cwd: ROOT,
        encoding: "buffer",
        maxBuffer: 100 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      });
      if (result.error !== undefined) {
        fail(`unzip failed to start: ${result.error.message}`);
      }
      if (result.status === 0) {
        return result.stdout;
      }
    }
    fail(`${rel(archive)} is missing ${memberName}`);
  }
  fail(`${rel(archive)} has unsupported release archive extension`);
}

function extractReleaseArchiveFile(archive, memberName, destination, { mode = null } = {}) {
  const data = readReleaseArchiveMember(archive, memberName);
  mkdirSync(path.dirname(destination), { recursive: true });
  writeFileSync(destination, data);
  if (mode !== null) {
    chmodSync(destination, mode);
  }
}

function pnpmPackForNpmPublish(packageDir) {
  const packageJson = JSON.parse(readFileSync(path.join(packageDir, "package.json"), "utf8"));
  const packageName = packageJson.name;
  if (typeof packageName !== "string" || packageName.length === 0) {
    fail(`${rel(packageDir)}/package.json must declare a package name`);
  }
  const packDir = path.join(ROOT, "target/release/npm-packages", safeNpmPackageFilenamePrefix(packageName));
  rmSync(packDir, { recursive: true, force: true });
  mkdirSync(packDir, { recursive: true });
  const rendered = commandOutput("pnpm", ["pack", "--pack-destination", packDir, "--json"], { cwd: packageDir });
  let manifest;
  try {
    manifest = JSON.parse(rendered);
  } catch (error) {
    fail(`pnpm pack for ${packageName} did not emit JSON: ${error.message}`);
  }
  const filename = Array.isArray(manifest) ? manifest[0]?.filename : manifest?.filename;
  if (typeof filename !== "string" || !filename.endsWith(".tgz")) {
    fail(`pnpm pack for ${packageName} did not report a .tgz filename`);
  }
  const tarball = path.isAbsolute(filename) ? filename : path.join(packDir, filename);
  if (!isFile(tarball)) {
    fail(`pnpm pack for ${packageName} did not create ${rel(tarball)}`);
  }
  return tarball;
}

function validatePackedNpmPackage({
  packageName,
  version,
  tarball,
  requiredMembers,
  executableMembers = [],
}) {
  let entries;
  try {
    entries = readTarGzEntries(tarball);
  } catch (error) {
    fail(`${rel(tarball)} is not a valid npm tarball: ${error.message}`);
  }
  if (!entries.has("package/package.json")) {
    fail(`${rel(tarball)} is missing package/package.json`);
  }
  let packageJson;
  try {
    const packageData = readTarGzMember(tarball, "package/package.json");
    if (packageData === null) {
      fail(`${rel(tarball)} package/package.json could not be read`);
    }
    packageJson = JSON.parse(packageData.toString("utf8"));
  } catch (error) {
    fail(`${rel(tarball)} package/package.json is not valid JSON: ${error.message}`);
  }
  if (packageJson.name !== packageName) {
    fail(`${rel(tarball)} package name must be ${packageName}, got ${JSON.stringify(packageJson.name)}`);
  }
  if (packageJson.version !== version) {
    fail(`${rel(tarball)} package version must be ${version}, got ${JSON.stringify(packageJson.version)}`);
  }
  for (const member of requiredMembers) {
    const entry = entries.get(member);
    if (entry === undefined) {
      fail(`${rel(tarball)} is missing ${member}`);
    }
    if (!entry.isFile || entry.size <= 0) {
      fail(`${rel(tarball)} ${member} must be a non-empty regular file`);
    }
  }
  for (const member of executableMembers) {
    const entry = entries.get(member);
    if (entry === undefined) {
      fail(`${rel(tarball)} is missing executable ${member}`);
    }
    if (!entry.isFile || entry.size <= 0 || (entry.mode & 0o111) === 0) {
      fail(`${rel(tarball)} ${member} must be a non-empty executable file`);
    }
  }
}

function brokerNpmTarballs(version) {
  const tarballs = [];
  const assetDir = path.join(ROOT, "target/oliphaunt-broker/release-assets");
  for (const [packageName, packageDir, target] of brokerNpmPackageTargets(version)) {
    const executableRelativePath = target.executable_relative_path;
    if (typeof executableRelativePath !== "string" || executableRelativePath.length === 0) {
      fail(`${target.id} must declare executable_relative_path for npm artifact package publication`);
    }
    const stageDir = stageNpmPackageDescriptor(packageName, packageDir, version, { target: target.target });
    const archive = path.join(assetDir, target.asset.replaceAll("{version}", version));
    extractReleaseArchiveFile(archive, executableRelativePath, path.join(stageDir, executableRelativePath), { mode: 0o755 });
    const tarball = pnpmPackForNpmPublish(stageDir);
    const requiredMembers = [`package/${executableRelativePath}`];
    validatePackedNpmPackage({
      packageName,
      version,
      tarball,
      requiredMembers,
      executableMembers: requiredMembers,
    });
    tarballs.push([packageName, tarball]);
  }
  return tarballs;
}

async function validateNodeDirectOptionalTarball(packageName, version, tarball) {
  if (!isFile(tarball)) {
    fail(`missing Node direct optional npm package artifact: ${rel(tarball)}`);
  }
  let entries;
  try {
    entries = readTarGzEntries(tarball);
  } catch (error) {
    fail(`${rel(tarball)} is not a valid Node direct optional npm tarball: ${error.message}`);
  }
  for (const required of ["package/package.json", "package/prebuilds/oliphaunt_node.node"]) {
    if (!entries.has(required)) {
      fail(`${rel(tarball)} is missing ${required}`);
    }
  }
  const prebuild = entries.get("package/prebuilds/oliphaunt_node.node");
  if (!prebuild.isFile || prebuild.size <= 0) {
    fail(`${rel(tarball)} prebuilt addon must be a non-empty regular file`);
  }
  let packageJson;
  try {
    const packageData = readTarGzMember(tarball, "package/package.json");
    if (packageData === null) {
      fail(`${rel(tarball)} package/package.json could not be read`);
    }
    packageJson = JSON.parse(packageData.toString("utf8"));
  } catch (error) {
    fail(`${rel(tarball)} package/package.json is not valid JSON: ${error.message}`);
  }
  if (packageJson.name !== packageName) {
    fail(`${rel(tarball)} package name must be ${packageName}, got ${JSON.stringify(packageJson.name)}`);
  }
  if (packageJson.version !== version) {
    fail(`${rel(tarball)} package version must be ${version}, got ${JSON.stringify(packageJson.version)}`);
  }
}

async function nodeDirectOptionalNpmTarballs(version) {
  const tarballs = [];
  for (const [packageName] of nodeDirectOptionalPackageTargets(version)) {
    const tarball = expectedNodeDirectNpmTarball(packageName, version);
    await validateNodeDirectOptionalTarball(packageName, version, tarball);
    tarballs.push([packageName, tarball]);
  }
  const expected = new Set(tarballs.map(([, tarball]) => path.resolve(tarball)));
  const unexpected = isDirectory(nodeDirectNpmPackageDir())
    ? readdirSync(nodeDirectNpmPackageDir())
      .filter((name) => name.endsWith(".tgz"))
      .map((name) => path.join(nodeDirectNpmPackageDir(), name))
      .filter((file) => !expected.has(path.resolve(file)))
      .map((file) => path.basename(file))
      .sort(compareText)
    : [];
  if (unexpected.length > 0) {
    fail(`unexpected Node direct optional npm package artifact(s): ${unexpected.join(", ")}`);
  }
  return tarballs;
}

async function runNodeDirectDryRun() {
  run(TOOL, ["src/runtimes/node-direct/tools/check-package.sh", "package-shape"]);
  ensureNodeDirectReleaseAssets();
  await nodeDirectOptionalNpmTarballs(currentProductVersionSync(NODE_DIRECT_PRODUCT, TOOL));
}

function runBrokerDryRun() {
  const version = currentProductVersionSync(BROKER_PRODUCT, TOOL);
  ensureBrokerReleaseAssets();
  brokerNpmTarballs(version);
  run(TOOL, [
    "tools/dev/bun.sh",
    "tools/release/package_broker_cargo_artifacts.mjs",
    "--version",
    version,
    "--output-dir",
    "target/oliphaunt-broker/cargo-artifacts",
  ]);
}

export async function runBunProductDryRun(product, { allowDirty = false } = {}) {
  if (SUPPORTED_SDK_PRODUCT_DRY_RUNS.has(product)) {
    await runSdkProductDryRun(product, { allowDirty });
    return;
  }
  if (product === BROKER_PRODUCT) {
    runBrokerDryRun();
    return;
  }
  if (product === NODE_DIRECT_PRODUCT) {
    await runNodeDirectDryRun();
    return;
  }
  fail(`no Bun publish dry-run handler for ${product}`, 2);
}

function usage() {
  console.log(`usage: tools/release/release-product-dry-run.mjs --product PRODUCT [--allow-dirty]

Runs Bun-owned product publish dry-run checks. Release-wide checks and registry
dependency checks are owned by release-publish.mjs before this helper is invoked
from the public publish dry-run command surface.
`);
}

function parseArgs(argv) {
  const args = {
    allowDirty: false,
    product: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--allow-dirty") {
      args.allowDirty = true;
    } else if (arg === "--product") {
      const value = argv[index + 1];
      if (!value) {
        usage();
        fail("--product requires a value", 2);
      }
      args.product = value;
      index += 1;
    } else if (arg.startsWith("--product=")) {
      args.product = arg.slice("--product=".length);
    } else if (arg === "-h" || arg === "--help") {
      usage();
      process.exit(0);
    } else {
      usage();
      fail(`unknown argument ${arg}`, 2);
    }
  }
  if (args.product === null) {
    usage();
    fail("--product is required", 2);
  }
  return args;
}

if (import.meta.main) {
  const args = parseArgs(Bun.argv.slice(2));
  await runBunProductDryRun(args.product, { allowDirty: args.allowDirty });
}
