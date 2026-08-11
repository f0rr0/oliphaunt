#!/usr/bin/env python3

from __future__ import annotations

import argparse
import csv
from dataclasses import dataclass
import hashlib
import os
from pathlib import Path
import re
import stat
import sys
from typing import Iterable


RUNTIME_CONTEXT = "wasix-runtime-context-v1"
RUNTIME_STATE = "wasix-runtime-state-v1"
RUNTIME_FENCE = "wasix-runtime-fence-v1"
HARNESS_PHASE = "wasix-runtime-phase-v1"
HARNESS_STABILIZATION = "wasix-runtime-stabilization-v1"
HARNESS_RECONNECT_CHURN = "wasix-runtime-reconnect-churn-v1"
PHASE_ORDER = (
    "cold-readiness",
    "maintenance-stabilization",
    "readiness",
    "reconnect-churn",
    "post-quiescence",
    "complete",
)
FENCE_PHASE_ORDER = ("readiness", "post-quiescence")
WAIT_KINDS = (
    "wait-registry.epoll_wait.pending",
    "wait-registry.futex_wait.pending",
)
CONTEXT_FIELDS = ("seq", "wait_kind", "observer_pid", "observer_tid")
STATE_FIELDS = (
    "seq",
    "mono_ns",
    "registered_processes",
    "active_tasks",
    "process_topology_nodes",
    "process_child_edges",
    "process_thread_entries",
    "process_live_threads",
    "process_pending_child_publications",
    "process_execution_leases",
    "process_quiescence_wakers",
    "process_retiring_nodes",
    "runtime_state_active",
    "runtime_state_stale",
    "runtime_state_slots",
    "runtime_state_observer_registered",
    "private_futexes",
    "private_futex_waiters",
    "private_futex_wakers",
    "shared_futexes",
    "shared_futex_waiters",
    "shared_futex_wakers",
    "epoll_states",
    "epoll_subscriptions",
    "epoll_ready_items",
    "epoll_pending_subscriptions",
    "epoll_enqueued_subscriptions",
    "epoll_join_guards",
    "epoll_close_registrations",
    "shared_registry_active",
    "shared_registry_stale",
    "shared_registry_slots",
    "shared_mappings",
    "guest_fd_entries",
)
PHASE_FIELDS = ("nonce", "seq", "mono_ns", "phase", "observer_pid")
FENCE_FIELDS = (
    "nonce",
    "seq",
    "mono_ns",
    "phase",
    "observer_pid",
    "observer_tid",
    "request_seq",
)
STABILIZATION_FIELDS = (
    "nonce",
    "method",
    "before_writes",
    "after_writes",
    "before_write_bytes",
    "after_write_bytes",
    "before_stats_reset",
    "after_stats_reset",
    "target_lsn",
    "observed_flush_lsn",
    "wal_writer_delay_ms",
    "start_mono_ns",
    "end_mono_ns",
    "status",
    "observer_pid",
)
RECONNECT_CHURN_FIELDS = (
    "nonce",
    "requested",
    "completed",
    "command_sha256",
    "client_sha256",
    "connection_sha256",
    "start_mono_ns",
    "end_mono_ns",
    "status",
    "observer_pid",
)
RECONNECT_COMMAND_CONTRACT = (
    b"oliphaunt.wasix-postmaster.lifecycle-reconnect.v1\0"
    b"PGCONNECT_TIMEOUT=5\0psql\0-X\0-qAt\0-v\0ON_ERROR_STOP=1\0-c\0select 1\0"
)
RECONNECT_COMMAND_SHA256 = hashlib.sha256(RECONNECT_COMMAND_CONTRACT).hexdigest()
COUNT_FIELDS = STATE_FIELDS[2:]
OUTPUT_FIELDS = (
    "schema_version",
    "target",
    "status",
    "detail",
    "claim_scope",
    "baseline_assumption",
    "baseline_policy_id",
    "baseline_policy_status",
    "baseline_policy_sha256",
    "baseline_binding_sha256",
    "nonce",
    "observer_pid",
    "freeze_receipt_sha256",
    "evidence_sha256",
    "commit_ack_sha256",
    "fence_end_offset",
    "wait_kind",
    "min_samples",
    "min_span_ns",
    "expected_interval_ms",
    "max_sample_gap_ns",
    "cold_readiness_phase_mono_ns",
    "maintenance_stabilization_phase_mono_ns",
    "readiness_phase_mono_ns",
    "stabilization_method",
    "stabilization_before_writes",
    "stabilization_after_writes",
    "stabilization_before_write_bytes",
    "stabilization_after_write_bytes",
    "stabilization_stats_reset",
    "stabilization_target_lsn",
    "stabilization_observed_flush_lsn",
    "stabilization_wal_writer_delay_ms",
    "stabilization_start_mono_ns",
    "stabilization_end_mono_ns",
    "stabilization_elapsed_ns",
    "reconnect_requested",
    "reconnect_completed",
    "reconnect_command_sha256",
    "reconnect_client_sha256",
    "reconnect_connection_sha256",
    "reconnect_start_mono_ns",
    "reconnect_end_mono_ns",
    "reconnect_elapsed_ns",
    "readiness_fence_sequence",
    "readiness_fence_mono_ns",
    "post_quiescence_fence_sequence",
    "post_quiescence_fence_mono_ns",
    "readiness_samples",
    "readiness_span_ns",
    "readiness_max_gap_ns",
    "post_quiescence_samples",
    "post_quiescence_span_ns",
    "post_quiescence_max_gap_ns",
    "cold_readiness_samples",
    "cold_readiness_span_ns",
    "cold_readiness_max_gap_ns",
    "cold_readiness_observer_pids",
    "readiness_observer_pids",
    "post_quiescence_observer_pids",
    *(
        output_field
        for field in COUNT_FIELDS
        for output_field in (
            f"cold_readiness_{field}",
            f"readiness_{field}",
            f"post_quiescence_{field}",
        )
    ),
)
NONCE_RE = re.compile(r"^[0-9a-f]{32}$")
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
U64_MAX = (1 << 64) - 1
FREEZE_RECEIPT_FIELDS = (
    "schema_version",
    "raw_log",
    "raw_observed_size",
    "commit_ack",
    "commit_ack_sha256",
    "fence_end_offset",
    "frozen_log",
    "frozen_size",
    "sha256",
    "nonce",
    "observer_pid",
    "fence_sequence",
    "fence_mono_ns",
    "complete_phase_sequence",
    "complete_phase_mono_ns",
)
COMMIT_ACK_FIELDS = (
    "nonce",
    "seq",
    "mono_ns",
    "phase",
    "observer_pid",
    "observer_tid",
    "request_seq",
    "fence_end_offset",
)
BASELINE_POLICY_FIELDS = (
    "schema_version",
    "policy_id",
    "policy_status",
    "claim_scope",
    "baseline_assumption",
    "field",
    "rule",
    "minimum",
    "maximum",
)
BASELINE_BINDING_FIELDS = (
    "schema_version",
    "policy_id",
    "policy_sha256",
    "policy_status",
    "claim_scope",
    "baseline_assumption",
    "postgres_major",
    "runtime_footprint",
    "runtime_footprint_sha256",
    "durability_profile",
    "durability_profile_sha256",
    "postgres_profile_resolution_identity",
    "runtime_mode",
    "wasmer_bin_sha256",
    "postgres_module_sha256",
    "carrier_manifest_sha256",
    "carrier_receipt_sha256",
    "carrier_payload_inventory_sha256",
)
CLAIM_SCOPE = "relative-to-stabilized-baseline"
BASELINE_ASSUMPTION = (
    "readiness-is-stabilized-idle-postmaster-state;"
    "absolute-pss-budget-governs-legitimate-baseline-size"
)


class EvidenceError(ValueError):
    pass


@dataclass(frozen=True)
class RuntimeContext:
    sequence: int
    wait_kind: str
    observer_pid: int
    observer_tid: int


@dataclass(frozen=True)
class RuntimeSample:
    sequence: int
    mono_ns: int
    wait_kind: str
    observer_pid: int
    observer_tid: int
    phase: str | None
    counts: tuple[int, ...]


@dataclass(frozen=True)
class StablePlateau:
    samples: int
    span_ns: int
    max_gap_ns: int
    first_mono_ns: int
    last_mono_ns: int
    observer_pids: tuple[int, ...]
    counts: tuple[int, ...]


@dataclass(frozen=True)
class HarnessPhase:
    sequence: int
    mono_ns: int
    phase: str
    observer_pid: int


@dataclass(frozen=True)
class WalWriterStabilization:
    method: str
    before_writes: int
    after_writes: int
    before_write_bytes: int
    after_write_bytes: int
    stats_reset: int
    target_lsn: str
    observed_flush_lsn: str
    wal_writer_delay_ms: int
    start_mono_ns: int
    end_mono_ns: int
    observer_pid: int

    @property
    def elapsed_ns(self) -> int:
        return self.end_mono_ns - self.start_mono_ns


@dataclass(frozen=True)
class ReconnectChurn:
    requested: int
    completed: int
    command_sha256: str
    client_sha256: str
    connection_sha256: str
    start_mono_ns: int
    end_mono_ns: int
    observer_pid: int

    @property
    def elapsed_ns(self) -> int:
        return self.end_mono_ns - self.start_mono_ns


@dataclass(frozen=True)
class RuntimeFence:
    phase: str
    request_sequence: int
    sample: RuntimeSample


@dataclass(frozen=True)
class LifecycleEvidence:
    samples: list[RuntimeSample]
    fences: dict[str, RuntimeFence]
    phases: dict[str, HarnessPhase]
    stabilization: WalWriterStabilization
    reconnect_churn: ReconnectChurn


@dataclass(frozen=True)
class FreezeBinding:
    receipt_sha256: str
    evidence_sha256: str
    commit_ack_sha256: str
    fence_end_offset: int
    fence_sequence: int
    fence_mono_ns: int


@dataclass(frozen=True)
class BaselineConstraint:
    field: str
    rule: str
    minimum: int
    maximum: int


@dataclass(frozen=True)
class BaselinePolicy:
    policy_id: str
    policy_status: str
    claim_scope: str
    baseline_assumption: str
    sha256: str
    constraints: tuple[BaselineConstraint, ...]


@dataclass(frozen=True)
class BaselineBinding:
    sha256: str
    policy: BaselinePolicy


@dataclass(frozen=True)
class LifecycleValidationOutcome:
    row: dict[str, str | int]
    error: str | None

    @property
    def passed(self) -> bool:
        return self.error is None


def regular_file_identity(metadata: os.stat_result) -> tuple[int, ...]:
    return (
        metadata.st_dev,
        metadata.st_ino,
        metadata.st_mode,
        metadata.st_uid,
        metadata.st_gid,
        metadata.st_nlink,
        metadata.st_size,
        metadata.st_mtime_ns,
        metadata.st_ctime_ns,
    )


def read_regular_file(path: Path) -> bytes:
    before = os.lstat(path)
    if stat.S_ISLNK(before.st_mode) or not stat.S_ISREG(before.st_mode):
        raise EvidenceError(f"evidence input is not a regular non-symlink file: {path}")
    fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    try:
        opened = os.fstat(fd)
        before_identity = regular_file_identity(before)
        opened_identity = regular_file_identity(opened)
        if not stat.S_ISREG(opened.st_mode) or opened_identity != before_identity:
            raise EvidenceError(f"evidence input changed while opening: {path}")

        def read_all() -> bytes:
            chunks: list[bytes] = []
            while True:
                chunk = os.read(fd, 1024 * 1024)
                if not chunk:
                    break
                chunks.append(chunk)
            return b"".join(chunks)

        payload = read_all()
        middle = os.fstat(fd)
        middle_identity = regular_file_identity(middle)
        if middle_identity != opened_identity or len(payload) != opened.st_size:
            raise EvidenceError(f"evidence input changed while reading: {path}")

        # Metadata catches ordinary in-place writes, including same-size ones.
        # A second byte-for-byte read also closes filesystems whose timestamp
        # granularity is too coarse to expose a concurrent rewrite.
        os.lseek(fd, 0, os.SEEK_SET)
        confirmed = read_all()
        after = os.fstat(fd)
        after_identity = regular_file_identity(after)
        if after_identity != opened_identity or confirmed != payload:
            raise EvidenceError(f"evidence input changed while confirming read: {path}")
        current = os.lstat(path)
        if stat.S_ISLNK(current.st_mode) or regular_file_identity(current) != opened_identity:
            raise EvidenceError(f"evidence input pathname changed while reading: {path}")
        return payload
    finally:
        os.close(fd)


def parse_ordered_record(line: str, prefix: str, fields: tuple[str, ...], line_no: int) -> dict[str, str]:
    parts = line.rstrip("\n").split("\t")
    if len(parts) != len(fields) + 1 or parts[0] != prefix:
        raise EvidenceError(f"line {line_no}: malformed {prefix} record")
    parsed: dict[str, str] = {}
    for token, field in zip(parts[1:], fields, strict=True):
        expected = f"{field}="
        if not token.startswith(expected) or token == expected:
            raise EvidenceError(f"line {line_no}: expected ordered field {field}")
        parsed[field] = token[len(expected):]
    return parsed


def parse_uint(value: str, field: str, line_no: int, *, positive: bool = False) -> int:
    if not value.isascii() or not value.isdecimal():
        raise EvidenceError(f"line {line_no}: {field} must be an unsigned decimal integer")
    parsed = int(value)
    if parsed > (1 << 64) - 1 or (positive and parsed == 0):
        qualifier = "positive " if positive else ""
        raise EvidenceError(f"line {line_no}: {field} must be a {qualifier}u64")
    return parsed


def parse_pg_lsn(value: str, field: str, line_no: int) -> int:
    if not re.fullmatch(r"[0-9A-F]+/[0-9A-F]+", value):
        raise EvidenceError(f"line {line_no}: {field} must be a canonical PostgreSQL LSN")
    high_text, low_text = value.split("/", 1)
    high = int(high_text, 16)
    low = int(low_text, 16)
    if high > 0xFFFFFFFF or low > 0xFFFFFFFF:
        raise EvidenceError(f"line {line_no}: {field} exceeds the PostgreSQL LSN range")
    return (high << 32) | low


def parse_exact_tsv_record(
    line: str, prefix: str, fields: tuple[str, ...], description: str
) -> dict[str, str]:
    parts = line.split("\t")
    if len(parts) != len(fields) + 1 or parts[0] != prefix:
        raise EvidenceError(f"malformed {description} record")
    values: dict[str, str] = {}
    for token, field in zip(parts[1:], fields, strict=True):
        expected = f"{field}="
        if not token.startswith(expected) or token == expected:
            raise EvidenceError(f"{description} expected ordered field {field}")
        values[field] = token[len(expected):]
    return values


def parse_baseline_policy(path: Path) -> BaselinePolicy:
    raw = read_regular_file(path)
    if not raw.endswith(b"\n"):
        raise EvidenceError("lifecycle baseline policy must be newline terminated")
    text = raw.decode("utf-8", errors="strict")
    lines = text[:-1].split("\n")
    if not lines or tuple(lines[0].split("\t")) != BASELINE_POLICY_FIELDS:
        raise EvidenceError("lifecycle baseline policy has an unexpected ordered schema")
    if len(lines) != len(COUNT_FIELDS) + 1:
        raise EvidenceError("lifecycle baseline policy must contain one row per state field")

    metadata: tuple[str, str, str, str] | None = None
    constraints: list[BaselineConstraint] = []
    for line_no, line in enumerate(lines[1:], 2):
        values = line.split("\t")
        if len(values) != len(BASELINE_POLICY_FIELDS) or any(value == "" for value in values):
            raise EvidenceError(f"baseline policy line {line_no} does not match its schema")
        row = dict(zip(BASELINE_POLICY_FIELDS, values, strict=True))
        if row["schema_version"] != "oliphaunt.wasix-postmaster.lifecycle-baseline-policy.v1":
            raise EvidenceError("lifecycle baseline policy schema version is unsupported")
        row_metadata = (
            row["policy_id"],
            row["policy_status"],
            row["claim_scope"],
            row["baseline_assumption"],
        )
        if metadata is None:
            metadata = row_metadata
        elif row_metadata != metadata:
            raise EvidenceError("lifecycle baseline policy metadata changes between fields")
        expected_field = COUNT_FIELDS[len(constraints)]
        if row["field"] != expected_field:
            raise EvidenceError(
                f"baseline policy line {line_no} expected ordered field {expected_field}"
            )
        if row["rule"] not in ("exact", "relative-equal"):
            raise EvidenceError(f"baseline policy line {line_no} has an unsupported rule")
        minimum = parse_uint(row["minimum"], "minimum", line_no)
        maximum = parse_uint(row["maximum"], "maximum", line_no)
        if minimum > maximum:
            raise EvidenceError(f"baseline policy line {line_no} has minimum above maximum")
        if row["rule"] == "exact" and minimum != maximum:
            raise EvidenceError(f"baseline policy line {line_no} exact bounds differ")
        constraints.append(
            BaselineConstraint(row["field"], row["rule"], minimum, maximum)
        )
    assert metadata is not None
    policy_id, policy_status, claim_scope, baseline_assumption = metadata
    if policy_status not in ("exploratory-unbounded", "qualification-bounded"):
        raise EvidenceError(
            "lifecycle baseline policy status must be exploratory-unbounded or qualification-bounded"
        )
    if claim_scope != CLAIM_SCOPE:
        raise EvidenceError("lifecycle baseline policy must use the relative claim scope")
    if baseline_assumption != BASELINE_ASSUMPTION:
        raise EvidenceError(
            "lifecycle baseline policy must state the stabilized-baseline assumption"
        )
    if policy_status == "qualification-bounded":
        if not re.fullmatch(
            r"pg18-idle-postmaster-stabilized-qualified-v[1-9][0-9]*", policy_id
        ):
            raise EvidenceError(
                "qualification baseline must use a distinct qualified policy ID"
            )
        for constraint in constraints:
            if constraint.rule != "exact" or constraint.minimum != constraint.maximum:
                raise EvidenceError(
                    "qualification baseline must freeze the exact exploratory "
                    f"observation for {constraint.field}"
                )
    elif not re.fullmatch(
        r"pg18-idle-postmaster-stabilized-exploratory-v[1-9][0-9]*", policy_id
    ):
        raise EvidenceError("exploratory baseline must use an idle-postmaster policy ID")

    required_exact = {
        "process_pending_child_publications": 0,
        "process_quiescence_wakers": 0,
        "process_retiring_nodes": 0,
        "runtime_state_stale": 0,
        "runtime_state_observer_registered": 1,
        "shared_registry_stale": 0,
    }
    for constraint in constraints:
        if constraint.field in required_exact and (
            constraint.rule != "exact"
            or constraint.minimum != required_exact[constraint.field]
            or constraint.maximum != required_exact[constraint.field]
        ):
            raise EvidenceError(
                f"baseline policy weakens unconditional {constraint.field} ownership"
            )
    return BaselinePolicy(
        policy_id=policy_id,
        policy_status=policy_status,
        claim_scope=claim_scope,
        baseline_assumption=baseline_assumption,
        sha256=hashlib.sha256(raw).hexdigest(),
        constraints=tuple(constraints),
    )


def parse_baseline_binding(path: Path, policy: BaselinePolicy) -> BaselineBinding:
    raw = read_regular_file(path)
    if not raw.endswith(b"\n") or raw.count(b"\n") != 2:
        raise EvidenceError("baseline binding must contain exactly two newline-terminated rows")
    header, record, _ = raw.decode("utf-8", errors="strict").split("\n")
    if tuple(header.split("\t")) != BASELINE_BINDING_FIELDS:
        raise EvidenceError("baseline binding has an unexpected ordered schema")
    values = record.split("\t")
    if len(values) != len(BASELINE_BINDING_FIELDS) or any(value == "" for value in values):
        raise EvidenceError("baseline binding row does not match its schema")
    row = dict(zip(BASELINE_BINDING_FIELDS, values, strict=True))
    for field, value in row.items():
        if any(ord(character) < 0x20 or ord(character) == 0x7F for character in value):
            raise EvidenceError(f"baseline binding {field} contains a control character")
    if row["schema_version"] != "oliphaunt.wasix-postmaster.lifecycle-baseline-binding.v1":
        raise EvidenceError("baseline binding schema version is unsupported")
    for field, expected in (
        ("policy_id", policy.policy_id),
        ("policy_sha256", policy.sha256),
        ("policy_status", policy.policy_status),
        ("claim_scope", policy.claim_scope),
        ("baseline_assumption", policy.baseline_assumption),
    ):
        if row[field] != expected:
            raise EvidenceError(f"baseline binding {field} does not match its policy")
    if row["postgres_major"] != "18":
        raise EvidenceError("baseline binding is not for PostgreSQL major 18")
    if row["runtime_footprint"] not in ("none", "embedded-concurrent"):
        raise EvidenceError("baseline binding runtime footprint is unsupported")
    if row["durability_profile"] not in ("none", "safe"):
        raise EvidenceError("baseline binding durability profile is unsupported")
    if row["runtime_mode"] not in ("compiler", "sealed-headless"):
        raise EvidenceError("baseline binding runtime mode is unsupported")
    required_hashes = ("wasmer_bin_sha256", "postgres_module_sha256")
    optional_hashes = (
        "runtime_footprint_sha256",
        "durability_profile_sha256",
        "postgres_profile_resolution_identity",
        "carrier_manifest_sha256",
        "carrier_receipt_sha256",
        "carrier_payload_inventory_sha256",
    )
    for field in required_hashes:
        if not re.fullmatch(r"[0-9a-f]{64}", row[field]):
            raise EvidenceError(f"baseline binding {field} is not a SHA-256")
    for field in optional_hashes:
        if row[field] != "none" and not re.fullmatch(r"[0-9a-f]{64}", row[field]):
            raise EvidenceError(f"baseline binding {field} is neither none nor a SHA-256")
    for id_field, hash_field in (
        ("runtime_footprint", "runtime_footprint_sha256"),
        ("durability_profile", "durability_profile_sha256"),
    ):
        if (row[id_field] == "none") != (row[hash_field] == "none"):
            raise EvidenceError(
                f"baseline binding {id_field} and {hash_field} presence differs"
            )
    profiles_named = (
        row["runtime_footprint"] != "none" or row["durability_profile"] != "none"
    )
    if profiles_named != (row["postgres_profile_resolution_identity"] != "none"):
        raise EvidenceError(
            "baseline binding profile IDs and resolution identity presence differs"
        )
    carrier_fields = (
        row["carrier_manifest_sha256"],
        row["carrier_receipt_sha256"],
        row["carrier_payload_inventory_sha256"],
    )
    if row["runtime_mode"] == "sealed-headless" and "none" in carrier_fields:
        raise EvidenceError("sealed baseline binding is missing a carrier identity")
    if row["runtime_mode"] == "compiler" and carrier_fields != ("none", "none", "none"):
        raise EvidenceError("compiler baseline binding unexpectedly names a sealed carrier")
    return BaselineBinding(sha256=hashlib.sha256(raw).hexdigest(), policy=policy)


def enforce_baseline_policy(
    policy: BaselinePolicy,
    readiness: StablePlateau,
    final: StablePlateau,
) -> None:
    for index, constraint in enumerate(policy.constraints):
        readiness_value = readiness.counts[index]
        final_value = final.counts[index]
        if not constraint.minimum <= readiness_value <= constraint.maximum:
            raise EvidenceError(
                f"readiness {constraint.field}={readiness_value} is outside baseline policy "
                f"[{constraint.minimum},{constraint.maximum}]"
            )
        if not constraint.minimum <= final_value <= constraint.maximum:
            raise EvidenceError(
                f"post-quiescence {constraint.field}={final_value} is outside baseline policy "
                f"[{constraint.minimum},{constraint.maximum}]"
            )
        if constraint.rule == "exact" and readiness_value != constraint.minimum:
            raise EvidenceError(
                f"baseline policy requires {constraint.field}={constraint.minimum}"
            )
        if constraint.rule == "relative-equal" and readiness_value != final_value:
            raise EvidenceError(
                f"baseline policy requires equal readiness/post-quiescence {constraint.field}"
            )


def validate_freeze_binding(
    receipt_path: Path,
    log_path: Path,
    frozen: bytes,
    nonce: str,
    observer_pid: int,
) -> FreezeBinding:
    receipt_raw = read_regular_file(receipt_path)
    if not receipt_raw.endswith(b"\n") or receipt_raw.count(b"\n") != 2:
        raise EvidenceError("freeze receipt must contain exactly two newline-terminated rows")
    receipt_text = receipt_raw.decode("utf-8", errors="strict")
    header, record, _ = receipt_text.split("\n")
    if tuple(header.split("\t")) != FREEZE_RECEIPT_FIELDS:
        raise EvidenceError("freeze receipt has an unexpected ordered schema")
    values = record.split("\t")
    if len(values) != len(FREEZE_RECEIPT_FIELDS):
        raise EvidenceError("freeze receipt row does not match its schema")
    row = dict(zip(FREEZE_RECEIPT_FIELDS, values, strict=True))
    if row["schema_version"] != "oliphaunt.wasix-postmaster.lifecycle-freeze.v2":
        raise EvidenceError("freeze receipt schema version is unsupported")
    if Path(row["frozen_log"]).resolve() != log_path.resolve():
        raise EvidenceError("freeze receipt names a different frozen lifecycle log")
    if row["nonce"] != nonce:
        raise EvidenceError("freeze receipt nonce does not match the lifecycle nonce")
    receipt_pid = parse_uint(row["observer_pid"], "observer_pid", 2, positive=True)
    if receipt_pid != observer_pid:
        raise EvidenceError("freeze receipt observer PID does not match the postmaster")

    frozen_size = parse_uint(row["frozen_size"], "frozen_size", 2, positive=True)
    if frozen_size != len(frozen):
        raise EvidenceError("freeze receipt size does not match the frozen lifecycle log")
    evidence_sha256 = hashlib.sha256(frozen).hexdigest()
    if not re.fullmatch(r"[0-9a-f]{64}", row["sha256"]):
        raise EvidenceError("freeze receipt lifecycle SHA-256 is malformed")
    if row["sha256"] != evidence_sha256:
        raise EvidenceError("freeze receipt SHA-256 does not match the frozen lifecycle log")

    ack_path = Path(row["commit_ack"])
    ack_raw = read_regular_file(ack_path)
    ack_sha256 = hashlib.sha256(ack_raw).hexdigest()
    if not re.fullmatch(r"[0-9a-f]{64}", row["commit_ack_sha256"]):
        raise EvidenceError("freeze receipt committed-ACK SHA-256 is malformed")
    if row["commit_ack_sha256"] != ack_sha256:
        raise EvidenceError("freeze receipt SHA-256 does not match the committed ACK")
    if not ack_raw.endswith(b"\n") or ack_raw.count(b"\n") != 1:
        raise EvidenceError("committed ACK must contain exactly one newline-terminated record")
    ack_text = ack_raw[:-1].decode("ascii", errors="strict")
    ack = parse_exact_tsv_record(
        ack_text,
        "wasix-runtime-fence-commit-v1",
        COMMIT_ACK_FIELDS,
        "committed ACK",
    )
    if ack["nonce"] != nonce or ack["phase"] != "post-quiescence":
        raise EvidenceError("committed ACK does not identify the final lifecycle fence")
    ack_pid = parse_uint(ack["observer_pid"], "observer_pid", 1, positive=True)
    ack_tid = parse_uint(ack["observer_tid"], "observer_tid", 1, positive=True)
    request_sequence = parse_uint(ack["request_seq"], "request_seq", 1, positive=True)
    if ack_pid != observer_pid or ack_tid == 0 or request_sequence != 2:
        raise EvidenceError("committed ACK has a foreign lifecycle identity")

    fence_sequence = parse_uint(row["fence_sequence"], "fence_sequence", 2, positive=True)
    fence_mono_ns = parse_uint(row["fence_mono_ns"], "fence_mono_ns", 2, positive=True)
    fence_end_offset = parse_uint(
        row["fence_end_offset"], "fence_end_offset", 2, positive=True
    )
    if (
        parse_uint(ack["seq"], "seq", 1, positive=True) != fence_sequence
        or parse_uint(ack["mono_ns"], "mono_ns", 1, positive=True) != fence_mono_ns
        or parse_uint(ack["fence_end_offset"], "fence_end_offset", 1, positive=True)
        != fence_end_offset
    ):
        raise EvidenceError("freeze receipt and committed ACK fence coordinates differ")
    if fence_end_offset >= len(frozen):
        raise EvidenceError("freeze receipt fence offset does not precede the closing marker")
    fence = (
        "wasix-runtime-fence-v1"
        f"\tnonce={nonce}\tseq={fence_sequence}\tmono_ns={fence_mono_ns}"
        f"\tphase=post-quiescence\tobserver_pid={observer_pid}"
        f"\tobserver_tid={ack_tid}\trequest_seq=2\n"
    ).encode("ascii")
    if not frozen[:fence_end_offset].endswith(fence):
        raise EvidenceError("freeze receipt offset does not end at its committed runtime fence")
    complete_sequence = parse_uint(
        row["complete_phase_sequence"], "complete_phase_sequence", 2, positive=True
    )
    complete_mono_ns = parse_uint(
        row["complete_phase_mono_ns"], "complete_phase_mono_ns", 2, positive=True
    )
    complete = (
        "wasix-runtime-phase-v1"
        f"\tnonce={nonce}\tseq={complete_sequence}\tmono_ns={complete_mono_ns}"
        f"\tphase=complete\tobserver_pid={observer_pid}\n"
    ).encode("ascii")
    if frozen[fence_end_offset:] != complete:
        raise EvidenceError("frozen lifecycle suffix is not the receipt-bound complete marker")
    return FreezeBinding(
        receipt_sha256=hashlib.sha256(receipt_raw).hexdigest(),
        evidence_sha256=evidence_sha256,
        commit_ack_sha256=ack_sha256,
        fence_end_offset=fence_end_offset,
        fence_sequence=fence_sequence,
        fence_mono_ns=fence_mono_ns,
    )


def parse_evidence(lines: Iterable[str], nonce: str, observer_pid: int) -> LifecycleEvidence:
    phase_index = -1
    active_phase: str | None = None
    pending_context: RuntimeContext | None = None
    last_runtime_sequence: int | None = None
    last_runtime_mono_ns: int | None = None
    last_phase_sequence = 0
    last_phase_mono_ns: int | None = None
    samples: list[RuntimeSample] = []
    fences: dict[str, RuntimeFence] = {}
    phases: dict[str, HarnessPhase] = {}
    stabilization: WalWriterStabilization | None = None
    reconnect_churn: ReconnectChurn | None = None
    last_complete_sample: RuntimeSample | None = None
    final_cutoff_reached = False

    for line_no, line in enumerate(lines, 1):
        if line.startswith(HARNESS_PHASE + "\t"):
            if pending_context is not None:
                raise EvidenceError(f"line {line_no}: phase marker split a runtime record")
            record = parse_ordered_record(line, HARNESS_PHASE, PHASE_FIELDS, line_no)
            if record["nonce"] != nonce:
                raise EvidenceError(f"line {line_no}: foreign lifecycle nonce")
            sequence = parse_uint(record["seq"], "seq", line_no, positive=True)
            mono_ns = parse_uint(record["mono_ns"], "mono_ns", line_no, positive=True)
            marker_pid = parse_uint(record["observer_pid"], "observer_pid", line_no, positive=True)
            if sequence != last_phase_sequence + 1:
                raise EvidenceError(f"line {line_no}: nonconsecutive harness phase sequence")
            if last_phase_mono_ns is not None and mono_ns <= last_phase_mono_ns:
                raise EvidenceError(f"line {line_no}: nonmonotonic harness phase timestamp")
            if marker_pid != observer_pid:
                raise EvidenceError(f"line {line_no}: observer PID changed")
            phase_index += 1
            if phase_index >= len(PHASE_ORDER) or record["phase"] != PHASE_ORDER[phase_index]:
                raise EvidenceError(f"line {line_no}: unexpected lifecycle phase order")
            phase = record["phase"]
            if phase == "reconnect-churn" and "readiness" not in fences:
                raise EvidenceError(f"line {line_no}: readiness phase has no writer fence")
            if phase == "complete" and "post-quiescence" not in fences:
                raise EvidenceError(f"line {line_no}: post-quiescence phase has no writer fence")
            last_phase_sequence = sequence
            last_phase_mono_ns = mono_ns
            phases[phase] = HarnessPhase(
                sequence=sequence,
                mono_ns=mono_ns,
                phase=phase,
                observer_pid=marker_pid,
            )
            active_phase = phase
            last_complete_sample = None
            if active_phase == "complete":
                break
            continue

        if line.startswith(HARNESS_STABILIZATION + "\t"):
            if pending_context is not None:
                raise EvidenceError(
                    f"line {line_no}: stabilization record split a runtime record"
                )
            if active_phase != "maintenance-stabilization":
                raise EvidenceError(
                    f"line {line_no}: stabilization record is outside its phase"
                )
            if stabilization is not None:
                raise EvidenceError(f"line {line_no}: duplicate stabilization record")
            record = parse_ordered_record(
                line, HARNESS_STABILIZATION, STABILIZATION_FIELDS, line_no
            )
            if record["nonce"] != nonce:
                raise EvidenceError(f"line {line_no}: foreign stabilization nonce")
            if record["method"] != "pg_log_standby_snapshot":
                raise EvidenceError(f"line {line_no}: unsupported stabilization method")
            if record["status"] != "passed":
                raise EvidenceError(f"line {line_no}: stabilization status is not passed")
            before_writes = parse_uint(record["before_writes"], "before_writes", line_no)
            after_writes = parse_uint(record["after_writes"], "after_writes", line_no)
            before_write_bytes = parse_uint(
                record["before_write_bytes"], "before_write_bytes", line_no
            )
            after_write_bytes = parse_uint(
                record["after_write_bytes"], "after_write_bytes", line_no
            )
            if after_writes <= before_writes:
                raise EvidenceError(
                    f"line {line_no}: WAL writer write count did not increase"
                )
            if after_write_bytes <= before_write_bytes:
                raise EvidenceError(
                    f"line {line_no}: WAL writer byte count did not increase"
                )
            before_stats_reset = parse_uint(
                record["before_stats_reset"], "before_stats_reset", line_no, positive=True
            )
            after_stats_reset = parse_uint(
                record["after_stats_reset"], "after_stats_reset", line_no, positive=True
            )
            if before_stats_reset != after_stats_reset:
                raise EvidenceError(
                    f"line {line_no}: pg_stat_io stats_reset changed during stabilization"
                )
            target_lsn = parse_pg_lsn(record["target_lsn"], "target_lsn", line_no)
            observed_flush_lsn = parse_pg_lsn(
                record["observed_flush_lsn"], "observed_flush_lsn", line_no
            )
            if target_lsn == 0:
                raise EvidenceError(f"line {line_no}: target LSN is zero")
            if observed_flush_lsn < target_lsn:
                raise EvidenceError(
                    f"line {line_no}: observed flush LSN is behind the target LSN"
                )
            start_mono_ns = parse_uint(
                record["start_mono_ns"], "start_mono_ns", line_no, positive=True
            )
            end_mono_ns = parse_uint(
                record["end_mono_ns"], "end_mono_ns", line_no, positive=True
            )
            if end_mono_ns <= start_mono_ns:
                raise EvidenceError(
                    f"line {line_no}: stabilization timestamps are not increasing"
                )
            stabilization_pid = parse_uint(
                record["observer_pid"], "observer_pid", line_no, positive=True
            )
            if stabilization_pid != observer_pid:
                raise EvidenceError(f"line {line_no}: observer PID changed")
            stabilization = WalWriterStabilization(
                method=record["method"],
                before_writes=before_writes,
                after_writes=after_writes,
                before_write_bytes=before_write_bytes,
                after_write_bytes=after_write_bytes,
                stats_reset=before_stats_reset,
                target_lsn=record["target_lsn"],
                observed_flush_lsn=record["observed_flush_lsn"],
                wal_writer_delay_ms=parse_uint(
                    record["wal_writer_delay_ms"],
                    "wal_writer_delay_ms",
                    line_no,
                    positive=True,
                ),
                start_mono_ns=start_mono_ns,
                end_mono_ns=end_mono_ns,
                observer_pid=stabilization_pid,
            )
            last_complete_sample = None
            continue

        if line.startswith(HARNESS_RECONNECT_CHURN + "\t"):
            if pending_context is not None:
                raise EvidenceError(
                    f"line {line_no}: reconnect record split a runtime record"
                )
            if active_phase != "reconnect-churn":
                raise EvidenceError(
                    f"line {line_no}: reconnect record is outside its phase"
                )
            if reconnect_churn is not None:
                raise EvidenceError(f"line {line_no}: duplicate reconnect record")
            record = parse_ordered_record(
                line, HARNESS_RECONNECT_CHURN, RECONNECT_CHURN_FIELDS, line_no
            )
            if record["nonce"] != nonce:
                raise EvidenceError(f"line {line_no}: foreign reconnect nonce")
            requested = parse_uint(
                record["requested"], "requested", line_no, positive=True
            )
            completed = parse_uint(
                record["completed"], "completed", line_no, positive=True
            )
            if completed != requested:
                raise EvidenceError(
                    f"line {line_no}: reconnect completion count differs from requested"
                )
            if record["command_sha256"] != RECONNECT_COMMAND_SHA256:
                raise EvidenceError(
                    f"line {line_no}: reconnect command contract is not canonical"
                )
            for field in ("client_sha256", "connection_sha256"):
                if not SHA256_RE.fullmatch(record[field]):
                    raise EvidenceError(
                        f"line {line_no}: reconnect {field} is not a SHA-256"
                    )
            start_mono_ns = parse_uint(
                record["start_mono_ns"], "start_mono_ns", line_no, positive=True
            )
            end_mono_ns = parse_uint(
                record["end_mono_ns"], "end_mono_ns", line_no, positive=True
            )
            if end_mono_ns <= start_mono_ns:
                raise EvidenceError(
                    f"line {line_no}: reconnect timestamps are not increasing"
                )
            if record["status"] != "passed":
                raise EvidenceError(f"line {line_no}: reconnect status is not passed")
            reconnect_pid = parse_uint(
                record["observer_pid"], "observer_pid", line_no, positive=True
            )
            if reconnect_pid != observer_pid:
                raise EvidenceError(f"line {line_no}: observer PID changed")
            reconnect_churn = ReconnectChurn(
                requested=requested,
                completed=completed,
                command_sha256=record["command_sha256"],
                client_sha256=record["client_sha256"],
                connection_sha256=record["connection_sha256"],
                start_mono_ns=start_mono_ns,
                end_mono_ns=end_mono_ns,
                observer_pid=reconnect_pid,
            )
            last_complete_sample = None
            continue

        # The post-quiescence writer acknowledgement is the exact runtime
        # cutoff. Runtime output may continue while the server remains alive,
        # but it cannot extend or repair the acknowledged evidence window.
        if final_cutoff_reached:
            continue

        if line.startswith(RUNTIME_CONTEXT + "\t"):
            last_complete_sample = None
            if pending_context is not None:
                raise EvidenceError(f"line {line_no}: runtime context missing its state record")
            record = parse_ordered_record(line, RUNTIME_CONTEXT, CONTEXT_FIELDS, line_no)
            sequence = parse_uint(record["seq"], "seq", line_no, positive=True)
            expected_sequence = 1 if last_runtime_sequence is None else last_runtime_sequence + 1
            if sequence != expected_sequence:
                raise EvidenceError(
                    f"line {line_no}: runtime sequence must start at 1 and remain consecutive"
                )
            wait_kind = record["wait_kind"]
            if wait_kind not in WAIT_KINDS:
                raise EvidenceError(f"line {line_no}: unknown wait kind {wait_kind}")
            pending_context = RuntimeContext(
                sequence=sequence,
                wait_kind=wait_kind,
                observer_pid=parse_uint(record["observer_pid"], "observer_pid", line_no, positive=True),
                observer_tid=parse_uint(record["observer_tid"], "observer_tid", line_no, positive=True),
            )
            continue

        if line.startswith(RUNTIME_STATE + "\t"):
            if pending_context is None:
                raise EvidenceError(f"line {line_no}: runtime state has no context")
            record = parse_ordered_record(line, RUNTIME_STATE, STATE_FIELDS, line_no)
            sequence = parse_uint(record["seq"], "seq", line_no, positive=True)
            mono_ns = parse_uint(record["mono_ns"], "mono_ns", line_no, positive=True)
            if sequence != pending_context.sequence:
                raise EvidenceError(f"line {line_no}: runtime context/state sequence mismatch")
            expected_sequence = 1 if last_runtime_sequence is None else last_runtime_sequence + 1
            if sequence != expected_sequence:
                raise EvidenceError(
                    f"line {line_no}: runtime sequence must start at 1 and remain consecutive"
                )
            if last_runtime_mono_ns is not None and mono_ns <= last_runtime_mono_ns:
                raise EvidenceError(f"line {line_no}: nonmonotonic runtime timestamp")
            counts = tuple(parse_uint(record[field], field, line_no) for field in COUNT_FIELDS)
            sample = RuntimeSample(
                sequence=sequence,
                mono_ns=mono_ns,
                wait_kind=pending_context.wait_kind,
                observer_pid=pending_context.observer_pid,
                observer_tid=pending_context.observer_tid,
                phase=active_phase,
                counts=counts,
            )
            samples.append(sample)
            pending_context = None
            last_runtime_sequence = sequence
            last_runtime_mono_ns = mono_ns
            last_complete_sample = sample
            continue

        if line.startswith(RUNTIME_FENCE + "\t"):
            if pending_context is not None:
                raise EvidenceError(f"line {line_no}: writer fence split a runtime record")
            if last_complete_sample is None:
                raise EvidenceError(
                    f"line {line_no}: writer fence must immediately follow its context/state pair"
                )
            record = parse_ordered_record(line, RUNTIME_FENCE, FENCE_FIELDS, line_no)
            if record["nonce"] != nonce:
                raise EvidenceError(f"line {line_no}: foreign writer-fence nonce")
            phase = record["phase"]
            request_sequence = parse_uint(
                record["request_seq"], "request_seq", line_no, positive=True
            )
            fence_index = len(fences)
            if (
                fence_index >= len(FENCE_PHASE_ORDER)
                or phase != FENCE_PHASE_ORDER[fence_index]
                or request_sequence != fence_index + 1
            ):
                raise EvidenceError(f"line {line_no}: unexpected writer-fence order")
            if phase != active_phase:
                raise EvidenceError(f"line {line_no}: writer fence does not close the active phase")
            fence_sequence = parse_uint(record["seq"], "seq", line_no, positive=True)
            fence_mono_ns = parse_uint(record["mono_ns"], "mono_ns", line_no, positive=True)
            fence_pid = parse_uint(record["observer_pid"], "observer_pid", line_no, positive=True)
            fence_tid = parse_uint(record["observer_tid"], "observer_tid", line_no, positive=True)
            sample = last_complete_sample
            if (
                fence_sequence != sample.sequence
                or fence_mono_ns != sample.mono_ns
                or fence_pid != sample.observer_pid
                or fence_tid != sample.observer_tid
            ):
                raise EvidenceError(
                    f"line {line_no}: writer fence does not reference the immediately preceding sample"
                )
            if fence_pid != observer_pid:
                raise EvidenceError(f"line {line_no}: writer fence came from a foreign observer")
            fences[phase] = RuntimeFence(
                phase=phase,
                request_sequence=request_sequence,
                sample=sample,
            )
            active_phase = None
            last_complete_sample = None
            if phase == "post-quiescence":
                final_cutoff_reached = True
            continue

        if line.startswith("wasix-runtime-"):
            raise EvidenceError(f"line {line_no}: unknown or malformed lifecycle record")
        last_complete_sample = None

    if pending_context is not None:
        raise EvidenceError("truncated runtime context/state record")
    if phase_index != len(PHASE_ORDER) - 1 or active_phase != "complete":
        raise EvidenceError("incomplete lifecycle phase sequence")
    if tuple(fences) != FENCE_PHASE_ORDER:
        raise EvidenceError("incomplete writer-fence sequence")
    if stabilization is None:
        raise EvidenceError("missing WAL-writer stabilization record")
    if reconnect_churn is None:
        raise EvidenceError("missing reconnect churn record")
    maintenance_phase = phases["maintenance-stabilization"]
    readiness_phase = phases["readiness"]
    if (
        stabilization.start_mono_ns < maintenance_phase.mono_ns
        or stabilization.end_mono_ns > readiness_phase.mono_ns
    ):
        raise EvidenceError(
            "WAL-writer stabilization timestamps are outside the maintenance phase"
        )
    reconnect_phase = phases["reconnect-churn"]
    post_quiescence_phase = phases["post-quiescence"]
    if (
        reconnect_churn.start_mono_ns < reconnect_phase.mono_ns
        or reconnect_churn.end_mono_ns > post_quiescence_phase.mono_ns
    ):
        raise EvidenceError("reconnect timestamps are outside the reconnect phase")
    return LifecycleEvidence(
        samples=samples,
        fences=fences,
        phases=phases,
        stabilization=stabilization,
        reconnect_churn=reconnect_churn,
    )


def stable_tail(
    samples: list[RuntimeSample], min_samples: int, min_span_ns: int, max_gap_ns: int
) -> StablePlateau:
    if not samples:
        raise EvidenceError("phase has no samples")
    final_counts = samples[-1].counts
    start = len(samples) - 1
    while start > 0 and samples[start - 1].counts == final_counts:
        start -= 1
    stable = samples[start:]
    span_ns = stable[-1].mono_ns - stable[0].mono_ns
    if len(stable) < min_samples:
        raise EvidenceError(f"stable tail has {len(stable)} samples; need {min_samples}")
    if span_ns < min_span_ns:
        raise EvidenceError(f"stable tail spans {span_ns}ns; need {min_span_ns}ns")
    gaps = [
        following.mono_ns - preceding.mono_ns
        for preceding, following in zip(stable, stable[1:], strict=False)
    ]
    max_observed_gap_ns = max(gaps, default=0)
    if max_observed_gap_ns > max_gap_ns:
        raise EvidenceError(
            f"stable tail has a {max_observed_gap_ns}ns sample gap; maximum is {max_gap_ns}ns"
        )
    return StablePlateau(
        samples=len(stable),
        span_ns=span_ns,
        max_gap_ns=max_observed_gap_ns,
        first_mono_ns=stable[0].mono_ns,
        last_mono_ns=stable[-1].mono_ns,
        observer_pids=tuple(sorted({sample.observer_pid for sample in stable})),
        counts=final_counts,
    )


def select_plateau(
    evidence: LifecycleEvidence,
    observer_pid: int,
    min_samples: int,
    min_span_ns: int,
    max_gap_ns: int,
    baseline_policy: BaselinePolicy,
) -> tuple[str, StablePlateau, StablePlateau, StablePlateau]:
    readiness_fence = evidence.fences["readiness"]
    final_fence = evidence.fences["post-quiescence"]
    wait_kind = readiness_fence.sample.wait_kind
    if final_fence.sample.wait_kind != wait_kind:
        raise EvidenceError("readiness and post-quiescence fences used different wait kinds")

    phase_plateaus: dict[str, StablePlateau] = {}
    for phase, fence in (
        ("cold-readiness", None),
        ("readiness", readiness_fence),
        ("post-quiescence", final_fence),
    ):
        phase_samples = [sample for sample in evidence.samples if sample.phase == phase]
        # Every wait dump is a global control-plane/registry snapshot. Any
        # registered idle PostgreSQL task may emit it; the state tuple itself
        # proves that emitting task is registered. The postmaster alone owns
        # the committed fence, while all same-kind observers strengthen the
        # stable window instead of being misclassified as foreign processes.
        candidate_samples = [
            sample for sample in phase_samples if sample.wait_kind == wait_kind
        ]
        if not candidate_samples:
            raise EvidenceError(f"{phase} has no candidate samples")
        if fence is not None and candidate_samples[-1].sequence != fence.sample.sequence:
            raise EvidenceError(f"{phase} fence is not the terminal candidate sample")
        plateau = stable_tail(candidate_samples, min_samples, min_span_ns, max_gap_ns)
        for sample in phase_samples:
            if sample.mono_ns < plateau.first_mono_ns:
                continue
            if sample.wait_kind != wait_kind:
                raise EvidenceError(
                    f"{phase} stable tail contains a foreign wait kind"
                )
            if sample.counts != plateau.counts:
                raise EvidenceError(
                    f"{phase} has a contradictory {sample.wait_kind} sample "
                    f"from observer {sample.observer_pid} inside the fenced plateau"
                )
        phase_plateaus[phase] = plateau

    cold = phase_plateaus["cold-readiness"]
    readiness = phase_plateaus["readiness"]
    final = phase_plateaus["post-quiescence"]
    if readiness.counts != final.counts:
        raise EvidenceError("readiness and post-quiescence tuples differ")
    values = dict(zip(COUNT_FIELDS, readiness.counts, strict=True))
    if values["registered_processes"] == 0:
        raise EvidenceError("idle-postmaster topology has no registered processes")
    for field in (
        "active_tasks",
        "process_topology_nodes",
        "process_thread_entries",
        "process_live_threads",
        "runtime_state_active",
        "runtime_state_slots",
    ):
        if values[field] != values["registered_processes"]:
            raise EvidenceError(
                "idle-postmaster semantic ownership requires "
                f"{field}=registered_processes"
            )
    if values["process_child_edges"] + 1 != values["process_topology_nodes"]:
        raise EvidenceError("idle-postmaster process topology is not one rooted tree")
    expected_execution_leases = values["active_tasks"] + values["process_child_edges"]
    if values["process_execution_leases"] != expected_execution_leases:
        raise EvidenceError(
            "idle-postmaster semantic ownership requires "
            "process_execution_leases=active_tasks+process_child_edges"
        )
    if len(readiness.observer_pids) != values["registered_processes"]:
        raise EvidenceError(
            "readiness stable tail observer cardinality does not equal registered_processes"
        )
    if len(final.observer_pids) != values["registered_processes"]:
        raise EvidenceError(
            "post-quiescence stable tail observer cardinality does not equal "
            "registered_processes"
        )
    if readiness.observer_pids != final.observer_pids:
        raise EvidenceError(
            "readiness and post-quiescence stable-tail observer PID sets differ"
        )
    if observer_pid not in readiness.observer_pids:
        raise EvidenceError("postmaster is absent from the terminal stable-tail observers")
    if values["runtime_state_observer_registered"] != 1:
        raise EvidenceError("runtime snapshot observer is not registered")
    for field in (
        "process_pending_child_publications",
        "process_quiescence_wakers",
        "process_retiring_nodes",
    ):
        if values[field] != 0:
            raise EvidenceError(f"idle-postmaster semantic ownership requires {field}=0")
    runtime_active = readiness.counts[COUNT_FIELDS.index("runtime_state_active")]
    runtime_stale = readiness.counts[COUNT_FIELDS.index("runtime_state_stale")]
    runtime_slots = readiness.counts[COUNT_FIELDS.index("runtime_state_slots")]
    if runtime_stale != 0:
        raise EvidenceError("runtime-state registry stale count is nonzero")
    if runtime_slots != runtime_active:
        raise EvidenceError("runtime-state registry slots do not equal active entries")
    for kind in ("private_futex", "shared_futex"):
        waiters = readiness.counts[COUNT_FIELDS.index(f"{kind}_waiters")]
        wakers = readiness.counts[COUNT_FIELDS.index(f"{kind}_wakers")]
        if wakers > waiters:
            raise EvidenceError(f"{kind} waker count exceeds waiter count")
    epoll_subscriptions = readiness.counts[COUNT_FIELDS.index("epoll_subscriptions")]
    epoll_close_registrations = readiness.counts[
        COUNT_FIELDS.index("epoll_close_registrations")
    ]
    if epoll_close_registrations > epoll_subscriptions:
        raise EvidenceError("epoll close registrations exceed subscriptions")
    active = readiness.counts[COUNT_FIELDS.index("shared_registry_active")]
    stale = readiness.counts[COUNT_FIELDS.index("shared_registry_stale")]
    slots = readiness.counts[COUNT_FIELDS.index("shared_registry_slots")]
    if stale != 0:
        raise EvidenceError("shared registry stale count is nonzero")
    if slots != active:
        raise EvidenceError("shared registry slots do not equal active entries")
    enforce_baseline_policy(baseline_policy, readiness, final)
    return wait_kind, cold, readiness, final


def output_row(
    *, target: str, status: str, detail: str, nonce: str, observer_pid: int,
    min_samples: int, min_span_ns: int, expected_interval_ms: int,
    max_sample_gap_ns: int, wait_kind: str = "",
    cold: StablePlateau | None = None,
    readiness: StablePlateau | None = None, final: StablePlateau | None = None,
    readiness_fence: RuntimeFence | None = None,
    final_fence: RuntimeFence | None = None,
    evidence: LifecycleEvidence | None = None,
    freeze_binding: FreezeBinding | None = None,
    baseline_binding: BaselineBinding | None = None,
) -> dict[str, str | int]:
    row: dict[str, str | int] = {field: "" for field in OUTPUT_FIELDS}
    row.update(
        schema_version=6,
        target=target,
        status=status,
        detail=detail.replace("\t", " ").replace("\r", " ").replace("\n", " "),
        claim_scope=CLAIM_SCOPE,
        baseline_assumption=BASELINE_ASSUMPTION,
        nonce=nonce,
        observer_pid=observer_pid,
        wait_kind=wait_kind,
        min_samples=min_samples,
        min_span_ns=min_span_ns,
        expected_interval_ms=expected_interval_ms,
        max_sample_gap_ns=max_sample_gap_ns,
    )
    if evidence is not None:
        stabilization = evidence.stabilization
        reconnect_churn = evidence.reconnect_churn
        row.update(
            cold_readiness_phase_mono_ns=evidence.phases["cold-readiness"].mono_ns,
            maintenance_stabilization_phase_mono_ns=evidence.phases[
                "maintenance-stabilization"
            ].mono_ns,
            readiness_phase_mono_ns=evidence.phases["readiness"].mono_ns,
            stabilization_method=stabilization.method,
            stabilization_before_writes=stabilization.before_writes,
            stabilization_after_writes=stabilization.after_writes,
            stabilization_before_write_bytes=stabilization.before_write_bytes,
            stabilization_after_write_bytes=stabilization.after_write_bytes,
            stabilization_stats_reset=stabilization.stats_reset,
            stabilization_target_lsn=stabilization.target_lsn,
            stabilization_observed_flush_lsn=stabilization.observed_flush_lsn,
            stabilization_wal_writer_delay_ms=stabilization.wal_writer_delay_ms,
            stabilization_start_mono_ns=stabilization.start_mono_ns,
            stabilization_end_mono_ns=stabilization.end_mono_ns,
            stabilization_elapsed_ns=stabilization.elapsed_ns,
            reconnect_requested=reconnect_churn.requested,
            reconnect_completed=reconnect_churn.completed,
            reconnect_command_sha256=reconnect_churn.command_sha256,
            reconnect_client_sha256=reconnect_churn.client_sha256,
            reconnect_connection_sha256=reconnect_churn.connection_sha256,
            reconnect_start_mono_ns=reconnect_churn.start_mono_ns,
            reconnect_end_mono_ns=reconnect_churn.end_mono_ns,
            reconnect_elapsed_ns=reconnect_churn.elapsed_ns,
        )
    if freeze_binding is not None:
        row.update(
            freeze_receipt_sha256=freeze_binding.receipt_sha256,
            evidence_sha256=freeze_binding.evidence_sha256,
            commit_ack_sha256=freeze_binding.commit_ack_sha256,
            fence_end_offset=freeze_binding.fence_end_offset,
        )
    if baseline_binding is not None:
        row.update(
            claim_scope=baseline_binding.policy.claim_scope,
            baseline_assumption=baseline_binding.policy.baseline_assumption,
            baseline_policy_id=baseline_binding.policy.policy_id,
            baseline_policy_status=baseline_binding.policy.policy_status,
            baseline_policy_sha256=baseline_binding.policy.sha256,
            baseline_binding_sha256=baseline_binding.sha256,
        )
    if (
        cold is not None
        and readiness is not None
        and final is not None
        and readiness_fence is not None
        and final_fence is not None
    ):
        row.update(
            readiness_fence_sequence=readiness_fence.sample.sequence,
            readiness_fence_mono_ns=readiness_fence.sample.mono_ns,
            post_quiescence_fence_sequence=final_fence.sample.sequence,
            post_quiescence_fence_mono_ns=final_fence.sample.mono_ns,
            readiness_samples=readiness.samples,
            readiness_span_ns=readiness.span_ns,
            readiness_max_gap_ns=readiness.max_gap_ns,
            post_quiescence_samples=final.samples,
            post_quiescence_span_ns=final.span_ns,
            post_quiescence_max_gap_ns=final.max_gap_ns,
            cold_readiness_samples=cold.samples,
            cold_readiness_span_ns=cold.span_ns,
            cold_readiness_max_gap_ns=cold.max_gap_ns,
            cold_readiness_observer_pids=",".join(
                str(pid) for pid in cold.observer_pids
            ),
            readiness_observer_pids=",".join(
                str(pid) for pid in readiness.observer_pids
            ),
            post_quiescence_observer_pids=",".join(
                str(pid) for pid in final.observer_pids
            ),
        )
        for index, field in enumerate(COUNT_FIELDS):
            row[f"cold_readiness_{field}"] = cold.counts[index]
            row[f"readiness_{field}"] = readiness.counts[index]
            row[f"post_quiescence_{field}"] = final.counts[index]
    return row


def validate_lifecycle_bundle(
    *,
    log: Path,
    freeze_receipt: Path,
    baseline_policy_path: Path,
    baseline_binding_path: Path,
    target: str,
    nonce: str,
    observer_pid: int,
    min_samples: int,
    min_span_ns: int,
    expected_interval_ms: int,
    max_sample_gap_ns: int,
) -> LifecycleValidationOutcome:
    freeze_binding: FreezeBinding | None = None
    baseline_binding: BaselineBinding | None = None
    evidence: LifecycleEvidence | None = None
    try:
        baseline_policy = parse_baseline_policy(baseline_policy_path)
        baseline_binding = parse_baseline_binding(
            baseline_binding_path, baseline_policy
        )
        frozen = read_regular_file(log)
        freeze_binding = validate_freeze_binding(
            freeze_receipt,
            log,
            frozen,
            nonce,
            observer_pid,
        )
        lines = frozen.decode("utf-8", errors="strict").splitlines(keepends=True)
        evidence = parse_evidence(lines, nonce, observer_pid)
        final_fence = evidence.fences["post-quiescence"].sample
        if (
            final_fence.sequence != freeze_binding.fence_sequence
            or final_fence.mono_ns != freeze_binding.fence_mono_ns
        ):
            raise EvidenceError("parsed final fence differs from the freeze receipt")
        wait_kind, cold, readiness, final = select_plateau(
            evidence,
            observer_pid,
            min_samples,
            min_span_ns,
            max_sample_gap_ns,
            baseline_policy,
        )
        row = output_row(
            target=target,
            status="passed",
            detail=(
                "idle-postmaster-semantic-ownership-and-stabilized-readiness-"
                "post-quiescence-tuple-and-observer-identity-equality-with-"
                "receipt-bound-reconnect-churn"
            ),
            nonce=nonce,
            observer_pid=observer_pid,
            min_samples=min_samples,
            min_span_ns=min_span_ns,
            expected_interval_ms=expected_interval_ms,
            max_sample_gap_ns=max_sample_gap_ns,
            wait_kind=wait_kind,
            cold=cold,
            readiness=readiness,
            final=final,
            readiness_fence=evidence.fences["readiness"],
            final_fence=evidence.fences["post-quiescence"],
            evidence=evidence,
            freeze_binding=freeze_binding,
            baseline_binding=baseline_binding,
        )
        return LifecycleValidationOutcome(row=row, error=None)
    except (EvidenceError, OSError, UnicodeError) as error:
        row = output_row(
            target=target,
            status="failed",
            detail=str(error),
            nonce=nonce,
            observer_pid=observer_pid,
            min_samples=min_samples,
            min_span_ns=min_span_ns,
            expected_interval_ms=expected_interval_ms,
            max_sample_gap_ns=max_sample_gap_ns,
            evidence=evidence,
            freeze_binding=freeze_binding,
            baseline_binding=baseline_binding,
        )
        return LifecycleValidationOutcome(row=row, error=str(error))


def write_output(path: Path, row: dict[str, str | int]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    pending = path.with_name(path.name + ".pending")
    with pending.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, delimiter="\t", fieldnames=OUTPUT_FIELDS, lineterminator="\n")
        writer.writeheader()
        writer.writerow(row)
    pending.replace(path)


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate WASIX lifecycle occupancy plateau evidence")
    parser.add_argument("--log", required=True, type=Path)
    parser.add_argument("--freeze-receipt", required=True, type=Path)
    parser.add_argument("--baseline-policy", required=True, type=Path)
    parser.add_argument("--baseline-binding", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--target", default="wasix")
    parser.add_argument("--nonce", required=True)
    parser.add_argument("--observer-pid", required=True, type=int)
    parser.add_argument("--min-samples", default=3, type=int)
    parser.add_argument("--min-span-ms", default=1000, type=int)
    parser.add_argument("--expected-interval-ms", required=True, type=int)
    args = parser.parse_args()

    if not NONCE_RE.fullmatch(args.nonce):
        parser.error("--nonce must be exactly 32 lowercase hexadecimal characters")
    if args.observer_pid <= 0:
        parser.error("--observer-pid must be positive")
    if args.min_samples < 3:
        parser.error("--min-samples must be at least 3")
    if args.min_span_ms < 1000:
        parser.error("--min-span-ms must be at least 1000")
    if args.expected_interval_ms <= 0:
        parser.error("--expected-interval-ms must be positive")
    if args.min_span_ms > ((1 << 64) - 1) // 1_000_000:
        parser.error("--min-span-ms exceeds the supported u64 nanosecond range")
    if args.expected_interval_ms > ((1 << 64) - 1) // 3_000_000:
        parser.error("--expected-interval-ms exceeds the supported u64 nanosecond range")
    min_span_ns = args.min_span_ms * 1_000_000
    max_sample_gap_ns = args.expected_interval_ms * 3_000_000

    outcome = validate_lifecycle_bundle(
        log=args.log,
        freeze_receipt=args.freeze_receipt,
        baseline_policy_path=args.baseline_policy,
        baseline_binding_path=args.baseline_binding,
        target=args.target,
        nonce=args.nonce,
        observer_pid=args.observer_pid,
        min_samples=args.min_samples,
        min_span_ns=min_span_ns,
        expected_interval_ms=args.expected_interval_ms,
        max_sample_gap_ns=max_sample_gap_ns,
    )
    write_output(args.output, outcome.row)
    if not outcome.passed:
        print(
            f"WASIX lifecycle plateau validation failed: {outcome.row['detail']}",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
