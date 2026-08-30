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
const WASIX_NAPI_PRODUCT = "oliphaunt-wasix-napi";

function fail(message, exitCode = 1) {
  console.error(`${TOOL}: ${message}`);
  process.exit(exitCode);
}

function safeNpmPackageFilenamePrefix(packageName) {
  return packageName.replace(/^@/u, "").replaceAll("/", "-");
}

function expectedOptionalNpmPackageNames(product, kind, version, label) {
  return artifactTargets(product, kind, TOOL)
    .map((target) => {
      if (typeof target.npmPackage !== "string" || target.npmPackage.length === 0) {
        throw new Error(`${target.id} must declare its ${label} npm package`);
      }
      return `${safeNpmPackageFilenamePrefix(target.npmPackage)}-${version}.tgz`;
    })
    .sort(compareText);
}

export function expectedNodeDirectNpmPackageNames(version) {
  return expectedOptionalNpmPackageNames(
    NODE_DIRECT_PRODUCT,
    "node-direct-addon",
    version,
    "Node direct",
  );
}

export function expectedWasixNapiNpmPackageNames(version) {
  return expectedOptionalNpmPackageNames(
    WASIX_NAPI_PRODUCT,
    "wasix-napi-addon",
    version,
    "WASIX Node-API",
  );
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

function requirePreChecksumAssetDirectory(product, kind, assetDir, version) {
  const expected = expectedAssets(product, kind, version, TOOL);
  const payloads = expected.filter((name) => !name.endsWith(".sha256"));
  const checksum = expected.filter((name) => name.endsWith(".sha256"));
  let actual;
  try {
    actual = exactRegularDirectoryFilenames(
      assetDir,
      `${product} aggregate asset directory`,
    );
    const accepted = [payloads, [...payloads, ...checksum]];
    if (!accepted.some((candidate) => {
      const sorted = [...candidate].sort(compareText);
      return JSON.stringify(actual) === JSON.stringify(sorted);
    })) {
      throw new Error(
        `${product} aggregate asset directory must contain the exact target payload set, with at most the replaceable checksum manifest: actual=${JSON.stringify(actual)}`,
      );
    }
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
        `usage: tools/release/${TOOL} --product <${BROKER_PRODUCT}|${NODE_DIRECT_PRODUCT}|${WASIX_NAPI_PRODUCT}> `
        + "[--asset-dir DIR] [--npm-package-dir DIR]",
      );
      process.exit(0);
    } else {
      fail(`unknown argument ${arg}`, 2);
    }
  }
  if (![BROKER_PRODUCT, NODE_DIRECT_PRODUCT, WASIX_NAPI_PRODUCT].includes(args.product)) {
    fail(`--product must be ${BROKER_PRODUCT}, ${NODE_DIRECT_PRODUCT}, or ${WASIX_NAPI_PRODUCT}`, 2);
  }
  return args;
}

function resolveDir(value, fallback) {
  return path.resolve(value ?? fallback);
}

function rewriteChecksums(product, assetDir, version) {
  const stem = product === BROKER_PRODUCT
    ? "oliphaunt-broker"
    : product === NODE_DIRECT_PRODUCT
      ? "oliphaunt-node-direct"
      : "oliphaunt-wasix-napi";
  const patterns = [`${stem}-*.tar.gz`, `${stem}-*.zip`];
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

function optionalNpmPackages(npmPackageDir, expected, label) {
  let names;
  try {
    names = exactRegularDirectoryFilenames(
      npmPackageDir,
      `staged ${label} optional npm package directory`,
    );
  } catch (error) {
    fail(error.message);
  }
  try {
    assertExactFilenames(
      names,
      expected,
      `staged ${label} optional npm packages`,
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
    requirePreChecksumAssetDirectory(args.product, "broker-helper", assetDir, version);
    rewriteChecksums(args.product, assetDir, version);
    requireExactAssetDirectory(args.product, "broker-helper", assetDir, version);
    run(TOOL, [
      process.execPath,
      "tools/release/check-broker-release-assets.mjs",
      "--asset-dir",
      assetDir,
    ]);
    return;
  }

  const isWasixNapi = args.product === WASIX_NAPI_PRODUCT;
  const outputRoot = isWasixNapi ? "target/oliphaunt-wasix-napi" : "target/oliphaunt-node-direct";
  const kind = isWasixNapi ? "wasix-napi-addon" : "node-direct-addon";
  const label = isWasixNapi ? "WASIX Node-API" : "Node direct";
  const assetDir = resolveDir(
    args.assetDir,
    (isWasixNapi
      ? process.env.OLIPHAUNT_WASIX_NAPI_ASSET_OUT_DIR
      : process.env.OLIPHAUNT_NODE_ADDON_ASSET_OUT_DIR)
      ?? path.join(ROOT, outputRoot, "release-assets"),
  );
  const npmPackageDir = resolveDir(
    args.npmPackageDir,
    (isWasixNapi
      ? process.env.OLIPHAUNT_WASIX_NAPI_NPM_PACKAGE_OUT_DIR
      : process.env.OLIPHAUNT_NODE_ADDON_NPM_PACKAGE_OUT_DIR)
      ?? path.join(ROOT, outputRoot, "npm-packages"),
  );
  requirePreChecksumAssetDirectory(args.product, kind, assetDir, version);
  rewriteChecksums(args.product, assetDir, version);
  requireExactAssetDirectory(args.product, kind, assetDir, version);
  const npmPackages = optionalNpmPackages(
    npmPackageDir,
    isWasixNapi
      ? expectedWasixNapiNpmPackageNames(version)
      : expectedNodeDirectNpmPackageNames(version),
    label,
  );
  run(TOOL, [
    process.execPath,
    isWasixNapi
      ? "tools/release/check-wasix-napi-release-assets.mjs"
      : "tools/release/check-node-direct-release-assets.mjs",
    "--asset-dir",
    assetDir,
    ...npmPackages.flatMap((npmPackage) => ["--npm-package", npmPackage]),
  ]);
}

if (import.meta.main) main();
