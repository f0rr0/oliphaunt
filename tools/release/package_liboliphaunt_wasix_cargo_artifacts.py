#!/usr/bin/env python3
"""Package liboliphaunt WASIX runtime assets as direct Cargo artifact crates."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tarfile
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import NoReturn

import product_metadata


ROOT = Path(__file__).resolve().parents[2]
PRODUCT = "liboliphaunt-wasix"
SCHEMA = "oliphaunt-liboliphaunt-wasix-cargo-artifacts-v2"
CRATES_IO_MAX_BYTES = 10 * 1024 * 1024
EXTENSION_AOT_SPLIT_THRESHOLD_BYTES = 9 * 1024 * 1024
RUNTIME_PACKAGE = "liboliphaunt-wasix-portable"
TOOLS_PACKAGE = "oliphaunt-wasix-tools"
ICU_PACKAGE = "oliphaunt-icu"
ICU_PAYLOAD_ARCHIVE = "icu-data.tar.zst"
TOOLS_PAYLOAD_FILES = (
    "bin/pg_dump.wasix.wasm",
    "bin/psql.wasix.wasm",
)
CORE_RUNTIME_ARCHIVE_FILES = (
    "oliphaunt/bin/initdb",
    "oliphaunt/bin/postgres",
)
FORBIDDEN_RUNTIME_ARCHIVE_TOOL_FILES = (
    "oliphaunt/bin/pg_ctl",
    "oliphaunt/bin/pg_dump",
    "oliphaunt/bin/psql",
)
TOOLS_AOT_ARTIFACTS = {"tool:pg_dump", "tool:psql"}
AOT_PACKAGES = {
    "macos-arm64": "liboliphaunt-wasix-aot-aarch64-apple-darwin",
    "linux-arm64-gnu": "liboliphaunt-wasix-aot-aarch64-unknown-linux-gnu",
    "linux-x64-gnu": "liboliphaunt-wasix-aot-x86_64-unknown-linux-gnu",
    "windows-x64-msvc": "liboliphaunt-wasix-aot-x86_64-pc-windows-msvc",
}
TOOLS_AOT_PACKAGES = {
    "macos-arm64": "oliphaunt-wasix-tools-aot-aarch64-apple-darwin",
    "linux-arm64-gnu": "oliphaunt-wasix-tools-aot-aarch64-unknown-linux-gnu",
    "linux-x64-gnu": "oliphaunt-wasix-tools-aot-x86_64-unknown-linux-gnu",
    "windows-x64-msvc": "oliphaunt-wasix-tools-aot-x86_64-pc-windows-msvc",
}
AOT_TARGET_TRIPLES = {
    "macos-arm64": "aarch64-apple-darwin",
    "linux-arm64-gnu": "aarch64-unknown-linux-gnu",
    "linux-x64-gnu": "x86_64-unknown-linux-gnu",
    "windows-x64-msvc": "x86_64-pc-windows-msvc",
}
AOT_TARGET_CFGS = {
    "aarch64-apple-darwin": 'cfg(all(target_os = "macos", target_arch = "aarch64"))',
    "aarch64-unknown-linux-gnu": 'cfg(all(target_os = "linux", target_arch = "aarch64", target_env = "gnu"))',
    "x86_64-unknown-linux-gnu": 'cfg(all(target_os = "linux", target_arch = "x86_64", target_env = "gnu"))',
    "x86_64-pc-windows-msvc": 'cfg(all(target_os = "windows", target_arch = "x86_64", target_env = "msvc"))',
}
EXPECTED_EXTENSION_AOT_TARGETS = frozenset(AOT_TARGET_TRIPLES.values())


def public_cargo_package_names() -> tuple[str, ...]:
    return (
        ICU_PACKAGE,
        RUNTIME_PACKAGE,
        TOOLS_PACKAGE,
        *AOT_PACKAGES.values(),
        *TOOLS_AOT_PACKAGES.values(),
    )


def public_aot_cargo_dependencies() -> dict[str, str]:
    return {
        AOT_TARGET_CFGS[AOT_TARGET_TRIPLES[target]]: package
        for target, package in AOT_PACKAGES.items()
    }


def public_tools_aot_cargo_dependencies() -> dict[str, str]:
    return {
        AOT_TARGET_CFGS[AOT_TARGET_TRIPLES[target]]: package
        for target, package in TOOLS_AOT_PACKAGES.items()
    }


def public_tools_feature_dependencies() -> set[str]:
    return {
        f"dep:{TOOLS_PACKAGE}",
        *(f"dep:{package}" for package in TOOLS_AOT_PACKAGES.values()),
    }


@dataclass(frozen=True)
class PackageSpec:
    name: str
    target: str
    kind: str
    template_dir: Path
    payload_root: Path
    payload_dir_name: str


@dataclass(frozen=True)
class GeneratedPackage:
    name: str
    manifest_path: Path
    crate_path: Path
    target: str
    kind: str
    size: int
    sha256: str


@dataclass(frozen=True)
class ExtensionCargoSpec:
    name: str
    product: str
    version: str
    sql_name: str
    archive: Path
    sha256: str
    size: int
    requires_aot: bool
    aot_targets: tuple["ExtensionAotCargoSpec", ...]


@dataclass(frozen=True)
class ExtensionAotCargoSpec:
    name: str
    version: str
    sql_name: str
    target: str
    source_dir: Path


@dataclass(frozen=True)
class ExtensionCargoSource:
    spec: ExtensionCargoSpec
    source_dir: Path


@dataclass(frozen=True)
class ExtensionAotCargoSource:
    spec: ExtensionAotCargoSpec
    source_dir: Path
    part_sources: tuple["ExtensionAotPartCargoSource", ...] = ()


@dataclass(frozen=True)
class ExtensionAotPartCargoSource:
    name: str
    version: str
    sql_name: str
    target: str
    source_dir: Path


def fail(message: str) -> NoReturn:
    print(f"package_liboliphaunt_wasix_cargo_artifacts.py: {message}", file=sys.stderr)
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


def checked_tar_member(name: str, archive: Path) -> PurePosixPath:
    path = PurePosixPath(name)
    parts = tuple(part for part in path.parts if part not in {"", "."})
    if not parts or any(part == ".." for part in parts) or path.is_absolute():
        fail(f"{rel(archive)} contains unsafe archive member {name!r}")
    return PurePosixPath(*parts)


def tar_zstd_members(archive: Path) -> list[str]:
    result = subprocess.run(
        ["tar", "--zstd", "-tf", str(archive)],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
    )
    if result.returncode != 0:
        fail(f"could not list {rel(archive)}: {result.stderr.strip()}")
    members = [line.rstrip("/") for line in result.stdout.splitlines() if line.strip()]
    for member in members:
        checked_tar_member(member, archive)
    return members


def extract_tar_zstd(archive: Path, destination: Path) -> None:
    shutil.rmtree(destination, ignore_errors=True)
    destination.mkdir(parents=True, exist_ok=True)
    tar_zstd_members(archive)
    run(["tar", "--zstd", "-xf", str(archive), "-C", str(destination)])


def payload_files(source_root: Path) -> list[Path]:
    return sorted(path for path in source_root.rglob("*") if path.is_file())


def target_asset_root(extracted: Path) -> Path:
    root = extracted / "target/oliphaunt-wasix/assets"
    if not (root / "manifest.json").is_file():
        fail(f"{rel(extracted)} does not contain target/oliphaunt-wasix/assets/manifest.json")
    return root


def target_aot_root(extracted: Path, triple: str) -> Path:
    root = extracted / "target/oliphaunt-wasix/aot" / triple
    if not (root / "manifest.json").is_file():
        fail(f"{rel(extracted)} does not contain target/oliphaunt-wasix/aot/{triple}/manifest.json")
    return root


def target_icu_root(extracted: Path) -> Path:
    root = extracted / "target/oliphaunt-wasix/icu/share/icu"
    if not root.is_dir():
        fail(f"{rel(extracted)} does not contain target/oliphaunt-wasix/icu/share/icu")
    return root


def validate_runtime_payload(root: Path) -> None:
    extension_files = sorted(path for path in (root / "extensions").rglob("*") if path.is_file()) if (root / "extensions").exists() else []
    if extension_files:
        fail("WASIX runtime Cargo payload must not contain extension archives: " + ", ".join(rel(path) for path in extension_files[:5]))
    manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
    if manifest.get("extensions") != []:
        fail(f"{rel(root / 'manifest.json')} must have an empty extensions array")
    for tool_key in ["pg-dump", "psql"]:
        if manifest.get(tool_key) is not None:
            fail(f"{rel(root / 'manifest.json')} must not advertise split WASIX tool {tool_key}")
    for required in [
        "oliphaunt.wasix.tar.zst",
        "bin/initdb.wasix.wasm",
        "prepopulated/pgdata-template.tar.zst",
        "prepopulated/pgdata-template.json",
    ]:
        if not (root / required).is_file():
            fail(f"WASIX runtime Cargo payload is missing {required}")
    runtime_members = tar_zstd_members(root / "oliphaunt.wasix.tar.zst")
    missing_core_runtime_files = sorted(
        member for member in CORE_RUNTIME_ARCHIVE_FILES if member not in runtime_members
    )
    if missing_core_runtime_files:
        fail(
            "WASIX runtime Cargo payload must bundle postgres/initdb inside "
            "oliphaunt.wasix.tar.zst; missing "
            + ", ".join(missing_core_runtime_files)
        )
    bundled_icu = [
        member
        for member in runtime_members
        if member == "oliphaunt/share/icu" or member.startswith("oliphaunt/share/icu/")
    ]
    if bundled_icu:
        fail(
            "WASIX runtime Cargo payload must not bundle ICU data; "
            f"found {bundled_icu[0]} in oliphaunt.wasix.tar.zst"
        )
    bundled_tools = sorted(
        member
        for member in runtime_members
        if member in FORBIDDEN_RUNTIME_ARCHIVE_TOOL_FILES
    )
    if bundled_tools:
        fail(
            "WASIX runtime Cargo payload must not bundle standalone tools inside "
            f"oliphaunt.wasix.tar.zst; found {bundled_tools[0]}"
        )


def validate_tools_payload(root: Path) -> None:
    actual = {path.relative_to(root).as_posix() for path in payload_files(root)}
    expected = set(TOOLS_PAYLOAD_FILES)
    if actual != expected:
        fail(f"WASIX tools Cargo payload file set mismatch for {rel(root)}: expected {sorted(expected)}, got {sorted(actual)}")


def prune_runtime_archive_tools(archive: Path, scratch: Path) -> None:
    runtime_members = tar_zstd_members(archive)
    if not any(member in FORBIDDEN_RUNTIME_ARCHIVE_TOOL_FILES for member in runtime_members):
        return

    extract_tar_zstd(archive, scratch)
    for member in FORBIDDEN_RUNTIME_ARCHIVE_TOOL_FILES:
        path = scratch / member
        if path.exists():
            path.unlink()
    prune_empty_dirs(scratch)

    replacement = archive.with_name(f"{archive.name}.tmp")
    if replacement.exists():
        replacement.unlink()
    run(
        [
            "tar",
            "--sort=name",
            "--owner=0",
            "--group=0",
            "--numeric-owner",
            "--mtime=@0",
            "--use-compress-program=zstd -19",
            "-cf",
            str(replacement),
            "-C",
            str(scratch),
            "oliphaunt",
        ]
    )
    replacement.replace(archive)


def rewrite_runtime_core_manifest(root: Path) -> None:
    manifest_path = root / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    runtime = manifest.get("runtime")
    if not isinstance(runtime, dict):
        fail(f"{rel(manifest_path)} is missing runtime metadata")
    runtime["sha256"] = sha256_file(root / "oliphaunt.wasix.tar.zst")
    manifest["extensions"] = []
    manifest.pop("pg-dump", None)
    manifest.pop("psql", None)
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")


def split_runtime_tools_payload(runtime_root: Path, extract_root: Path) -> tuple[Path, Path]:
    core_root = extract_root / "runtime-core-payload"
    tools_root = extract_root / "tools-payload"
    shutil.rmtree(core_root, ignore_errors=True)
    shutil.rmtree(tools_root, ignore_errors=True)
    shutil.copytree(runtime_root, core_root)
    shutil.rmtree(core_root / "extensions", ignore_errors=True)
    missing: list[str] = []
    for relative in TOOLS_PAYLOAD_FILES:
        source = runtime_root / relative
        if not source.is_file():
            missing.append(relative)
            continue
        destination = tools_root / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, destination)
        core_file = core_root / relative
        if core_file.exists():
            core_file.unlink()
    if missing:
        fail("WASIX tools Cargo payload is missing " + ", ".join(missing))
    prune_runtime_archive_tools(
        core_root / "oliphaunt.wasix.tar.zst",
        extract_root / "runtime-archive-core-pruned",
    )
    rewrite_runtime_core_manifest(core_root)
    prune_empty_dirs(core_root)
    return core_root, tools_root


def prune_empty_dirs(root: Path) -> None:
    for path in sorted((item for item in root.rglob("*") if item.is_dir()), reverse=True):
        try:
            path.rmdir()
        except OSError:
            pass


def icu_root_contains_data(root: Path) -> bool:
    if not root.is_dir():
        return False
    for child in sorted(root.iterdir()):
        name = child.name
        if child.is_file() and name.startswith("icudt") and name.endswith(".dat"):
            return True
        if child.is_dir() and name.startswith("icudt") and any(path.is_file() for path in child.rglob("*")):
            return True
    return False


def canonical_icu_root(root: Path) -> Path:
    if icu_root_contains_data(root):
        return root
    candidates = [child for child in sorted(root.iterdir()) if child.is_dir() and icu_root_contains_data(child)]
    if len(candidates) != 1:
        fail(f"{rel(root)} must contain exactly one ICU data directory, found {len(candidates)}")
    return candidates[0]


def validate_icu_payload(root: Path) -> None:
    if not icu_root_contains_data(root):
        fail(f"ICU Cargo payload is missing icudt data under {rel(root)}")


def write_icu_payload_archive(root: Path, payload_root: Path) -> Path:
    stage = payload_root.parent / "icu-payload-stage"
    shutil.rmtree(stage, ignore_errors=True)
    shutil.rmtree(payload_root, ignore_errors=True)
    (stage / "share").mkdir(parents=True, exist_ok=True)
    payload_root.mkdir(parents=True, exist_ok=True)
    shutil.copytree(root, stage / "share/icu")
    archive = payload_root / ICU_PAYLOAD_ARCHIVE
    run(
        [
            "tar",
            "--sort=name",
            "--owner=0",
            "--group=0",
            "--numeric-owner",
            "--mtime=@0",
            "--use-compress-program=zstd -19",
            "-cf",
            str(archive),
            "-C",
            str(stage),
            "share/icu",
        ]
    )
    members = tar_zstd_members(archive)
    unexpected = []
    has_icu_data = False
    for member in members:
        path = PurePosixPath(member)
        if path == PurePosixPath("share/icu"):
            continue
        try:
            relative = path.relative_to("share/icu")
        except ValueError:
            unexpected.append(member)
            continue
        if len(relative.parts) >= 2 and relative.parts[0].startswith("icudt"):
            has_icu_data = True
    if not has_icu_data:
        fail(f"{rel(archive)} is missing share/icu/icudt* data")
    if unexpected:
        fail(f"{rel(archive)} must contain only share/icu data, found {unexpected[0]}")
    return payload_root


def validate_aot_payload(root: Path) -> None:
    manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
    artifacts = manifest.get("artifacts")
    if not isinstance(artifacts, list) or not artifacts:
        fail(f"{rel(root / 'manifest.json')} must contain AOT artifacts")
    expected = {"manifest.json"}
    for artifact in artifacts:
        name = artifact.get("name")
        path = artifact.get("path")
        if not isinstance(name, str) or not name:
            fail(f"{rel(root / 'manifest.json')} contains an artifact without a name")
        if name.startswith("extension:"):
            fail(f"WASIX AOT Cargo payload must not contain extension artifact {name}")
        if not isinstance(path, str) or not path:
            fail(f"AOT artifact {name} is missing path")
        checked = PurePosixPath(path)
        if checked.is_absolute() or any(part in {"", ".", ".."} for part in checked.parts):
            fail(f"AOT artifact {name} path must be simple relative path, got {path!r}")
        if not (root / path).is_file():
            fail(f"AOT artifact {name} file is missing: {rel(root / path)}")
        expected.add(path)
    actual = {path.relative_to(root).as_posix() for path in payload_files(root)}
    if actual != expected:
        fail(f"WASIX AOT Cargo payload file set mismatch for {rel(root)}: expected {sorted(expected)}, got {sorted(actual)}")


def split_aot_tools_payload(aot_root: Path, extract_root: Path, target_id: str) -> tuple[Path, Path]:
    manifest_path = aot_root / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    artifacts = manifest.get("artifacts")
    if not isinstance(artifacts, list):
        fail(f"{rel(manifest_path)} must contain an artifacts array")

    core_root = extract_root / f"{target_id}-aot-core-payload"
    tools_root = extract_root / f"{target_id}-aot-tools-payload"
    shutil.rmtree(core_root, ignore_errors=True)
    shutil.rmtree(tools_root, ignore_errors=True)
    core_artifacts: list[dict[str, object]] = []
    tools_artifacts: list[dict[str, object]] = []

    for artifact in artifacts:
        if not isinstance(artifact, dict):
            fail(f"{rel(manifest_path)} contains a non-object artifact")
        name = artifact.get("name")
        path = artifact.get("path")
        if not isinstance(name, str) or not isinstance(path, str):
            fail(f"{rel(manifest_path)} contains an artifact without name/path")
        target_root = tools_root if name in TOOLS_AOT_ARTIFACTS else core_root
        target_artifacts = tools_artifacts if name in TOOLS_AOT_ARTIFACTS else core_artifacts
        source = aot_root / path
        if not source.is_file():
            fail(f"{rel(manifest_path)} references missing AOT artifact {path}")
        destination = target_root / path
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, destination)
        target_artifacts.append(artifact)

    missing = sorted(TOOLS_AOT_ARTIFACTS - {str(item.get("name")) for item in tools_artifacts})
    if missing:
        fail(f"{rel(manifest_path)} is missing WASIX tools AOT artifacts: {', '.join(missing)}")
    if not core_artifacts:
        fail(f"{rel(manifest_path)} generated no core WASIX AOT artifacts")

    for target_root, target_artifacts in [(core_root, core_artifacts), (tools_root, tools_artifacts)]:
        target_manifest = {**manifest, "artifacts": target_artifacts}
        target_root.mkdir(parents=True, exist_ok=True)
        (target_root / "manifest.json").write_text(
            json.dumps(target_manifest, indent=2) + "\n",
            encoding="utf-8",
        )
    return core_root, tools_root


def patch_tools_aot_template(crate_dir: Path, target: str) -> None:
    manifest = crate_dir / "Cargo.toml"
    text = manifest.read_text(encoding="utf-8")
    links = "oliphaunt_artifact_oliphaunt_wasix_tools_aot_" + target.replace("-", "_")
    text = re.sub(r'(?m)^links = "[^"]+"$', f'links = "{links}"', text, count=1)
    text = re.sub(
        r'(?m)^description = "[^"]+"$',
        f'description = "Internal Wasmer AOT artifacts for oliphaunt-wasix tools on {target}"',
        text,
        count=1,
    )
    manifest.write_text(text, encoding="utf-8")

    build_rs = crate_dir / "build.rs"
    text = build_rs.read_text(encoding="utf-8")
    text = text.replace(
        'const ARTIFACT_PRODUCT: &str = "liboliphaunt-wasix";',
        'const ARTIFACT_PRODUCT: &str = "oliphaunt-wasix-tools";',
    )
    text = text.replace(
        'const ARTIFACT_KIND: &str = "wasix-aot";',
        'const ARTIFACT_KIND: &str = "wasix-tools-aot";',
    )
    text = text.replace(
        '.strip_prefix("liboliphaunt-wasix-aot-")',
        '.strip_prefix("oliphaunt-wasix-tools-aot-")',
    )
    text = text.replace(
        "AOT crate name starts with liboliphaunt-wasix-aot-",
        "AOT crate name starts with oliphaunt-wasix-tools-aot-",
    )
    build_rs.write_text(text, encoding="utf-8")


def rewrite_cargo_manifest(
    manifest: Path,
    *,
    package_name: str,
    version: str,
    extension_sources: list[ExtensionCargoSource],
    extension_aot_sources: list[ExtensionAotCargoSource],
) -> None:
    text = manifest.read_text(encoding="utf-8")
    text = re.sub(r'(?m)^name = "[^"]+"$', f'name = "{package_name}"', text, count=1)
    text = re.sub(r'(?m)^version = "[^"]+"$', f'version = "{version}"', text, count=1)
    text = re.sub(r'(?m)^publish = false\n?', "", text)
    if package_name == RUNTIME_PACKAGE and extension_sources:
        text = inject_runtime_extension_dependencies(text, extension_sources, extension_aot_sources)
    if "\n[workspace]" not in text:
        text = text.rstrip() + "\n\n[workspace]\n"
    manifest.write_text(text, encoding="utf-8")
    package = cargo_metadata_package(manifest)
    if package["name"] != package_name or package["version"] != version:
        fail(
            f"{rel(manifest)} generated the wrong package metadata: "
            f"name={package['name']!r}, version={package['version']!r}"
        )


def inject_runtime_extension_dependencies(
    text: str,
    extension_sources: list[ExtensionCargoSource],
    extension_aot_sources: list[ExtensionAotCargoSource],
) -> str:
    dependency_lines = []
    target_dependency_lines: dict[str, list[str]] = {}
    aot_by_extension: dict[str, list[ExtensionAotCargoSource]] = {}
    for source in extension_aot_sources:
        aot_by_extension.setdefault(source.spec.sql_name, []).append(source)
    for source in extension_sources:
        package = source.spec.name
        dependency_lines.append(
            f'{package} = {{ version = "={source.spec.version}", path = "../{package}", optional = true }}'
        )
        feature = extension_feature_name(source.spec.product)
        feature_deps = [f"dep:{package}"]
        for aot_source in sorted(aot_by_extension.get(source.spec.sql_name, []), key=lambda item: item.spec.name):
            feature_deps.append(f"dep:{aot_source.spec.name}")
        replacement = f'{feature} = [{", ".join(json.dumps(dep) for dep in feature_deps)}]'
        pattern = rf"(?m)^{re.escape(feature)} = \[[^\n]*\]$"
        text, count = re.subn(pattern, replacement, text, count=1)
        if count == 0:
            text = text.replace("[features]\n", f"[features]\n{replacement}\n", 1)
    for source in extension_aot_sources:
        cfg = AOT_TARGET_CFGS.get(source.spec.target)
        if cfg is None:
            fail(f"unsupported extension AOT target {source.spec.target}")
        target_dependency_lines.setdefault(cfg, []).append(
            f'{source.spec.name} = {{ version = "={source.spec.version}", path = "../{source.spec.name}", optional = true }}'
        )
    if dependency_lines:
        block = "\n".join(dependency_lines)
        text = text.replace("\n[build-dependencies]", f"\n{block}\n\n[build-dependencies]", 1)
    if target_dependency_lines:
        blocks = []
        for cfg, lines in sorted(target_dependency_lines.items()):
            blocks.append(f"[target.'{cfg}'.dependencies]\n" + "\n".join(sorted(lines)))
        text = text.replace("\n[build-dependencies]", "\n" + "\n\n".join(blocks) + "\n\n[build-dependencies]", 1)
    return text


def copy_package_source(
    spec: PackageSpec,
    source_root: Path,
    version: str,
    extension_sources: list[ExtensionCargoSource],
    extension_aot_sources: list[ExtensionAotCargoSource],
) -> Path:
    crate_dir = source_root / spec.name
    if crate_dir.exists():
        fail(f"duplicate generated WASIX Cargo package source: {rel(crate_dir)}")
    shutil.copytree(
        spec.template_dir,
        crate_dir,
        ignore=shutil.ignore_patterns("target", "payload", "artifacts"),
    )
    if spec.kind == "wasix-tools-aot":
        patch_tools_aot_template(crate_dir, spec.target)
    shutil.copytree(spec.payload_root, crate_dir / spec.payload_dir_name)
    rewrite_cargo_manifest(
        crate_dir / "Cargo.toml",
        package_name=spec.name,
        version=version,
        extension_sources=extension_sources,
        extension_aot_sources=extension_aot_sources,
    )
    return crate_dir


def cargo_metadata_package(manifest: Path) -> dict[str, object]:
    result = subprocess.run(
        ["cargo", "metadata", "--no-deps", "--format-version", "1", "--manifest-path", str(manifest)],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
    )
    if result.returncode != 0:
        fail(f"cargo metadata failed for {rel(manifest)}: {result.stderr.strip()}")
    data = json.loads(result.stdout)
    packages = data.get("packages")
    if not isinstance(packages, list) or len(packages) != 1:
        fail(f"cargo metadata for {rel(manifest)} did not return exactly one package")
    package = packages[0]
    if not isinstance(package, dict):
        fail(f"cargo metadata for {rel(manifest)} returned an invalid package")
    return package


def cargo_package(crate_dir: Path, target_dir: Path, *, no_verify: bool = False) -> Path:
    manifest = crate_dir / "Cargo.toml"
    package = cargo_metadata_package(manifest)
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


def packaged_manifest_text(text: str) -> str:
    return re.sub(r', path = "\.\./[^"]+"', "", text)


def cargo_package_without_dependency_resolution(crate_dir: Path, target_dir: Path) -> Path:
    manifest = crate_dir / "Cargo.toml"
    package = cargo_metadata_package(manifest)
    name = str(package["name"])
    version = str(package["version"])
    package_root = f"{name}-{version}"
    stage_root = target_dir / "manual-package-stage"
    stage_dir = stage_root / package_root
    crate_path = target_dir / "package" / f"{package_root}.crate"
    shutil.rmtree(stage_dir, ignore_errors=True)
    crate_path.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(
        crate_dir,
        stage_dir,
        ignore=shutil.ignore_patterns("target", ".git"),
    )
    staged_manifest = stage_dir / "Cargo.toml"
    staged_manifest.write_text(
        packaged_manifest_text(staged_manifest.read_text(encoding="utf-8")),
        encoding="utf-8",
    )
    cargo_metadata_package(staged_manifest)
    if crate_path.exists():
        crate_path.unlink()
    with tarfile.open(crate_path, "w:gz") as archive:
        for path in sorted(item for item in stage_dir.rglob("*") if item.is_file()):
            arcname = f"{package_root}/{path.relative_to(stage_dir).as_posix()}"
            info = archive.gettarinfo(path, arcname)
            info.uid = 0
            info.gid = 0
            info.uname = ""
            info.gname = ""
            info.mtime = 0
            with path.open("rb") as handle:
                archive.addfile(info, handle)
    if not crate_path.is_file():
        fail(f"manual package did not create {rel(crate_path)}")
    return crate_path


def validate_crate_size(crate_path: Path) -> None:
    size = crate_path.stat().st_size
    if size > CRATES_IO_MAX_BYTES:
        fail(
            f"{rel(crate_path)} is {size} bytes, above the crates.io 10 MiB package limit; "
            "reduce the WASIX Cargo payload before publishing"
        )


def package_spec(
    spec: PackageSpec,
    *,
    version: str,
    source_root: Path,
    output_dir: Path,
    cargo_target_dir: Path,
    extension_sources: list[ExtensionCargoSource],
    extension_aot_sources: list[ExtensionAotCargoSource],
) -> GeneratedPackage:
    crate_dir = copy_package_source(spec, source_root, version, extension_sources, extension_aot_sources)
    if spec.name == RUNTIME_PACKAGE and extension_sources:
        crate_path = cargo_package_without_dependency_resolution(crate_dir, cargo_target_dir)
    else:
        crate_path = cargo_package(crate_dir, cargo_target_dir)
    validate_crate_size(crate_path)
    output = output_dir / crate_path.name
    shutil.copy2(crate_path, output)
    return GeneratedPackage(
        name=spec.name,
        manifest_path=crate_dir / "Cargo.toml",
        crate_path=output,
        target=spec.target,
        kind=spec.kind,
        size=output.stat().st_size,
        sha256=sha256_file(output),
    )


def extension_feature_name(package_name: str) -> str:
    if not package_name.startswith("oliphaunt-extension-"):
        fail(f"invalid extension package name {package_name}")
    return "extension-" + package_name.removeprefix("oliphaunt-extension-")


def wasix_extension_package_name(product: str) -> str:
    if not product.startswith("oliphaunt-extension-"):
        fail(f"invalid extension product name {product}")
    return f"{product}-wasix"


def wasix_extension_aot_package_name(product: str, target: str) -> str:
    if not product.startswith("oliphaunt-extension-"):
        fail(f"invalid extension product name {product}")
    return f"{product}-wasix-aot-{target}"


def wasix_extension_aot_part_package_name(package_name: str, index: int) -> str:
    return f"{package_name}-part-{index:03d}"


def rust_crate_ident(package_name: str) -> str:
    return package_name.replace("-", "_")


def discover_extension_manifests(roots: list[Path]) -> list[Path]:
    manifests: list[Path] = []
    for root in roots:
        if root.is_file() and root.name == "extension-artifacts.json":
            manifests.append(root)
            continue
        if root.is_dir():
            manifests.extend(path for path in root.rglob("extension-artifacts.json") if path.is_file())
    return sorted(set(manifests))


def extension_wasix_asset(extension_dir: Path, manifest: dict[str, object]) -> Path | None:
    for asset in manifest.get("assets", []):
        if not isinstance(asset, dict):
            continue
        if (
            asset.get("family") == "wasix"
            and asset.get("kind") == "wasix-runtime"
            and asset.get("target") == "wasix-portable"
            and isinstance(asset.get("name"), str)
        ):
            path = extension_dir / "release-assets" / str(asset["name"])
            if path.is_file():
                return path
    return None


def extension_aot_specs(extension_dir: Path, *, product: str, version: str, sql_name: str) -> tuple[ExtensionAotCargoSpec, ...]:
    aot_root = extension_dir / "wasix-aot"
    if not aot_root.is_dir():
        return ()
    specs: list[ExtensionAotCargoSpec] = []
    seen_targets: set[str] = set()
    for manifest_path in sorted(aot_root.glob("*/manifest.json")):
        data = json.loads(manifest_path.read_text(encoding="utf-8"))
        target = data.get("target-triple")
        artifacts = data.get("artifacts")
        if not isinstance(target, str) or not target:
            fail(f"{rel(manifest_path)} is missing target-triple")
        if target in seen_targets:
            fail(f"{rel(aot_root)} has duplicate extension AOT target {target}")
        if not isinstance(artifacts, list) or not artifacts:
            fail(f"{rel(manifest_path)} must contain extension AOT artifacts")
        expected_prefix = f"extension:{sql_name}"
        for artifact in artifacts:
            if not isinstance(artifact, dict):
                fail(f"{rel(manifest_path)} contains a non-object AOT artifact")
            name = artifact.get("name")
            path = artifact.get("path")
            if not isinstance(name, str) or not (
                name == expected_prefix or name.startswith(f"{expected_prefix}:")
            ):
                fail(f"{rel(manifest_path)} contains AOT artifact {name!r} for {sql_name}")
            if not isinstance(path, str) or not path:
                fail(f"{rel(manifest_path)} artifact {name!r} is missing path")
            checked = PurePosixPath(path)
            if checked.is_absolute() or any(part in {"", ".", ".."} for part in checked.parts):
                fail(f"{rel(manifest_path)} artifact {name!r} path must be simple relative path, got {path!r}")
            if not (manifest_path.parent / path).is_file():
                fail(f"{rel(manifest_path)} references missing AOT artifact {path}")
        seen_targets.add(target)
        specs.append(
            ExtensionAotCargoSpec(
                name=wasix_extension_aot_package_name(product, target),
                version=version,
                sql_name=sql_name,
                target=target,
                source_dir=manifest_path.parent,
            )
        )
    return tuple(sorted(specs, key=lambda spec: spec.target))


def extension_cargo_specs(extension_roots: list[Path]) -> list[ExtensionCargoSpec]:
    specs: list[ExtensionCargoSpec] = []
    for manifest_path in discover_extension_manifests(extension_roots):
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        product = manifest.get("product")
        version = manifest.get("version")
        sql_name = manifest.get("sqlName")
        native_module_stem = manifest.get("nativeModuleStem")
        if not all(isinstance(value, str) and value for value in [product, version, sql_name]):
            fail(f"{rel(manifest_path)} is missing product, version, or sqlName")
        archive = extension_wasix_asset(manifest_path.parent, manifest)
        if archive is None:
            continue
        specs.append(
            ExtensionCargoSpec(
                name=wasix_extension_package_name(str(product)),
                product=str(product),
                version=str(version),
                sql_name=str(sql_name),
                archive=archive,
                sha256=sha256_file(archive),
                size=archive.stat().st_size,
                requires_aot=isinstance(native_module_stem, str) and bool(native_module_stem),
                aot_targets=extension_aot_specs(
                    manifest_path.parent,
                    product=str(product),
                    version=str(version),
                    sql_name=str(sql_name),
                ),
            )
        )
    return sorted(specs, key=lambda spec: spec.name)


def validate_extension_aot_coverage(extension_specs: list[ExtensionCargoSpec]) -> None:
    for spec in extension_specs:
        if not spec.requires_aot:
            continue
        actual_targets = {aot_spec.target for aot_spec in spec.aot_targets}
        if actual_targets != EXPECTED_EXTENSION_AOT_TARGETS:
            fail(
                f"{spec.product} has a WASIX native module but incomplete extension AOT artifacts; "
                f"expected={sorted(EXPECTED_EXTENSION_AOT_TARGETS)}, actual={sorted(actual_targets)}"
            )


def write_extension_cargo_source(spec: ExtensionCargoSpec, source_root: Path) -> ExtensionCargoSource:
    crate_dir = source_root / spec.name
    if crate_dir.exists():
        fail(f"duplicate generated WASIX extension Cargo package source: {rel(crate_dir)}")
    (crate_dir / "src").mkdir(parents=True, exist_ok=True)
    (crate_dir / "payload").mkdir(parents=True, exist_ok=True)
    shutil.copy2(spec.archive, crate_dir / "payload/extension.tar.zst")
    crate_dir.joinpath("README.md").write_text(
        "\n".join(
            [
                f"# {spec.name}",
                "",
                f"Cargo artifact package for the `{spec.sql_name}` Oliphaunt WASIX extension.",
                "",
            ]
        ),
        encoding="utf-8",
    )
    crate_dir.joinpath("Cargo.toml").write_text(
        "\n".join(
            [
                "[package]",
                f'name = "{spec.name}"',
                f'version = "{spec.version}"',
                'edition = "2024"',
                'rust-version = "1.93"',
                f'description = "Oliphaunt WASIX artifact package for the {spec.sql_name} PostgreSQL extension"',
                'repository = "https://github.com/f0rr0/oliphaunt"',
                'homepage = "https://oliphaunt.dev"',
                'license = "MIT AND Apache-2.0 AND PostgreSQL"',
                'include = ["Cargo.toml", "README.md", "src/**", "payload/**"]',
                "",
                "[lib]",
                'path = "src/lib.rs"',
                "",
                "[workspace]",
                "",
            ]
        ),
        encoding="utf-8",
    )
    crate_dir.joinpath("src/lib.rs").write_text(
        "\n".join(
            [
                "#![deny(unsafe_code)]",
                "",
                f'pub const SQL_NAME: &str = "{spec.sql_name}";',
                f'pub const ARCHIVE_SHA256: &str = "{spec.sha256}";',
                f"pub const ARCHIVE_SIZE: u64 = {spec.size};",
                "",
                "pub fn archive() -> Option<&'static [u8]> {",
                '    Some(include_bytes!("../payload/extension.tar.zst"))',
                "}",
                "",
            ]
        ),
        encoding="utf-8",
    )
    return ExtensionCargoSource(spec=spec, source_dir=crate_dir)


def write_extension_aot_cargo_source(
    spec: ExtensionAotCargoSpec,
    source_root: Path,
) -> ExtensionAotCargoSource:
    crate_dir = source_root / spec.name
    if crate_dir.exists():
        fail(f"duplicate generated WASIX extension AOT Cargo package source: {rel(crate_dir)}")
    (crate_dir / "src").mkdir(parents=True, exist_ok=True)
    manifest_path = spec.source_dir / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    artifacts: list[tuple[str, str, Path, int]] = []
    for artifact in sorted(manifest.get("artifacts", []), key=lambda item: item.get("name", "")):
        name = artifact.get("name")
        path = artifact.get("path")
        if not isinstance(name, str) or not isinstance(path, str):
            fail(f"{rel(manifest_path)} contains an AOT artifact without name/path")
        source = spec.source_dir / path
        if not source.is_file():
            fail(f"{rel(manifest_path)} references missing AOT artifact {path}")
        artifacts.append((name, path, source, source.stat().st_size))
    if not artifacts:
        fail(f"{rel(manifest_path)} must contain extension AOT artifacts")

    split_parts = sum(size for _, _, _, size in artifacts) > EXTENSION_AOT_SPLIT_THRESHOLD_BYTES
    part_sources: list[ExtensionAotPartCargoSource] = []

    if split_parts:
        (crate_dir / "artifacts").mkdir(parents=True, exist_ok=True)
        shutil.copy2(manifest_path, crate_dir / "artifacts/manifest.json")
        for index, (name, path, source, _) in enumerate(artifacts):
            part_name = wasix_extension_aot_part_package_name(spec.name, index)
            part_dir = source_root / part_name
            if part_dir.exists():
                fail(f"duplicate generated WASIX extension AOT Cargo package source: {rel(part_dir)}")
            (part_dir / "src").mkdir(parents=True, exist_ok=True)
            destination = part_dir / "artifacts" / path
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, destination)
            part_dir.joinpath("README.md").write_text(
                "\n".join(
                    [
                        f"# {part_name}",
                        "",
                        f"Cargo artifact package part for `{spec.sql_name}` Oliphaunt WASIX AOT artifacts on `{spec.target}`.",
                        "",
                    ]
                ),
                encoding="utf-8",
            )
            part_dir.joinpath("Cargo.toml").write_text(
                "\n".join(
                    [
                        "[package]",
                        f'name = "{part_name}"',
                        f'version = "{spec.version}"',
                        'edition = "2024"',
                        'rust-version = "1.93"',
                        f'description = "Oliphaunt WASIX AOT artifact package part for the {spec.sql_name} PostgreSQL extension on {spec.target}"',
                        'repository = "https://github.com/f0rr0/oliphaunt"',
                        'homepage = "https://oliphaunt.dev"',
                        'license = "MIT AND Apache-2.0 AND PostgreSQL"',
                        'include = ["Cargo.toml", "README.md", "src/**", "artifacts/**"]',
                        "",
                        "[lib]",
                        'path = "src/lib.rs"',
                        "",
                        "[workspace]",
                        "",
                    ]
                ),
                encoding="utf-8",
            )
            part_dir.joinpath("src/lib.rs").write_text(
                "".join(
                    [
                        "#![deny(unsafe_code)]\n\n",
                        f'pub const SQL_NAME: &str = "{spec.sql_name}";\n',
                        f'pub const TARGET_TRIPLE: &str = "{spec.target}";\n\n',
                        "pub fn aot_artifact_bytes(name: &str) -> Option<&'static [u8]> {\n",
                        "    match name {\n",
                        f'        {json.dumps(name)} => Some(include_bytes!("../artifacts/{path}")),\n',
                        "        _ => None,\n",
                        "    }\n",
                        "}\n",
                    ]
                ),
                encoding="utf-8",
            )
            part_sources.append(
                ExtensionAotPartCargoSource(
                    name=part_name,
                    version=spec.version,
                    sql_name=spec.sql_name,
                    target=spec.target,
                    source_dir=part_dir,
                )
            )
    else:
        shutil.copytree(spec.source_dir, crate_dir / "artifacts")

    artifact_cases = []
    for name, path, _, _ in artifacts:
        artifact_cases.append(
            f'        {json.dumps(name)} => Some(include_bytes!("../artifacts/{path}")),\n'
        )
    crate_dir.joinpath("README.md").write_text(
        "\n".join(
            [
                f"# {spec.name}",
                "",
                f"Cargo artifact package for `{spec.sql_name}` Oliphaunt WASIX AOT artifacts on `{spec.target}`.",
                "",
            ]
        ),
        encoding="utf-8",
    )
    crate_dir.joinpath("Cargo.toml").write_text(
        "\n".join(
            [
                "[package]",
                f'name = "{spec.name}"',
                f'version = "{spec.version}"',
                'edition = "2024"',
                'rust-version = "1.93"',
                f'description = "Oliphaunt WASIX AOT artifact package for the {spec.sql_name} PostgreSQL extension on {spec.target}"',
                'repository = "https://github.com/f0rr0/oliphaunt"',
                'homepage = "https://oliphaunt.dev"',
                'license = "MIT AND Apache-2.0 AND PostgreSQL"',
                'include = ["Cargo.toml", "README.md", "src/**", "artifacts/**"]',
                "",
                "[lib]",
                'path = "src/lib.rs"',
                "",
                *(
                    [
                        "[dependencies]",
                        *[
                            f'{part.name} = {{ version = "={part.version}", path = "../{part.name}" }}'
                            for part in part_sources
                        ],
                        "",
                    ]
                    if part_sources
                    else []
                ),
                "[workspace]",
                "",
            ]
        ),
        encoding="utf-8",
    )
    if part_sources:
        artifact_bytes_lines: list[str] = []
        for part in part_sources:
            artifact_bytes_lines.extend(
                [
                    f"    if let Some(bytes) = {rust_crate_ident(part.name)}::aot_artifact_bytes(name) {{\n",
                    "        return Some(bytes);\n",
                    "    }\n",
                ]
            )
        artifact_bytes_body = "".join(artifact_bytes_lines)
    else:
        artifact_bytes_body = "".join(
            [
                "    match name {\n",
                *artifact_cases,
                "        _ => None,\n",
                "    }\n",
            ]
        )
    crate_dir.joinpath("src/lib.rs").write_text(
        "".join(
            [
                "#![deny(unsafe_code)]\n\n",
                f'pub const SQL_NAME: &str = "{spec.sql_name}";\n',
                f'pub const TARGET_TRIPLE: &str = "{spec.target}";\n',
                'pub const MANIFEST_JSON: &str = include_str!("../artifacts/manifest.json");\n\n',
                "pub fn aot_manifest_json() -> Option<&'static str> {\n",
                "    Some(MANIFEST_JSON)\n",
                "}\n\n",
                "pub fn aot_artifact_bytes(name: &str) -> Option<&'static [u8]> {\n",
                artifact_bytes_body,
                "    None\n" if part_sources else "",
                "}\n",
            ]
        ),
        encoding="utf-8",
    )
    return ExtensionAotCargoSource(spec=spec, source_dir=crate_dir, part_sources=tuple(part_sources))


def package_extension_source(
    source: ExtensionCargoSource,
    *,
    output_dir: Path,
    cargo_target_dir: Path,
) -> GeneratedPackage:
    crate_path = cargo_package(source.source_dir, cargo_target_dir)
    validate_crate_size(crate_path)
    output = output_dir / crate_path.name
    shutil.copy2(crate_path, output)
    return GeneratedPackage(
        name=source.spec.name,
        manifest_path=source.source_dir / "Cargo.toml",
        crate_path=output,
        target="wasix-portable",
        kind="wasix-extension",
        size=output.stat().st_size,
        sha256=sha256_file(output),
    )


def package_extension_aot_source(
    source: ExtensionAotCargoSource,
    *,
    output_dir: Path,
    cargo_target_dir: Path,
) -> list[GeneratedPackage]:
    packages: list[GeneratedPackage] = []
    for part in source.part_sources:
        crate_path = cargo_package(part.source_dir, cargo_target_dir)
        validate_crate_size(crate_path)
        output = output_dir / crate_path.name
        shutil.copy2(crate_path, output)
        packages.append(
            GeneratedPackage(
                name=part.name,
                manifest_path=part.source_dir / "Cargo.toml",
                crate_path=output,
                target=part.target,
                kind="wasix-extension-aot",
                size=output.stat().st_size,
                sha256=sha256_file(output),
            )
        )
    if source.part_sources:
        crate_path = cargo_package_without_dependency_resolution(source.source_dir, cargo_target_dir)
    else:
        crate_path = cargo_package(source.source_dir, cargo_target_dir)
    validate_crate_size(crate_path)
    output = output_dir / crate_path.name
    shutil.copy2(crate_path, output)
    packages.append(
        GeneratedPackage(
            name=source.spec.name,
            manifest_path=source.source_dir / "Cargo.toml",
            crate_path=output,
            target=source.spec.target,
            kind="wasix-extension-aot",
            size=output.stat().st_size,
            sha256=sha256_file(output),
        )
    )
    return packages


def package_specs(asset_dir: Path, extract_root: Path, version: str) -> list[PackageSpec]:
    specs: list[PackageSpec] = []
    runtime_archive = asset_dir / f"liboliphaunt-wasix-{version}-runtime-portable.tar.zst"
    if not runtime_archive.is_file():
        fail(f"missing WASIX portable runtime release asset: {rel(runtime_archive)}")
    runtime_extract = extract_root / "runtime-extracted"
    extract_tar_zstd(runtime_archive, runtime_extract)
    runtime_root = target_asset_root(runtime_extract)
    runtime_core_root, tools_root = split_runtime_tools_payload(runtime_root, extract_root)
    validate_runtime_payload(runtime_core_root)
    validate_tools_payload(tools_root)
    specs.append(
        PackageSpec(
            name=RUNTIME_PACKAGE,
            target="portable",
            kind="wasix-runtime",
            template_dir=ROOT / "src/runtimes/liboliphaunt/wasix/crates/assets",
            payload_root=runtime_core_root,
            payload_dir_name="payload",
        )
    )
    specs.append(
        PackageSpec(
            name=TOOLS_PACKAGE,
            target="portable",
            kind="wasix-tools",
            template_dir=ROOT / "src/runtimes/liboliphaunt/wasix/crates/tools",
            payload_root=tools_root,
            payload_dir_name="payload",
        )
    )
    icu_archive = asset_dir / f"liboliphaunt-wasix-{version}-icu-data.tar.zst"
    if not icu_archive.is_file():
        fail(f"missing WASIX ICU data release asset: {rel(icu_archive)}")
    icu_extract = extract_root / "icu-extracted"
    extract_tar_zstd(icu_archive, icu_extract)
    icu_root = canonical_icu_root(target_icu_root(icu_extract))
    validate_icu_payload(icu_root)
    icu_payload_root = write_icu_payload_archive(icu_root, extract_root / "icu-payload")
    specs.append(
        PackageSpec(
            name=ICU_PACKAGE,
            target="portable",
            kind="icu-data",
            template_dir=ROOT / "src/runtimes/liboliphaunt/icu",
            payload_root=icu_payload_root,
            payload_dir_name="payload",
        )
    )

    for target_id, package_name in sorted(AOT_PACKAGES.items()):
        archive = asset_dir / f"liboliphaunt-wasix-{version}-runtime-aot-{target_id}.tar.zst"
        if not archive.is_file():
            fail(f"missing WASIX AOT release asset: {rel(archive)}")
        extracted = extract_root / f"{target_id}-extracted"
        extract_tar_zstd(archive, extracted)
        triple = AOT_TARGET_TRIPLES[target_id]
        aot_root = target_aot_root(extracted, triple)
        validate_aot_payload(aot_root)
        aot_core_root, tools_aot_root = split_aot_tools_payload(aot_root, extract_root, target_id)
        specs.append(
            PackageSpec(
                name=package_name,
                target=triple,
                kind="wasix-aot",
                template_dir=ROOT / "src/runtimes/liboliphaunt/wasix/crates/aot" / triple,
                payload_root=aot_core_root,
                payload_dir_name="artifacts",
            )
        )
        specs.append(
            PackageSpec(
                name=TOOLS_AOT_PACKAGES[target_id],
                target=triple,
                kind="wasix-tools-aot",
                template_dir=ROOT / "src/runtimes/liboliphaunt/wasix/crates/tools-aot" / triple,
                payload_root=tools_aot_root,
                payload_dir_name="artifacts",
            )
        )
    return specs


def write_packages_manifest(packages: list[GeneratedPackage], output_dir: Path) -> None:
    data = {
        "schema": SCHEMA,
        "product": PRODUCT,
        "packages": [
            {
                "name": package.name,
                "target": package.target,
                "kind": package.kind,
                "role": "artifact",
                "manifestPath": rel(package.manifest_path),
                "cratePath": rel(package.crate_path),
                "size": package.size,
                "sha256": package.sha256,
            }
            for package in packages
        ],
    }
    (output_dir / "packages.json").write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--asset-dir",
        default="target/oliphaunt-wasix/release-assets",
        help="directory containing checked liboliphaunt-wasix release assets",
    )
    parser.add_argument(
        "--output-dir",
        default="target/oliphaunt-wasix/cargo-artifacts",
        help="directory where generated .crate files are written",
    )
    parser.add_argument("--version", default=product_metadata.read_current_version(PRODUCT))
    parser.add_argument(
        "--extension-artifact-root",
        action="append",
        default=["target/extension-artifacts"],
        help="directory containing staged exact-extension artifacts with WASIX archives",
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
    extension_roots = []
    for value in args.extension_artifact_root:
        path = Path(value)
        if not path.is_absolute():
            path = ROOT / path
        extension_roots.append(path)
    if not asset_dir.is_dir():
        fail(f"WASIX release asset directory does not exist: {rel(asset_dir)}")

    source_root = ROOT / "target/oliphaunt-wasix/cargo-package-sources"
    extract_root = ROOT / "target/oliphaunt-wasix/cargo-package-extracted"
    cargo_target_dir = ROOT / "target/oliphaunt-wasix/cargo-package-target"
    shutil.rmtree(source_root, ignore_errors=True)
    shutil.rmtree(extract_root, ignore_errors=True)
    shutil.rmtree(output_dir, ignore_errors=True)
    shutil.rmtree(cargo_target_dir, ignore_errors=True)
    source_root.mkdir(parents=True, exist_ok=True)
    extract_root.mkdir(parents=True, exist_ok=True)
    output_dir.mkdir(parents=True, exist_ok=True)

    extension_specs = extension_cargo_specs(extension_roots)
    validate_extension_aot_coverage(extension_specs)
    extension_sources = [
        write_extension_cargo_source(spec, source_root)
        for spec in extension_specs
    ]
    extension_aot_sources = [
        write_extension_aot_cargo_source(aot_spec, source_root)
        for spec in extension_specs
        for aot_spec in spec.aot_targets
    ]
    specs = package_specs(asset_dir, extract_root, args.version)
    packages = [
        *[
            package_extension_source(
                source,
                output_dir=output_dir,
                cargo_target_dir=cargo_target_dir,
            )
            for source in extension_sources
        ],
        *[
            package
            for source in extension_aot_sources
            for package in package_extension_aot_source(
                source,
                output_dir=output_dir,
                cargo_target_dir=cargo_target_dir,
            )
        ],
        *[
            package_spec(
                spec,
                version=args.version,
                source_root=source_root,
                output_dir=output_dir,
                cargo_target_dir=cargo_target_dir,
                extension_sources=extension_sources,
                extension_aot_sources=extension_aot_sources,
            )
            for spec in specs
        ],
    ]
    write_packages_manifest(packages, output_dir)
    print("generated liboliphaunt-wasix Cargo artifact crates:")
    for package in packages:
        print(f"{package.name} {rel(package.crate_path)} {package.size} bytes")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
