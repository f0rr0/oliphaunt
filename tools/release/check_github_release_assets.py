#!/usr/bin/env python3
"""Verify product-scoped GitHub release assets."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import sys
import urllib.error
import urllib.parse
import urllib.request
from typing import NoReturn

import artifact_targets
import extension_artifact_targets
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
        return expected_extension_assets(product, version)
    return artifact_targets.expected_assets(product, version, surface="github-release")


def expected_extension_assets(product: str, version: str) -> list[str]:
    release_asset_root = Path("target") / "extension-artifacts" / product / "release-assets"
    manifest_path = release_asset_root / f"{product}-{version}-manifest.json"
    if not manifest_path.is_file():
        fail(
            f"{product} exact-extension release verification requires staged public release manifest "
            f"{manifest_path}; download the CI workflow oliphaunt-extension-package-artifacts artifact first"
        )
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    expected = {
        "schema": "oliphaunt-extension-release-manifest-v1",
        "product": product,
        "version": version,
    }
    for key, value in expected.items():
        if manifest.get(key) != value:
            fail(f"{manifest_path} has {key}={manifest.get(key)!r}, expected {value!r}")
    actual_keys = set(manifest)
    expected_keys = product_metadata.PUBLIC_EXTENSION_RELEASE_MANIFEST_KEYS
    if actual_keys != expected_keys:
        fail(f"{manifest_path} public manifest keys must be {sorted(expected_keys)}, got {sorted(actual_keys)}")
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
        actual_asset_keys = set(asset)
        expected_asset_keys = product_metadata.PUBLIC_EXTENSION_RELEASE_ASSET_KEYS
        if actual_asset_keys != expected_asset_keys:
            fail(
                f"{manifest_path} assets[{index}] keys must be "
                f"{sorted(expected_asset_keys)}, got {sorted(actual_asset_keys)}"
            )
        names.append(name)
    if not names:
        fail(f"{manifest_path} does not declare any release assets")
    names.extend(
        [
            f"{product}-{version}-manifest.json",
            f"{product}-{version}-manifest.properties",
            f"{product}-{version}-release-assets.sha256",
        ]
    )
    return sorted(set(names))


def request_bytes(url: str) -> bytes:
    headers = {
        "Accept": "application/octet-stream",
        "User-Agent": "oliphaunt-release-check",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    token = os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN")
    if token:
        headers["Authorization"] = f"Bearer {token}"
    request = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            return response.read()
    except urllib.error.HTTPError as error:
        fail(f"GitHub asset download returned HTTP {error.code} for {url}")
    except urllib.error.URLError as error:
        fail(f"failed to download GitHub asset {url}: {error}")


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def parse_checksum_manifest(data: bytes, context: str) -> dict[str, str]:
    checksums: dict[str, str] = {}
    text = data.decode("utf-8")
    for line_number, raw_line in enumerate(text.splitlines(), start=1):
        line = raw_line.strip()
        if not line:
            continue
        parts = line.split(None, 1)
        if len(parts) != 2:
            fail(f"{context}:{line_number} must contain '<sha256> ./<asset>'")
        sha, name = parts
        if len(sha) != 64 or any(char not in "0123456789abcdef" for char in sha):
            fail(f"{context}:{line_number} has invalid sha256 {sha!r}")
        if not name.startswith("./") or "/" in name[2:]:
            fail(f"{context}:{line_number} must reference a direct asset path like ./name")
        asset_name = name[2:]
        if asset_name in checksums:
            fail(f"{context} declares duplicate checksum entry for {asset_name}")
        checksums[asset_name] = sha
    return checksums


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


def release_assets(repo: str, tag: str) -> dict[str, dict]:
    repo_path = urllib.parse.quote(repo, safe="/")
    tag_path = urllib.parse.quote(tag, safe="")
    url = f"{GITHUB_API.rstrip('/')}/repos/{repo_path}/releases/tags/{tag_path}"
    data = github_json(url)
    if not isinstance(data, dict):
        fail(f"GitHub release response for {tag} was not an object")
    assets = data.get("assets")
    if not isinstance(assets, list):
        fail(f"GitHub release response for {tag} did not include assets")
    parsed: dict[str, dict] = {}
    for asset in assets:
        if not isinstance(asset, dict) or not isinstance(asset.get("name"), str):
            continue
        name = asset["name"]
        if name in parsed:
            fail(f"GitHub release {tag} declares duplicate asset {name}")
        parsed[name] = asset
    return parsed


def release_asset_names(repo: str, tag: str) -> list[str]:
    return sorted(release_assets(repo, tag))


def download_asset(asset: dict, name: str) -> bytes:
    url = asset.get("url")
    if not isinstance(url, str) or not url:
        fail(f"GitHub release asset {name} did not include an API download URL")
    return request_bytes(url)


def extension_artifact_kind_allowed(family: str, target: str, kind: str) -> bool:
    if family == "wasix":
        return target == "wasix-portable" and kind == "wasix-runtime"
    if family != "native":
        return False
    if target == "ios-xcframework":
        return kind in {"runtime", "ios-xcframework"}
    if target.startswith("android-"):
        return kind in {"runtime", "android-static-archive"}
    return kind == "runtime"


def validate_extension_public_manifest(product: str, version: str, manifest: object) -> list[dict]:
    if not isinstance(manifest, dict):
        fail(f"{product} {version} public extension manifest must be a JSON object")
    expected = {
        "schema": "oliphaunt-extension-release-manifest-v1",
        "product": product,
        "version": version,
    }
    for key, value in expected.items():
        if manifest.get(key) != value:
            fail(f"{product} {version} public extension manifest has {key}={manifest.get(key)!r}, expected {value!r}")
    actual_keys = set(manifest)
    expected_keys = product_metadata.PUBLIC_EXTENSION_RELEASE_MANIFEST_KEYS
    if actual_keys != expected_keys:
        fail(
            f"{product} {version} public extension manifest keys must be "
            f"{sorted(expected_keys)}, got {sorted(actual_keys)}"
        )

    rows = manifest.get("assets")
    if not isinstance(rows, list) or not rows:
        fail(f"{product} {version} public extension manifest must declare assets")

    seen_names: set[str] = set()
    staged_targets_by_family: dict[str, set[str]] = {"native": set(), "wasix": set()}
    parsed_assets: list[dict] = []
    for index, asset in enumerate(rows):
        if not isinstance(asset, dict):
            fail(f"{product} {version} public extension manifest assets[{index}] must be an object")
        actual_asset_keys = set(asset)
        expected_asset_keys = product_metadata.PUBLIC_EXTENSION_RELEASE_ASSET_KEYS
        if actual_asset_keys != expected_asset_keys:
            fail(
                f"{product} {version} public extension manifest assets[{index}] keys must be "
                f"{sorted(expected_asset_keys)}, got {sorted(actual_asset_keys)}"
            )
        name = asset.get("name")
        family = asset.get("family")
        target = asset.get("target")
        kind = asset.get("kind")
        sha = asset.get("sha256")
        size = asset.get("bytes")
        if not all(isinstance(value, str) and value for value in (name, family, target, kind, sha)):
            fail(f"{product} {version} public extension manifest contains an incomplete asset row: {asset!r}")
        if not isinstance(size, int) or size <= 0:
            fail(f"{product} {version} public extension manifest asset {name} must declare positive bytes")
        if len(sha) != 64 or any(char not in "0123456789abcdef" for char in sha):
            fail(f"{product} {version} public extension manifest asset {name} has invalid sha256 {sha!r}")
        if name in seen_names:
            fail(f"{product} {version} public extension manifest declares duplicate asset {name}")
        seen_names.add(name)
        if not extension_artifact_kind_allowed(family, target, kind):
            fail(
                f"{product} {version} public extension manifest asset {name} has invalid "
                f"family={family!r} target={target!r} kind={kind!r}"
            )
        staged_targets_by_family.setdefault(family, set()).add(target)
        parsed_assets.append(asset)

    declared_native_targets = {
        target.target
        for target in extension_artifact_targets.artifact_targets(
            product=product,
            family="native",
            published_only=True,
        )
    }
    declared_wasix_targets = {
        target.target
        for target in extension_artifact_targets.artifact_targets(
            product=product,
            family="wasix",
            published_only=True,
        )
    }
    if staged_targets_by_family["native"] != declared_native_targets:
        fail(
            f"{product} {version} public extension manifest native targets must match published targets: "
            f"{sorted(staged_targets_by_family['native'])} vs {sorted(declared_native_targets)}"
        )
    if staged_targets_by_family["wasix"] != declared_wasix_targets:
        fail(
            f"{product} {version} public extension manifest WASIX targets must match published targets: "
            f"{sorted(staged_targets_by_family['wasix'])} vs {sorted(declared_wasix_targets)}"
        )
    return parsed_assets


def verify_extension_release_assets(
    product: str,
    version: str,
    expected_names: set[str],
    actual_assets: dict[str, dict],
) -> None:
    actual_names = set(actual_assets)
    unexpected = sorted(actual_names - expected_names)
    if unexpected:
        fail(
            f"{product} GitHub release {product_tag(product, version)} has unexpected exact-extension asset(s): "
            + ", ".join(unexpected)
        )

    manifest_name = f"{product}-{version}-manifest.json"
    properties_name = f"{product}-{version}-manifest.properties"
    checksum_name = f"{product}-{version}-release-assets.sha256"
    local_manifest_path = Path("target") / "extension-artifacts" / product / "release-assets" / manifest_name
    local_manifest = json.loads(local_manifest_path.read_text(encoding="utf-8"))

    downloaded: dict[str, bytes] = {}
    manifest_bytes = download_asset(actual_assets[manifest_name], manifest_name)
    downloaded[manifest_name] = manifest_bytes
    remote_manifest = json.loads(manifest_bytes.decode("utf-8"))
    if remote_manifest != local_manifest:
        fail(f"{product} GitHub release {product_tag(product, version)} public manifest differs from staged manifest")
    public_assets = validate_extension_public_manifest(product, version, remote_manifest)

    checksum_bytes = download_asset(actual_assets[checksum_name], checksum_name)
    downloaded[checksum_name] = checksum_bytes
    checksums = parse_checksum_manifest(checksum_bytes, checksum_name)
    checksum_covered_names = {asset["name"] for asset in public_assets}
    checksum_covered_names.add(manifest_name)
    checksum_covered_names.add(properties_name)
    if set(checksums) != checksum_covered_names:
        fail(
            f"{product} GitHub release {product_tag(product, version)} checksum manifest must cover "
            "release assets exactly: "
            f"{sorted(checksums)} vs {sorted(checksum_covered_names)}"
        )

    for name in sorted(checksum_covered_names):
        if name not in actual_assets:
            fail(f"{product} GitHub release {product_tag(product, version)} is missing checksum-covered asset {name}")
        data = downloaded.get(name)
        if data is None:
            data = download_asset(actual_assets[name], name)
            downloaded[name] = data
        expected_sha = checksums[name]
        actual_sha = sha256_bytes(data)
        if actual_sha != expected_sha:
            fail(f"{product} GitHub release {product_tag(product, version)} asset {name} checksum mismatch")
        remote_size = actual_assets[name].get("size")
        if isinstance(remote_size, int) and remote_size != len(data):
            fail(
                f"{product} GitHub release {product_tag(product, version)} asset {name} size "
                f"{remote_size} from GitHub metadata does not match downloaded bytes {len(data)}"
            )

    for asset in public_assets:
        name = asset["name"]
        data = downloaded[name]
        if len(data) != asset["bytes"]:
            fail(f"{product} GitHub release {product_tag(product, version)} asset {name} byte size mismatch")
        actual_sha = sha256_bytes(data)
        if actual_sha != asset["sha256"]:
            fail(
                f"{product} GitHub release {product_tag(product, version)} asset {name} "
                "public manifest checksum mismatch"
            )


def verify(product: str, version: str, assets: list[str]) -> None:
    repo = repository()
    tag = product_tag(product, version)
    actual_assets = release_assets(repo, tag)
    expected_names = set(assets)
    missing = sorted(expected_names - set(actual_assets))
    if missing:
        fail(
            f"{product} GitHub release {tag} is missing required asset(s): "
            + ", ".join(missing)
        )
    if product_metadata.product_config(product).get("kind") == "exact-extension-artifact":
        verify_extension_release_assets(product, version, expected_names, actual_assets)
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
