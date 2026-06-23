#!/usr/bin/env python3
"""Stage publishable exact-extension artifacts from built runtime outputs."""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import shutil
import sys
from pathlib import Path
from typing import NoReturn

import product_metadata
import extension_artifact_targets


ROOT = Path(__file__).resolve().parents[2]


def fail(message: str) -> NoReturn:
    print(f"build-extension-ci-artifacts.py: {message}", file=sys.stderr)
    raise SystemExit(1)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def extension_products() -> list[str]:
    products = []
    for product in product_metadata.product_ids():
        config = product_metadata.product_config(product)
        if config.get("kind") == "exact-extension-artifact":
            products.append(product)
    return sorted(products)


def extension_sql_name(product: str) -> str:
    config = product_metadata.product_config(product)
    value = config.get("extension_sql_name")
    if not isinstance(value, str) or not value:
        fail(f"{product} release metadata must declare extension_sql_name")
    return value


def generated_extension_row(sql_name: str) -> dict[str, object]:
    metadata = ROOT / "src/extensions/generated/sdk/kotlin.json"
    with metadata.open("r", encoding="utf-8") as handle:
        data = json.load(handle)
    for row in data.get("extensions", []):
        if isinstance(row, dict) and row.get("sql-name") == sql_name:
            return row
    fail(f"generated extension metadata has no row for {sql_name}")


def string_list(value: object) -> list[str]:
    if not isinstance(value, list):
        return []
    return sorted(str(item) for item in value if str(item))


def properties_csv(values: list[str]) -> str:
    return ",".join(values)


def public_asset(asset: dict[str, object]) -> dict[str, object]:
    return {
        key: asset[key]
        for key in ("name", "family", "target", "kind", "sha256", "bytes")
        if key in asset
    }


def resolve_repo_path(value: str, *, label: str) -> Path:
    path = Path(value)
    if not path.is_absolute():
        path = ROOT / path
    try:
        path.relative_to(ROOT)
    except ValueError:
        fail(f"{label} must be inside the repository: {path}")
    return path


def native_release_asset_root() -> Path:
    return resolve_repo_path(
        os.environ.get("OLIPHAUNT_NATIVE_EXTENSION_RELEASE_ASSET_ROOT", "target/extensions/native/release-assets"),
        label="native extension release asset root",
    )


def wasix_release_asset_root() -> Path:
    return resolve_repo_path(
        os.environ.get("OLIPHAUNT_WASIX_EXTENSION_RELEASE_ASSET_ROOT", "target/extensions/wasix/release-assets"),
        label="WASIX extension release asset root",
    )


def index_contains_sql_name(index: Path, sql_name: str) -> bool:
    with index.open("r", encoding="utf-8", newline="") as handle:
        return any(row.get("sql_name") == sql_name for row in csv.DictReader(handle, delimiter="\t"))


def native_extension_asset_indexes(sql_name: str, product: str | None = None) -> list[Path]:
    version = product_metadata.read_current_version("liboliphaunt-native")
    root = native_release_asset_root()
    indexes: list[Path] = []
    for target in extension_artifact_targets.published_target_ids(family="native"):
        target_root = root / target
        if product is not None:
            product_index = target_root / product / f"liboliphaunt-{version}-native-extension-assets.tsv"
            if product_index.is_file() and index_contains_sql_name(product_index, sql_name):
                indexes.append(product_index)
                continue
        direct_index = target_root / f"liboliphaunt-{version}-native-extension-assets.tsv"
        if direct_index.is_file():
            indexes.append(direct_index)
    return sorted(indexes)


def native_assets_from_target_indexes(
    sql_name: str,
    *,
    product: str | None = None,
    required: bool,
) -> list[tuple[Path, str, str]]:
    indexes = native_extension_asset_indexes(sql_name, product)
    if not indexes:
        return []

    assets: list[tuple[Path, str, str]] = []
    seen: set[tuple[str, str]] = set()
    for index in indexes:
        with index.open("r", encoding="utf-8", newline="") as handle:
            rows = list(csv.DictReader(handle, delimiter="\t"))
        for row in rows:
            if row.get("sql_name") != sql_name:
                continue
            target = row.get("target")
            kind = row.get("kind")
            artifact = row.get("artifact")
            if not target or not kind or not artifact:
                fail(f"{index.relative_to(ROOT)} has an incomplete native asset row for {sql_name}")
            dedupe_key = (target, kind)
            if dedupe_key in seen:
                fail(f"duplicate native extension asset row for {sql_name} target={target} kind={kind}")
            seen.add(dedupe_key)
            path = index.parent / artifact
            if not path.is_file():
                fail(f"{index.relative_to(ROOT)} references missing native asset {path.relative_to(ROOT)}")
            assets.append((path, target, kind))

    if required and not assets:
        fail(f"{sql_name} has no native extension assets in native target asset indexes")
    return assets


def native_assets_for(sql_name: str, *, product: str | None = None, required: bool) -> list[tuple[Path, str, str]]:
    indexed = native_assets_from_target_indexes(sql_name, product=product, required=False)
    if indexed:
        return indexed
    if required:
        product_hint = f" for {product}" if product else ""
        fail(f"{sql_name}{product_hint} has no native extension assets in native target asset indexes")
    return []


def wasix_archive_for(sql_name: str, *, product: str | None = None, required: bool) -> Path | None:
    version = product_metadata.read_current_version("liboliphaunt-wasix")
    root = wasix_release_asset_root()
    indexes: list[Path] = []
    for target in extension_artifact_targets.published_target_ids(family="wasix"):
        target_root = root / target
        if product is not None:
            product_index = target_root / product / f"liboliphaunt-wasix-{version}-wasix-extension-assets.tsv"
            if product_index.is_file():
                indexes.append(product_index)
                continue
        direct_index = target_root / f"liboliphaunt-wasix-{version}-wasix-extension-assets.tsv"
        if direct_index.is_file():
            indexes.append(direct_index)
    assets: list[Path] = []
    for index in indexes:
        with index.open("r", encoding="utf-8", newline="") as handle:
            rows = list(csv.DictReader(handle, delimiter="\t"))
        for row in rows:
            if row.get("sql_name") != sql_name:
                continue
            target = row.get("target")
            kind = row.get("kind")
            artifact = row.get("artifact")
            if target != "wasix-portable" or kind != "wasix-runtime" or not artifact:
                fail(f"{index.relative_to(ROOT)} has an invalid WASIX asset row for {sql_name}")
            path = index.parent / artifact
            if not path.is_file():
                fail(f"{index.relative_to(ROOT)} references missing WASIX asset {path.relative_to(ROOT)}")
            assets.append(path)
    if len(assets) > 1:
        fail(f"{sql_name} has duplicate WASIX extension assets: {', '.join(str(path.relative_to(ROOT)) for path in assets)}")
    if assets:
        return assets[0]

    if required:
        fail(
            f"{sql_name} has no WASIX extension assets in "
            "target/extensions/wasix/release-assets target indexes"
        )
    return None


def copy_asset(source: Path, destination_dir: Path, *, name: str) -> dict[str, object]:
    destination_dir.mkdir(parents=True, exist_ok=True)
    destination = destination_dir / name
    shutil.copy2(source, destination)
    return {
        "name": destination.name,
        "path": str(destination.relative_to(ROOT)),
        "source": str(source.relative_to(ROOT)),
        "sha256": sha256(destination),
        "bytes": destination.stat().st_size,
    }


def native_asset_name(product: str, version: str, target: str, kind: str, source: Path) -> str:
    suffix = archive_suffix(source)
    if target == "macos-arm64":
        return f"{product}-{version}-native-macos-arm64-runtime{suffix}"
    if target.startswith("linux-"):
        return f"{product}-{version}-native-{target}-runtime{suffix}"
    if target.startswith("windows-"):
        return f"{product}-{version}-native-{target}-runtime{suffix}"
    if target == "ios-xcframework":
        if kind == "runtime":
            return f"{product}-{version}-native-ios-runtime{suffix}"
        if kind == "ios-xcframework":
            return f"{product}-{version}-native-ios-xcframework{suffix}"
        fail(f"unsupported iOS extension artifact kind {kind} for {source.name}")
    if target.startswith("android-"):
        if kind == "runtime":
            return f"{product}-{version}-native-{target}-runtime{suffix}"
        if kind == "android-static-archive":
            return f"{product}-{version}-native-{target}-static{suffix}"
        fail(f"unsupported Android extension artifact kind {kind} for {source.name}")
    fail(f"unsupported native extension artifact target {target} for {source.name}")


def archive_suffix(source: Path) -> str:
    for suffix in (".tar.gz", ".tar.zst", ".zip"):
        if source.name.endswith(suffix):
            return suffix
    fail(f"native extension asset {source.name} must use .tar.gz, .tar.zst, or .zip")


def validate_staged_targets(
    product: str,
    assets: list[dict[str, object]],
    *,
    require_native: bool,
    require_wasix: bool,
    require_native_targets: set[str],
) -> None:
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
    staged_native_targets = {
        str(asset["target"])
        for asset in assets
        if asset.get("family") == "native"
    }
    staged_wasix_targets = {
        str(asset["target"])
        for asset in assets
        if asset.get("family") == "wasix"
    }

    extra_native = staged_native_targets - declared_native_targets
    extra_wasix = staged_wasix_targets - declared_wasix_targets
    if extra_native:
        fail(f"{product} staged undeclared native extension targets: {', '.join(sorted(extra_native))}")
    if extra_wasix:
        fail(f"{product} staged undeclared WASIX extension targets: {', '.join(sorted(extra_wasix))}")

    if require_native_targets:
        unknown_required = require_native_targets - declared_native_targets
        if unknown_required:
            fail(f"{product} was asked to require undeclared native targets: {', '.join(sorted(unknown_required))}")
        missing_native = require_native_targets - staged_native_targets
        if missing_native:
            fail(f"{product} is missing native extension artifacts for: {', '.join(sorted(missing_native))}")
    elif require_native:
        missing_native = declared_native_targets - staged_native_targets
        if missing_native:
            fail(f"{product} is missing native extension artifacts for: {', '.join(sorted(missing_native))}")
    if require_wasix:
        missing_wasix = declared_wasix_targets - staged_wasix_targets
        if missing_wasix:
            fail(f"{product} is missing WASIX extension artifacts for: {', '.join(sorted(missing_wasix))}")


def resolve_output_root(value: str) -> Path:
    return resolve_repo_path(value, label="output root")


def stage_product(
    product: str,
    *,
    output_root: Path,
    require_native: bool,
    require_wasix: bool,
    require_native_targets: set[str],
) -> None:
    known = set(extension_products())
    if product not in known:
        fail(f"unknown exact-extension product {product}; expected one of: {', '.join(sorted(known))}")

    sql_name = extension_sql_name(product)
    extension_row = generated_extension_row(sql_name)
    version = product_metadata.read_current_version(product)
    product_root = output_root / product
    asset_dir = product_root / "release-assets"
    if product_root.exists():
        shutil.rmtree(product_root)
    asset_dir.mkdir(parents=True, exist_ok=True)

    assets: list[dict[str, object]] = []
    for native_asset, target, kind in native_assets_for(sql_name, product=product, required=require_native):
        if require_native_targets and target not in require_native_targets:
            continue
        metadata = copy_asset(
            native_asset,
            asset_dir,
            name=native_asset_name(product, version, target, kind, native_asset),
        )
        metadata["family"] = "native"
        metadata["kind"] = kind
        metadata["target"] = target
        assets.append(metadata)

    wasix_archive = wasix_archive_for(sql_name, product=product, required=require_wasix)
    if wasix_archive is not None:
        wasix_name = f"{product}-{version}-wasix-portable.tar.zst"
        metadata = copy_asset(wasix_archive, asset_dir, name=wasix_name)
        metadata["family"] = "wasix"
        metadata["kind"] = "wasix-runtime"
        metadata["target"] = "wasix-portable"
        assets.append(metadata)

    validate_staged_targets(
        product,
        assets,
        require_native=require_native,
        require_wasix=require_wasix,
        require_native_targets=require_native_targets,
    )
    if not assets:
        fail(f"{product} produced no extension artifacts")

    manifest = {
        "schema": "oliphaunt-extension-ci-artifacts-v1",
        "product": product,
        "version": version,
        "sqlName": sql_name,
        "dependencies": string_list(extension_row.get("selected-extension-dependencies")),
        "nativeModuleStem": extension_row.get("native-module-stem"),
        "sharedPreloadLibraries": string_list(extension_row.get("shared-preload-libraries")),
        "mobileReleaseReady": extension_row.get("mobile-release-ready") is True,
        "desktopReleaseReady": extension_row.get("desktop-release-ready") is True,
        "assets": assets,
    }
    (product_root / "extension-artifacts.json").write_text(
        json.dumps(manifest, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    extension_metadata = product_metadata.extension_metadata(product)
    release_data = {
        "schema": "oliphaunt-extension-release-manifest-v1",
        "product": product,
        "version": version,
        "sqlName": sql_name,
        "extensionClass": extension_metadata["class"],
        "versioning": extension_metadata["versioning"],
        "sourceIdentity": product_metadata.extension_source_identity(product),
        "compatibility": extension_metadata["compatibility"],
        "dependencies": manifest["dependencies"],
        "nativeModuleStem": manifest["nativeModuleStem"],
        "sharedPreloadLibraries": manifest["sharedPreloadLibraries"],
        "mobileReleaseReady": manifest["mobileReleaseReady"],
        "desktopReleaseReady": manifest["desktopReleaseReady"],
        "assets": [public_asset(asset) for asset in assets],
    }
    release_manifest = asset_dir / f"{product}-{version}-manifest.json"
    release_manifest.write_text(
        json.dumps(release_data, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    properties_manifest = asset_dir / f"{product}-{version}-manifest.properties"
    source_identity = release_data["sourceIdentity"]
    properties_lines = [
        "schema=oliphaunt-extension-release-manifest-v1\n",
        f"product={product}\n",
        f"version={version}\n",
        f"sqlName={sql_name}\n",
        f"extensionClass={release_data['extensionClass']}\n",
        f"versioning={release_data['versioning']}\n",
        f"sourceKind={source_identity['kind']}\n",
        f"dependencies={properties_csv(manifest['dependencies'])}\n",
        f"nativeModuleStem={manifest['nativeModuleStem'] or ''}\n",
        f"sharedPreloadLibraries={properties_csv(manifest['sharedPreloadLibraries'])}\n",
        f"mobileReleaseReady={'true' if manifest['mobileReleaseReady'] else 'false'}\n",
        f"desktopReleaseReady={'true' if manifest['desktopReleaseReady'] else 'false'}\n",
    ]
    for asset in sorted(assets, key=lambda value: (str(value["family"]), str(value["target"]), str(value["kind"]))):
        key = f"asset.{asset['family']}.{asset['target']}.{asset['kind']}"
        properties_lines.append(f"{key}={asset['name']}\n")
    properties_manifest.write_text("".join(properties_lines), encoding="utf-8")
    checksum_manifest = asset_dir / f"{product}-{version}-release-assets.sha256"
    checksum_lines = []
    for asset in sorted(path for path in asset_dir.iterdir() if path.is_file() and path != checksum_manifest):
        checksum_lines.append(f"{sha256(asset)}  ./{asset.name}\n")
    checksum_manifest.write_text("".join(checksum_lines), encoding="utf-8")
    (product_root / "artifacts.txt").write_text(
        "".join(
            [
                *(f"{asset['path']}\n" for asset in assets),
                f"{release_manifest.relative_to(ROOT)}\n",
                f"{properties_manifest.relative_to(ROOT)}\n",
                f"{checksum_manifest.relative_to(ROOT)}\n",
            ]
        ),
        encoding="utf-8",
    )
    print(f"{product}: staged {len(assets)} exact-extension artifact(s) in {product_root.relative_to(ROOT)}")


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("products", nargs="*", help="exact-extension product id(s)")
    parser.add_argument("--all", action="store_true", help="stage every exact-extension product")
    parser.add_argument(
        "--output-root",
        default="target/extension-artifacts",
        help="repository-relative staging root for package-shaped extension artifacts",
    )
    parser.add_argument("--require-native", action="store_true", help="fail if native extension assets are missing")
    parser.add_argument(
        "--require-native-target",
        action="append",
        default=[],
        help="fail if the named native extension target is missing; may be passed more than once",
    )
    parser.add_argument("--require-wasix", action="store_true", help="fail if WASIX extension archives are missing")
    return parser.parse_args(argv)


def selected_products_from_env() -> list[str]:
    raw = os.environ.get("OLIPHAUNT_EXTENSION_PACKAGE_PRODUCTS", "")
    products = sorted({item.strip() for item in raw.split(",") if item.strip()})
    if not products:
        return []
    known = set(extension_products())
    unknown = sorted(set(products) - known)
    if unknown:
        fail(f"OLIPHAUNT_EXTENSION_PACKAGE_PRODUCTS contains unknown exact-extension product(s): {', '.join(unknown)}")
    return products


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    products = selected_products_from_env() or (extension_products() if args.all else args.products)
    if not products:
        fail("pass --all or at least one exact-extension product id")
    output_root = resolve_output_root(args.output_root)
    require_native_targets = set(args.require_native_target)
    for product in products:
        stage_product(
            product,
            output_root=output_root,
            require_native=args.require_native,
            require_wasix=args.require_wasix,
            require_native_targets=require_native_targets,
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
