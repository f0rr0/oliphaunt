#!/usr/bin/env bun
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { packageContribNativeCarriers } from '../../../extensions/artifacts/packages/tools/package-carriers.mts';
import { buildMavenArtifactManifest } from '../../../tools/packaging/build-maven-artifact-manifest.mts';
import { stageMavenArtifactManifest } from '../../../tools/packaging/maven-artifact-staging.mts';
import { validateCargoArtifactPackages } from '../../../tools/packaging/native-cargo-payload.mts';
import { extractPortableArchiveTree } from '../../../tools/packaging/portable-archive.mts';
import {
  artifactNpmPackageTargets,
  copyStagedRuntimeAssets,
  extractReleaseArchiveFile,
  fail,
  isDirectory,
  packStagedNpmCarrier,
  rel,
  stageNpmPackageDescriptor,
  stageWindowsVcRuntimeMembers,
  TOOL,
  validatePackedNpmPackage,
} from '../../../tools/packaging/release-carrier.mts';
import {
  assertReleaseNoticesInArchive,
  assertReleaseNoticesInDirectory,
  releaseNoticeRows,
  stageReleaseNotices,
} from '../../../tools/packaging/release-notices.mts';
import { writeChecksumManifest } from '../../../tools/packaging/write-checksum-manifest.mts';
import {
  artifactTargets,
  compareText,
  contribCarrierDescriptor,
  currentProductVersionSync,
  ROOT,
  registryPackageRows,
} from '../../../tools/release/release-artifact-targets.mts';
import { checkLiboliphauntReleaseAssets } from './check-release-assets.mts';
import {
  requiredCoreRuntimePaths,
  requiredRuntimeMemberPaths,
  requiredToolsPackageTools,
  validatePayload,
} from './native-runtime-payload.mts';
import { packageNativeCargoArtifacts } from './package-liboliphaunt-cargo-artifacts.mts';

export const LIBOLIPHAUNT_NATIVE_PRODUCT = 'liboliphaunt-native';

const LIBOLIPHAUNT_NATIVE_KIND = 'native-runtime';

const LIBOLIPHAUNT_NATIVE_PACKAGE_ROOT = path.join(ROOT, 'runtimes/liboliphaunt-native/packages');

function hasLiboliphauntReleaseArchive(assetDir) {
  if (!isDirectory(assetDir)) {
    return false;
  }
  return readdirSync(assetDir).some(
    (name) =>
      name.startsWith('liboliphaunt-') &&
      (name.endsWith('.tar.gz') || name.endsWith('.zip') || name.endsWith('.tsv')),
  );
}

async function ensureLiboliphauntReleaseAssets() {
  const assetDir = path.join(ROOT, 'target/liboliphaunt/release-assets');
  if (!hasLiboliphauntReleaseArchive(assetDir)) {
    copyStagedRuntimeAssets({
      product: LIBOLIPHAUNT_NATIVE_PRODUCT,
      destination: assetDir,
      envName: 'OLIPHAUNT_LIBOLIPHAUNT_RELEASE_ASSET_INPUT_DIRS',
      patterns: [
        'liboliphaunt-*.tar.gz',
        'liboliphaunt-*.zip',
        'liboliphaunt-*.tsv',
        'liboliphaunt-*.sha256',
      ],
    });
  }
  const version = currentProductVersionSync(LIBOLIPHAUNT_NATIVE_PRODUCT, TOOL);
  await writeChecksumManifest([
    '--asset-dir',
    rel(assetDir),
    '--output',
    `liboliphaunt-${version}-release-assets.sha256`,
    '--pattern',
    'liboliphaunt-*.tar.gz',
    '--pattern',
    'liboliphaunt-*.zip',
    '--pattern',
    'liboliphaunt-*.tsv',
  ]);
  await checkLiboliphauntReleaseAssets(['--asset-dir', rel(assetDir)]);
}

function ensureNativeToolsAbsentFromRuntime(stage, target) {
  const runtimeDir = path.join(stage, 'runtime');
  const leaked = [];
  for (const tool of requiredToolsPackageTools(target, runtimeDir)) {
    if (existsSync(path.join(runtimeDir, 'bin', tool))) {
      leaked.push(`runtime/bin/${tool}`);
    }
  }
  if (leaked.length > 0) {
    fail(
      `${rel(stage)} root runtime package must not contain split native tools: ${leaked.join(', ')}`,
    );
  }
}

function liboliphauntRuntimeNpmPackageTargets(version, targets) {
  const available = artifactNpmPackageTargets({
    product: LIBOLIPHAUNT_NATIVE_PRODUCT,
    kind: LIBOLIPHAUNT_NATIVE_KIND,
    surface: 'typescript-native-direct',
    packageRoot: LIBOLIPHAUNT_NATIVE_PACKAGE_ROOT,
    version,
  });
  if (!targets) return available;
  for (const target of targets) {
    if (!available.some((row) => row[2].target === target))
      fail(`unsupported native npm carrier target: ${target}`);
  }
  return available.filter((row) => targets.includes(row[2].target));
}

function embeddedCoreModuleMembers(target, prefix) {
  const suffix =
    target === 'windows-x64-msvc' ? '.dll' : target === 'macos-arm64' ? '.dylib' : '.so';
  const normalizedPrefix = prefix.replace(/\/+$/u, '');
  return ['dict_snowball', 'plpgsql'].map((stem) => `${normalizedPrefix}/${stem}${suffix}`);
}

function stageLiboliphauntNpmPayloads(
  version,
  { assetDir = path.join(ROOT, 'target/liboliphaunt/release-assets'), targets } = {},
) {
  const stages = new Map();
  for (const [packageName, packageDir, target] of liboliphauntRuntimeNpmPackageTargets(
    version,
    targets,
  )) {
    const libraryRelativePath = target.libraryRelativePath ?? target.library_relative_path;
    if (typeof libraryRelativePath !== 'string' || libraryRelativePath.length === 0) {
      fail(`${target.id} must declare library_relative_path for npm artifact package publication`);
    }
    const stage = stageNpmPackageDescriptor(packageName, packageDir, version, {
      target: target.target,
    });
    stageReleaseNotices(stage, { profile: 'native-runtime' });
    const archive = path.join(assetDir, target.asset.replaceAll('{version}', version));
    extractReleaseArchiveFile(archive, libraryRelativePath, path.join(stage, libraryRelativePath));
    extractPortableArchiveTree(archive, path.join(stage, 'lib/modules'), 'lib/modules');
    extractPortableArchiveTree(archive, path.join(stage, 'runtime'), 'runtime');
    const vcRuntimeMembers = [
      ...stageWindowsVcRuntimeMembers(archive, stage, target.target, 'bin', {
        profile: 'provider',
      }),
      ...stageWindowsVcRuntimeMembers(archive, stage, target.target, 'runtime/bin', {
        alreadyExtracted: true,
        profile: 'provider',
      }),
    ];
    ensureNativeToolsAbsentFromRuntime(stage, target.target);
    validatePayload(stage, target.target, { toolSet: 'runtime' });
    assertReleaseNoticesInDirectory(stage, { profile: 'native-runtime' });
    stages.set(packageName, { stage, vcRuntimeMembers });
  }
  return stages;
}

export function liboliphauntNpmTarballs(version, options = {}) {
  const packages = [];
  const runtimeStages = stageLiboliphauntNpmPayloads(version, options);
  for (const [packageName, , target] of liboliphauntRuntimeNpmPackageTargets(
    version,
    options.targets,
  )) {
    const payload = runtimeStages.get(packageName);
    const libraryRelativePath = target.libraryRelativePath ?? target.library_relative_path;
    const runtimeMembers = requiredRuntimeMemberPaths(target.target, 'package/runtime/bin');
    const coreRuntimeMembers = requiredCoreRuntimePaths(target.target).map(
      (member) => `package/runtime/${member}`,
    );
    const requiredMembers = [
      `package/${libraryRelativePath}`,
      ...embeddedCoreModuleMembers(target.target, 'package/lib/modules'),
      ...runtimeMembers,
      ...coreRuntimeMembers,
      ...payload.vcRuntimeMembers.map((member) => `package/${member}`),
      ...releaseNoticeRows({ profile: 'native-runtime' }).map((row) => `package/${row.member}`),
    ];
    const tarball = packStagedNpmCarrier(payload.stage);
    validatePackedNpmPackage({
      packageName,
      version,
      tarball,
      requiredMembers,
      executableMembers: runtimeMembers,
    });
    assertReleaseNoticesInArchive(tarball, { profile: 'native-runtime', prefix: 'package' });
    packages.push([packageName, tarball]);
  }
  return packages;
}

function nativeCargoArtifactTargets(kind) {
  return artifactTargets(LIBOLIPHAUNT_NATIVE_PRODUCT, kind, TOOL)
    .filter((target) => target.surfaces.includes('rust-native-direct'))
    .sort((left, right) => compareText(left.target, right.target));
}

function validateNativeCargoArtifacts(outputDir) {
  const expectedAggregators = new Set(
    nativeCargoArtifactTargets(LIBOLIPHAUNT_NATIVE_KIND).map(
      (target) => `${LIBOLIPHAUNT_NATIVE_PRODUCT}-${target.target}`,
    ),
  );
  const contribArtifactProduct = contribCarrierDescriptor(TOOL).artifactProduct;
  const configuredCrates = new Set(
    registryPackageRows({ product: LIBOLIPHAUNT_NATIVE_PRODUCT, packageKind: 'crates' }, TOOL)
      .map((row) => row.packageName)
      .filter(
        (name) => name !== contribArtifactProduct && !name.startsWith(`${contribArtifactProduct}-`),
      ),
  );
  return validateCargoArtifactPackages(outputDir, {
    product: LIBOLIPHAUNT_NATIVE_PRODUCT,
    expectedAggregators,
    configuredCrates,
  });
}

export async function liboliphauntNativeCargoArtifactPackages(
  version = currentProductVersionSync(LIBOLIPHAUNT_NATIVE_PRODUCT, TOOL),
) {
  const outputDir = path.join(ROOT, 'target/liboliphaunt/cargo-artifacts');
  await ensureLiboliphauntReleaseAssets();
  await packageNativeCargoArtifacts(['--version', version, '--output-dir', rel(outputDir)]);
  return validateNativeCargoArtifacts(outputDir);
}

export async function packageLiboliphauntNativeCarriers() {
  const version = currentProductVersionSync(LIBOLIPHAUNT_NATIVE_PRODUCT, TOOL);
  await liboliphauntNativeCargoArtifactPackages(version);
  liboliphauntNpmTarballs(version);
  const contribProduct = contribCarrierDescriptor(TOOL).artifactProduct;
  const manifest = await buildMavenArtifactManifest(
    'target/release/maven-manifests/liboliphaunt-native.tsv',
    {
      runtime: true,
      extensions: true,
      extensionProducts: [contribProduct],
    },
  );
  await stageMavenArtifactManifest(
    manifest,
    path.join(ROOT, 'target/release/maven-staging/liboliphaunt-native'),
  );
  await packageContribNativeCarriers();
}

if (import.meta.main) await packageLiboliphauntNativeCarriers();
