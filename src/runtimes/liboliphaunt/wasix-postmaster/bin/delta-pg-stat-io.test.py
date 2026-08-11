#!/usr/bin/env python3

from __future__ import annotations

import csv
import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock


SCRIPT = Path(__file__).with_name("delta-pg-stat-io.py")
SPEC = importlib.util.spec_from_file_location("delta_pg_stat_io", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)
HEADER = [
    "backend_type", "object", "context", "reads", "read_bytes", "read_time",
    "writes", "write_bytes", "write_time", "writebacks", "writeback_time",
    "extends", "extend_bytes", "extend_time", "hits", "evictions", "reuses",
    "fsyncs", "fsync_time", "stats_reset",
]


def row(*, reads: str = "1", reset: str = "2026-08-09 00:00:00+00") -> list[str]:
    return [
        "client backend", "relation", "normal", reads, "8192", "0.25", "2",
        "16384", "0.5", "", "", "3", "24576", "0.75", "4", "0", "",
        "", "", reset,
    ]


class DeltaPgStatIoTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)

    def tearDown(self) -> None:
        self.temp.cleanup()

    def write(self, name: str, rows: list[list[str]]) -> Path:
        path = self.root / name
        with path.open("w", encoding="utf-8", newline="") as handle:
            writer = csv.writer(handle, lineterminator="\n")
            writer.writerow(HEADER)
            writer.writerows(rows)
        return path

    def run_delta(self, before: Path, after: Path, output: str = "delta.tsv") -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [str(SCRIPT), str(before), str(after), str(self.root / output)],
            check=False, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )

    def test_valid_delta_preserves_nulls(self) -> None:
        before = self.write("before.csv", [row()])
        changed = row(reads="5")
        changed[5] = "1.00"
        after = self.write("after.csv", [changed])
        result = self.run_delta(before, after)
        self.assertEqual(result.returncode, 0, result.stderr)
        fields = (self.root / "delta.tsv").read_text(encoding="utf-8").splitlines()[1].split("\t")
        self.assertEqual(fields[3], "4")
        self.assertEqual(fields[5], "0.75")
        self.assertEqual(fields[9], "")

    def test_rejects_key_change(self) -> None:
        before = self.write("before.csv", [row()])
        changed = row()
        changed[2] = "bulkread"
        after = self.write("after.csv", [changed])
        self.assertNotEqual(self.run_delta(before, after).returncode, 0)

    def test_rejects_stats_reset_change(self) -> None:
        before = self.write("before.csv", [row()])
        after = self.write("after.csv", [row(reset="2026-08-09 01:00:00+00")])
        self.assertNotEqual(self.run_delta(before, after).returncode, 0)

    def test_rejects_decrease_and_null_shape_change(self) -> None:
        before = self.write("before.csv", [row(reads="5")])
        after = self.write("after.csv", [row(reads="4")])
        self.assertNotEqual(self.run_delta(before, after).returncode, 0)
        changed = row(reads="5")
        changed[9] = "1"
        after = self.write("after-null.csv", [changed])
        self.assertNotEqual(self.run_delta(before, after, "delta-null.tsv").returncode, 0)

    def test_load_uses_one_stable_snapshot_if_path_is_replaced(self) -> None:
        source = self.write("snapshot.csv", [row(reads="1")])
        replacement = self.write("replacement.csv", [row(reads="99")])
        calls: list[Path] = []
        real_stable_regular_bytes = MODULE.stable_regular_bytes

        def stable_then_replace(path: Path) -> bytes:
            calls.append(Path(path))
            payload = real_stable_regular_bytes(path)
            os.replace(replacement, path)
            return payload

        with mock.patch.object(MODULE, "stable_regular_bytes", stable_then_replace):
            loaded = MODULE.load(source)

        self.assertEqual(calls, [source])
        self.assertEqual(loaded[("client backend", "relation", "normal")]["reads"], "1")
        self.assertIn(b",99,", source.read_bytes())

    def test_rejects_rows_with_missing_or_extra_fields(self) -> None:
        for name, fields in (
            ("missing.csv", row()[:-1]),
            ("extra.csv", [*row(), "unexpected"]),
        ):
            with self.subTest(name=name):
                path = self.root / name
                with path.open("w", encoding="utf-8", newline="") as handle:
                    writer = csv.writer(handle, lineterminator="\n")
                    writer.writerow(HEADER)
                    writer.writerow(fields)
                with self.assertRaisesRegex(MODULE.EvidenceError, "malformed pg_stat_io row 2"):
                    MODULE.load(path)

    def test_destination_appearing_at_commit_is_not_replaced(self) -> None:
        before = self.write("before.csv", [row()])
        after = self.write("after.csv", [row(reads="2")])
        output = self.root / "raced.tsv"
        competitor = b"concurrent owner\n"
        real_publish = MODULE.publish_no_replace

        def publish_after_competitor(source: Path, destination: Path) -> None:
            destination.write_bytes(competitor)
            real_publish(source, destination)

        with mock.patch.object(MODULE, "publish_no_replace", publish_after_competitor):
            with self.assertRaises(MODULE.EvidenceError):
                MODULE.main([str(SCRIPT), str(before), str(after), str(output)])
        self.assertEqual(output.read_bytes(), competitor)
        self.assertEqual(list(self.root.glob(".pg-stat-io-delta.*")), [])


if __name__ == "__main__":
    unittest.main()
