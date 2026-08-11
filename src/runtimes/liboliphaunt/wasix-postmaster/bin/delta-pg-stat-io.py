#!/usr/bin/env python3
"""Validate and subtract two PostgreSQL 18 pg_stat_io CSV snapshots."""

from __future__ import annotations

import csv
from decimal import Decimal, InvalidOperation
import io
import os
from pathlib import Path
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))
from durable_publication import (  # noqa: E402
    PublicationError,
    publish as publish_no_replace,
    stable_regular_bytes,
)


KEYS = ("backend_type", "object", "context")
COUNTERS = (
    "reads",
    "read_bytes",
    "writes",
    "write_bytes",
    "writebacks",
    "extends",
    "extend_bytes",
    "hits",
    "evictions",
    "reuses",
    "fsyncs",
)
TIMERS = ("read_time", "write_time", "writeback_time", "extend_time", "fsync_time")
METRICS = (
    "reads",
    "read_bytes",
    "read_time",
    "writes",
    "write_bytes",
    "write_time",
    "writebacks",
    "writeback_time",
    "extends",
    "extend_bytes",
    "extend_time",
    "hits",
    "evictions",
    "reuses",
    "fsyncs",
    "fsync_time",
)
HEADER = (*KEYS, *METRICS, "stats_reset")


class EvidenceError(RuntimeError):
    pass


def load(path: Path) -> dict[tuple[str, str, str], dict[str, str]]:
    try:
        raw = stable_regular_bytes(path)
        text = raw.decode("utf-8", errors="strict")
    except (OSError, PublicationError, UnicodeDecodeError) as error:
        raise EvidenceError(f"could not read stable pg_stat_io input {path}: {error}") from error
    reader = csv.DictReader(io.StringIO(text, newline=""))
    if tuple(reader.fieldnames or ()) != HEADER:
        raise EvidenceError(f"pg_stat_io header mismatch: {path}")
    rows: dict[tuple[str, str, str], dict[str, str]] = {}
    for line_number, row in enumerate(reader, 2):
        if None in row or any(value is None for value in row.values()):
            raise EvidenceError(f"malformed pg_stat_io row {line_number}: {path}")
        key = tuple(row[name] for name in KEYS)
        if any(not value for value in key) or key in rows:
            raise EvidenceError(f"duplicate or empty pg_stat_io key at row {line_number}: {path}")
        if not row["stats_reset"]:
            raise EvidenceError(f"missing pg_stat_io stats_reset at row {line_number}: {path}")
        rows[key] = row
    if not rows:
        raise EvidenceError(f"pg_stat_io snapshot is empty: {path}")
    reset_values = {row["stats_reset"] for row in rows.values()}
    if len(reset_values) != 1:
        raise EvidenceError(f"pg_stat_io snapshot has inconsistent stats_reset values: {path}")
    return rows


def number(value: str, *, integer: bool, label: str) -> Decimal:
    try:
        parsed = Decimal(value)
    except InvalidOperation as error:
        raise EvidenceError(f"invalid pg_stat_io numeric value for {label}: {value!r}") from error
    if not parsed.is_finite() or parsed < 0 or (integer and parsed != parsed.to_integral_value()):
        raise EvidenceError(f"invalid pg_stat_io numeric value for {label}: {value!r}")
    return parsed


def canonical_decimal(value: Decimal, *, integer: bool) -> str:
    if integer:
        return str(int(value))
    rendered = format(value, "f")
    if "." in rendered:
        rendered = rendered.rstrip("0").rstrip(".")
    return rendered or "0"


def subtract(
    before: dict[tuple[str, str, str], dict[str, str]],
    after: dict[tuple[str, str, str], dict[str, str]],
) -> list[list[str]]:
    if set(before) != set(after):
        missing = sorted(set(before) - set(after))
        added = sorted(set(after) - set(before))
        raise EvidenceError(f"pg_stat_io key set changed: missing={missing!r} added={added!r}")
    output: list[list[str]] = []
    for key in sorted(before):
        old = before[key]
        new = after[key]
        if old["stats_reset"] != new["stats_reset"]:
            raise EvidenceError(f"pg_stat_io stats_reset changed for key {key!r}")
        deltas: list[str] = []
        for metric in METRICS:
            old_value = old[metric]
            new_value = new[metric]
            if (old_value == "") != (new_value == ""):
                raise EvidenceError(f"pg_stat_io NULL applicability changed for {key!r}/{metric}")
            if old_value == "":
                deltas.append("")
                continue
            integer = metric in COUNTERS
            old_number = number(old_value, integer=integer, label=f"before {key!r}/{metric}")
            new_number = number(new_value, integer=integer, label=f"after {key!r}/{metric}")
            if new_number < old_number:
                raise EvidenceError(f"pg_stat_io counter decreased for {key!r}/{metric}")
            deltas.append(canonical_decimal(new_number - old_number, integer=integer))
        output.append([*key, *deltas, old["stats_reset"]])
    return output


def main(argv: list[str]) -> int:
    if len(argv) != 4:
        print(f"usage: {argv[0]} BEFORE.csv AFTER.csv DELTA.tsv", file=sys.stderr)
        return 64
    before_path, after_path, output_path = map(Path, argv[1:])
    if output_path.exists() or output_path.is_symlink():
        raise EvidenceError(f"refusing to replace pg_stat_io delta: {output_path}")
    if not output_path.parent.is_dir():
        raise EvidenceError(f"pg_stat_io delta parent does not exist: {output_path.parent}")
    rows = subtract(load(before_path), load(after_path))
    descriptor, pending_name = tempfile.mkstemp(prefix=".pg-stat-io-delta.", dir=output_path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="") as handle:
            writer = csv.writer(handle, delimiter="\t", lineterminator="\n")
            writer.writerow((*KEYS, *(f"{name}_delta" for name in METRICS), "stats_reset"))
            writer.writerows(rows)
        os.chmod(pending_name, 0o444)
        try:
            publish_no_replace(Path(pending_name), output_path)
        except (OSError, PublicationError) as error:
            raise EvidenceError(
                f"could not publish pg_stat_io delta without replacement: {error}"
            ) from error
    except BaseException:
        try:
            os.unlink(pending_name)
        except FileNotFoundError:
            pass
        raise
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main(sys.argv))
    except EvidenceError as error:
        print(f"pg_stat_io delta: {error}", file=sys.stderr)
        raise SystemExit(1)
