#!/usr/bin/env python3
"""Validate staged release/build artifacts without rebuilding them.

This checker enforces the packaging boundary:

* SDK packages are wrappers and must not accidentally embed runtime or extension
  payloads.
* Exact-extension packages must contain only declared artifact targets, with
  checksums matching their manifests.
* Mobile app artifacts must contain only the extensions selected for that app.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import tarfile
import zipfile
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path
from typing import NoReturn

import extension_artifact_targets
import product_metadata


ROOT = Path(__file__).resolve().parents[2]
SDK_ROOT = ROOT / "target" / "sdk-artifacts"
EXTENSION_ROOT = ROOT / "target" / "extension-artifacts"
MOBILE_ROOT = ROOT / "target" / "mobile-build" / "react-native"

SDK_PRODUCTS = {
    "oliphaunt-rust",
    "oliphaunt-swift",
    "oliphaunt-kotlin",
    "oliphaunt-js",
    "oliphaunt-react-native",
    "oliphaunt-wasix-rust",
}

SDK_RUNTIME_PAYLOAD_PATTERNS = [
    re.compile(pattern)
    for pattern in (
        r"(^|/)assets/oliphaunt/runtime/",
        r"(^|/)assets/oliphaunt/template-pgdata/",
        r"(^|/)assets/oliphaunt/static-registry/archives/",
        r"(^|/)oliphaunt/runtime/files/",
        r"(^|/)runtime/files/share/postgresql/",
        r"(^|/)share/postgresql/extension/[^/]+\.(control|sql)$",
        r"(^|/)release-assets/",
        r"(^|/)extension-artifacts\.json$",
        r"(^|/)liboliphaunt\.(so|dylib|dll|a|lib)$",
        r"(^|/)liboliphaunt_extensions\.(so|dylib|dll|a|lib)$",
        r"(^|/)liboliphaunt_extension_[^/]+\.(so|dylib|dll|a|lib)$",
        r"\.xcframework(/|$)",
    )
]

KOTLIN_ALLOWED_NATIVE_PAYLOADS = {
    "liboliphaunt_kotlin_android.so",
}
KOTLIN_RELEASE_ABIS = {"arm64-v8a", "x86_64"}
BASELINE_POSTGRES_EXTENSIONS = {"plpgsql"}


def fail(message: str) -> NoReturn:
    print(f"check_staged_artifacts.py: {message}", file=sys.stderr)
    raise SystemExit(1)


def rel(path: Path) -> str:
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def read_json(path: Path) -> dict[str, object]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        fail(f"{rel(path)} is not valid JSON: {error}")
    if not isinstance(data, dict):
        fail(f"{rel(path)} must contain a JSON object")
    return data


def read_properties_text(text: str) -> dict[str, str]:
    parsed: dict[str, str] = {}
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            fail(f"invalid properties line: {raw!r}")
        key, value = line.split("=", 1)
        parsed[key] = value
    return parsed


def csv_values(value: str | None) -> list[str]:
    if not value:
        return []
    return [item.strip() for item in value.split(",") if item.strip()]


def archive_tar_names(path: Path) -> list[str]:
    try:
        with tarfile.open(path, "r:*") as archive:
            return sorted(member.name for member in archive.getmembers() if member.isfile())
    except tarfile.TarError as error:
        fail(f"{rel(path)} is not a readable tar archive: {error}")


def archive_zip_names(path: Path) -> list[str]:
    try:
        with zipfile.ZipFile(path) as archive:
            return sorted(name for name in archive.namelist() if not name.endswith("/"))
    except zipfile.BadZipFile as error:
        fail(f"{rel(path)} is not a readable zip archive: {error}")


def validate_zstd_archive_magic(path: Path) -> None:
    with path.open("rb") as handle:
        magic = handle.read(4)
    if magic != b"\x28\xb5\x2f\xfd":
        fail(f"{rel(path)} is not a zstd archive")


def validate_release_archive_payload(path: Path) -> None:
    if path.name.endswith(".tar.gz") or path.name.endswith(".tgz") or path.name.endswith(".crate"):
        names = archive_tar_names(path)
        if not names:
            fail(f"{rel(path)} must contain at least one file")
        return
    if path.name.endswith(".zip") or path.name.endswith(".aar") or path.name.endswith(".jar"):
        names = archive_zip_names(path)
        if not names:
            fail(f"{rel(path)} must contain at least one file")
        return
    if path.name.endswith(".tar.zst"):
        validate_zstd_archive_magic(path)


def directory_names(root: Path) -> list[str]:
    return sorted(str(path.relative_to(root)) for path in root.rglob("*") if path.is_file())


def path_bytes(path: Path) -> int:
    if path.is_file():
        return path.stat().st_size
    if path.is_dir():
        return sum(item.stat().st_size for item in path.rglob("*") if item.is_file())
    fail(f"missing path while measuring bytes: {rel(path)}")


def zip_read_text(path: Path, name: str) -> str:
    try:
        with zipfile.ZipFile(path) as archive:
            with archive.open(name) as handle:
                return handle.read().decode("utf-8")
    except KeyError:
        fail(f"{rel(path)} is missing {name}")
    except zipfile.BadZipFile as error:
        fail(f"{rel(path)} is not a readable zip archive: {error}")


def dir_read_text(root: Path, name: str) -> str:
    path = root / name
    if not path.is_file():
        fail(f"{rel(root)} is missing {name}")
    return path.read_text(encoding="utf-8")


def generated_extension_rows() -> dict[str, dict[str, object]]:
    metadata = ROOT / "src" / "extensions" / "generated" / "sdk" / "react-native.json"
    data = read_json(metadata)
    rows = data.get("extensions")
    if not isinstance(rows, list):
        fail(f"{rel(metadata)} must contain an extensions array")
    result: dict[str, dict[str, object]] = {}
    for row in rows:
        if not isinstance(row, dict):
            continue
        sql_name = row.get("sql-name")
        if isinstance(sql_name, str) and sql_name:
            result[sql_name] = row
    return result


def creates_extension(sql_name: str, rows: dict[str, dict[str, object]]) -> bool:
    row = rows.get(sql_name)
    if row is None:
        fail(f"selected extension {sql_name!r} is missing from generated extension metadata")
    return row.get("creates-extension") is not False


def native_module_stem(sql_name: str, rows: dict[str, dict[str, object]]) -> str:
    row = rows.get(sql_name)
    if row is None:
        fail(f"selected extension {sql_name!r} is missing from generated extension metadata")
    stem = row.get("native-module-stem")
    return stem if isinstance(stem, str) else ""


def native_module_extensions(selected: list[str], rows: dict[str, dict[str, object]]) -> list[str]:
    return sorted(
        extension
        for extension in selected
        if (stem := native_module_stem(extension, rows)) and stem != "-"
    )


def extension_name_for_asset(path_name: str) -> str | None:
    name = Path(path_name).name
    if name.endswith(".control"):
        return name.removesuffix(".control")
    if "--" in name and name.endswith(".sql"):
        return name.split("--", 1)[0]
    return None


def reject_sdk_runtime_payload(product: str, artifact: Path, names: Iterable[str]) -> None:
    for name in names:
        basename = Path(name).name
        if product == "oliphaunt-kotlin" and basename in KOTLIN_ALLOWED_NATIVE_PAYLOADS:
            continue
        for pattern in SDK_RUNTIME_PAYLOAD_PATTERNS:
            if pattern.search(name):
                fail(f"{product} SDK artifact {rel(artifact)} must not include runtime/extension payload {name}")


def validate_kotlin_android_aar(artifact: Path, names: Iterable[str]) -> None:
    name_set = set(names)
    present_abis = {
        parts[1]
        for name in name_set
        if (parts := name.split("/")) and len(parts) == 3 and parts[0] == "jni" and parts[2] == "liboliphaunt_kotlin_android.so"
    }
    if present_abis != KOTLIN_RELEASE_ABIS:
        fail(
            f"Kotlin Android release AAR {rel(artifact)} must contain JNI adapters for "
            f"{', '.join(sorted(KOTLIN_RELEASE_ABIS))}; got {', '.join(sorted(present_abis)) or '(none)'}"
        )


def check_sdk_product(product: str, *, require: bool) -> bool:
    root = SDK_ROOT / product
    if not root.exists():
        if require:
            fail(f"missing staged SDK artifacts for {product} under {rel(root)}")
        return False

    checked = False
    if product in {"oliphaunt-js", "oliphaunt-react-native"}:
        tarballs = sorted(root.glob("*.tgz"))
        if not tarballs and require:
            fail(f"{product} must stage an npm tarball under {rel(root)}")
        for tarball in tarballs:
            reject_sdk_runtime_payload(product, tarball, archive_tar_names(tarball))
            checked = True
    elif product == "oliphaunt-swift":
        archives = sorted(root.glob("*.zip"))
        if not archives and require:
            fail(f"{product} must stage a source zip under {rel(root)}")
        for archive in archives:
            reject_sdk_runtime_payload(product, archive, archive_zip_names(archive))
            checked = True
        release_manifest = root / "Package.swift.release"
        if not release_manifest.exists() and require:
            fail(f"{product} must stage {rel(release_manifest)} for release installation")
        if release_manifest.exists():
            text = release_manifest.read_text(encoding="utf-8")
            if "file://" in text:
                fail(f"{rel(release_manifest)} must not contain local file URLs")
            if "liboliphaunt-native-v" not in text or "checksum:" not in text:
                fail(f"{rel(release_manifest)} must reference checksummed public liboliphaunt assets")
    elif product == "oliphaunt-kotlin":
        maven_root = root / "maven"
        if not maven_root.is_dir():
            if require:
                fail(f"{product} must stage a Maven repository under {rel(maven_root)}")
            return False
        archives = sorted([*root.glob("*.aar"), *root.glob("*.jar")])
        for archive in archives:
            names = archive_zip_names(archive)
            reject_sdk_runtime_payload(product, archive, names)
            if archive.suffix == ".aar":
                validate_kotlin_android_aar(archive, names)
            checked = True
        maven_artifacts = sorted(maven_root.rglob("*"))
        for artifact in (path for path in maven_artifacts if path.suffix in {".aar", ".jar"}):
            names = archive_zip_names(artifact)
            reject_sdk_runtime_payload(product, artifact, names)
            if artifact.suffix == ".aar":
                validate_kotlin_android_aar(artifact, names)
            checked = True
    elif product in {"oliphaunt-rust", "oliphaunt-wasix-rust"}:
        crates = sorted(root.glob("*.crate"))
        if not crates and require:
            fail(f"{product} must stage a Cargo crate under {rel(root)}")
        for crate in crates:
            reject_sdk_runtime_payload(product, crate, archive_tar_names(crate))
            checked = True
    else:
        fail(f"unsupported SDK product {product}")

    if require and not checked:
        fail(f"{product} did not contain any inspectable staged package artifacts under {rel(root)}")
    if checked:
        print(f"validated SDK artifact cleanliness: {product}")
    return checked


def exact_extension_products() -> list[str]:
    products: list[str] = []
    for product in product_metadata.product_ids():
        if product_metadata.product_config(product).get("kind") == "exact-extension-artifact":
            products.append(product)
    return sorted(products)


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


def public_extension_asset(asset: dict) -> dict:
    return {
        key: asset[key]
        for key in product_metadata.PUBLIC_EXTENSION_RELEASE_ASSET_KEYS
        if key in asset
    }


def check_extension_product(product: str, *, require: bool, require_full_targets: bool) -> bool:
    root = EXTENSION_ROOT / product
    manifest = root / "extension-artifacts.json"
    if not manifest.exists():
        if require:
            fail(f"missing staged exact-extension package manifest for {product} under {rel(root)}")
        return False
    data = read_json(manifest)
    expected = {
        "schema": "oliphaunt-extension-ci-artifacts-v1",
        "product": product,
        "version": product_metadata.read_current_version(product),
    }
    for key, value in expected.items():
        if data.get(key) != value:
            fail(f"{rel(manifest)} has {key}={data.get(key)!r}, expected {value!r}")
    sql_name = data.get("sqlName")
    expected_sql_name = product_metadata.product_config(product).get("extension_sql_name")
    if sql_name != expected_sql_name:
        fail(f"{rel(manifest)} has sqlName={sql_name!r}, expected {expected_sql_name!r}")

    assets = data.get("assets")
    if not isinstance(assets, list) or not assets:
        fail(f"{rel(manifest)} must declare at least one asset")

    seen_names: set[str] = set()
    staged_targets: set[str] = set()
    allowed_targets = {
        target.target for target in extension_artifact_targets.artifact_targets(product=product, published_only=True)
    }
    for asset in assets:
        if not isinstance(asset, dict):
            fail(f"{rel(manifest)} contains a non-object asset entry")
        family = asset.get("family")
        target = asset.get("target")
        kind = asset.get("kind")
        name = asset.get("name")
        path_value = asset.get("path")
        sha = asset.get("sha256")
        bytes_value = asset.get("bytes")
        if not all(isinstance(value, str) and value for value in (family, target, kind, name, path_value, sha)):
            fail(f"{rel(manifest)} contains an incomplete asset entry: {asset!r}")
        if not isinstance(bytes_value, int) or bytes_value <= 0:
            fail(f"{rel(manifest)} asset {name} must declare positive bytes")
        if name in seen_names:
            fail(f"{rel(manifest)} declares duplicate asset name {name}")
        seen_names.add(name)
        staged_targets.add(target)
        if target not in allowed_targets:
            fail(f"{rel(manifest)} stages undeclared target={target!r}")
        if not extension_artifact_kind_allowed(family, target, kind):
            fail(f"{rel(manifest)} stages invalid artifact kind={kind!r} for family={family!r} target={target!r}")
        path = ROOT / path_value
        if path.parent != root / "release-assets" or path.name != name:
            fail(f"{rel(manifest)} asset {name} must live directly under {rel(root / 'release-assets')}")
        if not path.is_file():
            fail(f"{rel(manifest)} references missing asset {rel(path)}")
        if path.stat().st_size != bytes_value:
            fail(f"{rel(path)} size does not match {rel(manifest)}")
        if sha256_file(path) != sha:
            fail(f"{rel(path)} checksum does not match {rel(manifest)}")
        validate_release_archive_payload(path)

    release_manifest = root / "release-assets" / f"{product}-{expected['version']}-manifest.json"
    if not release_manifest.exists():
        fail(f"{product} must stage release manifest {rel(release_manifest)}")
    release_data = read_json(release_manifest)
    expected_release = {
        "schema": "oliphaunt-extension-release-manifest-v1",
        "product": product,
        "version": str(expected["version"]),
        "sqlName": str(expected_sql_name),
    }
    for key, value in expected_release.items():
        if release_data.get(key) != value:
            fail(f"{rel(release_manifest)} has {key}={release_data.get(key)!r}, expected {value!r}")
    actual_release_keys = set(release_data)
    expected_release_keys = product_metadata.PUBLIC_EXTENSION_RELEASE_MANIFEST_KEYS
    if actual_release_keys != expected_release_keys:
        fail(
            f"{rel(release_manifest)} public manifest keys must be "
            f"{sorted(expected_release_keys)}, got {sorted(actual_release_keys)}"
        )
    extension_metadata = product_metadata.extension_metadata(product)
    if release_data.get("extensionClass") != extension_metadata["class"]:
        fail(f"{rel(release_manifest)} has stale extensionClass")
    if release_data.get("versioning") != extension_metadata["versioning"]:
        fail(f"{rel(release_manifest)} has stale versioning")
    if release_data.get("sourceIdentity") != product_metadata.extension_source_identity(product):
        fail(f"{rel(release_manifest)} has stale sourceIdentity")
    if release_data.get("compatibility") != extension_metadata["compatibility"]:
        fail(f"{rel(release_manifest)} has stale compatibility metadata")
    public_assets = release_data.get("assets")
    if not isinstance(public_assets, list) or not public_assets:
        fail(f"{rel(release_manifest)} must declare release assets")
    expected_public_assets = [public_extension_asset(asset) for asset in assets]
    if public_assets != expected_public_assets:
        fail(f"{rel(release_manifest)} public assets must match staged CI manifest without local paths")
    for asset in public_assets:
        if not isinstance(asset, dict):
            fail(f"{rel(release_manifest)} contains a non-object public asset row")
        actual_asset_keys = set(asset)
        expected_asset_keys = product_metadata.PUBLIC_EXTENSION_RELEASE_ASSET_KEYS
        if actual_asset_keys != expected_asset_keys:
            fail(
                f"{rel(release_manifest)} public asset {asset.get('name')!r} keys must be "
                f"{sorted(expected_asset_keys)}, got {sorted(actual_asset_keys)}"
            )
    properties_manifest = root / "release-assets" / f"{product}-{expected['version']}-manifest.properties"
    if not properties_manifest.exists():
        fail(f"{product} must stage properties manifest {rel(properties_manifest)}")
    properties = read_properties_text(properties_manifest.read_text(encoding="utf-8"))
    expected_properties = {
        "schema": "oliphaunt-extension-release-manifest-v1",
        "product": product,
        "version": str(expected["version"]),
        "sqlName": str(expected_sql_name),
        "extensionClass": str(release_data["extensionClass"]),
        "versioning": str(release_data["versioning"]),
        "sourceKind": str(release_data["sourceIdentity"]["kind"]),
    }
    for key, value in expected_properties.items():
        if properties.get(key) != value:
            fail(f"{rel(properties_manifest)} has {key}={properties.get(key)!r}, expected {value!r}")
    expected_property_assets = {
        f"{asset['family']}.{asset['target']}.{asset['kind']}": asset["name"]
        for asset in assets
        if isinstance(asset, dict)
    }
    actual_property_assets = {
        key.removeprefix("asset."): value
        for key, value in properties.items()
        if key.startswith("asset.")
    }
    if actual_property_assets != expected_property_assets:
        fail(
            f"{rel(properties_manifest)} asset rows must match {rel(manifest)} exactly: "
            f"{actual_property_assets!r} vs {expected_property_assets!r}"
        )
    checksum_manifest = root / "release-assets" / f"{product}-{expected['version']}-release-assets.sha256"
    if not checksum_manifest.exists():
        fail(f"{product} must stage checksum manifest {rel(checksum_manifest)}")
    validate_checksum_manifest(checksum_manifest, root / "release-assets")

    if require_full_targets:
        missing = allowed_targets - staged_targets
        if missing:
            rendered = ", ".join(sorted(missing))
            fail(f"{product} is missing published exact-extension targets: {rendered}")
    print(f"validated exact-extension package artifacts: {product}")
    return True


def validate_checksum_manifest(path: Path, asset_dir: Path) -> None:
    declared: dict[str, str] = {}
    for line_number, raw in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        line = raw.strip()
        if not line:
            continue
        parts = line.split(None, 1)
        if len(parts) != 2:
            fail(f"{rel(path)}:{line_number} must contain '<sha256> ./<asset>'")
        sha, name = parts
        if not re.fullmatch(r"[0-9a-f]{64}", sha) or not name.startswith("./") or "/" in name[2:]:
            fail(f"{rel(path)}:{line_number} contains an invalid checksum entry")
        asset_name = name[2:]
        if asset_name in declared:
            fail(f"{rel(path)} declares duplicate checksum entry for {asset_name}")
        declared[asset_name] = sha
    expected_names = sorted(item.name for item in asset_dir.iterdir() if item.is_file() and item != path)
    if sorted(declared) != expected_names:
        fail(f"{rel(path)} must cover release assets exactly")
    for name, expected_sha in declared.items():
        actual = sha256_file(asset_dir / name)
        if actual != expected_sha:
            fail(f"{rel(path)} checksum mismatch for {name}")


@dataclass(frozen=True)
class MobileArtifact:
    platform: str
    path: Path
    names: list[str]

    def read_text(self, name: str) -> str:
        if self.path.is_dir():
            return dir_read_text(self.path, name)
        return zip_read_text(self.path, name)


def discover_mobile_artifacts(platform: str) -> list[MobileArtifact]:
    if platform == "android":
        return [
            MobileArtifact("android", apk, archive_zip_names(apk))
            for apk in sorted((MOBILE_ROOT / "android").glob("*.apk"))
        ]
    if platform == "ios":
        ios_root = MOBILE_ROOT / "ios"
        apps = sorted(ios_root.glob("*.app"))
        return [MobileArtifact("ios", app, directory_names(app)) for app in apps]
    fail(f"unsupported mobile platform {platform}")


def mobile_prefix(platform: str) -> str:
    if platform == "android":
        return "assets/oliphaunt/"
    if platform == "ios":
        return "OliphauntReactNativeResources.bundle/oliphaunt/"
    fail(f"unsupported mobile platform {platform}")


def mobile_target_for_artifact(artifact: MobileArtifact) -> str:
    if artifact.platform == "ios":
        return "ios-xcframework"
    abis = sorted(
        name.split("/", 2)[1]
        for name in artifact.names
        if name.startswith("lib/") and name.endswith("/liboliphaunt.so")
    )
    if len(abis) != 1:
        fail(f"{rel(artifact.path)} must contain exactly one Android liboliphaunt ABI, got {abis}")
    abi = abis[0]
    if abi == "arm64-v8a":
        return "android-arm64-v8a"
    if abi == "x86_64":
        return "android-x86_64"
    fail(f"{rel(artifact.path)} contains unsupported Android ABI {abi}")


def mobile_build_report(platform: str) -> dict[str, object] | None:
    report = MOBILE_ROOT / platform / "build-report.json"
    if not report.is_file():
        return None
    data = read_json(report)
    if data.get("schema") != "oliphaunt-react-native-mobile-build-v1":
        fail(f"{rel(report)} has invalid mobile build report schema")
    if data.get("platform") != platform:
        fail(f"{rel(report)} has platform={data.get('platform')!r}, expected {platform!r}")
    return data


def resolve_report_path(value: object, report_path: Path, field: str) -> Path:
    if not isinstance(value, str) or not value:
        fail(f"{rel(report_path)} must declare {field}")
    path = Path(value)
    if not path.is_absolute():
        path = ROOT / path
    return path


def check_extension_package_has_mobile_target(sql_name: str, target: str) -> None:
    for product in exact_extension_products():
        manifest = EXTENSION_ROOT / product / "extension-artifacts.json"
        if not manifest.is_file():
            continue
        data = read_json(manifest)
        if data.get("sqlName") != sql_name:
            continue
        assets = data.get("assets")
        if not isinstance(assets, list):
            fail(f"{rel(manifest)} must declare assets")
        runtime_matches = [
            asset
            for asset in assets
            if isinstance(asset, dict)
            and asset.get("family") == "native"
            and asset.get("target") == target
            and asset.get("kind") == "runtime"
        ]
        if len(runtime_matches) != 1:
            fail(f"{sql_name} exact-extension package must contain one native runtime asset for {target}")
        if target == "ios-xcframework":
            framework_matches = [
                asset
                for asset in assets
                if isinstance(asset, dict)
                and asset.get("family") == "native"
                and asset.get("target") == target
                and asset.get("kind") == "ios-xcframework"
            ]
            if len(framework_matches) != 1:
                fail(f"{sql_name} exact-extension package must contain one iOS XCFramework asset")
        return
    fail(f"no exact-extension package found for selected mobile extension {sql_name}")


def check_ios_prebuilt_extension_linkage(artifact: MobileArtifact, stems: list[str]) -> None:
    if not stems:
        return

    source_leaks = sorted(
        name
        for name in artifact.names
        if "/static-registry/oliphaunt_static_registry.c" in name
        or "/extension-frameworks/" in name
        or name.endswith(".xcframework")
    )
    if source_leaks:
        fail(
            f"{rel(artifact.path)} includes build-only iOS static-extension inputs as app resources: "
            f"{', '.join(source_leaks[:10])}"
        )

    report = mobile_build_report("ios")
    if report is None:
        fail(f"{rel(artifact.path)} requires {rel(MOBILE_ROOT / 'ios' / 'build-report.json')} for iOS extension link evidence")
    scratch_root = report.get("scratchRoot")
    if not isinstance(scratch_root, str) or not scratch_root:
        fail(f"{rel(MOBILE_ROOT / 'ios' / 'build-report.json')} must declare scratchRoot for iOS extension link evidence")
    scratch_path = Path(scratch_root)
    xcode_log = scratch_path / "xcodebuild.log"
    if not xcode_log.is_file():
        fail(f"iOS extension link evidence is missing xcodebuild log: {rel(xcode_log)}")
    log_text = xcode_log.read_text(encoding="utf-8", errors="replace")
    if "** BUILD SUCCEEDED **" not in log_text:
        fail(f"iOS extension link evidence requires a successful xcodebuild log: {rel(xcode_log)}")

    pods_support = (
        scratch_path
        / "src"
        / "sdks"
        / "react-native"
        / "examples"
        / "expo"
        / "ios"
        / "Pods"
        / "Target Support Files"
        / "OliphauntReactNative"
    )
    input_file = pods_support / "OliphauntReactNative-xcframeworks-input-files.xcfilelist"
    output_file = pods_support / "OliphauntReactNative-xcframeworks-output-files.xcfilelist"
    if not input_file.is_file():
        fail(f"iOS extension link evidence is missing CocoaPods XCFramework input file list: {rel(input_file)}")
    if not output_file.is_file():
        fail(f"iOS extension link evidence is missing CocoaPods XCFramework output file list: {rel(output_file)}")

    expected_frameworks = {f"liboliphaunt_extension_{stem}" for stem in stems}
    pod_text = input_file.read_text(encoding="utf-8", errors="replace") + "\n" + output_file.read_text(
        encoding="utf-8", errors="replace"
    )
    pod_frameworks = set(re.findall(r"liboliphaunt_extension_[A-Za-z0-9_]+", pod_text))
    products_root = scratch_path / "DerivedData" / "Build" / "Products"
    if not products_root.is_dir():
        fail(f"iOS extension link evidence is missing Xcode build products: {rel(products_root)}")
    built_frameworks = {
        path.name.removesuffix(".a").removesuffix(".framework")
        for path in products_root.rglob("liboliphaunt_extension_*")
        if path.name.endswith((".a", ".framework"))
    }

    missing_pods = sorted(expected_frameworks - pod_frameworks)
    if missing_pods:
        fail(
            f"CocoaPods file lists do not include selected iOS extension link input(s): "
            f"{', '.join(missing_pods)}"
        )
    missing_built = sorted(expected_frameworks - built_frameworks)
    if missing_built:
        fail(
            f"Xcode build products do not include selected iOS extension linked artifact(s): "
            f"{', '.join(missing_built)}"
        )
    unexpected_pods = sorted(pod_frameworks - expected_frameworks)
    if unexpected_pods:
        fail(
            f"CocoaPods file lists include unselected iOS extension link input(s): "
            f"{', '.join(unexpected_pods)}"
        )
    unexpected_built = sorted(built_frameworks - expected_frameworks)
    if unexpected_built:
        fail(
            f"Xcode build products include unselected iOS extension linked artifact(s): "
            f"{', '.join(unexpected_built)}"
        )


def check_android_prebuilt_extension_linkage(
    artifact: MobileArtifact,
    stems: list[str],
    report: dict[str, object],
    report_path: Path,
    expected_abi: str,
    static_registry: dict[str, str],
    target: str,
) -> None:
    if not stems:
        return

    evidence_path = resolve_report_path(report.get("androidLinkEvidence"), report_path, "androidLinkEvidence")
    if not evidence_path.is_file():
        fail(f"Android extension link evidence is missing: {rel(evidence_path)}")
    linked_stems: set[str] = set()
    linked_dependencies: set[str] = set()
    evidence_abi = ""
    runtime_path = ""
    schema_rows = 0
    abi_rows = 0

    def require_existing_path(raw_path: str, line_number: int, row_kind: str) -> Path:
        path = Path(raw_path)
        if not path.is_absolute():
            path = evidence_path.parent / path
        if not path.is_file():
            fail(f"{rel(evidence_path)}:{line_number} {row_kind} path does not exist: {path}")
        return path

    for line_number, raw in enumerate(evidence_path.read_text(encoding="utf-8").splitlines(), start=1):
        parts = raw.split("\t")
        if not parts or not parts[0]:
            continue
        kind = parts[0]
        if kind == "schema":
            if parts != ["schema", "oliphaunt-android-static-extension-link-v1"]:
                fail(f"{rel(evidence_path)}:{line_number} has invalid schema row")
            schema_rows += 1
        elif kind == "abi":
            if len(parts) != 2:
                fail(f"{rel(evidence_path)}:{line_number} has invalid abi row")
            evidence_abi = parts[1]
            abi_rows += 1
        elif kind == "runtime":
            if len(parts) != 3 or parts[1] != "liboliphaunt":
                fail(f"{rel(evidence_path)}:{line_number} has invalid runtime row")
            path = require_existing_path(parts[2], line_number, "runtime")
            if path.name != "liboliphaunt.so":
                fail(f"{rel(evidence_path)}:{line_number} runtime path must end in liboliphaunt.so")
            if runtime_path:
                fail(f"{rel(evidence_path)} contains duplicate runtime rows")
            runtime_path = str(path)
        elif kind == "extension":
            if len(parts) != 3:
                fail(f"{rel(evidence_path)}:{line_number} has invalid extension row")
            stem, archive = parts[1], parts[2]
            expected_name = f"liboliphaunt_extension_{stem}.a"
            path = require_existing_path(archive, line_number, "extension")
            expected_relative = static_registry.get(f"module.{stem}.archive.{target}")
            if not expected_relative:
                fail(f"{rel(artifact.path)} static registry manifest has no module.{stem}.archive.{target} entry")
            if path.name != expected_name:
                fail(f"{rel(evidence_path)}:{line_number} archive {archive!r} does not match stem {stem!r}")
            if not path.as_posix().endswith(expected_relative):
                fail(
                    f"{rel(evidence_path)}:{line_number} archive {archive!r} does not match "
                    f"static-registry path {expected_relative!r}"
                )
            linked_stems.add(stem)
        elif kind == "dependency":
            if len(parts) != 3 or not parts[1]:
                fail(f"{rel(evidence_path)}:{line_number} has invalid dependency row")
            dependency_name = parts[1]
            path = require_existing_path(parts[2], line_number, "dependency")
            expected_relative = static_registry.get(f"dependency.{dependency_name}.archive.{target}")
            if not expected_relative:
                fail(
                    f"{rel(evidence_path)}:{line_number} dependency {dependency_name!r} is not declared "
                    f"by the static-registry manifest for {target}"
                )
            if not path.as_posix().endswith(expected_relative):
                fail(
                    f"{rel(evidence_path)}:{line_number} dependency path {parts[2]!r} does not match "
                    f"static-registry path {expected_relative!r}"
                )
            linked_dependencies.add(dependency_name)
        else:
            fail(f"{rel(evidence_path)}:{line_number} has unknown row kind {kind!r}")
    if schema_rows != 1:
        fail(f"{rel(evidence_path)} must contain exactly one schema row")
    if abi_rows != 1:
        fail(f"{rel(evidence_path)} must contain exactly one abi row")
    if evidence_abi != expected_abi:
        fail(f"{rel(evidence_path)} declares abi={evidence_abi!r}, expected {expected_abi!r}")
    if not runtime_path:
        fail(f"{rel(evidence_path)} does not show liboliphaunt runtime link input")
    expected_stems = set(stems)
    missing = sorted(expected_stems - linked_stems)
    if missing:
        fail(
            f"{rel(evidence_path)} does not show selected Android extension archive link input(s): "
            f"{', '.join(missing)}"
        )
    unexpected = sorted(linked_stems - expected_stems)
    if unexpected:
        fail(
            f"{rel(evidence_path)} shows unselected Android extension archive link input(s): "
            f"{', '.join(unexpected)}"
        )
    expected_dependencies = set(csv_values(static_registry.get("dependencyArchives")))
    missing_dependencies = sorted(expected_dependencies - linked_dependencies)
    if missing_dependencies:
        fail(
            f"{rel(evidence_path)} does not show required Android extension dependency archive link input(s): "
            f"{', '.join(missing_dependencies)}"
        )
    unexpected_dependencies = sorted(linked_dependencies - expected_dependencies)
    if unexpected_dependencies:
        fail(
            f"{rel(evidence_path)} shows unselected Android extension dependency archive link input(s): "
            f"{', '.join(unexpected_dependencies)}"
        )


def check_mobile_artifact(artifact: MobileArtifact, *, require_prebuilt_extensions: bool) -> None:
    prefix = mobile_prefix(artifact.platform)
    runtime_manifest_name = f"{prefix}runtime/manifest.properties"
    static_registry_manifest_name = f"{prefix}static-registry/manifest.properties"
    package_size_name = f"{prefix}package-size.tsv"

    runtime = read_properties_text(artifact.read_text(runtime_manifest_name))
    if runtime.get("schema") != "oliphaunt-runtime-resources-v1":
        fail(f"{rel(artifact.path)} has invalid runtime resource manifest schema")
    selected = csv_values(runtime.get("extensions"))
    selected_set = set(selected)
    rows = generated_extension_rows()
    target = mobile_target_for_artifact(artifact)

    report_path = MOBILE_ROOT / artifact.platform / "build-report.json"
    report = mobile_build_report(artifact.platform)
    if report is None:
        fail(f"{rel(artifact.path)} requires mobile build report {rel(report_path)}")
    report_artifact = resolve_report_path(report.get("appArtifact"), report_path, "appArtifact")
    if report_artifact.resolve() != artifact.path.resolve():
        fail(f"{rel(report_path)} appArtifact={report_artifact} does not match inspected artifact {artifact.path}")
    if report.get("appArtifactBytes") != path_bytes(artifact.path):
        fail(f"{rel(report_path)} appArtifactBytes does not match inspected artifact size")
    selected_from_report = report.get("selectedExtensions")
    if not isinstance(selected_from_report, list):
        fail(f"{rel(report_path)} selectedExtensions must be an array")
    report_selected = sorted(str(value) for value in selected_from_report if str(value))
    if report_selected != sorted(selected):
        fail(f"{rel(report_path)} selectedExtensions={report_selected} must match runtime manifest {sorted(selected)}")
    if artifact.platform == "android":
        expected_abi = "arm64-v8a" if target == "android-arm64-v8a" else "x86_64"
        if report.get("abi") != expected_abi:
            fail(f"{rel(report_path)} abi={report.get('abi')!r}, expected {expected_abi!r}")
    else:
        expected_abi = ""

    extension_asset_names = [
        name
        for name in artifact.names
        if f"{prefix}runtime/files/share/postgresql/extension/" in name
        and (name.endswith(".control") or name.endswith(".sql"))
    ]
    present_extensions = {extension for name in extension_asset_names if (extension := extension_name_for_asset(name))}
    unexpected = sorted(present_extensions - selected_set - BASELINE_POSTGRES_EXTENSIONS)
    if unexpected:
        fail(f"{rel(artifact.path)} includes unselected extension assets: {', '.join(unexpected)}")
    for extension in selected:
        if creates_extension(extension, rows):
            has_control = any(name.endswith(f"/{extension}.control") for name in extension_asset_names)
            has_sql = any(f"/{extension}--" in name and name.endswith(".sql") for name in extension_asset_names)
            if not has_control or not has_sql:
                fail(f"{rel(artifact.path)} is missing selected {extension} control/SQL assets")
        if require_prebuilt_extensions:
            check_extension_package_has_mobile_target(extension, target)

    stems = sorted(stem for extension in selected if (stem := native_module_stem(extension, rows)) and stem != "-")
    static_registry = read_properties_text(artifact.read_text(static_registry_manifest_name))
    registered = sorted(csv_values(static_registry.get("registeredExtensions")))
    native_selected = native_module_extensions(selected, rows)
    if stems:
        if runtime.get("mobileStaticRegistryState") != "complete":
            fail(f"{rel(artifact.path)} must mark mobile static registry complete for native-module extensions")
        if registered != native_selected:
            fail(f"{rel(artifact.path)} static registry registeredExtensions={registered}, expected {native_selected}")
        if artifact.platform == "android" and not any(name.endswith("/liboliphaunt_extensions.so") for name in artifact.names):
            fail(f"{rel(artifact.path)} Android app is missing liboliphaunt_extensions.so")
        if artifact.platform == "android" and require_prebuilt_extensions:
            check_android_prebuilt_extension_linkage(artifact, stems, report, report_path, expected_abi, static_registry, target)
        if artifact.platform == "ios" and require_prebuilt_extensions:
            check_ios_prebuilt_extension_linkage(artifact, stems)
        if any("static-registry/archives/" in name for name in artifact.names):
            fail(f"{rel(artifact.path)} must not ship build-only static-registry archives")
    else:
        if runtime.get("mobileStaticRegistryState") not in {"", "not-required"}:
            fail(f"{rel(artifact.path)} must not claim a static registry for SQL-only extensions")

    package_size = artifact.read_text(package_size_name)
    extension_rows = [
        line.split("\t")
        for line in package_size.splitlines()
        if line.startswith("extension\t")
    ]
    package_size_extensions = sorted(parts[1] for parts in extension_rows if len(parts) >= 2)
    if package_size_extensions != sorted(selected):
        fail(
            f"{rel(artifact.path)} package-size extension rows {package_size_extensions} "
            f"must exactly match selected extensions {sorted(selected)}"
        )
    print(f"validated mobile app extension contents: {artifact.platform} {rel(artifact.path)}")


def check_mobile_platform(platform: str, *, require: bool, require_prebuilt_extensions: bool) -> bool:
    artifacts = discover_mobile_artifacts(platform)
    if not artifacts:
        if require:
            fail(f"missing staged React Native {platform} mobile app artifacts under {rel(MOBILE_ROOT / platform)}")
        return False
    for artifact in artifacts:
        check_mobile_artifact(artifact, require_prebuilt_extensions=require_prebuilt_extensions)
    return True


def expand_products(values: list[str], *, all_products: set[str], label: str) -> list[str]:
    expanded: list[str] = []
    for value in values:
        if value == "all":
            expanded.extend(sorted(all_products))
        else:
            if value not in all_products:
                fail(f"unknown {label} {value}; expected one of: all, {', '.join(sorted(all_products))}")
            expanded.append(value)
    return sorted(set(expanded))


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--require-sdk-product", action="append", default=[], help="SDK product to require, or all")
    parser.add_argument(
        "--require-extension-product",
        action="append",
        default=[],
        help="exact-extension product to require, or all",
    )
    parser.add_argument(
        "--require-full-extension-targets",
        action="store_true",
        help="require exact-extension packages to contain every published target",
    )
    parser.add_argument(
        "--require-mobile",
        action="append",
        default=[],
        choices=["android", "ios", "all"],
        help="mobile app artifact platform to require",
    )
    parser.add_argument(
        "--require-mobile-prebuilt-extensions",
        action="store_true",
        help="mobile artifacts must have matching staged exact-extension packages for their selected extensions",
    )
    parser.add_argument(
        "--inspect-present",
        action="store_true",
        help="also inspect any present staged SDK, extension, and mobile artifacts",
    )
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    checked = 0

    required_sdk_products = expand_products(
        args.require_sdk_product,
        all_products=SDK_PRODUCTS,
        label="SDK product",
    )
    for product in required_sdk_products:
        checked += int(check_sdk_product(product, require=True))
    if args.inspect_present:
        for product in sorted(SDK_PRODUCTS - set(required_sdk_products)):
            checked += int(check_sdk_product(product, require=False))

    extension_products = set(exact_extension_products())
    required_extension_products = expand_products(
        args.require_extension_product,
        all_products=extension_products,
        label="exact-extension product",
    )
    for product in required_extension_products:
        checked += int(
            check_extension_product(
                product,
                require=True,
                require_full_targets=args.require_full_extension_targets,
            )
        )
    if args.inspect_present:
        for product in sorted(extension_products - set(required_extension_products)):
            checked += int(check_extension_product(product, require=False, require_full_targets=False))

    required_mobile = set()
    for value in args.require_mobile:
        if value == "all":
            required_mobile.update({"android", "ios"})
        else:
            required_mobile.add(value)
    for platform in sorted(required_mobile):
        checked += int(
            check_mobile_platform(
                platform,
                require=True,
                require_prebuilt_extensions=args.require_mobile_prebuilt_extensions,
            )
        )
    if args.inspect_present:
        for platform in sorted({"android", "ios"} - required_mobile):
            checked += int(
                check_mobile_platform(
                    platform,
                    require=False,
                    require_prebuilt_extensions=args.require_mobile_prebuilt_extensions,
                )
            )

    if checked == 0:
        fail("no staged artifacts were checked; pass --require-* or --inspect-present")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
