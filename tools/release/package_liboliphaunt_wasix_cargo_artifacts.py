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
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import NoReturn

import product_metadata


ROOT = Path(__file__).resolve().parents[2]
PRODUCT = "liboliphaunt-wasix"
SCHEMA = "oliphaunt-liboliphaunt-wasix-cargo-artifacts-v2"
CRATES_IO_MAX_BYTES = 10 * 1024 * 1024
RUNTIME_PACKAGE = "oliphaunt-wasix-assets"
ICU_PACKAGE = "oliphaunt-icu"
ICU_PAYLOAD_ARCHIVE = "icu-data.tar.zst"
AOT_PACKAGES = {
    "macos-arm64": "oliphaunt-wasix-aot-aarch64-apple-darwin",
    "linux-arm64-gnu": "oliphaunt-wasix-aot-aarch64-unknown-linux-gnu",
    "linux-x64-gnu": "oliphaunt-wasix-aot-x86_64-unknown-linux-gnu",
    "windows-x64-msvc": "oliphaunt-wasix-aot-x86_64-pc-windows-msvc",
}
AOT_TARGET_TRIPLES = {
    "macos-arm64": "aarch64-apple-darwin",
    "linux-arm64-gnu": "aarch64-unknown-linux-gnu",
    "linux-x64-gnu": "x86_64-unknown-linux-gnu",
    "windows-x64-msvc": "x86_64-pc-windows-msvc",
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
    for required in [
        "oliphaunt.wasix.tar.zst",
        "bin/initdb.wasix.wasm",
        "prepopulated/pgdata-template.tar.zst",
        "prepopulated/pgdata-template.json",
    ]:
        if not (root / required).is_file():
            fail(f"WASIX runtime Cargo payload is missing {required}")
    runtime_members = tar_zstd_members(root / "oliphaunt.wasix.tar.zst")
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


def rewrite_cargo_manifest(manifest: Path, *, package_name: str, version: str) -> None:
    text = manifest.read_text(encoding="utf-8")
    text = re.sub(r'(?m)^version = "[^"]+"$', f'version = "{version}"', text, count=1)
    text = re.sub(r'(?m)^publish = false\n?', "", text)
    if "\n[workspace]" not in text:
        text = text.rstrip() + "\n\n[workspace]\n"
    manifest.write_text(text, encoding="utf-8")
    package = cargo_metadata_package(manifest)
    if package["name"] != package_name or package["version"] != version:
        fail(
            f"{rel(manifest)} generated the wrong package metadata: "
            f"name={package['name']!r}, version={package['version']!r}"
        )


def copy_package_source(spec: PackageSpec, source_root: Path, version: str) -> Path:
    crate_dir = source_root / spec.name
    if crate_dir.exists():
        fail(f"duplicate generated WASIX Cargo package source: {rel(crate_dir)}")
    shutil.copytree(
        spec.template_dir,
        crate_dir,
        ignore=shutil.ignore_patterns("target", "payload", "artifacts"),
    )
    shutil.copytree(spec.payload_root, crate_dir / spec.payload_dir_name)
    rewrite_cargo_manifest(crate_dir / "Cargo.toml", package_name=spec.name, version=version)
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


def cargo_package(crate_dir: Path, target_dir: Path) -> Path:
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
    env = {**os.environ, "OLIPHAUNT_ARTIFACT_CRATE_REQUIRE_PAYLOAD": "1"}
    run(command, env=env)
    crate_path = target_dir / "package" / f"{name}-{version}.crate"
    if not crate_path.is_file():
        fail(f"cargo package did not create {rel(crate_path)}")
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
) -> GeneratedPackage:
    crate_dir = copy_package_source(spec, source_root, version)
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


def package_specs(asset_dir: Path, extract_root: Path, version: str) -> list[PackageSpec]:
    specs: list[PackageSpec] = []
    runtime_archive = asset_dir / f"liboliphaunt-wasix-{version}-runtime-portable.tar.zst"
    if not runtime_archive.is_file():
        fail(f"missing WASIX portable runtime release asset: {rel(runtime_archive)}")
    runtime_extract = extract_root / "runtime-extracted"
    extract_tar_zstd(runtime_archive, runtime_extract)
    runtime_root = target_asset_root(runtime_extract)
    validate_runtime_payload(runtime_root)
    specs.append(
        PackageSpec(
            name=RUNTIME_PACKAGE,
            target="portable",
            kind="wasix-runtime",
            template_dir=ROOT / "src/runtimes/liboliphaunt/wasix/crates/assets",
            payload_root=runtime_root,
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
        specs.append(
            PackageSpec(
                name=package_name,
                target=triple,
                kind="wasix-aot",
                template_dir=ROOT / "src/runtimes/liboliphaunt/wasix/crates/aot" / triple,
                payload_root=aot_root,
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

    specs = package_specs(asset_dir, extract_root, args.version)
    packages = [
        package_spec(
            spec,
            version=args.version,
            source_root=source_root,
            output_dir=output_dir,
            cargo_target_dir=cargo_target_dir,
        )
        for spec in specs
    ]
    write_packages_manifest(packages, output_dir)
    print("generated liboliphaunt-wasix Cargo artifact crates:")
    for package in packages:
        print(f"{package.name} {rel(package.crate_path)} {package.size} bytes")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
