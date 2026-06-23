#!/usr/bin/env python3
"""Render the public SwiftPM manifest for an Oliphaunt Apple SDK release."""

from __future__ import annotations

import argparse
import hashlib
import plistlib
import shutil
import sys
import tarfile
import urllib.error
import urllib.request
import zipfile
from pathlib import Path
from typing import NoReturn

import product_metadata


ROOT = Path(__file__).resolve().parents[2]
REPOSITORY = "f0rr0/oliphaunt"


def fail(message: str) -> NoReturn:
    print(f"render_swiftpm_release_package.py: {message}", file=sys.stderr)
    raise SystemExit(1)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as file:
        for chunk in iter(lambda: file.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def checksum_from_manifest(text: str, asset: str) -> str | None:
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        parts = line.split()
        if len(parts) != 2:
            continue
        digest, filename = parts
        if filename == f"./{asset}" or filename == asset:
            return digest
    return None


def validate_apple_xcframework_asset(path: Path) -> None:
    try:
        with zipfile.ZipFile(path) as archive:
            try:
                info_data = archive.read("liboliphaunt.xcframework/Info.plist")
            except KeyError:
                fail(f"SwiftPM Apple XCFramework asset is missing liboliphaunt.xcframework/Info.plist: {path}")
            try:
                info = plistlib.loads(info_data)
            except Exception as error:
                fail(f"SwiftPM Apple XCFramework Info.plist is invalid in {path}: {error}")
            if not isinstance(info, dict):
                fail(f"SwiftPM Apple XCFramework Info.plist must be a plist dictionary in {path}")
            libraries = info.get("AvailableLibraries")
            if not isinstance(libraries, list) or not libraries:
                fail(f"SwiftPM Apple XCFramework Info.plist has no AvailableLibraries in {path}")
            archive_names = set(archive.namelist())
            platforms: set[tuple[str, str]] = set()
            for library in libraries:
                if not isinstance(library, dict):
                    continue
                platform = library.get("SupportedPlatform")
                variant = library.get("SupportedPlatformVariant", "")
                library_path = library.get("LibraryPath")
                identifier = library.get("LibraryIdentifier")
                if not isinstance(platform, str) or not isinstance(library_path, str) or not isinstance(identifier, str):
                    continue
                platforms.add((platform, variant if isinstance(variant, str) else ""))
                candidate = f"liboliphaunt.xcframework/{identifier}/{library_path}"
                if candidate not in archive_names and not any(name.startswith(f"{candidate}/") for name in archive_names):
                    fail(f"SwiftPM Apple XCFramework is missing declared library {candidate}")
    except zipfile.BadZipFile as error:
        fail(f"SwiftPM Apple XCFramework asset is not a readable zip file: {path}: {error}")

    required = {("macos", ""), ("ios", ""), ("ios", "simulator")}
    missing = required - platforms
    if missing:
        rendered = ", ".join(f"{platform}{('-' + variant) if variant else ''}" for platform, variant in sorted(missing))
        fail(f"SwiftPM Apple XCFramework asset {path} is missing required slice(s): {rendered}")


def prepare_icu_resource_tree(asset_dir: Path, version: str, generated_tree: Path | None) -> None:
    if generated_tree is None:
        return
    archive_path = asset_dir / f"liboliphaunt-{version}-icu-data.tar.gz"
    if not archive_path.is_file():
        fail(f"SwiftPM ICU resource product requires local ICU data asset: {archive_path}")
    target = generated_tree / "generated/swiftpm/OliphauntICU"
    shutil.rmtree(target, ignore_errors=True)
    (target / "share/icu").mkdir(parents=True, exist_ok=True)
    try:
        with tarfile.open(archive_path, "r:*") as archive:
            copied = 0
            for member in archive.getmembers():
                name = member.name.removeprefix("./").rstrip("/")
                if name == "share/icu" or not name.startswith("share/icu/"):
                    continue
                relative = Path(name).relative_to("share/icu")
                if relative.is_absolute() or ".." in relative.parts:
                    fail(f"SwiftPM ICU data asset contains unsafe path: {member.name}")
                destination = target / "share/icu" / relative
                if member.isdir():
                    destination.mkdir(parents=True, exist_ok=True)
                    continue
                if not member.isfile():
                    fail(f"SwiftPM ICU data asset member must be a regular file: {member.name}")
                extracted = archive.extractfile(member)
                if extracted is None:
                    fail(f"SwiftPM ICU data asset member could not be read: {member.name}")
                destination.parent.mkdir(parents=True, exist_ok=True)
                with extracted:
                    destination.write_bytes(extracted.read())
                copied += 1
    except tarfile.TarError as error:
        fail(f"SwiftPM ICU data asset is not a readable tar archive: {archive_path}: {error}")
    if copied == 0 or not any(path.name.startswith("icudt") for path in (target / "share/icu").iterdir()):
        fail(f"SwiftPM ICU resource product did not extract ICU icudt data from {archive_path}")
    (target / "OliphauntICU.swift").write_text(
        "public enum OliphauntICUResources {\n"
        "    public static let bundled = true\n"
        "}\n",
        encoding="utf-8",
    )


def resolve_checksum(asset_dir: Path, asset_base_url: str, asset: str, version: str) -> str:
    local_asset = asset_dir / asset
    if local_asset.is_file():
        if local_asset.stat().st_size <= 0:
            fail(f"SwiftPM Apple XCFramework asset is empty: {local_asset}")
        validate_apple_xcframework_asset(local_asset)
        return sha256(local_asset)

    local_manifest = asset_dir / f"liboliphaunt-{version}-release-assets.sha256"
    if local_manifest.is_file():
        checksum = checksum_from_manifest(local_manifest.read_text(encoding="utf-8"), asset)
        if checksum:
            return checksum

    manifest_url = f"{asset_base_url.rstrip('/')}/liboliphaunt-{version}-release-assets.sha256"
    try:
        with urllib.request.urlopen(manifest_url, timeout=20) as response:
            text = response.read().decode("utf-8")
    except (OSError, UnicodeDecodeError, urllib.error.URLError) as error:
        fail(
            f"SwiftPM asset {asset} is not present in {asset_dir}, and checksum "
            f"manifest could not be read from {manifest_url}: {error}"
        )
    checksum = checksum_from_manifest(text, asset)
    if not checksum:
        fail(f"checksum manifest {manifest_url} does not contain {asset}")
    return checksum


def render_manifest(
    asset_dir: Path,
    asset_base_url: str,
    liboliphaunt_version: str,
    checksum: str,
    generated_tree: Path | None,
) -> str:
    asset = f"liboliphaunt-{liboliphaunt_version}-apple-spm-xcframework.zip"
    url = f"{asset_base_url.rstrip('/')}/{asset}"
    if generated_tree is not None:
        generated_tree.mkdir(parents=True, exist_ok=True)
    return f"""// swift-tools-version: 6.0

import PackageDescription

// Generated by tools/release/render_swiftpm_release_package.py.
// This is the public SwiftPM release manifest. The source package under
// src/sdks/swift remains the local development package.
// Exact PostgreSQL extensions are released as separate opt-in extension
// artifacts. The base Swift package must not require or publish extension files.
let package = Package(
    name: "Oliphaunt",
    platforms: [
        .iOS(.v17),
        .macOS(.v14)
    ],
    products: [
        .library(name: "Oliphaunt", targets: ["Oliphaunt"]),
        .library(name: "OliphauntICU", targets: ["OliphauntICU"])
    ],
    targets: [
        .binaryTarget(
            name: "liboliphaunt",
            url: "{url}",
            checksum: "{checksum}"
        ),
        .target(
            name: "COliphaunt",
            dependencies: ["liboliphaunt"],
            path: "src/sdks/swift/Sources/COliphaunt",
            publicHeadersPath: "include"
        ),
        .target(
            name: "Oliphaunt",
            dependencies: ["COliphaunt"],
            path: "src/sdks/swift/Sources/Oliphaunt"
        ),
        .target(
            name: "OliphauntICU",
            path: "generated/swiftpm/OliphauntICU",
            resources: [.copy("share")]
        )
    ]
)
"""


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--asset-dir",
        default="target/liboliphaunt/release-assets",
        help="directory containing liboliphaunt release assets",
    )
    parser.add_argument(
        "--asset-base-url",
        help="base URL for liboliphaunt release assets; defaults to the GitHub release URL",
    )
    parser.add_argument(
        "--output",
        help="write the rendered manifest here; stdout is used when omitted",
    )
    parser.add_argument(
        "--generated-tree",
        help=(
            "create the generated SwiftPM release tree root; exact extension "
            "artifacts are released as separate opt-in products"
        ),
    )
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    liboliphaunt_version = product_metadata.read_current_version("liboliphaunt-native")
    asset_dir = (ROOT / args.asset_dir).resolve()
    asset = f"liboliphaunt-{liboliphaunt_version}-apple-spm-xcframework.zip"
    base_url = args.asset_base_url or (
        f"https://github.com/{REPOSITORY}/releases/download/liboliphaunt-native-v{liboliphaunt_version}"
    )
    checksum = resolve_checksum(asset_dir, base_url, asset, liboliphaunt_version)
    generated_tree = (ROOT / args.generated_tree).resolve() if args.generated_tree else None
    prepare_icu_resource_tree(asset_dir, liboliphaunt_version, generated_tree)
    manifest = render_manifest(asset_dir, base_url, liboliphaunt_version, checksum, generated_tree)
    if args.output:
        output = ROOT / args.output
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(manifest, encoding="utf-8")
    else:
        print(manifest, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
