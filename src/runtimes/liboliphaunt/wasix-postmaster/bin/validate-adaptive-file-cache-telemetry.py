#!/usr/bin/env python3

"""Validate exact adaptive-v5 or fail-closed cache-policy evidence."""

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


ACTIVE_SCHEMA = "oliphaunt.wasix-postmaster.file-cache-adaptive-telemetry.v5"
FALLBACK_SCHEMA = "oliphaunt.wasix-postmaster.file-cache-admission-fallback.v1"
RESULT_SCHEMA = "oliphaunt.wasix-postmaster.file-cache-adaptive-validation.v5"
POLICY_ID = "oliphaunt.wasix-postmaster.file-cache.adaptive-linux.v5"
POLICY_MODE = "adaptive-linux-explicit"
CONFIG_ID = "oliphaunt.wasix-postmaster.file-cache.adaptive-linux.embedded-v4"
CONFIG_SHA256 = "01668b856435cb8c34b2d2324ab55b7f1f5961b8b403c1ee49d9ee4b5c865f53"
FALLBACK_POLICY_ID = "oliphaunt.wasix-postmaster.file-cache.observe-only.v1"
FALLBACK_POLICY_MODE = "observe-only-retain"
MANIFEST_FALLBACK_MODE = "observe-only"
PORTABLE_ACCEPTANCE_POLICY = "portable-correctness-v1"
CONSTRAINED_ACCEPTANCE_POLICY = "constrained-linux-wal-action-v1"
ACCEPTANCE_POLICIES = {
    PORTABLE_ACCEPTANCE_POLICY,
    CONSTRAINED_ACCEPTANCE_POLICY,
}
SHA256_RE = re.compile(r"[0-9a-f]{64}\Z")
CGROUP_IDENTITY_RE = re.compile(r"([1-9][0-9]*):([1-9][0-9]*)\Z")
MEASUREMENT_ID_RE = re.compile(r"[A-Za-z0-9._-]+\Z")
MEBIBYTE = 1024 * 1024

CONFIG = {
    "page-alignment": "host-page",
    "sample-interval-ns": 250_000_000,
    "warmup-samples": 3,
    "enter-level1-per-mille": 780,
    "exit-level1-per-mille": 720,
    "enter-level2-per-mille": 850,
    "exit-level2-per-mille": 800,
    "enter-level3-per-mille": 920,
    "exit-level3-per-mille": 870,
    "emergency-headroom-bytes": 24 * 1024 * 1024,
    "cooldown-ns": 2_000_000_000,
    "circuit-breaker-cooldown-ns": 5_000_000_000,
    "healthy-samples-to-recover": 3,
    "max-dirty-bytes": 16 * 1024 * 1024,
    "max-dirty-per-mille": 80,
    "immediate-wal-cache-drop-safe": False,
    "relation-pressure-relief": False,
    "allow-wal-cache-drop-safe-dirty-bypass": True,
    "wal-emergency-max-bytes": 16 * 1024 * 1024,
    "deferred-wal-max-entries": 4,
    "deferred-wal-max-bytes": 64 * 1024 * 1024,
    "deferred-wal-max-fds": 4,
    "deferred-wal-ttl-ns": 4_000_000_000,
    "deferred-wal-drain-per-trigger": 1,
    "deferred-wal-busy-retries": 0,
    "bytes-per-second": 32 * 1024 * 1024,
    "burst-bytes": 32 * 1024 * 1024,
    "max-bytes-per-offer": 16 * 1024 * 1024,
    "min-bytes-per-offer": 4096,
    "psi-some-breaker-per-mille": 250,
    "psi-full-breaker-per-mille": 100,
    "refault-min-pages": 256,
    "refault-breaker-per-mille": 500,
}
MANIFEST_POLICY_FIELDS = {
    "requested-policy-id",
    "approved-config-id",
    "config-sha256",
    "portable-fallback-mode",
}
ACTIVE_FIELDS = {
    "schema",
    "policy-id",
    "policy-mode",
    "workload-id",
    "runtime-abi-id",
    "fallback-policy-id",
    "fallback-policy-mode",
    "config",
    "resolved-page-bytes",
    "state",
    "sample-count",
    "state-transitions",
    "sample-errors",
    "clock-errors",
    "psi-breaker-trips",
    "refault-breaker-trips",
    "dirty-vetoes",
    "wal-dirty-veto-bypasses",
    "wal-dirty-veto-bypass-bytes",
    "range-offered-bytes",
    "range-aligned-bytes",
    "range-advised-bytes",
    "token-bytes",
    "state-deadline-ns",
    "advised-bytes-since-sample",
    "advice-errors",
    "last-advice-raw-os-error",
    "max-current-bytes",
    "max-used-per-mille",
    "max-file-context-bytes",
    "max-file-dirty-bytes",
    "last-psi-some-delta-us",
    "last-psi-full-delta-us",
    "last-psi-some-per-mille",
    "last-psi-full-per-mille",
    "psi-no-advice-baseline-some-per-mille",
    "psi-no-advice-baseline-full-per-mille",
    "last-refault-delta",
    "last-local-high-event-delta",
    "last-local-max-event-delta",
    "last-local-oom-event-delta",
    "workload-finalized",
    "deferred-wal-maintenance-constructed",
    "deferred-wal-maintenance-active",
    "deferred-wal-queued-entries",
    "deferred-wal-queued-bytes",
    "deferred-wal-inflight-entries",
    "deferred-wal-inflight-bytes",
    "deferred-wal-oldest-age-ns",
    "deferred-wal-oldest-overdue-ns",
    "deferred-wal-high-entries",
    "deferred-wal-high-bytes",
    "deferred-wal-enqueued",
    "deferred-wal-enqueued-bytes",
    "deferred-wal-capacity-evicted",
    "deferred-wal-capacity-evicted-bytes",
    "deferred-wal-capacity-rejected",
    "deferred-wal-capacity-rejected-bytes",
    "deferred-wal-sequence-rejected",
    "deferred-wal-sequence-rejected-bytes",
    "deferred-wal-expired",
    "deferred-wal-expired-bytes",
    "deferred-wal-attempts",
    "deferred-wal-attempted-bytes",
    "deferred-wal-successes",
    "deferred-wal-success-bytes",
    "deferred-wal-busy",
    "deferred-wal-busy-requeued",
    "deferred-wal-busy-dropped",
    "deferred-wal-busy-dropped-bytes",
    "deferred-wal-invalidated",
    "deferred-wal-invalidated-bytes",
    "deferred-wal-revoked",
    "deferred-wal-revoked-bytes",
    "deferred-wal-errors",
    "deferred-wal-error-bytes",
    "deferred-wal-pin-errors",
    "deferred-wal-flushes",
    "deferred-wal-flushed-entries",
    "deferred-wal-flushed-bytes",
    "deferred-wal-sampler-flushes",
    "deferred-wal-clock-flushes",
    "deferred-wal-breaker-flushes",
    "deferred-wal-advice-error-flushes",
    "deferred-wal-drop-flushes",
    "deferred-wal-finalization-flushes",
    "deferred-wal-revoke-calls",
    "deferred-wal-revoke-errors",
    "deferred-wal-revoke-sequence",
    "deferred-wal-pressure-samples",
    "deferred-wal-actionable-samples",
    "deferred-wal-open-fds",
    "deferred-wal-mutation-epoch-identities",
    "deferred-wal-terminal-entries",
    "deferred-wal-terminal-bytes",
    "deferred-wal-conservation-entries-ok",
    "deferred-wal-conservation-bytes-ok",
    "wal-emergency-oversize-rejects",
    "wal-emergency-attempts",
    "wal-emergency-attempted-bytes",
    "wal-emergency-successes",
    "wal-emergency-success-bytes",
    "wal-emergency-current-attempts",
    "wal-emergency-current-attempted-bytes",
    "wal-emergency-current-successes",
    "wal-emergency-current-success-bytes",
    "wal-emergency-forced-samples",
    "wal-emergency-max-actions-per-trigger",
    "wal-emergency-max-bytes-per-trigger",
    "action-gate-contended-calls",
    "action-gate-contended-retained",
    "action-gate-contended-enqueued",
    "action-gate-contended-wal-pin-failures",
    "action-gate-probe-total-ns",
    "action-gate-probe-max-ns",
    "finalization-quiescence-notifications",
    "last-sample",
    "classes",
    "retain-reasons",
    "validation",
}
ACTIVE_BOOL_FIELDS = {
    "workload-finalized",
    "deferred-wal-maintenance-constructed",
    "deferred-wal-maintenance-active",
    "deferred-wal-conservation-entries-ok",
    "deferred-wal-conservation-bytes-ok",
}
ACTIVE_U32_FIELDS = {
    "deferred-wal-queued-entries",
    "deferred-wal-inflight-entries",
    "deferred-wal-high-entries",
    "deferred-wal-open-fds",
    "deferred-wal-mutation-epoch-identities",
    "wal-emergency-max-actions-per-trigger",
}
ACTIVE_U16_FIELDS = {
    "max-used-per-mille",
    "last-psi-some-per-mille",
    "last-psi-full-per-mille",
}
ACTIVE_OPTIONAL_U16_FIELDS = {
    "psi-no-advice-baseline-some-per-mille",
    "psi-no-advice-baseline-full-per-mille",
}
FALLBACK_FIELDS = {
    "schema",
    "admission",
    "requested-policy-id",
    "requested-policy-mode",
    "workload-id",
    "runtime-abi-id",
    "fallback-policy-id",
    "fallback-policy-mode",
    "reason",
    "config",
}
CLASS_FIELDS = {
    "class",
    "name",
    "offers",
    "offered-finite-bytes",
    "through-eof-offers",
    "advice-calls",
    "advised-bytes",
    "partial-advice-calls",
    "advice-errors",
}
RETAIN_FIELDS = {"reason", "calls"}
SAMPLE_FIELDS = {
    "monotonic-ns",
    "current-bytes",
    "effective-limit-bytes",
    "file-context-bytes",
    "file-dirty-bytes",
    "workingset-refault-file",
    "psi-some-total-us",
    "psi-full-total-us",
    "local-high-events",
    "local-max-events",
    "local-oom-events",
    "local-events-available",
    "membership-leaf-device",
    "membership-leaf-inode",
    "pressure-source-device",
    "pressure-source-inode",
    "pressure-source-depth",
}
CLASSES = (
    (1, "relation-read-normal"),
    (2, "relation-read-bulk"),
    (3, "relation-read-vacuum"),
    (4, "relation-sync-checkpoint"),
    (5, "relation-sync-immediate"),
    (6, "wal-inactive-durable"),
)
RETAIN_REASONS = (
    "unsupported-class",
    "through-eof",
    "non-host-backed",
    "pressure-state",
    "dirty-veto",
    "empty-after-inward-alignment",
    "rate-limited",
    "sampler-unavailable",
    "circuit-breaker",
    "wal-cache-drop-proof-required",
    "wal-whole-segment-required",
    "workload-finalized",
)
STATES = {
    "warmup",
    "retain",
    "relief-level1",
    "relief-level2",
    "relief-level3",
    "cooldown",
    "degraded",
}
FALLBACK_REASONS = {"unsupported", "invalid-evidence", "unavailable-io"}


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


def exact_unsigned(value: Any, label: str, maximum: int = (1 << 64) - 1) -> int:
    require(type(value) is int and 0 <= value <= maximum, f"{label} is out of range")
    return value


def exact_optional_unsigned(value: Any, label: str, maximum: int) -> int | None:
    if value is None:
        return None
    return exact_unsigned(value, label, maximum)


def require_canonical_wal_sum(count: int, byte_count: int, label: str) -> None:
    """Require bytes to be the sum of count 1/2/4/8/16 MiB segments."""
    require(
        (count == 0) == (byte_count == 0) and byte_count % MEBIBYTE == 0,
        f"{label} count/byte presence or MiB alignment differs",
    )
    units = byte_count // MEBIBYTE
    require(
        count <= units <= count * 16,
        f"{label} bytes exceed canonical whole-WAL bounds",
    )
    # Give every segment its mandatory 1 MiB baseline. A segment may then add
    # exactly 0, 1, 3, 7, or 15 MiB. The canonical coin system below computes
    # the fewest nonzero upgrades needed; the sum is representable iff those
    # upgrades fit in the available segment count.
    extra_units = units - count
    upgrade_count = 0
    for upgrade in (15, 7, 3, 1):
        quotient, extra_units = divmod(extra_units, upgrade)
        upgrade_count += quotient
    require(
        extra_units == 0 and upgrade_count <= count,
        f"{label} is not a sum of canonical 1/2/4/8/16 MiB WAL segments",
    )


def manifest_contract(manifest: dict[str, Any]) -> str:
    runtime_abi_id = manifest.get("runtime-abi-id")
    require(
        isinstance(runtime_abi_id, str) and SHA256_RE.fullmatch(runtime_abi_id) is not None,
        "sealed manifest runtime-abi-id is invalid",
    )
    policy = manifest.get("file-cache-policy")
    require(
        isinstance(policy, dict) and set(policy) == MANIFEST_POLICY_FIELDS,
        "sealed manifest file-cache-policy fields differ",
    )
    expected = {
        "requested-policy-id": POLICY_ID,
        "approved-config-id": CONFIG_ID,
        "config-sha256": CONFIG_SHA256,
        "portable-fallback-mode": MANIFEST_FALLBACK_MODE,
    }
    require(policy == expected, "sealed manifest file-cache-policy differs")
    canonical_config = json.dumps(
        CONFIG, ensure_ascii=False, separators=(",", ":")
    ).encode("utf-8")
    require(
        hashlib.sha256(canonical_config).hexdigest() == CONFIG_SHA256,
        "validator compiled adaptive config digest differs",
    )
    return runtime_abi_id


def validate_fixed_identity(telemetry: dict[str, Any], runtime_abi_id: str) -> None:
    expected = {
        "workload-id": "runtime:postgres",
        "runtime-abi-id": runtime_abi_id,
        "fallback-policy-id": FALLBACK_POLICY_ID,
        "fallback-policy-mode": FALLBACK_POLICY_MODE,
    }
    for field, value in expected.items():
        require(
            telemetry[field] == value,
            f"adaptive telemetry {field} differs: expected {value!r}, got {telemetry[field]!r}",
        )
    actual_config = telemetry["config"]
    require(
        isinstance(actual_config, dict) and set(actual_config) == set(CONFIG),
        "adaptive telemetry config fields differ",
    )
    for field, expected_value in CONFIG.items():
        actual_value = actual_config[field]
        require(
            type(actual_value) is type(expected_value) and actual_value == expected_value,
            f"adaptive telemetry config {field} differs",
        )


def validate_last_sample(
    value: Any, sample_count: int, sample_errors: int, clock_errors: int
) -> None:
    if value is None:
        require(
            sample_count == 0 or sample_errors > 0 or clock_errors > 0,
            "adaptive telemetry omitted a successful last sample without a sampler/clock error",
        )
        return
    require(sample_count > 0, "adaptive telemetry has a last sample without a sample")
    require(isinstance(value, dict) and set(value) == SAMPLE_FIELDS, "last-sample fields differ")
    for field in SAMPLE_FIELDS - {"local-events-available"}:
        maximum = (1 << 32) - 1 if field == "pressure-source-depth" else (1 << 64) - 1
        exact_unsigned(value[field], f"last-sample {field}", maximum)
    require(
        type(value["local-events-available"]) is bool,
        "last-sample local-events-available must be boolean",
    )
    require(value["effective-limit-bytes"] > 0, "last-sample effective limit is not finite")
    for field in (
        "membership-leaf-device",
        "membership-leaf-inode",
        "pressure-source-device",
        "pressure-source-inode",
    ):
        require(value[field] > 0, f"last-sample {field} is not a pinned identity")


def validate_active(telemetry: dict[str, Any], runtime_abi_id: str) -> dict[str, Any]:
    require(set(telemetry) == ACTIVE_FIELDS, "active adaptive telemetry fields differ")
    validate_fixed_identity(telemetry, runtime_abi_id)
    require(telemetry["schema"] == ACTIVE_SCHEMA, "active adaptive telemetry schema differs")
    require(telemetry["policy-id"] == POLICY_ID, "active adaptive policy-id differs")
    require(telemetry["policy-mode"] == POLICY_MODE, "active adaptive policy-mode differs")
    require(telemetry["state"] in STATES, "active adaptive state is unknown")

    for field in ACTIVE_BOOL_FIELDS:
        require(type(telemetry[field]) is bool, f"{field} must be boolean")
    optional_u16 = {
        field: exact_optional_unsigned(telemetry[field], field, (1 << 16) - 1)
        for field in ACTIVE_OPTIONAL_U16_FIELDS
    }
    require(
        (optional_u16["psi-no-advice-baseline-some-per-mille"] is None)
        == (optional_u16["psi-no-advice-baseline-full-per-mille"] is None),
        "adaptive PSI no-advice baselines must be present or absent together",
    )
    for field, value in optional_u16.items():
        require(value is None or value <= 1000, f"{field} exceeds 1000")

    scalar_fields = ACTIVE_FIELDS - {
        "schema",
        "policy-id",
        "policy-mode",
        "workload-id",
        "runtime-abi-id",
        "fallback-policy-id",
        "fallback-policy-mode",
        "config",
        "state",
        "last-advice-raw-os-error",
        "last-sample",
        "classes",
        "retain-reasons",
        "validation",
    } - ACTIVE_BOOL_FIELDS - ACTIVE_OPTIONAL_U16_FIELDS
    scalars = {
        field: exact_unsigned(
            telemetry[field],
            field,
            (1 << 16) - 1
            if field in ACTIVE_U16_FIELDS
            else (1 << 32) - 1
            if field in ACTIVE_U32_FIELDS
            else (1 << 64) - 1,
        )
        for field in scalar_fields
    }
    for field in ACTIVE_U16_FIELDS:
        require(scalars[field] <= 1000, f"{field} exceeds 1000")

    resolved_page_bytes = scalars["resolved-page-bytes"]
    require(
        resolved_page_bytes >= 512 and resolved_page_bytes.bit_count() == 1,
        "resolved-page-bytes is not a power of two >= 512",
    )
    effective_minimum = (
        CONFIG["min-bytes-per-offer"] + resolved_page_bytes - 1
    ) & -resolved_page_bytes
    require(
        effective_minimum <= CONFIG["max-bytes-per-offer"]
        and effective_minimum <= CONFIG["burst-bytes"],
        "resolved page cannot fit one configured adaptive offer",
    )
    require(
        CONFIG["wal-emergency-max-bytes"] >= resolved_page_bytes
        and CONFIG["wal-emergency-max-bytes"] % resolved_page_bytes == 0,
        "resolved page cannot represent a complete emergency WAL action",
    )
    require(scalars["token-bytes"] <= CONFIG["burst-bytes"], "token-bytes exceeds burst")

    require(telemetry["workload-finalized"], "active adaptive receipt is not workload-finalized")
    require(
        telemetry["deferred-wal-maintenance-constructed"],
        "active adaptive receipt did not construct bounded WAL maintenance",
    )
    require(
        not telemetry["deferred-wal-maintenance-active"],
        "active adaptive receipt retained live WAL maintenance",
    )
    for field in (
        "deferred-wal-queued-entries",
        "deferred-wal-queued-bytes",
        "deferred-wal-inflight-entries",
        "deferred-wal-inflight-bytes",
        "deferred-wal-oldest-age-ns",
        "deferred-wal-oldest-overdue-ns",
        "deferred-wal-open-fds",
        "deferred-wal-mutation-epoch-identities",
    ):
        require(scalars[field] == 0, f"terminal adaptive receipt has nonzero {field}")
    require(
        telemetry["deferred-wal-conservation-entries-ok"]
        and telemetry["deferred-wal-conservation-bytes-ok"],
        "terminal adaptive receipt failed deferred WAL conservation",
    )

    raw_error = telemetry["last-advice-raw-os-error"]
    require(
        raw_error is None or (type(raw_error) is int and -(1 << 31) <= raw_error < (1 << 31)),
        "last-advice-raw-os-error is not null or i32",
    )
    validate_last_sample(
        telemetry["last-sample"],
        scalars["sample-count"],
        scalars["sample-errors"],
        scalars["clock-errors"],
    )
    if scalars["sample-count"] < CONFIG["warmup-samples"]:
        require(
            telemetry["state"] in {"warmup", "degraded"},
            "pre-warmup adaptive state is not warmup or degraded",
        )
    if telemetry["last-sample"] is not None:
        last_sample_value = telemetry["last-sample"]
        last_used_per_mille = min(
            1000,
            last_sample_value["current-bytes"]
            * 1000
            // last_sample_value["effective-limit-bytes"],
        )
        require(
            scalars["max-current-bytes"] >= last_sample_value["current-bytes"]
            and scalars["max-file-context-bytes"]
            >= last_sample_value["file-context-bytes"]
            and scalars["max-file-dirty-bytes"]
            >= last_sample_value["file-dirty-bytes"]
            and scalars["max-used-per-mille"] >= last_used_per_mille,
            "adaptive sample exceeds its recorded high-water telemetry",
        )
        require(
            last_sample_value["file-dirty-bytes"]
            <= last_sample_value["file-context-bytes"],
            "last-sample file-dirty bytes exceed file-context bytes",
        )
        require(
            scalars["last-psi-some-delta-us"]
            <= last_sample_value["psi-some-total-us"]
            and scalars["last-psi-full-delta-us"]
            <= last_sample_value["psi-full-total-us"]
            and scalars["last-refault-delta"]
            <= last_sample_value["workingset-refault-file"]
            and scalars["last-local-high-event-delta"]
            <= last_sample_value["local-high-events"]
            and scalars["last-local-max-event-delta"]
            <= last_sample_value["local-max-events"]
            and scalars["last-local-oom-event-delta"]
            <= last_sample_value["local-oom-events"],
            "adaptive last-sample delta exceeds its cumulative source counter",
        )
        require(
            scalars["last-psi-some-delta-us"] > 0
            or scalars["last-psi-some-per-mille"] == 0,
            "zero PSI-some delta has a nonzero rate",
        )
        require(
            scalars["last-psi-full-delta-us"] > 0
            or scalars["last-psi-full-per-mille"] == 0,
            "zero PSI-full delta has a nonzero rate",
        )
        if not last_sample_value["local-events-available"]:
            require(
                last_sample_value["local-high-events"] == 0
                and last_sample_value["local-max-events"] == 0
                and last_sample_value["local-oom-events"] == 0,
                "last-sample unavailable local events have nonzero counters",
            )

    classes = telemetry["classes"]
    require(isinstance(classes, list) and len(classes) == len(CLASSES), "adaptive class closure differs")
    total_offers = 0
    total_finite_bytes = 0
    total_advice_calls = 0
    total_advised_bytes = 0
    total_advice_errors = 0
    wal_offers = 0
    wal_advice_calls = 0
    wal_advised_bytes = 0
    wal_advice_errors = 0
    wal_finite_offers = 0
    for index, ((class_id, name), record) in enumerate(zip(CLASSES, classes, strict=True)):
        require(isinstance(record, dict) and set(record) == CLASS_FIELDS, f"adaptive class {index} fields differ")
        require(record["class"] == class_id and type(record["class"]) is int, f"adaptive class {index} id differs")
        require(record["name"] == name, f"adaptive class {class_id} name differs")
        counters = {
            field: exact_unsigned(record[field], f"adaptive class {class_id} {field}")
            for field in CLASS_FIELDS - {"class", "name"}
        }
        require(counters["through-eof-offers"] <= counters["offers"], f"adaptive class {class_id} through-EOF offers exceed offers")
        finite_offers = counters["offers"] - counters["through-eof-offers"]
        require(
            (finite_offers == 0) == (counters["offered-finite-bytes"] == 0),
            f"adaptive class {class_id} finite offer count/byte presence differs",
        )
        require(counters["partial-advice-calls"] <= counters["advice-calls"], f"adaptive class {class_id} partial advice exceeds advice calls")
        if class_id == 6:
            require(
                counters["partial-advice-calls"] == 0,
                "class-6 WAL action reported partial advice",
            )
        require(counters["advice-calls"] + counters["advice-errors"] <= finite_offers, f"adaptive class {class_id} advice attempts exceed finite offers")
        require(counters["advised-bytes"] % resolved_page_bytes == 0, f"adaptive class {class_id} advised bytes are not page aligned")
        require(
            counters["advised-bytes"] <= counters["offered-finite-bytes"],
            f"adaptive class {class_id} advised bytes exceed finite offered bytes",
        )
        require(
            (counters["advice-calls"] == 0) == (counters["advised-bytes"] == 0),
            f"adaptive class {class_id} advice call/byte presence differs",
        )
        if counters["advice-calls"] > 0:
            require(
                counters["advice-calls"] * resolved_page_bytes
                <= counters["advised-bytes"]
                <= counters["advice-calls"] * CONFIG["max-bytes-per-offer"],
                f"adaptive class {class_id} advised bytes exceed per-call bounds",
            )
        if class_id in (1, 4, 5) or (
            class_id in (2, 3) and not CONFIG["relation-pressure-relief"]
        ):
            require(
                counters["advice-calls"] == 0
                and counters["advised-bytes"] == 0
                and counters["partial-advice-calls"] == 0
                and counters["advice-errors"] == 0,
                f"non-acting class {class_id} reported advice activity",
            )
        total_offers += counters["offers"]
        total_finite_bytes += counters["offered-finite-bytes"]
        total_advice_calls += counters["advice-calls"]
        total_advised_bytes += counters["advised-bytes"]
        total_advice_errors += counters["advice-errors"]
        if class_id == 6:
            wal_finite_offers = finite_offers
            wal_offers = counters["offers"]
            wal_advice_calls = counters["advice-calls"]
            wal_advised_bytes = counters["advised-bytes"]
            wal_advice_errors = counters["advice-errors"]

    retain = telemetry["retain-reasons"]
    require(isinstance(retain, list) and len(retain) == len(RETAIN_REASONS), "adaptive retain-reason closure differs")
    total_retained = 0
    retain_counts: dict[str, int] = {}
    for index, (name, record) in enumerate(zip(RETAIN_REASONS, retain, strict=True)):
        require(isinstance(record, dict) and set(record) == RETAIN_FIELDS, f"adaptive retain reason {index} fields differ")
        require(record["reason"] == name, f"adaptive retain reason {index} differs")
        calls = exact_unsigned(record["calls"], f"adaptive retain reason {name} calls")
        retain_counts[name] = calls
        total_retained += calls

    require(
        retain_counts["sampler-unavailable"] == 0
        or scalars["sample-errors"] > 0
        or scalars["clock-errors"] > 0
        or telemetry["state"] == "degraded",
        "sampler-unavailable retains lack sampler/clock error or degraded state",
    )
    require(
        retain_counts["circuit-breaker"] == 0
        or scalars["psi-breaker-trips"] > 0
        or scalars["refault-breaker-trips"] > 0
        or scalars["advice-errors"] > 0
        or telemetry["state"] == "degraded",
        "circuit-breaker retains lack breaker/advice history or degraded state",
    )
    require(
        retain_counts["dirty-veto"] == scalars["dirty-vetoes"],
        "dirty-veto retains differ from dirty-veto telemetry",
    )
    require(
        retain_counts["workload-finalized"] == 0,
        "authoritative terminal receipt recorded a post-finalization offer",
    )

    validation = telemetry["validation"]
    require(isinstance(validation, list) and len(validation) == 10, "adaptive validation closure differs")
    validation_counts = [
        exact_unsigned(value, f"adaptive validation index {index}")
        for index, value in enumerate(validation)
    ]
    require(validation_counts[0] == total_offers, "valid adaptive offers and class offers differ")
    require(all(value == 0 for value in validation_counts[1:]), "validated product emitted invalid adaptive offers")
    deferred_terminal_dispositions = sum(
        scalars[field]
        for field in (
            "deferred-wal-capacity-evicted",
            "deferred-wal-expired",
            "deferred-wal-busy-dropped",
            "deferred-wal-invalidated",
            "deferred-wal-revoked",
            "deferred-wal-flushed-entries",
        )
    )
    require(
        total_retained
        + total_advice_calls
        + total_advice_errors
        + deferred_terminal_dispositions
        == total_offers,
        "adaptive terminal offer dispositions do not conserve offers",
    )
    require(total_finite_bytes == scalars["range-offered-bytes"], "adaptive offered-byte totals differ")
    require(total_advised_bytes == scalars["range-advised-bytes"], "adaptive advised-byte totals differ")
    require(scalars["range-advised-bytes"] <= scalars["range-aligned-bytes"] <= scalars["range-offered-bytes"], "adaptive range byte ordering differs")
    require(scalars["advised-bytes-since-sample"] <= scalars["range-advised-bytes"], "adaptive advised-since-sample exceeds total")
    require(
        total_advice_errors + scalars["deferred-wal-invalidated"]
        == scalars["advice-errors"],
        "adaptive advice-error totals differ from class errors plus invalidations",
    )
    require(
        raw_error is None or total_advice_errors > 0,
        "adaptive raw advice error exists without an advice error",
    )

    aligned_byte_fields = {
        "wal-dirty-veto-bypass-bytes",
        "range-aligned-bytes",
        "range-advised-bytes",
        "advised-bytes-since-sample",
        "deferred-wal-queued-bytes",
        "deferred-wal-inflight-bytes",
        "deferred-wal-high-bytes",
        "deferred-wal-enqueued-bytes",
        "deferred-wal-capacity-evicted-bytes",
        "deferred-wal-capacity-rejected-bytes",
        "deferred-wal-sequence-rejected-bytes",
        "deferred-wal-expired-bytes",
        "deferred-wal-attempted-bytes",
        "deferred-wal-success-bytes",
        "deferred-wal-busy-dropped-bytes",
        "deferred-wal-invalidated-bytes",
        "deferred-wal-revoked-bytes",
        "deferred-wal-error-bytes",
        "deferred-wal-flushed-bytes",
        "deferred-wal-terminal-bytes",
        "wal-emergency-attempted-bytes",
        "wal-emergency-success-bytes",
        "wal-emergency-current-attempted-bytes",
        "wal-emergency-current-success-bytes",
        "wal-emergency-max-bytes-per-trigger",
    }
    for field in aligned_byte_fields:
        require(
            scalars[field] % resolved_page_bytes == 0,
            f"{field} is not resolved-page aligned",
        )

    count_byte_pairs = (
        ("wal-dirty-veto-bypasses", "wal-dirty-veto-bypass-bytes"),
        ("deferred-wal-queued-entries", "deferred-wal-queued-bytes"),
        ("deferred-wal-inflight-entries", "deferred-wal-inflight-bytes"),
        ("deferred-wal-high-entries", "deferred-wal-high-bytes"),
        ("deferred-wal-enqueued", "deferred-wal-enqueued-bytes"),
        ("deferred-wal-capacity-evicted", "deferred-wal-capacity-evicted-bytes"),
        ("deferred-wal-capacity-rejected", "deferred-wal-capacity-rejected-bytes"),
        ("deferred-wal-sequence-rejected", "deferred-wal-sequence-rejected-bytes"),
        ("deferred-wal-expired", "deferred-wal-expired-bytes"),
        ("deferred-wal-attempts", "deferred-wal-attempted-bytes"),
        ("deferred-wal-successes", "deferred-wal-success-bytes"),
        ("deferred-wal-busy-dropped", "deferred-wal-busy-dropped-bytes"),
        ("deferred-wal-invalidated", "deferred-wal-invalidated-bytes"),
        ("deferred-wal-revoked", "deferred-wal-revoked-bytes"),
        ("deferred-wal-errors", "deferred-wal-error-bytes"),
        ("deferred-wal-flushed-entries", "deferred-wal-flushed-bytes"),
        ("deferred-wal-terminal-entries", "deferred-wal-terminal-bytes"),
        ("wal-emergency-attempts", "wal-emergency-attempted-bytes"),
        ("wal-emergency-successes", "wal-emergency-success-bytes"),
        ("wal-emergency-current-attempts", "wal-emergency-current-attempted-bytes"),
        ("wal-emergency-current-successes", "wal-emergency-current-success-bytes"),
        ("wal-emergency-max-actions-per-trigger", "wal-emergency-max-bytes-per-trigger"),
    )
    for count_field, byte_field in count_byte_pairs:
        require_canonical_wal_sum(
            scalars[count_field],
            scalars[byte_field],
            f"{count_field}/{byte_field}",
        )
    require_canonical_wal_sum(wal_advice_calls, wal_advised_bytes, "class-6 advice")
    require_canonical_wal_sum(
        wal_finite_offers,
        classes[5]["offered-finite-bytes"],
        "class-6 finite offers",
    )

    require(
        scalars["deferred-wal-enqueued"]
        == scalars["deferred-wal-queued-entries"]
        + scalars["deferred-wal-inflight-entries"]
        + scalars["deferred-wal-capacity-evicted"]
        + scalars["deferred-wal-expired"]
        + scalars["deferred-wal-successes"]
        + scalars["deferred-wal-busy-dropped"]
        + scalars["deferred-wal-invalidated"]
        + scalars["deferred-wal-revoked"]
        + scalars["deferred-wal-errors"]
        + scalars["deferred-wal-flushed-entries"],
        "deferred WAL entry dispositions do not conserve enqueues",
    )
    require(
        scalars["deferred-wal-enqueued-bytes"]
        == scalars["deferred-wal-queued-bytes"]
        + scalars["deferred-wal-inflight-bytes"]
        + scalars["deferred-wal-capacity-evicted-bytes"]
        + scalars["deferred-wal-expired-bytes"]
        + scalars["deferred-wal-success-bytes"]
        + scalars["deferred-wal-busy-dropped-bytes"]
        + scalars["deferred-wal-invalidated-bytes"]
        + scalars["deferred-wal-revoked-bytes"]
        + scalars["deferred-wal-error-bytes"]
        + scalars["deferred-wal-flushed-bytes"],
        "deferred WAL byte dispositions do not conserve enqueues",
    )
    terminal_entry_sum = sum(
        scalars[field]
        for field in (
            "deferred-wal-successes",
            "deferred-wal-capacity-evicted",
            "deferred-wal-expired",
            "deferred-wal-busy-dropped",
            "deferred-wal-invalidated",
            "deferred-wal-revoked",
            "deferred-wal-errors",
            "deferred-wal-flushed-entries",
        )
    )
    terminal_byte_sum = sum(
        scalars[field]
        for field in (
            "deferred-wal-success-bytes",
            "deferred-wal-capacity-evicted-bytes",
            "deferred-wal-expired-bytes",
            "deferred-wal-busy-dropped-bytes",
            "deferred-wal-invalidated-bytes",
            "deferred-wal-revoked-bytes",
            "deferred-wal-error-bytes",
            "deferred-wal-flushed-bytes",
        )
    )
    require(
        scalars["deferred-wal-terminal-entries"] == terminal_entry_sum
        and scalars["deferred-wal-terminal-bytes"] == terminal_byte_sum
        and scalars["deferred-wal-enqueued"] == terminal_entry_sum
        and scalars["deferred-wal-enqueued-bytes"] == terminal_byte_sum,
        "terminal deferred WAL conservation fields differ from exact dispositions",
    )
    require(
        scalars["deferred-wal-attempts"]
        == scalars["deferred-wal-successes"]
        + scalars["deferred-wal-busy"]
        + scalars["deferred-wal-invalidated"]
        + scalars["deferred-wal-errors"],
        "deferred WAL attempt dispositions do not conserve attempts",
    )
    require(
        scalars["deferred-wal-busy"]
        == scalars["deferred-wal-busy-requeued"]
        + scalars["deferred-wal-busy-dropped"],
        "deferred WAL busy dispositions do not conserve attempts",
    )
    require(
        scalars["deferred-wal-busy-requeued"] == 0
        and scalars["deferred-wal-attempts"] <= scalars["deferred-wal-enqueued"]
        and scalars["deferred-wal-attempts"]
        <= scalars["deferred-wal-actionable-samples"],
        "deferred WAL work exceeds the no-retry, one-fresh-sample contract",
    )
    require(
        scalars["deferred-wal-attempted-bytes"]
        <= scalars["deferred-wal-enqueued-bytes"]
        * (CONFIG["deferred-wal-busy-retries"] + 1),
        "deferred WAL attempted bytes exceed sealed per-entry retry bounds",
    )
    require(
        scalars["deferred-wal-attempted-bytes"]
        >= scalars["deferred-wal-success-bytes"]
        + scalars["deferred-wal-busy-dropped-bytes"]
        + scalars["deferred-wal-invalidated-bytes"]
        + scalars["deferred-wal-error-bytes"],
        "deferred WAL terminal bytes exceed attempted bytes",
    )
    require(
        scalars["deferred-wal-flushes"]
        == sum(
            scalars[field]
            for field in (
                "deferred-wal-sampler-flushes",
                "deferred-wal-clock-flushes",
                "deferred-wal-breaker-flushes",
                "deferred-wal-advice-error-flushes",
                "deferred-wal-drop-flushes",
                "deferred-wal-finalization-flushes",
            )
        ),
        "deferred WAL flush reasons do not conserve flushes",
    )
    require(
        scalars["deferred-wal-flushes"]
        <= scalars["deferred-wal-flushed-entries"]
        and scalars["deferred-wal-drop-flushes"] == 0
        and scalars["deferred-wal-finalization-flushes"] <= 1,
        "terminal deferred WAL flush accounting exceeds finalization bounds",
    )
    require(
        scalars["deferred-wal-sampler-flushes"] <= scalars["sample-errors"]
        and scalars["deferred-wal-clock-flushes"] <= scalars["clock-errors"]
        and scalars["deferred-wal-advice-error-flushes"]
        <= scalars["advice-errors"],
        "deferred WAL error flush lacks its owning sampler/clock/advice error",
    )

    require(
        scalars["wal-emergency-attempts"]
        == scalars["wal-emergency-current-attempts"]
        + scalars["deferred-wal-attempts"],
        "aggregate WAL attempts differ from current plus deferred attempts",
    )
    require(
        scalars["wal-emergency-attempted-bytes"]
        == scalars["wal-emergency-current-attempted-bytes"]
        + scalars["deferred-wal-attempted-bytes"],
        "aggregate WAL attempted bytes differ from current plus deferred bytes",
    )
    require(
        scalars["wal-emergency-successes"]
        == scalars["wal-emergency-current-successes"]
        + scalars["deferred-wal-successes"],
        "aggregate WAL successes differ from current plus deferred successes",
    )
    require(
        scalars["wal-emergency-success-bytes"]
        == scalars["wal-emergency-current-success-bytes"]
        + scalars["deferred-wal-success-bytes"],
        "aggregate WAL success bytes differ from current plus deferred success bytes",
    )
    require(
        scalars["wal-emergency-current-attempts"] == 0
        and scalars["wal-emergency-current-attempted-bytes"] == 0
        and scalars["wal-emergency-current-successes"] == 0
        and scalars["wal-emergency-current-success-bytes"] == 0
        and scalars["wal-emergency-forced-samples"] == 0,
        "adaptive v5 receipt contains a forbidden immediate WAL action",
    )
    require(
        scalars["wal-emergency-successes"] == wal_advice_calls
        and scalars["wal-emergency-success-bytes"] == wal_advised_bytes,
        "aggregate WAL successes differ from class-6 advice",
    )
    require(
        scalars["wal-emergency-current-successes"]
        <= scalars["wal-emergency-current-attempts"]
        and scalars["deferred-wal-successes"] <= scalars["deferred-wal-attempts"],
        "WAL successes exceed attempts",
    )
    require(
        scalars["wal-emergency-success-bytes"]
        <= scalars["wal-emergency-attempted-bytes"]
        and scalars["wal-emergency-current-success-bytes"]
        <= scalars["wal-emergency-current-attempted-bytes"]
        and scalars["deferred-wal-success-bytes"]
        <= scalars["deferred-wal-attempted-bytes"],
        "WAL successful bytes exceed attempted bytes",
    )
    current_wal_errors = (
        scalars["wal-emergency-current-attempts"]
        - scalars["wal-emergency-current-successes"]
    )
    current_wal_error_bytes = (
        scalars["wal-emergency-current-attempted-bytes"]
        - scalars["wal-emergency-current-success-bytes"]
    )
    require_canonical_wal_sum(
        current_wal_errors,
        current_wal_error_bytes,
        "current WAL failed outcomes",
    )
    deferred_wal_busy_bytes = (
        scalars["deferred-wal-attempted-bytes"]
        - scalars["deferred-wal-success-bytes"]
        - scalars["deferred-wal-invalidated-bytes"]
        - scalars["deferred-wal-error-bytes"]
    )
    require_canonical_wal_sum(
        scalars["deferred-wal-busy"],
        deferred_wal_busy_bytes,
        "deferred WAL busy outcomes",
    )
    require(
        deferred_wal_busy_bytes >= scalars["deferred-wal-busy-dropped-bytes"],
        "deferred WAL busy-dropped bytes exceed all busy outcome bytes",
    )
    require_canonical_wal_sum(
        scalars["deferred-wal-busy-requeued"],
        deferred_wal_busy_bytes - scalars["deferred-wal-busy-dropped-bytes"],
        "deferred WAL busy-requeued outcomes",
    )
    require(
        wal_advice_errors
        == current_wal_errors
        + scalars["deferred-wal-errors"]
        + scalars["deferred-wal-pin-errors"],
        "class-6 advice errors differ from WAL action errors",
    )
    require(
        scalars["wal-dirty-veto-bypasses"]
        <= scalars["deferred-wal-successes"]
        and scalars["wal-dirty-veto-bypass-bytes"]
        <= scalars["deferred-wal-success-bytes"],
        "WAL dirty-veto bypasses exceed successful descriptor-ledger actions",
    )

    require(
        scalars["deferred-wal-high-entries"] <= CONFIG["deferred-wal-max-entries"]
        and scalars["deferred-wal-high-entries"] <= CONFIG["deferred-wal-max-fds"]
        and scalars["deferred-wal-high-bytes"] <= CONFIG["deferred-wal-max-bytes"],
        "deferred WAL high-water mark exceeds configured capacity",
    )
    require(
        (scalars["deferred-wal-enqueued"] == 0)
        == (scalars["deferred-wal-high-entries"] == 0)
        and scalars["deferred-wal-high-entries"]
        <= scalars["deferred-wal-enqueued"]
        and scalars["deferred-wal-high-bytes"]
        <= scalars["deferred-wal-enqueued-bytes"],
        "deferred WAL high-water mark does not reconcile with enqueues",
    )
    require(
        scalars["deferred-wal-queued-entries"]
        + scalars["deferred-wal-inflight-entries"]
        <= scalars["deferred-wal-high-entries"]
        and scalars["deferred-wal-queued-bytes"]
        + scalars["deferred-wal-inflight-bytes"]
        <= scalars["deferred-wal-high-bytes"],
        "deferred WAL occupancy exceeds its high-water mark",
    )
    require(
        scalars["deferred-wal-high-bytes"]
        >= scalars["deferred-wal-high-entries"] * resolved_page_bytes
        and scalars["deferred-wal-high-bytes"]
        <= scalars["deferred-wal-high-entries"] * CONFIG["wal-emergency-max-bytes"],
        "deferred WAL high-water bytes cannot represent its entries",
    )
    require(
        scalars["deferred-wal-enqueued"]
        + scalars["wal-emergency-current-attempts"]
        + scalars["wal-emergency-oversize-rejects"]
        + scalars["deferred-wal-capacity-rejected"]
        + scalars["deferred-wal-sequence-rejected"]
        + scalars["deferred-wal-pin-errors"]
        + scalars["action-gate-contended-wal-pin-failures"]
        <= wal_finite_offers
        and scalars["deferred-wal-capacity-rejected"]
        + scalars["deferred-wal-sequence-rejected"]
        <= total_retained
        and scalars["deferred-wal-pin-errors"] <= wal_advice_errors,
        "deferred WAL counters exceed their owning offer dispositions",
    )
    require(
        scalars["wal-emergency-current-attempted-bytes"]
        + scalars["deferred-wal-enqueued-bytes"]
        + scalars["deferred-wal-capacity-rejected-bytes"]
        + scalars["deferred-wal-sequence-rejected-bytes"]
        <= classes[5]["offered-finite-bytes"],
        "WAL action bytes exceed class-6 finite offered bytes",
    )

    require(
        scalars["wal-emergency-attempted-bytes"]
        <= scalars["wal-emergency-attempts"] * CONFIG["wal-emergency-max-bytes"]
        and scalars["wal-emergency-current-attempted-bytes"]
        <= scalars["wal-emergency-current-attempts"]
        * CONFIG["wal-emergency-max-bytes"]
        and scalars["deferred-wal-attempted-bytes"]
        <= scalars["deferred-wal-attempts"] * CONFIG["wal-emergency-max-bytes"],
        "WAL attempted bytes exceed whole-segment action bounds",
    )
    require(
        scalars["wal-emergency-max-actions-per-trigger"] <= 1
        and scalars["wal-emergency-max-bytes-per-trigger"]
        <= CONFIG["wal-emergency-max-bytes"]
        and scalars["wal-emergency-max-bytes-per-trigger"]
        <= scalars["wal-emergency-max-actions-per-trigger"]
        * CONFIG["wal-emergency-max-bytes"],
        "WAL trigger work exceeds the sealed bound",
    )
    require(
        scalars["wal-emergency-max-actions-per-trigger"]
        <= scalars["wal-emergency-attempts"]
        and scalars["wal-emergency-max-bytes-per-trigger"]
        <= scalars["wal-emergency-attempted-bytes"],
        "WAL trigger high-water mark exceeds aggregate attempted work",
    )
    require(
        (scalars["wal-emergency-max-actions-per-trigger"] == 0)
        == (scalars["deferred-wal-attempts"] == 0)
        and scalars["deferred-wal-pressure-samples"] <= scalars["sample-count"]
        and scalars["deferred-wal-actionable-samples"]
        <= scalars["deferred-wal-pressure-samples"]
        and (
            scalars["deferred-wal-actionable-samples"] == 0
            or scalars["sample-count"] >= CONFIG["warmup-samples"]
        ),
        "WAL trigger high-water action count differs from current/deferred execution",
    )
    require(
        scalars["wal-emergency-oversize-rejects"] <= wal_finite_offers
        and scalars["wal-emergency-current-attempts"] <= wal_finite_offers,
        "WAL action counters exceed class-6 offers",
    )

    require(
        scalars["deferred-wal-revoke-errors"]
        <= scalars["deferred-wal-revoke-calls"]
        and scalars["deferred-wal-revoke-calls"] <= ((1 << 64) - 1) // 2
        and scalars["deferred-wal-revoke-sequence"]
        == 2 * scalars["deferred-wal-revoke-calls"]
        and scalars["deferred-wal-revoked"] <= scalars["deferred-wal-enqueued"],
        "synchronous deferred WAL revoke accounting differs",
    )

    require(
        scalars["action-gate-contended-calls"]
        == scalars["action-gate-contended-retained"]
        + scalars["action-gate-contended-enqueued"],
        "contended action-gate dispositions do not conserve calls",
    )
    require(
        scalars["action-gate-contended-calls"] <= total_offers
        and scalars["action-gate-contended-retained"] <= total_retained
        and scalars["action-gate-contended-enqueued"]
        <= scalars["deferred-wal-enqueued"]
        and scalars["action-gate-contended-wal-pin-failures"]
        <= scalars["action-gate-contended-retained"],
        "contended action-gate counters exceed owning dispositions",
    )
    require(
        scalars["action-gate-probe-max-ns"]
        <= scalars["action-gate-probe-total-ns"],
        "action-gate maximum probe exceeds total probe time",
    )
    require(
        scalars["finalization-quiescence-notifications"] <= 1,
        "finalization emitted more than one terminal quiescence notification",
    )

    last_sample = telemetry["last-sample"]
    return {
        "outcome": "adaptive-active",
        "reason": "none",
        "state": telemetry["state"],
        "sample_count": scalars["sample-count"],
        "last_sample_present": telemetry["last-sample"] is not None,
        "last_sample_monotonic_ns": (
            last_sample["monotonic-ns"] if last_sample is not None else None
        ),
        "last_sample_effective_limit_bytes": (
            last_sample["effective-limit-bytes"] if last_sample is not None else None
        ),
        "membership_leaf_identity": (
            f"{last_sample['membership-leaf-device']}:"
            f"{last_sample['membership-leaf-inode']}"
            if last_sample is not None
            else None
        ),
        "pressure_source_identity": (
            f"{last_sample['pressure-source-device']}:"
            f"{last_sample['pressure-source-inode']}"
            if last_sample is not None
            else None
        ),
        "valid_offers": total_offers,
        "advice_calls": total_advice_calls,
        "advised_bytes": total_advised_bytes,
        "class6_offers": wal_offers,
        "class6_advice_calls": wal_advice_calls,
        "class6_advised_bytes": wal_advised_bytes,
        "class6_advice_errors": wal_advice_errors,
        "sample_errors": scalars["sample-errors"],
        "clock_errors": scalars["clock-errors"],
        "advice_errors": scalars["advice-errors"],
        "deferred_wal_invalidated": scalars["deferred-wal-invalidated"],
        "psi_breaker_trips": scalars["psi-breaker-trips"],
        "refault_breaker_trips": scalars["refault-breaker-trips"],
        "deferred_wal_pin_errors": scalars["deferred-wal-pin-errors"],
        "deferred_wal_breaker_flushes": scalars["deferred-wal-breaker-flushes"],
        "deferred_wal_revoke_errors": scalars["deferred-wal-revoke-errors"],
        "deferred_wal_actionable_samples": scalars[
            "deferred-wal-actionable-samples"
        ],
        "action_gate_contended_wal_pin_failures": scalars[
            "action-gate-contended-wal-pin-failures"
        ],
        "wal_dirty_veto_bypasses": scalars["wal-dirty-veto-bypasses"],
        "wal_dirty_veto_bypass_bytes": scalars["wal-dirty-veto-bypass-bytes"],
    }


def validate_fallback(telemetry: dict[str, Any], runtime_abi_id: str) -> dict[str, Any]:
    require(set(telemetry) == FALLBACK_FIELDS, "adaptive fallback evidence fields differ")
    validate_fixed_identity(telemetry, runtime_abi_id)
    expected = {
        "schema": FALLBACK_SCHEMA,
        "admission": "denied",
        "requested-policy-id": POLICY_ID,
        "requested-policy-mode": POLICY_MODE,
    }
    for field, value in expected.items():
        require(telemetry[field] == value, f"adaptive fallback {field} differs")
    require(telemetry["reason"] in FALLBACK_REASONS, "adaptive fallback reason is unknown")
    return {
        "outcome": "observe-only-fallback",
        "reason": telemetry["reason"],
        "state": "not-constructed",
        "sample_count": 0,
        "last_sample_present": False,
        "last_sample_monotonic_ns": None,
        "last_sample_effective_limit_bytes": None,
        "membership_leaf_identity": None,
        "pressure_source_identity": None,
        "valid_offers": 0,
        "advice_calls": 0,
        "advised_bytes": 0,
        "class6_offers": 0,
        "class6_advice_calls": 0,
        "class6_advised_bytes": 0,
        "class6_advice_errors": 0,
        "sample_errors": 0,
        "clock_errors": 0,
        "advice_errors": 0,
        "psi_breaker_trips": 0,
        "refault_breaker_trips": 0,
        "deferred_wal_pin_errors": 0,
        "deferred_wal_breaker_flushes": 0,
        "deferred_wal_revoke_errors": 0,
        "deferred_wal_actionable_samples": 0,
        "action_gate_contended_wal_pin_failures": 0,
        "wal_dirty_veto_bypasses": 0,
        "wal_dirty_veto_bypass_bytes": 0,
    }


def enforce_acceptance_policy(
    result: dict[str, Any],
    acceptance_policy: str,
    cgroup_identity: str | None,
    cgroup_memory_max_bytes: int | None,
    cgroup_memory_high_bytes: int | None,
    cgroup_swap_max_bytes: int | None,
    sample_window_start_ns: int | None,
    sample_window_end_ns: int | None,
    measurement_id: str | None,
    target: str | None,
) -> None:
    require(
        acceptance_policy in ACCEPTANCE_POLICIES,
        f"adaptive acceptance policy is unknown: {acceptance_policy!r}",
    )
    if acceptance_policy == PORTABLE_ACCEPTANCE_POLICY:
        return

    require(
        result["outcome"] == "adaptive-active",
        "constrained Linux WAL-action evidence requires adaptive-active admission",
    )
    require(
        result["class6_offers"] > 0,
        "constrained Linux WAL-action evidence requires class 6 offers",
    )
    require(
        result["class6_advice_calls"] > 0,
        "constrained Linux WAL-action evidence requires class 6 advice calls",
    )
    require(
        result["class6_advised_bytes"] > 0,
        "constrained Linux WAL-action evidence requires class 6 advised bytes",
    )
    require(
        result["last_sample_present"],
        "constrained Linux WAL-action evidence requires current admitted pressure evidence",
    )
    require(
        cgroup_identity is not None
        and CGROUP_IDENTITY_RE.fullmatch(cgroup_identity) is not None,
        "constrained Linux WAL-action evidence requires an exact cgroup device:inode identity",
    )
    require(
        cgroup_memory_max_bytes is not None
        and cgroup_memory_high_bytes is not None
        and cgroup_swap_max_bytes is not None
        and cgroup_memory_max_bytes > 0
        and cgroup_memory_high_bytes > 0
        and cgroup_memory_high_bytes <= cgroup_memory_max_bytes
        and cgroup_swap_max_bytes >= 0,
        "constrained Linux WAL-action evidence requires exact finite leaf cgroup limits",
    )
    require(
        sample_window_start_ns is not None
        and sample_window_end_ns is not None
        and 0 <= sample_window_start_ns < sample_window_end_ns <= (1 << 64) - 1,
        "constrained Linux WAL-action evidence requires an exact monotonic sample window",
    )
    require(
        measurement_id is not None
        and MEASUREMENT_ID_RE.fullmatch(measurement_id) is not None
        and target == "wasix",
        "constrained Linux WAL-action evidence requires an exact WASIX measurement identity",
    )
    require(
        result["membership_leaf_identity"] == cgroup_identity,
        "adaptive telemetry membership leaf differs from the measured cgroup identity",
    )
    require(
        result["pressure_source_identity"] == cgroup_identity,
        "adaptive telemetry pressure source differs from the measured cgroup identity",
    )
    require(
        sample_window_start_ns
        <= result["last_sample_monotonic_ns"]
        <= sample_window_end_ns,
        "adaptive telemetry last sample falls outside the measured target lifetime",
    )
    require(
        result["last_sample_effective_limit_bytes"]
        == min(cgroup_memory_max_bytes, cgroup_memory_high_bytes),
        "adaptive telemetry effective limit differs from min(leaf MemoryMax, leaf MemoryHigh)",
    )
    require(
        result["state"] != "degraded"
        and result["psi_breaker_trips"] == 0
        and result["refault_breaker_trips"] == 0,
        "constrained Linux WAL-action evidence contains degradation or breaker trips",
    )
    require(
        result["sample_errors"] == 0
        and result["clock_errors"] == 0
        and result["advice_errors"] == result["deferred_wal_invalidated"]
        and result["class6_advice_errors"] == 0
        and result["deferred_wal_pin_errors"] == 0
        and result["deferred_wal_breaker_flushes"] == 0
        and result["deferred_wal_revoke_errors"] == 0
        and result["action_gate_contended_wal_pin_failures"] == 0,
        "constrained Linux WAL-action evidence contains telemetry, advice, or WAL pin errors",
    )
    require(
        result["deferred_wal_actionable_samples"] > 0,
        "constrained Linux WAL-action evidence lacks a fresh L2/L3 pressure trigger",
    )


def validate(
    telemetry_path: Path,
    manifest_path: Path,
    output: Path,
    acceptance_policy: str,
    cgroup_identity: str | None,
    cgroup_memory_max_bytes: int | None,
    cgroup_memory_high_bytes: int | None,
    cgroup_swap_max_bytes: int | None,
    sample_window_start_ns: int | None,
    sample_window_end_ns: int | None,
    measurement_id: str | None,
    target: str | None,
) -> None:
    require(not os.path.lexists(output), f"validation output already exists: {output}")
    telemetry_data = read_regular_stable(telemetry_path, "adaptive file-cache telemetry")
    manifest_data = read_regular_stable(manifest_path, "sealed manifest")
    validator_data = read_regular_stable(Path(__file__), "validator")
    telemetry = parse_object(telemetry_data, "adaptive file-cache telemetry JSON")
    manifest = parse_object(manifest_data, "sealed manifest JSON")
    runtime_abi_id = manifest_contract(manifest)
    schema = telemetry.get("schema")
    if schema == ACTIVE_SCHEMA:
        result = validate_active(telemetry, runtime_abi_id)
    elif schema == FALLBACK_SCHEMA:
        result = validate_fallback(telemetry, runtime_abi_id)
    else:
        raise ValidationError(f"adaptive telemetry schema is not admitted: {schema!r}")
    enforce_acceptance_policy(
        result,
        acceptance_policy,
        cgroup_identity,
        cgroup_memory_max_bytes,
        cgroup_memory_high_bytes,
        cgroup_swap_max_bytes,
        sample_window_start_ns,
        sample_window_end_ns,
        measurement_id,
        target,
    )

    def receipt_value(value: Any) -> str:
        return "none" if value is None else str(value)

    payload = (
        "schema_version\tstatus\toutcome\treason\tworkload_id\tpolicy_id\t"
        "config_id\tconfig_sha256\tacceptance_policy\truntime_abi_id\t"
        "state\tsample_count\t"
        "valid_offers\tadvice_calls\tadvised_bytes\t"
        "class6_offers\tclass6_advice_calls\tclass6_advised_bytes\t"
        "class6_advice_errors\tsample_errors\tclock_errors\tadvice_errors\t"
        "wal_dirty_veto_bypasses\twal_dirty_veto_bypass_bytes\t"
        "telemetry_sha256\tmanifest_sha256\tvalidator_sha256\t"
        "cgroup_identity\tcgroup_memory_max_bytes\t"
        "cgroup_memory_high_bytes\tcgroup_swap_max_bytes\t"
        "sample_window_start_monotonic_ns\t"
        "sample_window_end_monotonic_ns\t"
        "membership_leaf_identity\tpressure_source_identity\t"
        "last_sample_monotonic_ns\tlast_sample_effective_limit_bytes\t"
        "measurement_id\ttarget\n"
        f"{RESULT_SCHEMA}\tpassed\t{result['outcome']}\t{result['reason']}\t"
        f"runtime:postgres\t{POLICY_ID}\t{CONFIG_ID}\t{CONFIG_SHA256}\t"
        f"{acceptance_policy}\t{runtime_abi_id}\t{result['state']}\t"
        f"{result['sample_count']}\t"
        f"{result['valid_offers']}\t{result['advice_calls']}\t"
        f"{result['advised_bytes']}\t{result['class6_offers']}\t"
        f"{result['class6_advice_calls']}\t{result['class6_advised_bytes']}\t"
        f"{result['class6_advice_errors']}\t{result['sample_errors']}\t"
        f"{result['clock_errors']}\t{result['advice_errors']}\t"
        f"{result['wal_dirty_veto_bypasses']}\t"
        f"{result['wal_dirty_veto_bypass_bytes']}\t"
        f"{hashlib.sha256(telemetry_data).hexdigest()}\t"
        f"{hashlib.sha256(manifest_data).hexdigest()}\t"
        f"{hashlib.sha256(validator_data).hexdigest()}\t"
        f"{receipt_value(cgroup_identity)}\t"
        f"{receipt_value(cgroup_memory_max_bytes)}\t"
        f"{receipt_value(cgroup_memory_high_bytes)}\t"
        f"{receipt_value(cgroup_swap_max_bytes)}\t"
        f"{receipt_value(sample_window_start_ns)}\t"
        f"{receipt_value(sample_window_end_ns)}\t"
        f"{receipt_value(result['membership_leaf_identity'])}\t"
        f"{receipt_value(result['pressure_source_identity'])}\t"
        f"{receipt_value(result['last_sample_monotonic_ns'])}\t"
        f"{receipt_value(result['last_sample_effective_limit_bytes'])}\t"
        f"{receipt_value(measurement_id)}\t{receipt_value(target)}\n"
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
        "--acceptance-policy",
        choices=sorted(ACCEPTANCE_POLICIES),
        default=PORTABLE_ACCEPTANCE_POLICY,
        help=(
            "portable-correctness-v1 accepts exact active or fallback evidence; "
            "constrained-linux-wal-action-v1 requires active class-6 cache-drop action"
        ),
    )
    parser.add_argument("--cgroup-identity")
    parser.add_argument("--cgroup-memory-max-bytes", type=int)
    parser.add_argument("--cgroup-memory-high-bytes", type=int)
    parser.add_argument("--cgroup-swap-max-bytes", type=int)
    parser.add_argument("--sample-window-start-monotonic-ns", type=int)
    parser.add_argument("--sample-window-end-monotonic-ns", type=int)
    parser.add_argument("--measurement-id")
    parser.add_argument("--target", choices=("wasix",))
    arguments = parser.parse_args(argv)
    try:
        validate(
            arguments.telemetry,
            arguments.manifest,
            arguments.output,
            arguments.acceptance_policy,
            arguments.cgroup_identity,
            arguments.cgroup_memory_max_bytes,
            arguments.cgroup_memory_high_bytes,
            arguments.cgroup_swap_max_bytes,
            arguments.sample_window_start_monotonic_ns,
            arguments.sample_window_end_monotonic_ns,
            arguments.measurement_id,
            arguments.target,
        )
        return 0
    except (OSError, PublicationError, ValidationError) as error:
        print(f"adaptive file-cache telemetry validation failed: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
