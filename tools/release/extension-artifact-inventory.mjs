import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { TextDecoder } from "node:util";

import { EXTENSION_ARTIFACT_ARCHIVE_POLICY } from "./extension-artifact-archive-policy.mjs";

export const EXTENSION_ARTIFACT_PROPERTY_KEYS = Object.freeze([
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

const PORTABLE_ID = /^[A-Za-z0-9._-]{1,128}$/u;
const C_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const {
  maxCompressedBytes: MAX_COMPRESSED_ARCHIVE_BYTES,
  maxExpandedBytes: MAX_EXPANDED_ARCHIVE_BYTES,
  maxMemberBytes: MAX_ARCHIVE_MEMBER_BYTES,
  maxMembers: MAX_ARCHIVE_MEMBERS,
} = EXTENSION_ARTIFACT_ARCHIVE_POLICY;
const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const DESKTOP_NATIVE_TARGETS = new Set([
  "linux-x64-gnu",
  "linux-arm64-gnu",
  "macos-arm64",
  "windows-x64-msvc",
]);
const BOUNDED_GUNZIP = path.join(import.meta.dirname, "bounded-gunzip-to-file.mjs");

function inventoryError(label, message) {
  return new Error(`${label}: ${message}`);
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function safeRelativePath(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw inventoryError(label, "must be a non-empty relative path");
  }
  if (value.includes("\\") || value !== value.normalize("NFC") || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw inventoryError(label, "must use NFC UTF-8 text without backslashes or control characters");
  }
  const parts = value.split("/");
  if (
    value.startsWith("/")
    || /^[A-Za-z]:/u.test(value)
    || parts.some((part) => part.length === 0 || part === "." || part === "..")
  ) {
    throw inventoryError(label, `must be a canonical relative path; got ${JSON.stringify(value)}`);
  }
  return parts.join("/");
}

function csv(value, label, { paths = false } = {}) {
  if (typeof value !== "string") throw inventoryError(label, "must be a string");
  if (value.length === 0) return [];
  const rows = value.split(",").map((row, index) => {
    if (row.length === 0 || row.trim() !== row) {
      throw inventoryError(label, `contains a malformed item at index ${index}`);
    }
    return paths ? safeRelativePath(row, `${label}[${index}]`) : row;
  });
  if (new Set(rows).size !== rows.length) throw inventoryError(label, "must not contain duplicates");
  const sorted = [...rows].sort(compareText);
  if (JSON.stringify(rows) !== JSON.stringify(sorted)) {
    throw inventoryError(label, "must be sorted deterministically");
  }
  return rows;
}

export function parseExtensionArtifactProperties(text, label) {
  if (
    typeof text !== "string"
    || text.startsWith("\uFEFF")
    || text.includes("\r")
    || text.includes("\\")
    || text !== text.normalize("NFC")
    || /[\u0000-\u0009\u000b-\u001f\u007f]/u.test(text)
    || !text.endsWith("\n")
    || text.endsWith("\n\n")
  ) {
    throw inventoryError(
      label,
      "must be canonical NFC UTF-8 key=value text with LF lines and exactly one final newline",
    );
  }
  const properties = new Map();
  const lines = text.slice(0, -1).split("\n");
  for (const [index, rawLine] of lines.entries()) {
    if (rawLine.length === 0) {
      throw inventoryError(label, `has an internal blank line at ${index + 1}`);
    }
    const separator = rawLine.indexOf("=");
    if (separator <= 0 || rawLine.trim() !== rawLine) {
      throw inventoryError(label, `has malformed properties line ${index + 1}`);
    }
    const key = rawLine.slice(0, separator);
    if (properties.has(key)) {
      throw inventoryError(label, `repeats property ${key}`);
    }
    properties.set(key, rawLine.slice(separator + 1));
  }
  const actual = [...properties.keys()].sort(compareText);
  const expected = [...EXTENSION_ARTIFACT_PROPERTY_KEYS].sort(compareText);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw inventoryError(
      label,
      `property fields must be exactly ${expected.join(",")}; got ${actual.join(",")}`,
    );
  }
  if (JSON.stringify([...properties.keys()]) !== JSON.stringify(EXTENSION_ARTIFACT_PROPERTY_KEYS)) {
    throw inventoryError(label, "properties must use the canonical field order");
  }
  return properties;
}

function decodeUtf8(bytes, label) {
  try {
    return UTF8.decode(bytes);
  } catch (error) {
    throw inventoryError(label, `contains invalid UTF-8: ${error.message}`);
  }
}

function tarString(buffer, offset, length, label, field) {
  const bytes = buffer.subarray(offset, offset + length);
  const end = bytes.indexOf(0);
  if (end >= 0 && !bytes.subarray(end).every((byte) => byte === 0)) {
    throw inventoryError(label, `tar ${field} has nonzero bytes after its terminator`);
  }
  return decodeUtf8(
    bytes.subarray(0, end < 0 ? bytes.length : end),
    `${label} tar ${field}`,
  );
}

function canonicalTarOctal(length, value) {
  return Buffer.from(`${value.toString(8).padStart(length - 1, "0")}\0`, "ascii");
}

function tarOctal(buffer, offset, length, label, field) {
  if (field === "checksum") {
    const bytes = buffer.subarray(offset, offset + length);
    if (length !== 8 || bytes[6] !== 0 || bytes[7] !== 0x20) {
      throw inventoryError(label, "has noncanonical tar checksum encoding");
    }
    const digits = decodeUtf8(bytes.subarray(0, 6), `${label} tar checksum`);
    if (!/^[0-7]{6}$/u.test(digits)) {
      throw inventoryError(label, `has invalid tar checksum field ${JSON.stringify(digits)}`);
    }
    return Number.parseInt(digits, 8);
  }
  const value = tarString(buffer, offset, length, label, field).trim();
  if (!/^[0-7]+$/u.test(value)) {
    throw inventoryError(label, `has invalid tar ${field} field ${JSON.stringify(value)}`);
  }
  const parsed = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw inventoryError(label, `has out-of-range tar ${field}`);
  }
  return parsed;
}

function readExact(descriptor, position, length, label) {
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const bytes = readSync(descriptor, buffer, offset, length - offset, position + offset);
    if (bytes === 0) throw inventoryError(label, "tar stream ended unexpectedly");
    offset += bytes;
  }
  return buffer;
}

function writeAll(descriptor, buffer, label) {
  let offset = 0;
  while (offset < buffer.length) {
    const bytes = writeSync(descriptor, buffer, offset, buffer.length - offset);
    if (bytes <= 0) throw inventoryError(label, "failed to snapshot the carrier bytes");
    offset += bytes;
  }
}

function rangeIsZero(descriptor, position, length, label) {
  const buffer = Buffer.alloc(Math.min(64 * 1024, Math.max(length, 1)));
  let checked = 0;
  while (checked < length) {
    const wanted = Math.min(buffer.length, length - checked);
    const bytes = readSync(descriptor, buffer, 0, wanted, position + checked);
    if (bytes !== wanted) throw inventoryError(label, "tar stream ended unexpectedly");
    if (!buffer.subarray(0, bytes).every((byte) => byte === 0)) return false;
    checked += bytes;
  }
  return true;
}

function canonicalTarPathParts(archiveName, label) {
  if (Buffer.byteLength(archiveName) <= 100) {
    return { name: archiveName, prefix: "" };
  }
  const parts = archiveName.split("/");
  for (let index = 1; index < parts.length; index += 1) {
    const prefix = parts.slice(0, index).join("/");
    const name = parts.slice(index).join("/");
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) {
      return { name, prefix };
    }
  }
  throw inventoryError(label, `member ${archiveName} cannot use the canonical producer ustar split`);
}

function validateCanonicalHeader(header, label, block, collisionNames, entries) {
  const storedChecksum = tarOctal(header, 148, 8, label, "checksum");
  const checksumHeader = Buffer.from(header);
  checksumHeader.fill(0x20, 148, 156);
  const actualChecksum = checksumHeader.reduce((sum, byte) => sum + byte, 0);
  if (storedChecksum !== actualChecksum) {
    throw inventoryError(label, `has a tar header checksum mismatch at block ${block}`);
  }
  if (tarString(header, 257, 6, label, "magic") !== "ustar") {
    throw inventoryError(label, "must use canonical ustar headers");
  }
  const name = tarString(header, 0, 100, label, "name");
  const prefix = tarString(header, 345, 155, label, "prefix");
  const archiveName = safeRelativePath(prefix ? `${prefix}/${name}` : name, `${label} tar member`);
  const canonicalPath = canonicalTarPathParts(archiveName, label);
  if (name !== canonicalPath.name || prefix !== canonicalPath.prefix) {
    throw inventoryError(
      label,
      `member ${archiveName} must use canonical ustar name/prefix split ${JSON.stringify(canonicalPath)}`,
    );
  }
  const collisionKey = archiveName.normalize("NFC").toLowerCase();
  const collision = collisionNames.get(collisionKey);
  if (collision !== undefined && collision !== archiveName) {
    throw inventoryError(label, `contains case/NFC-colliding members ${collision} and ${archiveName}`);
  }
  collisionNames.set(collisionKey, archiveName);
  if (header[156] !== 0x30) {
    throw inventoryError(label, `member ${archiveName} must be a regular file`);
  }
  const mode = tarOctal(header, 100, 8, label, "mode");
  const uid = tarOctal(header, 108, 8, label, "uid");
  const gid = tarOctal(header, 116, 8, label, "gid");
  const size = tarOctal(header, 124, 12, label, "size");
  const mtime = tarOctal(header, 136, 12, label, "mtime");
  if (size > MAX_ARCHIVE_MEMBER_BYTES) {
    throw inventoryError(label, `member ${archiveName} exceeds ${MAX_ARCHIVE_MEMBER_BYTES} bytes`);
  }
  if (![0o644, 0o755].includes(mode) || uid !== 0 || gid !== 0 || mtime !== 0) {
    throw inventoryError(
      label,
      `member ${archiveName} must use mode 0644/0755, uid=0, gid=0 and mtime=0`,
    );
  }
  for (const [field, offset, length, value] of [
    ["mode", 100, 8, mode],
    ["uid", 108, 8, uid],
    ["gid", 116, 8, gid],
    ["size", 124, 12, size],
    ["mtime", 136, 12, mtime],
  ]) {
    if (!header.subarray(offset, offset + length).equals(canonicalTarOctal(length, value))) {
      throw inventoryError(label, `member ${archiveName} has noncanonical tar ${field} encoding`);
    }
  }
  if (
    !header.subarray(148, 156).equals(
      Buffer.from(`${storedChecksum.toString(8).padStart(6, "0")}\0 `, "ascii"),
    )
    || !header.subarray(157, 257).every((byte) => byte === 0)
    || !header.subarray(257, 263).equals(Buffer.from("ustar\0", "ascii"))
    || !header.subarray(263, 265).equals(Buffer.from("00", "ascii"))
    || tarString(header, 265, 32, label, "uname") !== "root"
    || tarString(header, 297, 32, label, "gname") !== "root"
    || !header.subarray(329, 345).every((byte) => byte === 0)
    || !header.subarray(500, 512).every((byte) => byte === 0)
  ) {
    throw inventoryError(label, `member ${archiveName} does not use the canonical producer ustar header`);
  }
  if (entries.has(archiveName)) {
    throw inventoryError(label, `contains duplicate member ${archiveName}`);
  }
  return { archiveName, mode, size };
}

/** Read exactly the bounded deterministic gzip+ustar emitted by extension-artifact-packager.mjs. */
export function readCanonicalExtensionArtifactArchive(file, label = file) {
  const carrierMetadata = lstatSync(file, { bigint: true });
  if (carrierMetadata.isSymbolicLink() || !carrierMetadata.isFile()) {
    throw inventoryError(label, "carrier input must be a regular non-symlink file");
  }
  const temporary = mkdtempSync(path.join(os.tmpdir(), "oliphaunt-extension-archive-"));
  const compressedSnapshot = path.join(temporary, "carrier.tar.gz");
  const expanded = path.join(temporary, "archive.tar");
  try {
    let compressedDescriptor;
    let snapshotDescriptor;
    let gzipHeader;
    let compressedBytes;
    try {
      compressedDescriptor = openSync(
        file,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
      const opened = fstatSync(compressedDescriptor, { bigint: true });
      if (
        !opened.isFile()
        || opened.dev !== carrierMetadata.dev
        || opened.ino !== carrierMetadata.ino
      ) {
        throw inventoryError(label, "carrier changed between path inspection and no-follow open");
      }
      compressedBytes = Number(opened.size);
      if (
        !Number.isSafeInteger(compressedBytes)
        || compressedBytes === 0
        || compressedBytes > MAX_COMPRESSED_ARCHIVE_BYTES
      ) {
        throw inventoryError(
          label,
          `archive bytes must be between 1 and ${MAX_COMPRESSED_ARCHIVE_BYTES}`,
        );
      }
      gzipHeader = readExact(compressedDescriptor, 0, 10, label);
      snapshotDescriptor = openSync(
        compressedSnapshot,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      const buffer = Buffer.alloc(256 * 1024);
      let position = 0;
      while (position < compressedBytes) {
        const wanted = Math.min(buffer.length, compressedBytes - position);
        const bytes = readSync(compressedDescriptor, buffer, 0, wanted, position);
        if (bytes !== wanted) {
          throw inventoryError(label, "carrier changed or ended while taking its private snapshot");
        }
        writeAll(snapshotDescriptor, buffer.subarray(0, bytes), label);
        position += bytes;
      }
      const after = fstatSync(compressedDescriptor, { bigint: true });
      if (
        !after.isFile()
        || after.dev !== opened.dev
        || after.ino !== opened.ino
        || after.size !== opened.size
        || after.mtimeNs !== opened.mtimeNs
        || after.ctimeNs !== opened.ctimeNs
      ) {
        throw inventoryError(label, "carrier metadata changed while taking its private snapshot");
      }
    } finally {
      if (snapshotDescriptor !== undefined) closeSync(snapshotDescriptor);
      if (compressedDescriptor !== undefined) closeSync(compressedDescriptor);
    }
    if (
      gzipHeader[0] !== 0x1f
      || gzipHeader[1] !== 0x8b
      || gzipHeader[2] !== 8
      || gzipHeader[3] !== 0
      || !gzipHeader.subarray(4, 8).every((byte) => byte === 0)
      || gzipHeader[8] !== 0
      || gzipHeader[9] !== 0x03
    ) {
      throw inventoryError(label, "must use the canonical Bun gzip header");
    }
    if (statSync(compressedSnapshot).size !== compressedBytes) {
      throw inventoryError(label, "private carrier snapshot has the wrong byte count");
    }
    const result = spawnSync(
      process.execPath,
      [BOUNDED_GUNZIP, compressedSnapshot, expanded, String(MAX_EXPANDED_ARCHIVE_BYTES)],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1024 * 1024 },
    );
    if (result.error) {
      throw inventoryError(label, `bounded gzip reader failed to start: ${result.error.message}`);
    }
    if (result.status !== 0) {
      const detail = String(result.stderr || result.stdout || "").trim();
      throw inventoryError(label, `is not a valid bounded gzip stream${detail ? `: ${detail}` : ""}`);
    }
    const expandedBytes = statSync(expanded).size;
    if (
      expandedBytes < 1024
      || expandedBytes > MAX_EXPANDED_ARCHIVE_BYTES
      || expandedBytes % 512 !== 0
    ) {
      throw inventoryError(label, "must contain a bounded block-aligned ustar stream");
    }
    const entries = new Map();
    const collisionNames = new Map();
    let descriptor;
    let offset = 0;
    let ended = false;
    try {
      descriptor = openSync(expanded, "r");
      while (offset < expandedBytes) {
        const header = readExact(descriptor, offset, 512, label);
        if (header.every((byte) => byte === 0)) {
          if (
            expandedBytes - offset !== 1024
            || !rangeIsZero(descriptor, offset, 1024, label)
          ) {
            throw inventoryError(label, "tar end marker or trailing padding is not canonical");
          }
          ended = true;
          break;
        }
        const { archiveName, mode, size } = validateCanonicalHeader(
          header,
          label,
          offset / 512,
          collisionNames,
          entries,
        );
        const dataStart = offset + 512;
        const dataEnd = dataStart + size;
        const paddedEnd = dataStart + Math.ceil(size / 512) * 512;
        if (dataEnd > expandedBytes || paddedEnd > expandedBytes) {
          throw inventoryError(label, `member ${archiveName} exceeds the tar stream`);
        }
        const data = readExact(descriptor, dataStart, size, label);
        if (!rangeIsZero(descriptor, dataEnd, paddedEnd - dataEnd, label)) {
          throw inventoryError(label, `member ${archiveName} has nonzero tar padding`);
        }
        entries.set(archiveName, {
          bytes: data.length,
          data,
          mode,
          sha256: createHash("sha256").update(data).digest("hex"),
        });
        if (entries.size > MAX_ARCHIVE_MEMBERS) {
          throw inventoryError(label, `contains more than ${MAX_ARCHIVE_MEMBERS} members`);
        }
        offset = paddedEnd;
      }
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
    if (!ended || entries.size === 0) {
      throw inventoryError(label, "must contain regular files and a canonical tar end marker");
    }
    const names = [...entries.keys()];
    if (JSON.stringify(names) !== JSON.stringify([...names].sort(compareText))) {
      throw inventoryError(label, "tar members must be sorted deterministically");
    }
    return entries;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

function normalizeMetadata(row, label) {
  const sqlName = row?.sqlName ?? row?.["sql-name"];
  if (typeof sqlName !== "string" || !PORTABLE_ID.test(sqlName)) {
    throw inventoryError(label, "has an invalid sqlName");
  }
  const list = (camel, kebab, explicitValue = undefined) => {
    const value = explicitValue ?? row?.[camel] ?? row?.[kebab];
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
      throw inventoryError(label, `${kebab} must be a string array`);
    }
    const sorted = [...value].sort(compareText);
    if (new Set(sorted).size !== sorted.length) {
      throw inventoryError(label, `${kebab} must not contain duplicates`);
    }
    return sorted;
  };
  const nativeModuleStem = row?.nativeModuleStem ?? row?.["native-module-stem"] ?? null;
  if (nativeModuleStem !== null && (typeof nativeModuleStem !== "string" || !PORTABLE_ID.test(nativeModuleStem))) {
    throw inventoryError(label, "native-module-stem must be null or a portable identifier");
  }
  const createsExtension = row?.createsExtension ?? row?.["creates-extension"];
  if (typeof createsExtension !== "boolean") {
    throw inventoryError(label, "creates-extension must be boolean");
  }
  const metadata = {
    sqlName,
    createsExtension,
    nativeModuleStem,
    dependencies: (() => {
      const selected = row?.selectedExtensionDependencies
        ?? row?.["selected-extension-dependencies"]
        ?? row?.dependencies;
      return list("selectedExtensionDependencies", "selected-extension-dependencies", selected);
    })(),
    dataFiles: list(
      "runtimeShareDataFiles",
      "runtime-share-data-files",
      row?.runtimeShareDataFiles ?? row?.["runtime-share-data-files"] ?? row?.dataFiles,
    ).map((item, index) =>
      safeRelativePath(item, `${label}.runtime-share-data-files[${index}]`)),
    extensionSqlFileNames: list("extensionSqlFileNames", "extension-sql-file-names"),
    extensionSqlFilePrefixes: list("extensionSqlFilePrefixes", "extension-sql-file-prefixes"),
    sharedPreloadLibraries: list("sharedPreloadLibraries", "shared-preload-libraries"),
  };
  for (const [field, values] of [
    ["selected-extension-dependencies", metadata.dependencies],
    ["shared-preload-libraries", metadata.sharedPreloadLibraries],
  ]) {
    if (values.some((item) => !PORTABLE_ID.test(item))) {
      throw inventoryError(label, `${field} contains a non-portable identifier`);
    }
  }
  if (
    metadata.extensionSqlFileNames.some(
      (item) => path.posix.basename(item) !== item || !item.endsWith(".sql"),
    )
  ) {
    throw inventoryError(label, "extension-sql-file-names must contain SQL basenames");
  }
  if (
    metadata.extensionSqlFilePrefixes.some(
      (item) => !PORTABLE_ID.test(item) || item.includes("."),
    )
  ) {
    throw inventoryError(label, "extension-sql-file-prefixes must contain portable basename prefixes");
  }
  return metadata;
}

function moduleSuffix(target) {
  if (target === "windows-x64-msvc") return ".dll";
  if (target === "macos-arm64" || target === "ios-xcframework") return ".dylib";
  return ".so";
}

function sqlFileOwned(fileName, metadata) {
  return (
    (metadata.createsExtension && fileName === `${metadata.sqlName}.control`)
    || (metadata.createsExtension && fileName === `${metadata.sqlName}.sql`)
    || (metadata.createsExtension && fileName.startsWith(`${metadata.sqlName}--`) && fileName.endsWith(".sql"))
    || metadata.extensionSqlFileNames.includes(fileName)
    || (fileName.endsWith(".sql")
      && metadata.extensionSqlFilePrefixes.some((prefix) => fileName.startsWith(prefix)))
  );
}

export function isCanonicalExtensionInstallSql(fileName, sqlName) {
  const prefix = `${sqlName}--`;
  if (!fileName.startsWith(prefix) || !fileName.endsWith(".sql")) return false;
  const version = fileName.slice(prefix.length, -".sql".length);
  return /^[0-9][A-Za-z0-9._-]*$/u.test(version) && !version.includes("--");
}

function extensionSqlVersion(value) {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value) && !value.includes("--");
}

export function extensionControlDefaultVersion(control, sqlName, label) {
  const values = [];
  for (const [index, raw] of control.split(/\r?\n/u).entries()) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    if (!/^default_version(?:\s|=)/u.test(line)) continue;
    const match = line.match(/^default_version\s*=\s*'([^']+)'\s*(?:#.*)?$/u);
    if (match === null || !extensionSqlVersion(match[1])) {
      throw inventoryError(label, `${sqlName}.control has invalid default_version on line ${index + 1}`);
    }
    values.push(match[1]);
  }
  if (values.length !== 1) {
    throw inventoryError(label, `${sqlName}.control must declare default_version exactly once`);
  }
  return values[0];
}

function canonicalInstallVersion(fileName, sqlName) {
  if (!isCanonicalExtensionInstallSql(fileName, sqlName)) return null;
  return fileName.slice(`${sqlName}--`.length, -".sql".length);
}

function canonicalUpdateEdge(fileName, sqlName) {
  const prefix = `${sqlName}--`;
  if (!fileName.startsWith(prefix) || !fileName.endsWith(".sql")) return null;
  const versions = fileName.slice(prefix.length, -".sql".length).split("--");
  if (versions.length !== 2 || !versions.every(extensionSqlVersion)) return null;
  return versions;
}

/** Prove that PostgreSQL can install the control file's default version. */
export function validateExtensionInstallSqlReachability({ sqlName, control, fileNames, label }) {
  const defaultVersion = extensionControlDefaultVersion(control, sqlName, label);
  const installVersions = new Set();
  const updateTargets = new Map();
  for (const fileName of [...new Set(fileNames)].sort(compareText)) {
    const installVersion = canonicalInstallVersion(fileName, sqlName);
    if (installVersion !== null) installVersions.add(installVersion);
    const edge = canonicalUpdateEdge(fileName, sqlName);
    if (edge !== null) {
      const [from, to] = edge;
      const targets = updateTargets.get(from) ?? new Set();
      targets.add(to);
      updateTargets.set(from, targets);
    }
  }
  if (installVersions.has(defaultVersion)) return;

  const reachable = new Set(installVersions);
  const pending = [...installVersions].sort(compareText);
  for (let index = 0; index < pending.length; index += 1) {
    const current = pending[index];
    for (const next of [...(updateTargets.get(current) ?? [])].sort(compareText)) {
      if (reachable.has(next)) continue;
      reachable.add(next);
      pending.push(next);
    }
  }
  if (reachable.has(defaultVersion)) return;

  const updates = [...updateTargets]
    .flatMap(([from, targets]) => [...targets].map((to) => `${from}->${to}`))
    .sort(compareText);
  throw inventoryError(
    label,
    `${sqlName} default_version '${defaultVersion}' has no canonical installation script or update path; `
      + `install versions=${[...installVersions].sort(compareText).join(",") || "-"}; updates=${updates.join(",") || "-"}`,
  );
}

function declaredMobilePaths(properties, metadata, label) {
  const paths = [];
  const staticRows = csv(properties.get("mobileStaticArchives"), `${label} mobileStaticArchives`);
  for (const [index, row] of staticRows.entries()) {
    const separator = row.indexOf(":");
    if (separator <= 0 || metadata.nativeModuleStem === null) {
      throw inventoryError(label, `mobileStaticArchives[${index}] is malformed`);
    }
    const target = row.slice(0, separator);
    const member = safeRelativePath(row.slice(separator + 1), `${label} mobileStaticArchives[${index}]`);
    if (!PORTABLE_ID.test(target)) throw inventoryError(label, `mobile static target ${target} is invalid`);
    const expected = `mobile-static/${target}/extensions/${metadata.nativeModuleStem}/liboliphaunt_extension_${metadata.nativeModuleStem}.a`;
    if (member !== expected) {
      throw inventoryError(label, `mobile static member ${member} must be ${expected}`);
    }
    paths.push(member);
  }
  const dependencyRows = csv(
    properties.get("mobileStaticDependencyArchives"),
    `${label} mobileStaticDependencyArchives`,
  );
  for (const [index, row] of dependencyRows.entries()) {
    const first = row.indexOf(":");
    const second = row.indexOf(":", first + 1);
    if (first <= 0 || second <= first + 1) {
      throw inventoryError(label, `mobileStaticDependencyArchives[${index}] is malformed`);
    }
    const target = row.slice(0, first);
    const dependency = row.slice(first + 1, second);
    const member = safeRelativePath(
      row.slice(second + 1),
      `${label} mobileStaticDependencyArchives[${index}]`,
    );
    if (!PORTABLE_ID.test(target) || !PORTABLE_ID.test(dependency)) {
      throw inventoryError(label, `mobile static dependency identity ${target}:${dependency} is invalid`);
    }
    const prefix = `mobile-static/${target}/dependencies/${dependency}/`;
    if (!member.startsWith(prefix) || path.posix.basename(member) !== member.slice(prefix.length)) {
      throw inventoryError(label, `mobile static dependency member ${member} is not canonical`);
    }
    paths.push(member);
  }
  if (new Set(paths).size !== paths.length) {
    throw inventoryError(label, "mobile static archive paths must not repeat");
  }
  return paths;
}

function validateStaticLinkage(properties, metadata, target, label) {
  const prefix = properties.get("staticSymbolPrefix");
  if (prefix !== "" && !C_IDENTIFIER.test(prefix)) {
    throw inventoryError(label, "staticSymbolPrefix must be empty or a C identifier");
  }
  const aliases = csv(properties.get("staticSymbolAliases"), `${label} staticSymbolAliases`);
  const sqlSymbols = new Set();
  for (const [index, alias] of aliases.entries()) {
    const fields = alias.split(":");
    if (fields.length !== 2 || fields.some((field) => !C_IDENTIFIER.test(field))) {
      throw inventoryError(label, `staticSymbolAliases[${index}] must be a C-identifier pair`);
    }
    if (sqlSymbols.has(fields[0])) {
      throw inventoryError(label, `staticSymbolAliases repeats SQL-visible symbol ${fields[0]}`);
    }
    sqlSymbols.add(fields[0]);
  }
  if (DESKTOP_NATIVE_TARGETS.has(target) && (prefix !== "" || aliases.length !== 0)) {
    throw inventoryError(label, "desktop artifacts must not declare static symbol linkage");
  }
  if (metadata.nativeModuleStem === null && (prefix !== "" || aliases.length !== 0)) {
    throw inventoryError(label, "SQL-only artifacts must not declare static symbol linkage");
  }
}

/**
 * Validate both manifest semantics and the exact leaf inventory of a native extension artifact.
 * Returns the runtime `files/` rows used by npm staging.
 */
export function validateExtensionArtifactEntries({
  entries,
  metadata: rawMetadata,
  target,
  nativeRuntimeVersion,
  label,
}) {
  if (!DESKTOP_NATIVE_TARGETS.has(target)) {
    throw inventoryError(label, `native target ${JSON.stringify(target)} is not a canonical desktop target`);
  }
  if (typeof nativeRuntimeVersion !== "string" || !/^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u.test(nativeRuntimeVersion)) {
    throw inventoryError(label, "native runtime version must be stable SemVer X.Y.Z");
  }
  const metadata = normalizeMetadata(rawMetadata, `${label} canonical metadata`);
  const manifestEntry = entries.get("manifest.properties");
  if (manifestEntry === undefined) throw inventoryError(label, "is missing manifest.properties");
  const properties = parseExtensionArtifactProperties(
    decodeUtf8(manifestEntry.data, `${label} manifest.properties`),
    `${label} manifest.properties`,
  );
  const expectedProperties = new Map([
    ["packageLayout", "oliphaunt-extension-artifact-v1"],
    ["pgMajor", "18"],
    ["sqlName", metadata.sqlName],
    ["createsExtension", metadata.createsExtension ? "yes" : "no"],
    ["nativeModuleStem", metadata.nativeModuleStem ?? ""],
    ["nativeModuleFile", metadata.nativeModuleStem === null ? "" : `${metadata.nativeModuleStem}${moduleSuffix(target)}`],
    ["nativeTarget", target],
    ["nativeRuntimeProduct", "liboliphaunt-native"],
    ["nativeRuntimeVersion", nativeRuntimeVersion],
    ["dependencies", metadata.dependencies.join(",")],
    ["dataFiles", metadata.dataFiles.join(",")],
    ["extensionSqlFileNames", metadata.extensionSqlFileNames.join(",")],
    ["extensionSqlFilePrefixes", metadata.extensionSqlFilePrefixes.join(",")],
    ["sharedPreloadLibraries", metadata.sharedPreloadLibraries.join(",")],
    ["files", "files"],
  ]);
  for (const [key, expected] of expectedProperties) {
    if (properties.get(key) !== expected) {
      throw inventoryError(
        label,
        `manifest ${key} must be ${JSON.stringify(expected)}; got ${JSON.stringify(properties.get(key))}`,
      );
    }
  }
  if (!new Set(["yes", "no"]).has(properties.get("mobilePrebuilt"))) {
    throw inventoryError(label, "manifest mobilePrebuilt must be yes or no");
  }
  validateStaticLinkage(properties, metadata, target, label);

  const allowed = new Set(["manifest.properties"]);
  const extensionPrefix = "files/share/postgresql/extension/";
  let hasControl = false;
  let hasInstallSql = false;
  const extensionFileNames = [];
  for (const name of entries.keys()) {
    if (!name.startsWith(extensionPrefix)) continue;
    const fileName = name.slice(extensionPrefix.length);
    if (fileName.includes("/") || !sqlFileOwned(fileName, metadata)) {
      throw inventoryError(label, `contains undeclared extension SQL/control file ${name}`);
    }
    allowed.add(name);
    extensionFileNames.push(fileName);
    if (fileName === `${metadata.sqlName}.control`) hasControl = true;
    if (isCanonicalExtensionInstallSql(fileName, metadata.sqlName)) hasInstallSql = true;
  }
  if (metadata.createsExtension && (!hasControl || !hasInstallSql)) {
    throw inventoryError(label, `must contain ${metadata.sqlName}.control and canonical base installation SQL`);
  }
  if (metadata.createsExtension) {
    const controlName = `${extensionPrefix}${metadata.sqlName}.control`;
    validateExtensionInstallSqlReachability({
      sqlName: metadata.sqlName,
      control: decodeUtf8(entries.get(controlName).data, `${label} ${controlName}`),
      fileNames: extensionFileNames,
      label,
    });
  }
  for (const dataFile of metadata.dataFiles) {
    allowed.add(`files/share/postgresql/${dataFile}`);
  }
  if (metadata.nativeModuleStem !== null) {
    allowed.add(`files/lib/postgresql/${properties.get("nativeModuleFile")}`);
    if (DESKTOP_NATIVE_TARGETS.has(target)) {
      allowed.add(`files/lib/modules/${properties.get("nativeModuleFile")}`);
    }
  }
  const mobilePaths = declaredMobilePaths(properties, metadata, label);
  if (
    DESKTOP_NATIVE_TARGETS.has(target)
    && (properties.get("mobilePrebuilt") !== "no" || mobilePaths.length !== 0)
  ) {
    throw inventoryError(label, "desktop artifacts must not declare mobile prebuilt files");
  }
  for (const mobilePath of mobilePaths) {
    allowed.add(mobilePath);
  }
  const actual = [...entries.keys()].sort(compareText);
  const expected = [...allowed].sort(compareText);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    const undeclared = actual.filter((name) => !allowed.has(name));
    const missing = expected.filter((name) => !entries.has(name));
    throw inventoryError(
      label,
      `leaf inventory mismatch${undeclared.length ? `; undeclared: ${undeclared.join(",")}` : ""}`
        + `${missing.length ? `; missing: ${missing.join(",")}` : ""}`,
    );
  }
  const runtimeFiles = actual
    .filter((name) => name.startsWith("files/"))
    .map((name) => {
      const entry = entries.get(name);
      return {
        path: name.slice("files/".length),
        bytes: entry.bytes,
        sha256: entry.sha256,
      };
    });
  if (runtimeFiles.some((row) => !SHA256.test(row.sha256))) {
    throw inventoryError(label, "computed an invalid runtime file digest");
  }
  return { metadata, properties, runtimeFiles };
}

export function validateExtensionArtifactArchive(options) {
  const entries = readCanonicalExtensionArtifactArchive(options.file, options.label ?? options.file);
  return {
    entries,
    ...validateExtensionArtifactEntries({ ...options, entries, label: options.label ?? options.file }),
  };
}
