#!/usr/bin/env python3
"""Validate local oliphaunt-node-direct GitHub release assets."""

from __future__ import annotations

import argparse
import hashlib
import sys
import tarfile
import zipfile
from pathlib import Path
from typing import NoReturn

import artifact_targets
import product_metadata


ROOT = Path(__file__).resolve().parents[2]


def fail(message: str) -> NoReturn:
    print(f"check_node_direct_release_assets.py: {message}", file=sys.stderr)
    raise SystemExit(1)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def checksum_manifest(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    for index, raw_line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        line = raw_line.strip()
        if not line:
            continue
        parts = line.split(maxsplit=1)
        if len(parts) != 2 or len(parts[0]) != 64:
            fail(f"malformed checksum line {index}: {raw_line}")
        values[parts[1].removeprefix("./")] = parts[0].lower()
    return values


def expected_assets(version: str) -> list[str]:
    return artifact_targets.expected_assets("oliphaunt-node-direct", version, surface="github-release")


def expected_addon_assets(version: str) -> list[str]:
    return artifact_targets.expected_assets(
        "oliphaunt-node-direct",
        version,
        surface="github-release",
        kinds=["node-direct-addon"],
    )


def addon_targets_by_asset(version: str) -> dict[str, artifact_targets.ArtifactTarget]:
    return {
        target.asset_name(version): target
        for target in artifact_targets.artifact_targets(
            product="oliphaunt-node-direct",
            surface="github-release",
            published_only=True,
        )
        if target.kind == "node-direct-addon"
    }


def validate_tar_archive(path: Path, member_name: str) -> None:
    with tarfile.open(path, "r:gz") as archive:
        names = set(archive.getnames())
        if member_name not in names:
            fail(f"{path.name} is missing {member_name}")
        member = archive.getmember(member_name)
        if not member.isfile():
            fail(f"{path.name} {member_name} is not a regular file")
        if member.size == 0:
            fail(f"{path.name} {member_name} is empty")


def validate_zip_archive(path: Path, member_name: str) -> None:
    with zipfile.ZipFile(path) as archive:
        names = set(archive.namelist())
        if member_name not in names:
            fail(f"{path.name} is missing {member_name}")
        member = archive.getinfo(member_name)
        if member.is_dir():
            fail(f"{path.name} {member_name} is not a regular file")
        if member.file_size == 0:
            fail(f"{path.name} {member_name} is empty")


def validate_addon_archive(path: Path, target: artifact_targets.ArtifactTarget) -> None:
    member_name = target.library_relative_path
    if member_name is None:
        fail(f"{target.id} is missing library_relative_path")
    if path.name.endswith(".tar.gz"):
        validate_tar_archive(path, member_name)
    elif path.suffix == ".zip":
        validate_zip_archive(path, member_name)
    else:
        fail(f"{path.name} has unsupported Node direct archive extension")


def validate(asset_dir: Path, allow_partial: bool = False) -> None:
    version = product_metadata.read_current_version("oliphaunt-node-direct")
    required_assets = expected_assets(version)
    addon_targets = addon_targets_by_asset(version)
    missing = [asset for asset in required_assets if not (asset_dir / asset).is_file()]
    if missing:
        if not allow_partial:
            fail("missing oliphaunt-node-direct release asset(s): " + ", ".join(missing))
        present_addons = [asset for asset in expected_addon_assets(version) if (asset_dir / asset).is_file()]
        if not present_addons:
            fail("partial oliphaunt-node-direct release asset validation requires at least one addon asset")

    checksum_asset = asset_dir / f"oliphaunt-node-direct-{version}-release-assets.sha256"
    if not checksum_asset.is_file():
        fail(f"missing checksum manifest: {checksum_asset.name}")
    checksums = checksum_manifest(checksum_asset)
    for asset in required_assets:
        if allow_partial and not (asset_dir / asset).is_file():
            continue
        if asset == checksum_asset.name:
            continue
        expected_digest = checksums.get(asset)
        if expected_digest is None:
            fail(f"{checksum_asset.name} does not cover {asset}")
        actual = sha256(asset_dir / asset)
        if actual != expected_digest:
            fail(f"checksum mismatch for {asset}: expected {expected_digest}, got {actual}")
    for asset in expected_addon_assets(version):
        if allow_partial and not (asset_dir / asset).is_file():
            continue
        target = addon_targets.get(asset)
        if target is None:
            fail(f"no artifact target metadata found for {asset}")
        validate_addon_archive(asset_dir / asset, target)


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--asset-dir",
        default=str(ROOT / "target/oliphaunt-node-direct/release-assets"),
        help="directory containing oliphaunt-node-direct release assets",
    )
    parser.add_argument(
        "--allow-partial",
        action="store_true",
        help="validate the Node direct assets present in asset-dir without requiring every published target",
    )
    args = parser.parse_args(argv)
    validate(Path(args.asset_dir).resolve(), allow_partial=args.allow_partial)
    print(f"oliphaunt-node-direct release assets validated: {Path(args.asset_dir).resolve()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
