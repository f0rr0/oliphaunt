#!/usr/bin/env python3

"""Validate sealed Wasmer activation evidence for a release platform."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import secrets
import stat
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


SCHEMA = "oliphaunt.wasix-postmaster.sealed-loader-receipt.v2"
SUMMARY_SCHEMA = "oliphaunt.wasix-postmaster.attested-start-runtime-summary.v1"
MEMORY_IMAGE_SCHEMA = "oliphaunt.wasix-postmaster.memory-image.v2"
DETERMINISTIC_START_PROOF_SCHEMA = (
    "oliphaunt.wasix-postmaster.deterministic-start-proof.v1"
)
RESULT_SCHEMA = "oliphaunt.wasix-postmaster.sealed-loader-audit-validation.v4"
MAX_U64 = (1 << 64) - 1
SHA256_RE = re.compile(r"[0-9a-f]{64}\Z")
FIELDS = {
    "schema",
    "pid",
    "artifact_kind",
    "module_sha256",
    "snapshot_mode",
    "logical_bytes",
    "source_bytes_read",
    "source_bytes_written",
    "snapshot_bytes_written",
    "mapping_bytes_hashed",
    "sync_calls",
    "read_advice_applicable",
    "read_advice_supported",
    "read_advice_calls",
    "read_advice_successes",
    "read_advice_first_errno",
    "source_cache_eviction_applicable",
    "source_cache_eviction_supported",
    "source_cache_eviction_calls",
    "source_cache_eviction_successes",
    "source_cache_eviction_errno",
    "snapshot_cache_eviction_applicable",
    "snapshot_cache_eviction_supported",
    "snapshot_cache_eviction_calls",
    "snapshot_cache_eviction_successes",
    "snapshot_cache_eviction_errno",
    "mapping_cache_eviction_applicable",
    "mapping_cache_eviction_supported",
    "mapping_cache_eviction_calls",
    "mapping_cache_eviction_successes",
    "mapping_cache_eviction_errno",
    "residency_after_hash_inspect",
    "residency_after_archive_release",
    "source_residency_before_eviction",
    "source_residency_after_eviction",
    "residency_after_eviction",
    "write_policy",
}
SUMMARY_FIELDS = {
    "schema",
    "pid",
    "artifact_kind",
    "terminal",
    "module_sha256",
    "memory_image_schema",
    "proof_sha256",
    "proof_output_sha256",
    "mapped_size",
    "ordinary_start_completed_instances",
    "fresh_zeroed_instances",
    "nonfresh_instances",
    "validation_attempts",
    "full_compare_attempts",
    "full_compare_successes",
    "full_compare_failures",
    "compared_bytes",
    "reuse_successes",
    "reuse_failures",
    "skipped_bytes",
    "remap_successes",
    "remap_failures",
    "counter_overflow",
}
SUMMARY_COUNTER_FIELDS = (
    "ordinary_start_completed_instances",
    "fresh_zeroed_instances",
    "nonfresh_instances",
    "validation_attempts",
    "full_compare_attempts",
    "full_compare_successes",
    "full_compare_failures",
    "compared_bytes",
    "reuse_successes",
    "reuse_failures",
    "skipped_bytes",
    "remap_successes",
    "remap_failures",
)
RESIDENCY_FIELDS = {
    "state",
    "page_size",
    "total_pages",
    "resident_pages",
    "resident_bytes",
    "errno",
}
DIRECT_MODES = {"direct-immutable-inode", "direct-read-only-filesystem"}
PORTABLE_MODES = {
    "aot": "streamed-copy",
    "preinitialized-memory": "streamed-copy-sealed-backing",
}
SNAPSHOT_POLICIES = {"direct", "direct-immutable", "portable-copy"}
EXECUTABLE_NAMES = ("runtime:initdb", "runtime:postgres")


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


def read_regular(path: Path, label: str) -> bytes:
    try:
        return stable_regular_bytes(path)
    except PublicationError as error:
        raise ValidationError(f"invalid {label}: {error}") from error


def manifest_module_evidence(
    manifest_data: bytes,
) -> tuple[dict[str, str], dict[str, dict[str, Any]]]:
    try:
        manifest = json.loads(manifest_data.decode("utf-8"), object_pairs_hook=duplicate_keys)
    except (UnicodeDecodeError, json.JSONDecodeError, ValidationError) as error:
        raise ValidationError(f"invalid sealed manifest: {error}") from error
    require(isinstance(manifest, dict), "sealed manifest must be an object")
    artifacts = manifest.get("artifacts")
    require(
        isinstance(artifacts, list) and len(artifacts) >= len(EXECUTABLE_NAMES),
        "sealed manifest artifact closure is incomplete",
    )
    modules: dict[str, str] = {}
    for artifact in artifacts:
        require(isinstance(artifact, dict), "sealed manifest artifact must be an object")
        name = artifact.get("name")
        require(
            isinstance(name, str) and name.startswith("runtime:") and len(name) > 8,
            "sealed manifest artifact name is invalid",
        )
        module_hash = artifact.get("module-sha256")
        require(isinstance(module_hash, str) and SHA256_RE.fullmatch(module_hash), f"invalid module SHA-256 for {name}")
        require(name not in modules, f"duplicate manifest artifact: {name}")
        require(module_hash not in modules.values(), f"duplicate manifest module hash: {module_hash}")
        modules[name] = module_hash
    require(
        all(name in modules for name in EXECUTABLE_NAMES),
        "sealed manifest executable closure differs",
    )
    return modules, {}


def exact_nonnegative(value: Any, label: str) -> int:
    require(type(value) is int and value >= 0, f"{label} must be a nonnegative integer")
    return value


def exact_u64(value: Any, label: str) -> int:
    require(
        type(value) is int and 0 <= value <= MAX_U64,
        f"{label} must be an unsigned 64-bit integer",
    )
    return value


def exact_bool(value: Any, label: str) -> bool:
    require(type(value) is bool, f"{label} must be a boolean")
    return value


def validate_advice(
    record: dict[str, Any],
    *,
    prefix: str,
    errno_field: str,
    expected_applicable: bool,
    expected_calls: int,
    allow_unsupported: bool,
    line_number: int,
) -> tuple[int, int]:
    label = f"{prefix} line {line_number}"
    applicable = exact_bool(record[f"{prefix}_applicable"], f"{label} applicable")
    supported = exact_bool(record[f"{prefix}_supported"], f"{label} supported")
    calls = exact_nonnegative(record[f"{prefix}_calls"], f"{label} calls")
    successes = exact_nonnegative(record[f"{prefix}_successes"], f"{label} successes")
    errno = record[errno_field]
    require(applicable is expected_applicable, f"{label} applicability differs")
    require(successes <= calls, f"{label} successes exceed calls")
    if not applicable:
        require(calls == 0 and successes == 0 and errno is None, f"{label} issued an inapplicable call")
        return calls, successes
    if not supported:
        require(allow_unsupported, f"{label} is unsupported")
        require(
            calls == 0 and successes == 0 and errno is None,
            f"{label} unsupported shape differs",
        )
        return calls, successes
    require(calls == expected_calls, f"{label} call count differs")
    require(successes == calls, f"{label} advisory call failed")
    require(errno is None, f"{label} success unexpectedly carries errno")
    return calls, successes


def validate_residency(
    value: Any,
    *,
    label: str,
    logical_bytes: int,
    expected_states: set[str],
) -> int:
    require(isinstance(value, dict) and set(value) == RESIDENCY_FIELDS, f"{label} fields differ")
    state = value["state"]
    require(
        state in expected_states,
        f"{label} state differs: expected {sorted(expected_states)!r}, got {state!r}",
    )
    if state in {"not-applicable", "unsupported-platform"}:
        for field in RESIDENCY_FIELDS - {"state"}:
            require(value[field] is None, f"{label} not-applicable field {field} must be null")
        return 0

    page_size = exact_nonnegative(value["page_size"], f"{label} page_size")
    total_pages = exact_nonnegative(value["total_pages"], f"{label} total_pages")
    resident_pages = exact_nonnegative(value["resident_pages"], f"{label} resident_pages")
    resident_bytes = exact_nonnegative(value["resident_bytes"], f"{label} resident_bytes")
    require(value["errno"] is None, f"{label} measured checkpoint carries errno")
    require(page_size >= 512 and page_size & (page_size - 1) == 0, f"{label} page_size is invalid")
    expected_pages = (logical_bytes + page_size - 1) // page_size
    require(total_pages == expected_pages, f"{label} total_pages differs")
    require(resident_pages <= total_pages, f"{label} resident_pages exceed total_pages")
    if resident_pages == 0:
        possible_bytes = {0}
    else:
        tail_bytes = logical_bytes - (total_pages - 1) * page_size
        possible_bytes = {
            min(logical_bytes, resident_pages * page_size),
            (resident_pages - 1) * page_size + tail_bytes,
        }
    require(resident_bytes in possible_bytes, f"{label} resident byte/page accounting differs")
    return resident_bytes


def parse_audit(
    data: bytes,
    *,
    snapshot_policy: str = "direct",
) -> tuple[list[tuple[int, dict[str, Any]]], list[tuple[int, dict[str, Any]]]]:
    require(snapshot_policy in SNAPSHOT_POLICIES, "unknown snapshot policy")
    portable = snapshot_policy == "portable-copy"
    require(data and data.endswith(b"\n"), "sealed loader audit must be nonempty and newline-terminated")
    require(b"\r" not in data, "sealed loader audit contains a carriage return")
    records: list[tuple[int, dict[str, Any]]] = []
    summaries: list[tuple[int, dict[str, Any]]] = []
    for line_number, raw in enumerate(data.splitlines(), 1):
        try:
            record = json.loads(raw.decode("utf-8"), object_pairs_hook=duplicate_keys)
        except (UnicodeDecodeError, json.JSONDecodeError, ValidationError) as error:
            raise ValidationError(f"invalid audit JSON on line {line_number}: {error}") from error
        require(isinstance(record, dict), f"audit record must be an object on line {line_number}")
        schema = record.get("schema")
        require(isinstance(schema, str), f"audit schema is missing on line {line_number}")
        require(schema == SCHEMA, f"unknown audit schema on line {line_number}: {schema!r}")
        require(set(record) == FIELDS, f"loader audit fields differ on line {line_number}")
        require(type(record["pid"]) is int and record["pid"] > 0, f"invalid audit pid on line {line_number}")
        require(record["artifact_kind"] == "aot", f"invalid artifact kind on line {line_number}")
        require(isinstance(record["module_sha256"], str) and SHA256_RE.fullmatch(record["module_sha256"]), f"invalid module SHA-256 on line {line_number}")
        if portable:
            expected_mode = PORTABLE_MODES[record["artifact_kind"]]
            require(
                record["snapshot_mode"] == expected_mode,
                f"snapshot mode differs from portable-copy policy on line {line_number}",
            )
        else:
            require(record["snapshot_mode"] in DIRECT_MODES, f"non-direct snapshot mode on line {line_number}")
            if snapshot_policy == "direct-immutable":
                require(
                    record["snapshot_mode"] == "direct-immutable-inode",
                    f"snapshot mode differs from direct-immutable policy on line {line_number}",
                )
        logical = exact_nonnegative(record["logical_bytes"], f"logical_bytes line {line_number}")
        require(logical > 0, f"logical_bytes must be positive on line {line_number}")
        source_read = exact_nonnegative(record["source_bytes_read"], f"source_bytes_read line {line_number}")
        if portable:
            require(source_read == logical, f"source_bytes_read differs from portable-copy contract on line {line_number}")
        else:
            require(source_read in (0, logical), f"source_bytes_read differs from direct-mode contract on line {line_number}")
        require(exact_nonnegative(record["source_bytes_written"], f"source_bytes_written line {line_number}") == 0, f"source bytes were written on line {line_number}")
        expected_snapshot_writes = logical if portable else 0
        require(
            exact_nonnegative(record["snapshot_bytes_written"], f"snapshot_bytes_written line {line_number}") == expected_snapshot_writes,
            f"snapshot byte accounting differs on line {line_number}",
        )
        require(exact_nonnegative(record["mapping_bytes_hashed"], f"mapping_bytes_hashed line {line_number}") == logical, f"mapping hash coverage differs on line {line_number}")
        require(exact_nonnegative(record["sync_calls"], f"sync_calls line {line_number}") == 0, f"loader issued sync calls on line {line_number}")
        validate_advice(
            record,
            prefix="read_advice",
            errno_field="read_advice_first_errno",
            expected_applicable=True,
            expected_calls=2,
            allow_unsupported=portable,
            line_number=line_number,
        )
        validate_advice(
            record,
            prefix="source_cache_eviction",
            errno_field="source_cache_eviction_errno",
            expected_applicable=True,
            expected_calls=1,
            allow_unsupported=portable,
            line_number=line_number,
        )
        validate_advice(
            record,
            prefix="snapshot_cache_eviction",
            errno_field="snapshot_cache_eviction_errno",
            expected_applicable=portable and record["artifact_kind"] == "aot",
            expected_calls=1,
            allow_unsupported=portable,
            line_number=line_number,
        )
        validate_advice(
            record,
            prefix="mapping_cache_eviction",
            errno_field="mapping_cache_eviction_errno",
            expected_applicable=False,
            expected_calls=1,
            allow_unsupported=portable,
            line_number=line_number,
        )
        validate_residency(
            record["residency_after_hash_inspect"],
            label=f"residency_after_hash_inspect line {line_number}",
            logical_bytes=logical,
            expected_states={"unsupported-platform"} if portable else {"measured"},
        )
        validate_residency(
            record["residency_after_archive_release"],
            label=f"residency_after_archive_release line {line_number}",
            logical_bytes=logical,
            expected_states=(
                {"unsupported-platform"}
                if portable and record["artifact_kind"] == "aot"
                else {"measured"}
                if record["artifact_kind"] == "aot"
                else {"not-applicable"}
            ),
        )
        validate_residency(
            record["source_residency_before_eviction"],
            label=f"source_residency_before_eviction line {line_number}",
            logical_bytes=logical,
            expected_states={"unsupported-platform"} if portable else {"measured"},
        )
        validate_residency(
            record["source_residency_after_eviction"],
            label=f"source_residency_after_eviction line {line_number}",
            logical_bytes=logical,
            expected_states={"unsupported-platform"} if portable else {"measured"},
        )
        validate_residency(
            record["residency_after_eviction"],
            label=f"residency_after_eviction line {line_number}",
            logical_bytes=logical,
            expected_states={"unsupported-platform"} if portable else {"measured"},
        )
        expected_write_policy = (
            "private-streamed-copy-no-sync"
            if portable and record["artifact_kind"] == "aot"
            else "private-sealed-backing-no-sync"
            if portable
            else "none-immutable-source"
        )
        require(record["write_policy"] == expected_write_policy, f"write policy differs on line {line_number}")
        records.append((line_number, record))
    require(records, "sealed loader audit contains no loader receipts")
    return records, summaries


def validate_attested_start_summary(
    record: dict[str, Any],
    expected: dict[str, Any],
    *,
    line_number: int,
) -> None:
    label = f"attested-start summary line {line_number}"
    for field in (
        "memory_image_schema",
        "proof_sha256",
        "proof_output_sha256",
        "mapped_size",
    ):
        require(record[field] == expected[field], f"{label} {field} differs from sealed manifest")

    require(not record["counter_overflow"], f"{label} reports counter overflow")
    ordinary_starts = record["ordinary_start_completed_instances"]
    fresh_instances = record["fresh_zeroed_instances"]
    nonfresh_instances = record["nonfresh_instances"]
    validations = record["validation_attempts"]
    compare_attempts = record["full_compare_attempts"]
    compare_successes = record["full_compare_successes"]
    compare_failures = record["full_compare_failures"]
    reuse_successes = record["reuse_successes"]
    reuse_failures = record["reuse_failures"]
    remap_successes = record["remap_successes"]
    remap_failures = record["remap_failures"]
    mapped_size = record["mapped_size"]

    require(ordinary_starts > 0, f"{label} has no ordinary start completions")
    require(
        ordinary_starts == fresh_instances + nonfresh_instances,
        f"{label} ordinary-start/fresh-memory conservation differs",
    )
    require(nonfresh_instances == 0, f"{label} observed a non-fresh memory instance")
    require(
        validations == ordinary_starts,
        f"{label} ordinary-start/validation conservation differs",
    )
    require(
        compare_attempts == compare_successes + compare_failures,
        f"{label} full-compare conservation differs",
    )
    require(
        validations == compare_attempts + reuse_successes + reuse_failures,
        f"{label} validation compare/reuse conservation differs",
    )
    require(compare_attempts == 1, f"{label} did not perform exactly one full comparison")
    require(compare_failures == 0, f"{label} reports a full comparison failure")
    require(compare_successes == 1, f"{label} did not complete the first full comparison")
    require(reuse_failures == 0, f"{label} reports a cached-validation failure")
    require(
        reuse_successes == ordinary_starts - 1,
        f"{label} validation reuse count differs",
    )

    expected_compared_bytes = mapped_size * compare_successes
    expected_skipped_bytes = mapped_size * reuse_successes
    require(
        expected_compared_bytes <= MAX_U64 and expected_skipped_bytes <= MAX_U64,
        f"{label} byte-accounting product overflows u64",
    )
    require(
        record["compared_bytes"] == expected_compared_bytes,
        f"{label} compared byte accounting differs",
    )
    require(
        record["skipped_bytes"] == expected_skipped_bytes,
        f"{label} skipped byte accounting differs",
    )

    successful_validations = compare_successes + reuse_successes
    require(
        remap_successes + remap_failures == successful_validations,
        f"{label} validation/remap conservation differs",
    )
    require(remap_failures == 0, f"{label} reports a memory-image remap failure")
    require(
        remap_successes == ordinary_starts,
        f"{label} successful remap count differs from ordinary starts",
    )


def validate(
    audit: Path,
    manifest: Path,
    output: Path,
    *,
    snapshot_policy: str = "direct",
    expected_initdb_executions: int = 1,
    expected_postgres_executions: int = 1,
) -> None:
    require(not os.path.lexists(output), f"validation output already exists: {output}")
    require(snapshot_policy in SNAPSHOT_POLICIES, "unknown snapshot policy")
    require(expected_initdb_executions > 0, "expected initdb executions must be positive")
    require(expected_postgres_executions > 0, "expected postgres executions must be positive")
    audit_data = read_regular(audit, "sealed loader audit")
    manifest_data = read_regular(manifest, "sealed manifest")
    validator_data = read_regular(Path(__file__), "validator")
    manifest_modules, manifest_attested_memory = manifest_module_evidence(manifest_data)
    expected = {name: manifest_modules[name] for name in EXECUTABLE_NAMES}
    parsed_records, parsed_summaries = parse_audit(
        audit_data,
        snapshot_policy=snapshot_policy,
    )
    records = [record for _, record in parsed_records]
    summaries = [record for _, record in parsed_summaries]
    allowed_module_hashes = set(manifest_modules.values())
    for line_number, record in parsed_records:
        require(
            record["module_sha256"] in allowed_module_hashes,
            f"audit module SHA-256 is not in sealed manifest on line {line_number}",
        )
    by_key: dict[tuple[str, str], list[dict[str, Any]]] = {}
    for record in records:
        by_key.setdefault((record["module_sha256"], record["artifact_kind"]), []).append(record)
    # An outer initdb invocation necessarily execs the sealed postgres module
    # for bootstrap/single-user initialization in the same native executor
    # process.  The loader receipt records module activations, not merely outer
    # CLI invocations, so a valid initdb+postmaster lifecycle contains one
    # postgres activation on every initdb pid plus one on every outer postgres
    # pid.  Classify the outer invocation by the presence of the initdb module;
    # the product CLI admits only these two outer executables.  This preserves
    # exact population accounting without misreporting bootstrap activations as
    # additional postmasters.
    activation_pids: dict[str, set[int]] = {}
    for name, module_hash in expected.items():
        aot = by_key.get((module_hash, "aot"), [])
        aot_pids = [record["pid"] for record in aot]
        require(len(set(aot_pids)) == len(aot_pids), f"{name} AOT audit pids are not unique")
        activation_pids[name] = set(aot_pids)

    initdb_pids = activation_pids["runtime:initdb"]
    postgres_activation_pids = activation_pids["runtime:postgres"]
    require(
        len(initdb_pids) == expected_initdb_executions,
        f"runtime:initdb must have exactly {expected_initdb_executions} outer execution pids",
    )
    require(
        initdb_pids <= postgres_activation_pids,
        "every initdb execution must activate bootstrap postgres on the same pid",
    )
    outer_postgres_pids = postgres_activation_pids - initdb_pids
    require(
        len(outer_postgres_pids) == expected_postgres_executions,
        f"runtime:postgres must have exactly {expected_postgres_executions} outer execution pids",
    )
    expected_postgres_activations = expected_initdb_executions + expected_postgres_executions
    require(
        len(postgres_activation_pids) == expected_postgres_activations,
        "runtime:postgres activation population differs from initdb bootstrap plus outer executions",
    )

    executable_pids = {
        "runtime:initdb": sorted(initdb_pids),
        "runtime:postgres": sorted(outer_postgres_pids),
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    audit_sha = hashlib.sha256(audit_data).hexdigest()
    manifest_sha = hashlib.sha256(manifest_data).hexdigest()
    validator_sha = hashlib.sha256(validator_data).hexdigest()
    summary_totals = {
        field: sum(summary[field] for summary in summaries)
        for field in SUMMARY_COUNTER_FIELDS
    }
    overflow_summaries = sum(summary["counter_overflow"] for summary in summaries)
    read_calls = sum(record["read_advice_calls"] for record in records)
    read_successes = sum(record["read_advice_successes"] for record in records)
    source_eviction_calls = sum(
        record["source_cache_eviction_calls"] for record in records
    )
    source_eviction_successes = sum(
        record["source_cache_eviction_successes"] for record in records
    )
    snapshot_eviction_calls = sum(
        record["snapshot_cache_eviction_calls"] for record in records
    )
    snapshot_eviction_successes = sum(
        record["snapshot_cache_eviction_successes"] for record in records
    )
    mapping_eviction_calls = sum(
        record["mapping_cache_eviction_calls"] for record in records
    )
    mapping_eviction_successes = sum(
        record["mapping_cache_eviction_successes"] for record in records
    )
    hash_resident_bytes = sum(
        record["residency_after_hash_inspect"]["resident_bytes"] or 0
        for record in records
    )
    archive_resident_bytes = sum(
        record["residency_after_archive_release"]["resident_bytes"] or 0
        for record in records
    )
    source_before_eviction_bytes = sum(
        record["source_residency_before_eviction"]["resident_bytes"] or 0
        for record in records
    )
    source_after_eviction_bytes = sum(
        record["source_residency_after_eviction"]["resident_bytes"] or 0
        for record in records
    )
    eviction_resident_bytes = sum(
        record["residency_after_eviction"]["resident_bytes"] or 0
        for record in records
    )
    payload = (
        "schema_version\tstatus\trecords\taot_records\tmemory_records\t"
        "initdb_executions\tpostgres_executions\tinitdb_pids\tpostgres_pids\t"
        "snapshot_policy\taudit_sha256\tmanifest_sha256\tvalidator_sha256\t"
        "read_advice_calls\tread_advice_successes\tsource_cache_eviction_calls\t"
        "source_cache_eviction_successes\tsnapshot_cache_eviction_calls\t"
        "snapshot_cache_eviction_successes\tmapping_cache_eviction_calls\t"
        "mapping_cache_eviction_successes\tresidency_after_hash_inspect_bytes\t"
        "residency_after_archive_release_bytes\tsource_residency_before_eviction_bytes\t"
        "source_residency_after_eviction_bytes\tresidency_after_eviction_bytes\t"
        "attested_summary_records\t"
        + "\t".join(SUMMARY_COUNTER_FIELDS)
        + "\tcounter_overflow_records\n"
        + f"{RESULT_SCHEMA}\tpassed\t{len(records)}\t"
        f"{sum(record['artifact_kind'] == 'aot' for record in records)}\t"
        f"{sum(record['artifact_kind'] == 'preinitialized-memory' for record in records)}\t"
        f"{expected_initdb_executions}\t{expected_postgres_executions}\t"
        f"{','.join(str(pid) for pid in executable_pids['runtime:initdb'])}\t"
        f"{','.join(str(pid) for pid in executable_pids['runtime:postgres'])}\t"
        f"{snapshot_policy}\t"
        f"{audit_sha}\t{manifest_sha}\t{validator_sha}\t"
        f"{read_calls}\t{read_successes}\t"
        f"{source_eviction_calls}\t{source_eviction_successes}\t"
        f"{snapshot_eviction_calls}\t{snapshot_eviction_successes}\t"
        f"{mapping_eviction_calls}\t{mapping_eviction_successes}\t"
        f"{hash_resident_bytes}\t{archive_resident_bytes}\t"
        f"{source_before_eviction_bytes}\t{source_after_eviction_bytes}\t"
        f"{eviction_resident_bytes}\t{len(summaries)}\t"
        + "\t".join(str(summary_totals[field]) for field in SUMMARY_COUNTER_FIELDS)
        + f"\t{overflow_summaries}\n"
    ).encode("utf-8")
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
    parser.add_argument("--audit", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--snapshot-policy", choices=sorted(SNAPSHOT_POLICIES), default="direct")
    parser.add_argument("--expected-initdb-executions", type=int, default=1)
    parser.add_argument("--expected-postgres-executions", type=int, default=1)
    arguments = parser.parse_args(argv)
    try:
        validate(
            arguments.audit,
            arguments.manifest,
            arguments.output,
            snapshot_policy=arguments.snapshot_policy,
            expected_initdb_executions=arguments.expected_initdb_executions,
            expected_postgres_executions=arguments.expected_postgres_executions,
        )
        return 0
    except (OSError, PublicationError, ValidationError) as error:
        print(f"sealed loader audit validation failed: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
