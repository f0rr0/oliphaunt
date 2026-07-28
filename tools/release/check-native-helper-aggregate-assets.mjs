#!/usr/bin/env bun
import { readdirSync } from "node:fs";
import path from "node:path";

import {
  ROOT,
  artifactTargets,
  compareText,
  currentProductVersionSync,
  expectedAssets,
} from "./release-artifact-targets.mjs";
import { run } from "./release-cli-utils.mjs";

const TOOL = "check-native-helper-aggregate-assets.mjs";
const BROKER_PRODUCT = "oliphaunt-broker";
const NODE_DIRECT_PRODUCT = "oliphaunt-node-direct";

function fail(message, exitCode = 1) {
  console.error(`${TOOL}: ${message}`);
  process.exit(exitCode);
}

function safeNpmPackageFilenamePrefix(packageName) {
  return packageName.replace(/^@/u, "").replaceAll("/", "-");
}

export function expectedNodeDirectNpmPackageNames(version) {
  return artifactTargets(NODE_DIRECT_PRODUCT, "node-direct-addon", TOOL)
    .map((target) => {
      if (typeof target.npmPackage !== "string" || target.npmPackage.length === 0) {
        throw new Error(`${target.id} must declare its Node direct npm package`);
      }
      return `${safeNpmPackageFilenamePrefix(target.npmPackage)}-${version}.tgz`;
    })
    .sort(compareText);
}

export function assertExactFilenames(actual, expected, label) {
  const actualSorted = [...actual].sort(compareText);
  const expectedSorted = [...expected].sort(compareText);
  if (
    new Set(actualSorted).size !== actualSorted.length
    || JSON.stringify(actualSorted) !== JSON.stringify(expectedSorted)
  ) {
    throw new Error(
      `${label} must be exact: expected=${JSON.stringify(expectedSorted)}, actual=${JSON.stringify(actualSorted)}`,
    );
  }
}

export function exactRegularDirectoryFilenames(directory, label) {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    throw new Error(`cannot inspect ${label} ${directory}: ${error.message}`);
  }
  const invalid = entries
    .filter((entry) => !entry.isFile() || entry.isSymbolicLink())
    .map((entry) => entry.name)
    .sort(compareText);
  if (invalid.length > 0) {
    throw new Error(`${label} must contain only regular non-symlink files: ${invalid.join(", ")}`);
  }
  return entries.map((entry) => entry.name).sort(compareText);
}

function requireExactAssetDirectory(product, kind, assetDir, version) {
  try {
    assertExactFilenames(
      exactRegularDirectoryFilenames(assetDir, `${product} aggregate asset directory`),
      expectedAssets(product, kind, version, TOOL),
      `${product} aggregate asset directory`,
    );
  } catch (error) {
    fail(error.message);
  }
}

function parseArgs(argv) {
  const args = {
    assetDir: null,
    npmPackageDir: null,
    product: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--asset-dir") {
      args.assetDir = argv[index + 1] ?? fail("--asset-dir requires a value", 2);
      index += 1;
    } else if (arg === "--npm-package-dir") {
      args.npmPackageDir = argv[index + 1] ?? fail("--npm-package-dir requires a value", 2);
      index += 1;
    } else if (arg === "--product") {
      args.product = argv[index + 1] ?? fail("--product requires a value", 2);
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        `usage: tools/release/${TOOL} --product <${BROKER_PRODUCT}|${NODE_DIRECT_PRODUCT}> `
        + "[--asset-dir DIR] [--npm-package-dir DIR]",
      );
      process.exit(0);
    } else {
      fail(`unknown argument ${arg}`, 2);
    }
  }
  if (![BROKER_PRODUCT, NODE_DIRECT_PRODUCT].includes(args.product)) {
    fail(`--product must be ${BROKER_PRODUCT} or ${NODE_DIRECT_PRODUCT}`, 2);
  }
  return args;
}

function resolveDir(value, fallback) {
  return path.resolve(value ?? fallback);
}

function rewriteChecksums(product, assetDir, version) {
  const patterns = product === BROKER_PRODUCT
    ? ["oliphaunt-broker-*.tar.gz", "oliphaunt-broker-*.zip"]
    : ["oliphaunt-node-direct-*.tar.gz", "oliphaunt-node-direct-*.zip"];
  const command = [
    process.execPath,
    "tools/release/write_checksum_manifest.mjs",
    "--asset-dir",
    assetDir,
    "--output",
    `${product}-${version}-release-assets.sha256`,
  ];
  for (const pattern of patterns) command.push("--pattern", pattern);
  run(TOOL, command);
}

function nodeDirectNpmPackages(npmPackageDir, version) {
  let names;
  try {
    names = exactRegularDirectoryFilenames(
      npmPackageDir,
      "staged Node direct optional npm package directory",
    );
  } catch (error) {
    fail(error.message);
  }
  try {
    assertExactFilenames(
      names,
      expectedNodeDirectNpmPackageNames(version),
      "staged Node direct optional npm packages",
    );
  } catch (error) {
    fail(error.message);
  }
  return names.map((name) => path.join(npmPackageDir, name));
}

export function main(argv = Bun.argv.slice(2)) {
  const args = parseArgs(argv);
  const version = currentProductVersionSync(args.product, TOOL);
  if (args.product === BROKER_PRODUCT) {
    const assetDir = resolveDir(
      args.assetDir,
      process.env.OLIPHAUNT_BROKER_RELEASE_ASSETS
        ?? path.join(ROOT, "target/oliphaunt-broker/release-assets"),
    );
    requireExactAssetDirectory(args.product, "broker-helper", assetDir, version);
    rewriteChecksums(args.product, assetDir, version);
    run(TOOL, [
      process.execPath,
      "tools/release/check-broker-release-assets.mjs",
      "--asset-dir",
      assetDir,
    ]);
    return;
  }

  const assetDir = resolveDir(
    args.assetDir,
    process.env.OLIPHAUNT_NODE_ADDON_ASSET_OUT_DIR
      ?? path.join(ROOT, "target/oliphaunt-node-direct/release-assets"),
  );
  const npmPackageDir = resolveDir(
    args.npmPackageDir,
    process.env.OLIPHAUNT_NODE_ADDON_NPM_PACKAGE_OUT_DIR
      ?? path.join(ROOT, "target/oliphaunt-node-direct/npm-packages"),
  );
  requireExactAssetDirectory(args.product, "node-direct-addon", assetDir, version);
  rewriteChecksums(args.product, assetDir, version);
  const npmPackages = nodeDirectNpmPackages(npmPackageDir, version);
  run(TOOL, [
    process.execPath,
    "tools/release/check-node-direct-release-assets.mjs",
    "--asset-dir",
    assetDir,
    ...npmPackages.flatMap((npmPackage) => ["--npm-package", npmPackage]),
  ]);
}

if (import.meta.main) main();
