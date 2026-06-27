"""Shared release product metadata.

Release identity comes from release-please manifest-mode config. Product-local
``release.toml`` files hold package and artifact metadata that release-please
does not own.
"""

from __future__ import annotations

import json
import subprocess
import sys
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Iterable, NoReturn


ROOT = Path(__file__).resolve().parents[2]
PUBLIC_EXTENSION_RELEASE_MANIFEST_KEYS = {
    "schema",
    "product",
    "version",
    "sqlName",
    "extensionClass",
    "versioning",
    "sourceIdentity",
    "compatibility",
    "dependencies",
    "nativeModuleStem",
    "sharedPreloadLibraries",
    "mobileReleaseReady",
    "desktopReleaseReady",
    "assets",
}
PUBLIC_EXTENSION_RELEASE_ASSET_KEYS = {
    "name",
    "family",
    "target",
    "kind",
    "sha256",
    "bytes",
}


def fail(message: str) -> NoReturn:
    print(f"product_metadata.py: {message}", file=sys.stderr)
    raise SystemExit(2)


def package_path(product: str) -> str:
    value = product_config(product).get("path")
    if not isinstance(value, str) or not value:
        fail(f"release graph product {product!r} must declare a package path")
    return value


def moon_release_metadata(product: str) -> dict[str, Any]:
    projects = load_graph().get("moon_projects")
    project = projects.get(product) if isinstance(projects, dict) else None
    if not isinstance(project, dict):
        fail(f"unknown Moon release component {product!r}")
    project_config = project.get("project")
    metadata = project_config.get("metadata") if isinstance(project_config, dict) else None
    release = metadata.get("release") if isinstance(metadata, dict) else None
    if not isinstance(release, dict):
        fail(f"Moon release component {product!r} has no release metadata")
    return release


def load_graph() -> dict[str, Any]:
    """Compatibility return value for callers that still accept a graph arg."""

    return _release_graph()


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


@lru_cache(maxsize=None)
def _release_graph_query_json(command: str, args: tuple[str, ...] = ()) -> Any:
    try:
        output = subprocess.check_output(
            ["tools/dev/bun.sh", "tools/release/release_graph_query.mjs", command, *args],
            cwd=ROOT,
            text=True,
            stderr=subprocess.PIPE,
        )
    except subprocess.CalledProcessError as error:
        detail = (error.stderr or "").strip()
        if detail:
            fail(f"release graph {command} query failed: {detail}")
        fail(f"release graph {command} query failed with exit code {error.returncode}")
    return json.loads(output)


@lru_cache(maxsize=None)
def _release_graph_query_rows(command: str, args: tuple[str, ...] = ()) -> tuple[dict[str, Any], ...]:
    rows = _release_graph_query_json(command, args)
    if not isinstance(rows, list) or not all(isinstance(row, dict) for row in rows):
        fail(f"release graph {command} query must return a JSON object list")
    return tuple(rows)


@lru_cache(maxsize=1)
def _release_graph() -> dict[str, Any]:
    value = _release_graph_query_json("graph")
    if not isinstance(value, dict):
        fail("release graph query must return a JSON object")
    products = value.get("products")
    if not isinstance(products, dict) or not products:
        fail("release graph query must return a non-empty products object")
    return value


def _target_string(row: dict[str, Any], key: str, target_id: str, *, required: bool = True) -> str | None:
    value = row.get(key)
    if isinstance(value, str) and value:
        return value
    if required:
        fail(f"artifact target {target_id}.{key} must be a non-empty string")
    if value is not None:
        fail(f"artifact target {target_id}.{key} must be a string")
    return None


def _target_bool(row: dict[str, Any], key: str, target_id: str, *, default: bool | None = None) -> bool:
    value = row.get(key)
    if isinstance(value, bool):
        return value
    if value is None and default is not None:
        return default
    fail(f"artifact target {target_id}.{key} must be true or false")


def _target_surfaces(row: dict[str, Any], target_id: str) -> tuple[str, ...]:
    value = row.get("surfaces")
    if not isinstance(value, list) or not value or not all(isinstance(item, str) and item for item in value):
        fail(f"artifact target {target_id}.surfaces must be a non-empty string list")
    return tuple(value)


def _artifact_target_from_row(row: dict[str, Any]) -> ArtifactTarget:
    target_id = _target_string(row, "id", "<unknown>")
    assert target_id is not None
    return ArtifactTarget(
        id=target_id,
        product=_target_string(row, "product", target_id) or "",
        kind=_target_string(row, "kind", target_id) or "",
        target=_target_string(row, "target", target_id) or "",
        asset=_target_string(row, "asset", target_id) or "",
        published=_target_bool(row, "published", target_id),
        surfaces=_target_surfaces(row, target_id),
        triple=_target_string(row, "triple", target_id, required=False),
        runner=_target_string(row, "runner", target_id, required=False),
        library_relative_path=_target_string(row, "library_relative_path", target_id, required=False),
        executable_relative_path=_target_string(row, "executable_relative_path", target_id, required=False),
        npm_package=_target_string(row, "npm_package", target_id, required=False),
        npm_os=_target_string(row, "npm_os", target_id, required=False),
        npm_cpu=_target_string(row, "npm_cpu", target_id, required=False),
        npm_libc=_target_string(row, "npm_libc", target_id, required=False),
        llvm_url=_target_string(row, "llvm_url", target_id, required=False),
        extension_artifacts=_target_bool(row, "extension_artifacts", target_id, default=True),
    )


def _artifact_target_args(
    *,
    product: str | None = None,
    kind: str | None = None,
    surface: str | None = None,
    published_only: bool = False,
) -> tuple[str, ...]:
    args: list[str] = []
    if product is not None:
        args.extend(["--product", product])
    if kind is not None:
        args.extend(["--kind", kind])
    if surface is not None:
        args.extend(["--surface", surface])
    if published_only:
        args.append("--published-only")
    return tuple(args)


def raw_artifact_target_tables(graph: dict | None = None) -> list[dict[str, Any]]:
    """Return raw artifact target rows from the canonical Bun release graph."""

    return [
        dict(row)
        for row in _release_graph_query_rows("raw-artifact-targets")
    ]


def artifact_targets(
    graph: dict | None = None,
    *,
    product: str | None = None,
    kind: str | None = None,
    surface: str | None = None,
    published_only: bool = False,
) -> list[ArtifactTarget]:
    rows = _release_graph_query_rows(
        "artifact-targets",
        _artifact_target_args(
            product=product,
            kind=kind,
            surface=surface,
            published_only=published_only,
        ),
    )
    return [_artifact_target_from_row(row) for row in rows]


@lru_cache(maxsize=1)
def _wasix_cargo_artifact_contract() -> dict[str, Any]:
    value = _release_graph_query_json("wasix-cargo-artifact-contract")
    if not isinstance(value, dict):
        fail("release graph wasix-cargo-artifact-contract query must return a JSON object")
    return value


def _wasix_contract_string(key: str) -> str:
    value = _wasix_cargo_artifact_contract().get(key)
    if not isinstance(value, str) or not value:
        fail(f"WASIX Cargo artifact contract {key} must be a non-empty string")
    return value


def _wasix_contract_string_list(key: str) -> tuple[str, ...]:
    value = _wasix_cargo_artifact_contract().get(key)
    if not isinstance(value, list) or not all(isinstance(item, str) and item for item in value):
        fail(f"WASIX Cargo artifact contract {key} must be a string list")
    return tuple(value)


def _wasix_contract_string_map(key: str) -> dict[str, str]:
    value = _wasix_cargo_artifact_contract().get(key)
    if not isinstance(value, dict) or not all(
        isinstance(item_key, str) and item_key and isinstance(item_value, str) and item_value
        for item_key, item_value in value.items()
    ):
        fail(f"WASIX Cargo artifact contract {key} must be a string map")
    return dict(value)


def wasix_cargo_artifact_schema() -> str:
    return _wasix_contract_string("schema")


def wasix_runtime_package_name() -> str:
    return _wasix_contract_string("runtimePackage")


def wasix_tools_package_name() -> str:
    return _wasix_contract_string("toolsPackage")


def wasix_icu_package_name() -> str:
    return _wasix_contract_string("icuPackage")


def wasix_icu_payload_archive_name() -> str:
    return _wasix_contract_string("icuPayloadArchive")


def wasix_aot_packages() -> dict[str, str]:
    return _wasix_contract_string_map("aotPackages")


def wasix_tools_aot_packages() -> dict[str, str]:
    return _wasix_contract_string_map("toolsAotPackages")


def wasix_aot_target_triples() -> dict[str, str]:
    return _wasix_contract_string_map("aotTargetTriples")


def wasix_aot_target_cfgs() -> dict[str, str]:
    return _wasix_contract_string_map("aotTargetCfgs")


def wasix_public_cargo_package_names() -> tuple[str, ...]:
    return _wasix_contract_string_list("publicCargoPackageNames")


def wasix_public_aot_cargo_dependencies() -> dict[str, str]:
    return _wasix_contract_string_map("publicAotCargoDependencies")


def wasix_public_tools_aot_cargo_dependencies() -> dict[str, str]:
    return _wasix_contract_string_map("publicToolsAotCargoDependencies")


def wasix_public_tools_feature_dependencies() -> set[str]:
    return set(_wasix_contract_string_list("publicToolsFeatureDependencies"))


def wasix_core_runtime_archive_files() -> tuple[str, ...]:
    return _wasix_contract_string_list("coreRuntimeArchiveFiles")


def wasix_tools_payload_files() -> tuple[str, ...]:
    return _wasix_contract_string_list("toolsPayloadFiles")


def wasix_forbidden_runtime_archive_tool_files() -> tuple[str, ...]:
    return _wasix_contract_string_list("forbiddenRuntimeArchiveToolFiles")


def wasix_tools_aot_artifacts() -> set[str]:
    return set(_wasix_contract_string_list("toolsAotArtifacts"))


def wasix_expected_extension_aot_targets() -> tuple[str, ...]:
    return _wasix_contract_string_list("expectedExtensionAotTargets")


def wasix_extension_package_name(product: str) -> str:
    if not product:
        fail("WASIX extension package product must be non-empty")
    return f"{product}-wasix"


def wasix_extension_aot_package_name(product: str, target: str) -> str:
    if not product or not target:
        fail("WASIX extension AOT package product and target must be non-empty")
    return f"{product}-wasix-aot-{target}"


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
        fail(f"{product} has no artifact targets for surface {surface}")
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
        fail(f"{product} has no published {kind} CI release asset targets")
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
        fail(f"{product} has no published {kind} CI npm package targets")
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
        fail("liboliphaunt-wasix has no published WASIX AOT runtime targets")
    return sorted(names)


def ci_aggregate_release_asset_artifact_name(product: str) -> str:
    config = product_config(product)
    release_artifacts = config.get("release_artifacts")
    if not isinstance(release_artifacts, list) or not release_artifacts:
        fail(f"{product} does not publish aggregate release assets")
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
        fail("liboliphaunt-wasix has no published WASIX runtime targets")
    return sorted(names)


def ci_sdk_package_artifact_name(product: str) -> str:
    config = product_config(product)
    if config.get("kind") != "sdk":
        fail(f"{product} is not an SDK release product")
    if product == "oliphaunt-wasix-rust":
        return f"{product}-package-artifacts"
    return f"{product}-sdk-package-artifacts"


def sdk_package_products() -> tuple[str, ...]:
    return tuple(
        product
        for product, config in graph_products().items()
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
            fail(f"{product} has no published {kind} TypeScript optional package targets")
        for target in targets:
            if target.npm_package is None:
                fail(f"{target.id} must declare npm_package for TypeScript optional dependencies")
            if target.npm_package in package_products:
                fail(f"duplicate TypeScript optional package target {target.npm_package}")
            package_products[target.npm_package] = target.product
    return dict(sorted(package_products.items()))


def typescript_optional_runtime_package_versions() -> dict[str, str]:
    return {
        package_name: read_current_version(product)
        for package_name, product in typescript_optional_runtime_package_products().items()
    }


def graph_products(graph: dict | None = None) -> dict[str, dict[str, Any]]:
    source = load_graph() if graph is None else graph
    products = source.get("products") if isinstance(source, dict) else None
    if not isinstance(products, dict) or not products:
        fail("release graph must contain a non-empty products object")
    parsed: dict[str, dict[str, Any]] = {}
    for product, config in products.items():
        if not isinstance(product, str) or not product:
            fail("release graph product ids must be non-empty strings")
        if not isinstance(config, dict):
            fail(f"release graph product {product} config must be an object")
        parsed[product] = dict(config)
    return parsed


def product_config(product: str, graph: dict | None = None) -> dict[str, Any]:
    config = graph_products(graph).get(product)
    if config is None:
        fail(f"unknown release product {product!r}")
    return config


def product_ids(graph: dict | None = None) -> list[str]:
    return list(graph_products(graph))


def extension_product_ids(graph: dict | None = None) -> list[str]:
    return sorted(
        product
        for product, config in graph_products(graph).items()
        if config.get("kind") == "exact-extension-artifact"
    )


@lru_cache(maxsize=None)
def extension_artifact_targets(
    *,
    product: str | None = None,
    family: str | None = None,
    published_only: bool = False,
) -> tuple[SimpleNamespace, ...]:
    args: list[str] = []
    if product is not None:
        args.extend(["--product", product])
    if family is not None:
        args.extend(["--family", family])
    if published_only:
        args.append("--published-only")
    rows = _release_graph_query_rows("extension-targets", tuple(args))
    return tuple(SimpleNamespace(**row) for row in rows)


def published_android_maven_targets(product: str) -> tuple[SimpleNamespace, ...]:
    return tuple(
        sorted(
            (
                target
                for target in extension_artifact_targets(
                    product=product,
                    family="native",
                    published_only=True,
                )
                if target.kind == "native-static-registry" and target.target.startswith("android-")
            ),
            key=lambda target: target.target,
        )
    )


def published_extension_target_ids(*, family: str) -> list[str]:
    return sorted(
        {
            target.target
            for target in extension_artifact_targets(family=family, published_only=True)
        }
    )


def ci_wasix_extension_artifact_names() -> list[str]:
    names = [
        f"liboliphaunt-wasix-extension-artifacts-{target_id}"
        for target_id in published_extension_target_ids(family="wasix")
    ]
    if not names:
        fail("exact-extension metadata has no published WASIX artifact targets")
    return names


def ci_extension_package_artifact_names() -> list[str]:
    names = ["oliphaunt-extension-package-artifacts"]
    mobile_targets = [
        target
        for target in extension_artifact_targets(family="native", published_only=True)
        if target.kind == "native-static-registry"
    ]
    if mobile_targets:
        names.append("oliphaunt-mobile-extension-package-artifacts")
    return names


def string_list(config: dict, key: str, product: str) -> list[str]:
    value = config.get(key, [])
    if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
        fail(f"{product}.{key} must be a string list")
    return value


def registry_package_names(product: str, package_kind: str) -> list[str]:
    names: list[str] = []
    for raw in string_list(product_config(product), "registry_packages", product):
        kind, separator, name = raw.partition(":")
        if not separator or not kind or not name:
            fail(f"{product}.registry_packages entry {raw!r} must use kind:name")
        if kind == package_kind:
            names.append(name)
    duplicates = sorted({name for name in names if names.count(name) > 1})
    if duplicates:
        fail(
            f"{product} declares duplicate {package_kind} registry packages: "
            + ", ".join(duplicates)
        )
    return names


@lru_cache(maxsize=1)
def _extension_metadata_rows() -> tuple[dict[str, Any], ...]:
    return _release_graph_query_rows("extension-metadata")


def _extension_metadata_row(product: str) -> dict[str, Any]:
    matches = [row for row in _extension_metadata_rows() if row.get("product") == product]
    if len(matches) != 1:
        fail(f"release graph extension-metadata query must return one row for {product}, got {len(matches)}")
    return dict(matches[0])


def _metadata_string(row: dict[str, Any], key: str, product: str) -> str:
    value = row.get(key)
    if not isinstance(value, str) or not value:
        fail(f"extension-metadata {product}.{key} must be a non-empty string")
    return value


def _metadata_object(row: dict[str, Any], key: str, product: str) -> dict[str, Any]:
    value = row.get(key)
    if not isinstance(value, dict):
        fail(f"extension-metadata {product}.{key} must be an object")
    return dict(value)


def extension_metadata(product: str, graph: dict | None = None) -> dict[str, Any]:
    row = _extension_metadata_row(product)
    compatibility = _metadata_object(row, "compatibility", product)
    for key in [
        "postgresMajor",
        "extensionRuntimeContract",
        "nativeRuntimeProduct",
        "nativeRuntimeVersion",
        "wasixRuntimeProduct",
        "wasixRuntimeVersion",
    ]:
        if not isinstance(compatibility.get(key), str) or not compatibility[key]:
            fail(f"extension-metadata {product}.compatibility.{key} must be a non-empty string")
    return {
        "sqlName": _metadata_string(row, "sqlName", product),
        "class": _metadata_string(row, "class", product),
        "versioning": _metadata_string(row, "versioning", product),
        "sourcePath": _metadata_string(row, "sourcePath", product),
        "compatibility": compatibility,
    }


def extension_source_identity(product: str, graph: dict | None = None) -> dict[str, Any]:
    return _metadata_object(_extension_metadata_row(product), "sourceIdentity", product)


def validate_extension_metadata(product: str, graph: dict | None = None) -> None:
    extension_metadata(product, graph)


def validate_all_extension_metadata(graph: dict | None = None) -> None:
    for product in extension_product_ids():
        validate_extension_metadata(product, graph)


def _graph_string(config: dict[str, Any], key: str, product: str) -> str:
    value = config.get(key)
    if not isinstance(value, str) or not value:
        fail(f"release graph product {product}.{key} must be a non-empty string")
    return value


def _graph_string_list(config: dict[str, Any], key: str, product: str) -> list[str]:
    value = config.get(key)
    if not isinstance(value, list) or not value or not all(isinstance(item, str) and item for item in value):
        fail(f"release graph product {product}.{key} must be a non-empty string list")
    return list(value)


def version_files(product: str, graph: dict | None = None) -> list[str]:
    files = _graph_string_list(product_config(product, graph), "version_files", product)
    for path in files:
        if not (ROOT / path).is_file():
            fail(f"{product} version file does not exist: {path}")
    return files


def derived_version_files(product: str, graph: dict | None = None) -> list[str]:
    value = product_config(product, graph).get("derived_version_files", [])
    if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
        fail(f"release graph product {product}.derived_version_files must be a string list")
    return list(value)


def changelog_path(product: str, graph: dict | None = None) -> str:
    path = _graph_string(product_config(product, graph), "changelog_path", product)
    if not (ROOT / path).is_file():
        fail(f"{product} changelog does not exist: {path}")
    return path


def tag_prefix(product: str, graph: dict | None = None) -> str:
    return _graph_string(product_config(product, graph), "tag_prefix", product)


@lru_cache(maxsize=1)
def _product_version_rows() -> tuple[dict[str, Any], ...]:
    return _release_graph_query_rows("product-versions")


def _product_version_row(product: str) -> dict[str, Any]:
    matches = [row for row in _product_version_rows() if row.get("product") == product]
    if len(matches) != 1:
        fail(f"release graph product-versions query must return one row for {product}, got {len(matches)}")
    return dict(matches[0])


def read_current_version(product: str, graph: dict | None = None) -> str:
    version = _product_version_row(product).get("version")
    if not isinstance(version, str) or not version:
        fail(f"release graph product-versions {product}.version must be a non-empty string")
    return version


if __name__ == "__main__":
    fail(
        "tools/release/product_metadata.py is a Python compatibility module; "
        "use tools/dev/bun.sh tools/release/product-version.mjs version <product-id> for version reads"
    )
