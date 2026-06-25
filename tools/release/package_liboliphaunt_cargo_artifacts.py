#!/usr/bin/env python3
"""Package liboliphaunt native runtime archives as Cargo artifact crates."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tarfile
import zipfile
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import NoReturn

import artifact_targets
import optimize_native_runtime_payload
import product_metadata


ROOT = Path(__file__).resolve().parents[2]
PRODUCT = "liboliphaunt-native"
KIND = "native-runtime"
TOOLS_PRODUCT = "oliphaunt-tools"
TOOLS_KIND = "native-tools"
SURFACE = "rust-native-direct"
CRATES_IO_MAX_BYTES = 10 * 1024 * 1024
DEFAULT_PART_BYTES = 7 * 1024 * 1024


@dataclass(frozen=True)
class GeneratedPackage:
    name: str
    manifest_path: Path
    crate_path: Path | None
    target: str
    product: str
    kind: str
    role: str
    index: int | None = None


def fail(message: str) -> NoReturn:
    print(f"package_liboliphaunt_cargo_artifacts.py: {message}", file=sys.stderr)
    raise SystemExit(1)


def rel(path: Path) -> str:
    try:
        return path.relative_to(ROOT).as_posix()
    except ValueError:
        return str(path)


def run(args: list[str], *, cwd: Path = ROOT, env: dict[str, str] | None = None) -> None:
    print("\n==> " + " ".join(args), flush=True)
    result = subprocess.run(args, cwd=cwd, env=env, check=False)
    if result.returncode != 0:
        raise SystemExit(result.returncode)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def cargo_package_name(target_id: str, *, package_base: str = PRODUCT) -> str:
    return f"{package_base}-{target_id}"


def cargo_links_name(target_id: str, *, artifact_product: str = PRODUCT) -> str:
    product = artifact_product.replace("-", "_")
    return f"oliphaunt_artifact_{product}_{target_id.replace('-', '_')}"


def part_package_name(target_id: str, index: int, *, package_base: str = PRODUCT) -> str:
    return f"{cargo_package_name(target_id, package_base=package_base)}-part-{index:03d}"


def part_links_name(target_id: str, index: int, *, artifact_product: str = PRODUCT) -> str:
    product = artifact_product.replace("-", "_")
    return f"oliphaunt_artifact_part_{product}_{target_id.replace('-', '_')}_{index:03d}"


def rust_crate_ident(crate_name: str) -> str:
    return crate_name.replace("-", "_")


def checked_member_path(name: str, archive: Path) -> PurePosixPath:
    path = PurePosixPath(name)
    parts = tuple(part for part in path.parts if part not in {"", "."})
    if not parts or any(part == ".." for part in parts) or path.is_absolute():
        fail(f"{rel(archive)} contains unsafe archive member {name!r}")
    return PurePosixPath(*parts)


def extract_archive(archive_path: Path, destination: Path) -> None:
    shutil.rmtree(destination, ignore_errors=True)
    destination.mkdir(parents=True, exist_ok=True)
    if archive_path.name.endswith(".zip"):
        try:
            with zipfile.ZipFile(archive_path) as archive:
                for info in archive.infolist():
                    if info.is_dir() or info.filename.rstrip("/") in {"", ".", "./"}:
                        continue
                    member = checked_member_path(info.filename, archive_path)
                    output = destination.joinpath(*member.parts)
                    output.parent.mkdir(parents=True, exist_ok=True)
                    output.write_bytes(archive.read(info.filename))
                    mode = (info.external_attr >> 16) & 0o777
                    if mode:
                        output.chmod(mode)
        except zipfile.BadZipFile as error:
            fail(f"{rel(archive_path)} is not a readable zip archive: {error}")
        return

    try:
        with tarfile.open(archive_path, "r:*") as archive:
            for info in archive.getmembers():
                if info.isdir() or info.name.rstrip("/") in {"", ".", "./"}:
                    continue
                if not info.isfile():
                    fail(f"{rel(archive_path)} member {info.name} must be a regular file")
                member = checked_member_path(info.name, archive_path)
                extracted = archive.extractfile(info)
                if extracted is None:
                    fail(f"{rel(archive_path)} member {info.name} could not be read")
                output = destination.joinpath(*member.parts)
                output.parent.mkdir(parents=True, exist_ok=True)
                with extracted:
                    output.write_bytes(extracted.read())
                output.chmod(info.mode & 0o777)
    except tarfile.TarError as error:
        fail(f"{rel(archive_path)} is not a readable tar archive: {error}")


def write_part_crate(
    crate_dir: Path,
    *,
    target_id: str,
    index: int,
    version: str,
    package_base: str,
    artifact_product: str,
    artifact_label: str,
) -> None:
    name = part_package_name(target_id, index, package_base=package_base)
    links = part_links_name(target_id, index, artifact_product=artifact_product)
    (crate_dir / "src").mkdir(parents=True, exist_ok=True)
    (crate_dir / "Cargo.toml").write_text(
        f"""[package]
name = "{name}"
version = "{version}"
edition = "2024"
rust-version = "1.93"
description = "Cargo payload part {index:03d} for the {target_id} {artifact_label}."
readme = "README.md"
repository = "https://github.com/f0rr0/oliphaunt"
homepage = "https://oliphaunt.dev"
license = "MIT AND Apache-2.0 AND PostgreSQL"
links = "{links}"
build = "build.rs"
include = ["Cargo.toml", "README.md", "build.rs", "src/**", "payload/**"]

[lib]
path = "src/lib.rs"

[workspace]
""",
        encoding="utf-8",
    )
    (crate_dir / "README.md").write_text(
        f"""# {name}

Cargo payload part for the `{target_id}` {artifact_label}.
Applications do not depend on this crate directly.
""",
        encoding="utf-8",
    )
    (crate_dir / "src" / "lib.rs").write_text(
        f"""pub const RELEASE_TARGET: &str = "{target_id}";
pub const PART_INDEX: usize = {index};
pub const PAYLOAD_ROOT: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/payload");
""",
        encoding="utf-8",
    )
    (crate_dir / "build.rs").write_text(
        """use std::env;
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
""",
        encoding="utf-8",
    )


def toml_string(value: str) -> str:
    return json.dumps(value)


def write_aggregator_crate(
    crate_dir: Path,
    *,
    target: artifact_targets.ArtifactTarget,
    version: str,
    part_count: int,
    package_base: str,
    artifact_product: str,
    artifact_kind: str,
    artifact_label: str,
) -> None:
    if target.triple is None:
        fail(f"{target.id} must declare Cargo target triple")
    name = cargo_package_name(target.target, package_base=package_base)
    links = cargo_links_name(target.target, artifact_product=artifact_product)
    (crate_dir / "src").mkdir(parents=True, exist_ok=True)
    dependency_lines = [
        f'{part_package_name(target.target, index, package_base=package_base)} = {{ version = "={version}" }}'
        for index in range(part_count)
    ]
    part_roots = [
        f"    {rust_crate_ident(part_package_name(target.target, index, package_base=package_base))}::PAYLOAD_ROOT,"
        for index in range(part_count)
    ]
    library_relative_path = target.library_relative_path or ""
    (crate_dir / "Cargo.toml").write_text(
        f"""[package]
name = "{name}"
version = "{version}"
edition = "2024"
rust-version = "1.93"
description = "Cargo artifact crate for the {target.target} {artifact_label}."
readme = "README.md"
repository = "https://github.com/f0rr0/oliphaunt"
homepage = "https://oliphaunt.dev"
license = "MIT AND Apache-2.0 AND PostgreSQL"
links = "{links}"
build = "build.rs"
include = ["Cargo.toml", "README.md", "build.rs", "src/**"]

[lib]
path = "src/lib.rs"

[build-dependencies]
sha2 = "0.10"
{chr(10).join(dependency_lines)}

[workspace]
""",
        encoding="utf-8",
    )
    (crate_dir / "README.md").write_text(
        f"""# {name}

Cargo artifact crate for the `{target.target}` {artifact_label}.
Applications do not depend on this crate directly; `oliphaunt` selects it for
matching Cargo targets.
""",
        encoding="utf-8",
    )
    (crate_dir / "src" / "lib.rs").write_text(
        f"""pub const PRODUCT: &str = "{artifact_product}";
pub const KIND: &str = "{artifact_kind}";
pub const RELEASE_TARGET: &str = "{target.target}";
pub const CARGO_TARGET: &str = "{target.triple}";
pub const LIBRARY_RELATIVE_PATH: &str = "{library_relative_path}";
""",
        encoding="utf-8",
    )
    build_rs = (
        AGGREGATOR_BUILD_RS
        .replace("__SCHEMA__", toml_string("oliphaunt-artifact-manifest-v1"))
        .replace("__PRODUCT__", toml_string(artifact_product))
        .replace("__VERSION__", toml_string(version))
        .replace("__KIND__", toml_string(artifact_kind))
        .replace("__TARGET__", toml_string(target.triple))
        .replace("__PART_ROOTS__", "\n".join(part_roots))
    )
    (crate_dir / "build.rs").write_text(build_rs, encoding="utf-8")


AGGREGATOR_BUILD_RS = r'''use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::env;
use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};

const SCHEMA: &str = __SCHEMA__;
const PRODUCT: &str = __PRODUCT__;
const VERSION: &str = __VERSION__;
const KIND: &str = __KIND__;
const TARGET: &str = __TARGET__;
const PART_ROOTS: &[&str] = &[
__PART_ROOTS__
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
    for file in files {
        let relative = file.strip_prefix(&payload)
            .expect("payload file stays under payload root")
            .to_string_lossy()
            .replace('\\', "/");
        let sha256 = sha256_file(&file).expect("hash liboliphaunt payload file");
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

fn sha256_file(path: &Path) -> io::Result<String> {
    let mut file = fs::File::open(path)?;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 1024 * 64];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    let digest = digest.finalize();
    let mut output = String::with_capacity(digest.len() * 2);
    for byte in digest {
        use std::fmt::Write as _;
        let _ = write!(&mut output, "{byte:02x}");
    }
    Ok(output)
}

fn is_executable_relative(relative: &str) -> bool {
    relative.starts_with("runtime/bin/") || relative.starts_with("bin/")
}
'''


def payload_files(source_root: Path) -> list[Path]:
    return sorted(path for path in source_root.rglob("*") if path.is_file())


def next_part_dir(
    source_root: Path,
    target_id: str,
    index: int,
    version: str,
    *,
    package_base: str,
    artifact_product: str,
    artifact_label: str,
) -> Path:
    crate_dir = source_root / part_package_name(target_id, index, package_base=package_base)
    write_part_crate(
        crate_dir,
        target_id=target_id,
        index=index,
        version=version,
        package_base=package_base,
        artifact_product=artifact_product,
        artifact_label=artifact_label,
    )
    return crate_dir


def write_chunk(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)


def copy_payload_file(source: Path, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, destination)


def build_part_crates(
    extracted_root: Path,
    source_root: Path,
    *,
    target_id: str,
    version: str,
    part_bytes: int,
    package_base: str,
    artifact_product: str,
    artifact_label: str,
) -> list[Path]:
    part_dirs: list[Path] = []
    current_dir: Path | None = None
    current_size = 0

    def start_part() -> Path:
        index = len(part_dirs)
        part_dir = next_part_dir(
            source_root,
            target_id,
            index,
            version,
            package_base=package_base,
            artifact_product=artifact_product,
            artifact_label=artifact_label,
        )
        part_dirs.append(part_dir)
        return part_dir

    for source in payload_files(extracted_root):
        relative = source.relative_to(extracted_root).as_posix()
        size = source.stat().st_size
        if size > part_bytes:
            current_dir = None
            current_size = 0
            with source.open("rb") as handle:
                part_index = 0
                while True:
                    data = handle.read(part_bytes)
                    if not data:
                        break
                    part_dir = start_part()
                    write_chunk(
                        part_dir / "payload" / "chunks" / f"{relative}.part{part_index:03d}",
                        data,
                    )
                    part_index += 1
            continue
        if current_dir is None or current_size + size > part_bytes:
            current_dir = start_part()
            current_size = 0
        copy_payload_file(source, current_dir / "payload" / "files" / relative)
        current_size += size
    if not part_dirs:
        fail(f"{target_id} generated no {artifact_label} part crates")
    return part_dirs


def cargo_package(crate_dir: Path, target_dir: Path, *, no_verify: bool = False) -> Path:
    manifest = crate_dir / "Cargo.toml"
    package = json.loads(
        subprocess.check_output(
            ["cargo", "metadata", "--no-deps", "--format-version", "1", "--manifest-path", str(manifest)],
            cwd=ROOT,
            text=True,
        )
    )["packages"][0]
    name = package["name"]
    version = package["version"]
    command = [
        "cargo",
        "package",
        "--manifest-path",
        str(manifest),
        "--target-dir",
        str(target_dir),
        "--allow-dirty",
    ]
    if no_verify:
        command.append("--no-verify")
    env = {**os.environ, "OLIPHAUNT_ARTIFACT_CRATE_REQUIRE_PAYLOAD": "1"}
    run(command, env=env)
    crate_path = target_dir / "package" / f"{name}-{version}.crate"
    if not crate_path.is_file():
        fail(f"cargo package did not create {rel(crate_path)}")
    return crate_path


def validate_crate_size(crate_path: Path) -> None:
    size = crate_path.stat().st_size
    if size > CRATES_IO_MAX_BYTES:
        fail(f"{rel(crate_path)} is {size} bytes, above the crates.io 10 MiB package limit")


def copy_tools_payload(extracted_root: Path, tools_root: Path, target_id: str) -> None:
    shutil.rmtree(tools_root, ignore_errors=True)
    required = optimize_native_runtime_payload.required_tools_member_paths(
        target_id,
        prefix="runtime/bin",
    )
    missing: list[str] = []
    for member in required:
        source = extracted_root / member
        if not source.is_file():
            missing.append(member)
            continue
        destination = tools_root / member
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, destination)
        source.unlink()
    if missing:
        fail(f"{target_id} optimized payload is missing native tools: {', '.join(missing)}")
    optimize_native_runtime_payload.prune_empty_dirs(extracted_root)


def package_payload(
    payload_root: Path,
    source_root: Path,
    output_dir: Path,
    cargo_target_dir: Path,
    *,
    target: artifact_targets.ArtifactTarget,
    version: str,
    part_bytes: int,
    package_base: str,
    artifact_product: str,
    artifact_kind: str,
    artifact_label: str,
) -> list[GeneratedPackage]:
    part_dirs = build_part_crates(
        payload_root,
        source_root,
        target_id=target.target,
        version=version,
        part_bytes=part_bytes,
        package_base=package_base,
        artifact_product=artifact_product,
        artifact_label=artifact_label,
    )
    aggregator_dir = source_root / cargo_package_name(target.target, package_base=package_base)
    write_aggregator_crate(
        aggregator_dir,
        target=target,
        version=version,
        part_count=len(part_dirs),
        package_base=package_base,
        artifact_product=artifact_product,
        artifact_kind=artifact_kind,
        artifact_label=artifact_label,
    )

    packages: list[GeneratedPackage] = []
    for index, part_dir in enumerate(part_dirs):
        crate_path = cargo_package(part_dir, cargo_target_dir)
        validate_crate_size(crate_path)
        output = output_dir / crate_path.name
        shutil.copy2(crate_path, output)
        packages.append(
            GeneratedPackage(
                name=part_package_name(target.target, index, package_base=package_base),
                manifest_path=part_dir / "Cargo.toml",
                crate_path=output,
                target=target.target,
                product=artifact_product,
                kind=artifact_kind,
                role="part",
                index=index,
            )
        )

    packages.append(
        GeneratedPackage(
            name=cargo_package_name(target.target, package_base=package_base),
            manifest_path=aggregator_dir / "Cargo.toml",
            crate_path=None,
            target=target.target,
            product=artifact_product,
            kind=artifact_kind,
            role="aggregator",
        )
    )
    return packages


def package_target(
    target: artifact_targets.ArtifactTarget,
    *,
    version: str,
    asset_dir: Path,
    source_root: Path,
    output_dir: Path,
    cargo_target_dir: Path,
    part_bytes: int,
) -> list[GeneratedPackage]:
    archive = asset_dir / target.asset_name(version)
    if not archive.is_file():
        fail(f"missing liboliphaunt native release asset: {rel(archive)}")
    extracted_root = source_root / f"{target.target}-extracted"
    extract_archive(archive, extracted_root)
    optimize_native_runtime_payload.optimize_payload(extracted_root, target.target)
    tools_root = source_root / f"{target.target}-tools-extracted"
    copy_tools_payload(extracted_root, tools_root, target.target)
    return [
        *package_payload(
            extracted_root,
            source_root,
            output_dir,
            cargo_target_dir,
            target=target,
            version=version,
            part_bytes=part_bytes,
            package_base=PRODUCT,
            artifact_product=PRODUCT,
            artifact_kind=KIND,
            artifact_label="liboliphaunt native runtime",
        ),
        *package_payload(
            tools_root,
            source_root,
            output_dir,
            cargo_target_dir,
            target=target,
            version=version,
            part_bytes=part_bytes,
            package_base=TOOLS_PRODUCT,
            artifact_product=TOOLS_PRODUCT,
            artifact_kind=TOOLS_KIND,
            artifact_label="Oliphaunt native tools",
        ),
    ]


def write_packages_manifest(packages: list[GeneratedPackage], output_dir: Path) -> None:
    data = {
        "schema": "oliphaunt-liboliphaunt-cargo-artifacts-v1",
        "product": PRODUCT,
        "packages": [
            {
                "name": package.name,
                "target": package.target,
                "product": package.product,
                "kind": package.kind,
                "role": package.role,
                "index": package.index,
                "manifestPath": rel(package.manifest_path),
                "cratePath": rel(package.crate_path) if package.crate_path is not None else None,
            }
            for package in packages
        ],
    }
    (output_dir / "packages.json").write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--asset-dir",
        default="target/liboliphaunt/release-assets",
        help="directory containing checked liboliphaunt native release assets",
    )
    parser.add_argument(
        "--output-dir",
        default="target/liboliphaunt/cargo-artifacts",
        help="directory where generated .crate files are written",
    )
    parser.add_argument("--version", default=product_metadata.read_current_version(PRODUCT))
    parser.add_argument(
        "--target",
        action="append",
        default=[],
        help="release target id to package; defaults to every Rust native-direct target",
    )
    parser.add_argument(
        "--part-bytes",
        type=int,
        default=DEFAULT_PART_BYTES,
        help="maximum raw payload bytes per generated part crate",
    )
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    asset_dir = Path(args.asset_dir)
    output_dir = Path(args.output_dir)
    if not asset_dir.is_absolute():
        asset_dir = ROOT / asset_dir
    if not output_dir.is_absolute():
        output_dir = ROOT / output_dir
    if not asset_dir.is_dir():
        fail(f"liboliphaunt release asset directory does not exist: {rel(asset_dir)}")
    if args.part_bytes <= 0 or args.part_bytes > DEFAULT_PART_BYTES:
        fail(f"--part-bytes must be between 1 and {DEFAULT_PART_BYTES}")

    selected = set(args.target)
    source_root = ROOT / "target" / "liboliphaunt" / "cargo-package-sources"
    cargo_target_dir = ROOT / "target" / "liboliphaunt" / "cargo-package-target"
    shutil.rmtree(source_root, ignore_errors=True)
    shutil.rmtree(output_dir, ignore_errors=True)
    shutil.rmtree(cargo_target_dir, ignore_errors=True)
    source_root.mkdir(parents=True, exist_ok=True)
    output_dir.mkdir(parents=True, exist_ok=True)

    targets = artifact_targets.artifact_targets(
        product=PRODUCT,
        kind=KIND,
        surface=SURFACE,
        published_only=True,
    )
    if selected:
        known = {target.target for target in targets}
        unknown = sorted(selected - known)
        if unknown:
            fail("unknown liboliphaunt native Rust target(s): " + ", ".join(unknown))
        targets = [target for target in targets if target.target in selected]

    packages: list[GeneratedPackage] = []
    for target in targets:
        packages.extend(
            package_target(
                target,
                version=args.version,
                asset_dir=asset_dir,
                source_root=source_root,
                output_dir=output_dir,
                cargo_target_dir=cargo_target_dir,
                part_bytes=args.part_bytes,
            )
        )
    write_packages_manifest(packages, output_dir)
    print("generated liboliphaunt native Cargo artifact crates:")
    for package in packages:
        crate_path = rel(package.crate_path) if package.crate_path is not None else "<source-only>"
        print(f"{package.name} {package.role} {crate_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
