#!/usr/bin/env python3
"""Write a deterministic sha256 manifest for release assets."""

from __future__ import annotations

import argparse
import hashlib
from pathlib import Path


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def matching_assets(asset_dir: Path, patterns: list[str]) -> list[Path]:
    assets: dict[str, Path] = {}
    for pattern in patterns:
        for path in asset_dir.glob(pattern):
            if path.is_file():
                assets[path.name] = path
    return [assets[name] for name in sorted(assets)]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--asset-dir", required=True, help="directory containing assets")
    parser.add_argument("--output", required=True, help="checksum manifest file name")
    parser.add_argument(
        "--pattern",
        action="append",
        required=True,
        help="glob pattern, relative to asset-dir; may be passed more than once",
    )
    args = parser.parse_args()

    asset_dir = Path(args.asset_dir).resolve()
    output = asset_dir / args.output
    assets = matching_assets(asset_dir, args.pattern)
    with output.open("w", encoding="utf-8", newline="\n") as handle:
        for asset in assets:
            if asset == output:
                continue
            handle.write(f"{sha256(asset)}  {asset.name}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
