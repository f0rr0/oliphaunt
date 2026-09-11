#!/usr/bin/env bun
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  extractPortableArchiveTree,
  readPortableArchiveEntries,
} from '../../../tools/packaging/portable-archive.mts';
import {
  extractReleaseArchiveFile,
  fail,
  packStagedNpmCarrier,
  rel,
  stageNpmPackageDescriptor,
} from '../../../tools/packaging/release-carrier.mts';
import {
  assertReleaseNoticesInArchive,
  assertReleaseNoticesInDirectory,
  stageReleaseNotices,
} from '../../../tools/packaging/release-notices.mts';
import {
  currentProductVersionSync,
  ROOT,
} from '../../../tools/release/release-artifact-targets.mts';
import {
  assertIcuPackageManifest,
  assertIcuPackedClosureMatchesSource,
  assertPackedIcuCarrier,
  ICU_DATA_RELATIVE_PATH,
  ICU_MANIFEST_RELATIVE_PATH,
  ICU_PODSPEC,
  ICU_REACT_NATIVE_CONFIG,
} from './icu-npm-carrier-contract.mts';

const LIBOLIPHAUNT_ICU_PACKAGE_NAME = '@oliphaunt/icu';
const LIBOLIPHAUNT_ICU_PACKAGE_ROOT = path.join(ROOT, 'database-resources/icu/npm');
function stageLiboliphauntIcuNpmPayload(version) {
  const stage = stageNpmPackageDescriptor(
    LIBOLIPHAUNT_ICU_PACKAGE_NAME,
    LIBOLIPHAUNT_ICU_PACKAGE_ROOT,
    version,
    {
      extraDescriptors: [ICU_PODSPEC],
      target: 'portable',
    },
  );
  copyFileSync(
    path.join(LIBOLIPHAUNT_ICU_PACKAGE_ROOT, 'react-native.config.cts'),
    path.join(stage, ICU_REACT_NATIVE_CONFIG),
  );
  const sourceArchive = path.join(
    ROOT,
    'target/database-resources/release-assets',
    `database-resources-${version}-icu-data.tar.gz`,
  );
  extractPortableArchiveTree(
    sourceArchive,
    path.join(stage, ...ICU_DATA_RELATIVE_PATH.split('/')),
    'share/icu',
  );
  extractReleaseArchiveFile(
    sourceArchive,
    'manifest.properties',
    path.join(stage, ...ICU_MANIFEST_RELATIVE_PATH.split('/')),
  );
  const manifestFile = path.join(stage, 'package.json');
  const packageJson = JSON.parse(readFileSync(manifestFile, 'utf8'));
  const icuReceipt = readFileSync(
    path.join(stage, ...ICU_MANIFEST_RELATIVE_PATH.split('/')),
    'utf8',
  );
  const digest = /^icuDataTreeSha256=([0-9a-f]{64})$/mu.exec(icuReceipt)?.[1];
  if (digest === undefined) {
    fail(`${rel(sourceArchive)} has no canonical ICU data tree digest`);
  }
  packageJson.oliphaunt.icuDataTreeSha256 = digest;
  writeFileSync(manifestFile, `${JSON.stringify(packageJson, null, 2)}\n`);
  stageReleaseNotices(stage, { profile: 'native-icu-data' });
  assertReleaseNoticesInDirectory(stage, { profile: 'native-icu-data' });
  try {
    assertIcuPackageManifest(
      JSON.parse(readFileSync(path.join(stage, 'package.json'), 'utf8')),
      `${rel(stage)} package.json`,
    );
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  return stage;
}

function validatePackedIcuPackage(packageName, version, tarball, sourceArchive) {
  let entries;
  let sourceEntries;
  try {
    entries = readPortableArchiveEntries(tarball);
    sourceEntries = readPortableArchiveEntries(sourceArchive);
  } catch (error) {
    fail(`ICU carrier archives are invalid: ${error.message}`);
  }
  if (!entries.has('package/package.json')) {
    fail(`${rel(tarball)} is missing package/package.json`);
  }
  let packageJson;
  try {
    const packageData = entries.get('package/package.json')?.data();
    if (packageData === undefined) {
      fail(`${rel(tarball)} package/package.json could not be read`);
    }
    packageJson = JSON.parse(Buffer.from(packageData).toString('utf8'));
  } catch (error) {
    fail(`${rel(tarball)} package/package.json is not valid JSON: ${error.message}`);
  }
  if (packageJson.name !== packageName) {
    fail(
      `${rel(tarball)} package name must be ${packageName}, got ${JSON.stringify(packageJson.name)}`,
    );
  }
  if (packageJson.version !== version) {
    fail(
      `${rel(tarball)} package version must be ${version}, got ${JSON.stringify(packageJson.version)}`,
    );
  }
  try {
    assertPackedIcuCarrier({
      entries: [...entries].map(([name, entry]) => ({ name, isFile: entry.isFile })),
      packageJson,
      packedConfig: entries.get(`package/${ICU_REACT_NATIVE_CONFIG}`)?.data(),
      packedPodspec: entries.get(`package/${ICU_PODSPEC}`)?.data(),
      sourceConfig: readFileSync(
        path.join(LIBOLIPHAUNT_ICU_PACKAGE_ROOT, 'react-native.config.cts'),
      ),
      sourcePodspec: readFileSync(path.join(LIBOLIPHAUNT_ICU_PACKAGE_ROOT, ICU_PODSPEC)),
      label: rel(tarball),
    });
    assertIcuPackedClosureMatchesSource({
      packedEntries: entries,
      sourceEntries,
      packageJson,
      label: rel(tarball),
      sourceLabel: rel(sourceArchive),
    });
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  assertReleaseNoticesInArchive(tarball, { profile: 'native-icu-data', prefix: 'package' });
}

export function resourceNpmTarballs(version = currentProductVersionSync('database-resources')) {
  const stage = stageLiboliphauntIcuNpmPayload(version);
  const tarball = packStagedNpmCarrier(stage);
  validatePackedIcuPackage(
    LIBOLIPHAUNT_ICU_PACKAGE_NAME,
    version,
    tarball,
    path.join(
      ROOT,
      'target/database-resources/release-assets',
      `database-resources-${version}-icu-data.tar.gz`,
    ),
  );
  return [[LIBOLIPHAUNT_ICU_PACKAGE_NAME, tarball]];
}
if (import.meta.main) {
  for (const [name, tarball] of resourceNpmTarballs()) console.log(`${name}\t${tarball}`);
}
