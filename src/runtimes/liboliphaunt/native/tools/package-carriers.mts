#!/usr/bin/env bun
import { copyFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { packageContribNativeCarriers } from '../../../../extensions/artifacts/packages/tools/package-carriers.mts';
import { stageMavenArtifactManifest } from '../../../../sdks/kotlin/tools/maven-artifact-staging.mts';
import { buildMavenArtifactManifest } from '../../../../shared/artifact-packaging/build-maven-artifact-manifest.mts';
import { emitJavaScript } from '../../../../shared/artifact-packaging/emit-javascript.mts';
import {
  extractPortableArchiveTree,
  readPortableArchiveEntries,
} from '../../../../shared/artifact-packaging/portable-archive.mts';
import {
  artifactNpmPackageTargets,
  assertSameStringSet,
  copyStagedRuntimeAssets,
  extractReleaseArchiveFile,
  fail,
  isDirectory,
  isFile,
  packStagedNpmCarrier,
  rel,
  stageNpmPackageDescriptor,
  stageWindowsVcRuntimeMembers,
  TOOL,
  validatePackedNpmPackage,
} from '../../../../shared/artifact-packaging/release-carrier.mts';
import {
  assertReleaseNoticesInArchive,
  assertReleaseNoticesInDirectory,
  releaseNoticeRows,
  stageReleaseNotices,
} from '../../../../shared/artifact-packaging/release-notices.mts';
import { writeChecksumManifest } from '../../../../shared/artifact-packaging/write-checksum-manifest.mts';
import {
  artifactTargets,
  compareText,
  contribCarrierDescriptor,
  currentProductVersionSync,
  ROOT,
  registryPackageRows,
} from '../../../../shared/product-metadata/release-artifact-targets.mts';
import { checkLiboliphauntReleaseAssets } from './check-release-assets.mts';
import {
  assertIcuPackageManifest,
  assertIcuPackedClosureMatchesSource,
  assertPackedIcuCarrier,
  ICU_DATA_RELATIVE_PATH,
  ICU_MANIFEST_RELATIVE_PATH,
  ICU_PODSPEC,
  ICU_REACT_NATIVE_CONFIG,
} from './icu-npm-carrier-contract.mts';
import {
  requiredCoreRuntimePaths,
  requiredRuntimeMemberPaths,
  requiredToolsMemberPaths,
  requiredToolsPackageTools,
  validatePayload,
} from './native-runtime-payload.mts';
import { packageNativeCargoArtifacts } from './package-liboliphaunt-cargo-artifacts.mts';

export const LIBOLIPHAUNT_NATIVE_PRODUCT = 'liboliphaunt-native';

const LIBOLIPHAUNT_NATIVE_KIND = 'native-runtime';

const LIBOLIPHAUNT_NATIVE_TOOLS_PRODUCT = 'oliphaunt-tools';

const LIBOLIPHAUNT_NATIVE_TOOLS_KIND = 'native-tools';

const LIBOLIPHAUNT_NATIVE_PACKAGE_ROOT = path.join(
  ROOT,
  'src/runtimes/liboliphaunt/native/packages',
);

const LIBOLIPHAUNT_NATIVE_TOOLS_PACKAGE_ROOT = path.join(
  ROOT,
  'src/runtimes/liboliphaunt/native/tools-packages',
);

const LIBOLIPHAUNT_NATIVE_TOOLS_FACADE_PACKAGE = '@oliphaunt/tools';

const LIBOLIPHAUNT_NATIVE_TOOLS_FACADE_ROOT = path.join(
  ROOT,
  'src/runtimes/liboliphaunt/native/tools-npm',
);

const LIBOLIPHAUNT_ICU_PACKAGE_NAME = '@oliphaunt/icu';

const LIBOLIPHAUNT_ICU_PACKAGE_ROOT = path.join(ROOT, 'src/runtimes/liboliphaunt/native/icu-npm');

function hasLiboliphauntReleaseArchive(assetDir) {
  if (!isDirectory(assetDir)) {
    return false;
  }
  return readdirSync(assetDir).some(
    (name) =>
      (name.startsWith('liboliphaunt-') || name.startsWith('oliphaunt-tools-')) &&
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
        'oliphaunt-tools-*.tar.gz',
        'oliphaunt-tools-*.zip',
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
    '--pattern',
    'oliphaunt-tools-*.tar.gz',
    '--pattern',
    'oliphaunt-tools-*.zip',
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

function liboliphauntRuntimeNpmPackageTargets(version) {
  return artifactNpmPackageTargets({
    product: LIBOLIPHAUNT_NATIVE_PRODUCT,
    kind: LIBOLIPHAUNT_NATIVE_KIND,
    surface: 'typescript-native-direct',
    packageRoot: LIBOLIPHAUNT_NATIVE_PACKAGE_ROOT,
    version,
  });
}

function liboliphauntToolsNpmPackageTargets(version) {
  return artifactNpmPackageTargets({
    product: LIBOLIPHAUNT_NATIVE_PRODUCT,
    kind: LIBOLIPHAUNT_NATIVE_TOOLS_KIND,
    surface: 'typescript-native-direct',
    packageRoot: LIBOLIPHAUNT_NATIVE_TOOLS_PACKAGE_ROOT,
    version,
  });
}

function embeddedCoreModuleMembers(target, prefix) {
  const suffix =
    target === 'windows-x64-msvc' ? '.dll' : target === 'macos-arm64' ? '.dylib' : '.so';
  const normalizedPrefix = prefix.replace(/\/+$/u, '');
  return ['dict_snowball', 'plpgsql'].map((stem) => `${normalizedPrefix}/${stem}${suffix}`);
}

function stageLiboliphauntNpmPayloads(version) {
  const assetDir = path.join(ROOT, 'target/liboliphaunt/release-assets');
  const stages = new Map();
  for (const [packageName, packageDir, target] of liboliphauntRuntimeNpmPackageTargets(version)) {
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
    extractPortableArchiveTree(archive, path.join(stage, 'cluster-seed'), 'cluster-seed');
    extractPortableArchiveTree(archive, path.join(stage, 'cluster-seed-icu'), 'cluster-seed-icu');
    extractReleaseArchiveFile(
      archive,
      'manifest.properties',
      path.join(stage, 'manifest.properties'),
    );
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
  { assetDir = path.join(ROOT, 'target/liboliphaunt/release-assets'), targetIds } = {},
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
    for (const member of requiredToolsMemberPaths(target.target, 'runtime/bin')) {
      extractReleaseArchiveFile(archive, member, path.join(stage, member), {
        mode: 0o755,
      });
    }
    const vcRuntimeMembers = stageWindowsVcRuntimeMembers(
      archive,
      stage,
      target.target,
      'runtime/bin',
    );
    validatePayload(stage, target.target, { toolSet: 'tools' });
    assertReleaseNoticesInDirectory(stage, { profile: 'native-tools' });
    stages.set(packageName, { stage, vcRuntimeMembers });
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
    'target/liboliphaunt/release-assets',
    `liboliphaunt-${version}-icu-data.tar.gz`,
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

export function liboliphauntNpmTarballs(version) {
  const packages = [];
  const runtimeStages = stageLiboliphauntNpmPayloads(version);
  for (const [packageName, , target] of liboliphauntRuntimeNpmPackageTargets(version)) {
    const payload = runtimeStages.get(packageName);
    const libraryRelativePath = target.libraryRelativePath ?? target.library_relative_path;
    const runtimeMembers = requiredRuntimeMemberPaths(target.target, 'package/runtime/bin');
    const coreRuntimeMembers = requiredCoreRuntimePaths(target.target).map(
      (member) => `package/runtime/${member}`,
    );
    const requiredMembers = [
      `package/${libraryRelativePath}`,
      'package/cluster-seed/manifest.properties',
      'package/cluster-seed/files/PG_VERSION',
      'package/cluster-seed/files/global/pg_control',
      'package/cluster-seed-icu/manifest.properties',
      'package/cluster-seed-icu/files/PG_VERSION',
      'package/cluster-seed-icu/files/global/pg_control',
      'package/manifest.properties',
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
  packages.push(...liboliphauntToolsNpmTarballs(version));
  const icuStage = stageLiboliphauntIcuNpmPayload(version);
  const icuTarball = packStagedNpmCarrier(icuStage);
  validatePackedIcuPackage(
    LIBOLIPHAUNT_ICU_PACKAGE_NAME,
    version,
    icuTarball,
    path.join(
      ROOT,
      'target/liboliphaunt/release-assets',
      `liboliphaunt-${version}-icu-data.tar.gz`,
    ),
  );
  packages.push([LIBOLIPHAUNT_ICU_PACKAGE_NAME, icuTarball]);
  return packages;
}

export function liboliphauntToolsNpmTarballs(version, options = {}) {
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
        ...runtimeMembers,
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

function nativeCargoArtifactTargets(kind) {
  return artifactTargets(LIBOLIPHAUNT_NATIVE_PRODUCT, kind, TOOL)
    .filter((target) => target.surfaces.includes('rust-native-direct'))
    .sort((left, right) => compareText(left.target, right.target));
}

function validateNativeCargoArtifacts(outputDir) {
  const manifestPath = path.join(outputDir, 'packages.json');
  if (!isFile(manifestPath)) {
    fail(
      `missing generated ${LIBOLIPHAUNT_NATIVE_PRODUCT} Cargo artifact manifest: ${rel(manifestPath)}`,
    );
  }
  let data;
  try {
    data = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    fail(`${rel(manifestPath)} is not valid JSON: ${error.message}`);
  }
  if (
    data?.schema !== 'oliphaunt-liboliphaunt-cargo-artifacts-v1' ||
    !Array.isArray(data.packages)
  ) {
    fail(`${rel(manifestPath)} has an invalid liboliphaunt native Cargo artifact schema`);
  }

  const expectedAggregators = new Set([
    ...nativeCargoArtifactTargets(LIBOLIPHAUNT_NATIVE_KIND).map(
      (target) => `${LIBOLIPHAUNT_NATIVE_PRODUCT}-${target.target}`,
    ),
    ...nativeCargoArtifactTargets(LIBOLIPHAUNT_NATIVE_TOOLS_KIND).map(
      (target) => `${LIBOLIPHAUNT_NATIVE_TOOLS_PRODUCT}-${target.target}`,
    ),
  ]);
  const expectedRegistryCrates = new Set([
    ...expectedAggregators,
    LIBOLIPHAUNT_NATIVE_TOOLS_PRODUCT,
  ]);
  const contribArtifactProduct = contribCarrierDescriptor(TOOL).artifactProduct;
  const configuredCrates = new Set(
    registryPackageRows({ product: LIBOLIPHAUNT_NATIVE_PRODUCT, packageKind: 'crates' }, TOOL)
      .map((row) => row.packageName)
      .filter(
        (name) => name !== contribArtifactProduct && !name.startsWith(`${contribArtifactProduct}-`),
      ),
  );
  assertSameStringSet(
    `${LIBOLIPHAUNT_NATIVE_PRODUCT} crates.io packages must match native runtime/tool artifact packages`,
    configuredCrates,
    expectedRegistryCrates,
  );
  const aggregators = new Set();
  const facades = new Set();
  const expectedCratePaths = new Set();
  const packages = [];

  for (const item of data.packages) {
    if (item === null || Array.isArray(item) || typeof item !== 'object') {
      fail(`${rel(manifestPath)} package entries must be objects`);
    }
    const { name, role, manifestPath: rawManifest, cratePath: rawCrate } = item;
    if (
      ![name, role, rawManifest].every((value) => typeof value === 'string' && value.length > 0)
    ) {
      fail(`${rel(manifestPath)} has an invalid package row: ${JSON.stringify(item)}`);
    }
    const sourceManifest = path.join(ROOT, rawManifest);
    if (!isFile(sourceManifest)) {
      fail(
        `missing generated ${LIBOLIPHAUNT_NATIVE_PRODUCT} Cargo source manifest: ${rawManifest}`,
      );
    }
    if (typeof rawCrate !== 'string' || rawCrate.length === 0) {
      fail(
        `generated ${LIBOLIPHAUNT_NATIVE_PRODUCT} registry crate ${name} must freeze a .crate archive`,
      );
    }
    const cratePath = path.join(ROOT, rawCrate);
    if (!isFile(cratePath) || !cratePath.endsWith('.crate')) {
      fail(
        `missing generated ${LIBOLIPHAUNT_NATIVE_PRODUCT} Cargo archive for ${name}: ${rawCrate}`,
      );
    }
    expectedCratePaths.add(path.resolve(cratePath));
    if (role === 'part') {
      const aggregator = name.replace(/-part-\d{3}$/u, '');
      if (aggregator === name || !expectedAggregators.has(aggregator)) {
        fail(`unexpected ${LIBOLIPHAUNT_NATIVE_PRODUCT} Cargo part crate ${name}`);
      }
      packages.push({ name, cratePath, manifestPath: sourceManifest, role });
      continue;
    }
    if (role === 'aggregator') {
      if (!expectedAggregators.has(name)) {
        fail(`unexpected ${LIBOLIPHAUNT_NATIVE_PRODUCT} Cargo aggregator crate ${name}`);
      }
      aggregators.add(name);
      packages.push({ name, cratePath, manifestPath: sourceManifest, role });
      continue;
    }
    if (role === 'facade') {
      if (name !== LIBOLIPHAUNT_NATIVE_TOOLS_PRODUCT) {
        fail(`unexpected ${LIBOLIPHAUNT_NATIVE_PRODUCT} Cargo facade crate ${name}`);
      }
      facades.add(name);
      packages.push({ name, cratePath, manifestPath: sourceManifest, role });
      continue;
    }
    fail(`${rel(manifestPath)} has unsupported Cargo artifact role ${JSON.stringify(role)}`);
  }

  const missingAggregators = [...expectedAggregators]
    .filter((name) => !aggregators.has(name))
    .sort(compareText);
  if (missingAggregators.length > 0) {
    fail(
      `generated ${LIBOLIPHAUNT_NATIVE_PRODUCT} Cargo artifacts are missing aggregator crates: ${missingAggregators.join(', ')}`,
    );
  }
  if (!facades.has(LIBOLIPHAUNT_NATIVE_TOOLS_PRODUCT)) {
    fail(
      `generated ${LIBOLIPHAUNT_NATIVE_PRODUCT} Cargo artifacts are missing ${LIBOLIPHAUNT_NATIVE_TOOLS_PRODUCT} facade crate`,
    );
  }
  const unexpected = readdirSync(outputDir)
    .filter((name) => name.endsWith('.crate'))
    .map((name) => path.join(outputDir, name))
    .filter((file) => !expectedCratePaths.has(path.resolve(file)))
    .map((file) => path.basename(file))
    .sort(compareText);
  if (unexpected.length > 0) {
    fail(
      `unexpected ${LIBOLIPHAUNT_NATIVE_PRODUCT} Cargo artifact crate(s): ${unexpected.join(', ')}`,
    );
  }
  const roleOrder = new Map([
    ['part', 0],
    ['aggregator', 1],
    ['facade', 2],
  ]);
  return packages.sort(
    (left, right) =>
      (roleOrder.get(left.role) ?? 99) - (roleOrder.get(right.role) ?? 99) ||
      compareText(left.name, right.name),
  );
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
