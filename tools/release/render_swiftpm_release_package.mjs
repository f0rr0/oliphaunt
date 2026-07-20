#!/usr/bin/env bun
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { gunzipSync, inflateRawSync } from "node:zlib";

import { currentVersion } from "./product-version.mjs";

const ROOT = path.resolve(import.meta.dir, "../..");
const REPOSITORY = "f0rr0/oliphaunt";
const decoder = new TextDecoder();
const MAX_REMOTE_CHECKSUM_MANIFEST_BYTES = 1024 * 1024;

function fail(message) {
  console.error(`render_swiftpm_release_package.mjs: ${message}`);
  process.exit(1);
}

async function fileStat(file) {
  return fs.stat(file).catch(() => null);
}

async function isFile(file) {
  const stat = await fileStat(file);
  return stat?.isFile() === true;
}

async function sha256(file) {
  return createHash("sha256").update(await fs.readFile(file)).digest("hex");
}

function checksumFromManifest(text, asset) {
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    const parts = line.split(/\s+/u);
    if (parts.length !== 2) {
      continue;
    }
    const [digest, filename] = parts;
    if (filename === `./${asset}` || filename === asset) {
      return digest;
    }
  }
  return undefined;
}

function readUInt16LE(buffer, offset) {
  if (offset < 0 || offset + 2 > buffer.length) {
    throw new Error("truncated ZIP archive");
  }
  return buffer.readUInt16LE(offset);
}

function readUInt32LE(buffer, offset) {
  if (offset < 0 || offset + 4 > buffer.length) {
    throw new Error("truncated ZIP archive");
  }
  return buffer.readUInt32LE(offset);
}

function requireZipSignature(buffer, offset, signature, label) {
  if (readUInt32LE(buffer, offset) !== signature) {
    throw new Error(`invalid ZIP ${label}`);
  }
}

function findEndOfCentralDirectory(buffer) {
  const minimumOffset = Math.max(0, buffer.length - 65_557);
  for (let offset = buffer.length - 22; offset >= minimumOffset; offset -= 1) {
    if (readUInt32LE(buffer, offset) === 0x06054b50) {
      return offset;
    }
  }
  throw new Error("ZIP end of central directory was not found");
}

function validateZipPath(entryName) {
  if (
    entryName.length === 0 ||
    entryName.includes("\0") ||
    entryName.startsWith("/") ||
    entryName.includes("\\")
  ) {
    throw new Error(`unsafe ZIP entry path: ${entryName}`);
  }
  const parts = [];
  for (const rawPart of entryName.split("/")) {
    if (rawPart.length === 0 || rawPart === ".") {
      continue;
    }
    if (rawPart === "..") {
      throw new Error(`unsafe ZIP entry path: ${entryName}`);
    }
    parts.push(rawPart);
  }
  return `${parts.join("/")}${entryName.endsWith("/") ? "/" : ""}`;
}

async function readZipArchive(file) {
  const buffer = await fs.readFile(file);
  const eocd = findEndOfCentralDirectory(buffer);
  const totalEntries = readUInt16LE(buffer, eocd + 10);
  const centralDirectorySize = readUInt32LE(buffer, eocd + 12);
  const centralDirectoryOffset = readUInt32LE(buffer, eocd + 16);
  if (
    totalEntries === 0xffff ||
    centralDirectorySize === 0xffffffff ||
    centralDirectoryOffset === 0xffffffff
  ) {
    throw new Error("ZIP64 archives are not supported by this release validator");
  }
  if (centralDirectoryOffset + centralDirectorySize > buffer.length) {
    throw new Error("ZIP central directory is outside archive bounds");
  }

  const entries = new Map();
  let offset = centralDirectoryOffset;
  for (let index = 0; index < totalEntries; index += 1) {
    requireZipSignature(buffer, offset, 0x02014b50, "central directory header");
    const method = readUInt16LE(buffer, offset + 10);
    const compressedSize = readUInt32LE(buffer, offset + 20);
    const uncompressedSize = readUInt32LE(buffer, offset + 24);
    const nameLength = readUInt16LE(buffer, offset + 28);
    const extraLength = readUInt16LE(buffer, offset + 30);
    const commentLength = readUInt16LE(buffer, offset + 32);
    const localOffset = readUInt32LE(buffer, offset + 42);
    const nameStart = offset + 46;
    const nameEnd = nameStart + nameLength;
    if (nameEnd > buffer.length) {
      throw new Error("ZIP entry name is outside archive bounds");
    }
    const rawName = decoder.decode(buffer.subarray(nameStart, nameEnd));
    const entryName = validateZipPath(rawName);
    if (entryName) {
      entries.set(entryName, {
        compressedSize,
        localOffset,
        method,
        uncompressedSize,
      });
    }
    offset = nameEnd + extraLength + commentLength;
  }
  if (offset !== centralDirectoryOffset + centralDirectorySize) {
    throw new Error("ZIP central directory size does not match entries");
  }

  return {
    names: new Set(entries.keys()),
    read(entryName) {
      const entry = entries.get(entryName);
      if (!entry) {
        return undefined;
      }
      requireZipSignature(buffer, entry.localOffset, 0x04034b50, "local file header");
      const localNameLength = readUInt16LE(buffer, entry.localOffset + 26);
      const localExtraLength = readUInt16LE(buffer, entry.localOffset + 28);
      const dataStart = entry.localOffset + 30 + localNameLength + localExtraLength;
      const dataEnd = dataStart + entry.compressedSize;
      if (dataEnd > buffer.length) {
        throw new Error(`ZIP entry ${entryName} data is outside archive bounds`);
      }
      const compressed = buffer.subarray(dataStart, dataEnd);
      const data =
        entry.method === 0
          ? compressed
          : entry.method === 8
            ? inflateRawSync(compressed)
            : undefined;
      if (data === undefined) {
        throw new Error(`ZIP entry ${entryName} uses unsupported compression method ${entry.method}`);
      }
      if (data.length !== entry.uncompressedSize) {
        throw new Error(`ZIP entry ${entryName} has invalid uncompressed size`);
      }
      return data;
    },
  };
}

function xmlDecode(value) {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

function tokenizeXml(text) {
  return Array.from(text.matchAll(/<[^>]+>|[^<]+/gu), (match) => match[0]);
}

function tagName(token) {
  return token
    .replace(/^<\//u, "")
    .replace(/^</u, "")
    .replace(/\/?>$/u, "")
    .trim()
    .split(/\s+/u)[0];
}

class PlistParser {
  constructor(text) {
    this.tokens = tokenizeXml(text);
    this.index = 0;
  }

  parse() {
    const token = this.nextToken();
    if (!this.isOpening(token, "plist")) {
      throw new Error("plist root element is missing");
    }
    const value = this.parseValue();
    const closing = this.nextToken();
    if (!this.isClosing(closing, "plist")) {
      throw new Error("plist root element is not closed");
    }
    return value;
  }

  nextToken() {
    while (this.index < this.tokens.length) {
      const token = this.tokens[this.index];
      this.index += 1;
      if (!token.startsWith("<") && token.trim() === "") {
        continue;
      }
      if (
        token.startsWith("<?") ||
        token.startsWith("<!") ||
        token.startsWith("<!--")
      ) {
        continue;
      }
      return token;
    }
    throw new Error("unexpected end of plist XML");
  }

  peekToken() {
    const oldIndex = this.index;
    const token = this.nextToken();
    this.index = oldIndex;
    return token;
  }

  isOpening(token, name) {
    return token.startsWith("<") && !token.startsWith("</") && tagName(token) === name && !token.endsWith("/>");
  }

  isClosing(token, name) {
    return token.startsWith("</") && tagName(token) === name;
  }

  isSelfClosing(token, name) {
    return token.startsWith("<") && tagName(token) === name && token.endsWith("/>");
  }

  parseValue() {
    const token = this.nextToken();
    if (this.isOpening(token, "dict")) {
      return this.parseDict();
    }
    if (this.isOpening(token, "array")) {
      return this.parseArray();
    }
    if (this.isOpening(token, "string")) {
      return this.parseTextElement("string");
    }
    if (this.isSelfClosing(token, "string")) {
      return "";
    }
    if (this.isOpening(token, "integer")) {
      return Number.parseInt(this.parseTextElement("integer"), 10);
    }
    if (this.isSelfClosing(token, "true")) {
      return true;
    }
    if (this.isSelfClosing(token, "false")) {
      return false;
    }
    throw new Error(`unsupported plist value ${token}`);
  }

  parseDict() {
    const result = {};
    while (true) {
      const token = this.peekToken();
      if (this.isClosing(token, "dict")) {
        this.nextToken();
        return result;
      }
      const keyOpen = this.nextToken();
      if (!this.isOpening(keyOpen, "key")) {
        throw new Error(`expected plist dict key, got ${keyOpen}`);
      }
      const key = this.parseTextElement("key");
      result[key] = this.parseValue();
    }
  }

  parseArray() {
    const result = [];
    while (true) {
      const token = this.peekToken();
      if (this.isClosing(token, "array")) {
        this.nextToken();
        return result;
      }
      result.push(this.parseValue());
    }
  }

  parseTextElement(name) {
    let text = "";
    while (true) {
      const token = this.nextToken();
      if (this.isClosing(token, name)) {
        return xmlDecode(text);
      }
      if (token.startsWith("<")) {
        throw new Error(`unexpected tag in plist ${name}: ${token}`);
      }
      text += token;
    }
  }
}

function parsePlist(buffer, source) {
  const prefix = buffer.subarray(0, 6).toString("utf8");
  if (prefix === "bplist") {
    fail(`SwiftPM Apple XCFramework Info.plist must be XML for release validation: ${source}`);
  }
  try {
    return new PlistParser(buffer.toString("utf8")).parse();
  } catch (error) {
    fail(`SwiftPM Apple XCFramework Info.plist is invalid in ${source}: ${error.message}`);
  }
}

async function validateAppleXcframeworkAsset(file) {
  let archive;
  try {
    archive = await readZipArchive(file);
  } catch (error) {
    fail(`SwiftPM Apple XCFramework asset is not a readable zip file: ${file}: ${error.message}`);
  }
  const infoData = archive.read("liboliphaunt.xcframework/Info.plist");
  if (infoData === undefined) {
    fail(`SwiftPM Apple XCFramework asset is missing liboliphaunt.xcframework/Info.plist: ${file}`);
  }
  const info = parsePlist(infoData, file);
  if (info === null || Array.isArray(info) || typeof info !== "object") {
    fail(`SwiftPM Apple XCFramework Info.plist must be a plist dictionary in ${file}`);
  }
  const libraries = info.AvailableLibraries;
  if (!Array.isArray(libraries) || libraries.length === 0) {
    fail(`SwiftPM Apple XCFramework Info.plist has no AvailableLibraries in ${file}`);
  }

  const slices = new Set();
  for (const library of libraries) {
    if (library === null || Array.isArray(library) || typeof library !== "object") {
      continue;
    }
    const platform = library.SupportedPlatform;
    const variant = library.SupportedPlatformVariant ?? "";
    const libraryPath = library.LibraryPath;
    const identifier = library.LibraryIdentifier;
    const architectures = library.SupportedArchitectures;
    if (
      typeof platform !== "string" ||
      typeof libraryPath !== "string" ||
      typeof identifier !== "string" ||
      !Array.isArray(architectures) ||
      architectures.some((architecture) => typeof architecture !== "string")
    ) {
      continue;
    }
    for (const architecture of architectures) {
      slices.add(`${platform}\0${typeof variant === "string" ? variant : ""}\0${architecture}`);
    }
    const candidate = `liboliphaunt.xcframework/${identifier}/${libraryPath}`;
    if (!archive.names.has(candidate) && !Array.from(archive.names).some((name) => name.startsWith(`${candidate}/`))) {
      fail(`SwiftPM Apple XCFramework is missing declared library ${candidate}`);
    }
  }

  const missing = missingRequiredAppleArm64Slices(slices);
  if (missing.length > 0) {
    fail(`SwiftPM Apple XCFramework asset ${file} is missing required arm64 slice(s): ${missing.join(", ")}`);
  }
}

export function missingRequiredAppleArm64Slices(slices) {
  const required = [
    ["macos", "", "arm64"],
    ["ios", "", "arm64"],
    ["ios", "simulator", "arm64"],
  ];
  return required
    .filter(([platform, variant, architecture]) => !slices.has(`${platform}\0${variant}\0${architecture}`))
    .map(([platform, variant, architecture]) =>
      `${platform}${variant ? `-${variant}` : ""}-${architecture}`)
    .sort();
}

function parseTarString(buffer, start, length) {
  const end = buffer.indexOf(0, start);
  return buffer
    .subarray(start, end >= start && end < start + length ? end : start + length)
    .toString("utf8")
    .trim();
}

function parseTarOctal(buffer, start, length) {
  const text = parseTarString(buffer, start, length).replaceAll("\0", "").trim();
  return text ? Number.parseInt(text, 8) : 0;
}

function safeIcuRelativePath(memberName) {
  const trimmed = memberName.replace(/^\.\//u, "").replace(/\/+$/u, "");
  if (trimmed === "share/icu" || !trimmed.startsWith("share/icu/")) {
    return undefined;
  }
  const relative = trimmed.slice("share/icu/".length);
  const parts = relative.split("/");
  if (
    relative.length === 0 ||
    path.posix.isAbsolute(relative) ||
    parts.some((part) => part.length === 0 || part === "." || part === "..")
  ) {
    fail(`SwiftPM ICU data asset contains unsafe path: ${memberName}`);
  }
  return relative;
}

async function prepareIcuResourceTree(assetDir, version, generatedTree) {
  if (generatedTree === undefined) {
    return;
  }
  const archivePath = path.join(assetDir, `liboliphaunt-${version}-icu-data.tar.gz`);
  if (!(await isFile(archivePath))) {
    fail(`SwiftPM ICU resource product requires local ICU data asset: ${archivePath}`);
  }
  const target = path.join(generatedTree, "generated/swiftpm/OliphauntICU");
  await fs.rm(target, { recursive: true, force: true });
  await fs.mkdir(path.join(target, "share/icu"), { recursive: true });

  let copied = 0;
  let buffer;
  try {
    buffer = gunzipSync(await fs.readFile(archivePath));
  } catch (error) {
    fail(`SwiftPM ICU data asset is not a readable tar archive: ${archivePath}: ${error.message}`);
  }

  for (let offset = 0; offset + 512 <= buffer.length; ) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      break;
    }
    const name = parseTarString(header, 0, 100);
    const prefix = parseTarString(header, 345, 155);
    const fullName = prefix ? `${prefix}/${name}` : name;
    const size = parseTarOctal(header, 124, 12);
    const type = header.subarray(156, 157).toString("utf8");
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > buffer.length) {
      fail(`SwiftPM ICU data asset member is truncated: ${fullName}`);
    }

    const relative = safeIcuRelativePath(fullName);
    if (relative !== undefined) {
      const destination = path.join(target, "share/icu", ...relative.split("/"));
      if (type === "5") {
        await fs.mkdir(destination, { recursive: true });
      } else if (type === "" || type === "0" || type === "\0") {
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.writeFile(destination, buffer.subarray(dataStart, dataEnd));
        copied += 1;
      } else {
        fail(`SwiftPM ICU data asset member must be a regular file: ${fullName}`);
      }
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }

  const icuEntries = await fs.readdir(path.join(target, "share/icu")).catch(() => []);
  if (copied === 0 || !icuEntries.some((name) => name.startsWith("icudt"))) {
    fail(`SwiftPM ICU resource product did not extract ICU icudt data from ${archivePath}`);
  }
  await fs.writeFile(
    path.join(target, "OliphauntICU.swift"),
    "public enum OliphauntICUResources {\n    public static let bundled = true\n}\n",
    "utf8",
  );
}

export async function fetchText(url, {
  fetchImpl = fetch,
  timeoutMs = 20_000,
} = {}) {
  const response = await fetchImpl(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    await response.body?.cancel?.().catch(() => {});
    throw new Error(`HTTP ${response.status}`);
  }
  const contentLength = response.headers?.get?.("content-length");
  if (contentLength !== null && contentLength !== undefined) {
    const declared = Number(contentLength);
    if (!Number.isSafeInteger(declared) || declared < 0) {
      await response.body?.cancel?.().catch(() => {});
      throw new Error("checksum manifest returned an invalid Content-Length");
    }
    if (declared > MAX_REMOTE_CHECKSUM_MANIFEST_BYTES) {
      await response.body?.cancel?.().catch(() => {});
      throw new Error(`checksum manifest exceeds ${MAX_REMOTE_CHECKSUM_MANIFEST_BYTES} bytes`);
    }
  }
  const reader = response.body?.getReader?.();
  if (reader === undefined) {
    const text = await response.text();
    if (Buffer.byteLength(text) > MAX_REMOTE_CHECKSUM_MANIFEST_BYTES) {
      throw new Error(`checksum manifest exceeds ${MAX_REMOTE_CHECKSUM_MANIFEST_BYTES} bytes`);
    }
    return text;
  }
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_REMOTE_CHECKSUM_MANIFEST_BYTES) {
        await reader.cancel().catch(() => {});
        throw new Error(`checksum manifest exceeds ${MAX_REMOTE_CHECKSUM_MANIFEST_BYTES} bytes`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size).toString("utf8");
}

async function resolveChecksum(assetDir, assetBaseUrl, asset, version) {
  const localAsset = path.join(assetDir, asset);
  const localAssetStat = await fileStat(localAsset);
  if (localAssetStat?.isFile()) {
    if (localAssetStat.size <= 0) {
      fail(`SwiftPM Apple XCFramework asset is empty: ${localAsset}`);
    }
    await validateAppleXcframeworkAsset(localAsset);
    return sha256(localAsset);
  }

  const localManifest = path.join(assetDir, `liboliphaunt-${version}-release-assets.sha256`);
  if (await isFile(localManifest)) {
    const checksum = checksumFromManifest(await fs.readFile(localManifest, "utf8"), asset);
    if (checksum) {
      return checksum;
    }
  }

  const manifestUrl = `${assetBaseUrl.replace(/\/+$/u, "")}/liboliphaunt-${version}-release-assets.sha256`;
  let text;
  try {
    text = await fetchText(manifestUrl);
  } catch (error) {
    fail(
      `SwiftPM asset ${asset} is not present in ${assetDir}, and checksum ` +
        `manifest could not be read from ${manifestUrl}: ${error.message}`,
    );
  }
  const checksum = checksumFromManifest(text, asset);
  if (!checksum) {
    fail(`checksum manifest ${manifestUrl} does not contain ${asset}`);
  }
  return checksum;
}

function renderManifest(assetBaseUrl, liboliphauntVersion, checksum) {
  const asset = `liboliphaunt-${liboliphauntVersion}-apple-spm-xcframework.zip`;
  const url = `${assetBaseUrl.replace(/\/+$/u, "")}/${asset}`;
  return `// swift-tools-version: 6.0

import PackageDescription

// Generated by tools/release/render_swiftpm_release_package.mjs.
// This is the public SwiftPM release manifest. The source package under
// src/sdks/swift remains the local development package.
// Exact PostgreSQL extensions are released as separate opt-in extension
// artifacts. The base Swift package must not require or publish extension files.
let package = Package(
    name: "Oliphaunt",
    platforms: [
        .iOS(.v17),
        .macOS(.v14)
    ],
    products: [
        .library(name: "COliphaunt", targets: ["COliphaunt"]),
        .library(name: "Oliphaunt", targets: ["Oliphaunt"]),
        .library(name: "OliphauntExtensionSupport", targets: ["OliphauntExtensionSupport"]),
        .library(name: "OliphauntICU", targets: ["OliphauntICU"])
    ],
    targets: [
        .binaryTarget(
            name: "liboliphaunt",
            url: "${url}",
            checksum: "${checksum}"
        ),
        .target(
            name: "COliphaunt",
            dependencies: ["liboliphaunt"],
            path: "src/sdks/swift/Sources/COliphaunt",
            publicHeadersPath: "include"
        ),
        .target(
            name: "Oliphaunt",
            dependencies: ["COliphaunt"],
            path: "src/sdks/swift/Sources/Oliphaunt"
        ),
        .target(
            name: "OliphauntExtensionSupport",
            dependencies: ["COliphaunt", "Oliphaunt"],
            path: "src/sdks/swift/Sources/OliphauntExtensionSupport"
        ),
        .target(
            name: "OliphauntICU",
            path: "generated/swiftpm/OliphauntICU",
            resources: [.copy("share")]
        )
    ]
)
`;
}

function parseArgs(argv) {
  const usage =
    "usage: tools/release/render_swiftpm_release_package.mjs [--asset-dir DIR] [--asset-base-url URL] [--output FILE] [--generated-tree DIR]";
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
    console.log(usage);
    process.exit(0);
  }
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    let arg = argv[index];
    if (!arg.startsWith("--")) {
      fail(usage);
    }
    let value;
    const equals = arg.indexOf("=");
    if (equals >= 0) {
      value = arg.slice(equals + 1);
      arg = arg.slice(0, equals);
    } else {
      value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        fail(`${arg} requires a value`);
      }
      index += 1;
    }
    if (!["--asset-dir", "--asset-base-url", "--output", "--generated-tree"].includes(arg)) {
      fail(`unknown argument ${arg}`);
    }
    args[arg.slice(2)] = value;
  }
  return {
    assetBaseUrl: args["asset-base-url"],
    assetDir: args["asset-dir"] ?? "target/liboliphaunt/release-assets",
    generatedTree: args["generated-tree"],
    output: args.output,
  };
}

async function main(argv) {
  const args = parseArgs(argv);
  const liboliphauntVersion = await currentVersion("liboliphaunt-native");
  const assetDir = path.resolve(ROOT, args.assetDir);
  const asset = `liboliphaunt-${liboliphauntVersion}-apple-spm-xcframework.zip`;
  const assetBaseUrl =
    args.assetBaseUrl ??
    `https://github.com/${REPOSITORY}/releases/download/liboliphaunt-native-v${liboliphauntVersion}`;
  const checksum = await resolveChecksum(assetDir, assetBaseUrl, asset, liboliphauntVersion);
  const generatedTree = args.generatedTree ? path.resolve(ROOT, args.generatedTree) : undefined;
  if (generatedTree !== undefined) {
    await fs.mkdir(generatedTree, { recursive: true });
  }
  await prepareIcuResourceTree(assetDir, liboliphauntVersion, generatedTree);
  const manifest = renderManifest(assetBaseUrl, liboliphauntVersion, checksum);
  if (args.output) {
    const output = path.resolve(ROOT, args.output);
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.writeFile(output, manifest, "utf8");
  } else {
    process.stdout.write(manifest);
  }
}

if (import.meta.main) {
  await main(Bun.argv.slice(2));
}
