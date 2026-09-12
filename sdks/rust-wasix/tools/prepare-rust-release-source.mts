#!/usr/bin/env bun
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  canonicalWasixCargoToolchainVersions,
  validateWasixConsumerDependencyPins,
} from '../../../runtimes/liboliphaunt-wasix/tools/wasix-cargo-toolchain-policy.mts';

import {
  packagedCargoManifestText,
  parseCargoPackageNameVersion,
} from '../../../tools/packaging/cargo-source-package.mts';
import {
  assertReleaseNoticesInDirectory,
  stageReleaseNotices,
} from '../../../tools/packaging/release-notices.mts';
import { loadPublicationCatalog } from '../../../tools/release/publication-catalog.mts';
import { productCompatibilityVersion } from '../../../tools/release/release-graph.mts';
import { ROOT as root, stageWasixRustPackageSource } from './package-source.mts';

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
  const text = await readText('sdks/rust-wasix/Cargo.toml');
  return parseCargoPackageNameVersion(text, 'sdks/rust-wasix/Cargo.toml').version;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

export function renderOliphauntWasixReleaseCargoToml(
  source,
  runtimeVersion = productCompatibilityVersion(
    'oliphaunt-wasix-rust',
    'liboliphaunt-wasix',
    'prepare-rust-release-source.mts',
  ),
) {
  let text = packagedCargoManifestText(source);
  const catalog = loadPublicationCatalog('prepare-rust-release-source.mts');
  for (const carrier of catalog.carriers.filter((entry) => entry.ecosystem === 'cargo')) {
    const crate = carrier.name;
    const pattern = new RegExp(
      `^(${escapeRegExp(crate)}\\s*=\\s*\\{[^}\\n]*version\\s*=\\s*")[^"]+("[^}\\n]*\\})$`,
      'gmu',
    );
    if (!pattern.test(text)) {
      continue;
    }
    const version = carrier.product === 'liboliphaunt-wasix' ? runtimeVersion : carrier.version;
    text = text.replace(pattern, `$1=${version}$2`);
  }
  return text;
}

function validateGeneratedOliphauntWasixReleaseArtifactCoverage(manifestText) {
  if (/=\s*\{[^}\n]*path\s*=/u.test(manifestText)) {
    fail('generated oliphaunt-wasix release source must not contain local path dependencies');
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
  const stageDir = path.join(root, 'target/release/cargo-package-sources/oliphaunt-wasix');
  await stageWasixRustPackageSource(stageDir);
  const cargoToml = path.join(stageDir, 'Cargo.toml');
  const rendered = renderOliphauntWasixReleaseCargoToml(
    await fs.readFile(cargoToml, 'utf8'),
    runtimeVersion,
  );
  const generatedPackage = parseCargoPackageNameVersion(rendered, rel(cargoToml));
  if (generatedPackage.version !== version) {
    fail(`generated oliphaunt-wasix release source must keep SDK version ${version}`);
  }
  validateGeneratedOliphauntWasixReleaseArtifactCoverage(rendered);
  await fs.writeFile(cargoToml, rendered);
  stageReleaseNotices(stageDir, SOURCE_NOTICE_OPTIONS);
  assertReleaseNoticesInDirectory(stageDir, SOURCE_NOTICE_OPTIONS);
  return cargoToml;
}

if (import.meta.main) {
  if (Bun.argv.length !== 2) fail('usage: prepare-rust-release-source.mts');
  console.log(await prepareOliphauntWasixReleaseSource(await currentOliphauntWasixSdkVersion()));
}
