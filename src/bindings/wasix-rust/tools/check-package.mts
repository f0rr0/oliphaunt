#!/usr/bin/env bun
import {
  AOT_PACKAGES as WASIX_AOT_PACKAGES,
  AOT_TARGET_CFGS as WASIX_AOT_TARGET_CFGS,
  AOT_TARGET_TRIPLES as WASIX_AOT_TARGET_TRIPLES,
  ICU_PACKAGE,
  RUNTIME_PACKAGE as WASIX_RUNTIME_PACKAGE,
  TOOLS_AOT_PACKAGES as WASIX_TOOLS_AOT_PACKAGES,
  TOOLS_PACKAGE as WASIX_TOOLS_PACKAGE,
} from '../../../runtimes/liboliphaunt/wasix/tools/wasix-cargo-artifact-contract.mts';
import {
  PREFIX,
  archiveTarNames,
  cargoCrateManifest,
  fail,
  inspectSdkProduct,
  isFile,
  rejectSdkRuntimePayload,
  rel,
  requireCrateMatchesCargoListing,
  tarReadText,
} from '../../../shared/artifact-packaging/release-carrier.mts';
import {
  ROOT,
  compareText,
  currentProductVersion,
} from '../../../shared/product-metadata/release-artifact-targets.mts';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { productCompatibilityVersion } from '../../../shared/product-metadata/release-graph.mts';

function publicAotCargoDependencies() {
  return Object.fromEntries(
    Object.entries(WASIX_AOT_PACKAGES).map(([target, name]) => [
      WASIX_AOT_TARGET_CFGS[WASIX_AOT_TARGET_TRIPLES[target]],
      name,
    ]),
  );
}

function publicToolsAotCargoDependencies() {
  return Object.fromEntries(
    Object.entries(WASIX_TOOLS_AOT_PACKAGES).map(([target, name]) => [
      WASIX_AOT_TARGET_CFGS[WASIX_AOT_TARGET_TRIPLES[target]],
      name,
    ]),
  );
}

async function validateWasixSdkCrate(crate) {
  const manifest = cargoCrateManifest(crate);
  const packageConfig = manifest.package;
  if (
    packageConfig === null ||
    Array.isArray(packageConfig) ||
    typeof packageConfig !== 'object' ||
    packageConfig.name !== 'oliphaunt-wasix'
  ) {
    fail(`${rel(crate)} must package the oliphaunt-wasix crate`);
  }
  const sdkVersion = await currentProductVersion('oliphaunt-wasix-rust', PREFIX);
  if (packageConfig.version !== sdkVersion) {
    fail(`${rel(crate)} package oliphaunt-wasix must use version ${sdkVersion}`);
  }
  const packagedQueryCore = tarReadText(
    crate,
    `oliphaunt-wasix-${sdkVersion}/src/oliphaunt/query_core.rs`,
  );
  const canonicalQueryCore = readFileSync(
    path.join(ROOT, 'src/shared/rust-query-core/query_core.rs'),
    'utf8',
  );
  if (packagedQueryCore !== canonicalQueryCore) {
    fail(
      `${rel(crate)} Rust query core is stale relative to src/shared/rust-query-core/query_core.rs`,
    );
  }
  const runtimeVersion = productCompatibilityVersion(
    'oliphaunt-wasix-rust',
    'liboliphaunt-wasix',
    PREFIX,
  );
  const dependencies = manifest.dependencies;
  if (dependencies === null || Array.isArray(dependencies) || typeof dependencies !== 'object') {
    fail(`${rel(crate)} must declare Cargo dependencies`);
  }
  for (const name of [WASIX_RUNTIME_PACKAGE, WASIX_TOOLS_PACKAGE, ICU_PACKAGE].sort(compareText)) {
    const dependency = dependencies[name];
    if (
      dependency === null ||
      Array.isArray(dependency) ||
      typeof dependency !== 'object' ||
      dependency.version !== `=${runtimeVersion}` ||
      'path' in dependency
    ) {
      fail(
        `${rel(crate)} dependency ${name} must use registry version =${runtimeVersion} without a path`,
      );
    }
  }
  const targetTables = manifest.target;
  if (targetTables === null || Array.isArray(targetTables) || typeof targetTables !== 'object') {
    fail(`${rel(crate)} must declare target-specific WASIX AOT dependencies`);
  }
  const expectedTargets = new Map();
  for (const [cfg, name] of Object.entries(publicAotCargoDependencies())) {
    if (!expectedTargets.has(cfg)) {
      expectedTargets.set(cfg, []);
    }
    expectedTargets.get(cfg).push(name);
  }
  for (const [cfg, name] of Object.entries(publicToolsAotCargoDependencies())) {
    if (!expectedTargets.has(cfg)) {
      expectedTargets.set(cfg, []);
    }
    expectedTargets.get(cfg).push(name);
  }
  for (const [cfg, crates] of [...expectedTargets].sort(([left], [right]) =>
    compareText(left, right),
  )) {
    const target = targetTables[cfg];
    const targetDependencies =
      target && typeof target === 'object' && !Array.isArray(target)
        ? (target.dependencies ?? {})
        : {};
    for (const name of crates.sort(compareText)) {
      const dependency = targetDependencies[name];
      if (
        dependency === null ||
        Array.isArray(dependency) ||
        typeof dependency !== 'object' ||
        dependency.version !== `=${runtimeVersion}` ||
        'path' in dependency
      ) {
        fail(
          `${rel(crate)} target dependency ${cfg}:${name} must use registry version =${runtimeVersion} without a path`,
        );
      }
    }
  }
}

export async function checkWasixRustPackage(root) {
  const product = 'oliphaunt-wasix-rust';
  let checked = false;

  const crates = readdirSync(root)
    .filter((name) => name.endsWith('.crate'))
    .map((name) => path.join(root, name))
    .sort(compareText);
  if (crates.length === 0) {
    fail(`${product} must stage a Cargo crate under ${rel(root)}`);
  }
  for (const crate of crates) {
    rejectSdkRuntimePayload(product, crate, archiveTarNames(crate));
    await validateWasixSdkCrate(crate);
    const version = await currentProductVersion('oliphaunt-wasix-rust', PREFIX);
    requireCrateMatchesCargoListing(
      crate,
      path.join(root, 'cargo-package-files.txt'),
      'oliphaunt-wasix',
      version,
    );
    checked = true;
  }
  const listing = path.join(root, 'cargo-package-files.txt');
  if (!isFile(listing)) {
    fail(`${product} must stage a Cargo package file list under ${rel(root)}`);
  }
  const entries = new Set(
    readFileSync(listing, 'utf8')
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean),
  );
  for (const requiredEntry of [
    'Cargo.toml',
    'README.md',
    'src/lib.rs',
    'src/bin/oliphaunt_wasix_dump.rs',
    'src/bin/oliphaunt_wasix_proxy.rs',
    'src/oliphaunt/assets.rs',
    'src/oliphaunt/query_core.rs',
  ]) {
    if (!entries.has(requiredEntry)) {
      fail(`${product} package file list is missing ${requiredEntry}`);
    }
  }
  for (const entry of entries) {
    if (
      entry.startsWith('target/') ||
      entry.startsWith('src/runtimes/') ||
      entry.startsWith('src/extensions/generated/')
    ) {
      fail(`${product} package file list contains generated or external payload entry ${entry}`);
    }
  }
  checked = true;

  return checked;
}

if (import.meta.main) await inspectSdkProduct('oliphaunt-wasix-rust', checkWasixRustPackage);
