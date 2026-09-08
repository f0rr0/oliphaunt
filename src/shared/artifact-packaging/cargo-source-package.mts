import {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { tarHeader } from './archive-directory.mts';
import { canonicalGzipSync, readPortableArchiveEntries } from './portable-archive.mts';

export const CARGO_PACKAGE_SIZE_LIMIT_BYTES = 10 * 1024 * 1024;

// Keep 1 MiB below the registry limit. The raw budget only bounds working
// memory; the finished deterministic .crate decides whether splitting is needed.
export function fitCargoPayloadParts(buildParts, packagePart, rawBudget = 64 * 1024 * 1024) {
  if (!Number.isSafeInteger(rawBudget) || rawBudget < 1) {
    throw new Error('Cargo payload raw budget must be a positive integer');
  }
  for (;;) {
    const parts = buildParts(rawBudget);
    if (!parts.length) throw new Error('Cargo payload produced no parts');
    if (parts.every((part) => statSync(packagePart(part)).size <= 9 * 1024 * 1024)) return parts;
    if (rawBudget === 1) throw new Error('Cargo payload metadata exceeds the package size limit');
    rawBudget = Math.max(1, Math.floor(rawBudget / 2));
  }
}

export function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function abort(fail, message) {
  if (typeof fail === 'function') {
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
    abort(fail, `${context} must declare package.name and package.version`);
  }
  return { name, version };
}

export function readCargoPackageNameVersion(manifest, { fail = null, rel = String } = {}) {
  return parseCargoPackageNameVersion(readFileSync(manifest, 'utf8'), rel(manifest), { fail });
}

export function packagedCargoManifestText(source) {
  let text = source
    .replaceAll('repository.workspace = true', 'repository = "https://github.com/f0rr0/oliphaunt"')
    .replaceAll('homepage.workspace = true', 'homepage = "https://oliphaunt.dev"');
  text = text.replace(/, path = "[^"]+"/gu, '');
  if (!text.includes('\n[workspace]')) {
    text = `${text.trimEnd()}\n\n[workspace]\n`;
  }
  return text;
}

const CARGO_VIRTUAL_PACKAGE_FILES = new Set([
  '.cargo_vcs_info.json',
  'Cargo.lock',
  'Cargo.toml.orig',
]);

export function cargoPackageRelativePathParts(value) {
  if (
    !value ||
    value.includes('\\') ||
    value.includes('\0') ||
    value.startsWith('/') ||
    /^[A-Za-z]:/u.test(value)
  ) {
    throw new Error(`unsafe Cargo package path ${JSON.stringify(value)}`);
  }
  const parts = value.split('/');
  if (
    parts.some(
      (part) =>
        !part || part === '.' || part === '..' || /[<>:"|?*]/u.test(part) || /[ .]$/u.test(part),
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

function parseCargoPackageFiles(text, manifest, { fail, rel }) {
  const files = text.split(/\r?\n/u).filter(Boolean);
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
  if (!seen.has('Cargo.toml')) {
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
      abort(
        fail,
        `cargo-listed source ${rel(source)} for ${rel(manifest)} is missing: ${cause.message}`,
      );
    }
    if (metadata.isSymbolicLink()) {
      abort(
        fail,
        `cargo-listed source ${rel(source)} for ${rel(manifest)} must not be a symbolic link`,
      );
    }
  }
  const metadata = lstatSync(source);
  if (!metadata.isFile()) {
    abort(fail, `cargo-listed source ${rel(source)} for ${rel(manifest)} must be a regular file`);
  }
  return { metadata, source };
}

function copyCargoPackageSource(manifest, destination, files, options) {
  const sourceDir = path.dirname(manifest);
  const copied = new Set(['Cargo.toml']);
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(destination, { recursive: true });
  for (const relative of files) {
    if (relative === 'Cargo.toml') {
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
  const targetManifest = path.join(destination, 'Cargo.toml');
  copyFileSync(manifest, targetManifest);
  chmodSync(targetManifest, manifestMetadata.mode & 0o777);
  return copied;
}

function requireExactCrateMembers(cratePath, packageRoot, expected, { fail, rel }) {
  const prefix = `${packageRoot}/`;
  const actual = [...readPortableArchiveEntries(cratePath).keys()]
    .map((member) => {
      if (!member.startsWith(prefix) || member.length === prefix.length) {
        abort(fail, `${rel(cratePath)} contains member outside ${packageRoot}: ${member}`);
      }
      return member.slice(prefix.length);
    })
    .sort(compareText);
  const wanted = [...expected].sort(compareText);
  if (actual.length !== wanted.length || actual.some((member, index) => member !== wanted[index])) {
    const actualSet = new Set(actual);
    const wantedSet = new Set(wanted);
    const missing = wanted.filter((member) => !actualSet.has(member));
    const unexpected = actual.filter((member) => !wantedSet.has(member));
    abort(
      fail,
      `${rel(cratePath)} member set differs from Cargo's package selection: ` +
        `missing=${JSON.stringify(missing)}, unexpected=${JSON.stringify(unexpected)}`,
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
    abort(
      options.fail,
      `cargo metadata for ${options.rel(stagedManifest)} omitted package targets`,
    );
  }
  const absoluteStage = path.resolve(stageDir);
  for (const target of packageMetadata.targets) {
    if (target === null || typeof target !== 'object' || typeof target.src_path !== 'string') {
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
    const normalized = relative.split(path.sep).join('/');
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
    } else if (entry.isFile()) {
      files.push(fullPath);
    } else {
      throw new Error(
        'Cargo archive source must contain only regular files and directories: ' + fullPath,
      );
    }
  }
  return files;
}

export function createDeterministicTar(stageDir, packageRoot, options) {
  const chunks = [];
  const fixedFileMode = options.fixedFileMode;
  if (
    fixedFileMode !== undefined &&
    (!Number.isInteger(fixedFileMode) || fixedFileMode < 0 || fixedFileMode > 0o777)
  ) {
    abort(
      options.fail,
      'fixed deterministic tar file mode must be an integer between 0000 and 0777',
    );
  }
  const files = listFilesRecursive(stageDir);
  files.sort((left, right) =>
    compareText(path.relative(stageDir, left), path.relative(stageDir, right)),
  );
  for (const file of files) {
    const relative = path.relative(stageDir, file).split(path.sep).join('/');
    const archivePath = `${packageRoot}/${relative}`;
    const stats = statSync(file);
    const data = readFileSync(file);
    const mode = fixedFileMode ?? stats.mode & 0o777;
    chunks.push(tarHeader({ name: archivePath }, data.length, mode));
    chunks.push(data);
    const remainder = data.length % 512;
    if (remainder !== 0) {
      chunks.push(Buffer.alloc(512 - remainder, 0));
    }
  }
  chunks.push(Buffer.alloc(1024, 0));
  return Buffer.concat(chunks);
}

export function prepareCargoPackageSource(
  manifest,
  outputDir,
  files,
  { fail = null, rel = String } = {},
) {
  const { name, version } = readCargoPackageNameVersion(manifest, { fail, rel });
  const packageRoot = `${name}-${version}`;
  cargoPackageRelativePathParts(packageRoot);
  const stageDir = path.resolve(outputDir, 'manual-package-stage', packageRoot);
  const cratePath = path.resolve(outputDir, `${packageRoot}.crate`);
  const expectedMembers = [...copyCargoPackageSource(manifest, stageDir, files, { fail, rel })];
  const stagedManifest = path.join(stageDir, 'Cargo.toml');
  writeFileSync(stagedManifest, packagedCargoManifestText(readFileSync(stagedManifest, 'utf8')));
  return { name, version, packageRoot, stageDir, cratePath, expectedMembers, stagedManifest };
}

export function finishCargoPackageSource(state, packageMetadata, options = {}) {
  const { fail = null, rel = String } = options;
  const { name, version, stageDir, stagedManifest } = state;
  const expectedMembers = new Set(state.expectedMembers);
  if (packageMetadata.name !== name || packageMetadata.version !== version) {
    abort(fail, `${rel(stagedManifest)} produced unexpected cargo metadata`);
  }
  requirePackagedCargoTargetSources(packageMetadata, stageDir, expectedMembers, stagedManifest, {
    fail,
    rel,
  });
  return freezeCargoPackageSource(state, options);
}

function freezeCargoPackageSource(
  { stageDir, packageRoot, cratePath, expectedMembers },
  { fail = null, rel = String, packageSizeLimitBytes = CARGO_PACKAGE_SIZE_LIMIT_BYTES } = {},
) {
  rmSync(cratePath, { force: true });
  writeFileSync(
    cratePath,
    canonicalGzipSync(createDeterministicTar(stageDir, packageRoot, { fail })),
  );
  requireExactCrateMembers(cratePath, packageRoot, expectedMembers, { fail, rel });
  const size = statSync(cratePath).size;
  if (size > packageSizeLimitBytes) {
    abort(fail, `${rel(cratePath)} is ${size} bytes, above the crates.io 10 MiB package limit`);
  }
  return cratePath;
}

/** Every file in this private generated source tree belongs to the carrier. */
export function packageGeneratedCargoSource(manifest, outputDir, options = {}) {
  const source = path.dirname(manifest);
  const files = listFilesRecursive(source).map((file) =>
    path.relative(source, file).split(path.sep).join('/'),
  );
  const state = prepareCargoPackageSource(manifest, outputDir, files, options);
  return freezeCargoPackageSource(state, options);
}

if (import.meta.main) {
  const [phase, stateFile, ...args] = process.argv.slice(2);
  if (phase === 'prepare' && args.length === 3) {
    const [manifest, outputDir, listing] = args;
    const state = prepareCargoPackageSource(
      manifest,
      outputDir,
      parseCargoPackageFiles(readFileSync(listing, 'utf8'), manifest, { fail: null, rel: String }),
    );
    writeFileSync(stateFile, JSON.stringify(state));
    console.log(state.stagedManifest);
  } else if (phase === 'finish' && args.length === 1) {
    const metadata = JSON.parse(readFileSync(args[0], 'utf8'));
    if (!Array.isArray(metadata.packages) || metadata.packages.length !== 1) {
      throw new Error('Cargo metadata must contain exactly one package');
    }
    console.log(
      finishCargoPackageSource(JSON.parse(readFileSync(stateFile, 'utf8')), metadata.packages[0]),
    );
  } else {
    throw new Error(
      'usage: cargo-source-package.mts prepare STATE MANIFEST OUTPUT LIST | finish STATE METADATA',
    );
  }
}
