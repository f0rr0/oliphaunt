#!/usr/bin/env python3
"""Create small liboliphaunt release-shaped assets for SDK package checks.

The generated assets are not runnable PostgreSQL builds. They intentionally
exercise the consumer-facing release contract: product-scoped asset names,
checksums, archive layouts, and runtime-resource extraction.
"""

from __future__ import annotations

import argparse
import plistlib
from pathlib import Path

from release_fixture_utils import write_checksum_manifest, write_tar_gz, write_zip


NATIVE_TOOL_STEMS = ("initdb", "pg_ctl", "pg_dump", "postgres", "psql")


def native_runtime_entries(*, windows: bool = False) -> dict[str, bytes]:
    suffix = ".exe" if windows else ""
    entries = {
        f"runtime/bin/{tool}{suffix}": f"not-a-real-{tool}{suffix}\n".encode("utf-8")
        for tool in NATIVE_TOOL_STEMS
    }
    entries["runtime/share/postgresql/README.release-fixture"] = b"release-shaped native runtime fixture\n"
    return entries


def native_runtime_modes(*, windows: bool = False) -> dict[str, int]:
    suffix = ".exe" if windows else ""
    return {f"runtime/bin/{tool}{suffix}": 0o755 for tool in NATIVE_TOOL_STEMS}


def runtime_resource_entries() -> dict[str, bytes]:
    return {
        "oliphaunt/package-size.tsv": (
            b"kind\tid\textensions\tfiles\tbytes\n"
            b"package\ttotal\t-\t-\t96\n"
            b"package\truntime\t-\t-\t31\n"
            b"package\ttemplate-pgdata\t-\t-\t20\n"
            b"package\tstatic-registry\t-\t-\t45\n"
            b"extensions\tselected\t-\t-\t0\n"
        ),
        "oliphaunt/runtime/files/share/postgresql/README.release-fixture": (
            b"release-shaped runtime fixture\n"
        ),
        "oliphaunt/static-registry/manifest.properties": (
            b"schema=oliphaunt-static-registry-v1\n"
            b"registered=\n"
            b"pending=\n"
        ),
        "oliphaunt/runtime/manifest.properties": (
            b"schema=oliphaunt-runtime-resources-v1\n"
            b"cacheKey=release-fixture-runtime\n"
            b"layout=postgres-runtime-files-v1\n"
            b"extensions=\n"
            b"runtimeFeatures=\n"
            b"sharedPreloadLibraries=\n"
            b"mobileStaticRegistryState=not-required\n"
            b"mobileStaticRegistryRegistered=\n"
            b"mobileStaticRegistryPending=\n"
            b"nativeModuleStems=\n"
            b"mobileStaticRegistrySource=\n"
        ),
        "oliphaunt/template-pgdata/files/PG_VERSION": b"18\n",
        "oliphaunt/template-pgdata/manifest.properties": (
            b"schema=oliphaunt-runtime-resources-v1\n"
            b"cacheKey=release-fixture-template\n"
            b"layout=postgres-template-pgdata-v1\n"
            b"extensions=\n"
            b"runtimeFeatures=\n"
            b"sharedPreloadLibraries=\n"
            b"mobileStaticRegistryState=not-required\n"
            b"mobileStaticRegistryRegistered=\n"
            b"mobileStaticRegistryPending=\n"
            b"nativeModuleStems=\n"
            b"mobileStaticRegistrySource=\n"
        ),
    }


def xcframework_entries() -> dict[str, bytes]:
    libraries = [
        {
            "LibraryIdentifier": "macos-arm64",
            "LibraryPath": "liboliphaunt.framework",
            "SupportedArchitectures": ["arm64"],
            "SupportedPlatform": "macos",
        },
        {
            "LibraryIdentifier": "ios-arm64",
            "LibraryPath": "liboliphaunt.framework",
            "SupportedArchitectures": ["arm64"],
            "SupportedPlatform": "ios",
        },
        {
            "LibraryIdentifier": "ios-arm64_x86_64-simulator",
            "LibraryPath": "liboliphaunt.framework",
            "SupportedArchitectures": ["arm64", "x86_64"],
            "SupportedPlatform": "ios",
            "SupportedPlatformVariant": "simulator",
        },
    ]
    info = plistlib.dumps(
        {
            "AvailableLibraries": libraries,
            "CFBundlePackageType": "XFWK",
            "XCFrameworkFormatVersion": "1.0",
        },
        sort_keys=True,
    )
    entries = {"liboliphaunt.xcframework/Info.plist": info}
    for library in libraries:
        identifier = library["LibraryIdentifier"]
        framework_root = f"liboliphaunt.xcframework/{identifier}/liboliphaunt.framework"
        entries[f"{framework_root}/liboliphaunt"] = b"not-a-real-framework-binary\n"
        entries[f"{framework_root}/Info.plist"] = plistlib.dumps(
            {
                "CFBundleExecutable": "liboliphaunt",
                "CFBundleIdentifier": "dev.oliphaunt.liboliphaunt.fixture",
                "CFBundleName": "liboliphaunt",
                "CFBundlePackageType": "FMWK",
            },
            sort_keys=True,
        )
    return entries


def write_fixture_assets(asset_dir: Path, version: str) -> None:
    asset_dir.mkdir(parents=True, exist_ok=True)

    (asset_dir / f"liboliphaunt-{version}-package-size.tsv").write_text(
        "\n".join(
            [
                "kind\tid\textensions\tfiles\tbytes",
                "package\ttotal\t-\t-\t96",
                "package\truntime\t-\t-\t31",
                "package\ttemplate-pgdata\t-\t-\t20",
                "package\tstatic-registry\t-\t-\t45",
                "extensions\tselected\t-\t-\t0",
            ]
        )
        + "\n",
        encoding="utf-8",
    )

    write_tar_gz(
        asset_dir / f"liboliphaunt-{version}-runtime-resources.tar.gz",
        runtime_resource_entries(),
    )
    write_tar_gz(
        asset_dir / f"liboliphaunt-{version}-icu-data.tar.gz",
        {"share/icu/icudt76l.dat": b"not-real-icu-data\n"},
    )
    write_tar_gz(
        asset_dir / f"liboliphaunt-{version}-macos-arm64.tar.gz",
        {
            "lib/liboliphaunt.dylib": b"not-a-real-dylib\n",
            "lib/modules/plpgsql.dylib": b"not-a-real-module\n",
            **native_runtime_entries(),
        },
        modes=native_runtime_modes(),
    )
    write_tar_gz(
        asset_dir / f"liboliphaunt-{version}-linux-x64-gnu.tar.gz",
        {
            "lib/liboliphaunt.so": b"not-a-real-elf\n",
            "lib/modules/plpgsql.so": b"not-a-real-module\n",
            **native_runtime_entries(),
        },
        modes=native_runtime_modes(),
    )
    write_tar_gz(
        asset_dir / f"liboliphaunt-{version}-linux-arm64-gnu.tar.gz",
        {
            "lib/liboliphaunt.so": b"not-a-real-elf\n",
            "lib/modules/plpgsql.so": b"not-a-real-module\n",
            **native_runtime_entries(),
        },
        modes=native_runtime_modes(),
    )
    write_tar_gz(
        asset_dir / f"liboliphaunt-{version}-ios-xcframework.tar.gz",
        xcframework_entries(),
    )
    write_tar_gz(
        asset_dir / f"liboliphaunt-{version}-android-arm64-v8a.tar.gz",
        {"jni/arm64-v8a/liboliphaunt.so": b"not-a-real-android-elf\n"},
    )
    write_tar_gz(
        asset_dir / f"liboliphaunt-{version}-android-x86_64.tar.gz",
        {"jni/x86_64/liboliphaunt.so": b"not-a-real-android-elf\n"},
    )
    write_zip(
        asset_dir / f"liboliphaunt-{version}-windows-x64-msvc.zip",
        {
            "bin/oliphaunt.dll": b"not-a-real-dll\n",
            "lib/modules/plpgsql.dll": b"not-a-real-module\n",
            **native_runtime_entries(windows=True),
        },
        modes=native_runtime_modes(windows=True),
    )
    write_zip(
        asset_dir / f"liboliphaunt-{version}-apple-spm-xcframework.zip",
        xcframework_entries(),
    )

    write_checksum_manifest(asset_dir, f"liboliphaunt-{version}-release-assets.sha256")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--asset-dir", required=True, help="directory to write release-shaped assets into")
    parser.add_argument("--version", required=True, help="liboliphaunt version to encode in asset names")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    write_fixture_assets(Path(args.asset_dir).resolve(), args.version)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
