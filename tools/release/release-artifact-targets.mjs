import { existsSync, readFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { loadGraph } from "./release-graph.mjs";

export const ROOT = path.resolve(import.meta.dir, "../..");

export const DESKTOP_TARGETS = {
  "linux-arm64-gnu": {
    triple: "aarch64-unknown-linux-gnu",
    runner: "ubuntu-24.04-arm",
    archive: "tar.gz",
    npmOs: "linux",
    npmCpu: "arm64",
    npmLibc: "glibc",
    liboliphauntNpmPackage: "@oliphaunt/liboliphaunt-linux-arm64-gnu",
    liboliphauntToolsNpmPackage: "@oliphaunt/tools-linux-arm64-gnu",
    brokerNpmPackage: "@oliphaunt/broker-linux-arm64-gnu",
    nodePackage: "@oliphaunt/node-direct-linux-arm64-gnu",
    wasixLlvmUrl: "https://github.com/wasmerio/llvm-custom-builds/releases/download/22.x/llvm-linux-aarch64.tar.xz",
  },
  "linux-x64-gnu": {
    triple: "x86_64-unknown-linux-gnu",
    runner: "ubuntu-latest",
    archive: "tar.gz",
    npmOs: "linux",
    npmCpu: "x64",
    npmLibc: "glibc",
    liboliphauntNpmPackage: "@oliphaunt/liboliphaunt-linux-x64-gnu",
    liboliphauntToolsNpmPackage: "@oliphaunt/tools-linux-x64-gnu",
    brokerNpmPackage: "@oliphaunt/broker-linux-x64-gnu",
    nodePackage: "@oliphaunt/node-direct-linux-x64-gnu",
    wasixLlvmUrl: "https://github.com/wasmerio/llvm-custom-builds/releases/download/22.x/llvm-linux-amd64.tar.xz",
  },
  "macos-arm64": {
    triple: "aarch64-apple-darwin",
    runner: "macos-latest",
    archive: "tar.gz",
    npmOs: "darwin",
    npmCpu: "arm64",
    liboliphauntNpmPackage: "@oliphaunt/liboliphaunt-darwin-arm64",
    liboliphauntToolsNpmPackage: "@oliphaunt/tools-darwin-arm64",
    brokerNpmPackage: "@oliphaunt/broker-darwin-arm64",
    nodePackage: "@oliphaunt/node-direct-darwin-arm64",
    wasixLlvmUrl: "https://github.com/wasmerio/llvm-custom-builds/releases/download/22.x/llvm-darwin-aarch64.tar.xz",
  },
  "macos-x64": {
    triple: "x86_64-apple-darwin",
    runner: "macos-latest",
    archive: "tar.gz",
  },
  "windows-x64-msvc": {
    triple: "x86_64-pc-windows-msvc",
    runner: "windows-latest",
    archive: "zip",
    npmOs: "win32",
    npmCpu: "x64",
    liboliphauntNpmPackage: "@oliphaunt/liboliphaunt-win32-x64-msvc",
    liboliphauntToolsNpmPackage: "@oliphaunt/tools-win32-x64-msvc",
    brokerNpmPackage: "@oliphaunt/broker-win32-x64-msvc",
    nodePackage: "@oliphaunt/node-direct-win32-x64-msvc",
    wasixLlvmUrl: "https://github.com/wasmerio/llvm-custom-builds/releases/download/22.x/llvm-windows-amd64.tar.xz",
  },
};

export const MOBILE_TARGETS = {
  "android-arm64-v8a": {
    triple: "aarch64-linux-android",
    runner: "ubuntu-latest",
    androidAbi: "arm64-v8a",
  },
  "android-x86_64": {
    triple: "x86_64-linux-android",
    runner: "ubuntu-latest",
    androidAbi: "x86_64",
  },
  "ios-xcframework": {
    triple: "ios-xcframework",
    runner: "macos-26",
  },
};

const NATIVE_RUNTIME_TARGETS = { ...DESKTOP_TARGETS, ...MOBILE_TARGETS };
const WASIX_TARGETS = new Set(["portable", "linux-arm64-gnu", "linux-x64-gnu", "macos-arm64", "windows-x64-msvc"]);
const BROKER_TARGETS = new Set(["linux-arm64-gnu", "linux-x64-gnu", "macos-arm64", "windows-x64-msvc"]);
const NODE_DIRECT_TARGETS = BROKER_TARGETS;
const PRODUCT_PRESETS = {
  "liboliphaunt-native": "liboliphaunt-native",
  "liboliphaunt-wasix": "liboliphaunt-wasix",
  "oliphaunt-broker": "broker-helper",
  "oliphaunt-node-direct": "node-direct-addon",
};
const EXTENSION_FAMILIES = new Set(["native", "wasix"]);
const EXTENSION_KINDS = new Set(["native-dynamic", "native-static-registry", "wasix-runtime"]);
const EXTENSION_STATUSES = new Set(["supported", "planned", "unsupported"]);

const graphCache = new Map();

export function fail(prefix, message) {
  console.error(`${prefix}: ${message}`);
  process.exit(1);
}

export function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function rel(file) {
  const relative = path.relative(ROOT, file);
  return relative.startsWith("..") ? file : relative.split(path.sep).join("/");
}

function graph(prefix) {
  if (!graphCache.has(prefix)) {
    graphCache.set(prefix, loadGraph(prefix));
  }
  return graphCache.get(prefix);
}

function archiveAsset(productPrefix, target, archive) {
  return `${productPrefix}-{version}-${target}.${archive}`;
}

function assertStringList(value, label, prefix) {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item)) {
    fail(prefix, `${label} must be a non-empty string list`);
  }
  return value;
}

function artifactTargetConfig(product, expectedPreset, prefix) {
  const release = releaseMetadata(product, prefix);
  const config = release.artifactTargets;
  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    fail(prefix, `Moon release metadata for ${product} must declare artifactTargets`);
  }
  if (config.preset !== expectedPreset) {
    fail(prefix, `Moon release metadata for ${product} artifactTargets.preset must be ${expectedPreset}`);
  }
  return config;
}

function publishedTargets(product, expectedPreset, knownTargets, prefix) {
  const config = artifactTargetConfig(product, expectedPreset, prefix);
  const targets = assertStringList(config.publishedTargets ?? [], `${product}.publishedTargets`, prefix);
  const duplicates = [...new Set(targets.filter((target, index) => targets.indexOf(target) !== index))];
  if (duplicates.length > 0) {
    fail(prefix, `Moon release metadata for ${product} artifactTargets.publishedTargets contains duplicates`);
  }
  const unknown = targets.filter((target) => !knownTargets.has(target)).sort(compareText);
  if (unknown.length > 0) {
    fail(prefix, `Moon release metadata for ${product} declares unknown artifact target(s): ${unknown.join(", ")}`);
  }
  return targets;
}

function plannedTargets(product, expectedPreset, knownTargets, prefix) {
  const value = artifactTargetConfig(product, expectedPreset, prefix).plannedTargets ?? {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(prefix, `Moon release metadata for ${product} artifactTargets.plannedTargets must be an object`);
  }
  const parsed = new Map();
  for (const [target, details] of Object.entries(value)) {
    if (!knownTargets.has(target)) {
      fail(prefix, `Moon release metadata for ${product} declares unknown planned artifact target ${target}`);
    }
    const reason = details?.unsupportedReason;
    if (typeof reason !== "string" || reason.trim().length < 40) {
      fail(prefix, `Moon release metadata for ${product} planned target ${target} must declare a concrete unsupportedReason`);
    }
    parsed.set(target, details);
  }
  return parsed;
}

function nativeLibraryRelativePath(target) {
  if (target.startsWith("android-")) {
    return `jni/${MOBILE_TARGETS[target].androidAbi}/liboliphaunt.so`;
  }
  if (target === "ios-xcframework") {
    return "liboliphaunt.xcframework";
  }
  if (target.startsWith("macos-")) {
    return "lib/liboliphaunt.dylib";
  }
  if (target.startsWith("linux-")) {
    return "lib/liboliphaunt.so";
  }
  if (target === "windows-x64-msvc") {
    return "bin/oliphaunt.dll";
  }
  fail("release-artifact-targets.mjs", `unsupported liboliphaunt native target ${target}`);
}

function nativeSurfaces(target) {
  if (target.startsWith("android-")) {
    return ["github-release", "maven", "react-native-android"];
  }
  if (target === "ios-xcframework") {
    return ["github-release", "swiftpm", "react-native-ios"];
  }
  return ["github-release", "rust-native-direct", "typescript-native-direct"];
}

export function liboliphauntNativeBuildRoot(target) {
  if (!(target in NATIVE_RUNTIME_TARGETS)) {
    fail("release-artifact-targets.mjs", `unknown liboliphaunt-native target ${target}`);
  }
  const roots = {
    "macos-arm64": "target/liboliphaunt-pg18",
    "android-arm64-v8a": "target/liboliphaunt-pg18-android-arm64",
    "android-x86_64": "target/liboliphaunt-pg18-android-x86_64",
    "ios-xcframework": "target/liboliphaunt-ios-xcframework",
  };
  return roots[target] ?? `target/liboliphaunt-pg18-${target}`;
}

export function liboliphauntNativeCiArtifactRoot(target) {
  if (!(target in NATIVE_RUNTIME_TARGETS)) {
    fail("release-artifact-targets.mjs", `unknown liboliphaunt-native target ${target}`);
  }
  return `target/liboliphaunt-native-ci/${target}`;
}

export function liboliphauntAndroidAbi(target) {
  const abi = MOBILE_TARGETS[target]?.androidAbi;
  if (!abi) {
    fail("release-artifact-targets.mjs", `unsupported React Native Android runtime target ${target}`);
  }
  return abi;
}

function liboliphauntNativeRows(prefix) {
  const product = "liboliphaunt-native";
  const published = new Set(
    publishedTargets(product, PRODUCT_PRESETS[product], new Set(Object.keys(NATIVE_RUNTIME_TARGETS)), prefix),
  );
  const planned = plannedTargets(product, PRODUCT_PRESETS[product], new Set(Object.keys(NATIVE_RUNTIME_TARGETS)), prefix);
  const rows = [];
  for (const target of [...new Set([...published, ...planned.keys()])].sort(compareText)) {
    const platform = NATIVE_RUNTIME_TARGETS[target];
    const publishedTarget = published.has(target);
    const row = {
      id: `${product}.${target}`,
      product,
      kind: "native-runtime",
      target,
      triple: platform.triple,
      runner: platform.runner,
      asset: archiveAsset("liboliphaunt", target, platform.archive ?? "tar.gz"),
      library_relative_path: nativeLibraryRelativePath(target),
      npm_package: platform.liboliphauntNpmPackage,
      npm_os: platform.npmOs,
      npm_cpu: platform.npmCpu,
      npm_libc: platform.npmLibc,
      surfaces: nativeSurfaces(target),
      published: publishedTarget,
      _source_file: "Moon release metadata",
    };
    if (!publishedTarget) {
      row.tier = "planned";
      row.unsupported_reason = planned.get(target).unsupportedReason;
    }
    rows.push(row);
  }
  rows.push(
    {
      id: `${product}.apple-spm-xcframework`,
      product,
      kind: "apple-swiftpm-binary",
      target: "apple-spm-xcframework",
      triple: "apple-xcframework",
      runner: "macos-latest",
      asset: "liboliphaunt-{version}-apple-spm-xcframework.zip",
      surfaces: ["github-release", "swiftpm"],
      published: true,
      _source_file: "Moon release metadata",
    },
    {
      id: `${product}.runtime-resources`,
      product,
      kind: "runtime-resources",
      target: "portable",
      asset: "liboliphaunt-{version}-runtime-resources.tar.gz",
      surfaces: ["github-release", "rust-native-direct", "typescript-native-direct", "swiftpm", "maven"],
      published: true,
      _source_file: "Moon release metadata",
    },
    {
      id: `${product}.icu-data`,
      product,
      kind: "icu-data",
      target: "portable",
      asset: "liboliphaunt-{version}-icu-data.tar.gz",
      npm_package: "@oliphaunt/icu",
      surfaces: [
        "github-release",
        "rust-native-direct",
        "typescript-native-direct",
        "swiftpm",
        "maven",
        "react-native-ios",
        "react-native-android",
      ],
      published: true,
      _source_file: "Moon release metadata",
    },
    {
      id: `${product}.package-size`,
      product,
      kind: "package-footprint",
      target: "portable",
      asset: "liboliphaunt-{version}-package-size.tsv",
      surfaces: [
        "github-release",
        "swiftpm",
        "maven",
        "react-native-ios",
        "react-native-android",
        "rust-native-direct",
        "typescript-native-direct",
      ],
      published: true,
      _source_file: "Moon release metadata",
    },
    {
      id: `${product}.checksums`,
      product,
      kind: "checksums",
      target: "portable",
      asset: "liboliphaunt-{version}-release-assets.sha256",
      surfaces: ["github-release"],
      published: true,
      _source_file: "Moon release metadata",
    },
  );
  for (const target of [...published].filter((item) => item in DESKTOP_TARGETS).sort(compareText)) {
    const platform = DESKTOP_TARGETS[target];
    rows.push({
      id: `${product}.tools-${target}`,
      product,
      kind: "native-tools",
      target,
      triple: platform.triple,
      runner: platform.runner,
      asset: archiveAsset("oliphaunt-tools", target, platform.archive),
      npm_package: platform.liboliphauntToolsNpmPackage,
      npm_os: platform.npmOs,
      npm_cpu: platform.npmCpu,
      npm_libc: platform.npmLibc,
      surfaces: ["github-release", "rust-native-direct", "typescript-native-direct"],
      published: true,
      _source_file: "Moon release metadata",
    });
  }
  return rows;
}

function liboliphauntWasixRows(prefix) {
  const product = "liboliphaunt-wasix";
  const published = new Set(publishedTargets(product, PRODUCT_PRESETS[product], WASIX_TARGETS, prefix));
  if (!published.has("portable")) {
    fail(prefix, `Moon release metadata for ${product} must publish the portable runtime target`);
  }
  const rows = [
    {
      id: `${product}.runtime-portable`,
      product,
      kind: "wasix-runtime",
      target: "portable",
      asset: "liboliphaunt-wasix-{version}-runtime-portable.tar.zst",
      surfaces: ["github-release"],
      published: true,
      _source_file: "Moon release metadata",
    },
    {
      id: `${product}.icu-data`,
      product,
      kind: "icu-data",
      target: "portable",
      asset: "liboliphaunt-wasix-{version}-icu-data.tar.zst",
      surfaces: ["github-release"],
      published: true,
      _source_file: "Moon release metadata",
    },
  ];
  for (const target of [...published].filter((item) => item !== "portable").sort(compareText)) {
    const platform = DESKTOP_TARGETS[target];
    rows.push({
      id: `${product}.aot-${target}`,
      product,
      kind: "wasix-aot-runtime",
      target,
      triple: platform.triple,
      runner: platform.runner,
      llvm_url: platform.wasixLlvmUrl,
      asset: `liboliphaunt-wasix-{version}-runtime-aot-${target}.tar.zst`,
      surfaces: ["github-release"],
      published: true,
      _source_file: "Moon release metadata",
    });
  }
  rows.push({
    id: `${product}.checksums`,
    product,
    kind: "checksums",
    target: "portable",
    asset: "liboliphaunt-wasix-{version}-release-assets.sha256",
    surfaces: ["github-release"],
    published: true,
    _source_file: "Moon release metadata",
  });
  return rows;
}

function brokerRows(prefix) {
  const product = "oliphaunt-broker";
  const rows = [];
  for (const target of publishedTargets(product, PRODUCT_PRESETS[product], BROKER_TARGETS, prefix).sort(compareText)) {
    const platform = DESKTOP_TARGETS[target];
    rows.push({
      id: `${product}.${target}`,
      product,
      kind: "broker-helper",
      target,
      triple: platform.triple,
      runner: platform.runner,
      asset: archiveAsset(product, target, platform.archive),
      executable_relative_path: target === "windows-x64-msvc" ? "bin/oliphaunt-broker.exe" : "bin/oliphaunt-broker",
      npm_package: platform.brokerNpmPackage,
      npm_os: platform.npmOs,
      npm_cpu: platform.npmCpu,
      npm_libc: platform.npmLibc,
      surfaces: ["github-release", "rust-broker", "typescript-broker"],
      published: true,
      _source_file: "Moon release metadata",
    });
  }
  rows.push({
    id: `${product}.checksums`,
    product,
    kind: "checksums",
    target: "portable",
    asset: "oliphaunt-broker-{version}-release-assets.sha256",
    surfaces: ["github-release", "rust-broker", "typescript-broker"],
    published: true,
    _source_file: "Moon release metadata",
  });
  return rows;
}

function nodeDirectRows(prefix) {
  const product = "oliphaunt-node-direct";
  const rows = [];
  for (const target of publishedTargets(product, PRODUCT_PRESETS[product], NODE_DIRECT_TARGETS, prefix).sort(compareText)) {
    const platform = DESKTOP_TARGETS[target];
    rows.push({
      id: `${product}.${target}`,
      product,
      kind: "node-direct-addon",
      target,
      triple: platform.triple,
      runner: platform.runner,
      asset: archiveAsset(product, target, platform.archive),
      library_relative_path: "oliphaunt_node.node",
      npm_package: platform.nodePackage,
      npm_os: platform.npmOs,
      npm_cpu: platform.npmCpu,
      npm_libc: platform.npmLibc,
      surfaces: ["github-release", "npm-optional"],
      published: true,
      _source_file: "Moon release metadata",
    });
  }
  rows.push({
    id: `${product}.checksums`,
    product,
    kind: "checksums",
    target: "portable",
    asset: "oliphaunt-node-direct-{version}-release-assets.sha256",
    surfaces: ["github-release"],
    published: true,
    _source_file: "Moon release metadata",
  });
  return rows;
}

function rawArtifactTargetRows(prefix) {
  return [
    ...liboliphauntNativeRows(prefix),
    ...liboliphauntWasixRows(prefix),
    ...brokerRows(prefix),
    ...nodeDirectRows(prefix),
  ];
}

function stringField(row, key, id, required, prefix) {
  const value = row[key];
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  if (required) {
    fail(prefix, `artifact target ${id}.${key} must be a non-empty string`);
  }
  if (value !== undefined && value !== null) {
    fail(prefix, `artifact target ${id}.${key} must be a string`);
  }
  return undefined;
}

function normalizeArtifactTarget(row, prefix) {
  const id = stringField(row, "id", "<unknown>", true, prefix);
  const target = {
    id,
    product: stringField(row, "product", id, true, prefix),
    kind: stringField(row, "kind", id, true, prefix),
    target: stringField(row, "target", id, true, prefix),
    asset: stringField(row, "asset", id, true, prefix),
    published: row.published,
    surfaces: assertStringList(row.surfaces, `${id}.surfaces`, prefix),
    triple: stringField(row, "triple", id, false, prefix),
    runner: stringField(row, "runner", id, false, prefix),
    libraryRelativePath: stringField(row, "library_relative_path", id, false, prefix),
    executableRelativePath: stringField(row, "executable_relative_path", id, false, prefix),
    npmPackage: stringField(row, "npm_package", id, false, prefix),
    npmOs: stringField(row, "npm_os", id, false, prefix),
    npmCpu: stringField(row, "npm_cpu", id, false, prefix),
    npmLibc: stringField(row, "npm_libc", id, false, prefix),
    llvmUrl: stringField(row, "llvm_url", id, false, prefix),
    extensionArtifacts: row.extension_artifacts ?? true,
  };
  if (typeof target.published !== "boolean") {
    fail(prefix, `artifact target ${id}.published must be true or false`);
  }
  if (typeof target.extensionArtifacts !== "boolean") {
    fail(prefix, `artifact target ${id}.extension_artifacts must be true or false`);
  }
  return target;
}

export function allArtifactTargets(
  {
    product = undefined,
    kind = undefined,
    surface = undefined,
    publishedOnly = false,
  } = {},
  prefix = "release-artifact-targets.mjs",
) {
  const products = graph(prefix).products;
  const seen = new Set();
  return rawArtifactTargetRows(prefix)
    .map((row) => normalizeArtifactTarget(row, prefix))
    .filter((target) => {
      if (seen.has(target.id)) {
        fail(prefix, `duplicate artifact target id ${target.id}`);
      }
      seen.add(target.id);
      if (!products[target.product]) {
        fail(prefix, `artifact target ${target.id} references unknown product ${target.product}`);
      }
      if (product !== undefined && target.product !== product) {
        return false;
      }
      if (kind !== undefined && target.kind !== kind) {
        return false;
      }
      if (surface !== undefined && !target.surfaces.includes(surface)) {
        return false;
      }
      if (publishedOnly && !target.published) {
        return false;
      }
      return true;
    });
}

export function artifactTargets(product, kind, prefix) {
  return allArtifactTargets({ product, kind, publishedOnly: true }, prefix);
}

export function releaseMetadata(product, prefix) {
  const release = graph(prefix).moon_projects?.[product]?.project?.metadata?.release;
  if (!release) {
    fail(prefix, `Moon release metadata does not include ${product}`);
  }
  if (release.component !== product) {
    fail(prefix, `Moon release metadata for ${product} must use matching component`);
  }
  if (typeof release.packagePath !== "string" || !release.packagePath) {
    fail(prefix, `Moon release metadata for ${product} must declare packagePath`);
  }
  const expectedPreset = PRODUCT_PRESETS[product];
  if (expectedPreset !== undefined) {
    const artifactTargets = release.artifactTargets;
    if (
      typeof artifactTargets !== "object" ||
      artifactTargets === null ||
      artifactTargets.preset !== expectedPreset
    ) {
      fail(prefix, `Moon release metadata for ${product} must use artifactTargets preset ${expectedPreset}`);
    }
  }
  return release;
}

function parseCargoVersion(text, file, prefix) {
  let inPackage = false;
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line === "[package]") {
      inPackage = true;
      continue;
    }
    if (inPackage && line.startsWith("[")) {
      break;
    }
    if (!inPackage) {
      continue;
    }
    const match = line.match(/^version\s*=\s*"([^"]+)"/u);
    if (match) {
      return match[1];
    }
  }
  fail(prefix, `${rel(file)} does not define a package version`);
}

async function readJson(file, prefix) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    fail(prefix, `failed to read ${rel(file)}: ${error.message}`);
  }
}

export async function currentProductVersion(product, prefix) {
  const release = releaseMetadata(product, prefix);
  const packagePath = release.packagePath;
  const config = await readJson(path.join(ROOT, "release-please-config.json"), prefix);
  const packageConfig = config.packages?.[packagePath];
  if (typeof packageConfig !== "object" || packageConfig === null) {
    fail(prefix, `release-please-config.json does not include ${packagePath}`);
  }
  const versionFile =
    packageConfig["version-file"] ??
    (packageConfig["release-type"] === "rust"
      ? "Cargo.toml"
      : packageConfig["release-type"] === "node"
        ? "package.json"
        : null);
  if (typeof versionFile !== "string" || !versionFile) {
    fail(prefix, `${product} release-please config must declare a supported version file`);
  }
  const file = path.join(ROOT, packagePath, versionFile);
  const text = await fs.readFile(file, "utf8");
  if (path.basename(versionFile) === "Cargo.toml") {
    return parseCargoVersion(text, file, prefix);
  }
  if (path.basename(versionFile) === "package.json") {
    const data = JSON.parse(text);
    if (typeof data.version === "string" && data.version) {
      return data.version;
    }
  } else if (path.basename(versionFile) === "VERSION") {
    const version = text.trim();
    if (version) {
      return version;
    }
  }
  fail(prefix, `${rel(file)} does not define a release version for ${product}`);
}

export function expectedAssets(product, kind, version, prefix) {
  const assets = artifactTargets(product, kind, prefix).map((target) =>
    target.asset.replaceAll("{version}", version),
  );
  assets.push(`${product}-${version}-release-assets.sha256`);
  return assets.sort(compareText);
}

export function exactExtensionProducts(prefix = "release-artifact-targets.mjs") {
  return Object.entries(graph(prefix).products)
    .filter(([, config]) => config.kind === "exact-extension-artifact")
    .map(([product]) => product)
    .sort(compareText);
}

function extensionSqlName(product, prefix) {
  const value = graph(prefix).products[product]?.extension_sql_name;
  if (typeof value !== "string" || !value) {
    fail(prefix, `${product} release.toml must declare extension_sql_name`);
  }
  return value;
}

function wasixExtensionTargetId(runtimeTarget) {
  return runtimeTarget === "portable" ? "wasix-portable" : runtimeTarget;
}

function defaultExtensionTargetRows(product, prefix) {
  const sourceFile = `${releaseMetadata(product, prefix).packagePath}/release.toml`;
  const rows = [];
  for (const target of allArtifactTargets(
    { product: "liboliphaunt-native", kind: "native-runtime", publishedOnly: true },
    prefix,
  )) {
    if (!target.extensionArtifacts) {
      continue;
    }
    rows.push({
      target: target.target,
      family: "native",
      kind: target.target === "ios-xcframework" || target.target.startsWith("android-")
        ? "native-static-registry"
        : "native-dynamic",
      status: "supported",
      published: true,
      _source_file: sourceFile,
    });
  }
  for (const target of allArtifactTargets(
    { product: "liboliphaunt-wasix", kind: "wasix-runtime", publishedOnly: true },
    prefix,
  )) {
    rows.push({
      target: wasixExtensionTargetId(target.target),
      family: "wasix",
      kind: "wasix-runtime",
      status: "supported",
      published: true,
      _source_file: sourceFile,
    });
  }
  if (rows.length === 0) {
    fail(prefix, `${product} could not derive any exact-extension artifact targets`);
  }
  return rows;
}

function readExtensionTargetRows(product, prefix) {
  const release = releaseMetadata(product, prefix);
  const relative = `${release.packagePath}/targets/artifacts.toml`;
  const file = path.join(ROOT, relative);
  if (!existsSync(file)) {
    return defaultExtensionTargetRows(product, prefix);
  }
  const data = Bun.TOML.parse(readFileSync(file, "utf8"));
  if (data.schema !== "oliphaunt-extension-artifact-targets-v1") {
    fail(prefix, `${relative} must use schema = "oliphaunt-extension-artifact-targets-v1"`);
  }
  if (!Array.isArray(data.targets) || data.targets.length === 0) {
    fail(prefix, `${relative} must define [[targets]] rows`);
  }
  const allowed = new Set(defaultExtensionTargetRows(product, prefix).map((row) => `${row.target}\0${row.family}\0${row.kind}`));
  for (const row of data.targets) {
    row._source_file = relative;
    if (!allowed.has(`${row.target}\0${row.family}\0${row.kind}`)) {
      fail(prefix, `${relative} target row ${row.target}/${row.family}/${row.kind} is not backed by runtime artifact metadata`);
    }
  }
  return data.targets;
}

function boolField(value, label, prefix) {
  if (typeof value === "boolean") {
    return value;
  }
  fail(prefix, `${label} must be true or false`);
}

function nonEmptyString(value, label, prefix) {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  fail(prefix, `${label} must be a non-empty string`);
}

export function extensionArtifactTargets(
  {
    product = undefined,
    family = undefined,
    publishedOnly = false,
  } = {},
  prefix = "release-artifact-targets.mjs",
) {
  const products = product === undefined ? exactExtensionProducts(prefix) : [product];
  const parsed = [];
  for (const productId of products) {
    if (!exactExtensionProducts(prefix).includes(productId)) {
      fail(prefix, `${productId} is not an exact-extension artifact product`);
    }
    const sqlName = extensionSqlName(productId, prefix);
    const seen = new Set();
    for (const [index, row] of readExtensionTargetRows(productId, prefix).entries()) {
      const source = row._source_file ?? releaseMetadata(productId, prefix).packagePath;
      const target = nonEmptyString(row.target, `${source} targets[${index}].target`, prefix);
      const targetFamily = nonEmptyString(row.family, `${source} targets[${index}].family`, prefix);
      const kind = nonEmptyString(row.kind, `${source} targets[${index}].kind`, prefix);
      const status = nonEmptyString(row.status, `${source} targets[${index}].status`, prefix);
      const published = boolField(row.published, `${source} targets[${index}].published`, prefix);
      if (!EXTENSION_FAMILIES.has(targetFamily)) {
        fail(prefix, `${source} target ${target} has invalid family ${targetFamily}`);
      }
      if (!EXTENSION_KINDS.has(kind)) {
        fail(prefix, `${source} target ${target} has invalid kind ${kind}`);
      }
      if (!EXTENSION_STATUSES.has(status)) {
        fail(prefix, `${source} target ${target} has invalid status ${status}`);
      }
      if (targetFamily === "wasix" && kind !== "wasix-runtime") {
        fail(prefix, `${source} target ${target} must use kind wasix-runtime for wasix family`);
      }
      if (targetFamily === "native" && kind === "wasix-runtime") {
        fail(prefix, `${source} target ${target} cannot use wasix-runtime for native family`);
      }
      if (published && status !== "supported") {
        fail(prefix, `${source} target ${target} cannot be published with status ${status}`);
      }
      const key = `${target}\0${targetFamily}\0${kind}`;
      if (seen.has(key)) {
        fail(prefix, `${source} has duplicate target row ${target}/${targetFamily}/${kind}`);
      }
      seen.add(key);
      if (family !== undefined && targetFamily !== family) {
        continue;
      }
      if (publishedOnly && !published) {
        continue;
      }
      parsed.push({
        product: productId,
        sqlName,
        sql_name: sqlName,
        target,
        family: targetFamily,
        kind,
        published,
        status,
      });
    }
  }
  return parsed;
}

export function publishedExtensionTargetIds({ family }, prefix = "release-artifact-targets.mjs") {
  return [...new Set(extensionArtifactTargets({ family, publishedOnly: true }, prefix).map((target) => target.target))]
    .sort(compareText);
}
