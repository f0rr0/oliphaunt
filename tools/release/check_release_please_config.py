#!/usr/bin/env python3
"""Validate release-please manifest-mode configuration.

This is a transition guard while release-please becomes the version, changelog,
and tag owner. It checks the standard release-please files against current
product versions without re-implementing release planning.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any, NoReturn

import product_metadata


ROOT = Path(__file__).resolve().parents[2]
CONFIG_PATH = ROOT / "release-please-config.json"
MANIFEST_PATH = ROOT / ".release-please-manifest.json"


def fail(message: str) -> NoReturn:
    print(f"check_release_please_config.py: {message}", file=sys.stderr)
    raise SystemExit(2)


def rel(path: Path) -> str:
    return path.relative_to(ROOT).as_posix()


def read_json(path: Path) -> dict[str, Any]:
    if not path.is_file():
        fail(f"missing {rel(path)}")
    with path.open(encoding="utf-8") as handle:
        value = json.load(handle)
    if not isinstance(value, dict):
        fail(f"{rel(path)} must contain a JSON object")
    return value


def require_file(path: Path, context: str) -> None:
    if not path.is_file():
        fail(f"{context} references missing file {rel(path)}")


def reject_unsafe_relative_path(value: str, context: str) -> None:
    parts = Path(value).parts
    if Path(value).is_absolute() or ".." in parts:
        fail(f"{context} must stay inside its release-please package path: {value!r}")


def package_version_file(package_path: str, package_config: dict[str, Any]) -> Path | None:
    version_file = package_config.get("version-file")
    if version_file is None:
        return None
    if not isinstance(version_file, str) or not version_file:
        fail(f"{package_path}.version-file must be a non-empty string")
    return ROOT / package_path / version_file


def read_raw_version(path: Path) -> str:
    require_file(path, "release-please version-file")
    return path.read_text(encoding="utf-8").strip()


def validate_extra_files(package_path: str, package_config: dict[str, Any]) -> None:
    extra_files = package_config.get("extra-files", [])
    if not isinstance(extra_files, list):
        fail(f"{package_path}.extra-files must be a list")
    for index, entry in enumerate(extra_files):
        context = f"{package_path}.extra-files[{index}]"
        if isinstance(entry, str):
            reject_unsafe_relative_path(entry, context)
            require_file(ROOT / package_path / entry, context)
            continue
        if not isinstance(entry, dict):
            fail(f"{context} must be a path string or object")
        path = entry.get("path")
        if not isinstance(path, str) or not path:
            fail(f"{context}.path must be a non-empty string")
        reject_unsafe_relative_path(path, f"{context}.path")
        require_file(ROOT / package_path / path, context)
        entry_type = entry.get("type")
        if entry_type in {"json", "toml", "yaml"} and not isinstance(entry.get("jsonpath"), str):
            fail(f"{context} type {entry_type!r} requires jsonpath")
        if entry_type == "xml" and not isinstance(entry.get("xpath"), str):
            fail(f"{context} type 'xml' requires xpath")


def main() -> int:
    config = read_json(CONFIG_PATH)
    manifest = read_json(MANIFEST_PATH)
    packages = config.get("packages")
    if not isinstance(packages, dict) or not packages:
        fail("release-please-config.json must define non-empty packages")

    products = product_metadata.graph_products()
    paths_by_id = {product: product_metadata.package_path(product) for product in products}
    expected_paths = {paths_by_id[product] for product in products}
    actual_paths = set(packages)
    if actual_paths != expected_paths:
        fail(
            "release-please packages must match release products:\n"
            f"missing={sorted(expected_paths - actual_paths)}\n"
            f"extra={sorted(actual_paths - expected_paths)}"
        )
    if set(manifest) != expected_paths:
        fail(
            ".release-please-manifest.json paths must match release products:\n"
            f"missing={sorted(expected_paths - set(manifest))}\n"
            f"extra={sorted(set(manifest) - expected_paths)}"
        )

    if config.get("tag-separator") != "-":
        fail("release-please tag-separator must be '-' for <component>-v<version> tags")
    if config.get("include-v-in-tag") is not True:
        fail("release-please must include v in tags")
    if config.get("pull-request-title-pattern") != "chore${scope}: release${component} ${version}":
        fail("release-please pull-request-title-pattern must keep release-please's parseable default shape")
    if config.get("initial-version") != "0.1.0":
        fail("release-please initial-version must bootstrap the first generated release PR to 0.1.0")
    if config.get("bump-minor-pre-major") is not True:
        fail("release-please must minor-bump breaking changes while product versions are below 1.0.0")
    if config.get("bump-patch-for-minor-pre-major") is not True:
        fail("release-please must patch-bump feat commits after the 0.1.0 bootstrap while versions stay below 1.0.0")
    plugins = config.get("plugins", [])
    if plugins != ["node-workspace"]:
        fail("release-please plugins must stay minimal: use node-workspace only")

    ids_by_path = {path: product for product, path in paths_by_id.items()}
    for package_path, package_config in packages.items():
        if not isinstance(package_config, dict):
            fail(f"{package_path} config must be an object")
        product = ids_by_path[package_path]
        component = package_config.get("component")
        if component != product:
            fail(f"{package_path}.component must be {product!r}, got {component!r}")
        tag_prefix = product_metadata.tag_prefix(product)
        if tag_prefix != f"{component}-v":
            fail(f"{product} release-please component does not match tag prefix {tag_prefix!r}")
        manifest_version = manifest.get(package_path)
        current_version = product_metadata.read_current_version(product)
        if manifest_version != current_version:
            fail(
                f"{package_path} manifest version {manifest_version!r} "
                f"does not match current {product} version {current_version!r}"
            )
        changelog_path = package_config.get("changelog-path", "CHANGELOG.md")
        if not isinstance(changelog_path, str) or not changelog_path:
            fail(f"{package_path}.changelog-path must be a non-empty string")
        reject_unsafe_relative_path(changelog_path, f"{package_path}.changelog-path")
        require_file(ROOT / package_path / changelog_path, f"{package_path}.changelog-path")
        version_file = package_version_file(package_path, package_config)
        if version_file is not None and read_raw_version(version_file) != current_version:
            fail(f"{rel(version_file)} must match current {product} version {current_version}")
        validate_extra_files(package_path, package_config)

    print("release-please config checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
