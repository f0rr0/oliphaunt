#!/usr/bin/env python3
"""Create small oliphaunt-broker release-shaped assets for SDK checks."""

from __future__ import annotations

import argparse
from pathlib import Path

from release_fixture_utils import write_checksum_manifest, write_tar_gz, write_zip


def broker_entries(target: str, executable: str) -> dict[str, bytes]:
    return {
        executable: b"#!/bin/sh\necho oliphaunt-broker release fixture\n",
        "manifest.properties": (
            b"schema=oliphaunt-broker-release-assets-v1\n"
            b"product=oliphaunt-broker\n"
            + f"target={target}\n".encode()
            + f"binary={executable}\n".encode()
        ),
    }


def write_fixture_assets(asset_dir: Path, version: str) -> None:
    asset_dir.mkdir(parents=True, exist_ok=True)
    executable_modes = {"bin/oliphaunt-broker": 0o755, "bin/oliphaunt-broker.exe": 0o755}

    for target in ["macos-arm64", "linux-x64-gnu", "linux-arm64-gnu"]:
        write_tar_gz(
            asset_dir / f"oliphaunt-broker-{version}-{target}.tar.gz",
            broker_entries(target, "bin/oliphaunt-broker"),
            executable_modes,
        )

    write_zip(
        asset_dir / f"oliphaunt-broker-{version}-windows-x64-msvc.zip",
        broker_entries("windows-x64-msvc", "bin/oliphaunt-broker.exe"),
        executable_modes,
    )
    write_checksum_manifest(asset_dir, f"oliphaunt-broker-{version}-release-assets.sha256")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--asset-dir", required=True, help="directory to write release-shaped assets into")
    parser.add_argument("--version", required=True, help="oliphaunt-broker version to encode in asset names")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    write_fixture_assets(Path(args.asset_dir).resolve(), args.version)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
