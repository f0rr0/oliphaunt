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
VALIDATOR = ROOT / "validate-checkpoint-recycle.py"
SPEC = importlib.util.spec_from_file_location("validate_checkpoint_recycle", VALIDATOR)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


def write_tsv(path: Path, header: list[str], rows: list[list[object]]) -> None:
    with path.open("x", newline="", encoding="utf-8") as stream:
        writer = csv.writer(stream, delimiter="\t", lineterminator="\n")
        writer.writerow(header)
        writer.writerows(rows)


class CheckpointEvidenceTest(unittest.TestCase):
    def fixture(
        self,
        *,
        requested: int = 0,
        corrupt_schedule: bool = False,
        extra_transaction_field: bool = False,
    ) -> tuple[Path, list[str]]:
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        transactions = root / "transactions.tsv"
        flushes = root / "flushes.tsv"
        before = root / "before.tsv"
        after = root / "after.tsv"
        log = root / "server.log"
        output = root / "summary.tsv"
        gates = root / "gates.tsv"
        tx_header = [
            "schema_version", "client", "sequence", "scheduled_mono_ns",
            "start_mono_ns", "end_mono_ns", "start_real_ns", "end_real_ns",
            "service_ns", "lateness_ns", "status", "update_count",
            "insert_count", "read_count", "insert_lsn",
        ]
        base_real = 1_786_320_000_000_000_000
        rows: list[list[object]] = []
        for client in (1, 2):
            for sequence in (1, 2):
                scheduled = (
                    1_000_000_000
                    + (client - 1) * 1_000_000
                    + (sequence - 1) * 1_000_000_000
                )
                if corrupt_schedule and client == 2 and sequence == 2:
                    scheduled += 1
                start = base_real + scheduled
                start_mono = scheduled
                rows.append(
                    [1, client, sequence, scheduled,
                     start_mono, start_mono + 2_000_000,
                     start, start + 2_000_000, 2_000_000, 0, "ok", 48, 16, 8,
                     f"0/{client}{sequence}"]
                )
        if extra_transaction_field:
            rows[0].append("unexpected")
        write_tsv(transactions, tx_header, rows)
        write_tsv(
            flushes,
            ["schema_version", "client", "through_sequence", "insert_lsn",
             "flush_lsn", "covers", "status"],
            [[1, 1, 2, "0/12", "0/20", "t", "ok"],
             [1, 2, 2, "0/22", "0/30", "t", "ok"]],
        )
        write_tsv(before, ["num_timed", "num_requested", "num_done", "wal_bytes"], [[10, 4, 14, 100]])
        write_tsv(after, ["num_timed", "num_requested", "num_done", "wal_bytes"], [[11, 4 + requested, 15 + requested, 1100]])
        log.write_text(
            "2026-08-10 00:00:01.000500 UTC [1] LOG: checkpoint starting: time\n"
            "2026-08-10 00:00:01.001500 UTC [1] LOG: checkpoint complete: wrote 1 buffers; total=0.001 s; sync=0.001 s\n",
            encoding="utf-8",
        )
        return root, [
            str(VALIDATOR),
            "--transactions", str(transactions),
            "--flushes", str(flushes),
            "--checkpoint-before", str(before),
            "--checkpoint-after", str(after),
            "--server-log", str(log),
            "--output", str(output),
            "--gates-output", str(gates),
            "--target", "wasix",
            "--mode", "smoke",
            "--clients", "2",
            "--duration-seconds", "2",
            "--tps-per-client", "1",
            "--stagger-us", "1000",
            "--min-achieved-tps", "2",
            "--min-wal-bytes", "1000",
            "--min-checkpoints", "1",
            "--min-overlap-samples", "1",
        ]

    def run_command(self, command: list[str]) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            command,
            text=True,
            capture_output=True,
            check=False,
        )

    def run_fixture(
        self, *, requested: int = 0, corrupt_schedule: bool = False
    ) -> subprocess.CompletedProcess[str]:
        _, command = self.fixture(
            requested=requested, corrupt_schedule=corrupt_schedule
        )
        return self.run_command(command)

    def test_valid_smoke_evidence_passes(self) -> None:
        result = self.run_fixture()
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_requested_checkpoint_fails(self) -> None:
        result = self.run_fixture(requested=1)
        self.assertEqual(result.returncode, 1, result.stderr)

    def test_non_grid_schedule_fails(self) -> None:
        result = self.run_fixture(corrupt_schedule=True)
        self.assertEqual(result.returncode, 1, result.stderr)

    def test_rejects_extra_tsv_fields(self) -> None:
        _, command = self.fixture(extra_transaction_field=True)
        result = self.run_command(command)
        self.assertEqual(result.returncode, 2, result.stderr)

    def test_rejects_nonfinite_nonpositive_and_out_of_range_options(self) -> None:
        invalid = (
            ("--min-achieved-tps", "nan"),
            ("--min-achieved-tps", "-inf"),
            ("--max-p95-ms", "inf"),
            ("--max-overlap-ratio", "0"),
            ("--clients", "5"),
            ("--duration-seconds", "86401"),
            ("--tps-per-client", "10001"),
            ("--min-wal-bytes", str(1 << 64)),
        )
        for option, value in invalid:
            with self.subTest(option=option, value=value):
                _, command = self.fixture()
                result = self.run_command([*command, option, value])
                self.assertEqual(result.returncode, 2, result.stderr)

    def test_outputs_must_be_distinct_and_share_one_parent(self) -> None:
        root, command = self.fixture()
        output = root / "summary.tsv"
        gates_index = command.index("--gates-output") + 1
        command[gates_index] = str(output)
        result = self.run_command(command)
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertFalse(output.exists())

        root, command = self.fixture()
        other = root / "other"
        other.mkdir()
        gates_index = command.index("--gates-output") + 1
        command[gates_index] = str(other / "gates.tsv")
        result = self.run_command(command)
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertFalse((root / "summary.tsv").exists())

    def test_replay_completes_partial_identical_output_set(self) -> None:
        root, command = self.fixture()
        first = self.run_command(command)
        self.assertEqual(first.returncode, 0, first.stderr)
        summary = root / "summary.tsv"
        gates = root / "gates.tsv"
        summary_bytes = summary.read_bytes()
        summary_inode = summary.stat().st_ino
        gates_bytes = gates.read_bytes()
        self.assertEqual(summary.stat().st_mode & 0o777, 0o444)
        self.assertEqual(gates.stat().st_mode & 0o777, 0o444)
        gates.unlink()

        replay = self.run_command(command)
        self.assertEqual(replay.returncode, 0, replay.stderr)
        self.assertEqual(summary.read_bytes(), summary_bytes)
        self.assertEqual(summary.stat().st_ino, summary_inode)
        self.assertEqual(gates.read_bytes(), gates_bytes)
        self.assertEqual(list(root.glob(".*.pending.*")), [])

    def test_conflicting_member_prevents_any_partial_admission(self) -> None:
        root, command = self.fixture()
        gates = root / "gates.tsv"
        competitor = b"concurrent owner\n"
        gates.write_bytes(competitor)
        result = self.run_command(command)
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertFalse((root / "summary.tsv").exists())
        self.assertEqual(gates.read_bytes(), competitor)
        self.assertEqual(list(root.glob(".*.pending.*")), [])

    def test_tsv_parser_uses_one_captured_generation(self) -> None:
        root, _ = self.fixture()
        source = root / "state.tsv"
        write_tsv(source, MODULE.STATE_HEADER, [[1, 2, 3, 4]])
        replacement = root / "replacement.tsv"
        write_tsv(replacement, MODULE.STATE_HEADER, [[5, 6, 7, 8]])
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
            self.assertEqual(
                MODULE.read_state(source),
                {"num_timed": 1, "num_requested": 2, "num_done": 3, "wal_bytes": 4},
            )
        self.assertEqual(reads, 1)
        self.assertIn("5\t6\t7\t8", source.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
