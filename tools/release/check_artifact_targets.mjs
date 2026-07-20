#!/usr/bin/env bun

import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { BUILDER_JOBS, planForFullRun } from "../graph/ci_plan.mjs";
import {
  assertCiWorkflow,
  assertReleaseWorkflow,
  parseWorkflow,
} from "../policy/assertions/workflow-semantics.mjs";
import { extensionRegistryPackageStrings } from "./extension-registry-packages.mjs";
import {
  brokerRuntimeMatrix,
  extensionArtifactsNativeMatrix,
  extensionArtifactsWasixMatrix,
  jsExactCandidateConsumerMatrix,
  liboliphauntNativeAndroidRuntimeMatrix,
  liboliphauntNativeDesktopRuntimeMatrix,
  liboliphauntNativeIosRuntimeMatrix,
  liboliphauntNativeRuntimeMatrix,
  liboliphauntWasixAotRuntimeMatrix,
  nodeDirectRuntimeMatrix,
  reactNativeAndroidMobileAppMatrix,
} from "./artifact_target_matrix.mjs";
import {
  allArtifactTargets,
  ciNpmPackageArtifactRows,
  ciReleaseAssetArtifactRows,
  exactExtensionProducts,
  extensionArtifactTargets,
  extensionMetadata,
  extensionMemberPath,
  extensionRegistryPackageTargetSets,
  extensionSqlNames,
  rawArtifactTargetRows,
  releaseMetadata,
  sdkPackageProducts,
  typescriptOptionalRuntimePackageProducts,
} from "./release-artifact-targets.mjs";
import { ROOT, compareText, loadGraph } from "./release-graph.mjs";
import { declaredCarrierMap, loadPublicationCatalog } from "./publication-catalog.mjs";

const TOOL = "check_artifact_targets.mjs";
const GITHUB = "github-release";
const DESKTOP_SURFACES = [GITHUB, "rust-native-direct", "typescript-native-direct"];
const BROKER_SURFACES = [GITHUB, "rust-broker", "typescript-broker"];
const NODE_SURFACES = [GITHUB, "npm-optional"];

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
  },
]);

const WASIX_AOT = Object.freeze([
  ["linux-arm64-gnu", "aarch64-unknown-linux-gnu", "ubuntu-24.04-arm", "llvm-linux-aarch64.tar.xz", 668873496, "1fddcf5b30f9d3e073eb161509220b4136ea8e2f114f23084bdec33e40fa87c1"],
  ["linux-x64-gnu", "x86_64-unknown-linux-gnu", "ubuntu-24.04", "llvm-linux-amd64.tar.xz", 741670068, "5fb1c687c5e895d517a23e7aabea9ec3557e3a3e33f8a8d3a8d21395157b3906"],
  ["macos-arm64", "aarch64-apple-darwin", "macos-26", "llvm-darwin-aarch64.tar.xz", 479103872, "f64460f6c8a28876737402542fc5b28bb1f4262cef85f799b65ce2a7ee6f8847"],
  ["windows-x64-msvc", "x86_64-pc-windows-msvc", "windows-2025-vs2026", "llvm-windows-amd64.tar.xz", 757929860, "19ff22b0cf74b53dad2fc717db2209f8162b768fc6dede9e2caa6a83c724496e"],
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
  published = true,
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
    published,
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
    );
  }
  rows.push(
    targetRow({
      product: "liboliphaunt-native",
      id: "macos-x64",
      kind: "native-runtime",
      target: "macos-x64",
      asset: "liboliphaunt-{version}-macos-x64.tar.gz",
      surfaces: DESKTOP_SURFACES,
      published: false,
      triple: "x86_64-apple-darwin",
      runner: "macos-26",
      library: "lib/liboliphaunt.dylib",
      tier: "planned",
    }),
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
    portableRow(
      "liboliphaunt-native",
      "runtime-resources",
      "runtime-resources",
      "liboliphaunt-{version}-runtime-resources.tar.gz",
      [GITHUB, "maven", "rust-native-direct", "swiftpm", "typescript-native-direct"],
    ),
    targetRow({
      product: "liboliphaunt-native",
      id: "icu-data",
      kind: "icu-data",
      target: "portable",
      asset: "liboliphaunt-{version}-icu-data.tar.gz",
      surfaces: [GITHUB, "maven", "react-native-android", "react-native-ios", "rust-native-direct", "swiftpm", "typescript-native-direct"],
      npm: "@oliphaunt/icu",
    }),
    portableRow(
      "liboliphaunt-native",
      "package-size",
      "package-footprint",
      "liboliphaunt-{version}-package-size.tsv",
      [GITHUB, "maven", "react-native-android", "react-native-ios", "rust-native-direct", "swiftpm", "typescript-native-direct"],
    ),
    portableRow("liboliphaunt-native", "checksums", "checksums", "liboliphaunt-{version}-release-assets.sha256"),
    portableRow("liboliphaunt-wasix", "runtime-portable", "wasix-runtime", "liboliphaunt-wasix-{version}-runtime-portable.tar.zst"),
    portableRow("liboliphaunt-wasix", "icu-data", "icu-data", "liboliphaunt-wasix-{version}-icu-data.tar.zst"),
    portableRow("liboliphaunt-wasix", "checksums", "checksums", "liboliphaunt-wasix-{version}-release-assets.sha256"),
    portableRow("oliphaunt-broker", "checksums", "checksums", "oliphaunt-broker-{version}-release-assets.sha256", BROKER_SURFACES),
    portableRow("oliphaunt-node-direct", "checksums", "checksums", "oliphaunt-node-direct-{version}-release-assets.sha256"),
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
    published: target.published,
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
    if (row.published && row.surfaces.includes(GITHUB)) {
      const key = `${row.product}\0${row.asset}`;
      invariant(!seenAssets.has(key), `${row.product} publishes duplicate asset ${row.asset}`);
      seenAssets.add(key);
    }
    if (!row.published) {
      const source = actualTargets.find(({ id }) => id === row.id);
      invariant(row.tier === "planned", `${row.id} must be explicitly planned when unpublished`);
      invariant((source.unsupportedReason ?? source.unsupported_reason ?? "").trim().length >= 40, `${row.id} must explain why it is not published`);
    }
  }
}

export function validateExtensionCoverage(runtimeTargets, products, extensionTargets) {
  invariant(products.length > 0 && new Set(products).size === products.length, "extension product ids must be a non-empty unique set");
  const nativeTargets = runtimeTargets
    .filter((row) => row.product === "liboliphaunt-native" && row.kind === "native-runtime" && row.published && row.extensionArtifacts)
    .map(({ target }) => target);
  const wasixTargets = runtimeTargets
    .filter((row) => row.product === "liboliphaunt-wasix" && row.kind === "wasix-runtime" && row.published)
    .map(({ target }) => target === "portable" ? "wasix-portable" : target);
  const expectedPairs = new Set(products.flatMap((product) => extensionSqlNames(product, TOOL).flatMap((sqlName) => [
    ...nativeTargets.map((target) => `${product}\0${sqlName}\0native\0${target}`),
    ...wasixTargets.map((target) => `${product}\0${sqlName}\0wasix\0${target}`),
  ])));
  const actualPairs = new Set(extensionTargets.map((row) => `${row.product}\0${row.sqlName}\0${row.family}\0${row.target}`));
  assertSameStrings(actualPairs, expectedPairs, "exact-extension product/member/family/target pairs");
  invariant(actualPairs.size === extensionTargets.length, "exact-extension target rows must be unique");
  for (const row of extensionTargets) {
    invariant(row.published && row.status === "supported", `${row.product}/${row.target} must be supported and published`);
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
  const published = (product, kind) => targets.filter((row) => row.product === product && row.kind === kind && row.published);
  assertSameStrings(
    matrices.native.include.map(({ target }) => target),
    published("liboliphaunt-native", "native-runtime").map(({ target }) => target),
    "native runtime CI matrix",
  );
  const partitions = [matrices.nativeDesktop, matrices.nativeAndroid, matrices.nativeIos];
  assertSameStrings(partitions.flatMap(({ include }) => include.map(({ target }) => target)), matrices.native.include.map(({ target }) => target), "native runtime CI matrix partitions");
  invariant(new Set(partitions.flatMap(({ include }) => include.map(({ target }) => target))).size === matrices.native.include.length, "native runtime CI partitions must not overlap");
  assertSameStrings(
    matrices.reactNativeAndroid.include.map(({ target }) => target),
    published("liboliphaunt-native", "native-runtime").filter(({ surfaces }) => surfaces.includes("react-native-android")).map(({ target }) => target),
    "React Native Android CI matrix",
  );
  assertSameStrings(matrices.broker.include.map(({ target }) => target), published("oliphaunt-broker", "broker-helper").map(({ target }) => target), "broker CI matrix");
  assertSameStrings(matrices.nodeDirect.include.map(({ target }) => target), published("oliphaunt-node-direct", "node-direct-addon").map(({ target }) => target), "Node direct CI matrix");
  assertSameStrings(matrices.wasixAot.include.map(({ target_id }) => target_id), published("liboliphaunt-wasix", "wasix-aot-runtime").map(({ target }) => target), "WASIX AOT CI matrix");
  const wasixAotTargets = new Map(
    published("liboliphaunt-wasix", "wasix-aot-runtime").map((target) => [target.target, target]),
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
  assertSameStrings(
    new Set(matrixPairs(matrices.extensionNative)),
    new Set(extensions.filter(({ family, published: isPublished }) => family === "native" && isPublished).map(({ product, target }) => `${product}\0${target}`)),
    "native extension CI matrix",
  );
  assertSameStrings(
    new Set(matrixPairs(matrices.extensionWasix)),
    new Set(extensions.filter(({ family, published: isPublished }) => family === "wasix" && isPublished).map(({ product, target }) => `${product}\0${target}`)),
    "WASIX extension CI matrix",
  );
  const matrixSqlPairs = (matrix) => matrix.include.flatMap((row) => String(row.sql_names_csv ?? "").split(",").filter(Boolean).map((sqlName) => `${sqlName}\0${row.target}`));
  assertSameStrings(
    matrixSqlPairs(matrices.extensionNative),
    extensions.filter(({ family, published: isPublished }) => family === "native" && isPublished).map(({ sqlName, target }) => `${sqlName}\0${target}`),
    "native extension member CI matrix",
  );
  assertSameStrings(
    matrixSqlPairs(matrices.extensionWasix),
    extensions.filter(({ family, published: isPublished }) => family === "wasix" && isPublished).map(({ sqlName, target }) => `${sqlName}\0${target}`),
    "WASIX extension member CI matrix",
  );
}

function manifestArray(value) {
  return value === undefined ? [] : Array.isArray(value) ? value.map(String) : [];
}

export function validateCarrierCoverage({ graph, catalog, targets, jsManifest, rustManifest, platformManifests }) {
  const carriers = declaredCarrierMap(catalog);
  const runtimeProducts = new Set(["liboliphaunt-native", "oliphaunt-broker", "oliphaunt-node-direct"]);
  for (const product of runtimeProducts) {
    const expected = targets.filter((row) => row.product === product && row.published && row.npmPackage).map((row) => row.npmPackage);
    const actual = catalog.carriers.filter((row) => row.product === product && row.ecosystem === "npm").map((row) => row.name);
    assertSameStrings(actual, expected, `${product} npm carrier identities`);
  }
  for (const target of targets.filter((row) => row.published && row.npmPackage)) {
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
  assertSameStrings(Object.keys(actualOptional), expectedOptional.keys(), "TypeScript optional runtime packages");
  for (const [name, version] of expectedOptional) invariant(actualOptional[name] === version, `TypeScript optional runtime ${name} must use ${version}`);
  const brokerMetadata = object(object(rustManifest.package, "Rust package").metadata?.oliphaunt, "Rust broker metadata");
  invariant(brokerMetadata["broker-helper"] === "oliphaunt-broker", "Rust SDK broker helper identity must be oliphaunt-broker");
  invariant(brokerMetadata["broker-version"] === graph.products["oliphaunt-broker"].version, "Rust SDK broker helper version must match the broker product");
}

export function validateExtensionCarrierCoverage(graph, catalog, products) {
  const byProduct = new Map();
  for (const carrier of catalog.carriers) {
    const rows = byProduct.get(carrier.product) ?? [];
    rows.push(carrier.id);
    byProduct.set(carrier.product, rows);
  }
  for (const product of products) {
    const expected = extensionRegistryPackageStrings({
      product,
      ...extensionRegistryPackageTargetSets(product, TOOL),
    }).map((identity) => identity.replace(/^crates:/u, "cargo:"));
    assertSameStrings(byProduct.get(product) ?? [], expected, `${product} registry carriers`);
    invariant(catalog.carriers.filter((row) => row.product === product).every((row) => row.version === graph.products[product].version), `${product} carrier versions must match its exact-extension product version`);
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

function validateJsExactIosExtensionInput(workflow) {
  const jobId = "js-sdk-exact-candidate-consumer";
  const artifact = "liboliphaunt-native-extension-artifacts-ios-xcframework";
  const inputPath = "target/js-exact-candidate-input/ios-extensions";
  const allDownloads = actionSteps(workflow, jobId, "actions/download-artifact@");
  const downloads = allDownloads
    .filter((step) => step.with?.name === artifact);
  invariant(downloads.length === 1, `${jobId} must download ${artifact} exactly once`);
  invariant(
    downloads[0].with?.path === inputPath
      && downloads[0].with?.["run-id"] === undefined
      && downloads[0].with?.pattern === undefined
      && downloads[0].with?.repository === undefined
      && downloads[0].with?.["github-token"] === undefined,
    `${jobId}/${artifact} must use same-run immutable input path ${inputPath}`,
  );
  invariant(
    allDownloads.filter((step) => step.with?.path === inputPath).length === 1,
    `${jobId}/${artifact} input path ${inputPath} must not be shared with another download`,
  );

  const consumerSteps = workflowJob(workflow, jobId).steps
    .filter((step) => step.id === "js_exact_candidate_consumer");
  invariant(consumerSteps.length === 1, `${jobId} must declare exactly one exact-candidate consumer step`);
  const flagValues = [...String(consumerSteps[0].run ?? "").matchAll(
    /(?:^|\s)--ios-extension-artifact-root(?:=|\s+)([^\s\\]+)/gu,
  )].map((match) => match[1]);
  assertSameStrings(
    flagValues,
    [inputPath],
    `${jobId} --ios-extension-artifact-root values`,
  );
  const genericRootValues = [...String(consumerSteps[0].run ?? "").matchAll(
    /(?:^|\s)--artifact-root(?:=|\s+)([^\s\\]+)/gu,
  )].map((match) => match[1]);
  invariant(
    !genericRootValues.includes(inputPath),
    `${jobId} must bind ${inputPath} only through --ios-extension-artifact-root`,
  );
}

export function validateCiArtifactCoverage(workflow, inventory) {
  const matrixRows = {
    nativeDesktop: inventory.matrices.nativeDesktop.include,
    nativeAndroid: inventory.matrices.nativeAndroid.include,
    nativeIos: inventory.matrices.nativeIos.include,
    broker: inventory.matrices.broker.include,
    nodeDirect: inventory.matrices.nodeDirect.include,
    extensionNative: inventory.matrices.extensionNative.include,
    extensionWasix: inventory.matrices.extensionWasix.include,
    wasixAot: inventory.matrices.wasixAot.include,
    reactNativeAndroid: inventory.matrices.reactNativeAndroid.include,
    jsExact: inventory.matrices.jsExact.include,
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
  validateWorkflowProducer(workflow, "broker-runtime", "oliphaunt-broker-release-assets-${{ matrix.target }}", matrixRows.broker, releaseAssets("oliphaunt-broker", "broker-helper"));
  validateWorkflowProducer(workflow, "node-direct", "oliphaunt-node-direct-release-assets-${{ matrix.target }}", matrixRows.nodeDirect, releaseAssets("oliphaunt-node-direct", "node-direct-addon"));
  validateWorkflowProducer(workflow, "node-direct", "oliphaunt-node-direct-npm-package-${{ matrix.target }}", matrixRows.nodeDirect, npmPackages("oliphaunt-node-direct", "node-direct-addon"));
  const nativeExtensionArtifacts = sorted(new Set(inventory.extensions.filter(({ family, published }) => family === "native" && published).map(({ target }) => `liboliphaunt-native-extension-artifacts-${target}`)));
  const wasixExtensionArtifacts = sorted(new Set(inventory.extensions.filter(({ family, published }) => family === "wasix" && published).map(({ target }) => `liboliphaunt-wasix-extension-artifacts-${target}`)));
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
  ]) validateWorkflowProducer(workflow, jobId, artifact, [{}], [artifact]);
  validateWorkflowConsumer(workflow, "liboliphaunt-native-release-assets", ["liboliphaunt-native-desktop", "liboliphaunt-native-android", "liboliphaunt-native-ios"], nativeRelease);
  validateWorkflowConsumer(workflow, "extension-artifacts-wasix", ["liboliphaunt-wasix-runtime"], ["liboliphaunt-wasix-runtime-portable"]);
  validateWorkflowConsumer(workflow, "liboliphaunt-wasix-aot", ["liboliphaunt-wasix-runtime"], ["liboliphaunt-wasix-runtime-portable"]);
  validateWorkflowConsumer(workflow, "wasix-release-regression", ["extension-artifacts-wasix", "liboliphaunt-wasix-runtime", "liboliphaunt-wasix-aot"], [
    "liboliphaunt-wasix-runtime-portable",
    ...wasixExtensionArtifacts,
    "liboliphaunt-wasix-runtime-aot-linux-x64-gnu",
    "liboliphaunt-wasix-extension-aot-linux-x64-gnu",
  ]);
  validateWorkflowConsumer(workflow, "liboliphaunt-wasix-release-assets", ["liboliphaunt-wasix-runtime", "liboliphaunt-wasix-aot"], ["liboliphaunt-wasix-runtime-portable", ...wasixAot]);
  validateWorkflowConsumer(workflow, "extension-packages", ["extension-artifacts-native", "extension-artifacts-wasix", "liboliphaunt-wasix-aot"], [...nativeExtensionArtifacts, ...wasixExtensionArtifacts, ...extensionAot]);
  validateWorkflowConsumer(workflow, "mobile-extension-packages", ["extension-artifacts-native"], nativeExtensionArtifacts);
  validateWorkflowConsumer(
    workflow,
    "js-sdk-exact-candidate-consumer",
    ["broker-runtime", "extension-artifacts-native", "js-sdk-package", "liboliphaunt-native-desktop", "liboliphaunt-native-ios", "node-direct"],
    [
      ...matrixRows.jsExact.flatMap((row) => [
        row.native_artifact,
        row.extension_artifact,
        row.broker_artifact,
        row.node_artifact,
      ]),
      "liboliphaunt-native-icu-data",
      "liboliphaunt-native-release-assets-ios-xcframework",
      "liboliphaunt-native-extension-artifacts-ios-xcframework",
      "oliphaunt-js-sdk-package-artifacts",
    ],
    matrixRows.jsExact,
  );
  validateJsExactIosExtensionInput(workflow);
  const iosRelease = ["liboliphaunt-native-release-assets-ios-xcframework"];
  validateWorkflowConsumer(workflow, "swift-sdk-package", ["liboliphaunt-native-ios"], iosRelease);
  validateWorkflowConsumer(
    workflow,
    "rust-sdk-exact-candidate-consumer",
    ["broker-runtime", "extension-artifacts-native", "liboliphaunt-native-desktop", "rust-sdk-package"],
    [
      "liboliphaunt-native-extension-artifacts-linux-x64-gnu",
      "liboliphaunt-native-release-assets-linux-x64-gnu",
      "oliphaunt-broker-release-assets-linux-x64-gnu",
      "oliphaunt-rust-sdk-package-artifacts",
    ],
  );
  validateWorkflowConsumer(
    workflow,
    "wasix-rust-exact-candidate-consumer",
    ["liboliphaunt-wasix-release-assets", "wasix-rust-package"],
    ["liboliphaunt-wasix-release-assets", "oliphaunt-wasix-rust-package-artifacts"],
  );
  validateWorkflowConsumer(workflow, "react-native-sdk-package", ["liboliphaunt-native-ios"], iosRelease);
  validateWorkflowConsumer(workflow, "mobile-build-android", ["liboliphaunt-native-android", "mobile-extension-packages", "kotlin-sdk-package", "react-native-sdk-package"], [
    ...matrixRows.reactNativeAndroid.map(({ target }) => `liboliphaunt-native-target-${target}`),
    "oliphaunt-mobile-extension-package-artifacts",
    "oliphaunt-kotlin-sdk-package-artifacts",
    "oliphaunt-react-native-sdk-package-artifacts",
  ], matrixRows.reactNativeAndroid);
  validateWorkflowConsumer(workflow, "mobile-build-ios", ["liboliphaunt-native-ios", "mobile-extension-packages", "react-native-sdk-package", "swift-sdk-package"], [
    "liboliphaunt-native-target-ios-xcframework",
    ...iosRelease,
    "oliphaunt-mobile-extension-package-artifacts",
    "oliphaunt-react-native-sdk-package-artifacts",
    "oliphaunt-swift-sdk-package-artifacts",
  ]);
}

function platformPackageManifests(graph, targets) {
  const names = new Set(targets.filter(({ published, npmPackage }) => published && npmPackage).map(({ npmPackage }) => npmPackage));
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
      const mobile = extensions.some(({ product: owner, sqlName: member, kind, published }) => owner === product && member === sqlName && kind === "native-static-registry" && published);
      if (!mobile) continue;
      const recipe = path.join(extensionMemberPath(product, sqlName, TOOL), "targets/native-static-registry.toml");
      if (!existsSync(path.join(ROOT, recipe))) continue;
      invariant(statSync(path.join(ROOT, recipe)).isFile(), `${recipe} must be a file`);
      invariant(readToml(recipe).status === "supported", `${recipe} must be supported while mobile artifacts are published`);
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
      jsExact: jsExactCandidateConsumerMatrix(),
      extensionNative: extensionArtifactsNativeMatrix(),
      extensionWasix: extensionArtifactsWasixMatrix(),
      wasixAot: liboliphauntWasixAotRuntimeMatrix(),
      broker: brokerRuntimeMatrix(),
      nodeDirect: nodeDirectRuntimeMatrix(),
    },
  };
}

export function validateRepository() {
  const inventory = repositoryInventory();
  invariant((inventory.graph.artifact_targets ?? []).length === 0, "artifact targets must be owned by Moon product metadata, not a central legacy table");
  for (const [product, preset] of Object.entries({
    "liboliphaunt-native": "liboliphaunt-native",
    "liboliphaunt-wasix": "liboliphaunt-wasix",
    "oliphaunt-broker": "broker-helper",
    "oliphaunt-node-direct": "node-direct-addon",
  })) invariant(releaseMetadata(product, TOOL).artifactTargets?.preset === preset, `${product} must use Moon artifact target preset ${preset}`);
  validateArtifactTargetContract(inventory.targets);
  validateExtensionCoverage(inventory.targets, inventory.products, inventory.extensions);
  validateMatrixCoverage(inventory.targets, inventory.extensions, inventory.matrices);
  validateCarrierCoverage({
    graph: inventory.graph,
    catalog: inventory.catalog,
    targets: inventory.targets,
    jsManifest: readJson("src/sdks/js/package.json"),
    rustManifest: readToml("src/sdks/rust/Cargo.toml"),
    platformManifests: platformPackageManifests(inventory.graph, inventory.targets),
  });
  validateExtensionCarrierCoverage(inventory.graph, inventory.catalog, inventory.products);
  validateStructuredExtensionRecipes(inventory.products, inventory.extensions, inventory.graph);
  const ci = parseWorkflow(ROOT, ".github/workflows/ci.yml");
  const release = parseWorkflow(ROOT, ".github/workflows/release.yml");
  const releaseExecution = parseWorkflow(ROOT, ".github/workflows/release-execute.yml");
  assertCiWorkflow(ci, { builderJobs: BUILDER_JOBS });
  assertReleaseWorkflow(release, releaseExecution);
  validateCiArtifactCoverage(ci, inventory);
  const fullPlan = planForFullRun({ wasmTarget: "all", nativeTarget: "all", mobileTarget: "all" });
  const requiredProductBuilders = new Set([...BUILDER_JOBS].filter((job) => job !== "wasix-release-regression"));
  invariant([...requiredProductBuilders].every((job) => fullPlan.jobs.has(job)), "full CI planning must select every product artifact builder");
  const focusedWasix = planForFullRun({ wasmTarget: "linux-x64-gnu", nativeTarget: "all", mobileTarget: "all" });
  assertSameStrings(focusedWasix.jobs, ["affected", "extension-artifacts-wasix", "liboliphaunt-wasix-aot", "liboliphaunt-wasix-runtime"], "focused WASIX CI jobs");
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
