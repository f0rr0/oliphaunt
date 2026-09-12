import { renderSwiftpmReleasePackage } from './render_swiftpm_release_package.mts';
import { bundleJavaScript, emitJavaScript } from '../../../tools/packaging/emit-javascript.mts';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createDeterministicZip } from '../../../tools/packaging/archive-directory.mts';

import { IOS_CARRIER_FILENAME, buildIosCarrierManifest } from './ios-carrier-manifest.mts';
import {
  assertReleaseNoticesInArchive,
  assertReleaseNoticesInDirectory,
  stageReleaseNotices,
} from '../../../tools/packaging/release-notices.mts';
import { productCompatibilityVersion } from '../../../tools/release/release-graph.mts';
import { validateSwiftSourceReleaseContract } from './swift-source-carrier-contract.mts';
import {
  ROOT,
  copyDirContents,
  fail,
  rel,
  requireFile,
} from '../../../tools/packaging/staging.mts';

const PREFIX = 'swift stage-release-artifacts.mts';

export async function stageArtifacts(artifactRoot, workRoot) {
  const swiftSourceArchive = path.join(
    ROOT,
    'target/liboliphaunt-sdk-check/oliphaunt-swift/package-shape/swift-source-archive/Oliphaunt-source.zip',
  );
  requireFile(swiftSourceArchive);
  const stagedSourceArchive = path.join(artifactRoot, 'Oliphaunt-source.zip');
  copyFileSync(swiftSourceArchive, stagedSourceArchive);
  const assetDir = process.env.OLIPHAUNT_SWIFT_RELEASE_ASSET_DIR;
  if (!assetDir) {
    fail('oliphaunt-swift package artifacts require OLIPHAUNT_SWIFT_RELEASE_ASSET_DIR');
  }
  await renderSwiftpmReleasePackage([
    '--asset-dir',
    assetDir,
    '--output',
    path.join(artifactRoot, 'Package.swift.release'),
    '--generated-tree',
    path.join(workRoot, 'swiftpm-release-tree'),
  ]);
  const releaseTree = path.join(artifactRoot, 'release-tree');
  rmSync(releaseTree, { recursive: true, force: true });
  copyDirContents(path.join(workRoot, 'swiftpm-release-tree'), releaseTree);
  stageReleaseNotices(releaseTree);
  assertReleaseNoticesInDirectory(releaseTree);
  const carrier = buildIosCarrierManifest({
    baseAssetDir: assetDir,
    extensionManifests: [],
  });
  const carrierFile = path.join(releaseTree, 'sdks/swift/Carriers', IOS_CARRIER_FILENAME);
  mkdirSync(path.dirname(carrierFile), { recursive: true });
  writeFileSync(carrierFile, `${JSON.stringify(carrier, null, 2)}\n`, 'utf8');
  const manifest = readFileSync(path.join(artifactRoot, 'Package.swift.release'), 'utf8');
  const swiftVersion = readFileSync(path.join(ROOT, 'sdks/swift/VERSION'), 'utf8').trim();
  const releaseAssets = path.join(artifactRoot, 'release-assets');
  mkdirSync(releaseAssets, { recursive: true });
  for (const name of [
    `oliphaunt-swift-${swiftVersion}-bindings.xcframework.zip`,
    `oliphaunt-swift-${swiftVersion}-release-assets.sha256`,
  ]) {
    copyFileSync(
      path.join(ROOT, 'target/oliphaunt-swift/release-assets', name),
      path.join(releaseAssets, name),
    );
  }
  // The downloadable source package is independently buildable: use the
  // frozen public binary dependencies, not checkout-only Cargo output paths.
  const sourcePackage = path.join(workRoot, 'source', 'package');
  copyDirContents(path.join(path.dirname(swiftSourceArchive), 'package'), sourcePackage);
  const generatedSource = path.join(sourcePackage, 'Sources/OliphauntNativeBindings');
  mkdirSync(generatedSource, { recursive: true });
  copyFileSync(
    path.join(ROOT, 'target/mobile-bindings/generated/OliphauntNativeBindings.swift'),
    path.join(generatedSource, 'OliphauntNativeBindings.swift'),
  );
  writeFileSync(
    path.join(sourcePackage, 'Package.swift'),
    manifest.replaceAll('"sdks/swift/Sources/', '"Sources/'),
  );
  writeFileSync(
    stagedSourceArchive,
    await createDeterministicZip(sourcePackage, { keepParent: true }),
  );
  assertReleaseNoticesInArchive(stagedSourceArchive, { prefix: 'package' });
  try {
    validateSwiftSourceReleaseContract({
      carrier,
      expectedNativeVersion: productCompatibilityVersion(
        'oliphaunt-swift',
        'liboliphaunt-native',
        PREFIX,
      ),
      label: `${rel(artifactRoot)} source release`,
      manifestText: manifest,
    });
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  if (manifest.includes('file://')) {
    fail('staged SwiftPM release manifest must not contain local file URLs');
  }
  const generatorRoot = path.join(artifactRoot, 'extension-generator');
  mkdirSync(generatorRoot, { recursive: true });
  for (const name of [
    'extension-resource-inventory.mjs',
    'render-extension-products.mjs',
    'swift-carrier-resolver.mjs',
  ]) {
    const source = path.join(ROOT, 'sdks/swift/tools', name.replace(/\.mjs$/, '.mts'));
    const destination = path.join(generatorRoot, name);
    if (name === 'swift-carrier-resolver.mjs') {
      writeFileSync(destination, await bundleJavaScript(source), { mode: 0o644 });
    } else {
      emitJavaScript(source, destination);
    }
  }
  copyFileSync(
    path.join(ROOT, 'extensions/generated/sdk/extensions.json'),
    path.join(generatorRoot, 'extension-owner-catalog.json'),
  );
}

import { stageSdkArtifacts } from '../../../tools/packaging/staging.mts';
if (import.meta.main) await stageSdkArtifacts('oliphaunt-swift', stageArtifacts);
