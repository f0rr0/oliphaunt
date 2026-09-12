#!/usr/bin/env bun
import path from 'node:path';
import {
  ROOT,
  compareText,
  currentProductVersionSync,
} from '../../../../tools/release/release-artifact-targets.mts';
import {
  TOOL,
  artifactNpmPackageTargets,
  copyStagedRuntimeAssets,
  fail,
  isDirectory,
  isFile,
  rel,
  safeNpmPackageFilenamePrefix,
} from '../../../../tools/packaging/release-carrier.mts';
import { readdirSync } from 'node:fs';
import { writeChecksumManifest } from '../../../../tools/packaging/write-checksum-manifest.mts';
import { checkNodeDirectReleaseAssets } from './check-release-assets.mts';
import { readPortableArchiveEntries } from '../../../../tools/packaging/portable-archive.mts';

export const NODE_DIRECT_PRODUCT = 'oliphaunt-node-direct';

const NODE_DIRECT_KIND = 'node-direct-addon';

const NODE_DIRECT_PACKAGE_ROOT = path.join(ROOT, 'sdks/ts/node-addon/packages');

function hasNodeDirectReleaseArchive(assetDir) {
  if (!isDirectory(assetDir)) {
    return false;
  }
  return readdirSync(assetDir).some(
    (name) =>
      name.startsWith('oliphaunt-node-direct-') &&
      (name.endsWith('.tar.gz') || name.endsWith('.zip')),
  );
}

async function ensureNodeDirectReleaseAssets() {
  const assetDir = path.join(ROOT, 'target/oliphaunt-node-direct/release-assets');
  if (!hasNodeDirectReleaseArchive(assetDir)) {
    copyStagedRuntimeAssets({
      product: NODE_DIRECT_PRODUCT,
      destination: assetDir,
      envName: 'OLIPHAUNT_NODE_ADDON_ASSET_INPUT_DIRS',
      patterns: ['oliphaunt-node-direct-*.tar.gz', 'oliphaunt-node-direct-*.zip'],
    });
  }
  const version = currentProductVersionSync(NODE_DIRECT_PRODUCT, TOOL);
  await writeChecksumManifest([
    '--asset-dir',
    rel(assetDir),
    '--output',
    `oliphaunt-node-direct-${version}-release-assets.sha256`,
    '--pattern',
    'oliphaunt-node-direct-*.tar.gz',
    '--pattern',
    'oliphaunt-node-direct-*.zip',
  ]);
  await checkNodeDirectReleaseAssets(['--asset-dir', rel(assetDir)]);
}

function nodeDirectOptionalPackageTargets(version) {
  return artifactNpmPackageTargets({
    product: NODE_DIRECT_PRODUCT,
    kind: NODE_DIRECT_KIND,
    surface: 'npm-optional',
    packageRoot: NODE_DIRECT_PACKAGE_ROOT,
    version,
  });
}

function nodeDirectNpmPackageDir() {
  return path.join(ROOT, 'target/oliphaunt-node-direct/npm-packages');
}

function expectedNodeDirectNpmTarball(packageName, version) {
  return path.join(
    nodeDirectNpmPackageDir(),
    `${safeNpmPackageFilenamePrefix(packageName)}-${version}.tgz`,
  );
}

async function validateNodeDirectOptionalTarball(packageName, version, tarball) {
  if (!isFile(tarball)) {
    fail(`missing Node direct optional npm package artifact: ${rel(tarball)}`);
  }
  let entries;
  try {
    entries = readPortableArchiveEntries(tarball);
  } catch (error) {
    fail(`${rel(tarball)} is not a valid Node direct optional npm tarball: ${error.message}`);
  }
  for (const required of ['package/package.json', 'package/prebuilds/oliphaunt_node.node']) {
    if (!entries.has(required)) {
      fail(`${rel(tarball)} is missing ${required}`);
    }
  }
  const prebuild = entries.get('package/prebuilds/oliphaunt_node.node');
  if (!prebuild.isFile || prebuild.size <= 0) {
    fail(`${rel(tarball)} prebuilt addon must be a non-empty regular file`);
  }
  let packageJson;
  try {
    const packageData = entries.get('package/package.json')?.data() ?? null;
    if (packageData === null) {
      fail(`${rel(tarball)} package/package.json could not be read`);
    }
    packageJson = JSON.parse(packageData.toString('utf8'));
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
}

export async function nodeDirectOptionalNpmTarballs(version) {
  const tarballs = [];
  for (const [packageName] of nodeDirectOptionalPackageTargets(version)) {
    const tarball = expectedNodeDirectNpmTarball(packageName, version);
    await validateNodeDirectOptionalTarball(packageName, version, tarball);
    tarballs.push([packageName, tarball]);
  }
  const expected = new Set(tarballs.map(([, tarball]) => path.resolve(tarball)));
  const unexpected = isDirectory(nodeDirectNpmPackageDir())
    ? readdirSync(nodeDirectNpmPackageDir())
        .filter((name) => name.endsWith('.tgz'))
        .map((name) => path.join(nodeDirectNpmPackageDir(), name))
        .filter((file) => !expected.has(path.resolve(file)))
        .map((file) => path.basename(file))
        .sort(compareText)
    : [];
  if (unexpected.length > 0) {
    fail(`unexpected Node direct optional npm package artifact(s): ${unexpected.join(', ')}`);
  }
  return tarballs;
}

export async function packageNodeDirectCarriers() {
  await ensureNodeDirectReleaseAssets();
  await nodeDirectOptionalNpmTarballs(currentProductVersionSync(NODE_DIRECT_PRODUCT, TOOL));
}

if (import.meta.main) await packageNodeDirectCarriers();
