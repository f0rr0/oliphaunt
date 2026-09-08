#!/usr/bin/env bun
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { stageWasixRustPackageSource } from './package-source.mts';

import {
  parseCargoPackageNameVersion,
  packagedCargoManifestText,
} from '../../../shared/artifact-packaging/cargo-source-package.mts';
import {
  canonicalWasixCargoToolchainVersions,
  validateWasixConsumerDependencyPins,
} from '../../../shared/product-metadata/wasix-cargo-toolchain-policy.mts';
import {
  assertReleaseNoticesInDirectory,
  stageReleaseNotices,
} from '../../../shared/artifact-packaging/release-notices.mts';
import { productCompatibilityVersion } from '../../../shared/product-metadata/release-graph.mts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../tools', '..');
const SOURCE_NOTICE_OPTIONS = Object.freeze({ profile: 'source-sdk' });

function fail(message) {
  console.error(`prepare-rust-release-source.mts: ${message}`);
  process.exit(2);
}

function rel(target) {
  const relative = path.relative(root, target);
  return relative.startsWith('..') || path.isAbsolute(relative)
    ? target
    : relative.split(path.sep).join('/');
}

async function readText(relativePath) {
  return await fs.readFile(path.join(root, relativePath), 'utf8');
}

export async function currentOliphauntWasixSdkVersion() {
  const text = await readText('src/bindings/wasix-rust/crates/oliphaunt-wasix/Cargo.toml');
  return parseCargoPackageNameVersion(
    text,
    'src/bindings/wasix-rust/crates/oliphaunt-wasix/Cargo.toml',
  ).version;
}

async function wasixCargoRegistryPackages() {
  const text = await readText('src/runtimes/liboliphaunt/wasix/release.toml');
  const match = text.match(/^registry_packages\s*=\s*\[([\s\S]*?)^\]/mu);
  if (!match) {
    fail('src/runtimes/liboliphaunt/wasix/release.toml must declare registry_packages');
  }
  const packages = [...match[1].matchAll(/"crates:([^"]+)"/gu)].map((item) => item[1]);
  if (packages.length === 0) {
    fail('liboliphaunt-wasix registry_packages must include Cargo packages');
  }
  return packages.sort();
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function renderOliphauntWasixReleaseCargoToml(source, runtimeVersion, registryPackages) {
  let text = packagedCargoManifestText(source);
  for (const crate of registryPackages) {
    const pattern = new RegExp(
      `^(${escapeRegExp(crate)}\\s*=\\s*\\{[^}\\n]*version\\s*=\\s*")[^"]+("[^}\\n]*\\})$`,
      'mu',
    );
    if (!pattern.test(text)) {
      fail(`generated oliphaunt-wasix release source is missing dependency ${crate}`);
    }
    text = text.replace(pattern, `$1=${runtimeVersion}$2`);
  }
  return text;
}

function validateGeneratedOliphauntWasixReleaseArtifactCoverage(
  manifestText,
  runtimeVersion,
  registryPackages,
) {
  if (/=\s*\{[^}\n]*path\s*=/u.test(manifestText)) {
    fail('generated oliphaunt-wasix release source must not contain local path dependencies');
  }
  const missing = registryPackages.filter(
    (crate) => !manifestText.includes(`${crate} = { version = "=${runtimeVersion}"`),
  );
  if (missing.length > 0) {
    fail(
      `generated oliphaunt-wasix release source is missing WASIX artifact dependency pins: ${missing.join(', ')}`,
    );
  }
  const toolchainVersions = canonicalWasixCargoToolchainVersions(root);
  const toolchainFailures = validateWasixConsumerDependencyPins(Bun.TOML.parse(manifestText), {
    manifestPath: 'generated oliphaunt-wasix release source',
    toolchainVersions,
  });
  if (toolchainFailures.length > 0) {
    fail(toolchainFailures.join('\n'));
  }
}

export async function prepareOliphauntWasixReleaseSource(version) {
  const runtimeVersion = productCompatibilityVersion(
    'oliphaunt-wasix-rust',
    'liboliphaunt-wasix',
    'prepare-rust-release-source.mts',
  );
  const registryPackages = await wasixCargoRegistryPackages();
  const stageDir = path.join(root, 'target/release/cargo-package-sources/oliphaunt-wasix');
  await stageWasixRustPackageSource(stageDir);
  const cargoToml = path.join(stageDir, 'Cargo.toml');
  const rendered = renderOliphauntWasixReleaseCargoToml(
    await fs.readFile(cargoToml, 'utf8'),
    runtimeVersion,
    registryPackages,
  );
  const generatedPackage = parseCargoPackageNameVersion(rendered, rel(cargoToml));
  if (generatedPackage.version !== version) {
    fail(`generated oliphaunt-wasix release source must keep SDK version ${version}`);
  }
  validateGeneratedOliphauntWasixReleaseArtifactCoverage(
    rendered,
    runtimeVersion,
    registryPackages,
  );
  await fs.writeFile(cargoToml, rendered);
  stageReleaseNotices(stageDir, SOURCE_NOTICE_OPTIONS);
  assertReleaseNoticesInDirectory(stageDir, SOURCE_NOTICE_OPTIONS);
  return cargoToml;
}

if (import.meta.main) {
  if (Bun.argv.length !== 2) fail('usage: prepare-rust-release-source.mts');
  console.log(await prepareOliphauntWasixReleaseSource(await currentOliphauntWasixSdkVersion()));
}
