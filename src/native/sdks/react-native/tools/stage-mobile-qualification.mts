#!/usr/bin/env bun
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { currentProductVersionSync } from '../../../../../tools/release/release-artifact-targets.mts';
import { ROOT } from '../../../../../tools/release/release-graph.mts';
import {
  discoveredExtensionManifests,
  IOS_CARRIER_FILENAME,
  swiftExtensionCarrierAssetName,
  writeIosCarrierManifest,
  writeSwiftExtensionCarrierManifest,
} from '../../swift/tools/ios-carrier-manifest.mts';
import { parseSwiftReleaseBinaryTarget } from '../../swift/tools/prepare-swift-release-consumer.mts';

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

/** Keep immutable release pins separate from qualification of current workspace bytes. */
export function stageMobileQualification({
  platform,
  extensionRoot,
  outputRoot,
  baseAssetDir = path.join(ROOT, 'target/liboliphaunt/release-assets'),
  swiftSdkDir = path.join(ROOT, 'target/sdk-artifacts/oliphaunt-swift'),
}) {
  if (!['android', 'ios'].includes(platform))
    throw new Error(`unknown mobile platform ${platform}`);
  if (existsSync(outputRoot))
    throw new Error(`qualification destination already exists: ${outputRoot}`);
  const manifests = discoveredExtensionManifests(extensionRoot);
  if (manifests.length === 0) throw new Error(`no extension manifests in ${extensionRoot}`);
  const nativeRuntimeVersion = currentProductVersionSync('liboliphaunt-native');
  const wasixRuntimeVersion = currentProductVersionSync('liboliphaunt-wasix');
  const extensions = path.join(outputRoot, 'extensions');
  cpSync(extensionRoot, extensions, { recursive: true });
  const stagedManifests = manifests.map((source) => {
    const file = path.join(extensions, path.relative(extensionRoot, source));
    const manifest = JSON.parse(readFileSync(file, 'utf8'));
    manifest.qualificationOnly = true;
    manifest.compatibility = {
      ...manifest.compatibility,
      nativeRuntimeVersion,
      wasixRuntimeVersion,
    };
    // Producer paths may name a different transport root. Point at the copied bytes.
    for (const asset of [
      ...(manifest.extensions ?? [manifest]).flatMap((member) => member.assets),
      ...(manifest.carrierAssets ?? []),
    ]) {
      const directory = asset.carrierAsset ? 'member-assets' : 'release-assets';
      const marker = `/${directory}/`;
      const offset = asset.path.lastIndexOf(marker);
      if (offset < 0) throw new Error(`invalid extension asset path ${asset.path}`);
      asset.path = path.join(
        path.dirname(file),
        directory,
        asset.path.slice(offset + marker.length),
      );
    }
    writeJson(file, manifest);
    return file;
  });
  writeJson(path.join(outputRoot, 'qualification.json'), {
    qualificationOnly: true,
    nativeRuntimeVersion,
    wasixRuntimeVersion,
  });
  if (platform === 'android') return;

  const swift = path.join(outputRoot, 'swift-sdk');
  cpSync(swiftSdkDir, swift, { recursive: true });
  writeJson(path.join(swift, 'qualification.json'), {
    qualificationOnly: true,
    product: 'oliphaunt-swift',
  });
  const neutralFile = path.join(
    swift,
    'release-tree/src/sdks/swift/Carriers',
    IOS_CARRIER_FILENAME,
  );
  const neutral = writeIosCarrierManifest(neutralFile, {
    baseAssetDir,
    baseRuntimeVersion: nativeRuntimeVersion,
    extensionManifests: [],
  });
  const base = neutral.base.assets.find((asset) => asset.role === 'base-xcframework');
  const releaseManifest = path.join(swift, 'Package.swift.release');
  const original = readFileSync(releaseManifest, 'utf8');
  const target = parseSwiftReleaseBinaryTarget(original);
  const replacement = original
    .slice(target.index, target.end)
    .replace(target.url, base.url)
    .replace(target.checksum, base.sha256);
  const manifest = original.slice(0, target.index) + replacement + original.slice(target.end);
  writeFileSync(releaseManifest, manifest);
  writeFileSync(path.join(swift, 'release-tree/Package.swift'), manifest);
  writeIosCarrierManifest(path.join(outputRoot, 'ios-carriers', IOS_CARRIER_FILENAME), {
    baseAssetDir,
    baseRuntimeVersion: nativeRuntimeVersion,
    extensionManifests: stagedManifests,
    localUrls: true,
  });
  for (const extensionManifest of stagedManifests) {
    const { product, version } = JSON.parse(readFileSync(extensionManifest, 'utf8'));
    writeSwiftExtensionCarrierManifest(
      path.join(
        path.dirname(extensionManifest),
        'release-assets',
        swiftExtensionCarrierAssetName(product, version),
      ),
      { extensionManifest, nativeRuntimeVersion },
    );
  }
}

if (import.meta.main) {
  try {
    const [platform, extensionRoot, outputRoot, ...extra] = Bun.argv.slice(2);
    if (!extensionRoot || !outputRoot || extra.length) {
      throw new Error(
        'usage: stage-mobile-qualification.mts android|ios EXTENSION_ROOT OUTPUT_ROOT',
      );
    }
    stageMobileQualification({
      platform,
      extensionRoot: path.resolve(extensionRoot),
      outputRoot: path.resolve(outputRoot),
    });
  } catch (error) {
    console.error(`stage-mobile-qualification.mts: ${error.message}`);
    process.exit(1);
  }
}
