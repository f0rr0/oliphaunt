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

import extension_artifact_targets
import product_metadata


ROOT = Path(__file__).resolve().parents[2]
TYPESCRIPT_OPTIONAL_RUNTIME_PACKAGES_BY_PRODUCT = {
    "oliphaunt-broker": [
        "@oliphaunt/broker-darwin-arm64",
        "@oliphaunt/broker-linux-arm64-gnu",
        "@oliphaunt/broker-linux-x64-gnu",
        "@oliphaunt/broker-win32-x64-msvc",
    ],
    "liboliphaunt-native": [
        "@oliphaunt/liboliphaunt-darwin-arm64",
        "@oliphaunt/liboliphaunt-linux-arm64-gnu",
        "@oliphaunt/liboliphaunt-linux-x64-gnu",
        "@oliphaunt/liboliphaunt-win32-x64-msvc",
        "@oliphaunt/tools-darwin-arm64",
        "@oliphaunt/tools-linux-arm64-gnu",
        "@oliphaunt/tools-linux-x64-gnu",
        "@oliphaunt/tools-win32-x64-msvc",
    ],
    "oliphaunt-node-direct": [
        "@oliphaunt/node-direct-darwin-arm64",
        "@oliphaunt/node-direct-linux-arm64-gnu",
        "@oliphaunt/node-direct-linux-x64-gnu",
        "@oliphaunt/node-direct-win32-x64-msvc",
    ],
}
TYPESCRIPT_OPTIONAL_RUNTIME_PACKAGES = [
    package_name
    for packages in TYPESCRIPT_OPTIONAL_RUNTIME_PACKAGES_BY_PRODUCT.values()
    for package_name in packages
]
TYPESCRIPT_OPTIONAL_RUNTIME_PACKAGE_TO_PRODUCT = {
    package_name: product
    for product, packages in TYPESCRIPT_OPTIONAL_RUNTIME_PACKAGES_BY_PRODUCT.items()
    for package_name in packages
}
DEPENDENCY_TABLES = ("dependencies", "dev-dependencies", "build-dependencies")
LOCKFILES = [
    ROOT / "Cargo.lock",
    ROOT / "src/bindings/wasix-rust/examples/tauri-sqlx-vanilla/src-tauri/Cargo.lock",
]
PNPM_LOCKFILE = ROOT / "pnpm-lock.yaml"
PACKAGE_START_RE = re.compile(r"^\s*\[\[package\]\]\s*$")
STRING_KEY_RE = re.compile(r'^\s*([A-Za-z0-9_-]+)\s*=\s*"([^"]*)"\s*(?:#.*)?$')
VERSION_LINE_RE = re.compile(r'^(\s*version\s*=\s*)"[^"]*"(\s*(?:#.*)?)$')
TOML_TABLE_RE = re.compile(r"^\s*\[([A-Za-z0-9_.-]+)\]\s*(?:#.*)?$")
PNPM_TYPESCRIPT_OPTIONAL_RUNTIME_KEY_RE = re.compile(
    r"^(\s*)'(@oliphaunt/(?:broker|liboliphaunt|node-direct|tools)-[^']+)':\s*$"
)
PNPM_SPECIFIER_RE = re.compile(r"^(\s*specifier:\s*)(\S+)(\s*)$")
ASSET_INPUT_FINGERPRINT_PATH = ROOT / "src/runtimes/liboliphaunt/wasix/assets/generated/asset-inputs.sha256"
ASSET_INPUT_FINGERPRINT_MISMATCH_RE = re.compile(
    r"committed asset input fingerprint must be '([0-9a-f]+)', got '([0-9a-f]+)'"
)
EXTENSION_EVIDENCE_PATHS = [
    ROOT / "src/extensions/evidence/matrix.toml",
    ROOT / "src/extensions/evidence/runs/2026-06-07-transitional-catalog-smoke.json",
    ROOT / "src/extensions/generated/docs/extension-evidence.json",
]
EXTENSION_EVIDENCE_STALE_RE = re.compile(
    r"([^:\n]+\.json) sourceDigest is stale; expected (sha256:[0-9a-f]{64}), got '([^']*)'"
)


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


def set_toml_string_path(path: Path, dotted: str, expected: str, context: str) -> tuple[str | None, str | None]:
    parts = dotted.split(".")
    if len(parts) < 2:
        fail(f"{context} TOML parser must use table.key dotted syntax")
    table = parts[:-1]
    key = parts[-1]
    lines = path.read_text(encoding="utf-8").splitlines(keepends=True)
    current_table: list[str] = []
    saw_table = False
    key_pattern = re.compile(rf'^(\s*{re.escape(key)}\s*=\s*)"([^"]*)"(.*)$')

    for index, line in enumerate(lines):
        body, newline = strip_newline(line)
        table_match = TOML_TABLE_RE.match(body)
        if table_match:
            current_table = table_match.group(1).split(".")
            saw_table = current_table == table
            continue
        if current_table != table:
            continue
        key_match = key_pattern.match(body)
        if key_match is None:
            continue
        actual = key_match.group(2)
        if actual == expected:
            return None, None
        lines[index] = f'{key_match.group(1)}"{expected}"{key_match.group(3)}{newline}'
        return "".join(lines), f"{context} {actual!r} -> {expected!r}"

    if saw_table:
        fail(f"{context} did not find TOML key {key!r} in {rel(path)}")
    fail(f"{context} did not find TOML table {'.'.join(table)!r} in {rel(path)}")


def set_rust_const_string(path: Path, const_name: str, expected: str, context: str) -> tuple[str | None, str | None]:
    lines = path.read_text(encoding="utf-8").splitlines(keepends=True)
    pattern = re.compile(rf'^(\s*(?:pub\s+)?const\s+{re.escape(const_name)}\s*:\s*&str\s*=\s*)"([^"]*)"(;.*)$')
    for index, line in enumerate(lines):
        body, newline = strip_newline(line)
        match = pattern.match(body)
        if match is None:
            continue
        actual = match.group(2)
        if actual == expected:
            return None, None
        lines[index] = f'{match.group(1)}"{expected}"{match.group(3)}{newline}'
        return "".join(lines), f"{context} {actual!r} -> {expected!r}"
    fail(f"{context} did not find Rust const {const_name!r} in {rel(path)}")


def toml_array_assignment(key: str, values: list[str]) -> str:
    if len(values) == 1:
        return f'{key} = [{json.dumps(values[0])}]\n'
    lines = [f"{key} = [\n"]
    lines.extend(f"  {json.dumps(value)},\n" for value in values)
    lines.append("]\n")
    return "".join(lines)


def replace_top_level_array_assignment(text: str, key: str, values: list[str], context: str) -> str:
    lines = text.splitlines(keepends=True)
    output: list[str] = []
    index = 0
    replaced = False
    pattern = re.compile(rf"^{re.escape(key)}\s*=\s*\[")
    while index < len(lines):
        line = lines[index]
        if not replaced and pattern.match(line):
            replacement = toml_array_assignment(key, values)
            output.append(replacement)
            replaced = True
            if "]" not in line:
                index += 1
                while index < len(lines) and "]" not in lines[index]:
                    index += 1
            index += 1
            continue
        output.append(line)
        index += 1
    if not replaced:
        fail(f"{context} did not find top-level TOML array {key!r}")
    return "".join(output)


def sync_extension_maven_registry_metadata(changes: list[Change], *, write: bool) -> None:
    expected_publish_targets = ["github-release-assets", "maven-central"]
    for product in product_metadata.extension_product_ids():
        path = ROOT / product_metadata.package_path(product) / "release.toml"
        expected_registry_packages = [
            f"maven:dev.oliphaunt.extensions:{product}-{target.target}"
            for target in extension_artifact_targets.published_android_maven_targets(product)
        ]
        text = path.read_text(encoding="utf-8")
        updated = replace_top_level_array_assignment(
            text,
            "publish_targets",
            expected_publish_targets,
            product,
        )
        updated = replace_top_level_array_assignment(
            updated,
            "registry_packages",
            expected_registry_packages,
            product,
        )
        if updated != text:
            write_text_if_changed(
                path,
                updated,
                changes,
                "synced explicit Maven registry metadata",
                write=write,
            )


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
        if parser.startswith("toml:"):
            text, detail = set_toml_string_path(path, parser.split(":", 1)[1], expected, spec_id)
            if text is not None and detail is not None:
                write_text_if_changed(path, text, changes, detail, write=write)
            continue
        if parser.startswith("rust-const:"):
            text, detail = set_rust_const_string(path, parser.split(":", 1)[1], expected, spec_id)
            if text is not None and detail is not None:
                write_text_if_changed(path, text, changes, detail, write=write)
            continue
        fail(f"{spec_id} uses unsupported sync parser {parser!r}")


def expected_typescript_optional_runtime_versions() -> dict[str, str]:
    return {
        package_name: f"workspace:{product_metadata.read_current_version(product)}"
        for package_name, product in TYPESCRIPT_OPTIONAL_RUNTIME_PACKAGE_TO_PRODUCT.items()
    }


def sync_typescript_optional_runtime_dependencies(changes: list[Change], *, write: bool) -> None:
    path = ROOT / "src/sdks/js/package.json"
    data = read_json_object(path)
    optional = data.get("optionalDependencies")
    if not isinstance(optional, dict):
        fail(f"{rel(path)} must declare optionalDependencies")
    expected_keys = set(TYPESCRIPT_OPTIONAL_RUNTIME_PACKAGES)
    actual_keys = set(optional)
    if actual_keys != expected_keys:
        fail(
            f"{rel(path)} optionalDependencies must be exactly "
            f"{', '.join(TYPESCRIPT_OPTIONAL_RUNTIME_PACKAGES)}"
        )

    expected_versions = expected_typescript_optional_runtime_versions()
    changed = False
    details = []
    for package_name in TYPESCRIPT_OPTIONAL_RUNTIME_PACKAGES:
        expected_version = expected_versions[package_name]
        actual = optional.get(package_name)
        if actual != expected_version:
            optional[package_name] = expected_version
            changed = True
            details.append(f"{package_name} {actual!r} -> {expected_version!r}")
    if changed:
        write_text_if_changed(path, json_text(data), changes, "; ".join(details), write=write)


def sync_pnpm_typescript_optional_runtime_specifiers(changes: list[Change], *, write: bool) -> None:
    expected_versions = expected_typescript_optional_runtime_versions()
    lines = PNPM_LOCKFILE.read_text(encoding="utf-8").splitlines(keepends=True)
    expected_packages = set(TYPESCRIPT_OPTIONAL_RUNTIME_PACKAGES)
    seen: set[str] = set()
    file_changes: list[str] = []

    for index, line in enumerate(lines):
        body, _ = strip_newline(line)
        package_match = PNPM_TYPESCRIPT_OPTIONAL_RUNTIME_KEY_RE.match(body)
        if package_match is None:
            continue
        package_name = package_match.group(2)
        if package_name not in expected_packages:
            fail(f"{rel(PNPM_LOCKFILE)} contains unexpected TypeScript optional runtime package {package_name}")
        seen.add(package_name)
        package_indent = len(package_match.group(1))
        expected_version = expected_versions[package_name]

        for specifier_index in range(index + 1, len(lines)):
            specifier_body, specifier_newline = strip_newline(lines[specifier_index])
            if specifier_body.strip():
                specifier_indent = len(specifier_body) - len(specifier_body.lstrip(" "))
                if specifier_indent <= package_indent:
                    break
            specifier_match = PNPM_SPECIFIER_RE.match(specifier_body)
            if specifier_match is None:
                continue
            actual = specifier_match.group(2)
            if actual != expected_version:
                lines[specifier_index] = (
                    f"{specifier_match.group(1)}{expected_version}"
                    f"{specifier_match.group(3)}{specifier_newline}"
                )
                file_changes.append(f"{package_name} {actual!r} -> {expected_version!r}")
            break
        else:
            fail(f"{rel(PNPM_LOCKFILE)} is missing a specifier for {package_name}")

    missing = expected_packages - seen
    if missing:
        fail(
            f"{rel(PNPM_LOCKFILE)} is missing TypeScript optional runtime package specifiers: "
            f"{', '.join(sorted(missing))}"
        )
    if file_changes:
        write_text_if_changed(PNPM_LOCKFILE, "".join(lines), changes, "; ".join(file_changes), write=write)


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


def read_optional_text(path: Path) -> str | None:
    if not path.exists():
        return None
    return path.read_text(encoding="utf-8")


def command_output_for_error(result: subprocess.CompletedProcess[str]) -> str:
    parts = [part.strip() for part in (result.stdout, result.stderr) if part.strip()]
    return "\n".join(parts) or f"exit {result.returncode}"


def sync_asset_input_fingerprint(changes: list[Change], *, write: bool) -> None:
    command = ["cargo", "run", "-p", "xtask", "--", "assets", "input-fingerprint"]
    if write:
        command.append("--write")

    before = read_optional_text(ASSET_INPUT_FINGERPRINT_PATH)
    result = subprocess.run(command, cwd=ROOT, text=True, capture_output=True, check=False)
    output = command_output_for_error(result)

    if result.returncode != 0:
        mismatch = ASSET_INPUT_FINGERPRINT_MISMATCH_RE.search(output)
        if not write and mismatch is not None:
            changes.append(
                Change(
                    ASSET_INPUT_FINGERPRINT_PATH,
                    f"{mismatch.group(1)} -> {mismatch.group(2)}",
                )
            )
            return
        fail(f"`{' '.join(command)}` failed:\n{output}")

    if not write:
        return

    after = read_optional_text(ASSET_INPUT_FINGERPRINT_PATH)
    if before != after:
        old = before.strip() if before is not None else "<missing>"
        new = after.strip() if after is not None else "<missing>"
        changes.append(Change(ASSET_INPUT_FINGERPRINT_PATH, f"{old} -> {new}"))


def sync_extension_evidence(changes: list[Change], *, write: bool) -> None:
    command = ["python3", "src/extensions/tools/check-extension-model.py"]
    command.append("--write-evidence" if write else "--check")
    before = {path: read_optional_text(path) for path in EXTENSION_EVIDENCE_PATHS}
    result = subprocess.run(command, cwd=ROOT, text=True, capture_output=True, check=False)
    output = command_output_for_error(result)

    if result.returncode != 0:
        stale = EXTENSION_EVIDENCE_STALE_RE.findall(output)
        if not write and stale:
            for path_text, expected, actual in stale:
                changes.append(Change(ROOT / path_text, f"{actual} -> {expected}"))
            return
        fail(f"`{' '.join(command)}` failed:\n{output}")

    if not write:
        return

    for path in EXTENSION_EVIDENCE_PATHS:
        if before[path] != read_optional_text(path):
            changes.append(Change(path, "regenerated extension evidence"))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="fail instead of writing updates")
    args = parser.parse_args()

    changes: list[Change] = []
    write = not args.check
    sync_compatibility_versions(changes, write=write)
    sync_extension_maven_registry_metadata(changes, write=write)
    sync_typescript_optional_runtime_dependencies(changes, write=write)
    sync_pnpm_typescript_optional_runtime_specifiers(changes, write=write)
    sync_cargo_path_dependency_pins(changes, write=write)
    sync_lockfiles(changes, write=write)
    sync_asset_input_fingerprint(changes, write=write)
    sync_extension_evidence(changes, write=write)

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
