#!/usr/bin/env bun
import { gzipSync } from 'node:zlib';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const cargoPackageSizeLimitBytes = 10 * 1024 * 1024;

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

async function readCargoPackageNameVersion(manifest) {
  return parseCargoPackageNameVersion(await fs.readFile(manifest, 'utf8'), rel(manifest));
}

async function currentOliphauntWasixSdkVersion() {
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

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function packagedCargoManifestText(source) {
  let text = source
    .replaceAll('repository.workspace = true', 'repository = "https://github.com/f0rr0/oliphaunt"')
    .replaceAll('homepage.workspace = true', 'homepage = "https://oliphaunt.dev"');
  text = text.replace(/, path = "[^"]+"/gu, '');
  if (!text.includes('\n[workspace]')) {
    text = `${text.trimEnd()}\n\n[workspace]\n`;
  }
  return text;
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

async function prepareOliphauntWasixReleaseSource(version) {
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

async function cargoMetadataPackageFromManifest(manifest) {
  const proc = Bun.spawn(
    ['cargo', 'metadata', '--manifest-path', manifest, '--format-version', '1', '--no-deps'],
    {
      cwd: root,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    fail(`cargo metadata failed for ${rel(manifest)}: ${stderr.trim()}`);
  }
  const packages = JSON.parse(stdout).packages;
  if (!Array.isArray(packages) || packages.length !== 1 || typeof packages[0] !== 'object') {
    fail(`cargo metadata for ${rel(manifest)} did not return exactly one package`);
  }
  return packages[0];
}

async function listFilesRecursive(directory) {
  const files = [];
  const entries = await fs.readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => compareText(left.name, right.name));
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFilesRecursive(fullPath)));
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      files.push(fullPath);
    }
  }
  return files;
}

function tarPathParts(relativePath) {
  const normalized = relativePath.split(path.sep).join('/');
  if (Buffer.byteLength(normalized) <= 100) {
    return { name: normalized, prefix: '' };
  }
  const parts = normalized.split('/');
  for (let index = 1; index < parts.length; index += 1) {
    const prefix = parts.slice(0, index).join('/');
    const name = parts.slice(index).join('/');
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) {
      return { name, prefix };
    }
  }
  fail(`crate archive path is too long for ustar: ${normalized}`);
}

function writeString(buffer, offset, length, value) {
  const bytes = Buffer.from(value);
  if (bytes.length > length) {
    fail(`tar header field overflow for '${value}'`);
  }
  bytes.copy(buffer, offset);
}

function writeOctal(buffer, offset, length, value) {
  const text = value.toString(8);
  if (text.length > length - 1) {
    fail(`tar header octal field overflow for '${value}'`);
  }
  writeString(buffer, offset, length, `${text.padStart(length - 1, '0')}\0`);
}

function tarHeader(relativePath, size, mode) {
  const header = Buffer.alloc(512, 0);
  const { name, prefix } = tarPathParts(relativePath);
  writeString(header, 0, 100, name);
  writeOctal(header, 100, 8, mode);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  writeString(header, 156, 1, '0');
  writeString(header, 257, 6, 'ustar\0');
  writeString(header, 263, 2, '00');
  writeString(header, 345, 155, prefix);
  let checksum = 0;
  for (const byte of header) {
    checksum += byte;
  }
  const checksumText = checksum.toString(8);
  if (checksumText.length > 6) {
    fail(`tar header checksum overflow for ${relativePath}`);
  }
  writeString(header, 148, 8, `${checksumText.padStart(6, '0')}\0 `);
  return header;
}

async function createTar(stageDir, packageRoot) {
  const chunks = [];
  const files = await listFilesRecursive(stageDir);
  files.sort((left, right) => compareText(path.relative(stageDir, left), path.relative(stageDir, right)));
  for (const file of files) {
    const relative = path.relative(stageDir, file).split(path.sep).join('/');
    const archivePath = `${packageRoot}/${relative}`;
    const stat = await fs.stat(file);
    const data = await fs.readFile(file);
    chunks.push(tarHeader(archivePath, data.length, stat.mode & 0o777));
    chunks.push(data);
    const remainder = data.length % 512;
    if (remainder !== 0) {
      chunks.push(Buffer.alloc(512 - remainder, 0));
    }
  }
  chunks.push(Buffer.alloc(1024, 0));
  return Buffer.concat(chunks);
}

async function manualCargoPackageSource(manifest, outputDir) {
  const { name, version } = await readCargoPackageNameVersion(manifest);
  const sourceDir = path.dirname(manifest);
  const packageRoot = `${name}-${version}`;
  const stageRoot = path.join(outputDir, 'manual-package-stage');
  const stageDir = path.join(stageRoot, packageRoot);
  const cratePath = path.join(outputDir, `${packageRoot}.crate`);
  await copySourceTree(sourceDir, stageDir, new Set(['target', '.git', '.DS_Store']));

  const stagedManifest = path.join(stageDir, 'Cargo.toml');
  await fs.writeFile(
    stagedManifest,
    packagedCargoManifestText(await fs.readFile(stagedManifest, 'utf8')),
  );
  const packageMetadata = await cargoMetadataPackageFromManifest(stagedManifest);
  if (packageMetadata.name !== name || packageMetadata.version !== version) {
    fail(`${rel(stagedManifest)} produced unexpected cargo metadata`);
  }

  await fs.mkdir(outputDir, { recursive: true });
  await fs.rm(cratePath, { force: true });
  await fs.writeFile(cratePath, gzipSync(await createTar(stageDir, packageRoot), { mtime: 0 }));
  const size = (await fs.stat(cratePath)).size;
  if (size > cargoPackageSizeLimitBytes) {
    fail(`${rel(cratePath)} is ${size} bytes, above the crates.io 10 MiB package limit`);
  }
  return cratePath;
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

const { outputDir } = parseArgs(Bun.argv.slice(2));
const version = await currentOliphauntWasixSdkVersion();
const manifest = await prepareOliphauntWasixReleaseSource(version);
const cratePath = await manualCargoPackageSource(manifest, outputDir);
console.log(rel(cratePath));
