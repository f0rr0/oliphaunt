#!/usr/bin/env python3

"""Validate one exact observe-only file-cache telemetry snapshot."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import secrets
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))
from durable_publication import (  # noqa: E402
    PublicationError,
    PublicationSource,
    publish_identified,
    remove_private,
    stable_regular_bytes,
    write_bytes,
)


SCHEMA = "oliphaunt.wasix-postmaster.file-cache-telemetry.v2"
RESULT_SCHEMA = "oliphaunt.wasix-postmaster.file-cache-telemetry-validation.v2"
POLICY_ID = "oliphaunt.wasix-postmaster.file-cache.observe-only.v1"
ABI_MODULE = "oliphaunt_postmaster_v1"
ABI_FUNCTION = "fd_cache_offer"
ABI_SIGNATURE = "(i32,i64,i64,i32,i32)->i32_errno"
SHA256_RE = re.compile(r"[0-9a-f]{64}\Z")
TOP_LEVEL_FIELDS = {
    "schema",
    "policy-id",
    "policy-mode",
    "workload-id",
    "runtime-abi-id",
    "abi-module",
    "abi-function",
    "abi-signature",
    "classes",
    "validation",
}
CLASS_FIELDS = {
    "class",
    "name",
    "disposition",
    "calls",
    "finite-bytes",
    "through-eof-calls",
    "reclaim-eligible-calls",
    "reclaim-eligible-finite-bytes",
    "reclaim-eligible-through-eof-calls",
}
VALIDATION_FIELDS = {
    "valid",
    "invalid-range",
    "invalid-class",
    "invalid-flags",
    "bad-descriptor",
    "missing-rights",
    "non-regular",
    "non-host-backed",
    "state-fault",
    "controller-error",
}
CLASSES = (
    (1, "relation-read-normal"),
    (2, "relation-read-bulk"),
    (3, "relation-read-vacuum"),
    (4, "relation-sync-checkpoint"),
    (5, "relation-sync-immediate"),
    (6, "wal-inactive-durable"),
)


class ValidationError(Exception):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValidationError(message)


def duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        require(key not in result, f"duplicate JSON field: {key}")
        result[key] = value
    return result


def read_regular_stable(path: Path, label: str) -> bytes:
    try:
        return stable_regular_bytes(path)
    except PublicationError as error:
        raise ValidationError(f"invalid {label}: {error}") from error


def parse_object(data: bytes, label: str) -> dict[str, Any]:
    try:
        value = json.loads(data.decode("utf-8"), object_pairs_hook=duplicate_keys)
    except (UnicodeDecodeError, json.JSONDecodeError, ValidationError) as error:
        raise ValidationError(f"invalid {label}: {error}") from error
    require(isinstance(value, dict), f"{label} must be a JSON object")
    return value


def exact_nonnegative(value: Any, label: str) -> int:
    require(type(value) is int and value >= 0, f"{label} must be a nonnegative integer")
    require(value <= (1 << 64) - 1, f"{label} exceeds u64")
    return value


def manifest_runtime_abi_id(manifest: dict[str, Any]) -> str:
    value = manifest.get("runtime-abi-id")
    require(
        isinstance(value, str) and SHA256_RE.fullmatch(value) is not None,
        "sealed manifest runtime-abi-id is invalid",
    )
    return value


def validate(
    telemetry_path: Path,
    manifest_path: Path,
    output: Path,
    expected_workload: str,
) -> None:
    require(
        expected_workload in ("runtime:initdb", "runtime:postgres"),
        "expected workload is not a sealed product executable",
    )
    require(not os.path.lexists(output), f"validation output already exists: {output}")
    telemetry_data = read_regular_stable(telemetry_path, "file-cache telemetry")
    manifest_data = read_regular_stable(manifest_path, "sealed manifest")
    validator_data = read_regular_stable(Path(__file__), "validator")
    telemetry = parse_object(telemetry_data, "file-cache telemetry JSON")
    manifest = parse_object(manifest_data, "sealed manifest JSON")
    require(set(telemetry) == TOP_LEVEL_FIELDS, "file-cache telemetry fields differ")
    expected_scalars = {
        "schema": SCHEMA,
        "policy-id": POLICY_ID,
        "policy-mode": "observe-only",
        "workload-id": expected_workload,
        "runtime-abi-id": manifest_runtime_abi_id(manifest),
        "abi-module": ABI_MODULE,
        "abi-function": ABI_FUNCTION,
        "abi-signature": ABI_SIGNATURE,
    }
    for field, expected in expected_scalars.items():
        require(
            telemetry[field] == expected,
            f"file-cache telemetry {field} differs: expected {expected!r}, got {telemetry[field]!r}",
        )

    classes = telemetry["classes"]
    require(isinstance(classes, list) and len(classes) == len(CLASSES), "cache class closure differs")
    total_calls = 0
    total_finite_bytes = 0
    total_through_eof_calls = 0
    wal_reclaim_eligible_calls = 0
    wal_reclaim_eligible_finite_bytes = 0
    wal_reclaim_eligible_through_eof_calls = 0
    for index, ((class_id, name), record) in enumerate(zip(CLASSES, classes, strict=True)):
        require(isinstance(record, dict) and set(record) == CLASS_FIELDS, f"cache class {index} fields differ")
        require(type(record["class"]) is int and record["class"] == class_id, f"cache class {index} id differs")
        require(record["name"] == name, f"cache class {class_id} name differs")
        require(record["disposition"] == "retain", f"cache class {class_id} did not retain")
        total_calls += exact_nonnegative(record["calls"], f"cache class {class_id} calls")
        total_finite_bytes += exact_nonnegative(
            record["finite-bytes"], f"cache class {class_id} finite bytes"
        )
        total_through_eof_calls += exact_nonnegative(
            record["through-eof-calls"], f"cache class {class_id} through-EOF calls"
        )
        reclaim_eligible_calls = exact_nonnegative(
            record["reclaim-eligible-calls"],
            f"cache class {class_id} reclaim-eligible calls",
        )
        reclaim_eligible_finite_bytes = exact_nonnegative(
            record["reclaim-eligible-finite-bytes"],
            f"cache class {class_id} reclaim-eligible finite bytes",
        )
        reclaim_eligible_through_eof_calls = exact_nonnegative(
            record["reclaim-eligible-through-eof-calls"],
            f"cache class {class_id} reclaim-eligible through-EOF calls",
        )
        require(
            reclaim_eligible_calls <= record["calls"],
            f"cache class {class_id} reclaim-eligible calls exceed calls",
        )
        require(
            reclaim_eligible_finite_bytes <= record["finite-bytes"],
            f"cache class {class_id} reclaim-eligible finite bytes exceed finite bytes",
        )
        require(
            reclaim_eligible_through_eof_calls <= record["through-eof-calls"],
            f"cache class {class_id} reclaim-eligible through-EOF calls exceed through-EOF calls",
        )
        require(
            reclaim_eligible_through_eof_calls <= reclaim_eligible_calls,
            f"cache class {class_id} reclaim-eligible dimensions disagree",
        )
        if class_id != 6:
            require(
                reclaim_eligible_calls == 0
                and reclaim_eligible_finite_bytes == 0
                and reclaim_eligible_through_eof_calls == 0,
                f"non-WAL cache class {class_id} carried WAL reclaim eligibility",
            )
        else:
            wal_reclaim_eligible_calls = reclaim_eligible_calls
            wal_reclaim_eligible_finite_bytes = reclaim_eligible_finite_bytes
            wal_reclaim_eligible_through_eof_calls = reclaim_eligible_through_eof_calls

    validation = telemetry["validation"]
    require(
        isinstance(validation, dict) and set(validation) == VALIDATION_FIELDS,
        "file-cache validation fields differ",
    )
    validation_counts = {
        field: exact_nonnegative(value, f"validation {field}")
        for field, value in validation.items()
    }
    require(validation_counts["valid"] == total_calls, "valid offer and class call counts differ")
    for field in VALIDATION_FIELDS - {"valid"}:
        require(validation_counts[field] == 0, f"validated product emitted {field} cache offers")

    payload = (
        "schema_version\tstatus\tworkload_id\tpolicy_id\truntime_abi_id\t"
        "valid_calls\tfinite_bytes\tthrough_eof_calls\t"
        "wal_reclaim_eligible_calls\twal_reclaim_eligible_finite_bytes\t"
        "wal_reclaim_eligible_through_eof_calls\ttelemetry_sha256\t"
        "manifest_sha256\tvalidator_sha256\n"
        f"{RESULT_SCHEMA}\tpassed\t{expected_workload}\t{POLICY_ID}\t"
        f"{expected_scalars['runtime-abi-id']}\t{total_calls}\t{total_finite_bytes}\t"
        f"{total_through_eof_calls}\t{wal_reclaim_eligible_calls}\t"
        f"{wal_reclaim_eligible_finite_bytes}\t"
        f"{wal_reclaim_eligible_through_eof_calls}\t"
        f"{hashlib.sha256(telemetry_data).hexdigest()}\t"
        f"{hashlib.sha256(manifest_data).hexdigest()}\t"
        f"{hashlib.sha256(validator_data).hexdigest()}\n"
    ).encode("utf-8")
    output.parent.mkdir(parents=True, exist_ok=True)
    pending = output.with_name(
        f".{output.name}.pending.{os.getpid()}.{secrets.token_hex(16)}"
    )
    pending_identity: PublicationSource | None = None
    try:
        pending_identity = write_bytes(pending, payload)
        publish_identified(pending, output, pending_identity)
    finally:
        if pending_identity is not None:
            remove_private(pending, pending_identity)


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--telemetry", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument(
        "--expected-workload",
        choices=("runtime:initdb", "runtime:postgres"),
        required=True,
    )
    arguments = parser.parse_args(argv)
    try:
        validate(
            arguments.telemetry,
            arguments.manifest,
            arguments.output,
            arguments.expected_workload,
        )
        return 0
    except (OSError, PublicationError, ValidationError) as error:
        print(f"file-cache telemetry validation failed: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
