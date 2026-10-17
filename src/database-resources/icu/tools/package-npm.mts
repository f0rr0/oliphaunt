#!/usr/bin/env bun
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { packGeneratedNpmCarrier } from '../../../../tools/packaging/npm-package.mts';
import {
  extractPortableArchiveTree,
  readPortableArchiveEntries,
} from '../../../../tools/packaging/portable-archive.mts';
import {
  extractReleaseArchiveFile,
  fail,
  rel,
  stageNpmPackageDescriptor,
} from '../../../../tools/packaging/release-carrier.mts';
import {
  assertReleaseNoticesInArchive,
  assertReleaseNoticesInDirectory,
  stageReleaseNotices,
} from '../../../../tools/packaging/release-notices.mts';
import {
  currentProductVersionSync,
  ROOT,
} from '../../../../tools/release/release-artifact-targets.mts';
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
const LIBOLIPHAUNT_ICU_PACKAGE_ROOT = path.join(ROOT, 'src/database-resources/icu/npm');
function stageLiboliphauntIcuNpmPayload(version, context) {
  const packageRoot = context.packageRoot ?? LIBOLIPHAUNT_ICU_PACKAGE_ROOT;
  const stage = stageNpmPackageDescriptor(LIBOLIPHAUNT_ICU_PACKAGE_NAME, packageRoot, version, {
    extraDescriptors: [ICU_PODSPEC],
    target: 'portable',
    ...(context.stageDir === undefined ? {} : { stageDir: context.stageDir }),
  });
  copyFileSync(
    path.join(packageRoot, 'react-native.config.cts'),
    path.join(stage, ICU_REACT_NATIVE_CONFIG),
  );
  const sourceArchive =
    context.sourceArchive ??
    path.join(
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
  stageReleaseNotices(stage, { profile: 'native-icu-data', sourceRoot: context.noticeSourceRoot });
  assertReleaseNoticesInDirectory(stage, {
    profile: 'native-icu-data',
    sourceRoot: context.noticeSourceRoot,
  });
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

function validatePackedIcuPackage(packageName, version, tarball, sourceArchive, context) {
  const packageRoot = context.packageRoot ?? LIBOLIPHAUNT_ICU_PACKAGE_ROOT;
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
      sourceConfig: readFileSync(path.join(packageRoot, 'react-native.config.cts')),
      sourcePodspec: readFileSync(path.join(packageRoot, ICU_PODSPEC)),
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
  assertReleaseNoticesInArchive(tarball, {
    profile: 'native-icu-data',
    prefix: 'package',
    sourceRoot: context.noticeSourceRoot,
  });
}

export function resourceNpmTarballs(
  version = currentProductVersionSync('database-resources'),
  context = {},
) {
  const stage = stageLiboliphauntIcuNpmPayload(version, context);
  const tarball = packGeneratedNpmCarrier(
    stage,
    context.outputDir ?? path.join(ROOT, 'target/release/npm-packages'),
  );
  validatePackedIcuPackage(
    LIBOLIPHAUNT_ICU_PACKAGE_NAME,
    version,
    tarball,
    context.sourceArchive ??
      path.join(
        ROOT,
        'target/database-resources/release-assets',
        `database-resources-${version}-icu-data.tar.gz`,
      ),
    context,
  );
  return [[LIBOLIPHAUNT_ICU_PACKAGE_NAME, tarball]];
}
if (import.meta.main) {
  for (const [name, tarball] of resourceNpmTarballs()) console.log(`${name}\t${tarball}`);
}
