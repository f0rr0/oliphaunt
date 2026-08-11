#!/usr/bin/env python3

from __future__ import annotations

import csv
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


SCRIPT = Path(__file__).with_name("validate-wasix-lifecycle-memory-plateau.py")
NONCE = "0123456789abcdef0123456789abcdef"
FIELDS = (
    "schema_version",
    "nonce",
    "sequence",
    "stage",
    "completed_reconnects",
    "requested_reconnects",
    "checkpoint_every",
    "quiescence_seconds",
    "quiescence_start_ns",
    "quiescence_end_ns",
    "monotonic_before_ns",
    "monotonic_after_ns",
    "capture_elapsed_ns",
    "server_pid",
    "server_birth_identity",
    "pss_kib",
    "pss_anon_kib",
    "anonymous_kib",
    "heap_pss_kib",
    "heap_private_kib",
    "heap_mappings",
    "status",
)


class LifecycleMemoryPlateauTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.raw = self.root / "checkpoints.tsv"
        self.output = self.root / "result.tsv"
        self.runtime_plateau = self.root / "runtime-plateau.tsv"
        self.runtime_plateau.write_text(
            "schema_version\ttarget\tstatus\tnonce\tevidence_sha256\t"
            "freeze_receipt_sha256\treconnect_requested\treconnect_completed\t"
            "reconnect_start_mono_ns\treconnect_end_mono_ns\t"
            "readiness_fence_mono_ns\tpost_quiescence_fence_mono_ns\n"
            f"6\twasix\tpassed\t{NONCE}\t{'1' * 64}\t{'2' * 64}\t"
            "100\t100\t3005000000\t13030000000\t2500000000\t15040500000\n",
            encoding="utf-8",
        )

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def rows(self) -> list[dict[str, str | int]]:
        rows: list[dict[str, str | int]] = []
        for sequence, completed in enumerate((0, 25, 50, 75, 100)):
            rows.append(
                {
                    "schema_version": (
                        "oliphaunt.wasix-postmaster.lifecycle-memory-checkpoint.v1"
                    ),
                    "nonce": NONCE,
                    "sequence": sequence,
                    "stage": (
                        "baseline-fenced"
                        if completed == 0
                        else "final-fenced"
                        if completed == 100
                        else "wave-quiescent"
                    ),
                    "completed_reconnects": completed,
                    "requested_reconnects": 100,
                    "checkpoint_every": 25,
                    "quiescence_seconds": 2,
                    "quiescence_start_ns": 1_000_000_000 + sequence * 3_010_000_000,
                    "quiescence_end_ns": 3_000_000_000 + sequence * 3_010_000_000,
                    "monotonic_before_ns": 3_001_000_000 + sequence * 3_010_000_000,
                    "monotonic_after_ns": 3_002_000_000 + sequence * 3_010_000_000,
                    "capture_elapsed_ns": 1_000_000,
                    "server_pid": 4242,
                    "server_birth_identity": "linux-starttime:123456",
                    "pss_kib": (100_000, 100_400, 100_300, 100_450, 100_350)[sequence],
                    "pss_anon_kib": (70_000, 70_200, 70_100, 70_250, 70_150)[sequence],
                    "anonymous_kib": (70_100, 70_300, 70_200, 70_350, 70_250)[sequence],
                    "heap_pss_kib": (10_000, 10_100, 10_050, 10_125, 10_075)[sequence],
                    "heap_private_kib": (10_000, 10_100, 10_050, 10_125, 10_075)[sequence],
                    "heap_mappings": 1,
                    "status": "passed",
                }
            )
        return rows

    def write_rows(self, rows: list[dict[str, str | int]]) -> None:
        with self.raw.open("w", encoding="utf-8", newline="") as stream:
            writer = csv.DictWriter(
                stream, fieldnames=FIELDS, delimiter="\t", lineterminator="\n"
            )
            writer.writeheader()
            writer.writerows(rows)

    def run_validator(self, *extra: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            (
                sys.executable,
                str(SCRIPT),
                "--input",
                str(self.raw),
                "--output",
                str(self.output),
                "--runtime-plateau",
                str(self.runtime_plateau),
                "--nonce",
                NONCE,
                "--server-pid",
                "4242",
                "--requested-reconnects",
                "100",
                "--checkpoint-every",
                "25",
                "--min-quiescence-seconds",
                "1",
                "--max-pss-growth-kib",
                "512",
                "--max-pss-anon-growth-kib",
                "256",
                "--max-heap-growth-kib",
                "128",
                "--max-late-pss-slope-kib-per-1000-reconnects",
                "2048",
                "--max-late-pss-anon-slope-kib-per-1000-reconnects",
                "2048",
                "--max-late-heap-slope-kib-per-1000-reconnects",
                "1024",
                *extra,
            ),
            check=False,
            text=True,
            capture_output=True,
        )

    def result(self) -> dict[str, str]:
        with self.output.open(encoding="utf-8", newline="") as stream:
            rows = list(csv.DictReader(stream, delimiter="\t", strict=True))
        self.assertEqual(len(rows), 1)
        return rows[0]

    def test_accepts_exact_bounded_checkpoint_schedule(self) -> None:
        self.write_rows(self.rows())
        completed = self.run_validator()
        self.assertEqual(completed.returncode, 0, completed.stderr)
        result = self.result()
        self.assertEqual(result["status"], "passed")
        self.assertEqual(result["checkpoint_count"], "5")
        self.assertEqual(result["tail_start_reconnects"], "50")
        self.assertEqual(result["full_peak_growth_pss_kib"], "450")
        self.assertEqual(result["late_peak_growth_heap_pss_kib"], "75")
        self.assertRegex(result["input_sha256"], r"^[0-9a-f]{64}$")

    def test_rejects_growth_even_when_terminal_sample_falls(self) -> None:
        rows = self.rows()
        rows[3]["pss_kib"] = 100_900
        rows[4]["pss_kib"] = 100_100
        self.write_rows(rows)
        completed = self.run_validator()
        self.assertEqual(completed.returncode, 1)
        result = self.result()
        self.assertEqual(result["status"], "failed")
        self.assertIn("pss_kib growth exceeds", result["detail"])
        self.assertEqual(result["full_peak_growth_pss_kib"], "900")

    def test_rejects_small_but_monotonic_late_tail_leak(self) -> None:
        rows = self.rows()
        for index, value in zip((2, 3, 4), (100_300, 100_350, 100_400), strict=True):
            rows[index]["pss_kib"] = value
        self.write_rows(rows)
        completed = self.run_validator(
            "--max-late-pss-slope-kib-per-1000-reconnects", "1500"
        )
        self.assertEqual(completed.returncode, 1)
        result = self.result()
        self.assertEqual(result["status"], "failed")
        self.assertIn("late Theil-Sen slope", result["detail"])
        self.assertLessEqual(int(result["full_peak_growth_pss_kib"]), 512)

    def test_rejects_missing_intermediate_checkpoint(self) -> None:
        rows = self.rows()
        del rows[2]
        for sequence, row in enumerate(rows):
            row["sequence"] = sequence
        self.write_rows(rows)
        completed = self.run_validator()
        self.assertEqual(completed.returncode, 1)
        result = self.result()
        self.assertEqual(result["status"], "failed")
        self.assertIn("exact checkpoint schedule", result["detail"])

    def test_rejects_server_pid_reuse(self) -> None:
        rows = self.rows()
        rows[3]["server_birth_identity"] = "linux-starttime:999999"
        self.write_rows(rows)
        completed = self.run_validator()
        self.assertEqual(completed.returncode, 1)
        result = self.result()
        self.assertEqual(result["status"], "failed")
        self.assertIn("changes the server birth identity", result["detail"])

    def test_rejects_terminal_capture_before_bound_runtime_fence(self) -> None:
        self.write_rows(self.rows())
        text = self.runtime_plateau.read_text(encoding="utf-8")
        self.runtime_plateau.write_text(
            text.replace("15040500000", "16000000000"), encoding="utf-8"
        )
        completed = self.run_validator()
        self.assertEqual(completed.returncode, 1)
        result = self.result()
        self.assertEqual(result["status"], "failed")
        self.assertIn("precedes the post-quiescence fence", result["detail"])

    def test_rejects_short_quiescence_window(self) -> None:
        rows = self.rows()
        rows[1]["quiescence_seconds"] = 0
        self.write_rows(rows)
        completed = self.run_validator()
        self.assertEqual(completed.returncode, 1)
        result = self.result()
        self.assertEqual(result["status"], "failed")
        self.assertIn("insufficient quiescence", result["detail"])


if __name__ == "__main__":
    unittest.main()
