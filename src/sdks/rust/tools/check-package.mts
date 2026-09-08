#!/usr/bin/env bun
import {
  ROOT,
  allArtifactTargets,
  compareText,
  currentProductVersion,
} from '../../../shared/product-metadata/release-artifact-targets.mts';
import {
  PREFIX,
  archiveTarNames,
  cargoCrateManifest,
  fail,
  inspectSdkProduct,
  rejectSdkRuntimePayload,
  rel,
  requireCrateMatchesCargoListing,
  tarReadText,
} from '../../../shared/artifact-packaging/release-carrier.mts';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { assertReleaseNoticesInArchive } from '../../../shared/artifact-packaging/release-notices.mts';
import {
  assertSameNativeTargetSet,
  rustNativeTargetCfg,
} from '../../../shared/artifact-packaging/rust-native-targets.mts';
import { productCompatibilityVersion } from '../../../shared/product-metadata/release-graph.mts';

function exactSortedStrings(label, actual, expected) {
  const actualSorted = [...actual].sort(compareText);
  const expectedSorted = [...expected].sort(compareText);
  if (JSON.stringify(actualSorted) !== JSON.stringify(expectedSorted)) {
    fail(
      `${label} mismatch: expected=${JSON.stringify(expectedSorted)}, actual=${JSON.stringify(actualSorted)}`,
    );
  }
}

function rustSdkArtifactTargets(product, kind, surface) {
  return allArtifactTargets({ product, kind, surface }, PREFIX);
}

function requireRegistryTargetDependency(crate, dependencies, cfg, name, version) {
  const dependency = dependencies[name];
  if (
    dependency === null ||
    Array.isArray(dependency) ||
    typeof dependency !== 'object' ||
    dependency.version !== `=${version}` ||
    ['path', 'git', 'registry'].some((key) => key in dependency)
  ) {
    fail(
      `${rel(crate)} target dependency ${cfg}:${name} must use registry version ` +
        `=${version} without path, git, or alternate-registry metadata`,
    );
  }
}

async function validateRustSdkCrate(crate) {
  const manifest = cargoCrateManifest(crate);
  const packageConfig = manifest.package;
  if (packageConfig === null || Array.isArray(packageConfig) || typeof packageConfig !== 'object') {
    fail(`${rel(crate)} must declare a Cargo package`);
  }
  const packageName = packageConfig.name;
  if (!['oliphaunt', 'oliphaunt-build'].includes(packageName)) {
    fail(`${rel(crate)} contains unexpected oliphaunt-rust package ${JSON.stringify(packageName)}`);
  }
  const sdkVersion = await currentProductVersion('oliphaunt-rust', PREFIX);
  if (packageConfig.version !== sdkVersion) {
    fail(`${rel(crate)} package ${packageName} must use oliphaunt-rust version ${sdkVersion}`);
  }
  if (packageConfig.license !== 'MIT') {
    fail(`${rel(crate)} source-only package ${packageName} must declare license MIT`);
  }
  if (packageName === 'oliphaunt') {
    const packagedQueryCore = tarReadText(crate, `${packageName}-${sdkVersion}/src/query_core.rs`);
    const canonicalQueryCore = readFileSync(
      path.join(ROOT, 'src/shared/rust-query-core/query_core.rs'),
      'utf8',
    );
    if (packagedQueryCore !== canonicalQueryCore) {
      fail(
        `${rel(crate)} Rust query core is stale relative to src/shared/rust-query-core/query_core.rs`,
      );
    }
  }
  try {
    assertReleaseNoticesInArchive(crate, {
      profile: 'source-sdk',
      prefix: `${packageName}-${sdkVersion}`,
    });
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  if (packageName === 'oliphaunt-build') {
    return packageName;
  }

  const nativeTargets = rustSdkArtifactTargets(
    'liboliphaunt-native',
    'native-runtime',
    'rust-native-direct',
  );
  const brokerTargets = rustSdkArtifactTargets('oliphaunt-broker', 'broker-helper', 'rust-broker');
  const targetIds = nativeTargets.map((target) => target.target);
  try {
    assertSameNativeTargetSet(
      'staged oliphaunt Rust SDK native runtime/broker',
      targetIds,
      brokerTargets.map((target) => target.target),
    );
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }

  const targetTables = manifest.target;
  if (targetTables === null || Array.isArray(targetTables) || typeof targetTables !== 'object') {
    fail(
      `${rel(crate)} oliphaunt package must declare target-specific native release dependencies`,
    );
  }
  const expectedCfgs = targetIds.map((target) => `cfg(${rustNativeTargetCfg(target)})`);
  exactSortedStrings(`${rel(crate)} native target tables`, Object.keys(targetTables), expectedCfgs);

  const nativeVersion = productCompatibilityVersion(
    'oliphaunt-rust',
    'liboliphaunt-native',
    PREFIX,
  );
  const brokerVersion = productCompatibilityVersion('oliphaunt-rust', 'oliphaunt-broker', PREFIX);
  for (const target of nativeTargets) {
    const cfg = `cfg(${rustNativeTargetCfg(target)})`;
    const table = targetTables[cfg];
    const dependencies =
      table && typeof table === 'object' && !Array.isArray(table) ? table.dependencies : null;
    if (dependencies === null || Array.isArray(dependencies) || typeof dependencies !== 'object') {
      fail(`${rel(crate)} target table ${cfg} must declare release dependencies`);
    }
    const expectedDependencies = [
      `liboliphaunt-native-${target.target}`,
      `oliphaunt-broker-${target.target}`,
    ];
    exactSortedStrings(
      `${rel(crate)} target dependencies for ${cfg}`,
      Object.keys(dependencies),
      expectedDependencies,
    );
    requireRegistryTargetDependency(
      crate,
      dependencies,
      cfg,
      expectedDependencies[0],
      nativeVersion,
    );
    requireRegistryTargetDependency(
      crate,
      dependencies,
      cfg,
      expectedDependencies[1],
      brokerVersion,
    );
  }

  return packageName;
}

export async function checkRustPackage(root) {
  const product = 'oliphaunt-rust';
  let checked = false;

  const crates = readdirSync(root)
    .filter((name) => name.endsWith('.crate'))
    .map((name) => path.join(root, name))
    .sort(compareText);
  if (crates.length === 0) {
    fail(`${product} must stage a Cargo crate under ${rel(root)}`);
  }
  const packageNames = [];
  const cratesByPackage = new Map();
  for (const crate of crates) {
    rejectSdkRuntimePayload(product, crate, archiveTarNames(crate));
    const packageName = await validateRustSdkCrate(crate);
    packageNames.push(packageName);
    cratesByPackage.set(packageName, crate);
    checked = true;
  }
  if (crates.length > 0) {
    exactSortedStrings(`${product} staged Cargo packages`, packageNames, [
      'oliphaunt',
      'oliphaunt-build',
    ]);
    const version = await currentProductVersion('oliphaunt-rust', PREFIX);
    requireCrateMatchesCargoListing(
      cratesByPackage.get('oliphaunt'),
      path.join(root, 'cargo-package-files.txt'),
      'oliphaunt',
      version,
    );
  }

  return checked;
}

if (import.meta.main) await inspectSdkProduct('oliphaunt-rust', checkRustPackage);
