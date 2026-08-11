#!/usr/bin/env python3
"""Materialize or verify an artifact-derived WASIX postmaster identity.

This manifest proves only an exact local research closure. It has no qualified
or release mode; behavioral evidence is a separate, explicitly bound receipt.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import subprocess
import sys
import tomllib
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))
from durable_publication import (  # noqa: E402
    PublicationError,
    publish_identified,
    remove_private,
    write_bytes,
)


SCHEMA = "oliphaunt.wasix-postmaster.current-evidence.v1"
CLASSIFICATION = "research-only-non-release"
CLAIM_SCOPE = "artifact-identity-only"
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
DETERMINISTIC_START_ANALYZER_POLICY = (
    "llvm-shared-memory-init-restricted-effects.v1"
)
LINEAR_MEMORY_PROFILE_ID = (
    "oliphaunt.wasix-postmaster.linear-memory."
    "wasm32-max256m-u64-static4g-guard2g.v1"
)
RECEIPT_KEYS = (
    "schema",
    "build_recipe_sha256",
    "wasmer_source_commit",
    "wasmer_napi_commit",
    "wasmer_test_files_commit",
    "wasmer_spec_commit",
    "wasmer_patch_sha256",
    "wasmer_prepared_signature_sha256",
    "wasmer_cargo_lock_sha256",
    "wasmer_binary_sha256",
    "wasmer_features",
    "wasmer_headless_binary_sha256",
    "wasmer_headless_features",
    "runtime_abi_id",
    "artifact_abi_version",
    "wasix_libc_source_commit",
    "wasix_libc_patch_sha256",
    "wasix_libc_prepared_signature_sha256",
    "sysroot_carrier_manifest_sha256",
    "sysroot_variant",
    "sysroot_variant_manifest_sha256",
    "host_platform",
    "host_abi",
    "rustc_host",
    "rustc_version",
    "llvm_version",
)
POSTMASTER_EXECUTOR_RECEIPT_KEYS = (
    "schema",
    "build_recipe_sha256",
    "wasmer_build_receipt_sha256",
    "wasmer_source_commit",
    "wasmer_patch_sha256",
    "wasmer_prepared_signature_sha256",
    "wasmer_cargo_lock_sha256",
    "runtime_abi_id",
    "artifact_abi_version",
    "executor_package",
    "executor_binary",
    "executor_features",
    "executor_role",
    "runtime_policy_id",
    "cli_contract",
    "executor_binary_sha256",
    "start_proof_binary",
    "start_proof_features",
    "start_proof_policy",
    "start_proof_binary_sha256",
    "memory_profile_binary",
    "memory_profile_features",
    "linear_memory_profile_id",
    "memory_profile_binary_sha256",
    "postmaster_compiler_binary",
    "postmaster_compiler_features",
    "compiler_cpu_policy",
    "compiler_cpu_features",
    "postmaster_compiler_binary_sha256",
    "host_platform",
    "host_abi",
    "rustc_host",
    "rustc_version",
)


class EvidenceError(ValueError):
    pass


def sha256_bytes(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def require_sha256(value: Any, label: str) -> str:
    if not isinstance(value, str) or SHA256_RE.fullmatch(value) is None:
        raise EvidenceError(f"{label} is not a lowercase SHA-256")
    return value


def read_regular(path: Path, label: str, *, limit: int = 32 * 1024 * 1024) -> bytes:
    before = os.lstat(path)
    if stat.S_ISLNK(before.st_mode) or not stat.S_ISREG(before.st_mode):
        raise EvidenceError(f"{label} is not a regular non-symlink file: {path}")
    if before.st_size > limit:
        raise EvidenceError(f"{label} exceeds the {limit}-byte parser limit: {path}")
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    try:
        opened = os.fstat(descriptor)
        if (
            not stat.S_ISREG(opened.st_mode)
            or (opened.st_dev, opened.st_ino) != (before.st_dev, before.st_ino)
        ):
            raise EvidenceError(f"{label} changed while opening: {path}")
        chunks: list[bytes] = []
        remaining = opened.st_size
        while remaining:
            chunk = os.read(descriptor, min(remaining, 1024 * 1024))
            if not chunk:
                raise EvidenceError(f"{label} was truncated while reading: {path}")
            chunks.append(chunk)
            remaining -= len(chunk)
        after = os.fstat(descriptor)
        if (
            after.st_size,
            after.st_mtime_ns,
            after.st_dev,
            after.st_ino,
        ) != (
            opened.st_size,
            opened.st_mtime_ns,
            opened.st_dev,
            opened.st_ino,
        ):
            raise EvidenceError(f"{label} changed while reading: {path}")
        return b"".join(chunks)
    finally:
        os.close(descriptor)


def reject_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise EvidenceError(f"duplicate JSON field: {key}")
        result[key] = value
    return result


def parse_json(payload: bytes, label: str) -> dict[str, Any]:
    try:
        text = payload.decode("utf-8")
    except UnicodeDecodeError as error:
        raise EvidenceError(f"{label} is not UTF-8: {error}") from error
    if "\r" in text or "\0" in text:
        raise EvidenceError(f"{label} contains a forbidden control character")
    try:
        value = json.loads(text, object_pairs_hook=reject_duplicate_keys)
    except json.JSONDecodeError as error:
        raise EvidenceError(f"invalid {label}: {error}") from error
    if not isinstance(value, dict):
        raise EvidenceError(f"{label} must be a JSON object")
    return value


def parse_receipt(payload: bytes) -> dict[str, str]:
    try:
        text = payload.decode("utf-8")
    except UnicodeDecodeError as error:
        raise EvidenceError(f"Wasmer receipt is not UTF-8: {error}") from error
    if "\r" in text or not text.endswith("\n"):
        raise EvidenceError("Wasmer receipt is not canonical newline-terminated text")
    lines = text.splitlines()
    if len(lines) != len(RECEIPT_KEYS):
        raise EvidenceError("Wasmer receipt field count differs")
    receipt: dict[str, str] = {}
    for expected, line in zip(RECEIPT_KEYS, lines, strict=True):
        if line.count("=") != 1:
            raise EvidenceError(f"invalid Wasmer receipt field: {line!r}")
        key, value = line.split("=", 1)
        if key != expected or not value:
            raise EvidenceError(f"non-canonical Wasmer receipt field: expected {expected}")
        receipt[key] = value
    if receipt["schema"] != "oliphaunt.wasix-postmaster.wasmer-build.v2":
        raise EvidenceError("unexpected Wasmer build receipt schema")
    for key in (
        "build_recipe_sha256",
        "wasmer_patch_sha256",
        "wasmer_binary_sha256",
        "wasmer_headless_binary_sha256",
        "runtime_abi_id",
        "wasix_libc_patch_sha256",
    ):
        require_sha256(receipt[key], f"Wasmer receipt {key}")
    return receipt


def parse_postmaster_executor_receipt(payload: bytes) -> dict[str, str]:
    try:
        text = payload.decode("utf-8")
    except UnicodeDecodeError as error:
        raise EvidenceError(f"postmaster executor receipt is not UTF-8: {error}") from error
    if "\r" in text or not text.endswith("\n"):
        raise EvidenceError("postmaster executor receipt is not canonical text")
    lines = text.splitlines()
    if len(lines) != len(POSTMASTER_EXECUTOR_RECEIPT_KEYS):
        raise EvidenceError("postmaster executor receipt field count differs")
    receipt: dict[str, str] = {}
    for expected, line in zip(POSTMASTER_EXECUTOR_RECEIPT_KEYS, lines, strict=True):
        if line.count("=") != 1:
            raise EvidenceError(f"invalid postmaster executor receipt field: {line!r}")
        key, value = line.split("=", 1)
        if key != expected or not value:
            raise EvidenceError(
                f"non-canonical postmaster executor receipt field: expected {expected}"
            )
        receipt[key] = value
    if (
        receipt["schema"]
        != "oliphaunt.wasix-postmaster.postmaster-executor-build.v3"
    ):
        raise EvidenceError("unexpected postmaster executor receipt schema")
    for key in (
        "build_recipe_sha256",
        "wasmer_build_receipt_sha256",
        "wasmer_patch_sha256",
        "wasmer_prepared_signature_sha256",
        "wasmer_cargo_lock_sha256",
        "runtime_abi_id",
        "executor_binary_sha256",
        "start_proof_binary_sha256",
        "memory_profile_binary_sha256",
        "postmaster_compiler_binary_sha256",
    ):
        require_sha256(receipt[key], f"postmaster executor receipt {key}")
    if (
        receipt["start_proof_binary"] != "oliphaunt-wasix-start-proof"
        or receipt["start_proof_features"] != "start-proof-tool"
        or receipt["start_proof_policy"] != DETERMINISTIC_START_ANALYZER_POLICY
    ):
        raise EvidenceError(
            "postmaster executor deterministic-start analyzer identity differs"
        )
    if (
        receipt["memory_profile_binary"] != "oliphaunt-wasix-memory-profile"
        or receipt["memory_profile_features"] != "memory-profile-tool"
        or receipt["linear_memory_profile_id"] != LINEAR_MEMORY_PROFILE_ID
    ):
        raise EvidenceError(
            "postmaster executor linear-memory tool identity differs"
        )
    if (
        receipt["postmaster_compiler_binary"]
        != "oliphaunt-wasix-postmaster-compiler"
        or receipt["postmaster_compiler_features"] != "product-compiler"
        or receipt["compiler_cpu_policy"] != "generic-baseline"
        or receipt["compiler_cpu_features"] != "none"
    ):
        raise EvidenceError("postmaster product compiler identity differs")
    return receipt


def required_table(table: dict[str, Any], key: str) -> dict[str, Any]:
    value = table.get(key)
    if not isinstance(value, dict):
        raise EvidenceError(f"source lock is missing table {key}")
    return value


def required_string(table: dict[str, Any], key: str, label: str) -> str:
    value = table.get(key)
    if not isinstance(value, str) or not value:
        raise EvidenceError(f"{label} must be a nonempty string")
    return value


def locked_patch(
    project_root: Path,
    lock_table: dict[str, Any],
    label: str,
) -> tuple[str, int, str]:
    relative = required_string(lock_table, "path", f"{label} patch path")
    pure = PurePosixPath(relative)
    if pure.is_absolute() or any(part in ("", ".", "..") for part in pure.parts):
        raise EvidenceError(f"unsafe {label} patch path in source lock: {relative!r}")
    path = project_root.joinpath(*pure.parts)
    try:
        path.resolve().relative_to(project_root.resolve())
    except ValueError as error:
        raise EvidenceError(f"{label} patch path escapes the project root") from error
    payload = read_regular(path, f"{label} patch")
    declared_hash = require_sha256(lock_table.get("sha256"), f"{label} lock hash")
    declared_size = lock_table.get("bytes")
    if type(declared_size) is not int or declared_size < 1:
        raise EvidenceError(f"{label} lock byte count must be a positive integer")
    if len(payload) != declared_size or sha256_bytes(payload) != declared_hash:
        raise EvidenceError(f"{label} patch bytes differ from sources.lock.toml")
    return declared_hash, declared_size, relative


def carrier_directory(path: Path) -> Path:
    info = os.lstat(path)
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
        raise EvidenceError(f"carrier is not a non-symlink directory: {path}")
    return path.resolve()


def run_carrier_verifier(project_root: Path, carrier: Path) -> None:
    verifier = project_root / "bin" / "verify-sealed-headless-carrier.sh"
    info = os.lstat(verifier)
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
        raise EvidenceError(f"carrier verifier is not a regular file: {verifier}")
    environment = os.environ.copy()
    for name in (
        "FRESH_ROOT",
        "REPO_ROOT",
        "WASIX_TOOLCHAIN_ROOT",
        "POSTGRES_VERSION",
        "FRESH_WASMER_VERSION",
        "FRESH_WASMER_WASIX_VERSION",
        "FRESH_WASMER_ARTIFACT_ABI_VERSION",
        "FRESH_WASMER_SOURCE_COMMIT",
        "FRESH_WASMER_NAPI_COMMIT",
        "FRESH_WASMER_TEST_FILES_COMMIT",
        "FRESH_WASMER_SPEC_COMMIT",
        "FRESH_WASIX_LIBC_SOURCE_COMMIT",
    ):
        environment.pop(name, None)
    completed = subprocess.run(
        [str(verifier), str(carrier)],
        cwd=project_root,
        env=environment,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        text=True,
        check=False,
    )
    if completed.returncode != 0:
        detail = completed.stderr.strip().splitlines()
        suffix = f": {detail[-1]}" if detail else ""
        raise EvidenceError(f"sealed carrier verification failed{suffix}")


def artifact_snapshot(project_root: Path, carrier: Path) -> dict[str, Any]:
    source_lock_path = project_root / "sources.lock.toml"
    source_lock_raw = read_regular(source_lock_path, "source lock")
    try:
        source_lock = tomllib.loads(source_lock_raw.decode("utf-8"))
    except (UnicodeDecodeError, tomllib.TOMLDecodeError) as error:
        raise EvidenceError(f"invalid source lock: {error}") from error

    current_patches = required_table(source_lock, "current_runtime_patches")
    wasmer_patch_hash, wasmer_patch_bytes, wasmer_patch_path = locked_patch(
        project_root,
        required_table(current_patches, "wasmer"),
        "Wasmer",
    )
    libc_patch_hash, libc_patch_bytes, libc_patch_path = locked_patch(
        project_root,
        required_table(current_patches, "wasix_libc"),
        "wasix-libc",
    )

    manifest_raw = read_regular(carrier / "manifest.json", "sealed manifest")
    receipt_raw = read_regular(carrier / "wasmer-build.receipt", "Wasmer receipt")
    postmaster_receipt_path = carrier / "postmaster-executor.receipt"
    try:
        postmaster_receipt_raw = read_regular(
            postmaster_receipt_path, "postmaster executor receipt"
        )
    except FileNotFoundError:
        postmaster_receipt_raw = None
    payload_raw = read_regular(carrier / "payload.files", "payload inventory")
    manifest = parse_json(manifest_raw, "sealed manifest")
    receipt = parse_receipt(receipt_raw)
    postmaster_receipt = (
        None
        if postmaster_receipt_raw is None
        else parse_postmaster_executor_receipt(postmaster_receipt_raw)
    )

    wasmer = required_table(source_lock, "wasmer")
    wasix_libc = required_table(source_lock, "wasix_libc")
    postgresql = required_table(source_lock, "postgresql")
    exact_pairs = (
        (
            receipt["wasmer_source_commit"],
            required_string(wasmer, "commit", "Wasmer commit"),
            "Wasmer commit",
        ),
        (
            receipt["wasix_libc_source_commit"],
            required_string(wasix_libc, "commit", "wasix-libc commit"),
            "wasix-libc commit",
        ),
        (receipt["wasmer_patch_sha256"], wasmer_patch_hash, "Wasmer patch"),
        (receipt["wasix_libc_patch_sha256"], libc_patch_hash, "wasix-libc patch"),
        (
            manifest.get("postgres-version"),
            required_string(postgresql, "version", "PostgreSQL version"),
            "PostgreSQL version",
        ),
        (manifest.get("runtime-abi-id"), receipt["runtime_abi_id"], "runtime ABI"),
        (
            manifest.get("executor-sha256"),
            receipt["wasmer_headless_binary_sha256"]
            if postmaster_receipt is None
            else postmaster_receipt["executor_binary_sha256"],
            "role-selected executor",
        ),
        (manifest.get("wasmer-patch-sha256"), wasmer_patch_hash, "sealed Wasmer patch"),
    )
    for actual, expected, label in exact_pairs:
        if actual != expected:
            raise EvidenceError(f"{label} differs across the source lock, receipt, or carrier")

    if postmaster_receipt is None:
        executor_role = "full-headless"
        executor_receipt_hash = sha256_bytes(receipt_raw)
    else:
        executor_role = "postmaster-product"
        executor_receipt_hash = sha256_bytes(postmaster_receipt_raw)
        product_pairs = (
            (
                postmaster_receipt["wasmer_build_receipt_sha256"],
                sha256_bytes(receipt_raw),
                "postmaster parent receipt",
            ),
            (
                postmaster_receipt["runtime_abi_id"],
                receipt["runtime_abi_id"],
                "postmaster runtime ABI",
            ),
            (
                postmaster_receipt["executor_role"],
                executor_role,
                "postmaster executor role",
            ),
        )
        for actual, expected, label in product_pairs:
            if actual != expected:
                raise EvidenceError(f"{label} differs across executor receipts")

    runtime_abi = require_sha256(manifest.get("runtime-abi-id"), "runtime ABI")
    executor = require_sha256(manifest.get("executor-sha256"), "headless executor")
    producer = require_sha256(manifest.get("producer-recipe-sha256"), "producer recipe")
    source_fingerprint = require_sha256(manifest.get("source-fingerprint"), "source fingerprint")
    payload_hash = sha256_bytes(payload_raw)
    artifact_abi = manifest.get("artifact-abi-version")
    if type(artifact_abi) is not int or str(artifact_abi) != receipt["artifact_abi_version"]:
        raise EvidenceError("artifact ABI differs between manifest and receipt")
    compiler_config = manifest.get("compiler-config")
    if not isinstance(compiler_config, str) or not compiler_config:
        raise EvidenceError("sealed compiler config must be a nonempty string")
    postgres_version = required_string(postgresql, "version", "PostgreSQL version")

    return {
        "schema-version": SCHEMA,
        "classification": CLASSIFICATION,
        "qualification-status": "not-qualified",
        "claim-scope": CLAIM_SCOPE,
        "source-lock": {
            "path": "sources.lock.toml",
            "sha256": sha256_bytes(source_lock_raw),
        },
        "runtime-sources": {
            "wasmer-commit": receipt["wasmer_source_commit"],
            "wasmer-patch-path": wasmer_patch_path,
            "wasmer-patch-bytes": wasmer_patch_bytes,
            "wasmer-patch-sha256": wasmer_patch_hash,
            "wasix-libc-commit": receipt["wasix_libc_source_commit"],
            "wasix-libc-patch-path": libc_patch_path,
            "wasix-libc-patch-bytes": libc_patch_bytes,
            "wasix-libc-patch-sha256": libc_patch_hash,
        },
        "carrier": {
            "observed-directory-name": carrier.name,
            "canonical-directory-name": (
                f"wasix-postmaster-{postgres_version}-{runtime_abi[:16]}-{payload_hash}"
            ),
            "postgres-version": postgres_version,
            "runtime-abi-id": runtime_abi,
            "artifact-abi-version": artifact_abi,
            "compiler-config": compiler_config,
            "source-fingerprint": source_fingerprint,
            "producer-recipe-sha256": producer,
            "executor-sha256": executor,
            "executor-role": executor_role,
            "executor-receipt-sha256": executor_receipt_hash,
            "postmaster-executor-receipt-sha256": (
                None
                if postmaster_receipt_raw is None
                else sha256_bytes(postmaster_receipt_raw)
            ),
            "manifest-sha256": sha256_bytes(manifest_raw),
            "wasmer-build-receipt-sha256": sha256_bytes(receipt_raw),
            "payload-files-sha256": payload_hash,
        },
    }


def render(project_root: Path, carrier: Path) -> bytes:
    run_carrier_verifier(project_root, carrier)
    first = artifact_snapshot(project_root, carrier)
    run_carrier_verifier(project_root, carrier)
    second = artifact_snapshot(project_root, carrier)
    if first != second:
        raise EvidenceError("carrier or source inputs changed while evidence was materialized")
    return (json.dumps(first, indent=2, sort_keys=True) + "\n").encode("utf-8")


def publish_no_replace(path: Path, payload: bytes) -> None:
    path = Path(os.path.abspath(path))
    path.parent.mkdir(parents=True, exist_ok=True)
    pending = path.with_name(f".{path.name}.pending.{os.getpid()}.{os.urandom(16).hex()}")
    pending_identity = write_bytes(pending, payload)
    try:
        publish_identified(pending, path, pending_identity)
    finally:
        remove_private(pending, pending_identity)
    if read_regular(path, "published evidence manifest") != payload:
        raise EvidenceError("published evidence manifest differs from generated bytes")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    for command in ("write", "verify"):
        subparser = subparsers.add_parser(command)
        subparser.add_argument("--carrier", required=True, type=Path)
        subparser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()

    project_root = Path(__file__).resolve().parents[1]
    try:
        carrier = carrier_directory(args.carrier)
        output = args.output.resolve(strict=False)
        if output == carrier or carrier in output.parents:
            raise EvidenceError("evidence output must be outside the sealed carrier")
        expected = render(project_root, carrier)
        if args.command == "write":
            publish_no_replace(output, expected)
            print(f"wrote unqualified current-evidence manifest: {output}")
        else:
            actual = read_regular(output, "current-evidence manifest")
            if actual != expected:
                raise EvidenceError(
                    "current-evidence manifest does not exactly match the verified research artifact"
                )
            print(f"verified unqualified current-evidence manifest: {output}")
        return 0
    except (EvidenceError, OSError, PublicationError) as error:
        print(f"current-evidence manifest failed: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
