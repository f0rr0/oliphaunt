#!/usr/bin/env bun
import { readFile } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "../..");
const CONFIG_PATH = path.join(ROOT, "release-please-config.json");

function fail(message) {
  console.error(`product-version.mjs: ${message}`);
  process.exit(2);
}

async function readJson(file) {
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch {
    fail(`missing ${rel(file)}`);
  }
  const value = JSON.parse(text);
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    fail(`${rel(file)} must contain a JSON object`);
  }
  return value;
}

function rel(file) {
  const relative = path.relative(ROOT, file);
  return relative.startsWith("..") ? file : relative;
}

function usage() {
  fail("usage: tools/release/product-version.mjs version <product-id>");
}

function assertRelativePath(value, context) {
  if (typeof value !== "string" || value.length === 0) {
    fail(`${context} must be a non-empty string`);
  }
  if (path.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value) || value.split(/[\\/]/).includes("..")) {
    fail(`${context} must stay inside release package path: ${JSON.stringify(value)}`);
  }
  return value;
}

async function findPackageConfig(product) {
  const config = await readJson(CONFIG_PATH);
  const packages = config.packages;
  if (packages === null || Array.isArray(packages) || typeof packages !== "object") {
    fail("release-please-config.json must define packages");
  }
  let foundPath;
  let foundConfig;
  for (const [packagePath, packageConfig] of Object.entries(packages)) {
    if (packageConfig === null || Array.isArray(packageConfig) || typeof packageConfig !== "object") {
      fail(`${packagePath} release-please config must be an object`);
    }
    if (packageConfig.component === product) {
      if (foundPath !== undefined) {
        fail(`duplicate release-please component ${product}`);
      }
      foundPath = assertRelativePath(packagePath, `${product}.packagePath`);
      foundConfig = packageConfig;
    }
  }
  if (foundPath === undefined || foundConfig === undefined) {
    fail(`unknown release product ${JSON.stringify(product)}`);
  }
  return { packagePath: foundPath, packageConfig: foundConfig };
}

function packageRelativePath(packagePath, relative, context) {
  return path.join(assertRelativePath(packagePath, `${context}.packagePath`), assertRelativePath(relative, context));
}

function canonicalVersionFile(product, packagePath, packageConfig) {
  const versionFile = packageConfig["version-file"];
  if (typeof versionFile === "string" && versionFile.length > 0) {
    return packageRelativePath(packagePath, versionFile, `${product}.version-file`);
  }
  const releaseType = packageConfig["release-type"];
  if (releaseType === "rust") {
    return packageRelativePath(packagePath, "Cargo.toml", `${product}.rust`);
  }
  if (releaseType === "node" || releaseType === "expo") {
    return packageRelativePath(packagePath, "package.json", `${product}.node`);
  }
  fail(`${product} release-please config must declare version-file for release type ${JSON.stringify(releaseType)}`);
}

function parserForVersionFile(product, file) {
  const name = path.basename(file);
  if (name === "Cargo.toml") {
    return "cargo";
  }
  if (name === "package.json" || name === "jsr.json") {
    return "json:version";
  }
  if (name === "gradle.properties") {
    return "gradle:VERSION_NAME";
  }
  if (name === "VERSION" || name === "LIBOLIPHAUNT_VERSION") {
    return "raw";
  }
  fail(`${product}.version_files has unsupported version file type: ${file}`);
}

function parseJsonPath(text, dotted) {
  let value = JSON.parse(text);
  for (const key of dotted.split(".")) {
    if (value === null || Array.isArray(value) || typeof value !== "object" || !(key in value)) {
      return "";
    }
    value = value[key];
  }
  return String(value);
}

function parseTomlPath(text, dotted) {
  let value = Bun.TOML.parse(text);
  for (const key of dotted.split(".")) {
    if (value === null || Array.isArray(value) || typeof value !== "object" || !(key in value)) {
      return "";
    }
    value = value[key];
  }
  return String(value);
}

function parseGradleProperty(text, name) {
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#") || !line.includes("=")) {
      continue;
    }
    const [key, ...rest] = line.split("=");
    if (key.trim() === name) {
      return rest.join("=").trim();
    }
  }
  return "";
}

function parseVersionText(text, file, parser) {
  if (parser === "raw") {
    return text.trim();
  }
  if (parser === "cargo") {
    return parseTomlPath(text, "package.version");
  }
  if (parser.startsWith("gradle:")) {
    return parseGradleProperty(text, parser.slice("gradle:".length));
  }
  if (parser.startsWith("json:")) {
    return parseJsonPath(text, parser.slice("json:".length));
  }
  if (parser.startsWith("toml:")) {
    return parseTomlPath(text, parser.slice("toml:".length));
  }
  fail(`unknown version parser ${JSON.stringify(parser)} for ${file}`);
}

function ensureSemver(product, version) {
  if (!/^[0-9]+[.][0-9]+[.][0-9]+(?:[-+][0-9A-Za-z][0-9A-Za-z.-]*)?$/.test(version)) {
    fail(`${product} version is not semver-like: ${JSON.stringify(version)}`);
  }
  return version;
}

export async function currentVersion(product) {
  const { packagePath, packageConfig } = await findPackageConfig(product);
  const versionFile = canonicalVersionFile(product, packagePath, packageConfig);
  const parser = parserForVersionFile(product, versionFile);
  const file = path.join(ROOT, versionFile);
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch {
    fail(`${product} version file does not exist: ${versionFile}`);
  }
  const version = parseVersionText(text, versionFile, parser);
  if (!version) {
    fail(`${versionFile} does not define a release version for ${product}`);
  }
  return ensureSemver(product, version);
}

async function main(argv) {
  if (argv.length !== 2 || argv[0] !== "version") {
    usage();
  }
  console.log(await currentVersion(argv[1]));
}

if (import.meta.main) {
  await main(Bun.argv.slice(2));
}
