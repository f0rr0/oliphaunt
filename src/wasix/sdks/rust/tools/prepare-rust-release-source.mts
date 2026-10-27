#!/usr/bin/env bun
import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { renderCargoToml } from '../../../../../tools/packaging/cargo-manifest.mts';
import {
  packagedCargoManifestText,
  parseCargoPackageNameVersion,
} from '../../../../../tools/packaging/cargo-source-package.mts';
import {
  assertReleaseNoticesInDirectory,
  stageReleaseNotices,
} from '../../../../../tools/packaging/release-notices.mts';
import { loadPublicationCatalog } from '../../../../../tools/release/publication-catalog.mts';
import { productCompatibilityVersion } from '../../../../../tools/release/release-graph.mts';
import {
  canonicalWasixCargoToolchainVersions,
  canonicalWasixEngineSourcePackages,
  validateWasixConsumerDependencyPins,
} from '../../../runtime/tools/wasix-cargo-toolchain-policy.mts';
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
  const text = await readText('src/wasix/sdks/rust/Cargo.toml');
  return parseCargoPackageNameVersion(text, 'src/wasix/sdks/rust/Cargo.toml').version;
}

export function renderOliphauntWasixReleaseCargoToml(
  source,
  runtimeVersion,
  workspaceSource = readFileSync(path.join(root, 'Cargo.toml'), 'utf8'),
) {
  const manifest = Bun.TOML.parse(packagedCargoManifestText(source, workspaceSource));
  const metadata = manifest.package?.metadata?.oliphaunt ?? {};
  const requirements = {
    'liboliphaunt-wasix': runtimeVersion ?? metadata['runtime-version'],
    'postgres-tools-wasix': metadata['tools-version'],
    'database-resources': metadata['icu-version'],
    'oliphaunt-wasix-rust': manifest.package.version,
  };
  const catalog = loadPublicationCatalog('prepare-rust-release-source.mts');
  const carriers = new Map(
    catalog.carriers
      .filter((entry) => entry.ecosystem === 'cargo')
      .map((entry) => [entry.name, entry]),
  );
  for (const table of [manifest, ...Object.values(manifest.target ?? {})]) {
    for (const kind of ['dependencies', 'build-dependencies', 'dev-dependencies']) {
      for (const [alias, dependency] of Object.entries(table[kind] ?? {})) {
        const spec = typeof dependency === 'string' ? { version: dependency } : dependency;
        const crate = spec.package ?? alias;
        const carrier = carriers.get(crate);
        if (!carrier) continue;
        const version =
          spec.version === '*' ? requirements[carrier.product] : spec.version?.replace(/^=/u, '');
        if (typeof version !== 'string' || version.length === 0) {
          throw new Error(`Missing installed compatibility pin for ${crate}`);
        }
        table[kind][alias] =
          typeof dependency === 'string' ? `=${version}` : { ...spec, version: `=${version}` };
      }
    }
  }
  return renderCargoToml(manifest);
}

function validateGeneratedOliphauntWasixReleaseArtifactCoverage(manifestText) {
  if (/=\s*\{[^}\n]*path\s*=/u.test(manifestText)) {
    fail('generated oliphaunt-wasix release source must not contain local path dependencies');
  }
  const toolchainVersions = canonicalWasixCargoToolchainVersions(root);
  const toolchainFailures = validateWasixConsumerDependencyPins(Bun.TOML.parse(manifestText), {
    manifestPath: 'generated oliphaunt-wasix release source',
    toolchainVersions,
    engineSourcePackages: canonicalWasixEngineSourcePackages(root, toolchainVersions),
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
