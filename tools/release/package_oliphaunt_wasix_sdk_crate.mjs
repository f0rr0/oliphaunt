#!/usr/bin/env bun
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  compareText,
  manualCargoPackageSource,
  packagedCargoManifestText,
} from './cargo-source-package.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

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
}

async function copySourceTree(source, destination, ignoredNames) {
  await fs.rm(destination, { recursive: true, force: true });
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.cp(source, destination, {
    recursive: true,
    filter: (sourcePath) => !ignoredNames.has(path.basename(sourcePath)),
  });
}

export async function prepareOliphauntWasixReleaseSource(version) {
  const runtimeVersion = await currentLiboliphauntWasixVersion();
  const registryPackages = await wasixCargoRegistryPackages();
  const sourceDir = path.join(root, 'src/bindings/wasix-rust/crates/oliphaunt-wasix');
  const stageDir = path.join(root, 'target/release/cargo-package-sources/oliphaunt-wasix');
  await copySourceTree(sourceDir, stageDir, new Set(['target']));
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
  console.log(rel(cratePath));
}
