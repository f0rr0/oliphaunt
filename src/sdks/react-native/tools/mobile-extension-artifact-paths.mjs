#!/usr/bin/env bun
import { existsSync, statSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

function fail(message, code = 1) {
  console.error(message);
  process.exit(code);
}

function usage() {
  fail(
    "usage: mobile-extension-artifact-paths.mjs --root PATH --artifact-root PATH --extensions CSV --asset-kind runtime|ios-xcframework --asset-target TARGET|* --required 0|1",
    2,
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

function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

async function manifestPaths(artifactRoot) {
  const entries = await readdir(artifactRoot, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(artifactRoot, entry.name, "extension-artifacts.json"))
    .filter((path) => existsSync(path))
    .sort();
}

function assetMatches(asset, assetKind, assetTarget) {
  if (asset.family !== "native") {
    return false;
  }
  if (assetTarget !== "*" && asset.target !== assetTarget) {
    return false;
  }
  if (assetKind === "runtime") {
    return asset.kind === "runtime";
  }
  if (assetKind === "ios-xcframework") {
    return asset.kind === "ios-xcframework";
  }
  fail(`unknown extension asset kind: ${assetKind}`);
}

const args = Bun.argv.slice(2);
const root = optionValue(args, "--root");
const artifactRoot = optionValue(args, "--artifact-root");
const selected = optionValue(args, "--extensions")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);
const assetKind = optionValue(args, "--asset-kind");
const assetTarget = optionValue(args, "--asset-target");
const required = optionValue(args, "--required") === "1";

const bySqlName = new Map();
for (const manifestPath of await manifestPaths(artifactRoot)) {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const sqlName = manifest.sqlName;
  if (typeof sqlName !== "string" || sqlName.length === 0) {
    fail(`${manifestPath} does not declare sqlName`);
  }
  if (bySqlName.has(sqlName)) {
    fail(`duplicate exact-extension artifact package for SQL extension ${sqlName}`);
  }
  bySqlName.set(sqlName, { manifestPath, manifest });
}

const paths = [];
const missing = [];
for (const sqlName of selected) {
  const entry = bySqlName.get(sqlName);
  if (entry === undefined) {
    missing.push(`${sqlName}: package`);
    continue;
  }
  const assets = Array.isArray(entry.manifest.assets) ? entry.manifest.assets : [];
  const matches = assets.filter(
    (asset) => asset !== null && typeof asset === "object" && assetMatches(asset, assetKind, assetTarget),
  );
  if (matches.length === 0) {
    missing.push(`${sqlName}: ${assetKind} asset`);
    continue;
  }
  if (matches.length !== 1) {
    fail(
      `${entry.manifestPath} must contain exactly one ${assetKind} asset for ${sqlName}, got ${matches.length}`,
    );
  }
  const rawPath = matches[0].path;
  if (typeof rawPath !== "string" || rawPath.length === 0) {
    fail(`${entry.manifestPath} ${assetKind} asset for ${sqlName} does not declare path`);
  }
  const path = isAbsolute(rawPath) ? rawPath : join(root, rawPath);
  if (!isFile(path)) {
    missing.push(`${sqlName}: ${path}`);
    continue;
  }
  paths.push(path);
}

if (missing.length > 0) {
  const message = `missing exact-extension artifact(s): ${missing.join(", ")}`;
  fail(message, required ? 1 : 3);
}

for (const path of paths) {
  console.log(path);
}
