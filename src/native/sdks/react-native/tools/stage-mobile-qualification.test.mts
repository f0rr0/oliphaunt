import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { archiveDirectory } from '../../../../../tools/packaging/archive-directory.mts';
import { stageReleaseNotices } from '../../../../../tools/packaging/release-notices.mts';
import {
  currentProductVersionSync,
  extensionMetadata,
} from '../../../../../tools/release/release-artifact-targets.mts';
import { ROOT } from '../../../../../tools/release/release-graph.mts';
import { stageExtensionUpstreamLicenses } from '../../../../extensions/tools/extension-upstream-licenses.mts';
import {
  IOS_CARRIER_FILENAME,
  buildIosCarrierManifest,
} from '../../swift/tools/ios-carrier-manifest.mts';
import {
  localizeSwiftReleaseManifest,
  parseSwiftReleaseBinaryTarget,
} from '../../swift/tools/prepare-swift-release-consumer.mts';
import { extensionReleaseConsumerInputs } from '../../swift/tools/swift-extension-release-consumer-inputs.mts';
import { stageMobileQualification } from './stage-mobile-qualification.mts';

test('iOS qualification keeps the Swift base, independent carriers and binary checksum aligned', async () => {
  mkdirSync(path.join(ROOT, 'target'), { recursive: true });
  const root = mkdtempSync(path.join(ROOT, 'target/mobile-qualification-test-'));
  try {
    const nativeVersion = currentProductVersionSync('liboliphaunt-native');
    const product = 'oliphaunt-extension-pgtap';
    const version = currentProductVersionSync(product);
    const extensionRoot = path.join(root, 'extensions');
    const releaseAssets = path.join(extensionRoot, product, 'release-assets');
    const baseAssetDir = path.join(root, 'base');
    mkdirSync(releaseAssets, { recursive: true });
    mkdirSync(baseAssetDir, { recursive: true });
    async function archive(name, directory, member, profile, sqlName = undefined) {
      const stage = path.join(root, `stage-${name}`);
      mkdirSync(path.join(stage, member), { recursive: true });
      writeFileSync(path.join(stage, member, 'payload'), 'workspace bytes');
      stageReleaseNotices(member === 'oliphaunt' ? stage : path.join(stage, member), { profile });
      if (sqlName) stageExtensionUpstreamLicenses(sqlName, path.join(stage, 'files'));
      const output = path.join(directory, name);
      await archiveDirectory(member === 'oliphaunt' ? stage : path.join(stage, member), output, {
        keepParent: member !== 'oliphaunt',
      });
      return output;
    }
    const baseArchive = await archive(
      `liboliphaunt-${nativeVersion}-apple-spm-xcframework.zip`,
      baseAssetDir,
      'liboliphaunt.xcframework',
      'native-runtime',
    );
    await archive(
      `liboliphaunt-${nativeVersion}-runtime-resources-ios-datum64.tar.gz`,
      baseAssetDir,
      'oliphaunt',
      'native-runtime-resources',
    );
    const runtime = await archive(
      `${product}-${version}-native-ios-runtime.tar.gz`,
      releaseAssets,
      'oliphaunt',
      'external-native',
      'pgtap',
    );
    const bytes = readFileSync(runtime);
    const extensionFile = path.join(extensionRoot, product, 'extension-artifacts.json');
    writeFileSync(
      extensionFile,
      JSON.stringify({
        schema: 'oliphaunt-extension-ci-artifacts-v1',
        product,
        version,
        compatibility: {
          ...extensionMetadata(product).compatibility,
          nativeRuntimeVersion: '0.0.0',
        },
        sqlName: 'pgtap',
        createsExtension: true,
        dependencies: [],
        dataFiles: [],
        extensionSqlFileNames: [],
        extensionSqlFilePrefixes: [],
        sharedPreloadLibraries: [],
        nativeModuleStem: null,
        iosNativeDependencies: [],
        iosRegistration: null,
        wasixInstall: null,
        assets: [
          {
            family: 'native',
            target: 'ios-xcframework',
            kind: 'runtime',
            identity: null,
            name: path.basename(runtime),
            path: runtime,
            source: runtime,
            bytes: bytes.length,
            sha256: createHash('sha256').update(bytes).digest('hex'),
          },
        ],
      }),
    );
    assert.throws(
      () => buildIosCarrierManifest({ baseAssetDir, extensionManifests: [extensionFile] }),
      /selected base carrier/,
    );
    const swiftSdkDir = path.join(root, 'swift');
    mkdirSync(swiftSdkDir, { recursive: true });
    const publishedManifest = `.binaryTarget(name: "liboliphaunt", url: "https://example.invalid/pinned.zip", checksum: "${'0'.repeat(64)}")`;
    writeFileSync(path.join(swiftSdkDir, 'Package.swift.release'), publishedManifest);
    const original = readFileSync(extensionFile);
    const outputRoot = path.join(root, 'qualification');
    stageMobileQualification({
      platform: 'ios',
      extensionRoot,
      outputRoot,
      baseAssetDir,
      swiftSdkDir,
    });
    const sourceCarrierFile = path.join(
      outputRoot,
      'swift-sdk/release-tree/src/sdks/swift/Carriers',
      IOS_CARRIER_FILENAME,
    );
    const carrier = path.join(
      outputRoot,
      'extensions',
      product,
      'release-assets',
      `${product}-${version}-swift-extension-carrier.json`,
    );
    const plan = extensionReleaseConsumerInputs({
      sourceCarrierFile,
      extensionCarrierFiles: [carrier],
    });
    assert.equal(plan.finalLink.runtimeVersion, nativeVersion);
    assert.equal(
      JSON.parse(readFileSync(path.join(outputRoot, 'swift-sdk/qualification.json'), 'utf8'))
        .qualificationOnly,
      true,
    );
    const stagedManifest = path.join(outputRoot, 'swift-sdk/Package.swift.release');
    localizeSwiftReleaseManifest({
      manifestFile: stagedManifest,
      assetFile: baseArchive,
      outputFile: path.join(root, 'localized.swift'),
    });
    assert.equal(
      parseSwiftReleaseBinaryTarget(readFileSync(stagedManifest, 'utf8')).checksum,
      createHash('sha256').update(readFileSync(baseArchive)).digest('hex'),
    );
    const warm = JSON.parse(
      readFileSync(path.join(outputRoot, 'ios-carriers', IOS_CARRIER_FILENAME), 'utf8'),
    );
    assert.equal(warm.base.version, nativeVersion);
    assert.ok(warm.base.assets.every((asset) => asset.url.startsWith('file:')));
    assert.equal(JSON.parse(readFileSync(sourceCarrierFile, 'utf8')).extensions.length, 0);
    assert.deepEqual(readFileSync(extensionFile), original);
    assert.equal(
      readFileSync(path.join(swiftSdkDir, 'Package.swift.release'), 'utf8'),
      publishedManifest,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
