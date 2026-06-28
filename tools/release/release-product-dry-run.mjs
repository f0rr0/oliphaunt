#!/usr/bin/env bun
import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
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
const NODE_DIRECT_PRODUCT = "oliphaunt-node-direct";
const NODE_DIRECT_KIND = "node-direct-addon";
const NODE_DIRECT_PACKAGE_ROOT = path.join(ROOT, "src/runtimes/node-direct/packages");

export const SUPPORTED_BUN_PRODUCT_DRY_RUNS = new Set([
  ...SUPPORTED_SDK_PRODUCT_DRY_RUNS,
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

function nodeDirectOptionalPackageTargets(version) {
  const packageDirs = npmPackageDirsUnder(NODE_DIRECT_PACKAGE_ROOT);
  const packages = [];
  for (const target of artifactTargets(NODE_DIRECT_PRODUCT, NODE_DIRECT_KIND, TOOL)) {
    const packageName = target.npm_package;
    if (typeof packageName !== "string" || packageName.length === 0) {
      fail(`${target.id} must declare npm_package for npm optional package publication`);
    }
    const packageDir = packageDirs.get(packageName);
    if (packageDir === undefined) {
      fail(`${target.id} declares unknown Node direct npm package ${packageName}`);
    }
    const packageJson = JSON.parse(readFileSync(path.join(packageDir, "package.json"), "utf8"));
    if (packageJson.name !== packageName) {
      fail(`${rel(packageDir)}/package.json name must be ${packageName}`);
    }
    if (packageJson.version !== version) {
      fail(`${packageName} package version must match ${NODE_DIRECT_PRODUCT} ${version}`);
    }
    packages.push([packageName, packageDir, target]);
  }
  const expected = packages.map(([packageName]) => packageName).sort(compareText);
  const actual = [...packageDirs.keys()].sort(compareText);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail("Node direct npm optional package metadata must match published artifact targets exactly");
  }
  return packages.sort((left, right) => compareText(left[0], right[0]));
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
    const size = parseTarOctal(header, 124, 12);
    const type = header.subarray(156, 157).toString("utf8");
    entries.set(name, { size, isFile: type === "" || type === "0" });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
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

export async function runBunProductDryRun(product, { allowDirty = false } = {}) {
  if (SUPPORTED_SDK_PRODUCT_DRY_RUNS.has(product)) {
    await runSdkProductDryRun(product, { allowDirty });
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
