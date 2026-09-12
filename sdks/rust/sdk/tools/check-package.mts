#!/usr/bin/env bun
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { assertPackagedCargoDependencies } from '../../../../tools/packaging/cargo-dependencies.mts';
import { packagedCargoManifestText } from '../../../../tools/packaging/cargo-source-package.mts';
import {
  archiveTarNames,
  cargoCrateManifest,
  fail,
  inspectSdkProduct,
  PREFIX,
  rejectSdkRuntimePayload,
  rel,
  requireCrateMatchesCargoListing,
} from '../../../../tools/packaging/release-carrier.mts';
import { assertReleaseNoticesInArchive } from '../../../../tools/packaging/release-notices.mts';
import {
  compareText,
  currentProductVersion,
  ROOT,
} from '../../../../tools/release/release-artifact-targets.mts';
import { renderReleaseCargoToml } from './prepare-rust-release-source.mts';

function exactSortedStrings(label, actual, expected) {
  const actualSorted = [...actual].sort(compareText);
  const expectedSorted = [...expected].sort(compareText);
  if (JSON.stringify(actualSorted) !== JSON.stringify(expectedSorted)) {
    fail(
      `${label} mismatch: expected=${JSON.stringify(expectedSorted)}, actual=${JSON.stringify(actualSorted)}`,
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
  try {
    assertReleaseNoticesInArchive(crate, {
      profile: 'source-sdk',
      prefix: `${packageName}-${sdkVersion}`,
    });
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  const source = packagedCargoManifestText(
    readFileSync(
      path.join(
        ROOT,
        packageName === 'oliphaunt'
          ? 'sdks/rust/sdk/Cargo.toml'
          : 'sdks/rust/sdk/crates/oliphaunt-build/Cargo.toml',
      ),
      'utf8',
    ),
  );
  const expected = Bun.TOML.parse(
    packageName === 'oliphaunt' ? renderReleaseCargoToml(source) : source,
  );
  assertPackagedCargoDependencies(manifest, expected, rel(crate));

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
