#!/usr/bin/env python3
"""Single public release CLI for Oliphaunt product releases."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tarfile
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator, NoReturn

import artifact_targets
import check_cratesio_publication
import extension_artifact_targets
import product_metadata
import release_plan


ROOT = Path(__file__).resolve().parents[2]
EXTENSION_PRODUCT_PREFIX = "oliphaunt-extension-"
NODE_DIRECT_PACKAGE_DIRS = {
    "@oliphaunt/node-direct-darwin-arm64": ROOT / "src/runtimes/node-direct/packages/darwin-arm64",
    "@oliphaunt/node-direct-linux-x64-gnu": ROOT / "src/runtimes/node-direct/packages/linux-x64-gnu",
    "@oliphaunt/node-direct-linux-arm64-gnu": ROOT / "src/runtimes/node-direct/packages/linux-arm64-gnu",
    "@oliphaunt/node-direct-win32-x64-msvc": ROOT / "src/runtimes/node-direct/packages/win32-x64-msvc",
}
WASIX_ASSETS_CRATE_PAYLOAD_DIR = (
    ROOT / "src/runtimes/liboliphaunt/wasix/crates/assets/payload"
)
WASIX_AOT_CRATES_DIR = ROOT / "src/runtimes/liboliphaunt/wasix/crates/aot"


def fail(message: str) -> NoReturn:
    print(f"release.py: {message}", file=sys.stderr)
    raise SystemExit(2)


def run(args: list[str], *, cwd: Path = ROOT, env: dict[str, str] | None = None) -> None:
    print("\n==> " + " ".join(args), flush=True)
    result = subprocess.run(args, cwd=cwd, env=env, check=False)
    if result.returncode != 0:
        raise SystemExit(result.returncode)


def output(args: list[str], *, cwd: Path = ROOT) -> str:
    return subprocess.check_output(args, cwd=cwd, text=True).strip()


def succeeds(args: list[str], *, cwd: Path = ROOT) -> bool:
    result = subprocess.run(args, cwd=cwd, text=True, capture_output=True, check=False)
    return result.returncode == 0


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


def staged_swift_release_artifacts() -> tuple[Path, Path]:
    matches = require_staged_sdk_artifact("oliphaunt-swift", "Swift package", (".zip", ".release"))
    source_archives = [path for path in matches if path.name == "Oliphaunt-source.zip"]
    manifests = [path for path in matches if path.name == "Package.swift.release"]
    if len(source_archives) != 1 or len(manifests) != 1:
        fail(
            "oliphaunt-swift release requires exactly one staged Oliphaunt-source.zip "
            "and one staged Package.swift.release under target/sdk-artifacts/oliphaunt-swift"
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
    return source_archives[0], manifests[0]


def prepare_staged_swift_release_manifest() -> Path:
    _source_archive, staged_manifest = staged_swift_release_artifacts()
    output_dir = ROOT / "target" / "oliphaunt-swift"
    release_tree = output_dir / "release-tree"
    shutil.rmtree(release_tree, ignore_errors=True)
    release_tree.mkdir(parents=True, exist_ok=True)
    output_manifest = output_dir / "Package.swift.release"
    shutil.copy2(staged_manifest, output_manifest)
    return output_manifest


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def staged_cargo_crate(product: str) -> Path:
    matches = require_staged_sdk_artifact(product, "Cargo package", (".crate",))
    if len(matches) != 1:
        fail(f"{product} staged Cargo artifacts must contain exactly one .crate, got {len(matches)}")
    return matches[0]


def verify_staged_cargo_crate_identity(
    product: str,
    package: str,
    version: str,
    *,
    allow_dirty: bool,
) -> None:
    staged = staged_cargo_crate(product)
    expected_name = f"{package}-{version}.crate"
    if staged.name != expected_name:
        fail(f"{product} staged Cargo crate must be named {expected_name}, got {staged.name}")
    print(f"validated staged Cargo crate identity: {product} -> {staged.relative_to(ROOT)}")


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
    package_dir = ROOT / product_metadata.package_path(product)
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


def host_aot_manifest(target: str) -> Path | None:
    candidates = [
        ROOT / "target" / "oliphaunt-wasix" / "aot" / target / "manifest.json",
        ROOT / "src" / "runtimes" / "liboliphaunt" / "wasix" / "crates" / "aot" / target / "artifacts" / "manifest.json",
    ]
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    return None


def wasm_aot_target_triples() -> list[str]:
    matrix = json.loads(xtask(["assets", "ci-matrix", "--target", "all"], quiet=True))
    include = matrix.get("include")
    if not isinstance(include, list):
        fail("WASIX AOT CI matrix did not contain an include list")
    targets: list[str] = []
    for item in include:
        if not isinstance(item, dict) or not isinstance(item.get("target"), str):
            fail("WASIX AOT CI matrix target entries must contain raw target triples")
        targets.append(item["target"])
    return targets


def wasix_runtime_internal_packages() -> list[str]:
    packages = output(
        ["cargo", "run", "--quiet", "-p", "xtask", "--", "assets", "internal-packages"]
    )
    return [line.strip() for line in packages.splitlines() if line.strip()]


def require_release_portable_assets() -> None:
    manifest = ROOT / "target" / "oliphaunt-wasix" / "assets" / "manifest.json"
    if not manifest.is_file():
        fail("missing release portable assets; download or build CI workflow WASM runtime outputs first")


def require_release_aot_artifacts() -> None:
    for target in wasm_aot_target_triples():
        manifest = host_aot_manifest(target)
        if manifest is None:
            fail(f"missing release AOT artifacts for {target}")


def copy_clean_tree(source: Path, destination: Path) -> None:
    if not source.is_dir():
        fail(f"release payload source directory does not exist: {source.relative_to(ROOT)}")
    if destination.exists():
        shutil.rmtree(destination)
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(source, destination)


def clean_wasix_runtime_crate_payloads() -> None:
    shutil.rmtree(WASIX_ASSETS_CRATE_PAYLOAD_DIR, ignore_errors=True)
    for target in wasm_aot_target_triples():
        shutil.rmtree(WASIX_AOT_CRATES_DIR / target / "artifacts", ignore_errors=True)


@contextmanager
def materialized_wasix_runtime_crate_payloads() -> Iterator[None]:
    copy_clean_tree(ROOT / "target/oliphaunt-wasix/assets", WASIX_ASSETS_CRATE_PAYLOAD_DIR)
    for target in wasm_aot_target_triples():
        copy_clean_tree(
            ROOT / "target/oliphaunt-wasix/aot" / target,
            WASIX_AOT_CRATES_DIR / target / "artifacts",
        )
    try:
        yield
    finally:
        clean_wasix_runtime_crate_payloads()


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
    known = set(product_metadata.product_ids())
    unknown = sorted(set(value) - known)
    if unknown:
        fail(f"unknown release products: {', '.join(unknown)}")
    selected = set(value)
    graph = release_plan.load_graph()
    return release_plan.release_order(graph["products"], graph["moon_projects"], selected)


def product_tag(product: str) -> str:
    return f"{product_metadata.tag_prefix(product)}{product_metadata.read_current_version(product)}"


def is_extension_product(product: str) -> bool:
    return product.startswith(EXTENSION_PRODUCT_PREFIX)


def selected_extension_products(products: list[str]) -> list[str]:
    return sorted(product for product in products if is_extension_product(product))


def extension_sql_name(product: str) -> str:
    config = product_metadata.product_config(product)
    value = config.get("extension_sql_name")
    if not isinstance(value, str) or not value:
        fail(f"{product} release metadata must declare extension_sql_name")
    return value


def github_output(values: dict[str, str]) -> None:
    for key, value in values.items():
        print(f"{key}={value}")


def current_product_version(product: str) -> str:
    return product_metadata.read_current_version(product)


def verify_release_tag(product: str, head_ref: str) -> None:
    run(["tools/release/verify_product_tag.py", product, "--target", head_ref])


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
        "tools/release/upload_github_release_assets.py",
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
        [
            "tools/release/check_registry_publication.py",
            "--product",
            product,
            "--require-published",
        ]
    )


def published_rerun(product: str, head_ref: str) -> bool:
    return product_tag_points_at(product, head_ref) and product_registry_is_published(product)


def wait_for_cratesio_package(crate: str, version: str, *, retries: int = 12, retry_delay: float = 10.0) -> None:
    for attempt in range(retries + 1):
        if check_cratesio_publication.crate_version_exists(crate, version):
            return
        if attempt < retries:
            print(f"waiting for crates.io to index {crate} {version}...")
            time.sleep(retry_delay)
    fail(f"crates.io did not report {crate} {version} after publish")


def cargo_publish_package(package: str, version: str, *, allow_dirty: bool = False) -> None:
    if check_cratesio_publication.crate_version_exists(package, version):
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


def validate_wasix_runtime_inputs() -> None:
    require_release_portable_assets()
    require_release_aot_artifacts()
    xtask(["assets", "check"])
    for target in wasm_aot_target_triples():
        xtask(["assets", "check-aot", "--target-triple", target])


def run_wasix_runtime_staged_dry_run(allow_dirty: bool) -> None:
    validate_wasix_runtime_inputs()
    with materialized_wasix_runtime_crate_payloads():
        packages = wasix_runtime_internal_packages()
        package_check = ["tools/policy/check-crate-package.sh", *cargo_package_args(True)]
        for package in packages:
            package_check.extend(["--package", package])
        run(package_check)
        run(["tools/release/check_wasm_crate_payloads.py", *cargo_package_args(True)])
        for package in packages:
            run(
                [
                    "cargo",
                    "publish",
                    "-p",
                    package,
                    "--dry-run",
                    "--locked",
                    *cargo_publish_args(True),
                ]
            )


def run_wasix_runtime_release_dry_run(allow_dirty: bool) -> None:
    run_wasix_runtime_staged_dry_run(allow_dirty)


def run_wasm_release_dry_run(allow_dirty: bool) -> None:
    validate_staged_sdk_package("oliphaunt-wasix-rust")
    verify_staged_cargo_crate_identity(
        "oliphaunt-wasix-rust",
        "oliphaunt-wasix",
        current_product_version("oliphaunt-wasix-rust"),
        allow_dirty=allow_dirty,
    )
    print("validated staged WASIX Rust binding crate; skipping source cargo publish dry-run.")


def publish_wasix_runtime_staged_crates() -> None:
    validate_wasix_runtime_inputs()
    with materialized_wasix_runtime_crate_payloads():
        packages = wasix_runtime_internal_packages()
        package_check = ["tools/policy/check-crate-package.sh", *cargo_package_args(True)]
        for package in packages:
            package_check.extend(["--package", package])
        run(package_check)
        run(["tools/release/check_wasm_crate_payloads.py", *cargo_package_args(True)])
        version = current_product_version("liboliphaunt-wasix")
        for package in packages:
            cargo_publish_package(package, version, allow_dirty=True)


def publish_wasm_staged_crates() -> None:
    publish_wasix_runtime_staged_crates()
    version = current_product_version("oliphaunt-wasix-rust")
    cargo_publish_package("oliphaunt-wasix", version, allow_dirty=True)


def publish_wasix_runtime_crates_io(head_ref: str) -> None:
    if published_rerun("liboliphaunt-wasix", head_ref):
        print("liboliphaunt-wasix internal crates are already published at this commit; skipping crates.io publish.")
        return

    verify_release_tag("liboliphaunt-wasix", head_ref)
    publish_wasix_runtime_staged_crates()
    run(
        [
            "tools/release/check_registry_publication.py",
            "--product",
            "liboliphaunt-wasix",
            "--require-published",
            "--retries",
            "12",
            "--retry-delay",
            "10",
        ]
    )


def publish_wasm_crates_io(head_ref: str) -> None:
    if published_rerun("oliphaunt-wasix-rust", head_ref):
        print("oliphaunt-wasix is already published at this commit; skipping crates.io publish.")
        return

    verify_release_tag("oliphaunt-wasix-rust", head_ref)
    version = current_product_version("oliphaunt-wasix-rust")
    verify_staged_cargo_crate_identity(
        "oliphaunt-wasix-rust",
        "oliphaunt-wasix",
        version,
        allow_dirty=False,
    )
    cargo_publish_package("oliphaunt-wasix", version)
    run(
        [
            "tools/release/check_registry_publication.py",
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
        run(["tools/release/check_liboliphaunt_release_assets.py", "--asset-dir", "target/liboliphaunt/release-assets"])
        return
    fail(
        "liboliphaunt-native requires staged release assets under "
        "target/liboliphaunt/release-assets; download the CI workflow "
        "liboliphaunt-native-release-assets artifact before release validation or publishing"
    )


def run_liboliphaunt_dry_run() -> None:
    ensure_liboliphaunt_release_assets()


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
                    shutil.copy2(asset, destination / asset.name)
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
            "tools/release/write_checksum_manifest.py",
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
    run(["tools/release/check_broker_release_assets.py", "--asset-dir", str(asset_dir.relative_to(ROOT))])


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
            "tools/release/write_checksum_manifest.py",
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
    run(["tools/release/check_node_direct_release_assets.py", "--asset-dir", str(asset_dir.relative_to(ROOT))])


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
        for key in product_metadata.PUBLIC_EXTENSION_RELEASE_ASSET_KEYS
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
    expected_release_keys = product_metadata.PUBLIC_EXTENSION_RELEASE_MANIFEST_KEYS
    if actual_release_keys != expected_release_keys:
        fail(
            f"{release_manifest.relative_to(ROOT)} public manifest keys must be "
            f"{sorted(expected_release_keys)}, got {sorted(actual_release_keys)}"
        )
    extension_metadata = product_metadata.extension_metadata(product)
    if release_data.get("extensionClass") != extension_metadata["class"]:
        fail(f"{release_manifest.relative_to(ROOT)} has stale extensionClass")
    if release_data.get("versioning") != extension_metadata["versioning"]:
        fail(f"{release_manifest.relative_to(ROOT)} has stale versioning")
    if release_data.get("sourceIdentity") != product_metadata.extension_source_identity(product):
        fail(f"{release_manifest.relative_to(ROOT)} has stale sourceIdentity")
    if release_data.get("compatibility") != extension_metadata["compatibility"]:
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
            expected_asset_keys = product_metadata.PUBLIC_EXTENSION_RELEASE_ASSET_KEYS
            if actual_asset_keys != expected_asset_keys:
                fail(
                    f"{release_manifest.relative_to(ROOT)} public asset {asset.get('name')!r} keys must be "
                    f"{sorted(expected_asset_keys)}, got {sorted(actual_asset_keys)}"
                )

    declared_native_targets = {
        target.target
        for target in extension_artifact_targets.artifact_targets(
            product=product,
            family="native",
            published_only=True,
        )
    }
    declared_wasix_targets = {
        target.target
        for target in extension_artifact_targets.artifact_targets(
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


def validate_staged_sdk_package(product: str) -> None:
    run(["python3", "tools/release/check_staged_artifacts.py", "--require-sdk-product", product])


def run_rust_sdk_dry_run(allow_dirty: bool, head_ref: str) -> None:
    version = current_product_version("oliphaunt-rust")
    validate_staged_sdk_package("oliphaunt-rust")
    verify_staged_cargo_crate_identity(
        "oliphaunt-rust",
        "oliphaunt",
        version,
        allow_dirty=allow_dirty,
    )
    print("validated staged Rust SDK crate; skipping source cargo publish dry-run.")


def run_broker_dry_run() -> None:
    ensure_broker_release_assets()


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


def command_plan(args: list[str]) -> None:
    raise SystemExit(release_plan.main(args))


def command_check(args: list[str]) -> None:
    run(["python3", "tools/policy/check-release-policy.py"])
    run(["python3", "tools/release/check_release_please_config.py"])
    run(["python3", "tools/release/check_artifact_targets.py"])
    run(["tools/release/sync_release_pr.py", "--check"])
    run(["python3", "tools/release/check_release_pr_coverage.py"])
    run(["python3", "tools/release/check_release_metadata.py"])
    run(["tools/release/release.py", "consumer-shape", "--format", "json", "--require-ready"])
    run(
        [
            "tools/release/release.py",
            "consumer-shape",
            "--format",
            "json",
            "--require-ready",
            "--products-json",
            '["oliphaunt-react-native"]',
        ]
    )


def command_check_registries(args: list[str]) -> None:
    require_identities = "--require-identities" in args
    args = [value for value in args if value != "--require-identities"]
    if not args:
        print("No release products selected; registry publication checks skipped.")
        return
    run(["tools/release/check_release_versions.py", *args, "--check-registries"])
    if require_identities:
        products_json = passthrough_value(args, "--products-json")
        if products_json is None:
            fail("check-registries --require-identities requires --products-json")
        run(
            [
                "tools/release/check_registry_publication.py",
                "--products-json",
                products_json,
                "--require-identities",
            ]
        )


def command_consumer_shape(args: list[str]) -> None:
    result = subprocess.run(["tools/release/check_consumer_shape.py", *args], cwd=ROOT, check=False)
    if result.returncode != 0:
        raise SystemExit(result.returncode)


def consumer_shape_scope_args(args: list[str]) -> list[str]:
    scoped: list[str] = []
    index = 0
    while index < len(args):
        value = args[index]
        if value == "--products-json":
            if index + 1 >= len(args):
                fail("--products-json requires a value")
            scoped.extend([value, args[index + 1]])
            index += 2
            continue
        if value.startswith("--products-json="):
            scoped.append(value)
        index += 1
    return scoped


def command_verify_release(args: list[str]) -> None:
    run(["tools/release/check_release_versions.py", *args, "--check-registries"])
    command_consumer_shape(["--require-ready", *consumer_shape_scope_args(args)])
    run(["tools/release/verify_github_release_attestations.py", *args])


def publish_existing_tag_outputs(product: str, head_ref: str, fmt: str) -> None:
    values = {
        "tag": product_tag(product),
        "exists_at_head": "true" if published_rerun(product, head_ref) else "false",
    }
    if fmt == "github-output":
        github_output(values)
        return
    for key, value in values.items():
        print(f"{key}: {value}")


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
            "tools/release/publish_swiftpm_source_tag.py",
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
    urls = [
        f"https://repo1.maven.org/maven2/dev/oliphaunt/oliphaunt/{version}/oliphaunt-{version}.pom",
        f"https://repo1.maven.org/maven2/dev/oliphaunt/oliphaunt-android-gradle-plugin/{version}/oliphaunt-android-gradle-plugin-{version}.pom",
        f"https://repo1.maven.org/maven2/dev/oliphaunt/android/dev.oliphaunt.android.gradle.plugin/{version}/dev.oliphaunt.android.gradle.plugin-{version}.pom",
    ]
    return all(url_exists(url) for url in urls)


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
            "tools/release/check_registry_publication.py",
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
            "tools/release/check_registry_publication.py",
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
    verify_staged_cargo_crate_identity(
        "oliphaunt-rust",
        "oliphaunt",
        version,
        allow_dirty=False,
    )
    cargo_publish_package("oliphaunt", version)
    run(
        [
            "tools/release/check_registry_publication.py",
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


def node_direct_optional_package_targets(version: str) -> list[tuple[str, Path, artifact_targets.ArtifactTarget]]:
    packages: list[tuple[str, Path, artifact_targets.ArtifactTarget]] = []
    for target in artifact_targets.artifact_targets(
        product="oliphaunt-node-direct",
        kind="node-direct-addon",
        surface="npm-optional",
        published_only=True,
    ):
        package_name = target.npm_package
        if package_name is None:
            fail(f"{target.id} must declare npm_package for npm optional package publication")
        package_dir = NODE_DIRECT_PACKAGE_DIRS.get(package_name)
        if package_dir is None:
            fail(f"{target.id} declares unknown Node direct npm package {package_name}")
        package_json = json.loads((package_dir / "package.json").read_text(encoding="utf-8"))
        if package_json.get("name") != package_name:
            fail(f"{package_dir.relative_to(ROOT)}/package.json name must be {package_name}")
        if package_json.get("version") != version:
            fail(f"{package_name} package version must match oliphaunt-node-direct {version}")
        packages.append((package_name, package_dir, target))
    if sorted(package for package, _, _ in packages) != sorted(NODE_DIRECT_PACKAGE_DIRS):
        fail("Node direct npm optional package metadata must match published artifact targets exactly")
    return packages


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
            "tools/release/check_registry_publication.py",
            "--product",
            "oliphaunt-node-direct",
            "--require-published",
            "--retries",
            "12",
            "--retry-delay",
            "10",
        ]
    )


def publish_typescript_npm_jsr(head_ref: str) -> None:
    verify_release_tag("oliphaunt-js", head_ref)
    version = current_product_version("oliphaunt-js")
    if npm_package_is_published("@oliphaunt/ts", version):
        print(f"@oliphaunt/ts {version} is already published on npm; skipping npm publish.")
    else:
        npm_publish_pnpm_packed_package(ROOT / "src/sdks/js", product="oliphaunt-js")
    if succeeds(
        [
            "tools/release/check_registry_publication.py",
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
            "tools/release/check_registry_publication.py",
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
    asset_dir = ROOT / "target/oliphaunt-wasix/release-assets"
    if not asset_dir.is_dir() or not any(asset_dir.iterdir()):
        fail(
            "liboliphaunt-wasix requires staged release assets under "
            "target/oliphaunt-wasix/release-assets; download the CI workflow "
            "liboliphaunt-wasix-release-assets artifact before release validation or publishing"
        )
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


def command_publish_product_step(args: argparse.Namespace) -> None:
    product = args.product
    step = args.step
    head_ref = args.head_ref
    if product is None or step is None:
        fail("publish product step requires --product and --step")
    known = set(product_metadata.product_ids())
    if product not in known:
        fail(f"unknown release product: {product}")

    if step == "existing-tag":
        publish_existing_tag_outputs(product, head_ref, args.format)
    elif product == "liboliphaunt-native" and step == "github-release-assets":
        publish_liboliphaunt_github_assets(head_ref)
    elif product == "liboliphaunt-wasix" and step == "crates-io":
        publish_wasix_runtime_crates_io(head_ref)
    elif product == "liboliphaunt-wasix" and step == "github-release-assets":
        verify_release_tag("liboliphaunt-wasix", head_ref)
        publish_wasm_release_assets()
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
    if args.product or args.step:
        command_publish_product_step(args)
        return
    products_args = passthrough
    run(["tools/release/check_publish_environment.py", *products_args])
    command_publish_dry_run(args, passthrough)
    print("publish environment and dry-run checks passed; package-native publish steps run in the Release workflow")


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    for name in ["plan", "check", "check-registries", "consumer-shape", "verify-release"]:
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
    publish.add_argument("--format", choices=["text", "github-output"], default="text")

    args, passthrough = parser.parse_known_args(argv)
    command = args.command

    if command == "plan":
        command_plan(passthrough)
    elif command == "check":
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
