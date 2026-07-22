import { gzipSync } from "node:zlib";
import {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { captureCommandOutput } from "../dev/capture-command-output.mjs";
import { readPortableArchiveEntries } from "./portable-archive.mjs";

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
  const args = [
    "metadata",
    "--manifest-path",
    manifest,
    "--format-version",
    "1",
    "--no-deps",
  ];
  const result = captureCommandOutput("cargo", args, {
    cwd: root,
    label: `cargo metadata --manifest-path ${rel(manifest)}`,
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

const CARGO_VIRTUAL_PACKAGE_FILES = new Set([
  ".cargo_vcs_info.json",
  "Cargo.lock",
  "Cargo.toml.orig",
]);

export function cargoPackageRelativePathParts(value) {
  if (
    !value
    || value.includes("\\")
    || value.includes("\0")
    || value.startsWith("/")
    || /^[A-Za-z]:/u.test(value)
  ) {
    throw new Error(`unsafe Cargo package path ${JSON.stringify(value)}`);
  }
  const parts = value.split("/");
  if (
    parts.some((part) =>
      !part
      || part === "."
      || part === ".."
      || /[<>:"|?*]/u.test(part)
      || /[ .]$/u.test(part)
    )
  ) {
    throw new Error(`non-portable Cargo package path ${JSON.stringify(value)}`);
  }
  return parts;
}

function portablePackagePath(value, manifest, { fail, rel }) {
  try {
    return cargoPackageRelativePathParts(value);
  } catch (cause) {
    abort(fail, `cargo package --list for ${rel(manifest)} returned ${cause.message}`);
  }
}

function cargoPackageSourceFiles(manifest, { root, fail, rel }) {
  const args = [
    "package",
    "--manifest-path",
    manifest,
    "--allow-dirty",
    "--list",
  ];
  const result = captureCommandOutput("cargo", args, {
    cwd: root,
    label: `cargo package --list --manifest-path ${rel(manifest)}`,
  });
  if (result.error !== undefined) {
    abort(fail, `cargo failed to start while listing ${rel(manifest)}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    abort(fail, `cargo package --list failed for ${rel(manifest)}${detail ? `: ${detail}` : ""}`);
  }
  const files = result.stdout.split(/\r?\n/u).filter(Boolean);
  if (files.length === 0) {
    abort(fail, `cargo package --list returned no files for ${rel(manifest)}`);
  }
  const seen = new Set();
  for (const file of files) {
    portablePackagePath(file, manifest, { fail, rel });
    if (seen.has(file)) {
      abort(fail, `cargo package --list repeated ${file} for ${rel(manifest)}`);
    }
    seen.add(file);
  }
  if (!seen.has("Cargo.toml")) {
    abort(fail, `cargo package --list omitted Cargo.toml for ${rel(manifest)}`);
  }
  return files;
}

function sourceFileWithoutSymlinkComponents(sourceDir, parts, manifest, { fail, rel }) {
  let source = sourceDir;
  for (const part of parts) {
    source = path.join(source, part);
    let metadata;
    try {
      metadata = lstatSync(source);
    } catch (cause) {
      abort(fail, `cargo-listed source ${rel(source)} for ${rel(manifest)} is missing: ${cause.message}`);
    }
    if (metadata.isSymbolicLink()) {
      abort(fail, `cargo-listed source ${rel(source)} for ${rel(manifest)} must not be a symbolic link`);
    }
  }
  const metadata = lstatSync(source);
  if (!metadata.isFile()) {
    abort(fail, `cargo-listed source ${rel(source)} for ${rel(manifest)} must be a regular file`);
  }
  return { metadata, source };
}

function copyCargoPackageSource(manifest, destination, options) {
  const sourceDir = path.dirname(manifest);
  const copied = new Set(["Cargo.toml"]);
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(destination, { recursive: true });
  for (const relative of cargoPackageSourceFiles(manifest, options)) {
    if (relative === "Cargo.toml") {
      continue;
    }
    const parts = portablePackagePath(relative, manifest, options);
    try {
      lstatSync(path.join(sourceDir, ...parts));
    } catch (cause) {
      if (CARGO_VIRTUAL_PACKAGE_FILES.has(relative)) {
        continue;
      }
      abort(
        options.fail,
        `cargo-listed source ${relative} for ${options.rel(manifest)} is missing: ${cause.message}`,
      );
    }
    const { source, metadata } = sourceFileWithoutSymlinkComponents(
      sourceDir,
      parts,
      manifest,
      options,
    );
    const target = path.join(destination, ...parts);
    mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(source, target);
    chmodSync(target, metadata.mode & 0o777);
    copied.add(relative);
  }
  const manifestMetadata = lstatSync(manifest);
  if (manifestMetadata.isSymbolicLink() || !manifestMetadata.isFile()) {
    abort(options.fail, `${options.rel(manifest)} must be a regular, non-symlink Cargo manifest`);
  }
  const targetManifest = path.join(destination, "Cargo.toml");
  copyFileSync(manifest, targetManifest);
  chmodSync(targetManifest, manifestMetadata.mode & 0o777);
  return copied;
}

function requireExactCrateMembers(cratePath, packageRoot, expected, { fail, rel }) {
  const prefix = `${packageRoot}/`;
  const actual = [...readPortableArchiveEntries(cratePath).keys()].map((member) => {
    if (!member.startsWith(prefix) || member.length === prefix.length) {
      abort(fail, `${rel(cratePath)} contains member outside ${packageRoot}: ${member}`);
    }
    return member.slice(prefix.length);
  }).sort(compareText);
  const wanted = [...expected].sort(compareText);
  if (actual.length !== wanted.length || actual.some((member, index) => member !== wanted[index])) {
    const actualSet = new Set(actual);
    const wantedSet = new Set(wanted);
    const missing = wanted.filter((member) => !actualSet.has(member));
    const unexpected = actual.filter((member) => !wantedSet.has(member));
    abort(
      fail,
      `${rel(cratePath)} member set differs from Cargo's package selection: `
        + `missing=${JSON.stringify(missing)}, unexpected=${JSON.stringify(unexpected)}`,
    );
  }
}

function requirePackagedCargoTargetSources(
  packageMetadata,
  stageDir,
  expectedMembers,
  stagedManifest,
  options,
) {
  if (!Array.isArray(packageMetadata.targets)) {
    abort(options.fail, `cargo metadata for ${options.rel(stagedManifest)} omitted package targets`);
  }
  const absoluteStage = path.resolve(stageDir);
  for (const target of packageMetadata.targets) {
    if (target === null || typeof target !== "object" || typeof target.src_path !== "string") {
      abort(
        options.fail,
        `cargo metadata for ${options.rel(stagedManifest)} returned an invalid package target`,
      );
    }
    if (!path.isAbsolute(target.src_path)) {
      abort(
        options.fail,
        `cargo target ${JSON.stringify(target.name)} for ${options.rel(stagedManifest)} has a non-absolute source path`,
      );
    }
    const relative = path.relative(absoluteStage, path.resolve(target.src_path));
    if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      abort(
        options.fail,
        `cargo target ${JSON.stringify(target.name)} for ${options.rel(stagedManifest)} is outside the staged package`,
      );
    }
    const normalized = relative.split(path.sep).join("/");
    const parts = portablePackagePath(normalized, stagedManifest, options);
    if (!expectedMembers.has(normalized)) {
      abort(
        options.fail,
        `cargo target ${JSON.stringify(target.name)} source ${normalized} is absent from Cargo's package selection`,
      );
    }
    sourceFileWithoutSymlinkComponents(stageDir, parts, stagedManifest, options);
  }
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
  const packageRoot = `${name}-${version}`;
  const stageRoot = path.join(outputDir, "manual-package-stage");
  const stageDir = path.join(stageRoot, packageRoot);
  const cratePath = path.join(outputDir, `${packageRoot}.crate`);
  const expectedMembers = copyCargoPackageSource(manifest, stageDir, { root, fail, rel });

  const stagedManifest = path.join(stageDir, "Cargo.toml");
  writeFileSync(stagedManifest, packagedCargoManifestText(readFileSync(stagedManifest, "utf8")));
  const packageMetadata = cargoMetadataPackageFromManifest(stagedManifest, { root, fail, rel });
  if (packageMetadata.name !== name || packageMetadata.version !== version) {
    abort(fail, `${rel(stagedManifest)} produced unexpected cargo metadata`);
  }
  requirePackagedCargoTargetSources(
    packageMetadata,
    stageDir,
    expectedMembers,
    stagedManifest,
    { fail, rel },
  );

  mkdirSync(outputDir, { recursive: true });
  rmSync(cratePath, { force: true });
  writeFileSync(cratePath, gzipSync(createDeterministicTar(stageDir, packageRoot, { fail }), { mtime: 0 }));
  requireExactCrateMembers(cratePath, packageRoot, expectedMembers, { fail, rel });
  const size = statSync(cratePath).size;
  if (size > packageSizeLimitBytes) {
    abort(fail, `${rel(cratePath)} is ${size} bytes, above the crates.io 10 MiB package limit`);
  }
  return cratePath;
}
