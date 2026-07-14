import { existsSync, readFileSync } from "node:fs";
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
const EXTENSION_EVIDENCE_KINDS = new Set([
  "build-and-lifecycle-smoke",
  "build-package-and-install",
  "manual-qualification",
  "unsupported-contract",
]);
const EXTENSION_VERSIONING_BY_CLASS = {
  contrib: "runtime-bound",
  external: "upstream-bound",
  "first-party": "repo-bound",
};
const EXTENSION_RUNTIME_CONTRACT_PATH = "src/shared/extension-runtime-contract/contract.toml";
const POSTGRES18_SOURCE_PATH = "src/postgres/versions/18/source.toml";

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

export function rawArtifactTargetRows(prefix = "release-artifact-targets.mjs") {
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
  const libraryRelativePath = stringField(row, "library_relative_path", id, false, prefix);
  const executableRelativePath = stringField(row, "executable_relative_path", id, false, prefix);
  const npmPackage = stringField(row, "npm_package", id, false, prefix);
  const npmOs = stringField(row, "npm_os", id, false, prefix);
  const npmCpu = stringField(row, "npm_cpu", id, false, prefix);
  const npmLibc = stringField(row, "npm_libc", id, false, prefix);
  const llvmUrl = stringField(row, "llvm_url", id, false, prefix);
  const sourceFile =
    stringField(row, "_source_file", id, false, prefix) ??
    stringField(row, "source_file", id, false, prefix);
  const unsupportedReason = stringField(row, "unsupported_reason", id, false, prefix);
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
    libraryRelativePath,
    executableRelativePath,
    npmPackage,
    npmOs,
    npmCpu,
    npmLibc,
    llvmUrl,
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
    extension_artifacts: row.extension_artifacts ?? true,
    source_file: sourceFile,
    unsupported_reason: unsupportedReason,
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

export function typescriptOptionalRuntimePackageProducts(prefix = "release-artifact-targets.mjs") {
  const selected = allArtifactTargets({ publishedOnly: true }, prefix).filter((target) => {
    if (target.product === "oliphaunt-broker" && target.kind === "broker-helper") {
      return target.surfaces.includes("typescript-broker");
    }
    if (target.product === "liboliphaunt-native" && ["native-runtime", "native-tools"].includes(target.kind)) {
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

export function artifactTargets(product, kind, prefix) {
  return allArtifactTargets({ product, kind, publishedOnly: true }, prefix);
}

function ciArtifactRows({ product, kind, surface, family, name }, prefix) {
  const targets = allArtifactTargets({ product, kind, surface, publishedOnly: true }, prefix);
  if (targets.length === 0) {
    fail(prefix, `${product} has no published ${kind} CI ${family} artifact targets`);
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
    publishedOnly = true,
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
  const rows = allArtifactTargets({ product, surface, publishedOnly }, prefix)
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
  const entries = config.registry_packages ?? [];
  if (!Array.isArray(entries) || entries.some((entry) => typeof entry !== "string")) {
    fail(prefix, `${product}.registry_packages must be a string list`);
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

function aggregateReleaseAssetArtifactRow(product, prefix) {
  const config = productConfig(product, prefix);
  const releaseArtifacts = config.release_artifacts;
  if (!Array.isArray(releaseArtifacts) || releaseArtifacts.length === 0) {
    fail(prefix, `${product} does not publish aggregate release assets`);
  }
  return {
    aggregate: true,
    family: "aggregate-release-assets",
    product,
    artifactName: `${product}-release-assets`,
  };
}

function localPublishAggregateArtifactRows(prefix) {
  const rows = [
    aggregateReleaseAssetArtifactRow("liboliphaunt-native", prefix),
    aggregateReleaseAssetArtifactRow("liboliphaunt-wasix", prefix),
  ];
  rows.push(
    ...allArtifactTargets({
      product: "liboliphaunt-wasix",
      kind: "wasix-runtime",
      publishedOnly: true,
    }, prefix).map((target) => ({
      aggregate: true,
      family: "wasix-runtime",
      product: target.product,
      kind: target.kind,
      target: target.target,
      artifactTarget: target.id,
      artifactName: `liboliphaunt-wasix-runtime-${target.target}`,
    })),
  );
  rows.push(
    ...[...new Set(
      extensionArtifactTargets({ family: "wasix", publishedOnly: true }, prefix).map((target) => target.target),
    )].sort(compareText).map((target) => ({
      aggregate: true,
      family: "wasix-extension-artifacts",
      target,
      artifactName: `liboliphaunt-wasix-extension-artifacts-${target}`,
    })),
  );
  rows.push({
    aggregate: true,
    family: "extension-package-artifacts",
    artifactName: "oliphaunt-extension-package-artifacts",
  });
  if (extensionArtifactTargets({ family: "native", publishedOnly: true }, prefix).some(
    (target) => target.kind === "native-static-registry",
  )) {
    rows.push({
      aggregate: true,
      family: "extension-package-artifacts",
      artifactName: "oliphaunt-mobile-extension-package-artifacts",
    });
  }
  return rows;
}

export function localPublishArtifactRows({ aggregateOnly = false } = {}, prefix = "release-artifact-targets.mjs") {
  const rows = localPublishAggregateArtifactRows(prefix);
  if (!aggregateOnly) {
    rows.push(
      ...ciReleaseAssetArtifactRows("liboliphaunt-native", "native-runtime", prefix).map((row) => ({
        ...row,
        aggregate: false,
      })),
      ...allArtifactTargets({
        product: "liboliphaunt-wasix",
        kind: "wasix-aot-runtime",
        publishedOnly: true,
      }, prefix).map((target) => ({
        aggregate: false,
        family: "wasix-aot-runtime",
        product: target.product,
        kind: target.kind,
        target: target.target,
        artifactTarget: target.id,
        artifactName: `liboliphaunt-wasix-runtime-aot-${target.target}`,
      })),
      ...ciReleaseAssetArtifactRows("oliphaunt-broker", "broker-helper", prefix).map((row) => ({
        ...row,
        aggregate: false,
      })),
      ...ciReleaseAssetArtifactRows("oliphaunt-node-direct", "node-direct-addon", prefix).map((row) => ({
        ...row,
        aggregate: false,
      })),
      ...ciNpmPackageArtifactRows("oliphaunt-node-direct", "node-direct-addon", prefix).map((row) => ({
        ...row,
        aggregate: false,
      })),
      ...sdkPackageProducts(prefix).map((row) => ({
        aggregate: false,
        family: "sdk-package",
        product: row.product,
        artifactName: row.artifactName,
      })),
    );
  }
  const names = rows.map((row) => row.artifactName);
  const duplicates = [...new Set(names.filter((name, index) => names.indexOf(name) !== index))].sort(compareText);
  if (duplicates.length > 0) {
    fail(prefix, `duplicate local publish artifact names: ${duplicates.join(", ")}`);
  }
  return rows.sort((left, right) => compareText(left.artifactName, right.artifactName));
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
    } else if (name === "package.json" || name === "jsr.json") {
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
  return Object.entries(graph(prefix).products)
    .filter(([, config]) => config.kind === "exact-extension-artifact")
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
  const value = productConfig(product, prefix).extension_sql_name;
  if (typeof value !== "string" || !value) {
    fail(prefix, `${product} release.toml must declare extension_sql_name`);
  }
  return value;
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
  const config = productConfig(product, prefix);
  if (config.kind !== "exact-extension-artifact") {
    fail(prefix, `${product} is not an exact-extension artifact product`);
  }
  const topLevelSqlName = extensionSqlName(product, prefix);
  const metadata = config.extension;
  if (metadata === null || Array.isArray(metadata) || typeof metadata !== "object") {
    fail(prefix, `${product} release metadata must declare [extension]`);
  }
  const sqlName = nonEmptyString(metadata.sql_name, `${product}.extension.sql_name`, prefix);
  if (sqlName !== topLevelSqlName) {
    fail(prefix, `${product}.extension.sql_name ${JSON.stringify(sqlName)} must match extension_sql_name ${JSON.stringify(topLevelSqlName)}`);
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
  if (extensionClass === "contrib" && sourcePath !== POSTGRES18_SOURCE_PATH) {
    fail(prefix, `${product}.extension.source.path must be ${JSON.stringify(POSTGRES18_SOURCE_PATH)} for contrib extensions`);
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
  if (contractPath !== EXTENSION_RUNTIME_CONTRACT_PATH) {
    fail(prefix, `${product}.extension.compatibility.extension_runtime_contract must be ${JSON.stringify(EXTENSION_RUNTIME_CONTRACT_PATH)}`);
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
      name: metadata.sqlName,
      path: metadata.sourcePath,
      version: currentProductVersionSync(product, prefix),
    };
  }
  fail(prefix, `${product}.extension.class has unsupported source identity class ${JSON.stringify(metadata.class)}`);
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
    fail(prefix, `${relative} is required; exact-extension support is fail-closed and must never be inferred from runtime capability`);
  }
  const data = Bun.TOML.parse(readFileSync(file, "utf8"));
  if (data.schema !== "oliphaunt-extension-artifact-targets-v1") {
    fail(prefix, `${relative} must use schema = "oliphaunt-extension-artifact-targets-v1"`);
  }
  if (!Array.isArray(data.targets) || data.targets.length === 0) {
    if (!Array.isArray(data.profiles) || data.profiles.length === 0) {
      fail(prefix, `${relative} must opt into at least one canonical profile or define [[targets]] rows`);
    }
  }
  const allowed = new Set(defaultExtensionTargetRows(product, prefix).map((row) => `${row.target}\0${row.family}\0${row.kind}`));
  const rows = [];
  if (data.profiles !== undefined) {
    if (!Array.isArray(data.profiles) || data.profiles.some((profile) => typeof profile !== "string" || profile.length === 0)) {
      fail(prefix, `${relative} profiles must be a list of non-empty profile ids`);
    }
    const profileFile = "tools/release/extension-target-profiles.toml";
    const profileData = Bun.TOML.parse(readFileSync(path.join(ROOT, profileFile), "utf8"));
    if (profileData.schema !== "oliphaunt-extension-artifact-target-profiles-v1" || !Array.isArray(profileData.profiles)) {
      fail(prefix, `${profileFile} must use schema oliphaunt-extension-artifact-target-profiles-v1 and define [[profiles]]`);
    }
    const profiles = new Map();
    for (const profile of profileData.profiles) {
      const id = nonEmptyString(profile?.id, `${profileFile} profile id`, prefix);
      if (profiles.has(id) || !Array.isArray(profile.targets) || profile.targets.length === 0) {
        fail(prefix, `${profileFile} profile ${id} must be unique and define targets`);
      }
      profiles.set(id, profile.targets);
    }
    const evidence = data.evidence;
    if (evidence === null || Array.isArray(evidence) || typeof evidence !== "object") {
      fail(prefix, `${relative} must define [evidence.<profile>] for every selected profile`);
    }
    const selectedProfiles = new Set();
    for (const profileId of data.profiles) {
      if (selectedProfiles.has(profileId)) {
        fail(prefix, `${relative} selects duplicate profile ${profileId}`);
      }
      selectedProfiles.add(profileId);
      const profileTargets = profiles.get(profileId);
      if (profileTargets === undefined) {
        fail(prefix, `${relative} selects unknown extension target profile ${profileId}`);
      }
      const profileEvidence = evidence[profileId];
      if (profileEvidence === null || Array.isArray(profileEvidence) || typeof profileEvidence !== "object") {
        fail(prefix, `${relative} is missing [evidence.${profileId}]`);
      }
      const evidenceKind = nonEmptyString(profileEvidence.kind, `${relative} evidence.${profileId}.kind`, prefix);
      const evidenceReference = nonEmptyString(profileEvidence.reference, `${relative} evidence.${profileId}.reference`, prefix);
      for (const target of profileTargets) {
        rows.push({
          ...target,
          status: "supported",
          published: true,
          evidence_kind: evidenceKind,
          evidence_reference: evidenceReference,
          _profile: profileId,
        });
      }
    }
    const staleEvidence = Object.keys(evidence).filter((profileId) => !selectedProfiles.has(profileId)).sort(compareText);
    if (staleEvidence.length > 0) {
      fail(prefix, `${relative} defines evidence for unselected profiles: ${staleEvidence.join(", ")}`);
    }
  }
  rows.push(...(data.targets ?? []));
  for (const row of rows) {
    row._source_file = relative;
    if (!allowed.has(`${row.target}\0${row.family}\0${row.kind}`)) {
      fail(prefix, `${relative} target row ${row.target}/${row.family}/${row.kind} is not backed by runtime artifact metadata`);
    }
  }
  return rows;
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
      const evidenceKind = nonEmptyString(row.evidence_kind, `${source} targets[${index}].evidence_kind`, prefix);
      const evidenceReference = nonEmptyString(row.evidence_reference, `${source} targets[${index}].evidence_reference`, prefix);
      if (!EXTENSION_FAMILIES.has(targetFamily)) {
        fail(prefix, `${source} target ${target} has invalid family ${targetFamily}`);
      }
      if (!EXTENSION_KINDS.has(kind)) {
        fail(prefix, `${source} target ${target} has invalid kind ${kind}`);
      }
      if (!EXTENSION_STATUSES.has(status)) {
        fail(prefix, `${source} target ${target} has invalid status ${status}`);
      }
      if (!EXTENSION_EVIDENCE_KINDS.has(evidenceKind)) {
        fail(prefix, `${source} target ${target} has invalid evidence_kind ${evidenceKind}; expected one of ${[...EXTENSION_EVIDENCE_KINDS].sort(compareText).join(", ")}`);
      }
      if (evidenceReference.includes("\0") || evidenceReference.trim() !== evidenceReference) {
        fail(prefix, `${source} target ${target} evidence_reference must be a trimmed stable job, test, or contract reference`);
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
      const unsupportedReason = row.unsupported_reason;
      if (!published && (typeof unsupportedReason !== "string" || unsupportedReason.length === 0)) {
        fail(prefix, `${source} unpublished target ${target} must explain unsupported_reason`);
      }
      if (published && evidenceKind === "unsupported-contract") {
        fail(prefix, `${source} published target ${target} cannot use unsupported-contract evidence`);
      }
      if (!published && evidenceKind !== "unsupported-contract" && status === "unsupported") {
        fail(prefix, `${source} unsupported target ${target} must use unsupported-contract evidence`);
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
        source_file: source,
        unsupported_reason: typeof unsupportedReason === "string" ? unsupportedReason : null,
        evidence_kind: evidenceKind,
        evidence_reference: evidenceReference,
      });
    }
  }
  return parsed;
}

export function publishedExtensionTargetIds({ family }, prefix = "release-artifact-targets.mjs") {
  return [...new Set(extensionArtifactTargets({ family, publishedOnly: true }, prefix).map((target) => target.target))]
    .sort(compareText);
}

function extensionPublishedTargets(product, family, kind, prefix) {
  return [...new Set(
    extensionArtifactTargets({ product, family, publishedOnly: true }, prefix)
      .filter((target) => target.kind === kind)
      .map((target) => target.target),
  )].sort(compareText);
}

export function extensionRegistryPackageTargetSets(product, prefix = "release-artifact-targets.mjs") {
  const nativeDynamicTargets = extensionPublishedTargets(product, "native", "native-dynamic", prefix);
  if (nativeDynamicTargets.length === 0) {
    fail(prefix, `${product} has no published native dynamic extension registry targets`);
  }
  const androidTargets = extensionPublishedTargets(product, "native", "native-static-registry", prefix)
    .filter((target) => target.startsWith("android-"));
  const wasixRuntimeTargets = extensionPublishedTargets(product, "wasix", "wasix-runtime", prefix);
  return {
    androidTargets,
    npmTargets: nativeDynamicTargets,
    nativeCargoTargets: nativeDynamicTargets,
    includeWasixAot: wasixRuntimeTargets.includes("wasix-portable"),
  };
}
