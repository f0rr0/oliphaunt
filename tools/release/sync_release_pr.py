#!/usr/bin/env python3
"""Synchronize release-derived files after release-please updates a PR."""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import tomllib
from dataclasses import dataclass
from pathlib import Path
from typing import Any, NoReturn

import product_metadata


ROOT = Path(__file__).resolve().parents[2]
NODE_DIRECT_PRODUCT = "oliphaunt-node-direct"
NODE_DIRECT_OPTIONAL_PACKAGES = [
    "@oliphaunt/node-direct-darwin-arm64",
    "@oliphaunt/node-direct-linux-arm64-gnu",
    "@oliphaunt/node-direct-linux-x64-gnu",
    "@oliphaunt/node-direct-win32-x64-msvc",
]
DEPENDENCY_TABLES = ("dependencies", "dev-dependencies", "build-dependencies")
LOCKFILES = [
    ROOT / "Cargo.lock",
    ROOT / "src/bindings/wasix-rust/examples/tauri-sqlx-vanilla/src-tauri/Cargo.lock",
]
PNPM_LOCKFILE = ROOT / "pnpm-lock.yaml"
PACKAGE_START_RE = re.compile(r"^\s*\[\[package\]\]\s*$")
STRING_KEY_RE = re.compile(r'^\s*([A-Za-z0-9_-]+)\s*=\s*"([^"]*)"\s*(?:#.*)?$')
VERSION_LINE_RE = re.compile(r'^(\s*version\s*=\s*)"[^"]*"(\s*(?:#.*)?)$')


@dataclass(frozen=True)
class Change:
    path: Path
    detail: str


def fail(message: str) -> NoReturn:
    print(f"sync_release_pr.py: {message}", file=sys.stderr)
    raise SystemExit(2)


def rel(path: Path) -> str:
    return path.relative_to(ROOT).as_posix()


def read_json_object(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        fail(f"{rel(path)} must contain a JSON object")
    return value


def json_text(value: dict[str, Any]) -> str:
    return json.dumps(value, indent=2) + "\n"


def write_text_if_changed(path: Path, text: str, changes: list[Change], detail: str, *, write: bool) -> None:
    before = path.read_text(encoding="utf-8")
    if before == text:
        return
    changes.append(Change(path, detail))
    if write:
        path.write_text(text, encoding="utf-8")


def set_json_path(data: dict[str, Any], dotted: str, expected: str, context: str) -> str | None:
    current: Any = data
    parts = dotted.split(".")
    for part in parts[:-1]:
        if not isinstance(current, dict) or not isinstance(current.get(part), dict):
            fail(f"{context} is missing object path {'.'.join(parts[:-1])}")
        current = current[part]
    if not isinstance(current, dict):
        fail(f"{context} is missing object path {'.'.join(parts[:-1])}")
    key = parts[-1]
    actual = current.get(key)
    if actual == expected:
        return None
    current[key] = expected
    return f"{context} {actual!r} -> {expected!r}"


def sync_compatibility_versions(changes: list[Change], *, write: bool) -> None:
    for spec_id, (source_product, path_text, parser) in sorted(product_metadata.compatibility_version_links().items()):
        path = ROOT / path_text
        expected = product_metadata.read_current_version(source_product)
        if parser == "raw":
            write_text_if_changed(
                path,
                expected + "\n",
                changes,
                f"{spec_id} -> {source_product} {expected}",
                write=write,
            )
            continue
        if parser.startswith("json:"):
            data = read_json_object(path)
            detail = set_json_path(data, parser.split(":", 1)[1], expected, spec_id)
            if detail is not None:
                write_text_if_changed(path, json_text(data), changes, detail, write=write)
            continue
        fail(f"{spec_id} uses unsupported sync parser {parser!r}")


def sync_node_direct_optional_dependencies(changes: list[Change], *, write: bool) -> None:
    path = ROOT / "src/sdks/js/package.json"
    data = read_json_object(path)
    optional = data.get("optionalDependencies")
    if not isinstance(optional, dict):
        fail(f"{rel(path)} must declare optionalDependencies")
    expected_keys = set(NODE_DIRECT_OPTIONAL_PACKAGES)
    actual_keys = set(optional)
    if actual_keys != expected_keys:
        fail(
            f"{rel(path)} optionalDependencies must be exactly "
            f"{', '.join(NODE_DIRECT_OPTIONAL_PACKAGES)}"
        )

    expected_version = f"workspace:{product_metadata.read_current_version(NODE_DIRECT_PRODUCT)}"
    changed = False
    details = []
    for package_name in NODE_DIRECT_OPTIONAL_PACKAGES:
        actual = optional.get(package_name)
        if actual != expected_version:
            optional[package_name] = expected_version
            changed = True
            details.append(f"{package_name} {actual!r} -> {expected_version!r}")
    if changed:
        write_text_if_changed(path, json_text(data), changes, "; ".join(details), write=write)


def cargo_manifest_name_version(path: Path) -> tuple[str, str]:
    data = tomllib.loads(path.read_text(encoding="utf-8"))
    package = data.get("package")
    if not isinstance(package, dict):
        fail(f"{rel(path)} is missing [package]")
    name = package.get("name")
    version = package.get("version")
    if not isinstance(name, str) or not name:
        fail(f"{rel(path)} is missing package.name")
    if not isinstance(version, str) or not version:
        fail(f"{rel(path)} is missing package.version")
    return name, version


def cargo_manifest_paths() -> list[Path]:
    ignored_roots = {".git", "target", "node_modules"}
    return sorted(
        path
        for path in ROOT.rglob("Cargo.toml")
        if not any(part in ignored_roots for part in path.relative_to(ROOT).parts)
    )


def package_json_paths() -> list[Path]:
    ignored_roots = {".git", "target", "node_modules"}
    return sorted(
        path
        for path in ROOT.rglob("package.json")
        if not any(part in ignored_roots for part in path.relative_to(ROOT).parts)
    )


def local_cargo_packages_by_manifest() -> dict[Path, tuple[str, str]]:
    packages = {}
    for manifest in cargo_manifest_paths():
        data = tomllib.loads(manifest.read_text(encoding="utf-8"))
        package = data.get("package")
        if not isinstance(package, dict):
            continue
        name = package.get("name")
        version = package.get("version")
        if not isinstance(name, str) or not isinstance(version, str):
            continue
        packages[manifest.resolve()] = (name, version)
    return packages


def local_cargo_package_versions() -> dict[str, str]:
    versions: dict[str, str] = {}
    for manifest, (name, version) in local_cargo_packages_by_manifest().items():
        existing = versions.get(name)
        if existing is not None and existing != version:
            fail(f"local Cargo package {name} has conflicting versions including {rel(manifest)}")
        versions[name] = version
    return versions


def strip_newline(line: str) -> tuple[str, str]:
    if line.endswith("\r\n"):
        return line[:-2], "\r\n"
    if line.endswith("\n"):
        return line[:-1], "\n"
    return line, ""


def iter_dependency_tables(manifest: dict[str, Any]) -> list[dict[str, Any]]:
    tables = []
    for table_name in DEPENDENCY_TABLES:
        table = manifest.get(table_name)
        if isinstance(table, dict):
            tables.append(table)
    targets = manifest.get("target")
    if isinstance(targets, dict):
        for target in targets.values():
            if not isinstance(target, dict):
                continue
            for table_name in DEPENDENCY_TABLES:
                table = target.get(table_name)
                if isinstance(table, dict):
                    tables.append(table)
    return tables


def desired_cargo_path_dependency_versions(
    manifest_path: Path,
    local_packages: dict[Path, tuple[str, str]],
) -> dict[str, str]:
    manifest = tomllib.loads(manifest_path.read_text(encoding="utf-8"))
    desired: dict[str, str] = {}
    for table in iter_dependency_tables(manifest):
        for dependency_name, dependency in table.items():
            if not isinstance(dependency, dict):
                continue
            path_value = dependency.get("path")
            version_value = dependency.get("version")
            if not isinstance(path_value, str) or not isinstance(version_value, str):
                continue
            dependency_manifest = (manifest_path.parent / path_value / "Cargo.toml").resolve()
            package = local_packages.get(dependency_manifest)
            if package is None:
                continue
            _, package_version = package
            desired[dependency_name] = f"={package_version}" if version_value.startswith("=") else package_version
    return desired


def sync_cargo_path_dependency_pins(changes: list[Change], *, write: bool) -> None:
    local_packages = local_cargo_packages_by_manifest()
    for manifest_path in cargo_manifest_paths():
        desired = desired_cargo_path_dependency_versions(manifest_path, local_packages)
        if not desired:
            continue
        lines = manifest_path.read_text(encoding="utf-8").splitlines(keepends=True)
        seen: set[str] = set()
        file_changes: list[str] = []

        for index, line in enumerate(lines):
            body, newline = strip_newline(line)
            for dependency_name, expected in desired.items():
                pattern = re.compile(
                    rf'^(\s*{re.escape(dependency_name)}\s*=\s*\{{[^}}]*\bversion\s*=\s*")([^"]+)(".*)$'
                )
                match = pattern.match(body)
                if match is None:
                    continue
                seen.add(dependency_name)
                actual = match.group(2)
                if actual != expected:
                    lines[index] = f"{match.group(1)}{expected}{match.group(3)}{newline}"
                    file_changes.append(f"{dependency_name} {actual!r} -> {expected!r}")

        missing = sorted(set(desired) - seen)
        if missing:
            fail(f"{rel(manifest_path)} has non-inline local path dependency pins: {', '.join(missing)}")
        if file_changes:
            write_text_if_changed(
                manifest_path,
                "".join(lines),
                changes,
                "; ".join(file_changes),
                write=write,
            )


def string_key(line: str, key: str) -> str | None:
    body, _ = strip_newline(line)
    match = STRING_KEY_RE.match(body)
    if match and match.group(1) == key:
        return match.group(2)
    return None


def package_block_ranges(lines: list[str]) -> list[tuple[int, int]]:
    starts = [idx for idx, line in enumerate(lines) if PACKAGE_START_RE.match(line)]
    return [
        (start, starts[pos + 1] if pos + 1 < len(starts) else len(lines))
        for pos, start in enumerate(starts)
    ]


def replace_version_line(line: str, version: str) -> str:
    body, newline = strip_newline(line)
    match = VERSION_LINE_RE.match(body)
    if not match:
        fail(f"cannot update Cargo.lock version line: {line.rstrip()}")
    return f'{match.group(1)}"{version}"{match.group(2)}{newline}'


def sync_lockfile(lockfile: Path, versions: dict[str, str], changes: list[Change], *, write: bool) -> None:
    data = tomllib.loads(lockfile.read_text(encoding="utf-8"))
    packages = data.get("package")
    if not isinstance(packages, list):
        fail(f"{rel(lockfile)} is missing [[package]] entries")
    lines = lockfile.read_text(encoding="utf-8").splitlines(keepends=True)
    file_changes: list[str] = []

    for start, end in package_block_ranges(lines):
        block = lines[start:end]
        name = None
        version_idx = None
        current_version = None
        has_source = False

        for offset, line in enumerate(block):
            if string_key(line, "source") is not None:
                has_source = True
            key_name = string_key(line, "name")
            if key_name is not None:
                name = key_name
            key_version = string_key(line, "version")
            if key_version is not None:
                version_idx = start + offset
                current_version = key_version

        if name not in versions or has_source:
            continue
        if version_idx is None or current_version is None:
            fail(f"{rel(lockfile)} package {name} is missing version")

        expected_version = versions[name]
        if current_version != expected_version:
            lines[version_idx] = replace_version_line(lines[version_idx], expected_version)
            file_changes.append(f"{name} {current_version} -> {expected_version}")

    if file_changes:
        write_text_if_changed(lockfile, "".join(lines), changes, "; ".join(file_changes), write=write)


def sync_lockfiles(changes: list[Change], *, write: bool) -> None:
    versions = local_cargo_package_versions()
    for lockfile in LOCKFILES:
        sync_lockfile(lockfile, versions, changes, write=write)


def sync_pnpm_lockfile(changes: list[Change], *, write: bool) -> None:
    lockfile_before = PNPM_LOCKFILE.read_text(encoding="utf-8")
    manifests_before = {path: path.read_text(encoding="utf-8") for path in package_json_paths()}
    command = [
        "pnpm",
        "install",
        "--lockfile-only",
        "--no-frozen-lockfile",
        "--ignore-scripts",
    ]

    try:
        result = subprocess.run(command, cwd=ROOT, text=True, capture_output=True, check=False)
    except FileNotFoundError:
        fail("pnpm is required to sync pnpm-lock.yaml")

    if result.returncode != 0:
        PNPM_LOCKFILE.write_text(lockfile_before, encoding="utf-8")
        for path, before in manifests_before.items():
            if path.exists():
                path.write_text(before, encoding="utf-8")
        sys.stderr.write(result.stdout)
        sys.stderr.write(result.stderr)
        fail("pnpm install --lockfile-only failed while syncing pnpm-lock.yaml")

    manifest_changes = [
        rel(path)
        for path, before in manifests_before.items()
        if path.read_text(encoding="utf-8") != before
    ]
    if manifest_changes:
        PNPM_LOCKFILE.write_text(lockfile_before, encoding="utf-8")
        for path, before in manifests_before.items():
            if path.exists():
                path.write_text(before, encoding="utf-8")
        fail(
            "pnpm install --lockfile-only unexpectedly changed package manifests: "
            + ", ".join(manifest_changes)
        )

    lockfile_after = PNPM_LOCKFILE.read_text(encoding="utf-8")
    if lockfile_after == lockfile_before:
        return
    changes.append(Change(PNPM_LOCKFILE, "pnpm workspace lockfile"))
    if not write:
        PNPM_LOCKFILE.write_text(lockfile_before, encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="fail instead of writing updates")
    args = parser.parse_args()

    changes: list[Change] = []
    write = not args.check
    sync_compatibility_versions(changes, write=write)
    sync_node_direct_optional_dependencies(changes, write=write)
    sync_cargo_path_dependency_pins(changes, write=write)
    sync_lockfiles(changes, write=write)
    sync_pnpm_lockfile(changes, write=write)

    if not changes:
        print("release PR derived files are in sync")
        return 0

    for change in changes:
        print(f"{rel(change.path)}: {change.detail}", file=sys.stderr)
    if args.check:
        print("release PR derived files are stale; run `tools/release/sync_release_pr.py`", file=sys.stderr)
        return 1
    print("updated release PR derived files")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
