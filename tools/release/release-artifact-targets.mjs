import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  PLATFORM_COMPATIBILITY_POLICY,
  platformCompatibilityContract,
} from "./platform-compatibility-policy.mjs";
import {
  extensionNativeRegistryPackageStrings,
  extensionWasixRegistryPackageStrings,
} from "./extension-registry-packages.mjs";
import { loadContribCarriers } from "./contrib-carriers.mjs";
import {
  EXTENSION_TARGET_PROFILES_RELATIVE_PATH,
  loadExtensionTargetProfiles,
} from "./extension-target-profiles.mjs";
import { loadGraph } from "./release-graph.mjs";

export { PLATFORM_COMPATIBILITY_POLICY };

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
    wasixNapiPackage: "@oliphaunt/wasix-napi-linux-arm64-gnu",
    wasixLlvmUrl: "https://github.com/wasmerio/llvm-custom-builds/releases/download/22.x/llvm-linux-aarch64.tar.xz",
    wasixLlvmSha256: "1fddcf5b30f9d3e073eb161509220b4136ea8e2f114f23084bdec33e40fa87c1",
    wasixLlvmBytes: 668873496,
  },
  "linux-x64-gnu": {
    triple: "x86_64-unknown-linux-gnu",
    runner: "ubuntu-24.04",
    archive: "tar.gz",
    npmOs: "linux",
    npmCpu: "x64",
    npmLibc: "glibc",
    liboliphauntNpmPackage: "@oliphaunt/liboliphaunt-linux-x64-gnu",
    liboliphauntToolsNpmPackage: "@oliphaunt/tools-linux-x64-gnu",
    brokerNpmPackage: "@oliphaunt/broker-linux-x64-gnu",
    nodePackage: "@oliphaunt/node-direct-linux-x64-gnu",
    wasixNapiPackage: "@oliphaunt/wasix-napi-linux-x64-gnu",
    wasixLlvmUrl: "https://github.com/wasmerio/llvm-custom-builds/releases/download/22.x/llvm-linux-amd64.tar.xz",
    wasixLlvmSha256: "5fb1c687c5e895d517a23e7aabea9ec3557e3a3e33f8a8d3a8d21395157b3906",
    wasixLlvmBytes: 741670068,
  },
  "macos-arm64": {
    triple: "aarch64-apple-darwin",
    runner: "macos-26",
    archive: "tar.gz",
    npmOs: "darwin",
    npmCpu: "arm64",
    liboliphauntNpmPackage: "@oliphaunt/liboliphaunt-darwin-arm64",
    liboliphauntToolsNpmPackage: "@oliphaunt/tools-darwin-arm64",
    brokerNpmPackage: "@oliphaunt/broker-darwin-arm64",
    nodePackage: "@oliphaunt/node-direct-darwin-arm64",
    wasixNapiPackage: "@oliphaunt/wasix-napi-darwin-arm64",
    wasixLlvmUrl: "https://github.com/wasmerio/llvm-custom-builds/releases/download/22.x/llvm-darwin-aarch64.tar.xz",
    wasixLlvmSha256: "f64460f6c8a28876737402542fc5b28bb1f4262cef85f799b65ce2a7ee6f8847",
    wasixLlvmBytes: 479103872,
  },
  "macos-x64": {
    triple: "x86_64-apple-darwin",
    runner: "macos-26",
    archive: "tar.gz",
  },
  "windows-x64-msvc": {
    triple: "x86_64-pc-windows-msvc",
    runner: "windows-2025-vs2026",
    archive: "zip",
    npmOs: "win32",
    npmCpu: "x64",
    liboliphauntNpmPackage: "@oliphaunt/liboliphaunt-win32-x64-msvc",
    liboliphauntToolsNpmPackage: "@oliphaunt/tools-win32-x64-msvc",
    brokerNpmPackage: "@oliphaunt/broker-win32-x64-msvc",
    nodePackage: "@oliphaunt/node-direct-win32-x64-msvc",
    wasixNapiPackage: "@oliphaunt/wasix-napi-win32-x64-msvc",
    wasixLlvmUrl: "https://github.com/wasmerio/llvm-custom-builds/releases/download/22.x/llvm-windows-amd64.tar.xz",
    wasixLlvmSha256: "19ff22b0cf74b53dad2fc717db2209f8162b768fc6dede9e2caa6a83c724496e",
    wasixLlvmBytes: 757929860,
  },
};

export const MOBILE_TARGETS = {
  "android-arm64-v8a": {
    triple: "aarch64-linux-android",
    runner: "ubuntu-24.04",
    androidAbi: "arm64-v8a",
  },
  "android-x86_64": {
    triple: "x86_64-linux-android",
    runner: "ubuntu-24.04",
    androidAbi: "x86_64",
  },
  "ios-xcframework": {
    triple: "ios-xcframework",
    runner: "macos-26",
  },
};

const NATIVE_RUNTIME_TARGETS = { ...DESKTOP_TARGETS, ...MOBILE_TARGETS };
const RELEASE_HOST_TARGETS = Object.freeze([
  "linux-arm64-gnu",
  "linux-x64-gnu",
  "macos-arm64",
  "windows-x64-msvc",
]);
const WASIX_TARGETS = new Set(["portable", ...RELEASE_HOST_TARGETS]);
const WASIX_POSTMASTER_TARGETS = new Set(RELEASE_HOST_TARGETS);
const BROKER_TARGETS = new Set(RELEASE_HOST_TARGETS);
const NODE_DIRECT_TARGETS = BROKER_TARGETS;
const WASIX_NAPI_TARGETS = BROKER_TARGETS;
const PRODUCT_PRESETS = {
  "liboliphaunt-native": "liboliphaunt-native",
  "liboliphaunt-wasix": "liboliphaunt-wasix",
  "liboliphaunt-wasix-postmaster": "liboliphaunt-wasix-postmaster",
  "oliphaunt-broker": "broker-helper",
  "oliphaunt-node-direct": "node-direct-addon",
  "oliphaunt-wasix-napi": "wasix-napi-addon",
};
const EXTENSION_FAMILIES = new Set(["native", "wasix"]);
const EXTENSION_KINDS = new Set(["native-dynamic", "native-static-registry", "wasix-runtime"]);
const EXTENSION_VERSIONING_BY_CLASS = {
  contrib: "runtime-bound",
  external: "upstream-bound",
  "first-party": "repo-bound",
};
const EXTENSION_PRODUCT_KINDS = new Set(["exact-extension-artifact", "exact-extension-bundle"]);
const EXTENSION_CATALOG_PATH = path.join(ROOT, "src/extensions/generated/extensions.catalog.json");

const graphCache = new Map();
let extensionCatalogRowsCache;
let contribCarriersCache;

export function fail(prefix, message) {
  console.error(`${prefix}: ${message}`);
  process.exit(1);
}

function requiredBinaryCompatibility(target, use, prefix) {
  const contract = platformCompatibilityContract(target);
  if (contract === undefined) {
    fail(prefix, `${use} publishes ${target} without a platform compatibility contract`);
  }
  return contract;
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

export function contribCarrierDescriptor(prefix = "release-artifact-targets.mjs") {
  if (contribCarriersCache !== undefined) return contribCarriersCache;
  let value;
  try {
    value = loadContribCarriers(ROOT, prefix);
  } catch (error) {
    fail(prefix, error instanceof Error ? error.message.replace(`${prefix}: `, "") : String(error));
  }
  const descriptor = {
    ...value,
    sourcePath: value.source,
    runtimeContract: value.contract,
  };
  if (!descriptor.artifactProduct.startsWith("oliphaunt-extension-")) {
    fail(prefix, "contrib logical_product must be an extension artifact product");
  }
  for (const [family, owner] of [["native", descriptor.nativeOwner], ["wasix", descriptor.wasixOwner]]) {
    if (graph(prefix).products[owner] === undefined) {
      fail(prefix, `contrib ${family}_owner references unknown release product ${owner}`);
    }
  }
  contribCarriersCache = Object.freeze(descriptor);
  return contribCarriersCache;
}

export function extensionReleaseProduct(product, family, prefix = "release-artifact-targets.mjs") {
  if (!EXTENSION_FAMILIES.has(family)) {
    fail(prefix, `extension carrier family must be native or wasix, got ${JSON.stringify(family)}`);
  }
  const contrib = contribCarrierDescriptor(prefix);
  if (product === contrib.artifactProduct) {
    return family === "native" ? contrib.nativeOwner : contrib.wasixOwner;
  }
  if (!exactExtensionProducts(prefix).includes(product)) {
    fail(prefix, `${product} is not an exact-extension artifact product`);
  }
  return product;
}

export function extensionReleaseVersion(product, family, prefix = "release-artifact-targets.mjs") {
  return currentProductVersionSync(extensionReleaseProduct(product, family, prefix), prefix);
}

export function extensionArtifactProductRoot(
  product,
  family = "native",
  root = "target/extension-artifacts",
  prefix = "release-artifact-targets.mjs",
) {
  const releaseProduct = extensionReleaseProduct(product, family, prefix);
  return path.join(root, ...(releaseProduct === product ? [product] : [releaseProduct, product]));
}

export function extensionArtifactProductsForReleaseProducts(
  releaseProducts,
  { family = null, prefix = "release-artifact-targets.mjs" } = {},
) {
  if (!Array.isArray(releaseProducts) || releaseProducts.some((product) => typeof product !== "string" || !product)) {
    fail(prefix, "release products must be a string list");
  }
  if (family !== null && !EXTENSION_FAMILIES.has(family)) {
    fail(prefix, `extension carrier family must be native or wasix, got ${JSON.stringify(family)}`);
  }
  const selected = new Set(releaseProducts);
  const products = exactExtensionReleaseProducts(prefix).filter((product) => selected.has(product));
  const contrib = contribCarrierDescriptor(prefix);
  const selectedOwner = family === "native"
    ? selected.has(contrib.nativeOwner)
    : family === "wasix"
      ? selected.has(contrib.wasixOwner)
      : selected.has(contrib.nativeOwner) || selected.has(contrib.wasixOwner);
  if (selectedOwner) products.push(contrib.artifactProduct);
  return [...new Set(products)].sort(compareText);
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

function productTargets(product, expectedPreset, knownTargets, prefix) {
  const config = artifactTargetConfig(product, expectedPreset, prefix);
  const targets = assertStringList(config.targets ?? [], `${product}.targets`, prefix);
  const duplicates = [...new Set(targets.filter((target, index) => targets.indexOf(target) !== index))];
  if (duplicates.length > 0) {
    fail(prefix, `Moon release metadata for ${product} artifactTargets.targets contains duplicates`);
  }
  const unknown = targets.filter((target) => !knownTargets.has(target)).sort(compareText);
  if (unknown.length > 0) {
    fail(prefix, `Moon release metadata for ${product} declares unknown artifact target(s): ${unknown.join(", ")}`);
  }
  return targets;
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
  const targets = new Set(
    productTargets(product, PRODUCT_PRESETS[product], new Set(Object.keys(NATIVE_RUNTIME_TARGETS)), prefix),
  );
  const rows = [];
  for (const target of [...targets].sort(compareText)) {
    const platform = NATIVE_RUNTIME_TARGETS[target];
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
      binary_compatibility: requiredBinaryCompatibility(target, `${product} native runtime`, prefix),
      _source_file: "Moon release metadata",
    };
    rows.push(row);
  }
  rows.push(
    {
      id: `${product}.apple-spm-xcframework`,
      product,
      kind: "apple-swiftpm-binary",
      target: "apple-spm-xcframework",
      triple: "apple-xcframework",
      runner: "macos-26",
      asset: "liboliphaunt-{version}-apple-spm-xcframework.zip",
      surfaces: ["github-release", "swiftpm"],
      _source_file: "Moon release metadata",
    },
    {
      id: `${product}.runtime-resources-ios-datum64`,
      product,
      kind: "runtime-resources",
      target: "ios-datum64",
      asset: "liboliphaunt-{version}-runtime-resources-ios-datum64.tar.gz",
      surfaces: ["github-release", "react-native-ios"],
      _source_file: "Moon release metadata",
    },
    {
      id: `${product}.runtime-resources-android-datum64`,
      product,
      kind: "runtime-resources",
      target: "android-datum64",
      asset: "liboliphaunt-{version}-runtime-resources-android-datum64.tar.gz",
      surfaces: ["github-release", "maven", "react-native-android"],
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
      _source_file: "Moon release metadata",
    },
    {
      id: `${product}.checksums`,
      product,
      kind: "checksums",
      target: "portable",
      asset: "liboliphaunt-{version}-release-assets.sha256",
      surfaces: ["github-release"],
      _source_file: "Moon release metadata",
    },
  );
  for (const target of [...targets].filter((item) => item in DESKTOP_TARGETS).sort(compareText)) {
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
      binary_compatibility: requiredBinaryCompatibility(
        target,
        `${product} native tools`,
        prefix,
      ),
      _source_file: "Moon release metadata",
    });
  }
  return rows;
}

function liboliphauntWasixRows(prefix) {
  const product = "liboliphaunt-wasix";
  const targets = new Set(productTargets(product, PRODUCT_PRESETS[product], WASIX_TARGETS, prefix));
  if (!targets.has("portable")) {
    fail(prefix, `Moon release metadata for ${product} must include the portable runtime target`);
  }
  const rows = [
    {
      id: `${product}.runtime-portable`,
      product,
      kind: "wasix-runtime",
      target: "portable",
      asset: "liboliphaunt-wasix-{version}-runtime-portable.tar.zst",
      surfaces: ["github-release"],
      _source_file: "Moon release metadata",
    },
    {
      id: `${product}.icu-data`,
      product,
      kind: "icu-data",
      target: "portable",
      asset: "liboliphaunt-wasix-{version}-icu-data.tar.zst",
      surfaces: ["github-release"],
      _source_file: "Moon release metadata",
    },
  ];
  for (const target of [...targets].filter((item) => item !== "portable").sort(compareText)) {
    const platform = DESKTOP_TARGETS[target];
    rows.push({
      id: `${product}.aot-${target}`,
      product,
      kind: "wasix-aot-runtime",
      target,
      triple: platform.triple,
      runner: platform.runner,
      llvm_url: platform.wasixLlvmUrl,
      llvm_sha256: platform.wasixLlvmSha256,
      llvm_bytes: platform.wasixLlvmBytes,
      asset: `liboliphaunt-wasix-{version}-runtime-aot-${target}.tar.zst`,
      surfaces: ["github-release"],
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
    _source_file: "Moon release metadata",
  });
  return rows;
}

function liboliphauntWasixPostmasterRows(prefix) {
  const product = "liboliphaunt-wasix-postmaster";
  const rows = [];
  for (const target of productTargets(
    product,
    PRODUCT_PRESETS[product],
    WASIX_POSTMASTER_TARGETS,
    prefix,
  ).sort(compareText)) {
    const platform = DESKTOP_TARGETS[target];
    rows.push({
      id: `${product}.${target}`,
      product,
      kind: "wasix-postmaster-runtime",
      target,
      triple: platform.triple,
      runner: platform.runner,
      llvm_url: platform.wasixLlvmUrl,
      llvm_sha256: platform.wasixLlvmSha256,
      llvm_bytes: platform.wasixLlvmBytes,
      asset: `${product}-{version}-${target}.tar.zst`,
      surfaces: ["github-release"],
      binary_compatibility: requiredBinaryCompatibility(
        target,
        `${product} runtime`,
        prefix,
      ),
      extension_artifacts: false,
      _source_file: "Moon release metadata",
    });
  }
  rows.push({
    id: `${product}.checksums`,
    product,
    kind: "checksums",
    target: "portable",
    asset: `${product}-{version}-release-assets.sha256`,
    surfaces: ["github-release"],
    extension_artifacts: false,
    _source_file: "Moon release metadata",
  });
  return rows;
}

function brokerRows(prefix) {
  const product = "oliphaunt-broker";
  const rows = [];
  for (const target of productTargets(product, PRODUCT_PRESETS[product], BROKER_TARGETS, prefix).sort(compareText)) {
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
      binary_compatibility: requiredBinaryCompatibility(target, `${product} broker`, prefix),
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
    _source_file: "Moon release metadata",
  });
  return rows;
}

function nodeDirectRows(prefix) {
  const product = "oliphaunt-node-direct";
  const rows = [];
  for (const target of productTargets(product, PRODUCT_PRESETS[product], NODE_DIRECT_TARGETS, prefix).sort(compareText)) {
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
      binary_compatibility: requiredBinaryCompatibility(target, `${product} Node addon`, prefix),
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
    _source_file: "Moon release metadata",
  });
  return rows;
}

function wasixNapiRows(prefix) {
  const product = "oliphaunt-wasix-napi";
  const rows = [];
  for (const target of productTargets(product, PRODUCT_PRESETS[product], WASIX_NAPI_TARGETS, prefix).sort(compareText)) {
    const platform = DESKTOP_TARGETS[target];
    rows.push({
      id: `${product}.${target}`,
      product,
      kind: "wasix-napi-addon",
      target,
      triple: platform.triple,
      runner: platform.runner,
      asset: archiveAsset(product, target, platform.archive),
      library_relative_path: "oliphaunt_wasix_napi.node",
      npm_package: platform.wasixNapiPackage,
      npm_os: platform.npmOs,
      npm_cpu: platform.npmCpu,
      npm_libc: platform.npmLibc,
      surfaces: ["github-release", "npm-optional"],
      binary_compatibility: requiredBinaryCompatibility(target, `${product} Node-API addon`, prefix),
      extension_artifacts: false,
      _source_file: "Moon release metadata",
    });
  }
  rows.push({
    id: `${product}.checksums`,
    product,
    kind: "checksums",
    target: "portable",
    asset: "oliphaunt-wasix-napi-{version}-release-assets.sha256",
    surfaces: ["github-release"],
    extension_artifacts: false,
    _source_file: "Moon release metadata",
  });
  return rows;
}

export function rawArtifactTargetRows(prefix = "release-artifact-targets.mjs") {
  return [
    ...liboliphauntNativeRows(prefix),
    ...liboliphauntWasixRows(prefix),
    ...liboliphauntWasixPostmasterRows(prefix),
    ...brokerRows(prefix),
    ...nodeDirectRows(prefix),
    ...wasixNapiRows(prefix),
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

function positiveIntegerField(row, key, id, required, prefix) {
  const value = row[key];
  if (Number.isSafeInteger(value) && value > 0) return value;
  if (required || (value !== undefined && value !== null)) {
    fail(prefix, `artifact target ${id}.${key} must be a positive safe integer`);
  }
  return undefined;
}

function normalizeArtifactTarget(row, prefix) {
  const id = stringField(row, "id", "<unknown>", true, prefix);
  const libraryRelativePath = stringField(row, "library_relative_path", id, false, prefix);
  const executableRelativePath = stringField(row, "executable_relative_path", id, false, prefix);
  const npmPackage = stringField(row, "npm_package", id, false, prefix);
  const npmOs = stringField(row, "npm_os", id, false, prefix);
  const npmCpu = stringField(row, "npm_cpu", id, false, prefix);
  const npmLibc = stringField(row, "npm_libc", id, false, prefix);
  const llvmUrl = stringField(row, "llvm_url", id, false, prefix);
  const llvmSha256 = stringField(row, "llvm_sha256", id, false, prefix);
  const llvmBytes = positiveIntegerField(row, "llvm_bytes", id, false, prefix);
  const sourceFile =
    stringField(row, "_source_file", id, false, prefix) ??
    stringField(row, "source_file", id, false, prefix);
  const unsupportedReason = stringField(row, "unsupported_reason", id, false, prefix);
  const binaryCompatibility = row.binary_compatibility;
  if (
    binaryCompatibility !== undefined &&
    (binaryCompatibility === null ||
      typeof binaryCompatibility !== "object" ||
      Array.isArray(binaryCompatibility))
  ) {
    fail(prefix, `artifact target ${id}.binary_compatibility must be an object`);
  }
  const target = {
    id,
    product: stringField(row, "product", id, true, prefix),
    kind: stringField(row, "kind", id, true, prefix),
    target: stringField(row, "target", id, true, prefix),
    asset: stringField(row, "asset", id, true, prefix),
    surfaces: assertStringList(row.surfaces, `${id}.surfaces`, prefix),
    triple: stringField(row, "triple", id, false, prefix),
    runner: stringField(row, "runner", id, false, prefix),
    libraryRelativePath,
    executableRelativePath,
    npmPackage,
    npmOs,
    npmCpu,
    npmLibc,
    llvmUrl,
    llvmSha256,
    llvmBytes,
    binaryCompatibility,
    extensionArtifacts: row.extension_artifacts ?? true,
    sourceFile,
    tier: stringField(row, "tier", id, false, prefix),
    unsupportedReason,
    library_relative_path: libraryRelativePath,
    executable_relative_path: executableRelativePath,
    npm_package: npmPackage,
    npm_os: npmOs,
    npm_cpu: npmCpu,
    npm_libc: npmLibc,
    llvm_url: llvmUrl,
    llvm_sha256: llvmSha256,
    llvm_bytes: llvmBytes,
    binary_compatibility: binaryCompatibility,
    extension_artifacts: row.extension_artifacts ?? true,
    source_file: sourceFile,
    unsupported_reason: unsupportedReason,
  };
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
      return true;
    });
}

export function typescriptOptionalRuntimePackageProducts(prefix = "release-artifact-targets.mjs") {
  const selected = allArtifactTargets({}, prefix).filter((target) => {
    if (target.product === "oliphaunt-broker" && target.kind === "broker-helper") {
      return target.surfaces.includes("typescript-broker");
    }
    if (target.product === "liboliphaunt-native" && target.kind === "native-runtime") {
      return target.surfaces.includes("typescript-native-direct");
    }
    if (target.product === "oliphaunt-node-direct" && target.kind === "node-direct-addon") {
      return target.surfaces.includes("npm-optional");
    }
    return false;
  });
  if (selected.length === 0) {
    fail(prefix, "no TypeScript optional runtime package targets found");
  }
  const rows = [];
  const seen = new Set();
  for (const target of selected) {
    if (typeof target.npmPackage !== "string" || !target.npmPackage) {
      fail(prefix, `${target.id} must declare npmPackage for TypeScript optional dependencies`);
    }
    if (seen.has(target.npmPackage)) {
      fail(prefix, `duplicate TypeScript optional package target ${target.npmPackage}`);
    }
    seen.add(target.npmPackage);
    rows.push({
      packageName: target.npmPackage,
      product: target.product,
      target: target.target,
      kind: target.kind,
      artifactTarget: target.id,
    });
  }
  return rows.sort((left, right) => compareText(left.packageName, right.packageName));
}

export function nativeToolsOptionalPackageProducts(prefix = "release-artifact-targets.mjs") {
  const selected = allArtifactTargets(
    { product: "liboliphaunt-native", kind: "native-tools" },
    prefix,
  );
  if (selected.length === 0) {
    fail(prefix, "no native tools optional package targets found");
  }
  return selected
    .map((target) => {
      if (typeof target.npmPackage !== "string" || !target.npmPackage) {
        fail(prefix, `${target.id} must declare npmPackage for the native tools facade`);
      }
      return {
        packageName: target.npmPackage,
        product: target.product,
        target: target.target,
        kind: target.kind,
        artifactTarget: target.id,
      };
    })
    .sort((left, right) => compareText(left.packageName, right.packageName));
}

export function artifactTargets(product, kind, prefix) {
  return allArtifactTargets({ product, kind }, prefix);
}

function ciArtifactRows({ product, kind, surface, family, name }, prefix) {
  const targets = allArtifactTargets({ product, kind, surface }, prefix);
  if (targets.length === 0) {
    fail(prefix, `${product} has no ${kind} CI ${family} artifact targets`);
  }
  return targets
    .map((target) => ({
      family,
      product,
      target: target.target,
      kind: target.kind,
      artifactTarget: target.id,
      artifactName: name(target),
    }))
    .sort((left, right) => compareText(left.artifactName, right.artifactName));
}

export function ciReleaseAssetArtifactRows(product, kind, prefix = "release-artifact-targets.mjs") {
  return ciArtifactRows({
    product,
    kind,
    surface: "github-release",
    family: "release-assets",
    name: (target) => `${product}-release-assets-${target.target}`,
  }, prefix);
}

export function ciNpmPackageArtifactRows(product, kind, prefix = "release-artifact-targets.mjs") {
  return ciArtifactRows({
    product,
    kind,
    surface: "npm-optional",
    family: "npm-package",
    name: (target) => `${product}-npm-package-${target.target}`,
  }, prefix);
}

export function expectedAssetRows(
  {
    product,
    version,
    surface = "github-release",
    kinds = undefined,
  } = {},
  prefix = "release-artifact-targets.mjs",
) {
  if (typeof product !== "string" || product.length === 0) {
    fail(prefix, "expected asset rows require a product");
  }
  if (typeof version !== "string" || version.length === 0) {
    fail(prefix, "expected asset rows require a version");
  }
  const kindSet = kinds === undefined ? undefined : new Set(kinds);
  if (
    kindSet !== undefined
    && (kindSet.size === 0 || [...kindSet].some((kind) => typeof kind !== "string" || kind.length === 0))
  ) {
    fail(prefix, "expected asset row kinds must be a non-empty string list");
  }
  const rows = allArtifactTargets({ product, surface }, prefix)
    .filter((target) => kindSet === undefined || kindSet.has(target.kind))
    .map((target) => ({
      product: target.product,
      kind: target.kind,
      target: target.target,
      surface,
      artifactTarget: target.id,
      assetName: target.asset.replaceAll("{version}", version),
    }))
    .sort((left, right) => compareText(left.assetName, right.assetName));
  if (rows.length === 0) {
    fail(prefix, `${product} has no artifact targets for surface ${surface}`);
  }
  const names = rows.map((row) => row.assetName);
  const duplicates = [...new Set(names.filter((name, index) => names.indexOf(name) !== index))].sort(compareText);
  if (duplicates.length > 0) {
    fail(prefix, `${product} has duplicate expected asset names: ${duplicates.join(", ")}`);
  }
  return rows;
}

export function registryPackageRows(
  {
    product,
    packageKind = undefined,
  } = {},
  prefix = "release-artifact-targets.mjs",
) {
  if (typeof product !== "string" || product.length === 0) {
    fail(prefix, "registry package rows require a product");
  }
  if (
    packageKind !== undefined
    && (typeof packageKind !== "string" || packageKind.length === 0)
  ) {
    fail(prefix, "registry package kind must be a non-empty string");
  }
  const config = productConfig(product, prefix);
  const declaredEntries = config.registry_packages ?? [];
  if (!Array.isArray(declaredEntries) || declaredEntries.some((entry) => typeof entry !== "string")) {
    fail(prefix, `${product}.registry_packages must be a string list`);
  }
  const entries = [...declaredEntries];
  const contrib = contribCarrierDescriptor(prefix);
  if (product === contrib.nativeOwner || product === contrib.wasixOwner) {
    const targets = extensionRegistryPackageTargetSets(contrib.artifactProduct, prefix);
    if (product === contrib.nativeOwner) {
      entries.push(...extensionNativeRegistryPackageStrings({
        product: contrib.artifactProduct,
        androidTargets: targets.androidTargets,
        npmTargets: targets.npmTargets,
        nativeCargoTargets: targets.nativeCargoTargets,
      }));
    }
    if (product === contrib.wasixOwner) {
      entries.push(...extensionWasixRegistryPackageStrings({
        product: contrib.artifactProduct,
        includeAot: targets.includeWasixAot,
      }));
    }
  }
  const rows = [];
  const seen = new Set();
  for (const raw of entries) {
    const separator = raw.indexOf(":");
    if (separator <= 0 || separator === raw.length - 1) {
      fail(prefix, `${product}.registry_packages entry ${JSON.stringify(raw)} must use kind:name`);
    }
    const kind = raw.slice(0, separator);
    const packageName = raw.slice(separator + 1);
    const key = `${kind}\0${packageName}`;
    if (seen.has(key)) {
      fail(prefix, `${product} declares duplicate ${kind} registry package ${packageName}`);
    }
    seen.add(key);
    if (packageKind !== undefined && kind !== packageKind) {
      continue;
    }
    rows.push({
      product,
      packageKind: kind,
      packageName,
      raw,
    });
  }
  return rows.sort((left, right) =>
    compareText(left.packageKind, right.packageKind)
    || compareText(left.packageName, right.packageName)
  );
}

export function releaseMetadata(product, prefix) {
  const release = graph(prefix).moon_projects?.[product]?.config?.project?.metadata?.release;
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

const versionCache = new Map();

export function currentProductVersionSync(product, prefix = "release-artifact-targets.mjs") {
  const key = `${prefix}\0${product}`;
  if (!versionCache.has(key)) {
    const versionFile = productConfig(product, prefix).version_files?.[0];
    if (typeof versionFile !== "string" || !versionFile) {
      fail(prefix, `${product} does not declare a canonical version file`);
    }
    const file = path.join(ROOT, versionFile);
    const text = readFileSync(file, "utf8");
    const name = path.basename(file);
    let version = "";
    if (name === "Cargo.toml") {
      version = parseCargoVersion(text, file, prefix);
    } else if (name === "package.json") {
      const data = JSON.parse(text);
      version = typeof data.version === "string" ? data.version : "";
    } else if (name === "gradle.properties") {
      for (const rawLine of text.split(/\r?\n/u)) {
        const line = rawLine.trim();
        if (!line || line.startsWith("#") || !line.includes("=")) {
          continue;
        }
        const [property, ...rest] = line.split("=");
        if (property.trim() === "VERSION_NAME") {
          version = rest.join("=").trim();
          break;
        }
      }
    } else if (name === "VERSION" || name === "LIBOLIPHAUNT_VERSION") {
      version = text.trim();
    } else {
      fail(prefix, `${product}.version_files has unsupported version file type: ${versionFile}`);
    }
    if (!version) {
      fail(prefix, `${versionFile} does not define a release version for ${product}`);
    }
    versionCache.set(key, version);
  }
  return versionCache.get(key);
}

export async function currentProductVersion(product, prefix = "release-artifact-targets.mjs") {
  return currentProductVersionSync(product, prefix);
}

export function expectedAssets(product, kind, version, prefix) {
  const assets = expectedAssetRows({ product, version, kinds: [kind] }, prefix)
    .map((row) => row.assetName);
  assets.push(`${product}-${version}-release-assets.sha256`);
  return assets.sort(compareText);
}

function productConfig(product, prefix) {
  const config = graph(prefix).products[product];
  if (!config) {
    fail(prefix, `unknown release product ${product}`);
  }
  return config;
}

export function exactExtensionProducts(prefix = "release-artifact-targets.mjs") {
  const products = Object.entries(graph(prefix).products)
    .filter(([, config]) => EXTENSION_PRODUCT_KINDS.has(config.kind))
    .map(([product]) => product);
  products.push(contribCarrierDescriptor(prefix).artifactProduct);
  return [...new Set(products)].sort(compareText);
}

export function exactExtensionReleaseProducts(prefix = "release-artifact-targets.mjs") {
  return Object.entries(graph(prefix).products)
    .filter(([, config]) => EXTENSION_PRODUCT_KINDS.has(config.kind))
    .map(([product]) => product)
    .sort(compareText);
}

export function sdkPackageProducts(prefix = "release-artifact-targets.mjs") {
  const rows = Object.entries(graph(prefix).products)
    .filter(([, config]) => config.kind === "sdk")
    .map(([product]) => ({
      product,
      artifactName: product === "oliphaunt-wasix-rust"
        ? `${product}-package-artifacts`
        : `${product}-sdk-package-artifacts`,
    }))
    .sort((left, right) => compareText(left.product, right.product));
  if (rows.length === 0) {
    fail(prefix, "release graph contains no SDK package products");
  }
  return rows;
}

export function extensionSqlName(product, prefix = "release-artifact-targets.mjs") {
  const names = extensionSqlNames(product, prefix);
  if (names.length !== 1) {
    fail(prefix, `${product} owns ${names.length} exact extension members; use extensionSqlNames(product)`);
  }
  return names[0];
}

function contribMemberRows(product, prefix) {
  const descriptor = contribCarrierDescriptor(prefix);
  if (product !== descriptor.artifactProduct) {
    fail(prefix, `${product} is not the shared PostgreSQL contrib artifact product`);
  }
  const manifestPath = descriptor.memberManifest;
  const memberRoot = path.posix.dirname(manifestPath);
  const rows = [];
  const seenSqlNames = new Set();
  const seenIds = new Set();
  for (const [index, row] of descriptor.members.entries()) {
    if (row === null || Array.isArray(row) || typeof row !== "object") {
      fail(prefix, `${manifestPath}.extensions[${index}] must be a table`);
    }
    const id = nonEmptyString(row.id, `${manifestPath}.extensions[${index}].id`, prefix);
    const sqlName = nonEmptyString(row["sql-name"], `${manifestPath}.extensions[${index}].sql-name`, prefix);
    if (seenIds.has(id) || seenSqlNames.has(sqlName)) {
      fail(prefix, `${manifestPath} contains duplicate contrib member id or SQL name: ${id}/${sqlName}`);
    }
    seenIds.add(id);
    seenSqlNames.add(sqlName);
    rows.push({ id, sqlName, path: memberRoot });
  }
  return rows;
}

export function extensionSqlNames(product, prefix = "release-artifact-targets.mjs") {
  const contrib = contribCarrierDescriptor(prefix);
  if (product === contrib.artifactProduct) {
    return contribMemberRows(product, prefix).map((row) => row.sqlName).sort(compareText);
  }
  const config = productConfig(product, prefix);
  if (config.kind === "exact-extension-artifact") {
    const value = config.extension_sql_name;
    if (typeof value !== "string" || !value) {
      fail(prefix, `${product} release.toml must declare extension_sql_name`);
    }
    if (config.extension_sql_names !== undefined) {
      fail(prefix, `${product} singleton release metadata must not declare extension_sql_names`);
    }
    return [value];
  }
  if (config.kind !== "exact-extension-bundle") {
    fail(prefix, `${product} is not an exact-extension product`);
  }
  const values = config.extension_sql_names;
  if (!Array.isArray(values) || values.length < 2 || values.some((value) => typeof value !== "string" || !value)) {
    fail(prefix, `${product} exact-extension bundle must declare at least two extension_sql_names`);
  }
  const sorted = [...values].sort(compareText);
  if (new Set(sorted).size !== sorted.length || JSON.stringify(values) !== JSON.stringify(sorted)) {
    fail(prefix, `${product}.extension_sql_names must be unique and sorted`);
  }
  const manifestNames = contribMemberRows(product, prefix).map((row) => row.sqlName).sort(compareText);
  if (JSON.stringify(sorted) !== JSON.stringify(manifestNames)) {
    fail(prefix, `${product}.extension_sql_names must exactly match ${config.extension.member_manifest}`);
  }
  return sorted;
}

function extensionCatalogRows(prefix) {
  if (extensionCatalogRowsCache !== undefined) return extensionCatalogRowsCache;
  let catalog;
  try {
    catalog = JSON.parse(readFileSync(EXTENSION_CATALOG_PATH, "utf8"));
  } catch (error) {
    fail(prefix, `${rel(EXTENSION_CATALOG_PATH)} is not readable JSON: ${error.message}`);
  }
  if (catalog?.["format-version"] !== 1 || !Array.isArray(catalog.extensions)) {
    fail(prefix, `${rel(EXTENSION_CATALOG_PATH)} must use format-version 1 and define extension rows`);
  }
  const bySqlName = new Map();
  for (const [index, row] of catalog.extensions.entries()) {
    const sqlName = row?.["sql-name"];
    if (typeof sqlName !== "string" || !sqlName) {
      fail(prefix, `${rel(EXTENSION_CATALOG_PATH)} extension row ${index} has no SQL name`);
    }
    if (bySqlName.has(sqlName)) {
      fail(prefix, `${rel(EXTENSION_CATALOG_PATH)} repeats SQL extension ${sqlName}`);
    }
    const moduleFile = row["native-module-file"];
    if (moduleFile !== undefined && (typeof moduleFile !== "string" || !moduleFile)) {
      fail(prefix, `${rel(EXTENSION_CATALOG_PATH)} ${sqlName}.native-module-file must be a non-empty string when present`);
    }
    bySqlName.set(sqlName, row);
  }
  extensionCatalogRowsCache = bySqlName;
  return extensionCatalogRowsCache;
}

export function extensionPublicDependencySqlNames(
  sqlName,
  prefix = "release-artifact-targets.mjs",
) {
  nonEmptyString(sqlName, "extension SQL name", prefix);
  const rows = extensionCatalogRows(prefix);
  const row = rows.get(sqlName);
  if (row === undefined) {
    fail(prefix, `${sqlName} is absent from ${rel(EXTENSION_CATALOG_PATH)}`);
  }
  const dependencies = row.dependencies ?? [];
  if (!Array.isArray(dependencies) || dependencies.some((value) => typeof value !== "string" || !value)) {
    fail(prefix, `${rel(EXTENSION_CATALOG_PATH)} ${sqlName}.dependencies must be an array of SQL names`);
  }
  return [...new Set(dependencies.filter((dependency) => rows.has(dependency)))].sort(compareText);
}

export function extensionWasixAotMemberSqlNames(product, prefix = "release-artifact-targets.mjs") {
  const rows = extensionCatalogRows(prefix);
  return extensionSqlNames(product, prefix).filter((sqlName) => {
    const row = rows.get(sqlName);
    if (row === undefined) {
      fail(prefix, `${product} member ${sqlName} is absent from ${rel(EXTENSION_CATALOG_PATH)}`);
    }
    return typeof row["native-module-file"] === "string";
  });
}

export function extensionProductForSqlName(sqlName, prefix = "release-artifact-targets.mjs") {
  nonEmptyString(sqlName, "extension SQL name", prefix);
  const owners = exactExtensionProducts(prefix).filter((product) => extensionSqlNames(product, prefix).includes(sqlName));
  if (owners.length !== 1) {
    fail(prefix, `extension SQL name ${JSON.stringify(sqlName)} must have exactly one release product owner, found ${owners.join(", ") || "none"}`);
  }
  return owners[0];
}

export function extensionReleaseProductForSqlName(
  sqlName,
  family = "native",
  prefix = "release-artifact-targets.mjs",
) {
  return extensionReleaseProduct(extensionProductForSqlName(sqlName, prefix), family, prefix);
}

export function extensionMemberPath(product, sqlName, prefix = "release-artifact-targets.mjs") {
  if (!extensionSqlNames(product, prefix).includes(sqlName)) {
    fail(prefix, `${product} does not own extension SQL name ${JSON.stringify(sqlName)}`);
  }
  const contrib = contribCarrierDescriptor(prefix);
  if (product === contrib.artifactProduct) {
    const row = contribMemberRows(product, prefix).find((candidate) => candidate.sqlName === sqlName);
    if (row === undefined) {
      fail(prefix, `${product} member manifest has no row for ${JSON.stringify(sqlName)}`);
    }
    return releaseMetadataRelativePath(row.path, `${product} member ${sqlName}`, prefix);
  }
  const config = productConfig(product, prefix);
  if (config.kind === "exact-extension-artifact") {
    return packagePath(product, prefix);
  }
  fail(prefix, `${product} exact-extension bundle has no shared member descriptor`);
}

function releaseMetadataRelativePath(value, context, prefix) {
  const candidate = path.normalize(value).split(path.sep).join("/");
  if (path.isAbsolute(value) || candidate.split("/").includes("..")) {
    fail(prefix, `${context} must be a repository-relative path: ${JSON.stringify(value)}`);
  }
  if (!existsSync(path.join(ROOT, candidate))) {
    fail(prefix, `${context} path does not exist: ${candidate}`);
  }
  return candidate;
}

function packagePath(product, prefix) {
  return releaseMetadataRelativePath(
    nonEmptyString(productConfig(product, prefix).path, `${product}.path`, prefix),
    `${product}.path`,
    prefix,
  );
}

export function extensionMetadata(product, prefix = "release-artifact-targets.mjs") {
  const contrib = contribCarrierDescriptor(prefix);
  if (product === contrib.artifactProduct) {
    const source = Bun.TOML.parse(readFileSync(path.join(ROOT, contrib.sourcePath), "utf8"));
    const postgresVersion = nonEmptyString(
      source?.postgresql?.version,
      `${contrib.sourcePath}.postgresql.version`,
      prefix,
    );
    const postgresMajor = postgresVersion.split(".")[0];
    if (!/^[1-9][0-9]*$/u.test(postgresMajor)) {
      fail(prefix, `${contrib.sourcePath}.postgresql.version must begin with a stable major version`);
    }
    return {
      sqlName: undefined,
      sqlNames: extensionSqlNames(product, prefix),
      class: "contrib",
      versioning: "runtime-bound",
      sourcePath: contrib.sourcePath,
      artifactProduct: contrib.artifactProduct,
      compatibility: {
        postgresMajor,
        extensionRuntimeContract: contrib.runtimeContract,
        nativeRuntimeProduct: contrib.nativeOwner,
        nativeRuntimeVersion: currentProductVersionSync(contrib.nativeOwner, prefix),
        wasixRuntimeProduct: contrib.wasixOwner,
        wasixRuntimeVersion: currentProductVersionSync(contrib.wasixOwner, prefix),
      },
    };
  }
  const config = productConfig(product, prefix);
  if (!EXTENSION_PRODUCT_KINDS.has(config.kind)) {
    fail(prefix, `${product} is not an exact-extension product`);
  }
  const sqlNames = extensionSqlNames(product, prefix);
  const metadata = config.extension;
  if (metadata === null || Array.isArray(metadata) || typeof metadata !== "object") {
    fail(prefix, `${product} release metadata must declare [extension]`);
  }
  let sqlName;
  if (config.kind === "exact-extension-artifact") {
    sqlName = nonEmptyString(metadata.sql_name, `${product}.extension.sql_name`, prefix);
    if (sqlName !== sqlNames[0]) {
      fail(prefix, `${product}.extension.sql_name ${JSON.stringify(sqlName)} must match extension_sql_name ${JSON.stringify(sqlNames[0])}`);
    }
    if (metadata.member_manifest !== undefined) {
      fail(prefix, `${product} singleton extension metadata must not declare member_manifest`);
    }
  } else {
    if (metadata.sql_name !== undefined) {
      fail(prefix, `${product} extension bundle must not declare extension.sql_name`);
    }
    fail(prefix, `${product} extension bundle has no shared member descriptor`);
  }
  const extensionClass = nonEmptyString(metadata.class, `${product}.extension.class`, prefix);
  if (!(extensionClass in EXTENSION_VERSIONING_BY_CLASS)) {
    fail(prefix, `${product}.extension.class must be one of ${Object.keys(EXTENSION_VERSIONING_BY_CLASS).sort(compareText).join(", ")}`);
  }
  const versioning = nonEmptyString(metadata.versioning, `${product}.extension.versioning`, prefix);
  const expectedVersioning = EXTENSION_VERSIONING_BY_CLASS[extensionClass];
  if (versioning !== expectedVersioning) {
    fail(prefix, `${product}.extension.versioning must be ${JSON.stringify(expectedVersioning)} for class ${JSON.stringify(extensionClass)}, got ${JSON.stringify(versioning)}`);
  }
  const source = metadata.source;
  if (source === null || Array.isArray(source) || typeof source !== "object") {
    fail(prefix, `${product}.extension must declare [extension.source]`);
  }
  const sourcePath = releaseMetadataRelativePath(
    nonEmptyString(source.path, `${product}.extension.source.path`, prefix),
    `${product}.extension.source.path`,
    prefix,
  );
  const packageRoot = packagePath(product, prefix);
  if (extensionClass === "contrib" && sourcePath !== contrib.sourcePath) {
    fail(prefix, `${product}.extension.source.path must match the shared contrib source ${JSON.stringify(contrib.sourcePath)}`);
  }
  if (extensionClass === "external" && sourcePath !== `${packageRoot}/source.toml`) {
    fail(prefix, `${product}.extension.source.path must be ${packageRoot}/source.toml for external extensions`);
  }
  if (extensionClass === "first-party" && !(sourcePath === packageRoot || sourcePath.startsWith(`${packageRoot}/`))) {
    fail(prefix, `${product}.extension.source.path must stay inside ${packageRoot}/ for first-party extensions`);
  }

  const compatibility = metadata.compatibility;
  if (compatibility === null || Array.isArray(compatibility) || typeof compatibility !== "object") {
    fail(prefix, `${product}.extension must declare [extension.compatibility]`);
  }
  const postgresMajor = nonEmptyString(compatibility.postgres_major, `${product}.extension.compatibility.postgres_major`, prefix);
  if (postgresMajor !== "18") {
    fail(prefix, `${product}.extension.compatibility.postgres_major must be '18', got ${JSON.stringify(postgresMajor)}`);
  }
  const contractPath = releaseMetadataRelativePath(
    nonEmptyString(compatibility.extension_runtime_contract, `${product}.extension.compatibility.extension_runtime_contract`, prefix),
    `${product}.extension.compatibility.extension_runtime_contract`,
    prefix,
  );
  if (contractPath !== contrib.runtimeContract) {
    fail(prefix, `${product}.extension.compatibility.extension_runtime_contract must match ${JSON.stringify(contrib.runtimeContract)}`);
  }
  const nativeProduct = nonEmptyString(compatibility.native_runtime_product, `${product}.extension.compatibility.native_runtime_product`, prefix);
  const wasixProduct = nonEmptyString(compatibility.wasix_runtime_product, `${product}.extension.compatibility.wasix_runtime_product`, prefix);
  if (nativeProduct !== "liboliphaunt-native") {
    fail(prefix, `${product}.extension.compatibility.native_runtime_product must be 'liboliphaunt-native'`);
  }
  if (wasixProduct !== "liboliphaunt-wasix") {
    fail(prefix, `${product}.extension.compatibility.wasix_runtime_product must be 'liboliphaunt-wasix'`);
  }
  const nativeVersion = nonEmptyString(compatibility.native_runtime_version, `${product}.extension.compatibility.native_runtime_version`, prefix);
  const wasixVersion = nonEmptyString(compatibility.wasix_runtime_version, `${product}.extension.compatibility.wasix_runtime_version`, prefix);
  const expectedNativeVersion = currentProductVersionSync(nativeProduct, prefix);
  const expectedWasixVersion = currentProductVersionSync(wasixProduct, prefix);
  if (nativeVersion !== expectedNativeVersion) {
    fail(prefix, `${product}.extension.compatibility.native_runtime_version must be ${JSON.stringify(expectedNativeVersion)}, got ${JSON.stringify(nativeVersion)}`);
  }
  if (wasixVersion !== expectedWasixVersion) {
    fail(prefix, `${product}.extension.compatibility.wasix_runtime_version must be ${JSON.stringify(expectedWasixVersion)}, got ${JSON.stringify(wasixVersion)}`);
  }
  return {
    sqlName,
    sqlNames,
    artifactProduct: product,
    class: extensionClass,
    versioning,
    sourcePath,
    compatibility: {
      postgresMajor,
      extensionRuntimeContract: contractPath,
      nativeRuntimeProduct: nativeProduct,
      nativeRuntimeVersion: nativeVersion,
      wasixRuntimeProduct: wasixProduct,
      wasixRuntimeVersion: wasixVersion,
    },
  };
}

export function extensionSourceIdentity(product, prefix = "release-artifact-targets.mjs") {
  const metadata = extensionMetadata(product, prefix);
  const source = Bun.TOML.parse(readFileSync(path.join(ROOT, metadata.sourcePath), "utf8"));
  if (metadata.class === "contrib") {
    const postgresql = source.postgresql;
    if (postgresql === null || Array.isArray(postgresql) || typeof postgresql !== "object") {
      fail(prefix, `${metadata.sourcePath} must declare [postgresql] for contrib extension products`);
    }
    return {
      kind: "postgres-contrib",
      name: "postgresql",
      version: nonEmptyString(postgresql.version, `${metadata.sourcePath}.postgresql.version`, prefix),
      url: nonEmptyString(postgresql.url, `${metadata.sourcePath}.postgresql.url`, prefix),
      sha256: nonEmptyString(postgresql.sha256, `${metadata.sourcePath}.postgresql.sha256`, prefix),
    };
  }
  if (metadata.class === "external") {
    return {
      kind: "external",
      name: nonEmptyString(source.name, `${metadata.sourcePath}.name`, prefix),
      url: nonEmptyString(source.url, `${metadata.sourcePath}.url`, prefix),
      branch: nonEmptyString(source.branch, `${metadata.sourcePath}.branch`, prefix),
      commit: nonEmptyString(source.commit, `${metadata.sourcePath}.commit`, prefix),
    };
  }
  if (metadata.class === "first-party") {
    return {
      kind: "repo",
      name: metadata.sqlName ?? product,
      path: metadata.sourcePath,
      version: currentProductVersionSync(product, prefix),
    };
  }
  fail(prefix, `${product}.extension.class has unsupported source identity class ${JSON.stringify(metadata.class)}`);
}

function wasixExtensionTargetId(runtimeTarget) {
  return runtimeTarget === "portable" ? "wasix-portable" : runtimeTarget;
}

function runtimeExtensionTargetRows(prefix) {
  const rows = [];
  for (const target of allArtifactTargets(
    { product: "liboliphaunt-native", kind: "native-runtime" },
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
    });
  }
  for (const target of allArtifactTargets(
    { product: "liboliphaunt-wasix", kind: "wasix-runtime" },
    prefix,
  )) {
    rows.push({
      target: wasixExtensionTargetId(target.target),
      family: "wasix",
      kind: "wasix-runtime",
    });
  }
  if (rows.length === 0) {
    fail(prefix, "could not derive any exact-extension artifact targets from runtime products");
  }
  return rows;
}

function readExtensionTargetRows(prefix) {
  const relative = EXTENSION_TARGET_PROFILES_RELATIVE_PATH;
  const allowed = new Set(runtimeExtensionTargetRows(prefix).map((row) => `${row.target}\0${row.family}\0${row.kind}`));
  const rows = loadExtensionTargetProfiles().targets;
  for (const row of rows) {
    if (!allowed.has(`${row.target}\0${row.family}\0${row.kind}`)) {
      fail(prefix, `${relative} target row ${row.target}/${row.family}/${row.kind} is not backed by runtime artifact metadata`);
    }
  }
  return rows;
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
  } = {},
  prefix = "release-artifact-targets.mjs",
) {
  const products = product === undefined ? exactExtensionProducts(prefix) : [product];
  const parsed = [];
  for (const productId of products) {
    if (!exactExtensionProducts(prefix).includes(productId)) {
      fail(prefix, `${productId} is not an exact-extension artifact product`);
    }
    for (const sqlName of extensionSqlNames(productId, prefix)) {
      const seen = new Set();
      for (const [index, row] of readExtensionTargetRows(prefix).entries()) {
        const source = EXTENSION_TARGET_PROFILES_RELATIVE_PATH;
        const target = nonEmptyString(row.target, `${source} targets[${index}].target`, prefix);
        const targetFamily = nonEmptyString(row.family, `${source} targets[${index}].family`, prefix);
        const kind = nonEmptyString(row.kind, `${source} targets[${index}].kind`, prefix);
        if (!EXTENSION_FAMILIES.has(targetFamily)) {
          fail(prefix, `${source} target ${target} has invalid family ${targetFamily}`);
        }
        if (!EXTENSION_KINDS.has(kind)) {
          fail(prefix, `${source} target ${target} has invalid kind ${kind}`);
        }
        if (targetFamily === "wasix" && kind !== "wasix-runtime") {
          fail(prefix, `${source} target ${target} must use kind wasix-runtime for wasix family`);
        }
        if (targetFamily === "native" && kind === "wasix-runtime") {
          fail(prefix, `${source} target ${target} cannot use wasix-runtime for native family`);
        }
        const key = `${target}\0${targetFamily}\0${kind}`;
        if (seen.has(key)) {
          fail(prefix, `${source} has duplicate target row ${target}/${targetFamily}/${kind}`);
        }
        seen.add(key);
        if (family !== undefined && targetFamily !== family) {
          continue;
        }
        const binaryCompatibility =
          targetFamily === "native"
            ? requiredBinaryCompatibility(target, `${productId} native extension`, prefix)
            : undefined;
        parsed.push({
          product: productId,
          sqlName,
          sql_name: sqlName,
          target,
          family: targetFamily,
          kind,
          source_file: source,
          binaryCompatibility,
          binary_compatibility: binaryCompatibility,
        });
      }
    }
  }
  return parsed;
}

export function extensionTargetIds({ family }, prefix = "release-artifact-targets.mjs") {
  return [...new Set(extensionArtifactTargets({ family }, prefix).map((target) => target.target))]
    .sort(compareText);
}

function extensionPublishedTargets(product, family, kind, prefix) {
  return [...new Set(
    extensionArtifactTargets({ product, family }, prefix)
      .filter((target) => target.kind === kind)
      .map((target) => target.target),
  )].sort(compareText);
}

export function extensionRegistryPackageTargetSets(product, prefix = "release-artifact-targets.mjs") {
  const memberSignatures = extensionSqlNames(product, prefix).map((sqlName) => {
    const rows = extensionArtifactTargets({ product }, prefix)
      .filter((row) => row.sqlName === sqlName)
      .map((row) => `${row.target}\0${row.family}\0${row.kind}`)
      .sort(compareText);
    return { sqlName, rows };
  });
  const baseline = JSON.stringify(memberSignatures[0]?.rows ?? []);
  const mismatched = memberSignatures.filter(({ rows }) => JSON.stringify(rows) !== baseline).map(({ sqlName }) => sqlName);
  if (mismatched.length > 0) {
    fail(prefix, `${product} bundle members must publish an identical target carrier set; mismatched members: ${mismatched.join(", ")}`);
  }
  const nativeDynamicTargets = extensionPublishedTargets(product, "native", "native-dynamic", prefix);
  if (nativeDynamicTargets.length === 0) {
    fail(prefix, `${product} has no native dynamic extension registry targets`);
  }
  const androidTargets = extensionPublishedTargets(product, "native", "native-static-registry", prefix)
    .filter((target) => target.startsWith("android-"));
  const wasixRuntimeTargets = extensionPublishedTargets(product, "wasix", "wasix-runtime", prefix);
  const wasixAotMembers = extensionWasixAotMemberSqlNames(product, prefix);
  return {
    androidTargets,
    npmTargets: nativeDynamicTargets,
    nativeCargoTargets: nativeDynamicTargets,
    includeWasixNpm: wasixRuntimeTargets.includes("wasix-portable"),
    // An AOT carrier is meaningful only when at least one exact SQL member has
    // a native module to precompile. SQL/resource-only products still publish
    // their portable archive but must not reserve empty host-AOT identities.
    includeWasixAot: wasixRuntimeTargets.includes("wasix-portable") && wasixAotMembers.length > 0,
  };
}
