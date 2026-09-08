import { renderSwiftpmReleasePackage } from './render_swiftpm_release_package.mts';
import {
  bundleJavaScript,
  emitJavaScript,
} from '../../../shared/artifact-packaging/emit-javascript.mts';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import {
  IOS_CARRIER_FILENAME,
  buildIosCarrierManifest,
} from '../../../shared/artifact-packaging/ios-carrier-manifest.mts';
import {
  assertReleaseNoticesInArchive,
  assertReleaseNoticesInDirectory,
  stageReleaseNotices,
} from '../../../shared/artifact-packaging/release-notices.mts';
import { productCompatibilityVersion } from '../../../shared/product-metadata/release-graph.mts';
import { validateSwiftSourceReleaseContract } from './swift-source-carrier-contract.mts';
import {
  ROOT,
  copyDirContents,
  fail,
  rel,
  requireFile,
} from '../../../shared/artifact-packaging/staging.mts';

const PREFIX = 'swift stage-release-artifacts.mts';

export async function stageArtifacts(artifactRoot, workRoot) {
  const swiftSourceArchive = path.join(
    ROOT,
    'target/liboliphaunt-sdk-check/oliphaunt-swift/package-shape/swift-source-archive/Oliphaunt-source.zip',
  );
  requireFile(swiftSourceArchive);
  const stagedSourceArchive = path.join(artifactRoot, 'Oliphaunt-source.zip');
  copyFileSync(swiftSourceArchive, stagedSourceArchive);
  assertReleaseNoticesInArchive(stagedSourceArchive, { prefix: 'package' });
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
  const carrierFile = path.join(releaseTree, 'src/sdks/swift/Carriers', IOS_CARRIER_FILENAME);
  mkdirSync(path.dirname(carrierFile), { recursive: true });
  writeFileSync(carrierFile, `${JSON.stringify(carrier, null, 2)}\n`, 'utf8');
  const manifest = readFileSync(path.join(artifactRoot, 'Package.swift.release'), 'utf8');
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
    const source = path.join(ROOT, 'src/sdks/swift/tools', name.replace(/\.mjs$/, '.mts'));
    const destination = path.join(generatorRoot, name);
    if (name === 'swift-carrier-resolver.mjs') {
      writeFileSync(destination, await bundleJavaScript(source), { mode: 0o644 });
    } else {
      emitJavaScript(source, destination);
    }
  }
  copyFileSync(
    path.join(ROOT, 'src/extensions/generated/sdk/extensions.json'),
    path.join(generatorRoot, 'extension-owner-catalog.json'),
  );
}

import { stageSdkArtifacts } from '../../../shared/artifact-packaging/staging.mts';
if (import.meta.main) await stageSdkArtifacts('oliphaunt-swift', stageArtifacts);
