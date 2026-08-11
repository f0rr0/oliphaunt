#!/usr/bin/env python3

from __future__ import annotations

import csv
import importlib.util
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parent
SUMMARIZER = ROOT / "summarize-checkpoint-qualification.py"
SPEC = importlib.util.spec_from_file_location(
    "summarize_checkpoint_qualification", SUMMARIZER
)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)
HEADER = [
    "block", "pair", "position", "target", "label", "harness_status",
    "sample_status", "p95_ns", "p99_ns", "report_dir", "settings_sha256",
]


class CheckpointQualificationSummaryTest(unittest.TestCase):
    def fixture(
        self,
        *,
        wasix_p99: int = 12,
        wrong_order: bool = False,
        extra_field: bool = False,
    ) -> tuple[Path, list[str]]:
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        samples = root / "samples.tsv"
        with samples.open("x", newline="", encoding="utf-8") as stream:
            writer = csv.writer(stream, delimiter="\t", lineterminator="\n")
            writer.writerow(HEADER)
            for position, target in enumerate(("native", "wasix", "wasix", "native"), 1):
                if wrong_order and position == 1:
                    target = "wasix"
                pair = 1 if position <= 2 else 2
                row = [
                    1, pair, position, target, f"s{position}", 0, "passed",
                    5 if target == "native" else 8,
                    6 if target == "native" else wasix_p99,
                    f"/r/{position}", "a" * 64,
                ]
                if extra_field and position == 1:
                    row.append("unexpected")
                writer.writerow(row)
        return root, [
            str(SUMMARIZER), "--samples", str(samples),
            "--output", str(root / "summary.tsv"),
            "--result", str(root / "result.tsv"),
            "--mode", "diagnostic", "--blocks", "1",
            "--policy-sha256", "b" * 64,
            "--carrier-identity", "c" * 64,
            "--native-identity", "d" * 64,
            "--memory-status", "passed",
        ]

    def run_command(self, command: list[str]) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            command,
            text=True,
            capture_output=True,
            check=False,
        )

    def run_fixture(
        self, *, wasix_p99: int = 12, wrong_order: bool = False
    ) -> subprocess.CompletedProcess[str]:
        _, command = self.fixture(wasix_p99=wasix_p99, wrong_order=wrong_order)
        return self.run_command(command)

    def test_balanced_ratios_pass(self) -> None:
        result = self.run_fixture()
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_p99_ratio_gate_fails(self) -> None:
        result = self.run_fixture(wasix_p99=30)
        self.assertEqual(result.returncode, 1, result.stderr)

    def test_unbalanced_execution_order_is_rejected(self) -> None:
        result = self.run_fixture(wrong_order=True)
        self.assertEqual(result.returncode, 2, result.stderr)

    def test_rejects_extra_sample_fields(self) -> None:
        _, command = self.fixture(extra_field=True)
        result = self.run_command(command)
        self.assertEqual(result.returncode, 2, result.stderr)

    def test_rejects_nonfinite_nonpositive_and_unbounded_options(self) -> None:
        invalid = (
            ("--max-median-p95-ratio", "nan"),
            ("--max-median-p95-ratio", "inf"),
            ("--max-median-p99-ratio", "0"),
            ("--blocks", "10001"),
            ("--policy-sha256", "not-a-hash"),
            ("--carrier-identity", "C" * 64),
            ("--native-identity", "d" * 63),
        )
        for option, value in invalid:
            with self.subTest(option=option, value=value):
                _, command = self.fixture()
                result = self.run_command([*command, option, value])
                self.assertEqual(result.returncode, 2, result.stderr)

    def test_outputs_must_be_distinct_and_share_one_parent(self) -> None:
        root, command = self.fixture()
        result_index = command.index("--result") + 1
        command[result_index] = str(root / "summary.tsv")
        result = self.run_command(command)
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertFalse((root / "summary.tsv").exists())

        root, command = self.fixture()
        other = root / "other"
        other.mkdir()
        result_index = command.index("--result") + 1
        command[result_index] = str(other / "result.tsv")
        result = self.run_command(command)
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertFalse((root / "summary.tsv").exists())

    def test_replay_completes_partial_identical_output_set(self) -> None:
        root, command = self.fixture()
        first = self.run_command(command)
        self.assertEqual(first.returncode, 0, first.stderr)
        summary = root / "summary.tsv"
        result_path = root / "result.tsv"
        summary_bytes = summary.read_bytes()
        summary_inode = summary.stat().st_ino
        result_bytes = result_path.read_bytes()
        self.assertEqual(summary.stat().st_mode & 0o777, 0o444)
        self.assertEqual(result_path.stat().st_mode & 0o777, 0o444)
        result_path.unlink()

        replay = self.run_command(command)
        self.assertEqual(replay.returncode, 0, replay.stderr)
        self.assertEqual(summary.read_bytes(), summary_bytes)
        self.assertEqual(summary.stat().st_ino, summary_inode)
        self.assertEqual(result_path.read_bytes(), result_bytes)
        self.assertEqual(list(root.glob(".*.pending.*")), [])

    def test_conflicting_member_prevents_any_partial_admission(self) -> None:
        root, command = self.fixture()
        result_path = root / "result.tsv"
        competitor = b"concurrent owner\n"
        result_path.write_bytes(competitor)
        result = self.run_command(command)
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertFalse((root / "summary.tsv").exists())
        self.assertEqual(result_path.read_bytes(), competitor)
        self.assertEqual(list(root.glob(".*.pending.*")), [])

    def test_sample_parser_uses_one_captured_generation(self) -> None:
        root, _ = self.fixture()
        samples = root / "samples.tsv"
        captured = samples.read_bytes()
        replacement = root / "replacement.tsv"
        replacement.write_bytes(captured.replace(b"s1", b"replacement", 1))
        real_stable_read = MODULE.stable_regular_bytes
        reads = 0

        def replace_after_read(path: Path) -> bytes:
            nonlocal reads
            reads += 1
            data = real_stable_read(path)
            os.replace(replacement, path)
            return data

        with mock.patch.object(
            MODULE, "stable_regular_bytes", replace_after_read
        ):
            rows = MODULE.read_rows(samples)
        self.assertEqual(reads, 1)
        self.assertEqual(rows[0]["label"], "s1")
        self.assertIn("replacement", samples.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
