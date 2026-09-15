import { assertSameStringSet } from './release-carrier.mts';
import { createHash } from 'node:crypto';
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import {
  createDeterministicTar,
  fitCargoPayloadParts,
  packageGeneratedCargoSource,
} from './cargo-source-package.mts';
import { canonicalGzipSync } from './portable-archive.mts';
import {
  assertReleaseNoticesInArchive,
  assertReleaseNoticesInDirectory,
  releaseNoticeRows,
  releaseProfilePackageLicense,
  stageReleaseNotices,
} from './release-notices.mts';
import {
  allArtifactTargets,
  compareText,
  currentProductVersion,
  ROOT,
} from '../release/release-artifact-targets.mts';

const PREFIX = 'native-cargo-payload.mts';
const PRODUCT = 'liboliphaunt-native';
const CRATES_IO_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_PART_BYTES = 64 * 1024 * 1024;
export const NATIVE_CARGO_CARRIER_LICENSES = Object.freeze({
  'native-runtime': releaseProfilePackageLicense('native-runtime').spdx,
  'native-tools': releaseProfilePackageLicense('native-tools').spdx,
  'code-facade': releaseProfilePackageLicense('code-facade').spdx,
});

const AGGREGATOR_BUILD_RS = String.raw`use std::collections::BTreeMap;
use std::env;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

const SCHEMA: &str = __SCHEMA__;
const PRODUCT: &str = __PRODUCT__;
const VERSION: &str = __VERSION__;
const KIND: &str = __KIND__;
const TARGET: &str = __TARGET__;
const PART_ROOTS: &[&str] = &[
__PART_ROOTS__
];
const FILE_SHA256: &[(&str, &str)] = &[
__FILE_SHA256__
];

fn main() {
    emit_manifest();
}

fn emit_manifest() {
    let out_dir = PathBuf::from(env::var_os("OUT_DIR").expect("OUT_DIR is set"));
    let payload = out_dir.join("payload");
    if payload.exists() {
        fs::remove_dir_all(&payload).expect("remove stale liboliphaunt native payload");
    }
    fs::create_dir_all(&payload).expect("create liboliphaunt native payload directory");

    let part_roots = part_roots();
    if part_roots.is_empty() {
        if env::var_os("OLIPHAUNT_ARTIFACT_CRATE_REQUIRE_PAYLOAD").is_some() {
            panic!("missing liboliphaunt native payload part crates");
        }
        return;
    }

    let mut chunk_files: BTreeMap<String, Vec<(usize, PathBuf)>> = BTreeMap::new();
    for root in part_roots {
        println!("cargo::rerun-if-changed={}", root.display());
        copy_complete_files(&root.join("files"), &payload).expect("copy complete payload files");
        collect_chunks(&root.join("chunks"), &root.join("chunks"), &mut chunk_files)
            .expect("collect payload chunks");
    }

    for (relative, mut chunks) in chunk_files {
        chunks.sort_by_key(|(index, _)| *index);
        for (expected, (actual, _)) in chunks.iter().enumerate() {
            if *actual != expected {
                panic!("non-contiguous liboliphaunt chunk indexes for {relative}");
            }
        }
        let output = payload.join(&relative);
        if let Some(parent) = output.parent() {
            fs::create_dir_all(parent).expect("create reconstructed file parent");
        }
        let mut writer = fs::File::create(&output).expect("create reconstructed payload file");
        for (_, path) in chunks {
            let mut reader = fs::File::open(&path).expect("open payload chunk");
            io::copy(&mut reader, &mut writer).expect("append payload chunk");
        }
    }

    let files = collect_files(&payload).expect("collect reconstructed liboliphaunt payload files");
    if files.is_empty() {
        panic!("liboliphaunt native payload part crates produced no files");
    }
    let manifest = out_dir.join("oliphaunt-artifact.toml");
    let mut text = format!(
        "schema = {SCHEMA:?}\nproduct = {PRODUCT:?}\nversion = {VERSION:?}\nkind = {KIND:?}\ntarget = {TARGET:?}\n"
    );
    if files.len() != FILE_SHA256.len() {
        panic!("reconstructed liboliphaunt payload file count does not match the frozen inventory");
    }
    for file in files {
        let relative = file.strip_prefix(&payload)
            .expect("payload file stays under payload root")
            .to_string_lossy()
            .replace('\\', "/");
        let sha256 = FILE_SHA256.iter()
            .find_map(|(candidate, digest)| (*candidate == relative).then_some(*digest))
            .unwrap_or_else(|| panic!("reconstructed liboliphaunt payload has undeclared file {relative}"));
        text.push_str(&format!(
            "\n[[files]]\nsource = {:?}\nrelative = {:?}\nsha256 = {:?}\nexecutable = {}\n",
            file.display().to_string(),
            relative,
            sha256,
            is_executable_relative(&relative),
        ));
    }
    fs::write(&manifest, text).expect("write liboliphaunt native artifact manifest");
    println!("cargo::metadata=manifest={}", manifest.display());
}

fn part_roots() -> Vec<PathBuf> {
    PART_ROOTS.iter().map(PathBuf::from).collect()
}

fn copy_complete_files(source: &Path, destination: &Path) -> io::Result<()> {
    if !source.is_dir() {
        return Ok(());
    }
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let path = entry.path();
        let output = destination.join(path.strip_prefix(source).unwrap_or(&path));
        copy_tree_entry(&path, &output)?;
    }
    Ok(())
}

fn copy_tree_entry(source: &Path, destination: &Path) -> io::Result<()> {
    let metadata = fs::metadata(source)?;
    if metadata.is_dir() {
        fs::create_dir_all(destination)?;
        for entry in fs::read_dir(source)? {
            let entry = entry?;
            copy_tree_entry(&entry.path(), &destination.join(entry.file_name()))?;
        }
    } else if metadata.is_file() {
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::copy(source, destination)?;
    }
    Ok(())
}

fn collect_chunks(
    root: &Path,
    current: &Path,
    chunks: &mut BTreeMap<String, Vec<(usize, PathBuf)>>,
) -> io::Result<()> {
    if !current.is_dir() {
        return Ok(());
    }
    for entry in fs::read_dir(current)? {
        let entry = entry?;
        let path = entry.path();
        let metadata = fs::metadata(&path)?;
        if metadata.is_dir() {
            collect_chunks(root, &path, chunks)?;
            continue;
        }
        if !metadata.is_file() {
            continue;
        }
        let relative = path.strip_prefix(root).unwrap_or(&path).to_string_lossy().replace('\\', "/");
        let (file_relative, part_index) = split_part_relative(&relative)
            .unwrap_or_else(|| panic!("invalid liboliphaunt chunk file name {relative}"));
        chunks.entry(file_relative).or_default().push((part_index, path));
    }
    Ok(())
}

fn split_part_relative(relative: &str) -> Option<(String, usize)> {
    let (file, index) = relative.rsplit_once(".part")?;
    if file.is_empty() || index.len() != 3 || !index.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    Some((file.to_owned(), index.parse().ok()?))
}

fn collect_files(root: &Path) -> io::Result<Vec<PathBuf>> {
    let mut files = Vec::new();
    collect_files_inner(root, &mut files)?;
    files.sort();
    Ok(files)
}

fn collect_files_inner(path: &Path, files: &mut Vec<PathBuf>) -> io::Result<()> {
    if !path.is_dir() {
        return Ok(());
    }
    for entry in fs::read_dir(path)? {
        let entry = entry?;
        let entry_path = entry.path();
        let metadata = fs::metadata(&entry_path)?;
        if metadata.is_dir() {
            collect_files_inner(&entry_path, files)?;
        } else if metadata.is_file() {
            files.push(entry_path);
        }
    }
    Ok(())
}

fn is_executable_relative(relative: &str) -> bool {
    relative.starts_with("runtime/bin/") || relative.starts_with("bin/")
}
`;

export function fail(message) {
  console.error(`${PREFIX}: ${message}`);
  process.exit(1);
}

export function rel(file) {
  const relative = path.relative(ROOT, String(file));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    return String(file).split(path.sep).join('/');
  }
  return relative.split(path.sep).join('/');
}

function repoPath(value) {
  return path.isAbsolute(value) ? value : path.join(ROOT, value);
}

export function isFile(file) {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

function isDirectory(file) {
  try {
    return statSync(file).isDirectory();
  } catch {
    return false;
  }
}

export function cargoPackageName(targetId, { packageBase = PRODUCT } = {}) {
  return `${packageBase}-${targetId}`;
}

function cargoLinksName(targetId, { artifactProduct = PRODUCT } = {}) {
  return `oliphaunt_artifact_${artifactProduct.replaceAll('-', '_')}_${targetId.replaceAll('-', '_')}`;
}

function partPackageName(targetId, index, { packageBase = PRODUCT } = {}) {
  if (!Number.isSafeInteger(index) || index < 1 || index > 999) {
    fail(
      `Cargo payload part number must be an integer from 1 through 999, got ${JSON.stringify(index)}`,
    );
  }
  return `${cargoPackageName(targetId, { packageBase })}-part-${String(index).padStart(3, '0')}`;
}

function partLinksName(targetId, index, { artifactProduct = PRODUCT } = {}) {
  if (!Number.isSafeInteger(index) || index < 1 || index > 999) {
    fail(
      `Cargo payload part number must be an integer from 1 through 999, got ${JSON.stringify(index)}`,
    );
  }
  return `oliphaunt_artifact_part_${artifactProduct.replaceAll('-', '_')}_${targetId.replaceAll('-', '_')}_${String(index).padStart(3, '0')}`;
}

function rustCrateIdent(crateName) {
  return crateName.replaceAll('-', '_');
}

function tomlString(value) {
  return JSON.stringify(value);
}

function cargoIncludeMembers(profile, baseMembers) {
  return JSON.stringify([
    ...baseMembers,
    ...releaseNoticeRows({ profile }).map((row) => row.member),
  ]);
}

function writePartCrate(
  crateDir,
  { targetId, index, version, packageBase, artifactProduct, artifactLabel, noticeProfile },
) {
  rmSync(crateDir, { recursive: true, force: true });
  const name = partPackageName(targetId, index, { packageBase });
  const links = partLinksName(targetId, index, { artifactProduct });
  mkdirSync(path.join(crateDir, 'src'), { recursive: true });
  writeFileSync(
    path.join(crateDir, 'Cargo.toml'),
    `[package]
name = "${name}"
version = "${version}"
edition = "2024"
rust-version = "1.93"
description = "Cargo payload part ${String(index).padStart(3, '0')} for the ${targetId} ${artifactLabel}."
readme = "README.md"
repository = "https://github.com/f0rr0/oliphaunt"
homepage = "https://oliphaunt.dev"
license = "${NATIVE_CARGO_CARRIER_LICENSES[noticeProfile]}"
links = "${links}"
build = "build.rs"
include = ${cargoIncludeMembers(noticeProfile, ['Cargo.toml', 'README.md', 'build.rs', 'src/**', 'payload/**'])}

[lib]
path = "src/lib.rs"

[workspace]
`,
  );
  writeFileSync(
    path.join(crateDir, 'README.md'),
    `# ${name}

Cargo payload part for the \`${targetId}\` ${artifactLabel}.
Applications do not depend on this crate directly.
`,
  );
  writeFileSync(
    path.join(crateDir, 'src/lib.rs'),
    `pub const RELEASE_TARGET: &str = "${targetId}";
pub const PART_INDEX: usize = ${index};
pub const PAYLOAD_ROOT: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/payload");
`,
  );
  writeFileSync(
    path.join(crateDir, 'build.rs'),
    `use std::env;
use std::path::PathBuf;

fn main() {
    let manifest_dir =
        PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR is set"));
    let root = manifest_dir.join("payload");
    println!("cargo::rerun-if-changed={}", root.display());
    if !root.is_dir() {
        if env::var_os("OLIPHAUNT_ARTIFACT_CRATE_REQUIRE_PAYLOAD").is_some() {
            panic!("missing packaged Oliphaunt artifact payload under {}", root.display());
        }
        return;
    }
    println!("cargo::metadata=root={}", root.display());
}
`,
  );
  stageReleaseNotices(crateDir, { profile: noticeProfile });
  assertReleaseNoticesInDirectory(crateDir, { profile: noticeProfile });
}

function writeAggregatorCrate(
  crateDir,
  {
    target,
    version,
    partCount,
    packageBase,
    artifactProduct,
    artifactKind,
    artifactLabel,
    payloadFiles,
  },
) {
  rmSync(crateDir, { recursive: true, force: true });
  if (typeof target.triple !== 'string' || !target.triple) {
    fail(`${target.id} must declare Cargo target triple`);
  }
  const name = cargoPackageName(target.target, { packageBase });
  const links = cargoLinksName(target.target, { artifactProduct });
  mkdirSync(path.join(crateDir, 'src'), { recursive: true });
  const dependencyLines = [];
  const partRoots = [];
  for (let offset = 0; offset < partCount; offset += 1) {
    const partName = partPackageName(target.target, offset + 1, { packageBase });
    dependencyLines.push(`${partName} = { version = "=${version}", path = "../${partName}" }`);
    partRoots.push(`    ${rustCrateIdent(partName)}::PAYLOAD_ROOT,`);
  }
  const libraryRelativePath = target.libraryRelativePath ?? '';
  writeFileSync(
    path.join(crateDir, 'Cargo.toml'),
    `[package]
name = "${name}"
version = "${version}"
edition = "2024"
rust-version = "1.93"
description = "Cargo artifact crate for the ${target.target} ${artifactLabel}."
readme = "README.md"
repository = "https://github.com/f0rr0/oliphaunt"
homepage = "https://oliphaunt.dev"
license = "${NATIVE_CARGO_CARRIER_LICENSES['code-facade']}"
links = "${links}"
build = "build.rs"
include = ${cargoIncludeMembers('code-facade', ['Cargo.toml', 'README.md', 'build.rs', 'src/**'])}

[lib]
path = "src/lib.rs"

[build-dependencies]
${dependencyLines.join('\n')}

[workspace]
`,
  );
  writeFileSync(
    path.join(crateDir, 'README.md'),
    `# ${name}

Cargo artifact crate for the \`${target.target}\` ${artifactLabel}.
Applications do not depend on this crate directly; \`oliphaunt\` selects it for
matching Cargo targets.
`,
  );
  writeFileSync(
    path.join(crateDir, 'src/lib.rs'),
    `pub const PRODUCT: &str = "${artifactProduct}";
pub const KIND: &str = "${artifactKind}";
pub const RELEASE_TARGET: &str = "${target.target}";
pub const CARGO_TARGET: &str = "${target.triple}";
pub const LIBRARY_RELATIVE_PATH: &str = "${libraryRelativePath}";
`,
  );
  writeFileSync(
    path.join(crateDir, 'build.rs'),
    AGGREGATOR_BUILD_RS.replace('__SCHEMA__', tomlString('oliphaunt-artifact-manifest-v1'))
      .replace('__PRODUCT__', tomlString(artifactProduct))
      .replace('__VERSION__', tomlString(version))
      .replace('__KIND__', tomlString(artifactKind))
      .replace('__TARGET__', tomlString(target.triple))
      .replace('__PART_ROOTS__', partRoots.join('\n'))
      .replace(
        '__FILE_SHA256__',
        payloadFiles
          .map(({ relative, sha256 }) => `    (${tomlString(relative)}, ${tomlString(sha256)}),`)
          .join('\n'),
      ),
  );
  stageReleaseNotices(crateDir, { profile: 'code-facade' });
  assertReleaseNoticesInDirectory(crateDir, { profile: 'code-facade' });
}

function walkFiles(root) {
  const files = [];
  const visit = (current) => {
    if (!existsSync(current)) {
      return;
    }
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) {
        visit(file);
      } else if (entry.isFile()) {
        files.push(file);
      }
    }
  };
  visit(root);
  return files.sort(compareText);
}

function frozenPayloadFiles(root) {
  return walkFiles(root).map((file) => ({
    relative: path.relative(root, file).split(path.sep).join('/'),
    sha256: createHash('sha256').update(readFileSync(file)).digest('hex'),
  }));
}

function nextPartDir(
  sourceRoot,
  targetId,
  index,
  version,
  { packageBase, artifactProduct, artifactLabel, noticeProfile },
) {
  const crateDir = path.join(sourceRoot, partPackageName(targetId, index, { packageBase }));
  writePartCrate(crateDir, {
    targetId,
    index,
    version,
    packageBase,
    artifactProduct,
    artifactLabel,
    noticeProfile,
  });
  return crateDir;
}

function writeChunk(file, data) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, data);
}

function copyPayloadFile(source, destination) {
  mkdirSync(path.dirname(destination), { recursive: true });
  copyFileSync(source, destination);
}

function buildPartCrates(
  extractedRoot,
  sourceRoot,
  { targetId, version, partBytes, packageBase, artifactProduct, artifactLabel, noticeProfile },
) {
  const partDirs = [];
  let currentDir;
  let currentSize = 0;
  const startPart = () => {
    const partNumber = partDirs.length + 1;
    if (partNumber > 999) {
      fail(`${targetId} requires more than 999 ${artifactLabel} part crates`);
    }
    const partDir = nextPartDir(sourceRoot, targetId, partNumber, version, {
      packageBase,
      artifactProduct,
      artifactLabel,
      noticeProfile,
    });
    partDirs.push(partDir);
    return partDir;
  };

  for (const source of walkFiles(extractedRoot)) {
    const relative = path.relative(extractedRoot, source).split(path.sep).join('/');
    const size = statSync(source).size;
    if (size > partBytes) {
      currentDir = undefined;
      currentSize = 0;
      const fd = openSync(source, 'r');
      try {
        let partIndex = 0;
        let offset = 0;
        while (offset < size) {
          const length = Math.min(partBytes, size - offset);
          const buffer = Buffer.allocUnsafe(length);
          const bytesRead = readSync(fd, buffer, 0, length, offset);
          if (bytesRead <= 0) {
            break;
          }
          const partDir = startPart();
          writeChunk(
            path.join(
              partDir,
              'payload/chunks',
              `${relative}.part${String(partIndex).padStart(3, '0')}`,
            ),
            buffer.subarray(0, bytesRead),
          );
          offset += bytesRead;
          partIndex += 1;
        }
      } finally {
        closeSync(fd);
      }
      continue;
    }
    if (currentDir === undefined || currentSize + size > partBytes) {
      currentDir = startPart();
      currentSize = 0;
    }
    copyPayloadFile(source, path.join(currentDir, 'payload/files', relative));
    currentSize += size;
  }
  if (partDirs.length === 0) {
    fail(`${targetId} generated no ${artifactLabel} part crates`);
  }
  return partDirs;
}

function validateCrateSize(cratePath) {
  const size = statSync(cratePath).size;
  if (size > CRATES_IO_MAX_BYTES) {
    fail(`${rel(cratePath)} is ${size} bytes, above the crates.io 10 MiB package limit`);
  }
}

export function freezeSourceCrate(packageData, outputDir, cargoTargetDir) {
  const generated = packageGeneratedCargoSource(
    packageData.manifestPath,
    path.join(cargoTargetDir, 'strict-package', packageData.name),
    { root: ROOT, fail, rel },
  );
  assertReleaseNoticesInArchive(generated, {
    prefix: `${packageData.name}-${packageData.version}`,
    profile: packageData.noticeProfile,
  });
  validateCrateSize(generated);
  const cratePath = path.join(outputDir, path.basename(generated));
  copyFileSync(generated, cratePath);
  return { ...packageData, cratePath };
}

export function packagePayload(
  payloadRoot,
  sourceRoot,
  outputDir,
  cargoTargetDir,
  {
    target,
    version,
    partBytes,
    packageBase,
    artifactProduct,
    artifactKind,
    artifactLabel,
    noticeProfile,
  },
) {
  const partDirs = fitCargoPayloadParts(
    (rawBudget) =>
      buildPartCrates(payloadRoot, sourceRoot, {
        targetId: target.target,
        version,
        partBytes: rawBudget,
        packageBase,
        artifactProduct,
        artifactLabel,
        noticeProfile,
      }),
    (partDir) => {
      // Every file here was generated for this payload part; no source selection
      // or dependency resolution is needed to measure its compressed archive.
      const packageRoot = `${path.basename(partDir)}-${version}`;
      const probeDir = path.join(cargoTargetDir, 'size-probe');
      mkdirSync(probeDir, { recursive: true });
      const crate = path.join(probeDir, `${packageRoot}.crate`);
      writeFileSync(
        crate,
        canonicalGzipSync(createDeterministicTar(partDir, packageRoot, { fail })),
      );
      return crate;
    },
    partBytes,
  );
  const aggregatorDir = path.join(sourceRoot, cargoPackageName(target.target, { packageBase }));
  writeAggregatorCrate(aggregatorDir, {
    target,
    version,
    partCount: partDirs.length,
    packageBase,
    artifactProduct,
    artifactKind,
    artifactLabel,
    payloadFiles: frozenPayloadFiles(payloadRoot),
  });

  const packages = [];
  for (let offset = 0; offset < partDirs.length; offset += 1) {
    const partNumber = offset + 1;
    const partDir = partDirs[offset];
    const name = partPackageName(target.target, partNumber, { packageBase });
    const cratePath = path.join(cargoTargetDir, 'size-probe', `${name}-${version}.crate`);
    assertReleaseNoticesInArchive(cratePath, {
      prefix: `${name}-${version}`,
      profile: noticeProfile,
    });
    validateCrateSize(cratePath);
    const output = path.join(outputDir, path.basename(cratePath));
    copyFileSync(cratePath, output);
    packages.push({
      name,
      version,
      manifestPath: path.join(partDir, 'Cargo.toml'),
      cratePath: output,
      target: target.target,
      product: artifactProduct,
      kind: artifactKind,
      role: 'part',
      noticeProfile,
      index: partNumber,
    });
  }
  packages.push(
    freezeSourceCrate(
      {
        name: cargoPackageName(target.target, { packageBase }),
        version,
        manifestPath: path.join(aggregatorDir, 'Cargo.toml'),
        target: target.target,
        product: artifactProduct,
        kind: artifactKind,
        role: 'aggregator',
        noticeProfile: 'code-facade',
        index: null,
      },
      outputDir,
      cargoTargetDir,
    ),
  );
  return packages;
}

function usage() {
  fail(
    'usage: package-cargo-artifacts.mts [--asset-dir DIR] [--output-dir DIR] [--work-dir DIR] [--version VERSION] [--target TARGET]... [--part-bytes BYTES]',
  );
}

function help() {
  console.log(`usage: package-cargo-artifacts.mts [options]

Options:
  --asset-dir DIR      directory containing this product's checked release assets
  --output-dir DIR     directory where generated .crate files are written
  --work-dir DIR       isolated generated Cargo source/target workspace
  --version VERSION    release version to package
  --target TARGET      release target id to package; may be repeated
  --part-bytes BYTES   maximum raw payload bytes per generated part crate
  -h, --help           show this help
`);
}

function optionValue(argv, index) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    usage();
  }
  return value;
}

export async function parseCargoArtifactArgs(argv, { product, assetDir, outputDir, workDir }) {
  const args = {
    assetDir,
    outputDir,
    workDir,
    version: undefined,
    targets: [],
    partBytes: DEFAULT_PART_BYTES,
  };
  for (let index = 0; index < argv.length; ) {
    const arg = argv[index];
    if (arg === '--asset-dir') {
      args.assetDir = optionValue(argv, index);
      index += 2;
    } else if (arg === '--output-dir') {
      args.outputDir = optionValue(argv, index);
      index += 2;
    } else if (arg === '--work-dir') {
      args.workDir = optionValue(argv, index);
      index += 2;
    } else if (arg === '--version') {
      args.version = optionValue(argv, index);
      index += 2;
    } else if (arg === '--target') {
      args.targets.push(optionValue(argv, index));
      index += 2;
    } else if (arg === '--part-bytes') {
      const parsed = Number.parseInt(optionValue(argv, index), 10);
      if (!Number.isInteger(parsed)) {
        usage();
      }
      args.partBytes = parsed;
      index += 2;
    } else if (arg === '-h' || arg === '--help') {
      help();
      process.exit(0);
    } else {
      usage();
    }
  }
  return {
    assetDir: repoPath(args.assetDir),
    outputDir: repoPath(args.outputDir),
    workDir: repoPath(args.workDir),
    version: args.version ?? (await currentProductVersion(product, PREFIX)),
    targets: args.targets,
    partBytes: args.partBytes,
  };
}

export function writePackagesManifest(packages, outputDir, product) {
  const unfrozen = packages.filter((item) => item.cratePath === null);
  if (unfrozen.length > 0) {
    fail(
      `all registry Cargo packages must have frozen .crate bytes: ${unfrozen.map((item) => item.name).join(', ')}`,
    );
  }
  const data = {
    schema: 'oliphaunt-liboliphaunt-cargo-artifacts-v1',
    product,
    packages: packages.map((item) => ({
      name: item.name,
      target: item.target,
      product: item.product,
      kind: item.kind,
      role: item.role,
      noticeProfile: item.noticeProfile,
      index: item.index,
      manifestPath: rel(item.manifestPath),
      cratePath: rel(item.cratePath),
    })),
  };
  writeFileSync(path.join(outputDir, 'packages.json'), `${JSON.stringify(data, null, 2)}\n`);
}

export function prepareCargoArtifactWorkspace(args) {
  if (!isDirectory(args.assetDir)) fail('missing release asset directory: ' + rel(args.assetDir));
  if (args.partBytes <= 0 || args.partBytes > DEFAULT_PART_BYTES)
    fail('--part-bytes must be between 1 and ' + DEFAULT_PART_BYTES);
  const sourceRoot = path.join(args.workDir, 'cargo-package-sources');
  const cargoTargetDir = path.join(args.workDir, 'cargo-package-target');
  for (const dir of [sourceRoot, cargoTargetDir, args.outputDir])
    rmSync(dir, { recursive: true, force: true });
  mkdirSync(sourceRoot, { recursive: true });
  mkdirSync(args.outputDir, { recursive: true });
  return { sourceRoot, cargoTargetDir };
}
export function selectCargoArtifactTargets(product, kind, selected) {
  let targets = allArtifactTargets({ product, kind, surface: 'rust-native-direct' }, PREFIX);
  if (selected.length) {
    const unknown = selected.filter((id) => !targets.some((target) => target.target === id));
    if (unknown.length) fail('unknown Cargo artifact targets: ' + unknown.join(', '));
    targets = targets.filter((target) => selected.includes(target.target));
  }
  return targets;
}
export function validateCargoArtifactPackages(
  outputDir,
  { product, expectedAggregators, expectedFacade, configuredCrates },
) {
  const manifestPath = path.join(outputDir, 'packages.json');
  if (!isFile(manifestPath)) {
    fail(`missing generated ${product} Cargo artifact manifest: ${rel(manifestPath)}`);
  }
  let data;
  try {
    data = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    fail(`${rel(manifestPath)} is not valid JSON: ${error.message}`);
  }
  if (
    data?.schema !== 'oliphaunt-liboliphaunt-cargo-artifacts-v1' ||
    !Array.isArray(data.packages)
  ) {
    fail(`${rel(manifestPath)} has an invalid liboliphaunt native Cargo artifact schema`);
  }

  const expectedRegistryCrates = new Set([
    ...expectedAggregators,
    ...(expectedFacade ? [expectedFacade] : []),
  ]);
  assertSameStringSet(
    `${product} crates.io packages must match native runtime/tool artifact packages`,
    configuredCrates,
    expectedRegistryCrates,
  );
  const aggregators = new Set();
  const facades = new Set();
  const expectedCratePaths = new Set();
  const packages = [];

  for (const item of data.packages) {
    if (item === null || Array.isArray(item) || typeof item !== 'object') {
      fail(`${rel(manifestPath)} package entries must be objects`);
    }
    const { name, role, manifestPath: rawManifest, cratePath: rawCrate } = item;
    if (
      ![name, role, rawManifest].every((value) => typeof value === 'string' && value.length > 0)
    ) {
      fail(`${rel(manifestPath)} has an invalid package row: ${JSON.stringify(item)}`);
    }
    const sourceManifest = path.join(ROOT, rawManifest);
    if (!isFile(sourceManifest)) {
      fail(`missing generated ${product} Cargo source manifest: ${rawManifest}`);
    }
    if (typeof rawCrate !== 'string' || rawCrate.length === 0) {
      fail(`generated ${product} registry crate ${name} must freeze a .crate archive`);
    }
    const cratePath = path.join(ROOT, rawCrate);
    if (!isFile(cratePath) || !cratePath.endsWith('.crate')) {
      fail(`missing generated ${product} Cargo archive for ${name}: ${rawCrate}`);
    }
    expectedCratePaths.add(path.resolve(cratePath));
    if (role === 'part') {
      const aggregator = name.replace(/-part-\d{3}$/u, '');
      if (aggregator === name || !expectedAggregators.has(aggregator)) {
        fail(`unexpected ${product} Cargo part crate ${name}`);
      }
      packages.push({ name, cratePath, manifestPath: sourceManifest, role });
      continue;
    }
    if (role === 'aggregator') {
      if (!expectedAggregators.has(name)) {
        fail(`unexpected ${product} Cargo aggregator crate ${name}`);
      }
      aggregators.add(name);
      packages.push({ name, cratePath, manifestPath: sourceManifest, role });
      continue;
    }
    if (role === 'facade') {
      if (name !== expectedFacade) {
        fail(`unexpected ${product} Cargo facade crate ${name}`);
      }
      facades.add(name);
      packages.push({ name, cratePath, manifestPath: sourceManifest, role });
      continue;
    }
    fail(`${rel(manifestPath)} has unsupported Cargo artifact role ${JSON.stringify(role)}`);
  }

  const missingAggregators = [...expectedAggregators]
    .filter((name) => !aggregators.has(name))
    .sort(compareText);
  if (missingAggregators.length > 0) {
    fail(
      `generated ${product} Cargo artifacts are missing aggregator crates: ${missingAggregators.join(', ')}`,
    );
  }
  if (expectedFacade && !facades.has(expectedFacade)) {
    fail(`generated ${product} Cargo artifacts are missing ${expectedFacade} facade crate`);
  }
  const unexpected = readdirSync(outputDir)
    .filter((name) => name.endsWith('.crate'))
    .map((name) => path.join(outputDir, name))
    .filter((file) => !expectedCratePaths.has(path.resolve(file)))
    .map((file) => path.basename(file))
    .sort(compareText);
  if (unexpected.length > 0) {
    fail(`unexpected ${product} Cargo artifact crate(s): ${unexpected.join(', ')}`);
  }
  const roleOrder = new Map([
    ['part', 0],
    ['aggregator', 1],
    ['facade', 2],
  ]);
  return packages.sort(
    (left, right) =>
      (roleOrder.get(left.role) ?? 99) - (roleOrder.get(right.role) ?? 99) ||
      compareText(left.name, right.name),
  );
}
