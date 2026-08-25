#!/usr/bin/env python3

"""Verify the complete local sealed WASIX PostgreSQL carrier closure."""

from __future__ import annotations

import hashlib
import json
import os
import re
import stat
import sys
from pathlib import Path, PurePosixPath
from typing import Any

from guest_build_provenance import (
    ProvenanceError,
    REQUIRED_MODULES,
    SIDE_MODULE_POLICY,
    installed_closure_identity_from_records,
)
from sealed_export_chain import (
    ExportChainError,
    RECEIPT_RELATIVE as SEALED_EXPORT_RECEIPT_RELATIVE,
    validate_export_chain,
)


PAYLOAD_SCHEMA = "oliphaunt.wasix-postmaster.payload-files.v1"
MANIFEST_SCHEMA = "oliphaunt.wasix-postmaster.sealed-aot.v5"
LINEAR_MEMORY_INSTALL_SCHEMA = "oliphaunt.wasix-postmaster.linear-memory-install.v1"
LINEAR_MEMORY_PROFILE_ID = "oliphaunt.wasix-postmaster.linear-memory.wasm32-max256m-u64-static4g-guard2g.v1"
MEMORY_SCHEMA = "oliphaunt.wasix-postmaster.memory-image.v2"
MEMORY_PHASE = "post-module-start-pre-link-relocations-v1"
DETERMINISTIC_START_PROOF_SCHEMA = (
    "oliphaunt.wasix-postmaster.deterministic-start-proof.v1"
)
DETERMINISTIC_START_ANALYZER_POLICY = (
    "llvm-shared-memory-init-restricted-effects.v1"
)
DETERMINISTIC_START_MEMORY_READS = "fresh-zero-atomic-guard-only"
DETERMINISTIC_START_MEMORY_EFFECTS = (
    "passive-data-init-zero-fill-atomic-guard-only"
)
DETERMINISTIC_START_GLOBAL_EFFECTS = "local-numeric-relocations-only"
DETERMINISTIC_START_TABLE_EFFECTS = "none"
DETERMINISTIC_START_PROOF_KEYS = {
    "schema",
    "analyzer-policy",
    "module-sha256",
    "proof-sha256",
    "start-function-index",
    "start-function-export",
    "transitive-function-indices",
    "imported-function-calls",
    "memory-reads",
    "memory-effects",
    "global-effects",
    "table-effects",
    "requires-fresh-zeroed-memory",
    "ordinary-start-execution-per-instance",
    "first-instance-full-byte-validation",
}
SHA256_RE = re.compile(r"[0-9a-f]{64}\Z")
SIZE_RE = re.compile(r"(?:0|[1-9][0-9]*)\Z")

TOP_LEVEL_MANIFEST_KEYS = {
    "format-version",
    "schema",
    "source-lane",
    "source-fingerprint",
    "core-profile",
    "guest-build-recipe-sha256",
    "postgres-version",
    "target-triple",
    "host-abi",
    "engine",
    "compiler-config",
    "cpu-policy",
    "cpu-features",
    "wasmer-version",
    "wasmer-wasix-version",
    "wasmer-source-commit",
    "wasmer-patch-sha256",
    "wasmer-cargo-lock-sha256",
    "artifact-abi-version",
    "runtime-abi-id",
    "producer-recipe-sha256",
    "executor-engine",
    "executor-sha256",
    "executor-size",
    "linear-memory-profile",
    "wasm-features",
    "entrypoint",
    "artifacts",
}
LINEAR_MEMORY_PROFILE_KEYS = {
    "id",
    "address-width",
    "supported-host-pointer-width",
    "maximum-pages",
    "maximum-bytes",
    "static-bound-pages",
    "static-offset-guard-bytes",
    "static-access-lowering",
    "install-receipt-path",
    "install-receipt-sha256",
}
ARTIFACT_KEYS = {
    "name",
    "kind",
    "path",
    "module-path",
    "sha256",
    "raw-sha256",
    "raw-size",
    "module-sha256",
    "module-size",
    "linear-memory",
    "compressed",
    "exec-aliases",
}
ARTIFACT_LINEAR_MEMORY_KEYS = {
    "profile-id",
    "source-module-sha256",
    "install-receipt-sha256",
}
LINEAR_MEMORY_INSTALL_KEYS = {
    "schema",
    "profile-id",
    "address-width",
    "supported-host-pointer-width",
    "maximum-pages",
    "maximum-bytes",
    "static-bound-pages",
    "static-offset-guard-bytes",
    "static-access-lowering",
    "requires-shared",
    "requires-import",
    "excludes-wasm32-end-wrap",
    "predecessor-export-closure-receipt",
    "predecessor-export-closure-receipt-sha256",
    "source-module-closure-sha256",
    "module-closure-sha256",
    "module-count",
    "modules",
}
LINEAR_MEMORY_INSTALL_MODULE_KEYS = {
    "path",
    "source-module-sha256",
    "module-sha256",
    "initial-pages",
    "maximum-pages",
    "maximum-bytes",
    "shared",
    "import-module",
    "import-name",
    "transformation",
}
MEMORY_KEYS = {
    "path",
    "size",
    "sha256",
    "schema",
    "module-sha256",
    "runtime-abi-id",
    "phase",
    "mapping-alignment",
    "mapped-size",
    "memory-minimum-pages",
    "memory-maximum-pages",
    "memory-shared",
    "memory-base",
    "dylink-memory-size",
    "dylink-memory-alignment",
    "stack-low",
    "deterministic-start-proof",
    "deterministic-start-proof-output-sha256",
}
MEMORY_RECEIPT_KEYS = MEMORY_KEYS - {"path", "size", "sha256"}
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
POSTMASTER_EXECUTOR_RECEIPT_PATH = "postmaster-executor.receipt"
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
GUEST_BUILD_RECEIPT_KEYS = (
    "schema",
    "core_profile",
    "guest_source_signature_sha256",
    "docker_image_id",
    "installed_closure_sha256",
    "child_backend",
    "effective_cflags",
    "effective_ldflags",
    "effective_wasm_opt",
    "effective_wasm_opt_flags",
    "effective_wasm_opt_suppress_default",
    "atomic_fence_total",
    "atomic_fence_set_latch",
    "atomic_fence_reset_latch",
    "atomic_fence_wait_event_set_wait",
    "latch_state_contract",
    "final_wasm_concurrency_receipt_sha256",
    "linear_memory_profile_id",
    "linear_memory_install_receipt_sha256",
    "postgres_tag",
    "postgres_version",
    "sysroot_variant",
)
FINAL_CONCURRENCY_RECEIPT_PATH = (
    "share/postgresql/wasix-postmaster.final-wasm-concurrency.receipt"
)
FINAL_CONCURRENCY_RECEIPT_KEYS = (
    "schema",
    "postgres_sha256",
    "wasm_dis_sha256",
    "wasm_dis_version",
    "latch_state_contract",
    "atomic_fence_total",
    "atomic_fence_set_latch",
    "atomic_fence_reset_latch",
    "atomic_fence_wait_event_set_wait",
    "i32_atomic_load_total",
    "i32_atomic_load_wait_event_set_wait",
    "i32_atomic_rmw_and_total",
    "i32_atomic_rmw_and_reset_latch",
    "i32_atomic_rmw_and_wait_event_set_wait",
    "i32_atomic_rmw_or_total",
    "i32_atomic_rmw_or_set_latch",
    "i32_atomic_rmw_or_wait_event_set_wait",
)
EXPECTED_ARTIFACTS = (
    ("runtime:initdb", "executable", "bin/initdb", ["/bin/initdb"]),
    ("runtime:postgres", "executable", "bin/postgres", ["/bin/postgres"]),
    *(
        (f"runtime:{PurePosixPath(relative).name}", "side-module", relative, [])
        for relative, _aliases in SIDE_MODULE_POLICY
    ),
)


class VerificationError(Exception):
    pass


def fail(message: str) -> None:
    raise VerificationError(message)


def require(condition: bool, message: str) -> None:
    if not condition:
        fail(message)


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def linear_memory_closure_sha256(modules: list[dict[str, Any]], hash_field: str) -> str:
    digest = hashlib.sha256()
    for value in (
        "oliphaunt.wasix-postmaster.linear-memory-install-closure.v1",
        hash_field,
    ):
        encoded = value.encode("utf-8")
        digest.update(len(encoded).to_bytes(8, "big"))
        digest.update(encoded)
    for module in modules:
        for value in (module["path"], module[hash_field]):
            encoded = value.encode("utf-8")
            digest.update(len(encoded).to_bytes(8, "big"))
            digest.update(encoded)
    return digest.hexdigest()


def checked_relative(value: Any, label: str) -> str:
    require(isinstance(value, str) and value != "", f"{label} must be a nonempty string")
    require(
        not any(character in value for character in ("\0", "\n", "\r", "\t", "\\")),
        f"{label} contains a control character or backslash: {value!r}",
    )
    path = PurePosixPath(value)
    require(not path.is_absolute(), f"{label} must be relative: {value!r}")
    require(all(part not in ("", ".", "..") for part in path.parts), f"unsafe {label}: {value!r}")
    require(str(path) == value, f"non-canonical {label}: {value!r}")
    return value


def reject_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            fail(f"duplicate JSON field: {key}")
        result[key] = value
    return result


def decode_json(data: bytes, label: str) -> Any:
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError as error:
        fail(f"{label} is not UTF-8: {error}")
    require("\r" not in text, f"{label} contains a carriage return")
    try:
        return json.loads(text, object_pairs_hook=reject_duplicate_keys)
    except (json.JSONDecodeError, VerificationError) as error:
        fail(f"invalid {label}: {error}")


def consume_regular(
    path: Path, *, capture: bool
) -> tuple[bytes | None, os.stat_result, str]:
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    before = os.lstat(path)
    require(stat.S_ISREG(before.st_mode), f"carrier entry is not a regular file: {path}")
    descriptor = os.open(path, flags)
    try:
        opened = os.fstat(descriptor)
        require(stat.S_ISREG(opened.st_mode), f"opened carrier entry is not regular: {path}")
        require(
            (before.st_dev, before.st_ino) == (opened.st_dev, opened.st_ino),
            f"carrier entry changed identity while opening: {path}",
        )
        chunks: list[bytes] | None = [] if capture else None
        digest = hashlib.sha256()
        size = 0
        while True:
            chunk = os.read(descriptor, 1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
            size += len(chunk)
            if chunks is not None:
                chunks.append(chunk)
        after = os.fstat(descriptor)
        require(
            (
                opened.st_dev,
                opened.st_ino,
                opened.st_size,
                opened.st_mtime_ns,
                opened.st_ctime_ns,
            )
            == (
                after.st_dev,
                after.st_ino,
                after.st_size,
                after.st_mtime_ns,
                after.st_ctime_ns,
            ),
            f"carrier entry changed while reading: {path}",
        )
        require(size == opened.st_size, f"short read while verifying carrier entry: {path}")
        data = b"".join(chunks) if chunks is not None else None
        return data, opened, digest.hexdigest()
    finally:
        os.close(descriptor)


def read_regular(path: Path) -> tuple[bytes, os.stat_result]:
    data, info, _ = consume_regular(path, capture=True)
    require(data is not None, f"internal read failed to capture carrier entry: {path}")
    return data, info


def hash_regular(path: Path) -> tuple[os.stat_result, str]:
    _, info, digest = consume_regular(path, capture=False)
    return info, digest


def scan_carrier(root: Path) -> tuple[set[str], set[str]]:
    root_info = os.lstat(root)
    require(stat.S_ISDIR(root_info.st_mode), f"carrier root is not a directory: {root}")
    require(not stat.S_ISLNK(root_info.st_mode), f"carrier root must not be a symlink: {root}")
    require(
        stat.S_IMODE(root_info.st_mode) == 0o555,
        f"carrier root mode must be 0555: {stat.S_IMODE(root_info.st_mode):04o}",
    )
    files: set[str] = set()
    directories: set[str] = set()
    for current, names, filenames in os.walk(root, topdown=True, followlinks=False):
        names.sort()
        filenames.sort()
        for name in names:
            path = Path(current, name)
            info = os.lstat(path)
            relative = path.relative_to(root).as_posix()
            require(not stat.S_ISLNK(info.st_mode), f"carrier contains a symlink: {relative}")
            require(stat.S_ISDIR(info.st_mode), f"carrier contains a special entry: {relative}")
            require(
                stat.S_IMODE(info.st_mode) == 0o555,
                f"carrier directory mode must be 0555: {relative}: {stat.S_IMODE(info.st_mode):04o}",
            )
            directories.add(relative)
        for name in filenames:
            path = Path(current, name)
            info = os.lstat(path)
            relative = path.relative_to(root).as_posix()
            require(not stat.S_ISLNK(info.st_mode), f"carrier contains a symlink: {relative}")
            require(stat.S_ISREG(info.st_mode), f"carrier contains a special entry: {relative}")
            mode = stat.S_IMODE(info.st_mode)
            require(
                mode in (0o444, 0o555),
                f"carrier file mode must be 0444 or 0555: {relative}: {mode:04o}",
            )
            files.add(relative)
    return files, directories


def parse_inventory(root: Path) -> tuple[dict[str, tuple[int, str]], bytes]:
    inventory_path = root / "payload.files"
    data, _ = read_regular(inventory_path)
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError as error:
        fail(f"payload.files is not UTF-8: {error}")
    require("\r" not in text, "payload.files contains a carriage return")
    lines = text.splitlines()
    require(lines and lines[0] == f"schema={PAYLOAD_SCHEMA}", "payload.files schema mismatch")
    require(text.endswith("\n"), "payload.files must end in a newline")
    inventory: dict[str, tuple[int, str]] = {}
    previous = ""
    for line_number, line in enumerate(lines[1:], 2):
        fields = line.split("\t")
        require(len(fields) == 3, f"payload.files line {line_number} must have three tab-separated fields")
        digest, size_text, relative_value = fields
        require(SHA256_RE.fullmatch(digest) is not None, f"invalid SHA-256 on payload.files line {line_number}")
        require(SIZE_RE.fullmatch(size_text) is not None, f"invalid size on payload.files line {line_number}")
        relative = checked_relative(relative_value, f"payload.files path on line {line_number}")
        require(relative != "payload.files", "payload.files must not inventory itself")
        require(relative > previous, "payload.files paths must be unique and strictly sorted")
        previous = relative
        inventory[relative] = (int(size_text), digest)
    require(inventory, "payload.files contains no carrier entries")
    return inventory, data


def verify_inventory(
    root: Path,
    inventory: dict[str, tuple[int, str]],
    actual_files: set[str],
    actual_directories: set[str],
) -> dict[str, tuple[int, str]]:
    expected_files = set(inventory) | {"payload.files"}
    missing = sorted(expected_files - actual_files)
    unexpected = sorted(actual_files - expected_files)
    require(not missing, f"carrier is missing inventoried files: {missing}")
    require(not unexpected, f"carrier contains unlisted files: {unexpected}")

    expected_directories: set[str] = set()
    for relative in expected_files:
        parent = PurePosixPath(relative).parent
        while str(parent) != ".":
            expected_directories.add(str(parent))
            parent = parent.parent
    missing_directories = sorted(expected_directories - actual_directories)
    unexpected_directories = sorted(actual_directories - expected_directories)
    require(not missing_directories, f"carrier is missing inventory parent directories: {missing_directories}")
    require(not unexpected_directories, f"carrier contains unrepresented directories: {unexpected_directories}")

    verified: dict[str, tuple[int, str]] = {}
    for relative in sorted(inventory):
        info, actual_digest = hash_regular(root.joinpath(*PurePosixPath(relative).parts))
        expected_size, expected_digest = inventory[relative]
        require(info.st_size == expected_size, f"payload size mismatch for {relative}")
        require(actual_digest == expected_digest, f"payload SHA-256 mismatch for {relative}")
        verified[relative] = (info.st_size, actual_digest)
    return verified


def verified_json(
    root: Path,
    relative: str,
    verified: dict[str, tuple[int, str]],
    label: str,
) -> Any:
    require(relative in verified, f"{label} is not inventoried: {relative}")
    data, info = read_regular(root.joinpath(*PurePosixPath(relative).parts))
    require((info.st_size, sha256_bytes(data)) == verified[relative], f"{label} changed after inventory verification")
    return decode_json(data, label)


def parse_receipt(root: Path, verified: dict[str, tuple[int, str]]) -> dict[str, str]:
    relative = "wasmer-build.receipt"
    data, info = read_regular(root / relative)
    require((info.st_size, sha256_bytes(data)) == verified[relative], "Wasmer receipt changed after inventory verification")
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError as error:
        fail(f"Wasmer receipt is not UTF-8: {error}")
    require("\r" not in text and text.endswith("\n"), "Wasmer receipt is not canonical text")
    lines = text.splitlines()
    require(len(lines) == len(RECEIPT_KEYS), "Wasmer receipt field count mismatch")
    receipt: dict[str, str] = {}
    for expected_key, line in zip(RECEIPT_KEYS, lines, strict=True):
        require(line.count("=") == 1, f"invalid Wasmer receipt field: {line!r}")
        key, value = line.split("=", 1)
        require(key == expected_key and value != "", f"non-canonical Wasmer receipt field: expected {expected_key}")
        receipt[key] = value
    return receipt


def parse_postmaster_executor_receipt(
    root: Path,
    verified: dict[str, tuple[int, str]],
    wasmer_receipt: dict[str, str],
) -> dict[str, str]:
    require(
        POSTMASTER_EXECUTOR_RECEIPT_PATH in verified,
        "carrier must contain the postmaster product executor receipt",
    )
    relative = POSTMASTER_EXECUTOR_RECEIPT_PATH
    data, info = read_regular(root / relative)
    require(
        (info.st_size, sha256_bytes(data)) == verified[relative],
        "postmaster executor receipt changed after inventory verification",
    )
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError as error:
        fail(f"postmaster executor receipt is not UTF-8: {error}")
    require(
        "\r" not in text and text.endswith("\n"),
        "postmaster executor receipt is not canonical text",
    )
    lines = text.splitlines()
    require(
        len(lines) == len(POSTMASTER_EXECUTOR_RECEIPT_KEYS),
        "postmaster executor receipt field count mismatch",
    )
    receipt: dict[str, str] = {}
    for expected_key, line in zip(
        POSTMASTER_EXECUTOR_RECEIPT_KEYS, lines, strict=True
    ):
        require(line.count("=") == 1, f"invalid postmaster executor receipt field: {line!r}")
        key, value = line.split("=", 1)
        require(
            key == expected_key and value != "",
            f"non-canonical postmaster executor receipt field: expected {expected_key}",
        )
        receipt[key] = value

    require(
        receipt["schema"]
        == "oliphaunt.wasix-postmaster.postmaster-executor-build.v3",
        "postmaster executor receipt schema mismatch",
    )
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
        require(
            SHA256_RE.fullmatch(receipt[key]) is not None,
            f"postmaster executor receipt {key} is not a SHA-256",
        )
    require(
        receipt["wasmer_build_receipt_sha256"]
        == verified["wasmer-build.receipt"][1],
        "postmaster executor receipt does not bind the packaged Wasmer receipt",
    )
    for executor_key, wasmer_key in (
        ("build_recipe_sha256", "build_recipe_sha256"),
        ("wasmer_source_commit", "wasmer_source_commit"),
        ("wasmer_patch_sha256", "wasmer_patch_sha256"),
        ("wasmer_prepared_signature_sha256", "wasmer_prepared_signature_sha256"),
        ("wasmer_cargo_lock_sha256", "wasmer_cargo_lock_sha256"),
        ("runtime_abi_id", "runtime_abi_id"),
        ("artifact_abi_version", "artifact_abi_version"),
        ("host_platform", "host_platform"),
        ("host_abi", "host_abi"),
        ("rustc_host", "rustc_host"),
        ("rustc_version", "rustc_version"),
    ):
        require(
            receipt[executor_key] == wasmer_receipt[wasmer_key],
            f"postmaster executor receipt differs from Wasmer receipt: {executor_key}",
        )
    require(
        receipt["executor_package"] == "oliphaunt-wasix-postmaster-executor"
        and receipt["executor_binary"] == "oliphaunt-wasix-postmaster-executor"
        and receipt["executor_features"] == "product-executor",
        "postmaster executor Cargo product identity mismatch",
    )
    require(
        receipt["executor_role"] == "postmaster-product",
        "postmaster executor role mismatch",
    )
    require(
        receipt["runtime_policy_id"]
        == "oliphaunt.wasix-postmaster.tokio.2-async.embedded-postmaster-v1-budget96.v2",
        "postmaster executor runtime policy mismatch",
    )
    require(
        receipt["cli_contract"] == "sealed-postmaster-run-v1",
        "postmaster executor CLI contract mismatch",
    )
    require(
        receipt["executor_binary_sha256"] == verified["bin/wasmer-headless"][1],
        "postmaster executor receipt does not identify bin/wasmer-headless",
    )
    require(
        receipt["start_proof_binary"] == "oliphaunt-wasix-start-proof"
        and receipt["start_proof_features"] == "start-proof-tool"
        and receipt["start_proof_policy"]
        == DETERMINISTIC_START_ANALYZER_POLICY,
        "postmaster executor deterministic-start analyzer identity mismatch",
    )
    require(
        receipt["memory_profile_binary"] == "oliphaunt-wasix-memory-profile"
        and receipt["memory_profile_features"] == "memory-profile-tool"
        and receipt["linear_memory_profile_id"] == LINEAR_MEMORY_PROFILE_ID,
        "postmaster executor linear-memory tool identity mismatch",
    )
    require(
        receipt["postmaster_compiler_binary"]
        == "oliphaunt-wasix-postmaster-compiler"
        and receipt["postmaster_compiler_features"] == "product-compiler"
        and receipt["compiler_cpu_policy"] == "generic-baseline"
        and receipt["compiler_cpu_features"] == "none",
        "postmaster product compiler identity mismatch",
    )
    return receipt


def parse_guest_build_receipt(
    root: Path, verified: dict[str, tuple[int, str]]
) -> dict[str, str]:
    relative = "guest-build.receipt"
    data, info = read_regular(root / relative)
    require(
        (info.st_size, sha256_bytes(data)) == verified[relative],
        "guest build receipt changed after inventory verification",
    )
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError as error:
        fail(f"guest build receipt is not UTF-8: {error}")
    require(
        "\r" not in text and text.endswith("\n"),
        "guest build receipt is not canonical text",
    )
    lines = text.splitlines()
    require(
        len(lines) == len(GUEST_BUILD_RECEIPT_KEYS),
        "guest build receipt field count mismatch",
    )
    receipt: dict[str, str] = {}
    for expected_key, line in zip(GUEST_BUILD_RECEIPT_KEYS, lines, strict=True):
        require("=" in line, f"invalid guest build receipt field: {line!r}")
        key, value = line.split("=", 1)
        require(
            key == expected_key and value != "",
            f"non-canonical guest build receipt field: expected {expected_key}",
        )
        receipt[key] = value
    require(
        receipt["schema"] == "oliphaunt.wasix-postmaster.guest-build.v5",
        "guest build receipt schema mismatch",
    )
    require(
        receipt["core_profile"] == "release-o3",
        "guest build receipt core profile lacks a qualified final fence inventory",
    )
    require(
        SHA256_RE.fullmatch(receipt["guest_source_signature_sha256"]) is not None,
        "guest build source signature is not a SHA-256",
    )
    require(
        receipt["docker_image_id"].startswith("sha256:")
        and SHA256_RE.fullmatch(receipt["docker_image_id"][len("sha256:") :])
        is not None,
        "guest build Docker image ID is not an immutable SHA-256 identity",
    )
    require(
        SHA256_RE.fullmatch(receipt["installed_closure_sha256"]) is not None,
        "guest build installed closure identity is not a SHA-256",
    )
    require(
        receipt["child_backend"] == "exec",
        "guest build receipt child backend must be exec",
    )
    require(
        receipt["effective_wasm_opt"] in {"yes", "no"},
        "guest build receipt wasm-opt mode mismatch",
    )
    require(
        receipt["effective_wasm_opt_suppress_default"] == "yes",
        "guest build receipt must suppress implicit wasm-opt defaults",
    )
    expected_fences = {
        "atomic_fence_set_latch": "2",
        "atomic_fence_reset_latch": "1",
        "atomic_fence_wait_event_set_wait": "1",
    }
    for key, expected in expected_fences.items():
        require(
            receipt[key] == expected,
            f"guest build receipt concurrency fence contract mismatch: {key}",
        )
    require(
        re.fullmatch(r"[1-9][0-9]*", receipt["atomic_fence_total"]) is not None,
        "guest build receipt atomic fence total is not canonical",
    )
    require(
        receipt["latch_state_contract"] == "packed-atomic-v1",
        "guest build receipt latch-state contract mismatch",
    )
    require(
        SHA256_RE.fullmatch(receipt["final_wasm_concurrency_receipt_sha256"])
        is not None,
        "guest build final Wasm concurrency receipt is not a SHA-256",
    )
    require(
        receipt["linear_memory_profile_id"] == LINEAR_MEMORY_PROFILE_ID,
        "guest build linear-memory profile mismatch",
    )
    require(
        SHA256_RE.fullmatch(receipt["linear_memory_install_receipt_sha256"])
        is not None,
        "guest build linear-memory install receipt is not a SHA-256",
    )
    return receipt


def parse_final_concurrency_receipt(
    root: Path,
    verified: dict[str, tuple[int, str]],
    guest_build_receipt: dict[str, str],
) -> None:
    relative = FINAL_CONCURRENCY_RECEIPT_PATH
    require(
        relative in verified,
        "carrier lacks final Wasm concurrency receipt",
    )
    data, info = read_regular(root / relative)
    require(
        (info.st_size, sha256_bytes(data)) == verified[relative],
        "final Wasm concurrency receipt changed after inventory verification",
    )
    require(
        verified[relative][1]
        == guest_build_receipt["final_wasm_concurrency_receipt_sha256"],
        "final Wasm concurrency receipt differs from guest build receipt",
    )
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError as error:
        fail(f"final Wasm concurrency receipt is not UTF-8: {error}")
    require(
        "\r" not in text and text.endswith("\n"),
        "final Wasm concurrency receipt is not canonical text",
    )
    lines = text.splitlines()
    require(
        len(lines) == len(FINAL_CONCURRENCY_RECEIPT_KEYS),
        "final Wasm concurrency receipt field count mismatch",
    )
    values: dict[str, str] = {}
    for expected_key, line in zip(
        FINAL_CONCURRENCY_RECEIPT_KEYS, lines, strict=True
    ):
        require("=" in line, f"invalid final Wasm concurrency field: {line!r}")
        key, value = line.split("=", 1)
        require(
            key == expected_key and value != "",
            f"non-canonical final Wasm concurrency field: expected {expected_key}",
        )
        values[key] = value

    require(
        values["schema"]
        == "oliphaunt.wasix-postmaster.final-wasm-concurrency.v1",
        "final Wasm concurrency receipt schema mismatch",
    )
    require(
        values["postgres_sha256"] == verified["bin/postgres"][1],
        "final Wasm concurrency receipt does not identify PostgreSQL module",
    )
    require(
        SHA256_RE.fullmatch(values["wasm_dis_sha256"]) is not None,
        "final Wasm concurrency receipt disassembler identity is not a SHA-256",
    )
    require(
        values["latch_state_contract"] == "packed-atomic-v1",
        "final Wasm concurrency receipt latch-state contract mismatch",
    )

    integer_keys = FINAL_CONCURRENCY_RECEIPT_KEYS[5:]
    integers: dict[str, int] = {}
    for key in integer_keys:
        value = values[key]
        require(
            value.isascii()
            and value.isdecimal()
            and (len(value) == 1 or value[0] != "0"),
            f"final Wasm concurrency receipt {key} is not a canonical integer",
        )
        integers[key] = int(value)
    require(
        integers["atomic_fence_total"]
        == int(guest_build_receipt["atomic_fence_total"]),
        "final Wasm concurrency receipt fence total mismatch",
    )
    expected_exact = {
        "atomic_fence_set_latch": 2,
        "atomic_fence_reset_latch": 1,
        "atomic_fence_wait_event_set_wait": 1,
        "i32_atomic_rmw_and_reset_latch": 1,
        "i32_atomic_rmw_and_wait_event_set_wait": 2,
        "i32_atomic_rmw_or_set_latch": 1,
        "i32_atomic_rmw_or_wait_event_set_wait": 1,
    }
    for key, expected in expected_exact.items():
        require(
            integers[key] == expected,
            f"final Wasm concurrency receipt contract mismatch: {key}",
        )
    require(
        integers["i32_atomic_load_wait_event_set_wait"] >= 1,
        "final Wasm concurrency receipt waiter has no atomic load",
    )
    require(
        integers["i32_atomic_load_total"]
        >= integers["i32_atomic_load_wait_event_set_wait"],
        "final Wasm concurrency receipt atomic load total is inconsistent",
    )
    require(
        integers["i32_atomic_rmw_and_total"] >= 3
        and integers["i32_atomic_rmw_or_total"] >= 2,
        "final Wasm concurrency receipt RMW totals are inconsistent",
    )


def exact_int(value: Any, label: str, *, minimum: int = 0) -> int:
    require(type(value) is int and value >= minimum, f"{label} must be an integer >= {minimum}")
    return value


def validate_deterministic_start_proof(
    proof: Any, output_sha256: Any, module_sha256: str, label: str
) -> None:
    require(
        isinstance(proof, dict) and set(proof) == DETERMINISTIC_START_PROOF_KEYS,
        f"{label} fields differ",
    )
    require(
        proof["schema"] == DETERMINISTIC_START_PROOF_SCHEMA,
        f"{label} schema mismatch",
    )
    require(
        proof["analyzer-policy"] == DETERMINISTIC_START_ANALYZER_POLICY,
        f"{label} analyzer policy mismatch",
    )
    require(
        proof["module-sha256"] == module_sha256,
        f"{label} module SHA-256 mismatch",
    )
    require(
        isinstance(proof["proof-sha256"], str)
        and SHA256_RE.fullmatch(proof["proof-sha256"]) is not None,
        f"{label} digest is not a lowercase SHA-256",
    )
    start_index = exact_int(
        proof["start-function-index"], f"{label} start function index"
    )
    require(start_index <= 0xFFFFFFFF, f"{label} start function index exceeds u32")
    require(
        proof["start-function-export"] == "__wasm_init_memory",
        f"{label} start function export mismatch",
    )
    closure = proof["transitive-function-indices"]
    require(
        isinstance(closure, list)
        and len(closure) > 0
        and all(
            type(index) is int and 0 <= index <= 0xFFFFFFFF for index in closure
        )
        and closure == sorted(set(closure))
        and start_index in closure,
        f"{label} transitive function closure is invalid",
    )
    require(
        type(proof["imported-function-calls"]) is int
        and proof["imported-function-calls"] == 0,
        f"{label} admits imported function calls",
    )
    for field, expected in (
        ("memory-reads", DETERMINISTIC_START_MEMORY_READS),
        ("memory-effects", DETERMINISTIC_START_MEMORY_EFFECTS),
        ("global-effects", DETERMINISTIC_START_GLOBAL_EFFECTS),
        ("table-effects", DETERMINISTIC_START_TABLE_EFFECTS),
    ):
        require(proof[field] == expected, f"{label} {field} policy mismatch")
    for field in (
        "requires-fresh-zeroed-memory",
        "ordinary-start-execution-per-instance",
        "first-instance-full-byte-validation",
    ):
        require(proof[field] is True, f"{label} requires {field}=true")
    canonical_proof = json.dumps(
        proof,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    require(
        isinstance(output_sha256, str)
        and SHA256_RE.fullmatch(output_sha256) is not None
        and output_sha256 == sha256_bytes(canonical_proof),
        f"{label} canonical analyzer output digest mismatch",
    )


def inventory_identity(
    verified: dict[str, tuple[int, str]], relative: str, label: str
) -> tuple[int, str]:
    checked_relative(relative, label)
    require(relative in verified, f"{label} is not inventoried: {relative}")
    return verified[relative]


def source_fingerprint(root: Path, verified: dict[str, tuple[int, str]]) -> str:
    digest = hashlib.sha256()
    for subtree in ("bin", "lib", "share"):
        subtree_root = root / subtree
        for current, directories, files in os.walk(subtree_root, followlinks=False):
            directories.sort()
            files.sort()
            for name in files:
                relative = Path(current, name).relative_to(root).as_posix()
                if relative == "bin/wasmer-headless":
                    continue
                size, file_digest = verified[relative]
                for value in (relative, str(size), file_digest):
                    encoded = value.encode("utf-8")
                    digest.update(len(encoded).to_bytes(8, "big"))
                    digest.update(encoded)
    return digest.hexdigest()


def guest_installed_closure_identity(
    verified: dict[str, tuple[int, str]],
) -> str:
    selected = sorted(
        set(REQUIRED_MODULES)
        | {path for path in verified if path.startswith("share/postgresql/")}
    )
    try:
        return installed_closure_identity_from_records(
            [(path, verified[path][0], verified[path][1]) for path in selected]
        )
    except (KeyError, ProvenanceError) as error:
        fail(f"cannot derive guest installed closure identity: {error}")


def verify_layout(verified: dict[str, tuple[int, str]]) -> None:
    require(
        {path for path in verified if "/" not in path}
        == {
            "guest-build.receipt",
            "manifest.json",
            "postmaster-executor.receipt",
            "wasmer-build.receipt",
        },
        "carrier root contains an unexpected inventoried file",
    )
    require(
        {path for path in verified if path.startswith("bin/")}
        == {"bin/initdb", "bin/postgres", "bin/wasmer-headless"},
        "carrier bin/ closure differs",
    )
    require(
        {path for path in verified if path.startswith("lib/")}
        == {
            path
            for relative, aliases in SIDE_MODULE_POLICY
            for path in (relative, *aliases)
        },
        "carrier lib/ closure differs",
    )
    require(any(path.startswith("share/postgresql/") for path in verified), "carrier PostgreSQL share tree is empty")
    require(
        all(
            path.startswith(("bin/", "lib/", "share/postgresql/", "aot/", "memory/"))
            or path in {
                "guest-build.receipt",
                "manifest.json",
                "postmaster-executor.receipt",
                "wasmer-build.receipt",
            }
            for path in verified
        ),
        "carrier inventory contains a file outside the supported closure",
    )
    for relative, aliases in SIDE_MODULE_POLICY:
        identities = {verified[path] for path in (relative, *aliases)}
        require(
            len(identities) == 1,
            f"carrier aliases do not contain bytes identical to {relative}",
        )


def verify_manifest(
    root: Path,
    verified: dict[str, tuple[int, str]],
    receipt: dict[str, str],
    postmaster_executor_receipt: dict[str, str],
    guest_build_receipt: dict[str, str],
    expected_producer_recipe: str,
    postgres_version: str,
    wasmer_version: str,
    wasmer_wasix_version: str,
    artifact_abi_version: int,
) -> None:
    manifest = verified_json(root, "manifest.json", verified, "sealed manifest")
    require(isinstance(manifest, dict), "sealed manifest must be a JSON object")
    require(set(manifest) == TOP_LEVEL_MANIFEST_KEYS, "sealed manifest top-level fields differ")
    require(manifest["format-version"] == 6, "sealed manifest format version mismatch")
    require(manifest["schema"] == MANIFEST_SCHEMA, "sealed manifest schema mismatch")
    require(manifest["source-lane"] == "wasix-postmaster", "sealed manifest source lane mismatch")
    require(
        manifest["core-profile"] == "release-o3",
        "sealed manifest core profile lacks a qualified final fence inventory",
    )
    require(
        manifest["core-profile"] == guest_build_receipt["core_profile"],
        "sealed manifest core profile differs from the guest build receipt",
    )
    require(
        isinstance(manifest["guest-build-recipe-sha256"], str)
        and SHA256_RE.fullmatch(manifest["guest-build-recipe-sha256"]) is not None,
        "sealed manifest guest build recipe is not a SHA-256",
    )
    require(
        manifest["guest-build-recipe-sha256"]
        == verified["guest-build.receipt"][1],
        "sealed manifest guest build recipe differs from its inventoried receipt",
    )
    require(manifest["postgres-version"] == postgres_version, "sealed manifest PostgreSQL version mismatch")
    require(
        guest_build_receipt["postgres_version"] == postgres_version,
        "guest build receipt PostgreSQL version mismatch",
    )
    require(
        guest_build_receipt["sysroot_variant"] == receipt["sysroot_variant"],
        "guest build receipt sysroot differs from the Wasmer build receipt",
    )
    require(manifest["target-triple"] == receipt["rustc_host"], "sealed manifest target differs from receipt")
    require(manifest["host-abi"] == receipt["host_abi"], "sealed manifest host ABI differs from receipt")
    require(manifest["engine"] == "llvm-opta", "sealed manifest producer engine mismatch")
    require(isinstance(manifest["compiler-config"], str) and manifest["compiler-config"], "sealed compiler config is empty")
    require(manifest["cpu-policy"] == "generic-baseline", "sealed CPU policy mismatch")
    require(manifest["cpu-features"] == [], "sealed CPU feature list must be empty")
    require(manifest["wasmer-version"] == wasmer_version, "sealed Wasmer version mismatch")
    require(manifest["wasmer-wasix-version"] == wasmer_wasix_version, "sealed Wasmer-WASIX version mismatch")
    require(manifest["wasmer-source-commit"] == receipt["wasmer_source_commit"], "sealed Wasmer source differs from receipt")
    require(manifest["wasmer-patch-sha256"] == receipt["wasmer_patch_sha256"], "sealed Wasmer patch differs from receipt")
    require(manifest["wasmer-cargo-lock-sha256"] == receipt["wasmer_cargo_lock_sha256"], "sealed Cargo.lock differs from receipt")
    require(exact_int(manifest["artifact-abi-version"], "artifact ABI version") == artifact_abi_version, "sealed artifact ABI mismatch")
    require(str(artifact_abi_version) == receipt["artifact_abi_version"], "receipt artifact ABI mismatch")
    require(manifest["runtime-abi-id"] == receipt["runtime_abi_id"], "sealed runtime ABI differs from receipt")
    require(manifest["producer-recipe-sha256"] == expected_producer_recipe, "sealed AOT producer recipe mismatch")
    require(manifest["executor-engine"] == "engine-headless", "sealed executor engine mismatch")
    headless_size, headless_digest = verified["bin/wasmer-headless"]
    require(manifest["executor-sha256"] == headless_digest, "sealed executor SHA-256 mismatch")
    expected_executor_digest = postmaster_executor_receipt["executor_binary_sha256"]
    require(
        manifest["executor-sha256"] == expected_executor_digest,
        "sealed executor differs from its role-selected receipt",
    )
    require(exact_int(manifest["executor-size"], "executor size", minimum=1) == headless_size, "sealed executor size mismatch")
    linear_profile = manifest["linear-memory-profile"]
    require(
        isinstance(linear_profile, dict)
        and set(linear_profile) == LINEAR_MEMORY_PROFILE_KEYS,
        "sealed linear-memory profile fields differ",
    )
    expected_linear_profile = {
        "id": LINEAR_MEMORY_PROFILE_ID,
        "address-width": "wasm32",
        "supported-host-pointer-width": "u64",
        "maximum-pages": 4096,
        "maximum-bytes": 268435456,
        "static-bound-pages": 65536,
        "static-offset-guard-bytes": 2147483648,
        "static-access-lowering": "wasmer-llvm-unchecked-reservation-and-guard-v1",
    }
    for key, expected in expected_linear_profile.items():
        require(
            linear_profile[key] == expected,
            f"sealed linear-memory profile differs: {key}",
        )
    linear_receipt_path = linear_profile["install-receipt-path"]
    require(
        isinstance(linear_receipt_path, str)
        and linear_receipt_path
        == "share/postgresql/wasix-postmaster.linear-memory-profile.receipt.json",
        "sealed linear-memory install receipt path differs",
    )
    linear_receipt_size, linear_receipt_digest = inventory_identity(
        verified, linear_receipt_path, "linear-memory install receipt"
    )
    require(linear_receipt_size > 0, "linear-memory install receipt is empty")
    require(
        linear_profile["install-receipt-sha256"] == linear_receipt_digest,
        "sealed linear-memory install receipt SHA-256 differs",
    )
    require(
        guest_build_receipt["linear_memory_profile_id"] == LINEAR_MEMORY_PROFILE_ID
        and guest_build_receipt["linear_memory_install_receipt_sha256"]
        == linear_receipt_digest,
        "guest build receipt linear-memory binding differs",
    )
    linear_receipt = verified_json(
        root, linear_receipt_path, verified, "linear-memory install receipt"
    )
    require(
        isinstance(linear_receipt, dict)
        and set(linear_receipt) == LINEAR_MEMORY_INSTALL_KEYS,
        "linear-memory install receipt fields differ",
    )
    receipt_profile_keys = {
        "profile-id": LINEAR_MEMORY_PROFILE_ID,
        "address-width": "wasm32",
        "supported-host-pointer-width": "u64",
        "maximum-pages": 4096,
        "maximum-bytes": 268435456,
        "static-bound-pages": 65536,
        "static-offset-guard-bytes": 2147483648,
        "static-access-lowering": "wasmer-llvm-unchecked-reservation-and-guard-v1",
        "requires-shared": True,
        "requires-import": "env.memory",
        "excludes-wasm32-end-wrap": True,
    }
    require(
        linear_receipt["schema"] == LINEAR_MEMORY_INSTALL_SCHEMA,
        "linear-memory install receipt schema differs",
    )
    for key, expected in receipt_profile_keys.items():
        require(
            linear_receipt[key] == expected,
            f"linear-memory install receipt profile differs: {key}",
        )
    for key in (
        "predecessor-export-closure-receipt-sha256",
        "source-module-closure-sha256",
        "module-closure-sha256",
    ):
        require(
            isinstance(linear_receipt[key], str)
            and SHA256_RE.fullmatch(linear_receipt[key]) is not None,
            f"linear-memory install receipt {key} is not a SHA-256",
        )
    linear_modules = linear_receipt["modules"]
    require(
        isinstance(linear_modules, list)
        and exact_int(linear_receipt["module-count"], "linear-memory module count", minimum=1)
        == len(linear_modules),
        "linear-memory install receipt module count differs",
    )
    linear_modules_by_path: dict[str, dict[str, Any]] = {}
    for module in linear_modules:
        require(
            isinstance(module, dict)
            and set(module) == LINEAR_MEMORY_INSTALL_MODULE_KEYS,
            "linear-memory install module fields differ",
        )
        path = module["path"]
        require(
            isinstance(path, str) and path not in linear_modules_by_path,
            "linear-memory install module path is invalid or duplicated",
        )
        require(
            SHA256_RE.fullmatch(module["source-module-sha256"]) is not None
            and SHA256_RE.fullmatch(module["module-sha256"]) is not None,
            f"linear-memory install module hash differs for {path}",
        )
        require(
            type(module["initial-pages"]) is int
            and 0 <= module["initial-pages"] <= 4096
            and module["maximum-pages"] == 4096
            and module["maximum-bytes"] == 268435456
            and module["shared"] is True
            and module["import-module"] == "env"
            and module["import-name"] == "memory"
            and module["transformation"]
            == "pinned-wasixcc-65536-to-embedded-4096-reversible-v1",
            f"linear-memory install module contract differs for {path}",
        )
        linear_modules_by_path[path] = module
    require(
        [module["path"] for module in linear_modules]
        == sorted(linear_modules_by_path),
        "linear-memory install modules are not path-sorted",
    )
    require(
        linear_memory_closure_sha256(linear_modules, "source-module-sha256")
        == linear_receipt["source-module-closure-sha256"]
        and linear_memory_closure_sha256(linear_modules, "module-sha256")
        == linear_receipt["module-closure-sha256"],
        "linear-memory install closure SHA-256 differs",
    )
    require(
        linear_receipt["predecessor-export-closure-receipt"]
        == SEALED_EXPORT_RECEIPT_RELATIVE,
        "linear-memory predecessor path is not the canonical sealed-export receipt",
    )
    _, predecessor_digest = inventory_identity(
        verified,
        SEALED_EXPORT_RECEIPT_RELATIVE,
        "sealed-export predecessor receipt",
    )
    require(
        predecessor_digest
        == linear_receipt["predecessor-export-closure-receipt-sha256"],
        "linear-memory predecessor receipt digest differs",
    )
    try:
        validate_export_chain(
            root,
            Path(__file__).resolve().parent.parent,
            {
                module["path"]: module["source-module-sha256"]
                for module in linear_modules
            },
            verified,
        )
    except ExportChainError as error:
        fail(f"sealed-export predecessor chain differs: {error}")
    require(manifest["wasm-features"] == ["exceptions", "threads"], "sealed Wasm features mismatch")
    require(manifest["entrypoint"] == "runtime:postgres", "sealed entrypoint mismatch")
    require(manifest["source-fingerprint"] == source_fingerprint(root, verified), "sealed source fingerprint mismatch")
    require(
        guest_build_receipt["installed_closure_sha256"]
        == guest_installed_closure_identity(verified),
        "guest build receipt installed closure differs from the carrier bytes",
    )

    artifacts = manifest["artifacts"]
    require(isinstance(artifacts, list) and len(artifacts) == len(EXPECTED_ARTIFACTS), "sealed artifact closure size mismatch")
    expected_aot: set[str] = set()
    seen_module_hashes: set[str] = set()
    for artifact, expected in zip(artifacts, EXPECTED_ARTIFACTS, strict=True):
        expected_name, expected_kind, expected_module_path, expected_aliases = expected
        require(isinstance(artifact, dict), f"sealed artifact {expected_name} must be an object")
        require(set(artifact) == ARTIFACT_KEYS, f"sealed artifact fields differ for {expected_name}")
        require(artifact["name"] == expected_name, f"sealed artifact name/order mismatch for {expected_name}")
        require(artifact["kind"] == expected_kind, f"sealed artifact kind mismatch for {expected_name}")
        require(artifact["module-path"] == expected_module_path, f"sealed module path mismatch for {expected_name}")
        require(artifact["exec-aliases"] == expected_aliases, f"sealed aliases mismatch for {expected_name}")
        require(artifact["compressed"] is False, f"sealed artifact must be uncompressed for {expected_name}")
        module_digest = artifact["module-sha256"]
        require(isinstance(module_digest, str) and SHA256_RE.fullmatch(module_digest), f"invalid module SHA-256 for {expected_name}")
        artifact_linear_memory = artifact["linear-memory"]
        require(
            isinstance(artifact_linear_memory, dict)
            and set(artifact_linear_memory) == ARTIFACT_LINEAR_MEMORY_KEYS,
            f"sealed artifact linear-memory fields differ for {expected_name}",
        )
        try:
            install_record = linear_modules_by_path[expected_module_path]
        except KeyError:
            fail(f"linear-memory install receipt has no record for {expected_name}")
        require(
            artifact_linear_memory["profile-id"] == LINEAR_MEMORY_PROFILE_ID
            and artifact_linear_memory["install-receipt-sha256"]
            == linear_receipt_digest
            and artifact_linear_memory["source-module-sha256"]
            == install_record["source-module-sha256"]
            and install_record["module-sha256"] == module_digest,
            f"sealed artifact linear-memory binding differs for {expected_name}",
        )
        require(module_digest not in seen_module_hashes, f"duplicate module digest for {expected_name}")
        seen_module_hashes.add(module_digest)
        expected_artifact_path = f"aot/{module_digest.upper()}.bin"
        require(artifact["path"] == expected_artifact_path, f"sealed AOT path mismatch for {expected_name}")
        expected_aot.add(expected_artifact_path)
        module_size, actual_module_digest = inventory_identity(verified, expected_module_path, f"module path for {expected_name}")
        artifact_size, actual_artifact_digest = inventory_identity(verified, expected_artifact_path, f"AOT path for {expected_name}")
        require(actual_module_digest == module_digest, f"module SHA-256 mismatch for {expected_name}")
        require(exact_int(artifact["module-size"], f"module size for {expected_name}") == module_size, f"module size mismatch for {expected_name}")
        require(artifact["sha256"] == actual_artifact_digest, f"AOT SHA-256 mismatch for {expected_name}")
        require(artifact["raw-sha256"] == actual_artifact_digest, f"raw AOT SHA-256 mismatch for {expected_name}")
        require(exact_int(artifact["raw-size"], f"raw AOT size for {expected_name}") == artifact_size, f"raw AOT size mismatch for {expected_name}")

    require(
        {path for path in verified if path.startswith("aot/")} == expected_aot,
        "carrier AOT directory differs from the manifest closure",
    )
    require(
        not any(path.startswith("memory/") for path in verified),
        "carrier contains unsupported preinitialized-memory payloads",
    )


def recipe_inputs(root: Path) -> None:
    info = os.lstat(root)
    require(stat.S_ISDIR(info.st_mode) and not stat.S_ISLNK(info.st_mode), f"carrier root must be a non-symlink directory: {root}")
    manifest_data, _ = read_regular(root / "manifest.json")
    manifest = decode_json(manifest_data, "sealed manifest")
    require(isinstance(manifest, dict), "sealed manifest must be an object")
    values = (
        manifest.get("compiler-config"),
        manifest.get("target-triple"),
        manifest.get("source-fingerprint"),
    )
    for label, value in zip(("compiler-config", "target-triple", "source-fingerprint"), values, strict=True):
        require(isinstance(value, str) and value and "\n" not in value and "\r" not in value, f"invalid sealed manifest {label}")
    require(SHA256_RE.fullmatch(values[2]) is not None, "invalid sealed source fingerprint")
    print(*values, sep="\n")


def executor_selection(root: Path) -> None:
    actual_files, actual_directories = scan_carrier(root)
    inventory, _ = parse_inventory(root)
    verified = verify_inventory(
        root, inventory, actual_files, actual_directories
    )
    verify_layout(verified)
    wasmer_receipt = parse_receipt(root, verified)
    postmaster_receipt = parse_postmaster_executor_receipt(
        root, verified, wasmer_receipt
    )
    manifest = verified_json(root, "manifest.json", verified, "sealed manifest")
    require(isinstance(manifest, dict), "sealed manifest must be a JSON object")
    executor_size, executor_digest = verified["bin/wasmer-headless"]
    require(
        manifest.get("executor-sha256") == executor_digest,
        "sealed manifest does not identify the selected executor",
    )
    require(
        manifest.get("executor-size") == executor_size,
        "sealed manifest selected executor size differs",
    )
    role = "postmaster-product"
    receipt_path = POSTMASTER_EXECUTOR_RECEIPT_PATH
    print(
        role,
        receipt_path,
        verified[receipt_path][1],
        executor_digest,
        sep="\t",
    )


def verify(arguments: list[str]) -> None:
    require(len(arguments) == 7, "internal verifier invocation has the wrong argument count")
    root = Path(arguments[0])
    expected_producer_recipe = arguments[1]
    postgres_version = arguments[2]
    wasmer_version = arguments[3]
    wasmer_wasix_version = arguments[4]
    try:
        artifact_abi_version = int(arguments[5])
    except ValueError:
        fail("expected artifact ABI version is not an integer")
    expected_root = Path(arguments[6])
    require(root == expected_root, "carrier root changed while canonicalizing")
    require(SHA256_RE.fullmatch(expected_producer_recipe) is not None, "expected producer recipe is not a SHA-256")
    actual_files, actual_directories = scan_carrier(root)
    inventory, _ = parse_inventory(root)
    verified = verify_inventory(root, inventory, actual_files, actual_directories)
    verify_layout(verified)
    receipt = parse_receipt(root, verified)
    postmaster_executor_receipt = parse_postmaster_executor_receipt(
        root, verified, receipt
    )
    guest_build_receipt = parse_guest_build_receipt(root, verified)
    parse_final_concurrency_receipt(root, verified, guest_build_receipt)
    verify_manifest(
        root,
        verified,
        receipt,
        postmaster_executor_receipt,
        guest_build_receipt,
        expected_producer_recipe,
        postgres_version,
        wasmer_version,
        wasmer_wasix_version,
        artifact_abi_version,
    )


def main() -> int:
    try:
        if len(sys.argv) == 3 and sys.argv[1] == "recipe-inputs":
            recipe_inputs(Path(sys.argv[2]))
            return 0
        if len(sys.argv) == 3 and sys.argv[1] == "executor-selection":
            executor_selection(Path(sys.argv[2]))
            return 0
        if len(sys.argv) >= 2 and sys.argv[1] == "verify":
            verify(sys.argv[2:])
            return 0
        fail("usage: verify-sealed-carrier.py recipe-inputs ROOT | executor-selection ROOT | verify ROOT PRODUCER PG WASMER WASIX ABI CANONICAL_ROOT")
    except (OSError, VerificationError) as error:
        print(f"sealed carrier verification failed: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
