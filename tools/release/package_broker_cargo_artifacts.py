#!/usr/bin/env python3
"""Package oliphaunt-broker helper binaries as Cargo artifact crates."""

from __future__ import annotations

import argparse
import hashlib
import os
import shutil
import subprocess
import sys
import tarfile
import zipfile
from pathlib import Path
from typing import NoReturn

import artifact_targets
import product_metadata


ROOT = Path(__file__).resolve().parents[2]
PRODUCT = "oliphaunt-broker"
KIND = "broker-helper"
SURFACE = "rust-broker"
CRATES_IO_MAX_BYTES = 10 * 1024 * 1024


def fail(message: str) -> NoReturn:
    print(f"package_broker_cargo_artifacts.py: {message}", file=sys.stderr)
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


def cargo_package_name(target_id: str) -> str:
    return f"oliphaunt-broker-{target_id}"


def cargo_links_name(target_id: str) -> str:
    return f"oliphaunt_artifact_broker_{target_id.replace('-', '_')}"


def source_crate_dir(target_id: str) -> Path:
    return ROOT / "src" / "runtimes" / "broker" / "crates" / target_id


def extract_member(archive_path: Path, member_name: str, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    if archive_path.name.endswith(".zip"):
        try:
            with zipfile.ZipFile(archive_path) as archive:
                if member_name not in archive.namelist():
                    fail(f"{rel(archive_path)} is missing {member_name}")
                destination.write_bytes(archive.read(member_name))
        except zipfile.BadZipFile as error:
            fail(f"{rel(archive_path)} is not a readable zip archive: {error}")
        return

    try:
        with tarfile.open(archive_path, "r:*") as archive:
            member = archive.getmember(member_name)
            if not member.isfile():
                fail(f"{rel(archive_path)} member {member_name} must be a regular file")
            extracted = archive.extractfile(member)
            if extracted is None:
                fail(f"{rel(archive_path)} member {member_name} could not be read")
            with extracted:
                destination.write_bytes(extracted.read())
            destination.chmod(member.mode & 0o777)
    except KeyError:
        fail(f"{rel(archive_path)} is missing {member_name}")
    except tarfile.TarError as error:
        fail(f"{rel(archive_path)} is not a readable tar archive: {error}")

def copy_source_crate(target: artifact_targets.ArtifactTarget, crate_dir: Path, version: str) -> None:
    source_dir = source_crate_dir(target.target)
    if not source_dir.is_dir():
        fail(f"{target.id} source Cargo artifact crate is missing: {rel(source_dir)}")
    shutil.copytree(source_dir, crate_dir)
    cargo_toml = (crate_dir / "Cargo.toml").read_text(encoding="utf-8")
    expected_name = cargo_package_name(target.target)
    expected_links = cargo_links_name(target.target)
    for required in [
        f'name = "{expected_name}"',
        f'version = "{version}"',
        f'links = "{expected_links}"',
        'build = "build.rs"',
        '"payload/**"',
    ]:
        if required not in cargo_toml:
            fail(f"{rel(source_dir / 'Cargo.toml')} is missing {required!r}")
    lib_rs = (crate_dir / "src" / "lib.rs").read_text(encoding="utf-8")
    for required in [
        f'RELEASE_TARGET: &str = "{target.target}"',
        f'CARGO_TARGET: &str = "{target.triple}"',
        f'EXECUTABLE_RELATIVE_PATH: &str = "{target.executable_relative_path}"',
    ]:
        if required not in lib_rs:
            fail(f"{rel(source_dir / 'src/lib.rs')} is missing {required!r}")


def validate_crate(crate_path: Path, package_name: str, version: str, payload_member: str) -> None:
    if not crate_path.is_file():
        fail(f"missing generated Cargo crate {rel(crate_path)}")
    size = crate_path.stat().st_size
    if size > CRATES_IO_MAX_BYTES:
        fail(f"{rel(crate_path)} is {size} bytes, above the crates.io 10 MiB package limit")
    expected = {
        f"{package_name}-{version}/Cargo.toml",
        f"{package_name}-{version}/README.md",
        f"{package_name}-{version}/build.rs",
        f"{package_name}-{version}/src/lib.rs",
        f"{package_name}-{version}/payload/sha256",
        f"{package_name}-{version}/payload/{payload_member}",
    }
    try:
        with tarfile.open(crate_path, "r:gz") as archive:
            names = set(archive.getnames())
    except tarfile.TarError as error:
        fail(f"{rel(crate_path)} is not a readable .crate archive: {error}")
    missing = sorted(expected - names)
    if missing:
        fail(f"{rel(crate_path)} is missing package members: {', '.join(missing)}")


def package_target(
    target: artifact_targets.ArtifactTarget,
    *,
    version: str,
    asset_dir: Path,
    source_root: Path,
    output_dir: Path,
    cargo_target_dir: Path,
) -> Path:
    if target.triple is None:
        fail(f"{target.id} must declare a Cargo target triple")
    if target.executable_relative_path is None:
        fail(f"{target.id} must declare executable_relative_path")
    package_name = cargo_package_name(target.target)
    crate_dir = source_root / package_name
    copy_source_crate(target, crate_dir, version)
    archive = asset_dir / target.asset_name(version)
    payload = crate_dir / "payload" / target.executable_relative_path
    extract_member(archive, target.executable_relative_path, payload)
    if payload.stat().st_size <= 0:
        fail(f"{rel(payload)} must be a non-empty broker helper payload")
    payload.chmod(0o755)
    payload_sha256 = sha256_file(payload)
    (crate_dir / "payload" / "sha256").write_text(payload_sha256 + "\n", encoding="utf-8")
    env = {**os.environ, "OLIPHAUNT_ARTIFACT_CRATE_REQUIRE_PAYLOAD": "1"}
    run(
        [
            "cargo",
            "package",
            "--manifest-path",
            str(crate_dir / "Cargo.toml"),
            "--target-dir",
            str(cargo_target_dir),
            "--allow-dirty",
        ],
        env=env,
    )
    packaged = cargo_target_dir / "package" / f"{package_name}-{version}.crate"
    output = output_dir / packaged.name
    shutil.copy2(packaged, output)
    validate_crate(output, package_name, version, target.executable_relative_path)
    return output


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--asset-dir",
        default="target/oliphaunt-broker/release-assets",
        help="directory containing checked oliphaunt-broker release assets",
    )
    parser.add_argument(
        "--output-dir",
        default="target/oliphaunt-broker/cargo-artifacts",
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
        fail(f"broker release asset directory does not exist: {rel(asset_dir)}")
    source_root = ROOT / "target" / "oliphaunt-broker" / "cargo-package-sources"
    cargo_target_dir = ROOT / "target" / "oliphaunt-broker" / "cargo-package-target"
    shutil.rmtree(source_root, ignore_errors=True)
    shutil.rmtree(output_dir, ignore_errors=True)
    shutil.rmtree(cargo_target_dir, ignore_errors=True)
    source_root.mkdir(parents=True, exist_ok=True)
    output_dir.mkdir(parents=True, exist_ok=True)

    outputs = []
    targets = artifact_targets.artifact_targets(
        product=PRODUCT,
        kind=KIND,
        surface=SURFACE,
        published_only=True,
    )
    for target in targets:
        outputs.append(
            package_target(
                target,
                version=args.version,
                asset_dir=asset_dir,
                source_root=source_root,
                output_dir=output_dir,
                cargo_target_dir=cargo_target_dir,
            )
        )
    print("generated broker Cargo artifact crates:")
    for path in outputs:
        print(rel(path))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
