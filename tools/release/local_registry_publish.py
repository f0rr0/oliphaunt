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
import gzip
import hashlib
import json
import os
import platform as host_platform
import re
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

import artifact_targets
import extension_artifact_targets


ROOT = Path(__file__).resolve().parents[2]
DEFAULT_RUN_ID = "28049923289"
DEFAULT_REPO = "f0rr0/oliphaunt"
DEFAULT_REGISTRY_ROOT = ROOT / "target" / "local-registries"
DEFAULT_ARTIFACT_ROOT = ROOT / "target" / "local-registry-artifacts"
NPM_PACKAGE_SIZE_LIMIT_BYTES = 10 * 1024 * 1024
CRATES_IO_INDEX = "https://github.com/rust-lang/crates.io-index"
CARGO_PACKAGE_SIZE_LIMIT_BYTES = 10 * 1024 * 1024
CARGO_EXTENSION_PART_BYTES = 7 * 1024 * 1024
CARGO_EXTENSION_SPLIT_THRESHOLD_BYTES = 9 * 1024 * 1024
LEGACY_WASIX_ARTIFACT_CRATES = {
    "oliphaunt-wasix-assets",
    "oliphaunt-wasix-aot-aarch64-apple-darwin",
    "oliphaunt-wasix-aot-aarch64-unknown-linux-gnu",
    "oliphaunt-wasix-aot-x86_64-pc-windows-msvc",
    "oliphaunt-wasix-aot-x86_64-unknown-linux-gnu",
}

def local_publish_aggregate_artifacts() -> list[str]:
    return [
        artifact_targets.ci_aggregate_release_asset_artifact_name("liboliphaunt-native"),
        artifact_targets.ci_aggregate_release_asset_artifact_name("liboliphaunt-wasix"),
        *artifact_targets.ci_wasix_runtime_artifact_names(),
        *extension_artifact_targets.ci_wasix_extension_artifact_names(),
        *extension_artifact_targets.ci_extension_package_artifact_names(),
    ]


def local_publish_artifacts() -> list[str]:
    artifacts = [
        *local_publish_aggregate_artifacts(),
        *artifact_targets.ci_release_asset_artifact_names("liboliphaunt-native", "native-runtime"),
        *artifact_targets.ci_wasix_aot_runtime_artifact_names(),
        *artifact_targets.ci_release_asset_artifact_names("oliphaunt-broker", "broker-helper"),
        *artifact_targets.ci_release_asset_artifact_names("oliphaunt-node-direct", "node-direct-addon"),
        *artifact_targets.ci_npm_package_artifact_names("oliphaunt-node-direct", "node-direct-addon"),
        *artifact_targets.ci_sdk_package_artifact_names(),
    ]
    duplicates = sorted({artifact for artifact in artifacts if artifacts.count(artifact) > 1})
    if duplicates:
        raise RuntimeError("duplicate local publish artifact names: " + ", ".join(duplicates))
    return artifacts


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


def discover_roots(artifact_roots: Iterable[Path]) -> list[Path]:
    explicit_roots = list(artifact_roots)
    roots = explicit_roots or [
        DEFAULT_ARTIFACT_ROOT,
        ROOT / "target" / "sdk-artifacts",
        ROOT / "target" / "package" / "tmp-crate",
        ROOT / "target" / "package" / "tmp-registry",
        ROOT / "target" / "local-registry-generated" / "broker-cargo",
        ROOT / "target" / "oliphaunt-broker" / "cargo-artifacts",
        ROOT / "target" / "extension-artifacts",
    ]
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
        artifacts.extend(local_publish_artifacts())
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


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as file:
        for chunk in iter(lambda: file.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def copy_release_assets(
    roots: list[Path],
    destination: Path,
    patterns: tuple[str, ...],
) -> list[Path]:
    candidates: list[Path] = []
    destination_resolved = destination.resolve()
    for root in roots:
        if not root.is_dir():
            continue
        for pattern in patterns:
            for path in root.rglob(pattern):
                if not path.is_file():
                    continue
                try:
                    path.resolve().relative_to(destination_resolved)
                    continue
                except ValueError:
                    pass
                candidates.append(path)
    if not candidates:
        return []

    shutil.rmtree(destination, ignore_errors=True)
    destination.mkdir(parents=True, exist_ok=True)
    copied: list[Path] = []
    for source in sorted(candidates):
        target = destination / source.name
        if target.is_file():
            if file_sha256(target) != file_sha256(source):
                raise RuntimeError(
                    f"conflicting release asset {source.name}: {rel(target)} and {rel(source)} differ"
                )
            continue
        shutil.copy2(source, target)
        copied.append(target)
    return copied


def release_asset_dir_has_files(asset_dir: Path, patterns: tuple[str, ...]) -> bool:
    if not asset_dir.is_dir():
        return False
    return any(path.is_file() for pattern in patterns for path in asset_dir.glob(pattern))


def release_asset_dir_selected(roots: list[Path], asset_dir: Path) -> bool:
    resolved = asset_dir.resolve()
    return any(root.resolve() == resolved for root in roots)


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


def host_cargo_release_target() -> str | None:
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


def cargo_target_triple(target: str) -> str | None:
    if target == "linux-x64-gnu":
        return "x86_64-unknown-linux-gnu"
    if target == "linux-arm64-gnu":
        return "aarch64-unknown-linux-gnu"
    if target == "macos-arm64":
        return "aarch64-apple-darwin"
    if target == "windows-x64-msvc":
        return "x86_64-pc-windows-msvc"
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
    root = root.resolve()
    config = root / "config.yaml"
    storage = root / "storage"
    storage.mkdir(parents=True, exist_ok=True)
    (root / "plugins").mkdir(parents=True, exist_ok=True)
    text = "\n".join(
        [
            f"storage: {storage}",
            "max_body_size: 100mb",
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


def npm_auth_is_valid(registry_url: str, npmrc: Path) -> bool:
    completed = run(
        [
            "npm",
            "whoami",
            "--registry",
            registry_url,
            "--userconfig",
            str(npmrc),
            "--loglevel=error",
        ],
        check=False,
        capture=True,
        timeout=10,
    )
    return completed.returncode == 0


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
        if npm_auth_is_valid(registry_url, npmrc):
            return npmrc
        npmrc.unlink()
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


def npm_tarball_priority(path: Path, registry_root: Path) -> tuple[int, float, str]:
    resolved = path.resolve()
    priority = 20
    for root, value in [
        (ROOT / "target" / "release" / "npm-packages", 100),
        (ROOT / "target" / "sdk-artifacts", 90),
        (registry_root / "npm-extension-packages", 80),
        (DEFAULT_ARTIFACT_ROOT, 30),
    ]:
        try:
            resolved.relative_to(root.resolve())
        except ValueError:
            continue
        priority = value
        break
    try:
        modified = path.stat().st_mtime
    except OSError:
        modified = 0
    return priority, modified, str(path)


def select_npm_tarballs(tarballs: list[Path], registry_root: Path, result: SurfaceResult) -> list[Path]:
    selected: dict[tuple[str, str], Path] = {}
    unidentified: list[Path] = []
    for tarball in tarballs:
        identity = npm_package_identity(tarball)
        if identity is None:
            unidentified.append(tarball)
            continue
        current = selected.get(identity)
        if current is None:
            selected[identity] = tarball
            continue
        if npm_tarball_priority(tarball, registry_root) > npm_tarball_priority(current, registry_root):
            selected[identity] = tarball
            result.staged.append(
                f"preferred {rel(tarball)} over {rel(current)} for {identity[0]}@{identity[1]}"
            )
        else:
            result.staged.append(
                f"preferred {rel(current)} over {rel(tarball)} for {identity[0]}@{identity[1]}"
            )
    return sorted([*unidentified, *selected.values()])


def stage_release_asset_npm_packages(
    roots: list[Path],
    registry_root: Path,
    dry_run: bool,
    result: SurfaceResult,
) -> list[Path]:
    if dry_run:
        result.staged.append("dry-run generated liboliphaunt and broker npm artifact packages")
        return []

    sys.path.insert(0, str(ROOT / "tools" / "release"))
    import release  # type: ignore

    tarballs: list[Path] = []
    target = host_npm_target()
    targets = {target} if target is not None else None

    lib_asset_dir = ROOT / "target" / "liboliphaunt" / "release-assets"
    lib_version = release.current_product_version("liboliphaunt-native")
    lib_patterns = (f"liboliphaunt-{lib_version}-*", f"oliphaunt-tools-{lib_version}-*")
    copied_lib = copy_release_assets(roots, lib_asset_dir, lib_patterns)
    if copied_lib or (release_asset_dir_selected(roots, lib_asset_dir) and release.liboliphaunt_release_assets_ready()):
        if copied_lib:
            result.staged.append(f"staged {len(copied_lib)} liboliphaunt release asset(s)")
        tarballs.extend(
            path
            for _package_name, path in release.liboliphaunt_npm_tarballs(
                lib_version,
                validate_assets=False,
                targets=targets,
            )
        )
    else:
        result.add_skip("no liboliphaunt release assets found for native npm artifact packages")

    broker_asset_dir = ROOT / "target" / "oliphaunt-broker" / "release-assets"
    copied_broker = copy_release_assets(
        roots,
        broker_asset_dir,
        ("oliphaunt-broker-*.tar.gz", "oliphaunt-broker-*.zip"),
    )
    if copied_broker or (
        release_asset_dir_selected(roots, broker_asset_dir)
        and (any(broker_asset_dir.glob("oliphaunt-broker-*.tar.gz")) or any(broker_asset_dir.glob("oliphaunt-broker-*.zip")))
    ):
        if copied_broker:
            result.staged.append(f"staged {len(copied_broker)} broker release asset(s)")
        version = release.current_product_version("oliphaunt-broker")
        tarballs.extend(
            path
            for _package_name, path in release.broker_npm_tarballs(
                version,
                validate_assets=False,
                targets=targets,
            )
        )
    else:
        result.add_skip("no broker release assets found for broker npm artifact packages")

    if tarballs:
        result.staged.append(f"generated {len(tarballs)} release-asset npm package(s)")
    return tarballs


def publish_npm(roots: list[Path], registry_root: Path, dry_run: bool, strict: bool, port: int) -> SurfaceResult:
    result = SurfaceResult("npm")
    generated_tarballs = stage_release_asset_npm_packages(roots, registry_root, dry_run, result)
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
    tarballs = select_npm_tarballs([*discover_files(roots, (".tgz",)), *generated_tarballs], registry_root, result)
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
            command = [
                "npm",
                "unpublish",
                f"{identity[0]}@{identity[1]}",
                "--registry",
                registry_url,
                "--force",
                "--loglevel=error",
            ]
            if npmrc is not None:
                command.extend(["--userconfig", str(npmrc)])
            run(command)
            result.staged.append(f"replaced {identity[0]}@{identity[1]}")
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
    pnpm_store = registry_root / "pnpm-store"
    shutil.rmtree(pnpm_store, ignore_errors=True)
    result.staged.append(f"cleared local pnpm store {rel(pnpm_store)}")
    return result


def read_cargo_package_name_version(manifest: Path) -> tuple[str, str]:
    data = tomllib.loads(manifest.read_text(encoding="utf-8"))
    package = data.get("package")
    if not isinstance(package, dict):
        raise RuntimeError(f"{rel(manifest)} is missing [package]")
    name = package.get("name")
    version = package.get("version")
    if not isinstance(name, str) or not isinstance(version, str) or not name or not version:
        raise RuntimeError(f"{rel(manifest)} must declare package name and version")
    return name, version


def packaged_cargo_manifest_text(text: str) -> str:
    text = text.replace(
        "repository.workspace = true",
        'repository = "https://github.com/f0rr0/oliphaunt"',
    ).replace(
        "homepage.workspace = true",
        'homepage = "https://oliphaunt.dev"',
    )
    text = re.sub(r', path = "[^"]+"', "", text)
    if "\n[workspace]" not in text:
        text = text.rstrip() + "\n\n[workspace]\n"
    return text


def cargo_package_name_from_crate(crate_path: Path) -> str | None:
    try:
        with tarfile.open(crate_path, "r:gz") as archive:
            manifests = [
                member
                for member in archive.getmembers()
                if member.isfile() and member.name.count("/") == 1 and member.name.endswith("/Cargo.toml")
            ]
            if not manifests:
                return None
            extracted = archive.extractfile(manifests[0])
            if extracted is None:
                return None
            data = tomllib.loads(extracted.read().decode("utf-8"))
    except (tarfile.TarError, tomllib.TOMLDecodeError, UnicodeDecodeError, OSError):
        return None
    package = data.get("package")
    if not isinstance(package, dict):
        return None
    name = package.get("name")
    return name if isinstance(name, str) and name else None


def cargo_package_names_from_roots(roots: list[Path]) -> set[str]:
    names: set[str] = set()
    for crate_path in discover_files(roots, (".crate",)):
        name = cargo_package_name_from_crate(crate_path)
        if name is not None:
            names.add(name)
    return names


def prune_missing_local_artifact_target_dependencies(
    manifest: Path,
    available_package_names: set[str],
    result: SurfaceResult,
) -> None:
    text = manifest.read_text(encoding="utf-8")
    lines = text.splitlines()
    output: list[str] = []
    removed: list[tuple[str, list[str]]] = []
    index = 0
    while index < len(lines):
        line = lines[index]
        if not re.match(r"^\[target\..*\.dependencies\]$", line):
            output.append(line)
            index += 1
            continue

        block = [line]
        index += 1
        while index < len(lines) and not re.match(r"^\[[^\]]+\]$", lines[index]):
            block.append(lines[index])
            index += 1

        dependency_names = []
        for block_line in block[1:]:
            match = re.match(r"^([A-Za-z0-9_-]+)\s*=", block_line)
            if match:
                dependency_names.append(match.group(1))
        missing = sorted(name for name in dependency_names if name not in available_package_names)
        if missing:
            removed.append((line, missing))
            while output and output[-1] == "":
                output.pop()
            continue
        if output and output[-1] != "":
            output.append("")
        output.extend(block)

    if not removed:
        return
    manifest.write_text("\n".join(output).rstrip() + "\n", encoding="utf-8")
    for header, missing in removed:
        result.add_skip(
            f"{rel(manifest)} pruned {header} because local registry inputs are missing {', '.join(missing)}"
        )


def cargo_metadata_package_from_manifest(manifest: Path) -> dict[str, Any]:
    completed = run(
        [
            "cargo",
            "metadata",
            "--manifest-path",
            str(manifest),
            "--format-version",
            "1",
            "--no-deps",
        ],
        check=False,
        capture=True,
    )
    if completed.returncode != 0:
        raise RuntimeError(
            f"cargo metadata failed for {rel(manifest)}: {completed.stderr.strip()}"
        )
    packages = json.loads(completed.stdout).get("packages")
    if not isinstance(packages, list) or len(packages) != 1:
        raise RuntimeError(f"cargo metadata for {rel(manifest)} did not return exactly one package")
    package = packages[0]
    if not isinstance(package, dict):
        raise RuntimeError(f"cargo metadata for {rel(manifest)} returned an invalid package")
    return package


def manual_cargo_package_source(manifest: Path, output_dir: Path) -> Path:
    name, version = read_cargo_package_name_version(manifest)
    source_dir = manifest.parent
    package_root = f"{name}-{version}"
    stage_root = output_dir / "manual-package-stage"
    stage_dir = stage_root / package_root
    crate_path = output_dir / f"{package_root}.crate"
    shutil.rmtree(stage_dir, ignore_errors=True)
    stage_dir.parent.mkdir(parents=True, exist_ok=True)
    output_dir.mkdir(parents=True, exist_ok=True)
    shutil.copytree(
        source_dir,
        stage_dir,
        ignore=shutil.ignore_patterns("target", ".git", ".DS_Store"),
    )
    staged_manifest = stage_dir / "Cargo.toml"
    staged_manifest.write_text(
        packaged_cargo_manifest_text(staged_manifest.read_text(encoding="utf-8")),
        encoding="utf-8",
    )
    package = cargo_metadata_package_from_manifest(staged_manifest)
    if package.get("name") != name or package.get("version") != version:
        raise RuntimeError(f"{rel(staged_manifest)} produced unexpected cargo metadata")
    if crate_path.exists():
        crate_path.unlink()
    with crate_path.open("wb") as raw_output:
        with gzip.GzipFile(fileobj=raw_output, mode="wb", mtime=0) as gzip_output:
            with tarfile.open(fileobj=gzip_output, mode="w") as archive:
                for path in sorted(item for item in stage_dir.rglob("*") if item.is_file()):
                    arcname = f"{package_root}/{path.relative_to(stage_dir).as_posix()}"
                    info = archive.gettarinfo(path, arcname)
                    info.uid = 0
                    info.gid = 0
                    info.uname = ""
                    info.gname = ""
                    info.mtime = 0
                    with path.open("rb") as handle:
                        archive.addfile(info, handle)
    size = crate_path.stat().st_size
    if size > CARGO_PACKAGE_SIZE_LIMIT_BYTES:
        raise RuntimeError(f"{rel(crate_path)} is {size} bytes, above the crates.io 10 MiB package limit")
    return crate_path


def stage_cargo_source_crates(
    roots: list[Path],
    registry_root: Path,
    dry_run: bool,
    result: SurfaceResult,
) -> list[Path]:
    output_dir = registry_root / "cargo-generated" / "source-crates"
    if dry_run:
        result.staged.append("dry-run generated local Cargo source crates")
        return []
    shutil.rmtree(output_dir, ignore_errors=True)
    output_dir.mkdir(parents=True, exist_ok=True)

    generated: list[Path] = []
    build_manifest = ROOT / "src/sdks/rust/crates/oliphaunt-build/Cargo.toml"
    generated.append(manual_cargo_package_source(build_manifest, output_dir))

    sys.path.insert(0, str(ROOT / "tools/release"))
    import release  # type: ignore

    oliphaunt_manifest = release.prepare_oliphaunt_release_source(
        release.current_product_version("oliphaunt-rust")
    )
    available_package_names = cargo_package_names_from_roots(roots)
    native_source_root = ROOT / "target/liboliphaunt/cargo-package-sources"
    native_runtime_public_manifests = native_runtime_artifact_manifests(native_source_root)
    native_runtime_all_manifests = native_runtime_artifact_manifests(
        native_source_root,
        include_parts=True,
    )
    for manifest in native_runtime_public_manifests:
        name, _version = read_cargo_package_name_version(manifest)
        available_package_names.add(name)
    prune_missing_local_artifact_target_dependencies(
        oliphaunt_manifest,
        available_package_names,
        result,
    )
    generated.append(manual_cargo_package_source(oliphaunt_manifest, output_dir))

    wasix_manifest = release.prepare_oliphaunt_wasix_release_source(
        release.current_product_version("oliphaunt-wasix-rust")
    )
    prune_missing_local_artifact_target_dependencies(
        wasix_manifest,
        available_package_names,
        result,
    )
    generated.append(manual_cargo_package_source(wasix_manifest, output_dir))

    for manifest in native_runtime_all_manifests:
        generated.append(manual_cargo_package_source(manifest, output_dir))

    result.staged.extend(rel(path) for path in generated)
    return generated


def native_runtime_artifact_manifests(source_root: Path, *, include_parts: bool = False) -> list[Path]:
    if not source_root.is_dir():
        return []
    manifests = [
        *source_root.glob("liboliphaunt-native-*/Cargo.toml"),
        *source_root.glob("oliphaunt-tools-*/Cargo.toml"),
    ]
    result: list[Path] = []
    seen: set[Path] = set()
    for manifest in sorted(manifests):
        if manifest in seen:
            continue
        seen.add(manifest)
        name, _version = read_cargo_package_name_version(manifest)
        if "-part-" in name and not include_parts:
            continue
        result.append(manifest)
    return result


def native_extension_cargo_package_name(product: str, target: str) -> str:
    return f"{product}-{target}"


def native_extension_cargo_links_name(product: str, target: str) -> str:
    stem = f"extension_{product.removeprefix('oliphaunt-extension-')}_{target}"
    return "oliphaunt_artifact_" + stem.replace("-", "_")


def native_extension_cargo_part_package_name(product: str, target: str, index: int) -> str:
    return f"{native_extension_cargo_package_name(product, target)}-part-{index:03d}"


def rust_crate_ident(crate_name: str) -> str:
    return crate_name.replace("-", "_")


def toml_string(value: str) -> str:
    return json.dumps(value)


def payload_files(source_root: Path) -> list[Path]:
    return sorted(path for path in source_root.rglob("*") if path.is_file())


def write_chunk(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)


def copy_payload_file(source: Path, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, destination)


def write_native_extension_cargo_part_crate(
    crate_dir: Path,
    *,
    product: str,
    version: str,
    sql_name: str,
    target: str,
    index: int,
) -> None:
    name = native_extension_cargo_part_package_name(product, target, index)
    (crate_dir / "src").mkdir(parents=True, exist_ok=True)
    (crate_dir / "Cargo.toml").write_text(
        "\n".join(
            [
                "[package]",
                f'name = "{name}"',
                f'version = "{version}"',
                'edition = "2024"',
                'rust-version = "1.93"',
                f'description = "Cargo payload part {index:03d} for the {sql_name} Oliphaunt native extension on {target}."',
                'readme = "README.md"',
                'repository = "https://github.com/f0rr0/oliphaunt"',
                'homepage = "https://oliphaunt.dev"',
                'license = "MIT AND Apache-2.0 AND PostgreSQL"',
                'include = ["Cargo.toml", "README.md", "src/**", "payload/**"]',
                "",
                "[lib]",
                'path = "src/lib.rs"',
                "",
                "[workspace]",
                "",
            ]
        ),
        encoding="utf-8",
    )
    (crate_dir / "README.md").write_text(
        "\n".join(
            [
                f"# {name}",
                "",
                f"Cargo payload part for the `{sql_name}` Oliphaunt native extension on `{target}`.",
                "Applications do not depend on this crate directly.",
                "",
            ]
        ),
        encoding="utf-8",
    )
    (crate_dir / "src" / "lib.rs").write_text(
        "\n".join(
            [
                f'pub const PRODUCT: &str = "{product}";',
                'pub const KIND: &str = "extension-part";',
                f'pub const SQL_NAME: &str = "{sql_name}";',
                f'pub const RELEASE_TARGET: &str = "{target}";',
                f"pub const PART_INDEX: usize = {index};",
                'pub const PAYLOAD_ROOT: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/payload");',
                "",
            ]
        ),
        encoding="utf-8",
    )


def build_native_extension_part_crates(
    runtime_dir: Path,
    source_root: Path,
    *,
    product: str,
    version: str,
    sql_name: str,
    target: str,
    part_bytes: int = CARGO_EXTENSION_PART_BYTES,
) -> list[Path]:
    part_dirs: list[Path] = []
    current_dir: Path | None = None
    current_size = 0

    def start_part() -> Path:
        index = len(part_dirs)
        part_dir = source_root / native_extension_cargo_part_package_name(product, target, index)
        write_native_extension_cargo_part_crate(
            part_dir,
            product=product,
            version=version,
            sql_name=sql_name,
            target=target,
            index=index,
        )
        part_dirs.append(part_dir)
        return part_dir

    for source in payload_files(runtime_dir):
        relative = source.relative_to(runtime_dir).as_posix()
        size = source.stat().st_size
        if size > part_bytes:
            current_dir = None
            current_size = 0
            with source.open("rb") as handle:
                chunk_index = 0
                while True:
                    data = handle.read(part_bytes)
                    if not data:
                        break
                    part_dir = start_part()
                    write_chunk(
                        part_dir / "payload" / "chunks" / f"{relative}.part{chunk_index:03d}",
                        data,
                    )
                    chunk_index += 1
            continue
        if current_dir is None or current_size + size > part_bytes:
            current_dir = start_part()
            current_size = 0
        copy_payload_file(source, current_dir / "payload" / "files" / relative)
        current_size += size

    if not part_dirs:
        raise RuntimeError(f"{product}@{version} generated no native extension Cargo part crates")
    return part_dirs


NATIVE_EXTENSION_AGGREGATOR_BUILD_RS = r'''use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::env;
use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};

const SCHEMA: &str = __SCHEMA__;
const PRODUCT: &str = __PRODUCT__;
const VERSION: &str = env!("CARGO_PKG_VERSION");
const KIND: &str = "extension";
const TARGET: &str = __TARGET__;
const EXTENSION: &str = __EXTENSION__;
const PART_ROOTS: &[&str] = &[
__PART_ROOTS__
];

fn main() {
    emit_manifest();
}

fn emit_manifest() {
    let out_dir = PathBuf::from(env::var_os("OUT_DIR").expect("OUT_DIR is set"));
    let payload = out_dir.join("payload");
    if payload.exists() {
        fs::remove_dir_all(&payload).expect("remove stale Oliphaunt extension payload");
    }
    fs::create_dir_all(&payload).expect("create Oliphaunt extension payload directory");

    let part_roots = part_roots();
    if part_roots.is_empty() {
        if env::var_os("OLIPHAUNT_ARTIFACT_CRATE_REQUIRE_PAYLOAD").is_some() {
            panic!("missing Oliphaunt extension payload part crates");
        }
        return;
    }

    let mut chunk_files: BTreeMap<String, Vec<(usize, PathBuf)>> = BTreeMap::new();
    for root in part_roots {
        println!("cargo::rerun-if-changed={}", root.display());
        copy_complete_files(&root.join("files"), &payload).expect("copy complete extension payload files");
        collect_chunks(&root.join("chunks"), &root.join("chunks"), &mut chunk_files)
            .expect("collect extension payload chunks");
    }

    for (relative, mut chunks) in chunk_files {
        chunks.sort_by_key(|(index, _)| *index);
        for (expected, (actual, _)) in chunks.iter().enumerate() {
            if *actual != expected {
                panic!("non-contiguous Oliphaunt extension chunk indexes for {relative}");
            }
        }
        let output = payload.join(&relative);
        if let Some(parent) = output.parent() {
            fs::create_dir_all(parent).expect("create reconstructed extension file parent");
        }
        let mut writer = fs::File::create(&output).expect("create reconstructed extension payload file");
        for (_, path) in chunks {
            let mut reader = fs::File::open(&path).expect("open extension payload chunk");
            io::copy(&mut reader, &mut writer).expect("append extension payload chunk");
        }
    }

    let files = collect_files(&payload).expect("collect reconstructed extension payload files");
    if files.is_empty() {
        panic!("Oliphaunt extension payload part crates produced no files");
    }
    let manifest = out_dir.join("oliphaunt-artifact.toml");
    let mut text = format!(
        "schema = {SCHEMA:?}\nproduct = {PRODUCT:?}\nversion = {VERSION:?}\nkind = {KIND:?}\ntarget = {TARGET:?}\nextension = {EXTENSION:?}\n"
    );
    for file in files {
        let relative = file.strip_prefix(&payload)
            .expect("payload file stays under payload root")
            .to_string_lossy()
            .replace('\\', "/");
        let sha256 = sha256_file(&file).expect("hash extension payload file");
        text.push_str(&format!(
            "\n[[files]]\nsource = {:?}\nrelative = {:?}\nsha256 = {:?}\nexecutable = false\n",
            file.display().to_string(),
            relative,
            sha256,
        ));
    }
    fs::write(&manifest, text).expect("write Oliphaunt extension artifact manifest");
    println!("cargo::metadata=manifest={}", manifest.display());
}

fn part_roots() -> Vec<PathBuf> {
    PART_ROOTS.iter().map(PathBuf::from).collect()
}

fn copy_complete_files(source: &Path, destination: &Path) -> io::Result<()> {
    if !source.is_dir() {
        return Ok(());
    }
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let path = entry.path();
        let output = destination.join(path.strip_prefix(source).unwrap_or(&path));
        copy_tree_entry(&path, &output)?;
    }
    Ok(())
}

fn copy_tree_entry(source: &Path, destination: &Path) -> io::Result<()> {
    let metadata = fs::metadata(source)?;
    if metadata.is_dir() {
        fs::create_dir_all(destination)?;
        for entry in fs::read_dir(source)? {
            let entry = entry?;
            copy_tree_entry(&entry.path(), &destination.join(entry.file_name()))?;
        }
    } else if metadata.is_file() {
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::copy(source, destination)?;
    }
    Ok(())
}

fn collect_chunks(
    root: &Path,
    current: &Path,
    chunks: &mut BTreeMap<String, Vec<(usize, PathBuf)>>,
) -> io::Result<()> {
    if !current.is_dir() {
        return Ok(());
    }
    for entry in fs::read_dir(current)? {
        let entry = entry?;
        let path = entry.path();
        let metadata = fs::metadata(&path)?;
        if metadata.is_dir() {
            collect_chunks(root, &path, chunks)?;
            continue;
        }
        if !metadata.is_file() {
            continue;
        }
        let relative = path.strip_prefix(root).unwrap_or(&path).to_string_lossy().replace('\\', "/");
        let (file_relative, part_index) = split_part_relative(&relative)
            .unwrap_or_else(|| panic!("invalid Oliphaunt extension chunk file name {relative}"));
        chunks.entry(file_relative).or_default().push((part_index, path));
    }
    Ok(())
}

fn split_part_relative(relative: &str) -> Option<(String, usize)> {
    let (file, index) = relative.rsplit_once(".part")?;
    if file.is_empty() || index.len() != 3 || !index.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    Some((file.to_owned(), index.parse().ok()?))
}

fn collect_files(root: &Path) -> io::Result<Vec<PathBuf>> {
    let mut files = Vec::new();
    collect_files_inner(root, &mut files)?;
    files.sort();
    Ok(files)
}

fn collect_files_inner(path: &Path, files: &mut Vec<PathBuf>) -> io::Result<()> {
    if !path.is_dir() {
        return Ok(());
    }
    for entry in fs::read_dir(path)? {
        let entry = entry?;
        let entry_path = entry.path();
        let metadata = fs::metadata(&entry_path)?;
        if metadata.is_dir() {
            collect_files_inner(&entry_path, files)?;
        } else if metadata.is_file() {
            files.push(entry_path);
        }
    }
    Ok(())
}

fn sha256_file(path: &Path) -> io::Result<String> {
    let mut file = fs::File::open(path)?;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 1024 * 64];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    let digest = digest.finalize();
    let mut output = String::with_capacity(digest.len() * 2);
    for byte in digest {
        use std::fmt::Write as _;
        let _ = write!(&mut output, "{byte:02x}");
    }
    Ok(output)
}
'''


def write_native_extension_split_aggregator_crate(
    crate_dir: Path,
    *,
    product: str,
    version: str,
    sql_name: str,
    target: str,
    triple: str,
    part_dirs: list[Path],
) -> None:
    name = native_extension_cargo_package_name(product, target)
    links = native_extension_cargo_links_name(product, target)
    shutil.rmtree(crate_dir / "payload", ignore_errors=True)
    dependency_lines = []
    for index, part_dir in enumerate(part_dirs):
        dependency_name = native_extension_cargo_part_package_name(product, target, index)
        dependency_path = Path(os.path.relpath(part_dir, crate_dir)).as_posix()
        dependency_lines.append(
            f'{dependency_name} = {{ version = "={version}", path = "{dependency_path}" }}'
        )
    part_roots = [
        f"    {rust_crate_ident(native_extension_cargo_part_package_name(product, target, index))}::PAYLOAD_ROOT,"
        for index in range(len(part_dirs))
    ]
    (crate_dir / "Cargo.toml").write_text(
        "\n".join(
            [
                "[package]",
                f'name = "{name}"',
                f'version = "{version}"',
                'edition = "2024"',
                'rust-version = "1.93"',
                f'description = "Cargo artifact crate for the {sql_name} Oliphaunt native extension on {target}."',
                'readme = "README.md"',
                'repository = "https://github.com/f0rr0/oliphaunt"',
                'homepage = "https://oliphaunt.dev"',
                'license = "MIT AND Apache-2.0 AND PostgreSQL"',
                f'links = "{links}"',
                'build = "build.rs"',
                'include = ["Cargo.toml", "README.md", "build.rs", "src/**"]',
                "",
                "[lib]",
                'path = "src/lib.rs"',
                "",
                "[build-dependencies]",
                'sha2 = "0.10"',
                *dependency_lines,
                "",
                "[workspace]",
                "",
            ]
        ),
        encoding="utf-8",
    )
    build_rs = (
        NATIVE_EXTENSION_AGGREGATOR_BUILD_RS.replace(
            "__SCHEMA__", toml_string("oliphaunt-artifact-manifest-v1")
        )
        .replace("__PRODUCT__", toml_string(product))
        .replace("__TARGET__", toml_string(triple))
        .replace("__EXTENSION__", toml_string(sql_name))
        .replace("__PART_ROOTS__", "\n".join(part_roots))
    )
    (crate_dir / "build.rs").write_text(build_rs, encoding="utf-8")


def cargo_package(crate_dir: Path, target_dir: Path, *, no_verify: bool = False) -> Path:
    name, version = read_cargo_package_name_version(crate_dir / "Cargo.toml")
    command = [
        "cargo",
        "package",
        "--manifest-path",
        str(crate_dir / "Cargo.toml"),
        "--target-dir",
        str(target_dir),
        "--allow-dirty",
    ]
    if no_verify:
        command.append("--no-verify")
    run(command, env={**os.environ, "OLIPHAUNT_ARTIFACT_CRATE_REQUIRE_PAYLOAD": "1"})
    crate_path = target_dir / "package" / f"{name}-{version}.crate"
    if not crate_path.is_file():
        raise RuntimeError(f"cargo package did not create {rel(crate_path)}")
    return crate_path


def discard_cargo_package_artifact(crate_path: Path) -> None:
    crate_path.unlink(missing_ok=True)
    (crate_path.parent / "tmp-crate" / crate_path.name).unlink(missing_ok=True)


def write_native_extension_cargo_crate(
    crate_dir: Path,
    *,
    product: str,
    version: str,
    sql_name: str,
    target: str,
    triple: str,
    asset: Path,
) -> None:
    name = native_extension_cargo_package_name(product, target)
    links = native_extension_cargo_links_name(product, target)
    runtime_dir = crate_dir / "payload"
    extract_extension_runtime(asset, runtime_dir)
    strip_extension_modules(runtime_dir, target)
    if not any(runtime_dir.rglob("*")):
        raise RuntimeError(f"{rel(asset)} did not contain extension runtime files")
    (crate_dir / "src").mkdir(parents=True, exist_ok=True)
    (crate_dir / "README.md").write_text(
        "\n".join(
            [
                f"# {name}",
                "",
                f"Cargo artifact crate for the `{sql_name}` Oliphaunt native extension on `{target}`.",
                "",
            ]
        ),
        encoding="utf-8",
    )
    (crate_dir / "Cargo.toml").write_text(
        "\n".join(
            [
                "[package]",
                f'name = "{name}"',
                f'version = "{version}"',
                'edition = "2024"',
                'rust-version = "1.93"',
                f'description = "Cargo artifact crate for the {sql_name} Oliphaunt native extension on {target}."',
                'readme = "README.md"',
                'repository = "https://github.com/f0rr0/oliphaunt"',
                'homepage = "https://oliphaunt.dev"',
                'license = "MIT AND Apache-2.0 AND PostgreSQL"',
                f'links = "{links}"',
                'build = "build.rs"',
                'include = ["Cargo.toml", "README.md", "build.rs", "src/**", "payload/**"]',
                "",
                "[lib]",
                'path = "src/lib.rs"',
                "",
                "[build-dependencies]",
                'sha2 = "0.10"',
                "",
                "[workspace]",
                "",
            ]
        ),
        encoding="utf-8",
    )
    (crate_dir / "src/lib.rs").write_text(
        "\n".join(
            [
                f'pub const PRODUCT: &str = "{product}";',
                'pub const KIND: &str = "extension";',
                f'pub const SQL_NAME: &str = "{sql_name}";',
                f'pub const RELEASE_TARGET: &str = "{target}";',
                f'pub const CARGO_TARGET: &str = "{triple}";',
                "",
            ]
        ),
        encoding="utf-8",
    )
    (crate_dir / "build.rs").write_text(
        f"""use sha2::{{Digest, Sha256}};
use std::env;
use std::fs;
use std::io::Read;
use std::path::{{Path, PathBuf}};

const SCHEMA: &str = "oliphaunt-artifact-manifest-v1";
const PRODUCT: &str = {json.dumps(product)};
const VERSION: &str = env!("CARGO_PKG_VERSION");
const KIND: &str = "extension";
const TARGET: &str = {json.dumps(triple)};
const EXTENSION: &str = {json.dumps(sql_name)};

fn main() {{
    let manifest_dir =
        PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR is set"));
    let payload = manifest_dir.join("payload");
    println!("cargo::rerun-if-changed={{}}", payload.display());
    if !payload.is_dir() {{
        if env::var_os("OLIPHAUNT_ARTIFACT_CRATE_REQUIRE_PAYLOAD").is_some() {{
            panic!("missing packaged extension payload under {{}}", payload.display());
        }}
        return;
    }}
    let out_dir = PathBuf::from(env::var_os("OUT_DIR").expect("OUT_DIR is set"));
    let manifest = out_dir.join("oliphaunt-artifact.toml");
    let mut text = format!(
        "schema = {{SCHEMA:?}}\\nproduct = {{PRODUCT:?}}\\nversion = {{VERSION:?}}\\nkind = {{KIND:?}}\\ntarget = {{TARGET:?}}\\nextension = {{EXTENSION:?}}\\n"
    );
    for file in payload_files(&payload) {{
        let relative = file.strip_prefix(&payload).expect("payload file stays under payload");
        let sha256 = sha256_file(&file);
        text.push_str(&format!(
            "\\n[[files]]\\nsource = {{:?}}\\nrelative = {{:?}}\\nsha256 = {{sha256:?}}\\nexecutable = false\\n",
            file.display().to_string(),
            relative.to_string_lossy().replace('\\\\', "/"),
        ));
    }}
    fs::write(&manifest, text).expect("write Oliphaunt extension artifact manifest");
    println!("cargo::metadata=manifest={{}}", manifest.display());
}}

fn payload_files(root: &Path) -> Vec<PathBuf> {{
    let mut files = Vec::new();
    collect_payload_files(root, &mut files);
    files.sort();
    files
}}

fn collect_payload_files(root: &Path, files: &mut Vec<PathBuf>) {{
    for entry in fs::read_dir(root).expect("read payload directory") {{
        let path = entry.expect("read payload entry").path();
        if path.is_dir() {{
            collect_payload_files(&path, files);
        }} else if path.is_file() {{
            files.push(path);
        }}
    }}
}}

fn sha256_file(path: &Path) -> String {{
    let mut file = fs::File::open(path).expect("open payload file for hashing");
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 8192];
    loop {{
        let read = file.read(&mut buffer).expect("read payload file for hashing");
        if read == 0 {{
            break;
        }}
        hasher.update(&buffer[..read]);
    }}
    format!("{{:x}}", hasher.finalize())
}}
""",
        encoding="utf-8",
    )


def package_native_extension_cargo_crates(
    roots: list[Path],
    staging_root: Path,
    target: str | None,
    dry_run: bool,
    strict: bool,
    result: SurfaceResult,
) -> list[Path]:
    if target is None:
        result.add_skip("current host does not map to a supported native extension Cargo target")
        return []
    triple = cargo_target_triple(target)
    if triple is None:
        result.add_skip(f"unsupported native extension Cargo target {target}")
        return []
    manifests = discover_extension_manifests(roots)
    if not manifests:
        result.add_skip("no extension-artifacts.json manifests found for native extension Cargo crates")
        return []
    if dry_run:
        result.staged.append(f"dry-run native extension Cargo crates for {target}")
        return []

    source_root = staging_root / "native-extension-sources"
    output_dir = staging_root / "native-extension-crates"
    cargo_target_dir = staging_root / "native-extension-cargo-target"
    shutil.rmtree(source_root, ignore_errors=True)
    shutil.rmtree(output_dir, ignore_errors=True)
    shutil.rmtree(cargo_target_dir, ignore_errors=True)
    source_root.mkdir(parents=True, exist_ok=True)
    output_dir.mkdir(parents=True, exist_ok=True)

    outputs: list[Path] = []
    for manifest_path in manifests:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        product = manifest.get("product")
        version = manifest.get("version")
        sql_name = manifest.get("sqlName")
        if not all(isinstance(value, str) and value for value in [product, version, sql_name]):
            result.add_skip(f"{rel(manifest_path)} is missing product, version, or sqlName")
            continue
        release_manifest = extension_release_manifest(manifest_path.parent, str(product), str(version))
        asset = extension_runtime_asset(manifest_path.parent, release_manifest or manifest, target)
        if asset is None:
            result.add_skip(f"{product}@{version} has no {target} native runtime asset")
            continue
        name = native_extension_cargo_package_name(str(product), target)
        crate_dir = source_root / name
        write_native_extension_cargo_crate(
            crate_dir,
            product=str(product),
            version=str(version),
            sql_name=str(sql_name),
            target=target,
            triple=triple,
            asset=asset,
        )
        crate_path = cargo_package(crate_dir, cargo_target_dir)
        size = crate_path.stat().st_size
        if size > CARGO_EXTENSION_SPLIT_THRESHOLD_BYTES:
            discard_cargo_package_artifact(crate_path)
            part_dirs = build_native_extension_part_crates(
                crate_dir / "payload",
                source_root,
                product=str(product),
                version=str(version),
                sql_name=str(sql_name),
                target=target,
            )
            write_native_extension_split_aggregator_crate(
                crate_dir,
                product=str(product),
                version=str(version),
                sql_name=str(sql_name),
                target=target,
                triple=triple,
                part_dirs=part_dirs,
            )
            part_failed = False
            for part_dir in part_dirs:
                part_crate_path = cargo_package(part_dir, cargo_target_dir)
                part_size = part_crate_path.stat().st_size
                if part_size > CARGO_PACKAGE_SIZE_LIMIT_BYTES:
                    message = (
                        f"{rel(part_crate_path)} is {part_size} bytes, above the crates.io "
                        "10 MiB package limit"
                    )
                    result.add_skip(message)
                    if strict:
                        raise RuntimeError(message)
                    part_failed = True
                    continue
                output = output_dir / part_crate_path.name
                shutil.copy2(part_crate_path, output)
                outputs.append(output)
            if part_failed:
                continue
            crate_path = manual_cargo_package_source(
                crate_dir / "Cargo.toml",
                cargo_target_dir / "manual-package",
            )
            size = crate_path.stat().st_size
            if size > CARGO_PACKAGE_SIZE_LIMIT_BYTES:
                message = (
                    f"{rel(crate_path)} is {size} bytes after splitting, above the crates.io "
                    "10 MiB package limit"
                )
                result.add_skip(message)
                if strict:
                    raise RuntimeError(message)
                continue
        output = output_dir / crate_path.name
        shutil.copy2(crate_path, output)
        outputs.append(output)
    result.staged.extend(rel(path) for path in outputs)
    return outputs


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


def cargo_index_dependency(dep: dict[str, Any], local_package_names: set[str]) -> dict[str, Any]:
    registry = dep.get("registry")
    if dep["name"] in local_package_names:
        registry = None
    elif registry is None:
        registry = CRATES_IO_INDEX
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


def cargo_index_entry(crate_path: Path, package: dict[str, Any], local_package_names: set[str]) -> dict[str, Any]:
    checksum = hashlib.sha256(crate_path.read_bytes()).hexdigest()
    return {
        "name": package["name"],
        "vers": package["version"],
        "deps": [
            cargo_index_dependency(dep, local_package_names)
            for dep in package.get("dependencies", [])
        ],
        "features": package.get("features", {}),
        "features2": None,
        "cksum": checksum,
        "yanked": False,
        "links": package.get("_oliphaunt_links"),
        "rust_version": package.get("rust_version"),
        "v": 2,
    }


def clear_local_cargo_home_cache(registry_root: Path) -> list[Path]:
    cargo_home_registry = registry_root / "cargo-home" / "registry"
    removed: list[Path] = []
    for name in ["cache", "src", "index"]:
        path = cargo_home_registry / name
        if path.exists():
            shutil.rmtree(path)
            removed.append(path)
    package_cache = cargo_home_registry / ".package-cache"
    if package_cache.exists():
        package_cache.unlink()
        removed.append(package_cache)
    return removed


def cargo_crate_priority(path: Path, registry_root: Path) -> tuple[int, str]:
    resolved = path.resolve()
    priority = 20
    for root, value in [
        (registry_root / "cargo-generated", 100),
        (ROOT / "target/oliphaunt-wasix/cargo-artifacts-check", 90),
        (ROOT / "target/local-registry-generated", 80),
        (ROOT / "target/oliphaunt-wasix/cargo-artifacts", 70),
        (ROOT / "target/package/tmp-registry", 40),
        (ROOT / "target/package/tmp-crate", 30),
    ]:
        try:
            resolved.relative_to(root.resolve())
        except ValueError:
            continue
        priority = value
        break
    return priority, str(path)


def stage_release_asset_cargo_packages(
    roots: list[Path],
    registry_root: Path,
    dry_run: bool,
    result: SurfaceResult,
) -> list[Path]:
    if dry_run:
        result.staged.append("dry-run generated release-asset Cargo artifact crates")
        return []

    sys.path.insert(0, str(ROOT / "tools" / "release"))
    import release  # type: ignore

    output_root = registry_root / "cargo-generated" / "release-asset-crates"
    shutil.rmtree(output_root, ignore_errors=True)
    output_root.mkdir(parents=True, exist_ok=True)
    generated_roots: list[Path] = []
    host_target = host_cargo_release_target()

    lib_version = release.current_product_version("liboliphaunt-native")
    lib_patterns = (f"liboliphaunt-{lib_version}-*", f"oliphaunt-tools-{lib_version}-*")
    lib_asset_dir = ROOT / "target" / "liboliphaunt" / "release-assets"
    copied_lib_assets = copy_release_assets(roots, lib_asset_dir, lib_patterns)
    lib_output_dir = output_root / "liboliphaunt-native"
    if host_target is None:
        result.add_skip("current host does not map to a supported native runtime Cargo target")
    elif copied_lib_assets or (
        release_asset_dir_selected(roots, lib_asset_dir)
        and release_asset_dir_has_files(lib_asset_dir, lib_patterns)
    ):
        if copied_lib_assets:
            result.staged.append(
                f"staged {len(copied_lib_assets)} liboliphaunt release asset(s) for Cargo"
            )
        run(
            [
                "python3",
                "tools/release/package_liboliphaunt_cargo_artifacts.py",
                "--version",
                lib_version,
                "--output-dir",
                str(lib_output_dir),
                "--target",
                host_target,
            ]
        )
        generated_roots.append(lib_output_dir)
    else:
        result.add_skip("no liboliphaunt release assets found for native Cargo artifact packages")

    broker_version = release.current_product_version("oliphaunt-broker")
    broker_patterns = ("oliphaunt-broker-*.tar.gz", "oliphaunt-broker-*.zip")
    broker_asset_dir = ROOT / "target" / "oliphaunt-broker" / "release-assets"
    copied_broker_assets = copy_release_assets(roots, broker_asset_dir, broker_patterns)
    broker_output_dir = output_root / "oliphaunt-broker"
    if host_target is None:
        result.add_skip("current host does not map to a supported broker Cargo target")
    elif copied_broker_assets or (
        release_asset_dir_selected(roots, broker_asset_dir)
        and release_asset_dir_has_files(broker_asset_dir, broker_patterns)
    ):
        if copied_broker_assets:
            result.staged.append(
                f"staged {len(copied_broker_assets)} broker release asset(s) for Cargo"
            )
        run(
            [
                str(ROOT / "tools/dev/bun.sh"),
                "tools/release/package_broker_cargo_artifacts.mjs",
                "--version",
                broker_version,
                "--output-dir",
                str(broker_output_dir),
                "--target",
                host_target,
            ]
        )
        generated_roots.append(broker_output_dir)
    else:
        result.add_skip("no broker release assets found for broker Cargo artifact packages")

    wasix_version = release.current_product_version("liboliphaunt-wasix")
    wasix_patterns = (f"liboliphaunt-wasix-{wasix_version}-*",)
    wasix_asset_dir = ROOT / "target" / "oliphaunt-wasix" / "release-assets"
    copied_wasix_assets = copy_release_assets(roots, wasix_asset_dir, wasix_patterns)
    wasix_output_dir = output_root / "liboliphaunt-wasix"
    if copied_wasix_assets or (
        release_asset_dir_selected(roots, wasix_asset_dir)
        and release_asset_dir_has_files(wasix_asset_dir, wasix_patterns)
    ):
        if copied_wasix_assets:
            result.staged.append(
                f"staged {len(copied_wasix_assets)} WASIX release asset(s) for Cargo"
            )
        run(
            [
                "python3",
                "tools/release/package_liboliphaunt_wasix_cargo_artifacts.py",
                "--version",
                wasix_version,
                "--output-dir",
                str(wasix_output_dir),
            ]
        )
        generated_roots.append(wasix_output_dir)
    else:
        result.add_skip("no WASIX release assets found for WASIX Cargo artifact packages")

    generated_crates = discover_files(generated_roots, (".crate",))
    if generated_crates:
        result.staged.append(f"generated {len(generated_crates)} release-asset Cargo crate(s)")
        return generated_roots
    return generated_roots


def publish_cargo(roots: list[Path], registry_root: Path, dry_run: bool, strict: bool) -> SurfaceResult:
    registry_root = registry_root.resolve()
    result = SurfaceResult("cargo")
    release_asset_roots = stage_release_asset_cargo_packages(roots, registry_root, dry_run, result)
    if release_asset_roots:
        roots = [*roots, *release_asset_roots]
    generated_roots = stage_cargo_source_crates(roots, registry_root, dry_run, result)
    generated_roots.extend(
        package_native_extension_cargo_crates(
            roots,
            registry_root / "cargo-generated",
            host_cargo_release_target(),
            dry_run,
            strict,
            result,
        )
    )
    if generated_roots:
        roots = [*roots, *generated_roots]
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

    packages_by_target_name: dict[str, tuple[Path, dict[str, Any]]] = {}
    for crate_path in sorted(crates, key=lambda path: cargo_crate_priority(path, registry_root)):
        try:
            package = cargo_metadata_for_crate(crate_path)
        except RuntimeError as error:
            result.add_skip(str(error))
            if strict:
                raise
            continue
        if package.get("name") in LEGACY_WASIX_ARTIFACT_CRATES:
            result.add_skip(f"ignored legacy WASIX artifact crate {crate_path.name}")
            continue
        target_name = f"{package['name']}-{package['version']}.crate"
        packages_by_target_name[target_name] = (crate_path, package)

    local_package_names = {
        str(package["name"])
        for _crate_path, package in packages_by_target_name.values()
        if isinstance(package.get("name"), str)
    }
    entries_by_path: dict[Path, list[dict[str, Any]]] = {}
    for target_name, (crate_path, package) in sorted(packages_by_target_name.items()):
        entry = cargo_index_entry(crate_path, package, local_package_names)
        shutil.copy2(crate_path, crates_dir / target_name)
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
    removed_cache_paths = clear_local_cargo_home_cache(registry_root)
    if removed_cache_paths:
        result.staged.extend(f"cleared {rel(path)}" for path in removed_cache_paths)
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
