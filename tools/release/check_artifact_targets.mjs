#!/usr/bin/env bun

import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import {
  BUILDER_JOBS,
  addImpliedJobs,
  planForFullRun,
  planJobsForAffected,
  renderPlanForFullRun,
} from "../graph/ci_plan.mjs";
import {
  extensionNativeRegistryPackageStrings,
  extensionRegistryPackageStrings,
  extensionWasixRegistryPackageStrings,
} from "./extension-registry-packages.mjs";
import {
  brokerRuntimeMatrix,
  extensionArtifactsNativeMatrix,
  extensionArtifactsWasixMatrix,
  liboliphauntNativeAndroidRuntimeMatrix,
  liboliphauntNativeDesktopRuntimeMatrix,
  liboliphauntNativeIosRuntimeMatrix,
  liboliphauntNativeRuntimeMatrix,
  liboliphauntWasixAotRuntimeMatrix,
  liboliphauntWasixPostmasterRuntimeMatrix,
  nodeDirectRuntimeMatrix,
  reactNativeAndroidMobileAppMatrix,
  wasixNapiRuntimeMatrix,
} from "./artifact_target_matrix.mjs";
import {
  allArtifactTargets,
  ciNpmPackageArtifactRows,
  ciReleaseAssetArtifactRows,
  exactExtensionProducts,
  extensionArtifactTargets,
  extensionMetadata,
  extensionMemberPath,
  extensionReleaseProduct,
  extensionRegistryPackageTargetSets,
  extensionSqlNames,
  nativeToolsOptionalPackageProducts,
  rawArtifactTargetRows,
  registryPackageRows,
  releaseMetadata,
  sdkPackageProducts,
  typescriptOptionalRuntimePackageProducts,
} from "./release-artifact-targets.mjs";
import { ROOT, compareText, loadGraph } from "./release-graph.mjs";
import { parseWorkflow } from "./read-workflow.mjs";
import { declaredCarrierMap, loadPublicationCatalog } from "./publication-catalog.mjs";

const TOOL = "check_artifact_targets.mjs";
const GITHUB = "github-release";
const DESKTOP_SURFACES = [GITHUB, "rust-native-direct", "typescript-native-direct"];
const BROKER_SURFACES = [GITHUB, "rust-broker", "typescript-broker"];
const NODE_SURFACES = [GITHUB, "npm-optional"];
const WASIX_NAPI_SURFACES = [GITHUB, "npm-optional"];

const DESKTOP = Object.freeze([
  {
    target: "linux-arm64-gnu",
    triple: "aarch64-unknown-linux-gnu",
    runner: "ubuntu-24.04-arm",
    archive: "tar.gz",
    os: "linux",
    cpu: "arm64",
    libc: "glibc",
    library: "lib/liboliphaunt.so",
    nativeNpm: "@oliphaunt/liboliphaunt-linux-arm64-gnu",
    toolsNpm: "@oliphaunt/tools-linux-arm64-gnu",
    brokerNpm: "@oliphaunt/broker-linux-arm64-gnu",
    nodeNpm: "@oliphaunt/node-direct-linux-arm64-gnu",
    wasixNapiNpm: "@oliphaunt/wasix-napi-linux-arm64-gnu",
  },
  {
    target: "linux-x64-gnu",
    triple: "x86_64-unknown-linux-gnu",
    runner: "ubuntu-24.04",
    archive: "tar.gz",
    os: "linux",
    cpu: "x64",
    libc: "glibc",
    library: "lib/liboliphaunt.so",
    nativeNpm: "@oliphaunt/liboliphaunt-linux-x64-gnu",
    toolsNpm: "@oliphaunt/tools-linux-x64-gnu",
    brokerNpm: "@oliphaunt/broker-linux-x64-gnu",
    nodeNpm: "@oliphaunt/node-direct-linux-x64-gnu",
    wasixNapiNpm: "@oliphaunt/wasix-napi-linux-x64-gnu",
  },
  {
    target: "macos-arm64",
    triple: "aarch64-apple-darwin",
    runner: "macos-26",
    archive: "tar.gz",
    os: "darwin",
    cpu: "arm64",
    library: "lib/liboliphaunt.dylib",
    nativeNpm: "@oliphaunt/liboliphaunt-darwin-arm64",
    toolsNpm: "@oliphaunt/tools-darwin-arm64",
    brokerNpm: "@oliphaunt/broker-darwin-arm64",
    nodeNpm: "@oliphaunt/node-direct-darwin-arm64",
    wasixNapiNpm: "@oliphaunt/wasix-napi-darwin-arm64",
  },
  {
    target: "windows-x64-msvc",
    triple: "x86_64-pc-windows-msvc",
    runner: "windows-2025-vs2026",
    archive: "zip",
    os: "win32",
    cpu: "x64",
    library: "bin/oliphaunt.dll",
    nativeNpm: "@oliphaunt/liboliphaunt-win32-x64-msvc",
    toolsNpm: "@oliphaunt/tools-win32-x64-msvc",
    brokerNpm: "@oliphaunt/broker-win32-x64-msvc",
    nodeNpm: "@oliphaunt/node-direct-win32-x64-msvc",
    wasixNapiNpm: "@oliphaunt/wasix-napi-win32-x64-msvc",
  },
]);

const WASIX_AOT = Object.freeze([
  ["linux-arm64-gnu", "aarch64-unknown-linux-gnu", "ubuntu-24.04-arm", "llvm-linux-aarch64.tar.xz", 668873496, "1fddcf5b30f9d3e073eb161509220b4136ea8e2f114f23084bdec33e40fa87c1"],
  ["linux-x64-gnu", "x86_64-unknown-linux-gnu", "ubuntu-24.04", "llvm-linux-amd64.tar.xz", 741670068, "5fb1c687c5e895d517a23e7aabea9ec3557e3a3e33f8a8d3a8d21395157b3906"],
  ["macos-arm64", "aarch64-apple-darwin", "macos-26", "llvm-darwin-aarch64.tar.xz", 479103872, "f64460f6c8a28876737402542fc5b28bb1f4262cef85f799b65ce2a7ee6f8847"],
  ["windows-x64-msvc", "x86_64-pc-windows-msvc", "windows-2025-vs2026", "llvm-windows-amd64.tar.xz", 757929860, "19ff22b0cf74b53dad2fc717db2209f8162b768fc6dede9e2caa6a83c724496e"],
]);
const WASIX_POSTMASTER_TARGETS = new Set([
  "linux-arm64-gnu",
  "linux-x64-gnu",
  "macos-arm64",
]);

function invariant(condition, message) {
  if (!condition) throw new Error(`${TOOL}: ${message}`);
}

function object(value, label) {
  invariant(value !== null && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  return value;
}

function sorted(values) {
  return [...values].sort(compareText);
}

function sameStrings(left, right) {
  const actual = sorted(left);
  const expected = sorted(right);
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

function assertSameStrings(actual, expected, label) {
  invariant(
    sameStrings(actual, expected),
    `${label} must be ${JSON.stringify(sorted(expected))}; got ${JSON.stringify(sorted(actual))}`,
  );
}

function readJson(relativePath) {
  try {
    return object(JSON.parse(readFileSync(path.join(ROOT, relativePath), "utf8")), relativePath);
  } catch (error) {
    throw new Error(`${TOOL}: ${relativePath} is invalid JSON: ${error.message}`);
  }
}

function readToml(relativePath) {
  try {
    return object(Bun.TOML.parse(readFileSync(path.join(ROOT, relativePath), "utf8")), relativePath);
  } catch (error) {
    throw new Error(`${TOOL}: ${relativePath} is invalid TOML: ${error.message}`);
  }
}

function targetRow({
  product,
  id,
  kind,
  target,
  asset,
  surfaces,
  triple = null,
  runner = null,
  library = null,
  executable = null,
  npm = null,
  os = null,
  cpu = null,
  libc = null,
  llvm = null,
  llvmSha256 = null,
  llvmBytes = null,
  tier = null,
  extensionArtifacts = true,
}) {
  return {
    id: `${product}.${id}`,
    product,
    kind,
    target,
    asset,
    surfaces: sorted(surfaces),
    triple,
    runner,
    library,
    executable,
    npm,
    os,
    cpu,
    libc,
    llvm,
    llvmSha256,
    llvmBytes,
    tier,
    extensionArtifacts,
  };
}

function portableRow(product, id, kind, asset, surfaces = [GITHUB]) {
  return targetRow({ product, id, kind, target: "portable", asset, surfaces });
}

export function expectedArtifactTargetContract() {
  const rows = [];
  for (const platform of DESKTOP) {
    const common = {
      target: platform.target,
      triple: platform.triple,
      runner: platform.runner,
      os: platform.os,
      cpu: platform.cpu,
      libc: platform.libc ?? null,
    };
    rows.push(
      targetRow({
        product: "liboliphaunt-native",
        id: platform.target,
        kind: "native-runtime",
        asset: `liboliphaunt-{version}-${platform.target}.${platform.archive}`,
        surfaces: DESKTOP_SURFACES,
        library: platform.library,
        npm: platform.nativeNpm,
        ...common,
      }),
      targetRow({
        product: "liboliphaunt-native",
        id: `tools-${platform.target}`,
        kind: "native-tools",
        asset: `oliphaunt-tools-{version}-${platform.target}.${platform.archive}`,
        surfaces: DESKTOP_SURFACES,
        npm: platform.toolsNpm,
        ...common,
      }),
      targetRow({
        product: "oliphaunt-broker",
        id: platform.target,
        kind: "broker-helper",
        asset: `oliphaunt-broker-{version}-${platform.target}.${platform.archive}`,
        surfaces: BROKER_SURFACES,
        executable: platform.os === "win32" ? "bin/oliphaunt-broker.exe" : "bin/oliphaunt-broker",
        npm: platform.brokerNpm,
        ...common,
      }),
      targetRow({
        product: "oliphaunt-node-direct",
        id: platform.target,
        kind: "node-direct-addon",
        asset: `oliphaunt-node-direct-{version}-${platform.target}.${platform.archive}`,
        surfaces: NODE_SURFACES,
        library: "oliphaunt_node.node",
        npm: platform.nodeNpm,
        ...common,
      }),
      targetRow({
        product: "oliphaunt-wasix-napi",
        id: platform.target,
        kind: "wasix-napi-addon",
        asset: `oliphaunt-wasix-napi-{version}-${platform.target}.${platform.archive}`,
        surfaces: WASIX_NAPI_SURFACES,
        library: "oliphaunt_wasix_napi.node",
        npm: platform.wasixNapiNpm,
        extensionArtifacts: false,
        ...common,
      }),
    );
  }
  rows.push(
    targetRow({
      product: "liboliphaunt-native",
      id: "android-arm64-v8a",
      kind: "native-runtime",
      target: "android-arm64-v8a",
      asset: "liboliphaunt-{version}-android-arm64-v8a.tar.gz",
      surfaces: [GITHUB, "maven", "react-native-android"],
      triple: "aarch64-linux-android",
      runner: "ubuntu-24.04",
      library: "jni/arm64-v8a/liboliphaunt.so",
    }),
    targetRow({
      product: "liboliphaunt-native",
      id: "android-x86_64",
      kind: "native-runtime",
      target: "android-x86_64",
      asset: "liboliphaunt-{version}-android-x86_64.tar.gz",
      surfaces: [GITHUB, "maven", "react-native-android"],
      triple: "x86_64-linux-android",
      runner: "ubuntu-24.04",
      library: "jni/x86_64/liboliphaunt.so",
    }),
    targetRow({
      product: "liboliphaunt-native",
      id: "ios-xcframework",
      kind: "native-runtime",
      target: "ios-xcframework",
      asset: "liboliphaunt-{version}-ios-xcframework.tar.gz",
      surfaces: [GITHUB, "react-native-ios", "swiftpm"],
      triple: "ios-xcframework",
      runner: "macos-26",
      library: "liboliphaunt.xcframework",
    }),
    targetRow({
      product: "liboliphaunt-native",
      id: "apple-spm-xcframework",
      kind: "apple-swiftpm-binary",
      target: "apple-spm-xcframework",
      asset: "liboliphaunt-{version}-apple-spm-xcframework.zip",
      surfaces: [GITHUB, "swiftpm"],
      triple: "apple-xcframework",
      runner: "macos-26",
    }),
    targetRow({
      product: "liboliphaunt-native",
      id: "runtime-resources-ios-datum64",
      kind: "runtime-resources",
      target: "ios-datum64",
      asset: "liboliphaunt-{version}-runtime-resources-ios-datum64.tar.gz",
      surfaces: [GITHUB, "react-native-ios"],
    }),
    targetRow({
      product: "liboliphaunt-native",
      id: "runtime-resources-android-datum64",
      kind: "runtime-resources",
      target: "android-datum64",
      asset: "liboliphaunt-{version}-runtime-resources-android-datum64.tar.gz",
      surfaces: [GITHUB, "maven", "react-native-android"],
    }),
    targetRow({
      product: "liboliphaunt-native",
      id: "icu-data",
      kind: "icu-data",
      target: "portable",
      asset: "liboliphaunt-{version}-icu-data.tar.gz",
      surfaces: [GITHUB, "maven", "react-native-android", "react-native-ios", "rust-native-direct", "swiftpm", "typescript-native-direct"],
      npm: "@oliphaunt/icu",
    }),
    portableRow("liboliphaunt-native", "checksums", "checksums", "liboliphaunt-{version}-release-assets.sha256"),
    portableRow("liboliphaunt-wasix", "runtime-portable", "wasix-runtime", "liboliphaunt-wasix-{version}-runtime-portable.tar.zst"),
    portableRow("liboliphaunt-wasix", "icu-data", "icu-data", "liboliphaunt-wasix-{version}-icu-data.tar.zst"),
    portableRow("liboliphaunt-wasix", "checksums", "checksums", "liboliphaunt-wasix-{version}-release-assets.sha256"),
    targetRow({
      product: "liboliphaunt-wasix-postmaster",
      id: "checksums",
      kind: "checksums",
      target: "portable",
      asset: "liboliphaunt-wasix-postmaster-{version}-release-assets.sha256",
      surfaces: [GITHUB],
      extensionArtifacts: false,
    }),
    portableRow("oliphaunt-broker", "checksums", "checksums", "oliphaunt-broker-{version}-release-assets.sha256", BROKER_SURFACES),
    portableRow("oliphaunt-node-direct", "checksums", "checksums", "oliphaunt-node-direct-{version}-release-assets.sha256"),
    targetRow({
      product: "oliphaunt-wasix-napi",
      id: "checksums",
      kind: "checksums",
      target: "portable",
      asset: "oliphaunt-wasix-napi-{version}-release-assets.sha256",
      surfaces: [GITHUB],
      extensionArtifacts: false,
    }),
  );
  for (const [target, triple, runner, llvmArchive, llvmBytes, llvmSha256] of WASIX_AOT) {
    rows.push(targetRow({
      product: "liboliphaunt-wasix",
      id: `aot-${target}`,
      kind: "wasix-aot-runtime",
      target,
      asset: `liboliphaunt-wasix-{version}-runtime-aot-${target}.tar.zst`,
      surfaces: [GITHUB],
      triple,
      runner,
      llvm: `https://github.com/wasmerio/llvm-custom-builds/releases/download/22.x/${llvmArchive}`,
      llvmSha256,
      llvmBytes,
    }));
    if (WASIX_POSTMASTER_TARGETS.has(target)) {
      rows.push(targetRow({
        product: "liboliphaunt-wasix-postmaster",
        id: target,
        kind: "wasix-postmaster-runtime",
        target,
        asset: `liboliphaunt-wasix-postmaster-{version}-${target}.tar.zst`,
        surfaces: [GITHUB],
        triple,
        runner,
        llvm: `https://github.com/wasmerio/llvm-custom-builds/releases/download/22.x/${llvmArchive}`,
        llvmSha256,
        llvmBytes,
        extensionArtifacts: false,
      }));
    }
  }
  return rows.sort((left, right) => compareText(left.id, right.id));
}

function projectTarget(target) {
  return {
    id: target.id,
    product: target.product,
    kind: target.kind,
    target: target.target,
    asset: target.asset,
    surfaces: sorted(target.surfaces),
    triple: target.triple ?? null,
    runner: target.runner ?? null,
    library: target.libraryRelativePath ?? target.library_relative_path ?? target.library ?? null,
    executable: target.executableRelativePath ?? target.executable_relative_path ?? target.executable ?? null,
    npm: target.npmPackage ?? target.npm_package ?? target.npm ?? null,
    os: target.npmOs ?? target.npm_os ?? target.os ?? null,
    cpu: target.npmCpu ?? target.npm_cpu ?? target.cpu ?? null,
    libc: target.npmLibc ?? target.npm_libc ?? target.libc ?? null,
    llvm: target.llvmUrl ?? target.llvm_url ?? target.llvm ?? null,
    llvmSha256: target.llvmSha256 ?? target.llvm_sha256 ?? null,
    llvmBytes: target.llvmBytes ?? target.llvm_bytes ?? null,
    tier: target.tier ?? null,
    extensionArtifacts: target.extensionArtifacts ?? target.extension_artifacts ?? true,
  };
}

export function validateArtifactTargetContract(actualTargets, expectedTargets = expectedArtifactTargetContract()) {
  const actual = actualTargets.map(projectTarget).sort((left, right) => compareText(left.id, right.id));
  const expected = expectedTargets.map(projectTarget).sort((left, right) => compareText(left.id, right.id));
  assertSameStrings(actual.map(({ id }) => id), expected.map(({ id }) => id), "artifact target ids");
  const expectedById = new Map(expected.map((row) => [row.id, row]));
  const seenAssets = new Set();
  for (const row of actual) {
    const wanted = expectedById.get(row.id);
    invariant(JSON.stringify(row) === JSON.stringify(wanted), `${row.id} public target contract differs: expected ${JSON.stringify(wanted)}, got ${JSON.stringify(row)}`);
    invariant(row.asset.includes("{version}"), `${row.id} asset must bind the product version`);
    if (row.surfaces.includes(GITHUB)) {
      const key = `${row.product}\0${row.asset}`;
      invariant(!seenAssets.has(key), `${row.product} publishes duplicate asset ${row.asset}`);
      seenAssets.add(key);
    }
  }
}

export function validateExtensionCoverage(runtimeTargets, products, extensionTargets) {
  invariant(products.length > 0 && new Set(products).size === products.length, "extension product ids must be a non-empty unique set");
  const nativeTargets = runtimeTargets
    .filter((row) => row.product === "liboliphaunt-native" && row.kind === "native-runtime" && row.extensionArtifacts)
    .map(({ target }) => target);
  const wasixTargets = runtimeTargets
    .filter((row) => row.product === "liboliphaunt-wasix" && row.kind === "wasix-runtime")
    .map(({ target }) => target === "portable" ? "wasix-portable" : target);
  const expectedPairs = new Set(products.flatMap((product) => extensionSqlNames(product, TOOL).flatMap((sqlName) => [
    ...nativeTargets.map((target) => `${product}\0${sqlName}\0native\0${target}`),
    ...wasixTargets.map((target) => `${product}\0${sqlName}\0wasix\0${target}`),
  ])));
  const actualPairs = new Set(extensionTargets.map((row) => `${row.product}\0${row.sqlName}\0${row.family}\0${row.target}`));
  assertSameStrings(actualPairs, expectedPairs, "exact-extension product/member/family/target pairs");
  invariant(actualPairs.size === extensionTargets.length, "exact-extension target rows must be unique");
  for (const row of extensionTargets) {
    const expectedKind = row.family === "wasix"
      ? "wasix-runtime"
      : row.target === "ios-xcframework" || row.target.startsWith("android-")
        ? "native-static-registry"
        : "native-dynamic";
    invariant(row.kind === expectedKind, `${row.product}/${row.target} must use ${expectedKind}, got ${row.kind}`);
    invariant(extensionSqlNames(row.product, TOOL).includes(row.sqlName), `${row.product} target row has undeclared SQL member ${row.sqlName}`);
  }
}

function matrixPairs(matrix, { productField = "extensions_csv" } = {}) {
  const pairs = [];
  for (const row of matrix.include) {
    for (const product of String(row[productField] ?? "").split(",").filter(Boolean)) pairs.push(`${product}\0${row.target}`);
  }
  return pairs;
}

export function validateMatrixCoverage(targets, extensions, matrices) {
  const selected = (product, kind) => targets.filter((row) => row.product === product && row.kind === kind);
  assertSameStrings(
    matrices.native.include.map(({ target }) => target),
    selected("liboliphaunt-native", "native-runtime").map(({ target }) => target),
    "native runtime CI matrix",
  );
  const partitions = [matrices.nativeDesktop, matrices.nativeAndroid, matrices.nativeIos];
  assertSameStrings(partitions.flatMap(({ include }) => include.map(({ target }) => target)), matrices.native.include.map(({ target }) => target), "native runtime CI matrix partitions");
  invariant(new Set(partitions.flatMap(({ include }) => include.map(({ target }) => target))).size === matrices.native.include.length, "native runtime CI partitions must not overlap");
  assertSameStrings(
    matrices.reactNativeAndroid.include.map(({ target }) => target),
    selected("liboliphaunt-native", "native-runtime").filter(({ surfaces }) => surfaces.includes("react-native-android")).map(({ target }) => target),
    "React Native Android CI matrix",
  );
  assertSameStrings(matrices.broker.include.map(({ target }) => target), selected("oliphaunt-broker", "broker-helper").map(({ target }) => target), "broker CI matrix");
  assertSameStrings(matrices.nodeDirect.include.map(({ target }) => target), selected("oliphaunt-node-direct", "node-direct-addon").map(({ target }) => target), "Node direct CI matrix");
  assertSameStrings(matrices.wasixNapi.include.map(({ target }) => target), selected("oliphaunt-wasix-napi", "wasix-napi-addon").map(({ target }) => target), "WASIX Node-API CI matrix");
  assertSameStrings(matrices.wasixAot.include.map(({ target_id }) => target_id), selected("liboliphaunt-wasix", "wasix-aot-runtime").map(({ target }) => target), "WASIX AOT CI matrix");
  const wasixAotTargets = new Map(
    selected("liboliphaunt-wasix", "wasix-aot-runtime").map((target) => [target.target, target]),
  );
  for (const row of matrices.wasixAot.include) {
    const target = wasixAotTargets.get(row.target_id);
    invariant(target !== undefined, `WASIX AOT CI matrix has unknown target ${row.target_id}`);
    invariant(row.llvm_url === target.llvmUrl, `WASIX AOT CI matrix ${row.target_id} must bind its declared LLVM URL`);
    invariant(
      row.llvm_sha256 === target.llvmSha256 && /^[0-9a-f]{64}$/u.test(row.llvm_sha256),
      `WASIX AOT CI matrix ${row.target_id} must bind its exact LLVM SHA-256`,
    );
    invariant(
      row.llvm_bytes === target.llvmBytes
        && Number.isSafeInteger(row.llvm_bytes)
        && row.llvm_bytes > 0
        && row.llvm_bytes <= 2 * 1024 * 1024 * 1024,
      `WASIX AOT CI matrix ${row.target_id} must bind its exact supported LLVM byte size`,
    );
  }
  const postmasterTargets = targets.filter(
    ({ product, kind }) => product === "liboliphaunt-wasix-postmaster" && kind === "wasix-postmaster-runtime",
  );
  assertSameStrings(
    matrices.wasixPostmaster.include.map(({ target_id }) => target_id),
    postmasterTargets.map(({ target }) => target),
    "WASIX postmaster CI matrix",
  );
  const postmasterByTarget = new Map(postmasterTargets.map((target) => [target.target, target]));
  for (const row of matrices.wasixPostmaster.include) {
    const target = postmasterByTarget.get(row.target_id);
    invariant(target !== undefined, `WASIX postmaster CI matrix has unknown target ${row.target_id}`);
    invariant(
      row.os === target.runner && row.target === target.triple,
      `WASIX postmaster CI matrix ${row.target_id} must bind its declared runner and target triple`,
    );
    invariant(
      row.artifact === `liboliphaunt-wasix-postmaster-release-assets-${target.target}`,
      `WASIX postmaster CI matrix ${row.target_id} must bind its exact CI artifact name`,
    );
    invariant(
      row.release_asset_path
        === `target/oliphaunt-wasix-postmaster/release-assets/${target.asset.replace("{version}", "*")}`,
      `WASIX postmaster CI matrix ${row.target_id} must bind its catalog-derived release asset path`,
    );
    invariant(
      row.llvm_url === target.llvmUrl
        && row.llvm_sha256 === target.llvmSha256
        && row.llvm_bytes === target.llvmBytes,
      `WASIX postmaster CI matrix ${row.target_id} must bind its declared LLVM toolchain`,
    );
  }
  assertSameStrings(
    new Set(matrixPairs(matrices.extensionNative)),
    new Set(extensions.filter(({ family }) => family === "native").map(({ product, target }) => `${product}\0${target}`)),
    "native extension CI matrix",
  );
  assertSameStrings(
    new Set(matrixPairs(matrices.extensionWasix)),
    new Set(extensions.filter(({ family }) => family === "wasix").map(({ product, target }) => `${product}\0${target}`)),
    "WASIX extension CI matrix",
  );
  const matrixSqlPairs = (matrix) => matrix.include.flatMap((row) => String(row.sql_names_csv ?? "").split(",").filter(Boolean).map((sqlName) => `${sqlName}\0${row.target}`));
  assertSameStrings(
    matrixSqlPairs(matrices.extensionNative),
    extensions.filter(({ family }) => family === "native").map(({ sqlName, target }) => `${sqlName}\0${target}`),
    "native extension member CI matrix",
  );
  assertSameStrings(
    matrixSqlPairs(matrices.extensionWasix),
    extensions.filter(({ family }) => family === "wasix").map(({ sqlName, target }) => `${sqlName}\0${target}`),
    "WASIX extension member CI matrix",
  );
}

function manifestArray(value) {
  return value === undefined ? [] : Array.isArray(value) ? value.map(String) : [];
}

export function validateCarrierCoverage({
  graph,
  catalog,
  targets,
  jsManifest,
  nativeToolsManifest,
  rustManifest,
  platformManifests,
}) {
  const carriers = declaredCarrierMap(catalog);
  const runtimeProducts = new Set(["liboliphaunt-native", "oliphaunt-broker", "oliphaunt-node-direct", "oliphaunt-wasix-napi"]);
  for (const product of runtimeProducts) {
    const expected = registryPackageRows({ product, packageKind: "npm" }, TOOL)
      .map((row) => row.packageName);
    const actual = catalog.carriers.filter((row) => row.product === product && row.ecosystem === "npm").map((row) => row.name);
    assertSameStrings(actual, expected, `${product} npm carrier identities`);
  }
  for (const target of targets.filter((row) => row.npmPackage)) {
    const carrier = carriers.get(`npm:${target.npmPackage}`);
    invariant(carrier?.product === target.product && carrier.version === graph.products[target.product].version, `${target.id} npm carrier is missing or version-skewed`);
    if (target.npmOs === undefined) continue;
    const manifest = platformManifests.get(target.npmPackage);
    invariant(manifest !== undefined, `${target.npmPackage} has no package manifest`);
    invariant(manifest.version === graph.products[target.product].version && manifest.optional === true, `${target.npmPackage} must be optional and match ${target.product} version`);
    assertSameStrings(manifestArray(manifest.os), [target.npmOs], `${target.npmPackage} os selector`);
    assertSameStrings(manifestArray(manifest.cpu), [target.npmCpu], `${target.npmPackage} cpu selector`);
    assertSameStrings(manifestArray(manifest.libc), target.npmLibc === undefined ? [] : [target.npmLibc], `${target.npmPackage} libc selector`);
    invariant(manifest.oliphaunt?.target === target.target, `${target.npmPackage} must select target ${target.target}`);
  }
  const expectedOptional = new Map(typescriptOptionalRuntimePackageProducts(TOOL).map((row) => [
    row.packageName,
    `workspace:${graph.products[row.product].version}`,
  ]));
  const actualOptional = object(jsManifest.optionalDependencies ?? {}, "TypeScript optionalDependencies");
  assertSameStrings(Object.keys(actualOptional), [...expectedOptional.keys()], "TypeScript optional runtime packages");
  for (const [name, version] of expectedOptional) invariant(actualOptional[name] === version, `TypeScript optional runtime ${name} must use ${version}`);
  const expectedToolsOptional = new Map(nativeToolsOptionalPackageProducts(TOOL).map((row) => [
    row.packageName,
    `workspace:${graph.products[row.product].version}`,
  ]));
  const actualToolsOptional = object(
    nativeToolsManifest.optionalDependencies ?? {},
    "native tools facade optionalDependencies",
  );
  assertSameStrings(
    Object.keys(actualToolsOptional),
    [...expectedToolsOptional.keys()],
    "native tools facade optional packages",
  );
  for (const [name, version] of expectedToolsOptional) {
    invariant(
      actualToolsOptional[name] === version,
      `native tools facade optional package ${name} must use ${version}`,
    );
  }
  const brokerMetadata = object(object(rustManifest.package, "Rust package").metadata?.oliphaunt, "Rust broker metadata");
  invariant(brokerMetadata["broker-helper"] === "oliphaunt-broker", "Rust SDK broker helper identity must be oliphaunt-broker");
  invariant(brokerMetadata["broker-version"] === graph.products["oliphaunt-broker"].version, "Rust SDK broker helper version must match the broker product");
}

export function validateExtensionCarrierCoverage(graph, catalog, products) {
  for (const product of products) {
    const targetSets = extensionRegistryPackageTargetSets(product, TOOL);
    const expected = extensionRegistryPackageStrings({ product, ...targetSets })
      .map((identity) => identity.replace(/^crates:/u, "cargo:"));
    const expectedNative = extensionNativeRegistryPackageStrings({ product, ...targetSets })
      .map((identity) => identity.replace(/^crates:/u, "cargo:"));
    const expectedWasix = extensionWasixRegistryPackageStrings({
      product,
      includeAot: targetSets.includeWasixAot,
    }).map((identity) => identity.replace(/^crates:/u, "cargo:"));
    const actual = catalog.carriers.filter((row) => expected.includes(row.id));
    assertSameStrings(actual.map((row) => row.id), expected, `${product} registry carriers`);
    for (const [family, identities] of [["native", expectedNative], ["wasix", expectedWasix]]) {
      const owner = extensionReleaseProduct(product, family, TOOL);
      invariant(
        actual.filter((row) => identities.includes(row.id))
          .every((row) => row.product === owner && row.version === graph.products[owner].version),
        `${product} ${family} carrier versions must match ${owner}`,
      );
    }
  }
}

function workflowJob(workflow, jobId) {
  return object(workflow.jobs?.[jobId], `workflow job ${jobId}`);
}

function workflowNeeds(workflow, jobId) {
  const needs = workflowJob(workflow, jobId).needs ?? [];
  return new Set((Array.isArray(needs) ? needs : [needs]).map(String));
}

function actionSteps(workflow, jobId, action) {
  const steps = workflowJob(workflow, jobId).steps;
  invariant(Array.isArray(steps), `${jobId} must declare steps`);
  return steps.filter((step) => String(step.uses ?? "").startsWith(action));
}

function namedStep(workflow, jobId, name) {
  const steps = workflowJob(workflow, jobId).steps;
  invariant(Array.isArray(steps), `${jobId} must declare steps`);
  return steps.find((step) => step.name === name);
}

function validateCrossFamilyIcuWorkflow(ci, release) {
  const condition = "${{ contains(fromJson(needs.affected.outputs.builder_jobs), 'liboliphaunt-native-release-assets') && contains(fromJson(needs.affected.outputs.builder_jobs), 'liboliphaunt-wasix-release-assets') }}";
  const native = namedStep(ci, "builds", "Download native ICU release asset for cross-family validation");
  const wasix = namedStep(ci, "builds", "Download WASIX release assets for cross-family ICU validation");
  const proof = namedStep(ci, "builds", "Prove native and WASIX ICU data identity");
  invariant(
    native?.if === condition
      && native.with?.name === "liboliphaunt-native-icu-data"
      && wasix?.if === condition
      && wasix.with?.name === "liboliphaunt-wasix-release-assets"
      && proof?.if === condition
      && String(proof.run ?? "").includes("check-cross-family-icu-data.mjs"),
    "final build qualification must compare canonical native and WASIX ICU receipts only when both release families exist",
  );

  const releaseProof = namedStep(release, "publish-dry-run", "Prove native and WASIX ICU data identity");
  invariant(
    String(releaseProof?.if ?? "").includes("'liboliphaunt-native'")
      && String(releaseProof?.if ?? "").includes("'liboliphaunt-wasix'")
      && String(releaseProof?.run ?? "").includes("check-cross-family-icu-data.mjs"),
    "release publication must recheck cross-family ICU identity when both products are selected",
  );
}

function expandTemplate(template, rows) {
  const values = [];
  for (const row of rows) {
    const value = String(template).replace(/\$\{\{\s*matrix\.([A-Za-z0-9_-]+)\s*\}\}/gu, (_match, field) => {
      invariant(row[field] !== undefined, `artifact template ${template} requires absent matrix field ${field}`);
      return String(row[field]);
    });
    invariant(!value.includes("${{"), `cannot materialize artifact template ${template}`);
    values.push(value);
  }
  return values;
}

function plannerOwnedMatrix(workflow, jobId) {
  const matrix = workflowJob(workflow, jobId).strategy?.matrix;
  invariant(typeof matrix === "string", `${jobId} must consume a planner-owned matrix expression`);
  const references = [...matrix.matchAll(/needs[.]affected[.]outputs[.]([A-Za-z0-9_]+)/gu)].map((match) => match[1]);
  invariant(new Set(references).size === 1, `${jobId} matrix must consume exactly one affected-plan output`);
  invariant(Object.hasOwn(workflowJob(workflow, "affected").outputs ?? {}, references[0]), `${jobId} references missing affected-plan output ${references[0]}`);
}

export function validateWorkflowProducer(workflow, jobId, template, rows, expectedArtifacts) {
  if (rows.length > 1 || String(template).includes("matrix.")) plannerOwnedMatrix(workflow, jobId);
  const matches = actionSteps(workflow, jobId, "actions/upload-artifact@").filter((step) => step.with?.name === template);
  invariant(matches.length === 1, `${jobId} must upload ${template} exactly once`);
  invariant(matches[0].with?.["if-no-files-found"] === "error", `${jobId}/${template} must fail when its payload is absent`);
  assertSameStrings(expandTemplate(template, rows), expectedArtifacts, `${jobId} produced artifact set`);
}

function globMatches(pattern, value) {
  const expression = `^${String(pattern).split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join(".*")}$`;
  return new RegExp(expression, "u").test(value);
}

export function validateWorkflowConsumer(workflow, jobId, producerJobs, requiredArtifacts, rows = [{}]) {
  const needs = workflowNeeds(workflow, jobId);
  for (const producer of producerJobs) invariant(needs.has(producer), `${jobId} must depend on artifact producer ${producer}`);
  const specs = actionSteps(workflow, jobId, "actions/download-artifact@").flatMap((step) => {
    const value = step.with?.name ?? step.with?.pattern;
    return value === undefined ? [] : expandTemplate(value, rows);
  });
  for (const artifact of requiredArtifacts) invariant(specs.some((pattern) => globMatches(pattern, artifact)), `${jobId} does not download required artifact ${artifact}`);
}

function validateMergedSameRunDownload(workflow, jobId, pattern, artifactPath) {
  const matches = actionSteps(workflow, jobId, "actions/download-artifact@")
    .filter((step) => step.with?.pattern === pattern);
  invariant(matches.length === 1, `${jobId} must download ${pattern} exactly once`);
  const options = matches[0].with ?? {};
  invariant(
    options.path === artifactPath
      && options["merge-multiple"] === true
      && options.name === undefined
      && options["run-id"] === undefined
      && options.repository === undefined
      && options["github-token"] === undefined,
    `${jobId}/${pattern} must merge exact same-run artifacts into ${artifactPath}`,
  );
}

export function validateCiArtifactCoverage(workflow, inventory) {
  const matrixRows = {
    nativeDesktop: inventory.matrices.nativeDesktop.include,
    nativeAndroid: inventory.matrices.nativeAndroid.include,
    nativeIos: inventory.matrices.nativeIos.include,
    broker: inventory.matrices.broker.include,
    nodeDirect: inventory.matrices.nodeDirect.include,
    wasixNapi: inventory.matrices.wasixNapi.include,
    extensionNative: inventory.matrices.extensionNative.include,
    extensionWasix: inventory.matrices.extensionWasix.include,
    wasixAot: inventory.matrices.wasixAot.include,
    wasixPostmaster: inventory.matrices.wasixPostmaster.include,
    reactNativeAndroid: inventory.matrices.reactNativeAndroid.include,
  };
  const releaseAssets = (product, kind) => ciReleaseAssetArtifactRows(product, kind, TOOL).map(({ artifactName }) => artifactName);
  const npmPackages = (product, kind) => ciNpmPackageArtifactRows(product, kind, TOOL).map(({ artifactName }) => artifactName);
  const nativeRelease = releaseAssets("liboliphaunt-native", "native-runtime");
  const nativeBy = (predicate) => nativeRelease.filter((name) => predicate(name.replace("liboliphaunt-native-release-assets-", "")));
  validateWorkflowProducer(workflow, "liboliphaunt-native-desktop", "liboliphaunt-native-release-assets-${{ matrix.target }}", matrixRows.nativeDesktop, nativeBy((target) => /^(linux|macos|windows)-/u.test(target)));
  validateWorkflowProducer(workflow, "liboliphaunt-native-desktop", "liboliphaunt-native-icu-data", [{}], ["liboliphaunt-native-icu-data"]);
  const portableIcuUpload = actionSteps(workflow, "liboliphaunt-native-desktop", "actions/upload-artifact@")
    .find((step) => step.with?.name === "liboliphaunt-native-icu-data");
  const portableIcuPackages = workflowJob(workflow, "liboliphaunt-native-desktop").steps
    .filter((step) => String(step.run ?? "").includes("package-liboliphaunt-icu-data.sh"));
  invariant(
    portableIcuUpload?.if === "${{ matrix.target == 'macos-arm64' }}"
      && portableIcuPackages.length === 1
      && portableIcuPackages[0].if === "${{ matrix.target == 'macos-arm64' }}",
    "portable ICU package and upload must be produced by exactly the macos-arm64 desktop matrix row",
  );
  validateWorkflowProducer(workflow, "liboliphaunt-native-android", "liboliphaunt-native-release-assets-${{ matrix.target }}", matrixRows.nativeAndroid, nativeBy((target) => target.startsWith("android-")));
  validateWorkflowProducer(workflow, "liboliphaunt-native-ios", "liboliphaunt-native-release-assets-${{ matrix.target }}", matrixRows.nativeIos, nativeBy((target) => target === "ios-xcframework"));
  validateWorkflowProducer(
    workflow,
    "liboliphaunt-native-android-abi",
    "liboliphaunt-native-abi-compatible-release-assets-android-datum64",
    [{}],
    ["liboliphaunt-native-abi-compatible-release-assets-android-datum64"],
  );
  validateWorkflowProducer(
    workflow,
    "liboliphaunt-native-ios-abi",
    "liboliphaunt-native-abi-compatible-release-assets-ios-datum64",
    [{}],
    ["liboliphaunt-native-abi-compatible-release-assets-ios-datum64"],
  );
  validateWorkflowProducer(workflow, "broker-runtime", "oliphaunt-broker-release-assets-${{ matrix.target }}", matrixRows.broker, releaseAssets("oliphaunt-broker", "broker-helper"));
  validateWorkflowProducer(workflow, "node-direct", "oliphaunt-node-direct-release-assets-${{ matrix.target }}", matrixRows.nodeDirect, releaseAssets("oliphaunt-node-direct", "node-direct-addon"));
  validateWorkflowProducer(workflow, "node-direct", "oliphaunt-node-direct-npm-package-${{ matrix.target }}", matrixRows.nodeDirect, npmPackages("oliphaunt-node-direct", "node-direct-addon"));
  validateWorkflowProducer(workflow, "wasix-napi", "oliphaunt-wasix-napi-release-assets-${{ matrix.target }}", matrixRows.wasixNapi, releaseAssets("oliphaunt-wasix-napi", "wasix-napi-addon"));
  validateWorkflowProducer(workflow, "wasix-napi", "oliphaunt-wasix-napi-npm-package-${{ matrix.target }}", matrixRows.wasixNapi, npmPackages("oliphaunt-wasix-napi", "wasix-napi-addon"));
  const nativeExtensionArtifacts = sorted(new Set(inventory.extensions.filter(({ family }) => family === "native").map(({ target }) => `liboliphaunt-native-extension-artifacts-${target}`)));
  const wasixExtensionArtifacts = sorted(new Set(inventory.extensions.filter(({ family }) => family === "wasix").map(({ target }) => `liboliphaunt-wasix-extension-artifacts-${target}`)));
  validateWorkflowProducer(workflow, "extension-artifacts-native", "liboliphaunt-native-extension-artifacts-${{ matrix.target }}", matrixRows.extensionNative, nativeExtensionArtifacts);
  validateWorkflowProducer(workflow, "extension-artifacts-wasix", "liboliphaunt-wasix-extension-artifacts-${{ matrix.target }}", matrixRows.extensionWasix, wasixExtensionArtifacts);
  const wasixAot = matrixRows.wasixAot.map(({ target_id }) => `liboliphaunt-wasix-runtime-aot-${target_id}`);
  const extensionAot = matrixRows.wasixAot.map(({ target_id }) => `liboliphaunt-wasix-extension-aot-${target_id}`);
  validateWorkflowProducer(workflow, "liboliphaunt-wasix-aot", "liboliphaunt-wasix-runtime-aot-${{ matrix.target_id }}", matrixRows.wasixAot, wasixAot);
  validateWorkflowProducer(workflow, "liboliphaunt-wasix-aot", "liboliphaunt-wasix-extension-aot-${{ matrix.target_id }}", matrixRows.wasixAot, extensionAot);
  for (const row of inventory.sdkProducts) validateWorkflowProducer(workflow, row.product.replace(/^oliphaunt-/u, "") === "wasix-rust" ? "wasix-rust-package" : `${row.product.replace(/^oliphaunt-/u, "")}-sdk-package`, row.artifactName, [{}], [row.artifactName]);
  for (const [jobId, artifact] of [
    ["liboliphaunt-native-release-assets", "liboliphaunt-native-release-assets"],
    ["extension-packages", "oliphaunt-extension-package-artifacts"],
    ["mobile-extension-packages", "oliphaunt-mobile-extension-package-artifacts"],
    ["liboliphaunt-wasix-runtime", "liboliphaunt-wasix-runtime-portable"],
    ["liboliphaunt-wasix-release-assets", "liboliphaunt-wasix-release-assets"],
    ["wasix-postmaster", "liboliphaunt-wasix-postmaster-release-assets"],
  ]) validateWorkflowProducer(workflow, jobId, artifact, [{}], [artifact]);
  const postmasterReleaseAssets = releaseAssets(
    "liboliphaunt-wasix-postmaster",
    "wasix-postmaster-runtime",
  );
  validateWorkflowProducer(
    workflow,
    "wasix-postmaster-target",
    "liboliphaunt-wasix-postmaster-release-assets-${{ matrix.target_id }}",
    matrixRows.wasixPostmaster,
    postmasterReleaseAssets,
  );
  validateWorkflowProducer(
    workflow,
    "wasix-postmaster-portable",
    "liboliphaunt-wasix-postmaster-portable-build-inputs",
    [{}],
    ["liboliphaunt-wasix-postmaster-portable-build-inputs"],
  );
  const portablePostmasterQualification = workflowJob(workflow, "wasix-postmaster-portable").steps
    .find((step) => step.name === "Build and qualify portable WASIX postmaster inputs");
  invariant(
    portablePostmasterQualification?.run?.includes("--upstream deep")
      && portablePostmasterQualification.run.includes("liboliphaunt-wasix-postmaster:portable-inputs"),
    "portable WASIX postmaster qualification must execute its complete Moon dependency graph",
  );
  const targetPostmasterQualification = workflowJob(workflow, "wasix-postmaster-target").steps
    .find((step) => step.name === "Build, verify, qualify, and package WASIX postmaster");
  invariant(
    targetPostmasterQualification?.run?.includes("--upstream deep")
      && targetPostmasterQualification.run.includes("liboliphaunt-wasix-postmaster:release-assets")
      && targetPostmasterQualification.if === undefined,
    "every WASIX postmaster target must execute its complete Moon dependency graph",
  );
  const postmasterUpload = actionSteps(workflow, "wasix-postmaster-target", "actions/upload-artifact@")
    .find((step) => step.with?.name === "liboliphaunt-wasix-postmaster-release-assets-${{ matrix.target_id }}");
  invariant(
    postmasterUpload?.if === undefined
      && postmasterUpload.with?.path === "${{ matrix.release_asset_path }}",
    "every WASIX postmaster target must upload its catalog-derived release asset path",
  );
  invariant(
    actionSteps(workflow, "wasix-postmaster", "./.github/actions/setup-moon").length === 1,
    "WASIX postmaster aggregation must load its release catalog through the pinned Moon toolchain",
  );
  const postmasterAggregation = workflowJob(workflow, "wasix-postmaster").steps
    .find((step) => step.name === "Merge target WASIX postmaster release assets");
  invariant(
    String(postmasterAggregation?.run ?? "").includes(
      "run-moon-targets.sh --upstream none liboliphaunt-wasix-postmaster:aggregate-release-assets",
    ),
    "WASIX postmaster aggregation must run the product-owned aggregate Moon task without producer dependencies",
  );
  validateMergedSameRunDownload(
    workflow,
    "wasix-postmaster",
    "liboliphaunt-wasix-postmaster-release-assets-*",
    "target/oliphaunt-wasix-postmaster/release-assets",
  );
  validateWorkflowConsumer(
    workflow,
    "wasix-postmaster-target",
    ["wasix-postmaster-portable"],
    ["liboliphaunt-wasix-postmaster-portable-build-inputs"],
  );
  validateWorkflowConsumer(
    workflow,
    "wasix-postmaster",
    ["wasix-postmaster-target"],
    postmasterReleaseAssets,
  );
  validateWorkflowConsumer(
    workflow,
    "broker-release-assets",
    ["broker-runtime"],
    releaseAssets("oliphaunt-broker", "broker-helper"),
  );
  validateWorkflowConsumer(
    workflow,
    "node-direct-release-assets",
    ["node-direct"],
    [
      ...releaseAssets("oliphaunt-node-direct", "node-direct-addon"),
      ...npmPackages("oliphaunt-node-direct", "node-direct-addon"),
    ],
  );
  validateMergedSameRunDownload(
    workflow,
    "broker-release-assets",
    "oliphaunt-broker-release-assets-*",
    "target/oliphaunt-broker/release-assets",
  );
  validateMergedSameRunDownload(
    workflow,
    "node-direct-release-assets",
    "oliphaunt-node-direct-release-assets-*",
    "target/oliphaunt-node-direct/release-assets",
  );
  validateWorkflowConsumer(
    workflow,
    "wasix-napi-release-assets",
    ["wasix-napi"],
    [
      ...releaseAssets("oliphaunt-wasix-napi", "wasix-napi-addon"),
      ...npmPackages("oliphaunt-wasix-napi", "wasix-napi-addon"),
    ],
  );
  validateMergedSameRunDownload(
    workflow,
    "wasix-napi-release-assets",
    "oliphaunt-wasix-napi-release-assets-*",
    "target/oliphaunt-wasix-napi/release-assets",
  );
  validateMergedSameRunDownload(
    workflow,
    "wasix-napi-release-assets",
    "oliphaunt-wasix-napi-npm-package-*",
    "target/oliphaunt-wasix-napi/npm-packages",
  );
  validateMergedSameRunDownload(
    workflow,
    "node-direct-release-assets",
    "oliphaunt-node-direct-npm-package-*",
    "target/oliphaunt-node-direct/npm-packages",
  );
  for (const jobId of ["broker-release-assets", "node-direct-release-assets", "wasix-napi-release-assets"]) {
    invariant(
      actionSteps(workflow, jobId, "actions/upload-artifact@").length === 0,
      `${jobId} must validate same-run target artifacts without uploading a duplicate product artifact`,
    );
  }
  validateWorkflowConsumer(
    workflow,
    "liboliphaunt-native-android-abi",
    ["liboliphaunt-native-android"],
    [
      "liboliphaunt-native-target-android-arm64-v8a",
      "liboliphaunt-native-target-android-x86_64",
      "liboliphaunt-native-release-assets-android-x86_64",
    ],
  );
  validateWorkflowConsumer(
    workflow,
    "liboliphaunt-native-ios-abi",
    ["liboliphaunt-native-ios"],
    [
      "liboliphaunt-native-target-ios-xcframework",
      "liboliphaunt-native-release-assets-ios-xcframework",
    ],
  );
  validateWorkflowConsumer(
    workflow,
    "liboliphaunt-native-release-assets",
    [
      "liboliphaunt-native-desktop",
      "liboliphaunt-native-android",
      "liboliphaunt-native-android-abi",
      "liboliphaunt-native-ios",
      "liboliphaunt-native-ios-abi",
    ],
    [
      ...nativeRelease,
      "liboliphaunt-native-abi-compatible-release-assets-android-datum64",
      "liboliphaunt-native-abi-compatible-release-assets-ios-datum64",
    ],
  );
  validateWorkflowConsumer(workflow, "extension-artifacts-wasix", ["liboliphaunt-wasix-runtime"], ["liboliphaunt-wasix-runtime-portable"]);
  validateWorkflowConsumer(workflow, "liboliphaunt-wasix-aot", ["liboliphaunt-wasix-runtime"], ["liboliphaunt-wasix-runtime-portable"]);
  validateWorkflowConsumer(
    workflow,
    "wasix-napi",
    ["extension-artifacts-wasix", "liboliphaunt-wasix-aot", "liboliphaunt-wasix-runtime"],
    [
      "liboliphaunt-wasix-runtime-portable",
      ...wasixExtensionArtifacts,
      ...wasixAot,
      ...extensionAot,
    ],
    matrixRows.wasixNapi,
  );
  validateMergedSameRunDownload(
    workflow,
    "wasix-napi",
    "liboliphaunt-wasix-extension-artifacts-*",
    "target/extensions/wasix/release-assets",
  );
  const wasixNapiBuild = namedStep(workflow, "wasix-napi", "Build WASIX Node-API release assets");
  invariant(
    wasixNapiBuild?.env?.OLIPHAUNT_ARTIFACT_CRATE_REQUIRE_PAYLOAD === "1"
      && wasixNapiBuild.env.OLIPHAUNT_WASIX_GENERATED_ASSETS_DIR === "${{ github.workspace }}/target/oliphaunt-wasix/assets"
      && wasixNapiBuild.env.OLIPHAUNT_WASM_GENERATED_AOT_DIR === "${{ github.workspace }}/target/oliphaunt-wasix/aot"
      && wasixNapiBuild.env.OLIPHAUNT_WASIX_EXTENSION_ARTIFACT_ROOT === "${{ github.workspace }}/target/extension-artifacts"
      && wasixNapiBuild.env.OLIPHAUNT_ICU_DATA_DIR === "${{ github.workspace }}/target/oliphaunt-wasix/wasix-build/work/icu-wasix/share/icu"
      && wasixNapiBuild.env.OLIPHAUNT_WASIX_NAPI_ARTIFACT_SOURCE_SHA === "${{ github.event.pull_request.head.sha || github.sha }}"
      && String(wasixNapiBuild.run ?? "").includes("OLIPHAUNT_MOON_UPSTREAM=none"),
    "WASIX Node-API builds must fail closed on exact same-run portable, ICU, AOT, and extension payload roots",
  );
  const wasixNapiExtensionStage = namedStep(workflow, "wasix-napi", "Stage exact-extension WASIX build inputs");
  invariant(
    String(wasixNapiExtensionStage?.run ?? "").includes(
      "build-extension-ci-artifacts.mjs --all --family wasix --require-wasix",
    ),
    "WASIX Node-API builds must stage complete exact-extension portable and target AOT inputs",
  );
  const wasixNapiAotRestore = namedStep(workflow, "wasix-napi", "Restore exact target core and tool AOT layout");
  invariant(
    wasixNapiAotRestore?.env?.EXPECTED_TARGET_TRIPLE === "${{ matrix.target_triple }}"
      && String(wasixNapiAotRestore.run ?? "").includes("target-triple.txt")
      && String(wasixNapiAotRestore.run ?? "").includes("target/oliphaunt-wasix/aot/$target"),
    "WASIX Node-API builds must restore marker-validated host AOT inputs to the Cargo artifact layout",
  );
  validateWorkflowConsumer(workflow, "wasix-release-regression", ["extension-artifacts-wasix", "liboliphaunt-wasix-runtime", "liboliphaunt-wasix-aot"], [
    "liboliphaunt-wasix-runtime-portable",
    ...wasixExtensionArtifacts,
    "liboliphaunt-wasix-runtime-aot-linux-x64-gnu",
    "liboliphaunt-wasix-extension-aot-linux-x64-gnu",
  ]);
  validateWorkflowConsumer(workflow, "liboliphaunt-wasix-release-assets", ["liboliphaunt-wasix-runtime", "liboliphaunt-wasix-aot"], ["liboliphaunt-wasix-runtime-portable", ...wasixAot]);
  validateWorkflowConsumer(workflow, "extension-packages", ["extension-artifacts-native", "extension-artifacts-wasix", "liboliphaunt-wasix-aot"], [...nativeExtensionArtifacts, ...wasixExtensionArtifacts, ...extensionAot]);
  validateWorkflowConsumer(workflow, "mobile-extension-packages", ["extension-artifacts-native"], nativeExtensionArtifacts);
  const abiCompatibleIosRelease = ["liboliphaunt-native-abi-compatible-release-assets-ios-datum64"];
  validateWorkflowConsumer(workflow, "swift-sdk-package", ["liboliphaunt-native-ios-abi"], abiCompatibleIosRelease);
  validateWorkflowConsumer(workflow, "react-native-sdk-package", ["liboliphaunt-native-ios-abi"], abiCompatibleIosRelease);
  validateWorkflowConsumer(workflow, "mobile-build-android", ["liboliphaunt-native-android", "liboliphaunt-native-android-abi", "mobile-extension-packages", "kotlin-sdk-package", "react-native-sdk-package"], [
    ...matrixRows.reactNativeAndroid.map(({ target }) => `liboliphaunt-native-target-${target}`),
    "liboliphaunt-native-abi-compatible-release-assets-android-datum64",
    "oliphaunt-mobile-extension-package-artifacts",
    "oliphaunt-kotlin-sdk-package-artifacts",
    "oliphaunt-react-native-sdk-package-artifacts",
  ], matrixRows.reactNativeAndroid);
  validateWorkflowConsumer(workflow, "mobile-build-ios", ["liboliphaunt-native-ios", "liboliphaunt-native-ios-abi", "mobile-extension-packages", "react-native-sdk-package", "swift-sdk-package"], [
    "liboliphaunt-native-target-ios-xcframework",
    ...abiCompatibleIosRelease,
    "oliphaunt-mobile-extension-package-artifacts",
    "oliphaunt-react-native-sdk-package-artifacts",
    "oliphaunt-swift-sdk-package-artifacts",
  ]);
  for (const jobId of ["swift-sdk-package", "react-native-sdk-package", "mobile-build-ios"]) {
    invariant(
      actionSteps(workflow, jobId, "actions/download-artifact@")
        .every((step) => step.with?.name !== "liboliphaunt-native-release-assets-ios-xcframework"),
      `${jobId} must not bypass iOS ABI-compatibility admission`,
    );
  }
  invariant(
    actionSteps(workflow, "mobile-build-android", "actions/download-artifact@")
      .every((step) => step.with?.name !== "liboliphaunt-native-release-assets-android-x86_64"),
    "mobile-build-android must not bypass Android ABI-compatibility admission",
  );
  validateWorkflowConsumer(
    workflow,
    "mobile-e2e-android",
    ["mobile-build-android"],
    ["react-native-mobile-android-app-android-x86_64"],
  );
  validateWorkflowConsumer(
    workflow,
    "mobile-e2e-ios",
    ["mobile-build-ios"],
    ["react-native-mobile-ios-app"],
  );
  for (const [jobId, platform] of [["mobile-e2e-android", "android"], ["mobile-e2e-ios", "ios"]]) {
    const execution = workflowJob(workflow, jobId).steps.find(
      (step) => step.name === `Run ${platform === "android" ? "Android" : "iOS"} installed-app E2E`,
    );
    invariant(
      String(execution?.run ?? "").includes(`mobile-e2e.sh ${platform}`),
      `${jobId} must execute the installed-app receipt validator`,
    );
  }
  const finalE2eNeeds = workflowNeeds(workflow, "e2e");
  invariant(
    finalE2eNeeds.has("mobile-e2e-android") && finalE2eNeeds.has("mobile-e2e-ios"),
    "final E2E qualification must depend on both representative mobile executions",
  );
  const finalExecutionGate = workflowJob(workflow, "e2e").steps.find(
    (step) => step.name === "Check final release execution qualification",
  );
  invariant(
    finalExecutionGate?.env?.SELECTED_JOBS_JSON === "${{ needs.affected.outputs.e2e_jobs }}"
      && String(finalExecutionGate.run ?? "").includes("check-ci-gate.mjs selected"),
    "final release execution qualification must enforce the planner-selected E2E jobs",
  );
  invariant(
    workflowNeeds(workflow, "required").has("e2e")
      && workflowNeeds(workflow, "qualified").has("required"),
    "release qualification must remain downstream of final mobile execution qualification",
  );
}

function platformPackageManifests(graph, targets) {
  const names = new Set(targets.filter(({ npmPackage }) => npmPackage).map(({ npmPackage }) => npmPackage));
  const manifests = new Map();
  for (const config of Object.values(graph.products)) {
    for (const relativePath of config.version_files ?? []) {
      if (path.basename(relativePath) !== "package.json") continue;
      const manifest = readJson(relativePath);
      if (!names.has(manifest.name)) continue;
      invariant(!manifests.has(manifest.name), `duplicate platform package manifest ${manifest.name}`);
      manifests.set(manifest.name, manifest);
    }
  }
  return manifests;
}

function validateStructuredExtensionRecipes(products, extensions, graph) {
  for (const product of products) {
    for (const sqlName of extensionSqlNames(product, TOOL)) {
      const mobile = extensions.some(({ product: owner, sqlName: member, kind }) => owner === product && member === sqlName && kind === "native-static-registry");
      if (!mobile) continue;
      const recipe = path.join(extensionMemberPath(product, sqlName, TOOL), "targets/native-static-registry.toml");
      if (!existsSync(path.join(ROOT, recipe))) continue;
      invariant(statSync(path.join(ROOT, recipe)).isFile(), `${recipe} must be a file`);
      invariant(readToml(recipe).status === undefined, `${recipe} must not carry an intermediate support status`);
    }
  }
}

export function repositoryInventory() {
  const graph = loadGraph(TOOL);
  const targets = allArtifactTargets({}, TOOL);
  const products = exactExtensionProducts(TOOL);
  const extensions = extensionArtifactTargets({}, TOOL);
  return {
    graph,
    targets,
    products,
    extensions,
    catalog: loadPublicationCatalog(TOOL),
    sdkProducts: sdkPackageProducts(TOOL),
    matrices: {
      native: liboliphauntNativeRuntimeMatrix(),
      nativeDesktop: liboliphauntNativeDesktopRuntimeMatrix(),
      nativeAndroid: liboliphauntNativeAndroidRuntimeMatrix(),
      nativeIos: liboliphauntNativeIosRuntimeMatrix(),
      reactNativeAndroid: reactNativeAndroidMobileAppMatrix(),
      extensionNative: extensionArtifactsNativeMatrix(),
      extensionWasix: extensionArtifactsWasixMatrix(),
      wasixAot: liboliphauntWasixAotRuntimeMatrix(),
      wasixPostmaster: liboliphauntWasixPostmasterRuntimeMatrix(),
      broker: brokerRuntimeMatrix(),
      nodeDirect: nodeDirectRuntimeMatrix(),
      wasixNapi: wasixNapiRuntimeMatrix(),
    },
  };
}

export function validateRepository() {
  const inventory = repositoryInventory();
  const wasixNapiNativeBuild = readFileSync(
    path.join(ROOT, "src/runtimes/wasix-napi/tools/build-native.sh"),
    "utf8",
  );
  const wasixNapiLinuxBaselineBuild = readFileSync(
    path.join(ROOT, "tools/release/build-linux-wasix-napi-baseline.sh"),
    "utf8",
  );
  invariant(
    wasixNapiNativeBuild.includes("tools/release/build-linux-wasix-napi-baseline.sh"),
    "WASIX Node-API Linux release variants must use the pinned baseline builder",
  );
  invariant(
    wasixNapiLinuxBaselineBuild.includes(
      "rust@sha256:5b9332190bb3b9ece73b810cd1f1e9f06343b294ce184bcb067f0747d7d333ea",
    )
      && wasixNapiLinuxBaselineBuild.includes('expected_builder_glibc="glibc 2.36"')
      && wasixNapiLinuxBaselineBuild.includes("docker_cargo none")
      && wasixNapiLinuxBaselineBuild.includes("cargo build")
      && wasixNapiLinuxBaselineBuild.includes("--offline"),
    "WASIX Node-API Linux baseline builder must pin Bookworm and compile in the sealed offline phase",
  );
  invariant((inventory.graph.artifact_targets ?? []).length === 0, "artifact targets must be owned by Moon product metadata, not a central legacy table");
  const wasixNapiDependencies = inventory.graph.moon_projects["oliphaunt-wasix-napi"]?.dependencies ?? [];
  assertSameStrings(
    wasixNapiDependencies
      .filter(({ id, scope }) => scope === "production" && inventory.products.includes(id))
      .map(({ id }) => id),
    inventory.products,
    "WASIX Node-API exact-extension production dependency closure",
  );
  for (const [product, preset] of Object.entries({
    "liboliphaunt-native": "liboliphaunt-native",
    "liboliphaunt-wasix": "liboliphaunt-wasix",
    "liboliphaunt-wasix-postmaster": "liboliphaunt-wasix-postmaster",
    "oliphaunt-broker": "broker-helper",
    "oliphaunt-node-direct": "node-direct-addon",
    "oliphaunt-wasix-napi": "wasix-napi-addon",
  })) invariant(releaseMetadata(product, TOOL).artifactTargets?.preset === preset, `${product} must use Moon artifact target preset ${preset}`);
  validateArtifactTargetContract(inventory.targets);
  validateExtensionCoverage(inventory.targets, inventory.products, inventory.extensions);
  validateMatrixCoverage(inventory.targets, inventory.extensions, inventory.matrices);
  validateCarrierCoverage({
    graph: inventory.graph,
    catalog: inventory.catalog,
    targets: inventory.targets,
    jsManifest: readJson("src/sdks/js/package.json"),
    nativeToolsManifest: readJson("src/runtimes/liboliphaunt/native/tools-npm/package.json"),
    rustManifest: readToml("src/sdks/rust/Cargo.toml"),
    platformManifests: platformPackageManifests(inventory.graph, inventory.targets),
  });
  validateExtensionCarrierCoverage(inventory.graph, inventory.catalog, inventory.products);
  validateStructuredExtensionRecipes(inventory.products, inventory.extensions, inventory.graph);
  const ci = parseWorkflow(ROOT, ".github/workflows/ci.yml");
  const release = parseWorkflow(ROOT, ".github/workflows/release.yml");
  validateCiArtifactCoverage(ci, inventory);
  validateCrossFamilyIcuWorkflow(ci, release);
  const fullPlan = planForFullRun({ wasmTarget: "all", nativeTarget: "all", mobileTarget: "all" });
  const requiredProductBuilders = new Set([...BUILDER_JOBS].filter((job) => job !== "wasix-release-regression"));
  invariant([...requiredProductBuilders].every((job) => fullPlan.jobs.has(job)), "full CI planning must select every product artifact builder");
  const wasixNapiPlan = new Set(["wasix-napi"]);
  addImpliedJobs(wasixNapiPlan, new Set());
  invariant(
    ["extension-artifacts-wasix", "liboliphaunt-wasix-aot", "liboliphaunt-wasix-runtime"]
      .every((job) => wasixNapiPlan.has(job)),
    "WASIX Node-API CI planning must select every same-run embedded payload producer",
  );
  for (const product of inventory.products) {
    const extensionPlan = planJobsForAffected(new Set([product]), new Set());
    invariant(
      [
        "wasix-napi",
        "extension-artifacts-wasix",
        "liboliphaunt-wasix-aot",
        "liboliphaunt-wasix-runtime",
      ].every((job) => extensionPlan.has(job)),
      `${product} CI planning must rebuild WASIX Node-API carriers and every embedded payload producer`,
    );
  }
  const focusedWasix = planForFullRun({ wasmTarget: "linux-x64-gnu", nativeTarget: "all", mobileTarget: "all" });
  assertSameStrings(focusedWasix.jobs, ["affected", "extension-artifacts-wasix", "liboliphaunt-wasix-aot", "liboliphaunt-wasix-runtime"], "focused WASIX CI jobs");
  const focusedAndroid = renderPlanForFullRun({
    wasmTarget: "all",
    nativeTarget: "android-arm64-v8a",
    mobileTarget: "android",
  });
  assertSameStrings(
    focusedAndroid.liboliphaunt_native_android_runtime_matrix.include.map(({ target }) => target),
    ["android-arm64-v8a", "android-x86_64"],
    "focused Android compatibility-domain runtime targets",
  );
  assertSameStrings(
    focusedAndroid.react_native_android_mobile_app_matrix.include.map(({ target }) => target),
    ["android-x86_64"],
    "focused Android representative app target",
  );
  invariant(rawArtifactTargetRows(TOOL).length === inventory.targets.length, "raw and normalized artifact target inventories must have equal cardinality");
  return {
    artifactTargets: inventory.targets.length,
    extensionProducts: inventory.products.length,
    extensionTargets: inventory.extensions.length,
    registryCarriers: inventory.catalog.carriers.length,
    sdkProducts: inventory.sdkProducts.length,
  };
}

if (import.meta.main) {
  try {
    const summary = validateRepository();
    console.log(
      `artifact target checks passed (${summary.artifactTargets} runtime/helper rows, ` +
        `${summary.extensionProducts} exact-extension products, ${summary.extensionTargets} extension rows, ` +
        `${summary.registryCarriers} catalog-declared registry carrier minima, ${summary.sdkProducts} SDK packages)`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
