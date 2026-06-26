#!/usr/bin/env python3
"""Build a manifest for Oliphaunt tarball Maven artifact publications."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import NoReturn

import extension_artifact_targets
import product_metadata


ROOT = Path(__file__).resolve().parents[2]


def fail(message: str) -> NoReturn:
    print(f"build_maven_artifact_manifest.py: {message}", file=sys.stderr)
    raise SystemExit(1)


def repo_path(value: str) -> Path:
    path = Path(value)
    if not path.is_absolute():
        path = ROOT / path
    return path


def require_file(path: Path, label: str) -> Path:
    if not path.is_file():
        fail(f"missing {label}: {path.relative_to(ROOT)}")
    return path


def tsv_row(
    *,
    group_id: str,
    artifact_id: str,
    version: str,
    file: Path,
    name: str,
    description: str,
) -> str:
    values = [group_id, artifact_id, version, str(file.relative_to(ROOT)), name, description]
    if any("\t" in value or "\n" in value for value in values):
        fail(f"Maven artifact manifest value contains a tab or newline: {values}")
    return "\t".join(values)


RUNTIME_MAVEN_ARTIFACTS = {
    "liboliphaunt-runtime-resources": {
        "filename": "liboliphaunt-{version}-runtime-resources.tar.gz",
        "name": "Oliphaunt runtime resources",
        "description": "Package-managed Oliphaunt PostgreSQL runtime resources for Android app builds.",
    },
    "oliphaunt-icu": {
        "filename": "liboliphaunt-{version}-icu-data.tar.gz",
        "name": "Oliphaunt ICU data",
        "description": "Package-managed optional ICU data files for Oliphaunt app builds.",
    },
    "liboliphaunt-android-arm64-v8a": {
        "filename": "liboliphaunt-{version}-android-arm64-v8a.tar.gz",
        "name": "Oliphaunt Android runtime arm64-v8a",
        "description": "Package-managed liboliphaunt Android runtime for arm64-v8a app builds.",
    },
    "liboliphaunt-android-x86_64": {
        "filename": "liboliphaunt-{version}-android-x86_64.tar.gz",
        "name": "Oliphaunt Android runtime x86_64",
        "description": "Package-managed liboliphaunt Android runtime for x86_64 app builds.",
    },
}


def split_maven_coordinate(coordinate: str) -> tuple[str, str]:
    group_id, separator, artifact_id = coordinate.partition(":")
    if not separator or not group_id or not artifact_id:
        fail(f"invalid Maven coordinate {coordinate!r}; expected group:artifact")
    return group_id, artifact_id


def runtime_rows(asset_root: Path) -> list[str]:
    version = product_metadata.read_current_version("liboliphaunt-native")
    rows = []
    for coordinate in product_metadata.registry_package_names("liboliphaunt-native", "maven"):
        group_id, artifact_id = split_maven_coordinate(coordinate)
        if group_id != "dev.oliphaunt.runtime":
            fail(f"liboliphaunt-native Maven artifact {coordinate} must use dev.oliphaunt.runtime")
        artifact = RUNTIME_MAVEN_ARTIFACTS.get(artifact_id)
        if artifact is None:
            fail(f"liboliphaunt-native Maven artifact {coordinate} has no release asset mapping")
        filename = artifact["filename"].format(version=version)
        rows.append(
            tsv_row(
                group_id=group_id,
                artifact_id=artifact_id,
                version=version,
                file=require_file(asset_root / filename, artifact_id),
                name=artifact["name"],
                description=artifact["description"],
            )
        )
    return rows


def extension_rows(extension_root: Path, selected_products: list[str]) -> list[str]:
    products = selected_products or [
        product
        for product in product_metadata.product_ids()
        if product_metadata.product_config(product).get("kind") == "exact-extension-artifact"
    ]
    rows: list[str] = []
    for product in sorted(products):
        config = product_metadata.product_config(product)
        if config.get("kind") != "exact-extension-artifact":
            fail(f"{product} is not an exact-extension-artifact product")
        sql_name = config.get("extension_sql_name")
        if not isinstance(sql_name, str) or not sql_name:
            fail(f"{product} release metadata must declare extension_sql_name")
        version = product_metadata.read_current_version(product)
        product_root = extension_root / product / "release-assets"
        targets = extension_artifact_targets.published_android_maven_targets(product)
        if not targets:
            fail(f"{product} has no published Android Maven extension targets")
        for target in targets:
            filename = f"{product}-{version}-native-{target.target}-runtime.tar.gz"
            rows.append(
                tsv_row(
                    group_id="dev.oliphaunt.extensions",
                    artifact_id=f"{product}-{target.target}",
                    version=version,
                    file=require_file(product_root / filename, f"{product} {target.target} Maven artifact"),
                    name=f"Oliphaunt extension {sql_name} {target.target}",
                    description=f"Package-managed Oliphaunt Android runtime and static-link artifacts for the {sql_name} PostgreSQL extension on {target.target}.",
                )
            )
    return rows


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True, help="TSV manifest path to write")
    parser.add_argument(
        "--runtime-asset-root",
        default="target/liboliphaunt/release-assets",
        help="Directory containing liboliphaunt runtime release assets",
    )
    parser.add_argument(
        "--extension-artifact-root",
        default="target/extension-artifacts",
        help="Directory containing staged exact-extension package artifacts",
    )
    parser.add_argument("--runtime", action="store_true", help="include base liboliphaunt Android runtime artifacts")
    parser.add_argument("--extensions", action="store_true", help="include Android exact-extension artifacts")
    parser.add_argument("--extension-product", action="append", default=[], help="exact-extension product to include")
    args = parser.parse_args()

    include_runtime = args.runtime or not args.extensions
    include_extensions = args.extensions or bool(args.extension_product)
    rows: list[str] = []
    if include_runtime:
        rows.extend(runtime_rows(repo_path(args.runtime_asset_root)))
    if include_extensions:
        rows.extend(extension_rows(repo_path(args.extension_artifact_root), args.extension_product))
    if not rows:
        fail("manifest would be empty")

    output = repo_path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text("\n".join(rows) + "\n", encoding="utf-8")
    print(f"Wrote {len(rows)} Maven artifact publication row(s) to {output.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
