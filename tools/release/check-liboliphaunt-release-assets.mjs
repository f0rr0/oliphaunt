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
  const metadataPath = path.join(ROOT, "src/extensions/generated/sdk/rust.json");
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
  return "base runtime static-registry manifest must be the canonical empty oliphaunt-static-registry-v1 manifest";
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

function expectedBasePackageSizeReport(entries, file) {
  const runtimeBytes = archiveTreeBytes(entries, file, "oliphaunt/runtime/files/");
  const templateBytes = archiveTreeBytes(entries, file, "oliphaunt/template-pgdata/files/");
  const staticRegistryBytes = archiveTreeBytes(entries, file, "oliphaunt/static-registry/");
  return [
    "kind\tid\textensions\tfiles\tbytes",
    `package\ttotal\t-\t-\t${runtimeBytes + templateBytes + staticRegistryBytes}`,
    `package\truntime\t-\t-\t${runtimeBytes}`,
    `package\ttemplate-pgdata\t-\t-\t${templateBytes}`,
    `package\tstatic-registry\t-\t-\t${staticRegistryBytes}`,
    "extensions\tselected\t-\t-\t0",
    "",
  ].join("\n");
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

async function validateNativeTargetArtifact(file, target, { requireRuntime, toolSet }) {
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

async function validateNativeTargetArtifacts(assetDir, version) {
  const runtimeTargets = new Set(
    allArtifactTargets({
      product: PRODUCT,
      kind: "native-runtime",
      surface: "rust-native-direct",
      publishedOnly: true,
    }).map((target) => target.target),
  );
  for (const target of allArtifactTargets({
    product: PRODUCT,
    kind: "native-runtime",
    surface: "github-release",
    publishedOnly: true,
  })) {
    await validateNativeTargetArtifact(path.join(assetDir, assetName(target, version)), target.target, {
      requireRuntime: runtimeTargets.has(target.target),
      toolSet: "runtime",
    });
  }
  for (const target of allArtifactTargets({
    product: PRODUCT,
    kind: "native-tools",
    surface: "github-release",
    publishedOnly: true,
  })) {
    await validateNativeTargetArtifact(path.join(assetDir, assetName(target, version)), target.target, {
      requireRuntime: true,
      toolSet: "tools",
    });
  }
}

function validateBaseRuntimeArtifactContents(file, packageSizeFile, extensionMetadata) {
  const entries = readArchiveEntries(file);
  const names = new Set(entries.keys());
  const runtimePrefix = "oliphaunt/runtime/files/";
  for (const requiredMember of [
    "oliphaunt/package-size.tsv",
    "oliphaunt/runtime/manifest.properties",
    "oliphaunt/static-registry/manifest.properties",
    "oliphaunt/template-pgdata/manifest.properties",
  ]) {
    if (!names.has(requiredMember)) {
      fail(`${file} must contain ${requiredMember}`);
    }
  }
  if (!names.has(`${runtimePrefix}share/postgresql/README.release-fixture`) && ![...names].some((name) => name.startsWith(runtimePrefix))) {
    fail(`${file} must contain an oliphaunt/runtime/files tree`);
  }
  if ([...names].some((name) => name.startsWith(`${runtimePrefix}share/icu/`))) {
    fail(`${file} base runtime must not contain ICU data under ${runtimePrefix}share/icu`);
  }
  for (const [sqlName, metadata] of extensionMetadata) {
    const control = `${runtimePrefix}share/postgresql/extension/${sqlName}.control`;
    if (names.has(control)) {
      fail(`${file} base runtime must not contain optional extension control file ${control}`);
    }
    for (const dataFile of metadata.dataFiles) {
      const dataPath = `${runtimePrefix}share/postgresql/${dataFile}`;
      if (names.has(dataPath)) {
        fail(`${file} base runtime must not contain optional extension data file ${dataPath}`);
      }
    }
    if (typeof metadata.nativeModuleStem === "string" && metadata.nativeModuleStem) {
      for (const suffix of [".dylib", ".so", ".dll"]) {
        const module = `${runtimePrefix}lib/postgresql/${metadata.nativeModuleStem}${suffix}`;
        if (names.has(module)) {
          fail(`${file} base runtime must not contain optional extension module ${module}`);
        }
      }
    }
  }

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
  const releasedPackageSize = readFileSync(packageSizeFile, "utf8");
  if (embeddedPackageSize !== releasedPackageSize) {
    fail(`${packageSizeFile} must byte-match oliphaunt/package-size.tsv in ${file}`);
  }
  const expectedPackageSize = expectedBasePackageSizeReport(entries, file);
  if (embeddedPackageSize !== expectedPackageSize) {
    fail(`${file} package-size report does not match the actual packaged resource bytes`);
  }
}

function validateIcuDataArtifactContents(file) {
  assertReleaseNoticesInArchive(file, { profile: "native-icu-data" });
  const names = archiveMemberNames(file);
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
  const legalNames = releaseNoticeNamespaceNames("native-icu-data");
  const unexpected = [...names]
    .filter((name) =>
      name !== "."
      && name !== "share"
      && name !== "share/icu"
      && !name.startsWith("share/icu/")
      && !legalNames.has(name))
    .sort(compareText);
  if (unexpected.length > 0) {
    fail(`${file} must contain only share/icu data, found: ${unexpected.slice(0, 5).join(", ")}`);
  }
}

function validateReleaseNoticeClosure(assetDir, version) {
  const profileByKind = new Map([
    ["native-runtime", "native-runtime"],
    ["native-tools", "native-tools"],
    ["apple-swiftpm-binary", "native-runtime"],
    ["runtime-resources", "native-runtime-resources"],
    ["icu-data", "native-icu-data"],
  ]);
  for (const target of allArtifactTargets({
    product: PRODUCT,
    surface: "github-release",
    publishedOnly: true,
  })) {
    const profile = profileByKind.get(target.kind);
    if (profile !== undefined) {
      assertReleaseNoticesInArchive(path.join(assetDir, assetName(target, version)), { profile });
    }
  }
}

function parseSizeValue(value, file, lineNumber, field) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || String(parsed) !== value) {
    fail(`${file} line ${lineNumber} has invalid ${field}: ${JSON.stringify(value)}`);
  }
  if (parsed < 0) {
    fail(`${file} line ${lineNumber} has negative ${field}: ${JSON.stringify(value)}`);
  }
  return parsed;
}

function parseTsv(file, expectedHeader) {
  const lines = readFileSync(file, "utf8").split(/\r?\n/u);
  const header = lines.shift()?.split("\t") ?? [];
  if (JSON.stringify(header) !== JSON.stringify(expectedHeader)) {
    fail(`${file} has unexpected header: ${JSON.stringify(header)}`);
  }
  return lines
    .filter((line) => line.length > 0)
    .map((line, index) => {
      const values = line.split("\t");
      const row = Object.fromEntries(header.map((column, columnIndex) => [column, values[columnIndex] ?? ""]));
      return { row, lineNumber: index + 2 };
    });
}

function validatePackageSizeReport(file) {
  requireFile(file, "liboliphaunt package-size release report");
  const rows = new Map();
  const extensionRows = [];
  for (const { row, lineNumber } of parseTsv(file, ["kind", "id", "extensions", "files", "bytes"])) {
    const key = `${row.kind}\0${row.id}`;
    if (rows.has(key)) {
      fail(`${file} repeats row ${row.kind}/${row.id}`);
    }
    rows.set(key, row);
    parseSizeValue(row.bytes, file, lineNumber, "bytes");
    if (row.kind === "extension") {
      extensionRows.push(row.id);
      parseSizeValue(row.files, file, lineNumber, "files");
    } else if (row.files !== "-") {
      fail(`${file} line ${lineNumber} package rows must use '-' for files`);
    }
  }

  const requiredRows = [
    ["package", "total"],
    ["package", "runtime"],
    ["package", "template-pgdata"],
    ["package", "static-registry"],
    ["extensions", "selected"],
  ];
  const missing = requiredRows
    .filter(([kind, id]) => !rows.has(`${kind}\0${id}`))
    .map(([kind, id]) => `${kind}/${id}`);
  if (missing.length > 0) {
    fail(`${file} is missing required row(s): ${missing.join(", ")}`);
  }
  if (rows.get("extensions\0selected").bytes !== "0") {
    fail(`${file} base package-size report must have zero selected extension bytes`);
  }
  if (extensionRows.length > 0) {
    fail(`${file} base package-size report must not include selected extension rows: ${extensionRows.sort(compareText).join(", ")}`);
  }
  const total = parseSizeValue(rows.get("package\0total").bytes, file, 0, "package total bytes");
  const parts = [
    ["package", "runtime"],
    ["package", "template-pgdata"],
    ["package", "static-registry"],
  ].reduce((sum, [kind, id]) => sum + parseSizeValue(rows.get(`${kind}\0${id}`).bytes, file, 0, `${kind}/${id} bytes`), 0);
  if (total !== parts) {
    fail(`${file} package total bytes must equal runtime + template-pgdata + static-registry`);
  }
}

function expectedGithubAssets(version) {
  return allArtifactTargets({
    product: PRODUCT,
    surface: "github-release",
    publishedOnly: true,
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
  validateBaseRuntimeArtifactContents(
    path.join(assetDir, `liboliphaunt-${version}-runtime-resources.tar.gz`),
    path.join(assetDir, `liboliphaunt-${version}-package-size.tsv`),
    metadata,
  );
  await validateNativeTargetArtifacts(assetDir, version);
  validateIcuDataArtifactContents(path.join(assetDir, `liboliphaunt-${version}-icu-data.tar.gz`));
  validatePackageSizeReport(path.join(assetDir, `liboliphaunt-${version}-package-size.tsv`));
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
