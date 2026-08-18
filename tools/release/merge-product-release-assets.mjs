#!/usr/bin/env bun

import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  createReadStream,
  linkSync,
  lstatSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { compareText, expectedAssetRows } from "./release-artifact-targets.mjs";

const TOOL = "merge-product-release-assets.mjs";

function fail(message) {
  throw new Error(`${TOOL}: ${message}`);
}

function parseOptions(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!["--asset-dir", "--product", "--version"].includes(flag) || index + 1 >= argv.length) {
      fail(`usage: ${TOOL} --product PRODUCT --version VERSION --asset-dir DIR`);
    }
    const field = flag.slice(2).replace("-", "_");
    if (options[field] !== undefined) {
      fail(`${flag} may only be provided once`);
    }
    options[field] = argv[index + 1];
    index += 1;
  }
  for (const field of ["asset_dir", "product", "version"]) {
    if (typeof options[field] !== "string" || options[field].length === 0) {
      fail(`--${field.replace("_", "-")} is required`);
    }
  }
  return options;
}

async function sha256File(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

function exactRegularFiles(directory) {
  const directoryEntry = lstatSync(directory);
  if (!directoryEntry.isDirectory() || directoryEntry.isSymbolicLink()) {
    fail(`asset directory must be a regular directory: ${directory}`);
  }
  return readdirSync(directory).map((name) => {
    const file = path.join(directory, name);
    const entry = lstatSync(file);
    if (!entry.isFile() || entry.isSymbolicLink()) {
      fail(`asset directory contains a non-regular entry: ${file}`);
    }
    return name;
  }).sort(compareText);
}

function canonicalAssetNames(rows, product) {
  const names = rows.map(({ assetName }) => assetName);
  for (const name of names) {
    if (
      typeof name !== "string"
      || name.length === 0
      || name === "."
      || name === ".."
      || name.includes("/")
      || name.includes("\\")
      || path.basename(name) !== name
    ) {
      fail(`${product} declares a non-canonical release asset name: ${JSON.stringify(name)}`);
    }
  }
  if (new Set(names).size !== names.length) {
    fail(`${product} declares duplicate release asset names`);
  }
}

export async function mergeProductReleaseAssets({ assetDir, product, version }) {
  const directory = path.resolve(assetDir);
  const expected = expectedAssetRows({ product, version }, TOOL);
  canonicalAssetNames(expected, product);
  const checksumRows = expected.filter(({ kind }) => kind === "checksums");
  if (checksumRows.length !== 1) {
    fail(`${product} must declare exactly one checksum release asset`);
  }
  const checksumName = checksumRows[0].assetName;
  const payloadNames = expected
    .filter(({ assetName }) => assetName !== checksumName)
    .map(({ assetName }) => assetName)
    .sort(compareText);
  const actualNames = exactRegularFiles(directory);
  if (JSON.stringify(actualNames) !== JSON.stringify(payloadNames)) {
    fail(
      `${product} release payload set differs: expected=${JSON.stringify(payloadNames)}, actual=${JSON.stringify(actualNames)}`,
    );
  }

  const checksum = path.join(directory, checksumName);
  const temporary = path.join(directory, `.${checksumName}.tmp-${randomUUID()}`);
  const lines = [];
  for (const name of payloadNames) {
    lines.push(`${await sha256File(path.join(directory, name))}  ./${name}`);
  }
  try {
    writeFileSync(temporary, `${lines.join("\n")}\n`, { encoding: "utf8", flag: "wx", mode: 0o444 });
    linkSync(temporary, checksum);
  } finally {
    try {
      unlinkSync(temporary);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  chmodSync(checksum, 0o444);
  return checksum;
}

if (import.meta.main) {
  const options = parseOptions(Bun.argv.slice(2));
  const checksum = await mergeProductReleaseAssets({
    assetDir: options.asset_dir,
    product: options.product,
    version: options.version,
  });
  console.log(`merged ${options.product} release assets: ${checksum}`);
}
