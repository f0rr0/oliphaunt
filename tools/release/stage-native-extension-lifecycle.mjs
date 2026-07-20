#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import {
  ROOT,
  compareText,
  currentProductVersionSync,
  exactExtensionProducts,
  extensionSqlNames,
} from "./release-artifact-targets.mjs";
import {
  NATIVE_EXTENSION_ASSET_INDEX_HEADER,
  isCanonicalNativeExtensionRuntimeIndexRow,
} from "./native-extension-asset-index-contract.mjs";
import {
  requiredRuntimeMemberPaths,
  requiredToolsMemberPaths,
} from "./optimize_native_runtime_payload.mjs";
import {
  isCanonicalExtensionInstallSql,
  validateExtensionInstallSqlReachability,
} from "./extension-artifact-inventory.mjs";

const PREFIX = "stage-native-extension-lifecycle.mjs";
const TARGET = "linux-x64-gnu";
const EXTENSION_ARTIFACT_PROPERTY_KEYS = new Set([
  "packageLayout",
  "pgMajor",
  "sqlName",
  "createsExtension",
  "nativeModuleStem",
  "nativeModuleFile",
  "nativeTarget",
  "nativeRuntimeProduct",
  "nativeRuntimeVersion",
  "dependencies",
  "dataFiles",
  "extensionSqlFileNames",
  "extensionSqlFilePrefixes",
  "sharedPreloadLibraries",
  "mobilePrebuilt",
  "mobileStaticArchives",
  "mobileStaticDependencyArchives",
  "staticSymbolPrefix",
  "staticSymbolAliases",
  "files",
]);

function fail(message) {
  throw new Error(`${PREFIX}: ${message}`);
}

function parseArgs(argv) {
  const values = new Map();
  const pathArguments = new Set([
    "runtime-assets",
    "extension-assets",
    "broker-assets",
    "proof-runner",
    "output",
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (!name?.startsWith("--")) fail(`unknown argument ${name}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) fail(`${name} requires a value`);
    const key = name.slice(2);
    values.set(key, pathArguments.has(key) ? path.resolve(value) : value);
    index += 1;
  }
  for (const required of [
    "runtime-assets",
    "extension-assets",
    "broker-assets",
    "proof-runner",
    "candidate-sha",
    "candidate-tree",
    "extensions-csv",
    "output",
  ]) {
    if (!values.has(required)) fail(`--${required} is required`);
  }
  return Object.fromEntries(values);
}

function sha256Bytes(data) {
  return createHash("sha256").update(data).digest("hex");
}

function artifactRecord(identity, file) {
  const data = readFileSync(file);
  return {
    identity,
    file: path.basename(file),
    bytes: data.length,
    sha256: sha256Bytes(data),
  };
}

function assertExactFiles(root, expected, label) {
  const actual = regularFiles(root).map((file) => path.resolve(file)).sort(compareText);
  const wanted = [...expected].map((file) => path.resolve(file)).sort(compareText);
  if (actual.join("\0") !== wanted.join("\0")) {
    fail(
      `${label} has unindexed files: expected=${wanted.map(path.basename).join(",")}; ` +
        `actual=${actual.map(path.basename).join(",")}`,
    );
  }
}

function regularFiles(root) {
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => compareText(a.name, b.name))) {
      const file = path.join(directory, entry.name);
      const stat = lstatSync(file);
      if (stat.isSymbolicLink()) fail(`artifact input contains symbolic link: ${file}`);
      if (stat.isDirectory()) visit(file);
      else if (stat.isFile()) files.push(file);
      else fail(`artifact input contains unsupported filesystem entry: ${file}`);
    }
  };
  if (!statSync(root).isDirectory()) fail(`artifact input is not a directory: ${root}`);
  visit(root);
  return files;
}

function oneFile(root, basename) {
  const matches = regularFiles(root).filter((file) => path.basename(file) === basename);
  if (matches.length !== 1) {
    fail(`${root} must contain exactly one ${basename}, found ${matches.length}`);
  }
  return matches[0];
}

function tarString(buffer, start, length) {
  const end = buffer.indexOf(0, start);
  return buffer
    .subarray(start, end >= start && end < start + length ? end : start + length)
    .toString("utf8")
    .trim();
}

function tarOctal(buffer, start, length, label) {
  const value = tarString(buffer, start, length).replaceAll("\0", "").trim();
  if (!value) return 0;
  if (!/^[0-7]+$/u.test(value)) fail(`archive has malformed ${label}: ${JSON.stringify(value)}`);
  return Number.parseInt(value, 8);
}

function safeArchivePath(raw, archive) {
  const normalized = raw.replaceAll("\\", "/").replace(/\/$/u, "");
  if (normalized === ".") return null;
  const parts = normalized.split("/");
  if (!normalized || normalized.startsWith("/") || parts.some((part) => !part || part === "." || part === "..")) {
    fail(`${archive} contains unsafe member ${JSON.stringify(raw)}`);
  }
  return parts.join("/");
}

export function readCanonicalTarGz(file) {
  let buffer;
  try {
    buffer = gunzipSync(readFileSync(file));
  } catch (error) {
    fail(`${file} is not a readable gzip tar archive: ${error.message}`);
  }
  const entries = new Map();
  let sawTerminator = false;
  for (let offset = 0; offset + 512 <= buffer.length; ) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      sawTerminator = true;
      break;
    }
    const rawName = tarString(header, 0, 100);
    const prefix = tarString(header, 345, 155);
    const fullName = prefix ? `${prefix}/${rawName}` : rawName;
    const name = safeArchivePath(fullName, file);
    const mode = tarOctal(header, 100, 8, "mode");
    const size = tarOctal(header, 124, 12, "size");
    const type = header.subarray(156, 157).toString("utf8");
    if (type !== "0" && type !== "5" && type !== "") {
      fail(`${file} contains unsupported non-file member ${JSON.stringify(fullName)} type=${JSON.stringify(type)}`);
    }
    const isDirectory = type === "5";
    if (isDirectory !== fullName.endsWith("/") && name !== null) {
      fail(`${file} contains non-canonical member marker ${JSON.stringify(fullName)}`);
    }
    const dataOffset = offset + 512;
    if (dataOffset + size > buffer.length) fail(`${file} truncates member ${fullName}`);
    if (name !== null) {
      if (entries.has(name)) fail(`${file} contains duplicate member ${name}`);
      entries.set(name, {
        data: Buffer.from(buffer.subarray(dataOffset, dataOffset + size)),
        isDirectory,
        mode,
      });
    }
    offset = dataOffset + Math.ceil(size / 512) * 512;
  }
  if (!sawTerminator) fail(`${file} is missing the tar terminator`);
  return entries;
}

function extract(entries, destination) {
  mkdirSync(destination, { recursive: true });
  for (const [name, entry] of [...entries].sort(([left], [right]) => compareText(left, right))) {
    const output = path.join(destination, ...name.split("/"));
    const relative = path.relative(destination, output);
    if (relative.startsWith("..") || path.isAbsolute(relative)) fail(`unsafe extraction path ${name}`);
    if (entry.isDirectory) {
      mkdirSync(output, { recursive: true });
      chmodSync(output, 0o755);
    } else {
      mkdirSync(path.dirname(output), { recursive: true });
      writeFileSync(output, entry.data, { mode: entry.mode & 0o111 ? 0o755 : 0o644 });
    }
  }
}

function optionalLstat(file) {
  try {
    return lstatSync(file);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Stage one validated extension carrier into the product-owned resource layout
 * emitted by oliphaunt-build. Carrier-only manifest.properties and files/
 * envelope paths are deliberately not exposed to the runtime locator.
 */
export function stageExtensionCarrier(entries, output, metadata, archive = "native extension carrier") {
  const releaseProduct = metadata?.["release-product"];
  if (
    typeof releaseProduct !== "string"
    || !/^oliphaunt-extension-[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(releaseProduct)
  ) {
    fail(`${archive} has invalid generated release-product ${JSON.stringify(releaseProduct)}`);
  }
  requireArchiveFile(entries, "manifest.properties", archive);
  const destination = path.join(output, "resources/extension", releaseProduct);
  mkdirSync(destination, { recursive: true });
  let stagedFiles = 0;
  for (const [name, entry] of [...entries].sort(([left], [right]) => compareText(left, right))) {
    if (name === "manifest.properties") continue;
    if (name === "files") {
      if (!entry.isDirectory) fail(`${archive} files carrier root must be a directory`);
      continue;
    }
    if (!name.startsWith("files/")) {
      fail(`${archive} contains unexpected carrier-root member ${name}`);
    }
    const relativeName = name.slice("files/".length);
    if (!relativeName) fail(`${archive} contains an empty carrier payload path`);
    const target = path.join(destination, ...relativeName.split("/"));
    const relative = path.relative(destination, target);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      fail(`${archive} contains unsafe carrier payload path ${name}`);
    }
    const existing = optionalLstat(target);
    if (entry.isDirectory) {
      if (existing !== null && !existing.isDirectory()) {
        fail(`${archive} payload directory conflicts at ${target}`);
      }
      mkdirSync(target, { recursive: true });
      chmodSync(target, 0o755);
      continue;
    }
    if (existing !== null) {
      if (!existing.isFile() || existing.isSymbolicLink()) {
        fail(`${archive} payload file conflicts at ${target}`);
      }
      const existingData = readFileSync(target);
      if (!existingData.equals(entry.data)) {
        fail(
          `${archive} payload conflicts at ${target} with different bytes: `
            + `existing=${sha256Bytes(existingData)} incoming=${sha256Bytes(entry.data)}`,
        );
      }
      const executable = (existing.mode & 0o111) !== 0 || (entry.mode & 0o111) !== 0;
      chmodSync(target, executable ? 0o755 : 0o644);
    } else {
      try {
        mkdirSync(path.dirname(target), { recursive: true });
      } catch (error) {
        fail(`${archive} cannot create payload parent for ${target}: ${error.message}`);
      }
      writeFileSync(target, entry.data, { mode: entry.mode & 0o111 ? 0o755 : 0o644 });
    }
    stagedFiles += 1;
  }
  if (stagedFiles === 0) fail(`${archive} has no files/ payload files`);
  return destination;
}

function parseProperties(data, label) {
  const properties = new Map();
  for (const [index, raw] of data.toString("utf8").split(/\r?\n/u).entries()) {
    if (!raw) continue;
    const separator = raw.indexOf("=");
    if (separator <= 0) fail(`${label} has malformed properties line ${index + 1}`);
    const key = raw.slice(0, separator);
    if (properties.has(key)) fail(`${label} repeats property ${key}`);
    properties.set(key, raw.slice(separator + 1));
  }
  return properties;
}

function requireExactProperties(properties, expected, label) {
  const actual = [...properties.keys()].sort(compareText);
  const wanted = [...expected].sort(compareText);
  if (actual.join("\0") !== wanted.join("\0")) {
    fail(`${label} property fields must be exactly ${wanted.join(",")}; got ${actual.join(",")}`);
  }
}

function parseTsv(file) {
  const lines = readFileSync(file, "utf8").split(/\r?\n/u).filter(Boolean);
  if (lines.length < 2) fail(`${file} has no artifact rows`);
  const header = lines[0].split("\t");
  const expectedHeader = NATIVE_EXTENSION_ASSET_INDEX_HEADER;
  if (header.join("\t") !== expectedHeader.join("\t")) fail(`${file} has a non-canonical header`);
  return lines.slice(1).map((line, index) => {
    const fields = line.split("\t");
    if (fields.length !== header.length) fail(`${file} row ${index + 2} has ${fields.length} fields`);
    return Object.fromEntries(header.map((column, fieldIndex) => [column, fields[fieldIndex]]));
  });
}

function canonicalExtensions(selectionCsv) {
  const metadataFile = path.join(ROOT, "src/extensions/generated/sdk/rust.json");
  const metadata = JSON.parse(readFileSync(metadataFile, "utf8"));
  const byName = new Map((metadata.extensions ?? []).map((row) => [row["sql-name"], row]));
  const canonicalNames = exactExtensionProducts(PREFIX)
    .flatMap((product) => extensionSqlNames(product, PREFIX))
    .sort(compareText);
  if (canonicalNames.length === 0 || new Set(canonicalNames).size !== canonicalNames.length) {
    fail("canonical exact-extension products must resolve to a nonempty unique SQL-name set");
  }
  const names = selectionCsv.split(",").filter(Boolean).sort(compareText);
  if (names.length === 0 || new Set(names).size !== names.length) {
    fail("planned native lifecycle extension selection must be nonempty and unique");
  }
  const canonicalSet = new Set(canonicalNames);
  const unknown = names.filter((name) => !canonicalSet.has(name));
  if (unknown.length > 0) fail(`planned native lifecycle selection contains unknown extensions: ${unknown.join(",")}`);
  const rows = names.map((name) => {
    const row = byName.get(name);
    if (!row || row["desktop-release-ready"] !== true) fail(`generated Rust metadata is not release-ready for ${name}`);
    return row;
  });
  const selectedSet = new Set(names);
  for (const row of rows) {
    const missing = (row["selected-extension-dependencies"] ?? [])
      .filter((dependency) => !selectedSet.has(dependency));
    if (missing.length > 0) {
      fail(`${row["sql-name"]} planned native lifecycle selection omits dependencies: ${missing.join(",")}`);
    }
  }
  return rows;
}

function requireArchiveFile(entries, name, archive) {
  const entry = entries.get(name);
  if (!entry || entry.isDirectory || entry.data.length === 0) fail(`${archive} is missing non-empty ${name}`);
  return entry;
}

export function selectedExtensionDependencies(metadata) {
  const selected = metadata?.["selected-extension-dependencies"];
  if (!Array.isArray(selected) || selected.some((name) => typeof name !== "string" || name.length === 0)) {
    fail("generated extension metadata has invalid selected-extension-dependencies");
  }
  const sorted = [...selected].sort(compareText);
  if (new Set(sorted).size !== sorted.length) {
    fail("generated extension metadata repeats a selected extension dependency");
  }
  return sorted.join(",");
}

function stageBaseRuntime(runtimeAssets, output, extensionRows) {
  const version = currentProductVersionSync("liboliphaunt-native", PREFIX);
  const runtimeArchive = oneFile(runtimeAssets, `liboliphaunt-${version}-${TARGET}.tar.gz`);
  const toolsArchive = oneFile(runtimeAssets, `oliphaunt-tools-${version}-${TARGET}.tar.gz`);
  const runtimeEntries = readCanonicalTarGz(runtimeArchive);
  const toolsEntries = readCanonicalTarGz(toolsArchive);
  for (const required of [
    "lib/liboliphaunt.so",
    "lib/modules/plpgsql.so",
    ...requiredRuntimeMemberPaths(TARGET, "runtime/bin"),
  ]) requireArchiveFile(runtimeEntries, required, runtimeArchive);
  for (const required of requiredToolsMemberPaths(TARGET, "runtime/bin")) {
    requireArchiveFile(toolsEntries, required, toolsArchive);
  }
  for (const row of extensionRows) {
    const sqlName = row["sql-name"];
    if (runtimeEntries.has(`runtime/share/postgresql/extension/${sqlName}.control`)) {
      fail(`base runtime artifact leaks optional extension ${sqlName}`);
    }
  }
  extract(runtimeEntries, path.join(output, "resources/native-runtime/liboliphaunt-native"));
  extract(toolsEntries, path.join(output, "resources/native-tools/oliphaunt-tools"));
  assertExactFiles(runtimeAssets, [runtimeArchive, toolsArchive], "Linux runtime artifact download");
  return [
    artifactRecord("native-runtime", runtimeArchive),
    artifactRecord("native-tools", toolsArchive),
  ];
}

function stageBroker(brokerAssets, output) {
  const version = currentProductVersionSync("oliphaunt-broker", PREFIX);
  const archive = oneFile(brokerAssets, `oliphaunt-broker-${version}-${TARGET}.tar.gz`);
  const checksum = oneFile(brokerAssets, `oliphaunt-broker-${version}-release-assets.sha256`);
  const checksumLines = readFileSync(checksum, "utf8").split(/\r?\n/u).filter(Boolean);
  if (checksumLines.length !== 1) fail(`${checksum} must cover exactly the one partial Linux broker artifact`);
  const checksumMatch = checksumLines[0].match(/^([0-9a-f]{64})\s+\.\/(.+)$/u);
  if (!checksumMatch || checksumMatch[2] !== path.basename(archive)) {
    fail(`${checksum} does not bind the exact Linux broker artifact`);
  }
  const actualBrokerSha = artifactRecord("broker", archive).sha256;
  if (checksumMatch[1] !== actualBrokerSha) fail(`${checksum} digest does not match ${archive}`);
  const entries = readCanonicalTarGz(archive);
  const binary = requireArchiveFile(entries, "bin/oliphaunt-broker", archive);
  if ((binary.mode & 0o111) === 0) fail(`${archive} broker is not executable`);
  const manifest = parseProperties(requireArchiveFile(entries, "manifest.properties", archive).data, archive);
  for (const [key, expected] of [
    ["schema", "oliphaunt-broker-release-assets-v1"],
    ["product", "oliphaunt-broker"],
    ["version", version],
    ["target", TARGET],
    ["binary", "bin/oliphaunt-broker"],
  ]) {
    if (manifest.get(key) !== expected) fail(`${archive} ${key} must be ${expected}`);
  }
  extract(entries, path.join(output, "broker"));
  assertExactFiles(brokerAssets, [archive, checksum], "Linux broker artifact download");
  return [artifactRecord("broker", archive), artifactRecord("broker-checksum", checksum)];
}

function stageExtensions(extensionAssets, output, extensionRows) {
  const version = currentProductVersionSync("liboliphaunt-native", PREFIX);
  const index = oneFile(extensionAssets, `liboliphaunt-${version}-native-extension-assets.tsv`);
  const rows = parseTsv(index);
  const expectedNames = extensionRows.map((row) => row["sql-name"]).sort(compareText);
  const actualNames = rows.map((row) => row.sql_name).sort(compareText);
  if (rows.length !== expectedNames.length || new Set(actualNames).size !== rows.length) {
    fail(`native extension artifact index must contain ${expectedNames.length} unique rows, got ${rows.length}`);
  }
  if (actualNames.join("\0") !== expectedNames.join("\0")) {
    fail(`native extension artifact index drift: expected=${expectedNames.join(",")}; actual=${actualNames.join(",")}`);
  }
  const metadataByName = new Map(extensionRows.map((row) => [row["sql-name"], row]));
  const referenced = new Set();
  const consumed = [artifactRecord("native-extension-index", index)];
  for (const row of rows) {
    if (!isCanonicalNativeExtensionRuntimeIndexRow(row, TARGET)) {
      fail(`native extension artifact index has invalid carrier row for ${row.sql_name}`);
    }
    if (!/^[1-9][0-9]*$/u.test(row.artifact_bytes)) fail(`invalid artifact byte count for ${row.sql_name}`);
    const archive = path.resolve(path.dirname(index), row.artifact);
    const relative = path.relative(path.dirname(index), archive);
    if (relative.startsWith("..") || path.isAbsolute(relative)) fail(`artifact path escapes index for ${row.sql_name}`);
    if (statSync(archive).size !== Number(row.artifact_bytes)) fail(`artifact byte count drift for ${row.sql_name}`);
    referenced.add(archive);
    consumed.push(artifactRecord(`native-extension:${row.sql_name}`, archive));
    const entries = readCanonicalTarGz(archive);
    const manifest = parseProperties(requireArchiveFile(entries, "manifest.properties", archive).data, archive);
    requireExactProperties(manifest, EXTENSION_ARTIFACT_PROPERTY_KEYS, archive);
    const metadata = metadataByName.get(row.sql_name);
    const expectedDependencies = selectedExtensionDependencies(metadata);
    for (const [key, expected] of [
      ["packageLayout", "oliphaunt-extension-artifact-v1"],
      ["pgMajor", "18"],
      ["sqlName", row.sql_name],
      ["createsExtension", metadata["creates-extension"] === true ? "yes" : "no"],
      ["nativeModuleStem", metadata["native-module-stem"] ?? ""],
      ["nativeTarget", TARGET],
      ["nativeRuntimeProduct", "liboliphaunt-native"],
      ["nativeRuntimeVersion", version],
      ["dependencies", expectedDependencies],
      ["dataFiles", (metadata["runtime-share-data-files"] ?? []).join(",")],
      ["extensionSqlFileNames", (metadata["extension-sql-file-names"] ?? []).join(",")],
      ["extensionSqlFilePrefixes", (metadata["extension-sql-file-prefixes"] ?? []).join(",")],
      ["sharedPreloadLibraries", (metadata["shared-preload-libraries"] ?? []).join(",")],
      ["files", "files"],
    ]) {
      if (manifest.get(key) !== expected) fail(`${archive} ${key} must be ${expected}`);
    }
    if (!new Set(["yes", "no"]).has(manifest.get("mobilePrebuilt"))) {
      fail(`${archive} mobilePrebuilt must be yes or no`);
    }
    if (metadata["creates-extension"] === true) {
      const controlName = `files/share/postgresql/extension/${row.sql_name}.control`;
      const control = requireArchiveFile(entries, controlName, archive);
      const sqlPrefix = "files/share/postgresql/extension/";
      const sqlFileNames = [...entries.keys()]
        .filter((name) => name.startsWith(sqlPrefix) && !entries.get(name).isDirectory)
        .map((name) => name.slice(sqlPrefix.length));
      if (!sqlFileNames.some((name) => isCanonicalExtensionInstallSql(name, row.sql_name))) {
        fail(`${archive} has no canonical base install SQL for ${row.sql_name}`);
      }
      validateExtensionInstallSqlReachability({
        sqlName: row.sql_name,
        control: control.data.toString("utf8"),
        fileNames: sqlFileNames,
        label: archive,
      });
    }
    const stem = metadata["native-module-stem"];
    const expectedModuleFile = stem === null ? "" : `${stem}.so`;
    if (manifest.get("nativeModuleFile") !== expectedModuleFile) {
      fail(`${archive} nativeModuleFile must be ${expectedModuleFile}`);
    }
    if (expectedModuleFile !== "") {
      requireArchiveFile(entries, `files/lib/postgresql/${expectedModuleFile}`, archive);
    }
    stageExtensionCarrier(entries, output, metadata, archive);
  }
  const unreferenced = regularFiles(path.dirname(index))
    .filter((file) => file.endsWith(".tar.gz") && !referenced.has(file))
    .map((file) => path.basename(file));
  if (unreferenced.length > 0) fail(`unindexed native extension artifacts: ${unreferenced.join(",")}`);
  const legacyIndex = oneFile(
    extensionAssets,
    `liboliphaunt-${version}-extension-assets.tsv`,
  );
  consumed.push(artifactRecord("native-extension-legacy-index", legacyIndex));
  assertExactFiles(
    extensionAssets,
    [index, legacyIndex, ...referenced],
    "Linux exact-extension artifact download",
  );
  return consumed;
}

export function stageNativeExtensionLifecycle(args) {
  if (!/^[0-9a-f]{40}$/u.test(args["candidate-sha"])) fail("--candidate-sha must be a full 40-character Git object ID");
  if (!/^[0-9a-f]{40}$/u.test(args["candidate-tree"])) fail("--candidate-tree must be a full 40-character Git tree ID");
  const extensionRows = canonicalExtensions(args["extensions-csv"]);
  rmSync(args.output, { force: true, recursive: true });
  mkdirSync(args.output, { recursive: true });
  const consumedArtifacts = [
    ...stageBaseRuntime(args["runtime-assets"], args.output, extensionRows),
    ...stageBroker(args["broker-assets"], args.output),
    ...stageExtensions(args["extension-assets"], args.output, extensionRows),
    artifactRecord("native-extension-proof-runner", args["proof-runner"]),
  ].sort((left, right) => compareText(left.identity, right.identity));
  const evidenceCore = {
    schema: "oliphaunt-native-extension-lifecycle-inputs-v1",
    candidateSha: args["candidate-sha"],
    candidateTree: args["candidate-tree"],
    target: TARGET,
    extensionCount: extensionRows.length,
    extensions: extensionRows.map((row) => row["sql-name"]).sort(compareText),
    modes: ["direct", "broker", "server"],
    lifecycle: ["install", "load", "restart", "backup", "restore"],
    consumedArtifacts,
  };
  const evidence = {
    ...evidenceCore,
    inputEnvelopeSha256: sha256Bytes(Buffer.from(JSON.stringify(evidenceCore))),
  };
  writeFileSync(path.join(args.output, "inputs.json"), `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`native extension lifecycle inputs staged: ${args.output} (${extensionRows.length} extensions)`);
}

if (import.meta.main) {
  try {
    stageNativeExtensionLifecycle(parseArgs(Bun.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
