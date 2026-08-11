#!/usr/bin/env python3

from __future__ import annotations

import csv
import hashlib
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


SCRIPT = Path(__file__).with_name("freeze-wasix-lifecycle-evidence.py")
NONCE = "0123456789abcdef0123456789abcdef"
FENCE = (
    "wasix-runtime-fence-v1"
    f"\tnonce={NONCE}\tseq=17\tmono_ns=9000\tphase=post-quiescence"
    "\tobserver_pid=42\tobserver_tid=1\trequest_seq=2\n"
).encode("ascii")
COMPLETE = (
    "wasix-runtime-phase-v1"
    f"\tnonce={NONCE}\tseq=6\tmono_ns=10000\tphase=complete\tobserver_pid=42\n"
).encode("ascii")


def commit_ack(offset: int, *, sequence: int = 17, mono_ns: int = 9000) -> bytes:
    return (
        "wasix-runtime-fence-commit-v1"
        f"\tnonce={NONCE}\tseq={sequence}\tmono_ns={mono_ns}"
        "\tphase=post-quiescence\tobserver_pid=42\tobserver_tid=1"
        f"\trequest_seq=2\tfence_end_offset={offset}\n"
    ).encode("ascii")


class FreezeLifecycleEvidenceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.raw = self.root / "raw.log"
        self.ack = self.root / "commit.ack"
        self.frozen = self.root / "frozen.log"
        self.receipt = self.root / "freeze.tsv"

    def tearDown(self) -> None:
        self.temp.cleanup()

    def run_freezer(
        self, *, complete_mono_ns: int = 10000
    ) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [
                str(SCRIPT),
                "--raw-log", str(self.raw),
                "--commit-ack", str(self.ack),
                "--output", str(self.frozen),
                "--receipt", str(self.receipt),
                "--nonce", NONCE,
                "--observer-pid", "42",
                "--complete-phase-sequence", "6",
                "--complete-phase-mono-ns", str(complete_mono_ns),
            ],
            check=False,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )

    def test_freezes_committed_offset_and_excludes_existing_and_future_tail(self) -> None:
        prefix = b"runtime-prefix\n" + FENCE
        self.raw.write_bytes(prefix + b"garbage-already-after-fence\n")
        ack = commit_ack(len(prefix))
        self.ack.write_bytes(ack)
        result = self.run_freezer()
        self.assertEqual(result.returncode, 0, result.stderr)
        expected = prefix + COMPLETE
        self.assertEqual(self.frozen.read_bytes(), expected)
        frozen_digest = hashlib.sha256(expected).hexdigest()
        with self.receipt.open(encoding="utf-8", newline="") as handle:
            row = next(csv.DictReader(handle, delimiter="\t"))
        self.assertEqual(
            row["schema_version"], "oliphaunt.wasix-postmaster.lifecycle-freeze.v2"
        )
        self.assertEqual(row["frozen_size"], str(len(expected)))
        self.assertEqual(row["sha256"], frozen_digest)
        self.assertEqual(row["commit_ack"], str(self.ack))
        self.assertEqual(row["commit_ack_sha256"], hashlib.sha256(ack).hexdigest())
        self.assertEqual(row["fence_end_offset"], str(len(prefix)))

        frozen_inode = self.frozen.stat().st_ino
        receipt_inode = self.receipt.stat().st_ino
        replay = self.run_freezer()
        self.assertEqual(replay.returncode, 0, replay.stderr)
        self.assertEqual(self.frozen.stat().st_ino, frozen_inode)
        self.assertEqual(self.receipt.stat().st_ino, receipt_inode)

        with self.raw.open("ab") as handle:
            handle.write(b"live-writer-tail\n")
        self.assertEqual(self.frozen.read_bytes(), expected)
        self.assertEqual(hashlib.sha256(self.frozen.read_bytes()).hexdigest(), frozen_digest)

        conflict = self.run_freezer(complete_mono_ns=10001)
        self.assertEqual(conflict.returncode, 1)
        self.assertIn("publication set destination differs", conflict.stderr)
        self.assertEqual(self.frozen.read_bytes(), expected)
        self.assertEqual(self.frozen.stat().st_ino, frozen_inode)
        self.assertEqual(self.receipt.stat().st_ino, receipt_inode)
        self.assertEqual(os.stat(self.frozen).st_mode & 0o777, 0o444)
        self.assertEqual(os.stat(self.receipt).st_mode & 0o777, 0o444)

    def test_partial_identical_set_is_completed_without_replacing_first_member(self) -> None:
        prefix = b"runtime-prefix\n" + FENCE
        self.raw.write_bytes(prefix)
        self.ack.write_bytes(commit_ack(len(prefix)))
        first = self.run_freezer()
        self.assertEqual(first.returncode, 0, first.stderr)
        frozen_inode = self.frozen.stat().st_ino
        self.receipt.chmod(0o644)
        self.receipt.unlink()

        replay = self.run_freezer()

        self.assertEqual(replay.returncode, 0, replay.stderr)
        self.assertEqual(self.frozen.stat().st_ino, frozen_inode)
        self.assertTrue(self.receipt.is_file())

    def test_missing_or_malformed_committed_ack_fails_closed(self) -> None:
        self.raw.write_bytes(FENCE)
        result = self.run_freezer()
        self.assertEqual(result.returncode, 1)
        self.assertIn("No such file", result.stderr)
        self.ack.write_bytes(b"wasix-runtime-fence-commit-v1\ttruncated\n")
        result = self.run_freezer()
        self.assertEqual(result.returncode, 1)
        self.assertIn("malformed committed ACK", result.stderr)
        self.assertFalse(self.frozen.exists())

    def test_ack_mismatch_or_nonterminal_offset_fails_closed(self) -> None:
        self.raw.write_bytes(FENCE + b"tail\n")
        for ack, detail in (
            (commit_ack(len(FENCE), sequence=18), "does not end at the matching"),
            (commit_ack(len(FENCE) - 1), "does not end at the matching"),
            (commit_ack(len(FENCE) + 5), "does not end at the matching"),
        ):
            with self.subTest(detail=detail, ack=ack):
                self.ack.write_bytes(ack)
                result = self.run_freezer()
                self.assertEqual(result.returncode, 1)
                self.assertIn(detail, result.stderr)
                self.assertFalse(self.frozen.exists())

    def test_duplicate_matching_fence_in_committed_prefix_fails_closed(self) -> None:
        raw = FENCE + FENCE
        self.raw.write_bytes(raw)
        self.ack.write_bytes(commit_ack(len(raw)))
        result = self.run_freezer()
        self.assertEqual(result.returncode, 1)
        self.assertIn("not unique", result.stderr)


if __name__ == "__main__":
    unittest.main()
