#!/usr/bin/env bun
import path from 'node:path';
import { ROOT, currentProductVersionSync } from '../../tools/release/release-artifact-targets.mts';
import {
  TOOL,
  artifactNpmPackageTargets,
  copyStagedRuntimeAssets,
  extractReleaseArchiveFile,
  fail,
  isDirectory,
  packStagedNpmCarrier,
  rel,
  stageNpmPackageDescriptor,
  stageWindowsVcRuntimeMembers,
  validatePackedNpmPackage,
} from '../../tools/packaging/release-carrier.mts';
import { readdirSync } from 'node:fs';
import { writeChecksumManifest } from '../../tools/packaging/write-checksum-manifest.mts';
import { checkBrokerReleaseAssets } from './check-release-assets.mts';
import {
  assertReleaseNoticesInDirectory,
  releaseNoticeRows,
  stageReleaseNotices,
} from '../../tools/packaging/release-notices.mts';
import {
  BROKER_PAYLOAD_LICENSE,
  assertBrokerDependencyLicensesInArchive,
  assertBrokerDependencyLicensesInDirectory,
  brokerDependencyLicenseMembers,
  normalizeBrokerDependencyLicenseModes,
} from './broker-dependency-license-contract.mts';
import { extractPortableArchiveTree } from '../../tools/packaging/portable-archive.mts';

export const BROKER_PRODUCT = 'oliphaunt-broker';

const BROKER_KIND = 'broker-helper';

const BROKER_PACKAGE_ROOT = path.join(ROOT, 'broker/packages');

function hasBrokerReleaseArchive(assetDir) {
  if (!isDirectory(assetDir)) {
    return false;
  }
  return readdirSync(assetDir).some(
    (name) =>
      name.startsWith('oliphaunt-broker-') && (name.endsWith('.tar.gz') || name.endsWith('.zip')),
  );
}

async function ensureBrokerReleaseAssets() {
  const assetDir = path.join(ROOT, 'target/oliphaunt-broker/release-assets');
  if (!hasBrokerReleaseArchive(assetDir)) {
    copyStagedRuntimeAssets({
      product: BROKER_PRODUCT,
      destination: assetDir,
      envName: 'OLIPHAUNT_BROKER_RELEASE_ASSET_INPUT_DIRS',
      patterns: ['oliphaunt-broker-*.tar.gz', 'oliphaunt-broker-*.zip'],
    });
  }
  const version = currentProductVersionSync(BROKER_PRODUCT, TOOL);
  await writeChecksumManifest([
    '--asset-dir',
    rel(assetDir),
    '--output',
    `oliphaunt-broker-${version}-release-assets.sha256`,
    '--pattern',
    'oliphaunt-broker-*.tar.gz',
    '--pattern',
    'oliphaunt-broker-*.zip',
  ]);
  await checkBrokerReleaseAssets(['--asset-dir', rel(assetDir)]);
}

function brokerNpmPackageTargets(version) {
  return artifactNpmPackageTargets({
    product: BROKER_PRODUCT,
    kind: BROKER_KIND,
    surface: 'typescript-broker',
    packageRoot: BROKER_PACKAGE_ROOT,
    version,
  });
}

export function brokerNpmTarballs(
  version,
  { assetDir = path.join(ROOT, 'target/oliphaunt-broker/release-assets') } = {},
) {
  const tarballs = [];
  for (const [packageName, packageDir, target] of brokerNpmPackageTargets(version)) {
    const executableRelativePath = target.executable_relative_path;
    if (typeof executableRelativePath !== 'string' || executableRelativePath.length === 0) {
      fail(
        `${target.id} must declare executable_relative_path for npm artifact package publication`,
      );
    }
    const stageDir = stageNpmPackageDescriptor(packageName, packageDir, version, {
      target: target.target,
    });
    stageReleaseNotices(stageDir, { profile: 'broker' });
    assertReleaseNoticesInDirectory(stageDir, { profile: 'broker' });
    const archive = path.join(assetDir, target.asset.replaceAll('{version}', version));
    assertBrokerDependencyLicensesInArchive(archive, { target: target.target });
    extractReleaseArchiveFile(
      archive,
      executableRelativePath,
      path.join(stageDir, executableRelativePath),
      { mode: 0o755 },
    );
    extractPortableArchiveTree(
      archive,
      path.join(stageDir, 'THIRD_PARTY_LICENSES/rust'),
      'THIRD_PARTY_LICENSES/rust',
    );
    normalizeBrokerDependencyLicenseModes(stageDir, target.target);
    assertBrokerDependencyLicensesInDirectory(stageDir, { target: target.target });
    const vcRuntimeMembers = stageWindowsVcRuntimeMembers(archive, stageDir, target.target, 'bin');
    const tarball = packStagedNpmCarrier(stageDir);
    const requiredMembers = [
      `package/${executableRelativePath}`,
      ...vcRuntimeMembers.map((member) => `package/${member}`),
      ...releaseNoticeRows({ profile: 'broker' }).map((row) => `package/${row.member}`),
      ...brokerDependencyLicenseMembers(target.target, { prefix: 'package' }),
    ];
    const manifest = validatePackedNpmPackage({
      packageName,
      version,
      tarball,
      requiredMembers,
      executableMembers: [`package/${executableRelativePath}`],
    });
    if (manifest.license !== BROKER_PAYLOAD_LICENSE) {
      fail(`${rel(tarball)} package license must be ${BROKER_PAYLOAD_LICENSE}`);
    }
    assertBrokerDependencyLicensesInArchive(tarball, { target: target.target, prefix: 'package' });
    tarballs.push([packageName, tarball]);
  }
  return tarballs;
}

export async function packageBrokerCarriers() {
  const version = currentProductVersionSync(BROKER_PRODUCT, TOOL);
  await ensureBrokerReleaseAssets();
  brokerNpmTarballs(version);
}

if (import.meta.main) await packageBrokerCarriers();
