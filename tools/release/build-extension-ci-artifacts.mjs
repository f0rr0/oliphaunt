#!/usr/bin/env bun
import { createHash } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import path from "node:path";

import {
  ROOT,
  compareText,
  currentProductVersion,
  currentProductVersionSync,
  exactExtensionProducts,
  extensionArtifactTargets,
  extensionMetadata,
  extensionSourceIdentity,
  extensionSqlName,
} from "./release-artifact-targets.mjs";
import { AOT_TARGET_TRIPLES } from "./wasix-cargo-artifact-contract.mjs";
import { assertCanonicalWasixAotManifest } from "./wasix-aot-manifest.mjs";

const PREFIX = "build-extension-ci-artifacts.mjs";

function fail(message) {
  console.error(`${PREFIX}: ${message}`);
  process.exit(1);
}

function rel(file) {
  return path.relative(ROOT, file).split(path.sep).join("/");
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function extensionProducts() {
  return exactExtensionProducts(PREFIX);
}

function generatedExtensionRow(sqlName) {
  const metadata = path.join(ROOT, "src/extensions/generated/sdk/kotlin.json");
  const data = JSON.parse(readFileSync(metadata, "utf8"));
  const row = (data.extensions ?? []).find((item) => item && item["sql-name"] === sqlName);
  if (!row) {
    fail(`generated extension metadata has no row for ${sqlName}`);
  }
  return row;
}

function stringList(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((item) => String(item)).filter(Boolean).sort(compareText);
}

function propertiesCsv(values) {
  return values.join(",");
}

function publicAsset(asset) {
  const result = {};
  for (const key of ["name", "family", "target", "kind", "identity", "sha256", "bytes"]) {
    if (Object.hasOwn(asset, key)) {
      result[key] = asset[key];
    }
  }
  return result;
}

function resolveRepoPath(value, { label }) {
  const resolved = path.resolve(ROOT, value);
  const relative = path.relative(ROOT, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    fail(`${label} must be inside the repository: ${resolved}`);
  }
  return resolved;
}

function nativeReleaseAssetRoot() {
  return resolveRepoPath(process.env.OLIPHAUNT_NATIVE_EXTENSION_RELEASE_ASSET_ROOT ?? "target/extensions/native/release-assets", {
    label: "native extension release asset root",
  });
}

function wasixReleaseAssetRoot() {
  return resolveRepoPath(process.env.OLIPHAUNT_WASIX_EXTENSION_RELEASE_ASSET_ROOT ?? "target/extensions/wasix/release-assets", {
    label: "WASIX extension release asset root",
  });
}

function wasixAotArtifactRoot() {
  return resolveRepoPath(process.env.OLIPHAUNT_WASIX_EXTENSION_AOT_ARTIFACT_ROOT ?? "target/extensions/wasix/aot-artifacts", {
    label: "WASIX extension AOT artifact root",
  });
}

function parseTsv(file) {
  const lines = readFileSync(file, "utf8").split(/\r?\n/u).filter((line) => line.length > 0);
  if (lines.length === 0) {
    return [];
  }
  const header = lines[0].split("\t");
  return lines.slice(1).map((line) => {
    const values = line.split("\t");
    return Object.fromEntries(header.map((column, index) => [column, values[index] ?? ""]));
  });
}

function indexContainsSqlName(index, sqlName) {
  return parseTsv(index).some((row) => row.sql_name === sqlName);
}

function publishedTargetIds(family) {
  return [...new Set(
    extensionArtifactTargets({ family, publishedOnly: true }, PREFIX).map((target) => target.target),
  )].sort(compareText);
}

function nativeExtensionAssetIndexes(sqlName, product = undefined) {
  const version = currentProductVersionSync("liboliphaunt-native", PREFIX);
  const root = nativeReleaseAssetRoot();
  const indexes = [];
  for (const target of publishedTargetIds("native")) {
    const targetRoot = path.join(root, target);
    if (product !== undefined) {
      const productIndex = path.join(targetRoot, product, `liboliphaunt-${version}-native-extension-assets.tsv`);
      if (existsSync(productIndex) && indexContainsSqlName(productIndex, sqlName)) {
        indexes.push(productIndex);
        continue;
      }
    }
    const directIndex = path.join(targetRoot, `liboliphaunt-${version}-native-extension-assets.tsv`);
    if (existsSync(directIndex)) {
      indexes.push(directIndex);
    }
  }
  return indexes.sort(compareText);
}

function nativeAssetsFromTargetIndexes(sqlName, { product = undefined, required = false } = {}) {
  const indexes = nativeExtensionAssetIndexes(sqlName, product);
  if (indexes.length === 0) {
    return [];
  }
  const assets = [];
  const seen = new Set();
  for (const index of indexes) {
    for (const row of parseTsv(index)) {
      if (row.sql_name !== sqlName) {
        continue;
      }
      const { target, kind, artifact } = row;
      if (!target || !kind || !artifact) {
        fail(`${rel(index)} has an incomplete native asset row for ${sqlName}`);
      }
      const identity = row.identity && row.identity !== "-" ? row.identity : null;
      const registrationArtifact = row.registration_artifact && row.registration_artifact !== "-"
        ? path.join(path.dirname(index), row.registration_artifact)
        : null;
      if (kind === "ios-dependency-xcframework" && identity === null) {
        fail(`${rel(index)} iOS dependency XCFramework row for ${sqlName} must declare identity`);
      }
      if (kind !== "ios-dependency-xcframework" && identity !== null && kind !== "ios-xcframework") {
        fail(`${rel(index)} ${kind} row for ${sqlName} must not declare identity`);
      }
      const dedupeKey = `${target}\0${kind}\0${identity ?? ""}`;
      if (seen.has(dedupeKey)) {
        fail(`duplicate native extension asset row for ${sqlName} target=${target} kind=${kind} identity=${identity ?? "-"}`);
      }
      seen.add(dedupeKey);
      const asset = path.join(path.dirname(index), artifact);
      if (!existsSync(asset) || !statSync(asset).isFile()) {
        fail(`${rel(index)} references missing native asset ${rel(asset)}`);
      }
      if (registrationArtifact !== null && (!existsSync(registrationArtifact) || !statSync(registrationArtifact).isFile())) {
        fail(`${rel(index)} references missing registration metadata ${rel(registrationArtifact)}`);
      }
      assets.push({ asset, target, kind, identity, registrationArtifact });
    }
  }
  if (required && assets.length === 0) {
    fail(`${sqlName} has no native extension assets in native target asset indexes`);
  }
  return assets;
}

function nativeAssetsFor(sqlName, { product = undefined, required = false } = {}) {
  const indexed = nativeAssetsFromTargetIndexes(sqlName, { product, required: false });
  if (indexed.length > 0) {
    return indexed;
  }
  if (required) {
    fail(`${sqlName}${product ? ` for ${product}` : ""} has no native extension assets in native target asset indexes`);
  }
  return [];
}

function wasixArchiveFor(sqlName, { product = undefined, required = false } = {}) {
  const version = currentProductVersionSync("liboliphaunt-wasix", PREFIX);
  const root = wasixReleaseAssetRoot();
  const indexes = [];
  for (const target of publishedTargetIds("wasix")) {
    const targetRoot = path.join(root, target);
    if (product !== undefined) {
      const productIndex = path.join(targetRoot, product, `liboliphaunt-wasix-${version}-wasix-extension-assets.tsv`);
      if (existsSync(productIndex)) {
        indexes.push(productIndex);
        continue;
      }
    }
    const directIndex = path.join(targetRoot, `liboliphaunt-wasix-${version}-wasix-extension-assets.tsv`);
    if (existsSync(directIndex)) {
      indexes.push(directIndex);
    }
  }
  const assets = [];
  for (const index of indexes) {
    for (const row of parseTsv(index)) {
      if (row.sql_name !== sqlName) {
        continue;
      }
      const { target, kind, artifact } = row;
      if (target !== "wasix-portable" || kind !== "wasix-runtime" || !artifact) {
        fail(`${rel(index)} has an invalid WASIX asset row for ${sqlName}`);
      }
      const asset = path.join(path.dirname(index), artifact);
      if (!existsSync(asset) || !statSync(asset).isFile()) {
        fail(`${rel(index)} references missing WASIX asset ${rel(asset)}`);
      }
      assets.push(asset);
    }
  }
  if (assets.length > 1) {
    fail(`${sqlName} has duplicate WASIX extension assets: ${assets.map(rel).join(", ")}`);
  }
  if (assets.length === 1) {
    return assets[0];
  }
  if (required) {
    fail(`${sqlName} has no WASIX extension assets in target/extensions/wasix/release-assets target indexes`);
  }
  return undefined;
}

function wasixAotDirsFor(sqlName) {
  const root = wasixAotArtifactRoot();
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    return [];
  }
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => [entry.name, path.join(root, entry.name, sqlName)])
    .filter(([, candidate]) => existsSync(path.join(candidate, "manifest.json")))
    .sort(([left], [right]) => compareText(left, right));
}

function validateWasixAotDir(targetId, source) {
  const expectedTarget = AOT_TARGET_TRIPLES[targetId];
  if (expectedTarget === undefined) {
    fail(`WASIX extension AOT artifact root contains unknown target id ${targetId}`);
  }
  const manifestPath = path.join(source, "manifest.json");
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    fail(`${rel(manifestPath)} is not valid JSON: ${error.message}`);
  }
  try {
    assertCanonicalWasixAotManifest(manifest, {
      context: rel(manifestPath),
      expectedTarget,
    });
  } catch (error) {
    fail(error.message);
  }
}

function copyAsset(source, destinationDir, { name }) {
  mkdirSync(destinationDir, { recursive: true });
  const destination = path.join(destinationDir, name);
  copyFileSync(source, destination);
  chmodSync(destination, statSync(source).mode & 0o777);
  return {
    name: path.basename(destination),
    path: rel(destination),
    source: rel(source),
    sha256: sha256(destination),
    bytes: statSync(destination).size,
  };
}

function nativeAssetName(product, version, target, kind, source) {
  const suffix = archiveSuffix(source);
  if (target === "macos-arm64") {
    return `${product}-${version}-native-macos-arm64-runtime${suffix}`;
  }
  if (target.startsWith("linux-")) {
    return `${product}-${version}-native-${target}-runtime${suffix}`;
  }
  if (target.startsWith("windows-")) {
    return `${product}-${version}-native-${target}-runtime${suffix}`;
  }
  if (target === "ios-xcframework") {
    if (kind === "runtime") {
      return `${product}-${version}-native-ios-runtime${suffix}`;
    }
    if (kind === "ios-xcframework") {
      return `${product}-${version}-native-ios-xcframework${suffix}`;
    }
    if (kind === "ios-dependency-xcframework") {
      fail(`iOS dependency XCFramework ${path.basename(source)} requires its exact dependency identity`);
    }
    fail(`unsupported iOS extension artifact kind ${kind} for ${path.basename(source)}`);
  }
  if (target.startsWith("android-")) {
    if (kind === "runtime") {
      return `${product}-${version}-native-${target}-runtime${suffix}`;
    }
    if (kind === "android-static-archive") {
      return `${product}-${version}-native-${target}-static${suffix}`;
    }
    fail(`unsupported Android extension artifact kind ${kind} for ${path.basename(source)}`);
  }
  fail(`unsupported native extension artifact target ${target} for ${path.basename(source)}`);
}

function nativeAssetNameForRow(product, version, row) {
  if (row.kind === "ios-dependency-xcframework") {
    return `${product}-${version}-native-ios-dependency-${row.identity}-xcframework${archiveSuffix(row.asset)}`;
  }
  return nativeAssetName(product, version, row.target, row.kind, row.asset);
}

function readIosRegistration(file, { sqlName, nativeModuleStem }) {
  if (file === null) return null;
  let value;
  try {
    value = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    fail(`${rel(file)} is not valid registration JSON: ${error.message}`);
  }
  if (
    value?.schema !== "oliphaunt-ios-extension-registration-v1"
    || value.sqlName !== sqlName
    || value.nativeModuleStem !== nativeModuleStem
    || typeof value.magicSymbol !== "string"
    || !(value.initSymbol === null || typeof value.initSymbol === "string")
    || !Array.isArray(value.symbols)
  ) {
    fail(`${rel(file)} does not describe ${sqlName}/${nativeModuleStem} iOS registration`);
  }
  return value;
}

function archiveSuffix(source) {
  for (const suffix of [".tar.gz", ".tar.zst", ".zip"]) {
    if (source.endsWith(suffix)) {
      return suffix;
    }
  }
  fail(`native extension asset ${path.basename(source)} must use .tar.gz, .tar.zst, or .zip`);
}

function validateStagedTargets(product, assets, { requireNative, requireWasix, requireNativeTargets }) {
  const declaredNativeTargets = new Set(
    extensionArtifactTargets({ product, family: "native", publishedOnly: true }, PREFIX).map((target) => target.target),
  );
  const declaredWasixTargets = new Set(
    extensionArtifactTargets({ product, family: "wasix", publishedOnly: true }, PREFIX).map((target) => target.target),
  );
  const stagedNativeTargets = new Set(assets.filter((asset) => asset.family === "native").map((asset) => String(asset.target)));
  const stagedWasixTargets = new Set(assets.filter((asset) => asset.family === "wasix").map((asset) => String(asset.target)));
  const extraNative = [...stagedNativeTargets].filter((target) => !declaredNativeTargets.has(target)).sort(compareText);
  const extraWasix = [...stagedWasixTargets].filter((target) => !declaredWasixTargets.has(target)).sort(compareText);
  if (extraNative.length > 0) {
    fail(`${product} staged undeclared native extension targets: ${extraNative.join(", ")}`);
  }
  if (extraWasix.length > 0) {
    fail(`${product} staged undeclared WASIX extension targets: ${extraWasix.join(", ")}`);
  }
  if (requireNativeTargets.size > 0) {
    const unknownRequired = [...requireNativeTargets].filter((target) => !declaredNativeTargets.has(target)).sort(compareText);
    if (unknownRequired.length > 0) {
      fail(`${product} was asked to require undeclared native targets: ${unknownRequired.join(", ")}`);
    }
    const missingNative = [...requireNativeTargets].filter((target) => !stagedNativeTargets.has(target)).sort(compareText);
    if (missingNative.length > 0) {
      fail(`${product} is missing native extension artifacts for: ${missingNative.join(", ")}`);
    }
  } else if (requireNative) {
    const missingNative = [...declaredNativeTargets].filter((target) => !stagedNativeTargets.has(target)).sort(compareText);
    if (missingNative.length > 0) {
      fail(`${product} is missing native extension artifacts for: ${missingNative.join(", ")}`);
    }
  }
  if (requireWasix) {
    const missingWasix = [...declaredWasixTargets].filter((target) => !stagedWasixTargets.has(target)).sort(compareText);
    if (missingWasix.length > 0) {
      fail(`${product} is missing WASIX extension artifacts for: ${missingWasix.join(", ")}`);
    }
  }
}

async function stageProduct(product, { outputRoot, requireNative, requireWasix, requireNativeTargets }) {
  const known = new Set(extensionProducts());
  if (!known.has(product)) {
    fail(`unknown exact-extension product ${product}; expected one of: ${[...known].sort(compareText).join(", ")}`);
  }
  const sqlName = extensionSqlName(product, PREFIX);
  const extensionRow = generatedExtensionRow(sqlName);
  const version = await currentProductVersion(product, PREFIX);
  const productRoot = path.join(outputRoot, product);
  const assetDir = path.join(productRoot, "release-assets");
  rmSync(productRoot, { recursive: true, force: true });
  mkdirSync(assetDir, { recursive: true });

  const assets = [];
  let iosRegistration = null;
  for (const row of nativeAssetsFor(sqlName, { product, required: requireNative })) {
    const target = row.target;
    if (requireNativeTargets.size > 0 && !requireNativeTargets.has(target)) {
      continue;
    }
    const metadata = copyAsset(row.asset, assetDir, {
      name: nativeAssetNameForRow(product, version, row),
    });
    metadata.family = "native";
    metadata.kind = row.kind;
    metadata.target = target;
    metadata.identity = row.identity;
    assets.push(metadata);
    if (row.registrationArtifact !== null) {
      const registration = readIosRegistration(row.registrationArtifact, {
        sqlName,
        nativeModuleStem: extensionRow["native-module-stem"],
      });
      if (iosRegistration !== null && JSON.stringify(iosRegistration) !== JSON.stringify(registration)) {
        fail(`${product} has conflicting iOS registration metadata`);
      }
      iosRegistration = registration;
    }
  }

  const wasixArchive = wasixArchiveFor(sqlName, { product, required: requireWasix });
  if (wasixArchive !== undefined) {
    const metadata = copyAsset(wasixArchive, assetDir, {
      name: `${product}-${version}-wasix-portable.tar.zst`,
    });
    metadata.family = "wasix";
    metadata.kind = "wasix-runtime";
    metadata.target = "wasix-portable";
    metadata.identity = null;
    assets.push(metadata);
  }

  for (const [targetId, source] of wasixAotDirsFor(sqlName)) {
    validateWasixAotDir(targetId, source);
    const destination = path.join(productRoot, "wasix-aot", targetId);
    rmSync(destination, { recursive: true, force: true });
    cpSync(source, destination, { recursive: true });
  }

  validateStagedTargets(product, assets, {
    requireNative,
    requireWasix,
    requireNativeTargets,
  });
  if (assets.length === 0) {
    fail(`${product} produced no extension artifacts`);
  }

  const manifest = {
    schema: "oliphaunt-extension-ci-artifacts-v1",
    product,
    version,
    sqlName,
    createsExtension: extensionRow["creates-extension"] !== false,
    dependencies: stringList(extensionRow["selected-extension-dependencies"]),
    nativeDependencies: stringList(extensionRow["native-dependencies"]),
    nativeModuleStem: extensionRow["native-module-stem"],
    iosNativeDependencies: assets
      .filter((asset) => asset.kind === "ios-dependency-xcframework")
      .map((asset) => asset.identity)
      .sort(compareText),
    iosRegistration,
    sharedPreloadLibraries: stringList(extensionRow["shared-preload-libraries"]),
    mobileReleaseReady: extensionRow["mobile-release-ready"] === true,
    desktopReleaseReady: extensionRow["desktop-release-ready"] === true,
    assets,
  };
  writeFileSync(path.join(productRoot, "extension-artifacts.json"), `${JSON.stringify(sortValue(manifest), null, 2)}\n`, "utf8");

  const releaseMetadata = extensionMetadata(product, PREFIX);
  const releaseData = {
    schema: "oliphaunt-extension-release-manifest-v1",
    product,
    version,
    sqlName,
    extensionClass: releaseMetadata.class,
    versioning: releaseMetadata.versioning,
    sourceIdentity: extensionSourceIdentity(product, PREFIX),
    compatibility: releaseMetadata.compatibility,
    dependencies: manifest.dependencies,
    createsExtension: manifest.createsExtension,
    nativeDependencies: manifest.nativeDependencies,
    nativeModuleStem: manifest.nativeModuleStem,
    iosNativeDependencies: manifest.iosNativeDependencies,
    iosRegistration: manifest.iosRegistration,
    sharedPreloadLibraries: manifest.sharedPreloadLibraries,
    mobileReleaseReady: manifest.mobileReleaseReady,
    desktopReleaseReady: manifest.desktopReleaseReady,
    assets: assets.map(publicAsset),
  };
  const releaseManifest = path.join(assetDir, `${product}-${version}-manifest.json`);
  writeFileSync(releaseManifest, `${JSON.stringify(sortValue(releaseData), null, 2)}\n`, "utf8");

  const propertiesManifest = path.join(assetDir, `${product}-${version}-manifest.properties`);
  const sourceIdentity = releaseData.sourceIdentity;
  const propertiesLines = [
    "schema=oliphaunt-extension-release-manifest-v1\n",
    `product=${product}\n`,
    `version=${version}\n`,
    `sqlName=${sqlName}\n`,
    `extensionClass=${releaseData.extensionClass}\n`,
    `versioning=${releaseData.versioning}\n`,
    `sourceKind=${sourceIdentity.kind}\n`,
    `dependencies=${propertiesCsv(manifest.dependencies)}\n`,
    `nativeDependencies=${propertiesCsv(manifest.nativeDependencies)}\n`,
    `nativeModuleStem=${manifest.nativeModuleStem || ""}\n`,
    `iosNativeDependencies=${propertiesCsv(manifest.iosNativeDependencies)}\n`,
    `sharedPreloadLibraries=${propertiesCsv(manifest.sharedPreloadLibraries)}\n`,
    `mobileReleaseReady=${manifest.mobileReleaseReady ? "true" : "false"}\n`,
    `desktopReleaseReady=${manifest.desktopReleaseReady ? "true" : "false"}\n`,
  ];
  for (const asset of [...assets].sort((left, right) => compareText(`${left.family}\0${left.target}\0${left.kind}`, `${right.family}\0${right.target}\0${right.kind}`))) {
    propertiesLines.push(`asset.${asset.family}.${asset.target}.${asset.kind}=${asset.name}\n`);
  }
  writeFileSync(propertiesManifest, propertiesLines.join(""), "utf8");

  const checksumManifest = path.join(assetDir, `${product}-${version}-release-assets.sha256`);
  const checksumLines = readdirSync(assetDir)
    .map((name) => path.join(assetDir, name))
    .filter((file) => statSync(file).isFile() && file !== checksumManifest)
    .sort(compareText)
    .map((file) => `${sha256(file)}  ./${path.basename(file)}\n`);
  writeFileSync(checksumManifest, checksumLines.join(""), "utf8");
  writeFileSync(
    path.join(productRoot, "artifacts.txt"),
    [
      ...assets.map((asset) => `${asset.path}\n`),
      `${rel(releaseManifest)}\n`,
      `${rel(propertiesManifest)}\n`,
      `${rel(checksumManifest)}\n`,
    ].join(""),
    "utf8",
  );
  console.log(`${product}: staged ${assets.length} exact-extension artifact(s) in ${rel(productRoot)}`);
}

function selectedProductsFromEnv() {
  const raw = process.env.OLIPHAUNT_EXTENSION_PACKAGE_PRODUCTS ?? "";
  const products = [...new Set(raw.split(",").map((item) => item.trim()).filter(Boolean))].sort(compareText);
  if (products.length === 0) {
    return [];
  }
  const known = new Set(extensionProducts());
  const unknown = products.filter((product) => !known.has(product));
  if (unknown.length > 0) {
    fail(`OLIPHAUNT_EXTENSION_PACKAGE_PRODUCTS contains unknown exact-extension product(s): ${unknown.join(", ")}`);
  }
  return products;
}

function parseArgs(argv) {
  const args = {
    products: [],
    all: false,
    outputRoot: "target/extension-artifacts",
    requireNative: false,
    requireWasix: false,
    requireNativeTargets: new Set(),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--all") {
      args.all = true;
    } else if (arg === "--output-root") {
      const value = argv[index + 1];
      if (!value) {
        fail("--output-root requires a value");
      }
      args.outputRoot = value;
      index += 1;
    } else if (arg === "--require-native") {
      args.requireNative = true;
    } else if (arg === "--require-native-target") {
      const value = argv[index + 1];
      if (!value) {
        fail("--require-native-target requires a value");
      }
      args.requireNativeTargets.add(value);
      index += 1;
    } else if (arg === "--require-wasix") {
      args.requireWasix = true;
    } else if (arg === "--help" || arg === "-h") {
      console.log("usage: tools/release/build-extension-ci-artifacts.mjs [--all] [--output-root DIR] [--require-native] [--require-native-target TARGET] [--require-wasix] [products...]");
      process.exit(0);
    } else if (arg.startsWith("--")) {
      fail(`unknown argument ${arg}`);
    } else {
      args.products.push(arg);
    }
  }
  return args;
}

function sortValue(value) {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort(compareText).map((key) => [key, sortValue(value[key])]));
  }
  return value;
}

async function main(argv) {
  const args = parseArgs(argv);
  const envProducts = selectedProductsFromEnv();
  const products = envProducts.length > 0
    ? envProducts
    : args.all
      ? extensionProducts()
      : args.products;
  if (products.length === 0) {
    fail("pass --all or at least one exact-extension product id");
  }
  const outputRoot = resolveRepoPath(args.outputRoot, { label: "output root" });
  for (const product of products) {
    await stageProduct(product, {
      outputRoot,
      requireNative: args.requireNative,
      requireWasix: args.requireWasix,
      requireNativeTargets: args.requireNativeTargets,
    });
  }
}

await main(Bun.argv.slice(2));
