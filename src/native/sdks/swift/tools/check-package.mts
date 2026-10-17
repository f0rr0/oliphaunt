#!/usr/bin/env bun
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  bundleJavaScript,
  releaseJavaScript,
} from '../../../../../tools/packaging/emit-javascript.mts';
import {
  directoryNames,
  fail,
  inspectSdkProduct,
  isDirectory,
  isFile,
  PREFIX,
  readZipEntries,
  rejectSdkRuntimePayload,
  rel,
} from '../../../../../tools/packaging/release-carrier.mts';
import { compareText, ROOT } from '../../../../../tools/release/release-artifact-targets.mts';
import { productCompatibilityVersion } from '../../../../../tools/release/release-graph.mts';
import {
  validateSelectionNeutralSwiftSourceCarrierFile,
  validateSwiftSourceReleaseContract,
} from './swift-source-carrier-contract.mts';
import {
  SWIFT_SOURCE_FIXTURE_PREFIX,
  validateSwiftSourceFixtureEntries as validateDeclaredSwiftSourceFixtureEntries,
} from './swift-source-fixture-contract.mts';

const SWIFT_SOURCE_FIXTURE_REPOSITORY_ROOT = path.join(
  ROOT,
  'src/native/sdks/swift/Tests/Fixtures/swiftpm-extension-resources',
);

export function validateSwiftSourceFixtureEntries(artifact, entries) {
  if (!isDirectory(SWIFT_SOURCE_FIXTURE_REPOSITORY_ROOT)) {
    throw new Error(
      `${rel(artifact)} cannot validate Swift source fixtures because ` +
        `${rel(SWIFT_SOURCE_FIXTURE_REPOSITORY_ROOT)} is missing`,
    );
  }

  const expected = new Map(
    directoryNames(SWIFT_SOURCE_FIXTURE_REPOSITORY_ROOT).map((name) => [
      `${SWIFT_SOURCE_FIXTURE_PREFIX}${name}`,
      readFileSync(path.join(SWIFT_SOURCE_FIXTURE_REPOSITORY_ROOT, ...name.split('/'))),
    ]),
  );
  return validateDeclaredSwiftSourceFixtureEntries(rel(artifact), entries, expected);
}

export async function checkSwiftPackage(root, { nativeSourceBasis = undefined } = {}) {
  const product = 'oliphaunt-swift';
  let checked = false;

  const archives = readdirSync(root)
    .filter((name) => name.endsWith('.zip'))
    .map((name) => path.join(root, name))
    .sort(compareText);
  if (archives.length === 0) {
    fail(`${product} must stage a source zip under ${rel(root)}`);
  }
  for (const archive of archives) {
    const entries = readZipEntries(archive);
    const names = [...entries]
      .filter(([, entry]) => entry.isFile)
      .map(([name]) => name)
      .sort(compareText);
    let allowedFixtureNames;
    try {
      allowedFixtureNames = validateSwiftSourceFixtureEntries(archive, entries);
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
    rejectSdkRuntimePayload(product, archive, names, allowedFixtureNames);
    checked = true;
  }
  const releaseManifest = path.join(root, 'Package.swift.release');
  if (!existsSync(releaseManifest)) {
    fail(`${product} must stage ${rel(releaseManifest)} for release installation`);
  }
  if (existsSync(releaseManifest)) {
    const text = readFileSync(releaseManifest, 'utf8');
    if (text.includes('file://')) {
      fail(`${rel(releaseManifest)} must not contain local file URLs`);
    }
    if (!text.includes('liboliphaunt-native-v') || !text.includes('checksum:')) {
      fail(`${rel(releaseManifest)} must reference checksummed public liboliphaunt assets`);
    }
    const sourceCarrier = path.join(
      root,
      'release-tree/src/sdks/swift/Carriers/oliphaunt-react-native-ios-carriers.json',
    );
    if (!isFile(sourceCarrier)) {
      fail(`${product} must stage its selection-neutral source carrier at ${rel(sourceCarrier)}`);
    }
    try {
      const carrier = validateSelectionNeutralSwiftSourceCarrierFile(
        sourceCarrier,
        rel(sourceCarrier),
        { sourceBasis: nativeSourceBasis },
      );
      validateSwiftSourceReleaseContract({
        carrier,
        expectedNativeVersion: productCompatibilityVersion(
          'oliphaunt-swift',
          'liboliphaunt-native',
          PREFIX,
        ),
        label: `${product} staged source release`,
        manifestText: text,
        sourceBasis: nativeSourceBasis,
      });
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  }
  const generatorRoot = path.join(root, 'extension-generator');
  for (const [name, source] of [
    [
      'extension-owner-catalog.json',
      path.join(ROOT, 'src/extensions/generated/sdk/extensions.json'),
    ],
    [
      'extension-resource-inventory.mjs',
      path.join(ROOT, 'src/native/sdks/swift/tools/extension-resource-inventory.mts'),
    ],
    [
      'render-extension-products.mjs',
      path.join(ROOT, 'src/native/sdks/swift/tools/render-extension-products.mts'),
    ],
    [
      'swift-carrier-resolver.mjs',
      path.join(ROOT, 'src/native/sdks/swift/tools/swift-carrier-resolver.mts'),
    ],
  ]) {
    const frozen = path.join(generatorRoot, name);
    if (!isFile(frozen)) {
      fail(`${product} must stage frozen extension generator input ${rel(frozen)}`);
    }
    const expected =
      name === 'swift-carrier-resolver.mjs'
        ? await bundleJavaScript(source)
        : source.endsWith('.mts')
          ? releaseJavaScript(source)
          : readFileSync(source);
    if (!readFileSync(frozen).equals(expected)) {
      fail(`${rel(frozen)} must byte-for-byte match the release output of ${rel(source)}`);
    }
  }

  return checked;
}

if (import.meta.main) await inspectSdkProduct('oliphaunt-swift', checkSwiftPackage);
