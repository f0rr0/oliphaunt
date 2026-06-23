#!/usr/bin/env python3
"""Upload assets to a product-scoped GitHub release created by release-please."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path
from tempfile import TemporaryDirectory
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


def gh_json(args: list[str]) -> object:
    output = subprocess.check_output(["gh", *args, "--json", "assets"], cwd=ROOT, text=True)
    return json.loads(output)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def release_asset_names(tag: str, repo: str) -> set[str]:
    data = gh_json(["release", "view", tag, "--repo", repo])
    if not isinstance(data, dict) or not isinstance(data.get("assets"), list):
        fail(f"GitHub release {tag} returned malformed asset metadata")
    return {
        asset["name"]
        for asset in data["assets"]
        if isinstance(asset, dict) and isinstance(asset.get("name"), str)
    }


def download_release_asset(tag: str, repo: str, asset_name: str, destination: Path) -> Path:
    run_gh(["release", "download", tag, "--pattern", asset_name, "--dir", str(destination), "--repo", repo])
    path = destination / asset_name
    if not path.is_file():
        fail(f"failed to download existing GitHub release asset {asset_name}")
    return path


def upload_release_assets(
    product: str,
    tag: str,
    repo: str,
    assets: list[str],
) -> None:
    if not release_exists(tag, repo):
        fail(
            f"{product} GitHub release {tag} does not exist. "
            "Run release-please before package-native publish steps."
        )
    if assets:
        seen_names: set[str] = set()
        upload_assets: list[str] = []
        existing_names = release_asset_names(tag, repo)
        with TemporaryDirectory(prefix="oliphaunt-release-assets-") as tmp:
            tmpdir = Path(tmp)
            for asset in assets:
                asset_path = ROOT / asset
                if not asset_path.is_file():
                    asset_path = Path(asset)
                if not asset_path.is_file():
                    fail(f"release asset does not exist: {asset}")
                asset_name = asset_path.name
                if asset_name in seen_names:
                    fail(f"duplicate release asset name in upload set: {asset_name}")
                seen_names.add(asset_name)
                if asset_name not in existing_names:
                    upload_assets.append(asset)
                    continue
                existing = download_release_asset(tag, repo, asset_name, tmpdir)
                local_sha = sha256(asset_path)
                remote_sha = sha256(existing)
                if local_sha == remote_sha:
                    print(f"{product} GitHub release {tag} already has identical asset {asset_name}; skipping.")
                    continue
                fail(
                    f"{product} GitHub release {tag} already has different bytes for {asset_name}; "
                    "delete the conflicting GitHub release asset manually before rerunning an intentional repair"
                )
        if upload_assets:
            run_gh(["release", "upload", tag, *upload_assets, "--repo", repo])
        else:
            print(f"{product} GitHub release {tag} already has all requested assets with matching checksums.")
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
