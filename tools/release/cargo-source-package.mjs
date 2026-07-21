import { spawnSync } from "node:child_process";
import { gzipSync } from "node:zlib";
import {
  cpSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

export const CARGO_PACKAGE_SIZE_LIMIT_BYTES = 10 * 1024 * 1024;

export function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function abort(fail, message) {
  if (typeof fail === "function") {
    fail(message);
  }
  throw new Error(message);
}

export function parseCargoPackageNameVersion(text, context, { fail = null } = {}) {
  let inPackage = false;
  let name = null;
  let version = null;
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line === "[package]") {
      inPackage = true;
      continue;
    }
    if (inPackage && line.startsWith("[")) {
      break;
    }
    if (!inPackage) {
      continue;
    }
    name ??= line.match(/^name\s*=\s*"([^"]+)"/u)?.[1] ?? null;
    version ??= line.match(/^version\s*=\s*"([^"]+)"/u)?.[1] ?? null;
  }
  if (!name || !version) {
    abort(fail, `${context} must declare package.name and package.version`);
  }
  return { name, version };
}

export function readCargoPackageNameVersion(manifest, { fail = null, rel = String } = {}) {
  return parseCargoPackageNameVersion(readFileSync(manifest, "utf8"), rel(manifest), { fail });
}

export function packagedCargoManifestText(source) {
  let text = source
    .replaceAll("repository.workspace = true", 'repository = "https://github.com/f0rr0/oliphaunt"')
    .replaceAll("homepage.workspace = true", 'homepage = "https://oliphaunt.dev"');
  text = text.replace(/, path = "[^"]+"/gu, "");
  if (!text.includes("\n[workspace]")) {
    text = `${text.trimEnd()}\n\n[workspace]\n`;
  }
  return text;
}

function cargoMetadataPackageFromManifest(manifest, { root, fail, rel }) {
  const result = spawnSync("cargo", [
    "metadata",
    "--manifest-path",
    manifest,
    "--format-version",
    "1",
    "--no-deps",
  ], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error !== undefined) {
    abort(fail, `cargo failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    abort(fail, `cargo metadata failed for ${rel(manifest)}: ${result.stderr.trim()}`);
  }
  let data;
  try {
    data = JSON.parse(result.stdout);
  } catch (error) {
    abort(fail, `cargo metadata for ${rel(manifest)} did not return valid JSON: ${error.message}`);
  }
  const packages = data.packages;
  if (!Array.isArray(packages) || packages.length !== 1 || typeof packages[0] !== "object") {
    abort(fail, `cargo metadata for ${rel(manifest)} did not return exactly one package`);
  }
  return packages[0];
}

function copySourceTree(source, destination, ignoredNames) {
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(path.dirname(destination), { recursive: true });
  cpSync(source, destination, {
    recursive: true,
    filter: (sourcePath) => !ignoredNames.has(path.basename(sourcePath)),
  });
}

function listFilesRecursive(directory) {
  const files = [];
  const entries = readdirSync(directory, { withFileTypes: true });
  entries.sort((left, right) => compareText(left.name, right.name));
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFilesRecursive(fullPath));
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      files.push(fullPath);
    }
  }
  return files;
}

function tarPathParts(relativePath, { fail }) {
  const normalized = relativePath.split(path.sep).join("/");
  if (Buffer.byteLength(normalized) <= 100) {
    return { name: normalized, prefix: "" };
  }
  const parts = normalized.split("/");
  for (let index = 1; index < parts.length; index += 1) {
    const prefix = parts.slice(0, index).join("/");
    const name = parts.slice(index).join("/");
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) {
      return { name, prefix };
    }
  }
  abort(fail, `crate archive path is too long for ustar: ${normalized}`);
}

function writeString(buffer, offset, length, value, { fail }) {
  const bytes = Buffer.from(value);
  if (bytes.length > length) {
    abort(fail, `tar header field overflow for '${value}'`);
  }
  bytes.copy(buffer, offset);
}

function writeOctal(buffer, offset, length, value, options) {
  const text = value.toString(8);
  if (text.length > length - 1) {
    abort(options.fail, `tar header octal field overflow for '${value}'`);
  }
  writeString(buffer, offset, length, `${text.padStart(length - 1, "0")}\0`, options);
}

function tarHeader(relativePath, size, mode, options) {
  const header = Buffer.alloc(512, 0);
  const { name, prefix } = tarPathParts(relativePath, options);
  writeString(header, 0, 100, name, options);
  writeOctal(header, 100, 8, mode, options);
  writeOctal(header, 108, 8, 0, options);
  writeOctal(header, 116, 8, 0, options);
  writeOctal(header, 124, 12, size, options);
  writeOctal(header, 136, 12, 0, options);
  header.fill(0x20, 148, 156);
  writeString(header, 156, 1, "0", options);
  writeString(header, 257, 6, "ustar\0", options);
  writeString(header, 263, 2, "00", options);
  writeString(header, 345, 155, prefix, options);
  let checksum = 0;
  for (const byte of header) {
    checksum += byte;
  }
  const checksumText = checksum.toString(8);
  if (checksumText.length > 6) {
    abort(options.fail, `tar header checksum overflow for ${relativePath}`);
  }
  writeString(header, 148, 8, `${checksumText.padStart(6, "0")}\0 `, options);
  return header;
}

export function createDeterministicTar(stageDir, packageRoot, options) {
  const chunks = [];
  const files = listFilesRecursive(stageDir);
  files.sort((left, right) => compareText(path.relative(stageDir, left), path.relative(stageDir, right)));
  for (const file of files) {
    const relative = path.relative(stageDir, file).split(path.sep).join("/");
    const archivePath = `${packageRoot}/${relative}`;
    const stats = statSync(file);
    const data = readFileSync(file);
    chunks.push(tarHeader(archivePath, data.length, stats.mode & 0o777, options));
    chunks.push(data);
    const remainder = data.length % 512;
    if (remainder !== 0) {
      chunks.push(Buffer.alloc(512 - remainder, 0));
    }
  }
  chunks.push(Buffer.alloc(1024, 0));
  return Buffer.concat(chunks);
}

export function manualCargoPackageSource(
  manifest,
  outputDir,
  {
    root,
    fail = null,
    rel = String,
    packageSizeLimitBytes = CARGO_PACKAGE_SIZE_LIMIT_BYTES,
  },
) {
  const { name, version } = readCargoPackageNameVersion(manifest, { fail, rel });
  const sourceDir = path.dirname(manifest);
  const packageRoot = `${name}-${version}`;
  const stageRoot = path.join(outputDir, "manual-package-stage");
  const stageDir = path.join(stageRoot, packageRoot);
  const cratePath = path.join(outputDir, `${packageRoot}.crate`);
  copySourceTree(sourceDir, stageDir, new Set(["target", ".git", ".DS_Store"]));

  const stagedManifest = path.join(stageDir, "Cargo.toml");
  writeFileSync(stagedManifest, packagedCargoManifestText(readFileSync(stagedManifest, "utf8")));
  const packageMetadata = cargoMetadataPackageFromManifest(stagedManifest, { root, fail, rel });
  if (packageMetadata.name !== name || packageMetadata.version !== version) {
    abort(fail, `${rel(stagedManifest)} produced unexpected cargo metadata`);
  }

  mkdirSync(outputDir, { recursive: true });
  rmSync(cratePath, { force: true });
  writeFileSync(cratePath, gzipSync(createDeterministicTar(stageDir, packageRoot, { fail }), { mtime: 0 }));
  const size = statSync(cratePath).size;
  if (size > packageSizeLimitBytes) {
    abort(fail, `${rel(cratePath)} is ${size} bytes, above the crates.io 10 MiB package limit`);
  }
  return cratePath;
}
