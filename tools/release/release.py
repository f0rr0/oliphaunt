#!/usr/bin/env python3
"""Single public release CLI for Oliphaunt product releases."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tarfile
import time
import zipfile
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path, PurePosixPath
from types import SimpleNamespace
from typing import Any, Iterable, NoReturn


ROOT = Path(__file__).resolve().parents[2]
EXTENSION_PRODUCT_PREFIX = "oliphaunt-extension-"
NODE_DIRECT_PACKAGE_ROOT = ROOT / "src/runtimes/node-direct/packages"
REGISTRY_PUBLICATION_CHECK = [
    "tools/dev/bun.sh",
    "tools/release/check_registry_publication.mjs",
]
NATIVE_PAYLOAD_POLICY = json.loads(
    (ROOT / "tools/release/native-runtime-payload-policy.json").read_text(encoding="utf-8")
)
NATIVE_RUNTIME_TOOL_STEMS = tuple(NATIVE_PAYLOAD_POLICY["nativeRuntimeToolStems"])
NATIVE_TOOLS_TOOL_STEMS = tuple(NATIVE_PAYLOAD_POLICY["nativeToolsToolStems"])
NATIVE_PACKAGED_TOOL_STEMS = (*NATIVE_RUNTIME_TOOL_STEMS, *NATIVE_TOOLS_TOOL_STEMS)
LIBOLIPHAUNT_NATIVE_CARGO_PRODUCT = "liboliphaunt-native"
LIBOLIPHAUNT_TOOLS_PRODUCT = "oliphaunt-tools"
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


def liboliphaunt_cargo_package_name(target_id: str, package_base: str = LIBOLIPHAUNT_NATIVE_CARGO_PRODUCT) -> str:
    return f"{package_base}-{target_id}"


def fail(message: str) -> NoReturn:
    print(f"release.py: {message}", file=sys.stderr)
    raise SystemExit(2)


def run(args: list[str], *, cwd: Path = ROOT, env: dict[str, str] | None = None) -> None:
    print("\n==> " + " ".join(args), flush=True)
    result = subprocess.run(args, cwd=cwd, env=env, check=False)
    if result.returncode != 0:
        raise SystemExit(result.returncode)


def bun_json(args: list[str]) -> object:
    output = subprocess.check_output(["tools/dev/bun.sh", *args], cwd=ROOT, text=True)
    return json.loads(output)


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
    return json.loads(output)


@lru_cache(maxsize=None)
def release_graph_rows(command: str, args: tuple[str, ...] = ()) -> tuple[dict[str, Any], ...]:
    rows = release_graph_json(command, args)
    if not isinstance(rows, list) or not all(isinstance(row, dict) for row in rows):
        fail(f"release graph {command} query must return a JSON object list")
    return tuple(rows)


@lru_cache(maxsize=None)
def product_config_rows(product: str | None = None) -> tuple[dict[str, Any], ...]:
    args = () if product is None else ("--product", product)
    rows = release_graph_rows("product-configs", args)
    if product is not None and len(rows) != 1:
        fail(f"release graph product-configs query must return one row for {product}, got {len(rows)}")
    seen: set[str] = set()
    parsed: list[dict[str, Any]] = []
    for row in rows:
        product_id = row.get("product")
        config_id = row.get("id")
        if not isinstance(product_id, str) or not product_id:
            fail("release graph product-configs rows must declare a non-empty product")
        if product_id in seen:
            fail(f"release graph product-configs query returned duplicate product {product_id}")
        seen.add(product_id)
        if config_id != product_id:
            fail(f"release graph product-configs {product_id}.id must match the product id")
        for key in ["kind", "owner", "path", "changelog_path", "tag_prefix"]:
            value = row.get(key)
            if not isinstance(value, str) or not value:
                fail(f"release graph product-configs {product_id}.{key} must be a non-empty string")
        for key in ["publish_targets", "release_artifacts", "version_files"]:
            value = row.get(key)
            if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
                fail(f"release graph product-configs {product_id}.{key} must be a string list")
            if not value:
                fail(f"release graph product-configs {product_id}.{key} must not be empty")
        for key in ["registry_packages", "derived_version_files"]:
            value = row.get(key)
            if value is None:
                row[key] = []
                continue
            if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
                fail(f"release graph product-configs {product_id}.{key} must be a string list")
        parsed.append(dict(row))
    if not parsed:
        fail("release graph returned no product config rows")
    return tuple(parsed)


def product_config(product: str) -> dict[str, Any]:
    row = dict(product_config_rows(product)[0])
    row.pop("product", None)
    return row


def product_ids() -> list[str]:
    return [str(row["product"]) for row in product_config_rows()]


def package_path(product: str) -> str:
    value = product_config(product).get("path")
    if not isinstance(value, str) or not value:
        fail(f"release graph product {product!r} must declare a package path")
    return value


def tag_prefix(product: str) -> str:
    value = product_config(product).get("tag_prefix")
    if not isinstance(value, str) or not value:
        fail(f"release graph product {product}.tag_prefix must be a non-empty string")
    return value


@lru_cache(maxsize=1)
def product_version_rows() -> tuple[dict[str, Any], ...]:
    return release_graph_rows("product-versions")


def read_current_version(product: str) -> str:
    matches = [row for row in product_version_rows() if row.get("product") == product]
    if len(matches) != 1:
        fail(f"release graph product-versions query must return one row for {product}, got {len(matches)}")
    version = matches[0].get("version")
    if not isinstance(version, str) or not version:
        fail(f"release graph product-versions {product}.version must be a non-empty string")
    return version


@lru_cache(maxsize=None)
def publish_step_target_coverage_rows(product: str | None = None) -> tuple[dict[str, Any], ...]:
    args = () if product is None else ("--product", product)
    rows = release_graph_rows("publish-step-target-coverage", args)
    seen: set[tuple[str, str]] = set()
    parsed: list[dict[str, Any]] = []
    for row in rows:
        product_id = row.get("product")
        step = row.get("step")
        publish_targets = row.get("publishTargets")
        extension = row.get("extension")
        if not isinstance(product_id, str) or not product_id:
            fail("release graph publish-step-target-coverage rows must declare a non-empty product")
        if product is not None and product_id != product:
            fail(f"release graph publish-step-target-coverage returned row for {product_id}, expected {product}")
        if not isinstance(step, str) or not step:
            fail(f"release graph publish-step-target-coverage {product_id}.step must be a non-empty string")
        if not isinstance(publish_targets, list) or not publish_targets or not all(
            isinstance(item, str) and item for item in publish_targets
        ):
            fail(
                f"release graph publish-step-target-coverage {product_id}.{step}.publishTargets "
                "must be a non-empty string list"
            )
        if not isinstance(extension, bool):
            fail(f"release graph publish-step-target-coverage {product_id}.{step}.extension must be true or false")
        key = (product_id, step)
        if key in seen:
            fail(f"release graph publish-step-target-coverage returned duplicate row for {product_id}.{step}")
        seen.add(key)
        parsed.append(dict(row))
    return tuple(parsed)


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


def artifact_target_from_row(row: dict[str, Any]) -> ArtifactTarget:
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


def artifact_targets(
    *,
    product: str | None = None,
    kind: str | None = None,
    surface: str | None = None,
    published_only: bool = False,
) -> list[ArtifactTarget]:
    args: list[str] = []
    if product is not None:
        args.extend(["--product", product])
    if kind is not None:
        args.extend(["--kind", kind])
    if surface is not None:
        args.extend(["--surface", surface])
    if published_only:
        args.append("--published-only")
    return [artifact_target_from_row(row) for row in release_graph_rows("artifact-targets", tuple(args))]


@lru_cache(maxsize=1)
def wasix_cargo_artifact_contract() -> dict[str, Any]:
    value = release_graph_json("wasix-cargo-artifact-contract")
    if not isinstance(value, dict):
        fail("release graph wasix-cargo-artifact-contract query must return a JSON object")
    return value


def wasix_contract_string(key: str) -> str:
    value = wasix_cargo_artifact_contract().get(key)
    if not isinstance(value, str) or not value:
        fail(f"WASIX Cargo artifact contract {key} must be a non-empty string")
    return value


def wasix_contract_string_list(key: str) -> tuple[str, ...]:
    value = wasix_cargo_artifact_contract().get(key)
    if not isinstance(value, list) or not all(isinstance(item, str) and item for item in value):
        fail(f"WASIX Cargo artifact contract {key} must be a string list")
    return tuple(value)


def wasix_cargo_artifact_schema() -> str:
    return wasix_contract_string("schema")


def wasix_public_cargo_package_names() -> tuple[str, ...]:
    return wasix_contract_string_list("publicCargoPackageNames")


@lru_cache(maxsize=None)
def expected_asset_rows(
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
    return release_graph_rows("expected-assets", tuple(args))


def expected_assets(
    product: str,
    version: str,
    *,
    surface: str = "github-release",
    published_only: bool = True,
    kinds: Iterable[str] | None = None,
) -> list[str]:
    kind_tuple = None if kinds is None else tuple(sorted(set(kinds)))
    names: list[str] = []
    for row in expected_asset_rows(product, version, surface, published_only, kind_tuple):
        asset_name = row.get("assetName")
        artifact_target = row.get("artifactTarget")
        row_product = row.get("product")
        kind = row.get("kind")
        if not isinstance(asset_name, str) or not asset_name:
            fail(f"release graph expected-assets {product}/{surface} assetName must be a non-empty string")
        if not isinstance(artifact_target, str) or not artifact_target:
            fail(f"release graph expected-assets {asset_name}.artifactTarget must be a non-empty string")
        if not isinstance(row_product, str) or not row_product:
            fail(f"release graph expected-assets {asset_name}.product must be a non-empty string")
        if not isinstance(kind, str) or not kind:
            fail(f"release graph expected-assets {asset_name}.kind must be a non-empty string")
        names.append(asset_name)
    if len(names) != len(set(names)):
        fail(f"release graph expected-assets returned duplicate names for {product}/{surface}")
    if not names:
        fail(f"release graph returned no expected assets for {product}/{surface}")
    return sorted(names)


@lru_cache(maxsize=None)
def registry_package_rows(product: str, package_kind: str | None = None) -> tuple[dict[str, Any], ...]:
    args = ["--product", product]
    if package_kind is not None:
        args.extend(["--kind", package_kind])
    return release_graph_rows("registry-packages", tuple(args))


def registry_package_names(product: str, package_kind: str) -> list[str]:
    names: list[str] = []
    for row in registry_package_rows(product, package_kind):
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
        fail(f"{product} declares duplicate {package_kind} registry packages: " + ", ".join(duplicates))
    return names


@lru_cache(maxsize=1)
def extension_metadata_rows() -> tuple[dict[str, Any], ...]:
    return release_graph_rows("extension-metadata")


def extension_metadata_row(product: str) -> dict[str, Any]:
    matches = [row for row in extension_metadata_rows() if row.get("product") == product]
    if len(matches) != 1:
        fail(f"release graph extension-metadata query must return one row for {product}, got {len(matches)}")
    return dict(matches[0])


def extension_metadata_string(row: dict[str, Any], key: str, product: str) -> str:
    value = row.get(key)
    if not isinstance(value, str) or not value:
        fail(f"extension-metadata {product}.{key} must be a non-empty string")
    return value


def extension_metadata_object(row: dict[str, Any], key: str, product: str) -> dict[str, Any]:
    value = row.get(key)
    if not isinstance(value, dict):
        fail(f"extension-metadata {product}.{key} must be an object")
    return dict(value)


def release_extension_metadata(product: str) -> dict[str, Any]:
    row = extension_metadata_row(product)
    compatibility = extension_metadata_object(row, "compatibility", product)
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
        "sqlName": extension_metadata_string(row, "sqlName", product),
        "class": extension_metadata_string(row, "class", product),
        "versioning": extension_metadata_string(row, "versioning", product),
        "sourcePath": extension_metadata_string(row, "sourcePath", product),
        "compatibility": compatibility,
    }


def release_extension_source_identity(product: str) -> dict[str, Any]:
    return extension_metadata_object(extension_metadata_row(product), "sourceIdentity", product)


def extension_product_ids() -> list[str]:
    products: list[str] = []
    for row in extension_metadata_rows():
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
    return tuple(SimpleNamespace(**row) for row in release_graph_rows("extension-targets", tuple(args)))


def is_windows_native_target(target: str | None, runtime_dir: Path | None = None) -> bool:
    if target is not None and target.startswith("windows-"):
        return True
    if runtime_dir is None:
        return False
    bin_dir = runtime_dir / "bin"
    return any((bin_dir / f"{stem}.exe").exists() for stem in NATIVE_PACKAGED_TOOL_STEMS)


def required_native_runtime_tools(target: str | None, runtime_dir: Path | None = None) -> tuple[str, ...]:
    if is_windows_native_target(target, runtime_dir):
        return tuple(f"{stem}.exe" for stem in NATIVE_RUNTIME_TOOL_STEMS)
    return NATIVE_RUNTIME_TOOL_STEMS


def required_native_tools_package_tools(
    target: str | None,
    runtime_dir: Path | None = None,
) -> tuple[str, ...]:
    if is_windows_native_target(target, runtime_dir):
        return tuple(f"{stem}.exe" for stem in NATIVE_TOOLS_TOOL_STEMS)
    return NATIVE_TOOLS_TOOL_STEMS


def required_runtime_member_paths(target: str | None, *, prefix: str) -> list[str]:
    return [f"{prefix.rstrip('/')}/{tool}" for tool in required_native_runtime_tools(target)]


def required_tools_member_paths(target: str | None, *, prefix: str) -> list[str]:
    return [f"{prefix.rstrip('/')}/{tool}" for tool in required_native_tools_package_tools(target)]


def run_native_payload_optimizer(root: Path, target: str, *, tool_set: str) -> None:
    run(
        [
            "tools/dev/bun.sh",
            "tools/release/optimize_native_runtime_payload.mjs",
            str(root),
            "--target",
            target,
            "--tool-set",
            tool_set,
        ]
    )


def output(args: list[str], *, cwd: Path = ROOT) -> str:
    return subprocess.check_output(args, cwd=cwd, text=True).strip()


def succeeds(args: list[str], *, cwd: Path = ROOT) -> bool:
    result = subprocess.run(args, cwd=cwd, text=True, capture_output=True, check=False)
    return result.returncode == 0


def registry_check_args(*args: str) -> list[str]:
    return [*REGISTRY_PUBLICATION_CHECK, *args]


def registry_check_json(*args: str) -> dict:
    value = json.loads(output(registry_check_args(*args)))
    if not isinstance(value, dict):
        fail("registry publication helper did not return a JSON object")
    return value


def cratesio_product_crates(product: str) -> list[str]:
    value = registry_check_json("product-crates", "--product", product)
    crates = value.get("crates")
    if not isinstance(crates, list) or not all(isinstance(crate, str) for crate in crates):
        fail(f"registry publication helper returned invalid crates for {product}")
    return crates


def cratesio_crate_version_exists(crate: str, version: str) -> bool:
    value = registry_check_json(
        "crate-version-exists",
        "--crate",
        crate,
        "--version",
        version,
    )
    exists = value.get("exists")
    if not isinstance(exists, bool):
        fail(f"registry publication helper returned invalid crates.io status for {crate} {version}")
    return exists


def pnpm_pack_for_npm_publish(package_dir: Path) -> Path:
    """Pack with pnpm so workspace: dependency specs become publishable versions."""

    package = json.loads((package_dir / "package.json").read_text(encoding="utf-8"))
    package_name = package.get("name")
    package_version = package.get("version")
    if not isinstance(package_name, str) or not package_name:
        fail(f"{package_dir.relative_to(ROOT)}/package.json must declare a package name")
    if not isinstance(package_version, str) or not package_version:
        fail(f"{package_dir.relative_to(ROOT)}/package.json must declare a package version")
    safe_name = package_name.replace("@", "").replace("/", "-")
    pack_dir = ROOT / "target" / "release" / "npm-packages" / safe_name
    shutil.rmtree(pack_dir, ignore_errors=True)
    pack_dir.mkdir(parents=True, exist_ok=True)
    rendered = output(
        ["pnpm", "pack", "--pack-destination", str(pack_dir), "--json"],
        cwd=package_dir,
    )
    try:
        manifest = json.loads(rendered)
    except json.JSONDecodeError as error:
        fail(f"pnpm pack for {package_name} did not emit JSON: {error}")
    filename = manifest.get("filename") if isinstance(manifest, dict) else None
    if not isinstance(filename, str) or not filename.endswith(".tgz"):
        fail(f"pnpm pack for {package_name} did not report a .tgz filename")
    tarball = pack_dir / filename
    if not tarball.is_file():
        fail(f"pnpm pack for {package_name} did not create {tarball.relative_to(ROOT)}")
    return tarball


def sdk_artifact_dir(product: str) -> Path:
    return ROOT / "target" / "sdk-artifacts" / product


def require_staged_sdk_artifact(product: str, description: str, suffixes: tuple[str, ...]) -> list[Path]:
    directory = sdk_artifact_dir(product)
    matches = sorted(
        path
        for path in directory.glob("*")
        if path.is_file() and path.name != "artifacts.txt" and path.suffix in suffixes
    )
    if not matches:
        fail(
            f"{product} requires staged {description} artifact(s) under "
            f"{directory.relative_to(ROOT)}; download the CI workflow SDK package artifacts "
            "before release validation or publishing"
        )
    return matches


def staged_swift_release_artifacts() -> tuple[Path, Path, Path]:
    matches = require_staged_sdk_artifact("oliphaunt-swift", "Swift package", (".zip", ".release"))
    source_archives = [path for path in matches if path.name == "Oliphaunt-source.zip"]
    manifests = [path for path in matches if path.name == "Package.swift.release"]
    release_tree = sdk_artifact_dir("oliphaunt-swift") / "release-tree"
    if len(source_archives) != 1 or len(manifests) != 1:
        fail(
            "oliphaunt-swift release requires exactly one staged Oliphaunt-source.zip "
            "and one staged Package.swift.release under target/sdk-artifacts/oliphaunt-swift"
        )
    if not (release_tree / "generated/swiftpm/OliphauntICU/OliphauntICU.swift").is_file():
        fail(
            "oliphaunt-swift release requires staged SwiftPM release-tree files, including "
            "generated/swiftpm/OliphauntICU/OliphauntICU.swift"
        )
    manifest_text = manifests[0].read_text(encoding="utf-8")
    required_fragments = [
        "binaryTarget(",
        "liboliphaunt-native-v",
        "liboliphaunt-",
        "apple-spm-xcframework.zip",
        "checksum:",
    ]
    for fragment in required_fragments:
        if fragment not in manifest_text:
            fail(f"oliphaunt-swift staged Package.swift.release is missing {fragment!r}")
    return source_archives[0], manifests[0], release_tree


def prepare_staged_swift_release_manifest() -> Path:
    _source_archive, staged_manifest, staged_release_tree = staged_swift_release_artifacts()
    output_dir = ROOT / "target" / "oliphaunt-swift"
    release_tree = output_dir / "release-tree"
    shutil.rmtree(release_tree, ignore_errors=True)
    output_dir.mkdir(parents=True, exist_ok=True)
    shutil.copytree(staged_release_tree, release_tree)
    output_manifest = output_dir / "Package.swift.release"
    shutil.copy2(staged_manifest, output_manifest)
    return output_manifest


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def staged_cargo_crates(product: str) -> list[Path]:
    matches = require_staged_sdk_artifact(product, "Cargo package", (".crate",))
    names = [path.name for path in matches]
    if len(names) != len(set(names)):
        fail(f"{product} staged Cargo artifacts contain duplicate crate filenames: {names}")
    return matches


def verify_staged_cargo_crate_identity(
    product: str,
    package: str,
    version: str,
    *,
    allow_dirty: bool,
) -> None:
    expected_name = f"{package}-{version}.crate"
    matches = [path for path in staged_cargo_crates(product) if path.name == expected_name]
    if len(matches) != 1:
        staged_names = sorted(path.name for path in staged_cargo_crates(product))
        fail(
            f"{product} staged Cargo artifacts must contain exactly one {expected_name}; "
            f"staged={staged_names}"
        )
    staged = matches[0]
    print(f"validated staged Cargo crate identity: {product} -> {staged.relative_to(ROOT)}")


def verify_staged_cargo_product_crates(product: str, version: str, *, allow_dirty: bool) -> None:
    crates = cratesio_product_crates(product)
    for crate in crates:
        verify_staged_cargo_crate_identity(product, crate, version, allow_dirty=allow_dirty)
    staged_names = sorted(path.name for path in staged_cargo_crates(product))
    expected_names = sorted(f"{crate}-{version}.crate" for crate in crates)
    if staged_names != expected_names:
        fail(f"{product} staged Cargo artifacts mismatch: expected={expected_names}, staged={staged_names}")


def staged_npm_package_tarball(product: str) -> Path | None:
    matches = require_staged_sdk_artifact(product, "npm package", (".tgz",))
    if not matches:
        return None
    if len(matches) != 1:
        fail(f"{product} staged npm package artifacts must contain exactly one .tgz, got {len(matches)}")
    validate_staged_npm_package_tarball(product, matches[0])
    return matches[0]


def staged_kotlin_maven_repo() -> Path:
    root = sdk_artifact_dir("oliphaunt-kotlin") / "maven"
    if not root.is_dir():
        fail(
            "oliphaunt-kotlin requires staged Maven repository artifacts under "
            f"{root.relative_to(ROOT)}; download the CI workflow Kotlin SDK package artifacts "
            "before release validation or publishing"
        )
    version = current_product_version("oliphaunt-kotlin")
    required = [
        root / f"dev/oliphaunt/oliphaunt-android/{version}/oliphaunt-android-{version}.aar",
        root / f"dev/oliphaunt/oliphaunt-android/{version}/oliphaunt-android-{version}.pom",
        root / f"dev/oliphaunt/oliphaunt-android/{version}/oliphaunt-android-{version}.module",
        root / (
            f"dev/oliphaunt/oliphaunt-android-gradle-plugin/{version}/"
            f"oliphaunt-android-gradle-plugin-{version}.jar"
        ),
        root / (
            f"dev/oliphaunt/oliphaunt-android-gradle-plugin/{version}/"
            f"oliphaunt-android-gradle-plugin-{version}.pom"
        ),
        root / (
            f"dev/oliphaunt/oliphaunt-android-gradle-plugin/{version}/"
            f"oliphaunt-android-gradle-plugin-{version}.module"
        ),
        root / (
            f"dev/oliphaunt/android/dev.oliphaunt.android.gradle.plugin/{version}/"
            f"dev.oliphaunt.android.gradle.plugin-{version}.pom"
        ),
    ]
    missing = [path.relative_to(ROOT) for path in required if not path.is_file()]
    if missing:
        fail("oliphaunt-kotlin staged Maven repository is missing: " + ", ".join(str(path) for path in missing))
    for path in root.rglob("*"):
        if not path.is_file():
            continue
        relative = path.relative_to(root)
        if relative.parts[:2] != ("dev", "oliphaunt"):
            fail(f"oliphaunt-kotlin staged Maven repository contains unexpected path {path.relative_to(ROOT)}")
        if path.suffix in {".lastUpdated", ".lock"}:
            fail(f"oliphaunt-kotlin staged Maven repository contains local resolver state {path.relative_to(ROOT)}")
    print(f"validated staged Kotlin Maven repository: {root.relative_to(ROOT)}")
    return root


def json_contains_workspace_protocol(value: object) -> bool:
    if isinstance(value, str):
        return value.startswith("workspace:")
    if isinstance(value, list):
        return any(json_contains_workspace_protocol(item) for item in value)
    if isinstance(value, dict):
        return any(json_contains_workspace_protocol(item) for item in value.values())
    return False


def validate_staged_npm_package_tarball(product: str, tarball: Path) -> None:
    package_dir = ROOT / package_path(product)
    package_json = package_dir / "package.json"
    if not package_json.is_file():
        fail(f"{product} has no package.json at {package_json.relative_to(ROOT)}")
    source_package = json.loads(package_json.read_text(encoding="utf-8"))
    expected_name = source_package.get("name")
    expected_version = current_product_version(product)
    if not isinstance(expected_name, str) or not expected_name:
        fail(f"{package_json.relative_to(ROOT)} must declare a package name")
    expected_filename = f"{safe_npm_package_filename_prefix(expected_name)}-{expected_version}.tgz"
    if tarball.name != expected_filename:
        fail(f"{product} staged npm tarball must be named {expected_filename}, got {tarball.name}")

    try:
        with tarfile.open(tarball, "r:gz") as archive:
            names = set(archive.getnames())
            if "package/package.json" not in names:
                fail(f"{tarball.relative_to(ROOT)} is missing package/package.json")
            package_member = archive.extractfile("package/package.json")
            if package_member is None:
                fail(f"{tarball.relative_to(ROOT)} package/package.json could not be read")
            with package_member:
                packed_package = json.loads(package_member.read().decode("utf-8"))
            if packed_package.get("name") != expected_name:
                fail(
                    f"{tarball.relative_to(ROOT)} package name must be {expected_name}, "
                    f"got {packed_package.get('name')!r}"
                )
            if packed_package.get("version") != expected_version:
                fail(
                    f"{tarball.relative_to(ROOT)} package version must be {expected_version}, "
                    f"got {packed_package.get('version')!r}"
                )
            if json_contains_workspace_protocol(packed_package):
                fail(f"{tarball.relative_to(ROOT)} must not contain workspace: dependency specifiers")
            if not any(name.startswith("package/lib/") for name in names):
                fail(f"{tarball.relative_to(ROOT)} must contain built package/lib output")
    except (tarfile.TarError, json.JSONDecodeError, UnicodeDecodeError) as error:
        fail(f"{tarball.relative_to(ROOT)} is not a valid staged npm package tarball: {error}")


def staged_jsr_source_dir(product: str) -> Path | None:
    directory = sdk_artifact_dir(product) / "jsr-source"
    if not directory.is_dir():
        fail(
            f"{product} requires staged JSR source under {directory.relative_to(ROOT)}; "
            "download the CI workflow SDK package artifacts before release validation or publishing"
        )
    required = ["jsr.json", "package.json", "src"]
    missing = [name for name in required if not (directory / name).exists()]
    if missing:
        fail(f"{product} staged JSR source is missing: {', '.join(missing)}")
    return directory


def npm_publish_pnpm_packed_package(package_dir: Path, *, product: str | None = None) -> None:
    tarball = staged_npm_package_tarball(product) if product is not None else None
    if tarball is None:
        tarball = pnpm_pack_for_npm_publish(package_dir)
    run(["npm", "publish", str(tarball), "--access", "public", "--provenance"])


def xtask(args: list[str], *, quiet: bool = False) -> str:
    command = ["cargo", "run"]
    if quiet:
        command.append("--quiet")
    command.extend(["-p", "xtask", "--", *args])
    if quiet:
        return output(command)
    run(command)
    return ""


def cargo_publish_args(allow_dirty: bool) -> list[str]:
    return ["--allow-dirty"] if allow_dirty else []


def cargo_package_args(allow_dirty: bool) -> list[str]:
    return ["--allow-dirty"] if allow_dirty else []


def passthrough_value(args: list[str], name: str) -> str | None:
    index = 0
    while index < len(args):
        value = args[index]
        if value == name:
            if index + 1 >= len(args):
                fail(f"{name} requires a value")
            return args[index + 1]
        if value.startswith(f"{name}="):
            return value.split("=", 1)[1]
        index += 1
    return None


def selected_products_from_passthrough(args: list[str]) -> list[str]:
    raw = passthrough_value(args, "--products-json")
    if raw is None:
        return []
    value = json.loads(raw)
    if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
        fail("--products-json must be a JSON string list")
    known = set(product_ids())
    unknown = sorted(set(value) - known)
    if unknown:
        fail(f"unknown release products: {', '.join(unknown)}")
    ordered = bun_json(
        [
            "tools/release/release_graph_query.mjs",
            "release-order",
            "--products-json",
            json.dumps(value, separators=(",", ":")),
        ]
    )
    if not isinstance(ordered, list) or not all(isinstance(item, str) for item in ordered):
        fail("release graph query returned an invalid release order")
    return ordered


def product_tag(product: str) -> str:
    return f"{tag_prefix(product)}{read_current_version(product)}"


def is_extension_product(product: str) -> bool:
    return product.startswith(EXTENSION_PRODUCT_PREFIX)


def selected_extension_products(products: list[str]) -> list[str]:
    return sorted(product for product in products if is_extension_product(product))


def publish_step_target_coverage(product: str) -> dict[str, set[str]]:
    coverage: dict[str, set[str]] = {}
    for row in publish_step_target_coverage_rows(product):
        step = row["step"]
        publish_targets = row["publishTargets"]
        assert isinstance(step, str)
        assert isinstance(publish_targets, list)
        coverage[step] = set(publish_targets)
    return coverage


def supported_publish_targets(product: str) -> set[str]:
    covered: set[str] = set()
    for targets in publish_step_target_coverage(product).values():
        covered.update(targets)
    return covered


def extension_sql_name(product: str) -> str:
    config = product_config(product)
    value = config.get("extension_sql_name")
    if not isinstance(value, str) or not value:
        fail(f"{product} release metadata must declare extension_sql_name")
    return value


def broker_cargo_package_name(target_id: str) -> str:
    return f"oliphaunt-broker-{target_id}"


def current_product_version(product: str) -> str:
    return read_current_version(product)


def verify_release_tag(product: str, head_ref: str) -> None:
    run(["tools/release/verify_product_tag.mjs", product, "--target", head_ref])


def glob_release_assets(asset_dir: Path, suffixes: tuple[str, ...]) -> list[str]:
    if not asset_dir.is_dir():
        fail(f"release asset directory does not exist: {asset_dir.relative_to(ROOT)}")
    assets = sorted(
        path
        for path in asset_dir.iterdir()
        if path.is_file() and any(path.name.endswith(suffix) for suffix in suffixes)
    )
    if not assets:
        fail(f"no release assets found in {asset_dir.relative_to(ROOT)}")
    return [str(path.relative_to(ROOT)) for path in assets]


def upload_github_release_assets(product: str, *, tag: str | None = None, assets: list[str] | None = None) -> None:
    command = [
        "tools/dev/bun.sh",
        "tools/release/upload_github_release_assets.mjs",
        product,
        "--tag",
        tag or product_tag(product),
    ]
    for asset in assets or []:
        command.extend(["--asset", asset])
    run(command)


def npm_package_is_published(package_name: str, version: str) -> bool:
    result = subprocess.run(
        ["npm", "view", f"{package_name}@{version}", "version"],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
    )
    return result.returncode == 0 and result.stdout.strip() == version


def validate_no_consumer_install_scripts(package: dict, label: str) -> None:
    scripts = package.get("scripts", {})
    if not isinstance(scripts, dict):
        return
    forbidden = sorted({"preinstall", "install", "postinstall", "prepare"} & set(scripts))
    if forbidden:
        fail(f"{label} must not declare consumer install lifecycle scripts: {', '.join(forbidden)}")


def url_exists(url: str) -> bool:
    return succeeds(["curl", "-fsIL", "--retry", "3", "--connect-timeout", "10", url])


def git_commit(ref: str) -> str | None:
    result = subprocess.run(
        ["git", "rev-list", "-n", "1", ref],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
    )
    if result.returncode != 0:
        return None
    value = result.stdout.strip()
    return value or None


def product_tag_points_at(product: str, head_ref: str) -> bool:
    tag_commit = git_commit(product_tag(product))
    head_commit = git_commit(head_ref)
    return tag_commit is not None and head_commit is not None and tag_commit == head_commit


def product_registry_is_published(product: str) -> bool:
    return succeeds(
        registry_check_args(
            "--product",
            product,
            "--require-published",
        )
    )


def published_rerun(product: str, head_ref: str) -> bool:
    return product_tag_points_at(product, head_ref) and product_registry_is_published(product)


def wait_for_cratesio_package(crate: str, version: str, *, retries: int = 12, retry_delay: float = 10.0) -> None:
    for attempt in range(retries + 1):
        if cratesio_crate_version_exists(crate, version):
            return
        if attempt < retries:
            print(f"waiting for crates.io to index {crate} {version}...")
            time.sleep(retry_delay)
    fail(f"crates.io did not report {crate} {version} after publish")


def verify_generated_cratesio_packages_published(product: str, crates: list[str], version: str) -> None:
    generated_crates = sorted(set(crates))
    if not generated_crates:
        fail(f"{product} generated no Cargo artifact crates to verify")
    for crate in generated_crates:
        wait_for_cratesio_package(crate, version)
    print(
        f"{product} generated Cargo artifact publication verified: "
        + ", ".join(generated_crates)
    )


def cargo_publish_package(package: str, version: str, *, allow_dirty: bool = False) -> None:
    if cratesio_crate_version_exists(package, version):
        print(f"{package} {version} is already published on crates.io; skipping cargo publish.")
        return
    run(
        [
            "cargo",
            "publish",
            "-p",
            package,
            "--locked",
            *cargo_publish_args(allow_dirty),
        ]
    )
    wait_for_cratesio_package(package, version)


def cargo_publish_manifest(package: str, version: str, manifest_path: Path, *, allow_dirty: bool = False) -> None:
    if cratesio_crate_version_exists(package, version):
        print(f"{package} {version} is already published on crates.io; skipping cargo publish.")
        return
    run(
        [
            "cargo",
            "publish",
            "--manifest-path",
            str(manifest_path),
            "--target-dir",
            str(ROOT / "target" / "release" / "cargo-publish"),
            *cargo_publish_args(allow_dirty),
        ]
    )
    wait_for_cratesio_package(package, version)


def cargo_registry_packages(product: str) -> list[str]:
    return sorted(registry_package_names(product, "crates"))


def maven_pom_url(coordinate: str, version: str) -> str:
    group_id, separator, artifact_id = coordinate.partition(":")
    if not separator or not group_id or not artifact_id:
        fail(f"invalid Maven coordinate {coordinate!r}; expected group:artifact")
    group_path = group_id.replace(".", "/")
    return (
        f"https://repo1.maven.org/maven2/{group_path}/{artifact_id}/"
        f"{version}/{artifact_id}-{version}.pom"
    )


def rust_artifact_cargo_target_cfg(target: ArtifactTarget) -> str:
    if target.target == "linux-arm64-gnu":
        return 'all(target_os = "linux", target_arch = "aarch64", target_env = "gnu")'
    if target.target == "linux-x64-gnu":
        return 'all(target_os = "linux", target_arch = "x86_64", target_env = "gnu")'
    if target.target == "macos-arm64":
        return 'all(target_os = "macos", target_arch = "aarch64")'
    if target.target == "windows-x64-msvc":
        return 'all(target_os = "windows", target_arch = "x86_64", target_env = "msvc")'
    fail(f"unsupported Cargo target cfg for {target.id}")


def render_oliphaunt_release_cargo_toml(source: str, native_version: str, broker_version: str) -> str:
    text = source.replace(
        "repository.workspace = true",
        'repository = "https://github.com/f0rr0/oliphaunt"',
    ).replace(
        "homepage.workspace = true",
        'homepage = "https://oliphaunt.dev"',
    )
    if "[workspace]" not in text:
        text = text.rstrip() + "\n\n[workspace]\n"
    lines = [
        "",
        "# Generated for crates.io publishing. Source checkouts keep native runtime",
        "# and broker artifact crates out of the local dependency graph until those",
        "# artifacts are published and indexed.",
    ]
    target_dependencies: dict[str, list[str]] = {}
    for target in artifact_targets(
        product="liboliphaunt-native",
        kind="native-runtime",
        surface="rust-native-direct",
        published_only=True,
    ):
        crate = liboliphaunt_cargo_package_name(target.target)
        tools_facade = LIBOLIPHAUNT_TOOLS_PRODUCT
        cfg = rust_artifact_cargo_target_cfg(target)
        target_dependencies.setdefault(cfg, []).append(f'{crate} = {{ version = "={native_version}" }}')
        target_dependencies.setdefault(cfg, []).append(f'{tools_facade} = {{ version = "={native_version}" }}')
    for target in artifact_targets(
        product="oliphaunt-broker",
        kind="broker-helper",
        surface="rust-broker",
        published_only=True,
    ):
        crate = broker_cargo_package_name(target.target)
        cfg = rust_artifact_cargo_target_cfg(target)
        target_dependencies.setdefault(cfg, []).append(f'{crate} = {{ version = "={broker_version}" }}')
    for cfg in sorted(target_dependencies):
        lines.extend(
            [
                "",
                f"[target.'cfg({cfg})'.dependencies]",
                *sorted(target_dependencies[cfg]),
            ]
        )
    return text.rstrip() + "\n" + "\n".join(lines) + "\n"


def validate_generated_oliphaunt_release_artifact_coverage(manifest_path: Path) -> None:
    manifest = manifest_path.read_text(encoding="utf-8")
    broker_crates = cargo_registry_packages("oliphaunt-broker")
    missing_broker = [crate for crate in broker_crates if f"{crate} = " not in manifest]
    if missing_broker:
        fail(
            "generated oliphaunt release source is missing broker Cargo artifact dependencies: "
            + ", ".join(missing_broker)
        )

    native_version = current_product_version("liboliphaunt-native")
    native_targets = artifact_targets(
        product="liboliphaunt-native",
        kind="native-runtime",
        surface="rust-native-direct",
        published_only=True,
    )
    native_runtime_crates = {
        liboliphaunt_cargo_package_name(target.target)
        for target in native_targets
    }
    native_crates = set(cargo_registry_packages("liboliphaunt-native"))
    if not native_crates:
        target_names = ", ".join(target.target for target in native_targets)
        fail(
            "oliphaunt-rust cannot publish a working native Cargo consumer path: "
            "oliphaunt-build requires Cargo-resolved liboliphaunt-native native-runtime "
            f"artifacts for {target_names}, but liboliphaunt-native declares no crates.io "
            "artifact packages. Split/size native runtime artifacts into crates.io-sized "
            "packages before publishing oliphaunt-rust."
        )
    tools_facade = LIBOLIPHAUNT_TOOLS_PRODUCT
    missing_native = sorted(
        crate for crate in native_runtime_crates if f'{crate} = {{ version = "={native_version}" }}' not in manifest
    )
    if missing_native:
        fail(
            "generated oliphaunt release source is missing native runtime Cargo artifact dependencies: "
            + ", ".join(missing_native)
        )
    if f'{tools_facade} = {{ version = "={native_version}" }}' not in manifest:
        fail(f"generated oliphaunt release source is missing native tools facade dependency {tools_facade}")
    direct_tool_deps = sorted(
        crate
        for crate in native_crates
        if crate.startswith(f"{tools_facade}-") and f"{crate} = " in manifest
    )
    if direct_tool_deps:
        fail(
            "generated oliphaunt release source must depend on oliphaunt-tools, not target tools crates: "
            + ", ".join(direct_tool_deps)
        )


def render_oliphaunt_wasix_release_cargo_toml(source: str, runtime_version: str) -> str:
    text = source.replace(
        "repository.workspace = true",
        'repository = "https://github.com/f0rr0/oliphaunt"',
    ).replace(
        "homepage.workspace = true",
        'homepage = "https://oliphaunt.dev"',
    )
    text = re.sub(r', path = "[^"]+"', "", text)
    artifact_crates = set(wasix_public_cargo_package_names())
    for crate in sorted(artifact_crates):
        pattern = rf'(?m)^({re.escape(crate)}\s*=\s*\{{[^}}\n]*version\s*=\s*")=[^"]+("[^}}\n]*\}})$'
        text, count = re.subn(pattern, rf"\1={runtime_version}\2", text, count=1)
        if count != 1:
            fail(f"generated oliphaunt-wasix release source is missing dependency {crate}")
    if "\n[workspace]" not in text:
        text = text.rstrip() + "\n\n[workspace]\n"
    return text


def validate_generated_oliphaunt_wasix_release_artifact_coverage(manifest_path: Path) -> None:
    manifest = manifest_path.read_text(encoding="utf-8")
    if re.search(r'=\s*\{[^}\n]*path\s*=', manifest):
        fail("generated oliphaunt-wasix release source must not contain local path dependencies")
    runtime_version = current_product_version("liboliphaunt-wasix")
    required_crates = set(wasix_public_cargo_package_names())
    missing = [
        crate
        for crate in sorted(required_crates)
        if f'{crate} = {{ version = "={runtime_version}"' not in manifest
    ]
    if missing:
        fail(
            "generated oliphaunt-wasix release source is missing WASIX artifact dependency pins: "
            + ", ".join(missing)
        )


def prepare_oliphaunt_wasix_release_source(version: str) -> Path:
    runtime_version = current_product_version("liboliphaunt-wasix")
    source_dir = ROOT / "src" / "bindings" / "wasix-rust" / "crates" / "oliphaunt-wasix"
    stage_dir = ROOT / "target" / "release" / "cargo-package-sources" / "oliphaunt-wasix"
    shutil.rmtree(stage_dir, ignore_errors=True)
    shutil.copytree(
        source_dir,
        stage_dir,
        ignore=shutil.ignore_patterns("target"),
    )
    cargo_toml = stage_dir / "Cargo.toml"
    rendered = render_oliphaunt_wasix_release_cargo_toml(
        cargo_toml.read_text(encoding="utf-8"),
        runtime_version,
    )
    cargo_toml.write_text(rendered, encoding="utf-8")
    package = rendered.split("[package]", 1)[1].split("[", 1)[0]
    if f'version = "{version}"' not in package:
        fail(f"generated oliphaunt-wasix release source must keep SDK version {version}")
    validate_generated_oliphaunt_wasix_release_artifact_coverage(cargo_toml)
    return cargo_toml


def prepare_oliphaunt_release_source(version: str) -> Path:
    native_version = current_product_version("liboliphaunt-native")
    broker_version = current_product_version("oliphaunt-broker")
    source_dir = ROOT / "src" / "sdks" / "rust"
    stage_dir = ROOT / "target" / "release" / "cargo-package-sources" / "oliphaunt"
    shutil.rmtree(stage_dir, ignore_errors=True)
    shutil.copytree(
        source_dir,
        stage_dir,
        ignore=shutil.ignore_patterns("target"),
    )
    shutil.rmtree(stage_dir / "crates" / "oliphaunt-build", ignore_errors=True)
    cargo_toml = stage_dir / "Cargo.toml"
    rendered = render_oliphaunt_release_cargo_toml(
        cargo_toml.read_text(encoding="utf-8"),
        native_version,
        broker_version,
    )
    cargo_toml.write_text(rendered, encoding="utf-8")
    package = rendered.split("[package]", 1)[1].split("[", 1)[0]
    if f'version = "{version}"' not in package:
        fail(f"generated oliphaunt release source must keep SDK version {version}")
    for target in artifact_targets(
        product="liboliphaunt-native",
        kind="native-runtime",
        surface="rust-native-direct",
        published_only=True,
    ):
        crate = liboliphaunt_cargo_package_name(target.target)
        if f'{crate} = {{ version = "={native_version}" }}' not in rendered:
            fail(f"generated oliphaunt release source is missing native runtime artifact dependency {crate}")
    tools_facade = LIBOLIPHAUNT_TOOLS_PRODUCT
    if f'{tools_facade} = {{ version = "={native_version}" }}' not in rendered:
        fail(f"generated oliphaunt release source is missing native tools facade dependency {tools_facade}")
    for target in artifact_targets(
        product="oliphaunt-broker",
        kind="broker-helper",
        surface="rust-broker",
        published_only=True,
    ):
        crate = broker_cargo_package_name(target.target)
        if f'{crate} = {{ version = "={broker_version}" }}' not in rendered:
            fail(f"generated oliphaunt release source is missing broker artifact dependency {crate}")
    return cargo_toml


def wasix_release_asset_dir() -> Path:
    return ROOT / "target/oliphaunt-wasix/release-assets"


def parse_local_checksum_manifest(path: Path) -> dict[str, str]:
    checksums: dict[str, str] = {}
    for line_number, raw_line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        line = raw_line.strip()
        if not line:
            continue
        parts = line.split(None, 1)
        if len(parts) != 2:
            fail(f"{path.relative_to(ROOT)}:{line_number} must contain '<sha256> <asset>'")
        sha, name = parts
        if len(sha) != 64 or any(char not in "0123456789abcdef" for char in sha):
            fail(f"{path.relative_to(ROOT)}:{line_number} has invalid sha256 {sha!r}")
        asset_name = name[2:] if name.startswith("./") else name
        if "/" in asset_name or not asset_name:
            fail(f"{path.relative_to(ROOT)}:{line_number} must reference a direct asset filename")
        if asset_name in checksums:
            fail(f"{path.relative_to(ROOT)} declares duplicate checksum entry for {asset_name}")
        checksums[asset_name] = sha
    return checksums


def validate_wasix_release_assets() -> None:
    product = "liboliphaunt-wasix"
    version = current_product_version(product)
    asset_dir = wasix_release_asset_dir()
    if not asset_dir.is_dir():
        fail(
            "liboliphaunt-wasix requires staged release assets under "
            "target/oliphaunt-wasix/release-assets; download the CI workflow "
            "liboliphaunt-wasix-release-assets artifact before release validation or publishing"
        )
    expected = set(expected_assets(product, version, surface="github-release"))
    actual = {path.name for path in asset_dir.iterdir() if path.is_file()}
    missing = sorted(expected - actual)
    if missing:
        fail("liboliphaunt-wasix release asset directory is missing expected assets: " + ", ".join(missing))
    unexpected = sorted(actual - expected)
    if unexpected:
        fail("liboliphaunt-wasix release asset directory contains unexpected assets: " + ", ".join(unexpected))
    checksum_name = f"liboliphaunt-wasix-{version}-release-assets.sha256"
    checksum_path = asset_dir / checksum_name
    if not checksum_path.is_file():
        fail(f"liboliphaunt-wasix release asset directory is missing {checksum_name}")
    checksums = parse_local_checksum_manifest(checksum_path)
    checksum_expected = expected - {checksum_name}
    if set(checksums) != checksum_expected:
        fail(
            "liboliphaunt-wasix checksum manifest must cover release assets exactly: "
            f"{sorted(checksums)} vs {sorted(checksum_expected)}"
        )
    for name, expected_sha in checksums.items():
        actual_sha = sha256_file(asset_dir / name)
        if actual_sha != expected_sha:
            fail(f"liboliphaunt-wasix release asset {name} checksum mismatch")
    validate_wasix_release_asset_contents(asset_dir)
    print(f"validated liboliphaunt-wasix staged release assets under {asset_dir.relative_to(ROOT)}")


def run_wasix_runtime_release_dry_run(allow_dirty: bool) -> None:
    validate_wasix_release_assets()
    liboliphaunt_wasix_cargo_artifact_crates(current_product_version("liboliphaunt-wasix"))


def tar_zstd_members(archive: Path) -> list[str]:
    result = subprocess.run(
        ["tar", "--zstd", "-tf", str(archive)],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
    )
    if result.returncode != 0:
        fail(f"could not list {archive.relative_to(ROOT)}: {result.stderr.strip()}")
    return [line for line in result.stdout.splitlines() if line.strip()]


def normalized_tar_member(member: str) -> str:
    pure = PurePosixPath(member)
    parts = [part for part in pure.parts if part not in {"", "."}]
    return "/".join(parts)


def find_tar_zstd_member(archive: Path, expected: str) -> str | None:
    for member in tar_zstd_members(archive):
        if normalized_tar_member(member) == expected:
            return member
    return None


def read_tar_zstd_member(archive: Path, expected: str) -> bytes:
    member = find_tar_zstd_member(archive, expected)
    if member is None:
        fail(f"{archive.relative_to(ROOT)} is missing {expected}")
    result = subprocess.run(
        ["tar", "--zstd", "-xOf", str(archive), member],
        cwd=ROOT,
        capture_output=True,
        check=False,
    )
    if result.returncode != 0:
        fail(f"could not read {expected} from {archive.relative_to(ROOT)}: {result.stderr.decode().strip()}")
    return result.stdout


def tar_zstd_bytes_members(data: bytes, context: str) -> list[str]:
    result = subprocess.run(
        ["tar", "--zstd", "-tf", "-"],
        input=data,
        cwd=ROOT,
        text=False,
        capture_output=True,
        check=False,
    )
    if result.returncode != 0:
        fail(f"could not list nested zstd tar for {context}: {result.stderr.decode().strip()}")
    return [line for line in result.stdout.decode("utf-8").splitlines() if line.strip()]


def validate_simple_tar_path(path: str, context: str) -> None:
    pure = PurePosixPath(path)
    if pure.is_absolute() or any(part in {"", ".", ".."} for part in pure.parts):
        fail(f"{context} path must be a simple relative path, got {path!r}")


def expected_parent_dirs(paths: set[str]) -> set[str]:
    parents: set[str] = set()
    for path in paths:
        pure = PurePosixPath(path)
        for parent in pure.parents:
            if str(parent) != ".":
                parents.add(str(parent))
    return parents


def validate_wasix_release_asset_contents(asset_dir: Path) -> None:
    portable = next(asset_dir.glob("liboliphaunt-wasix-*-runtime-portable.tar.zst"), None)
    if portable is None:
        fail("liboliphaunt-wasix release assets are missing the portable runtime archive")
    validate_wasix_portable_release_asset(portable)

    icu = next(asset_dir.glob("liboliphaunt-wasix-*-icu-data.tar.zst"), None)
    if icu is None:
        fail("liboliphaunt-wasix release assets are missing the ICU data archive")
    validate_wasix_icu_release_asset(icu)

    aot_archives = sorted(asset_dir.glob("liboliphaunt-wasix-*-runtime-aot-*.tar.zst"))
    if not aot_archives:
        fail("liboliphaunt-wasix release assets are missing target AOT archives")
    for archive in aot_archives:
        validate_wasix_aot_release_asset(archive)


def validate_wasix_portable_release_asset(archive: Path) -> None:
    members = {normalized_tar_member(member) for member in tar_zstd_members(archive)}
    extension_members = sorted(
        member for member in members if member.startswith("target/oliphaunt-wasix/assets/extensions/")
    )
    if extension_members:
        fail(
            f"{archive.relative_to(ROOT)} must not contain extension payloads: "
            + ", ".join(extension_members[:5])
        )
    manifest_path = "target/oliphaunt-wasix/assets/manifest.json"
    manifest = json.loads(read_tar_zstd_member(archive, manifest_path).decode("utf-8"))
    extensions = manifest.get("extensions")
    if extensions != []:
        fail(f"{archive.relative_to(ROOT)} asset manifest must contain an empty extensions array")
    for tool_key in ["pg-dump", "psql"]:
        if tool_key in manifest:
            fail(
                f"{archive.relative_to(ROOT)} asset manifest must not contain split WASIX tool entry {tool_key}"
            )
    icu_sidecar_members = sorted(
        member
        for member in members
        if member == "target/oliphaunt-wasix/icu" or member.startswith("target/oliphaunt-wasix/icu/")
    )
    if icu_sidecar_members:
        fail(
            f"{archive.relative_to(ROOT)} must not contain ICU data sidecar files: "
            + ", ".join(icu_sidecar_members[:5])
        )
    runtime_archive = read_tar_zstd_member(
        archive,
        "target/oliphaunt-wasix/assets/oliphaunt.wasix.tar.zst",
    )
    runtime_members = {normalized_tar_member(member) for member in tar_zstd_bytes_members(runtime_archive, "WASIX runtime archive")}
    missing_runtime_tools = sorted(
        member
        for member in {"oliphaunt/bin/initdb", "oliphaunt/bin/postgres"}
        if member not in runtime_members
    )
    if missing_runtime_tools:
        fail(
            f"{archive.relative_to(ROOT)} must bundle core WASIX runtime binaries inside target/oliphaunt-wasix/assets/oliphaunt.wasix.tar.zst: "
            + ", ".join(missing_runtime_tools)
        )
    bundled_icu = sorted(
        member
        for member in runtime_members
        if member == "oliphaunt/share/icu" or member.startswith("oliphaunt/share/icu/")
    )
    if bundled_icu:
        fail(
            f"{archive.relative_to(ROOT)} must not bundle ICU data inside target/oliphaunt-wasix/assets/oliphaunt.wasix.tar.zst: "
            + ", ".join(bundled_icu[:5])
        )
    bundled_tools = sorted(
        member
        for member in runtime_members
        if member in {"oliphaunt/bin/pg_ctl", "oliphaunt/bin/pg_dump", "oliphaunt/bin/psql"}
    )
    if bundled_tools:
        fail(
            f"{archive.relative_to(ROOT)} must not bundle standalone tools inside target/oliphaunt-wasix/assets/oliphaunt.wasix.tar.zst: "
            + ", ".join(bundled_tools)
        )


def validate_wasix_icu_release_asset(archive: Path) -> None:
    members = {normalized_tar_member(member) for member in tar_zstd_members(archive)}
    icu_root = "target/oliphaunt-wasix/icu/share/icu"
    icu_entries = sorted(
        member
        for member in members
        if member.startswith(f"{icu_root}/")
        and PurePosixPath(member).relative_to(icu_root).parts
        and PurePosixPath(member).relative_to(icu_root).parts[0].startswith("icudt")
    )
    if not icu_entries:
        fail(f"{archive.relative_to(ROOT)} must contain ICU data files under {icu_root}")
    unexpected = sorted(
        member
        for member in members
        if member not in expected_parent_dirs(set(icu_entries))
        and not member.startswith(f"{icu_root}/")
        and not member.endswith("/")
    )
    if unexpected:
        fail(
            f"{archive.relative_to(ROOT)} contains unexpected non-ICU files: "
            + ", ".join(unexpected[:5])
        )


def validate_wasix_aot_release_asset(archive: Path) -> None:
    members = {normalized_tar_member(member) for member in tar_zstd_members(archive)}
    manifest_members = sorted(
        member
        for member in members
        if member.startswith("target/oliphaunt-wasix/aot/") and member.endswith("/manifest.json")
    )
    if len(manifest_members) != 1:
        fail(f"{archive.relative_to(ROOT)} must contain exactly one AOT manifest, got {manifest_members}")
    manifest_path = manifest_members[0]
    aot_root = str(PurePosixPath(manifest_path).parent)
    manifest = json.loads(read_tar_zstd_member(archive, manifest_path).decode("utf-8"))
    artifacts = manifest.get("artifacts")
    if not isinstance(artifacts, list) or not artifacts:
        fail(f"{archive.relative_to(ROOT)} AOT manifest must contain artifacts")

    expected_files = {manifest_path}
    for artifact in artifacts:
        if not isinstance(artifact, dict):
            fail(f"{archive.relative_to(ROOT)} AOT manifest contains a non-object artifact")
        name = artifact.get("name")
        path = artifact.get("path")
        if not isinstance(name, str) or not name:
            fail(f"{archive.relative_to(ROOT)} AOT manifest contains an artifact without a name")
        if name.startswith("extension:"):
            fail(f"{archive.relative_to(ROOT)} must not contain extension AOT artifact {name}")
        if not isinstance(path, str) or not path:
            fail(f"{archive.relative_to(ROOT)} AOT artifact {name} is missing path")
        validate_simple_tar_path(path, f"{archive.relative_to(ROOT)} AOT artifact {name}")
        expected_files.add(f"{aot_root}/{path}")

    parent_dirs = expected_parent_dirs(expected_files)
    actual_files = {
        member
        for member in members
        if member not in parent_dirs and not member.endswith("/")
    }
    if actual_files != expected_files:
        fail(
            f"{archive.relative_to(ROOT)} AOT file set mismatch: "
            f"expected {sorted(expected_files)}, got {sorted(actual_files)}"
        )


def run_wasm_release_dry_run(allow_dirty: bool) -> None:
    _ = allow_dirty
    version = current_product_version("oliphaunt-wasix-rust")
    validate_staged_sdk_package("oliphaunt-wasix-rust")
    release_manifest = prepare_oliphaunt_wasix_release_source(version)
    validate_generated_oliphaunt_wasix_release_artifact_coverage(release_manifest)
    print(
        f"validated generated WASIX Rust binding release source: {release_manifest.relative_to(ROOT)}"
    )
    print(
        "validated staged WASIX Rust binding package shape and generated publish manifest; "
        "source publish runs after WASIX artifact crates are published."
    )


def publish_wasm_crates_io(head_ref: str) -> None:
    if published_rerun("oliphaunt-wasix-rust", head_ref):
        print("oliphaunt-wasix is already published at this commit; skipping crates.io publish.")
        return

    verify_release_tag("oliphaunt-wasix-rust", head_ref)
    run(
        [
            *REGISTRY_PUBLICATION_CHECK,
            "--product",
            "liboliphaunt-wasix",
            "--registry-kind",
            "crates",
            "--require-published",
            "--retries",
            "12",
            "--retry-delay",
            "10",
        ]
    )
    version = current_product_version("oliphaunt-wasix-rust")
    validate_staged_sdk_package("oliphaunt-wasix-rust")
    release_manifest = prepare_oliphaunt_wasix_release_source(version)
    validate_generated_oliphaunt_wasix_release_artifact_coverage(release_manifest)
    cargo_publish_manifest("oliphaunt-wasix", version, release_manifest)
    run(
        [
            *REGISTRY_PUBLICATION_CHECK,
            "--product",
            "oliphaunt-wasix-rust",
            "--require-published",
            "--retries",
            "12",
            "--retry-delay",
            "10",
        ]
    )


def liboliphaunt_release_asset_dir() -> Path:
    return ROOT / "target" / "liboliphaunt" / "release-assets"


def liboliphaunt_release_assets_ready() -> bool:
    asset_dir = liboliphaunt_release_asset_dir()
    if not asset_dir.is_dir():
        return False
    return any(path.is_file() for path in asset_dir.iterdir())


def ensure_liboliphaunt_release_assets() -> None:
    if liboliphaunt_release_assets_ready():
        run(["tools/dev/bun.sh", "tools/release/check-liboliphaunt-release-assets.mjs", "--asset-dir", "target/liboliphaunt/release-assets"])
        return
    fail(
        "liboliphaunt-native requires staged release assets under "
        "target/liboliphaunt/release-assets; download the CI workflow "
        "liboliphaunt-native-release-assets artifact before release validation or publishing"
    )


def run_liboliphaunt_dry_run() -> None:
    ensure_liboliphaunt_release_assets()
    liboliphaunt_cargo_artifact_crates(current_product_version("liboliphaunt-native"))


def staged_runtime_input_dirs(env_name: str) -> list[Path]:
    raw = os.environ.get(env_name) or os.environ.get("OLIPHAUNT_RELEASE_ASSET_INPUT_DIRS") or ""
    dirs = [Path(item).expanduser() for item in raw.split(":") if item]
    return [path if path.is_absolute() else ROOT / path for path in dirs]


def copy_staged_runtime_assets(
    *,
    product: str,
    destination: Path,
    env_name: str,
    patterns: tuple[str, ...],
) -> None:
    source_dirs = staged_runtime_input_dirs(env_name)
    if not source_dirs:
        fail(
            f"{product} requires staged runtime artifacts; set {env_name} or "
            "OLIPHAUNT_RELEASE_ASSET_INPUT_DIRS to the downloaded CI artifact directory"
        )
    destination.mkdir(parents=True, exist_ok=True)
    copied = 0
    for source_dir in source_dirs:
        if not source_dir.is_dir():
            fail(f"{product} release asset input directory does not exist: {source_dir}")
        for pattern in patterns:
            for asset in sorted(source_dir.glob(pattern)):
                if asset.is_file():
                    output_asset = destination / asset.name
                    if output_asset.is_file():
                        if sha256_file(output_asset) != sha256_file(asset):
                            fail(
                                f"{product} release asset input collision for {asset.name}: "
                                f"{output_asset} and {asset} have different bytes"
                            )
                        continue
                    shutil.copy2(asset, output_asset)
                    copied += 1
    if copied == 0:
        fail(f"{product} found no staged runtime artifacts matching {patterns} under {source_dirs}")


def ensure_broker_release_assets() -> None:
    asset_dir = ROOT / "target" / "oliphaunt-broker" / "release-assets"
    if not any(asset_dir.glob("oliphaunt-broker-*.tar.gz")) and not any(asset_dir.glob("oliphaunt-broker-*.zip")):
        copy_staged_runtime_assets(
            product="oliphaunt-broker",
            destination=asset_dir,
            env_name="OLIPHAUNT_BROKER_RELEASE_ASSET_INPUT_DIRS",
            patterns=("oliphaunt-broker-*.tar.gz", "oliphaunt-broker-*.zip"),
        )
    version = current_product_version("oliphaunt-broker")
    run(
        [
            "tools/release/write_checksum_manifest.mjs",
            "--asset-dir",
            str(asset_dir.relative_to(ROOT)),
            "--output",
            f"oliphaunt-broker-{version}-release-assets.sha256",
            "--pattern",
            "oliphaunt-broker-*.tar.gz",
            "--pattern",
            "oliphaunt-broker-*.zip",
        ]
    )
    run(["bun", "tools/release/check-broker-release-assets.mjs", "--asset-dir", str(asset_dir.relative_to(ROOT))])


def ensure_node_direct_release_assets() -> None:
    asset_dir = ROOT / "target" / "oliphaunt-node-direct" / "release-assets"
    if not any(asset_dir.glob("oliphaunt-node-direct-*.tar.gz")) and not any(asset_dir.glob("oliphaunt-node-direct-*.zip")):
        copy_staged_runtime_assets(
            product="oliphaunt-node-direct",
            destination=asset_dir,
            env_name="OLIPHAUNT_NODE_ADDON_ASSET_INPUT_DIRS",
            patterns=("oliphaunt-node-direct-*.tar.gz", "oliphaunt-node-direct-*.zip"),
        )
    version = current_product_version("oliphaunt-node-direct")
    run(
        [
            "tools/release/write_checksum_manifest.mjs",
            "--asset-dir",
            str(asset_dir.relative_to(ROOT)),
            "--output",
            f"oliphaunt-node-direct-{version}-release-assets.sha256",
            "--pattern",
            "oliphaunt-node-direct-*.tar.gz",
            "--pattern",
            "oliphaunt-node-direct-*.zip",
        ]
    )
    run(["bun", "tools/release/check-node-direct-release-assets.mjs", "--asset-dir", str(asset_dir.relative_to(ROOT))])


def extension_package_dir(product: str) -> Path:
    return ROOT / "target" / "extension-artifacts" / product


def read_json_file(path: Path) -> object:
    try:
        with path.open("r", encoding="utf-8") as handle:
            return json.load(handle)
    except json.JSONDecodeError as error:
        fail(f"{path.relative_to(ROOT)} is not valid JSON: {error}")


def validate_checksum_manifest(checksum_manifest: Path, asset_dir: Path) -> None:
    declared: dict[str, str] = {}
    for line_number, raw_line in enumerate(checksum_manifest.read_text(encoding="utf-8").splitlines(), start=1):
        line = raw_line.strip()
        if not line:
            continue
        parts = line.split(None, 1)
        if len(parts) != 2:
            fail(f"{checksum_manifest.relative_to(ROOT)}:{line_number} must contain '<sha256>  ./<asset>'")
        sha, name = parts
        if len(sha) != 64 or any(char not in "0123456789abcdef" for char in sha):
            fail(f"{checksum_manifest.relative_to(ROOT)}:{line_number} has invalid sha256 {sha!r}")
        if not name.startswith("./") or "/" in name[2:]:
            fail(f"{checksum_manifest.relative_to(ROOT)}:{line_number} must reference a direct asset path like ./name")
        asset_name = name[2:]
        if asset_name in declared:
            fail(f"{checksum_manifest.relative_to(ROOT)} declares duplicate checksum entry for {asset_name}")
        declared[asset_name] = sha

    expected = sorted(path.name for path in asset_dir.iterdir() if path.is_file() and path != checksum_manifest)
    if sorted(declared) != expected:
        fail(
            f"{checksum_manifest.relative_to(ROOT)} entries must exactly match release asset files: "
            f"{sorted(declared)} vs {expected}"
        )
    for asset_name, expected_sha in declared.items():
        asset_path = asset_dir / asset_name
        actual_sha = sha256_file(asset_path)
        if actual_sha != expected_sha:
            fail(f"{checksum_manifest.relative_to(ROOT)} checksum for {asset_name} is {expected_sha}, got {actual_sha}")


def public_extension_asset(asset: dict[str, object]) -> dict[str, object]:
    return {
        key: asset[key]
        for key in PUBLIC_EXTENSION_RELEASE_ASSET_KEYS
        if key in asset
    }


def validate_extension_release_package(product: str) -> None:
    package_dir = extension_package_dir(product)
    asset_dir = package_dir / "release-assets"
    manifest = package_dir / "extension-artifacts.json"
    if not manifest.is_file() or not asset_dir.is_dir():
        fail(f"{product} extension package is missing {manifest.relative_to(ROOT)} or {asset_dir.relative_to(ROOT)}")

    data = read_json_file(manifest)
    if not isinstance(data, dict):
        fail(f"{manifest.relative_to(ROOT)} must contain a JSON object")
    version = current_product_version(product)
    sql_name = extension_sql_name(product)
    expected = {
        "schema": "oliphaunt-extension-ci-artifacts-v1",
        "product": product,
        "version": version,
        "sqlName": sql_name,
    }
    for key, value in expected.items():
        if data.get(key) != value:
            fail(f"{manifest.relative_to(ROOT)} has {key}={data.get(key)!r}, expected {value!r}")

    release_manifest = asset_dir / f"{product}-{version}-manifest.json"
    properties_manifest = asset_dir / f"{product}-{version}-manifest.properties"
    checksum_manifest = asset_dir / f"{product}-{version}-release-assets.sha256"
    for required in (release_manifest, properties_manifest, checksum_manifest):
        if not required.is_file():
            fail(f"{product} extension package is missing {required.relative_to(ROOT)}")
    validate_checksum_manifest(checksum_manifest, asset_dir)

    release_data = read_json_file(release_manifest)
    if not isinstance(release_data, dict):
        fail(f"{release_manifest.relative_to(ROOT)} must contain a JSON object")
    release_expected = {
        "schema": "oliphaunt-extension-release-manifest-v1",
        "product": product,
        "version": version,
        "sqlName": sql_name,
    }
    for key, value in release_expected.items():
        if release_data.get(key) != value:
            fail(f"{release_manifest.relative_to(ROOT)} has {key}={release_data.get(key)!r}, expected {value!r}")
    actual_release_keys = set(release_data)
    expected_release_keys = PUBLIC_EXTENSION_RELEASE_MANIFEST_KEYS
    if actual_release_keys != expected_release_keys:
        fail(
            f"{release_manifest.relative_to(ROOT)} public manifest keys must be "
            f"{sorted(expected_release_keys)}, got {sorted(actual_release_keys)}"
        )
    extension_meta = release_extension_metadata(product)
    if release_data.get("extensionClass") != extension_meta["class"]:
        fail(f"{release_manifest.relative_to(ROOT)} has stale extensionClass")
    if release_data.get("versioning") != extension_meta["versioning"]:
        fail(f"{release_manifest.relative_to(ROOT)} has stale versioning")
    if release_data.get("sourceIdentity") != release_extension_source_identity(product):
        fail(f"{release_manifest.relative_to(ROOT)} has stale sourceIdentity")
    if release_data.get("compatibility") != extension_meta["compatibility"]:
        fail(f"{release_manifest.relative_to(ROOT)} has stale compatibility")

    assets = data.get("assets")
    if not isinstance(assets, list) or not assets:
        fail(f"{manifest.relative_to(ROOT)} must declare at least one extension asset")
    public_assets = release_data.get("assets")
    if public_assets != [public_extension_asset(asset) for asset in assets if isinstance(asset, dict)]:
        fail(f"{release_manifest.relative_to(ROOT)} public assets must match {manifest.relative_to(ROOT)} without local paths")
    if isinstance(public_assets, list):
        for asset in public_assets:
            if not isinstance(asset, dict):
                fail(f"{release_manifest.relative_to(ROOT)} public assets must contain object rows")
            actual_asset_keys = set(asset)
            expected_asset_keys = PUBLIC_EXTENSION_RELEASE_ASSET_KEYS
            if actual_asset_keys != expected_asset_keys:
                fail(
                    f"{release_manifest.relative_to(ROOT)} public asset {asset.get('name')!r} keys must be "
                    f"{sorted(expected_asset_keys)}, got {sorted(actual_asset_keys)}"
                )

    declared_native_targets = {
        target.target
        for target in extension_artifact_targets(
            product=product,
            family="native",
            published_only=True,
        )
    }
    declared_wasix_targets = {
        target.target
        for target in extension_artifact_targets(
            product=product,
            family="wasix",
            published_only=True,
        )
    }
    staged_native_targets: set[str] = set()
    staged_wasix_targets: set[str] = set()
    seen_assets: set[str] = set()
    for asset in assets:
        if not isinstance(asset, dict):
            fail(f"{manifest.relative_to(ROOT)} contains a non-object asset entry")
        family = asset.get("family")
        target = asset.get("target")
        kind = asset.get("kind")
        name = asset.get("name")
        path_value = asset.get("path")
        sha_value = asset.get("sha256")
        bytes_value = asset.get("bytes")
        if not all(isinstance(value, str) and value for value in (family, target, kind, name, path_value, sha_value)):
            fail(f"{manifest.relative_to(ROOT)} contains an incomplete asset entry: {asset!r}")
        if not isinstance(bytes_value, int) or bytes_value <= 0:
            fail(f"{manifest.relative_to(ROOT)} asset {name} must declare positive bytes")
        if family == "native":
            staged_native_targets.add(target)
        elif family == "wasix":
            staged_wasix_targets.add(target)
        else:
            fail(f"{manifest.relative_to(ROOT)} asset {name} has unsupported family {family!r}")
        if name in seen_assets:
            fail(f"{manifest.relative_to(ROOT)} declares duplicate asset name {name}")
        seen_assets.add(name)

        asset_path = ROOT / path_value
        if asset_path.parent != asset_dir or asset_path.name != name:
            fail(f"{manifest.relative_to(ROOT)} asset {name} must live directly under {asset_dir.relative_to(ROOT)}")
        if not asset_path.is_file():
            fail(f"{manifest.relative_to(ROOT)} references missing asset {asset_path.relative_to(ROOT)}")
        if asset_path.stat().st_size != bytes_value:
            fail(f"{asset_path.relative_to(ROOT)} size does not match staged manifest")
        if sha256_file(asset_path) != sha_value:
            fail(f"{asset_path.relative_to(ROOT)} checksum does not match staged manifest")

    if staged_native_targets != declared_native_targets:
        fail(
            f"{product} staged native extension targets must match declared published targets: "
            f"{sorted(staged_native_targets)} vs {sorted(declared_native_targets)}"
        )
    if staged_wasix_targets != declared_wasix_targets:
        fail(
            f"{product} staged WASIX extension targets must match declared published targets: "
            f"{sorted(staged_wasix_targets)} vs {sorted(declared_wasix_targets)}"
        )


def extension_release_package_ready(product: str) -> bool:
    package_dir = extension_package_dir(product)
    asset_dir = package_dir / "release-assets"
    manifest = package_dir / "extension-artifacts.json"
    if not manifest.is_file() or not asset_dir.is_dir():
        return False
    validate_extension_release_package(product)
    return True


def ensure_extension_release_package(product: str) -> None:
    if extension_release_package_ready(product):
        return
    fail(
        f"{product} requires staged exact-extension package artifacts under "
        f"{extension_package_dir(product).relative_to(ROOT)}; download the CI workflow "
        "oliphaunt-extension-package-artifacts artifact before release validation or publishing"
    )


def extension_asset_paths(product: str) -> list[str]:
    ensure_extension_release_package(product)
    asset_dir = extension_package_dir(product) / "release-assets"
    if not asset_dir.is_dir():
        fail(f"{product} extension package did not create {asset_dir.relative_to(ROOT)}")
    assets = sorted(path for path in asset_dir.iterdir() if path.is_file())
    if not assets:
        fail(f"{product} extension package produced no release assets")
    return [str(path.relative_to(ROOT)) for path in assets]


def run_extension_artifact_dry_run(product: str) -> None:
    for asset in extension_asset_paths(product):
        print(f"{product} release asset: {asset}")
    run_extension_maven_artifact_dry_run(product)


def build_maven_artifact_manifest(
    name: str,
    *,
    runtime: bool = False,
    extensions: bool = False,
    extension_products: list[str] | None = None,
) -> Path:
    output_path = ROOT / "target" / "release" / "maven-artifacts" / f"{name}.tsv"
    command = [
        "tools/dev/bun.sh",
        "tools/release/build_maven_artifact_manifest.mjs",
        "--output",
        str(output_path.relative_to(ROOT)),
    ]
    if runtime:
        command.append("--runtime")
    if extensions:
        command.append("--extensions")
    for extension_product in extension_products or []:
        command.extend(["--extension-product", extension_product])
    run(command)
    return output_path


def run_maven_artifact_publisher(manifest: Path, task: str, cache_slug: str) -> None:
    run(
        [
            "src/sdks/kotlin/gradlew",
            "-p",
            "src/sdks/kotlin",
            task,
            f"-PoliphauntMavenArtifactsManifest={manifest}",
            f"-PoliphauntBuildRoot={ROOT / f'target/liboliphaunt-sdk-check/gradle/{cache_slug}'}",
            "--project-cache-dir",
            str(ROOT / f"target/liboliphaunt-sdk-check/gradle-cache/{cache_slug}"),
            "--configure-on-demand",
            "--no-configuration-cache",
        ]
    )


def run_runtime_maven_artifact_dry_run() -> None:
    manifest = build_maven_artifact_manifest("liboliphaunt-native-runtime", runtime=True)
    run_maven_artifact_publisher(
        manifest,
        ":oliphaunt-maven-artifacts:publishToMavenLocal",
        "liboliphaunt-native-maven-dry-run",
    )


def run_extension_maven_artifact_dry_run(product: str) -> None:
    manifest = build_maven_artifact_manifest(product, extensions=True, extension_products=[product])
    run_maven_artifact_publisher(
        manifest,
        ":oliphaunt-maven-artifacts:publishToMavenLocal",
        f"{product}-maven-dry-run",
    )


def validate_staged_sdk_package(product: str) -> None:
    run(["tools/dev/bun.sh", "tools/release/check-staged-artifacts.mjs", "--require-sdk-product", product])


def run_rust_sdk_dry_run(allow_dirty: bool, head_ref: str) -> None:
    version = current_product_version("oliphaunt-rust")
    validate_staged_sdk_package("oliphaunt-rust")
    verify_staged_cargo_product_crates("oliphaunt-rust", version, allow_dirty=allow_dirty)
    release_manifest = prepare_oliphaunt_release_source(version)
    validate_generated_oliphaunt_release_artifact_coverage(release_manifest)
    print(f"validated generated Rust SDK release source: {release_manifest.relative_to(ROOT)}")
    print("validated staged Rust SDK crates; skipping source cargo publish dry-run.")


def run_broker_dry_run() -> None:
    version = current_product_version("oliphaunt-broker")
    ensure_broker_release_assets()
    broker_npm_tarballs(version)
    broker_cargo_artifact_crates(version)


def run_swift_sdk_dry_run() -> None:
    validate_staged_sdk_package("oliphaunt-swift")
    prepare_staged_swift_release_manifest()


def run_kotlin_sdk_dry_run() -> None:
    validate_staged_sdk_package("oliphaunt-kotlin")
    staged_kotlin_maven_repo()


def run_react_native_sdk_dry_run() -> None:
    validate_staged_sdk_package("oliphaunt-react-native")
    require_staged_sdk_artifact("oliphaunt-react-native", "npm package", (".tgz",))


def run_typescript_sdk_dry_run(allow_dirty: bool) -> None:
    validate_staged_sdk_package("oliphaunt-js")
    require_staged_sdk_artifact("oliphaunt-js", "npm package", (".tgz",))
    jsr_source = staged_jsr_source_dir("oliphaunt-js")
    command = ["pnpm", "exec", "jsr", "publish", "--dry-run"]
    if allow_dirty:
        command.append("--allow-dirty")
    run(command, cwd=jsr_source)


def run_node_direct_dry_run() -> None:
    run(["src/runtimes/node-direct/tools/check-package.sh", "package-shape"])
    ensure_node_direct_release_assets()
    node_direct_optional_npm_tarballs(current_product_version("oliphaunt-node-direct"))


def run_product_publish_dry_runs(products: list[str], *, allow_dirty: bool, head_ref: str) -> None:
    for product in products:
        if product == "liboliphaunt-native":
            run_liboliphaunt_dry_run()
            liboliphaunt_npm_tarballs(current_product_version("liboliphaunt-native"))
            run_runtime_maven_artifact_dry_run()
        elif product == "liboliphaunt-wasix":
            run_wasix_runtime_release_dry_run(allow_dirty)
        elif product == "oliphaunt-rust":
            run_rust_sdk_dry_run(allow_dirty, head_ref)
        elif product == "oliphaunt-broker":
            run_broker_dry_run()
        elif product == "oliphaunt-node-direct":
            run_node_direct_dry_run()
        elif product == "oliphaunt-swift":
            run_swift_sdk_dry_run()
        elif product == "oliphaunt-kotlin":
            run_kotlin_sdk_dry_run()
        elif product == "oliphaunt-react-native":
            run_react_native_sdk_dry_run()
        elif product == "oliphaunt-js":
            run_typescript_sdk_dry_run(allow_dirty)
        elif product == "oliphaunt-wasix-rust":
            if published_rerun("oliphaunt-wasix-rust", head_ref):
                print("oliphaunt-wasix is already published at this commit; skipping WASM publish dry-run.")
            else:
                run_wasm_release_dry_run(allow_dirty)
        elif is_extension_product(product):
            run_extension_artifact_dry_run(product)
        else:
            fail(f"no publish dry-run handler for {product}")


def command_check(args: list[str]) -> None:
    run(["tools/dev/bun.sh", "tools/release/release-check.mjs", *args])


def command_check_registries(args: list[str]) -> None:
    run(["tools/dev/bun.sh", "tools/release/release-check-registries.mjs", *args])


def command_consumer_shape(args: list[str]) -> None:
    run(["tools/dev/bun.sh", "tools/release/release-consumer-shape.mjs", *args])


def command_verify_release(args: list[str]) -> None:
    run(["tools/dev/bun.sh", "tools/release/release-verify.mjs", *args])


def publish_liboliphaunt_github_assets(head_ref: str) -> None:
    verify_release_tag("liboliphaunt-native", head_ref)
    ensure_liboliphaunt_release_assets()
    assets = glob_release_assets(
        ROOT / "target/liboliphaunt/release-assets",
        (".tar.gz", ".tar.zst", ".tsv", ".zip", ".sha256"),
    )
    upload_github_release_assets("liboliphaunt-native", assets=assets)


def publish_swift_release(head_ref: str) -> None:
    verify_release_tag("oliphaunt-swift", head_ref)
    manifest = prepare_staged_swift_release_manifest()
    run(
        [
            "tools/dev/bun.sh",
            "tools/release/publish_swiftpm_source_tag.mjs",
            "--target",
            head_ref,
            "--manifest",
            str(manifest.relative_to(ROOT)),
            "--include-tree",
            "target/oliphaunt-swift/release-tree",
            "--push",
        ]
    )
    upload_github_release_assets("oliphaunt-swift")


def kotlin_artifacts_published(version: str) -> bool:
    return all(
        url_exists(maven_pom_url(coordinate, version))
        for coordinate in registry_package_names("oliphaunt-kotlin", "maven")
    )


def publish_kotlin_maven(head_ref: str) -> None:
    verify_release_tag("oliphaunt-kotlin", head_ref)
    staged_kotlin_maven_repo()
    version = current_product_version("oliphaunt-kotlin")
    if kotlin_artifacts_published(version):
        print(f"dev.oliphaunt Android artifacts {version} are already published on Maven Central; skipping publishAndReleaseToMavenCentral.")
    else:
        run(
            [
                "src/sdks/kotlin/gradlew",
                "-p",
                "src/sdks/kotlin",
                ":oliphaunt:publishAndReleaseToMavenCentral",
                ":oliphaunt-android-gradle-plugin:publishAndReleaseToMavenCentral",
                f"-PoliphauntBuildRoot={ROOT / 'target/liboliphaunt-sdk-check/gradle/oliphaunt-kotlin-release'}",
                f"-PoliphauntCxxBuildRoot={ROOT / 'target/liboliphaunt-sdk-check/cxx/oliphaunt-kotlin-release'}",
                "--project-cache-dir",
                str(ROOT / "target/liboliphaunt-sdk-check/gradle-cache/oliphaunt-kotlin-release"),
                "--configuration-cache",
            ]
        )
    run(
        [
            *REGISTRY_PUBLICATION_CHECK,
            "--product",
            "oliphaunt-kotlin",
            "--require-published",
            "--retries",
            "12",
            "--retry-delay",
            "10",
        ]
    )
    upload_github_release_assets("oliphaunt-kotlin")


def publish_liboliphaunt_runtime_maven(head_ref: str) -> None:
    verify_release_tag("liboliphaunt-native", head_ref)
    ensure_liboliphaunt_release_assets()
    manifest = build_maven_artifact_manifest("liboliphaunt-native-runtime", runtime=True)
    version = current_product_version("liboliphaunt-native")
    if succeeds(
        [
            *REGISTRY_PUBLICATION_CHECK,
            "--product",
            "liboliphaunt-native",
            "--registry-kind",
            "maven",
            "--require-published",
        ]
    ):
        print(f"dev.oliphaunt.runtime artifacts {version} are already published on Maven Central; skipping publishAndReleaseToMavenCentral.")
    else:
        run_maven_artifact_publisher(
            manifest,
            ":oliphaunt-maven-artifacts:publishAndReleaseToMavenCentral",
            "liboliphaunt-native-maven-release",
        )
    run(
        [
            *REGISTRY_PUBLICATION_CHECK,
            "--product",
            "liboliphaunt-native",
            "--registry-kind",
            "maven",
            "--require-published",
            "--retries",
            "12",
            "--retry-delay",
            "10",
        ]
    )


def publish_react_native_npm(head_ref: str) -> None:
    verify_release_tag("oliphaunt-react-native", head_ref)
    version = current_product_version("oliphaunt-react-native")
    if npm_package_is_published("@oliphaunt/react-native", version):
        print(f"@oliphaunt/react-native {version} is already published on npm; skipping npm publish.")
    else:
        npm_publish_pnpm_packed_package(
            ROOT / "src/sdks/react-native",
            product="oliphaunt-react-native",
        )
    run(
        [
            *REGISTRY_PUBLICATION_CHECK,
            "--product",
            "oliphaunt-react-native",
            "--require-published",
            "--retries",
            "12",
            "--retry-delay",
            "10",
        ]
    )
    upload_github_release_assets("oliphaunt-react-native")


def publish_rust_crates_io(head_ref: str) -> None:
    if published_rerun("oliphaunt-rust", head_ref):
        print("oliphaunt-rust is already published at this commit; skipping crates.io publish.")
        return
    verify_release_tag("oliphaunt-rust", head_ref)
    version = current_product_version("oliphaunt-rust")
    verify_staged_cargo_product_crates("oliphaunt-rust", version, allow_dirty=False)
    broker_version = current_product_version("oliphaunt-broker")
    native_version = current_product_version("liboliphaunt-native")
    run(
        [
            *REGISTRY_PUBLICATION_CHECK,
            "--product",
            "liboliphaunt-native",
            "--registry-kind",
            "crates",
            "--require-published",
            "--version",
            native_version,
        ]
    )
    run(
        [
            *REGISTRY_PUBLICATION_CHECK,
            "--product",
            "oliphaunt-broker",
            "--registry-kind",
            "crates",
            "--require-published",
            "--version",
            broker_version,
        ]
    )
    cargo_publish_package("oliphaunt-build", version)
    release_manifest = prepare_oliphaunt_release_source(version)
    validate_generated_oliphaunt_release_artifact_coverage(release_manifest)
    cargo_publish_manifest("oliphaunt", version, release_manifest)
    run(
        [
            *REGISTRY_PUBLICATION_CHECK,
            "--product",
            "oliphaunt-rust",
            "--require-published",
            "--retries",
            "12",
            "--retry-delay",
            "10",
        ]
    )


def publish_broker_release_assets(head_ref: str) -> None:
    verify_release_tag("oliphaunt-broker", head_ref)
    ensure_broker_release_assets()
    assets = glob_release_assets(
        ROOT / "target/oliphaunt-broker/release-assets",
        (".tar.gz", ".zip", ".sha256"),
    )
    upload_github_release_assets("oliphaunt-broker", assets=assets)


def publish_node_direct_release_assets(head_ref: str) -> None:
    verify_release_tag("oliphaunt-node-direct", head_ref)
    ensure_node_direct_release_assets()
    asset_dir = ROOT / "target/oliphaunt-node-direct/release-assets"
    assets = glob_release_assets(asset_dir, (".tar.gz", ".zip", ".sha256"))
    upload_github_release_assets("oliphaunt-node-direct", assets=assets)


def node_direct_optional_package_targets(version: str) -> list[tuple[str, Path, ArtifactTarget]]:
    package_dirs = npm_package_dirs_under(NODE_DIRECT_PACKAGE_ROOT)
    packages: list[tuple[str, Path, ArtifactTarget]] = []
    for target in artifact_targets(
        product="oliphaunt-node-direct",
        kind="node-direct-addon",
        surface="npm-optional",
        published_only=True,
    ):
        package_name = target.npm_package
        if package_name is None:
            fail(f"{target.id} must declare npm_package for npm optional package publication")
        package_dir = package_dirs.get(package_name)
        if package_dir is None:
            fail(f"{target.id} declares unknown Node direct npm package {package_name}")
        package_json = json.loads((package_dir / "package.json").read_text(encoding="utf-8"))
        if package_json.get("name") != package_name:
            fail(f"{package_dir.relative_to(ROOT)}/package.json name must be {package_name}")
        if package_json.get("version") != version:
            fail(f"{package_name} package version must match oliphaunt-node-direct {version}")
        packages.append((package_name, package_dir, target))
    if sorted(package for package, _, _ in packages) != sorted(package_dirs):
        fail("Node direct npm optional package metadata must match published artifact targets exactly")
    return packages


def npm_package_dirs_under(package_root: Path) -> dict[str, Path]:
    packages: dict[str, Path] = {}
    for package_json_path in sorted(package_root.glob("*/package.json")):
        package_dir = package_json_path.parent
        package_json = json.loads(package_json_path.read_text(encoding="utf-8"))
        package_name = package_json.get("name")
        if not isinstance(package_name, str) or not package_name:
            fail(f"{package_json_path.relative_to(ROOT)} must declare name")
        if package_name in packages:
            fail(
                f"duplicate npm package name {package_name} in "
                f"{packages[package_name].relative_to(ROOT)} and {package_dir.relative_to(ROOT)}"
            )
        packages[package_name] = package_dir
    if not packages:
        fail(f"{package_root.relative_to(ROOT)} does not contain npm package descriptors")
    return packages


def artifact_npm_package_targets(
    product: str,
    kind: str,
    surface: str,
    package_root: Path,
) -> list[tuple[str, Path, ArtifactTarget]]:
    package_dirs = npm_package_dirs_under(package_root)
    packages: list[tuple[str, Path, ArtifactTarget]] = []
    for target in artifact_targets(product=product, kind=kind, surface=surface, published_only=True):
        package_name = target.npm_package
        if package_name is None:
            fail(f"{target.id} must declare npm_package for npm artifact package publication")
        package_dir = package_dirs.get(package_name)
        if package_dir is None:
            fail(f"{target.id} declares npm package {package_name}, but no descriptor exists under {package_root.relative_to(ROOT)}")
        packages.append((package_name, package_dir, target))
    expected = sorted(package for package, _, _ in packages)
    actual = sorted(package_dirs)
    if actual != expected:
        fail(
            f"{package_root.relative_to(ROOT)} package descriptors must match published {product} npm artifact targets for {surface}: "
            f"expected {expected}, got {actual}"
        )
    return sorted(packages, key=lambda item: item[2].target)


def safe_npm_package_filename_prefix(package_name: str) -> str:
    return package_name.removeprefix("@").replace("/", "-")


def node_direct_npm_package_dir() -> Path:
    return ROOT / "target" / "oliphaunt-node-direct" / "npm-packages"


def expected_node_direct_npm_tarball(package_name: str, version: str) -> Path:
    return node_direct_npm_package_dir() / f"{safe_npm_package_filename_prefix(package_name)}-{version}.tgz"


def validate_node_direct_optional_tarball(package_name: str, version: str, tarball: Path) -> None:
    if not tarball.is_file():
        fail(f"missing Node direct optional npm package artifact: {tarball.relative_to(ROOT)}")
    try:
        with tarfile.open(tarball, "r:gz") as archive:
            names = set(archive.getnames())
            if "package/package.json" not in names:
                fail(f"{tarball.relative_to(ROOT)} is missing package/package.json")
            if "package/prebuilds/oliphaunt_node.node" not in names:
                fail(f"{tarball.relative_to(ROOT)} is missing package/prebuilds/oliphaunt_node.node")
            package_member = archive.extractfile("package/package.json")
            if package_member is None:
                fail(f"{tarball.relative_to(ROOT)} package/package.json could not be read")
            with package_member:
                package = json.loads(package_member.read().decode("utf-8"))
            if package.get("name") != package_name:
                fail(f"{tarball.relative_to(ROOT)} package name must be {package_name}, got {package.get('name')!r}")
            if package.get("version") != version:
                fail(f"{tarball.relative_to(ROOT)} package version must be {version}, got {package.get('version')!r}")
            prebuild = archive.getmember("package/prebuilds/oliphaunt_node.node")
            if not prebuild.isfile() or prebuild.size <= 0:
                fail(f"{tarball.relative_to(ROOT)} prebuilt addon must be a non-empty regular file")
    except (tarfile.TarError, json.JSONDecodeError, UnicodeDecodeError) as error:
        fail(f"{tarball.relative_to(ROOT)} is not a valid Node direct optional npm tarball: {error}")


def validate_npm_package_metadata(
    package_name: str,
    package_dir: Path,
    version: str,
    *,
    target: str | None = None,
) -> None:
    package_json_path = package_dir / "package.json"
    if not package_json_path.is_file():
        fail(f"{package_dir.relative_to(ROOT)} is missing package.json")
    package_json = json.loads(package_json_path.read_text(encoding="utf-8"))
    if package_json.get("name") != package_name:
        fail(f"{package_json_path.relative_to(ROOT)} name must be {package_name}")
    if package_json.get("version") != version:
        fail(f"{package_name} package version must match {version}")
    if target is not None and package_json.get("oliphaunt", {}).get("target") != target:
        fail(f"{package_name} package oliphaunt.target must be {target}")
    validate_no_consumer_install_scripts(package_json, f"{package_name} npm package")


def npm_package_source_stage_dir(package_name: str) -> Path:
    safe_name = safe_npm_package_filename_prefix(package_name)
    return ROOT / "target" / "release" / "npm-package-sources" / safe_name


def stage_npm_package_descriptor(
    package_name: str,
    source_dir: Path,
    version: str,
    *,
    extra_descriptors: tuple[str, ...] = (),
    target: str | None = None,
) -> Path:
    stage_dir = npm_package_source_stage_dir(package_name)
    shutil.rmtree(stage_dir, ignore_errors=True)
    stage_dir.mkdir(parents=True, exist_ok=True)
    for descriptor in ("package.json", "README.md", *extra_descriptors):
        source = source_dir / descriptor
        if not source.is_file():
            fail(f"{source_dir.relative_to(ROOT)} is missing {descriptor}")
        shutil.copy2(source, stage_dir / descriptor)
    validate_npm_package_metadata(package_name, stage_dir, version, target=target)
    return stage_dir


def require_release_archive_file(path: Path, description: str) -> None:
    if not path.is_file():
        fail(f"missing {description}: {path.relative_to(ROOT)}")


def extract_tar_tree(archive_path: Path, source_prefix: str, destination: Path) -> None:
    require_release_archive_file(archive_path, "release archive")
    shutil.rmtree(destination, ignore_errors=True)
    destination.mkdir(parents=True, exist_ok=True)
    prefix = source_prefix.rstrip("/")
    prefix_path = PurePosixPath(prefix)
    copied_files = 0
    try:
        with tarfile.open(archive_path, "r:*") as archive:
            for member in sorted(archive.getmembers(), key=lambda item: item.name):
                member_name = member.name.rstrip("/")
                if member_name != prefix and not member_name.startswith(f"{prefix}/"):
                    continue
                relative = PurePosixPath(member_name).relative_to(prefix_path)
                if str(relative) == ".":
                    continue
                target = destination.joinpath(*relative.parts)
                if member.isdir():
                    target.mkdir(parents=True, exist_ok=True)
                    continue
                if not member.isfile():
                    fail(f"{archive_path.relative_to(ROOT)} member {member.name} must be a regular file")
                extracted = archive.extractfile(member)
                if extracted is None:
                    fail(f"{archive_path.relative_to(ROOT)} member {member.name} could not be read")
                target.parent.mkdir(parents=True, exist_ok=True)
                with extracted:
                    target.write_bytes(extracted.read())
                target.chmod(member.mode & 0o777)
                copied_files += 1
    except (KeyError, tarfile.TarError) as error:
        fail(f"{archive_path.relative_to(ROOT)} is not a readable release archive: {error}")
    if copied_files == 0:
        fail(f"{archive_path.relative_to(ROOT)} is missing archive tree {source_prefix}")


def extract_tar_file(archive_path: Path, member_name: str, destination: Path) -> None:
    require_release_archive_file(archive_path, "release archive")
    destination.parent.mkdir(parents=True, exist_ok=True)
    try:
        with tarfile.open(archive_path, "r:*") as archive:
            member = archive.getmember(member_name)
            if not member.isfile():
                fail(f"{archive_path.relative_to(ROOT)} member {member_name} must be a regular file")
            extracted = archive.extractfile(member)
            if extracted is None:
                fail(f"{archive_path.relative_to(ROOT)} member {member_name} could not be read")
            with extracted:
                destination.write_bytes(extracted.read())
            destination.chmod(member.mode & 0o777)
    except KeyError:
        fail(f"{archive_path.relative_to(ROOT)} is missing {member_name}")
    except tarfile.TarError as error:
        fail(f"{archive_path.relative_to(ROOT)} is not a readable release archive: {error}")


def extract_zip_file(
    archive_path: Path,
    member_name: str,
    destination: Path,
    *,
    mode: int | None = None,
) -> None:
    require_release_archive_file(archive_path, "release archive")
    destination.parent.mkdir(parents=True, exist_ok=True)
    try:
        with zipfile.ZipFile(archive_path) as archive:
            if member_name not in archive.namelist():
                fail(f"{archive_path.relative_to(ROOT)} is missing {member_name}")
            destination.write_bytes(archive.read(member_name))
            if mode is not None:
                destination.chmod(mode)
    except zipfile.BadZipFile as error:
        fail(f"{archive_path.relative_to(ROOT)} is not a readable release archive: {error}")


def extract_zip_tree(archive_path: Path, source_prefix: str, destination: Path) -> None:
    require_release_archive_file(archive_path, "release archive")
    shutil.rmtree(destination, ignore_errors=True)
    destination.mkdir(parents=True, exist_ok=True)
    prefix = source_prefix.rstrip("/")
    prefix_path = PurePosixPath(prefix)
    copied_files = 0
    try:
        with zipfile.ZipFile(archive_path) as archive:
            for info in sorted(archive.infolist(), key=lambda item: item.filename):
                member_name = info.filename.rstrip("/")
                if member_name != prefix and not member_name.startswith(f"{prefix}/"):
                    continue
                relative = PurePosixPath(member_name).relative_to(prefix_path)
                if str(relative) == ".":
                    continue
                target = destination.joinpath(*relative.parts)
                if info.is_dir():
                    target.mkdir(parents=True, exist_ok=True)
                    continue
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(archive.read(info))
                mode = (info.external_attr >> 16) & 0o777
                if mode:
                    target.chmod(mode)
                copied_files += 1
    except zipfile.BadZipFile as error:
        fail(f"{archive_path.relative_to(ROOT)} is not a readable release archive: {error}")
    if copied_files == 0:
        fail(f"{archive_path.relative_to(ROOT)} is missing archive tree {source_prefix}")


def packed_package_contains(
    tarball: Path,
    package_name: str,
    version: str,
    required_members: list[str],
    *,
    executable_members: tuple[str, ...] = (),
) -> None:
    try:
        with tarfile.open(tarball, "r:gz") as archive:
            names = set(archive.getnames())
            if "package/package.json" not in names:
                fail(f"{tarball.relative_to(ROOT)} is missing package/package.json")
            package_member = archive.extractfile("package/package.json")
            if package_member is None:
                fail(f"{tarball.relative_to(ROOT)} package/package.json could not be read")
            with package_member:
                package = json.loads(package_member.read().decode("utf-8"))
            if package.get("name") != package_name:
                fail(f"{tarball.relative_to(ROOT)} package name must be {package_name}, got {package.get('name')!r}")
            if package.get("version") != version:
                fail(f"{tarball.relative_to(ROOT)} package version must be {version}, got {package.get('version')!r}")
            for member in required_members:
                if member not in names:
                    fail(f"{tarball.relative_to(ROOT)} is missing {member}")
                info = archive.getmember(member)
                if not info.isfile() or info.size <= 0:
                    fail(f"{tarball.relative_to(ROOT)} {member} must be a non-empty regular file")
            for member in executable_members:
                if member not in names:
                    fail(f"{tarball.relative_to(ROOT)} is missing executable {member}")
                info = archive.getmember(member)
                if not info.isfile() or info.size <= 0 or not (info.mode & 0o111):
                    fail(f"{tarball.relative_to(ROOT)} {member} must be a non-empty executable file")
    except (tarfile.TarError, json.JSONDecodeError, UnicodeDecodeError) as error:
        fail(f"{tarball.relative_to(ROOT)} is not a valid npm tarball: {error}")


def packed_icu_package_contains(tarball: Path, package_name: str, version: str) -> None:
    try:
        with tarfile.open(tarball, "r:gz") as archive:
            names = set(archive.getnames())
            if "package/package.json" not in names:
                fail(f"{tarball.relative_to(ROOT)} is missing package/package.json")
            package_member = archive.extractfile("package/package.json")
            if package_member is None:
                fail(f"{tarball.relative_to(ROOT)} package/package.json could not be read")
            with package_member:
                package = json.loads(package_member.read().decode("utf-8"))
            if package.get("name") != package_name:
                fail(f"{tarball.relative_to(ROOT)} package name must be {package_name}, got {package.get('name')!r}")
            if package.get("version") != version:
                fail(f"{tarball.relative_to(ROOT)} package version must be {version}, got {package.get('version')!r}")
            metadata = package.get("oliphaunt", {})
            if (
                not isinstance(metadata, dict)
                or metadata.get("product") != "oliphaunt-icu"
                or metadata.get("kind") != "icu-data"
                or metadata.get("target") != "portable"
                or metadata.get("dataRelativePath") != "share/icu"
            ):
                fail(f"{tarball.relative_to(ROOT)} package.json must declare portable oliphaunt-icu metadata")
            if "package/OliphauntICU.podspec" not in names:
                fail(f"{tarball.relative_to(ROOT)} is missing package/OliphauntICU.podspec")
            icu_entries = [
                name
                for name in names
                if name.startswith("package/share/icu/")
                and PurePosixPath(name).relative_to("package/share/icu").parts
                and PurePosixPath(name).relative_to("package/share/icu").parts[0].startswith("icudt")
            ]
            if not icu_entries:
                fail(f"{tarball.relative_to(ROOT)} is missing package/share/icu/icudt* data files")
    except (tarfile.TarError, json.JSONDecodeError, UnicodeDecodeError) as error:
        fail(f"{tarball.relative_to(ROOT)} is not a valid ICU npm tarball: {error}")


def npm_pack_and_validate(
    package_name: str,
    package_dir: Path,
    version: str,
    *,
    required_members: list[str],
    executable_members: tuple[str, ...] = (),
    target: str | None = None,
) -> Path:
    validate_npm_package_metadata(package_name, package_dir, version, target=target)
    tarball = pnpm_pack_for_npm_publish(package_dir)
    packed_package_contains(
        tarball,
        package_name,
        version,
        required_members,
        executable_members=executable_members,
    )
    return tarball


def stage_liboliphaunt_npm_payloads(
    version: str,
    *,
    validate_assets: bool = True,
    targets: set[str] | None = None,
) -> dict[str, Path]:
    if validate_assets:
        ensure_liboliphaunt_release_assets()
    asset_dir = liboliphaunt_release_asset_dir()
    packages = artifact_npm_package_targets(
        "liboliphaunt-native",
        "native-runtime",
        "typescript-native-direct",
        ROOT / "src/runtimes/liboliphaunt/native/packages",
    )
    stages: dict[str, Path] = {}
    for package_name, package_dir, target in packages:
        if targets is not None and target.target not in targets:
            continue
        if target.library_relative_path is None:
            fail(f"{target.id} must declare library_relative_path for npm artifact package publication")
        stage = stage_npm_package_descriptor(
            package_name,
            package_dir,
            version,
            target=target.target,
        )
        archive = asset_dir / target.asset_name(version)
        if archive.name.endswith(".zip"):
            extract_zip_file(
                archive,
                target.library_relative_path,
                stage / target.library_relative_path,
            )
            extract_zip_tree(archive, "runtime", stage / "runtime")
        else:
            extract_tar_file(
                archive,
                target.library_relative_path,
                stage / target.library_relative_path,
            )
            extract_tar_tree(archive, "runtime", stage / "runtime")
        ensure_native_tools_absent_from_runtime(stage, target.target)
        run_native_payload_optimizer(stage, target.target, tool_set="runtime")
        stages[package_name] = stage
    return stages


def ensure_native_tools_absent_from_runtime(stage: Path, target: str) -> None:
    runtime_dir = stage / "runtime"
    leaked_tools: list[str] = []
    for tool in required_native_tools_package_tools(target, runtime_dir):
        path = runtime_dir / "bin" / tool
        if path.exists():
            leaked_tools.append(f"runtime/bin/{tool}")
    if leaked_tools:
        fail(
            f"{stage.relative_to(ROOT)} root runtime package must not contain split native tools: "
            + ", ".join(leaked_tools)
        )


def stage_liboliphaunt_tools_npm_payloads(
    version: str,
    *,
    validate_assets: bool = True,
    targets: set[str] | None = None,
) -> dict[str, Path]:
    if validate_assets:
        ensure_liboliphaunt_release_assets()
    asset_dir = liboliphaunt_release_asset_dir()
    packages = artifact_npm_package_targets(
        "liboliphaunt-native",
        "native-tools",
        "typescript-native-direct",
        ROOT / "src/runtimes/liboliphaunt/native/tools-packages",
    )
    stages: dict[str, Path] = {}
    for package_name, package_dir, target in packages:
        if targets is not None and target.target not in targets:
            continue
        stage = stage_npm_package_descriptor(
            package_name,
            package_dir,
            version,
            target=target.target,
        )
        archive = asset_dir / target.asset_name(version)
        for tool in required_native_tools_package_tools(target.target):
            member = f"runtime/bin/{tool}"
            destination = stage / member
            if archive.name.endswith(".zip"):
                extract_zip_file(archive, member, destination, mode=0o755)
            else:
                extract_tar_file(archive, member, destination)
        run_native_payload_optimizer(stage, target.target, tool_set="tools")
        stages[package_name] = stage
    return stages


def stage_liboliphaunt_icu_npm_payload(version: str, *, validate_assets: bool = True) -> Path:
    if validate_assets:
        ensure_liboliphaunt_release_assets()
    package_name = "@oliphaunt/icu"
    stage = stage_npm_package_descriptor(
        package_name,
        ROOT / "src/runtimes/liboliphaunt/native/icu-npm",
        version,
        extra_descriptors=("OliphauntICU.podspec",),
        target="portable",
    )
    extract_tar_tree(
        liboliphaunt_release_asset_dir() / f"liboliphaunt-{version}-icu-data.tar.gz",
        "share/icu",
        stage / "share/icu",
    )
    return stage


def stage_broker_npm_payloads(
    version: str,
    *,
    validate_assets: bool = True,
    targets: set[str] | None = None,
) -> dict[str, Path]:
    if validate_assets:
        ensure_broker_release_assets()
    asset_dir = ROOT / "target" / "oliphaunt-broker" / "release-assets"
    packages = artifact_npm_package_targets(
        "oliphaunt-broker",
        "broker-helper",
        "typescript-broker",
        ROOT / "src/runtimes/broker/packages",
    )
    stages: dict[str, Path] = {}
    for package_name, package_dir, target in packages:
        if targets is not None and target.target not in targets:
            continue
        if target.executable_relative_path is None:
            fail(f"{target.id} must declare executable_relative_path for npm artifact package publication")
        stage = stage_npm_package_descriptor(
            package_name,
            package_dir,
            version,
            target=target.target,
        )
        archive = asset_dir / target.asset_name(version)
        if archive.name.endswith(".zip"):
            extract_zip_file(
                archive,
                target.executable_relative_path,
                stage / target.executable_relative_path,
                mode=0o755,
            )
        else:
            extract_tar_file(
                archive,
                target.executable_relative_path,
                stage / target.executable_relative_path,
            )
        stages[package_name] = stage
    return stages


def npm_publish_packages(package_tarballs: list[tuple[str, Path]], version: str) -> None:
    for package_name, tarball in package_tarballs:
        if npm_package_is_published(package_name, version):
            print(f"{package_name} {version} is already published on npm; skipping npm publish.")
            continue
        run(["npm", "publish", str(tarball), "--access", "public", "--provenance"])


def node_direct_optional_npm_tarballs(version: str) -> list[tuple[str, Path]]:
    tarballs: list[tuple[str, Path]] = []
    for package_name, _package_dir, _target in node_direct_optional_package_targets(version):
        tarball = expected_node_direct_npm_tarball(package_name, version)
        validate_node_direct_optional_tarball(package_name, version, tarball)
        tarballs.append((package_name, tarball))
    unexpected = sorted(
        path.name
        for path in node_direct_npm_package_dir().glob("*.tgz")
        if path not in {tarball for _, tarball in tarballs}
    )
    if unexpected:
        fail("unexpected Node direct optional npm package artifact(s): " + ", ".join(unexpected))
    return tarballs


def liboliphaunt_npm_tarballs(
    version: str,
    *,
    validate_assets: bool = True,
    targets: set[str] | None = None,
    include_icu: bool = True,
) -> list[tuple[str, Path]]:
    packages: list[tuple[str, Path]] = []
    stages = stage_liboliphaunt_npm_payloads(
        version,
        validate_assets=validate_assets,
        targets=targets,
    )
    tools_stages = stage_liboliphaunt_tools_npm_payloads(
        version,
        validate_assets=validate_assets,
        targets=targets,
    )
    for package_name, _package_dir, target in artifact_npm_package_targets(
        "liboliphaunt-native",
        "native-runtime",
        "typescript-native-direct",
        ROOT / "src/runtimes/liboliphaunt/native/packages",
    ):
        if targets is not None and target.target not in targets:
            continue
        if target.library_relative_path is None:
            fail(f"{target.id} must declare library_relative_path for npm artifact package publication")
        runtime_members = required_runtime_member_paths(
            target.target,
            prefix="package/runtime/bin",
        )
        required_members = [f"package/{target.library_relative_path}", *runtime_members]
        package_dir = stages[package_name]
        tarball = npm_pack_and_validate(
            package_name,
            package_dir,
            version,
            required_members=required_members,
            executable_members=tuple(runtime_members),
            target=target.target,
        )
        packages.append((package_name, tarball))
    for package_name, _package_dir, target in artifact_npm_package_targets(
        "liboliphaunt-native",
        "native-tools",
        "typescript-native-direct",
        ROOT / "src/runtimes/liboliphaunt/native/tools-packages",
    ):
        if targets is not None and target.target not in targets:
            continue
        runtime_members = required_tools_member_paths(
            target.target,
            prefix="package/runtime/bin",
        )
        tarball = npm_pack_and_validate(
            package_name,
            tools_stages[package_name],
            version,
            required_members=runtime_members,
            executable_members=tuple(runtime_members),
            target=target.target,
        )
        packages.append((package_name, tarball))
    if include_icu:
        icu_package = "@oliphaunt/icu"
        icu_stage = stage_liboliphaunt_icu_npm_payload(version, validate_assets=validate_assets)
        icu_tarball = pnpm_pack_for_npm_publish(icu_stage)
        packed_icu_package_contains(icu_tarball, icu_package, version)
        packages.append((icu_package, icu_tarball))
    return packages


def broker_npm_tarballs(
    version: str,
    *,
    validate_assets: bool = True,
    targets: set[str] | None = None,
) -> list[tuple[str, Path]]:
    packages: list[tuple[str, Path]] = []
    stages = stage_broker_npm_payloads(
        version,
        validate_assets=validate_assets,
        targets=targets,
    )
    for package_name, _package_dir, target in artifact_npm_package_targets(
        "oliphaunt-broker",
        "broker-helper",
        "typescript-broker",
        ROOT / "src/runtimes/broker/packages",
    ):
        if targets is not None and target.target not in targets:
            continue
        if target.executable_relative_path is None:
            fail(f"{target.id} must declare executable_relative_path for npm artifact package publication")
        required_members = [f"package/{target.executable_relative_path}"]
        tarball = npm_pack_and_validate(
            package_name,
            stages[package_name],
            version,
            required_members=required_members,
            executable_members=tuple(required_members),
            target=target.target,
        )
        packages.append((package_name, tarball))
    return packages


def broker_cargo_artifact_crates(version: str) -> list[tuple[str, Path, Path]]:
    ensure_broker_release_assets()
    output_dir = ROOT / "target" / "oliphaunt-broker" / "cargo-artifacts"
    run(
        [
            "tools/dev/bun.sh",
            "tools/release/package_broker_cargo_artifacts.mjs",
            "--version",
            version,
            "--output-dir",
            str(output_dir.relative_to(ROOT)),
        ]
    )
    packages: list[tuple[str, Path, Path]] = []
    source_root = ROOT / "target" / "oliphaunt-broker" / "cargo-package-sources"
    expected_crates = {
        broker_cargo_package_name(target.target)
        for target in artifact_targets(
            product="oliphaunt-broker",
            kind="broker-helper",
            surface="rust-broker",
            published_only=True,
        )
    }
    configured_crates = set(cratesio_product_crates("oliphaunt-broker"))
    if configured_crates != expected_crates:
        fail(
            "oliphaunt-broker crates.io packages must match broker artifact targets: "
            f"expected={sorted(expected_crates)}, configured={sorted(configured_crates)}"
        )
    expected_paths = set()
    for crate in sorted(expected_crates):
        crate_path = output_dir / f"{crate}-{version}.crate"
        expected_paths.add(crate_path)
        manifest_path = source_root / crate / "Cargo.toml"
        if not crate_path.is_file():
            fail(f"missing generated broker Cargo artifact crate: {crate_path.relative_to(ROOT)}")
        if not manifest_path.is_file():
            fail(f"missing generated broker Cargo artifact manifest: {manifest_path.relative_to(ROOT)}")
        packages.append((crate, crate_path, manifest_path))
    unexpected = sorted(
        path.name
        for path in output_dir.glob("*.crate")
        if path not in expected_paths
    )
    if unexpected:
        fail("unexpected broker Cargo artifact crate(s): " + ", ".join(unexpected))
    return packages


def liboliphaunt_cargo_artifact_crates(version: str) -> list[tuple[str, Path | None, Path, str]]:
    ensure_liboliphaunt_release_assets()
    output_dir = ROOT / "target" / "liboliphaunt" / "cargo-artifacts"
    run(
        [
            "tools/dev/bun.sh",
            "tools/release/package-liboliphaunt-cargo-artifacts.mjs",
            "--version",
            version,
            "--output-dir",
            str(output_dir.relative_to(ROOT)),
        ]
    )
    manifest_path = output_dir / "packages.json"
    if not manifest_path.is_file():
        fail(f"missing generated liboliphaunt Cargo artifact manifest: {manifest_path.relative_to(ROOT)}")
    data = json.loads(manifest_path.read_text(encoding="utf-8"))
    packages_data = data.get("packages")
    if data.get("schema") != "oliphaunt-liboliphaunt-cargo-artifacts-v1" or not isinstance(packages_data, list):
        fail(f"{manifest_path.relative_to(ROOT)} has an invalid schema")

    packages: list[tuple[str, Path | None, Path, str]] = []
    native_targets = artifact_targets(
        product="liboliphaunt-native",
        kind="native-runtime",
        surface="rust-native-direct",
        published_only=True,
    )
    expected_aggregators = {
        liboliphaunt_cargo_package_name(target.target)
        for target in native_targets
    } | {
        liboliphaunt_cargo_package_name(
            target.target,
            package_base=LIBOLIPHAUNT_TOOLS_PRODUCT,
        )
        for target in native_targets
    }
    expected_facades = {LIBOLIPHAUNT_TOOLS_PRODUCT}
    expected_registry_crates = expected_aggregators | expected_facades
    configured_crates = set(cratesio_product_crates("liboliphaunt-native"))
    if configured_crates != expected_registry_crates:
        fail(
            "liboliphaunt-native crates.io packages must match native Rust runtime/tool artifact targets: "
            f"expected={sorted(expected_registry_crates)}, configured={sorted(configured_crates)}"
        )

    seen_aggregators: set[str] = set()
    seen_facades: set[str] = set()
    expected_part_crates: set[Path] = set()
    for item in packages_data:
        if not isinstance(item, dict):
            fail(f"{manifest_path.relative_to(ROOT)} packages entries must be objects")
        name = item.get("name")
        role = item.get("role")
        raw_manifest = item.get("manifestPath")
        raw_crate = item.get("cratePath")
        if not isinstance(name, str) or not isinstance(role, str) or not isinstance(raw_manifest, str):
            fail(f"{manifest_path.relative_to(ROOT)} has an invalid package row: {item!r}")
        source_manifest = ROOT / raw_manifest
        if not source_manifest.is_file():
            fail(f"missing generated liboliphaunt Cargo source manifest: {raw_manifest}")
        crate_path = ROOT / raw_crate if isinstance(raw_crate, str) else None
        if role == "part":
            if crate_path is None or not crate_path.is_file():
                fail(f"missing generated liboliphaunt part crate for {name}")
            expected_part_crates.add(crate_path)
        elif role == "aggregator":
            if name not in expected_aggregators:
                fail(f"unexpected liboliphaunt native artifact aggregator crate {name}")
            if crate_path is not None:
                fail(f"liboliphaunt native artifact aggregator {name} must publish from source after part crates")
            seen_aggregators.add(name)
        elif role == "facade":
            if name not in expected_facades:
                fail(f"unexpected liboliphaunt native tools facade crate {name}")
            if crate_path is not None:
                fail(f"liboliphaunt native tools facade {name} must publish from source after target tool crates")
            seen_facades.add(name)
        else:
            fail(f"unsupported liboliphaunt generated Cargo artifact role {role!r}")
        packages.append((name, crate_path, source_manifest, role))
    if seen_aggregators != expected_aggregators:
        fail(
            "generated liboliphaunt native artifact aggregators do not match configured crates: "
            f"expected={sorted(expected_aggregators)}, generated={sorted(seen_aggregators)}"
        )
    if seen_facades != expected_facades:
        fail(
            "generated liboliphaunt native tools facades do not match configured crates: "
            f"expected={sorted(expected_facades)}, generated={sorted(seen_facades)}"
        )
    unexpected = sorted(
        path.name
        for path in output_dir.glob("*.crate")
        if path not in expected_part_crates
    )
    if unexpected:
        fail("unexpected liboliphaunt native Cargo artifact part crate(s): " + ", ".join(unexpected))
    return packages


def liboliphaunt_wasix_cargo_artifact_crates(version: str) -> list[tuple[str, Path, Path]]:
    validate_wasix_release_assets()
    output_dir = ROOT / "target" / "oliphaunt-wasix" / "cargo-artifacts"
    run(
        [
            "tools/dev/bun.sh",
            "tools/release/package_liboliphaunt_wasix_cargo_artifacts.mjs",
            "--version",
            version,
            "--output-dir",
            str(output_dir.relative_to(ROOT)),
        ]
    )
    manifest_path = output_dir / "packages.json"
    if not manifest_path.is_file():
        fail(f"missing generated liboliphaunt-wasix Cargo artifact manifest: {manifest_path.relative_to(ROOT)}")
    data = json.loads(manifest_path.read_text(encoding="utf-8"))
    packages_data = data.get("packages")
    if data.get("schema") != wasix_cargo_artifact_schema() or not isinstance(packages_data, list):
        fail(f"{manifest_path.relative_to(ROOT)} has an invalid schema")

    expected_base_crates = set(
        wasix_public_cargo_package_names()
    )
    configured_crates = set(cratesio_product_crates("liboliphaunt-wasix"))
    if configured_crates != expected_base_crates:
        fail(
            "liboliphaunt-wasix crates.io packages must match WASIX runtime/AOT artifact packages: "
            f"expected={sorted(expected_base_crates)}, configured={sorted(configured_crates)}"
        )
    generated_crates: set[str] = set()
    expected_crate_paths: set[Path] = set()
    packages: list[tuple[str, Path, Path]] = []
    for item in packages_data:
        if not isinstance(item, dict):
            fail(f"{manifest_path.relative_to(ROOT)} packages entries must be objects")
        name = item.get("name")
        role = item.get("role")
        kind = item.get("kind")
        raw_manifest = item.get("manifestPath")
        raw_crate = item.get("cratePath")
        if not isinstance(name, str) or not isinstance(role, str) or not isinstance(kind, str) or not isinstance(raw_manifest, str):
            fail(f"{manifest_path.relative_to(ROOT)} has an invalid package row: {item!r}")
        if role != "artifact":
            fail(f"{manifest_path.relative_to(ROOT)} must contain direct WASIX artifact packages, got role {role!r}")
        if name not in expected_base_crates and not (
            kind == "wasix-extension"
            and any(name == f"{product}-wasix" for product in extension_product_ids())
        ) and not (
            kind == "wasix-extension-aot"
            and any(name.startswith(f"{product}-wasix-aot-") for product in extension_product_ids())
        ):
            fail(f"unexpected liboliphaunt-wasix Cargo artifact crate {name}")
        if kind not in {"wasix-runtime", "wasix-tools", "wasix-aot", "wasix-tools-aot", "icu-data", "wasix-extension", "wasix-extension-aot"}:
            fail(f"{manifest_path.relative_to(ROOT)} has unsupported WASIX Cargo artifact kind {kind!r}")
        source_manifest = ROOT / raw_manifest
        if not source_manifest.is_file():
            fail(f"missing generated liboliphaunt-wasix Cargo source manifest: {raw_manifest}")
        if not isinstance(raw_crate, str):
            fail(f"generated liboliphaunt-wasix Cargo artifact {name} must have a cratePath")
        crate_path = ROOT / raw_crate
        if not crate_path.is_file():
            fail(f"missing generated liboliphaunt-wasix Cargo artifact crate for {name}: {raw_crate}")
        generated_crates.add(name)
        expected_crate_paths.add(crate_path)
        packages.append((name, crate_path, source_manifest))
    missing_base_crates = expected_base_crates - generated_crates
    if missing_base_crates:
        fail(
            "generated liboliphaunt-wasix Cargo artifacts are missing configured runtime crates: "
            f"missing={sorted(missing_base_crates)}, generated={sorted(generated_crates)}"
        )
    unexpected = sorted(
        path.name
        for path in output_dir.glob("*.crate")
        if path not in expected_crate_paths
    )
    if unexpected:
        fail("unexpected liboliphaunt-wasix Cargo artifact crate(s): " + ", ".join(unexpected))
    return packages


def publish_liboliphaunt_cargo_artifacts(head_ref: str) -> None:
    verify_release_tag("liboliphaunt-native", head_ref)
    version = current_product_version("liboliphaunt-native")
    packages = liboliphaunt_cargo_artifact_crates(version)
    for crate, _crate_path, manifest_path, role in packages:
        if role == "part":
            cargo_publish_manifest(crate, version, manifest_path)
    for crate, _crate_path, manifest_path, role in packages:
        if role == "aggregator":
            cargo_publish_manifest(crate, version, manifest_path)
    for crate, _crate_path, manifest_path, role in packages:
        if role == "facade":
            cargo_publish_manifest(crate, version, manifest_path)
    verify_generated_cratesio_packages_published(
        "liboliphaunt-native",
        [crate for crate, _crate_path, _manifest_path, _role in packages],
        version,
    )
    run(
        [
            *REGISTRY_PUBLICATION_CHECK,
            "--product",
            "liboliphaunt-native",
            "--registry-kind",
            "crates",
            "--require-published",
            "--retries",
            "12",
            "--retry-delay",
            "10",
        ]
    )


def publish_liboliphaunt_wasix_cargo_artifacts(head_ref: str) -> None:
    verify_release_tag("liboliphaunt-wasix", head_ref)
    version = current_product_version("liboliphaunt-wasix")
    packages = liboliphaunt_wasix_cargo_artifact_crates(version)
    for crate, _crate_path, manifest_path in packages:
        cargo_publish_manifest(crate, version, manifest_path)
    verify_generated_cratesio_packages_published(
        "liboliphaunt-wasix",
        [crate for crate, _crate_path, _manifest_path in packages],
        version,
    )
    run(
        [
            *REGISTRY_PUBLICATION_CHECK,
            "--product",
            "liboliphaunt-wasix",
            "--registry-kind",
            "crates",
            "--require-published",
            "--retries",
            "12",
            "--retry-delay",
            "10",
        ]
    )


def publish_broker_cargo_artifacts(head_ref: str) -> None:
    verify_release_tag("oliphaunt-broker", head_ref)
    version = current_product_version("oliphaunt-broker")
    for crate, _crate_path, manifest_path in broker_cargo_artifact_crates(version):
        cargo_publish_manifest(crate, version, manifest_path)
    run(
        [
            *REGISTRY_PUBLICATION_CHECK,
            "--product",
            "oliphaunt-broker",
            "--registry-kind",
            "crates",
            "--require-published",
            "--retries",
            "12",
            "--retry-delay",
            "10",
        ]
    )


def publish_node_direct_npm_optional_packages(head_ref: str) -> None:
    verify_release_tag("oliphaunt-node-direct", head_ref)
    version = current_product_version("oliphaunt-node-direct")
    ensure_node_direct_release_assets()
    tarballs = node_direct_optional_npm_tarballs(version)
    for package_name, tarball in tarballs:
        if npm_package_is_published(package_name, version):
            print(f"{package_name} {version} is already published on npm; skipping npm publish.")
            continue
        run(["npm", "publish", str(tarball), "--access", "public", "--provenance"])
    run(
        [
            *REGISTRY_PUBLICATION_CHECK,
            "--product",
            "oliphaunt-node-direct",
            "--require-published",
            "--retries",
            "12",
            "--retry-delay",
            "10",
        ]
    )


def publish_liboliphaunt_npm_packages(head_ref: str) -> None:
    verify_release_tag("liboliphaunt-native", head_ref)
    version = current_product_version("liboliphaunt-native")
    npm_publish_packages(liboliphaunt_npm_tarballs(version), version)
    run(
        [
            *REGISTRY_PUBLICATION_CHECK,
            "--product",
            "liboliphaunt-native",
            "--registry-kind",
            "npm",
            "--require-published",
            "--retries",
            "12",
            "--retry-delay",
            "10",
        ]
    )


def publish_broker_npm_packages(head_ref: str) -> None:
    verify_release_tag("oliphaunt-broker", head_ref)
    version = current_product_version("oliphaunt-broker")
    npm_publish_packages(broker_npm_tarballs(version), version)
    run(
        [
            *REGISTRY_PUBLICATION_CHECK,
            "--product",
            "oliphaunt-broker",
            "--registry-kind",
            "npm",
            "--require-published",
            "--retries",
            "12",
            "--retry-delay",
            "10",
        ]
    )


def publish_typescript_npm_jsr(head_ref: str) -> None:
    verify_release_tag("oliphaunt-js", head_ref)
    run(
        [
            "tools/dev/bun.sh",
            "tools/release/check_release_versions.mjs",
            "--products-json",
            '["oliphaunt-js"]',
            "--head-ref",
            head_ref,
            "--check-registries",
        ]
    )
    version = current_product_version("oliphaunt-js")
    if npm_package_is_published("@oliphaunt/ts", version):
        print(f"@oliphaunt/ts {version} is already published on npm; skipping npm publish.")
    else:
        npm_publish_pnpm_packed_package(ROOT / "src/sdks/js", product="oliphaunt-js")
    if succeeds(
        [
            *REGISTRY_PUBLICATION_CHECK,
            "--product",
            "oliphaunt-js",
            "--registry-kind",
            "jsr",
            "--require-published",
        ]
    ):
        print(f"jsr:@oliphaunt/ts {version} is already published; skipping jsr publish.")
    else:
        jsr_source = staged_jsr_source_dir("oliphaunt-js") or (ROOT / "src/sdks/js")
        run(["pnpm", "exec", "jsr", "publish"], cwd=jsr_source)
    run(
        [
            *REGISTRY_PUBLICATION_CHECK,
            "--product",
            "oliphaunt-js",
            "--require-published",
            "--retries",
            "12",
            "--retry-delay",
            "10",
        ]
    )
    upload_github_release_assets("oliphaunt-js", assets=[])


def publish_wasm_release_assets() -> None:
    validate_wasix_release_assets()
    asset_dir = wasix_release_asset_dir()
    assets = glob_release_assets(asset_dir, (".tar.zst", ".sha256"))
    upload_github_release_assets("liboliphaunt-wasix", assets=assets)


def publish_extension_release_assets(product: str, head_ref: str) -> None:
    verify_release_tag(product, head_ref)
    upload_github_release_assets(product, assets=extension_asset_paths(product))


def publish_selected_extension_release_assets(products: list[str], head_ref: str) -> None:
    extensions = selected_extension_products(products)
    if not extensions:
        fail("no extension products selected")
    for product in extensions:
        verify_release_tag(product, head_ref)
        upload_github_release_assets(product, assets=extension_asset_paths(product))


def extension_maven_artifacts_published(products: list[str]) -> bool:
    return succeeds(
        [
            *REGISTRY_PUBLICATION_CHECK,
            "--products-json",
            json.dumps(products),
            "--registry-kind",
            "maven",
            "--require-published",
        ]
    )


def require_extension_maven_artifacts_published(products: list[str]) -> None:
    run(
        [
            *REGISTRY_PUBLICATION_CHECK,
            "--products-json",
            json.dumps(products),
            "--registry-kind",
            "maven",
            "--require-published",
            "--retries",
            "12",
            "--retry-delay",
            "10",
        ]
    )


def publish_selected_extension_maven(products: list[str], head_ref: str) -> None:
    extensions = selected_extension_products(products)
    if not extensions:
        fail("no extension products selected")
    for product in extensions:
        verify_release_tag(product, head_ref)
        ensure_extension_release_package(product)
    manifest = build_maven_artifact_manifest(
        "selected-extensions",
        extensions=True,
        extension_products=extensions,
    )
    if extension_maven_artifacts_published(extensions):
        print("selected Oliphaunt extension Android artifacts are already published on Maven Central; skipping publishAndReleaseToMavenCentral.")
    else:
        run_maven_artifact_publisher(
            manifest,
            ":oliphaunt-maven-artifacts:publishAndReleaseToMavenCentral",
            "oliphaunt-extensions-maven-release",
        )
    require_extension_maven_artifacts_published(extensions)


def command_publish_product_step(args: argparse.Namespace) -> None:
    product = args.product
    step = args.step
    head_ref = args.head_ref
    if product is None or step is None:
        fail("publish product step requires --product and --step")
    known = set(product_ids())
    if product not in known:
        fail(f"unknown release product: {product}")

    if product == "liboliphaunt-native" and step == "github-release-assets":
        publish_liboliphaunt_github_assets(head_ref)
    elif product == "liboliphaunt-native" and step == "npm":
        publish_liboliphaunt_npm_packages(head_ref)
    elif product == "liboliphaunt-native" and step == "maven-central":
        publish_liboliphaunt_runtime_maven(head_ref)
    elif product == "liboliphaunt-native" and step == "crates-io":
        publish_liboliphaunt_cargo_artifacts(head_ref)
    elif product == "liboliphaunt-wasix" and step == "github-release-assets":
        verify_release_tag("liboliphaunt-wasix", head_ref)
        publish_wasm_release_assets()
    elif product == "liboliphaunt-wasix" and step == "crates-io":
        publish_liboliphaunt_wasix_cargo_artifacts(head_ref)
    elif product == "oliphaunt-swift" and step == "github-release":
        publish_swift_release(head_ref)
    elif product == "oliphaunt-kotlin" and step == "maven-central":
        publish_kotlin_maven(head_ref)
    elif product == "oliphaunt-react-native" and step == "npm":
        publish_react_native_npm(head_ref)
    elif product == "oliphaunt-rust" and step == "crates-io":
        publish_rust_crates_io(head_ref)
    elif product == "oliphaunt-broker" and step == "github-release-assets":
        publish_broker_release_assets(head_ref)
    elif product == "oliphaunt-broker" and step == "crates-io":
        publish_broker_cargo_artifacts(head_ref)
    elif product == "oliphaunt-broker" and step == "npm":
        publish_broker_npm_packages(head_ref)
    elif product == "oliphaunt-node-direct" and step == "github-release-assets":
        publish_node_direct_release_assets(head_ref)
    elif product == "oliphaunt-node-direct" and step == "npm":
        publish_node_direct_npm_optional_packages(head_ref)
    elif product == "oliphaunt-js" and step == "npm-jsr":
        publish_typescript_npm_jsr(head_ref)
    elif product == "oliphaunt-wasix-rust" and step == "crates-io":
        publish_wasm_crates_io(head_ref)
    elif is_extension_product(product) and step == "github-release-assets":
        publish_extension_release_assets(product, head_ref)
    elif is_extension_product(product) and step == "maven-central":
        publish_selected_extension_maven([product], head_ref)
    else:
        fail(f"unsupported publish step {product}:{step}")


def command_publish_dry_run(args: argparse.Namespace, passthrough: list[str]) -> None:
    command_check([])
    products = selected_products_from_passthrough(passthrough)
    if products:
        command_check_registries(passthrough)
        run_product_publish_dry_runs(
            products,
            allow_dirty=args.allow_dirty,
            head_ref=passthrough_value(passthrough, "--head-ref") or "HEAD",
        )
        return
    if args.wasm:
        run_wasm_release_dry_run(args.allow_dirty)
    if passthrough:
        command_check_registries(passthrough)


def command_publish(args: argparse.Namespace, passthrough: list[str]) -> None:
    products = selected_products_from_passthrough(passthrough)
    if args.step == "github-release-assets" and not args.product and selected_extension_products(products):
        publish_selected_extension_release_assets(products, args.head_ref)
        return
    if args.step == "maven-central" and not args.product and selected_extension_products(products):
        publish_selected_extension_maven(products, args.head_ref)
        return
    if args.product or args.step:
        command_publish_product_step(args)
        return
    products_args = passthrough
    run(["tools/release/check_publish_environment.mjs", *products_args])
    command_publish_dry_run(args, passthrough)
    print("publish environment and dry-run checks passed; package-native publish steps run in the Release workflow")


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    for name in [
        "check",
        "check-registries",
        "consumer-shape",
        "verify-release",
    ]:
        subparsers.add_parser(name, add_help=False)

    dry_run = subparsers.add_parser("publish-dry-run")
    dry_run.add_argument("--wasm", action="store_true")
    dry_run.add_argument("--allow-dirty", action="store_true")

    publish = subparsers.add_parser("publish")
    publish.add_argument("--wasm", action="store_true")
    publish.add_argument("--allow-dirty", action="store_true")
    publish.add_argument("--product")
    publish.add_argument("--step")
    publish.add_argument("--head-ref", default="HEAD")

    args, passthrough = parser.parse_known_args(argv)
    command = args.command

    if command == "check":
        command_check(passthrough)
    elif command == "check-registries":
        command_check_registries(passthrough)
    elif command == "consumer-shape":
        command_consumer_shape(passthrough)
    elif command == "verify-release":
        command_verify_release(passthrough)
    elif command == "publish-dry-run":
        command_publish_dry_run(args, passthrough)
    elif command == "publish":
        command_publish(args, passthrough)
    else:
        fail(f"unknown command {command}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
