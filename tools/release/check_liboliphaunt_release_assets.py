#!/usr/bin/env python3
"""Validate liboliphaunt GitHub release assets before upload."""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import sys
import tarfile
import zipfile
from pathlib import Path
from typing import NoReturn

import artifact_targets
import product_metadata


ROOT = Path(__file__).resolve().parents[2]


def fail(message: str) -> NoReturn:
    print(f"check_liboliphaunt_release_assets.py: {message}", file=sys.stderr)
    raise SystemExit(1)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as file:
        for chunk in iter(lambda: file.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def require_file(path: Path, description: str) -> None:
    if not path.is_file():
        fail(f"missing {description}: {path}")
    if path.stat().st_size <= 0:
        fail(f"{description} is empty: {path}")


def parse_checksum_file(path: Path) -> dict[str, str]:
    checksums: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        parts = line.split()
        if len(parts) != 2:
            fail(f"malformed checksum line in {path}: {line!r}")
        digest, filename = parts
        if not filename.startswith("./"):
            fail(f"checksum path must be relative './name': {filename}")
        checksums[filename[2:]] = digest
    return checksums


def validate_checksums(asset_dir: Path, checksum_file: Path) -> None:
    checksums = parse_checksum_file(checksum_file)
    expected_assets = sorted(
        path
        for path in asset_dir.iterdir()
        if path.is_file() and path.suffix != ".sha256"
    )
    if not expected_assets:
        fail(f"no release assets found in {asset_dir}")
    for asset in expected_assets:
        recorded = checksums.get(asset.name)
        if recorded is None:
            fail(f"checksum file does not cover release asset: {asset.name}")
        actual = sha256(asset)
        if recorded != actual:
            fail(f"checksum mismatch for {asset.name}: expected {recorded}, got {actual}")
    extra = sorted(set(checksums) - {asset.name for asset in expected_assets})
    if extra:
        fail("checksum file contains entries for missing assets: " + ", ".join(extra))


def generated_extension_metadata() -> dict[str, dict[str, object]]:
    metadata_path = ROOT / "src/extensions/generated/sdk/rust.json"
    try:
        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    except OSError as error:
        fail(f"read generated Rust SDK extension metadata {metadata_path}: {error}")
    except json.JSONDecodeError as error:
        fail(f"parse generated Rust SDK extension metadata {metadata_path}: {error}")
    rows = metadata.get("extensions")
    if not isinstance(rows, list):
        fail(f"{metadata_path} must define an extensions array")
    expected: dict[str, dict[str, object]] = {}
    for index, row in enumerate(rows):
        if not isinstance(row, dict):
            fail(f"{metadata_path} extensions[{index}] must be an object")
        sql_name = row.get("sql-name")
        if not isinstance(sql_name, str) or not sql_name:
            fail(f"{metadata_path} extensions[{index}] must define sql-name")
        data_files = row.get("runtime-share-data-files")
        if not isinstance(data_files, list) or not all(isinstance(value, str) for value in data_files):
            fail(f"{metadata_path} extension {sql_name} must define runtime-share-data-files")
        native_module_stem = row.get("native-module-stem")
        if native_module_stem is not None and not isinstance(native_module_stem, str):
            fail(f"{metadata_path} extension {sql_name} native-module-stem must be a string or null")
        expected[sql_name] = {
            "creates_extension": row.get("creates-extension") is True,
            "data_files": data_files,
            "data_files_tsv": ",".join(data_files) if data_files else "-",
            "native_module_stem": native_module_stem,
        }
    return expected


def tar_member_names(path: Path) -> set[str]:
    try:
        with tarfile.open(path, "r:*") as archive:
            names = set()
            for member in archive.getmembers():
                name = member.name.removeprefix("./").rstrip("/")
                if name:
                    names.add(name)
            return names
    except tarfile.TarError as error:
        fail(f"{path} is not a readable tar archive: {error}")


def tar_text(path: Path, member_name: str) -> str:
    try:
        with tarfile.open(path, "r:*") as archive:
            member = archive.getmember(member_name)
            extracted = archive.extractfile(member)
            if extracted is None:
                fail(f"{path} member {member_name} is not a regular file")
            return extracted.read().decode("utf-8")
    except KeyError:
        fail(f"{path} is missing {member_name}")
    except UnicodeDecodeError as error:
        fail(f"{path} member {member_name} is not UTF-8: {error}")
    except tarfile.TarError as error:
        fail(f"{path} is not a readable tar archive: {error}")


def validate_base_runtime_artifact_contents(
    path: Path,
    extension_metadata: dict[str, dict[str, object]],
) -> None:
    names = tar_member_names(path)
    runtime_prefix = "oliphaunt/runtime/files/"
    for required_member in [
        "oliphaunt/package-size.tsv",
        "oliphaunt/runtime/manifest.properties",
        "oliphaunt/template-pgdata/manifest.properties",
    ]:
        if required_member not in names:
            fail(f"{path} must contain {required_member}")
    if f"{runtime_prefix}share/postgresql/README.release-fixture" not in names and not any(
        name.startswith(runtime_prefix) for name in names
    ):
        fail(f"{path} must contain an oliphaunt/runtime/files tree")
    if any(name.startswith(f"{runtime_prefix}share/icu/") for name in names):
        fail(f"{path} base runtime must not contain ICU data under {runtime_prefix}share/icu")
    for sql_name, metadata in extension_metadata.items():
        control = f"{runtime_prefix}share/postgresql/extension/{sql_name}.control"
        if control in names:
            fail(f"{path} base runtime must not contain optional extension control file {control}")
        for data_file in metadata["data_files"]:
            data_path = f"{runtime_prefix}share/postgresql/{data_file}"
            if data_path in names:
                fail(f"{path} base runtime must not contain optional extension data file {data_path}")
        stem = metadata.get("native_module_stem")
        if isinstance(stem, str) and stem:
            for suffix in (".dylib", ".so", ".dll"):
                module = f"{runtime_prefix}lib/postgresql/{stem}{suffix}"
                if module in names:
                    fail(f"{path} base runtime must not contain optional extension module {module}")


def validate_icu_data_artifact_contents(path: Path) -> None:
    names = tar_member_names(path)
    icu_entries = sorted(
        name
        for name in names
        if name.startswith("share/icu/")
        and Path(name).relative_to("share/icu").parts
        and Path(name).relative_to("share/icu").parts[0].startswith("icudt")
    )
    if not icu_entries:
        fail(f"{path} must contain ICU data files under share/icu/icudt*")
    unexpected = sorted(
        name
        for name in names
        if name != "."
        and name not in {"share", "share/icu"}
        and not name.startswith("share/icu/")
    )
    if unexpected:
        fail(f"{path} must contain only share/icu data, found: {', '.join(unexpected[:5])}")


def validate_extension_runtime_artifact_contents(
    path: Path,
    row: dict[str, str],
    extension_metadata: dict[str, dict[str, object]],
) -> None:
    sql_name = row["sql_name"]
    metadata = extension_metadata[sql_name]
    names = tar_member_names(path)
    manifest = tar_text(path, "manifest.properties")
    for expected in [
        "packageLayout=oliphaunt-extension-artifact-v1\n",
        f"sqlName={sql_name}\n",
        "files=files\n",
    ]:
        if expected not in manifest:
            fail(f"{path} manifest must contain {expected.strip()!r}")
    if not any(name.startswith("files/") for name in names):
        fail(f"{path} must contain a files/ runtime tree")
    if metadata["creates_extension"]:
        control = f"files/share/postgresql/extension/{sql_name}.control"
        if control not in names:
            fail(f"{path} must contain selected extension control file {control}")
        sql_prefix = f"files/share/postgresql/extension/{sql_name}--"
        if not any(name.startswith(sql_prefix) and name.endswith(".sql") for name in names):
            fail(f"{path} must contain at least one selected extension SQL file under {sql_prefix}*.sql")
    stem = row["native_module_stem"]
    if stem != "-":
        module = f"files/lib/postgresql/{stem}.dylib"
        if module not in names:
            fail(f"{path} must contain selected extension native module {module}")
    expected_data_files = set(metadata["data_files"])
    for data_file in sorted(expected_data_files):
        data_path = f"files/share/postgresql/{data_file}"
        if data_path not in names:
            fail(f"{path} must contain selected extension data file {data_path}")
    for other_sql_name, other_metadata in extension_metadata.items():
        if other_sql_name == sql_name:
            continue
        other_control = f"files/share/postgresql/extension/{other_sql_name}.control"
        if other_control in names:
            fail(f"{path} for {sql_name} must not contain unselected extension control file {other_control}")
        other_stem = other_metadata.get("native_module_stem")
        if isinstance(other_stem, str) and other_stem:
            for suffix in (".dylib", ".so", ".dll"):
                other_module = f"files/lib/postgresql/{other_stem}{suffix}"
                if other_module in names:
                    fail(f"{path} for {sql_name} must not contain unselected extension module {other_module}")
        for data_file in other_metadata["data_files"]:
            if data_file in expected_data_files:
                continue
            other_data = f"files/share/postgresql/{data_file}"
            if other_data in names:
                fail(f"{path} for {sql_name} must not contain unselected extension data file {other_data}")


def validate_android_extension_artifact(
    path: Path,
    row: dict[str, str],
    abi: str,
) -> None:
    sql_name = row["sql_name"]
    stem = row["native_module_stem"]
    names = tar_member_names(path)
    manifest = tar_text(path, "manifest.properties")
    expected_archive = f"extensions/{stem}/liboliphaunt_extension_{stem}.a"
    for expected in [
        "packageLayout=liboliphaunt-android-extension-artifact-v1\n",
        f"abi={abi}\n",
        f"sqlName={sql_name}\n",
        f"nativeModuleStem={stem}\n",
        f"archive={expected_archive}\n",
    ]:
        if expected not in manifest:
            fail(f"{path} manifest must contain {expected.strip()!r}")
    if expected_archive not in names:
        fail(f"{path} must contain selected Android static archive {expected_archive}")


def validate_extension_index(
    asset_dir: Path,
    index_file: Path,
    extension_metadata: dict[str, dict[str, object]],
) -> None:
    required_columns = [
        "sql_name",
        "creates_extension",
        "native_module_stem",
        "dependencies",
        "shared_preload",
        "mobile_prebuilt",
        "mobile_static_archive_targets",
        "runtime_artifact",
        "ios_xcframework_artifact",
        "android_arm64_artifact",
        "android_x86_64_artifact",
        "runtime_artifact_bytes",
        "ios_xcframework_artifact_bytes",
        "android_arm64_artifact_bytes",
        "android_x86_64_artifact_bytes",
        "data_files",
    ]
    with index_file.open("r", encoding="utf-8", newline="") as file:
        reader = csv.DictReader(file, delimiter="\t")
        if reader.fieldnames != required_columns:
            fail(f"{index_file} has unexpected header: {reader.fieldnames}")
        row_count = 0
        seen_sql_names: set[str] = set()
        for row in reader:
            row_count += 1
            sql_name = row["sql_name"]
            if not sql_name:
                fail(f"{index_file} row {row_count} has empty sql_name")
            if sql_name in seen_sql_names:
                fail(f"{index_file} contains duplicate sql_name {sql_name}")
            seen_sql_names.add(sql_name)
            runtime_artifact = row["runtime_artifact"]
            if runtime_artifact == "-":
                fail(f"{sql_name} must reference a runtime extension artifact")
            require_file(asset_dir / runtime_artifact, f"{sql_name} runtime extension artifact")
            metadata = extension_metadata.get(sql_name)
            if metadata is None:
                fail(f"{sql_name} is missing from generated Rust SDK extension metadata")
            expected_creates_extension = "yes" if metadata["creates_extension"] else "no"
            if row["creates_extension"] != expected_creates_extension:
                fail(
                    f"{sql_name} creates_extension must match generated metadata: "
                    f"expected {expected_creates_extension!r}, got {row['creates_extension']!r}"
                )
            expected_stem = metadata["native_module_stem"] or "-"
            if row["native_module_stem"] != expected_stem:
                fail(
                    f"{sql_name} native_module_stem must match generated metadata: "
                    f"expected {expected_stem!r}, got {row['native_module_stem']!r}"
                )
            expected_data_files = metadata["data_files_tsv"]
            if row["data_files"] != expected_data_files:
                fail(
                    f"{sql_name} release artifact index data_files must match generated metadata: "
                    f"expected {expected_data_files!r}, got {row['data_files']!r}"
                )
            validate_extension_runtime_artifact_contents(
                asset_dir / runtime_artifact,
                row,
                extension_metadata,
            )
            validate_recorded_bytes(
                asset_dir,
                runtime_artifact,
                row["runtime_artifact_bytes"],
                f"{sql_name} runtime extension artifact",
            )
            if row["mobile_prebuilt"] == "yes" and row["native_module_stem"] != "-":
                ios_artifact = row["ios_xcframework_artifact"]
                android_arm64_artifact = row["android_arm64_artifact"]
                android_x86_64_artifact = row["android_x86_64_artifact"]
                if ios_artifact == "-" or android_arm64_artifact == "-" or android_x86_64_artifact == "-":
                    fail(f"{sql_name} is mobile-prebuilt but missing mobile artifact references")
                require_file(asset_dir / ios_artifact, f"{sql_name} iOS extension artifact")
                validate_swiftpm_xcframework_zip(
                    asset_dir / ios_artifact,
                    f"liboliphaunt_extension_{row['native_module_stem']}.xcframework",
                    f"{sql_name} iOS SwiftPM extension artifact",
                )
                require_file(asset_dir / android_arm64_artifact, f"{sql_name} Android arm64 extension artifact")
                require_file(asset_dir / android_x86_64_artifact, f"{sql_name} Android x86_64 extension artifact")
                validate_android_extension_artifact(
                    asset_dir / android_arm64_artifact,
                    row,
                    "arm64-v8a",
                )
                validate_android_extension_artifact(
                    asset_dir / android_x86_64_artifact,
                    row,
                    "x86_64",
                )
                validate_recorded_bytes(
                    asset_dir,
                    ios_artifact,
                    row["ios_xcframework_artifact_bytes"],
                    f"{sql_name} iOS extension artifact",
                )
                validate_recorded_bytes(
                    asset_dir,
                    android_arm64_artifact,
                    row["android_arm64_artifact_bytes"],
                    f"{sql_name} Android arm64 extension artifact",
                )
                validate_recorded_bytes(
                    asset_dir,
                    android_x86_64_artifact,
                    row["android_x86_64_artifact_bytes"],
                    f"{sql_name} Android x86_64 extension artifact",
                )
            else:
                for column in [
                    "ios_xcframework_artifact",
                    "android_arm64_artifact",
                    "android_x86_64_artifact",
                    "ios_xcframework_artifact_bytes",
                    "android_arm64_artifact_bytes",
                    "android_x86_64_artifact_bytes",
                ]:
                    if row[column] != "-":
                        fail(f"{sql_name} {column} must be '-' when no mobile artifact is referenced")
        if row_count == 0:
            fail(f"{index_file} contains no extension rows")


def validate_recorded_bytes(
    asset_dir: Path,
    artifact: str,
    recorded: str,
    description: str,
) -> None:
    if artifact == "-":
        if recorded != "-":
            fail(f"{description} byte count must be '-' when artifact is '-'")
        return
    try:
        expected = int(recorded)
    except ValueError:
        fail(f"{description} byte count is not an integer: {recorded!r}")
    actual = (asset_dir / artifact).stat().st_size
    if expected != actual:
        fail(f"{description} byte count mismatch for {artifact}: expected {expected}, got {actual}")


def parse_size_value(value: str, path: Path, line_number: int, field: str) -> int:
    try:
        parsed = int(value)
    except ValueError:
        fail(f"{path} line {line_number} has invalid {field}: {value!r}")
    if parsed < 0:
        fail(f"{path} line {line_number} has negative {field}: {value!r}")
    return parsed


def validate_package_size_report(path: Path) -> None:
    require_file(path, "liboliphaunt package-size release report")
    with path.open("r", encoding="utf-8", newline="") as file:
        reader = csv.DictReader(file, delimiter="\t")
        expected_header = ["kind", "id", "extensions", "files", "bytes"]
        if reader.fieldnames != expected_header:
            fail(f"{path} has unexpected header: {reader.fieldnames}")
        rows: dict[tuple[str, str], dict[str, str]] = {}
        extension_rows: list[str] = []
        for line_number, row in enumerate(reader, start=2):
            key = (row["kind"], row["id"])
            if key in rows:
                fail(f"{path} repeats row {row['kind']}/{row['id']}")
            rows[key] = row
            parse_size_value(row["bytes"], path, line_number, "bytes")
            if row["kind"] == "extension":
                extension_rows.append(row["id"])
                parse_size_value(row["files"], path, line_number, "files")
            elif row["files"] != "-":
                fail(f"{path} line {line_number} package rows must use '-' for files")

    required_rows = [
        ("package", "total"),
        ("package", "runtime"),
        ("package", "template-pgdata"),
        ("package", "static-registry"),
        ("extensions", "selected"),
    ]
    missing = [f"{kind}/{identifier}" for kind, identifier in required_rows if (kind, identifier) not in rows]
    if missing:
        fail(f"{path} is missing required row(s): {', '.join(missing)}")
    if rows[("extensions", "selected")]["bytes"] != "0":
        fail(f"{path} base package-size report must have zero selected extension bytes")
    if extension_rows:
        fail(
            f"{path} base package-size report must not include selected extension rows: "
            + ", ".join(sorted(extension_rows))
        )
    total = parse_size_value(rows[("package", "total")]["bytes"], path, 0, "package total bytes")
    parts = sum(
        parse_size_value(rows[key]["bytes"], path, 0, f"{key[0]}/{key[1]} bytes")
        for key in [
            ("package", "runtime"),
            ("package", "template-pgdata"),
            ("package", "static-registry"),
        ]
    )
    if total != parts:
        fail(f"{path} package total bytes must equal runtime + template-pgdata + static-registry")


def validate_swiftpm_xcframework_zip(path: Path, expected_xcframework: str, description: str) -> None:
    if path.suffix != ".zip":
        fail(f"{description} must be a SwiftPM-compatible XCFramework .zip artifact: {path.name}")
    try:
        with zipfile.ZipFile(path) as archive:
            names = archive.namelist()
    except zipfile.BadZipFile:
        fail(f"{description} is not a valid zip archive: {path}")
    info_plist = f"{expected_xcframework}/Info.plist"
    if info_plist not in names:
        fail(f"{description} must contain {info_plist}")
    nested_manifests = [name for name in names if name.endswith("/manifest.properties")]
    if nested_manifests:
        fail(
            f"{description} must contain exactly the XCFramework for SwiftPM, "
            "not the generic staged extension tarball layout"
        )


def validate(asset_dir: Path) -> None:
    version = product_metadata.read_current_version("liboliphaunt-native")
    metadata = generated_extension_metadata()
    required = artifact_targets.expected_assets("liboliphaunt-native", version, surface="github-release")
    expected = set(required)
    actual = {path.name for path in asset_dir.iterdir() if path.is_file()}
    missing = sorted(expected - actual)
    if missing:
        fail("liboliphaunt-native release asset directory is missing expected assets: " + ", ".join(missing))
    unexpected = sorted(actual - expected)
    if unexpected:
        fail("liboliphaunt-native release asset directory contains unexpected assets: " + ", ".join(unexpected))
    for filename in required:
        require_file(asset_dir / filename, f"liboliphaunt release artifact {filename}")
    leaked_extension_assets = sorted(
        path.name
        for path in asset_dir.iterdir()
        if path.is_file()
        and "extension" in path.name
        and not path.name.endswith("-release-assets.sha256")
    )
    if leaked_extension_assets:
        fail(
            "liboliphaunt-native release assets must not include exact-extension artifacts; "
            "publish them through oliphaunt-extension-* products instead: "
            + ", ".join(leaked_extension_assets)
        )
    validate_base_runtime_artifact_contents(
        asset_dir / f"liboliphaunt-{version}-runtime-resources.tar.gz",
        metadata,
    )
    validate_icu_data_artifact_contents(asset_dir / f"liboliphaunt-{version}-icu-data.tar.gz")
    validate_package_size_report(asset_dir / f"liboliphaunt-{version}-package-size.tsv")
    validate_checksums(asset_dir, asset_dir / f"liboliphaunt-{version}-release-assets.sha256")


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--asset-dir",
        default="target/liboliphaunt/release-assets",
        help="directory containing liboliphaunt release assets",
    )
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    asset_dir = (ROOT / args.asset_dir).resolve()
    if not asset_dir.is_dir():
        fail(f"release asset directory does not exist: {asset_dir}")
    validate(asset_dir)
    print(f"liboliphaunt release assets validated: {asset_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
