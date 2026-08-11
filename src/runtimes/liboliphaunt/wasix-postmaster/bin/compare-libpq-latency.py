#!/usr/bin/env python3
"""Validate and compare paired native/WASIX true-libpq latency evidence.

The input is a run index emitted by qualify-wasix-libpq-latency.sh.  This
program deliberately re-opens the benchmark's raw samples and recomputes its
nearest-rank percentiles.  A benchmark summary is evidence, not authority.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import io
import math
import os
import re
import secrets
import sys
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation, getcontext
from pathlib import Path
from typing import Iterable, Sequence

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))
from durable_publication import (  # noqa: E402
    PublicationError,
    publish_set as publish_no_replace_set,
    remove_private as remove_publication_source,
    stable_regular_bytes,
    write_bytes as write_publication_source,
)


getcontext().prec = 40

RUN_HEADER = [
    "schema_version",
    "block",
    "order",
    "pair",
    "position",
    "target",
    "run_label",
    "harness_status",
    "report_dir",
    "effective_settings",
    "effective_settings_sha256",
    "carrier_closure_identity",
    "native_oracle_identity",
    "postgres_profile_resolution_identity",
    "qualification_plan_identity",
]
PROFILE_COMPARISON_HEADER = [
    "schema_version",
    "block",
    "order",
    "pair",
    "native_settings",
    "wasix_settings",
    "comparison",
    "comparison_sha256",
    "status",
]
EFFECTIVE_SETTINGS_HEADER = ["name", "setting", "unit", "source"]
PROFILE_INPUT_HEADER = ["kind", "id", "path", "sha256"]
PROFILE_RESOLUTION_HEADER = [
    "name",
    "value",
    "source",
    "profile_id",
    "profile_path",
    "profile_sha256",
    "precedence",
]
PROFILE_RESULT_HEADER = [
    "name",
    "native_setting",
    "native_unit",
    "native_source",
    "wasix_setting",
    "wasix_unit",
    "wasix_source",
    "status",
]
REQUIRED_SETTINGS = (
    "autovacuum_worker_slots",
    "backend_flush_after",
    "bgwriter_flush_after",
    "checkpoint_flush_after",
    "checkpoint_timeout",
    "fsync",
    "full_page_writes",
    "io_method",
    "max_connections",
    "max_wal_senders",
    "max_worker_processes",
    "max_wal_size",
    "min_wal_size",
    "shared_buffers",
    "synchronous_commit",
    "wal_segment_size",
)
LATENCY_HEADER = [
    "schema_version",
    "target",
    "mode",
    "status",
    "clock",
    "warmup_count",
    "sample_count",
    "p50_ns",
    "p95_ns",
    "p99_ns",
    "p50_ms",
    "p95_ms",
    "p99_ms",
    "raw_tsv",
    "libpq_path",
    "libpq_sha256",
    "probe_sha256",
]
RAW_HEADER = [
    "schema_version",
    "mode",
    "phase",
    "sample_index",
    "duration_ns",
    "status",
]
HOST_FD_HEADER = [
    "target",
    "mode",
    "before_open_fds",
    "after_open_fds",
    "quiescent_open_fds",
    "quiescent_growth",
    "allowance",
    "status",
]
SERVER_LIMITS_HEADER = [
    "target",
    "requested_soft_nofile",
    "pre_soft_nofile",
    "pre_hard_nofile",
    "actual_soft_nofile",
    "actual_hard_nofile",
    "status",
    "launch_record",
]
SERVER_LIFECYCLE_HEADER = [
    "target",
    "server_pid",
    "server_pgid",
    "server_birth_identity",
    "cgroup_path",
    "cgroup_identity",
    "orderly_int",
    "forced",
    "wait_status",
    "clean_shutdown_marker",
    "process_group_residue",
    "cgroup_residue",
    "port_residue",
    "status",
    "report",
]
INSTRUMENTATION_HEADER = [
    "schema_version",
    "lane",
    "wasix_perf_stats",
    "wait_dump_policy",
    "wait_dump_interval_ms",
    "wait_dump_max_per_wait",
    "wait_dump_verbose",
    "fence_protocol",
    "sanitized_environment",
]
WAIT_DUMP_ENVIRONMENT = (
    "WASIX_PERF_WAIT_DUMP_INTERVAL_MS",
    "WASIX_PERF_WAIT_DUMP_FILE",
    "WASIX_PERF_WAIT_DUMP_MAX_PER_WAIT",
    "WASIX_PERF_WAIT_DUMP_VERBOSE",
    "WASIX_WAIT_DUMP_INTERVAL_MS",
    "WASIX_WAIT_DUMP_FILE",
    "WASIX_WAIT_DUMP_MAX_PER_WAIT",
    "WASIX_WAIT_DUMP_VERBOSE",
    "WASIX_WAIT_DUMP_FENCE_REQUEST_FILE",
    "WASIX_WAIT_DUMP_FENCE_ACK_FILE",
)
NATIVE_MANIFEST_HEADER = ["schema", "kind", "path", "bytes", "sha256_or_target"]
RECEIPT_HEADER = [
    "schema_version",
    "block",
    "order",
    "pair",
    "position",
    "target",
    "mode",
    "run_label",
    "status",
    "clock",
    "warmup_count",
    "sample_count",
    "p50_ns",
    "p95_ns",
    "p99_ns",
    "raw_tsv",
    "raw_sha256",
    "latency_summary",
    "latency_summary_sha256",
    "host_fd_churn_sha256",
    "server_limits_sha256",
    "server_lifecycle_sha256",
    "instrumentation_policy_sha256",
    "effective_settings_sha256",
    "carrier_closure_identity",
    "native_oracle_identity",
    "probe_source_sha256",
    "probe_path",
    "probe_sha256",
    "libpq_path",
    "libpq_sha256",
    "postgres_profile_resolution_identity",
    "qualification_plan_identity",
    "report_dir",
]
PAIR_HEADER = [
    "schema_version",
    "block",
    "order",
    "pair",
    "first_target",
    "second_target",
    "mode",
    "native_p95_ns",
    "wasix_p95_ns",
    "paired_p95_ratio",
    "native_p99_ns",
    "wasix_p99_ns",
    "paired_p99_ratio",
]
SUMMARY_HEADER = [
    "schema_version",
    "mode",
    "status",
    "server_pairs",
    "native_server_runs",
    "wasix_server_runs",
    "max_p95_ratio",
    "max_p99_ratio",
    "max_wasix_p95_ms",
    "max_wasix_p99_ms",
    "paired_p95_ratio_p50",
    "paired_p95_ratio_p95",
    "paired_p99_ratio_p50",
    "paired_p99_ratio_p95",
    "wasix_p95_ms_p50",
    "wasix_p95_ms_p95",
    "wasix_p99_ms_p50",
    "wasix_p99_ms_p95",
    "detail",
]
IDENTITY_HEADER = [
    "schema_version",
    "carrier_closure_identity",
    "native_oracle_identity",
    "probe_source_sha256",
    "representative_probe_path",
    "probe_sha256",
    "libpq_path",
    "libpq_sha256",
    "postgres_profile_resolution_identity",
    "qualification_plan_identity",
]

SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
LABEL_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
MODES = ("persistent", "reconnect")


class EvidenceError(RuntimeError):
    pass


def die(message: str) -> "None":
    raise EvidenceError(message)


def canonical_positive(value: str, name: str, maximum: int = 10_000_000) -> int:
    if not re.fullmatch(r"[1-9][0-9]*", value):
        die(f"{name} must be a canonical positive integer: {value!r}")
    number = int(value)
    if number > maximum:
        die(f"{name} exceeds {maximum}: {number}")
    return number


def canonical_nonnegative(value: str, name: str, maximum: int = 10_000_000) -> int:
    if not re.fullmatch(r"0|[1-9][0-9]*", value):
        die(f"{name} must be a canonical nonnegative integer: {value!r}")
    number = int(value)
    if number > maximum:
        die(f"{name} exceeds {maximum}: {number}")
    return number


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def require_sha256(value: str, name: str) -> str:
    if not SHA256_RE.fullmatch(value):
        die(f"{name} is not a lowercase SHA-256: {value!r}")
    return value


def read_regular_bytes(path: Path, name: str) -> bytes:
    try:
        return stable_regular_bytes(path)
    except (OSError, PublicationError) as exc:
        die(f"cannot read {name} {path}: {exc}")


def read_tsv(path: Path, header: Sequence[str], name: str) -> tuple[list[dict[str, str]], bytes]:
    data = read_regular_bytes(path, name)
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError as exc:
        die(f"{name} is not UTF-8: {path}: {exc}")
    if "\r" in text or "\0" in text:
        die(f"{name} contains forbidden control characters: {path}")
    rows = list(csv.reader(text.splitlines(), delimiter="\t", strict=True))
    if not rows or rows[0] != list(header):
        actual = "<empty>" if not rows else "\t".join(rows[0])
        die(f"{name} has an unexpected header: {actual}")
    if any(len(row) != len(header) for row in rows[1:]):
        die(f"{name} has a malformed row: {path}")
    return [dict(zip(header, row, strict=True)) for row in rows[1:]], data


def nearest_rank(values: Sequence[Decimal | int], percentile: int):
    if not values:
        die("cannot calculate a percentile over an empty sample")
    index = math.ceil(len(values) * percentile / 100) - 1
    return sorted(values)[index]


def decimal_arg(value: str, name: str) -> Decimal:
    try:
        parsed = Decimal(value)
    except InvalidOperation:
        die(f"{name} must be a decimal: {value!r}")
    if not parsed.is_finite() or parsed <= 0:
        die(f"{name} must be finite and greater than zero: {value!r}")
    return parsed


def format_decimal(value: Decimal) -> str:
    result = format(value.quantize(Decimal("0.000000001")), "f")
    return result.rstrip("0").rstrip(".") if "." in result else result


def ns_to_ms(value: int) -> Decimal:
    return Decimal(value) / Decimal(1_000_000)


def validate_raw(path: Path, mode: str, warmup: int, samples: int) -> tuple[dict[str, int], str]:
    rows, data = read_tsv(path, RAW_HEADER, "raw latency evidence")
    expected_rows = warmup + samples
    if len(rows) != expected_rows:
        die(f"raw latency row count mismatch for {path}: expected {expected_rows}, got {len(rows)}")
    durations: list[int] = []
    seen_measure = False
    counts = {"warmup": 0, "measure": 0}
    for row in rows:
        if row["schema_version"] != "1" or row["mode"] != mode or row["status"] != "ok":
            die(f"raw latency identity/status mismatch in {path}")
        phase = row["phase"]
        if phase not in counts:
            die(f"invalid raw latency phase in {path}: {phase!r}")
        counts[phase] += 1
        index = canonical_positive(row["sample_index"], "raw sample_index")
        if index != counts[phase]:
            die(f"non-contiguous {phase} sample index in {path}: {index}")
        duration = canonical_positive(row["duration_ns"], "raw duration_ns", maximum=10**15)
        if phase == "measure":
            seen_measure = True
            durations.append(duration)
        elif seen_measure:
            die(f"warmup sample follows measurement sample in {path}")
    if counts != {"warmup": warmup, "measure": samples}:
        die(f"raw latency phase counts mismatch in {path}: {counts}")
    return {
        "p50_ns": nearest_rank(durations, 50),
        "p95_ns": nearest_rank(durations, 95),
        "p99_ns": nearest_rank(durations, 99),
    }, sha256_bytes(data)


def parse_native_oracle(path: Path, expected_identity: str, install: Path) -> set[tuple[str, str]]:
    rows, data = read_tsv(path, NATIVE_MANIFEST_HEADER, "native oracle manifest")
    if sha256_bytes(data) != expected_identity:
        die("native oracle manifest does not match the declared frozen identity")
    allowed: set[tuple[str, str]] = set()
    seen: set[str] = set()
    for row in rows:
        if row["schema"] != "oliphaunt.wasix-postmaster.native-oracle.v1":
            die("native oracle manifest has an unexpected schema")
        relative = row["path"]
        if relative in seen or relative.startswith("/") or ".." in Path(relative).parts:
            die(f"native oracle manifest has an unsafe or duplicate path: {relative!r}")
        seen.add(relative)
        if row["kind"] == "file":
            canonical_nonnegative(row["bytes"], "native oracle bytes", maximum=10**12)
            digest = require_sha256(row["sha256_or_target"], "native oracle file digest")
            if Path(relative).name.startswith("libpq.") or Path(relative).name == "libpq.a":
                allowed.add((str((install / relative).resolve()), digest))
        elif row["kind"] != "symlink":
            die(f"native oracle manifest has an unexpected kind: {row['kind']!r}")
    if not allowed:
        die("native oracle manifest contains no regular libpq artifact")
    return allowed


@dataclass(frozen=True)
class Run:
    block: int
    order: str
    pair: int
    position: int
    target: str
    label: str
    report: Path
    settings: Path
    settings_sha256: str


@dataclass(frozen=True)
class Sample:
    run: Run
    mode: str
    p50_ns: int
    p95_ns: int
    p99_ns: int
    raw: Path
    raw_sha256: str
    summary: Path
    summary_sha256: str
    host_fd_sha256: str
    server_limits_sha256: str
    server_lifecycle_sha256: str
    instrumentation_policy_sha256: str
    probe_sha256: str
    probe_path: Path
    libpq_path: str
    libpq_sha256: str


def validate_run_index(args: argparse.Namespace) -> list[Run]:
    rows, _ = read_tsv(args.runs, RUN_HEADER, "latency run index")
    expected_count = args.expected_blocks * 4
    if len(rows) != expected_count:
        die(f"run index row count mismatch: expected {expected_count}, got {len(rows)}")
    runs: list[Run] = []
    seen_labels: set[str] = set()
    seen_reports: set[Path] = set()
    seen_keys: set[tuple[int, int]] = set()
    for row in rows:
        if row["schema_version"] != "1":
            die("run index contains an unexpected schema version")
        block = canonical_positive(row["block"], "run block")
        pair = canonical_positive(row["pair"], "run pair")
        position = canonical_positive(row["position"], "run position")
        if not (1 <= block <= args.expected_blocks and pair in (1, 2) and position in (1, 2, 3, 4)):
            die("run index block/pair/position is out of range")
        expected_order = "ABBA" if block % 2 else "BAAB"
        if row["order"] != expected_order:
            die(f"block {block} must use {expected_order}, got {row['order']!r}")
        expected_targets = ("native", "wasix", "wasix", "native") if expected_order == "ABBA" else ("wasix", "native", "native", "wasix")
        if row["target"] != expected_targets[position - 1] or pair != (position + 1) // 2:
            die(f"run index violates {expected_order} pairing at block {block}, position {position}")
        key = (block, position)
        if key in seen_keys:
            die(f"duplicate run index position: block {block}, position {position}")
        seen_keys.add(key)
        if row["harness_status"] != "0":
            die(f"benchmark run did not pass: {row['run_label']} status={row['harness_status']}")
        label = row["run_label"]
        if not LABEL_RE.fullmatch(label) or label in seen_labels:
            die(f"unsafe or duplicate run label: {label!r}")
        seen_labels.add(label)
        report = Path(row["report_dir"])
        expected_report = args.benchmark_reports_root / label
        if (
            report != expected_report
            or not report.is_absolute()
            or report in seen_reports
            or report.is_symlink()
            or not report.is_dir()
        ):
            die(f"run report is not a unique absolute non-symlink directory: {report}")
        seen_reports.add(report)
        settings = Path(row["effective_settings"])
        expected_settings = report / row["target"] / "effective-postgres-settings.tsv"
        if settings != expected_settings:
            die(f"effective settings path is not bound to its report: {settings}")
        settings_data = read_regular_bytes(settings, "effective PostgreSQL settings")
        settings_sha = require_sha256(row["effective_settings_sha256"], "effective settings SHA-256")
        if sha256_bytes(settings_data) != settings_sha:
            die(f"effective settings hash mismatch: {settings}")
        if row["carrier_closure_identity"] != args.carrier_identity:
            die(f"carrier closure identity mismatch in run {label}")
        if row["native_oracle_identity"] != args.native_oracle_identity:
            die(f"native oracle identity mismatch in run {label}")
        if row["postgres_profile_resolution_identity"] != args.profile_identity:
            die(f"PostgreSQL profile identity mismatch in run {label}")
        if row["qualification_plan_identity"] != args.plan_identity:
            die(f"qualification plan identity mismatch in run {label}")
        runs.append(Run(block, expected_order, pair, position, row["target"], label, report, settings, settings_sha))
    if seen_keys != {(block, position) for block in range(1, args.expected_blocks + 1) for position in range(1, 5)}:
        die("run index is not a complete balanced block matrix")
    return sorted(runs, key=lambda run: (run.block, run.position))


def validate_profile_comparisons(args: argparse.Namespace, runs: Sequence[Run]) -> None:
    rows, _ = read_tsv(args.profile_comparisons, PROFILE_COMPARISON_HEADER, "profile comparison index")
    expected = args.expected_blocks * 2
    if len(rows) != expected:
        die(f"profile comparison row count mismatch: expected {expected}, got {len(rows)}")
    by_key = {(run.block, run.pair, run.target): run for run in runs}
    seen: set[tuple[int, int]] = set()
    for row in rows:
        if row["schema_version"] != "1":
            die("profile comparison has an unexpected schema version")
        block = canonical_positive(row["block"], "profile comparison block")
        pair = canonical_positive(row["pair"], "profile comparison pair")
        key = (block, pair)
        if key in seen or key not in {(b, p) for b in range(1, args.expected_blocks + 1) for p in (1, 2)}:
            die(f"duplicate or unexpected profile comparison pair: {key}")
        seen.add(key)
        expected_order = "ABBA" if block % 2 else "BAAB"
        if row["order"] != expected_order or row["status"] != "passed":
            die(f"profile comparison did not pass for block {block}, pair {pair}")
        native = by_key[(block, pair, "native")]
        wasix = by_key[(block, pair, "wasix")]
        if Path(row["native_settings"]) != native.settings or Path(row["wasix_settings"]) != wasix.settings:
            die(f"profile comparison paths are not bound to block {block}, pair {pair}")
        comparison = Path(row["comparison"])
        comparison_data = read_regular_bytes(comparison, "PostgreSQL settings comparison")
        if sha256_bytes(comparison_data) != require_sha256(row["comparison_sha256"], "profile comparison SHA-256"):
            die(f"profile comparison hash mismatch: {comparison}")
        native_values = validate_effective_settings(native.settings)
        wasix_values = validate_effective_settings(wasix.settings)
        if native_values != wasix_values:
            die(f"native/WASIX effective settings differ for block {block}, pair {pair}")
        result_rows, result_data = read_tsv(comparison, PROFILE_RESULT_HEADER, "PostgreSQL settings comparison")
        if result_data != comparison_data or len(result_rows) != len(REQUIRED_SETTINGS):
            die(f"PostgreSQL settings comparison row count is invalid: {comparison}")
        for expected_name, result in zip(REQUIRED_SETTINGS, result_rows, strict=True):
            expected = native_values[expected_name]
            if (
                result["name"] != expected_name
                or result["status"] != "matched"
                or (result["native_setting"], result["native_unit"], result["native_source"]) != expected
                or (result["wasix_setting"], result["wasix_unit"], result["wasix_source"]) != expected
            ):
                die(f"PostgreSQL settings comparison is not exact: {comparison}")


def validate_effective_settings(path: Path) -> dict[str, tuple[str, str, str]]:
    rows, _ = read_tsv(path, EFFECTIVE_SETTINGS_HEADER, "effective PostgreSQL settings")
    values: dict[str, tuple[str, str, str]] = {}
    for row in rows:
        name = row["name"]
        if not name or name in values:
            die(f"effective PostgreSQL settings contain a duplicate/empty name: {path}")
        values[name] = (row["setting"], row["unit"], row["source"])
    if set(values) != set(REQUIRED_SETTINGS):
        die(
            f"effective PostgreSQL settings key set mismatch: {path}: "
            f"missing={sorted(set(REQUIRED_SETTINGS) - set(values))}, "
            f"extra={sorted(set(values) - set(REQUIRED_SETTINGS))}"
        )
    return values


def validate_auxiliary_artifacts(run: Run) -> tuple[str, str, str, str]:
    fd_rows, fd_data = read_tsv(run.report / "host-fd-churn-summary.tsv", HOST_FD_HEADER, "host FD churn summary")
    if len(fd_rows) != 2 or {row["mode"] for row in fd_rows} != set(MODES):
        die(f"host FD churn summary is incomplete: {run.report}")
    for row in fd_rows:
        if row["target"] != run.target or row["status"] != "passed" or row["allowance"] != "0" or row["quiescent_growth"] != "0":
            die(f"host FD churn did not pass with zero allowance: {run.report}")

    limit_rows, limit_data = read_tsv(run.report / "server-limits.tsv", SERVER_LIMITS_HEADER, "server limits summary")
    if len(limit_rows) != 1:
        die(f"server limits summary must contain exactly one row: {run.report}")
    limit = limit_rows[0]
    if limit["target"] != run.target or limit["status"] != "passed" or limit["requested_soft_nofile"] != "1024" or limit["actual_soft_nofile"] != "1024":
        die(f"server limit setup did not pass with the declared 1024-FD lane: {run.report}")

    lifecycle_rows, lifecycle_data = read_tsv(run.report / "server-lifecycle.tsv", SERVER_LIFECYCLE_HEADER, "server lifecycle summary")
    if len(lifecycle_rows) != 1:
        die(f"server lifecycle summary must contain exactly one row: {run.report}")
    lifecycle = lifecycle_rows[0]
    if (
        lifecycle["target"] != run.target
        or lifecycle["status"] != "passed"
        or lifecycle["orderly_int"] != "1"
        or lifecycle["forced"] != "none"
        or lifecycle["wait_status"] != "0"
        or lifecycle["clean_shutdown_marker"] != "1"
        or lifecycle["process_group_residue"] != "0"
        or lifecycle["cgroup_residue"] != "0"
        or lifecycle["port_residue"] != "0"
    ):
        die(f"server lifecycle was not a clean, orderly shutdown: {run.report}")
    instrumentation_rows, instrumentation_data = read_tsv(
        run.report / "instrumentation-policy.tsv",
        INSTRUMENTATION_HEADER,
        "instrumentation policy receipt",
    )
    if len(instrumentation_rows) != 1:
        die(f"instrumentation policy must contain exactly one row: {run.report}")
    instrumentation = instrumentation_rows[0]
    if (
        instrumentation["schema_version"] != "oliphaunt.wasix-postmaster.instrumentation.v1"
        or instrumentation["lane"] != "benchmark"
        or instrumentation["wasix_perf_stats"] != "0"
        or instrumentation["wait_dump_policy"] != "prohibited"
        or instrumentation["wait_dump_interval_ms"] != "0"
        or instrumentation["wait_dump_max_per_wait"] != "0"
        or instrumentation["wait_dump_verbose"] != "0"
        or instrumentation["fence_protocol"] != "none"
        or instrumentation["sanitized_environment"] != " ".join(WAIT_DUMP_ENVIRONMENT)
    ):
        die(f"timed sample has a noncanonical instrumentation policy: {run.report}")
    return (
        sha256_bytes(fd_data),
        sha256_bytes(limit_data),
        sha256_bytes(lifecycle_data),
        sha256_bytes(instrumentation_data),
    )


def validate_profile_evidence(run: Run, args: argparse.Namespace) -> None:
    expected_inputs = read_regular_bytes(args.profile_inputs, "qualification profile inputs")
    expected_resolution = read_regular_bytes(args.profile_resolution, "qualification profile resolution")
    if read_regular_bytes(run.report / "postgres-profile-inputs.tsv", "sample profile inputs") != expected_inputs:
        die(f"sample profile inputs differ from the qualification input: {run.report}")
    if read_regular_bytes(run.report / "postgres-profile-resolution.tsv", "sample profile resolution") != expected_resolution:
        die(f"sample profile resolution differs from the qualification input: {run.report}")


def validate_qualification_profile_identity(args: argparse.Namespace) -> None:
    input_rows, _ = read_tsv(args.profile_inputs, PROFILE_INPUT_HEADER, "qualification profile inputs")
    resolution_rows, _ = read_tsv(
        args.profile_resolution,
        PROFILE_RESOLUTION_HEADER,
        "qualification profile resolution",
    )
    if not input_rows or not resolution_rows:
        die("qualification requires nonempty named-profile evidence")
    identity_lines = ["schema\toliphaunt.wasix-postmaster.postgres-profile-resolution.v1"]
    seen_inputs: set[tuple[str, str]] = set()
    for row in input_rows:
        key = (row["kind"], row["id"])
        if key in seen_inputs or row["kind"] not in ("runtime-footprint", "durability"):
            die(f"duplicate or unexpected qualification profile input: {key}")
        seen_inputs.add(key)
        digest = require_sha256(row["sha256"], "profile input SHA-256")
        source_path = Path(row["path"])
        if not source_path.is_absolute():
            die(f"profile input path is not absolute: {source_path}")
        if sha256_bytes(read_regular_bytes(source_path, "profile input source")) != digest:
            die(f"profile input source hash mismatch: {source_path}")
        identity_lines.append(f"input\t{row['kind']}\t{row['id']}\t{digest}")
    names: list[str] = []
    for row in resolution_rows:
        name = row["name"]
        if not name or name in names:
            die("qualification profile resolution has a duplicate/empty name")
        names.append(name)
        require_sha256(row["profile_sha256"], "resolved profile SHA-256")
        if row["source"] not in ("runtime-footprint", "durability", "explicit"):
            die(f"unexpected profile resolution source: {row['source']!r}")
        canonical_positive(row["precedence"], "profile precedence", maximum=3)
        identity_lines.append(
            "\t".join(
                (
                    "setting",
                    name,
                    row["value"],
                    row["source"],
                    row["profile_id"],
                    row["profile_sha256"],
                    row["precedence"],
                )
            )
        )
    if names != sorted(names):
        die("qualification profile resolution rows are not in canonical name order")
    computed = sha256_bytes(("\n".join(identity_lines) + "\n").encode("utf-8"))
    if computed != args.profile_identity:
        die("qualification profile receipts do not match the declared semantic identity")


def validate_samples(args: argparse.Namespace, runs: Sequence[Run], allowed_libpq: set[tuple[str, str]]) -> list[Sample]:
    samples: list[Sample] = []
    probe_hashes: set[str] = set()
    libpq_identities: set[tuple[str, str]] = set()
    raw_paths: set[Path] = set()
    for run in runs:
        validate_profile_evidence(run, args)
        fd_sha, limit_sha, lifecycle_sha, instrumentation_sha = validate_auxiliary_artifacts(run)
        probe_path = args.benchmark_runs_root / run.label / "libpq-latency-probe"
        probe_data = read_regular_bytes(probe_path, "libpq latency probe binary")
        probe_binary_sha = sha256_bytes(probe_data)
        summary_path = run.report / "libpq-latency-summary.tsv"
        summary_rows, summary_data = read_tsv(summary_path, LATENCY_HEADER, "libpq latency summary")
        if len(summary_rows) != 2 or {row["mode"] for row in summary_rows} != set(MODES):
            die(f"libpq latency summary is incomplete: {summary_path}")
        summary_sha = sha256_bytes(summary_data)
        for row in summary_rows:
            mode = row["mode"]
            if (
                row["schema_version"] != "1"
                or row["target"] != run.target
                or row["status"] != "ok"
                or row["clock"] != "CLOCK_MONOTONIC"
                or canonical_nonnegative(row["warmup_count"], "summary warmup_count") != args.expected_warmup
                or canonical_positive(row["sample_count"], "summary sample_count") != args.expected_samples
            ):
                die(f"latency summary identity/count/status mismatch: {summary_path}")
            raw_path = Path(row["raw_tsv"])
            expected_raw = run.report / run.target / "libpq-latency" / f"{mode}.raw.tsv"
            if raw_path != expected_raw or raw_path in raw_paths:
                die(f"raw latency path is unbound or duplicated: {raw_path}")
            raw_paths.add(raw_path)
            computed, raw_sha = validate_raw(raw_path, mode, args.expected_warmup, args.expected_samples)
            summary_values = {
                name: canonical_positive(row[name], f"summary {name}", maximum=10**15)
                for name in ("p50_ns", "p95_ns", "p99_ns")
            }
            if computed != summary_values:
                die(f"summary percentiles do not match raw evidence: {raw_path}")
            for percentile in ("p50", "p95", "p99"):
                expected_ms = format(
                    Decimal(summary_values[percentile + "_ns"]) / Decimal(1_000_000),
                    ".6f",
                )
                if row[percentile + "_ms"] != expected_ms:
                    die(f"summary {percentile}_ms does not match {percentile}_ns: {summary_path}")
            probe_sha = require_sha256(row["probe_sha256"], "probe SHA-256")
            if probe_sha != probe_binary_sha:
                die(f"probe SHA-256 does not match the exact run binary: {probe_path}")
            libpq_sha = require_sha256(row["libpq_sha256"], "libpq SHA-256")
            libpq_path = Path(row["libpq_path"])
            if not libpq_path.is_absolute():
                die(f"libpq path is not absolute: {libpq_path}")
            libpq_data = read_regular_bytes(libpq_path, "linked libpq artifact")
            if sha256_bytes(libpq_data) != libpq_sha:
                die(f"linked libpq hash mismatch: {libpq_path}")
            libpq_identity = (str(libpq_path.resolve()), libpq_sha)
            if libpq_identity not in allowed_libpq:
                die(f"linked libpq is outside the frozen native oracle: {libpq_path}")
            probe_hashes.add(probe_sha)
            libpq_identities.add(libpq_identity)
            samples.append(
                Sample(
                    run,
                    mode,
                    summary_values["p50_ns"],
                    summary_values["p95_ns"],
                    summary_values["p99_ns"],
                    raw_path,
                    raw_sha,
                    summary_path,
                    summary_sha,
                    fd_sha,
                    limit_sha,
                    lifecycle_sha,
                    instrumentation_sha,
                    probe_sha,
                    probe_path,
                    str(libpq_path.resolve()),
                    libpq_sha,
                )
            )
    if len(probe_hashes) != 1:
        die(f"probe binary identity changed between runs: {sorted(probe_hashes)}")
    if len(libpq_identities) != 1:
        die(f"linked libpq identity changed between runs: {sorted(libpq_identities)}")
    return sorted(samples, key=lambda item: (item.run.block, item.run.position, item.mode))


def encode_tsv(
    header: Sequence[str], rows: Iterable[Sequence[object]]
) -> bytes:
    stream = io.StringIO(newline="")
    writer = csv.writer(stream, delimiter="\t", lineterminator="\n")
    writer.writerow(header)
    writer.writerows(rows)
    return stream.getvalue().encode("utf-8")


def prepare_publication_source(
    destination: Path, payload: bytes, generation: str, invocation: str
) -> tuple[Path, tuple[int, int]]:
    source = destination.with_name(
        f".{destination.name}.pending.{generation}.{invocation}"
    )
    try:
        source_identity = write_publication_source(source, payload)
    except (OSError, PublicationError) as error:
        raise EvidenceError(
            f"could not create sealed output source {source}: {error}"
        ) from error
    return source, source_identity


def publish_tsv_set(
    outputs: Sequence[
        tuple[Path, Sequence[str], Iterable[Sequence[object]]]
    ],
) -> None:
    if len(outputs) < 2:
        die("comparison output set requires at least two members")
    destinations = [Path(os.path.abspath(path)) for path, _, _ in outputs]
    if len(set(destinations)) != len(destinations):
        die("comparison output paths must be distinct")
    parents = {destination.parent for destination in destinations}
    if len(parents) != 1:
        die("comparison outputs must share one directory")
    parent = parents.pop()
    parent.mkdir(parents=True, exist_ok=True)

    members = [
        (destination, encode_tsv(header, rows))
        for destination, (_, header, rows) in zip(
            destinations, outputs, strict=True
        )
    ]
    generation_digest = hashlib.sha256()
    for destination, payload in members:
        for field in (destination.name.encode("utf-8"), payload):
            generation_digest.update(len(field).to_bytes(8, "big"))
            generation_digest.update(field)
    generation = generation_digest.hexdigest()
    invocation = f"{os.getpid()}.{secrets.token_hex(16)}"
    sources: list[tuple[Path, tuple[int, int]]] = []
    failure: BaseException | None = None
    try:
        pairs: list[Path] = []
        for destination, payload in members:
            source, source_identity = prepare_publication_source(
                destination, payload, generation, invocation
            )
            sources.append((source, source_identity))
            pairs.extend((source, destination))
        try:
            publish_no_replace_set(tuple(pairs))
        except (OSError, PublicationError) as error:
            die(f"could not publish comparison output set: {error}")
    except BaseException as error:
        failure = error
        raise
    finally:
        cleanup_errors: list[str] = []
        for source, source_identity in sources:
            try:
                remove_publication_source(source, source_identity)
            except (OSError, PublicationError) as error:
                cleanup_errors.append(f"{source}: {error}")
        if cleanup_errors:
            detail = "; ".join(cleanup_errors)
            if failure is None:
                die(f"could not clean private comparison outputs: {detail}")
            failure.add_note(
                f"could not clean private comparison outputs: {detail}"
            )


def compare_and_write(args: argparse.Namespace, samples: Sequence[Sample]) -> bool:
    by_key = {(sample.run.block, sample.run.pair, sample.run.target, sample.mode): sample for sample in samples}
    pair_rows: list[list[object]] = []
    summaries: list[list[object]] = []
    all_passed = True
    budgets = {
        "persistent": (
            args.max_persistent_p95_ratio,
            args.max_persistent_p99_ratio,
            args.max_wasix_persistent_p95_ms,
            args.max_wasix_persistent_p99_ms,
        ),
        "reconnect": (
            args.max_reconnect_p95_ratio,
            args.max_reconnect_p99_ratio,
            args.max_wasix_reconnect_p95_ms,
            args.max_wasix_reconnect_p99_ms,
        ),
    }
    for mode in MODES:
        p95_ratios: list[Decimal] = []
        p99_ratios: list[Decimal] = []
        wasix_p95_values: list[Decimal] = []
        wasix_p99_values: list[Decimal] = []
        for block in range(1, args.expected_blocks + 1):
            order = "ABBA" if block % 2 else "BAAB"
            for pair in (1, 2):
                native = by_key[(block, pair, "native", mode)]
                wasix = by_key[(block, pair, "wasix", mode)]
                p95_ratio = Decimal(wasix.p95_ns) / Decimal(native.p95_ns)
                p99_ratio = Decimal(wasix.p99_ns) / Decimal(native.p99_ns)
                p95_ratios.append(p95_ratio)
                p99_ratios.append(p99_ratio)
                wasix_p95_values.append(ns_to_ms(wasix.p95_ns))
                wasix_p99_values.append(ns_to_ms(wasix.p99_ns))
                first, second = sorted((native, wasix), key=lambda item: item.run.position)
                pair_rows.append(
                    [
                        "1",
                        block,
                        order,
                        pair,
                        first.run.target,
                        second.run.target,
                        mode,
                        native.p95_ns,
                        wasix.p95_ns,
                        format_decimal(p95_ratio),
                        native.p99_ns,
                        wasix.p99_ns,
                        format_decimal(p99_ratio),
                    ]
                )
        observed = (
            nearest_rank(p95_ratios, 95),
            nearest_rank(p99_ratios, 95),
            nearest_rank(wasix_p95_values, 95),
            nearest_rank(wasix_p99_values, 95),
        )
        limits = budgets[mode]
        labels = ("paired_p95_ratio_p95", "paired_p99_ratio_p95", "wasix_p95_ms_p95", "wasix_p99_ms_p95")
        failures = [
            f"{label}={format_decimal(value)}>{format_decimal(limit)}"
            for label, value, limit in zip(labels, observed, limits, strict=True)
            if value > limit
        ]
        status = "failed" if failures else "passed"
        all_passed = all_passed and not failures
        summaries.append(
            [
                "1",
                mode,
                status,
                args.expected_blocks * 2,
                args.expected_blocks * 2,
                args.expected_blocks * 2,
                *(format_decimal(limit) for limit in limits),
                format_decimal(nearest_rank(p95_ratios, 50)),
                format_decimal(observed[0]),
                format_decimal(nearest_rank(p99_ratios, 50)),
                format_decimal(observed[1]),
                format_decimal(nearest_rank(wasix_p95_values, 50)),
                format_decimal(observed[2]),
                format_decimal(nearest_rank(wasix_p99_values, 50)),
                format_decimal(observed[3]),
                ";".join(failures) if failures else "all-declared-gates-passed",
            ]
        )

    receipt_rows = [
        [
            "1",
            sample.run.block,
            sample.run.order,
            sample.run.pair,
            sample.run.position,
            sample.run.target,
            sample.mode,
            sample.run.label,
            "passed",
            "CLOCK_MONOTONIC",
            args.expected_warmup,
            args.expected_samples,
            sample.p50_ns,
            sample.p95_ns,
            sample.p99_ns,
            sample.raw,
            sample.raw_sha256,
            sample.summary,
            sample.summary_sha256,
            sample.host_fd_sha256,
            sample.server_limits_sha256,
            sample.server_lifecycle_sha256,
            sample.instrumentation_policy_sha256,
            sample.run.settings_sha256,
            args.carrier_identity,
            args.native_oracle_identity,
            args.probe_source_sha256,
            sample.probe_path,
            sample.probe_sha256,
            sample.libpq_path,
            sample.libpq_sha256,
            args.profile_identity,
            args.plan_identity,
            sample.run.report,
        ]
        for sample in samples
    ]
    identity_sample = samples[0]
    publish_tsv_set(
        (
            (args.receipt_output, RECEIPT_HEADER, receipt_rows),
            (args.pairs_output, PAIR_HEADER, pair_rows),
            (args.summary_output, SUMMARY_HEADER, summaries),
            (
                args.identity_output,
                IDENTITY_HEADER,
                [[
                    "1",
                    args.carrier_identity,
                    args.native_oracle_identity,
                    args.probe_source_sha256,
                    identity_sample.probe_path,
                    identity_sample.probe_sha256,
                    identity_sample.libpq_path,
                    identity_sample.libpq_sha256,
                    args.profile_identity,
                    args.plan_identity,
                ]],
            ),
        )
    )
    return all_passed


def parse_args(argv: Sequence[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runs", type=Path, required=True)
    parser.add_argument("--profile-comparisons", type=Path, required=True)
    parser.add_argument("--profile-inputs", type=Path, required=True)
    parser.add_argument("--profile-resolution", type=Path, required=True)
    parser.add_argument("--native-oracle-manifest", type=Path, required=True)
    parser.add_argument("--native-install-dir", type=Path, required=True)
    parser.add_argument("--benchmark-reports-root", type=Path, required=True)
    parser.add_argument("--benchmark-runs-root", type=Path, required=True)
    parser.add_argument("--expected-blocks", type=int, required=True)
    parser.add_argument("--expected-warmup", type=int, required=True)
    parser.add_argument("--expected-samples", type=int, required=True)
    parser.add_argument("--carrier-identity", required=True)
    parser.add_argument("--native-oracle-identity", required=True)
    parser.add_argument("--profile-identity", required=True)
    parser.add_argument("--probe-source-sha256", required=True)
    parser.add_argument("--plan-identity", required=True)
    parser.add_argument("--max-persistent-p95-ratio", default="2.0")
    parser.add_argument("--max-persistent-p99-ratio", default="2.5")
    parser.add_argument("--max-reconnect-p95-ratio", default="3.5")
    parser.add_argument("--max-reconnect-p99-ratio", default="4.5")
    parser.add_argument("--max-wasix-persistent-p95-ms", default="0.25")
    parser.add_argument("--max-wasix-persistent-p99-ms", default="0.40")
    parser.add_argument("--max-wasix-reconnect-p95-ms", default="20")
    parser.add_argument("--max-wasix-reconnect-p99-ms", default="30")
    parser.add_argument("--receipt-output", type=Path, required=True)
    parser.add_argument("--pairs-output", type=Path, required=True)
    parser.add_argument("--summary-output", type=Path, required=True)
    parser.add_argument("--identity-output", type=Path, required=True)
    args = parser.parse_args(argv)
    output_paths = tuple(
        Path(os.path.abspath(getattr(args, name)))
        for name in (
            "receipt_output",
            "pairs_output",
            "summary_output",
            "identity_output",
        )
    )
    if len(set(output_paths)) != len(output_paths):
        parser.error("comparison output paths must be distinct")
    if len({path.parent for path in output_paths}) != 1:
        parser.error("comparison outputs must share one directory")
    if args.expected_blocks <= 0 or args.expected_blocks % 2 or args.expected_warmup < 0 or args.expected_samples <= 0:
        parser.error("expected blocks must be positive/even, samples positive, and warmup nonnegative")
    for name in ("carrier_identity", "native_oracle_identity", "profile_identity", "probe_source_sha256", "plan_identity"):
        require_sha256(getattr(args, name), name.replace("_", " "))
    for name in (
        "max_persistent_p95_ratio",
        "max_persistent_p99_ratio",
        "max_reconnect_p95_ratio",
        "max_reconnect_p99_ratio",
        "max_wasix_persistent_p95_ms",
        "max_wasix_persistent_p99_ms",
        "max_wasix_reconnect_p95_ms",
        "max_wasix_reconnect_p99_ms",
    ):
        setattr(args, name, decimal_arg(getattr(args, name), "--" + name.replace("_", "-")))
    if (
        not args.benchmark_reports_root.is_absolute()
        or args.benchmark_reports_root.is_symlink()
        or not args.benchmark_reports_root.is_dir()
    ):
        parser.error("--benchmark-reports-root must be an absolute non-symlink directory")
    if (
        not args.benchmark_runs_root.is_absolute()
        or args.benchmark_runs_root.is_symlink()
        or not args.benchmark_runs_root.is_dir()
    ):
        parser.error("--benchmark-runs-root must be an absolute non-symlink directory")
    if (
        not args.native_install_dir.is_absolute()
        or args.native_install_dir.is_symlink()
        or not args.native_install_dir.is_dir()
    ):
        parser.error("--native-install-dir must be an absolute non-symlink directory")
    return args


def main(argv: Sequence[str]) -> int:
    try:
        args = parse_args(argv)
        allowed_libpq = parse_native_oracle(args.native_oracle_manifest, args.native_oracle_identity, args.native_install_dir.resolve())
        validate_qualification_profile_identity(args)
        runs = validate_run_index(args)
        validate_profile_comparisons(args, runs)
        samples = validate_samples(args, runs, allowed_libpq)
        return 0 if compare_and_write(args, samples) else 1
    except EvidenceError as exc:
        print(f"libpq latency comparison failed closed: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
