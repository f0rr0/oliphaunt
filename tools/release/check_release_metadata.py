#!/usr/bin/env python3
"""Validate release-owned version metadata and derived registry manifests."""

from __future__ import annotations

import json
import re
import subprocess
import sys
import tempfile
import tomllib
from functools import lru_cache
from pathlib import Path
from types import SimpleNamespace
from typing import Any, NoReturn


ROOT = Path(__file__).resolve().parents[2]
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


def fail(message: str) -> NoReturn:
    print(f"check_release_metadata.py: {message}", file=sys.stderr)
    raise SystemExit(1)


def read_text(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def release_graph_json(command: str, args: tuple[str, ...] = ()) -> Any:
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
    try:
        return json.loads(output)
    except json.JSONDecodeError as error:
        fail(f"release graph {command} query did not return valid JSON: {error}")


def local_registry_metadata_json(command: str, args: tuple[str, ...] = ()) -> Any:
    try:
        output = subprocess.check_output(
            ["tools/dev/bun.sh", "tools/release/local_registry_metadata.mjs", command, *args],
            cwd=ROOT,
            text=True,
            stderr=subprocess.PIPE,
        )
    except subprocess.CalledProcessError as error:
        detail = (error.stderr or "").strip()
        if detail:
            fail(f"local registry metadata {command} query failed: {detail}")
        fail(f"local registry metadata {command} query failed with exit code {error.returncode}")
    try:
        return json.loads(output)
    except json.JSONDecodeError as error:
        fail(f"local registry metadata {command} query did not return valid JSON: {error}")


@lru_cache(maxsize=None)
def release_graph_rows(command: str, args: tuple[str, ...] = ()) -> tuple[dict[str, Any], ...]:
    rows = release_graph_json(command, args)
    if not isinstance(rows, list) or not all(isinstance(row, dict) for row in rows):
        fail(f"release graph {command} query must return a JSON object list")
    return tuple(rows)


def string_list(config: dict[str, Any], key: str, product: str) -> list[str]:
    value = config.get(key, [])
    if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
        fail(f"{product}.{key} must be a string list")
    return value


@lru_cache(maxsize=1)
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


def product_config(product: str) -> dict[str, Any]:
    matches = [row for row in product_config_rows() if row.get("product") == product]
    if len(matches) != 1:
        fail(f"release graph product-configs query returned {len(matches)} rows for {product}")
    config = dict(matches[0])
    config.pop("product", None)
    return config


def graph_products() -> dict[str, dict[str, Any]]:
    return {
        str(row["product"]): product_config(str(row["product"]))
        for row in product_config_rows()
    }


def product_ids() -> list[str]:
    return [str(row["product"]) for row in product_config_rows()]


def version_files(product: str) -> list[str]:
    files = string_list(product_config(product), "version_files", product)
    for path in files:
        if not (ROOT / path).is_file():
            fail(f"{product} version file does not exist: {path}")
    return files


def derived_version_files(product: str) -> list[str]:
    return string_list(product_config(product), "derived_version_files", product)


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
) -> tuple[SimpleNamespace, ...]:
    optional_defaults = {
        "triple": None,
        "runner": None,
        "library_relative_path": None,
        "executable_relative_path": None,
        "npm_package": None,
        "npm_os": None,
        "npm_cpu": None,
        "npm_libc": None,
        "llvm_url": None,
        "extension_artifacts": True,
    }
    return tuple(
        SimpleNamespace(**{**optional_defaults, **row})
        for row in release_graph_rows(
            "artifact-targets",
            artifact_target_args(
                product=product,
                kind=kind,
                surface=surface,
                published_only=published_only,
            ),
        )
    )


def publish_step_target_coverage(product: str) -> dict[str, set[str]]:
    coverage: dict[str, set[str]] = {}
    for row in release_graph_rows("publish-step-target-coverage", ("--product", product)):
        product_id = row.get("product")
        step = row.get("step")
        publish_targets = row.get("publishTargets")
        if product_id != product:
            fail(f"release graph publish-step-target-coverage returned row for {product_id!r}, expected {product!r}")
        if not isinstance(step, str) or not step:
            fail(f"release graph publish-step-target-coverage {product}.step must be a non-empty string")
        if not isinstance(publish_targets, list) or not publish_targets or not all(
            isinstance(item, str) and item for item in publish_targets
        ):
            fail(f"release graph publish-step-target-coverage {product}.{step}.publishTargets must be a non-empty string list")
        coverage[step] = set(publish_targets)
    return coverage


def supported_publish_targets(product: str) -> set[str]:
    covered: set[str] = set()
    for targets in publish_step_target_coverage(product).values():
        covered.update(targets)
    return covered


def is_extension_product(product: str) -> bool:
    rows = release_graph_rows("publish-step-target-coverage", ("--product", product))
    if not rows:
        return product.startswith("oliphaunt-extension-")
    return bool(rows[0].get("extension"))


@lru_cache(maxsize=1)
def extension_metadata_rows() -> tuple[dict[str, Any], ...]:
    rows = release_graph_rows("extension-metadata")
    seen: set[str] = set()
    for row in rows:
        product = row.get("product")
        if not isinstance(product, str) or not product:
            fail("release graph extension-metadata rows must declare a non-empty product")
        if product in seen:
            fail(f"release graph extension-metadata query returned duplicate product {product}")
        seen.add(product)
    if not rows:
        fail("release graph extension-metadata query returned no products")
    return rows


def extension_product_ids() -> list[str]:
    return sorted(str(row["product"]) for row in extension_metadata_rows())


def validate_all_extension_metadata() -> None:
    for row in extension_metadata_rows():
        product = str(row["product"])
        for key in ["sqlName", "class", "versioning", "sourcePath"]:
            value = row.get(key)
            if not isinstance(value, str) or not value:
                fail(f"release graph extension-metadata {product}.{key} must be a non-empty string")
        compatibility = row.get("compatibility")
        if not isinstance(compatibility, dict):
            fail(f"release graph extension-metadata {product}.compatibility must be an object")
        source_identity = row.get("sourceIdentity")
        if not isinstance(source_identity, dict):
            fail(f"release graph extension-metadata {product}.sourceIdentity must be an object")


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
    return tuple(SimpleNamespace(**row) for row in release_graph_rows("extension-targets", tuple(args)))


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
    contract = release_graph_json("wasix-cargo-artifact-contract")
    if not isinstance(contract, dict):
        fail("release graph wasix-cargo-artifact-contract query must return a JSON object")
    return contract


def wasix_contract_string_list(key: str) -> tuple[str, ...]:
    return tuple(string_list(wasix_cargo_artifact_contract(), key, f"WASIX Cargo artifact contract {key}"))


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
    package_name = wasix_extension_package_contract(product).get("packageName")
    if not isinstance(package_name, str) or not package_name:
        fail(f"release graph wasix-extension-package-names {product}.packageName must be non-empty")
    return package_name


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


def require_text(path: str, needle: str, message: str) -> None:
    if needle not in read_text(path):
        fail(message)


def reject_text(path: str, needle: str, message: str) -> None:
    if needle in read_text(path):
        fail(message)


def validate_no_consumer_install_scripts(package: dict, label: str) -> None:
    scripts = package.get("scripts", {})
    if not isinstance(scripts, dict):
        return
    for script_name in ["preinstall", "install", "postinstall", "prepare"]:
        if script_name in scripts:
            fail(f"{label} package must not run {script_name} during consumer installs")
    for script_name, command in scripts.items():
        if not isinstance(command, str):
            continue
        if re.search(r"\b(cargo|rustup)\b", command):
            fail(f"{label} package script {script_name!r} must not require Rust tooling")


def validate_publish_executable_files(package: dict, expected: list[str], label: str) -> None:
    publish_config = package.get("publishConfig")
    if not isinstance(publish_config, dict):
        fail(f"{label} package must declare publishConfig")
    if publish_config.get("access") != "public":
        fail(f"{label} package publishConfig.access must be public")
    if publish_config.get("provenance") is not True:
        fail(f"{label} package publishConfig.provenance must be true")
    executable_files = publish_config.get("executableFiles")
    if executable_files != expected:
        fail(f"{label} package publishConfig.executableFiles must be exactly {expected!r}")


def npm_package_dirs_under(package_root: str) -> dict[str, str]:
    root = ROOT / package_root
    packages: dict[str, str] = {}
    for package_json_path in sorted(root.glob("*/package.json")):
        package_dir = package_json_path.parent
        package = json.loads(package_json_path.read_text(encoding="utf-8"))
        package_name = package.get("name")
        if not isinstance(package_name, str) or not package_name:
            fail(f"{package_json_path.relative_to(ROOT)} must declare name")
        if package_name in packages:
            fail(
                f"duplicate npm package name {package_name} in "
                f"{packages[package_name]} and {package_dir.relative_to(ROOT).as_posix()}"
            )
        packages[package_name] = package_dir.relative_to(ROOT).as_posix()
    if not packages:
        fail(f"{package_root} must contain platform package descriptors")
    return packages


def validate_platform_npm_packages(
    product: str,
    kind: str,
    surface: str,
    package_root: str,
    version: str,
) -> None:
    package_dirs = npm_package_dirs_under(package_root)
    targets = [
        target
        for target in artifact_targets(product=product, kind=kind, surface=surface, published_only=True)
        if target.npm_package is not None
    ]
    expected_packages = sorted(target.npm_package for target in targets if target.npm_package is not None)
    actual_packages = sorted(package_dirs)
    if actual_packages != expected_packages:
        fail(f"{package_root} packages must match {product} npm artifact targets for {surface}: expected {expected_packages}, got {actual_packages}")

    for target in targets:
        assert target.npm_package is not None
        package_path = package_dirs[target.npm_package]
        package = json.loads(read_text(f"{package_path}/package.json"))
        validate_no_consumer_install_scripts(package, target.npm_package)
        if package.get("name") != target.npm_package:
            fail(f"{package_path}/package.json name must be {target.npm_package}")
        if package.get("version") != version:
            fail(f"{target.npm_package} version must be {version}")
        if package.get("type") != "module":
            fail(f"{target.npm_package} package type must be module")
        repository = package.get("repository")
        if not isinstance(repository, dict):
            fail(f"{target.npm_package} package must declare repository metadata")
        if repository.get("url") != "git+https://github.com/f0rr0/oliphaunt.git":
            fail(f"{target.npm_package} repository URL must match canonical release repository")
        if repository.get("directory") != package_path:
            fail(f"{target.npm_package} repository.directory must be {package_path}")
        if target.npm_os is None or package.get("os") != [target.npm_os]:
            fail(f"{target.npm_package} os selector must be {[target.npm_os]!r}")
        if target.npm_cpu is None or package.get("cpu") != [target.npm_cpu]:
            fail(f"{target.npm_package} cpu selector must be {[target.npm_cpu]!r}")
        if target.npm_libc is None:
            if "libc" in package:
                fail(f"{target.npm_package} must not declare libc for non-Linux-glibc targets")
        elif package.get("libc") != [target.npm_libc]:
            fail(f"{target.npm_package} libc selector must be {[target.npm_libc]!r}")
        if package.get("optional") is not True:
            fail(f"{target.npm_package} package must be marked optional")
        if package.get("exports") != {"./package.json": "./package.json"}:
            fail(f"{target.npm_package} package must only export ./package.json")

        metadata = package.get("oliphaunt")
        if not isinstance(metadata, dict) or metadata.get("target") != target.target:
            fail(f"{target.npm_package} package oliphaunt.target must be {target.target}")
        if product == "liboliphaunt-native" and kind == "native-runtime":
            if target.library_relative_path is None:
                fail(f"{target.id} must declare library_relative_path")
            if metadata.get("libraryRelativePath") != target.library_relative_path:
                fail(f"{target.npm_package} libraryRelativePath must be {target.library_relative_path}")
            if metadata.get("runtimeRelativePath") != "runtime":
                fail(f"{target.npm_package} runtimeRelativePath must be runtime")
            files = ["bin", "runtime", "README.md"] if target.target == "windows-x64-msvc" else ["lib", "runtime", "README.md"]
            executable_files = [
                f"./runtime/bin/{tool}"
                for tool in sorted(required_native_runtime_tools(target.target))
            ]
        elif product == "liboliphaunt-native" and kind == "native-tools":
            if metadata.get("product") != "oliphaunt-tools":
                fail(f"{target.npm_package} product must be oliphaunt-tools")
            if metadata.get("kind") != "native-tools":
                fail(f"{target.npm_package} kind must be native-tools")
            if metadata.get("runtimeRelativePath") != "runtime":
                fail(f"{target.npm_package} runtimeRelativePath must be runtime")
            files = ["runtime", "README.md"]
            executable_files = [
                f"./runtime/bin/{tool}"
                for tool in sorted(required_native_tools_package_tools(target.target))
            ]
        elif product == "oliphaunt-broker":
            if target.executable_relative_path is None:
                fail(f"{target.id} must declare executable_relative_path")
            if metadata.get("brokerHelper") != "oliphaunt-broker":
                fail(f"{target.npm_package} brokerHelper must be oliphaunt-broker")
            if metadata.get("executableRelativePath") != target.executable_relative_path:
                fail(f"{target.npm_package} executableRelativePath must be {target.executable_relative_path}")
            files = ["bin", "README.md"]
            executable_files = [f"./{target.executable_relative_path}"]
        else:
            fail(f"unsupported platform package product {product}")
        if package.get("files") != files:
            fail(f"{target.npm_package} files must be {files!r}")
        validate_publish_executable_files(package, executable_files, target.npm_package)


def stable_version(version: str, product: str) -> None:
    if not re.fullmatch(r"[0-9]+[.][0-9]+[.][0-9]+", version):
        fail(f"{product} must use a stable x.y.z release version, got {version!r}")


def cargo_manifest_version(path: str) -> str:
    manifest = tomllib.loads(read_text(path))
    package = manifest.get("package")
    if not isinstance(package, dict) or not isinstance(package.get("version"), str):
        fail(f"{path} must declare [package].version")
    return package["version"]


def validate_graph_files() -> None:
    products = graph_products()
    for product in products:
        for path in [
            *version_files(product),
            *derived_version_files(product),
        ]:
            if not (ROOT / path).is_file():
                fail(f"{product} release metadata path does not exist: {path}")
    validate_all_extension_metadata()
    if (ROOT / "tools/release/product_metadata.py").exists():
        fail("tools/release/product_metadata.py must stay deleted; release metadata consumers should query Bun directly")
    release_graph_query = read_text("tools/release/release_graph_query.mjs")
    release_graph_source = read_text("tools/release/release-graph.mjs")
    release_artifact_targets = read_text("tools/release/release-artifact-targets.mjs")
    sync_release_pr = read_text("tools/release/sync-release-pr.mjs")
    release_check = read_text("tools/release/release-check.mjs")
    release_check_registries = read_text("tools/release/release-check-registries.mjs")
    release_consumer_shape = read_text("tools/release/release-consumer-shape.mjs")
    release_verify = read_text("tools/release/release-verify.mjs")
    release_metadata_entrypoint = read_text("tools/release/check-release-metadata.mjs")
    consumer_shape_entrypoint = read_text("tools/release/check-consumer-shape.mjs")
    prepare_rust_release_source = read_text("tools/release/prepare-rust-release-source.mjs")
    local_registry_publish = read_text("tools/release/local-registry-publish.mjs")
    cargo_source_package = read_text("tools/release/cargo-source-package.mjs")
    wasix_sdk_packager = read_text("tools/release/package_oliphaunt_wasix_sdk_crate.mjs")
    release_pr_coverage = read_text("tools/release/check_release_pr_coverage.mjs")
    build_extension_ci_artifacts = read_text("tools/release/build-extension-ci-artifacts.mjs")
    check_staged_artifacts = read_text("tools/release/check-staged-artifacts.mjs")
    check_artifact_targets = read_text("tools/release/check_artifact_targets.mjs")
    check_consumer_shape = read_text("tools/release/check_consumer_shape.py")
    extension_model = read_text("src/extensions/tools/check-extension-model.py")
    extension_model_entrypoint = read_text("src/extensions/tools/check-extension-model.mjs")
    extension_model_moon = read_text("src/extensions/model/moon.yml")
    extension_artifacts_native_moon = read_text("src/extensions/artifacts/native/moon.yml")
    extension_artifacts_wasix_moon = read_text("src/extensions/artifacts/wasix/moon.yml")
    source_inputs_assertion = read_text("tools/policy/assertions/assert-source-inputs.mjs")
    release_policy = read_text("tools/policy/check-release-policy.mjs")
    check_release_metadata_source = read_text("tools/release/check_release_metadata.py")
    if re.search(r"(?m)^import product_metadata$", check_release_metadata_source):
        fail("check_release_metadata.py must consume Bun release graph rows instead of importing product_metadata.py")
    if re.search(r"(?m)^import local_registry_publish$", check_release_metadata_source) or "local_registry_metadata.mjs" not in check_release_metadata_source:
        fail("check_release_metadata.py must consume local registry metadata through the Bun helper instead of importing local_registry_publish.py")
    if (
        "compatibility-version-entries [--require-source-product]" not in release_graph_query
        or "compatibilityVersionEntries(graphProducts()" not in sync_release_pr
    ):
        fail("compatibility version metadata must be collected through the canonical Bun release graph query")
    if (
        "extension-metadata [--product PRODUCT]" not in release_graph_query
        or "export function extensionMetadata(" not in release_artifact_targets
        or "export function extensionSourceIdentity(" not in release_artifact_targets
        or "exactExtensionProducts(TOOL)" not in release_graph_query
        or "const extensionProducts = extensionProductIds();" not in check_artifact_targets
        or "return set(extension_product_ids())" not in check_consumer_shape
        or "const modeledExtensionProducts = new Set(extensionProductIds());" not in release_policy
        or "import product_metadata" in release_policy
        or "import product_metadata" in check_artifact_targets
        or "import product_metadata" in check_consumer_shape
        or "import product_metadata" in extension_model
        or 'release_graph_rows("extension-metadata")' not in extension_model
        or 'src/extensions/tools/check-extension-model.py' not in extension_model_entrypoint
        or 'tools/dev/bun.sh", "src/extensions/tools/check-extension-model.mjs"' not in sync_release_pr
        or "tools/dev/bun.sh', ['src/extensions/tools/check-extension-model.mjs', '--check']" not in source_inputs_assertion
        or "python3 src/extensions/tools/check-extension-model.py --check" in extension_model_moon
        or "python3 src/extensions/tools/check-extension-model.py --check" in extension_artifacts_native_moon
        or "python3 src/extensions/tools/check-extension-model.py --check" in extension_artifacts_wasix_moon
        or any(
            required not in moon_source
            for moon_source in [
                extension_model_moon,
                extension_artifacts_native_moon,
                extension_artifacts_wasix_moon,
            ]
            for required in [
                "/tools/release/release_graph_query.mjs",
                "/tools/release/release-artifact-targets.mjs",
                "/tools/release/release-graph.mjs",
            ]
        )
        or "function extensionMetadata(" in build_extension_ci_artifacts
        or "function extensionSourceIdentity(" in build_extension_ci_artifacts
        or "function extensionMetadata(" in check_staged_artifacts
        or "function extensionSourceIdentity(" in check_staged_artifacts
    ):
        fail("extension metadata and source identity must be shared through release-artifact-targets and the Bun release graph query")
    if (
        "product-versions [--product PRODUCT]" not in release_graph_query
        or "currentProductVersionSync(" not in release_graph_query
        or 'property.trim() === "VERSION_NAME"' not in release_artifact_targets
    ):
        fail("current product version values must be read through the Bun release graph product-versions query")
    if (
        "product-configs [--product PRODUCT]" not in release_graph_query
        or "productConfigRows({ product }, TOOL)" not in release_graph_query
        or "export function productConfigRows(" not in release_graph_source
    ):
        fail("product config metadata must be adapted through the Bun release graph product-configs query")
    release_source = read_text("tools/release/release.py")
    release_workflow = read_text(".github/workflows/release.yml")
    release_moon = read_text("tools/release/moon.yml")
    root_moon = read_text("moon.yml")
    rust_sdk_check = read_text("src/sdks/rust/tools/check-sdk.sh")
    examples_readme = read_text("examples/README.md")
    examples_local_registries = read_text("examples/tools/with-local-registries.sh")
    if (
        '"tools/release/release-check.mjs"' not in release_source
        or '"tools/release/release-check-registries.mjs", *passthrough' not in release_source
        or "def command_check(" in release_source
        or "def command_check_registries(" in release_source
        or "def command_consumer_shape(" in release_source
        or "def command_verify_release(" in release_source
        or '"check-registries",' in release_source
        or '"consumer-shape",' in release_source
        or '"verify-release",' in release_source
        or 'command == "check"' in release_source
        or 'command == "check-registries"' in release_source
        or 'command == "consumer-shape"' in release_source
        or 'command == "verify-release"' in release_source
        or "tools/release/check_release_pr_coverage.mjs" not in release_check
        or "tools/release/check-release-metadata.mjs" not in release_check
        or '["python3", "tools/release/check_release_metadata.py"]' in release_check
        or "tools/release/check_release_metadata.py" not in release_metadata_entrypoint
        or "tools/release/release-consumer-shape.mjs" not in release_check
        or "tools/release/check_release_versions.mjs" not in release_check_registries
        or "tools/release/check_registry_publication.mjs" not in release_check_registries
        or "tools/release/check-consumer-shape.mjs" not in release_consumer_shape
        or '["tools/release/check_consumer_shape.py"' in release_consumer_shape
        or "tools/release/check_consumer_shape.py" not in consumer_shape_entrypoint
        or "tools/release/check_release_versions.mjs" not in release_verify
        or "tools/release/release-consumer-shape.mjs" not in release_verify
        or "tools/release/verify_github_release_attestations.mjs" not in release_verify
        or "tools/dev/bun.sh tools/release/release-check.mjs" not in release_workflow
        or "tools/dev/bun.sh tools/release/release-check-registries.mjs" not in release_workflow
        or "tools/dev/bun.sh tools/release/release-consumer-shape.mjs" not in release_workflow
        or "tools/dev/bun.sh tools/release/release-verify.mjs" not in release_workflow
        or "tools/dev/bun.sh tools/release/release-check.mjs" not in release_moon
        or "tools/dev/bun.sh tools/release/release-consumer-shape.mjs" not in release_moon
        or 'command: "tools/dev/bun.sh tools/release/release-check.mjs"' not in root_moon
        or 'command: "tools/dev/bun.sh tools/release/check-release-metadata.mjs"' not in root_moon
        or 'command: "tools/release/release.py check"' in root_moon
        or 'command: "tools/release/check_release_metadata.py"' in root_moon
    ):
        fail("active release check, registry-check, verify, and consumer-shape orchestration must live in Bun helpers; release.py must keep only the protected publish and publish-dry-run implementation")
    if (
        "tools/dev/bun.sh tools/release/prepare-rust-release-source.mjs" not in rust_sdk_check
        or '"prepare-rust-release-source"' in release_source
        or "renderReleaseCargoToml(" not in prepare_rust_release_source
        or "currentProductVersionSync(RUST_PRODUCT" not in prepare_rust_release_source
        or "allArtifactTargets({ product, kind, surface, publishedOnly: true }" not in prepare_rust_release_source
        or 'registryPackageRows({ product: LIBOLIPHAUNT_NATIVE_PRODUCT, packageKind: "crates" }' not in prepare_rust_release_source
        or "oliphaunt-tools, not target tools crates" not in prepare_rust_release_source
    ):
        fail("Rust SDK generated publish-source preparation must live in the Bun helper instead of the release.py command surface")
    if (
        'if (command === "status")' not in local_registry_publish
        or 'if (command === "download")' not in local_registry_publish
        or 'if (command === "publish")' not in local_registry_publish
        or 'command === "-h" || command === "--help"' not in local_registry_publish
        or "function mainHelp()" not in local_registry_publish
        or "function unsupportedCommand(" not in local_registry_publish
        or "function status(argv)" not in local_registry_publish
        or "function statusHelp()" not in local_registry_publish
        or "function downloadHelp()" not in local_registry_publish
        or "function publishHelp()" not in local_registry_publish
        or "function download(argv)" not in local_registry_publish
        or "function publishCargoDryRun(" not in local_registry_publish
        or "function publishCargoCrates(" not in local_registry_publish
        or "function stageReleaseAssetCargoPackages(" not in local_registry_publish
        or "function stageCargoSourceCrates(" not in local_registry_publish
        or "function packageNativeExtensionCargoCrates(" not in local_registry_publish
        or "function writeNativeExtensionCargoCrate(" not in local_registry_publish
        or "function buildNativeExtensionPartCrates(" not in local_registry_publish
        or "function writeNativeExtensionSplitAggregatorCrate(" not in local_registry_publish
        or "function pruneMissingLocalArtifactTargetDependencies(" not in local_registry_publish
        or "function nativeRuntimeArtifactManifests(" not in local_registry_publish
        or "nativeSplitReleaseAssetNames(" not in local_registry_publish
        or "nativeNpmReleaseAssetNames(" not in local_registry_publish
        or "function stageReleaseAssetNpmPackages(" not in local_registry_publish
        or "function stageExtensionNpmPackages(" not in local_registry_publish
        or "function stageExtensionPayloadGroups(" not in local_registry_publish
        or "function extensionNpmPayloadPackage(" not in local_registry_publish
        or "function liboliphauntNpmTarballs(" not in local_registry_publish
        or "function stageLiboliphauntToolsNpmPayloads(" not in local_registry_publish
        or "function stageLiboliphauntIcuNpmPayload(" not in local_registry_publish
        or "function brokerNpmTarballs(" not in local_registry_publish
        or 'from "./optimize_native_runtime_payload.mjs"' not in local_registry_publish
        or 'from "./cargo-source-package.mjs"' not in local_registry_publish
        or 'from "./package_oliphaunt_wasix_sdk_crate.mjs"' not in local_registry_publish
        or "export function manualCargoPackageSource(" not in cargo_source_package
        or "gzipSync(createTar(" not in cargo_source_package
        or "export async function prepareOliphauntWasixReleaseSource(" not in wasix_sdk_packager
        or "export async function currentOliphauntWasixSdkVersion(" not in wasix_sdk_packager
        or "if (import.meta.main)" not in wasix_sdk_packager
        or "function cargoCratesRequirePythonGeneration(" not in local_registry_publish
        or "function cargoMetadataForCrate(" not in local_registry_publish
        or "function cargoIndexEntry(" not in local_registry_publish
        or "function clearLocalCargoHomeCache(" not in local_registry_publish
        or "function publishNpmDryRun(" not in local_registry_publish
        or "async function publishNpmTarballs(" not in local_registry_publish
        or "async function ensureVerdaccio(" not in local_registry_publish
        or "function selectNpmTarballs(" not in local_registry_publish
        or "function discoverExtensionManifests(" not in local_registry_publish
        or "function publishMaven(" not in local_registry_publish
        or "function publishSwift(" not in local_registry_publish
        or "function canPublishInBun(" not in local_registry_publish
        or "function discoverRoots(" not in local_registry_publish
        or "tools/release/local_registry_metadata.mjs" not in local_registry_publish
        or "if (options.help)" not in local_registry_publish
        or '(surface === "cargo" && (options.dryRun || !cargoCratesRequirePythonGeneration(options, roots)))' not in local_registry_publish
        or "function cargoCratesRequirePythonGeneration(options, roots) {\n  return false;\n}" not in local_registry_publish
        or '(surface === "npm" && (options.dryRun || !npmTarballsRequirePythonGeneration(roots)))' not in local_registry_publish
        or "function npmTarballsRequirePythonGeneration(roots) {\n  return false;\n}" not in local_registry_publish
        or '["python3", "tools/release/local_registry_publish.py", "publish", ...argv]' in local_registry_publish
        or '["python3", "tools/release/local_registry_publish.py", "status"' in local_registry_publish
        or '["python3", "tools/release/local_registry_publish.py", ...Bun.argv.slice(2)]' in local_registry_publish
        or "tools/dev/bun.sh tools/release/local-registry-publish.mjs download" not in examples_readme
        or "tools/dev/bun.sh tools/release/local-registry-publish.mjs publish" not in examples_readme
        or "python3 tools/release/local_registry_publish.py" in examples_readme
        or "tools/dev/bun.sh tools/release/local-registry-publish.mjs" not in examples_local_registries
    ):
        fail("example local-registry setup must use the Bun local-registry command surface and stage Cargo plus npm release/source/extension packages without Python publish fallback")
    if (
        "publish-step-target-coverage [--product PRODUCT]" not in release_graph_query
        or "export function publishStepTargetCoverageRows(" not in release_graph_source
        or 'release_graph_rows("publish-step-target-coverage", args)' not in release_source
        or "def publish_step_target_coverage(product: str)" not in release_source
        or "import product_metadata" in release_source
        or '"liboliphaunt-native": {' in release_source
        or 'return {"github-release-assets": {"github-release-assets"}' in release_source
    ):
        fail("release.py publish target coverage must be adapted through the Bun release graph query")
    if (
        "moon-release-metadata [--product PRODUCT]" not in release_graph_query
        or "moonReleaseMetadataRows({ product }, TOOL)" not in release_graph_query
        or "export function moonReleaseMetadataRows(" not in release_graph_source
    ):
        fail("Moon release metadata must be adapted through the Bun release graph moon-release-metadata query")
    if (
        "moon-projects [--project PROJECT]" not in release_graph_query
        or "export function moonProjectRows(" not in release_graph_source
        or 'bunJson(["tools/release/release_graph_query.mjs", "moon-projects"])' not in release_policy
        or "def moon_projects(" in release_policy
        or "moon query projects" in release_policy
        or 'graph.get("products")' in release_policy
        or 'project.get("config")' in release_policy
    ):
        fail("release policy must consume normalized Bun Moon project rows and product-config metadata")
    if (
        "legacy-central-artifact-targets" not in release_graph_query
        or 'releaseGraphRows("legacy-central-artifact-targets")' not in check_artifact_targets
        or ("product_metadata." + "load_graph()") in check_artifact_targets
        or ("def " + "load_graph()") in check_release_metadata_source
        or ("product_metadata." + "load_graph()") in check_release_metadata_source
    ):
        fail("artifact target checks must use graph-query adapters instead of direct full graph calls")
    if (
        "tools/release/release_plan.mjs" not in release_pr_coverage
        or "tools/release/release.py', [\n    'plan'" in release_pr_coverage
        or 'tools/release/release.py", [\n    "plan"' in release_pr_coverage
        or "def command_plan(" in release_source
        or 'if command == "plan":' in release_source
        or 'for name in [\n        "plan",' in release_source
    ):
        fail("release planning must use the Bun release planner directly")
    if (
        "function typescriptOptionalRuntimePackageProducts(" in sync_release_pr
        or "export function typescriptOptionalRuntimePackageProducts(" not in release_artifact_targets
        or "typescriptOptionalRuntimePackageProducts(PREFIX)" not in sync_release_pr
        or "typescript-optional-runtime-package-versions" not in release_graph_query
        or "typescriptOptionalRuntimePackageProducts(TOOL)" not in release_graph_query
    ):
        fail("TypeScript optional runtime package selection must come from the shared Bun artifact target helper")
    if (
        "export function sdkPackageProducts(" not in release_artifact_targets
        or "sdk-package-products [--product PRODUCT]" not in release_graph_query
        or "ci-products --family sdk-package" not in release_graph_query
        or "sdkPackageProducts(TOOL)" not in release_graph_query
        or "def command_ci_products(" in release_source
        or '"ci-products"' in release_source
    ):
        fail("SDK package product and CI artifact-name selection must come from the shared Bun release graph query")
    if (
        "export function ciReleaseAssetArtifactRows(" not in release_artifact_targets
        or "export function ciNpmPackageArtifactRows(" not in release_artifact_targets
        or "ci-artifact-names --family release-assets|npm-package|sdk-package --product PRODUCT" not in release_graph_query
        or "ciReleaseAssetArtifactRows(product, kind, TOOL)" not in release_graph_query
        or "ciNpmPackageArtifactRows(product, kind, TOOL)" not in release_graph_query
        or "def command_ci_artifacts(" in release_source
        or '"ci-artifacts"' in release_source
    ):
        fail("CI release asset and npm package artifact names must come from the shared Bun artifact target helper")
    if (
        "export function expectedAssetRows(" not in release_artifact_targets
        or "expected-assets --product PRODUCT --version VERSION" not in release_graph_query
        or "expectedAssetRows({" not in release_graph_query
    ):
        fail("expected release asset names must come from the shared Bun release graph query")
    if (
        "export function registryPackageRows(" not in release_artifact_targets
        or "registry-packages --product PRODUCT [--kind KIND]" not in release_graph_query
        or "registryPackageRows({ product, packageKind }, TOOL)" not in release_graph_query
    ):
        fail("registry package name selection must come from the shared Bun release graph query")
    if (
        "wasix-extension-package-names [--product PRODUCT [--target TARGET...]]" not in release_graph_query
        or "exactExtensionProducts(TOOL).map" not in release_graph_query
        or 'release_graph_rows("wasix-extension-package-names")' not in check_consumer_shape
        or "wasixExtensionPackageName(product)" not in release_graph_query
        or "wasixExtensionAotPackageName(product, target)" not in release_graph_query
    ):
        fail("WASIX extension package names must come from the shared Bun WASIX Cargo artifact contract query")
    if (
        "export function localPublishArtifactRows(" not in release_artifact_targets
        or "local-publish-artifacts [--aggregate-only]" not in release_graph_query
        or "localPublishArtifactRows({ aggregateOnly }, TOOL)" not in release_graph_query
    ):
        fail("local-registry publish artifact preset must come from the shared Bun release graph query")


def validate_exact_extension_registry_shape() -> None:
    for product in extension_product_ids():
        config = product_config(product)
        if "-native-" in product or product.endswith("-native"):
            fail(f"{product} exact-extension product names must stay platform-neutral; special-case wasix packages only")
        publish_targets = set(string_list(config, "publish_targets", product))
        if not {"github-release-assets", "maven-central"}.issubset(publish_targets):
            fail(f"{product} must publish exact-extension GitHub assets and Android Maven artifacts")
        registry_packages = string_list(config, "registry_packages", product)
        native_named_packages = sorted(package for package in registry_packages if "-native-" in package)
        if native_named_packages:
            fail(
                f"{product} exact-extension registry package names must not include a native qualifier: "
                + ", ".join(native_named_packages)
            )
        expected_registry_packages = {
            f"maven:dev.oliphaunt.extensions:{product}-{target.target}"
            for target in published_android_maven_targets(product)
        }
        if set(registry_packages) != expected_registry_packages:
            fail(
                f"{product} registry_packages must explicitly match Android Maven artifact targets: "
                + ", ".join(sorted(registry_packages))
            )
        android_targets = {
            target.target
            for target in published_android_maven_targets(product)
        }
        if android_targets != {"android-arm64-v8a", "android-x86_64"}:
            fail(f"{product} derived Android Maven targets are wrong: {sorted(android_targets)}")
        for target in extension_artifact_targets(product=product, published_only=True):
            if target.family == "native" and target.target.startswith("native-"):
                fail(f"{product} native exact-extension target {target.target} must not repeat a native qualifier")
            if target.family == "wasix" and not target.target.startswith("wasix-"):
                fail(f"{product} WASIX exact-extension target {target.target} must carry the wasix qualifier")
        wasix_package = wasix_extension_package_name(product)
        if wasix_package != f"{product}-wasix" or "-native-" in wasix_package:
            fail(f"{product} WASIX extension Cargo package name must be {product}-wasix, got {wasix_package}")
        for target in wasix_expected_extension_aot_targets():
            package = wasix_extension_aot_package_name(product, target)
            if package != f"{product}-wasix-aot-{target}" or "-native-" in package:
                fail(f"{product} WASIX extension AOT Cargo package name is wrong: {package}")


def validate_publish_target_coverage() -> None:
    workflow = read_text(".github/workflows/release.yml")
    release_source = read_text("tools/release/release.py")
    release_publish = read_text("tools/release/release-publish.mjs")
    release_product_dry_run = read_text("tools/release/release-product-dry-run.mjs")
    release_sdk_product_dry_run = read_text("tools/release/release-sdk-product-dry-run.mjs")
    if "tools/release/check_publish_environment.mjs --products-json" not in workflow:
        fail("Release workflow must validate publish credentials through the Bun publish-environment helper")
    if "tools/release/check_publish_environment.py" in workflow:
        fail("Release workflow must not call the retired Python publish-environment helper")
    if (
        "tools/dev/bun.sh tools/release/release-publish.mjs publish-dry-run" not in workflow
        or "tools/dev/bun.sh tools/release/release-publish.mjs publish " not in workflow
        or "tools/release/release.py publish-dry-run" in workflow
        or "tools/release/release.py publish --" in workflow
        or 'const COMMANDS = new Set(["publish", "publish-dry-run"]);' not in release_publish
        or 'function isNoProductPublishDryRun(' not in release_publish
        or 'run(TOOL, ["tools/dev/bun.sh", "tools/release/release-check.mjs"]);' not in release_publish
        or 'run(TOOL, ["tools/dev/bun.sh", "tools/release/release-check-registries.mjs", ...passthrough]);' not in release_publish
        or "SUPPORTED_BUN_PRODUCT_DRY_RUNS" not in release_publish
        or 'await runBunProductDryRun(product, { allowDirty: productDryRunPlan.allowDirty });' not in release_publish
        or "function legacyWasmPublishDryRunPlan(" not in release_publish
        or 'LEGACY_WASM_DRY_RUN_PRODUCT = "oliphaunt-wasix-rust"' not in release_publish
        or 'await runBunProductDryRun(legacyWasmDryRunPlan.product, { allowDirty: legacyWasmDryRunPlan.allowDirty });' not in release_publish
        or "--wasm dry-runs, and protected publish dispatch still delegate to release.py" in release_publish
        or "SUPPORTED_SDK_PRODUCT_DRY_RUNS" not in release_product_dry_run
        or "LIBOLIPHAUNT_NATIVE_PRODUCT," not in release_product_dry_run
        or "ensureLiboliphauntReleaseAssets" not in release_product_dry_run
        or "tools/release/check-liboliphaunt-release-assets.mjs" not in release_product_dry_run
        or "tools/release/package-liboliphaunt-cargo-artifacts.mjs" not in release_product_dry_run
        or "validateNativeCargoArtifacts" not in release_product_dry_run
        or "liboliphauntNpmTarballs" not in release_product_dry_run
        or "liboliphaunt-native-maven-dry-run" not in release_product_dry_run
        or "BROKER_PRODUCT," not in release_product_dry_run
        or "ensureBrokerReleaseAssets" not in release_product_dry_run
        or "brokerNpmTarballs" not in release_product_dry_run
        or "tools/release/package_broker_cargo_artifacts.mjs" not in release_product_dry_run
        or "WASIX_PRODUCT," not in release_product_dry_run
        or "ensureWasixReleaseAssets" not in release_product_dry_run
        or "tools/release/check-liboliphaunt-wasix-release-assets.mjs" not in release_product_dry_run
        or "tools/release/package_liboliphaunt_wasix_cargo_artifacts.mjs" not in release_product_dry_run
        or "validateWasixCargoArtifacts" not in release_product_dry_run
        or "NODE_DIRECT_PRODUCT," not in release_product_dry_run
        or "ensureNodeDirectReleaseAssets" not in release_product_dry_run
        or "nodeDirectOptionalNpmTarballs" not in release_product_dry_run
        or '"oliphaunt-js",' not in release_sdk_product_dry_run
        or '"oliphaunt-kotlin",' not in release_sdk_product_dry_run
        or '"oliphaunt-react-native",' not in release_sdk_product_dry_run
        or '"oliphaunt-rust",' not in release_sdk_product_dry_run
        or '"oliphaunt-wasix-rust",' not in release_sdk_product_dry_run
        or '"oliphaunt-swift",' not in release_sdk_product_dry_run
        or 'tools/release/check-staged-artifacts.mjs", "--require-sdk-product", product' not in release_sdk_product_dry_run
        or "prepareStagedSwiftReleaseManifest" not in release_sdk_product_dry_run
        or "stagedKotlinMavenRepo" not in release_sdk_product_dry_run
        or 'verifyStagedCargoProductCrates("oliphaunt-rust")' not in release_sdk_product_dry_run
        or "tools/release/prepare-rust-release-source.mjs" not in release_sdk_product_dry_run
        or "prepareOliphauntWasixReleaseSource" not in release_sdk_product_dry_run
        or 'spawnSync("tools/release/release.py", argv' not in release_publish
    ):
        fail("Release workflow publish commands must use the Bun release-publish entrypoint, no-product and legacy --wasm publish dry-runs must run through Bun without launching release.py, and low-risk product dry-runs must stay in Bun")
    if 'run(["tools/release/check_publish_environment.mjs", *products_args])' not in release_source:
        fail("release.py publish dry-run must validate publish credentials through the Bun helper")
    saw_extension = False
    for product, config in graph_products().items():
        declared = set(string_list(config, "publish_targets", product))
        supported = supported_publish_targets(product)
        if declared != supported:
            fail(
                f"{product}.publish_targets must match release.py publish handler coverage: "
                f"declared={sorted(declared)}, supported={sorted(supported)}"
            )
        step_coverage = publish_step_target_coverage(product)
        if is_extension_product(product):
            saw_extension = True
            continue
        for step in step_coverage:
            if f'product == "{product}" and step == "{step}"' not in release_source:
                fail(f"release.py must dispatch publish step {product}:{step}")
            if f"--product {product} --step {step}" not in workflow:
                fail(f"Release workflow must invoke publish step {product}:{step}")
    if saw_extension:
        for step in ["github-release-assets", "maven-central"]:
            if f'is_extension_product(product) and step == "{step}"' not in release_source:
                fail(f"release.py must dispatch extension publish step {step}")
            if f"--step {step} --products-json" not in workflow:
                fail(f"Release workflow must invoke aggregate extension publish step {step}")


def validate_release_setup_docs() -> None:
    setup = read_text("docs/maintainers/release-setup.md")
    normalized_setup = re.sub(r"\s+", " ", setup)
    required_fragments = [
        "Rust/Tauri: `cargo add oliphaunt`",
        "iOS/macOS Swift: Xcode or SwiftPM",
        'Android/Kotlin: Maven Central plus `id("dev.oliphaunt.android")`',
        "React Native/Expo: `pnpm add @oliphaunt/react-native` plus the Expo config",
        "TypeScript/Node/Bun: `pnpm add @oliphaunt/ts`",
        "TypeScript/Deno: `deno add jsr:@oliphaunt/ts`",
        "Normal app consumers must not install Rust, run Cargo, build PostgreSQL",
        "Do not set up CocoaPods trunk credentials",
        "CocoaPods trunk is scheduled to become read-only on December 2, 2026",
        "JSR's GitHub Actions OIDC publishing path",
        "MAVEN_CENTRAL_USERNAME",
        "SwiftPM plus GitHub release assets",
        "oliphaunt-broker",
        "tools/dev/bun.sh tools/release/release-consumer-shape.mjs --require-ready --products-json '<released products>'",
        "tools/dev/bun.sh tools/release/release-check-registries.mjs --products-json '<released products>' --head-ref HEAD",
        "release_commit",
        "full 40-character SHA that should be published",
        "The workflow still runs the latest release scripts",
        "For the first public release, select every product",
        "manually bootstrap any first Cargo crates",
        "Manual registry bootstrap is a release-completion state",
        "create and push the matching product tag at the same release commit",
        "TypeScript broker mode needs the matching `oliphaunt-broker` runtime",
        "Consumers must not install `@oliphaunt/ts` with optional dependencies disabled",
    ]
    for fragment in required_fragments:
        normalized_fragment = re.sub(r"\s+", " ", fragment)
        if normalized_fragment not in normalized_setup:
            fail(f"release setup guide is missing {fragment!r}")

    before_publish_section = setup.split("Run these from GitHub Actions", 1)[0]
    normalized_before_publish_section = re.sub(r"\s+", " ", before_publish_section)
    if "Consumer shape is strict" not in normalized_before_publish_section:
        fail("release setup guide must explain that strict consumer shape is a tracked package-shape gate")
    if setup.count("Sonatype Central Portal token setup:") != 1:
        fail("release setup guide must contain exactly one Sonatype token setup reference")


def validate_local_registry_publisher() -> None:
    publisher = read_text("tools/release/local-registry-publish.mjs")
    if "const roots = artifactRoots.length > 0 ? artifactRoots : DEFAULT_ROOTS;" not in publisher:
        fail("local registry publisher must treat explicit --artifact-root values as the selected artifact set")
    if "roots.push(" in publisher or "roots.extend(extra_roots)" in publisher:
        fail("local registry publisher must not append explicit artifact roots to stale default build roots")
    if "stageLiboliphauntIcuNpmPayload" not in publisher or "include_icu=False" in publisher:
        fail("local registry npm publishing must include the declared @oliphaunt/icu sidecar package")
    if "oliphaunt-tools-${libVersion}-*" not in publisher:
        fail("local registry publisher must copy split oliphaunt-tools release assets when staging liboliphaunt native packages")
    if (
        "LEGACY_WASIX_ARTIFACT_CRATES" not in publisher
        or "ignored legacy WASIX artifact crate" not in publisher
        or "if (strict) {\n        fail(TOOL, message);" not in publisher
    ):
        fail("strict local Cargo publishing must reject legacy unsplit WASIX artifact crates")
    default_roots = publisher.split("const DEFAULT_ROOTS =", 1)[-1].split("];", 1)[0]
    if "target/oliphaunt-wasix" in default_roots:
        fail("local registry publisher defaults must not silently scan stale canonical WASIX build outputs")
    if "function clearLocalCargoHomeCache(" not in publisher or '"cache", "src", "index"' not in publisher:
        fail("local registry publisher must clear Cargo's local registry cache after same-version Cargo republishes")
    if (
        "function stageReleaseAssetCargoPackages(" not in publisher
        or "package-liboliphaunt-cargo-artifacts.mjs" not in publisher
        or "package_broker_cargo_artifacts.mjs" not in publisher
        or "package_liboliphaunt_wasix_cargo_artifacts.mjs" not in publisher
        or "hostCargoReleaseTarget()" not in publisher
        or "stageReleaseAssetCargoPackages(roots, registryRoot, result, strict)" not in publisher
        or "strict)" not in publisher
        or "pruneMissingFeatureDependencies" not in publisher
    ):
        fail("local registry Cargo publishing must generate runtime/tool artifact crates from staged release assets")
    artifacts = local_registry_metadata_json("local-publish-artifacts")
    if not isinstance(artifacts, list) or not all(isinstance(item, str) and item for item in artifacts):
        fail("Bun local registry metadata helper must return local-publish artifact names as a non-empty string list")
    duplicates = sorted({artifact for artifact in artifacts if artifacts.count(artifact) > 1})
    if duplicates:
        fail("local registry publish artifact preset must not contain duplicate names: " + ", ".join(duplicates))
    if "STATIC_LOCAL_PUBLISH_ARTIFACTS" in publisher:
        fail("local registry publish preset must derive aggregate artifact names instead of keeping a static list")
    if (
        "function localPublishArtifacts(" not in publisher
        or '"local-publish-artifacts"' not in publisher
        or '"discover-extension-manifests"' not in publisher
        or "def extension_manifest_identity" in publisher
        or "local_publish_artifact_names(aggregate_only=True)" in publisher
        or "local_publish_artifact_names()" in publisher
        or "release_graph_rows(" in publisher
        or "import product_metadata" in publisher
        or "ci_aggregate_release_asset_artifact_name(\"liboliphaunt-native\")" in publisher
        or "ci_wasix_runtime_artifact_names()" in publisher
        or "ci_wasix_aot_runtime_artifact_names()" in publisher
        or "ci_wasix_extension_artifact_names()" in publisher
        or "ci_extension_package_artifact_names()" in publisher
        or "ci_release_asset_artifact_names(\"liboliphaunt-native\", \"native-runtime\")" in publisher
    ):
        fail("local registry publish preset must come from the shared Bun local-publish-artifacts query")
    with tempfile.TemporaryDirectory(prefix="oliphaunt-extension-manifest-dedupe-") as tmp:
        root = Path(tmp)
        first = root / "first" / "oliphaunt-extension-demo"
        second = root / "second" / "oliphaunt-extension-demo"
        for directory in (first, second):
            directory.mkdir(parents=True)
            (directory / "extension-artifacts.json").write_text(
                json.dumps(
                    {
                        "schema": "oliphaunt-extension-ci-artifacts-v1",
                        "product": "oliphaunt-extension-demo",
                        "version": "0.1.0",
                        "sqlName": "demo",
                    }
                )
                + "\n",
                encoding="utf-8",
            )
        manifests = local_registry_metadata_json(
            "discover-extension-manifests",
            ("--root", str(first.parent), "--root", str(second.parent)),
        )
        expected_manifest = str(first / "extension-artifacts.json")
        if manifests != [expected_manifest]:
            fail("local registry extension manifest discovery must deduplicate product/version/sql rows by root priority")


def validate_rust() -> None:
    require_text(
        "src/sdks/rust/tools/check-sdk.sh",
        "--resolve-release-assets",
        "Rust SDK package check must exercise release-shaped liboliphaunt asset resolution",
    )
    require_text(
        "src/sdks/rust/tools/check-sdk.sh",
        "create-liboliphaunt-release-fixture.mjs",
        "Rust SDK package check must use deterministic Bun release-shaped liboliphaunt asset fixtures",
    )
    require_text(
        "src/sdks/rust/tools/check-sdk.sh",
        "--resolve-broker-release-assets",
        "Rust SDK package check must exercise release-shaped broker helper asset resolution",
    )
    require_text(
        "src/sdks/rust/tools/check-sdk.sh",
        "create-broker-release-fixture.mjs",
        "Rust SDK package check must use deterministic Bun release-shaped broker asset fixtures",
    )
    require_text(
        "src/sdks/rust/src/bin/package_resources.rs",
        "--resolve-broker-release-assets",
        "Rust SDK resource resolver must expose broker helper release asset resolution",
    )
    require_text(
        "src/sdks/rust/README.md",
        "oliphaunt-build = \"0.1.0\"",
        "Rust SDK README must document the Cargo-native build helper dependency",
    )
    require_text(
        "src/sdks/rust/README.md",
        "oliphaunt_build::configure()",
        "Rust SDK README must document the Cargo-native build script entrypoint",
    )
    require_text(
        "src/sdks/rust/README.md",
        "variables as part of normal installation",
        "Rust SDK README must not present broker asset environment variables as the consumer path",
    )
    require_text(
        "src/sdks/rust/src/bin/package_resources.rs",
        'assets.push(format!("liboliphaunt-{version}-linux-x64-gnu.tar.gz"))',
        "Rust SDK release asset resolver must support Linux x64 liboliphaunt assets",
    )
    require_text(
        "src/sdks/rust/src/bin/package_resources.rs",
        'assets.push(format!("oliphaunt-tools-{version}-linux-x64-gnu.tar.gz"))',
        "Rust SDK release asset resolver must support split Linux x64 oliphaunt-tools assets",
    )
    require_text(
        "src/sdks/rust/src/bin/package_resources.rs",
        '"linux-arm64-gnu" =>',
        "Rust SDK release asset resolver must support Linux arm64 liboliphaunt assets",
    )
    require_text(
        "src/sdks/rust/src/bin/package_resources.rs",
        '"windows-x64-msvc" =>',
        "Rust SDK release asset resolver must support Windows x64 liboliphaunt assets",
    )
    require_text(
        "src/sdks/rust/src/config.rs",
        "let _ = self.resolved_extensions()?;",
        "Rust OpenConfig::validate must resolve extension dependencies before runtime startup",
    )


def validate_broker() -> None:
    require_text(
        "tools/release/package-broker-assets.sh",
        "oliphaunt-broker-${version}-${target_id}.${asset_extension}",
        "Broker runtime release must package platform-scoped oliphaunt-broker helper assets",
    )
    require_text(
        "tools/release/package-broker-assets.sh",
        'target_id="windows-x64-msvc"',
        "Broker runtime release must package the Windows broker helper target",
    )
    require_text(
        "tools/release/package-broker-assets.sh",
        "oliphaunt-broker-${version}-release-assets.sha256",
        "Broker runtime release must publish a checksum manifest for broker helper assets",
    )
    require_text(
        "tools/release/check-broker-release-assets.mjs",
        "executableRelativePath",
        "Broker runtime release asset checker must verify the metadata-declared helper executable",
    )


def validate_swift(swift_version: str, liboliphaunt_version: str) -> None:
    if read_text("src/sdks/swift/VERSION").strip() != swift_version:
        fail("Swift VERSION must match oliphaunt-swift product version")
    if read_text("src/sdks/swift/LIBOLIPHAUNT_VERSION").strip() != liboliphaunt_version:
        fail("Swift LIBOLIPHAUNT_VERSION must match the current liboliphaunt product version")
    require_text(
        "Package.swift",
        'path: "src/sdks/swift/Sources/Oliphaunt"',
        "root SwiftPM package must expose the Apple SDK from the monorepo root",
    )
    require_text(
        "Package.swift",
        'path: "src/sdks/swift/Sources/COliphaunt"',
        "root SwiftPM package must expose the C bridge target from the monorepo root",
    )
    require_text(
        "tools/release/render_swiftpm_release_package.mjs",
        "binaryTarget(",
        "SwiftPM release manifest renderer must emit a binary liboliphaunt target",
    )
    require_text(
        "tools/release/render_swiftpm_release_package.mjs",
        "liboliphaunt-native-v",
        "SwiftPM release manifest renderer must use liboliphaunt GitHub release assets",
    )
    require_text(
        "src/sdks/swift/tools/check-sdk.sh",
        "render_swiftpm_release_package.mjs",
        "Swift SDK package check must render the public SwiftPM release manifest from release-shaped assets",
    )
    require_text(
        "src/sdks/swift/tools/check-sdk.sh",
        "OLIPHAUNT_SWIFT_RELEASE_ASSET_DIR",
        "Swift SDK package check must consume real liboliphaunt release assets when CI provides them",
    )
    require_text(
        "src/sdks/swift/tools/check-sdk.sh",
        "liboliphaunt-$liboliphaunt_version-apple-spm-xcframework.zip",
        "Swift SDK package check must require the real Apple SwiftPM XCFramework release asset",
    )
    require_text(
        "src/sdks/swift/tools/check-sdk.sh",
        "Swift package-shape requires OLIPHAUNT_SWIFT_RELEASE_ASSET_DIR",
        "Swift SDK package check must fail closed instead of fabricating local release assets",
    )
    require_text(
        "tools/release/build-sdk-ci-artifacts.mjs",
        "render_swiftpm_release_package.mjs",
        "Swift SDK package artifact builder must render the staged public SwiftPM release manifest",
    )
    require_text(
        "tools/release/build-sdk-ci-artifacts.mjs",
        'path.join(artifactRoot, "Package.swift.release")',
        "Swift SDK package artifact builder must stage Package.swift.release as a release artifact",
    )
    require_text(
        "tools/release/build-sdk-ci-artifacts.mjs",
        "staged SwiftPM release manifest must not contain local file URLs",
        "Swift SDK package artifact builder must reject local file URLs in release artifacts",
    )
    reject_text(
        "tools/release/build-sdk-ci-artifacts.mjs",
        'cp "$work_root/check/package-shape/Package.swift.release"',
        "Swift SDK package artifact builder must not stage the local validation manifest",
    )
    require_text(
        "tools/release/render_swiftpm_release_package.mjs",
        "base Swift package must not require or publish extension files",
        "SwiftPM release manifest renderer must keep exact extensions out of the base package",
    )
    renderer = read_text("tools/release/render_swiftpm_release_package.mjs")
    for forbidden in ("extension_rows", "dependency_closure", "OliphauntExtension"):
        if forbidden in renderer:
            fail(f"SwiftPM release manifest renderer must not synthesize base-package extension products: {forbidden}")
    require_text(
        "tools/release/publish_swiftpm_source_tag.mjs",
        "commit-tree",
        "SwiftPM source-tag publisher must create a release-only manifest commit",
    )
    require_text(
        "tools/release/publish_swiftpm_source_tag.mjs",
        "--include-tree",
        "SwiftPM source-tag publisher must be able to include generated release-tree files",
    )
    require_text(
        "tools/release/release.py",
        "staged_swift_release_artifacts",
        "release CLI must validate staged Swift source and SwiftPM manifest artifacts before dry-run or tagging",
    )
    require_text(
        "tools/release/release.py",
        "Oliphaunt-source.zip",
        "release CLI must require the staged Swift source archive",
    )
    require_text(
        "tools/release/release.py",
        "Package.swift.release",
        "release CLI must require the staged SwiftPM release manifest",
    )
    require_text(
        "tools/release/release.py",
        "apple-spm-xcframework.zip",
        "release CLI must validate that the staged SwiftPM manifest points at the Apple liboliphaunt binary artifact",
    )
    require_text(
        "tools/release/release.py",
        "--manifest",
        "release CLI must pass a SwiftPM manifest to the source-tag publisher",
    )
    require_text(
        "tools/release/release.py",
        "--include-tree",
        "release CLI must pass the SwiftPM release-tree root to the source-tag publisher",
    )
    require_text(
        "tools/release/release.py",
        'output_manifest = output_dir / "Package.swift.release"',
        "release CLI must stage the SwiftPM binary manifest before tagging",
    )
    require_text(
        "src/sdks/swift/README.md",
        "Normal iOS and macOS app consumers do not install Rust",
        "Swift SDK README must make the no-Rust consumer install path explicit",
    )
    require_text(
        "src/sdks/swift/README.md",
        "OliphauntICU",
        "Swift SDK README must document the optional ICU data product",
    )
    require_text(
        "src/sdks/swift/README.md",
        "oliphaunt-extension-vector",
        "Swift SDK README must describe exact-extension artifacts by release product, not hidden SwiftPM products",
    )
    require_text(
        "src/sdks/swift/Tests/OliphauntTests/OliphauntTests.swift",
        "@Test\nfunc runtimeResourcesRejectUnsupportedPackageKindLayout() throws",
        "Swift runtime-resource layout rejection must be an executable test, not an unannotated helper",
    )
    require_text(
        "src/sdks/swift/Sources/Oliphaunt/OliphauntNativeDirect.swift",
        "resolveExplicitRuntimeDirectory",
        "Swift native-direct explicit runtimeDirectory must validate selected extensions against release-shaped runtime resources",
    )
    require_text(
        "src/sdks/swift/Sources/Oliphaunt/OliphauntNativeDirect.swift",
        "release-shaped OliphauntRuntimeResources",
        "Swift native-direct explicit runtimeDirectory errors must require release-shaped resource proof for selected extensions",
    )
    require_text(
        "src/sdks/swift/Sources/Oliphaunt/OliphauntRuntimeResources.swift",
        "forRuntimeDirectory runtimeDirectory: URL",
        "Swift runtime resources must validate explicit runtimeDirectory and return shared-preload metadata from the manifest",
    )
    require_text(
        "src/sdks/swift/Sources/Oliphaunt/OliphauntRuntimeResources.swift",
        "releaseShapedResources",
        "Swift runtime resources must infer only oliphaunt/runtime/files resource trees for explicit runtimeDirectory validation",
    )
    require_text(
        "src/sdks/swift/Tests/OliphauntTests/OliphauntTests.swift",
        "nativeDirectExtensionsRejectUnprovedExplicitRuntimeDirectory",
        "Swift tests must reject explicit runtimeDirectory extensions without release-shaped proof",
    )
    require_text(
        "src/sdks/swift/Tests/OliphauntTests/OliphauntTests.swift",
        "runtimeResourcesValidateExplicitRuntimeDirectory",
        "Swift tests must validate explicit runtimeDirectory extension files and shared-preload metadata",
    )
    swift_readme = read_text("src/sdks/swift/README.md")
    allowed_extension_api_symbols = {
        "OliphauntExtensionArtifactResolution",
        "OliphauntExtensionArtifactResolver",
        "OliphauntExtensionReleaseAsset",
        "OliphauntExtensionReleaseManifest",
        "OliphauntExtensionSizeReport",
    }
    for symbol in re.findall(r"\bOliphauntExtension[A-Z][A-Za-z0-9]*\b", swift_readme):
        if symbol not in allowed_extension_api_symbols:
            fail(
                "Swift SDK README must not advertise generated OliphauntExtension* "
                f"products until they exist: {symbol}"
            )
    for retired_podspec in [
        ROOT / "src/sdks/swift/COliphaunt.podspec",
        ROOT / "src/sdks/swift/Oliphaunt.podspec",
    ]:
        if retired_podspec.exists():
            fail(
                f"standalone Swift SDK must stay SwiftPM-only; remove {retired_podspec.relative_to(ROOT)}"
            )


def validate_kotlin(kotlin_version: str, liboliphaunt_version: str) -> None:
    plugin_liboliphaunt_version = read_text(
        "src/sdks/kotlin/oliphaunt-android-gradle-plugin/src/main/resources/dev/oliphaunt/android/liboliphaunt.version"
    ).strip()
    if plugin_liboliphaunt_version != liboliphaunt_version:
        fail("Kotlin Android Gradle plugin embedded liboliphaunt version must match liboliphaunt product version")
    require_text(
        "src/sdks/kotlin/oliphaunt/build.gradle.kts",
        'version = providers.gradleProperty("VERSION_NAME")',
        "Kotlin publication must derive project.version from VERSION_NAME",
    )
    require_text(
        "src/sdks/kotlin/oliphaunt/build.gradle.kts",
        'group = providers.gradleProperty("GROUP")',
        "Kotlin publication must derive group from gradle.properties",
    )
    require_text(
        "src/sdks/kotlin/oliphaunt-android-gradle-plugin/build.gradle.kts",
        'id = "dev.oliphaunt.android"',
        "Kotlin release must publish the app-applied Android Gradle plugin marker",
    )
    require_text(
        "src/sdks/kotlin/README.md",
        "Normal Android app consumers use Gradle, Maven Central",
        "Kotlin README must make the no-Rust consumer install path explicit",
    )
    require_text(
        "src/sdks/kotlin/README.md",
        "icu.set(true)",
        "Kotlin README must document the optional Android ICU selector",
    )
    require_text(
        "src/sdks/kotlin/README.md",
        "dev.oliphaunt.runtime:oliphaunt-icu",
        "Kotlin README must document the optional ICU Maven artifact",
    )
    require_text(
        "src/sdks/kotlin/oliphaunt/src/androidMain/kotlin/dev/oliphaunt/OliphauntAndroid.kt",
        "resourceRoot: File? = null",
        "Kotlin Android open must expose optional resourceRoot for release-shaped local runtime resources",
    )
    require_text(
        "src/sdks/kotlin/oliphaunt/src/androidMain/kotlin/dev/oliphaunt/AndroidNativeDirectEngine.kt",
        "resourceRoot = resourceRoot",
        "Kotlin Android native-direct engine must pass explicit resourceRoot into runtime resolution",
    )
    require_text(
        "src/sdks/kotlin/oliphaunt/src/androidMain/kotlin/dev/oliphaunt/OliphauntAndroidRuntimeAssets.kt",
        "validateExplicitRuntimeDirectory",
        "Kotlin Android explicit runtimeDirectory must validate selected extensions against release-shaped runtime resources",
    )
    require_text(
        "src/sdks/kotlin/oliphaunt/src/androidMain/kotlin/dev/oliphaunt/OliphauntAndroidRuntimeAssets.kt",
        "releaseShapedRuntimePackageForDirectory",
        "Kotlin Android explicit runtimeDirectory validation must infer only oliphaunt/runtime/files resource trees",
    )
    require_text(
        "src/sdks/kotlin/oliphaunt/src/androidMain/kotlin/dev/oliphaunt/OliphauntAndroidRuntimeAssets.kt",
        "requireExtensionInstallFiles(runtimePackage, requestedExtensions, runtimeRoot)",
        "Kotlin Android packaged runtime materialization must validate selected extension control and SQL files after copy",
    )
    require_text(
        "src/sdks/kotlin/oliphaunt/src/androidUnitTest/kotlin/dev/oliphaunt/OliphauntAndroidRuntimeAssetsTest.kt",
        "rejectsExplicitRuntimeDirectoryWithoutReleaseShapedProofForExtensions",
        "Kotlin Android tests must reject explicit runtimeDirectory extensions without release-shaped proof",
    )
    require_text(
        "src/sdks/kotlin/oliphaunt/src/androidUnitTest/kotlin/dev/oliphaunt/OliphauntAndroidRuntimeAssetsTest.kt",
        "rejectsExplicitRuntimeDirectoryWithMissingExtensionInstallFiles",
        "Kotlin Android tests must reject explicit runtimeDirectory extension manifests missing install files",
    )
    require_text(
        "src/sdks/kotlin/oliphaunt/build.gradle.kts",
        "fun oliphauntProperty(name: String)",
        "Kotlin Android Gradle packaging must accept canonical and existing capitalized Oliphaunt property spellings",
    )
    require_text(
        "src/sdks/kotlin/oliphaunt/build.gradle.kts",
        'project.findProperty("O${it.drop(1)}")',
        "Kotlin Android Gradle packaging must keep backward-compatible capitalized Oliphaunt property lookup",
    )
    require_text(
        "tools/release/release.py",
        'registry_package_names("oliphaunt-kotlin", "maven")',
        "Kotlin Maven release idempotency probes must derive package coordinates from release metadata",
    )
    reject_text(
        "tools/release/release.py",
        "https://repo1.maven.org/maven2/dev/oliphaunt/oliphaunt/",
        "Kotlin Maven release idempotency probes must not hard-code package coordinates",
    )
    require_text(
        "tools/release/build_maven_artifact_manifest.mjs",
        'registryPackageNames("liboliphaunt-native", "maven")',
        "Native runtime Maven artifact manifests must derive package coordinates from release metadata",
    )
    require_text(
        "tools/release/build_maven_artifact_manifest.mjs",
        "nativeRuntimeArtifactTargets(",
        "Native runtime Maven artifact manifests must derive release asset filenames from artifact target metadata",
    )
    reject_text(
        "tools/release/build_maven_artifact_manifest.mjs",
        "RUNTIME_MAVEN_ARTIFACTS",
        "Native runtime Maven artifact manifests must not duplicate release asset filenames in a static Maven table",
    )
    android_resolver = (
        "src/sdks/kotlin/oliphaunt-android-gradle-plugin/src/main/java/dev/oliphaunt/android/ResolveOliphauntAndroidAssetsTask.java"
    )
    for needle in [
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
    ]:
        require_text(
            android_resolver,
            needle,
            "Android Gradle resolver must validate selected exact-extension runtime artifacts before generated manifests declare them",
        )
    for path in [
        "src/sdks/kotlin/oliphaunt-android-gradle-plugin/src/main/java/dev/oliphaunt/android/OliphauntAndroidPlugin.java",
        android_resolver,
        "src/sdks/kotlin/oliphaunt/build.gradle.kts",
    ]:
        for forbidden in [
            "github.com/f0rr0/oliphaunt/releases/download",
            "openStream()",
            "downloadAsset(",
            "downloadAndVerify(",
            "downloadAndVerifyExtension(",
            "downloadExtensionAsset(",
            "assetBaseUrl",
            "release-asset-cache",
        ]:
            reject_text(
                path,
                forbidden,
                "Kotlin/Android consumer builds must resolve Oliphaunt bytes through Gradle/Maven dependencies, not runtime GitHub release downloads",
            )
    for forbidden in [
        "downloads and verifies",
        "GitHub release assets during the normal Gradle build",
        "https://github.com/f0rr0/oliphaunt/releases/download",
        "PoliphauntAssetBaseUrl",
    ]:
        reject_text(
            "src/sdks/kotlin/README.md",
            forbidden,
            "Kotlin README must not document GitHub release downloads as the Android consumer install path",
        )


def validate_react_native(rn_version: str, swift_version: str, kotlin_version: str) -> None:
    package = json.loads(read_text("src/sdks/react-native/package.json"))
    validate_no_consumer_install_scripts(package, "React Native")
    if package.get("version") != rn_version:
        fail("React Native package.json version must match oliphaunt-react-native product version")
    metadata = package.get("oliphaunt")
    if not isinstance(metadata, dict):
        fail("React Native package.json must include oliphaunt compatibility metadata")
    if metadata.get("swiftSdkVersion") != swift_version:
        fail("React Native package.json swiftSdkVersion must match current Swift SDK version")
    if metadata.get("kotlinSdkVersion") != kotlin_version:
        fail("React Native package.json kotlinSdkVersion must match current Kotlin SDK version")
    require_text(
        "src/sdks/react-native/OliphauntReactNative.podspec",
        'package["version"]',
        "React Native podspec must derive its version from package.json",
    )
    require_text(
        "src/sdks/react-native/OliphauntReactNative.podspec",
        'package.fetch("oliphaunt", {}).fetch("swiftSdkVersion", package["version"])',
        "React Native podspec must derive its Swift SDK dependency from package metadata",
    )
    require_text(
        "src/sdks/react-native/OliphauntReactNative.podspec",
        's.dependency "Oliphaunt", native_sdk_version',
        "React Native podspec must depend on the compatible Swift SDK version",
    )
    require_text(
        "src/sdks/react-native/android/settings.gradle",
        "if (configuredKotlinSdkDir != null && !configuredKotlinSdkDir.isBlank())",
        "React Native Android local Kotlin SDK composite builds must be explicit development overrides",
    )
    require_text(
        "src/sdks/react-native/android/build.gradle",
        '?: "dev.oliphaunt:oliphaunt:${kotlinSdkVersion}"',
        "React Native Android package must default to the published Kotlin SDK Maven coordinate",
    )
    require_text(
        "src/sdks/react-native/android/src/main/java/dev/oliphaunt/reactnative/OliphauntModule.kt",
        "resourceRoot = openConfig.resourceRoot?.let(::File)",
        "React Native Android open must forward resourceRoot to the Kotlin Android runtime resolver",
    )
    require_text(
        "src/sdks/react-native/android/src/main/java/dev/oliphaunt/reactnative/OliphauntModule.kt",
        "resourceRoot.orEmpty()",
        "React Native Android reopen keys must include resourceRoot",
    )
    require_text(
        "src/sdks/react-native/src/__tests__/client.test.ts",
        "extensions: ['hstore', 'unaccent']",
        "React Native JS tests must forward selected extensions together with explicit native runtime/resource overrides",
    )
    require_text(
        "src/sdks/react-native/android/build.gradle",
        "def oliphauntProperty = { String name ->",
        "React Native Android Gradle packaging must accept canonical and existing capitalized Oliphaunt property spellings",
    )
    require_text(
        "src/sdks/react-native/android/build.gradle",
        'project.findProperty("O${name.substring(1)}")',
        "React Native Android Gradle packaging must keep backward-compatible capitalized Oliphaunt property lookup",
    )
    for needle in [
        'validateSelectedExtensionFiles(new File(output, "oliphaunt/runtime/files"), selectedExtensions.get())',
        "validateSelectedExtensionFiles(filesDir, extensions)",
        "private static void validateSelectedExtensionFiles",
        "is missing control file",
        "has no packaged SQL files in",
    ]:
        require_text(
            "src/sdks/react-native/android/build.gradle",
            needle,
            "React Native Android asset preparation must validate selected extension control and SQL files for split and prebuilt runtime resources",
        )
    for needle in [
        "PNPM_CONFIG_LOCKFILE",
        "src/sdks/kotlin/gradlew",
        "react-native-split-incomplete-extension",
        "prebuilt runtime resources accepted a selected extension without packaged SQL files",
        "-PoliphauntReactNativePackageRuntime=true",
    ]:
        require_text(
            "src/sdks/react-native/tools/check-sdk.sh",
            needle,
            "React Native Android package checks must cover selected-extension file validation for split and prebuilt runtime resources",
        )
    require_text(
        "src/sdks/react-native/tools/check-sdk.sh",
        "local Kotlin SDK composite builds must be explicit development overrides",
        "React Native package check must guard the release-shaped Kotlin dependency boundary",
    )
    require_text(
        "src/sdks/react-native/app.plugin.js",
        "ios/podspecs",
        "React Native Expo config plugin must resolve Swift SDK pods through npm-shipped podspec shims",
    )
    require_text(
        "src/sdks/react-native/app.plugin.js",
        "pod 'COliphaunt', :podspec => File.join(oliphaunt_podspecs_path, 'COliphaunt.podspec')",
        "React Native Expo config plugin must inject the C bridge podspec shim",
    )
    require_text(
        "src/sdks/react-native/ios/podspecs/COliphaunt.podspec",
        "src/sdks/swift/Sources/COliphaunt",
        "React Native C podspec shim must point CocoaPods at the released Swift SDK C bridge source",
    )
    require_text(
        "src/sdks/react-native/ios/podspecs/COliphaunt.podspec",
        's.module_map = "src/sdks/swift/Sources/COliphaunt/include/module.modulemap"',
        "React Native C podspec shim must expose the COliphaunt module map",
    )
    require_text(
        "src/sdks/react-native/ios/podspecs/Oliphaunt.podspec",
        "src/sdks/swift/Sources/Oliphaunt/**/*.swift",
        "React Native Swift podspec shim must point CocoaPods at the released Swift SDK source",
    )
    require_text(
        "src/sdks/react-native/ios/podspecs/Oliphaunt.podspec",
        's.dependency "COliphaunt", swift_sdk_version',
        "React Native Swift podspec shim must depend on the exact C bridge version",
    )
    reject_text(
        "src/sdks/react-native/package.json",
        "prepare-apple-vendor",
        "React Native package must not generate a vendored Swift SDK source slice before publishing",
    )
    repository = package.get("repository")
    if not isinstance(repository, dict):
        fail("React Native package must declare repository metadata")
    if repository.get("url") != "git+https://github.com/f0rr0/oliphaunt.git":
        fail("React Native package repository URL must match canonical release repository")
    if repository.get("directory") != "src/sdks/react-native":
        fail("React Native package repository.directory must point at the package root")
    publish_config = package.get("publishConfig")
    if not isinstance(publish_config, dict) or publish_config.get("provenance") is not True:
        fail("React Native package must request npm provenance")
    require_text(
        "src/sdks/react-native/README.md",
        "Normal React Native and Expo app consumers do not install Rust",
        "React Native README must make the no-Rust consumer install path explicit",
    )
    require_text(
        "src/sdks/react-native/README.md",
        "pnpm add @oliphaunt/react-native @oliphaunt/icu",
        "React Native README must document the optional ICU npm sidecar install",
    )
    require_text(
        "src/sdks/react-native/README.md",
        '"icu": true',
        "React Native README must document the config plugin ICU selector",
    )
    for path in [
        "src/sdks/react-native/src/specs/NativeOliphaunt.ts",
        "src/sdks/react-native/src/client.ts",
        "src/sdks/react-native/android/src/main/java/dev/oliphaunt/reactnative/OliphauntModule.kt",
        "src/sdks/react-native/ios/OliphauntAdapter.swift",
    ]:
        require_text(
            path,
            "runtimeFeatures",
            "React Native package-size reports must preserve runtime feature metadata like Kotlin and Swift",
        )


def validate_typescript(
    ts_version: str,
    liboliphaunt_version: str,
    broker_version: str,
    node_direct_version: str,
) -> None:
    package = json.loads(read_text("src/sdks/js/package.json"))
    validate_no_consumer_install_scripts(package, "TypeScript")
    if package.get("version") != ts_version:
        fail("TypeScript package.json version must match oliphaunt-js product version")
    metadata = package.get("oliphaunt")
    if not isinstance(metadata, dict):
        fail("TypeScript package.json must include oliphaunt compatibility metadata")
    if metadata.get("liboliphauntVersion") != liboliphaunt_version:
        fail("TypeScript package.json liboliphauntVersion must match current liboliphaunt product version")
    if metadata.get("icuPackage") != "@oliphaunt/icu":
        fail("TypeScript package.json must identify the optional ICU data package it consumes")
    if metadata.get("icuVersion") != liboliphaunt_version:
        fail("TypeScript package.json icuVersion must match current liboliphaunt product version")
    if metadata.get("brokerVersion") != broker_version:
        fail("TypeScript package.json brokerVersion must match current broker runtime version")
    if metadata.get("nodeDirectAddonVersion") != node_direct_version:
        fail("TypeScript package.json nodeDirectAddonVersion must match current Node direct runtime version")
    if metadata.get("nodeDirectAddon") != "oliphaunt-node-direct":
        fail("TypeScript package.json must identify the Node native-direct adapter it consumes")
    if metadata.get("brokerHelper") != "oliphaunt-broker":
        fail("TypeScript package.json must identify the Rust broker helper it consumes")
    repository = package.get("repository")
    if not isinstance(repository, dict):
        fail("TypeScript package must declare repository metadata")
    if repository.get("url") != "git+https://github.com/f0rr0/oliphaunt.git":
        fail("TypeScript package repository URL must match canonical release repository")
    if repository.get("directory") != "src/sdks/js":
        fail("TypeScript package repository.directory must point at the package root")
    publish_config = package.get("publishConfig")
    if not isinstance(publish_config, dict) or publish_config.get("provenance") is not True:
        fail("TypeScript npm registry artifact must request provenance")
    require_text(
        "src/sdks/js/README.md",
        "pnpm add @oliphaunt/icu",
        "TypeScript README must document the optional ICU npm sidecar install",
    )
    require_text(
        "src/sdks/js/README.md",
        "deno add npm:@oliphaunt/icu",
        "TypeScript README must document the optional Deno npm ICU sidecar install",
    )
    dependencies = package.get("dependencies", {})
    if dependencies not in ({}, None):
        fail("TypeScript SDK must not declare regular runtime artifact dependencies")
    expected_optional = typescript_optional_runtime_package_versions()
    optional_dependencies = package.get("optionalDependencies", {})
    if not isinstance(optional_dependencies, dict) or set(optional_dependencies) != set(expected_optional):
        fail("TypeScript package.json must declare exactly the runtime optional platform packages")
    stale_optional = {
        name: version
        for name, version in optional_dependencies.items()
        if version != f"workspace:{expected_optional[name]}"
    }
    if stale_optional:
        fail("TypeScript package.json optional dependency versions must match product versions")
    validate_platform_npm_packages(
        "liboliphaunt-native",
        "native-runtime",
        "typescript-native-direct",
        "src/runtimes/liboliphaunt/native/packages",
        liboliphaunt_version,
    )
    validate_platform_npm_packages(
        "liboliphaunt-native",
        "native-tools",
        "typescript-native-direct",
        "src/runtimes/liboliphaunt/native/tools-packages",
        liboliphaunt_version,
    )
    icu_package = json.loads(read_text("src/runtimes/liboliphaunt/native/icu-npm/package.json"))
    icu_metadata = icu_package.get("oliphaunt")
    if (
        icu_package.get("name") != "@oliphaunt/icu"
        or icu_package.get("version") != liboliphaunt_version
        or not isinstance(icu_metadata, dict)
        or icu_metadata.get("product") != "oliphaunt-icu"
        or icu_metadata.get("kind") != "icu-data"
        or icu_metadata.get("target") != "portable"
        or icu_metadata.get("dataRelativePath") != "share/icu"
    ):
        fail("@oliphaunt/icu package metadata must match the portable liboliphaunt ICU data artifact")
    icu_podspec = read_text("src/runtimes/liboliphaunt/native/icu-npm/OliphauntICU.podspec")
    if f"s.version = '{liboliphaunt_version}'" not in icu_podspec or "x-release-please-version" not in icu_podspec:
        fail("OliphauntICU.podspec version must match liboliphaunt and be managed by release-please")
    require_text(
        "tools/release/release.py",
        'extra_descriptors=("OliphauntICU.podspec",)',
        "release CLI must include the ICU podspec in the staged npm package",
    )
    release_config = json.loads(read_text("release-please-config.json"))
    native_release = release_config.get("packages", {}).get("src/runtimes/liboliphaunt/native", {})
    native_extra_files = native_release.get("extra-files", [])
    if {
        "type": "json",
        "path": "icu-npm/package.json",
        "jsonpath": "$.version",
    } not in native_extra_files or {"type": "generic", "path": "icu-npm/OliphauntICU.podspec"} not in native_extra_files:
        fail("release-please must bump @oliphaunt/icu npm and podspec versions with liboliphaunt-native")
    validate_platform_npm_packages(
        "oliphaunt-broker",
        "broker-helper",
        "typescript-broker",
        "src/runtimes/broker/packages",
        broker_version,
    )
    exports = package.get("exports")
    if not isinstance(exports, dict):
        fail("TypeScript package must declare explicit exports")
    for export_name in [".", "./node", "./bun", "./deno", "./protocol", "./query"]:
        if export_name not in exports:
            fail(f"TypeScript package is missing export {export_name}")

    jsr_config = json.loads(read_text("src/sdks/js/jsr.json"))
    if jsr_config.get("name") != "@oliphaunt/ts":
        fail("TypeScript JSR package name must be @oliphaunt/ts")
    if jsr_config.get("version") != ts_version:
        fail("TypeScript jsr.json version must match oliphaunt-js product version")
    jsr_exports = jsr_config.get("exports")
    if not isinstance(jsr_exports, dict):
        fail("TypeScript JSR config must declare explicit exports")
    for export_name in [".", "./protocol", "./query"]:
        if export_name not in jsr_exports:
            fail(f"TypeScript JSR package is missing export {export_name}")
    for export_name in ["./node", "./bun", "./deno"]:
        if export_name in jsr_exports:
            fail(f"TypeScript JSR package must not export native entrypoint {export_name}")
    require_text(
        "src/sdks/js/tools/check-sdk.sh",
        "jsr publish --dry-run",
        "TypeScript SDK checks must validate JSR package shape",
    )
    require_text(
        "src/sdks/js/tools/check-sdk.sh",
        "packed TypeScript package must rewrite runtime optional dependencies to exact published versions",
        "TypeScript SDK checks must inspect the packed npm manifest for publish-safe runtime optional dependencies",
    )
    require_text(
        "src/sdks/js/tools/check-sdk.sh",
        'tools/dev/bun.sh" "$package_dir/.oliphaunt-bun-smoke.ts"',
        "TypeScript SDK checks must validate Bun through the pinned repo launcher",
    )
    require_text(
        "src/sdks/js/tools/check-sdk.sh",
        ".oliphaunt-bun-smoke.ts",
        "TypeScript SDK checks must run a Bun import smoke for the npm-registry package surface",
    )
    require_text(
        "src/sdks/js/README.md",
        "Deno can consume packages from",
        "TypeScript README must explain npm-vs-JSR install guidance for Deno consumers",
    )
    require_text(
        "src/sdks/js/README.md",
        "There is no `postinstall` native compilation step",
        "TypeScript README must make the no-build consumer install path explicit",
    )
    require_text(
        "src/sdks/js/README.md",
        "Do not\ninstall `@oliphaunt/ts` with optional dependencies disabled",
        "TypeScript README must document that optional platform packages are required for native runtime installs",
    )
    require_text(
        "src/sdks/js/README.md",
        "Node.js, Bun, and Deno use `nativeDirect` by default",
        "TypeScript README must document the consistent nativeDirect default",
    )
    require_text(
        "src/sdks/js/README.md",
        "prebuilt Node direct adapter",
        "TypeScript README must keep Node direct mode on a zero-build package-owned adapter path",
    )
    require_text(
        "src/sdks/js/ARCHITECTURE.md",
        "Node.js, Bun, and Deno all default to\n`nativeDirect`",
        "TypeScript architecture must keep default engine selection consistent across runtimes",
    )
    require_text(
        "src/sdks/js/ARCHITECTURE.md",
        "oliphaunt-node-direct-*",
        "TypeScript architecture must keep Node direct mode on prebuilt adapter release assets",
    )
    require_text(
        "src/sdks/js/tools/check-sdk.sh",
        "cargo build -p oliphaunt-broker --locked",
        "TypeScript broker smoke must build the Rust broker helper when no released helper is present",
    )
    require_text(
        "src/sdks/js/src/native/common.ts",
        "liboliphauntPackageTarget",
        "TypeScript SDK must select product-scoped liboliphaunt platform packages",
    )
    require_text(
        "src/sdks/js/src/native/assets-node.ts",
        "runtimeRelativePath",
        "TypeScript Node/Bun native binding must resolve runtime resources from the selected liboliphaunt package",
    )
    require_text(
        "src/sdks/js/src/native/node-addon.ts",
        "oliphaunt-node-direct",
        "TypeScript Node native-direct binding must resolve compatible Node-API adapter packages",
    )
    require_text(
        "src/runtimes/node-direct/native/node-addon/oliphaunt_node.cc",
        "NAPI_MODULE",
        "Node direct runtime must have a package-owned Node-API implementation",
    )
    require_text(
        "src/runtimes/node-direct/tools/build-node-addon.sh",
        "oliphaunt-node-direct-$version-$target.tar.gz",
        "Node direct release tooling must package the Node native-direct adapter release asset",
    )
    require_text(
        "src/runtimes/node-direct/tools/build-node-addon.sh",
        "Node direct addon smoke passed",
        "Node direct release tooling must load-smoke the compiled adapter before publishing it",
    )
    require_text(
        "src/runtimes/node-direct/tools/build-node-addon.sh",
        "check-node-direct-release-assets.mjs",
        "Node direct release tooling must validate addon archives and checksums after building",
    )
    require_text(
        "tools/release/release.py",
        "check-node-direct-release-assets.mjs",
        "Node direct release publishing must validate addon archives and checksums before upload/npm staging",
    )
    require_text(
        ".github/workflows/ci.yml",
        ".github/scripts/run-planned-moon-job.sh node-direct",
        "Node direct CI matrix must invoke the planned Moon job that includes release-shaped addon artifacts on each published target",
    )
    require_text(
        "src/runtimes/node-direct/moon.yml",
        'tags: ["release", "artifact", "ci-node-direct"]',
        "Node direct release-assets must be selected by the ci-node-direct Moon tag",
    )
    require_text(
        ".github/workflows/ci.yml",
        ".github/actions/setup-msvc",
        "Node direct Windows CI must set up an MSVC developer environment for cl.exe",
    )
    require_text(
        ".github/actions/setup-msvc/action.yml",
        "ilammy/msvc-dev-cmd@0b201ec74fa43914dc39ae48a89fd1d8cb592756",
        "shared MSVC CI setup must use the pinned MSVC developer environment action",
    )
    require_text(
        ".github/actions/setup-msvc/action.yml",
        "CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_LINKER",
        "shared MSVC CI setup must force Rust MSVC builds to use the MSVC linker under Git Bash",
    )
    require_text(
        "tools/release/release-product-dry-run.mjs",
        "nodeDirectOptionalNpmTarballs",
        "Node direct release dry-run must validate staged optional npm tarballs from the builder job in Bun",
    )
    require_text(
        "tools/release/release-product-dry-run.mjs",
        "brokerNpmTarballs",
        "Broker release dry-run must validate staged broker npm tarballs from release assets in Bun",
    )
    require_text(
        "tools/release/release-product-dry-run.mjs",
        "exactExtensionProducts(TOOL)",
        "Exact-extension release dry-runs must run through the Bun product dry-run support set",
    )
    require_text(
        "tools/release/release-product-dry-run.mjs",
        "--require-full-extension-targets",
        "Exact-extension release dry-runs must reject partial staged extension packages in Bun",
    )
    require_text(
        "tools/release/release-product-dry-run.mjs",
        ":oliphaunt-maven-artifacts:publishToMavenLocal",
        "Exact-extension release dry-runs must publish extension Maven artifacts to Maven Local in Bun",
    )
    require_text(
        "src/sdks/js/src/native/assets-deno.ts",
        "runtimeRelativePath",
        "TypeScript Deno native binding must resolve runtime resources from the selected liboliphaunt package",
    )
    require_text(
        "src/sdks/js/src/native/deno.ts",
        "Deno nativeDirect does not automatically materialize extension packages",
        "TypeScript Deno native binding must fail clearly for package-managed extension materialization",
    )
    require_text(
        "src/sdks/js/src/native/extension-runtime.ts",
        "validatePreparedRuntimeExtensions",
        "TypeScript native bindings must share explicit runtimeDirectory extension-file validation",
    )
    require_text(
        "src/sdks/js/src/native/assets-deno.ts",
        "validatePreparedDenoRuntimeExtensions",
        "TypeScript Deno native binding must validate explicit prepared runtimeDirectory extension files",
    )
    require_text(
        "src/sdks/js/src/__tests__/native-bindings.test.ts",
        "testDenoNativeBindingRejectsPackageManagedExtensions",
        "TypeScript SDK tests must cover Deno package-managed extension rejection",
    )
    require_text(
        "src/sdks/js/src/__tests__/native-bindings.test.ts",
        "Deno nativeDirect explicit runtimeDirectory",
        "TypeScript SDK tests must reject Deno explicit runtimeDirectory extensions missing prepared files",
    )
    require_text(
        "src/sdks/js/src/__tests__/asset-resolver.test.ts",
        "explicitRuntimeExtensionValidationUsesPreparedFiles",
        "TypeScript asset resolver tests must cover explicit prepared runtimeDirectory extension validation",
    )
    require_text(
        "src/sdks/js/src/__tests__/runtime-modes.test.ts",
        "testDenoBrokerModeValidatesExplicitExtensionRuntime",
        "TypeScript broker tests must cover Deno explicit prepared runtimeDirectory extension validation",
    )
    require_text(
        "src/sdks/js/src/runtime/broker.ts",
        "restorePhysicalArchiveWithBroker",
        "TypeScript broker helper must restore physical archives without requiring third-party Node FFI",
    )
    require_text(
        "src/sdks/js/src/__tests__/asset-resolver.test.ts",
        "nodeResolverUsesInstalledPackages",
        "TypeScript package-local resolver must have regression coverage",
    )
    require_text(
        "src/sdks/js/src/runtime/broker.ts",
        "resolveBrokerNativeInstall",
        "TypeScript broker mode must resolve the liboliphaunt install before launching the Rust helper",
    )
    require_text(
        "src/sdks/js/src/runtime/broker.ts",
        "OLIPHAUNT_INSTALL_DIR",
        "TypeScript broker mode must pass the resolved PostgreSQL runtime tree to the Rust helper",
    )
    require_text(
        "src/sdks/js/src/runtime/broker.ts",
        "LIBOLIPHAUNT_PATH",
        "TypeScript broker mode must pass the resolved liboliphaunt library to the Rust helper",
    )
    require_text(
        "src/sdks/js/src/runtime/broker.ts",
        "packageBrokerExecutable",
        "TypeScript broker mode must resolve the installed Rust broker helper package",
    )


def validate_node_direct(node_direct_version: str, liboliphaunt_version: str) -> None:
    package = json.loads(read_text("src/runtimes/node-direct/package.json"))
    if package.get("version") != node_direct_version:
        fail("Node direct package.json version must match oliphaunt-node-direct product version")
    metadata = package.get("oliphaunt")
    if not isinstance(metadata, dict):
        fail("Node direct package.json must include oliphaunt compatibility metadata")
    if metadata.get("liboliphauntVersion") != liboliphaunt_version:
        fail("Node direct package.json liboliphauntVersion must match current liboliphaunt product version")


def version_file_value(path: str) -> str:
    if Path(path).name == "Cargo.toml":
        return cargo_manifest_version(path)
    return read_text(path).strip()


def validate_wasm(wasix_runtime_version: str, wasm_binding_version: str) -> None:
    runtime_version_files = version_files("liboliphaunt-wasix")
    for path in runtime_version_files:
        if version_file_value(path) != wasix_runtime_version:
            fail(f"{path} must use liboliphaunt-wasix runtime version {wasix_runtime_version}")
    binding_version_files = version_files("oliphaunt-wasix-rust")
    for path in binding_version_files:
        if version_file_value(path) != wasm_binding_version:
            fail(f"{path} must use oliphaunt-wasix binding version {wasm_binding_version}")
    manifest = tomllib.loads(read_text("src/bindings/wasix-rust/crates/oliphaunt-wasix/Cargo.toml"))
    dependencies = manifest.get("dependencies", {})
    runtime_dependency = dependencies.get("liboliphaunt-wasix-portable")
    if not isinstance(runtime_dependency, dict) or runtime_dependency.get("version") != f"={wasix_runtime_version}":
        fail("oliphaunt-wasix must depend on liboliphaunt-wasix-portable at the exact liboliphaunt-wasix runtime version")
    tools_dependency = dependencies.get("oliphaunt-wasix-tools")
    if (
        not isinstance(tools_dependency, dict)
        or tools_dependency.get("version") != f"={wasix_runtime_version}"
        or tools_dependency.get("optional") is not True
    ):
        fail("oliphaunt-wasix must optionally depend on oliphaunt-wasix-tools at the exact liboliphaunt-wasix runtime version")
    icu_source_version = version_file_value("src/runtimes/liboliphaunt/icu/Cargo.toml")
    icu_dependency = dependencies.get("oliphaunt-icu")
    if (
        not isinstance(icu_dependency, dict)
        or icu_dependency.get("version") != f"={icu_source_version}"
        or icu_dependency.get("path") != "../../../../runtimes/liboliphaunt/icu"
        or icu_dependency.get("optional") is not True
    ):
        fail("oliphaunt-wasix source must optionally depend on the local oliphaunt-icu path crate version")
    expected_aot_dependencies = (
        wasix_public_aot_cargo_dependencies()
    )
    expected_tools_aot_dependencies = (
        wasix_public_tools_aot_cargo_dependencies()
    )
    target_tables = manifest.get("target", {})
    for cfg, crate in expected_aot_dependencies.items():
        target = target_tables.get(cfg)
        target_dependencies = target.get("dependencies", {}) if isinstance(target, dict) else {}
        dependency = target_dependencies.get(crate)
        if not isinstance(dependency, dict) or dependency.get("version") != f"={wasix_runtime_version}":
            fail(f"oliphaunt-wasix must depend on {crate} at the exact liboliphaunt-wasix runtime version behind {cfg}")
    for cfg, crate in expected_tools_aot_dependencies.items():
        target = target_tables.get(cfg)
        target_dependencies = target.get("dependencies", {}) if isinstance(target, dict) else {}
        dependency = target_dependencies.get(crate)
        if (
            not isinstance(dependency, dict)
            or dependency.get("version") != f"={wasix_runtime_version}"
            or dependency.get("optional") is not True
        ):
            fail(f"oliphaunt-wasix must optionally depend on {crate} at the exact liboliphaunt-wasix runtime version behind {cfg}")
    expected_tools_feature = (
        wasix_public_tools_feature_dependencies()
    )
    tools_feature = set(manifest.get("features", {}).get("tools", []))
    if tools_feature != expected_tools_feature:
        fail("oliphaunt-wasix tools feature must select exactly the WASIX pg_dump/psql tool artifact crates")
    asset_manifest = tomllib.loads(read_text("src/runtimes/liboliphaunt/wasix/crates/assets/Cargo.toml"))
    if asset_manifest.get("package", {}).get("name") != "liboliphaunt-wasix-portable":
        fail("WASIX root runtime asset crate must be liboliphaunt-wasix-portable")
    tools_manifest = tomllib.loads(read_text("src/runtimes/liboliphaunt/wasix/crates/tools/Cargo.toml"))
    if tools_manifest.get("package", {}).get("name") != "oliphaunt-wasix-tools":
        fail("WASIX split tools asset crate must be oliphaunt-wasix-tools")
    asset_build_source = read_text("src/runtimes/liboliphaunt/wasix/crates/assets/build.rs")
    release_workspace_source = read_text("tools/xtask/src/release_workspace.rs")
    if (
        '"bin/initdb.wasix.wasm"' not in asset_build_source
        or '"bin/pg_dump.wasix.wasm"' in asset_build_source
        or '"bin/psql.wasix.wasm"' in asset_build_source
        or 'object.remove("pg-dump");' not in asset_build_source
        or 'object.remove("psql");' not in asset_build_source
        or 'object.remove("pg-dump");' not in release_workspace_source
        or 'object.remove("psql");' not in release_workspace_source
        or "SPLIT_WASIX_TOOL_AOT_ARTIFACTS" not in release_workspace_source
        or '"pg-dump":null' in asset_build_source
        or '"psql":null' in asset_build_source
    ):
        fail("WASIX root runtime asset crate must carry postgres/initdb runtime assets and omit split pg_dump/psql manifest entries")
    tools_build_source = read_text("src/runtimes/liboliphaunt/wasix/crates/tools/build.rs")
    if (
        '"bin/pg_dump.wasix.wasm"' not in tools_build_source
        or '"bin/psql.wasix.wasm"' not in tools_build_source
        or "pg_ctl" in tools_build_source
    ):
        fail("WASIX tools asset crate must package pg_dump and psql only; pg_ctl is intentionally absent")
    wasix_packager_source = read_text("tools/release/package_liboliphaunt_wasix_cargo_artifacts.mjs")
    if (
        wasix_core_runtime_archive_files()
        != ("oliphaunt/bin/initdb", "oliphaunt/bin/postgres")
        or wasix_tools_payload_files()
        != ("bin/pg_dump.wasix.wasm", "bin/psql.wasix.wasm")
        or wasix_forbidden_runtime_archive_tool_files()
        != ("oliphaunt/bin/pg_ctl", "oliphaunt/bin/pg_dump", "oliphaunt/bin/psql")
        or wasix_tools_aot_artifacts()
        != {"tool:pg_dump", "tool:psql"}
        or "splitRuntimeToolsPayload" not in wasix_packager_source
        or "splitAotToolsPayload" not in wasix_packager_source
        or "import product_metadata" in wasix_packager_source
        or "product_metadata." in wasix_packager_source
        or 'from "./wasix-cargo-artifact-contract.mjs"' not in wasix_packager_source
        or "wasixExtensionPackageName" not in wasix_packager_source
        or "wasixExtensionAotPackageName" not in wasix_packager_source
        or "currentProductVersionSync(PRODUCT" not in wasix_packager_source
        or 'text.replace(/^publish = false\\n?/gmu, "")' not in wasix_packager_source
    ):
        fail("WASIX Cargo artifact packager must read the Bun WASIX artifact contract, split pg_dump/psql into publishable tools crates, and keep only postgres/initdb in root runtime crates")
    wasix_dependency_invariant_source = read_text("tools/policy/check-wasix-release-dependency-invariants.mjs")
    if (
        "SOURCE_TEMPLATE_TOOLS_MANIFEST" not in wasix_dependency_invariant_source
        or "SOURCE_TEMPLATE_TOOLS_AOT_MANIFESTS_DIR" not in wasix_dependency_invariant_source
        or "oliphaunt-wasix-tools-aot-" not in wasix_dependency_invariant_source
    ):
        fail("WASIX release dependency invariants must cover oliphaunt-wasix-tools and tools-AOT artifact crates")
    if (
        'name = "oliphaunt-wasix-dump"\npath = "src/bin/oliphaunt_wasix_dump.rs"\nrequired-features = ["tools"]'
        not in read_text("src/bindings/wasix-rust/crates/oliphaunt-wasix/Cargo.toml")
    ):
        fail("oliphaunt-wasix-dump must require the tools feature at Cargo install/build time")
    native_packager_source = read_text("tools/release/package-liboliphaunt-cargo-artifacts.mjs")
    native_optimizer_source = read_text("tools/release/optimize_native_runtime_payload.mjs")
    native_linux_packager_source = read_text("tools/release/package-liboliphaunt-linux-assets.sh")
    native_macos_packager_source = read_text("tools/release/package-liboliphaunt-macos-assets.sh")
    native_windows_packager_source = read_text("tools/release/package-liboliphaunt-windows-assets.ps1")
    native_build_source = read_text("src/sdks/rust/crates/oliphaunt-build/src/lib.rs")
    if (
        NATIVE_RUNTIME_TOOL_STEMS != ("initdb", "pg_ctl", "postgres")
        or NATIVE_TOOLS_TOOL_STEMS != ("pg_dump", "psql")
        or "native-runtime-payload-policy.json" not in native_optimizer_source
        or "--exclude '/bin/pg_dump'" not in native_linux_packager_source
        or "--exclude '/bin/psql'" not in native_linux_packager_source
        or "--exclude '/bin/pg_dump'" not in native_macos_packager_source
        or "--exclude '/bin/psql'" not in native_macos_packager_source
        or 'Remove-Item -Force (Join-Path (Join-Path $Stage "runtime/bin") $Tool)' not in native_windows_packager_source
        or "missing oliphaunt-tools native release asset" not in native_packager_source
        or "extractArchive(toolsArchive, toolsRoot)" not in native_packager_source
        or "validateToolsTargetPair" not in native_packager_source
        or "writeToolsFacadeCrate" not in native_packager_source
        or 'toolSet: "runtime"' not in native_packager_source
        or 'toolSet: "tools"' not in native_packager_source
        or "packageBase: TOOLS_PRODUCT" not in native_packager_source
        or "artifactProduct: TOOLS_PRODUCT" not in native_packager_source
        or 'native_tool_paths(&self.target, &["postgres", "initdb", "pg_ctl"])'
        not in native_build_source
        or 'native_tool_paths(&self.target, &["pg_dump", "psql"])' not in native_build_source
        or "artifact_manifest_accepts_windows_native_split_payloads" not in native_build_source
    ):
        fail("Native Cargo artifact packager must split pg_dump/psql into oliphaunt-tools crates while keeping postgres/initdb/pg_ctl in root runtime crates")
    sdk_lib_source = read_text("src/bindings/wasix-rust/crates/oliphaunt-wasix/src/lib.rs")
    sdk_server_source = read_text("src/bindings/wasix-rust/crates/oliphaunt-wasix/src/oliphaunt/server.rs")
    sdk_pg_dump_source = read_text("src/bindings/wasix-rust/crates/oliphaunt-wasix/src/oliphaunt/pg_dump.rs")
    oliphaunt_build_source = native_build_source
    if (
        "pub fn preflight_wasix_tools() -> Result<()>" not in sdk_pg_dump_source
        or "pub fn preflight_tools(&self) -> Result<()>" not in sdk_server_source
        or "preflight_wasix_tools" not in sdk_lib_source
        or "load_pg_dump_module(&engine)" not in sdk_pg_dump_source
        or "load_psql_module(&engine)" not in sdk_pg_dump_source
    ):
        fail("oliphaunt-wasix must expose an explicit split pg_dump/psql tools preflight that validates payload and AOT artifacts")
    if (
        "fn oliphaunt_wasix_tools_enabled(&self) -> bool" not in oliphaunt_build_source
        or 'dependencies_enable_feature(&self.dependencies, "oliphaunt-wasix", "tools")' not in oliphaunt_build_source
        or "wasix_runtime_without_tools_stages_root_runtime_only" not in oliphaunt_build_source
        or "wasix_runtime_with_tools_feature_stages_split_tools" not in oliphaunt_build_source
    ):
        fail("oliphaunt-build must stage WASIX pg_dump/psql tools artifacts only when the app opts into the oliphaunt-wasix tools feature")
    release_check_source = read_text("src/bindings/wasix-rust/tools/check-release.sh")
    wasix_rust_moon_source = read_text("src/bindings/wasix-rust/moon.yml")
    if (
        "OLIPHAUNT_WASM_AOT_VERIFY=full" not in release_check_source
        or "preflight_wasix_tools_loads_split_artifacts" not in release_check_source
        or "--no-run" in release_check_source
        or 'command: "bash src/bindings/wasix-rust/tools/check-release.sh"' not in wasix_rust_moon_source
        or 'liboliphaunt-wasix:runtime-aot' not in wasix_rust_moon_source
        or '"/target/oliphaunt-wasix/aot/**/*"' not in wasix_rust_moon_source
    ):
        fail("oliphaunt-wasix-rust release-check must run the split tools preflight against release-shaped WASIX AOT artifacts")
    sdk_aot_source = read_text("src/bindings/wasix-rust/crates/oliphaunt-wasix/src/oliphaunt/aot.rs")
    if "missing package-manager-resolved AOT manifest for selected extension" not in sdk_aot_source:
        fail("oliphaunt-wasix must fail when a selected extension AOT manifest is missing for the target")
    aot_source = read_text("src/bindings/wasix-rust/crates/oliphaunt-wasix/src/oliphaunt/aot.rs")
    for cfg in expected_aot_dependencies:
        rust_cfg = cfg.removeprefix("cfg(").removesuffix(")")
        if rust_cfg not in aot_source:
            fail(
                "oliphaunt-wasix Rust AOT cfgs must match Cargo target dependency cfgs; "
                f"missing {rust_cfg}"
            )
    package = manifest.get("package", {})
    build_source = read_text("src/bindings/wasix-rust/crates/oliphaunt-wasix/build.rs")
    if (
        not isinstance(package, dict)
        or package.get("links") != "oliphaunt_artifact_wasix_relay"
        or package.get("build") != "build.rs"
        or "DEP_OLIPHAUNT_ARTIFACT_" not in build_source
        or "cargo::metadata=" not in build_source
    ):
        fail("oliphaunt-wasix must relay WASIX Cargo artifact manifests through a Cargo links build script")
    runtime_config = product_config("liboliphaunt-wasix")
    publish_targets = string_list(runtime_config, "publish_targets", "liboliphaunt-wasix")
    if publish_targets != ["github-release-assets", "crates-io"]:
        fail("liboliphaunt-wasix must publish GitHub release assets and crates.io WASIX artifact crates")
    registry_packages = set(string_list(runtime_config, "registry_packages", "liboliphaunt-wasix"))
    expected_registry_packages = {
        f"crates:{name}"
        for name in wasix_public_cargo_package_names()
    }
    if registry_packages != expected_registry_packages:
        fail(
            "liboliphaunt-wasix crates.io registry packages must match public WASIX runtime, tools, AOT, and ICU data artifact crates: "
            + ", ".join(sorted(registry_packages))
        )
    features = manifest.get("features", {})
    if "bundled" in features:
        fail("oliphaunt-wasix must remove the inert bundled feature before the WASIX Rust binding is release-ready")
    for path in [
        "src/bindings/wasix-rust/crates/oliphaunt-wasix/README.md",
        "src/docs/content/sdk/wasm/guide.mdx",
        "src/docs/content/sdk/wasm/runtime.mdx",
        "src/docs/content/sdk/wasm/index.mdx",
        "src/bindings/wasix-rust/crates/oliphaunt-wasix/src/lib.rs",
        "src/bindings/wasix-rust/crates/oliphaunt-wasix/src/oliphaunt/base.rs",
        "src/bindings/wasix-rust/crates/oliphaunt-wasix/src/oliphaunt/aot.rs",
    ]:
        for forbidden in [
            "OLIPHAUNT_WASM_RUNTIME_ARCHIVE",
            "OLIPHAUNT_WASM_AOT_ARCHIVE",
            "OLIPHAUNT_WASM_AOT_DIR",
        ]:
            reject_text(
                path,
                forbidden,
                "WASIX runtime artifact selection must use generated package manifests instead of public archive environment variables",
            )


def main() -> int:
    validate_graph_files()
    validate_exact_extension_registry_shape()
    validate_publish_target_coverage()
    validate_release_setup_docs()
    validate_local_registry_publisher()

    versions = {
        product: read_current_version(product)
        for product in product_ids()
    }
    for product, version in versions.items():
        stable_version(version, product)

    validate_rust()
    validate_broker()
    validate_swift(versions["oliphaunt-swift"], versions["liboliphaunt-native"])
    validate_kotlin(versions["oliphaunt-kotlin"], versions["liboliphaunt-native"])
    validate_react_native(
        versions["oliphaunt-react-native"],
        versions["oliphaunt-swift"],
        versions["oliphaunt-kotlin"],
    )
    validate_typescript(
        versions["oliphaunt-js"],
        versions["liboliphaunt-native"],
        versions["oliphaunt-broker"],
        versions["oliphaunt-node-direct"],
    )
    validate_node_direct(versions["oliphaunt-node-direct"], versions["liboliphaunt-native"])
    validate_wasm(versions["liboliphaunt-wasix"], versions["oliphaunt-wasix-rust"])

    print("release metadata checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
