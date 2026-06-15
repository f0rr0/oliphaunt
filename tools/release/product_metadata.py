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
from typing import Any, NoReturn


ROOT = Path(__file__).resolve().parents[2]
RELEASE_PLEASE_CONFIG_PATH = ROOT / "release-please-config.json"
RELEASE_PLEASE_MANIFEST_PATH = ROOT / ".release-please-manifest.json"


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
        config = dict(_release_metadata(product))
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


def string_list(config: dict, key: str, product: str) -> list[str]:
    value = config.get(key, [])
    if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
        fail(f"{product}.{key} must be a string list")
    return value


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


def compatibility_version_specs(graph: dict | None = None) -> dict[str, tuple[str, str]]:
    specs: dict[str, tuple[str, str]] = {}
    for product in product_ids():
        raw_specs = _release_metadata(product).get("compatibility_versions", {})
        if not isinstance(raw_specs, dict):
            fail(f"{product}.compatibility_versions must be a table when present")
        for spec_id, spec in raw_specs.items():
            if not isinstance(spec_id, str) or not spec_id:
                fail(f"{product}.compatibility_versions keys must be non-empty strings")
            if not isinstance(spec, dict):
                fail(f"{product}.compatibility_versions.{spec_id} must be a table")
            path = spec.get("path")
            parser = spec.get("parser")
            if not isinstance(path, str) or not path:
                fail(f"{product}.compatibility_versions.{spec_id}.path must be a non-empty string")
            if not isinstance(parser, str) or not parser:
                fail(f"{product}.compatibility_versions.{spec_id}.parser must be a non-empty string")
            if not (ROOT / path).is_file():
                fail(f"{product}.compatibility_versions.{spec_id} path does not exist: {path}")
            specs[spec_id] = (path, parser)
    return specs


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


def parse_version_text(text: str, path: str, parser: str) -> str:
    if parser == "raw":
        return text.strip()
    if parser == "cargo":
        return parse_cargo_version(text, path)
    if parser.startswith("gradle:"):
        return parse_gradle_property(text, parser.split(":", 1)[1])
    if parser.startswith("json:"):
        return parse_json_path(text, parser.split(":", 1)[1])
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
