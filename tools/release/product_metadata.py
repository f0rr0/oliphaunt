#!/usr/bin/env python3
"""Shared release product metadata.

Release identity comes from release-please manifest-mode config. Product-local
``release.toml`` files hold package and artifact metadata that release-please
does not own.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import tomllib
from functools import lru_cache
from pathlib import Path
from types import SimpleNamespace
from typing import Any, NoReturn


ROOT = Path(__file__).resolve().parents[2]
RELEASE_PLEASE_CONFIG_PATH = ROOT / "release-please-config.json"
RELEASE_PLEASE_MANIFEST_PATH = ROOT / ".release-please-manifest.json"
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
def _release_please_manifest() -> dict[str, Any]:
    return _read_json(RELEASE_PLEASE_MANIFEST_PATH)


def _moon_bin() -> str:
    if moon_bin := os.environ.get("MOON_BIN"):
        return moon_bin
    proto_moon = Path.home() / ".proto" / "bin" / "moon"
    return str(proto_moon) if proto_moon.exists() else "moon"


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


@lru_cache(maxsize=1)
def _moon_query_projects() -> list[dict[str, Any]]:
    output = subprocess.check_output([_moon_bin(), "query", "projects"], cwd=ROOT, text=True)
    value = json.loads(output)
    projects = value.get("projects")
    if not isinstance(projects, list):
        fail("moon query projects did not return a projects array")
    return projects


def _moon_project_release_metadata(project: dict[str, Any]) -> dict[str, Any] | None:
    config = project.get("config") if isinstance(project.get("config"), dict) else {}
    project_config = config.get("project") if isinstance(config.get("project"), dict) else {}
    metadata = project_config.get("metadata") if isinstance(project_config.get("metadata"), dict) else {}
    release = metadata.get("release")
    return release if isinstance(release, dict) else None


@lru_cache(maxsize=1)
def _moon_release_projects_by_component() -> dict[str, dict[str, Any]]:
    projects: dict[str, dict[str, Any]] = {}
    for project in _moon_query_projects():
        if not isinstance(project, dict) or not isinstance(project.get("id"), str):
            continue
        config = project.get("config") if isinstance(project.get("config"), dict) else {}
        tags = config.get("tags") if isinstance(config.get("tags"), list) else []
        release = _moon_project_release_metadata(project)
        if "release-product" not in tags:
            if release is not None:
                fail(f"Moon project {project['id']} declares release metadata but is not tagged release-product")
            continue
        if release is None:
            fail(f"Moon release product {project['id']} must declare project.metadata.release")
        component = release.get("component")
        package_path = release.get("packagePath")
        if not isinstance(component, str) or not component:
            fail(f"Moon release product {project['id']} must declare release.component")
        if component != project["id"]:
            fail(f"Moon release product {project['id']} release.component must match the project id")
        if not isinstance(package_path, str) or not package_path:
            fail(f"Moon release product {project['id']} must declare release.packagePath")
        if component in projects:
            fail(f"duplicate Moon release component {component}")
        projects[component] = {
            "project_id": project["id"],
            "project_source": project.get("source") or "",
            "path": package_path,
            "release": release,
        }
    if not projects:
        fail("Moon project graph does not contain any release-product projects")
    return dict(sorted(projects.items()))


@lru_cache(maxsize=1)
def _product_paths_by_id() -> dict[str, str]:
    moon_products = _moon_release_projects_by_component()
    release_please_products = _release_please_packages_by_component()
    moon_components = set(moon_products)
    release_please_components = set(release_please_products)
    if moon_components != release_please_components:
        fail(
            "Moon release-product components must match release-please components: "
            f"moon={sorted(moon_components)}, release-please={sorted(release_please_components)}"
        )
    paths: dict[str, str] = {}
    for component, metadata in moon_products.items():
        package_path = metadata["path"]
        release_please_path, package_config = release_please_products[component]
        if release_please_path != package_path:
            fail(
                f"{component} Moon release.packagePath {package_path!r} must match "
                f"release-please package path {release_please_path!r}"
            )
        if package_config.get("component") != component:
            fail(f"{package_path}.component must be {component!r}")
        paths[component] = package_path
    return paths


def package_path(product: str) -> str:
    paths = _product_paths_by_id()
    value = paths.get(product)
    if value is None:
        fail(f"unknown release product {product!r}")
    return value


def moon_release_metadata(product: str) -> dict[str, Any]:
    metadata = _moon_release_projects_by_component().get(product)
    if metadata is None:
        fail(f"unknown Moon release component {product!r}")
    release = metadata.get("release")
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

    return {
        "policy": {
            "repository": "f0rr0/oliphaunt",
            "default_branch": "main",
            "versioning": "independent",
        },
        "products": graph_products(),
        "artifact_targets": [],
    }


def graph_products(graph: dict | None = None) -> dict[str, dict[str, Any]]:
    products: dict[str, dict[str, Any]] = {}
    manifest = _release_please_manifest()
    for product, path in _product_paths_by_id().items():
        config = _effective_release_metadata(product)
        package_config = _package_config(product)
        config["path"] = path
        config["tag_prefix"] = tag_prefix(product)
        config["changelog_path"] = changelog_path(product)
        config["version_files"] = version_files(product)
        config.setdefault("derived_version_files", [])
        if path not in manifest:
            fail(f".release-please-manifest.json is missing {path}")
        products[product] = config
    return products


def product_config(product: str, graph: dict | None = None) -> dict[str, Any]:
    config = graph_products().get(product)
    if config is None:
        fail(f"unknown release product {product!r}")
    return config


def product_ids(graph: dict | None = None) -> list[str]:
    return list(graph_products())


def extension_product_ids(graph: dict | None = None) -> list[str]:
    return sorted(
        product
        for product, config in graph_products().items()
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


def ensure_semver(product: str, version: str) -> str:
    if not re.fullmatch(r"[0-9]+[.][0-9]+[.][0-9]+(?:[-+][0-9A-Za-z][0-9A-Za-z.-]*)?", version):
        fail(f"{product} version is not semver-like: {version!r}")
    return version


def main(argv: list[str]) -> int:
    if len(argv) == 2 and argv[0] == "version":
        print(ensure_semver(argv[1], read_current_version(argv[1])))
        return 0
    fail("usage: tools/release/product_metadata.py version <product-id>")


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
