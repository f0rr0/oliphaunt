#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";

import {
  ROOT,
  compareText,
  tagPrefix,
} from "./release-graph.mjs";
import { currentProductVersionSync } from "./release-artifact-targets.mjs";

export const IOS_CARRIER_SCHEMA = "oliphaunt-react-native-ios-carrier-v1";
export const IOS_CARRIER_FILENAME = "oliphaunt-react-native-ios-carriers.json";
export const DEFAULT_IOS_CARRIER = path.join(
  ROOT,
  "target/release/ios-carriers",
  IOS_CARRIER_FILENAME,
);

const DEFAULT_REPOSITORY = "f0rr0/oliphaunt";

function error(message) {
  return new Error(`ios-carrier-manifest: ${message}`);
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function requireFile(file, label) {
  if (!existsSync(file) || !statSync(file).isFile()) {
    throw error(`missing ${label}: ${path.relative(ROOT, file)}`);
  }
  return file;
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort(compareText).map((key) => [key, stable(value[key])]));
  }
  return value;
}

function listArchive(file, format) {
  const args = format === "zip" ? ["unzip", "-Z1", file] : ["tar", "-tzf", file];
  const result = spawnSync(args[0], args.slice(1), {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error !== undefined || result.status !== 0) {
    throw error(`cannot inspect ${path.basename(file)}: ${(result.stderr || result.error?.message || "").trim()}`);
  }
  const members = result.stdout
    .split(/\r?\n/u)
    .map((value) => value.replace(/^\.\//u, "").replace(/\/$/u, ""))
    .filter((value) => value.length > 0 && value !== ".");
  if (members.length === 0) throw error(`${path.basename(file)} is empty`);
  return members;
}

function verifyMember(file, format, member) {
  const members = listArchive(file, format);
  if (member === ".") return;
  if (!members.some((value) => value === member || value.startsWith(`${member}/`))) {
    throw error(`${path.basename(file)} is missing declared archive member ${member}`);
  }
}

function assetUrl({ file, name, tag, repository, localUrls }) {
  if (localUrls) return pathToFileURL(file).href;
  return `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`;
}

function asset({ file, role, member, tag, repository, localUrls, verifyMembers }) {
  requireFile(file, `${role} asset`);
  const name = path.basename(file);
  const format = name.endsWith(".zip") ? "zip" : name.endsWith(".tar.gz") ? "tar.gz" : null;
  if (format === null) throw error(`${name} must be a .zip or .tar.gz archive`);
  if (verifyMembers) verifyMember(file, format, member);
  return {
    role,
    name,
    url: assetUrl({ file, name, tag, repository, localUrls }),
    sha256: sha256(file),
    bytes: statSync(file).size,
    format,
    member,
  };
}

function baseCarrier({ baseAssetDir, repository, localUrls, verifyMembers }) {
  const product = "liboliphaunt-native";
  const version = currentProductVersionSync(product, "ios-carrier-manifest");
  const tag = `${tagPrefix(product, "ios-carrier-manifest")}${version}`;
  const rows = [
    {
      role: "base-xcframework",
      name: `liboliphaunt-${version}-apple-spm-xcframework.zip`,
      member: "liboliphaunt.xcframework",
    },
    {
      role: "runtime-resources",
      name: `liboliphaunt-${version}-runtime-resources.tar.gz`,
      member: "oliphaunt",
    },
    {
      role: "icu-data",
      name: `liboliphaunt-${version}-icu-data.tar.gz`,
      member: "share/icu",
    },
  ];
  return {
    product,
    version,
    tag,
    assets: rows.map((row) => asset({
      ...row,
      file: path.join(baseAssetDir, row.name),
      tag,
      repository,
      localUrls,
      verifyMembers,
    })),
  };
}

function frozenBaseCarrier(file) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(requireFile(path.resolve(file), "base carrier manifest"), "utf8"));
  } catch (cause) {
    throw error(`cannot read base carrier manifest ${file}: ${cause.message}`);
  }
  const base = manifest?.schema === IOS_CARRIER_SCHEMA ? manifest.base : manifest;
  const product = "liboliphaunt-native";
  const version = currentProductVersionSync(product, "ios-carrier-manifest");
  const tag = `${tagPrefix(product, "ios-carrier-manifest")}${version}`;
  if (base?.product !== product || base.version !== version || base.tag !== tag || !Array.isArray(base.assets)) {
    throw error(`${file} does not freeze the current ${product} base carrier`);
  }
  const expectedRoles = ["base-xcframework", "runtime-resources", "icu-data"];
  if (JSON.stringify(base.assets.map(({ role }) => role)) !== JSON.stringify(expectedRoles)) {
    throw error(`${file} base carrier roles must be exactly ${expectedRoles.join(", ")}`);
  }
  for (const [index, row] of base.assets.entries()) {
    if (
      typeof row.name !== "string" || path.basename(row.name) !== row.name
      || typeof row.url !== "string" || !row.url.startsWith("https://")
      || typeof row.sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(row.sha256)
      || !Number.isSafeInteger(row.bytes) || row.bytes <= 0
      || !["zip", "tar.gz"].includes(row.format)
      || typeof row.member !== "string" || row.member.length === 0
    ) {
      throw error(`${file} contains invalid base asset ${index}`);
    }
  }
  return stable(base);
}

function validateRegistration(value, manifestPath) {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw error(`${manifestPath} native extension lacks iOS registration metadata`);
  }
  const { schema, sqlName, nativeModuleStem, magicSymbol, initSymbol, symbols } = value;
  if (
    schema !== "oliphaunt-ios-extension-registration-v1"
    || typeof sqlName !== "string"
    || typeof nativeModuleStem !== "string"
    || typeof magicSymbol !== "string"
    || !(initSymbol === null || typeof initSymbol === "string")
    || !Array.isArray(symbols)
  ) {
    throw error(`${manifestPath} contains invalid iOS registration metadata`);
  }
  return {
    magicSymbol,
    initSymbol,
    symbols: symbols.map((row) => ({ name: row.name, address: row.address })),
  };
}

function extensionCarrier(manifestPath, { repository, localUrls, verifyMembers }) {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (
    manifest?.schema !== "oliphaunt-extension-ci-artifacts-v1"
    || typeof manifest.product !== "string"
    || typeof manifest.version !== "string"
    || typeof manifest.sqlName !== "string"
    || !Array.isArray(manifest.assets)
  ) {
    throw error(`${manifestPath} is not an exact-extension CI artifact manifest`);
  }
  const tag = `${tagPrefix(manifest.product, "ios-carrier-manifest")}${manifest.version}`;
  const iOS = manifest.assets.filter((row) => row?.family === "native" && row.target === "ios-xcframework");
  const allowedKinds = new Set(["runtime", "ios-xcframework", "ios-dependency-xcframework"]);
  if (iOS.some((row) => !allowedKinds.has(row.kind))) {
    throw error(`${manifestPath} contains an unsupported iOS asset role`);
  }
  const rows = iOS.map((row) => {
    const file = path.resolve(ROOT, row.path);
    requireFile(file, `${manifest.product} ${row.kind}`);
    if (statSync(file).size !== row.bytes || sha256(file) !== row.sha256 || path.basename(file) !== row.name) {
      throw error(`${manifestPath} metadata does not match ${row.path}`);
    }
    if (row.kind === "runtime") {
      return { row, role: "runtime-resources", member: "." };
    }
    if (row.kind === "ios-xcframework") {
      return { row, role: "extension-xcframework", member: `liboliphaunt_extension_${row.identity}.xcframework` };
    }
    return { row, role: "dependency-xcframework", member: `liboliphaunt_dependency_${row.identity}.xcframework` };
  });
  const assets = rows.map(({ row, role, member }) => asset({
    file: path.resolve(ROOT, row.path),
    role,
    member,
    tag,
    repository,
    localUrls,
    verifyMembers,
  })).sort((left, right) => `${left.role}\0${left.member}`.localeCompare(`${right.role}\0${right.member}`));
  const runtimeCount = assets.filter(({ role }) => role === "runtime-resources").length;
  const nativeModuleStem = typeof manifest.nativeModuleStem === "string" && manifest.nativeModuleStem.length > 0
    ? manifest.nativeModuleStem
    : null;
  const nativeDependencies = Array.isArray(manifest.iosNativeDependencies)
    ? [...manifest.iosNativeDependencies].sort(compareText)
    : [];
  if (runtimeCount !== 1) throw error(`${manifestPath} must contain exactly one iOS runtime-resources asset`);
  if (nativeModuleStem === null) {
    if (assets.some(({ role }) => role !== "runtime-resources") || nativeDependencies.length > 0 || manifest.iosRegistration !== null) {
      throw error(`${manifestPath} SQL-only extension fabricates iOS native roles`);
    }
  } else {
    const primary = rows.filter(({ row }) => row.kind === "ios-xcframework");
    const dependencies = rows
      .filter(({ row }) => row.kind === "ios-dependency-xcframework")
      .map(({ row }) => row.identity)
      .sort(compareText);
    if (primary.length !== 1 || primary[0].row.identity !== nativeModuleStem) {
      throw error(`${manifestPath} lacks its canonical primary iOS XCFramework`);
    }
    if (JSON.stringify(dependencies) !== JSON.stringify(nativeDependencies)) {
      throw error(`${manifestPath} iOS dependency assets do not match iosNativeDependencies`);
    }
  }
  const registration = nativeModuleStem === null ? null : validateRegistration(manifest.iosRegistration, manifestPath);
  return {
    product: manifest.product,
    version: manifest.version,
    tag,
    sqlName: manifest.sqlName,
    createsExtension: manifest.createsExtension,
    dependencies: [...(manifest.dependencies ?? [])].sort(compareText),
    nativeDependencies,
    nativeModuleStem,
    sharedPreloadLibraries: [...(manifest.sharedPreloadLibraries ?? [])].sort(compareText),
    registration,
    assets,
  };
}

function discoveredExtensionManifests(root) {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(root, entry.name, "extension-artifacts.json"))
    .filter((file) => existsSync(file))
    .sort(compareText);
}

export function buildIosCarrierManifest({
  baseAssetDir = path.join(ROOT, "target/liboliphaunt/release-assets"),
  baseCarrierManifest = undefined,
  extensionManifests = discoveredExtensionManifests(path.join(ROOT, "target/extension-artifacts")),
  repository = DEFAULT_REPOSITORY,
  localUrls = false,
  verifyMembers = true,
} = {}) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) {
    throw error(`invalid GitHub repository ${repository}`);
  }
  const extensions = extensionManifests
    .map((file) => extensionCarrier(path.resolve(file), { repository, localUrls, verifyMembers }))
    .sort((left, right) => compareText(left.sqlName, right.sqlName));
  if (new Set(extensions.map(({ sqlName }) => sqlName)).size !== extensions.length) {
    throw error("extension carrier set contains duplicate SQL names");
  }
  return stable({
    schema: IOS_CARRIER_SCHEMA,
    base: baseCarrierManifest === undefined
      ? baseCarrier({ baseAssetDir: path.resolve(baseAssetDir), repository, localUrls, verifyMembers })
      : frozenBaseCarrier(baseCarrierManifest),
    extensions,
  });
}

export function writeIosCarrierManifest(output, options = {}) {
  const manifest = buildIosCarrierManifest(options);
  mkdirSync(path.dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifest;
}

function parseArgs(argv) {
  const options = { extensionManifests: [] };
  let output = DEFAULT_IOS_CARRIER;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--local-urls") {
      options.localUrls = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      console.log(
        `usage: ${path.basename(import.meta.path)} [--base-asset-dir DIR] [--extension-manifest FILE ...] ` +
          `[--base-carrier FILE] [--extension-root DIR] [--repository OWNER/REPO] [--output FILE] [--local-urls]`,
      );
      process.exit(0);
    }
    const value = argv[index + 1];
    if (value === undefined) throw error(`${arg} requires a value`);
    index += 1;
    if (arg === "--base-asset-dir") options.baseAssetDir = value;
    else if (arg === "--base-carrier") options.baseCarrierManifest = value;
    else if (arg === "--extension-manifest") options.extensionManifests.push(value);
    else if (arg === "--extension-root") options.extensionManifests.push(...discoveredExtensionManifests(path.resolve(value)));
    else if (arg === "--repository") options.repository = value;
    else if (arg === "--output") output = path.resolve(value);
    else throw error(`unknown argument ${arg}`);
  }
  if (options.extensionManifests.length === 0) delete options.extensionManifests;
  return { options, output };
}

if (import.meta.main) {
  try {
    const { options, output } = parseArgs(Bun.argv.slice(2));
    const manifest = writeIosCarrierManifest(output, options);
    console.log(`${path.relative(ROOT, output)}\t${manifest.extensions.length} extensions`);
  } catch (cause) {
    console.error(cause instanceof Error ? cause.message : String(cause));
    process.exit(1);
  }
}
