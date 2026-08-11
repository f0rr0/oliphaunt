#!/usr/bin/env python3
"""Summarize balanced native/WASIX checkpoint-overlap sample receipts."""

from __future__ import annotations

import argparse
import csv
import io
import math
import os
import re
import secrets
import statistics
import sys
from pathlib import Path
from typing import Callable

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))
from durable_publication import (  # noqa: E402
    PublicationError,
    publish_set,
    remove_private,
    stable_regular_bytes,
    write_bytes,
)


HEADER = [
    "block",
    "pair",
    "position",
    "target",
    "label",
    "harness_status",
    "sample_status",
    "p95_ns",
    "p99_ns",
    "report_dir",
    "settings_sha256",
]
SHA256 = re.compile(r"^[0-9a-f]{64}$")
U64_MAX = (1 << 64) - 1
MAX_BLOCKS = 10_000
MAX_RATIO = 1_000_000.0


class EvidenceError(ValueError):
    pass


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


def bounded_float(option: str) -> Callable[[str], float]:
    def parse(value: str) -> float:
        try:
            parsed = float(value)
        except ValueError as error:
            raise argparse.ArgumentTypeError(f"{option} must be a finite number") from error
        if not math.isfinite(parsed) or not 0 < parsed <= MAX_RATIO:
            raise argparse.ArgumentTypeError(
                f"{option} must be finite and in (0, {MAX_RATIO}]"
            )
        return parsed

    return parse


def sha256_identity(option: str) -> Callable[[str], str]:
    def parse(value: str) -> str:
        if SHA256.fullmatch(value) is None:
            raise argparse.ArgumentTypeError(
                f"{option} must be a lowercase SHA-256 identity"
            )
        return value

    return parse


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser()
    result.add_argument("--samples", type=Path, required=True)
    result.add_argument("--output", type=Path, required=True)
    result.add_argument("--result", type=Path, required=True)
    result.add_argument("--mode", choices=("smoke", "diagnostic", "qualification"), required=True)
    result.add_argument(
        "--blocks",
        type=bounded_integer("--blocks", minimum=1, maximum=MAX_BLOCKS),
        required=True,
    )
    result.add_argument(
        "--max-median-p95-ratio",
        type=bounded_float("--max-median-p95-ratio"),
        default=2.0,
    )
    result.add_argument(
        "--max-median-p99-ratio",
        type=bounded_float("--max-median-p99-ratio"),
        default=2.5,
    )
    result.add_argument(
        "--policy-sha256", type=sha256_identity("--policy-sha256"), required=True
    )
    result.add_argument(
        "--carrier-identity",
        type=sha256_identity("--carrier-identity"),
        required=True,
    )
    result.add_argument(
        "--native-identity",
        type=sha256_identity("--native-identity"),
        required=True,
    )
    result.add_argument("--memory-status", choices=("passed", "failed", "not-run"), required=True)
    return result


def unsigned(value: str, field: str, *, positive: bool = False) -> int:
    if not value.isascii() or not value.isdigit():
        raise EvidenceError(f"{field} is not an unsigned 64-bit integer")
    try:
        parsed = int(value)
    except ValueError as error:
        raise EvidenceError(f"{field} is not an unsigned 64-bit integer") from error
    minimum = 1 if positive else 0
    if not minimum <= parsed <= U64_MAX:
        raise EvidenceError(f"{field} is outside unsigned 64-bit range")
    return parsed


def read_rows(path: Path) -> list[dict[str, str]]:
    data = stable_regular_bytes(path)
    text = data.decode("utf-8", errors="strict")
    reader = csv.DictReader(io.StringIO(text, newline=""), delimiter="\t", strict=True)
    if reader.fieldnames != HEADER:
        raise EvidenceError(f"unexpected sample header: {reader.fieldnames!r}")
    rows: list[dict[str, str]] = []
    for line_number, row in enumerate(reader, 2):
        if (
            None in row
            or tuple(row) != tuple(HEADER)
            or any(value is None for value in row.values())
        ):
            raise EvidenceError(f"malformed sample row {line_number}")
        rows.append(row)
    if not rows:
        raise EvidenceError("sample receipt contains no rows")
    return rows


def render(rows: list[list[object]]) -> bytes:
    stream = io.StringIO(newline="")
    csv.writer(stream, delimiter="\t", lineterminator="\n").writerows(rows)
    return stream.getvalue().encode("utf-8")


def output_pair(first: Path, second: Path) -> tuple[Path, Path]:
    first = Path(os.path.abspath(first))
    second = Path(os.path.abspath(second))
    if first == second:
        raise EvidenceError("paired summary and qualification result must differ")
    if first.parent != second.parent:
        raise EvidenceError(
            "paired summary and qualification result must share one directory"
        )
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


def main() -> int:
    args = parser().parse_args()
    try:
        args.output, args.result = output_pair(args.output, args.result)
        samples = Path(os.path.abspath(args.samples))
        pairs: dict[tuple[int, int], dict[str, tuple[int, int]]] = {}
        settings: dict[tuple[int, int], dict[str, str]] = {}
        failed = False
        seen_positions: set[tuple[int, int]] = set()
        seen_labels: set[str] = set()
        rows = read_rows(samples)
        for row in rows:
            if row["target"] not in ("native", "wasix"):
                raise EvidenceError("unknown target in sample receipt")
            block = unsigned(row["block"], "block", positive=True)
            pair_number = unsigned(row["pair"], "pair", positive=True)
            position = unsigned(row["position"], "position", positive=True)
            harness_status = unsigned(row["harness_status"], "harness_status")
            p95_ns = unsigned(row["p95_ns"], "p95_ns", positive=True)
            p99_ns = unsigned(row["p99_ns"], "p99_ns", positive=True)
            position_key = (block, position)
            expected_order = (
                ("native", "wasix", "wasix", "native")
                if block % 2 == 1
                else ("wasix", "native", "native", "wasix")
            )
            if (
                block not in range(1, args.blocks + 1)
                or position not in range(1, 5)
                or pair_number != (position - 1) // 2 + 1
                or row["target"] != expected_order[position - 1]
                or position_key in seen_positions
                or not row["label"]
                or row["label"] in seen_labels
                or not row["report_dir"]
                or not SHA256.fullmatch(row["settings_sha256"])
                or p99_ns < p95_ns
                or row["sample_status"] not in ("passed", "failed")
            ):
                raise EvidenceError("sample receipt violates the balanced block plan")
            seen_positions.add(position_key)
            seen_labels.add(row["label"])
            key = (block, pair_number)
            if row["target"] in pairs.setdefault(key, {}):
                raise EvidenceError(f"duplicate target within balanced pair: {key}")
            pairs[key][row["target"]] = (p95_ns, p99_ns)
            settings.setdefault(key, {})[row["target"]] = row["settings_sha256"]
            failed |= harness_status != 0 or row["sample_status"] != "passed"
        expected_rows = args.blocks * 4
        expected_pairs = args.blocks * 2
        if len(rows) != expected_rows or len(pairs) != expected_pairs:
            failed = True
        p95_ratios: list[float] = []
        p99_ratios: list[float] = []
        settings_equal = True
        for key in sorted(pairs):
            pair = pairs[key]
            if set(pair) != {"native", "wasix"}:
                failed = True
                continue
            native_p95, native_p99 = pair["native"]
            wasix_p95, wasix_p99 = pair["wasix"]
            if native_p95 <= 0 or native_p99 <= 0:
                failed = True
                continue
            p95_ratios.append(wasix_p95 / native_p95)
            p99_ratios.append(wasix_p99 / native_p99)
            if settings.get(key, {}).get("native") != settings.get(key, {}).get("wasix"):
                settings_equal = False
        if not p95_ratios or not p99_ratios:
            raise EvidenceError("no complete native/WASIX pairs")
        median_p95 = statistics.median(p95_ratios)
        median_p99 = statistics.median(p99_ratios)
        performance_enforced = args.mode in ("diagnostic", "qualification")
        ratios_pass = (
            median_p95 <= args.max_median_p95_ratio
            and median_p99 <= args.max_median_p99_ratio
        )
        if performance_enforced and not ratios_pass:
            failed = True
        if not settings_equal:
            failed = True
        if args.memory_status != "passed":
            failed = True
        if args.mode == "qualification" and args.blocks < 10:
            failed = True
        status = "failed" if failed else "passed"
        classification = f"research-only-{args.mode}-{status}-non-release"
        summary_payload = render(
            [[
                "schema_version", "mode", "status", "paired_samples",
                "median_p95_ratio", "median_p99_ratio", "performance_enforced",
                "settings_equal", "memory_status",
            ], [
                "oliphaunt.wasix-postmaster.checkpoint-paired.v1", args.mode,
                status, len(p95_ratios), f"{median_p95:.9f}",
                f"{median_p99:.9f}", int(performance_enforced),
                int(settings_equal), args.memory_status,
            ]],
        )
        result_payload = render(
            [[
                "schema_version", "status", "classification", "claim_scope",
                "mode", "blocks", "policy_sha256", "carrier_identity",
                "native_identity", "samples", "paired_summary",
                "memory_status",
            ], [
                "oliphaunt.wasix-postmaster.checkpoint-qualification.v1",
                status, classification,
                "checkpoint-recycle-only-non-release",
                args.mode, args.blocks, args.policy_sha256,
                args.carrier_identity, args.native_identity, samples,
                args.output, args.memory_status,
            ]],
        )
        publish_outputs(
            args.output,
            summary_payload,
            args.result,
            result_payload,
        )
        return 0 if status == "passed" else 1
    except (PublicationError, OSError, UnicodeError, ValueError, csv.Error) as error:
        print(f"checkpoint qualification summary failed: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
