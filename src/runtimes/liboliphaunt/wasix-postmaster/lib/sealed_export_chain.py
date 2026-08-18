#!/usr/bin/env python3

"""Strictly verify the sealed-export predecessor of the memory-ABI seal."""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
from typing import Any, Mapping


RECEIPT_RELATIVE = (
    "share/postgresql/wasix-postmaster.sealed-export.structure.receipt"
)
SEED_PROOF_RELATIVE = (
    "share/postgresql/wasix-postmaster.sealed-export.seed-proof.json"
)
FINAL_PROOF_RELATIVE = (
    "share/postgresql/wasix-postmaster.sealed-export.final-proof.json"
)
ALLOWLIST_RELATIVE = (
    "share/postgresql/wasix-postmaster.sealed-export.allowlist"
)
RECEIPT_SCHEMA = "oliphaunt.wasix-postmaster.sealed-export-structure.v1"
PROOF_SCHEMA = "oliphaunt.wasix-postmaster.sealed-export-closure-proof.v2"
POLICY_ID = "oliphaunt.wasix-postmaster.sealed-export-closure.v1"
SHA256_RE = re.compile(r"[0-9a-f]{64}\Z")
LINEAR_RECEIPT_RELATIVE = (
    "share/postgresql/wasix-postmaster.linear-memory-profile.receipt.json"
)
LINEAR_RECEIPT_SCHEMA = "oliphaunt.wasix-postmaster.linear-memory-install.v1"
LINEAR_PROFILE_ID = (
    "oliphaunt.wasix-postmaster.linear-memory."
    "wasm32-max256m-u64-static4g-guard2g.v1"
)
MAX_UNINVENTORIED_INPUT_BYTES = 512 * 1024 * 1024

RECEIPT_KEYS = {
    "schema",
    "policy-id",
    "analyzer-version",
    "analyzer-binary-sha256",
    "dce-tool-sha256",
    "dce-tool-version",
    "dce-passes",
    "mandatory-policy-sha256",
    "declared-main-dlsym-policy-sha256",
    "side-manifest-sha256",
    "allowlist-sha256",
    "seed-proof-sha256",
    "final-proof-sha256",
    "seed",
    "final-module",
    "sides",
}
SNAPSHOT_KEYS = {
    "sha256",
    "bytes",
    "exports",
    "local-functions",
    "local-globals",
    "element-function-entries",
    "element-unique-function-indices",
    "start-function-index",
}
SIDE_KEYS = {"path", "sha256"}
PROOF_KEYS = {
    "schema",
    "policy-id",
    "analyzer-version",
    "mandatory-policy-sha256",
    "declared-main-dlsym-policy-sha256",
    "main",
    "sides",
    "mandatory-runtime-exports",
    "declared-main-dlsym-exports",
    "side-dynamic-imports",
    "retained-main-exports",
    "retained-main-export-descriptors",
    "removed-main-export-count",
    "removed-main-export-names-sha256",
    "unresolved-main-requirements",
    "mismatched-main-requirements",
    "unresolved-side-dependencies",
    "retained-counts",
    "removed-counts",
}
MODULE_KEYS = {
    "path",
    "sha256",
    "bytes",
    "non-export-sections-sha256",
    "dylink-needed",
    "imported-functions",
    "local-functions",
    "imported-globals",
    "local-globals",
    "imported-tables",
    "local-tables",
    "element-function-entries",
    "element-unique-function-indices",
    "element-max-function-index",
    "start-function-index",
    "imports",
    "export-counts",
    "exported-global-type-counts",
    "exported-immutable-i32-globals",
    "exported-local-functions",
    "exported-imported-functions",
}
LINEAR_RECEIPT_KEYS = {
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
LINEAR_MODULE_KEYS = {
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


class ExportChainError(ValueError):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ExportChainError(message)


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def duplicate_rejecting_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        require(key not in result, f"duplicate sealed-export JSON field: {key}")
        result[key] = value
    return result


def parse_json(data: bytes, label: str) -> dict[str, Any]:
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError as error:
        raise ExportChainError(f"{label} is not UTF-8: {error}") from error
    require("\0" not in text and "\r" not in text, f"{label} is not canonical text")
    try:
        value = json.loads(text, object_pairs_hook=duplicate_rejecting_object)
    except json.JSONDecodeError as error:
        raise ExportChainError(f"invalid {label}: {error}") from error
    require(isinstance(value, dict), f"{label} must be an object")
    return value


def safe_relative(value: Any, label: str) -> str:
    require(isinstance(value, str) and value, f"{label} must be nonempty")
    pure = PurePosixPath(value)
    require(
        not pure.is_absolute()
        and all(part not in ("", ".", "..") for part in pure.parts),
        f"unsafe {label}: {value!r}",
    )
    return value


def read_regular(
    root: Path,
    relative: str,
    expected_identities: Mapping[str, tuple[int, str]] | None,
) -> bytes:
    safe_relative(relative, "sealed-export path")
    path = root.joinpath(*PurePosixPath(relative).parts)
    expected: tuple[int, str] | None = None
    if expected_identities is not None:
        require(relative in expected_identities, f"sealed-export input is not inventoried: {relative}")
        expected = expected_identities[relative]
        require(
            type(expected[0]) is int and 0 <= expected[0] <= MAX_UNINVENTORIED_INPUT_BYTES,
            f"sealed-export inventory size is invalid: {relative}",
        )
    descriptor = os.open(
        path,
        os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0),
    )
    try:
        before = os.fstat(descriptor)
        require(
            stat.S_ISREG(before.st_mode),
            f"sealed-export input is not a regular file: {relative}",
        )
        bound = expected[0] if expected is not None else MAX_UNINVENTORIED_INPUT_BYTES
        if expected is not None:
            require(
                before.st_size == expected[0],
                f"sealed-export input size differs from inventory: {relative}",
            )
        require(
            0 <= before.st_size <= bound,
            f"sealed-export input exceeds its read bound: {relative}",
        )
        data = bytearray()
        while len(data) <= bound:
            chunk = os.read(descriptor, min(1024 * 1024, bound + 1 - len(data)))
            if not chunk:
                break
            data.extend(chunk)
        require(
            len(data) == before.st_size and len(data) <= bound,
            f"sealed-export input changed size while reading: {relative}",
        )
        after = os.fstat(descriptor)
        require(
            (
                before.st_dev,
                before.st_ino,
                before.st_size,
                before.st_mtime_ns,
                before.st_ctime_ns,
            )
            == (
                after.st_dev,
                after.st_ino,
                after.st_size,
                after.st_mtime_ns,
                after.st_ctime_ns,
            ),
            f"sealed-export input changed while reading: {relative}",
        )
    finally:
        os.close(descriptor)
    result = bytes(data)
    if expected is not None:
        require(
            expected == (len(result), sha256(result)),
            f"sealed-export input differs from inventory: {relative}",
        )
    return result


def tracked_hash(path: Path, label: str) -> str:
    info = os.lstat(path)
    require(
        stat.S_ISREG(info.st_mode) and not stat.S_ISLNK(info.st_mode),
        f"tracked {label} is not a regular file: {path}",
    )
    return sha256(path.read_bytes())


def require_sha(value: Any, label: str) -> str:
    require(isinstance(value, str) and SHA256_RE.fullmatch(value) is not None, f"{label} is not a SHA-256")
    return value


def side_manifest_paths(path: Path) -> list[str]:
    lines = path.read_text(encoding="utf-8").splitlines()
    require(
        lines and lines[0] == "# schema=oliphaunt.wasix-postmaster.sealed-side-modules.v1",
        "sealed side-module manifest schema differs",
    )
    result: list[str] = []
    for line in lines:
        if not line or line.startswith("#"):
            continue
        fields = line.split("\t")
        require(len(fields) == 3, "sealed side-module manifest row differs")
        result.append(safe_relative(fields[0], "sealed side-module path"))
    require(len(result) == 27 and len(set(result)) == 27, "sealed side-module manifest must contain exactly 27 canonical paths")
    return result


def validate_proof(
    proof: dict[str, Any],
    label: str,
    receipt: dict[str, Any],
    expected_main_sha256: str,
    expected_sides: list[dict[str, str]],
) -> None:
    require(set(proof) == PROOF_KEYS, f"{label} fields differ")
    require(proof["schema"] == PROOF_SCHEMA, f"{label} schema differs")
    require(proof["policy-id"] == POLICY_ID, f"{label} policy differs")
    require(
        proof["analyzer-version"] == receipt["analyzer-version"],
        f"{label} analyzer version differs from structural receipt",
    )
    require(
        proof["mandatory-policy-sha256"] == receipt["mandatory-policy-sha256"]
        and proof["declared-main-dlsym-policy-sha256"]
        == receipt["declared-main-dlsym-policy-sha256"],
        f"{label} policy hashes differ from structural receipt",
    )
    main = proof["main"]
    require(isinstance(main, dict) and set(main) == MODULE_KEYS, f"{label} main fields differ")
    require(
        main["path"] == "bin/postgres" and main["sha256"] == expected_main_sha256,
        f"{label} main module identity differs",
    )
    sides = proof["sides"]
    require(isinstance(sides, list) and len(sides) == len(expected_sides), f"{label} side closure differs")
    for module, expected in zip(sides, expected_sides, strict=True):
        require(isinstance(module, dict) and set(module) == MODULE_KEYS, f"{label} side fields differ")
        require(
            (module["path"], module["sha256"])
            == (expected["path"], expected["sha256"]),
            f"{label} side identity differs: {expected['path']}",
        )
    for field in (
        "unresolved-main-requirements",
        "mismatched-main-requirements",
        "unresolved-side-dependencies",
    ):
        require(proof[field] == [], f"{label} is not a closed export graph: {field}")


def validate_export_chain(
    root: Path,
    project_root: Path,
    source_module_hashes: Mapping[str, str],
    expected_identities: Mapping[str, tuple[int, str]] | None = None,
) -> dict[str, Any]:
    receipt_data = read_regular(root, RECEIPT_RELATIVE, expected_identities)
    receipt = parse_json(receipt_data, "sealed-export structural receipt")
    require(set(receipt) == RECEIPT_KEYS, "sealed-export structural receipt fields differ")
    require(receipt["schema"] == RECEIPT_SCHEMA, "sealed-export structural receipt schema differs")
    require(receipt["policy-id"] == POLICY_ID, "sealed-export structural receipt policy differs")
    require(receipt["dce-passes"] == ["--remove-unused-module-elements"], "sealed-export DCE pass differs")
    for field in (
        "analyzer-binary-sha256",
        "dce-tool-sha256",
        "mandatory-policy-sha256",
        "declared-main-dlsym-policy-sha256",
        "side-manifest-sha256",
        "allowlist-sha256",
        "seed-proof-sha256",
        "final-proof-sha256",
    ):
        require_sha(receipt[field], f"sealed-export receipt {field}")
    require(
        isinstance(receipt["analyzer-version"], str)
        and receipt["analyzer-version"]
        and isinstance(receipt["dce-tool-version"], str)
        and receipt["dce-tool-version"]
        and "\n" not in receipt["dce-tool-version"],
        "sealed-export tool version identity differs",
    )

    policy_root = project_root / "runtime" / "policies"
    mandatory = policy_root / "sealed-main-runtime-exports.v1.txt"
    dlsym = policy_root / "sealed-main-dlsym-exports.v1.txt"
    side_manifest = policy_root / "sealed-side-modules.v1.tsv"
    require(
        receipt["mandatory-policy-sha256"] == tracked_hash(mandatory, "mandatory export policy")
        and receipt["declared-main-dlsym-policy-sha256"] == tracked_hash(dlsym, "dlsym export policy")
        and receipt["side-manifest-sha256"] == tracked_hash(side_manifest, "side-module manifest"),
        "sealed-export tracked policy identity differs",
    )
    side_paths = side_manifest_paths(side_manifest)

    seed = receipt["seed"]
    final_module = receipt["final-module"]
    require(isinstance(seed, dict) and set(seed) == SNAPSHOT_KEYS, "sealed-export seed snapshot fields differ")
    require(isinstance(final_module, dict) and set(final_module) == SNAPSHOT_KEYS, "sealed-export final snapshot fields differ")
    seed_sha = require_sha(seed["sha256"], "sealed-export seed module")
    final_sha = require_sha(final_module["sha256"], "sealed-export final module")
    require(
        source_module_hashes.get("bin/postgres") == final_sha,
        "sealed-export final module is not the linear-memory predecessor of bin/postgres",
    )

    sides = receipt["sides"]
    require(isinstance(sides, list) and len(sides) == len(side_paths), "sealed-export side count differs")
    expected_sides: list[dict[str, str]] = []
    for side, expected_path in zip(sides, side_paths, strict=True):
        require(isinstance(side, dict) and set(side) == SIDE_KEYS, "sealed-export side receipt fields differ")
        side_path = safe_relative(side["path"], "sealed-export side path")
        side_sha = require_sha(side["sha256"], f"sealed-export side {side_path}")
        require(side_path == expected_path, f"sealed-export side order/path differs: {expected_path}")
        require(
            source_module_hashes.get(side_path) == side_sha,
            f"sealed-export side is not the linear-memory predecessor: {side_path}",
        )
        expected_sides.append({"path": side_path, "sha256": side_sha})

    allowlist = read_regular(root, ALLOWLIST_RELATIVE, expected_identities)
    seed_proof_data = read_regular(root, SEED_PROOF_RELATIVE, expected_identities)
    final_proof_data = read_regular(root, FINAL_PROOF_RELATIVE, expected_identities)
    require(
        sha256(allowlist) == receipt["allowlist-sha256"]
        and sha256(seed_proof_data) == receipt["seed-proof-sha256"]
        and sha256(final_proof_data) == receipt["final-proof-sha256"],
        "sealed-export installed proof bytes differ from structural receipt",
    )
    seed_proof = parse_json(seed_proof_data, "sealed-export seed proof")
    final_proof = parse_json(final_proof_data, "sealed-export final proof")
    validate_proof(seed_proof, "sealed-export seed proof", receipt, seed_sha, expected_sides)
    validate_proof(final_proof, "sealed-export final proof", receipt, final_sha, expected_sides)
    return receipt


def linear_closure_hash(modules: list[dict[str, Any]], field: str) -> str:
    digest = hashlib.sha256()
    for value in (
        "oliphaunt.wasix-postmaster.linear-memory-install-closure.v1",
        field,
    ):
        encoded = value.encode()
        digest.update(len(encoded).to_bytes(8, "big"))
        digest.update(encoded)
    for module in modules:
        for value in (module["path"], module[field]):
            encoded = value.encode()
            digest.update(len(encoded).to_bytes(8, "big"))
            digest.update(encoded)
    return digest.hexdigest()


def linear_memory_descendant_source_hashes(root: Path) -> dict[str, str]:
    data = read_regular(root, LINEAR_RECEIPT_RELATIVE, None)
    receipt = parse_json(data, "linear-memory install receipt")
    require(set(receipt) == LINEAR_RECEIPT_KEYS, "linear-memory install receipt fields differ")
    require(
        receipt["schema"] == LINEAR_RECEIPT_SCHEMA
        and receipt["profile-id"] == LINEAR_PROFILE_ID
        and receipt["address-width"] == "wasm32"
        and receipt["supported-host-pointer-width"] == "u64"
        and receipt["maximum-pages"] == 4096
        and receipt["maximum-bytes"] == 268435456
        and receipt["static-bound-pages"] == 65536
        and receipt["static-offset-guard-bytes"] == 2147483648
        and receipt["static-access-lowering"]
        == "wasmer-llvm-unchecked-reservation-and-guard-v1"
        and receipt["requires-shared"] is True
        and receipt["requires-import"] == "env.memory"
        and receipt["excludes-wasm32-end-wrap"] is True,
        "linear-memory descendant profile differs",
    )
    require(
        receipt["predecessor-export-closure-receipt"] == RECEIPT_RELATIVE,
        "linear-memory descendant predecessor path differs",
    )
    predecessor = read_regular(root, RECEIPT_RELATIVE, None)
    require(
        sha256(predecessor)
        == receipt["predecessor-export-closure-receipt-sha256"],
        "linear-memory descendant predecessor digest differs",
    )
    modules = receipt["modules"]
    require(
        isinstance(modules, list)
        and type(receipt["module-count"]) is int
        and receipt["module-count"] == len(modules)
        and len(modules) > 0,
        "linear-memory descendant module count differs",
    )
    paths: list[str] = []
    source_hashes: dict[str, str] = {}
    for module in modules:
        require(isinstance(module, dict) and set(module) == LINEAR_MODULE_KEYS, "linear-memory descendant module fields differ")
        path = safe_relative(module["path"], "linear-memory descendant module path")
        source = require_sha(module["source-module-sha256"], f"linear-memory source {path}")
        sealed = require_sha(module["module-sha256"], f"linear-memory module {path}")
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
            f"linear-memory descendant module contract differs: {path}",
        )
        current = read_regular(root, path, None)
        require(sha256(current) == sealed, f"linear-memory descendant bytes differ: {path}")
        paths.append(path)
        require(path not in source_hashes, f"duplicate linear-memory descendant path: {path}")
        source_hashes[path] = source
    require(paths == sorted(paths), "linear-memory descendant modules are not path-sorted")
    require(
        linear_closure_hash(modules, "source-module-sha256")
        == receipt["source-module-closure-sha256"]
        and linear_closure_hash(modules, "module-sha256")
        == receipt["module-closure-sha256"],
        "linear-memory descendant closure digest differs",
    )
    return source_hashes


def main() -> int:
    import argparse

    parser = argparse.ArgumentParser()
    parser.add_argument("--install-root", type=Path, required=True)
    parser.add_argument("--project-root", type=Path, required=True)
    parser.add_argument("--allow-linear-memory-descendant", action="store_true")
    arguments = parser.parse_args()
    side_manifest = (
        arguments.project_root / "runtime" / "policies" / "sealed-side-modules.v1.tsv"
    )
    linear_receipt = arguments.install_root / LINEAR_RECEIPT_RELATIVE
    if arguments.allow_linear_memory_descendant and linear_receipt.is_file():
        source_hashes = linear_memory_descendant_source_hashes(arguments.install_root)
    else:
        paths = ["bin/postgres", *side_manifest_paths(side_manifest)]
        source_hashes = {
            relative: sha256(read_regular(arguments.install_root, relative, None))
            for relative in paths
        }
    validate_export_chain(
        arguments.install_root,
        arguments.project_root,
        source_hashes,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
