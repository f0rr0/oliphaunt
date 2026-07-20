#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import {
  ROOT,
  allArtifactTargets,
  compareText,
  currentProductVersion,
} from "./release-artifact-targets.mjs";
import {
  renderUnsupportedNativeTargetGuard,
  rustNativeTargetCfg,
} from "./rust-native-targets.mjs";
import { localWindowsTarInvocation } from "./tar-command.mjs";

const PREFIX = "package-liboliphaunt-cargo-artifacts.mjs";
const PRODUCT = "liboliphaunt-native";
const KIND = "native-runtime";
const TOOLS_PRODUCT = "oliphaunt-tools";
const TOOLS_KIND = "native-tools";
const TOOLS_FACADE_TEMPLATE = path.join(ROOT, "src/runtimes/liboliphaunt/native/crates/tools");
const SURFACE = "rust-native-direct";
const CRATES_IO_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_PART_BYTES = 7 * 1024 * 1024;

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

function fail(message) {
  console.error(`${PREFIX}: ${message}`);
  process.exit(1);
}

function rel(file) {
  const relative = path.relative(ROOT, String(file));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return String(file).split(path.sep).join("/");
  }
  return relative.split(path.sep).join("/");
}

function repoPath(value) {
  return path.isAbsolute(value) ? value : path.join(ROOT, value);
}

function run(args, { env = process.env, capture = false, cwd = ROOT } = {}) {
  const invocation = args[0] === "tar"
    ? localWindowsTarInvocation(args.slice(1), { cwd })
    : { args: args.slice(1), cwd };
  console.log(`\n==> ${args.join(" ")}`);
  const result = spawnSync(args[0], invocation.args, {
    cwd: invocation.cwd,
    env,
    encoding: capture ? "utf8" : "buffer",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.error !== undefined) {
    fail(`${args[0]} failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    if (capture) {
      process.stderr.write(result.stderr ?? "");
    }
    process.exit(result.status ?? 1);
  }
  return capture ? result.stdout : "";
}

function isFile(file) {
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

function cargoPackageName(targetId, { packageBase = PRODUCT } = {}) {
  return `${packageBase}-${targetId}`;
}

function cargoLinksName(targetId, { artifactProduct = PRODUCT } = {}) {
  return `oliphaunt_artifact_${artifactProduct.replaceAll("-", "_")}_${targetId.replaceAll("-", "_")}`;
}

function partPackageName(targetId, index, { packageBase = PRODUCT } = {}) {
  if (!Number.isSafeInteger(index) || index < 1 || index > 999) {
    fail(`Cargo payload part number must be an integer from 1 through 999, got ${JSON.stringify(index)}`);
  }
  return `${cargoPackageName(targetId, { packageBase })}-part-${String(index).padStart(3, "0")}`;
}

function partLinksName(targetId, index, { artifactProduct = PRODUCT } = {}) {
  if (!Number.isSafeInteger(index) || index < 1 || index > 999) {
    fail(`Cargo payload part number must be an integer from 1 through 999, got ${JSON.stringify(index)}`);
  }
  return `oliphaunt_artifact_part_${artifactProduct.replaceAll("-", "_")}_${targetId.replaceAll("-", "_")}_${String(index).padStart(3, "0")}`;
}

function rustCrateIdent(crateName) {
  return crateName.replaceAll("-", "_");
}

function tomlString(value) {
  return JSON.stringify(value);
}

function artifactAssetName(target, version) {
  return target.asset.replaceAll("{version}", version);
}

function checkedMemberPath(name, archive) {
  const normalized = name.replaceAll("\\", "/");
  if (!normalized || normalized === "." || normalized === "./" || normalized.startsWith("/") || normalized.includes("\0")) {
    fail(`${rel(archive)} contains unsafe archive member ${JSON.stringify(name)}`);
  }
  const parts = normalized.split("/").filter((part) => part && part !== ".");
  if (parts.length === 0 || parts.includes("..")) {
    fail(`${rel(archive)} contains unsafe archive member ${JSON.stringify(name)}`);
  }
  return parts.join("/");
}

function archiveNames(archive) {
  const command = archive.endsWith(".zip") ? ["unzip", "-Z1", archive] : ["tar", "-tf", archive];
  const output = run(command, { capture: true });
  return output.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
}

function extractArchive(archive, destination) {
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(destination, { recursive: true });
  for (const name of archiveNames(archive)) {
    if (name === "." || name === "./" || name.endsWith("/")) {
      continue;
    }
    checkedMemberPath(name, archive);
  }
  const command = archive.endsWith(".zip")
    ? ["unzip", "-qq", archive, "-d", destination]
    : ["tar", "-xf", archive, "-C", destination];
  run(command);
}

export function nativePayloadPlatformCommand(payloadRoot, target, { toolSet }) {
  const platformCommand = [
    process.execPath,
    "tools/release/platform-binary-contract.mjs",
    "--target",
    target,
    "--root",
    payloadRoot,
  ];
  if (target === "windows-x64-msvc" && toolSet === "runtime") {
    platformCommand.push(
      "--require-windows-runtime-import-library",
      "--windows-vc-runtime-profile",
      "provider",
    );
  }
  return platformCommand;
}

function validateNativePayload(payloadRoot, target, { toolSet }) {
  run(nativePayloadPlatformCommand(payloadRoot, target, { toolSet }));
  run([
    process.execPath,
    "tools/release/optimize_native_runtime_payload.mjs",
    payloadRoot,
    "--target",
    target,
    "--tool-set",
    toolSet,
    "--check",
  ]);
}

function writePartCrate(
  crateDir,
  {
    targetId,
    index,
    version,
    packageBase,
    artifactProduct,
    artifactLabel,
  },
) {
  rmSync(crateDir, { recursive: true, force: true });
  const name = partPackageName(targetId, index, { packageBase });
  const links = partLinksName(targetId, index, { artifactProduct });
  mkdirSync(path.join(crateDir, "src"), { recursive: true });
  writeFileSync(
    path.join(crateDir, "Cargo.toml"),
    `[package]
name = "${name}"
version = "${version}"
edition = "2024"
rust-version = "1.93"
description = "Cargo payload part ${String(index).padStart(3, "0")} for the ${targetId} ${artifactLabel}."
readme = "README.md"
repository = "https://github.com/f0rr0/oliphaunt"
homepage = "https://oliphaunt.dev"
license = "MIT AND Apache-2.0 AND PostgreSQL"
links = "${links}"
build = "build.rs"
include = ["Cargo.toml", "README.md", "build.rs", "src/**", "payload/**"]

[lib]
path = "src/lib.rs"

[workspace]
`,
  );
  writeFileSync(
    path.join(crateDir, "README.md"),
    `# ${name}

Cargo payload part for the \`${targetId}\` ${artifactLabel}.
Applications do not depend on this crate directly.
`,
  );
  writeFileSync(
    path.join(crateDir, "src/lib.rs"),
    `pub const RELEASE_TARGET: &str = "${targetId}";
pub const PART_INDEX: usize = ${index};
pub const PAYLOAD_ROOT: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/payload");
`,
  );
  writeFileSync(
    path.join(crateDir, "build.rs"),
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
  if (typeof target.triple !== "string" || !target.triple) {
    fail(`${target.id} must declare Cargo target triple`);
  }
  const name = cargoPackageName(target.target, { packageBase });
  const links = cargoLinksName(target.target, { artifactProduct });
  mkdirSync(path.join(crateDir, "src"), { recursive: true });
  const dependencyLines = [];
  const partRoots = [];
  for (let offset = 0; offset < partCount; offset += 1) {
    const partName = partPackageName(target.target, offset + 1, { packageBase });
    dependencyLines.push(`${partName} = { version = "=${version}", path = "../${partName}" }`);
    partRoots.push(`    ${rustCrateIdent(partName)}::PAYLOAD_ROOT,`);
  }
  const libraryRelativePath = target.libraryRelativePath ?? "";
  writeFileSync(
    path.join(crateDir, "Cargo.toml"),
    `[package]
name = "${name}"
version = "${version}"
edition = "2024"
rust-version = "1.93"
description = "Cargo artifact crate for the ${target.target} ${artifactLabel}."
readme = "README.md"
repository = "https://github.com/f0rr0/oliphaunt"
homepage = "https://oliphaunt.dev"
license = "MIT AND Apache-2.0 AND PostgreSQL"
links = "${links}"
build = "build.rs"
include = ["Cargo.toml", "README.md", "build.rs", "src/**"]

[lib]
path = "src/lib.rs"

[build-dependencies]
${dependencyLines.join("\n")}

[workspace]
`,
  );
  writeFileSync(
    path.join(crateDir, "README.md"),
    `# ${name}

Cargo artifact crate for the \`${target.target}\` ${artifactLabel}.
Applications do not depend on this crate directly; \`oliphaunt\` selects it for
matching Cargo targets.
`,
  );
  writeFileSync(
    path.join(crateDir, "src/lib.rs"),
    `pub const PRODUCT: &str = "${artifactProduct}";
pub const KIND: &str = "${artifactKind}";
pub const RELEASE_TARGET: &str = "${target.target}";
pub const CARGO_TARGET: &str = "${target.triple}";
pub const LIBRARY_RELATIVE_PATH: &str = "${libraryRelativePath}";
`,
  );
  writeFileSync(
    path.join(crateDir, "build.rs"),
    AGGREGATOR_BUILD_RS
      .replace("__SCHEMA__", tomlString("oliphaunt-artifact-manifest-v1"))
      .replace("__PRODUCT__", tomlString(artifactProduct))
      .replace("__VERSION__", tomlString(version))
      .replace("__KIND__", tomlString(artifactKind))
      .replace("__TARGET__", tomlString(target.triple))
      .replace("__PART_ROOTS__", partRoots.join("\n"))
      .replace("__FILE_SHA256__", payloadFiles.map(({ relative, sha256 }) => `    (${tomlString(relative)}, ${tomlString(sha256)}),`).join("\n")),
  );
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
    relative: path.relative(root, file).split(path.sep).join("/"),
    sha256: createHash("sha256").update(readFileSync(file)).digest("hex"),
  }));
}

function nextPartDir(
  sourceRoot,
  targetId,
  index,
  version,
  {
    packageBase,
    artifactProduct,
    artifactLabel,
  },
) {
  const crateDir = path.join(sourceRoot, partPackageName(targetId, index, { packageBase }));
  writePartCrate(crateDir, {
    targetId,
    index,
    version,
    packageBase,
    artifactProduct,
    artifactLabel,
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
  {
    targetId,
    version,
    partBytes,
    packageBase,
    artifactProduct,
    artifactLabel,
  },
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
    });
    partDirs.push(partDir);
    return partDir;
  };

  for (const source of walkFiles(extractedRoot)) {
    const relative = path.relative(extractedRoot, source).split(path.sep).join("/");
    const size = statSync(source).size;
    if (size > partBytes) {
      currentDir = undefined;
      currentSize = 0;
      const fd = openSync(source, "r");
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
            path.join(partDir, "payload/chunks", `${relative}.part${String(partIndex).padStart(3, "0")}`),
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
    copyPayloadFile(source, path.join(currentDir, "payload/files", relative));
    currentSize += size;
  }
  if (partDirs.length === 0) {
    fail(`${targetId} generated no ${artifactLabel} part crates`);
  }
  return partDirs;
}

function cargoPackage(crateDir, targetDir, { noVerify = false, index = null } = {}) {
  const manifest = path.join(crateDir, "Cargo.toml");
  const metadata = Bun.TOML.parse(readFileSync(manifest, "utf8"));
  const name = metadata?.package?.name;
  const version = metadata?.package?.version;
  if (typeof name !== "string" || typeof version !== "string") {
    fail(`${rel(manifest)} must declare package.name and package.version`);
  }
  const command = [
    "cargo",
    "package",
    "--manifest-path",
    manifest,
    "--target-dir",
    targetDir,
    "--allow-dirty",
  ];
  if (noVerify) {
    command.push("--no-verify");
  }
  if (index !== null) {
    command.push(
      "--config",
      'source.crates-io.replace-with="oliphaunt-package-deps"',
      "--config",
      `source.oliphaunt-package-deps.registry=${JSON.stringify(index)}`,
    );
  }
  run(command, { env: { ...process.env, OLIPHAUNT_ARTIFACT_CRATE_REQUIRE_PAYLOAD: "1" } });
  const cratePath = path.join(targetDir, "package", `${name}-${version}.crate`);
  if (!isFile(cratePath)) {
    fail(`cargo package did not create ${rel(cratePath)}`);
  }
  return cratePath;
}

function validateCrateSize(cratePath) {
  const size = statSync(cratePath).size;
  if (size > CRATES_IO_MAX_BYTES) {
    fail(`${rel(cratePath)} is ${size} bytes, above the crates.io 10 MiB package limit`);
  }
}

function crateIndexPath(name) {
  const lower = name.toLowerCase();
  if (lower.length === 1) return path.join("1", lower);
  if (lower.length === 2) return path.join("2", lower);
  if (lower.length === 3) return path.join("3", lower[0], lower);
  return path.join(lower.slice(0, 2), lower.slice(2, 4), lower);
}

function temporaryCargoIndex(packages, directory) {
  rmSync(directory, { recursive: true, force: true });
  const cratesDir = path.join(directory, "crates");
  const indexDir = path.join(directory, "index");
  mkdirSync(cratesDir, { recursive: true });
  mkdirSync(indexDir, { recursive: true });
  writeFileSync(path.join(indexDir, "config.json"), `${JSON.stringify({ dl: `file://${cratesDir}/{crate}-{version}.crate` })}\n`);
  for (const packageData of packages) {
    const crateName = `${packageData.name}-${packageData.version}.crate`;
    copyFileSync(packageData.cratePath, path.join(cratesDir, crateName));
    const entry = {
      name: packageData.name,
      vers: packageData.version,
      deps: (packageData.localDependencies ?? []).map((dependency) => ({
        name: dependency.name,
        req: dependency.req,
        features: [],
        optional: false,
        default_features: true,
        target: dependency.target ?? null,
        kind: dependency.kind ?? "normal",
        registry: null,
        package: null,
      })),
      features: {},
      features2: null,
      cksum: createHash("sha256").update(readFileSync(packageData.cratePath)).digest("hex"),
      yanked: false,
      links: packageData.links ?? null,
      rust_version: "1.93",
      v: 2,
    };
    const indexFile = path.join(indexDir, crateIndexPath(packageData.name));
    mkdirSync(path.dirname(indexFile), { recursive: true });
    writeFileSync(indexFile, `${JSON.stringify(entry)}\n`);
  }
  run(["git", "init", "--quiet"], { env: process.env, cwd: indexDir });
  run(["git", "config", "user.name", "Oliphaunt Package Fixture"], { env: process.env, cwd: indexDir });
  run(["git", "config", "user.email", "packages@oliphaunt.invalid"], { env: process.env, cwd: indexDir });
  run(["git", "add", "."], { env: process.env, cwd: indexDir });
  run(["git", "commit", "--quiet", "-m", "package dependency index"], { env: process.env, cwd: indexDir });
  return `file://${indexDir}`;
}

function freezeSourceCrate(packageData, outputDir, cargoTargetDir, dependencyPackages) {
  const index = temporaryCargoIndex(
    dependencyPackages,
    path.join(cargoTargetDir, "dependency-index", packageData.name),
  );
  const generated = cargoPackage(path.dirname(packageData.manifestPath), cargoTargetDir, { noVerify: true, index });
  validateCrateSize(generated);
  const cratePath = path.join(outputDir, path.basename(generated));
  copyFileSync(generated, cratePath);
  return { ...packageData, cratePath };
}

function validateToolsTargetPair(runtimeTarget, toolsTarget) {
  if (toolsTarget.target !== runtimeTarget.target) {
    fail(`${toolsTarget.id} must use target ${runtimeTarget.target}`);
  }
  if (toolsTarget.triple !== runtimeTarget.triple) {
    fail(`${toolsTarget.id} must use Cargo target triple ${runtimeTarget.triple}`);
  }
}

export function renderUnsupportedToolsTargetGuard(nativeTargets, nativeCfgs) {
  return renderUnsupportedNativeTargetGuard({
    product: TOOLS_PRODUCT,
    nativeTargets,
    nativeCfgs,
    guidance: "use one of these declared native targets; this package has no portable fallback.",
  });
}

function writeToolsFacadeCrate(sourceRoot, { version, toolsTargets }) {
  const crateDir = path.join(sourceRoot, TOOLS_PRODUCT);
  if (existsSync(crateDir)) {
    fail(`duplicate generated ${TOOLS_PRODUCT} source crate: ${rel(crateDir)}`);
  }
  cpSync(TOOLS_FACADE_TEMPLATE, crateDir, {
    recursive: true,
    filter: (source) => path.basename(source) !== "target",
  });
  const cargoToml = path.join(crateDir, "Cargo.toml");
  let text = readFileSync(cargoToml, "utf8");
  text = text
    .replace("repository.workspace = true", 'repository = "https://github.com/f0rr0/oliphaunt"')
    .replace("homepage.workspace = true", 'homepage = "https://oliphaunt.dev"');
  const versionMatches = text.match(/^version = "[^"]+"$/gm) ?? [];
  if (versionMatches.length !== 1) {
    fail(`${rel(cargoToml)} must declare exactly one package version`);
  }
  text = text.replace(/^version = "[^"]+"$/m, `version = "${version}"`);
  const dependencyBlocks = [];
  const sortedToolsTargets = [...toolsTargets].sort((left, right) => compareText(left.target, right.target));
  const nativeTargets = sortedToolsTargets.map((target) => target.target);
  const nativeCfgs = sortedToolsTargets.map((target) => rustNativeTargetCfg(target));
  for (let index = 0; index < sortedToolsTargets.length; index += 1) {
    const target = sortedToolsTargets[index];
    const packageName = cargoPackageName(target.target, { packageBase: TOOLS_PRODUCT });
    dependencyBlocks.push(
      [
        "",
        `[target.'cfg(${nativeCfgs[index]})'.dependencies]`,
        `${packageName} = { version = "=${version}", path = "../${packageName}" }`,
      ].join("\n"),
    );
  }
  if (!text.includes("\n[workspace]")) {
    text = `${text.trimEnd()}\n\n[workspace]\n`;
  }
  writeFileSync(cargoToml, `${text.trimEnd()}\n${dependencyBlocks.join("\n")}\n`);
  const libRs = path.join(crateDir, "src/lib.rs");
  const releaseOnlyGuard = renderUnsupportedToolsTargetGuard(nativeTargets, nativeCfgs);
  writeFileSync(
    libRs,
    `${readFileSync(libRs, "utf8").trimEnd()}\n\n// Generated release-only native target guard.\n${releaseOnlyGuard}\n`,
  );
  return {
    name: TOOLS_PRODUCT,
    version,
    manifestPath: cargoToml,
    cratePath: null,
    target: "portable",
    product: TOOLS_PRODUCT,
    kind: TOOLS_KIND,
    role: "facade",
    index: null,
    links: "oliphaunt_artifact_oliphaunt_tools_relay",
    localDependencies: [...toolsTargets].map((target) => ({
      name: cargoPackageName(target.target, { packageBase: TOOLS_PRODUCT }),
      req: `=${version}`,
      target: `cfg(${rustNativeTargetCfg(target)})`,
    })),
  };
}

function packagePayload(
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
  },
) {
  const partDirs = buildPartCrates(payloadRoot, sourceRoot, {
    targetId: target.target,
    version,
    partBytes,
    packageBase,
    artifactProduct,
    artifactLabel,
  });
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
    const cratePath = cargoPackage(partDir, cargoTargetDir);
    validateCrateSize(cratePath);
    const output = path.join(outputDir, path.basename(cratePath));
    copyFileSync(cratePath, output);
    packages.push({
      name: partPackageName(target.target, partNumber, { packageBase }),
      version,
      manifestPath: path.join(partDir, "Cargo.toml"),
      cratePath: output,
      target: target.target,
      product: artifactProduct,
      kind: artifactKind,
      role: "part",
      index: partNumber,
      links: partLinksName(target.target, partNumber, { artifactProduct }),
      localDependencies: [],
    });
  }
  packages.push(freezeSourceCrate({
    name: cargoPackageName(target.target, { packageBase }),
    version,
    manifestPath: path.join(aggregatorDir, "Cargo.toml"),
    target: target.target,
    product: artifactProduct,
    kind: artifactKind,
    role: "aggregator",
    index: null,
    links: cargoLinksName(target.target, { artifactProduct }),
    localDependencies: Array.from({ length: partDirs.length }, (_, offset) => ({
      name: partPackageName(target.target, offset + 1, { packageBase }),
      req: `=${version}`,
      kind: "build",
    })),
  }, outputDir, cargoTargetDir, packages));
  return packages;
}

function packageTarget(
  target,
  {
    toolsTarget,
    version,
    assetDir,
    sourceRoot,
    outputDir,
    cargoTargetDir,
    partBytes,
  },
) {
  validateToolsTargetPair(target, toolsTarget);
  const archive = path.join(assetDir, artifactAssetName(target, version));
  if (!isFile(archive)) {
    fail(`missing liboliphaunt native release asset: ${rel(archive)}`);
  }
  const toolsArchive = path.join(assetDir, artifactAssetName(toolsTarget, version));
  if (!isFile(toolsArchive)) {
    fail(`missing oliphaunt-tools native release asset: ${rel(toolsArchive)}`);
  }
  const extractedRoot = path.join(sourceRoot, `${target.target}-extracted`);
  extractArchive(archive, extractedRoot);
  const toolsRoot = path.join(sourceRoot, `${target.target}-tools-extracted`);
  extractArchive(toolsArchive, toolsRoot);
  validateNativePayload(extractedRoot, target.target, { toolSet: "runtime" });
  validateNativePayload(toolsRoot, target.target, { toolSet: "tools" });
  return [
    ...packagePayload(extractedRoot, sourceRoot, outputDir, cargoTargetDir, {
      target,
      version,
      partBytes,
      packageBase: PRODUCT,
      artifactProduct: PRODUCT,
      artifactKind: KIND,
      artifactLabel: "liboliphaunt native runtime",
    }),
    ...packagePayload(toolsRoot, sourceRoot, outputDir, cargoTargetDir, {
      target: toolsTarget,
      version,
      partBytes,
      packageBase: TOOLS_PRODUCT,
      artifactProduct: TOOLS_PRODUCT,
      artifactKind: TOOLS_KIND,
      artifactLabel: "Oliphaunt native tools",
    }),
  ];
}

function writePackagesManifest(packages, outputDir) {
  const unfrozen = packages.filter((item) => item.cratePath === null);
  if (unfrozen.length > 0) {
    fail(`all registry Cargo packages must have frozen .crate bytes: ${unfrozen.map((item) => item.name).join(", ")}`);
  }
  const data = {
    schema: "oliphaunt-liboliphaunt-cargo-artifacts-v1",
    product: PRODUCT,
    packages: packages.map((item) => ({
      name: item.name,
      target: item.target,
      product: item.product,
      kind: item.kind,
      role: item.role,
      index: item.index,
      manifestPath: rel(item.manifestPath),
      cratePath: rel(item.cratePath),
    })),
  };
  writeFileSync(path.join(outputDir, "packages.json"), `${JSON.stringify(data, null, 2)}\n`);
}

function usage() {
  fail(
    "usage: tools/release/package-liboliphaunt-cargo-artifacts.mjs [--asset-dir DIR] [--output-dir DIR] [--work-dir DIR] [--version VERSION] [--target TARGET]... [--part-bytes BYTES]",
  );
}

function help() {
  console.log(`usage: tools/release/package-liboliphaunt-cargo-artifacts.mjs [options]

Options:
  --asset-dir DIR      directory containing checked liboliphaunt native release assets
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
  if (value === undefined || value.startsWith("--")) {
    usage();
  }
  return value;
}

async function parseArgs(argv) {
  const args = {
    assetDir: "target/liboliphaunt/release-assets",
    outputDir: "target/liboliphaunt/cargo-artifacts",
    workDir: "target/liboliphaunt",
    version: undefined,
    targets: [],
    partBytes: DEFAULT_PART_BYTES,
  };
  for (let index = 0; index < argv.length;) {
    const arg = argv[index];
    if (arg === "--asset-dir") {
      args.assetDir = optionValue(argv, index);
      index += 2;
    } else if (arg === "--output-dir") {
      args.outputDir = optionValue(argv, index);
      index += 2;
    } else if (arg === "--work-dir") {
      args.workDir = optionValue(argv, index);
      index += 2;
    } else if (arg === "--version") {
      args.version = optionValue(argv, index);
      index += 2;
    } else if (arg === "--target") {
      args.targets.push(optionValue(argv, index));
      index += 2;
    } else if (arg === "--part-bytes") {
      const parsed = Number.parseInt(optionValue(argv, index), 10);
      if (!Number.isInteger(parsed)) {
        usage();
      }
      args.partBytes = parsed;
      index += 2;
    } else if (arg === "-h" || arg === "--help") {
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
    version: args.version ?? await currentProductVersion(PRODUCT, PREFIX),
    targets: args.targets,
    partBytes: args.partBytes,
  };
}

async function main(argv) {
  const args = await parseArgs(argv);
  if (!isDirectory(args.assetDir)) {
    fail(`liboliphaunt release asset directory does not exist: ${rel(args.assetDir)}`);
  }
  if (args.partBytes <= 0 || args.partBytes > DEFAULT_PART_BYTES) {
    fail(`--part-bytes must be between 1 and ${DEFAULT_PART_BYTES}`);
  }
  const selected = new Set(args.targets);
  const sourceRoot = path.join(args.workDir, "cargo-package-sources");
  const cargoTargetDir = path.join(args.workDir, "cargo-package-target");
  rmSync(sourceRoot, { recursive: true, force: true });
  rmSync(args.outputDir, { recursive: true, force: true });
  rmSync(cargoTargetDir, { recursive: true, force: true });
  mkdirSync(sourceRoot, { recursive: true });
  mkdirSync(args.outputDir, { recursive: true });

  let targets = allArtifactTargets(
    { product: PRODUCT, kind: KIND, surface: SURFACE, publishedOnly: true },
    PREFIX,
  );
  const toolsTargets = new Map(
    allArtifactTargets(
      { product: PRODUCT, kind: TOOLS_KIND, surface: SURFACE, publishedOnly: true },
      PREFIX,
    ).map((target) => [target.target, target]),
  );
  if (selected.size > 0) {
    const known = new Set(targets.map((target) => target.target));
    const unknown = [...selected].filter((target) => !known.has(target)).sort(compareText);
    if (unknown.length > 0) {
      fail(`unknown liboliphaunt native Rust target(s): ${unknown.join(", ")}`);
    }
    targets = targets.filter((target) => selected.has(target.target));
  }

  const packages = [];
  const selectedToolsTargets = [];
  for (const target of targets) {
    const toolsTarget = toolsTargets.get(target.target);
    if (toolsTarget === undefined) {
      fail(`missing oliphaunt-tools Cargo artifact target for ${target.target}`);
    }
    selectedToolsTargets.push(toolsTarget);
    packages.push(...packageTarget(target, {
      toolsTarget,
      version: args.version,
      assetDir: args.assetDir,
      sourceRoot,
      outputDir: args.outputDir,
      cargoTargetDir,
      partBytes: args.partBytes,
    }));
  }
  packages.push(freezeSourceCrate(writeToolsFacadeCrate(sourceRoot, {
    version: args.version,
    toolsTargets: selectedToolsTargets,
  }), args.outputDir, cargoTargetDir, packages));
  writePackagesManifest(packages, args.outputDir);
  console.log("generated liboliphaunt native Cargo artifact crates:");
  for (const item of packages) {
    console.log(`${item.name} ${item.role} ${rel(item.cratePath)}`);
  }
}

if (import.meta.main) {
  await main(Bun.argv.slice(2));
}
