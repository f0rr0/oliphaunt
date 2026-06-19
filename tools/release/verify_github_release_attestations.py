#!/usr/bin/env python3
"""Verify GitHub artifact attestations for asset-backed product releases."""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import NoReturn

import check_github_release_assets
import product_metadata


BASE_ASSET_BACKED_PRODUCTS = {
    "liboliphaunt-native",
    "liboliphaunt-wasix",
    "oliphaunt-broker",
    "oliphaunt-node-direct",
}


def asset_backed_products() -> set[str]:
    products = set(BASE_ASSET_BACKED_PRODUCTS)
    for product in product_metadata.product_ids():
        if product_metadata.product_config(product).get("kind") == "exact-extension-artifact":
            products.add(product)
    return products


def fail(message: str) -> NoReturn:
    print(f"verify_github_release_attestations.py: {message}", file=sys.stderr)
    raise SystemExit(1)


def parse_products(value: str | None) -> list[str]:
    if not value:
        return sorted(asset_backed_products())
    parsed = json.loads(value)
    if not isinstance(parsed, list) or not all(isinstance(item, str) for item in parsed):
        fail("--products-json must be a JSON string array")
    return [product for product in parsed if product in asset_backed_products()]


def run(args: list[str], *, cwd: Path | None = None) -> None:
    print("\n==> " + " ".join(args), flush=True)
    subprocess.run(args, cwd=cwd, check=True)


def verify_product(product: str, destination: Path) -> None:
    version = product_metadata.read_current_version(product)
    tag = check_github_release_assets.product_tag(product, version)
    repo = check_github_release_assets.repository()
    signer_workflow = f"{repo}/.github/workflows/release.yml"
    assets = check_github_release_assets.expected_assets(product, version)
    check_github_release_assets.verify(product, version, assets)
    product_dir = destination / product
    product_dir.mkdir(parents=True, exist_ok=True)
    for asset in assets:
        run(["gh", "release", "download", tag, "--repo", repo, "--pattern", asset, "--dir", str(product_dir)])
        run(
            [
                "gh",
                "attestation",
                "verify",
                str(product_dir / asset),
                "--repo",
                repo,
                "--signer-workflow",
                signer_workflow,
                "--source-ref",
                "refs/heads/main",
                "--deny-self-hosted-runners",
            ]
        )
    print(f"{product} GitHub release attestations verified for {tag}")


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--product", action="append", default=[], help="product id to verify")
    parser.add_argument("--products-json", help="JSON product id array from the release plan")
    parser.add_argument("--head-ref", help="accepted for release.py passthrough; not used")
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    if shutil.which("gh") is None:
        fail("gh CLI is required to verify GitHub release attestations")
    products = args.product or parse_products(args.products_json)
    unknown = sorted(set(products) - asset_backed_products())
    if unknown:
        fail("attestation verification is only defined for asset-backed products: " + ", ".join(unknown))
    if not products:
        print("no asset-backed products selected; GitHub attestation verification skipped")
        return 0
    with tempfile.TemporaryDirectory(prefix="oliphaunt-release-attestations.") as tmp:
        destination = Path(tmp)
        for product in products:
            verify_product(product, destination)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
