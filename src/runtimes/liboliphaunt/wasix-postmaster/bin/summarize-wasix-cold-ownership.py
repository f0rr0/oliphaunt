#!/usr/bin/env python3
"""Aggregate independently validated cold-start samples with nearest-rank tails."""

from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import math
import os
import secrets
import sys
import re
from pathlib import Path
from typing import NoReturn

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))
from cold_ownership_schema import SAMPLE_HEADER  # noqa: E402
from durable_publication import (  # noqa: E402
    PublicationError,
    publish_set,
    remove_private,
    stable_regular_bytes,
    write_bytes,
)


SAMPLE_SCHEMA = "oliphaunt.wasix-postmaster.cold-ownership-sample.v1"
SUMMARY_SCHEMA = "oliphaunt.wasix-postmaster.cold-ownership-summary.v1"
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
U64_MAX = (1 << 64) - 1


class SummaryError(RuntimeError):
    pass


def fail(message: str) -> NoReturn:
    raise SummaryError(message)


def nearest_rank(values: list[float], percentile: float) -> float:
    if not values:
        fail("cannot calculate a percentile over no values")
    ordered = sorted(values)
    rank = max(1, math.ceil(percentile * len(ordered)))
    return ordered[rank - 1]


def unsigned(
    row: dict[str, str], name: str, *, positive: bool = False
) -> int:
    value = row.get(name, "")
    if (
        not value.isascii()
        or not value.isdecimal()
        or (len(value) > 1 and value.startswith("0"))
    ):
        fail(f"sample field {name} must be unsigned: {value!r}")
    parsed = int(value)
    if parsed > U64_MAX or (positive and parsed == 0):
        qualifier = "positive " if positive else ""
        fail(f"sample field {name} must be a {qualifier}u64: {value!r}")
    return parsed


def nonnegative_finite(row: dict[str, str], name: str) -> float:
    value = row.get(name, "")
    try:
        parsed = float(value)
    except ValueError:
        fail(f"sample field {name} must be numeric: {value!r}")
    if not math.isfinite(parsed) or parsed < 0:
        fail(f"sample field {name} must be finite and nonnegative: {value!r}")
    return parsed


def positive_finite_argument(value: str) -> float:
    try:
        parsed = float(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError("must be numeric") from error
    if not math.isfinite(parsed) or parsed <= 0:
        raise argparse.ArgumentTypeError("must be finite and positive")
    return parsed


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", action="append", required=True, type=Path)
    parser.add_argument("--expected-blocks", required=True, type=int)
    parser.add_argument("--max-p95-ms", type=positive_finite_argument)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--receipt", required=True, type=Path)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.expected_blocks < 5:
        fail("cold qualification requires at least five independent blocks")
    if len(args.input) != args.expected_blocks or len(set(args.input)) != len(args.input):
        fail("input count/uniqueness does not match expected blocks")
    rows: list[dict[str, str]] = []
    latencies: list[float] = []
    inputs: list[dict[str, str]] = []
    header: list[str] | None = None
    for index, path in enumerate(args.input, start=1):
        raw = stable_regular_bytes(path)
        if not raw.endswith(b"\n") or raw.count(b"\n") != 2:
            fail(f"sample must contain exactly two newline-terminated rows: {path}")
        stream = io.StringIO(raw.decode("utf-8", errors="strict"), newline="")
        reader = csv.DictReader(stream, delimiter="\t")
        if reader.fieldnames != list(SAMPLE_HEADER):
            fail(f"sample has an unexpected ordered header: {path}")
        if header is None:
            header = reader.fieldnames
        elif reader.fieldnames != header:
            fail(f"sample header changed: {path}")
        current = list(reader)
        if len(current) != 1:
            fail(f"sample must contain exactly one row: {path}")
        row = current[0]
        if None in row or any(value is None for value in row.values()):
            fail(f"sample row does not match its exact header: {path}")
        if row.get("schema_version") != SAMPLE_SCHEMA or row.get("target") != "wasix" or row.get("status") != "passed":
            fail(f"sample is not an exact passed WASIX cold sample: {path}")
        for name in (
            "execution_identity_sha256",
            "residency_receipt_sha256",
            "first_query_snapshot_sha256",
            "final_snapshot_sha256",
            "resource_samples_sha256",
            "validator_sha256",
        ):
            if SHA256_RE.fullmatch(row.get(name, "")) is None:
                fail(f"sample field {name} must be a lowercase SHA-256: {path}")
        memory_max = unsigned(row, "memory_max_bytes", positive=True)
        memory_high = unsigned(row, "memory_high_bytes", positive=True)
        swap_max = unsigned(row, "swap_max_bytes")
        if memory_high > memory_max:
            fail(f"sample memory high limit exceeds its hard limit: {path}")
        row["memory_max_bytes"] = str(memory_max)
        row["memory_high_bytes"] = str(memory_high)
        row["swap_max_bytes"] = str(swap_max)
        if unsigned(row, "resident_after_pages") != 0:
            fail(f"sample retained resident pages: {path}")
        if unsigned(row, "full_valid_sample_count") < 1:
            fail(f"sample has no full resource observation: {path}")
        io_status = row.get("io_observation_status")
        io_controller = row.get("io_controller_status")
        io_reason = row.get("io_missing_reason")
        io_first_touch = row.get("io_first_touch_status")
        if io_status == "available":
            if io_controller not in {"available", "missing"} or io_reason != "none":
                fail(f"sample has incoherent available io evidence: {path}")
            if io_first_touch != "attributable":
                fail(f"sample does not bind attributable io first touch: {path}")
            for name in ("io_read_bytes", "io_write_bytes", "io_read_ios", "io_write_ios"):
                unsigned(row, name)
        elif io_status == "unavailable":
            expected_reason = (
                "io-controller-missing"
                if io_controller == "missing"
                else "io-stat-missing"
            )
            if io_controller not in {"available", "missing"} or io_reason != expected_reason:
                fail(f"sample has incoherent unavailable io evidence: {path}")
            if io_first_touch != "unavailable":
                fail(f"sample claims io first touch while io is unavailable: {path}")
            for name in ("io_read_bytes", "io_write_bytes", "io_read_ios", "io_write_ios"):
                if row.get(name, "") != "":
                    fail(f"sample fills unavailable io metric {name}: {path}")
        else:
            fail(f"sample has invalid io observation status: {path}")
        latencies.append(nonnegative_finite(row, "spawn_to_first_query_ms"))
        rows.append(row)
        inputs.append(
            {
                "block": str(index),
                "path": str(path),
                "sha256": hashlib.sha256(raw).hexdigest(),
            }
        )

    execution_identities = {row["execution_identity_sha256"] for row in rows}
    carrier_roots = {row["carrier_root"] for row in rows}
    pgdata_roots = {row["pgdata_root"] for row in rows}
    memory_limits = {unsigned(row, "memory_max_bytes", positive=True) for row in rows}
    high_limits = {unsigned(row, "memory_high_bytes", positive=True) for row in rows}
    swap_limits = {unsigned(row, "swap_max_bytes") for row in rows}
    if len(execution_identities) != 1 or len(carrier_roots) != 1:
        fail("carrier/execution identity changed across cold blocks")
    if len(pgdata_roots) != len(rows):
        fail("cold blocks reused PGDATA instead of creating independent initialized roots")
    if len(memory_limits) != 1 or len(high_limits) != 1 or len(swap_limits) != 1:
        fail("cgroup limits changed across cold blocks")

    p50 = nearest_rank(latencies, 0.50)
    p95 = nearest_rank(latencies, 0.95)
    status = "passed"
    io_available_rows = [row for row in rows if row["io_observation_status"] == "available"]
    io_unavailable_rows = [row for row in rows if row["io_observation_status"] == "unavailable"]
    if len(io_available_rows) == len(rows):
        io_first_touch_status = "attributable"
        total_io_read_bytes: int | str = sum(
            unsigned(row, "io_read_bytes") for row in io_available_rows
        )
        total_io_write_bytes: int | str = sum(
            unsigned(row, "io_write_bytes") for row in io_available_rows
        )
    elif len(io_unavailable_rows) == len(rows):
        io_first_touch_status = "unavailable"
        total_io_read_bytes = ""
        total_io_write_bytes = ""
    else:
        io_first_touch_status = "mixed-unavailable"
        total_io_read_bytes = ""
        total_io_write_bytes = ""
    io_controllers = {row["io_controller_status"] for row in rows}
    io_reasons = {row["io_missing_reason"] for row in rows}
    io_controller_status = next(iter(io_controllers)) if len(io_controllers) == 1 else "mixed"
    io_missing_reason = next(iter(io_reasons)) if len(io_reasons) == 1 else "mixed"
    detail = f"cold-boundary-memory-resource-gates-passed;io-first-touch-{io_first_touch_status}"
    if args.max_p95_ms is not None and p95 > args.max_p95_ms:
        status = "failed"
        detail = "cold-start-p95-exceeds-declared-ceiling"
    values = [
        SUMMARY_SCHEMA,
        status,
        "research-only-non-release",
        detail,
        len(rows),
        f"{p50:.6f}",
        f"{p95:.6f}",
        "" if args.max_p95_ms is None else f"{args.max_p95_ms:.6f}",
        max(unsigned(row, "whole_scope_memory_peak_bytes") for row in rows),
        max(unsigned(row, "peak_file_dirty_bytes") for row in rows),
        max(unsigned(row, "peak_file_writeback_bytes") for row in rows),
        io_first_touch_status,
        io_controller_status,
        io_missing_reason,
        len(io_available_rows),
        len(io_unavailable_rows),
        total_io_read_bytes,
        total_io_write_bytes,
        next(iter(execution_identities)),
        next(iter(carrier_roots)),
        next(iter(memory_limits)),
        next(iter(high_limits)),
        next(iter(swap_limits)),
    ]
    columns = [
        "schema_version",
        "status",
        "classification",
        "detail",
        "blocks",
        "spawn_to_first_query_p50_ms",
        "spawn_to_first_query_p95_ms",
        "max_p95_ms",
        "max_whole_scope_memory_peak_bytes",
        "max_file_dirty_bytes",
        "max_file_writeback_bytes",
        "io_first_touch_status",
        "io_controller_status",
        "io_missing_reason",
        "io_attributable_block_count",
        "io_unavailable_block_count",
        "total_io_read_bytes",
        "total_io_write_bytes",
        "execution_identity_sha256",
        "carrier_root",
        "memory_max_bytes",
        "memory_high_bytes",
        "swap_max_bytes",
    ]
    if len(values) != len(columns):
        fail("internal cold summary schema mismatch")
    output = Path(os.path.abspath(args.output))
    receipt_path = Path(os.path.abspath(args.receipt))
    if output == receipt_path:
        fail("summary and receipt paths must differ")
    if output.parent != receipt_path.parent:
        fail("summary and receipt must share one publication directory")

    summary_stream = io.StringIO(newline="")
    writer = csv.writer(summary_stream, delimiter="\t", lineterminator="\n")
    writer.writerow(columns)
    writer.writerow(values)
    summary_payload = summary_stream.getvalue().encode("utf-8")
    receipt = {
        "schema_version": "oliphaunt.wasix-postmaster.cold-ownership-qualification-receipt.v1",
        "status": status,
        "classification": "research-only-non-release",
        "summary_sha256": hashlib.sha256(summary_payload).hexdigest(),
        "summarizer_sha256": hashlib.sha256(
            stable_regular_bytes(Path(__file__))
        ).hexdigest(),
        "inputs": inputs,
    }
    receipt_payload = (
        json.dumps(receipt, indent=2, sort_keys=True) + "\n"
    ).encode("utf-8")

    output.parent.mkdir(parents=True, exist_ok=True)
    token = f"{os.getpid()}.{secrets.token_hex(16)}"
    private_output = output.with_name(f".{output.name}.pending.{token}")
    private_receipt = receipt_path.with_name(f".{receipt_path.name}.pending.{token}")
    output_identity = write_bytes(private_output, summary_payload)
    receipt_identity = None
    try:
        receipt_identity = write_bytes(private_receipt, receipt_payload)
        publish_set(
            (private_output, output, private_receipt, receipt_path),
            (output_identity, receipt_identity),
        )
    finally:
        remove_private(private_output, output_identity)
        if receipt_identity is not None:
            remove_private(private_receipt, receipt_identity)
    return 0 if status == "passed" else 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (PublicationError, SummaryError, OSError, UnicodeError, ValueError) as error:
        print(f"cold-ownership summary failed: {error}", file=sys.stderr)
        raise SystemExit(1)
