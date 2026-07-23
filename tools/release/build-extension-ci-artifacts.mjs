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
  assertReleaseNoticesInArchive,
  stageReleaseNotices,
} from "./release-notices.mjs";
import {
  assertExtensionUpstreamLicensesInArchive,
  extensionCarrierLegalContract,
  stageExtensionUpstreamLicenses,
} from "./extension-upstream-licenses.mjs";

import { createDeterministicTar } from "./cargo-source-package.mjs";
import { extensionRuntimeAssetContract } from "./extension-runtime-asset-contract.mjs";
import { canonicalGzipSync } from "./portable-archive.mjs";
import {
  ROOT,
  compareText,
  currentProductVersion,
  currentProductVersionSync,
  exactExtensionProducts,
  extensionArtifactTargets,
  extensionMetadata,
  extensionSourceIdentity,
  extensionSqlNames,
} from "./release-artifact-targets.mjs";
import {
  swiftExtensionCarrierAssetName,
  writeSwiftExtensionCarrierManifest,
} from "./ios-carrier-manifest.mjs";
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

function stringList(value, label) {
  if (
    !Array.isArray(value)
    || value.some((item) => typeof item !== "string" || item.length === 0)
    || new Set(value).size !== value.length
  ) {
    fail(`generated extension metadata ${label} must be a unique non-empty string list`);
  }
  return [...value].sort(compareText);
}

function propertiesCsv(values) {
  return values.join(",");
}

export function publicExtensionReleaseAsset(asset) {
  return extensionRuntimeAssetContract(asset);
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
  const generatedRootValue = process.env.OLIPHAUNT_WASIX_GENERATED_ASSET_ROOT;
  if (generatedRootValue) {
    const generatedRoot = resolveRepoPath(generatedRootValue, {
      label: "generated WASIX asset root",
    });
    const manifestPath = path.join(generatedRoot, "manifest.json");
    if (!existsSync(manifestPath) || !statSync(manifestPath).isFile()) {
      fail(`generated WASIX asset root is missing ${rel(manifestPath)}`);
    }
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch (error) {
      fail(`${rel(manifestPath)} is not valid JSON: ${error.message}`);
    }
    const rows = Array.isArray(manifest.extensions)
      ? manifest.extensions.filter((row) => row?.["sql-name"] === sqlName)
      : [];
    if (rows.length !== 1) {
      fail(`${rel(manifestPath)} must contain exactly one extension row for ${sqlName}, got ${rows.length}`);
    }
    const row = rows[0];
    const expectedArchive = `extensions/${sqlName}.tar.zst`;
    if (row.archive !== expectedArchive || !/^[0-9a-f]{64}$/u.test(row.sha256 ?? "")) {
      fail(`${rel(manifestPath)} has a noncanonical archive identity for ${sqlName}`);
    }
    const archive = path.join(generatedRoot, expectedArchive);
    if (!existsSync(archive) || !statSync(archive).isFile()) {
      fail(`${rel(manifestPath)} references missing WASIX extension archive ${rel(archive)}`);
    }
    if (sha256(archive) !== row.sha256) {
      fail(`${rel(archive)} does not match the digest in ${rel(manifestPath)}`);
    }
    return archive;
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
  // Release payloads are data, not host executables.  A fixed mode keeps the
  // aggregate archive independent of the producer's umask and checkout mode.
  chmodSync(destination, 0o644);
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

function publicMemberAsset(asset) {
  return publicExtensionReleaseAsset(asset);
}

function stageMember(product, sqlName, version, productRoot, {
  destinationDir,
  bundle,
  requireNative,
  requireWasix,
  requireNativeTargets,
}) {
  const extensionRow = generatedExtensionRow(sqlName);
  const assets = [];
  let iosRegistration = null;
  for (const row of nativeAssetsFor(sqlName, { product, required: requireNative })) {
    const target = row.target;
    if (requireNativeTargets.size > 0 && !requireNativeTargets.has(target)) {
      continue;
    }
    const metadata = copyAsset(row.asset, destinationDir, {
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
    const metadata = copyAsset(wasixArchive, destinationDir, {
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
    const destination = bundle
      ? path.join(productRoot, "wasix-aot", targetId, sqlName)
      : path.join(productRoot, "wasix-aot", targetId);
    rmSync(destination, { recursive: true, force: true });
    cpSync(source, destination, { recursive: true });
  }

  validateStagedTargets(product, assets, {
    requireNative,
    requireWasix,
    requireNativeTargets,
  });
  if (assets.length === 0) {
    fail(`${product}/${sqlName} produced no extension artifacts`);
  }
  return {
    sqlName,
    createsExtension: extensionRow["creates-extension"] !== false,
    dependencies: stringList(extensionRow["selected-extension-dependencies"], `${sqlName}.selected-extension-dependencies`),
    dataFiles: stringList(extensionRow["runtime-share-data-files"], `${sqlName}.runtime-share-data-files`),
    extensionSqlFileNames: stringList(extensionRow["extension-sql-file-names"], `${sqlName}.extension-sql-file-names`),
    extensionSqlFilePrefixes: stringList(extensionRow["extension-sql-file-prefixes"], `${sqlName}.extension-sql-file-prefixes`),
    nativeDependencies: stringList(extensionRow["native-dependencies"], `${sqlName}.native-dependencies`),
    nativeModuleStem: extensionRow["native-module-stem"],
    iosNativeDependencies: assets
      .filter((asset) => asset.kind === "ios-dependency-xcframework")
      .map((asset) => asset.identity)
      .sort(compareText),
    iosRegistration,
    sharedPreloadLibraries: stringList(extensionRow["shared-preload-libraries"], `${sqlName}.shared-preload-libraries`),
    mobileReleaseReady: extensionRow["mobile-release-ready"] === true,
    desktopReleaseReady: extensionRow["desktop-release-ready"] === true,
    assets,
  };
}

function bundleCarrierAssets(product, version, productRoot, members, compatibility) {
  const assetDir = path.join(productRoot, "release-assets");
  const stageRoot = path.join(productRoot, ".bundle-stage");
  const groups = new Map();
  for (const member of members) {
    for (const asset of member.assets) {
      const key = `${asset.family}\0${asset.target}`;
      const group = groups.get(key) ?? { family: asset.family, target: asset.target, rows: [] };
      group.rows.push({ sqlName: member.sqlName, asset });
      groups.set(key, group);
    }
  }
  const carrierAssets = [];
  for (const group of [...groups.values()].sort((left, right) => compareText(`${left.family}\0${left.target}`, `${right.family}\0${right.target}`))) {
    const memberNames = [...new Set(group.rows.map((row) => row.sqlName))].sort(compareText);
    const expectedNames = members.map((member) => member.sqlName).sort(compareText);
    if (JSON.stringify(memberNames) !== JSON.stringify(expectedNames)) {
      fail(`${product} ${group.family}/${group.target} bundle is missing exact members: expected ${expectedNames.join(",")}, got ${memberNames.join(",")}`);
    }
    const archiveRoot = `${product}-${version}-${group.family}-${group.target}-bundle`;
    const stageDir = path.join(stageRoot, archiveRoot);
    rmSync(stageDir, { recursive: true, force: true });
    mkdirSync(stageDir, { recursive: true });
    const manifestMembers = [];
    for (const row of group.rows.sort((left, right) => compareText(
      `${left.sqlName}\0${left.asset.kind}\0${left.asset.identity ?? ""}`,
      `${right.sqlName}\0${right.asset.kind}\0${right.asset.identity ?? ""}`,
    ))) {
      const memberPath = `extensions/${row.sqlName}/${row.asset.name}`;
      const source = path.join(ROOT, row.asset.path);
      const destination = path.join(stageDir, ...memberPath.split("/"));
      mkdirSync(path.dirname(destination), { recursive: true });
      copyFileSync(source, destination);
      chmodSync(destination, 0o644);
      const copiedSha256 = sha256(destination);
      const copiedBytes = statSync(destination).size;
      if (copiedSha256 !== row.asset.sha256 || copiedBytes !== row.asset.bytes) {
        fail(`${product} ${group.family}/${group.target} changed ${row.sqlName} member bytes while staging ${memberPath}`);
      }
      const member = {
        sqlName: row.sqlName,
        kind: row.asset.kind,
        identity: row.asset.identity ?? null,
        path: memberPath,
        sha256: row.asset.sha256,
        bytes: row.asset.bytes,
      };
      manifestMembers.push(member);
      row.asset.carrierAsset = `${archiveRoot}.tar.gz`;
      row.asset.carrierRoot = archiveRoot;
      row.asset.memberPath = memberPath;
    }
    const externalLicenseFiles = [];
    for (const sqlName of memberNames) {
      externalLicenseFiles.push(...stageExtensionUpstreamLicenses(sqlName, stageDir));
    }
    const legal = extensionCarrierLegalContract(product, memberNames, {
      family: group.family,
      target: group.target,
    });
    const stagedLicenseFiles = [...new Set(externalLicenseFiles)].sort(compareText);
    if (JSON.stringify(stagedLicenseFiles) !== JSON.stringify(legal.licenseFiles)) {
      fail(
        `${product} ${group.family}/${group.target} staged upstream licenses differ from its legal contract: `
        + `expected ${legal.licenseFiles.join(",")}, got ${stagedLicenseFiles.join(",")}`,
      );
    }
    const bundleManifest = path.join(stageDir, "bundle-manifest.json");
    writeFileSync(bundleManifest, `${JSON.stringify(sortValue({
      schema: "oliphaunt-extension-bundle-v1",
      product,
      version,
      compatibility,
      family: group.family,
      target: group.target,
      licenseProfile: legal.profile,
      licenseFiles: legal.licenseFiles,
      members: manifestMembers,
    }), null, 2)}\n`, "utf8");
    chmodSync(bundleManifest, 0o644);
    stageReleaseNotices(stageDir, { profile: legal.profile });
    const output = path.join(assetDir, `${archiveRoot}.tar.gz`);
    writeFileSync(output, canonicalGzipSync(createDeterministicTar(stageDir, archiveRoot, {
      fail,
      // Every bundle member is data. Windows filesystem modes are synthetic,
      // so encode the portable carrier contract instead of copying stat bits.
      fixedFileMode: 0o644,
    })));
    assertReleaseNoticesInArchive(output, {
      prefix: archiveRoot,
      profile: legal.profile,
    });
    if (legal.upstreamMembers.length > 0) {
      assertExtensionUpstreamLicensesInArchive(legal.upstreamMembers, output, {
        prefix: archiveRoot,
      });
    }
    carrierAssets.push({
      name: path.basename(output),
      path: rel(output),
      sha256: sha256(output),
      bytes: statSync(output).size,
      family: group.family,
      target: group.target,
      kind: "extension-bundle",
      memberCount: memberNames.length,
    });
  }
  rmSync(stageRoot, { recursive: true, force: true });
  return carrierAssets;
}

export function extensionReleasePropertiesText({ product, version, manifest, releaseData, directAssets }) {
  const sourceIdentity = releaseData.sourceIdentity;
  const propertiesLines = [
    `schema=${releaseData.schema}\n`,
    `product=${product}\n`,
    `version=${version}\n`,
    `extensionClass=${releaseData.extensionClass}\n`,
    `versioning=${releaseData.versioning}\n`,
    `sourceKind=${sourceIdentity.kind}\n`,
  ];
  if (manifest.schema === "oliphaunt-extension-ci-artifacts-v1") {
    propertiesLines.push(
      `sqlName=${manifest.sqlName}\n`,
      `createsExtension=${manifest.createsExtension ? "true" : "false"}\n`,
      `dependencies=${propertiesCsv(manifest.dependencies)}\n`,
      `dataFiles=${propertiesCsv(manifest.dataFiles)}\n`,
      `extensionSqlFileNames=${propertiesCsv(manifest.extensionSqlFileNames)}\n`,
      `extensionSqlFilePrefixes=${propertiesCsv(manifest.extensionSqlFilePrefixes)}\n`,
      `nativeDependencies=${propertiesCsv(manifest.nativeDependencies)}\n`,
      `nativeModuleStem=${manifest.nativeModuleStem || ""}\n`,
      `iosNativeDependencies=${propertiesCsv(manifest.iosNativeDependencies)}\n`,
      `sharedPreloadLibraries=${propertiesCsv(manifest.sharedPreloadLibraries)}\n`,
      `mobileReleaseReady=${manifest.mobileReleaseReady ? "true" : "false"}\n`,
      `desktopReleaseReady=${manifest.desktopReleaseReady ? "true" : "false"}\n`,
    );
    for (const asset of [...manifest.assets].sort((left, right) => compareText(
      `${left.family}\0${left.target}\0${left.kind}\0${left.identity ?? ""}\0${left.name}`,
      `${right.family}\0${right.target}\0${right.kind}\0${right.identity ?? ""}\0${right.name}`,
    ))) {
      const identity = asset.identity === null || asset.identity === undefined ? "" : `.${asset.identity}`;
      propertiesLines.push(`asset.${asset.family}.${asset.target}.${asset.kind}${identity}=${asset.name}\n`);
    }
  } else {
    propertiesLines.push(`extensions=${manifest.extensions.map((row) => row.sqlName).join(",")}\n`);
    for (const member of manifest.extensions) {
      const prefix = `extension.${member.sqlName}`;
      propertiesLines.push(
        `${prefix}.createsExtension=${member.createsExtension ? "true" : "false"}\n`,
        `${prefix}.dependencies=${propertiesCsv(member.dependencies)}\n`,
        `${prefix}.dataFiles=${propertiesCsv(member.dataFiles)}\n`,
        `${prefix}.extensionSqlFileNames=${propertiesCsv(member.extensionSqlFileNames)}\n`,
        `${prefix}.extensionSqlFilePrefixes=${propertiesCsv(member.extensionSqlFilePrefixes)}\n`,
        `${prefix}.nativeDependencies=${propertiesCsv(member.nativeDependencies)}\n`,
        `${prefix}.nativeModuleStem=${member.nativeModuleStem || ""}\n`,
        `${prefix}.iosNativeDependencies=${propertiesCsv(member.iosNativeDependencies)}\n`,
        `${prefix}.sharedPreloadLibraries=${propertiesCsv(member.sharedPreloadLibraries)}\n`,
        `${prefix}.mobileReleaseReady=${member.mobileReleaseReady ? "true" : "false"}\n`,
        `${prefix}.desktopReleaseReady=${member.desktopReleaseReady ? "true" : "false"}\n`,
      );
      for (const asset of member.assets) {
        const identity = asset.identity === null || asset.identity === undefined ? "" : `.${asset.identity}`;
        propertiesLines.push(`asset.${member.sqlName}.${asset.family}.${asset.target}.${asset.kind}${identity}=${asset.carrierAsset}:${asset.memberPath}:${asset.sha256}:${asset.bytes}\n`);
      }
    }
    for (const asset of [...directAssets].sort((left, right) => compareText(`${left.family}\0${left.target}\0${left.kind}`, `${right.family}\0${right.target}\0${right.kind}`))) {
      propertiesLines.push(`carrier.${asset.family}.${asset.target}.${asset.kind}=${asset.name}\n`);
    }
  }
  return propertiesLines.join("");
}

function writeReleaseControls({ product, version, productRoot, manifest, releaseData, releaseMetadata, directAssets }) {
  const assetDir = path.join(productRoot, "release-assets");
  const extensionManifest = path.join(productRoot, "extension-artifacts.json");
  writeFileSync(extensionManifest, `${JSON.stringify(sortValue(manifest), null, 2)}\n`, "utf8");
  const swiftCarrier = directAssets.some((asset) => asset.family === "native" && asset.target === "ios-xcframework")
    ? path.join(assetDir, swiftExtensionCarrierAssetName(product, version))
    : null;
  if (swiftCarrier !== null) {
    writeSwiftExtensionCarrierManifest(swiftCarrier, {
      extensionManifest,
      nativeRuntimeVersion: releaseMetadata.compatibility.nativeRuntimeVersion,
    });
  }
  const releaseManifest = path.join(assetDir, `${product}-${version}-manifest.json`);
  writeFileSync(releaseManifest, `${JSON.stringify(sortValue(releaseData), null, 2)}\n`, "utf8");

  const propertiesManifest = path.join(assetDir, `${product}-${version}-manifest.properties`);
  writeFileSync(
    propertiesManifest,
    extensionReleasePropertiesText({ product, version, manifest, releaseData, directAssets }),
    "utf8",
  );

  const checksumManifest = path.join(assetDir, `${product}-${version}-release-assets.sha256`);
  const checksumLines = readdirSync(assetDir)
    .map((name) => path.join(assetDir, name))
    .filter((file) => statSync(file).isFile() && file !== checksumManifest)
    .sort(compareText)
    .map((file) => `${sha256(file)}  ./${path.basename(file)}\n`);
  writeFileSync(checksumManifest, checksumLines.join(""), "utf8");
  const payloadPaths = Object.freeze(directAssets.map((asset) => asset.path));
  const controlPaths = Object.freeze([
    rel(releaseManifest),
    rel(propertiesManifest),
    ...(swiftCarrier === null ? [] : [rel(swiftCarrier)]),
    rel(checksumManifest),
  ]);
  const artifactPaths = [...new Set([...payloadPaths, ...controlPaths])];
  writeFileSync(
    path.join(productRoot, "artifacts.txt"),
    artifactPaths.map((file) => `${file}\n`).join(""),
    "utf8",
  );
  return { swiftCarrier, releaseManifest, propertiesManifest, checksumManifest };
}

async function stageProduct(product, { outputRoot, requireNative, requireWasix, requireNativeTargets }) {
  const known = new Set(extensionProducts());
  if (!known.has(product)) {
    fail(`unknown exact-extension product ${product}; expected one of: ${[...known].sort(compareText).join(", ")}`);
  }
  const sqlNames = extensionSqlNames(product, PREFIX);
  const version = await currentProductVersion(product, PREFIX);
  const productRoot = path.join(outputRoot, product);
  const assetDir = path.join(productRoot, "release-assets");
  rmSync(productRoot, { recursive: true, force: true });
  mkdirSync(assetDir, { recursive: true });
  const bundle = sqlNames.length > 1;
  const members = sqlNames.map((sqlName) => stageMember(product, sqlName, version, productRoot, {
    destinationDir: bundle ? path.join(productRoot, "member-assets", sqlName) : assetDir,
    bundle,
    requireNative,
    requireWasix,
    requireNativeTargets,
  }));
  const releaseMetadata = extensionMetadata(product, PREFIX);
  let manifest;
  let releaseData;
  let directAssets;
  if (bundle) {
    directAssets = bundleCarrierAssets(
      product,
      version,
      productRoot,
      members,
      releaseMetadata.compatibility,
    );
    manifest = {
      schema: "oliphaunt-extension-ci-artifacts-v2",
      product,
      version,
      compatibility: releaseMetadata.compatibility,
      extensions: members,
      carrierAssets: directAssets,
    };
    releaseData = {
      schema: "oliphaunt-extension-release-manifest-v2",
      product,
      version,
      extensionClass: releaseMetadata.class,
      versioning: releaseMetadata.versioning,
      sourceIdentity: extensionSourceIdentity(product, PREFIX),
      compatibility: releaseMetadata.compatibility,
      extensions: members.map((member) => ({ ...member, assets: member.assets.map(publicMemberAsset) })),
      assets: directAssets.map(publicExtensionReleaseAsset),
    };
  } else {
    const member = members[0];
    directAssets = member.assets;
    manifest = {
      schema: "oliphaunt-extension-ci-artifacts-v1",
      product,
      version,
      compatibility: releaseMetadata.compatibility,
      ...member,
    };
    releaseData = {
      schema: "oliphaunt-extension-release-manifest-v1",
      product,
      version,
      sqlName: member.sqlName,
      extensionClass: releaseMetadata.class,
      versioning: releaseMetadata.versioning,
      sourceIdentity: extensionSourceIdentity(product, PREFIX),
      compatibility: releaseMetadata.compatibility,
      dependencies: member.dependencies,
      dataFiles: member.dataFiles,
      extensionSqlFileNames: member.extensionSqlFileNames,
      extensionSqlFilePrefixes: member.extensionSqlFilePrefixes,
      createsExtension: member.createsExtension,
      nativeDependencies: member.nativeDependencies,
      nativeModuleStem: member.nativeModuleStem,
      iosNativeDependencies: member.iosNativeDependencies,
      iosRegistration: member.iosRegistration,
      sharedPreloadLibraries: member.sharedPreloadLibraries,
      mobileReleaseReady: member.mobileReleaseReady,
      desktopReleaseReady: member.desktopReleaseReady,
      assets: member.assets.map(publicExtensionReleaseAsset),
    };
  }
  writeReleaseControls({ product, version, productRoot, manifest, releaseData, releaseMetadata, directAssets });
  console.log(`${product}: staged ${members.length} exact member(s) in ${directAssets.length} direct carrier asset(s) under ${rel(productRoot)}`);
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

if (import.meta.main) {
  await main(Bun.argv.slice(2));
}
