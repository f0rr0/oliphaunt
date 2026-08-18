#!/usr/bin/env python3

from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).with_name("validate-sealed-loader-audit.py")
SPEC = importlib.util.spec_from_file_location("validate_sealed_loader_audit", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)

INITDB = "1" * 64
POSTGRES = "2" * 64
SIDE_MODULE = "3" * 64
LOGICAL_BYTES = 4096


def manifest() -> dict[str, object]:
    return {
        "artifacts": [
            {"name": "runtime:initdb", "module-sha256": INITDB},
            {"name": "runtime:postgres", "module-sha256": POSTGRES},
            {"name": "runtime:libpq.so.5.18", "module-sha256": SIDE_MODULE},
        ]
    }


def residency(state: str, *, resident: bool = True) -> dict[str, object]:
    if state == "unsupported-platform":
        return {
            "state": state,
            "page_size": None,
            "total_pages": None,
            "resident_pages": None,
            "resident_bytes": None,
            "errno": None,
        }
    return {
        "state": state,
        "page_size": 4096,
        "total_pages": 1,
        "resident_pages": 1 if resident else 0,
        "resident_bytes": LOGICAL_BYTES if resident else 0,
        "errno": None,
    }


def record(module_hash: str, pid: int, *, portable: bool = False) -> dict[str, object]:
    observed = residency("unsupported-platform") if portable else residency("measured")
    evicted = residency("unsupported-platform") if portable else residency("measured", resident=False)
    return {
        "schema": MODULE.SCHEMA,
        "pid": pid,
        "artifact_kind": "aot",
        "module_sha256": module_hash,
        "snapshot_mode": "streamed-copy" if portable else "direct-immutable-inode",
        "logical_bytes": LOGICAL_BYTES,
        "source_bytes_read": LOGICAL_BYTES if portable else 0,
        "source_bytes_written": 0,
        "snapshot_bytes_written": LOGICAL_BYTES if portable else 0,
        "mapping_bytes_hashed": LOGICAL_BYTES,
        "sync_calls": 0,
        "read_advice_applicable": True,
        "read_advice_supported": not portable,
        "read_advice_calls": 0 if portable else 2,
        "read_advice_successes": 0 if portable else 2,
        "read_advice_first_errno": None,
        "source_cache_eviction_applicable": True,
        "source_cache_eviction_supported": not portable,
        "source_cache_eviction_calls": 0 if portable else 1,
        "source_cache_eviction_successes": 0 if portable else 1,
        "source_cache_eviction_errno": None,
        "snapshot_cache_eviction_applicable": portable,
        "snapshot_cache_eviction_supported": not portable,
        "snapshot_cache_eviction_calls": 0,
        "snapshot_cache_eviction_successes": 0,
        "snapshot_cache_eviction_errno": None,
        "mapping_cache_eviction_applicable": False,
        "mapping_cache_eviction_supported": True,
        "mapping_cache_eviction_calls": 0,
        "mapping_cache_eviction_successes": 0,
        "mapping_cache_eviction_errno": None,
        "residency_after_hash_inspect": dict(observed),
        "residency_after_archive_release": dict(observed),
        "source_residency_before_eviction": dict(observed),
        "source_residency_after_eviction": dict(evicted),
        "residency_after_eviction": dict(evicted),
        "write_policy": "private-streamed-copy-no-sync" if portable else "none-immutable-source",
    }


def lifecycle_records(*, portable: bool = False) -> list[dict[str, object]]:
    return [
        record(INITDB, 101, portable=portable),
        record(POSTGRES, 101, portable=portable),
        record(POSTGRES, 202, portable=portable),
    ]


class LoaderAuditTests(unittest.TestCase):
    def write_fixture(
        self,
        root: Path,
        records: list[dict[str, object]],
        manifest_value: dict[str, object] | None = None,
    ) -> tuple[Path, Path]:
        manifest_path = root / "manifest.json"
        manifest_path.write_text(
            json.dumps(manifest_value or manifest(), sort_keys=True) + "\n",
            encoding="utf-8",
        )
        audit_path = root / "audit.jsonl"
        audit_path.write_text(
            "".join(json.dumps(item, sort_keys=True) + "\n" for item in records),
            encoding="utf-8",
        )
        return manifest_path, audit_path

    def validate(
        self,
        records: list[dict[str, object]],
        *,
        snapshot_policy: str = "direct-immutable",
    ) -> list[str]:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            manifest_path, audit_path = self.write_fixture(root, records)
            output = root / "validation.tsv"
            MODULE.validate(
                audit_path,
                manifest_path,
                output,
                snapshot_policy=snapshot_policy,
            )
            return output.read_text(encoding="utf-8").splitlines()

    def test_exact_aot_lifecycle_passes(self) -> None:
        header, values = self.validate(lifecycle_records())
        columns = dict(zip(header.split("\t"), values.split("\t"), strict=True))
        self.assertEqual(columns["status"], "passed")
        self.assertEqual(columns["records"], "3")
        self.assertEqual(columns["aot_records"], "3")
        self.assertEqual(columns["memory_records"], "0")
        self.assertEqual(columns["attested_summary_records"], "0")
        self.assertEqual(columns["initdb_pids"], "101")
        self.assertEqual(columns["postgres_pids"], "202")

    def test_portable_aot_lifecycle_passes(self) -> None:
        header, values = self.validate(
            lifecycle_records(portable=True),
            snapshot_policy="portable-copy",
        )
        columns = dict(zip(header.split("\t"), values.split("\t"), strict=True))
        self.assertEqual(columns["snapshot_policy"], "portable-copy")
        self.assertEqual(columns["snapshot_cache_eviction_calls"], "0")

    def test_preinitialized_memory_receipt_is_rejected(self) -> None:
        records = lifecycle_records()
        records.insert(1, {**records[0], "artifact_kind": "preinitialized-memory"})
        with self.assertRaisesRegex(MODULE.ValidationError, "invalid artifact kind"):
            self.validate(records)

    def test_missing_bootstrap_postgres_activation_is_rejected(self) -> None:
        records = [record(INITDB, 101), record(POSTGRES, 202)]
        with self.assertRaisesRegex(
            MODULE.ValidationError,
            "every initdb execution must activate bootstrap postgres",
        ):
            self.validate(records)

    def test_unknown_module_and_duplicate_pid_are_rejected(self) -> None:
        with self.assertRaisesRegex(MODULE.ValidationError, "not in sealed manifest"):
            self.validate([*lifecycle_records(), record("f" * 64, 303)])
        duplicate = lifecycle_records()
        duplicate.append(dict(duplicate[-1]))
        with self.assertRaisesRegex(MODULE.ValidationError, "AOT audit pids are not unique"):
            self.validate(duplicate)

    def test_loader_fields_and_modes_fail_closed(self) -> None:
        records = lifecycle_records()
        records[0]["unknown"] = True
        with self.assertRaisesRegex(MODULE.ValidationError, "loader audit fields differ"):
            self.validate(records)
        records = lifecycle_records()
        records[0]["snapshot_mode"] = "reflink"
        with self.assertRaisesRegex(MODULE.ValidationError, "non-direct snapshot mode"):
            self.validate(records)

    def test_existing_output_is_not_replaced(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            manifest_path, audit_path = self.write_fixture(root, lifecycle_records())
            output = root / "validation.tsv"
            output.write_text("existing\n", encoding="utf-8")
            with self.assertRaisesRegex(MODULE.ValidationError, "already exists"):
                MODULE.validate(audit_path, manifest_path, output)
            self.assertEqual(output.read_text(encoding="utf-8"), "existing\n")


if __name__ == "__main__":
    unittest.main()
