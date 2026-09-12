#!/usr/bin/env bun
import path from 'node:path';
import {
  ROOT,
  artifactTargets,
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
import { assertWasixNapiNpmArchive, checkWasixNapiReleaseAssets } from './check-release-assets.mts';

export const WASIX_NAPI_PRODUCT = 'oliphaunt-wasix-napi';

const WASIX_NAPI_KIND = 'wasix-napi-addon';

const WASIX_NAPI_PACKAGE_ROOT = path.join(ROOT, 'sdks/ts-wasix/node-addon/packages');

function hasWasixNapiReleaseArchive(assetDir) {
  if (!isDirectory(assetDir)) {
    return false;
  }
  return readdirSync(assetDir).some(
    (name) =>
      name.startsWith('oliphaunt-wasix-napi-') &&
      (name.endsWith('.tar.gz') || name.endsWith('.zip')),
  );
}

async function ensureWasixNapiReleaseAssets() {
  const assetDir = path.join(ROOT, 'target/oliphaunt-wasix-napi/release-assets');
  if (!hasWasixNapiReleaseArchive(assetDir)) {
    copyStagedRuntimeAssets({
      product: WASIX_NAPI_PRODUCT,
      destination: assetDir,
      envName: 'OLIPHAUNT_WASIX_NAPI_ASSET_INPUT_DIRS',
      patterns: ['oliphaunt-wasix-napi-*.tar.gz', 'oliphaunt-wasix-napi-*.zip'],
    });
  }
  const version = currentProductVersionSync(WASIX_NAPI_PRODUCT, TOOL);
  await writeChecksumManifest([
    '--asset-dir',
    rel(assetDir),
    '--output',
    `oliphaunt-wasix-napi-${version}-release-assets.sha256`,
    '--pattern',
    'oliphaunt-wasix-napi-*.tar.gz',
    '--pattern',
    'oliphaunt-wasix-napi-*.zip',
  ]);
  await checkWasixNapiReleaseAssets(['--asset-dir', rel(assetDir)]);
}

function wasixNapiOptionalPackageTargets(version) {
  return artifactNpmPackageTargets({
    product: WASIX_NAPI_PRODUCT,
    kind: WASIX_NAPI_KIND,
    surface: 'npm-optional',
    packageRoot: WASIX_NAPI_PACKAGE_ROOT,
    version,
  });
}

export async function wasixNapiOptionalNpmTarballs(version) {
  const targets = artifactTargets(WASIX_NAPI_PRODUCT, WASIX_NAPI_KIND, TOOL);
  const tarballs = [];
  const packageDir = path.join(ROOT, 'target/oliphaunt-wasix-napi/npm-packages');
  for (const [packageName] of wasixNapiOptionalPackageTargets(version)) {
    const tarball = path.join(
      packageDir,
      `${safeNpmPackageFilenamePrefix(packageName)}-${version}.tgz`,
    );
    if (!isFile(tarball)) {
      fail(`missing WASIX Node-API optional npm package artifact: ${rel(tarball)}`);
    }
    try {
      assertWasixNapiNpmArchive(tarball, targets, version);
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
    tarballs.push([packageName, tarball]);
  }
  const expected = new Set(tarballs.map(([, tarball]) => path.resolve(tarball)));
  const unexpected = isDirectory(packageDir)
    ? readdirSync(packageDir)
        .filter((name) => name.endsWith('.tgz'))
        .map((name) => path.join(packageDir, name))
        .filter((file) => !expected.has(path.resolve(file)))
        .map((file) => path.basename(file))
        .sort(compareText)
    : [];
  if (unexpected.length > 0) {
    fail(`unexpected WASIX Node-API optional npm package artifact(s): ${unexpected.join(', ')}`);
  }
  return tarballs;
}

export async function packageWasixNapiCarriers() {
  await ensureWasixNapiReleaseAssets();
  await wasixNapiOptionalNpmTarballs(currentProductVersionSync(WASIX_NAPI_PRODUCT, TOOL));
}

if (import.meta.main) await packageWasixNapiCarriers();
