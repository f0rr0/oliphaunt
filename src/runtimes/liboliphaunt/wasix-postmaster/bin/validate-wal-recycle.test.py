#!/usr/bin/env python3

from __future__ import annotations

import csv
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parent
VALIDATOR = ROOT / "validate-wal-recycle.py"


class WalRecycleTest(unittest.TestCase):
    def run_fixture(
        self, *, recycled: int = 2, reuse_inode: bool = True, bad_ordinal: bool = False
    ) -> subprocess.CompletedProcess[str]:
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        snapshots = root / "snapshots.tsv"
        with snapshots.open("x", newline="", encoding="utf-8") as stream:
            writer = csv.writer(stream, delimiter="\t", lineterminator="\n")
            writer.writerow(["schema_version", "snapshot", "ordinal", "name", "size", "device", "inode"])
            labels = [
                "before-steady", "after-steady", "after-volume",
                "plateau-1", "plateau-2", "plateau-3",
            ]
            for index, label in enumerate(labels, start=1):
                writer.writerow(
                    [
                        1,
                        label,
                        2 if bad_ordinal and index == 1 else 1,
                        f"0000000100000000000000{index:02X}",
                        16777216,
                        7,
                        101 if reuse_inode else 100 + index,
                    ]
                )
        log = root / "server.log"
        log.write_text(
            f"2026-08-10 00:00:00 UTC LOG: checkpoint complete: 0 added, 0 removed, {recycled} recycled; total=1.0 s\n",
            encoding="utf-8",
        )
        return subprocess.run(
            [
                str(VALIDATOR), "--snapshots", str(snapshots),
                "--server-log", str(log), "--output", str(root / "summary.tsv"),
                "--gates-output", str(root / "gates.tsv"),
            ],
            text=True,
            capture_output=True,
            check=False,
        )

    def test_recycled_inode_and_plateau_pass(self) -> None:
        result = self.run_fixture()
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_missing_log_recycle_fails(self) -> None:
        result = self.run_fixture(recycled=0)
        self.assertEqual(result.returncode, 1, result.stderr)

    def test_same_inode_is_required_across_snapshots(self) -> None:
        result = self.run_fixture(reuse_inode=False)
        self.assertEqual(result.returncode, 1, result.stderr)

    def test_ordinals_restart_for_each_snapshot(self) -> None:
        result = self.run_fixture(bad_ordinal=True)
        self.assertEqual(result.returncode, 2, result.stderr)


if __name__ == "__main__":
    unittest.main()
