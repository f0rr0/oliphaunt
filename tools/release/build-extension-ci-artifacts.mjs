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
  exactExtensionProducts,
  extensionArtifactTargets,
} from "./release-artifact-targets.mjs";
import { loadGraph } from "./release-graph.mjs";

const PREFIX = "build-extension-ci-artifacts.mjs";
const EXTENSION_VERSIONING_BY_CLASS = {
  contrib: "postgres-bound",
  external: "upstream-bound",
  "first-party": "repo-bound",
};
const EXTENSION_RUNTIME_CONTRACT_PATH = "src/shared/extension-runtime-contract/contract.toml";
const POSTGRES18_SOURCE_PATH = "src/postgres/versions/18/source.toml";

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

function graphProducts() {
  return loadGraph(PREFIX).products;
}

function productConfig(product) {
  const config = graphProducts()[product];
  if (!config) {
    fail(`unknown release product ${product}`);
  }
  return config;
}

function packagePath(product) {
  return releaseMetadataRelativePath(
    nonEmptyString(productConfig(product).path, `${product}.path`),
    `${product}.path`,
  );
}

function extensionProducts() {
  return exactExtensionProducts(PREFIX);
}

function extensionSqlName(product) {
  const value = productConfig(product).extension_sql_name;
  if (typeof value !== "string" || !value) {
    fail(`${product} release metadata must declare extension_sql_name`);
  }
  return value;
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
  for (const key of ["name", "family", "target", "kind", "sha256", "bytes"]) {
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
  const version = currentProductVersionSync("liboliphaunt-native");
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
      const dedupeKey = `${target}\0${kind}`;
      if (seen.has(dedupeKey)) {
        fail(`duplicate native extension asset row for ${sqlName} target=${target} kind=${kind}`);
      }
      seen.add(dedupeKey);
      const asset = path.join(path.dirname(index), artifact);
      if (!existsSync(asset) || !statSync(asset).isFile()) {
        fail(`${rel(index)} references missing native asset ${rel(asset)}`);
      }
      assets.push([asset, target, kind]);
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
  const version = currentProductVersionSync("liboliphaunt-wasix");
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

function extensionMetadata(product) {
  const config = productConfig(product);
  if (config.kind !== "exact-extension-artifact") {
    fail(`${product} is not an exact-extension artifact product`);
  }
  const topLevelSqlName = config.extension_sql_name;
  if (typeof topLevelSqlName !== "string" || !topLevelSqlName) {
    fail(`${product} release metadata must declare extension_sql_name`);
  }
  const metadata = config.extension;
  if (metadata === null || Array.isArray(metadata) || typeof metadata !== "object") {
    fail(`${product} release metadata must declare [extension]`);
  }
  const sqlName = nonEmptyString(metadata.sql_name, `${product}.extension.sql_name`);
  if (sqlName !== topLevelSqlName) {
    fail(`${product}.extension.sql_name ${JSON.stringify(sqlName)} must match extension_sql_name ${JSON.stringify(topLevelSqlName)}`);
  }
  const extensionClass = nonEmptyString(metadata.class, `${product}.extension.class`);
  if (!(extensionClass in EXTENSION_VERSIONING_BY_CLASS)) {
    fail(`${product}.extension.class must be one of ${Object.keys(EXTENSION_VERSIONING_BY_CLASS).sort(compareText).join(", ")}`);
  }
  const versioning = nonEmptyString(metadata.versioning, `${product}.extension.versioning`);
  const expectedVersioning = EXTENSION_VERSIONING_BY_CLASS[extensionClass];
  if (versioning !== expectedVersioning) {
    fail(`${product}.extension.versioning must be ${JSON.stringify(expectedVersioning)} for class ${JSON.stringify(extensionClass)}, got ${JSON.stringify(versioning)}`);
  }
  const source = metadata.source;
  if (source === null || Array.isArray(source) || typeof source !== "object") {
    fail(`${product}.extension must declare [extension.source]`);
  }
  const sourcePath = releaseMetadataRelativePath(nonEmptyString(source.path, `${product}.extension.source.path`), `${product}.extension.source.path`);
  const packageRoot = packagePath(product);
  if (extensionClass === "contrib" && sourcePath !== POSTGRES18_SOURCE_PATH) {
    fail(`${product}.extension.source.path must be ${JSON.stringify(POSTGRES18_SOURCE_PATH)} for contrib extensions`);
  }
  if (extensionClass === "external" && sourcePath !== `${packageRoot}/source.toml`) {
    fail(`${product}.extension.source.path must be ${packageRoot}/source.toml for external extensions`);
  }
  if (extensionClass === "first-party" && !(sourcePath === packageRoot || sourcePath.startsWith(`${packageRoot}/`))) {
    fail(`${product}.extension.source.path must stay inside ${packageRoot}/ for first-party extensions`);
  }

  const compatibility = metadata.compatibility;
  if (compatibility === null || Array.isArray(compatibility) || typeof compatibility !== "object") {
    fail(`${product}.extension must declare [extension.compatibility]`);
  }
  const postgresMajor = nonEmptyString(compatibility.postgres_major, `${product}.extension.compatibility.postgres_major`);
  if (postgresMajor !== "18") {
    fail(`${product}.extension.compatibility.postgres_major must be '18', got ${JSON.stringify(postgresMajor)}`);
  }
  const contractPath = releaseMetadataRelativePath(
    nonEmptyString(compatibility.extension_runtime_contract, `${product}.extension.compatibility.extension_runtime_contract`),
    `${product}.extension.compatibility.extension_runtime_contract`,
  );
  if (contractPath !== EXTENSION_RUNTIME_CONTRACT_PATH) {
    fail(`${product}.extension.compatibility.extension_runtime_contract must be ${JSON.stringify(EXTENSION_RUNTIME_CONTRACT_PATH)}`);
  }
  const nativeProduct = nonEmptyString(compatibility.native_runtime_product, `${product}.extension.compatibility.native_runtime_product`);
  const wasixProduct = nonEmptyString(compatibility.wasix_runtime_product, `${product}.extension.compatibility.wasix_runtime_product`);
  if (nativeProduct !== "liboliphaunt-native") {
    fail(`${product}.extension.compatibility.native_runtime_product must be 'liboliphaunt-native'`);
  }
  if (wasixProduct !== "liboliphaunt-wasix") {
    fail(`${product}.extension.compatibility.wasix_runtime_product must be 'liboliphaunt-wasix'`);
  }
  const nativeVersion = nonEmptyString(compatibility.native_runtime_version, `${product}.extension.compatibility.native_runtime_version`);
  const wasixVersion = nonEmptyString(compatibility.wasix_runtime_version, `${product}.extension.compatibility.wasix_runtime_version`);
  const expectedNativeVersion = currentProductVersionSync(nativeProduct);
  const expectedWasixVersion = currentProductVersionSync(wasixProduct);
  if (nativeVersion !== expectedNativeVersion) {
    fail(`${product}.extension.compatibility.native_runtime_version must be ${JSON.stringify(expectedNativeVersion)}, got ${JSON.stringify(nativeVersion)}`);
  }
  if (wasixVersion !== expectedWasixVersion) {
    fail(`${product}.extension.compatibility.wasix_runtime_version must be ${JSON.stringify(expectedWasixVersion)}, got ${JSON.stringify(wasixVersion)}`);
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

function extensionSourceIdentity(product) {
  const metadata = extensionMetadata(product);
  const source = Bun.TOML.parse(readFileSync(path.join(ROOT, metadata.sourcePath), "utf8"));
  if (metadata.class === "contrib") {
    const postgresql = source.postgresql;
    if (postgresql === null || Array.isArray(postgresql) || typeof postgresql !== "object") {
      fail(`${metadata.sourcePath} must declare [postgresql] for contrib extension products`);
    }
    return {
      kind: "postgres-contrib",
      name: "postgresql",
      version: nonEmptyString(postgresql.version, `${metadata.sourcePath}.postgresql.version`),
      url: nonEmptyString(postgresql.url, `${metadata.sourcePath}.postgresql.url`),
      sha256: nonEmptyString(postgresql.sha256, `${metadata.sourcePath}.postgresql.sha256`),
    };
  }
  if (metadata.class === "external") {
    return {
      kind: "external",
      name: nonEmptyString(source.name, `${metadata.sourcePath}.name`),
      url: nonEmptyString(source.url, `${metadata.sourcePath}.url`),
      branch: nonEmptyString(source.branch, `${metadata.sourcePath}.branch`),
      commit: nonEmptyString(source.commit, `${metadata.sourcePath}.commit`),
    };
  }
  if (metadata.class === "first-party") {
    return {
      kind: "repo",
      name: metadata.sqlName,
      path: metadata.sourcePath,
      version: currentProductVersionSync(product),
    };
  }
  fail(`${product}.extension.class has unsupported source identity class ${JSON.stringify(metadata.class)}`);
}

async function stageProduct(product, { outputRoot, requireNative, requireWasix, requireNativeTargets }) {
  const known = new Set(extensionProducts());
  if (!known.has(product)) {
    fail(`unknown exact-extension product ${product}; expected one of: ${[...known].sort(compareText).join(", ")}`);
  }
  const sqlName = extensionSqlName(product);
  const extensionRow = generatedExtensionRow(sqlName);
  const version = await currentProductVersion(product, PREFIX);
  const productRoot = path.join(outputRoot, product);
  const assetDir = path.join(productRoot, "release-assets");
  rmSync(productRoot, { recursive: true, force: true });
  mkdirSync(assetDir, { recursive: true });

  const assets = [];
  for (const [nativeAsset, target, kind] of nativeAssetsFor(sqlName, { product, required: requireNative })) {
    if (requireNativeTargets.size > 0 && !requireNativeTargets.has(target)) {
      continue;
    }
    const metadata = copyAsset(nativeAsset, assetDir, {
      name: nativeAssetName(product, version, target, kind, nativeAsset),
    });
    metadata.family = "native";
    metadata.kind = kind;
    metadata.target = target;
    assets.push(metadata);
  }

  const wasixArchive = wasixArchiveFor(sqlName, { product, required: requireWasix });
  if (wasixArchive !== undefined) {
    const metadata = copyAsset(wasixArchive, assetDir, {
      name: `${product}-${version}-wasix-portable.tar.zst`,
    });
    metadata.family = "wasix";
    metadata.kind = "wasix-runtime";
    metadata.target = "wasix-portable";
    assets.push(metadata);
  }

  for (const [targetId, source] of wasixAotDirsFor(sqlName)) {
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
    dependencies: stringList(extensionRow["selected-extension-dependencies"]),
    nativeModuleStem: extensionRow["native-module-stem"],
    sharedPreloadLibraries: stringList(extensionRow["shared-preload-libraries"]),
    mobileReleaseReady: extensionRow["mobile-release-ready"] === true,
    desktopReleaseReady: extensionRow["desktop-release-ready"] === true,
    assets,
  };
  writeFileSync(path.join(productRoot, "extension-artifacts.json"), `${JSON.stringify(sortValue(manifest), null, 2)}\n`, "utf8");

  const releaseMetadata = extensionMetadata(product);
  const releaseData = {
    schema: "oliphaunt-extension-release-manifest-v1",
    product,
    version,
    sqlName,
    extensionClass: releaseMetadata.class,
    versioning: releaseMetadata.versioning,
    sourceIdentity: extensionSourceIdentity(product),
    compatibility: releaseMetadata.compatibility,
    dependencies: manifest.dependencies,
    nativeModuleStem: manifest.nativeModuleStem,
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
    `nativeModuleStem=${manifest.nativeModuleStem || ""}\n`,
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

const versionCache = new Map();

function currentProductVersionSync(product) {
  if (!versionCache.has(product)) {
    const versionFile = productConfig(product).version_files?.[0];
    if (typeof versionFile !== "string" || !versionFile) {
      fail(`${product} does not declare a canonical version file`);
    }
    const file = path.join(ROOT, versionFile);
    const text = readFileSync(file, "utf8");
    const name = path.basename(file);
    let version = "";
    if (name === "Cargo.toml") {
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
        const match = inPackage ? /^version\s*=\s*"([^"]+)"/u.exec(line) : null;
        if (match) {
          version = match[1];
          break;
        }
      }
    } else if (name === "package.json" || name === "jsr.json") {
      const data = JSON.parse(text);
      version = typeof data.version === "string" ? data.version : "";
    } else if (name === "gradle.properties") {
      for (const rawLine of text.split(/\r?\n/u)) {
        const line = rawLine.trim();
        if (!line || line.startsWith("#") || !line.includes("=")) {
          continue;
        }
        const [key, ...rest] = line.split("=");
        if (key.trim() === "VERSION_NAME") {
          version = rest.join("=").trim();
          break;
        }
      }
    } else if (name === "VERSION" || name === "LIBOLIPHAUNT_VERSION") {
      version = text.trim();
    } else {
      fail(`${product}.version_files has unsupported version file type: ${versionFile}`);
    }
    if (!version) {
      fail(`${versionFile} does not define a release version for ${product}`);
    }
    versionCache.set(product, version);
  }
  return versionCache.get(product);
}

function nonEmptyString(value, context) {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  fail(`${context} must be a non-empty string`);
}

function releaseMetadataRelativePath(value, context) {
  const candidate = path.normalize(value).split(path.sep).join("/");
  if (path.isAbsolute(value) || candidate.split("/").includes("..")) {
    fail(`${context} must be a repository-relative path: ${JSON.stringify(value)}`);
  }
  if (!existsSync(path.join(ROOT, candidate))) {
    fail(`${context} path does not exist: ${candidate}`);
  }
  return candidate;
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
