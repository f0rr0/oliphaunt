"""Shared release product metadata.

Release identity comes from release-please manifest-mode config. Product-local
``release.toml`` files hold package and artifact metadata that release-please
does not own.
"""

from __future__ import annotations

import json
import re
import subprocess
import sys
import tomllib
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Iterable, NoReturn


ROOT = Path(__file__).resolve().parents[2]
RELEASE_PLEASE_CONFIG_PATH = ROOT / "release-please-config.json"
EXTENSION_CLASSES = {"contrib", "external", "first-party"}
EXTENSION_VERSIONING_BY_CLASS = {
    "contrib": "postgres-bound",
    "external": "upstream-bound",
    "first-party": "repo-bound",
}
EXTENSION_RUNTIME_CONTRACT_PATH = "src/shared/extension-runtime-contract/contract.toml"
POSTGRES18_SOURCE_PATH = "src/postgres/versions/18/source.toml"
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


def _read_json(path: Path) -> dict[str, Any]:
    if not path.is_file():
        fail(f"missing {path.relative_to(ROOT)}")
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        fail(f"{path.relative_to(ROOT)} must contain a JSON object")
    return value


def _read_toml(path: Path) -> dict[str, Any]:
    if not path.is_file():
        fail(f"missing {path.relative_to(ROOT)}")
    value = tomllib.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        fail(f"{path.relative_to(ROOT)} must contain a TOML table")
    return value


@lru_cache(maxsize=1)
def _release_please_config() -> dict[str, Any]:
    return _read_json(RELEASE_PLEASE_CONFIG_PATH)


@lru_cache(maxsize=1)
def _packages() -> dict[str, dict[str, Any]]:
    packages = _release_please_config().get("packages")
    if not isinstance(packages, dict) or not packages:
        fail("release-please-config.json must define packages")
    parsed: dict[str, dict[str, Any]] = {}
    for package_path, package_config in packages.items():
        if not isinstance(package_path, str) or not package_path:
            fail("release-please package paths must be non-empty strings")
        if not isinstance(package_config, dict):
            fail(f"{package_path} release-please config must be an object")
        parsed[package_path] = package_config
    return parsed


@lru_cache(maxsize=1)
def _release_please_packages_by_component() -> dict[str, tuple[str, dict[str, Any]]]:
    packages: dict[str, tuple[str, dict[str, Any]]] = {}
    for package_path, package_config in _packages().items():
        component = package_config.get("component")
        if not isinstance(component, str) or not component:
            fail(f"{package_path}.component must be a non-empty string")
        if component in packages:
            fail(f"duplicate release-please component {component}")
        packages[component] = (package_path, package_config)
    return packages


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


def _package_config(product: str) -> dict[str, Any]:
    package = _release_please_packages_by_component().get(product)
    if package is None:
        fail(f"unknown release-please component {product!r}")
    package_path_from_release_please, config = package
    moon_package_path = package_path(product)
    if package_path_from_release_please != moon_package_path:
        fail(
            f"{product} release-please path {package_path_from_release_please!r} must match "
            f"Moon package path {moon_package_path!r}"
        )
    return config


def _release_metadata_path(product: str) -> Path:
    return ROOT / package_path(product) / "release.toml"


def _release_metadata(product: str) -> dict[str, Any]:
    metadata = _read_toml(_release_metadata_path(product))
    metadata_id = metadata.get("id")
    if metadata_id != product:
        fail(f"{_release_metadata_path(product).relative_to(ROOT)} must declare id = {product!r}")
    return metadata


def _effective_release_metadata(product: str) -> dict[str, Any]:
    metadata = dict(_release_metadata(product))
    publish_targets = metadata.get("publish_targets", [])
    if not isinstance(publish_targets, list) or not all(isinstance(item, str) for item in publish_targets):
        fail(f"{product}.publish_targets must be a string list")
    return metadata


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
    args = ["tools/dev/bun.sh", "tools/release/release_graph_query.mjs", "extension-targets"]
    if product is not None:
        args.extend(["--product", product])
    if family is not None:
        args.extend(["--family", family])
    if published_only:
        args.append("--published-only")
    try:
        output = subprocess.check_output(args, cwd=ROOT, text=True, stderr=subprocess.PIPE)
    except subprocess.CalledProcessError as error:
        detail = (error.stderr or "").strip()
        if detail:
            fail(f"release graph extension target query failed: {detail}")
        fail(f"release graph extension target query failed with exit code {error.returncode}")
    rows = json.loads(output)
    if not isinstance(rows, list) or not all(isinstance(row, dict) for row in rows):
        fail("release graph extension-targets query must return a JSON object list")
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


def _string_field(config: dict[str, Any], key: str, context: str) -> str:
    value = config.get(key)
    if not isinstance(value, str) or not value:
        fail(f"{context}.{key} must be a non-empty string")
    return value


def _release_metadata_relative_path(path: str, context: str) -> str:
    candidate = Path(path)
    if candidate.is_absolute() or ".." in candidate.parts:
        fail(f"{context} must be a repository-relative path: {path!r}")
    if not (ROOT / candidate).is_file():
        fail(f"{context} path does not exist: {path}")
    return candidate.as_posix()


def extension_metadata(product: str, graph: dict | None = None) -> dict[str, Any]:
    config = product_config(product)
    if config.get("kind") != "exact-extension-artifact":
        fail(f"{product} is not an exact-extension artifact product")
    metadata = _release_metadata(product)
    top_level_sql_name = metadata.get("extension_sql_name")
    if not isinstance(top_level_sql_name, str) or not top_level_sql_name:
        fail(f"{product} release metadata must declare extension_sql_name")

    extension = metadata.get("extension")
    if not isinstance(extension, dict):
        fail(f"{product} release metadata must declare [extension]")
    sql_name = _string_field(extension, "sql_name", f"{product}.extension")
    if sql_name != top_level_sql_name:
        fail(
            f"{product}.extension.sql_name {sql_name!r} must match "
            f"extension_sql_name {top_level_sql_name!r}"
        )
    extension_class = _string_field(extension, "class", f"{product}.extension")
    if extension_class not in EXTENSION_CLASSES:
        fail(f"{product}.extension.class must be one of {sorted(EXTENSION_CLASSES)}, got {extension_class!r}")
    versioning = _string_field(extension, "versioning", f"{product}.extension")
    expected_versioning = EXTENSION_VERSIONING_BY_CLASS[extension_class]
    if versioning != expected_versioning:
        fail(
            f"{product}.extension.versioning must be {expected_versioning!r} "
            f"for class {extension_class!r}, got {versioning!r}"
        )

    source = extension.get("source")
    if not isinstance(source, dict):
        fail(f"{product}.extension must declare [extension.source]")
    source_path = _release_metadata_relative_path(
        _string_field(source, "path", f"{product}.extension.source"),
        f"{product}.extension.source.path",
    )
    package = package_path(product)
    if extension_class == "contrib" and source_path != POSTGRES18_SOURCE_PATH:
        fail(f"{product}.extension.source.path must be {POSTGRES18_SOURCE_PATH!r} for contrib extensions")
    if extension_class == "external" and source_path != f"{package}/source.toml":
        fail(f"{product}.extension.source.path must be {package}/source.toml for external extensions")
    if extension_class == "first-party" and not (
        source_path == package or source_path.startswith(f"{package}/")
    ):
        fail(f"{product}.extension.source.path must stay inside {package}/ for first-party extensions")

    compatibility = extension.get("compatibility")
    if not isinstance(compatibility, dict):
        fail(f"{product}.extension must declare [extension.compatibility]")
    postgres_major = _string_field(compatibility, "postgres_major", f"{product}.extension.compatibility")
    if postgres_major != "18":
        fail(f"{product}.extension.compatibility.postgres_major must be '18', got {postgres_major!r}")
    contract_path = _release_metadata_relative_path(
        _string_field(compatibility, "extension_runtime_contract", f"{product}.extension.compatibility"),
        f"{product}.extension.compatibility.extension_runtime_contract",
    )
    if contract_path != EXTENSION_RUNTIME_CONTRACT_PATH:
        fail(
            f"{product}.extension.compatibility.extension_runtime_contract must be "
            f"{EXTENSION_RUNTIME_CONTRACT_PATH!r}"
        )
    native_product = _string_field(compatibility, "native_runtime_product", f"{product}.extension.compatibility")
    wasix_product = _string_field(compatibility, "wasix_runtime_product", f"{product}.extension.compatibility")
    if native_product != "liboliphaunt-native":
        fail(f"{product}.extension.compatibility.native_runtime_product must be 'liboliphaunt-native'")
    if wasix_product != "liboliphaunt-wasix":
        fail(f"{product}.extension.compatibility.wasix_runtime_product must be 'liboliphaunt-wasix'")
    native_version = _string_field(compatibility, "native_runtime_version", f"{product}.extension.compatibility")
    wasix_version = _string_field(compatibility, "wasix_runtime_version", f"{product}.extension.compatibility")
    expected_native_version = read_current_version(native_product)
    expected_wasix_version = read_current_version(wasix_product)
    if native_version != expected_native_version:
        fail(
            f"{product}.extension.compatibility.native_runtime_version must be "
            f"{expected_native_version!r}, got {native_version!r}"
        )
    if wasix_version != expected_wasix_version:
        fail(
            f"{product}.extension.compatibility.wasix_runtime_version must be "
            f"{expected_wasix_version!r}, got {wasix_version!r}"
        )

    return {
        "sqlName": sql_name,
        "class": extension_class,
        "versioning": versioning,
        "sourcePath": source_path,
        "compatibility": {
            "postgresMajor": postgres_major,
            "extensionRuntimeContract": contract_path,
            "nativeRuntimeProduct": native_product,
            "nativeRuntimeVersion": native_version,
            "wasixRuntimeProduct": wasix_product,
            "wasixRuntimeVersion": wasix_version,
        },
    }


def extension_source_identity(product: str, graph: dict | None = None) -> dict[str, Any]:
    metadata = extension_metadata(product)
    source_path = metadata["sourcePath"]
    source = _read_toml(ROOT / source_path)
    extension_class = metadata["class"]
    if extension_class == "contrib":
        postgresql = source.get("postgresql")
        if not isinstance(postgresql, dict):
            fail(f"{source_path} must declare [postgresql] for contrib extension products")
        return {
            "kind": "postgres-contrib",
            "name": "postgresql",
            "version": _string_field(postgresql, "version", source_path),
            "url": _string_field(postgresql, "url", source_path),
            "sha256": _string_field(postgresql, "sha256", source_path),
        }
    if extension_class == "external":
        return {
            "kind": "external",
            "name": _string_field(source, "name", source_path),
            "url": _string_field(source, "url", source_path),
            "branch": _string_field(source, "branch", source_path),
            "commit": _string_field(source, "commit", source_path),
        }
    if extension_class == "first-party":
        return {
            "kind": "repo",
            "name": metadata["sqlName"],
            "path": source_path,
            "version": read_current_version(product),
        }
    fail(f"{product}.extension.class has unsupported source identity class {extension_class!r}")


def validate_extension_metadata(product: str, graph: dict | None = None) -> None:
    extension_metadata(product, graph)


def validate_all_extension_metadata(graph: dict | None = None) -> None:
    for product in extension_product_ids():
        validate_extension_metadata(product, graph)


def _package_relative_path(product: str, relative: str, context: str) -> str:
    path = Path(relative)
    if path.is_absolute() or ".." in path.parts:
        fail(f"{context} must stay inside release package path: {relative!r}")
    return (Path(package_path(product)) / path).as_posix()


def _canonical_version_file(product: str) -> str:
    package_config = _package_config(product)
    release_type = package_config.get("release-type")
    version_file = package_config.get("version-file")
    if isinstance(version_file, str) and version_file:
        return _package_relative_path(product, version_file, f"{product}.version-file")
    if release_type == "rust":
        return _package_relative_path(product, "Cargo.toml", f"{product}.rust")
    if release_type in {"node", "expo"}:
        return _package_relative_path(product, "package.json", f"{product}.node")
    fail(f"{product} release-please config must declare version-file for release type {release_type!r}")


def _extra_version_files(product: str) -> list[str]:
    files: list[str] = []
    package_config = _package_config(product)
    extra_files = package_config.get("extra-files", [])
    if not isinstance(extra_files, list):
        fail(f"{product}.extra-files must be a list")
    for index, entry in enumerate(extra_files):
        context = f"{product}.extra-files[{index}]"
        if isinstance(entry, str):
            files.append(_package_relative_path(product, entry, context))
            continue
        if not isinstance(entry, dict):
            fail(f"{context} must be a path string or object")
        path = entry.get("path")
        if not isinstance(path, str) or not path:
            fail(f"{context}.path must be a non-empty string")
        files.append(_package_relative_path(product, path, f"{context}.path"))
    return files


def version_files(product: str, graph: dict | None = None) -> list[str]:
    files = [_canonical_version_file(product), *_extra_version_files(product)]
    for path in files:
        if not (ROOT / path).is_file():
            fail(f"{product} version file does not exist: {path}")
    return files


def derived_version_files(product: str, graph: dict | None = None) -> list[str]:
    return string_list(_release_metadata(product), "derived_version_files", product)


def changelog_path(product: str, graph: dict | None = None) -> str:
    package_config = _package_config(product)
    relative = package_config.get("changelog-path", "CHANGELOG.md")
    if not isinstance(relative, str) or not relative:
        fail(f"{product}.changelog-path must be a non-empty string")
    path = _package_relative_path(product, relative, f"{product}.changelog-path")
    if not (ROOT / path).is_file():
        fail(f"{product} changelog does not exist: {path}")
    return path


def tag_prefix(product: str, graph: dict | None = None) -> str:
    config = _release_please_config()
    package_config = _package_config(product)
    component = package_config.get("component")
    if component != product:
        fail(f"{product} release-please component must match product id")
    if config.get("include-v-in-tag") is not True:
        fail("release-please must include v in product tags")
    separator = config.get("tag-separator")
    if separator != "-":
        fail("release-please tag-separator must be '-'")
    return f"{product}{separator}v"


def parser_for_version_file(product: str, path: str) -> str:
    name = Path(path).name
    if name == "Cargo.toml":
        return "cargo"
    if name == "package.json":
        return "json:version"
    if name == "gradle.properties":
        return "gradle:VERSION_NAME"
    if name in {"VERSION", "LIBOLIPHAUNT_VERSION"}:
        return "raw"
    if name == "jsr.json":
        return "json:version"
    fail(f"{product}.version_files has unsupported version file type: {path}")


def canonical_version_spec(product: str, graph: dict | None = None) -> tuple[str, str]:
    path = version_files(product)[0]
    return path, parser_for_version_file(product, path)


def product_version_specs(graph: dict | None = None) -> dict[str, tuple[str, str]]:
    return {
        product: canonical_version_spec(product)
        for product in graph_products()
    }


def _compatibility_version_entries(*, require_source_product: bool) -> dict[str, tuple[str | None, str, str]]:
    specs: dict[str, tuple[str | None, str, str]] = {}
    known_products = set(product_ids()) if require_source_product else set()
    for product in product_ids():
        raw_specs = _release_metadata(product).get("compatibility_versions", {})
        if not isinstance(raw_specs, dict):
            fail(f"{product}.compatibility_versions must be a table when present")
        for spec_id, spec in raw_specs.items():
            if not isinstance(spec_id, str) or not spec_id:
                fail(f"{product}.compatibility_versions keys must be non-empty strings")
            if not isinstance(spec, dict):
                fail(f"{product}.compatibility_versions.{spec_id} must be a table")
            source_product = spec.get("source_product")
            if require_source_product:
                if not isinstance(source_product, str) or not source_product:
                    fail(f"{product}.compatibility_versions.{spec_id}.source_product must be a non-empty string")
                if source_product not in known_products:
                    fail(
                        f"{product}.compatibility_versions.{spec_id}.source_product "
                        f"must name a release product, got {source_product!r}"
                    )
            elif source_product is not None and not isinstance(source_product, str):
                fail(f"{product}.compatibility_versions.{spec_id}.source_product must be a string when present")
            path = spec.get("path")
            parser = spec.get("parser")
            if not isinstance(path, str) or not path:
                fail(f"{product}.compatibility_versions.{spec_id}.path must be a non-empty string")
            if not isinstance(parser, str) or not parser:
                fail(f"{product}.compatibility_versions.{spec_id}.parser must be a non-empty string")
            if not (ROOT / path).is_file():
                fail(f"{product}.compatibility_versions.{spec_id} path does not exist: {path}")
            specs[spec_id] = (source_product if isinstance(source_product, str) else None, path, parser)
    return specs


def compatibility_version_specs(graph: dict | None = None) -> dict[str, tuple[str, str]]:
    return {
        spec_id: (path, parser)
        for spec_id, (_, path, parser) in _compatibility_version_entries(require_source_product=False).items()
    }


def compatibility_version_links(graph: dict | None = None) -> dict[str, tuple[str, str, str]]:
    return {
        spec_id: (source_product, path, parser)
        for spec_id, (source_product, path, parser) in _compatibility_version_entries(
            require_source_product=True
        ).items()
        if source_product is not None
    }


def release_owned_version_specs(graph: dict | None = None) -> dict[str, tuple[str, str]]:
    return {
        **product_version_specs(),
        **compatibility_version_specs(),
    }


def parse_cargo_version(text: str, path: str) -> str:
    in_package = False
    for line in text.splitlines():
        stripped = line.strip()
        if stripped == "[package]":
            in_package = True
            continue
        if in_package and stripped.startswith("["):
            break
        if in_package:
            match = re.match(r'version\s*=\s*"([^"]+)"', stripped)
            if match:
                return match.group(1)
    return ""


def parse_gradle_property(text: str, name: str) -> str:
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        if key.strip() == name:
            return value.strip()
    return ""


def parse_json_path(text: str, dotted: str) -> str:
    value: object = json.loads(text)
    for key in dotted.split("."):
        if not isinstance(value, dict) or key not in value:
            return ""
        value = value[key]
    return str(value)


def parse_toml_path(text: str, dotted: str) -> str:
    value: object = tomllib.loads(text)
    for key in dotted.split("."):
        if not isinstance(value, dict) or key not in value:
            return ""
        value = value[key]
    return str(value)


def parse_version_text(text: str, path: str, parser: str) -> str:
    if parser == "raw":
        return text.strip()
    if parser == "cargo":
        return parse_cargo_version(text, path)
    if parser.startswith("gradle:"):
        return parse_gradle_property(text, parser.split(":", 1)[1])
    if parser.startswith("json:"):
        return parse_json_path(text, parser.split(":", 1)[1])
    if parser.startswith("toml:"):
        return parse_toml_path(text, parser.split(":", 1)[1])
    if parser.startswith("rust-const:"):
        name = re.escape(parser.split(":", 1)[1])
        match = re.search(rf'^\s*(?:pub\s+)?const\s+{name}\s*:\s*&str\s*=\s*"([^"]+)"\s*;', text, re.M)
        return match.group(1) if match else ""
    fail(f"unknown version parser {parser!r}")


def read_current_version(product: str, graph: dict | None = None) -> str:
    path, parser = canonical_version_spec(product)
    version = parse_version_text((ROOT / path).read_text(encoding="utf-8"), path, parser)
    if not version:
        fail(f"{path} does not define a release version for {product}")
    return version


if __name__ == "__main__":
    fail(
        "tools/release/product_metadata.py is a Python compatibility module; "
        "use tools/dev/bun.sh tools/release/product-version.mjs version <product-id> for version reads"
    )
