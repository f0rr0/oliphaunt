#!/usr/bin/env bun
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { readPortableArchiveEntries } from '../../../../../tools/packaging/portable-archive.mts';
import { productCompatibilityVersion } from '../../../../../tools/release/release-graph.mts';
import { assertRustDependencyLicensesInEntries } from '../../../mobile-bindings/tools/dependency-license-contract.mts';

import { renderSwiftReleaseManifest } from './swift-release-manifest.mts';
import { validateAppleXcframeworkAsset } from './swift-xcframework-contract.mts';

export { missingRequiredAppleArm64Slices } from './swift-xcframework-contract.mts';

const ROOT = path.resolve(import.meta.dir, '../../../../..');
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

function parseArgs(argv) {
  const usage =
    'usage: src/native/sdks/swift/tools/render_swiftpm_release_package.mts [--asset-dir DIR] [--asset-base-url URL] [--output FILE] [--generated-tree DIR]';
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

export async function stageSwiftpmSources(generatedTree, bindingsFile) {
  // Published source tags keep their established paths for pinned CocoaPods consumers.
  const sources = path.join(generatedTree, 'src/sdks/swift/Sources');
  await fs.cp(path.join(ROOT, 'src/native/sdks/swift/Sources'), sources, { recursive: true });
  await fs.cp(
    path.join(ROOT, 'src/native/sdks/swift/Templates'),
    path.join(generatedTree, 'src/sdks/swift/Templates'),
    { recursive: true },
  );
  await fs.copyFile(
    path.join(ROOT, 'src/native/runtime/include/oliphaunt.h'),
    path.join(sources, 'COliphaunt/include/oliphaunt.h'),
  );
  await fs.mkdir(path.join(sources, 'OliphauntNativeBindings'), { recursive: true });
  await fs.copyFile(
    bindingsFile,
    path.join(sources, 'OliphauntNativeBindings/OliphauntNativeBindings.swift'),
  );
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
  const swiftVersion = (
    await fs.readFile(path.join(ROOT, 'src/native/sdks/swift/VERSION'), 'utf8')
  ).trim();
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
    await stageSwiftpmSources(
      generatedTree,
      path.join(ROOT, 'target/mobile-bindings/generated/OliphauntNativeBindings.swift'),
    );
  }
  const manifest = renderSwiftReleaseManifest(
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
