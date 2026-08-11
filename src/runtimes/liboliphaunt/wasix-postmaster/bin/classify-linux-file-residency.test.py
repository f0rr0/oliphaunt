#!/usr/bin/env python3

from __future__ import annotations

import csv
import importlib.util
import mmap
import os
import platform
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).with_name("classify-linux-file-residency.py")
SPEC = importlib.util.spec_from_file_location("classify_linux_file_residency", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
CLASSIFIER = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = CLASSIFIER
SPEC.loader.exec_module(CLASSIFIER)
PAGE_SIZE = os.sysconf("SC_PAGE_SIZE")


@unittest.skipUnless(platform.system() == "Linux", "Linux mincore fixture")
class LinuxFileResidencyClassifierTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="file-residency-test-")
        self.root = Path(self.temp.name)
        self.carrier = self.root / "carrier"
        self.pgdata = self.root / "pgdata"
        for name in ("bin", "aot", "memory", "share"):
            (self.carrier / name).mkdir(parents=True, exist_ok=True)
        (self.pgdata / "base" / "12345").mkdir(parents=True)
        (self.pgdata / "global").mkdir()
        (self.pgdata / "pg_wal").mkdir()
        (self.pgdata / "base" / "pgsql_tmp").mkdir()
        (self.pgdata / "pg_stat_tmp").mkdir()

        self.resident = self.carrier / "bin" / "wasmer-headless"
        self.resident.write_bytes(b"R" * (2 * PAGE_SIZE))
        self.resident_fd = os.open(self.resident, os.O_RDONLY)
        self.resident_map = mmap.mmap(self.resident_fd, 0, access=mmap.ACCESS_READ)
        for offset in range(0, len(self.resident_map), PAGE_SIZE):
            self.assertEqual(self.resident_map[offset], ord("R"))

        self.sparse = self.carrier / "aot" / "sparse-module.bin"
        with self.sparse.open("wb") as stream:
            stream.truncate(16 * PAGE_SIZE)

        (self.carrier / "memory" / "postgres.bin").write_bytes(b"memory-image")
        (self.carrier / "share" / "extension.control").write_bytes(b"share")
        (self.carrier / "manifest.json").write_bytes(b"{}\n")
        (self.pgdata / "base" / "12345" / "16384").write_bytes(b"relation")
        (self.pgdata / "global" / "1262").write_bytes(b"global")
        (self.pgdata / "pg_wal" / "000000010000000000000001").write_bytes(b"wal")
        (self.pgdata / "base" / "pgsql_tmp" / "pgsql_tmp42.0").write_bytes(b"temp")
        (self.pgdata / "base" / "12345" / "t7_9001_vm.1").write_bytes(b"temp-relation")
        (self.pgdata / "pg_stat_tmp" / "global.stat").write_bytes(b"temp-stat")
        (self.pgdata / "PG_VERSION").write_bytes(b"18\n")

        self.files_output = self.root / "files.tsv"
        self.summary_output = self.root / "summary.tsv"

    def tearDown(self) -> None:
        self.resident_map.close()
        os.close(self.resident_fd)
        self.temp.cleanup()

    def run_classifier(
        self, carrier: Path | None = None, suffix: str = ""
    ) -> subprocess.CompletedProcess[str]:
        files_output = self.root / f"files{suffix}.tsv"
        summary_output = self.root / f"summary{suffix}.tsv"
        result = subprocess.run(
            [
                "python3",
                str(SCRIPT),
                "--carrier-root",
                str(carrier or self.carrier),
                "--pgdata-root",
                str(self.pgdata),
                "--files-output",
                str(files_output),
                "--summary-output",
                str(summary_output),
            ],
            check=False,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        return result

    def read_rows(self, path: Path) -> list[dict[str, str]]:
        with path.open("r", encoding="utf-8", newline="") as stream:
            return list(csv.DictReader(stream, delimiter="\t"))

    def test_sparse_resident_temp_and_summary_accounting(self) -> None:
        result = self.run_classifier()
        self.assertEqual(result.returncode, 0, result.stderr)
        files = self.read_rows(self.files_output)
        by_path = {(row["root"], row["relative_path"]): row for row in files}

        sparse = by_path[("carrier", "aot/sparse-module.bin")]
        self.assertEqual(sparse["resident_pages"], "0")
        self.assertEqual(sparse["nonresident_pages"], "16")
        self.assertEqual(sparse["nonresident_logical_bytes"], str(16 * PAGE_SIZE))
        self.assertEqual(sparse["nonresident_page_bytes"], str(16 * PAGE_SIZE))

        resident = by_path[("carrier", "bin/wasmer-headless")]
        self.assertEqual(resident["resident_pages"], "2")
        self.assertEqual(resident["resident_logical_bytes"], str(2 * PAGE_SIZE))
        self.assertEqual(resident["resident_page_bytes"], str(2 * PAGE_SIZE))

        self.assertEqual(
            by_path[("pgdata", "base/pgsql_tmp/pgsql_tmp42.0")]["category"], "temp"
        )
        self.assertEqual(by_path[("pgdata", "base/12345/t7_9001_vm.1")]["category"], "temp")
        self.assertEqual(by_path[("pgdata", "pg_stat_tmp/global.stat")]["category"], "temp")
        self.assertEqual(
            by_path[("pgdata", "base/12345/16384")]["category"],
            "relation-index-aggregate",
        )
        self.assertEqual(by_path[("pgdata", "base/12345/16384")]["scope"], "base")

        summary = self.read_rows(self.summary_output)
        expected_order = [
            ("carrier", "bin", "-"),
            ("carrier", "aot", "-"),
            ("carrier", "memory", "-"),
            ("carrier", "share", "-"),
            ("carrier", "metadata", "-"),
            ("pgdata", "relation-index-aggregate", "base"),
            ("pgdata", "relation-index-aggregate", "global"),
            ("pgdata", "pg_wal", "-"),
            ("pgdata", "temp", "-"),
            ("pgdata", "other", "-"),
            ("all", "total", "-"),
        ]
        self.assertEqual(
            [(row["root"], row["category"], row["scope"]) for row in summary],
            expected_order,
        )
        total = summary[-1]
        self.assertEqual(total["status"], "passed")
        self.assertEqual(total["error_count"], "0")
        self.assertEqual(total["probe_major_faults_delta"], "0")
        self.assertEqual(total["probe_snapshot_scope"], "sequential-point-in-time")
        self.assertEqual(total["probe_consecutive_vectors_stable"], "yes")
        self.assertGreater(int(total["probe_scan_started_monotonic_ns"]), 0)
        self.assertGreaterEqual(
            int(total["probe_scan_completed_monotonic_ns"]),
            int(total["probe_scan_started_monotonic_ns"]),
        )
        self.assertGreaterEqual(float(total["probe_scan_duration_ms"]), 0.0)
        self.assertEqual(total["probe_payload_bytes_read"], "0")
        self.assertEqual(
            int(total["resident_pages"]) + int(total["nonresident_pages"]),
            int(total["page_count"]),
        )
        self.assertEqual(
            int(total["resident_logical_bytes"])
            + int(total["nonresident_logical_bytes"]),
            int(total["logical_bytes"]),
        )
        self.assertEqual(
            int(total["resident_page_bytes"])
            + int(total["nonresident_page_bytes"]),
            int(total["page_count"]) * PAGE_SIZE,
        )
        self.assertGreaterEqual(int(total["probe_minor_faults_delta"]), 0)

        repeat = self.run_classifier(suffix="-repeat")
        self.assertEqual(repeat.returncode, 0, repeat.stderr)
        self.assertEqual(
            self.files_output.read_bytes(),
            (self.root / "files-repeat.tsv").read_bytes(),
        )
        repeat_summary = self.read_rows(self.root / "summary-repeat.tsv")
        varying_fault_fields = {
            "probe_minor_faults_before",
            "probe_minor_faults_after",
            "probe_minor_faults_delta",
            "probe_major_faults_before",
            "probe_major_faults_after",
            "probe_major_faults_delta",
            "probe_scan_started_monotonic_ns",
            "probe_scan_completed_monotonic_ns",
            "probe_scan_duration_ms",
        }
        for first, second in zip(summary, repeat_summary, strict=True):
            for field in varying_fault_fields:
                first[field] = ""
                second[field] = ""
        self.assertEqual(summary, repeat_summary)

    def test_symlink_is_rejected_with_failure_summary(self) -> None:
        (self.pgdata / "unsafe-link").symlink_to("PG_VERSION")
        result = self.run_classifier(suffix="-symlink")
        self.assertEqual(result.returncode, 1)
        self.assertIn("tree contains a symlink", result.stderr)
        summary = self.read_rows(self.root / "summary-symlink.tsv")
        total = summary[-1]
        self.assertEqual(total["status"], "failed")
        self.assertEqual(total["error_count"], "1")
        self.assertIn("tree contains a symlink", total["errors"])

    def test_noncanonical_root_is_rejected(self) -> None:
        alias = self.root / "carrier-alias"
        alias.symlink_to(self.carrier, target_is_directory=True)
        result = self.run_classifier(carrier=alias, suffix="-root-link")
        self.assertEqual(result.returncode, 1)
        self.assertIn("must be a non-symlink directory", result.stderr)
        summary = self.read_rows(self.root / "summary-root-link.tsv")
        self.assertEqual(summary[-1]["status"], "failed")

    def test_output_aliases_cannot_overwrite_each_other(self) -> None:
        reports = self.root / "reports"
        reports.mkdir()
        alias = self.root / "reports-alias"
        alias.symlink_to(reports, target_is_directory=True)
        output = reports / "evidence.tsv"
        result = subprocess.run(
            [
                "python3",
                str(SCRIPT),
                "--carrier-root",
                str(self.carrier),
                "--pgdata-root",
                str(self.pgdata),
                "--files-output",
                str(output),
                "--summary-output",
                str(alias / "evidence.tsv"),
            ],
            check=False,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        self.assertEqual(result.returncode, 1)
        self.assertIn("must be different paths", result.stderr)
        self.assertFalse(output.exists())

    def test_pair_publication_recovers_an_identical_partial_set(self) -> None:
        reports = self.root / "partial-reports"
        reports.mkdir()
        files = reports / "files.tsv"
        summary = reports / "summary.tsv"
        file_rows = [{field: "" for field in CLASSIFIER.FILES_HEADER}]
        summary_rows = [{field: "" for field in CLASSIFIER.SUMMARY_HEADER}]
        expected_summary = CLASSIFIER.render_tsv(
            CLASSIFIER.SUMMARY_HEADER, summary_rows
        )
        summary.write_bytes(expected_summary)
        summary.chmod(0o444)
        summary_inode = summary.stat().st_ino
        outputs = CLASSIFIER.validate_outputs(files, summary, ())
        try:
            CLASSIFIER.publish_tsv_pair(outputs, file_rows, summary_rows)
        finally:
            for output in outputs:
                os.close(output.fd)

        self.assertTrue(files.is_file())
        self.assertEqual(summary.read_bytes(), expected_summary)
        self.assertEqual(summary.stat().st_ino, summary_inode)
        self.assertEqual(files.stat().st_mode & 0o777, 0o444)
        self.assertEqual(summary.stat().st_mode & 0o777, 0o444)

    def test_pair_publication_rejects_mixed_existing_generation_preflight(self) -> None:
        reports = self.root / "mixed-reports"
        reports.mkdir()
        files = reports / "files.tsv"
        summary = reports / "summary.tsv"
        old_summary = b"preexisting different generation\n"
        summary.write_bytes(old_summary)
        summary.chmod(0o444)
        summary_inode = summary.stat().st_ino
        file_rows = [{field: "new" for field in CLASSIFIER.FILES_HEADER}]
        summary_rows = [{field: "new" for field in CLASSIFIER.SUMMARY_HEADER}]
        outputs = CLASSIFIER.validate_outputs(files, summary, ())
        try:
            with self.assertRaises(CLASSIFIER.PublicationError):
                CLASSIFIER.publish_tsv_pair(outputs, file_rows, summary_rows)
        finally:
            for output in outputs:
                os.close(output.fd)

        self.assertFalse(files.exists())
        self.assertEqual(summary.read_bytes(), old_summary)
        self.assertEqual(summary.stat().st_ino, summary_inode)
        self.assertEqual(list(reports.glob(".*.pending.*")), [])


if __name__ == "__main__":
    unittest.main()
