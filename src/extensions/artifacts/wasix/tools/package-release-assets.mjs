#!/usr/bin/env bun
import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const PREFIX = "package-wasix-extension-assets.sh";
const WASIX_PRODUCT_PATH = "src/runtimes/liboliphaunt/wasix";
const EXTENSION_CLASSES = ["contrib", "external", "first-party"];

function fail(message) {
  console.error(`${PREFIX}: ${message}`);
  process.exit(2);
}

function usage() {
  fail(
    "usage: package-release-assets.mjs --root PATH --asset-root PATH --metadata PATH --out-dir PATH --target TARGET --extension-products CSV",
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

async function readToml(file) {
  let value;
  try {
    value = Bun.TOML.parse(await readFile(file, "utf8"));
  } catch (error) {
    fail(`could not read TOML file ${file}: ${error.message}`);
  }
  if (!isObject(value)) {
    fail(`${file} must contain a TOML table`);
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

async function extensionReleaseTomls(root) {
  const files = [];
  for (const extensionClass of EXTENSION_CLASSES) {
    const classRoot = path.join(root, "src/extensions", extensionClass);
    const classReleasePath = path.join(classRoot, "release.toml");
    if ((await fileSize(classReleasePath)) !== undefined) {
      files.push(classReleasePath);
    }
    let entries;
    try {
      entries = await readdir(classRoot, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const releasePath = path.join(classRoot, entry.name, "release.toml");
        if ((await fileSize(releasePath)) !== undefined) {
          files.push(releasePath);
        }
      }
    }
  }
  return files.sort();
}

async function selectedSqlNames(root, extensionProductsCsv) {
  const products = parseCsv(extensionProductsCsv);
  if (products.length === 0) {
    return new Set();
  }

  const byProduct = new Map();
  for (const releasePath of await extensionReleaseTomls(root)) {
    const metadata = await readToml(releasePath);
    const product = metadata.id;
    if (typeof product === "string" && product.length > 0) {
      byProduct.set(product, { metadata, releasePath });
    }
  }

  const sqlNames = new Set();
  for (const product of products) {
    const entry = byProduct.get(product);
    if (entry === undefined) {
      fail(`unknown exact-extension artifact product ${product}`);
    }
    const { metadata, releasePath } = entry;
    const members = metadata.kind === "exact-extension-artifact"
      ? [metadata.extension_sql_name]
      : metadata.kind === "exact-extension-bundle"
        ? metadata.extension_sql_names
        : undefined;
    if (!Array.isArray(members) || members.length === 0 || members.some((sqlName) => typeof sqlName !== "string" || sqlName.length === 0)) {
      fail(`${relativeToRoot(root, releasePath)} must declare exact extension_sql_name or extension_sql_names members`);
    }
    for (const sqlName of members) sqlNames.add(sqlName);
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
const outDir = path.resolve(optionValue(args, "--out-dir"));
const targetId = optionValue(args, "--target");
const extensionProductsCsv = optionValue(args, "--extension-products");

const [version, selected] = await Promise.all([
  releaseVersion(root),
  selectedSqlNames(root, extensionProductsCsv),
]);

const data = await readJson(metadataPath);
const extensions = data.extensions;
if (!Array.isArray(extensions) || extensions.length === 0) {
  fail(`${relativeToRoot(root, metadataPath)} must contain a non-empty extensions array`);
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

  const source = path.join(assetRoot, archive);
  const sourceBytes = await fileSize(source);
  if (sourceBytes === undefined) {
    fail(`missing WASIX extension archive for ${sqlName}: ${relativeToRoot(root, source)}`);
  }
  if (sourceBytes === 0) {
    fail(`WASIX extension archive for ${sqlName} is empty: ${relativeToRoot(root, source)}`);
  }

  const artifact = `liboliphaunt-wasix-${version}-extension-${sqlName}-${targetId}.tar.zst`;
  const destination = path.join(outDir, artifact);
  await copyFile(source, destination);
  const artifactBytes = await fileSize(destination);
  rows.push({
    sqlName,
    target: targetId,
    kind: "wasix-runtime",
    artifact,
    artifactBytes,
  });
}

if (rows.length === 0) {
  fail("no WASIX extension artifacts were staged");
}

const indexPath = path.join(outDir, `liboliphaunt-wasix-${version}-wasix-extension-assets.tsv`);
const lines = [["sql_name", "target", "kind", "artifact", "artifact_bytes"].join("\t")];
for (const row of rows) {
  lines.push(
    [
      tsvCell(row.sqlName),
      tsvCell(row.target),
      tsvCell(row.kind),
      tsvCell(row.artifact),
      tsvCell(row.artifactBytes),
    ].join("\t"),
  );
}
await writeFile(indexPath, `${lines.join("\n")}\n`, "utf8");

console.log(`staged ${rows.length} WASIX exact-extension artifact(s) in ${relativeToRoot(root, outDir)}`);
