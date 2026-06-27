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


@lru_cache(maxsize=None)
def _wasix_extension_package_names(product: str, targets: tuple[str, ...] = ()) -> dict[str, Any]:
    args: list[str] = ["--product", product]
    for target in targets:
        args.extend(["--target", target])
    value = _release_graph_query_json("wasix-extension-package-names", tuple(args))
    if not isinstance(value, dict):
        fail("release graph wasix-extension-package-names query must return a JSON object")
    if value.get("product") != product:
        fail(f"release graph wasix-extension-package-names returned product {value.get('product')!r}, expected {product!r}")
    package_name = value.get("packageName")
    if not isinstance(package_name, str) or not package_name:
        fail(f"release graph wasix-extension-package-names {product}.packageName must be a non-empty string")
    aot_packages = value.get("aotPackages")
    if not isinstance(aot_packages, list) or not all(isinstance(row, dict) for row in aot_packages):
        fail(f"release graph wasix-extension-package-names {product}.aotPackages must be an object list")
    return value


def wasix_extension_package_name(product: str) -> str:
    return str(_wasix_extension_package_names(product).get("packageName"))


def wasix_extension_aot_package_name(product: str, target: str) -> str:
    rows = _wasix_extension_package_names(product, (target,)).get("aotPackages")
    assert isinstance(rows, list)
    matches = [row for row in rows if row.get("target") == target]
    if len(matches) != 1:
        fail(f"release graph returned {len(matches)} WASIX extension AOT package names for {product}/{target}")
    package_name = matches[0].get("packageName")
    if not isinstance(package_name, str) or not package_name:
        fail(f"release graph wasix-extension-package-names {product}/{target}.packageName must be a non-empty string")
    return package_name


@lru_cache(maxsize=None)
def _expected_asset_rows(
    product: str,
    version: str,
    surface: str,
    published_only: bool,
    kinds: tuple[str, ...] | None,
) -> tuple[dict[str, Any], ...]:
    args: list[str] = ["--product", product, "--version", version, "--surface", surface]
    if not published_only:
        args.append("--include-unpublished")
    if kinds is not None:
        for kind in kinds:
            args.extend(["--kind", kind])
    return _release_graph_query_rows("expected-assets", tuple(args))


def _expected_asset_names(rows: Iterable[dict[str, Any]], *, context: str) -> list[str]:
    names: list[str] = []
    for row in rows:
        asset_name = row.get("assetName")
        artifact_target = row.get("artifactTarget")
        product = row.get("product")
        kind = row.get("kind")
        if not isinstance(asset_name, str) or not asset_name:
            fail(f"release graph expected-assets {context} assetName must be a non-empty string")
        if not isinstance(artifact_target, str) or not artifact_target:
            fail(f"release graph expected-assets {asset_name}.artifactTarget must be a non-empty string")
        if not isinstance(product, str) or not product:
            fail(f"release graph expected-assets {asset_name}.product must be a non-empty string")
        if not isinstance(kind, str) or not kind:
            fail(f"release graph expected-assets {asset_name}.kind must be a non-empty string")
        names.append(asset_name)
    if len(names) != len(set(names)):
        fail(f"release graph expected-assets returned duplicate names for {context}")
    if not names:
        fail(f"release graph returned no expected assets for {context}")
    return sorted(names)


def expected_assets(
    product: str,
    version: str,
    *,
    surface: str = "github-release",
    published_only: bool = True,
    kinds: Iterable[str] | None = None,
) -> list[str]:
    kind_tuple = None if kinds is None else tuple(sorted(set(kinds)))
    return _expected_asset_names(
        _expected_asset_rows(product, version, surface, published_only, kind_tuple),
        context=f"{product}/{surface}",
    )


@lru_cache(maxsize=None)
def _ci_artifact_name_rows(family: str, product: str, kind: str) -> tuple[dict[str, Any], ...]:
    return _release_graph_query_rows(
        "ci-artifact-names",
        ("--family", family, "--product", product, "--kind", kind),
    )


def _ci_artifact_names(family: str, product: str, kind: str) -> list[str]:
    names: list[str] = []
    for row in _ci_artifact_name_rows(family, product, kind):
        artifact_name = row.get("artifactName")
        artifact_target = row.get("artifactTarget")
        if row.get("family") != family or row.get("product") != product or row.get("kind") != kind:
            fail(f"release graph ci-artifact-names returned an unexpected row for {family}/{product}/{kind}")
        if not isinstance(artifact_name, str) or not artifact_name:
            fail(f"release graph ci-artifact-names {family}/{product}/{kind} artifactName must be a non-empty string")
        if not isinstance(artifact_target, str) or not artifact_target:
            fail(f"release graph ci-artifact-names {family}/{product}/{kind} artifactTarget must be a non-empty string")
        names.append(artifact_name)
    if len(names) != len(set(names)):
        fail(f"release graph ci-artifact-names returned duplicate artifacts for {family}/{product}/{kind}")
    if not names:
        fail(f"release graph returned no CI artifact names for {family}/{product}/{kind}")
    return sorted(names)


def ci_release_asset_artifact_names(product: str, kind: str) -> list[str]:
    return _ci_artifact_names("release-assets", product, kind)


def ci_npm_package_artifact_names(product: str, kind: str) -> list[str]:
    return _ci_artifact_names("npm-package", product, kind)


@lru_cache(maxsize=None)
def _local_publish_artifact_rows(aggregate_only: bool = False) -> tuple[dict[str, Any], ...]:
    args = ("--aggregate-only",) if aggregate_only else ()
    return _release_graph_query_rows("local-publish-artifacts", args)


def _local_publish_row_names(rows: Iterable[dict[str, Any]], *, context: str) -> list[str]:
    names: list[str] = []
    for row in rows:
        artifact_name = row.get("artifactName")
        aggregate = row.get("aggregate")
        family = row.get("family")
        if not isinstance(artifact_name, str) or not artifact_name:
            fail(f"release graph local-publish-artifacts {context} artifactName must be a non-empty string")
        if not isinstance(aggregate, bool):
            fail(f"release graph local-publish-artifacts {artifact_name}.aggregate must be true or false")
        if not isinstance(family, str) or not family:
            fail(f"release graph local-publish-artifacts {artifact_name}.family must be a non-empty string")
        names.append(artifact_name)
    if len(names) != len(set(names)):
        fail(f"release graph local-publish-artifacts returned duplicate names for {context}")
    if not names:
        fail(f"release graph returned no local-publish artifacts for {context}")
    return sorted(names)


def ci_local_publish_artifact_names(*, aggregate_only: bool = False) -> list[str]:
    return _local_publish_row_names(
        _local_publish_artifact_rows(aggregate_only),
        context="aggregate-only" if aggregate_only else "full preset",
    )


def _local_publish_artifact_names_by_family(family: str, *, aggregate_only: bool = False) -> list[str]:
    return _local_publish_row_names(
        (
            row
            for row in _local_publish_artifact_rows(aggregate_only)
            if row.get("family") == family
        ),
        context=family,
    )


def ci_wasix_aot_runtime_artifact_names() -> list[str]:
    return _local_publish_artifact_names_by_family("wasix-aot-runtime")


def ci_aggregate_release_asset_artifact_name(product: str) -> str:
    names = _local_publish_row_names(
        (
            row
            for row in _local_publish_artifact_rows(aggregate_only=True)
            if row.get("family") == "aggregate-release-assets" and row.get("product") == product
        ),
        context=f"aggregate release assets for {product}",
    )
    if len(names) != 1:
        fail(f"release graph returned {len(names)} aggregate release asset rows for {product}")
    return names[0]


def ci_wasix_runtime_artifact_names() -> list[str]:
    return _local_publish_artifact_names_by_family("wasix-runtime", aggregate_only=True)


@lru_cache(maxsize=1)
def _sdk_package_product_rows() -> tuple[dict[str, Any], ...]:
    return _release_graph_query_rows("sdk-package-products")


def _sdk_package_product_row(product: str) -> dict[str, Any]:
    matches = [row for row in _sdk_package_product_rows() if row.get("product") == product]
    if len(matches) != 1:
        fail(f"release graph sdk-package-products query must return one row for SDK product {product}, got {len(matches)}")
    return dict(matches[0])


def _sdk_row_string(row: dict[str, Any], key: str, product: str) -> str:
    value = row.get(key)
    if not isinstance(value, str) or not value:
        fail(f"release graph sdk-package-products {product}.{key} must be a non-empty string")
    return value


def ci_sdk_package_artifact_name(product: str) -> str:
    return _sdk_row_string(_sdk_package_product_row(product), "artifactName", product)


def sdk_package_products() -> tuple[str, ...]:
    products = tuple(_sdk_row_string(row, "product", "<unknown>") for row in _sdk_package_product_rows())
    if len(products) != len(set(products)):
        fail("release graph sdk-package-products query returned duplicate SDK products")
    if not products:
        fail("release graph returned no SDK package products")
    return products


def ci_sdk_package_artifact_names(product: str | None = None) -> list[str]:
    if product is not None:
        return [ci_sdk_package_artifact_name(product)]
    return [ci_sdk_package_artifact_name(sdk_product) for sdk_product in sdk_package_products()]


@lru_cache(maxsize=1)
def _typescript_optional_runtime_package_version_rows() -> tuple[dict[str, Any], ...]:
    return _release_graph_query_rows("typescript-optional-runtime-package-versions")


def typescript_optional_runtime_package_versions() -> dict[str, str]:
    versions: dict[str, str] = {}
    for row in _typescript_optional_runtime_package_version_rows():
        package_name = row.get("packageName")
        product = row.get("product")
        version = row.get("version")
        artifact_target = row.get("artifactTarget")
        if not isinstance(package_name, str) or not package_name:
            fail("typescript-optional-runtime-package-versions rows must declare a non-empty packageName")
        if not isinstance(product, str) or not product:
            fail(f"typescript-optional-runtime-package-versions {package_name}.product must be a non-empty string")
        if not isinstance(version, str) or not version:
            fail(f"typescript-optional-runtime-package-versions {package_name}.version must be a non-empty string")
        if not isinstance(artifact_target, str) or not artifact_target:
            fail(
                f"typescript-optional-runtime-package-versions {package_name}.artifactTarget "
                "must be a non-empty string"
            )
        if package_name in versions:
            fail(f"duplicate TypeScript optional runtime package target {package_name}")
        versions[package_name] = version
    if not versions:
        fail("release graph returned no TypeScript optional runtime package versions")
    return versions


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
    products: list[str] = []
    for row in _extension_metadata_rows():
        product = row.get("product")
        if not isinstance(product, str) or not product:
            fail("release graph extension-metadata rows must declare a non-empty product")
        products.append(product)
    if len(products) != len(set(products)):
        fail("release graph extension-metadata query returned duplicate extension products")
    if not products:
        fail("release graph returned no extension products")
    return sorted(products)


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
    return _local_publish_artifact_names_by_family("wasix-extension-artifacts", aggregate_only=True)


def ci_extension_package_artifact_names() -> list[str]:
    return _local_publish_artifact_names_by_family("extension-package-artifacts", aggregate_only=True)


def string_list(config: dict, key: str, product: str) -> list[str]:
    value = config.get(key, [])
    if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
        fail(f"{product}.{key} must be a string list")
    return value


@lru_cache(maxsize=None)
def _registry_package_rows(product: str, package_kind: str | None = None) -> tuple[dict[str, Any], ...]:
    args = ["--product", product]
    if package_kind is not None:
        args.extend(["--kind", package_kind])
    return _release_graph_query_rows("registry-packages", tuple(args))


def registry_package_names(product: str, package_kind: str) -> list[str]:
    names: list[str] = []
    for row in _registry_package_rows(product, package_kind):
        row_product = row.get("product")
        kind = row.get("packageKind")
        name = row.get("packageName")
        if row_product != product:
            fail(f"release graph registry-packages returned row for {row_product!r}, expected {product!r}")
        if kind != package_kind:
            fail(f"release graph registry-packages returned {product}.{kind!r}, expected {package_kind!r}")
        if not isinstance(name, str) or not name:
            fail(f"release graph registry-packages {product}.{package_kind} packageName must be a non-empty string")
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
