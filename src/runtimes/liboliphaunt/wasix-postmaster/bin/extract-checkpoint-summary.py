#!/usr/bin/env python3
"""Extract the three paired-qualification fields from one validated sample."""

from __future__ import annotations

import argparse
import csv
import sys
from pathlib import Path


HEADER = [
    "schema_version", "target", "mode", "status", "performance_enforced",
    "expected_transactions", "completed_transactions", "completion_fraction",
    "achieved_tps", "observed_window_ns", "scheduled_span_ns", "p50_ns",
    "p95_ns", "p99_ns", "max_ns", "overlap_samples", "overlap_p99_ns",
    "non_overlap_p99_ns", "timed_checkpoints", "requested_checkpoints",
    "completed_checkpoints", "logged_periodic_checkpoints", "wal_bytes", "gates",
]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("summary", type=Path)
    args = parser.parse_args()
    try:
        if not args.summary.is_file() or args.summary.is_symlink():
            raise ValueError("summary must be a regular non-symlink file")
        with args.summary.open(newline="", encoding="utf-8") as stream:
            reader = csv.DictReader(stream, delimiter="\t")
            if reader.fieldnames != HEADER:
                raise ValueError(f"unexpected checkpoint summary header: {reader.fieldnames!r}")
            rows = list(reader)
        if len(rows) != 1:
            raise ValueError("checkpoint summary must contain exactly one row")
        row = rows[0]
        if row["status"] not in ("passed", "failed"):
            raise ValueError("checkpoint summary status is malformed")
        for field in ("p95_ns", "p99_ns"):
            if not row[field].isdigit() or int(row[field]) <= 0:
                raise ValueError(f"checkpoint summary {field} is malformed")
        if int(row["p99_ns"]) < int(row["p95_ns"]):
            raise ValueError("checkpoint summary percentiles are nonmonotonic")
        print(row["status"], row["p95_ns"], row["p99_ns"], sep="\t")
        return 0
    except (OSError, csv.Error, ValueError) as error:
        print(f"checkpoint summary extraction failed: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
