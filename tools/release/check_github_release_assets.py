#!/usr/bin/env python3
"""Verify product-scoped GitHub release assets are present."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import sys
import urllib.error
import urllib.parse
import urllib.request
from typing import NoReturn

import artifact_targets
import product_metadata


GITHUB_API = os.environ.get("GITHUB_API", "https://api.github.com")


def fail(message: str) -> NoReturn:
    print(f"check_github_release_assets.py: {message}", file=sys.stderr)
    raise SystemExit(1)


def repository() -> str:
    repo = os.environ.get("GITHUB_REPOSITORY")
    if repo:
        return repo
    graph = product_metadata.load_graph()
    policy = graph.get("policy")
    if isinstance(policy, dict) and isinstance(policy.get("repository"), str):
        return policy["repository"]
    fail("GITHUB_REPOSITORY is not set and release metadata has no policy.repository")


def product_tag(product: str, version: str) -> str:
    return f"{product_metadata.tag_prefix(product)}{version}"


def expected_assets(product: str, version: str) -> list[str]:
    config = product_metadata.product_config(product)
    if config.get("kind") == "exact-extension-artifact":
        return expected_extension_assets(product)
    return artifact_targets.expected_assets(product, version, surface="github-release")


def expected_extension_assets(product: str) -> list[str]:
    manifest_path = Path("target") / "extension-artifacts" / product / "extension-artifacts.json"
    if not manifest_path.is_file():
        fail(
            f"{product} exact-extension release verification requires staged package manifest "
            f"{manifest_path}; download the Builds workflow oliphaunt-extension-package-artifacts artifact first"
        )
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    assets = manifest.get("assets")
    if not isinstance(assets, list):
        fail(f"{manifest_path} must contain an assets array")
    names: list[str] = []
    for index, asset in enumerate(assets):
        if not isinstance(asset, dict):
            fail(f"{manifest_path} assets[{index}] must be an object")
        name = asset.get("name")
        if not isinstance(name, str) or not name:
            fail(f"{manifest_path} assets[{index}] must declare name")
        names.append(name)
    if not names:
        fail(f"{manifest_path} does not declare any release assets")
    version = product_metadata.read_current_version(product)
    names.extend(
        [
            f"{product}-{version}-manifest.json",
            f"{product}-{version}-manifest.properties",
            f"{product}-{version}-release-assets.sha256",
        ]
    )
    return sorted(set(names))


def github_json(url: str) -> object:
    headers = {
        "Accept": "application/vnd.github+json",
        "User-Agent": "oliphaunt-release-check",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    token = os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN")
    if token:
        headers["Authorization"] = f"Bearer {token}"
    request = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        if error.code == 404:
            fail(f"GitHub release not found for URL {url}")
        fail(f"GitHub API returned HTTP {error.code} for {url}")
    except urllib.error.URLError as error:
        fail(f"failed to query GitHub release URL {url}: {error}")


def release_asset_names(repo: str, tag: str) -> list[str]:
    repo_path = urllib.parse.quote(repo, safe="/")
    tag_path = urllib.parse.quote(tag, safe="")
    url = f"{GITHUB_API.rstrip('/')}/repos/{repo_path}/releases/tags/{tag_path}"
    data = github_json(url)
    if not isinstance(data, dict):
        fail(f"GitHub release response for {tag} was not an object")
    assets = data.get("assets")
    if not isinstance(assets, list):
        fail(f"GitHub release response for {tag} did not include assets")
    names = []
    for asset in assets:
        if isinstance(asset, dict) and isinstance(asset.get("name"), str):
            names.append(asset["name"])
    return sorted(names)


def verify(product: str, version: str, assets: list[str]) -> None:
    repo = repository()
    tag = product_tag(product, version)
    actual = release_asset_names(repo, tag)
    missing = sorted(set(assets) - set(actual))
    if missing:
        fail(
            f"{product} GitHub release {tag} is missing required asset(s): "
            + ", ".join(missing)
        )
    print(f"{product} GitHub release assets verified for {tag}: {', '.join(assets)}")


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("product", help="release product id")
    parser.add_argument(
        "--version",
        help="product version to check; defaults to the current product version",
    )
    parser.add_argument(
        "--asset",
        action="append",
        default=[],
        help="required asset name; may be passed more than once",
    )
    parser.add_argument(
        "--default-assets",
        action="store_true",
        help="check the product's default release asset set",
    )
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    version = args.version or product_metadata.read_current_version(args.product)
    assets = list(args.asset)
    if args.default_assets:
        assets.extend(expected_assets(args.product, version))
    if not assets:
        fail("pass --default-assets or at least one --asset")
    verify(args.product, version, sorted(set(assets)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
