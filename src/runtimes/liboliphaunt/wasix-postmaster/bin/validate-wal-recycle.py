#!/usr/bin/env python3
"""Validate bounded PostgreSQL WAL recycling from host-side snapshots."""

from __future__ import annotations

import argparse
import csv
import re
import sys
from collections import defaultdict
from pathlib import Path


HEADER = ["schema_version", "snapshot", "ordinal", "name", "size", "device", "inode"]
EXPECTED_SNAPSHOTS = [
    "before-steady",
    "after-steady",
    "after-volume",
    "plateau-1",
    "plateau-2",
    "plateau-3",
]
WAL_NAME = re.compile(r"^[0-9A-F]{24}$")
RECYCLED = re.compile(r"([0-9]+) recycled")


class EvidenceError(ValueError):
    pass


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser()
    result.add_argument("--snapshots", type=Path, required=True)
    result.add_argument("--server-log", type=Path, required=True)
    result.add_argument("--output", type=Path, required=True)
    result.add_argument("--gates-output", type=Path, required=True)
    result.add_argument("--max-plateau-range-bytes", type=int, default=33554432)
    result.add_argument("--max-plateau-count-range", type=int, default=2)
    result.add_argument("--max-latest-bytes", type=int, default=536870912)
    return result


def write(path: Path, rows: list[list[object]]) -> None:
    if path.exists() or path.is_symlink():
        raise EvidenceError(f"refusing to replace output: {path}")
    with path.open("x", newline="", encoding="utf-8") as stream:
        csv.writer(stream, delimiter="\t", lineterminator="\n").writerows(rows)


def main() -> int:
    args = parser().parse_args()
    try:
        for path in (args.snapshots, args.server_log):
            if not path.is_file() or path.is_symlink():
                raise EvidenceError(f"evidence must be regular and non-symlink: {path}")
        snapshots: dict[str, list[tuple[str, int, int, int]]] = {}
        snapshot_order: list[str] = []
        inode_history: dict[tuple[int, int], dict[str, set[str]]] = defaultdict(
            lambda: defaultdict(set)
        )
        snapshot_names: dict[str, set[str]] = defaultdict(set)
        snapshot_inodes: dict[str, set[tuple[int, int]]] = defaultdict(set)
        with args.snapshots.open(newline="", encoding="utf-8") as stream:
            reader = csv.DictReader(stream, delimiter="\t")
            if reader.fieldnames != HEADER:
                raise EvidenceError(f"unexpected WAL snapshot header: {reader.fieldnames!r}")
            for row in reader:
                if row["schema_version"] != "1" or not WAL_NAME.fullmatch(row["name"]):
                    raise EvidenceError("WAL snapshot contains a malformed row")
                numeric = [row[field] for field in ("ordinal", "size", "device", "inode")]
                if any(not value.isdigit() for value in numeric):
                    raise EvidenceError("WAL snapshot numeric field is malformed")
                if row["snapshot"] not in snapshots:
                    if row["snapshot"] in snapshot_order:
                        raise EvidenceError("WAL snapshot rows must be contiguous")
                    snapshots[row["snapshot"]] = []
                    snapshot_order.append(row["snapshot"])
                elif snapshot_order[-1] != row["snapshot"]:
                    raise EvidenceError("WAL snapshot rows must be contiguous")
                ordinal = int(row["ordinal"])
                record = (
                    row["name"],
                    int(row["size"]),
                    int(row["device"]),
                    int(row["inode"]),
                )
                identity = (record[2], record[3])
                if ordinal != len(snapshots[row["snapshot"]]) + 1:
                    raise EvidenceError(
                        "WAL snapshot ordinals must restart at one and be contiguous"
                    )
                if (
                    record[0] in snapshot_names[row["snapshot"]]
                    or identity in snapshot_inodes[row["snapshot"]]
                ):
                    raise EvidenceError(
                        "a WAL name or filesystem identity is duplicated within one snapshot"
                    )
                if snapshots[row["snapshot"]] and record[0] <= snapshots[row["snapshot"]][-1][0]:
                    raise EvidenceError(
                        "WAL snapshot rows must be in ascending segment-name order"
                    )
                if record[1] <= 0:
                    raise EvidenceError("WAL segment size must be positive")
                snapshots[row["snapshot"]].append(record)
                snapshot_names[row["snapshot"]].add(record[0])
                snapshot_inodes[row["snapshot"]].add(identity)
                inode_history[identity][row["snapshot"]].add(record[0])
        if snapshot_order != EXPECTED_SNAPSHOTS:
            raise EvidenceError(
                f"WAL snapshots are {snapshot_order!r}, expected {EXPECTED_SNAPSHOTS!r}"
            )
        if any(not snapshots[label] for label in EXPECTED_SNAPSHOTS):
            raise EvidenceError("every required WAL snapshot must contain a segment")
        recycled_log_count = 0
        with args.server_log.open(encoding="utf-8", errors="strict") as stream:
            for line in stream:
                match = RECYCLED.search(line)
                if match is not None:
                    recycled_log_count += int(match.group(1))
        reused_inodes = 0
        reuse_transitions = 0
        for by_snapshot in inode_history.values():
            identity_reused = False
            for earlier, later in zip(
                EXPECTED_SNAPSHOTS, EXPECTED_SNAPSHOTS[1:]
            ):
                if (
                    earlier in by_snapshot
                    and later in by_snapshot
                    and by_snapshot[earlier] != by_snapshot[later]
                ):
                    identity_reused = True
                    reuse_transitions += 1
            reused_inodes += int(identity_reused)
        last_three = snapshot_order[-3:]
        byte_totals = [sum(item[1] for item in snapshots[label]) for label in last_three]
        file_counts = [len(snapshots[label]) for label in last_three]
        byte_range = max(byte_totals) - min(byte_totals)
        count_range = max(file_counts) - min(file_counts)
        latest_bytes = byte_totals[-1]
        gates = [
            ("logged_recycling", ">0", recycled_log_count, recycled_log_count > 0),
            ("inode_reuse_under_new_name", ">0", reused_inodes, reused_inodes > 0),
            ("cross_snapshot_reuse_transitions", ">0", reuse_transitions, reuse_transitions > 0),
            (
                "last_three_byte_range",
                f"<={args.max_plateau_range_bytes}",
                byte_range,
                byte_range <= args.max_plateau_range_bytes,
            ),
            (
                "last_three_count_range",
                f"<={args.max_plateau_count_range}",
                count_range,
                count_range <= args.max_plateau_count_range,
            ),
            (
                "latest_wal_bytes",
                f"<={args.max_latest_bytes}",
                latest_bytes,
                latest_bytes <= args.max_latest_bytes,
            ),
        ]
        passed = all(item[3] for item in gates)
        write(
            args.gates_output,
            [["gate", "expected", "observed", "status"]]
            + [
                [name, expected, observed, "passed" if ok else "failed"]
                for name, expected, observed, ok in gates
            ],
        )
        write(
            args.output,
            [[
                "schema_version", "status", "snapshot_count",
                "logged_recycled_files", "reused_inode_count",
                "cross_snapshot_reuse_transitions",
                "last_three_byte_range", "last_three_count_range",
                "latest_wal_bytes", "gates",
            ], [
                "oliphaunt.wasix-postmaster.wal-recycle.v1",
                "passed" if passed else "failed", len(snapshot_order),
                recycled_log_count, reused_inodes, reuse_transitions,
                byte_range, count_range,
                latest_bytes, args.gates_output,
            ]],
        )
        return 0 if passed else 1
    except (EvidenceError, OSError, csv.Error) as error:
        print(f"WAL recycle validation failed: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
