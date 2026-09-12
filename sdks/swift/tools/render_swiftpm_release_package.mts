#!/usr/bin/env bun
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { readPortableArchiveEntries } from '../../../tools/packaging/portable-archive.mts';
import { productCompatibilityVersion } from '../../../tools/release/release-graph.mts';
import { assertRustDependencyLicensesInEntries } from '../../rust/mobile-bindings/tools/dependency-license-contract.mts';

const ROOT = path.resolve(import.meta.dir, '../../..');
const REPOSITORY = 'f0rr0/oliphaunt';
const MAX_REMOTE_CHECKSUM_MANIFEST_BYTES = 1024 * 1024;

function fail(message) {
  console.error(`render_swiftpm_release_package.mts: ${message}`);
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
  return createHash('sha256')
    .update(await fs.readFile(file))
    .digest('hex');
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

async function readZipArchive(file) {
  const entries = readPortableArchiveEntries(file, { format: 'zip' });
  return {
    names: new Set(entries.keys()),
    read(entryName) {
      const entry = entries.get(entryName);
      return entry?.isFile ? Buffer.from(entry.data()) : undefined;
    },
  };
}

function xmlDecode(value) {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

function tokenizeXml(text) {
  return Array.from(text.matchAll(/<[^>]+>|[^<]+/gu), (match) => match[0]);
}

function tagName(token) {
  return token
    .replace(/^<\//u, '')
    .replace(/^</u, '')
    .replace(/\/?>$/u, '')
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
    if (!this.isOpening(token, 'plist')) {
      throw new Error('plist root element is missing');
    }
    const value = this.parseValue();
    const closing = this.nextToken();
    if (!this.isClosing(closing, 'plist')) {
      throw new Error('plist root element is not closed');
    }
    return value;
  }

  nextToken() {
    while (this.index < this.tokens.length) {
      const token = this.tokens[this.index];
      this.index += 1;
      if (!token.startsWith('<') && token.trim() === '') {
        continue;
      }
      if (token.startsWith('<?') || token.startsWith('<!') || token.startsWith('<!--')) {
        continue;
      }
      return token;
    }
    throw new Error('unexpected end of plist XML');
  }

  peekToken() {
    const oldIndex = this.index;
    const token = this.nextToken();
    this.index = oldIndex;
    return token;
  }

  isOpening(token, name) {
    return (
      token.startsWith('<') &&
      !token.startsWith('</') &&
      tagName(token) === name &&
      !token.endsWith('/>')
    );
  }

  isClosing(token, name) {
    return token.startsWith('</') && tagName(token) === name;
  }

  isSelfClosing(token, name) {
    return token.startsWith('<') && tagName(token) === name && token.endsWith('/>');
  }

  parseValue() {
    const token = this.nextToken();
    if (this.isOpening(token, 'dict')) {
      return this.parseDict();
    }
    if (this.isOpening(token, 'array')) {
      return this.parseArray();
    }
    if (this.isOpening(token, 'string')) {
      return this.parseTextElement('string');
    }
    if (this.isSelfClosing(token, 'string')) {
      return '';
    }
    if (this.isOpening(token, 'integer')) {
      return Number.parseInt(this.parseTextElement('integer'), 10);
    }
    if (this.isSelfClosing(token, 'true')) {
      return true;
    }
    if (this.isSelfClosing(token, 'false')) {
      return false;
    }
    throw new Error(`unsupported plist value ${token}`);
  }

  parseDict() {
    const result = {};
    while (true) {
      const token = this.peekToken();
      if (this.isClosing(token, 'dict')) {
        this.nextToken();
        return result;
      }
      const keyOpen = this.nextToken();
      if (!this.isOpening(keyOpen, 'key')) {
        throw new Error(`expected plist dict key, got ${keyOpen}`);
      }
      const key = this.parseTextElement('key');
      result[key] = this.parseValue();
    }
  }

  parseArray() {
    const result = [];
    while (true) {
      const token = this.peekToken();
      if (this.isClosing(token, 'array')) {
        this.nextToken();
        return result;
      }
      result.push(this.parseValue());
    }
  }

  parseTextElement(name) {
    let text = '';
    while (true) {
      const token = this.nextToken();
      if (this.isClosing(token, name)) {
        return xmlDecode(text);
      }
      if (token.startsWith('<')) {
        throw new Error(`unexpected tag in plist ${name}: ${token}`);
      }
      text += token;
    }
  }
}

function parsePlist(buffer, source) {
  const prefix = buffer.subarray(0, 6).toString('utf8');
  if (prefix === 'bplist') {
    fail(`SwiftPM Apple XCFramework Info.plist must be XML for release validation: ${source}`);
  }
  try {
    return new PlistParser(buffer.toString('utf8')).parse();
  } catch (error) {
    fail(`SwiftPM Apple XCFramework Info.plist is invalid in ${source}: ${error.message}`);
  }
}

async function validateAppleXcframeworkAsset(file, framework = 'liboliphaunt') {
  let archive;
  try {
    archive = await readZipArchive(file);
  } catch (error) {
    fail(`SwiftPM Apple XCFramework asset is not a readable zip file: ${file}: ${error.message}`);
  }
  const infoData = archive.read(`${framework}.xcframework/Info.plist`);
  if (infoData === undefined) {
    fail(`SwiftPM Apple XCFramework asset is missing ${framework}.xcframework/Info.plist: ${file}`);
  }
  const info = parsePlist(infoData, file);
  if (info === null || Array.isArray(info) || typeof info !== 'object') {
    fail(`SwiftPM Apple XCFramework Info.plist must be a plist dictionary in ${file}`);
  }
  const libraries = info.AvailableLibraries;
  if (!Array.isArray(libraries) || libraries.length === 0) {
    fail(`SwiftPM Apple XCFramework Info.plist has no AvailableLibraries in ${file}`);
  }

  const slices = new Set();
  for (const library of libraries) {
    if (library === null || Array.isArray(library) || typeof library !== 'object') {
      continue;
    }
    const platform = library.SupportedPlatform;
    const variant = library.SupportedPlatformVariant ?? '';
    const libraryPath = library.LibraryPath;
    const identifier = library.LibraryIdentifier;
    const architectures = library.SupportedArchitectures;
    if (
      typeof platform !== 'string' ||
      typeof libraryPath !== 'string' ||
      typeof identifier !== 'string' ||
      !Array.isArray(architectures) ||
      architectures.some((architecture) => typeof architecture !== 'string')
    ) {
      continue;
    }
    for (const architecture of architectures) {
      slices.add(`${platform}\0${typeof variant === 'string' ? variant : ''}\0${architecture}`);
    }
    const candidate = `${framework}.xcframework/${identifier}/${libraryPath}`;
    if (
      !archive.names.has(candidate) &&
      !Array.from(archive.names).some((name) => name.startsWith(`${candidate}/`))
    ) {
      fail(`SwiftPM Apple XCFramework is missing declared library ${candidate}`);
    }
  }

  const missing = missingRequiredAppleArm64Slices(slices);
  if (missing.length > 0) {
    fail(
      `SwiftPM Apple XCFramework asset ${file} is missing required arm64 slice(s): ${missing.join(', ')}`,
    );
  }
}

export function missingRequiredAppleArm64Slices(slices) {
  const required = [
    ['macos', '', 'arm64'],
    ['ios', '', 'arm64'],
    ['ios', 'simulator', 'arm64'],
  ];
  return required
    .filter(
      ([platform, variant, architecture]) =>
        !slices.has(`${platform}\0${variant}\0${architecture}`),
    )
    .map(
      ([platform, variant, architecture]) =>
        `${platform}${variant ? `-${variant}` : ''}-${architecture}`,
    )
    .sort();
}

export async function fetchText(url, { fetchImpl = fetch, timeoutMs = 20_000 } = {}) {
  const response = await fetchImpl(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    await response.body?.cancel?.().catch(() => {});
    throw new Error(`HTTP ${response.status}`);
  }
  const contentLength = response.headers?.get?.('content-length');
  if (contentLength !== null && contentLength !== undefined) {
    const declared = Number(contentLength);
    if (!Number.isSafeInteger(declared) || declared < 0) {
      await response.body?.cancel?.().catch(() => {});
      throw new Error('checksum manifest returned an invalid Content-Length');
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
  return Buffer.concat(chunks, size).toString('utf8');
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
    const checksum = checksumFromManifest(await fs.readFile(localManifest, 'utf8'), asset);
    if (checksum) {
      return checksum;
    }
  }

  const manifestUrl = `${assetBaseUrl.replace(/\/+$/u, '')}/liboliphaunt-${version}-release-assets.sha256`;
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

function renderManifest(
  assetBaseUrl,
  liboliphauntVersion,
  checksum,
  bindingsUrl,
  bindingsChecksum,
) {
  const asset = `liboliphaunt-${liboliphauntVersion}-apple-spm-xcframework.zip`;
  const url = `${assetBaseUrl.replace(/\/+$/u, '')}/${asset}`;
  return `// swift-tools-version: 6.0

import PackageDescription

// Generated by sdks/swift/tools/render_swiftpm_release_package.mts.
// This is the public SwiftPM release manifest. The source package under
// sdks/swift remains the local development package.
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
        .library(name: "OliphauntExtensionSupport", targets: ["OliphauntExtensionSupport"])
    ],
    targets: [
        .binaryTarget(
            name: "OliphauntNativeBindingsFFI",
            url: "${bindingsUrl}",
            checksum: "${bindingsChecksum}"
        ),
        .target(
            name: "OliphauntNativeBindings",
            dependencies: ["OliphauntNativeBindingsFFI"],
            path: "sdks/swift/Sources/OliphauntNativeBindings"
        ),
        .binaryTarget(
            name: "liboliphaunt",
            url: "${url}",
            checksum: "${checksum}"
        ),
        .target(
            name: "COliphaunt",
            dependencies: ["liboliphaunt"],
            path: "sdks/swift/Sources/COliphaunt",
            publicHeadersPath: "include",
            cSettings: [.define("OLIPHAUNT_LINK_RUNTIME")]
        ),
        .target(
            name: "Oliphaunt",
            dependencies: ["COliphaunt", "OliphauntNativeBindings"],
            path: "sdks/swift/Sources/Oliphaunt"
        ),
        .target(
            name: "OliphauntExtensionSupport",
            dependencies: ["COliphaunt", "Oliphaunt"],
            path: "sdks/swift/Sources/OliphauntExtensionSupport"
        )
    ]
)
`;
}

function parseArgs(argv) {
  const usage =
    'usage: sdks/swift/tools/render_swiftpm_release_package.mts [--asset-dir DIR] [--asset-base-url URL] [--output FILE] [--generated-tree DIR]';
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) {
    console.log(usage);
    process.exit(0);
  }
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    let arg = argv[index];
    if (!arg.startsWith('--')) {
      fail(usage);
    }
    let value;
    const equals = arg.indexOf('=');
    if (equals >= 0) {
      value = arg.slice(equals + 1);
      arg = arg.slice(0, equals);
    } else {
      value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        fail(`${arg} requires a value`);
      }
      index += 1;
    }
    if (
      ![
        '--asset-dir',
        '--asset-base-url',
        '--bindings-asset-dir',
        '--output',
        '--generated-tree',
      ].includes(arg)
    ) {
      fail(`unknown argument ${arg}`);
    }
    args[arg.slice(2)] = value;
  }
  return {
    assetBaseUrl: args['asset-base-url'],
    bindingsAssetDir: args['bindings-asset-dir'] ?? 'target/oliphaunt-swift/release-assets',
    assetDir: args['asset-dir'] ?? 'target/liboliphaunt/release-assets',
    generatedTree: args['generated-tree'],
    output: args.output,
  };
}

export async function renderSwiftpmReleasePackage(argv) {
  const args = parseArgs(argv);
  const liboliphauntVersion = productCompatibilityVersion(
    'oliphaunt-swift',
    'liboliphaunt-native',
    'render_swiftpm_release_package.mts',
  );
  const assetDir = path.resolve(ROOT, args.assetDir);
  const asset = `liboliphaunt-${liboliphauntVersion}-apple-spm-xcframework.zip`;
  const assetBaseUrl =
    args.assetBaseUrl ??
    `https://github.com/${REPOSITORY}/releases/download/liboliphaunt-native-v${liboliphauntVersion}`;
  const checksum = await resolveChecksum(assetDir, assetBaseUrl, asset, liboliphauntVersion);
  const swiftVersion = (await fs.readFile(path.join(ROOT, 'sdks/swift/VERSION'), 'utf8')).trim();
  const bindingsAsset = `oliphaunt-swift-${swiftVersion}-bindings.xcframework.zip`;
  const bindingsFile = path.resolve(ROOT, args.bindingsAssetDir, bindingsAsset);
  await validateAppleXcframeworkAsset(bindingsFile, 'OliphauntNativeBindingsFFI');
  const bindingsEntries = readPortableArchiveEntries(bindingsFile, { format: 'zip' });
  for (const target of ['ios-arm64', 'ios-simulator-arm64', 'macos-arm64']) {
    await assertRustDependencyLicensesInEntries(bindingsEntries, {
      target,
      prefix: `OliphauntNativeBindingsFFI.xcframework/licenses/${target}`,
      label: bindingsFile,
    });
  }
  const bindingsChecksum = await sha256(bindingsFile);
  const bindingsUrl = `https://github.com/${REPOSITORY}/releases/download/oliphaunt-swift-v${swiftVersion}/${bindingsAsset}`;
  const generatedTree = args.generatedTree ? path.resolve(ROOT, args.generatedTree) : undefined;
  if (generatedTree !== undefined) {
    await fs.mkdir(generatedTree, { recursive: true });
    const sources = path.join(generatedTree, 'sdks/swift/Sources/OliphauntNativeBindings');
    await fs.mkdir(sources, { recursive: true });
    await fs.copyFile(
      path.join(ROOT, 'target/mobile-bindings/generated/OliphauntNativeBindings.swift'),
      path.join(sources, 'OliphauntNativeBindings.swift'),
    );
  }
  const manifest = renderManifest(
    assetBaseUrl,
    liboliphauntVersion,
    checksum,
    bindingsUrl,
    bindingsChecksum,
  );
  if (args.output) {
    const output = path.resolve(ROOT, args.output);
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.writeFile(output, manifest, 'utf8');
  } else {
    process.stdout.write(manifest);
  }
}

if (import.meta.main) {
  await renderSwiftpmReleasePackage(Bun.argv.slice(2));
}
