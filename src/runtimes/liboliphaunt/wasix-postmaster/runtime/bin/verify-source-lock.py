#!/usr/bin/env python3
"""Reconcile every wasix-postmaster source and runtime-patch trust input."""

from __future__ import annotations

import argparse
import hashlib
import re
import sys
import tomllib
from pathlib import Path
from typing import Any


class VerificationError(RuntimeError):
    pass


COMMON_KEYS = {
    "POSTGRES_TAG",
    "POSTGRES_VERSION",
    "FRESH_WASMER_VERSION",
    "FRESH_WASMER_WASIX_VERSION",
    "FRESH_WASMER_SOURCE_COMMIT",
    "FRESH_WASMER_NAPI_COMMIT",
    "FRESH_WASMER_TEST_FILES_COMMIT",
    "FRESH_WASMER_SPEC_COMMIT",
    "FRESH_WASIX_LIBC_SOURCE_COMMIT",
}

SOURCE_MANIFESTS = {
    "wasmer": {
        "path": "src/sources/third-party/wasix-postmaster/wasmer.toml",
        "name": "wasmer-postmaster",
        "commit_key": "commit",
        "remote_key": "remote",
        "branch_key": "tag",
    },
    "wasmer_napi": {
        "path": "src/sources/third-party/wasix-postmaster/wasmer-napi.toml",
        "name": "wasmer-postmaster-napi",
        "commit_key": "napi_commit",
        "remote_key": "napi_remote",
        "branch": "main",
    },
    "wasmer_test_files": {
        "path": "src/sources/third-party/wasix-postmaster/wasmer-test-files.toml",
        "name": "wasmer-postmaster-test-files",
        "commit_key": "test_files_commit",
        "remote_key": "test_files_remote",
        "branch": "main",
    },
    "wasmer_spec": {
        "path": "src/sources/third-party/wasix-postmaster/webassembly-testsuite.toml",
        "name": "wasmer-postmaster-webassembly-testsuite",
        "commit_key": "webassembly_testsuite_commit",
        "remote_key": "webassembly_testsuite_remote",
        "branch": "main",
    },
}


def load_toml(path: Path) -> dict[str, Any]:
    try:
        with path.open("rb") as handle:
            return tomllib.load(handle)
    except (OSError, tomllib.TOMLDecodeError) as error:
        raise VerificationError(f"cannot read TOML {path}: {error}") from error


def require_equal(label: str, actual: Any, expected: Any) -> None:
    if actual != expected:
        raise VerificationError(f"{label}: expected {expected!r}, got {actual!r}")


def require_table(table: dict[str, Any], key: str, source: str) -> dict[str, Any]:
    value = table.get(key)
    if not isinstance(value, dict):
        raise VerificationError(f"{source} must define table [{key}]")
    return value


def parse_common_constants(path: Path) -> dict[str, str]:
    assignment = re.compile(
        r'^export\s+([A-Z0-9_]+)="\$\{\1:-([^"}]*)\}"\s*$'
    )
    constants: dict[str, str] = {}
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError as error:
        raise VerificationError(f"cannot read {path}: {error}") from error
    for line in lines:
        match = assignment.match(line)
        if match and match.group(1) in COMMON_KEYS:
            constants[match.group(1)] = match.group(2)
    missing = sorted(COMMON_KEYS - constants.keys())
    if missing:
        raise VerificationError(
            f"{path} lacks canonical default assignments for: {', '.join(missing)}"
        )
    return constants


def regular_project_file(project_root: Path, relative: str, label: str) -> Path:
    candidate = Path(relative)
    if candidate.is_absolute() or ".." in candidate.parts or "." in candidate.parts:
        raise VerificationError(f"{label} has unsafe relative path: {relative!r}")
    path = project_root / candidate
    if path.is_symlink() or not path.is_file():
        raise VerificationError(f"{label} must be a regular non-symlink file: {path}")
    return path


def verify_patch(
    project_root: Path,
    record: dict[str, Any],
    *,
    label: str,
    expected_path: str,
    expected_base: str,
) -> None:
    require_equal(f"{label}.path", record.get("path"), expected_path)
    require_equal(f"{label}.base_commit", record.get("base_commit"), expected_base)
    path = regular_project_file(project_root, expected_path, label)
    contents = path.read_bytes()
    require_equal(f"{label}.bytes", record.get("bytes"), len(contents))
    require_equal(
        f"{label}.sha256", record.get("sha256"), hashlib.sha256(contents).hexdigest()
    )


def verify_postgresql_product_inputs(
    project_root: Path, record: dict[str, Any]
) -> None:
    label = "current_postgresql_product_inputs"
    files = record.get("file")
    if not isinstance(files, list) or not all(isinstance(item, dict) for item in files):
        raise VerificationError(f"{label}.file must be an array of tables")
    series_path = regular_project_file(
        project_root, "postgres/patches/series", f"{label}.series"
    )
    expected_paths = {
        "postgres/patches/series",
        "postgres/product-patch-provenance.toml",
        *{
            f"postgres/patches/{line}"
            for line in series_path.read_text(encoding="utf-8").splitlines()
            if line and not line.startswith("#")
        },
    }
    actual_paths = [item.get("path") for item in files]
    if len(actual_paths) != len(set(actual_paths)):
        raise VerificationError(f"{label}.file contains duplicate paths")
    require_equal(f"{label}.paths", set(actual_paths), expected_paths)
    for index, item in enumerate(files):
        item_label = f"{label}.file[{index}]"
        relative = item.get("path")
        if not isinstance(relative, str):
            raise VerificationError(f"{item_label}.path must be a string")
        contents = regular_project_file(project_root, relative, item_label).read_bytes()
        require_equal(f"{item_label}.bytes", item.get("bytes"), len(contents))
        require_equal(
            f"{item_label}.sha256",
            item.get("sha256"),
            hashlib.sha256(contents).hexdigest(),
        )


def verify_postgresql_packed_latch_patch(
    project_root: Path, record: dict[str, Any], *, postgres_tag: str
) -> None:
    label = "current_postgresql_patches.packed_atomic_latch_state"
    expected_path = "postgres/patches/0008-wasix-packed-atomic-latch-state.patch"
    require_equal(f"{label}.path", record.get("path"), expected_path)
    require_equal(f"{label}.base_tag", record.get("base_tag"), postgres_tag)
    require_equal(
        f"{label}.feature_macro",
        record.get("feature_macro"),
        "PG_WASIX_ATOMIC_LATCH_STATE",
    )
    require_equal(
        f"{label}.native_behavior_preserved",
        record.get("native_behavior_preserved"),
        True,
    )
    path = regular_project_file(project_root, expected_path, label)
    contents = path.read_bytes()
    require_equal(f"{label}.bytes", record.get("bytes"), len(contents))
    require_equal(
        f"{label}.sha256", record.get("sha256"), hashlib.sha256(contents).hexdigest()
    )


def verify(project_root: Path, repo_root: Path) -> None:
    project_root = project_root.resolve()
    repo_root = repo_root.resolve()
    lock_path = project_root / "sources.lock.toml"
    lock = load_toml(lock_path)
    common = parse_common_constants(project_root / "lib/common.sh")

    postgres = require_table(lock, "postgresql", str(lock_path))
    postgres_source_path = repo_root / "src/postgres/versions/18/source.toml"
    postgres_source = require_table(
        load_toml(postgres_source_path), "postgresql", str(postgres_source_path)
    )
    require_equal("PostgreSQL version vs source manifest", postgres.get("version"), postgres_source.get("version"))
    require_equal("PostgreSQL archive digest vs source manifest", postgres.get("archive_sha256"), postgres_source.get("sha256"))
    require_equal("PostgreSQL version vs common.sh", postgres.get("version"), common["POSTGRES_VERSION"])
    require_equal("PostgreSQL tag vs common.sh", postgres.get("tag"), common["POSTGRES_TAG"])

    postgresql_patches = require_table(
        lock, "current_postgresql_patches", str(lock_path)
    )
    verify_postgresql_product_inputs(
        project_root,
        require_table(lock, "current_postgresql_product_inputs", str(lock_path)),
    )
    verify_postgresql_packed_latch_patch(
        project_root,
        require_table(
            postgresql_patches, "packed_atomic_latch_state", str(lock_path)
        ),
        postgres_tag=postgres["tag"],
    )
    wasmer = require_table(lock, "wasmer", str(lock_path))
    require_equal("Wasmer version vs common.sh", wasmer.get("version"), common["FRESH_WASMER_VERSION"])
    require_equal("wasmer-wasix version vs common.sh", wasmer.get("wasix_version"), common["FRESH_WASMER_WASIX_VERSION"])
    common_commit_keys = {
        "commit": "FRESH_WASMER_SOURCE_COMMIT",
        "napi_commit": "FRESH_WASMER_NAPI_COMMIT",
        "test_files_commit": "FRESH_WASMER_TEST_FILES_COMMIT",
        "webassembly_testsuite_commit": "FRESH_WASMER_SPEC_COMMIT",
    }
    for lock_key, common_key in common_commit_keys.items():
        require_equal(f"wasmer.{lock_key} vs common.sh", wasmer.get(lock_key), common[common_key])

    for label, specification in SOURCE_MANIFESTS.items():
        manifest_path = repo_root / specification["path"]
        manifest = load_toml(manifest_path)
        require_equal(f"{label} source name", manifest.get("name"), specification["name"])
        require_equal(
            f"{label} source commit",
            manifest.get("commit"),
            wasmer.get(specification["commit_key"]),
        )
        require_equal(
            f"{label} source remote",
            manifest.get("url"),
            wasmer.get(specification["remote_key"]),
        )
        expected_branch = (
            wasmer.get(specification["branch_key"])
            if "branch_key" in specification
            else specification["branch"]
        )
        require_equal(f"{label} source branch", manifest.get("branch"), expected_branch)

    wasix_libc = require_table(lock, "wasix_libc", str(lock_path))
    libc_manifest_path = repo_root / "src/sources/third-party/wasix-postmaster/wasix-libc.toml"
    libc_manifest = load_toml(libc_manifest_path)
    require_equal("wasix-libc source name", libc_manifest.get("name"), "wasix-libc-postmaster")
    require_equal("wasix-libc source branch", libc_manifest.get("branch"), "main")
    require_equal("wasix-libc source commit", libc_manifest.get("commit"), wasix_libc.get("commit"))
    require_equal("wasix-libc source remote", libc_manifest.get("url"), wasix_libc.get("remote"))
    require_equal("wasix-libc commit vs common.sh", wasix_libc.get("commit"), common["FRESH_WASIX_LIBC_SOURCE_COMMIT"])

    runtime_patches = require_table(lock, "current_runtime_patches", str(lock_path))
    verify_patch(
        project_root,
        require_table(runtime_patches, "wasmer", str(lock_path)),
        label="current_runtime_patches.wasmer",
        expected_path="runtime/patches/wasmer/0001-postgres-wasix-blockers.patch",
        expected_base=wasmer["commit"],
    )
    verify_patch(
        project_root,
        require_table(runtime_patches, "wasix_libc", str(lock_path)),
        label="current_runtime_patches.wasix_libc",
        expected_path="runtime/patches/wasix-libc/0001-postgres-wasix-blockers.patch",
        expected_base=wasix_libc["commit"],
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    script_project_root = Path(__file__).resolve().parents[2]
    parser.add_argument("--project-root", type=Path, default=script_project_root)
    parser.add_argument("--repo-root", type=Path)
    options = parser.parse_args()
    project_root = options.project_root
    repo_root = options.repo_root or project_root.parents[3]
    try:
        verify(project_root, repo_root)
    except (KeyError, VerificationError) as error:
        print(f"wasix-postmaster source-lock verification failed: {error}", file=sys.stderr)
        return 1
    print("wasix-postmaster source lock verified")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
