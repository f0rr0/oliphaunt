#!/usr/bin/env bun
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  extensionPackageDir,
  packageExtensionNpmCarriers,
} from '../../../extensions/artifacts/packages/tools/package-carriers.mts';
import {
  assertSameStringSet,
  copyStagedRuntimeAssets,
  fail,
  isDirectory,
  isFile,
  rel,
  TOOL,
} from '../../../tools/packaging/release-carrier.mts';
import { writeChecksumManifest } from '../../../tools/packaging/write-checksum-manifest.mts';
import {
  compareText,
  contribCarrierDescriptor,
  currentProductVersionSync,
  ROOT,
  registryPackageRows,
} from '../../../tools/release/release-artifact-targets.mts';
import { main as checkWasixReleaseAssets } from './check-release-assets.mts';
import { packageWasixCargoArtifacts } from './package_liboliphaunt_wasix_cargo_artifacts.mts';
import {
  WASIX_CARGO_ARTIFACT_SCHEMA,
  publicCargoPackageNames as wasixPublicCargoPackageNames,
} from './wasix-cargo-artifact-contract.mts';
import {
  expectedWasixExtensionPackageInventory,
  isExpectedWasixExtensionPackage,
  validateWasixExtensionArtifactInventory,
} from './wasix-extension-cargo-artifact-inventory.mts';
import { packWasixRuntimeNpmCarrier } from './wasix-runtime-npm-carrier.mts';

export const WASIX_PRODUCT = 'liboliphaunt-wasix';

function hasWasixReleaseArchive(assetDir) {
  if (!isDirectory(assetDir)) {
    return false;
  }
  return readdirSync(assetDir).some(
    (name) => name.startsWith('liboliphaunt-wasix-') && name.endsWith('.tar.zst'),
  );
}

async function ensureWasixReleaseAssets() {
  const assetDir = path.join(ROOT, 'target/oliphaunt-wasix/release-assets');
  if (!hasWasixReleaseArchive(assetDir)) {
    copyStagedRuntimeAssets({
      product: WASIX_PRODUCT,
      destination: assetDir,
      envName: 'OLIPHAUNT_WASIX_RELEASE_ASSET_INPUT_DIRS',
      patterns: ['liboliphaunt-wasix-*.tar.zst'],
    });
  }
  const version = currentProductVersionSync(WASIX_PRODUCT, TOOL);
  await writeChecksumManifest([
    '--asset-dir',
    rel(assetDir),
    '--output',
    `liboliphaunt-wasix-${version}-release-assets.sha256`,
    '--pattern',
    'liboliphaunt-wasix-*.tar.zst',
  ]);
  checkWasixReleaseAssets(['--asset-dir', rel(assetDir), '--version', version]);
}

export function validateWasixCargoArtifacts(outputDir) {
  const manifestPath = path.join(outputDir, 'packages.json');
  if (!isFile(manifestPath)) {
    fail(`missing generated ${WASIX_PRODUCT} Cargo artifact manifest: ${rel(manifestPath)}`);
  }
  let data;
  try {
    data = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    fail(`${rel(manifestPath)} is not valid JSON: ${error.message}`);
  }
  if (data?.schema !== WASIX_CARGO_ARTIFACT_SCHEMA || !Array.isArray(data.packages)) {
    fail(`${rel(manifestPath)} has an invalid WASIX Cargo artifact schema`);
  }

  const contribProduct = contribCarrierDescriptor(TOOL).artifactProduct;
  const expectedBaseCrates = new Set(wasixPublicCargoPackageNames());
  const expectedExtensionInventory = expectedWasixExtensionPackageInventory(TOOL, [contribProduct]);
  const expectedConfiguredCrates = new Set([
    ...expectedBaseCrates,
    ...expectedExtensionInventory.expectedPackageKinds.keys(),
  ]);
  const configuredCrates = new Set(
    registryPackageRows({ product: WASIX_PRODUCT, packageKind: 'crates' }, TOOL).map(
      (row) => row.packageName,
    ),
  );
  assertSameStringSet(
    `${WASIX_PRODUCT} crates.io packages must match WASIX runtime/AOT artifact packages`,
    configuredCrates,
    expectedConfiguredCrates,
  );
  const generatedCrates = new Set();
  const expectedCratePaths = new Set();
  try {
    validateWasixExtensionArtifactInventory(data.packages, expectedExtensionInventory);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  const packages = [];
  const allowedKinds = new Set([
    'wasix-runtime',
    'wasix-aot',
    'wasix-extension',
    'wasix-extension-aot',
  ]);
  for (const item of data.packages) {
    if (item === null || Array.isArray(item) || typeof item !== 'object') {
      fail(`${rel(manifestPath)} package entries must be objects`);
    }
    const { name, role, kind, manifestPath: rawManifest, cratePath: rawCrate } = item;
    if (
      ![name, role, kind, rawManifest].every(
        (value) => typeof value === 'string' && value.length > 0,
      )
    ) {
      fail(`${rel(manifestPath)} has an invalid package row: ${JSON.stringify(item)}`);
    }
    if (role !== 'artifact') {
      fail(
        `${rel(manifestPath)} must contain direct WASIX artifact packages, got role ${JSON.stringify(role)}`,
      );
    }
    if (!allowedKinds.has(kind)) {
      fail(
        `${rel(manifestPath)} has unsupported WASIX Cargo artifact kind ${JSON.stringify(kind)}`,
      );
    }
    if (
      !expectedBaseCrates.has(name) &&
      !isExpectedWasixExtensionPackage(name, kind, expectedExtensionInventory)
    ) {
      fail(`unexpected ${WASIX_PRODUCT} Cargo artifact crate ${name}`);
    }
    const sourceManifest = path.join(ROOT, rawManifest);
    if (!isFile(sourceManifest)) {
      fail(`missing generated ${WASIX_PRODUCT} Cargo source manifest: ${rawManifest}`);
    }
    if (typeof rawCrate !== 'string' || rawCrate.length === 0) {
      fail(`generated ${WASIX_PRODUCT} Cargo artifact ${name} must have a cratePath`);
    }
    const cratePath = path.join(ROOT, rawCrate);
    if (!isFile(cratePath)) {
      fail(`missing generated ${WASIX_PRODUCT} Cargo artifact crate for ${name}: ${rawCrate}`);
    }
    generatedCrates.add(name);
    expectedCratePaths.add(path.resolve(cratePath));
    packages.push({ name, cratePath, manifestPath: sourceManifest });
  }

  const missingBaseCrates = [...expectedBaseCrates]
    .filter((name) => !generatedCrates.has(name))
    .sort(compareText);
  if (missingBaseCrates.length > 0) {
    fail(
      `generated ${WASIX_PRODUCT} Cargo artifacts are missing configured runtime crates: ${missingBaseCrates.join(', ')}`,
    );
  }
  const unexpected = readdirSync(outputDir)
    .filter((name) => name.endsWith('.crate'))
    .map((name) => path.join(outputDir, name))
    .filter((file) => !expectedCratePaths.has(path.resolve(file)))
    .map((file) => path.basename(file))
    .sort(compareText);
  if (unexpected.length > 0) {
    fail(`unexpected ${WASIX_PRODUCT} Cargo artifact crate(s): ${unexpected.join(', ')}`);
  }
  return packages.sort((left, right) => compareText(left.name, right.name));
}

export async function liboliphauntWasixCargoArtifactPackages(
  version = currentProductVersionSync(WASIX_PRODUCT, TOOL),
  { extensionArtifactRoots = [] } = {},
) {
  const outputDir = path.join(ROOT, 'target/oliphaunt-wasix/cargo-artifacts');
  await ensureWasixReleaseAssets();
  const args = ['--version', version, '--output-dir', rel(outputDir)];
  for (const root of extensionArtifactRoots) {
    args.push('--extension-artifact-root', rel(root));
  }
  packageWasixCargoArtifacts(args);
  return validateWasixCargoArtifacts(outputDir);
}

export async function packageWasixRuntimeCarriers() {
  const contrib = contribCarrierDescriptor(TOOL);
  const version = currentProductVersionSync(WASIX_PRODUCT, TOOL);
  await liboliphauntWasixCargoArtifactPackages(version, {
    extensionArtifactRoots: [extensionPackageDir(contrib.artifactProduct, 'wasix')],
  });
  const portableReleaseArchive = path.join(
    ROOT,
    `target/oliphaunt-wasix/release-assets/liboliphaunt-wasix-${version}-runtime-portable.tar.zst`,
  );
  packWasixRuntimeNpmCarrier({
    version,
    portableReleaseArchive,
  });
  packageExtensionNpmCarriers(contrib.artifactProduct, { family: 'wasix' });
}

if (import.meta.main) await packageWasixRuntimeCarriers();
