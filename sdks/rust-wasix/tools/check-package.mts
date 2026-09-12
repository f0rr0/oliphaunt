#!/usr/bin/env bun
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { assertPackagedCargoDependencies } from '../../../tools/packaging/cargo-dependencies.mts';
import {
  archiveTarNames,
  cargoCrateManifest,
  fail,
  inspectSdkProduct,
  PREFIX,
  rejectSdkRuntimePayload,
  rel,
  requireCrateMatchesCargoListing,
} from '../../../tools/packaging/release-carrier.mts';
import {
  compareText,
  currentProductVersion,
  ROOT,
} from '../../../tools/release/release-artifact-targets.mts';
import { renderOliphauntWasixReleaseCargoToml } from './prepare-rust-release-source.mts';

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
  const expected = Bun.TOML.parse(
    renderOliphauntWasixReleaseCargoToml(
      readFileSync(path.join(ROOT, 'sdks/rust-wasix/Cargo.toml'), 'utf8'),
    ),
  );
  assertPackagedCargoDependencies(manifest, expected, rel(crate));
}

export async function checkWasixRustPackage(root) {
  const product = 'oliphaunt-wasix-rust';

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
  }
  return true;
}

if (import.meta.main) await inspectSdkProduct('oliphaunt-wasix-rust', checkWasixRustPackage);
