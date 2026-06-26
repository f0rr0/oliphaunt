#!/usr/bin/env python3
"""Release artifact target metadata derived from Moon release metadata.

Moon owns release-product identity and target membership. This module expands
compact product presets into concrete release asset rows so package managers,
CI matrices, and validators all read the same artifact graph.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

import product_metadata

ROOT = Path(__file__).resolve().parents[2]

DESKTOP_TARGETS: dict[str, dict[str, str]] = {
    "linux-arm64-gnu": {
        "triple": "aarch64-unknown-linux-gnu",
        "runner": "ubuntu-24.04-arm",
        "archive": "tar.gz",
        "npm_os": "linux",
        "npm_cpu": "arm64",
        "npm_libc": "glibc",
        "liboliphaunt_npm_package": "@oliphaunt/liboliphaunt-linux-arm64-gnu",
        "liboliphaunt_tools_npm_package": "@oliphaunt/tools-linux-arm64-gnu",
        "broker_npm_package": "@oliphaunt/broker-linux-arm64-gnu",
        "node_package": "@oliphaunt/node-direct-linux-arm64-gnu",
        "wasix_llvm_url": "https://github.com/wasmerio/llvm-custom-builds/releases/download/22.x/llvm-linux-aarch64.tar.xz",
    },
    "linux-x64-gnu": {
        "triple": "x86_64-unknown-linux-gnu",
        "runner": "ubuntu-latest",
        "archive": "tar.gz",
        "npm_os": "linux",
        "npm_cpu": "x64",
        "npm_libc": "glibc",
        "liboliphaunt_npm_package": "@oliphaunt/liboliphaunt-linux-x64-gnu",
        "liboliphaunt_tools_npm_package": "@oliphaunt/tools-linux-x64-gnu",
        "broker_npm_package": "@oliphaunt/broker-linux-x64-gnu",
        "node_package": "@oliphaunt/node-direct-linux-x64-gnu",
        "wasix_llvm_url": "https://github.com/wasmerio/llvm-custom-builds/releases/download/22.x/llvm-linux-amd64.tar.xz",
    },
    "macos-arm64": {
        "triple": "aarch64-apple-darwin",
        "runner": "macos-latest",
        "archive": "tar.gz",
        "npm_os": "darwin",
        "npm_cpu": "arm64",
        "liboliphaunt_npm_package": "@oliphaunt/liboliphaunt-darwin-arm64",
        "liboliphaunt_tools_npm_package": "@oliphaunt/tools-darwin-arm64",
        "broker_npm_package": "@oliphaunt/broker-darwin-arm64",
        "node_package": "@oliphaunt/node-direct-darwin-arm64",
        "wasix_llvm_url": "https://github.com/wasmerio/llvm-custom-builds/releases/download/22.x/llvm-darwin-aarch64.tar.xz",
    },
    "macos-x64": {
        "triple": "x86_64-apple-darwin",
        "runner": "macos-latest",
        "archive": "tar.gz",
    },
    "windows-x64-msvc": {
        "triple": "x86_64-pc-windows-msvc",
        "runner": "windows-latest",
        "archive": "zip",
        "npm_os": "win32",
        "npm_cpu": "x64",
        "liboliphaunt_npm_package": "@oliphaunt/liboliphaunt-win32-x64-msvc",
        "liboliphaunt_tools_npm_package": "@oliphaunt/tools-win32-x64-msvc",
        "broker_npm_package": "@oliphaunt/broker-win32-x64-msvc",
        "node_package": "@oliphaunt/node-direct-win32-x64-msvc",
        "wasix_llvm_url": "https://github.com/wasmerio/llvm-custom-builds/releases/download/22.x/llvm-windows-amd64.tar.xz",
    },
}

MOBILE_TARGETS: dict[str, dict[str, str]] = {
    "android-arm64-v8a": {
        "triple": "aarch64-linux-android",
        "runner": "ubuntu-latest",
        "android_abi": "arm64-v8a",
    },
    "android-x86_64": {
        "triple": "x86_64-linux-android",
        "runner": "ubuntu-latest",
        "android_abi": "x86_64",
    },
    "ios-xcframework": {
        "triple": "ios-xcframework",
        "runner": "macos-26",
    },
}

NATIVE_RUNTIME_TARGETS = {**DESKTOP_TARGETS, **MOBILE_TARGETS}
WASIX_TARGETS = {"portable", "linux-arm64-gnu", "linux-x64-gnu", "macos-arm64", "windows-x64-msvc"}
BROKER_TARGETS = {"linux-arm64-gnu", "linux-x64-gnu", "macos-arm64", "windows-x64-msvc"}
NODE_DIRECT_TARGETS = BROKER_TARGETS


def liboliphaunt_native_build_root(target_id: str) -> str:
    if target_id not in NATIVE_RUNTIME_TARGETS:
        product_metadata.fail(f"unknown liboliphaunt-native target {target_id}")
    build_roots = {
        "macos-arm64": "target/liboliphaunt-pg18",
        "android-arm64-v8a": "target/liboliphaunt-pg18-android-arm64",
        "android-x86_64": "target/liboliphaunt-pg18-android-x86_64",
        "ios-xcframework": "target/liboliphaunt-ios-xcframework",
    }
    return build_roots.get(target_id, f"target/liboliphaunt-pg18-{target_id}")


def liboliphaunt_native_ci_artifact_root(target_id: str) -> str:
    if target_id not in NATIVE_RUNTIME_TARGETS:
        product_metadata.fail(f"unknown liboliphaunt-native target {target_id}")
    return f"target/liboliphaunt-native-ci/{target_id}"


def liboliphaunt_android_abi(target_id: str) -> str:
    metadata = MOBILE_TARGETS.get(target_id)
    abi = metadata.get("android_abi") if metadata is not None else None
    if not abi:
        product_metadata.fail(f"unsupported React Native Android runtime target {target_id}")
    return abi


@dataclass(frozen=True)
class ArtifactTarget:
    id: str
    product: str
    kind: str
    target: str
    asset: str
    published: bool
    surfaces: tuple[str, ...]
    triple: str | None = None
    runner: str | None = None
    library_relative_path: str | None = None
    executable_relative_path: str | None = None
    npm_package: str | None = None
    npm_os: str | None = None
    npm_cpu: str | None = None
    npm_libc: str | None = None
    llvm_url: str | None = None
    extension_artifacts: bool = True

    def asset_name(self, version: str) -> str:
        return self.asset.format(version=version)


def _string(value: object, key: str, target_id: str, required: bool = True) -> str | None:
    if isinstance(value, str) and value:
        return value
    if required:
        product_metadata.fail(f"artifact target {target_id}.{key} must be a non-empty string")
    if value is not None:
        product_metadata.fail(f"artifact target {target_id}.{key} must be a string")
    return None


def _surfaces(value: object, target_id: str) -> tuple[str, ...]:
    if not isinstance(value, list) or not value or not all(isinstance(item, str) and item for item in value):
        product_metadata.fail(f"artifact target {target_id}.surfaces must be a non-empty string list")
    return tuple(value)


def _published(value: object, target_id: str) -> bool:
    if isinstance(value, bool):
        return value
    product_metadata.fail(f"artifact target {target_id}.published must be true or false")


def _optional_bool(value: object, key: str, target_id: str, default: bool) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    product_metadata.fail(f"artifact target {target_id}.{key} must be true or false")


def _release_target_config(product: str, expected_preset: str) -> dict:
    release = product_metadata.moon_release_metadata(product)
    config = release.get("artifactTargets")
    if not isinstance(config, dict):
        product_metadata.fail(f"Moon release metadata for {product} must declare artifactTargets")
    preset = config.get("preset")
    if preset != expected_preset:
        product_metadata.fail(
            f"Moon release metadata for {product} artifactTargets.preset must be "
            f"{expected_preset!r}, got {preset!r}"
        )
    return config


def _target_list(config: dict, product: str, key: str) -> tuple[str, ...]:
    value = config.get(key, [])
    if not isinstance(value, list) or not all(isinstance(item, str) and item for item in value):
        product_metadata.fail(f"Moon release metadata for {product} artifactTargets.{key} must be a string list")
    if len(set(value)) != len(value):
        product_metadata.fail(f"Moon release metadata for {product} artifactTargets.{key} contains duplicate targets")
    return tuple(value)


def _planned_targets(config: dict, product: str) -> dict[str, dict]:
    value = config.get("plannedTargets", {})
    if not isinstance(value, dict):
        product_metadata.fail(f"Moon release metadata for {product} artifactTargets.plannedTargets must be a table")
    planned: dict[str, dict] = {}
    for target, details in value.items():
        if not isinstance(target, str) or not target:
            product_metadata.fail(f"Moon release metadata for {product} planned target keys must be non-empty strings")
        if not isinstance(details, dict):
            product_metadata.fail(f"Moon release metadata for {product} planned target {target} must be a table")
        reason = details.get("unsupportedReason")
        if not isinstance(reason, str) or len(reason.strip()) < 40:
            product_metadata.fail(
                f"Moon release metadata for {product} planned target {target} must declare a concrete unsupportedReason"
            )
        planned[target] = details
    return planned


def _check_known_targets(product: str, targets: Iterable[str], known: set[str]) -> None:
    unknown = sorted(set(targets) - known)
    if unknown:
        product_metadata.fail(f"Moon release metadata for {product} declares unknown artifact target(s): {unknown}")


def _archive_asset(product_prefix: str, target: str, archive: str) -> str:
    if archive == "zip":
        return f"{product_prefix}-{{version}}-{target}.zip"
    return f"{product_prefix}-{{version}}-{target}.tar.gz"


def _native_library_relative_path(target: str) -> str:
    if target.startswith("android-"):
        abi = MOBILE_TARGETS[target]["android_abi"]
        return f"jni/{abi}/liboliphaunt.so"
    if target == "ios-xcframework":
        return "liboliphaunt.xcframework"
    if target.startswith("macos-"):
        return "lib/liboliphaunt.dylib"
    if target.startswith("linux-"):
        return "lib/liboliphaunt.so"
    if target == "windows-x64-msvc":
        return "bin/oliphaunt.dll"
    product_metadata.fail(f"unsupported liboliphaunt native target {target}")


def _native_surfaces(target: str) -> list[str]:
    if target.startswith("android-"):
        return ["github-release", "maven", "react-native-android"]
    if target == "ios-xcframework":
        return ["github-release", "swiftpm", "react-native-ios"]
    return ["github-release", "rust-native-direct", "typescript-native-direct"]


def _liboliphaunt_native_target_tables() -> list[dict]:
    product = "liboliphaunt-native"
    config = _release_target_config(product, "liboliphaunt-native")
    published = set(_target_list(config, product, "publishedTargets"))
    planned = _planned_targets(config, product)
    _check_known_targets(product, [*published, *planned], set(NATIVE_RUNTIME_TARGETS))
    if published & set(planned):
        product_metadata.fail(f"Moon release metadata for {product} declares targets as both published and planned")

    rows: list[dict] = []
    for target in sorted([*published, *planned]):
        platform = NATIVE_RUNTIME_TARGETS[target]
        published_target = target in published
        row = {
            "id": f"{product}.{target}",
            "product": product,
            "kind": "native-runtime",
            "target": target,
            "triple": platform["triple"],
            "runner": platform["runner"],
            "asset": _archive_asset("liboliphaunt", target, platform.get("archive", "tar.gz")),
            "library_relative_path": _native_library_relative_path(target),
            "npm_package": platform.get("liboliphaunt_npm_package"),
            "npm_os": platform.get("npm_os"),
            "npm_cpu": platform.get("npm_cpu"),
            "npm_libc": platform.get("npm_libc"),
            "surfaces": _native_surfaces(target),
            "published": published_target,
            "_source_file": "Moon release metadata",
        }
        if not published_target:
            row["tier"] = "planned"
            row["unsupported_reason"] = planned[target]["unsupportedReason"]
        rows.append(row)

    rows.extend(
        [
            {
                "id": f"{product}.apple-spm-xcframework",
                "product": product,
                "kind": "apple-swiftpm-binary",
                "target": "apple-spm-xcframework",
                "triple": "apple-xcframework",
                "runner": "macos-latest",
                "asset": "liboliphaunt-{version}-apple-spm-xcframework.zip",
                "surfaces": ["github-release", "swiftpm"],
                "published": True,
                "_source_file": "Moon release metadata",
            },
            {
                "id": f"{product}.runtime-resources",
                "product": product,
                "kind": "runtime-resources",
                "target": "portable",
                "asset": "liboliphaunt-{version}-runtime-resources.tar.gz",
                "surfaces": ["github-release", "rust-native-direct", "typescript-native-direct", "swiftpm", "maven"],
                "published": True,
                "_source_file": "Moon release metadata",
            },
            {
                "id": f"{product}.icu-data",
                "product": product,
                "kind": "icu-data",
                "target": "portable",
                "asset": "liboliphaunt-{version}-icu-data.tar.gz",
                "npm_package": "@oliphaunt/icu",
                "surfaces": [
                    "github-release",
                    "rust-native-direct",
                    "typescript-native-direct",
                    "swiftpm",
                    "maven",
                    "react-native-ios",
                    "react-native-android",
                ],
                "published": True,
                "_source_file": "Moon release metadata",
            },
            {
                "id": f"{product}.package-size",
                "product": product,
                "kind": "package-footprint",
                "target": "portable",
                "asset": "liboliphaunt-{version}-package-size.tsv",
                "surfaces": [
                    "github-release",
                    "swiftpm",
                    "maven",
                    "react-native-ios",
                    "react-native-android",
                    "rust-native-direct",
                    "typescript-native-direct",
                ],
                "published": True,
                "_source_file": "Moon release metadata",
            },
            {
                "id": f"{product}.checksums",
                "product": product,
                "kind": "checksums",
                "target": "portable",
                "asset": "liboliphaunt-{version}-release-assets.sha256",
                "surfaces": ["github-release"],
                "published": True,
                "_source_file": "Moon release metadata",
            },
        ]
    )
    for target in sorted(published & set(DESKTOP_TARGETS)):
        platform = DESKTOP_TARGETS[target]
        rows.append(
            {
                "id": f"{product}.tools-{target}",
                "product": product,
                "kind": "native-tools",
                "target": target,
                "triple": platform["triple"],
                "runner": platform["runner"],
                "asset": _archive_asset("oliphaunt-tools", target, platform.get("archive", "tar.gz")),
                "npm_package": platform.get("liboliphaunt_tools_npm_package"),
                "npm_os": platform.get("npm_os"),
                "npm_cpu": platform.get("npm_cpu"),
                "npm_libc": platform.get("npm_libc"),
                "surfaces": ["github-release", "rust-native-direct", "typescript-native-direct"],
                "published": True,
                "_source_file": "Moon release metadata",
            }
        )
    return rows


def _liboliphaunt_wasix_target_tables() -> list[dict]:
    product = "liboliphaunt-wasix"
    config = _release_target_config(product, "liboliphaunt-wasix")
    published = set(_target_list(config, product, "publishedTargets"))
    _check_known_targets(product, published, WASIX_TARGETS)
    if "portable" not in published:
        product_metadata.fail(f"Moon release metadata for {product} must publish the portable runtime target")

    rows: list[dict] = [
        {
            "id": f"{product}.runtime-portable",
            "product": product,
            "kind": "wasix-runtime",
            "target": "portable",
            "asset": "liboliphaunt-wasix-{version}-runtime-portable.tar.zst",
            "surfaces": ["github-release"],
            "published": True,
            "_source_file": "Moon release metadata",
        }
    ]
    rows.append(
        {
            "id": f"{product}.icu-data",
            "product": product,
            "kind": "icu-data",
            "target": "portable",
            "asset": "liboliphaunt-wasix-{version}-icu-data.tar.zst",
            "surfaces": ["github-release"],
            "published": True,
            "_source_file": "Moon release metadata",
        }
    )
    for target in sorted(published - {"portable"}):
        platform = DESKTOP_TARGETS[target]
        rows.append(
            {
                "id": f"{product}.aot-{target}",
                "product": product,
                "kind": "wasix-aot-runtime",
                "target": target,
                "triple": platform["triple"],
                "runner": platform["runner"],
                "llvm_url": platform["wasix_llvm_url"],
                "asset": f"liboliphaunt-wasix-{{version}}-runtime-aot-{target}.tar.zst",
                "surfaces": ["github-release"],
                "published": True,
                "_source_file": "Moon release metadata",
            }
        )
    rows.append(
        {
            "id": f"{product}.checksums",
            "product": product,
            "kind": "checksums",
            "target": "portable",
            "asset": "liboliphaunt-wasix-{version}-release-assets.sha256",
            "surfaces": ["github-release"],
            "published": True,
            "_source_file": "Moon release metadata",
        }
    )
    return rows


def _broker_target_tables() -> list[dict]:
    product = "oliphaunt-broker"
    config = _release_target_config(product, "broker-helper")
    published = set(_target_list(config, product, "publishedTargets"))
    _check_known_targets(product, published, BROKER_TARGETS)
    rows: list[dict] = []
    for target in sorted(published):
        platform = DESKTOP_TARGETS[target]
        rows.append(
            {
                "id": f"{product}.{target}",
                "product": product,
                "kind": "broker-helper",
                "target": target,
                "triple": platform["triple"],
                "runner": platform["runner"],
                "asset": _archive_asset("oliphaunt-broker", target, platform["archive"]),
                "executable_relative_path": "bin/oliphaunt-broker.exe" if target == "windows-x64-msvc" else "bin/oliphaunt-broker",
                "npm_package": platform["broker_npm_package"],
                "npm_os": platform.get("npm_os"),
                "npm_cpu": platform.get("npm_cpu"),
                "npm_libc": platform.get("npm_libc"),
                "surfaces": ["github-release", "rust-broker", "typescript-broker"],
                "published": True,
                "_source_file": "Moon release metadata",
            }
        )
    rows.append(
        {
            "id": f"{product}.checksums",
            "product": product,
            "kind": "checksums",
            "target": "portable",
            "asset": "oliphaunt-broker-{version}-release-assets.sha256",
            "surfaces": ["github-release", "rust-broker", "typescript-broker"],
            "published": True,
            "_source_file": "Moon release metadata",
        }
    )
    return rows


def _node_direct_target_tables() -> list[dict]:
    product = "oliphaunt-node-direct"
    config = _release_target_config(product, "node-direct-addon")
    published = set(_target_list(config, product, "publishedTargets"))
    _check_known_targets(product, published, NODE_DIRECT_TARGETS)
    rows: list[dict] = []
    for target in sorted(published):
        platform = DESKTOP_TARGETS[target]
        rows.append(
            {
                "id": f"{product}.{target}",
                "product": product,
                "kind": "node-direct-addon",
                "target": target,
                "triple": platform["triple"],
                "runner": platform["runner"],
                "asset": _archive_asset("oliphaunt-node-direct", target, platform["archive"]),
                "library_relative_path": "oliphaunt_node.node",
                "npm_package": platform["node_package"],
                "npm_os": platform.get("npm_os"),
                "npm_cpu": platform.get("npm_cpu"),
                "npm_libc": platform.get("npm_libc"),
                "surfaces": ["github-release", "npm-optional"],
                "published": True,
                "_source_file": "Moon release metadata",
            }
        )
    rows.append(
        {
            "id": f"{product}.checksums",
            "product": product,
            "kind": "checksums",
            "target": "portable",
            "asset": "oliphaunt-node-direct-{version}-release-assets.sha256",
            "surfaces": ["github-release"],
            "published": True,
            "_source_file": "Moon release metadata",
        }
    )
    return rows


def _moon_target_tables() -> list[dict]:
    return [
        *_liboliphaunt_native_target_tables(),
        *_liboliphaunt_wasix_target_tables(),
        *_broker_target_tables(),
        *_node_direct_target_tables(),
    ]


def raw_artifact_target_tables(graph: dict | None = None) -> list[dict]:
    """Return artifact target tables from Moon release metadata."""

    data = graph if graph is not None else product_metadata.load_graph()
    graph_targets = data.get("artifact_targets", [])
    if not isinstance(graph_targets, list):
        product_metadata.fail("compatibility artifact_targets must be an array of tables")
    tables: list[dict] = _moon_target_tables()
    for raw in graph_targets:
        if not isinstance(raw, dict):
            product_metadata.fail("compatibility artifact_targets entries must be tables")
        table = dict(raw)
        table.setdefault("_source_file", "product metadata compatibility graph")
        tables.append(table)
    return tables


def artifact_targets(
    graph: dict | None = None,
    *,
    product: str | None = None,
    kind: str | None = None,
    surface: str | None = None,
    published_only: bool = False,
) -> list[ArtifactTarget]:
    data = graph if graph is not None else product_metadata.load_graph()
    raw_targets = raw_artifact_target_tables(data)

    products = product_metadata.graph_products(data)
    parsed: list[ArtifactTarget] = []
    seen: set[str] = set()
    for raw in raw_targets:
        target_id = _string(raw.get("id"), "id", "<unknown>")
        assert target_id is not None
        if target_id in seen:
            source_file = raw.get("_source_file", "unknown source")
            product_metadata.fail(f"duplicate artifact target id {target_id} in {source_file}")
        seen.add(target_id)

        target_product = _string(raw.get("product"), "product", target_id)
        assert target_product is not None
        if target_product not in products:
            product_metadata.fail(f"artifact target {target_id} references unknown product {target_product}")

        parsed_target = ArtifactTarget(
            id=target_id,
            product=target_product,
            kind=_string(raw.get("kind"), "kind", target_id) or "",
            target=_string(raw.get("target"), "target", target_id) or "",
            asset=_string(raw.get("asset"), "asset", target_id) or "",
            published=_published(raw.get("published"), target_id),
            surfaces=_surfaces(raw.get("surfaces"), target_id),
            triple=_string(raw.get("triple"), "triple", target_id, required=False),
            runner=_string(raw.get("runner"), "runner", target_id, required=False),
            library_relative_path=_string(raw.get("library_relative_path"), "library_relative_path", target_id, required=False),
            executable_relative_path=_string(raw.get("executable_relative_path"), "executable_relative_path", target_id, required=False),
            npm_package=_string(raw.get("npm_package"), "npm_package", target_id, required=False),
            npm_os=_string(raw.get("npm_os"), "npm_os", target_id, required=False),
            npm_cpu=_string(raw.get("npm_cpu"), "npm_cpu", target_id, required=False),
            npm_libc=_string(raw.get("npm_libc"), "npm_libc", target_id, required=False),
            llvm_url=_string(raw.get("llvm_url"), "llvm_url", target_id, required=False),
            extension_artifacts=_optional_bool(raw.get("extension_artifacts"), "extension_artifacts", target_id, True),
        )
        if product is not None and parsed_target.product != product:
            continue
        if kind is not None and parsed_target.kind != kind:
            continue
        if surface is not None and surface not in parsed_target.surfaces:
            continue
        if published_only and not parsed_target.published:
            continue
        parsed.append(parsed_target)

    return parsed


def expected_assets(
    product: str,
    version: str,
    *,
    surface: str = "github-release",
    published_only: bool = True,
    kinds: Iterable[str] | None = None,
) -> list[str]:
    allowed_kinds = set(kinds) if kinds is not None else None
    assets = [
        target.asset_name(version)
        for target in artifact_targets(
            product=product,
            surface=surface,
            published_only=published_only,
        )
        if allowed_kinds is None or target.kind in allowed_kinds
    ]
    if not assets:
        product_metadata.fail(f"{product} has no artifact targets for surface {surface}")
    return sorted(assets)


def ci_release_asset_artifact_names(product: str, kind: str) -> list[str]:
    names = [
        f"{product}-release-assets-{target.target}"
        for target in artifact_targets(
            product=product,
            kind=kind,
            surface="github-release",
            published_only=True,
        )
    ]
    if not names:
        product_metadata.fail(f"{product} has no published {kind} CI release asset targets")
    return sorted(names)


def ci_npm_package_artifact_names(product: str, kind: str) -> list[str]:
    names = [
        f"{product}-npm-package-{target.target}"
        for target in artifact_targets(
            product=product,
            kind=kind,
            surface="npm-optional",
            published_only=True,
        )
    ]
    if not names:
        product_metadata.fail(f"{product} has no published {kind} CI npm package targets")
    return sorted(names)


def ci_wasix_aot_runtime_artifact_names() -> list[str]:
    names = [
        f"liboliphaunt-wasix-runtime-aot-{target.target}"
        for target in artifact_targets(
            product="liboliphaunt-wasix",
            kind="wasix-aot-runtime",
            published_only=True,
        )
    ]
    if not names:
        product_metadata.fail("liboliphaunt-wasix has no published WASIX AOT runtime targets")
    return sorted(names)


def ci_aggregate_release_asset_artifact_name(product: str) -> str:
    config = product_metadata.product_config(product)
    release_artifacts = config.get("release_artifacts")
    if not isinstance(release_artifacts, list) or not release_artifacts:
        product_metadata.fail(f"{product} does not publish aggregate release assets")
    return f"{product}-release-assets"


def ci_wasix_runtime_artifact_names() -> list[str]:
    names = [
        f"liboliphaunt-wasix-runtime-{target.target}"
        for target in artifact_targets(
            product="liboliphaunt-wasix",
            kind="wasix-runtime",
            published_only=True,
        )
    ]
    if not names:
        product_metadata.fail("liboliphaunt-wasix has no published WASIX runtime targets")
    return sorted(names)


def ci_sdk_package_artifact_name(product: str) -> str:
    config = product_metadata.product_config(product)
    if config.get("kind") != "sdk":
        product_metadata.fail(f"{product} is not an SDK release product")
    if product == "oliphaunt-wasix-rust":
        return f"{product}-package-artifacts"
    return f"{product}-sdk-package-artifacts"


def sdk_package_products() -> tuple[str, ...]:
    return tuple(
        product
        for product, config in product_metadata.graph_products().items()
        if config.get("kind") == "sdk"
    )


def ci_sdk_package_artifact_names(product: str | None = None) -> list[str]:
    if product is not None:
        return [ci_sdk_package_artifact_name(product)]
    return [ci_sdk_package_artifact_name(sdk_product) for sdk_product in sdk_package_products()]


def typescript_optional_runtime_package_products() -> dict[str, str]:
    package_products: dict[str, str] = {}
    selectors = [
        ("oliphaunt-broker", "broker-helper", "typescript-broker"),
        ("liboliphaunt-native", "native-runtime", "typescript-native-direct"),
        ("liboliphaunt-native", "native-tools", "typescript-native-direct"),
        ("oliphaunt-node-direct", "node-direct-addon", "npm-optional"),
    ]
    for product, kind, surface in selectors:
        targets = artifact_targets(
            product=product,
            kind=kind,
            surface=surface,
            published_only=True,
        )
        if not targets:
            product_metadata.fail(f"{product} has no published {kind} TypeScript optional package targets")
        for target in targets:
            if target.npm_package is None:
                product_metadata.fail(f"{target.id} must declare npm_package for TypeScript optional dependencies")
            if target.npm_package in package_products:
                product_metadata.fail(f"duplicate TypeScript optional package target {target.npm_package}")
            package_products[target.npm_package] = target.product
    return dict(sorted(package_products.items()))


def typescript_optional_runtime_package_versions() -> dict[str, str]:
    return {
        package_name: product_metadata.read_current_version(product)
        for package_name, product in typescript_optional_runtime_package_products().items()
    }
