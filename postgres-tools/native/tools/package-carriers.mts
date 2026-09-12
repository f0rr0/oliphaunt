#!/usr/bin/env bun
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { emitJavaScript } from '../../../tools/packaging/emit-javascript.mts';
import {
  extractPortableArchiveTree,
  readPortableArchiveEntries,
} from '../../../tools/packaging/portable-archive.mts';
import {
  artifactNpmPackageTargets,
  fail,
  packStagedNpmCarrier,
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
import {
  compareText,
  currentProductVersionSync,
  ROOT,
  artifactTargets,
  registryPackageRows,
} from '../../../tools/release/release-artifact-targets.mts';
import {
  requiredToolsMemberPaths,
  validatePayload,
} from '../../../runtimes/liboliphaunt-native/tools/native-runtime-payload.mts';
import { validateCargoArtifactPackages } from '../../../tools/packaging/native-cargo-payload.mts';
import { packageNativeToolsCargoArtifacts } from './package-cargo-artifacts.mts';
const LIBOLIPHAUNT_NATIVE_PRODUCT = 'postgres-tools-native';
const LIBOLIPHAUNT_NATIVE_TOOLS_KIND = 'native-tools';
const LIBOLIPHAUNT_NATIVE_TOOLS_FACADE_PACKAGE = '@oliphaunt/tools';
const LIBOLIPHAUNT_NATIVE_TOOLS_PACKAGE_ROOT = path.join(
  ROOT,
  'postgres-tools/native/npm-platforms',
);
const LIBOLIPHAUNT_NATIVE_TOOLS_FACADE_ROOT = path.join(ROOT, 'postgres-tools/native/npm');
function liboliphauntToolsNpmPackageTargets(version) {
  return artifactNpmPackageTargets({
    product: LIBOLIPHAUNT_NATIVE_PRODUCT,
    kind: LIBOLIPHAUNT_NATIVE_TOOLS_KIND,
    surface: 'typescript-native-direct',
    packageRoot: LIBOLIPHAUNT_NATIVE_TOOLS_PACKAGE_ROOT,
    version,
  });
}

function selectedLiboliphauntToolsNpmPackageTargets(version, targetIds) {
  const targets = liboliphauntToolsNpmPackageTargets(version);
  if (targetIds === undefined) return targets;
  const selected = new Set(targetIds);
  const filtered = targets.filter(([, , target]) => selected.has(target.target));
  const actual = new Set(filtered.map(([, , target]) => target.target));
  const missing = [...selected].filter((target) => !actual.has(target)).sort(compareText);
  if (missing.length > 0) {
    fail(`unknown native tools npm target(s): ${missing.join(', ')}`);
  }
  return filtered;
}

function stageLiboliphauntToolsNpmPayloads(
  version,
  { assetDir = path.join(ROOT, 'target/postgres-tools/native/release-assets'), targetIds } = {},
) {
  const stages = new Map();
  for (const [packageName, packageDir, target] of selectedLiboliphauntToolsNpmPackageTargets(
    version,
    targetIds,
  )) {
    const stage = stageNpmPackageDescriptor(packageName, packageDir, version, {
      target: target.target,
    });
    stageReleaseNotices(stage, { profile: 'native-tools' });
    const archive = path.join(assetDir, target.asset.replaceAll('{version}', version));
    extractPortableArchiveTree(archive, path.join(stage, 'runtime'), 'runtime');
    const payloadMembers = [...readPortableArchiveEntries(archive).values()]
      .filter((entry) => !entry.isDirectory && entry.name.startsWith('runtime/'))
      .map((entry) => entry.name);
    const vcRuntimeMembers = stageWindowsVcRuntimeMembers(
      archive,
      stage,
      target.target,
      'runtime/bin',
      { alreadyExtracted: true },
    );
    validatePayload(stage, target.target, { toolSet: 'tools' });
    assertReleaseNoticesInDirectory(stage, { profile: 'native-tools' });
    stages.set(packageName, { stage, vcRuntimeMembers, payloadMembers });
  }
  return stages;
}

function stageLiboliphauntToolsNpmFacade(version) {
  const stage = stageNpmPackageDescriptor(
    LIBOLIPHAUNT_NATIVE_TOOLS_FACADE_PACKAGE,
    LIBOLIPHAUNT_NATIVE_TOOLS_FACADE_ROOT,
    version,
  );
  emitJavaScript(
    path.join(LIBOLIPHAUNT_NATIVE_TOOLS_FACADE_ROOT, 'index.mts'),
    path.join(stage, 'index.js'),
  );
  for (const descriptor of ['index.d.ts']) {
    copyFileSync(
      path.join(LIBOLIPHAUNT_NATIVE_TOOLS_FACADE_ROOT, descriptor),
      path.join(stage, descriptor),
    );
  }
  const manifestFile = path.join(stage, 'package.json');
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
  delete manifest.scripts;
  manifest.optionalDependencies = Object.fromEntries(
    Object.keys(manifest.optionalDependencies ?? {})
      .sort(compareText)
      .map((name) => [name, version]),
  );
  writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  stageReleaseNotices(stage, { profile: 'source-sdk' });
  assertReleaseNoticesInDirectory(stage, { profile: 'source-sdk' });
  return stage;
}

export function liboliphauntToolsNpmTarballs(
  version = currentProductVersionSync(LIBOLIPHAUNT_NATIVE_PRODUCT, TOOL),
  options = {},
) {
  const packages = [];
  const toolsStages = stageLiboliphauntToolsNpmPayloads(version, options);
  for (const [packageName, , target] of selectedLiboliphauntToolsNpmPackageTargets(
    version,
    options.targetIds,
  )) {
    const payload = toolsStages.get(packageName);
    const runtimeMembers = requiredToolsMemberPaths(target.target, 'package/runtime/bin');
    const tarball = packStagedNpmCarrier(payload.stage);
    validatePackedNpmPackage({
      packageName,
      version,
      tarball,
      requiredMembers: [
        ...payload.payloadMembers.map((member) => `package/${member}`),
        ...payload.vcRuntimeMembers.map((member) => `package/${member}`),
        ...releaseNoticeRows({ profile: 'native-tools' }).map((row) => `package/${row.member}`),
      ],
      executableMembers: runtimeMembers,
    });
    assertReleaseNoticesInArchive(tarball, { profile: 'native-tools', prefix: 'package' });
    packages.push([packageName, tarball]);
  }
  const toolsFacadeStage = stageLiboliphauntToolsNpmFacade(version);
  const toolsFacadeTarball = packStagedNpmCarrier(toolsFacadeStage);
  validatePackedNpmPackage({
    packageName: LIBOLIPHAUNT_NATIVE_TOOLS_FACADE_PACKAGE,
    version,
    tarball: toolsFacadeTarball,
    requiredMembers: [
      'package/index.js',
      'package/index.d.ts',
      ...releaseNoticeRows({ profile: 'source-sdk' }).map((row) => `package/${row.member}`),
    ],
  });
  assertReleaseNoticesInArchive(toolsFacadeTarball, {
    profile: 'source-sdk',
    prefix: 'package',
  });
  packages.push([LIBOLIPHAUNT_NATIVE_TOOLS_FACADE_PACKAGE, toolsFacadeTarball]);
  return packages;
}

export async function nativeToolsCargoArtifactPackages(
  version = currentProductVersionSync(LIBOLIPHAUNT_NATIVE_PRODUCT, TOOL),
) {
  const outputDir = path.join(ROOT, 'target/postgres-tools/native/cargo-artifacts');
  await packageNativeToolsCargoArtifacts(['--version', version]);
  return validateCargoArtifactPackages(outputDir, {
    product: LIBOLIPHAUNT_NATIVE_PRODUCT,
    expectedAggregators: new Set(
      artifactTargets(LIBOLIPHAUNT_NATIVE_PRODUCT, LIBOLIPHAUNT_NATIVE_TOOLS_KIND, TOOL)
        .filter((t) => t.surfaces.includes('rust-native-direct'))
        .map((t) => 'oliphaunt-tools-' + t.target),
    ),
    expectedFacade: 'oliphaunt-tools',
    configuredCrates: new Set(
      registryPackageRows(
        { product: LIBOLIPHAUNT_NATIVE_PRODUCT, packageKind: 'crates' },
        TOOL,
      ).map((row) => row.packageName),
    ),
  });
}
export async function packageNativeToolsCarriers() {
  const version = currentProductVersionSync(LIBOLIPHAUNT_NATIVE_PRODUCT, TOOL);
  await nativeToolsCargoArtifactPackages(version);
  return liboliphauntToolsNpmTarballs(version);
}
if (import.meta.main) await packageNativeToolsCarriers();
