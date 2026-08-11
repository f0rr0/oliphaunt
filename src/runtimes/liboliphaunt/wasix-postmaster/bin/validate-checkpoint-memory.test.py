#!/usr/bin/env python3

from __future__ import annotations

import csv
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parent
VALIDATOR = ROOT / "validate-checkpoint-memory.py"
HEADER = [
    "schema_version", "epoch", "epoch_origin_monotonic_ns",
    "monotonic_ns", "phase", "process_count", "pss_kib", "pss_anon_kib",
    "private_kib", "pagetables_kib", "cgroup_current_bytes",
    "cgroup_peak_bytes",
    "cgroup_swap_bytes", "cgroup_anon_bytes", "cgroup_file_bytes",
    "cgroup_kernel_bytes", "cgroup_pagetables_bytes",
    "cgroup_file_dirty_bytes", "cgroup_file_writeback_bytes", "event_high",
    "event_max", "event_oom", "event_oom_kill", "psi_some_total_usec",
    "psi_full_total_usec",
]


class CheckpointMemoryTest(unittest.TestCase):
    def run_fixture(
        self,
        *,
        oom_delta: int = 0,
        restart_oom: int = 0,
        wrong_phase_order: bool = False,
        reuse_cgroup: bool = False,
    ) -> subprocess.CompletedProcess[str]:
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        samples = root / "samples.tsv"
        epochs = root / "epochs.tsv"
        phases = [
            "initial-quiescent",
            "initial-quiescent",
            "steady",
            "volume-checkpoint",
            "volume-checkpoint",
            "recycle-shutdown",
            "recycle-startup",
            "second-steady",
            "post-recycle-quiescent",
            "post-recycle-quiescent",
            "post-recycle-quiescent",
        ]
        if wrong_phase_order:
            phases[2], phases[3] = phases[3], phases[2]
        with samples.open("x", newline="", encoding="utf-8") as stream:
            writer = csv.writer(stream, delimiter="\t", lineterminator="\n")
            writer.writerow(HEADER)
            for index, phase in enumerate(phases):
                writer.writerow(
                    [
                        1, 1 if index < 6 else 2,
                        0 if index < 6 else 6_500_000_000,
                        (index + 1) * 1_000_000_000, phase, 4,
                        70000 + index * 100, 45000 + index * 50,
                        50000 + index * 50, 900, 120_000_000, 130_000_000,
                        0, 50_000_000, 60_000_000, 3_000_000, 900_000,
                        10_000_000, 1_000_000, (index % 6) * 10, 0,
                        restart_oom
                        + (oom_delta if index == len(phases) - 1 else 0)
                        if index >= 6
                        else 0,
                        0, (index % 6) * 1000, (index % 6) * 500,
                    ]
                )
        with epochs.open("x", newline="", encoding="utf-8") as stream:
            writer = csv.writer(stream, delimiter="\t", lineterminator="\n")
            writer.writerow(
                [
                    "schema_version", "epoch", "epoch_origin_monotonic_ns",
                    "cgroup_path", "cgroup_identity", "memory_max_bytes",
                    "memory_high_bytes", "memory_swap_max_bytes",
                ]
            )
            writer.writerow(
                [1, 1, 0, "/sys/fs/cgroup/test-e1", "7:101",
                 268435456, 234881024, 0]
            )
            writer.writerow(
                [1, 2, 6_500_000_000,
                 "/sys/fs/cgroup/test-e1" if reuse_cgroup else "/sys/fs/cgroup/test-e2",
                 "7:101" if reuse_cgroup else "7:202",
                 268435456, 234881024, 0]
            )
        return subprocess.run(
            [
                str(VALIDATOR), "--samples", str(samples),
                "--epochs", str(epochs),
                "--output", str(root / "summary.tsv"),
                "--gates-output", str(root / "gates.tsv"),
            ],
            text=True,
            capture_output=True,
            check=False,
        )

    def test_bounded_evidence_passes(self) -> None:
        result = self.run_fixture()
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_oom_delta_fails(self) -> None:
        result = self.run_fixture(oom_delta=1)
        self.assertEqual(result.returncode, 1, result.stderr)

    def test_restart_boundary_oom_fails(self) -> None:
        result = self.run_fixture(restart_oom=1, oom_delta=1)
        self.assertEqual(result.returncode, 1, result.stderr)

    def test_wrong_phase_order_is_rejected(self) -> None:
        result = self.run_fixture(wrong_phase_order=True)
        self.assertEqual(result.returncode, 2, result.stderr)

    def test_reused_cgroup_scope_is_rejected(self) -> None:
        result = self.run_fixture(reuse_cgroup=True)
        self.assertEqual(result.returncode, 2, result.stderr)


if __name__ == "__main__":
    unittest.main()
