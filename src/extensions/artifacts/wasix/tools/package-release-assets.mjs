#!/usr/bin/env bun
import { copyFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { extensionSqlNames } from "../../../../../tools/release/release-artifact-targets.mjs";
import {
  projectWasixExtensionInstallSidecar,
} from "../../../../../tools/release/wasix-extension-install-contract.mjs";
import {
  loadNativeComponentContract,
  resolveNativeComponentClosure,
} from "../../../tools/native-component-contract.mjs";
const PREFIX = "package-wasix-extension-assets.sh";
const WASIX_PRODUCT_PATH = "src/runtimes/liboliphaunt/wasix";
const nativeComponentContract = loadNativeComponentContract();

function fail(message) {
  console.error(`${PREFIX}: ${message}`);
  process.exit(2);
}

function usage() {
  fail(
    "usage: package-release-assets.mjs --root PATH --asset-root PATH --metadata PATH --manifest PATH --out-dir PATH --target TARGET --extension-products CSV",
  );
}

function optionValue(args, name) {
  const index = args.indexOf(name);
  if (index === -1) {
    usage();
  }
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    usage();
  }
  return value;
}

function parseCsv(value) {
  return [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))].sort();
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function readJson(file) {
  let value;
  try {
    value = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    fail(`could not read JSON file ${file}: ${error.message}`);
  }
  if (!isObject(value)) {
    fail(`${file} must contain a JSON object`);
  }
  return value;
}

function relativeToRoot(root, file) {
  return path.relative(root, file).split(path.sep).join("/");
}

async function releaseVersion(root) {
  const manifestPath = path.join(root, ".release-please-manifest.json");
  const manifest = await readJson(manifestPath);
  const version = manifest[WASIX_PRODUCT_PATH];
  if (typeof version !== "string" || version.length === 0) {
    fail(`.release-please-manifest.json is missing ${WASIX_PRODUCT_PATH}`);
  }
  return version;
}

function selectedSqlNames(extensionProductsCsv) {
  const products = parseCsv(extensionProductsCsv);
  if (products.length === 0) {
    return new Set();
  }

  const sqlNames = new Set();
  for (const product of products) {
    for (const sqlName of extensionSqlNames(product, PREFIX)) sqlNames.add(sqlName);
  }
  return sqlNames;
}

async function fileSize(file) {
  try {
    return (await stat(file)).size;
  } catch {
    return undefined;
  }
}

function tsvCell(value) {
  const text = String(value);
  if (text.includes("\t") || text.includes("\n") || text.includes("\r")) {
    fail(`TSV field contains unsupported whitespace: ${JSON.stringify(text)}`);
  }
  return text;
}

const args = Bun.argv.slice(2);
const root = path.resolve(optionValue(args, "--root"));
const assetRoot = path.resolve(optionValue(args, "--asset-root"));
const metadataPath = path.resolve(optionValue(args, "--metadata"));
const manifestPath = path.resolve(optionValue(args, "--manifest"));
const outDir = path.resolve(optionValue(args, "--out-dir"));
const targetId = optionValue(args, "--target");
const extensionProductsCsv = optionValue(args, "--extension-products");

const [version, selected] = await Promise.all([
  releaseVersion(root),
  selectedSqlNames(extensionProductsCsv),
]);

const data = await readJson(metadataPath);
const extensions = data.extensions;
if (!Array.isArray(extensions) || extensions.length === 0) {
  fail(`${relativeToRoot(root, metadataPath)} must contain a non-empty extensions array`);
}
const builtManifest = await readJson(manifestPath);
const builtExtensions = builtManifest.extensions;
if (!Array.isArray(builtExtensions) || builtExtensions.length === 0) {
  fail(`${relativeToRoot(root, manifestPath)} must contain a non-empty extensions array`);
}
const builtBySqlName = new Map();
for (const row of builtExtensions) {
  const sqlName = isObject(row) ? row["sql-name"] : undefined;
  if (typeof sqlName !== "string" || sqlName.length === 0 || builtBySqlName.has(sqlName)) {
    fail(`${relativeToRoot(root, manifestPath)} must contain unique extension sql-name rows`);
  }
  builtBySqlName.set(sqlName, row);
}

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

const rows = [];
for (const item of extensions) {
  if (!isObject(item)) {
    fail(`${relativeToRoot(root, metadataPath)} contains a non-object extension row`);
  }
  const sqlName = item["sql-name"];
  const archive = item.archive;
  if (typeof sqlName !== "string" || sqlName.length === 0) {
    fail(`${relativeToRoot(root, metadataPath)} contains an extension row without sql-name`);
  }
  if (selected.size > 0 && !selected.has(sqlName)) {
    continue;
  }
  if (typeof archive !== "string" || archive.length === 0) {
    fail(`${relativeToRoot(root, metadataPath)} row for ${sqlName} is missing archive`);
  }
  const componentClosure = resolveNativeComponentClosure(nativeComponentContract, {
    extension: sqlName,
    family: "wasix",
    kind: "wasix-runtime",
    target: targetId,
  });
  for (const [field, expected] of [
    ["native-components", componentClosure.components],
    ["native-link-units", componentClosure.linkUnits],
    ["native-runtime-files", componentClosure.runtimeFiles],
  ]) {
    if (JSON.stringify(item[field]) !== JSON.stringify(expected)) {
      fail(`${relativeToRoot(root, metadataPath)} row for ${sqlName} has stale ${field}`);
    }
  }

  const source = path.join(assetRoot, archive);
  const sourceSize = await fileSize(source);
  if (sourceSize === undefined) {
    fail(`missing WASIX extension archive for ${sqlName}: ${relativeToRoot(root, source)}`);
  }
  if (sourceSize === 0) {
    fail(`WASIX extension archive for ${sqlName} is empty: ${relativeToRoot(root, source)}`);
  }
  const builtRow = builtBySqlName.get(sqlName);
  if (builtRow === undefined) {
    fail(`${relativeToRoot(root, manifestPath)} has no built extension row for ${sqlName}`);
  }
  const installedFiles = Array.isArray(builtRow["installed-files"])
    ? builtRow["installed-files"]
    : [];
  const missingComponentRuntimeFiles = componentClosure.runtimeFiles
    .map((file) => `share/${file}`)
    .filter((file) => !installedFiles.includes(file));
  if (missingComponentRuntimeFiles.length > 0) {
    fail(
      `${relativeToRoot(root, manifestPath)} extension ${sqlName} is missing native component runtime files: `
        + missingComponentRuntimeFiles.join(", "),
    );
  }
  const archiveBytes = await readFile(source);
  let installContract;
  try {
    installContract = projectWasixExtensionInstallSidecar({
      modelRow: item,
      manifestRow: builtRow,
    }, {
      archiveBytes,
      label: `${relativeToRoot(root, manifestPath)} extension ${sqlName}`,
    });
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }

  const artifact = `liboliphaunt-wasix-${version}-extension-${sqlName}-${targetId}.tar.zst`;
  const destination = path.join(outDir, artifact);
  await copyFile(source, destination);
  const artifactBytes = await fileSize(destination);
  if (artifactBytes !== installContract.size) {
    fail(`WASIX extension archive for ${sqlName} changed while being staged`);
  }
  const installContractName =
    `liboliphaunt-wasix-${version}-extension-${sqlName}-${targetId}.install-contract.json`;
  await writeFile(
    path.join(outDir, installContractName),
    `${JSON.stringify(installContract, null, 2)}\n`,
    "utf8",
  );
  rows.push({
    sqlName,
    target: targetId,
    kind: "wasix-runtime",
    artifact,
    artifactBytes,
    installContract: installContractName,
  });
}

if (rows.length === 0) {
  fail("no WASIX extension artifacts were staged");
}

const indexPath = path.join(outDir, `liboliphaunt-wasix-${version}-wasix-extension-assets.tsv`);
const lines = [[
  "sql_name",
  "target",
  "kind",
  "artifact",
  "artifact_bytes",
  "install_contract",
].join("\t")];
for (const row of rows) {
  lines.push(
    [
      tsvCell(row.sqlName),
      tsvCell(row.target),
      tsvCell(row.kind),
      tsvCell(row.artifact),
      tsvCell(row.artifactBytes),
      tsvCell(row.installContract),
    ].join("\t"),
  );
}
await writeFile(indexPath, `${lines.join("\n")}\n`, "utf8");

console.log(`staged ${rows.length} WASIX exact-extension artifact(s) in ${relativeToRoot(root, outDir)}`);
