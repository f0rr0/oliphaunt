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


SCRIPT = Path(__file__).with_name("compare-postgres-settings.py")
SPEC = importlib.util.spec_from_file_location("compare_postgres_settings", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)
NAMES = (
    "autovacuum_worker_slots", "backend_flush_after", "bgwriter_flush_after",
    "checkpoint_flush_after", "checkpoint_timeout", "fsync",
    "full_page_writes", "io_method", "max_connections", "max_wal_senders",
    "max_worker_processes", "max_wal_size", "min_wal_size",
    "shared_buffers", "synchronous_commit", "wal_segment_size",
)


class SettingsComparisonTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)

    def tearDown(self) -> None:
        self.temp.cleanup()

    def write(
        self,
        name: str,
        overrides: dict[str, tuple[str, str, str]] | None = None,
        extras: dict[str, tuple[str, str, str]] | None = None,
    ) -> Path:
        path = self.root / name
        overrides = overrides or {}
        extras = extras or {}
        with path.open("w", encoding="utf-8", newline="") as handle:
            writer = csv.writer(handle, delimiter="\t", lineterminator="\n")
            writer.writerow(("name", "setting", "unit", "source"))
            for setting in NAMES:
                writer.writerow((setting, *overrides.get(setting, ("1", "", "command line"))))
            for setting in reversed(tuple(extras)):
                writer.writerow((setting, *extras[setting]))
        return path

    def run_compare(self, native: Path, wasix: Path, output: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [str(SCRIPT), str(native), str(wasix), str(self.root / output)],
            check=False, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )

    def test_exact_profile_passes(self) -> None:
        result = self.run_compare(self.write("native.tsv"), self.write("wasix.tsv"), "match.tsv")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue((self.root / "match.tsv").is_file())

    def test_value_or_source_mismatch_fails_with_evidence(self) -> None:
        native = self.write("native.tsv")
        wasix = self.write("wasix.tsv", {"io_method": ("worker", "", "default")})
        result = self.run_compare(native, wasix, "mismatch.tsv")
        self.assertEqual(result.returncode, 1)
        self.assertIn("mismatched", (self.root / "mismatch.tsv").read_text(encoding="utf-8"))

    def test_identical_explicit_settings_are_compared_after_baseline(self) -> None:
        extras = {
            "work_mem": ("4096", "kB", "command line"),
            "random_page_cost": ("1.1", "", "command line"),
        }
        result = self.run_compare(
            self.write("native.tsv", extras=extras),
            self.write("wasix.tsv", extras=extras),
            "extras.tsv",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        with (self.root / "extras.tsv").open(encoding="utf-8", newline="") as handle:
            names = [row["name"] for row in csv.DictReader(handle, delimiter="\t")]
        self.assertEqual(names, [*NAMES, "random_page_cost", "work_mem"])

    def test_explicit_setting_mismatch_fails_with_evidence(self) -> None:
        native = self.write(
            "native.tsv", extras={"work_mem": ("4096", "kB", "command line")}
        )
        wasix = self.write(
            "wasix.tsv", extras={"work_mem": ("8192", "kB", "command line")}
        )
        result = self.run_compare(native, wasix, "work-mem-mismatch.tsv")
        self.assertEqual(result.returncode, 1)
        self.assertIn(
            "work_mem\t4096\tkB\tcommand line\t8192\tkB\tcommand line\tmismatched",
            (self.root / "work-mem-mismatch.tsv").read_text(encoding="utf-8"),
        )

    def test_explicit_key_set_mismatch_fails_closed(self) -> None:
        native = self.write(
            "native.tsv", extras={"work_mem": ("4096", "kB", "command line")}
        )
        wasix = self.write("wasix.tsv")
        result = self.run_compare(native, wasix, "key-set-mismatch.tsv")
        self.assertEqual(result.returncode, 1)
        self.assertIn("native/WASIX settings key set mismatch", result.stderr)
        self.assertFalse((self.root / "key-set-mismatch.tsv").exists())

    def test_missing_required_key_fails_closed(self) -> None:
        native = self.write("native.tsv")
        wasix = self.write("wasix.tsv")
        lines = wasix.read_text(encoding="utf-8").splitlines()
        wasix.write_text("\n".join(line for line in lines if not line.startswith("io_method\t")) + "\n", encoding="utf-8")
        result = self.run_compare(native, wasix, "missing.tsv")
        self.assertEqual(result.returncode, 1)
        self.assertFalse((self.root / "missing.tsv").exists())

    def test_load_uses_one_stable_snapshot_if_path_is_replaced(self) -> None:
        source = self.write("settings.tsv")
        replacement = self.write(
            "replacement.tsv", {"io_method": ("worker", "", "default")}
        )
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
        self.assertEqual(loaded["io_method"], ("1", "", "command line"))
        self.assertIn(b"io_method\tworker\t\tdefault\n", source.read_bytes())

    def test_rejects_rows_with_missing_or_extra_fields(self) -> None:
        for name, fields in (
            ("missing-fields.tsv", ("io_method", "worker", "")),
            ("extra-fields.tsv", ("io_method", "worker", "", "default", "unexpected")),
        ):
            with self.subTest(name=name):
                path = self.root / name
                with path.open("w", encoding="utf-8", newline="") as handle:
                    writer = csv.writer(handle, delimiter="\t", lineterminator="\n")
                    writer.writerow(("name", "setting", "unit", "source"))
                    writer.writerow(fields)
                with self.assertRaisesRegex(MODULE.EvidenceError, "malformed settings row 2"):
                    MODULE.load(path)

    def test_destination_appearing_at_commit_is_not_replaced(self) -> None:
        native = self.write("native.tsv")
        wasix = self.write("wasix.tsv")
        output = self.root / "raced.tsv"
        competitor = b"concurrent owner\n"
        real_publish = MODULE.publish_no_replace

        def publish_after_competitor(source: Path, destination: Path) -> None:
            destination.write_bytes(competitor)
            real_publish(source, destination)

        with mock.patch.object(MODULE, "publish_no_replace", publish_after_competitor):
            with self.assertRaises(MODULE.EvidenceError):
                MODULE.main([str(SCRIPT), str(native), str(wasix), str(output)])
        self.assertEqual(output.read_bytes(), competitor)
        self.assertEqual(list(self.root.glob(".postgres-settings.*")), [])


if __name__ == "__main__":
    unittest.main()
