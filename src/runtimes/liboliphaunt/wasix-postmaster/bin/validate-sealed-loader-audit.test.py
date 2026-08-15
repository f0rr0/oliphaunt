#!/usr/bin/env python3

from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
import unittest
from unittest import mock
from pathlib import Path


SCRIPT = Path(__file__).with_name("validate-sealed-loader-audit.py")
SPEC = importlib.util.spec_from_file_location("validate_sealed_loader_audit", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


INITDB = "1" * 64
POSTGRES = "2" * 64
PROOF_SHA256 = {
    INITDB: "6" * 64,
    POSTGRES: "7" * 64,
}
PROOF_OUTPUT_SHA256 = {
    INITDB: "8" * 64,
    POSTGRES: "9" * 64,
}
MAPPED_SIZE = 4096


def memory_metadata(module_hash: str) -> dict[str, object]:
    return {
        "schema": MODULE.MEMORY_IMAGE_SCHEMA,
        "module-sha256": module_hash,
        "mapped-size": MAPPED_SIZE,
        "deterministic-start-proof": {
            "schema": MODULE.DETERMINISTIC_START_PROOF_SCHEMA,
            "module-sha256": module_hash,
            "proof-sha256": PROOF_SHA256[module_hash],
        },
        "deterministic-start-proof-output-sha256": PROOF_OUTPUT_SHA256[module_hash],
    }


def manifest() -> dict[str, object]:
    artifacts = [
        {
            "name": "runtime:initdb",
            "module-sha256": INITDB,
            "preinitialized-memory": memory_metadata(INITDB),
        },
        {
            "name": "runtime:postgres",
            "module-sha256": POSTGRES,
            "preinitialized-memory": memory_metadata(POSTGRES),
        },
        {"name": "runtime:libpq.so.5.18", "module-sha256": "3" * 64},
        {"name": "runtime:dict_snowball.so", "module-sha256": "4" * 64},
        {"name": "runtime:plpgsql.so", "module-sha256": "5" * 64},
    ]
    artifacts.extend(
        {
            "name": f"runtime:declared_side_module_{index:02d}.so",
            "module-sha256": f"{index:064x}",
        }
        for index in range(10, 34)
    )
    return {"artifacts": artifacts}


def record(module_hash: str, kind: str, pid: int) -> dict[str, object]:
    logical = MAPPED_SIZE
    measured = {
        "state": "measured",
        "page_size": 4096,
        "total_pages": 1,
        "resident_pages": 1,
        "resident_bytes": logical,
        "errno": None,
    }
    after_eviction = dict(measured)
    after_eviction["resident_pages"] = 0
    after_eviction["resident_bytes"] = 0
    return {
        "schema": MODULE.SCHEMA,
        "pid": pid,
        "artifact_kind": kind,
        "module_sha256": module_hash,
        "snapshot_mode": "direct-immutable-inode",
        "logical_bytes": logical,
        "source_bytes_read": 0 if kind == "aot" else logical,
        "source_bytes_written": 0,
        "snapshot_bytes_written": 0,
        "mapping_bytes_hashed": logical,
        "sync_calls": 0,
        "read_advice_applicable": True,
        "read_advice_supported": True,
        "read_advice_calls": 2,
        "read_advice_successes": 2,
        "read_advice_first_errno": None,
        "source_cache_eviction_applicable": True,
        "source_cache_eviction_supported": True,
        "source_cache_eviction_calls": 1,
        "source_cache_eviction_successes": 1,
        "source_cache_eviction_errno": None,
        "snapshot_cache_eviction_applicable": False,
        "snapshot_cache_eviction_supported": True,
        "snapshot_cache_eviction_calls": 0,
        "snapshot_cache_eviction_successes": 0,
        "snapshot_cache_eviction_errno": None,
        "mapping_cache_eviction_applicable": kind == "preinitialized-memory",
        "mapping_cache_eviction_supported": True,
        "mapping_cache_eviction_calls": 1 if kind == "preinitialized-memory" else 0,
        "mapping_cache_eviction_successes": 1 if kind == "preinitialized-memory" else 0,
        "mapping_cache_eviction_errno": None,
        "residency_after_hash_inspect": dict(measured),
        "residency_after_archive_release": (
            dict(measured)
            if kind == "aot"
            else {
                "state": "not-applicable",
                "page_size": None,
                "total_pages": None,
                "resident_pages": None,
                "resident_bytes": None,
                "errno": None,
            }
        ),
        "source_residency_before_eviction": dict(measured),
        "source_residency_after_eviction": dict(after_eviction),
        "residency_after_eviction": dict(after_eviction),
        "write_policy": "none-immutable-source",
    }


def portable_record(module_hash: str, kind: str, pid: int) -> dict[str, object]:
    value = record(module_hash, kind, pid)
    unsupported = {
        "state": "unsupported-platform",
        "page_size": None,
        "total_pages": None,
        "resident_pages": None,
        "resident_bytes": None,
        "errno": None,
    }
    value.update(
        snapshot_mode=(
            "streamed-copy"
            if kind == "aot"
            else "streamed-copy-sealed-backing"
        ),
        source_bytes_read=MAPPED_SIZE,
        snapshot_bytes_written=MAPPED_SIZE,
        read_advice_supported=False,
        read_advice_calls=0,
        read_advice_successes=0,
        source_cache_eviction_supported=False,
        source_cache_eviction_calls=0,
        source_cache_eviction_successes=0,
        snapshot_cache_eviction_applicable=kind == "aot",
        snapshot_cache_eviction_supported=kind != "aot",
        snapshot_cache_eviction_calls=0,
        snapshot_cache_eviction_successes=0,
        mapping_cache_eviction_supported=kind != "preinitialized-memory",
        mapping_cache_eviction_calls=0,
        mapping_cache_eviction_successes=0,
        residency_after_hash_inspect=dict(unsupported),
        residency_after_archive_release=(
            dict(unsupported)
            if kind == "aot"
            else {
                "state": "not-applicable",
                "page_size": None,
                "total_pages": None,
                "resident_pages": None,
                "resident_bytes": None,
                "errno": None,
            }
        ),
        source_residency_before_eviction=dict(unsupported),
        source_residency_after_eviction=dict(unsupported),
        residency_after_eviction=dict(unsupported),
        write_policy=(
            "private-streamed-copy-no-sync"
            if kind == "aot"
            else "private-sealed-backing-no-sync"
        ),
    )
    return value


def summary(module_hash: str, pid: int, instances: int = 1) -> dict[str, object]:
    assert instances > 0
    reuse_successes = instances - 1
    return {
        "schema": MODULE.SUMMARY_SCHEMA,
        "pid": pid,
        "artifact_kind": "attested-start-runtime-summary",
        "terminal": True,
        "module_sha256": module_hash,
        "memory_image_schema": MODULE.MEMORY_IMAGE_SCHEMA,
        "proof_sha256": PROOF_SHA256[module_hash],
        "proof_output_sha256": PROOF_OUTPUT_SHA256[module_hash],
        "mapped_size": MAPPED_SIZE,
        "ordinary_start_completed_instances": instances,
        "fresh_zeroed_instances": instances,
        "nonfresh_instances": 0,
        "validation_attempts": instances,
        "full_compare_attempts": 1,
        "full_compare_successes": 1,
        "full_compare_failures": 0,
        "compared_bytes": MAPPED_SIZE,
        "reuse_successes": reuse_successes,
        "reuse_failures": 0,
        "skipped_bytes": MAPPED_SIZE * reuse_successes,
        "remap_successes": instances,
        "remap_failures": 0,
        "counter_overflow": False,
    }


def lifecycle_records(
    initdb_pids: tuple[int, ...] = (101,),
    postgres_pids: tuple[int, ...] = (202,),
) -> list[dict[str, object]]:
    records: list[dict[str, object]] = []
    for pid in initdb_pids:
        for module_hash in (INITDB, POSTGRES):
            for kind in ("aot", "preinitialized-memory"):
                records.append(record(module_hash, kind, pid))
    for pid in postgres_pids:
        for kind in ("aot", "preinitialized-memory"):
            records.append(record(POSTGRES, kind, pid))
    for pid in initdb_pids:
        records.extend((summary(INITDB, pid), summary(POSTGRES, pid)))
    for pid in postgres_pids:
        records.append(summary(POSTGRES, pid))
    return records


def portable_lifecycle_records() -> list[dict[str, object]]:
    records = lifecycle_records()
    return [
        portable_record(item["module_sha256"], item["artifact_kind"], item["pid"])
        if item.get("schema") == MODULE.SCHEMA
        else item
        for item in records
    ]


def find_summary(
    records: list[dict[str, object]], module_hash: str, pid: int
) -> dict[str, object]:
    return next(
        item
        for item in records
        if item.get("schema") == MODULE.SUMMARY_SCHEMA
        and item.get("module_sha256") == module_hash
        and item.get("pid") == pid
    )


class LoaderAuditTests(unittest.TestCase):
    def write_fixture(
        self,
        root: Path,
        records: list[dict[str, object]],
        manifest_value: dict[str, object] | None = None,
    ) -> tuple[Path, Path]:
        manifest_path = root / "manifest.json"
        audit_path = root / "audit.jsonl"
        manifest_path.write_text(json.dumps(manifest_value or manifest()) + "\n", encoding="utf-8")
        audit_path.write_text(
            "".join(json.dumps(item, separators=(",", ":")) + "\n" for item in records),
            encoding="utf-8",
        )
        return manifest_path, audit_path

    def assert_rejected(
        self,
        records: list[dict[str, object]],
        message: str,
        manifest_value: dict[str, object] | None = None,
    ) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            manifest_path, audit_path = self.write_fixture(root, records, manifest_value)
            with self.assertRaisesRegex(MODULE.ValidationError, message):
                MODULE.validate(audit_path, manifest_path, root / "validation.tsv")

    def assert_rejected_with_policy(
        self,
        records: list[dict[str, object]],
        message: str,
        *,
        snapshot_policy: str,
    ) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            manifest_path, audit_path = self.write_fixture(root, records)
            with self.assertRaisesRegex(MODULE.ValidationError, message):
                MODULE.validate(
                    audit_path,
                    manifest_path,
                    root / "validation.tsv",
                    snapshot_policy=snapshot_policy,
                )

    def test_exact_direct_aot_and_memory_evidence_passes(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            records = lifecycle_records()
            manifest_path, audit_path = self.write_fixture(root, records)
            output = root / "validation.tsv"
            MODULE.validate(
                audit_path,
                manifest_path,
                output,
                snapshot_policy="direct-immutable",
            )
            self.assertIn(
                "\tpassed\t6\t3\t3\t1\t1\t101\t202\tdirect-immutable\t",
                output.read_text(),
            )
            header, result = output.read_text().splitlines()
            self.assertTrue(header.startswith("schema_version\tstatus\trecords\t"))
            self.assertIn("\tattested_summary_records\t", header)
            self.assertTrue(result.startswith(f"{MODULE.RESULT_SCHEMA}\tpassed\t"))
            self.assertTrue(
                result.endswith(
                    "12\t12\t6\t6\t0\t0\t3\t3\t24576\t12288\t24576\t0\t0\t"
                    "3\t3\t3\t0\t3\t3\t3\t0\t12288\t0\t0\t0\t3\t0\t0"
                )
            )

    def test_portable_copy_aot_and_memory_evidence_passes(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            manifest_path, audit_path = self.write_fixture(
                root,
                portable_lifecycle_records(),
            )
            output = root / "validation.tsv"
            MODULE.validate(
                audit_path,
                manifest_path,
                output,
                snapshot_policy="portable-copy",
            )
            header, values = output.read_text().splitlines()
            result = dict(zip(header.split("\t"), values.split("\t"), strict=True))
            self.assertEqual(result["snapshot_policy"], "portable-copy")
            self.assertEqual(result["records"], "6")
            self.assertEqual(result["residency_after_hash_inspect_bytes"], "0")

    def test_portable_policy_rejects_direct_activation(self) -> None:
        self.assert_rejected_with_policy(
            lifecycle_records(),
            "snapshot mode differs from portable-copy policy",
            snapshot_policy="portable-copy",
        )

    def test_destination_appearing_at_commit_is_not_replaced(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            manifest_path, audit_path = self.write_fixture(root, lifecycle_records())
            output = root / "validation.tsv"
            competitor = b"concurrent owner\n"
            real_publish = MODULE.publish_identified

            def publish_after_competitor(source, destination, identity) -> None:
                destination.write_bytes(competitor)
                real_publish(source, destination, identity)

            with mock.patch.object(MODULE, "publish_identified", publish_after_competitor):
                with self.assertRaises(MODULE.PublicationError):
                    MODULE.validate(audit_path, manifest_path, output)
            self.assertEqual(output.read_bytes(), competitor)
            self.assertEqual(list(root.glob(".validation.tsv.pending.*")), [])

    def test_pending_replacement_is_never_unlinked_by_cleanup(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            manifest_path, audit_path = self.write_fixture(root, lifecycle_records())
            output = root / "validation.tsv"
            held = root / "held-original-pending"
            attacker = b"different private generation\n"

            def replace_pending(source: Path, _destination: Path, _identity) -> None:
                source.rename(held)
                source.write_bytes(attacker)
                source.chmod(0o444)
                raise MODULE.PublicationError("injected publication failure")

            with mock.patch.object(MODULE, "publish_identified", replace_pending):
                with self.assertRaisesRegex(
                    MODULE.PublicationError, "private publication generation changed"
                ):
                    MODULE.validate(audit_path, manifest_path, output)
            pending = list(root.glob(".validation.tsv.pending.*"))
            self.assertEqual(len(pending), 1)
            self.assertEqual(pending[0].read_bytes(), attacker)
            self.assertTrue(held.is_file())
            self.assertFalse(output.exists())

    def test_exact_manifest_dynamic_module_evidence_is_accepted(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            records = lifecycle_records()
            records.extend(
                (
                    record("3" * 64, "aot", 101),
                    record("5" * 64, "aot", 202),
                )
            )
            manifest_path, audit_path = self.write_fixture(root, records)
            output = root / "validation.tsv"
            MODULE.validate(audit_path, manifest_path, output)
            self.assertIn("\tpassed\t8\t5\t3\t1\t1\t101\t202\t", output.read_text())

    def test_unknown_dynamic_module_hash_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            records = lifecycle_records()
            records.append(record("9" * 64, "aot", 202))
            manifest_path, audit_path = self.write_fixture(root, records)
            with self.assertRaisesRegex(
                MODULE.ValidationError,
                "audit module SHA-256 is not in sealed manifest",
            ):
                MODULE.validate(audit_path, manifest_path, root / "validation.tsv")

    def test_duplicate_hash_across_manifest_artifacts_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            manifest_value = manifest()
            artifacts = manifest_value["artifacts"]
            assert isinstance(artifacts, list)
            assert isinstance(artifacts[2], dict)
            artifacts[2]["module-sha256"] = POSTGRES
            manifest_path, audit_path = self.write_fixture(
                root,
                lifecycle_records(),
                manifest_value,
            )
            with self.assertRaisesRegex(
                MODULE.ValidationError,
                "duplicate manifest module hash",
            ):
                MODULE.validate(audit_path, manifest_path, root / "validation.tsv")

    def test_repeated_direct_executions_are_counted_by_distinct_pid(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            records = lifecycle_records((101, 102), (201, 202, 203))
            manifest_path, audit_path = self.write_fixture(root, records)
            output = root / "validation.tsv"
            MODULE.validate(
                audit_path,
                manifest_path,
                output,
                snapshot_policy="direct-immutable",
                expected_initdb_executions=2,
                expected_postgres_executions=3,
            )
            self.assertIn("\tpassed\t14\t7\t7\t2\t3\t101,102\t201,202,203\t", output.read_text())

    def test_missing_initdb_bootstrap_postgres_activation_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            records = [
                record(INITDB, "aot", 101),
                record(INITDB, "preinitialized-memory", 101),
                record(POSTGRES, "aot", 202),
                record(POSTGRES, "preinitialized-memory", 202),
                summary(INITDB, 101),
                summary(POSTGRES, 202),
            ]
            manifest_path, audit_path = self.write_fixture(root, records)
            with self.assertRaisesRegex(
                MODULE.ValidationError,
                "every initdb execution must activate bootstrap postgres",
            ):
                MODULE.validate(audit_path, manifest_path, root / "validation.tsv")

    def test_reflink_and_any_write_are_rejected(self) -> None:
        for field, value, message in (
            ("snapshot_mode", "reflink", "non-direct snapshot mode"),
            ("source_bytes_written", 1, "source bytes were written"),
            ("snapshot_bytes_written", 1, "snapshot byte accounting differs"),
            ("sync_calls", 1, "loader issued sync calls"),
        ):
            with self.subTest(field=field), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                records = lifecycle_records()
                records[2][field] = value
                manifest_path, audit_path = self.write_fixture(root, records)
                with self.assertRaisesRegex(MODULE.ValidationError, message):
                    MODULE.validate(audit_path, manifest_path, root / "validation.tsv")

    def test_read_only_filesystem_mode_is_rejected_when_immutable_is_required(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            records = lifecycle_records()
            records[3]["snapshot_mode"] = "direct-read-only-filesystem"
            manifest_path, audit_path = self.write_fixture(root, records)
            with self.assertRaisesRegex(MODULE.ValidationError, "snapshot mode differs from direct-immutable policy"):
                MODULE.validate(
                    audit_path,
                    manifest_path,
                    root / "validation.tsv",
                    snapshot_policy="direct-immutable",
                )

    def test_missing_memory_activation_and_pid_mismatch_are_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            records = lifecycle_records()
            records[1]["pid"] = 102
            manifest_path, audit_path = self.write_fixture(root, records)
            with self.assertRaisesRegex(MODULE.ValidationError, "AOT and memory audit pids differ"):
                MODULE.validate(audit_path, manifest_path, root / "validation.tsv")

    def test_failed_eviction_and_malformed_residency_are_rejected(self) -> None:
        for mutate, message in (
            (
                lambda item: item.update(
                    read_advice_supported=False,
                    read_advice_calls=0,
                    read_advice_successes=0,
                ),
                "read_advice.*unsupported",
            ),
            (
                lambda item: item.update(
                    source_cache_eviction_successes=0,
                    source_cache_eviction_errno=5,
                ),
                "source_cache_eviction.*advisory call failed",
            ),
            (
                lambda item: item["residency_after_eviction"].update(
                    resident_pages=0,
                    resident_bytes=4096,
                ),
                "resident byte/page accounting differs",
            ),
        ):
            with self.subTest(message=message), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                records = lifecycle_records()
                mutate(records[0])
                manifest_path, audit_path = self.write_fixture(root, records)
                with self.assertRaisesRegex(MODULE.ValidationError, message):
                    MODULE.validate(audit_path, manifest_path, root / "validation.tsv")

    def test_multi_instance_reuse_summary_passes_and_is_aggregated(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            records = lifecycle_records()
            target = find_summary(records, POSTGRES, 202)
            target.clear()
            target.update(summary(POSTGRES, 202, instances=4))
            manifest_path, audit_path = self.write_fixture(root, records)
            output = root / "validation.tsv"
            MODULE.validate(audit_path, manifest_path, output)
            header, values = output.read_text().splitlines()
            result = dict(zip(header.split("\t"), values.split("\t"), strict=True))
            self.assertEqual(result["attested_summary_records"], "3")
            self.assertEqual(result["ordinary_start_completed_instances"], "6")
            self.assertEqual(result["full_compare_successes"], "3")
            self.assertEqual(result["reuse_successes"], "3")
            self.assertEqual(result["compared_bytes"], str(3 * MAPPED_SIZE))
            self.assertEqual(result["skipped_bytes"], str(3 * MAPPED_SIZE))
            self.assertEqual(result["remap_successes"], "6")

    def test_missing_duplicate_and_orphan_summaries_are_rejected(self) -> None:
        records = lifecycle_records()
        records.remove(find_summary(records, POSTGRES, 202))
        self.assert_rejected(records, "missing attested-start summary")

        records = lifecycle_records()
        records.append(dict(find_summary(records, POSTGRES, 202)))
        self.assert_rejected(records, "duplicate attested-start summary")

        records = lifecycle_records()
        find_summary(records, POSTGRES, 202)["pid"] = 999
        self.assert_rejected(records, "orphan attested-start summary")

    def test_summary_module_proof_and_size_mismatches_are_rejected(self) -> None:
        for field, value, message in (
            ("module_sha256", "3" * 64, "orphan attested-start summary"),
            ("proof_sha256", "a" * 64, "proof_sha256 differs from sealed manifest"),
            (
                "proof_output_sha256",
                "b" * 64,
                "proof_output_sha256 differs from sealed manifest",
            ),
            ("mapped_size", MAPPED_SIZE * 2, "mapped_size differs from sealed manifest"),
        ):
            with self.subTest(field=field):
                records = lifecycle_records()
                find_summary(records, INITDB, 101)[field] = value
                self.assert_rejected(records, message)

        records = lifecycle_records()
        manifest_value = manifest()
        artifacts = manifest_value["artifacts"]
        assert isinstance(artifacts, list) and isinstance(artifacts[0], dict)
        memory = artifacts[0]["preinitialized-memory"]
        assert isinstance(memory, dict)
        memory["mapped-size"] = MAPPED_SIZE * 2
        initdb_summary = find_summary(records, INITDB, 101)
        initdb_summary["mapped_size"] = MAPPED_SIZE * 2
        initdb_summary["compared_bytes"] = MAPPED_SIZE * 2
        self.assert_rejected(
            records,
            "activation size differs from sealed manifest",
            manifest_value,
        )

    def test_start_validation_and_remap_conservation_are_rejected(self) -> None:
        for mutate, message in (
            (
                lambda item: item.__setitem__(
                    "ordinary_start_completed_instances", 2
                ),
                "ordinary-start/fresh-memory conservation differs",
            ),
            (
                lambda item: item.__setitem__("validation_attempts", 2),
                "ordinary-start/validation conservation differs",
            ),
            (
                lambda item: item.update(
                    fresh_zeroed_instances=0,
                    nonfresh_instances=1,
                ),
                "observed a non-fresh memory instance",
            ),
            (
                lambda item: item.__setitem__("remap_successes", 0),
                "validation/remap conservation differs",
            ),
        ):
            with self.subTest(message=message):
                records = lifecycle_records()
                mutate(find_summary(records, INITDB, 101))
                self.assert_rejected(records, message)

    def test_compare_reuse_and_byte_conservation_are_rejected(self) -> None:
        records = lifecycle_records()
        target = find_summary(records, POSTGRES, 202)
        target.clear()
        target.update(summary(POSTGRES, 202, instances=2))
        target.update(
            full_compare_attempts=2,
            full_compare_successes=2,
            compared_bytes=MAPPED_SIZE * 2,
            reuse_successes=0,
            skipped_bytes=0,
        )
        self.assert_rejected(records, "did not perform exactly one full comparison")

        records = lifecycle_records()
        target = find_summary(records, POSTGRES, 202)
        target.clear()
        target.update(summary(POSTGRES, 202, instances=3))
        target["reuse_successes"] = 1
        self.assert_rejected(records, "validation compare/reuse conservation differs")

        records = lifecycle_records()
        find_summary(records, POSTGRES, 202)["compared_bytes"] = MAPPED_SIZE - 1
        self.assert_rejected(records, "compared byte accounting differs")

        records = lifecycle_records()
        target = find_summary(records, POSTGRES, 202)
        target.clear()
        target.update(summary(POSTGRES, 202, instances=3))
        target["skipped_bytes"] = MAPPED_SIZE
        self.assert_rejected(records, "skipped byte accounting differs")

    def test_runtime_failures_counter_overflow_and_math_overflow_are_rejected(self) -> None:
        records = lifecycle_records()
        target = find_summary(records, POSTGRES, 202)
        target.update(
            full_compare_successes=0,
            full_compare_failures=1,
            compared_bytes=0,
            remap_successes=0,
        )
        self.assert_rejected(records, "reports a full comparison failure")

        records = lifecycle_records()
        target = find_summary(records, POSTGRES, 202)
        target.clear()
        target.update(summary(POSTGRES, 202, instances=2))
        target.update(
            reuse_successes=0,
            reuse_failures=1,
            skipped_bytes=0,
            remap_successes=1,
        )
        self.assert_rejected(records, "reports a cached-validation failure")

        records = lifecycle_records()
        target = find_summary(records, POSTGRES, 202)
        target.update(remap_successes=0, remap_failures=1)
        self.assert_rejected(records, "reports a memory-image remap failure")

        records = lifecycle_records()
        find_summary(records, POSTGRES, 202)["counter_overflow"] = True
        self.assert_rejected(records, "reports counter overflow")

        records = lifecycle_records()
        find_summary(records, POSTGRES, 202)["validation_attempts"] = MODULE.MAX_U64 + 1
        self.assert_rejected(records, "must be an unsigned 64-bit integer")

        records = lifecycle_records()
        target = find_summary(records, POSTGRES, 202)
        target.clear()
        target.update(summary(POSTGRES, 202))
        target.update(
            ordinary_start_completed_instances=MODULE.MAX_U64,
            fresh_zeroed_instances=MODULE.MAX_U64,
            validation_attempts=MODULE.MAX_U64,
            reuse_successes=MODULE.MAX_U64 - 1,
            skipped_bytes=0,
            remap_successes=MODULE.MAX_U64,
        )
        self.assert_rejected(records, "byte-accounting product overflows u64")

    def test_unknown_loader_and_summary_fields_and_schemas_fail_closed(self) -> None:
        for mutate, message in (
            (
                lambda records: records[0].__setitem__("unknown", 1),
                "loader audit fields differ",
            ),
            (
                lambda records: records[0].__setitem__("schema", "unknown.loader.v1"),
                "unknown audit schema",
            ),
            (
                lambda records: find_summary(records, INITDB, 101).__setitem__(
                    "unknown", 1
                ),
                "attested-start summary fields differ",
            ),
            (
                lambda records: find_summary(records, INITDB, 101).__setitem__(
                    "schema", "unknown.summary.v1"
                ),
                "unknown audit schema",
            ),
            (
                lambda records: find_summary(records, INITDB, 101).__setitem__(
                    "memory_image_schema", "unknown.memory.v1"
                ),
                "unknown summary memory image schema",
            ),
        ):
            with self.subTest(message=message):
                records = lifecycle_records()
                mutate(records)
                self.assert_rejected(records, message)

        for field, value, message in (
            ("schema", "unknown.memory.v1", "preinitialized-memory schema differs"),
            (
                "proof-schema",
                "unknown.proof.v1",
                "deterministic-start proof schema differs",
            ),
        ):
            with self.subTest(manifest_field=field):
                manifest_value = manifest()
                artifacts = manifest_value["artifacts"]
                assert isinstance(artifacts, list) and isinstance(artifacts[0], dict)
                memory = artifacts[0]["preinitialized-memory"]
                assert isinstance(memory, dict)
                if field == "proof-schema":
                    proof = memory["deterministic-start-proof"]
                    assert isinstance(proof, dict)
                    proof["schema"] = value
                else:
                    memory[field] = value
                self.assert_rejected(lifecycle_records(), message, manifest_value)


if __name__ == "__main__":
    unittest.main()
