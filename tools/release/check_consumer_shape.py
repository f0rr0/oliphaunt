#!/usr/bin/env python3
"""Validate tracked consumer-facing package shape for Oliphaunt products.

This is deliberately not a public-registry install test. It proves that the
repository surfaces are directionally ready for consumers: package metadata,
install docs, generated app wiring, asset resolver hooks, and exact-extension
selection stay present and consistent with the release metadata.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import tomllib
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from types import SimpleNamespace
from typing import Any, NoReturn


ROOT = Path(__file__).resolve().parents[2]
DEFAULT_FIXTURE = ROOT / "src/shared/fixtures/consumer-shape/products.json"
SCHEMA = "oliphaunt-consumer-shape-v1"
SEVERITY_ORDER = {"P0": 0, "P1": 1, "P2": 2}
FORBIDDEN_INSTALL_SCRIPTS = {"preinstall", "install", "postinstall", "prepare"}
NATIVE_PAYLOAD_POLICY = json.loads(
    (ROOT / "tools/release/native-runtime-payload-policy.json").read_text(encoding="utf-8")
)
NATIVE_RUNTIME_TOOL_STEMS = tuple(NATIVE_PAYLOAD_POLICY["nativeRuntimeToolStems"])
NATIVE_TOOLS_TOOL_STEMS = tuple(NATIVE_PAYLOAD_POLICY["nativeToolsToolStems"])


def is_windows_native_target(target: str | None) -> bool:
    return target is not None and target.startswith("windows-")


def required_native_runtime_tools(target: str | None) -> tuple[str, ...]:
    if is_windows_native_target(target):
        return tuple(f"{stem}.exe" for stem in NATIVE_RUNTIME_TOOL_STEMS)
    return NATIVE_RUNTIME_TOOL_STEMS


def required_native_tools_package_tools(target: str | None) -> tuple[str, ...]:
    if is_windows_native_target(target):
        return tuple(f"{stem}.exe" for stem in NATIVE_TOOLS_TOOL_STEMS)
    return NATIVE_TOOLS_TOOL_STEMS


@dataclass(frozen=True)
class Finding:
    severity: str
    product: str
    check: str
    message: str
    evidence: tuple[str, ...]

    @property
    def id(self) -> str:
        return f"{self.product}.{self.check}"


def fail(message: str) -> NoReturn:
    print(f"check_consumer_shape.py: {message}", file=sys.stderr)
    raise SystemExit(2)


def relative(path: Path) -> str:
    return path.relative_to(ROOT).as_posix()


def read_text(path: str) -> str:
    full = ROOT / path
    if not full.is_file():
        fail(f"required checker input is missing: {path}")
    return full.read_text(encoding="utf-8")


def read_optional_text(path: str) -> str | None:
    full = ROOT / path
    if not full.is_file():
        return None
    return full.read_text(encoding="utf-8")


def read_json(path: str) -> dict:
    try:
        value = json.loads(read_text(path))
    except json.JSONDecodeError as error:
        fail(f"{path} is not valid JSON: {error}")
    if not isinstance(value, dict):
        fail(f"{path} must contain a JSON object")
    return value


def bun_json(args: list[str]) -> object:
    try:
        output = subprocess.check_output(
            ["tools/dev/bun.sh", *args],
            cwd=ROOT,
            text=True,
            stderr=subprocess.PIPE,
        )
    except subprocess.CalledProcessError as error:
        detail = (error.stderr or "").strip()
        if detail:
            fail(f"Bun metadata query failed: {detail}")
        fail(f"Bun metadata query failed with exit code {error.returncode}")
    try:
        return json.loads(output)
    except json.JSONDecodeError as error:
        fail(f"Bun metadata query did not return valid JSON: {error}")


@lru_cache(maxsize=None)
def release_graph_json(command: str, args: tuple[str, ...] = ()) -> Any:
    return bun_json(["tools/release/release_graph_query.mjs", command, *args])


@lru_cache(maxsize=None)
def release_graph_rows(command: str, args: tuple[str, ...] = ()) -> tuple[dict[str, Any], ...]:
    value = release_graph_json(command, args)
    if not isinstance(value, list) or not all(isinstance(row, dict) for row in value):
        fail(f"release graph {command} query must return a JSON object list")
    return tuple(value)


def string_list(value: Any, label: str) -> list[str]:
    if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
        fail(f"{label} must be a string list")
    return list(value)


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


def artifact_target_from_row(row: dict[str, Any]) -> ArtifactTarget:
    target_id = row.get("id")
    if not isinstance(target_id, str) or not target_id:
        fail("artifact target row must declare a non-empty id")
    surfaces = string_list(row.get("surfaces"), f"artifact target {target_id}.surfaces")
    values: dict[str, str] = {}
    for key in ["product", "kind", "target", "asset"]:
        value = row.get(key)
        if not isinstance(value, str) or not value:
            fail(f"artifact target {target_id}.{key} must be a non-empty string")
        values[key] = value
    published = row.get("published")
    if not isinstance(published, bool):
        fail(f"artifact target {target_id}.published must be true or false")
    optional: dict[str, str | None] = {}
    for key in [
        "triple",
        "runner",
        "library_relative_path",
        "executable_relative_path",
        "npm_package",
        "npm_os",
        "npm_cpu",
        "npm_libc",
        "llvm_url",
    ]:
        value = row.get(key)
        if value is not None and not isinstance(value, str):
            fail(f"artifact target {target_id}.{key} must be a string when present")
        optional[key] = value
    extension_artifacts = row.get("extension_artifacts", True)
    if not isinstance(extension_artifacts, bool):
        fail(f"artifact target {target_id}.extension_artifacts must be true or false")
    return ArtifactTarget(
        id=target_id,
        product=values["product"],
        kind=values["kind"],
        target=values["target"],
        asset=values["asset"],
        published=published,
        surfaces=tuple(surfaces),
        extension_artifacts=extension_artifacts,
        **optional,
    )


def artifact_target_args(
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


def artifact_targets(
    *,
    product: str | None = None,
    kind: str | None = None,
    surface: str | None = None,
    published_only: bool = False,
) -> list[ArtifactTarget]:
    return [
        artifact_target_from_row(row)
        for row in release_graph_rows(
            "artifact-targets",
            artifact_target_args(
                product=product,
                kind=kind,
                surface=surface,
                published_only=published_only,
            ),
        )
    ]


@lru_cache(maxsize=None)
def product_config_rows() -> tuple[dict[str, Any], ...]:
    rows = release_graph_rows("product-configs")
    seen: set[str] = set()
    for row in rows:
        product = row.get("product")
        if not isinstance(product, str) or not product:
            fail("release graph product-configs rows must declare a non-empty product")
        if product in seen:
            fail(f"release graph product-configs query returned duplicate product {product}")
        seen.add(product)
    if not rows:
        fail("release graph product-configs query returned no products")
    return rows


@lru_cache(maxsize=1)
def product_ids() -> tuple[str, ...]:
    return tuple(str(row["product"]) for row in product_config_rows())


def product_config(product: str) -> dict[str, Any]:
    matches = [row for row in product_config_rows() if row.get("product") == product]
    if len(matches) != 1:
        fail(f"release graph product-configs query returned {len(matches)} rows for {product}")
    return dict(matches[0])


def package_path(product: str) -> str:
    path = product_config(product).get("path")
    if not isinstance(path, str) or not path:
        fail(f"release graph product-configs {product}.path must be a non-empty string")
    return path


@lru_cache(maxsize=1)
def product_version_rows() -> tuple[dict[str, Any], ...]:
    rows = release_graph_rows("product-versions")
    seen: set[str] = set()
    for row in rows:
        product = row.get("product")
        version = row.get("version")
        if not isinstance(product, str) or not product:
            fail("release graph product-versions rows must declare a non-empty product")
        if not isinstance(version, str) or not version:
            fail(f"release graph product-versions {product}.version must be a non-empty string")
        if product in seen:
            fail(f"release graph product-versions query returned duplicate product {product}")
        seen.add(product)
    if not rows:
        fail("release graph product-versions query returned no products")
    return rows


def read_current_version(product: str) -> str:
    matches = [row for row in product_version_rows() if row.get("product") == product]
    if len(matches) != 1:
        fail(f"release graph product-versions query returned {len(matches)} rows for {product}")
    version = matches[0].get("version")
    if not isinstance(version, str) or not version:
        fail(f"release graph product-versions {product}.version must be a non-empty string")
    return version


def typescript_optional_runtime_package_versions() -> dict[str, str]:
    versions: dict[str, str] = {}
    for row in release_graph_rows("typescript-optional-runtime-package-versions"):
        package_name = row.get("packageName")
        version = row.get("version")
        if not isinstance(package_name, str) or not package_name:
            fail("typescript-optional-runtime-package-versions rows must declare a non-empty packageName")
        if not isinstance(version, str) or not version:
            fail(f"typescript-optional-runtime-package-versions {package_name}.version must be non-empty")
        if package_name in versions:
            fail(f"duplicate TypeScript optional runtime package target {package_name}")
        versions[package_name] = version
    if not versions:
        fail("release graph returned no TypeScript optional runtime package versions")
    return versions


@lru_cache(maxsize=1)
def wasix_cargo_artifact_contract() -> dict[str, Any]:
    value = release_graph_json("wasix-cargo-artifact-contract")
    if not isinstance(value, dict):
        fail("release graph wasix-cargo-artifact-contract query must return a JSON object")
    return value


def wasix_contract_string_list(key: str) -> tuple[str, ...]:
    return tuple(string_list(wasix_cargo_artifact_contract().get(key), f"WASIX Cargo artifact contract {key}"))


def wasix_contract_string_map(key: str) -> dict[str, str]:
    value = wasix_cargo_artifact_contract().get(key)
    if not isinstance(value, dict) or not all(
        isinstance(item_key, str)
        and item_key
        and isinstance(item_value, str)
        and item_value
        for item_key, item_value in value.items()
    ):
        fail(f"WASIX Cargo artifact contract {key} must be a string map")
    return dict(value)


def wasix_public_cargo_package_names() -> tuple[str, ...]:
    return wasix_contract_string_list("publicCargoPackageNames")


def wasix_public_aot_cargo_dependencies() -> dict[str, str]:
    return wasix_contract_string_map("publicAotCargoDependencies")


def wasix_public_tools_aot_cargo_dependencies() -> dict[str, str]:
    return wasix_contract_string_map("publicToolsAotCargoDependencies")


def wasix_public_tools_feature_dependencies() -> set[str]:
    return set(wasix_contract_string_list("publicToolsFeatureDependencies"))


def wasix_core_runtime_archive_files() -> tuple[str, ...]:
    return wasix_contract_string_list("coreRuntimeArchiveFiles")


def wasix_tools_payload_files() -> tuple[str, ...]:
    return wasix_contract_string_list("toolsPayloadFiles")


def wasix_forbidden_runtime_archive_tool_files() -> tuple[str, ...]:
    return wasix_contract_string_list("forbiddenRuntimeArchiveToolFiles")


def wasix_tools_aot_artifacts() -> set[str]:
    return set(wasix_contract_string_list("toolsAotArtifacts"))


def wasix_expected_extension_aot_targets() -> tuple[str, ...]:
    return wasix_contract_string_list("expectedExtensionAotTargets")


def expected_assets(
    product: str,
    version: str,
    *,
    surface: str = "github-release",
) -> list[str]:
    rows = release_graph_rows(
        "expected-assets",
        ("--product", product, "--version", version, "--surface", surface),
    )
    names: list[str] = []
    for row in rows:
        asset_name = row.get("assetName")
        if not isinstance(asset_name, str) or not asset_name:
            fail(f"release graph expected-assets {product}/{surface} row must declare a non-empty assetName")
        names.append(asset_name)
    if not names:
        fail(f"release graph returned no expected assets for {product}/{surface}")
    if len(names) != len(set(names)):
        fail(f"release graph expected-assets returned duplicate asset names for {product}/{surface}")
    return sorted(names)


def extension_artifact_targets(
    *,
    product: str | None = None,
    family: str | None = None,
    published_only: bool = False,
) -> tuple[SimpleNamespace, ...]:
    rows = []
    for row in release_graph_rows("extension-targets"):
        if product is not None and row.get("product") != product:
            continue
        if family is not None and row.get("family") != family:
            continue
        if published_only and row.get("published") is not True:
            continue
        rows.append(SimpleNamespace(**row))
    return tuple(rows)


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


def extension_product_ids() -> list[str]:
    products: list[str] = []
    for row in release_graph_rows("extension-metadata"):
        product = row.get("product")
        if not isinstance(product, str) or not product:
            fail("release graph extension-metadata rows must declare a non-empty product")
        products.append(product)
    if len(products) != len(set(products)):
        fail("release graph extension-metadata query returned duplicate products")
    return sorted(products)


@lru_cache(maxsize=1)
def wasix_extension_package_rows() -> tuple[dict[str, Any], ...]:
    rows = release_graph_rows("wasix-extension-package-names")
    seen: set[str] = set()
    for row in rows:
        product = row.get("product")
        package_name = row.get("packageName")
        aot_packages = row.get("aotPackages")
        if not isinstance(product, str) or not product:
            fail("release graph wasix-extension-package-names rows must declare a non-empty product")
        if product in seen:
            fail(f"release graph wasix-extension-package-names returned duplicate product {product}")
        seen.add(product)
        if not isinstance(package_name, str) or not package_name:
            fail(f"release graph wasix-extension-package-names {product}.packageName must be non-empty")
        if not isinstance(aot_packages, list) or not all(isinstance(item, dict) for item in aot_packages):
            fail(f"release graph wasix-extension-package-names {product}.aotPackages must be an object list")
    if not rows:
        fail("release graph returned no WASIX extension package names")
    return rows


def wasix_extension_package_contract(product: str) -> dict[str, Any]:
    matches = [row for row in wasix_extension_package_rows() if row.get("product") == product]
    if len(matches) != 1:
        fail(f"release graph wasix-extension-package-names returned {len(matches)} rows for {product}")
    return dict(matches[0])


def wasix_extension_package_name(product: str) -> str:
    return str(wasix_extension_package_contract(product).get("packageName"))


def wasix_extension_aot_package_name(product: str, target: str) -> str:
    rows = wasix_extension_package_contract(product).get("aotPackages")
    assert isinstance(rows, list)
    matches = [row for row in rows if row.get("target") == target]
    if len(matches) != 1:
        fail(f"release graph returned {len(matches)} WASIX extension AOT package names for {product}/{target}")
    package_name = matches[0].get("packageName")
    if not isinstance(package_name, str) or not package_name:
        fail(f"release graph wasix-extension-package-names {product}/{target}.packageName must be non-empty")
    return package_name


def read_toml(path: str) -> dict:
    try:
        return tomllib.loads(read_text(path))
    except tomllib.TOMLDecodeError as error:
        fail(f"{path} is not valid TOML: {error}")


def read_gradle_properties(path: str) -> dict[str, str]:
    values: dict[str, str] = {}
    for raw_line in read_text(path).splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip()
    return values


def parse_products_json(raw: str | None) -> list[str]:
    if raw is None:
        return []
    try:
        value = json.loads(raw)
    except json.JSONDecodeError as error:
        fail(f"--products-json must be valid JSON: {error}")
    if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
        fail("--products-json must be a JSON string list")
    known = set(product_ids())
    unknown = sorted(set(value) - known)
    if unknown:
        fail(f"unknown release products: {', '.join(unknown)}")
    return value


def load_fixture(path: Path) -> dict[str, dict]:
    if not path.is_file():
        fail(f"consumer-shape fixture is missing: {relative(path)}")
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        fail(f"{relative(path)} is not valid JSON: {error}")
    if payload.get("schema") != SCHEMA:
        fail(f"{relative(path)} must declare schema {SCHEMA}")
    products = payload.get("products")
    if not isinstance(products, dict):
        fail(f"{relative(path)} must contain a products object")
    for product, config in products.items():
        if not isinstance(config, dict):
            fail(f"{relative(path)} product {product} must be an object")
        files = config.get("files")
        if not isinstance(files, list) or not all(isinstance(item, str) for item in files):
            fail(f"{relative(path)} product {product}.files must be a string list")
        required_text = config.get("requiredText", {})
        if not isinstance(required_text, dict):
            fail(f"{relative(path)} product {product}.requiredText must be an object")
        for required_file, snippets in required_text.items():
            if required_file not in files:
                fail(f"{relative(path)} product {product} requires text in an undeclared file: {required_file}")
            if not isinstance(snippets, list) or not all(isinstance(item, str) for item in snippets):
                fail(f"{relative(path)} product {product}.requiredText[{required_file}] must be a string list")
    return products


def add(
    findings: list[Finding],
    product: str,
    check: str,
    message: str,
    evidence: str | list[str] | tuple[str, ...],
    *,
    severity: str = "P1",
) -> None:
    if isinstance(evidence, str):
        evidence_tuple = (evidence,)
    else:
        evidence_tuple = tuple(evidence)
    findings.append(Finding(severity, product, check, message, evidence_tuple))


def require(
    findings: list[Finding],
    product: str,
    check: str,
    condition: bool,
    message: str,
    evidence: str | list[str] | tuple[str, ...],
    *,
    severity: str = "P1",
) -> None:
    if not condition:
        add(findings, product, check, message, evidence, severity=severity)


def require_absent_text(
    findings: list[Finding],
    product: str,
    check: str,
    path: str,
    fragments: list[str] | tuple[str, ...],
    message: str,
    *,
    severity: str = "P0",
) -> None:
    text = read_text(path)
    present = [fragment for fragment in fragments if fragment in text]
    require(
        findings,
        product,
        check,
        not present,
        message,
        [f"{path}: {fragment}" for fragment in present] or path,
        severity=severity,
    )


def validate_fixture_contract(
    findings: list[Finding],
    fixture: dict[str, dict],
    selected_products: list[str],
) -> None:
    for product in selected_products:
        config = fixture.get(product)
        if config is None:
            add(
                findings,
                product,
                "missing-fixture",
                "Product has no consumer-shape fixture.",
                "src/shared/fixtures/consumer-shape/products.json",
                severity="P0",
            )
            continue
        for path in config["files"]:
            if not (ROOT / path).is_file():
                add(
                    findings,
                    product,
                    "required-file",
                    "Consumer-shape fixture references a file that does not exist.",
                    path,
                    severity="P0",
                )
        for path, snippets in config.get("requiredText", {}).items():
            text = read_optional_text(path)
            if text is None:
                continue
            missing = [snippet for snippet in snippets if snippet not in text]
            if missing:
                add(
                    findings,
                    product,
                    "required-text",
                    "Consumer-facing fixture text is missing.",
                    [f"{path}: {snippet}" for snippet in missing],
                    severity="P1",
                )


def product_registry_packages(product: str) -> list[str]:
    config = product_config(product)
    packages = config.get("registry_packages", [])
    if not isinstance(packages, list):
        fail(f"{product}.registry_packages must be a list")
    return [str(package) for package in packages]


def expected_extension_registry_packages(product: str) -> set[str]:
    rows = release_graph_rows("expected-extension-registry-packages", ("--product", product))
    packages: set[str] = set()
    for row in rows:
        raw = row.get("raw")
        if row.get("product") != product or not isinstance(raw, str) or ":" not in raw:
            fail(f"release graph expected-extension-registry-packages returned invalid row for {product}: {row!r}")
        packages.add(raw)
    if not packages:
        fail(f"release graph expected-extension-registry-packages returned no packages for {product}")
    return packages


def product_publish_targets(product: str) -> list[str]:
    config = product_config(product)
    targets = config.get("publish_targets", [])
    if not isinstance(targets, list):
        fail(f"{product}.publish_targets must be a list")
    return [str(target) for target in targets]


def npm_registry_packages(product: str, kind: str, surface: str) -> set[str]:
    packages = set()
    for target in artifact_targets(
        product=product,
        kind=kind,
        surface=surface,
        published_only=True,
    ):
        if target.npm_package is None:
            fail(f"{target.id} must declare npm_package for {surface}")
        packages.add(f"npm:{target.npm_package}")
    return packages


def liboliphaunt_native_expected_registry_packages() -> set[str]:
    runtime_targets = artifact_targets(
        product="liboliphaunt-native",
        kind="native-runtime",
        surface="rust-native-direct",
        published_only=True,
    )
    tools_targets = artifact_targets(
        product="liboliphaunt-native",
        kind="native-tools",
        surface="typescript-native-direct",
        published_only=True,
    )
    android_targets = artifact_targets(
        product="liboliphaunt-native",
        kind="native-runtime",
        surface="maven",
        published_only=True,
    )
    return {
        "npm:@oliphaunt/icu",
        "maven:dev.oliphaunt.runtime:oliphaunt-icu",
        "maven:dev.oliphaunt.runtime:liboliphaunt-runtime-resources",
        "crates:oliphaunt-tools",
        *{f"crates:liboliphaunt-native-{target.target}" for target in runtime_targets},
        *{f"crates:oliphaunt-tools-{target.target}" for target in tools_targets},
        *npm_registry_packages("liboliphaunt-native", "native-runtime", "typescript-native-direct"),
        *npm_registry_packages("liboliphaunt-native", "native-tools", "typescript-native-direct"),
        *{f"maven:dev.oliphaunt.runtime:liboliphaunt-{target.target}" for target in android_targets},
    }


def native_npm_tool_split_failures(
    root: str,
    *,
    tool_set: str,
) -> list[str]:
    failures: list[str] = []
    for package_json_path in sorted((ROOT / root).glob("*/package.json")):
        path = relative(package_json_path)
        package = read_json(path)
        metadata = package.get("oliphaunt", {})
        target = metadata.get("target") if isinstance(metadata, dict) else None
        if not isinstance(target, str) or not target:
            failures.append(f"{path}: missing oliphaunt.target")
            continue
        publish_config = package.get("publishConfig", {})
        executable_files = (
            publish_config.get("executableFiles") if isinstance(publish_config, dict) else None
        )
        if not isinstance(executable_files, list) or not all(
            isinstance(item, str) for item in executable_files
        ):
            failures.append(f"{path}: publishConfig.executableFiles={executable_files!r}")
            continue
        if tool_set == "runtime":
            expected_tools = required_native_runtime_tools(target)
        elif tool_set == "tools":
            expected_tools = required_native_tools_package_tools(target)
        else:
            fail(f"unsupported native npm tool split check: {tool_set}")
        expected = {f"./runtime/bin/{tool}" for tool in expected_tools}
        actual = set(executable_files)
        if actual != expected:
            failures.append(
                f"{path}: expected executableFiles={sorted(expected)!r}, got {sorted(actual)!r}"
            )
    return failures


def broker_expected_registry_packages() -> set[str]:
    targets = artifact_targets(
        product="oliphaunt-broker",
        kind="broker-helper",
        published_only=True,
    )
    return {
        *{f"crates:oliphaunt-broker-{target.target}" for target in targets},
        *npm_registry_packages("oliphaunt-broker", "broker-helper", "typescript-broker"),
    }


def npm_package_dirs(root: str) -> dict[str, str]:
    packages: dict[str, str] = {}
    for package_json_path in sorted((ROOT / root).glob("*/package.json")):
        path = relative(package_json_path)
        package = read_json(path)
        package_name = package.get("name")
        if not isinstance(package_name, str) or not package_name:
            fail(f"{path} must declare a package name")
        package_dir = relative(package_json_path.parent)
        if package_name in packages:
            fail(f"duplicate npm package name {package_name}: {packages[package_name]} and {package_dir}")
        packages[package_name] = package_dir
    return packages


def check_npm_package_common(
    findings: list[Finding],
    product: str,
    path: str,
    expected_name: str,
    expected_directory: str,
) -> dict:
    package = read_json(path)
    require(
        findings,
        product,
        "npm-name",
        package.get("name") == expected_name,
        "npm package name must match the public registry identity.",
        f"{path}: name={package.get('name')!r}",
        severity="P0",
    )
    require(
        findings,
        product,
        "npm-version",
        package.get("version") == read_current_version(product),
        "npm package version must match the release metadata product version.",
        f"{path}: version={package.get('version')!r}",
        severity="P0",
    )
    repository = package.get("repository", {})
    require(
        findings,
        product,
        "npm-repository",
        isinstance(repository, dict)
        and repository.get("url") == "git+https://github.com/f0rr0/oliphaunt.git"
        and repository.get("directory") == expected_directory,
        "npm package repository metadata must point at the public repo and product directory.",
        f"{path}: repository={repository!r}",
    )
    publish_config = package.get("publishConfig", {})
    require(
        findings,
        product,
        "npm-provenance",
        isinstance(publish_config, dict)
        and publish_config.get("access") == "public"
        and publish_config.get("provenance") is True,
        "npm publishConfig must opt into public provenance publishing.",
        f"{path}: publishConfig={publish_config!r}",
        severity="P0",
    )
    scripts = package.get("scripts", {})
    forbidden = sorted(set(scripts) & FORBIDDEN_INSTALL_SCRIPTS) if isinstance(scripts, dict) else []
    require(
        findings,
        product,
        "npm-install-scripts",
        not forbidden,
        "Consumer installs must not run native build or repository-local setup scripts.",
        f"{path}: forbidden scripts={', '.join(forbidden)}",
        severity="P0",
    )
    return package


def check_liboliphaunt(findings: list[Finding]) -> None:
    product = "liboliphaunt-native"
    version = read_text("src/runtimes/liboliphaunt/native/VERSION").strip()
    require(
        findings,
        product,
        "version-source",
        version == read_current_version(product),
        "liboliphaunt VERSION must be the release metadata version source.",
        f"src/runtimes/liboliphaunt/native/VERSION={version!r}",
        severity="P0",
    )
    expected_registry_packages = liboliphaunt_native_expected_registry_packages()
    require(
        findings,
        product,
        "liboliphaunt-platform-packages",
        {"github-release-assets", "npm", "maven-central", "crates-io"}.issubset(product_publish_targets(product))
        and set(product_registry_packages(product)) == expected_registry_packages,
        "liboliphaunt native runtime must publish package-manager artifacts for Rust, Node, Android, and optional ICU consumers.",
        f"src/runtimes/liboliphaunt/native/release.toml registry_packages={product_registry_packages(product)!r}",
        severity="P0",
    )
    native_packager = read_text("tools/release/package-liboliphaunt-cargo-artifacts.mjs")
    native_optimizer = read_text("tools/release/optimize_native_runtime_payload.mjs")
    native_linux_packager = read_text("tools/release/package-liboliphaunt-linux-assets.sh")
    native_macos_packager = read_text("tools/release/package-liboliphaunt-macos-assets.sh")
    native_windows_packager = read_text("tools/release/package-liboliphaunt-windows-assets.ps1")
    release_cli = read_text("tools/release/release.py")
    release_publish = read_text("tools/release/release-publish.mjs")
    release_product_dry_run = read_text("tools/release/release-product-dry-run.mjs")
    local_registry_publisher = read_text("tools/release/local-registry-publish.mjs")
    oliphaunt_build_source = read_text("src/sdks/rust/crates/oliphaunt-build/src/lib.rs")
    native_runtime_package_split_failures = native_npm_tool_split_failures(
        "src/runtimes/liboliphaunt/native/packages",
        tool_set="runtime",
    )
    native_tools_package_split_failures = native_npm_tool_split_failures(
        "src/runtimes/liboliphaunt/native/tools-packages",
        tool_set="tools",
    )
    require(
        findings,
        product,
        "liboliphaunt-native-tool-split",
        set(NATIVE_RUNTIME_TOOL_STEMS) == {"initdb", "pg_ctl", "postgres"}
        and set(NATIVE_TOOLS_TOOL_STEMS) == {"pg_dump", "psql"}
        and "--exclude '/bin/pg_dump'" in native_linux_packager
        and "--exclude '/bin/psql'" in native_linux_packager
        and "--exclude '/bin/pg_dump'" in native_macos_packager
        and "--exclude '/bin/psql'" in native_macos_packager
        and 'Remove-Item -Force (Join-Path (Join-Path $Stage "runtime/bin") $Tool)' in native_windows_packager
        and "missing oliphaunt-tools native release asset" in native_packager
        and "extractArchive(toolsArchive, toolsRoot)" in native_packager
        and "validateToolsTargetPair" in native_packager
        and "writeToolsFacadeCrate" in native_packager
        and "packageBase: TOOLS_PRODUCT" in native_packager
        and "artifactProduct: TOOLS_PRODUCT" in native_packager
        and 'toolSet: "runtime"' in native_packager
        and 'toolSet: "tools"' in native_packager
        and "required_runtime_member_paths" in release_cli
        and "required_tools_member_paths" in release_cli
        and "stage_liboliphaunt_tools_npm_payloads" in release_cli
        and "ensure_native_tools_absent_from_runtime" in release_cli
        and "oliphaunt-tools-${libVersion}-*" in local_registry_publisher
        and "DEFAULT_CURRENT_ARTIFACT_ROOT" in local_registry_publisher
        and "copyReleaseAssetSet" in local_registry_publisher
        and "nativeSplitReleaseAssetsReady" in local_registry_publisher
        and "nativeNpmReleaseAssetsReady" in local_registry_publisher
        and "nativeSplitReleaseAssetMissingMessage" in local_registry_publisher
        and "nativeNpmReleaseAssetMissingMessage" in local_registry_publisher
        and "stageReleaseAssetNpmPackages(roots, registryRoot, result, strict)" in local_registry_publisher
        and "cargoDependencyNameMatchesHostTarget" in local_registry_publisher
        and "host target artifact dependencies" in local_registry_publisher
        and "NON_PUBLISHABLE_LOCAL_CARGO_CRATE_PREFIXES" in local_registry_publisher
        and "isDefaultCargoTmpCrateArtifact" in local_registry_publisher
        and "ignored malformed Cargo scratch artifact" in local_registry_publisher
        and 'native_tool_paths(&self.target, &["postgres", "initdb", "pg_ctl"])'
        in oliphaunt_build_source
        and 'native_tool_paths(&self.target, &["pg_dump", "psql"])' in oliphaunt_build_source
        and "artifact_manifest_accepts_windows_native_split_payloads" in oliphaunt_build_source
        and "artifact_manifest_rejects_linux_native_runtime_with_windows_tool_names"
        in oliphaunt_build_source
        and "artifact_manifest_rejects_windows_native_tools_with_unix_tool_names"
        in oliphaunt_build_source
        and "NATIVE_RUNTIME_TOOL_STEMS" in native_optimizer
        and "NATIVE_TOOLS_TOOL_STEMS" in native_optimizer
        and not native_runtime_package_split_failures
        and not native_tools_package_split_failures,
        "Native root packages and crates must keep postgres/initdb/pg_ctl only, with pg_dump/psql published through oliphaunt-tools packages/crates.",
        [
            "tools/release/optimize_native_runtime_payload.mjs",
            "tools/release/package-liboliphaunt-linux-assets.sh",
            "tools/release/package-liboliphaunt-macos-assets.sh",
            "tools/release/package-liboliphaunt-windows-assets.ps1",
            "tools/release/package-liboliphaunt-cargo-artifacts.mjs",
            "tools/release/local-registry-publish.mjs",
            "tools/release/release.py",
            *native_runtime_package_split_failures,
            *native_tools_package_split_failures,
        ],
        severity="P0",
    )
    icu_package = read_json("src/runtimes/liboliphaunt/native/icu-npm/package.json")
    icu_metadata = icu_package.get("oliphaunt", {})
    require(
        findings,
        product,
        "liboliphaunt-icu-npm-package",
        icu_package.get("name") == "@oliphaunt/icu"
        and icu_package.get("version") == version
        and isinstance(icu_metadata, dict)
        and icu_metadata.get("product") == "oliphaunt-icu"
        and icu_metadata.get("kind") == "icu-data"
        and icu_metadata.get("target") == "portable"
        and icu_metadata.get("dataRelativePath") == "share/icu",
        "Optional native ICU data must publish as a standalone portable npm package.",
        "src/runtimes/liboliphaunt/native/icu-npm/package.json",
        severity="P0",
    )
    icu_podspec = read_text("src/runtimes/liboliphaunt/native/icu-npm/OliphauntICU.podspec")
    release_config = read_json("release-please-config.json")
    native_release = release_config.get("packages", {}).get("src/runtimes/liboliphaunt/native", {})
    native_extra_files = native_release.get("extra-files", [])
    require(
        findings,
        product,
        "liboliphaunt-icu-release-versioning",
        f"s.version = '{version}'" in icu_podspec
        and "x-release-please-version" in icu_podspec
        and {
            "type": "json",
            "path": "icu-npm/package.json",
            "jsonpath": "$.version",
        }
        in native_extra_files
        and {"type": "generic", "path": "icu-npm/OliphauntICU.podspec"} in native_extra_files,
        "Optional native ICU npm and podspec descriptors must version with liboliphaunt-native.",
        "release-please-config.json and src/runtimes/liboliphaunt/native/icu-npm/OliphauntICU.podspec",
        severity="P0",
    )
    release_cli = read_text("tools/release/release.py")
    workflow = read_text(".github/workflows/release.yml")
    require(
        findings,
        product,
        "liboliphaunt-icu-npm-podspec-packaging",
        'extra_descriptors=("OliphauntICU.podspec",)' in release_cli
        and "packed_icu_package_contains" in release_cli,
        "Optional native ICU npm publication must include the React Native iOS podspec and validate the packed tarball.",
        "tools/release/release.py",
        severity="P0",
    )
    for required, source, label in [
        (
            "package-liboliphaunt-cargo-artifacts.mjs",
            release_product_dry_run,
            "tools/release/release-product-dry-run.mjs",
        ),
        (
            "publishLiboliphauntNativeCargoArtifacts",
            release_publish,
            "tools/release/release-publish.mjs",
        ),
        (
            "liboliphauntNativeCargoArtifactPackages",
            release_product_dry_run,
            "tools/release/release-product-dry-run.mjs",
        ),
    ]:
        require(
            findings,
            product,
            "liboliphaunt-rust-artifact-crates",
            required in source,
            "liboliphaunt native Rust consumers must resolve release assets from Cargo artifact crates.",
            f"{label} missing {required}",
            severity="P0",
        )
    require(
        findings,
        product,
        "liboliphaunt-rust-artifact-workflow",
        "Publish liboliphaunt native artifact packages to crates.io" in workflow,
        "Release workflow must publish liboliphaunt native Cargo artifact crates before the Rust SDK.",
        ".github/workflows/release.yml",
        severity="P0",
    )
    packaging_scripts = {
        "tools/release/package-liboliphaunt-macos-assets.sh": [
            "oliphaunt_assert_base_runtime_has_no_optional_extensions",
            "optimize_native_runtime_payload.mjs",
            "plpgsql.dylib",
            "$stage/lib/modules/",
            "liboliphaunt-${version}-${target_id}.tar.gz",
            "run-host-c-smoke.mjs",
        ],
        "tools/release/package-liboliphaunt-linux-assets.sh": [
            "oliphaunt_assert_base_runtime_has_no_optional_extensions",
            "optimize_native_runtime_payload.mjs",
            "plpgsql.so",
            "$stage/lib/modules/",
            "liboliphaunt-${version}-${target_id}.tar.gz",
            "run-host-c-smoke.mjs",
        ],
        "tools/release/package-liboliphaunt-windows-assets.ps1": [
            "Assert-BaseRuntimeHasNoOptionalExtensions",
            "optimize_native_runtime_payload.mjs",
            "plpgsql.dll",
            "lib/modules",
            'Copy-Item -Recurse -Force (Join-Path $Runtime "*") (Join-Path $Stage "runtime")',
            "liboliphaunt-$Version-$TargetId.zip",
            "run-host-c-smoke.mjs",
        ],
        "tools/release/package-liboliphaunt-mobile-assets.sh": [
            "oliphaunt_assert_base_runtime_has_no_optional_extensions",
            "liboliphaunt-${version}-runtime-resources",
            "liboliphaunt-${version}-icu-data",
            "liboliphaunt-${version}-apple-spm-xcframework.zip",
        ],
        "tools/release/package-liboliphaunt-aggregate-assets.sh": [
            "liboliphaunt-${version}-release-assets.sha256",
            "check-liboliphaunt-release-assets.mjs",
        ],
    }
    for script_path, required_snippets in packaging_scripts.items():
        script = read_text(script_path)
        for required in required_snippets:
            require(
                findings,
                product,
                "asset-packaging",
                required in script,
                "liboliphaunt release packaging must publish base runtime assets and checksums through the active CI packagers.",
                f"{script_path} missing {required}",
                severity="P0",
            )
        for forbidden in [
            "write_extension_asset_index_header",
            "src/extensions/artifacts/native/tools/package-release-assets.sh",
        ]:
            require(
                findings,
                product,
                "asset-packaging",
                forbidden not in script,
                "liboliphaunt release packaging must not publish exact-extension artifacts; extension products own those assets.",
                f"{script_path} still contains {forbidden}",
                severity="P0",
            )
    windows_packager = read_text("tools/release/package-liboliphaunt-windows-assets.ps1")
    for forbidden in [
        "Stage-EmbeddedPlpgsqlModule",
        "runtime/lib/postgresql/plpgsql.dll",
        "Assert-SameFileBytes",
    ]:
        require(
            findings,
            product,
            "windows-runtime-plpgsql",
            forbidden not in windows_packager,
            "Windows release packaging must keep PostgreSQL's normal runtime PL/pgSQL module because initdb loads it during bootstrap.",
            f"tools/release/package-liboliphaunt-windows-assets.ps1 still contains {forbidden}",
            severity="P0",
        )
    for script_path, forbidden in {
        "tools/release/package-liboliphaunt-macos-assets.sh": "$stage/runtime/lib/postgresql/plpgsql.dylib",
        "tools/release/package-liboliphaunt-linux-assets.sh": "$stage/runtime/lib/postgresql/plpgsql.so",
    }.items():
        script = read_text(script_path)
        require(
            findings,
            product,
            "desktop-runtime-plpgsql",
            forbidden not in script and "stage_embedded_plpgsql_module" not in script,
            "Desktop release packaging must keep PostgreSQL's normal runtime PL/pgSQL module; liboliphaunt selects embedded modules at backend startup.",
            f"{script_path} still mutates runtime PL/pgSQL",
            severity="P0",
        )

    native_build_scripts = {
        "src/runtimes/liboliphaunt/native/bin/build-postgres18-macos.sh": [
            "embedded_postgis_make_args",
            "embedded_module_be_dllibs=\"-L$out_dir -loliphaunt -Wl,-rpath,$out_dir\"",
            "macos_embedded_module_link_args()",
            "printf '%s\\n' \"PG_LDFLAGS=$pg_ldflags\"",
            "printf '%s\\n' \"BE_DLLLIBS=$be_dllibs\"",
            "local embedded_pg_ldflags=\"$embedded_module_be_dllibs\"",
            "done < <(macos_embedded_module_link_args \"$embedded_pg_ldflags\" \"$embedded_module_be_dllibs\")",
            "done < <(pgxs_extension_link_args \"$extension\" \"embedded\" \"$embedded_module_be_dllibs\")",
            "macos_embedded_module_link_args \"$link_flags\" \"$be_dllibs\"",
            "embedded_postgis_ldflags=\"$embedded_module_be_dllibs\"",
            "LDFLAGS=$embedded_postgis_ldflags ${arg#LDFLAGS=}",
            "BE_DLLLIBS=\"$embedded_module_be_dllibs\" \"${embedded_postgis_make_args[@]}\"",
            "audit_embedded_extension_modules",
        ],
    }
    for script_path, required_snippets in native_build_scripts.items():
        script = read_text(script_path)
        for required in required_snippets:
            require(
                findings,
                product,
                "native-embedded-extension-linkage",
                required in script,
                "Native embedded extension builds must force PostgreSQL symbol lookup through liboliphaunt before platform system libraries.",
                f"{script_path} missing {required}",
                severity="P0",
            )

    native_runtime_sources = {
        "src/runtimes/liboliphaunt/native/src/liboliphaunt_fs.c": [
            "oliphaunt_resolve_embedded_module_dir",
            "oliphaunt_loaded_library_path_dup",
            "lib/modules",
            "out/modules",
        ],
        "src/runtimes/liboliphaunt/native/src/liboliphaunt_native.c": [
            "set_backend_embedded_module_dir_env",
            "OLIPHAUNT_EMBEDDED_MODULE_DIR_ENV",
            "restore_backend_env_var",
        ],
        "src/runtimes/liboliphaunt/native/patches/postgresql-18.4/0010-liboliphaunt-use-host-runtime-paths.patch": [
            "OLIPHAUNT_EMBEDDED_MODULE_DIR",
            "strlcpy(pkglib_path, module_dir, MAXPGPATH)",
            "get_pkglib_path(my_exec_path, pkglib_path)",
        ],
    }
    for source_path, required_snippets in native_runtime_sources.items():
        source = read_text(source_path)
        for required in required_snippets:
            require(
                findings,
                product,
                "embedded-module-path",
                required in source,
                "Native direct release assets must resolve liboliphaunt-linked modules from lib/modules without mutating the standalone PostgreSQL runtime tree.",
                f"{source_path} missing {required}",
                severity="P0",
            )


def check_rust(findings: list[Finding]) -> None:
    product = "oliphaunt-rust"
    manifest = read_toml("src/sdks/rust/Cargo.toml")
    build_manifest = read_toml("src/sdks/rust/crates/oliphaunt-build/Cargo.toml")
    package = manifest.get("package", {})
    build_package = build_manifest.get("package", {})
    product_version = read_current_version(product)
    require(
        findings,
        product,
        "cargo-name",
        package.get("name") == "oliphaunt",
        "Rust SDK crate name must match the public crates.io package.",
        f"src/sdks/rust/Cargo.toml package.name={package.get('name')!r}",
        severity="P0",
    )
    require(
        findings,
        product,
        "cargo-version",
        package.get("version") == product_version,
        "Rust SDK crate version must match the release metadata product version.",
        f"src/sdks/rust/Cargo.toml package.version={package.get('version')!r}",
        severity="P0",
    )
    require(
        findings,
        product,
        "artifact-relay-links",
        package.get("links") == "oliphaunt_artifact_relay" and package.get("build") == "build.rs",
        "Rust SDK must expose Cargo artifact manifests to application build scripts through a stable links relay.",
        f"src/sdks/rust/Cargo.toml package.links={package.get('links')!r} package.build={package.get('build')!r}",
        severity="P0",
    )
    require(
        findings,
        product,
        "build-helper-cargo-name",
        build_package.get("name") == "oliphaunt-build",
        "Rust build helper crate name must match the public crates.io package.",
        f"src/sdks/rust/crates/oliphaunt-build/Cargo.toml package.name={build_package.get('name')!r}",
        severity="P0",
    )
    require(
        findings,
        product,
        "build-helper-cargo-version",
        build_package.get("version") == product_version,
        "Rust build helper crate version must match the Rust SDK product version.",
        f"src/sdks/rust/crates/oliphaunt-build/Cargo.toml package.version={build_package.get('version')!r}",
        severity="P0",
    )
    bins = {item.get("name") for item in manifest.get("bin", []) if isinstance(item, dict)}
    require(
        findings,
        product,
        "cargo-binaries",
        "oliphaunt-resources" in bins,
        "Rust SDK must ship the runtime resource helper binary it documents.",
        "missing [[bin]] oliphaunt-resources",
        severity="P0",
    )
    require(
        findings,
        product,
        "registry-package",
        {"crates:oliphaunt", "crates:oliphaunt-build"}.issubset(product_registry_packages(product)),
        "Rust SDK release metadata must publish the SDK and build helper to crates.io.",
        "src/sdks/rust/release.toml",
        severity="P0",
    )
    build_source = read_text("src/sdks/rust/crates/oliphaunt-build/src/lib.rs")
    require(
        findings,
        product,
        "build-helper-no-network",
        not any(fragment in build_source for fragment in ["ureq", "reqwest", "OLIPHAUNT_RELEASE_BASE_URL", "github.com"]),
        "oliphaunt-build must stage Cargo-resolved artifacts without network downloads.",
        "src/sdks/rust/crates/oliphaunt-build/src/lib.rs",
        severity="P0",
    )
    require(
        findings,
        product,
        "build-helper-out-dir",
        "OUT_DIR" in build_source and "target/oliphaunt" not in build_source,
        "oliphaunt-build must use Cargo OUT_DIR for generated resources.",
        "src/sdks/rust/crates/oliphaunt-build/src/lib.rs",
        severity="P0",
    )
    relay_source = read_text("src/sdks/rust/build.rs")
    require(
        findings,
        product,
        "artifact-relay-build-script",
        "DEP_OLIPHAUNT_ARTIFACT_" in relay_source
        and "cargo::metadata=" in relay_source
        and "RELAY_ENV_PREFIX" in relay_source,
        "Rust SDK build script must relay direct Cargo artifact metadata to application build scripts.",
        "src/sdks/rust/build.rs",
        severity="P0",
    )
    sdk_manifest_text = read_text("src/sdks/rust/Cargo.toml")
    require(
        findings,
        product,
        "publish-only-broker-dependencies",
        "oliphaunt-broker-linux-x64-gnu" not in sdk_manifest_text
        and "renderReleaseCargoToml(" in read_text("tools/release/prepare-rust-release-source.mjs"),
        "Rust SDK source manifest must stay local-check friendly; broker artifact dependencies are injected into the generated publish source.",
        "src/sdks/rust/Cargo.toml and tools/release/prepare-rust-release-source.mjs",
        severity="P0",
    )
    require_absent_text(
        findings,
        product,
        "public-docs-no-cli-first-install",
        "src/sdks/rust/README.md",
        [
            "oliphaunt-resources --prebuilt-extension",
            "oliphaunt-resources --extension",
            "Missing URL-backed artifacts are downloaded",
            "--extension-cache",
        ],
        "Rust public README must not document maintainer CLI/download flows as the consumer extension install path.",
    )


def check_broker(findings: list[Finding]) -> None:
    product = "oliphaunt-broker"
    manifest = read_toml("src/runtimes/broker/Cargo.toml")
    package = manifest.get("package", {})
    require(
        findings,
        product,
        "cargo-name",
        package.get("name") == "oliphaunt-broker",
        "Broker runtime package name must match the helper executable product.",
        f"src/runtimes/broker/Cargo.toml package.name={package.get('name')!r}",
        severity="P0",
    )
    bins = {item.get("name") for item in manifest.get("bin", []) if isinstance(item, dict)}
    require(
        findings,
        product,
        "broker-binary",
        "oliphaunt-broker" in bins,
        "Broker runtime must ship the oliphaunt-broker executable.",
        "missing [[bin]] oliphaunt-broker",
        severity="P0",
    )
    require(
        findings,
        product,
        "release-assets",
        "github-release-assets" in product_publish_targets(product),
        "Broker runtime must publish platform helper binaries as release assets.",
        "src/runtimes/broker/release.toml",
        severity="P0",
    )
    expected_registry_packages = broker_expected_registry_packages()
    require(
        findings,
        product,
        "broker-npm-platform-packages",
        {"crates-io", "npm"}.issubset(product_publish_targets(product))
        and set(product_registry_packages(product)) == expected_registry_packages,
        "Broker runtime must publish platform helper binaries as npm packages and Cargo artifact crates.",
        f"src/runtimes/broker/release.toml registry_packages={product_registry_packages(product)!r}",
        severity="P0",
    )
    version = read_current_version(product)
    for target in artifact_targets(
        product=product,
        kind="broker-helper",
        surface="rust-broker",
        published_only=True,
    ):
        crate_name = f"oliphaunt-broker-{target.target}"
        crate_dir = Path("src/runtimes/broker/crates") / target.target
        manifest_path = crate_dir / "Cargo.toml"
        source_path = crate_dir / "src/lib.rs"
        build_path = crate_dir / "build.rs"
        manifest = read_toml(manifest_path.as_posix())
        package = manifest.get("package", {})
        require(
            findings,
            product,
            f"broker-cargo-artifact-{target.target}",
            package.get("name") == crate_name
            and package.get("version") == version
            and package.get("links") == f"oliphaunt_artifact_broker_{target.target.replace('-', '_')}"
            and package.get("build") == "build.rs"
            and manifest.get("workspace") == {},
            "Broker Cargo artifact descriptor crates must match broker artifact target metadata.",
            manifest_path.as_posix(),
            severity="P0",
        )
        source = read_text(source_path.as_posix())
        require(
            findings,
            product,
            f"broker-cargo-artifact-source-{target.target}",
            f'RELEASE_TARGET: &str = "{target.target}"' in source
            and f'CARGO_TARGET: &str = "{target.triple}"' in source
            and f'EXECUTABLE_RELATIVE_PATH: &str = "{target.executable_relative_path}"' in source,
            "Broker Cargo artifact source constants must match broker artifact target metadata.",
            source_path.as_posix(),
            severity="P0",
        )
        build_source = read_text(build_path.as_posix())
        require(
            findings,
            product,
            f"broker-cargo-artifact-build-{target.target}",
            "cargo::metadata=manifest=" in build_source
            and "OLIPHAUNT_ARTIFACT_CRATE_REQUIRE_PAYLOAD" in build_source
            and not any(fragment in build_source for fragment in ["ureq", "reqwest", "github.com"]),
            "Broker Cargo artifact build scripts must emit Cargo manifests from packaged payloads without network access.",
            build_path.as_posix(),
            severity="P0",
        )


def check_node_direct(findings: list[Finding]) -> None:
    product = "oliphaunt-node-direct"
    package = read_json("src/runtimes/node-direct/package.json")
    version = read_current_version(product)
    require(
        findings,
        product,
        "npm-name",
        package.get("name") == "@oliphaunt/node-direct" and package.get("private") is True,
        "Node direct root package must stay a private source/build package; only platform packages are published.",
        f"src/runtimes/node-direct/package.json name={package.get('name')!r} private={package.get('private')!r}",
        severity="P0",
    )
    require(
        findings,
        product,
        "npm-version",
        package.get("version") == version,
        "Node direct root package version must match the release metadata product version.",
        f"src/runtimes/node-direct/package.json version={package.get('version')!r}",
        severity="P0",
    )
    metadata = package.get("oliphaunt", {})
    require(
        findings,
        product,
        "node-direct-liboliphaunt-pin",
        isinstance(metadata, dict)
        and metadata.get("liboliphauntVersion") == read_current_version("liboliphaunt-native"),
        "Node direct source package must pin the compatible native liboliphaunt runtime version.",
        f"src/runtimes/node-direct/package.json oliphaunt={metadata!r}",
        severity="P0",
    )
    scripts = package.get("scripts", {})
    forbidden = sorted(set(scripts) & FORBIDDEN_INSTALL_SCRIPTS) if isinstance(scripts, dict) else []
    require(
        findings,
        product,
        "npm-install-scripts",
        not forbidden,
        "Node direct source package must not run native build scripts during consumer install.",
        f"src/runtimes/node-direct/package.json forbidden scripts={', '.join(forbidden)}",
        severity="P0",
    )
    require(
        findings,
        product,
        "release-targets",
        {"npm", "github-release-assets"}.issubset(product_publish_targets(product))
        and {
            "node-api-prebuilds",
            "npm-optional-platform-packages",
        }.issubset(set(product_config(product).get("release_artifacts", []))),
        "Node direct must publish both GitHub prebuild assets and optional npm platform packages.",
        "src/runtimes/node-direct/release.toml",
        severity="P0",
    )

    node_targets = artifact_targets(
        product=product,
        kind="node-direct-addon",
        surface="npm-optional",
        published_only=True,
    )
    expected_packages = {
        target.npm_package: target
        for target in node_targets
        if target.npm_package is not None and target.npm_os is not None and target.npm_cpu is not None
    }
    require(
        findings,
        product,
        "registry-packages",
        len(expected_packages) == len(node_targets)
        and set(product_registry_packages(product)) == {f"npm:{name}" for name in expected_packages},
        "Node direct release metadata must publish exactly the optional platform npm packages.",
        f"src/runtimes/node-direct/release.toml registry_packages={product_registry_packages(product)!r}",
        severity="P0",
    )
    package_dirs = npm_package_dirs("src/runtimes/node-direct/packages")
    require(
        findings,
        product,
        "platform-package-dirs",
        set(package_dirs) == set(expected_packages),
        "Node direct package directories must match published artifact target npm packages exactly.",
        f"src/runtimes/node-direct/packages package names={sorted(package_dirs)!r}",
        severity="P0",
    )
    for package_name, target in expected_packages.items():
        package_dir = package_dirs.get(package_name)
        if package_dir is None:
            continue
        package_path = f"{package_dir}/package.json"
        optional_package = check_npm_package_common(
            findings,
            product,
            package_path,
            package_name,
            package_dir,
        )
        expected_libc = [target.npm_libc] if target.npm_libc is not None else None
        require(
            findings,
            product,
            "node-direct-platform-package",
            optional_package.get("optional") is True
            and optional_package.get("os") == [target.npm_os]
            and optional_package.get("cpu") == [target.npm_cpu]
            and (expected_libc is None or optional_package.get("libc") == expected_libc),
            "Node direct platform packages must constrain npm installation to the matching OS, CPU, and libc.",
            f"{package_path}: os={optional_package.get('os')!r} cpu={optional_package.get('cpu')!r} libc={optional_package.get('libc')!r}",
            severity="P0",
        )
        require(
            findings,
            product,
            "node-direct-platform-package",
            "prebuilds" in optional_package.get("files", [])
            and optional_package.get("exports", {}).get("./oliphaunt_node.node") == "./prebuilds/oliphaunt_node.node",
            "Node direct platform packages must expose the prebuilt addon by the stable export path.",
            f"{package_path}: files={optional_package.get('files')!r} exports={optional_package.get('exports')!r}",
            severity="P0",
        )


def check_swift(findings: list[Finding]) -> None:
    product = "oliphaunt-swift"
    version = read_text("src/sdks/swift/VERSION").strip()
    lib_version = read_text("src/sdks/swift/LIBOLIPHAUNT_VERSION").strip()
    require(
        findings,
        product,
        "swift-version",
        version == read_current_version(product),
        "Swift SDK VERSION must be the release metadata product version.",
        f"src/sdks/swift/VERSION={version!r}",
        severity="P0",
    )
    require(
        findings,
        product,
        "swift-liboliphaunt-pin",
        lib_version == read_current_version("liboliphaunt-native"),
        "Swift SDK must pin the compatible liboliphaunt release.",
        f"src/sdks/swift/LIBOLIPHAUNT_VERSION={lib_version!r}",
        severity="P0",
    )
    root_package = read_text("Package.swift")
    for required in [
        'name: "Oliphaunt"',
        ".iOS(.v17)",
        ".macOS(.v14)",
        'path: "src/sdks/swift/Sources/COliphaunt"',
        'path: "src/sdks/swift/Sources/Oliphaunt"',
    ]:
        require(
            findings,
            product,
            "swiftpm-source-package",
            required in root_package,
            "Root SwiftPM source package must remain a normal Apple consumer entrypoint.",
            f"Package.swift missing {required}",
            severity="P0",
        )
    renderer = read_text("tools/release/render_swiftpm_release_package.mjs")
    for required in ["binaryTarget(", "checksum", "base Swift package must not require or publish extension files"]:
        require(
            findings,
            product,
            "swiftpm-release-manifest",
            required in renderer,
            "Swift release manifest renderer must checksum-pin the base binary target and keep extensions separate.",
            f"tools/release/render_swiftpm_release_package.mjs missing {required}",
            severity="P0",
        )
    for forbidden in ["extension_rows", "OliphauntExtension"]:
        require(
            findings,
            product,
            "swiftpm-release-manifest",
            forbidden not in renderer,
            "Swift base release manifest renderer must not synthesize exact-extension products.",
            f"tools/release/render_swiftpm_release_package.mjs still contains {forbidden}",
            severity="P0",
        )
    swift_tests = read_text("src/sdks/swift/Tests/OliphauntTests/OliphauntTests.swift")
    require(
        findings,
        product,
        "swift-runtime-resource-layout-test",
        "@Test\nfunc runtimeResourcesRejectUnsupportedPackageKindLayout() throws" in swift_tests,
        "Swift runtime-resource layout rejection must stay covered by an executable test.",
        "src/sdks/swift/Tests/OliphauntTests/OliphauntTests.swift",
        severity="P0",
    )


def check_kotlin(findings: list[Finding]) -> None:
    product = "oliphaunt-kotlin"
    props = read_gradle_properties("src/sdks/kotlin/gradle.properties")
    require(
        findings,
        product,
        "kotlin-coordinates",
        props.get("GROUP") == "dev.oliphaunt",
        "Kotlin SDK group must match the public Maven coordinates.",
        f"src/sdks/kotlin/gradle.properties GROUP={props.get('GROUP')!r}",
        severity="P0",
    )
    require(
        findings,
        product,
        "kotlin-version",
        props.get("VERSION_NAME") == read_current_version(product),
        "Kotlin SDK version must match the release metadata product version.",
        f"src/sdks/kotlin/gradle.properties VERSION_NAME={props.get('VERSION_NAME')!r}",
        severity="P0",
    )
    pinned_lib = read_text(
        "src/sdks/kotlin/oliphaunt-android-gradle-plugin/src/main/resources/dev/oliphaunt/android/liboliphaunt.version"
    ).strip()
    require(
        findings,
        product,
        "android-liboliphaunt-pin",
        pinned_lib == read_current_version("liboliphaunt-native"),
        "Android Gradle plugin must pin the compatible liboliphaunt release.",
        f"liboliphaunt.version={pinned_lib!r}",
        severity="P0",
    )
    plugin_source = read_text(
        "src/sdks/kotlin/oliphaunt-android-gradle-plugin/src/main/java/dev/oliphaunt/android/OliphauntAndroidPlugin.java"
    )
    resolver_source = read_text(
        "src/sdks/kotlin/oliphaunt-android-gradle-plugin/src/main/java/dev/oliphaunt/android/ResolveOliphauntAndroidAssetsTask.java"
    )
    android_plugin_surface = plugin_source + "\n" + resolver_source
    for required in ["dev.oliphaunt.android", "oliphauntExtensions", "resolveOliphauntAndroidAssets"]:
        require(
            findings,
            product,
            "android-consumer-plugin",
            required in plugin_source,
            "Android SDK must expose an app-applied Gradle plugin for consumer asset wiring.",
            f"OliphauntAndroidPlugin.java missing {required}",
            severity="P0",
        )
    for required in [
        "oliphauntExtensionVersions",
        "manifest.properties",
    ]:
        require(
            findings,
            product,
            "android-exact-extension-resolver",
            required in android_plugin_surface,
            "Android asset resolver must consume exact-extension package products rather than liboliphaunt-bundled extension indexes.",
            f"ResolveOliphauntAndroidAssetsTask.java missing {required}",
            severity="P0",
        )
    android_extension_validation_fragments = [
        "extractExtensionRuntimeArtifact(sqlName, artifact)",
        'copyTree(new File(artifactRoot, "files").toPath(), runtimeFiles.toPath())',
        "validateSelectedExtensionRuntimeFiles(runtimeFiles, artifacts);",
        "private static void validateSelectedExtensionRuntimeFiles",
        'artifact.sqlName + ".control"',
        '" is missing packaged control file "',
        "extensionSqlFiles(runtimeFiles, artifact.sqlName);",
        'file.getName().startsWith(sqlName + "--")',
        'file.getName().endsWith(".sql")',
        '" has no packaged SQL files in "',
    ]
    require(
        findings,
        product,
        "android-exact-extension-runtime-validation",
        all(fragment in resolver_source for fragment in android_extension_validation_fragments),
        "Android exact-extension resolver must validate selected Maven runtime artifacts by SQL name and reject manifests unless the merged runtime contains the selected control file and versioned SQL files.",
        "src/sdks/kotlin/oliphaunt-android-gradle-plugin/src/main/java/dev/oliphaunt/android/ResolveOliphauntAndroidAssetsTask.java",
        severity="P0",
    )
    maven_artifact_publisher = read_text("src/sdks/kotlin/oliphaunt-maven-artifacts/build.gradle.kts")
    release_publish = read_text("tools/release/release-publish.mjs")
    release_product_dry_run = read_text("tools/release/release-product-dry-run.mjs")
    release_workflow = read_text(".github/workflows/release.yml")
    for required in [
        "include(\":oliphaunt-maven-artifacts\")",
        "MavenPublication",
        "OLIPHAUNT_MAVEN_ARTIFACTS_MANIFEST",
        "extension = \"tar.gz\"",
        "validateOliphauntMavenArtifacts",
    ]:
        require(
            findings,
            product,
            "android-maven-artifact-publisher",
            required in maven_artifact_publisher or required in read_text("src/sdks/kotlin/settings.gradle.kts"),
            "Android runtime and extension tarballs must publish through a manifest-driven Maven artifact publisher.",
            f"missing {required}",
            severity="P0",
        )
    for required, source, label in [
        (
            "build_maven_artifact_manifest.mjs",
            release_product_dry_run,
            "tools/release/release-product-dry-run.mjs",
        ),
        (
            "publishLiboliphauntRuntimeMaven",
            release_publish,
            "tools/release/release-publish.mjs",
        ),
        (
            "publishSelectedExtensionMaven",
            release_publish,
            "tools/release/release-publish.mjs",
        ),
        (
            "publishSelectedExtensionNpm",
            release_publish,
            "tools/release/release-publish.mjs",
        ),
        (
            "publishSelectedExtensionCargo",
            release_publish,
            "tools/release/release-publish.mjs",
        ),
        (
            ":oliphaunt-maven-artifacts:publishAndReleaseToMavenCentral",
            release_publish,
            "tools/release/release-publish.mjs",
        ),
    ]:
        require(
            findings,
            product,
            "android-maven-release-hooks",
            required in source,
            "Release CLI must publish Android runtime artifacts plus exact-extension Maven, npm, and Cargo packages.",
            f"{label} missing {required}",
            severity="P0",
        )
    maven_artifact_release_helper = ""
    if "export function runMavenArtifactPublisher(" in release_product_dry_run:
        maven_artifact_release_helper = release_product_dry_run.split("export function runMavenArtifactPublisher(", 1)[1].split("\nexport function ", 1)[0]
    require(
        findings,
        product,
        "android-maven-artifact-publisher-cache-mode",
        "--no-configuration-cache" in maven_artifact_release_helper
        and "--configuration-cache" not in maven_artifact_release_helper,
        "Manifest-driven Maven artifact publishing must not use Gradle configuration cache.",
        "run_maven_artifact_publisher must pass --no-configuration-cache",
        severity="P0",
    )
    for required in [
        "Publish liboliphaunt Android runtime artifacts to Maven Central",
        "Publish selected extension Android artifacts to Maven Central",
        "Publish selected extension packages to npm",
        "Publish selected extension Cargo artifact crates to crates.io",
    ]:
        require(
            findings,
            product,
            "android-maven-release-workflow",
            required in release_workflow,
            "Release workflow must run Maven Central publication for Android runtime artifacts plus exact-extension Maven, npm, and Cargo packages.",
            f".github/workflows/release.yml missing {required}",
            severity="P0",
        )
    for source_path in [
        "src/sdks/kotlin/oliphaunt-android-gradle-plugin/src/main/java/dev/oliphaunt/android/OliphauntAndroidPlugin.java",
        "src/sdks/kotlin/oliphaunt-android-gradle-plugin/src/main/java/dev/oliphaunt/android/ResolveOliphauntAndroidAssetsTask.java",
        "src/sdks/kotlin/oliphaunt/build.gradle.kts",
    ]:
        require_absent_text(
            findings,
            product,
            "android-no-runtime-downloads",
            source_path,
            [
                "github.com/f0rr0/oliphaunt/releases/download",
                "openStream()",
                "downloadAsset(",
                "downloadAndVerify(",
                "downloadAndVerifyExtension(",
                "downloadExtensionAsset(",
                "assetBaseUrl",
                "release-asset-cache",
            ],
            "Android consumer builds must resolve runtime and extension bytes through Gradle/Maven dependencies, not GitHub release downloads.",
        )
    require_absent_text(
        findings,
        product,
        "android-public-docs-no-runtime-downloads",
        "src/sdks/kotlin/README.md",
        [
            "downloads and verifies",
            "GitHub release assets during the normal Gradle build",
            "https://github.com/f0rr0/oliphaunt/releases/download",
            "PoliphauntAssetBaseUrl",
        ],
        "Kotlin public README must not document GitHub release downloads as the Android consumer install path.",
    )


def check_react_native(findings: list[Finding]) -> None:
    product = "oliphaunt-react-native"
    package = check_npm_package_common(
        findings,
        product,
        "src/sdks/react-native/package.json",
        "@oliphaunt/react-native",
        "src/sdks/react-native",
    )
    require(
        findings,
        product,
        "rn-peer-dependencies",
        "react-native" in package.get("peerDependencies", {}) and "react" in package.get("peerDependencies", {}),
        "React Native package must peer-depend on React and React Native instead of bundling app frameworks.",
        "src/sdks/react-native/package.json peerDependencies",
        severity="P0",
    )
    require(
        findings,
        product,
        "rn-codegen",
        isinstance(package.get("codegenConfig"), dict)
        and package["codegenConfig"].get("jsSrcsDir") == "src/specs"
        and package.get("react-native") == "lib/module/index.js",
        "React Native package must expose New Architecture Codegen metadata and compiled React Native entrypoint.",
        "src/sdks/react-native/package.json",
        severity="P0",
    )
    metadata = package.get("oliphaunt", {})
    require(
        findings,
        product,
        "rn-sdk-compatibility",
        isinstance(metadata, dict)
        and metadata.get("swiftSdkVersion") == read_current_version("oliphaunt-swift")
        and metadata.get("kotlinSdkVersion") == read_current_version("oliphaunt-kotlin"),
        "React Native package must pin compatible Swift and Kotlin SDK versions.",
        f"src/sdks/react-native/package.json oliphaunt={metadata!r}",
        severity="P0",
    )
    plugin = read_text("src/sdks/react-native/app.plugin.js")
    for required in [
        "extension '${extension}' must be an exact PostgreSQL extension name",
        "oliphauntExtensions",
        "OliphauntExtensions.json",
        "pod 'Oliphaunt'",
        "dev.oliphaunt.android",
    ]:
        require(
            findings,
            product,
            "expo-config-plugin",
            required in plugin,
            "React Native config plugin must wire exact extension selection through iOS and Android app projects.",
            f"src/sdks/react-native/app.plugin.js missing {required}",
            severity="P0",
        )
    podspec = read_text("src/sdks/react-native/OliphauntReactNative.podspec")
    require(
        findings,
        product,
        "rn-podspec",
        's.dependency "Oliphaunt", native_sdk_version' in podspec and "install_modules_dependencies(s)" in podspec,
        "React Native podspec must delegate iOS runtime behavior to the Swift SDK and RN autolinking.",
        "src/sdks/react-native/OliphauntReactNative.podspec",
        severity="P0",
    )
    android_gradle = read_text("src/sdks/react-native/android/build.gradle")
    rn_check = read_text("src/sdks/react-native/tools/check-sdk.sh")
    rn_extension_validation_fragments = [
        'validateSelectedExtensionFiles(new File(output, "oliphaunt/runtime/files"), selectedExtensions.get())',
        "validateSelectedExtensionFiles(filesDir, extensions)",
        "private static void validateSelectedExtensionFiles",
        "is missing control file",
        "has no packaged SQL files in",
        "PNPM_CONFIG_LOCKFILE",
        "src/sdks/kotlin/gradlew",
        "react-native-split-incomplete-extension",
        "prebuilt runtime resources accepted a selected extension without packaged SQL files",
    ]
    require(
        findings,
        product,
        "rn-android-extension-file-validation",
        all(
            fragment in android_gradle or fragment in rn_check
            for fragment in rn_extension_validation_fragments
        ),
        "React Native Android must reject selected extensions when split or prebuilt runtime resources lack packaged control/SQL files.",
        [
            "src/sdks/react-native/android/build.gradle",
            "src/sdks/react-native/tools/check-sdk.sh",
        ],
        severity="P0",
    )


def check_typescript(findings: list[Finding]) -> None:
    product = "oliphaunt-js"
    package = check_npm_package_common(
        findings,
        product,
        "src/sdks/js/package.json",
        "@oliphaunt/ts",
        "src/sdks/js",
    )
    require(
        findings,
        product,
        "ts-no-regular-runtime-deps",
        package.get("dependencies") in ({}, None),
        "TypeScript SDK must install liboliphaunt runtime resources through the selected optional platform package.",
        f"src/sdks/js/package.json dependencies={package.get('dependencies')!r}",
        severity="P0",
    )
    expected_optional = typescript_optional_runtime_package_versions()
    optional_dependencies = package.get("optionalDependencies", {})
    require(
        findings,
        product,
        "ts-runtime-optional-deps",
        isinstance(optional_dependencies, dict)
        and optional_dependencies
        == {name: f"workspace:{version}" for name, version in expected_optional.items()},
        "TypeScript SDK must select native runtime helpers through exact optional platform packages and must not install ICU by default.",
        f"src/sdks/js/package.json optionalDependencies={optional_dependencies!r}",
        severity="P0",
    )
    metadata = package.get("oliphaunt", {})
    require(
        findings,
        product,
        "ts-sdk-compatibility",
        isinstance(metadata, dict)
        and metadata.get("liboliphauntVersion") == read_current_version("liboliphaunt-native")
        and metadata.get("icuPackage") == "@oliphaunt/icu"
        and metadata.get("icuVersion") == read_current_version("liboliphaunt-native")
        and metadata.get("brokerVersion") == read_current_version("oliphaunt-broker")
        and metadata.get("nodeDirectAddonVersion") == read_current_version("oliphaunt-node-direct"),
        "TypeScript SDK must pin compatible liboliphaunt, optional ICU, broker-helper, and Node direct versions.",
        f"src/sdks/js/package.json oliphaunt={metadata!r}",
        severity="P0",
    )
    exports = package.get("exports", {})
    for export_name in [".", "./node", "./bun", "./deno", "./protocol", "./query"]:
        require(
            findings,
            product,
            "ts-exports",
            export_name in exports,
            "TypeScript SDK must publish runtime-specific and protocol exports.",
            f"src/sdks/js/package.json missing exports[{export_name}]",
            severity="P0",
        )
    jsr = read_json("src/sdks/js/jsr.json")
    require(
        findings,
        product,
        "jsr-version",
        jsr.get("version") == read_current_version(product),
        "JSR version must match the TypeScript release metadata product version.",
        f"src/sdks/js/jsr.json version={jsr.get('version')!r}",
        severity="P0",
    )
    jsr_exports = jsr.get("exports", {})
    require(
        findings,
        product,
        "jsr-exports",
        isinstance(jsr_exports, dict)
        and {".", "./protocol", "./query"}.issubset(jsr_exports)
        and not {"./node", "./bun", "./deno"}.intersection(jsr_exports),
        "JSR package must expose protocol/query entrypoints and no native runtime entrypoints.",
        f"src/sdks/js/jsr.json exports={jsr_exports!r}",
        severity="P0",
    )


def check_wasm(findings: list[Finding]) -> None:
    product = "oliphaunt-wasix-rust"
    manifest = read_toml("src/bindings/wasix-rust/crates/oliphaunt-wasix/Cargo.toml")
    package = manifest.get("package", {})
    require(
        findings,
        product,
        "wasm-crate-name",
        package.get("name") == "oliphaunt-wasix",
        "WASM crate name must match the public crate.",
        f"oliphaunt-wasix Cargo.toml package.name={package.get('name')!r}",
        severity="P0",
    )
    require(
        findings,
        product,
        "wasm-version",
        package.get("version") == read_current_version(product),
        "WASM crate version must match the release metadata product version.",
        f"oliphaunt-wasix Cargo.toml package.version={package.get('version')!r}",
        severity="P0",
    )
    metadata = package.get("metadata", {}).get("oliphaunt-wasix", {}).get("assets", {})
    require(
        findings,
        product,
        "wasm-pg18",
        metadata.get("postgres-version") == "18.4",
        "WASM consumer crate must advertise the active PostgreSQL 18.4 runtime.",
        f"package.metadata.oliphaunt-wasix.assets.postgres-version={metadata.get('postgres-version')!r}",
        severity="P0",
    )
    features = manifest.get("features", {})
    require(
        findings,
        product,
        "wasm-bundled-assets",
        "bundled" not in features and "extensions" in features,
        "WASM crate must not expose an inert bundled feature; runtime artifacts must come from package-manager-resolved artifact products.",
        "oliphaunt-wasix Cargo.toml features",
        severity="P0",
    )
    lib_rs = read_text("src/bindings/wasix-rust/crates/oliphaunt-wasix/src/lib.rs")
    require(
        findings,
        product,
        "wasm-bundled-assets",
        'compile_error!' not in lib_rs and "does not embed WASIX runtime assets" not in lib_rs,
        "The WASM crate must remove the inert bundled feature contract instead of publishing a feature that always fails.",
        "src/bindings/wasix-rust/crates/oliphaunt-wasix/src/lib.rs",
        severity="P0",
    )
    require(
        findings,
        product,
        "wasm-default-features",
        features.get("default") == [],
        "WASM crate default features must not depend on unpublished runtime asset crates.",
        f"oliphaunt-wasix Cargo.toml default={features.get('default')!r}",
        severity="P0",
    )
    expected_tools_feature = (
        wasix_public_tools_feature_dependencies()
    )
    require(
        findings,
        product,
        "wasm-tools-feature",
        set(features.get("tools", [])) == expected_tools_feature,
        "WASM crate must keep pg_dump/psql artifacts behind an explicit tools feature.",
        f"oliphaunt-wasix Cargo.toml tools={features.get('tools')!r}",
        severity="P0",
    )
    pg_dump_source = read_text(
        "src/bindings/wasix-rust/crates/oliphaunt-wasix/src/oliphaunt/pg_dump.rs"
    )
    server_source = read_text(
        "src/bindings/wasix-rust/crates/oliphaunt-wasix/src/oliphaunt/server.rs"
    )
    require(
        findings,
        product,
        "wasm-tools-preflight-api",
        "pub fn preflight_wasix_tools() -> Result<()>" in pg_dump_source
        and "pub fn preflight_tools(&self) -> Result<()>" in server_source
        and "preflight_wasix_tools" in lib_rs
        and "load_pg_dump_module(&engine)" in pg_dump_source
        and "load_psql_module(&engine)" in pg_dump_source,
        "WASM Rust SDK must expose an explicit split pg_dump/psql tools preflight that validates WASM payloads and target AOT artifacts before first tool use.",
        [
            "src/bindings/wasix-rust/crates/oliphaunt-wasix/src/lib.rs",
            "src/bindings/wasix-rust/crates/oliphaunt-wasix/src/oliphaunt/server.rs",
            "src/bindings/wasix-rust/crates/oliphaunt-wasix/src/oliphaunt/pg_dump.rs",
        ],
        severity="P0",
    )
    oliphaunt_build_source = read_text("src/sdks/rust/crates/oliphaunt-build/src/lib.rs")
    require(
        findings,
        product,
        "wasm-build-tools-opt-in",
        "fn oliphaunt_wasix_tools_enabled(&self) -> bool" in oliphaunt_build_source
        and 'dependencies_enable_feature(&self.dependencies, "oliphaunt-wasix", "tools")'
        in oliphaunt_build_source
        and "wasix_runtime_without_tools_stages_root_runtime_only" in oliphaunt_build_source
        and "wasix_runtime_with_tools_feature_stages_split_tools" in oliphaunt_build_source,
        "oliphaunt-build must keep WASIX pg_dump/psql staging behind the explicit tools opt-in instead of treating tools as root runtime assets.",
        "src/sdks/rust/crates/oliphaunt-build/src/lib.rs",
        severity="P0",
    )
    release_check_source = read_text("src/bindings/wasix-rust/tools/check-release.sh")
    wasix_rust_moon_source = read_text("src/bindings/wasix-rust/moon.yml")
    require(
        findings,
        product,
        "wasm-tools-release-preflight",
        "OLIPHAUNT_WASM_AOT_VERIFY=full" in release_check_source
        and "preflight_wasix_tools_loads_split_artifacts" in release_check_source
        and "--no-run" not in release_check_source
        and 'command: "bash src/bindings/wasix-rust/tools/check-release.sh"' in wasix_rust_moon_source
        and "liboliphaunt-wasix:runtime-aot" in wasix_rust_moon_source
        and '"/target/oliphaunt-wasix/aot/**/*"' in wasix_rust_moon_source,
        "WASM Rust release-check must execute the split pg_dump/psql tools preflight against release-shaped WASIX AOT artifacts.",
        [
            "src/bindings/wasix-rust/tools/check-release.sh",
            "src/bindings/wasix-rust/moon.yml",
        ],
        severity="P0",
    )
    runtime_version = read_current_version("liboliphaunt-wasix")
    dependencies = manifest.get("dependencies", {})
    target_tables = manifest.get("target", {})
    expected_runtime_dependency = dependencies.get("liboliphaunt-wasix-portable")
    expected_tools_dependency = dependencies.get("oliphaunt-wasix-tools")
    expected_icu_dependency = dependencies.get("oliphaunt-icu")
    require(
        findings,
        product,
        "wasm-runtime-artifact-dependency",
        isinstance(expected_runtime_dependency, dict)
        and expected_runtime_dependency.get("version") == f"={runtime_version}",
        "WASM crate must depend on the public portable runtime artifact crate at the liboliphaunt-wasix version.",
        f"liboliphaunt-wasix-portable dependency={expected_runtime_dependency!r}",
        severity="P0",
    )
    require(
        findings,
        product,
        "wasm-tools-artifact-dependency",
        isinstance(expected_tools_dependency, dict)
        and expected_tools_dependency.get("version") == f"={runtime_version}"
        and expected_tools_dependency.get("optional") is True,
        "WASM crate must depend optionally on the public WASIX tools artifact crate at the liboliphaunt-wasix version.",
        f"oliphaunt-wasix-tools dependency={expected_tools_dependency!r}",
        severity="P0",
    )
    icu_source_manifest = read_toml("src/runtimes/liboliphaunt/icu/Cargo.toml")
    icu_source_version = icu_source_manifest.get("package", {}).get("version")
    require(
        findings,
        product,
        "wasm-local-icu-dependency",
        isinstance(expected_icu_dependency, dict)
        and expected_icu_dependency.get("version") == f"={icu_source_version}"
        and expected_icu_dependency.get("path") == "../../../../runtimes/liboliphaunt/icu"
        and expected_icu_dependency.get("optional") is True,
        "WASM source crate must keep the ICU feature wired to the local oliphaunt-icu path crate; release packaging rewrites this edge to the published runtime version.",
        f"oliphaunt-icu dependency={expected_icu_dependency!r}",
        severity="P0",
    )
    expected_aot_dependencies = (
        wasix_public_aot_cargo_dependencies()
    )
    expected_tools_aot_dependencies = (
        wasix_public_tools_aot_cargo_dependencies()
    )
    missing_aot_dependencies = []
    for cfg, crate in expected_aot_dependencies.items():
        target = target_tables.get(cfg)
        target_dependencies = target.get("dependencies", {}) if isinstance(target, dict) else {}
        dependency = target_dependencies.get(crate)
        if not isinstance(dependency, dict) or dependency.get("version") != f"={runtime_version}":
            missing_aot_dependencies.append(f"{cfg}:{crate}")
    for cfg, crate in expected_tools_aot_dependencies.items():
        target = target_tables.get(cfg)
        target_dependencies = target.get("dependencies", {}) if isinstance(target, dict) else {}
        dependency = target_dependencies.get(crate)
        if (
            not isinstance(dependency, dict)
            or dependency.get("version") != f"={runtime_version}"
            or dependency.get("optional") is not True
        ):
            missing_aot_dependencies.append(f"{cfg}:{crate}")
    require(
        findings,
        product,
        "wasm-aot-artifact-dependencies",
        not missing_aot_dependencies,
        "WASM crate must depend on every public target-specific root AOT crate and optional tools AOT crate behind exact Cargo target cfgs.",
        missing_aot_dependencies or "src/bindings/wasix-rust/crates/oliphaunt-wasix/Cargo.toml",
        severity="P0",
    )
    aot_source = read_text("src/bindings/wasix-rust/crates/oliphaunt-wasix/src/oliphaunt/aot.rs")
    missing_aot_cfgs = [
        cfg.removeprefix("cfg(").removesuffix(")")
        for cfg in expected_aot_dependencies
        if cfg.removeprefix("cfg(").removesuffix(")") not in aot_source
    ]
    require(
        findings,
        product,
        "wasm-aot-rust-cfgs-match-cargo",
        not missing_aot_cfgs,
        "WASM AOT Rust cfgs must match the Cargo target dependency cfgs so unsupported target environments do not reference missing crates.",
        missing_aot_cfgs or "src/bindings/wasix-rust/crates/oliphaunt-wasix/src/oliphaunt/aot.rs",
        severity="P0",
    )
    relay_source = read_text("src/bindings/wasix-rust/crates/oliphaunt-wasix/build.rs")
    require(
        findings,
        product,
        "wasm-artifact-relay-build-script",
        package.get("links") == "oliphaunt_artifact_wasix_relay"
        and package.get("build") == "build.rs"
        and "DEP_OLIPHAUNT_ARTIFACT_" in relay_source
        and "cargo::metadata=" in relay_source,
        "WASM crate must relay Cargo-resolved runtime/tool/AOT artifact manifests through Cargo links metadata.",
        "src/bindings/wasix-rust/crates/oliphaunt-wasix/build.rs",
        severity="P0",
    )
    for source_path in [
        "src/bindings/wasix-rust/crates/oliphaunt-wasix/README.md",
        "src/docs/content/sdk/wasm/guide.mdx",
        "src/docs/content/sdk/wasm/runtime.mdx",
        "src/docs/content/sdk/wasm/index.mdx",
    ]:
        require_absent_text(
            findings,
            product,
            "wasm-public-docs-no-archive-env",
            source_path,
            [
                "OLIPHAUNT_WASM_RUNTIME_ARCHIVE",
                "OLIPHAUNT_WASM_AOT_ARCHIVE",
                "OLIPHAUNT_WASM_AOT_DIR",
                "GitHub release",
            ],
            "WASIX public docs must not document app-owned runtime archive environment variables or release-asset downloads as the consumer install path.",
        )
    for source_path in [
        "src/bindings/wasix-rust/crates/oliphaunt-wasix/src/lib.rs",
        "src/bindings/wasix-rust/crates/oliphaunt-wasix/src/oliphaunt/base.rs",
        "src/bindings/wasix-rust/crates/oliphaunt-wasix/src/oliphaunt/aot.rs",
    ]:
        require_absent_text(
            findings,
            product,
            "wasm-no-public-archive-env-runtime",
            source_path,
            [
                "OLIPHAUNT_WASM_RUNTIME_ARCHIVE",
                "OLIPHAUNT_WASM_AOT_ARCHIVE",
                "OLIPHAUNT_WASM_AOT_DIR",
            ],
            "WASIX runtime artifact selection must use generated package manifests instead of public archive environment variables.",
        )


def check_liboliphaunt_wasix(findings: list[Finding]) -> None:
    product = "liboliphaunt-wasix"
    version = read_text("src/runtimes/liboliphaunt/wasix/VERSION").strip()
    require(
        findings,
        product,
        "wasix-runtime-version",
        version == read_current_version(product),
        "WASIX runtime VERSION must be the release metadata product version.",
        f"src/runtimes/liboliphaunt/wasix/VERSION={version!r}",
        severity="P0",
    )
    asset_manifest = read_toml("src/runtimes/liboliphaunt/wasix/crates/assets/Cargo.toml")
    asset_package = asset_manifest.get("package", {})
    tools_manifest = read_toml("src/runtimes/liboliphaunt/wasix/crates/tools/Cargo.toml")
    tools_package = tools_manifest.get("package", {})
    wasix_artifact_manifest_paths = [
        "src/runtimes/liboliphaunt/wasix/crates/assets/Cargo.toml",
        "src/runtimes/liboliphaunt/wasix/crates/tools/Cargo.toml",
        *[
            relative(path)
            for path in sorted(
                (ROOT / "src/runtimes/liboliphaunt/wasix/crates/aot").glob("*/Cargo.toml")
            )
        ],
        *[
            relative(path)
            for path in sorted(
                (ROOT / "src/runtimes/liboliphaunt/wasix/crates/tools-aot").glob("*/Cargo.toml")
            )
        ],
    ]
    wasix_artifact_descriptions = [
        str(read_toml(path).get("package", {}).get("description", ""))
        for path in wasix_artifact_manifest_paths
    ]
    assets_build_source = read_text("src/runtimes/liboliphaunt/wasix/crates/assets/build.rs")
    release_workspace_source = read_text("tools/xtask/src/release_workspace.rs")
    tools_build_source = read_text("src/runtimes/liboliphaunt/wasix/crates/tools/build.rs")
    require(
        findings,
        product,
        "wasix-assets-crate",
        asset_package.get("name") == "liboliphaunt-wasix-portable"
        and asset_package.get("version") == read_current_version(product),
        "WASIX runtime asset crate must publish under the runtime product version.",
        f"src/runtimes/liboliphaunt/wasix/crates/assets/Cargo.toml package={asset_package!r}",
        severity="P0",
    )
    require(
        findings,
        product,
        "wasix-tools-crate",
        tools_package.get("name") == "oliphaunt-wasix-tools"
        and tools_package.get("version") == read_current_version(product),
        "WASIX tools asset crate must publish under the runtime product version.",
        f"src/runtimes/liboliphaunt/wasix/crates/tools/Cargo.toml package={tools_package!r}",
        severity="P0",
    )
    require(
        findings,
        product,
        "wasix-public-artifact-descriptions",
        all(description and "Internal" not in description for description in wasix_artifact_descriptions),
        "WASIX runtime, tools, root AOT, and tools-AOT artifact crate templates must describe the public registry artifact packages instead of calling them internal.",
        wasix_artifact_manifest_paths,
        severity="P0",
    )
    require(
        findings,
        product,
        "wasix-root-tools-split",
        'object.remove("pg-dump");' in assets_build_source
        and 'object.remove("psql");' in assets_build_source
        and 'object.remove("pg-dump");' in release_workspace_source
        and 'object.remove("psql");' in release_workspace_source
        and '"pg-dump":null' not in assets_build_source
        and '"psql":null' not in assets_build_source
        and "remove_split_wasix_tool_payload" in release_workspace_source
        and "retain_split_tools" in release_workspace_source
        and "SPLIT_WASIX_TOOL_AOT_ARTIFACTS" in release_workspace_source
        and '"bin/initdb.wasix.wasm"' in assets_build_source
        and '"bin/pg_dump.wasix.wasm"' not in assets_build_source
        and '"bin/psql.wasix.wasm"' not in assets_build_source,
        "WASIX root runtime asset crate must keep postgres/initdb assets only and omit split tool manifest entries.",
        [
            "src/runtimes/liboliphaunt/wasix/crates/assets/build.rs",
            "tools/xtask/src/release_workspace.rs",
        ],
        severity="P0",
    )
    require(
        findings,
        product,
        "wasix-tools-payload",
        '"bin/pg_dump.wasix.wasm"' in tools_build_source
        and '"bin/psql.wasix.wasm"' in tools_build_source
        and "pg_ctl" not in tools_build_source,
        "WASIX tools asset crate must package pg_dump and psql only; pg_ctl is intentionally absent on WASIX.",
        "src/runtimes/liboliphaunt/wasix/crates/tools/build.rs",
        severity="P0",
    )
    require(
        findings,
        product,
        "wasix-publish-targets",
        product_publish_targets(product) == ["github-release-assets", "crates-io"],
        "WASIX runtime must publish GitHub release assets and Cargo artifact crates.",
        "src/runtimes/liboliphaunt/wasix/release.toml",
        severity="P0",
    )
    registry_packages = set(product_registry_packages(product))
    expected_registry_packages = {
        f"crates:{name}"
        for name in wasix_public_cargo_package_names()
    }
    require(
        findings,
        product,
        "wasix-registry-packages",
        registry_packages == expected_registry_packages,
        "WASIX runtime release metadata must expose the public portable runtime, tools, target-specific root/tools AOT, and ICU data artifact crates.",
        f"src/runtimes/liboliphaunt/wasix/release.toml registry_packages={sorted(registry_packages)!r}",
        severity="P0",
    )
    release_source = read_text("tools/release/release.py")
    wasix_packager_source = read_text("tools/release/package_liboliphaunt_wasix_cargo_artifacts.mjs")
    wasix_dependency_invariant_source = read_text("tools/policy/check-wasix-release-dependency-invariants.mjs")
    workflow_source = read_text(".github/workflows/release.yml")
    require(
        findings,
        product,
        "wasix-cargo-artifact-release-flow",
        "package_liboliphaunt_wasix_cargo_artifacts.mjs" in release_source
        and "liboliphaunt_wasix_cargo_artifact_crates" in release_source
        and "--product liboliphaunt-wasix --step crates-io" in workflow_source,
        "Release flow must generate and publish WASIX Cargo artifact crates from staged WASIX release assets.",
        ["tools/release/release.py", ".github/workflows/release.yml"],
        severity="P0",
    )
    require(
        findings,
        product,
        "wasix-portable-runtime-tool-contract",
        wasix_core_runtime_archive_files()
        == ("oliphaunt/bin/initdb", "oliphaunt/bin/postgres")
        and wasix_tools_payload_files()
        == ("bin/pg_dump.wasix.wasm", "bin/psql.wasix.wasm")
        and wasix_forbidden_runtime_archive_tool_files()
        == ("oliphaunt/bin/pg_ctl", "oliphaunt/bin/pg_dump", "oliphaunt/bin/psql")
        and wasix_tools_aot_artifacts()
        == {"tool:pg_dump", "tool:psql"}
        and '"oliphaunt/bin/initdb", "oliphaunt/bin/postgres"' in release_source
        and '"oliphaunt/bin/pg_ctl", "oliphaunt/bin/pg_dump", "oliphaunt/bin/psql"' in release_source
        and "CORE_RUNTIME_ARCHIVE_FILES" in wasix_packager_source
        and "TOOLS_PAYLOAD_FILES" in wasix_packager_source
        and "TOOLS_AOT_ARTIFACTS" in wasix_packager_source
        and "FORBIDDEN_RUNTIME_ARCHIVE_TOOL_FILES" in wasix_packager_source
        and ("import " + "product_metadata") not in wasix_packager_source
        and "product_metadata." not in wasix_packager_source
        and 'from "./wasix-cargo-artifact-contract.mjs"' in wasix_packager_source
        and "wasixExtensionPackageName" in wasix_packager_source
        and "wasixExtensionAotPackageName" in wasix_packager_source
        and "currentProductVersionSync(PRODUCT" in wasix_packager_source,
        "Release validation must require postgres/initdb in the WASIX runtime archive, reject pg_ctl/pg_dump/psql there, and publish pg_dump/psql through WASIX tools payload/AOT crates.",
        [
            "tools/release/release.py",
            "tools/release/package_liboliphaunt_wasix_cargo_artifacts.mjs",
        ],
        severity="P0",
    )
    require(
        findings,
        product,
        "wasix-tools-dependency-invariant",
        "SOURCE_TEMPLATE_TOOLS_MANIFEST" in wasix_dependency_invariant_source
        and "SOURCE_TEMPLATE_TOOLS_AOT_MANIFESTS_DIR" in wasix_dependency_invariant_source
        and "oliphaunt-wasix-tools" in wasix_dependency_invariant_source
        and "oliphaunt-wasix-tools-aot-" in wasix_dependency_invariant_source,
        "WASIX release dependency invariants must cover the registry-installed tools and tools-AOT artifact crates, not only the root runtime/AOT crates.",
        "tools/policy/check-wasix-release-dependency-invariants.mjs",
        severity="P0",
    )
    local_registry_publisher = read_text("tools/release/local-registry-publish.mjs")
    require(
        findings,
        product,
        "wasix-local-registry-rejects-legacy-tools",
        "LEGACY_WASIX_ARTIFACT_CRATES" in local_registry_publisher
        and "ignored legacy WASIX artifact crate" in local_registry_publisher
        and "if (strict) {\n        fail(TOOL, message);" in local_registry_publisher,
        "Strict local Cargo publishing must reject stale unsplit WASIX artifact crates so examples resolve the current split runtime/tools surface.",
        "tools/release/local-registry-publish.mjs",
        severity="P0",
    )
    require(
        findings,
        product,
        "wasix-local-registry-requires-target-artifacts",
        "strict)" in local_registry_publisher
        and "is missing local registry inputs for host target artifact dependencies" in local_registry_publisher
        and "cargoDependencyNameMatchesHostTarget" in local_registry_publisher
        and "pruneMissingFeatureDependencies" in local_registry_publisher
        and 'value.startsWith("dep:")' in local_registry_publisher,
        "Strict local Cargo publishing must fail when release-shaped host target runtime/tools-AOT artifact crates are missing; non-host local pruning must also remove stale feature dep entries.",
        "tools/release/local-registry-publish.mjs",
        severity="P0",
    )
    require(
        findings,
        product,
        "wasix-direct-cargo-artifact-packaging",
        "CRATES_IO_MAX_BYTES" in wasix_packager_source
        and "validateCrateSize" in wasix_packager_source
        and "DEFAULT_PART_COUNT" not in wasix_packager_source
        and "createDeterministicTar" in wasix_packager_source
        and "--sort=name" not in wasix_packager_source
        and "--numeric-owner" not in wasix_packager_source
        and "--use-compress-program" not in wasix_packager_source
        and "wasixExtensionAotPartPackageName" in wasix_packager_source
        and "EXTENSION_AOT_SPLIT_THRESHOLD_BYTES" in wasix_packager_source
        and 'role: "artifact"' in wasix_packager_source,
        "WASIX Cargo artifact packaging must publish direct public artifact crates, enforce the crates.io size limit, avoid GNU tar-only archive creation, and split only oversized internal extension AOT payloads.",
        "tools/release/package_liboliphaunt_wasix_cargo_artifacts.mjs",
        severity="P0",
    )
    version = read_current_version(product)
    expected_release_assets = set(expected_assets(product, version, surface="github-release"))
    require(
        findings,
        product,
        "wasix-release-assets",
        {
            f"liboliphaunt-wasix-{version}-runtime-portable.tar.zst",
            f"liboliphaunt-wasix-{version}-icu-data.tar.zst",
            f"liboliphaunt-wasix-{version}-runtime-aot-macos-arm64.tar.zst",
            f"liboliphaunt-wasix-{version}-runtime-aot-linux-x64-gnu.tar.zst",
            f"liboliphaunt-wasix-{version}-runtime-aot-linux-arm64-gnu.tar.zst",
            f"liboliphaunt-wasix-{version}-runtime-aot-windows-x64-msvc.tar.zst",
            f"liboliphaunt-wasix-{version}-release-assets.sha256",
        }.issubset(expected_release_assets),
        "WASIX runtime release metadata must expose portable, target AOT, and checksum GitHub release assets.",
        f"src/runtimes/liboliphaunt/wasix/moon.yml: {sorted(expected_release_assets)!r}",
        severity="P0",
    )


def check_exact_extension(findings: list[Finding], product: str) -> None:
    config = product_config(product)
    product_path = package_path(product)
    sql_name = config.get("extension_sql_name")
    expected_registry_packages = expected_extension_registry_packages(product)
    version_path = f"{product_path}/VERSION"
    version = read_text(version_path).strip()
    require(
        findings,
        product,
        "extension-version",
        version == read_current_version(product),
        "Exact-extension VERSION must be the release metadata product version.",
        f"{version_path}={version!r}",
        severity="P0",
    )
    require(
        findings,
        product,
        "extension-release-metadata",
        config.get("kind") == "exact-extension-artifact"
        and {"github-release-assets", "npm", "maven-central", "crates-io"}.issubset(set(product_publish_targets(product)))
        and set(product_registry_packages(product)) == expected_registry_packages
        and config.get("release_artifacts") == ["exact-extension-artifacts"]
        and isinstance(sql_name, str)
        and sql_name,
        "Exact-extension release metadata must publish exact GitHub artifacts plus explicit npm, Maven, and Cargo packages by SQL extension name.",
        f"{product_path}/release.toml registry_packages={sorted(product_registry_packages(product))!r}",
        severity="P0",
    )
    targets = extension_artifact_targets(product=product, published_only=True)
    native_targets = {target.target for target in targets if target.family == "native"}
    wasix_targets = {target.target for target in targets if target.family == "wasix"}
    require(
        findings,
        product,
        "extension-targets",
        {
            "android-arm64-v8a",
            "android-x86_64",
            "ios-xcframework",
            "linux-arm64-gnu",
            "linux-x64-gnu",
            "macos-arm64",
        }.issubset(native_targets)
        and wasix_targets == {"wasix-portable"},
        "Exact-extension artifact targets must cover mobile and non-Windows native artifact surfaces plus WASIX portable; default targets are derived from runtime metadata unless a product owns an override file.",
        f"{product_path}/release.toml: native={sorted(native_targets)!r} wasix={sorted(wasix_targets)!r}",
        severity="P0",
    )
    wasix_package = wasix_extension_package_name(product)
    wasix_aot_packages = {
        wasix_extension_aot_package_name(product, target)
        for target in wasix_expected_extension_aot_targets()
    }
    native_qualified_registry_packages = [
        package for package in product_registry_packages(product) if "-native-" in package
    ]
    require(
        findings,
        product,
        "extension-package-naming",
        "-native-" not in product
        and not product.endswith("-native")
        and not native_qualified_registry_packages
        and all(not target.startswith("native-") for target in native_targets)
        and all(target.startswith("wasix-") for target in wasix_targets)
        and wasix_package == f"{product}-wasix"
        and "-native-" not in wasix_package
        and wasix_aot_packages
        == {
            f"{product}-wasix-aot-{target}"
            for target in wasix_expected_extension_aot_targets()
        }
        and all("-native-" not in package for package in wasix_aot_packages),
        "Exact-extension registry/package names must keep native targets platform-suffixed without a native qualifier and reserve the wasix qualifier for WASIX Cargo packages.",
        f"{product_path}/release.toml registry={sorted(product_registry_packages(product))!r} wasix={wasix_package!r} wasix_aot={sorted(wasix_aot_packages)!r}",
        severity="P0",
    )
    require(
        findings,
        product,
        "extension-consumer-assets",
        all(target.kind == "native-static-registry" for target in targets if target.target.startswith("android-") or target.target == "ios-xcframework")
        and all(target.kind == "native-dynamic" for target in targets if target.target.startswith(("linux-", "macos-", "windows-")))
        and all(target.kind == "wasix-runtime" for target in targets if target.family == "wasix"),
        "Exact-extension target metadata must distinguish mobile static-registry artifacts, desktop dynamic artifacts, and WASIX runtime artifacts.",
        f"{product_path}/release.toml: {[f'{target.target}:{target.kind}' for target in targets]!r}",
        severity="P0",
    )


PRODUCT_CHECKS = {
    "liboliphaunt-native": check_liboliphaunt,
    "liboliphaunt-wasix": check_liboliphaunt_wasix,
    "oliphaunt-rust": check_rust,
    "oliphaunt-broker": check_broker,
    "oliphaunt-node-direct": check_node_direct,
    "oliphaunt-swift": check_swift,
    "oliphaunt-kotlin": check_kotlin,
    "oliphaunt-react-native": check_react_native,
    "oliphaunt-js": check_typescript,
    "oliphaunt-wasix-rust": check_wasm,
}


def exact_extension_products() -> set[str]:
    return set(extension_product_ids())


def known_consumer_products() -> set[str]:
    return set(PRODUCT_CHECKS) | exact_extension_products()


def collect_findings(selected_products: list[str], fixture_path: Path) -> list[Finding]:
    fixture = load_fixture(fixture_path)
    findings: list[Finding] = []
    validate_fixture_contract(findings, fixture, selected_products)
    for product in selected_products:
        check = PRODUCT_CHECKS.get(product)
        if check is not None:
            check(findings)
            continue
        if product in exact_extension_products():
            check_exact_extension(findings, product)
            continue
        else:
            add(
                findings,
                product,
                "missing-product-check",
                "Product has no consumer-shape metadata checker.",
                "tools/release/check_consumer_shape.py",
                severity="P0",
            )
    return sorted(findings, key=lambda finding: (SEVERITY_ORDER[finding.severity], finding.product, finding.check))


def apply_filters(findings: list[Finding], severities: list[str], ids: list[str]) -> list[Finding]:
    severity_set = set(severities)
    id_set = set(ids)
    if severity_set:
        findings = [finding for finding in findings if finding.severity in severity_set]
    if id_set:
        findings = [finding for finding in findings if finding.id in id_set]
    return findings


def payload(selected_products: list[str], findings: list[Finding]) -> dict:
    counts: dict[str, int] = {}
    for finding in findings:
        counts[finding.severity] = counts.get(finding.severity, 0) + 1
    return {
        "schema": SCHEMA,
        "products": selected_products,
        "ready": len(findings) == 0,
        "findingCount": len(findings),
        "countsBySeverity": counts,
        "findings": [
            {
                "id": finding.id,
                "severity": finding.severity,
                "product": finding.product,
                "check": finding.check,
                "message": finding.message,
                "evidence": list(finding.evidence),
            }
            for finding in findings
        ],
    }


def print_text(report: dict) -> None:
    if report["ready"]:
        print("consumer shape checks passed")
        return
    print(f"consumer shape gaps found: {report['findingCount']}")
    for finding in report["findings"]:
        print(f"- [{finding['severity']}] {finding['id']}: {finding['message']}")
        for evidence in finding["evidence"]:
            print(f"  evidence: {evidence}")


def print_markdown(report: dict) -> None:
    print("# Consumer Shape Readiness\n")
    if report["ready"]:
        print("No consumer-shape gaps were found.")
        return
    print("| Severity | Finding | Message | Evidence |")
    print("| --- | --- | --- | --- |")
    for finding in report["findings"]:
        evidence = "<br>".join(str(item).replace("|", "\\|") for item in finding["evidence"])
        print(
            f"| {finding['severity']} | `{finding['id']}` | "
            f"{finding['message'].replace('|', '\\|')} | {evidence} |"
        )


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--fixture", default=str(DEFAULT_FIXTURE))
    parser.add_argument("--products-json")
    parser.add_argument("--product", action="append", default=[])
    parser.add_argument("--severity", action="append", choices=sorted(SEVERITY_ORDER))
    parser.add_argument("--id", action="append", default=[])
    parser.add_argument("--format", choices=["text", "json", "markdown"], default="text")
    parser.add_argument("--require-ready", action="store_true")
    args = parser.parse_args(argv)

    selected = args.product or parse_products_json(args.products_json) or sorted(known_consumer_products())
    unknown = sorted(set(selected) - known_consumer_products())
    if unknown:
        fail(f"unknown consumer-shape products: {', '.join(unknown)}")

    findings = collect_findings(selected, Path(args.fixture))
    findings = apply_filters(findings, args.severity or [], args.id)
    report = payload(selected, findings)

    if args.format == "json":
        print(json.dumps(report, indent=2, sort_keys=True))
    elif args.format == "markdown":
        print_markdown(report)
    else:
        print_text(report)

    if args.require_ready and findings:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
