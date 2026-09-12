#!/usr/bin/env bun
import {
  ROOT,
  contribCarrierDescriptor,
  extensionArtifactProductRoot,
  extensionRegistryPackageTargetSets,
} from '../../../../tools/release/release-artifact-targets.mts';
import path from 'node:path';
import { TOOL, fail, isFile, rel } from '../../../../tools/packaging/release-carrier.mts';
import { checkExtensionProduct } from './check-carriers.mts';
import { buildMavenArtifactManifest } from '../../../../tools/packaging/build-maven-artifact-manifest.mts';
import { stageMavenArtifactManifest } from '../../../../tools/packaging/maven-artifact-staging.mts';
import {
  packageNativeExtensionCargoCrates,
  stageExtensionNpmPackagesForTargets,
} from './package-extension-release-carriers.mts';
import { packageWasixCargoArtifacts } from '../../../../runtimes/liboliphaunt-wasix/tools/package_liboliphaunt_wasix_cargo_artifacts.mts';
import { readFileSync } from 'node:fs';
import { WASIX_CARGO_ARTIFACT_SCHEMA } from '../../../../runtimes/liboliphaunt-wasix/tools/wasix-cargo-artifact-contract.mts';
import {
  expectedWasixExtensionPackageInventory,
  validateWasixExtensionArtifactInventory,
} from '../../../../runtimes/liboliphaunt-wasix/tools/wasix-extension-cargo-artifact-inventory.mts';
import { packageExtensionCargoFacades } from './package-extension-cargo-facades.mts';

export function extensionPackageDir(product, family = 'native') {
  return extensionArtifactProductRoot(
    product,
    family,
    path.join(ROOT, 'target/extension-artifacts'),
    TOOL,
  );
}

function releaseSurfaceResult(surface) {
  return { surface, staged: [], skipped: [] };
}

async function requireExtensionAssets(product) {
  await checkExtensionProduct(product, { family: null, require: true, requireFullTargets: true });
}

async function packageExtensionMavenCarriers(product) {
  const manifest = await buildMavenArtifactManifest(
    `target/release/maven-manifests/${product}.tsv`,
    {
      extensions: true,
      extensionProducts: [product],
    },
  );
  await stageMavenArtifactManifest(
    manifest,
    path.join(ROOT, 'target/release/maven-staging', product),
  );
}

export function packageExtensionNpmCarriers(product, { family = null } = {}) {
  const roots = [extensionPackageDir(product, family ?? 'native')];
  const targetSets = extensionRegistryPackageTargetSets(product, TOOL);
  const targets = targetSets.npmTargets;
  const result = releaseSurfaceResult(`${product}-npm${family === null ? '' : `-${family}`}`);
  const staged = stageExtensionNpmPackagesForTargets(
    roots,
    path.join(ROOT, 'target/release/extension-carriers/npm', product, family ?? 'all'),
    targets,
    result,
    { metaTargets: targets },
  );
  const missingNativeTargets =
    family === 'wasix' ? [] : targets.filter((target) => staged.nativeRoots[target] === null);
  const missingWasix =
    family === 'native' ? false : targetSets.includeWasixNpm && staged.wasixRoot === null;
  if (missingNativeTargets.length > 0 || missingWasix || result.staged.length === 0) {
    fail(
      `${product} npm carrier packaging failed: missing native targets=${missingNativeTargets.join(',') || 'none'}; ` +
        `missing portable WASIX=${missingWasix ? 'yes' : 'no'}; ` +
        `details=${result.skipped.join('; ') || 'none'}`,
    );
  }
}

function packageExtensionNativeCargoCarriers(product) {
  for (const target of extensionRegistryPackageTargetSets(product, TOOL).nativeCargoTargets) {
    const result = releaseSurfaceResult(`${product}-cargo-${target}`);
    const crates = packageNativeExtensionCargoCrates(
      [extensionPackageDir(product, 'native')],
      path.join(ROOT, 'target/release/extension-carriers/cargo', product, `native-${target}`),
      target,
      true,
      result,
    );
    if (crates.length === 0) {
      fail(
        `${product} native Cargo carrier packaging failed for ${target}: ${result.skipped.join('; ')}`,
      );
    }
  }
}

function packageExtensionWasixCargoCarriers(product) {
  const outputDir = path.join(ROOT, 'target/release/extension-carriers/cargo', product, 'wasix');
  packageWasixCargoArtifacts([
    '--extensions-only',
    '--output-dir',
    rel(outputDir),
    '--extension-artifact-root',
    rel(extensionPackageDir(product, 'wasix')),
  ]);
  const manifestPath = path.join(outputDir, 'packages.json');
  if (!isFile(manifestPath)) {
    fail(`${product} WASIX Cargo packaging did not generate ${rel(manifestPath)}`);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (manifest?.schema !== WASIX_CARGO_ARTIFACT_SCHEMA || !Array.isArray(manifest.packages)) {
    fail(`${product} WASIX Cargo packaging generated an invalid package manifest`);
  }
  try {
    validateWasixExtensionArtifactInventory(
      manifest.packages,
      expectedWasixExtensionPackageInventory(TOOL, [product]),
    );
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

function packageExtensionFacade(product) {
  const packages = packageExtensionCargoFacades(
    [product],
    path.join(ROOT, 'target/release/extension-carriers/cargo', product, 'facade'),
  );
  if (packages.length !== 1 || packages[0].name !== product) {
    fail(`${product} Cargo facade packaging did not generate its canonical package`);
  }
}

export async function packageExtensionCarriers(product) {
  await requireExtensionAssets(product);
  await packageExtensionMavenCarriers(product);
  packageExtensionNpmCarriers(product);
  packageExtensionNativeCargoCarriers(product);
  packageExtensionWasixCargoCarriers(product);
  packageExtensionFacade(product);
}

export async function packageContribNativeCarriers() {
  const product = contribCarrierDescriptor(TOOL).artifactProduct;
  const manifest = path.join(extensionPackageDir(product, 'native'), 'extension-artifacts.json');
  if (!isFile(manifest)) {
    fail(`liboliphaunt-native requires staged contrib native artifacts at ${rel(manifest)}`);
  }
  packageExtensionNpmCarriers(product, { family: 'native' });
  packageExtensionNativeCargoCarriers(product);
  packageExtensionFacade(product);
}

if (import.meta.main) await packageExtensionCarriers(process.argv[2]);
