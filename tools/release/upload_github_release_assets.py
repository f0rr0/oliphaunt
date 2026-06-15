#!/usr/bin/env python3
"""Upload assets to a product-scoped GitHub release created by release-please."""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
from pathlib import Path
from typing import NoReturn

import product_metadata


ROOT = Path(__file__).resolve().parents[2]


def fail(message: str) -> NoReturn:
    print(f"upload_github_release_assets.py: {message}", file=sys.stderr)
    raise SystemExit(1)


def default_tag(product: str) -> str:
    prefix = product_metadata.tag_prefix(product)
    return f"{prefix}{product_metadata.read_current_version(product)}"


def release_exists(tag: str, repo: str) -> bool:
    result = subprocess.run(
        ["gh", "release", "view", tag, "--repo", repo],
        cwd=ROOT,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=False,
    )
    return result.returncode == 0


def run_gh(args: list[str]) -> None:
    subprocess.run(["gh", *args], cwd=ROOT, check=True)


def upload_release_assets(product: str, tag: str, repo: str, assets: list[str]) -> None:
    if not release_exists(tag, repo):
        fail(
            f"{product} GitHub release {tag} does not exist. "
            "Run release-please before package-native publish steps."
        )
    if assets:
        run_gh(["release", "upload", tag, *assets, "--clobber", "--repo", repo])
    else:
        print(f"{product} GitHub release {tag} exists; no assets to upload.")


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("product", help="release product id")
    parser.add_argument("--tag", help="release tag; defaults to the product tag prefix plus current version")
    parser.add_argument(
        "--repo",
        default=os.environ.get("GITHUB_REPOSITORY", ""),
        help="GitHub repository in owner/name form",
    )
    parser.add_argument(
        "--asset",
        action="append",
        default=[],
        help="asset file to upload; may be passed more than once",
    )
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    if not args.repo:
        fail("--repo or GITHUB_REPOSITORY is required")
    assets = [str(Path(asset)) for asset in args.asset]
    for asset in assets:
        if not (ROOT / asset).is_file() and not Path(asset).is_file():
            fail(f"release asset does not exist: {asset}")
    upload_release_assets(
        product=args.product,
        tag=args.tag or default_tag(args.product),
        repo=args.repo,
        assets=assets,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
