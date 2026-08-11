#!/usr/bin/env python3

from __future__ import annotations

import csv
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parent
EXTRACTOR = ROOT / "extract-checkpoint-summary.py"
HEADER = [
    "schema_version", "target", "mode", "status", "performance_enforced",
    "expected_transactions", "completed_transactions", "completion_fraction",
    "achieved_tps", "observed_window_ns", "scheduled_span_ns", "p50_ns",
    "p95_ns", "p99_ns", "max_ns", "overlap_samples", "overlap_p99_ns",
    "non_overlap_p99_ns", "timed_checkpoints", "requested_checkpoints",
    "completed_checkpoints", "logged_periodic_checkpoints", "wal_bytes", "gates",
]


class CheckpointSummaryExtractorTest(unittest.TestCase):
    def run_fixture(self, *, p99: object = 300) -> subprocess.CompletedProcess[str]:
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        summary = Path(temporary.name) / "summary.tsv"
        row = [
            "oliphaunt.wasix-postmaster.checkpoint-sample.v1", "wasix", "smoke",
            "passed", 0, 2400, 2400, "1.000000000", "59.900000", 40000000000,
            39900000000, 100, 200, p99, 400, 100, 300, 250, 1, 0, 1, 1,
            33554432, "/gates.tsv",
        ]
        with summary.open("x", newline="", encoding="utf-8") as stream:
            writer = csv.writer(stream, delimiter="\t", lineterminator="\n")
            writer.writerow(HEADER)
            writer.writerow(row)
        return subprocess.run(
            [str(EXTRACTOR), str(summary)], text=True, capture_output=True, check=False
        )

    def test_extracts_status_and_percentiles(self) -> None:
        result = self.run_fixture()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, "passed\t200\t300\n")

    def test_rejects_non_numeric_p99(self) -> None:
        result = self.run_fixture(p99="}")
        self.assertEqual(result.returncode, 2, result.stderr)


if __name__ == "__main__":
    unittest.main()
