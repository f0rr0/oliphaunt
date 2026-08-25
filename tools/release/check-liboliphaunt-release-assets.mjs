#!/usr/bin/env bun
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import {
  ROOT,
  allArtifactTargets,
  compareText,
  currentProductVersion,
} from "./release-artifact-targets.mjs";
import { inspectPlatformBinaryTree } from "./platform-binary-contract.mjs";
import { readPortableArchiveEntries } from "./portable-archive.mjs";
import {
  assertReleaseNoticesInArchive,
  releaseNoticeRows,
} from "./release-notices.mjs";
import { SNOWBALL_STOPWORD_LANGUAGES } from "./optimize_native_runtime_payload.mjs";
import {
  parseProperties,
  validateNativeClusterSeedManifest,
} from "./native-cluster-seed-contract.mjs";
import { validateNativeIcuDataManifestRows } from "./native-icu-data-contract.mjs";
import { NATIVE_RUNTIME_CARRIER_SCHEMA } from "./native-runtime-carrier-contract.mjs";
import {
  compareNativeMobileAbiReceipts,
  NATIVE_MOBILE_ABI_TARGETS_BY_DOMAIN,
} from "./native-mobile-abi-contract.mjs";

const PREFIX = "check-liboliphaunt-release-assets.mjs";
const PRODUCT = "liboliphaunt-native";
const EMPTY_STATIC_REGISTRY_MANIFEST = [
  "packageLayout=oliphaunt-static-registry-v1",
  "abiVersion=1",
  "state=not-required",
  "source=",
  "registeredExtensions=",
  "pendingExtensions=",
  "nativeModuleStems=",
  "modules=",
  "archiveTargets=",
  "dependencyArchiveTargets=",
  "dependencyArchives=",
  "",
].join("\n");

function fail(message) {
  console.error(`${PREFIX}: ${message}`);
  process.exit(1);
}

function rel(file) {
  const relative = path.relative(ROOT, file);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return file;
  }
  return relative.split(path.sep).join("/");
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function requireFile(file, description) {
  let stat;
  try {
    stat = statSync(file);
  } catch {
    fail(`missing ${description}: ${file}`);
  }
  if (!stat.isFile()) {
    fail(`${description} is not a file: ${file}`);
  }
  if (stat.size <= 0) {
    fail(`${description} is empty: ${file}`);
  }
}

function parseChecksumFile(file) {
  const checksums = new Map();
  for (const rawLine of readFileSync(file, "utf8").split(/\r?\n/u)) {
    if (!rawLine.trim()) {
      continue;
    }
    const parts = rawLine.trim().split(/\s+/u);
    if (parts.length !== 2) {
      fail(`malformed checksum line in ${file}: ${JSON.stringify(rawLine)}`);
    }
    const [digest, filename] = parts;
    if (!filename.startsWith("./")) {
      fail(`checksum path must be relative './name': ${filename}`);
    }
    checksums.set(filename.slice(2), digest);
  }
  return checksums;
}

function validateChecksums(assetDir, checksumFile) {
  const checksums = parseChecksumFile(checksumFile);
  const expectedAssets = readdirSync(assetDir)
    .map((name) => path.join(assetDir, name))
    .filter((file) => statSync(file).isFile() && path.extname(file) !== ".sha256")
    .sort(compareText);
  if (expectedAssets.length === 0) {
    fail(`no release assets found in ${assetDir}`);
  }
  const assetNames = new Set(expectedAssets.map((file) => path.basename(file)));
  for (const asset of expectedAssets) {
    const recorded = checksums.get(path.basename(asset));
    if (!recorded) {
      fail(`checksum file does not cover release asset: ${path.basename(asset)}`);
    }
    const actual = sha256(asset);
    if (recorded !== actual) {
      fail(`checksum mismatch for ${path.basename(asset)}: expected ${recorded}, got ${actual}`);
    }
  }
  const extra = [...checksums.keys()].filter((name) => !assetNames.has(name)).sort(compareText);
  if (extra.length > 0) {
    fail(`checksum file contains entries for missing assets: ${extra.join(", ")}`);
  }
}

function generatedExtensionMetadata() {
  const metadataPath = path.join(ROOT, "src/extensions/generated/sdk/extensions.json");
  let metadata;
  try {
    metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
  } catch (error) {
    fail(`read generated Rust SDK extension metadata ${metadataPath}: ${error.message}`);
  }
  if (!Array.isArray(metadata.extensions)) {
    fail(`${metadataPath} must define an extensions array`);
  }
  const expected = new Map();
  for (const [index, row] of metadata.extensions.entries()) {
    if (row === null || Array.isArray(row) || typeof row !== "object") {
      fail(`${metadataPath} extensions[${index}] must be an object`);
    }
    const sqlName = row["sql-name"];
    if (typeof sqlName !== "string" || !sqlName) {
      fail(`${metadataPath} extensions[${index}] must define sql-name`);
    }
    const dataFiles = row["runtime-share-data-files"];
    if (!Array.isArray(dataFiles) || !dataFiles.every((value) => typeof value === "string")) {
      fail(`${metadataPath} extension ${sqlName} must define runtime-share-data-files`);
    }
    const nativeModuleStem = row["native-module-stem"];
    if (nativeModuleStem !== null && nativeModuleStem !== undefined && typeof nativeModuleStem !== "string") {
      fail(`${metadataPath} extension ${sqlName} native-module-stem must be a string or null`);
    }
    expected.set(sqlName, {
      createsExtension: row["creates-extension"] === true,
      dataFiles,
      dataFilesTsv: dataFiles.length > 0 ? dataFiles.join(",") : "-",
      nativeModuleStem,
    });
  }
  return expected;
}

export function canonicalTarEntryMarkerError(name, type) {
  if (name === "." || name === "./") return null;
  const directoryMarker = name.endsWith("/");
  if (type === "5" && !directoryMarker) {
    return `directory member must use a trailing slash: ${JSON.stringify(name)}`;
  }
  if ((type === "" || type === "0") && directoryMarker) {
    return `regular-file member must not use a trailing slash: ${JSON.stringify(name)}`;
  }
  return null;
}

export function canonicalEmptyStaticRegistryManifestError(text) {
  if (text === EMPTY_STATIC_REGISTRY_MANIFEST) {
    return null;
  }
  return "standard runtime static-registry manifest must be the canonical empty oliphaunt-static-registry-v1 manifest";
}

function readArchiveEntries(file) {
  try {
    return readPortableArchiveEntries(file);
  } catch (error) {
    fail(`${file} is not a strict portable release archive: ${error.message}`);
  }
}

function archiveMemberNames(file) {
  return new Set(readArchiveEntries(file).keys());
}

function releaseNoticeNamespaceNames(profile) {
  const names = new Set();
  for (const { member } of releaseNoticeRows({ profile })) {
    names.add(member);
    const parts = member.split("/");
    for (let index = 1; index < parts.length; index += 1) {
      names.add(parts.slice(0, index).join("/"));
    }
  }
  return names;
}

function archiveText(entries, file, memberName) {
  const entry = entries.get(memberName);
  if (!entry) {
    fail(`${file} is missing ${memberName}`);
  }
  if (!entry.isFile) {
    fail(`${file} member ${memberName} is not a regular file`);
  }
  try {
    const data = typeof entry.data === "function" ? entry.data() : entry.data;
    return Buffer.from(data).toString("utf8");
  } catch (error) {
    fail(`${file} member ${memberName} is not readable UTF-8: ${error.message}`);
  }
}

function archiveTreeBytes(entries, file, prefix) {
  let total = 0;
  for (const [name, entry] of entries) {
    if (!name.startsWith(prefix) || entry.isDirectory) {
      continue;
    }
    if (!entry.isFile) {
      fail(`${file} member ${name} under ${prefix} must be a regular file`);
    }
    const data = typeof entry.data === "function" ? entry.data() : entry.data;
    total += Buffer.byteLength(data);
  }
  return total;
}

function archiveLogicalTreeRows(entries, file, prefix) {
  const rows = [];
  for (const [name, entry] of entries) {
    if (!name.startsWith(prefix) || entry.isDirectory) continue;
    if (!entry.isFile) fail(`${file} member ${name} under ${prefix} must be a regular file`);
    rows.push({
      path: name.slice(prefix.length),
      bytes: typeof entry.data === "function" ? entry.data() : entry.data,
    });
  }
  if (rows.length === 0) fail(`${file} contains no files under ${prefix}`);
  return rows;
}

function expectedRuntimeResourcePackageSizeReport(entries, file) {
  const runtimeBytes = archiveTreeBytes(entries, file, "oliphaunt/runtime/files/");
  const standardSeedBytes = archiveTreeBytes(entries, file, "oliphaunt/cluster-seed/files/");
  const icuSeedBytes = archiveTreeBytes(entries, file, "oliphaunt/cluster-seed-icu/files/");
  const staticRegistryBytes = archiveTreeBytes(entries, file, "oliphaunt/static-registry/");
  return [
    "kind\tid\textensions\tfiles\tbytes",
    `package\ttotal\t-\t-\t${runtimeBytes + standardSeedBytes + icuSeedBytes + staticRegistryBytes}`,
    `package\truntime\t-\t-\t${runtimeBytes}`,
    `package\tcluster-seed\t-\t-\t${standardSeedBytes}`,
    `package\tcluster-seed-icu\t-\t-\t${icuSeedBytes}`,
    `package\tstatic-registry\t-\t-\t${staticRegistryBytes}`,
    "extensions\tselected\t-\t-\t0",
    "",
  ].join("\n");
}

function validateMobileAbiProofEntries(entries, file, domain, prefix = "oliphaunt/") {
  const targets = NATIVE_MOBILE_ABI_TARGETS_BY_DOMAIN[domain];
  if (targets === undefined) fail(`${file} uses unsupported mobile ABI domain ${domain}`);
  const proofPrefix = `${prefix}provenance/native-mobile-abi/`;
  try {
    compareNativeMobileAbiReceipts(
      domain,
      targets.map((target) => {
        const member = `${proofPrefix}${target}.properties`;
        return { label: `${file} ${member}`, text: archiveText(entries, file, member) };
      }),
    );
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

function extractArchive(file, destination) {
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(destination, { recursive: true });
  for (const [name, entry] of readArchiveEntries(file)) {
    if (entry.isDirectory) {
      continue;
    }
    if (!entry.isFile) {
      fail(`${file} member ${name} must be a regular file`);
    }
    const output = path.join(destination, ...name.split("/"));
    mkdirSync(path.dirname(output), { recursive: true });
    const data = typeof entry.data === "function" ? entry.data() : entry.data;
    writeFileSync(output, data);
    if (entry.mode) {
      chmodSync(output, entry.mode & 0o777);
    }
  }
}

function validateNativeRuntimeCarrierEntries(
  entries,
  file,
  { prefix = "", target, icuDataTreeSha256 },
) {
  const member = (relative) => `${prefix}${relative}`;
  for (const required of [
    "manifest.properties",
    "cluster-seed/manifest.properties",
    "cluster-seed/files/PG_VERSION",
    "cluster-seed/files/global/pg_control",
    "cluster-seed-icu/manifest.properties",
    "cluster-seed-icu/files/PG_VERSION",
    "cluster-seed-icu/files/global/pg_control",
  ]) {
    if (!entries.get(member(required))?.isFile) {
      fail(`${file} is missing native runtime closure member ${member(required)}`);
    }
  }
  for (const profile of ["cluster-seed", "cluster-seed-icu"]) {
    const filesPrefix = member(`${profile}/files/`);
    const pgVersion = entries.get(`${filesPrefix}PG_VERSION`);
    const control = entries.get(`${filesPrefix}global/pg_control`);
    const pgWal = entries.get(`${filesPrefix}pg_wal/`) ?? entries.get(`${filesPrefix}pg_wal`);
    if (pgVersion?.isSymbolicLink
      || archiveText(entries, file, `${filesPrefix}PG_VERSION`).trim() !== "18") {
      fail(`${file} has invalid ${filesPrefix}PG_VERSION`);
    }
    if (control?.isSymbolicLink || control?.size <= 0) {
      fail(`${file} has invalid ${filesPrefix}global/pg_control`);
    }
    if (!pgWal?.isDirectory || pgWal.isSymbolicLink) {
      fail(`${file} is missing real directory ${filesPrefix}pg_wal/`);
    }
    for (const [name, entry] of entries) {
      if (!name.startsWith(filesPrefix)) continue;
      if (entry.isSymbolicLink || (!entry.isFile && !entry.isDirectory)) {
        fail(`${file} cluster seed member ${name} must be a regular file or directory`);
      }
    }
    for (const transient of ["postmaster.pid", "postmaster.opts"]) {
      if (entries.has(`${filesPrefix}${transient}`)) {
        fail(`${file} cluster seed contains transient ${filesPrefix}${transient}`);
      }
    }
  }
  try {
    const receipt = parseProperties(
      Buffer.from(archiveText(entries, file, member("manifest.properties"))),
      `${file} ${member("manifest.properties")}`,
    );
    if (receipt.size !== 4
      || receipt.get("schema") !== NATIVE_RUNTIME_CARRIER_SCHEMA
      || receipt.get("clusterSeedTarget") !== target
      || receipt.get("clusterSeedRelativePath") !== "cluster-seed"
      || receipt.get("icuClusterSeedRelativePath") !== "cluster-seed-icu") {
      fail(`${file} has an invalid ${target} native runtime carrier receipt`);
    }
    validateNativeClusterSeedManifest(
      Buffer.from(archiveText(entries, file, member("cluster-seed/manifest.properties"))),
      "standard",
      { label: `${file} ${member("cluster-seed/manifest.properties")}`, target },
    );
    validateNativeClusterSeedManifest(
      Buffer.from(archiveText(entries, file, member("cluster-seed-icu/manifest.properties"))),
      "icu",
      {
        label: `${file} ${member("cluster-seed-icu/manifest.properties")}`,
        target,
        icuDataTreeSha256,
      },
    );
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

async function validateNativeTargetArtifact(
  file,
  target,
  { requireRuntime, toolSet, icuDataTreeSha256 },
) {
  if (requireRuntime && toolSet === "runtime") {
    const entries = readPortableArchiveEntries(file);
    validateNativeRuntimeCarrierEntries(entries, file, { target, icuDataTreeSha256 });
    if (target === "windows-x64-msvc") {
      for (const directory of ["bin", "runtime/bin"]) {
        for (const name of ["icudt76.dll", "icuin76.dll", "icuuc76.dll"]) {
          const member = `${directory}/${name}`;
          const entry = entries.get(member);
          if (entry === undefined || !entry.isFile || entry.isSymbolicLink || entry.size <= 0) {
            fail(`${file} ICU-enabled Windows runtime is missing ${member}`);
          }
        }
      }
    }
  }
  const temp = mkdtempSync(path.join(tmpdir(), `oliphaunt-native-${target}-`));
  try {
    const extracted = path.join(temp, "payload");
    extractArchive(file, extracted);
    const command = [
      "tools/release/optimize_native_runtime_payload.mjs",
      extracted,
      "--target",
      target,
      "--tool-set",
      toolSet,
      "--check",
    ];
    if (!requireRuntime) {
      command.push("--allow-missing-runtime");
    }
    await inspectPlatformBinaryTree(extracted, {
      target,
      requireWindowsRuntimeImportLibrary:
        target === "windows-x64-msvc" && toolSet === "runtime",
      windowsVcRuntimeProfile:
        target === "windows-x64-msvc" && toolSet === "runtime" ? "provider" : undefined,
    });
    const result = spawnSync(process.execPath, command, {
      cwd: ROOT,
      stdio: "inherit",
    });
    if (result.status !== 0) {
      process.exit(result.status ?? 1);
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

function assetName(target, version) {
  return target.asset.replaceAll("{version}", version);
}

async function validateNativeTargetArtifacts(assetDir, version, icuDataTreeSha256) {
  const runtimeTargets = new Set(
    allArtifactTargets({
      product: PRODUCT,
      kind: "native-runtime",
      surface: "rust-native-direct",
    }).map((target) => target.target),
  );
  for (const target of allArtifactTargets({
    product: PRODUCT,
    kind: "native-runtime",
    surface: "github-release",
  })) {
    await validateNativeTargetArtifact(path.join(assetDir, assetName(target, version)), target.target, {
      requireRuntime: runtimeTargets.has(target.target),
      toolSet: "runtime",
      icuDataTreeSha256,
    });
  }
  for (const target of allArtifactTargets({
    product: PRODUCT,
    kind: "native-tools",
    surface: "github-release",
  })) {
    await validateNativeTargetArtifact(path.join(assetDir, assetName(target, version)), target.target, {
      requireRuntime: true,
      toolSet: "tools",
    });
  }
}

function validateRuntimeResourceArtifactContents(
  file,
  { target, icuDataTreeSha256, extensionMetadata },
) {
  const entries = readArchiveEntries(file);
  const names = new Set(entries.keys());
  const runtimePrefix = "oliphaunt/runtime/files/";
  for (const requiredMember of [
    "oliphaunt/manifest.properties",
    "oliphaunt/package-size.tsv",
    "oliphaunt/runtime/manifest.properties",
    "oliphaunt/static-registry/manifest.properties",
    "oliphaunt/cluster-seed/manifest.properties",
    "oliphaunt/cluster-seed/files/PG_VERSION",
    "oliphaunt/cluster-seed/files/global/pg_control",
    "oliphaunt/cluster-seed-icu/manifest.properties",
    "oliphaunt/cluster-seed-icu/files/PG_VERSION",
    "oliphaunt/cluster-seed-icu/files/global/pg_control",
  ]) {
    if (!names.has(requiredMember)) {
      fail(`${file} must contain ${requiredMember}`);
    }
  }
  if (!names.has(`${runtimePrefix}share/postgresql/README.release-fixture`) && ![...names].some((name) => name.startsWith(runtimePrefix))) {
    fail(`${file} must contain an oliphaunt/runtime/files tree`);
  }
  if ([...names].some((name) => name.startsWith(`${runtimePrefix}share/icu/`))) {
    fail(`${file} standard runtime must not contain ICU data under ${runtimePrefix}share/icu`);
  }
  for (const required of [
    `${runtimePrefix}share/postgresql/extension/plpgsql--1.0.sql`,
    `${runtimePrefix}share/postgresql/extension/plpgsql.control`,
    `${runtimePrefix}share/postgresql/snowball_create.sql`,
    ...SNOWBALL_STOPWORD_LANGUAGES.map(
      (language) => `${runtimePrefix}share/postgresql/tsearch_data/${language}.stop`,
    ),
  ]) {
    const entry = entries.get(required);
    if (entry === undefined || !entry.isFile || entry.isSymbolicLink || entry.size <= 0) {
      fail(`${file} standard runtime is missing required core PostgreSQL resource ${required}`);
    }
  }
  for (const [sqlName, metadata] of extensionMetadata) {
    const control = `${runtimePrefix}share/postgresql/extension/${sqlName}.control`;
    if (names.has(control)) {
      fail(`${file} standard runtime must not contain optional extension control file ${control}`);
    }
    for (const dataFile of metadata.dataFiles) {
      const dataPath = `${runtimePrefix}share/postgresql/${dataFile}`;
      if (names.has(dataPath)) {
        fail(`${file} standard runtime must not contain optional extension data file ${dataPath}`);
      }
    }
    if (typeof metadata.nativeModuleStem === "string" && metadata.nativeModuleStem) {
      for (const suffix of [".dylib", ".so", ".dll"]) {
        const module = `${runtimePrefix}lib/postgresql/${metadata.nativeModuleStem}${suffix}`;
        if (names.has(module)) {
          fail(`${file} standard runtime must not contain optional extension module ${module}`);
        }
      }
    }
  }

  validateNativeRuntimeCarrierEntries(entries, file, {
    prefix: "oliphaunt/",
    target,
    icuDataTreeSha256,
  });
  validateMobileAbiProofEntries(entries, file, target);

  const staticRegistryManifest = archiveText(
    entries,
    file,
    "oliphaunt/static-registry/manifest.properties",
  );
  const staticRegistryError = canonicalEmptyStaticRegistryManifestError(staticRegistryManifest);
  if (staticRegistryError !== null) {
    fail(`${file} ${staticRegistryError}`);
  }

  const embeddedPackageSize = archiveText(entries, file, "oliphaunt/package-size.tsv");
  const expectedPackageSize = expectedRuntimeResourcePackageSizeReport(entries, file);
  if (embeddedPackageSize !== expectedPackageSize) {
    fail(`${file} package-size report does not match the actual packaged resource bytes`);
  }
}

function validateIcuDataArtifactContents(file) {
  assertReleaseNoticesInArchive(file, { profile: "native-icu-data" });
  const entries = readArchiveEntries(file);
  const names = new Set(entries.keys());
  const icuEntries = [...names]
    .filter((name) => {
      if (!name.startsWith("share/icu/")) {
        return false;
      }
      const parts = name.slice("share/icu/".length).split("/").filter(Boolean);
      return parts.length > 0 && parts[0].startsWith("icudt");
    })
    .sort(compareText);
  if (icuEntries.length === 0) {
    fail(`${file} must contain ICU data files under share/icu/icudt*`);
  }
  let receipt;
  try {
    receipt = validateNativeIcuDataManifestRows(
      Buffer.from(archiveText(entries, file, "manifest.properties")),
      archiveLogicalTreeRows(entries, file, "share/icu/"),
      `${file} manifest.properties`,
    );
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  const icuDataBytes = archiveTreeBytes(entries, file, "share/icu/");
  const expectedSizeReport = [
    "kind\tid\textensions\tfiles\tbytes",
    `package\ttotal\t-\t-\t${icuDataBytes}`,
    `package\ticu-data\t-\t-\t${icuDataBytes}`,
    "",
  ].join("\n");
  if (archiveText(entries, file, "package-size.tsv") !== expectedSizeReport) {
    fail(`${file} ICU package-size report does not match the actual data bytes`);
  }
  const legalNames = releaseNoticeNamespaceNames("native-icu-data");
  const unexpected = [...names]
    .filter((name) =>
      name !== "."
      && name !== "share"
      && name !== "share/icu"
      && !name.startsWith("share/icu/")
      && name !== "manifest.properties"
      && name !== "package-size.tsv"
      && !legalNames.has(name))
    .sort(compareText);
  if (unexpected.length > 0) {
    fail(`${file} must contain only ICU data and its receipt, found: ${unexpected.slice(0, 5).join(", ")}`);
  }
  return receipt.icuDataTreeSha256;
}

const RELEASE_NOTICE_OPTIONS_BY_KIND = new Map([
  ["native-runtime", Object.freeze({ profile: "native-runtime" })],
  ["native-tools", Object.freeze({ profile: "native-tools" })],
  [
    "apple-swiftpm-binary",
    Object.freeze({
      profile: "native-runtime",
      prefix: "liboliphaunt.xcframework",
    }),
  ],
  ["runtime-resources", Object.freeze({ profile: "native-runtime-resources" })],
  ["icu-data", Object.freeze({ profile: "native-icu-data" })],
]);

export function assertLiboliphauntArtifactReleaseNotices(file, kind) {
  const options = RELEASE_NOTICE_OPTIONS_BY_KIND.get(kind);
  if (options === undefined) {
    return false;
  }
  assertReleaseNoticesInArchive(file, options);
  return true;
}

function validateReleaseNoticeClosure(assetDir, version) {
  for (const target of allArtifactTargets({
    product: PRODUCT,
    surface: "github-release",
  })) {
    assertLiboliphauntArtifactReleaseNotices(
      path.join(assetDir, assetName(target, version)),
      target.kind,
    );
  }
}

function expectedGithubAssets(version) {
  return allArtifactTargets({
    product: PRODUCT,
    surface: "github-release",
  }).map((target) => assetName(target, version)).sort(compareText);
}

async function validate(assetDir) {
  const version = await currentProductVersion(PRODUCT, PREFIX);
  const metadata = generatedExtensionMetadata();
  const required = expectedGithubAssets(version);
  const expected = new Set(required);
  const actual = new Set(readdirSync(assetDir).filter((name) => statSync(path.join(assetDir, name)).isFile()));
  const missing = [...expected].filter((name) => !actual.has(name)).sort(compareText);
  if (missing.length > 0) {
    fail(`liboliphaunt-native release asset directory is missing expected assets: ${missing.join(", ")}`);
  }
  const unexpected = [...actual].filter((name) => !expected.has(name)).sort(compareText);
  if (unexpected.length > 0) {
    fail(`liboliphaunt-native release asset directory contains unexpected assets: ${unexpected.join(", ")}`);
  }
  for (const filename of required) {
    requireFile(path.join(assetDir, filename), `liboliphaunt release artifact ${filename}`);
  }
  validateReleaseNoticeClosure(assetDir, version);
  const leakedExtensionAssets = [...actual]
    .filter((name) => name.includes("extension") && !name.endsWith("-release-assets.sha256"))
    .sort(compareText);
  if (leakedExtensionAssets.length > 0) {
    fail(
      "liboliphaunt-native release assets must not include exact-extension artifacts; " +
        `publish them through oliphaunt-extension-* products instead: ${leakedExtensionAssets.join(", ")}`,
    );
  }
  const icuDataTreeSha256 = validateIcuDataArtifactContents(
    path.join(assetDir, `liboliphaunt-${version}-icu-data.tar.gz`),
  );
  for (const target of ["ios-datum64", "android-datum64"]) {
    validateRuntimeResourceArtifactContents(
      path.join(assetDir, `liboliphaunt-${version}-runtime-resources-${target}.tar.gz`),
      { target, icuDataTreeSha256, extensionMetadata: metadata },
    );
  }
  for (const filename of [
    `liboliphaunt-${version}-ios-xcframework.tar.gz`,
    `liboliphaunt-${version}-apple-spm-xcframework.zip`,
  ]) {
    const file = path.join(assetDir, filename);
    const entries = readArchiveEntries(file);
    for (const slice of ["ios-arm64", "ios-arm64-simulator"]) {
      validateMobileAbiProofEntries(
        entries,
        file,
        "ios-datum64",
        `liboliphaunt.xcframework/${slice}/liboliphaunt.framework/Resources/oliphaunt/`,
      );
    }
  }
  await validateNativeTargetArtifacts(assetDir, version, icuDataTreeSha256);
  validateChecksums(assetDir, path.join(assetDir, `liboliphaunt-${version}-release-assets.sha256`));
}

function parseArgs(argv) {
  const args = {
    assetDir: path.join(ROOT, "target/liboliphaunt/release-assets"),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--asset-dir") {
      const value = argv[index + 1];
      if (!value) {
        fail("--asset-dir requires a value");
      }
      args.assetDir = path.resolve(ROOT, value);
      index += 1;
    } else {
      fail(`unknown argument ${arg}`);
    }
  }
  return args;
}

if (import.meta.main) {
  const args = parseArgs(Bun.argv.slice(2));
  if (!existsSync(args.assetDir) || !statSync(args.assetDir).isDirectory()) {
    fail(`release asset directory does not exist: ${args.assetDir}`);
  }
  await validate(args.assetDir);
  console.log(`liboliphaunt release assets validated: ${rel(args.assetDir)}`);
}
