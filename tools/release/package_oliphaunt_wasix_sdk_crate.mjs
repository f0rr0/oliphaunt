#!/usr/bin/env bun
import { readdirSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  compareText,
  manualCargoPackageSource,
  packagedCargoManifestText,
} from './cargo-source-package.mjs';
import {
  canonicalWasixCargoToolchainVersions,
  validateWasixConsumerDependencyPins,
} from './wasix-cargo-toolchain-policy.mjs';
import {
  assertReleaseNoticesInArchive,
  assertReleaseNoticesInDirectory,
  stageReleaseNotices,
} from './release-notices.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SOURCE_NOTICE_OPTIONS = Object.freeze({ profile: 'source-sdk' });
const EXTENSION_SMOKE_FIXTURES = readdirSync(
  path.join(root, 'src/shared/fixtures/extensions'),
  { withFileTypes: true },
)
  .filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
  .map((entry) => [
    `src/testdata/extensions/${entry.name}`,
    `src/shared/fixtures/extensions/${entry.name}`,
  ])
  .sort((left, right) => left[0].localeCompare(right[0]));
const PACKAGE_FIXTURES = Object.freeze([
  ...EXTENSION_SMOKE_FIXTURES,
  ['src/testdata/database-root.json', 'src/shared/fixtures/storage/database-root.json'],
  [
    'src/testdata/physical-archive-wasix-v1.properties',
    'src/shared/fixtures/storage/physical-archive-wasix-v1.properties',
  ],
  [
    'src/testdata/physical-backup-wal-range-v1.properties',
    'src/shared/fixtures/storage/physical-backup-wal-range-v1.properties',
  ],
  [
    'src/testdata/postgres-behavior-contract.json',
    'src/shared/fixtures/postgres/behavior-contract.json',
  ],
  [
    'src/testdata/postgres-logical-tools.json',
    'src/shared/fixtures/postgres/logical-tools.json',
  ],
  [
    'src/testdata/postgres-logical-tools-seed.sql',
    'src/shared/fixtures/postgres/logical-tools-seed.sql',
  ],
  [
    'src/testdata/postgres-logical-tools-verify.sql',
    'src/shared/fixtures/postgres/logical-tools-verify.sql',
  ],
  [
    'src/testdata/postgres-server-listen.json',
    'src/shared/fixtures/postgres/server-listen.json',
  ],
  [
    'src/testdata/protocol-query-response-cases.json',
    'src/shared/fixtures/protocol/query-response-cases.json',
  ],
]);

function fail(message) {
  console.error(`package_oliphaunt_wasix_sdk_crate.mjs: ${message}`);
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

function parseCargoPackageNameVersion(text, context) {
  let inPackage = false;
  let name = null;
  let version = null;
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line === '[package]') {
      inPackage = true;
      continue;
    }
    if (inPackage && line.startsWith('[')) {
      break;
    }
    if (!inPackage) {
      continue;
    }
    name ??= line.match(/^name\s*=\s*"([^"]+)"/u)?.[1] ?? null;
    version ??= line.match(/^version\s*=\s*"([^"]+)"/u)?.[1] ?? null;
  }
  if (!name || !version) {
    fail(`${context} must declare package.name and package.version`);
  }
  return { name, version };
}

export async function currentOliphauntWasixSdkVersion() {
  const text = await readText('src/bindings/wasix-rust/crates/oliphaunt-wasix/Cargo.toml');
  return parseCargoPackageNameVersion(
    text,
    'src/bindings/wasix-rust/crates/oliphaunt-wasix/Cargo.toml',
  ).version;
}

async function currentLiboliphauntWasixVersion() {
  const version = (await readText('src/runtimes/liboliphaunt/wasix/VERSION')).trim();
  if (!version) {
    fail('src/runtimes/liboliphaunt/wasix/VERSION must not be empty');
  }
  return version;
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
      `^(${escapeRegExp(crate)}\\s*=\\s*\\{[^}\\n]*version\\s*=\\s*")=[^"]+("[^}\\n]*\\})$`,
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
  const toolchainFailures = validateWasixConsumerDependencyPins(
    Bun.TOML.parse(manifestText),
    {
      manifestPath: 'generated oliphaunt-wasix release source',
      toolchainVersions,
    },
  );
  if (toolchainFailures.length > 0) {
    fail(toolchainFailures.join('\n'));
  }
}

async function copySourceTree(source, destination, ignoredNames) {
  await fs.rm(destination, { recursive: true, force: true });
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.cp(source, destination, {
    recursive: true,
    filter: (sourcePath) => !ignoredNames.has(path.basename(sourcePath)),
  });
}

async function validatePackageFixtures(sourceDir) {
  for (const [packageFixture, canonicalFixture] of PACKAGE_FIXTURES) {
    const [packaged, canonical] = await Promise.all([
      fs.readFile(path.join(sourceDir, packageFixture)),
      fs.readFile(path.join(root, canonicalFixture)),
    ]);
    if (!packaged.equals(canonical)) {
      fail(`${rel(path.join(sourceDir, packageFixture))} must exactly match ${canonicalFixture}`);
    }
  }
}

async function stagePackageFixtures(stageDir) {
  for (const [packageFixture, canonicalFixture] of PACKAGE_FIXTURES) {
    const destination = path.join(stageDir, packageFixture);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(path.join(root, canonicalFixture), destination);
  }
}

export async function prepareOliphauntWasixReleaseSource(version) {
  const runtimeVersion = await currentLiboliphauntWasixVersion();
  const registryPackages = await wasixCargoRegistryPackages();
  const sourceDir = path.join(root, 'src/bindings/wasix-rust/crates/oliphaunt-wasix');
  const stageDir = path.join(root, 'target/release/cargo-package-sources/oliphaunt-wasix');
  await copySourceTree(sourceDir, stageDir, new Set(['target']));
  await stagePackageFixtures(stageDir);
  await validatePackageFixtures(stageDir);
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

function parseArgs(argv) {
  let outputDir = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--output-dir') {
      outputDir = argv[index + 1] ?? null;
      index += 1;
      continue;
    }
    fail(`unknown argument: ${arg}`);
  }
  if (!outputDir) {
    fail('usage: tools/release/package_oliphaunt_wasix_sdk_crate.mjs --output-dir <path>');
  }
  return {
    outputDir: path.isAbsolute(outputDir) ? outputDir : path.join(root, outputDir),
  };
}

if (import.meta.main) {
  const { outputDir } = parseArgs(Bun.argv.slice(2));
  const version = await currentOliphauntWasixSdkVersion();
  const manifest = await prepareOliphauntWasixReleaseSource(version);
  const cratePath = manualCargoPackageSource(manifest, outputDir, { root, fail, rel });
  assertReleaseNoticesInArchive(cratePath, {
    ...SOURCE_NOTICE_OPTIONS,
    prefix: path.basename(cratePath, '.crate'),
  });
  console.log(rel(cratePath));
}
