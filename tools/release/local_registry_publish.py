#!/usr/bin/env python3
"""Stage Oliphaunt release artifacts into local package registries.

The script intentionally consumes the same artifact shape produced by CI:

* npm package tarballs under ``target/sdk-artifacts`` or a downloaded artifact
  directory are published to a local Verdaccio.
* Rust ``.crate`` files are indexed into a local Cargo git registry whose
  downloads point at local files.
* Maven repository trees are copied into a local filesystem Maven repository.
* SwiftPM artifacts are staged for inspection; the Swift product currently
  releases through a source tag rather than a registry publish.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform as host_platform
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
import tomllib
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable


ROOT = Path(__file__).resolve().parents[2]
DEFAULT_RUN_ID = "28049923289"
DEFAULT_REPO = "f0rr0/oliphaunt"
DEFAULT_REGISTRY_ROOT = ROOT / "target" / "local-registries"
DEFAULT_ARTIFACT_ROOT = ROOT / "target" / "local-registry-artifacts"
NPM_PACKAGE_SIZE_LIMIT_BYTES = 10 * 1024 * 1024

LOCAL_PUBLISH_ARTIFACTS = [
    "liboliphaunt-native-release-assets",
    "liboliphaunt-native-release-assets-android-arm64-v8a",
    "liboliphaunt-native-release-assets-android-x86_64",
    "liboliphaunt-native-release-assets-ios-xcframework",
    "liboliphaunt-native-release-assets-linux-arm64-gnu",
    "liboliphaunt-native-release-assets-linux-x64-gnu",
    "liboliphaunt-native-release-assets-macos-arm64",
    "liboliphaunt-native-release-assets-windows-x64-msvc",
    "liboliphaunt-wasix-extension-artifacts-wasix-portable",
    "liboliphaunt-wasix-release-assets",
    "liboliphaunt-wasix-runtime-aot-linux-arm64-gnu",
    "liboliphaunt-wasix-runtime-aot-linux-x64-gnu",
    "liboliphaunt-wasix-runtime-aot-macos-arm64",
    "liboliphaunt-wasix-runtime-aot-windows-x64-msvc",
    "liboliphaunt-wasix-runtime-portable",
    "oliphaunt-broker-release-assets-linux-arm64-gnu",
    "oliphaunt-broker-release-assets-linux-x64-gnu",
    "oliphaunt-broker-release-assets-macos-arm64",
    "oliphaunt-broker-release-assets-windows-x64-msvc",
    "oliphaunt-extension-package-artifacts",
    "oliphaunt-rust-sdk-package-artifacts",
    "oliphaunt-wasix-rust-package-artifacts",
    "oliphaunt-js-sdk-package-artifacts",
    "oliphaunt-react-native-sdk-package-artifacts",
    "oliphaunt-kotlin-sdk-package-artifacts",
    "oliphaunt-swift-sdk-package-artifacts",
    "oliphaunt-mobile-extension-package-artifacts",
    "oliphaunt-node-direct-npm-package-linux-x64-gnu",
    "oliphaunt-node-direct-npm-package-linux-arm64-gnu",
    "oliphaunt-node-direct-npm-package-macos-arm64",
    "oliphaunt-node-direct-npm-package-windows-x64-msvc",
    "oliphaunt-node-direct-release-assets-linux-arm64-gnu",
    "oliphaunt-node-direct-release-assets-linux-x64-gnu",
    "oliphaunt-node-direct-release-assets-macos-arm64",
    "oliphaunt-node-direct-release-assets-windows-x64-msvc",
]


def rel(path: Path) -> str:
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


def run(
    args: list[str],
    *,
    cwd: Path = ROOT,
    check: bool = True,
    capture: bool = False,
    env: dict[str, str] | None = None,
    timeout: float | None = None,
) -> subprocess.CompletedProcess[str]:
    kwargs: dict[str, Any] = {
        "cwd": cwd,
        "check": check,
        "text": True,
        "env": env,
        "timeout": timeout,
    }
    if capture:
        kwargs["stdout"] = subprocess.PIPE
        kwargs["stderr"] = subprocess.PIPE
    return subprocess.run(args, **kwargs)


def require_command(name: str) -> str:
    resolved = shutil.which(name)
    if not resolved:
        raise RuntimeError(f"missing required command: {name}")
    return resolved


@dataclass
class SurfaceResult:
    surface: str
    published: list[str] = field(default_factory=list)
    staged: list[str] = field(default_factory=list)
    skipped: list[str] = field(default_factory=list)

    def add_skip(self, message: str) -> None:
        self.skipped.append(message)


def discover_roots(extra_roots: Iterable[Path]) -> list[Path]:
    roots = [
        DEFAULT_ARTIFACT_ROOT,
        ROOT / "target" / "sdk-artifacts",
        ROOT / "target" / "package" / "tmp-crate",
        ROOT / "target" / "package" / "tmp-registry",
        ROOT / "target" / "oliphaunt-wasix" / "cargo-artifacts",
        ROOT / "target" / "oliphaunt-wasix" / "release-assets",
        ROOT / "target" / "extension-artifacts",
    ]
    roots.extend(extra_roots)
    seen: set[Path] = set()
    result: list[Path] = []
    for root in roots:
        resolved = root.resolve()
        if resolved in seen or not resolved.exists():
            continue
        seen.add(resolved)
        result.append(resolved)
    return result


def list_ci_artifacts(repo: str, run_id: str) -> list[dict[str, Any]]:
    require_command("gh")
    completed = run(
        [
            "gh",
            "api",
            f"repos/{repo}/actions/runs/{run_id}/artifacts?per_page=100",
            "--paginate",
        ],
        capture=True,
    )
    data = json.loads(completed.stdout)
    if isinstance(data, list):
        artifacts: list[dict[str, Any]] = []
        for page in data:
            artifacts.extend(page.get("artifacts", []))
        return artifacts
    return data.get("artifacts", [])


def download_artifacts(args: argparse.Namespace) -> None:
    artifacts = list(args.artifact)
    if args.preset == "local-publish":
        artifacts.extend(LOCAL_PUBLISH_ARTIFACTS)
    artifacts = sorted(set(artifacts))
    if not artifacts:
        print("No artifacts selected; pass --artifact or --preset local-publish.", file=sys.stderr)
        raise SystemExit(2)

    available = {artifact["name"]: artifact for artifact in list_ci_artifacts(args.repo, args.run_id)}
    missing = [artifact for artifact in artifacts if artifact not in available]
    if missing:
        print(f"Run {args.run_id} is missing artifacts: {', '.join(missing)}", file=sys.stderr)
        raise SystemExit(1)
    if args.dry_run:
        for artifact in artifacts:
            row = available[artifact]
            print(f"{artifact}\t{row.get('size_in_bytes', 0)}")
        return

    args.destination.mkdir(parents=True, exist_ok=True)
    for artifact in artifacts:
        artifact_dir = args.destination / artifact
        if artifact_dir.exists() and any(artifact_dir.iterdir()) and not args.force:
            print(f"Skipping existing {rel(artifact_dir)}")
            continue
        shutil.rmtree(artifact_dir, ignore_errors=True)
        artifact_dir.mkdir(parents=True, exist_ok=True)
        print(f"Downloading {artifact} from {args.repo} run {args.run_id}")
        run(
            [
                "gh",
                "run",
                "download",
                args.run_id,
                "--repo",
                args.repo,
                "--name",
                artifact,
                "--dir",
                str(artifact_dir),
            ]
        )


def discover_files(roots: list[Path], suffixes: tuple[str, ...]) -> list[Path]:
    files: list[Path] = []
    for root in roots:
        if root.is_file() and root.name.endswith(suffixes):
            files.append(root)
            continue
        if root.is_dir():
            files.extend(path for path in root.rglob("*") if path.is_file() and path.name.endswith(suffixes))
    return sorted(set(files))


def host_npm_target() -> str | None:
    machine = host_platform.machine().lower()
    if sys.platform == "linux" and machine in {"x86_64", "amd64"}:
        return "linux-x64-gnu"
    if sys.platform == "linux" and machine in {"aarch64", "arm64"}:
        return "linux-arm64-gnu"
    if sys.platform == "darwin" and machine == "arm64":
        return "macos-arm64"
    if sys.platform == "win32" and machine in {"amd64", "x86_64"}:
        return "windows-x64-msvc"
    return None


def npm_platform_constraints(target: str) -> dict[str, list[str]]:
    if target == "linux-x64-gnu":
        return {"os": ["linux"], "cpu": ["x64"], "libc": ["glibc"]}
    if target == "linux-arm64-gnu":
        return {"os": ["linux"], "cpu": ["arm64"], "libc": ["glibc"]}
    if target == "macos-arm64":
        return {"os": ["darwin"], "cpu": ["arm64"]}
    if target == "windows-x64-msvc":
        return {"os": ["win32"], "cpu": ["x64"]}
    return {}


def extension_npm_package(sql_name: str) -> str:
    return f"@oliphaunt/extension-{sql_name.replace('_', '-')}"


def extension_npm_target_package(sql_name: str, target: str) -> str:
    return f"{extension_npm_package(sql_name)}-{target}"


def extension_npm_payload_package(sql_name: str, target: str, index: int) -> str:
    return f"{extension_npm_target_package(sql_name, target)}-payload-{index}"


def discover_extension_manifests(roots: list[Path]) -> list[Path]:
    manifests: list[Path] = []
    for root in roots:
        if root.is_file() and root.name == "extension-artifacts.json":
            manifests.append(root)
            continue
        if root.is_dir():
            manifests.extend(path for path in root.rglob("extension-artifacts.json") if path.is_file())
    return sorted(set(manifests))


def safe_package_path(package_name: str) -> str:
    return package_name.replace("@", "").replace("/", "__")


def extension_release_manifest(extension_dir: Path, product: str, version: str) -> dict[str, Any]:
    manifest_path = extension_dir / "release-assets" / f"{product}-{version}-manifest.json"
    if not manifest_path.is_file():
        return {}
    return json.loads(manifest_path.read_text(encoding="utf-8"))


def extension_runtime_asset(
    extension_dir: Path,
    manifest: dict[str, Any],
    target: str,
) -> Path | None:
    for asset in manifest.get("assets", []):
        if (
            asset.get("family") == "native"
            and asset.get("kind") == "runtime"
            and asset.get("target") == target
            and isinstance(asset.get("name"), str)
        ):
            path = extension_dir / "release-assets" / asset["name"]
            if path.is_file():
                return path
    return None


def extract_extension_runtime(asset: Path, runtime_dir: Path) -> None:
    runtime_dir.mkdir(parents=True, exist_ok=True)
    with tarfile.open(asset, "r:gz") as archive:
        for member in archive.getmembers():
            if not member.isfile() or not member.name.startswith("files/"):
                continue
            relative = Path(member.name.removeprefix("files/"))
            if relative.is_absolute() or ".." in relative.parts:
                raise RuntimeError(f"{rel(asset)} contains unsafe path {member.name!r}")
            target = runtime_dir / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            source = archive.extractfile(member)
            if source is None:
                continue
            with source, target.open("wb") as output:
                shutil.copyfileobj(source, output)


def extension_module_directory(runtime_dir: Path) -> Path | None:
    postgres_lib = runtime_dir / "lib" / "postgresql"
    if not postgres_lib.is_dir():
        return None
    for path in sorted(postgres_lib.iterdir()):
        if path.is_file() and path.suffix.lower() in {".so", ".dylib", ".dll"}:
            return postgres_lib
    return None


def strip_extension_modules(runtime_dir: Path, target: str) -> None:
    module_dir = extension_module_directory(runtime_dir)
    if module_dir is None or not target.startswith("linux-"):
        return
    strip = shutil.which("strip")
    if strip is None:
        return
    for path in sorted(module_dir.iterdir()):
        if path.is_file() and path.suffix == ".so":
            run([strip, "--strip-unneeded", str(path)], check=False)


def write_extension_readme(package_dir: Path, package_name: str, sql_name: str, target: str | None) -> None:
    target_text = f" for `{target}`" if target else ""
    package_dir.joinpath("README.md").write_text(
        "\n".join(
            [
                f"# {package_name}",
                "",
                f"Oliphaunt registry package for the `{sql_name}` PostgreSQL extension{target_text}.",
                "",
                "This package is consumed by `@oliphaunt/ts` when an application opens a database with",
                f"`extensions: ['{sql_name}']`.",
                "",
            ]
        ),
        encoding="utf-8",
    )


def write_extension_meta_package(
    package_dir: Path,
    *,
    product: str,
    version: str,
    sql_name: str,
    target: str,
) -> None:
    package_name = extension_npm_package(sql_name)
    target_package = extension_npm_target_package(sql_name, target)
    package_dir.mkdir(parents=True, exist_ok=True)
    write_extension_readme(package_dir, package_name, sql_name, None)
    package_dir.joinpath("package.json").write_text(
        json.dumps(
            {
                "name": package_name,
                "version": version,
                "description": f"Oliphaunt extension package for PostgreSQL {sql_name}.",
                "license": "MIT AND Apache-2.0 AND PostgreSQL",
                "type": "module",
                "optionalDependencies": {target_package: version},
                "oliphaunt": {
                    "product": product,
                    "kind": "exact-extension",
                    "sqlName": sql_name,
                    "targetPackageNames": {target: target_package},
                },
                "publishConfig": {"access": "public", "provenance": False},
                "files": ["README.md"],
                "exports": {"./package.json": "./package.json"},
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )


def write_extension_target_package(
    package_dir: Path,
    *,
    product: str,
    version: str,
    sql_name: str,
    target: str,
    liboliphaunt_version: str,
    payload_package_names: list[str],
) -> None:
    package_name = extension_npm_target_package(sql_name, target)
    package_dir.mkdir(parents=True, exist_ok=True)
    write_extension_readme(package_dir, package_name, sql_name, target)

    package_json = {
        "name": package_name,
        "version": version,
        "description": f"{target} Oliphaunt extension package selector for PostgreSQL {sql_name}.",
        "license": "MIT AND Apache-2.0 AND PostgreSQL",
        "type": "module",
        **npm_platform_constraints(target),
        "optional": True,
        "optionalDependencies": {name: version for name in payload_package_names},
        "oliphaunt": {
            "product": product,
            "kind": "exact-extension-target",
            "sqlName": sql_name,
            "target": target,
            "liboliphauntVersion": liboliphaunt_version,
            "payloadPackageNames": payload_package_names,
        },
        "publishConfig": {"access": "public", "provenance": False},
        "files": ["README.md"],
        "exports": {"./package.json": "./package.json"},
    }
    package_dir.joinpath("package.json").write_text(
        json.dumps(package_json, indent=2) + "\n",
        encoding="utf-8",
    )


def copy_runtime_entries(runtime_dir: Path, payload_runtime_dir: Path, entries: list[Path]) -> None:
    for entry in entries:
        relative = entry.relative_to(runtime_dir)
        target = payload_runtime_dir / relative
        if entry.is_dir():
            shutil.copytree(entry, target, dirs_exist_ok=True)
        elif entry.is_file():
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(entry, target)


def write_extension_payload_package(
    package_dir: Path,
    *,
    package_name: str,
    product: str,
    version: str,
    sql_name: str,
    target: str,
    liboliphaunt_version: str,
) -> None:
    runtime_dir = package_dir / "runtime"
    module_dir = extension_module_directory(runtime_dir)
    write_extension_readme(package_dir, package_name, sql_name, target)
    oliphaunt: dict[str, Any] = {
        "product": product,
        "kind": "exact-extension-payload",
        "sqlName": sql_name,
        "target": target,
        "runtimeRelativePath": "runtime",
        "liboliphauntVersion": liboliphaunt_version,
    }
    if module_dir is not None:
        oliphaunt["moduleRelativePath"] = module_dir.relative_to(package_dir).as_posix()
    package_json = {
        "name": package_name,
        "version": version,
        "description": f"{target} Oliphaunt extension runtime payload for PostgreSQL {sql_name}.",
        "license": "MIT AND Apache-2.0 AND PostgreSQL",
        "type": "module",
        **npm_platform_constraints(target),
        "optional": True,
        "oliphaunt": oliphaunt,
        "publishConfig": {"access": "public", "provenance": False},
        "files": ["runtime", "README.md"],
        "exports": {"./package.json": "./package.json"},
    }
    package_dir.joinpath("package.json").write_text(
        json.dumps(package_json, indent=2) + "\n",
        encoding="utf-8",
    )


def pack_extension_package(package_dir: Path, tarball_dir: Path) -> Path:
    tarball_dir.mkdir(parents=True, exist_ok=True)
    completed = run(
        [
            "npm",
            "pack",
            str(package_dir),
            "--pack-destination",
            str(tarball_dir),
            "--loglevel=error",
        ],
        capture=True,
    )
    filename = completed.stdout.strip().splitlines()[-1]
    return tarball_dir / filename


def npm_package_size_ok(tarball: Path, result: SurfaceResult) -> bool:
    size = tarball.stat().st_size
    if size <= NPM_PACKAGE_SIZE_LIMIT_BYTES:
        return True
    result.add_skip(
        f"{rel(tarball)} is {size} bytes, exceeding the 10 MiB npm package limit",
    )
    tarball.unlink(missing_ok=True)
    return False


def stage_extension_payload_group(
    *,
    runtime_dir: Path,
    entries: list[Path],
    package_root: Path,
    tarball_root: Path,
    product: str,
    version: str,
    sql_name: str,
    target: str,
    liboliphaunt_version: str,
    payload_index: int,
    result: SurfaceResult,
) -> tuple[list[str], list[Path]]:
    package_name = extension_npm_payload_package(sql_name, target, payload_index)
    package_dir = package_root / safe_package_path(package_name)
    shutil.rmtree(package_dir, ignore_errors=True)
    payload_runtime_dir = package_dir / "runtime"
    payload_runtime_dir.mkdir(parents=True, exist_ok=True)
    copy_runtime_entries(runtime_dir, payload_runtime_dir, entries)
    write_extension_payload_package(
        package_dir,
        package_name=package_name,
        product=product,
        version=version,
        sql_name=sql_name,
        target=target,
        liboliphaunt_version=liboliphaunt_version,
    )
    tarball = pack_extension_package(package_dir, tarball_root)
    if tarball.stat().st_size <= NPM_PACKAGE_SIZE_LIMIT_BYTES:
        return [package_name], [tarball]

    tarball.unlink(missing_ok=True)
    shutil.rmtree(package_dir, ignore_errors=True)
    if len(entries) == 1 and entries[0].is_dir():
        child_entries = sorted(entries[0].iterdir())
        if child_entries:
            return stage_extension_payload_groups(
                runtime_dir=runtime_dir,
                groups=[[entry] for entry in child_entries],
                package_root=package_root,
                tarball_root=tarball_root,
                product=product,
                version=version,
                sql_name=sql_name,
                target=target,
                liboliphaunt_version=liboliphaunt_version,
                start_index=payload_index,
                result=result,
            )
    if len(entries) > 1:
        return stage_extension_payload_groups(
            runtime_dir=runtime_dir,
            groups=[[entry] for entry in entries],
            package_root=package_root,
            tarball_root=tarball_root,
            product=product,
            version=version,
            sql_name=sql_name,
            target=target,
            liboliphaunt_version=liboliphaunt_version,
            start_index=payload_index,
            result=result,
        )

    result.add_skip(
        f"{package_name} cannot be split below the 10 MiB npm package limit; largest entry is {entries[0]}",
    )
    return [], []


def stage_extension_payload_groups(
    *,
    runtime_dir: Path,
    groups: list[list[Path]],
    package_root: Path,
    tarball_root: Path,
    product: str,
    version: str,
    sql_name: str,
    target: str,
    liboliphaunt_version: str,
    start_index: int,
    result: SurfaceResult,
) -> tuple[list[str], list[Path]]:
    package_names: list[str] = []
    tarballs: list[Path] = []
    payload_index = start_index
    for entries in groups:
        names, paths = stage_extension_payload_group(
            runtime_dir=runtime_dir,
            entries=entries,
            package_root=package_root,
            tarball_root=tarball_root,
            product=product,
            version=version,
            sql_name=sql_name,
            target=target,
            liboliphaunt_version=liboliphaunt_version,
            payload_index=payload_index,
            result=result,
        )
        if not names:
            continue
        package_names.extend(names)
        tarballs.extend(paths)
        payload_index += len(names)
    return package_names, tarballs


def stage_extension_payload_packages(
    *,
    runtime_dir: Path,
    package_root: Path,
    tarball_root: Path,
    product: str,
    version: str,
    sql_name: str,
    target: str,
    liboliphaunt_version: str,
    result: SurfaceResult,
) -> tuple[list[str], list[Path]]:
    entries = sorted(runtime_dir.iterdir())
    return stage_extension_payload_groups(
        runtime_dir=runtime_dir,
        groups=[[entry] for entry in entries],
        package_root=package_root,
        tarball_root=tarball_root,
        product=product,
        version=version,
        sql_name=sql_name,
        target=target,
        liboliphaunt_version=liboliphaunt_version,
        start_index=0,
        result=result,
    )


def stage_extension_npm_packages(
    roots: list[Path],
    staging_root: Path,
    target: str | None,
    dry_run: bool,
    result: SurfaceResult,
) -> Path | None:
    manifests = discover_extension_manifests(roots)
    if not manifests:
        result.add_skip("no extension-artifacts.json manifests found for npm extension packages")
        return None
    if target is None:
        result.add_skip("current host does not map to a supported npm extension target")
        return None

    if dry_run:
        for manifest_path in manifests:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            sql_name = manifest.get("sqlName")
            version = manifest.get("version")
            if isinstance(sql_name, str) and isinstance(version, str):
                result.staged.append(
                    f"dry-run npm extension packages {extension_npm_package(sql_name)}@{version} ({target})",
                )
        return None

    shutil.rmtree(staging_root, ignore_errors=True)
    package_root = staging_root / "packages"
    tarball_root = staging_root / "tarballs"
    work_root = staging_root / "work"
    staged_any = False
    for manifest_path in manifests:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        extension_dir = manifest_path.parent
        product = manifest.get("product")
        version = manifest.get("version")
        sql_name = manifest.get("sqlName")
        if not all(isinstance(value, str) and value for value in [product, version, sql_name]):
            result.add_skip(f"{rel(manifest_path)} is missing product, version, or sqlName")
            continue
        release_manifest = extension_release_manifest(extension_dir, product, version)
        asset = extension_runtime_asset(extension_dir, release_manifest or manifest, target)
        if asset is None:
            result.add_skip(f"{product}@{version} has no {target} native runtime asset")
            continue
        compatibility = release_manifest.get("compatibility", {})
        liboliphaunt_version = compatibility.get("nativeRuntimeVersion", version)
        if not isinstance(liboliphaunt_version, str) or not liboliphaunt_version:
            result.add_skip(f"{product}@{version} is missing native runtime compatibility")
            continue

        meta_dir = package_root / safe_package_path(extension_npm_package(sql_name))
        target_dir = package_root / safe_package_path(extension_npm_target_package(sql_name, target))
        runtime_work_dir = work_root / safe_package_path(extension_npm_target_package(sql_name, target)) / "runtime"
        extract_extension_runtime(asset, runtime_work_dir)
        strip_extension_modules(runtime_work_dir, target)
        payload_package_names, payload_tarballs = stage_extension_payload_packages(
            runtime_dir=runtime_work_dir,
            package_root=package_root,
            tarball_root=tarball_root,
            product=product,
            version=version,
            sql_name=sql_name,
            target=target,
            liboliphaunt_version=liboliphaunt_version,
            result=result,
        )
        if not payload_package_names:
            continue
        write_extension_meta_package(
            meta_dir,
            product=product,
            version=version,
            sql_name=sql_name,
            target=target,
        )
        write_extension_target_package(
            target_dir,
            product=product,
            version=version,
            sql_name=sql_name,
            target=target,
            liboliphaunt_version=liboliphaunt_version,
            payload_package_names=payload_package_names,
        )
        target_tarball = pack_extension_package(target_dir, tarball_root)
        if not npm_package_size_ok(target_tarball, result):
            for tarball in payload_tarballs:
                tarball.unlink(missing_ok=True)
            continue
        meta_tarball = pack_extension_package(meta_dir, tarball_root)
        if not npm_package_size_ok(meta_tarball, result):
            target_tarball.unlink(missing_ok=True)
            for tarball in payload_tarballs:
                tarball.unlink(missing_ok=True)
            continue
        for tarball in payload_tarballs:
            result.staged.append(rel(tarball))
        result.staged.append(rel(target_tarball))
        result.staged.append(rel(meta_tarball))
        staged_any = True

    return tarball_root if staged_any else None


def write_verdaccio_config(root: Path, port: int) -> tuple[Path, bool]:
    config = root / "config.yaml"
    storage = root / "storage"
    storage.mkdir(parents=True, exist_ok=True)
    (root / "plugins").mkdir(parents=True, exist_ok=True)
    text = "\n".join(
        [
            f"storage: {storage}",
            "auth:",
            "  htpasswd:",
            f"    file: {root / 'htpasswd'}",
            "uplinks:",
            "  npmjs:",
            "    url: https://registry.npmjs.org/",
            "packages:",
            "  '@oliphaunt/*':",
            "    access: $all",
            "    publish: $authenticated",
            "    unpublish: $authenticated",
            "    proxy: npmjs",
            "  '**':",
            "    access: $all",
            "    publish: $authenticated",
            "    unpublish: $authenticated",
            "    proxy: npmjs",
            "middlewares:",
            "  audit:",
            "    enabled: false",
            "log:",
            "  - {type: stdout, format: pretty, level: http}",
            "",
        ]
    )
    previous = config.read_text(encoding="utf-8") if config.exists() else None
    config.write_text(text, encoding="utf-8")
    (root / "registry-url.txt").write_text(f"http://127.0.0.1:{port}\n", encoding="utf-8")
    return config, previous != text


def stop_recorded_verdaccio(root: Path) -> None:
    pid_file = root / "verdaccio.pid"
    if not pid_file.is_file():
        return
    try:
        pid = int(pid_file.read_text(encoding="utf-8").strip())
    except ValueError:
        pid_file.unlink(missing_ok=True)
        return
    try:
        os.kill(pid, 15)
    except ProcessLookupError:
        pid_file.unlink(missing_ok=True)
        return
    for _ in range(30):
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            pid_file.unlink(missing_ok=True)
            return
        time.sleep(0.1)
    try:
        os.kill(pid, 9)
    except ProcessLookupError:
        pass
    pid_file.unlink(missing_ok=True)


def npm_ping(registry_url: str) -> bool:
    if not shutil.which("npm"):
        return False
    try:
        result = run(
            [
                "npm",
                "ping",
                "--registry",
                registry_url,
                "--fetch-timeout=1000",
                "--fetch-retries=0",
            ],
            check=False,
            capture=True,
            timeout=3,
        )
        return result.returncode == 0
    except subprocess.TimeoutExpired:
        return False


def ensure_verdaccio(root: Path, port: int, dry_run: bool) -> str:
    registry_url = f"http://127.0.0.1:{port}"
    config, changed = write_verdaccio_config(root, port)
    if changed and not dry_run:
        stop_recorded_verdaccio(root)
    if npm_ping(registry_url):
        return registry_url
    if dry_run:
        return registry_url

    if not shutil.which("pnpm"):
        raise RuntimeError("pnpm is required to start Verdaccio")
    log_path = root / "verdaccio.log"
    log = log_path.open("a", encoding="utf-8")
    process = subprocess.Popen(
        [
            "pnpm",
            "dlx",
            "verdaccio@6",
            "--config",
            str(config),
            "--listen",
            registry_url,
        ],
        cwd=ROOT,
        stdout=log,
        stderr=subprocess.STDOUT,
        text=True,
        start_new_session=True,
    )
    (root / "verdaccio.pid").write_text(f"{process.pid}\n", encoding="utf-8")
    for _ in range(60):
        if npm_ping(registry_url):
            return registry_url
        if process.poll() is not None:
            raise RuntimeError(f"Verdaccio exited early; see {rel(log_path)}")
        time.sleep(1)
    raise RuntimeError(f"Timed out waiting for Verdaccio; see {rel(log_path)}")


def ensure_verdaccio_npmrc(root: Path, registry_url: str, dry_run: bool) -> Path | None:
    if dry_run:
        return None
    npmrc = root / "npmrc"
    if npmrc.is_file():
        text = npmrc.read_text(encoding="utf-8")
        if "always-auth" in text:
            npmrc.write_text(
                "\n".join(line for line in text.splitlines() if not line.startswith("always-auth=")) + "\n",
                encoding="utf-8",
            )
        return npmrc
    username = "oliphaunt-local"
    password = "oliphaunt-local"
    payload = json.dumps(
        {
            "name": username,
            "password": password,
            "email": "local-registry@oliphaunt.invalid",
            "type": "user",
            "roles": [],
            "date": time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime()),
        }
    ).encode("utf-8")
    request = urllib.request.Request(
        f"{registry_url}/-/user/org.couchdb.user:{username}",
        data=payload,
        method="PUT",
        headers={"content-type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            data = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        body = error.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"failed to create local Verdaccio user: HTTP {error.code}: {body}") from error
    token = data.get("token")
    if not isinstance(token, str) or not token:
        raise RuntimeError("Verdaccio did not return an auth token for the local user")
    host = registry_url.removeprefix("http://").removeprefix("https://")
    npmrc.write_text(
        "\n".join(
            [
                f"registry={registry_url}/",
                f"//{host}/:_authToken={token}",
                "",
            ]
        ),
        encoding="utf-8",
    )
    return npmrc


def npm_package_identity(tarball: Path) -> tuple[str, str] | None:
    try:
        with tarfile.open(tarball, "r:gz") as archive:
            for member in archive.getmembers():
                if member.isfile() and member.name.endswith("/package.json"):
                    source = archive.extractfile(member)
                    if source is None:
                        continue
                    with source:
                        package_json = json.loads(source.read().decode("utf-8"))
                    name = package_json.get("name")
                    version = package_json.get("version")
                    if isinstance(name, str) and isinstance(version, str):
                        return name, version
    except (tarfile.TarError, json.JSONDecodeError):
        return None
    return None


def npm_package_exists(
    registry_url: str,
    npmrc: Path | None,
    name: str,
    version: str,
) -> bool:
    command = [
        "npm",
        "view",
        f"{name}@{version}",
        "version",
        "--registry",
        registry_url,
        "--fetch-retries=0",
        "--loglevel=error",
    ]
    if npmrc is not None:
        command.extend(["--userconfig", str(npmrc)])
    completed = run(command, check=False, capture=True, timeout=10)
    return completed.returncode == 0 and completed.stdout.strip() == version


def publish_npm(roots: list[Path], registry_root: Path, dry_run: bool, strict: bool, port: int) -> SurfaceResult:
    result = SurfaceResult("npm")
    extension_target = host_npm_target()
    extension_tarball_root = stage_extension_npm_packages(
        roots,
        registry_root / "npm-extension-packages",
        extension_target,
        dry_run,
        result,
    )
    if extension_tarball_root is not None:
        roots = [*roots, extension_tarball_root]
    tarballs = discover_files(roots, (".tgz",))
    if not tarballs:
        result.add_skip("no npm .tgz artifacts found")
        if strict:
            raise RuntimeError(result.skipped[-1])
        return result

    verdaccio_root = registry_root / "verdaccio"
    registry_url = ensure_verdaccio(verdaccio_root, port, dry_run)
    npmrc = ensure_verdaccio_npmrc(verdaccio_root, registry_url, dry_run)
    result.staged.append(f"verdaccio={registry_url}")
    for tarball in tarballs:
        identity = npm_package_identity(tarball)
        if dry_run:
            label = rel(tarball) if identity is None else f"{identity[0]}@{identity[1]}"
            result.published.append(f"dry-run npm publish {label}")
            continue
        if identity is not None and npm_package_exists(registry_url, npmrc, identity[0], identity[1]):
            result.add_skip(f"already published {identity[0]}@{identity[1]}")
            continue
        command = [
                "npm",
                "publish",
                str(tarball),
                "--registry",
                registry_url,
                "--provenance=false",
                "--ignore-scripts",
                "--access",
                "public",
                "--loglevel=error",
            ]
        if npmrc is not None:
            command.extend(["--userconfig", str(npmrc)])
        run(command)
        result.published.append(rel(tarball))
    return result


def crate_index_path(name: str) -> Path:
    lower = name.lower()
    if len(lower) == 1:
        return Path("1") / lower
    if len(lower) == 2:
        return Path("2") / lower
    if len(lower) == 3:
        return Path("3") / lower[:1] / lower
    return Path(lower[:2]) / lower[2:4] / lower


def cargo_metadata_for_crate(crate_path: Path) -> dict[str, Any]:
    with tempfile.TemporaryDirectory(prefix="oliphaunt-crate-") as temp:
        temp_path = Path(temp)
        with tarfile.open(crate_path, "r:gz") as archive:
            archive.extractall(temp_path, filter="data")
        manifests = sorted(temp_path.glob("*/Cargo.toml"))
        if not manifests:
            raise RuntimeError(f"{rel(crate_path)} does not contain Cargo.toml")
        cargo_toml = tomllib.loads(manifests[0].read_text(encoding="utf-8"))
        metadata = run(
            [
                "cargo",
                "metadata",
                "--manifest-path",
                str(manifests[0]),
                "--format-version",
                "1",
                "--no-deps",
            ],
            capture=True,
        )
        package = json.loads(metadata.stdout)["packages"][0]
        package["_oliphaunt_links"] = cargo_toml.get("package", {}).get("links")
        return package


def cargo_index_dependency(dep: dict[str, Any]) -> dict[str, Any]:
    registry = dep.get("registry")
    return {
        "name": dep["name"],
        "req": dep.get("req", "*"),
        "features": dep.get("features") or [],
        "optional": bool(dep.get("optional")),
        "default_features": bool(dep.get("uses_default_features", dep.get("default_features", True))),
        "target": dep.get("target"),
        "kind": dep.get("kind") or "normal",
        "registry": registry,
        "package": dep.get("rename") or dep.get("package"),
    }


def cargo_index_entry(crate_path: Path) -> dict[str, Any]:
    package = cargo_metadata_for_crate(crate_path)
    checksum = hashlib.sha256(crate_path.read_bytes()).hexdigest()
    return {
        "name": package["name"],
        "vers": package["version"],
        "deps": [cargo_index_dependency(dep) for dep in package.get("dependencies", [])],
        "features": package.get("features", {}),
        "features2": None,
        "cksum": checksum,
        "yanked": False,
        "links": package.get("_oliphaunt_links"),
        "rust_version": package.get("rust_version"),
        "v": 2,
    }


def publish_cargo(roots: list[Path], registry_root: Path, dry_run: bool, strict: bool) -> SurfaceResult:
    result = SurfaceResult("cargo")
    crates = discover_files(roots, (".crate",))
    if not crates:
        result.add_skip("no .crate artifacts found")
        if strict:
            raise RuntimeError(result.skipped[-1])
        return result
    require_command("cargo")

    cargo_root = registry_root / "cargo"
    crates_dir = cargo_root / "crates"
    index_dir = cargo_root / "index"
    config_snippet = cargo_root / "config.toml"
    if dry_run:
        result.published.extend(f"dry-run cargo index {rel(path)}" for path in crates)
        return result

    shutil.rmtree(cargo_root, ignore_errors=True)
    crates_dir.mkdir(parents=True, exist_ok=True)
    index_dir.mkdir(parents=True, exist_ok=True)
    (index_dir / "config.json").write_text(
        json.dumps({"dl": f"file://{crates_dir}/{{crate}}-{{version}}.crate"}, sort_keys=True) + "\n",
        encoding="utf-8",
    )

    entries_by_path: dict[Path, list[dict[str, Any]]] = {}
    copied: set[str] = set()
    for crate_path in crates:
        try:
            entry = cargo_index_entry(crate_path)
        except RuntimeError as error:
            result.add_skip(str(error))
            if strict:
                raise
            continue
        target_name = f"{entry['name']}-{entry['vers']}.crate"
        if target_name in copied:
            continue
        shutil.copy2(crate_path, crates_dir / target_name)
        copied.add(target_name)
        entries_by_path.setdefault(crate_index_path(entry["name"]), []).append(entry)
        result.published.append(target_name)

    for path, entries in entries_by_path.items():
        target = index_dir / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(
            "".join(json.dumps(entry, sort_keys=True, separators=(",", ":")) + "\n" for entry in entries),
            encoding="utf-8",
        )

    run(["git", "init"], cwd=index_dir)
    run(["git", "config", "user.name", "Oliphaunt Local Registry"], cwd=index_dir)
    run(["git", "config", "user.email", "local-registry@oliphaunt.invalid"], cwd=index_dir)
    run(["git", "add", "."], cwd=index_dir)
    run(["git", "commit", "-m", "local cargo registry"], cwd=index_dir)
    config_snippet.write_text(
        "\n".join(
            [
                "[registries.oliphaunt-local]",
                f'index = "file://{index_dir}"',
                "",
            ]
        ),
        encoding="utf-8",
    )
    result.staged.extend([rel(index_dir), rel(config_snippet)])
    return result


def copy_tree_contents(source: Path, destination: Path) -> int:
    copied = 0
    for path in source.rglob("*"):
        if not path.is_file():
            continue
        target = destination / path.relative_to(source)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(path, target)
        copied += 1
    return copied


def publish_maven(roots: list[Path], registry_root: Path, dry_run: bool, strict: bool) -> SurfaceResult:
    result = SurfaceResult("maven")
    candidates = sorted(
        path
        for root in roots
        for path in (root.rglob("maven") if root.is_dir() else [])
        if path.is_dir()
    )
    if not candidates:
        result.add_skip("no staged Maven repository directories named maven found")
        if strict:
            raise RuntimeError(result.skipped[-1])
        return result
    maven_root = registry_root / "maven"
    if dry_run:
        result.published.extend(f"dry-run maven copy {rel(path)}" for path in candidates)
        return result
    shutil.rmtree(maven_root, ignore_errors=True)
    maven_root.mkdir(parents=True, exist_ok=True)
    for candidate in candidates:
        count = copy_tree_contents(candidate, maven_root)
        result.published.append(f"{rel(candidate)} ({count} files)")
    result.staged.append(rel(maven_root))
    return result


def publish_swift(roots: list[Path], registry_root: Path, dry_run: bool, strict: bool) -> SurfaceResult:
    result = SurfaceResult("swift")
    swift_files = discover_files(roots, (".swift", ".zip"))
    swift_files = [
        path
        for path in swift_files
        if path.name == "Package.swift.release" or path.name.endswith("-source.zip") or "swift" in str(path)
    ]
    if not swift_files:
        result.add_skip("no SwiftPM package artifacts found")
        if strict:
            raise RuntimeError(result.skipped[-1])
        return result
    if not shutil.which("swift"):
        result.add_skip("swift is not installed; staged artifacts are copyable, registry publish skipped on this Linux host")
    swift_root = registry_root / "swift"
    if dry_run:
        result.published.extend(f"dry-run swift stage {rel(path)}" for path in swift_files)
        return result
    shutil.rmtree(swift_root, ignore_errors=True)
    swift_root.mkdir(parents=True, exist_ok=True)
    for path in swift_files:
        target = swift_root / path.name
        shutil.copy2(path, target)
        result.staged.append(rel(target))
    return result


def publish(args: argparse.Namespace) -> None:
    roots = discover_roots(args.artifact_root)
    args.registry_root.mkdir(parents=True, exist_ok=True)
    surfaces = args.surface or ["npm", "cargo", "maven", "swift"]
    results: list[SurfaceResult] = []
    for surface in surfaces:
        if surface == "npm":
            results.append(publish_npm(roots, args.registry_root, args.dry_run, args.strict, args.verdaccio_port))
        elif surface == "cargo":
            results.append(publish_cargo(roots, args.registry_root, args.dry_run, args.strict))
        elif surface == "maven":
            results.append(publish_maven(roots, args.registry_root, args.dry_run, args.strict))
        elif surface == "swift":
            results.append(publish_swift(roots, args.registry_root, args.dry_run, args.strict))
        else:
            raise RuntimeError(f"unsupported surface: {surface}")

    report = {
        "registry_root": str(args.registry_root),
        "artifact_roots": [str(root) for root in roots],
        "dry_run": args.dry_run,
        "surfaces": [result.__dict__ for result in results],
    }
    report_path = args.registry_root / "report.json"
    if not args.dry_run:
        report_path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2, sort_keys=True))


def status(args: argparse.Namespace) -> None:
    roots = discover_roots(args.artifact_root)
    report = {
        "default_run_id": DEFAULT_RUN_ID,
        "artifact_roots": [str(root) for root in roots],
        "tools": {
            "cargo": bool(shutil.which("cargo")),
            "gh": bool(shutil.which("gh")),
            "java": bool(shutil.which("java")),
            "npm": bool(shutil.which("npm")),
            "pnpm": bool(shutil.which("pnpm")),
            "swift": bool(shutil.which("swift")),
        },
        "artifacts": {
            "npm": [rel(path) for path in discover_files(roots, (".tgz",))],
            "cargo": [rel(path) for path in discover_files(roots, (".crate",))],
            "maven_roots": [
                rel(path)
                for root in roots
                for path in (root.rglob("maven") if root.is_dir() else [])
                if path.is_dir()
            ],
            "swift": [
                rel(path)
                for path in discover_files(roots, (".swift", ".zip"))
                if path.name == "Package.swift.release" or "swift" in str(path)
            ],
        },
    }
    print(json.dumps(report, indent=2, sort_keys=True))


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    download = subparsers.add_parser("download", help="download GitHub Actions artifacts with gh")
    download.add_argument("--repo", default=DEFAULT_REPO)
    download.add_argument("--run-id", default=DEFAULT_RUN_ID)
    download.add_argument("--destination", type=Path, default=DEFAULT_ARTIFACT_ROOT)
    download.add_argument("--artifact", action="append", default=[])
    download.add_argument("--preset", choices=["local-publish"], default=None)
    download.add_argument("--force", action="store_true")
    download.add_argument("--dry-run", action="store_true")
    download.set_defaults(func=download_artifacts)

    publish_parser = subparsers.add_parser("publish", help="publish staged artifacts to local registries")
    publish_parser.add_argument("--artifact-root", type=Path, action="append", default=[])
    publish_parser.add_argument("--registry-root", type=Path, default=DEFAULT_REGISTRY_ROOT)
    publish_parser.add_argument(
        "--surface",
        action="append",
        choices=["npm", "cargo", "maven", "swift"],
        help="publish only this surface; may be repeated",
    )
    publish_parser.add_argument("--verdaccio-port", type=int, default=4873)
    publish_parser.add_argument("--dry-run", action="store_true")
    publish_parser.add_argument("--strict", action="store_true")
    publish_parser.set_defaults(func=publish)

    status_parser = subparsers.add_parser("status", help="show locally available staged artifacts")
    status_parser.add_argument("--artifact-root", type=Path, action="append", default=[])
    status_parser.set_defaults(func=status)
    return parser


def main(argv: list[str] | None = None) -> None:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        args.func(args)
    except RuntimeError as error:
        print(f"local_registry_publish.py: {error}", file=sys.stderr)
        raise SystemExit(1) from error


if __name__ == "__main__":
    main()
