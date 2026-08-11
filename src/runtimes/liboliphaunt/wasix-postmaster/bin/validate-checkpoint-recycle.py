#!/usr/bin/env python3
"""Validate one open-loop PostgreSQL checkpoint-overlap evidence sample."""

from __future__ import annotations

import argparse
import csv
import io
import math
import os
import re
import secrets
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Iterable

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))
from durable_publication import (  # noqa: E402
    PublicationError,
    publish_set,
    remove_private,
    stable_regular_bytes,
    write_bytes,
)


TRANSACTION_HEADER = [
    "schema_version",
    "client",
    "sequence",
    "scheduled_mono_ns",
    "start_mono_ns",
    "end_mono_ns",
    "start_real_ns",
    "end_real_ns",
    "service_ns",
    "lateness_ns",
    "status",
    "update_count",
    "insert_count",
    "read_count",
    "insert_lsn",
]
FLUSH_HEADER = [
    "schema_version",
    "client",
    "through_sequence",
    "insert_lsn",
    "flush_lsn",
    "covers",
    "status",
]
STATE_HEADER = ["num_timed", "num_requested", "num_done", "wal_bytes"]
START_RE = re.compile(r"checkpoint starting: ([a-z]+)")
COMPLETE_RE = re.compile(r"checkpoint complete: .*?total=([0-9]+(?:\.[0-9]+)?) s")
TIMESTAMP_RE = re.compile(
    r"^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?)(?: ([A-Z]{3,5}|[+-]\d{2}(?::?\d{2})?))?"
)
LSN_RE = re.compile(r"^([0-9A-F]{1,8})/([0-9A-F]{1,8})$")
U64_MAX = (1 << 64) - 1
MAX_CLIENTS = 4
MAX_DURATION_SECONDS = 86_400
MAX_TPS_PER_CLIENT = 10_000
MAX_STAGGER_US = 1_000_000
MAX_EXPECTED_ROWS = MAX_CLIENTS * MAX_DURATION_SECONDS * MAX_TPS_PER_CLIENT
MAX_RATE = MAX_CLIENTS * MAX_TPS_PER_CLIENT
MAX_RATIO = 1_000_000.0
MAX_MILLISECONDS = U64_MAX / 1_000_000
MAX_SECONDS = U64_MAX / 1_000_000_000


class EvidenceError(ValueError):
    pass


@dataclass(frozen=True)
class Checkpoint:
    reason: str
    start_ns: int
    end_ns: int
    total_seconds: float


def read_dict_rows(path: Path, expected_header: list[str]) -> list[dict[str, str]]:
    data = stable_regular_bytes(path)
    text = data.decode("utf-8", errors="strict")
    stream = io.StringIO(text, newline="")
    reader = csv.DictReader(stream, delimiter="\t", strict=True)
    if reader.fieldnames != expected_header:
        raise EvidenceError(
            f"unexpected TSV header in {path}: {reader.fieldnames!r}"
        )
    rows: list[dict[str, str]] = []
    for line_number, row in enumerate(reader, 2):
        if (
            None in row
            or tuple(row) != tuple(expected_header)
            or any(value is None for value in row.values())
        ):
            raise EvidenceError(f"malformed TSV row {line_number} in {path}")
        rows.append(row)
    if not rows:
        raise EvidenceError(f"evidence contains no rows: {path}")
    return rows


def parse_nonnegative(row: dict[str, str], field: str) -> int:
    value = row[field]
    if not value.isascii() or not value.isdigit():
        raise EvidenceError(f"{field} is not an unsigned 64-bit integer: {value!r}")
    try:
        parsed = int(value)
    except ValueError as error:
        raise EvidenceError(
            f"{field} is not an unsigned 64-bit integer: {value!r}"
        ) from error
    if parsed > U64_MAX:
        raise EvidenceError(f"{field} exceeds unsigned 64-bit range: {value!r}")
    return parsed


def read_state(path: Path) -> dict[str, int]:
    rows = read_dict_rows(path, STATE_HEADER)
    if len(rows) != 1:
        raise EvidenceError(f"checkpoint state must contain exactly one row: {path}")
    return {field: parse_nonnegative(rows[0], field) for field in STATE_HEADER}


def nearest_rank(values: Iterable[int], fraction: float) -> int:
    ordered = sorted(values)
    if not ordered:
        raise EvidenceError("cannot calculate a percentile over no values")
    rank = max(1, math.ceil(fraction * len(ordered)))
    return ordered[rank - 1]


def parse_lsn(value: str) -> int:
    match = LSN_RE.fullmatch(value)
    if match is None:
        raise EvidenceError(f"malformed PostgreSQL LSN: {value!r}")
    return (int(match.group(1), 16) << 32) + int(match.group(2), 16)


def parse_timestamp_ns(line: str) -> int | None:
    match = TIMESTAMP_RE.match(line)
    if match is None:
        return None
    text, zone = match.groups()
    parsed = datetime.fromisoformat(text)
    if zone in (None, "UTC", "GMT"):
        parsed = parsed.replace(tzinfo=timezone.utc)
    elif re.fullmatch(r"[+-]\d{2}", zone):
        parsed = datetime.fromisoformat(f"{text}{zone}:00")
    elif re.fullmatch(r"[+-]\d{4}", zone):
        parsed = datetime.fromisoformat(f"{text}{zone[:3]}:{zone[3:]}")
    elif zone and zone.startswith(("+", "-")):
        parsed = datetime.fromisoformat(f"{text}{zone}")
    else:
        raise EvidenceError(f"unsupported checkpoint log timezone: {zone!r}")
    return int(parsed.timestamp() * 1_000_000_000)


def parse_checkpoints(path: Path) -> tuple[list[Checkpoint], bool]:
    data = stable_regular_bytes(path)
    text = data.decode("utf-8", errors="strict")
    starts: list[tuple[str, int]] = []
    checkpoints: list[Checkpoint] = []
    too_frequent = False
    for line in io.StringIO(text, newline=""):
        too_frequent |= "checkpoints are occurring too frequently" in line
        start_match = START_RE.search(line)
        complete_match = COMPLETE_RE.search(line)
        if start_match is not None:
            timestamp = parse_timestamp_ns(line)
            if timestamp is None:
                raise EvidenceError("checkpoint start lacks a parseable %m timestamp")
            starts.append((start_match.group(1), timestamp))
        elif complete_match is not None:
            timestamp = parse_timestamp_ns(line)
            if timestamp is None:
                raise EvidenceError(
                    "checkpoint completion lacks a parseable %m timestamp"
                )
            if not starts:
                continue
            reason, started = starts.pop(0)
            total_seconds = float(complete_match.group(1))
            if not math.isfinite(total_seconds) or total_seconds < 0:
                raise EvidenceError("checkpoint completion duration is not finite")
            checkpoints.append(
                Checkpoint(reason, started, timestamp, total_seconds)
            )
    return checkpoints, too_frequent


def bounded_integer(
    option: str, *, minimum: int, maximum: int
) -> Callable[[str], int]:
    def parse(value: str) -> int:
        if not value.isascii() or not value.isdigit():
            raise argparse.ArgumentTypeError(
                f"{option} must be an integer in [{minimum}, {maximum}]"
            )
        try:
            parsed = int(value)
        except ValueError as error:
            raise argparse.ArgumentTypeError(
                f"{option} must be an integer in [{minimum}, {maximum}]"
            ) from error
        if not minimum <= parsed <= maximum:
            raise argparse.ArgumentTypeError(
                f"{option} must be in [{minimum}, {maximum}]"
            )
        return parsed

    return parse


def bounded_float(
    option: str, *, minimum: float, maximum: float, minimum_inclusive: bool = False
) -> Callable[[str], float]:
    def parse(value: str) -> float:
        try:
            parsed = float(value)
        except ValueError as error:
            raise argparse.ArgumentTypeError(f"{option} must be a finite number") from error
        minimum_ok = parsed >= minimum if minimum_inclusive else parsed > minimum
        if not math.isfinite(parsed) or not minimum_ok or parsed > maximum:
            lower = "[" if minimum_inclusive else "("
            raise argparse.ArgumentTypeError(
                f"{option} must be finite and in {lower}{minimum}, {maximum}]"
            )
        return parsed

    return parse


def render_tsv(rows: list[list[object]]) -> bytes:
    stream = io.StringIO(newline="")
    csv.writer(stream, delimiter="\t", lineterminator="\n").writerows(rows)
    return stream.getvalue().encode("utf-8")


def output_pair(first: Path, second: Path) -> tuple[Path, Path]:
    first = Path(os.path.abspath(first))
    second = Path(os.path.abspath(second))
    if first == second:
        raise EvidenceError("validation output and gate output must differ")
    if first.parent != second.parent:
        raise EvidenceError("validation output and gate output must share one directory")
    if not first.parent.is_dir() or first.parent.is_symlink():
        raise EvidenceError(
            f"output parent must be a non-symlink directory: {first.parent}"
        )
    return first, second


def publish_outputs(
    first: Path, first_payload: bytes, second: Path, second_payload: bytes
) -> None:
    token = f"{os.getpid()}.{secrets.token_hex(16)}"
    first_private = first.with_name(f".{first.name}.pending.{token}")
    second_private = second.with_name(f".{second.name}.pending.{token}")
    first_identity = write_bytes(first_private, first_payload)
    second_identity = None
    try:
        second_identity = write_bytes(second_private, second_payload)
        publish_set(
            (first_private, first, second_private, second),
            (first_identity, second_identity),
        )
    finally:
        remove_private(first_private, first_identity)
        if second_identity is not None:
            remove_private(second_private, second_identity)


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser()
    result.add_argument("--transactions", type=Path, required=True)
    result.add_argument("--flushes", type=Path, required=True)
    result.add_argument("--checkpoint-before", type=Path, required=True)
    result.add_argument("--checkpoint-after", type=Path, required=True)
    result.add_argument("--server-log", type=Path, required=True)
    result.add_argument("--output", type=Path, required=True)
    result.add_argument("--gates-output", type=Path, required=True)
    result.add_argument("--target", choices=("native", "wasix"), required=True)
    result.add_argument("--mode", choices=("smoke", "diagnostic", "qualification"), required=True)
    result.add_argument(
        "--clients",
        type=bounded_integer("--clients", minimum=1, maximum=MAX_CLIENTS),
        required=True,
    )
    result.add_argument(
        "--duration-seconds",
        type=bounded_integer(
            "--duration-seconds", minimum=1, maximum=MAX_DURATION_SECONDS
        ),
        required=True,
    )
    result.add_argument(
        "--tps-per-client",
        type=bounded_integer(
            "--tps-per-client", minimum=1, maximum=MAX_TPS_PER_CLIENT
        ),
        required=True,
    )
    result.add_argument(
        "--stagger-us",
        type=bounded_integer(
            "--stagger-us", minimum=0, maximum=MAX_STAGGER_US
        ),
        required=True,
    )
    result.add_argument(
        "--min-completion-fraction",
        type=bounded_float(
            "--min-completion-fraction", minimum=0, maximum=1.0
        ),
        default=0.99,
    )
    result.add_argument(
        "--min-achieved-tps",
        type=bounded_float("--min-achieved-tps", minimum=0, maximum=MAX_RATE),
        required=True,
    )
    result.add_argument(
        "--min-wal-bytes",
        type=bounded_integer("--min-wal-bytes", minimum=1, maximum=U64_MAX),
        required=True,
    )
    result.add_argument(
        "--min-checkpoints",
        type=bounded_integer(
            "--min-checkpoints", minimum=1, maximum=MAX_EXPECTED_ROWS
        ),
        required=True,
    )
    result.add_argument(
        "--max-checkpoint-seconds",
        type=bounded_float(
            "--max-checkpoint-seconds", minimum=0, maximum=MAX_SECONDS
        ),
        default=30.0,
    )
    for option, destination, default in (
        ("--max-p95-ms", "max_p95_ms", 10.0),
        ("--max-p99-ms", "max_p99_ms", 50.0),
        ("--max-latency-ms", "max_latency_ms", 250.0),
        ("--max-overlap-delta-ms", "max_overlap_delta_ms", 10.0),
        ("--max-clock-duration-skew-ms", "max_clock_duration_skew_ms", 2.0),
        ("--max-clock-offset-drift-ms", "max_clock_offset_drift_ms", 5.0),
    ):
        result.add_argument(
            option,
            dest=destination,
            type=bounded_float(option, minimum=0, maximum=MAX_MILLISECONDS),
            default=default,
        )
    result.add_argument(
        "--max-overlap-ratio",
        type=bounded_float(
            "--max-overlap-ratio", minimum=0, maximum=MAX_RATIO
        ),
        default=2.0,
    )
    result.add_argument(
        "--min-overlap-samples",
        type=bounded_integer(
            "--min-overlap-samples", minimum=1, maximum=MAX_EXPECTED_ROWS
        ),
        required=True,
    )
    result.add_argument("--enforce-performance", action="store_true")
    return result


def main() -> int:
    args = parser().parse_args()
    try:
        args.output, args.gates_output = output_pair(
            args.output, args.gates_output
        )

        transactions = read_dict_rows(args.transactions, TRANSACTION_HEADER)
        flushes = read_dict_rows(args.flushes, FLUSH_HEADER)
        before = read_state(args.checkpoint_before)
        after = read_state(args.checkpoint_after)
        checkpoints, too_frequent = parse_checkpoints(args.server_log)

        expected_rows = args.clients * args.duration_seconds * args.tps_per_client
        seen: set[tuple[int, int]] = set()
        sequences: dict[int, list[int]] = {client: [] for client in range(1, args.clients + 1)}
        successful_lsn: dict[tuple[int, int], str] = {}
        scheduled_by_key: dict[tuple[int, int], int] = {}
        ends_by_key: dict[tuple[int, int], int] = {}
        service_ns: list[int] = []
        window_start_ns: int | None = None
        window_end_ns: int | None = None
        invalid_rows = 0
        skipped = 0
        clock_duration_skew_ns = 0
        clock_offsets_ns: list[int] = []
        for row in transactions:
            if row["schema_version"] != "1":
                raise EvidenceError("transaction row has an unknown schema version")
            client = parse_nonnegative(row, "client")
            sequence = parse_nonnegative(row, "sequence")
            key = (client, sequence)
            if client not in sequences or key in seen:
                invalid_rows += 1
                continue
            seen.add(key)
            sequences[client].append(sequence)
            start_real = parse_nonnegative(row, "start_real_ns")
            end_real = parse_nonnegative(row, "end_real_ns")
            scheduled_mono = parse_nonnegative(row, "scheduled_mono_ns")
            start_mono = parse_nonnegative(row, "start_mono_ns")
            end_mono = parse_nonnegative(row, "end_mono_ns")
            measured_service = parse_nonnegative(row, "service_ns")
            measured_lateness = parse_nonnegative(row, "lateness_ns")
            expected_lateness = max(0, start_mono - scheduled_mono)
            if (
                end_real < start_real
                or start_mono < scheduled_mono
                or end_mono < start_mono
                or measured_service != end_mono - start_mono
                or measured_lateness != expected_lateness
            ):
                invalid_rows += 1
            scheduled_by_key[key] = scheduled_mono
            ends_by_key[key] = end_mono
            realtime_duration = end_real - start_real
            clock_duration_skew_ns = max(
                clock_duration_skew_ns, abs(realtime_duration - measured_service)
            )
            clock_offsets_ns.extend(
                [start_real - start_mono, end_real - end_mono]
            )
            window_start_ns = start_real if window_start_ns is None else min(window_start_ns, start_real)
            window_end_ns = end_real if window_end_ns is None else max(window_end_ns, end_real)
            if row["status"] == "skipped":
                skipped += 1
                continue
            if (
                row["status"] != "ok"
                or row["update_count"] != "48"
                or row["insert_count"] != "16"
                or row["read_count"] != "8"
            ):
                invalid_rows += 1
                continue
            try:
                parse_lsn(row["insert_lsn"])
            except EvidenceError:
                invalid_rows += 1
                continue
            successful_lsn[key] = row["insert_lsn"]
            service_ns.append(measured_service)

        ordered_sequences: dict[int, list[int]] = {}
        for client, values in sequences.items():
            ordered = sorted(values)
            ordered_sequences[client] = ordered
            if len(ordered) != args.duration_seconds * args.tps_per_client:
                invalid_rows += 1
            elif ordered != list(range(ordered[0], ordered[0] + len(ordered))):
                invalid_rows += 1

        interval_ns = 1_000_000_000 // args.tps_per_client
        sequence_starts = {
            values[0] for values in ordered_sequences.values() if values
        }
        schedule_base_ns: int | None = None
        schedule_grid_errors = 0
        if len(sequence_starts) != 1 or not ordered_sequences[1]:
            schedule_grid_errors += 1
        else:
            first_sequence = next(iter(sequence_starts))
            schedule_base_ns = scheduled_by_key.get((1, first_sequence))
            if schedule_base_ns is None:
                schedule_grid_errors += 1
            else:
                for client, values in ordered_sequences.items():
                    previous_scheduled: int | None = None
                    for sequence in values:
                        scheduled = scheduled_by_key.get((client, sequence))
                        expected_scheduled = (
                            schedule_base_ns
                            + (client - 1) * args.stagger_us * 1_000
                            + (sequence - first_sequence) * interval_ns
                        )
                        if (
                            scheduled is None
                            or scheduled != expected_scheduled
                            or (
                                previous_scheduled is not None
                                and scheduled <= previous_scheduled
                            )
                        ):
                            schedule_grid_errors += 1
                        previous_scheduled = scheduled

        flush_clients: set[int] = set()
        flush_sequences: dict[int, list[int]] = {
            client: [] for client in range(1, args.clients + 1)
        }
        previous_flush_lsn: dict[int, int] = {}
        seen_flushes: set[tuple[int, int]] = set()
        invalid_flushes = 0
        for row in flushes:
            if row["schema_version"] != "1":
                invalid_flushes += 1
                continue
            client = parse_nonnegative(row, "client")
            sequence = parse_nonnegative(row, "through_sequence")
            key = (client, sequence)
            try:
                insert_lsn = parse_lsn(row["insert_lsn"])
                flush_lsn = parse_lsn(row["flush_lsn"])
            except EvidenceError:
                invalid_flushes += 1
                continue
            if (
                client not in sequences
                or key in seen_flushes
                or row["status"] != "ok"
                or row["covers"] != "t"
                or successful_lsn.get(key) != row["insert_lsn"]
                or flush_lsn < insert_lsn
                or (
                    client in previous_flush_lsn
                    and flush_lsn < previous_flush_lsn[client]
                )
            ):
                invalid_flushes += 1
                continue
            seen_flushes.add(key)
            flush_clients.add(client)
            flush_sequences[client].append(sequence)
            previous_flush_lsn[client] = flush_lsn
        for client, values in sequences.items():
            successful = sorted(
                sequence for sequence in values if (client, sequence) in successful_lsn
            )
            if not successful:
                invalid_flushes += 1
                continue
            required = list(
                range(successful[0] + 255, successful[-1] + 1, 256)
            )
            if not required or required[-1] != successful[-1]:
                required.append(successful[-1])
            if flush_sequences[client] != required:
                invalid_flushes += 1

        if window_start_ns is None or window_end_ns is None or not service_ns:
            raise EvidenceError("transaction evidence has no successful measured window")
        periodic = [
            checkpoint
            for checkpoint in checkpoints
            if checkpoint.reason == "time"
            and checkpoint.start_ns >= window_start_ns
            and checkpoint.start_ns <= window_end_ns
        ]
        overlap_service: list[int] = []
        non_overlap_service: list[int] = []
        for row in transactions:
            if row["status"] != "ok":
                continue
            start_real = int(row["start_real_ns"])
            end_real = int(row["end_real_ns"])
            overlaps = any(
                start_real <= checkpoint.end_ns and end_real >= checkpoint.start_ns
                for checkpoint in periodic
            )
            (overlap_service if overlaps else non_overlap_service).append(int(row["service_ns"]))

        deltas = {field: after[field] - before[field] for field in STATE_HEADER}
        if any(delta < 0 for delta in deltas.values()):
            raise EvidenceError("checkpoint statistics moved backwards during the sample")
        completed = len(service_ns)
        completion_fraction = completed / expected_rows
        observed_start_ns = min(scheduled_by_key.values())
        observed_end_ns = max(ends_by_key.values())
        observed_window_ns = observed_end_ns - observed_start_ns
        if observed_window_ns <= 0:
            raise EvidenceError("transaction evidence has no positive monotonic window")
        achieved_tps = completed * 1_000_000_000 / observed_window_ns
        scheduled_span_ns = max(scheduled_by_key.values()) - observed_start_ns
        expected_scheduled_span_ns = (
            (args.duration_seconds * args.tps_per_client - 1) * interval_ns
            + (args.clients - 1) * args.stagger_us * 1_000
        )
        p95_ns = nearest_rank(service_ns, 0.95)
        p99_ns = nearest_rank(service_ns, 0.99)
        max_ns = max(service_ns)
        overlap_p99_ns = nearest_rank(overlap_service, 0.99) if overlap_service else 0
        non_overlap_p99_ns = nearest_rank(non_overlap_service, 0.99) if non_overlap_service else 0
        overlap_ratio_limit_ns = int(non_overlap_p99_ns * args.max_overlap_ratio)
        overlap_delta_limit_ns = (
            non_overlap_p99_ns + int(args.max_overlap_delta_ms * 1_000_000)
        )
        clock_offset_drift_ns = max(clock_offsets_ns) - min(clock_offsets_ns)

        gates: list[tuple[str, str, str, bool]] = []

        def gate(name: str, expected: str, observed: object, passed: bool) -> None:
            gates.append((name, expected, str(observed), passed))

        gate("transaction_rows", str(expected_rows), len(transactions), len(transactions) == expected_rows)
        gate("transaction_shape", "zero-invalid", invalid_rows, invalid_rows == 0)
        gate("monotonic_schedule_grid", "exact", schedule_grid_errors, schedule_grid_errors == 0)
        gate(
            "scheduled_span_ns",
            str(expected_scheduled_span_ns),
            scheduled_span_ns,
            scheduled_span_ns == expected_scheduled_span_ns,
        )
        gate(
            "realtime_monotonic_duration_skew_ms",
            f"<={args.max_clock_duration_skew_ms}",
            f"{clock_duration_skew_ns / 1_000_000:.6f}",
            clock_duration_skew_ns <= args.max_clock_duration_skew_ms * 1_000_000,
        )
        gate(
            "realtime_monotonic_offset_drift_ms",
            f"<={args.max_clock_offset_drift_ms}",
            f"{clock_offset_drift_ns / 1_000_000:.6f}",
            clock_offset_drift_ns <= args.max_clock_offset_drift_ms * 1_000_000,
        )
        gate("skipped_offers", "0", skipped, skipped == 0)
        gate(
            "completion_fraction",
            f">={args.min_completion_fraction}",
            f"{completion_fraction:.6f}",
            completion_fraction >= args.min_completion_fraction,
        )
        gate(
            "achieved_tps",
            f">={args.min_achieved_tps}",
            f"{achieved_tps:.6f}",
            achieved_tps >= args.min_achieved_tps,
        )
        gate("flush_receipts", f"{args.clients}-clients-covered", len(flush_clients), invalid_flushes == 0 and len(flush_clients) == args.clients)
        gate("requested_checkpoints", "0", deltas["num_requested"], deltas["num_requested"] == 0)
        gate("timed_checkpoints", f">={args.min_checkpoints}", deltas["num_timed"], deltas["num_timed"] >= args.min_checkpoints)
        gate("completed_checkpoints", f">={args.min_checkpoints}", deltas["num_done"], deltas["num_done"] >= args.min_checkpoints)
        gate("logged_periodic_checkpoints", f">={args.min_checkpoints}", len(periodic), len(periodic) >= args.min_checkpoints)
        gate("checkpoint_duration", f"<{args.max_checkpoint_seconds}s", max((item.total_seconds for item in periodic), default=0), bool(periodic) and all(item.total_seconds < args.max_checkpoint_seconds for item in periodic))
        gate("checkpoint_frequency_warning", "absent", too_frequent, not too_frequent)
        gate("wal_bytes", f">={args.min_wal_bytes}", deltas["wal_bytes"], deltas["wal_bytes"] >= args.min_wal_bytes)
        gate("overlap_samples", f">={args.min_overlap_samples}", len(overlap_service), len(overlap_service) >= args.min_overlap_samples)
        if args.enforce_performance:
            gate("p95_ms", f"<={args.max_p95_ms}", f"{p95_ns / 1_000_000:.6f}", p95_ns <= args.max_p95_ms * 1_000_000)
            gate("p99_ms", f"<={args.max_p99_ms}", f"{p99_ns / 1_000_000:.6f}", p99_ns <= args.max_p99_ms * 1_000_000)
            gate("max_ms", f"<={args.max_latency_ms}", f"{max_ns / 1_000_000:.6f}", max_ns <= args.max_latency_ms * 1_000_000)
            gate(
                "checkpoint_overlap_p99_ratio",
                f"<={overlap_ratio_limit_ns / 1_000_000:.6f}ms",
                f"{overlap_p99_ns / 1_000_000:.6f}",
                bool(non_overlap_service)
                and overlap_p99_ns <= overlap_ratio_limit_ns,
            )
            gate(
                "checkpoint_overlap_p99_delta",
                f"<={overlap_delta_limit_ns / 1_000_000:.6f}ms",
                f"{overlap_p99_ns / 1_000_000:.6f}",
                bool(non_overlap_service)
                and overlap_p99_ns <= overlap_delta_limit_ns,
            )

        passed = all(item[3] for item in gates)
        gates_payload = render_tsv(
            [
                ["gate", "expected", "observed", "status"],
                *[
                    [name, expected, observed, "passed" if gate_passed else "failed"]
                    for name, expected, observed, gate_passed in gates
                ],
            ]
        )
        summary_payload = render_tsv(
            [
                [
                    "schema_version",
                    "target",
                    "mode",
                    "status",
                    "performance_enforced",
                    "expected_transactions",
                    "completed_transactions",
                    "completion_fraction",
                    "achieved_tps",
                    "observed_window_ns",
                    "scheduled_span_ns",
                    "p50_ns",
                    "p95_ns",
                    "p99_ns",
                    "max_ns",
                    "overlap_samples",
                    "overlap_p99_ns",
                    "non_overlap_p99_ns",
                    "timed_checkpoints",
                    "requested_checkpoints",
                    "completed_checkpoints",
                    "logged_periodic_checkpoints",
                    "wal_bytes",
                    "gates",
                ],
                [
                    "oliphaunt.wasix-postmaster.checkpoint-sample.v1",
                    args.target,
                    args.mode,
                    "passed" if passed else "failed",
                    int(args.enforce_performance),
                    expected_rows,
                    completed,
                    f"{completion_fraction:.9f}",
                    f"{achieved_tps:.6f}",
                    observed_window_ns,
                    scheduled_span_ns,
                    nearest_rank(service_ns, 0.50),
                    p95_ns,
                    p99_ns,
                    max_ns,
                    len(overlap_service),
                    overlap_p99_ns,
                    non_overlap_p99_ns,
                    deltas["num_timed"],
                    deltas["num_requested"],
                    deltas["num_done"],
                    len(periodic),
                    deltas["wal_bytes"],
                    args.gates_output,
                ],
            ]
        )
        publish_outputs(
            args.output,
            summary_payload,
            args.gates_output,
            gates_payload,
        )
        return 0 if passed else 1
    except (PublicationError, OSError, UnicodeError, ValueError, csv.Error) as error:
        print(f"checkpoint evidence validation failed: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
